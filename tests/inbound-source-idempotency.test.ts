import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import type { Endpoint, InboundMessage, Person } from '../src/shared/types.js';

const directories: string[] = [], stores: Store[] = [];
const sender: Person = { id: '123', name: 'Original human', isBot: false };
function open(file?: string): Store {
  if (!file) { const directory = mkdtempSync(path.join(tmpdir(), 'rele-inbound-source-')); directories.push(directory); file = path.join(directory, 'rele.sqlite'); }
  const store = new Store(file); stores.push(store); return store;
}
function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return { id: 'telegram:999:-100123:42', platform: 'telegram', accountId: '999', chatId: '-100123', threadId: '42', title: 'Source group', subtitle: 'Synthetic topic', people: [sender], updatedAt: '2026-10-30T00:00:00Z', ...overrides };
}
function bind(store: Store, ep = endpoint(), nativeThread = 'native-1') {
  store.upsertEndpoint(ep); const conversation = store.createConversation({ name: 'Source fixture', threadId: nativeThread, cwd: '/synthetic', bindings: [{ platform: ep.platform, endpointId: ep.id, allowedSenderIds: [sender.id, 'UOWNER'] }] });
  store.setSourceAccess(ep.id, { mode: 'all' }); return conversation;
}
function message(ep = endpoint(), overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { eventId: 'update-1', endpoint: ep, sender, messageId: '100', text: 'One source message', ...overrides };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('Durable source-message ingress idempotency', () => {
  it('uses the same request across new delivery IDs, metadata refresh and restart', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rele-inbound-reopen-')); directories.push(directory); const file = path.join(directory, 'rele.sqlite');
    const store = open(file); bind(store); const incoming = message(), first = store.ingest(incoming).request!;
    expect(first).toBeTruthy();
    const replay = store.ingest({ ...incoming, eventId: 'update-2', sender: { ...sender, name: 'Refreshed profile', isBot: undefined }, participants: [{ id: '456', name: 'Later participant', isBot: true }], endpoint: { ...incoming.endpoint, title: 'Refreshed group', updatedAt: '2026-10-30T01:00:00Z' } });
    expect(replay.duplicate).toBe(true); expect(replay.request?.id).toBe(first.id); expect(replay.request?.origin).toEqual(first.origin);
    store.close(); const reopened = open(file);
    expect(reopened.ingest({ ...incoming, eventId: 'update-3' })).toMatchObject({ duplicate: true, request: { id: first.id } });
    expect(reopened.listRequests()).toHaveLength(1);
  });

  it('keeps consumed replies and ignored messages consumed after delivery/policy changes', () => {
    const store = open(), ep = endpoint(), conversation = bind(store, ep);
    const reply = message(ep, { eventId: 'reply-1', messageId: '101', text: 'Already consumed clarification', replyToMessageId: '90' });
    expect(store.recordInbound(reply)).toEqual({ duplicate: false });
    expect(store.ingest({ ...reply, eventId: 'reply-2', replyToMessageId: undefined })).toEqual({ duplicate: true, request: null });
    store.setSourceAccess(ep.id, { mode: 'off' }); const ignored = message(ep, { eventId: 'off-1', messageId: '102' });
    expect(store.ingest(ignored).request).toBeNull(); store.setSourceAccess(ep.id, { mode: 'all' });
    expect(store.ingest({ ...ignored, eventId: 'off-2', directMention: true })).toEqual({ duplicate: true, request: null });
    store.updateConversation(conversation.id, { paused: true }); const paused = message(ep, { eventId: 'paused-1', messageId: '103' });
    expect(store.ingest(paused).request).toBeNull(); store.updateConversation(conversation.id, { paused: false });
    expect(store.ingest({ ...paused, eventId: 'paused-2' })).toEqual({ duplicate: true, request: null }); expect(store.listRequests()).toHaveLength(0);
  });

  it('preserves genuine text/audio changes and explicit copies with another message ID', () => {
    const store = open(); bind(store); const original = message(), first = store.ingest(original).request!;
    const changed = store.ingest({ ...original, eventId: 'edited-delivery', text: 'Genuinely changed text' }).request!;
    expect(changed.id).not.toBe(first.id); expect(store.getRequest(first.id)?.text).toBe(original.text);
    const audio = message(endpoint(), { eventId: 'audio-1', messageId: '104', text: '', audio: { platform: 'telegram', fileId: 'media-A', url: 'https://example.invalid/download-a', name: 'voice.ogg', mimeType: 'audio/ogg', size: 100 } });
    const voice = store.ingest(audio).request!;
    expect(store.ingest({ ...audio, eventId: 'audio-retry', audio: { ...audio.audio!, url: 'https://example.invalid/download-b' } })).toMatchObject({ duplicate: true, request: { id: voice.id } });
    expect(store.ingest({ ...audio, eventId: 'audio-renamed', audio: { ...audio.audio!, name: 'recording.ogg' } }).request?.id).not.toBe(voice.id);
    expect(store.ingest({ ...audio, eventId: 'audio-edited', audio: { ...audio.audio!, fileId: 'media-B' } }).request?.id).not.toBe(voice.id);
    expect(store.ingest({ ...audio, eventId: 'audio-copy', messageId: '105' }).request?.id).not.toBe(voice.id);
    expect(store.ingest({ ...original, eventId: 'explicit-text-copy', messageId: '106' }).request?.id).not.toBe(first.id);
  });

  it('keeps different account/chat/thread sources separate despite the same message ID and text', () => {
    const store = open(), eps = [endpoint(), endpoint({ id: 'other-account', accountId: '998' }), endpoint({ id: 'other-chat', chatId: '-100456' }), endpoint({ id: 'other-thread', threadId: '43' })];
    const ids = eps.map((ep, index) => { bind(store, ep, `native-${index}`); return store.ingest(message(ep, { eventId: `source-${index}` })).request?.id; });
    expect(ids.every(Boolean)).toBe(true); expect(new Set(ids).size).toBe(eps.length);
  });

  it('does not create a second steering identity when the queued child is redelivered', () => {
    const store = open(); bind(store);
    const parent = store.ingest(message()).request!; store.updateRequest(parent.id, { status: 'running', turnId: 'native-active-turn' });
    const incoming = message(endpoint(), { eventId: 'child-1', messageId: '107', text: 'Add one detail' });
    const child = store.ingest(incoming).request!, input = store.beginSteeringInput(parent.id, { id: child.id, requestId: child.id, text: 'Original exact steering body' });
    expect(store.ingest({ ...incoming, eventId: 'child-2' })).toMatchObject({ duplicate: true, request: { id: child.id, turnId: parent.turnId ?? 'native-active-turn' } });
    store.finishSteeringInput(input.id, 'applied');
    expect(store.ingest({ ...incoming, eventId: 'child-3' })).toMatchObject({ duplicate: true, request: { id: child.id, status: 'completed' } });
    expect(store.listRequests()).toHaveLength(2); expect(store.steeringInputs(parent.id).map(row => row.id)).toEqual([child.id]);
  });

  it('deduplicates ordinary Slack ingress across structural block IDs without erasing literal user JSON', () => {
    const store = open(), ep = endpoint({ id: 'slack:TTEAM:UBOT:CONE:1000.000001', platform: 'slack', accountId: 'TTEAM:UBOT', chatId: 'CONE', threadId: '1000.000001' }); bind(store, ep);
    const author = { id: 'UOWNER', name: 'Slack author', isBot: false }, text = 'Literal user data: {"block_id":"meaningful-A"}';
    const make = (eventId: string, blockId: string, body = text): InboundMessage => message(ep, { eventId, sender: author, messageId: '1000.000002', text: body, slack: { endpointId: ep.id, accountId: ep.accountId, chatId: ep.chatId, threadId: ep.threadId, messageId: '1000.000002', sender: author, kind: 'message', text: body, payload: { text: body, blocks: [{ type: 'section', block_id: blockId, text: { type: 'mrkdwn', text: body } }] } } });
    const first = store.ingest(make('delivery-A', 'layout-random-A')).request!;
    expect(store.ingest(make('delivery-B', 'layout-random-B'))).toMatchObject({ duplicate: true, request: { id: first.id } });
    const changed = store.ingest(make('delivery-C', 'layout-random-C', 'Literal user data: {"block_id":"meaningful-B"}')).request!;
    expect(changed.id).not.toBe(first.id); expect(changed.text).toContain('meaningful-B');
  });
});
