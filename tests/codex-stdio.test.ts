import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { CodexStdioTransport, type CodexStdioError } from '../src/server/codex-stdio.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});

async function fixture(source: string, maxFrameBytes?: number, expectedMessages = 1) {
  const directory = await mkdtemp(path.join(tmpdir(), 'Rele stdio fixture '));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'server.mjs');
  await writeFile(script, source);
  const messages: string[] = [], errors: CodexStdioError[] = [];
  let resolveMessage!: () => void, resolveFailure!: () => void, resolveClosed!: () => void;
  const message = new Promise<void>(resolve => { resolveMessage = resolve; });
  const failure = new Promise<void>(resolve => { resolveFailure = resolve; });
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const transport = new CodexStdioTransport(process.execPath, [script], process.env, {
    message: raw => { messages.push(raw); if (messages.length >= expectedMessages) resolveMessage(); },
    stderr: () => {},
    failure: error => { errors.push(error); resolveFailure(); },
    closed: resolveClosed,
  }, { maxFrameBytes });
  cleanup.push(() => transport.close());
  await transport.ready;
  return { transport, messages, errors, message, failure, closed };
}

describe('owned Codex NDJSON transport', () => {
  it('joins split UTF-8 bytes and separates several frames without WebSocket framing', async () => {
    const f = await fixture(`
      import { writeSync } from 'node:fs';
      process.stdin.resume();
      const data = Buffer.from(JSON.stringify({ text: 'Привет 🌍' }) + '\\n' + JSON.stringify({ next: true }) + '\\r\\n');
      for (const byte of data) writeSync(1, Buffer.from([byte]));
    `, undefined, 2);
    await f.message;
    // The process stays alive, so close confirms that only our own child is stopped.
    await f.transport.close();
    expect(f.errors).toEqual([]);
    expect(f.messages.map(raw => JSON.parse(raw))).toEqual([{ text: 'Привет 🌍' }, { next: true }]);
  });

  it('sends one newline-terminated JSON object per write', async () => {
    const f = await fixture(`
      import { createInterface } from 'node:readline';
      for await (const line of createInterface({ input: process.stdin })) process.stdout.write(line + '\\n');
    `);
    await f.transport.send(JSON.stringify({ id: 'test', params: { text: 'Первая\\nвторая' } }));
    await f.message;
    expect(f.messages).toEqual([JSON.stringify({ id: 'test', params: { text: 'Первая\\nвторая' } })]);
  });

  it.each([
    ['a partial final frame', `process.stdout.write('{"id":1');`, 'invalid-protocol'],
    ['invalid UTF-8', `process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));`, 'invalid-protocol'],
    ['an oversized frame without a newline', `process.stdout.write('x'.repeat(65));`, 'frame-too-large'],
  ])('rejects %s with a bounded safe diagnostic', async (_name, source, code) => {
    const f = await fixture(source, 64);
    await f.failure;
    expect(f.errors).toHaveLength(1);
    expect(f.errors[0]).toMatchObject({ code });
    expect(f.messages).toEqual([]);
    // These fixtures exit naturally after writing their invalid bytes.
    await f.closed;
  });
});

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly pid: number) { super(); }
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode === null && this.signalCode === null) this.exit(code, signal);
    this.emit('close', code, signal);
  }
}

async function windowsFixture(spawned = true) {
  vi.useFakeTimers();
  const helper = new FakeProcess(1234);
  const spawnProcess = vi.fn().mockReturnValue(helper);
  const stdinEnd = vi.spyOn(helper.stdin, 'end');
  const callbacks = { message: vi.fn(), stderr: vi.fn(), failure: vi.fn(), closed: vi.fn() };
  const command = 'C:\\Program Files\\node.exe';
  const args = ['C:\\Local Codex\\codex.mjs', 'app-server', '--listen', 'stdio://', '-c', 'thread_unload_delay_secs=0'];
  const env = { CODEX_HOME: 'C:\\Users\\Fixture User\\.codex', TEST_ENV: 'inherited' };
  const transport = new CodexStdioTransport(command, args, env, callbacks, {
    platform: 'win32', spawnProcess: spawnProcess as unknown as typeof spawn,
  });
  if (spawned) {
    helper.emit('spawn');
    await transport.ready;
  }
  return { helper, spawnProcess, stdinEnd, callbacks, command, args, env, transport };
}

describe('Windows owned Job lifecycle', () => {
  it('launches only the packaged guard with exact command, arguments and environment', async () => {
    const f = await windowsFixture();
    expect(f.spawnProcess).toHaveBeenCalledExactlyOnceWith(
      fileURLToPath(new URL('../dist/native/Rele.Process.exe', import.meta.url)),
      ['--', f.command, ...f.args],
      { stdio: ['pipe', 'pipe', 'pipe'], env: f.env, windowsHide: true, detached: false },
    );
    await f.transport.send('{"id":1}');
    expect(f.helper.stdin.read().toString()).toBe('{"id":1}\n');
    const stopping = f.transport.close();
    f.helper.close();
    await stopping;
    expect(f.spawnProcess).toHaveBeenCalledOnce();
  });

  it('signals EOF once and waits for helper close after exit without an early forced kill', async () => {
    const f = await windowsFixture();
    let resolved = false;
    const stopping = f.transport.close();
    expect(f.transport.close()).toBe(stopping);
    const close = stopping.then(() => { resolved = true; });
    expect(f.stdinEnd).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.helper.kill).not.toHaveBeenCalled();
    expect(resolved).toBe(false);
    f.helper.exit(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(false); // exit alone does not establish closed pipes
    expect(f.callbacks.closed).not.toHaveBeenCalled();
    f.helper.close();
    await close;
    expect(resolved).toBe(true);
    expect(f.callbacks.closed).toHaveBeenCalledOnce();
    expect(f.stdinEnd).toHaveBeenCalledOnce();
    await expect(f.transport.send('{"id":2}')).rejects.toMatchObject({ code: 'connection-closed' });
  });

  it('accepts a guard that already confirmed an empty Job on natural root exit', async () => {
    const f = await windowsFixture();
    f.helper.close(0);
    await f.transport.close();
    expect(f.stdinEnd).not.toHaveBeenCalled();
    expect(f.helper.kill).not.toHaveBeenCalled();
    expect(f.callbacks.closed).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'a nonzero exit', code: 13, signal: null },
    { name: 'a signal', code: null, signal: 'SIGTERM' as const },
  ])('does not treat $name as confirmed Job termination', async ({ code, signal }) => {
    const f = await windowsFixture();
    const close = f.transport.close();
    const rejected = expect(close).rejects.toMatchObject({ code: 'shutdown-failed' });
    f.helper.close(code, signal);
    await rejected;
    expect(f.helper.kill).not.toHaveBeenCalled();
    expect(f.transport.close()).toBe(close);
  });

  it('retains a guard failure that happened before close was requested', async () => {
    const f = await windowsFixture();
    f.helper.close(1);
    const close = f.transport.close();
    await expect(close).rejects.toMatchObject({ code: 'shutdown-failed' });
    expect(f.transport.close()).toBe(close);
    expect(f.stdinEnd).not.toHaveBeenCalled();
  });

  it('bounds a stalled guard and retains timeout even if forced termination immediately closes it', async () => {
    const f = await windowsFixture();
    f.helper.kill.mockImplementation(() => { f.helper.close(0); return true; });
    const close = f.transport.close();
    const rejected = expect(close).rejects.toMatchObject({ code: 'shutdown-timeout' });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(f.helper.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(f.helper.kill).toHaveBeenCalledOnce();
    expect(f.spawnProcess).toHaveBeenCalledOnce();
    expect(f.transport.close()).toBe(close);
  });

  it('fails bounded cleanup when an exited guard still has open pipes without killing a stale PID', async () => {
    const f = await windowsFixture();
    f.helper.exit();
    const close = f.transport.close();
    const rejected = expect(close).rejects.toMatchObject({ code: 'shutdown-timeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(f.spawnProcess).toHaveBeenCalledOnce();
    expect(f.helper.kill).not.toHaveBeenCalled();
    expect(f.stdinEnd).not.toHaveBeenCalled();
    expect(f.callbacks.closed).not.toHaveBeenCalled();
    f.helper.close();
  });

  it('reports a safe guard launch failure without a direct-process fallback', async () => {
    const f = await windowsFixture(false);
    const rejected = expect(f.transport.ready).rejects.toMatchObject({ code: 'cli-unavailable' });
    f.helper.emit('error', new Error('synthetic-private-diagnostic'));
    await rejected;
    expect(f.callbacks.failure).toHaveBeenCalledOnce();
    expect(f.callbacks.failure.mock.calls[0][0].message).not.toContain('synthetic-private-diagnostic');
    f.helper.close(-2);
    await expect(f.transport.close()).rejects.toMatchObject({ code: 'shutdown-failed' });
    expect(f.spawnProcess).toHaveBeenCalledOnce();
    expect(f.helper.kill).not.toHaveBeenCalled();
  });
});
