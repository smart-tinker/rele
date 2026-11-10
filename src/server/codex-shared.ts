import { spawn } from 'node:child_process';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants, createReadStream, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import type { CodexConnectionTarget, CodexDiscoveryResult } from '../shared/types.js';
import { SUPPORTED_CODEX_VERSIONS } from '../shared/codex-runtime.js';
import { defaultDataDirectory, isLocalCodexHome, isLocalSocketPath } from './config.js';
import { compareCodexInstallations, discoverCodex } from './codex-discovery.js';
import { codexEnvironment, environmentValue, resolveCodexLaunch, type CodexLaunch } from './codex-launch.js';

export class SharedCodexError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'SharedCodexError'; }
}

interface CommandResult { stdout: string; code: number | null }
export interface SharedCodexOptions {
  env?: NodeJS.ProcessEnv;
  discover?: typeof discoverCodex;
  run?: (command: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<CommandResult>;
  timeoutMs?: number;
  prepareControlDirectory?: (home: string, launch: CodexLaunch, env: NodeJS.ProcessEnv) => Promise<void>;
}

async function prepareWindowsControlDirectory(home: string, launch: CodexLaunch, env: NodeJS.ProcessEnv): Promise<void> {
  if (process.platform !== 'win32') return;
  const helper = fileURLToPath(new URL('../../dist/native/Rele.Process.exe', import.meta.url));
  const result = await runSharedCommand(helper, ['--repair-codex-control', home, '--', launch.command, ...launch.args], 10_000, env);
  if (result.code !== 0 || !/^\{"status":"(?:unchanged|migrated)"\}\s*$/u.test(result.stdout)) {
    throw new SharedCodexError('Не удалось безопасно подготовить служебный каталог общего Codex. Его владелец, права, содержимое или состояние запуска требуют проверки; существующие файлы сохранены.', 'shared-control-migration-required');
  }
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

/** An official npm wrapper selects only its own optional native package or bundled vendor files. */
export async function nativeCodexExecutable(executable: string, platform = process.platform): Promise<string> {
  const native = await realpath(executable);
  if (!/\.[cm]?js$/iu.test(native)) return native;
  const root = path.dirname(path.dirname(native));
  if ((JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { name?: unknown }).name !== '@openai/codex') throw new Error('Not an official Codex package.');
  const architecture = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : '';
  const suffix = platform === 'win32' ? 'pc-windows-msvc' : platform === 'linux' ? 'unknown-linux-musl' : '';
  if (!architecture || !suffix) throw new Error('Unsupported native platform.');
  let vendor: string;
  try { vendor = path.join(path.dirname(createRequire(native).resolve(`@openai/codex-${platform}-${process.arch}/package.json`)), 'vendor'); }
  catch { vendor = path.join(root, 'vendor'); }
  return realpath(path.join(vendor, `${architecture}-${suffix}`, 'bin', platform === 'win32' ? 'codex.exe' : 'codex'));
}

/** Return the complete supported package's version; native code verifies copied contents. */
export async function completeCodexPackage(executable: string): Promise<string | undefined> {
  try {
    const architecture = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : '';
    const suffix = process.platform === 'win32' ? 'pc-windows-msvc' : process.platform === 'linux' ? 'unknown-linux-musl' : '';
    if (!architecture || !suffix) return undefined;
    const target = `${architecture}-${suffix}`, binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const native = await nativeCodexExecutable(executable);
    const directory = path.dirname(native);
    const packaged = ['bin', 'codex-resources'].includes(path.basename(directory));
    const root = packaged ? path.dirname(directory) : directory;
    const metadata = JSON.parse(await readFile(path.join(root, 'codex-package.json'), 'utf8')) as { layoutVersion?: unknown; version?: unknown; target?: unknown; entrypoint?: unknown; execServer?: unknown };
    const entrypoint = `bin/${binary}`;
    const winget = process.platform === 'win32' && metadata.layoutVersion === 1 && metadata.entrypoint === `codex-${target}.exe` && path.basename(native) === metadata.entrypoint;
    if (!packaged && !winget || typeof metadata.version !== 'string' || !SUPPORTED_CODEX_VERSIONS.includes(metadata.version)
      || metadata.target !== target || metadata.entrypoint !== entrypoint && !winget) return undefined;
    const sourceEntrypoint = String(metadata.entrypoint);
    const execServer = `bin/${process.platform === 'win32' ? 'codex-exec-server.exe' : 'codex-exec-server'}`;
    if (metadata.execServer !== undefined && metadata.execServer !== execServer) return undefined;
    const files = ['codex-package.json', sourceEntrypoint, path.posix.join(path.posix.dirname(sourceEntrypoint), process.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'),
      process.platform === 'win32' ? 'codex-path/rg.exe' : 'codex-path/rg',
      ...(process.platform === 'win32' ? ['codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe'] : ['codex-resources/bwrap'])];
    if (metadata.execServer) files.push(execServer);
    const present = await Promise.all(files.map(async file => {
      const info = await stat(path.join(root, file));
      return info.isFile() && (process.platform === 'win32' || file === 'codex-package.json' || !!(info.mode & 0o111));
    }));
    return present.every(Boolean) ? metadata.version : undefined;
  } catch { return undefined; }
}

const DESKTOP_PACKAGE_FILES = [
  ['codex.exe', 'bin/codex.exe'],
  ['codex-code-mode-host.exe', 'bin/codex-code-mode-host.exe'],
  ['codex-command-runner.exe', 'codex-resources/codex-command-runner.exe'],
  ['codex-windows-sandbox-setup.exe', 'codex-resources/codex-windows-sandbox-setup.exe'],
  ['rg.exe', 'codex-path/rg.exe'],
] as const;

async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

interface PreparedDesktopPackage {
  executable: string;
  sourceExecutable: string;
  version: string;
  executableSha256: string;
  sourceSelection: string;
  sourceUnchanged: boolean;
}

function sourceIdentity(info: Awaited<ReturnType<typeof stat>>) {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}

async function packageFiles(directory: string): Promise<string[]> {
  const files: string[] = []; let entries = 0;
  const walk = async (relative: string) => {
    for (const name of await readdir(path.join(directory, relative))) {
      const item = path.posix.join(relative, name), file = path.join(directory, item), info = await lstat(file);
      if (++entries > 512 || info.isSymbolicLink()) throw new Error('Invalid native package inventory.');
      if (info.isDirectory()) await walk(item);
      else if (info.isFile()) files.push(item);
      else throw new Error('Invalid native package file.');
    }
  };
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(['bin', 'codex-package.json', 'codex-path', 'codex-resources'])) throw new Error('Invalid native package root.');
  for (const folder of ['bin', 'codex-resources', 'codex-path']) {
    const info = await lstat(path.join(directory, folder));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid native package directory.');
    await walk(folder);
  }
  return files.sort();
}

/** Status reads bind metadata; prepare/apply separately verify every cached file. */
export async function readPreparedDesktopCodexPackage(executable: string, options: SharedCodexOptions = {}, verifyFiles = false): Promise<PreparedDesktopPackage | undefined> {
  const data = await canonicalDirectory(path.resolve(environmentValue(options.env ?? process.env, 'RELE_DATA_DIR') || defaultDataDirectory()));
  const cache = path.join(data, 'codex-desktop-packages');
  const parts = path.relative(cache, path.resolve(executable)).split(path.sep);
  if (parts.length !== 3 || !/^[a-f0-9]{64}$/u.test(parts[0]) || parts[1] !== 'bin' || parts[2] !== 'codex.exe') return;
  const invalid = () => new SharedCodexError('Сохранённый полный пакет Codex изменён или не подтверждён. Файлы и работающий сервер сохранены.', 'shared-desktop-package-invalid');
  try {
    const directory = path.join(cache, parts[0]);
    for (const folder of [data, cache, directory]) if (!(await lstat(folder)).isDirectory() || !samePath(await realpath(folder), folder)) throw invalid();
    const file = path.join(directory, 'codex-package.json'), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw invalid();
    const bytes = await readFile(file), manifest = JSON.parse(bytes.toString('utf8'));
    const required: string[] = DESKTOP_PACKAGE_FILES.map(([, destination]) => destination);
    if (manifest.execServer !== undefined) {
      if (manifest.execServer !== 'bin/codex-exec-server.exe') throw invalid();
      required.push(manifest.execServer);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== parts[0] || manifest.layoutVersion !== 1
      || manifest.target !== 'x86_64-pc-windows-msvc' || manifest.entrypoint !== 'bin/codex.exe'
      || manifest.resourcesDir !== 'codex-resources' || manifest.pathDir !== 'codex-path'
      || typeof manifest.version !== 'string' || !SUPPORTED_CODEX_VERSIONS.includes(manifest.version)
      || typeof manifest.sourceExecutable !== 'string' || !path.isAbsolute(manifest.sourceExecutable)
      || manifest.sourceSelection !== undefined && (typeof manifest.sourceSelection !== 'string' || !manifest.sourceSelection || manifest.sourceSelection.includes('\0'))
      || !Array.isArray(manifest.files) || manifest.files.length < required.length || manifest.files.length > 512
      || manifest.files.some((item: { path?: unknown; sha256?: unknown }) => typeof item.path !== 'string'
        || !/^(?:bin|codex-resources|codex-path)\//u.test(item.path) || item.path.includes('\\') || item.path.split('/').some(part => !part || part === '.' || part === '..')
        || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256))
      || new Set(manifest.files.map((item: { path: string }) => item.path)).size !== manifest.files.length
      || required.some(name => !manifest.files.some((item: { path: string }) => item.path === name))) throw invalid();
    if (verifyFiles) {
      if (JSON.stringify(await packageFiles(directory)) !== JSON.stringify(manifest.files.map((item: { path: string }) => item.path).sort())) throw invalid();
      for (const item of manifest.files) if (await fileDigest(path.join(directory, item.path)) !== item.sha256) throw invalid();
    }
    if (!(await readFile(file)).equals(bytes)) throw invalid();
    const unchanged = await stat(manifest.sourceExecutable).then(info => info.isFile()
      && JSON.stringify(sourceIdentity(info)) === JSON.stringify(manifest.sourceIdentity), () => false);
    return { executable: path.join(directory, 'bin', 'codex.exe'), sourceExecutable: manifest.sourceExecutable,
      sourceSelection: manifest.sourceSelection ?? manifest.sourceExecutable, sourceUnchanged: unchanged,
      version: manifest.version, executableSha256: manifest.files.find((item: { path: string }) => item.path === 'bin/codex.exe').sha256 };
  } catch (error) { if (error instanceof SharedCodexError) throw error; throw invalid(); }
}

/** Snapshot one complete native package, never auth, history or another release's helpers. */
export async function prepareDesktopCodexPackage(executable: string, options: SharedCodexOptions = {}, sourceSelection = executable): Promise<string | undefined> {
  if (process.arch !== 'x64' || path.basename(executable).toLowerCase() !== 'codex.exe'
    || !['resources', 'bin'].includes(path.basename(path.dirname(executable)).toLowerCase())) return;
  const existing = await readPreparedDesktopCodexPackage(executable, options, true);
  if (existing) return existing.executable;
  const env = options.env ?? process.env; let staging: string | undefined, recognized = false;
  const invalid = () => new SharedCodexError('Не удалось проверить полный локальный пакет Codex. Существующие файлы и сервер сохранены.', 'shared-desktop-package-invalid');
  try {
    const canonical = path.basename(path.dirname(executable)) === 'bin';
    const bundle = await realpath(path.dirname(path.dirname(executable)));
    const inside = (file: string) => { const relative = path.relative(bundle, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
    const localFile = async (file: string) => { const resolved = await realpath(file); if (!inside(resolved) || !(await stat(resolved)).isFile()) throw invalid(); return resolved; };
    const sources: Array<{ source: string; original: string; destination: string; digest: string }> = [];
    let metadata: Record<string, unknown>, originalManifest: Buffer | undefined;
    if (canonical) {
      try { originalManifest = await readFile(path.join(bundle, 'codex-package.json')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const packageLayout = await Promise.all(['codex-resources', 'codex-path'].map(name => stat(path.join(bundle, name)).then(info => info.isDirectory(), () => false)));
        if (packageLayout.some(Boolean)) throw invalid();
        return; // Older self-contained CLI paths can legitimately have no package manifest.
      }
      if (originalManifest.length > 64 * 1024) throw invalid();
      metadata = JSON.parse(originalManifest.toString('utf8'));
      if (metadata.layoutVersion !== 1 || metadata.target !== 'x86_64-pc-windows-msvc' || metadata.entrypoint !== 'bin/codex.exe'
        || metadata.resourcesDir !== 'codex-resources' || metadata.pathDir !== 'codex-path'
        || metadata.execServer !== undefined && metadata.execServer !== 'bin/codex-exec-server.exe') throw invalid();
      recognized = true;
      const paths = await packageFiles(bundle), required: string[] = DESKTOP_PACKAGE_FILES.map(([, destination]) => destination);
      if (metadata.execServer) required.push(metadata.execServer as string);
      if (required.some(file => !paths.includes(file))) throw invalid();
      for (const destination of paths) { const original = path.join(bundle, destination), source = await localFile(original); sources.push({ source, original, destination, digest: await fileDigest(source) }); }
    } else {
      const resources = path.join(bundle, 'resources');
      if (!await stat(path.join(resources, 'app.asar')).then(info => info.isFile(), () => false)) return;
      const gui = await Promise.all(['ChatGPT.exe', 'Codex.exe'].map(name => stat(path.join(bundle, name)).then(info => info.isFile(), () => false)));
      if (!gui.some(Boolean)) return;
      await localFile(path.join(resources, 'app.asar'));
      await Promise.all(['ChatGPT.exe', 'Codex.exe'].filter((_, index) => gui[index]).map(name => localFile(path.join(bundle, name))));
      for (const [name, destination] of DESKTOP_PACKAGE_FILES) { const original = path.join(resources, name), source = await localFile(original); sources.push({ source, original, destination, digest: await fileDigest(source) }); }
      metadata = { layoutVersion: 1, target: 'x86_64-pc-windows-msvc', variant: 'codex', entrypoint: 'bin/codex.exe', resourcesDir: 'codex-resources', pathDir: 'codex-path' };
    }
    const entry = sources.find(item => item.destination === 'bin/codex.exe')!;
    const cli = await (options.run ?? runSharedCommand)(entry.source, ['--version'], Math.min(options.timeoutMs ?? 15_000, 4_000), env);
    const version = cli.stdout.trim().match(/^codex(?:-cli)?\s+(\S+)(?:\s|$)/iu)?.[1];
    if (cli.code !== 0 || !version || !SUPPORTED_CODEX_VERSIONS.includes(version)) throw new SharedCodexError(`Для общего daemon нужен проверенный Codex ${SUPPORTED_CODEX_VERSIONS.join(' или ')}.`, 'shared-cli-unverified');
    if (canonical && metadata.version !== version) throw invalid();
    const sourceStat = await stat(entry.source);
    const manifest = JSON.stringify({ ...metadata, version, sourceExecutable: entry.source, sourceSelection, sourceIdentity: sourceIdentity(sourceStat), files: sources.map(({ destination, digest }) => ({ path: destination, sha256: digest })) });
    const digest = createHash('sha256').update(manifest).digest('hex');
    const dataDirectory = path.resolve(environmentValue(env, 'RELE_DATA_DIR') || defaultDataDirectory());
    if (!isLocalCodexHome(dataDirectory)) throw invalid();
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const data = await realpath(dataDirectory), cache = path.join(data, 'codex-desktop-packages');
    await mkdir(cache, { recursive: true, mode: 0o700 });
    if (!samePath(await realpath(cache), cache)) throw invalid();
    const destination = path.join(cache, digest);
    const unchanged = async () => {
      if (canonical && (!(await readFile(path.join(bundle, 'codex-package.json'))).equals(originalManifest!)
        || JSON.stringify(await packageFiles(bundle)) !== JSON.stringify(sources.map(item => item.destination).sort()))) throw invalid();
      for (const source of sources) if (!samePath(await localFile(source.original), source.source) || await fileDigest(source.source) !== source.digest) throw invalid();
      if (JSON.stringify(sourceIdentity(await stat(entry.source))) !== JSON.stringify(sourceIdentity(sourceStat))) throw invalid();
    };
    const verify = async (directory: string) => {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
      if (JSON.stringify(await packageFiles(directory)) !== JSON.stringify(sources.map(item => item.destination).sort())) throw invalid();
      for (const source of sources) if (await fileDigest(path.join(directory, source.destination)) !== source.digest) throw invalid();
      if (!(await readFile(path.join(directory, 'codex-package.json'))).equals(Buffer.from(manifest))) throw invalid();
    };
    if (await lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) { await unchanged(); await verify(destination); return path.join(destination, 'bin', 'codex.exe'); }
    staging = await mkdtemp(path.join(cache, '.prepare-'));
    for (const source of sources) { const target = path.join(staging, source.destination); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await copyFile(source.source, target, constants.COPYFILE_EXCL); }
    await writeFile(path.join(staging, 'codex-package.json'), manifest, { flag: 'wx', mode: 0o600 });
    await unchanged(); await verify(staging);
    try { await rename(staging, destination); } catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
    await verify(destination); return path.join(destination, 'bin', 'codex.exe');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !recognized) return; if (error instanceof SharedCodexError) throw error; throw invalid(); }
  finally { if (staging) await rm(staging, { recursive: true, force: true }); }
}

/** Resolve only installed files and version metadata; this never starts the daemon. */
export async function resolveSharedCodexExecutable(target: CodexConnectionTarget, options: SharedCodexOptions = {}): Promise<string> {
  const env = codexEnvironment(target.codexHome, options.env ?? process.env);
  const home = await canonicalDirectory(sharedHome(env));
  const expectedSocket = path.join(home, 'app-server-control', 'app-server-control.sock');
  const run = options.run ?? runSharedCommand;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let executable = target.executable, installedCurrent = false;
  if (executable === 'codex') {
    const native = path.join(home, 'packages', 'app-server-daemon', 'current', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    const installed = await stat(native).then(info => info.isFile(), error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new SharedCodexError('Нет доступа к установленному общему Codex.', 'shared-cli-unavailable');
    });
    if (installed) { executable = native; installedCurrent = true; }
    else {
      const found = await (options.discover ?? discoverCodex)({ env, ...(target.codexHome ? { codexHome: target.codexHome } : {}) });
      executable = found.installations.find(item => item.running && item.version && SUPPORTED_CODEX_VERSIONS.includes(item.version) && item.connection?.transport === 'proxy' && item.connection.endpoint && samePath(path.resolve(item.connection.endpoint), expectedSocket))?.executable
        ?? found.recommendedManaged?.executable ?? '';
      if (!executable) throw new SharedCodexError(`Не найден проверенный Codex CLI. Нужен ${SUPPORTED_CODEX_VERSIONS.join(' или ')}.`, 'shared-cli-unavailable');
    }
  }
  await readPreparedDesktopCodexPackage(executable, { ...options, env });
  const launch = await resolveCodexLaunch(executable, { env });
  const cli = await run(launch.command, [...launch.args, '--version'], Math.min(timeoutMs, 4_000), env);
  const version = cli.stdout.trim().match(/^codex(?:-cli)?\s+(\S+)(?:\s|$)/iu)?.[1];
  if (cli.code !== 0 || !version || !SUPPORTED_CODEX_VERSIONS.includes(version)) {
    // An unsupported cached daemon package must not hide a supported installed control client.
    if (installedCurrent) {
      const found = await (options.discover ?? discoverCodex)({ env, ...(target.codexHome ? { codexHome: target.codexHome } : {}) });
      const candidates = found.installations.filter(item => item.version && SUPPORTED_CODEX_VERSIONS.includes(item.version))
        .sort((a, b) => compareCodexInstallations(a, b));
      const seen = new Set<string>();
      for (const candidate of candidates) {
        const key = path.normalize(candidate.executable);
        if (seen.has(key) || samePath(path.resolve(candidate.executable), path.resolve(executable))) continue;
        seen.add(key);
        try { return await resolveSharedCodexExecutable({ ...target, executable: candidate.executable }, { ...options, env }); }
        catch (error) { if (!(error instanceof SharedCodexError)) throw error; }
      }
    }
    throw new SharedCodexError(`Для общего daemon нужен проверенный Codex ${SUPPORTED_CODEX_VERSIONS.join(' или ')}.`, 'shared-cli-unverified');
  }
  return launch.executable;
}

interface WindowsCodexReceipt {
  status: 'started' | 'alreadyRunning';
  endpoint: string;
  codexHome: string;
  executable: string;
  executableSha256: string;
  ownerSid: string;
  ownerDirectory: string;
  taskName: string;
  processId: number;
  processStartTime: string;
}

/** Local Desktop does not send a token; this listener must never bind a network interface. */
export function isSharedCodexWebSocket(endpoint: string): boolean {
  const port = endpoint.match(/^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/u)?.[1];
  return !!port && Number(port) <= 65535;
}

async function verifyWindowsCodexSocket(receipt: WindowsCodexReceipt, timeoutMs: number): Promise<void> {
  const invalid = () => new SharedCodexError('Общий Codex не подтвердил исходный профиль, версию или PID. Запросы не отправлены.', 'shared-daemon-invalid');
  const socket = new WebSocket(receipt.endpoint, { handshakeTimeout: timeoutMs, maxPayload: 1024 * 1024, followRedirects: false });
  let pending: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  let failure: Error | undefined;
  const fail = () => { failure ??= invalid(); pending?.reject(failure); pending = undefined; };
  socket.on('error', fail);
  socket.on('close', fail);
  socket.on('message', (raw, binary) => {
    try {
      if (binary) throw invalid();
      const message = JSON.parse(raw.toString()) as { id?: number; method?: unknown; result?: unknown; error?: unknown };
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw invalid();
      if (pending && message.id === pending.id && !('method' in message)) {
        if ('error' in message) throw invalid();
        const current = pending; pending = undefined; current.resolve(message.result);
      }
    } catch { fail(); socket.terminate(); }
  });
  const timer = setTimeout(() => { fail(); socket.terminate(); }, timeoutMs);
  const call = (id: number, method: string, params?: unknown) => new Promise<unknown>((resolve, reject) => {
    if (failure) { reject(failure); return; }
    pending = { id, resolve, reject };
    socket.send(JSON.stringify({ id, method, params }), error => { if (error) fail(); });
  });
  try {
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve); socket.once('error', () => reject(invalid())); socket.once('close', () => reject(invalid()));
      });
    } catch { throw new SharedCodexError('Общий Codex пока не открыл локальный сокет. Запросы сохранены.', 'shared-daemon-unavailable'); }
    const initialized = await call(1, 'initialize', { clientInfo: { name: 'rele_shared_startup_check', version: '0.0.0' }, capabilities: { experimentalApi: true } }) as { userAgent?: unknown; codexHome?: unknown; platformFamily?: unknown; platformOs?: unknown } | undefined;
    const version = typeof initialized?.userAgent === 'string' ? initialized.userAgent.match(/\/(\S+)(?:\s|$)/u)?.[1] : undefined;
    if (!version || !SUPPORTED_CODEX_VERSIONS.includes(version) || initialized?.platformFamily !== 'windows' || initialized.platformOs !== 'windows'
      || typeof initialized.codexHome !== 'string') throw invalid();
    if (!samePath(await realpath(initialized.codexHome), receipt.codexHome)) throw new SharedCodexError('Общий Codex использует другой профиль. История не переносится; подключение остановлено.', 'shared-profile-mismatch');
    await new Promise<void>((resolve, reject) => socket.send(JSON.stringify({ method: 'initialized' }), error => error ? reject(invalid()) : resolve()));
    const diagnostics = await call(2, 'server/diagnostics', {}) as { process?: { id?: unknown } } | undefined;
    if (diagnostics?.process?.id !== receipt.processId) throw invalid();
  } catch (error) { throw error instanceof SharedCodexError ? error : invalid(); }
  finally { clearTimeout(timer); socket.terminate(); }
}

/** The installed owner task survives gateway restarts; Desktop connects directly to native Codex. */
export async function ensureWindowsSharedCodex(target: CodexConnectionTarget, options: SharedCodexOptions = {}, installationDirectory = fileURLToPath(new URL('../../', import.meta.url))): Promise<CodexConnectionTarget> {
  if (target.transport !== 'shared' || target.endpoint) throw new SharedCodexError('Выберите общий Codex без ручного endpoint.', 'invalid-shared-target');
  const env = codexEnvironment(target.codexHome, options.env ?? process.env);
  const home = effectiveSharedCodexHome(env);
  const run = options.run ?? runSharedCommand, timeoutMs = options.timeoutMs ?? 15_000;
  const invalid = () => new SharedCodexError('Не подтверждён установленный владелец общего Codex. Чужие процессы и настройки сохранены.', 'shared-daemon-invalid');
  const installation = async () => {
    const metadata = JSON.parse(await readFile(path.join(installationDirectory, 'rele-install.json'), 'utf8')) as { OwnerSid?: unknown; DataDirectory?: unknown; TaskName?: unknown; CodexHome?: unknown; CodexWebSocketEndpoint?: unknown; CodexWebSocketOwnerDirectory?: unknown; CodexWebSocketTaskName?: unknown };
    if (typeof metadata.OwnerSid !== 'string' || !/^S-1-[0-9-]+$/u.test(metadata.OwnerSid)
      || typeof metadata.DataDirectory !== 'string' || typeof metadata.TaskName !== 'string' || !/^Rele-[A-Za-z0-9._-]{1,120}$/u.test(metadata.TaskName)) throw invalid();
    const expectedData = await realpath(environmentValue(env, 'RELE_DATA_DIR') || defaultDataDirectory());
    if (!samePath(await realpath(metadata.DataDirectory), expectedData)) throw invalid();
    if (metadata.CodexHome && (typeof metadata.CodexHome !== 'string' || !samePath(effectiveSharedCodexHome(codexEnvironment(metadata.CodexHome, env)), home))) throw new SharedCodexError('Установка Rele использует другой профиль Codex. Настройки сохранены.', 'shared-profile-mismatch');
    return metadata;
  };
  try {
    const before = await installation();
    const validateReceipt = async (result: CommandResult, executable?: string, existingOnly = false): Promise<WindowsCodexReceipt> => {
      const receipt = JSON.parse(result.stdout) as WindowsCodexReceipt;
      const after = await installation();
      const currentPointer = [
        [after.CodexWebSocketTaskName, receipt?.taskName], [after.CodexWebSocketEndpoint, receipt?.endpoint],
        // Read-only status can report the Task's verified successor before codex-start promotes its saved pointer.
        ...(!existingOnly ? [[after.CodexWebSocketOwnerDirectory, receipt?.ownerDirectory]] : []),
      ];
      if (result.code !== 0 || !receipt || !(existingOnly ? ['alreadyRunning'] : ['started', 'alreadyRunning']).includes(receipt.status)
        || typeof receipt.endpoint !== 'string' || !isSharedCodexWebSocket(receipt.endpoint)
        || receipt.ownerSid !== before.OwnerSid || receipt.ownerSid !== after.OwnerSid || before.TaskName !== after.TaskName || receipt.taskName !== `${before.TaskName}-Codex`
        || currentPointer.some(([saved, actual]) => (!existingOnly || saved) && saved !== actual)
        || typeof receipt.ownerDirectory !== 'string' || !/^[a-f0-9]{64}$/u.test(path.basename(receipt.ownerDirectory))
        || !samePath(await realpath(path.dirname(receipt.ownerDirectory)), path.join(await realpath(after.DataDirectory as string), 'codex-websocket-owners'))
        || !Number.isSafeInteger(receipt.processId) || receipt.processId <= 0 || typeof receipt.processStartTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(receipt.processStartTime) || !Number.isFinite(Date.parse(receipt.processStartTime))
        || typeof receipt.executable !== 'string' || typeof receipt.codexHome !== 'string' || !samePath(await realpath(receipt.codexHome), home)
        || typeof receipt.executableSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.executableSha256)
        || executable && receipt.status !== 'alreadyRunning' && !samePath(await realpath(receipt.executable), executable)
        || await fileDigest(receipt.executable) !== receipt.executableSha256) throw invalid();
      return receipt;
    };
    let selected = target.executable, resolved: string | undefined;
    const priorPackage = async () => {
      const directory = before.CodexWebSocketOwnerDirectory;
      if (typeof directory !== 'string' || !/^[a-f0-9]{64}$/u.test(path.basename(directory)) || !samePath(path.dirname(directory), path.join(await realpath(before.DataDirectory as string), 'codex-websocket-owners'))) return;
      const bytes = await readFile(path.join(directory, 'owner.json')).catch(error => { if (error.code === 'ENOENT') return; throw error; });
      if (!bytes) return;
      if (bytes.length > 64 * 1024 || createHash('sha256').update(bytes).digest('hex') !== path.basename(directory)) throw invalid();
      const owner = JSON.parse(bytes.toString('utf8'));
      if (owner.OwnerSid !== before.OwnerSid || owner.TaskName !== `${before.TaskName}-Codex` || !samePath(owner.CodexHome, home)) throw invalid();
      const prepared = await readPreparedDesktopCodexPackage(owner.Executable, { ...options, env });
      if (prepared && (selected === 'codex' || samePath(selected, prepared.sourceSelection) || samePath(selected, prepared.sourceExecutable) || samePath(selected, prepared.executable))) return prepared.executable;
    };
    // The saved executable is desired policy; an existing owned server remains actual until explicit maintenance.
    const current = await run(path.join(installationDirectory, 'Rele.exe'), ['codex-status', '--quiet', '--codex-home', home], timeoutMs, env);
    const status = JSON.parse(current.stdout) as { status?: unknown; pendingUpdate?: unknown; pendingExe?: unknown } | null;
    if (current.code !== 0 || !status || !['notRunning', 'alreadyRunning'].includes(String(status.status))) throw invalid();
    const prior = status.status === 'notRunning' && status.pendingUpdate !== true ? await priorPackage() : undefined;
    if (status.status === 'alreadyRunning') selected = (await validateReceipt(current, undefined, true)).executable;
    else if (status.pendingUpdate === true) {
      if (typeof status.pendingExe !== 'string' || !path.isAbsolute(status.pendingExe)) throw invalid();
      selected = status.pendingExe;
    } else if (prior) selected = prior;
    else if (selected === 'codex') {
      const discovery = await (options.discover ?? discoverCodex)({ env, ...(target.codexHome ? { codexHome: target.codexHome } : {}) });
      const candidates = discovery.installations.filter(item => item.version && SUPPORTED_CODEX_VERSIONS.includes(item.version))
        .sort((a, b) => compareCodexInstallations(a, b, 'win32'));
      const candidateResults: { source: string; version: string; result: string }[] = [];
      const seen = new Set<string>();
      for (const candidate of candidates) {
        const key = path.win32.normalize(candidate.executable).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const native = await nativeCodexExecutable(await resolveSharedCodexExecutable({ ...target, executable: candidate.executable }, { ...options, env }), 'win32');
          if (path.basename(native).toLowerCase() !== 'codex.exe') {
            candidateResults.push({ source: candidate.source, version: candidate.version!, result: 'native-entrypoint-rejected' });
            continue;
          }
          selected = candidate.executable; resolved = native; break;
        } catch (error) {
          const code = error instanceof SharedCodexError && ['shared-cli-unavailable', 'shared-cli-unverified', 'shared-desktop-package-invalid'].includes(error.code)
            ? error.code : 'candidate-resolution-failed';
          candidateResults.push({ source: candidate.source, version: candidate.version!, result: code });
        }
      }
      if (!resolved) {
        if (environmentValue(env, 'RELE_CI_SHARED_DIAGNOSTICS') === '1') {
          const installations = discovery.installations.map(item => ({
            source: item.source,
            ...(item.version && item.version.length <= 96 && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(item.version) ? { version: item.version } : {}),
            running: item.running === true,
          }));
          const issues = [...new Set(discovery.issues.map(item => item.code).filter(code => /^[a-z][a-z0-9-]{0,63}$/u.test(code)))];
          console.error(`RELE_CI_WINDOWS_DESKTOP_DISCOVERY=${JSON.stringify({ installations, issues, candidates: candidateResults })}`);
        }
        throw new SharedCodexError('Не найден проверенный установленный Codex Desktop.', 'shared-cli-unavailable');
      }
    }
    let executable = resolved ?? await nativeCodexExecutable(await resolveSharedCodexExecutable({ ...target, executable: selected }, { ...options, env }), 'win32');
    if (status.status !== 'alreadyRunning' && status.pendingUpdate !== true) {
      const prepared = await prepareDesktopCodexPackage(executable, { ...options, env }, target.executable);
      if (!prepared && path.basename(path.dirname(executable)).toLowerCase() === 'resources') throw new SharedCodexError('Полная исходная поставка Codex не подтверждена. Сервер не запускался.', 'shared-desktop-package-invalid');
      executable = prepared ?? executable;
    }
    if (status.status !== 'alreadyRunning') {
      const cached = await readPreparedDesktopCodexPackage(executable, { ...options, env }, true);
      if (!cached) {
        const version = await run(executable, ['--version'], Math.min(timeoutMs, 4_000), env);
        if (/^codex(?:-cli)?\s+0\.166\.0-alpha\.6(?:\s|$)/u.test(version.stdout)) throw new SharedCodexError('Для нового Codex требуется подтверждённый полный пакет. Сервер не запускался.', 'shared-desktop-package-invalid');
      }
    }
    if (path.basename(executable).toLowerCase() !== 'codex.exe') throw new SharedCodexError('Общему Windows Codex нужен штатный codex.exe из установленного Desktop.', 'shared-cli-unverified');
    const deadline = Date.now() + timeoutMs;
    const result = await run(path.join(installationDirectory, 'Rele.exe'), ['codex-start', '--quiet', '--codex-executable', executable, '--codex-home', home,
      '--preserve-active'], timeoutMs, env);
    const receipt = await validateReceipt(result, executable);
    const actual = await resolveSharedCodexExecutable({ ...target, executable: receipt.executable }, { ...options, env });
    if (!samePath(await realpath(actual), await realpath(receipt.executable))) throw invalid();
    for (;;) {
      try { await verifyWindowsCodexSocket(receipt, Math.max(1, deadline - Date.now())); break; }
      catch (error) {
        if (!(error instanceof SharedCodexError) || error.code !== 'shared-daemon-unavailable' || Date.now() >= deadline) throw error;
        await delay(Math.min(100, deadline - Date.now()));
      }
    }
    if (await fileDigest(receipt.executable) !== receipt.executableSha256) throw invalid();
    return { ...target, transport: 'websocket', executable: receipt.executable, endpoint: receipt.endpoint, codexHome: home };
  } catch (error) { throw error instanceof SharedCodexError ? error : invalid(); }
}

/** Native ownership is idempotent. Never replace a private Desktop backend implicitly. */
export async function ensureSharedCodex(target: CodexConnectionTarget, options: SharedCodexOptions = {}): Promise<CodexConnectionTarget> {
  if (target.transport !== 'shared' || target.endpoint) throw new SharedCodexError('Выберите общий Codex без ручного endpoint.', 'invalid-shared-target');
  if (process.platform === 'win32') return ensureWindowsSharedCodex(target, options);
  const env = codexEnvironment(target.codexHome, options.env ?? process.env);
  const home = sharedHome(env), selectedHome = await canonicalDirectory(home);
  const pendingFile = path.join(path.resolve(env.RELE_DATA_DIR || defaultDataDirectory()), 'codex-linux-update.json');
  try {
    const info = await lstat(pendingFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 || info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error('invalid update journal');
    const saved = JSON.parse(await readFile(pendingFile, 'utf8'));
    if (saved?.schema !== 1 || saved.pending?.owner?.codexHome !== selectedHome || !['ready', 'verified'].includes(saved.pending?.phase)) {
      throw new SharedCodexError('Обновление Linux Codex требует завершения или сверки. Запросы сохранены; прежний сервер не запускается.', 'shared-linux-update-pending');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error instanceof SharedCodexError ? error : new SharedCodexError('Журнал обновления Linux Codex требует проверки; другой сервер не запускается.', 'shared-linux-update-pending');
  }
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
  // Windows AF_UNIX markers can exist while stat/lstat rejects their metadata.
  const socketPresent = await access(expectedSocket).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new SharedCodexError('Нет доступа к сокету общего Codex.', 'shared-daemon-unavailable');
  });
  const found = await (options.discover ?? discoverCodex)({ env, ...(target.codexHome ? { codexHome: target.codexHome } : {}), processesOnly: true });
  const ownerIssue = found.issues.find(issue => ['windows-discovery-unavailable', 'process-discovery-unavailable', 'process-owner-unavailable'].includes(issue.code));
  if (ownerIssue) {
    const trace = found.issues.find(issue => /^windows-probe-(?:timeout|unavailable|output-limit|exit|json|failed)-(?:startup|process-provider|process-query|process-parse|owner-query|parent-query|packages|json-provider|json|done)$/u.test(issue.code))?.code;
    throw new SharedCodexError(`Не удалось проверить существующий сервер Desktop (${ownerIssue.code}${trace ? `; ${trace}` : ''}). Проверьте доступ Rele к процессам текущего пользователя; новый сервер не запущен.`, 'shared-owner-unknown');
  }
  if (found.installations.some(item => item.running && item.connection?.transport !== 'proxy') || !socketPresent && found.installations.some(item => item.running)) throw new SharedCodexError('Codex Desktop уже использует отдельный сервер. После завершения его задач один раз полностью закройте Desktop и откройте снова с включённой интеграцией Rele. Rele не завершает чужие процессы.', 'shared-desktop-conflict');
  let completeVersion = await completeCodexPackage(launch.executable);
  if (target.executable === 'codex') {
    const available = await discover();
    const candidates = available.installations.filter(item => item.version && SUPPORTED_CODEX_VERSIONS.includes(item.version));
    // Query the current daemon before considering a different installed version. Only this absent-daemon path selects a successor.
    if (completeVersion) candidates.push({ executable: launch.executable, version: completeVersion, source: 'standard', name: 'Codex', running: false });
    candidates.sort((a, b) => compareCodexInstallations(a, b));
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = path.normalize(candidate.executable);
      if (seen.has(key)) continue;
      seen.add(key);
      if (await completeCodexPackage(candidate.executable) !== candidate.version) continue;
      try {
        launch = await resolveCodexLaunch(await resolveSharedCodexExecutable({ ...target, executable: candidate.executable }, { ...options, env }), { env });
        completeVersion = candidate.version;
        break;
      } catch (error) { if (!(error instanceof SharedCodexError)) throw error; }
    }
  }
  if (!completeVersion) throw new SharedCodexError(`Для запуска общего Codex нужен полный пакет CLI или комплектная поставка Desktop ${SUPPORTED_CODEX_VERSIONS.join(' или ')}. Проверьте установку Codex; существующий сервер не заменён.`, 'shared-package-incomplete');
  await (options.prepareControlDirectory ?? prepareWindowsControlDirectory)(selectedHome, launch, env);
  // Native singleton locks and liveness checks own stale-socket recovery.
  const deadline = Date.now() + timeoutMs;
  const started = await run(launch.command, [...launch.args, 'app-server', 'daemon', 'start'], timeoutMs, env);
  if (started.code !== 0) {
    // A failed control command can still leave the native daemon becoming ready.
    while (Date.now() < deadline) {
      const current = await run(launch.command, [...launch.args, 'app-server', 'daemon', 'version'], Math.max(1, deadline - Date.now()), env);
      if (current.code === 0) return validate(current, ['running']);
      if (Date.now() < deadline) await delay(Math.min(250, deadline - Date.now()));
    }
    throw new SharedCodexError('Не удалось запустить штатный общий daemon Codex. Проверьте выбранный CLI и профиль; Rele повторит подключение.', 'shared-daemon-unavailable');
  }
  return validate(started, ['started', 'alreadyRunning']);
}
