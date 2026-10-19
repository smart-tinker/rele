import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { CodexClient, CodexTransportError, classifyCodexConnectionFailure, type CodexNotification } from '../src/server/codex.js';

interface Rpc { id?: string | number; method?: string; params: Record<string, unknown>; result?: unknown }
type Handler = (message: Rpc, socket: WebSocket) => unknown | Promise<unknown>;
const noResponse = Symbol('no response');
const threadId = randomUUID();
const rawThread = { id: threadId, name: 'Релиз Rele', preview: 'Общий контекст', cwd: '/project', updatedAt: 123, status: { type: 'idle' } };
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(handlers: Record<string, Handler> = {}) {
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
  const client = new CodexClient({ transport: 'websocket', executable: 'codex', endpoint });
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

  it('initializes the experimental protocol and lists paginated names without resuming threads', async () => {
    const f = await fixture({
      'thread/list': message => message.params.cursor
        ? { data: [{ ...rawThread, id: 'second', name: null, preview: '  Название\nиз контекста  ' }], nextCursor: null }
        : { data: [rawThread], nextCursor: 'page-2' },
    });
    await f.client.connect();
    expect(f.client.status()).toMatchObject({ connected: true, queueSupported: true, desktopVerified: false, name: 'Codex 0.163.0' });
    expect(f.calls[0]).toMatchObject({ method: 'initialize', params: { capabilities: { experimentalApi: true } } });
    const threads = await f.client.listThreads();
    expect(threads.map(thread => thread.name)).toEqual(['Релиз Rele', 'Название из контекста']);
    for (const call of f.calls.filter(call => call.method === 'thread/list')) {
      expect(call.params).toMatchObject({ archived: false, sourceKinds: expect.arrayContaining(['cli', 'vscode', 'appServer', 'exec']) });
    }
    expect(f.calls.some(call => call.method === 'thread/resume')).toBe(false);
    await f.client.readThread(threadId);
    expect(f.calls.at(-1)).toMatchObject({ method: 'thread/read', params: { threadId } });
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

  it('recovers an accepted request from queue or paginated completed history without resending', async () => {
    const clientId = randomUUID();
    const f = await fixture({
      'thread/queue/list': () => ({ data: [{ id: 'queue-id', clientUserMessageId: clientId }], nextCursor: null }),
    });
    await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId)).toEqual({ state: 'queued', queuedSubmissionId: 'queue-id' });
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

  it('does not recover a mixed Desktop/Rele turn as a routable answer', async () => {
    const clientId = randomUUID();
    const f = await fixture({ 'thread/turns/list': () => ({ data: [{ id: 'mixed', status: 'completed', items: [
      { type: 'userMessage', clientId }, { type: 'userMessage', clientId: null },
      { type: 'agentMessage', phase: 'final_answer', text: 'Ответ на два запроса' },
    ] }], nextCursor: null }) });
    await f.client.connect();
    expect(await f.client.findRequest(threadId, clientId)).toEqual({ state: 'completed', turnId: 'mixed', mixed: true });
  });

  it('rejects duplicate queued identifiers instead of treating queue/add as idempotent', async () => {
    const clientId = randomUUID();
    const f = await fixture({ 'thread/queue/list': () => ({ data: [
      { id: 'queue-1', clientUserMessageId: clientId }, { id: 'queue-2', clientUserMessageId: clientId },
    ], nextCursor: null }) });
    await f.client.connect();
    await expect(f.client.findRequest(threadId, clientId)).rejects.toThrow('несколько запросов');
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
