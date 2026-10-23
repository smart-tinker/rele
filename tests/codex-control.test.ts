import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it, type TestContext } from 'vitest';

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('../dist/native/Rele.Process.exe', import.meta.url));
const aclFixture = fileURLToPath(new URL('./fixtures/codex-control.ps1', import.meta.url));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const directories: string[] = [];
const shellArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', aclFixture];
type Descriptor = { ownerMatches: boolean; private: boolean; protected: boolean; descriptorSha256: string };

async function acl(action: 'Identity' | 'Private' | 'Legacy' | 'Inspect', root?: string, directory?: string): Promise<string> {
  const result = await execute(powershell, [...shellArgs, '-Action', action, ...(root && directory ? ['-Root', root, '-Directory', directory] : [])], {
    windowsHide: true, timeout: 5_000, maxBuffer: 8192, encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  return result.stdout;
}

async function fixture(kind: 'legacy' | 'private' | 'missing' = 'legacy') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'Rele codex control ')));
  directories.push(root);
  const home = path.join(root, 'profile with spaces');
  await mkdir(home);
  const control = path.join(home, 'app-server-control');
  if (kind !== 'missing') {
    await mkdir(control);
    expect(await acl(kind === 'private' ? 'Private' : 'Legacy', root, control)).toBe('owned-acl-ready');
  }
  const calls = path.join(root, 'query-calls.jsonl');
  const query = path.join(root, 'synthetic native query.cjs');
  await writeFile(query, [
    "const fs = require('node:fs'); const path = require('node:path');",
    "const args = process.argv.slice(2); const home = process.env.CODEX_HOME;",
    "if (JSON.stringify(args) !== JSON.stringify(['app-server', 'daemon', 'version'])) process.exit(91);",
    "fs.appendFileSync(process.env.RELE_FIXTURE_QUERY_CALLS, JSON.stringify({ pid: process.pid, args, homeMatches: home === process.env.RELE_FIXTURE_QUERY_HOME }) + '\\n');",
    "const mode = process.env.RELE_FIXTURE_QUERY_RESULT;",
    "if (mode === 'ready') process.stdout.write('{\"status\":\"running\"}');",
    "else if (mode === 'hang') setInterval(() => {}, 1000);",
    "else { process.stderr.write(mode === 'denied' ? 'synthetic-secret: access denied (os error 5)' : mode === 'malformed' ? 'synthetic-secret: unrelated error (os error 2)' : 'Error: failed to connect to ' + path.join(home, 'app-server-control', 'app-server-control.sock') + ': synthetic refusal (os error ' + mode + ')'); process.exitCode = 1; }",
  ].join('\n'));
  return { root, home, control, calls, query };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function invoke(f: Fixture, result = '2') {
  const options = {
    env: { ...process.env, CODEX_HOME: path.join(f.root, 'unselected synthetic profile'), RELE_FIXTURE_QUERY_HOME: f.home, RELE_FIXTURE_QUERY_CALLS: f.calls, RELE_FIXTURE_QUERY_RESULT: result },
    windowsHide: true, timeout: 8_000, maxBuffer: 8192, encoding: 'utf8' as const,
  };
  try {
    const response = await execute(helper, ['--repair-codex-control', f.home, '--', process.execPath, f.query], options);
    return { code: 0, ...response };
  } catch (error) {
    const failure = error as Error & { code?: unknown; stdout: string; stderr: string; killed?: boolean };
    // A helper deadline is a failure of the test, never a passing migration refusal.
    if (typeof failure.code !== 'number' || failure.killed) throw error;
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}
async function descriptor(f: Fixture, directory = f.control): Promise<Descriptor> { return JSON.parse(await acl('Inspect', f.root, directory)) as Descriptor; }
async function nativeCalls(f: Fixture): Promise<Array<{ pid: number; homeMatches: boolean; args: string[] }>> {
  try { return (await readFile(f.calls, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function backups(f: Fixture): Promise<string[]> { return (await readdir(f.home)).filter(name => name.startsWith('app-server-control.rele-backup-')); }
async function unchanged(f: Fixture, before: Descriptor) {
  expect(await descriptor(f)).toEqual(before);
  expect(await backups(f)).toEqual([]);
  expect((await readdir(f.home)).filter(name => name.startsWith('.rele-codex-control-'))).toEqual([]);
}
function refused(result: Awaited<ReturnType<typeof invoke>>, reason: string | RegExp) {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim()).toMatch(typeof reason === 'string' ? new RegExp(`^Rele Codex control: ${reason}$`, 'u') : reason);
  expect(result.stderr).not.toContain('synthetic-secret');
}

describe.skipIf(process.platform !== 'win32')('native Windows control directory migration', () => {
  let elevated = false;
  beforeAll(async () => { elevated = (JSON.parse(await acl('Identity')) as { elevated: boolean }).elevated; });
  function nonAdmin(context: TestContext) {
    // Production rejects elevated tokens; real migration acceptance runs under the owning filtered user.
    if (elevated) context.skip('Requires a nonadmin Windows token; the production helper intentionally refuses elevation.');
  }
  afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it.for(['2', '10061'])('preserves the legacy inode contents/descriptor in backup after confirmed os error %s', async (code, context) => {
    nonAdmin(context);
    const f = await fixture();
    const files = { 'app-server-control.sock': 'synthetic-stale-marker', 'app-server-startup.lock': 'synthetic-lock', 'app-server.log': 'synthetic-history-free-log' };
    for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(f.control, name), bytes);
    const before = await descriptor(f);
    expect(before.ownerMatches).toBe(true); expect(before.private).toBe(false);
    expect(await invoke(f, code)).toEqual({ code: 0, stdout: '{"status":"migrated"}\r\n', stderr: '' });
    expect(await descriptor(f)).toMatchObject({ ownerMatches: true, private: true, protected: true });
    expect(await readdir(f.control)).toEqual([]);
    const names = await backups(f); expect(names).toHaveLength(1);
    const backup = path.join(f.home, names[0]);
    expect(await descriptor(f, backup)).toEqual(before);
    for (const [name, bytes] of Object.entries(files)) expect(await readFile(path.join(backup, name), 'utf8')).toBe(bytes);
    expect(await nativeCalls(f)).toMatchObject([{ args: ['app-server', 'daemon', 'version'], homeMatches: true }]);
    expect(await invoke(f)).toEqual({ code: 0, stdout: '{"status":"unchanged"}\r\n', stderr: '' });
    expect(await nativeCalls(f)).toHaveLength(1);
    expect(await backups(f)).toEqual(names);
  });

  it.for(['private', 'missing'] as const)('leaves %s control unchanged without a native query', async (kind, context) => {
    nonAdmin(context);
    const f = await fixture(kind);
    const before = kind === 'private' ? await descriptor(f) : undefined;
    expect(await invoke(f)).toEqual({ code: 0, stdout: '{"status":"unchanged"}\r\n', stderr: '' });
    expect(await nativeCalls(f)).toEqual([]);
    expect(await backups(f)).toEqual([]);
    if (before) await unchanged(f, before);
    else expect(await readdir(f.home)).toEqual([]);
  });

  it('preserves an unsafe directory if the locked fresh native query reports running', async context => {
    nonAdmin(context);
    const f = await fixture(), before = await descriptor(f);
    expect(await invoke(f, 'ready')).toEqual({ code: 0, stdout: '{"status":"unchanged"}\r\n', stderr: '' });
    await unchanged(f, before);
    expect(await nativeCalls(f)).toHaveLength(1);
  });

  it('rejects unknown entries before probing or moving the old namespace', async context => {
    nonAdmin(context);
    const f = await fixture(), before = await descriptor(f);
    await writeFile(path.join(f.control, 'unrelated-user-file'), 'preserve-this-owned-fixture');
    refused(await invoke(f), 'unknown-control-entry');
    await unchanged(f, before);
    expect(await readFile(path.join(f.control, 'unrelated-user-file'), 'utf8')).toBe('preserve-this-owned-fixture');
    expect(await nativeCalls(f)).toEqual([]);
  });

  it('rejects a known-name child junction without following or changing its target', async context => {
    nonAdmin(context);
    const f = await fixture(), before = await descriptor(f);
    const target = path.join(f.root, 'owned junction target'); await mkdir(target);
    await writeFile(path.join(target, 'preserved'), 'owned-junction-target');
    await symlink(target, path.join(f.control, 'app-server-control.sock'), 'junction');
    refused(await invoke(f), /^Rele Codex control: (?:unsafe-control-entry|path-open-failed)$/u);
    await unchanged(f, before);
    expect(await readFile(path.join(target, 'preserved'), 'utf8')).toBe('owned-junction-target');
    expect(await nativeCalls(f)).toEqual([]);
  });

  it('rejects a redirected control directory while preserving the owned target', async context => {
    nonAdmin(context);
    const f = await fixture('missing');
    const target = path.join(f.root, 'owned control target'); await mkdir(target);
    expect(await acl('Legacy', f.root, target)).toBe('owned-acl-ready');
    const before = await descriptor(f, target);
    await symlink(target, f.control, 'junction');
    refused(await invoke(f), 'unsafe-directory');
    expect(await descriptor(f, target)).toEqual(before);
    expect(await readdir(target)).toEqual([]);
    expect(await backups(f)).toEqual([]);
    expect(await nativeCalls(f)).toEqual([]);
  });

  it.for(['denied', 'malformed'])('preserves old bytes and ACL after an unconfirmed %s probe', async (mode, context) => {
    nonAdmin(context);
    const f = await fixture();
    await writeFile(path.join(f.control, 'app-server.log'), 'preserved-synthetic-log');
    const before = await descriptor(f);
    refused(await invoke(f, mode), 'native-probe-unconfirmed');
    await unchanged(f, before);
    expect(await readFile(path.join(f.control, 'app-server.log'), 'utf8')).toBe('preserved-synthetic-log');
    expect(await nativeCalls(f)).toHaveLength(1);
  });

  it('refuses a held native first-byte operation lock without probing or moving the directory', async context => {
    nonAdmin(context);
    const f = await fixture(), before = await descriptor(f);
    const state = path.join(f.home, 'app-server-daemon'); await mkdir(state);
    expect(await acl('Private', f.root, state)).toBe('owned-acl-ready');
    const child = spawn(powershell, [...shellArgs, '-Action', 'HoldLock', '-Root', f.root, '-Directory', state], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', errors = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    child.stdin.on('error', () => {}); // Early fixture failure is reported by its own close/exit receipt.
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; if (output.includes('operation-lock-held\r\n')) resolve(); });
          void closed.then(() => reject(new Error('Owned lock fixture exited before ready')), reject);
        }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Owned lock fixture readiness timed out')), 5_000); }),
      ]);
      refused(await invoke(f), 'operation-lock-unavailable');
      await unchanged(f, before);
      expect(await nativeCalls(f)).toEqual([]);
    } finally {
      clearTimeout(timer);
      child.stdin.end('\n');
      const cleanup = setTimeout(() => child.kill(), 2_000);
      try { expect(await closed).toBe(0); expect(errors).toBe(''); }
      finally { clearTimeout(cleanup); }
    }
  });

  it('bounds a hung native query, stops its own query process and leaves old data untouched', async context => {
    nonAdmin(context);
    const f = await fixture();
    await writeFile(path.join(f.control, 'app-server.log'), 'preserve-on-timeout');
    const before = await descriptor(f);
    const started = performance.now();
    refused(await invoke(f, 'hang'), 'native-probe-timeout');
    expect(performance.now() - started).toBeLessThan(8_000);
    await unchanged(f, before);
    expect(await readFile(path.join(f.control, 'app-server.log'), 'utf8')).toBe('preserve-on-timeout');
    const calls = await nativeCalls(f); expect(calls).toHaveLength(1);
    await expect.poll(() => {
      try { process.kill(calls[0].pid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
    }, { timeout: 1_000, interval: 20 }).toBe(false);
  });
});
