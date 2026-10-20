import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine, type CodexGateway, type EngineOptions } from '../src/server/engine.js';
import { Store } from '../src/server/store.js';
import { defaultConfig } from '../src/server/config.js';
import { CodexThreadBusyError, CodexTransportError, type CodexNotification, type CodexServerRequest, type RequestLocation } from '../src/server/codex.js';
import { ChannelError, type ApprovalAction, type Channel } from '../src/server/channels/common.js';
import type { Approval, CodexConnectionState, Delivery, Endpoint, InboundMessage, Platform, ReleRequest } from '../src/shared/types.js';

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
  verifiedVersion = true;
  isVerifiedVersion = () => this.verifiedVersion;
  queueSupported = true;
  locations = new Map<string, RequestLocation>();
  transport: CodexConnectionState['transport'] = 'managed';
  status = vi.fn(() => ({ configured: true, connected: this.connected, queueSupported: this.queueSupported, desktopVerified: false, transport: this.transport }));
  createThread = vi.fn<(_cwd: string) => Promise<string>>().mockResolvedValue('auto-created-thread');
  setThreadName = vi.fn(async (_threadId: string, _name: string): Promise<void> => {});
  injectContext = vi.fn(async (_threadId: string, _entryId: string, _text: string) => {});
  subscribe = vi.fn(async (_threadId: string) => {});
  releaseThread = vi.fn(async (_threadId: string) => {});
  enqueue = vi.fn(async (_threadId: string, _text: string, clientId: string) => {
    const queuedSubmissionId = `queue-${clientId}`;
    this.locations.set(clientId, { state: 'queued', queuedSubmissionId });
    return { queuedSubmissionId };
  });
  findRequest = vi.fn(async (_threadId: string, clientId: string): Promise<RequestLocation> => this.locations.get(clientId) ?? { state: 'not_found' });
  respond = vi.fn(async (_rpcId: string | number, _result: unknown) => {});
  rejectRequest = vi.fn(async (_rpcId: string | number, _message: string) => {});
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
    state: { configured: true, connected: true, name: platform, accountId: platform === 'slack' ? 'team:bot-user' : '999' },
    readThreadPage: vi.fn<NonNullable<Channel['readThreadPage']>>().mockResolvedValue({ messages: [] }),
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
  const config = structuredClone(defaultConfig);
  const engine = new Engine(store, codex, { config: () => config, temporaryRoot: dirname(path),
    redact: error => error instanceof Error ? error.message : String(error), transcribe: options.transcribe });
  engine.channels = { slack, telegram };
  engine.on('diagnostic', (error: string) => diagnostics.push(error));
  fixtures.push({ engine, store });
  if (options.start !== false) engine.start();
  return { engine, store, codex, slack, telegram, eps, path, diagnostics, config,
    conversation: store.listConversations()[0],
    message(platform: Platform, eventId = '1', overrides: Partial<InboundMessage> = {}): InboundMessage {
      const endpoint = eps[platform];
      return { eventId, endpoint, sender: endpoint.people[0], messageId: platform === 'slack' ? `170001.${String([...eventId].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 0) >>> 0).slice(-6).padStart(6, '0')}` : `${platform}-message-${eventId}`, text: `${platform} task ${eventId}`, ...overrides };
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
  vi.useRealTimers();
});

describe('Engine correlation and queue', () => {
  it('keeps a busy original thread queued without delivery or resubmission and retries after ownership becomes available', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture();
    f.codex.transport = 'managed';
    f.codex.subscribe.mockRejectedValueOnce(new CodexThreadBusyError(THREAD));
    const request = await acceptRequest(f, 'telegram');
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'queued', origin: request.origin });
    expect(f.store.getRequest(request.id)?.error).toMatch(/занят|ожида/iu);
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    expect(f.store.listDeliveries()).toEqual([]);
    await f.engine.pump();
    expect(f.codex.subscribe).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 5_001);
    await f.engine.pump();
    expect(f.codex.enqueue).toHaveBeenCalledExactlyOnceWith(THREAD, request.text, request.id);
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'starting', error: undefined });
  });

  it('retains a waiting request and its original ID across a Rele restart', async () => {
    const f = fixture();
    f.codex.subscribe.mockRejectedValueOnce(new CodexThreadBusyError(THREAD));
    const request = await acceptRequest(f);
    await f.engine.stop();
    const restarted = fixture({ path: f.path });
    await restarted.engine.pump();
    expect(restarted.codex.enqueue).toHaveBeenCalledExactlyOnceWith(THREAD, request.text, request.id);
    expect(restarted.store.listRequests()).toHaveLength(1);
    expect(restarted.store.getRequest(request.id)?.origin).toEqual(request.origin);
  });

  it('waits for thread release before dispatching the next origin', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture();
    f.codex.transport = 'managed';
    const closed = deferred<void>();
    const first = await acceptRequest(f, 'slack');
    await running(f, first);
    const releasedBeforeCompletion = f.codex.releaseThread.mock.calls.length;
    f.codex.releaseThread.mockImplementationOnce(() => closed.promise);
    f.codex.complete(first.id, 'First result');
    await vi.waitFor(() => expect(f.codex.releaseThread).toHaveBeenCalledTimes(releasedBeforeCompletion + 1));
    expect(f.codex.releaseThread.mock.calls.at(-1)).toEqual([THREAD]);
    await f.engine.receive(f.message('telegram'));
    await f.engine.pump();
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    closed.resolve();
    await f.engine.settled();
    vi.setSystemTime(Date.now() + 2000);
    await f.engine.pump();
    expect(f.codex.enqueue).toHaveBeenCalledTimes(2);
    expect(f.codex.enqueue.mock.calls[1][0]).toBe(THREAD);
    expect(f.slack.deliver).toHaveBeenCalledTimes(1);
    expect(f.telegram.deliver).not.toHaveBeenCalled();
  });

  it('does not release a thread while an accepted request still needs reconciliation', async () => {
    const f = fixture();
    f.codex.enqueue.mockRejectedValueOnce(new CodexTransportError('Lost acknowledgement'));
    const request = await acceptRequest(f);
    const enqueueOrder = f.codex.enqueue.mock.invocationCallOrder[0];
    expect(enqueueOrder).toBeDefined();
    expect(f.codex.releaseThread.mock.invocationCallOrder.every(order => order < enqueueOrder)).toBe(true);
    const priorPassiveReleases = f.codex.releaseThread.mock.calls.length;
    await f.engine.reconcile(request.id);
    expect(f.store.getRequest(request.id)?.status).toBe('uncertain');
    expect(f.codex.releaseThread).toHaveBeenCalledTimes(priorPassiveReleases);
  });

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
    expect(f.codex.releaseThread).not.toHaveBeenCalled();
    acknowledgement.resolve({ queuedSubmissionId: 'early-queue' });
    await f.engine.settled();
    await f.engine.pump();
    expect(f.store.listRequests()[0]).toMatchObject({ status: 'completed', queuedSubmissionId: 'early-queue' });
    expect(f.telegram.deliver).toHaveBeenCalledTimes(1);
    expect(f.slack.deliver).not.toHaveBeenCalled();
    expect(f.codex.releaseThread).toHaveBeenCalledExactlyOnceWith(THREAD);
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
  it.each(['lookup-error', 'mixed', 'wrong-turn', 'already-terminal'] as const)('rejects a managed approval when origin verification is %s', async reason => {
    const f = fixture();
    f.codex.transport = 'managed';
    const request = await acceptRequest(f);
    await running(f, request);
    f.codex.findRequest.mockImplementationOnce(async () => {
      if (reason === 'lookup-error') throw new Error('Cannot read origin');
      if (reason === 'already-terminal') f.store.finishRequest(request.id, { status: 'cancelled' }, []);
      return { state: 'running', turnId: reason === 'wrong-turn' ? 'other-turn' : 'turn-1', mixed: reason === 'mixed' };
    });
    f.codex.request({ id: 'unverified-approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: THREAD, turnId: 'turn-1', itemId: 'approval-item', command: 'unverified command',
    } });
    await f.engine.settled();
    expect(f.codex.rejectRequest).toHaveBeenCalledExactlyOnceWith('unverified-approval', expect.stringContaining('cannot authorize'));
    expect(f.codex.respond).not.toHaveBeenCalled();
    expect(f.store.listApprovals()).toEqual([]);
    expect(f.store.listDeliveries()).toEqual([]);
  });

  it('rejects unsupported interactions in its own server without asking the user to answer them in Desktop', async () => {
    const f = fixture();
    f.codex.transport = 'managed';
    const request = await acceptRequest(f);
    await running(f, request);
    f.codex.request({ id: 'unsupported-tool', method: 'item/tool/call', params: {
      threadId: THREAD, turnId: 'turn-1', callId: 'external-tool', tool: 'desktop-only-tool', arguments: {},
    } });
    await f.engine.settled();
    expect(f.codex.rejectRequest).toHaveBeenCalledWith('unsupported-tool', expect.stringContaining('not supported'));
    expect(f.store.getRequest(request.id)?.error).toContain('Действие отклонено');
    expect(f.store.listApprovals()).toEqual([]);
    expect(f.store.listDeliveries()).toEqual([]);
  });

  it('does not authorize an unowned request in its own server', async () => {
    const f = fixture();
    f.codex.transport = 'managed';
    f.codex.request({ id: 'unowned-approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: THREAD, turnId: 'unowned-turn', command: 'not authorized by an inbound Rele message',
    } });
    await f.engine.settled();
    expect(f.codex.rejectRequest).toHaveBeenCalledExactlyOnceWith('unowned-approval', expect.stringContaining('cannot authorize'));
    expect(f.codex.respond).not.toHaveBeenCalled();
    expect(f.store.listRequests()).toEqual([]);
    expect(f.store.listDeliveries()).toEqual([]);
  });

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

  it.each(['slack', 'telegram'] as const)('cancels only the originating sender task from %s, with a durable control receipt', async platform => {
    const f = fixture();
    const request = await acceptRequest(f, platform);
    await requestApproval(f, request, true);
    const wrong = f.message(platform, 'wrong-cancel', { text: 'rele:cancel', sender: { id: 'other', name: 'Other' } });
    await f.engine.receive(wrong);
    expect(f.codex.interrupt).not.toHaveBeenCalled();
    const control = f.message(platform, 'cancel-control', { text: platform === 'telegram' ? '/rele_cancel' : 'rele:cancel' });
    f.codex.interrupt.mockImplementationOnce(async () => { expect(f.store.recordInbound(control).duplicate).toBe(true); });
    await f.engine.receive(control);
    await f.engine.receive(control);
    await f.engine.settled();
    expect(f.codex.interrupt).toHaveBeenCalledExactlyOnceWith(THREAD, 'turn-1');
    expect(f.codex.respond).not.toHaveBeenCalled();
    expect(f.store.listRequests()).toHaveLength(1);
    expect(f.store.listDeliveries().find(row => row.key === 'control:cancel-control')?.origin).toEqual(request.origin);
  });

  it('uses native Slack Stop to interrupt the exact origin once, retaining the receipt across restart', async () => {
    const f = fixture(); const request = await acceptRequest(f); await running(f, request);
    const control = f.message('slack', 'agent-session-stopped:Ev1', { control: 'stop', text: '', messageId: `${Math.floor(Date.now() / 1000) + 1}.000001` });
    for (const patch of [{ endpoint: { ...control.endpoint, id: 'other-account', accountId: 'other' } }, { endpoint: { ...control.endpoint, id: 'other-chat', chatId: 'other' } }, { endpoint: { ...control.endpoint, id: 'other-thread', threadId: 'other' } }, { sender: { id: 'other', name: 'Other' } }]) {
      await f.engine.receive({ ...control, ...patch, eventId: `wrong-${JSON.stringify(patch)}` });
    }
    expect(f.codex.interrupt).not.toHaveBeenCalled();
    f.codex.interrupt.mockImplementationOnce(async () => { expect(f.store.recordInbound(control).duplicate).toBe(true); });
    await f.engine.receive(control); await f.engine.receive(control); await f.engine.settled();
    expect(f.codex.interrupt).toHaveBeenCalledExactlyOnceWith(THREAD, 'turn-1');
    expect(f.store.listRequests()).toHaveLength(1);
    expect(f.store.listDeliveries().find(row => row.key === `control:${control.eventId}`)?.origin).toEqual(request.origin);
    await f.engine.stop(); f.store.close();
    const restarted = fixture({ path: f.path, start: false });
    await restarted.engine.receive(control);
    expect(restarted.codex.interrupt).not.toHaveBeenCalled();
    expect(restarted.store.listRequests()).toHaveLength(1);
  });

  it('does not let a delayed native Stop cancel a later message or a merely queued request', async () => {
    const f = fixture();
    const request = await acceptRequest(f, 'slack', 'later');
    const control = f.message('slack', 'agent-session-stopped:old', { control: 'stop', text: '', messageId: '1.000001' });
    await running(f, request); await f.engine.receive(control);
    expect(f.codex.interrupt).not.toHaveBeenCalled();
    expect(f.store.getRequest(request.id)?.status).toBe('running');
    const idle = fixture(); idle.codex.connected = false;
    const queued = await acceptRequest(idle, 'slack', 'queued');
    await idle.engine.receive(idle.message('slack', 'agent-session-stopped:queued', { control: 'stop', text: '', messageId: '999999.999999' }));
    expect(idle.store.getRequest(queued.id)?.status).toBe('queued');
    expect(idle.codex.deleteQueued).not.toHaveBeenCalled();
    expect(idle.codex.enqueue).not.toHaveBeenCalled();
  });

  it('does not redirect a delayed Stop to a request that was queued before the click', async () => {
    const f = fixture(); const first = await acceptRequest(f); await running(f, first);
    const next = await acceptRequest(f, 'slack', 'already-queued');
    expect(f.store.getRequest(next.id)?.status).toBe('queued');
    const clickMs = Date.now() + 100;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(clickMs + 1000);
    try {
      f.codex.complete(first.id, 'First response'); await f.engine.settled();
      await f.engine.pump(); await f.engine.settled();
      await running(f, next, 'next-turn');
      expect(Number(f.store.getMeta(`request-started:${next.id}`))).toBeGreaterThan(clickMs);
      await f.engine.receive(f.message('slack', 'agent-session-stopped:delayed', { control: 'stop', text: '', messageId: String(clickMs / 1000) }));
      await f.engine.settled();
      expect(f.codex.interrupt).not.toHaveBeenCalled();
      expect(f.store.getRequest(next.id)?.status).toBe('running');
    } finally { clock.mockRestore(); }
  });

  it('returns native Stop after its durable receipt while the exact-target cancellation RPC is pending', async () => {
    const f = fixture(); const request = await acceptRequest(f); await running(f, request);
    const native = deferred<RequestLocation>();
    f.codex.findRequest.mockImplementationOnce(() => native.promise);
    const control = f.message('slack', 'agent-session-stopped:slow-rpc', { control: 'stop', text: '', messageId: `${Math.floor(Date.now() / 1000) + 1}.000001` });
    await f.engine.receive(control);
    expect(f.store.recordInbound(control).duplicate).toBe(true);
    expect(f.codex.interrupt).not.toHaveBeenCalled();
    native.resolve({ state: 'running', turnId: 'turn-1' });
    await f.engine.settled();
    expect(f.codex.interrupt).toHaveBeenCalledExactlyOnceWith(THREAD, 'turn-1');
  });

  it('keeps native Stop out of Codex when another client has mixed the turn', async () => {
    const f = fixture(); const request = await acceptRequest(f); await running(f, request);
    f.store.setMeta(`mixed:${request.id}`, '1');
    await f.engine.receive(f.message('slack', 'agent-session-stopped:mixed', { control: 'stop', text: '', messageId: `${Math.floor(Date.now() / 1000) + 1}.000001` }));
    await f.engine.settled();
    expect(f.codex.interrupt).not.toHaveBeenCalled();
    expect(f.codex.deleteQueued).not.toHaveBeenCalled();
    expect(f.store.listRequests()).toHaveLength(1);
    expect(f.store.listDeliveries()[0].body).toContain('смешанного хода');
  });

  it.each([true, false])('refuses to interrupt mixed turns, including a persisted mixed flag=%s', async persisted => {
    const f = fixture(); const request = await acceptRequest(f, 'telegram'); await running(f, request);
    if (persisted) f.store.setMeta(`mixed:${request.id}`, '1');
    else f.codex.locations.set(request.id, { state: 'running', turnId: 'turn-1', mixed: true });
    await expect(f.engine.cancel(request.id)).rejects.toThrow('смешанного хода');
    expect(f.codex.interrupt).not.toHaveBeenCalled();
    expect(f.codex.deleteQueued).not.toHaveBeenCalled();
  });

  it('cancels a local queued request from its origin without starting Codex', async () => {
    const f = fixture(); f.codex.connected = false;
    const request = await acceptRequest(f, 'telegram');
    await f.engine.receive(f.message('telegram', 'cancel-queued', { text: '/rele_cancel' })); await f.engine.settled();
    expect(f.store.getRequest(request.id)?.status).toBe('cancelled');
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    expect(f.codex.interrupt).not.toHaveBeenCalled();
    expect(f.store.listDeliveries()[0].body).toBe('Запрос отменён в Rele.');
  });

  it.each(['slack', 'telegram'] as const)('answers several questions from %s and keeps invalid replies out of the Codex task queue', async platform => {
    const f = fixture(); const request = await acceptRequest(f, platform); await running(f, request);
    f.codex.request({ id: 'many-questions', method: 'item/tool/requestUserInput', params: {
      threadId: THREAD, turnId: 'turn-1', itemId: 'questions', questions: [
        { id: 'branch', header: 'Branch', question: 'Which branch?' }, { id: 'mode', header: 'Mode', question: 'Which mode?' },
      ],
    } });
    await f.engine.settled();
    const approval = f.store.listApprovals()[0];
    const prompt = f.store.listDeliveries().find(row => row.approvalId === approval.id)!;
    expect(prompt.body).toContain('1. Branch');
    const invalid = f.message(platform, 'invalid-many-answer', { text: 'main', replyToMessageId: prompt.remoteMessageId });
    await f.engine.receive(invalid); await f.engine.settled();
    expect(f.store.getApproval(approval.id)?.status).toBe('pending');
    expect(f.codex.respond).not.toHaveBeenCalled();
    const reply = f.message(platform, 'valid-many-answer', { text: '1. main\n2. read-only', replyToMessageId: prompt.remoteMessageId });
    await f.engine.receive(reply); await f.engine.receive(reply); await f.engine.settled();
    expect(f.codex.respond).toHaveBeenCalledExactlyOnceWith('many-questions', { answers: { branch: { answers: ['main'] }, mode: { answers: ['read-only'] } } });
    expect(f.store.listRequests()).toHaveLength(1);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each(['slack', 'telegram'] as const)('delivers every long question part before accepting an answer from %s', async platform => {
    const f = fixture(); const request = await acceptRequest(f, platform); await running(f, request);
    const channel = platform === 'slack' ? f.slack : f.telegram;
    let failed = false;
    channel.deliver.mockImplementation(async delivery => {
      if (delivery.ordinal === 1 && !failed) { failed = true; throw new ChannelError('Retry this part', true, false, 60_000); }
      return `${platform}-part-${delivery.ordinal}`;
    });
    const questions = [1, 2, 3].map(index => ({ id: `q${index}`, header: `Question ${index}`,
      question: `${'Длинный вопрос '.repeat(450)}FULL_QUESTION_${index}_CANARY`,
      options: [{ label: `Choice ${index}`, description: `LAST_OPTION_${index}_CANARY` }] }));
    f.codex.request({ id: 'long-questions', method: 'item/tool/requestUserInput', params: {
      threadId: THREAD, turnId: 'turn-1', itemId: 'long-questions', questions,
    } });
    await f.engine.settled();
    const approval = f.store.listApprovals()[0];
    let parts = f.store.listDeliveries(2000).filter(delivery => delivery.approvalId === approval.id).sort((a, b) => a.ordinal - b.ordinal);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toMatchObject({ key: `approval:${approval.id}`, status: 'sent' });
    expect(parts[1].status).toBe('pending');
    const early = f.message(platform, 'early-long-answer', { text: '1. first\n2. second\n3. third', replyToMessageId: parts[0].remoteMessageId });
    await f.engine.receive(early); await f.engine.settled();
    expect(f.codex.respond).not.toHaveBeenCalled();
    expect(f.store.listRequests()).toHaveLength(1);
    expect(f.store.recordInbound(early).duplicate).toBe(true);
    f.store.updateDelivery(parts[1].id, { nextAttemptAt: undefined });
    await f.engine.pump(); await f.engine.settled();
    parts = f.store.listDeliveries(2000).filter(delivery => delivery.approvalId === approval.id).sort((a, b) => a.ordinal - b.ordinal);
    expect(parts.every(delivery => delivery.status === 'sent' && [...delivery.body].length <= 3000)).toBe(true);
    expect(parts.map(delivery => delivery.ordinal)).toEqual(parts.map((_delivery, index) => index));
    expect(new Set(parts.map(delivery => delivery.key)).size).toBe(parts.length);
    expect(channel.deliver.mock.calls.map(([delivery]) => delivery.ordinal)).toEqual([0, 1, ...parts.slice(1).map(delivery => delivery.ordinal)]);
    const delivered = parts.map(delivery => delivery.body).join('');
    for (const question of questions) expect(delivered).toContain(question.question);
    expect(delivered).toContain('LAST_OPTION_3_CANARY');
    expect(approval.details.length).toBeGreaterThan(16_000);
    expect(approval.details).toContain('LAST_OPTION_3_CANARY');
    await f.engine.receive(early); // The old early receipt cannot turn into a later answer or a task.
    expect(f.codex.respond).not.toHaveBeenCalled();
    await f.engine.receive(f.message(platform, 'complete-long-answer', { text: early.text, replyToMessageId: parts.at(-1)!.remoteMessageId }));
    await f.engine.settled();
    expect(f.codex.respond).toHaveBeenCalledExactlyOnceWith('long-questions', { answers: { q1: { answers: ['first'] }, q2: { answers: ['second'] }, q3: { answers: ['third'] } } });
    expect(f.store.listRequests()).toHaveLength(1);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
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

  it.each(['expired', 'answered'] as const)('records a late reply to an %s Telegram approval without starting another task', async status => {
    const f = fixture();
    const request = await acceptRequest(f, 'telegram');
    const approval = await requestApproval(f, request, true);
    const prompt = f.store.listDeliveries().find(row => row.approvalId === approval.id)!;
    f.store.updateApproval(approval.id, { status });
    f.store.finishRequest(request.id, { status: 'completed' }, []);
    const reply = f.message('telegram', 'late-answer', { text: 'main', replyToMessageId: prompt.remoteMessageId });
    await f.engine.receive(reply);
    await f.engine.receive(reply);
    await f.engine.settled();
    expect(f.store.recordInbound(reply)).toEqual({ duplicate: true });
    expect(f.store.listRequests()).toHaveLength(1);
    expect(f.store.getApproval(approval.id)?.status).toBe(status);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    expect(f.codex.respond).not.toHaveBeenCalled();
    expect(f.store.listDeliveries()).toHaveLength(1);
  });

  it('cancels a rejected approval delivery resolved in Desktop so the final answer can be delivered', async () => {
    const f = fixture();
    const request = await acceptRequest(f);
    f.slack.deliver.mockRejectedValueOnce(new ChannelError('Confirmed rejection'));
    const approval = await requestApproval(f, request);
    const prompt = f.store.listDeliveries().find(row => row.approvalId === approval.id)!;
    expect(prompt.status).toBe('failed');
    f.codex.notification({ method: 'serverRequest/resolved', params: { threadId: THREAD, requestId: approval.rpcId } });
    await f.engine.settled();
    expect(f.store.getDelivery(prompt.id)?.status).toBe('cancelled');
    expect(f.store.getApproval(approval.id)?.status).toBe('answered');
    f.codex.complete(request.id, 'Final answer after Desktop confirmation');
    await f.engine.settled();
    await f.engine.pump();
    expect(f.slack.deliver).toHaveBeenCalledTimes(2);
    expect(f.slack.deliver.mock.calls[1][0]).toMatchObject({ kind: 'answer', body: 'Final answer after Desktop confirmation' });
    expect(f.codex.respond).not.toHaveBeenCalled();
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


function slackInbound(f: ReturnType<typeof fixture>, eventId: string, messageId: string, text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  const value = f.message('slack', eventId, { messageId, text, ...overrides });
  return { ...value, slack: { endpointId: value.endpoint.id, accountId: value.endpoint.accountId, chatId: value.endpoint.chatId,
    threadId: value.endpoint.threadId, messageId, text, sender: value.sender, kind: 'message', payload: { text, ts: messageId } } };
}

describe('Engine Slack transcript and authorized task boundary', () => {
  it('replaces a stale writer error while a fresh Slack history scan is still paginating', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture();
    const busy = new CodexThreadBusyError(THREAD);
    f.codex.injectContext.mockRejectedValueOnce(busy);
    const request = await acceptRequest(f);
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'queued', error: busy.message });
    f.slack.readThreadPage.mockResolvedValueOnce({ messages: [], nextCursor: 'next-history-page' });
    vi.setSystemTime(Date.now() + 5001);
    await f.engine.pump(); await f.engine.settled();
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'queued', error: expect.stringContaining('синхронизация полного контекста Slack') });
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1501);
    await f.engine.pump(); await f.engine.settled();
    expect(f.codex.enqueue).toHaveBeenCalledExactlyOnceWith(THREAD, request.text, request.id);
    expect(f.store.getRequest(request.id)?.error).toBeUndefined();
  });

  it('does not attach a late sync error to a request cancelled during context injection', async () => {
    const f = fixture();
    const append = deferred<void>();
    f.codex.injectContext.mockImplementationOnce(() => append.promise);
    await f.engine.receive(slackInbound(f, 'cancel-sync', '170002.000001', 'Cancel while context waits'));
    await vi.waitFor(() => expect(f.codex.injectContext).toHaveBeenCalledOnce());
    const request = f.store.listRequests()[0];
    await f.engine.cancel(request.id);
    append.reject(new CodexThreadBusyError(THREAD));
    await f.engine.settled();
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'cancelled', error: undefined });
    expect(f.codex.enqueue).not.toHaveBeenCalled();
  });

  it('projects every history page and the triggering source before enqueueing the authorized task', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture();
    const root = slackInbound(f, 'root', '170000.123', 'Original Slack root').slack!;
    const other = slackInbound(f, 'other-agent', '170002.000001', 'Other agent context', { sender: { id: 'UOTHER', name: 'Other agent', isBot: true }, contextOnly: true }).slack!;
    f.slack.readThreadPage.mockResolvedValueOnce({ messages: [root], nextCursor: 'history-page-2' }).mockResolvedValueOnce({ messages: [other] });
    const task = slackInbound(f, 'human-task', '170003.000001', 'Authorized task after conversation');
    await f.engine.receive(task); await f.engine.settled();
    expect(f.codex.injectContext).not.toHaveBeenCalled();
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1501);
    await f.engine.pump(); await f.engine.settled();
    expect(f.codex.injectContext).toHaveBeenCalledTimes(3);
    const request = f.store.listRequests()[0];
    expect(f.codex.enqueue).toHaveBeenCalledExactlyOnceWith(THREAD, task.text, request.id);
    expect(f.codex.injectContext.mock.invocationCallOrder.every(order => order < f.codex.enqueue.mock.invocationCallOrder[0])).toBe(true);
    const context = f.codex.injectContext.mock.calls.map(([, , text]) => text).join('\n');
    expect(context).toContain('Original Slack root');
    expect(context).toContain('Other agent context');
    expect(context).toContain('Authorized task after conversation');
    expect(f.store.listRequests()).toHaveLength(1);
  });

  it('projects passive idle messages from other agents without a task, request approval or model queue call', async () => {
    const f = fixture();
    const passive = slackInbound(f, 'passive-idle', '170002.000001', 'Agent report without a request', { sender: { id: 'UOTHER', name: 'Other agent', isBot: true }, contextOnly: true });
    await f.engine.receive(passive); await f.engine.settled();
    expect(f.codex.injectContext).toHaveBeenCalledOnce();
    expect(f.codex.injectContext.mock.calls[0][2]).toContain('Agent report without a request');
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    expect(f.codex.respond).not.toHaveBeenCalled();
    expect(f.store.listRequests()).toEqual([]);
    const [stream] = f.store.listSlackSyncStreams();
    expect(f.store.listSlackSyncEntries(stream.id)[0].state).toBe('applied');
  });

  it('buffers passive input during a running task and drains it after completion', async () => {
    const f = fixture(); const request = await acceptRequest(f); await running(f, request);
    const existingContext = f.codex.injectContext.mock.calls.length;
    const passive = slackInbound(f, 'passive-running', '170002.000001', 'New context during execution', { contextOnly: true });
    await f.engine.receive(passive); await f.engine.settled();
    expect(f.codex.injectContext).toHaveBeenCalledTimes(existingContext);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    const [stream] = f.store.listSlackSyncStreams();
    expect(f.store.listSlackSyncEntries(stream.id).find(entry => entry.messageId === passive.messageId)?.state).toBe('pending');
    f.codex.complete(request.id, 'Finished original task');
    await f.engine.settled(); await f.engine.pump(); await f.engine.settled();
    expect(f.codex.injectContext).toHaveBeenCalledTimes(existingContext + 1);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    expect(f.store.listSlackSyncEntries(stream.id).find(entry => entry.messageId === passive.messageId)?.state).toBe('applied');
  });

  it('never lets a context-only message from the original sender resolve an active clarification', async () => {
    const f = fixture(); const request = await acceptRequest(f);
    const approval = await requestApproval(f, request, true);
    const passive = slackInbound(f, 'passive-answer', '170002.000001', 'This is quoted context, not an answer', { contextOnly: true });
    await f.engine.receive(passive); await f.engine.settled();
    expect(f.codex.respond).not.toHaveBeenCalled();
    expect(f.store.getApproval(approval.id)?.status).toBe('pending');
    expect(f.store.listRequests()).toHaveLength(1);
    const [stream] = f.store.listSlackSyncStreams();
    expect(f.store.listSlackSyncEntries(stream.id).find(entry => entry.messageId === passive.messageId)?.state).toBe('pending');
  });

  it.each(['websocket', 'proxy'] as const)('buffers source context until shared %s runtime confirms persistence', async transport => {
    const f = fixture(); f.codex.transport = transport;
    f.codex.injectContext.mockRejectedValueOnce(new Error('Receipt not confirmed'));
    await f.engine.receive(slackInbound(f, 'shared-runtime', '170002.000001', 'Task needs complete source context'));
    await f.engine.settled();
    expect(f.codex.injectContext).toHaveBeenCalledTimes(1);
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    expect(f.codex.subscribe).not.toHaveBeenCalled();
    expect(f.slack.deliver).not.toHaveBeenCalled();
    expect(f.store.listRequests()[0]).toMatchObject({ status: 'queued' });
    const [stream] = f.store.listSlackSyncStreams();
    expect(stream.error).toContain('Receipt not confirmed');
    expect(f.store.listSlackSyncEntries(stream.id)[0].state).toBe('uncertain');
  });

  it('replays an uncertain passive append with the same marker before attempting the task only once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture();
    f.codex.injectContext.mockRejectedValueOnce(new CodexTransportError('Lost passive append acknowledgement'));
    const task = slackInbound(f, 'passive-ack', '170002.000001', 'Authorized task waits for passive source');
    await f.engine.receive(task); await f.engine.settled();
    const [stream] = f.store.listSlackSyncStreams();
    expect(f.store.listSlackSyncEntries(stream.id)[0].state).toBe('uncertain');
    expect(f.store.listRequests()[0].status).toBe('queued');
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    expect(f.codex.findRequest).not.toHaveBeenCalled();
    const originalAppend = f.codex.injectContext.mock.calls[0];
    vi.setSystemTime(Date.now() + 5001);
    await f.engine.pump(); await f.engine.settled();
    expect(f.codex.injectContext.mock.calls[1]).toEqual(originalAppend);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    expect(f.store.listRequests()).toHaveLength(1);
  });

  it('does not enqueue a later request using the cancelled earlier request context cutoff', async () => {
    const f = fixture();
    const appended = deferred<void>();
    f.codex.injectContext.mockImplementationOnce(() => appended.promise);
    const firstMessage = slackInbound(f, 'cancelled-barrier', '170002.000001', 'Earlier request to cancel');
    await f.engine.receive(firstMessage);
    await vi.waitFor(() => expect(f.codex.injectContext).toHaveBeenCalledOnce());
    const first = f.store.listRequests()[0];
    const secondMessage = slackInbound(f, 'later-barrier', '170003.000001', 'Later request requires its own context');
    await f.engine.receive(secondMessage);
    await f.engine.cancel(first.id);
    appended.resolve(); await f.engine.settled();
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    const second = f.store.listRequests().find(request => request.id !== first.id)!;
    expect(f.store.getRequest(first.id)?.status).toBe('cancelled');
    expect(f.store.getRequest(second.id)?.status).toBe('queued');
    await f.engine.pump(); await f.engine.settled();
    expect(f.codex.injectContext.mock.calls.at(-1)?.[2]).toContain(secondMessage.text);
    expect(f.codex.enqueue).toHaveBeenCalledExactlyOnceWith(THREAD, secondMessage.text, second.id);
    expect(f.codex.injectContext.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.codex.enqueue.mock.invocationCallOrder[0]);
  });
});


describe('automatic native thread creation', () => {
  function autoFixture() {
    const f = fixture();
    const endpoint = { ...f.eps.telegram, id: 'unbound-topic', threadId: '99' };
    f.store.upsertEndpoint(endpoint);
    f.config.telegram.enabled = true;
    f.config.autoLinkRules = [{ id: 'rule', enabled: true, platform: 'telegram', accountId: endpoint.accountId,
      chatId: endpoint.chatId, cwd: '/projects/new', allowedSenderIds: ['123'], requireMention: false }];
    return { ...f, endpoint, incoming: (eventId = 'auto-1', overrides: Partial<InboundMessage> = {}) =>
      f.message('telegram', eventId, { endpoint, ...overrides }) };
  }

  it('durably groups concurrent first messages, creates once, and keeps origin delivery', async () => {
    const f = autoFixture(); const gate = deferred<string>();
    f.codex.createThread.mockReturnValue(gate.promise);
    await f.engine.receive(f.incoming());
    await f.engine.receive(f.incoming('auto-2'));
    expect(f.store.listAutoLinkIntents()).toHaveLength(1);
    expect(f.store.listAutoLinkIntents()[0].status).toBe('creating');
    gate.resolve('new-native'); await f.engine.settled(); await f.engine.pump();
    expect(f.codex.createThread).toHaveBeenCalledExactlyOnceWith('/projects/new');
    const conversation = f.store.listConversations().find(row => row.threadId === 'new-native')!;
    const requests = f.store.listRequests().filter(row => row.conversationId === conversation.id);
    expect(requests).toHaveLength(2);
    expect(requests.every(row => row.origin.endpointId === f.endpoint.id && row.origin.threadId === '99')).toBe(true);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    expect(f.store.listAutoLinkIntents()[0]).toMatchObject({ status: 'completed', threadId: 'new-native' });
    await f.engine.receive(f.incoming()); await f.engine.settled();
    expect(f.codex.createThread).toHaveBeenCalledOnce();
    expect(f.store.listRequests()).toHaveLength(2);
  });

  it('waits for a supported connected runtime before making a durable creation attempt', async () => {
    const f = autoFixture(); f.codex.verifiedVersion = false;
    await f.engine.receive(f.incoming()); await f.engine.settled();
    expect(f.codex.createThread).not.toHaveBeenCalled();
    expect(f.store.listAutoLinkIntents()[0].status).toBe('pending');
    f.codex.verifiedVersion = true; await f.engine.pump();
    expect(f.codex.createThread).toHaveBeenCalledOnce();
  });

  it('does not create on denied, context-only, control, unmentioned or administrative messages', async () => {
    const f = autoFixture(); f.config.autoLinkRules![0].requireMention = true;
    for (const [index, patch] of [ { sender: { id: 'denied', name: 'Denied' }, directMention: true },
      { contextOnly: true, directMention: true }, { text: '/start', directMention: true },
      { text: '/rele_chats', directMention: true }, { text: '/rele_cancel' }, { directMention: false } ].entries()) {
      await f.engine.receive(f.incoming(`denied-${index}`, patch));
    }
    await f.engine.settled();
    expect(f.codex.createThread).not.toHaveBeenCalled();
    expect(f.store.listAutoLinkIntents()).toEqual([]);
    await f.engine.receive(f.incoming('accepted', { directMention: true })); await f.engine.settled();
    expect(f.codex.createThread).toHaveBeenCalledOnce();
  });

  it('accepts an allowlisted human DM without a mention and denies bot DMs', async () => {
    const f = autoFixture();
    f.endpoint.chatId = '123'; f.endpoint.threadId = ''; f.store.upsertEndpoint({ ...f.endpoint, id: 'dm-human' });
    f.config.autoLinkRules![0] = { ...f.config.autoLinkRules![0], chatId: '123', requireMention: true };
    const endpoint = { ...f.endpoint, id: 'dm-human' };
    await f.engine.receive(f.incoming('bot-dm', { endpoint, sender: { id: '123', name: 'Bot', isBot: true }, directMention: true }));
    await f.engine.settled(); expect(f.codex.createThread).not.toHaveBeenCalled();
    // A bot identity cannot become a human merely by omitting its flag later.
    const fresh = autoFixture(); fresh.config.autoLinkRules![0] = { ...fresh.config.autoLinkRules![0], chatId: '123', requireMention: true };
    await fresh.engine.receive(fresh.incoming('human-dm', { endpoint: { ...fresh.endpoint, id: 'dm-fresh', chatId: '123', threadId: '' } }));
    await fresh.engine.settled(); expect(fresh.codex.createThread).toHaveBeenCalledOnce();
  });

  it('never repeats thread/start after an unknown ACK, including after restart', async () => {
    const f = autoFixture(); f.codex.createThread.mockRejectedValue(new CodexTransportError('Lost create ACK'));
    await f.engine.receive(f.incoming()); await f.engine.settled();
    expect(f.store.listAutoLinkIntents()[0].status).toBe('uncertain');
    f.codex.connected = false; await f.engine.pump();
    expect(f.store.listAutoLinkIntents()[0].error).toBe('Lost create ACK');
    expect(f.codex.createThread).toHaveBeenCalledOnce();
    await f.engine.stop(); f.store.close(); fixtures.splice(fixtures.findIndex(row => row.engine === f.engine), 1);
    const restarted = fixture({ path: f.path }); restarted.config.autoLinkRules = f.config.autoLinkRules;
    restarted.config.telegram.enabled = true;
    await restarted.engine.pump(); expect(restarted.codex.createThread).not.toHaveBeenCalled();
    expect(restarted.store.listAutoLinkIntents()[0].status).toBe('uncertain');
  });

  it('persists a known ID without creating a binding after its rule is disabled', async () => {
    const f = autoFixture(); const gate = deferred<string>(); f.codex.createThread.mockReturnValue(gate.promise);
    await f.engine.receive(f.incoming()); f.config.autoLinkRules![0].enabled = false;
    gate.resolve('known-native'); await f.engine.settled();
    expect(f.store.listAutoLinkIntents()[0]).toMatchObject({ status: 'created', threadId: 'known-native' });
    expect(f.store.bindingForEndpoint(f.endpoint.id)).toBeUndefined();
    expect(f.codex.releaseThread).toHaveBeenCalledWith('known-native');
    f.config.autoLinkRules![0].enabled = true; await f.engine.pump();
    expect(f.store.bindingForEndpoint(f.endpoint.id)).toBeDefined();
    expect(f.codex.createThread).toHaveBeenCalledOnce();
  });

  it('retains a lazy new thread until idempotent native metadata has materialized it', async () => {
    const f = autoFixture(); f.codex.setThreadName.mockRejectedValueOnce(new CodexTransportError('Lost metadata ACK'));
    await f.engine.receive(f.incoming()); await f.engine.settled();
    expect(f.store.listAutoLinkIntents()[0]).toMatchObject({ status: 'created', threadId: 'auto-created-thread' });
    expect(f.store.bindingForEndpoint(f.endpoint.id)).toBeUndefined();
    expect(f.codex.releaseThread).not.toHaveBeenCalledWith('auto-created-thread');
    await f.engine.pump();
    expect(f.codex.createThread).toHaveBeenCalledOnce();
    expect(f.codex.setThreadName).toHaveBeenCalledTimes(2);
    expect(f.codex.setThreadName).toHaveBeenLastCalledWith('auto-created-thread', f.endpoint.title);
    expect(f.codex.releaseThread).toHaveBeenCalledWith('auto-created-thread');
    expect(f.store.bindingForEndpoint(f.endpoint.id)).toBeDefined();
  });

  it('prefers a manual binding that appeared while native creation was in flight', async () => {
    const f = autoFixture(); const gate = deferred<string>(); f.codex.createThread.mockReturnValue(gate.promise);
    await f.engine.receive(f.incoming());
    f.store.addBinding(f.conversation.id, 'telegram', f.endpoint.id, ['123']);
    gate.resolve('orphaned-created-native'); await f.engine.settled(); await f.engine.pump();
    expect(f.store.bindingForEndpoint(f.endpoint.id)?.conversationId).toBe(f.conversation.id);
    expect(f.store.listRequests()[0].conversationId).toBe(f.conversation.id);
    expect(f.store.listAutoLinkIntents()[0].error).toMatch(/Ручная/);
    expect(f.codex.releaseThread).toHaveBeenCalledWith('orphaned-created-native');
    expect(f.codex.createThread).toHaveBeenCalledOnce();
  });
});

describe('multiple origins and terminal reconciliation', () => {
  it('keeps an automatic group open to future humans and agents without creating more native threads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(); const endpoint = { ...f.eps.slack, id: 'auto-group-origin', chatId: 'CINFRA', threadId: '170000.456' };
    f.config.slack.enabled = true;
    f.config.autoLinkRules = [{ id: 'all-group', enabled: true, platform: 'slack', accountId: endpoint.accountId,
      chatId: endpoint.chatId, cwd: '/project/group', allowedSenderIds: [], allowAllSenders: true, requireMention: false }];
    await f.engine.receive(slackInbound(f, 'first-agent', '170001.000001', 'agent task', { endpoint, sender: { id: 'UAGENT', name: 'Agent', isBot: true } }));
    await f.engine.settled();
    await f.engine.receive(slackInbound(f, 'future-human', '170001.000002', 'new member task', { endpoint, sender: { id: 'UFUTURE', name: 'New member' } }));
    await f.engine.settled();
    const binding = f.store.bindingForEndpoint(endpoint.id)!;
    expect(binding).toMatchObject({ allowAllSenders: true, requireMention: false, allowedSenderIds: [] });
    expect(f.store.listRequests().filter(row => row.conversationId === binding.conversationId)).toHaveLength(2);
    expect(f.codex.createThread).toHaveBeenCalledOnce();
    f.store.updateBinding(binding.conversationId, binding.id, endpoint.id, [], { requireMention: true });
    await f.engine.receive(slackInbound(f, 'unmentioned-later', '170001.000003', 'no call', { endpoint, sender: { id: 'UOTHER', name: 'Other' } }));
    await f.engine.receive(slackInbound(f, 'mentioned-later', '170001.000004', 'explicit call', { endpoint, directMention: true, sender: { id: 'UOTHER', name: 'Other' } }));
    await f.engine.settled();
    expect(f.store.listRequests().filter(row => row.conversationId === binding.conversationId)).toHaveLength(3);
  });

  it('serializes four origins on one native thread and delivers each answer only to its origin', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture();
    const extra = Object.values(f.eps).map(endpoint => ({ ...endpoint, id: `${endpoint.id}-2`, threadId: `${endpoint.threadId}2` }));
    for (const endpoint of extra) { f.store.upsertEndpoint(endpoint); f.store.addBinding(f.conversation.id, endpoint.platform, endpoint.id, [endpoint.people[0].id]); }
    for (const endpoint of [...Object.values(f.eps), ...extra]) {
      await f.engine.receive(f.message(endpoint.platform, endpoint.id, { endpoint }));
      await f.engine.settled();
    }
    for (let index = 0; index < 4; index++) {
      for (let scan = 0; scan < 3; scan++) { vi.setSystemTime(Date.now() + 2000); await f.engine.pump(); await f.engine.settled(); }
      const active = f.store.activeRequests().find(row => row.status !== 'queued')!;
      expect(active).toBeDefined(); expect(f.codex.enqueue).toHaveBeenCalledTimes(index + 1);
      await running(f, active, `turn-${index}`);
      f.codex.complete(active.id, `answer-${active.origin.endpointId}`, `turn-${index}`);
      await f.engine.settled(); await f.engine.pump();
    }
    const sent = [...f.slack.deliver.mock.calls, ...f.telegram.deliver.mock.calls].map(([delivery]) => delivery).filter(row => row.kind === 'answer');
    expect(sent).toHaveLength(4);
    for (const delivery of sent) expect(delivery.body).toBe(`answer-${delivery.origin.endpointId}`);
  });

  it('rechecks a completion notification received during an earlier history read', async () => {
    const f = fixture(); const request = await acceptRequest(f, 'telegram'); await running(f, request);
    const gate = deferred<RequestLocation>(); f.codex.findRequest.mockReturnValueOnce(gate.promise);
    const pendingRead = f.engine.reconcile(request.id);
    await vi.waitFor(() => expect(f.codex.findRequest).toHaveBeenCalled());
    f.codex.complete(request.id, 'OK'); await Promise.resolve(); await Promise.resolve();
    gate.reject(new Error('Interrupted snapshot has no completion timestamp'));
    await pendingRead; await f.engine.settled(); await f.engine.pump();
    expect(f.store.getRequest(request.id)?.status).toBe('completed');
    expect(f.telegram.deliver.mock.calls.map(([delivery]) => delivery.body)).toContain('OK');
    expect(f.codex.interrupt).not.toHaveBeenCalled();
  });
});
