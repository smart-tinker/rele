import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CodexConnectionTarget, CodexDiscoveryResult } from '../shared/types.js';
import { SUPPORTED_CODEX_VERSIONS } from '../shared/codex-runtime.js';
import { isLocalCodexHome, isLocalSocketPath } from './config.js';
import { discoverCodex } from './codex-discovery.js';
import { codexEnvironment, environmentValue, resolveCodexLaunch } from './codex-launch.js';

export class SharedCodexError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'SharedCodexError'; }
}

interface CommandResult { stdout: string; code: number | null }
export interface SharedCodexOptions {
  env?: NodeJS.ProcessEnv;
  discover?: typeof discoverCodex;
  run?: (command: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<CommandResult>;
  timeoutMs?: number;
}

/** Bound only the native control command; its daemon has an independent lifetime. */
async function runSharedCommand(command: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '', settled = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve({ stdout, code });
    };
    const fail = () => {
      child.kill();
      child.stdout.destroy();
      finish(new SharedCodexError('Штатный daemon Codex не подтвердил готовность. Rele повторит подключение без повторной отправки задач.', 'shared-daemon-unavailable'));
    };
    const timer = setTimeout(fail, timeoutMs);
    timer.unref();
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 128 * 1024) fail();
    });
    child.once('error', () => finish(new SharedCodexError('Не удалось запустить выбранный Codex CLI.', 'shared-cli-unavailable')));
    child.once('close', code => finish(undefined, code));
  });
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function canonicalDirectory(directory: string): Promise<string> {
  try { return await realpath(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(directory); throw error; }
}

function sharedHome(env: NodeJS.ProcessEnv): string {
  const home = (process.platform === 'win32' ? environmentValue(env, 'CODEX_HOME') : env.CODEX_HOME) || path.join(homedir(), '.codex');
  if (!isLocalCodexHome(home)) throw new SharedCodexError('Общему Codex нужен абсолютный локальный профиль.', 'invalid-shared-profile');
  return home;
}

/** Fingerprints must keep the same profile identity before its native directories exist. */
export function effectiveSharedCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  let directory = sharedHome(env);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(realpathSync.native(directory), ...missing.reverse()); }
    catch (error) {
      const parent = path.dirname(directory);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === directory) throw error;
      missing.push(path.basename(directory));
      directory = parent;
    }
  }
}

/** Match the pinned native daemon's local package preflight; native code verifies copied contents. */
async function completeCodexPackage(executable: string): Promise<boolean> {
  try {
    const architecture = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : '';
    const suffix = process.platform === 'win32' ? 'pc-windows-msvc' : process.platform === 'linux' ? 'unknown-linux-musl' : '';
    if (!architecture || !suffix) return false;
    const target = `${architecture}-${suffix}`, binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
    let native = await realpath(executable);
    if (/\.[cm]?js$/iu.test(native)) {
      const root = path.dirname(path.dirname(native));
      if ((JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { name?: unknown }).name !== '@openai/codex') return false;
      let vendor: string;
      try { vendor = path.join(path.dirname(createRequire(native).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`)), 'vendor'); }
      catch { vendor = path.join(root, 'vendor'); }
      native = await realpath(path.join(vendor, target, 'bin', binary));
    }
    const directory = path.dirname(native);
    const packaged = ['bin', 'codex-resources'].includes(path.basename(directory));
    const root = packaged ? path.dirname(directory) : directory;
    const metadata = JSON.parse(await readFile(path.join(root, 'codex-package.json'), 'utf8')) as { layoutVersion?: unknown; version?: unknown; target?: unknown; entrypoint?: unknown };
    const entrypoint = `bin/${binary}`;
    const winget = process.platform === 'win32' && metadata.layoutVersion === 1 && metadata.entrypoint === `codex-${target}.exe` && path.basename(native) === metadata.entrypoint;
    if (!packaged && !winget || typeof metadata.version !== 'string' || !SUPPORTED_CODEX_VERSIONS.includes(metadata.version)
      || metadata.target !== target || metadata.entrypoint !== entrypoint && !winget) return false;
    const sourceEntrypoint = String(metadata.entrypoint);
    const files = ['codex-package.json', sourceEntrypoint, path.posix.join(path.posix.dirname(sourceEntrypoint), process.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'),
      process.platform === 'win32' ? 'codex-path/rg.exe' : 'codex-path/rg',
      ...(process.platform === 'win32' ? ['codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe'] : ['codex-resources/bwrap'])];
    const present = await Promise.all(files.map(async file => {
      const info = await stat(path.join(root, file));
      return info.isFile() && (process.platform === 'win32' || file === 'codex-package.json' || !!(info.mode & 0o111));
    }));
    return present.every(Boolean);
  } catch { return false; }
}

/** Resolve only installed files and version metadata; this never starts the daemon. */
export async function resolveSharedCodexExecutable(target: CodexConnectionTarget, options: SharedCodexOptions = {}): Promise<string> {
  const env = codexEnvironment(target.codexHome, options.env ?? process.env);
  const home = await canonicalDirectory(sharedHome(env));
  const expectedSocket = path.join(home, 'app-server-control', 'app-server-control.sock');
  const run = options.run ?? runSharedCommand;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let executable = target.executable;
  if (executable === 'codex') {
    const native = path.join(home, 'packages', 'app-server-daemon', 'current', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    const installed = await stat(native).then(info => info.isFile(), error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new SharedCodexError('Нет доступа к установленному общему Codex.', 'shared-cli-unavailable');
    });
    if (installed) executable = native;
    else {
      const found = await (options.discover ?? discoverCodex)({ env, ...(target.codexHome ? { codexHome: target.codexHome } : {}) });
      executable = found.installations.find(item => item.running && item.version && SUPPORTED_CODEX_VERSIONS.includes(item.version) && item.connection?.transport === 'proxy' && item.connection.endpoint && samePath(path.resolve(item.connection.endpoint), expectedSocket))?.executable
        ?? found.recommendedManaged?.executable ?? '';
      if (!executable) throw new SharedCodexError(`Не найден проверенный Codex CLI. Нужен ${SUPPORTED_CODEX_VERSIONS.join(' или ')}.`, 'shared-cli-unavailable');
    }
  }
  const launch = await resolveCodexLaunch(executable, { env });
  const cli = await run(launch.command, [...launch.args, '--version'], Math.min(timeoutMs, 4_000), env);
  const version = cli.stdout.trim().match(/^codex(?:-cli)?\s+(\S+)(?:\s|$)/iu)?.[1];
  if (cli.code !== 0 || !version || !SUPPORTED_CODEX_VERSIONS.includes(version)) throw new SharedCodexError(`Для общего daemon нужен проверенный Codex ${SUPPORTED_CODEX_VERSIONS.join(' или ')}.`, 'shared-cli-unverified');
  return launch.executable;
}

/** Native daemon start is idempotent. Never replace a private Desktop backend implicitly. */
export async function ensureSharedCodex(target: CodexConnectionTarget, options: SharedCodexOptions = {}): Promise<CodexConnectionTarget> {
  if (target.transport !== 'shared' || target.endpoint) throw new SharedCodexError('Выберите общий Codex без ручного endpoint.', 'invalid-shared-target');
  const env = codexEnvironment(target.codexHome, options.env ?? process.env);
  const home = sharedHome(env), selectedHome = await canonicalDirectory(home);
  const expectedSocket = path.join(selectedHome, 'app-server-control', 'app-server-control.sock');
  const run = options.run ?? runSharedCommand;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let discovery: CodexDiscoveryResult | undefined;
  const discover = async () => discovery ??= await (options.discover ?? discoverCodex)({ env, ...(target.codexHome ? { codexHome: target.codexHome } : {}) });
  const executable = await resolveSharedCodexExecutable(target, { ...options, env, discover });
  let launch = await resolveCodexLaunch(executable, { env });
  const proxy = (nativeExecutable: string, endpoint: string, codexHome = selectedHome): CodexConnectionTarget => ({ ...target, transport: 'proxy', executable: nativeExecutable, endpoint, codexHome });
  const validate = async (result: CommandResult, statuses: string[]): Promise<CodexConnectionTarget> => {
    let output: { status?: unknown; socketPath?: unknown; managedCodexPath?: unknown; managedCodexVersion?: unknown };
    try { output = JSON.parse(result.stdout); }
    catch { throw new SharedCodexError('Штатный daemon Codex вернул неподтверждённый результат. Запуск другого сервера запрещён.', 'shared-daemon-invalid'); }
    if (!output || result.code !== 0 || !statuses.includes(String(output.status))
        || typeof output.socketPath !== 'string' || !isLocalSocketPath(output.socketPath) || !path.isAbsolute(output.socketPath)
        || typeof output.managedCodexPath !== 'string' || !isLocalCodexHome(output.managedCodexPath)
        || typeof output.managedCodexVersion !== 'string' || !SUPPORTED_CODEX_VERSIONS.includes(output.managedCodexVersion)) {
      throw new SharedCodexError('Штатный daemon Codex не подтвердил совместимый runtime и локальный сокет. Другой сервер не запускается.', 'shared-daemon-invalid');
    }
    const socket = path.join(await canonicalDirectory(path.dirname(output.socketPath)), path.basename(output.socketPath));
    // Resolve the home again: a fresh native start may have created it.
    const profile = await canonicalDirectory(home);
    const expected = path.join(profile, 'app-server-control', 'app-server-control.sock');
    if (!samePath(socket, expected)) throw new SharedCodexError('Daemon Codex относится к другому профилю. Выберите исходный профиль; история не переносится.', 'shared-profile-mismatch');
    return proxy(output.managedCodexPath, output.socketPath, profile);
  };

  // The sidecar starts outside rele.service's cgroup; clients wait without starting a second owner.
  if (env.RELE_CODEX_DAEMON_EXTERNAL === '1') {
    const deadline = Date.now() + timeoutMs;
    do {
      const current = await run(launch.command, [...launch.args, 'app-server', 'daemon', 'version'], Math.max(1, deadline - Date.now()), env);
      if (current.code === 0) return validate(current, ['running']);
      if (Date.now() >= deadline) break;
      await delay(Math.min(250, deadline - Date.now()));
    } while (Date.now() < deadline);
    throw new SharedCodexError('Общий daemon Codex пока недоступен. Проверьте rele-codex.timer и повторите подключение; сервер внутри службы Rele не запускался.', 'shared-daemon-unavailable');
  }

  const current = await run(launch.command, [...launch.args, 'app-server', 'daemon', 'version'], timeoutMs, env);
  if (current.code === 0) return validate(current, ['running']);
  const socketPresent = await stat(expectedSocket).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new SharedCodexError('Нет доступа к сокету общего Codex.', 'shared-daemon-unavailable');
  });
  const found = await discover();
  if (!socketPresent && found.issues.some(issue => ['windows-discovery-unavailable', 'process-discovery-unavailable', 'process-owner-unavailable'].includes(issue.code))) {
    throw new SharedCodexError('Не удалось проверить существующий сервер Desktop. Проверьте доступ Rele к процессам текущего пользователя; новый сервер не запущен.', 'shared-owner-unknown');
  }
  if (!socketPresent && found.installations.some(item => item.running)) throw new SharedCodexError('Codex Desktop уже использует отдельный сервер. Один раз полностью закройте Desktop и запустите его через Rele.Codex; затем повторите подключение. Rele не завершает чужие процессы.', 'shared-desktop-conflict');
  if (!await completeCodexPackage(launch.executable)) {
    let selected: string | undefined;
    if (target.executable === 'codex') {
      const candidates = found.installations.filter(item => item.version && SUPPORTED_CODEX_VERSIONS.includes(item.version))
        .sort((a, b) => SUPPORTED_CODEX_VERSIONS.indexOf(a.version!) - SUPPORTED_CODEX_VERSIONS.indexOf(b.version!));
      for (const candidate of new Set([found.recommendedManaged?.executable, ...candidates.map(item => item.executable)])) {
        if (candidate && await completeCodexPackage(candidate)) { selected = candidate; break; }
      }
    }
    if (!selected) throw new SharedCodexError(`Для запуска общего Codex нужен полный пакет CLI ${SUPPORTED_CODEX_VERSIONS.join(' или ')}. Установите официальный npm-пакет @openai/codex или standalone CLI; отдельного codex.exe из Desktop недостаточно.`, 'shared-package-incomplete');
    launch = await resolveCodexLaunch(await resolveSharedCodexExecutable({ ...target, executable: selected }, { ...options, env }), { env });
  }
  // Native singleton locks and liveness checks own stale-socket recovery.
  const started = await run(launch.command, [...launch.args, 'app-server', 'daemon', 'start'], timeoutMs, env);
  if (started.code !== 0) throw new SharedCodexError('Не удалось запустить штатный общий daemon Codex. Проверьте выбранный CLI и профиль; Rele повторит подключение.', 'shared-daemon-unavailable');
  return validate(started, ['started', 'alreadyRunning']);
}
