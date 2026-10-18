import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import type { Approval, Delivery, Endpoint, InboundMessage, ReleRequest } from '../src/shared/types.js';

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
    store.removeBinding(conv.id, 'slack');
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

  it('finishes requests atomically with the outbox and cancels only unsent approval prompts', () => {
    const store = open();
    conversation(store);
    const req = request(store);
    store.updateRequest(req.id, { status: 'waiting_approval' });
    const pending = store.addApproval(approvalInput(req.id));
    const answered = store.addApproval({ ...approvalInput(req.id), itemId: 'answered-item', status: 'answered', decision: 'accept' });
    const [prompt] = store.addDeliveries(req.id, [{ key: `approval:${pending.id}`, ordinal: 0, kind: 'approval', body: 'Approve?', approvalId: pending.id }]);

    expect(() => store.finishRequest(req.id, { status: 'completed', turnId: 'turn-1' }, [
      { key: 'answer:0', ordinal: 0, kind: 'answer', body: 'Completed' },
      { key: 'answer:1', ordinal: 1, kind: 'invalid' as Delivery['kind'], body: 'Constraint failure' },
    ])).toThrow(/CHECK/);
    expect(store.getRequest(req.id)).toMatchObject({ status: 'waiting_approval', turnId: undefined });
    expect(store.getApproval(pending.id)?.status).toBe('pending');
    expect(store.getDelivery(prompt.id)?.status).toBe('pending');
    expect(store.listDeliveries()).toHaveLength(1);

    const parts: Array<Pick<Delivery, 'key' | 'ordinal' | 'kind' | 'body'>> = [{ key: 'answer:0', ordinal: 0, kind: 'answer', body: 'Completed' }];
    expect(store.finishRequest(req.id, { status: 'completed', turnId: 'turn-1' }, parts).status).toBe('completed');
    expect(store.getApproval(pending.id)?.status).toBe('expired');
    expect(store.getApproval(answered.id)).toMatchObject({ status: 'answered', decision: 'accept' });
    expect(store.getDelivery(prompt.id)).toMatchObject({ status: 'cancelled', attempts: 0 });
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
    store.finishRequest(req.id, { status: 'completed' }, [{ key: 'answer:0', ordinal: 0, kind: 'answer', body: 'Final answer' }]);
    expect(store.getDelivery(sending.id)?.status).toBe('sending');
    expect(store.getDelivery(uncertain.id)?.status).toBe('uncertain');
    expect(store.claimDelivery()).toBeUndefined();
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
      expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
      expect(check.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');
      expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { check.close(); }
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
