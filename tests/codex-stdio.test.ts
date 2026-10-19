import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexStdioTransport, type CodexStdioError } from '../src/server/codex-stdio.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(source: string, maxFrameBytes?: number, expectedMessages = 1) {
  const directory = await mkdtemp(path.join(tmpdir(), 'Rele stdio fixture '));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'server.mjs');
  await writeFile(script, source);
  const messages: string[] = [], errors: CodexStdioError[] = [];
  let resolveMessage!: () => void, resolveFailure!: () => void;
  const message = new Promise<void>(resolve => { resolveMessage = resolve; });
  const failure = new Promise<void>(resolve => { resolveFailure = resolve; });
  const transport = new CodexStdioTransport(process.execPath, [script], process.env, {
    message: raw => { messages.push(raw); if (messages.length >= expectedMessages) resolveMessage(); },
    stderr: () => {},
    failure: error => { errors.push(error); resolveFailure(); },
    closed: () => {},
  }, { maxFrameBytes });
  cleanup.push(() => transport.close());
  await transport.ready;
  return { transport, messages, errors, message, failure };
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
  });
});
