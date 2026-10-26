import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConfigStore } from './config.js';

interface Instance { pid: number; address: string; version: string }

class InvalidInstanceError extends Error {
  constructor() { super('Некорректный локальный адрес Rele в instance.json. Перезапустите Rele.'); }
}

async function instance(config: Pick<ConfigStore, 'directory'>): Promise<Instance | null> {
  let source: string;
  try { source = await readFile(path.join(config.directory, 'instance.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const value = JSON.parse(source) as Instance;
    const address = new URL(value.address);
    // Node process.kill accepts a signed 32-bit PID; larger JSON integers are not process identities.
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 0x7fffffff || typeof value.version !== 'string' ||
      address.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(address.hostname) ||
      address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new Error();
    return { pid: value.pid, version: value.version, address: address.origin };
  } catch { throw new InvalidInstanceError(); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

interface InstanceDiagnostics {
  marker: 'absent' | 'valid' | 'invalid' | 'unreadable';
  pid?: number;
  processAlive?: boolean;
  health: 'not-checked' | 'responding' | 'mismatch' | 'unavailable';
  httpStatus?: number;
  versionMatch?: boolean;
}

/** Public health is a limited observation, never authenticated ownership or model readiness. */
export async function instanceDiagnostics(directory: string, version: string): Promise<InstanceDiagnostics> {
  let current: Instance | null;
  try { current = await instance({ directory }); }
  catch (error) { return { marker: error instanceof InvalidInstanceError ? 'invalid' : 'unreadable', health: 'not-checked' }; }
  if (!current) return { marker: 'absent', health: 'not-checked' };
  const report: InstanceDiagnostics = { marker: 'valid', pid: current.pid, processAlive: alive(current.pid), health: 'not-checked' };
  if (!report.processAlive) return report;
  try {
    const response = await fetch(new URL('/api/health', current.address), {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(1500),
    });
    report.httpStatus = response.status;
    if (!response.ok) { report.health = 'unavailable'; return report; }
    const health = await response.json().catch(() => null) as { ok?: unknown; version?: unknown } | null;
    report.versionMatch = health?.ok === true && health.version === current.version && current.version === version;
    report.health = report.versionMatch ? 'responding' : 'mismatch';
  } catch { report.health = 'unavailable'; }
  return report;
}

async function request(config: ConfigStore, current: Instance, endpoint: string, method = 'GET'): Promise<Response> {
  return fetch(new URL(endpoint, current.address), {
    method, headers: { authorization: `Bearer ${config.panelToken}` },
    redirect: 'error', signal: AbortSignal.timeout(1500),
  });
}

async function verify(config: ConfigStore, current: Instance): Promise<boolean> {
  if (!alive(current.pid)) return false;
  let response: Response;
  try { response = await request(config, current, '/api/instance'); }
  catch { return false; }
  if (response.status === 404) throw new Error('Старая версия Rele ещё работает. Завершите её запуск (Ctrl+C) и откройте Rele заново.');
  if (!response.ok) throw new Error('Запущенный Rele не подтверждает ключ этого каталога данных. Остановка другого процесса запрещена.');
  const remote = await response.json() as Partial<Instance>;
  if (remote.pid !== current.pid || remote.version !== current.version) throw new Error('Запущенный процесс не совпадает с локальной записью Rele. Перезапустите приложение.');
  return true;
}

async function runningInstance(config: ConfigStore, wait: boolean): Promise<Instance> {
  const deadline = Date.now() + (wait ? 15_000 : 0);
  let current: Instance | null = null;
  do {
    current = await instance(config);
    if (current && await verify(config, current)) break;
    current = null;
    if (wait) await delay(200);
  } while (Date.now() < deadline);
  if (!current) throw new Error('Фоновый Rele не запущен. Запустите приложение через ярлык Rele или службу rele.');
  return current;
}

export class MessageToolAcknowledgementError extends Error {
  constructor() { super('Rele не подтвердил результат операции.'); }
}

/** One authenticated call to the verified local instance; mutating calls are never retried. */
export async function callLocalMessageTool(config: ConfigStore, body: unknown): Promise<unknown> {
  const current = await runningInstance(config, false);
  let response: Response;
  try {
    response = await fetch(new URL('/api/tools/call', current.address), {
      method: 'POST', headers: { authorization: `Bearer ${config.panelToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new MessageToolAcknowledgementError(); }
  if (response.status >= 400 && response.status < 500) throw new Error('Rele отклонил вызов: проверьте параметры и доступ к выбранному источнику.');
  if (!response.ok) throw new MessageToolAcknowledgementError();
  try {
    const source = await response.text();
    if (source.length > 256_000) throw new Error();
    return JSON.parse(source) as unknown;
  } catch { throw new MessageToolAcknowledgementError(); }
}

export async function serverStatus(config: ConfigStore, wait: boolean): Promise<void> {
  const current = await runningInstance(config, wait);
  process.stdout.write(JSON.stringify({ running: true, ...current }) + '\n');
}

export async function openPanel(config: ConfigStore, printUrl: boolean): Promise<void> {
  const current = await runningInstance(config, true);
  const response = await request(config, current, '/api/session/launch-token', 'POST');
  if (!response.ok) throw new Error('Не удалось создать ссылку для открытия панели. Перезапустите Rele.');
  const body = await response.json() as { token?: unknown };
  if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(body.token)) throw new Error('Rele вернул некорректную ссылку входа.');
  const url = `${current.address}/#rele-launch=${body.token}`;
  if (printUrl) { process.stdout.write(`${url}\n`); return; }
  const program = process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const browser = spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: true });
    browser.once('error', () => reject(new Error('Не удалось открыть браузер. Используйте rele open --print-url.')));
    browser.once('spawn', () => { browser.unref(); resolve(); });
  });
}

export async function stopServer(config: ConfigStore): Promise<void> {
  const current = await instance(config);
  if (!current || !alive(current.pid)) return;
  if (!await verify(config, current)) throw new Error('Фоновый Rele не отвечает. Повторите остановку через службу или ярлык Rele.');
  const response = await request(config, current, '/api/shutdown', 'POST');
  if (!response.ok) throw new Error('Фоновый Rele не подтвердил остановку.');
  const deadline = Date.now() + 30_000;
  while (alive(current.pid) && Date.now() < deadline) await delay(100);
  if (alive(current.pid)) throw new Error('Rele не завершился за 30 секунд. Обновление отменено; файлы программы нельзя заменять.');
}
