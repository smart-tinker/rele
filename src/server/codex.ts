import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import type { CodexThread, ConnectionState } from '../shared/types.js';
import { isLocalEndpoint } from './config.js';

// Queue semantics and clientId recovery were tested against this exact runtime.
// A newer CLI installed beside an older Desktop does not upgrade that Desktop's server.
export const SUPPORTED_CODEX_VERSION = '0.163.0';
export interface CodexConfig {
  transport: 'proxy' | 'websocket';
  executable: string;
  endpoint?: string;
  token?: string;
}
export type RpcId = string | number;
export interface CodexNotification { method: string; params: Record<string, unknown> }
export interface CodexServerRequest extends CodexNotification { id: RpcId }
export interface RequestLocation {
  state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'not_found';
  queuedSubmissionId?: string;
  turnId?: string;
  text?: string;
  mixed?: boolean;
}
export interface CodexRuntime { userAgent: string; codexHome: string; platformFamily: string; platformOs: string }
interface QueueEntry { id: string; clientUserMessageId: string }
interface HistoryItem { type: string; clientId?: string | null; text?: string; phase?: string | null }
interface HistoryTurn { id: string; status: string; items: HistoryItem[] }
interface Page<T> { data: T[]; nextCursor: string | null }
interface RawThread {
  id: string; name?: string | null; cwd: string; preview: string; updatedAt: number;
  status?: { type: string }; ephemeral?: boolean;
}
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'CodexRpcError'; }
}

// A dropped connection or timeout cannot establish whether a mutating RPC was accepted.
export class CodexTransportError extends Error {
  readonly uncertain = true;
  constructor(message: string) { super(message); this.name = 'CodexTransportError'; }
}

/** Attach to an existing app-server. This class never starts a Codex daemon. */
export class CodexClient extends EventEmitter {
  private socket?: WebSocket;
  private proxy?: ChildProcessWithoutNullStreams;
  private pending = new Map<RpcId, PendingCall>();
  private serverRequests = new Set<RpcId>();
  private subscriptions = new Set<string>();
  private subscribed = new Map<string, Promise<void>>();
  private reconnectTimer?: NodeJS.Timeout;
  private connecting?: Promise<void>;
  private stopped = true;
  private retry = 0;
  private runtime?: CodexRuntime;
  private version?: string;
  private state: ConnectionState & { queueSupported: boolean; desktopVerified: boolean };

  constructor(private readonly config: CodexConfig) {
    super();
    this.state = {
      configured: config.transport === 'proxy' ? !!config.executable : isLocalEndpoint(config.endpoint ?? ''),
      connected: false, queueSupported: false, desktopVerified: false,
    };
  }

  status(): ConnectionState & { queueSupported: boolean; desktopVerified: boolean } { return { ...this.state }; }
  runtimeInfo(): CodexRuntime | undefined { return this.runtime ? { ...this.runtime } : undefined; }

  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.state.connected) return;
    if (this.config.transport === 'websocket' && !isLocalEndpoint(this.config.endpoint ?? '')) {
      throw new Error('Codex: разрешён только локальный ws:// или wss:// адрес без пароля и параметров.');
    }
    if (this.config.transport === 'proxy' && !this.config.executable) throw new Error('Укажите исполняемый файл Codex CLI.');
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connecting = this.open().catch(error => {
      this.disconnect(this.safeMessage(error));
      this.scheduleReconnect();
      throw error;
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.disconnect('Соединение с Codex закрыто.');
  }

  async listThreads(): Promise<CodexThread[]> {
    const rows = await this.pages<RawThread>('thread/list', { limit: 100, sortKey: 'updated_at', modelProviders: [] });
    return rows.filter(row => !row.ephemeral).map(row => ({
      id: row.id,
      name: row.name?.trim() || row.preview?.replace(/\s+/gu, ' ').trim().slice(0, 100) || 'Без названия',
      cwd: row.cwd, preview: row.preview || '', updatedAt: row.updatedAt, status: row.status?.type,
    }));
  }

  /** Metadata only: reading does not load a thread or wake its persisted queue. */
  async readThread(threadId: string): Promise<unknown> {
    return this.call('thread/read', { threadId });
  }

  /** Rejoin the existing runtime without overriding its model, sandbox, or instructions. */
  async subscribe(threadId: string): Promise<void> {
    if (this.version !== SUPPORTED_CODEX_VERSION) {
      throw new Error(this.state.error || `Для подписки нужен проверенный Codex ${SUPPORTED_CODEX_VERSION}.`);
    }
    this.subscriptions.add(threadId);
    const existing = this.subscribed.get(threadId);
    if (existing) return existing;
    const subscribing = (async () => {
      await this.call('thread/resume', { threadId, excludeTurns: true });
      if (!this.state.queueSupported && this.version === SUPPORTED_CODEX_VERSION) {
        await this.call('thread/queue/list', { threadId, limit: 1 });
        this.setState({ queueSupported: true, error: undefined });
      }
    })().catch(error => { this.subscribed.delete(threadId); throw error; });
    this.subscribed.set(threadId, subscribing);
    return subscribing;
  }

  async enqueue(threadId: string, text: string, clientUserMessageId: string): Promise<{ queuedSubmissionId: string }> {
    if (!text.trim()) throw new Error('Нельзя отправить пустой запрос Codex.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(clientUserMessageId)) {
      throw new Error('Запрос Codex должен иметь постоянный UUID для восстановления после обрыва связи.');
    }
    await this.subscribe(threadId);
    this.requireQueue();
    // add is NOT idempotent. Never retry it here, even with the same clientUserMessageId.
    // Auto-drain creates a separate turn atomically; turn/start would steer a Desktop turn.
    const response = await this.call<{ queuedSubmission: QueueEntry }>('thread/queue/add', {
      threadId, input: [{ type: 'text', text }], clientUserMessageId,
    });
    if (!response.queuedSubmission?.id) throw new CodexTransportError('Codex принял запрос, но не вернул идентификатор очереди. Проверьте историю перед повтором.');
    return { queuedSubmissionId: response.queuedSubmission.id };
  }

  /** Explicit continuation after an interrupted queue; never steers another active turn. */
  async startQueued(threadId: string, queuedSubmissionId?: string): Promise<{ turn: HistoryTurn }> {
    this.requireQueue();
    await this.subscribe(threadId);
    return this.call('thread/queue/start', { threadId, ...(queuedSubmissionId ? { queuedSubmissionId } : {}) });
  }

  async deleteQueued(threadId: string, queuedSubmissionId: string): Promise<{ deleted: boolean }> {
    this.requireQueue();
    return this.call('thread/queue/delete', { threadId, queuedSubmissionId });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.requireQueue();
    await this.call('turn/interrupt', { threadId, turnId });
  }

  /** A not_found result is evidence for operator review, not permission to resend queue/add. */
  async findRequest(threadId: string, clientId: string): Promise<RequestLocation> {
    const queue = await this.pages<QueueEntry>('thread/queue/list', { threadId, limit: 100 });
    const queued = queue.filter(entry => entry.clientUserMessageId === clientId);
    if (queued.length > 1) throw new Error('В очереди Codex несколько запросов с одним clientId; требуется ручная сверка.');
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.call<Page<HistoryTurn>>('thread/turns/list', {
        threadId, limit: 50, itemsView: 'full', sortDirection: 'desc', ...(cursor ? { cursor } : {}),
      });
      const matches = page.data.filter(turn => turn.items.some(item => item.type === 'userMessage' && item.clientId === clientId));
      if (matches.length > 1) throw new Error('В истории Codex несколько ходов с одним clientId; требуется ручная сверка.');
      if (matches.length) {
        const turn = matches[0];
        const mixed = turn.items.some(item => item.type === 'userMessage' && item.clientId !== clientId);
        const state = turn.status === 'inProgress' ? 'running' : turn.status;
        if (!['running', 'completed', 'failed', 'interrupted'].includes(state)) throw new Error('Неизвестное состояние хода Codex.');
        const answers = turn.items.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer');
        const legacy = turn.items.filter(item => item.type === 'agentMessage' && item.phase == null);
        return {
          state: state as RequestLocation['state'], turnId: turn.id,
          ...(mixed ? { mixed: true } : {
            text: answers.length ? answers.map(item => item.text || '').join('\n\n') : legacy.at(-1)?.text,
          }),
        };
      }
      cursor = nextPage(page.nextCursor, seen);
    } while (cursor);
    return queued.length ? { state: 'queued', queuedSubmissionId: queued[0].id } : { state: 'not_found' };
  }

  async diagnostics(): Promise<{ process: { id: number }; gauges: unknown[] }> {
    return this.call('server/diagnostics', {});
  }

  async respond(rpcId: RpcId, result: unknown): Promise<void> {
    this.requireQueue();
    if (!this.serverRequests.has(rpcId)) throw new Error('Запрос подтверждения Codex уже завершён или соединение изменилось.');
    await this.send({ id: rpcId, result });
    this.serverRequests.delete(rpcId);
  }

  private async open(): Promise<void> {
    this.runtime = undefined;
    this.version = undefined;
    this.setState({ connected: false, queueSupported: false, error: undefined });
    let options: WebSocket.ClientOptions = { handshakeTimeout: 5_000, maxPayload: 32 * 1024 * 1024, followRedirects: false };
    if (this.config.token) options.headers = { Authorization: `Bearer ${this.config.token}` };
    if (this.config.transport === 'proxy') {
      const launch = await proxyLaunch(this.config.executable);
      if (this.stopped) throw new CodexTransportError('Соединение закрыто.');
      const args = [...launch.args, 'app-server', 'proxy'];
      if (this.config.endpoint) args.push('--sock', this.config.endpoint);
      this.proxy = spawn(launch.command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.proxy.stderr.resume(); // Never publish environment details or secrets from child stderr.
      const stream = Duplex.from({ readable: this.proxy.stdout, writable: this.proxy.stdin });
      options = { ...options, createConnection: () => stream as Socket };
    }
    const socket = new WebSocket(this.config.transport === 'proxy' ? 'ws://localhost/' : this.config.endpoint!, options);
    this.socket = socket;
    socket.on('message', raw => { if (this.socket === socket) this.receive(raw.toString()); });
    socket.on('error', () => {}); // The handshake and close handlers surface sanitized connection state.
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.disconnect('Соединение с Codex прервано. Неподтверждённые запросы требуют сверки.');
      this.scheduleReconnect();
    });
    this.proxy?.once('error', () => { if (this.socket === socket) socket.terminate(); });
    this.proxy?.once('exit', () => { if (this.socket === socket) socket.terminate(); });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', () => reject(new CodexTransportError('Не удалось подключиться к существующему Codex app-server. Проверьте его запуск и локальный адрес.')));
      socket.once('close', () => reject(new CodexTransportError('Codex app-server закрыл соединение во время подключения.')));
    });
    this.runtime = await this.call<CodexRuntime>('initialize', {
      clientInfo: { name: 'rele', title: 'Rele', version: '0.1.0' }, capabilities: { experimentalApi: true },
    });
    await this.send({ method: 'initialized' });
    this.version = this.runtime.userAgent.match(/\/(\d+\.\d+\.\d+)(?:\s|$)/u)?.[1];
    this.setState({ name: this.version ? `Codex ${this.version}` : 'Codex', connected: true });
    if (this.version !== SUPPORTED_CODEX_VERSION) {
      this.setState({ error: `Запись доступна для проверенного Codex ${SUPPORTED_CODEX_VERSION}; подключён ${this.version || 'неизвестный runtime'}.` });
    } else {
      await this.probeQueue();
    }
    for (const threadId of this.subscriptions) {
      try { await this.subscribe(threadId); }
      catch (error) { this.setState({ error: this.safeMessage(error) }); }
    }
    this.retry = 0;
  }

  private async probeQueue(): Promise<void> {
    const threads = await this.call<Page<RawThread>>('thread/list', { limit: 100, modelProviders: [], sortKey: 'updated_at' });
    for (const thread of threads.data.filter(row => !row.ephemeral)) {
      try {
        await this.call('thread/queue/list', { threadId: thread.id, limit: 1 });
        this.setState({ queueSupported: true, error: undefined });
        return;
      } catch (error) {
        if (!(error instanceof CodexRpcError)) throw error;
        if (/thread not found|archived|ephemeral thread/iu.test(error.message)) continue;
        this.setState({ error: 'Подключённый Codex не предоставляет очередь запросов. Отправка отключена.' });
        return;
      }
    }
    this.setState({ error: 'Создайте обычный разговор в Codex и выберите его связку, чтобы проверить очередь.' });
  }

  private requireQueue(): void {
    if (!this.state.connected || !this.state.queueSupported) {
      throw new Error(this.state.error || `Для отправки нужна очередь общего Codex app-server ${SUPPORTED_CODEX_VERSION}.`);
    }
  }

  private async pages<T>(method: string, params: Record<string, unknown>): Promise<T[]> {
    const rows: T[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.call<Page<T>>(method, { ...params, ...(cursor ? { cursor } : {}) });
      rows.push(...page.data);
      cursor = nextPage(page.nextCursor, seen);
    } while (cursor);
    return rows;
  }

  private call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexTransportError(`Codex не подтвердил ${method} за 30 секунд; проверьте состояние перед повтором.`));
      }, 30_000);
      timer.unref();
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      void this.send({ id, method, params }).catch(error => {
        const pending = this.pending.get(id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error as Error); }
      });
    });
  }

  private send(value: unknown): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new CodexTransportError('Codex не подключён.'));
    return new Promise((resolve, reject) => socket.send(JSON.stringify(value), error => error
      ? reject(new CodexTransportError('Codex не подтвердил передачу сообщения; требуется сверка.')) : resolve()));
  }

  private receive(raw: string): void {
    let message: { id?: RpcId; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
    try {
      message = JSON.parse(raw) as typeof message;
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid');
    } catch {
      this.disconnect('Codex вернул некорректное сообщение протокола.');
      this.scheduleReconnect();
      return;
    }
    if (message.method) {
      const event = { method: message.method, params: message.params ?? {} };
      if (message.id !== undefined) {
        this.serverRequests.add(message.id);
        this.emit('request', { ...event, id: message.id } satisfies CodexServerRequest);
      } else {
        if (message.method === 'serverRequest/resolved') this.serverRequests.delete(event.params.requestId as RpcId);
        this.emit('notification', event satisfies CodexNotification);
      }
      return;
    }
    const pending = message.id === undefined ? undefined : this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id!);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new CodexRpcError(message.error.code, this.safeMessage(message.error.message)));
    else pending.resolve(message.result);
  }

  private disconnect(message: string): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
    this.proxy?.kill(); // Only our byte proxy; the shared app-server belongs to Codex.
    this.proxy = undefined;
    this.subscribed.clear();
    this.serverRequests.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new CodexTransportError(message)); }
    this.pending.clear();
    this.setState({ connected: false, queueSupported: false, error: message });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = [1_000, 2_000, 5_000, 10_000, 30_000][Math.min(this.retry++, 4)];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {});
    }, delay);
    this.reconnectTimer.unref();
  }

  private setState(change: Partial<ConnectionState & { queueSupported: boolean }>): void {
    this.state = { ...this.state, ...change, desktopVerified: false };
    this.emit('status', this.status());
  }

  private safeMessage(value: unknown): string {
    const message = value instanceof Error ? value.message : String(value);
    return (this.config.token ? message.split(this.config.token).join('[скрыто]') : message).slice(0, 1_000);
  }
}

function nextPage(cursor: string | null, seen: Set<string>): string | undefined {
  if (!cursor) return undefined;
  if (seen.has(cursor)) throw new Error('Codex повторил курсор страницы; сверка истории остановлена.');
  seen.add(cursor);
  return cursor;
}

/** Launch the official Windows npm shim without cmd.exe or shell interpolation. */
async function proxyLaunch(executable: string): Promise<{ command: string; args: string[] }> {
  if (/\.[cm]?js$/iu.test(executable)) return { command: process.execPath, args: [executable] };
  if (process.platform !== 'win32') return { command: executable, args: [] };
  const candidates = path.isAbsolute(executable) || /[\\/]/u.test(executable)
    ? [path.resolve(executable)]
    : (process.env.PATH || '').split(path.delimiter).flatMap(directory => path.extname(executable)
      ? [path.join(directory, executable)] : [path.join(directory, `${executable}.exe`), path.join(directory, `${executable}.cmd`)]);
  for (const candidate of candidates) {
    try { await access(candidate); } catch { continue; }
    if (!/\.(cmd|bat)$/iu.test(candidate)) return { command: candidate, args: [] };
    const entry = path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try { await access(entry); return { command: process.execPath, args: [entry] }; } catch { /* Try another PATH installation. */ }
  }
  throw new Error('Не найден Codex CLI для Windows. Укажите codex.exe или установите официальный @openai/codex для текущего пользователя.');
}
