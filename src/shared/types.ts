export type Platform = 'telegram' | 'slack';
export interface Person { id: string; name: string; isBot?: boolean }

export interface CatalogPage<T> { items: T[]; nextCursor?: string }
export interface CatalogChat {
  id: string;
  name: string;
  subtitle: string;
  kind: 'channel' | 'group' | 'direct';
}

export interface Endpoint {
  id: string;
  platform: Platform;
  accountId: string;
  chatId: string;
  threadId: string;
  title: string;
  subtitle: string;
  url?: string;
  people: Person[];
  updatedAt: string;
  chatTitle?: string;
  topicTitle?: string;
  isForum?: boolean;
  generalTopic?: boolean;
  available?: boolean;
}

export interface Binding {
  id: string;
  conversationId: string;
  platform: Platform;
  endpointId: string;
  allowedSenderIds: string[];
}

export interface Conversation {
  id: string;
  name: string;
  threadId: string;
  cwd: string;
  paused: boolean;
  bindings: Binding[];
  createdAt: string;
  updatedAt: string;
}

export interface Origin {
  platform: Platform;
  accountId: string;
  endpointId: string;
  chatId: string;
  threadId: string;
  senderId: string;
  senderName: string;
  messageId: string;
}

export interface AudioAttachment {
  platform: Platform;
  fileId?: string;
  url?: string;
  name: string;
  mimeType?: string;
  size?: number;
}

export interface SlackTranscriptMessage {
  endpointId: string;
  accountId: string;
  chatId: string;
  threadId: string;
  messageId: string;
  sender: Person;
  text: string;
  payload: Record<string, unknown>;
  kind: 'message' | 'edit' | 'deleted';
}

export interface InboundMessage {
  // Native controls are inbox receipts, never Slack transcript messages or new tasks.
  control?: 'stop';
  eventId: string;
  endpoint: Endpoint;
  sender: Person;
  messageId: string;
  text: string;
  audio?: AudioAttachment;
  replyToMessageId?: string;
  slack?: SlackTranscriptMessage;
  contextOnly?: boolean;
  directMention?: boolean;
}

export type RequestStatus = 'queued' | 'transcribing' | 'starting' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'uncertain';
export interface ReleRequest {
  id: string;
  conversationId: string;
  eventId: string;
  origin: Origin;
  text: string;
  audio?: AudioAttachment;
  status: RequestStatus;
  queuedSubmissionId?: string;
  turnId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'cancelled';
export interface Delivery {
  id: string;
  requestId: string;
  origin: Origin;
  key: string;
  ordinal: number;
  kind: 'answer' | 'error' | 'approval';
  body: string;
  approvalId?: string;
  status: DeliveryStatus;
  attempts: number;
  remoteMessageId?: string;
  error?: string;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalQuestion {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
  isSecret?: boolean;
}

export interface Approval {
  id: string;
  requestId: string;
  turnId: string;
  itemId: string;
  rpcId: string | number;
  method: string;
  title: string;
  details: string;
  questions?: ApprovalQuestion[];
  status: 'pending' | 'answered' | 'expired';
  decision?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexThread {
  id: string;
  name: string;
  cwd: string;
  preview: string;
  updatedAt: number;
  status?: string;
  archived?: boolean;
}

export interface ConnectionState {
  configured: boolean;
  connected: boolean;
  name?: string;
  error?: string;
  accountId?: string;
}

export type CodexTransport = 'managed' | 'proxy' | 'websocket';

export interface CodexConnectionTarget {
  executable: string;
  transport: CodexTransport;
  endpoint: string;
  codexHome?: string;
}

export interface CodexInstallation {
  executable: string;
  name: string;
  source: 'desktop-process' | 'desktop-install' | 'path' | 'standard';
  version?: string;
  running: boolean;
  processId?: number;
  connection?: CodexConnectionTarget;
  managedConnection?: CodexConnectionTarget;
}

export interface CodexDiscoveryIssue {
  code: string;
  message: string;
  executable?: string;
}

export interface CodexDiscoveryResult {
  installations: CodexInstallation[];
  recommended?: CodexConnectionTarget;
  recommendedManaged?: CodexConnectionTarget;
  issues: CodexDiscoveryIssue[];
}

export interface CodexConnectionState extends ConnectionState {
  queueSupported: boolean;
  desktopVerified: boolean;
  executable?: string;
  transport?: CodexTransport;
  endpoint?: string;
  codexHome?: string;
  errorCode?: string;
}

export interface PublicConfig {
  codex: CodexConnectionTarget & { tokenConfigured: boolean };
  telegram: { enabled: boolean; tokenConfigured: boolean };
  slack: { enabled: boolean; botTokenConfigured: boolean; appTokenConfigured: boolean };
  voice: { enabled: boolean; python: string; model: string; language: string; device: 'cpu' | 'cuda' };
}

export interface DashboardState {
  version: string;
  codex: CodexConnectionState;
  connections: Record<Platform, ConnectionState>;
  conversations: Conversation[];
  endpoints: Endpoint[];
  requests: ReleRequest[];
  deliveries: Delivery[];
  approvals: Approval[];
  config: PublicConfig;
}

export type SlackSyncEntryState = 'pending' | 'applying' | 'applied' | 'uncertain';
export interface SlackSyncJournal {
  streams: Array<{
    id: string;
    endpointId: string;
    title: string;
    active: boolean;
    paused: boolean;
    state: 'backfill' | 'ready' | 'blocked';
    coveredThrough?: string;
    error?: string;
    counts: Record<SlackSyncEntryState, number>;
  }>;
  streamId?: string;
  entries: Array<{
    id: string;
    message: SlackTranscriptMessage;
    state: SlackSyncEntryState;
    error?: string;
    createdAt: string;
  }>;
  nextOffset?: number;
}
