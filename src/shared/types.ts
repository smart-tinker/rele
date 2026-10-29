export type Platform = 'telegram' | 'slack';
export interface Person { id: string; name: string; isBot?: boolean; username?: string }

export interface CatalogPage<T> { items: T[]; nextCursor?: string; warning?: string }
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

export type ReactionMode = 'off' | 'mention' | 'all';

export interface SourceAccess {
  endpointId: string;
  mode: ReactionMode;
  allowedSenderIds: string[];
  legacy: boolean;
}

export interface SourceRoute {
  endpointId: string;
  mode: 'none' | 'manual' | 'auto';
  cwd?: string;
}

export interface Binding {
  id: string;
  conversationId: string;
  platform: Platform;
  endpointId: string;
  allowedSenderIds: string[];
  allowAllSenders?: boolean;
  requireMention?: boolean;
}

export interface AutoLinkRule {
  id: string;
  enabled: boolean;
  platform: Platform;
  accountId: string;
  chatId: string;
  cwd: string;
  allowedSenderIds: string[];
  requireMention: boolean;
  allowAllSenders?: boolean;
}

export interface AutoLinkIntent {
  id: string;
  endpointId: string;
  rule: AutoLinkRule;
  targetFingerprint: string;
  status: 'pending' | 'creating' | 'created' | 'uncertain' | 'failed' | 'completed';
  threadId?: string;
  conversationId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
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
  senderIsBot?: boolean;
  participants?: Person[];
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
  platform?: Platform;
  receivedAt?: string;
  endpointId: string;
  accountId: string;
  chatId: string;
  threadId: string;
  messageId: string;
  sender: Person;
  participants?: Person[];
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
  participants?: Person[];
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
  suppressedFinal?: boolean;
  steeredInto?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'cancelled';
export interface Delivery {
  id: string;
  requestId?: string;
  operationId?: string;
  conversationId?: string;
  nativeThreadId?: string;
  callId?: string;
  mentions?: Person[];
  origin: Origin;
  key: string;
  ordinal: number;
  kind: 'answer' | 'error' | 'approval' | 'message';
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

export interface MessageToolCall { threadId: string; callId: string; name: string; arguments: unknown }
export interface MessageToolReceipt {
  operationId: string;
  endpointId: string;
  status: DeliveryStatus;
  remoteMessageId?: string;
  error?: string;
}
export interface MessageDestination { endpointId: string; platform: Platform; title: string; participants: Person[] }

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

export type CodexTransport = 'shared' | 'managed' | 'proxy' | 'websocket';

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

export interface DesktopIntegrationState {
  available: boolean;
  enabled: boolean;
  lastCheckFailed: boolean;
}

export interface CodexUpdateState {
  available: boolean;
  phase: 'current' | 'available' | 'unsupported' | 'preparing' | 'restartRequired' | 'failed';
  currentVersion?: string;
  installedVersion?: string;
  pendingVersion?: string;
  error?: string;
}

export interface PublicConfig {
  autoLinkRules?: AutoLinkRule[];
  codex: CodexConnectionTarget & { tokenConfigured: boolean };
  telegram: { enabled: boolean; tokenConfigured: boolean };
  slack: { enabled: boolean; botTokenConfigured: boolean; appTokenConfigured: boolean };
  voice: { enabled: boolean; python: string; model: string; language: string; device: 'cpu' | 'cuda' };
}

export interface DashboardState {
  sourceAccess?: SourceAccess[];
  sourceRoutes?: SourceRoute[];
  autoLinks?: AutoLinkIntent[];
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
    platform: Platform;
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
