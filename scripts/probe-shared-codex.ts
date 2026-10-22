/** Isolated native shared gate driver: real Rele client/engine/store, synthetic channels. */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigStore, defaultConfig, defaultDataDirectory } from '../src/server/config.js';
import { CodexClient } from '../src/server/codex.js';
import { Engine } from '../src/server/engine.js';
import { Store } from '../src/server/store.js';
import type { Channel } from '../src/server/channels/common.js';
import type { Endpoint, Platform, SlackTranscriptMessage } from '../src/shared/types.js';

const { values } = parseArgs({ options: {
  executable: { type: 'string' }, home: { type: 'string' }, directory: { type: 'string' },
  thread: { type: 'string' }, prepare: { type: 'boolean' }, 'profile-socket': { type: 'string' }, 'expect-error': { type: 'string' },
} });
if (!values.executable || !values.home || !values.directory || !process.env.RELE_DATA_DIR) throw new Error('Missing isolated fixture paths');
const config = { ...structuredClone(defaultConfig), codex: {
  transport: 'shared' as const, executable: values.executable, endpoint: '', codexHome: values.home,
} };
const saved = new ConfigStore(defaultDataDirectory());
await saved.load();
await saved.save(config);
if (values['expect-error']) {
  const client = new CodexClient(config.codex);
  try { await client.connect(); } catch { /* Assert the exact production fence below. */ }
  const status = client.status();
  await client.close();
  if (status.connected || status.errorCode !== values['expect-error']) throw new Error('Expected production shared owner fence was not observed');
  process.stdout.write(JSON.stringify({ expectedError: status.errorCode, disconnected: true }) + '\n');
} else if (values['profile-socket']) {
  // Test-only resolver fault: the real native initialize response must still fence another profile.
  const client = new CodexClient(config.codex, { shared: async target => ({
    ...target, transport: 'proxy', endpoint: values['profile-socket']!,
  }) });
  let rejected = false;
  try { await client.connect(); } catch { rejected = client.status().errorCode === 'shared-profile-mismatch'; }
  const disconnected = !client.status().connected;
  await client.close();
  if (!rejected || !disconnected) throw new Error('Native wrong-profile initialize was not fenced');
  process.stdout.write(JSON.stringify({ profileRejected: true, disconnected }) + '\n');
} else if (values.prepare) {
  process.stdout.write(JSON.stringify({ prepared: true, platform: process.platform }) + '\n');
} else {
  const store = new Store(join(values.directory, 'rele.sqlite'));
  const endpoints = Object.fromEntries((['slack', 'telegram'] as const).map(platform => [platform, {
    id: `shared-${platform}`, platform, accountId: 'fixture-account', chatId: platform === 'slack' ? 'CSHARED' : '-100123',
    threadId: platform === 'slack' ? '1700000000.000000' : '17', title: `Shared ${platform}`, subtitle: 'Synthetic origin',
    people: [{ id: 'fixture-user', name: 'Fixture human' }], updatedAt: new Date().toISOString(),
  } satisfies Endpoint])) as Record<Platform, Endpoint>;
  for (const endpoint of Object.values(endpoints)) store.upsertEndpoint(endpoint);
  const history: SlackTranscriptMessage[] = [{ endpointId: endpoints.slack.id, accountId: endpoints.slack.accountId,
    chatId: endpoints.slack.chatId, threadId: endpoints.slack.threadId, messageId: '1700000000.000001',
    sender: { id: 'fixture-agent', name: 'Other agent', isBot: true }, text: 'shared-passive-agent-context',
    payload: { text: 'shared-passive-agent-context', preserved: { full: true } }, kind: 'message' }];
  const diagnostics: string[] = [];
  const observedTurns: Array<{ method: string; threadId: string; turnId: string }> = [];
  let codex: CodexClient | undefined, engine: Engine | undefined;
  let threadId = values.thread;
  let loseNextQueueAck = false, droppedQueueAcks = 0, catalogValidated = false;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  async function start() {
    codex = new CodexClient(config.codex);
    codex.on('notification', (event: { method: string; params: { threadId?: unknown; turn?: { id?: unknown } } }) => {
      if (['turn/started', 'turn/completed'].includes(event.method) && typeof event.params.threadId === 'string' && typeof event.params.turn?.id === 'string') {
        observedTurns.push({ method: event.method, threadId: event.params.threadId, turnId: event.params.turn.id });
        if (observedTurns.length > 100) observedTurns.shift();
      }
    });
    await codex.connect();
    const enqueue = codex.enqueue.bind(codex);
    codex.enqueue = async (...args) => {
      const result = await enqueue(...args);
      if (loseNextQueueAck) { loseNextQueueAck = false; droppedQueueAcks++; throw new Error('Synthetic lost queue ACK after native acceptance'); }
      return result;
    };
    const previous = store.listConversations()[0];
    threadId = previous?.threadId ?? threadId;
    if (!threadId) {
      threadId = await codex.createThread(values.directory!);
      await codex.setThreadName(threadId, 'Original shared fixture');
    }
    if (values.thread || previous) {
      // Match manual selection in the real source route API, without pre-subscribing.
      let catalog = await codex.listThreads({ refresh: true });
      const deadline = Date.now() + 5_000;
      while (!catalog.some(thread => thread.id === threadId) && Date.now() < deadline) {
        await delay(100); catalog = await codex.listThreads({ refresh: true });
      }
      if (!catalog.some(thread => thread.id === threadId)) throw new Error('Original shared thread absent from refreshed production catalog');
      catalogValidated = true;
    }
    if (!previous) store.createConversation({ name: 'Original shared fixture', threadId, cwd: values.directory!,
      bindings: Object.values(endpoints).map(endpoint => ({ platform: endpoint.platform, endpointId: endpoint.id, allowedSenderIds: ['fixture-user'] })) });
    engine = new Engine(store, codex, { config: () => config, temporaryRoot: values.directory!, redact: value => String(value) });
    for (const platform of ['slack', 'telegram'] as const) engine.channels[platform] = {
      state: { configured: true, connected: true, name: platform, accountId: endpoints[platform].accountId },
      readThreadPage: async () => ({ messages: platform === 'slack' ? [...history] : [] }),
      start: async () => {}, stop: async () => {}, download: async () => { throw new Error('No audio in shared fixture'); },
      deliver: async delivery => `${platform}:${delivery.id}`,
    } satisfies Channel;
    engine.on('diagnostic', message => diagnostics.push(String(message)));
    engine.start();
  }
  async function snapshot() {
    if (!codex) throw new Error('Client is closed');
    return { threadId, configuredExecutable: config.codex.executable, status: codex.status(), runtime: codex.runtimeInfo(), runtimeProcessId: (await codex.diagnostics()).process.id,
      droppedQueueAcks, catalogValidated, observedTurns, requests: store.listRequests(), deliveries: store.listDeliveries(), approvals: store.listApprovals(), diagnostics };
  }
  const input = createInterface({ input: process.stdin });
  try {
    await start();
    process.stdout.write(JSON.stringify({ ready: true, ...(await snapshot()) }) + '\n');
    for await (const line of input) {
      const command = JSON.parse(line) as { action: string; platform?: Platform; text?: string; eventId?: string;
        requestId?: string; approvalId?: string; status?: string; turnId?: string; loseAck?: boolean };
      if (command.action === 'ingest') {
        loseNextQueueAck = command.loseAck === true;
        const platform = command.platform!;
        if (!endpoints[platform]) throw new Error('Unknown fixture origin');
        const messageId = platform === 'slack' ? `1700000001.${String(history.length).padStart(6, '0')}` : command.eventId!;
        const slack: SlackTranscriptMessage | undefined = platform === 'slack' ? { endpointId: endpoints.slack.id,
          accountId: endpoints.slack.accountId, chatId: endpoints.slack.chatId, threadId: endpoints.slack.threadId,
          messageId, sender: endpoints.slack.people[0], text: command.text!, payload: { text: command.text!, ts: messageId }, kind: 'message' } : undefined;
        if (slack) history.push(slack);
        await engine!.receive({ eventId: command.eventId!, endpoint: endpoints[platform], sender: endpoints[platform].people[0],
          messageId, text: command.text!, ...(slack ? { slack } : {}) });
        await engine!.settled();
      } else if (command.action === 'wait') {
        const until = Date.now() + 40_000;
        const pending = () => command.turnId ? !observedTurns.some(event =>
          event.method === 'turn/completed' && event.threadId === threadId && event.turnId === command.turnId) : command.status ? !store.listRequests().some(request =>
          (!command.requestId || request.id === command.requestId) && request.status === command.status) : store.activeRequests().length > 0;
        while (pending() && Date.now() < until) { await engine!.pump(); await engine!.settled(); await delay(50); }
        if (pending()) throw new Error(`Shared requests did not reach expected state: ${JSON.stringify(store.listRequests())}`);
        await engine!.pump(); await engine!.settled();
      } else if (command.action === 'answer') {
        await engine!.resolveApproval(command.approvalId!, 'decline');
      } else if (command.action === 'resume') {
        await engine!.resume(command.requestId!);
      } else if (command.action === 'cancel') {
        await engine!.cancel(command.requestId!);
      } else if (command.action === 'close') {
        const pid = (await codex!.diagnostics()).process.id;
        await engine!.stop(); await codex!.close();
        process.stdout.write(JSON.stringify({ stopped: true, runtimeProcessId: pid, backendAlive: alive(pid) }) + '\n');
        break;
      } else if (command.action !== 'snapshot') throw new Error('Unknown shared fixture command');
      process.stdout.write(JSON.stringify({ action: command.action, ...(await snapshot()) }) + '\n');
    }
  } finally {
    input.close();
    if (engine) await engine.stop();
    if (codex) await codex.close();
    store.close();
  }
}
