import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from '../src/server/channels/telegram.js';
import { ChannelError, endpointId, type ChannelCallbacks } from '../src/server/channels/common.js';
import { Store } from '../src/server/store.js';
import type { Approval, Delivery, Endpoint } from '../src/shared/types.js';

const TOKEN = '999:never_print_this_secret';
const APPROVAL_ID = '53428f3d-4190-449d-8b2e-d1a0caafc07a';
const channels: TelegramChannel[] = [];
const directories: string[] = [];
const stores: Store[] = [];
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
  return { message_id: 20, message_thread_id: 17, is_topic_message: true, chat: { id: -100123, type: 'supergroup', title: 'Infrastructure' },
    from: { id: 123, is_bot: false, first_name: 'Alex' }, text: 'Check backups', ...overrides };
}
function privateMessage(overrides: Record<string, unknown> = {}) {
  return telegramMessage({ message_thread_id: undefined, is_topic_message: undefined, chat: { id: 123, type: 'private', first_name: 'Alex' }, ...overrides });
}
function generalMessage(overrides: Record<string, unknown> = {}) {
  return telegramMessage({ message_thread_id: undefined, is_topic_message: undefined,
    chat: { id: -100123, type: 'supergroup', title: 'Infrastructure', is_forum: true }, ...overrides });
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
    if (method === 'sendMessage') return response({ message_id: 500,
      chat: { id: Number(call.body.chat_id), type: Number(call.body.chat_id) < 0 ? 'supergroup' : 'private' },
      message_thread_id: call.body.message_thread_id, is_topic_message: call.body.message_thread_id ? true : undefined });
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
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Telegram connection and incoming events', () => {
  it('recovers an offline startup with capped backoff without sending any messages', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = harness();
    h.handlers.set('getMe', () => { throw new Error(`Offline ${TOKEN}`); });
    await expect(h.channel.start()).rejects.toThrow(/недоступен/);
    expect(h.channel.state.error).not.toContain(TOKEN);
    let attempts = 1;
    for (const wait of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(h.calls).toHaveLength(attempts);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.calls).toHaveLength(++attempts);
    }
    h.handlers.delete('getMe');
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.channel.state).toMatchObject({ connected: true, error: undefined });
    expect(h.calls.filter(call => call.method === 'getUpdates')).toHaveLength(1);
    expect(h.calls.some(call => call.method === 'sendMessage')).toBe(false);
    await h.channel.start();
    expect(h.calls.filter(call => call.method === 'getUpdates')).toHaveLength(1);
  });

  it('cancels a startup retry on stop and honors an explicit rate-limit delay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = harness();
    h.handlers.set('getMe', () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 4 } }, { status: 429 }));
    await expect(h.channel.start()).rejects.toThrow(/частоту/);
    await vi.advanceTimersByTimeAsync(3999);
    expect(h.calls).toHaveLength(1);
    await h.channel.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.calls).toHaveLength(1);
    expect(h.channel.state.connected).toBe(false);
  });

  it('verifies the bot identity before reading an account-scoped checkpoint', async () => {
    const h = harness();
    h.handlers.set('getMe', () => response({ id: 998, is_bot: true, first_name: 'Another bot' }));
    await expect(h.channel.start()).rejects.toThrow(/другую учётную запись/);
    expect(h.calls.map(call => call.method)).toEqual(['getMe']);
    expect(h.offset).toBe(0);
  });

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
    expect(h.channel.state).toMatchObject({ connected: true, name: '@rele_test_bot', accountId: '999', error: undefined });
    expect(h.calls.find((call) => call.method === 'getUpdates')?.body).toEqual({ offset: 0, timeout: 25, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
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
    expect(discovered).toMatchObject({ title: 'Infrastructure / Recovery', chatTitle: 'Infrastructure', topicTitle: 'Recovery',
      accountId: '999', chatId: '-100123', threadId: '17', available: true, isForum: true });
    expect(discovered.people).toEqual([{ id: '123', name: 'Alex' }, { id: '456', name: 'Colleague' }]);
    expect(discovered.title).not.toMatch(/123|17|999/u);
    expect(vi.mocked(h.callbacks.endpoint).mock.calls.find(([endpoint]) => !endpoint.threadId)?.[0]).toMatchObject({
      title: 'Infrastructure', chatTitle: 'Infrastructure', threadId: '', available: true, isForum: true,
    });
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
    h.push([{ update_id: 41, message: privateMessage({ chat: { id: 123, type: 'private', first_name: 'Alex', last_name: 'Example' } }) }]);
    await vi.waitFor(() => expect(h.offset).toBe(42));
    expect(vi.mocked(h.callbacks.message).mock.calls[1][0].endpoint).toMatchObject({ title: 'Alex', threadId: '' });
  });
});

describe('Telegram chat discovery', () => {
  it('exposes a verified bot link and privacy-mode command without sending or fetching anything from the getter', async () => {
    const h = harness();
    expect(h.channel.discoveryInfo()).toEqual({ botUrl: undefined, command: '/rele_register' });
    expect(h.calls).toHaveLength(0);
    await h.channel.start();
    const count = h.calls.length;
    expect(h.channel.discoveryInfo()).toEqual({ botUrl: 'https://t.me/rele_test_bot?start=rele_chats', command: '/rele_register@rele_test_bot' });
    expect(h.channel.state.accountId).toBe('999');
    expect(h.channel.discoveryInfo()).toEqual(h.channel.discoveryInfo());
    expect(h.calls).toHaveLength(count);
    expect(h.calls.some(call => call.method === 'sendMessage')).toBe(false);
  });

  it('tracks its own group membership and availability of every known topic, without affecting another bot', async () => {
    const known: Endpoint = { id: endpointId('telegram', '999', '-100123', '17'), platform: 'telegram', accountId: '999', chatId: '-100123', threadId: '17',
      title: 'Infrastructure / Backups', chatTitle: 'Infrastructure', topicTitle: 'Backups', subtitle: 'Тема · Telegram', isForum: true,
      available: true, people: [{ id: '123', name: 'Alex' }], updatedAt: new Date().toISOString() };
    const other = { ...known, id: endpointId('telegram', '998', '-100123', '17'), accountId: '998' };
    const endpoints = new Map([known, other].map(endpoint => [endpoint.id, endpoint]));
    const h = harness({ knownEndpoints: [known, other], callbacks: { endpoint: vi.fn(endpoint => { endpoints.set(endpoint.id, endpoint); }) } });
    const changed = (status: string, overrides: Record<string, unknown> = {}) => ({
      chat: { id: -100123, type: 'supergroup', title: 'Infrastructure', is_forum: true }, from: { id: 123, first_name: 'Alex' },
      new_chat_member: { status, user: { id: 999, is_bot: true }, ...overrides },
    });
    await h.channel.start();
    h.push([{ update_id: 1, my_chat_member: changed('administrator') }]);
    await vi.waitFor(() => expect(h.offset).toBe(2));
    const parentId = endpointId('telegram', '999', '-100123', '');
    expect(endpoints.get(parentId)).toMatchObject({ title: 'Infrastructure', threadId: '', available: true, isForum: true });
    expect(endpoints.get(parentId)?.generalTopic).not.toBe(true);
    h.push([
      { update_id: 2, my_chat_member: changed('left') },
      { update_id: 3, message: telegramMessage({ text: undefined, left_chat_member: { id: 999, is_bot: true } }) },
    ]);
    await vi.waitFor(() => expect(h.offset).toBe(4));
    expect(endpoints.get(parentId)?.available).toBe(false);
    expect(endpoints.get(known.id)).toMatchObject({ available: false, title: known.title, topicTitle: 'Backups' });
    expect(endpoints.get(other.id)).toBe(other);
    h.push([{ update_id: 4, my_chat_member: changed('member', { user: { id: 998, is_bot: true } }) }]);
    await vi.waitFor(() => expect(h.offset).toBe(5));
    expect(endpoints.get(known.id)?.available).toBe(false);
    h.push([{ update_id: 5, my_chat_member: changed('restricted', { is_member: true }) }]);
    await vi.waitFor(() => expect(h.offset).toBe(6));
    expect(endpoints.get(parentId)?.available).toBe(true);
    expect(endpoints.get(known.id)?.available).toBe(true);
    expect(h.callbacks.message).not.toHaveBeenCalled();
    expect(h.calls.some(call => call.method === 'sendMessage')).toBe(false);
  });

  it('marks blocked private chats and their topics unavailable and retains private-topic support after unblocking', async () => {
    const h = harness();
    await h.channel.start();
    h.push([{ update_id: 1, message: privateMessage({ message_thread_id: 17, text: undefined, forum_topic_created: { name: 'Planning' } }) }]);
    await vi.waitFor(() => expect(h.offset).toBe(2));
    const changed = (status: string) => ({ chat: { id: 123, type: 'private', first_name: 'Alex' }, from: { id: 123, first_name: 'Alex' },
      new_chat_member: { status, user: { id: 999, is_bot: true } } });
    h.push([{ update_id: 2, my_chat_member: changed('kicked') }]);
    await vi.waitFor(() => expect(h.offset).toBe(3));
    expect(vi.mocked(h.callbacks.endpoint).mock.calls.slice(-2).map(([endpoint]) => endpoint.available)).toEqual([false, false]);
    h.push([{ update_id: 3, my_chat_member: changed('member') }]);
    await vi.waitFor(() => expect(h.offset).toBe(4));
    const topic = vi.mocked(h.callbacks.endpoint).mock.calls.at(-1)![0];
    expect(topic).toMatchObject({ title: 'Alex / Planning', chatTitle: 'Alex', topicTitle: 'Planning', isForum: false, available: true, threadId: '17' });
    expect(topic.url).toBe('https://t.me/rele_test_bot');
    expect(h.callbacks.message).not.toHaveBeenCalled();
    expect(h.calls.some(call => call.method === 'sendMessage')).toBe(false);
  });

  it('offers the native group picker only in response to its own private-chat commands', async () => {
    const h = harness();
    await h.channel.start();
    h.push([
      { update_id: 1, message: privateMessage({ text: '/start rele_chats' }) },
      { update_id: 2, message: privateMessage({ text: '/rele_chats@ReLe_TeSt_BoT' }) },
      { update_id: 3, message: privateMessage({ text: '/rele_chats@some_other_bot' }) },
      { update_id: 4, message: telegramMessage({ text: '/rele_chats@rele_test_bot' }) },
    ]);
    await vi.waitFor(() => expect(h.offset).toBe(5));
    const sent = h.calls.filter(call => call.method === 'sendMessage');
    expect(sent).toHaveLength(2);
    const markup = sent[0].body.reply_markup as { keyboard: Array<Array<{ request_chat: Record<string, unknown> }>> };
    const selection = markup.keyboard[0][0].request_chat;
    expect(selection).toEqual({ request_id: expect.any(Number), chat_is_channel: false, bot_is_member: true, request_title: true });
    expect(selection.request_id).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(selection.request_id).toBeLessThan(2 ** 31);
    expect(sent[0].body).toMatchObject({ chat_id: '123', reply_parameters: { message_id: 20 } });
    expect(sent[0].body).not.toHaveProperty('parse_mode');
    expect(sent[0].body).not.toHaveProperty('message_thread_id');
    expect(h.calls.some(call => ['getChat', 'getChatMember'].includes(call.method))).toBe(false);
    expect(h.callbacks.message).not.toHaveBeenCalled();
  });

  it('verifies picker selections against getChat and its own membership, including a button sent before restart', async () => {
    const first = harness();
    await first.channel.start();
    first.push([{ update_id: 1, message: privateMessage({ text: '/start rele_chats' }) }]);
    await vi.waitFor(() => expect(first.offset).toBe(2));
    const markup = first.calls.find(call => call.method === 'sendMessage')!.body.reply_markup as { keyboard: Array<Array<{ request_chat: { request_id: number } }>> };
    const requestId = markup.keyboard[0][0].request_chat.request_id;
    await first.channel.stop();
    const h = harness();
    const checked = deferred<Response>();
    h.handlers.set('getChat', () => response({ id: -100777, type: 'supergroup', title: 'Verified workspace', is_forum: true }));
    h.handlers.set('getChatMember', () => checked.promise);
    await h.channel.start();
    h.push([{ update_id: 2, message: privateMessage({ text: undefined, chat_shared: { request_id: requestId, chat_id: -100777, title: 'Untrusted picker title' } }) }]);
    await vi.waitFor(() => expect(h.calls.some(call => call.method === 'getChatMember')).toBe(true));
    expect(h.offset).toBe(0);
    expect(vi.mocked(h.callbacks.endpoint).mock.calls.some(([endpoint]) => endpoint.chatId === '-100777')).toBe(false);
    expect(h.calls.find(call => call.method === 'getChatMember')?.body).toEqual({ chat_id: '-100777', user_id: 999 });
    checked.resolve(response({ status: 'member', user: { id: 999, is_bot: true } }));
    await vi.waitFor(() => expect(h.offset).toBe(3));
    expect(vi.mocked(h.callbacks.endpoint).mock.calls.at(-1)![0]).toMatchObject({ title: 'Verified workspace', chatTitle: 'Verified workspace',
      chatId: '-100777', threadId: '', accountId: '999', available: true, isForum: true, people: [{ id: '123', name: 'Alex' }] });
    expect(vi.mocked(h.callbacks.endpoint).mock.calls.at(-1)![0].generalTopic).not.toBe(true);
    expect(h.calls.filter(call => call.method !== 'getUpdates').map(call => call.method)).toEqual(['getMe', 'getWebhookInfo', 'getChat', 'getChatMember']);
    expect(h.callbacks.message).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'another keyboard request', requestId: 1, getChat: false },
    { name: 'a group message', group: true, getChat: false },
    { name: 'a bot sender', bot: true, getChat: false },
    { name: 'a mismatching private sender', wrongSender: true, getChat: false },
    { name: 'a mismatching returned chat', wrongChat: true, getChat: true },
    { name: 'another bot membership', wrongBot: true, getChat: true },
    { name: 'a chat the bot has left', left: true, getChat: true },
    { name: 'an explicit access rejection', forbidden: true, getChat: true },
  ])('does not advertise an unverified picker selection: $name', async (scenario) => {
    const h = harness();
    h.handlers.set('getChat', () => 'forbidden' in scenario ? Response.json({ ok: false, error_code: 403, description: TOKEN }, { status: 403 }) :
      response({ id: 'wrongChat' in scenario ? -100778 : -100777, type: 'supergroup', title: 'Workspace', is_forum: true }));
    h.handlers.set('getChatMember', () => response({ status: 'left' in scenario ? 'left' : 'member', user: { id: 'wrongBot' in scenario ? 998 : 999, is_bot: true } }));
    await h.channel.start();
    const message = privateMessage({ text: 'A service message must never become a task',
      chat_shared: { request_id: 'requestId' in scenario ? scenario.requestId : 0x52454c45, chat_id: -100777, title: 'Unverified name' },
      ...('group' in scenario ? { chat: { id: -100123, type: 'supergroup', title: 'Source group' } } : {}),
      ...('wrongSender' in scenario ? { from: { id: 456, is_bot: false, first_name: 'Another user' } } : {}),
      ...('bot' in scenario ? { from: { id: 555, is_bot: true, first_name: 'Other bot' } } : {}) });
    h.push([{ update_id: 1, message }]);
    await vi.waitFor(() => expect(h.offset).toBe(2));
    const target = vi.mocked(h.callbacks.endpoint).mock.calls.map(([endpoint]) => endpoint).find(endpoint => endpoint.chatId === '-100777');
    if ('left' in scenario) expect(target?.available).toBe(false); else expect(target).toBeUndefined();
    expect(h.calls.some(call => call.method === 'getChat')).toBe(scenario.getChat);
    expect(h.calls.some(call => call.method === 'sendMessage')).toBe(false);
    expect(h.callbacks.message).not.toHaveBeenCalled();
    expect(h.channel.state.error ?? '').not.toContain(TOKEN);
  });

  it.each(['/rele_register', '/rele_register@RELE_TEST_BOT'])('registers names and people with %s without executing Codex in an existing binding and retains metadata after restart', async (command) => {
    const directory = mkdtempSync(join(tmpdir(), 'rele-telegram-catalog-'));
    directories.push(directory);
    const file = join(directory, 'rele.sqlite');
    const store = new Store(file);
    stores.push(store);
    const known: Endpoint = { id: endpointId('telegram', '999', '-100123', '17'), platform: 'telegram', accountId: '999', chatId: '-100123', threadId: '17',
      title: 'Infrastructure / Old topic', subtitle: 'Тема · Telegram', people: [{ id: '123', name: 'Alex' }], updatedAt: new Date().toISOString() };
    store.upsertEndpoint(known);
    store.setMeta(`endpoint-alias:${known.id}`, 'Моя локальная подпись');
    store.createConversation({ name: 'Existing binding', threadId: 'codex-thread', cwd: '/project',
      bindings: [{ platform: 'telegram', endpointId: known.id, allowedSenderIds: ['123'] }] });
    const message = vi.fn<ChannelCallbacks['message']>(async inbound => { store.ingest(inbound); });
    const h = harness({ knownEndpoints: store.listEndpoints(), callbacks: { endpoint: endpoint => store.upsertEndpoint(endpoint), message } });
    await h.channel.start();
    h.push([
      { update_id: 1, message: telegramMessage({ text: `${command} Release planning` }) },
      { update_id: 2, message: telegramMessage({ text: '/rele_register@some_other_bot Must not rename' }) },
      { update_id: 3, message: privateMessage({ text: '/rele_register' }) },
      { update_id: 4, message: telegramMessage({ message_thread_id: undefined, is_topic_message: undefined, chat: { id: -100456, type: 'group', title: 'Operations' }, text: '/rele_register' }) },
    ]);
    await vi.waitFor(() => expect(h.offset).toBe(5));
    expect(store.listRequests()).toEqual([]);
    expect(message).not.toHaveBeenCalled();
    expect(store.getEndpoint(known.id)).toMatchObject({ title: 'Infrastructure / Release planning', chatTitle: 'Infrastructure', topicTitle: 'Release planning', isForum: true, available: true });
    expect(store.getEndpoint(endpointId('telegram', '999', '-100123', ''))).toMatchObject({ title: 'Infrastructure', isForum: true });
    expect(store.getEndpoint(endpointId('telegram', '999', '-100456', ''))).toMatchObject({ title: 'Operations', isForum: false });
    expect(h.calls.filter(call => call.method === 'sendMessage')).toHaveLength(3);
    expect(h.calls.find(call => call.method === 'sendMessage')?.body).toMatchObject({ chat_id: '-100123', message_thread_id: 17 });
    h.push([{ update_id: 5, message: telegramMessage({ text: 'Now run the actual task', reply_to_message: { message_id: 17, forum_topic_created: { name: 'Old topic' } } }) }]);
    await vi.waitFor(() => expect(h.offset).toBe(6));
    expect(store.listRequests()).toHaveLength(1);
    await h.channel.stop();
    stores.splice(stores.indexOf(store), 1);
    store.close();
    const reopened = new Store(file);
    stores.push(reopened);
    const restarted = harness({ knownEndpoints: reopened.listEndpoints(), callbacks: { endpoint: endpoint => reopened.upsertEndpoint(endpoint) } });
    await restarted.channel.start();
    restarted.push([{ update_id: 6, message: telegramMessage({ chat: { id: -100123, type: 'supergroup', title: 'Renamed workspace' }, text: undefined,
      reply_to_message: { message_id: 17, forum_topic_created: { name: 'Old topic' } } }) }]);
    await vi.waitFor(() => expect(restarted.offset).toBe(7));
    expect(reopened.getEndpoint(known.id)).toMatchObject({ title: 'Renamed workspace / Release planning', chatTitle: 'Renamed workspace', topicTitle: 'Release planning', isForum: true, available: true,
      people: [{ id: '123', name: 'Alex' }] });
    expect(restarted.calls.some(call => call.method === 'sendMessage')).toBe(false);
    expect(reopened.listRequests()).toHaveLength(1);
    expect(reopened.getMeta(`endpoint-alias:${known.id}`)).toBe('Моя локальная подпись');
  });

  it('consumes an uncertain service-reply outcome without replaying the command or creating a task', async () => {
    const h = harness();
    h.handlers.set('sendMessage', () => { throw new Error(`Lost acknowledgement ${TOKEN}`); });
    await h.channel.start();
    h.push([{ update_id: 1, message: telegramMessage({ text: '/rele_register' }) }]);
    await vi.waitFor(() => expect(h.offset).toBe(2));
    expect(h.channel.state.connected).toBe(true);
    expect(h.channel.state.error).not.toContain(TOKEN);
    h.push([{ update_id: 1, message: telegramMessage({ text: '/rele_register' }) }]);
    await vi.waitFor(() => expect(h.calls.filter(call => call.method === 'getUpdates')).toHaveLength(3));
    expect(h.calls.filter(call => call.method === 'sendMessage')).toHaveLength(1);
    expect(h.callbacks.message).not.toHaveBeenCalled();
  });
});

describe('Telegram General routing', () => {
  it('keeps a forum parent unselectable until a real General message and learns its original or registered name', async () => {
    const h = harness();
    await h.channel.start();
    h.push([{ update_id: 1, message: generalMessage({ text: undefined, forum_topic_edited: { name: 'Discussion' } }) }]);
    await vi.waitFor(() => expect(h.offset).toBe(2));
    const parent = vi.mocked(h.callbacks.endpoint).mock.calls.at(-1)![0];
    expect(parent).toMatchObject({ threadId: '', title: 'Infrastructure', topicTitle: 'Discussion', isForum: true });
    expect(parent.generalTopic).not.toBe(true);
    h.push([{ update_id: 2, message: generalMessage({ text: '/rele_register@rele_test_bot' }) }]);
    await vi.waitFor(() => expect(h.offset).toBe(3));
    expect(vi.mocked(h.callbacks.endpoint).mock.calls.at(-1)![0]).toMatchObject({ id: parent.id, threadId: '', generalTopic: true,
      title: 'Infrastructure / Discussion', chatTitle: 'Infrastructure', topicTitle: 'Discussion', isForum: true });
    h.push([{ update_id: 3, message: generalMessage({ message_thread_id: 20, text: '/rele_register@rele_test_bot Team room' }) }]);
    await vi.waitFor(() => expect(h.offset).toBe(4));
    expect(vi.mocked(h.callbacks.endpoint).mock.calls.at(-1)![0]).toMatchObject({ id: parent.id, threadId: '', generalTopic: true,
      title: 'Infrastructure / Team room', topicTitle: 'Team room' });
    expect(h.callbacks.message).not.toHaveBeenCalled();
    for (const sent of h.calls.filter(call => call.method === 'sendMessage')) {
      expect(sent.body).not.toHaveProperty('message_thread_id');
      expect(sent.body).toMatchObject({ reply_parameters: { message_id: 20, allow_sending_without_reply: true } });
    }
  });

  it('keeps the existing empty endpoint identity and never silently rebinds a legacy generic reply thread', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rele-telegram-general-'));
    directories.push(directory);
    const file = join(directory, 'rele.sqlite');
    const store = new Store(file);
    stores.push(store);
    const parent: Endpoint = { id: endpointId('telegram', '999', '-100123', ''), platform: 'telegram', accountId: '999', chatId: '-100123', threadId: '',
      title: 'Infrastructure', chatTitle: 'Infrastructure', subtitle: 'Группа · Telegram', people: [{ id: '123', name: 'Alex' }],
      isForum: true, available: true, updatedAt: new Date().toISOString() };
    const oldReply: Endpoint = { ...parent, id: endpointId('telegram', '999', '-100123', '42'), threadId: '42',
      title: 'Infrastructure / Old reply', topicTitle: 'Old reply', subtitle: 'Тема · Telegram' };
    store.upsertEndpoint(parent);
    store.upsertEndpoint(oldReply);
    const previous = store.createConversation({ name: 'Legacy mistaken reply binding', threadId: 'old-codex', cwd: '/project',
      bindings: [{ platform: 'telegram', endpointId: oldReply.id, allowedSenderIds: ['123'] }] });
    const message = vi.fn<ChannelCallbacks['message']>(async inbound => { store.ingest(inbound); });
    const h = harness({ knownEndpoints: store.listEndpoints(), callbacks: { endpoint: endpoint => store.upsertEndpoint(endpoint), message } });
    await h.channel.start();
    h.push([{ update_id: 1, message: generalMessage({ message_id: 43, message_thread_id: 42, text: 'A generic reply in General' }) }]);
    await vi.waitFor(() => expect(h.offset).toBe(2));
    expect(store.getEndpoint(parent.id)).toMatchObject({ id: parent.id, threadId: '', generalTopic: true, isForum: true,
      title: 'Infrastructure / Общая тема', chatTitle: 'Infrastructure', topicTitle: 'Общая тема' });
    expect(store.getConversation(previous.id)?.bindings[0].endpointId).toBe(oldReply.id);
    expect(store.getEndpoint(oldReply.id)?.threadId).toBe('42');
    expect(store.listRequests()).toEqual([]);
    const selected = store.createConversation({ name: 'Explicit General binding', threadId: 'general-codex', cwd: '/project',
      bindings: [{ platform: 'telegram', endpointId: parent.id, allowedSenderIds: ['123'] }] });
    h.push([
      { update_id: 2, message: generalMessage({ message_id: 44, text: 'Root General message' }) },
      { update_id: 3, message: generalMessage({ message_id: 45, message_thread_id: 42, text: 'Another reply in General' }) },
    ]);
    await vi.waitFor(() => expect(h.offset).toBe(4));
    expect(store.listRequests()).toHaveLength(2);
    for (const request of store.listRequests()) expect(request).toMatchObject({ conversationId: selected.id,
      origin: { endpointId: parent.id, threadId: '', chatId: '-100123' } });
    h.handlers.set('sendMessage', call => response({ message_id: 500, chat: { id: Number(call.body.chat_id), type: 'supergroup', is_forum: true },
      message_thread_id: 42 }));
    const request = store.listRequests()[0];
    expect(await h.channel.deliver(delivery({ origin: request.origin }))).toBe('500');
    const sent = h.calls.find(call => call.method === 'sendMessage')!;
    expect(sent.body).not.toHaveProperty('message_thread_id');
    expect(sent.body).toMatchObject({ chat_id: '-100123', reply_parameters: { message_id: 45, allow_sending_without_reply: true } });
    await h.channel.stop();
    stores.splice(stores.indexOf(store), 1);
    store.close();
    const reopened = new Store(file);
    stores.push(reopened);
    const restarted = harness({ knownEndpoints: reopened.listEndpoints(), callbacks: { endpoint: endpoint => reopened.upsertEndpoint(endpoint) } });
    restarted.handlers.set('getChat', () => response({ id: -100123, type: 'supergroup', title: 'Infrastructure', is_forum: true }));
    restarted.handlers.set('getChatMember', () => response({ status: 'member', user: { id: 999, is_bot: true } }));
    await restarted.channel.start();
    restarted.push([
      { update_id: 4, my_chat_member: { chat: { id: -100123, type: 'supergroup', title: 'Infrastructure', is_forum: true },
        new_chat_member: { status: 'member', user: { id: 999, is_bot: true } } } },
      { update_id: 5, message: privateMessage({ text: undefined, chat_shared: { request_id: 0x52454c45, chat_id: -100123 } }) },
    ]);
    await vi.waitFor(() => expect(restarted.offset).toBe(6));
    expect(reopened.getEndpoint(parent.id)).toMatchObject({ id: parent.id, threadId: '', generalTopic: true, title: 'Infrastructure / Общая тема', topicTitle: 'Общая тема' });
    expect(reopened.getConversation(previous.id)?.bindings[0].endpointId).toBe(oldReply.id);
    expect(reopened.getEndpoint(oldReply.id)?.threadId).toBe('42');
    expect(restarted.calls.some(call => call.method === 'sendMessage')).toBe(false);
  });

  it('treats generic reply threads in ordinary supergroups as their existing chat, without inventing a forum', async () => {
    const h = harness();
    await h.channel.start();
    h.push([{ update_id: 1, message: telegramMessage({ message_thread_id: 42, is_topic_message: undefined,
      chat: { id: -100456, type: 'supergroup', title: 'Operations' } }) }]);
    await vi.waitFor(() => expect(h.offset).toBe(2));
    expect(vi.mocked(h.callbacks.message).mock.calls[0][0].endpoint).toMatchObject({ threadId: '', title: 'Operations', isForum: false });
    expect(vi.mocked(h.callbacks.endpoint).mock.calls).toHaveLength(1);
    expect(vi.mocked(h.callbacks.message).mock.calls[0][0].endpoint.generalTopic).not.toBe(true);
  });

  it('does not reinterpret a malformed marked topic without its identifier as General', async () => {
    const h = harness();
    await h.channel.start();
    h.push([{ update_id: 1, message: generalMessage({ is_topic_message: true, text: '/rele_register' }) }]);
    await vi.waitFor(() => expect(h.offset).toBe(2));
    expect(h.callbacks.endpoint).not.toHaveBeenCalled();
    expect(h.callbacks.message).not.toHaveBeenCalled();
    expect(h.calls.some(call => call.method === 'sendMessage')).toBe(false);
  });

  it('normalizes General approval callback messages consistently and preserves private topic callback routing', async () => {
    const h = harness();
    await h.channel.start();
    const origin = { ...delivery().origin, endpointId: endpointId('telegram', '999', '-100123', ''), threadId: '' };
    await h.channel.deliver(delivery({ origin, kind: 'approval', approvalId: APPROVAL_ID }), approval());
    expect(h.calls.find(call => call.method === 'sendMessage')?.body).not.toHaveProperty('message_thread_id');
    const data = `rele:${APPROVAL_ID}:accept`;
    h.push([
      { update_id: 1, callback_query: { id: 'general-1', from: { id: 123, first_name: 'Alex' }, data, message: generalMessage({ message_id: 500 }) } },
      { update_id: 2, callback_query: { id: 'general-2', from: { id: 123, first_name: 'Alex' }, data, message: generalMessage({ message_id: 500, message_thread_id: 20 }) } },
      { update_id: 3, callback_query: { id: 'private-topic', from: { id: 123, first_name: 'Alex' }, data, message: privateMessage({ message_id: 500, message_thread_id: 17 }) } },
    ]);
    await vi.waitFor(() => expect(h.offset).toBe(4));
    const sources = vi.mocked(h.callbacks.action).mock.calls.map(([action]) => ({ chatId: action.chatId, threadId: action.threadId }));
    expect(sources).toEqual([{ chatId: '-100123', threadId: '' }, { chatId: '-100123', threadId: '' }, { chatId: '123', threadId: '17' }]);
    expect(h.calls.filter(call => call.method === 'answerCallbackQuery').map(call => call.body.text)).toEqual(['Ответ принят.', 'Ответ принят.', 'Ответ принят.']);
  });

  it('rejects a General send acknowledgement from an actual non-General topic', async () => {
    const h = harness();
    h.handlers.set('sendMessage', () => response(generalMessage({ message_id: 500, is_topic_message: true, message_thread_id: 17 })));
    await h.channel.start();
    await expect(h.channel.deliver(delivery({ origin: { ...delivery().origin, threadId: '' } }))).rejects.toMatchObject({ uncertain: true, retryable: false });
    expect(h.calls.filter(call => call.method === 'sendMessage')).toHaveLength(1);
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
