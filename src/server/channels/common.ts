import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Approval, AudioAttachment, CatalogChat, CatalogPage, ConnectionState, Delivery, Endpoint, InboundMessage, Origin, Person, Platform, SlackTranscriptMessage } from '../../shared/types.js';

export type SlackSessionStatus = 'processing' | 'active' | 'suspended';

export interface ApprovalAction {
  approvalId: string;
  decision: 'accept' | 'decline';
  platform: Platform;
  accountId: string;
  chatId: string;
  threadId?: string;
  senderId: string;
}

export interface ChannelCallbacks {
  message(message: InboundMessage): Promise<void>;
  endpoint(endpoint: Endpoint): void;
  action(action: ApprovalAction): Promise<void>;
  status(): void;
}

export interface Channel {
  state: ConnectionState;
  start(): Promise<void>;
  stop(): Promise<void>;
  deliver(delivery: Delivery, approval?: Approval): Promise<string>;
  download(audio: AudioAttachment, file: string): Promise<void>;
  listChats?(cursor?: string): Promise<CatalogPage<CatalogChat>>;
  listThreads?(chatId: string, cursor?: string): Promise<CatalogPage<Endpoint>>;
  listPeople?(chatId: string, cursor?: string): Promise<CatalogPage<Person>>;
  discoveryInfo?(): { botUrl?: string; command: string };
  setThreadStatus?(origin: Origin, status: SlackSessionStatus): Promise<void>;
  readThreadPage?(target: Pick<Origin, 'endpointId' | 'accountId' | 'chatId' | 'threadId'>, options?: { cursor?: string; oldest?: string; latest?: string }): Promise<{ messages: SlackTranscriptMessage[]; nextCursor?: string }>;
}

export class ChannelError extends Error {
  constructor(message: string, readonly retryable = false, readonly uncertain = false, readonly retryAfterMs = 30_000, readonly statusCode?: number) { super(message); }
}

export function endpointId(platform: Platform, accountId: string, chatId: string, threadId: string): string {
  return createHash('sha256').update(JSON.stringify([platform, accountId, chatId, threadId])).digest('hex').slice(0,32);
}

export function splitReply(text: string, limit = 3000): string[] {
  const chars = [...text];
  if (!chars.length) return ['Codex завершил задачу без текстового ответа.'];
  const parts: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + limit, chars.length);
    if (end < chars.length) {
      for (let i = end - 1; i > start + Math.floor(limit / 2); i--) if (chars[i] === '\n') { end = i + 1; break; }
    }
    parts.push(chars.slice(start, end).join(''));
    start = end;
  }
  return parts;
}

export async function downloadBounded(response: Response, file: string, maximum = 20 * 1024 * 1024): Promise<void> {
  if (!response.ok || !response.body) throw new ChannelError('Не удалось скачать аудиофайл.');
  const announced = Number(response.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > maximum) throw new ChannelError('Аудиофайл превышает 20 МБ.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new ChannelError('Аудиофайл превышает 20 МБ.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  await writeFile(file, Buffer.concat(chunks), { mode: 0o600, flag: 'wx' });
}

export function readableTitle(value: unknown, fallback: string, length = 80): string {
  return (typeof value === 'string' ? value.replace(/<@[A-Z0-9]+>/gu, 'участник').replace(/\s+/gu, ' ').trim() : '').slice(0,length) || fallback;
}
