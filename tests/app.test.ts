import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import {
  ConfigStore,
  defaultConfig,
  mergeConfig,
} from '../src/server/config.js';
import { Store } from '../src/server/store.js';
import type { Engine } from '../src/server/engine.js';
import type { Endpoint } from '../src/shared/types.js';
import { ChannelError, type Channel } from '../src/server/channels/common.js';

const panelToken = 'a'.repeat(64);
const telegramToken = '123456:synthetic_telegram_secret_123456';
const headers = {
  host: '127.0.0.1:3210',
  authorization: `Bearer ${panelToken}`,
};
const opened: Array<{ app: ReturnType<typeof createApp>; store: Store }> = [];
afterEach(async () => {
  for (const { app, store } of opened.splice(0)) {
    await app.close();
    store.close();
  }
});

function makeApp() {
  const store = new Store(':memory:');
  const config = new ConfigStore('unused-in-injection-tests');
  config.panelToken = panelToken;
  config.config = mergeConfig(defaultConfig, {
    telegram: { enabled: true, token: telegramToken },
    slack: {
      enabled: true,
      botToken: 'SLACK_TOKEN_PLACEHOLDER_4051722',
      appToken: 'SLACK_TOKEN_PLACEHOLDER_6612940',
    },
    codex: { token: 'synthetic-codex-secret' },
  });
  const engine = {
    channels: {} as Partial<Record<'telegram' | 'slack', Channel>>,
    cancel: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    reconcile: vi.fn().mockResolvedValue(undefined),
    retryDelivery: vi.fn(),
    resolveApproval: vi.fn().mockResolvedValue(undefined),
  };
  const codex = {
    listThreads: vi.fn().mockResolvedValue([
      {
        id: 'thread-example',
        name: 'Пример проекта',
        cwd: '/work/example',
        preview: '',
        updatedAt: 0,
      },
      {
        id: 'thread-other',
        name: 'Другой пример',
        cwd: '/work/other',
        preview: '',
        updatedAt: 0,
      },
    ]),
    connect: vi.fn().mockResolvedValue(undefined),
    status: () => ({
      configured: true,
      connected: true,
      queueSupported: true,
      desktopVerified: false,
    }),
  };
  const configure = vi.fn().mockImplementation(async (next) => {
    config.config = next;
  });
  let currentCodex = codex;
  const shutdown = vi.fn().mockResolvedValue(undefined);
  const discovery = vi.fn().mockResolvedValue({ installations: [], issues: [{ code: 'not-found', message: 'Codex не найден.' }] });
  const app = createApp({
    store,
    config,
    engine: engine as unknown as Engine,
    codex: () => currentCodex,
    configure,
    version: '0.1.0-test',
    shutdown,
    discoverCodex: discovery,
  });
  opened.push({ app, store });
  const endpoint: Endpoint = {
    id: 'telegram-example',
    platform: 'telegram',
    accountId: 'bot-example',
    chatId: 'chat-example',
    threadId: 'topic-example',
    title: 'Пример чата',
    subtitle: 'Пример темы',
    people: [{ id: 'sender-anna', name: 'Анна (пример)' }],
    updatedAt: '2026-10-18T20:00:00Z',
  };
  store.upsertEndpoint(endpoint);
  return { app, store, config, engine, codex, configure, endpoint, shutdown, discovery, replaceCodex: () => { currentCodex = { ...codex }; } };
}

describe('installed application lifecycle', () => {
  it('exchanges an authenticated launcher link only once, with the same local origin boundary', async () => {
    const { app } = makeApp();
    const local = { host: headers.host };
    expect((await app.inject({ method: 'POST', url: '/api/session/launch-token', headers: local })).statusCode).toBe(401);
    const minted = await app.inject({ method: 'POST', url: '/api/session/launch-token', headers });
    expect(minted.statusCode).toBe(200);
    expect(minted.body).not.toContain(panelToken);
    const { token } = minted.json();
    const request = { method: 'POST' as const, url: '/api/session/launch', headers: local, payload: { token } };
    expect((await app.inject({ ...request, headers: { ...local, origin: 'https://example.com' } })).statusCode).toBe(403);
    const exchanged = await app.inject(request);
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.json()).toEqual({ key: panelToken });
    expect(exchanged.headers['cache-control']).toBe('no-store');
    expect((await app.inject(request)).statusCode).toBe(401);
    expect((await app.inject({ ...request, payload: { token: panelToken } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/session/launch', headers: local })).statusCode).toBe(401);
  });

  it('expires a launcher link after one minute', async () => {
    const { app } = makeApp();
    const minted = await app.inject({ method: 'POST', url: '/api/session/launch-token', headers });
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    try {
      const result = await app.inject({ method: 'POST', url: '/api/session/launch', headers: { host: headers.host }, payload: { token: minted.json().token } });
      expect(result.statusCode).toBe(401);
      expect(result.body).not.toContain(panelToken);
    } finally { now.mockRestore(); }
  });

  it('protects discovery, process identity and graceful shutdown with the existing panel key', async () => {
    const { app, shutdown, discovery } = makeApp();
    for (const [method, url] of [['GET', '/api/instance'], ['GET', '/api/codex/discovery'], ['POST', '/api/shutdown']] as const) {
      expect((await app.inject({ method, url, headers: { host: headers.host } })).statusCode).toBe(401);
    }
    expect(shutdown).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
    expect((await app.inject({ url: '/api/instance', headers })).json()).toEqual({ pid: process.pid, version: '0.1.0-test' });
    expect((await app.inject({ url: '/api/codex/discovery', headers })).json().issues[0].code).toBe('not-found');
    expect(discovery).toHaveBeenCalledOnce();
    const response = await app.inject({ method: 'POST', url: '/api/shutdown', headers });
    expect(response.json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  });
});

describe('local panel request boundary', () => {
  it('exposes only a minimal unauthenticated health response', async () => {
    const { app } = makeApp();
    const response = await app.inject({
      url: '/api/health',
      headers: { host: headers.host },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, version: '0.1.0-test' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each(['/api/state', '/api/threads', '/api/catalog/slack/chats', '/api/catalog/slack/threads?chatId=CEXAMPLE', '/api/catalog/slack/people?endpointId=example', '/api/catalog/telegram', '/api/unknown', '/api'])(
    'requires bearer authentication for %s',
    async (url) => {
      const { app } = makeApp();
      const response = await app.inject({
        url,
        headers: { host: headers.host },
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it.each([
    'rele.evil.invalid',
    'localhost.evil.invalid:3210',
    'user@localhost:3210',
    '127.0.0.1.evil.invalid:3210',
  ])('rejects Host rebinding even with a valid bearer: %s', async (host) => {
    const { app, configure } = makeApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { ...headers, host, 'x-forwarded-host': headers.host },
      payload: { telegram: { enabled: false } },
    });
    expect(response.statusCode).toBe(403);
    expect(configure).not.toHaveBeenCalled();
  });

  it.each(['https://evil.invalid', 'null', 'http://localhost:3210'])(
    'rejects a different Origin on configuration writes: %s',
    async (origin) => {
      const { app, configure } = makeApp();
      const response = await app.inject({
        method: 'PUT',
        url: '/api/config',
        headers: { ...headers, origin },
        payload: { telegram: { enabled: false } },
      });
      expect(response.statusCode).toBe(403);
      expect(configure).not.toHaveBeenCalled();
    },
  );

  it('accepts the same local Origin, sets security headers, and never sends configured secrets', async () => {
    const { app } = makeApp();
    const response = await app.inject({
      url: '/api/state',
      headers: { ...headers, origin: `http://${headers.host}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    expect(response.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    for (const secret of [
      panelToken,
      telegramToken,
      'SLACK_TOKEN_PLACEHOLDER_4051722',
      'SLACK_TOKEN_PLACEHOLDER_6612940',
      'synthetic-codex-secret',
    ])
      expect(response.body).not.toContain(secret);
    expect(response.json().config.telegram).toEqual({
      enabled: true,
      tokenConfigured: true,
    });
    expect(response.json().codex.desktopVerified).toBe(false);
  });

  it('does not accept a panel token in a query string', async () => {
    const { app } = makeApp();
    const response = await app.inject({
      url: `/api/state?token=${panelToken}`,
      headers: { host: headers.host },
    });
    expect(response.statusCode).toBe(401);
  });

  it('redacts configured secrets from server error responses', async () => {
    const { app, codex } = makeApp();
    codex.listThreads.mockRejectedValueOnce(
      new Error(`Synthetic failure ${telegramToken} ${panelToken}`),
    );
    const response = await app.inject({ url: '/api/threads', headers });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(telegramToken);
    expect(response.body).not.toContain(panelToken);
    expect(response.json().error).toContain('[скрыто]');
  });
});

describe('named binding API', () => {
  it('keeps local chat aliases across messenger name updates and can reset to the latest source name', async () => {
    const { app, store, endpoint } = makeApp();
    const path = `/api/endpoints/${endpoint.id}`;
    const saved = await app.inject({
      method: 'PATCH',
      url: path,
      headers,
      payload: { title: 'Моя старая тема' },
    });
    expect(saved.statusCode).toBe(200);
    expect(store.getEndpoint(endpoint.id)?.title).toBe(endpoint.title);
    store.upsertEndpoint({ ...endpoint, title: 'Новое имя из мессенджера' });
    const aliased = await app.inject({ url: '/api/state', headers });
    expect(aliased.json().endpoints[0].title).toBe('Моя старая тема');
    const reset = await app.inject({
      method: 'PATCH',
      url: path,
      headers,
      payload: { title: '' },
    });
    expect(reset.statusCode).toBe(200);
    const current = await app.inject({ url: '/api/state', headers });
    expect(current.json().endpoints[0].title).toBe('Новое имя из мессенджера');
    const unknown = await app.inject({
      method: 'PATCH',
      url: '/api/endpoints/unknown',
      headers,
      payload: { title: 'Пример' },
    });
    expect(unknown.statusCode).toBe(404);
    const invalid = await app.inject({
      method: 'PATCH',
      url: path,
      headers,
      payload: { title: 'Пример', chatId: 'replacement' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(store.getEndpoint(endpoint.id)?.chatId).toBe(endpoint.chatId);
  });

  it('creates from an observed Codex thread and only known allowed senders', async () => {
    const { app, store } = makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers,
      payload: {
        name: 'Мой пример',
        threadId: 'thread-example',
        cwd: '/work/example',
        bindings: [
          {
            platform: 'telegram',
            endpointId: 'telegram-example',
            allowedSenderIds: ['sender-anna', 'sender-anna'],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const conversation = response.json().conversation;
    expect(conversation).toMatchObject({
      name: 'Мой пример',
      threadId: 'thread-example',
      cwd: '/work/example',
      paused: false,
    });
    expect(conversation.bindings[0].allowedSenderIds).toEqual(['sender-anna']);
    expect(store.listConversations()).toHaveLength(1);
  });

  it.each([
    { name: 'Пример', threadId: 'thread-missing', cwd: '/work/example' },
    { name: 'Пример', threadId: 'thread-example', cwd: '/unobserved/path' },
    {
      name: 'Пример',
      threadId: 'thread-example',
      cwd: '/work/example',
      bindings: [
        {
          platform: 'telegram',
          endpointId: 'unknown-chat',
          allowedSenderIds: ['sender-anna'],
        },
      ],
    },
    {
      name: 'Пример',
      threadId: 'thread-example',
      cwd: '/work/example',
      bindings: [
        {
          platform: 'slack',
          endpointId: 'telegram-example',
          allowedSenderIds: ['sender-anna'],
        },
      ],
    },
    {
      name: 'Пример',
      threadId: 'thread-example',
      cwd: '/work/example',
      bindings: [
        {
          platform: 'telegram',
          endpointId: 'telegram-example',
          allowedSenderIds: ['unknown-person'],
        },
      ],
    },
    {
      name: 'Пример',
      threadId: 'thread-example',
      cwd: '/work/example',
      arbitrary: true,
    },
  ])(
    'rejects an unobserved or malformed binding without leaving partial state: %j',
    async (payload) => {
      const { app, store } = makeApp();
      const response = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(store.listConversations()).toEqual([]);
    },
  );

  it('rolls back a second conversation when its external endpoint is already bound', async () => {
    const { app, store } = makeApp();
    const bindings = [
      {
        platform: 'telegram',
        endpointId: 'telegram-example',
        allowedSenderIds: ['sender-anna'],
      },
    ];
    await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers,
      payload: {
        name: 'Первый пример',
        threadId: 'thread-example',
        cwd: '/work/example',
        bindings,
      },
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers,
      payload: {
        name: 'Второй пример',
        threadId: 'thread-other',
        cwd: '/work/other',
        bindings,
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(store.listConversations()).toHaveLength(1);
  });

  it('updates the existing binding only after validating the platform and sender list', async () => {
    const { app, store } = makeApp();
    const conversation = store.createConversation({
      name: 'Пример',
      threadId: 'thread-example',
      cwd: '/work/example',
    });
    const path = `/api/conversations/${conversation.id}/bindings/telegram`;
    const valid = await app.inject({
      method: 'PUT',
      url: path,
      headers,
      payload: {
        endpointId: 'telegram-example',
        allowedSenderIds: ['sender-anna'],
      },
    });
    expect(valid.statusCode).toBe(200);
    const invalid = await app.inject({
      method: 'PUT',
      url: path,
      headers,
      payload: {
        endpointId: 'telegram-example',
        allowedSenderIds: ['unknown-person'],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(
      store.getConversation(conversation.id)?.bindings[0].allowedSenderIds,
    ).toEqual(['sender-anna']);
    const paused = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conversation.id}`,
      headers,
      payload: { name: 'Новое имя', paused: true },
    });
    expect(paused.json().conversation).toMatchObject({
      name: 'Новое имя',
      paused: true,
    });
    const removed = await app.inject({ method: 'DELETE', url: path, headers });
    expect(removed.statusCode).toBe(200);
    expect(store.getConversation(conversation.id)?.bindings).toEqual([]);
  });
});

describe('configuration and execution action API', () => {
  it('keeps configuration responses write-only for existing and replacement tokens', async () => {
    const { app, config, configure } = makeApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/config',
      headers,
      payload: { telegram: { token: '', enabled: false } },
    });
    expect(response.statusCode).toBe(200);
    expect(configure).toHaveBeenCalledOnce();
    expect(config.config.telegram.token).toBe(telegramToken);
    expect(response.json()).toMatchObject({
      config: { telegram: { enabled: false, tokenConfigured: true } },
    });
    expect(response.body).not.toContain(telegramToken);
  });

  it('does not persist a rejected configuration change', async () => {
    const { app, configure } = makeApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/config',
      headers,
      payload: {
        codex: {
          transport: 'websocket',
          endpoint: 'ws://remote.example.invalid',
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(configure).not.toHaveBeenCalled();
  });

  it('prevents two concurrent configuration transactions', async () => {
    const { app, configure } = makeApp();
    let release!: () => void;
    configure.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = app
      .inject({
        method: 'PUT',
        url: '/api/config',
        headers,
        payload: { telegram: { enabled: false } },
      })
      .then((response) => response);
    await vi.waitFor(() => expect(configure).toHaveBeenCalledOnce());
    const second = await app.inject({
      method: 'PUT',
      url: '/api/config',
      headers,
      payload: { telegram: { enabled: false } },
    });
    release();
    expect(second.statusCode).toBe(409);
    expect((await first).statusCode).toBe(200);
  });

  it('passes only a validated approval decision and answer map to the engine', async () => {
    const { app, engine } = makeApp();
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/approvals/approval-example/resolve',
      headers,
      payload: { decision: 'accept', answers: { question: [42] } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(engine.resolveApproval).not.toHaveBeenCalled();
    const valid = await app.inject({
      method: 'POST',
      url: '/api/approvals/approval-example/resolve',
      headers,
      payload: { decision: 'accept', answers: { question: ['Пример ответа'] } },
    });
    expect(valid.statusCode).toBe(200);
    expect(engine.resolveApproval).toHaveBeenCalledWith(
      'approval-example',
      'accept',
      { question: ['Пример ответа'] },
    );
  });

  it('delegates cancel, reconcile and resume without substituting a fresh agent task', async () => {
    const { app, engine } = makeApp();
    for (const operation of ['cancel', 'reconcile', 'resume'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/requests/request-example/${operation}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(engine[operation]).toHaveBeenCalledWith('request-example');
    }
    const delivery = await app.inject({
      method: 'POST',
      url: '/api/deliveries/delivery-example/retry',
      headers,
    });
    expect(delivery.statusCode).toBe(200);
    expect(engine.retryDelivery).toHaveBeenCalledWith('delivery-example');
  });
});

describe('conversation discovery API', () => {
  function slack(f: ReturnType<typeof makeApp>) {
    const endpoint: Endpoint = { ...f.endpoint, id: 'slack-example', platform: 'slack', accountId: 'TEXAMPLE:UBOT', chatId: 'CEXAMPLE', threadId: '1700000000.001000', chatTitle: '#example', available: true, people: [] };
    const channel = {
      state: { configured: true, connected: true, accountId: endpoint.accountId },
      start: vi.fn(), stop: vi.fn(), deliver: vi.fn(), download: vi.fn(),
      listChats: vi.fn().mockResolvedValue({ items: [{ id: endpoint.chatId, name: '#example', subtitle: 'Команда', kind: 'channel' }], nextCursor: 'next-chats' }),
      listThreads: vi.fn().mockImplementation(async () => ({ items: [f.store.upsertEndpoint(endpoint)], nextCursor: 'next-threads' })),
      listPeople: vi.fn().mockResolvedValue({ items: [{ id: 'new-sender', name: 'Елена' }], nextCursor: 'next-people' }),
    };
    f.engine.channels.slack = channel;
    return { channel, endpoint };
  }

  it('loads existing Slack conversations and people without creating a Codex request', async () => {
    const f = makeApp();
    const { channel, endpoint } = slack(f);
    const chats = await f.app.inject({ url: '/api/catalog/slack/chats?cursor=page-2', headers });
    expect(chats.statusCode).toBe(200);
    expect(chats.json()).toMatchObject({ items: [{ name: '#example' }], nextCursor: 'next-chats' });
    expect(channel.listChats).toHaveBeenCalledWith('page-2');
    f.store.setMeta(`endpoint-alias:${endpoint.id}`, 'Понятное имя обсуждения');
    const threads = await f.app.inject({ url: '/api/catalog/slack/threads?chatId=CEXAMPLE&cursor=older', headers });
    expect(threads.json()).toMatchObject({ items: [{ id: endpoint.id, title: 'Понятное имя обсуждения' }], nextCursor: 'next-threads' });
    expect(channel.listThreads).toHaveBeenCalledWith('CEXAMPLE', 'older');
    const people = await f.app.inject({ url: `/api/catalog/slack/people?endpointId=${endpoint.id}`, headers });
    expect(people.statusCode).toBe(200);
    expect(channel.listPeople).toHaveBeenCalledWith('CEXAMPLE', undefined);
    expect(f.store.getEndpoint(endpoint.id)?.people).toEqual([{ id: 'new-sender', name: 'Елена' }]);
    expect(f.store.listRequests()).toEqual([]);
    const binding = await f.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: {
      name: 'Каталог', threadId: 'thread-example', cwd: '/work/example',
      bindings: [{ platform: 'slack', endpointId: endpoint.id, allowedSenderIds: ['new-sender'] }],
    } });
    expect(binding.statusCode).toBe(200);
    expect(binding.json().conversation.bindings[0].allowedSenderIds).toEqual(['new-sender']);
  });

  it('validates catalog arguments and never reads people of another connected bot', async () => {
    const f = makeApp();
    expect((await f.app.inject({ url: '/api/catalog/slack/chats', headers })).statusCode).toBe(503);
    const { channel, endpoint } = slack(f);
    for (const url of ['/api/catalog/slack/chats?unknown=true', '/api/catalog/slack/threads', '/api/catalog/slack/people?endpointId=missing', '/api/catalog/slack/chats?cursor=']) {
      expect((await f.app.inject({ url, headers })).statusCode).toBeGreaterThanOrEqual(400);
    }
    f.store.upsertEndpoint({ ...endpoint, accountId: 'OTHER:BOT' });
    expect((await f.app.inject({ url: `/api/catalog/slack/people?endpointId=${endpoint.id}`, headers })).statusCode).toBe(404);
    expect(channel.listPeople).not.toHaveBeenCalled();
    expect(channel.listChats).not.toHaveBeenCalled();
  });

  it('discards an old catalog response after the Slack connection is replaced', async () => {
    const f = makeApp();
    const { channel, endpoint } = slack(f);
    f.store.upsertEndpoint(endpoint);
    let resolve!: (page: { items: Array<{ id: string; name: string }> }) => void;
    channel.listPeople.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = f.app.inject({ url: `/api/catalog/slack/people?endpointId=${endpoint.id}`, headers }).then(response => response);
    await vi.waitFor(() => expect(channel.listPeople).toHaveBeenCalledOnce());
    f.engine.channels.slack = { ...channel, state: { ...channel.state, accountId: 'OTHER:BOT' } };
    resolve({ items: [{ id: 'stale-user', name: 'Из прошлого подключения' }] });
    expect((await pending).statusCode).toBe(409);
    expect(f.store.getEndpoint(endpoint.id)?.people).toEqual([]);
  });

  it('passes Slack retry timing to the panel without automatically retrying the read', async () => {
    const f = makeApp();
    const { channel } = slack(f);
    channel.listChats.mockRejectedValueOnce(new ChannelError('Slack ограничил частоту запросов.', true, false, 45_000, 429));
    const response = await f.app.inject({ url: '/api/catalog/slack/chats', headers });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('45');
    expect(response.json()).toMatchObject({ retryAfterSeconds: 45, error: expect.stringContaining('45 с') });
    expect(channel.listChats).toHaveBeenCalledOnce();
  });

  it('exposes Telegram registration instructions without sending a message', async () => {
    const f = makeApp();
    const { channel } = slack(f);
    f.engine.channels.telegram = { ...channel, discoveryInfo: () => ({ botUrl: 'https://t.me/example_bot?start=rele_chats', command: '/rele_register@example_bot' }) };
    expect((await f.app.inject({ url: '/api/catalog/telegram', headers })).json()).toEqual({ botUrl: 'https://t.me/example_bot?start=rele_chats', command: '/rele_register@example_bot' });
    expect(channel.deliver).not.toHaveBeenCalled();
    expect(f.store.listRequests()).toEqual([]);
  });

  it('offers archived Codex metadata for inspection but refuses to bind it', async () => {
    const f = makeApp();
    const archive = await f.app.inject({ url: '/api/threads?archived=true', headers });
    expect(archive.statusCode).toBe(200);
    expect(f.codex.listThreads).toHaveBeenLastCalledWith({ archived: true });
    expect((await f.app.inject({ url: '/api/threads?archived=maybe', headers })).statusCode).toBe(400);
    f.codex.listThreads.mockResolvedValueOnce([{ id: 'thread-example', name: 'Архив', cwd: '/work/example', preview: '', updatedAt: 0, archived: true } as never]);
    const binding = await f.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: { name: 'Архив', threadId: 'thread-example', cwd: '/work/example' } });
    expect(binding.statusCode).toBe(400);
    expect(f.store.listConversations()).toEqual([]);
  });

  it.each(['GET', 'POST'])('rejects stale Codex metadata after a runtime change during %s', async method => {
    const f = makeApp();
    let resolve!: (threads: Awaited<ReturnType<typeof f.codex.listThreads>>) => void;
    f.codex.listThreads.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = (method === 'GET'
      ? f.app.inject({ url: '/api/threads', headers })
      : f.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: { name: 'Смена runtime', threadId: 'thread-example', cwd: '/work/example' } })
    ).then(response => response);
    await vi.waitFor(() => expect(f.codex.listThreads).toHaveBeenCalledOnce());
    f.replaceCodex();
    resolve([{ id: 'thread-example', name: 'Старый runtime', cwd: '/work/example', preview: '', updatedAt: 0 }]);
    expect((await pending).statusCode).toBe(409);
    expect(f.store.listConversations()).toEqual([]);
  });

  it('binds an observed General Telegram topic using the existing empty thread route', async () => {
    const f = makeApp();
    f.store.upsertEndpoint({ ...f.endpoint, id: 'telegram-general', threadId: '', isForum: true, generalTopic: true, title: 'Команда / Общая тема' });
    const response = await f.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: {
      name: 'Общая', threadId: 'thread-example', cwd: '/work/example',
      bindings: [{ platform: 'telegram', endpointId: 'telegram-general', allowedSenderIds: ['sender-anna'] }],
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json().conversation.bindings[0].endpointId).toBe('telegram-general');
  });

  it.each([
    { available: false },
    { isForum: true, threadId: '' },
    { accountId: 'previous-bot' },
  ])('rejects unavailable or incompatible Telegram targets: %j', async patch => {
    const f = makeApp();
    const { channel } = slack(f);
    f.engine.channels.telegram = { ...channel, state: { configured: true, connected: true, accountId: f.endpoint.accountId } };
    f.store.upsertEndpoint({ ...f.endpoint, id: 'unavailable-endpoint', chatId: 'another-chat', ...patch });
    const response = await f.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: {
      name: 'Недоступная связка', threadId: 'thread-example', cwd: '/work/example',
      bindings: [{ platform: 'telegram', endpointId: 'unavailable-endpoint', allowedSenderIds: ['sender-anna'] }],
    } });
    expect(response.statusCode).toBe(400);
    expect(f.store.listConversations()).toEqual([]);
  });
});
