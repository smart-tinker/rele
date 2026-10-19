import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
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
    // These fixtures exit naturally after writing their invalid bytes. Observe
    // that exit before cleanup rather than racing it with a forced tree kill.
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
  exit(code = 0): void { this.exitCode = code; this.emit('exit', code, null); }
  close(code = 0): void {
    if (this.exitCode === null) this.exit(code);
    this.emit('close', code, null);
  }
}

async function windowsFixture() {
  vi.useFakeTimers();
  const child = new FakeProcess(1234), helper = new FakeProcess(5678);
  const spawnProcess = vi.fn().mockImplementation((command: string) => command === 'taskkill.exe' ? helper : child);
  const stdinEnd = vi.spyOn(child.stdin, 'end');
  const transport = new CodexStdioTransport('fixture-codex.exe', ['app-server'], {}, {
    message: () => {}, stderr: () => {}, failure: () => {}, closed: () => {},
  }, { platform: 'win32', spawnProcess: spawnProcess as unknown as typeof spawn });
  child.emit('spawn');
  await transport.ready;
  return { child, helper, spawnProcess, stdinEnd, transport };
}

describe('Windows owned-process shutdown ordering', () => {
  it('keeps the root alive for delayed tree enumeration and does not interrupt taskkill after two seconds', async () => {
    const f = await windowsFixture();
    // Model the npm/Codex behavior that caused the race: stdin EOF exits the root
    // immediately, while a descendant can still own the inherited pipe handles.
    f.child.stdin.once('finish', () => f.child.exit());
    let resolved = false;
    const stopping = f.transport.close();
    expect(f.transport.close()).toBe(stopping);
    const close = stopping.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.spawnProcess).toHaveBeenLastCalledWith('taskkill.exe', ['/PID', '1234', '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    expect(f.stdinEnd).not.toHaveBeenCalled();
    expect(f.child.exitCode).toBeNull();
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.helper.kill).not.toHaveBeenCalled();
    expect(resolved).toBe(false);
    f.helper.close(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.stdinEnd).toHaveBeenCalledOnce();
    expect(resolved).toBe(false); // helper success is not child close
    f.child.close();
    await close;
    expect(resolved).toBe(true);
  });

  it('continues waiting for taskkill completion if the root closes first', async () => {
    const f = await windowsFixture();
    let resolved = false;
    const close = f.transport.close().then(() => { resolved = true; });
    f.child.close();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(resolved).toBe(false);
    expect(f.helper.kill).not.toHaveBeenCalled();
    expect(f.stdinEnd).not.toHaveBeenCalled();
    f.helper.close(0);
    await close;
    expect(resolved).toBe(true);
  });

  it.each(['error', 'nonzero'] as const)('does not treat taskkill %s as confirmed tree termination', async outcome => {
    const f = await windowsFixture();
    const close = f.transport.close();
    const rejected = expect(close).rejects.toMatchObject({ code: 'shutdown-failed' });
    // Even a root close cannot turn an unsuccessful tree operation into success.
    f.child.close();
    if (outcome === 'error') f.helper.emit('error', new Error('synthetic-private-diagnostic'));
    else f.helper.close(128);
    await rejected;
    expect(f.stdinEnd).not.toHaveBeenCalled();
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.transport.close()).toBe(close);
    await expect(close).rejects.not.toThrow('synthetic-private-diagnostic');
  });

  it('keeps shutdown bounded and fails closed while inherited pipes remain open', async () => {
    const f = await windowsFixture();
    const close = f.transport.close();
    const rejected = expect(close).rejects.toMatchObject({ code: 'shutdown-timeout' });
    f.helper.close(0);
    f.child.exit(); // exit alone is not the close event
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.transport.close()).toBe(close);
  });

  it('bounds a stalled taskkill without falling back to terminating only the root', async () => {
    const f = await windowsFixture();
    const close = f.transport.close();
    const rejected = expect(close).rejects.toMatchObject({ code: 'shutdown-timeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(f.helper.kill).toHaveBeenCalledOnce();
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.stdinEnd).not.toHaveBeenCalled();
  });

  it('does not kill an already-exited root by a potentially reused PID', async () => {
    const f = await windowsFixture();
    f.child.exit();
    let resolved = false;
    const close = f.transport.close().then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(f.spawnProcess).toHaveBeenCalledOnce();
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.stdinEnd).not.toHaveBeenCalled();
    expect(resolved).toBe(false);
    f.child.close();
    await close;
  });

  it('does not conceal a timeout when the root already exited and descendants keep pipes open', async () => {
    const f = await windowsFixture();
    f.child.exit();
    const close = f.transport.close();
    const rejected = expect(close).rejects.toMatchObject({ code: 'shutdown-timeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(f.spawnProcess).toHaveBeenCalledOnce();
    expect(f.child.kill).not.toHaveBeenCalled();
  });
});
