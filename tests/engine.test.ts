import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine, type CodexGateway, type EngineOptions } from '../src/server/engine.js';
import { Store } from '../src/server/store.js';
import { INITIAL_RELE_MESSAGE, requestInput } from '../src/server/inbound-context.js';
import { initialMessageKey } from '../src/server/initial-message.js';
import { defaultConfig } from '../src/server/config.js';
import { CodexSteerRefusedError, CodexThreadBusyError, CodexTransportError, type CodexNotification, type CodexServerRequest, type RequestLocation } from '../src/server/codex.js';
import { ChannelError, type ApprovalAction, type Channel } from '../src/server/channels/common.js';
import type { Approval, CodexConnectionState, Delivery, Endpoint, InboundMessage, MessageToolReceipt, Platform, ReleRequest } from '../src/shared/types.js';

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
  pendingRequests = new Set<string | number>();
  hasPendingRequest = (id: string | number) => this.pendingRequests.has(id);
  locations = new Map<string, RequestLocation>();
  transport: CodexConnectionState['transport'] = 'managed';
  status = vi.fn(() => ({ configured: true, connected: this.connected, queueSupported: this.queueSupported, desktopVerified: false, transport: this.transport, codexHome: '/test/codex-home' }));
  createThread = vi.fn<(_cwd: string) => Promise<string>>().mockResolvedValue('auto-created-thread');
  setThreadName = vi.fn(async (_threadId: string, _name: string): Promise<void> => {});
  injectContext = vi.fn(async (_threadId: string, _entryId: string, _text: string) => {});
  subscribe = vi.fn(async (_threadId: string) => {});
  releaseThread = vi.fn(async (_threadId: string) => {});
  enqueue = vi.fn(async (_threadId: string, text: string, clientId: string) => {
    const queuedSubmissionId = `queue-${clientId}`;
    this.locations.set(clientId, text === INITIAL_RELE_MESSAGE ? { state: 'completed', turnId: `initial-${clientId}`, text: 'NOREPLY' } : { state: 'queued', queuedSubmissionId });
    return { queuedSubmissionId };
  });
  findRequest = vi.fn(async (_threadId: string, clientId: string): Promise<RequestLocation> => this.locations.get(clientId) ?? { state: 'not_found' });
  retryOverloaded = vi.fn<import('../src/server/codex.js').CodexClient['retryOverloaded']>(async (_thread, id, previous, _inputs, beforeSend) => {
    if (!beforeSend()) return;
    const turnId = `${previous}-retry`;
    this.locations.set(id, { state: 'running', turnId });
    return { turnId };
  });
  steer = vi.fn(async (threadId: string, _text: string, clientId: string, turnId: string) => {
    this.locations.set(clientId, { state: 'running', turnId });
    this.notification({ method: 'item/started', params: { threadId, turnId, item: { type: 'userMessage', clientId } } });
    return { turnId };
  });
  findSteerReceipt = vi.fn(async (_threadId: string, clientId: string, turnId: string): Promise<RequestLocation> => {
    const found = this.locations.get(clientId);
    return found?.turnId === turnId ? found : { state: 'not_found' };
  });
  respond = vi.fn(async (rpcId: string | number, _result: unknown) => { this.pendingRequests.delete(rpcId); });
  rejectRequest = vi.fn(async (_rpcId: string | number, _message: string) => {});
  interrupt = vi.fn(async (threadId: string, turnId: string) => {
    for (const [id, location] of this.locations) if (location.turnId === turnId && location.state === 'running') {
      this.locations.set(id, { ...location, state: 'interrupted' });
    }
    this.notification({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted' } } });
  });
  deleteQueued = vi.fn(async (_threadId: string, _queuedSubmissionId: string) => ({ deleted: true }));
  startQueued = vi.fn(async (_threadId: string, _queuedSubmissionId: string) => ({ turn: { id: 'resumed-turn', status: 'inProgress', items: [] } }));
  terminals: Array<{ itemId: string; processId: string }> = [];
  serverId = 42;
  backgroundTerminals = vi.fn(async (_threadId: string) => ({ serverId: this.serverId, terminals: this.terminals.map(row => ({ ...row })) }));
  terminateBackgroundTerminal = vi.fn(async (_threadId: string, target: { serverId: number; itemId: string; processId: string }) => {
    this.terminals = this.terminals.filter(row => row.itemId !== target.itemId || row.processId !== target.processId);
  });
  notification(event: CodexNotification): void {
    if (event.method === 'serverRequest/resolved') this.pendingRequests.delete((event.params as { requestId: string | number }).requestId);
    this.emit('notification', event);
  }
  request(event: CodexServerRequest): void { this.pendingRequests.add(event.id); this.emit('request', event); }
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
    updateProgress: vi.fn(async (_id: string, _origin: ReleRequest['origin'], _progress: import('../src/server/channels/common.js').RequestProgress) => {}),
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

function fixture(options: { path?: string; start?: boolean; initialized?: boolean; transcribe?: EngineOptions['transcribe'] } = {}) {
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
  if (options.initialized !== false) store.setMeta(initialMessageKey('/test/codex-home', THREAD), JSON.stringify({ applied: true }));
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
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Engine Codex maintenance', () => {
  it('keeps incoming messages durable and queued until maintenance ends, then dispatches the original request', async () => {
    const f = fixture({ start: false });
    let release!: () => void;
    const operation = vi.fn(async () => new Promise<void>(resolve => { release = resolve; }));
    const maintenance = f.engine.maintainCodex(operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    const message = f.message('slack', 'during-maintenance');
    await f.engine.receive(message);
    const [queued] = f.store.listRequests();
    expect(queued).toMatchObject({ eventId: 'during-maintenance', status: 'queued' });
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    await expect(f.engine.resume(queued.id)).rejects.toThrow('приостановлен');
    await expect(f.engine.resolveApproval('unused', 'accept')).rejects.toThrow('приостановлен');
    await expect(f.engine.receive({ ...message, eventId: 'stop-during-maintenance', control: 'stop' })).rejects.toMatchObject({ retryable: true });
    expect(f.codex.startQueued).not.toHaveBeenCalled();
    release(); await maintenance; await f.engine.settled();
    expect(f.store.listRequests()).toHaveLength(1);
    expect(f.store.listRequests()[0].id).toBe(queued.id);
    expect(f.codex.enqueue).toHaveBeenCalledOnce();
  });

  it('does not enter maintenance while work is running and restores admission after a failed operation', async () => {
    const f = fixture(), request = await acceptRequest(f);
    await running(f, request);
    const replace = vi.fn(async () => {});
    await expect(f.engine.maintainCodex(replace)).rejects.toThrow('активные запросы');
    expect(replace).not.toHaveBeenCalled();
    expect(f.codex.interrupt).not.toHaveBeenCalled();
    const idle = fixture({ start: false });
    await expect(idle.engine.maintainCodex(async () => { throw new Error('native declined'); })).rejects.toThrow('native declined');
    await idle.engine.settled();
    const next = await acceptRequest(idle, 'slack', 'after-failure');
    expect(idle.codex.enqueue.mock.calls.some(([, , id]) => id === next.id)).toBe(true);
  });
});

describe('Engine initial instruction and same-source steering', () => {
  it('does not start existing disabled chats on idle startup, but accepts an explicit initial-message action', async () => {
    const f = fixture({ initialized: false, start: false });
    for (const endpoint of Object.values(f.eps)) f.store.setSourceAccess(endpoint.id, { mode: 'off' });
    f.engine.start(); await f.engine.pump(); await f.engine.settled();
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    f.engine.sendInitialMessage(f.conversation.id); await f.engine.settled();
    expect(f.codex.enqueue).toHaveBeenCalledOnce();
    expect(f.codex.enqueue.mock.calls[0][1]).toBe(INITIAL_RELE_MESSAGE);
  });
  it('sends the initial instruction before real input once per chat, including after restart and with multiple bindings', async () => {
    const f = fixture({ initialized: false });
    const request = await acceptRequest(f);
    expect(f.codex.enqueue.mock.calls.map(call => call[1])).toEqual([INITIAL_RELE_MESSAGE, requestInput(request)]);
    expect(f.codex.injectContext.mock.invocationCallOrder[0]).toBeGreaterThan(f.codex.enqueue.mock.invocationCallOrder[0]);
    await running(f, request); f.codex.complete(request.id, 'Answer');
    await f.engine.settled(); await f.engine.pump(); await f.engine.stop();
    const second = fixture({ path: f.path, initialized: false });
    await second.engine.pump(); await second.engine.settled();
    expect(second.codex.enqueue).not.toHaveBeenCalled();
    expect(second.store.listDeliveries().some(row => row.body === 'NOREPLY')).toBe(false);
  });

  it('steers another authorized author in the same source, preserves attribution and delivers one answer only to the controlling source', async () => {
    const f = fixture(); f.store.setSourceAccess(f.eps.slack.id, { mode: 'all' });
    const root = await acceptRequest(f); await running(f, root);
    const other = await acceptRequest(f, 'telegram', 'other-source');
    expect(f.codex.steer).not.toHaveBeenCalled();
    const message = f.message('slack', 'oscar', { text: '@Theresa extra information', sender: { id: 'UAGENT', name: 'Oscar', isBot: true } });
    await f.engine.receive(message); await f.engine.settled();
    const addition = f.store.listRequests().find(row => row.eventId === 'oscar')!;
    expect(addition).toMatchObject({ status: 'completed', steeredInto: root.id, turnId: 'turn-1', origin: { senderName: 'Oscar', senderIsBot: true } });
    expect(f.codex.steer).toHaveBeenCalledExactlyOnceWith(THREAD, requestInput(addition), addition.id, 'turn-1');
    expect(f.store.getRequest(other.id)?.status).toBe('queued');
    expect(f.store.listDeliveries().filter(row => row.requestId === addition.id)).toEqual([]);
    await f.engine.receive(message); await f.engine.settled();
    expect(f.codex.steer).toHaveBeenCalledOnce();
    f.codex.complete(root.id, 'Combined answer'); await f.engine.settled(); await f.engine.pump();
    expect(f.slack.deliver.mock.calls.filter(([delivery]) => delivery.kind === 'answer')).toHaveLength(1);
    expect(f.telegram.deliver).not.toHaveBeenCalled();
    expect(f.store.getRequest(root.id)).toMatchObject({ status: 'completed', origin: { senderId: 'U1' } });
  });

  it('keeps approval and Stop authority with the original request after an agent addition', async () => {
    const f = fixture(); f.store.setSourceAccess(f.eps.slack.id, { mode: 'all' });
    const root = await acceptRequest(f); await running(f, root);
    await f.engine.receive(f.message('slack', 'agent-update', { sender: { id: 'UAGENT', name: 'Oscar', isBot: true } })); await f.engine.settled();
    const approval = await requestApproval(f, root);
    expect(approval.requestId).toBe(root.id);
    await expect(f.engine.action({ platform: 'slack', accountId: f.eps.slack.accountId, chatId: f.eps.slack.chatId,
      threadId: f.eps.slack.threadId, senderId: 'UAGENT', senderIsBot: true, approvalId: approval.id, decision: 'accept' })).rejects.toThrow();
    await f.engine.resolveApproval(approval.id, 'decline');
    await f.engine.cancel(root.id);
    expect(f.codex.interrupt).toHaveBeenCalledExactlyOnceWith(THREAD, 'turn-1');
    expect(f.store.getRequest(root.id)?.status).toBe('interrupted');
  });

  it('leaves additions queued during a pending approval and steers them once it is answered', async () => {
    const f = fixture(); const root = await acceptRequest(f); const approval = await requestApproval(f, root);
    const child = await acceptRequest(f, 'slack', 'while-approval');
    expect(f.codex.steer).not.toHaveBeenCalled();
    expect(f.store.getRequest(child.id)?.status).toBe('queued');
    await f.engine.resolveApproval(approval.id, 'accept'); await f.engine.pump(); await f.engine.settled();
    expect(f.store.getRequest(child.id)).toMatchObject({ status: 'completed', steeredInto: root.id });
    expect(f.codex.steer).toHaveBeenCalledOnce();
  });

  it('reconciles a lost steering ACK without a second send or passive append', async () => {
    const f = fixture(); const root = await acceptRequest(f); await running(f, root);
    f.codex.steer.mockImplementationOnce(async (_thread, _text, id, turnId) => {
      f.codex.locations.set(id, { state: 'running', turnId });
      throw new CodexTransportError('Lost acknowledgement');
    });
    const child = await acceptRequest(f, 'slack', 'lost-steer-ack');
    expect(f.store.getRequest(child.id)?.status).toBe('uncertain');
    const contextCount = f.codex.injectContext.mock.calls.length;
    await f.engine.pump(); await f.engine.settled();
    expect(f.store.getRequest(child.id)).toMatchObject({ status: 'completed', steeredInto: root.id });
    expect(f.codex.steer).toHaveBeenCalledOnce();
    expect(f.codex.injectContext).toHaveBeenCalledTimes(contextCount);
  });

  it('waits for the persisted steering receipt even after an ACK before delivering the combined final', async () => {
    const f = fixture(); const root = await acceptRequest(f); await running(f, root);
    f.codex.steer.mockImplementationOnce(async (_thread, _text, _id, turnId) => ({ turnId }));
    const child = await acceptRequest(f, 'slack', 'delayed-steer-receipt');
    expect(f.store.getRequest(child.id)?.status).toBe('uncertain');
    f.codex.complete(root.id, 'Combined final'); await f.engine.settled(); await f.engine.pump(); await f.engine.settled();
    expect(f.store.listDeliveries().some(row => row.kind === 'answer')).toBe(false);
    f.codex.locations.set(child.id, { state: 'completed', turnId: 'turn-1' });
    await f.engine.reconcile(child.id); await f.engine.settled(); await f.engine.pump();
    expect(f.store.getRequest(child.id)).toMatchObject({ status: 'completed', steeredInto: root.id });
    expect(f.store.getRequest(root.id)?.status).toBe('completed');
    expect(f.slack.deliver.mock.calls.filter(([delivery]) => delivery.kind === 'answer')).toHaveLength(1);
    expect(f.codex.steer).toHaveBeenCalledOnce();
  });

  it('does not retry a refused steer and starts that input as a later ordinary request', async () => {
    const f = fixture(); const root = await acceptRequest(f); await running(f, root);
    f.codex.steer.mockRejectedValueOnce(new CodexSteerRefusedError('no_active_turn'));
    const child = await acceptRequest(f, 'slack', 'refused-steer');
    expect(f.store.getRequest(child.id)?.status).toBe('queued');
    await f.engine.pump(); await f.engine.settled();
    expect(f.codex.steer).toHaveBeenCalledOnce();
    f.codex.complete(root.id, 'Done'); await f.engine.settled(); await f.engine.pump(); await f.engine.settled();
    expect(f.codex.enqueue.mock.calls.some(call => call[2] === child.id)).toBe(true);
    expect(f.store.getRequest(child.id)?.steeredInto).toBeUndefined();
  });

  it('still suppresses a mixed final when an unrelated native client writes after an own addition', async () => {
    const f = fixture(); const root = await acceptRequest(f); await running(f, root);
    await acceptRequest(f, 'slack', 'own-extra');
    f.codex.notification({ method: 'item/started', params: { threadId: THREAD, turnId: 'turn-1', item: { type: 'userMessage', clientId: 'external-client' } } });
    await f.engine.settled();
    f.codex.complete(root.id, 'Private desktop answer'); await f.engine.settled(); await f.engine.pump();
    expect(f.store.getRequest(root.id)?.status).toBe('failed');
    expect(f.store.listDeliveries().some(row => row.kind === 'answer')).toBe(false);
  });
});

describe('Engine public Slack progress', () => {
  it.each(['missing', 'unavailable'] as const)('periodically recovers a request with %s history while another thread runs, without resending', async failure => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture();
    const otherEndpoint = { ...f.eps.slack, id: 'other-slack-endpoint', threadId: '170000.456' };
    f.store.upsertEndpoint(otherEndpoint);
    f.store.createConversation({ name: 'Other', threadId: 'other-codex-thread', cwd: '/projects/other',
      bindings: [{ platform: 'slack', endpointId: otherEndpoint.id, allowedSenderIds: ['U1'] }] });
    f.store.setMeta(initialMessageKey('/test/codex-home', 'other-codex-thread'), JSON.stringify({ applied: true }));
    const first = await acceptRequest(f);
    await running(f, first);
    await f.engine.receive(f.message('slack', 'other', { endpoint: otherEndpoint }));
    await f.engine.settled();
    vi.setSystemTime(Date.now() + 1500); // Allow the second source's paced initial backfill.
    await f.engine.pump(); await f.engine.settled();
    const second = f.store.listRequests().find(row => row.eventId === 'other')!;
    expect(second).toMatchObject({ status: 'starting', error: undefined });
    expect(f.codex.enqueue).toHaveBeenCalledTimes(2);
    f.codex.locations.set(second.id, { state: 'running', turnId: 'other-turn' });
    await f.engine.reconcile(second.id);
    expect(f.store.getRequest(second.id)?.status).toBe('running');
    f.codex.notification({ method: 'item/completed', params: { threadId: THREAD, turnId: 'turn-1',
      item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'Public step' } } });
    await f.engine.settled(); await f.engine.pump();
    if (failure === 'missing') f.codex.locations.delete(first.id);
    else f.codex.findRequest.mockRejectedValueOnce(new Error('Private backend detail'));
    await f.engine.reconcile(first.id);
    expect(f.store.getRequest(first.id)?.status).toBe('uncertain');
    await f.engine.pump();
    expect(f.slack.updateProgress.mock.calls.at(-1)).toEqual([first.id, first.origin,
      { statusText: 'Проверяю состояние Codex', existingOnly: true }]);
    f.codex.locations.set(first.id, { state: 'running', turnId: 'turn-1' });
    vi.setSystemTime(Date.now() + 16_000);
    await f.engine.pump(); await f.engine.settled();
    expect(f.store.getRequest(first.id)).toMatchObject({ status: 'running', turnId: 'turn-1', error: undefined });
    expect(f.store.getRequest(second.id)).toMatchObject({ status: 'running', turnId: 'other-turn' });
    await f.engine.pump();
    expect(f.slack.updateProgress.mock.calls.at(-1)).toEqual([first.id, first.origin,
      { commentary: 'Public step', steps: [{ id: 'turn-1:comment', text: 'Public step' }] }]);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(2);
    expect(f.codex.retryOverloaded).not.toHaveBeenCalled();
    expect(f.codex.interrupt).not.toHaveBeenCalled();
    expect(f.store.listDeliveries()).toEqual([]);
  });

  it('coalesces public commentary and native plan for the same request, excludes reasoning and closes even with NOREPLY', async () => {
    const f = fixture(); const root = await acceptRequest(f); await running(f, root);
    const plan = [{ step: 'Check access', status: 'completed' }, { step: 'Read results', status: 'in_progress' }];
    f.codex.notification({ method: 'item/completed', params: { threadId: THREAD, turnId: 'turn-1', item: { id: 'reason', type: 'reasoning', content: ['not public'], summary: ['private reasoning summary'] } } });
    f.codex.notification({ method: 'item/completed', params: { threadId: THREAD, turnId: 'turn-1', item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'Access checked, reading results.' } } });
    f.codex.notification({ method: 'turn/plan/updated', params: { threadId: THREAD, turnId: 'turn-1', plan } });
    await f.engine.settled(); await f.engine.pump();
    expect(f.slack.updateProgress).toHaveBeenCalledExactlyOnceWith(root.id, root.origin, { steps: [{ id: 'turn-1:comment', text: 'Access checked, reading results.' }], commentary: 'Access checked, reading results.', plan });
    expect(f.telegram.updateProgress).not.toHaveBeenCalled();
    f.codex.complete(root.id, 'NOREPLY'); await f.engine.settled(); await f.engine.pump();
    expect(f.slack.updateProgress.mock.calls.at(-1)?.[2]).toEqual({ steps: [{ id: 'turn-1:comment', text: 'Access checked, reading results.' }], commentary: 'Access checked, reading results.', plan, terminal: 'completed' });
    expect(f.store.listDeliveries().some(row => row.kind === 'answer')).toBe(false);
  });

  it('keeps the complete ordered commentary across duplicate events and history recovery', async () => {
    const f = fixture(); const root = await acceptRequest(f); await running(f, root);
    const first = { id: 'turn-1:one', text: 'First recovered step' };
    const second = { id: 'turn-1:two', text: 'Long public commentary '.repeat(200) };
    const event = { method: 'item/completed', params: { threadId: THREAD, turnId: 'turn-1',
      item: { id: 'two', type: 'agentMessage', phase: 'commentary', text: second.text } } };
    f.codex.notification(event); f.codex.notification(event); await f.engine.settled();
    expect(JSON.parse(f.store.getMeta(`request-progress:${root.id}`)!).steps).toEqual([second]);
    f.codex.locations.set(root.id, { state: 'running', turnId: 'turn-1', commentary: [first, second] });
    await f.engine.reconcile(root.id); await f.engine.pump();
    expect(f.slack.updateProgress.mock.calls.at(-1)?.[2]).toMatchObject({ steps: [first, second], commentary: second.text });
    await f.engine.reconcile(root.id);
    expect(JSON.parse(f.store.getMeta(`request-progress:${root.id}`)!).steps).toEqual([first, second]);
    f.codex.complete(root.id, 'Done'); await f.engine.settled(); await f.engine.pump();
    expect(f.slack.updateProgress.mock.calls.at(-1)?.[2]).toMatchObject({ steps: [first, second], terminal: 'completed' });
  });

  it('does not forward Desktop or mixed progress and does not fail the answer when Slack progress is unavailable', async () => {
    const f = fixture(); const root = await acceptRequest(f); await running(f, root);
    const event = (turnId: string) => ({ method: 'item/completed', params: { threadId: THREAD, turnId,
      item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'Public progress' } } });
    f.codex.notification(event('desktop-turn')); await f.engine.settled(); await f.engine.pump();
    expect(f.slack.updateProgress).not.toHaveBeenCalled();
    f.codex.notification(event('turn-1')); await f.engine.settled();
    f.slack.updateProgress.mockRejectedValueOnce(new ChannelError('Progress unavailable', true));
    await f.engine.pump();
    f.codex.complete(root.id, 'Final result'); await f.engine.settled(); await f.engine.pump();
    expect(f.store.getRequest(root.id)?.status).toBe('completed');
    expect(f.slack.deliver.mock.calls.some(([delivery]) => delivery.body === 'Final result')).toBe(true);
    const mixed = fixture(); const otherRoot = await acceptRequest(mixed); await running(mixed, otherRoot);
    mixed.codex.notification(event('turn-1')); await mixed.engine.settled();
    mixed.codex.locations.set(otherRoot.id, { state: 'running', turnId: 'turn-1', mixed: true });
    await mixed.engine.pump();
    expect(mixed.slack.updateProgress).toHaveBeenCalledExactlyOnceWith(otherRoot.id, otherRoot.origin, { terminal: 'failed', existingOnly: true });
  });
});

describe('Engine correlation and queue', () => {
  it('enqueues one attributed multi-party request with the original body and immutable roster', async () => {
    const f = fixture();
    const text = '@First @Second check this';
    await f.engine.receive(f.message('telegram', 'attributed', { text, sender: { id: '123', name: 'Actual author', isBot: false } }));
    await f.engine.settled();
    const request = f.store.listRequests()[0];
    expect(request.text).toBe(text);
    expect(request.origin.participants).toEqual([{ id: '123', name: 'Actual author', isBot: false }]);
    expect(f.codex.enqueue).toHaveBeenCalledExactlyOnceWith(THREAD, requestInput(request), request.id);
    expect(f.codex.enqueue.mock.calls[0][1]).toContain('"type":"human"');
    expect(f.codex.createThread).not.toHaveBeenCalled();
  });

  it('persists exact NOREPLY as a successful suppressed final, including repeated reconciliation and restart', async () => {
    const f = fixture();
    const request = await acceptRequest(f, 'telegram');
    await running(f, request);
    f.codex.complete(request.id, ' \nNOREPLY\n ');
    await f.engine.settled();
    await f.engine.reconcile(request.id);
    await f.engine.pump();
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'completed', suppressedFinal: true });
    expect(JSON.parse(f.store.getMeta(`suppressed-final:${request.id}`)!)).toMatchObject({ reason: 'NOREPLY', turnId: 'turn-1' });
    expect(f.store.listDeliveries()).toEqual([]);
    expect(f.telegram.deliver).not.toHaveBeenCalled();
    await f.engine.stop();
    const restarted = fixture({ path: f.path });
    await restarted.engine.pump();
    expect(restarted.store.getRequest(request.id)).toMatchObject({ status: 'completed', suppressedFinal: true });
    expect(restarted.store.listRequests()[0].suppressedFinal).toBe(true);
    expect(restarted.store.getMeta(`suppressed-final:${request.id}`)).toBe(f.store.getMeta(`suppressed-final:${request.id}`));
    expect(restarted.codex.enqueue).not.toHaveBeenCalled();
    expect(restarted.store.listDeliveries()).toEqual([]);
  });

  it.each(['noreply', '`NOREPLY`', 'NOREPLY because it is complete', 'The word NOREPLY'])('does not suppress ordinary final text: %s', async text => {
    const f = fixture();
    const request = await acceptRequest(f, 'telegram');
    await running(f, request);
    f.codex.complete(request.id, text);
    await f.engine.settled(); await f.engine.pump();
    expect(f.store.listDeliveries()).toEqual([expect.objectContaining({ kind: 'answer', body: text, status: 'sent' })]);
    expect(f.store.getMeta(`suppressed-final:${request.id}`)).toBeUndefined();
  });

  it('does not suppress failure notifications even when recovered text is NOREPLY', async () => {
    const f = fixture();
    const request = await acceptRequest(f, 'telegram');
    await running(f, request);
    f.codex.locations.set(request.id, { state: 'failed', turnId: 'turn-1', text: 'NOREPLY' });
    await f.engine.reconcile(request.id); await f.engine.pump();
    expect(f.store.getRequest(request.id)?.status).toBe('failed');
    expect(f.store.listDeliveries()[0]).toMatchObject({ kind: 'error', status: 'sent' });
    expect(f.store.getMeta(`suppressed-final:${request.id}`)).toBeUndefined();
  });

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
    expect(f.codex.enqueue).toHaveBeenCalledExactlyOnceWith(THREAD, requestInput(request), request.id);
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'starting', error: undefined });
  });

  it('retains a waiting request and its original ID across a Rele restart', async () => {
    const f = fixture();
    f.codex.subscribe.mockRejectedValueOnce(new CodexThreadBusyError(THREAD));
    const request = await acceptRequest(f);
    await f.engine.stop();
    const restarted = fixture({ path: f.path });
    await restarted.engine.pump();
    expect(restarted.codex.enqueue).toHaveBeenCalledExactlyOnceWith(THREAD, requestInput(request), request.id);
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
    expect(f.codex.enqueue).toHaveBeenLastCalledWith(THREAD, requestInput(first), first.id);

    await running(f, first);
    f.codex.complete(first.id, 'Slack answer');
    await f.engine.settled();
    await f.engine.pump();
    await f.engine.settled();
    expect(f.slack.deliver).toHaveBeenCalledTimes(1);
    expect(f.slack.deliver.mock.calls[0][0]).toMatchObject({ requestId: first.id, body: 'Slack answer', origin: first.origin });
    expect(f.telegram.deliver).not.toHaveBeenCalled();
    expect(f.codex.enqueue).toHaveBeenCalledTimes(2);
    expect(f.codex.enqueue).toHaveBeenLastCalledWith(THREAD, requestInput(second), second.id);

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
      f.codex.releaseThread.mockClear(); // Exclude the preceding passive-context writer release.
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

  it.each(['completed', 'failed'] as const)('never publishes a mixed Desktop/Rele %s result, including after reconnect and an incomplete history snapshot', async state => {
    const f = fixture();
    const request = await acceptRequest(f);
    await running(f, request);
    f.codex.notification({ method: 'item/started', params: { threadId: THREAD, turnId: 'turn-1', item: { type: 'userMessage', clientId: null } } });
    await f.engine.settled();
    expect(f.store.getRequest(request.id)?.status).toBe('uncertain');
    f.codex.connection(false);
    f.codex.locations.set(request.id, { state, turnId: 'turn-1', text: 'Contains Desktop-only context', failureReason: 'serverOverloaded', mixed: false });
    f.codex.connection(true);
    await f.engine.settled();
    await f.engine.pump();
    expect(f.store.getRequest(request.id)?.status).toBe('failed');
    expect(f.store.listDeliveries()).toEqual([]);
    expect(f.slack.deliver).not.toHaveBeenCalled();
    expect(f.telegram.deliver).not.toHaveBeenCalled();
  });

  it.each(['slack', 'telegram'] as const)('retries overload with backoff and delivers only to %s', async platform => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(); const request = await acceptRequest(f, platform); await running(f, request);
    f.codex.locations.set(request.id, { state: 'failed', turnId: 'turn-1', failureReason: 'serverOverloaded' });
    await f.engine.reconcile(request.id); await f.engine.pump();
    expect(f.codex.retryOverloaded).not.toHaveBeenCalled();
    expect(f.store.getRequest(request.id)?.status).toBe('running');
    expect(f.store.listDeliveries()).toMatchObject([{ kind: 'answer', body: expect.stringContaining('через 15 с'), status: 'sent' }]);
    vi.setSystemTime(Date.now() + 15_000); await f.engine.reconcile(request.id); await f.engine.settled();
    expect(f.codex.retryOverloaded).toHaveBeenCalledTimes(1);
    f.codex.complete(request.id, 'Recovered answer', 'turn-1-retry');
    await f.engine.settled(); await f.engine.pump();
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'completed', turnId: 'turn-1-retry' });
    expect(f.store.listDeliveries().filter(row => row.key.startsWith('answer:'))).toMatchObject([{ body: 'Recovered answer', status: 'sent' }]);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    expect(f[platform === 'slack' ? 'telegram' : 'slack'].deliver).not.toHaveBeenCalled();
  });

  it('stops after four increasing overload delays without replaying input', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(); const request = await acceptRequest(f); await running(f, request);
    let turnId = 'turn-1';
    for (const seconds of [15, 30, 60, 120]) {
      f.codex.locations.set(request.id, { state: 'failed', turnId, failureReason: 'serverOverloaded' });
      await f.engine.reconcile(request.id);
      const before = f.codex.retryOverloaded.mock.calls.length;
      vi.setSystemTime(Date.now() + seconds * 1000 - 1); await f.engine.reconcile(request.id);
      expect(f.codex.retryOverloaded).toHaveBeenCalledTimes(before);
      vi.setSystemTime(Date.now() + 1); await f.engine.reconcile(request.id); await f.engine.settled();
      expect(f.codex.retryOverloaded).toHaveBeenCalledTimes(before + 1); turnId += '-retry';
    }
    f.codex.locations.set(request.id, { state: 'failed', turnId, failureReason: 'serverOverloaded' });
    await f.engine.reconcile(request.id); await f.engine.pump();
    expect(f.store.getRequest(request.id)?.status).toBe('failed');
    expect(f.store.listDeliveries().filter(row => row.kind === 'error')).toHaveLength(1);
    expect(f.codex.retryOverloaded).toHaveBeenCalledTimes(4);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
  });

  it('reports native willRetry once without scheduling a second turn', async () => {
    const f = fixture(); const request = await acceptRequest(f); await running(f, request);
    for (let i = 0; i < 2; i++) f.codex.notification({ method: 'error', params: { threadId: THREAD, turnId: 'turn-1', willRetry: true, error: { codexErrorInfo: 'serverOverloaded', message: 'private' } } });
    await f.engine.settled(); await f.engine.pump();
    expect(f.store.listDeliveries()).toMatchObject([{ kind: 'answer', body: expect.stringContaining('автоматически повторяет') }]);
    expect(f.codex.retryOverloaded).not.toHaveBeenCalled();
    expect(JSON.stringify(f.store.listDeliveries())).not.toContain('private');
  });

  it('adopts a Desktop continuation during backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(); const request = await acceptRequest(f); await running(f, request);
    f.codex.locations.set(request.id, { state: 'failed', turnId: 'turn-1', failureReason: 'serverOverloaded' });
    await f.engine.reconcile(request.id);
    f.codex.locations.set(request.id, { state: 'running', turnId: 'desktop-retry', retryCount: 1 });
    f.codex.notification({ method: 'turn/started', params: { threadId: THREAD, turn: { id: 'desktop-retry' } } });
    await f.engine.settled(); expect(f.store.getRequest(request.id)?.turnId).toBe('desktop-retry');
    vi.setSystemTime(Date.now() + 20_000); await f.engine.reconcile(request.id);
    expect(f.codex.retryOverloaded).not.toHaveBeenCalled();
    f.codex.complete(request.id, 'Desktop retry result', 'desktop-retry');
    await f.engine.settled(); await f.engine.pump();
    expect(f.store.listDeliveries().filter(row => row.key.startsWith('answer:'))).toMatchObject([{ body: 'Desktop retry result' }]);
  });

  it('Stop during backoff prevents retry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(); const request = await acceptRequest(f); await running(f, request);
    f.codex.locations.set(request.id, { state: 'failed', turnId: 'turn-1', failureReason: 'serverOverloaded' });
    await f.engine.reconcile(request.id); await f.engine.cancel(request.id);
    vi.setSystemTime(Date.now() + 300_000); await f.engine.reconcile(request.id);
    expect(f.store.getRequest(request.id)?.status).toBe('cancelled');
    expect(f.codex.retryOverloaded).not.toHaveBeenCalled(); expect(f.codex.interrupt).not.toHaveBeenCalled();
  });

  it('does not resend a lost retry ACK and accepts a later receipt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(); const request = await acceptRequest(f); await running(f, request);
    f.codex.locations.set(request.id, { state: 'failed', turnId: 'turn-1', failureReason: 'serverOverloaded' });
    f.codex.retryOverloaded.mockImplementationOnce(async (_thread, _id, _turn, _inputs, beforeSend) => { beforeSend(); throw new Error('Lost ACK'); });
    await f.engine.reconcile(request.id); vi.setSystemTime(Date.now() + 15_000);
    await f.engine.reconcile(request.id); vi.setSystemTime(Date.now() + 300_000); await f.engine.reconcile(request.id);
    expect(f.store.getRequest(request.id)?.status).toBe('uncertain'); expect(f.codex.retryOverloaded).toHaveBeenCalledTimes(1);
    f.codex.locations.set(request.id, { state: 'completed', turnId: 'recovered-retry', text: 'Recovered once' });
    await f.engine.reconcile(request.id); await f.engine.pump();
    expect(f.store.getRequest(request.id)?.status).toBe('completed');
    expect(f.store.listDeliveries().filter(row => row.key.startsWith('answer:'))).toHaveLength(1);
  });

  it('preserves the retry deadline across an Engine restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(); const request = await acceptRequest(f); await running(f, request);
    const failed: RequestLocation = { state: 'failed', turnId: 'turn-1', failureReason: 'serverOverloaded' };
    f.codex.locations.set(request.id, failed); await f.engine.reconcile(request.id); await f.engine.stop();
    const restored = fixture({ path: f.path, start: false }); restored.codex.locations.set(request.id, failed);
    restored.engine.start(); await restored.engine.settled();
    vi.setSystemTime(Date.now() + 14_999); await restored.engine.reconcile(request.id);
    expect(restored.codex.retryOverloaded).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1); await restored.engine.reconcile(request.id); await restored.engine.settled();
    expect(restored.codex.retryOverloaded).toHaveBeenCalledTimes(1); expect(restored.codex.enqueue).not.toHaveBeenCalled();
  });

  it('does not retry when foreign work follows the overload', async () => {
    const f = fixture(); const request = await acceptRequest(f); await running(f, request);
    f.codex.locations.set(request.id, { state: 'failed', turnId: 'turn-1', failureReason: 'serverOverloaded', retryBlocked: true });
    await f.engine.reconcile(request.id);
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('другая задача') });
    expect(f.codex.retryOverloaded).not.toHaveBeenCalled();
  });

  it('Stop racing a retry ACK waits for the new turn and interrupts it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(); const request = await acceptRequest(f); await running(f, request);
    f.codex.locations.set(request.id, { state: 'failed', turnId: 'turn-1', failureReason: 'serverOverloaded' });
    await f.engine.reconcile(request.id); vi.setSystemTime(Date.now() + 15_000);
    const ack = deferred<{ turnId: string }>();
    f.codex.retryOverloaded.mockImplementationOnce(async (_thread, _id, _turn, _inputs, beforeSend) => { beforeSend(); return ack.promise; });
    const reconciliation = f.engine.reconcile(request.id);
    await vi.waitFor(() => expect(f.codex.retryOverloaded).toHaveBeenCalledTimes(1));
    const cancellation = f.engine.cancel(request.id);
    expect(f.codex.interrupt).not.toHaveBeenCalled();
    f.codex.locations.set(request.id, { state: 'running', turnId: 'new-retry' }); ack.resolve({ turnId: 'new-retry' });
    await reconciliation; await cancellation; await f.engine.settled();
    expect(f.codex.interrupt).toHaveBeenCalledWith(THREAD, 'new-retry');
    expect(f.store.getRequest(request.id)?.status).toBe('interrupted');
  });

  it('a native busy rejection defers retry without burning an attempt or looping', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(); const request = await acceptRequest(f); await running(f, request);
    f.codex.locations.set(request.id, { state: 'failed', turnId: 'turn-1', failureReason: 'serverOverloaded' });
    await f.engine.reconcile(request.id); vi.setSystemTime(Date.now() + 15_000);
    f.codex.retryOverloaded.mockImplementationOnce(async (_thread, _id, _turn, _inputs, beforeSend) => { beforeSend(); throw new CodexThreadBusyError(THREAD, 'non_idle'); });
    await f.engine.reconcile(request.id); await f.engine.settled();
    await f.engine.reconcile(request.id); expect(f.codex.retryOverloaded).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 15_000); await f.engine.pump(); await f.engine.settled();
    expect(f.codex.retryOverloaded).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.store.getMeta(`overload-retry:${request.id}`)!)).toMatchObject({ attempts: 1 });
  });

  it('keeps an unknown native failure generic without publishing raw error details', async () => {
    const f = fixture();
    const request = await acceptRequest(f);
    await running(f, request);
    f.codex.locations.set(request.id, { state: 'failed', turnId: 'turn-1',
      ...{ error: { message: 'synthetic-secret', additionalDetails: 'private-synthetic-secret' } } });
    await f.engine.reconcile(request.id);
    await f.engine.pump();
    const error = 'Codex завершил запрос с ошибкой. Подробности доступны в Codex.';
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'failed', error });
    expect(f.store.listDeliveries()).toMatchObject([{ kind: 'error', body: error }]);
    expect(JSON.stringify(f.store.listDeliveries())).not.toContain('synthetic-secret');
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
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

describe('Engine continuation after native Stop', () => {
  function ownQueue(f: ReturnType<typeof fixture>, request: ReleRequest, soleQueuedSubmission = true): RequestLocation {
    const location: RequestLocation = { state: 'queued', queuedSubmissionId: `queue-${request.id}`, soleQueuedSubmission };
    f.codex.locations.set(request.id, location);
    return location;
  }

  it('automatically starts the fresh own submission after Stop while preserving the original origin and UUID', async () => {
    const f = fixture();
    const stopped = await acceptRequest(f, 'telegram', 'stopped');
    await running(f, stopped);
    f.codex.locations.set(stopped.id, { state: 'interrupted', turnId: 'turn-1' });
    f.codex.notification({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: 'turn-1', status: 'interrupted' } } });
    await f.engine.settled();
    f.codex.enqueue.mockImplementationOnce(async (_thread, _text, clientId) => {
      const queuedSubmissionId = `queue-${clientId}`;
      f.codex.locations.set(clientId, { state: 'queued', queuedSubmissionId, soleQueuedSubmission: true });
      return { queuedSubmissionId };
    });
    f.codex.startQueued.mockImplementationOnce(async (_thread, queuedSubmissionId) => {
      const requestId = queuedSubmissionId.slice('queue-'.length);
      f.codex.running(requestId, 'fresh-turn');
      return { turn: { id: 'fresh-turn', status: 'inProgress', items: [] } };
    });
    const fresh = await acceptRequest(f, 'slack', 'fresh-after-stop');
    await f.engine.settled();
    expect(f.codex.startQueued).toHaveBeenCalledExactlyOnceWith(THREAD, `queue-${fresh.id}`);
    expect(f.store.getRequest(stopped.id)?.status).toBe('interrupted');
    expect(f.store.getRequest(fresh.id)).toMatchObject({ status: 'running', turnId: 'fresh-turn', origin: fresh.origin });
    f.codex.complete(fresh.id, 'Fresh own result', 'fresh-turn');
    await f.engine.settled(); await f.engine.pump();
    expect(f.slack.deliver.mock.calls.some(([delivery]) => delivery.requestId === fresh.id && delivery.body === 'Fresh own result')).toBe(true);
    expect(f.telegram.deliver.mock.calls.some(([delivery]) => delivery.requestId === fresh.id)).toBe(false);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(2);
    expect(f.codex.interrupt).not.toHaveBeenCalled();
  });

  it('keeps a foreign native queue paused automatically but permits explicit continuation of the selected own entry', async () => {
    const f = fixture(), request = await acceptRequest(f, 'telegram');
    ownQueue(f, request, false);
    await f.engine.reconcile(request.id);
    expect(f.codex.startQueued).not.toHaveBeenCalled();
    await f.engine.resume(request.id);
    expect(f.codex.startQueued).toHaveBeenCalledExactlyOnceWith(THREAD, `queue-${request.id}`);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
  });

  it('retries only after a confirmed busy refusal and never interrupts the active Desktop turn', async () => {
    const f = fixture(), request = await acceptRequest(f, 'telegram');
    ownQueue(f, request);
    f.codex.startQueued.mockRejectedValueOnce(new CodexThreadBusyError(THREAD, 'non_idle'));
    await f.engine.reconcile(request.id);
    expect(f.store.getRequest(request.id)?.status).toBe('starting');
    expect(f.store.getMeta(`queue-start-attempt:${request.id}`)).toBe('');
    await f.engine.reconcile(request.id);
    expect(f.codex.startQueued).toHaveBeenCalledTimes(2);
    expect(f.codex.startQueued.mock.calls.every(args => args[1] === `queue-${request.id}`)).toBe(true);
    expect(f.codex.interrupt).not.toHaveBeenCalled();
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
  });

  it('recovers a lost enqueue ACK by UUID and starts the existing sole submission without enqueueing again', async () => {
    const f = fixture();
    f.codex.enqueue.mockImplementationOnce(async (_thread, _text, clientId) => {
      f.codex.locations.set(clientId, { state: 'queued', queuedSubmissionId: 'accepted-native-entry', soleQueuedSubmission: true });
      throw new CodexTransportError('Lost queue/add ACK');
    });
    const request = await acceptRequest(f, 'telegram');
    await f.engine.reconcile(request.id);
    expect(f.codex.startQueued).toHaveBeenCalledExactlyOnceWith(THREAD, 'accepted-native-entry');
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    expect(f.store.getRequest(request.id)?.queuedSubmissionId).toBe('accepted-native-entry');
  });

  it('persists a lost queue/start ACK fence across restart and recovers later completion without repeating either mutation', async () => {
    const f = fixture(), request = await acceptRequest(f, 'telegram');
    ownQueue(f, request);
    f.codex.startQueued.mockRejectedValueOnce(new CodexTransportError('Lost queue/start ACK'));
    await f.engine.reconcile(request.id);
    expect(f.store.getRequest(request.id)?.status).toBe('uncertain');
    await f.engine.reconcile(request.id);
    expect(f.codex.startQueued).toHaveBeenCalledTimes(1);
    await f.engine.stop();
    const restarted = fixture({ path: f.path, start: false });
    ownQueue(restarted, request);
    restarted.engine.start(); await restarted.engine.settled(); await restarted.engine.reconcile(request.id);
    expect(restarted.codex.startQueued).not.toHaveBeenCalled();
    expect(restarted.codex.enqueue).not.toHaveBeenCalled();
    expect(restarted.store.getRequest(request.id)?.status).toBe('uncertain');
    restarted.codex.locations.set(request.id, { state: 'completed', turnId: 'accepted-before-loss', text: 'Recovered result' });
    await restarted.engine.reconcile(request.id); await restarted.engine.pump();
    expect(restarted.store.getRequest(request.id)?.status).toBe('completed');
    expect(restarted.telegram.deliver).toHaveBeenCalledTimes(1);
    expect(restarted.codex.startQueued).not.toHaveBeenCalled();
  });

  it.each(['pause', 'source-off', 'suspend', 'mixed', 'cancel', 'replace', 'disconnect', 'unverified'] as const)('rechecks %s after the native queue lookup before any automatic mutation', async guard => {
    const f = fixture(), request = await acceptRequest(f, 'slack');
    const location = ownQueue(f, request), gate = deferred<RequestLocation>();
    f.codex.findRequest.mockImplementationOnce(() => gate.promise);
    const before = f.codex.findRequest.mock.calls.length;
    const checking = f.engine.reconcile(request.id);
    await vi.waitFor(() => expect(f.codex.findRequest.mock.calls.length).toBe(before + 1));
    if (guard === 'pause') f.store.updateConversation(request.conversationId, { paused: true });
    if (guard === 'source-off') f.store.setSourceAccess(f.eps.slack.id, { mode: 'off' });
    if (guard === 'suspend') f.engine.suspend(true);
    if (guard === 'mixed') f.store.setMeta(`mixed:${request.id}`, '1');
    if (guard === 'cancel') await f.engine.cancel(request.id);
    if (guard === 'replace') f.engine.replaceCodex(new FakeCodex());
    if (guard === 'disconnect') f.codex.connection(false);
    if (guard === 'unverified') f.codex.verifiedVersion = false;
    gate.resolve(location); await checking; await f.engine.settled();
    expect(f.codex.startQueued).not.toHaveBeenCalled();
    expect(f.store.listRequests()).toHaveLength(1);
  });

  it('keeps the cancellation fence after a lost delete ACK and a Rele restart', async () => {
    const f = fixture(), request = await acceptRequest(f, 'telegram');
    ownQueue(f, request);
    f.codex.deleteQueued.mockRejectedValueOnce(new CodexTransportError('Lost delete ACK'));
    await expect(f.engine.cancel(request.id)).rejects.toThrow('Lost delete ACK');
    await f.engine.reconcile(request.id);
    expect(f.codex.startQueued).not.toHaveBeenCalled();
    await f.engine.stop();
    const restarted = fixture({ path: f.path, start: false });
    ownQueue(restarted, request); restarted.engine.start(); await restarted.engine.settled();
    expect(restarted.store.getMeta(`cancel-requested:${request.id}`)).toBe('1');
    expect(restarted.codex.startQueued).not.toHaveBeenCalled();
    expect(restarted.codex.enqueue).not.toHaveBeenCalled();
    await expect(restarted.engine.resume(request.id)).rejects.toThrow('отмену');
  });

  it('cancels the exact own turn if it starts while the queued deletion is in flight', async () => {
    const f = fixture(), request = await acceptRequest(f, 'telegram');
    const location = ownQueue(f, request), startAck = deferred<{ turn: { id: string; status: string; items: never[] } }>();
    f.codex.startQueued.mockImplementationOnce(() => startAck.promise);
    const continuing = f.engine.reconcile(request.id);
    await vi.waitFor(() => expect(f.codex.startQueued).toHaveBeenCalledTimes(1));
    f.codex.deleteQueued.mockImplementationOnce(async () => {
      f.codex.locations.set(request.id, { state: 'running', turnId: 'exact-own-started-turn' });
      return { deleted: false };
    });
    await f.engine.cancel(request.id);
    expect(f.codex.deleteQueued).toHaveBeenCalledExactlyOnceWith(THREAD, location.queuedSubmissionId);
    expect(f.codex.interrupt).toHaveBeenCalledExactlyOnceWith(THREAD, 'exact-own-started-turn');
    startAck.resolve({ turn: { id: 'exact-own-started-turn', status: 'inProgress', items: [] } });
    await continuing;
    f.codex.locations.set(request.id, { state: 'interrupted', turnId: 'exact-own-started-turn' });
    await f.engine.reconcile(request.id);
    expect(f.store.getRequest(request.id)?.status).toBe('interrupted');
    expect(f.codex.startQueued).toHaveBeenCalledTimes(1);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
  });

  it('shares one native start between manual resume and reconciliation', async () => {
    const f = fixture(), request = await acceptRequest(f, 'telegram');
    ownQueue(f, request);
    const gate = deferred<{ turn: { id: string; status: string; items: never[] } }>();
    f.codex.startQueued.mockImplementationOnce(() => gate.promise);
    const automatic = f.engine.reconcile(request.id);
    await vi.waitFor(() => expect(f.codex.startQueued).toHaveBeenCalledTimes(1));
    const manual = f.engine.resume(request.id);
    await Promise.resolve();
    f.codex.locations.set(request.id, { state: 'running', turnId: 'one-start' });
    gate.resolve({ turn: { id: 'one-start', status: 'inProgress', items: [] } });
    await Promise.all([automatic, manual]); await f.engine.settled();
    expect(f.codex.startQueued).toHaveBeenCalledTimes(1);
    expect(f.store.getRequest(request.id)?.turnId).toBe('one-start');
  });
});

describe('Engine scoped shell cancellation', () => {
  async function shell(f: ReturnType<typeof fixture>) {
    const request = await acceptRequest(f, 'telegram', 'own-shell');
    await running(f, request, 'shell-turn');
    f.codex.notification({ method: 'item/started', params: { threadId: THREAD, turnId: 'shell-turn',
      item: { type: 'commandExecution', id: 'own-command', processId: null } } });
    await f.engine.settled();
    f.codex.terminals.push({ itemId: 'own-command', processId: '1234' });
    return request;
  }

  it('holds completion, release and the next request until exact own terminal cleanup while late items still arrive', async () => {
    const f = fixture();
    f.store.removeBinding(f.conversation.id, f.conversation.bindings.find(binding => binding.platform === 'slack')!.id);
    f.codex.terminals = [{ itemId: 'foreign-command', processId: '9876' }];
    const request = await acceptRequest(f, 'telegram', 'cancel-own-shell');
    f.codex.releaseThread.mockClear();
    await running(f, request, 'shell-turn');
    f.codex.notification({ method: 'item/started', params: { threadId: THREAD, turnId: 'shell-turn',
      item: { type: 'commandExecution', id: 'own-command', processId: null } } });
    await f.engine.settled();
    f.codex.terminals.push({ itemId: 'own-command', processId: '1234' });
    f.codex.interrupt.mockImplementationOnce(async () => {
      f.codex.locations.set(request.id, { state: 'interrupted', turnId: 'shell-turn' });
      f.codex.notification({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: 'shell-turn', status: 'interrupted' } } });
    });
    const cleanup = deferred<void>(); void cleanup.promise.catch(() => {});
    f.codex.terminateBackgroundTerminal.mockImplementationOnce(async () => {
      await cleanup.promise;
      f.codex.terminals = f.codex.terminals.filter(row => row.itemId !== 'own-command');
    });
    const cancelling = f.engine.cancel(request.id);
    await vi.waitFor(() => expect(f.codex.terminateBackgroundTerminal).toHaveBeenCalledOnce());
    f.codex.notification({ method: 'item/completed', params: { threadId: THREAD, turnId: 'shell-turn',
      item: { type: 'commandExecution', id: 'own-command', processId: '1234' } } });
    await vi.waitFor(() => expect(f.store.getMeta(`request-command-items:${request.id}`)).toContain('1234'));
    const next = await acceptRequest(f, 'telegram', 'after-shell-stop');
    await f.engine.pump();
    expect(f.store.getRequest(request.id)?.status).toBe('uncertain');
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    expect(f.codex.releaseThread).not.toHaveBeenCalled();
    expect(f.store.listDeliveries().some(row => row.requestId === request.id && row.key === 'terminal:error')).toBe(false);
    cleanup.resolve(); await cancelling; await f.engine.settled(); await f.engine.pump(); await f.engine.settled();
    expect(f.store.getRequest(request.id)?.status).toBe('interrupted');
    expect(f.codex.terminateBackgroundTerminal).toHaveBeenCalledExactlyOnceWith(THREAD, { serverId: 42, itemId: 'own-command', processId: '1234' });
    expect(f.codex.terminals).toEqual([{ itemId: 'foreign-command', processId: '9876' }]);
    expect(f.diagnostics).toEqual([]);
    expect(f.store.getRequest(next.id)).toMatchObject({ status: 'starting' });
    expect(f.codex.enqueue).toHaveBeenLastCalledWith(THREAD, requestInput(next), next.id);
  });

  it.each(['running', 'interrupted'] as const)('reconciles a lost terminate ACK on the same connection from %s without replaying a persisted PID', async state => {
    const f = fixture(), request = await shell(f);
    if (state === 'interrupted') f.codex.locations.set(request.id, { state, turnId: 'shell-turn' });
    f.codex.terminateBackgroundTerminal.mockImplementationOnce(async () => {
      f.codex.terminals = [];
      throw new CodexTransportError('Lost terminal ACK');
    });
    await expect(f.engine.cancel(request.id)).rejects.toThrow('Lost terminal ACK');
    expect(f.store.getRequest(request.id)?.status).toBe('uncertain');
    expect(f.store.listDeliveries().some(row => row.requestId === request.id && row.key === 'terminal:error')).toBe(false);
    await f.engine.reconcile(request.id); await f.engine.settled();
    expect(f.store.getRequest(request.id)?.status).toBe('interrupted');
    expect(f.codex.terminateBackgroundTerminal).toHaveBeenCalledTimes(1);
    expect(f.codex.interrupt).toHaveBeenCalledTimes(state === 'running' ? 1 : 0);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
  });

  it('keeps pending cleanup uncertain after Engine restart even with the same server PID and an empty registry', async () => {
    const f = fixture(), request = await shell(f);
    f.codex.terminateBackgroundTerminal.mockImplementationOnce(async () => {
      f.codex.terminals = [];
      throw new CodexTransportError('Lost terminal ACK');
    });
    await expect(f.engine.cancel(request.id)).rejects.toThrow('Lost terminal ACK');
    await f.engine.stop();
    const restarted = fixture({ path: f.path, start: false });
    restarted.codex.locations.set(request.id, { state: 'interrupted', turnId: 'shell-turn' });
    restarted.engine.start(); await restarted.engine.settled(); await restarted.engine.reconcile(request.id);
    expect(restarted.store.getRequest(request.id)).toMatchObject({ status: 'uncertain', error: expect.stringContaining('соединение отмены потеряно') });
    expect(restarted.codex.serverId).toBe(f.codex.serverId);
    expect(restarted.codex.terminals).toEqual([]);
    expect(restarted.codex.interrupt).not.toHaveBeenCalled();
    expect(restarted.codex.terminateBackgroundTerminal).not.toHaveBeenCalled();
    expect(restarted.codex.subscribe).not.toHaveBeenCalled();
    expect(restarted.codex.backgroundTerminals).not.toHaveBeenCalled();
    expect(restarted.store.listDeliveries().some(row => row.requestId === request.id && row.key === 'terminal:error')).toBe(false);
  });

  it('does not terminate an unmapped fresh terminal or release the request as stopped', async () => {
    const f = fixture(), request = await acceptRequest(f, 'telegram');
    f.codex.releaseThread.mockClear();
    await running(f, request, 'shell-turn');
    f.codex.terminals.push({ itemId: 'unmapped-command', processId: '1234' });
    await expect(f.engine.cancel(request.id)).rejects.toThrow('не подтверждены');
    expect(f.codex.interrupt).toHaveBeenCalledExactlyOnceWith(THREAD, 'shell-turn');
    expect(f.codex.terminateBackgroundTerminal).not.toHaveBeenCalled();
    expect(f.store.getRequest(request.id)?.status).toBe('uncertain');
    expect(f.codex.releaseThread).not.toHaveBeenCalled();
  });

  it('does not accept an empty registry while a canonical startup item has no completion or termination receipt', async () => {
    const f = fixture(), request = await shell(f);
    f.codex.terminals = [];
    await expect(f.engine.cancel(request.id)).rejects.toThrow('не подтверждены');
    expect(f.store.getRequest(request.id)?.status).toBe('uncertain');
    expect(f.codex.terminateBackgroundTerminal).not.toHaveBeenCalled();
    f.codex.notification({ method: 'item/completed', params: { threadId: THREAD, turnId: 'shell-turn',
      item: { type: 'commandExecution', id: 'own-command', processId: null } } });
    await f.engine.settled(); await f.engine.reconcile(request.id); await f.engine.settled();
    expect(f.store.getRequest(request.id)?.status).toBe('interrupted');
  });

  it('cancels locally while the pre-enqueue terminal snapshot is pending without sending the original request', async () => {
    const f = fixture();
    f.store.removeBinding(f.conversation.id, f.conversation.bindings.find(binding => binding.platform === 'slack')!.id);
    const baseline = deferred<{ serverId: number; terminals: Array<{ itemId: string; processId: string }> }>();
    f.codex.backgroundTerminals.mockImplementationOnce(() => baseline.promise);
    await f.engine.receive(f.message('telegram', 'cancel-before-enqueue'));
    await vi.waitFor(() => expect(f.codex.backgroundTerminals).toHaveBeenCalledOnce());
    const request = f.store.listRequests()[0];
    await f.engine.cancel(request.id);
    baseline.resolve({ serverId: 42, terminals: [] }); await f.engine.settled();
    expect(f.store.getRequest(request.id)?.status).toBe('cancelled');
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    expect(f.codex.interrupt).not.toHaveBeenCalled();
    expect(f.codex.terminateBackgroundTerminal).not.toHaveBeenCalled();
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
    await requestApproval(f, first);
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

describe('Engine durable outgoing tools', () => {
  function toolsFixture() {
    const f = fixture(); f.config.slack.enabled = true; f.config.telegram.enabled = true;
    return f;
  }
  async function send(f: ReturnType<typeof fixture>, callId = 'native-call', args: Record<string, unknown> = { endpointId: f.eps.slack.id, text: 'Agent message' }): Promise<MessageToolReceipt> {
    const result = await f.engine.messageTool({ threadId: THREAD, callId, name: 'send_message', arguments: args });
    if ('destinations' in result) throw new Error('Unexpected destination response');
    return result;
  }
  it('lists only linked enabled sources and observed thread authors, and accepts a Desktop-origin send with no inbound request', async () => {
    const f = toolsFixture();
    f.store.recordInbound(f.message('slack', 'known-peer', { sender: { id: 'UPEER', name: 'Peer agent', isBot: true }, contextOnly: true }));
    const result = await f.engine.messageTool({ threadId: THREAD, callId: 'list', name: 'list_destinations', arguments: {} });
    expect(result).toMatchObject({ destinations: [
      { endpointId: f.eps.slack.id, participants: [{ id: 'UPEER', name: 'Peer agent', isBot: true }] },
      { endpointId: f.eps.telegram.id, participants: [] },
    ] });
    const receipt = await send(f, 'native-call', { endpointId: f.eps.slack.id, text: 'Agent message', mentionIds: ['UPEER'] });
    await f.engine.settled();
    expect(f.store.listRequests()).toEqual([]);
    expect(f.store.getDelivery(receipt.operationId)).toMatchObject({ kind: 'message', status: 'sent', nativeThreadId: THREAD,
      origin: { senderId: 'bot-user', senderName: 'slack', senderIsBot: true }, mentions: [{ id: 'UPEER', isBot: true }] });
    expect(f.store.getDelivery(receipt.operationId)?.requestId).toBeUndefined();
    expect(f.slack.deliver).toHaveBeenCalledOnce();
    expect(f.telegram.deliver).not.toHaveBeenCalled();
    expect(f.store.getThreadParticipants(f.eps.slack.id)).toContainEqual({ id: 'bot-user', name: 'slack', isBot: true });
    expect(f.store.listSlackSyncStreams().filter(stream => stream.endpointId === f.eps.slack.id)
      .flatMap(stream => f.store.listSlackSyncEntries(stream.id)).some(entry => entry.message.sender.id === 'bot-user')).toBe(false);
  });

  it('records a confirmed own Telegram post as passive context without a new request', async () => {
    const f = toolsFixture();
    const receipt = await send(f, 'telegram-send', { endpointId: f.eps.telegram.id, text: 'Own Telegram report' });
    await f.engine.settled();
    expect(f.store.getDelivery(receipt.operationId)?.status).toBe('sent');
    expect(f.store.listRequests()).toEqual([]);
    expect(f.store.listSlackSyncStreams().filter(stream => stream.endpointId === f.eps.telegram.id)
      .flatMap(stream => f.store.listSlackSyncEntries(stream.id)).some(entry => entry.message.sender.id === '999' && entry.message.text === 'Own Telegram report')).toBe(true);
    await f.engine.pump(); await f.engine.settled();
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    expect(f.telegram.deliver).toHaveBeenCalledOnce();
  });

  it('returns the same durable receipt on duplicate calls, rejects changed arguments, and scopes status to the native thread', async () => {
    const f = toolsFixture();
    const receipt = await send(f); await f.engine.settled();
    expect(await send(f)).toMatchObject({ operationId: receipt.operationId, status: 'sent' });
    expect(f.slack.deliver).toHaveBeenCalledOnce();
    await expect(send(f, 'native-call', { endpointId: f.eps.slack.id, text: 'Changed' })).rejects.toThrow(/другими аргументами/);
    const status = await f.engine.messageTool({ threadId: THREAD, callId: 'status', name: 'get_message_status', arguments: { operationId: receipt.operationId } });
    expect(status).toMatchObject({ operationId: receipt.operationId, status: 'sent' });
    await expect(f.engine.messageTool({ threadId: 'foreign-thread', callId: 'status', name: 'get_message_status', arguments: { operationId: receipt.operationId } })).rejects.toThrow(/не найдена/);
  });

  it('keeps timeout outcomes uncertain without a blind retry or raw channel-error exposure', async () => {
    const f = toolsFixture();
    f.slack.deliver.mockRejectedValueOnce(new ChannelError('synthetic-private-channel-error', false, true));
    const receipt = await send(f); await f.engine.settled();
    await f.engine.pump(); await f.engine.pump();
    expect(f.slack.deliver).toHaveBeenCalledOnce();
    expect(await send(f)).toMatchObject({ operationId: receipt.operationId, status: 'uncertain' });
    expect(JSON.stringify(await send(f))).not.toContain('synthetic-private');
    expect(() => f.engine.retryDelivery(receipt.operationId)).toThrow(/Неопределённую/);
  });

  it.each(['access', 'pause', 'account', 'binding'] as const)('cancels an unsent tool message after %s changes', async reason => {
    const f = toolsFixture();
    const gate = deferred<string>(); f.slack.deliver.mockImplementationOnce(() => gate.promise);
    await send(f, 'first-call');
    const queued = await send(f, 'queued-call');
    if (reason === 'access') f.store.setSourceAccess(f.eps.slack.id, { mode: 'off' });
    if (reason === 'pause') f.store.updateConversation(f.conversation.id, { paused: true });
    if (reason === 'account') f.slack.state.accountId = 'different:bot';
    if (reason === 'binding') f.store.removeBinding(f.conversation.id, f.conversation.bindings.find(value => value.platform === 'slack')!.id);
    gate.resolve('170002.000001'); await f.engine.settled();
    expect(f.store.getDelivery(queued.operationId)?.status).toBe('cancelled');
    expect(f.slack.deliver).toHaveBeenCalledOnce();
  });

  it('rejects implicit or foreign destinations, catalog-only people, malformed calls and Telegram participants without a known username', async () => {
    const f = toolsFixture();
    for (const args of [{ text: 'No destination' }, { endpointId: 'foreign', text: 'Work' },
      { endpointId: f.eps.slack.id, text: 'Work', mentionIds: ['U1'] }, { endpointId: f.eps.slack.id, text: 'Work', author: 'Forged' },
      { endpointId: f.eps.slack.id, text: 'x'.repeat(3001) }, { endpointId: f.eps.slack.id, text: 'Work', mentionIds: ['U1', 'U1'] }]) {
      await expect(send(f, 'invalid', args)).rejects.toThrow();
    }
    f.store.recordInbound(f.message('telegram', 'known-no-name', { sender: { id: '456', name: 'Peer', isBot: true }, contextOnly: true }));
    await expect(send(f, 'missing-username', { endpointId: f.eps.telegram.id, text: 'Work', mentionIds: ['456'] })).rejects.toThrow(/проверенного адреса/);
    expect(f.store.listDeliveries()).toEqual([]);
  });

  it('does not add a final outbound after an explicit tool send and exact NOREPLY', async () => {
    const f = toolsFixture();
    const request = await acceptRequest(f, 'telegram'); await running(f, request);
    const receipt = await send(f); await f.engine.settled();
    f.codex.complete(request.id, 'NOREPLY'); await f.engine.settled(); await f.engine.pump();
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'completed', suppressedFinal: true });
    expect(f.store.listDeliveries()).toEqual([expect.objectContaining({ id: receipt.operationId, kind: 'message', status: 'sent' })]);
    expect(f.telegram.deliver).not.toHaveBeenCalled();
    expect(f.slack.deliver).toHaveBeenCalledOnce();
  });
});

describe('Engine bot-origin group controls', () => {
  async function botRequest(f: ReturnType<typeof fixture>) {
    f.store.setSourceAccess(f.eps.telegram.id, { mode: 'all' });
    await f.engine.receive(f.message('telegram', 'bot-task', { sender: { id: '777', name: 'Peer agent', isBot: true }, text: 'Check this' }));
    await f.engine.settled();
    return f.store.listRequests()[0];
  }
  const action = (f: ReturnType<typeof fixture>, approval: Approval, extra: Partial<ApprovalAction> = {}): ApprovalAction => ({
    approvalId: approval.id, decision: 'accept', platform: 'telegram', accountId: f.eps.telegram.accountId,
    chatId: f.eps.telegram.chatId, threadId: f.eps.telegram.threadId, senderId: '456', senderIsBot: false, ...extra });

  it.each(['accept', 'decline'] as const)('allows another verified human in the same group to %s an agent request', async decision => {
    const f = fixture();
    const request = await botRequest(f);
    const approval = await requestApproval(f, request);
    await f.engine.action(action(f, approval, { decision }));
    expect(f.store.getApproval(approval.id)).toMatchObject({ status: 'answered', decision });
    expect(f.codex.respond).toHaveBeenCalledWith(approval.rpcId, { decision });
  });

  it.each([{ senderIsBot: undefined }, { senderIsBot: true }, { senderId: '777', senderIsBot: true },
    { accountId: 'other' }, { chatId: '-other' }, { threadId: 'other' }, { platform: 'slack' as const }])('denies unverified/bot/foreign actors: %j', async patch => {
    const f = fixture();
    const request = await botRequest(f);
    const approval = await requestApproval(f, request);
    await expect(f.engine.action(action(f, approval, patch))).rejects.toThrow(/недоступно/);
    expect(f.store.getApproval(approval.id)?.status).toBe('pending');
    expect(f.codex.respond).not.toHaveBeenCalled();
  });

  it('accepts a verified group human clarification and consumes a bot reply without authorizing or queuing it', async () => {
    const f = fixture();
    const request = await botRequest(f);
    const approval = await requestApproval(f, request, true);
    const delivery = f.store.listDeliveries().find(row => row.approvalId === approval.id)!;
    await f.engine.receive(f.message('telegram', 'bot-answer', { text: 'main', sender: { id: '777', name: 'Peer agent', isBot: true }, replyToMessageId: delivery.remoteMessageId }));
    expect(f.store.getApproval(approval.id)?.status).toBe('pending');
    expect(f.store.listRequests()).toHaveLength(1);
    await f.engine.receive(f.message('telegram', 'human-answer', { text: 'main', sender: { id: '456', name: 'Another human', isBot: false }, replyToMessageId: delivery.remoteMessageId }));
    expect(f.codex.respond).toHaveBeenCalledWith(approval.rpcId, { answers: { target: { answers: ['main'] } } });
  });

  it('keeps a new addressed Slack agent task queued while another agent awaits clarification', async () => {
    const f = fixture();
    f.store.setSourceAccess(f.eps.slack.id, { mode: 'mention' });
    await f.engine.receive(slackInbound(f, 'first-agent', '170001.000001', '<@bot-user> First task', {
      sender: { id: 'UFIRST', name: 'First agent', isBot: true }, directMention: true,
    }));
    await f.engine.settled();
    const request = f.store.listRequests()[0];
    const approval = await requestApproval(f, request, true);
    const text = '<@bot-user> Separate task';
    await f.engine.receive(slackInbound(f, 'second-agent', '170002.000001', text, {
      sender: { id: 'USECOND', name: 'Second agent', isBot: true }, directMention: true,
    }));
    await f.engine.settled();
    expect(f.store.getApproval(approval.id)?.status).toBe('pending');
    expect(f.store.getRequest(request.id)?.status).toBe('waiting_approval');
    expect(f.codex.respond).not.toHaveBeenCalled();
    expect(f.store.listRequests()).toHaveLength(2);
    expect(f.store.listRequests().find(row => row.id !== request.id)).toMatchObject({
      status: 'queued', text, origin: { senderId: 'USECOND', senderIsBot: true },
    });
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
  });

  it('allows only a verified same-group human to cancel an agent request and deduplicates the command', async () => {
    const f = fixture();
    const request = await botRequest(f);
    await running(f, request);
    for (const sender of [{ id: '777', name: 'Agent', isBot: true }, { id: '456', name: 'Unknown' }]) {
      await f.engine.receive(f.message('telegram', `denied-${sender.id}`, { text: '/rele_cancel', sender }));
    }
    expect(f.codex.interrupt).not.toHaveBeenCalled();
    const command = f.message('telegram', 'human-cancel', { text: '/rele_cancel@TestBot', sender: { id: '456', name: 'Another human', isBot: false } });
    await f.engine.receive(command); await f.engine.settled();
    await f.engine.receive(command);
    expect(f.codex.interrupt).toHaveBeenCalledTimes(1);
    expect(f.store.getRequest(request.id)?.status).toBe('interrupted');
  });

  it('retains sender-only controls for human-origin requests', async () => {
    const f = fixture();
    const request = await acceptRequest(f, 'telegram');
    const approval = await requestApproval(f, request);
    await expect(f.engine.action(action(f, approval))).rejects.toThrow(/недоступно/);
    expect(f.codex.respond).not.toHaveBeenCalled();
  });

  it('does not let a repeated or delayed native Stop for an agent request reach the next request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(200_000);
    const f = fixture();
    f.store.setSourceAccess(f.eps.slack.id, { mode: 'all' });
    const sender = { id: 'UAGENT', name: 'Peer agent', isBot: true };
    await f.engine.receive(slackInbound(f, 'first-agent', '199.000001', 'First task', { sender }));
    await f.engine.settled();
    const request = f.store.listRequests()[0];
    await running(f, request);
    const control = f.message('slack', 'agent-stop', { control: 'stop', messageId: '200.500000', text: '', sender: { id: 'UOTHERHUMAN', name: 'Human', isBot: false } });
    await f.engine.receive(control); await f.engine.settled();
    expect(f.codex.interrupt).toHaveBeenCalledTimes(1);
    vi.setSystemTime(203_000);
    await f.engine.receive(slackInbound(f, 'second-agent', '202.900000', 'Second task', { sender }));
    await f.engine.settled();
    const next = f.store.listRequests().find(row => row.id !== request.id)!;
    await running(f, next, 'turn-2');
    await f.engine.receive(control);
    await f.engine.receive({ ...control, eventId: 'delayed-agent-stop' });
    await f.engine.settled();
    expect(f.codex.interrupt).toHaveBeenCalledTimes(1);
    expect(f.store.getRequest(next.id)?.status).toBe('running');
  });
});

describe('Engine native Rele MCP message approvals', () => {
  const params = (f: ReturnType<typeof fixture>, text = 'Send this exact text') => ({
    threadId: THREAD, turnId: 'turn-1', serverName: 'rele', mode: 'form',
    message: 'Native approval', requestedSchema: { type: 'object', properties: {} },
    _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { endpointId: f.eps.slack.id, text } },
  });
  async function prepare(f: ReturnType<typeof fixture>, agent = false) {
    f.config.slack.enabled = true;
    f.store.setSourceAccess(f.eps.slack.id, { mode: 'all' });
    if (agent) {
      await f.engine.receive(slackInbound(f, 'agent-mcp', '170001.000001', 'Agent task', { sender: { id: 'UAGENT', name: 'Agent', isBot: true } }));
      await f.engine.settled();
    } else await acceptRequest(f);
    const request = f.store.listRequests()[0]; await running(f, request); return request;
  }
  const action = (f: ReturnType<typeof fixture>, approval: Approval, decision: 'accept' | 'decline', patch: Partial<ApprovalAction> = {}): ApprovalAction => ({
    approvalId: approval.id, decision, platform: 'slack', accountId: f.eps.slack.accountId, chatId: f.eps.slack.chatId,
    threadId: f.eps.slack.threadId, senderId: 'U1', senderIsBot: false, ...patch,
  });

  it.each(['accept', 'decline'] as const)('forwards only the exact message preview and responds with a one-call MCP %s', async decision => {
    const f = fixture(); f.codex.transport = 'websocket';
    const request = await prepare(f);
    f.codex.request({ id: 'mcp-approval', method: 'mcpServer/elicitation/request', params: {
      ...params(f, 'Hello @unverified'), message: 'Unrelated native detail not forwarded',
      _meta: { ...params(f, 'Hello @unverified')._meta, persist: ['session', 'always'], secret: 'unrelated-secret' },
    } });
    await f.engine.settled();
    const approval = f.store.listApprovals()[0];
    expect(approval).toMatchObject({ method: 'mcpServer/elicitation/request', requestId: request.id, status: 'pending' });
    expect(approval.details).toContain('Team / Infrastructure');
    expect(approval.details).toContain('Hello @\u200bunverified');
    expect(approval.details).not.toMatch(/unrelated|session|always/);
    expect(f.slack.deliver).toHaveBeenCalledWith(expect.objectContaining({ kind: 'approval', approvalId: approval.id }), approval);
    await f.engine.action(action(f, approval, decision));
    expect(f.codex.respond).toHaveBeenCalledExactlyOnceWith('mcp-approval', { action: decision, content: decision === 'accept' ? {} : null, _meta: null });
    expect(f.store.getApproval(approval.id)).toMatchObject({ status: 'answered', decision });
    await expect(f.engine.action(action(f, approval, decision))).rejects.toThrow(/завершено/);
    expect(f.codex.respond).toHaveBeenCalledTimes(1);
  });

  it('allows a verified group human to approve a bot request while refusing agents, unknown people and other sources', async () => {
    const f = fixture(); await prepare(f, true);
    f.codex.request({ id: 'agent-mcp-approval', method: 'mcpServer/elicitation/request', params: params(f) });
    await f.engine.settled(); const approval = f.store.listApprovals()[0];
    for (const patch of [{ senderId: 'UAGENT', senderIsBot: true }, { senderId: 'UOTHER', senderIsBot: undefined },
      { accountId: 'other' }, { chatId: 'COTHER' }, { threadId: 'other-thread' }]) {
      await expect(f.engine.action(action(f, approval, 'accept', patch))).rejects.toThrow(/недоступно/);
    }
    expect(f.codex.respond).not.toHaveBeenCalled();
    await f.engine.action(action(f, approval, 'accept', { senderId: 'UOTHER', senderIsBot: false }));
    expect(f.codex.respond).toHaveBeenCalledExactlyOnceWith('agent-mcp-approval', { action: 'accept', content: {}, _meta: null });
  });

  it('requires the entire long message preview before channel approval and still permits immediate decline', async () => {
    const f = fixture(); await prepare(f);
    f.slack.deliver.mockResolvedValueOnce('first-preview').mockRejectedValueOnce(new ChannelError('Temporary outage', true));
    f.codex.request({ id: 'long-mcp-approval', method: 'mcpServer/elicitation/request', params: params(f, 'x'.repeat(3000)) });
    await f.engine.settled(); const approval = f.store.listApprovals()[0];
    expect(f.store.listDeliveries().filter(row => row.approvalId === approval.id)).toHaveLength(2);
    expect(f.store.approvalDeliveryProgress(approval.id).complete).toBe(false);
    await expect(f.engine.action(action(f, approval, 'accept'))).rejects.toThrow(/полной доставки/);
    expect(f.codex.respond).not.toHaveBeenCalled();
    await f.engine.action(action(f, approval, 'decline'));
    expect(f.codex.respond).toHaveBeenCalledExactlyOnceWith('long-mcp-approval', { action: 'decline', content: null, _meta: null });
  });

  it.each([
    { mode: 'url', url: 'https://private.example/auth' },
    { serverName: 'another-mcp' },
    { _meta: { codex_approval_kind: 'browser_auth', tool_params: { endpointId: 'slack-endpoint', text: 'private' } } },
    { _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { endpointId: 'slack-endpoint', text: 'private', password: 'secret' } } },
    { _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { endpointId: 'slack-endpoint', text: 'private', mentionIds: null } } },
    { _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { endpointId: 'slack-endpoint', text: 'private', mentionIds: ['UUNKNOWN'] } } },
    { requestedSchema: { type: 'object', properties: { password: { type: 'string' } } } },
    { turnId: null },
  ])('keeps unsupported, uncorrelated or secret elicitation out of the source: %j', async patch => {
    const f = fixture(); await prepare(f);
    f.codex.request({ id: 'unsupported-mcp', method: 'mcpServer/elicitation/request', params: { ...params(f), ...patch } });
    await f.engine.settled();
    expect(f.store.listApprovals()).toEqual([]);
    expect(f.slack.deliver).not.toHaveBeenCalled();
    expect(f.codex.respond).not.toHaveBeenCalled();
    expect(f.codex.rejectRequest).toHaveBeenCalledWith('unsupported-mcp', expect.any(String));
  });
});

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
    expect(f.codex.enqueue).toHaveBeenCalledExactlyOnceWith(THREAD, requestInput(request), request.id);
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

  it('holds an off Slack source until full backfill while another origin in the same conversation proceeds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture();
    f.slack.readThreadPage.mockResolvedValueOnce({ messages: [], nextCursor: 'unfinished-history' });
    const task = slackInbound(f, 'off-before-backfill', '170003.000001', 'Original Slack task');
    await f.engine.receive(task); await f.engine.settled();
    const request = f.store.listRequests()[0]; const origin = request.origin;
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    f.store.setSourceAccess(f.eps.slack.id, { mode: 'off' });
    f.slack.readThreadPage.mockClear();
    vi.setSystemTime(Date.now() + 1501);
    await f.engine.pump(); await f.engine.settled();
    expect(f.slack.readThreadPage).not.toHaveBeenCalled();
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'queued', origin,
      error: 'Источник выключен. Включите его для проверки полного контекста или отмените принятый запрос.' });
    const telegram = await acceptRequest(f, 'telegram', 'later-origin');
    expect(f.codex.enqueue).toHaveBeenCalledExactlyOnceWith(THREAD, requestInput(telegram), telegram.id);
    expect(f.store.getRequest(request.id)?.status).toBe('queued');
    await running(f, telegram);
    f.codex.complete(telegram.id, 'Telegram finished'); await f.engine.settled();
    const root = slackInbound(f, 'history-root', f.eps.slack.threadId, 'Previously unverified root').slack!;
    f.slack.readThreadPage.mockResolvedValueOnce({ messages: [root], nextCursor: 'full-second-page' }).mockResolvedValueOnce({ messages: [] });
    f.store.setSourceAccess(f.eps.slack.id, { mode: 'all' });
    vi.setSystemTime(Date.now() + 1501);
    await f.engine.pump(); await f.engine.settled();
    expect(f.slack.readThreadPage.mock.calls[0][1]?.oldest).toBeUndefined();
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1501);
    await f.engine.pump(); await f.engine.settled();
    expect(f.codex.enqueue.mock.calls.filter(([, , id]) => id === request.id)).toEqual([[THREAD, requestInput(request), request.id]]);
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'starting', origin, error: undefined });
    const contextIndex = f.codex.injectContext.mock.calls.findIndex(([, , text]) => text.includes(root.text));
    expect(contextIndex).toBeGreaterThanOrEqual(0);
    expect(f.codex.injectContext.mock.invocationCallOrder[contextIndex]).toBeLessThan(f.codex.enqueue.mock.invocationCallOrder[1]);
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
    expect(f.codex.enqueue).toHaveBeenCalledExactlyOnceWith(THREAD, requestInput(request), request.id);
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

  it('steers passive same-source context into a running task without a second turn or later passive replay', async () => {
    const f = fixture(); const request = await acceptRequest(f); await running(f, request);
    const existingContext = f.codex.injectContext.mock.calls.length;
    const passive = slackInbound(f, 'passive-running', '170002.000001', 'New context during execution', { contextOnly: true });
    await f.engine.receive(passive); await f.engine.settled();
    expect(f.codex.injectContext).toHaveBeenCalledTimes(existingContext);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    const [stream] = f.store.listSlackSyncStreams();
    expect(f.codex.steer).toHaveBeenCalledOnce();
    expect(f.codex.steer.mock.calls[0][1]).toContain('New context during execution');
    expect(f.store.listSlackSyncEntries(stream.id).find(entry => entry.messageId === passive.messageId)?.state).toBe('applied');
    f.codex.complete(request.id, 'Finished original task');
    await f.engine.settled(); await f.engine.pump(); await f.engine.settled();
    expect(f.codex.injectContext).toHaveBeenCalledTimes(existingContext);
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
    expect(f.codex.enqueue).toHaveBeenCalledExactlyOnceWith(THREAD, requestInput(second), second.id);
    expect(f.codex.injectContext.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.codex.enqueue.mock.invocationCallOrder[0]);
  });
});


describe('automatic native thread creation', () => {
  function expectInitialThenTask(f: ReturnType<typeof fixture>, nativeId: string, request: ReleRequest) {
    const calls = f.codex.enqueue.mock.calls.filter(call => call[0] === nativeId);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([nativeId, INITIAL_RELE_MESSAGE, expect.any(String)]);
    expect(calls[0][2]).not.toBe(request.id);
    expect(calls[1]).toEqual([nativeId, requestInput(request), request.id]);
    expect(f.store.getRequest(request.id)?.queuedSubmissionId).toBe(`queue-${request.id}`);
    expect(JSON.parse(f.store.getMeta(initialMessageKey(f.codex.status().codexHome, nativeId))!)).toEqual({ applied: true });
  }

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
    gate.resolve('new-native'); await f.engine.settled(); await f.engine.pump(); await f.engine.settled();
    expect(f.codex.createThread).toHaveBeenCalledExactlyOnceWith('/projects/new');
    const conversation = f.store.listConversations().find(row => row.threadId === 'new-native')!;
    const requests = f.store.listRequests().filter(row => row.conversationId === conversation.id);
    expect(requests).toHaveLength(2);
    expect(requests.every(row => row.origin.endpointId === f.endpoint.id && row.origin.threadId === '99')).toBe(true);
    expectInitialThenTask(f, 'new-native', requests.find(request => request.queuedSubmissionId)!);
    expect(f.store.listAutoLinkIntents()[0]).toMatchObject({ status: 'completed', threadId: 'new-native' });
    await f.engine.receive(f.incoming()); await f.engine.settled();
    expect(f.codex.createThread).toHaveBeenCalledOnce();
    expect(f.store.listRequests()).toHaveLength(2);
  });

  it('creates only the explicitly selected source after its access is enabled, without a chat-wide rule', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(); const endpoint = { ...f.eps.slack, id: 'source-auto', threadId: '170010.000001' };
    f.store.upsertEndpoint(endpoint); f.config.slack.enabled = true;
    f.store.routeSource(endpoint.id, null, '/source/project');
    await f.engine.receive(slackInbound(f, 'off-source', '170010.000002', 'ignored trigger', { endpoint })); await f.engine.settled();
    expect(f.codex.createThread).not.toHaveBeenCalled();
    f.store.setSourceAccess(endpoint.id, { mode: 'mention', allowedSenderIds: [] });
    const sender = { id: 'UAGENT', name: 'Agent', isBot: true };
    await f.engine.receive(slackInbound(f, 'plain-source', '170010.000003', 'not a trigger', { endpoint, sender })); await f.engine.settled();
    expect(f.codex.createThread).not.toHaveBeenCalled();
    await f.engine.receive(slackInbound(f, 'called-source', '170010.000004', 'authorized task', { endpoint, sender, directMention: true })); await f.engine.settled();
    for (let scan = 0; scan < 4 && !f.store.listRequests()[0]?.queuedSubmissionId; scan++) {
      vi.setSystemTime(Date.now() + 2000); await f.engine.pump(); await f.engine.settled();
    }
    expect(f.codex.createThread).toHaveBeenCalledExactlyOnceWith('/source/project');
    expect(f.store.listRequests()).toHaveLength(1);
    const request = f.store.listRequests()[0];
    expect(request).toMatchObject({ text: 'authorized task', origin: { endpointId: endpoint.id, senderId: sender.id } });
    expectInitialThenTask(f, 'auto-created-thread', request);
    expect(f.config.autoLinkRules).toEqual([]);
    expect(f.store.getSourceRoute(f.eps.slack.id).mode).toBe('manual');
  });

  it('keeps approvals and cancellation available for accepted requests after the source is off', async () => {
    const f = fixture(); const request = await acceptRequest(f, 'telegram');
    f.store.setSourceAccess(f.eps.telegram.id, { mode: 'off' });
    const approval = await requestApproval(f, request, true);
    const delivery = f.store.listDeliveries().find(value => value.approvalId === approval.id)!;
    await f.engine.receive(f.message('telegram', 'off-approval', { text: 'main', replyToMessageId: delivery.remoteMessageId }));
    await f.engine.settled();
    expect(f.codex.respond).toHaveBeenCalledWith(approval.rpcId, { answers: { target: { answers: ['main'] } } });
    await f.engine.receive(f.message('telegram', 'off-new-task'));
    await f.engine.receive(f.message('telegram', 'off-cancel', { text: '/rele_cancel' }));
    await f.engine.settled();
    expect(f.store.listRequests()).toHaveLength(1);
    expect(f.codex.enqueue).toHaveBeenCalledOnce();
    expect(f.codex.interrupt).toHaveBeenCalledWith(THREAD, 'turn-1');
  });

  it('waits for a supported connected runtime before making a durable creation attempt', async () => {
    const f = autoFixture(); f.codex.verifiedVersion = false;
    await f.engine.receive(f.incoming()); await f.engine.settled();
    expect(f.codex.createThread).not.toHaveBeenCalled();
    expect(f.store.listAutoLinkIntents()[0].status).toBe('pending');
    f.codex.verifiedVersion = true; await f.engine.pump();
    expect(f.codex.createThread).toHaveBeenCalledOnce();
  });

  it('keeps an accepted inherited-profile intent pending after restart into another profile', async () => {
    const profileA = mkdtempSync(join(tmpdir(), 'rele-profile-A-')), profileB = mkdtempSync(join(tmpdir(), 'rele-profile-B-'));
    directories.push(profileA, profileB);
    vi.stubEnv('CODEX_HOME', profileA);
    const f = autoFixture(); f.codex.connected = false;
    await f.engine.receive(f.incoming()); await f.engine.settled();
    const intent = f.store.listAutoLinkIntents()[0];
    expect(intent.status).toBe('pending');
    await f.engine.stop(); f.store.close(); fixtures.splice(fixtures.findIndex(row => row.engine === f.engine), 1);

    vi.stubEnv('CODEX_HOME', profileB);
    const restarted = fixture({ path: f.path });
    restarted.config.telegram.enabled = true;
    restarted.config.autoLinkRules = f.config.autoLinkRules;
    expect(restarted.engine.targetFingerprint()).not.toBe(intent.targetFingerprint);
    await restarted.engine.pump(); await restarted.engine.settled();
    expect(restarted.store.listAutoLinkIntents()[0]).toMatchObject({ status: 'pending', targetFingerprint: intent.targetFingerprint });
    expect(restarted.codex.createThread).not.toHaveBeenCalled();
    expect(restarted.codex.enqueue).not.toHaveBeenCalled();
    expect(restarted.store.bindingForEndpoint(f.endpoint.id)).toBeUndefined();

    vi.stubEnv('CODEX_HOME', profileA);
    await restarted.engine.pump(); await restarted.engine.settled();
    expect(restarted.codex.createThread).toHaveBeenCalledExactlyOnceWith(intent.rule.cwd);
    expectInitialThenTask(restarted, 'auto-created-thread', restarted.store.listRequests()[0]);
  });

  it('keeps inherited profile aliases and later native directory creation on the same fingerprint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rele-profile-alias-'));
    directories.push(directory);
    const physical = join(directory, 'physical'), alias = join(directory, 'alias');
    mkdirSync(physical);
    symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    vi.stubEnv('CODEX_HOME', join(alias, 'new', 'profile'));
    const f = autoFixture(); f.codex.connected = false;
    await f.engine.receive(f.incoming()); await f.engine.settled();
    const fingerprint = f.engine.targetFingerprint();
    mkdirSync(join(physical, 'new', 'profile'), { recursive: true });
    vi.stubEnv('CODEX_HOME', join(physical, 'new', 'profile'));
    expect(f.engine.targetFingerprint()).toBe(fingerprint);
    f.codex.connected = true;
    await f.engine.pump(); await f.engine.settled();
    expect(f.codex.createThread).toHaveBeenCalledOnce();
    expectInitialThenTask(f, 'auto-created-thread', f.store.listRequests()[0]);
    expect(f.config.codex).not.toHaveProperty('codexHome');
  });

  it.each(['managed', 'proxy', 'websocket', 'explicit-shared'] as const)('preserves existing raw target fingerprints for %s', target => {
    const f = fixture();
    f.config.codex = { transport: target === 'explicit-shared' ? 'shared' : target, executable: 'codex', endpoint: '',
      ...(target === 'explicit-shared' ? { codexHome: join(dirname(f.path), 'explicit-profile') } : {}) };
    const { transport, executable, endpoint, codexHome } = f.config.codex;
    const expected = createHash('sha256').update(JSON.stringify([transport, executable, endpoint, codexHome ?? null])).digest('hex');
    vi.stubEnv('CODEX_HOME', '/inherited/profile-A');
    expect(f.engine.targetFingerprint()).toBe(expected);
    vi.stubEnv('CODEX_HOME', '/inherited/profile-B');
    expect(f.engine.targetFingerprint()).toBe(expected);
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

  it('creates from an unmentioned allowed Slack human DM and returns the answer to its original DM root', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture();
    const human = { id: 'U1', name: 'Allowed human' };
    const bot = { id: 'UPEERBOT', name: 'Peer bot', isBot: true };
    const endpoint = { ...f.eps.slack, id: 'auto-slack-dm', chatId: 'DPRIVATE', threadId: '170010.000001', people: [human, bot] };
    const nativeId = 'auto-slack-dm-native';
    f.codex.createThread.mockResolvedValue(nativeId);
    f.store.upsertEndpoint(endpoint);
    f.config.slack.enabled = true;
    f.config.autoLinkRules = [{ id: 'slack-human-dm', enabled: true, platform: 'slack', accountId: endpoint.accountId,
      chatId: endpoint.chatId, cwd: '/projects/slack-dm', allowedSenderIds: [human.id, bot.id], requireMention: true }];
    await f.engine.receive(slackInbound(f, 'bot-dm', '170010.000002', 'Bot must not create a conversation', { endpoint, sender: bot, directMention: true }));
    await f.engine.settled();
    expect(f.codex.createThread).not.toHaveBeenCalled();
    expect(f.store.listAutoLinkIntents()).toEqual([]);
    expect(f.store.listRequests()).toEqual([]);

    const incoming = slackInbound(f, 'human-dm', '170010.000003', 'Please check the project', { endpoint, sender: human, directMention: false });
    await f.engine.receive(incoming); await f.engine.settled();
    for (let scan = 0; scan < 4 && !f.store.listRequests()[0]?.queuedSubmissionId; scan++) {
      vi.setSystemTime(Date.now() + 2000); await f.engine.pump(); await f.engine.settled();
    }
    expect(f.codex.createThread).toHaveBeenCalledExactlyOnceWith('/projects/slack-dm');
    const conversation = f.store.listConversations().find(row => row.threadId === nativeId)!;
    const request = f.store.listRequests()[0];
    const origin = { platform: 'slack', accountId: endpoint.accountId, endpointId: endpoint.id, chatId: 'DPRIVATE',
      threadId: endpoint.threadId, senderId: human.id, senderName: human.name, messageId: incoming.messageId };
    expect(f.store.listRequests()).toHaveLength(1);
    expect(request).toMatchObject({ conversationId: conversation.id, text: incoming.text, origin });
    expectInitialThenTask(f, nativeId, request);
    expect(f.codex.injectContext.mock.calls.some(([threadId, , text]) => threadId === nativeId && text.includes(incoming.text))).toBe(true);
    expect(f.codex.injectContext.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.codex.enqueue.mock.invocationCallOrder[1]);
    f.codex.locations.set(request.id, { state: 'running', turnId: 'dm-turn' });
    f.codex.notification({ method: 'item/started', params: { threadId: nativeId, turnId: 'dm-turn', item: { type: 'userMessage', clientId: request.id } } });
    await f.engine.settled();
    f.codex.locations.set(request.id, { state: 'completed', turnId: 'dm-turn', text: 'DM answer' });
    f.codex.notification({ method: 'turn/completed', params: { threadId: nativeId, turn: { id: 'dm-turn', status: 'completed' } } });
    await f.engine.settled(); await f.engine.pump();
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'completed', origin });
    expect(f.slack.deliver).toHaveBeenCalledOnce();
    expect(f.slack.deliver.mock.calls[0][0]).toMatchObject({ requestId: request.id, kind: 'answer', body: 'DM answer', origin });
    expect(f.telegram.deliver).not.toHaveBeenCalled();
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

  it('releases an unused lazy thread when a manual binding resolves a failed metadata checkpoint', async () => {
    const f = autoFixture(); f.codex.setThreadName.mockRejectedValueOnce(new CodexTransportError('Lost metadata ACK'));
    await f.engine.receive(f.incoming()); await f.engine.settled();
    expect(f.codex.releaseThread).not.toHaveBeenCalledWith('auto-created-thread');
    f.store.addBinding(f.conversation.id, 'telegram', f.endpoint.id, ['123']);
    await f.engine.pump();
    expect(f.store.bindingForEndpoint(f.endpoint.id)?.conversationId).toBe(f.conversation.id);
    expect(f.codex.releaseThread).toHaveBeenCalledWith('auto-created-thread');
    expect(f.codex.createThread).toHaveBeenCalledOnce();
    expect(f.codex.setThreadName).toHaveBeenCalledOnce();
  });

  it.each(['profile', 'account', 'disabled', 'disconnected', 'unverified'] as const)('keeps explicit recovery pending when the original %s fence changes before promotion', async changed => {
    const f = autoFixture(); f.codex.createThread.mockRejectedValueOnce(new CodexTransportError('Lost create ACK'));
    await f.engine.receive(f.incoming()); await f.engine.settled();
    const intent = f.store.listAutoLinkIntents()[0];
    expect(intent.status).toBe('uncertain');
    f.store.routeSourceToThread(f.endpoint.id, { threadId: 'manually-verified-native', cwd: intent.rule.cwd, name: 'Recovered' }, intent.id, intent.rule);
    const originalConfig = structuredClone(f.config.codex);
    if (changed === 'profile') f.config.codex.codexHome = '/different-profile';
    if (changed === 'account') f.telegram.state.accountId = 'different-account';
    if (changed === 'disabled') f.config.telegram.enabled = false;
    if (changed === 'disconnected') f.codex.connected = false;
    if (changed === 'unverified') f.codex.verifiedVersion = false;
    await f.engine.pump(); await f.engine.settled();
    expect(f.store.getAutoLinkIntent(intent.id)).toMatchObject({ status: 'uncertain', error: expect.stringContaining('исходное подключение') });
    expect(f.store.listRequests()).toEqual([]);
    expect(f.codex.enqueue).not.toHaveBeenCalled();
    expect(f.codex.createThread).toHaveBeenCalledOnce();
    f.config.codex = originalConfig; f.telegram.state.accountId = f.endpoint.accountId;
    f.config.telegram.enabled = true; f.codex.connected = true; f.codex.verifiedVersion = true;
    await f.engine.pump(); await f.engine.settled();
    const request = f.store.listRequests()[0];
    expect(f.store.listRequests()).toHaveLength(1);
    expect(f.store.getAutoLinkIntent(intent.id)?.status).toBe('completed');
    expect(request.origin).toMatchObject({ endpointId: f.endpoint.id, accountId: f.endpoint.accountId, threadId: f.endpoint.threadId });
    expectInitialThenTask(f, 'manually-verified-native', request);
    expect(f.codex.createThread).toHaveBeenCalledOnce();
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

describe('Engine interactive Slack questions', () => {
  async function questionFixture() {
    const f = fixture({ start: false });
    const update = vi.fn<NonNullable<Channel['updateApproval']>>().mockResolvedValue(undefined);
    f.engine.channels.slack = { ...f.slack, updateApproval: update };
    const request = await acceptRequest(f);
    const approval = await requestApproval(f, request, true);
    const prompt = f.store.listDeliveries().find(row => row.approvalId === approval.id)!;
    expect(prompt.status).toBe('sent');
    const context = { approvalId: approval.id, platform: 'slack' as const, accountId: request.origin.accountId,
      chatId: request.origin.chatId, threadId: request.origin.threadId, senderId: request.origin.senderId,
      senderIsBot: false, senderName: 'Alex', messageId: prompt.remoteMessageId };
    return { ...f, request, approval, prompt, context, update };
  }

  it('answers the exact native RPC once and updates only its existing card with the Slack actor', async () => {
    const f = await questionFixture();
    expect(f.engine.question(f.context).id).toBe(f.approval.id);
    await f.engine.action({ ...f.context, decision: 'accept', answers: { target: ['main'] } });
    await f.engine.pump(); await f.engine.settled();
    expect(f.codex.respond).toHaveBeenCalledExactlyOnceWith('approval-rpc', { answers: { target: { answers: ['main'] } } });
    expect(f.update).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: f.prompt.id, remoteMessageId: f.prompt.remoteMessageId }),
      expect.objectContaining({ id: f.approval.id, status: 'answered' }),
      { source: 'slack', senderId: f.context.senderId, senderName: 'Alex', answers: { target: ['main'] } });
    await expect(f.engine.action({ ...f.context, decision: 'accept', answers: { target: ['different'] } })).rejects.toThrow();
    await f.engine.pump();
    expect(f.update).toHaveBeenCalledTimes(1); expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    expect(f.store.listRequests()).toHaveLength(1); expect(f.slack.deliver).toHaveBeenCalledTimes(1);
  });

  it.each(['actor', 'bot', 'account', 'thread', 'message', 'secret', 'turn', 'delivery', 'mixed'] as const)('rejects a stale or mismatched %s before exposing a form or answering', async mismatch => {
    const f = await questionFixture(), context = { ...f.context };
    if (mismatch === 'actor') context.senderId = 'other-human';
    if (mismatch === 'bot') context.senderIsBot = true;
    if (mismatch === 'account') context.accountId = 'other:bot';
    if (mismatch === 'thread') context.threadId = 'other-thread';
    if (mismatch === 'message') context.messageId = 'other-message';
    if (mismatch === 'secret') f.store.updateApproval(f.approval.id, { questions: [{ id: 'target', header: '', question: 'Secret?', isSecret: true }] });
    if (mismatch === 'turn') f.store.updateRequest(f.request.id, { turnId: 'other-turn' });
    if (mismatch === 'delivery') f.store.addDeliveries(f.request.id, [{ key: 'question-extra', ordinal: 1, kind: 'approval', body: 'Not yet sent', approvalId: f.approval.id }]);
    if (mismatch === 'mixed') f.store.setMeta(`mixed:${f.request.id}`, '1');
    expect(() => f.engine.question(context)).toThrow();
    await expect(f.engine.action({ ...context, decision: 'accept', answers: { target: ['main'] } })).rejects.toThrow();
    expect(f.codex.respond).not.toHaveBeenCalled();
  });

  it('closes a card after native resolution without inventing a Slack answer', async () => {
    const f = await questionFixture();
    f.codex.notification({ method: 'serverRequest/resolved', params: { threadId: THREAD, requestId: f.approval.rpcId } });
    await f.engine.settled(); await f.engine.pump();
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ id: f.prompt.id }), expect.objectContaining({ decision: 'resolved_in_codex' }), { source: 'codex' });
    expect(() => f.engine.question(f.context)).toThrow(); expect(f.codex.respond).not.toHaveBeenCalled();
  });

  it('retries a failed known-card update after restart without resending the answer', async () => {
    const f = await questionFixture(); f.update.mockRejectedValue(new ChannelError('Temporary update refusal', true));
    await f.engine.action({ ...f.context, decision: 'accept', answers: { target: ['main'] } });
    await f.engine.pump();
    expect(f.store.resolvedApprovalDeliveries()).toHaveLength(1);
    await f.engine.stop();
    const next = fixture({ path: f.path, start: false });
    const update = vi.fn<NonNullable<Channel['updateApproval']>>().mockResolvedValue(undefined);
    next.engine.channels.slack = { ...next.slack, updateApproval: update };
    await next.engine.pump();
    expect(update).toHaveBeenCalledTimes(1); expect(next.codex.respond).not.toHaveBeenCalled();
    expect(next.store.resolvedApprovalDeliveries()).toEqual([]);
  });

  it('marks an unknown answer send as uncertain and never repeats it', async () => {
    const f = await questionFixture(); f.codex.respond.mockRejectedValueOnce(new Error('Wire closed'));
    await expect(f.engine.action({ ...f.context, decision: 'accept', answers: { target: ['main'] } })).rejects.toThrow();
    await f.engine.pump();
    expect(f.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'expired', decision: 'uncertain' }), expect.anything());
    await expect(f.engine.action({ ...f.context, decision: 'accept', answers: { target: ['main'] } })).rejects.toThrow();
    expect(f.codex.respond).toHaveBeenCalledTimes(1);
  });

  it('expires all pending questions and rejects an older generation even if a native RPC ID is reused', async () => {
    const f = await questionFixture();
    for (let i = 0; i < 1001; i++) f.store.addApproval({ requestId: f.request.id, turnId: 'turn-1', itemId: `history-${i}`,
      rpcId: `history-${i}`, method: 'item/commandExecution/requestApproval', title: 'History', details: '', status: 'answered' });
    const next = new FakeCodex(); next.pendingRequests.add(f.approval.rpcId);
    next.locations.set(f.request.id, { state: 'running', turnId: 'turn-1' });
    f.engine.replaceCodex(next); await f.engine.settled();
    expect(f.store.getApproval(f.approval.id)?.status).toBe('expired');
    f.store.updateApproval(f.approval.id, { status: 'pending' });
    expect(() => f.engine.question(f.context)).toThrow();
    await expect(f.engine.resolveApproval(f.approval.id, 'accept', { target: ['main'] })).rejects.toThrow();
    expect(next.respond).not.toHaveBeenCalled();
  });

  it.each(['completed', 'interrupted'] as const)('closes every known sent question part when the turn is %s', async status => {
    const f = await questionFixture();
    const [extra] = f.store.addDeliveries(f.request.id, [{ key: 'extra-part', ordinal: 1, kind: 'approval', body: 'Extra', approvalId: f.approval.id }]);
    f.store.updateDelivery(extra.id, { status: 'sent', remoteMessageId: 'second-card' });
    f.store.setMeta(`approval-ui-attempted:${f.prompt.id}`, String(Date.now()));
    if (status === 'completed') f.codex.complete(f.request.id, 'Done');
    else await f.engine.cancel(f.request.id);
    await f.engine.settled(); await f.engine.pump();
    expect(f.update).toHaveBeenCalledTimes(2);
    expect(f.update.mock.calls[0][0].id).toBe(extra.id);
    expect(f.update.mock.calls.map(([delivery]) => delivery.id).sort()).toEqual([f.prompt.id, extra.id].sort());
    expect(f.store.resolvedApprovalDeliveries()).toEqual([]);
  });

  it('never stores a secret panel answer for Slack card feedback', async () => {
    const f = await questionFixture();
    f.store.updateApproval(f.approval.id, { questions: [{ id: 'target', header: '', question: 'Secret?', isSecret: true }] });
    await f.engine.resolveApproval(f.approval.id, 'accept', { target: ['synthetic-private-value'] });
    await f.engine.pump();
    expect(f.store.getMeta(`approval-resolution:${f.approval.id}`)).toBe('{"source":"rele"}');
    expect(f.update).toHaveBeenCalledWith(expect.anything(), expect.anything(), { source: 'rele' });
  });

  it.each(['retry', 'resolved', 'retired'] as const)('handles a transient history failure with native question %s', async outcome => {
    const f = fixture({ start: false }), request = await acceptRequest(f); await running(f, request);
    f.codex.findRequest.mockRejectedValueOnce(new Error('Temporary history failure'));
    f.codex.request({ id: 'retry-question', method: 'item/tool/requestUserInput', params: { threadId: THREAD,
      turnId: 'turn-1', itemId: 'question-retry', questions: [{ id: 'target', header: 'Target', question: 'Which branch?' }] } });
    await f.engine.settled();
    expect(f.store.listApprovals()).toEqual([]); expect(f.codex.rejectRequest).not.toHaveBeenCalled();
    if (outcome === 'resolved') { f.codex.notification({ method: 'serverRequest/resolved', params: { threadId: THREAD, requestId: 'retry-question' } }); await f.engine.settled(); }
    if (outcome === 'retired') f.codex.pendingRequests.delete('retry-question');
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000);
    try { await f.engine.pump(); await f.engine.settled(); } finally { now.mockRestore(); }
    expect(f.store.listApprovals()).toHaveLength(outcome === 'retry' ? 1 : 0);
    if (outcome === 'retry') expect(f.store.listDeliveries().some(row => row.body.includes('Which branch?') && row.status === 'sent')).toBe(true);
    expect(f.codex.respond).not.toHaveBeenCalled();
  });
});
