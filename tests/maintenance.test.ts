import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { backupForUpdate, runMaintenance } from '../src/server/maintenance.js';

const project = fileURLToPath(new URL('../', import.meta.url)), directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'rele-maintenance-'));
  directories.push(directory);
  const data = path.join(directory, 'data'); await mkdir(data);
  const protectedSettings = Buffer.from(JSON.stringify({ version: 1, encoding: 'dpapi', value: 'synthetic-protected-bytes-not-for-decryption' }));
  await writeFile(path.join(data, 'config.json'), protectedSettings);
  const writer = new DatabaseSync(path.join(data, 'rele.sqlite'));
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=1; CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('committed WAL record');");
  return { directory, data, writer, protectedSettings };
}

describe('installer maintenance independent of a broken installed application', () => {
  it('backs up committed WAL pages and exact protected settings without migrating the source database', async () => {
    const f = await fixture();
    try {
      const target = await backupForUpdate(f.data, '0.1.0-rc.25');
      expect(await readFile(path.join(target, 'config.json'))).toEqual(f.protectedSettings);
      expect(f.writer.prepare('PRAGMA user_version').get()!.user_version).toBe(1);
      const saved = new DatabaseSync(path.join(target, 'rele.sqlite'), { readOnly: true });
      try {
        expect(saved.prepare('SELECT value FROM example').get()!.value).toBe('committed WAL record');
        expect(saved.prepare('PRAGMA user_version').get()!.user_version).toBe(1);
      } finally { saved.close(); }
      expect(JSON.parse(await readFile(path.join(target, 'backup.json'), 'utf8'))).toMatchObject({ version: '0.1.0-rc.25' });
      const existing = path.join(f.data, 'existing-backup'); await mkdir(existing); await writeFile(path.join(existing, 'keep'), 'retained');
      await expect(backupForUpdate(f.data, '0.1.0-rc.25', existing)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(path.join(existing, 'keep'), 'utf8')).toBe('retained');
    } finally { f.writer.close(); }
  });

  it('runs the extracted three-module candidate with no installed main, Engine, Store or dependencies', async () => {
    const f = await fixture();
    try {
      const temporary = path.join(f.directory, 'inno-temp'); await mkdir(temporary);
      for (const name of ['maintenance', 'config', 'lifecycle']) {
        const source = await readFile(path.join(project, 'src/server', name + '.ts'), 'utf8');
        const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
        const imports = [...emitted.matchAll(/\bfrom\s*['"]([^'"]+)['"]/gu)].map(match => match[1]);
        expect(imports.every(value => value.startsWith('node:') || ['./config.js', './lifecycle.js'].includes(value))).toBe(true);
        await writeFile(path.join(temporary, name + '.js'), emitted);
      }
      await writeFile(path.join(temporary, 'package.json'), JSON.stringify({ type: 'module', version: '0.1.0-rc.25' }));
      const env: NodeJS.ProcessEnv = { ...process.env, RELE_DATA_DIR: f.data }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
      const child = spawnSync(process.execPath, [path.join(temporary, 'maintenance.js'), 'backup'], { cwd: temporary, env, encoding: 'utf8', timeout: 15_000 });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toBe('');
      expect(child.stderr).not.toContain('synthetic-protected');
      expect((await readdir(temporary)).sort()).toEqual(['config.js', 'lifecycle.js', 'maintenance.js', 'package.json']);
      const snapshots = await readdir(path.join(f.data, 'backups')); expect(snapshots).toHaveLength(1);
      expect(await readFile(path.join(f.data, 'backups', snapshots[0], 'config.json'))).toEqual(f.protectedSettings);
    } finally { f.writer.close(); }
  });

  it('fails closed on a missing profile and does not create a configuration or empty database', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'rele-maintenance-missing-')); directories.push(directory);
    const missing = path.join(directory, 'absent');
    await expect(runMaintenance('stop', missing, '0.1.0-rc.25')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(runMaintenance('backup', missing, '0.1.0-rc.25')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await stat(missing).catch(() => null)).toBeNull();
    expect(await readdir(directory)).toEqual([]);
  });

  it('removes only its freshly created partial snapshot if the source database is corrupt', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'rele-maintenance-corrupt-')); directories.push(directory);
    await writeFile(path.join(directory, 'config.json'), 'protected settings retained');
    await writeFile(path.join(directory, 'rele.sqlite'), 'not a SQLite database');
    const target = path.join(directory, 'new-snapshot'), existing = path.join(directory, 'existing-snapshot');
    await mkdir(existing); await writeFile(path.join(existing, 'keep'), 'existing backup retained');
    await expect(backupForUpdate(directory, '0.1.0-rc.25', target)).rejects.toThrow();
    expect(await stat(target).catch(() => null)).toBeNull();
    expect(await readFile(path.join(existing, 'keep'), 'utf8')).toBe('existing backup retained');
    expect(await readFile(path.join(directory, 'rele.sqlite'), 'utf8')).toBe('not a SQLite database');
    expect(await readFile(path.join(directory, 'config.json'), 'utf8')).toBe('protected settings retained');
  });

  it('wires the candidate closure and skips identical Node before the forced wildcard copy', async () => {
    const script = await readFile(path.join(project, 'scripts/windows/rele.iss'), 'utf8');
    const files = script.slice(script.indexOf('[Files]'), script.indexOf('[Icons]'));
    const explicit = files.split('\n').find(line => line.includes('DestDir: "{app}\\runtime"'))!;
    expect(explicit).toContain('Check: RuntimeNeedsCopy; BeforeInstall: CheckRuntimeCanReplace');
    const wildcard = files.split('\n').find(line => line.includes('Source: "{#StageDir}\\*"'))!;
    expect(wildcard).toContain('Excludes: "runtime\\node.exe,');
    expect(files.indexOf(explicit)).toBeLessThan(files.indexOf(wildcard));
    for (const name of ['maintenance.js', 'config.js', 'lifecycle.js', 'package.json', 'manifest.json']) expect(files).toContain(name + '"; Flags: dontcopy');
    expect(script).toContain('GetSHA256OfFile(Current) <> GetSHA256OfFile(Candidate)');
    const launcher = await readFile(path.join(project, 'scripts/windows/Rele.cs'), 'utf8');
    const prepare = launcher.slice(launcher.indexOf('if (command == "prepare-update" || command == "check-runtime")'), launcher.indexOf('if (command == "install")'));
    expect(prepare.indexOf('CheckRuntimeReplacement();')).toBeLessThan(prepare.indexOf('Stop(true, true);'));
    expect(prepare).toContain('Backup(true)');
  });
});
