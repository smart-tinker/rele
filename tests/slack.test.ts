import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { Delivery, InboundMessage } from '../src/shared/types.js';
import { SlackChannel } from '../src/server/channels/slack.js';
import {
  ChannelError,
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
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === 'https://slack.com/api/auth.test')
        return Response.json({
          ok: true,
          team_id: 'TEXAMPLE',
          user_id: 'UBOT',
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
          user: { id: 'UANNA', profile: { display_name: 'Анна (пример)' } },
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
    { message, endpoint: endpoints, action, status: vi.fn() },
    {
      fetch: fetcher,
      socket: () => {
        queueMicrotask(() => socket.emit('open'));
        return socket as unknown as WebSocket;
      },
    },
  );
  live.push(channel);
  await channel.start();
  return { channel, socket, calls, fetcher, endpoints, message, action };
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
    expect(received[0].text).toBe('Пример сообщения');
    await vi.waitFor(() => expect(endpoints).toHaveBeenCalled());
    const named = endpoints.mock.calls.at(-1)![0];
    expect(named.title).toBe('Пример сообщения');
    expect(named.subtitle).toBe('Пример команды · #example');
    expect(named.people).toContainEqual({ id: 'UANNA', name: 'Анна (пример)' });
  });

  it('ignores bot messages and another workspace without emitting a user request', async () => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('env-self', 'message', { user: 'UBOT' }));
    socket.receive(envelope('env-bot', 'message', { bot_id: 'BOTHER' }));
    const foreign = envelope('env-foreign');
    foreign.payload.team_id = 'TOTHER';
    socket.receive(foreign);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(message).not.toHaveBeenCalled();
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
      text: 'Пример &lt;@everyone&gt; &amp; ответ',
      mrkdwn: false,
      parse: 'none',
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
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
