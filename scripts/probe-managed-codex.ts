/** Fixture driver: real Rele engine/SQLite/managed transport, synthetic channels only. */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexClient, CodexTransportError } from '../src/server/codex.js';
import { CodexContextReceipts } from '../src/server/codex-context-receipts.js';
import { Engine } from '../src/server/engine.js';
import { Store } from '../src/server/store.js';
import { defaultConfig } from '../src/server/config.js';
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
store.createConversation({ name: 'Managed fixture', threadId: values.thread, cwd: values.directory,
  bindings: Object.values(endpoints).map(endpoint => ({ platform: endpoint.platform, endpointId: endpoint.id, allowedSenderIds: ['fixture-user'] })),
});
const slackHistory: SlackTranscriptMessage[] = [{
  endpointId: endpoints.slack.id, accountId: endpoints.slack.accountId, chatId: endpoints.slack.chatId,
  threadId: endpoints.slack.threadId, messageId: '1700000000.000001',
  sender: { id: 'fixture-peer-bot', name: 'Peer agent', isBot: true },
  text: 'passive-peer-agent-context', payload: { text: 'passive-peer-agent-context' }, kind: 'message',
}];
let codex!: CodexClient;
let engine!: Engine;
const diagnostics: string[] = [];
let oldPid: number | undefined;
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function start(): Promise<void> {
  codex = new CodexClient(config.codex);
  engine = new Engine(store, codex, { config: () => config, temporaryRoot: values.directory!, redact: value => String(value) });
  for (const platform of ['slack', 'telegram'] as const) engine.channels[platform] = {
    state: { configured: true, connected: true, name: platform, accountId: endpoints[platform].accountId },
    readThreadPage: async () => ({ messages: platform === 'slack' ? [...slackHistory] : [] }),
    start: async () => {}, stop: async () => {}, download: async () => { throw new Error('Audio not used in this fixture'); },
    deliver: async delivery => `${platform}:${delivery.id}`,
  } satisfies Channel;
  engine.on('diagnostic', message => { diagnostics.push(String(message)); });
  await codex.connect();
  engine.start();
}
async function snapshot() {
  return { status: codex.status(), runtime: codex.runtimeInfo(), runtimeProcessId: (await codex.diagnostics()).process.id,
    requests: store.listRequests(), deliveries: store.listDeliveries(), diagnostics,
  };
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
      threadId: thread, itemId: `rele_slack_${entryId}`, text });
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
  process.stdout.write(JSON.stringify({ ready: true, catalog: await codex.listThreads(), ...(await snapshot()) }) + '\n');
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
      const until = Date.now() + 40_000;
      while (store.activeRequests().length && Date.now() < until) {
        await engine.pump(); await engine.settled(); await delay(100);
      }
      if (store.activeRequests().length) throw new Error(`Fixture requests did not finish: ${JSON.stringify(store.listRequests())}`);
      await engine.settled(); await engine.pump();
    } else if (command.action === 'fresh-context') {
      freshContext = await freshContextProof();
    } else if (command.action === 'restart') {
      oldPid = (await codex.diagnostics()).process.id;
      await engine.stop(); await codex.close();
      if (processAlive(oldPid)) throw new Error('Owned Codex process survived an awaited close');
      await start();
    } else if (command.action === 'close') {
      const pid = (await codex.diagnostics()).process.id;
      await engine.stop(); await codex.close();
      process.stdout.write(JSON.stringify({ stopped: true, childExited: !processAlive(pid) }) + '\n');
      break;
    } else if (command.action !== 'snapshot') throw new Error('Unknown fixture action');
    process.stdout.write(JSON.stringify({ action: command.action, ...(freshContext ? { freshContext } : {}), ...(oldPid ? { previousProcessId: oldPid } : {}), ...(await snapshot()) }) + '\n');
  }
} finally {
  lines.close();
  if (engine) await engine.stop();
  if (codex) await codex.close();
  store.close();
}
