import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { Endpoint } from '../src/shared/types.js';
import { SlackChannel } from '../src/server/channels/slack.js';
import { endpointId, type ChannelCallbacks } from '../src/server/channels/common.js';

type Json = Record<string, any>;
type Handler = (body: Json) => unknown | Promise<unknown>;
const live: SlackChannel[] = [];
afterEach(async () => {
  for (const channel of live.splice(0)) await channel.stop();
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  ping = vi.fn();
  terminate() { this.readyState = 3; this.emit('close'); }
}

async function fixture(handlers: Record<string, Handler> = {}, knownEndpoints: Endpoint[] = []) {
  const calls: Array<{ method: string; body: Json; authorization: string | null }> = [];
  const callbacks: ChannelCallbacks = {
    message: vi.fn().mockResolvedValue(undefined), endpoint: vi.fn(),
    action: vi.fn().mockResolvedValue(undefined), status: vi.fn(),
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const method = new URL(String(input)).pathname.split('/').at(-1)!;
    const form = new Headers(init?.headers).get('content-type')?.startsWith('application/x-www-form-urlencoded');
    if (['conversations.members', 'users.info'].includes(method) && !form) {
      return Response.json({ ok: false, error: method === 'conversations.members' ? 'invalid_arguments' : 'user_not_found' });
    }
    const body = form ? Object.fromEntries(new URLSearchParams(String(init?.body))) : JSON.parse(String(init?.body));
    calls.push({ method, body, authorization: new Headers(init?.headers).get('authorization') });
    const defaults: Record<string, Handler> = {
      'auth.test': () => ({ ok: true, team_id: 'TONE', user_id: 'UBOT', team: 'Команда' }),
      'apps.connections.open': () => ({ ok: true, url: 'wss://wss-primary.slack.com/test' }),
      'users.conversations': () => ({ ok: true, channels: [{ id: 'CONE', name: 'general' }] }),
      'users.info': value => ({ ok: true, user: { id: value.user, profile: { display_name: value.user === 'UANNA' ? 'Анна' : 'Борис' } } }),
      'conversations.members': () => ({ ok: true, members: ['UBOT', 'UANNA', 'UBORIS'] }),
      'conversations.history': () => ({ ok: true, messages: [] }),
    };
    const handler = handlers[method] ?? defaults[method];
    if (!handler) throw new Error('Unexpected synthetic Slack call');
    const result = await handler(body);
    return result instanceof Response ? result : Response.json(result);
  });
  const channel = new SlackChannel('SLACK_TOKEN_PLACEHOLDER_7827226', 'SLACK_TOKEN_PLACEHOLDER_3805900', callbacks, {
    fetch: fetcher, knownEndpoints,
    socket: () => {
      const socket = new FakeSocket();
      queueMicrotask(() => socket.emit('open'));
      return socket as unknown as WebSocket;
    },
  });
  live.push(channel);
  await channel.start();
  return { channel, callbacks, calls, callsFor: (method: string) => calls.filter(call => call.method === method) };
}

function savedEndpoint(accountId: string, name: string): Endpoint {
  return {
    id: endpointId('slack', accountId, 'CONE', '1770000000.123456'),
    platform: 'slack', accountId, chatId: 'CONE', threadId: '1770000000.123456',
    title: 'Сохранённое обсуждение', subtitle: 'Команда', available: true,
    people: [{ id: 'UANNA', name }], updatedAt: '2026-10-18T00:00:00Z',
  };
}

describe('Slack bot conversation catalog', () => {
  it('loads members and profiles when Slack rejects JSON arguments', async () => {
    const { channel } = await fixture();
    expect(await channel.listPeople('CONE')).toEqual({
      items: [{ id: 'UANNA', name: 'Анна' }, { id: 'UBORIS', name: 'Борис' }],
      nextCursor: undefined,
    });
  });

  it('pages all four conversation types with human DM and MPIM names using the bot token', async () => {
    const { channel, callbacks, callsFor } = await fixture({
      'users.conversations': body => body.cursor ? {
        ok: true, channels: [{ id: 'CPRIVATE', name: 'planning', is_private: true }, { id: 'GGROUP', is_mpim: true, name: 'mpdm-raw-internal-name' }],
        response_metadata: { next_cursor: '' },
      } : {
        ok: true, channels: [{ id: 'CONE', name: 'general' }, { id: 'DANNA', is_im: true, user: 'UANNA' }],
        response_metadata: { next_cursor: 'chat-page-2' },
      },
    });
    expect(channel.state.accountId).toBe('TONE:UBOT');
    const first = await channel.listChats();
    expect(first.nextCursor).toBe('chat-page-2');
    expect(first.items).toMatchObject([
      { id: 'CONE', name: '#general', kind: 'channel' },
      { id: 'DANNA', name: 'Анна', kind: 'direct', subtitle: 'Команда · Личные сообщения' },
    ]);
    const second = await channel.listChats(first.nextCursor);
    expect(second.items).toMatchObject([
      { id: 'CPRIVATE', name: '#planning', subtitle: 'Команда · Закрытый канал' },
      { id: 'GGROUP', name: 'Анна, Борис', kind: 'group' },
    ]);
    expect(second.nextCursor).toBeUndefined();
    expect(callsFor('users.conversations').map(call => call.body)).toEqual([
      { types: 'public_channel,private_channel,im,mpim', exclude_archived: true, limit: 100 },
      { types: 'public_channel,private_channel,im,mpim', exclude_archived: true, limit: 100, cursor: 'chat-page-2' },
    ]);
    expect(callsFor('users.conversations').every(call => call.authorization === 'Bearer SLACK_TOKEN_PLACEHOLDER_7827226')).toBe(true);
    expect(callsFor('users.info').filter(call => call.body.user === 'UANNA')).toHaveLength(1);
    expect(callbacks.message).not.toHaveBeenCalled();
    expect(callbacks.action).not.toHaveBeenCalled();
  });

  it('keeps pagination when a page contains only archived or unavailable conversations', async () => {
    const { channel } = await fixture({
      'users.conversations': () => ({ ok: true, channels: [
        { id: 'CARCHIVE', name: 'old', is_archived: true },
        { id: 'COTHER', name: 'not-joined', is_member: false },
      ], response_metadata: { next_cursor: 'more' } }),
    });
    expect(await channel.listChats()).toEqual({ items: [], nextCursor: 'more' });
  });

  it('persists only threadable root messages, preserves string timestamps, and never creates an inbox request', async () => {
    const previous = savedEndpoint('TONE:UBOT', 'Анна');
    const { channel, callbacks, callsFor } = await fixture({
      'conversations.history': body => body.cursor ? {
        ok: true, messages: [{ type: 'message', ts: '1770000005.000001', text: 'Следующая страница' }],
      } : {
        ok: true, messages: [
          { type: 'message', ts: '1770000000.123456', thread_ts: '1770000000.123456', text: 'План обновления', reply_count: 3 },
          { type: 'message', ts: '1770000001.000001', text: 'Пока без ответов' },
          { type: 'message', ts: '1770000002.000001', subtype: 'file_share', files: [{ title: 'Запись встречи.ogg' }] },
          { type: 'message', ts: '1770000003.000001', subtype: 'bot_message', text: 'Корневое сообщение бота' },
          { type: 'message', ts: '1770000004.000001', subtype: 'channel_join', text: 'служебное событие' },
          { type: 'message', ts: '1770000004.000002', thread_ts: '1770000000.123456', text: 'Ответ внутри треда' },
          { type: 'message', ts: '1770000004.000003', subtype: 'message_deleted' },
          { type: 'message', ts: 1770000004.000004, text: 'Неточный numeric timestamp' },
          { type: 'message', ts: 'not-a-timestamp', text: 'Неверное время' },
        ], response_metadata: { next_cursor: 'history-page-2' },
      },
    }, [previous, savedEndpoint('TOTHER:UBOT', 'Чужое имя')]);
    const first = await channel.listThreads('CONE');
    expect(first.items).toHaveLength(4);
    expect(first.items[0]).toMatchObject({
      id: previous.id, accountId: 'TONE:UBOT', chatTitle: '#general', available: true,
      title: 'План обновления', threadId: '1770000000.123456', people: [{ id: 'UANNA', name: 'Анна' }],
    });
    expect(first.items[0].subtitle).toContain('Ответов: 3');
    expect(first.items[0].subtitle).toContain('UTC');
    expect(first.items[0].subtitle).toContain('План обновления');
    expect(first.items[1].subtitle).toContain('Ответов: 0');
    expect(first.items[2].title).toBe('Запись встречи.ogg');
    const second = await channel.listThreads('CONE', first.nextCursor);
    expect(second.items[0].threadId).toBe('1770000005.000001');
    expect(second.nextCursor).toBeUndefined();
    expect(callsFor('conversations.history').map(call => call.body)).toEqual([
      { channel: 'CONE', limit: 100 }, { channel: 'CONE', limit: 100, cursor: 'history-page-2' },
    ]);
    expect(callbacks.endpoint).toHaveBeenCalledTimes(5);
    expect(callbacks.message).not.toHaveBeenCalled();
    expect(callbacks.action).not.toHaveBeenCalled();
    expect(callsFor('chat.postMessage')).toEqual([]);
    expect(callsFor('conversations.replies')).toEqual([]);
  });

  it('pages members, resolves names, and excludes bots and deleted users', async () => {
    const { channel, callsFor } = await fixture({
      'conversations.members': body => body.cursor ? {
        ok: true, members: ['UBORIS'], response_metadata: { next_cursor: '' },
      } : {
        ok: true, members: ['UBOT', 'UANNA', 'UANNA', 'UOTHERBOT', 'UDELETED', 'UAPP'],
        response_metadata: { next_cursor: 'people-page-2' },
      },
      'users.info': body => ({ ok: true, user: {
        id: body.user, is_bot: body.user === 'UOTHERBOT', deleted: body.user === 'UDELETED', is_app_user: body.user === 'UAPP',
        profile: { real_name: body.user === 'UANNA' ? 'Анна' : 'Борис' },
      } }),
    });
    const first = await channel.listPeople('CONE');
    expect(first).toEqual({ items: [{ id: 'UANNA', name: 'Анна' }], nextCursor: 'people-page-2' });
    expect(await channel.listPeople('CONE', first.nextCursor)).toEqual({ items: [{ id: 'UBORIS', name: 'Борис' }], nextCursor: undefined });
    expect(callsFor('conversations.members').map(call => call.body)).toEqual([
      { channel: 'CONE', limit: '20' }, { channel: 'CONE', limit: '20', cursor: 'people-page-2' },
    ]);
    expect(callsFor('users.info').filter(call => call.body.user === 'UBOT')).toEqual([]);
  });

  it('returns the accessible IM user without enumerating channel members', async () => {
    const { channel, callsFor } = await fixture({
      'users.conversations': () => ({ ok: true, channels: [{ id: 'DANNA', is_im: true, user: 'UANNA' }] }),
    });
    expect(await channel.listPeople('DANNA')).toEqual({ items: [{ id: 'UANNA', name: 'Анна' }] });
    expect(callsFor('conversations.members')).toEqual([]);
  });

  it('enriches an IM missing its user through conversation info and reuses the confirmed participant', async () => {
    const { channel, callsFor } = await fixture({
      'users.conversations': () => ({ ok: true, channels: [{ id: 'DANNA', is_im: true }] }),
      'conversations.info': () => ({ ok: true, channel: { id: 'DANNA', is_im: true, user: 'UANNA' } }),
    });
    expect((await channel.listChats()).items).toMatchObject([{ id: 'DANNA', name: 'Анна', kind: 'direct' }]);
    expect(await channel.listPeople('DANNA')).toEqual({ items: [{ id: 'UANNA', name: 'Анна' }] });
    expect(callsFor('conversations.info').map(call => call.body)).toEqual([{ channel: 'DANNA' }]);
    expect(callsFor('users.info')).toHaveLength(1);
    expect(callsFor('conversations.members')).toEqual([]);
  });

  it.each([
    { id: 'DOTHER', is_im: true, user: 'UANNA' },
    { id: 'DANNA', is_im: true },
  ])('rejects an unconfirmed IM participant without falling back to members ($id)', async detail => {
    const { channel, callsFor } = await fixture({
      'users.conversations': () => ({ ok: true, channels: [{ id: 'DANNA', is_im: true }] }),
      'conversations.info': () => ({ ok: true, channel: detail }),
    });
    await expect(channel.listPeople('DANNA')).rejects.toThrow('Slack не сообщил участника личного разговора.');
    expect(callsFor('users.info')).toEqual([]);
    expect(callsFor('conversations.members')).toEqual([]);
  });

  it('finds an uncached bot membership on a later page instead of trusting a supplied channel ID', async () => {
    const { channel, callsFor } = await fixture({
      'users.conversations': body => body.cursor
        ? { ok: true, channels: [{ id: 'CSECOND', name: 'second' }] }
        : { ok: true, channels: [], response_metadata: { next_cursor: 'second' } },
    });
    expect(await channel.listThreads('CSECOND')).toEqual({ items: [], nextCursor: undefined });
    expect(callsFor('users.conversations')).toHaveLength(2);
    expect(callsFor('conversations.history')[0].body.channel).toBe('CSECOND');
  });

  it('marks a saved nonmember endpoint unavailable only after a complete scan and restores it after confirmed membership', async () => {
    const previous = savedEndpoint('TONE:UBOT', 'Анна');
    let restored = false;
    const { channel, callbacks, callsFor } = await fixture({
      'users.conversations': body => restored
        ? { ok: true, channels: [{ id: 'CONE', name: 'general' }] }
        : body.cursor
          ? { ok: true, channels: [] }
          : { ok: true, channels: [{ id: 'COTHER', name: 'allowed' }], response_metadata: { next_cursor: 'last' } },
    }, [previous, savedEndpoint('TOTHER:UBOT', 'Чужое имя')]);
    expect((await channel.listChats()).nextCursor).toBe('last');
    expect(callbacks.endpoint).not.toHaveBeenCalled();
    await expect(channel.listThreads('CONE')).rejects.toThrow('Разговор недоступен боту Slack');
    expect(callsFor('users.conversations')).toHaveLength(3);
    expect(callbacks.endpoint).toHaveBeenCalledExactlyOnceWith({ ...previous, available: false, updatedAt: expect.any(String) });
    await expect(channel.listPeople('CONE')).rejects.toThrow('Разговор недоступен боту Slack');
    expect(callsFor('conversations.history')).toEqual([]);
    expect(callsFor('conversations.members')).toEqual([]);
    expect(callbacks.endpoint).toHaveBeenCalledTimes(1);
    restored = true;
    await channel.listChats();
    expect(callbacks.endpoint).toHaveBeenLastCalledWith({ ...previous, available: true, updatedAt: expect.any(String) });
    expect(callbacks.endpoint).toHaveBeenCalledTimes(2);
    expect(callbacks.message).not.toHaveBeenCalled();
  });

  it.each([
    ['conversations.history', 'not_in_channel'],
    ['conversations.history', 'channel_not_found'],
    ['conversations.members', 'is_archived'],
    ['conversations.members', 'no_permission'],
  ])('invalidates every saved thread of the affected chat on %s / %s and evicts its membership', async (method, error) => {
    const previous = savedEndpoint('TONE:UBOT', 'Анна');
    const second = { ...previous, id: endpointId('slack', previous.accountId, previous.chatId, '1770000001.000001'), threadId: '1770000001.000001' };
    const otherChat = { ...previous, id: endpointId('slack', previous.accountId, 'COTHER', previous.threadId), chatId: 'COTHER' };
    let listed = true;
    const { channel, callbacks, callsFor } = await fixture({
      'users.conversations': () => ({ ok: true, channels: listed ? [{ id: 'CONE', name: 'general' }] : [] }),
      [method]: () => ({ ok: false, error }),
    }, [previous, second, otherChat, savedEndpoint('TOTHER:UBOT', 'Чужое имя')]);
    await expect(method === 'conversations.history' ? channel.listThreads('CONE') : channel.listPeople('CONE')).rejects.toThrow();
    expect(callbacks.endpoint).toHaveBeenCalledTimes(2);
    for (const endpoint of [previous, second]) expect(callbacks.endpoint).toHaveBeenCalledWith({ ...endpoint, available: false, updatedAt: expect.any(String) });
    listed = false;
    await expect(channel.listThreads('CONE')).rejects.toThrow('Разговор недоступен боту Slack');
    expect(callsFor('users.conversations')).toHaveLength(2);
    expect(callsFor(method)).toHaveLength(1);
    expect(callbacks.endpoint).toHaveBeenCalledTimes(2);
    expect(callbacks.message).not.toHaveBeenCalled();
  });

  it.each([
    ['users.conversations', 'timeout'],
    ['conversations.history', 'rate_limit'],
    ['conversations.members', 'missing_scope'],
  ])('keeps saved availability on a transient or scope failure (%s / %s)', async (method, failure) => {
    const { channel, callbacks } = await fixture({
      [method]: () => {
        if (failure === 'timeout') throw new DOMException('Synthetic timeout', 'TimeoutError');
        if (failure === 'rate_limit') return new Response('', { status: 429, headers: { 'retry-after': '2' } });
        return { ok: false, error: 'missing_scope' };
      },
    }, [savedEndpoint('TONE:UBOT', 'Анна')]);
    await expect(method === 'conversations.members' ? channel.listPeople('CONE') : channel.listThreads('CONE')).rejects.toThrow();
    expect(callbacks.endpoint).not.toHaveBeenCalled();
    expect(callbacks.message).not.toHaveBeenCalled();
  });

  it.each(['stopped', 'same_account', 'other_account'])('ignores a late access rejection after the connection changes (%s)', async mode => {
    let finish!: (value: unknown) => void;
    const response = new Promise(resolve => { finish = resolve; });
    let team = 'TONE';
    const { channel, callbacks, callsFor } = await fixture({
      'auth.test': () => ({ ok: true, team_id: team, user_id: 'UBOT', team }),
      'conversations.history': () => response,
    }, [savedEndpoint('TONE:UBOT', 'Анна')]);
    const pending = channel.listThreads('CONE');
    const rejection = expect(pending).rejects.toThrow('Подключение Slack изменилось');
    await vi.waitFor(() => expect(callsFor('conversations.history')).toHaveLength(1));
    await channel.stop();
    if (mode !== 'stopped') {
      if (mode === 'other_account') team = 'TTWO';
      await channel.start();
      await channel.listChats();
    }
    finish({ ok: false, error: 'not_in_channel' });
    await rejection;
    expect(callbacks.endpoint).not.toHaveBeenCalled();
    if (mode !== 'stopped') {
      const scans = callsFor('users.conversations').length;
      await channel.listPeople('CONE');
      expect(callsFor('users.conversations')).toHaveLength(scans);
    }
    expect(callbacks.message).not.toHaveBeenCalled();
  });

  it('clears memberships and names when the authenticated account changes', async () => {
    let team = 'TONE';
    const { channel, callsFor } = await fixture({
      'auth.test': () => ({ ok: true, team_id: team, user_id: 'UBOT', team }),
      'users.conversations': () => ({ ok: true, channels: [
        { id: team === 'TONE' ? 'CONE' : 'CTWO', name: 'team-channel' }, { id: 'DANNA', is_im: true, user: 'UANNA' },
      ] }),
      'users.info': body => ({ ok: true, user: { id: body.user, profile: { display_name: `${team} Анна` } } }),
    }, [savedEndpoint('TOTHER:UBOT', 'Чужое имя')]);
    expect((await channel.listChats()).items[1].name).toBe('TONE Анна');
    await channel.stop();
    team = 'TTWO';
    await channel.start();
    expect(channel.state.accountId).toBe('TTWO:UBOT');
    await expect(channel.listThreads('CONE')).rejects.toThrow('Разговор недоступен боту Slack');
    expect((await channel.listChats()).items[1].name).toBe('TTWO Анна');
    expect(callsFor('users.info')).toHaveLength(2);
    expect(callsFor('conversations.history')).toEqual([]);
  });

  it('reports missing scopes without echoing API data or tokens', async () => {
    const { channel } = await fixture({
      'users.conversations': () => ({ ok: false, error: 'missing_scope', needed: 'SLACK_TOKEN_PLACEHOLDER_7827226' }),
    });
    await expect(channel.listChats()).rejects.toMatchObject({
      message: 'Приложению Slack не хватает разрешений. Обновите разрешения и переустановите приложение в workspace.',
      retryable: false, uncertain: false,
    });
  });

  it.each([
    { status: 429, header: '7', retryAfterMs: 7000 },
    { status: 429, header: 'invalid', retryAfterMs: 30000 },
    { status: 200, header: '9', retryAfterMs: 9000 },
  ])('preserves a rate-limited catalog page for a later retry ($status, $header)', async ({ status, header, retryAfterMs }) => {
    const { channel, callbacks, callsFor } = await fixture({
      'conversations.history': () => new Response(status === 429 ? '' : JSON.stringify({ ok: false, error: 'ratelimited' }), { status, headers: { 'retry-after': header } }),
    });
    await expect(channel.listThreads('CONE')).rejects.toMatchObject({ retryable: true, uncertain: false, retryAfterMs, statusCode: 429 });
    expect(callsFor('conversations.history')).toHaveLength(1);
    expect(callbacks.endpoint).not.toHaveBeenCalled();
    expect(callbacks.message).not.toHaveBeenCalled();
  });

  it.each([false, true])('rejects an in-flight history response after stop, including a new session with the same account (%s)', async (restart) => {
    let finish!: (value: unknown) => void;
    const response = new Promise(resolve => { finish = resolve; });
    const { channel, callbacks, callsFor } = await fixture({ 'conversations.history': () => response });
    const pending = channel.listThreads('CONE');
    const rejection = expect(pending).rejects.toThrow('Подключение Slack изменилось');
    await vi.waitFor(() => expect(callsFor('conversations.history')).toHaveLength(1));
    await channel.stop();
    if (restart) await channel.start();
    finish({ ok: true, messages: [{ type: 'message', ts: '1770000000.123456', text: 'Late synthetic result' }] });
    await rejection;
    expect(callbacks.endpoint).not.toHaveBeenCalled();
    expect(callbacks.message).not.toHaveBeenCalled();
  });

  it('does not cache a late conversation page into the next connection', async () => {
    let finish!: (value: unknown) => void;
    const response = new Promise(resolve => { finish = resolve; });
    let first = true;
    const { channel, callbacks, callsFor } = await fixture({
      'users.conversations': () => {
        if (first) { first = false; return response; }
        return { ok: true, channels: [{ id: 'CNEW', name: 'new' }] };
      },
    });
    const pending = channel.listChats();
    const rejection = expect(pending).rejects.toThrow('Подключение Slack изменилось');
    await vi.waitFor(() => expect(callsFor('users.conversations')).toHaveLength(1));
    await channel.stop();
    await channel.start();
    finish({ ok: true, channels: [{ id: 'COLD', name: 'old' }] });
    await rejection;
    await expect(channel.listThreads('COLD')).rejects.toThrow('Разговор недоступен боту Slack');
    expect(callsFor('conversations.history')).toEqual([]);
    expect(callbacks.endpoint).not.toHaveBeenCalled();
    expect(callbacks.message).not.toHaveBeenCalled();
  });
});
