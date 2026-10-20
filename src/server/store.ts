import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, backup as backupDatabase, type SQLOutputValue } from 'node:sqlite';
import type { Approval, Binding, Conversation, Delivery, Endpoint, InboundMessage, Origin, Platform, ReleRequest, SlackTranscriptMessage } from '../shared/types.js';

type Row = Record<string, SQLOutputValue>;
type BindingInput = { platform: Platform; endpointId: string; allowedSenderIds: string[] };
type DeliveryPart = Pick<Delivery, 'key' | 'ordinal' | 'kind' | 'body' | 'approvalId'>;
type ApprovalInput = Omit<Approval, 'id' | 'status' | 'createdAt' | 'updatedAt'> & Partial<Pick<Approval, 'id' | 'status'>>;
export interface SlackSyncStream {
  id: string; endpointId: string; conversationId: string; codexThreadId: string;
  accountId: string; chatId: string; threadId: string; active: boolean; paused: boolean;
  cursor?: string; coveredThrough?: string; scanUntil?: string; scanOldest?: string;
  state: 'backfill' | 'ready' | 'blocked'; error?: string; retryAt?: string;
}
export interface SlackSyncEntry {
  id: string; streamId: string; message: SlackTranscriptMessage; messageId: string; revision: string;
  requestId?: string;
  state: 'pending' | 'applying' | 'applied' | 'uncertain';
  error?: string; retryAt?: string; createdAt: string; updatedAt: string;
}
const APPLICATION_ID = 0x52454c45;
const BLOCKING_REQUESTS = "'starting','running','transcribing','waiting_approval','uncertain'";
const MIGRATIONS = [String.raw`
  CREATE TABLE endpoints (
    id TEXT PRIMARY KEY NOT NULL, platform TEXT NOT NULL CHECK(platform IN ('slack','telegram')),
    account_id TEXT NOT NULL, chat_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    title TEXT NOT NULL, subtitle TEXT NOT NULL, url TEXT,
    people TEXT NOT NULL CHECK(json_valid(people) AND json_type(people) = 'array'), updated_at TEXT NOT NULL,
    UNIQUE(platform, account_id, chat_id, thread_id), UNIQUE(id, platform)
  ) STRICT;
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL CHECK(length(trim(name)) > 0),
    thread_id TEXT NOT NULL UNIQUE CHECK(length(thread_id) > 0), cwd TEXT NOT NULL CHECK(length(cwd) > 0),
    paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE bindings (
    id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id),
    platform TEXT NOT NULL CHECK(platform IN ('slack','telegram')), endpoint_id TEXT NOT NULL UNIQUE,
    allowed_sender_ids TEXT NOT NULL CHECK(json_valid(allowed_sender_ids) AND json_type(allowed_sender_ids) = 'array'),
    UNIQUE(conversation_id, platform), FOREIGN KEY(endpoint_id, platform) REFERENCES endpoints(id, platform)
  ) STRICT;
  CREATE TABLE requests (
    id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), event_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(json_valid(origin) AND json_type(origin) = 'object'), text TEXT NOT NULL,
    audio TEXT CHECK(audio IS NULL OR (json_valid(audio) AND json_type(audio) = 'object')),
    status TEXT NOT NULL CHECK(status IN ('queued','transcribing','starting','running','waiting_approval','completed','failed','interrupted','cancelled','uncertain')),
    queued_submission_id TEXT, turn_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX requests_queue ON requests(conversation_id, status);
  CREATE UNIQUE INDEX requests_one_active ON requests(conversation_id)
    WHERE status IN ('starting','running','transcribing','waiting_approval','uncertain');
  CREATE TABLE inbound_events (
    platform TEXT NOT NULL, account_id TEXT NOT NULL, event_id TEXT NOT NULL,
    endpoint_id TEXT NOT NULL REFERENCES endpoints(id), payload TEXT NOT NULL CHECK(json_valid(payload)),
    request_id TEXT UNIQUE REFERENCES requests(id), created_at TEXT NOT NULL,
    PRIMARY KEY(platform, account_id, event_id)
  ) STRICT;
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL REFERENCES requests(id), turn_id TEXT NOT NULL,
    item_id TEXT NOT NULL, rpc_id TEXT NOT NULL CHECK(json_valid(rpc_id)), method TEXT NOT NULL,
    title TEXT NOT NULL, details TEXT NOT NULL,
    questions TEXT CHECK(questions IS NULL OR (json_valid(questions) AND json_type(questions) = 'array')),
    status TEXT NOT NULL CHECK(status IN ('pending','answered','expired')), decision TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(request_id, turn_id, item_id, method)
  ) STRICT;
  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL REFERENCES requests(id),
    origin TEXT NOT NULL CHECK(json_valid(origin) AND json_type(origin) = 'object'), key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0), kind TEXT NOT NULL CHECK(kind IN ('answer','error','approval')),
    body TEXT NOT NULL, approval_id TEXT REFERENCES approvals(id),
    status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','uncertain')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), remote_message_id TEXT, error TEXT, next_attempt_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(request_id, key)
  ) STRICT;
  CREATE INDEX deliveries_queue ON deliveries(status, next_attempt_at);
  CREATE INDEX deliveries_request ON deliveries(request_id);
  CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;
`, String.raw`
  ALTER TABLE deliveries RENAME TO deliveries_v1;
  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL REFERENCES requests(id),
    origin TEXT NOT NULL CHECK(json_valid(origin) AND json_type(origin) = 'object'), key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0), kind TEXT NOT NULL CHECK(kind IN ('answer','error','approval')),
    body TEXT NOT NULL, approval_id TEXT REFERENCES approvals(id),
    status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','uncertain','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), remote_message_id TEXT, error TEXT, next_attempt_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(request_id, key)
  ) STRICT;
  INSERT INTO deliveries(rowid,id,request_id,origin,key,ordinal,kind,body,approval_id,status,attempts,remote_message_id,error,next_attempt_at,created_at,updated_at)
    SELECT rowid,id,request_id,origin,key,ordinal,kind,body,approval_id,status,attempts,remote_message_id,error,next_attempt_at,created_at,updated_at FROM deliveries_v1 ORDER BY rowid;
  DROP TABLE deliveries_v1;
  CREATE INDEX deliveries_queue ON deliveries(status, next_attempt_at);
  CREATE INDEX deliveries_request ON deliveries(request_id);
`, String.raw`
  ALTER TABLE endpoints ADD COLUMN catalog TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(catalog) AND json_type(catalog) = 'object');
`, String.raw`
  CREATE TABLE slack_sync_streams (
    id TEXT PRIMARY KEY NOT NULL, endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
    conversation_id TEXT NOT NULL REFERENCES conversations(id), codex_thread_id TEXT NOT NULL,
    account_id TEXT NOT NULL, chat_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    cursor TEXT, covered_through TEXT, scan_until TEXT, scan_oldest TEXT,
    state TEXT NOT NULL DEFAULT 'backfill' CHECK(state IN ('backfill','ready','blocked')),
    error TEXT, retry_at TEXT, UNIQUE(endpoint_id, conversation_id)
  ) STRICT;
  CREATE TABLE slack_sync_entries (
    id TEXT PRIMARY KEY NOT NULL, stream_id TEXT NOT NULL REFERENCES slack_sync_streams(id),
    message_id TEXT NOT NULL, message_order TEXT NOT NULL, revision TEXT NOT NULL,
    message TEXT NOT NULL CHECK(json_valid(message) AND json_type(message) = 'object'),
    request_id TEXT REFERENCES requests(id),
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applying','applied','uncertain')),
    error TEXT, retry_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(stream_id, message_id, revision)
  ) STRICT;
  CREATE INDEX slack_sync_pending ON slack_sync_entries(stream_id, state, message_order);
`];

function required(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must not be empty`);
}
function allowedPatch(patch: object, fields: readonly string[]): void {
  for (const key of Object.keys(patch)) if (!fields.includes(key)) throw new Error(`Cannot update immutable field: ${key}`);
}
function limitValue(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Limit must be a non-negative integer');
  return limit;
}
function json<T>(value: SQLOutputValue): T { return JSON.parse(value as string) as T; }
function optional(value: SQLOutputValue): string | undefined { return value === null ? undefined : value as string; }
function toEndpoint(r: Row): Endpoint {
  return { id: r.id as string, platform: r.platform as Platform, accountId: r.account_id as string, chatId: r.chat_id as string,
    threadId: r.thread_id as string, title: r.title as string, subtitle: r.subtitle as string, url: optional(r.url),
    people: json(r.people), updatedAt: r.updated_at as string, ...json<Record<string, unknown>>(r.catalog) };
}
function toBinding(r: Row): Binding {
  return { id: r.id as string, conversationId: r.conversation_id as string, platform: r.platform as Platform,
    endpointId: r.endpoint_id as string, allowedSenderIds: json(r.allowed_sender_ids) };
}
function toRequest(r: Row): ReleRequest {
  return { id: r.id as string, conversationId: r.conversation_id as string, eventId: r.event_id as string,
    origin: json(r.origin), text: r.text as string, audio: r.audio === null ? undefined : json(r.audio),
    status: r.status as ReleRequest['status'], queuedSubmissionId: optional(r.queued_submission_id),
    turnId: optional(r.turn_id), error: optional(r.error), createdAt: r.created_at as string, updatedAt: r.updated_at as string };
}
function toDelivery(r: Row): Delivery {
  return { id: r.id as string, requestId: r.request_id as string, origin: json(r.origin), key: r.key as string,
    ordinal: r.ordinal as number, kind: r.kind as Delivery['kind'], body: r.body as string, approvalId: optional(r.approval_id),
    status: r.status as Delivery['status'], attempts: r.attempts as number, remoteMessageId: optional(r.remote_message_id),
    error: optional(r.error), nextAttemptAt: optional(r.next_attempt_at), createdAt: r.created_at as string, updatedAt: r.updated_at as string };
}
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item);
}
function slackMessageOrder(value: string): string {
  const match = /^(\d+)\.(\d+)$/u.exec(value);
  return match ? `${match[1].padStart(20, '0')}.${match[2].padEnd(12, '0')}` : value;
}
function toSlackSyncStream(r: Row): SlackSyncStream {
  return { id: r.id as string, endpointId: r.endpoint_id as string, conversationId: r.conversation_id as string,
    codexThreadId: r.codex_thread_id as string, accountId: r.account_id as string, chatId: r.chat_id as string,
    threadId: r.thread_id as string, active: !!r.active, paused: !!r.paused, cursor: optional(r.cursor),
    coveredThrough: optional(r.covered_through), scanUntil: optional(r.scan_until), scanOldest: optional(r.scan_oldest), state: r.state as SlackSyncStream['state'],
    error: optional(r.error), retryAt: optional(r.retry_at) };
}
function toSlackSyncEntry(r: Row): SlackSyncEntry {
  return { id: r.id as string, streamId: r.stream_id as string, message: json(r.message), messageId: r.message_id as string,
    revision: r.revision as string, requestId: optional(r.request_id),
    state: r.state as SlackSyncEntry['state'], error: optional(r.error), retryAt: optional(r.retry_at),
    createdAt: r.created_at as string, updatedAt: r.updated_at as string };
}
function toApproval(r: Row): Approval {
  return { id: r.id as string, requestId: r.request_id as string, turnId: r.turn_id as string, itemId: r.item_id as string,
    rpcId: json(r.rpc_id), method: r.method as string, title: r.title as string, details: r.details as string,
    questions: r.questions === null ? undefined : json(r.questions), status: r.status as Approval['status'],
    decision: optional(r.decision), createdAt: r.created_at as string, updatedAt: r.updated_at as string };
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly path: string;
  private closed = false;

  constructor(dbPath: string) {
    required(dbPath, 'Database path');
    this.path = dbPath === ':memory:' ? dbPath : resolve(dbPath);
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path, { enableForeignKeyConstraints: true });
    try {
      this.db.exec('PRAGMA busy_timeout = 5000;');
      const appId = this.db.prepare('PRAGMA application_id').get()!.application_id as number;
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version as number;
      const hasTables = this.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
      if (appId !== APPLICATION_ID && (appId !== 0 || version !== 0 || hasTables)) throw new Error('Database does not belong to Rele');
      if (version > MIGRATIONS.length) throw new Error(`Database schema ${version} is newer than this Rele version`);
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
      this.transaction(() => {
        for (let index = version; index < MIGRATIONS.length; index++) {
          this.db.exec(MIGRATIONS[index]);
          this.db.exec(`PRAGMA user_version = ${index + 1};`);
        }
        this.db.exec(`PRAGMA application_id = ${APPLICATION_ID};`);
      });
      if (this.db.prepare('PRAGMA quick_check').all().some((row) => row.quick_check !== 'ok') || this.db.prepare('PRAGMA foreign_key_check').get()) {
        throw new Error('Database integrity check failed; restore a verified backup');
      }
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  close(): void {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the failure that caused the rollback. */ }
      throw error;
    }
  }

  private writeEndpoint(endpoint: Endpoint): void {
    for (const [label, value] of Object.entries({ id: endpoint.id, accountId: endpoint.accountId, chatId: endpoint.chatId })) required(value, label);
    const existing = this.getEndpoint(endpoint.id);
    if (existing && (existing.platform !== endpoint.platform || existing.accountId !== endpoint.accountId || existing.chatId !== endpoint.chatId || existing.threadId !== endpoint.threadId)) {
      throw new Error('Endpoint identity cannot be changed');
    }
    const knownBots = new Set(existing?.people.filter(person => person.isBot).map(person => person.id));
    const people = [...new Map([...(existing?.people ?? []), ...endpoint.people].map(person => [person.id, knownBots.has(person.id) ? { ...person, isBot: true } : person])).values()];
    const catalog: Record<string, unknown> = {};
    for (const key of ['chatTitle', 'topicTitle', 'isForum', 'generalTopic', 'available'] as const) {
      const value = endpoint[key] ?? existing?.[key];
      if (value === undefined) continue;
      if (typeof value !== (key === 'chatTitle' || key === 'topicTitle' ? 'string' : 'boolean')) throw new Error('Invalid endpoint catalog metadata');
      catalog[key] = value;
    }
    this.db.prepare(`INSERT INTO endpoints (id,platform,account_id,chat_id,thread_id,title,subtitle,url,people,updated_at,catalog)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,subtitle=excluded.subtitle,url=excluded.url,people=excluded.people,updated_at=excluded.updated_at,catalog=excluded.catalog`)
      .run(endpoint.id, endpoint.platform, endpoint.accountId, endpoint.chatId, endpoint.threadId, endpoint.title, endpoint.subtitle, endpoint.url ?? null, JSON.stringify(people), endpoint.updatedAt, JSON.stringify(catalog));
  }

  upsertEndpoint(endpoint: Endpoint): Endpoint {
    return this.transaction(() => { this.writeEndpoint(endpoint); return this.getEndpoint(endpoint.id)!; });
  }
  listEndpoints(): Endpoint[] { return this.db.prepare('SELECT * FROM endpoints ORDER BY title COLLATE NOCASE, id').all().map(toEndpoint); }
  getEndpoint(id: string): Endpoint | undefined {
    const row = this.db.prepare('SELECT * FROM endpoints WHERE id=?').get(id);
    return row ? toEndpoint(row) : undefined;
  }

  createConversation(input: { name: string; threadId: string; cwd: string; bindings?: BindingInput[] }): Conversation {
    required(input.name, 'Conversation name'); required(input.threadId, 'Codex thread'); required(input.cwd, 'Working directory');
    return this.transaction(() => {
      const id = randomUUID(); const now = new Date().toISOString();
      this.db.prepare('INSERT INTO conversations (id,name,thread_id,cwd,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(id, input.name.trim(), input.threadId, input.cwd, now, now);
      const platforms = new Set<Platform>();
      for (const binding of input.bindings ?? []) {
        if (platforms.has(binding.platform)) throw new Error('A conversation can have only one binding per platform');
        platforms.add(binding.platform);
        this.writeBinding(id, binding.platform, binding.endpointId, binding.allowedSenderIds);
      }
      return this.getConversation(id)!;
    });
  }
  updateConversation(id: string, patch: Partial<Pick<Conversation, 'name' | 'paused'>>): Conversation {
    allowedPatch(patch, ['name', 'paused']);
    return this.transaction(() => {
      const current = this.getConversation(id);
      if (!current) throw new Error('Conversation not found');
      const next = { ...current, ...patch };
      required(next.name, 'Conversation name');
      if (typeof next.paused !== 'boolean') throw new Error('Paused must be a boolean');
      this.db.prepare('UPDATE conversations SET name=?,paused=?,updated_at=? WHERE id=?')
        .run(next.name.trim(), Number(next.paused), new Date().toISOString(), id);
      return this.getConversation(id)!;
    });
  }
  getConversation(id: string): Conversation | undefined {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
    if (!row) return undefined;
    return { id: row.id as string, name: row.name as string, threadId: row.thread_id as string, cwd: row.cwd as string,
      paused: Boolean(row.paused), bindings: this.db.prepare('SELECT * FROM bindings WHERE conversation_id=? ORDER BY platform').all(id).map(toBinding),
      createdAt: row.created_at as string, updatedAt: row.updated_at as string };
  }
  listConversations(): Conversation[] {
    return this.db.prepare('SELECT id FROM conversations ORDER BY rowid').all().map((row) => this.getConversation(row.id as string)!);
  }

  private writeBinding(conversationId: string, platform: Platform, endpointId: string, allowedSenderIds: string[]): Binding {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error('Conversation not found');
    const previous = conversation.bindings.find(binding => binding.platform === platform);
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint) throw new Error('Endpoint not found');
    if (endpoint.platform !== platform) throw new Error('Endpoint platform does not match the binding');
    if (!Array.isArray(allowedSenderIds)) throw new Error('Allowed senders must be an array');
    for (const senderId of allowedSenderIds) required(senderId, 'Allowed sender ID');
    this.db.prepare(`INSERT INTO bindings (id,conversation_id,platform,endpoint_id,allowed_sender_ids) VALUES (?,?,?,?,?)
      ON CONFLICT(conversation_id,platform) DO UPDATE SET endpoint_id=excluded.endpoint_id,allowed_sender_ids=excluded.allowed_sender_ids`)
      .run(randomUUID(), conversationId, platform, endpointId, JSON.stringify([...new Set(allowedSenderIds)]));
    if (platform === 'slack' && previous?.endpointId !== endpointId) {
      if (previous) this.resetSlackSyncStream(conversationId, previous.endpointId);
      this.resetSlackSyncStream(conversationId, endpointId);
    }
    this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(new Date().toISOString(), conversationId);
    return toBinding(this.db.prepare('SELECT * FROM bindings WHERE conversation_id=? AND platform=?').get(conversationId, platform)!);
  }
  setBinding(conversationId: string, platform: Platform, endpointId: string, allowedSenderIds: string[]): Binding {
    return this.transaction(() => this.writeBinding(conversationId, platform, endpointId, allowedSenderIds));
  }
  removeBinding(conversationId: string, platform: Platform): void {
    this.transaction(() => {
      const conversation = this.getConversation(conversationId);
      if (!conversation) throw new Error('Conversation not found');
      const binding = conversation.bindings.find(binding => binding.platform === platform);
      this.db.prepare('DELETE FROM bindings WHERE conversation_id=? AND platform=?').run(conversationId, platform);
      if (platform === 'slack' && binding) this.resetSlackSyncStream(conversationId, binding.endpointId);
      this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(new Date().toISOString(), conversationId);
    });
  }

  private resetSlackSyncStream(conversationId: string, endpointId: string): void {
    this.db.prepare(`UPDATE slack_sync_streams SET cursor=NULL,covered_through=NULL,scan_until=NULL,scan_oldest=NULL,
      state='backfill',error=NULL,retry_at=NULL WHERE conversation_id=? AND endpoint_id=?`).run(conversationId, endpointId);
  }

  private ensureSlackSyncStreams(): void {
    const rows = this.db.prepare(`SELECT b.endpoint_id, b.conversation_id, c.thread_id AS codex_thread_id,
      e.account_id, e.chat_id, e.thread_id FROM bindings b JOIN endpoints e ON e.id=b.endpoint_id
      JOIN conversations c ON c.id=b.conversation_id WHERE b.platform='slack'`).all();
    for (const row of rows) {
      const id = randomUUID();
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO slack_sync_streams
        (id,endpoint_id,conversation_id,codex_thread_id,account_id,chat_id,thread_id) VALUES (?,?,?,?,?,?,?)`)
        .run(id, row.endpoint_id, row.conversation_id, row.codex_thread_id, row.account_id, row.chat_id, row.thread_id);
      if (!inserted.changes) continue;
      // Existing receipts remain useful when upgrading, even before Slack backfill succeeds.
      for (const receipt of this.db.prepare('SELECT payload,request_id FROM inbound_events WHERE endpoint_id=? ORDER BY rowid').all(row.endpoint_id)) {
        const inbound = json<InboundMessage>(receipt.payload);
        const message = inbound.slack ?? { endpointId: inbound.endpoint.id, accountId: inbound.endpoint.accountId,
          chatId: inbound.endpoint.chatId, threadId: inbound.endpoint.threadId, messageId: inbound.messageId,
          sender: inbound.sender, text: inbound.text, payload: { text: inbound.text, ...(inbound.audio ? { audio: inbound.audio } : {}) }, kind: 'message' as const };
        const requestId = optional(receipt.request_id);
        this.writeSlackSyncEntry(id, message, requestId && this.getRequest(requestId)?.conversationId === row.conversation_id ? requestId : undefined);
      }
    }
  }

  listSlackSyncStreams(): SlackSyncStream[] {
    return this.transaction(() => {
      this.ensureSlackSyncStreams();
      return this.db.prepare(`SELECT s.*,c.paused,EXISTS(SELECT 1 FROM bindings b WHERE
        b.platform='slack' AND b.endpoint_id=s.endpoint_id AND b.conversation_id=s.conversation_id) AS active
        FROM slack_sync_streams s JOIN conversations c ON c.id=s.conversation_id ORDER BY s.rowid`).all().map(toSlackSyncStream);
    });
  }
  getSlackSyncStream(id: string): SlackSyncStream | undefined {
    const row = this.db.prepare(`SELECT s.*,c.paused,EXISTS(SELECT 1 FROM bindings b WHERE
      b.platform='slack' AND b.endpoint_id=s.endpoint_id AND b.conversation_id=s.conversation_id) AS active
      FROM slack_sync_streams s JOIN conversations c ON c.id=s.conversation_id WHERE s.id=?`).get(id);
    return row ? toSlackSyncStream(row) : undefined;
  }
  updateSlackSyncStream(id: string, patch: Partial<Pick<SlackSyncStream, 'cursor' | 'coveredThrough' | 'scanUntil' | 'scanOldest' | 'state' | 'error' | 'retryAt'>>): SlackSyncStream {
    allowedPatch(patch, ['cursor', 'coveredThrough', 'scanUntil', 'scanOldest', 'state', 'error', 'retryAt']);
    return this.transaction(() => {
      const current = this.getSlackSyncStream(id);
      if (!current) throw new Error('Slack sync stream not found');
      const next = { ...current, ...patch };
      const retryAt = next.retryAt === undefined ? null : new Date(next.retryAt).toISOString();
      this.db.prepare('UPDATE slack_sync_streams SET cursor=?,covered_through=?,scan_until=?,scan_oldest=?,state=?,error=?,retry_at=? WHERE id=?')
        .run(next.cursor ?? null, next.coveredThrough ?? null, next.scanUntil ?? null, next.scanOldest ?? null, next.state, next.error ?? null, retryAt, id);
      return this.getSlackSyncStream(id)!;
    });
  }

  private writeSlackSyncEntry(streamId: string, message: SlackTranscriptMessage, requestId?: string): SlackSyncEntry {
    for (const [label, value] of Object.entries({ messageId: message.messageId, senderId: message.sender.id })) required(value, label);
    if (!['message', 'edit', 'deleted'].includes(message.kind) || typeof message.text !== 'string' || !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) throw new Error('Invalid Slack transcript message');
    const stream = this.getSlackSyncStream(streamId);
    if (!stream || stream.endpointId !== message.endpointId || stream.accountId !== message.accountId || stream.chatId !== message.chatId || stream.threadId !== message.threadId) throw new Error('Slack transcript origin does not match the sync stream');
    if (requestId && this.getRequest(requestId)?.conversationId !== stream.conversationId) throw new Error('Slack transcript request belongs to another conversation');
    const revision = createHash('sha256').update(stableJson({ kind: message.kind === 'deleted' ? 'deleted' : 'message',
      senderId: message.sender.id, text: message.text, edited: (message.payload.edited as { ts?: unknown } | undefined)?.ts,
      files: message.payload.files, attachments: message.payload.attachments, blocks: message.payload.blocks })).digest('hex');
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO slack_sync_entries (id,stream_id,message_id,message_order,revision,message,request_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(stream_id,message_id,revision) DO UPDATE SET request_id=COALESCE(slack_sync_entries.request_id,excluded.request_id)`)
      .run(id, streamId, message.messageId, slackMessageOrder(message.messageId), revision, JSON.stringify(message), requestId ?? null, now, now);
    return toSlackSyncEntry(this.db.prepare('SELECT * FROM slack_sync_entries WHERE stream_id=? AND message_id=? AND revision=?').get(streamId, message.messageId, revision)!);
  }
  private recordSlackMessageInside(message: SlackTranscriptMessage, requestId?: string): SlackSyncEntry | undefined {
    this.ensureSlackSyncStreams();
    let row = this.db.prepare(`SELECT s.id,s.conversation_id FROM slack_sync_streams s JOIN bindings b
      ON b.endpoint_id=s.endpoint_id AND b.conversation_id=s.conversation_id WHERE b.platform='slack' AND s.endpoint_id=?`).get(message.endpointId);
    if (!row && message.kind === 'deleted') {
      const prior = this.db.prepare(`SELECT s.id,s.conversation_id,e.message FROM slack_sync_entries e
        JOIN slack_sync_streams s ON s.id=e.stream_id JOIN bindings b ON b.endpoint_id=s.endpoint_id AND b.conversation_id=s.conversation_id
        WHERE b.platform='slack' AND s.account_id=? AND s.chat_id=? AND e.message_id=? ORDER BY e.rowid DESC LIMIT 1`)
        .get(message.accountId, message.chatId, message.messageId);
      if (prior) {
        const previous = json<SlackTranscriptMessage>(prior.message);
        message = { ...message, endpointId: previous.endpointId, threadId: previous.threadId, sender: previous.sender };
        row = prior;
      }
    }
    if (!row) return undefined;
    const matchingRequest = requestId && this.getRequest(requestId)?.conversationId === row.conversation_id ? requestId : undefined;
    return this.writeSlackSyncEntry(row.id as string, message, matchingRequest);
  }
  recordSlackMessage(message: SlackTranscriptMessage): SlackSyncEntry | undefined {
    return this.transaction(() => this.recordSlackMessageInside(message));
  }
  getSlackSyncEntry(id: string): SlackSyncEntry | undefined {
    const row = this.db.prepare('SELECT * FROM slack_sync_entries WHERE id=?').get(id);
    return row ? toSlackSyncEntry(row) : undefined;
  }
  listSlackSyncEntries(streamId: string, options: { pending?: boolean; beforeMessageId?: string; limit?: number; offset?: number } = {}): SlackSyncEntry[] {
    const before = options.beforeMessageId === undefined ? null : slackMessageOrder(options.beforeMessageId);
    return this.db.prepare(`SELECT * FROM slack_sync_entries WHERE stream_id=?
      AND (?=0 OR (state IN ('pending','uncertain') AND (retry_at IS NULL OR retry_at<=?)))
      AND (? IS NULL OR message_order<=?) ORDER BY message_order,rowid LIMIT ? OFFSET ?`)
      .all(streamId, Number(!!options.pending), new Date().toISOString(), before, before, limitValue(options.limit ?? 100), limitValue(options.offset ?? 0)).map(toSlackSyncEntry);
  }
  latestSlackMessageId(streamId: string): string | undefined {
    return this.db.prepare('SELECT message_id FROM slack_sync_entries WHERE stream_id=? ORDER BY message_order DESC,rowid DESC LIMIT 1').get(streamId)?.message_id as string | undefined;
  }
  hasPendingSlackSyncEntries(streamId: string, beforeMessageId?: string): boolean {
    const before = beforeMessageId === undefined ? null : slackMessageOrder(beforeMessageId);
    return !!this.db.prepare(`SELECT 1 FROM slack_sync_entries WHERE stream_id=?
      AND state<>'applied' AND (? IS NULL OR message_order<=?) LIMIT 1`).get(streamId, before, before);
  }
  getSlackSyncCounts(streamId: string): Record<SlackSyncEntry['state'], number> {
    const counts: Record<SlackSyncEntry['state'], number> = { pending: 0, applying: 0, applied: 0, uncertain: 0 };
    for (const row of this.db.prepare('SELECT state,COUNT(*) AS count FROM slack_sync_entries WHERE stream_id=? GROUP BY state').all(streamId)) counts[row.state as SlackSyncEntry['state']] = Number(row.count);
    return counts;
  }
  updateSlackSyncEntry(id: string, patch: Partial<Pick<SlackSyncEntry, 'state' | 'requestId' | 'error' | 'retryAt'>>): SlackSyncEntry {
    allowedPatch(patch, ['state', 'requestId', 'error', 'retryAt']);
    return this.transaction(() => {
      const current = this.getSlackSyncEntry(id);
      if (!current) throw new Error('Slack sync entry not found');
      const next = { ...current, ...patch };
      const stream = this.getSlackSyncStream(current.streamId)!;
      if (next.requestId && this.getRequest(next.requestId)?.conversationId !== stream.conversationId) throw new Error('Slack transcript request belongs to another conversation');
      const retryAt = next.retryAt === undefined ? null : new Date(next.retryAt).toISOString();
      this.db.prepare('UPDATE slack_sync_entries SET state=?,request_id=?,error=?,retry_at=?,updated_at=? WHERE id=?')
        .run(next.state, next.requestId ?? null, next.error ?? null, retryAt, new Date().toISOString(), id);
      return this.getSlackSyncEntry(id)!;
    });
  }
  claimSlackSyncEntry(id: string): SlackSyncEntry | undefined {
    return this.transaction(() => {
      const now = new Date().toISOString();
      const result = this.db.prepare(`UPDATE slack_sync_entries SET state='applying',updated_at=? WHERE id=?
        AND state IN ('pending','uncertain') AND (retry_at IS NULL OR retry_at<=?)
        AND EXISTS(SELECT 1 FROM slack_sync_streams s JOIN conversations c ON c.id=s.conversation_id
          WHERE s.id=slack_sync_entries.stream_id AND c.paused=0)`).run(now, id, now);
      return result.changes ? this.getSlackSyncEntry(id) : undefined;
    });
  }

  private recordEvent(message: InboundMessage): { duplicate: boolean; requestId?: string } {
    required(message.eventId, 'Event ID'); required(message.sender.id, 'Sender ID'); required(message.messageId, 'Message ID');
    const endpoint = message.endpoint;
    if (message.slack && (endpoint.platform !== 'slack' || message.slack.endpointId !== endpoint.id || message.slack.accountId !== endpoint.accountId
      || message.slack.chatId !== endpoint.chatId || message.slack.threadId !== endpoint.threadId || message.slack.messageId !== message.messageId || message.slack.sender.id !== message.sender.id)) throw new Error('Slack transcript origin does not match the inbound event');
    const event = this.db.prepare('SELECT request_id,payload FROM inbound_events WHERE platform=? AND account_id=? AND event_id=?')
      .get(endpoint.platform, endpoint.accountId, message.eventId);
    if (event) {
      const requestId = optional(event.request_id);
      const original = json<InboundMessage>(event.payload).slack;
      if (original) this.recordSlackMessageInside(original, requestId);
      return { duplicate: true, requestId };
    }
    this.writeEndpoint(endpoint);
    this.db.prepare('INSERT INTO inbound_events (platform,account_id,event_id,endpoint_id,payload,created_at) VALUES (?,?,?,?,?,?)')
      .run(endpoint.platform, endpoint.accountId, message.eventId, endpoint.id, JSON.stringify(message), new Date().toISOString());
    if (message.slack) this.recordSlackMessageInside(message.slack);
    return { duplicate: false };
  }
  recordInbound(message: InboundMessage): { duplicate: boolean } {
    return this.transaction(() => ({ duplicate: this.recordEvent(message).duplicate }));
  }
  ingest(message: InboundMessage): { request: ReleRequest | null; duplicate: boolean } {
    return this.transaction(() => {
      const endpoint = message.endpoint;
      const event = this.recordEvent(message);
      if (event.duplicate) return { request: event.requestId ? this.getRequest(event.requestId)! : null, duplicate: true };
      const now = new Date().toISOString();
      const row = this.db.prepare(`SELECT bindings.* FROM bindings JOIN conversations ON conversations.id=bindings.conversation_id
        WHERE bindings.endpoint_id=? AND conversations.paused=0`).get(endpoint.id);
      const binding = row ? toBinding(row) : undefined;
      if (message.contextOnly || (message.slack && message.slack.kind !== 'message') || ((message.sender.isBot || message.slack?.sender.isBot || this.getEndpoint(endpoint.id)?.people.some(person => person.id === message.sender.id && person.isBot)) && !message.directMention) || !binding || !binding.allowedSenderIds.length || !binding.allowedSenderIds.includes(message.sender.id)) return { request: null, duplicate: false };
      const origin: Origin = { platform: endpoint.platform, accountId: endpoint.accountId, endpointId: endpoint.id,
        chatId: endpoint.chatId, threadId: endpoint.threadId, senderId: message.sender.id, senderName: message.sender.name, messageId: message.messageId };
      const id = randomUUID();
      this.db.prepare(`INSERT INTO requests (id,conversation_id,event_id,origin,text,audio,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?)`)
        .run(id, binding.conversationId, message.eventId, JSON.stringify(origin), message.text, message.audio ? JSON.stringify(message.audio) : null, now, now);
      if (message.slack) this.recordSlackMessageInside(message.slack, id);
      this.db.prepare('UPDATE inbound_events SET request_id=? WHERE platform=? AND account_id=? AND event_id=?').run(id, endpoint.platform, endpoint.accountId, message.eventId);
      return { request: this.getRequest(id)!, duplicate: false };
    });
  }

  getRequest(id: string): ReleRequest | undefined {
    const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    return row ? toRequest(row) : undefined;
  }
  listRequests(limit = 100): ReleRequest[] { return this.db.prepare('SELECT * FROM requests ORDER BY rowid DESC LIMIT ?').all(limitValue(limit)).map(toRequest); }
  listPendingRequests(): ReleRequest[] { return this.db.prepare("SELECT * FROM requests WHERE status='queued' ORDER BY rowid").all().map(toRequest); }
  activeRequests(): ReleRequest[] {
    return this.db.prepare(`SELECT * FROM requests WHERE status IN ('queued',${BLOCKING_REQUESTS}) ORDER BY rowid`).all().map(toRequest);
  }
  claimNextRequest(conversationId: string): ReleRequest | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT r.id FROM requests r JOIN conversations c ON c.id=r.conversation_id
        WHERE r.conversation_id=? AND r.status='queued' AND c.paused=0
        AND NOT EXISTS(SELECT 1 FROM requests active WHERE active.conversation_id=r.conversation_id AND active.status IN (${BLOCKING_REQUESTS}))
        ORDER BY r.rowid LIMIT 1`).get(conversationId);
      if (!row) return undefined;
      const id = row.id as string;
      this.db.prepare("UPDATE requests SET status='starting',updated_at=? WHERE id=?").run(new Date().toISOString(), id);
      return this.getRequest(id)!;
    });
  }
  updateRequest(id: string, patch: Partial<Pick<ReleRequest, 'status' | 'text' | 'queuedSubmissionId' | 'turnId' | 'error'>>): ReleRequest {
    allowedPatch(patch, ['status', 'text', 'queuedSubmissionId', 'turnId', 'error']);
    return this.transaction(() => {
      const current = this.getRequest(id);
      if (!current) throw new Error('Request not found');
      const next = { ...current, ...patch };
      this.db.prepare('UPDATE requests SET status=?,text=?,queued_submission_id=?,turn_id=?,error=?,updated_at=? WHERE id=?')
        .run(next.status, next.text, next.queuedSubmissionId ?? null, next.turnId ?? null, next.error ?? null, new Date().toISOString(), id);
      return this.getRequest(id)!;
    });
  }

  addDeliveries(requestId: string, parts: DeliveryPart[]): Delivery[] {
    return this.transaction(() => this.writeDeliveries(requestId, parts));
  }
  private writeDeliveries(requestId: string, parts: DeliveryPart[]): Delivery[] {
      const request = this.getRequest(requestId);
      if (!request) throw new Error('Request not found');
      const result: Delivery[] = [];
      for (const part of [...parts].sort((a, b) => a.ordinal - b.ordinal)) {
        required(part.key, 'Delivery key'); required(part.body, 'Delivery body');
        if (!Number.isSafeInteger(part.ordinal) || part.ordinal < 0) throw new Error('Delivery ordinal must be a non-negative integer');
        const existingRow = this.db.prepare('SELECT * FROM deliveries WHERE request_id=? AND key=?').get(requestId, part.key);
        if (existingRow) {
          const existing = toDelivery(existingRow);
          if (existing.body !== part.body || existing.ordinal !== part.ordinal || existing.kind !== part.kind || existing.approvalId !== part.approvalId) throw new Error('Delivery key already exists with different content');
          result.push(existing);
          continue;
        }
        if (part.approvalId && this.getApproval(part.approvalId)?.requestId !== requestId) throw new Error('Approval does not belong to this request');
        const id = randomUUID(); const now = new Date().toISOString();
        this.db.prepare(`INSERT INTO deliveries (id,request_id,origin,key,ordinal,kind,body,approval_id,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`).run(id, requestId, JSON.stringify(request.origin), part.key, part.ordinal, part.kind, part.body, part.approvalId ?? null, now, now);
        result.push(this.getDelivery(id)!);
      }
      return result;
  }
  finishRequest(id: string, patch: { status: 'completed' | 'failed' | 'interrupted' | 'cancelled'; error?: string; turnId?: string }, parts: DeliveryPart[]): ReleRequest {
    allowedPatch(patch, ['status', 'error', 'turnId']);
    if (!['completed', 'failed', 'interrupted', 'cancelled'].includes(patch.status)) throw new Error('Finishing a request requires a terminal status');
    return this.transaction(() => {
      const current = this.getRequest(id);
      if (!current) throw new Error('Request not found');
      const next = { ...current, ...patch };
      const now = new Date().toISOString();
      this.db.prepare('UPDATE requests SET status=?,turn_id=?,error=?,updated_at=? WHERE id=?').run(next.status, next.turnId ?? null, next.error ?? null, now, id);
      this.db.prepare("UPDATE approvals SET status='expired',updated_at=? WHERE request_id=? AND status='pending'").run(now, id);
      this.db.prepare("UPDATE deliveries SET status='cancelled',updated_at=? WHERE request_id=? AND kind='approval' AND status IN ('pending','failed')").run(now, id);
      this.writeDeliveries(id, parts);
      return this.getRequest(id)!;
    });
  }
  getDelivery(id: string): Delivery | undefined {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id);
    return row ? toDelivery(row) : undefined;
  }
  listDeliveries(limit = 100): Delivery[] { return this.db.prepare('SELECT * FROM deliveries ORDER BY rowid DESC LIMIT ?').all(limitValue(limit)).map(toDelivery); }
  findReplyApproval(origin: Pick<Origin, 'platform' | 'accountId' | 'chatId' | 'threadId'>, remoteMessageId: string): Approval | undefined {
    const row = this.db.prepare(`SELECT a.* FROM deliveries d JOIN approvals a ON a.id=d.approval_id
      WHERE d.kind='approval' AND d.status='sent' AND d.remote_message_id=?
        AND json_extract(d.origin,'$.platform')=? AND json_extract(d.origin,'$.accountId')=?
        AND json_extract(d.origin,'$.chatId')=? AND json_extract(d.origin,'$.threadId')=?
      ORDER BY d.rowid DESC LIMIT 1`).get(remoteMessageId, origin.platform, origin.accountId, origin.chatId, origin.threadId);
    return row ? toApproval(row) : undefined;
  }
  approvalDeliveryProgress(approvalId: string): { sent: boolean; complete: boolean } {
    const row = this.db.prepare("SELECT COUNT(*) AS total, SUM(status='sent') AS sent FROM deliveries WHERE kind='approval' AND approval_id=?").get(approvalId)!;
    return { sent: Number(row.sent) > 0, complete: Number(row.total) > 0 && Number(row.sent) === Number(row.total) };
  }

  cancelApprovalDeliveries(approvalId: string): void {
    this.db.prepare("UPDATE deliveries SET status='cancelled',updated_at=? WHERE approval_id=? AND kind='approval' AND status IN ('pending','failed')")
      .run(new Date().toISOString(), approvalId);
  }
  claimDelivery(now: string | number | Date = new Date()): Delivery | undefined {
    const timestamp = new Date(now).toISOString();
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT d.id FROM deliveries d WHERE d.status='pending'
        AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?)
        AND NOT EXISTS(SELECT 1 FROM deliveries earlier WHERE earlier.request_id=d.request_id AND earlier.rowid<d.rowid AND earlier.status NOT IN ('sent','cancelled'))
        ORDER BY d.rowid LIMIT 1`).get(timestamp);
      if (!row) return undefined;
      const id = row.id as string;
      this.db.prepare("UPDATE deliveries SET status='sending',attempts=attempts+1,updated_at=? WHERE id=?").run(timestamp, id);
      return this.getDelivery(id)!;
    });
  }
  updateDelivery(id: string, patch: Partial<Pick<Delivery, 'status' | 'remoteMessageId' | 'error' | 'nextAttemptAt'>>): Delivery {
    allowedPatch(patch, ['status', 'remoteMessageId', 'error', 'nextAttemptAt']);
    return this.transaction(() => {
      const current = this.getDelivery(id);
      if (!current) throw new Error('Delivery not found');
      const next = { ...current, ...patch };
      const nextAttemptAt = next.nextAttemptAt === undefined ? null : new Date(next.nextAttemptAt).toISOString();
      this.db.prepare('UPDATE deliveries SET status=?,remote_message_id=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?')
        .run(next.status, next.remoteMessageId ?? null, next.error ?? null, nextAttemptAt, new Date().toISOString(), id);
      return this.getDelivery(id)!;
    });
  }

  addApproval(input: ApprovalInput): Approval {
    return this.transaction(() => {
      if (!this.getRequest(input.requestId)) throw new Error('Request not found');
      if (typeof input.rpcId !== 'string' && (typeof input.rpcId !== 'number' || !Number.isFinite(input.rpcId))) throw new Error('Approval RPC ID must be a string or finite number');
      const existing = this.db.prepare('SELECT * FROM approvals WHERE request_id=? AND turn_id=? AND item_id=? AND method=?')
        .get(input.requestId, input.turnId, input.itemId, input.method);
      const id = existing ? existing.id as string : input.id ?? randomUUID(); const now = new Date().toISOString();
      if (existing) {
        this.db.prepare('UPDATE approvals SET rpc_id=?,title=?,details=?,questions=?,updated_at=? WHERE id=?')
          .run(JSON.stringify(input.rpcId), input.title, input.details, input.questions ? JSON.stringify(input.questions) : null, now, id);
      } else {
        this.db.prepare(`INSERT INTO approvals (id,request_id,turn_id,item_id,rpc_id,method,title,details,questions,status,decision,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.requestId, input.turnId, input.itemId, JSON.stringify(input.rpcId), input.method,
          input.title, input.details, input.questions ? JSON.stringify(input.questions) : null, input.status ?? 'pending', input.decision ?? null, now, now);
      }
      return this.getApproval(id)!;
    });
  }
  getApproval(id: string): Approval | undefined {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
    return row ? toApproval(row) : undefined;
  }
  listApprovals(limit = 100): Approval[] { return this.db.prepare('SELECT * FROM approvals ORDER BY rowid DESC LIMIT ?').all(limitValue(limit)).map(toApproval); }
  updateApproval(id: string, patch: Partial<Pick<Approval, 'status' | 'decision' | 'rpcId' | 'title' | 'details' | 'questions'>>): Approval {
    allowedPatch(patch, ['status', 'decision', 'rpcId', 'title', 'details', 'questions']);
    return this.transaction(() => {
      const current = this.getApproval(id);
      if (!current) throw new Error('Approval not found');
      const next = { ...current, ...patch };
      if (typeof next.rpcId !== 'string' && (typeof next.rpcId !== 'number' || !Number.isFinite(next.rpcId))) throw new Error('Approval RPC ID must be a string or finite number');
      this.db.prepare('UPDATE approvals SET status=?,decision=?,rpc_id=?,title=?,details=?,questions=?,updated_at=? WHERE id=?')
        .run(next.status, next.decision ?? null, JSON.stringify(next.rpcId), next.title, next.details, next.questions ? JSON.stringify(next.questions) : null, new Date().toISOString(), id);
      return this.getApproval(id)!;
    });
  }

  recoverInterrupted(): { requests: number; deliveries: number } {
    return this.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare("UPDATE slack_sync_entries SET state='pending',error=COALESCE(error,'Passive append acknowledgement was interrupted; replay may duplicate context'),updated_at=? WHERE state='applying'").run(now);
      const execution = this.db.prepare("UPDATE requests SET status='uncertain',error=COALESCE(error,'Execution interrupted; reconcile with Codex before retrying'),updated_at=? WHERE status IN ('starting','running')").run(now);
      const transcription = this.db.prepare("UPDATE requests SET status='queued',updated_at=? WHERE status='transcribing'").run(now);
      const deliveries = this.db.prepare("UPDATE deliveries SET status='uncertain',error=COALESCE(error,'Delivery interrupted; verify receipt before retrying'),updated_at=? WHERE status='sending'").run(now);
      return { requests: Number(execution.changes) + Number(transcription.changes), deliveries: Number(deliveries.changes) };
    });
  }
  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row?.value as string | undefined;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  async backup(path: string): Promise<void> {
    required(path, 'Backup path');
    const destination = resolve(path);
    if (destination === this.path) throw new Error('Backup must not overwrite the active database');
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    await backupDatabase(this.db, destination);
  }
}
