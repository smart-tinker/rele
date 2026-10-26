import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { CodexClient, CodexThreadBusyError, CodexTransportError, classifyCodexConnectionFailure, type CodexNotification } from '../src/server/codex.js';
import { SharedCodexError } from '../src/server/codex-shared.js';
import { Engine } from '../src/server/engine.js';
import { Store } from '../src/server/store.js';
import { defaultConfig } from '../src/server/config.js';
import type { Endpoint } from '../src/shared/types.js';

interface Rpc { id?: string | number; method?: string; params: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }
type Handler = (message: Rpc, socket: WebSocket) => unknown | Promise<unknown>;
const noResponse = Symbol('no response');
const threadId = randomUUID();
const rawThread = { id: threadId, name: 'Релиз Rele', preview: 'Общий контекст', cwd: '/project', updatedAt: 123, status: { type: 'idle' } };
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function managedFixture(options: {
  version?: string;
  resume?: 'busy' | 'wrong';
  release?: 'early' | 'delayed' | 'notLoaded' | 'silent';
  dropAck?: boolean;
  contextRead?: 'busy' | 'notLoaded' | 'wrong';
  contextQueue?: 'pending' | 'afterResume';
  dropInjectAck?: boolean;
  malformed?: boolean;
  codexHome?: string;
  auto?: boolean;
  releaseTimeoutMs?: number;
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'Rele managed fixture '));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'codex.mjs');
  const log = path.join(directory, 'wire.jsonl');
  await writeFile(log, '');
  await writeFile(executable, `
    import { appendFileSync, writeSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    const log = ${JSON.stringify(log)}, options = ${JSON.stringify(options)}, thread = ${JSON.stringify(rawThread)};
    const record = value => appendFileSync(log, JSON.stringify(value) + '\\n');
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    record({ event: 'start', pid: process.pid, argv: process.argv.slice(2), home: process.env.CODEX_HOME, marker: process.env.RELE_CODEX_TEST_MARKER });
    let released, resumed = false;
    for await (const line of createInterface({ input: process.stdin })) {
      const message = JSON.parse(line);
      record(message);
      if (!message.method || message.id === undefined) continue;
      const reply = result => send({ id: message.id, result });
      switch (message.method) {
        case 'initialize':
          if (options.malformed) { writeSync(2, 'synthetic-secret-never-published\\n'); writeSync(1, 'malformed-json\\n'); break; }
          reply({ userAgent: 'rele/' + (options.version || '0.163.0') + ' (Fixture)', codexHome: process.env.CODEX_HOME || ${JSON.stringify(directory)}, platformFamily: 'fixture', platformOs: process.platform });
          break;
        case 'thread/list': reply({ data: [thread], nextCursor: null }); break;
        case 'thread/queue/list':
          reply({ data: options.contextQueue === 'pending' || options.contextQueue === 'afterResume' && resumed ? [{ id: 'other-queue', clientUserMessageId: 'other-request' }] : [], nextCursor: null });
          break;
        case 'thread/turns/list': reply({ data: [], nextCursor: null }); break;
        case 'thread/resume':
          resumed = true;
          if (options.resume === 'busy') send({ id: message.id, error: { code: -32600, message: 'thread ' + message.params.threadId + ' already has an active writer' } });
          else reply({ thread: { ...thread, id: options.resume === 'wrong' ? 'unexpected-fork' : message.params.threadId } });
          break;
        case 'thread/queue/add':
          if (options.dropAck) process.exit(0);
          reply({ queuedSubmission: { id: 'queued', clientUserMessageId: message.params.clientUserMessageId } });
          break;
        case 'thread/unsubscribe':
          released = message.params.threadId;
          if (options.release === 'notLoaded') reply({ status: 'notLoaded' });
          else if (options.release === 'early' || !options.release) {
            send({ method: 'thread/closed', params: { threadId: released } });
            reply({ status: 'unsubscribed' });
          } else reply({ status: 'unsubscribed' });
          break;
        case 'thread/read':
          if (message.params.threadId === 'fixture-release-now') send({ method: 'thread/closed', params: { threadId: released } });
          reply({ thread: { ...thread, id: options.contextRead === 'wrong' ? 'unexpected-context-thread' : thread.id, status: { type: options.contextRead === 'busy' ? 'active' : options.contextRead === 'notLoaded' ? 'notLoaded' : 'idle' } } });
          break;
        case 'thread/inject_items':
          if (options.dropInjectAck) process.exit(0);
          reply({});
          break;
        default: send({ id: message.id, error: { code: -32601, message: 'Unknown fixture method' } });
      }
    }
  `);
  const discover = vi.fn().mockResolvedValue({
    installations: [{ executable, name: 'Installed Codex', source: 'desktop-process', version: '0.163.0', running: true }],
    recommendedManaged: { executable, transport: 'managed', endpoint: '' },
    issues: [{ code: 'desktop-stdio', message: 'Desktop has no listener' }],
  });
  const client = new CodexClient({ transport: 'managed', executable: options.auto ? 'codex' : executable, codexHome: options.codexHome }, { discover, releaseTimeoutMs: options.releaseTimeoutMs });
  cleanup.push(() => client.close());
  const records = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Rpc & { event?: string; argv?: string[]; home?: string; marker?: string; pid?: number });
  const calls = async () => (await records()).filter(row => row.method);
  return { client, executable, directory, discover, records, calls };
}

async function fixture(handlers: Record<string, Handler> = {}, codexHome?: string) {
  const calls: Rpc[] = [], responses: Rpc[] = [], sockets: WebSocket[] = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  cleanup.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const defaults: Record<string, Handler> = {
    initialize: () => ({ userAgent: 'rele/0.163.0 (Linux; x86_64)', codexHome: '/isolated', platformFamily: 'unix', platformOs: 'linux' }),
    'thread/list': () => ({ data: [rawThread], nextCursor: null }),
    'thread/queue/list': () => ({ data: [], nextCursor: null }),
    'thread/resume': () => ({ thread: { ...rawThread, turns: [] } }),
    'thread/read': () => ({ thread: rawThread }),
    'thread/turns/list': () => ({ data: [], nextCursor: null }),
    'turn/interrupt': () => ({}),
  };
  server.on('connection', socket => {
    sockets.push(socket);
    socket.on('message', async raw => {
      const message = JSON.parse(raw.toString()) as Rpc;
      if (!message.method) { responses.push(message); return; }
      calls.push(message);
      if (message.id === undefined) return;
      const handler = handlers[message.method] ?? defaults[message.method];
      if (!handler) { socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } })); return; }
      const result = await handler(message, socket);
      if (result !== noResponse && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new CodexClient({ transport: 'websocket', executable: 'codex', endpoint, codexHome });
  cleanup.push(() => client.close());
  return { client, calls, responses, sockets, handlers, endpoint };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition did not become true.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('Codex native shared policy', () => {
  async function sharedFixture(implicitProfile = false) {
    const home = await mkdtemp(path.join(tmpdir(), 'rele-shared-client-'));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const f = await fixture({ initialize: () => ({ userAgent: 'codex/0.163.0-alpha.11 (Fixture)', codexHome: home,
      platformFamily: process.platform === 'win32' ? 'windows' : 'unix', platformOs: process.platform === 'win32' ? 'windows' : process.platform }) }, home);
    if (implicitProfile) vi.stubEnv('CODEX_HOME', home);
    const target = { transport: 'shared' as const, executable: 'codex', endpoint: '', ...(!implicitProfile ? { codexHome: home } : {}) };
    const shared = vi.fn().mockResolvedValue({ ...target, transport: 'websocket', endpoint: f.endpoint, codexHome: home });
    const client = new CodexClient(target, { shared });
    cleanup.push(() => client.close());
    return { ...f, client, peer: f.client, target, shared, home };
  }

  it.each([false, true])('keeps policy stable and closes only its connection (implicit profile: %s)', async implicitProfile => {
    const f = await sharedFixture(implicitProfile);
    await f.client.connect();
    expect(f.shared).toHaveBeenCalledWith(f.target, {});
    expect(f.client.status()).toMatchObject({ connected: true, transport: 'shared', queueSupported: true, codexHome: f.home, name: 'Codex 0.163.0-alpha.11' });
    expect(f.target).toMatchObject({ transport: 'shared', endpoint: '' });
    await f.client.subscribe(threadId);
    await f.client.releaseThread(threadId);
    expect(f.calls.some(call => call.method === 'thread/unsubscribe')).toBe(false);
    await f.client.close();
    await f.peer.connect();
    expect(f.peer.status().connected).toBe(true);
    expect((await f.peer.listThreads())[0].id).toBe(threadId);
  });

  it('keeps the last connection error visible during retry and clears it after a verified reconnect', async () => {
    const f = await sharedFixture();
    f.shared.mockRejectedValueOnce(new SharedCodexError('Fixed safe startup failure.', 'shared-daemon-unavailable'));
    await expect(f.client.connect()).rejects.toMatchObject({ code: 'shared-daemon-unavailable' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.shared.mockImplementationOnce(async () => {
      await gate;
      return { ...f.target, transport: 'websocket', endpoint: f.endpoint, codexHome: f.home };
    });
    const retry = f.client.connect();
    try {
      await until(() => f.shared.mock.calls.length === 2);
      expect(f.client.status()).toMatchObject({ connected: false, error: 'Fixed safe startup failure.', errorCode: 'shared-daemon-unavailable' });
    } finally { release(); }
    await retry;
    expect(f.client.status()).toMatchObject({ connected: true, queueSupported: true, error: undefined, errorCode: undefined });
  });

  it.each([false, true])('rejects a different profile before any catalog or queue call (implicit profile: %s)', async implicitProfile => {
    const f = await sharedFixture(implicitProfile);
    f.handlers.initialize = () => ({ userAgent: 'codex/0.163.0 (Fixture)', codexHome: path.join(f.home, 'different'),
      platformFamily: process.platform === 'win32' ? 'windows' : 'unix', platformOs: process.platform === 'win32' ? 'windows' : process.platform });
    await expect(f.client.connect()).rejects.toMatchObject({ code: 'shared-profile-mismatch' });
    expect(f.client.status()).toMatchObject({ connected: false, queueSupported: false, errorCode: 'shared-profile-mismatch' });
    expect(f.calls.map(call => call.method)).toEqual(['initialize', 'initialized']);
  });

  it('re-resolves after disconnect and reconciles an accepted UUID without repeating queue/add', async () => {
    const f = await sharedFixture(), clientId = randomUUID();
    f.handlers['thread/queue/add'] = (_message, socket) => { socket.close(); return noResponse; };
    f.handlers['thread/queue/list'] = () => ({ data: [{ id: 'accepted', clientUserMessageId: clientId }], nextCursor: null });
    await f.client.connect();
    await expect(f.client.enqueue(threadId, 'Original shared request', clientId)).rejects.toBeInstanceOf(CodexTransportError);
    await f.client.connect();
    expect(f.shared).toHaveBeenCalledTimes(2);
    expect(await f.client.findRequest(threadId, clientId)).toEqual({ state: 'queued', queuedSubmissionId: 'accepted', soleQueuedSubmission: true });
    expect(f.calls.filter(call => call.method === 'thread/queue/add')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'thread/resume').every(call => call.params.threadId === threadId)).toBe(true);
    expect(f.calls.some(call => ['thread/start', 'thread/fork', 'turn/start'].includes(call.method ?? ''))).toBe(false);
  });

  it('automatically retries a startup outage past 15 seconds and refuses a changed profile before recovering', async () => {
    const f = await sharedFixture();
    const replacement = await fixture({ initialize: () => ({ userAgent: 'codex/0.163.0-alpha.11 (Fixture)', codexHome: path.join(f.home, 'wrong'),
      platformFamily: process.platform === 'win32' ? 'windows' : 'unix', platformOs: process.platform === 'win32' ? 'windows' : process.platform }) });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const started = Date.now();
    f.shared.mockRejectedValue(new SharedCodexError('Native is not ready.', 'shared-daemon-unavailable'));
    await expect(f.client.connect()).rejects.toMatchObject({ code: 'shared-daemon-unavailable' });
    for (const [delay, count] of [[1_000, 2], [2_000, 3]]) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(f.shared).toHaveBeenCalledTimes(count);
      expect(f.client.status().connected).toBe(false);
    }
    f.shared.mockResolvedValue({ ...f.target, transport: 'websocket', endpoint: replacement.endpoint, codexHome: f.home });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(f.client.status().errorCode).toBe('shared-profile-mismatch'));
    expect(replacement.calls.map(call => call.method)).toEqual(['initialize', 'initialized']);
    replacement.handlers.initialize = () => ({ userAgent: 'codex/0.163.0-alpha.11 (Fixture)', codexHome: f.home,
      platformFamily: process.platform === 'win32' ? 'windows' : 'unix', platformOs: process.platform === 'win32' ? 'windows' : process.platform });
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(f.client.status()).toMatchObject({ connected: true, queueSupported: true, endpoint: replacement.endpoint, errorCode: undefined }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(18_000);
    expect(f.shared).toHaveBeenCalledTimes(5);
    expect(f.calls).toEqual([]);
    expect((await f.client.listThreads())[0].id).toBe(threadId);
  });

  it('automatically reconnects Engine to a replacement native target without replaying a lost-ACK request or losing the next queued UUID', async () => {
    const f = await sharedFixture();
    const runtime = { userAgent: 'codex/0.163.0-alpha.11 (Fixture)', codexHome: f.home,
      platformFamily: process.platform === 'win32' ? 'windows' : 'unix', platformOs: process.platform === 'win32' ? 'windows' : process.platform };
    let acceptedId = '', nextId = '';
    f.handlers['server/diagnostics'] = () => ({ process: { id: 41 }, gauges: [] });
    f.handlers['thread/backgroundTerminals/list'] = () => ({ data: [], nextCursor: null });
    f.handlers['thread/queue/add'] = (message, socket) => { acceptedId = String(message.params.clientUserMessageId); socket.close(); return noResponse; };
    const replacement = await fixture({ initialize: () => runtime,
      'server/diagnostics': () => ({ process: { id: 42 }, gauges: [] }),
      'thread/backgroundTerminals/list': () => ({ data: [], nextCursor: null }),
      'thread/queue/add': message => { nextId = String(message.params.clientUserMessageId); return { queuedSubmission: { id: 'next-accepted', clientUserMessageId: nextId } }; },
      'thread/turns/list': () => ({ data: [{ id: 'accepted-turn', status: 'completed', items: [
        { type: 'userMessage', clientId: acceptedId }, { type: 'agentMessage', phase: 'final_answer', text: 'Recovered answer' },
      ] }, ...(nextId ? [{ id: 'next-turn', status: 'inProgress', items: [{ type: 'userMessage', clientId: nextId }] }] : [])], nextCursor: null }),
    }, f.home);
    const store = new Store(':memory:');
    cleanup.push(() => store.close());
    const endpoint: Endpoint = { id: 'retry-telegram', platform: 'telegram', accountId: '999', chatId: '-100123', threadId: '17',
      title: 'Retry fixture', subtitle: '', people: [{ id: '123', name: 'Fixture' }], updatedAt: new Date().toISOString() };
    store.upsertEndpoint(endpoint);
    store.createConversation({ name: 'Original', threadId, cwd: f.home, bindings: [{ platform: 'telegram', endpointId: endpoint.id, allowedSenderIds: ['123'] }] });
    const config = { ...structuredClone(defaultConfig), codex: f.target, telegram: { enabled: true } };
    const engine = new Engine(store, f.client, { config: () => config, temporaryRoot: f.home, redact: () => 'Fixture error' });
    const deliver = vi.fn(async () => 'remote-receipt');
    engine.channels.telegram = { state: { configured: true, connected: true, accountId: '999' }, start: async () => {}, stop: async () => {}, download: async () => {}, deliver };
    cleanup.push(() => engine.stop());
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    await f.client.connect();
    engine.start();
    await engine.receive({ eventId: 'lost-ack', endpoint, sender: endpoint.people[0], messageId: '1', text: 'First request' });
    await engine.settled();
    const first = store.listRequests()[0];
    expect(first).toMatchObject({ id: acceptedId, status: 'uncertain' });
    f.shared.mockRejectedValue(new SharedCodexError('Native is not ready.', 'shared-daemon-unavailable'));
    await engine.receive({ eventId: 'waiting', endpoint, sender: endpoint.people[0], messageId: '2', text: 'Next request' });
    await engine.settled();
    const second = store.listRequests().find(request => request.eventId === 'waiting')!;
    expect(second.status).toBe('queued');
    for (const delay of [1_000, 2_000, 5_000]) await vi.advanceTimersByTimeAsync(delay);
    expect(f.client.status().connected).toBe(false);
    expect(store.getRequest(first.id)?.status).toBe('uncertain');
    expect(store.getRequest(second.id)?.status).toBe('queued');
    f.shared.mockResolvedValue({ ...f.target, transport: 'websocket', endpoint: replacement.endpoint, codexHome: f.home });
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(f.client.status()).toMatchObject({ connected: true, queueSupported: true, endpoint: replacement.endpoint }));
    await engine.settled();
    await vi.advanceTimersByTimeAsync(1_000);
    await engine.settled();
    expect(f.shared).toHaveBeenCalledTimes(5);
    expect(store.listRequests()).toHaveLength(2);
    expect(store.getRequest(first.id)).toMatchObject({ id: acceptedId, status: 'completed', turnId: 'accepted-turn' });
    await vi.waitFor(() => expect(store.getRequest(second.id)).toMatchObject({ id: second.id, status: 'running', turnId: 'next-turn' }));
    expect(await f.client.backgroundTerminals(threadId)).toEqual({ serverId: 42, terminals: [] });
    expect(f.calls.filter(call => call.method === 'thread/queue/add').map(call => call.params.clientUserMessageId)).toEqual([first.id]);
    expect(replacement.calls.filter(call => call.method === 'thread/queue/add').map(call => call.params.clientUserMessageId)).toEqual([second.id]);
    expect(deliver).toHaveBeenCalledOnce();
    expect(store.listDeliveries()[0]).toMatchObject({ requestId: first.id, body: 'Recovered answer', status: 'sent' });
    expect([...f.calls, ...replacement.calls].some(call => ['thread/start', 'thread/fork', 'turn/start'].includes(call.method ?? ''))).toBe(false);
  });
});

describe('Codex shared-runtime adapter', () => {
  it('automatically resolves the default CLI to a discovered existing Desktop server and keeps version gates', async () => {
    const f = await fixture({ initialize: () => ({ userAgent: 'rele/0.164.0 (Windows)', codexHome: '/isolated', platformFamily: 'windows', platformOs: 'windows' }) });
    const recommended = { executable: 'C:\\Example Desktop\\resources\\codex.exe', transport: 'websocket' as const, endpoint: f.endpoint };
    const discover = vi.fn().mockResolvedValue({ installations: [], recommended, issues: [] });
    const client = new CodexClient({ transport: 'proxy', executable: 'codex' }, { discover });
    cleanup.push(() => client.close());
    await client.connect();
    expect(discover).toHaveBeenCalledOnce();
    expect(client.status()).toMatchObject({ ...recommended, connected: true, queueSupported: false, desktopVerified: false, name: 'Codex 0.164.0' });
    expect((await client.listThreads()).map(thread => thread.id)).toEqual([threadId]);
    await expect(client.enqueue(threadId, 'Test', randomUUID())).rejects.toThrow('0.163.0');
    expect(f.calls.some(call => ['turn/start', 'thread/queue/add'].includes(call.method || ''))).toBe(false);
  });

  it('reports a discovered stdio-only Desktop without spawning another app-server', async () => {
    const executable = 'C:\\Example Desktop\\resources\\codex.exe';
    const discover = vi.fn().mockResolvedValue({
      installations: [{ executable, name: 'Codex из Desktop', source: 'desktop-process', version: '0.163.0', running: true, processId: 42 }],
      issues: [{ code: 'desktop-stdio', executable, message: 'Desktop найден, общий сокет не обнаружен.' }],
    });
    const client = new CodexClient({ transport: 'proxy', executable: 'codex' }, { discover });
    cleanup.push(() => client.close());
    await expect(client.connect()).rejects.toMatchObject({ code: 'desktop-stdio' });
    expect(client.status()).toMatchObject({ executable, connected: false, errorCode: 'desktop-stdio', desktopVerified: false });
    await expect(client.connect()).rejects.toMatchObject({ code: 'desktop-stdio' });
    expect(discover).toHaveBeenCalledOnce();
  });

  it('preserves an explicit WebSocket target without invoking installation discovery', async () => {
    const f = await fixture();
    const discover = vi.fn().mockRejectedValue(new Error('Discovery must not be called'));
    const client = new CodexClient({ transport: 'websocket', executable: '/custom/codex', endpoint: f.endpoint }, { discover });
    cleanup.push(() => client.close());
    await client.connect();
    expect(discover).not.toHaveBeenCalled();
    expect(client.status()).toMatchObject({ executable: '/custom/codex', endpoint: f.endpoint, connected: true });
  });

  it('only launches proxy for an explicit CLI, preserves its socket and categorizes stderr without exposing it', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'Rele proxy fixture '));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const script = path.join(directory, 'codex-fixture.mjs');
    const record = path.join(directory, 'arguments.json');
    const endpoint = path.join(directory, 'existing-control.sock');
    await writeFile(script, `import { writeFileSync, writeSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\nwriteSync(2, "error: unrecognized subcommand 'proxy'; synthetic-secret-must-never-appear\\n");\nprocess.exit(1);\n`);
    const discover = vi.fn().mockRejectedValue(new Error('Must not discover a custom executable'));
    const client = new CodexClient({ transport: 'proxy', executable: script, endpoint }, { discover });
    cleanup.push(() => client.close());
    await expect(client.connect()).rejects.toMatchObject({ code: 'proxy-unsupported' });
    expect(discover).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual(['app-server', 'proxy', '--sock', endpoint]);
    expect(client.status()).toMatchObject({ connected: false, executable: script, endpoint, errorCode: 'proxy-unsupported' });
    expect(JSON.stringify(client.status())).not.toContain('synthetic-secret');
  });

  it('rejects a stale WebSocket URL in proxy configuration before discovery or launch', async () => {
    const discover = vi.fn();
    const client = new CodexClient({ transport: 'proxy', executable: 'codex', endpoint: 'ws://127.0.0.1:4500' }, { discover });
    cleanup.push(() => client.close());
    await expect(client.connect()).rejects.toMatchObject({ code: 'invalid-proxy-socket' });
    expect(discover).not.toHaveBeenCalled();
  });

  it('auto-resolves only the executable when an operator configured an explicit proxy socket', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'Rele selected socket '));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, 'codex-fixture.mjs');
    const record = path.join(directory, 'arguments.json');
    const endpoint = path.join(directory, 'operator-selected.sock');
    await writeFile(executable, `import { writeFileSync, writeSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\nwriteSync(2, "No such file or directory (os error 2)\\n");\nprocess.exit(1);\n`);
    const discover = vi.fn().mockResolvedValue({
      installations: [{ executable, name: 'Codex', source: 'desktop-process', version: '0.163.0', running: true }],
      recommended: { executable, transport: 'websocket', endpoint: 'ws://127.0.0.1:45678' }, issues: [],
    });
    const client = new CodexClient({ transport: 'proxy', executable: 'codex', endpoint }, { discover });
    cleanup.push(() => client.close());
    await expect(client.connect()).rejects.toMatchObject({ code: 'shared-server-unavailable' });
    expect(discover).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual(['app-server', 'proxy', '--sock', endpoint]);
    expect(client.status()).toMatchObject({ executable, transport: 'proxy', endpoint });
  });

  it.each([
    ['No such file or directory (os error 2)', 'shared-server-unavailable'],
    ['Access is denied (os error 5)', 'access-denied'],
    ['spawn ENOENT', 'cli-unavailable'],
    ['Unexpected server response: 401', 'authentication-failed'],
  ])('classifies a connection failure using a fixed safe message: %s', (input, code) => {
    const result = classifyCodexConnectionFailure(`${input} synthetic-private-token-and-path`);
    expect(result.code).toBe(code);
    expect(result.message).not.toContain('synthetic-private');
  });

  it.each([false, true])('lists every page of ordinary conversations without resuming them (refresh: %s)', async refresh => {
    const f = await fixture({
      'thread/list': message => message.params.cursor
        ? { data: [{ ...rawThread, id: 'second', name: null, preview: '  Название\nиз контекста  ' }], nextCursor: null }
        : { data: [rawThread], nextCursor: 'page-2' },
    });
    await f.client.connect();
    expect(f.client.status()).toMatchObject({ connected: true, queueSupported: true, desktopVerified: false, name: 'Codex 0.163.0' });
    expect(f.calls[0]).toMatchObject({ method: 'initialize', params: { capabilities: { experimentalApi: true } } });
    const threads = await f.client.listThreads({ refresh });
    expect(threads.map(thread => thread.name)).toEqual(['Релиз Rele', 'Название из контекста']);
    const listings = f.calls.filter(call => call.method === 'thread/list');
    expect(listings).toHaveLength(3);
    expect(listings[0].params).toMatchObject({ useStateDbOnly: true });
    for (const call of listings) {
      expect(call.params).toMatchObject({ archived: false, sourceKinds: ['cli', 'vscode', 'exec', 'appServer'] });
    }
    for (const call of listings.slice(1)) expect(call.params).toMatchObject({ useStateDbOnly: !refresh });
    expect(listings[2].params.cursor).toBe('page-2');
    expect(f.calls.filter(call => call.method === 'thread/queue/list')).toHaveLength(1);
    expect(f.calls.some(call => ['thread/resume', 'thread/queue/add', 'thread/unarchive'].includes(call.method ?? ''))).toBe(false);
    await f.client.readThread(threadId);
    expect(f.calls.at(-1)).toMatchObject({ method: 'thread/read', params: { threadId } });
  });

  it('filters technical metadata while preserving every normal source and user titles', async () => {
    const normal = ['cli', 'vscode', 'exec', 'appServer'].map(source => ({
      ...rawThread, id: `normal-${source}`, source, name: source === 'cli' ? 'Guardian review' : source,
    }));
    const technical = [
      { ...rawThread, id: 'guardian', source: { subAgent: { other: 'guardian' } }, name: 'Renamed review' },
      { ...rawThread, id: 'review', source: { subAgent: 'review' } },
      { ...rawThread, id: 'compact', source: { subAgent: 'compact' } },
      { ...rawThread, id: 'spawn', source: { subAgent: { thread_spawn: { parent_thread_id: threadId } } } },
      { ...rawThread, id: 'child', source: 'appServer', parentThreadId: threadId },
      { ...rawThread, id: 'temporary', source: 'cli', ephemeral: true },
      { ...rawThread, id: 'unknown', source: 'unknown' },
    ];
    const f = await fixture({ 'thread/list': () => ({ data: [...technical, ...normal], nextCursor: null }) });
    await f.client.connect();
    const threads = await f.client.listThreads();
    expect(threads.map(thread => thread.id)).toEqual(normal.map(thread => thread.id));
    expect(threads[0].name).toBe('Guardian review');
    expect(f.calls.filter(call => call.method === 'thread/queue/list').map(call => call.params.threadId)).toEqual(['normal-cli']);
    expect(f.calls.some(call => ['thread/resume', 'thread/queue/add', 'thread/unarchive'].includes(call.method ?? ''))).toBe(false);
  });

  it('checks queue support using full refresh results after an empty indexed catalog', async () => {
    const f = await fixture({
      'thread/list': message => ({ data: message.params.useStateDbOnly ? [] : [rawThread], nextCursor: null }),
    });
    await f.client.connect();
    expect(f.client.status()).toMatchObject({ connected: true, queueSupported: false });
    expect(await f.client.listThreads()).toEqual([]);
    expect(f.calls.filter(call => call.method === 'thread/queue/list')).toHaveLength(0);
    expect(await f.client.listThreads({ refresh: true })).toMatchObject([{ id: threadId }]);
    expect(f.client.status()).toMatchObject({ queueSupported: true, error: undefined });
    expect(f.calls.filter(call => call.method === 'thread/list')).toHaveLength(3);
    expect(f.calls.filter(call => call.method === 'thread/queue/list')).toHaveLength(1);
    expect(f.calls.some(call => ['thread/resume', 'thread/queue/add', 'thread/unarchive'].includes(call.method ?? ''))).toBe(false);
  });

  it('lists archived conversations without restoring, resuming or queuing them', async () => {
    const f = await fixture({
      'thread/list': message => ({ data: message.params.archived ? [rawThread, { ...rawThread, id: 'temporary', ephemeral: true }] : [], nextCursor: null }),
    });
    await f.client.connect();
    expect(await f.client.listThreads()).toEqual([]);
    expect(await f.client.listThreads({ archived: true })).toMatchObject([{ id: threadId, archived: true }]);
    expect(f.calls.some(call => ['thread/unarchive', 'thread/resume', 'thread/queue/add'].includes(call.method ?? ''))).toBe(false);
  });

  it('only adds to the queue, preserves early origin events and forwards Desktop steering', async () => {
    const clientId = randomUUID(), events: CodexNotification[] = [];
    const f = await fixture({
      'thread/queue/add': (message, socket) => {
        for (const clientId of [message.params.clientUserMessageId, null]) {
          socket.send(JSON.stringify({ method: 'item/started', params: { threadId, turnId: 'same-turn', item: { type: 'userMessage', clientId } } }));
        }
        return { queuedSubmission: { id: 'queue-id', clientUserMessageId: message.params.clientUserMessageId } };
      },
    });
    f.client.on('notification', event => events.push(event));
    await f.client.connect();
    expect(await f.client.enqueue(threadId, 'Запрос Telegram', clientId)).toEqual({ queuedSubmissionId: 'queue-id' });
    expect(f.calls.find(call => call.method === 'thread/resume')?.params).toEqual({ threadId, excludeTurns: true });
    expect(f.calls.find(call => call.method === 'thread/queue/add')?.params).toEqual({ threadId, input: [{ type: 'text', text: 'Запрос Telegram' }], clientUserMessageId: clientId });
    expect(events.map(event => (event.params.item as { clientId: string | null }).clientId)).toEqual([clientId, null]);
    expect(f.calls.some(call => ['turn/start', 'thread/queue/start'].includes(call.method || ''))).toBe(false);
  });

  it('refuses writes on an untested runtime and never falls back to turn/start', async () => {
    const f = await fixture({ initialize: () => ({ userAgent: 'rele/0.164.0 (Linux)', codexHome: '/isolated', platformFamily: 'unix', platformOs: 'linux' }) });
    await f.client.connect();
    expect(f.client.status()).toMatchObject({ connected: true, queueSupported: false });
    await expect(f.client.enqueue(threadId, 'Test', randomUUID())).rejects.toThrow('0.163.0');
    expect(f.calls.some(call => ['turn/start', 'thread/queue/add'].includes(call.method || ''))).toBe(false);
  });

  it('probes the actual queue service and keeps unsupported servers read only', async () => {
    const f = await fixture({ 'thread/queue/list': (message, socket) => {
      socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'user message queue is unavailable' } }));
      return noResponse;
    } });
    await f.client.connect();
    expect(f.client.status()).toMatchObject({ connected: true, queueSupported: false });
    await expect(f.client.enqueue(threadId, 'Test', randomUUID())).rejects.toThrow('queue is unavailable');
    expect(f.calls.some(call => call.method === 'thread/queue/add')).toBe(false);
  });

  it.each(['0.163.0', '0.163.0-alpha.10.2'])('creates an empty-profile thread on supported %s before probing its queue', async version => {
    const createdId = randomUUID(), cwd = '/new project';
    const f = await fixture({
      initialize: () => ({ userAgent: `rele/${version} (Linux)`, codexHome: '/isolated', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/list': () => ({ data: [], nextCursor: null }),
      'thread/start': () => ({ thread: { ...rawThread, id: createdId, cwd } }),
    });
    await f.client.connect();
    expect(f.client.status().queueSupported).toBe(false);
    expect(await f.client.createThread(cwd)).toBe(createdId);
    expect(f.client.status()).toMatchObject({ queueSupported: true, error: undefined });
    expect(f.calls.find(call => call.method === 'thread/start')?.params).toEqual({ cwd });
    expect(f.calls.filter(call => call.method === 'thread/queue/list').map(call => call.params)).toEqual([{ threadId: createdId, limit: 1 }]);
    await f.client.subscribe(createdId);
    expect(f.calls.some(call => ['thread/resume', 'turn/start', 'thread/queue/add'].includes(call.method ?? ''))).toBe(false);
  });

  it.each(['0.164.0', '0.163.0-alpha.10.3'])('refuses creation on unsupported %s without a native write', async version => {
    const f = await fixture({ initialize: () => ({ userAgent: `rele/${version} (Linux)`, codexHome: '/isolated', platformFamily: 'unix', platformOs: 'linux' }) });
    await f.client.connect();
    await expect(f.client.createThread('/project')).rejects.toThrow('0.163.0');
    expect(f.calls.some(call => call.method === 'thread/start')).toBe(false);
  });

  it('refuses disconnected creation and an empty cwd before any native write', async () => {
    const f = await fixture();
    await expect(f.client.createThread('/project')).rejects.toThrow('проверенный Codex');
    await f.client.connect();
    await expect(f.client.createThread('  ')).rejects.toThrow('каталог');
    expect(f.calls.some(call => call.method === 'thread/start')).toBe(false);
  });

  it.each(['rpc', 'disconnect'])('returns the acknowledged new ID if its queue probe encounters %s', async failure => {
    const createdId = randomUUID();
    const f = await fixture({
      'thread/list': () => ({ data: [], nextCursor: null }),
      'thread/start': () => ({ thread: { ...rawThread, id: createdId } }),
      'thread/queue/list': (message, socket) => {
        if (failure === 'disconnect') socket.close();
        else socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'user message queue is unavailable' } }));
        return noResponse;
      },
    });
    await f.client.connect();
    expect(await f.client.createThread('/project')).toBe(createdId);
    expect(f.client.status()).toMatchObject({ queueSupported: false, error: expect.any(String) });
    expect(f.calls.filter(call => call.method === 'thread/start')).toHaveLength(1);
    expect(f.calls.some(call => ['thread/resume', 'turn/start', 'thread/queue/add'].includes(call.method ?? ''))).toBe(false);
  });

  it('keeps an unconfirmed create ACK uncertain without retrying or probing another thread', async () => {
    const f = await fixture({
      'thread/list': () => ({ data: [], nextCursor: null }),
      'thread/start': () => ({ thread: { ...rawThread, id: '' } }),
    });
    await f.client.connect();
    await expect(f.client.createThread('/project')).rejects.toMatchObject({ uncertain: true, code: 'thread-start-unconfirmed' });
    expect(f.calls.filter(call => call.method === 'thread/start')).toHaveLength(1);
    expect(f.calls.some(call => call.method === 'thread/queue/list')).toBe(false);
  });

  it.each(['0.163.0', '0.163.0-alpha.10.2'])('names a thread on supported %s with bounded Unicode title and recovers the empty-profile queue gate', async version => {
    const f = await fixture({
      initialize: () => ({ userAgent: `rele/${version} (Linux)`, codexHome: '/isolated', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/list': () => ({ data: [], nextCursor: null }),
      'thread/name/set': () => ({}),
    });
    await f.client.connect();
    expect(f.client.status().queueSupported).toBe(false);
    await f.client.setThreadName(threadId, `  ${'🧵'.repeat(205)}\n`);
    expect(f.calls.find(call => call.method === 'thread/name/set')?.params).toEqual({ threadId, name: '🧵'.repeat(200) });
    expect(f.client.status()).toMatchObject({ queueSupported: true, error: undefined });
    expect(f.calls.filter(call => ['thread/name/set', 'thread/queue/list'].includes(call.method ?? '')).map(call => call.method)).toEqual(['thread/name/set', 'thread/queue/list']);
    expect(f.calls.some(call => ['thread/start', 'thread/resume', 'turn/start', 'thread/queue/add', 'thread/inject_items'].includes(call.method ?? ''))).toBe(false);
  });

  it.each(['0.164.0', '0.163.0-alpha.10.3'])('does not rename on unsupported %s', async version => {
    const f = await fixture({ initialize: () => ({ userAgent: `rele/${version} (Linux)`, codexHome: '/isolated', platformFamily: 'unix', platformOs: 'linux' }) });
    await f.client.connect();
    await expect(f.client.setThreadName(threadId, 'New title')).rejects.toThrow('0.163.0');
    expect(f.calls.some(call => call.method === 'thread/name/set')).toBe(false);
  });

  it('requires a connected runtime, target and nonempty title before renaming', async () => {
    const f = await fixture();
    await expect(f.client.setThreadName(threadId, 'New title')).rejects.toThrow('проверенный Codex');
    await f.client.connect();
    await expect(f.client.setThreadName(threadId, ' \n\t ')).rejects.toThrow('непустое название');
    await expect(f.client.setThreadName('', 'New title')).rejects.toThrow('идентификатор');
    expect(f.calls.some(call => call.method === 'thread/name/set')).toBe(false);
  });

  it('preserves a name ACK if the subsequent read-only queue probe fails', async () => {
    const f = await fixture({
      'thread/list': () => ({ data: [], nextCursor: null }),
      'thread/name/set': () => ({}),
      'thread/queue/list': (message, socket) => {
        socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'queue unavailable' } }));
        return noResponse;
      },
    });
    await f.client.connect();
    await expect(f.client.setThreadName(threadId, ' Named thread ')).resolves.toBeUndefined();
    expect(f.client.status()).toMatchObject({ queueSupported: false, error: 'queue unavailable' });
    expect(f.calls.filter(call => call.method === 'thread/name/set')).toHaveLength(1);
  });

  it.each(['rpc', 'disconnect'])('propagates an unconfirmed name result after %s without retrying metadata or queue input', async failure => {
    const f = await fixture({
      'thread/list': () => ({ data: [], nextCursor: null }),
      'thread/name/set': (message, socket) => {
        if (failure === 'disconnect') socket.close();
        else socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'name rejected' } }));
        return noResponse;
      },
    });
    await f.client.connect();
    await expect(f.client.setThreadName(threadId, 'New title')).rejects.toMatchObject(failure === 'rpc' ? { code: -32600 } : { uncertain: true });
    expect(f.calls.filter(call => call.method === 'thread/name/set')).toHaveLength(1);
    expect(f.calls.some(call => ['thread/queue/list', 'thread/queue/add', 'turn/start'].includes(call.method ?? ''))).toBe(false);
  });

  it.each([undefined, null, '1792486920'])('keeps interrupted history with completedAt=%s uncertain and can later recover the answer', async completedAt => {
    const clientId = randomUUID();
    const f = await fixture({ 'thread/turns/list': () => ({ data: [{ id: 'turn-1', status: 'interrupted', completedAt,
      items: [{ type: 'userMessage', clientId }] }], nextCursor: null }) });
    await f.client.connect();
    await expect(f.client.findRequest(threadId, clientId)).rejects.toMatchObject({ uncertain: true, code: 'turn-interruption-unconfirmed', message: expect.stringContaining('не подтвердил прерывание') });
    f.handlers['thread/turns/list'] = () => ({ data: [{ id: 'turn-1', status: 'completed', completedAt: 1792486920,
      items: [{ type: 'userMessage', clientId }, { type: 'agentMessage', phase: 'final_answer', text: 'OK' }] }], nextCursor: null });
    expect(await f.client.findRequest(threadId, clientId)).toEqual({ state: 'completed', turnId: 'turn-1', text: 'OK' });
    expect(f.calls.some(call => ['turn/interrupt', 'thread/queue/add', 'thread/queue/delete'].includes(call.method ?? ''))).toBe(false);
  });

  it('recovers a timestamped native abort without receiving its original notification', async () => {
    const clientId = randomUUID();
    const f = await fixture({ 'thread/turns/list': () => ({ data: [{ id: 'stopped-turn', status: 'interrupted', completedAt: 1792486920,
      items: [{ type: 'userMessage', clientId }] }], nextCursor: null }) });
    await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId)).toMatchObject({ state: 'interrupted', turnId: 'stopped-turn' });
    expect(f.calls.some(call => ['turn/interrupt', 'thread/queue/add'].includes(call.method ?? ''))).toBe(false);
  });

  it.each([
    ['failed', 'serverOverloaded', 'serverOverloaded'],
    ['failed', 'unknown-synthetic-secret', undefined],
    ['failed', { serverOverloaded: 'synthetic-secret' }, undefined],
    ['completed', 'serverOverloaded', undefined],
    ['interrupted', 'serverOverloaded', undefined],
  ])('exposes only a known safe cause from %s history with error info %s', async (status, codexErrorInfo, failureReason) => {
    const clientId = randomUUID();
    const f = await fixture({ 'thread/turns/list': () => ({ data: [{ id: 'own-turn', status, completedAt: 1792486920,
      error: { codexErrorInfo, message: 'synthetic-secret', additionalDetails: 'private-synthetic-secret' },
      items: [{ type: 'userMessage', clientId }] }], nextCursor: null }) });
    await f.client.connect();
    const found = await f.client.findRequest(threadId, clientId);
    expect(found).toEqual({ state: status, turnId: 'own-turn', text: undefined, ...(failureReason ? { failureReason } : {}) });
    expect(JSON.stringify(found)).not.toContain('synthetic-secret');
    expect(f.calls.some(call => ['turn/interrupt', 'thread/queue/add', 'thread/queue/start'].includes(call.method ?? ''))).toBe(false);
  });

  it('recovers an accepted request from queue or paginated completed history without resending', async () => {
    const clientId = randomUUID();
    const f = await fixture({
      'thread/queue/list': () => ({ data: [{ id: 'queue-id', clientUserMessageId: clientId }], nextCursor: null }),
    });
    await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId)).toEqual({ state: 'queued', queuedSubmissionId: 'queue-id', soleQueuedSubmission: true });
    f.handlers['thread/turns/list'] = message => message.params.cursor
      ? { data: [{ id: 'completed-turn', status: 'completed', items: [
        { type: 'userMessage', clientId },
        { type: 'agentMessage', phase: 'commentary', text: 'Работаю' },
        { type: 'agentMessage', phase: 'final_answer', text: 'Готовый ответ' },
      ] }], nextCursor: null }
      : { data: [], nextCursor: 'older' };
    expect(await f.client.findRequest(threadId, clientId)).toEqual({ state: 'completed', turnId: 'completed-turn', text: 'Готовый ответ' });
    expect(f.calls.some(call => call.method === 'thread/queue/add')).toBe(false);
  });

  it.each(['completed', 'failed'])('does not recover a mixed Desktop/Rele %s turn as a routable answer or cause', async status => {
    const clientId = randomUUID();
    const f = await fixture({ 'thread/turns/list': () => ({ data: [{ id: 'mixed', status, error: { codexErrorInfo: 'serverOverloaded' }, items: [
      { type: 'userMessage', clientId }, { type: 'userMessage', clientId: null },
      { type: 'agentMessage', phase: 'final_answer', text: 'Ответ на два запроса' },
    ] }], nextCursor: null }) });
    await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId)).toEqual({ state: status, turnId: 'mixed', mixed: true });
  });

  it('rejects duplicate queued identifiers instead of treating queue/add as idempotent', async () => {
    const clientId = randomUUID();
    const f = await fixture({ 'thread/queue/list': () => ({ data: [
      { id: 'queue-1', clientUserMessageId: clientId }, { id: 'queue-2', clientUserMessageId: clientId },
    ], nextCursor: null }) });
    await f.client.connect();
    await expect(f.client.findRequest(threadId, clientId)).rejects.toThrow('несколько запросов');
  });

  it('does not mark a queued request safe for automatic continuation when another native entry exists on a later page', async () => {
    const clientId = randomUUID();
    const f = await fixture({ 'thread/queue/list': message => message.params.cursor
      ? { data: [{ id: 'foreign', clientUserMessageId: randomUUID() }], nextCursor: null }
      : { data: [{ id: 'own', clientUserMessageId: clientId }], nextCursor: 'later' } });
    await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId)).toEqual({ state: 'queued', queuedSubmissionId: 'own', soleQueuedSubmission: false });
    expect(f.calls.some(call => call.method === 'thread/queue/start')).toBe(false);
  });

  it('requires the exact native queue ID and never substitutes the queue head', async () => {
    const f = await fixture({ 'thread/queue/start': () => ({ turn: { id: 'exact-turn', status: 'inProgress', items: [] } }) });
    await f.client.connect();
    await expect(f.client.startQueued(threadId, '')).rejects.toThrow('подтверждённый элемент');
    expect(f.calls.some(call => call.method === 'thread/queue/start')).toBe(false);
    await expect(f.client.startQueued(threadId, 'own-entry')).resolves.toMatchObject({ turn: { id: 'exact-turn' } });
    expect(f.calls.filter(call => call.method === 'thread/queue/start').map(call => call.params)).toEqual([{ threadId, queuedSubmissionId: 'own-entry' }]);
    expect(f.calls.some(call => call.method === 'turn/start')).toBe(false);
  });

  it('classifies only the explicit native idle-admission rejection as a retryable busy queue', async () => {
    const f = await fixture({ 'thread/queue/start': (message, socket) => {
      socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'thread already has an active or pending turn' } }));
      return noResponse;
    } });
    await f.client.connect();
    await expect(f.client.startQueued(threadId, 'own-entry')).rejects.toMatchObject({ name: 'CodexThreadBusyError', reason: 'non_idle' });
    f.handlers['thread/queue/start'] = (message, socket) => {
      socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'queued submission not found: own-entry' } }));
      return noResponse;
    };
    await expect(f.client.startQueued(threadId, 'own-entry')).rejects.toMatchObject({ name: 'CodexRpcError' });
  });

  it('keeps an accepted but unconfirmed queue start uncertain without repeating it', async () => {
    const f = await fixture({ 'thread/queue/start': () => ({}) });
    await f.client.connect();
    await expect(f.client.startQueued(threadId, 'own-entry')).rejects.toMatchObject({ uncertain: true, code: 'queue-start-unconfirmed' });
    expect(f.calls.filter(call => call.method === 'thread/queue/start')).toHaveLength(1);
    expect(f.calls.some(call => call.method === 'thread/queue/add')).toBe(false);
  });

  it('exposes nullable canonical command IDs and terminates only a revalidated native terminal pair', async () => {
    const clientId = randomUUID();
    const terminals = [{ itemId: 'own-command', processId: '1234', command: 'never-export-this-command' },
      { itemId: 'foreign-command', processId: '5678', command: 'foreign-command-body' }];
    const f = await fixture({
      'server/diagnostics': () => ({ process: { id: 42 } }),
      'thread/turns/list': () => ({ data: [{ id: 'own-turn', status: 'inProgress', items: [
        { type: 'userMessage', clientId }, { type: 'commandExecution', id: 'own-command', processId: null },
      ] }], nextCursor: null }),
      'thread/backgroundTerminals/list': () => ({ data: terminals, nextCursor: null }),
      'thread/backgroundTerminals/terminate': () => ({ terminated: true }),
    });
    await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId)).toMatchObject({ turnId: 'own-turn', commandItems: [{ id: 'own-command', processId: null }] });
    expect(await f.client.backgroundTerminals(threadId)).toEqual({ serverId: 42, terminals: [
      { itemId: 'own-command', processId: '1234' }, { itemId: 'foreign-command', processId: '5678' },
    ] });
    await f.client.terminateBackgroundTerminal(threadId, { serverId: 42, itemId: 'own-command', processId: '1234' });
    expect(f.calls.filter(call => call.method === 'thread/backgroundTerminals/terminate').map(call => call.params))
      .toEqual([{ threadId, processId: '1234' }]);
    terminals[0].processId = '9999';
    await expect(f.client.terminateBackgroundTerminal(threadId, { serverId: 42, itemId: 'own-command', processId: '1234' })).rejects.toThrow();
    expect(f.calls.filter(call => call.method === 'thread/backgroundTerminals/terminate')).toHaveLength(1);
  });

  it('forwards approval requests and rejects responses after another client resolves them', async () => {
    const f = await fixture();
    await f.client.connect();
    const next = once(f.client, 'request');
    f.sockets[0].send(JSON.stringify({ id: 77, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn', itemId: 'item' } }));
    expect((await next)[0]).toMatchObject({ id: 77, method: 'item/commandExecution/requestApproval' });
    await f.client.respond(77, { decision: 'decline' });
    await until(() => f.responses.length === 1);
    expect(f.responses[0]).toEqual({ id: 77, result: { decision: 'decline' } });
    await expect(f.client.respond(77, { decision: 'accept' })).rejects.toThrow('уже завершён');
    const pending = once(f.client, 'request');
    f.sockets[0].send(JSON.stringify({ id: 'peer-approval', method: 'item/fileChange/requestApproval', params: {} }));
    await pending;
    const resolved = once(f.client, 'notification');
    f.sockets[0].send(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId, requestId: 'peer-approval' } }));
    await resolved;
    await expect(f.client.respond('peer-approval', { decision: 'accept' })).rejects.toThrow('уже завершён');
  });

  it('rejects a known unsupported interaction once with a JSON-RPC error', async () => {
    const f = await fixture();
    await f.client.connect();
    const request = once(f.client, 'request');
    f.sockets[0].send(JSON.stringify({ id: 'unsupported-tool', method: 'item/tool/call', params: { threadId } }));
    await request;
    await f.client.rejectRequest('unsupported-tool', 'This interaction is not supported by Rele.');
    await until(() => f.responses.length === 1);
    expect(f.responses[0]).toEqual({ id: 'unsupported-tool', error: { code: -32601, message: 'This interaction is not supported by Rele.' } });
    await expect(f.client.rejectRequest('unsupported-tool', 'Retry')).rejects.toThrow('уже завершён');
    await f.client.releaseThread(threadId);
    expect(f.calls.some(call => call.method === 'thread/unsubscribe')).toBe(false);
  });

  it('marks a lost enqueue acknowledgment uncertain and never replays it on reconnect', async () => {
    const f = await fixture({ 'thread/queue/add': (_message, socket) => { socket.terminate(); return noResponse; } });
    await f.client.connect();
    await expect(f.client.enqueue(threadId, 'Accepted before disconnect', randomUUID())).rejects.toBeInstanceOf(CodexTransportError);
    expect(f.client.status().connected).toBe(false);
    await f.client.connect();
    expect(f.client.status().connected).toBe(true);
    expect(f.calls.filter(call => call.method === 'thread/queue/add')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'thread/resume')).toHaveLength(2);
  });

  it.each(['ws://example.com:4500', 'ws://127.0.0.1/?token=secret', 'ws://user:secret@localhost', 'https://localhost'])('refuses a nonlocal or credential-bearing endpoint: %s', async endpoint => {
    const client = new CodexClient({ transport: 'websocket', endpoint, executable: 'codex' });
    await expect(client.connect()).rejects.toThrow('локальный');
    expect(client.status().connected).toBe(false);
  });
});

describe('Codex passive context', () => {
  it('rejects an unmatched shared profile before any context mutation or writer acquisition', async () => {
    const f = await fixture();
    await f.client.connect();
    const before = f.calls.length;
    await expect(f.client.injectContext(threadId, 'slack-entry', 'Passive Slack transcript')).rejects.toThrow('тем же профилем');
    expect(f.calls).toHaveLength(before);
  });

  it.each(['0.163.0', '0.163.0-alpha.10.2'])('injects raw user context into the same idle writer on verified %s without creating a turn', async version => {
    const f = await managedFixture({ version });
    await f.client.connect();
    await f.client.injectContext(threadId, 'slack-entry', 'Passive Slack transcript');
    const calls = await f.calls();
    const original = calls.find(call => call.method === 'thread/resume');
    expect(original?.params).toEqual({ threadId, excludeTurns: true });
    expect(calls.find(call => call.method === 'thread/read')?.params).toEqual({ threadId });
    expect(calls.find(call => call.method === 'thread/inject_items')?.params).toEqual({
      threadId, items: [{ type: 'message', id: 'rele_slack_slack-entry', role: 'user', content: [{ type: 'input_text', text: 'Passive Slack transcript' }] }],
    });
    const methods = calls.map(call => call.method);
    expect(methods.indexOf('thread/queue/list')).toBeLessThan(methods.indexOf('thread/resume'));
    expect(calls.filter(call => call.method === 'thread/queue/list').at(-1)?.params).toEqual({ threadId, limit: 1 });
    expect(methods.some(method => ['thread/start', 'thread/fork', 'turn/start', 'thread/queue/add'].includes(method ?? ''))).toBe(false);
    await f.client.releaseThread(threadId);
    expect((await f.calls()).filter(call => call.method === 'thread/unsubscribe')).toHaveLength(1);
  });

  it('keeps the exact runtime gate for passive context', async () => {
    const f = await managedFixture({ version: '0.163.0-alpha.10.3' });
    await f.client.connect();
    await expect(f.client.injectContext(threadId, 'entry', 'Context')).rejects.toThrow('проверенного Codex');
    expect((await f.calls()).some(call => ['thread/resume', 'thread/inject_items'].includes(call.method ?? ''))).toBe(false);
  });

  it.each(['pending', 'afterResume'] as const)('does not inject when the native queue is %s', async contextQueue => {
    const f = await managedFixture({ contextQueue });
    await f.client.connect();
    await expect(f.client.injectContext(threadId, 'entry', 'Context')).rejects.toMatchObject({
      name: 'CodexThreadBusyError', threadId, reason: 'queued_input', message: expect.stringContaining('очереди Codex'),
    });
    const calls = await f.calls();
    expect(calls.some(call => ['thread/inject_items', 'thread/queue/add', 'turn/start'].includes(call.method ?? ''))).toBe(false);
    if (contextQueue === 'pending') expect(calls.some(call => call.method === 'thread/resume')).toBe(false);
  });

  it.each(['busy', 'notLoaded'] as const)('does not inject when the thread readiness is %s', async contextRead => {
    const f = await managedFixture({ contextRead });
    await f.client.connect();
    await expect(f.client.injectContext(threadId, 'entry', 'Context')).rejects.toMatchObject({
      name: 'CodexThreadBusyError', threadId, reason: 'non_idle', message: expect.stringContaining('ещё не подтвердил'),
    });
    expect((await f.calls()).some(call => call.method === 'thread/inject_items')).toBe(false);
  });

  it('preserves the original writer ownership fence', async () => {
    const f = await managedFixture({ resume: 'busy' });
    await f.client.connect();
    await expect(f.client.injectContext(threadId, 'entry', 'Context')).rejects.toMatchObject({
      name: 'CodexThreadBusyError', threadId, reason: 'foreign_writer', message: expect.stringContaining('без выполняющейся задачи'),
    });
    expect((await f.calls()).some(call => call.method === 'thread/inject_items')).toBe(false);
  });

  it('fails closed if the read identity differs from the subscribed thread', async () => {
    const f = await managedFixture({ contextRead: 'wrong' });
    await f.client.connect();
    await expect(f.client.injectContext(threadId, 'entry', 'Context')).rejects.toMatchObject({ code: 'thread-identity-mismatch' });
    expect(f.client.status().connected).toBe(false);
    expect((await f.calls()).some(call => call.method === 'thread/inject_items')).toBe(false);
  });

  it('propagates unknown transport outcomes and never replays an injection itself', async () => {
    const f = await managedFixture({ dropInjectAck: true });
    await f.client.connect();
    await expect(f.client.injectContext(threadId, 'entry', 'Context')).rejects.toBeInstanceOf(CodexTransportError);
    await f.client.connect();
    expect((await f.calls()).filter(call => call.method === 'thread/inject_items')).toHaveLength(1);
    expect((await f.calls()).filter(call => call.method === 'thread/resume')).toHaveLength(1);
  });
});


async function sharedContextFixture(options: { persist?: boolean; dropAck?: boolean } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'Rele shared receipts '));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const sessions = path.join(home, 'sessions');
  await mkdir(sessions);
  const rolloutPath = path.join(sessions, 'synthetic.jsonl');
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: threadId } }) + '\n';
  await writeFile(rolloutPath, meta);
  const runtime = { userAgent: 'rele/0.163.0 (Fixture)', codexHome: home,
    platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
    platformOs: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform };
  const thread: typeof rawThread & { path?: string | null } = { ...rawThread, status: { ...rawThread.status }, path: rolloutPath };
  const pending: unknown[] = [];
  const f = await fixture({
    initialize: () => runtime,
    'thread/read': () => ({ thread }),
    'thread/inject_items': async (message, socket) => {
      const item = (message.params.items as unknown[])[0];
      pending.push(item);
      if (options.persist !== false) await appendFile(rolloutPath, JSON.stringify({ type: 'response_item', payload: item }) + '\n');
      if (options.dropAck) { options.dropAck = false; socket.terminate(); return noResponse; }
      return {};
    },
  }, home);
  return { ...f, home, rolloutPath, runtime, thread, pending, meta };
}

describe('Codex shared passive context receipts', () => {
  it('accepts only an exact durable raw item after ACK without creating a turn', async () => {
    const f = await sharedContextFixture();
    await f.client.connect();
    await f.client.injectContext(threadId, 'entry', 'Context');
    expect(f.calls.filter(call => call.method === 'thread/inject_items')).toHaveLength(1);
    expect(f.calls.find(call => call.method === 'thread/inject_items')?.params).toEqual({
      threadId, items: [{ type: 'message', id: 'rele_slack_entry', role: 'user', content: [{ type: 'input_text', text: 'Context' }] }],
    });
    expect(f.calls.some(call => ['thread/start', 'thread/fork', 'turn/start', 'thread/queue/add'].includes(call.method ?? ''))).toBe(false);
    expect(await readFile(f.rolloutPath, 'utf8')).toContain('rele_slack_entry');
  });

  it('reconciles a persisted injection after a lost ACK without appending it again', async () => {
    const f = await sharedContextFixture({ dropAck: true });
    await f.client.connect();
    await expect(f.client.injectContext(threadId, 'entry', 'Context')).rejects.toBeInstanceOf(CodexTransportError);
    expect(f.client.runtimeInfo()).toBeUndefined();
    await f.client.connect();
    const before = f.calls.length;
    await f.client.injectContext(threadId, 'entry', 'Context');
    expect(f.calls.filter(call => call.method === 'thread/inject_items')).toHaveLength(1);
    expect(f.calls.slice(before).map(call => call.method)).toEqual(['thread/read']);
  });

  it('keeps ACK-only context pending and confirms a later native flush on retry', async () => {
    const f = await sharedContextFixture({ persist: false });
    await f.client.connect();
    await expect(f.client.injectContext(threadId, 'entry', 'Context')).rejects.toThrow('сохранённая запись пока не подтверждена');
    expect(f.calls.filter(call => call.method === 'thread/inject_items')).toHaveLength(1);
    await appendFile(f.rolloutPath, JSON.stringify({ type: 'response_item', payload: f.pending[0] }) + '\n');
    await f.client.injectContext(threadId, 'entry', 'Context');
    expect(f.calls.filter(call => call.method === 'thread/inject_items')).toHaveLength(1);
  });

  it.each(['profile', 'platform', 'remote-home', 'missing-path', 'outside-path', 'wrong-thread'] as const)('rejects %s before acquiring a writer or mutating context', async failure => {
    const f = await sharedContextFixture();
    if (failure === 'profile') { f.runtime.codexHome = path.join(f.home, 'other-profile'); await mkdir(f.runtime.codexHome); }
    if (failure === 'platform') f.runtime.platformOs = 'remote-os' as typeof f.runtime.platformOs;
    if (failure === 'remote-home') f.runtime.codexHome = '//remote/profile';
    if (failure === 'missing-path') delete f.thread.path;
    if (failure === 'outside-path') { f.thread.path = path.join(f.home, 'outside.jsonl'); await writeFile(f.thread.path, f.meta); }
    if (failure === 'wrong-thread') f.thread.id = randomUUID();
    await f.client.connect();
    await expect(f.client.injectContext(threadId, 'entry', 'Context')).rejects.toThrow();
    expect(f.calls.some(call => ['thread/resume', 'thread/inject_items', 'turn/start', 'thread/queue/add'].includes(call.method ?? ''))).toBe(false);
  });

  it.each(['queue', 'active', 'notLoaded', 'unknown'] as const)('preserves the shared %s readiness guard', async condition => {
    const f = await sharedContextFixture();
    if (condition === 'queue') f.handlers['thread/queue/list'] = () => ({ data: [{ id: 'other', clientUserMessageId: 'other' }], nextCursor: null });
    else f.thread.status.type = condition;
    await f.client.connect();
    await expect(f.client.injectContext(threadId, 'entry', 'Context')).rejects.toMatchObject({ name: 'CodexThreadBusyError', reason: condition === 'queue' ? 'queued_input' : 'non_idle' });
    expect(f.calls.some(call => call.method === 'thread/inject_items')).toBe(false);
  });

  it.each(['failed', 'completed', 'interrupted'])('appends passive context after a confirmed %s turn leaves systemError without replaying that turn', async status => {
    const f = await sharedContextFixture();
    const previous = { id: 'previous-turn', status, completedAt: 1793004647, error: { codexErrorInfo: 'serverOverloaded' } };
    f.thread.status.type = 'systemError';
    f.handlers['thread/turns/list'] = () => ({ data: [previous], nextCursor: 'older-turns' });
    await f.client.connect();
    await f.client.injectContext(threadId, 'new-slack-entry', 'New agent context');
    expect(f.calls.find(call => call.method === 'thread/turns/list')?.params).toEqual({ threadId, limit: 1, itemsView: 'summary', sortDirection: 'desc' });
    expect(f.calls.filter(call => call.method === 'thread/inject_items')).toHaveLength(1);
    expect(await readFile(f.rolloutPath, 'utf8')).toContain('rele_slack_new-slack-entry');
    expect(previous).toEqual({ id: 'previous-turn', status, completedAt: 1793004647, error: { codexErrorInfo: 'serverOverloaded' } });
    expect(f.calls.some(call => ['thread/start', 'thread/fork', 'turn/start', 'turn/interrupt', 'thread/queue/add', 'thread/queue/start', 'thread/queue/delete'].includes(call.method ?? ''))).toBe(false);
  });

  it.each([
    [],
    [{ id: 'current', status: 'inProgress', completedAt: null }],
    [{ id: 'current', status: 'interrupted', completedAt: null }],
    [{ id: 'current', status: 'failed' }],
    [{ id: 'current', status: 'failed', completedAt: '1793004647' }],
    [{ id: 'current', status: 'unknown', completedAt: 1793004647 }],
    [{ status: 'failed', completedAt: 1793004647 }],
    [{ id: 1, status: 'failed', completedAt: 1793004647 }],
  ])('keeps systemError blocked without a confirmed terminal latest turn: %j', async (...data) => {
    const f = await sharedContextFixture();
    f.thread.status.type = 'systemError';
    f.handlers['thread/turns/list'] = () => ({ data, nextCursor: null });
    await f.client.connect();
    await expect(f.client.injectContext(threadId, 'entry', 'Context')).rejects.toMatchObject({ name: 'CodexThreadBusyError', reason: 'non_idle' });
    expect(f.calls.some(call => call.method === 'thread/inject_items')).toBe(false);
    expect(await readFile(f.rolloutPath, 'utf8')).toBe(f.meta);
  });

  it.each(['active', 'notLoaded', 'unknown'])('blocks passive context if terminal systemError changes to %s during verification', async status => {
    const f = await sharedContextFixture();
    f.thread.status.type = 'systemError';
    f.handlers['thread/turns/list'] = () => {
      f.thread.status.type = status;
      return { data: [{ id: 'old', status: 'failed', completedAt: 1793004647 }], nextCursor: null };
    };
    await f.client.connect();
    await expect(f.client.injectContext(threadId, 'entry', 'Context')).rejects.toMatchObject({ name: 'CodexThreadBusyError', reason: 'non_idle' });
    expect(f.calls.some(call => call.method === 'thread/inject_items')).toBe(false);
  });

  it('preserves a native message queued while terminal systemError is being verified', async () => {
    const f = await sharedContextFixture();
    let queued = false;
    f.thread.status.type = 'systemError';
    f.handlers['thread/turns/list'] = () => {
      queued = true;
      return { data: [{ id: 'old', status: 'failed', completedAt: 1793004647 }], nextCursor: null };
    };
    f.handlers['thread/queue/list'] = () => ({ data: queued ? [{ id: 'other', clientUserMessageId: 'other' }] : [], nextCursor: null });
    await f.client.connect();
    await expect(f.client.injectContext(threadId, 'entry', 'Context')).rejects.toMatchObject({ name: 'CodexThreadBusyError', reason: 'queued_input' });
    expect(f.calls.some(call => ['thread/inject_items', 'thread/queue/add', 'thread/queue/delete'].includes(call.method ?? ''))).toBe(false);
  });

  it('re-reads the exact native rollout path after ACK when the thread was archived', async () => {
    const f = await sharedContextFixture({ persist: false });
    const archive = path.join(f.home, 'archived_sessions');
    await mkdir(archive);
    const moved = path.join(archive, 'synthetic.jsonl');
    await writeFile(moved, f.meta);
    f.handlers['thread/inject_items'] = async message => {
      await appendFile(moved, JSON.stringify({ type: 'response_item', payload: (message.params.items as unknown[])[0] }) + '\n');
      f.thread.path = moved;
      return {};
    };
    await f.client.connect();
    await f.client.injectContext(threadId, 'entry', 'Context');
    expect(f.calls.filter(call => call.method === 'thread/inject_items')).toHaveLength(1);
    expect(await readFile(f.rolloutPath, 'utf8')).toBe(f.meta);
  });
});

describe('Codex managed runtime', () => {
  it('owns an NDJSON child, preserves the inherited profile and safely closes that process', async () => {
    vi.stubEnv('CODEX_HOME', path.join(tmpdir(), 'inherited Codex profile'));
    vi.stubEnv('RELE_CODEX_TEST_MARKER', 'inherited-sentinel');
    const f = await managedFixture();
    await f.client.connect();
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.client.status()).toMatchObject({ connected: true, transport: 'managed', executable: f.executable, queueSupported: true, codexHome: process.env.CODEX_HOME, desktopVerified: false });
    const [start] = await f.records();
    expect(start).toMatchObject({ argv: ['app-server', '--listen', 'stdio://', '-c', 'thread_unload_delay_secs=0'], home: process.env.CODEX_HOME, marker: 'inherited-sentinel' });
    expect((await f.client.listThreads())[0].id).toBe(threadId);
    expect((await f.calls()).some(call => call.method === 'thread/resume')).toBe(false);
    await f.client.close();
    expect(() => process.kill(start.pid!, 0)).toThrow();
  });

  it('chooses a managed CLI independently of the Desktop listener and applies only an explicit profile override', async () => {
    vi.stubEnv('CODEX_HOME', path.join(tmpdir(), 'original inherited profile'));
    vi.stubEnv('RELE_CODEX_TEST_MARKER', 'still-inherited');
    const codexHome = path.join(tmpdir(), 'explicit Codex profile');
    const f = await managedFixture({ auto: true, codexHome });
    await f.client.connect();
    expect(f.discover).toHaveBeenCalledWith({ codexHome });
    expect(f.client.runtimeInfo()?.codexHome).toBe(codexHome);
    expect((await f.records())[0]).toMatchObject({ home: codexHome, marker: 'still-inherited' });
    expect(process.env.CODEX_HOME).toContain('original inherited profile');
  });

  it.each([
    ['0.163.0-alpha.10.2', true],
    ['0.163.0-alpha.11.2', true],
    ['0.164.0-alpha.11.1', true],
    ['0.163.0-alpha.10.3', false],
    ['0.163.0-alpha.11.3', false],
    ['0.164.0-alpha.11', false],
    ['0.164.0-alpha.11.2', false],
    ['0.164.0-alpha.11.1.extra', false],
    ['0.163.0-alpha.11.2.extra', false],
    ['0.163.0-alpha.10.2.extra', false],
    ['0.163.0+custom', false],
  ])('keeps the complete runtime version %s in the exact write gate', async (version, verified) => {
    const f = await managedFixture({ version });
    await f.client.connect();
    expect(f.client.status()).toMatchObject({ name: `Codex ${version}`, queueSupported: verified, desktopVerified: false });
    if (verified) await expect(f.client.enqueue(threadId, 'Continue this thread', randomUUID())).resolves.toEqual({ queuedSubmissionId: 'queued' });
    else await expect(f.client.enqueue(threadId, 'Continue this thread', randomUUID())).rejects.toThrow('проверенного Codex');
    expect((await f.calls()).some(call => call.method === 'thread/queue/add')).toBe(verified);
  });

  it('reports a busy writer without forking, creating or seeding another conversation', async () => {
    const f = await managedFixture({ resume: 'busy' });
    await f.client.connect();
    const requestId = randomUUID();
    await expect(f.client.enqueue(threadId, 'Wait for Desktop', requestId)).rejects.toBeInstanceOf(CodexThreadBusyError);
    await expect(f.client.subscribe(threadId)).rejects.toMatchObject({ threadId, reason: 'foreign_writer' });
    expect(f.client.status().connected).toBe(true);
    const calls = await f.calls();
    expect(calls.filter(call => call.method === 'thread/resume').map(call => call.params)).toEqual([
      { threadId, excludeTurns: true }, { threadId, excludeTurns: true },
    ]);
    expect(calls.some(call => ['thread/start', 'thread/fork', 'turn/start', 'thread/queue/add'].includes(call.method ?? ''))).toBe(false);
  });

  it('fails closed when resume returns another thread identity', async () => {
    const f = await managedFixture({ resume: 'wrong' });
    await f.client.connect();
    await expect(f.client.enqueue(threadId, 'Keep the original thread', randomUUID())).rejects.toMatchObject({ code: 'thread-identity-mismatch' });
    expect(f.client.status().connected).toBe(false);
    expect((await f.calls()).some(call => ['thread/start', 'thread/fork', 'thread/queue/add'].includes(call.method ?? ''))).toBe(false);
  });

  it('handles thread/closed before the unsubscribe acknowledgment without reloading automatically', async () => {
    const f = await managedFixture({ release: 'early' });
    await f.client.connect();
    await f.client.subscribe(threadId);
    const released = f.client.releaseThread(threadId);
    expect(f.client.releaseThread(threadId)).toBe(released);
    await released;
    await f.client.readThread(threadId);
    expect((await f.calls()).filter(call => call.method === 'thread/resume')).toHaveLength(1);
    expect((await f.calls()).filter(call => call.method === 'thread/unsubscribe')).toHaveLength(1);
    await f.client.subscribe(threadId);
    expect((await f.calls()).filter(call => call.method === 'thread/resume')).toHaveLength(2);
  });

  it('waits for actual closure after the ack and blocks a concurrent subscribe until closure', async () => {
    const f = await managedFixture({ release: 'delayed' });
    await f.client.connect();
    await f.client.subscribe(threadId);
    let released = false;
    const release = f.client.releaseThread(threadId).then(() => { released = true; });
    const subscribe = f.client.subscribe(threadId);
    await f.client.readThread('fixture-barrier');
    expect(released).toBe(false);
    expect((await f.calls()).filter(call => call.method === 'thread/resume')).toHaveLength(1);
    await f.client.readThread('fixture-release-now');
    await Promise.all([release, subscribe]);
    expect((await f.calls()).filter(call => call.method === 'thread/resume')).toHaveLength(2);
  });

  it('accepts notLoaded as a completed release', async () => {
    const f = await managedFixture({ release: 'notLoaded' });
    await f.client.connect();
    await f.client.releaseThread(threadId);
    expect(f.client.status().connected).toBe(true);
  });

  it('stops its own child on a missing close notification before allowing a new runtime', async () => {
    const f = await managedFixture({ release: 'silent', releaseTimeoutMs: 50 });
    await f.client.connect();
    await f.client.subscribe(threadId);
    const [start] = await f.records();
    await expect(f.client.releaseThread(threadId)).rejects.toMatchObject({ code: 'thread-release-timeout' });
    expect(f.client.status().connected).toBe(false);
    expect(() => process.kill(start.pid!, 0)).toThrow();
    await f.client.connect();
    expect((await f.calls()).filter(call => call.method === 'thread/resume')).toHaveLength(1);
    await f.client.subscribe(threadId);
    expect((await f.calls()).filter(call => call.method === 'thread/resume')).toHaveLength(2);
  });

  it('never replays an uncertain submission or reacquires remembered threads during managed reconnect', async () => {
    const f = await managedFixture({ dropAck: true });
    await f.client.connect();
    await expect(f.client.enqueue(threadId, 'Accepted before exit', randomUUID())).rejects.toBeInstanceOf(CodexTransportError);
    await f.client.connect();
    expect(f.client.status().connected).toBe(true);
    const calls = await f.calls();
    expect(calls.filter(call => call.method === 'thread/resume')).toHaveLength(1);
    expect(calls.filter(call => call.method === 'thread/queue/add')).toHaveLength(1);
  });

  it('rejects malformed child output without returning stdout or stderr content', async () => {
    const f = await managedFixture({ malformed: true });
    await expect(f.client.connect()).rejects.toMatchObject({ code: 'invalid-protocol' });
    expect(JSON.stringify(f.client.status())).not.toMatch(/synthetic-secret|malformed-json/u);
    expect(f.client.status().connected).toBe(false);
  });
});
