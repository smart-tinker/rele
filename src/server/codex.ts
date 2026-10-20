import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import type { CodexConnectionState, CodexConnectionTarget, CodexDiscoveryResult, CodexThread } from '../shared/types.js';
import { SUPPORTED_CODEX_VERSION, SUPPORTED_CODEX_VERSIONS } from '../shared/codex-runtime.js';
import { isLocalEndpoint, isLocalSocketPath } from './config.js';
import { discoverCodex } from './codex-discovery.js';
import { codexEnvironment, resolveCodexLaunch } from './codex-launch.js';
import { CodexStdioError, CodexStdioTransport } from './codex-stdio.js';

export { SUPPORTED_CODEX_VERSION } from '../shared/codex-runtime.js';
// Keep user conversations from every normal client; technical subagents are not binding targets.
const THREAD_SOURCES = ['cli', 'vscode', 'exec', 'appServer'];
export interface CodexConfig {
  transport: CodexConnectionTarget['transport'];
  executable: string;
  endpoint?: string;
  codexHome?: string;
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
  source?: string | Record<string, unknown>; parentThreadId?: string | null;
}
function isBindableThread(thread: RawThread): boolean {
  return !thread.ephemeral && !thread.parentThreadId
    && (thread.source === undefined || typeof thread.source === 'string' && THREAD_SOURCES.includes(thread.source));
}
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'CodexRpcError'; }
}

/** A persisted thread is owned by another runtime; retry the same ID after handoff. */
export class CodexThreadBusyError extends Error {
  constructor(readonly threadId: string) {
    super('Разговор занят другим Codex, например Desktop. Запрос подождёт освобождения этого же разговора.');
    this.name = 'CodexThreadBusyError';
  }
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

/** Own a stdio child or attach to an explicit existing server; never start a daemon. */
export class CodexClient extends EventEmitter {
  private socket?: WebSocket;
  private proxy?: ChildProcessWithoutNullStreams;
  private stdio?: CodexStdioTransport;
  private cleanup: Promise<void> = Promise.resolve();
  private pending = new Map<RpcId, PendingCall>();
  private serverRequests = new Set<RpcId>();
  private subscriptions = new Set<string>();
  private subscribed = new Map<string, Promise<void>>();
  private releasing = new Map<string, Promise<void>>();
  private closedWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private reconnectTimer?: NodeJS.Timeout;
  private connecting?: Promise<void>;
  private stopped = true;
  private retry = 0;
  private runtime?: CodexRuntime;
  private version?: string;
  private state: CodexConnectionState;
  private discovery?: { at: number; result: CodexDiscoveryResult };

  constructor(private readonly config: CodexConfig, private readonly options: { discover?: typeof discoverCodex; releaseTimeoutMs?: number } = {}) {
    super();
    this.state = {
      configured: config.transport !== 'websocket' ? !!config.executable : isLocalEndpoint(config.endpoint ?? ''),
      connected: false, queueSupported: false, desktopVerified: false, transport: config.transport,
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
    if (this.config.transport !== 'websocket' && !this.config.executable) throw new Error('Укажите исполняемый файл Codex CLI.');
    if (this.config.transport === 'proxy' && this.config.endpoint && !isLocalSocketPath(this.config.endpoint)) throw new CodexTransportError('Proxy Codex принимает путь к локальному сокету. WebSocket URL нужно выбрать в режиме WebSocket.', 'invalid-proxy-socket');
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connecting = this.open().catch(async error => {
      await this.disconnect(this.safeMessage(error), error instanceof CodexTransportError ? error.code : 'connection-failed');
      this.scheduleReconnect();
      throw error;
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    return this.disconnect('Соединение с Codex закрыто.');
  }

  async listThreads(options: { archived?: boolean; refresh?: boolean } = {}): Promise<CodexThread[]> {
    const archived = options.archived === true;
    const rows = await this.pages<RawThread>('thread/list', {
      limit: 100, sortKey: 'updated_at', modelProviders: [], archived,
      sourceKinds: THREAD_SOURCES, useStateDbOnly: options.refresh !== true,
    });
    if (options.refresh && !archived && this.isVerifiedVersion() && !this.state.queueSupported) await this.probeQueue(rows);
    return rows.filter(isBindableThread).map(row => ({
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
    const releasing = this.releasing.get(threadId);
    if (releasing) await releasing;
    if (!this.state.connected || !this.isVerifiedVersion()) {
      throw new Error(this.state.error || `Для подписки нужен проверенный Codex ${SUPPORTED_CODEX_VERSION}.`);
    }
    this.subscriptions.add(threadId);
    const existing = this.subscribed.get(threadId);
    if (existing) return existing;
    const subscribing = (async () => {
      const response = await this.call<{ thread: { id: string } }>('thread/resume', { threadId, excludeTurns: true });
      if (response?.thread?.id !== threadId) {
        const error = new CodexTransportError('Codex вернул другой разговор при возобновлении. Отправка остановлена; исходная связка сохранена.', 'thread-identity-mismatch');
        await this.disconnect(error.message, error.code);
        this.scheduleReconnect();
        throw error;
      }
      if (!this.state.queueSupported && this.isVerifiedVersion()) {
        await this.call('thread/queue/list', { threadId, limit: 1 });
        this.setState({ queueSupported: true, error: undefined });
      }
    })().catch(error => {
      if (this.subscribed.get(threadId) === subscribing) this.subscribed.delete(threadId);
      if (error instanceof CodexRpcError && error.code === -32600 && /already has an active writer/iu.test(error.message)) {
        this.subscriptions.delete(threadId);
        throw new CodexThreadBusyError(threadId);
      }
      throw error;
    });
    this.subscribed.set(threadId, subscribing);
    return subscribing;
  }

  /** Release only our managed runtime's writer, and wait for actual thread shutdown. */
  releaseThread(threadId: string): Promise<void> {
    if (this.config.transport !== 'managed') return Promise.resolve();
    const existing = this.releasing.get(threadId);
    if (existing) return existing;
    const release = this.releaseManagedThread(threadId).finally(() => {
      if (this.releasing.get(threadId) === release) this.releasing.delete(threadId);
    });
    this.releasing.set(threadId, release);
    return release;
  }

  private async releaseManagedThread(threadId: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const subscribing = this.subscribed.get(threadId);
      if (subscribing) await subscribing;
      this.subscribed.delete(threadId);
      this.subscriptions.delete(threadId);
      if (!this.stdio || !this.state.connected) { await this.cleanup; return; }
      let waiter!: { resolve: () => void; reject: (error: Error) => void };
      const closed = new Promise<void>((resolve, reject) => {
        waiter = { resolve, reject };
        this.closedWaiters.set(threadId, waiter);
        timer = setTimeout(() => reject(new CodexTransportError('Codex не подтвердил освобождение разговора. Управляемый процесс будет остановлен перед новым подключением.', 'thread-release-timeout')), this.options.releaseTimeoutMs ?? 15_000);
        timer.unref();
      });
      // The closed notification can precede the RPC response. Register its waiter first.
      void this.call<{ status: string }>('thread/unsubscribe', { threadId }).then(response => {
        if (response?.status === 'notLoaded') waiter.resolve();
        else if (!['unsubscribed', 'notSubscribed'].includes(response?.status)) {
          waiter.reject(new CodexTransportError('Codex вернул неизвестный результат освобождения разговора.', 'invalid-protocol'));
        }
      }, error => waiter.reject(error as Error));
      await closed;
    } catch (error) {
      await this.disconnect('Освобождение разговора Codex не подтверждено. Управляемый процесс остановлен; требуется сверка перед продолжением.', 'thread-release-failed');
      this.scheduleReconnect();
      throw error;
    } finally {
      clearTimeout(timer);
      this.closedWaiters.delete(threadId);
      this.subscribed.delete(threadId);
      this.subscriptions.delete(threadId);
    }
  }

  /** Passive user context only; caller serializes this with requests and releases our writer. */
  async injectContext(threadId: string, entryId: string, text: string): Promise<void> {
    if (this.config.transport !== 'managed' || !this.stdio) throw new Error('Фоновый контекст доступен только в управляемом Codex Rele.');
    if (!entryId.trim() || !text.trim()) throw new Error('Фоновому контексту нужны постоянный идентификатор и непустой текст.');
    this.requireQueue();
    if (!this.isVerifiedVersion()) throw new Error(`Для фонового контекста нужен проверенный Codex ${SUPPORTED_CODEX_VERSION}.`);
    // Resume may drain a persisted queue. Check before acquiring the original writer too.
    const pending = await this.call<Page<QueueEntry>>('thread/queue/list', { threadId, limit: 1 });
    if (!Array.isArray(pending?.data)) throw new CodexTransportError('Codex вернул некорректную очередь фонового контекста.', 'invalid-protocol');
    if (pending.data.length || pending.nextCursor) throw new CodexThreadBusyError(threadId);
    await this.subscribe(threadId);
    const response = await this.call<{ thread: RawThread }>('thread/read', { threadId });
    if (response?.thread?.id !== threadId) {
      const error = new CodexTransportError('Codex вернул другой разговор при проверке фонового контекста. Исходная связка сохранена.', 'thread-identity-mismatch');
      await this.disconnect(error.message, error.code);
      this.scheduleReconnect();
      throw error;
    }
    if (response.thread.status?.type !== 'idle') throw new CodexThreadBusyError(threadId);
    const queue = await this.call<Page<QueueEntry>>('thread/queue/list', { threadId, limit: 1 });
    if (!Array.isArray(queue?.data)) throw new CodexTransportError('Codex вернул некорректную очередь фонового контекста.', 'invalid-protocol');
    if (queue.data.length || queue.nextCursor) throw new CodexThreadBusyError(threadId);
    // Raw item IDs are attribution, not server idempotency keys. Never retry the RPC here.
    await this.call('thread/inject_items', {
      threadId, items: [{ type: 'message', id: `rele_slack_${entryId}`, role: 'user', content: [{ type: 'input_text', text }] }],
    });
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

  async rejectRequest(rpcId: RpcId, message: string): Promise<void> {
    if (!this.state.connected || !this.isVerifiedVersion()) throw new Error('Для ответа нужен подключённый проверенный Codex.');
    if (!this.serverRequests.has(rpcId)) throw new Error('Запрос подтверждения Codex уже завершён или соединение изменилось.');
    await this.send({ id: rpcId, error: { code: -32601, message: this.safeMessage(message) } });
    this.serverRequests.delete(rpcId);
  }

  private async open(): Promise<void> {
    // Reconnect must not overlap two owned runtimes, even after an uncertain shutdown.
    await this.cleanup;
    this.runtime = undefined;
    this.version = undefined;
    this.setState({ connected: false, queueSupported: false, codexHome: undefined, error: undefined, errorCode: undefined });
    let target: CodexConnectionTarget = { executable: this.config.executable, transport: this.config.transport, endpoint: this.config.endpoint ?? '', ...(this.config.codexHome ? { codexHome: this.config.codexHome } : {}) };
    if (target.transport !== 'websocket' && target.executable === 'codex') {
      const result = this.discovery && Date.now() - this.discovery.at < 15_000
        ? this.discovery.result : await (this.options.discover ?? discoverCodex)(this.config.codexHome ? { codexHome: this.config.codexHome } : undefined);
      this.discovery = { at: Date.now(), result };
      if (target.transport === 'managed') {
        if (!result.recommendedManaged) {
          throw new CodexTransportError(`Не найден проверенный Codex для управляемого режима. Нужен ${SUPPORTED_CODEX_VERSIONS.join(' или ')}; выберите установленный CLI в настройках.`, 'managed-cli-unavailable');
        }
        target = { ...target, executable: result.recommendedManaged.executable, endpoint: '' };
      } else {
        const explicitSocketCli = target.endpoint ? result.installations.find(item => item.version && item.connection?.endpoint === target.endpoint)
          ?? result.installations.find(item => item.version && item.running)
          ?? result.installations.find(item => item.version) : undefined;
        if (target.endpoint && explicitSocketCli) target = { ...target, executable: explicitSocketCli.executable };
        else if (!target.endpoint && result.recommended) target = { ...result.recommended, ...(this.config.codexHome ? { codexHome: this.config.codexHome } : {}) };
        else {
          const installation = result.installations.find(item => item.running) ?? result.installations[0];
          this.setState({ executable: installation?.executable, transport: 'proxy', endpoint: '' });
          const issue = result.issues.find(item => ['multiple-desktop-servers', 'desktop-stdio', 'socket-not-found', 'desktop-listener-unsupported', 'cli-probe-failed', 'cli-not-confirmed', 'cli-not-found'].includes(item.code)) ?? result.issues[0];
          throw new CodexTransportError(issue?.message || 'Доступное подключение к общему Codex app-server не найдено.', issue?.code || 'discovery-no-connection');
        }
      }
    }
    if (this.stopped) throw new CodexTransportError('Соединение закрыто.');
    this.setState({ executable: target.executable, transport: target.transport, endpoint: target.endpoint });
    let failure: ConnectionFailure | undefined;
    const diagnostic = (chunk: string) => {
      diagnosticTail = (diagnosticTail + chunk).slice(-8_192);
      const classified = classifyCodexConnectionFailure(diagnosticTail);
      if (classified.code !== 'connection-failed') failure = classified;
    };
    let diagnosticTail = '';
    if (target.transport === 'managed') {
      const env = codexEnvironment(this.config.codexHome);
      const launch = await resolveCodexLaunch(target.executable, { env });
      if (this.stopped) throw new CodexTransportError('Соединение закрыто.');
      this.setState({ executable: launch.executable });
      const stdio = new CodexStdioTransport(launch.command, [...launch.args, 'app-server', '--listen', 'stdio://', '-c', 'thread_unload_delay_secs=0'], env, {
        message: raw => { if (this.stdio === stdio) this.receive(raw); },
        stderr: diagnostic,
        failure: error => {
          if (this.stdio !== stdio) return;
          const details = failure ?? { message: error.message, code: error.code };
          void this.disconnect(details.message, details.code).catch(() => {});
          this.scheduleReconnect();
        },
        closed: () => {
          if (this.stdio !== stdio) return;
          void this.disconnect(failure?.message || 'Управляемый Codex завершился. Неподтверждённые запросы требуют сверки.', failure?.code || 'connection-closed').catch(() => {});
          this.scheduleReconnect();
        },
      });
      this.stdio = stdio;
      try { await stdio.ready; }
      catch (error) {
        const details = failure ?? { message: error instanceof CodexStdioError ? error.message : 'Не удалось запустить управляемый Codex.', code: error instanceof CodexStdioError ? error.code : 'cli-unavailable' };
        throw new CodexTransportError(details.message, details.code);
      }
    } else {
      let options: WebSocket.ClientOptions = { handshakeTimeout: 5_000, maxPayload: 32 * 1024 * 1024, followRedirects: false };
      if (this.config.token) options.headers = { Authorization: `Bearer ${this.config.token}` };
      if (target.transport === 'proxy') {
        if (target.endpoint && !isLocalSocketPath(target.endpoint)) throw new CodexTransportError('Некорректный локальный сокет Codex.', 'invalid-proxy-socket');
        const env = codexEnvironment(this.config.codexHome);
        const launch = await resolveCodexLaunch(target.executable, { env });
        if (this.stopped) throw new CodexTransportError('Соединение закрыто.');
        this.setState({ executable: launch.executable });
        const args = [...launch.args, 'app-server', 'proxy'];
        if (target.endpoint) args.push('--sock', target.endpoint);
        this.proxy = spawn(launch.command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
        this.proxy.stderr.setEncoding('utf8').on('data', diagnostic);
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
        void this.disconnect(failure?.message || 'Соединение с Codex прервано. Неподтверждённые запросы требуют сверки.', failure?.code).catch(() => {});
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
    }
    this.runtime = await this.call<CodexRuntime>('initialize', {
      clientInfo: { name: 'rele', title: 'Rele', version: '0.1.0' }, capabilities: { experimentalApi: true },
    });
    await this.send({ method: 'initialized' });
    if (typeof this.runtime?.userAgent !== 'string' || typeof this.runtime.codexHome !== 'string') throw new CodexTransportError('Codex вернул некорректные сведения о сервере.', 'invalid-protocol');
    this.version = this.runtime.userAgent.match(/\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)(?=\s|$)/u)?.[1];
    this.setState({ name: this.version ? `Codex ${this.version}` : 'Codex', connected: true, codexHome: this.runtime.codexHome });
    if (!this.isVerifiedVersion()) {
      this.setState({ error: `Запись доступна для проверенного Codex ${SUPPORTED_CODEX_VERSIONS.join(' или ')}; подключён ${this.version || 'неизвестный runtime'}.` });
    } else {
      await this.probeQueue();
    }
    for (const threadId of this.config.transport === 'managed' ? [] : this.subscriptions) {
      try { await this.subscribe(threadId); }
      catch (error) { this.setState({ error: this.safeMessage(error) }); }
    }
    this.retry = 0;
  }

  private async probeQueue(rows?: RawThread[]): Promise<void> {
    const threads = rows ?? (await this.call<Page<RawThread>>('thread/list', { limit: 100, modelProviders: [], sortKey: 'updated_at', sourceKinds: THREAD_SOURCES, archived: false, useStateDbOnly: true })).data;
    for (const thread of threads.filter(isBindableThread)) {
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

  private isVerifiedVersion(): boolean {
    return SUPPORTED_CODEX_VERSIONS.some(version => version === this.version);
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
    if (this.stdio) {
      return this.stdio.send(JSON.stringify(value)).catch(error => {
        throw new CodexTransportError(error instanceof CodexStdioError ? error.message : 'Codex не подтвердил передачу сообщения; требуется сверка.', error instanceof CodexStdioError ? error.code : 'connection-closed');
      });
    }
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
      if (message.id !== undefined && !(typeof message.id === 'string' || typeof message.id === 'number' && Number.isFinite(message.id))) throw new Error('invalid id');
      if (message.method !== undefined) {
        if (typeof message.method !== 'string' || !message.method || message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) throw new Error('invalid method');
      } else if (message.id === undefined || !Object.hasOwn(message, 'result') && !message.error) throw new Error('invalid response');
      if (message.error && (typeof message.error !== 'object' || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string')) throw new Error('invalid error');
    } catch {
      void this.disconnect('Codex вернул некорректное сообщение протокола.', 'invalid-protocol').catch(() => {});
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
        if (message.method === 'thread/closed' && this.config.transport === 'managed' && typeof event.params.threadId === 'string') {
          this.subscribed.delete(event.params.threadId);
          this.subscriptions.delete(event.params.threadId);
          this.closedWaiters.get(event.params.threadId)?.resolve();
        }
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

  private disconnect(message: string, errorCode?: string): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
    this.proxy?.kill(); // Only our byte proxy; the shared app-server belongs to Codex.
    this.proxy = undefined;
    const stdio = this.stdio;
    this.stdio = undefined;
    if (stdio) {
      this.cleanup = Promise.all([this.cleanup, stdio.close()]).then(() => {});
      void this.cleanup.catch(error => {
        this.setState({ connected: false, queueSupported: false, error: this.safeMessage(error), errorCode: error instanceof CodexStdioError ? error.code : 'shutdown-timeout' });
      });
    }
    this.subscribed.clear();
    this.serverRequests.clear();
    for (const waiter of this.closedWaiters.values()) waiter.reject(new CodexTransportError(message, errorCode));
    this.closedWaiters.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new CodexTransportError(message, errorCode)); }
    this.pending.clear();
    this.setState({ connected: false, queueSupported: false, error: message, errorCode });
    return this.cleanup;
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

