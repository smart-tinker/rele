import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine, type CodexGateway, type EngineOptions } from '../src/server/engine.js';
import { Store } from '../src/server/store.js';
import { defaultConfig } from '../src/server/config.js';
import { CodexTransportError, type CodexNotification, type CodexServerRequest, type RequestLocation } from '../src/server/codex.js';
import { ChannelError, type ApprovalAction, type Channel } from '../src/server/channels/common.js';
import type { Approval, Delivery, Endpoint, InboundMessage, Platform, ReleRequest } from '../src/shared/types.js';

const THREAD = 'codex-shared-thread';
const fixtures: Array<{ engine: Engine; store: Store }> = [];
const directories: string[] = [];
const pending: Array<() => void> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  pending.push(() => reject(new Error('Test cleanup')));
  return { promise, resolve, reject };
}

class FakeCodex extends EventEmitter implements CodexGateway {
  connected = true;
  queueSupported = true;
  locations = new Map<string, RequestLocation>();
  status = vi.fn(() => ({ configured: true, connected: this.connected, queueSupported: this.queueSupported, desktopVerified: false }));
  subscribe = vi.fn(async (_threadId: string) => {});
  enqueue = vi.fn(async (_threadId: string, _text: string, clientId: string) => {
    const queuedSubmissionId = `queue-${clientId}`;
    this.locations.set(clientId, { state: 'queued', queuedSubmissionId });
    return { queuedSubmissionId };
  });
  findRequest = vi.fn(async (_threadId: string, clientId: string): Promise<RequestLocation> => this.locations.get(clientId) ?? { state: 'not_found' });
  respond = vi.fn(async (_rpcId: string | number, _result: unknown) => {});
  interrupt = vi.fn(async (_threadId: string, _turnId: string) => {});
  deleteQueued = vi.fn(async (_threadId: string, _queuedSubmissionId: string) => ({ deleted: true }));
  startQueued = vi.fn(async (_threadId: string, _queuedSubmissionId?: string) => ({ turn: { id: 'resumed-turn', status: 'inProgress', items: [] } }));
  notification(event: CodexNotification): void { this.emit('notification', event); }
  request(event: CodexServerRequest): void { this.emit('request', event); }
  connection(connected: boolean): void { this.connected = connected; this.emit('status'); }
  running(requestId: string, turnId = 'turn-1'): void {
    this.locations.set(requestId, { state: 'running', turnId });
    this.notification({ method: 'item/started', params: { threadId: THREAD, turnId, item: { type: 'userMessage', clientId: requestId } } });
  }
  complete(requestId: string, text: string, turnId = 'turn-1', mixed = false): void {
    this.locations.set(requestId, { state: 'completed', turnId, text, mixed });
    this.notification({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: turnId, status: 'completed' } } });
  }
}

function fakeChannel(platform: Platform) {
  const channel = {
    state: { configured: true, connected: true, name: platform },
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), download: vi.fn(async () => {}),
    deliver: vi.fn(async (_delivery: Delivery, _approval?: Approval): Promise<string> => `${platform}-remote-${channel.deliver.mock.calls.length}`),
  } satisfies Channel;
  return channel;
}

function endpoints(): Record<Platform, Endpoint> {
  const updatedAt = new Date().toISOString();
  return {
    slack: { id: 'slack-endpoint', platform: 'slack', accountId: 'team:bot-user', chatId: 'C-infra', threadId: '170000.123', title: 'Team / Infrastructure', subtitle: 'Slack thread', people: [{ id: 'U1', name: 'Alex' }], updatedAt },
    telegram: { id: 'telegram-endpoint', platform: 'telegram', accountId: '999', chatId: '-100123', threadId: '17', title: 'Infrastructure / Backups', subtitle: 'Telegram topic', people: [{ id: '123', name: 'Alex' }], updatedAt },
  };
}

function fixture(options: { path?: string; start?: boolean; transcribe?: EngineOptions['transcribe'] } = {}) {
  let path = options.path;
  if (!path) {
    const dir = mkdtempSync(join(tmpdir(), 'rele-engine-'));
    directories.push(dir);
    path = join(dir, 'rele.sqlite');
  }
  const store = new Store(path);
  const eps = endpoints();
  if (!store.listConversations().length) {
    for (const ep of Object.values(eps)) store.upsertEndpoint(ep);
    store.createConversation({ name: 'Shared infrastructure', threadId: THREAD, cwd: '/projects/infra', bindings: Object.values(eps).map(ep => ({ platform: ep.platform, endpointId: ep.id, allowedSenderIds: [ep.people[0].id] })) });
  }
  const codex = new FakeCodex();
  const slack = fakeChannel('slack');
  const telegram = fakeChannel('telegram');
  const diagnostics: string[] = [];
  const engine = new Engine(store, codex, { config: () => structuredClone(defaultConfig), temporaryRoot: dirname(path),
    redact: error => error instanceof Error ? error.message : String(error), transcribe: options.transcribe });
  engine.channels = { slack, telegram };
  engine.on('diagnostic', (error: string) => diagnostics.push(error));
  fixtures.push({ engine, store });
  if (options.start !== false) engine.start();
  return { engine, store, codex, slack, telegram, eps, path, diagnostics,
    conversation: store.listConversations()[0],
    message(platform: Platform, eventId = '1', overrides: Partial<InboundMessage> = {}): InboundMessage {
      const endpoint = eps[platform];
      return { eventId, endpoint, sender: endpoint.people[0], messageId: `${platform}-message-${eventId}`, text: `${platform} task ${eventId}`, ...overrides };
    } };
}

async function acceptRequest(f: ReturnType<typeof fixture>, platform: Platform = 'slack', eventId = '1'): Promise<ReleRequest> {
  await f.engine.receive(f.message(platform, eventId));
  await f.engine.settled();
  const request = f.store.listRequests().find(row => row.origin.platform === platform && row.eventId === eventId)!;
  expect(request).toBeDefined();
  return request;
}
async function running(f: ReturnType<typeof fixture>, request: ReleRequest, turnId = 'turn-1'): Promise<void> {
  f.codex.running(request.id, turnId);
  await f.engine.settled();
}
async function requestApproval(f: ReturnType<typeof fixture>, request: ReleRequest, question = false): Promise<Approval> {
  await running(f, request);
  f.codex.request({ id: 'approval-rpc', method: question ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval', params: {
    threadId: THREAD, turnId: 'turn-1', itemId: 'approval-item', command: 'Check backups', availableDecisions: ['accept', 'decline'],
    ...(question ? { questions: [{ id: 'target', header: 'Target', question: 'Which branch?' }] } : {}),
  } });
  await f.engine.settled();
  return f.store.listApprovals()[0];
}

afterEach(async () => {
  for (const reject of pending.splice(0)) reject();
  for (const { engine } of fixtures) await engine.stop();
  for (const { store } of fixtures.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Engine correlation and queue', () => {
  it('serializes both origins in one Codex thread and routes each result only to its immutable origin', async () => {
    const f = fixture();
    const slackMessage = f.message('slack');
    const telegramMessage = f.message('telegram');
    await Promise.all([f.engine.receive(slackMessage), f.engine.receive(telegramMessage), f.engine.receive(slackMessage)]);
    await f.engine.settled();
    const first = f.store.listRequests().find(row => row.origin.platform === 'slack')!;
    const second = f.store.listRequests().find(row => row.origin.platform === 'telegram')!;
    expect(f.store.listRequests()).toHaveLength(2);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    expect(f.codex.enqueue).toHaveBeenLastCalledWith(THREAD, slackMessage.text, first.id);

    await running(f, first);
    f.codex.complete(first.id, 'Slack answer');
    await f.engine.settled();
    await f.engine.pump();
    await f.engine.settled();
    expect(f.slack.deliver).toHaveBeenCalledTimes(1);
    expect(f.slack.deliver.mock.calls[0][0]).toMatchObject({ requestId: first.id, body: 'Slack answer', origin: first.origin });
    expect(f.telegram.deliver).not.toHaveBeenCalled();
    expect(f.codex.enqueue).toHaveBeenCalledTimes(2);
    expect(f.codex.enqueue).toHaveBeenLastCalledWith(THREAD, telegramMessage.text, second.id);

    await running(f, second, 'turn-2');
    f.codex.complete(second.id, 'Telegram answer', 'turn-2');
    await f.engine.settled();
    await f.engine.pump();
    expect(f.telegram.deliver).toHaveBeenCalledTimes(1);
    expect(f.telegram.deliver.mock.calls[0][0]).toMatchObject({ requestId: second.id, body: 'Telegram answer', origin: second.origin });
    await f.engine.receive(slackMessage);
    await f.engine.settled();
    expect(f.codex.enqueue).toHaveBeenCalledTimes(2);
    expect(f.store.listDeliveries()).toHaveLength(2);
  });

  it('handles user and completion events arriving before the enqueue acknowledgement', async () => {
    const f = fixture();
    const acknowledgement = deferred<{ queuedSubmissionId: string }>();
    f.codex.enqueue.mockImplementationOnce(async (_thread, _text, clientId) => {
      f.codex.running(clientId);
      f.codex.complete(clientId, 'Fast answer');
      return acknowledgement.promise;
    });
    await f.engine.receive(f.message('telegram'));
    await vi.waitFor(() => expect(f.store.listRequests()[0]?.status).toBe('completed'));
    acknowledgement.resolve({ queuedSubmissionId: 'early-queue' });
    await f.engine.settled();
    await f.engine.pump();
    expect(f.store.listRequests()[0]).toMatchObject({ status: 'completed', queuedSubmissionId: 'early-queue' });
    expect(f.telegram.deliver).toHaveBeenCalledTimes(1);
    expect(f.slack.deliver).not.toHaveBeenCalled();
  });

  it('keeps Desktop turns and their approval requests inside Codex', async () => {
    const f = fixture();
    f.codex.notification({ method: 'item/started', params: { threadId: THREAD, turnId: 'desktop-turn', item: { type: 'userMessage', clientId: null } } });
    f.codex.request({ id: 'desktop-approval', method: 'item/commandExecution/requestApproval', params: { threadId: THREAD, turnId: 'desktop-turn', itemId: 'desktop-item', command: 'Desktop command' } });
    f.codex.notification({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: 'desktop-turn', status: 'completed' } } });
    await f.engine.settled();
    await f.engine.pump();
    expect(f.store.listRequests()).toEqual([]);
    expect(f.store.listApprovals()).toEqual([]);
    expect(f.codex.respond).not.toHaveBeenCalled();
    expect(f.slack.deliver).not.toHaveBeenCalled();
    expect(f.telegram.deliver).not.toHaveBeenCalled();
  });

  it('never publishes a mixed Desktop/Rele answer, including after reconnect and an incomplete history snapshot', async () => {
    const f = fixture();
    const request = await acceptRequest(f);
    await running(f, request);
    f.codex.notification({ method: 'item/started', params: { threadId: THREAD, turnId: 'turn-1', item: { type: 'userMessage', clientId: null } } });
    await f.engine.settled();
    expect(f.store.getRequest(request.id)?.status).toBe('uncertain');
    f.codex.connection(false);
    f.codex.locations.set(request.id, { state: 'completed', turnId: 'turn-1', text: 'Contains Desktop-only context', mixed: false });
    f.codex.connection(true);
    await f.engine.settled();
    await f.engine.pump();
    expect(f.store.getRequest(request.id)?.status).toBe('failed');
    expect(f.store.listDeliveries()).toEqual([]);
    expect(f.slack.deliver).not.toHaveBeenCalled();
    expect(f.telegram.deliver).not.toHaveBeenCalled();
  });

  it('never enqueues again after a lost acknowledgement and recovers accepted work by its UUID', async () => {
    const f = fixture();
    f.codex.enqueue.mockImplementationOnce(async (_thread, _text, clientId) => {
      f.codex.locations.set(clientId, { state: 'queued', queuedSubmissionId: 'accepted-queue' });
      throw new CodexTransportError('Connection lost after acceptance');
    });
    const request = await acceptRequest(f, 'telegram');
    expect(f.store.getRequest(request.id)?.status).toBe('uncertain');
    await f.engine.pump();
    await f.engine.pump();
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    await f.engine.reconcile(request.id);
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'starting', queuedSubmissionId: 'accepted-queue' });
    await running(f, request);
    f.codex.complete(request.id, 'Recovered answer');
    await f.engine.settled();
    await f.engine.pump();
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    expect(f.telegram.deliver).toHaveBeenCalledTimes(1);
    expect(f.telegram.deliver.mock.calls[0][0].body).toBe('Recovered answer');
  });

  it('keeps a request uncertain when history cannot establish whether it was accepted', async () => {
    const f = fixture();
    f.codex.enqueue.mockRejectedValueOnce(new CodexTransportError('Lost ACK'));
    const request = await acceptRequest(f);
    await f.engine.reconcile(request.id);
    await f.engine.pump();
    expect(f.store.getRequest(request.id)?.status).toBe('uncertain');
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    expect(f.store.listDeliveries()).toEqual([]);
  });

  it('does not overwrite a terminal request with a stale reconciliation result', async () => {
    const f = fixture();
    const request = await acceptRequest(f);
    const lookup = deferred<RequestLocation>();
    f.codex.findRequest.mockImplementationOnce(() => lookup.promise);
    const reconciliation = f.engine.reconcile(request.id);
    await vi.waitFor(() => expect(f.codex.findRequest).toHaveBeenCalledTimes(1));
    f.store.finishRequest(request.id, { status: 'cancelled' }, []);
    lookup.resolve({ state: 'running', turnId: 'stale-turn' });
    await reconciliation;
    expect(f.store.getRequest(request.id)?.status).toBe('cancelled');
    expect(f.store.listDeliveries()).toEqual([]);
  });
});

describe('Engine approvals', () => {
  it('withholds an approval when an earlier Desktop message made the same turn mixed', async () => {
    const f = fixture();
    const request = await acceptRequest(f, 'telegram');
    f.codex.notification({ method: 'item/started', params: { threadId: THREAD, turnId: 'turn-1', item: { type: 'userMessage', clientId: null } } });
    f.codex.running(request.id);
    f.codex.locations.set(request.id, { state: 'running', turnId: 'turn-1', mixed: true });
    f.codex.request({ id: 'mixed-approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: THREAD, turnId: 'turn-1', itemId: 'desktop-related-command', command: 'Command from the mixed turn', availableDecisions: ['accept', 'decline'],
    } });
    await f.engine.settled();
    expect(f.store.getRequest(request.id)?.status).toBe('uncertain');
    expect(f.store.listApprovals()).toEqual([]);
    expect(f.store.listDeliveries()).toEqual([]);
    expect(f.telegram.deliver).not.toHaveBeenCalled();
    expect(f.codex.respond).not.toHaveBeenCalled();
  });

  it('requires the original platform, account, chat, thread and sender before answering', async () => {
    const f = fixture();
    const request = await acceptRequest(f, 'telegram');
    const approval = await requestApproval(f, request);
    const valid: ApprovalAction = { approvalId: approval.id, decision: 'accept', platform: 'telegram', accountId: request.origin.accountId,
      chatId: request.origin.chatId, threadId: request.origin.threadId, senderId: request.origin.senderId };
    for (const patch of [{ platform: 'slack' }, { accountId: 'other-account' }, { chatId: 'other-chat' }, { threadId: 'other-thread' }, { threadId: undefined }, { senderId: 'other-sender' }]) {
      await expect(f.engine.action({ ...valid, ...patch } as ApprovalAction)).rejects.toThrow();
    }
    expect(f.codex.respond).not.toHaveBeenCalled();
    await f.engine.action(valid);
    expect(f.codex.respond).toHaveBeenCalledExactlyOnceWith('approval-rpc', { decision: 'accept' });
    expect(f.store.getApproval(approval.id)).toMatchObject({ status: 'answered', decision: 'accept' });
    expect(f.store.getRequest(request.id)?.status).toBe('running');
    await expect(f.engine.action(valid)).rejects.toThrow(/завершено|недоступно/);
    expect(f.codex.respond).toHaveBeenCalledTimes(1);
  });

  it('persists a question-reply receipt before writing to Codex and never turns its replay into a new task', async () => {
    const f = fixture();
    const request = await acceptRequest(f, 'telegram');
    const approval = await requestApproval(f, request, true);
    const prompt = f.store.listDeliveries().find(row => row.approvalId === approval.id)!;
    expect(prompt.status).toBe('sent');
    const reply = f.message('telegram', 'question-answer', { text: 'main', replyToMessageId: prompt.remoteMessageId });
    let receiptWasDurable = false;
    f.codex.respond.mockImplementationOnce(async () => {
      receiptWasDurable = f.store.recordInbound(reply).duplicate;
      throw new CodexTransportError('Lost answer acknowledgement');
    });
    await expect(f.engine.receive(reply)).rejects.toThrow();
    expect(receiptWasDurable).toBe(true);
    expect(f.store.getRequest(request.id)?.status).toBe('uncertain');
    await f.engine.receive(reply);
    await f.engine.settled();
    expect(f.store.listRequests()).toHaveLength(1);
    expect(f.codex.respond).toHaveBeenCalledTimes(1);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
  });

  it('ignores another sender answering a question and handles a successful reply once', async () => {
    const f = fixture();
    const request = await acceptRequest(f, 'telegram');
    const approval = await requestApproval(f, request, true);
    const prompt = f.store.listDeliveries().find(row => row.approvalId === approval.id)!;
    const wrong = f.message('telegram', 'wrong-answer', { text: 'other branch', replyToMessageId: prompt.remoteMessageId, sender: { id: 'intruder', name: 'Alex' } });
    await f.engine.receive(wrong);
    expect(f.codex.respond).not.toHaveBeenCalled();
    const reply = f.message('telegram', 'valid-answer', { text: 'main', replyToMessageId: prompt.remoteMessageId });
    await f.engine.receive(reply);
    await f.engine.receive(reply);
    await f.engine.settled();
    expect(f.codex.respond).toHaveBeenCalledExactlyOnceWith('approval-rpc', { answers: { target: { answers: ['main'] } } });
    expect(f.store.listRequests()).toHaveLength(1);
  });
});

describe('Engine restart and outbox', () => {
  it('delivers a committed final answer after restart without running Codex again', async () => {
    const first = fixture();
    const request = await acceptRequest(first);
    await running(first, request);
    first.codex.complete(request.id, 'Durable final answer');
    await first.engine.settled();
    expect(first.store.getRequest(request.id)?.status).toBe('completed');
    expect(first.store.listDeliveries()[0]?.status).toBe('pending');
    await first.engine.stop();
    first.store.close();

    const restarted = fixture({ path: first.path });
    await restarted.engine.pump();
    expect(restarted.codex.enqueue).not.toHaveBeenCalled();
    expect(restarted.slack.deliver).toHaveBeenCalledTimes(1);
    expect(restarted.slack.deliver.mock.calls[0][0]).toMatchObject({ body: 'Durable final answer', origin: request.origin });
    await restarted.engine.receive(restarted.message('slack'));
    await restarted.engine.settled();
    expect(restarted.store.listRequests()).toHaveLength(1);
    expect(restarted.slack.deliver).toHaveBeenCalledTimes(1);
  });

  it('does not automatically retry a delivery whose transport acknowledgement is unknown', async () => {
    const f = fixture();
    const request = await acceptRequest(f);
    await running(f, request);
    f.slack.deliver.mockRejectedValueOnce(new ChannelError('Unknown delivery result', false, true));
    f.codex.complete(request.id, 'May already be delivered');
    await f.engine.settled();
    await f.engine.pump();
    const delivery = f.store.listDeliveries()[0];
    expect(delivery.status).toBe('uncertain');
    await f.engine.pump();
    await f.engine.pump();
    expect(f.slack.deliver).toHaveBeenCalledTimes(1);
    expect(() => f.engine.retryDelivery(delivery.id)).toThrow(/Неопределённую/);
  });

  it('recovers an interrupted sending record as uncertain and retains the remaining parts', async () => {
    const first = fixture();
    const request = await acceptRequest(first, 'telegram');
    first.store.finishRequest(request.id, { status: 'completed' }, [
      { key: 'answer:0', ordinal: 0, kind: 'answer', body: 'First part' },
      { key: 'answer:1', ordinal: 1, kind: 'answer', body: 'Second part' },
    ]);
    const sending = first.store.claimDelivery()!;
    await first.engine.stop();
    first.store.close();
    const restarted = fixture({ path: first.path });
    await restarted.engine.pump();
    expect(restarted.store.getDelivery(sending.id)?.status).toBe('uncertain');
    expect(restarted.store.listDeliveries().find(row => row.key === 'answer:1')?.status).toBe('pending');
    expect(restarted.telegram.deliver).not.toHaveBeenCalled();
    expect(restarted.codex.enqueue).not.toHaveBeenCalled();
  });
});
