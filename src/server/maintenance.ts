/** Installer-only entry: its extracted closure is this file, config and lifecycle. */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { ConfigStore, defaultDataDirectory } from './config.js';
import { stopServer } from './lifecycle.js';

export async function backupForUpdate(directory: string, version: string, destination?: string): Promise<string> {
  const database = path.join(directory, 'rele.sqlite'), config = path.join(directory, 'config.json');
  // Read the original protected bytes, without decrypting or rewriting settings.
  const settings = await readFile(config);
  if (!(await stat(database)).isFile()) throw new Error('Rele database is missing');
  const target = destination ?? path.join(directory, 'backups', `update-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomBytes(6).toString('hex')}`);
  if (!path.isAbsolute(target) || path.resolve(target) === path.resolve(directory)) throw new Error('Invalid backup directory');
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o700 }); // Existing backups are never overwritten.
  try {
    // Opening Store would run candidate schema migrations before the backup.
    // SQLite's read-only backup also includes committed pages still in the WAL.
    const db = new DatabaseSync(database, { readOnly: true });
    try { await backup(db, path.join(target, 'rele.sqlite')); }
    finally { db.close(); }
    await chmod(path.join(target, 'rele.sqlite'), 0o600);
    await writeFile(path.join(target, 'config.json'), settings, { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(target, 'backup.json'), JSON.stringify({ version, createdAt: new Date().toISOString(), platform: process.platform,
      note: 'Stop Rele before restore. DPAPI secrets require the same Windows user and machine.' }, null, 2), { mode: 0o600, flag: 'wx' });
    return target;
  } catch (error) {
    // Only this operation's successfully created directory is eligible for cleanup.
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function runMaintenance(command: string, directory: string, version: string): Promise<void> {
  if (!path.isAbsolute(directory) || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u.test(version)) throw new Error('Invalid maintenance context');
  if (command === 'stop') {
    const config = new ConfigStore(directory);
    await config.loadExisting(); // Never create or repair a damaged/missing profile.
    await stopServer(config); // Authenticated gateway shutdown, not Codex/MCP termination.
  } else if (command === 'backup') await backupForUpdate(directory, version);
  else throw new Error('Unknown maintenance command');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error('Invalid maintenance arguments');
    // Inno extracts the candidate ESM package next to this entry in its private
    // temporary directory. No installed main/Engine or node_modules is loaded.
    const metadata = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
    await runMaintenance(process.argv[2], defaultDataDirectory(), metadata.version);
  } catch {
    process.stderr.write('Подготовка обновления Rele не завершена. Файлы программы не следует заменять.\n');
    process.exitCode = 1;
  }
}
