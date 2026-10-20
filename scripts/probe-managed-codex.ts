/** Fixture driver: real Rele engine/SQLite/managed transport, synthetic channels only. */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexClient } from '../src/server/codex.js';
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
const lines = createInterface({ input: process.stdin });
try {
  await start();
  process.stdout.write(JSON.stringify({ ready: true, catalog: await codex.listThreads(), ...(await snapshot()) }) + '\n');
  for await (const line of lines) {
    const command = JSON.parse(line) as { action: string; platform?: Platform; text?: string; eventId?: string };
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
    process.stdout.write(JSON.stringify({ action: command.action, ...(oldPid ? { previousProcessId: oldPid } : {}), ...(await snapshot()) }) + '\n');
  }
} finally {
  lines.close();
  if (engine) await engine.stop();
  if (codex) await codex.close();
  store.close();
}
