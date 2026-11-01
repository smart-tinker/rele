import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, posix, resolve, win32 } from 'node:path';
import { DatabaseSync, backup as backupDatabase, type SQLOutputValue } from 'node:sqlite';
import { isLocalWorkspace } from './config.js';
import { messageToolOperationId, MessageToolValidationError } from '../shared/message-tool.js';
import { inboundSourceRevision, slackSourceRevision } from './slack-source-version.js';
import type { Approval, AutoLinkIntent, AutoLinkRule, Binding, Conversation, Delivery, Endpoint, InboundMessage, Origin, Person, Platform, ReleRequest, SlackTranscriptMessage, SourceAccess, SourceRoute } from '../shared/types.js';

type Row = Record<string, SQLOutputValue>;
type BindingPolicy = Pick<Binding, 'allowAllSenders' | 'requireMention'>;
type BindingInput = { platform: Platform; endpointId: string; allowedSenderIds: string[] } & BindingPolicy;
type DeliveryPart = Pick<Delivery, 'key' | 'ordinal' | 'kind' | 'body' | 'approvalId'>;
type ApprovalInput = Omit<Approval, 'id' | 'status' | 'createdAt' | 'updatedAt'> & Partial<Pick<Approval, 'id' | 'status'>>;
export interface SlackSyncStream {
  platform: Platform;
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
  canonicalEntryId?: string;
}
export interface SteeringInput {
  id: string; parentRequestId: string; turnId: string; requestId?: string; entryId?: string; approvalId?: string; text: string;
  state: 'sending' | 'uncertain' | 'applied' | 'refused'; error?: string;
}
const APPLICATION_ID = 0x52454c45;
const BLOCKING_REQUESTS = "'starting','running','transcribing','waiting_approval','uncertain'";
const ASYNC_USER_INPUT = 'rele/asyncUserInput';
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
`, String.raw`
  CREATE TABLE bindings_v5 (
    id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id),
    platform TEXT NOT NULL CHECK(platform IN ('slack','telegram')), endpoint_id TEXT NOT NULL UNIQUE,
    allowed_sender_ids TEXT NOT NULL CHECK(json_valid(allowed_sender_ids) AND json_type(allowed_sender_ids) = 'array'),
    allow_all_senders INTEGER NOT NULL DEFAULT 0 CHECK(allow_all_senders IN (0,1)),
    require_mention INTEGER NOT NULL DEFAULT 0 CHECK(require_mention IN (0,1)),
    FOREIGN KEY(endpoint_id, platform) REFERENCES endpoints(id, platform)
  ) STRICT;
  INSERT INTO bindings_v5(rowid,id,conversation_id,platform,endpoint_id,allowed_sender_ids)
    SELECT rowid,id,conversation_id,platform,endpoint_id,allowed_sender_ids FROM bindings ORDER BY rowid;
  DROP TABLE bindings;
  ALTER TABLE bindings_v5 RENAME TO bindings;
  CREATE INDEX bindings_conversation ON bindings(conversation_id,platform);
  CREATE TABLE auto_link_intents (
    id TEXT PRIMARY KEY NOT NULL, endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
    rule TEXT NOT NULL CHECK(json_valid(rule) AND json_type(rule) = 'object'), target_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','creating','created','uncertain','failed','completed')),
    thread_id TEXT, conversation_id TEXT REFERENCES conversations(id), error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX auto_link_active_endpoint ON auto_link_intents(endpoint_id) WHERE status<>'completed';
  ALTER TABLE inbound_events ADD COLUMN auto_link_intent_id TEXT REFERENCES auto_link_intents(id);
  CREATE INDEX inbound_auto_link ON inbound_events(auto_link_intent_id);
`, String.raw`
  INSERT OR IGNORE INTO meta(key,value) VALUES ('source-policy-version','1');
`, String.raw`
  CREATE TABLE tool_outbox (
    id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL, call_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id), arguments TEXT NOT NULL CHECK(json_valid(arguments)),
    origin TEXT NOT NULL CHECK(json_valid(origin)), body TEXT NOT NULL CHECK(length(body)>0),
    mentions TEXT NOT NULL CHECK(json_valid(mentions) AND json_type(mentions)='array'),
    status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','uncertain','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), remote_message_id TEXT, error TEXT, next_attempt_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(thread_id,call_id)
  ) STRICT;
  CREATE INDEX tool_outbox_pending ON tool_outbox(status,next_attempt_at);
`, String.raw`
  ALTER TABLE slack_sync_entries ADD COLUMN semantic_revision TEXT;
  ALTER TABLE slack_sync_entries ADD COLUMN canonical_entry_id TEXT REFERENCES slack_sync_entries(id);
  CREATE UNIQUE INDEX slack_sync_semantic_source ON slack_sync_entries(stream_id,message_id,semantic_revision)
    WHERE canonical_entry_id IS NULL;
  CREATE INDEX slack_sync_aliases ON slack_sync_entries(canonical_entry_id);
  CREATE TABLE inbound_source_versions (
    platform TEXT NOT NULL, account_id TEXT NOT NULL, event_id TEXT NOT NULL,
    endpoint_id TEXT NOT NULL REFERENCES endpoints(id), message_id TEXT NOT NULL, revision TEXT NOT NULL,
    canonical_event_id TEXT NOT NULL,
    PRIMARY KEY(platform,account_id,event_id),
    FOREIGN KEY(platform,account_id,canonical_event_id) REFERENCES inbound_events(platform,account_id,event_id)
  ) STRICT;
  CREATE UNIQUE INDEX inbound_semantic_source ON inbound_source_versions(platform,account_id,endpoint_id,message_id,revision)
    WHERE event_id=canonical_event_id;
`];

function required(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must not be empty`);
}
function workingDirectoryKey(value: string): string {
  const windows = /^[A-Za-z]:[\\/]/u.test(value);
  const paths = windows ? win32 : posix;
  let normalized = paths.normalize(value);
  if (normalized.length > paths.parse(normalized).root.length) normalized = normalized.replace(windows ? /\\+$/u : /\/+$/u, '');
  return windows ? normalized[0].toUpperCase() + normalized.slice(1) : normalized;
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
    endpointId: r.endpoint_id as string, allowedSenderIds: json(r.allowed_sender_ids),
    allowAllSenders: !!r.allow_all_senders, requireMention: !!r.require_mention };
}
function toAutoLinkIntent(r: Row): AutoLinkIntent {
  return { id: r.id as string, endpointId: r.endpoint_id as string, rule: json(r.rule),
    targetFingerprint: r.target_fingerprint as string, status: r.status as AutoLinkIntent['status'],
    threadId: optional(r.thread_id), conversationId: optional(r.conversation_id), error: optional(r.error),
    createdAt: r.created_at as string, updatedAt: r.updated_at as string };
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
function toToolDelivery(r: Row): Delivery {
  return { id: r.id as string, operationId: r.id as string, conversationId: r.conversation_id as string,
    nativeThreadId: r.thread_id as string, callId: r.call_id as string, mentions: json(r.mentions), origin: json(r.origin),
    key: 'message', ordinal: 0, kind: 'message', body: r.body as string, status: r.status as Delivery['status'], attempts: r.attempts as number,
    remoteMessageId: optional(r.remote_message_id), error: optional(r.error), nextAttemptAt: optional(r.next_attempt_at),
    createdAt: r.created_at as string, updatedAt: r.updated_at as string };
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
  return { platform: r.platform as Platform ?? 'slack', id: r.id as string, endpointId: r.endpoint_id as string, conversationId: r.conversation_id as string,
    codexThreadId: r.codex_thread_id as string, accountId: r.account_id as string, chatId: r.chat_id as string,
    threadId: r.thread_id as string, active: !!r.active, paused: !!r.paused, cursor: optional(r.cursor),
    coveredThrough: optional(r.covered_through), scanUntil: optional(r.scan_until), scanOldest: optional(r.scan_oldest), state: r.state as SlackSyncStream['state'],
    error: optional(r.error), retryAt: optional(r.retry_at) };
}
function toSlackSyncEntry(r: Row): SlackSyncEntry {
  return { id: r.id as string, streamId: r.stream_id as string, message: json(r.message), messageId: r.message_id as string,
    revision: r.revision as string, requestId: optional(r.request_id),
    state: r.state as SlackSyncEntry['state'], error: optional(r.error), retryAt: optional(r.retry_at),
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
    ...(r.canonical_entry_id ? { canonicalEntryId: r.canonical_entry_id as string } : {}) };
}
function toApproval(r: Row): Approval {
  return { id: r.id as string, requestId: r.request_id as string, turnId: r.turn_id as string, itemId: r.item_id as string,
    rpcId: json(r.rpc_id), method: r.method as string, title: r.title as string, details: r.details as string,
    questions: r.questions === null ? undefined : json(r.questions), status: r.status as Approval['status'],
    decision: optional(r.decision), createdAt: r.created_at as string, updatedAt: r.updated_at as string };
}
function personRole(person: Person, previous?: Person, profile?: Person): Person {
  const isBot = profile?.isBot ?? person.isBot ?? previous?.isBot;
  return { ...person, ...(isBot === undefined ? {} : { isBot }) };
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
          if (index === 7) this.migrateSourceVersions();
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

  /** Runs once inside the schema transaction: raw rows and their receipt text never change. */
  private migrateSourceVersions(): void {
    const groups = new Map<string, { revision: string; rows: Row[] }>();
    for (const row of this.db.prepare(`SELECT e.*,s.endpoint_id,s.account_id,s.chat_id,s.thread_id FROM slack_sync_entries e
      JOIN slack_sync_streams s ON s.id=e.stream_id ORDER BY CASE e.state WHEN 'applied' THEN 0 WHEN 'uncertain' THEN 1 WHEN 'applying' THEN 1 ELSE 2 END,e.rowid`).all()) {
      const message = json<SlackTranscriptMessage>(row.message);
      if (message.endpointId !== row.endpoint_id || message.accountId !== row.account_id || message.chatId !== row.chat_id
        || message.threadId !== row.thread_id || message.messageId !== row.message_id) throw new Error('Slack source version origin does not match its stream');
      const revision = slackSourceRevision(message), key = JSON.stringify([row.stream_id, row.message_id, revision]);
      const group = groups.get(key) ?? { revision, rows: [] }; group.rows.push(row); groups.set(key, group);
    }
    const update = this.db.prepare('UPDATE slack_sync_entries SET semantic_revision=?,canonical_entry_id=? WHERE id=?');
    for (const { revision, rows } of groups.values()) {
      const winner = rows[0].id;
      for (const row of rows.slice(1)) update.run(revision, winner, row.id);
      update.run(revision, null, winner);
    }
    const canonical = new Map<string, string>();
    const insert = this.db.prepare(`INSERT INTO inbound_source_versions(platform,account_id,event_id,endpoint_id,message_id,revision,canonical_event_id) VALUES (?,?,?,?,?,?,?)`);
    for (const row of this.db.prepare('SELECT * FROM inbound_events ORDER BY rowid').all()) {
      const message = json<InboundMessage>(row.payload), revision = inboundSourceRevision(message);
      if (message.endpoint.platform !== row.platform || message.endpoint.accountId !== row.account_id || message.endpoint.id !== row.endpoint_id
        || message.eventId !== row.event_id) throw new Error('Inbound source version origin does not match its receipt');
      const key = JSON.stringify([row.platform, row.account_id, row.endpoint_id, message.messageId, revision]);
      const event = canonical.get(key) ?? row.event_id as string; canonical.set(key, event);
      insert.run(row.platform, row.account_id, row.event_id, row.endpoint_id, message.messageId, revision, event);
    }
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
    const knownPeople = new Map(existing?.people.map(person => [person.id, person]));
    for (const person of endpoint.people) knownPeople.set(person.id, personRole(person, knownPeople.get(person.id)));
    const people = [...knownPeople.values()];
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
    return this.transaction(() => this.writeConversation(input));
  }
  private writeConversation(input: { name: string; threadId: string; cwd: string; bindings?: BindingInput[] }): Conversation {
    required(input.name, 'Conversation name'); required(input.threadId, 'Codex thread'); required(input.cwd, 'Working directory');
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare('INSERT INTO conversations (id,name,thread_id,cwd,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, input.name.trim(), input.threadId, input.cwd, now, now);
    for (const binding of input.bindings ?? []) this.writeBinding(id, binding.platform, binding.endpointId, binding.allowedSenderIds, undefined, binding);
    return this.getConversation(id)!;
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
      paused: Boolean(row.paused), bindings: this.db.prepare('SELECT * FROM bindings WHERE conversation_id=? ORDER BY platform,rowid').all(id).map(toBinding),
      createdAt: row.created_at as string, updatedAt: row.updated_at as string };
  }
  listConversations(): Conversation[] {
    return this.db.prepare('SELECT id FROM conversations ORDER BY rowid').all().map((row) => this.getConversation(row.id as string)!);
  }

  getBinding(conversationId: string, bindingId: string): Binding | undefined {
    const row = this.db.prepare('SELECT * FROM bindings WHERE conversation_id=? AND id=?').get(conversationId, bindingId);
    return row ? toBinding(row) : undefined;
  }
  bindingForEndpoint(endpointId: string): Binding | undefined {
    const row = this.db.prepare('SELECT * FROM bindings WHERE endpoint_id=?').get(endpointId);
    return row ? toBinding(row) : undefined;
  }
  getSourceAccess(endpointId: string, rule?: AutoLinkRule): SourceAccess {
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint) throw new Error('Endpoint not found');
    const saved = this.getMeta(`source-access:${endpointId}`);
    if (saved !== undefined) {
      try {
        const access = JSON.parse(saved) as SourceAccess & { allowAllSenders?: boolean };
        if (!['off', 'mention', 'all'].includes(access.mode) || !Array.isArray(access.allowedSenderIds) || access.allowedSenderIds.some(id => typeof id !== 'string' || !id.trim()) ||
          access.legacy !== undefined && access.legacy !== false && (access.legacy !== true || typeof access.allowAllSenders !== 'boolean' || this.isDirectMessage(endpoint) && access.allowAllSenders)) throw new Error();
        return { endpointId, mode: access.mode, allowedSenderIds: access.allowedSenderIds, legacy: access.legacy === true };
      } catch { return { endpointId, mode: 'off', allowedSenderIds: [], legacy: false }; }
    }
    const binding = this.bindingForEndpoint(endpointId);
    if (binding) return { endpointId, mode: binding.requireMention ? 'mention' : 'all', allowedSenderIds: binding.allowedSenderIds, legacy: true };
    if (this.getMeta(`source-route:${endpointId}`) === undefined && this.matchesSourceRule(endpoint, rule)) {
      return { endpointId, mode: rule!.requireMention ? 'mention' : 'all', allowedSenderIds: rule!.allowedSenderIds, legacy: true };
    }
    return { endpointId, mode: 'off', allowedSenderIds: [], legacy: false };
  }
  setSourceAccess(endpointId: string, input: Pick<SourceAccess, 'mode'> & Partial<Pick<SourceAccess, 'allowedSenderIds'>>): SourceAccess {
    return this.transaction(() => {
      const endpoint = this.getEndpoint(endpointId);
      if (!endpoint) throw new Error('Endpoint not found');
      allowedPatch(input, ['mode', 'allowedSenderIds']);
      if (!['off', 'mention', 'all'].includes(input.mode)) throw new Error('Unknown source access mode');
      const allowedSenderIds = input.allowedSenderIds ?? this.getSourceAccess(endpointId).allowedSenderIds;
      if (!Array.isArray(allowedSenderIds)) throw new Error('Allowed senders must be an array');
      for (const id of allowedSenderIds) required(id, 'Allowed sender ID');
      if (input.mode !== 'off' && this.isDirectMessage(endpoint) && (!allowedSenderIds.length || allowedSenderIds.some(id =>
        !endpoint.people.some(person => person.id === id && !person.isBot) || endpoint.platform === 'telegram' && id !== endpoint.chatId))) {
        throw new Error('Direct messages require explicitly allowed human senders');
      }
      this.setMeta(`source-access:${endpointId}`, JSON.stringify({ mode: input.mode, allowedSenderIds: [...new Set(allowedSenderIds)] }));
      this.db.prepare(`UPDATE slack_sync_streams SET cursor=NULL,covered_through=NULL,scan_until=NULL,scan_oldest=NULL,
        state='backfill',error=NULL,retry_at=NULL WHERE endpoint_id=?`).run(endpointId);
      return this.getSourceAccess(endpointId);
    });
  }
  getSourceRoute(endpointId: string, legacyRule?: AutoLinkRule): SourceRoute {
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint) throw new Error('Endpoint not found');
    const saved = this.getMeta(`source-route:${endpointId}`);
    if (saved !== undefined) {
      try {
        const route = JSON.parse(saved) as SourceRoute;
        if (!['none', 'manual', 'auto'].includes(route.mode) || route.mode === 'auto' && (typeof route.cwd !== 'string' || !isLocalWorkspace(route.cwd))) throw new Error();
        return { endpointId, mode: route.mode, ...(route.mode === 'auto' ? { cwd: route.cwd } : {}) };
      } catch { return { endpointId, mode: 'none' }; }
    }
    if (this.bindingForEndpoint(endpointId)) return { endpointId, mode: 'manual' };
    return this.matchesSourceRule(endpoint, legacyRule) ? { endpointId, mode: 'auto', cwd: legacyRule!.cwd } : { endpointId, mode: 'none' };
  }
  private matchesSourceRule(endpoint: Endpoint, rule?: AutoLinkRule): boolean {
    return !!rule && rule.enabled === true && rule.platform === endpoint.platform && rule.accountId === endpoint.accountId && rule.chatId === endpoint.chatId && Array.isArray(rule.allowedSenderIds);
  }
  private legacySourceAll(endpointId: string, fallback = false): boolean {
    const saved = this.getMeta(`source-access:${endpointId}`);
    if (saved !== undefined) {
      try {
        const access = JSON.parse(saved) as { legacy?: boolean; allowAllSenders?: boolean };
        if (access.legacy === true && typeof access.allowAllSenders === 'boolean') return access.allowAllSenders;
      } catch { /* Invalid snapshots already resolve to off in getSourceAccess. */ }
    }
    return fallback;
  }
  getSourceAutoRule(endpointId: string, legacyRule?: AutoLinkRule): AutoLinkRule | undefined {
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint) throw new Error('Endpoint not found');
    const route = this.getSourceRoute(endpointId);
    const access = this.getSourceAccess(endpointId, legacyRule);
    if (access.mode === 'off') return undefined;
    if (route.mode === 'auto') return { id: `source:${endpointId}`, enabled: true, platform: endpoint.platform,
      accountId: endpoint.accountId, chatId: endpoint.chatId, cwd: route.cwd!, allowedSenderIds: access.allowedSenderIds,
      requireMention: access.mode === 'mention', allowAllSenders: access.legacy ? this.legacySourceAll(endpointId) : !this.isDirectMessage(endpoint) };
    if (this.getMeta(`source-route:${endpointId}`) !== undefined || this.bindingForEndpoint(endpointId) || !this.matchesSourceRule(endpoint, legacyRule)) return undefined;
    return access.legacy ? legacyRule : { ...legacyRule!, allowedSenderIds: access.allowedSenderIds,
      requireMention: access.mode === 'mention', allowAllSenders: !this.isDirectMessage(endpoint) };
  }
  routeSource(endpointId: string, conversationId: string | null, automaticCwd?: string, legacyRule?: AutoLinkRule): SourceRoute {
    return this.transaction(() => this.routeSourceInside(endpointId, conversationId, automaticCwd, undefined, legacyRule));
  }
  routeSourceToThread(endpointId: string, input: { threadId: string; cwd: string; name: string }, recoveryIntentId?: string, legacyRule?: AutoLinkRule): SourceRoute {
    return this.transaction(() => {
      required(input.threadId, 'Native Codex thread'); required(input.cwd, 'Working directory');
      if (recoveryIntentId !== undefined) {
        const intent = this.getAutoLinkIntent(recoveryIntentId);
        if (!intent || intent.endpointId !== endpointId || !['uncertain', 'failed', 'created'].includes(intent.status)) {
          throw Object.assign(new Error('Выберите незавершённое автосоздание этого источника с подтверждённым отказом или неопределённым результатом.'), { statusCode: 409 });
        }
        if (intent.threadId && intent.threadId !== input.threadId) throw Object.assign(new Error('Выбранный разговор не совпадает с сохранённым результатом автосоздания.'), { statusCode: 409 });
        if (!isLocalWorkspace(input.cwd) || workingDirectoryKey(intent.rule.cwd) !== workingDirectoryKey(input.cwd)) {
          throw Object.assign(new Error('Рабочая папка не совпадает с принятым автосозданием.'), { statusCode: 409 });
        }
      }
      const existing = this.db.prepare('SELECT id FROM conversations WHERE thread_id=?').get(input.threadId);
      const conversation = existing ? this.getConversation(existing.id as string)! : this.writeConversation(input);
      if (workingDirectoryKey(conversation.cwd) !== workingDirectoryKey(input.cwd)) throw new Error('Native Codex thread belongs to another working directory');
      return this.routeSourceInside(endpointId, conversation.id, undefined, recoveryIntentId, legacyRule);
    });
  }
  private routeSourceInside(endpointId: string, conversationId: string | null, automaticCwd?: string, recoveryIntentId?: string, legacyRule?: AutoLinkRule): SourceRoute {
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint) throw new Error('Endpoint not found');
    if (automaticCwd !== undefined && (conversationId !== null || !isLocalWorkspace(automaticCwd))) throw new Error('Choose an absolute local working directory for automatic creation');
    if (conversationId !== null && !this.getConversation(conversationId)) throw new Error('Conversation not found');
    const previous = this.bindingForEndpoint(endpointId);
    const mode = conversationId !== null ? 'manual' : automaticCwd !== undefined ? 'auto' : 'none';
    const route = this.getSourceRoute(endpointId);
    const unchanged = (previous?.conversationId ?? null) === conversationId && route.mode === mode && route.cwd === automaticCwd &&
      (mode !== 'none' || this.getMeta(`source-route:${endpointId}`) !== undefined);
    if (!unchanged) this.assertNoPendingAsyncQuestion(endpointId);
    if (!unchanged && this.db.prepare(`SELECT 1 FROM requests WHERE json_extract(origin,'$.endpointId')=?
      AND status IN ('queued',${BLOCKING_REQUESTS}) LIMIT 1`).get(endpointId)) {
      throw Object.assign(new Error('Завершите или отмените принятые запросы этого источника перед сменой разговора Codex.'), { statusCode: 409 });
    }
    const openIntent = this.db.prepare("SELECT id FROM auto_link_intents WHERE endpoint_id=? AND status<>'completed'").get(endpointId);
    if (!unchanged && openIntent && openIntent.id !== recoveryIntentId) {
      throw Object.assign(new Error('Принято автосоздание этого источника. Дождитесь результата или явно восстановите его через журнал автосоздания.'), { statusCode: 409 });
    }
    if (this.getMeta(`source-access:${endpointId}`) === undefined) {
      if (previous && conversationId === null) this.setMeta(`source-access:${endpointId}`, JSON.stringify({
        mode: previous.requireMention ? 'mention' : 'all', allowedSenderIds: previous.allowedSenderIds,
        allowAllSenders: !!previous.allowAllSenders, legacy: true,
      }));
      else if (!previous) {
        const access = this.getSourceAccess(endpointId, legacyRule);
        this.setMeta(`source-access:${endpointId}`, JSON.stringify(access.legacy ? { mode: access.mode,
          allowedSenderIds: access.allowedSenderIds, allowAllSenders: !!legacyRule?.allowAllSenders, legacy: true,
        } : { mode: 'off', allowedSenderIds: [] }));
      }
    }
    if (previous && previous.conversationId !== conversationId) {
      if (conversationId === null) this.db.prepare('DELETE FROM bindings WHERE id=?').run(previous.id);
      else this.db.prepare('UPDATE bindings SET conversation_id=? WHERE id=?').run(conversationId, previous.id);
      if (endpoint.platform === 'slack') this.resetSlackSyncStream(previous.conversationId, endpointId);
      this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(new Date().toISOString(), previous.conversationId);
    } else if (!previous && conversationId !== null) {
      this.writeBinding(conversationId, endpoint.platform, endpointId, this.getSourceAccess(endpointId).allowedSenderIds);
    }
    if (conversationId !== null) {
      if (endpoint.platform === 'slack' && previous?.conversationId !== conversationId) this.resetSlackSyncStream(conversationId, endpointId);
      this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(new Date().toISOString(), conversationId);
    }
    this.setMeta(`source-route:${endpointId}`, JSON.stringify({ mode, ...(automaticCwd !== undefined ? { cwd: automaticCwd } : {}) }));
    return this.getSourceRoute(endpointId);
  }
  private sourceContextEnabled(endpointId: string): boolean { return this.getSourceAccess(endpointId).mode !== 'off'; }
  private assertNoPendingAsyncQuestion(endpointId: string): void {
    if (this.db.prepare(`SELECT 1 FROM approvals a JOIN requests r ON r.id=a.request_id
      WHERE a.method=? AND json_extract(r.origin,'$.endpointId')=? AND (a.status='pending' OR EXISTS
        (SELECT 1 FROM meta m WHERE m.key='steering-input:'||a.id AND json_extract(m.value,'$.approvalId')=a.id
          AND json_extract(m.value,'$.state') IN ('sending','uncertain')) OR EXISTS
        (SELECT 1 FROM requests child JOIN meta m ON m.key='async-question-answer:'||child.id AND m.value=a.id
          WHERE child.id=a.id AND child.event_id='async-question-answer:'||a.id AND child.conversation_id=r.conversation_id
            AND child.status IN ('queued',${BLOCKING_REQUESTS}))) LIMIT 1`).get(ASYNC_USER_INPUT, endpointId)) {
      throw Object.assign(new Error('Ответьте на ожидающий вопрос Codex перед сменой связки этого источника.'), { statusCode: 409 });
    }
  }
  private sourceSyncStream(row: Row): SlackSyncStream {
    const stream = toSlackSyncStream({ ...row, platform: this.getEndpoint(row.endpoint_id as string)!.platform });
    if (stream.active && !this.sourceContextEnabled(stream.endpointId)) stream.active = false;
    return stream;
  }
  private writeBinding(conversationId: string, platform: Platform, endpointId: string, allowedSenderIds: string[], bindingId?: string, policy?: BindingPolicy): Binding {
    if (!this.getConversation(conversationId)) throw new Error('Conversation not found');
    const previous = bindingId ? this.getBinding(conversationId, bindingId) : undefined;
    if (bindingId && !previous) throw new Error('Binding not found');
    if (previous && previous.platform !== platform) throw new Error('Binding platform is immutable');
    if (previous && previous.endpointId !== endpointId) this.assertNoPendingAsyncQuestion(previous.endpointId);
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint) throw new Error('Endpoint not found');
    if (endpoint.platform !== platform) throw new Error('Endpoint platform does not match the binding');
    if (!Array.isArray(allowedSenderIds)) throw new Error('Allowed senders must be an array');
    for (const senderId of allowedSenderIds) required(senderId, 'Allowed sender ID');
    for (const value of [policy?.allowAllSenders, policy?.requireMention]) if (value !== undefined && typeof value !== 'boolean') throw new Error('Binding policy must be boolean');
    const inheritedPolicy = previous?.endpointId === endpointId ? previous : undefined;
    const allowAllSenders = policy?.allowAllSenders ?? inheritedPolicy?.allowAllSenders ?? false;
    const requireMention = policy?.requireMention ?? inheritedPolicy?.requireMention ?? false;
    if (allowAllSenders && this.isDirectMessage(endpoint)) throw new Error('Direct messages require explicitly allowed human senders');
    const id = previous?.id ?? randomUUID();
    if (previous) this.db.prepare('UPDATE bindings SET endpoint_id=?,allowed_sender_ids=?,allow_all_senders=?,require_mention=? WHERE id=? AND conversation_id=?')
      .run(endpointId, JSON.stringify([...new Set(allowedSenderIds)]), Number(allowAllSenders), Number(requireMention), id, conversationId);
    else this.db.prepare('INSERT INTO bindings (id,conversation_id,platform,endpoint_id,allowed_sender_ids,allow_all_senders,require_mention) VALUES (?,?,?,?,?,?,?)')
      .run(id, conversationId, platform, endpointId, JSON.stringify([...new Set(allowedSenderIds)]), Number(allowAllSenders), Number(requireMention));
    if (platform === 'slack' && previous?.endpointId !== endpointId) {
      if (previous) this.resetSlackSyncStream(conversationId, previous.endpointId);
      this.resetSlackSyncStream(conversationId, endpointId);
    }
    this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(new Date().toISOString(), conversationId);
    return this.getBinding(conversationId, id)!;
  }
  addBinding(conversationId: string, platform: Platform, endpointId: string, allowedSenderIds: string[], policy?: BindingPolicy): Binding {
    return this.transaction(() => this.writeBinding(conversationId, platform, endpointId, allowedSenderIds, undefined, policy));
  }
  updateBinding(conversationId: string, bindingId: string, endpointId: string, allowedSenderIds: string[], policy?: BindingPolicy): Binding {
    return this.transaction(() => {
      const binding = this.getBinding(conversationId, bindingId);
      if (!binding) throw new Error('Binding not found');
      return this.writeBinding(conversationId, binding.platform, endpointId, allowedSenderIds, bindingId, policy);
    });
  }
  setBinding(conversationId: string, platform: Platform, endpointId: string, allowedSenderIds: string[], policy?: BindingPolicy): Binding {
    return this.transaction(() => {
      const conversation = this.getConversation(conversationId);
      if (!conversation) throw new Error('Conversation not found');
      const matches = conversation.bindings.filter(binding => binding.platform === platform);
      if (matches.length > 1) throw new Error('Multiple bindings require a binding ID');
      return this.writeBinding(conversationId, platform, endpointId, allowedSenderIds, matches[0]?.id, policy);
    });
  }
  removeBinding(conversationId: string, bindingId: string): void {
    this.transaction(() => {
      if (!this.getConversation(conversationId)) throw new Error('Conversation not found');
      const binding = this.getBinding(conversationId, bindingId);
      if (!binding) throw new Error('Binding not found');
      this.assertNoPendingAsyncQuestion(binding.endpointId);
      this.db.prepare('DELETE FROM bindings WHERE conversation_id=? AND id=?').run(conversationId, bindingId);
      if (binding.platform === 'slack') this.resetSlackSyncStream(conversationId, binding.endpointId);
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
      JOIN conversations c ON c.id=b.conversation_id`).all();
    for (const row of rows) {
      if (!this.sourceContextEnabled(row.endpoint_id as string)) continue;
      const id = randomUUID();
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO slack_sync_streams
        (id,endpoint_id,conversation_id,codex_thread_id,account_id,chat_id,thread_id) VALUES (?,?,?,?,?,?,?)`)
        .run(id, row.endpoint_id, row.conversation_id, row.codex_thread_id, row.account_id, row.chat_id, row.thread_id);
      if (!inserted.changes) continue;
      // Existing receipts remain useful when upgrading, even before Slack backfill succeeds.
      for (const receipt of this.db.prepare('SELECT payload,request_id,created_at FROM inbound_events WHERE endpoint_id=? ORDER BY rowid').all(row.endpoint_id)) {
        const inbound = json<InboundMessage>(receipt.payload);
        if (inbound.control) continue;
        const message = inbound.slack ?? { platform: inbound.endpoint.platform, receivedAt: receipt.created_at as string | undefined,
          participants: inbound.participants, endpointId: inbound.endpoint.id, accountId: inbound.endpoint.accountId,
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
        b.endpoint_id=s.endpoint_id AND b.conversation_id=s.conversation_id) AS active
        FROM slack_sync_streams s JOIN conversations c ON c.id=s.conversation_id ORDER BY s.rowid`).all().map(row => this.sourceSyncStream(row));
    });
  }
  getSlackSyncStream(id: string): SlackSyncStream | undefined {
    const row = this.db.prepare(`SELECT s.*,c.paused,EXISTS(SELECT 1 FROM bindings b WHERE
      b.endpoint_id=s.endpoint_id AND b.conversation_id=s.conversation_id) AS active
      FROM slack_sync_streams s JOIN conversations c ON c.id=s.conversation_id WHERE s.id=?`).get(id);
    return row ? this.sourceSyncStream(row) : undefined;
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
    const revision = slackSourceRevision(message);
    const previous = this.db.prepare('SELECT * FROM slack_sync_entries WHERE stream_id=? AND message_id=? AND semantic_revision=? AND canonical_entry_id IS NULL')
      .get(streamId, message.messageId, revision);
    if (previous) {
      if (requestId && !previous.request_id) this.db.prepare('UPDATE slack_sync_entries SET request_id=? WHERE id=?').run(requestId, previous.id);
      return this.getSlackSyncEntry(previous.id as string)!;
    }
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO slack_sync_entries (id,stream_id,message_id,message_order,revision,semantic_revision,message,request_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, streamId, message.messageId, slackMessageOrder(message.platform === 'telegram'
        ? `${Math.floor(Date.parse(message.receivedAt ?? now) / 1000)}.${String(Date.parse(message.receivedAt ?? now) % 1000).padStart(3, '0')}000`
        : message.messageId), revision, revision, JSON.stringify(message), requestId ?? null, now, now);
    return this.getSlackSyncEntry(id)!;
  }
  private recordSlackMessageInside(message: SlackTranscriptMessage, requestId?: string): SlackSyncEntry | undefined {
    this.ensureSlackSyncStreams();
    let row = this.db.prepare(`SELECT s.id,s.conversation_id FROM slack_sync_streams s JOIN bindings b
      ON b.endpoint_id=s.endpoint_id AND b.conversation_id=s.conversation_id WHERE s.endpoint_id=?`).get(message.endpointId);
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
    if (!row || !this.sourceContextEnabled(message.endpointId)) return undefined;
    if (!message.participants) message = { ...message, participants: this.rememberThreadParticipant(message.endpointId, message.sender, message.messageId) };
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
  listSlackSyncReceiptEntries(id: string): SlackSyncEntry[] {
    const entry = this.getSlackSyncEntry(id);
    if (!entry) return [];
    const canonical = entry.canonicalEntryId ?? entry.id;
    return this.db.prepare(`SELECT * FROM slack_sync_entries WHERE id=? OR canonical_entry_id=? ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,rowid`)
      .all(canonical, canonical, canonical).map(toSlackSyncEntry);
  }
  listSlackSyncEntries(streamId: string, options: { pending?: boolean; beforeMessageId?: string; limit?: number; offset?: number } = {}): SlackSyncEntry[] {
    const before = options.beforeMessageId === undefined ? null : slackMessageOrder(options.beforeMessageId);
    return this.db.prepare(`SELECT * FROM slack_sync_entries WHERE stream_id=? AND canonical_entry_id IS NULL
      AND (?=0 OR (state IN ('pending','uncertain') AND (retry_at IS NULL OR retry_at<=?)))
      AND (? IS NULL OR message_order<=?) ORDER BY message_order,rowid LIMIT ? OFFSET ?`)
      .all(streamId, Number(!!options.pending), new Date().toISOString(), before, before, limitValue(options.limit ?? 100), limitValue(options.offset ?? 0)).map(toSlackSyncEntry);
  }
  listPendingSlackSyncEntries(conversationId: string, beforeMessageId?: string, limit = 10): SlackSyncEntry[] {
    const before = beforeMessageId === undefined ? null : slackMessageOrder(beforeMessageId);
    return this.db.prepare(`SELECT e.* FROM slack_sync_entries e JOIN slack_sync_streams s ON s.id=e.stream_id
      WHERE s.conversation_id=? AND e.canonical_entry_id IS NULL AND e.state IN ('pending','uncertain') AND (e.retry_at IS NULL OR e.retry_at<=?)
      AND NOT EXISTS(SELECT 1 FROM meta m WHERE m.key LIKE 'steering-input:%'
        AND json_extract(m.value,'$.entryId') IN (SELECT id FROM slack_sync_entries WHERE id=e.id OR canonical_entry_id=e.id)
        AND json_extract(m.value,'$.state')<>'refused')
      AND (? IS NULL OR e.message_order<=?) ORDER BY e.message_order,e.rowid LIMIT ?`)
      .all(conversationId, new Date().toISOString(), before, before, limitValue(limit)).map(toSlackSyncEntry);
  }
  latestSlackMessageId(streamId: string): string | undefined {
    return this.db.prepare('SELECT message_id FROM slack_sync_entries WHERE stream_id=? ORDER BY message_order DESC,rowid DESC LIMIT 1').get(streamId)?.message_id as string | undefined;
  }
  hasPendingSlackSyncEntries(streamId: string, beforeMessageId?: string): boolean {
    const before = beforeMessageId === undefined ? null : slackMessageOrder(beforeMessageId);
    return !!this.db.prepare(`SELECT 1 FROM slack_sync_entries WHERE stream_id=? AND canonical_entry_id IS NULL
      AND state<>'applied' AND (? IS NULL OR message_order<=?) LIMIT 1`).get(streamId, before, before);
  }
  getSlackSyncCounts(streamId: string): Record<SlackSyncEntry['state'], number> {
    const counts: Record<SlackSyncEntry['state'], number> = { pending: 0, applying: 0, applied: 0, uncertain: 0 };
    for (const row of this.db.prepare('SELECT state,COUNT(*) AS count FROM slack_sync_entries WHERE stream_id=? AND canonical_entry_id IS NULL GROUP BY state').all(streamId)) counts[row.state as SlackSyncEntry['state']] = Number(row.count);
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
        AND canonical_entry_id IS NULL AND state IN ('pending','uncertain') AND (retry_at IS NULL OR retry_at<=?)
        AND NOT EXISTS(SELECT 1 FROM meta m WHERE m.key LIKE 'steering-input:%'
          AND json_extract(m.value,'$.entryId') IN (SELECT member.id FROM slack_sync_entries member WHERE member.id=slack_sync_entries.id OR member.canonical_entry_id=slack_sync_entries.id)
          AND json_extract(m.value,'$.state')<>'refused')
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
    let event = this.db.prepare('SELECT request_id,payload FROM inbound_events WHERE platform=? AND account_id=? AND event_id=?')
      .get(endpoint.platform, endpoint.accountId, message.eventId)
      ?? this.db.prepare(`SELECT e.request_id,e.payload FROM inbound_source_versions v JOIN inbound_events e
        ON e.platform=v.platform AND e.account_id=v.account_id AND e.event_id=v.canonical_event_id
        WHERE v.platform=? AND v.account_id=? AND v.event_id=?`).get(endpoint.platform, endpoint.accountId, message.eventId);
    const revision = inboundSourceRevision(message);
    if (!event) {
      const canonical = this.db.prepare(`SELECT v.canonical_event_id,e.request_id,e.payload FROM inbound_source_versions v JOIN inbound_events e
        ON e.platform=v.platform AND e.account_id=v.account_id AND e.event_id=v.canonical_event_id
        WHERE v.platform=? AND v.account_id=? AND v.endpoint_id=? AND v.message_id=? AND v.revision=? AND v.event_id=v.canonical_event_id`)
        .get(endpoint.platform, endpoint.accountId, endpoint.id, message.messageId, revision);
      if (canonical) {
        this.db.prepare(`INSERT INTO inbound_source_versions(platform,account_id,event_id,endpoint_id,message_id,revision,canonical_event_id) VALUES (?,?,?,?,?,?,?)`)
          .run(endpoint.platform, endpoint.accountId, message.eventId, endpoint.id, message.messageId, revision, canonical.canonical_event_id);
        event = canonical;
      }
    }
    if (event) {
      const requestId = optional(event.request_id);
      const original = json<InboundMessage>(event.payload).slack;
      if (original) this.recordSlackMessageInside(original, requestId);
      return { duplicate: true, requestId };
    }
    this.writeEndpoint(endpoint);
    const now = new Date().toISOString();
    const participants = message.control ? undefined : this.rememberThreadParticipant(endpoint.id, message.sender, message.messageId);
    const saved = { ...message, ...(participants ? { participants } : {}),
      ...(message.slack ? { slack: { ...message.slack, participants } } : {}) };
    this.db.prepare('INSERT INTO inbound_events (platform,account_id,event_id,endpoint_id,payload,created_at) VALUES (?,?,?,?,?,?)')
      .run(endpoint.platform, endpoint.accountId, message.eventId, endpoint.id, JSON.stringify(saved), now);
    this.db.prepare(`INSERT INTO inbound_source_versions(platform,account_id,event_id,endpoint_id,message_id,revision,canonical_event_id) VALUES (?,?,?,?,?,?,?)`)
      .run(endpoint.platform, endpoint.accountId, message.eventId, endpoint.id, message.messageId, revision, message.eventId);
    if (!message.control) this.recordSlackMessageInside(saved.slack ?? { platform: endpoint.platform, receivedAt: now,
      endpointId: endpoint.id, accountId: endpoint.accountId, chatId: endpoint.chatId, threadId: endpoint.threadId,
      messageId: message.messageId, sender: message.sender, participants, text: message.text,
      payload: { text: message.text, ...(message.audio ? { audio: message.audio } : {}) }, kind: 'message' });
    return { duplicate: false };
  }

  /** Only observed authors of this source thread; never the channel-member catalog. */
  rememberThreadParticipant(endpointId: string, sender: Person, messageId: string): Person[] {
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint) throw new Error('Participant source not found');
    const order = (id: string) => endpoint.platform === 'telegram' && /^\d+$/u.test(id) ? id.padStart(30, '0') : slackMessageOrder(id);
    const key = `thread-participants:${endpointId}`;
    const stored = this.getMeta(key);
    const people = new Map<string, { person: Person; first: string }>(stored ? JSON.parse(stored) : []);
    const observe = (person: Person, id: string) => {
      if (person.id === 'slack:unknown') return;
      const previous = people.get(person.id);
      people.set(person.id, { person: personRole(person, previous?.person, endpoint.people.find(profile => profile.id === person.id)),
        first: previous && previous.first < order(id) ? previous.first : order(id) });
    };
    if (!stored) {
      for (const row of this.db.prepare('SELECT payload FROM inbound_events WHERE endpoint_id=? ORDER BY rowid').all(endpointId)) {
        const old = json<InboundMessage>(row.payload);
        if (!old.control) observe(old.sender, old.messageId);
      }
      for (const row of this.db.prepare('SELECT message FROM slack_sync_entries WHERE stream_id IN (SELECT id FROM slack_sync_streams WHERE endpoint_id=?) ORDER BY rowid').all(endpointId)) {
        const old = json<SlackTranscriptMessage>(row.message);
        if (old.kind !== 'deleted') observe(old.sender, old.messageId);
      }
    }
    observe(sender, messageId);
    this.setMeta(key, JSON.stringify([...people]));
    return [...people.values()].filter(person => person.first <= order(messageId))
      .map(value => personRole(value.person, undefined, endpoint.people.find(profile => profile.id === value.person.id)));
  }
  getThreadParticipants(endpointId: string): Person[] {
    const profiles = this.getEndpoint(endpointId)?.people ?? [];
    const stored = this.getMeta(`thread-participants:${endpointId}`);
    if (stored) return (JSON.parse(stored) as Array<[string, { person: Person }]>).map(([, value]) => personRole(value.person, undefined, profiles.find(profile => profile.id === value.person.id)));
    const people = new Map<string, Person>();
    const observe = (person: Person) => {
      if (person.id !== 'slack:unknown') people.set(person.id, personRole(person, people.get(person.id), profiles.find(profile => profile.id === person.id)));
    };
    for (const row of this.db.prepare('SELECT payload FROM inbound_events WHERE endpoint_id=? ORDER BY rowid').all(endpointId)) {
      const message = json<InboundMessage>(row.payload); if (!message.control) observe(message.sender);
    }
    for (const row of this.db.prepare('SELECT message FROM slack_sync_entries WHERE stream_id IN (SELECT id FROM slack_sync_streams WHERE endpoint_id=?) ORDER BY rowid').all(endpointId)) observe(json<SlackTranscriptMessage>(row.message).sender);
    return [...people.values()];
  }
  recordInbound(message: InboundMessage): { duplicate: boolean } {
    return this.transaction(() => ({ duplicate: this.recordEvent(message).duplicate }));
  }
  private isBotMessage(message: InboundMessage): boolean {
    return this.getEndpoint(message.endpoint.id)?.people.find(person => person.id === message.sender.id)?.isBot
      ?? message.sender.isBot ?? message.slack?.sender.isBot ?? false;
  }
  private isDirectMessage(endpoint: Endpoint): boolean {
    return endpoint.platform === 'slack' ? endpoint.chatId.startsWith('D') : /^\d+$/u.test(endpoint.chatId);
  }
  private acceptsRequest(message: InboundMessage, allowedSenderIds: string[], policy: BindingPolicy = {}): boolean {
    const endpoint = message.endpoint;
    const group = !this.isDirectMessage(endpoint);
    const all = group && policy.allowAllSenders === true;
    if (message.contextOnly || message.control || message.slack && message.slack.kind !== 'message') return false;
    if (!group && (this.isBotMessage(message) || endpoint.platform === 'telegram' && message.sender.id !== endpoint.chatId)) return false;
    if (all) {
      const stable = endpoint.platform === 'slack'
        ? /^[UW][A-Z0-9]+$/u.test(message.sender.id) || message.sender.isBot === true && /^bot:B[A-Z0-9]+$/u.test(message.sender.id)
        : /^\d+$/u.test(message.sender.id);
      const self = message.sender.id === (endpoint.platform === 'slack' ? endpoint.accountId.split(':').at(-1) : endpoint.accountId);
      return stable && !self && message.sender.id !== 'USLACKBOT' && (!policy.requireMention || message.directMention === true);
    }
    return !(this.isBotMessage(message) && !message.directMention) &&
      (!group || !policy.requireMention || message.directMention === true) && allowedSenderIds.includes(message.sender.id);
  }
  private acceptsSourceRequest(message: InboundMessage, binding: BindingPolicy & { allowedSenderIds: string[] }, rule?: AutoLinkRule): boolean {
    const access = this.getSourceAccess(message.endpoint.id, rule);
    if (access.mode === 'off') return false;
    if (access.legacy) return this.acceptsRequest(message, access.allowedSenderIds, {
      allowAllSenders: this.legacySourceAll(message.endpoint.id, binding.allowAllSenders), requireMention: access.mode === 'mention',
    });
    return (access.mode !== 'mention' || message.directMention === true) && this.acceptsRequest(message, access.allowedSenderIds,
      { allowAllSenders: !this.isDirectMessage(message.endpoint), requireMention: false });
  }
  private writeRequest(message: InboundMessage, binding: Binding): ReleRequest {
    const endpoint = message.endpoint;
    const now = new Date().toISOString();
    const receipt = this.db.prepare('SELECT payload FROM inbound_events WHERE platform=? AND account_id=? AND event_id=?')
      .get(endpoint.platform, endpoint.accountId, message.eventId)!;
    const saved = json<InboundMessage>(receipt.payload);
    const origin: Origin = { platform: endpoint.platform, accountId: endpoint.accountId, endpointId: endpoint.id,
      chatId: endpoint.chatId, threadId: endpoint.threadId, senderId: saved.sender.id, senderName: saved.sender.name,
      senderIsBot: saved.sender.isBot, participants: saved.participants, messageId: message.messageId };
    const id = randomUUID();
    this.db.prepare(`INSERT INTO requests (id,conversation_id,event_id,origin,text,audio,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?)`)
      .run(id, binding.conversationId, message.eventId, JSON.stringify(origin), message.text, message.audio ? JSON.stringify(message.audio) : null, now, now);
    this.db.prepare('UPDATE inbound_events SET request_id=? WHERE platform=? AND account_id=? AND event_id=?').run(id, endpoint.platform, endpoint.accountId, message.eventId);
    const entry = this.recordSlackMessageInside(saved.slack ?? { platform: endpoint.platform, endpointId: endpoint.id,
      accountId: endpoint.accountId, chatId: endpoint.chatId, threadId: endpoint.threadId, messageId: message.messageId,
      sender: saved.sender, text: saved.text, payload: { text: saved.text, ...(saved.audio ? { audio: saved.audio } : {}) }, kind: 'message' }, id);
    if (entry) {
      const members = this.listSlackSyncReceiptEntries(entry.id).map(value => value.id);
      for (const row of this.db.prepare(`SELECT value FROM meta WHERE key LIKE 'steering-input:%'
        AND json_extract(value,'$.entryId') IN (SELECT value FROM json_each(?))`).all(JSON.stringify(members))) {
        this.attachLateSteeringRequest(JSON.parse(row.value as string) as SteeringInput);
      }
    }
    return this.getRequest(id)!;
  }
  ingest(message: InboundMessage, auto?: { rule: AutoLinkRule; targetFingerprint: string }): { request: ReleRequest | null; duplicate: boolean; autoLinkIntent?: AutoLinkIntent } {
    return this.transaction(() => {
      const event = this.recordEvent(message);
      if (event.duplicate) return { request: event.requestId ? this.getRequest(event.requestId)! : null, duplicate: true };
      const binding = this.bindingForEndpoint(message.endpoint.id);
      if (binding) return { request: !this.getConversation(binding.conversationId)!.paused && this.acceptsSourceRequest(message, binding)
        ? this.writeRequest(message, binding) : null, duplicate: false };
      const rule = auto && this.getSourceAutoRule(message.endpoint.id, auto.rule);
      const intent = auto && rule && this.acceptsAutoLink(message, rule) ? this.recordAutoLink(message, { ...auto, rule }) : undefined;
      return { request: null, duplicate: false, ...(intent ? { autoLinkIntent: intent } : {}) };
    });
  }
  private acceptsAutoLink(message: InboundMessage, rule: AutoLinkRule): boolean {
    const endpoint = message.endpoint;
    if (!rule || typeof rule !== 'object') return false;
    const directMessage = this.isDirectMessage(endpoint);
    return !(directMessage && (rule.allowAllSenders || this.isBotMessage(message) || endpoint.platform === 'telegram' && message.sender.id !== endpoint.chatId)) && rule.enabled === true && !!rule.id?.trim() && !!rule.cwd?.trim() && typeof rule.requireMention === 'boolean' &&
      rule.platform === endpoint.platform && rule.accountId === endpoint.accountId && rule.chatId === endpoint.chatId &&
      Array.isArray(rule.allowedSenderIds) && this.acceptsSourceRequest(message, rule, rule) &&
      (!rule.requireMention || directMessage || message.directMention === true) &&
      (!!message.audio || typeof message.text === 'string' && !!message.text.trim()) &&
      !/^(?:rele:cancel|\/rele_cancel(?:@[\w]+)?)(?:\s|$)/iu.test(message.text) &&
      !(endpoint.platform === 'telegram' && /^\/(?:start|rele_register|rele_chats)(?:@[\w]+)?(?:\s|$)/iu.test(message.text));
  }
  private recordAutoLink(message: InboundMessage, auto: { rule: AutoLinkRule; targetFingerprint: string }): AutoLinkIntent | undefined {
    required(auto.targetFingerprint, 'Codex target fingerprint');
    let row = this.db.prepare("SELECT * FROM auto_link_intents WHERE endpoint_id=? AND status<>'completed'").get(message.endpoint.id);
    if (row && (row.target_fingerprint !== auto.targetFingerprint || stableJson(json(row.rule)) !== stableJson(auto.rule))) return undefined;
    if (!row) {
      const id = randomUUID(); const now = new Date().toISOString();
      this.db.prepare('INSERT INTO auto_link_intents(id,endpoint_id,rule,target_fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(id, message.endpoint.id, JSON.stringify(auto.rule), auto.targetFingerprint, now, now);
      row = this.db.prepare('SELECT * FROM auto_link_intents WHERE id=?').get(id)!;
    }
    this.db.prepare('UPDATE inbound_events SET auto_link_intent_id=? WHERE platform=? AND account_id=? AND event_id=?')
      .run(row.id, message.endpoint.platform, message.endpoint.accountId, message.eventId);
    return toAutoLinkIntent(row);
  }
  getAutoLinkIntent(id: string): AutoLinkIntent | undefined {
    const row = this.db.prepare('SELECT * FROM auto_link_intents WHERE id=?').get(id);
    return row ? toAutoLinkIntent(row) : undefined;
  }
  listAutoLinkIntents(): AutoLinkIntent[] {
    return this.db.prepare('SELECT * FROM auto_link_intents ORDER BY rowid').all().map(toAutoLinkIntent);
  }
  claimAutoLinkIntent(id: string): AutoLinkIntent | undefined {
    return this.transaction(() => {
      const intent = this.getAutoLinkIntent(id);
      const endpoint = intent && this.getEndpoint(intent.endpointId);
      const rule = intent?.rule;
      if (!endpoint || !rule || typeof rule.id !== 'string' || !rule.id.trim() || typeof intent.targetFingerprint !== 'string' || !intent.targetFingerprint.trim()
        || typeof rule.requireMention !== 'boolean' || rule.enabled !== true || typeof rule.cwd !== 'string' || !rule.cwd.trim() || !Array.isArray(rule.allowedSenderIds)
        || rule.platform !== endpoint.platform || rule.accountId !== endpoint.accountId || rule.chatId !== endpoint.chatId) return undefined;
      const effectiveRule = this.getSourceAutoRule(intent.endpointId, rule);
      if (!effectiveRule || stableJson(effectiveRule) !== stableJson(rule)) return undefined;
      const changed = this.db.prepare(`UPDATE auto_link_intents SET status='creating',error=NULL,updated_at=?
        WHERE id=? AND status='pending' AND thread_id IS NULL AND NOT EXISTS(SELECT 1 FROM bindings b WHERE b.endpoint_id=auto_link_intents.endpoint_id)`)
        .run(new Date().toISOString(), id);
      return changed.changes ? this.getAutoLinkIntent(id) : undefined;
    });
  }
  updateAutoLinkIntent(id: string, patch: Partial<Pick<AutoLinkIntent, 'status' | 'threadId' | 'error'>>): AutoLinkIntent {
    allowedPatch(patch, ['status', 'threadId', 'error']);
    return this.transaction(() => {
      const current = this.getAutoLinkIntent(id);
      if (!current) throw new Error('Auto-link intent not found');
      if ('threadId' in patch) {
        required(patch.threadId!, 'Native Codex thread');
        if (current.threadId && current.threadId !== patch.threadId) throw new Error('Native Codex thread is immutable');
      }
      const next = { ...current, ...patch };
      if (next.status === 'created' && !next.threadId) throw new Error('Persist the native Codex thread before finalizing');
      this.db.prepare('UPDATE auto_link_intents SET status=?,thread_id=?,error=?,updated_at=? WHERE id=?')
        .run(next.status, next.threadId ?? null, next.error ?? null, new Date().toISOString(), id);
      return this.getAutoLinkIntent(id)!;
    });
  }
  finalizeAutoLinkIntent(id: string, name?: string): Conversation | undefined {
    return this.transaction(() => {
      const intent = this.getAutoLinkIntent(id);
      if (!intent) throw new Error('Auto-link intent not found');
      if (intent.status === 'completed') return intent.conversationId ? this.getConversation(intent.conversationId) : undefined;
      let binding = this.bindingForEndpoint(intent.endpointId);
      if (!binding) {
        if (!intent.threadId || intent.status !== 'created') return undefined;
        const effectiveRule = this.getSourceAutoRule(intent.endpointId, intent.rule);
        if (!effectiveRule || stableJson(effectiveRule) !== stableJson(intent.rule)) return undefined;
        const existing = this.db.prepare('SELECT id FROM conversations WHERE thread_id=?').get(intent.threadId);
        const conversation = existing ? this.getConversation(existing.id as string)! : this.writeConversation({
          name: name ?? this.getEndpoint(intent.endpointId)!.title, threadId: intent.threadId, cwd: intent.rule.cwd });
        if (conversation.cwd !== intent.rule.cwd) throw new Error('Native Codex thread belongs to another working directory');
        binding = this.writeBinding(conversation.id, intent.rule.platform, intent.endpointId, intent.rule.allowedSenderIds, undefined, intent.rule);
      }
      const conversation = this.getConversation(binding.conversationId)!;
      if (conversation.paused) {
        this.db.prepare('UPDATE auto_link_intents SET error=?,updated_at=? WHERE id=?').run('Связка приостановлена; принятые события ожидают возобновления.', new Date().toISOString(), id);
        return undefined;
      }
      this.ensureSlackSyncStreams();
      const events = this.db.prepare('SELECT payload FROM inbound_events WHERE auto_link_intent_id=? AND request_id IS NULL ORDER BY rowid').all(id);
      let blocked = false;
      for (const event of events) {
        const message = json<InboundMessage>(event.payload);
        if (!this.acceptsSourceRequest(message, binding)) { blocked = true; continue; }
        this.writeRequest(message, binding);
      }
      const now = new Date().toISOString();
      if (blocked) {
        this.db.prepare('UPDATE auto_link_intents SET error=?,updated_at=? WHERE id=?').run('Текущий доступ связки не разрешает все принятые события автосоздания.', now, id);
        return undefined;
      }
      const error = intent.threadId && intent.threadId !== conversation.threadId ? 'Ручная связка использована; ранее созданный Codex thread остаётся непривязанным.' : null;
      this.db.prepare("UPDATE auto_link_intents SET status='completed',conversation_id=?,thread_id=COALESCE(thread_id,?),error=?,updated_at=? WHERE id=?")
        .run(conversation.id, conversation.threadId, error, now, id);
      return this.getConversation(conversation.id)!;
    });
  }

  getRequest(id: string): ReleRequest | undefined {
    const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    return row ? this.requestFromRow(row) : undefined;
  }
  private requestFromRow(row: Row): ReleRequest {
    const request = toRequest(row);
    if (this.getMeta(`suppressed-final:${request.id}`)) request.suppressedFinal = true;
    const input = this.getSteeringInput(request.id);
    return input?.requestId === request.id && input.state !== 'refused' ? { ...request, steeredInto: input.parentRequestId,
      turnId: input.turnId, status: input.state === 'applied' ? 'completed' : 'uncertain', error: input.error } : request;
  }
  listRequests(limit = 100): ReleRequest[] { return this.db.prepare('SELECT * FROM requests ORDER BY rowid DESC LIMIT ?').all(limitValue(limit)).map(row => this.requestFromRow(row)); }
  listPendingRequests(): ReleRequest[] { return this.db.prepare("SELECT * FROM requests WHERE status='queued' ORDER BY rowid").all().map(row => this.requestFromRow(row)).filter(request => !request.steeredInto); }
  activeRequests(): ReleRequest[] {
    return this.db.prepare(`SELECT * FROM requests WHERE status IN ('queued',${BLOCKING_REQUESTS}) ORDER BY rowid`).all().map(row => this.requestFromRow(row));
  }
  hasUnfinishedCodexOperations(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM auto_link_intents WHERE status<>'completed'
      UNION ALL SELECT 1 FROM approvals WHERE method='rele/asyncUserInput' AND status='pending'
      UNION ALL SELECT 1 FROM meta WHERE
        (key LIKE 'cancel-cleanup:%' AND COALESCE(json_extract(value,'$.done'),0)<>1)
        OR (key LIKE 'steering-input:%' AND json_extract(value,'$.state') IN ('sending','uncertain'))
      LIMIT 1`).get();
  }
  claimNextRequest(conversationId: string, requestId?: string): ReleRequest | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT r.id FROM requests r JOIN conversations c ON c.id=r.conversation_id
        WHERE r.conversation_id=? AND r.status='queued' AND c.paused=0 AND (? IS NULL OR r.id=?)
        AND NOT EXISTS(SELECT 1 FROM meta m WHERE m.key LIKE 'steering-input:%'
          AND (m.key='steering-input:'||r.id OR json_extract(m.value,'$.requestId')=r.id) AND json_extract(m.value,'$.state')<>'refused')
        AND NOT EXISTS(SELECT 1 FROM requests active WHERE active.conversation_id=r.conversation_id AND active.status IN (${BLOCKING_REQUESTS}))
        ORDER BY r.rowid LIMIT 1`).get(conversationId, requestId ?? null, requestId ?? null);
      if (!row) return undefined;
      const id = row.id as string;
      this.db.prepare("UPDATE requests SET status='starting',updated_at=? WHERE id=?").run(new Date().toISOString(), id);
      this.setMeta(`request-started:${id}`, String(Date.now()));
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

  steeringInputs(parentId: string): SteeringInput[] {
    const raw = this.getMeta(`steering-inputs:${parentId}`);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Invalid steering input index');
    return ids.map(id => {
      const input = this.getSteeringInput(id);
      if (!input || input.parentRequestId !== parentId) throw new Error('Steering input index does not match its parent');
      return input;
    });
  }
  getSteeringInput(id: string): SteeringInput | undefined {
    const direct = this.getMeta(`steering-input:${id}`);
    const raw = direct ?? this.db.prepare(`SELECT value FROM meta WHERE key LIKE 'steering-input:%'
      AND json_extract(value,'$.requestId')=?`).get(id)?.value as string | undefined;
    if (!raw) return;
    const input = JSON.parse(raw) as SteeringInput;
    if (!input || input.id !== id && (direct !== undefined || input.requestId !== id) || !input.parentRequestId || !input.turnId || typeof input.text !== 'string'
      || !['sending', 'uncertain', 'applied', 'refused'].includes(input.state)) throw new Error('Invalid steering input receipt');
    return input;
  }
  private attachLateSteeringRequest(input: SteeringInput): SteeringInput {
    if (input.requestId || !input.entryId || input.id !== input.entryId || input.approvalId) return input;
    const entries = this.listSlackSyncReceiptEntries(input.entryId), entry = entries[0];
    const requestIds = [...new Set(entries.flatMap(value => value.requestId ? [value.requestId] : []))];
    if (!entry || requestIds.length !== 1) return input;
    const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(requestIds[0]);
    const child = row && toRequest(row), parentRow = this.db.prepare('SELECT * FROM requests WHERE id=?').get(input.parentRequestId);
    const parent = parentRow && toRequest(parentRow), stream = this.getSlackSyncStream(entry.streamId);
    const receipt = child && this.db.prepare('SELECT payload FROM inbound_events WHERE request_id=?').get(child.id);
    const saved = receipt && json<InboundMessage>(receipt.payload);
    if (!child || !parent || !stream || !saved || child.id === parent.id || child.status !== 'queued' || child.audio
      || child.turnId || child.queuedSubmissionId || parent.turnId !== input.turnId
      || child.conversationId !== parent.conversationId || stream.conversationId !== parent.conversationId
      || saved.eventId !== child.eventId || saved.text !== child.text || saved.sender.id !== child.origin.senderId
      || this.db.prepare(`SELECT 1 FROM meta WHERE key LIKE 'steering-input:%' AND key<>?
        AND (key=? OR json_extract(value,'$.requestId')=? OR json_extract(value,'$.entryId') IN (SELECT value FROM json_each(?)))`)
        .get(`steering-input:${input.id}`, `steering-input:${child.id}`, child.id, JSON.stringify(entries.map(value => value.id)))) return input;
    const original = saved.slack ?? { platform: saved.endpoint.platform, endpointId: saved.endpoint.id, accountId: saved.endpoint.accountId,
      chatId: saved.endpoint.chatId, threadId: saved.endpoint.threadId, messageId: saved.messageId, sender: saved.sender,
      text: saved.text, payload: { text: saved.text }, kind: 'message' as const };
    const sameSource = (source: Pick<Origin, 'platform' | 'accountId' | 'chatId' | 'threadId'> & { endpointId?: string; id?: string }) =>
      source.platform === stream.platform && source.accountId === stream.accountId && source.chatId === stream.chatId
      && source.threadId === stream.threadId && (source.endpointId ?? source.id) === stream.endpointId;
    if (!sameSource(parent.origin) || !sameSource(child.origin) || !sameSource(saved.endpoint)
      || saved.messageId !== child.origin.messageId || entries.some(value => value.streamId !== entry.streamId
        || value.messageId !== child.origin.messageId || value.message.messageId !== value.messageId
        || !sameSource({ ...value.message, platform: value.message.platform ?? stream.platform })
        || value.message.sender.id !== child.origin.senderId || value.message.text !== child.text
        || slackSourceRevision(value.message) !== slackSourceRevision(original))) return input;
    // Preserve the native client UUID: late ingress adds ownership, never another send.
    const next = { ...input, requestId: child.id }, now = new Date().toISOString();
    this.setMeta(`steering-input:${input.id}`, JSON.stringify(next));
    this.db.prepare(`UPDATE slack_sync_entries SET request_id=? WHERE id IN (SELECT value FROM json_each(?))`)
      .run(child.id, JSON.stringify(entries.map(value => value.id)));
    this.db.prepare('UPDATE requests SET status=?,turn_id=?,error=?,updated_at=? WHERE id=?')
      .run(input.state === 'applied' ? 'completed' : 'queued', input.state === 'refused' ? null : input.turnId, input.error ?? null, now, child.id);
    return next;
  }
  beginAsyncQuestionAnswer(approvalId: string, text: string): { input?: SteeringInput; request?: ReleRequest } {
    return this.transaction(() => {
      required(text, 'Async question answer');
      const approval = this.getApproval(approvalId);
      const parent = approval && this.getRequest(approval.requestId);
      if (!approval || approval.method !== ASYNC_USER_INPUT || approval.rpcId !== null || !parent
        || !parent.turnId || parent.turnId !== approval.turnId) throw new Error('Async question does not match its original request turn');
      const existingInput = this.getSteeringInput(approval.id);
      const existingRequest = this.getRequest(approval.id);
      const conversation = this.getConversation(parent.conversationId), endpoint = this.getEndpoint(parent.origin.endpointId);
      const binding = endpoint && this.bindingForEndpoint(endpoint.id);
      if (approval.status !== 'pending' && !(approval.status === 'answered' && (existingInput || existingRequest))
        || !['running', 'waiting_approval', 'completed'].includes(parent.status)
          && !(parent.status === 'uncertain' && existingInput?.state === 'uncertain')
        || !conversation || conversation.paused || !endpoint || !binding || binding.conversationId !== parent.conversationId
        || endpoint.platform !== parent.origin.platform || endpoint.accountId !== parent.origin.accountId
        || endpoint.chatId !== parent.origin.chatId || endpoint.threadId !== parent.origin.threadId
        || this.getSourceAccess(endpoint.id).mode === 'off' || this.getMeta(`mixed:${parent.id}`) === '1'
        || this.getMeta(`cancel-requested:${parent.id}`)
        || this.db.prepare("SELECT 1 FROM approvals WHERE request_id=? AND status='pending' AND method<>? LIMIT 1").get(parent.id, ASYNC_USER_INPUT)) {
        throw new Error('Async question is not available in its original authorized source');
      }
      if (existingInput || existingRequest) {
        if (existingInput && !existingRequest && existingInput.approvalId === approval.id && existingInput.parentRequestId === parent.id
          && existingInput.turnId === approval.turnId && existingInput.text === text && !existingInput.requestId && !existingInput.entryId) return { input: existingInput };
        if (existingRequest && !existingInput && this.getAsyncQuestionAnswerApproval(existingRequest.id)?.id === approval.id
          && existingRequest.text === text) return { request: existingRequest };
        throw new Error('Async question answer already exists with different content');
      }
      if (parent.status !== 'completed') {
        const input: SteeringInput = { id: approval.id, approvalId: approval.id, parentRequestId: parent.id,
          turnId: approval.turnId, text, state: 'sending' };
        const index = this.steeringInputs(parent.id).map(value => value.id);
        this.setMeta(`steering-input:${input.id}`, JSON.stringify(input));
        this.setMeta(`steering-inputs:${parent.id}`, JSON.stringify([...index, input.id]));
        return { input };
      }
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO requests (id,conversation_id,event_id,origin,text,status,created_at,updated_at)
        VALUES (?,?,?,?,?,'queued',?,?)`).run(approval.id, parent.conversationId, `async-question-answer:${approval.id}`,
          JSON.stringify(parent.origin), text, now, now);
      this.setMeta(`async-question-answer:${approval.id}`, approval.id);
      return { request: this.getRequest(approval.id)! };
    });
  }
  getAsyncQuestionAnswerApproval(requestId: string): Approval | undefined {
    if (this.getMeta(`async-question-answer:${requestId}`) !== requestId) return;
    const approval = this.getApproval(requestId), request = this.getRequest(requestId);
    const parent = approval && this.getRequest(approval.requestId);
    if (!approval || approval.method !== ASYNC_USER_INPUT || approval.rpcId !== null || !request || !parent
      || parent.turnId !== approval.turnId || request.eventId !== `async-question-answer:${approval.id}` || request.conversationId !== parent.conversationId
      || stableJson(request.origin) !== stableJson(parent.origin)) return;
    return approval;
  }
  beginSteeringInput(parentId: string, candidate: { id: string; requestId?: string; entryId?: string; text: string }): SteeringInput {
    return this.transaction(() => {
      required(candidate.text, 'Steering text');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(candidate.id)
        || !candidate.requestId && !candidate.entryId || candidate.id !== (candidate.requestId ?? candidate.entryId)) throw new Error('Steering input needs its original request or journal UUID');
      const existing = this.getSteeringInput(candidate.id);
      if (existing) {
        if (existing.parentRequestId !== parentId || existing.requestId !== candidate.requestId || existing.text !== candidate.text
          || candidate.entryId && existing.entryId !== candidate.entryId) throw new Error('Steering input already exists with different content');
        return existing;
      }
      const parent = this.getRequest(parentId), conversation = parent && this.getConversation(parent.conversationId);
      if (!parent || parent.status !== 'running' || !parent.turnId || !conversation || conversation.paused
        || this.getMeta(`mixed:${parentId}`) === '1' || this.getMeta(`cancel-requested:${parentId}`)
        || this.db.prepare("SELECT 1 FROM approvals WHERE request_id=? AND status='pending'").get(parentId)) throw new Error('Steering parent is not a confirmed running request');
      const sameSource = (source: Pick<Origin, 'platform' | 'accountId' | 'chatId' | 'threadId'>) => source.platform === parent.origin.platform
        && source.accountId === parent.origin.accountId && source.chatId === parent.origin.chatId && source.threadId === parent.origin.threadId;
      const child = candidate.requestId ? this.getRequest(candidate.requestId) : undefined;
      let entry = candidate.entryId ? this.getSlackSyncEntry(candidate.entryId) : undefined;
      const sameEntrySource = (value: SlackSyncEntry) => {
        const stream = this.getSlackSyncStream(value.streamId);
        return !!stream && stream.active && !stream.paused && stream.conversationId === parent.conversationId
          && sameSource(stream) && (value.message.platform === undefined || value.message.platform === stream.platform)
          && value.message.endpointId === parent.origin.endpointId;
      };
      if (candidate.requestId) {
        const binding = child && this.bindingForEndpoint(child.origin.endpointId);
        const savedRow = child && this.db.prepare('SELECT payload FROM inbound_events WHERE request_id=?').get(child.id);
        const saved = savedRow && json<InboundMessage>(savedRow.payload);
        if (!child || child.id === parent.id || child.status !== 'queued' || child.audio || child.turnId || child.queuedSubmissionId
          || child.conversationId !== parent.conversationId || !sameSource(child.origin) || !binding || binding.conversationId !== parent.conversationId
          || !saved || !this.acceptsSourceRequest(saved, binding)) throw new Error('Steering request is not an authorized queued input from the same source');
        const original = saved.slack ?? { platform: saved.endpoint.platform, endpointId: saved.endpoint.id, accountId: saved.endpoint.accountId,
          chatId: saved.endpoint.chatId, threadId: saved.endpoint.threadId, messageId: saved.messageId, sender: saved.sender,
          text: saved.text, payload: { text: saved.text }, kind: 'message' as const };
        const matches = (value: SlackSyncEntry) => !value.canonicalEntryId && value.state === 'pending' && value.requestId === child.id && sameEntrySource(value)
          && value.messageId === child.origin.messageId && value.message.sender.id === child.origin.senderId
          && value.message.text === child.text && slackSourceRevision(value.message) === slackSourceRevision(original);
        if (candidate.entryId && (!entry || !matches(entry))) throw new Error('Steering journal entry does not match the immutable request revision');
        if (!candidate.entryId) entry = this.db.prepare('SELECT * FROM slack_sync_entries WHERE request_id=? AND canonical_entry_id IS NULL ORDER BY rowid').all(child.id).map(toSlackSyncEntry).find(matches);
      } else if (!entry || entry.canonicalEntryId || entry.state !== 'pending' || entry.requestId || !sameEntrySource(entry)) {
        throw new Error('Steering journal entry is not pending context from the same source');
      }
      const input: SteeringInput = { id: candidate.id, parentRequestId: parentId, turnId: parent.turnId, text: candidate.text, state: 'sending',
        ...(child ? { requestId: child.id } : {}), ...(entry ? { entryId: entry.id } : {}) };
      if (entry && this.db.prepare(`SELECT 1 FROM meta m WHERE m.key LIKE 'steering-input:%' AND json_extract(m.value,'$.state')<>'refused'
        AND json_extract(m.value,'$.entryId') IN (SELECT id FROM slack_sync_entries WHERE id=? OR canonical_entry_id=?) LIMIT 1`).get(entry.id, entry.id)) {
        throw new Error('This source version already belongs to a steering operation; reconcile without replay');
      }
      const index = this.steeringInputs(parentId).map(value => value.id);
      this.setMeta(`steering-input:${input.id}`, JSON.stringify(input));
      this.setMeta(`steering-inputs:${parentId}`, JSON.stringify([...index, input.id]));
      // Keep the base child queued: the one-active-request SQL index belongs to its parent.
      if (child) this.db.prepare('UPDATE requests SET turn_id=?,error=NULL,updated_at=? WHERE id=?').run(input.turnId, new Date().toISOString(), child.id);
      if (entry) this.db.prepare("UPDATE slack_sync_entries SET state='applying',error=NULL,retry_at=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), entry.id);
      return input;
    });
  }
  finishSteeringInput(id: string, outcome: 'applied' | 'refused' | 'uncertain', error?: string): SteeringInput {
    return this.transaction(() => {
      const found = this.getSteeringInput(id);
      const input = found && this.attachLateSteeringRequest(found);
      if (!input || !['applied', 'refused', 'uncertain'].includes(outcome)) throw new Error('Steering input receipt not found');
      if (input.state === 'applied' || input.state === 'refused') {
        if (input.state !== outcome) throw new Error('A final steering receipt cannot change its outcome');
        return input;
      }
      const entry = input.entryId && this.getSlackSyncEntry(input.entryId);
      const entries = entry ? this.listSlackSyncReceiptEntries(entry.id) : [];
      if (input.entryId && (!entry || entry.requestId !== input.requestId || entries.some(value => value.requestId && value.requestId !== input.requestId))) {
        throw new Error('Steering journal association changed; reconcile without replay');
      }
      const next: SteeringInput = { ...input, state: outcome, ...(error ? { error } : {}) };
      if (!error) delete next.error;
      this.setMeta(`steering-input:${input.id}`, JSON.stringify(next));
      const now = new Date().toISOString();
      if (input.requestId) this.db.prepare('UPDATE requests SET status=?,turn_id=?,error=?,updated_at=? WHERE id=?')
        .run(outcome === 'applied' ? 'completed' : 'queued', outcome === 'refused' ? null : input.turnId, error ?? null, now, input.requestId);
      if (entry) this.db.prepare(`UPDATE slack_sync_entries SET state=?,error=?,retry_at=NULL,updated_at=? WHERE id IN (SELECT value FROM json_each(?))`)
        .run(outcome === 'applied' ? 'applied' : outcome === 'refused' ? 'pending' : 'uncertain', error ?? null, now,
          JSON.stringify(entries.map(value => value.id)));
      return next;
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
  finishRequest(id: string, patch: { status: 'completed' | 'failed' | 'interrupted' | 'cancelled'; error?: string; turnId?: string }, parts: DeliveryPart[], suppressedFinal = false): ReleRequest {
    allowedPatch(patch, ['status', 'error', 'turnId']);
    if (!['completed', 'failed', 'interrupted', 'cancelled'].includes(patch.status)) throw new Error('Finishing a request requires a terminal status');
    return this.transaction(() => {
      const current = this.getRequest(id);
      if (!current) throw new Error('Request not found');
      const next = { ...current, ...patch };
      const now = new Date().toISOString();
      if (suppressedFinal) {
        if (next.status !== 'completed' || parts.length) throw new Error('Only a successful final reply may be suppressed');
        this.setMeta(`suppressed-final:${id}`, JSON.stringify({ reason: 'NOREPLY', turnId: next.turnId, at: now }));
      }
      this.db.prepare('UPDATE requests SET status=?,turn_id=?,error=?,updated_at=? WHERE id=?').run(next.status, next.turnId ?? null, next.error ?? null, now, id);
      this.db.prepare("UPDATE approvals SET status='expired',updated_at=? WHERE request_id=? AND status='pending' AND (?<>'completed' OR method<>?)")
        .run(now, id, patch.status, ASYNC_USER_INPUT);
      this.db.prepare(`UPDATE deliveries SET status='cancelled',updated_at=? WHERE request_id=? AND kind='approval' AND status IN ('pending','failed')
        AND (?<>'completed' OR approval_id IS NULL OR approval_id NOT IN (SELECT id FROM approvals WHERE method=? AND status='pending'))`)
        .run(now, id, patch.status, ASYNC_USER_INPUT);
      this.writeDeliveries(id, parts);
      return this.getRequest(id)!;
    });
  }
  getDelivery(id: string): Delivery | undefined {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id);
    if (row) return toDelivery(row);
    const tool = this.db.prepare('SELECT * FROM tool_outbox WHERE id=?').get(id);
    return tool ? toToolDelivery(tool) : undefined;
  }
  listDeliveries(limit = 100): Delivery[] {
    const count = limitValue(limit);
    return [...this.db.prepare('SELECT * FROM deliveries ORDER BY rowid DESC LIMIT ?').all(count).map(toDelivery),
      ...this.db.prepare('SELECT * FROM tool_outbox ORDER BY rowid DESC LIMIT ?').all(count).map(toToolDelivery)]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, count);
  }
  toolMessageForCall(threadId: string, callId: string, args: unknown): Delivery | undefined {
    const row = this.db.prepare('SELECT * FROM tool_outbox WHERE thread_id=? AND call_id=?').get(threadId, callId);
    if (!row) return undefined;
    if (row.arguments !== stableJson(args)) throw new MessageToolValidationError('call_conflict');
    return toToolDelivery(row);
  }
  toolMessageStatus(threadId: string, operationId: string): Delivery | undefined {
    const row = this.db.prepare('SELECT * FROM tool_outbox WHERE thread_id=? AND id=?').get(threadId, operationId);
    return row ? toToolDelivery(row) : undefined;
  }
  addToolMessage(input: { threadId: string; callId: string; conversationId: string; origin: Origin; arguments: unknown; text: string; mentions: Person[] }): Delivery {
    return this.transaction(() => {
      const existing = this.toolMessageForCall(input.threadId, input.callId, input.arguments);
      if (existing) return existing;
      required(input.threadId, 'Native thread'); required(input.callId, 'Tool call'); required(input.text, 'Message text');
      if ([...input.text].length > 3000 || this.getConversation(input.conversationId)?.threadId !== input.threadId) throw new Error('Invalid tool message target or text');
      const endpoint = this.getEndpoint(input.origin.endpointId);
      if (!endpoint || endpoint.platform !== input.origin.platform || endpoint.accountId !== input.origin.accountId
        || endpoint.chatId !== input.origin.chatId || endpoint.threadId !== input.origin.threadId) throw new Error('Invalid tool message origin');
      const id = messageToolOperationId(input.threadId, input.callId), now = new Date().toISOString();
      this.db.prepare(`INSERT INTO tool_outbox (id,thread_id,call_id,conversation_id,arguments,origin,body,mentions,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`).run(id, input.threadId, input.callId, input.conversationId, stableJson(input.arguments),
          JSON.stringify(input.origin), input.text, JSON.stringify(input.mentions), now, now);
      return this.getDelivery(id)!;
    });
  }
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

  resolvedApprovalDeliveries(): Array<{ delivery: Delivery; approval: Approval; version: string }> {
    return this.db.prepare(`SELECT d.*, a.status||':'||COALESCE(a.decision,'')||':'||a.updated_at||CASE WHEN marker.value IS NOT NULL THEN ':'||marker.value ELSE '' END AS ui_version
      FROM deliveries d JOIN approvals a ON a.id=d.approval_id
      LEFT JOIN meta m ON m.key='approval-ui-updated:'||d.id
      LEFT JOIN meta retry ON retry.key='approval-ui-attempted:'||d.id
      LEFT JOIN meta marker ON marker.key='approval-answer-marker-ui:'||a.id
      WHERE d.kind='approval' AND d.status='sent' AND d.remote_message_id IS NOT NULL
        AND json_extract(d.origin,'$.platform')='slack' AND json_array_length(a.questions)>0
        AND a.status!='pending' AND (m.value IS NULL OR m.value!=a.status||':'||COALESCE(a.decision,'')||':'||a.updated_at||CASE WHEN marker.value IS NOT NULL THEN ':'||marker.value ELSE '' END)
      ORDER BY COALESCE(CAST(retry.value AS INTEGER),0),d.rowid LIMIT 100`).all().map(row => ({ delivery: toDelivery(row),
        approval: this.getApproval(String(row.approval_id))!, version: String(row.ui_version) }));
  }

  cancelApprovalDeliveries(approvalId: string): void {
    this.db.prepare("UPDATE deliveries SET status='cancelled',updated_at=? WHERE approval_id=? AND kind='approval' AND status IN ('pending','failed')")
      .run(new Date().toISOString(), approvalId);
  }

  expirePendingApprovals(): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE deliveries SET status='cancelled',updated_at=? WHERE kind='approval' AND status IN ('pending','failed')
        AND approval_id IN (SELECT id FROM approvals WHERE status='pending' AND method<>?)`).run(now, ASYNC_USER_INPUT);
      this.db.prepare("UPDATE approvals SET status='expired',updated_at=? WHERE status='pending' AND method<>?").run(now, ASYNC_USER_INPUT);
    });
  }
  claimDelivery(now: string | number | Date = new Date()): Delivery | undefined {
    const timestamp = new Date(now).toISOString();
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT d.id,d.created_at FROM deliveries d WHERE d.status='pending'
        AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?)
        AND NOT EXISTS(SELECT 1 FROM deliveries earlier WHERE earlier.request_id=d.request_id AND earlier.rowid<d.rowid AND earlier.status NOT IN ('sent','cancelled'))
        ORDER BY d.rowid LIMIT 1`).get(timestamp);
      const tool = this.db.prepare("SELECT id,created_at FROM tool_outbox WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY rowid LIMIT 1").get(timestamp);
      if (!row && !tool) return undefined;
      const useTool = !!tool && (!row || String(tool.created_at) < String(row.created_at));
      const id = (useTool ? tool! : row!).id as string;
      this.db.prepare(`UPDATE ${useTool ? 'tool_outbox' : 'deliveries'} SET status='sending',attempts=attempts+1,updated_at=? WHERE id=?`).run(timestamp, id);
      return this.getDelivery(id)!;
    });
  }
  updateDelivery(id: string, patch: Partial<Pick<Delivery, 'status' | 'remoteMessageId' | 'error' | 'nextAttemptAt'>>, ownReceipt?: InboundMessage): Delivery {
    allowedPatch(patch, ['status', 'remoteMessageId', 'error', 'nextAttemptAt']);
    return this.transaction(() => {
      const current = this.getDelivery(id);
      if (!current) throw new Error('Delivery not found');
      const next = { ...current, ...patch };
      const nextAttemptAt = next.nextAttemptAt === undefined ? null : new Date(next.nextAttemptAt).toISOString();
      this.db.prepare(`UPDATE ${current.kind === 'message' ? 'tool_outbox' : 'deliveries'} SET status=?,remote_message_id=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?`)
        .run(next.status, next.remoteMessageId ?? null, next.error ?? null, nextAttemptAt, new Date().toISOString(), id);
      if (ownReceipt) {
        if (current.kind !== 'message' || next.status !== 'sent' || !ownReceipt.contextOnly || ownReceipt.sender.id !== current.origin.senderId
          || ownReceipt.endpoint.id !== current.origin.endpointId || ownReceipt.messageId !== next.remoteMessageId) throw new Error('Invalid own delivery receipt');
        this.recordEvent(ownReceipt);
      }
      return this.getDelivery(id)!;
    });
  }

  addApproval(input: ApprovalInput): Approval {
    return this.transaction(() => {
      if (!this.getRequest(input.requestId)) throw new Error('Request not found');
      if (input.method === ASYNC_USER_INPUT ? input.rpcId !== null : typeof input.rpcId !== 'string' && (typeof input.rpcId !== 'number' || !Number.isFinite(input.rpcId))) {
        throw new Error('Approval RPC ID must be null only for async questions, otherwise a string or finite number');
      }
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
      if (next.method === ASYNC_USER_INPUT ? next.rpcId !== null : typeof next.rpcId !== 'string' && (typeof next.rpcId !== 'number' || !Number.isFinite(next.rpcId))) {
        throw new Error('Approval RPC ID must be null only for async questions, otherwise a string or finite number');
      }
      this.db.prepare('UPDATE approvals SET status=?,decision=?,rpc_id=?,title=?,details=?,questions=?,updated_at=? WHERE id=?')
        .run(next.status, next.decision ?? null, JSON.stringify(next.rpcId), next.title, next.details, next.questions ? JSON.stringify(next.questions) : null, new Date().toISOString(), id);
      return this.getApproval(id)!;
    });
  }

  recoverInterrupted(): { requests: number; deliveries: number } {
    return this.transaction(() => {
      const now = new Date().toISOString();
      for (const row of this.db.prepare("SELECT key FROM meta WHERE key LIKE 'steering-input:%'").all()) {
        const input = this.attachLateSteeringRequest(this.getSteeringInput((row.key as string).slice('steering-input:'.length))!);
        if (input.state !== 'sending') continue;
        const error = 'Steering acknowledgement interrupted; reconcile without replay';
        this.setMeta(`steering-input:${input.id}`, JSON.stringify({ ...input, state: 'uncertain', error }));
        if (input.entryId) this.db.prepare("UPDATE slack_sync_entries SET state='uncertain',error=?,updated_at=? WHERE id=?").run(error, now, input.entryId);
        if (input.approvalId === input.id) this.db.prepare(`UPDATE approvals SET status='expired',decision='uncertain',updated_at=?
          WHERE id=? AND request_id=? AND turn_id=? AND method=? AND rpc_id='null' AND status IN ('pending','answered')`)
          .run(now, input.approvalId, input.parentRequestId, input.turnId, ASYNC_USER_INPUT);
      }
      this.db.prepare("UPDATE auto_link_intents SET status='uncertain',error=COALESCE(error,'Native creation acknowledgement was interrupted; reconcile before retrying'),updated_at=? WHERE status='creating'").run(now);
      this.db.prepare("UPDATE slack_sync_entries SET state='pending',error=COALESCE(error,'Passive append acknowledgement was interrupted; replay may duplicate context'),updated_at=? WHERE state='applying'").run(now);
      const execution = this.db.prepare("UPDATE requests SET status='uncertain',error=COALESCE(error,'Execution interrupted; reconcile with Codex before retrying'),updated_at=? WHERE status IN ('starting','running')").run(now);
      for (const row of this.db.prepare("SELECT id FROM requests WHERE status='uncertain' AND event_id='async-question-answer:'||id").all()) {
        const approval = this.getAsyncQuestionAnswerApproval(row.id as string);
        if (approval && (approval.status === 'pending' || approval.status === 'answered' && ['queued', 'sending'].includes(approval.decision ?? ''))) {
          this.db.prepare("UPDATE approvals SET status='expired',decision='uncertain',updated_at=? WHERE id=?").run(now, approval.id);
        }
      }
      const transcription = this.db.prepare("UPDATE requests SET status='queued',updated_at=? WHERE status='transcribing'").run(now);
      const deliveries = this.db.prepare("UPDATE deliveries SET status='uncertain',error=COALESCE(error,'Delivery interrupted; verify receipt before retrying'),updated_at=? WHERE status='sending'").run(now);
      const tool = this.db.prepare("UPDATE tool_outbox SET status='uncertain',error=COALESCE(error,'Delivery interrupted; verify receipt before retrying'),updated_at=? WHERE status='sending'").run(now);
      return { requests: Number(execution.changes) + Number(transcription.changes), deliveries: Number(deliveries.changes) + Number(tool.changes) };
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
