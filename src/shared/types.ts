export type Platform = 'telegram' | 'slack';
export interface Person { id: string; name: string }

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

export interface InboundMessage {
  eventId: string;
  endpoint: Endpoint;
  sender: Person;
  messageId: string;
  text: string;
  audio?: AudioAttachment;
  replyToMessageId?: string;
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
}

export interface ConnectionState {
  configured: boolean;
  connected: boolean;
  name?: string;
  error?: string;
}

export interface PublicConfig {
  codex: { transport: 'proxy' | 'websocket'; executable: string; endpoint: string; tokenConfigured: boolean };
  telegram: { enabled: boolean; tokenConfigured: boolean };
  slack: { enabled: boolean; botTokenConfigured: boolean; appTokenConfigured: boolean };
  voice: { enabled: boolean; python: string; model: string; language: string; device: 'cpu' | 'cuda' };
}

export interface DashboardState {
  version: string;
  codex: ConnectionState & { queueSupported: boolean; desktopVerified: boolean };
  connections: Record<Platform, ConnectionState>;
  conversations: Conversation[];
  endpoints: Endpoint[];
  requests: ReleRequest[];
  deliveries: Delivery[];
  approvals: Approval[];
  config: PublicConfig;
}
