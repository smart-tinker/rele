import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CodexConnectionState, CodexConnectionTarget, CodexDiscoveryResult, CodexInstallation, CodexUpdateState } from '../shared/types.js';
import { SUPPORTED_CODEX_VERSIONS } from '../shared/codex-runtime.js';
import { discoverCodex } from './codex-discovery.js';
import { codexEnvironment } from './codex-launch.js';
import { effectiveSharedCodexHome, isSharedCodexWebSocket } from './codex-shared.js';

const execute = promisify(execFile);
const failure = 'Не удалось подтвердить подготовку обновления Codex. Работающий сервер и его задачи не изменялись.';
const applyFailure = 'Обновление не подтверждено. Проверьте состояние Codex; очередь сохранена.';
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
type CommandResult = { stdout: string; code: number | null };
type Installation = { DataDirectory: string; OwnerSid: string; TaskName: string; CodexHome?: string };
type NativeStatus = Record<string, unknown>;
export interface CodexUpdateOptions {
  platform?: NodeJS.Platform;
  discover?: typeof discoverCodex;
  run?: (command: string, args: string[]) => Promise<CommandResult>;
}
export class CodexUpdateError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); this.name = 'CodexUpdateError'; }
}
async function runLauncher(command: string, args: string[]): Promise<CommandResult> {
  const { stdout } = await execute(command, args, { windowsHide: true, timeout: args[0] === 'codex-apply-update' ? 60_000 : 30_000, maxBuffer: 16 * 1024 });
  return { stdout, code: 0 };
}
async function executableDigest(executable: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  return hash.digest('hex');
}
function samePath(left: string, right: string): boolean { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
function compareVersions(left: string, right: string): number {
  const a = versionPattern.exec(left)!, b = versionPattern.exec(right)!;
  for (let index = 1; index <= 3; index++) if (Number(a[index]) !== Number(b[index])) return Number(a[index]) - Number(b[index]);
  if (a[4] === b[4]) return 0;
  if (!a[4] || !b[4]) return a[4] ? -1 : 1;
  const x = a[4].split('.'), y = b[4].split('.');
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    if (x[index] === y[index]) continue;
    if (x[index] === undefined || y[index] === undefined) return x[index] === undefined ? -1 : 1;
    const numericX = /^\d+$/u.test(x[index]), numericY = /^\d+$/u.test(y[index]);
    if (numericX && numericY) return Number(x[index]) - Number(y[index]);
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x[index] < y[index] ? -1 : 1;
  }
  return 0;
}
function nativeResult(result: CommandResult, message = failure): NativeStatus {
  if (result.code !== 0 || Buffer.byteLength(result.stdout, 'utf8') > 16 * 1024) throw new CodexUpdateError(message, 502);
  const value: unknown = JSON.parse(result.stdout);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CodexUpdateError(message, 502);
  return value as NativeStatus;
}

/** Preparation preserves the live server; applying requires native's exclusive idle gate. */
export class CodexUpdate {
  private operation?: 'preparing' | 'applying';
  private last: CodexUpdateState = { available: false, phase: 'current' };
  private lastError?: string;
  constructor(
    private readonly root: string,
    private readonly dataDirectory: string,
    private readonly target: () => CodexConnectionTarget,
    private readonly current: () => CodexConnectionState,
    private readonly options: CodexUpdateOptions = {},
  ) {}

  private identity(): string {
    const current = this.current();
    return JSON.stringify([this.target(), current.connected, current.name, current.transport, current.endpoint, current.executable, current.codexHome]);
  }
  private assertIdentity(expected: string): void {
    if (this.identity() !== expected) throw new CodexUpdateError('Подключение Codex изменилось. Обновите состояние перед подготовкой обновления.', 409);
  }
  private async installation(): Promise<Installation | undefined> {
    if ((this.options.platform ?? process.platform) !== 'win32') return;
    const target = this.target();
    if (target.transport !== 'shared' || target.executable !== 'codex' || target.endpoint) return;
    try {
      const file = path.join(this.root, 'rele-install.json');
      if ((await stat(file)).size > 64 * 1024 || !(await stat(path.join(this.root, 'Rele.exe'))).isFile()) return;
      const marker = JSON.parse(await readFile(file, 'utf8')) as Installation;
      if (typeof marker.DataDirectory !== 'string' || typeof marker.OwnerSid !== 'string' || !/^S-1-\d+(?:-\d+)+$/u.test(marker.OwnerSid)
        || typeof marker.TaskName !== 'string' || !/^Rele-[A-Za-z0-9._-]{1,120}$/u.test(marker.TaskName)
        || marker.CodexHome != null && typeof marker.CodexHome !== 'string'
        || !samePath(await realpath(marker.DataDirectory), await realpath(this.dataDirectory))) return;
      return marker;
    } catch { return; }
  }
  private async checkedInstallation(expected: Installation): Promise<Installation> {
    const marker = await this.installation();
    if (!marker || marker.OwnerSid !== expected.OwnerSid || marker.TaskName !== expected.TaskName
      || marker.CodexHome !== expected.CodexHome) throw new CodexUpdateError('Установка Rele изменилась. Обновите состояние Codex.', 409);
    return marker;
  }
  private async inspect() {
    const identity = this.identity(), marker = await this.installation();
    const current = this.current();
    const currentVersion = current.name?.match(/^Codex (\S+)$/u)?.[1];
    const state: CodexUpdateState = { available: !!marker, phase: 'current', ...(currentVersion && versionPattern.test(currentVersion) ? { currentVersion } : {}) };
    if (!marker) return { state, identity };
    const home = await realpath(current.codexHome || effectiveSharedCodexHome(codexEnvironment(this.target().codexHome)));
    if (marker.CodexHome && !samePath(await realpath(marker.CodexHome), home)
      || this.target().codexHome && !samePath(await realpath(this.target().codexHome!), home)) throw new CodexUpdateError('Обновление требует исходный профиль работающего общего Codex.', 409);
    const discovery: CodexDiscoveryResult = await (this.options.discover ?? discoverCodex)({ codexHome: home });
    this.assertIdentity(identity);
    const installed = discovery.installations.filter((item): item is CodexInstallation & { version: string } =>
      item.source === 'desktop-install' && !!item.version && versionPattern.test(item.version));
    installed.sort((left, right) => compareVersions(right.version, left.version));
    const candidate = installed[0];
    if (candidate) state.installedVersion = candidate.version;
    const native = nativeResult(await (this.options.run ?? runLauncher)(path.join(this.root, 'Rele.exe'), ['codex-status', '--quiet', '--codex-home', home]));
    this.assertIdentity(identity);
    if (!['alreadyRunning', 'notRunning'].includes(String(native.status))) throw new CodexUpdateError(failure, 502);
    if (native.status === 'alreadyRunning') {
      if (native.ownerSid !== marker.OwnerSid || native.taskName !== `${marker.TaskName}-Codex`
        || typeof native.codexHome !== 'string' || !samePath(await realpath(native.codexHome), home)
        || typeof native.endpoint !== 'string' || !isSharedCodexWebSocket(native.endpoint)
        || typeof native.executable !== 'string' || !path.isAbsolute(native.executable)
        || typeof native.executableSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(native.executableSha256)
        || !Number.isSafeInteger(native.processId) || Number(native.processId) <= 0
        || typeof native.processStartTime !== 'string' || !Number.isFinite(Date.parse(native.processStartTime))) throw new CodexUpdateError(failure, 502);
      if (current.connected && (current.endpoint && current.endpoint !== native.endpoint
        || current.executable && !samePath(current.executable, native.executable))) throw new CodexUpdateError('Работающий Codex изменился. Обновите состояние перед подготовкой обновления.', 409);
      const version = discovery.installations.find(item => samePath(item.executable, native.executable as string) && item.version && versionPattern.test(item.version))?.version;
      if (version && !current.connected) state.currentVersion = version;
    }
    if (native.pendingUpdate === true) {
      const pendingExecutable = native.status === 'notRunning' ? native.pendingExe : native.successorExe;
      const pendingHash = native.status === 'notRunning' ? native.pendingSha256 : native.successorSha256;
      if (native.ownerSid !== marker.OwnerSid || native.taskName !== `${marker.TaskName}-Codex`
        || typeof native.codexHome !== 'string' || !samePath(await realpath(native.codexHome), home)
        || typeof native.endpoint !== 'string' || !isSharedCodexWebSocket(native.endpoint)
        || typeof pendingExecutable !== 'string' || !path.isAbsolute(pendingExecutable)
        || typeof pendingHash !== 'string' || !/^[a-f0-9]{64}$/u.test(pendingHash)
        || typeof native.successorDirectory !== 'string' || !/^[a-f0-9]{64}$/u.test(path.basename(native.successorDirectory))
        || !samePath(path.dirname(native.successorDirectory), path.join(await realpath(this.dataDirectory), 'codex-websocket-owners'))) throw new CodexUpdateError(failure, 502);
      const pending = discovery.installations.find(item => samePath(item.executable, pendingExecutable) && item.version && versionPattern.test(item.version));
      if (pending?.version) state.pendingVersion = pending.version;
      state.phase = 'ready';
    } else if (candidate && state.currentVersion && compareVersions(candidate.version, state.currentVersion) > 0) {
      state.phase = SUPPORTED_CODEX_VERSIONS.includes(candidate.version) ? 'available' : 'unsupported';
    }
    if (candidate && installed.some(item => item.executable.toLowerCase() !== candidate.executable.toLowerCase() && compareVersions(item.version, candidate.version) === 0)) {
      throw new CodexUpdateError('Найдено несколько установок Desktop одной версии. Автоматический выбор обновления остановлен.');
    }
    return { state, identity, marker, candidate, home, native };
  }

  async status(): Promise<CodexUpdateState> {
    if (this.operation) return { ...this.last, phase: this.operation };
    try {
      const { state } = await this.inspect();
      if (this.operation) return { ...state, phase: this.operation };
      this.last = this.lastError && ['available', 'ready'].includes(state.phase)
        ? { ...state, phase: state.phase === 'ready' ? 'ready' : 'failed', error: this.lastError } : state;
    } catch { this.last = { ...this.last, phase: 'failed', error: this.lastError ?? failure }; }
    return { ...this.last };
  }

  async prepare(): Promise<CodexUpdateState> {
    if (this.operation) throw new CodexUpdateError('Обновление Codex уже выполняется.', 409);
    this.operation = 'preparing';
    this.lastError = undefined;
    try {
      const before = await this.inspect();
      this.last = before.state;
      if (before.state.phase === 'ready') return { ...before.state };
      if (!before.marker || !before.home || !before.candidate || !path.isAbsolute(before.candidate.executable)
        || !this.current().connected || !this.current().codexHome || before.native?.status !== 'alreadyRunning' || before.state.phase !== 'available') {
        throw new CodexUpdateError(before.state.phase === 'unsupported'
          ? 'Установленная версия Codex пока не проверена для Rele. Работающий сервер сохранён.'
          : 'Подготовка обновления доступна для работающего общего Codex и более новой проверенной установки Desktop.');
      }
      const digest = await executableDigest(before.candidate.executable);
      const version = await (this.options.run ?? runLauncher)(before.candidate.executable, ['--version']);
      if (version.code !== 0 || Buffer.byteLength(version.stdout, 'utf8') > 16 * 1024) throw new CodexUpdateError(failure, 502);
      if (version.stdout.match(/^(?:codex-cli|codex) (\S+)\s*$/u)?.[1] !== before.candidate.version
        || await executableDigest(before.candidate.executable) !== digest) {
        throw new CodexUpdateError('Установка Codex изменилась во время проверки. Обновите состояние перед подготовкой обновления.', 409);
      }
      const marker = await this.checkedInstallation(before.marker);
      this.assertIdentity(before.identity);
      const native = nativeResult(await (this.options.run ?? runLauncher)(path.join(this.root, 'Rele.exe'), ['codex-update', '--quiet', '--codex-executable', before.candidate.executable, '--expected-sha256', digest, '--codex-home', before.home]));
      if (native.status !== 'updatePrepared' || native.pendingUpdate !== true
        || native.ownerSid !== marker.OwnerSid || native.taskName !== `${marker.TaskName}-Codex`
        || typeof native.codexHome !== 'string' || !samePath(await realpath(native.codexHome), before.home)
        || typeof native.endpoint !== 'string' || !isSharedCodexWebSocket(native.endpoint)
        || typeof native.successorExe !== 'string' || !samePath(native.successorExe, before.candidate.executable)
        || native.successorSha256 !== digest
        || typeof native.successorDirectory !== 'string' || !/^[a-f0-9]{64}$/u.test(path.basename(native.successorDirectory))
        || !samePath(path.dirname(native.successorDirectory), path.join(await realpath(this.dataDirectory), 'codex-websocket-owners'))) throw new CodexUpdateError(failure, 502);
      this.last = { ...before.state, phase: 'ready', pendingVersion: before.candidate.version };
      return { ...this.last };
    } catch (error) {
      const safe = error instanceof CodexUpdateError ? error : new CodexUpdateError(failure, 502);
      this.lastError = safe.message;
      this.last = { ...this.last, phase: 'failed', error: safe.message };
      throw safe;
    } finally { this.operation = undefined; }
  }

  /** The caller pauses Engine and closes Rele's client before invoking native's idle gate. */
  async apply(): Promise<CodexUpdateState> {
    if (this.operation) throw new CodexUpdateError('Обновление Codex уже выполняется.', 409);
    this.operation = 'applying';
    this.lastError = undefined;
    try {
      const before = await this.inspect();
      this.last = before.state;
      if (!before.marker || !before.home || before.state.phase !== 'ready' || !before.state.pendingVersion
        || !SUPPORTED_CODEX_VERSIONS.includes(before.state.pendingVersion) || before.native?.pendingUpdate !== true) {
        throw new CodexUpdateError('Сначала подготовьте проверенное обновление общего Codex.');
      }
      const pendingExe = before.native.status === 'notRunning' ? before.native.pendingExe : before.native.successorExe;
      const pendingHash = before.native.status === 'notRunning' ? before.native.pendingSha256 : before.native.successorSha256;
      if (typeof pendingExe !== 'string' || await executableDigest(pendingExe) !== pendingHash) {
        throw new CodexUpdateError('Подготовленный файл Codex изменился. Обновление остановлено; проверьте установку Desktop.', 409);
      }
      const marker = await this.checkedInstallation(before.marker);
      this.assertIdentity(before.identity);
      const native = nativeResult(await (this.options.run ?? runLauncher)(path.join(this.root, 'Rele.exe'),
        ['codex-apply-update', '--quiet', '--codex-home', before.home]), applyFailure);
      if (!['started', 'alreadyRunning'].includes(String(native.status)) || native.pendingUpdate === true
        || native.ownerSid !== marker.OwnerSid || native.taskName !== `${marker.TaskName}-Codex`
        || typeof native.codexHome !== 'string' || !samePath(await realpath(native.codexHome), before.home)
        || native.endpoint !== before.native.endpoint
        || typeof native.executable !== 'string' || typeof pendingExe !== 'string' || !samePath(native.executable, pendingExe)
        || native.executableSha256 !== pendingHash
        || typeof native.ownerDirectory !== 'string' || typeof before.native.successorDirectory !== 'string'
        || !samePath(native.ownerDirectory, before.native.successorDirectory)
        || !Number.isSafeInteger(native.processId) || Number(native.processId) <= 0
        || typeof native.processStartTime !== 'string' || !Number.isFinite(Date.parse(native.processStartTime))) throw new CodexUpdateError(applyFailure, 502);
      this.last = { available: true, phase: 'current', currentVersion: before.state.pendingVersion,
        ...(before.state.installedVersion ? { installedVersion: before.state.installedVersion } : {}) };
      return { ...this.last };
    } catch (error) {
      const safe = error instanceof CodexUpdateError ? error : new CodexUpdateError(applyFailure, 502);
      this.lastError = safe.message;
      this.last = { ...this.last, phase: 'failed', error: safe.message };
      throw safe;
    } finally { this.operation = undefined; }
  }
}
