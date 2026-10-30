import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { ConfigStore, isLocalCodexHome, mergeConfig } from './config.js';
import { codexEnvironment } from './codex-launch.js';
import { effectiveSharedCodexHome } from './codex-shared.js';
import { acquireGatewayLock } from './gateway-lock.js';
import type { CodexConnectionTarget } from '../shared/types.js';

function sameHome(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function requireUnusedEndpoint(endpoint: string): Promise<void> {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Прежний сервер Codex требует ручной проверки; настройки сохранены.'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Явно выбранный сервер Codex сохранён. Автоматическое подключение Desktop требует локального общего Codex.');
  }
  const hosts = url.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [url.hostname.replace(/^\[|\]$/gu, '')];
  await Promise.all(hosts.map(host => new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port: Number(url.port || 80) });
    const fail = () => { socket.destroy(); reject(new Error('Прежний локальный сервер Codex работает или его состояние не подтверждено. Он не остановлен; настройки сохранены.')); };
    socket.setTimeout(1500, fail);
    socket.once('connect', fail);
    socket.once('error', error => {
      socket.destroy();
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(); else fail();
    });
  })));
}

async function requireUnsentQueue(directory: string): Promise<void> {
  const file = path.join(directory, 'rele.sqlite');
  const info = await lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('База Rele требует проверки; автоматическая смена подключения отменена.');
  // Loading SQLite only here keeps native CLI passthrough free of experimental warnings.
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout=500; BEGIN;');
    const version = Number(database.prepare('PRAGMA user_version').get()!.user_version);
    if (database.prepare('PRAGMA application_id').get()!.application_id !== 0x52454c45 || !Number.isSafeInteger(version) || version < 1 || version > 8) throw new Error('Неизвестная версия базы Rele; настройки сохранены.');
    const blocked = database.prepare(`SELECT 1 FROM requests WHERE status IS NULL
      OR status NOT IN ('queued','completed','failed','interrupted','cancelled')
      OR (status='queued' AND (queued_submission_id IS NOT NULL OR turn_id IS NOT NULL)) LIMIT 1`).get()
      || database.prepare("SELECT 1 FROM approvals WHERE status IS NULL OR status NOT IN ('answered','expired') LIMIT 1").get()
      || version >= 4 && database.prepare(`SELECT 1 FROM slack_sync_entries WHERE ${version >= 8 ? 'canonical_entry_id IS NULL AND ' : ''}(state IS NULL OR state NOT IN ('pending','applied')) LIMIT 1`).get()
      || version >= 5 && database.prepare("SELECT 1 FROM auto_link_intents WHERE status IS NULL OR status<>'completed' LIMIT 1").get()
      || version >= 7 && database.prepare("SELECT 1 FROM tool_outbox WHERE status IS NULL OR status NOT IN ('pending','sent','failed','cancelled') LIMIT 1").get();
    if (blocked) throw new Error('В Rele остались активные или неподтверждённые операции Codex. Автоматическая смена подключения отложена; запросы сохранены.');
    if (database.prepare('SELECT cwd FROM conversations').all().some(row => typeof row.cwd !== 'string' || !isLocalCodexHome(row.cwd))) {
      throw new Error('Рабочие папки прежних разговоров относятся к другому компьютеру. Настройки сохранены.');
    }
  } finally { database.close(); }
}

/** Only the selected installer task may migrate an idle legacy local target. */
export async function setupSharedCodex(
  config: ConfigStore,
  verify: (target: CodexConnectionTarget, env: NodeJS.ProcessEnv) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  const lock = await acquireGatewayLock(config.directory);
  try {
    const file = path.join(config.directory, 'config.json');
    const beforeLoad = await readFile(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; });
    await config.load();
    const original = await readFile(file);
    if (beforeLoad && !original.equals(beforeLoad)) throw new Error('Настройки Rele изменились во время чтения. Автоматическая смена отменена.');
    const current = config.config;
    const home = effectiveSharedCodexHome(codexEnvironment(current.codex.codexHome, env));
    if (!sameHome(home, effectiveSharedCodexHome(env))) throw new Error('Профиль установки отличается от сохранённого профиля Codex. Оба профиля сохранены; подключение Desktop отменено.');
    if (current.codex.transport === 'shared') { await verify(current.codex, codexEnvironment(current.codex.codexHome, env)); return; }
    if (current.codex.token) throw new Error('Прежний сервер Codex использует отдельный ключ. Его настройки сохранены; автоматическая смена отменена.');
    if (current.codex.transport === 'websocket') await requireUnusedEndpoint(current.codex.endpoint);
    else if (!['managed', 'proxy'].includes(current.codex.transport) || current.codex.executable !== 'codex' || current.codex.endpoint) {
      throw new Error('Явно выбранное подключение Codex сохранено. Автоматическая смена требует проверки прежнего сервера.');
    }
    await requireUnsentQueue(config.directory);
    if (current.autoLinkRules.some(rule => rule.enabled && !isLocalCodexHome(rule.cwd))) throw new Error('Правила новых разговоров относятся к другому компьютеру. Настройки сохранены.');
    const next = mergeConfig(current, { codex: { transport: 'shared', executable: 'codex', endpoint: '' } });
    if (!(await readFile(file)).equals(original)) throw new Error('Настройки Rele изменились во время проверки. Автоматическая смена отменена.');
    const backup = path.join(config.directory, 'backups', `codex-setup-${randomUUID()}`);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await writeFile(path.join(backup, 'config.json'), original, { flag: 'wx', mode: 0o600, flush: true });
    await config.save(next);
    // Keep the selected policy through a transient startup failure; only verified readiness enables Desktop.
    await verify(next.codex, codexEnvironment(next.codex.codexHome, env));
  } finally { await new Promise<void>(resolve => lock.close(() => resolve())); }
}
