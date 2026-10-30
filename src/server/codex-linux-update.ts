import type { CodexConnectionState, CodexConnectionTarget } from '../shared/types.js';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, readlink, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { compareCodexVersions, SUPPORTED_CODEX_VERSIONS } from '../shared/codex-runtime.js';
import { codexEnvironment } from './codex-launch.js';
import { completeCodexPackage, effectiveSharedCodexHome } from './codex-shared.js';

export interface LinuxCodexCandidate { executable: string; version: string; sha256: string }
export interface LinuxCodexOwner extends LinuxCodexCandidate {
  kind: 'daemon'; codexHome: string; endpoint: string; pid: number; startTicks: string; uid: number;
  pidRecordPath: string; pidRecordSha256: string;
}
export interface LinuxCodexPending {
  candidate: LinuxCodexCandidate; owner: LinuxCodexOwner;
  phase: 'ready' | 'signal-intent' | 'draining' | 'start-intent' | 'verified' | 'uncertain';
  baseline?: Array<[string, boolean]>;
  selectionAttempted?: boolean; managedExecutable?: string; resolvedManagedExecutable?: string;
  startAttempted?: boolean; errorCode?: string;
}
export interface LinuxCodexInspection {
  available: boolean; reason?: string; reasonCode?: string; owner?: LinuxCodexOwner; pending?: LinuxCodexPending;
}
export interface LinuxCodexApplyResult extends LinuxCodexCandidate {
  codexHome: string; endpoint: string; pid: number; startTicks: string; uid: number;
  cleanup: 'native-managed';
}
interface ProcessIdentity { pid: number; startTicks: string; uid: number; executable: string; sha256: string; cgroup: string }
interface Snapshot { version: string; codexHome: string; pid: number; idle?: boolean; loaded?: string; catalog?: Array<[string, boolean]> }
interface CommandResult { stdout: string; code: number | null }
export interface LinuxCodexUpdateOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<CommandResult>;
  readProcess?: (pid: number) => Promise<ProcessIdentity | undefined>;
  timeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
}
export class LinuxCodexUpdateError extends Error {
  constructor(message: string, readonly statusCode = 409, readonly code = 'linux-update-unconfirmed') { super(message); this.name = 'LinuxCodexUpdateError'; }
}

const execute = promisify(execFile), hashes = new Map<string, string>();
const SHA = /^[a-f0-9]{64}$/u, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const uncertain = 'Результат обновления Codex требует сверки. Повторный сигнал не отправлен; очередь сохранена.';
const external = 'Codex запущен внешней службой или другим владельцем. Rele не меняет и не перезапускает эту службу.';
function requireValue(ok: unknown, message: string, code = 'linux-owner-unconfirmed'): asserts ok {
  if (!ok) throw new LinuxCodexUpdateError(message, 409, code);
}
function sameOwner(a: LinuxCodexOwner, b: LinuxCodexOwner): boolean {
  return ['pid', 'startTicks', 'uid', 'executable', 'sha256', 'codexHome', 'endpoint', 'pidRecordPath', 'pidRecordSha256'].every(key => a[key as keyof LinuxCodexOwner] === b[key as keyof LinuxCodexOwner]);
}
async function digest(file: string): Promise<string> {
  const value = createHash('sha256'); for await (const chunk of createReadStream(file)) value.update(chunk); return value.digest('hex');
}
async function command(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  try { const { stdout } = await execute(command, args, { env, timeout: 120_000, maxBuffer: 64 * 1024 }); return { stdout, code: 0 }; }
  catch { throw new LinuxCodexUpdateError('Штатная команда Codex не подтвердила результат. Проверьте состояние перед повтором.', 502, 'linux-command-unconfirmed'); }
}
async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const root = `/proc/${pid}`, before = await readFile(`${root}/stat`, 'utf8'), fields = before.slice(before.lastIndexOf(') ') + 2).split(/\s+/u);
    const startTicks = fields[19], executable = await readlink(`${root}/exe`), info = await stat(`${root}/exe`), uid = (await stat(root)).uid;
    const key = JSON.stringify([pid, startTicks, executable, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
    let sha256 = hashes.get(key);
    if (!sha256) { sha256 = await digest(`${root}/exe`); if (hashes.size >= 16) hashes.clear(); hashes.set(key, sha256); }
    const after = await readFile(`${root}/stat`, 'utf8');
    requireValue(after.slice(after.lastIndexOf(') ') + 2).split(/\s+/u)[19] === startTicks, 'Процесс Codex изменился во время проверки.');
    return { pid, startTicks, executable, sha256, uid, cgroup: await readFile(`${root}/cgroup`, 'utf8') };
  } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error; }
}
function empty(page: unknown): boolean {
  const value = page as { data?: unknown; nextCursor?: unknown } | undefined;
  return !!value && Array.isArray(value.data) && !value.data.length && Object.hasOwn(value, 'nextCursor') && value.nextCursor === null;
}
function idleThread(thread: Record<string, unknown>, result: Record<string, unknown>): boolean {
  const status = thread.status as Record<string, unknown> | undefined;
  if (status?.type !== 'idle') return false;
  for (const row of [result, thread, status]) for (const key of ['activeFlags', 'pendingRequests', 'requests']) {
    if (Object.hasOwn(row, key) && (!Array.isArray(row[key]) || (row[key] as unknown[]).length)) return false;
  }
  return true;
}
function idleGauges(value: unknown, loaded: number): boolean {
  if (!Array.isArray(value)) return false;
  // Native metrics are registered lazily: absent zero-work series are normal.
  const allowed = new Set(['app.requests.in_flight', 'app.requests.queued', 'app.server_requests.pending', 'core.mailbox.pending', 'core.turns.active', 'core.threads.live', 'mcp.connections.live']), seen = new Set<string>();
  for (const row of value) {
    if (typeof row?.name !== 'string' || !allowed.has(row.name) || seen.has(row.name) || !Number.isSafeInteger(row.value) || row.value < 0) return false;
    seen.add(row.name);
    if (row.name === 'app.requests.in_flight' ? row.value !== 1 : row.name === 'core.threads.live' ? row.value > loaded : row.name === 'mcp.connections.live' ? false : row.value !== 0) return false;
  }
  return seen.has('app.requests.in_flight');
}
async function snapshot(endpoint: string, codexHome: string, detailed = false): Promise<Snapshot> {
  const socket = new WebSocket(`ws+unix:${endpoint}:/`, { handshakeTimeout: 10_000, maxPayload: 16 * 1024 * 1024 });
  let sequence = 0, pending: { id: number; resolve: (value: any) => void; reject: (error: Error) => void } | undefined, failure: Error | undefined;
  const fail = () => { failure ??= new LinuxCodexUpdateError('Codex не подтвердил состояние работы.', 409, 'linux-idle-unconfirmed'); pending?.reject(failure); };
  socket.on('error', fail); socket.on('close', fail);
  socket.on('message', raw => {
    try {
      const value = JSON.parse(raw.toString());
      if (value.method && value.id !== undefined) { fail(); return; }
      if (pending && value.id === pending.id && !value.method) { const next = pending; pending = undefined; value.error ? next.reject(new LinuxCodexUpdateError('Codex не подтвердил проверку работы.', 409, 'linux-idle-unconfirmed')) : next.resolve(value.result); }
    } catch { fail(); }
  });
  const timer = setTimeout(() => { fail(); socket.terminate(); }, detailed ? 90_000 : 15_000);
  const call = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    if (failure) { reject(failure); return; }
    pending = { id: ++sequence, resolve, reject };
    socket.send(JSON.stringify({ id: sequence, method, params }), error => { if (error) fail(); });
  });
  const pages = async (method: string, params: object) => {
    const rows: any[] = [], cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const page = await call(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) });
      requireValue(Array.isArray(page?.data) && (page.nextCursor === null || typeof page.nextCursor === 'string' && !!page.nextCursor), 'Codex вернул неизвестную страницу состояния.');
      rows.push(...page.data); requireValue(rows.length <= 100000, 'Слишком большой каталог Codex.');
      cursor = page.nextCursor ?? undefined;
      if (cursor) { requireValue(!cursors.has(cursor), 'Codex повторил курсор состояния.'); cursors.add(cursor); }
    } while (cursor);
    return rows;
  };
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); const closed = () => reject(new LinuxCodexUpdateError('Сокет общего Codex недоступен.', 409, 'linux-socket-unavailable')); socket.once('error', closed); socket.once('close', closed); });
    const init = await call('initialize', { clientInfo: { name: 'rele_linux_update', version: '0.0.0' }, capabilities: { experimentalApi: true } });
    const version = typeof init?.userAgent === 'string' ? init.userAgent.match(/\/(\S+)(?:\s|$)/u)?.[1] : undefined;
    requireValue(version && SUPPORTED_CODEX_VERSIONS.includes(version) && typeof init.codexHome === 'string' && await realpath(init.codexHome) === codexHome && init.platformFamily === 'unix', 'Codex подтвердил другой профиль или неизвестную версию.');
    socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    const diagnostics = await call('server/diagnostics');
    requireValue(Number.isSafeInteger(diagnostics?.process?.id) && diagnostics.process.id > 0, 'Codex не подтвердил PID сервера.');
    const result: Snapshot = { version, codexHome, pid: diagnostics.process.id };
    if (!detailed) return result;
    const ids = (await pages('thread/loaded/list', {})).sort();
    requireValue(ids.every(id => typeof id === 'string' && UUID.test(id)) && new Set(ids).size === ids.length, 'Codex не подтвердил загруженные разговоры.');
    let idle = idleGauges(diagnostics.gauges, ids.length);
    for (const threadId of ids) {
      const value = await call('thread/read', { threadId, includeTurns: false }), thread = value?.thread;
      requireValue(thread?.id === threadId && typeof thread.ephemeral === 'boolean', 'Codex не подтвердил тип разговора.');
      const queued = thread.ephemeral ? true : empty(await call('thread/queue/list', { threadId, limit: 1 }));
      const terminals = empty(await call('thread/backgroundTerminals/list', { threadId, limit: 1 }));
      idle = idle && idleThread(thread, value) && queued && terminals;
    }
    requireValue(JSON.stringify(ids) === JSON.stringify((await pages('thread/loaded/list', {})).sort()), 'Состав работающих разговоров изменился.');
    const catalog: Array<[string, boolean]> = [];
    for (const archived of [false, true]) for (const row of await pages('thread/list', { archived, sourceKinds: [], modelProviders: [], useStateDbOnly: true })) {
      requireValue(typeof row?.id === 'string' && UUID.test(row.id), 'Codex вернул неизвестный идентификатор разговора.'); catalog.push([row.id, archived]);
    }
    requireValue(new Set(catalog.map(row => row[0])).size === catalog.length, 'Каталог Codex повторил идентификатор.');
    return { ...result, idle, loaded: JSON.stringify(ids), catalog: catalog.sort((a, b) => a[0].localeCompare(b[0])) };
  } finally { clearTimeout(timer); socket.terminate(); }
}

/** Native lifecycle only; selection policy, Engine maintenance and user confirmation belong to the caller. */
export class LinuxCodexUpdate {
  private busy = false;
  constructor(readonly dataDirectory: string, readonly options: LinuxCodexUpdateOptions = {}) {}
  private get file(): string { return path.join(this.dataDirectory, 'codex-linux-update.json'); }
  private env(home: string): NodeJS.ProcessEnv { return codexEnvironment(home, this.options.env ?? process.env); }
  private run(command: string, args: string[], home: string): Promise<CommandResult> { return (this.options.run ?? commandRunner)(command, args, this.env(home)); }
  private process(pid: number): Promise<ProcessIdentity | undefined> { return (this.options.readProcess ?? processIdentity)(pid); }
  private async scope(target: CodexConnectionTarget, current: CodexConnectionState): Promise<{ codexHome: string; endpoint: string }> {
    requireValue((this.options.platform ?? process.platform) === 'linux' && ['shared', 'proxy'].includes(target.transport) && !(target as { token?: string }).token, 'Управляемое обновление требует локальный Linux Codex.', 'linux-target-unsupported');
    const codexHome = await realpath(effectiveSharedCodexHome(this.env(target.codexHome ?? current.codexHome ?? ''))), endpoint = path.join(codexHome, 'app-server-control', 'app-server-control.sock');
    requireValue((target.transport === 'shared' ? !target.endpoint : target.endpoint === endpoint) && (!current.endpoint || current.endpoint === endpoint) && (!current.codexHome || await realpath(current.codexHome) === codexHome), 'Обновление требует прежние профиль и UDS Codex.', 'linux-profile-mismatch');
    return { codexHome, endpoint };
  }
  private async pending(home: string): Promise<LinuxCodexPending | undefined> {
    try {
      const info = await lstat(this.file); requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024 && info.uid === process.getuid?.() && !(info.mode & 0o077), 'Журнал обновления Codex требует проверки.');
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      requireValue(value?.schema === 1 && value.pending?.owner?.codexHome === home && ['ready', 'signal-intent', 'draining', 'start-intent', 'verified', 'uncertain'].includes(value.pending?.phase) && SHA.test(value.pending?.candidate?.sha256) && SHA.test(value.pending?.owner?.sha256) && Number.isSafeInteger(value.pending.owner.pid) && /^\d+$/u.test(value.pending.owner.startTicks), 'Журнал обновления относится к другому или неизвестному Codex.');
      return value.pending as LinuxCodexPending;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  private async save(value: LinuxCodexPending): Promise<void> {
    requireValue(await realpath(this.dataDirectory) === path.resolve(this.dataDirectory), 'Каталог данных Rele изменился.');
    const temporary = `${this.file}.${randomBytes(12).toString('hex')}.tmp`, file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ schema: 1, pending: value }) + '\n'); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, this.file); const directory = await open(this.dataDirectory, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    finally { await unlink(temporary).catch(() => {}); }
  }
  private async owner(meta: Snapshot, endpoint: string): Promise<LinuxCodexOwner> {
    const value = await this.process(meta.pid);
    requireValue(value && value.uid === process.getuid?.() && path.isAbsolute(value.executable) && SHA.test(value.sha256), external, 'linux-owner-external');
    requireValue(!value.cgroup.split('\n').some(line => { const unit = path.basename(line.slice(line.lastIndexOf(':') + 1)); return unit.endsWith('.service') && unit !== 'rele-codex.service'; }), external, 'linux-owner-external');
    requireValue(meta.version === '0.166.0-alpha.5.1', 'Безопасный graceful update подтверждён только для Codex 0.166.0-alpha.5.1.', 'linux-graceful-unsupported');
    const status = await this.run(value.executable, ['app-server', 'daemon', 'version'], meta.codexHome);
    let daemon: any; try { daemon = JSON.parse(status.stdout); } catch { throw new LinuxCodexUpdateError(external, 409, 'linux-owner-external'); }
    requireValue(status.code === 0 && daemon.status === 'running' && daemon.backend === 'pid' && daemon.socketPath === endpoint && daemon.appServerVersion === meta.version && typeof daemon.managedCodexPath === 'string' && await realpath(daemon.managedCodexPath) === value.executable, external, 'linux-owner-external');
    const home = meta.codexHome, records: Array<{ file: string; raw: string; value: any }> = [];
    for (const name of ['daemon.pid', 'app-server.pid']) {
      const file = path.join(home, 'app-server-daemon', name);
      try { const info = await lstat(file), raw = await readFile(file, 'utf8'); requireValue(info.isFile() && !info.isSymbolicLink() && info.uid === value.uid && info.size <= 16 * 1024, external); records.push({ file, raw, value: JSON.parse(raw) }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    requireValue(records.length === 1 && records[0].value.pid === value.pid && typeof records[0].value.processStartTime === 'string', external, 'linux-owner-external');
    const ps = await this.run('/usr/bin/ps', ['-p', String(value.pid), '-o', 'lstart='], home);
    requireValue(ps.code === 0 && ps.stdout.trim() === records[0].value.processStartTime, external, 'linux-owner-external');
    for (const name of ['daemon-updater.pid', 'app-server-updater.pid']) {
      try { await lstat(path.join(home, 'app-server-daemon', name)); throw new LinuxCodexUpdateError('Сначала завершите штатный updater Codex; Rele не останавливает его процессы.', 409, 'linux-updater-active'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return { kind: 'daemon', ...value, codexHome: home, endpoint, version: meta.version, pidRecordPath: records[0].file, pidRecordSha256: createHash('sha256').update(records[0].raw).digest('hex') };
  }
  async inspect(target: CodexConnectionTarget, current: CodexConnectionState): Promise<LinuxCodexInspection> {
    try {
      const scope = await this.scope(target, current), pending = await this.pending(scope.codexHome);
      requireValue(this.env(scope.codexHome).RELE_CODEX_DAEMON_EXTERNAL !== '1' || target.transport === 'shared', 'Для обновления через штатный Linux starter требуется режим «Общий Codex».', 'linux-starter-unavailable');
      const previous = pending && !['ready', 'verified'].includes(pending.phase) ? await this.process(pending.owner.pid) : undefined;
      if (pending && !['ready', 'verified'].includes(pending.phase) && (!previous || previous.startTicks !== pending.owner.startTicks)) return { available: true, owner: pending.owner, pending, ...(pending.phase === 'uncertain' ? { reason: uncertain, reasonCode: pending.errorCode } : {}) };
      const owner = await this.owner(await snapshot(scope.endpoint, scope.codexHome), scope.endpoint);
      return { available: true, owner, ...(pending ? { pending } : {}) };
    } catch (error) {
      const safe = error instanceof LinuxCodexUpdateError ? error : new LinuxCodexUpdateError('Не удалось подтвердить владельца Linux Codex. Сервер не изменён.');
      return { available: false, reason: safe.message, reasonCode: safe.code };
    }
  }
  private async candidate(value: LinuxCodexCandidate, home: string): Promise<LinuxCodexCandidate> {
    requireValue(path.isAbsolute(value.executable) && SUPPORTED_CODEX_VERSIONS.includes(value.version) && SHA.test(value.sha256), 'Выберите существующий поддержанный пакет Codex.');
    const executable = await realpath(value.executable);
    requireValue(await digest(executable) === value.sha256 && await completeCodexPackage(executable) === value.version, 'Выбранный пакет Codex изменился или неполон.', 'linux-candidate-changed');
    const result = await this.run(executable, ['--version'], home);
    requireValue(result.code === 0 && result.stdout.trim() === `codex-cli ${value.version}` && await digest(executable) === value.sha256, 'Версия выбранного Codex не подтверждена.', 'linux-candidate-changed');
    return { ...value, executable };
  }
  private async socketIdle(owner: LinuxCodexOwner): Promise<void> {
    const helper = fileURLToPath(new URL('../../scripts/linux/rele-codex-signal.py', import.meta.url)), deadline = Date.now() + 3_000;
    for (;;) {
      const result = await this.run('/usr/bin/python3', ['-I', helper, '--peers', String(owner.pid), owner.endpoint], owner.codexHome);
      const value = JSON.parse(result.stdout);
      requireValue(result.code === 0 && value.listener === true && Number.isSafeInteger(value.peers) && value.peers >= 0, 'Не удалось подтвердить клиентов UDS Codex.', 'linux-peers-unconfirmed');
      if (value.peers === 0) return;
      requireValue(Date.now() < deadline, 'У Codex остаются другие подключения. Закройте CLI и клиентов общего сервера.', 'linux-native-busy');
      await (this.options.wait ?? delay)(100);
    }
  }
  private async complete(pending: LinuxCodexPending): Promise<LinuxCodexApplyResult> {
    const { owner, candidate } = pending;
    requireValue(pending.managedExecutable && pending.resolvedManagedExecutable, uncertain);
    requireValue(await realpath(pending.managedExecutable) === pending.resolvedManagedExecutable && await digest(pending.managedExecutable) === candidate.sha256, 'Штатный выбор пакета Codex изменился.');
    const after = await snapshot(owner.endpoint, owner.codexHome, true), next = await this.owner(after, owner.endpoint);
    requireValue((next.pid !== owner.pid || next.startTicks !== owner.startTicks) && next.version === candidate.version && next.sha256 === candidate.sha256 && next.executable === pending.resolvedManagedExecutable, uncertain);
    const catalog = new Map(after.catalog);
    requireValue(pending.baseline?.every(([id, archived]) => catalog.has(id) && catalog.get(id) === archived), 'Codex не подтвердил сохранность исходного каталога; требуется сверка.');
    pending.phase = 'verified'; await this.save(pending);
    return { executable: next.executable, version: next.version, sha256: next.sha256, pid: next.pid, startTicks: next.startTicks, uid: next.uid, codexHome: next.codexHome, endpoint: next.endpoint, cleanup: 'native-managed' };
  }
  private async waitForStarter(pending: LinuxCodexPending): Promise<LinuxCodexApplyResult> {
    const deadline = Date.now() + (this.options.timeoutMs ?? 60_000);
    for (;;) {
      try { return await this.complete(pending); }
      catch (error) {
        if (!(error instanceof LinuxCodexUpdateError) || error.code !== 'linux-socket-unavailable' || Date.now() >= deadline) throw error;
      }
      await (this.options.wait ?? delay)(250);
    }
  }
  /** Called only by the existing rele-codex.service starter, outside the gateway cgroup. */
  async startPrepared(target: CodexConnectionTarget): Promise<boolean> {
    const scope = await this.scope(target, { configured: true, connected: false, queueSupported: false, desktopVerified: false }), pending = await this.pending(scope.codexHome);
    if (!pending || ['ready', 'verified'].includes(pending.phase)) return false;
    requireValue(this.env(scope.codexHome).RELE_CODEX_DAEMON_EXTERNAL !== '1', 'Общий Codex запускается только независимым Linux starter.', 'linux-starter-unavailable');
    // Timer invocations during drain or an unconfirmed package selection must not cold-start the old runtime.
    if (!pending.startAttempted || !pending.managedExecutable || !pending.resolvedManagedExecutable) return true;
    const old = await this.process(pending.owner.pid);
    requireValue(!old || old.startTicks !== pending.owner.startTicks, 'Прежний Codex ещё завершает работу.', 'linux-drain-pending');
    await this.candidate(pending.candidate, scope.codexHome);
    requireValue(await realpath(pending.managedExecutable) === pending.resolvedManagedExecutable && await digest(pending.managedExecutable) === pending.candidate.sha256, 'Штатный выбор Codex изменился; starter не запускал сервер.');
    const intent = JSON.stringify([pending.owner.codexHome, pending.owner.endpoint, pending.owner.pid, pending.owner.startTicks, pending.candidate, pending.resolvedManagedExecutable]) + '\n';
    const dispatch = path.join(this.dataDirectory, `codex-linux-start-${createHash('sha256').update(intent).digest('hex')}.json`);
    let record;
    try { record = await open(dispatch, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await lstat(dispatch);
      requireValue(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.() && !(info.mode & 0o077) && info.size <= 16 * 1024 && await readFile(dispatch, 'utf8') === intent, 'Журнал запуска Codex требует сверки.');
      return true; // A lost ACK is reconciled by apply; a timer never repeats the dispatch.
    }
    try { await record.writeFile(intent); await record.sync(); } finally { await record.close(); }
    const directory = await open(this.dataDirectory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    const result = await this.run(pending.candidate.executable, ['app-server', 'daemon', 'start'], scope.codexHome), receipt = JSON.parse(result.stdout);
    requireValue(result.code === 0 && ['started', 'alreadyRunning'].includes(receipt.status) && receipt.socketPath === scope.endpoint && receipt.managedCodexVersion === pending.candidate.version && receipt.appServerVersion === pending.candidate.version && await realpath(receipt.managedCodexPath) === pending.resolvedManagedExecutable, uncertain);
    return true;
  }
  async prepare(target: CodexConnectionTarget, current: CodexConnectionState, value: LinuxCodexCandidate): Promise<LinuxCodexInspection> {
    requireValue(!this.busy && current.connected, 'Подключите Codex перед подготовкой обновления.'); this.busy = true;
    try {
      const before = await this.inspect(target, current); requireValue(before.available && before.owner, before.reason ?? external, before.reasonCode);
      requireValue(!before.pending || ['ready', 'verified'].includes(before.pending.phase), uncertain);
      const candidate = await this.candidate(value, before.owner.codexHome);
      requireValue(compareCodexVersions(candidate.version, before.owner.version) >= 0, 'Понижение версии существующего профиля Codex не поддерживается.');
      const helper = fileURLToPath(new URL('../../scripts/linux/rele-codex-signal.py', import.meta.url));
      const supported = await this.run('/usr/bin/python3', ['-I', helper, '--check'], before.owner.codexHome);
      requireValue(supported.code === 0 && JSON.parse(supported.stdout).supported === true, 'Linux не предоставляет pidfd для адресного сигнала Codex.', 'linux-pidfd-unavailable');
      const fresh = await this.owner(await snapshot(before.owner.endpoint, before.owner.codexHome), before.owner.endpoint);
      requireValue(sameOwner(before.owner, fresh), 'Владелец Codex изменился во время подготовки.');
      const pending: LinuxCodexPending = { candidate, owner: fresh, phase: 'ready' }; await this.save(pending);
      return { available: true, owner: fresh, pending };
    } finally { this.busy = false; }
  }
  async apply(target: CodexConnectionTarget, current: CodexConnectionState): Promise<LinuxCodexApplyResult> {
    requireValue(!this.busy, 'Обновление Codex уже выполняется.'); this.busy = true;
    let pending: LinuxCodexPending | undefined;
    try {
      const scope = await this.scope(target, current); pending = await this.pending(scope.codexHome);
      requireValue(pending && pending.phase !== 'verified', 'Сначала подготовьте обновление Codex.');
      await this.candidate(pending.candidate, pending.owner.codexHome);
      const { owner, candidate } = pending;
      if (pending.phase === 'ready') {
        const first = await snapshot(owner.endpoint, owner.codexHome, true), actual = await this.owner(first, owner.endpoint);
        requireValue(sameOwner(owner, actual) && first.idle === true, 'Codex занят: завершите разговоры, вопросы, очередь и фоновые команды.', 'linux-native-busy');
        await (this.options.wait ?? delay)(100);
        const fresh = await snapshot(owner.endpoint, owner.codexHome, true);
        requireValue(fresh.idle === true && fresh.loaded === first.loaded && sameOwner(owner, await this.owner(fresh, owner.endpoint)), 'Работа Codex изменилась; обновление не начато.', 'linux-native-busy');
        await this.socketIdle(owner);
        pending.baseline = fresh.catalog; pending.phase = 'signal-intent'; await this.save(pending);
        const helper = fileURLToPath(new URL('../../scripts/linux/rele-codex-signal.py', import.meta.url));
        const result = await this.run('/usr/bin/python3', ['-I', helper, '--signal', String(owner.pid), owner.startTicks, String(owner.uid), owner.executable, owner.sha256], owner.codexHome);
        requireValue(result.code === 0 && JSON.parse(result.stdout).status === 'signalSent', uncertain);
        pending.phase = 'draining'; await this.save(pending);
      }
      // A persisted intent is never a reason to send SIGHUP again, including after a lost helper ACK.
      const deadline = Date.now() + (this.options.timeoutMs ?? 60_000);
      for (;;) {
        const old = await this.process(owner.pid);
        if (!old || old.startTicks !== owner.startTicks) break;
        requireValue(Date.now() < deadline, 'Codex завершает работу. Повторите сверку позже; принудительное завершение не применяется.', 'linux-drain-pending');
        await (this.options.wait ?? delay)(250);
      }
      if (!pending.managedExecutable) {
        requireValue(!pending.selectionAttempted, uncertain, 'linux-selection-uncertain');
        pending.phase = 'start-intent'; pending.selectionAttempted = true; await this.save(pending);
        const result = await this.run(candidate.executable, ['app-server', 'daemon', 'update', '--from-cli', '--yes'], owner.codexHome);
        const selected = JSON.parse(result.stdout);
        requireValue(result.code === 0 && selected.status === 'updated' && selected.installedVersion === candidate.version && selected.runningVersion === null && typeof selected.managedCodexPath === 'string', uncertain);
        const executable = await realpath(selected.managedCodexPath);
        requireValue(executable.startsWith(path.join(owner.codexHome, 'packages', 'app-server-daemon', 'releases') + path.sep) && await digest(executable) === candidate.sha256 && await completeCodexPackage(executable) === candidate.version, uncertain);
        pending.managedExecutable = selected.managedCodexPath; pending.resolvedManagedExecutable = executable; await this.save(pending);
      }
      requireValue(pending.managedExecutable && await realpath(pending.managedExecutable) === pending.resolvedManagedExecutable && await digest(pending.managedExecutable) === candidate.sha256, 'Штатный выбор пакета Codex изменился; запуск остановлен.');
      const externalStarter = this.env(owner.codexHome).RELE_CODEX_DAEMON_EXTERNAL === '1';
      if (pending.startAttempted) return externalStarter ? await this.waitForStarter(pending) : await this.complete(pending);
      pending.startAttempted = true; await this.save(pending);
      if (externalStarter) return await this.waitForStarter(pending);
      const started = await this.run(candidate.executable, ['app-server', 'daemon', 'start'], owner.codexHome);
      const receipt = JSON.parse(started.stdout);
      requireValue(started.code === 0 && ['started', 'alreadyRunning'].includes(receipt.status) && receipt.socketPath === owner.endpoint && receipt.managedCodexVersion === candidate.version && receipt.appServerVersion === candidate.version && await realpath(receipt.managedCodexPath) === pending.resolvedManagedExecutable, uncertain);
      return await this.complete(pending);
    } catch (error) {
      if (pending && pending.phase !== 'ready' && pending.phase !== 'verified') { pending.phase = 'uncertain'; pending.errorCode = error instanceof LinuxCodexUpdateError ? error.code : 'linux-command-unconfirmed'; await this.save(pending).catch(() => {}); }
      throw error instanceof LinuxCodexUpdateError ? error : new LinuxCodexUpdateError(uncertain, 502);
    } finally { this.busy = false; }
  }
}

const commandRunner = command;
