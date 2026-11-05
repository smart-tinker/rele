import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore, defaultConfig, mergeConfig } from '../src/server/config.js';
import { setupSharedCodex } from '../src/server/codex-setup.js';
import { acquireGatewayLock } from '../src/server/gateway-lock.js';
import { Store } from '../src/server/store.js';
import type { AutoLinkRule, CodexConnectionTarget, Endpoint, InboundMessage } from '../src/shared/types.js';

const directories: string[] = [];
const servers: Server[] = [];
const stores: Store[] = [];

async function close(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const server of servers.splice(0)) await close(server);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function localEndpoint(): Promise<{ server: Server; endpoint: string }> {
  const server = createServer(socket => socket.destroy());
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an isolated loopback port.');
  return { server, endpoint: `ws://127.0.0.1:${address.port}` };
}

async function fixture(codex: Partial<CodexConnectionTarget & { token?: string }> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'rele-setup-')));
  directories.push(root);
  const home = path.join(root, 'native-home'), directory = path.join(root, 'data');
  await mkdir(home); await mkdir(directory, { mode: 0o700 });
  const rule: AutoLinkRule = { id: 'existing-rule', enabled: true, platform: 'slack', accountId: 'TTEST:UBOT', chatId: 'CTEST',
    cwd: home, allowedSenderIds: ['UHUMAN'], requireMention: true };
  const config = new ConfigStore(directory);
  config.panelToken = 'a'.repeat(64);
  await config.save(mergeConfig(defaultConfig, {
    codex: { transport: 'managed', executable: 'codex', endpoint: '', codexHome: home },
    telegram: { enabled: false, token: '123456:synthetic_telegram_token_123456' },
    slack: { enabled: false, botToken: 'SLACK_TOKEN_PLACEHOLDER_6836699', appToken: 'SLACK_TOKEN_PLACEHOLDER_9130938' },
    autoLinkRules: [rule],
  }));
  if (Object.keys(codex).length) await config.save({ ...config.config, codex: { ...config.config.codex, ...codex } });
  const file = path.join(directory, 'config.json');
  const original = await readFile(file), saved = structuredClone(config.config);
  const env = { CODEX_HOME: home, RELE_SYNTHETIC_SETUP_ENV: 'preserved' };
  const verify = vi.fn(async (_target: CodexConnectionTarget, _env: NodeJS.ProcessEnv): Promise<void> => {});
  return { root, home, directory, config, file, original, saved, env, verify };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function backups(f: Fixture): Promise<string[]> {
  return readdir(path.join(f.directory, 'backups')).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
}

async function unchanged(f: Fixture): Promise<void> {
  expect(await readFile(f.file)).toEqual(f.original);
  expect(await backups(f)).toEqual([]);
}

function endpoint(id = 'source'): Endpoint {
  return { id, platform: 'slack', accountId: 'TTEST:UBOT', chatId: id === 'source' ? 'CTEST' : 'CAUTO', threadId: '100.000001',
    title: 'Synthetic source', subtitle: 'Test', people: [{ id: 'UHUMAN', name: 'Synthetic human' }], updatedAt: '2026-10-23T00:00:00.000Z' };
}

function message(ep = endpoint()): InboundMessage {
  return { eventId: `event-${ep.id}`, endpoint: ep, messageId: '101.000001', sender: ep.people[0], text: 'Preserve this accepted request',
    slack: { endpointId: ep.id, accountId: ep.accountId, chatId: ep.chatId, threadId: ep.threadId, messageId: '101.000001',
      sender: ep.people[0], text: 'Preserve this accepted request', payload: { text: 'Preserve this accepted request' }, kind: 'message' } };
}

function inbox(f: Fixture) {
  const file = path.join(f.directory, 'rele.sqlite'), store = new Store(file);
  stores.push(store);
  const ep = endpoint(); store.upsertEndpoint(ep);
  const conversation = store.createConversation({ name: 'Original conversation', threadId: 'original-native-thread', cwd: f.home,
    bindings: [{ platform: 'slack', endpointId: ep.id, allowedSenderIds: ['UHUMAN'] }] });
  const request = store.ingest(message(ep)).request;
  if (!request) throw new Error('Synthetic request was not accepted.');
  const stream = store.listSlackSyncStreams()[0], entry = store.listSlackSyncEntries(stream.id)[0];
  if (!entry) throw new Error('Synthetic context was not captured.');
  return { file, store, conversation, request, entry };
}

function autoIntent(f: Fixture, store: Store) {
  const ep = endpoint('automatic');
  const rule = { ...f.saved.autoLinkRules[0], id: 'automatic-rule', chatId: ep.chatId, requireMention: false };
  const intent = store.ingest(message(ep), { rule, targetFingerprint: 'original-target-fingerprint' }).autoLinkIntent;
  if (!intent) throw new Error('Synthetic auto-link was not accepted.');
  return intent;
}

describe('installer-only shared Codex setup', () => {
  it('migrates an unavailable local WebSocket and removed executable while preserving the profile, secrets, rules and protected backup', async () => {
    const port = await localEndpoint(); await close(port.server);
    const f = await fixture({ transport: 'websocket', endpoint: port.endpoint, executable: path.join(tmpdir(), 'removed-desktop-version', 'codex.exe') });
    await setupSharedCodex(f.config, f.verify, f.env);
    expect(f.verify).toHaveBeenCalledExactlyOnceWith({ transport: 'shared', executable: 'codex', endpoint: '', codexHome: f.home }, f.env);
    const restored = new ConfigStore(f.directory); await restored.load();
    expect(restored.config).toEqual({ ...f.saved, codex: { transport: 'shared', executable: 'codex', endpoint: '', codexHome: f.home } });
    expect(restored.panelToken).toBe(f.config.panelToken);
    const [backup] = await backups(f); expect(backup).toMatch(/^codex-setup-/u);
    expect(await readFile(path.join(f.directory, 'backups', backup, 'config.json'))).toEqual(f.original);
    const envelope = JSON.parse(f.original.toString('utf8')) as { encoding: string };
    expect(envelope.encoding).toBe(process.platform === 'win32' ? 'dpapi' : 'plain');
    if (process.platform === 'win32') expect(f.original.toString('utf8')).not.toContain(f.config.panelToken);
    else expect((await stat(path.join(f.directory, 'backups', backup, 'config.json'))).mode & 0o777).toBe(0o600);
    await expect(stat(path.join(f.directory, 'rele.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    const migratedBytes = await readFile(f.file);
    await setupSharedCodex(f.config, f.verify, f.env);
    expect(await readFile(f.file)).toEqual(migratedBytes);
    expect(await backups(f)).toEqual([backup]);
    expect(f.verify).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('verifies an existing shared selection without rewriting it or creating a database or backup', async () => {
    const f = await fixture({ transport: 'shared', executable: 'explicit-native-cli' });
    await setupSharedCodex(f.config, f.verify, f.env);
    expect(f.verify).toHaveBeenCalledExactlyOnceWith(f.saved.codex, f.env);
    await unchanged(f);
    await expect(stat(path.join(f.directory, 'rele.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses migration while this data directory has a live gateway owner', async () => {
    const f = await fixture(), lock = await acquireGatewayLock(f.directory); servers.push(lock);
    await expect(setupSharedCodex(f.config, f.verify, f.env)).rejects.toThrow('уже запущен');
    expect(f.verify).not.toHaveBeenCalled(); await unchanged(f);
    await close(lock);
    await setupSharedCodex(f.config, f.verify, f.env);
    expect(f.verify).toHaveBeenCalledOnce();
  });

  it('retains unsent queued requests, pending context, deliveries and completed auto-links without writing SQLite or its WAL', async () => {
    const f = await fixture(), db = inbox(f);
    db.store.setMeta(`request-started:${db.request.id}`, '123');
    db.store.addDeliveries(db.request.id, [{ key: 'prior-answer', ordinal: 0, kind: 'answer', body: 'Original delivery body' }]);
    const intent = autoIntent(f, db.store);
    db.store.updateAutoLinkIntent(intent.id, { status: 'created', threadId: 'auto-created-thread' });
    expect(db.store.finalizeAutoLinkIntent(intent.id)).toBeDefined();
    const originalRows = { requests: db.store.listRequests(), conversations: db.store.listConversations(), intents: db.store.listAutoLinkIntents(),
      deliveries: db.store.listDeliveries(), entry: db.store.getSlackSyncEntry(db.entry.id) };
    const main = await readFile(db.file), wal = await readFile(db.file + '-wal');
    await setupSharedCodex(f.config, f.verify, f.env);
    expect(await readFile(db.file)).toEqual(main); expect(await readFile(db.file + '-wal')).toEqual(wal);
    expect({ requests: db.store.listRequests(), conversations: db.store.listConversations(), intents: db.store.listAutoLinkIntents(),
      deliveries: db.store.listDeliveries(), entry: db.store.getSlackSyncEntry(db.entry.id) }).toEqual(originalRows);
    expect(f.verify).toHaveBeenCalledOnce();
  });

  it('ignores retained uncertain legacy aliases after their canonical context was applied', async () => {
    const f = await fixture(), db = inbox(f);
    db.store.updateSlackSyncEntry(db.entry.id, { state: 'applied' }); db.store.close();
    const raw = new DatabaseSync(db.file);
    try {
      raw.prepare(`INSERT INTO slack_sync_entries
        (id,stream_id,message_id,message_order,revision,message,request_id,state,error,retry_at,created_at,updated_at,semantic_revision,canonical_entry_id)
        SELECT 'legacy-context-alias',stream_id,message_id,message_order,'legacy-revision',message,request_id,'uncertain',NULL,NULL,created_at,updated_at,semantic_revision,id
        FROM slack_sync_entries WHERE id=?`).run(db.entry.id);
    } finally { raw.close(); }
    const before = await readFile(db.file);
    await setupSharedCodex(f.config, f.verify, f.env);
    expect(f.verify).toHaveBeenCalledOnce();
    expect(await readFile(db.file)).toEqual(before);
  });

  it.each(['starting', 'running', 'transcribing', 'waiting_approval', 'uncertain', 'queued-submission', 'queued-turn', 'pending-approval',
    'auto-pending', 'auto-creating', 'auto-created', 'auto-uncertain', 'auto-failed', 'context-applying', 'context-uncertain', 'tool-sending', 'tool-uncertain'] as const)
  ('preserves all original bytes and refuses unresolved %s', async state => {
    const f = await fixture(), db = inbox(f);
    if (state === 'queued-submission') db.store.updateRequest(db.request.id, { queuedSubmissionId: 'native-submission' });
    else if (state === 'queued-turn') db.store.updateRequest(db.request.id, { turnId: 'native-turn' });
    else if (state === 'pending-approval') db.store.addApproval({ requestId: db.request.id, turnId: 'native-turn', itemId: 'command-item',
      rpcId: 10, method: 'item/commandExecution/requestApproval', title: 'Synthetic approval', details: 'Preserve the original approval' });
    else if (state.startsWith('auto-')) {
      const intent = autoIntent(f, db.store), status = state.slice(5) as 'pending' | 'creating' | 'created' | 'uncertain' | 'failed';
      db.store.updateAutoLinkIntent(intent.id, { status, ...(status === 'created' ? { threadId: 'native-created-thread' } : {}) });
    } else if (state.startsWith('context-')) db.store.updateSlackSyncEntry(db.entry.id, { state: state.slice(8) as 'applying' | 'uncertain' });
    else if (state.startsWith('tool-')) {
      const conversation = db.store.getConversation(db.request.conversationId)!;
      const delivery = db.store.addToolMessage({ threadId: conversation.threadId, callId: 'synthetic-send', conversationId: conversation.id,
        origin: { ...db.request.origin, senderId: 'UBOT', senderIsBot: true, messageId: '' }, arguments: {}, text: 'Synthetic outgoing message', mentions: [] });
      db.store.updateDelivery(delivery.id, { status: state.slice(5) as 'sending' | 'uncertain' });
    }
    else db.store.updateRequest(db.request.id, { status: state as 'starting' | 'running' | 'transcribing' | 'waiting_approval' | 'uncertain' });
    db.store.close(); const originalDatabase = await readFile(db.file);
    await expect(setupSharedCodex(f.config, f.verify, f.env)).rejects.toThrow('активные или неподтверждённые');
    expect(f.verify).not.toHaveBeenCalled(); await unchanged(f);
    expect(await readFile(db.file)).toEqual(originalDatabase);
  });

  it.each(['foreign-owner', 'future-schema', 'missing-column'] as const)('fails closed on %s without migrating the database', async problem => {
    const f = await fixture(), db = inbox(f); db.store.close();
    const malformed = new DatabaseSync(db.file);
    try { malformed.exec(problem === 'foreign-owner' ? 'PRAGMA application_id=123;' : problem === 'future-schema'
      ? 'PRAGMA user_version=10;' : 'ALTER TABLE requests RENAME COLUMN queued_submission_id TO unknown_submission;'); }
    finally { malformed.close(); }
    const originalDatabase = await readFile(db.file);
    await expect(setupSharedCodex(f.config, f.verify, f.env)).rejects.toThrow();
    expect(f.verify).not.toHaveBeenCalled(); await unchanged(f);
    expect(await readFile(db.file)).toEqual(originalDatabase);
  });

  it.each([
    { name: 'remote WebSocket', codex: { transport: 'websocket', endpoint: 'ws://192.0.2.1:56316' } },
    { name: 'secure WebSocket', codex: { transport: 'websocket', endpoint: 'wss://127.0.0.1:56316' } },
    { name: 'separate token', codex: { token: 'synthetic-server-token' } },
    { name: 'custom proxy socket', codex: { transport: 'proxy', endpoint: path.join(tmpdir(), 'explicit-native.sock') } },
    { name: 'custom managed executable', codex: { transport: 'managed', executable: 'explicit-native-cli' } },
  ] satisfies Array<{ name: string; codex: Partial<CodexConnectionTarget & { token?: string }> }>)
  ('keeps the explicitly selected $name untouched', async ({ codex }) => {
    const f = await fixture(codex);
    await expect(setupSharedCodex(f.config, f.verify, f.env)).rejects.toThrow();
    expect(f.verify).not.toHaveBeenCalled(); await unchanged(f);
  });

  it('detects a live local listener without sending protocol traffic or stopping it', async () => {
    const port = await localEndpoint(), received: Buffer[] = [];
    port.server.removeAllListeners('connection');
    port.server.on('connection', socket => { socket.on('data', chunk => received.push(chunk)); socket.on('end', () => socket.end()); });
    const f = await fixture({ transport: 'websocket', endpoint: port.endpoint });
    await expect(setupSharedCodex(f.config, f.verify, f.env)).rejects.toThrow('локальный сервер Codex работает');
    expect(port.server.listening).toBe(true); expect(received).toEqual([]);
    expect(f.verify).not.toHaveBeenCalled(); await unchanged(f);
  });

  it('refuses a different installation profile before verifying or changing the saved target', async () => {
    const f = await fixture(), other = path.join(f.root, 'other-profile'); await mkdir(other);
    await expect(setupSharedCodex(f.config, f.verify, { CODEX_HOME: other })).rejects.toThrow('Профиль установки отличается');
    expect(f.verify).not.toHaveBeenCalled(); await unchanged(f);
  });

  it('persists the shared policy before a native failure, retains the original backup and permits an idempotent recovery', async () => {
    const f = await fixture();
    f.verify.mockImplementationOnce(async () => {
      expect(f.config.config.codex.transport).toBe('shared');
      expect(await readFile(f.file)).not.toEqual(f.original);
      throw new Error('Synthetic native preflight failed');
    });
    await expect(setupSharedCodex(f.config, f.verify, f.env)).rejects.toThrow('Synthetic native preflight failed');
    const restored = new ConfigStore(f.directory); await restored.load();
    expect(restored.config).toEqual({ ...f.saved, codex: { transport: 'shared', executable: 'codex', endpoint: '', codexHome: f.home } });
    expect(restored.panelToken).toBe(f.config.panelToken);
    const [backup] = await backups(f); expect(backup).toMatch(/^codex-setup-/u);
    expect(await readFile(path.join(f.directory, 'backups', backup, 'config.json'))).toEqual(f.original);
    const persisted = await readFile(f.file);
    await setupSharedCodex(f.config, f.verify, f.env);
    expect(f.verify).toHaveBeenCalledTimes(2);
    expect(await readFile(f.file)).toEqual(persisted); expect(await backups(f)).toEqual([backup]);
  }, 30_000);

  it('does not replace settings when their encrypted backup cannot be created', async () => {
    const f = await fixture(); await writeFile(path.join(f.directory, 'backups'), 'preserve this existing file');
    await expect(setupSharedCodex(f.config, f.verify, f.env)).rejects.toThrow();
    expect(f.verify).not.toHaveBeenCalled();
    expect(await readFile(f.file)).toEqual(f.original);
    expect(await readFile(path.join(f.directory, 'backups'), 'utf8')).toBe('preserve this existing file');
  });
});
