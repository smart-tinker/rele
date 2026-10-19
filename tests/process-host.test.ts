import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const helper = fileURLToPath(new URL('../dist/native/Rele.Process.exe', import.meta.url));
const windowsTest = test.skipIf(process.platform !== 'win32');

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function startHost(directory: string, source: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const script = path.join(directory, 'root with spaces.cjs');
  await writeFile(script, source);
  const child = spawn(helper, ['--', process.execPath, script, ...args], {
    cwd: directory, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const errors: string[] = [];
  const ownedPids = new Set<number>();
  if (child.pid) ownedPids.add(child.pid);
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.on('error', error => errors.push(error.message));
  child.stdin.on('error', error => errors.push(error.message));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const messages = () => {
    const result: Array<Record<string, unknown>> = [];
    for (const line of Buffer.concat(stdout).toString('utf8').split('\n').slice(0, -1)) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (!['root', 'grandchild-started', 'grandchild-ready', 'metadata'].includes(String(value.kind))) continue;
        const pid = value.pid;
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
        ownedPids.add(pid);
        result.push(value);
      } catch { /* Binary echo after the metadata is deliberately not JSON. */ }
    }
    return result;
  };
  return {
    child, closed, ownedPids, messages,
    stdout: () => Buffer.concat(stdout),
    stderr: () => Buffer.concat(stderr),
    diagnostic: () => errors.join('\n') || Buffer.concat(stderr).toString('utf8'),
  };
}

type Host = Awaited<ReturnType<typeof startHost>>;

async function cleanup(host: Host | undefined, directory: string): Promise<void> {
  const stop = async () => {
    if (!host) return;
    host.messages();
    // Only the helper we spawned and IDs reported by our own fixtures can be killed.
    for (const pid of [...host.ownedPids].reverse()) {
      if (!isRunning(pid)) continue;
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await bounded(host.closed, 15000, 'The fixture pipes did not close during emergency cleanup');
    await expect.poll(() => [...host.ownedPids].some(isRunning), { timeout: 2000, interval: 20 }).toBe(false);
  };
  try { await bounded(stop(), 18000, 'The owned process tree did not finish emergency cleanup'); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

windowsTest('killing only the Windows helper stops its whole job and releases a grandchild file lock', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'Rele process host lock '));
  const lockedFile = path.join(directory, 'FETCH_HEAD');
  const movedFile = path.join(directory, 'FETCH_HEAD released');
  let host: Host | undefined;
  try {
    await writeFile(lockedFile, 'owned fixture content\n');
    // Node's Windows file handles allow delete sharing. FileShare.None proves an actual held-file lock.
    const grandchild = [
      "$ErrorActionPreference = 'Stop'",
      '$file = [System.IO.File]::Open($env:RELE_FIXTURE_LOCK_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)',
      'try {',
      '  [Console]::WriteLine(\'{"kind":"grandchild-ready","pid":\' + $PID + \'}\')',
      '  [Console]::Out.Flush()',
      '  Start-Sleep -Seconds 60',
      '} finally { $file.Dispose() }',
    ].join('\n');
    host = await startHost(directory, [
      "const { spawn } = require('node:child_process');",
      "const report = value => process.stdout.write(JSON.stringify(value) + '\\n');",
      "report({ kind: 'root', pid: process.pid });",
      "const child = spawn(process.env.RELE_FIXTURE_POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', process.env.RELE_FIXTURE_COMMAND], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });",
      "child.once('spawn', () => report({ kind: 'grandchild-started', pid: child.pid }));",
      "child.once('error', error => { process.stderr.write(error.message); process.exit(91); });",
      'process.stdin.resume();',
      'setTimeout(() => process.exit(90), 60000).unref();',
    ].join('\n'), [], {
      RELE_FIXTURE_LOCK_FILE: lockedFile,
      RELE_FIXTURE_POWERSHELL: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      RELE_FIXTURE_COMMAND: Buffer.from(grandchild, 'utf16le').toString('base64'),
    });
    const running = host;
    await expect.poll(
      () => running.messages().some(message => message.kind === 'grandchild-ready') ? 'ready' : running.diagnostic(),
      { timeout: 8000, interval: 20 },
    ).toBe('ready');
    const messages = host.messages();
    expect(messages.find(message => message.kind === 'grandchild-ready')?.pid)
      .toBe(messages.find(message => message.kind === 'grandchild-started')?.pid);
    expect(host.ownedPids.size).toBe(3);
    expect([...host.ownedPids].every(isRunning)).toBe(true);
    await expect(rename(lockedFile, movedFile)).rejects.toMatchObject({
      code: expect.stringMatching(/^(EPERM|EACCES|EBUSY)$/u),
    });

    // Keep stdin open and kill no child here: only closing the helper's Job handle can do the cleanup.
    expect(host.child.kill('SIGKILL')).toBe(true);
    await bounded(host.closed, 16000, 'Killing the helper left an inherited output pipe open');
    await expect.poll(() => [...running.ownedPids].some(isRunning), { timeout: 2000, interval: 20 }).toBe(false);
    await rename(lockedFile, movedFile);
    expect(await readFile(movedFile, 'utf8')).toBe('owned fixture content\n');
  } finally { await cleanup(host, directory); }
}, 45000);

windowsTest('the Windows helper preserves argv, environment, cwd and raw input/output bytes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'Rele process host bytes '));
  const args = ['', 'two words', 'a"quoted"value', 'C:\\space folder\\', '\\\\server\\share\\', 'slashes\\\\\\"quote', 'Кодекс 🙂'];
  const value = 'профиль "with spaces" C:\\Codex home\\ 🙂';
  const payload = Buffer.concat([
    Buffer.from('Ж🙂 начало\r\n', 'utf8'),
    Buffer.alloc(70000, 0x5c),
    Buffer.from([0, 0xff, 0xfe, 0x80, 13, 10]),
    Buffer.from('конец "bytes"\n', 'utf8'),
  ]);
  let host: Host | undefined;
  try {
    host = await startHost(directory, [
      "process.stdout.write(JSON.stringify({ kind: 'metadata', pid: process.pid, argv: process.argv.slice(2), value: process.env.RELE_FIXTURE_VALUE, cwd: process.cwd() }) + '\\n');",
      "process.stdin.on('data', chunk => { process.stdout.write(chunk); process.stderr.write(chunk); });",
      'setTimeout(() => process.exit(90), 60000).unref();',
    ].join('\n'), args, { RELE_FIXTURE_VALUE: value });
    const running = host;
    await expect.poll(
      () => running.messages().some(message => message.kind === 'metadata') ? 'ready' : running.diagnostic(),
      { timeout: 8000, interval: 20 },
    ).toBe('ready');
    expect(host.messages().find(message => message.kind === 'metadata')).toMatchObject({ argv: args, value, cwd: directory });
    expect(host.ownedPids.size).toBe(2);
    const headerLength = host.stdout().indexOf(0x0a) + 1;
    host.child.stdin.write(payload.subarray(0, 1));
    host.child.stdin.write(payload.subarray(1, 65539));
    host.child.stdin.write(payload.subarray(65539));
    await expect.poll(
      () => [running.stdout().length - headerLength, running.stderr().length],
      { timeout: 8000, interval: 20 },
    ).toEqual([payload.length, payload.length]);
    expect(host.stdout().subarray(headerLength).equals(payload)).toBe(true);
    expect(host.stderr().equals(payload)).toBe(true);

    // EOF requests shutdown, so only send it after both echoed streams have arrived.
    host.child.stdin.end();
    expect(await bounded(host.closed, 16000, 'The helper did not close after input EOF')).toEqual({ code: 0, signal: null });
    await expect.poll(() => [...running.ownedPids].some(isRunning), { timeout: 2000, interval: 20 }).toBe(false);
  } finally { await cleanup(host, directory); }
}, 55000);
