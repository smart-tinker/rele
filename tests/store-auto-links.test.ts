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
    old.exec(`CREATE TABLE bindings_v4 (
      id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      platform TEXT NOT NULL CHECK(platform IN ('slack','telegram')), endpoint_id TEXT NOT NULL UNIQUE,
      allowed_sender_ids TEXT NOT NULL CHECK(json_valid(allowed_sender_ids) AND json_type(allowed_sender_ids)='array'),
      UNIQUE(conversation_id,platform), FOREIGN KEY(endpoint_id,platform) REFERENCES endpoints(id,platform)
    ) STRICT;
    INSERT INTO bindings_v4(rowid,id,conversation_id,platform,endpoint_id,allowed_sender_ids)
      SELECT rowid,id,conversation_id,platform,endpoint_id,allowed_sender_ids FROM bindings;
    DROP TABLE bindings; ALTER TABLE bindings_v4 RENAME TO bindings;
    DROP INDEX inbound_auto_link; ALTER TABLE inbound_events DROP COLUMN auto_link_intent_id;
    DROP TABLE auto_link_intents; PRAGMA user_version=4;`);
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
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(5);
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
