import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import type { CodexConnectionState, CodexConnectionTarget, CodexDiscoveryResult, CodexThread } from '../shared/types.js';
import { SUPPORTED_CODEX_VERSION, SUPPORTED_CODEX_VERSIONS } from '../shared/codex-runtime.js';
import { isLocalCodexHome, isLocalEndpoint, isLocalSocketPath } from './config.js';
import { discoverCodex } from './codex-discovery.js';
import { codexEnvironment, environmentValue, resolveCodexLaunch } from './codex-launch.js';
import { CodexContextReceipts } from './codex-context-receipts.js';
import { CodexStdioError, CodexStdioTransport } from './codex-stdio.js';
import { codexNativeGeneration, type CodexNativePeer } from './codex-native-generation.js';
import { effectiveSharedCodexHome, ensureSharedCodex, SharedCodexError } from './codex-shared.js';
import { asyncQuestions, matchAsyncAnswer, parseAsyncAnswers, type AsyncAnswer, type AsyncQuestion } from './async-questions.js';

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
export interface CodexContextReceiptCandidates {
  itemId: string;
  entries: { entryId: string; text: string }[];
}
export type PublicHistoryEvent = { step: { id: string; text: string } } | { boundary: string };
export interface RequestLocation {
  state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'not_found';
  queuedSubmissionId?: string;
  soleQueuedSubmission?: boolean;
  turnId?: string;
  text?: string;
  failureReason?: 'serverOverloaded' | 'contextWindowExceeded' | 'contextCompactionFailed';
  commentary?: { id: string; text: string }[];
  publicHistory?: PublicHistoryEvent[];
  retryCount?: number;
  retryBlocked?: boolean;
  rootTurnId?: string;
  mixed?: boolean;
  commandItems?: CodexCommandItem[];
  asyncQuestions?: AsyncQuestion[];
  asyncAnswers?: AsyncAnswer[];
}
export interface CodexCommandItem { id: string; processId: string | null; completed?: true }
export interface CodexTerminal { itemId: string; processId: string }
export interface CodexTerminalSnapshot { serverId: number; serverGeneration?: string; terminals: CodexTerminal[] }
const nativeProcessId = (value: unknown): value is string => typeof value === 'string' && /^\d+$/u.test(value) && Number(value) > 0 && Number(value) <= 0x7fffffff;
/** Canonical startup items bind a command to its turn even before native publishes its PID. */
export function codexCommandItem(value: unknown): CodexCommandItem | undefined {
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  if (item.type !== 'commandExecution' || item.source === 'unifiedExecInteraction' || item.kind === 'writeStdin'
    || typeof item.id !== 'string' || !item.id || item.processId != null && !nativeProcessId(item.processId)) return;
  return { id: item.id, processId: item.processId == null ? null : item.processId as string,
    ...(['completed', 'failed', 'declined'].includes(String(item.status)) ? { completed: true as const } : {}) };
}
export interface CodexRuntime { userAgent: string; codexHome: string; platformFamily: string; platformOs: string }
interface QueueEntry { id: string; clientUserMessageId: string }
interface HistoryItem { type: string; id?: string; clientId?: string | null; text?: string; phase?: string | null; delivery?: string | null; questions?: unknown; content?: unknown }
interface HistoryTurn { id: string; rootTurnId?: string | null; status: string; completedAt?: number | null; items: HistoryItem[]; error?: { codexErrorInfo?: unknown; message?: unknown } | null }
interface Page<T> { data: T[]; nextCursor: string | null }
interface RawThread {
  id: string; name?: string | null; cwd: string; preview: string; updatedAt: number;
  status?: { type: string }; ephemeral?: boolean; path?: string | null;
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

function nativeFailureReason(error: HistoryTurn['error']): RequestLocation['failureReason'] {
  if (error?.codexErrorInfo === 'serverOverloaded') return 'serverOverloaded';
  const message = typeof error?.message === 'string' ? error.message : '';
  const contextExceeded = error?.codexErrorInfo === 'contextWindowExceeded' || error?.codexErrorInfo === 'other'
    && message.includes('Your input exceeds the context window of this model. Please adjust your input and try again.');
  if (contextExceeded) return message.startsWith('Error running remote compact task:') ? 'contextCompactionFailed' : 'contextWindowExceeded';
}

export class CodexRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'CodexRpcError'; }
}

/** Only an explicit native NotSubmitted response permits using the normal queue instead. */
export class CodexSteerRefusedError extends Error {
  constructor(readonly reason: 'no_active_turn' | 'turn_mismatch') {
    super(reason === 'no_active_turn' ? 'Codex не применил дополнение: активного хода нет.' : 'Codex не применил дополнение: активный ход изменился.');
    this.name = 'CodexSteerRefusedError';
  }
}

const busyMessages = {
  foreign_writer: 'Разговор удерживает другой Codex. Desktop может сохранять право записи даже без выполняющейся задачи. Ожидается освобождение этого же разговора.',
  queued_input: 'В очереди Codex уже есть сообщения. Ожидается освобождение очереди этого разговора.',
  non_idle: 'Codex ещё не подтвердил, что разговор свободен. Операция ожидает готовности этого же разговора.',
};

/** The original thread is not ready for this operation; preserve its identity while waiting. */
export class CodexThreadBusyError extends Error {
  constructor(readonly threadId: string, readonly reason: keyof typeof busyMessages = 'foreign_writer') {
    super(busyMessages[reason]);
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

/** Attach to the native shared daemon, own a private child, or use an explicit server. */
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
  private heartbeatTimer?: NodeJS.Timeout;
  private healthCheck?: { socket: WebSocket; queueSupported: boolean; error?: string; errorCode?: string };
  private connecting?: Promise<void>;
  private stopped = true;
  private retry = 0;
  private runtime?: CodexRuntime;
  private nativePeer?: CodexNativePeer;
  private contextReceipts = new CodexContextReceipts();
  private version?: string;
  private state: CodexConnectionState;
  private discovery?: { at: number; result: CodexDiscoveryResult };

  constructor(private readonly config: CodexConfig, private readonly options: { discover?: typeof discoverCodex; shared?: typeof ensureSharedCodex; releaseTimeoutMs?: number;
    expectedVersion?: string;
    rpcTimeoutMs?: number; heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number;
    setupPlugin?: (rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>, runtime: CodexRuntime) => Promise<void> } = {}) {
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
      await this.disconnect(this.safeMessage(error), error instanceof CodexTransportError || error instanceof SharedCodexError ? error.code : 'connection-failed');
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

  setSharedExecutable(executable: string): void {
    if (this.config.transport !== 'shared' || !executable.trim()) throw new Error('Выбор версии допустим только для общего Codex.');
    this.config.executable = executable;
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

  /** Create only an explicitly requested conversation; never use this as a resume fallback. */
  async createThread(cwd: string): Promise<string> {
    if (!cwd.trim()) throw new Error('Укажите рабочий каталог нового разговора Codex.');
    if (!this.state.connected || !this.isVerifiedVersion()) {
      throw new Error(this.state.error || `Для создания разговора нужен проверенный Codex ${SUPPORTED_CODEX_VERSIONS.join(' или ')}.`);
    }
    const response = await this.call<{ thread: RawThread }>('thread/start', { cwd });
    const thread = response?.thread;
    if (!thread || typeof thread.id !== 'string' || !thread.id.trim() || !isBindableThread(thread)) {
      throw new CodexTransportError('Codex не подтвердил идентификатор нового разговора. Проверьте список разговоров перед повтором.', 'thread-start-unconfirmed');
    }
    this.subscriptions.add(thread.id);
    this.subscribed.set(thread.id, Promise.resolve());
    this.setState({ queueSupported: false, error: undefined });
    try { await this.probeQueue([thread]); }
    catch (error) { this.setState({ queueSupported: false, error: this.safeMessage(error) }); }
    // Preserve the acknowledged ID even if the read-only queue probe fails.
    return thread.id;
  }

  /** Native metadata writes also persist a newly created thread before its writer is released. */
  async setThreadName(threadId: string, name: string): Promise<void> {
    if (!this.state.connected || !this.isVerifiedVersion()) {
      throw new Error(this.state.error || `Для названия разговора нужен проверенный Codex ${SUPPORTED_CODEX_VERSIONS.join(' или ')}.`);
    }
    const title = [...name.replace(/\p{Cc}/gu, ' ').trim()].slice(0, 200).join('');
    if (!threadId.trim() || !title) throw new Error('Нужны идентификатор и непустое название разговора Codex.');
    await this.call('thread/name/set', { threadId, name: title });
    if (!this.state.queueSupported) {
      try {
        await this.call('thread/queue/list', { threadId, limit: 1 });
        this.setState({ queueSupported: true, error: undefined });
      } catch (error) { this.setState({ queueSupported: false, error: this.safeMessage(error) }); }
    }
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
  async injectContext(threadId: string, entryId: string, text: string, candidates?: CodexContextReceiptCandidates): Promise<void> {
    const shared = this.config.transport !== 'managed';
    if (!shared && !this.stdio) throw new Error('Управляемый Codex Rele не подключён.');
    if (!entryId.trim() || !text.trim()) throw new Error('Фоновому контексту нужны постоянный идентификатор и непустой текст.');
    // Native 166 omits unprefixed IDs from provider requests while retaining the exact local receipt.
    const itemId = candidates?.itemId ?? `rele-context-${createHash('sha256').update(JSON.stringify([threadId, entryId])).digest('hex').slice(0, 48)}`;
    if (!/^rele-context-[a-f0-9]{48}$/u.test(itemId) || candidates && (!Array.isArray(candidates.entries)
      || candidates.entries.some(entry => typeof entry.entryId !== 'string' || !entry.entryId.trim() || typeof entry.text !== 'string' || !entry.text.trim()))) {
      throw new Error('Не удалось проверить идентификаторы сохранённого контекста Codex.');
    }
    const previousItemId = `msg_${itemId.slice('rele-context-'.length)}`;
    const receipts = [{ entryId, text }, ...(candidates?.entries ?? [])].flatMap(entry => {
      // Older three-argument callers derived IDs from the journal entry rather than its source version.
      const digest = createHash('sha256').update(JSON.stringify([threadId, entry.entryId])).digest('hex').slice(0, 48);
      return [{ itemId, text: entry.text }, { itemId: previousItemId, text: entry.text }, { itemId: `rele_slack_${entry.entryId}`, text: entry.text },
        { itemId: `rele-context-${digest}`, text: entry.text }, { itemId: `msg_${digest}`, text: entry.text }];
    });
    this.requireQueue();
    if (!this.isVerifiedVersion()) throw new Error(`Для фонового контекста нужен проверенный Codex ${SUPPORTED_CODEX_VERSION}.`);
    const runtime = this.runtime;
    const home = shared ? await this.localContextHome(runtime) : undefined;
    const current = () => {
      if (!runtime || this.runtime !== runtime || !this.state.connected) throw new CodexTransportError('Соединение Codex изменилось во время сохранения контекста.');
    };
    const read = async () => {
      current();
      const response = await this.call<{ thread: RawThread }>('thread/read', { threadId });
      current();
      if (response?.thread?.id !== threadId) {
        const error = new CodexTransportError('Codex вернул другой разговор при проверке фонового контекста. Исходная связка сохранена.', 'thread-identity-mismatch');
        await this.disconnect(error.message, error.code);
        this.scheduleReconnect();
        throw error;
      }
      return response.thread;
    };
    const receipt = async () => {
      const thread = await read(); // Re-read: archive/compression can change the persisted rollout path.
      if (!home || typeof thread.path !== 'string') throw new Error('Не удалось подтвердить сохранение контекста Codex.');
      const found = await this.contextReceipts.has({ codexHome: home, rolloutPath: thread.path, threadId, itemId, text, alternatives: receipts });
      current();
      return found;
    };
    // Resolve an earlier lost ACK without acquiring a writer or appending the raw item twice.
    if (shared && await receipt()) return;
    // Resume may drain a persisted queue. Check before acquiring the original writer too.
    const pending = await this.call<Page<QueueEntry>>('thread/queue/list', { threadId, limit: 1 });
    if (!Array.isArray(pending?.data)) throw new CodexTransportError('Codex вернул некорректную очередь фонового контекста.', 'invalid-protocol');
    if (pending.data.length || pending.nextCursor) throw new CodexThreadBusyError(threadId, 'queued_input');
    await this.subscribe(threadId);
    const thread = await read();
    if (thread.status?.type === 'systemError') {
      // Native keeps this error flag until the next turn; require actual completion first.
      const page = await this.call<Page<HistoryTurn>>('thread/turns/list', { threadId, limit: 1, itemsView: 'summary', sortDirection: 'desc' });
      current();
      const latest = Array.isArray(page?.data) && page.data.length === 1 ? page.data[0] : undefined;
      if (typeof latest?.id !== 'string' || !latest.id.trim() || !['completed', 'failed', 'interrupted'].includes(latest.status)
        || typeof latest.completedAt !== 'number' || !Number.isFinite(latest.completedAt)) {
        throw new CodexThreadBusyError(threadId, 'non_idle');
      }
      const confirmed = await read();
      if (!['idle', 'systemError'].includes(confirmed.status?.type ?? '')) throw new CodexThreadBusyError(threadId, 'non_idle');
    } else if (thread.status?.type !== 'idle') throw new CodexThreadBusyError(threadId, 'non_idle');
    const queue = await this.call<Page<QueueEntry>>('thread/queue/list', { threadId, limit: 1 });
    if (!Array.isArray(queue?.data)) throw new CodexTransportError('Codex вернул некорректную очередь фонового контекста.', 'invalid-protocol');
    if (queue.data.length || queue.nextCursor) throw new CodexThreadBusyError(threadId, 'queued_input');
    if (shared && await receipt()) return;
    current();
    // Raw item IDs are attribution, not server idempotency keys. Never retry the RPC here.
    await this.call('thread/inject_items', {
      threadId, items: [{ type: 'message', id: itemId, role: 'user', content: [{ type: 'input_text', text }] }],
    });
    if (shared && !await receipt()) throw new Error('Codex принял контекст, но сохранённая запись пока не подтверждена. Контекст остаётся в ожидании.');
  }

  private async localContextHome(runtime: CodexRuntime | undefined, selectedHome?: string): Promise<string> {
    const error = 'Для пассивного контекста общего Codex нужен локальный runtime с тем же профилем Rele.';
    const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform;
    const expected = selectedHome || this.config.codexHome || (process.platform === 'win32' ? environmentValue(process.env, 'CODEX_HOME') : process.env.CODEX_HOME) || path.join(homedir(), '.codex');
    try {
      if (!runtime || runtime.platformOs !== os || runtime.platformFamily !== (process.platform === 'win32' ? 'windows' : 'unix')
        || !isLocalCodexHome(runtime.codexHome) || !isLocalCodexHome(expected)) throw new Error();
      const [home, selected] = await Promise.all([realpath(runtime.codexHome), realpath(expected)]);
      if (home !== selected || !isLocalCodexHome(home)) throw new Error();
      return home;
    } catch { throw new Error(error); }
  }

  async enqueue(threadId: string, text: string, clientUserMessageId: string, images: readonly string[] = []): Promise<{ queuedSubmissionId: string }> {
    if (!text.trim()) throw new Error('Нельзя отправить пустой запрос Codex.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(clientUserMessageId)) {
      throw new Error('Запрос Codex должен иметь постоянный UUID для восстановления после обрыва связи.');
    }
    await this.subscribe(threadId);
    this.requireQueue();
    // add is NOT idempotent. Never retry it here, even with the same clientUserMessageId.
    // Auto-drain creates a separate turn atomically; turn/start would steer a Desktop turn.
    const response = await this.call<{ queuedSubmission: QueueEntry }>('thread/queue/add', {
      threadId, input: [{ type: 'text', text }, ...images.map(url => ({ type: 'image', url }))], clientUserMessageId,
    });
    if (!response.queuedSubmission?.id) throw new CodexTransportError('Codex принял запрос, но не вернул идентификатор очереди. Проверьте историю перед повтором.');
    return { queuedSubmissionId: response.queuedSubmission.id };
  }

  /** The caller persists its input intent and proves ownership before this single mutation. */
  async steer(threadId: string, text: string, clientUserMessageId: string, expectedTurnId: string): Promise<{ turnId: string }> {
    if (!threadId.trim() || !text.trim() || !expectedTurnId.trim()) throw new Error('Дополнению нужны разговор, текст и исходный активный ход.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(clientUserMessageId)) {
      throw new Error('Дополнению нужен постоянный UUID для сверки после обрыва связи.');
    }
    this.requireQueue();
    const runtime = this.runtime;
    try {
      // expectedTurnId is native's atomic admission fence. Never substitute turn/start or retry.
      const response = await this.call<{ turnId: string }>('turn/steer', {
        threadId, input: [{ type: 'text', text }], clientUserMessageId, expectedTurnId,
      });
      if (runtime !== this.runtime || !this.state.connected || response?.turnId !== expectedTurnId) {
        throw new CodexTransportError('Codex не подтвердил применение дополнения к исходному ходу. Требуется сверка без повтора.', 'steer-unconfirmed');
      }
      return { turnId: response.turnId };
    } catch (error) {
      if (error instanceof CodexRpcError && error.code === -32600) {
        if (error.message === 'no active turn to steer') throw new CodexSteerRefusedError('no_active_turn');
        const mismatch = /^expected active turn id `([^`\r\n]+)` but found `([^`\r\n]+)`$/u.exec(error.message);
        if (mismatch?.[1] === expectedTurnId && mismatch[2] !== expectedTurnId) throw new CodexSteerRefusedError('turn_mismatch');
      }
      if (error instanceof CodexTransportError) throw error;
      throw new CodexTransportError('Результат применения дополнения неизвестен. Требуется сверка без повтора.', 'steer-unconfirmed');
    }
  }

  /** Continue only the selected submission; native admission never steers an active turn. */
  async startQueued(threadId: string, queuedSubmissionId: string): Promise<{ turn: HistoryTurn }> {
    if (!queuedSubmissionId?.trim()) throw new Error('Укажите подтверждённый элемент очереди Codex.');
    this.requireQueue();
    await this.subscribe(threadId);
    try {
      const response = await this.call<{ turn: HistoryTurn }>('thread/queue/start', { threadId, queuedSubmissionId });
      if (!response?.turn?.id) throw new CodexTransportError('Codex не подтвердил ход продолжения очереди. Требуется сверка перед повтором.', 'queue-start-unconfirmed');
      return response;
    } catch (error) {
      if (error instanceof CodexRpcError && error.code === -32600 && /^thread already has an active or pending turn$/iu.test(error.message)) {
        throw new CodexThreadBusyError(threadId, 'non_idle');
      }
      throw error;
    }
  }

  async deleteQueued(threadId: string, queuedSubmissionId: string): Promise<{ deleted: boolean }> {
    this.requireQueue();
    return this.call('thread/queue/delete', { threadId, queuedSubmissionId });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.requireQueue();
    await this.call('turn/interrupt', { threadId, turnId });
  }

  async backgroundTerminals(threadId: string): Promise<CodexTerminalSnapshot> {
    this.requireQueue();
    const runtime = this.runtime;
    const diagnostic = await this.diagnostics();
    const peer = this.nativePeer;
    const generation = runtime ? await codexNativeGeneration(peer, diagnostic?.process?.id, runtime.codexHome) : undefined;
    const entries = await this.pages<CodexTerminal>('thread/backgroundTerminals/list', { threadId, limit: 100 });
    const after = generation && runtime ? await codexNativeGeneration(peer, diagnostic.process.id, runtime.codexHome) : undefined;
    if (runtime !== this.runtime || peer !== this.nativePeer || !this.state.connected || !Number.isSafeInteger(diagnostic?.process?.id) || diagnostic.process.id <= 0
      || entries.some(entry => !entry || typeof entry.itemId !== 'string' || !entry.itemId || !nativeProcessId(entry.processId))) {
      throw new CodexTransportError('Codex не подтвердил идентичность фоновых команд. Отмена команды требует сверки.', 'terminal-identity-unconfirmed');
    }
    return { serverId: diagnostic.process.id, ...(generation && generation === after ? { serverGeneration: generation } : {}), terminals: entries.map(({ itemId, processId }) => ({ itemId, processId })) };
  }

  async terminateBackgroundTerminal(threadId: string, target: CodexTerminal & { serverId: number; serverGeneration?: string }): Promise<void> {
    const current = await this.backgroundTerminals(threadId);
    const matching = current.terminals.filter(entry => entry.itemId === target.itemId);
    if (target.serverGeneration !== undefined && (!/^[a-f0-9]{64}$/u.test(target.serverGeneration) || current.serverGeneration !== target.serverGeneration)
      || current.serverId !== target.serverId) {
      throw new CodexTransportError('Фоновая команда или сервер изменились. Адресное завершение не отправлено.', 'terminal-identity-changed');
    }
    if (matching.length === 0) return;
    if (matching.length !== 1 || matching[0].processId !== target.processId) {
      throw new CodexTransportError('Фоновая команда или сервер изменились. Адресное завершение не отправлено.', 'terminal-identity-changed');
    }
    // Native has no expected-item CAS: revalidate immediately, never terminate a stored PID blindly.
    const result = await this.call<{ terminated: boolean }>('thread/backgroundTerminals/terminate', { threadId, processId: target.processId });
    if (result?.terminated !== true) throw new CodexTransportError('Codex не подтвердил завершение фоновой команды.', 'terminal-stop-unconfirmed');
  }

  /** A not_found result is evidence for operator review, not permission to resend queue/add. */
  async findRequest(threadId: string, clientId: string, ownInputIds: readonly string[] = [], followRetries = false): Promise<RequestLocation> {
    const known = this.knownInputIds(clientId, ownInputIds);
    const queue = await this.pages<QueueEntry>('thread/queue/list', { threadId, limit: 100 });
    const queued = queue.filter(entry => entry.clientUserMessageId === clientId);
    if (queued.length > 1) throw new Error('В очереди Codex несколько запросов с одним clientId; требуется ручная сверка.');
    const newer: HistoryTurn[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.receiptPage(threadId, cursor);
      const matches = page.data.filter(turn => turn.items.some(item => item.type === 'userMessage' && item.clientId === clientId));
      if (matches.length > 1) throw new Error('В истории Codex несколько ходов с одним clientId; требуется ручная сверка.');
      if (matches.length) {
        let turn = matches[0];
        let found = this.historyLocation(turn, known);
        if (!followRetries || found.mixed || found.failureReason !== 'serverOverloaded') return found;
        const rootTurnId = turn.rootTurnId ?? turn.id;
        let retryCount = 0;
        for (const next of [...newer, ...page.data.slice(0, page.data.indexOf(turn))].reverse()) {
          if (found.failureReason !== 'serverOverloaded') break;
          // Desktop Retry starts a self-rooted successor; only registered inputs may extend it.
          const users = next.items.filter(item => item.type === 'userMessage');
          if (users.length && ((next.rootTurnId !== rootTurnId && next.rootTurnId !== next.id)
            || users.some(item => !item.clientId || !known.has(item.clientId)))) {
            return { ...found, rootTurnId, retryCount, retryBlocked: true };
          }
          if (next.rootTurnId && next.rootTurnId !== next.id && next.rootTurnId !== rootTurnId) {
            return { ...found, rootTurnId, retryCount, retryBlocked: true };
          }
          turn = next;
          const location = this.historyLocation(turn, known);
          const commentary = [...(found.commentary ?? []), ...(location.commentary ?? [])];
          found = { ...location, ...(commentary.length ? { commentary } : {}),
            ...((found.publicHistory || location.publicHistory) ? { publicHistory: [...(found.publicHistory ?? (found.commentary ?? []).map(step => ({ step }))), ...(location.publicHistory ?? (location.commentary ?? []).map(step => ({ step })))] } : {}),
            commandItems: [...(found.commandItems ?? []), ...(location.commandItems ?? [])] };
          retryCount++;
        }
        return { ...found, rootTurnId, retryCount };
      }
      newer.push(...page.data);
      cursor = nextPage(page.nextCursor, seen);
    } while (cursor);
    return queued.length ? { state: 'queued', queuedSubmissionId: queued[0].id, soleQueuedSubmission: queue.length === 1 } : { state: 'not_found' };
  }

  /** Desktop's Retry: continue the history, never replay the original user message. */
  async retryOverloaded(threadId: string, clientId: string, expectedTurnId: string, ownInputIds: readonly string[], beforeSend: () => boolean): Promise<{ turnId: string } | undefined> {
    this.requireQueue();
    const runtime = this.runtime;
    const snapshot = await this.call<{ thread: RawThread }>('thread/read', { threadId });
    const queue = await this.pages<QueueEntry>('thread/queue/list', { threadId, limit: 100 });
    if (snapshot.thread.id !== threadId || !['idle', 'systemError'].includes(snapshot.thread.status?.type ?? '') || queue.length) return;
    const found = await this.findRequest(threadId, clientId, ownInputIds, true);
    if (found.turnId !== expectedTurnId || found.failureReason !== 'serverOverloaded' || found.mixed || found.retryBlocked) return;
    if (snapshot.thread.status?.type === 'systemError') {
      // Native keeps systemError until the next turn; it alone does not prove the failed turn has ended.
      if ('activeFlags' in snapshot.thread.status) return;
      const page = await this.call<Page<HistoryTurn>>('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc' });
      const latest = Array.isArray(page?.data) && page.data.length === 1 ? page.data[0] : undefined;
      if (latest?.id !== expectedTurnId || latest.status !== 'failed' || typeof latest.completedAt !== 'number' || !Number.isFinite(latest.completedAt) || latest.completedAt <= 0) return;
    }
    // shortcut: native has no expected-previous-turn fence; history is checked immediately before sending.
    if (runtime !== this.runtime || !this.state.connected || !beforeSend()) return;
    try {
      // Native rejects empty input on an active turn; it cannot steer another client's work.
      const response = await this.call<{ turn: HistoryTurn }>('turn/start', {
        threadId, input: [], turnTrigger: 'capacity_retry_automatic',
        parentTurnId: expectedTurnId, rootTurnId: found.rootTurnId ?? expectedTurnId,
      });
      if (runtime !== this.runtime || !response?.turn?.id || response.turn.id === expectedTurnId) {
        throw new CodexTransportError('Результат повтора Codex не подтверждён. Ожидается сверка истории без повторной отправки.');
      }
      return { turnId: response.turn.id };
    } catch (error) {
      if (error instanceof CodexRpcError && error.code === -32603 && error.message === 'failed to submit turn input: EmptyInput') {
        throw new CodexThreadBusyError(threadId, 'non_idle');
      }
      throw error;
    }
  }

  /** An absent receipt is uncertain, never permission to replay a steer or enqueue its text. */
  async findSteerReceipt(threadId: string, clientId: string, expectedTurnId: string, ownInputIds: readonly string[] = []): Promise<RequestLocation> {
    if (!expectedTurnId.trim()) throw new Error('Сверке дополнения нужен исходный активный ход.');
    const known = this.knownInputIds(clientId, ownInputIds);
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.receiptPage(threadId, cursor);
      const matches = page.data.filter(turn => turn.items.some(item => item.type === 'userMessage' && item.clientId === clientId));
      if (matches.length) {
        if (matches.length !== 1 || matches[0].items.filter(item => item.type === 'userMessage' && item.clientId === clientId).length !== 1) {
          throw new CodexTransportError('В истории Codex несколько записей дополнения. Требуется сверка без повтора.', 'steer-receipt-duplicate');
        }
        if (matches[0].id !== expectedTurnId) {
          throw new CodexTransportError('Дополнение найдено в другом ходе Codex. Требуется сверка без повтора.', 'steer-receipt-turn-mismatch');
        }
        return this.historyLocation(matches[0], known);
      }
      cursor = nextPage(page.nextCursor, seen);
    } while (cursor);
    return { state: 'not_found' };
  }

  private async receiptPage(threadId: string, cursor?: string): Promise<Page<HistoryTurn>> {
    const runtime = this.runtime;
    const unconfirmed = () => new CodexTransportError('Codex не подтвердил историю запроса. Ожидается сверка без повторной отправки.', 'request-history-unconfirmed');
    const page = await this.call<Page<HistoryTurn>>('thread/turns/list', {
      threadId, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc', ...(cursor ? { cursor } : {}),
    });
    if (runtime !== this.runtime || !this.state.connected || !page || !Array.isArray(page.data)
      || page.nextCursor != null && (typeof page.nextCursor !== 'string' || !page.nextCursor)) throw unconfirmed();
    for (const turn of page.data) {
      if (!turn || typeof turn.id !== 'string' || !turn.id) throw unconfirmed();
      const items: HistoryItem[] = [], seen = new Set<string>();
      let itemCursor: string | undefined;
      do {
        // shortcut: one native item can still exceed the frame limit; reconcile without replay if it does.
        const itemPage = await this.call<Page<{ turnId: string; item: HistoryItem }>>('thread/items/list', {
          threadId, turnId: turn.id, limit: 1, sortDirection: 'asc', ...(itemCursor ? { cursor: itemCursor } : {}),
        });
        if (runtime !== this.runtime || !this.state.connected || !itemPage || !Array.isArray(itemPage.data) || itemPage.data.length > 1
          || itemPage.nextCursor != null && (typeof itemPage.nextCursor !== 'string' || !itemPage.nextCursor)) throw unconfirmed();
        for (const entry of itemPage.data) {
          if (!entry || entry.turnId !== turn.id || !entry.item || typeof entry.item.type !== 'string') throw unconfirmed();
          items.push(entry.item);
        }
        itemCursor = nextPage(itemPage.nextCursor, seen);
      } while (itemCursor);
      turn.items = items;
    }
    return page;
  }

  private knownInputIds(clientId: string, ownInputIds: readonly string[]): Set<string> {
    if (!clientId.trim() || !Array.isArray(ownInputIds) || ownInputIds.some(id => typeof id !== 'string' || !id.trim())) {
      throw new Error('Сверке Codex нужны точные идентификаторы собственных входящих сообщений.');
    }
    return new Set([clientId, ...ownInputIds]);
  }

  /** Read individual items: a long historical turn must not overflow one WebSocket frame. */
  async asyncQuestionState(threadId: string, questionId: string): Promise<{
    turnId: string; question: AsyncQuestion['question']; answer?: { answer: string; clientId?: string };
  } | undefined> {
    if (!threadId.trim() || !questionId.trim()) throw new Error('Сверке вопроса нужны исходные идентификаторы Codex.');
    const runtime = this.runtime, replies: AsyncAnswer[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    for (let count = 0; count < 1_000; count++) {
      const page = await this.call<Page<{ turnId: string; item: HistoryItem }>>('thread/items/list', {
        threadId, limit: 1, sortDirection: 'desc', ...(cursor ? { cursor } : {}),
      });
      if (runtime !== this.runtime || !this.state.connected || !page || !Array.isArray(page.data) || page.data.length > 1
        || page.nextCursor != null && (typeof page.nextCursor !== 'string' || !page.nextCursor)) {
        throw new CodexTransportError('Codex не подтвердил историю вопроса. Ожидается сверка без повторной отправки.', 'async-question-history-unconfirmed');
      }
      for (const entry of page.data) {
        if (!entry || typeof entry.turnId !== 'string' || !entry.turnId || !entry.item || typeof entry.item.type !== 'string') {
          throw new CodexTransportError('Codex не подтвердил запись вопроса.', 'async-question-history-unconfirmed');
        }
        if (entry.item.type === 'userMessage') {
          for (const answer of parseAsyncAnswers(entry.item.content) ?? []) if (answer.questionItemId === questionId) {
            replies.push({ ...answer, ...(typeof entry.item.clientId === 'string' && entry.item.clientId ? { clientId: entry.item.clientId } : {}) });
          }
        }
        const found = asyncQuestions(entry.item).find(({ question }) => question.id === questionId);
        if (found) {
          const answer = replies.find(reply => matchAsyncAnswer(reply, found.question));
          return { turnId: entry.turnId, question: found.question,
            ...(answer ? { answer: { answer: answer.answer, ...(answer.clientId ? { clientId: answer.clientId } : {}) } } : {}) };
        }
      }
      cursor = nextPage(page.nextCursor, seen);
      if (!cursor) return;
    }
    throw new CodexTransportError('История вопроса превышает предел сверки. Повторная отправка не разрешена.', 'async-question-history-limit');
  }

  private historyLocation(turn: HistoryTurn, known: Set<string>): RequestLocation {
    const questions = new Map<string, AsyncQuestion>(), asyncAnswers: AsyncAnswer[] = [];
    let mixed = false;
    const publicHistory: PublicHistoryEvent[] = [];
    for (const item of turn.items) {
      if (item.type === 'agentMessage' && item.delivery !== 'async' && item.phase === 'commentary' && item.text?.trim())
        publicHistory.push({ step: { id: `${turn.id}:${item.id ?? createHash('sha256').update(item.text).digest('hex')}`, text: item.text } });
      for (const entry of asyncQuestions(item)) publicHistory.push({ boundary: `question:${entry.question.id}` });
      for (const question of asyncQuestions(item)) questions.set(question.question.id, question);
      if (item.type !== 'userMessage') continue;
      const answers = parseAsyncAnswers(item.content);
      const matching = answers?.every(answer => {
        const question = questions.get(answer.questionItemId);
        return question && matchAsyncAnswer(answer, question.question);
      });
      if (matching) for (const answer of answers!) publicHistory.push({ boundary: `answer:${answer.questionItemId}` });
      else if (item.clientId && known.has(item.clientId) && publicHistory.length) publicHistory.push({ boundary: `input:${item.clientId}` });
      if (matching) asyncAnswers.push(...answers!.map(answer => ({ ...answer,
        ...(typeof item.clientId === 'string' && item.clientId ? { clientId: item.clientId } : {}) })));
      if ((typeof item.clientId !== 'string' || !known.has(item.clientId)) && !matching) mixed = true;
    }
    const state = turn.status === 'inProgress' ? 'running' : turn.status;
    if (!['running', 'completed', 'failed', 'interrupted'].includes(state)) throw new Error('Неизвестное состояние хода Codex.');
    const failureReason = state === 'failed' ? nativeFailureReason(turn.error) : undefined;
    // Native history can normalize a live snapshot to interrupted without a terminal event.
    if (state === 'interrupted' && (typeof turn.completedAt !== 'number' || !Number.isFinite(turn.completedAt))) {
      throw new CodexTransportError('Codex пока не подтвердил прерывание запроса. Ожидается сверка завершения без повторной отправки.', 'turn-interruption-unconfirmed');
    }
    const commentary = turn.items.filter(item => item.type === 'agentMessage' && item.delivery !== 'async' && item.phase === 'commentary' && item.text?.trim())
      .map(item => ({ id: `${turn.id}:${item.id ?? createHash('sha256').update(item.text!).digest('hex')}`, text: item.text! }));
    const answers = turn.items.filter(item => item.type === 'agentMessage' && item.delivery !== 'async' && item.phase === 'final_answer')
      .map(item => item.text || '');
    const visibleAnswers = answers.filter(text => text.trim() !== 'NOREPLY');
    const finalText = visibleAnswers.join('\n\n');
    const legacy = turn.items.filter(item => item.type === 'agentMessage' && item.delivery !== 'async' && item.phase == null);
    const unanswered = [...questions.values()].filter(({ question }) => !asyncAnswers.some(answer => answer.questionItemId === question.id));
    return {
      state: state as RequestLocation['state'], turnId: turn.id,
      ...(mixed ? { mixed: true } : {
        ...(commentary.length ? { commentary } : {}),
        ...(publicHistory.some(event => 'boundary' in event) ? { publicHistory } : {}),
        text: !answers.length ? legacy.at(-1)?.text
          : !finalText.trim() && visibleAnswers.length < answers.length ? 'NOREPLY' : finalText,
        ...(failureReason ? { failureReason } : {}),
        ...(turn.items.some(item => codexCommandItem(item)) ? { commandItems: turn.items.flatMap(item => { const command = codexCommandItem(item); return command ? [command] : []; }) } : {}),
        ...(['running', 'completed'].includes(state) && unanswered.length ? { asyncQuestions: unanswered } : {}),
        ...(asyncAnswers.length ? { asyncAnswers } : {}),
      }),
    };
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

  hasPendingRequest(rpcId: RpcId): boolean { return this.serverRequests.has(rpcId); }

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
    this.nativePeer = undefined;
    this.version = undefined;
    this.setState({ connected: false, queueSupported: false, codexHome: undefined });
    let target: CodexConnectionTarget = { executable: this.config.executable, transport: this.config.transport, endpoint: this.config.endpoint ?? '', ...(this.config.codexHome ? { codexHome: this.config.codexHome } : {}) };
    if (target.transport === 'shared') target = await (this.options.shared ?? ensureSharedCodex)(target, { ...(this.options.discover ? { discover: this.options.discover } : {}) });
    else if (target.transport !== 'websocket' && target.executable === 'codex') {
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
    this.setState({ executable: target.executable, transport: this.config.transport === 'shared' ? 'shared' : target.transport, endpoint: target.endpoint });
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
      try {
        await stdio.ready;
        if (stdio.pid) {
          let codexHome: string | undefined;
          try { codexHome = effectiveSharedCodexHome(env); } catch { /* An unknown launch profile cannot attest stdio. */ }
          this.nativePeer = { kind: 'stdio', pid: stdio.pid, executable: launch.command, codexHome, helperExecutable: stdio.helperExecutable };
        }
      }
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
        if (this.proxy.pid && target.endpoint) this.nativePeer = { kind: 'proxy', pid: this.proxy.pid, endpoint: target.endpoint };
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
    if (process.platform === 'win32' && this.config.transport === 'shared' && target.transport === 'websocket') {
      const connection = (this.socket as WebSocket & { _socket?: Socket } | undefined)?._socket;
      if (connection?.localAddress === '127.0.0.1' && connection.remoteAddress === '127.0.0.1' && connection.localPort && connection.remotePort) {
        this.nativePeer = { kind: 'windows-shared', endpoint: target.endpoint, localPort: connection.localPort, remotePort: connection.remotePort };
      }
    }
    this.runtime = await this.call<CodexRuntime>('initialize', {
      clientInfo: { name: 'rele', title: 'Rele', version: '0.1.0' }, capabilities: { experimentalApi: true },
    });
    await this.send({ method: 'initialized' });
    if (typeof this.runtime?.userAgent !== 'string' || typeof this.runtime.codexHome !== 'string') throw new CodexTransportError('Codex вернул некорректные сведения о сервере.', 'invalid-protocol');
    if (this.config.transport === 'shared') {
      try { await this.localContextHome(this.runtime, target.codexHome); }
      catch { throw new SharedCodexError('Общий Codex использует другой профиль или платформу. Выберите исходный локальный профиль; запись остановлена.', 'shared-profile-mismatch'); }
    }
    this.version = this.runtime.userAgent.match(/\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)(?=\s|$)/u)?.[1];
    if (this.options.expectedVersion && this.version !== this.options.expectedVersion) throw new CodexTransportError(
      'Codex не подтвердил версию после обновления. Очередь сохранена; повторяется только подключение.', 'update-version-mismatch');
    this.setState({ name: this.version ? `Codex ${this.version}` : 'Codex', connected: true, codexHome: this.runtime.codexHome, error: undefined, errorCode: undefined });
    if (this.socket) this.startHeartbeat(this.socket);
    if (!this.isVerifiedVersion()) {
      this.setState({ error: `Запись доступна для проверенного Codex ${SUPPORTED_CODEX_VERSIONS.join(' или ')}; подключён ${this.version || 'неизвестный runtime'}.` });
    } else {
      let pluginError = false;
      if (this.options.setupPlugin) {
        try { await this.options.setupPlugin((method, params) => this.call(method, params), this.runtime); }
        catch { pluginError = true; }
      }
      await this.probeQueue();
      if (pluginError) this.setState({ error: 'Инструменты Rele не подключены: Codex не подтвердил установку собственного плагина. Настройки модели и чужие плагины сохранены.' });
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

  isVerifiedVersion(): boolean {
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

  private call<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = this.options.rpcTimeoutMs ?? 30_000, confirmHealth = true): Promise<T> {
    const id = randomUUID(), socket = this.socket;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexTransportError(`Codex не подтвердил ${method} вовремя; проверьте состояние перед повтором.`, 'rpc-timeout'));
        if (confirmHealth && socket && this.socket === socket && this.state.connected) this.checkSocketHealth(socket);
      }, timeoutMs);
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

  private failSocket(socket: WebSocket, message: string, code: string): void {
    if (this.socket !== socket) return;
    void this.disconnect(message, code).catch(() => {});
    this.scheduleReconnect();
  }

  private startHeartbeat(socket: WebSocket): void {
    clearTimeout(this.heartbeatTimer);
    let token: string | undefined;
    const schedule = (timeout: number) => {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = setTimeout(() => {
        if (this.socket !== socket) return;
        if (token) {
          this.failSocket(socket, 'Codex не отвечает на проверку соединения. Неподтверждённые запросы требуют сверки; подключение будет повторено.', 'heartbeat-timeout');
          return;
        }
        token = randomUUID();
        try { socket.ping(token, undefined, error => { if (error) this.failSocket(socket, 'Codex не подтвердил проверку соединения.', 'heartbeat-failed'); }); }
        catch { this.failSocket(socket, 'Codex не подтвердил проверку соединения.', 'heartbeat-failed'); }
        if (this.socket === socket) schedule(this.options.heartbeatTimeoutMs ?? 5_000);
      }, timeout);
      this.heartbeatTimer.unref();
    };
    socket.on('pong', data => {
      if (this.socket !== socket || !token || data.toString() !== token) return;
      token = undefined;
      schedule(this.options.heartbeatIntervalMs ?? 15_000);
    });
    schedule(this.options.heartbeatIntervalMs ?? 15_000);
  }

  private checkSocketHealth(socket: WebSocket): void {
    if (this.healthCheck?.socket === socket) return;
    const check = { socket, queueSupported: this.state.queueSupported, error: this.state.error, errorCode: this.state.errorCode };
    this.healthCheck = check;
    const pauseError = 'Codex не подтвердил запрос вовремя. Проверяется соединение; новые запросы приостановлены.';
    this.setState({ queueSupported: false, error: pauseError, errorCode: 'rpc-timeout' });
    void this.call<{ process?: { id?: number } }>('server/diagnostics', {}, this.options.heartbeatTimeoutMs ?? 5_000, false).then(result => {
      if (this.socket !== socket) return;
      const pid = result?.process?.id;
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new CodexTransportError('Codex не подтвердил проверку состояния.', 'rpc-health-unconfirmed');
      if (this.healthCheck === check && !this.state.queueSupported && this.state.error === pauseError && this.state.errorCode === 'rpc-timeout') {
        this.setState({ queueSupported: check.queueSupported, error: check.error, errorCode: check.errorCode });
      }
    }).catch(() => {
      this.failSocket(socket, 'Codex не отвечает на проверку состояния. Неподтверждённые запросы требуют сверки; подключение будет повторено.', 'rpc-health-timeout');
    }).finally(() => { if (this.healthCheck === check) this.healthCheck = undefined; });
  }

  private disconnect(message: string, errorCode?: string): Promise<void> {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.healthCheck = undefined;
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
    this.runtime = undefined;
    this.version = undefined;
    this.contextReceipts.clear();
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

