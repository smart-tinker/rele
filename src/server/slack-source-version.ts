import { createHash } from 'node:crypto';
import type { InboundMessage, SlackTranscriptMessage } from '../shared/types.js';

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item);
}
function blocks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(blocks);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'block_id').map(([key, item]) => [key, blocks(item)]));
}
function attachments(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(item => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).map(([key, value]) => [key, key === 'blocks' ? blocks(value) : value])) : item);
}

/** Content revision only; callers must also bind platform/account/chat/thread/message identity. */
export function slackSourceRevision(message: SlackTranscriptMessage): string {
  const slack = message.platform !== 'telegram';
  return createHash('sha256').update(stableJson({ kind: message.kind === 'deleted' ? 'deleted' : 'message', senderId: message.sender.id,
    text: message.text, edited: (message.payload.edited as { ts?: unknown } | undefined)?.ts,
    files: message.payload.files, audio: message.payload.audio,
    attachments: slack ? attachments(message.payload.attachments) : message.payload.attachments,
    blocks: slack ? blocks(message.payload.blocks) : message.payload.blocks })).digest('hex');
}

/** Transport envelopes and current access decisions cannot revive an already consumed source version. */
export function inboundSourceRevision(message: InboundMessage): string {
  const audio = message.audio && { ...message.audio, ...(message.audio.fileId ? { url: undefined } : {}) };
  const transcript = message.slack ?? { ...message.endpoint, endpointId: message.endpoint.id, messageId: message.messageId, sender: message.sender,
    text: message.text, payload: { text: message.text }, kind: 'message' as const };
  return createHash('sha256').update(stableJson({ source: slackSourceRevision(transcript), text: message.text, audio, control: message.control,
    origin: [message.endpoint.platform, message.endpoint.accountId, message.endpoint.chatId, message.endpoint.threadId, message.messageId] })).digest('hex');
}
