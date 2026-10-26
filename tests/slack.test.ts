import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { Delivery, Endpoint, InboundMessage } from '../src/shared/types.js';
import { SlackChannel } from '../src/server/channels/slack.js';
import { Store } from '../src/server/store.js';
import {
  ChannelError,
  endpointId,
  type ChannelCallbacks,
} from '../src/server/channels/common.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(value: string) {
    this.sent.push(value);
  }
  ping = vi.fn();
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
  receive(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }
}

const live: SlackChannel[] = [];
const files: string[] = [];
afterEach(async () => {
  for (const channel of live.splice(0)) await channel.stop();
  for (const directory of files.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function makeChannel(
  options: {
    message?: ChannelCallbacks['message'];
    action?: ChannelCallbacks['action'];
    postMessage?: () => Promise<Response>;
    api?: (method: string, body: Record<string, unknown>) => Response | undefined | Promise<Response | undefined>;
    knownEndpoints?: Endpoint[];
  } = {},
) {
  const socket = new FakeSocket();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const endpoints = vi.fn<ChannelCallbacks['endpoint']>();
  const message =
    options.message ??
    vi.fn<ChannelCallbacks['message']>().mockResolvedValue(undefined);
  const action =
    options.action ??
    vi.fn<ChannelCallbacks['action']>().mockResolvedValue(undefined);
  const status = vi.fn();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      const form = new Headers(init?.headers).get('content-type')?.startsWith('application/x-www-form-urlencoded');
      const body = form ? Object.fromEntries(new URLSearchParams(String(init?.body))) : init?.body ? JSON.parse(String(init.body)) : {};
      const override = await options.api?.(url.split('/').at(-1)!, body);
      if (override) return override;
      if (url === 'https://slack.com/api/auth.test')
        return Response.json({
          ok: true,
          team_id: 'TEXAMPLE',
          user_id: 'UBOT',
          bot_id: 'BSELF',
          team: 'Пример команды',
        });
      if (url === 'https://slack.com/api/apps.connections.open')
        return Response.json({
          ok: true,
          url: 'wss://wss-primary.slack.com/link?ticket=synthetic-only',
        });
      if (url === 'https://slack.com/api/users.info')
        return Response.json({
          ok: true,
          user: { id: 'UANNA', is_bot: false, profile: { display_name: 'Анна (пример)' } },
        });
      if (url === 'https://slack.com/api/conversations.info')
        return Response.json({
          ok: true,
          channel: { id: 'CEXAMPLE', name: 'example' },
        });
      if (url === 'https://slack.com/api/conversations.replies')
        return Response.json({
          ok: true,
          messages: [{ text: 'Пример: вопрос API' }],
        });
      if (url === 'https://slack.com/api/chat.postMessage')
        return options.postMessage
          ? options.postMessage()
          : Response.json({ ok: true, ts: '1000.2000', channel: 'CEXAMPLE' });
      if (url.startsWith('https://files.slack.com/files-pri/'))
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'audio/ogg', 'content-length': '3' },
        });
      throw new Error(`Unexpected URL in isolated Slack test: ${url}`);
    });
  const channel = new SlackChannel(
    'SLACK_TOKEN_PLACEHOLDER_4051722',
    'SLACK_TOKEN_PLACEHOLDER_6612940',
    { message, endpoint: endpoints, action, status },
    {
      fetch: fetcher,
      knownEndpoints: options.knownEndpoints,
      socket: () => {
        queueMicrotask(() => socket.emit('open'));
        return socket as unknown as WebSocket;
      },
    },
  );
  live.push(channel);
  await channel.start();
  return { channel, socket, calls, fetcher, endpoints, message, action, status };
}

function envelope(
  id: string,
  type: 'message' | 'app_mention' = 'message',
  extra: Record<string, unknown> = {},
) {
  return {
    envelope_id: id,
    type: 'events_api',
    payload: {
      team_id: 'TEXAMPLE',
      event_id: `outer-${id}`,
      event: {
        type,
        user: 'UANNA',
        channel: 'CEXAMPLE',
        ts: '1000.1001',
        thread_ts: '1000.1000',
        text: '<@UBOT> Пример сообщения',
        ...extra,
      },
    },
  };
}

function delivery(accountId = 'TEXAMPLE:UBOT'): Delivery {
  return {
    id: 'delivery-example',
    requestId: 'request-example',
    origin: {
      platform: 'slack',
      accountId,
      endpointId: 'endpoint-example',
      chatId: 'CEXAMPLE',
      threadId: '1000.1000',
      senderId: 'UANNA',
      senderName: 'Анна (пример)',
      messageId: '1000.1001',
    },
    key: 'part-0',
    ordinal: 0,
    kind: 'answer',
    body: 'Пример <@everyone> & ответ',
    status: 'sending',
    attempts: 1,
    createdAt: '2026-10-18T20:00:00Z',
    updatedAt: '2026-10-18T20:00:00Z',
  };
}

describe('Slack Socket Mode durability and identity', () => {
  it('ACKs only after the durable message callback completes', async () => {
    let commit!: () => void;
    const durable = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const message = vi
      .fn<ChannelCallbacks['message']>()
      .mockImplementation(() => durable);
    const { socket } = await makeChannel({ message });
    socket.receive(envelope('env-1'));
    await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
    expect(socket.sent).toEqual([]);
    commit();
    await vi.waitFor(() =>
      expect(socket.sent).toEqual([JSON.stringify({ envelope_id: 'env-1' })]),
    );
  });

  it('does not ACK a failed inbox write and can accept a later replay', async () => {
    const message = vi
      .fn<ChannelCallbacks['message']>()
      .mockRejectedValueOnce(new Error('Synthetic disk error'))
      .mockResolvedValue(undefined);
    const { socket, channel } = await makeChannel({ message });
    socket.receive(envelope('env-failed'));
    await vi.waitFor(() =>
      expect(channel.state.error).toContain('Не удалось сохранить событие'),
    );
    expect(socket.sent).toEqual([]);
    socket.receive(envelope('env-replay'));
    await vi.waitFor(() =>
      expect(socket.sent).toEqual([
        JSON.stringify({ envelope_id: 'env-replay' }),
      ]),
    );
  });

  it('delivers native Stop as a durable control, without fabricating a Slack transcript message', async () => {
    const known: Endpoint = { id: endpointId('slack', 'TEXAMPLE:UBOT', 'CEXAMPLE', '1000.1000'), platform: 'slack', accountId: 'TEXAMPLE:UBOT', chatId: 'CEXAMPLE', threadId: '1000.1000', title: 'Thread', subtitle: 'Slack', people: [{ id: 'UANNA', name: 'Anna' }], updatedAt: '2026-10-20T00:00:00Z' };
    let commit!: () => void;
    const persisted = new Promise<void>(resolve => { commit = resolve; });
    const message = vi.fn<ChannelCallbacks['message']>().mockRejectedValueOnce(new Error('Synthetic disk error')).mockImplementationOnce(() => persisted);
    const { socket, channel } = await makeChannel({ message, knownEndpoints: [known] });
    const stop = envelope('native-stop', 'message', { type: 'agent_session_stopped', event_ts: '1000.2000', streaming_message_ts: [] });
    socket.receive(stop);
    await vi.waitFor(() => expect(channel.state.error).toContain('Не удалось сохранить событие'));
    expect(socket.sent).toEqual([]);
    socket.receive(stop);
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(2));
    expect(message.mock.calls[1][0]).toEqual({ control: 'stop', eventId: 'agent-session-stopped:outer-native-stop', endpoint: known, sender: { id: 'UANNA', name: 'Анна (пример)', isBot: false }, messageId: '1000.2000', text: '' });
    expect(socket.sent).toEqual([]);
    commit();
    await vi.waitFor(() => expect(socket.sent).toEqual([JSON.stringify({ envelope_id: 'native-stop' })]));
  });

  it('rejects foreign and malformed native Stop events before the control callback', async () => {
    const known: Endpoint = { id: endpointId('slack', 'TEXAMPLE:UBOT', 'CEXAMPLE', '1000.1000'), platform: 'slack', accountId: 'TEXAMPLE:UBOT', chatId: 'CEXAMPLE', threadId: '1000.1000', title: 'Thread', subtitle: 'Slack', people: [], updatedAt: '2026-10-20T00:00:00Z' };
    const { socket, message } = await makeChannel({ knownEndpoints: [known] });
    const stop = envelope('foreign-stop', 'message', { type: 'agent_session_stopped', event_ts: '1000.2000', streaming_message_ts: [] });
    socket.receive({ ...stop, payload: { ...stop.payload, team_id: 'TOTHER' } });
    for (const patch of [{ channel: 'COTHER' }, { thread_ts: '1000.9999' }, { thread_ts: undefined }, { user: 'invalid' }, { event_ts: undefined }]) {
      socket.receive(envelope('invalid-stop', 'message', { type: 'agent_session_stopped', event_ts: '1000.2000', ...patch }));
    }
    await vi.waitFor(() => expect(socket.sent).toHaveLength(5));
    expect(message).not.toHaveBeenCalled();
  });

  it('normalizes app_mention and message to the same dedupe identity and named endpoint', async () => {
    const received: InboundMessage[] = [];
    const { socket, endpoints } = await makeChannel({
      message: async (value) => {
        received.push(value);
      },
    });
    socket.receive(envelope('env-message', 'message'));
    socket.receive(envelope('env-mention', 'app_mention'));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[0].eventId).toBe(received[1].eventId);
    expect(received[0].endpoint.id).toBe(received[1].endpoint.id);
    expect(received[0].endpoint.accountId).toBe('TEXAMPLE:UBOT');
    expect(received[0].text).toBe('<@UBOT> Пример сообщения');
    await vi.waitFor(() => expect(endpoints).toHaveBeenCalled());
    const named = endpoints.mock.calls.at(-1)![0];
    expect(named.title).toBe('Пример сообщения');
    expect(named.subtitle).toBe('Пример команды · #example');
    expect(named.people).toContainEqual({ id: 'UANNA', name: 'Анна (пример)', isBot: false });
  });

  it('persists self and peer bot messages while rejecting another workspace', async () => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('env-self', 'message', { user: 'UBOT' }));
    socket.receive(envelope('env-bot', 'message', { bot_id: 'BOTHER' }));
    const foreign = envelope('env-foreign');
    foreign.payload.team_id = 'TOTHER';
    socket.receive(foreign);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(message).toHaveBeenCalledTimes(2);
    expect(vi.mocked(message).mock.calls[0][0]).toMatchObject({ contextOnly: true, sender: { id: 'UBOT', isBot: true } });
    expect(vi.mocked(message).mock.calls[1][0]).toMatchObject({ contextOnly: false, directMention: true, sender: { id: 'UANNA', isBot: true } });
  });

  it('reports fresh peer mentions for the binding policy and never wakes itself', async () => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('peer-passive', 'message', { user: 'UPEER', bot_id: 'BPEER', text: 'Готово', ts: '1000.1002' }));
    socket.receive(envelope('peer-block', 'message', { user: 'UPEER', bot_id: 'BPEER', text: '', blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_quote', elements: [{ type: 'user', user_id: 'UBOT' }] }] }], ts: '1000.1003' }));
    socket.receive(envelope('peer-direct', 'message', { user: 'UPEER', bot_id: 'BPEER', text: '<@UBOT> Проверь', ts: '1000.1004' }));
    socket.receive(envelope('self-direct', 'message', { user: 'UBOT', text: '<@UBOT> Мой ответ', ts: '1000.1005' }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(4));
    const received = vi.mocked(message).mock.calls.map(([value]) => value);
    expect(received.map(value => value.contextOnly)).toEqual([false, true, false, true]);
    expect(received.map(value => value.directMention)).toEqual([false, false, true, true]);
    expect(received[0].endpoint.people).toContainEqual({ id: 'UPEER', name: 'Бот Slack', isBot: true });
    expect(received[3].endpoint.people.some(person => person.id === 'UBOT')).toBe(false);
  });

  it('keeps complete visible payload and distinct edit/delete receipts from inner source identity', async () => {
    const { socket, message } = await makeChannel();
    const long = 'я'.repeat(60_000);
    const original = { type: 'message', user: 'UANNA', ts: '1000.1001', thread_ts: '1000.1000', text: long, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: long } }], files: [{ id: 'FONE', name: 'Отчёт.pdf', mimetype: 'application/pdf', url_private: 'https://files.slack.com/files-pri/one', token: 'synthetic-exclude' }], attachments: [{ text: 'Приложение' }], bot_profile: { name: 'noise' }, reply_count: 7 };
    socket.receive(envelope('full-original', 'message', original));
    socket.receive(envelope('full-edit', 'message', { subtype: 'message_changed', ts: '9999.1', thread_ts: '9999.0', message: { ...original, text: long + ' изменено', edited: { user: 'UANNA', ts: '1001.1' } } }));
    socket.receive(envelope('full-delete', 'message', { subtype: 'message_deleted', ts: '9999.2', deleted_ts: '1000.1001', previous_message: original }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(3));
    const received = vi.mocked(message).mock.calls.map(([value]) => value);
    expect(received.every(value => value.endpoint.threadId === '1000.1000' && value.messageId === '1000.1001')).toBe(true);
    expect(new Set(received.map(value => value.eventId)).size).toBe(3);
    expect(received.map(value => value.slack?.kind)).toEqual(['message', 'edit', 'deleted']);
    expect(received.map(value => value.contextOnly)).toEqual([false, true, true]);
    expect(received[0].text).toHaveLength(60_000);
    expect(received[0].slack?.payload).toMatchObject({ text: long, blocks: original.blocks, attachments: original.attachments, files: [{ id: 'FONE', name: 'Отчёт.pdf', mimetype: 'application/pdf' }] });
    expect(JSON.stringify(received[0].slack?.payload)).not.toMatch(/synthetic-exclude|bot_profile|reply_count|event_ts/);
  });

  it.each(['> <@UBOT> цитата', '`<@UBOT>`', '``<@UBOT>``', '``a ` <@UBOT> b``', '```md\n<@UBOT>\n```', '~~~\n<@UBOT>\n~~~'])('does not treat a quoted/code-only token as a fresh peer mention: %s', async text => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('quoted-peer', 'message', { user: 'UPEER', bot_id: 'BPEER', text }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
    expect(vi.mocked(message).mock.calls[0][0]).toMatchObject({ directMention: false, contextOnly: false });
  });

  it('recognizes app traffic and remembered bot roles even without a bot_message subtype', async () => {
    const known: Endpoint = { id: endpointId('slack', 'TEXAMPLE:UBOT', 'CEXAMPLE', '1000.1000'), platform: 'slack', accountId: 'TEXAMPLE:UBOT', chatId: 'CEXAMPLE', threadId: '1000.1000', title: 'Thread', subtitle: 'Slack', people: [{ id: 'UPEER', name: 'Другой агент', isBot: true }], updatedAt: '2026-10-20T00:00:00Z' };
    const { socket, message } = await makeChannel({ knownEndpoints: [known] });
    socket.receive(envelope('remembered-peer', 'message', { user: 'UPEER', text: 'Сводка' }));
    socket.receive(envelope('app-peer', 'message', { user: 'UAPP', app_id: 'AOTHER', text: 'Сводка', ts: '1000.1002' }));
    socket.receive(envelope('remember-app-role', 'message', { user: 'UAPP', text: 'Сводка в другом треде', ts: '1000.1003', thread_ts: '1000.0999' }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(3));
    for (const [received] of vi.mocked(message).mock.calls) expect(received).toMatchObject({ sender: { isBot: true }, directMention: false, contextOnly: false });
  });

  it('persists unknown message subtypes as context without making them task candidates', async () => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('system-context', 'message', { subtype: 'assistant_app_thread', text: '<@UBOT> Context' }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
    expect(vi.mocked(message).mock.calls[0][0]).toMatchObject({ contextOnly: true, slack: { payload: { subtype: 'assistant_app_thread' } } });
  });

  it('persists block-only/file-only app posts without adding fake authors to selectable people', async () => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('block-only', 'message', { user: undefined, bot_id: 'BHOOK', subtype: 'bot_message', text: '', blocks: [{ type: 'section', text: { type: 'plain_text', text: 'CI завершён' } }] }));
    socket.receive(envelope('file-only', 'message', { user: undefined, text: '', subtype: 'file_share', ts: '1000.1002', files: [{ id: 'FONE', title: 'Схема', mimetype: 'image/png' }] }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(2));
    const received = vi.mocked(message).mock.calls.map(([value]) => value);
    expect(received[0]).toMatchObject({ sender: { id: 'bot:BHOOK', isBot: true }, text: 'CI завершён', contextOnly: false });
    expect(received[1]).toMatchObject({ sender: { id: 'slack:unknown' }, text: '', contextOnly: true, slack: { payload: { files: [{ title: 'Схема' }] } } });
    expect(received.every(value => value.endpoint.people.length === 0)).toBe(true);
  });

  it('admits bot_id-only agents in an open group, while preserving selected-sender and own-bot guards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rele-slack-bot-only-')); files.push(dir);
    const store = new Store(join(dir, 'test.sqlite'));
    const source = (threadId: string): Endpoint => ({ id: endpointId('slack', 'TEXAMPLE:UBOT', 'CEXAMPLE', threadId),
      platform: 'slack', accountId: 'TEXAMPLE:UBOT', chatId: 'CEXAMPLE', threadId, title: 'Thread', subtitle: 'Slack', people: [], updatedAt: new Date().toISOString() });
    const open = source('1000.1000'), selected = source('1000.2000');
    store.upsertEndpoint(open); store.upsertEndpoint(selected);
    const conversation = store.createConversation({ name: 'Codex', threadId: 'codex-thread', cwd: '/project',
      bindings: [{ platform: 'slack', endpointId: open.id, allowedSenderIds: [] }, { platform: 'slack', endpointId: selected.id, allowedSenderIds: ['UHUMAN'] }] });
    store.setSourceAccess(open.id, { mode: 'all' });
    const received: InboundMessage[] = [];
    try {
      const { socket } = await makeChannel({ knownEndpoints: [open, selected], message: async value => { received.push(value); store.ingest(value); } });
      socket.receive(envelope('bot-only-open', 'message', { user: undefined, bot_id: 'BPEER', username: 'Peer agent', subtype: 'bot_message', text: 'Unmentioned work', ts: '1000.1001' }));
      socket.receive(envelope('bot-only-selected', 'message', { user: undefined, bot_id: 'BPEER', username: 'Peer agent', text: '<@UBOT> Work', thread_ts: selected.threadId, ts: '1000.2001' }));
      socket.receive(envelope('bot-only-self', 'message', { user: undefined, bot_id: 'BSELF', username: 'Peer agent', text: '<@UBOT> Echo', ts: '1000.1002' }));
      socket.receive(envelope('bot-only-invalid', 'message', { user: undefined, bot_id: 'invalid:BPEER', username: 'Peer agent', text: '<@UBOT> Work', ts: '1000.1003' }));
      await vi.waitFor(() => expect(received).toHaveLength(4));
      expect(received[0]).toMatchObject({ contextOnly: false, directMention: false, sender: { id: 'bot:BPEER', name: 'Peer agent', isBot: true } });
      expect(received[2]).toMatchObject({ contextOnly: true, sender: { id: 'bot:BSELF', isBot: true } });
      expect(received[3]).toMatchObject({ contextOnly: true, sender: { id: 'slack:unknown' } });
      expect(store.listRequests()).toEqual([expect.objectContaining({ origin: expect.objectContaining({ endpointId: open.id, senderId: 'bot:BPEER', senderIsBot: true }) })]);
      const binding = store.getConversation(conversation.id)!.bindings.find(value => value.endpointId === selected.id)!;
      store.updateBinding(conversation.id, binding.id, selected.id, ['bot:BPEER']);
      socket.receive(envelope('bot-only-chosen', 'message', { user: undefined, bot_id: 'BPEER', text: '<@UBOT> Explicitly selected work', thread_ts: selected.threadId, ts: '1000.2002' }));
      await vi.waitFor(() => expect(store.listRequests()).toHaveLength(2));
      store.setSourceAccess(open.id, { mode: 'mention' });
      socket.receive(envelope('bot-only-unmentioned', 'message', { user: undefined, bot_id: 'BPEER', text: 'No mention', ts: '1000.1004' }));
      socket.receive(envelope('bot-only-mentioned', 'message', { user: undefined, bot_id: 'BPEER', text: '<@UBOT> Mentioned', ts: '1000.1005' }));
      await vi.waitFor(() => expect(received).toHaveLength(7));
      expect(store.listRequests()).toHaveLength(3);
      expect(store.listRequests()[0].text).toBe('<@UBOT> Mentioned');
    } finally { store.close(); }
  });

  it('keeps bot-only posts passive if Slack did not provide the connected bot identity', async () => {
    const { socket, message } = await makeChannel({ api: method => method === 'auth.test'
      ? Response.json({ ok: true, team_id: 'TEXAMPLE', user_id: 'UBOT', team: 'Team' }) : undefined });
    socket.receive(envelope('bot-unresolved-owner', 'message', { user: undefined, bot_id: 'BPEER', text: '<@UBOT> Work' }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
    expect(vi.mocked(message).mock.calls[0][0]).toMatchObject({ sender: { id: 'bot:BPEER', isBot: true }, contextOnly: true });
  });

  it('sends only verified tool mentions in a separate mrkdwn section and keeps the body rich', async () => {
    const { channel, calls } = await makeChannel();
    const tool: Delivery = { ...delivery(), kind: 'message', requestId: undefined, operationId: 'operation',
      body: '**Result** <@UUNVALIDATED> @everyone', mentions: [{ id: 'UPEER', name: 'Untrusted caption', isBot: true }],
      origin: { ...delivery().origin, senderId: 'UBOT', senderName: 'Own agent', messageId: '' } };
    await channel.deliver(tool);
    const post = JSON.parse(String(calls.find(call => call.url.endsWith('/chat.postMessage'))!.init!.body));
    expect(post.blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: '<@UPEER>', verbatim: true } },
      { type: 'markdown', text: '**Result** @\u200bUUNVALIDATED @\u200beveryone' },
    ]);
    expect(post.text).not.toContain('<@UPEER>');
    expect(post.link_names).toBe(false);
    expect(channel.deliveryText(tool)).toBe('<@UPEER>\n\n**Result** @\u200bUUNVALIDATED @\u200beveryone');
    await expect(channel.deliver({ ...tool, mentions: [{ id: 'bot:BPEER', name: 'Agent', isBot: true }] })).rejects.toThrow(/адрес упоминания/);
    await channel.deliver({ ...tool, mentions: [] });
    const posts = calls.filter(call => call.url.endsWith('/chat.postMessage'));
    expect(posts).toHaveLength(2);
    expect(JSON.parse(String(posts[1].init!.body)).blocks).toEqual([{ type: 'markdown', text: '**Result** @\u200bUUNVALIDATED @\u200beveryone' }]);
  });

  it('keeps non-audio uploads as context while allowing a human voice task', async () => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('human-file', 'message', { text: '', subtype: 'file_share', files: [{ id: 'FPDF', name: 'Отчёт.pdf', mimetype: 'application/pdf' }] }));
    socket.receive(envelope('human-voice', 'message', { text: '', subtype: 'file_share', ts: '1000.1002', files: [{ id: 'FAUDIO', name: 'Сообщение.ogg', mimetype: 'audio/ogg', url_private_download: 'https://files.slack.com/files-pri/audio.ogg' }] }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(2));
    const received = vi.mocked(message).mock.calls.map(([value]) => value);
    expect(received[0]).toMatchObject({ contextOnly: true, text: '', slack: { payload: { files: [{ id: 'FPDF' }] } } });
    expect(received[0].audio).toBeUndefined();
    expect(received[1]).toMatchObject({ contextOnly: false, audio: { fileId: 'FAUDIO', mimeType: 'audio/ogg' } });
  });

  it.each([
    { name: 'native user', mention: true, blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'UBOT' }, { type: 'text', text: ' Проверь' }] }] }] },
    { name: 'native quote', mention: false, blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_quote', elements: [{ type: 'user', user_id: 'UBOT' }, { type: 'text', text: ' Проверь' }] }] }] },
    { name: 'preformatted', mention: false, blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_preformatted', elements: [{ type: 'user', user_id: 'UBOT' }, { type: 'text', text: ' Проверь' }] }] }] },
    { name: 'code style', mention: false, blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'UBOT', style: { code: true } }, { type: 'text', text: ' Проверь' }] }] }] },
    { name: 'markdown', mention: true, blocks: [{ type: 'markdown', text: '<@UBOT> Проверь' }] },
    { name: 'mrkdwn', mention: true, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '<@UBOT> Проверь' } }] },
    { name: 'quoted mrkdwn', mention: false, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '> <@UBOT> Проверь' } }] },
    { name: 'inline code', mention: false, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '`<@UBOT>` Проверь' } }] },
    { name: 'forwarded metadata', mention: false, blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Проверь' }] }], forwarded: { type: 'user', user_id: 'UBOT' } }] },
    { name: 'attachment', mention: false, attachments: [{ blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'UBOT' }, { type: 'text', text: ' Проверь' }] }] }] }] },
  ])('only accepts fresh rendered current-block mentions: $name', async ({ mention, ...payload }) => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('peer-native', 'message', { user: 'UPEER', bot_id: 'BPEER', text: '', ...payload }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
    expect(vi.mocked(message).mock.calls[0][0]).toMatchObject({ directMention: mention, contextOnly: false });
  });
});

describe('Slack origin-bound delivery', () => {
  it('sends into the original thread and disables mentions, parsing and unfurls', async () => {
    const { channel, calls } = await makeChannel();
    await expect(channel.deliver(delivery())).resolves.toBe('1000.2000');
    const sent = calls.find((call) => call.url.endsWith('/chat.postMessage'))!;
    expect(JSON.parse(String(sent.init?.body))).toMatchObject({
      channel: 'CEXAMPLE',
      thread_ts: '1000.1000',
      text: 'Пример @\u200beveryone &amp; ответ',
      blocks: [{ type: 'markdown', text: 'Пример @\u200beveryone & ответ' }],
      mrkdwn: false,
      parse: 'none',
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it('preserves Markdown tables and citations only for answer deliveries', async () => {
    const { channel, calls } = await makeChannel();
    const text = '| Файл |\n| --- |\n| Пример |\n:codex-file-citation{path="C:/Отчёт.md" purpose="source"}';
    await channel.deliver({ ...delivery(), body: text });
    await channel.deliver({ ...delivery(), kind: 'error', body: text });
    const posts = calls.filter(call => call.url.endsWith('/chat.postMessage')).map(call => JSON.parse(String(call.init?.body)));
    expect(posts[0].blocks).toEqual([{ type: 'markdown', text: text.replace(':codex-file-citation{path="C:/Отчёт.md" purpose="source"}', '`C:/Отчёт.md`') }]);
    expect(posts[1].blocks).toBeUndefined();
    expect(posts[1].text).toBe(text);
  });

  it('sets and clears only the original account/thread status without a status callback loop', async () => {
    const { channel, calls, status } = await makeChannel({ api: method => method === 'agents.sessions.setStatus' ? Response.json({ ok: true }) : undefined });
    const before = status.mock.calls.length;
    await channel.setThreadStatus(delivery().origin, 'processing');
    await channel.setThreadStatus(delivery().origin, 'active');
    const updates = calls.filter(call => call.url.endsWith('/agents.sessions.setStatus'));
    expect(updates.map(call => JSON.parse(String(call.init?.body)))).toEqual([{ channel_id: 'CEXAMPLE', thread_ts: '1000.1000', status: 'processing' }, { channel_id: 'CEXAMPLE', thread_ts: '1000.1000', status: 'active' }]);
    expect(updates.every(call => new Headers(call.init?.headers).get('content-type')?.startsWith('application/json'))).toBe(true);
    expect(status).toHaveBeenCalledTimes(before);
    await expect(channel.setThreadStatus(delivery('TOTHER:UBOT').origin, 'processing')).rejects.toThrow('Подключение Slack изменилось');
    expect(calls.filter(call => call.url.endsWith('/agents.sessions.setStatus'))).toHaveLength(2);
  });

  it('propagates a native status failure to its manager', async () => {
    const { channel } = await makeChannel({ api: method => method === 'agents.sessions.setStatus' ? Response.json({ ok: false, error: 'missing_scope' }) : undefined });
    await expect(channel.setThreadStatus(delivery().origin, 'processing')).rejects.toMatchObject({ retryable: false, uncertain: false });
  });

  it('reports a missing native Stop subscription once and clears it when fixed', async () => {
    let subscribed = false;
    const { channel, status } = await makeChannel({ api: method => method === 'agents.sessions.setStatus'
      ? Response.json({ ok: true, response_metadata: { warnings: subscribed ? [] : ['missing_agent_session_stopped_event_subscription'] } }) : undefined });
    const before = status.mock.calls.length;
    await channel.setThreadStatus(delivery().origin, 'processing');
    expect(channel.state.error).toContain('agent_session_stopped');
    await channel.setThreadStatus(delivery().origin, 'processing');
    expect(status).toHaveBeenCalledTimes(before + 1);
    subscribed = true;
    await channel.setThreadStatus(delivery().origin, 'active');
    expect(channel.state.error).toBeUndefined();
    expect(status).toHaveBeenCalledTimes(before + 2);
  });

  it('never sends a request through a different installation/account', async () => {
    const { channel, calls } = await makeChannel();
    await expect(
      channel.deliver(delivery('TOTHER:UOTHER')),
    ).rejects.toMatchObject({ retryable: false, uncertain: false });
    expect(calls.some((call) => call.url.endsWith('/chat.postMessage'))).toBe(
      false,
    );
  });

  it('classifies a lost send acknowledgement as uncertain, not an automatic retry', async () => {
    const { channel } = await makeChannel({
      postMessage: async () => {
        throw new TypeError('Synthetic connection reset');
      },
    });
    await expect(channel.deliver(delivery())).rejects.toMatchObject({
      retryable: false,
      uncertain: true,
    });
  });

  it('accepts an explicit 429 as safe to retry and respects Retry-After', async () => {
    const { channel } = await makeChannel({
      postMessage: async () =>
        new Response('', { status: 429, headers: { 'retry-after': '7' } }),
    });
    await expect(channel.deliver(delivery())).rejects.toMatchObject({
      retryable: true,
      uncertain: false,
      retryAfterMs: 7000,
    });
  });

  it('does not trust a successful response for a different destination', async () => {
    const { channel } = await makeChannel({
      postMessage: async () =>
        Response.json({ ok: true, ts: '1000.2000', channel: 'COTHER' }),
    });
    await expect(channel.deliver(delivery())).rejects.toMatchObject({
      retryable: false,
      uncertain: true,
    });
  });
});

describe('Slack private audio URL restrictions', () => {
  it.each([
    'http://files.slack.com/files-pri/example',
    'https://files.slack.com.evil.invalid/files-pri/example',
    'https://127.0.0.1/files-pri/example',
    'https://files.slack.com/files-pri/T00000000-F00000000/fixture-1984453',
    'https://files.slack.com/files-pri/T00000000-F00000000/fixture-9889589',
    'https://files.slack.com:8443/files-pri/example',
  ])('rejects unsafe URL before attaching a bot token: %s', async (url) => {
    const { channel, calls } = await makeChannel();
    const before = calls.length;
    await expect(
      channel.download(
        { platform: 'slack', name: 'example.ogg', url },
        '/tmp/unused-rele-audio-test',
      ),
    ).rejects.toBeInstanceOf(ChannelError);
    expect(calls).toHaveLength(before);
  });

  it('downloads only an allowed private file and forbids credential-bearing redirects', async () => {
    const { channel, calls } = await makeChannel();
    const directory = await mkdtemp(join(tmpdir(), 'rele-slack-test-'));
    files.push(directory);
    const file = join(directory, 'audio.ogg');
    await channel.download(
      {
        platform: 'slack',
        name: 'example.ogg',
        url: 'https://files.slack.com/files-pri/TEXAMPLE-FEXAMPLE/example.ogg',
        size: 3,
      },
      file,
    );
    expect([...(await readFile(file))]).toEqual([1, 2, 3]);
    const request = calls.at(-1)!;
    expect(request.init).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bearer SLACK_TOKEN_PLACEHOLDER_4051722' },
    });
  });
});
