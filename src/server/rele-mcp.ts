import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { ConfigStore } from './config.js';
import { callLocalMessageTool, MessageToolAcknowledgementError } from './lifecycle.js';
import { messageToolOperationId } from '../shared/message-tool.js';

export interface ReleToolCall { threadId: string; callId: string; name: string; arguments: Record<string, unknown> }
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown, max = 200): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x20\x7f]/u.test(value);
const exactKeys = (value: ObjectValue, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

export const releMcpTools = [
  { name: 'list_destinations', description: 'List permitted Slack/Telegram sources linked to this Codex thread and their known participants. Unknown participants are not a full roster.', annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'send_message', description: 'Send one explicit message to a listed source, optionally mentioning zero, one or several listed participant IDs. Returns a durable operation receipt. For uncertain delivery use get_message_status; do not repeat the send.', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, inputSchema: { type: 'object', properties: { endpointId: { type: 'string', minLength: 1, maxLength: 200 }, text: { type: 'string', minLength: 1, maxLength: 3000 }, mentionIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 200 } } }, required: ['endpointId', 'text'], additionalProperties: false } },
  { name: 'get_message_status', description: 'Read this Codex thread’s durable receipt for an outgoing operation. Pending or uncertain is not confirmed delivery.', annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: 'object', properties: { operationId: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['operationId'], additionalProperties: false } },
];

/** Native metadata is the sole source of identity; model arguments cannot select another thread/call. */
export function parseReleToolCall(params: unknown): ReleToolCall {
  if (!object(params) || !object(params._meta) || !identifier(params._meta.threadId) || !identifier(params._meta.callId, 300)
    || !object(params.arguments)) throw new Error('Для инструментов Rele нужны threadId и callId от совместимого Codex.');
  const name = params.name, args = params.arguments;
  if (name === 'list_destinations') {
    if (Object.keys(args).length) throw new Error('list_destinations не принимает параметры.');
  } else if (name === 'send_message') {
    if (!exactKeys(args, ['endpointId', 'text', 'mentionIds']) || !identifier(args.endpointId)
      || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 3000 || /[\x00-\x08\x0b-\x1f\x7f]/u.test(args.text)
      || args.mentionIds !== undefined && (!Array.isArray(args.mentionIds)
        || args.mentionIds.some(value => !identifier(value)) || new Set(args.mentionIds).size !== args.mentionIds.length)) throw new Error('Некорректное сообщение Rele.');
  } else if (name === 'get_message_status') {
    if (!exactKeys(args, ['operationId']) || !identifier(args.operationId)) throw new Error('Нужен идентификатор операции Rele.');
  } else throw new Error('Неизвестный инструмент Rele.');
  return { threadId: params._meta.threadId, callId: params._meta.callId, name, arguments: args };
}

export async function invokeReleTool(params: unknown, call: (body: ReleToolCall) => Promise<unknown>): Promise<unknown> {
  const body = parseReleToolCall(params);
  try { return await call(body); }
  catch (error) {
    if (body.name !== 'send_message' || !(error instanceof MessageToolAcknowledgementError)) throw error;
    // The POST may have committed before its acknowledgement was lost. Keep a
    // deterministic receipt key so the model can reconcile with a read-only call.
    return { operationId: messageToolOperationId(body.threadId, body.callId), status: 'uncertain', endpointId: body.arguments.endpointId,
      error: 'Подтверждение доставки недоступно. Проверьте get_message_status; не повторяйте отправку вслепую.' };
  }
}

/** Newline-framed stdio MCP: stdout is exclusively protocol, never diagnostics or credentials. */
export async function runReleMcp(directory: string, input: Readable = process.stdin, output: Writable = process.stdout,
  call = async (body: ReleToolCall): Promise<unknown> => {
    const config = new ConfigStore(directory);
    await config.loadExisting();
    return callLocalMessageTool(config, body);
  }): Promise<void> {
  const lines = createInterface({ input, terminal: false });
  const write = (value: unknown) => output.write(JSON.stringify(value) + '\n');
  for await (const line of lines) {
    let message: ObjectValue;
    try {
      if (line.length > 32_768) throw new Error();
      const value: unknown = JSON.parse(line);
      if (!object(value) || !(typeof value.id === 'string' || typeof value.id === 'number' && Number.isFinite(value.id) || value.id === undefined) || typeof value.method !== 'string') throw new Error();
      message = value;
    } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Некорректный запрос MCP.' } }); continue; }
    if (message.id === undefined) continue;
    const reply = (result: unknown) => write({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') {
      const protocolVersion = object(message.params) && typeof message.params.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18';
      reply({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'rele', version: '1.0.0' } });
    } else if (message.method === 'ping') reply({});
    else if (message.method === 'tools/list') reply({ tools: releMcpTools });
    else if (message.method === 'tools/call') {
      try {
        const value = await invokeReleTool(message.params, call);
        reply({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: object(value) && value.isError === true });
      } catch {
        // Never reflect raw HTTP/native errors or credential-bearing exceptions to the model.
        reply({ content: [{ type: 'text', text: 'Rele не подтвердил операцию. Проверьте состояние доставки; не повторяйте отправку вслепую. Для инструментов нужен совместимый Codex с threadId и callId.' }], isError: true });
      }
    } else write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Неизвестный метод MCP.' } });
  }
}
