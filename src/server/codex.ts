import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import type { CodexConnectionState, CodexConnectionTarget, CodexDiscoveryResult, CodexThread } from '../shared/types.js';
import { isLocalEndpoint, isLocalSocketPath } from './config.js';
import { discoverCodex } from './codex-discovery.js';
import { resolveCodexLaunch } from './codex-launch.js';

// Queue semantics and clientId recovery were tested against this exact runtime.
// A newer CLI installed beside an older Desktop does not upgrade that Desktop's server.
export const SUPPORTED_CODEX_VERSION = '0.163.0';
// An omitted filter silently hides app-server and other persisted sources.
const THREAD_SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
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
  constructor(message: string, readonly code?: string) { super(message); this.name = 'CodexTransportError'; }
}

interface ConnectionFailure { code: string; message: string }

/** Return a fixed diagnostic category, never raw child output or command lines. */
export function classifyCodexConnectionFailure(value: string, fallback = 'connection-failed'): ConnectionFailure {
  if (/unrecognized subcommand ['"]?proxy|unknown (?:subcommand|command).*proxy|unexpected argument ['"]?proxy/iu.test(value)) return { code: 'proxy-unsupported', message: 'Найденный Codex CLI не поддерживает подключение app-server proxy. Выберите совместимый CLI или доступный WebSocket существующего сервера.' };
  if (/permission denied|access is denied|access denied|EACCES|EPERM|os error 5\b/iu.test(value)) return { code: 'access-denied', message: 'Нет доступа к Codex CLI или сокету сервера. Rele и Desktop должны работать под одним Windows-пользователем с доступом к этим файлам.' };
  if (/unexpected server response: (?:401|403)|unauthori[sz]ed|forbidden/iu.test(value)) return { code: 'authentication-failed', message: 'Существующий app-server отклонил подключение. Проверьте токен сервера в настройках Codex.' };
  if (/not running|no (?:running|existing).*server|connection refused|ECONNREFUSED|os error (?:2|61|111|10061)\b|control socket.*(?:not found|failed|missing)|No such file or directory/iu.test(value)) return { code: 'shared-server-unavailable', message: 'Codex CLI найден, но доступный общий app-server или его сокет не найден. Проверьте выбранный runtime и его адрес; новый сервер Rele не запускает.' };
  if (/ENOENT|not a valid Win32 application|ENOEXEC|EINVAL/iu.test(value)) return { code: 'cli-unavailable', message: 'Не удалось запустить выбранный Codex CLI. Проверьте путь к CLI; исполняемый файл интерфейса Desktop для этого не подходит.' };
  return { code: fallback, message: 'Не удалось подключиться к существующему Codex app-server. Проверьте выбранную установку и локальный адрес подключения.' };
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
  private state: CodexConnectionState;
  private discovery?: { at: number; result: CodexDiscoveryResult };

  constructor(private readonly config: CodexConfig, private readonly options: { discover?: typeof discoverCodex } = {}) {
    super();
    this.state = {
      configured: config.transport === 'proxy' ? !!config.executable : isLocalEndpoint(config.endpoint ?? ''),
      connected: false, queueSupported: false, desktopVerified: false,
    };
  }

  status(): CodexConnectionState { return { ...this.state }; }
  runtimeInfo(): CodexRuntime | undefined { return this.runtime ? { ...this.runtime } : undefined; }

  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.state.connected) return;
    if (this.config.transport === 'websocket' && !isLocalEndpoint(this.config.endpoint ?? '')) {
      throw new Error('Codex: разрешён только локальный ws:// или wss:// адрес без пароля и параметров.');
    }
    if (this.config.transport === 'proxy' && !this.config.executable) throw new Error('Укажите исполняемый файл Codex CLI.');
    if (this.config.transport === 'proxy' && this.config.endpoint && !isLocalSocketPath(this.config.endpoint)) throw new CodexTransportError('Proxy Codex принимает путь к локальному сокету. WebSocket URL нужно выбрать в режиме WebSocket.', 'invalid-proxy-socket');
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connecting = this.open().catch(error => {
      this.disconnect(this.safeMessage(error), error instanceof CodexTransportError ? error.code : 'connection-failed');
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

  async listThreads(options: { archived?: boolean } = {}): Promise<CodexThread[]> {
    const archived = options.archived === true;
    const rows = await this.pages<RawThread>('thread/list', {
      limit: 100, sortKey: 'updated_at', modelProviders: [], archived,
      sourceKinds: THREAD_SOURCES,
    });
    return rows.filter(row => !row.ephemeral).map(row => ({
      id: row.id,
      name: row.name?.trim() || row.preview?.replace(/\s+/gu, ' ').trim().slice(0, 100) || 'Без названия',
      cwd: row.cwd, preview: row.preview || '', updatedAt: row.updatedAt, status: row.status?.type, archived,
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
    this.setState({ connected: false, queueSupported: false, error: undefined, errorCode: undefined });
    let target: CodexConnectionTarget = { executable: this.config.executable, transport: this.config.transport, endpoint: this.config.endpoint ?? '' };
    if (target.transport === 'proxy' && target.executable === 'codex') {
      const result = this.discovery && Date.now() - this.discovery.at < 15_000
        ? this.discovery.result : await (this.options.discover ?? discoverCodex)();
      this.discovery = { at: Date.now(), result };
      const explicitSocketCli = target.endpoint ? result.installations.find(item => item.version && item.connection?.endpoint === target.endpoint)
        ?? result.installations.find(item => item.version && item.running)
        ?? result.installations.find(item => item.version) : undefined;
      if (target.endpoint && explicitSocketCli) target = { ...target, executable: explicitSocketCli.executable };
      else if (!target.endpoint && result.recommended) target = result.recommended;
      else {
        const installation = result.installations.find(item => item.running) ?? result.installations[0];
        this.setState({ executable: installation?.executable, transport: 'proxy', endpoint: '' });
        const issue = result.issues.find(item => ['multiple-desktop-servers', 'desktop-stdio', 'socket-not-found', 'desktop-listener-unsupported', 'cli-probe-failed', 'cli-not-confirmed', 'cli-not-found'].includes(item.code)) ?? result.issues[0];
        throw new CodexTransportError(issue?.message || 'Доступное подключение к общему Codex app-server не найдено.', issue?.code || 'discovery-no-connection');
      }
    }
    if (this.stopped) throw new CodexTransportError('Соединение закрыто.');
    this.setState({ executable: target.executable, transport: target.transport, endpoint: target.endpoint });
    let failure: ConnectionFailure | undefined;
    let options: WebSocket.ClientOptions = { handshakeTimeout: 5_000, maxPayload: 32 * 1024 * 1024, followRedirects: false };
    if (this.config.token) options.headers = { Authorization: `Bearer ${this.config.token}` };
    if (target.transport === 'proxy') {
      if (target.endpoint && !isLocalSocketPath(target.endpoint)) throw new CodexTransportError('Некорректный локальный сокет Codex.', 'invalid-proxy-socket');
      const launch = await resolveCodexLaunch(target.executable);
      if (this.stopped) throw new CodexTransportError('Соединение закрыто.');
      this.setState({ executable: launch.executable });
      const args = [...launch.args, 'app-server', 'proxy'];
      if (target.endpoint) args.push('--sock', target.endpoint);
      this.proxy = spawn(launch.command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let diagnosticTail = '';
      this.proxy.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        diagnosticTail = (diagnosticTail + chunk).slice(-8_192);
        const classified = classifyCodexConnectionFailure(diagnosticTail);
        if (classified.code !== 'connection-failed') failure = classified;
      });
      const stream = Duplex.from({ readable: this.proxy.stdout, writable: this.proxy.stdin });
      options = { ...options, createConnection: () => stream as Socket };
    }
    else if (!isLocalEndpoint(target.endpoint)) throw new CodexTransportError('Codex принимает только локальный WebSocket URL.', 'invalid-endpoint');
    const socket = new WebSocket(target.transport === 'proxy' ? 'ws://localhost/' : target.endpoint, options);
    this.socket = socket;
    socket.on('message', raw => { if (this.socket === socket) this.receive(raw.toString()); });
    socket.on('error', () => {}); // The handshake and close handlers surface sanitized connection state.
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.disconnect(failure?.message || 'Соединение с Codex прервано. Неподтверждённые запросы требуют сверки.', failure?.code);
      this.scheduleReconnect();
    });
    this.proxy?.once('error', error => {
      failure = classifyCodexConnectionFailure((error as NodeJS.ErrnoException).code || '', 'cli-unavailable');
      if (this.socket === socket) socket.terminate();
    });
    this.proxy?.once('exit', () => { if (this.socket === socket) socket.terminate(); });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', error => {
        const details = failure ?? classifyCodexConnectionFailure(error.message);
        reject(new CodexTransportError(details.message, details.code));
      });
      socket.once('close', () => reject(new CodexTransportError(failure?.message || 'Codex app-server закрыл соединение во время подключения.', failure?.code || 'connection-closed')));
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
    const threads = await this.call<Page<RawThread>>('thread/list', { limit: 100, modelProviders: [], sortKey: 'updated_at', sourceKinds: THREAD_SOURCES, archived: false });
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

  private disconnect(message: string, errorCode?: string): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
    this.proxy?.kill(); // Only our byte proxy; the shared app-server belongs to Codex.
    this.proxy = undefined;
    this.subscribed.clear();
    this.serverRequests.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new CodexTransportError(message)); }
    this.pending.clear();
    this.setState({ connected: false, queueSupported: false, error: message, errorCode });
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

  private setState(change: Partial<CodexConnectionState>): void {
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

