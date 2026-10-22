import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { bridgeCodexStdio, shimMode, validateStdioFlags, findDesktopExecutable } from '../src/server/codex-cli.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function pair() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => { for (const client of server.clients) client.terminate(); server.close(() => resolve()); }));
  const accepted = once(server, 'connection');
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  socket.on('error', () => {});
  cleanup.push(() => socket.terminate());
  const [peer] = await accepted as [WebSocket];
  await once(socket, 'open');
  const input = new PassThrough(), output = new PassThrough();
  cleanup.push(() => { input.destroy(); output.destroy(); });
  return { socket, peer, input, output };
}

describe('Desktop framing over the shared native connection', () => {
  it('forwards initialize, IDs, notifications and approval replies without synthesizing an initializer', async () => {
    const { socket, peer, input, output } = await pair();
    const received: unknown[] = [];
    const lines: string[] = [];
    output.on('data', chunk => lines.push(String(chunk)));
    peer.on('message', raw => { received.push(JSON.parse(raw.toString())); });
    const bridge = bridgeCodexStdio(socket, input, output);
    const initialized = { id: 'desktop-1', method: 'initialize', params: { clientInfo: { name: 'codex_desktop' }, capabilities: { experimentalApi: true } } };
    const next = once(peer, 'message');
    const bytes = Buffer.from(JSON.stringify(initialized) + '\r\n');
    input.write(bytes.subarray(0, 12)); input.write(bytes.subarray(12));
    await next;
    expect(received).toEqual([initialized]);
    const event = { id: 29, method: 'item/commandExecution/requestApproval', params: { threadId: 'original-id', command: 'echo проверка' } };
    const written = once(output, 'data');
    peer.send(JSON.stringify(event, null, 2));
    await written;
    expect(lines.join('').trim().split('\n').map(line => JSON.parse(line))).toEqual([event]);
    const replied = once(peer, 'message');
    input.write(JSON.stringify({ id: 29, result: { decision: 'decline' } }) + '\n');
    await replied;
    expect(received[1]).toEqual({ id: 29, result: { decision: 'decline' } });
    input.end(); await bridge;
  });

  it('preserves split UTF-8 frames and sends each input once', async () => {
    const { socket, peer, input, output } = await pair();
    const bridge = bridgeCodexStdio(socket, input, output);
    const received = once(peer, 'message');
    const text = JSON.stringify({ method: 'thread/name/set', params: { name: 'Тереза' } });
    const bytes = Buffer.from(text + '\n');
    for (const byte of bytes) input.write(Buffer.from([byte]));
    expect(JSON.parse(String((await received)[0]))).toEqual(JSON.parse(text));
    input.end(); await bridge;
  });

  it('rejects malformed and oversized input before forwarding it', async () => {
    for (const value of ['not-json\n', 'x'.repeat(20) + '\n', '{"partial":true}']) {
      const { socket, peer, input, output } = await pair();
      const received: unknown[] = [];
      peer.on('message', raw => received.push(raw));
      const bridge = bridgeCodexStdio(socket, input, output, 16);
      const failure = expect(bridge).rejects.toThrow();
      input.end(value);
      await failure;
      expect(received).toEqual([]);
    }
  });

  it('closes only the connection on backend failure and never replays a request', async () => {
    const { socket, peer, input, output } = await pair();
    const bridge = bridgeCodexStdio(socket, input, output);
    const received = once(peer, 'message');
    input.write('{"id":"unknown-ack","method":"thread/queue/add"}\n');
    await received;
    peer.terminate();
    await bridge;
    expect(input.destroyed).toBe(true);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it('verifies the same native profile before forwarding any following Desktop requests', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rele-shim-home-'));
    const foreign = await mkdtemp(path.join(tmpdir(), 'rele-shim-other-'));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    cleanup.push(() => rm(foreign, { recursive: true, force: true }));
    const { socket, peer, input, output } = await pair();
    const received: unknown[] = [];
    peer.on('message', raw => {
      received.push(JSON.parse(raw.toString()));
      peer.send(JSON.stringify({ id: 1, result: { codexHome: foreign } }));
    });
    const bridge = bridgeCodexStdio(socket, input, output, undefined, home);
    const failure = expect(bridge).rejects.toThrow('профиль');
    input.write('{"id":1,"method":"initialize"}\n{"id":2,"method":"thread/queue/add"}\n');
    await failure;
    expect(received).toEqual([{ id: 1, method: 'initialize' }]);
  });

  it('keeps independent server IDs and later reused client IDs after profile verification', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rele-shim-ids-'));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const { socket, peer, input, output } = await pair();
    const frames: unknown[] = [];
    output.on('data', chunk => frames.push(JSON.parse(String(chunk))));
    const bridge = bridgeCodexStdio(socket, input, output, undefined, home);
    peer.once('message', () => {
      peer.send(JSON.stringify({ id: 1, result: { codexHome: home } }));
      peer.send(JSON.stringify({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'same-thread' } }));
      peer.send(JSON.stringify({ id: 1, result: { reused: true } }));
    });
    input.write('{"id":1,"method":"initialize"}\n');
    while (frames.length < 3) await once(output, 'data');
    expect(frames).toEqual([{ id: 1, result: { codexHome: home } }, { id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'same-thread' } }, { id: 1, result: { reused: true } }]);
    const reply = once(peer, 'message');
    input.write('{"id":1,"result":{"decision":"decline"}}\n');
    expect(JSON.parse(String((await reply)[0]))).toEqual({ id: 1, result: { decision: 'decline' } });
    input.end(); await bridge;
  });

  it('selects an actual installed Desktop GUI and refuses ambiguous installations or CLI aliases', async () => {
    const fixture = { installations: [{ executable: 'C:\\Apps\\Codex\\resources\\codex.exe', name: 'Desktop', source: 'desktop-install' as const, running: false }, { executable: 'C:\\CLI\\codex.exe', name: 'CLI', source: 'path' as const, running: false }], issues: [] };
    const files = new Set(['C:\\Apps\\Codex\\resources\\app.asar', 'C:\\Apps\\Codex\\Codex.exe']);
    expect(await findDesktopExecutable(fixture, async file => files.has(file))).toBe('C:\\Apps\\Codex\\Codex.exe');
    files.add('C:\\Apps\\Codex\\ChatGPT.exe');
    expect(await findDesktopExecutable(fixture, async file => files.has(file))).toBe('C:\\Apps\\Codex\\ChatGPT.exe');
    files.delete('C:\\Apps\\Codex\\Codex.exe');
    expect(await findDesktopExecutable(fixture, async file => files.has(file))).toBe('C:\\Apps\\Codex\\ChatGPT.exe');
    await expect(findDesktopExecutable(fixture, async () => false)).rejects.toThrow();
    await expect(findDesktopExecutable({ ...fixture, installations: [...fixture.installations, { ...fixture.installations[0], executable: 'C:\\Other\\resources\\codex.exe' }] }, async () => true)).rejects.toThrow();
  });

  it('rejects incompatible startup settings before any lifecycle mutation', () => {
    expect(() => validateStdioFlags(['app-server', '--analytics-default-enabled', '--listen', 'stdio://'])).not.toThrow();
    for (const flags of [['--listen', 'ws://127.0.0.1:1234'], ['-c', 'sqlite_home=/other'], ['--unknown']]) expect(() => validateStdioFlags(['app-server', ...flags])).toThrow();
  });

  it('keeps version/schema/exec commands on the real CLI and makes strict interactive mode explicit', () => {
    expect(shimMode(['app-server'])).toBe('stdio');
    expect(shimMode(['app-server', '--stdio'])).toBe('stdio');
    for (const argv of [['--version'], ['app-server', 'proxy'], ['app-server', 'generate-json-schema']]) expect(shimMode(argv)).toBe('passthrough');
    expect(shimMode(['exec', 'hello'])).toBe('unsupported');
    expect(shimMode(['--rele-desktop'])).toBe('desktop');
    expect(shimMode(['--rele-cli', 'resume', 'original-id'])).toBe('interactive');
    expect(shimMode(['--rele-daemon-start'])).toBe('daemon');
  });
});
