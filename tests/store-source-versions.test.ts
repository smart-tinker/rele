import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import type { Endpoint, SlackTranscriptMessage } from '../src/shared/types.js';

const roots: string[] = [], stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }); });
function open(file: string) { const s = new Store(file); stores.push(s); return s; }
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'rele-source-version-')); roots.push(root);
  const file = path.join(root, 'rele.sqlite'), store = open(file);
  const endpoint: Endpoint = { id: 'source', platform: 'slack', accountId: 'team:bot', chatId: 'channel', threadId: '100.000001', title: 'Fixture', subtitle: 'Slack', people: [], updatedAt: new Date().toISOString() };
  store.upsertEndpoint(endpoint);
  const conversation = store.createConversation({ name: 'Fixture', threadId: 'native-thread', cwd: root, bindings: [{ platform: 'slack', endpointId: endpoint.id, allowedSenderIds: ['human'] }] });
  const message = (id: string, text = 'Literal {"block_id":"user-data"}'): SlackTranscriptMessage => ({ endpointId: endpoint.id, accountId: endpoint.accountId, chatId: endpoint.chatId, threadId: endpoint.threadId, messageId: id,
    sender: { id: 'agent', name: 'Agent', isBot: true }, kind: 'message', text,
    payload: { text, blocks: [{ type: 'section', block_id: randomUUID(), text: { type: 'mrkdwn', text } }], attachments: [{ blocks: [{ type: 'section', block_id: randomUUID(), text: { type: 'plain_text', text: 'Attachment' } }] }] } });
  return { file, store, endpoint, conversation, message };
}
function downgrade(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`DROP TABLE inbound_source_versions; DROP INDEX slack_sync_semantic_source; DROP INDEX slack_sync_aliases;
    ALTER TABLE slack_sync_entries DROP COLUMN canonical_entry_id; ALTER TABLE slack_sync_entries DROP COLUMN semantic_revision; ALTER TABLE requests DROP COLUMN images; PRAGMA user_version=7;`);
  return db;
}

describe('Persistent transcript source versions', () => {
  it('imports 67 sources once across 14 block-ID variants and a journal restart, retaining real content changes', () => {
    const f = fixture(); let store = f.store;
    const ids = new Map<string, string>();
    for (let pass = 0; pass < 14; pass++) {
      for (let i = 0; i < 67; i++) {
        const source = `${101 + i}.000001`, entry = store.recordSlackMessage(f.message(source))!;
        if (!pass) ids.set(source, entry.id); else expect(entry.id).toBe(ids.get(source));
      }
      if (pass === 6) { store.close(); store = open(f.file); }
    }
    const stream = store.listSlackSyncStreams()[0];
    expect(store.listSlackSyncEntries(stream.id)).toHaveLength(67);
    expect(store.getSlackSyncCounts(stream.id)).toEqual({ pending: 67, applying: 0, applied: 0, uncertain: 0 });
    const original = f.message('101.000001');
    const edited = store.recordSlackMessage({ ...original, kind: 'edit', text: 'Real edit' })!;
    expect(edited.id).not.toBe(ids.get(original.messageId));
    const fileChanged = store.recordSlackMessage({ ...original, payload: { ...original.payload, files: [{ id: 'new-file', name: 'changed.txt' }] } })!;
    expect(fileChanged.id).not.toBe(ids.get(original.messageId));
    const attachmentChanged = store.recordSlackMessage({ ...original, payload: { ...original.payload, attachments: [{ text: 'Changed attachment' }] } })!;
    expect(attachmentChanged.id).not.toBe(ids.get(original.messageId));
    expect(store.recordSlackMessage(f.message('500.000001'))!.id).not.toBe(ids.get(original.messageId));
    const journal = new DatabaseSync(f.file, { readOnly: true });
    try { expect(journal.prepare('SELECT COUNT(*) AS n FROM slack_sync_entries').get()?.n).toBe(71); } finally { journal.close(); }
  });

  it('migrates applied and uncertain legacy groups without changing raw receipt text, IDs or states', () => {
    const f = fixture(), first = f.store.recordSlackMessage(f.message('101.000001'))!, second = f.store.recordSlackMessage(f.message('102.000001'))!;
    f.store.updateSlackSyncEntry(first.id, { state: 'applied' }); f.store.updateSlackSyncEntry(second.id, { state: 'uncertain' }); f.store.close();
    const old = downgrade(f.file), duplicate = old.prepare(`INSERT INTO slack_sync_entries(id,stream_id,message_id,message_order,revision,message,state,created_at,updated_at)
      SELECT ?,stream_id,message_id,message_order,?, ?, ?,created_at,updated_at FROM slack_sync_entries WHERE id=?`);
    const aliasIds = [randomUUID(), randomUUID(), randomUUID()];
    duplicate.run(aliasIds[0], 'legacy-variant-1', JSON.stringify(f.message(first.messageId)), 'uncertain', first.id);
    duplicate.run(aliasIds[1], 'legacy-variant-2', JSON.stringify(f.message(first.messageId)), 'pending', first.id);
    duplicate.run(aliasIds[2], 'legacy-variant-3', JSON.stringify(f.message(second.messageId)), 'pending', second.id);
    const raw = old.prepare('SELECT id,revision,message,state,request_id,created_at FROM slack_sync_entries ORDER BY id').all(); old.close();
    const store = open(f.file), stream = store.listSlackSyncStreams()[0];
    expect(store.getSlackSyncCounts(stream.id)).toEqual({ applied: 1, uncertain: 1, pending: 0, applying: 0 });
    expect(store.listPendingSlackSyncEntries(f.conversation.id).map(e => e.id)).toEqual([second.id]);
    expect(store.listSlackSyncReceiptEntries(first.id).map(e => e.id)).toEqual([first.id, aliasIds[0], aliasIds[1]]);
    expect(store.listSlackSyncReceiptEntries(second.id).map(e => e.id)).toEqual([second.id, aliasIds[2]]);
    for (const id of aliasIds) expect(store.claimSlackSyncEntry(id)).toBeUndefined();
    expect(store.recordSlackMessage(f.message(first.messageId))!.id).toBe(first.id);
    expect(store.recordSlackMessage(f.message(second.messageId))!.id).toBe(second.id);
    const check = new DatabaseSync(f.file, { readOnly: true });
    try { expect(check.prepare('SELECT id,revision,message,state,request_id,created_at FROM slack_sync_entries ORDER BY id').all()).toEqual(raw); expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(9); } finally { check.close(); }
    store.close(); const reopened = open(f.file);
    expect(reopened.listSlackSyncEntries(stream.id).map(e => e.id)).toEqual([first.id, second.id]);
  });
});
