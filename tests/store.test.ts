import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { messageToolOperationId } from '../src/shared/message-tool.js';
import type { Approval, Delivery, Endpoint, InboundMessage, ReleRequest, SlackTranscriptMessage } from '../src/shared/types.js';

const directories: string[] = [];
const stores: Store[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'rele-store-'));
  directories.push(path);
  return path;
}
function open(path = join(directory(), 'rele.sqlite')): Store {
  const store = new Store(path);
  stores.push(store);
  return store;
}
function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return { id: 'slack-1', platform: 'slack', accountId: 'workspace-1', chatId: 'channel-1', threadId: 'thread-1',
    title: '#Infrastructure', subtitle: 'Team / Backup', people: [{ id: 'user-1', name: 'Alex' }],
    updatedAt: new Date().toISOString(), ...overrides };
}
function message(ep = endpoint(), eventId = 'event-1', overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { eventId, endpoint: ep, sender: { id: 'user-1', name: 'Alex' }, messageId: `message-${eventId}`, text: 'Check the backups', ...overrides };
}
function conversation(store: Store, ep = endpoint(), threadId = 'codex-1') {
  store.upsertEndpoint(ep);
  return store.createConversation({ name: 'Infrastructure', threadId, cwd: '/projects/infra',
    bindings: [{ platform: ep.platform, endpointId: ep.id, allowedSenderIds: ['user-1'] }] });
}
function request(store: Store, ep = endpoint(), eventId = 'event-1'): ReleRequest {
  const result = store.ingest(message(ep, eventId));
  expect(result.request).not.toBeNull();
  return result.request!;
}
function approvalInput(requestId: string): Omit<Approval, 'id' | 'status' | 'createdAt' | 'updatedAt'> {
  return { requestId, turnId: 'turn-1', itemId: 'item-1', rpcId: 10, method: 'item/commandExecution/requestApproval',
    title: 'Approve command', details: 'Run the backup check?' };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Store inbox and bindings', () => {
  it('snapshots only observed authors of this thread, preserving old snapshots across replay and restart', () => {
    const path = join(directory(), 'participants.sqlite');
    const store = open(path);
    const ep = endpoint({ people: [{ id: 'CHANNEL', name: 'Channel member' }] });
    conversation(store, ep);
    const first = store.ingest(message(ep, 'first', { messageId: '10.000001', text: '<@BOT> original', sender: { id: 'user-1', name: 'Alex', isBot: false } })).request!;
    expect(first.origin.participants).toEqual([{ id: 'user-1', name: 'Alex', isBot: false }]);
    store.recordInbound(message(ep, 'later', { messageId: '30.000001', sender: { id: 'BOT', name: 'Agent', isBot: true } }));
    const second = store.ingest(message(ep, 'second', { messageId: '40.000001' })).request!;
    expect(second.origin.participants?.map(person => person.id)).toEqual(['user-1', 'BOT']);
    store.recordSlackMessage({ endpointId: ep.id, accountId: ep.accountId, chatId: ep.chatId, threadId: ep.threadId,
      messageId: '5.000001', sender: { id: 'OLD', name: 'Old participant', isBot: true }, text: 'backfill', payload: {}, kind: 'message' });
    expect(store.getRequest(first.id)?.origin.participants).toEqual(first.origin.participants);
    expect(store.getRequest(first.id)?.text).toBe('<@BOT> original');
    const stream = store.listSlackSyncStreams()[0];
    expect(store.listSlackSyncEntries(stream.id).find(entry => entry.messageId === '5.000001')?.message.participants?.map(person => person.id)).toEqual(['OLD']);
    store.upsertEndpoint({ ...ep, people: [{ id: 'OTHER', name: 'Another channel member' }] });
    expect(store.ingest(message(ep, 'first', { sender: { id: 'FORGED', name: 'Changed replay', isBot: true } })).request?.origin).toEqual(first.origin);
    const another = { ...ep, id: 'another-thread', threadId: 'different' };
    store.recordInbound(message(another, 'other-thread', { sender: { id: 'STRANGER', name: 'Other thread' } }));
    expect(store.rememberThreadParticipant(ep.id, { id: 'user-1', name: 'Alex' }, '50.000001').map(person => person.id)).toEqual(['user-1', 'BOT', 'OLD']);
    expect(store.rememberThreadParticipant(ep.id, { id: 'slack:unknown', name: 'Unknown sender' }, '60.000001').map(person => person.id)).toEqual(['user-1', 'BOT', 'OLD']);
    store.close();
    expect(open(path).getRequest(first.id)?.origin).toEqual(first.origin);
  });

  it('deduplicates by platform, account and event, preserving the original request', () => {
    const store = open();
    const slack = endpoint();
    const conv = conversation(store, slack);
    const telegram = endpoint({ id: 'telegram-1', platform: 'telegram', accountId: slack.accountId });
    store.upsertEndpoint(telegram);
    store.setBinding(conv.id, 'telegram', telegram.id, ['user-1']);
    const otherSlack = endpoint({ id: 'slack-2', accountId: 'workspace-2' });
    conversation(store, otherSlack, 'codex-2');

    const original = request(store, slack);
    const replay = store.ingest(message(slack, 'event-1', { text: 'Changed replay', sender: { id: 'attacker', name: 'Alex' } }));
    expect(replay).toEqual({ request: original, duplicate: true });
    expect(request(store, telegram).id).not.toBe(original.id);
    expect(request(store, otherSlack).id).not.toBe(original.id);
    expect(store.listRequests()).toHaveLength(3);
  });

  it('requires an active binding and an explicit allowed sender, and does not replay ignored events', () => {
    const store = open();
    const ep = endpoint();
    expect(store.ingest(message(ep, 'unbound')).request).toBeNull();
    const conv = conversation(store, ep);
    expect(store.ingest(message(ep, 'unbound'))).toEqual({ request: null, duplicate: true });

    store.setBinding(conv.id, 'slack', ep.id, []);
    expect(store.ingest(message(ep, 'empty-allowlist')).request).toBeNull();
    store.setBinding(conv.id, 'slack', ep.id, ['user-1']);
    expect(store.ingest(message(ep, 'empty-allowlist'))).toEqual({ request: null, duplicate: true });
    expect(store.ingest(message(ep, 'wrong-sender', { sender: { id: 'someone-else', name: 'Alex' } })).request).toBeNull();

    const accepted = request(store, ep, 'allowed');
    store.updateConversation(conv.id, { paused: true });
    expect(store.ingest(message(ep, 'paused')).request).toBeNull();
    expect(store.claimNextRequest(conv.id)).toBeUndefined();
    expect(store.getRequest(accepted.id)?.status).toBe('queued');
    store.updateConversation(conv.id, { paused: false });
    expect(store.claimNextRequest(conv.id)?.id).toBe(accepted.id);
    store.removeBinding(conv.id, store.getConversation(conv.id)!.bindings.find(binding => binding.platform === 'slack')!.id);
    expect(store.ingest(message(ep, 'removed')).request).toBeNull();
  });

  it('enforces unique endpoints and server threads, and atomically creates all bindings', () => {
    const store = open();
    const ep = endpoint();
    const first = conversation(store, ep);
    expect(() => store.createConversation({ name: 'Duplicate thread', threadId: first.threadId, cwd: '/elsewhere' })).toThrow(/UNIQUE/);
    const second = store.createConversation({ name: 'Another', threadId: 'codex-2', cwd: '/elsewhere' });
    expect(() => store.setBinding(second.id, 'slack', ep.id, ['user-1'])).toThrow(/UNIQUE/);
    expect(() => store.setBinding(second.id, 'telegram', ep.id, ['user-1'])).toThrow(/platform/);
    expect(() => store.upsertEndpoint({ ...ep, chatId: 'other-chat' })).toThrow(/identity/);

    const freeEndpoint = endpoint({ id: 'slack-free', chatId: 'free-channel' });
    store.upsertEndpoint(freeEndpoint);
    expect(() => store.createConversation({ name: 'Rollback', threadId: 'rollback-thread', cwd: '/project', bindings: [
      { platform: 'slack', endpointId: freeEndpoint.id, allowedSenderIds: ['user-1'] },
      { platform: 'telegram', endpointId: 'missing-endpoint', allowedSenderIds: ['user-1'] },
    ] })).toThrow(/Endpoint not found/);
    expect(store.listConversations()).toHaveLength(2);
    expect(store.setBinding(second.id, 'slack', freeEndpoint.id, ['user-1']).endpointId).toBe(freeEndpoint.id);
    expect(store.getConversation(first.id)?.bindings[0].endpointId).toBe(ep.id);
  });

  it('rolls back the inbox event and endpoint changes when creating the request fails', () => {
    const store = open();
    const ep = endpoint();
    conversation(store, ep);
    expect(() => store.ingest(message({ ...ep, title: 'Uncommitted title' }, 'rollback-event', { text: undefined as unknown as string }))).toThrow();
    expect(store.getEndpoint(ep.id)?.title).toBe(ep.title);
    expect(store.listRequests()).toHaveLength(0);
    expect(store.ingest(message(ep, 'rollback-event')).duplicate).toBe(false);
  });

  it('records approval replies durably without ever creating a new request on replay', () => {
    const path = join(directory(), 'rele.sqlite');
    const store = open(path);
    conversation(store);
    const reply = message(endpoint(), 'approval-reply', { text: 'main', replyToMessageId: 'approval-message' });
    expect(store.recordInbound(reply)).toEqual({ duplicate: false });
    expect(store.listRequests()).toHaveLength(0);
    store.close();
    const reopened = open(path);
    expect(reopened.recordInbound(reply)).toEqual({ duplicate: true });
    expect(reopened.ingest(reply)).toEqual({ duplicate: true, request: null });
  });

  it('keeps the request and delivery origin when endpoints are renamed or bindings move', () => {
    const store = open();
    const ep = endpoint();
    const conv = conversation(store, ep);
    const original = request(store, ep);
    store.upsertEndpoint({ ...ep, title: '#Renamed', people: [{ id: 'user-2', name: 'Colleague' }] });
    store.upsertEndpoint({ ...ep, title: '#Renamed', people: [{ id: 'user-1', name: 'New display name' }] });
    expect(store.getEndpoint(ep.id)?.people).toEqual([{ id: 'user-1', name: 'New display name' }, { id: 'user-2', name: 'Colleague' }]);
    const replacement = endpoint({ id: 'replacement', chatId: 'replacement-channel' });
    store.upsertEndpoint(replacement);
    store.setBinding(conv.id, 'slack', replacement.id, ['user-1']);
    const [delivery] = store.addDeliveries(original.id, [{ key: 'answer:0', ordinal: 0, kind: 'answer', body: 'Backups are healthy' }]);
    expect(store.getRequest(original.id)?.origin).toEqual(original.origin);
    expect(delivery.origin).toEqual(original.origin);
    expect(() => store.updateRequest(original.id, { origin: { ...original.origin, chatId: 'hijack' } } as unknown as Partial<ReleRequest>)).toThrow(/immutable/);
    expect(() => store.updateDelivery(delivery.id, { origin: { ...original.origin, chatId: 'hijack' } } as unknown as Partial<Delivery>)).toThrow(/immutable/);
  });
});

describe('Store queues and approvals', () => {
  it('keeps tool messages independent, deduplicated and scoped across a crash without replaying an uncertain send', () => {
    const path = join(directory(), 'tool-outbox.sqlite'), store = open(path), ep = endpoint();
    const conv = conversation(store, ep);
    const input = { threadId: conv.threadId, callId: 'native-call', conversationId: conv.id,
      origin: { platform: ep.platform, accountId: ep.accountId, endpointId: ep.id, chatId: ep.chatId, threadId: ep.threadId,
        senderId: 'OWNBOT', senderName: 'Own agent', senderIsBot: true, messageId: '' }, arguments: { endpointId: ep.id, text: 'Work', mentionIds: [] }, text: 'Work', mentions: [] };
    const message = store.addToolMessage(input);
    expect(message).toMatchObject({ id: messageToolOperationId(conv.threadId, 'native-call'), kind: 'message', status: 'pending', operationId: message.id });
    expect(message.requestId).toBeUndefined();
    expect(store.listRequests()).toEqual([]);
    expect(store.addToolMessage({ ...input, arguments: { mentionIds: [], text: 'Work', endpointId: ep.id } }).id).toBe(message.id);
    expect(() => store.addToolMessage({ ...input, arguments: { ...input.arguments, text: 'Different' }, text: 'Different' })).toThrow(/другими аргументами/);
    expect(store.toolMessageStatus('foreign-thread', message.id)).toBeUndefined();
    expect(store.claimDelivery()).toMatchObject({ id: message.id, kind: 'message', status: 'sending', attempts: 1 });
    store.close();
    const restarted = open(path);
    expect(restarted.recoverInterrupted()).toEqual({ requests: 0, deliveries: 1 });
    expect(restarted.claimDelivery()).toBeUndefined();
    expect(restarted.addToolMessage(input)).toMatchObject({ id: message.id, status: 'uncertain', attempts: 1 });
    expect(restarted.listDeliveries()).toHaveLength(1);
  });

  it('commits a confirmed own Telegram post and its passive receipt atomically', () => {
    const store = open(), ep = endpoint({ id: 'telegram-own', platform: 'telegram', accountId: '999', chatId: '-100', threadId: '7' });
    const conv = conversation(store, ep), sender = { id: '999', name: 'Own agent', isBot: true };
    const operation = store.addToolMessage({ threadId: conv.threadId, callId: 'own-post', conversationId: conv.id,
      origin: { platform: 'telegram', accountId: ep.accountId, endpointId: ep.id, chatId: ep.chatId, threadId: ep.threadId,
        senderId: sender.id, senderName: sender.name, senderIsBot: true, messageId: '' }, arguments: {}, text: 'Report', mentions: [] });
    store.claimDelivery();
    const ownReceipt: InboundMessage = { eventId: `tool-outgoing:${operation.id}`, endpoint: ep, sender, messageId: '500', text: 'Report', contextOnly: true };
    expect(() => store.updateDelivery(operation.id, { status: 'sent', remoteMessageId: '500' }, { ...ownReceipt, text: undefined as unknown as string })).toThrow();
    expect(store.getDelivery(operation.id)?.status).toBe('sending');
    expect(store.listSlackSyncStreams().flatMap(stream => store.listSlackSyncEntries(stream.id))).toEqual([]);
    store.updateDelivery(operation.id, { status: 'sent', remoteMessageId: '500' }, ownReceipt);
    expect(store.getDelivery(operation.id)?.status).toBe('sent');
    expect(store.listRequests()).toEqual([]);
    expect(store.listSlackSyncStreams().flatMap(stream => store.listSlackSyncEntries(stream.id))).toEqual([
      expect.objectContaining({ message: expect.objectContaining({ text: 'Report', sender }), state: 'pending' }),
    ]);
  });

  it('claims requests in FIFO order across connections and only blocks the affected conversation', () => {
    const path = join(directory(), 'rele.sqlite');
    const store = open(path);
    const otherConnection = open(path);
    const conv = conversation(store);
    const first = request(store);
    const second = request(store, endpoint(), 'second');
    const otherEndpoint = endpoint({ id: 'other', chatId: 'other-channel' });
    const otherConv = conversation(store, otherEndpoint, 'other-codex');
    const otherRequest = request(store, otherEndpoint, 'other-event');

    expect(store.claimNextRequest(conv.id)?.id).toBe(first.id);
    expect(otherConnection.claimNextRequest(conv.id)).toBeUndefined();
    expect(otherConnection.claimNextRequest(otherConv.id)?.id).toBe(otherRequest.id);
    store.updateRequest(first.id, { status: 'waiting_approval', queuedSubmissionId: 'queue-1', turnId: 'turn-1' });
    expect(store.claimNextRequest(conv.id)).toBeUndefined();
    store.updateRequest(first.id, { status: 'uncertain' });
    expect(store.claimNextRequest(conv.id)).toBeUndefined();
    expect(store.activeRequests().map((r) => r.id)).toEqual([first.id, second.id, otherRequest.id]);
    expect(store.listPendingRequests().map((r) => r.id)).toEqual([second.id]);
    store.updateRequest(first.id, { status: 'completed', error: undefined });
    expect(otherConnection.claimNextRequest(conv.id)?.id).toBe(second.id);
  });

  it('deduplicates parts per request and preserves FIFO across batches whose ordinals restart', () => {
    const store = open();
    conversation(store);
    const req = request(store);
    const parts: Array<Pick<Delivery, 'key' | 'ordinal' | 'kind' | 'body'>> = [
      { key: 'answer:1', ordinal: 1, kind: 'answer', body: 'Second part' },
      { key: 'answer:0', ordinal: 0, kind: 'answer', body: 'First part' },
    ];
    const saved = store.addDeliveries(req.id, parts);
    expect(store.addDeliveries(req.id, parts).map((d) => d.id)).toEqual(saved.map((d) => d.id));
    const [last] = store.addDeliveries(req.id, [{ key: 'error:final', ordinal: 0, kind: 'error', body: 'Later batch' }]);
    const first = store.claimDelivery()!;
    expect(first.key).toBe('answer:0');
    expect(first.attempts).toBe(1);
    expect(store.claimDelivery()).toBeUndefined();
    store.updateDelivery(first.id, { status: 'sent', remoteMessageId: 'remote-1' });
    const second = store.claimDelivery()!;
    expect(second.key).toBe('answer:1');
    store.updateDelivery(second.id, { status: 'sent' });
    expect(store.claimDelivery()?.id).toBe(last.id);

    const anotherRequest = request(store, endpoint(), 'another');
    expect(store.addDeliveries(anotherRequest.id, [{ key: 'answer:0', ordinal: 0, kind: 'answer', body: 'Another answer' }])).toHaveLength(1);
    expect(() => store.addDeliveries(req.id, [{ ...parts[1], body: 'Changed content' }])).toThrow(/different content/);
  });

  it('respects retry time and blocks later parts after an uncertain delivery without blocking other requests', () => {
    const store = open();
    conversation(store);
    const req = request(store);
    const [first, second] = store.addDeliveries(req.id, [
      { key: 'answer:0', ordinal: 0, kind: 'answer', body: 'First' },
      { key: 'answer:1', ordinal: 1, kind: 'answer', body: 'Second' },
    ]);
    store.updateDelivery(first.id, { nextAttemptAt: '2100-01-02T00:00:00.000Z' });
    expect(store.claimDelivery('2100-01-01T00:00:00.000Z')).toBeUndefined();
    expect(store.claimDelivery('2100-01-02T00:00:00.000Z')?.id).toBe(first.id);
    store.updateDelivery(first.id, { status: 'uncertain' });
    expect(store.claimDelivery('2100-01-03T00:00:00.000Z')).toBeUndefined();
    expect(store.getDelivery(second.id)?.status).toBe('pending');
    const another = request(store, endpoint(), 'other-event');
    const [otherDelivery] = store.addDeliveries(another.id, [{ key: 'answer:0', ordinal: 0, kind: 'answer', body: 'Independent answer' }]);
    expect(store.claimDelivery()?.id).toBe(otherDelivery.id);
    store.updateDelivery(first.id, { status: 'pending', nextAttemptAt: undefined });
    expect(store.claimDelivery()?.attempts).toBe(2);
  });

  it('rolls back every delivery in a batch when a later SQL constraint fails', () => {
    const store = open();
    conversation(store);
    const req = request(store);
    expect(() => store.addDeliveries(req.id, [
      { key: 'answer:0', ordinal: 0, kind: 'answer', body: 'Should roll back' },
      { key: 'answer:1', ordinal: 1, kind: 'invalid' as Delivery['kind'], body: 'Violates kind constraint' },
    ])).toThrow(/CHECK/);
    expect(store.listDeliveries()).toHaveLength(0);
    expect(store.addDeliveries(req.id, [{ key: 'answer:0', ordinal: 0, kind: 'answer', body: 'Committed' }])).toHaveLength(1);
  });

  it('updates replayed approval RPC IDs without losing the recorded decision or changing its request', () => {
    const store = open();
    conversation(store);
    const req = request(store);
    const approval = store.addApproval(approvalInput(req.id));
    store.updateApproval(approval.id, { status: 'answered', decision: 'accept' });
    const replay = store.addApproval({ ...approvalInput(req.id), rpcId: 'new-rpc-id' });
    expect(replay).toMatchObject({ id: approval.id, rpcId: 'new-rpc-id', status: 'answered', decision: 'accept' });
    expect(store.listApprovals()).toHaveLength(1);
    const another = request(store, endpoint(), 'another');
    expect(() => store.addDeliveries(another.id, [{ key: 'approval:1', ordinal: 0, kind: 'approval', body: 'Approve?', approvalId: approval.id }])).toThrow(/does not belong/);
    expect(store.getApproval(approval.id)?.requestId).toBe(req.id);
  });

  it.each(['pending', 'failed'] as const)('finishes requests atomically with the outbox and cancels a %s approval prompt', status => {
    const store = open();
    conversation(store);
    const req = request(store);
    store.updateRequest(req.id, { status: 'waiting_approval' });
    const pending = store.addApproval(approvalInput(req.id));
    const answered = store.addApproval({ ...approvalInput(req.id), itemId: 'answered-item', status: 'answered', decision: 'accept' });
    const [prompt] = store.addDeliveries(req.id, [{ key: `approval:${pending.id}`, ordinal: 0, kind: 'approval', body: 'Approve?', approvalId: pending.id }]);
    if (status === 'failed') { store.claimDelivery(); store.updateDelivery(prompt.id, { status: 'failed' }); }

    expect(() => store.finishRequest(req.id, { status: 'completed', turnId: 'turn-1' }, [
      { key: 'answer:0', ordinal: 0, kind: 'answer', body: 'Completed' },
      { key: 'answer:1', ordinal: 1, kind: 'invalid' as Delivery['kind'], body: 'Constraint failure' },
    ])).toThrow(/CHECK/);
    expect(store.getRequest(req.id)).toMatchObject({ status: 'waiting_approval', turnId: undefined });
    expect(store.getApproval(pending.id)?.status).toBe('pending');
    expect(store.getDelivery(prompt.id)?.status).toBe(status);
    expect(store.listDeliveries()).toHaveLength(1);

    const parts: Array<Pick<Delivery, 'key' | 'ordinal' | 'kind' | 'body'>> = [{ key: 'answer:0', ordinal: 0, kind: 'answer', body: 'Completed' }];
    expect(store.finishRequest(req.id, { status: 'completed', turnId: 'turn-1' }, parts).status).toBe('completed');
    expect(store.getApproval(pending.id)?.status).toBe('expired');
    expect(store.getApproval(answered.id)).toMatchObject({ status: 'answered', decision: 'accept' });
    expect(store.getDelivery(prompt.id)).toMatchObject({ status: 'cancelled', attempts: status === 'failed' ? 1 : 0 });
    expect(store.claimDelivery()?.key).toBe('answer:0');
    store.finishRequest(req.id, { status: 'completed' }, parts);
    expect(store.listDeliveries()).toHaveLength(2);
    expect(() => store.finishRequest(req.id, { status: 'failed', error: 'Must roll back' }, [{ ...parts[0], body: 'Changed duplicate' }])).toThrow(/different content/);
    expect(store.getRequest(req.id)).toMatchObject({ status: 'completed', error: undefined });
  });

  it('preserves sending and uncertain approval deliveries when a request finishes', () => {
    const store = open();
    conversation(store);
    const req = request(store);
    const firstApproval = store.addApproval(approvalInput(req.id));
    const secondApproval = store.addApproval({ ...approvalInput(req.id), itemId: 'another-item' });
    const [sending, uncertain] = store.addDeliveries(req.id, [
      { key: 'approval:1', ordinal: 0, kind: 'approval', body: 'First approval', approvalId: firstApproval.id },
      { key: 'approval:2', ordinal: 1, kind: 'approval', body: 'Second approval', approvalId: secondApproval.id },
    ]);
    store.updateDelivery(sending.id, { status: 'sending' });
    store.updateDelivery(uncertain.id, { status: 'uncertain' });
    store.cancelApprovalDeliveries(firstApproval.id);
    store.cancelApprovalDeliveries(secondApproval.id);
    expect(store.getDelivery(sending.id)?.status).toBe('sending');
    expect(store.getDelivery(uncertain.id)?.status).toBe('uncertain');
    store.finishRequest(req.id, { status: 'completed' }, [{ key: 'answer:0', ordinal: 0, kind: 'answer', body: 'Final answer' }]);
    expect(store.getDelivery(sending.id)?.status).toBe('sending');
    expect(store.getDelivery(uncertain.id)?.status).toBe('uncertain');
    expect(store.claimDelivery()).toBeUndefined();
  });

  it('finds an old approval reply only in the exact platform, bot, chat and thread', () => {
    const store = open();
    conversation(store);
    const req = request(store);
    const approval = store.addApproval({ ...approvalInput(req.id), status: 'expired' });
    const [prompt] = store.addDeliveries(req.id, [{ key: `approval:${approval.id}`, ordinal: 0, kind: 'approval', body: 'Old question', approvalId: approval.id }]);
    store.updateDelivery(prompt.id, { status: 'sent', remoteMessageId: '500' });
    expect(store.findReplyApproval(req.origin, '500')?.id).toBe(approval.id);
    expect(store.findReplyApproval(req.origin, '501')).toBeUndefined();
    for (const patch of [{ platform: req.origin.platform === 'telegram' ? 'slack' as const : 'telegram' as const }, { accountId: 'different-bot' }, { chatId: 'different-chat' }, { threadId: 'different-thread' }]) {
      expect(store.findReplyApproval({ ...req.origin, ...patch }, '500')).toBeUndefined();
    }
  });
});

describe('Store durability and recovery', () => {
  it('preserves interrupted states on open and only changes them through explicit recovery', () => {
    const path = join(directory(), 'rele.sqlite');
    const store = open(path);
    const firstConv = conversation(store);
    const running = request(store);
    const queued = request(store, endpoint(), 'queued');
    store.claimNextRequest(firstConv.id);
    store.updateRequest(running.id, { status: 'running', turnId: 'turn-1', queuedSubmissionId: 'submission-1' });

    const audioEndpoint = endpoint({ id: 'audio-endpoint', chatId: 'audio-chat' });
    conversation(store, audioEndpoint, 'audio-codex');
    const audio = request(store, audioEndpoint, 'audio-event');
    store.updateRequest(audio.id, { status: 'transcribing' });
    const approvalEndpoint = endpoint({ id: 'approval-endpoint', chatId: 'approval-chat' });
    conversation(store, approvalEndpoint, 'approval-codex');
    const waiting = request(store, approvalEndpoint, 'approval-event');
    store.updateRequest(waiting.id, { status: 'waiting_approval' });
    store.addDeliveries(running.id, [{ key: 'answer:0', ordinal: 0, kind: 'answer', body: 'Delivery awaiting acknowledgement' }]);
    const sending = store.claimDelivery()!;
    store.setMeta('telegram.offset', '500');
    store.close();

    const reopened = open(path);
    expect(reopened.getRequest(running.id)?.status).toBe('running');
    expect(reopened.getDelivery(sending.id)?.status).toBe('sending');
    expect(reopened.recoverInterrupted()).toEqual({ requests: 2, deliveries: 1 });
    expect(reopened.getRequest(running.id)).toMatchObject({ status: 'uncertain', turnId: 'turn-1', queuedSubmissionId: 'submission-1' });
    expect(reopened.getRequest(audio.id)?.status).toBe('queued');
    expect(reopened.getRequest(waiting.id)?.status).toBe('waiting_approval');
    expect(reopened.getRequest(queued.id)?.status).toBe('queued');
    expect(reopened.getDelivery(sending.id)).toMatchObject({ status: 'uncertain', attempts: 1 });
    expect(reopened.claimNextRequest(firstConv.id)).toBeUndefined();
    expect(reopened.claimDelivery()).toBeUndefined();
    expect(reopened.getMeta('telegram.offset')).toBe('500');
    expect(reopened.recoverInterrupted()).toEqual({ requests: 0, deliveries: 0 });
  });

  it('backs up the live WAL database as an independently usable database', async () => {
    const dir = directory();
    const path = join(dir, 'live.sqlite');
    const store = open(path);
    const conv = conversation(store);
    const req = request(store);
    store.setMeta('cursor', '123');
    const backupPath = join(dir, 'backups', 'snapshot.sqlite');
    await store.backup(backupPath);
    const restored = open(backupPath);
    expect(restored.getConversation(conv.id)).toEqual(store.getConversation(conv.id));
    expect(restored.getRequest(req.id)).toEqual(req);
    expect(restored.getMeta('cursor')).toBe('123');
    await expect(store.backup(path)).rejects.toThrow(/active database/);

    const check = new DatabaseSync(path);
    try {
      expect(check.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(7);
      expect(check.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');
      expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { check.close(); }
  });

  it('upgrades a v2 database without changing bindings, senders, pending requests or aliases', () => {
    const path = join(directory(), 'v2.sqlite');
    const original = open(path);
    const conv = conversation(original);
    const req = request(original);
    original.setMeta('endpoint-alias:slack-1', 'Мой разговор');
    original.close();
    const old = new DatabaseSync(path);
    old.exec('DROP TABLE tool_outbox; DROP INDEX inbound_auto_link; ALTER TABLE inbound_events DROP COLUMN auto_link_intent_id; DROP TABLE auto_link_intents; DROP TABLE slack_sync_entries; DROP TABLE slack_sync_streams; ALTER TABLE endpoints DROP COLUMN catalog; PRAGMA user_version = 2;');
    old.close();
    const upgraded = open(path);
    expect(upgraded.getConversation(conv.id)).toEqual(conv);
    expect(upgraded.getRequest(req.id)).toEqual(req);
    expect(upgraded.getMeta('endpoint-alias:slack-1')).toBe('Мой разговор');
    upgraded.upsertEndpoint({ ...upgraded.getEndpoint('slack-1')!, chatTitle: 'Команда', topicTitle: 'Релиз', available: false, isForum: true });
    upgraded.upsertEndpoint(endpoint({ title: 'Новое исходное имя' }));
    upgraded.close();
    const reopened = open(path);
    expect(reopened.getEndpoint('slack-1')).toMatchObject({ title: 'Новое исходное имя', chatTitle: 'Команда', topicTitle: 'Релиз', available: false, isForum: true });
    expect(reopened.getConversation(conv.id)).toEqual(conv);
    expect(reopened.listRequests()).toHaveLength(1);
  });

  it('refuses corrupted, unrelated and future databases without deleting their data', () => {
    const dir = directory();
    const corrupt = join(dir, 'corrupt.sqlite');
    const contents = Buffer.from('This is not a SQLite database; preserve it for diagnosis.');
    writeFileSync(corrupt, contents);
    expect(() => new Store(corrupt)).toThrow();
    expect(readFileSync(corrupt)).toEqual(contents);

    const unrelated = join(dir, 'unrelated.sqlite');
    const foreignDb = new DatabaseSync(unrelated);
    foreignDb.exec("CREATE TABLE important_data(value TEXT); INSERT INTO important_data VALUES ('preserve me');");
    foreignDb.close();
    expect(() => new Store(unrelated)).toThrow(/does not belong/);
    const unchanged = new DatabaseSync(unrelated);
    try { expect(unchanged.prepare('SELECT value FROM important_data').get()?.value).toBe('preserve me'); }
    finally { unchanged.close(); }

    const future = join(dir, 'future.sqlite');
    const futureDb = new DatabaseSync(future);
    futureDb.exec('PRAGMA application_id = 1380273221; PRAGMA user_version = 999;');
    futureDb.close();
    expect(() => new Store(future)).toThrow(/newer/);
  });
});


function transcript(ep = endpoint(), messageId = '1770000000.000001', overrides: Partial<SlackTranscriptMessage> = {}): SlackTranscriptMessage {
  return { endpointId: ep.id, accountId: ep.accountId, chatId: ep.chatId, threadId: ep.threadId, messageId,
    sender: ep.people[0], text: 'Full Slack message', payload: { text: 'Full Slack message', ts: messageId }, kind: 'message', ...overrides };
}
function transcriptInbound(value: SlackTranscriptMessage, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return message(endpoint(), `message:${value.chatId}:${value.messageId}`, { messageId: value.messageId, sender: value.sender,
    text: value.text, slack: value, ...overrides });
}

describe('durable Slack transcript sync', () => {
  it('upgrades v3 without changing requests and seeds receipts without advancing coverage', () => {
    const path = join(directory(), 'v3.sqlite');
    const oldStore = open(path);
    const conv = conversation(oldStore);
    const original = request(oldStore);
    oldStore.close();
    const old = new DatabaseSync(path);
    old.exec('DROP TABLE tool_outbox; DROP INDEX inbound_auto_link; ALTER TABLE inbound_events DROP COLUMN auto_link_intent_id; DROP TABLE auto_link_intents; DROP TABLE slack_sync_entries; DROP TABLE slack_sync_streams; PRAGMA user_version = 3;');
    old.close();
    const upgraded = open(path);
    const [stream] = upgraded.listSlackSyncStreams();
    expect(stream).toMatchObject({ endpointId: endpoint().id, conversationId: conv.id, codexThreadId: conv.threadId, active: true, paused: false, state: 'backfill' });
    expect(stream.coveredThrough).toBeUndefined();
    const [entry] = upgraded.listSlackSyncEntries(stream.id);
    expect(entry).toMatchObject({ requestId: original.id, state: 'pending', message: { text: original.text } });
    expect(upgraded.getRequest(original.id)).toEqual(original);
    expect(upgraded.listRequests()).toHaveLength(1);
  });

  it('commits full context and task receipt together, replays once and rolls everything back on error', () => {
    const store = open();
    conversation(store);
    const slack = transcript(endpoint(), undefined, { text: 'a'.repeat(60_000), payload: { text: 'a'.repeat(60_000), files: [{ id: 'F1', title: 'Attachment' }] } });
    const inbound = transcriptInbound(slack);
    const first = store.ingest(inbound);
    expect(store.ingest({ ...inbound, slack: { ...slack, text: 'Changed replay' } })).toMatchObject({ duplicate: true, request: first.request });
    const [stream] = store.listSlackSyncStreams();
    const [entry] = store.listSlackSyncEntries(stream.id);
    expect(entry.requestId).toBe(first.request!.id);
    expect(entry.message).toEqual({ ...slack, participants: [slack.sender] });
    expect(store.listSlackSyncEntries(stream.id)).toHaveLength(1);
    expect(stream.coveredThrough).toBeUndefined();
    const next = transcript(endpoint(), '1770000000.000002');
    expect(() => store.ingest(transcriptInbound(next, { text: undefined as unknown as string }))).toThrow();
    expect(store.listSlackSyncEntries(stream.id)).toHaveLength(1);
    expect(store.ingest(transcriptInbound(next)).duplicate).toBe(false);
  });

  it('backfills passively, dedupes live/history metadata and retains edit/delete revisions', () => {
    const store = open();
    conversation(store);
    const slack = transcript();
    const original = store.recordSlackMessage(slack)!;
    expect(store.recordSlackMessage({ ...slack, payload: { ...slack.payload, event_ts: 'later', type: 'app_mention', team: 'T1' } })!.id).toBe(original.id);
    const edited = store.recordSlackMessage({ ...slack, kind: 'edit', text: 'Updated', payload: { text: 'Updated', edited: { ts: '1770000001.000000' } } })!;
    expect(store.recordSlackMessage({ ...edited.message, kind: 'message' })!.id).toBe(edited.id);
    const deleted = store.recordSlackMessage({ ...slack, kind: 'deleted', text: '', payload: {} })!;
    expect(deleted.id).not.toBe(edited.id);
    expect(store.listSlackSyncEntries(original.streamId)).toHaveLength(3);
    expect(store.listRequests()).toEqual([]);
    const stream = store.updateSlackSyncStream(original.streamId, { cursor: 'page-2', scanUntil: '1770000002.000000' });
    expect(stream.coveredThrough).toBeUndefined();
    expect(store.getSlackSyncStream(stream.id)?.cursor).toBe('page-2');
  });

  it('requires selected bots and direct mentions, while context-only and edits never trigger', () => {
    const store = open();
    const conv = conversation(store);
    const bot = { id: 'UBOT2', name: 'Other agent', isBot: true };
    store.setBinding(conv.id, 'slack', endpoint().id, ['user-1', bot.id]);
    const botMessage = transcript(endpoint(), '1770000000.000001', { sender: bot });
    expect(store.ingest(transcriptInbound(botMessage)).request).toBeNull();
    expect(store.ingest(transcriptInbound({ ...botMessage, messageId: '1770000000.000002' }, { directMention: true, contextOnly: true })).request).toBeNull();
    expect(store.ingest(transcriptInbound({ ...botMessage, messageId: '1770000000.000003' }, { directMention: true })).request).not.toBeNull();
    expect(store.ingest(transcriptInbound({ ...botMessage, messageId: '1770000000.000004', sender: { ...bot, id: 'UNOTSELECTED' } }, { directMention: true })).request).toBeNull();
    expect(store.ingest(transcriptInbound({ ...botMessage, messageId: '1770000000.000005', kind: 'edit' }, { directMention: true })).request).toBeNull();
    const [stream] = store.listSlackSyncStreams();
    expect(store.listSlackSyncEntries(stream.id)).toHaveLength(5);
    expect(store.listRequests()).toHaveLength(1);
  });

  it('records approval replies without tasks and preserves a cancelled trigger in the transcript', () => {
    const store = open();
    conversation(store);
    const reply = transcriptInbound(transcript());
    expect(store.recordInbound(reply)).toEqual({ duplicate: false });
    expect(store.ingest(reply)).toEqual({ duplicate: true, request: null });
    const trigger = transcriptInbound(transcript(endpoint(), '1770000000.000002'));
    const req = store.ingest(trigger).request!;
    store.finishRequest(req.id, { status: 'cancelled' }, []);
    const [stream] = store.listSlackSyncStreams();
    expect(store.listSlackSyncEntries(stream.id)).toHaveLength(2);
    expect(store.listSlackSyncEntries(stream.id)[1]).toMatchObject({ requestId: req.id, state: 'pending' });
  });

  it('pins captured entries to the old Codex destination across rebind and buffers while paused', () => {
    const store = open();
    const conv = conversation(store);
    const captured = store.recordSlackMessage(transcript())!;
    store.updateConversation(conv.id, { paused: true });
    expect(store.claimSlackSyncEntry(captured.id)).toBeUndefined();
    const next = endpoint({ id: 'new-endpoint', chatId: 'new-chat' });
    store.upsertEndpoint(next);
    store.setBinding(conv.id, 'slack', next.id, ['user-1']);
    const streams = store.listSlackSyncStreams();
    expect(streams).toHaveLength(2);
    expect(store.getSlackSyncStream(captured.streamId)).toMatchObject({ active: false, paused: true, codexThreadId: conv.threadId, endpointId: endpoint().id });
    expect(store.recordSlackMessage(transcript(endpoint(), '1770000000.000002'))).toBeUndefined();
    store.updateConversation(conv.id, { paused: false });
    expect(store.claimSlackSyncEntry(captured.id)?.state).toBe('applying');
    expect(store.getSlackSyncStream(captured.streamId)?.codexThreadId).toBe(conv.threadId);
    expect(() => store.updateSlackSyncStream(captured.streamId, { codexThreadId: 'other-thread' } as never)).toThrow(/immutable/);
    expect(() => store.recordSlackMessage(transcript(next, '1770000000.000003', { accountId: 'foreign-account' }))).toThrow(/origin/);
  });

  it('resets stream coverage on Slack detach and reattach while preserving its ledger and ACL-only updates', () => {
    const store = open();
    const conv = conversation(store);
    const entry = store.recordSlackMessage(transcript())!;
    const checkpoint = { cursor: 'page-2', coveredThrough: '1770000001.000000', scanUntil: '1770000002.000000',
      scanOldest: '1770000001.000000', state: 'blocked' as const, error: 'Previous failure', retryAt: '2999-01-01T00:00:00.000Z' };
    store.updateSlackSyncStream(entry.streamId, checkpoint);
    store.setBinding(conv.id, 'slack', endpoint().id, []);
    expect(store.getSlackSyncStream(entry.streamId)).toMatchObject(checkpoint);
    store.removeBinding(conv.id, store.getConversation(conv.id)!.bindings.find(binding => binding.platform === 'slack')!.id);
    const reset = { cursor: undefined, coveredThrough: undefined, scanUntil: undefined, scanOldest: undefined,
      state: 'backfill', error: undefined, retryAt: undefined };
    expect(store.getSlackSyncStream(entry.streamId)).toMatchObject({ ...reset, active: false, codexThreadId: conv.threadId });
    // Returning to an existing target must reset it even if its inactive checkpoint was retained by an older process.
    store.updateSlackSyncStream(entry.streamId, checkpoint);
    store.setBinding(conv.id, 'slack', endpoint().id, ['user-1']);
    expect(store.getSlackSyncStream(entry.streamId)).toMatchObject({ ...reset, active: true, codexThreadId: conv.threadId });
    expect(store.listSlackSyncEntries(entry.streamId)).toEqual([entry]);
    store.updateSlackSyncStream(entry.streamId, checkpoint);
    const occupied = endpoint({ id: 'occupied-endpoint', chatId: 'occupied-chat' });
    conversation(store, occupied, 'other-codex');
    expect(() => store.setBinding(conv.id, 'slack', occupied.id, ['user-1'])).toThrow(/UNIQUE/);
    expect(store.getSlackSyncStream(entry.streamId)).toMatchObject(checkpoint);
    expect(store.getConversation(conv.id)?.bindings[0].endpointId).toBe(endpoint().id);
  });

  it('orders source timestamps exactly, retries passive uncertain writes and recovers applying after restart', () => {
    const path = join(directory(), 'sync.sqlite');
    const store = open(path);
    conversation(store);
    const later = store.recordSlackMessage(transcript(endpoint(), '1770000000.000002'))!;
    const earlier = store.recordSlackMessage(transcript(endpoint(), '1770000000.000001'))!;
    expect(store.listSlackSyncEntries(later.streamId, { pending: true, beforeMessageId: earlier.messageId }).map(entry => entry.id)).toEqual([earlier.id]);
    expect(store.claimSlackSyncEntry(earlier.id)?.state).toBe('applying');
    expect(store.claimSlackSyncEntry(earlier.id)).toBeUndefined();
    store.updateSlackSyncEntry(later.id, { state: 'uncertain', retryAt: '2999-01-01T00:00:00Z' });
    expect(store.listSlackSyncEntries(later.streamId, { pending: true })).toEqual([]);
    store.close();
    const restarted = open(path);
    expect(restarted.recoverInterrupted()).toEqual({ requests: 0, deliveries: 0 });
    expect(restarted.getSlackSyncEntry(earlier.id)).toMatchObject({ state: 'pending' });
    expect(restarted.claimSlackSyncEntry(earlier.id)?.state).toBe('applying');
    expect(restarted.claimSlackSyncEntry(later.id)).toBeUndefined();
    restarted.updateSlackSyncEntry(later.id, { retryAt: undefined });
    expect(restarted.claimSlackSyncEntry(later.id)?.state).toBe('applying');
  });
});


describe('Slack transcript identity guards', () => {
  it('keeps a known bot classified as a bot when later events omit its profile', () => {
    const store = open();
    const ep = endpoint({ people: [{ id: 'UBOT', name: 'Agent', isBot: true }] });
    const conv = conversation(store, ep);
    store.setBinding(conv.id, 'slack', ep.id, ['UBOT']);
    store.upsertEndpoint({ ...ep, people: [{ id: 'UBOT', name: 'Unknown role' }] });
    expect(store.getEndpoint(ep.id)?.people[0].isBot).toBe(true);
    const value = transcript(ep, '1770000000.000001', { sender: { id: 'UBOT', name: 'Unknown role' } });
    expect(store.ingest(transcriptInbound(value, { endpoint: { ...ep, people: [value.sender] } })).request).toBeNull();
    expect(store.getEndpoint(ep.id)?.people[0].isBot).toBe(true);
  });

  it('routes a parentless deletion only by a previously logged message in the same account and channel', () => {
    const store = open();
    conversation(store);
    const original = store.recordSlackMessage(transcript())!;
    const missingParent = transcript(endpoint(), original.messageId, { endpointId: 'unknown-root', threadId: original.messageId,
      kind: 'deleted', sender: { id: 'slack:unknown', name: 'Unknown' }, text: '', payload: { deleted_ts: original.messageId } });
    const deletion = store.recordSlackMessage(missingParent)!;
    expect(deletion).toMatchObject({ streamId: original.streamId, message: { endpointId: endpoint().id, threadId: endpoint().threadId, sender: original.message.sender, kind: 'deleted' } });
    expect(store.recordSlackMessage({ ...missingParent, messageId: '1770000000.999999' })).toBeUndefined();
    expect(store.recordSlackMessage({ ...missingParent, accountId: 'other-account' })).toBeUndefined();
    expect(store.listSlackSyncEntries(original.streamId)).toHaveLength(2);
  });

  it('reports counts beyond the journal page size and pending rows whose retry has not elapsed', () => {
    const store = open();
    conversation(store);
    const entries = Array.from({ length: 105 }, (_, index) => store.recordSlackMessage(transcript(endpoint(), `1770000000.${String(index).padStart(6, '0')}`))!);
    store.updateSlackSyncEntry(entries[0].id, { state: 'uncertain', retryAt: '2999-01-01T00:00:00Z' });
    store.updateSlackSyncEntry(entries[1].id, { state: 'applied' });
    expect(store.getSlackSyncCounts(entries[0].streamId)).toEqual({ pending: 103, uncertain: 1, applied: 1, applying: 0 });
    expect(store.listSlackSyncEntries(entries[0].streamId)).toHaveLength(100);
    expect(store.hasPendingSlackSyncEntries(entries[0].streamId, entries[0].messageId)).toBe(true);
    expect(store.latestSlackMessageId(entries[0].streamId)).toBe(entries.at(-1)!.messageId);
  });
});


describe('shared conversation Slack backlog ordering', () => {
  it('orders pending entries across streams by source timestamp then durable insertion order, including revision ties', () => {
    const store = open();
    const firstEndpoint = endpoint();
    const secondEndpoint = endpoint({ id: 'second-stream', chatId: 'other-channel' });
    const conv = conversation(store, firstEndpoint);
    store.upsertEndpoint(secondEndpoint);
    store.addBinding(conv.id, 'slack', secondEndpoint.id, ['user-1']);
    const first = store.recordSlackMessage(transcript(firstEndpoint, '1770000002.000001'))!;
    const older = store.recordSlackMessage(transcript(secondEndpoint, '1770000001.000001'))!;
    const revision = store.recordSlackMessage(transcript(firstEndpoint, '1770000002.000001', { kind: 'edit', text: 'Edited revision' }))!;
    const tied = store.recordSlackMessage(transcript(secondEndpoint, '1770000002.000001'))!;
    expect(store.listPendingSlackSyncEntries(conv.id).map(entry => entry.id)).toEqual([older.id, first.id, revision.id, tied.id]);
    expect(store.listPendingSlackSyncEntries(conv.id, '1770000001.000001').map(entry => entry.id)).toEqual([older.id]);
    expect(store.listPendingSlackSyncEntries(conv.id, undefined, 2).map(entry => entry.id)).toEqual([older.id, first.id]);
    store.updateSlackSyncEntry(older.id, { state: 'applied' });
    store.updateSlackSyncEntry(first.id, { state: 'uncertain', retryAt: new Date(Date.now() + 60_000).toISOString() });
    store.updateSlackSyncEntry(revision.id, { state: 'applying' });
    expect(store.listPendingSlackSyncEntries(conv.id).map(entry => entry.id)).toEqual([tied.id]);
    const unrelated = endpoint({ id: 'unrelated', chatId: 'unrelated-channel' });
    const other = conversation(store, unrelated, 'unrelated-codex');
    store.recordSlackMessage(transcript(unrelated, '1770000000.000001'));
    expect(store.listPendingSlackSyncEntries(conv.id).map(entry => entry.id)).toEqual([tied.id]);
    expect(store.listPendingSlackSyncEntries(other.id)).toHaveLength(1);
  });
});

describe('durable addressed steering inputs', () => {
  function running(path?: string) {
    const store = open(path), ep = endpoint({ accountId: 'T1:UAGENT', chatId: 'C1', people: [{ id: 'U1', name: 'Owner', isBot: false }] });
    const conv = conversation(store, ep); store.setSourceAccess(ep.id, { mode: 'all' });
    const parent = store.ingest(message(ep, 'parent', { sender: ep.people[0], messageId: '1770000001.000001' })).request!;
    store.claimNextRequest(conv.id, parent.id); store.updateRequest(parent.id, { status: 'running', turnId: 'native-turn' });
    return { store, ep, conv, parent };
  }
  function addon(store: Store, ep: Endpoint, sender = { id: 'U2', name: 'Another participant', isBot: false }) {
    return store.ingest(message(ep, 'addon', { sender, messageId: '1770000002.000001', text: 'New direction' })).request!;
  }

  it.each([false, true])('attaches any authorized same-source author without transferring ownership (bot=%s)', isBot => {
    const { store, ep, conv, parent } = running(), child = addon(store, ep, { id: isBot ? 'UBOT2' : 'U2', name: 'Participant', isBot });
    const originalOrigin = child.origin;
    const input = store.beginSteeringInput(parent.id, { id: child.id, requestId: child.id, text: 'Attributed input' });
    expect(input).toMatchObject({ id: child.id, parentRequestId: parent.id, turnId: 'native-turn', state: 'sending', requestId: child.id });
    expect(store.getRequest(child.id)).toMatchObject({ status: 'uncertain', turnId: 'native-turn', steeredInto: parent.id, origin: originalOrigin });
    expect(store.getRequest(parent.id)?.origin).toEqual(parent.origin);
    expect(store.listPendingRequests()).toEqual([]);
    expect(store.beginSteeringInput(parent.id, { id: child.id, requestId: child.id, text: input.text })).toEqual(input);
    expect(store.steeringInputs(parent.id)).toEqual([input]);
    store.updateRequest(parent.id, { status: 'completed' });
    expect(store.claimNextRequest(conv.id, child.id)).toBeUndefined();
    const third = store.ingest(message(ep, 'next', { sender: ep.people[0] })).request!;
    expect(store.claimNextRequest(conv.id)?.id).toBe(third.id);
  });

  it('commits applied receipts and their exact journal entry without creating a delivery', () => {
    const path = join(directory(), 'steer.sqlite'), { store, ep, parent } = running(path), child = addon(store, ep);
    const input = store.beginSteeringInput(parent.id, { id: child.id, requestId: child.id, text: 'Input with attribution' });
    expect(store.getSlackSyncEntry(input.entryId!)?.state).toBe('applying');
    store.finishSteeringInput(child.id, 'applied');
    expect(store.getRequest(child.id)).toMatchObject({ status: 'completed', steeredInto: parent.id, turnId: 'native-turn', origin: child.origin });
    expect(store.getSlackSyncEntry(input.entryId!)?.state).toBe('applied');
    expect(store.listDeliveries()).toEqual([]);
    store.close();
    const restarted = open(path);
    expect(restarted.getSteeringInput(child.id)).toMatchObject({ state: 'applied', text: input.text });
    expect(restarted.getRequest(child.id)).toMatchObject({ status: 'completed', steeredInto: parent.id });
    expect(restarted.finishSteeringInput(child.id, 'applied').state).toBe('applied');
    expect(() => restarted.finishSteeringInput(child.id, 'refused')).toThrow(/final steering/);
  });

  it('returns an explicit refused input to the queue but preserves its non-replayable receipt', () => {
    const { store, ep, parent } = running(), child = addon(store, ep);
    const input = store.beginSteeringInput(parent.id, { id: child.id, requestId: child.id, text: 'Input' });
    store.finishSteeringInput(child.id, 'refused');
    expect(store.getRequest(child.id)).toMatchObject({ status: 'queued', origin: child.origin });
    expect(store.getRequest(child.id)?.steeredInto).toBeUndefined();
    expect(store.getRequest(child.id)?.turnId).toBeUndefined();
    expect(store.getSlackSyncEntry(input.entryId!)?.state).toBe('pending');
    expect(store.listPendingRequests().map(value => value.id)).toEqual([child.id]);
    expect(store.beginSteeringInput(parent.id, { id: child.id, requestId: child.id, text: 'Input' }).state).toBe('refused');
    expect(() => store.beginSteeringInput(parent.id, { id: child.id, requestId: child.id, text: 'Changed' })).toThrow(/different content/);
  });

  it('recovers interrupted intents as uncertain without passive or request replay', () => {
    const path = join(directory(), 'lost-ack.sqlite'), { store, ep, conv, parent } = running(path), child = addon(store, ep);
    const input = store.beginSteeringInput(parent.id, { id: child.id, requestId: child.id, text: 'Input' });
    store.close(); const restarted = open(path); restarted.recoverInterrupted();
    expect(restarted.getSteeringInput(child.id)).toMatchObject({ state: 'uncertain', parentRequestId: parent.id, turnId: 'native-turn' });
    expect(restarted.getRequest(child.id)).toMatchObject({ status: 'uncertain', steeredInto: parent.id });
    expect(restarted.getSlackSyncEntry(input.entryId!)?.state).toBe('uncertain');
    expect(restarted.claimSlackSyncEntry(input.entryId!)).toBeUndefined();
    expect(restarted.listPendingSlackSyncEntries(conv.id).some(value => value.id === input.entryId)).toBe(false);
    expect(restarted.listPendingRequests()).toEqual([]);
    restarted.finishSteeringInput(child.id, 'applied');
    expect(restarted.getRequest(child.id)?.status).toBe('completed');
    expect(restarted.listDeliveries()).toEqual([]);
  });

  it.each(['platform', 'account', 'chat', 'thread'])('refuses a different source even when linked to the same native conversation (%s)', field => {
    const { store, ep, conv, parent } = running();
    const other = { ...ep, id: 'another-source', ...(field === 'platform' ? { platform: 'telegram' as const, chatId: '-100' }
      : field === 'account' ? { accountId: 'OTHER' } : field === 'chat' ? { chatId: 'C2' } : { threadId: 'another-thread' }) };
    store.upsertEndpoint(other); store.addBinding(conv.id, other.platform, other.id, []); store.setSourceAccess(other.id, { mode: 'all' });
    const child = addon(store, other, { id: field === 'platform' ? '42' : 'U2', name: 'Participant', isBot: false });
    expect(child).toBeTruthy();
    expect(() => store.beginSteeringInput(parent.id, { id: child.id, requestId: child.id, text: 'Input' })).toThrow(/same source/);
    expect(store.getSteeringInput(child.id)).toBeUndefined();
    expect(store.getRequest(child.id)?.status).toBe('queued');
  });

  it.each(['mixed', 'cancel', 'approval', 'paused', 'audio', 'source-off'])('fails closed before persisting an inadmissible intent (%s)', guard => {
    const { store, ep, conv, parent } = running();
    const child = guard === 'audio' ? store.ingest(message(ep, 'audio', { sender: ep.people[0], audio: { platform: 'slack', name: 'voice.ogg', fileId: 'F1' } })).request! : addon(store, ep);
    if (guard === 'mixed') store.setMeta(`mixed:${parent.id}`, '1');
    if (guard === 'cancel') store.setMeta(`cancel-requested:${parent.id}`, '1');
    if (guard === 'approval') store.addApproval(approvalInput(parent.id));
    if (guard === 'paused') store.updateConversation(conv.id, { paused: true });
    if (guard === 'source-off') store.setSourceAccess(ep.id, { mode: 'off' });
    expect(() => store.beginSteeringInput(parent.id, { id: child.id, requestId: child.id, text: 'Input' })).toThrow();
    expect(store.getSteeringInput(child.id)).toBeUndefined();
    expect(store.getRequest(child.id)?.status).toBe('queued');
  });

  it('applies only the immutable request revision and leaves later edits pending', () => {
    const { store, ep, parent } = running();
    const source = transcript(ep, '1770000002.000001', { sender: { id: 'U2', name: 'Participant' }, text: 'Original', payload: { text: 'Original', files: [{ id: 'F1' }] } });
    const child = store.ingest(transcriptInbound(source, { endpoint: ep })).request!;
    const original = store.listSlackSyncEntries(store.listSlackSyncStreams()[0].id).find(value => value.requestId === child.id)!;
    const edit = store.recordSlackMessage({ ...source, kind: 'edit', text: 'Edited', payload: { text: 'Edited', edited: { ts: '1770000003.000001' } } })!;
    store.updateSlackSyncEntry(edit.id, { requestId: child.id });
    expect(() => store.beginSteeringInput(parent.id, { id: child.id, requestId: child.id, entryId: edit.id, text: 'Input' })).toThrow(/immutable request revision/);
    const input = store.beginSteeringInput(parent.id, { id: child.id, requestId: child.id, text: 'Input' });
    expect(input.entryId).toBe(original.id);
    store.finishSteeringInput(child.id, 'applied');
    expect(store.getSlackSyncEntry(original.id)?.state).toBe('applied');
    expect(store.getSlackSyncEntry(edit.id)?.state).toBe('pending');
  });

  it('tracks passive same-source context without manufacturing a child request', () => {
    const { store, ep, parent } = running();
    const wrongPlatform = store.recordSlackMessage(transcript(ep, '1770000003.000001', { platform: 'telegram' }))!;
    expect(() => store.beginSteeringInput(parent.id, { id: wrongPlatform.id, entryId: wrongPlatform.id, text: 'Wrong platform' })).toThrow(/same source/);
    const entry = store.recordSlackMessage(transcript(ep, '1770000002.000001', { sender: { id: 'UBOT2', name: 'Another agent', isBot: true } }))!;
    const input = store.beginSteeringInput(parent.id, { id: entry.id, entryId: entry.id, text: 'Attributed passive context' });
    expect(input.requestId).toBeUndefined();
    expect(store.getSlackSyncEntry(entry.id)?.state).toBe('applying');
    store.finishSteeringInput(input.id, 'uncertain', 'Unknown native ACK');
    expect(store.claimSlackSyncEntry(entry.id)).toBeUndefined();
    store.finishSteeringInput(input.id, 'applied');
    expect(store.getSlackSyncEntry(entry.id)?.state).toBe('applied');
    expect(store.listRequests()).toHaveLength(1);
    expect(store.listDeliveries()).toEqual([]);
  });
});
