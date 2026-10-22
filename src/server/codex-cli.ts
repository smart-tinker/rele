import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import { Duplex, type Readable, type Writable } from 'node:stream';
import type { Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { ConfigStore, defaultDataDirectory } from './config.js';
import { codexEnvironment, fileExists, environmentValue, resolveCodexLaunch } from './codex-launch.js';
import { ensureSharedCodex, SharedCodexError, resolveSharedCodexExecutable } from './codex-shared.js';
import { discoverCodex } from './codex-discovery.js';
import type { CodexDiscoveryResult } from '../shared/types.js';

export class CodexShimError extends Error {}

const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** Only framing changes: Desktop's initialize, request IDs and notifications pass unchanged. */
export async function bridgeCodexStdio(socket: WebSocket, input: Readable, output: Writable, maxFrameBytes = MAX_FRAME_BYTES, codexHome?: string): Promise<void> {
  let ended = false;
  let initializeId: string | number | undefined;
  let profileConfirmed = false;
  let confirmInitialize!: () => void, rejectInitialize!: (error: Error) => void;
  const initialized = new Promise<void>((resolve, reject) => { confirmInitialize = resolve; rejectInitialize = reject; });
  void initialized.catch(() => {});
  const canonical = async (value: string) => { const resolved = await realpath(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
  const expectedHome = codexHome ? await canonical(codexHome) : undefined;
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
          if (typeof message.result?.codexHome !== 'string' || await canonical(message.result.codexHome) !== expectedHome) throw new CodexShimError('Общий Codex ответил из другого профиля. Запросы Desktop не отправлены.');
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

export function shimMode(args: string[]): 'daemon' | 'stdio' | 'interactive' | 'desktop' | 'unsupported' | 'passthrough' {
  if (['exec', 'e', 'x'].includes(args[0])) return 'unsupported';
  if (args[0] === '--rele-daemon-start') return 'daemon';
  if (args[0] === '--rele-desktop') return 'desktop';
  if (args[0] === '--rele-cli') return 'interactive';
  if (args[0] === 'app-server' && (!args[1] || args[1].startsWith('-'))) return 'stdio';
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

export function validateStdioFlags(args: string[]): void {
  // The daemon owns startup settings; a Desktop-only override cannot be silently discarded.
  const flags = args.slice(1);
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] === '--analytics-default-enabled' || flags[index] === '--stdio') continue;
    if (flags[index] === '--listen' && flags[++index] === 'stdio://') continue;
    if (flags[index] === '--listen=stdio://') continue;
    throw new CodexShimError('Параметры запуска Desktop несовместимы с общим Codex. Настройте общий профиль Codex.');
  }
}

async function main(args: string[]): Promise<void> {
  const mode = shimMode(args);
  if (mode === 'unsupported') throw new CodexShimError('codex exec не поддерживает общий --remote в этой версии. Используйте интерактивный общий Codex CLI.');
  if (mode === 'stdio') validateStdioFlags(args);
  const config = new ConfigStore(defaultDataDirectory());
  await config.load();
  // An explicit old endpoint is never silently replaced by a second owner.
  if (mode === 'daemon' && config.config.codex.transport !== 'shared') return;
  if (mode !== 'passthrough' && config.config.codex.transport !== 'shared') throw new CodexShimError('Сначала выберите «Общий Codex» в настройках Rele.');
  const env = codexEnvironment(config.config.codex.codexHome);
  if (mode === 'daemon') delete env.RELE_CODEX_DAEMON_EXTERNAL;
  if (mode === 'desktop') {
    if (process.platform !== 'win32') throw new CodexShimError('Этот launcher предназначен для Windows Desktop.');
    if (environmentValue(env, 'CODEX_APP_SERVER_WS_URL')) throw new CodexShimError('Удалите конфликтующий CODEX_APP_SERVER_WS_URL перед подключением Desktop.');
    const discovery = await discoverCodex(config.config.codex.codexHome ? { codexHome: config.config.codex.codexHome } : undefined);
    const executable = await findDesktopExecutable(discovery);
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const wrapper = [path.join(root, 'Rele.Codex.exe'), path.join(root, 'dist/native/Rele.Codex.exe')];
    const snapshot = environmentValue(env, 'RELE_DESKTOP_CLI');
    if (snapshot) {
      const relative = path.relative(path.join(config.directory, 'codex-adapters'), snapshot);
      if (!/^[a-f0-9]{64}[\\/]Rele\.Codex\.exe$/iu.test(relative)) throw new CodexShimError('Не подтверждён каталог установленного адаптера Desktop.');
      const metadata = JSON.parse(await readFile(path.join(path.dirname(snapshot), 'rele-install.json'), 'utf8')) as { DesktopAdapterVersion?: unknown; DataDirectory?: unknown; OwnerSid?: unknown };
      if (metadata.DesktopAdapterVersion !== 1 || typeof metadata.OwnerSid !== 'string' || !/^S-1-/u.test(metadata.OwnerSid)) throw new CodexShimError('Не подтверждён владелец установленного адаптера Desktop.');
      if (typeof metadata.DataDirectory !== 'string' || path.resolve(metadata.DataDirectory).toLowerCase() !== path.resolve(config.directory).toLowerCase()) throw new CodexShimError('Адаптер Desktop относится к другому экземпляру Rele.');
      wrapper.unshift(snapshot);
    }
    const cli = await Promise.all(wrapper.map(file => fileExists(file)));
    const shim = wrapper.find((_, index) => cli[index]);
    if (!shim) throw new CodexShimError('Адаптер Desktop не установлен. Переустановите Rele.');
    await ensureSharedCodex(config.config.codex, { env });
    const desktopEnv = { ...env };
    for (const key of Object.keys(desktopEnv)) if (['CODEX_CLI_PATH', 'CODEX_APP_SERVER_FORCE_CLI'].includes(key.toUpperCase())) delete desktopEnv[key];
    desktopEnv.CODEX_CLI_PATH = shim; desktopEnv.CODEX_APP_SERVER_FORCE_CLI = '1';
    const desktop = spawn(executable, args.slice(1), { env: desktopEnv, cwd: path.dirname(executable), stdio: 'ignore', detached: true, windowsHide: false });
    await once(desktop, 'spawn'); desktop.unref();
    return;
  }
  let target = config.config.codex;
  if (mode !== 'passthrough') target = { ...await ensureSharedCodex(target, { env }), transport: 'shared' };
  const launch = await resolveCodexLaunch(mode === 'passthrough' && target.executable === 'codex' ? await resolveSharedCodexExecutable(target, { env }) : target.executable, { env });
  if (mode === 'daemon') return;
  if (mode !== 'stdio') {
    const childArgs = mode === 'interactive' ? ['--remote', `unix://${target.endpoint}`, ...args.slice(1)] : args;
    const child = spawn(launch.command, [...launch.args, ...childArgs], { env, stdio: 'inherit', windowsHide: true });
    child.once('error', () => { process.stderr.write('Rele: не удалось запустить Codex CLI.\n'); process.exitCode = 1; });
    const [code] = await once(child, 'exit') as [number | null];
    process.exitCode = code ?? 1;
    return;
  }
  const proxy = spawn(launch.command, [...launch.args, 'app-server', 'proxy', '--sock', target.endpoint], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  proxy.stderr.resume(); // Native diagnostics can contain paths or request details; do not copy them to Desktop.
  const stream = Duplex.from({ readable: proxy.stdout, writable: proxy.stdin });
  const socket = new WebSocket('ws://localhost/', { createConnection: () => stream as Socket, handshakeTimeout: 10_000, maxPayload: MAX_FRAME_BYTES, followRedirects: false });
  socket.on('error', () => {});
  proxy.once('error', () => socket.terminate());
  proxy.once('exit', () => socket.terminate());
  const stop = () => { socket.terminate(); proxy.kill(); };
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
