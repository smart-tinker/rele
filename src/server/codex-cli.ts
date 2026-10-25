import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
import { Duplex, type Readable, type Writable } from 'node:stream';
import type { Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { ConfigStore, defaultDataDirectory } from './config.js';
import { codexEnvironment, fileExists, environmentValue, resolveCodexLaunch } from './codex-launch.js';
import { ensureSharedCodex, isSharedCodexWebSocket, SharedCodexError, resolveSharedCodexExecutable } from './codex-shared.js';
import { setupSharedCodex } from './codex-setup.js';
import { discoverCodex } from './codex-discovery.js';
import type { CodexConnectionTarget, CodexDiscoveryResult } from '../shared/types.js';

export class CodexShimError extends Error {}

const MAX_FRAME_BYTES = 32 * 1024 * 1024;

async function canonicalHome(value: string): Promise<string> {
  const resolved = await realpath(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Only framing changes: Desktop's initialize, request IDs and notifications pass unchanged. */
export async function bridgeCodexStdio(socket: WebSocket, input: Readable, output: Writable, maxFrameBytes = MAX_FRAME_BYTES, codexHome?: string): Promise<void> {
  let ended = false;
  let initializeId: string | number | undefined;
  let profileConfirmed = false;
  let confirmInitialize!: () => void, rejectInitialize!: (error: Error) => void;
  const initialized = new Promise<void>((resolve, reject) => { confirmInitialize = resolve; rejectInitialize = reject; });
  void initialized.catch(() => {});
  const expectedHome = codexHome ? await canonicalHome(codexHome) : undefined;
  let initializeTimer: NodeJS.Timeout | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    if (expectedHome) initializeTimer = setTimeout(() => {
      const error = new CodexShimError('Codex не подтвердил профиль Desktop вовремя.'); rejectInitialize(error); reject(error);
    }, 15_000);
    let receiving = Promise.resolve();
    socket.once('close', () => { ended = true; rejectInitialize(new CodexShimError('Общий Codex отключён до подтверждения профиля.')); input.destroy(); resolve(); });
    socket.on('error', reject);
    output.on('error', reject);
    socket.on('message', (data, binary) => {
      receiving = receiving.then(async () => {
      try {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (binary || bytes.length > maxFrameBytes) throw new CodexShimError('Некорректное сообщение общего Codex.');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const message = JSON.parse(text) as { id?: string | number; result?: { codexHome?: string } };
        if (expectedHome && !profileConfirmed && initializeId !== undefined && message.id === initializeId && !('method' in message)) {
          if (typeof message.result?.codexHome !== 'string' || await canonicalHome(message.result.codexHome) !== expectedHome) throw new CodexShimError('Общий Codex ответил из другого профиля. Запросы Desktop не отправлены.');
          profileConfirmed = true; clearTimeout(initializeTimer); confirmInitialize();
        }
        const frame = JSON.stringify(message);
        if (!output.write(frame + '\n')) socket.pause();
      } catch {
        const error = new CodexShimError('Не подтверждён профиль или формат общего Codex. Соединение Desktop закрыто.');
        rejectInitialize(error); reject(error);
      }
      });
      void receiving.catch(reject);
    });
    output.on('drain', () => socket.resume());
  });
  const pump = async () => {
    let chunks: Buffer[] = [], size = 0;
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const part = chunk.subarray(start, newline === -1 ? chunk.length : newline);
        size += part.length;
        if (size > maxFrameBytes) throw new CodexShimError('Сообщение Desktop превышает допустимый размер.');
        chunks.push(part);
        if (newline === -1) break;
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
        chunks = []; size = 0;
        if (raw.trim()) {
          const message = JSON.parse(raw) as { id?: string | number; method?: string };
          if (expectedHome && initializeId === undefined) {
            if (message.method !== 'initialize' || message.id === undefined) throw new CodexShimError('Desktop должен начать с initialize.');
            initializeId = message.id;
          }
          await new Promise<void>((resolve, reject) => socket.send(raw, error => error ? reject(error) : resolve()));
          if (expectedHome) await initialized;
        }
        start = newline + 1;
      }
    }
    if (size) throw new CodexShimError('Desktop завершил неполное сообщение.');
    socket.close();
  };
  try {
    await Promise.race([closed, pump()]);
  } catch (error) {
    if (!ended) throw error;
  } finally {
    clearTimeout(initializeTimer);
    input.destroy();
    socket.terminate();
  }
}

function appServerInvocation(args: string[]): { index: number; unknownPrefix: boolean } | undefined {
  let index = 0;
  while (index < args.length) {
    if (args[index] === '-c' || args[index] === '--config') { index += 2; continue; }
    if (args[index].startsWith('--config=') || args[index].startsWith('-c') && args[index].length > 2) { index++; continue; }
    break;
  }
  if (args[index] === 'app-server') return { index, unknownPrefix: false };
  // An unknown global startup option must not hide app-server in CLI passthrough.
  const candidate = args.indexOf('app-server', index + 1);
  return args[index]?.startsWith('-') && candidate !== -1 ? { index: candidate, unknownPrefix: true } : undefined;
}

export function shimMode(args: string[]): 'daemon' | 'stdio' | 'interactive' | 'desktop' | 'desktop-check' | 'desktop-setup' | 'unsupported' | 'passthrough' {
  if (['exec', 'e', 'x'].includes(args[0])) return 'unsupported';
  if (args[0] === '--rele-daemon-start') return 'daemon';
  if (args[0] === '--rele-desktop') return 'desktop';
  if (args[0] === '--rele-desktop-check') return 'desktop-check';
  if (args[0] === '--rele-desktop-setup') return 'desktop-setup';
  if (args[0] === '--rele-cli') return 'interactive';
  const server = appServerInvocation(args);
  if (server && (server.unknownPrefix || !args[server.index + 1] || args[server.index + 1].startsWith('-'))) return 'stdio';
  return 'passthrough';
}

/** Select an installed GUI next to its own resources, never a CLI or execution alias. */
export async function findDesktopExecutable(discovery: CodexDiscoveryResult, exists = fileExists): Promise<string> {
  const candidates = new Set<string>();
  for (const item of discovery.installations) {
    if (!/[\\/]resources[\\/]codex\.exe$/iu.test(item.executable)) continue;
    const directory = path.win32.dirname(path.win32.dirname(item.executable));
    if (!await exists(path.win32.join(directory, 'resources', 'app.asar'))) continue;
    for (const name of ['ChatGPT.exe', 'Codex.exe']) {
      const executable = path.win32.join(directory, name);
      if (await exists(executable)) { candidates.add(executable); break; }
    }
  }
  if (candidates.size !== 1) throw new CodexShimError('Не удалось однозначно найти Codex Desktop. Проверьте установку Desktop в панели Rele.');
  return [...candidates][0];
}

export function validateStdioFlags(args: string[]): boolean {
  // The daemon owns startup settings; only the explicit Desktop transport hints below are exempt.
  const server = appServerInvocation(args);
  const incompatible = () => new CodexShimError('Параметры запуска Desktop несовместимы с общим Codex. Настройте общий профиль Codex.');
  if (!server || server.unknownPrefix) throw incompatible();
  const flags = [...args.slice(0, server.index), ...args.slice(server.index + 1)];
  let requireCodeModeHost = false;
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] === '--analytics-default-enabled' || flags[index] === '--stdio') continue;
    if (flags[index] === '--listen') {
      if (flags[index + 1] !== 'stdio://') throw incompatible();
      index++; continue;
    }
    if (flags[index] === '--listen=stdio://') continue;
    let override: string | undefined;
    if (flags[index] === '-c' || flags[index] === '--config') override = flags[++index];
    else if (flags[index].startsWith('--config=')) override = flags[index].slice('--config='.length);
    else if (flags[index].startsWith('-c') && flags[index].length > 2) override = flags[index].slice(2);
    if (override === 'features.code_mode_host=true') { requireCodeModeHost = true; continue; }
    // Official Desktop's configured WS transport skips these local startup hints.
    // Shared mode keeps the daemon/profile plugin and Windows sandbox policy;
    // its sandbox backend can differ from a private Desktop server's.
    if (override === 'features.prefer_mxc=true') continue;
    if (['mcp_servers.codex_app.enabled',
      'mcp_servers.code-review.enabled'].some(key =>
      override === `${key}=true` || override === `${key}=false`)) continue;
    throw incompatible();
  }
  return requireCodeModeHost;
}

/** A separate read-only connection keeps Desktop's initializer and RPC IDs untouched. */
export async function verifyDesktopCodeModeHost(socket: WebSocket, codexHome: string): Promise<void> {
  const unavailable = () => new CodexShimError('Общий Codex не подтвердил стартовые настройки Desktop. Подключение не проверено; проверьте состояние Codex в Rele.');
  let failure: Error | undefined;
  let pending: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  const fail = (error: Error) => { failure ??= error; pending?.reject(failure); pending = undefined; };
  const receive = (data: WebSocket.RawData, binary: boolean) => {
    try {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (binary || bytes.length > MAX_FRAME_BYTES) throw unavailable();
      const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as { id?: number; method?: string; result?: unknown; error?: unknown };
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw unavailable();
      if (pending && message.id === pending.id && !('method' in message)) {
        if ('error' in message) throw unavailable();
        const current = pending; pending = undefined; current.resolve(message.result);
      }
    } catch { fail(unavailable()); }
  };
  const disconnected = () => fail(unavailable());
  const timer = setTimeout(disconnected, 15_000);
  socket.on('message', receive);
  socket.on('close', disconnected);
  socket.on('error', disconnected);
  const call = (id: number, method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    if (failure) { reject(failure); return; }
    pending = { id, resolve, reject };
    socket.send(JSON.stringify({ id, method, params }), error => { if (error) fail(unavailable()); });
  });
  try {
    const initialized = await call(1, 'initialize', { clientInfo: { name: 'rele_desktop_startup_check', version: '0.0.0' }, capabilities: { experimentalApi: true } }) as { codexHome?: unknown } | undefined;
    if (typeof initialized?.codexHome !== 'string' || await canonicalHome(initialized.codexHome) !== await canonicalHome(codexHome)) throw new CodexShimError('Общий Codex ответил из другого профиля. Запросы Desktop не отправлены.');
    await new Promise<void>((resolve, reject) => socket.send(JSON.stringify({ method: 'initialized' }), error => error ? reject(unavailable()) : resolve()));
    const features = await call(2, 'experimentalFeature/list', {}) as { data?: Array<{ name?: unknown; enabled?: unknown }> } | undefined;
    const matched = Array.isArray(features?.data) ? features.data.filter(feature => feature?.name === 'code_mode_host') : [];
    if (matched.length !== 1 || matched[0].enabled !== true) throw new CodexShimError('Не подтверждён features.code_mode_host=true в общем Codex. Проверьте общий профиль и штатно перезапустите Codex; Desktop не подключён.');
    await call(3, 'configRequirements/read', undefined);
    await call(4, 'config/read', { includeLayers: false });
  } finally {
    clearTimeout(timer);
    socket.off('message', receive); socket.off('close', disconnected); socket.off('error', disconnected);
  }
}

function sharedProxy(launch: Awaited<ReturnType<typeof resolveCodexLaunch>>, endpoint: string, env: NodeJS.ProcessEnv) {
  const proxy = spawn(launch.command, [...launch.args, 'app-server', 'proxy', '--sock', endpoint], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  proxy.stderr.resume(); // Native diagnostics can contain paths or request details; do not copy them to Desktop.
  const stream = Duplex.from({ readable: proxy.stdout, writable: proxy.stdin });
  const socket = new WebSocket('ws://localhost/', { createConnection: () => stream as Socket, handshakeTimeout: 10_000, maxPayload: MAX_FRAME_BYTES, followRedirects: false });
  socket.on('error', () => {});
  proxy.once('error', () => socket.terminate());
  proxy.once('exit', () => socket.terminate());
  return { socket, stop: () => { socket.terminate(); proxy.kill(); } };
}

function sharedConnection(launch: Awaited<ReturnType<typeof resolveCodexLaunch>>, target: CodexConnectionTarget, env: NodeJS.ProcessEnv) {
  if (target.transport !== 'websocket') return sharedProxy(launch, target.endpoint, env);
  if (!isSharedCodexWebSocket(target.endpoint)) throw new CodexShimError('Desktop принимает только проверенный локальный адрес общего Codex.');
  const socket = new WebSocket(target.endpoint, { handshakeTimeout: 10_000, maxPayload: MAX_FRAME_BYTES, followRedirects: false });
  socket.on('error', () => {});
  return { socket, stop: () => socket.terminate() };
}

export async function verifyDesktopConnection(launch: Awaited<ReturnType<typeof resolveCodexLaunch>>, target: CodexConnectionTarget, env: NodeJS.ProcessEnv): Promise<void> {
  if (!target.codexHome) throw new CodexShimError('Не подтверждён профиль общего Codex.');
  const check = sharedConnection(launch, target, env);
  try { await once(check.socket, 'open'); await verifyDesktopCodeModeHost(check.socket, target.codexHome); }
  finally { check.stop(); }
}

/** Explicit launch changes only this process's transport address; native Desktop stays untouched. */
export function desktopConnectionEnvironment(env: NodeJS.ProcessEnv, target: CodexConnectionTarget): NodeJS.ProcessEnv {
  if (target.transport !== 'websocket' || !isSharedCodexWebSocket(target.endpoint)) throw new CodexShimError('Не подтверждён прямой локальный сервер Desktop.');
  const current = environmentValue(env, 'CODEX_APP_SERVER_WS_URL');
  if (current && current !== target.endpoint) throw new CodexShimError('Адрес Desktop принадлежит другому подключению; настройки сохранены.');
  if (environmentValue(env, 'CODEX_CLI_PATH') || environmentValue(env, 'CODEX_APP_SERVER_FORCE_CLI')) throw new CodexShimError('Прежняя подмена backend Desktop требует штатного восстановления.');
  const result = { ...env };
  for (const key of Object.keys(result)) if (key.toUpperCase() === 'CODEX_APP_SERVER_WS_URL') delete result[key];
  result.CODEX_APP_SERVER_WS_URL = target.endpoint;
  return result;
}

async function main(args: string[]): Promise<void> {
  const mode = shimMode(args);
  if (mode === 'unsupported') throw new CodexShimError('codex exec не поддерживает общий --remote в этой версии. Используйте интерактивный общий Codex CLI.');
  const requireCodeModeHost = mode === 'desktop-check' || mode === 'stdio' && validateStdioFlags(args);
  const config = new ConfigStore(defaultDataDirectory());
  if (mode === 'desktop-setup') {
    await setupSharedCodex(config, async (candidate, env) => {
      let target: CodexConnectionTarget;
      try { target = await ensureSharedCodex(candidate, { env }); }
      catch (error) {
        // The one allowed Quit releases the private Desktop; ordinary launch checks again.
        if (error instanceof SharedCodexError && error.code === 'shared-desktop-conflict') return;
        throw error;
      }
      await verifyDesktopConnection(await resolveCodexLaunch(target.executable, { env }), target, env);
    });
    return;
  }
  try { await config.load(); }
  catch { throw new CodexShimError('Не удалось прочитать защищённые настройки Rele. Подключение Desktop не проверено; откройте Rele под владельцем установки.'); }
  // An explicit old endpoint is never silently replaced by a second owner.
  if (mode === 'daemon' && config.config.codex.transport !== 'shared') return;
  if (mode !== 'passthrough' && config.config.codex.transport !== 'shared') throw new CodexShimError('Подключение Desktop требует режима «Общий Codex» в Rele. Прежние адрес сервера и профиль сохранены; перейдите на общий режим после завершения текущих запросов.');
  const env = codexEnvironment(config.config.codex.codexHome);
  if (mode === 'daemon') delete env.RELE_CODEX_DAEMON_EXTERNAL;
  if (mode === 'desktop') {
    if (process.platform !== 'win32') throw new CodexShimError('Этот launcher предназначен для Windows Desktop.');
    const discovery = await discoverCodex(config.config.codex.codexHome ? { codexHome: config.config.codex.codexHome } : undefined);
    const executable = await findDesktopExecutable(discovery);
    const target = await ensureSharedCodex(config.config.codex, { env });
    await verifyDesktopConnection(await resolveCodexLaunch(target.executable, { env }), target, env);
    const desktopEnv = desktopConnectionEnvironment(env, target);
    const desktop = spawn(executable, args.slice(1), { env: desktopEnv, cwd: path.dirname(executable), stdio: 'ignore', detached: true, windowsHide: false });
    await once(desktop, 'spawn'); desktop.unref();
    return;
  }
  let target = config.config.codex;
  if (mode !== 'passthrough') {
    try { target = await ensureSharedCodex(target, { env }); }
    catch (error) {
      // Installation may precede the one allowed Quit; the adapter checks again after relaunch.
      if (mode === 'desktop-check' && error instanceof SharedCodexError && error.code === 'shared-desktop-conflict') return;
      throw error;
    }
  }
  const executable = mode === 'passthrough' && target.executable === 'codex' ? await resolveSharedCodexExecutable(target, { env }) : target.executable;
  let launch: Awaited<ReturnType<typeof resolveCodexLaunch>>;
  try { launch = await resolveCodexLaunch(executable, { env }); }
  catch { throw new CodexShimError('Выбранный исполняемый файл Codex недоступен. Повторите выбор Codex в Rele; сохранённый профиль не изменён.'); }
  if (mode === 'daemon') return;
  if (mode !== 'stdio' && mode !== 'desktop-check') {
    const childArgs = mode === 'interactive' ? ['--remote', target.transport === 'websocket' ? target.endpoint : `unix://${target.endpoint}`, ...args.slice(1)] : args;
    const child = spawn(launch.command, [...launch.args, ...childArgs], { env, stdio: 'inherit', windowsHide: true });
    child.once('error', () => { process.stderr.write('Rele: не удалось запустить Codex CLI.\n'); process.exitCode = 1; });
    const [code] = await once(child, 'exit') as [number | null];
    process.exitCode = code ?? 1;
    return;
  }
  if (requireCodeModeHost) await verifyDesktopConnection(launch, target, env);
  if (mode === 'desktop-check') return;
  const { socket, stop } = sharedConnection(launch, target, env);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await once(socket, 'open');
    await bridgeCodexStdio(socket, process.stdin, process.stdout, MAX_FRAME_BYTES, target.codexHome);
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    stop(); // Only this connection's byte proxy; the native daemon belongs to Codex.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const message = error instanceof CodexShimError || error instanceof SharedCodexError ? error.message : 'Подключение к общему Codex прервано. Неподтверждённые запросы требуют сверки; проверьте настройки Rele.';
    process.stderr.write(`Rele: ${message}\n`); process.exitCode = 1;
  });
}
