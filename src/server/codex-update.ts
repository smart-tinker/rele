import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CodexConnectionState, CodexConnectionTarget, CodexDiscoveryResult, CodexInstallation, CodexUpdateState } from '../shared/types.js';
import { compareCodexVersions, SUPPORTED_CODEX_VERSIONS } from '../shared/codex-runtime.js';
import { compareCodexInstallations, discoverCodex } from './codex-discovery.js';
import { codexEnvironment, resolveCodexLaunch } from './codex-launch.js';
import { effectiveSharedCodexHome, isSharedCodexWebSocket, nativeCodexExecutable } from './codex-shared.js';

const execute = promisify(execFile);
const failure = 'Не удалось подтвердить подготовку обновления Codex. Работающий сервер и его задачи не изменялись.';
const applyFailure = 'Обновление не подтверждено. Проверьте состояние Codex; очередь сохранена.';
const pendingMismatch = 'Подготовлен другой файл Codex. Верните прежний выбор перед применением обновления.';
const downgrade = 'Понижение версии для существующего профиля Codex не поддерживается. Работающий сервер сохранён.';
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
type CommandResult = { stdout: string; code: number | null };
type Installation = { DataDirectory: string; OwnerSid: string; TaskName: string; CodexHome?: string };
type NativeStatus = Record<string, unknown>;
export interface CodexUpdateOptions {
  platform?: NodeJS.Platform;
  discover?: typeof discoverCodex;
  run?: (command: string, args: string[]) => Promise<CommandResult>;
  resolveNative?: (executable: string, codexHome: string) => Promise<string>;
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
function nativeResult(result: CommandResult, message = failure): NativeStatus {
  if (result.code !== 0 || Buffer.byteLength(result.stdout, 'utf8') > 16 * 1024) throw new CodexUpdateError(message, 502);
  const value: unknown = JSON.parse(result.stdout);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CodexUpdateError(message, 502);
  return value as NativeStatus;
}

/** Preparation preserves the live server; applying requires native's exclusive idle gate. */
export class CodexUpdate {
  private operation?: 'preparing' | 'applying';
  private selectionChanging = false;
  private last: CodexUpdateState = { available: false, phase: 'current' };
  private lastError?: string;
  private lastSelection?: string;
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
  private resetSelectionState(): void {
    const selection = JSON.stringify(this.target());
    if (selection === this.lastSelection) return;
    this.lastSelection = selection;
    this.lastError = undefined;
    this.last = { available: false, phase: 'current', selectionMode: this.target().executable === 'codex' ? 'auto' : 'manual' };
  }
  private async normalizeExecutable(executable: string, home: string): Promise<string> {
    if (this.options.resolveNative) return this.options.resolveNative(executable, home);
    const platform = this.options.platform ?? process.platform;
    const launch = await resolveCodexLaunch(executable, { platform, env: codexEnvironment(home) });
    const native = await nativeCodexExecutable(launch.executable, platform);
    if (!path.isAbsolute(native) || !(await stat(native)).isFile() || platform === 'win32' && !/\.exe$/iu.test(native)) throw new Error('Invalid native executable.');
    return native;
  }
  private async installation(): Promise<Installation | undefined> {
    if ((this.options.platform ?? process.platform) !== 'win32') return;
    const target = this.target();
    if (target.transport !== 'shared' || target.endpoint || (target as CodexConnectionTarget & { token?: string }).token) return;
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
    const selectionMode = this.target().executable === 'codex' ? 'auto' : 'manual';
    const state: CodexUpdateState = { available: !!marker, phase: 'current', selectionMode,
      ...(currentVersion && versionPattern.test(currentVersion) ? { currentVersion } : {}) };
    if (!marker) return { state, identity };
    const home = await realpath(current.codexHome || effectiveSharedCodexHome(codexEnvironment(this.target().codexHome)));
    if (marker.CodexHome && !samePath(await realpath(marker.CodexHome), home)
      || this.target().codexHome && !samePath(await realpath(this.target().codexHome!), home)) throw new CodexUpdateError('Обновление требует исходный профиль работающего общего Codex.', 409);
    const discovery: CodexDiscoveryResult = await (this.options.discover ?? discoverCodex)({ codexHome: home });
    this.assertIdentity(identity);
    const installed = discovery.installations.filter((item): item is CodexInstallation & { version: string } => !!item.version && versionPattern.test(item.version))
      .sort((a, b) => compareCodexInstallations(a, b, 'win32'));
    const desktop = installed.find(item => item.source === 'desktop-install');
    if (desktop) state.installedVersion = desktop.version;
    const resolutions = new Map<string, Promise<string | undefined>>();
    const resolve = (executable: string) => {
      if (!resolutions.has(executable)) resolutions.set(executable, this.normalizeExecutable(executable, home).catch(() => undefined));
      return resolutions.get(executable)!;
    };
    const normalized = (await Promise.all(installed.map(async item => {
      const executable = await resolve(item.executable);
      return executable ? { ...item, executable } : undefined;
    }))).filter((item): item is CodexInstallation & { version: string } => !!item);
    let candidate: (CodexInstallation & { version: string }) | undefined;
    if (selectionMode === 'auto') {
      candidate = normalized.find(item => SUPPORTED_CODEX_VERSIONS.includes(item.version));
    } else {
      const executable = await resolve(this.target().executable);
      if (executable) {
        let version = normalized.find(item => samePath(item.executable, executable))?.version;
        if (!version) {
          const result = await (this.options.run ?? runLauncher)(executable, ['--version']);
          if (result.code === 0 && Buffer.byteLength(result.stdout, 'utf8') <= 16 * 1024) version = result.stdout.match(/^(?:codex-cli|codex) (\S+)\s*$/u)?.[1];
        }
        if (version && versionPattern.test(version)) candidate = { executable, version, name: 'Selected Codex', source: 'path', running: false };
      }
    }
    this.assertIdentity(identity);
    if (candidate) state.selectedVersion = candidate.version;
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
      const version = normalized.find(item => samePath(item.executable, native.executable as string))?.version;
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
      const pending = normalized.find(item => samePath(item.executable, pendingExecutable));
      if (pending?.version) state.pendingVersion = pending.version;
      else if (candidate && samePath(candidate.executable, pendingExecutable)) state.pendingVersion = candidate.version;
      else {
        if (await executableDigest(pendingExecutable) !== pendingHash) throw new CodexUpdateError('Подготовленный файл Codex изменился. Применение остановлено.', 409);
        const version = await (this.options.run ?? runLauncher)(pendingExecutable, ['--version']);
        if (await executableDigest(pendingExecutable) !== pendingHash) throw new CodexUpdateError('Подготовленный файл Codex изменился во время проверки.', 409);
        const value = version.code === 0 && Buffer.byteLength(version.stdout, 'utf8') <= 16 * 1024 ? version.stdout.match(/^(?:codex-cli|codex) (\S+)\s*$/u)?.[1] : undefined;
        if (value && versionPattern.test(value)) state.pendingVersion = value;
      }
      state.phase = 'ready';
      if (!state.pendingVersion || !SUPPORTED_CODEX_VERSIONS.includes(state.pendingVersion)) state.error = 'Подготовленная версия Codex не подтверждена как поддерживаемая.';
      else if (selectionMode === 'manual' && (!candidate || !samePath(candidate.executable, pendingExecutable) || candidate.version !== state.pendingVersion)) state.error = pendingMismatch;
    } else if (!candidate || !SUPPORTED_CODEX_VERSIONS.includes(candidate.version)) {
      state.phase = 'unsupported';
      state.error = 'Выбранный файл Codex не подтверждён как поддерживаемая версия Rele.';
    } else if (state.currentVersion) {
      const comparison = compareCodexVersions(candidate.version, state.currentVersion);
      if (comparison < 0) { state.phase = 'unsupported'; state.error = downgrade; }
      else if (comparison > 0 || selectionMode === 'manual' && typeof native.executable === 'string' && !samePath(candidate.executable, native.executable)) state.phase = 'available';
    }
    this.assertIdentity(identity);
    return { state, identity, marker, candidate, home, native };
  }

  async status(): Promise<CodexUpdateState> {
    this.resetSelectionState();
    if (this.operation) return { ...this.last, phase: this.operation };
    try {
      const { state } = await this.inspect();
      if (this.operation) return { ...state, phase: this.operation };
      this.last = this.lastError && !state.error && ['available', 'ready'].includes(state.phase)
        ? { ...state, phase: state.phase === 'ready' ? 'ready' : 'failed', error: this.lastError } : state;
    } catch { this.resetSelectionState(); this.last = { ...this.last, phase: 'failed', error: this.lastError ?? failure }; }
    return { ...this.last };
  }

  async prepare(): Promise<CodexUpdateState> {
    if (this.operation || this.selectionChanging) throw new CodexUpdateError('Обновление Codex уже выполняется.', 409);
    this.resetSelectionState();
    const selection = this.lastSelection;
    this.operation = 'preparing';
    this.lastError = undefined;
    try {
      const before = await this.inspect();
      this.last = before.state;
      if (before.state.phase === 'ready') {
        if (before.state.error) throw new CodexUpdateError(before.state.error, 409);
        return { ...before.state };
      }
      if (!before.marker || !before.home || !before.candidate || !path.isAbsolute(before.candidate.executable)
        || !this.current().connected || !this.current().codexHome || before.native?.status !== 'alreadyRunning' || before.state.phase !== 'available') {
        throw new CodexUpdateError(before.state.error ?? 'Подготовка обновления доступна для работающего общего Codex и выбранной поддерживаемой установки.');
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
      this.resetSelectionState();
      const safe = error instanceof CodexUpdateError ? error : new CodexUpdateError(failure, 502);
      if (this.lastSelection === selection) {
        this.lastError = safe.message;
        this.last = { ...this.last, phase: 'failed', error: safe.message };
      }
      throw safe;
    } finally { this.operation = undefined; }
  }

  /** The caller pauses Engine and closes Rele's client before invoking native's idle gate. */
  async apply(): Promise<CodexUpdateState> {
    if (this.operation || this.selectionChanging) throw new CodexUpdateError('Обновление Codex уже выполняется.', 409);
    this.resetSelectionState();
    const selection = this.lastSelection;
    this.operation = 'applying';
    this.lastError = undefined;
    try {
      const before = await this.inspect();
      this.last = before.state;
      if (before.state.phase === 'ready' && before.state.error) throw new CodexUpdateError(before.state.error, 409);
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
      this.last = { available: true, phase: 'current', selectionMode: before.state.selectionMode, selectedVersion: before.state.selectedVersion, currentVersion: before.state.pendingVersion,
        ...(before.state.installedVersion ? { installedVersion: before.state.installedVersion } : {}) };
      return { ...this.last };
    } catch (error) {
      this.resetSelectionState();
      const safe = error instanceof CodexUpdateError ? error : new CodexUpdateError(applyFailure, 502);
      if (this.lastSelection === selection) {
        this.lastError = safe.message;
        this.last = { ...this.last, phase: 'failed', error: safe.message };
      }
      throw safe;
    } finally { this.operation = undefined; }
  }

  /** Change selection policy without reconnecting a verified server; applying remains a separate operation. */
  async canChangeSelection(next: CodexConnectionTarget & { token?: string }): Promise<boolean> {
    if ((this.options.platform ?? process.platform) !== 'win32') return false;
    const currentTarget = this.target() as CodexConnectionTarget & { token?: string };
    if (currentTarget.transport !== 'shared' || next.transport !== 'shared' || currentTarget.endpoint || next.endpoint
      || currentTarget.token || next.token || typeof next.executable !== 'string' || !next.executable || currentTarget.executable === next.executable) return false;
    const fields = new Set([...Object.keys(currentTarget), ...Object.keys(next)]);
    for (const field of fields) if (field !== 'executable' && JSON.stringify(currentTarget[field as keyof typeof currentTarget]) !== JSON.stringify(next[field as keyof typeof next])) return false;
    if (this.operation) throw new CodexUpdateError('Обновление Codex уже выполняется.', 409);
    const before = await this.inspect(), current = this.current();
    if (before.native?.pendingUpdate === true) throw new CodexUpdateError('Сначала завершите подготовленное обновление Codex; выбор пока изменить нельзя.', 409);
    if (!before.marker || !before.home || before.native?.status !== 'alreadyRunning' || !current.connected || current.transport !== 'shared'
      || !current.codexHome || !samePath(await realpath(current.codexHome), before.home) || current.endpoint !== before.native.endpoint
      || !current.executable || typeof before.native.executable !== 'string' || !samePath(current.executable, before.native.executable)) return false;
    this.assertIdentity(before.identity);
    if (this.operation) throw new CodexUpdateError('Обновление Codex уже выполняется.', 409);
    return true;
  }

  async changeSelection(next: CodexConnectionTarget & { token?: string }, save: () => Promise<void>): Promise<boolean> {
    if (this.selectionChanging) throw new CodexUpdateError('Выбор Codex уже сохраняется.', 409);
    this.selectionChanging = true;
    try {
      if (!await this.canChangeSelection(next)) return false;
      await save();
      this.resetSelectionState();
      return true;
    } finally { this.selectionChanging = false; }
  }
}
