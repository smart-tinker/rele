import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import type { AutoLinkRule, Endpoint, InboundMessage } from '../src/shared/types.js';

const stores: Store[] = [];
const directories: string[] = [];
let messageNumber = 1000;
function path() {
  const directory = mkdtempSync(join(tmpdir(), 'rele-auto-links-'));
  directories.push(directory);
  return join(directory, 'rele.sqlite');
}
function open(file = path()) {
  const store = new Store(file);
  stores.push(store);
  return store;
}
function dropSourceVersionSchema(database: DatabaseSync): void {
  database.exec(`DROP TABLE inbound_source_versions; DROP INDEX slack_sync_semantic_source; DROP INDEX slack_sync_aliases;
    ALTER TABLE slack_sync_entries DROP COLUMN canonical_entry_id; ALTER TABLE slack_sync_entries DROP COLUMN semantic_revision;`);
}
function endpoint(id = 'slack-1', platform: 'slack' | 'telegram' = 'slack'): Endpoint {
  return { id, platform, accountId: platform === 'slack' ? 'T1:BOT' : 'telegram-bot',
    chatId: platform === 'slack' ? `C${id.replaceAll('-', '')}` : '-100', threadId: id,
    title: id, subtitle: platform, people: [{ id: 'U1', name: 'Human' }, { id: 'U2', name: 'Other' }], updatedAt: new Date().toISOString() };
}
function message(ep = endpoint(), eventId = 'first', patch: Partial<InboundMessage> = {}): InboundMessage {
  const messageId = `${messageNumber++}.000001`;
  const value: InboundMessage = { endpoint: ep, eventId, messageId, sender: ep.people[0], text: eventId,
    ...(ep.platform === 'slack' ? { slack: { endpointId: ep.id, accountId: ep.accountId, chatId: ep.chatId,
      threadId: ep.threadId, messageId, sender: ep.people[0], text: eventId, payload: { text: eventId }, kind: 'message' as const } } : {}), ...patch };
  if (value.slack) value.slack = { ...value.slack, sender: value.sender, text: value.text };
  return value;
}
function rule(ep = endpoint(), patch: Partial<AutoLinkRule> = {}): AutoLinkRule {
  return { id: 'rule', enabled: true, platform: ep.platform, accountId: ep.accountId, chatId: ep.chatId,
    cwd: '/fixture', allowedSenderIds: ['U1', 'U2'], requireMention: false, ...patch };
}
const auto = (value = rule()) => ({ rule: value, targetFingerprint: 'sha256:test-profile' });
function accept(store: Store, value = message(), selected = auto()) {
  const received = store.ingest(value, selected);
  expect(received.request).toBeNull();
  expect(received.duplicate).toBe(false);
  expect(received.autoLinkIntent).toBeDefined();
  return received.autoLinkIntent!;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('multiple origin bindings and v5 migration', () => {
  it('upgrades a genuine v4 binding constraint while retaining IDs, ACL, requests, outbox and Slack history', () => {
    const file = path();
    const store = open(file);
    const slack = endpoint(); const telegram = endpoint('telegram-1', 'telegram');
    for (const ep of [slack, telegram]) store.upsertEndpoint(ep);
    const original = store.createConversation({ name: 'Original', threadId: 'native-original', cwd: '/fixture', bindings: [
      { platform: 'slack', endpointId: slack.id, allowedSenderIds: ['U1'] },
      { platform: 'telegram', endpointId: telegram.id, allowedSenderIds: ['U2'] },
    ] });
    const request = store.ingest(message(slack)).request!;
    const deliveries = store.addDeliveries(request.id, [{ key: 'part', ordinal: 0, kind: 'answer', body: 'Original outbox' }]);
    const streams = store.listSlackSyncStreams();
    const entries = store.listSlackSyncEntries(streams[0].id);
    store.close();
    const old = new DatabaseSync(file);
    dropSourceVersionSchema(old);
    old.exec(`DROP TABLE tool_outbox; CREATE TABLE bindings_v4 (
      id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      platform TEXT NOT NULL CHECK(platform IN ('slack','telegram')), endpoint_id TEXT NOT NULL UNIQUE,
      allowed_sender_ids TEXT NOT NULL CHECK(json_valid(allowed_sender_ids) AND json_type(allowed_sender_ids)='array'),
      UNIQUE(conversation_id,platform), FOREIGN KEY(endpoint_id,platform) REFERENCES endpoints(id,platform)
    ) STRICT;
    INSERT INTO bindings_v4(rowid,id,conversation_id,platform,endpoint_id,allowed_sender_ids)
      SELECT rowid,id,conversation_id,platform,endpoint_id,allowed_sender_ids FROM bindings;
    DROP TABLE bindings; ALTER TABLE bindings_v4 RENAME TO bindings;
    DROP INDEX inbound_auto_link; ALTER TABLE inbound_events DROP COLUMN auto_link_intent_id;
    DROP TABLE auto_link_intents; ALTER TABLE requests DROP COLUMN images; PRAGMA user_version=4;`);
    expect(() => old.prepare('INSERT INTO bindings VALUES (?,?,?,?,?)').run('conflict', original.id, 'slack', 'unused', '[]')).toThrow(/UNIQUE/);
    old.close();
    const upgraded = open(file);
    expect(upgraded.getConversation(original.id)).toEqual(original);
    expect(upgraded.getRequest(request.id)).toEqual(request);
    expect(upgraded.listDeliveries()).toEqual(deliveries);
    expect(upgraded.listSlackSyncStreams()).toEqual(streams);
    expect(upgraded.listSlackSyncEntries(streams[0].id)).toEqual(entries);
    for (const ep of [endpoint('slack-2'), endpoint('telegram-2', 'telegram')]) {
      upgraded.upsertEndpoint(ep); upgraded.addBinding(original.id, ep.platform, ep.id, ['U1']);
    }
    expect(upgraded.getConversation(original.id)?.bindings).toHaveLength(4);
    expect(upgraded.getConversation(original.id)?.threadId).toBe('native-original');
    const check = new DatabaseSync(file);
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(9);
    expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(check.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');
    check.close();
  });

  it('edits and removes only a scoped binding and rejects duplicate endpoints or ambiguous legacy replacement', () => {
    const store = open();
    const endpoints = [endpoint(), endpoint('slack-2'), endpoint('telegram-1', 'telegram'), endpoint('telegram-2', 'telegram')];
    for (const ep of endpoints) store.upsertEndpoint(ep);
    const conv = store.createConversation({ name: 'Four origins', threadId: 'original', cwd: '/fixture',
      bindings: endpoints.map(ep => ({ platform: ep.platform, endpointId: ep.id, allowedSenderIds: ['U1'] })) });
    const [first, second] = conv.bindings.filter(binding => binding.platform === 'slack');
    expect(store.updateBinding(conv.id, first.id, first.endpointId, ['U2']).id).toBe(first.id);
    expect(store.getBinding(conv.id, second.id)).toEqual(second);
    expect(() => store.updateBinding(conv.id, first.id, second.endpointId, ['U1'])).toThrow(/UNIQUE/);
    expect(store.getBinding(conv.id, first.id)?.allowedSenderIds).toEqual(['U2']);
    expect(() => store.addBinding(conv.id, 'slack', first.endpointId, ['U1'])).toThrow(/UNIQUE/);
    expect(() => store.setBinding(conv.id, 'slack', first.endpointId, ['U1'])).toThrow(/binding ID/);
    expect(() => store.removeBinding(conv.id, 'slack')).toThrow(/Binding not found/);
    const other = store.createConversation({ name: 'Other', threadId: 'other', cwd: '/fixture' });
    expect(() => store.updateBinding(other.id, first.id, first.endpointId, ['U1'])).toThrow(/Binding not found/);
    expect(() => store.addBinding(other.id, 'slack', first.endpointId, ['U1'])).toThrow(/UNIQUE/);
    store.removeBinding(conv.id, first.id);
    expect(store.getConversation(conv.id)?.bindings).toEqual(conv.bindings.filter(binding => binding.id !== first.id));
  });
});

describe('durable auto-link intake and creation', () => {
  it('joins parallel intake, deduplicates receipts, and never promotes earlier ignored events', () => {
    const file = path(); const store = open(file); const peer = open(file);
    const old = message(endpoint(), 'ignored-before-rule');
    expect(store.ingest(old)).toEqual({ request: null, duplicate: false });
    expect(store.ingest(old, auto())).toEqual({ request: null, duplicate: true });
    const first = message(endpoint(), 'accepted-first');
    const intent = accept(store, first);
    expect(store.ingest(first, auto())).toEqual({ request: null, duplicate: true });
    const next = accept(peer, message(endpoint(), 'accepted-second'));
    expect(next.id).toBe(intent.id);
    expect(store.listAutoLinkIntents()).toHaveLength(1);
    expect(store.claimAutoLinkIntent(intent.id)?.status).toBe('creating');
    expect(peer.claimAutoLinkIntent(intent.id)).toBeUndefined();
    store.updateAutoLinkIntent(intent.id, { status: 'created', threadId: 'native-once' });
    const conversation = peer.finalizeAutoLinkIntent(intent.id)!;
    expect(conversation.threadId).toBe('native-once');
    expect(store.listRequests().map(request => request.text).sort()).toEqual(['accepted-first', 'accepted-second']);
    expect(store.ingest(old, auto())).toEqual({ request: null, duplicate: true });
    expect(peer.finalizeAutoLinkIntent(intent.id)?.id).toBe(conversation.id);
    expect(store.listRequests()).toHaveLength(2);
    expect(store.listSlackSyncEntries(store.listSlackSyncStreams()[0].id)).toHaveLength(3);
  });

  it('keeps unknown create ACKs uncertain across restart and resumes a saved native ID without another claim', () => {
    const file = path(); const store = open(file);
    const unknown = accept(store);
    store.claimAutoLinkIntent(unknown.id);
    const otherEndpoint = endpoint('second');
    const saved = accept(store, message(otherEndpoint, 'saved'), auto(rule(otherEndpoint)));
    store.claimAutoLinkIntent(saved.id);
    store.updateAutoLinkIntent(saved.id, { status: 'created', threadId: 'saved-native-id' });
    store.close();
    const reopened = open(file);
    reopened.recoverInterrupted();
    expect(reopened.getAutoLinkIntent(unknown.id)?.status).toBe('uncertain');
    expect(reopened.claimAutoLinkIntent(unknown.id)).toBeUndefined();
    expect(reopened.finalizeAutoLinkIntent(unknown.id)).toBeUndefined();
    expect(reopened.getAutoLinkIntent(saved.id)?.status).toBe('created');
    expect(reopened.claimAutoLinkIntent(saved.id)).toBeUndefined();
    expect(reopened.finalizeAutoLinkIntent(saved.id)?.threadId).toBe('saved-native-id');
    expect(() => reopened.updateAutoLinkIntent(saved.id, { threadId: 'different-id' })).toThrow(/immutable/);
  });

  it('uses a manual binding with current pause and ACL and starts a fresh incarnation only after unlink', () => {
    const store = open(); const ep = endpoint();
    const intent = accept(store);
    accept(store, message(ep, 'second-user', { sender: ep.people[1] }));
    const manual = store.createConversation({ name: 'Manual winner', threadId: 'manual-native', cwd: '/manual',
      bindings: [{ platform: 'slack', endpointId: ep.id, allowedSenderIds: ['U1'] }] });
    store.updateConversation(manual.id, { paused: true });
    expect(store.claimAutoLinkIntent(intent.id)).toBeUndefined();
    expect(store.finalizeAutoLinkIntent(intent.id)).toBeUndefined();
    expect(store.listRequests()).toEqual([]);
    store.updateConversation(manual.id, { paused: false });
    expect(store.finalizeAutoLinkIntent(intent.id)).toBeUndefined();
    expect(store.listRequests()).toHaveLength(1);
    store.updateBinding(manual.id, manual.bindings[0].id, ep.id, ['U1', 'U2']);
    expect(store.finalizeAutoLinkIntent(intent.id)?.id).toBe(manual.id);
    expect(store.getAutoLinkIntent(intent.id)).toMatchObject({ status: 'completed', threadId: 'manual-native' });
    expect(store.listConversations()).toHaveLength(1);
    expect(store.listRequests()).toHaveLength(2);
    store.removeBinding(manual.id, manual.bindings[0].id);
    expect(accept(store, message(ep, 'new-incarnation')).id).not.toBe(intent.id);
  });

  it('does not absorb changed rule or target snapshots and does not create behind a paused binding', () => {
    const store = open(); const selected = rule(); const intent = accept(store, message(), auto(selected));
    selected.allowedSenderIds.push('NEW');
    expect(store.getAutoLinkIntent(intent.id)?.rule.allowedSenderIds).toEqual(['U1', 'U2']);
    expect(store.ingest(message(endpoint(), 'changed-rule'), auto(selected)).autoLinkIntent).toBeUndefined();
    expect(store.ingest(message(endpoint(), 'changed-target'), { ...auto(), targetFingerprint: 'different' }).autoLinkIntent).toBeUndefined();
    const ep = endpoint('bound'); store.upsertEndpoint(ep);
    const conversation = store.createConversation({ name: 'Paused', threadId: 'paused-native', cwd: '/fixture',
      bindings: [{ platform: 'slack', endpointId: ep.id, allowedSenderIds: ['U1'] }] });
    store.updateConversation(conversation.id, { paused: true });
    expect(store.ingest(message(ep, 'paused'), auto(rule(ep)))).toEqual({ request: null, duplicate: false });
    expect(store.listAutoLinkIntents()).toHaveLength(1);
  });

  it.each(['disabled', 'wrong-account', 'wrong-chat', 'wrong-platform', 'denied', 'context', 'edit', 'control', 'cancel', 'bot', 'mention', 'empty'] as const)('does not provision %s events', kind => {
    const store = open(); const value = message(); const selected = rule();
    if (kind === 'disabled') selected.enabled = false;
    if (kind === 'wrong-account') selected.accountId = 'other';
    if (kind === 'wrong-chat') selected.chatId = 'other';
    if (kind === 'wrong-platform') selected.platform = 'telegram';
    if (kind === 'denied') selected.allowedSenderIds = [];
    if (kind === 'context') value.contextOnly = true;
    if (kind === 'edit') value.slack!.kind = 'edit';
    if (kind === 'control') value.control = 'stop';
    if (kind === 'cancel') value.text = 'rele:cancel';
    if (kind === 'bot') { value.sender.isBot = true; value.slack!.sender.isBot = true; }
    if (kind === 'mention') selected.requireMention = true;
    if (kind === 'empty') value.text = '';
    if (value.slack) value.slack = { ...value.slack, text: value.text };
    expect(store.ingest(value, auto(selected))).toEqual({ request: null, duplicate: false });
    expect(store.listAutoLinkIntents()).toEqual([]);
  });

  it('accepts only a fresh bot mention in groups and only the exact allowlisted human in DMs', () => {
    const store = open(); const group = endpoint();
    const bot = { id: 'BOTOTHER', name: 'Other agent', isBot: true };
    expect(accept(store, message(group, 'group-bot', { sender: bot, directMention: true }), auto(rule(group, { allowedSenderIds: [bot.id] })))).toBeDefined();
    for (const platform of ['slack', 'telegram'] as const) {
      const dm = { ...endpoint(`dm-${platform}`, platform), chatId: platform === 'slack' ? 'DUSER' : '123', people: [{ id: '123', name: 'Human' }] };
      const selected = auto(rule(dm, { requireMention: true, allowedSenderIds: ['123', bot.id] }));
      expect(store.ingest(message(dm, `dm-bot-${platform}`, { sender: bot, directMention: true }), selected).autoLinkIntent).toBeUndefined();
      expect(accept(store, message(dm, `dm-human-${platform}`), selected)).toBeDefined();
      if (platform === 'telegram') expect(store.ingest(message(dm, 'wrong-dm-human', { sender: { id: '456', name: 'Other' } }), auto(rule(dm, { allowedSenderIds: ['456'] }))).autoLinkIntent).toBeUndefined();
    }
  });

  it.each(['/start', '/rele_register', '/rele_chats', '/rele_cancel'])('never auto-links Telegram command %s', text => {
    const store = open(); const ep = endpoint('topic', 'telegram');
    expect(store.ingest(message(ep, text, { text }), auto(rule(ep))).autoLinkIntent).toBeUndefined();
    expect(store.listAutoLinkIntents()).toEqual([]);
  });

  it('rolls back the receipt on intake failure and preserves a saved native ID when a manual binding wins', () => {
    const store = open(); const value = message();
    expect(() => store.ingest(value, { ...auto(), targetFingerprint: '' })).toThrow(/fingerprint/);
    const intent = accept(store, value);
    store.claimAutoLinkIntent(intent.id);
    expect(() => store.updateAutoLinkIntent(intent.id, { status: 'created' })).toThrow(/Persist/);
    store.updateAutoLinkIntent(intent.id, { status: 'created', threadId: 'unused-native' });
    const manual = store.createConversation({ name: 'Manual', threadId: 'manual-native', cwd: '/manual',
      bindings: [{ platform: 'slack', endpointId: value.endpoint.id, allowedSenderIds: ['U1'] }] });
    expect(store.finalizeAutoLinkIntent(intent.id)?.id).toBe(manual.id);
    expect(store.getAutoLinkIntent(intent.id)).toMatchObject({ status: 'completed', threadId: 'unused-native', conversationId: manual.id });
    expect(store.getAutoLinkIntent(intent.id)?.error).toBeTruthy();
    expect(store.listConversations()).toHaveLength(1);
  });
});


describe('persisted group sender policy', () => {
  it('keeps all participants including future agents allowed after auto creation, without changing legacy ACL bindings', () => {
    const store = open(); const ep = { ...endpoint(), accountId: 'T1:UBOT' };
    const selected = auto(rule(ep, { allowedSenderIds: [], allowAllSenders: true }));
    const intent = accept(store, message(ep), selected);
    store.claimAutoLinkIntent(intent.id);
    store.updateAutoLinkIntent(intent.id, { status: 'created', threadId: 'group-native' });
    const conversation = store.finalizeAutoLinkIntent(intent.id)!;
    const binding = conversation.bindings[0];
    expect(binding).toMatchObject({ allowAllSenders: true, requireMention: false, allowedSenderIds: [] });
    const peer = { id: 'UAGENT', name: 'Future agent', isBot: true };
    expect(store.ingest(message(ep, 'future-agent', { sender: peer })).request?.conversationId).toBe(conversation.id);
    expect(store.ingest(message(ep, 'future-human', { sender: { id: 'UNEW', name: 'Future member' } })).request).toBeTruthy();
    for (const sender of [{ id: 'UBOT', name: 'Rele', isBot: true }, { id: 'USLACKBOT', name: 'Slackbot', isBot: true }, { id: 'slack:unknown', name: 'Unknown' }]) {
      expect(store.ingest(message(ep, sender.id, { sender })).request).toBeNull();
    }
    store.updateBinding(conversation.id, binding.id, ep.id, ['U1']);
    expect(store.getBinding(conversation.id, binding.id)?.allowAllSenders).toBe(true);
    store.updateBinding(conversation.id, binding.id, ep.id, ['U1', peer.id], { allowAllSenders: false });
    expect(store.ingest(message(ep, 'legacy-bot-no-mention', { sender: peer })).request).toBeNull();
    expect(store.ingest(message(ep, 'legacy-bot-mentioned', { sender: peer, directMention: true })).request).toBeTruthy();
    expect(store.ingest(message(ep, 'legacy-human-denied', { sender: { id: 'UNEW', name: 'New' } })).request).toBeNull();
  });

  it('resets omitted sender policy on endpoint replacement while preserving same-endpoint edits', () => {
    const store = open();
    for (const platform of ['slack', 'telegram'] as const) {
      const human = { id: platform === 'slack' ? 'U1' : '123', name: 'Selected human' };
      const outsider = { id: platform === 'slack' ? 'UNEW' : '456', name: 'Other member' };
      const original = { ...endpoint(`original-${platform}`, platform), people: [human] };
      const replacement = { ...endpoint(`replacement-${platform}`, platform), people: [human, outsider] };
      for (const ep of [original, replacement]) store.upsertEndpoint(ep);
      const conversation = store.createConversation({ name: 'Policy replacement', threadId: `policy-${platform}`, cwd: '/fixture', bindings: [
        { platform, endpointId: original.id, allowedSenderIds: [], allowAllSenders: true, requireMention: true },
      ] });
      const binding = conversation.bindings[0];
      expect(store.updateBinding(conversation.id, binding.id, original.id, []).id).toBe(binding.id);
      expect(store.getBinding(conversation.id, binding.id)).toMatchObject({ allowAllSenders: true, requireMention: true });
      expect(store.updateBinding(conversation.id, binding.id, replacement.id, [human.id])).toMatchObject({
        id: binding.id, endpointId: replacement.id, allowedSenderIds: [human.id], allowAllSenders: false, requireMention: false,
      });
      expect(store.ingest(message(replacement, `outsider-${platform}`, { sender: outsider, directMention: true })).request).toBeNull();
      expect(store.ingest(message(replacement, `selected-${platform}`, { sender: human })).request?.conversationId).toBe(conversation.id);
      expect(store.bindingForEndpoint(original.id)).toBeUndefined();
      // An explicit policy can still authorize the replacement group.
      expect(store.updateBinding(conversation.id, binding.id, original.id, [], { allowAllSenders: true, requireMention: false })).toMatchObject({
        id: binding.id, allowAllSenders: true, requireMention: false,
      });
      expect(store.ingest(message(original, `explicit-outsider-${platform}`, { sender: outsider })).request?.conversationId).toBe(conversation.id);
    }
  });

  it('applies the group mention checkbox to humans and bots, and persists it across reopening', () => {
    const file = path(); const store = open(file); const ep = endpoint();
    store.upsertEndpoint(ep);
    const conv = store.createConversation({ name: 'Mention only', threadId: 'mention-native', cwd: '/fixture', bindings: [
      { platform: 'slack', endpointId: ep.id, allowedSenderIds: [], allowAllSenders: true, requireMention: true },
    ] });
    store.close();
    const reopened = open(file);
    expect(reopened.getConversation(conv.id)?.bindings[0]).toMatchObject({ allowAllSenders: true, requireMention: true });
    for (const sender of [{ id: 'UNEW', name: 'Member' }, { id: 'UAGENT', name: 'Agent', isBot: true }]) {
      expect(reopened.ingest(message(ep, `${sender.id}-plain`, { sender })).request).toBeNull();
      expect(reopened.ingest(message(ep, `${sender.id}-mention`, { sender, directMention: true })).request).toBeTruthy();
    }
  });

  it('allows new numeric Telegram group members while rejecting all-participants DM bindings and rules', () => {
    const store = open(); const group = endpoint('tg-group', 'telegram');
    store.upsertEndpoint(group);
    const conv = store.createConversation({ name: 'TG group', threadId: 'tg-native', cwd: '/fixture', bindings: [
      { platform: 'telegram', endpointId: group.id, allowedSenderIds: [], allowAllSenders: true },
    ] });
    expect(store.ingest(message(group, 'new-human', { sender: { id: '123', name: 'Human' } })).request?.conversationId).toBe(conv.id);
    expect(store.ingest(message(group, 'new-bot', { sender: { id: '456', name: 'Agent', isBot: true } })).request).toBeTruthy();
    expect(store.ingest(message(group, 'unknown', { sender: { id: 'unknown', name: 'Unknown' } })).request).toBeNull();
    for (const platform of ['slack', 'telegram'] as const) {
      const dm = { ...endpoint(`all-dm-${platform}`, platform), chatId: platform === 'slack' ? 'DPRIVATE' : '123' };
      store.upsertEndpoint(dm);
      expect(() => store.addBinding(conv.id, platform, dm.id, [], { allowAllSenders: true })).toThrow(/Direct messages/);
      expect(store.ingest(message(dm, `all-rule-${platform}`, { sender: { id: '123', name: 'Human' } }), auto(rule(dm, { allowAllSenders: true }))).autoLinkIntent).toBeUndefined();
    }
  });

  it('keeps automatic DM bindings restricted to the same allowed human after creation', () => {
    const store = open();
    for (const platform of ['slack', 'telegram'] as const) {
      const human = { id: platform === 'slack' ? 'UHUMAN' : '123', name: 'Allowed human' };
      const dm = { ...endpoint(`human-dm-${platform}`, platform), chatId: platform === 'slack' ? 'DPRIVATE' : human.id, people: [human] };
      const intent = accept(store, message(dm, `first-dm-${platform}`, { sender: human }), auto(rule(dm, { allowedSenderIds: [human.id, '456'] })));
      store.updateAutoLinkIntent(intent.id, { status: 'created', threadId: `native-human-dm-${platform}` });
      const conversation = store.finalizeAutoLinkIntent(intent.id)!;
      expect(store.ingest(message(dm, `human-followup-${platform}`, { sender: human })).request?.conversationId).toBe(conversation.id);
      if (platform === 'telegram') {
        expect(store.ingest(message(dm, 'wrong-private-sender', { sender: { id: '456', name: 'Other allowed sender' }, directMention: true })).request).toBeNull();
      }
      store.upsertEndpoint({ ...dm, people: [{ ...human, isBot: true }] });
      // Incoming role is incomplete; the stored bot classification must still win.
      expect(store.ingest(message(dm, `known-bot-dm-${platform}`, { sender: human, directMention: true })).request).toBeNull();
      expect(store.getConversation(conversation.id)?.bindings[0].allowAllSenders).toBe(false);
    }
  });

  it('does not claim an unreadable stored rule or provision an undefined rule', () => {
    const file = path(); const store = open(file);
    expect(store.ingest(message(), { rule: undefined as unknown as AutoLinkRule, targetFingerprint: 'profile' }).autoLinkIntent).toBeUndefined();
    const intent = accept(store, message(endpoint(), 'valid'));
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE auto_link_intents SET rule='{}' WHERE id=?").run(intent.id);
    raw.close();
    expect(store.claimAutoLinkIntent(intent.id)).toBeUndefined();
    expect(store.getAutoLinkIntent(intent.id)?.status).toBe('pending');
  });
});


describe('source access and routing', () => {
  it('fences older schema-five binaries without rewriting bindings, requests or source policies', () => {
    const file = path(); const store = open(file); const ep = endpoint(); store.upsertEndpoint(ep);
    const conversation = store.createConversation({ name: 'Retained', threadId: 'schema-fence', cwd: '/fixture', bindings: [
      { platform: 'slack', endpointId: ep.id, allowedSenderIds: ['U1'] },
    ] });
    const accepted = store.ingest(message(ep, 'before-upgrade')).request!;
    store.setSourceAccess(ep.id, { mode: 'off' });
    const access = store.getSourceAccess(ep.id);
    store.close();
    const old = new DatabaseSync(file);
    dropSourceVersionSchema(old);
    old.exec("DROP TABLE tool_outbox; DELETE FROM meta WHERE key='source-policy-version'; ALTER TABLE requests DROP COLUMN images; PRAGMA user_version=5;"); old.close();
    const upgraded = open(file);
    expect(upgraded.getConversation(conversation.id)).toEqual(conversation);
    expect(upgraded.getRequest(accepted.id)).toEqual(accepted);
    expect(upgraded.getSourceAccess(ep.id)).toEqual(access);
    expect(upgraded.getMeta('source-policy-version')).toBe('1');
    const check = new DatabaseSync(file);
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(9);
    expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]); check.close();
    expect(upgraded.ingest(message(ep, 'still-off')).request).toBeNull();
  });

  it('defaults new sources to off and preserves legacy ACL until access is explicitly chosen', () => {
    const store = open(); const ep = endpoint(); store.upsertEndpoint(ep);
    expect(store.getSourceAccess(ep.id)).toEqual({ endpointId: ep.id, mode: 'off', allowedSenderIds: [], legacy: false });
    const conv = store.createConversation({ name: 'Existing', threadId: 'legacy-source', cwd: '/fixture', bindings: [
      { platform: 'slack', endpointId: ep.id, allowedSenderIds: ['U1'] },
    ] });
    const binding = conv.bindings[0];
    expect(store.getSourceAccess(ep.id)).toMatchObject({ mode: 'all', legacy: true, allowedSenderIds: ['U1'] });
    expect(store.ingest(message(ep, 'legacy-denied', { sender: { id: 'UNEW', name: 'New member' } })).request).toBeNull();
    store.setSourceAccess(ep.id, { mode: 'mention', allowedSenderIds: [] });
    const peer = { id: 'UAGENT', name: 'Agent', isBot: true };
    expect(store.ingest(message(ep, 'unmentioned-agent', { sender: peer })).request).toBeNull();
    expect(store.ingest(message(ep, 'mentioned-agent', { sender: peer, directMention: true })).request).toBeTruthy();
    store.setSourceAccess(ep.id, { mode: 'all' });
    expect(store.ingest(message(ep, 'all-agent', { sender: peer })).request).toBeTruthy();
    expect(store.getBinding(conv.id, binding.id)).toEqual(binding);
  });

  it('stops only the selected source while retaining accepted requests and captured context', () => {
    const store = open(); const first = endpoint(); const second = endpoint('neighbor');
    for (const ep of [first, second]) store.upsertEndpoint(ep);
    const conv = store.createConversation({ name: 'Shared', threadId: 'off-shared', cwd: '/fixture', bindings: [first, second].map(ep =>
      ({ platform: ep.platform, endpointId: ep.id, allowedSenderIds: ['U1'] })) });
    const accepted = store.ingest(message(first, 'accepted-before-off')).request!;
    const stream = store.listSlackSyncStreams().find(stream => stream.endpointId === first.id)!;
    const captured = store.listSlackSyncEntries(stream.id);
    store.setSourceAccess(first.id, { mode: 'off' });
    expect(store.ingest(message(first, 'off-task')).request).toBeNull();
    expect(store.listSlackSyncEntries(stream.id)).toEqual(captured);
    expect(store.getSlackSyncStream(stream.id)?.active).toBe(false);
    expect(store.ingest(message(second, 'neighbor-still-on')).request?.conversationId).toBe(conv.id);
    expect(store.getRequest(accepted.id)).toEqual(accepted);
    store.setSourceAccess(first.id, { mode: 'all' });
    expect(store.ingest(message(first, 'off-task')).request).toBeNull();
    expect(store.ingest(message(first, 'fresh-after-on')).request).toBeTruthy();
  });

  it('requires selected humans in direct messages and keeps explicit mention mode separate from legacy DM behavior', () => {
    const store = open(); const human = { id: 'U1', name: 'Human' }; const bot = { id: 'UBOT', name: 'Bot', isBot: true };
    const ep = { ...endpoint(), chatId: 'DPRIVATE', people: [human, bot] }; store.upsertEndpoint(ep);
    const conv = store.createConversation({ name: 'DM', threadId: 'dm-access', cwd: '/fixture' });
    store.routeSource(ep.id, conv.id);
    expect(store.getSourceAccess(ep.id).mode).toBe('off');
    for (const ids of [[], [bot.id], ['UNKNOWN']]) expect(() => store.setSourceAccess(ep.id, { mode: 'all', allowedSenderIds: ids })).toThrow(/human/);
    store.setSourceAccess(ep.id, { mode: 'all', allowedSenderIds: [human.id] });
    expect(store.ingest(message(ep, 'human-dm')).request).toBeTruthy();
    expect(store.ingest(message(ep, 'bot-dm', { sender: bot, directMention: true })).request).toBeNull();
    store.setSourceAccess(ep.id, { mode: 'mention' });
    expect(store.ingest(message(ep, 'human-unmentioned')).request).toBeNull();
    expect(store.ingest(message(ep, 'human-mentioned', { directMention: true })).request).toBeTruthy();
    store.setSourceAccess(ep.id, { mode: 'off' });
    expect(store.getSourceAccess(ep.id).mode).toBe('off');
  });

  it('moves a source atomically after completion while preserving binding identity and old destinations', () => {
    const store = open(); const ep = endpoint(); store.upsertEndpoint(ep);
    const original = store.createConversation({ name: 'Original', threadId: 'route-original', cwd: '/fixture', bindings: [
      { platform: 'slack', endpointId: ep.id, allowedSenderIds: ['U1'] },
    ] });
    const target = store.createConversation({ name: 'Target', threadId: 'route-target', cwd: '/fixture' });
    const binding = original.bindings[0]; const request = store.ingest(message(ep, 'original-task')).request!;
    const oldStream = store.listSlackSyncStreams()[0];
    for (const status of ['queued', 'running', 'uncertain'] as const) {
      store.updateRequest(request.id, { status });
      expect(() => store.routeSource(ep.id, target.id)).toThrow(/принятые запросы/);
      expect(() => store.routeSourceToThread(ep.id, { name: 'Must roll back', threadId: `orphan-${status}`, cwd: '/fixture' })).toThrow(/принятые запросы/);
      expect(store.listConversations()).toHaveLength(2);
      expect(store.bindingForEndpoint(ep.id)).toEqual(binding);
    }
    store.finishRequest(request.id, { status: 'completed' }, []);
    const accepted = store.getRequest(request.id);
    expect(store.routeSource(ep.id, target.id)).toEqual({ endpointId: ep.id, mode: 'manual' });
    expect(store.bindingForEndpoint(ep.id)).toEqual({ ...binding, conversationId: target.id });
    expect(store.getRequest(request.id)).toEqual(accepted);
    expect(store.getSlackSyncStream(oldStream.id)).toMatchObject({ active: false, codexThreadId: original.threadId });
    expect(store.ingest(message(ep, 'new-destination')).request?.conversationId).toBe(target.id);
  });

  it('retains exact legacy ACL across unbinding, rebinding and automatic routing without widening sender access', () => {
    const store = open(); const ep = endpoint(); store.upsertEndpoint(ep);
    const selectedBot = { id: 'UAGENT', name: 'Selected agent', isBot: true }; const outsider = { id: 'UNEW', name: 'New member' };
    const original = store.createConversation({ name: 'Legacy', threadId: 'legacy-rights', cwd: '/fixture', bindings: [
      { platform: 'slack', endpointId: ep.id, allowedSenderIds: ['U1', selectedBot.id] },
    ] });
    const access = store.getSourceAccess(ep.id);
    store.routeSource(ep.id, null);
    expect(store.getSourceAccess(ep.id)).toEqual(access);
    expect(store.getSourceRoute(ep.id).mode).toBe('none');
    store.routeSource(ep.id, original.id);
    expect(store.bindingForEndpoint(ep.id)?.allowedSenderIds).toEqual(['U1', selectedBot.id]);
    expect(store.ingest(message(ep, 'legacy-outsider', { sender: outsider, directMention: true })).request).toBeNull();
    expect(store.ingest(message(ep, 'legacy-bot-unmentioned', { sender: selectedBot })).request).toBeNull();
    const request = store.ingest(message(ep, 'legacy-bot-called', { sender: selectedBot, directMention: true })).request!;
    expect(request.conversationId).toBe(original.id);
    store.finishRequest(request.id, { status: 'completed' }, []);
    store.routeSource(ep.id, null, '/legacy-auto');
    expect(store.getSourceAccess(ep.id)).toEqual(access);
    const automatic = store.getSourceAutoRule(ep.id)!;
    expect(automatic).toMatchObject({ allowAllSenders: false, allowedSenderIds: ['U1', selectedBot.id], requireMention: false });
    expect(store.ingest(message(ep, 'auto-outsider', { sender: outsider, directMention: true }), auto(automatic)).autoLinkIntent).toBeUndefined();
    expect(store.ingest(message(ep, 'auto-bot-unmentioned', { sender: selectedBot }), auto(automatic)).autoLinkIntent).toBeUndefined();
    expect(store.ingest(message(ep, 'auto-bot-called', { sender: selectedBot, directMention: true }), auto(automatic)).autoLinkIntent).toBeTruthy();
    store.setSourceAccess(ep.id, { mode: 'all', allowedSenderIds: [] });
    expect(store.getSourceAccess(ep.id)).toMatchObject({ mode: 'all', legacy: false });
    expect(store.getSourceAutoRule(ep.id)?.allowAllSenders).toBe(true);
  });

  it('retains legacy all-participant mention policy across automatic routing and fails closed on a corrupt snapshot', () => {
    const store = open(); const ep = endpoint(); store.upsertEndpoint(ep);
    store.createConversation({ name: 'Legacy group', threadId: 'legacy-all-rights', cwd: '/fixture', bindings: [
      { platform: 'slack', endpointId: ep.id, allowedSenderIds: [], allowAllSenders: true, requireMention: true },
    ] });
    store.routeSource(ep.id, null, '/legacy-all-auto');
    expect(store.getSourceAccess(ep.id)).toMatchObject({ mode: 'mention', legacy: true });
    expect(store.getSourceAutoRule(ep.id)).toMatchObject({ requireMention: true, allowAllSenders: true, allowedSenderIds: [] });
    store.setMeta(`source-access:${ep.id}`, JSON.stringify({ mode: 'all', allowedSenderIds: ['U1'], legacy: true }));
    expect(store.getSourceAccess(ep.id)).toMatchObject({ mode: 'off', legacy: false });
    expect(store.getSourceAutoRule(ep.id)).toBeUndefined();
    expect(store.ingest(message(ep, 'corrupt-legacy', { directMention: true }), auto(rule(ep))).autoLinkIntent).toBeUndefined();
  });

  it('keeps an acknowledged native ID without binding or promoting after source access turns off', () => {
    const store = open(); const ep = endpoint(); store.upsertEndpoint(ep);
    store.routeSource(ep.id, null, '/source-project'); store.setSourceAccess(ep.id, { mode: 'all', allowedSenderIds: [] });
    const effective = store.getSourceAutoRule(ep.id)!;
    const intent = accept(store, message(ep, 'accepted-source-create'), auto(effective));
    expect(store.claimAutoLinkIntent(intent.id)?.status).toBe('creating');
    store.updateAutoLinkIntent(intent.id, { status: 'created', threadId: 'keep-acknowledged-native' });
    store.setSourceAccess(ep.id, { mode: 'off' });
    expect(store.finalizeAutoLinkIntent(intent.id)).toBeUndefined();
    expect(store.bindingForEndpoint(ep.id)).toBeUndefined();
    expect(store.listRequests()).toEqual([]);
    expect(store.getAutoLinkIntent(intent.id)).toMatchObject({ status: 'created', threadId: 'keep-acknowledged-native' });
  });

  it('persists endpoint-only auto creation and explicit none independently from legacy chat rules', () => {
    const file = path(); const store = open(file); const ep = endpoint(); const neighbor = { ...endpoint('same-chat-neighbor'), chatId: ep.chatId };
    for (const value of [ep, neighbor]) store.upsertEndpoint(value);
    const legacy = rule(ep);
    expect(store.getSourceAutoRule(ep.id, legacy)).toEqual(legacy);
    store.routeSource(ep.id, null, '/source-project');
    expect(store.getSourceAutoRule(ep.id, legacy)).toBeUndefined();
    expect(store.getSourceRoute(ep.id)).toEqual({ endpointId: ep.id, mode: 'auto', cwd: '/source-project' });
    store.setSourceAccess(ep.id, { mode: 'mention', allowedSenderIds: [] });
    const effective = store.getSourceAutoRule(ep.id)!;
    expect(effective).toMatchObject({ id: `source:${ep.id}`, cwd: '/source-project', allowedSenderIds: [], allowAllSenders: true, requireMention: true });
    expect(store.getSourceAutoRule(neighbor.id)).toBeUndefined();
    expect(store.ingest(message(ep, 'no-mention'), auto(effective)).autoLinkIntent).toBeUndefined();
    const intent = accept(store, message(ep, 'source-trigger', { directMention: true }), auto(effective));
    expect(intent.rule).toEqual(effective);
    expect(() => store.routeSource(ep.id, null)).toThrow(/автосоздание/);
    store.setSourceAccess(ep.id, { mode: 'off' });
    expect(store.getSourceAutoRule(ep.id, legacy)).toBeUndefined();
    expect(store.claimAutoLinkIntent(intent.id)).toBeUndefined();
    store.routeSource(neighbor.id, null);
    expect(store.getSourceAutoRule(neighbor.id, legacy)).toBeUndefined();
    store.close();
    const reopened = open(file);
    expect(reopened.getSourceRoute(ep.id, legacy)).toEqual({ endpointId: ep.id, mode: 'auto', cwd: '/source-project' });
    expect(reopened.getSourceRoute(neighbor.id, legacy)).toEqual({ endpointId: neighbor.id, mode: 'none' });
    expect(reopened.getSourceAccess(ep.id, legacy)).toMatchObject({ mode: 'off', legacy: false });
    expect(reopened.getAutoLinkIntent(intent.id)).toEqual(intent);
  });

  it('preserves config-only legacy ACL on first manual or automatic route without enabling fresh sources', () => {
    const store = open(); const selectedBot = { id: 'UAGENT', name: 'Agent', isBot: true };
    const outsider = { id: 'UNEW', name: 'Other member' };
    for (const mode of ['manual', 'auto', 'none'] as const) {
      const ep = endpoint(`config-legacy-${mode}`); store.upsertEndpoint(ep);
      const legacy = rule(ep, { allowedSenderIds: ['U1', selectedBot.id], requireMention: false });
      const before = store.getSourceAccess(ep.id, legacy);
      if (mode === 'manual') store.routeSourceToThread(ep.id, { threadId: 'manual-config-legacy', cwd: '/fixture', name: 'Existing' }, undefined, legacy);
      else store.routeSource(ep.id, null, mode === 'auto' ? '/fixture' : undefined, legacy);
      expect(store.getSourceAccess(ep.id)).toEqual(before);
      const effective = store.getSourceAutoRule(ep.id, legacy);
      expect(store.ingest(message(ep, `outsider-${mode}`, { sender: outsider, directMention: true }), effective && auto(effective)).request).toBeNull();
      expect(store.ingest(message(ep, `agent-${mode}`, { sender: selectedBot }), effective && auto(effective)).autoLinkIntent).toBeUndefined();
      if (mode === 'auto') expect(effective).toMatchObject({ allowAllSenders: false, allowedSenderIds: legacy.allowedSenderIds });
    }
    const fresh = endpoint('fresh-route'); store.upsertEndpoint(fresh);
    store.routeSourceToThread(fresh.id, { threadId: 'fresh-native', cwd: '/fixture', name: 'Fresh' });
    expect(store.getSourceAccess(fresh.id)).toMatchObject({ mode: 'off', legacy: false });
  });

  it('blocks ordinary rerouting while any accepted auto creation is unresolved and rolls back new metadata', () => {
    const store = open();
    for (const status of ['pending', 'creating', 'uncertain', 'failed', 'created'] as const) {
      const ep = endpoint(`busy-intent-${status}`);
      const intent = accept(store, message(ep, `accepted-${status}`), auto(rule(ep)));
      if (status !== 'pending') store.updateAutoLinkIntent(intent.id, { status, ...(status === 'created' ? { threadId: `created-${status}` } : {}) });
      const before = store.getAutoLinkIntent(intent.id);
      expect(() => store.routeSource(ep.id, null)).toThrow(/автосоздание/);
      expect(() => store.routeSource(ep.id, null, '/different')).toThrow(/автосоздание/);
      expect(() => store.routeSourceToThread(ep.id, { threadId: `must-not-link-${status}`, cwd: '/fixture', name: 'No orphan' })).toThrow(/автосоздание/);
      expect(store.listConversations()).toEqual([]);
      expect(store.getAutoLinkIntent(intent.id)).toEqual(before);
      expect(store.bindingForEndpoint(ep.id)).toBeUndefined();
    }
  });

  it('recovers only the matching uncertain, failed or created intent and promotes its events once', () => {
    const store = open();
    for (const status of ['uncertain', 'failed', 'created'] as const) {
      const ep = endpoint(`recover-${status}`); const selected = rule(ep, { cwd: 'c:\\fixture\\project\\' });
      const intent = accept(store, message(ep, `recover-event-${status}`), auto(selected));
      store.updateAutoLinkIntent(intent.id, { status, ...(status === 'created' ? { threadId: `native-${status}` } : {}) });
      const input = { threadId: `native-${status}`, cwd: 'C:/fixture/project', name: 'Recovered' };
      expect(() => store.routeSourceToThread(ep.id, { ...input, cwd: 'C:/different' }, intent.id)).toThrow(/папка/);
      if (status === 'created') expect(() => store.routeSourceToThread(ep.id, { ...input, threadId: 'different-native' }, intent.id)).toThrow(/не совпадает/);
      expect(store.listConversations()).toHaveLength(status === 'uncertain' ? 0 : status === 'failed' ? 1 : 2);
      store.routeSourceToThread(ep.id, input, intent.id, selected);
      const binding = store.bindingForEndpoint(ep.id)!;
      expect(store.getConversation(binding.conversationId)).toMatchObject({ threadId: input.threadId, cwd: input.cwd });
      expect(store.getAutoLinkIntent(intent.id)?.status).toBe(status);
      expect(store.finalizeAutoLinkIntent(intent.id)?.id).toBe(binding.conversationId);
      expect(store.listRequests().filter(request => request.origin.endpointId === ep.id)).toHaveLength(1);
      expect(store.getAutoLinkIntent(intent.id)?.status).toBe('completed');
      expect(() => store.routeSourceToThread(ep.id, input, intent.id)).toThrow(/автосоздание/);
    }
    const ep = endpoint('bad-recovery'); const intent = accept(store, message(ep), auto(rule(ep)));
    const other = endpoint('other-recovery'); store.upsertEndpoint(other);
    const input = { threadId: 'wrong-recovery', cwd: '/fixture', name: 'No orphan' };
    expect(() => store.routeSourceToThread(ep.id, input, 'missing')).toThrow(/автосоздание/);
    expect(() => store.routeSourceToThread(other.id, input, intent.id)).toThrow(/автосоздание/);
    for (const status of ['pending', 'creating'] as const) {
      store.updateAutoLinkIntent(intent.id, { status });
      expect(() => store.routeSourceToThread(ep.id, input, intent.id)).toThrow(/автосоздание/);
    }
    expect(store.listConversations()).toHaveLength(3);
    expect(store.bindingForEndpoint(ep.id)).toBeUndefined();
  });

});
