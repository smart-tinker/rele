import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from '../src/server/channels/telegram.js';
import { ChannelError, endpointId, type ChannelCallbacks } from '../src/server/channels/common.js';
import type { Approval, Delivery, Endpoint } from '../src/shared/types.js';

const TOKEN = '999:never_print_this_secret';
const APPROVAL_ID = '53428f3d-4190-449d-8b2e-d1a0caafc07a';
const channels: TelegramChannel[] = [];
const directories: string[] = [];
type Call = { method: string; body: Record<string, unknown>; init?: RequestInit; url: string };
type Handler = (call: Call) => Response | Promise<Response>;

function response(result: unknown): Response { return Response.json({ ok: true, result }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return { id: 'delivery-1', requestId: 'request-1', origin: { platform: 'telegram', accountId: '999',
    endpointId: endpointId('telegram', '999', '-100123', '17'), chatId: '-100123', threadId: '17', senderId: '123', senderName: 'Alex', messageId: '20' },
    key: 'answer:0', ordinal: 0, kind: 'answer', body: '<b>Plain text</b> & diagnostics', status: 'sending', attempts: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides };
}
function approval(overrides: Partial<Approval> = {}): Approval {
  return { id: APPROVAL_ID, requestId: 'request-1', turnId: 'turn-1', itemId: 'item-1', rpcId: 5,
    method: 'item/commandExecution/requestApproval', title: 'Approve command', details: 'Run the command?', status: 'pending',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides };
}
function telegramMessage(overrides: Record<string, unknown> = {}) {
  return { message_id: 20, message_thread_id: 17, chat: { id: -100123, type: 'supergroup', title: 'Infrastructure' },
    from: { id: 123, is_bot: false, first_name: 'Alex' }, text: 'Check backups', ...overrides };
}
function harness(options: { callbacks?: Partial<ChannelCallbacks>; knownEndpoints?: Endpoint[] } = {}) {
  const calls: Call[] = [];
  const handlers = new Map<string, Handler>();
  const pending: Array<{ response: ReturnType<typeof deferred<Response>>; signal?: AbortSignal | null }> = [];
  const batches: unknown[][] = [];
  let offset = 0;
  const callbacks = { message: vi.fn(async () => {}), endpoint: vi.fn(() => {}), action: vi.fn(async () => {}), status: vi.fn(() => {}), ...options.callbacks } satisfies ChannelCallbacks;
  const fetcher: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.includes('/file/bot') ? 'file' : url.slice(url.lastIndexOf('/') + 1);
    const call = { method, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}, init, url };
    calls.push(call);
    const handler = handlers.get(method);
    if (handler) return handler(call);
    if (method === 'getMe') return response({ id: 999, is_bot: true, first_name: 'Rele', username: 'rele_test_bot' });
    if (method === 'getWebhookInfo') return response({ url: '' });
    if (method === 'getUpdates') {
      const batch = batches.shift();
      if (batch) return response(batch);
      const waiting = deferred<Response>();
      pending.push({ response: waiting, signal: init?.signal });
      init?.signal?.addEventListener('abort', () => waiting.reject(new DOMException('Aborted', 'AbortError')), { once: true });
      return waiting.promise;
    }
    if (method === 'sendMessage') return response({ message_id: 500, chat: { id: Number(call.body.chat_id) }, message_thread_id: call.body.message_thread_id });
    if (method === 'answerCallbackQuery') return response(true);
    throw new Error('Unexpected mocked method');
  }) as typeof fetch;
  const channel = new TelegramChannel(TOKEN, callbacks, { get: () => offset, set: (value) => { offset = value; } }, { fetch: fetcher, knownEndpoints: options.knownEndpoints });
  channels.push(channel);
  return { channel, calls, handlers, callbacks, get offset() { return offset; }, push(updates: unknown[]) {
    let waiting = pending.shift();
    while (waiting?.signal?.aborted) waiting = pending.shift();
    if (waiting) waiting.response.resolve(response(updates)); else batches.push(updates);
  } };
}

afterEach(async () => {
  await Promise.all(channels.splice(0).map((channel) => channel.stop()));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Telegram connection and incoming events', () => {
  it('refuses an existing webhook without changing or deleting it', async () => {
    const h = harness();
    h.handlers.set('getWebhookInfo', () => response({ url: 'https://existing.example/private-hook' }));
    await expect(h.channel.start()).rejects.toThrow(/webhook/);
    expect(h.channel.state.connected).toBe(false);
    expect(h.channel.state.error).not.toContain('existing.example');
    expect(h.calls.map((call) => call.method)).toEqual(['getMe', 'getWebhookInfo']);
  });

  it('sanitizes startup failures and can be started again after they are fixed', async () => {
    const h = harness();
    h.handlers.set('getMe', () => Response.json({ ok: false, error_code: 401, description: `Bad token ${TOKEN}` }, { status: 401 }));
    await expect(h.channel.start()).rejects.toThrow(/токен/);
    expect(h.channel.state.error).not.toContain(TOKEN);
    h.handlers.delete('getMe');
    await h.channel.start();
    expect(h.channel.state).toMatchObject({ connected: true, name: '@rele_test_bot', error: undefined });
    expect(h.calls.find((call) => call.method === 'getUpdates')?.body).toEqual({ offset: 0, timeout: 25, allowed_updates: ['message', 'callback_query'] });
  });

  it('advances the checkpoint only after awaited durable ingestion, in update order', async () => {
    const persisted = deferred<void>();
    const save = vi.fn<ChannelCallbacks['message']>().mockImplementationOnce(() => persisted.promise).mockResolvedValue(undefined);
    const h = harness({ callbacks: { message: save } });
    await h.channel.start();
    h.push([{ update_id: 22, message: telegramMessage({ message_id: 22, text: 'Second' }) }, { update_id: 21, message: telegramMessage({ message_id: 21, text: 'First' }) }]);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toMatchObject({ eventId: '21', text: 'First', endpoint: { accountId: '999' } });
    expect(h.offset).toBe(0);
    persisted.resolve();
    await vi.waitFor(() => expect(h.offset).toBe(23));
    expect(save).toHaveBeenCalledTimes(2);
    h.push([{ update_id: 21, message: telegramMessage() }]);
    await vi.waitFor(() => expect(h.calls.filter((call) => call.method === 'getUpdates').length).toBeGreaterThanOrEqual(3));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('retains the checkpoint on a storage failure and stops promptly while awaiting ingestion', async () => {
    const save = vi.fn<ChannelCallbacks['message']>().mockRejectedValueOnce(new Error(`Storage failure with ${TOKEN}`));
    const h = harness({ callbacks: { message: save } });
    await h.channel.start();
    h.push([{ update_id: 30, message: telegramMessage() }]);
    await vi.waitFor(() => expect(h.channel.state.error).toMatch(/сохранить/));
    expect(h.channel.state.error).not.toContain(TOKEN);
    expect(h.offset).toBe(0);
    await h.channel.stop();
    const persisted = deferred<void>();
    save.mockImplementation(() => persisted.promise);
    await h.channel.start();
    h.push([{ update_id: 30, message: telegramMessage() }]);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await h.channel.stop();
    expect(h.offset).toBe(0);
    persisted.resolve();
  });

  it('discovers topic names and people while ignoring edits, service requests and bot messages', async () => {
    const h = harness();
    await h.channel.start();
    h.push([
      { update_id: 1, message: telegramMessage({ message_id: 17, text: undefined, forum_topic_created: { name: 'Backups' } }) },
      { update_id: 2, message: telegramMessage() },
      { update_id: 3, edited_message: telegramMessage({ text: 'Edited command must not run' }) },
      { update_id: 4, message: telegramMessage({ from: { id: 999, is_bot: true, first_name: 'Rele' }, text: 'Own reply' }) },
      { update_id: 5, message: telegramMessage({ text: undefined, new_chat_members: [{ id: 456, first_name: 'Colleague' }] }) },
      { update_id: 6, message: telegramMessage({ text: undefined, forum_topic_edited: { name: 'Recovery' } }) },
      { update_id: 7, message: telegramMessage({ message_id: 25, text: 'Another task', from: { id: 456, first_name: 'Colleague' } }) },
    ]);
    await vi.waitFor(() => expect(h.offset).toBe(8));
    expect(h.callbacks.message).toHaveBeenCalledTimes(2);
    const discovered = vi.mocked(h.callbacks.endpoint).mock.calls.at(-1)![0];
    expect(discovered).toMatchObject({ title: 'Infrastructure / Recovery', accountId: '999', chatId: '-100123', threadId: '17' });
    expect(discovered.people).toEqual([{ id: '123', name: 'Alex' }, { id: '456', name: 'Colleague' }]);
    expect(discovered.title).not.toMatch(/123|17|999/u);
  });

  it('keeps known topic names after restart and exposes voice attachments and reply targets', async () => {
    const known: Endpoint = { id: endpointId('telegram', '999', '-100123', '17'), platform: 'telegram', accountId: '999', chatId: '-100123', threadId: '17',
      title: 'Infrastructure / Backups', subtitle: 'Тема · Telegram', people: [{ id: '456', name: 'Colleague' }], updatedAt: new Date().toISOString() };
    const h = harness({ knownEndpoints: [known] });
    await h.channel.start();
    h.push([{ update_id: 40, message: telegramMessage({ text: undefined, caption: 'Listen to this', voice: { file_id: 'voice-file', file_size: 1024, mime_type: 'audio/ogg' }, reply_to_message: { message_id: 500 } }) }]);
    await vi.waitFor(() => expect(h.offset).toBe(41));
    expect(vi.mocked(h.callbacks.message).mock.calls[0][0]).toMatchObject({ endpoint: { title: known.title, people: [{ id: '456', name: 'Colleague' }, { id: '123', name: 'Alex' }] },
      text: 'Listen to this', replyToMessageId: '500', audio: { platform: 'telegram', fileId: 'voice-file', size: 1024, mimeType: 'audio/ogg' } });
    h.push([{ update_id: 41, message: telegramMessage({ message_thread_id: undefined, chat: { id: 123, type: 'private', first_name: 'Alex', last_name: 'Example' } }) }]);
    await vi.waitFor(() => expect(h.offset).toBe(42));
    expect(vi.mocked(h.callbacks.message).mock.calls[1][0].endpoint).toMatchObject({ title: 'Alex', threadId: '' });
  });
});

describe('Telegram delivery and approvals', () => {
  it('sends plain text only to the recorded chat and topic and refuses another bot account', async () => {
    const h = harness();
    await h.channel.start();
    expect(await h.channel.deliver(delivery())).toBe('500');
    const sent = h.calls.find((call) => call.method === 'sendMessage')!;
    expect(sent.body).toMatchObject({ chat_id: '-100123', message_thread_id: 17, text: '<b>Plain text</b> & diagnostics', reply_parameters: { message_id: 20, allow_sending_without_reply: true } });
    expect(sent.body).not.toHaveProperty('parse_mode');
    expect(sent.init?.redirect).toBe('error');
    await expect(h.channel.deliver(delivery({ origin: { ...delivery().origin, accountId: 'another-bot' } }))).rejects.toThrow(/другому боту/);
    expect(h.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1);
    await h.channel.deliver(delivery({ origin: { ...delivery().origin, chatId: '123', threadId: '' } }));
    expect(h.calls.filter((call) => call.method === 'sendMessage')[1].body).not.toHaveProperty('message_thread_id');
  });

  it.each([
    { name: 'explicit rate limit', result: () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 3 }, description: TOKEN }, { status: 429 }), retryable: true, uncertain: false, wait: 3000 },
    { name: 'explicit rejection', result: () => Response.json({ ok: false, error_code: 400, description: TOKEN }, { status: 400 }), retryable: false, uncertain: false, wait: 30000 },
    { name: 'lost transport acknowledgement', result: () => { throw new Error(`fetch ${TOKEN} failed`); }, retryable: false, uncertain: true, wait: 30000 },
    { name: 'malformed success JSON', result: () => new Response('{', { status: 200 }), retryable: false, uncertain: true, wait: 30000 },
    { name: 'success without a message ID', result: () => response({ chat: { id: -100123 }, message_thread_id: 17 }), retryable: false, uncertain: true, wait: 30000 },
    { name: 'success for the wrong destination', result: () => response({ message_id: 500, chat: { id: -100456 }, message_thread_id: 17 }), retryable: false, uncertain: true, wait: 30000 },
  ])('classifies $name without exposing credentials', async ({ result, retryable, uncertain, wait }) => {
    const h = harness();
    await h.channel.start();
    h.handlers.set('sendMessage', result);
    const error = await h.channel.deliver(delivery()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ retryable, uncertain, retryAfterMs: wait });
    expect((error as Error).message).not.toContain(TOKEN);
    expect(h.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1);
  });

  it('uses bounded callback data, reports the verified source, and consumes rejected actions', async () => {
    const action = vi.fn<ChannelCallbacks['action']>().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Wrong sender'));
    const h = harness({ callbacks: { action } });
    await h.channel.start();
    await h.channel.deliver(delivery({ kind: 'approval', approvalId: APPROVAL_ID }), approval());
    const sent = h.calls.find((call) => call.method === 'sendMessage')!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    const callbackData = sent.inline_keyboard[0][0].callback_data;
    expect(callbackData).toBe(`rele:${APPROVAL_ID}:accept`);
    expect(Buffer.byteLength(callbackData)).toBeLessThanOrEqual(64);
    const callback = { id: 'callback-1', from: { id: 123, first_name: 'Alex' }, data: callbackData, message: telegramMessage({ message_id: 500 }) };
    h.push([{ update_id: 50, callback_query: callback }, { update_id: 51, callback_query: { ...callback, id: 'callback-2', from: { id: 456, first_name: 'Other' } } }]);
    await vi.waitFor(() => expect(h.offset).toBe(52));
    expect(action.mock.calls[0][0]).toEqual({ approvalId: APPROVAL_ID, decision: 'accept', platform: 'telegram', accountId: '999', chatId: '-100123', threadId: '17', senderId: '123' });
    expect(h.calls.filter((call) => call.method === 'answerCallbackQuery').map((call) => call.body.text)).toEqual(['Ответ принят.', 'Действие недоступно.']);
  });

  it('uses a selective ForceReply for questions and leaves retryable approval actions unacknowledged in the checkpoint', async () => {
    const h = harness({ callbacks: { action: vi.fn(async () => { throw new ChannelError('Codex temporarily unavailable', true); }) } });
    await h.channel.start();
    await h.channel.deliver(delivery({ kind: 'approval', approvalId: APPROVAL_ID }), approval({ questions: [{ id: 'q1', header: 'Target', question: 'Which branch?' }] }));
    expect(h.calls.find((call) => call.method === 'sendMessage')?.body.reply_markup).toMatchObject({ force_reply: true, selective: true });
    h.push([{ update_id: 60, callback_query: { id: 'callback-3', from: { id: 123, first_name: 'Alex' }, data: `rele:${APPROVAL_ID}:accept`, message: telegramMessage({ message_id: 500 }) } }]);
    await vi.waitFor(() => expect(h.channel.state.connected).toBe(false));
    expect(h.offset).toBe(0);
  });
});

describe('Telegram audio download', () => {
  it('uses a validated Telegram file path and writes a bounded file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rele-telegram-'));
    directories.push(dir);
    const h = harness();
    h.handlers.set('getFile', () => response({ file_path: 'voice/file_42.oga', file_size: 5 }));
    h.handlers.set('file', () => new Response('audio'));
    await h.channel.start();
    const file = join(dir, 'voice.oga');
    await h.channel.download({ platform: 'telegram', fileId: 'voice-file', name: 'voice.oga' }, file);
    expect(readFileSync(file, 'utf8')).toBe('audio');
    const download = h.calls.find((call) => call.method === 'file')!;
    expect(download.url).toBe(`https://api.telegram.org/file/bot${TOKEN}/voice/file_42.oga`);
    expect(download.init?.redirect).toBe('error');
    h.handlers.set('getFile', () => response({ file_path: '../another-bot/secret.oga' }));
    await expect(h.channel.download({ platform: 'telegram', fileId: 'bad-file', name: 'voice.oga' }, join(dir, 'bad.oga'))).rejects.toThrow(/путь/);
    expect(h.calls.filter((call) => call.method === 'file')).toHaveLength(1);
    await expect(h.channel.download({ platform: 'telegram', fileId: 'large-file', name: 'voice.oga', size: 20 * 1024 * 1024 + 1 }, join(dir, 'large.oga'))).rejects.toThrow(/20 МБ/);
  });
});
