import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { CodexClient, CodexSteerRefusedError, CodexThreadBusyError, CodexTransportError, classifyCodexConnectionFailure, type CodexNotification } from '../src/server/codex.js';
import { SharedCodexError } from '../src/server/codex-shared.js';
import { Engine } from '../src/server/engine.js';
import { Store } from '../src/server/store.js';
import { defaultConfig } from '../src/server/config.js';
import { codexNativeGeneration, type CodexNativePeer } from '../src/server/codex-native-generation.js';
import { initialMessageKey } from '../src/server/initial-message.js';
import { asyncQuestions, encodeAsyncAnswers } from '../src/server/async-questions.js';
import type { Endpoint } from '../src/shared/types.js';
import { promisify } from 'node:util';

const execute = promisify(execFile);

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
  diagnosticPid?: 'parent';
  terminals?: boolean;
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
        case 'server/diagnostics': reply({ process: { id: options.diagnosticPid === 'parent' ? process.ppid : process.pid }, gauges: [] }); break;
        case 'thread/backgroundTerminals/list': reply({ data: options.terminals ? [{ itemId:'fixture-command', processId:'1234' }] : [], nextCursor: null }); break;
        case 'thread/backgroundTerminals/terminate': reply({ terminated:true }); break;
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

async function fixture(handlers: Record<string, Handler> = {}, codexHome?: string, options: NonNullable<ConstructorParameters<typeof CodexClient>[1]> = {}, autoPong = true) {
  const calls: Rpc[] = [], responses: Rpc[] = [], sockets: WebSocket[] = [];
  const turnItems = new Map<string, unknown[]>();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong });
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
    'thread/items/list': request => {
      const items = turnItems.get(String(request.params.turnId)) ?? [], index = Number(request.params.cursor ?? 0);
      return { data: items.slice(index, index + 1).map(item => ({ turnId: request.params.turnId, item })),
        nextCursor: index + 1 < items.length ? String(index + 1) : null };
    },
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
      let result = await handler(message, socket);
      if (message.method === 'thread/turns/list' && message.params.itemsView === 'notLoaded' && result && typeof result === 'object' && 'data' in result) {
        const page = result as { data: { id: string; items?: unknown[] }[] };
        result = { ...page, data: page.data.map(turn => {
          turnItems.set(turn.id, turn.items ?? []);
          return { ...turn, items: [] };
        }) };
      }
      if (result !== noResponse && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new CodexClient({ transport: 'websocket', executable: 'codex', endpoint, codexHome }, options);
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

describe('native source controls', () => {
  it('recovers an exact recorded Goal turn beyond the latest page without mixing newer turns', async () => {
    const f = await fixture({ 'thread/turns/list': message => message.params.cursor === 'older'
      ? { data: [{ id: 'old-goal-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'old-result', phase: 'final_answer', text: 'Owned old result' }] }], nextCursor: null }
      : { data: [{ id: 'newer-foreign-turn', status: 'completed', items: [{ type: 'userMessage', clientId: 'other' }] }], nextCursor: 'older' } });
    await f.client.connect();
    expect(await f.client.controlTurns(threadId, ['old-goal-turn'])).toMatchObject([{ id: 'old-goal-turn', items: [{ text: 'Owned old result' }] }]);
  });
  it('reads configuration and Goal capability without resuming or starting work', async () => {
    const f = await fixture({
      'thread/read': () => ({ thread: { ...rawThread, model: 'fixture-model', reasoningEffort: 'high' } }),
      'experimentalFeature/list': () => ({ data: [{ name: 'goals', enabled: true }], nextCursor: null }),
      'thread/goal/get': () => ({ goal: null }),
    });
    await f.client.connect();
    const before = f.calls.length;
    expect(await f.client.controlSnapshot(threadId)).toMatchObject({ model: 'fixture-model', effort: 'high', runtimeStatus: 'idle', goalSupported: true, goal: null, queued: 0 });
    expect(f.calls.slice(before).map(call => call.method)).not.toContain('thread/resume');
    expect(f.calls.slice(before).some(call => ['turn/start', 'thread/queue/add', 'thread/goal/set'].includes(call.method ?? ''))).toBe(false);
  });

  it('checks each model effort and changes only future thread defaults, without an inference probe', async () => {
    const f = await fixture({
      'model/list': () => ({ data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }], nextCursor: null }),
      'thread/settings/update': () => ({}),
    });
    await f.client.connect();
    await expect(f.client.updateControlModel(threadId, 'fixture-model', 'low')).rejects.toThrow();
    expect(f.calls.some(call => call.method === 'thread/settings/update')).toBe(false);
    await f.client.updateControlModel(threadId, 'fixture-model', 'high');
    expect(f.calls.filter(call => call.method === 'thread/settings/update').map(call => call.params)).toEqual([{ threadId, model: 'fixture-model', effort: 'high' }]);
    expect(f.calls.some(call => ['turn/start', 'turn/settings/update', 'thread/resume'].includes(call.method ?? ''))).toBe(false);
  });
  it('revalidates admission after the model catalog await and before settings/update', async () => {
    let admitted = true;
    const f = await fixture({ 'model/list': () => {
      admitted = false;
      return { data: [{ model: 'fixture-model', displayName: 'Fixture', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }], nextCursor: null };
    }, 'thread/settings/update': () => ({}) });
    await f.client.connect();
    await expect(f.client.updateControlModel(threadId, 'fixture-model', 'high', () => { if (!admitted) throw new Error('Source revoked'); })).rejects.toThrow('Source revoked');
    expect(f.calls.some(call => call.method === 'thread/settings/update')).toBe(false);
  });

  it('uses native user-origin Goal mutations, preserves zero accounting, and rejects malformed snapshots', async () => {
    const goal = { threadId, objective: 'Ship\nDone: tests pass', status: 'active', tokenBudget: 5000, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 100, updatedAt: 100 };
    const f = await fixture({ 'thread/goal/set': message => ({ goal: { ...goal, status: message.params.status ?? 'active' } }) });
    await f.client.connect();
    expect(await f.client.updateControlGoal(threadId, { objective: goal.objective, tokenBudget: 5000 })).toEqual(goal);
    expect(await f.client.updateControlGoal(threadId, { status: 'paused' })).toMatchObject({ status: 'paused' });
    expect(f.calls.filter(call => call.method === 'thread/goal/set').map(call => call.params)).toEqual([
      { threadId, origin: 'user', objective: goal.objective, tokenBudget: 5000 }, { threadId, origin: 'user', status: 'paused' },
    ]);
    await expect(f.client.updateControlGoal(threadId, { objective: ' ' })).rejects.toThrow();
    f.handlers['thread/goal/set'] = () => ({ goal: { ...goal, threadId: 'other' } });
    await expect(f.client.updateControlGoal(threadId, { status: 'paused' })).rejects.toThrow();
  });
});

describe('Codex socket health', () => {
  it('invalidates a socket without matching pongs, preserves another client and permits a fresh connection', async () => {
    const f = await fixture({}, undefined, { heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60 }, false);
    await f.client.connect();
    const first = f.sockets[0], peer = new WebSocket(f.endpoint); cleanup.push(() => peer.terminate()); await once(peer, 'open');
    await until(() => !f.client.status().connected);
    expect(f.client.status()).toMatchObject({ connected: false, queueSupported: false, errorCode: 'heartbeat-timeout' });
    expect(peer.readyState).toBe(WebSocket.OPEN);
    await f.client.connect();
    expect(f.client.status()).toMatchObject({ connected: true, queueSupported: true, errorCode: undefined });
    expect(f.sockets.at(-1)).not.toBe(first);
    expect(f.calls.filter(call => call.method === 'initialize')).toHaveLength(2);
    expect(f.calls.some(call => ['turn/start', 'turn/interrupt', 'thread/queue/add'].includes(call.method ?? ''))).toBe(false);
  });

  it('keeps a quiet long-running connection and pending question alive while pongs arrive, then cleans up on close', async () => {
    const f = await fixture({}, undefined, { heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60 }); await f.client.connect();
    const socket = f.sockets[0]; let pings = 0; socket.on('ping', () => pings++);
    socket.send(JSON.stringify({ id: 'long-turn-question', method: 'item/tool/requestUserInput', params: { threadId } }));
    await until(() => f.client.hasPendingRequest('long-turn-question'));
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(pings).toBeGreaterThanOrEqual(3); expect(f.sockets).toHaveLength(1);
    expect(f.client.status()).toMatchObject({ connected: true, queueSupported: true });
    await f.client.respond('long-turn-question', { answers: {} }); await until(() => f.responses.length === 1);
    const closed = once(socket, 'close'); await f.client.close(); await closed; const count = pings;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(pings).toBe(count); expect(f.sockets).toHaveLength(1); expect(f.client.status().connected).toBe(false);
  });

  it('marks an unanswered mutation uncertain and disconnects after one failed application probe even while pongs arrive', async () => {
    const clientId = randomUUID(), f = await fixture({ 'thread/queue/add': () => noResponse, 'server/diagnostics': () => noResponse }, undefined,
      { rpcTimeoutMs: 30, heartbeatIntervalMs: 15, heartbeatTimeoutMs: 80 });
    await f.client.connect();
    await expect(f.client.enqueue(threadId, 'Accepted input with lost ACK', clientId)).rejects.toMatchObject({ uncertain: true, code: 'rpc-timeout' });
    expect(f.client.status()).toMatchObject({ connected: true, queueSupported: false, errorCode: 'rpc-timeout' });
    await until(() => !f.client.status().connected);
    expect(f.client.status().errorCode).toBe('rpc-health-timeout');
    expect(f.calls.filter(call => call.method === 'server/diagnostics')).toHaveLength(1);
    f.handlers['thread/queue/list'] = () => ({ data: [{ id: 'native-accepted', clientUserMessageId: clientId }], nextCursor: null });
    await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId)).toEqual({ state: 'queued', queuedSubmissionId: 'native-accepted', soleQueuedSubmission: true });
    expect(f.calls.filter(call => call.method === 'thread/queue/add')).toHaveLength(1);
    expect(f.calls.some(call => ['turn/start', 'thread/queue/start', 'turn/interrupt'].includes(call.method ?? ''))).toBe(false);
  });

  it('preserves the same socket and pending question after a healthy timeout probe without replaying the mutation', async () => {
    let confirm!: (value: unknown) => void;
    const answer = new Promise(resolve => { confirm = resolve; });
    const f = await fixture({ 'thread/queue/add': () => noResponse, 'server/diagnostics': () => answer }, undefined,
      { rpcTimeoutMs: 30, heartbeatIntervalMs: 20, heartbeatTimeoutMs: 200 });
    await f.client.connect(); const socket = f.sockets[0];
    socket.send(JSON.stringify({ id: 'retained-question', method: 'item/tool/requestUserInput', params: { threadId } }));
    await until(() => f.client.hasPendingRequest('retained-question'));
    await expect(f.client.enqueue(threadId, 'Slow mutation', randomUUID())).rejects.toMatchObject({ code: 'rpc-timeout' });
    expect(f.client.status().queueSupported).toBe(false);
    await expect(f.client.enqueue(threadId, 'Next input', randomUUID())).rejects.toThrow('приостановлены');
    confirm({ process: { id: 42 } });
    await until(() => f.client.status().queueSupported);
    expect(f.client.status()).toMatchObject({ connected: true, error: undefined, errorCode: undefined });
    expect(f.client.hasPendingRequest('retained-question')).toBe(true);
    await f.client.respond('retained-question', { answers: {} });
    expect(f.sockets).toHaveLength(1); expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(f.calls.filter(call => call.method === 'thread/queue/add')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'server/diagnostics')).toHaveLength(1);
  });

  it('shares one bounded health probe across concurrent RPC timeouts', async () => {
    const f = await fixture({ 'server/diagnostics': () => noResponse }, undefined,
      { rpcTimeoutMs: 30, heartbeatIntervalMs: 15, heartbeatTimeoutMs: 80 });
    await f.client.connect(); f.handlers['thread/read'] = f.handlers['thread/list'] = () => noResponse;
    const outcomes = await Promise.allSettled([f.client.readThread(threadId), f.client.listThreads()]);
    expect(outcomes.every(outcome => outcome.status === 'rejected' && outcome.reason instanceof CodexTransportError)).toBe(true);
    await until(() => !f.client.status().connected);
    expect(f.calls.filter(call => call.method === 'server/diagnostics')).toHaveLength(1);
  });

  it('preserves a newer capability failure on the same socket when the healthy probe completes', async () => {
    let confirm!: (value: unknown) => void;
    const answer = new Promise(resolve => { confirm = resolve; }), createdId = randomUUID();
    const f = await fixture({ 'thread/read': () => noResponse, 'server/diagnostics': () => answer,
      'thread/start': () => ({ thread: { ...rawThread, id: createdId } }),
      'thread/queue/list': (message, socket) => {
        if (message.params.threadId !== createdId) return { data: [], nextCursor: null };
        socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Queue unsupported for this runtime' } })); return noResponse;
      },
    }, undefined, { rpcTimeoutMs: 30, heartbeatIntervalMs: 20, heartbeatTimeoutMs: 200 });
    await f.client.connect();
    await expect(f.client.readThread(threadId)).rejects.toMatchObject({ code: 'rpc-timeout' });
    expect(f.client.status().queueSupported).toBe(false);
    expect(await f.client.createThread('/new-project')).toBe(createdId);
    const newer = f.client.status();
    expect(newer).toMatchObject({ connected: true, queueSupported: false, error: expect.stringContaining('не предоставляет очередь') });
    confirm({ process: { id: 42 } }); await f.client.diagnostics();
    expect(f.client.status()).toEqual(newer); expect(f.sockets).toHaveLength(1);
  });
});

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

  it('keeps the post-update expected version enforced across reconnects before any catalog, plugin or queue work', async () => {
    const f = await sharedFixture();
    const setupPlugin = vi.fn(async () => {});
    const client = new CodexClient(f.target, { shared: f.shared, expectedVersion: '0.166.0-alpha.5.1', setupPlugin });
    cleanup.push(() => client.close());
    await expect(client.connect()).rejects.toMatchObject({ code: 'update-version-mismatch' });
    expect(client.status()).toMatchObject({ connected: false, queueSupported: false });
    expect(f.calls.map(call => call.method)).toEqual(['initialize', 'initialized']);
    expect(setupPlugin).not.toHaveBeenCalled();
    f.handlers.initialize = () => ({ userAgent: 'codex/0.166.0-alpha.5.1 (Fixture)', codexHome: f.home,
      platformFamily: process.platform === 'win32' ? 'windows' : 'unix', platformOs: process.platform === 'win32' ? 'windows' : process.platform });
    await client.connect();
    expect(client.status()).toMatchObject({ connected: true, queueSupported: true, name: 'Codex 0.166.0-alpha.5.1' });
    expect(f.calls.some(call => ['thread/queue/add', 'turn/start'].includes(call.method ?? ''))).toBe(false);
  });

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

  it('keeps the live connection while changing selection and uses the new policy on reconnect', async () => {
    const f = await sharedFixture();
    await f.client.connect();
    const actual = f.client.status();
    for (const executable of [path.join(f.home, 'chosen-codex'), 'codex']) {
      const count = f.shared.mock.calls.length;
      f.client.setSharedExecutable(executable);
      expect(f.shared).toHaveBeenCalledTimes(count);
      expect(f.client.status()).toEqual(actual);
      await f.client.close(); await f.client.connect();
      expect(f.shared.mock.lastCall?.[0]).toMatchObject({ executable, transport: 'shared', codexHome: f.home });
      expect(f.client.status()).toEqual(actual);
    }
    expect(() => f.client.setSharedExecutable('')).toThrow('общего Codex');
    expect(() => f.peer.setSharedExecutable('codex')).toThrow('общего Codex');
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
    const sessions = path.join(f.home, 'sessions'); await mkdir(sessions);
    const rollout = path.join(sessions, 'synthetic-context.jsonl');
    await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: threadId } }) + '\n');
    const contextHandlers: Record<string, Handler> = {
      'thread/read': () => ({ thread: { ...rawThread, path: rollout } }),
      'thread/inject_items': async message => {
        for (const item of message.params.items as unknown[]) await appendFile(rollout, JSON.stringify({ type: 'response_item', payload: item }) + '\n');
        return {};
      },
      'thread/unsubscribe': () => ({ status: 'notLoaded' }),
    };
    Object.assign(f.handlers, contextHandlers);
    let acceptedId = '', nextId = '';
    f.handlers['server/diagnostics'] = () => ({ process: { id: 41 }, gauges: [] });
    f.handlers['thread/backgroundTerminals/list'] = () => ({ data: [], nextCursor: null });
    f.handlers['thread/queue/add'] = (message, socket) => { acceptedId = String(message.params.clientUserMessageId); socket.close(); return noResponse; };
    const replacement = await fixture({ ...contextHandlers, initialize: () => runtime,
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
    store.setMeta(initialMessageKey(f.home, threadId), JSON.stringify({ applied: true }));
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

  it('keeps a Slack image in the same native queue submission as its attributed text', async () => {
    const f = await fixture({ 'thread/queue/add': () => ({ queuedSubmission: { id: 'image-queue-id' } }) });
    const clientId = randomUUID(), url = 'data:image/png;base64,iVBORw0KGgo=';
    await f.client.connect();
    await f.client.enqueue(threadId, 'Slack screenshot', clientId, [url]);
    expect(f.calls.filter(call => call.method === 'thread/queue/add').map(call => call.params)).toEqual([
      { threadId, clientUserMessageId: clientId, input: [{ type: 'text', text: 'Slack screenshot' }, { type: 'image', url }] },
    ]);
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
    ['failed', 'contextWindowExceeded', 'contextWindowExceeded'],
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

  it.each([
    ['failed', 'other', 'Your input exceeds the context window of this model. Please adjust your input and try again.', null, 'contextWindowExceeded'],
    ['failed', 'other', 'synthetic-provider-secret: Your input exceeds the context window of this model. Please adjust your input and try again. (provider wrapper)', null, 'contextWindowExceeded'],
    ['failed', 'other', 'Error running remote compact task: HTTP400 synthetic-provider-secret: Your input exceeds the context window of this model. Please adjust your input and try again.', null, 'contextCompactionFailed'],
    ['failed', 'other', 'Error running remote compact task: unrelated provider failure', null, undefined],
    ['failed', 'other', 'Provider reported an unrelated context error', null, undefined],
    ['failed', 'other', 'Unknown provider error', '{"error":{"code":"context_length_exceeded"}}', undefined],
    ['failed', 'badRequest', 'Your input exceeds the context window of this model. Please adjust your input and try again.', null, undefined],
    ['completed', 'other', 'Your input exceeds the context window of this model. Please adjust your input and try again.', null, undefined],
  ])('classifies only a failed native context error (%s/%s)', async (status, codexErrorInfo, message, additionalDetails, failureReason) => {
    const clientId = randomUUID();
    const f = await fixture({ 'thread/turns/list': () => ({ data: [{ id: 'context-turn', status, error: { codexErrorInfo, message, additionalDetails },
      items: [{ type: 'userMessage', clientId }, { type: 'agentMessage', phase: 'commentary', text: 'Assistant can mention context_length_exceeded without classifying an error.' }] }], nextCursor: null }) });
    await f.client.connect(); const found = await f.client.findRequest(threadId, clientId);
    expect(found.failureReason).toBe(failureReason); expect(JSON.stringify(found)).not.toContain('synthetic-provider-secret');
    expect(f.calls.some(call => ['turn/start', 'thread/queue/add', 'thread/fork', 'thread/compact/start'].includes(call.method ?? ''))).toBe(false);
  });

  it('does not interpret assistant text as a native context error', async () => {
    const clientId = randomUUID(), message = 'Error running remote compact task: Your input exceeds the context window of this model. Please adjust your input and try again.';
    const f = await fixture({ 'thread/turns/list': () => ({ data: [{ id: 'generic-turn', status: 'failed', error: { codexErrorInfo: 'other', message: 'Unknown error' },
      items: [{ type: 'userMessage', clientId }, { type: 'agentMessage', phase: 'final_answer', text: message }] }], nextCursor: null }) });
    await f.client.connect(); expect(await f.client.findRequest(threadId, clientId)).toMatchObject({ state: 'failed', text: message });
    expect((await f.client.findRequest(threadId, clientId)).failureReason).toBeUndefined();
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
        { id: 'comment-1', type: 'agentMessage', phase: 'commentary', text: 'Работаю' },
        { type: 'agentMessage', phase: 'final_answer', text: 'Готовый ответ' },
      ] }], nextCursor: null }
      : { data: [], nextCursor: 'older' };
    expect(await f.client.findRequest(threadId, clientId)).toEqual({ state: 'completed', turnId: 'completed-turn', text: 'Готовый ответ', commentary: [{ id: 'completed-turn:comment-1', text: 'Работаю' }] });
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
    await expect(f.client.terminateBackgroundTerminal(threadId, { serverId: 42, itemId: 'own-command', processId: '1234' }))
      .rejects.toMatchObject({ identityFailure: 'terminal-process-changed' });
    terminals.push({ itemId: 'own-command', processId: '1111', command: 'duplicate-command-body' });
    await expect(f.client.terminateBackgroundTerminal(threadId, { serverId: 42, itemId: 'own-command', processId: '1234' }))
      .rejects.toMatchObject({ identityFailure: 'terminal-ambiguous' });
    expect(f.calls.filter(call => call.method === 'thread/backgroundTerminals/terminate')).toHaveLength(1);
  });

  it('does not terminate a process when the exact background terminal already disappeared', async () => {
    const generation = 'a'.repeat(64);
    const f = await fixture({
      'server/diagnostics': () => ({ process: { id: 42 }, gauges: [] }),
      'thread/backgroundTerminals/terminate': () => ({ terminated: true }),
    });
    await f.client.connect();
    const terminateCalls = f.calls.filter(call => call.method === 'thread/backgroundTerminals/terminate').length;
    vi.spyOn(f.client, 'backgroundTerminals')
      .mockResolvedValueOnce({ serverId: 42, serverGeneration: generation, terminals: [{ itemId: 'own-command', processId: '1234' }] })
      .mockResolvedValueOnce({ serverId: 42, serverGeneration: generation, terminals: [] });
    const snapshot = await f.client.backgroundTerminals(threadId);
    await expect(f.client.terminateBackgroundTerminal(threadId, { ...snapshot.terminals[0], serverId:snapshot.serverId, serverGeneration:generation })).resolves.toBeUndefined();
    expect(f.calls.filter(call => call.method === 'thread/backgroundTerminals/terminate')).toHaveLength(terminateCalls);
  });

  it('forwards approval requests and rejects responses after another client resolves them', async () => {
    const f = await fixture();
    await f.client.connect();
    const next = once(f.client, 'request');
    f.sockets[0].send(JSON.stringify({ id: 77, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn', itemId: 'item' } }));
    expect((await next)[0]).toMatchObject({ id: 77, method: 'item/commandExecution/requestApproval' });
    expect(f.client.hasPendingRequest(77)).toBe(true);
    expect(f.client.hasPendingRequest('77')).toBe(false);
    await f.client.respond(77, { decision: 'decline' });
    await until(() => f.responses.length === 1);
    expect(f.responses[0]).toEqual({ id: 77, result: { decision: 'decline' } });
    await expect(f.client.respond(77, { decision: 'accept' })).rejects.toThrow('уже завершён');
    expect(f.client.hasPendingRequest(77)).toBe(false);
    const pending = once(f.client, 'request');
    f.sockets[0].send(JSON.stringify({ id: 'peer-approval', method: 'item/fileChange/requestApproval', params: {} }));
    await pending;
    const resolved = once(f.client, 'notification');
    f.sockets[0].send(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId, requestId: 'peer-approval' } }));
    await resolved;
    expect(f.client.hasPendingRequest('peer-approval')).toBe(false);
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
      threadId, items: [{ type: 'message', id: expect.stringMatching(/^rele-context-[a-f0-9]{48}$/u), role: 'user', content: [{ type: 'input_text', text: 'Passive Slack transcript' }] }],
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
      threadId, items: [{ type: 'message', id: expect.stringMatching(/^rele-context-[a-f0-9]{48}$/u), role: 'user', content: [{ type: 'input_text', text: 'Context' }] }],
    });
    expect(f.calls.some(call => ['thread/start', 'thread/fork', 'turn/start', 'thread/queue/add'].includes(call.method ?? ''))).toBe(false);
    expect(await readFile(f.rolloutPath, 'utf8')).toContain('rele-context-');
    expect(await readFile(f.rolloutPath, 'utf8')).not.toContain('rele_slack_entry');
    expect((f.pending[0] as { id: string }).id).toBe(`rele-context-${createHash('sha256').update(JSON.stringify([threadId, 'entry'])).digest('hex').slice(0, 48)}`);
  });

  it.each([
    `msg_${'a'.repeat(48)}`, `rele_context_${'a'.repeat(48)}`, `rele-context-${'a'.repeat(47)}_`,
    `rele-context-${'A'.repeat(48)}`, `rele-context-${'a'.repeat(47)}`, `rele-context-${'a'.repeat(49)}`,
    'msg_input_018f9e15-7a6a-7000-8000-000000000001',
  ])('rejects unsafe or non-owned supplied IDs before any context RPC: %s', async itemId => {
    const f = await sharedContextFixture(); await f.client.connect(); const before = f.calls.length;
    await expect(f.client.injectContext(threadId, 'entry', 'Context', { itemId, entries: [] })).rejects.toThrow('идентификаторы');
    expect(f.calls.slice(before)).toEqual([]);
  });

  it('reconciles the previous three-argument msg receipt without reinjecting or changing raw history', async () => {
    const f = await sharedContextFixture();
    const previousId = `msg_${createHash('sha256').update(JSON.stringify([threadId, 'old-entry'])).digest('hex').slice(0, 48)}`;
    await appendFile(f.rolloutPath, JSON.stringify({ type: 'response_item', payload: { type: 'message', id: previousId,
      role: 'user', content: [{ type: 'input_text', text: 'Exact previous context' }] } }) + '\n');
    const original = await readFile(f.rolloutPath);
    await f.client.connect(); const before = f.calls.length;
    await f.client.injectContext(threadId, 'old-entry', 'Exact previous context');
    expect(f.calls.slice(before).map(call => call.method)).toEqual(['thread/read']);
    expect(await readFile(f.rolloutPath)).toEqual(original);
  });

  it.each(['legacy', 'msg', 'local'])('reconciles a migrated %s alias before acquiring a writer or appending', async format => {
    const f = await sharedContextFixture(), itemId = `rele-context-${'b'.repeat(48)}`, oldText = 'Original quote with the old journal provenance';
    const persistedId = format === 'legacy' ? 'rele_slack_old-entry' : format === 'msg' ? `msg_${'b'.repeat(48)}` : itemId;
    await appendFile(f.rolloutPath, JSON.stringify({ type: 'response_item', payload: { type: 'message', id: persistedId,
      role: 'user', content: [{ type: 'input_text', text: oldText }] } }) + '\n');
    const beforeFile = await readFile(f.rolloutPath);
    await f.client.connect(); const before = f.calls.length;
    await f.client.injectContext(threadId, 'canonical-entry', 'Canonical quote', { itemId, entries: [{ entryId: 'old-entry', text: oldText }] });
    expect(f.calls.slice(before).map(call => call.method)).toEqual(['thread/read']);
    expect(await readFile(f.rolloutPath)).toEqual(beforeFile);
  });

  it.each(['local', 'msg'])('reconciles an entry-derived %s receipt after semantic-ID and quote migration', async format => {
    const f = await sharedContextFixture(), itemId = `rele-context-${'e'.repeat(48)}`;
    const digest = createHash('sha256').update(JSON.stringify([threadId, 'old-entry'])).digest('hex').slice(0, 48);
    const persistedId = format === 'local' ? `rele-context-${digest}` : `msg_${digest}`;
    await appendFile(f.rolloutPath, JSON.stringify({ type: 'response_item', payload: { type: 'message', id: persistedId,
      role: 'user', content: [{ type: 'input_text', text: 'Exact full legacy quote' }] } }) + '\n');
    const beforeFile = await readFile(f.rolloutPath); await f.client.connect(); const before = f.calls.length;
    await f.client.injectContext(threadId, 'canonical-entry', 'Compact quote', { itemId, entries: [{ entryId: 'old-entry', text: 'Exact full legacy quote' }] });
    expect(f.calls.slice(before).map(call => call.method)).toEqual(['thread/read']);
    expect(await readFile(f.rolloutPath)).toEqual(beforeFile);
  });

  it('reconciles a new-ID lost ACK even when the canonical journal entry changes', async () => {
    const f = await sharedContextFixture({ dropAck: true }), itemId = `rele-context-${'c'.repeat(48)}`;
    await f.client.connect();
    await expect(f.client.injectContext(threadId, 'old-entry', 'Old exact quote', { itemId, entries: [] })).rejects.toBeInstanceOf(CodexTransportError);
    await f.client.connect(); const before = f.calls.length;
    await f.client.injectContext(threadId, 'canonical-entry', 'Canonical quote', { itemId, entries: [{ entryId: 'old-entry', text: 'Old exact quote' }] });
    expect(f.calls.slice(before).map(call => call.method)).toEqual(['thread/read']);
    expect(f.calls.filter(call => call.method === 'thread/inject_items')).toHaveLength(1);
  });

  it.each(['legacy', 'msg', 'entry-local', 'entry-msg'])('does not accept %s alias provenance with another exact text', async format => {
    const f = await sharedContextFixture(), itemId = `rele-context-${'d'.repeat(48)}`;
    const digest = createHash('sha256').update(JSON.stringify([threadId, 'old-entry'])).digest('hex').slice(0, 48);
    const persistedId = format === 'legacy' ? 'rele_slack_old-entry' : format === 'msg' ? `msg_${'d'.repeat(48)}`
      : format === 'entry-local' ? `rele-context-${digest}` : `msg_${digest}`;
    await appendFile(f.rolloutPath, JSON.stringify({ type: 'response_item', payload: { type: 'message', id: persistedId, role: 'user', content: [{ type: 'input_text', text: 'Another source version' }] } }) + '\n');
    await f.client.connect();
    await f.client.injectContext(threadId, 'canonical-entry', 'Current quote', { itemId, entries: [{ entryId: 'old-entry', text: 'Expected exact old quote' }] });
    expect(f.calls.filter(call => call.method === 'thread/inject_items')).toHaveLength(1);
    expect((f.pending[0] as { id: string }).id).toBe(itemId);
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
    expect(await readFile(f.rolloutPath, 'utf8')).toContain('rele-context-');
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
  it('never sends terminal termination with an unproven or malformed target generation', async () => {
    const f = await fixture({
      'server/diagnostics': () => ({ process: { id: 42 }, gauges: [] }),
      'thread/backgroundTerminals/list': () => ({ data: [{ itemId: 'own-command', processId: '1234' }], nextCursor: null }),
      'thread/backgroundTerminals/terminate': () => ({ terminated: true }),
    });
    await f.client.connect();
    await expect(f.client.terminateBackgroundTerminal(threadId, { serverId: 42, serverGeneration: 'a'.repeat(64), itemId: 'own-command', processId: '1234' }))
      .rejects.toMatchObject({ code: 'terminal-identity-changed', identityFailure: 'server-generation-unconfirmed' });
    for (const serverGeneration of ['A'.repeat(64), 'a'.repeat(63), '']) {
      await expect(f.client.terminateBackgroundTerminal(threadId, { serverId: 42, serverGeneration, itemId: 'own-command', processId: '1234' }))
        .rejects.toMatchObject({ code: 'terminal-identity-changed', identityFailure: 'target-generation-invalid' });
    }
    expect(f.calls.some(call => call.method === 'thread/backgroundTerminals/terminate')).toBe(false);
    expect(await f.client.backgroundTerminals(threadId)).not.toHaveProperty('serverGeneration');
  });

  it('classifies a server identity change without sending native termination', async () => {
    let serverId = 42;
    const f = await fixture({
      'server/diagnostics': () => ({ process: { id: serverId }, gauges: [] }),
      'thread/backgroundTerminals/list': () => ({ data: [{ itemId: 'own-command', processId: '1234' }], nextCursor: null }),
      'thread/backgroundTerminals/terminate': () => ({ terminated: true }),
    });
    await f.client.connect();
    const snapshot = await f.client.backgroundTerminals(threadId);
    serverId++;

    await expect(f.client.terminateBackgroundTerminal(threadId, { ...snapshot.terminals[0], serverId: snapshot.serverId }))
      .rejects.toMatchObject({ code: 'terminal-identity-changed', identityFailure: 'server-id-changed' });
    expect(f.calls.some(call => call.method === 'thread/backgroundTerminals/terminate')).toBe(false);
  });

  it('classifies a confirmed server generation change without sending native termination', async () => {
    const f = await fixture();
    await f.client.connect();
    vi.spyOn(f.client, 'backgroundTerminals').mockResolvedValue({ serverId: 42, serverGeneration: 'b'.repeat(64), terminals: [{ itemId: 'own-command', processId: '1234' }] });

    await expect(f.client.terminateBackgroundTerminal(threadId, { serverId: 42, serverGeneration: 'a'.repeat(64), itemId: 'own-command', processId: '1234' }))
      .rejects.toMatchObject({ code: 'terminal-identity-changed', identityFailure: 'server-generation-changed' });
    expect(f.calls.some(call => call.method === 'thread/backgroundTerminals/terminate')).toBe(false);
  });

  it.skipIf(!['linux', 'win32'].includes(process.platform))('proves a stable generation for the actual owned stdio peer and changes it for a replacement process', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'Rele native generation '));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const f = await managedFixture({ codexHome: home, terminals:true });
    await f.client.connect();
    const first = await f.client.backgroundTerminals(threadId);
    expect(first.serverId).toBe((await f.records())[0].pid);
    let proofFailure = 'preflight';
    if (process.platform === 'win32' && !first.serverGeneration) {
      const peer = Reflect.get(f.client, 'nativePeer') as CodexNativePeer | undefined;
      const stdioPeer = peer?.kind === 'stdio' ? peer : undefined;
      const expectedPeerPid = stdioPeer?.pid;
      const expectedExecutable = stdioPeer?.executable;
      const helperExecutable = stdioPeer?.helperExecutable;
      const run = async (command: string, args: string[]) => {
        try {
          const result = await execute(command, args, { timeout:30_000, maxBuffer:128*1024, windowsHide:true });
          let proof: Record<string, unknown>;
          try { proof = JSON.parse(result.stdout) as Record<string, unknown>; }
          catch { proofFailure = result.stdout.trim() ? 'proof-output-invalid-json' : 'proof-output-empty'; return { ...result, code:0 }; }
          const validTime = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(value) && Number.isFinite(Date.parse(value));
          const validPath = (value: unknown) => typeof value === 'string' && /^[A-Za-z]:\\/u.test(value) && path.win32.isAbsolute(value);
          const samePath = (left: unknown, right: string | undefined) => typeof left === 'string' && right !== undefined && path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
          const checks: [string, boolean][] = [
            ['peer', proof.peerVerified === true], ['pid', proof.pid === first.serverId], ['gateway', proof.gatewayId === process.pid],
            ['birth', validTime(proof.birth)], ['boot', validTime(proof.boot)], ['owner', typeof proof.owner === 'string' && /^S-1-\d+(?:-\d+)+$/u.test(proof.owner)],
            ['sha', typeof proof.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(proof.sha256)], ['executable-path', validPath(proof.executable)],
            ['home', validPath(proof.codexHome) && samePath(proof.codexHome, home)], ['parent', proof.parentPid === (helperExecutable ? expectedPeerPid : process.pid)],
            ['gateway-owner', proof.gatewayOwner === proof.owner], ['image', proof.executableContentMatchesExpected === true || samePath(proof.executable, expectedExecutable)],
            ['helper-pid', helperExecutable === undefined || proof.helperPid === expectedPeerPid],
            ['helper-parent', helperExecutable === undefined || proof.helperParentPid === process.pid],
            ['helper-owner', helperExecutable === undefined || proof.helperOwner === proof.owner],
            ['helper-path', helperExecutable === undefined || validPath(proof.helperExecutable)],
            ['helper-image', helperExecutable === undefined || proof.helperExecutableContentMatchesExpected === true || samePath(proof.helperExecutable, helperExecutable)],
            ['helper-birth', helperExecutable === undefined || validTime(proof.helperBirth)],
            ['helper-sha', helperExecutable === undefined || typeof proof.helperSha256 === 'string' && /^[a-f0-9]{64}$/u.test(proof.helperSha256)],
          ];
          proofFailure = `proof-validation:${checks.filter(([, ok]) => !ok).map(([name]) => name).join(',') || 'unclassified'}`;
          return { ...result, code:0 };
        } catch (error) {
          const stderr = String((error as { stderr?:string }).stderr ?? '');
          proofFailure = stderr.match(/rele-native-proof:([a-z-]+)/u)?.[1] ?? 'powershell-invocation';
          return { stdout:'', code:1 };
        }
      };
      await codexNativeGeneration(peer, first.serverId, home, { platform:'win32', run });
    }
    expect(first, `Windows native proof returned no generation (${proofFailure})`).toHaveProperty('serverGeneration', expect.stringMatching(/^[a-f0-9]{64}$/u));
    expect(await f.client.backgroundTerminals(threadId)).toEqual(first);
    await expect(f.client.terminateBackgroundTerminal(threadId, { serverId:first.serverId, serverGeneration:'0'.repeat(64), itemId:'fixture-command', processId:'1234' })).rejects.toMatchObject({ code:'terminal-identity-changed' });
    expect((await f.calls()).filter(call => call.method === 'thread/backgroundTerminals/terminate')).toHaveLength(0);
    await f.client.terminateBackgroundTerminal(threadId, { serverId:first.serverId, serverGeneration:first.serverGeneration, itemId:'fixture-command', processId:'1234' });
    expect((await f.calls()).filter(call => call.method === 'thread/backgroundTerminals/terminate').map(call => call.params)).toEqual([{ threadId, processId:'1234' }]);
    await f.client.close();
    await f.client.connect();
    const replacement = await f.client.backgroundTerminals(threadId);
    expect(replacement).toHaveProperty('serverGeneration', expect.stringMatching(/^[a-f0-9]{64}$/u));
    expect(replacement.serverId).not.toBe(first.serverId);
    expect(replacement).not.toHaveProperty('serverGeneration', Reflect.get(first, 'serverGeneration'));
  }, 60000);

  it('does not turn a claimed diagnostics PID into proof of another stdio process', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'Rele claimed generation '));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const f = await managedFixture({ codexHome: home, diagnosticPid: 'parent' });
    await f.client.connect();
    expect(await f.client.backgroundTerminals(threadId)).not.toHaveProperty('serverGeneration');
  });

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
    ['0.165.0-alpha.1.2', true],
    ['0.166.0-alpha.5.1', true],
    ['0.166.0-alpha.6', true],
    ['0.163.0-alpha.10.3', false],
    ['0.163.0-alpha.11.3', false],
    ['0.164.0-alpha.11', false],
    ['0.164.0-alpha.11.2', false],
    ['0.166.0-alpha.5', false],
    ['0.166.0-alpha.5.2', false],
    ['0.166.0-alpha.5.1.extra', false],
    ['0.166.0-alpha.5.1+custom', false],
    ['0.166.0-alpha.6.1', false],
    ['0.166.0-alpha.6.extra', false],
    ['0.166.0-alpha.6+custom', false],
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

describe('Codex addressed steering and own input receipts', () => {
  it.each([
    { name: 'repeated markers', parts: ['NOREPLY', ' \tNOREPLY\n', ' '], expected: 'NOREPLY' },
    { name: 'mixed marker and real finals', parts: ['NOREPLY', 'First paragraph', '\nNOREPLY ', 'Mention NOREPLY in the second paragraph.'],
      expected: 'First paragraph\n\nMention NOREPLY in the second paragraph.' },
    { name: 'legacy history', parts: [], expected: 'Legacy final' },
  ])('aggregates final history without leaking markers ($name)', async ({ parts, expected }) => {
    const clientId = randomUUID(), turnId = randomUUID();
    const turn = { id: turnId, status: 'completed', items: [
      { type: 'userMessage', clientId },
      { type: 'agentMessage', phase: 'commentary', id: 'progress', text: 'Working' },
      { type: 'agentMessage', text: 'Legacy final' },
      ...parts.map(text => ({ type: 'agentMessage', phase: 'final_answer', text })),
    ] };
    const f = await fixture({ 'thread/turns/list': () => ({ data: [turn], nextCursor: null }) });
    await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId)).toMatchObject({ state: 'completed', turnId, text: expected,
      commentary: [{ id: `${turnId}:progress`, text: 'Working' }] });
  });

  it.each(['request', 'steer'])('reconciles a composite turn over 32 MiB using single-item %s receipt pages', async kind => {
    const rootId = randomUUID(), clientId = randomUUID(), turnId = randomUUID();
    const turn = { id: turnId, status: 'completed', items: [
      { type: 'userMessage', clientId: rootId },
      { type: 'agentMessage', id: 'progress', phase: 'commentary', text: 'Working' },
      ...[0, 1, 2].map(index => ({ type: 'commandExecution', id: `command-${index}`, processId: String(123 + index),
        status: 'completed', aggregatedOutput: 'x'.repeat(11 * 1024 * 1024) })),
      { type: 'userMessage', clientId },
      { type: 'agentMessage', phase: 'final_answer', text: 'Recovered answer' },
    ] };
    expect(Buffer.byteLength(JSON.stringify(turn))).toBeGreaterThan(32 * 1024 * 1024);
    const f = await fixture({ 'thread/turns/list': () => ({ data: [turn], nextCursor: null }) });
    await f.client.connect(); const before = f.calls.length;
    const found = kind === 'request' ? await f.client.findRequest(threadId, rootId, [clientId])
      : await f.client.findSteerReceipt(threadId, clientId, turnId, [rootId]);
    expect(found).toMatchObject({ state: 'completed', turnId, text: 'Recovered answer',
      commentary: [{ id: `${turnId}:progress`, text: 'Working' }],
      commandItems: [0, 1, 2].map(index => ({ id: `command-${index}`, processId: String(123 + index), completed: true })),
    });
    expect(f.client.status().connected).toBe(true);
    expect(f.calls.slice(before).filter(call => call.method === 'thread/turns/list').map(call => call.params))
      .toEqual([{ threadId, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc' }]);
    expect(f.calls.slice(before).filter(call => call.method === 'thread/items/list').map(call => call.params))
      .toEqual(turn.items.map((_item, index) => ({ threadId, turnId, limit: 1, sortDirection: 'asc', ...(index ? { cursor: String(index) } : {}) })));
    expect(f.calls.some(call => ['thread/queue/add', 'thread/resume', 'turn/steer', 'turn/start'].includes(call.method ?? ''))).toBe(false);
  });

  it.each(['request', 'steer'])('keeps the %s receipt connected when older full history would overflow a bulk frame', async kind => {
    const clientId = randomUUID(), turnId = randomUUID();
    const turn = { id: turnId, status: 'completed', items: [
      { type: 'userMessage', clientId },
      { type: 'commandExecution', id: 'command-1', processId: '123', status: 'completed' },
      { type: 'agentMessage', phase: 'final_answer', text: 'NOREPLY' },
    ] };
    const f = await fixture({ 'thread/turns/list': request => ({
      data: request.params.limit === 1 ? [turn] : [turn, { id: 'older-turn', status: 'completed', items: [
        { type: 'commandExecution', id: 'old-command', aggregatedOutput: 'x'.repeat(33 * 1024 * 1024) },
      ] }],
      nextCursor: request.params.limit === 1 ? 'older-page' : null,
    }) });
    await f.client.connect();
    const found = kind === 'request' ? await f.client.findRequest(threadId, clientId)
      : await f.client.findSteerReceipt(threadId, clientId, turnId);
    expect(found).toMatchObject({ state: 'completed', turnId, text: 'NOREPLY',
      commandItems: [{ id: 'command-1', processId: '123', completed: true }] });
    expect(f.client.status().connected).toBe(true);
    expect(f.calls.some(call => ['thread/queue/add', 'thread/resume', 'turn/steer', 'turn/start'].includes(call.method ?? ''))).toBe(false);
  });

  it('keeps an oversized single item uncertain without repeating any mutation', async () => {
    const clientId = randomUUID(), turnId = randomUUID();
    const f = await fixture({ 'thread/turns/list': () => ({ data: [{ id: turnId, status: 'completed', items: [
      { type: 'userMessage', clientId },
      { type: 'commandExecution', id: 'oversized-command', aggregatedOutput: 'x'.repeat(33 * 1024 * 1024) },
    ] }], nextCursor: null }) });
    await f.client.connect();
    await expect(f.client.findRequest(threadId, clientId)).rejects.toMatchObject({ uncertain: true });
    expect(f.client.status().connected).toBe(false);
    expect(f.calls.some(call => ['thread/queue/add', 'thread/resume', 'turn/steer', 'turn/start'].includes(call.method ?? ''))).toBe(false);
  });

  it.each(['request', 'steer'])('fails closed on malformed %s receipt item pages', async kind => {
    const clientId = randomUUID(), turnId = randomUUID();
    const f = await fixture({
      'thread/turns/list': () => ({ data: [{ id: turnId, status: 'completed', items: [] }], nextCursor: null }),
      'thread/items/list': () => ({ data: [{ turnId: 'another-turn', item: { type: 'userMessage', clientId } }], nextCursor: null }),
    });
    await f.client.connect();
    const found = kind === 'request' ? f.client.findRequest(threadId, clientId) : f.client.findSteerReceipt(threadId, clientId, turnId);
    await expect(found).rejects.toMatchObject({ uncertain: true, code: 'request-history-unconfirmed' });
  });

  it('stops a repeated item cursor without claiming an absent receipt', async () => {
    const clientId = randomUUID(), turnId = randomUUID();
    const f = await fixture({
      'thread/turns/list': () => ({ data: [{ id: turnId, status: 'completed', items: [] }], nextCursor: null }),
      'thread/items/list': () => ({ data: [], nextCursor: 'repeated' }),
    });
    await f.client.connect();
    await expect(f.client.findRequest(threadId, clientId)).rejects.toThrow('курсор');
  });

  it('steers the exact expected turn once and preserves an early native input receipt', async () => {
    const clientId = randomUUID(), turnId = randomUUID(), events: CodexNotification[] = [];
    const f = await fixture({ 'turn/steer': (message, socket) => {
      socket.send(JSON.stringify({ method: 'item/started', params: { threadId, turnId, item: { type: 'userMessage', clientId: message.params.clientUserMessageId } } }));
      return { turnId };
    } });
    await f.client.connect(); f.client.on('notification', event => events.push(event));
    const before = f.calls.length;
    expect(await f.client.steer(threadId, 'Дополнение от участника', clientId, turnId)).toEqual({ turnId });
    expect(f.calls.slice(before).map(call => ({ method: call.method, params: call.params }))).toEqual([
      { method: 'turn/steer', params: { threadId, input: [{ type: 'text', text: 'Дополнение от участника' }], clientUserMessageId: clientId, expectedTurnId: turnId } },
    ]);
    expect(events).toMatchObject([{ method: 'item/started', params: { threadId, turnId, item: { clientId } } }]);
  });

  it.each([['', randomUUID(), 'turn-1'], ['text', 'not-a-uuid', 'turn-1'], ['text', randomUUID(), '']])('rejects incomplete steering input before the wire (%s)', async (text, clientId, turnId) => {
    const f = await fixture(); await f.client.connect();
    await expect(f.client.steer(threadId, text, clientId, turnId)).rejects.toThrow();
    expect(f.calls.some(call => call.method === 'turn/steer')).toBe(false);
  });

  it.each([
    ['no active turn to steer', 'no_active_turn'], ['expected active turn id `turn-1` but found `turn-2`', 'turn_mismatch'],
  ])('classifies only a known native NotSubmitted response: %s', async (message, reason) => {
    const f = await fixture({ 'turn/steer': (request, socket) => {
      socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message } })); return noResponse;
    } });
    await f.client.connect();
    const operation = f.client.steer(threadId, 'new input', randomUUID(), 'turn-1');
    await expect(operation).rejects.toBeInstanceOf(CodexSteerRefusedError);
    await expect(operation).rejects.toMatchObject({ reason });
    expect(f.calls.filter(call => call.method === 'turn/steer')).toHaveLength(1);
    expect(f.calls.some(call => ['turn/start', 'thread/queue/add'].includes(call.method ?? ''))).toBe(false);
  });

  it.each([
    [-32603, 'no active turn to steer'], [-32600, 'expected active turn id `different` but found `turn-2`'],
    [-32600, 'native-private-secret'], [-32600, 'no active turn to steer\nnative-private-secret'],
  ])('keeps an unknown native steering error uncertain (%s, %s)', async (code, message) => {
    const f = await fixture({ 'turn/steer': (request, socket) => {
      socket.send(JSON.stringify({ id: request.id, error: { code, message } })); return noResponse;
    } });
    await f.client.connect();
    const error = await f.client.steer(threadId, 'new input', randomUUID(), 'turn-1').catch(error => error);
    expect(error).toBeInstanceOf(CodexTransportError);
    expect(error).toMatchObject({ uncertain: true, code: 'steer-unconfirmed' });
    expect(error.message).not.toContain('native-private-secret');
    expect(f.calls.filter(call => call.method === 'turn/steer')).toHaveLength(1);
  });

  it.each([{}, { turnId: 'a-different-turn' }, null])('keeps an incomplete or mismatched ACK uncertain: %s', async response => {
    const f = await fixture({ 'turn/steer': () => response }); await f.client.connect();
    await expect(f.client.steer(threadId, 'new input', randomUUID(), 'turn-1')).rejects.toMatchObject({ uncertain: true, code: 'steer-unconfirmed' });
    expect(f.calls.filter(call => call.method === 'turn/steer')).toHaveLength(1);
  });

  it('reconciles a lost steering ACK from the exact persisted input without repeating a mutation', async () => {
    const rootId = randomUUID(), clientId = randomUUID(), turnId = randomUUID(); let accepted = false;
    const f = await fixture({
      'turn/steer': (_request, socket) => { accepted = true; socket.close(); return noResponse; },
      'thread/turns/list': () => ({ data: accepted ? [{ id: turnId, status: 'completed', completedAt: 100,
        items: [{ type: 'userMessage', clientId: rootId }, { type: 'userMessage', clientId }, { type: 'agentMessage', text: 'Updated answer' }] }] : [], nextCursor: null }),
    });
    await f.client.connect();
    await expect(f.client.steer(threadId, 'new input', clientId, turnId)).rejects.toBeInstanceOf(CodexTransportError);
    await f.client.connect();
    expect(await f.client.findSteerReceipt(threadId, clientId, turnId, [rootId])).toEqual({ state: 'completed', turnId, text: 'Updated answer' });
    expect(f.calls.filter(call => call.method === 'turn/steer')).toHaveLength(1);
    expect(f.calls.some(call => ['turn/start', 'thread/queue/add'].includes(call.method ?? ''))).toBe(false);
  });

  it('accepts an explicit own input group while preserving the default single-ID policy', async () => {
    const rootId = randomUUID(), addonId = randomUUID();
    const f = await fixture({ 'thread/turns/list': () => ({ data: [{ id: 'own-turn', status: 'completed', items: [
      { type: 'userMessage', clientId: rootId }, { type: 'userMessage', clientId: addonId }, { type: 'agentMessage', phase: 'final_answer', text: 'Same-source answer' },
    ] }], nextCursor: null }) });
    await f.client.connect();
    expect(await f.client.findRequest(threadId, rootId)).toEqual({ state: 'completed', turnId: 'own-turn', mixed: true });
    expect(await f.client.findRequest(threadId, rootId, [addonId])).toEqual({ state: 'completed', turnId: 'own-turn', text: 'Same-source answer' });
    expect(await f.client.findSteerReceipt(threadId, addonId, 'own-turn', [rootId])).toEqual({ state: 'completed', turnId: 'own-turn', text: 'Same-source answer' });
  });

  it.each([null, randomUUID()])('still quarantines an external input alongside the registered group (%s)', async foreignId => {
    const rootId = randomUUID(), addonId = randomUUID();
    const f = await fixture({ 'thread/turns/list': () => ({ data: [{ id: 'mixed-turn', status: 'failed', error: { codexErrorInfo: 'serverOverloaded' }, items: [
      { type: 'userMessage', clientId: rootId }, { type: 'userMessage', clientId: addonId }, { type: 'userMessage', clientId: foreignId },
      { type: 'commandExecution', id: 'foreign-command', processId: '1234' }, { type: 'agentMessage', text: 'Must stay local' },
    ] }], nextCursor: null }) });
    await f.client.connect();
    expect(await f.client.findRequest(threadId, rootId, [addonId])).toEqual({ state: 'failed', turnId: 'mixed-turn', mixed: true });
    expect(await f.client.findSteerReceipt(threadId, addonId, 'mixed-turn', [rootId])).toEqual({ state: 'failed', turnId: 'mixed-turn', mixed: true });
  });

  it.each(['wrong-turn', 'duplicate-input'])('refuses an ambiguous steering receipt (%s)', async kind => {
    const clientId = randomUUID();
    const f = await fixture({ 'thread/turns/list': () => ({ data: [{ id: kind === 'wrong-turn' ? 'other-turn' : 'expected-turn', status: 'inProgress', items: [
      { type: 'userMessage', clientId }, ...(kind === 'duplicate-input' ? [{ type: 'userMessage', clientId }] : []),
    ] }], nextCursor: null }) });
    await f.client.connect();
    await expect(f.client.findSteerReceipt(threadId, clientId, 'expected-turn')).rejects.toMatchObject({ uncertain: true,
      code: kind === 'wrong-turn' ? 'steer-receipt-turn-mismatch' : 'steer-receipt-duplicate' });
  });

  it('finds an older exact receipt and leaves an absent receipt not_found without queue fallback', async () => {
    const clientId = randomUUID(); let present = false;
    const f = await fixture({ 'thread/turns/list': request => request.params.cursor
      ? { data: present ? [{ id: 'expected-turn', status: 'inProgress', items: [{ type: 'userMessage', clientId }] }] : [], nextCursor: null }
      : { data: [], nextCursor: 'older' } });
    await f.client.connect(); const before = f.calls.length;
    expect(await f.client.findSteerReceipt(threadId, clientId, 'expected-turn')).toEqual({ state: 'not_found' });
    present = true;
    expect(await f.client.findSteerReceipt(threadId, clientId, 'expected-turn')).toMatchObject({ state: 'running', turnId: 'expected-turn' });
    expect(f.calls.slice(before).every(call => ['thread/turns/list', 'thread/items/list'].includes(call.method ?? ''))).toBe(true);
  });
});

describe('Overload continuation protocol', () => {
  const clientId = 'overloaded-request';
  const failed = { id: 'failed-turn', rootTurnId: 'failed-turn', status: 'failed', items: [{ type: 'userMessage', clientId }], error: { codexErrorInfo: 'serverOverloaded' } };
  const retry = { id: 'retry-turn', rootTurnId: 'failed-turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Recovered' }] };
  const page = (data: unknown[]) => ({ data, nextCursor: null });

  it.each(['idle', 'systemError'])('continues from %s via empty turn/start with lineage and without changing model or policies', async status => {
    const f = await fixture({
      'thread/read': () => ({ thread: { ...rawThread, status: { type: status } } }),
      'thread/turns/list': () => page([{ ...failed, completedAt: 1793665117 }]),
      'turn/start': () => ({ turn: { ...retry, status: 'inProgress', items: [] } }),
    });
    await f.client.connect();
    let intent = 0;
    expect(await f.client.retryOverloaded(threadId, clientId, failed.id, [], () => { intent++; return true; })).toEqual({ turnId: retry.id });
    expect(intent).toBe(1);
    expect(f.calls.filter(call => call.method === 'thread/turns/list').every(call => call.params.itemsView === 'notLoaded')).toBe(true);
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
    expect(f.calls.find(call => call.method === 'turn/start')?.params).toEqual({ threadId, input: [], turnTrigger: 'capacity_retry_automatic', parentTurnId: failed.id, rootTurnId: failed.id });
  });

  it.each(['missing-latest', 'different-latest', 'running-latest', 'missing-completion', 'null-completion', 'invalid-completion', 'zero-completion', 'foreign-input', 'other-error', 'active-flags', 'queued'])('keeps systemError blocked with %s', async condition => {
    const terminal = { ...failed, completedAt: 1793665117 };
    const history = condition === 'foreign-input' ? { ...terminal, items: [...terminal.items, { type: 'userMessage', clientId: 'foreign' }] }
      : condition === 'other-error' ? { ...terminal, error: { codexErrorInfo: 'other' } } : terminal;
    const latest = condition === 'different-latest' ? { ...terminal, id: 'different-turn' }
      : condition === 'running-latest' ? { ...terminal, status: 'inProgress' }
      : condition === 'missing-completion' ? { ...terminal, completedAt: undefined }
      : condition === 'null-completion' ? { ...terminal, completedAt: null }
      : condition === 'invalid-completion' ? { ...terminal, completedAt: '1793665117' }
      : condition === 'zero-completion' ? { ...terminal, completedAt: 0 } : terminal;
    let reads = 0;
    const f = await fixture({
      'thread/read': () => ({ thread: { ...rawThread, status: { type: 'systemError', ...(condition === 'active-flags' ? { activeFlags: ['waitingOnApproval'] } : {}) } } }),
      'thread/queue/list': () => page(condition === 'queued' ? [{ id: 'foreign', clientUserMessageId: 'other' }] : []),
      'thread/turns/list': () => page(reads++ === 0 ? [history] : condition === 'missing-latest' ? [] : [latest]),
    });
    await f.client.connect();
    expect(await f.client.retryOverloaded(threadId, clientId, failed.id, [], () => { throw Error('must not send'); })).toBeUndefined();
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(0);
  });

  it.each(['desktop', 'rele', 'page-boundary'])('finds an empty %s continuation from the original client ID', async kind => {
    const comment = (id: string) => ({ id, type: 'agentMessage', phase: 'commentary', text: id });
    const original = { ...failed, items: [...failed.items, comment('before')] };
    const continued = { ...retry, rootTurnId: kind === 'desktop' ? retry.id : failed.id, items: [comment('after'), ...retry.items] };
    const f = await fixture({ 'thread/turns/list': message => kind === 'page-boundary' && !message.params?.cursor
      ? { data: [continued], nextCursor: 'older' } : page(kind === 'page-boundary' ? [original] : [continued, original]) });
    await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId, [], true)).toMatchObject({ state: 'completed', turnId: retry.id, text: 'Recovered', retryCount: 1,
      commentary: [{ id: `${failed.id}:before`, text: 'before' }, { id: `${retry.id}:after`, text: 'after' }] });
  });

  it.each([
    ['desktop', 'completed'], ['desktop', 'inProgress'],
    ['rele', 'completed'], ['rele', 'inProgress'],
    ['page-boundary', 'completed'], ['page-boundary', 'inProgress'],
  ])('keeps known steering in a %s continuation that is %s', async (kind, status) => {
    const ownSteer = 'own-steer';
    const continued = { ...retry, rootTurnId: kind === 'rele' ? failed.id : retry.id, status,
      items: [{ type: 'userMessage', clientId: ownSteer }, ...retry.items] };
    const f = await fixture({ 'thread/turns/list': message => kind === 'page-boundary' && !message.params?.cursor
      ? { data: [continued], nextCursor: 'older' } : page(kind === 'page-boundary' ? [failed] : [continued, failed]) });
    await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId, [ownSteer], true)).toMatchObject({
      state: status === 'inProgress' ? 'running' : 'completed', turnId: retry.id, text: 'Recovered', retryCount: 1,
    });
    expect(await f.client.findRequest(threadId, clientId, [ownSteer])).toMatchObject({
      state: 'failed', turnId: failed.id, failureReason: 'serverOverloaded',
    });
    expect(await f.client.retryOverloaded(threadId, clientId, failed.id, [ownSteer], () => { throw Error('must not send'); })).toBeUndefined();
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(0);
  });

  it.each(['foreign-input', 'mixed-input', 'missing-input-id', 'foreign-root', 'unrooted-input'])('keeps the retry guard for known steering with %s', async kind => {
    const ownSteer = 'own-steer';
    const users = kind === 'foreign-input' ? [{ type: 'userMessage', clientId: 'foreign' }]
      : kind === 'missing-input-id' ? [{ type: 'userMessage' }]
      : [{ type: 'userMessage', clientId: ownSteer }, ...(kind === 'mixed-input' ? [{ type: 'userMessage', clientId: 'foreign' }] : [])];
    const continued = { ...retry,
      rootTurnId: kind === 'foreign-root' ? 'different-root' : kind === 'unrooted-input' ? undefined : retry.id, items: users };
    const f = await fixture({ 'thread/turns/list': () => page([continued, failed]) }); await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId, [ownSteer], true)).toMatchObject({
      state: 'failed', turnId: failed.id, retryBlocked: true,
    });
    expect(await f.client.retryOverloaded(threadId, clientId, failed.id, [ownSteer], () => { throw Error('must not send'); })).toBeUndefined();
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(0);
  });

  it.each(['foreign-input', 'foreign-root'])('does not adopt or retry past %s', async kind => {
    const foreign = kind === 'foreign-input' ? { ...retry, items: [{ type: 'userMessage', clientId: 'foreign' }] } : { ...retry, rootTurnId: 'different-root' };
    const f = await fixture({ 'thread/turns/list': () => page([foreign, failed]) }); await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId, [], true)).toMatchObject({ state: 'failed', turnId: failed.id, retryBlocked: true });
    expect(await f.client.retryOverloaded(threadId, clientId, failed.id, [], () => { throw Error('must not send'); })).toBeUndefined();
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(0);
  });

  it('does not send after Desktop has already retried', async () => {
    const f = await fixture({ 'thread/turns/list': () => page([{ ...retry, status: 'inProgress' }, failed]) }); await f.client.connect();
    expect(await f.client.retryOverloaded(threadId, clientId, failed.id, [], () => { throw Error('must not send'); })).toBeUndefined();
  });

  it.each(['active', 'queued', 'cancelled'])('checks %s immediately before retry', async condition => {
    const f = await fixture({ 'thread/turns/list': () => page([failed]),
      'thread/read': () => ({ thread: { ...rawThread, status: { type: condition === 'active' ? 'active' : 'idle' } } }),
      'thread/queue/list': () => page(condition === 'queued' ? [{ id: 'foreign', clientUserMessageId: 'other' }] : []),
    }); await f.client.connect();
    expect(await f.client.retryOverloaded(threadId, clientId, failed.id, [], () => false)).toBeUndefined();
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(0);
  });

  it.each(['idle', 'systemError'])('treats the exact native EmptyInput rejection from %s as a busy thread', async status => {
    const f = await fixture({
      'thread/read': () => ({ thread: { ...rawThread, status: { type: status } } }),
      'thread/turns/list': () => page([{ ...failed, completedAt: 1793665117 }]), 'turn/start': (message, socket) => {
      socket.send(JSON.stringify({ id: message.id, error: { code: -32603, message: 'failed to submit turn input: EmptyInput' } })); return noResponse;
    } }); await f.client.connect();
    await expect(f.client.retryOverloaded(threadId, clientId, failed.id, [], () => true)).rejects.toMatchObject({ reason: 'non_idle' });
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
  });

  it('does not replay the mutation after losing its ACK', async () => {
    const f = await fixture({ 'thread/turns/list': () => page([failed]), 'turn/start': (_message, socket) => { socket.close(); return noResponse; } });
    await f.client.connect();
    await expect(f.client.retryOverloaded(threadId, clientId, failed.id, [], () => true)).rejects.toMatchObject({ uncertain: true });
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
  });
});

describe('Codex typed async question history', () => {
  const questionItem = { type: 'agentMessage', delivery: 'async', id: 'async-call', phase: 'final_answer', text: 'Question UI only',
    questions: [{ title: 'Где ответить?', options: ['Slack', 'Desktop'] }] };
  const ref = asyncQuestions(questionItem)[0], questionId = ref.question.id;
  const envelope = encodeAsyncAnswers([ref.question], { [questionId]: ['Slack'] });
  const reply = { type: 'userMessage', id: 'desktop-reply', clientId: 'desktop-input', content: [{ type: 'text', text: envelope }] };
  const page = (data: unknown[], nextCursor: string | null = null) => ({ data, nextCursor });

  it.each(['inProgress', 'completed', 'failed', 'interrupted'])('keeps unanswered async questions only for live/completed turns (%s)', async status => {
    const clientId = randomUUID(), turn = { id: 'question-turn', status, completedAt: 123, items: [
      { type: 'userMessage', clientId }, questionItem,
    ] };
    const f = await fixture({ 'thread/turns/list': () => page([turn]) }); await f.client.connect();
    const found = await f.client.findRequest(threadId, clientId);
    expect(found.asyncQuestions).toEqual(['inProgress', 'completed'].includes(status) ? [ref] : undefined);
    expect(found.text).toBeUndefined(); expect(found.commentary).toBeUndefined(); expect(found.mixed).toBeUndefined();
  });

  it('recognizes a Desktop reply to an earlier exact question without marking the same turn mixed', async () => {
    const clientId = randomUUID(), turn = { id: 'question-turn', status: 'completed', items: [
      { type: 'userMessage', clientId }, questionItem, reply, { type: 'agentMessage', phase: 'final_answer', text: 'Real final' },
      { ...questionItem, id: 'second-question', phase: 'commentary' },
    ] };
    const f = await fixture({ 'thread/turns/list': () => page([turn]) }); await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId)).toEqual({ state: 'completed', turnId: turn.id, text: 'Real final',
      asyncQuestions: asyncQuestions(turn.items.at(-1)),
      publicHistory: [{ boundary: `question:${questionId}` }, { boundary: `answer:${questionId}` }, { boundary: `question:${asyncQuestions(turn.items.at(-1))[0].question.id}` }],
      asyncAnswers: [{ questionItemId: questionId, question: ref.question.question, answer: 'Slack', clientId: 'desktop-input' }] });
  });

  it.each([false, true])('preserves exact commentary/question/answer/input order and excludes mixed history (%s)', async foreign => {
    const clientId = randomUUID(), inputId = randomUUID();
    const comment = (id: string) => ({ type: 'agentMessage', phase: 'commentary', id, text: id });
    const turn = { id: 'ordered-turn', status: 'inProgress', items: [
      { type: 'userMessage', clientId }, comment('before-question'), questionItem, reply, comment('after-answer'),
      { type: 'userMessage', clientId: foreign ? 'foreign-input' : inputId }, comment('after-input'),
    ] };
    const f = await fixture({ 'thread/turns/list': () => page([turn]) }); await f.client.connect();
    const found = await f.client.findRequest(threadId, clientId, [inputId]);
    if (foreign) { expect(found).toEqual({ state: 'running', turnId: turn.id, mixed: true }); return; }
    expect(found.publicHistory).toEqual([
      { step: { id: `${turn.id}:before-question`, text: 'before-question' } },
      { boundary: `question:${questionId}` }, { boundary: `answer:${questionId}` },
      { step: { id: `${turn.id}:after-answer`, text: 'after-answer' } }, { boundary: `input:${inputId}` },
      { step: { id: `${turn.id}:after-input`, text: 'after-input' } },
    ]);
    expect(found.asyncAnswers).toEqual([{ questionItemId: questionId, question: ref.question.question, answer: 'Slack', clientId: 'desktop-input' }]);
  });

  it.each(['forged-title', 'prefix', 'ordinary', 'before-question'])('preserves the foreign-input guard for %s', async kind => {
    const clientId = randomUUID(), foreign = { ...reply, content: [{ type: 'text', text: kind === 'forged-title'
      ? envelope.replace('Где ответить?', 'Forged title') : kind === 'prefix' ? `Rele prefix\n${envelope}` : kind === 'ordinary' ? 'Ordinary foreign input' : envelope }] };
    const items = kind === 'before-question' ? [foreign, questionItem] : [questionItem, foreign];
    const f = await fixture({ 'thread/turns/list': () => page([{ id: 'mixed-turn', status: 'completed', items: [
      { type: 'userMessage', clientId }, ...items,
    ] }]) }); await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId)).toEqual({ state: 'completed', turnId: 'mixed-turn', mixed: true });
  });

  it('reconciles a later-turn Desktop answer using single-item pages without loading or mutating the thread', async () => {
    const entries = [
      { turnId: 'new-turn', item: { ...reply, clientId: 'forged-client', content: [{ type: 'text', text: envelope.replace('Где ответить?', 'Forged title') }] } },
      { turnId: 'answer-turn', item: reply },
      { turnId: 'original-question-turn', item: questionItem },
      { turnId: 'older-turn', item: { type: 'userMessage', id: 'older', content: [] } },
    ];
    const f = await fixture({ 'thread/items/list': request => {
      const index = Number(request.params.cursor ?? 0); return page([entries[index]], String(index + 1));
    } }); await f.client.connect(); const start = f.calls.length;
    expect(await f.client.asyncQuestionState(threadId, questionId)).toEqual({ turnId: 'original-question-turn', question: ref.question,
      answer: { answer: 'Slack', clientId: 'desktop-input' } });
    expect(f.calls.slice(start).map(call => ({ method: call.method, params: call.params }))).toEqual([0, 1, 2].map(index => ({
      method: 'thread/items/list', params: { threadId, limit: 1, sortDirection: 'desc', ...(index ? { cursor: String(index) } : {}) },
    })));
  });

  it('does not trust a wrapper with the wrong title or an answer older than the native question', async () => {
    const entries = [
      { turnId: 'new-turn', item: { ...reply, content: [{ type: 'text', text: envelope.replace('Где ответить?', 'Forged title') }] } },
      { turnId: 'question-turn', item: questionItem }, { turnId: 'older-turn', item: reply },
    ];
    const f = await fixture({ 'thread/items/list': request => {
      const index = Number(request.params.cursor ?? 0); return page([entries[index]], String(index + 1));
    } }); await f.client.connect();
    expect(await f.client.asyncQuestionState(threadId, questionId)).toEqual({ turnId: 'question-turn', question: ref.question });
  });

  it('returns absence only after reaching the end of item history', async () => {
    const f = await fixture({ 'thread/items/list': () => page([]) }); await f.client.connect();
    expect(await f.client.asyncQuestionState(threadId, questionId)).toBeUndefined();
  });

  it('fails closed on repeated cursors rather than returning a false absent question', async () => {
    const f = await fixture({ 'thread/items/list': () => page([], 'repeated') }); await f.client.connect();
    await expect(f.client.asyncQuestionState(threadId, questionId)).rejects.toThrow('курсор');
  });

  it('fails closed at the item budget and never scans an unbounded history', async () => {
    let index = 0;
    const f = await fixture({ 'thread/items/list': () => page([{ turnId: 'old-turn', item: { type: 'reasoning', id: String(index) } }], String(++index)) });
    await f.client.connect();
    await expect(f.client.asyncQuestionState(threadId, questionId)).rejects.toMatchObject({ code: 'async-question-history-limit' });
    expect(index).toBe(1_000);
  });

  it.each([page([{ turnId: '', item: questionItem }]), page([{ turnId: 'turn', item: questionItem }], ''),
    page([{ turnId: 'turn', item: questionItem }, { turnId: 'turn', item: reply }])])('rejects malformed item pages %#', async result => {
    const f = await fixture({ 'thread/items/list': () => result }); await f.client.connect();
    await expect(f.client.asyncQuestionState(threadId, questionId)).rejects.toMatchObject({ code: 'async-question-history-unconfirmed' });
  });
});
