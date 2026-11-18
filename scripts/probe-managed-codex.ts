/** Fixture driver: real Rele engine/SQLite/managed transport, synthetic channels only. */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { closeManagedFixture, waitManagedQueue } from './managed-probe-wait.mjs';
import { CodexClient, CodexTransportError } from '../src/server/codex.js';
import { CodexContextReceipts } from '../src/server/codex-context-receipts.js';
import { Engine } from '../src/server/engine.js';
import { Store } from '../src/server/store.js';
import { defaultConfig } from '../src/server/config.js';
import { initialMessageKey } from '../src/server/initial-message.js';
import type { Channel } from '../src/server/channels/common.js';
import type { Endpoint, Platform, SlackTranscriptMessage } from '../src/shared/types.js';

const { values } = parseArgs({ options: {
  executable: { type: 'string' }, home: { type: 'string' }, directory: { type: 'string' },
  thread: { type: 'string' },
} });
if (!values.executable || !values.home || !values.directory || !values.thread) throw new Error('Missing isolated fixture paths.');
const config = { ...structuredClone(defaultConfig), codex: {
  transport: 'managed' as const, executable: values.executable, endpoint: '', codexHome: values.home,
} };
const store = new Store(join(values.directory, 'rele.sqlite'));
const endpoints = Object.fromEntries((['slack', 'telegram'] as const).map(platform => [platform, {
  id: `fixture-${platform}`, platform, accountId: 'synthetic-account', chatId: `synthetic-${platform}`,
  threadId: platform === 'slack' ? '1700000000.000000' : 'synthetic-topic', title: `Fixture ${platform}`, subtitle: 'Synthetic origin',
  people: [{ id: 'fixture-user', name: 'Fixture user' }], updatedAt: new Date().toISOString(),
} satisfies Endpoint])) as Record<Platform, Endpoint>;
for (const endpoint of Object.values(endpoints)) store.upsertEndpoint(endpoint);
const conversation = store.createConversation({ name: 'Managed fixture', threadId: values.thread, cwd: values.directory,
  bindings: Object.values(endpoints).map(endpoint => ({ platform: endpoint.platform, endpointId: endpoint.id, allowedSenderIds: ['fixture-user'] })),
});
// This ownership/history fixture starts with an initialized existing conversation.
const slackHistory: SlackTranscriptMessage[] = [{
  endpointId: endpoints.slack.id, accountId: endpoints.slack.accountId, chatId: endpoints.slack.chatId,
  threadId: endpoints.slack.threadId, messageId: '1700000000.000001',
  sender: { id: 'fixture-peer-bot', name: 'Peer agent', isBot: true },
  text: 'passive-peer-agent-context', payload: { text: 'passive-peer-agent-context' }, kind: 'message',
}];
let codex!: CodexClient;
let engine!: Engine;
const diagnostics: string[] = [];
const pendingOperations = new Map<number, string>();
let nextPendingOperation = 0;
let oldPid: number | undefined;
const safeRpcMethods = new Set([
  'server/diagnostics', 'thread/backgroundTerminals/list', 'thread/inject_items', 'thread/queue/add',
  'thread/queue/list', 'thread/read', 'thread/resume', 'thread/turns/list', 'thread/unsubscribe',
]);
function observe<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const id = ++nextPendingOperation;
  pendingOperations.set(id, label);
  try { return operation().finally(() => pendingOperations.delete(id)); }
  catch (error) { pendingOperations.delete(id); throw error; }
}
function observeMethod(target: object, method: string, label: string): void {
  const methods = target as Record<string, unknown>;
  const operation = methods[method];
  if (typeof operation !== 'function') return;
  methods[method] = function(this: unknown, ...args: unknown[]) {
    return observe(label, () => (operation as (this: unknown, ...args: unknown[]) => Promise<unknown>).apply(this, args));
  };
}
function pendingOperationLabels(): string[] { return [...new Set(pendingOperations.values())].sort(); }
let ownedPid: number | undefined;
let shutdown: ReturnType<typeof closeManagedFixture> | undefined;
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
async function start(): Promise<void> {
  shutdown = undefined;
  ownedPid = undefined;
  codex = new CodexClient(config.codex);
  const privateClient = codex as unknown as { call: (method: string, params: Record<string, unknown>, timeoutMs?: number, confirmHealth?: boolean) => Promise<unknown> };
  const nativeCall = privateClient.call.bind(codex);
  privateClient.call = (method, params, timeoutMs, confirmHealth) => observe(
    `rpc.${safeRpcMethods.has(method) ? method : 'other'}`,
    () => nativeCall(method, params, timeoutMs, confirmHealth),
  );
  engine = new Engine(store, codex, { config: () => config, temporaryRoot: values.directory!, redact: value => String(value) });
  for (const platform of ['slack', 'telegram'] as const) engine.channels[platform] = {
    state: { configured: true, connected: true, name: platform, accountId: endpoints[platform].accountId },
    readThreadPage: async () => ({ messages: platform === 'slack' ? [...slackHistory] : [] }),
    start: async () => {}, stop: async () => {}, download: async () => { throw new Error('Audio not used in this fixture'); },
    deliver: async delivery => `${platform}:${delivery.id}`,
  } satisfies Channel;
  const internalEngine = engine as unknown as Record<string, unknown>;
  for (const [method, label] of [
    ['deliver', 'pump.deliver'], ['flushProgress', 'pump.flushProgress'], ['flushApprovalUpdates', 'pump.flushApprovalUpdates'],
    ['retryPendingQuestions', 'pump.retryPendingQuestions'], ['refreshAsyncQuestions', 'pump.refreshAsyncQuestions'],
    ['provision', 'pump.provision'], ['reconcile', 'pump.reconcile'], ['dispatch', 'pump.dispatch'],
  ] as const) observeMethod(engine, method, label);
  for (const [owner, method, label] of [
    ['sourceControls', 'recover', 'pump.sourceControls.recover'], ['slackSync', 'backfill', 'pump.slackSync.backfill'],
    ['slackSync', 'drain', 'dispatch.slackSync.drain'], ['initialMessages', 'ensure', 'dispatch.initialMessages.ensure'],
  ] as const) {
    const target = internalEngine[owner];
    if (target && typeof target === 'object') observeMethod(target, method, label);
  }
  for (const [method, label] of [
    ['injectContext', 'dispatch.codex.injectContext'], ['subscribe', 'dispatch.codex.subscribe'],
    ['backgroundTerminals', 'dispatch.codex.backgroundTerminals'], ['enqueue', 'dispatch.codex.enqueue'],
    ['releaseThread', 'dispatch.codex.releaseThread'],
  ] as const) observeMethod(codex, method, label);
  engine.on('diagnostic', message => { diagnostics.push(String(message)); });
  await codex.connect();
  const connectedHome = codex.status().codexHome;
  assert(connectedHome, 'Codex did not report its connected profile');
  store.setMeta(initialMessageKey(connectedHome, store.getConversation(conversation.id)!.threadId), JSON.stringify({ applied: true }));
  engine.start();
}
async function snapshot() {
  const runtimeProcessId = (await codex.diagnostics()).process.id;
  ownedPid = runtimeProcessId;
  return { status: codex.status(), runtime: codex.runtimeInfo(), runtimeProcessId,
    requests: store.listRequests(), deliveries: store.listDeliveries(), diagnostics,
  };
}
function closeFixture() {
  return shutdown ??= closeManagedFixture(
    () => engine.stop(),
    () => codex.close(),
    () => ownedPid !== undefined && !processAlive(ownedPid),
  );
}
async function freshContextProof() {
  const home = join(values.home!, '..', 'f');
  await mkdir(home);
  await copyFile(join(values.home!, 'config.toml'), join(home, 'config.toml'));
  const fresh = new CodexClient({ ...config.codex, codexHome: home });
  let pid: number | undefined;
  let proof;
  try {
    await fresh.connect();
    pid = (await fresh.diagnostics()).process.id;
    if (fresh.status().queueSupported) throw new Error('Fresh fixture profile was not empty');
    const thread = await fresh.createThread(values.directory!);
    if (!fresh.status().queueSupported) throw new Error('New thread did not establish the queue gate');
    await fresh.setThreadName(thread, 'Fresh managed fixture');
    await fresh.releaseThread(thread);
    const startedTurns = new Set<string>();
    fresh.on('notification', event => {
      if (event.method === 'turn/started' && event.params.threadId === thread && typeof event.params.turn?.id === 'string') startedTurns.add(event.params.turn.id);
    });
    const entryId = randomUUID(), text = `First-turn managed Slack canary ${randomUUID()}`;
    await fresh.injectContext(thread, entryId, text);
    const metadata = await fresh.readThread(thread) as { thread: { path: string } };
    const receipt = await new CodexContextReceipts().has({ codexHome: home, rolloutPath: metadata.thread.path,
      threadId: thread, itemId: `rele-context-${createHash('sha256').update(JSON.stringify([thread, entryId])).digest('hex').slice(0, 48)}`, text });
    const passiveTurnsStarted = startedTurns.size;
    if (!receipt || passiveTurnsStarted !== 0) throw new Error('Fresh passive context created a turn or has no persisted receipt');
    const clientId = randomUUID();
    await fresh.enqueue(thread, 'First authorized managed request after passive context', clientId);
    const until = Date.now() + 25_000;
    let found;
    while (Date.now() < until) {
      try { found = await fresh.findRequest(thread, clientId); }
      catch (error) { if (!(error instanceof CodexTransportError) || error.code !== 'turn-interruption-unconfirmed') throw error; }
      if (found?.state === 'completed') break;
      if (found?.state === 'failed' || found?.state === 'interrupted') throw new Error('First managed request did not complete');
      await delay(50);
    }
    if (found?.state !== 'completed' || startedTurns.size !== 1) throw new Error(`Fresh managed request did not complete exactly one turn: ${JSON.stringify({ state: found?.state, turnsStarted: startedTurns.size })}`);
    proof = { queueEstablished: true, namedBeforeRelease: true, releasedBeforeContext: true, receiptBeforeFirstModel: true, passiveTurnsStarted, turnsStarted: startedTurns.size, text, answer: found.text };
  } finally { await fresh.close(); }
  if (pid && processAlive(pid)) throw new Error('Fresh managed child survived its awaited close');
  return { ...proof, childExited: true };
}

const lines = createInterface({ input: process.stdin });
try {
  await start();
  const initial = await snapshot();
  process.stdout.write(JSON.stringify({ ready: true, catalog: await codex.listThreads(), ...initial }) + '\n');
  for await (const line of lines) {
    const command = JSON.parse(line) as { action: string; platform?: Platform; text?: string; eventId?: string };
    let freshContext;
    if (command.action === 'ingest') {
      const platform = command.platform!;
      if (!endpoints[platform]) throw new Error('Unknown fixture origin');
      const messageId = platform === 'slack' ? `1700000001.${String(slackHistory.length).padStart(6, '0')}` : command.eventId!;
      const slack: SlackTranscriptMessage | undefined = platform === 'slack' ? {
        endpointId: endpoints.slack.id, accountId: endpoints.slack.accountId, chatId: endpoints.slack.chatId,
        threadId: endpoints.slack.threadId, messageId, sender: endpoints.slack.people[0], text: command.text!,
        payload: { text: command.text!, ts: messageId }, kind: 'message',
      } : undefined;
      if (slack) slackHistory.push(slack);
      await engine.receive({ eventId: command.eventId!, endpoint: endpoints[platform], sender: endpoints[platform].people[0],
        messageId, text: command.text!, ...(slack ? { slack } : {}),
      });
      await engine.settled();
    } else if (command.action === 'wait') {
      const result = await waitManagedQueue(
        () => store.activeRequests().length,
        () => engine.pump(),
        () => engine.settled(),
        () => delay(100),
      );
      if (!result.ok) {
        process.stdout.write(JSON.stringify({ action: command.action, ...result,
          activeRequestCount: store.activeRequests().length, pendingOperations: pendingOperationLabels() }) + '\n');
        process.exitCode = 1;
        continue;
      }
    } else if (command.action === 'fresh-context') {
      freshContext = await freshContextProof();
    } else if (command.action === 'restart') {
      oldPid = ownedPid ?? (await codex.diagnostics()).process.id;
      const stopped = await closeFixture();
      if (!stopped.ok || !stopped.childExited) throw new Error('Owned Codex cleanup was not confirmed');
      await start();
    } else if (command.action === 'close') {
      const stopped = await closeFixture();
      process.stdout.write(JSON.stringify({ action: command.action, ...stopped }) + '\n');
      if (!stopped.ok) process.exitCode = 1;
      break;
    } else if (command.action !== 'snapshot') throw new Error('Unknown fixture action');
    process.stdout.write(JSON.stringify({ action: command.action, ...(freshContext ? { freshContext } : {}), ...(oldPid ? { previousProcessId: oldPid } : {}), ...(await snapshot()) }) + '\n');
  }
} finally {
  lines.close();
  if (codex) {
    const stopped = await closeFixture();
    if (!stopped.ok) process.exitCode = 1;
  }
  store.close();
}
