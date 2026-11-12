import { syntheticSlackAppToken, syntheticSlackBotToken } from './fixtures/slack.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { createApp } from '../src/server/app.js';
import {
  ConfigStore,
  defaultConfig,
  mergeConfig,
} from '../src/server/config.js';
import { Store } from '../src/server/store.js';
import type { Engine } from '../src/server/engine.js';
import type { Endpoint } from '../src/shared/types.js';
import { MessageToolValidationError } from '../src/shared/message-tool.js';
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
      botToken: syntheticSlackBotToken,
      appToken: syntheticSlackAppToken,
    },
    codex: { token: 'synthetic-codex-secret' },
  });
  const engine = Object.assign(new EventEmitter(), {
    channels: {} as Partial<Record<'telegram' | 'slack', Channel>>,
    targetFingerprint: vi.fn().mockReturnValue('synthetic-app-target'),
    cancel: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    reconcile: vi.fn().mockResolvedValue(undefined),
    retryDelivery: vi.fn(),
    messageTool: vi.fn().mockResolvedValue({ operationId: 'synthetic-operation', status: 'pending' }),
    sendInitialMessage: vi.fn().mockReturnValue({ status: 'queued', operationId: 'initial-operation' }),
    resolveApproval: vi.fn().mockResolvedValue(undefined),
  });
  const codex = {
    runtimeInfo: vi.fn().mockReturnValue({ platformOs: 'linux', platformFamily: 'unix', codexHome: '/home/example/.codex', userAgent: 'test' }),
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
    isVerifiedVersion: vi.fn().mockReturnValue(true),
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
  const desktopIntegration = {
    status: vi.fn().mockResolvedValue({ available: true, enabled: false, lastCheckFailed: true }),
    shouldRetry: vi.fn().mockResolvedValue(false),
    setEnabled: vi.fn().mockImplementation(async (enabled: boolean) => ({ available: true, enabled, lastCheckFailed: false })),
  };
  const codexUpdate = {
    status: vi.fn().mockResolvedValue({ available: true, phase: 'available', currentVersion: '0.164.0-alpha.11.1', installedVersion: '0.165.0-alpha.1.2' }),
    prepare: vi.fn().mockResolvedValue({ available: true, phase: 'ready', pendingVersion: '0.165.0-alpha.1.2' }),
    apply: vi.fn().mockResolvedValue({ available: true, phase: 'current', currentVersion: '0.165.0-alpha.1.2' }),
  };
  const app = createApp({
    store,
    config,
    engine: engine as unknown as Engine,
    codex: () => currentCodex,
    configure,
    version: '0.1.0-test',
    shutdown,
    discoverCodex: discovery,
    desktopIntegration,
    codexUpdate,
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
  return { app, store, config, engine, codex, configure, endpoint, shutdown, discovery, desktopIntegration, codexUpdate, replaceCodex: () => { currentCodex = { ...codex }; } };
}

describe('shared Codex update', () => {
  it('requires panel authorization and rejects executable paths supplied by the caller', async () => {
    const f = makeApp();
    const url = '/api/codex/update';
    expect((await f.app.inject({ url })).statusCode).toBe(401);
    expect((await f.app.inject({ url, method: 'POST', payload: {} })).statusCode).toBe(401);
    expect(f.codexUpdate.status).not.toHaveBeenCalled();
    expect((await f.app.inject({ url, headers })).json()).toMatchObject({ phase: 'available' });
    expect((await f.app.inject({ url, method: 'POST', headers, payload: { executable: '/untrusted/native' } })).statusCode).toBe(400);
    expect(f.codexUpdate.prepare).not.toHaveBeenCalled();
    expect((await f.app.inject({ url, method: 'POST', headers, payload: {} })).json()).toMatchObject({ phase: 'ready' });
    expect(f.codexUpdate.prepare).toHaveBeenCalledOnce();
    expect(f.codex.connect).not.toHaveBeenCalled();
    expect(f.engine.cancel).not.toHaveBeenCalled();
  });

  it('requires an explicit closed-client confirmation and serializes apply with native controls and shutdown', async () => {
    const f = makeApp(), url = '/api/codex/update';
    for (const payload of [{ action: 'apply' }, { action: 'apply', clientsClosed: false }, { action: 'unknown', clientsClosed: true }, { clientsClosed: true }])
      expect((await f.app.inject({ url, method: 'POST', headers, payload })).statusCode).toBe(400);
    expect(f.codexUpdate.apply).not.toHaveBeenCalled();
    let release!: () => void;
    f.codexUpdate.apply.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { available: true, phase: 'current', currentVersion: '0.165.0-alpha.1.2' };
    });
    const pending = f.app.inject({ url, method: 'POST', headers, payload: { action: 'apply', clientsClosed: true } }).then(value => value);
    await vi.waitFor(() => expect(f.codexUpdate.apply).toHaveBeenCalledOnce());
    for (const endpoint of ['/api/codex/connect', '/api/shutdown', '/api/requests/example/cancel', '/api/requests/example/resume', '/api/requests/example/reconcile', '/api/approvals/example/resolve', '/api/conversations'])
      expect((await f.app.inject({ url: endpoint, method: 'POST', headers, payload: {} })).statusCode).toBe(409);
    expect(f.engine.resume).not.toHaveBeenCalled(); expect(f.engine.cancel).not.toHaveBeenCalled();
    expect(f.codexUpdate.prepare).not.toHaveBeenCalled();
    release(); expect((await pending).json()).toMatchObject({ phase: 'current' });
    expect((await f.app.inject({ url: '/api/codex/connect', method: 'POST', headers })).statusCode).toBe(200);
  });

  it('serializes preparation with connection changes while leaving status readable and releases the guard after failure', async () => {
    const f = makeApp();
    let release!: () => void;
    f.codexUpdate.prepare.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      throw new Error('Synthetic preparation failure');
    });
    const pending = f.app.inject({ url: '/api/codex/update', method: 'POST', headers, payload: {} }).then(value => value);
    await vi.waitFor(() => expect(f.codexUpdate.prepare).toHaveBeenCalledOnce());
    for (const request of [
      { url: '/api/codex/update', payload: {} },
      { url: '/api/codex/connect' },
      { url: '/api/config', method: 'PUT' as const, payload: { codex: { transport: 'shared' } } },
      { url: '/api/codex/desktop-integration', payload: { enabled: false } },
    ]) expect((await f.app.inject({ method: 'POST', ...request, headers })).statusCode).toBe(409);
    expect((await f.app.inject({ url: '/api/codex/update', headers })).statusCode).toBe(200);
    release(); expect((await pending).statusCode).toBe(400);
    expect((await f.app.inject({ url: '/api/codex/connect', method: 'POST', headers })).statusCode).toBe(200);
  });
});

describe('initial Rele instruction', () => {
  it('requires panel authorization and a known conversation, rejects unexpected content and queues one operation', async () => {
    const f = makeApp();
    const conversation = f.store.createConversation({ name: 'Example', threadId: 'thread-example', cwd: '/work/example' });
    const url = `/api/conversations/${conversation.id}/initial-message`;
    expect((await f.app.inject({ method: 'POST', url, headers: { host: headers.host } })).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'POST', url: '/api/conversations/unknown/initial-message', headers })).statusCode).toBe(404);
    expect((await f.app.inject({ method: 'POST', url, headers, payload: { text: 'override' } })).statusCode).toBe(400);
    expect(f.engine.sendInitialMessage).not.toHaveBeenCalled();
    const result = await f.app.inject({ method: 'POST', url, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ status: 'queued', operationId: 'initial-operation' });
    expect(f.engine.sendInitialMessage).toHaveBeenCalledExactlyOnceWith(conversation.id);
  });
});

describe('explicit Desktop integration controls', () => {
  it('authenticates reads and writes, validates the action and never enables integration while merely saving shared mode', async () => {
    const f = makeApp();
    const route = '/api/codex/desktop-integration';
    expect((await f.app.inject({ url: route })).statusCode).toBe(401);
    expect((await f.app.inject({ url: route, method: 'POST', payload: { enabled: true } })).statusCode).toBe(401);
    expect(f.desktopIntegration.status).not.toHaveBeenCalled();
    expect((await f.app.inject({ url: route, headers })).json()).toEqual({ available: true, enabled: false, lastCheckFailed: true });
    for (const payload of [{ enabled: 'true' }, { enabled: true, executable: 'other' }, {}]) {
      expect((await f.app.inject({ url: route, method: 'POST', headers, payload })).statusCode).toBe(400);
    }
    f.config.config.codex = { transport: 'websocket', executable: 'old-explicit-codex', endpoint: 'ws://127.0.0.1:4500' };
    expect((await f.app.inject({ url: route, method: 'POST', headers, payload: { enabled: true } })).statusCode).toBe(400);
    expect(f.desktopIntegration.setEnabled).not.toHaveBeenCalled();
    expect((await f.app.inject({ url: '/api/config', method: 'PUT', headers, payload: { codex: { transport: 'shared' } } })).statusCode).toBe(200);
    expect(f.desktopIntegration.setEnabled).not.toHaveBeenCalled();
    f.codex.status = () => ({ configured: true, connected: false, queueSupported: false, desktopVerified: false });
    expect((await f.app.inject({ url: route, method: 'POST', headers, payload: { enabled: true } })).json()).toEqual({ available: true, enabled: true, lastCheckFailed: false });
    expect(f.desktopIntegration.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.codex.connect).not.toHaveBeenCalled();
    expect(f.engine.cancel).not.toHaveBeenCalled();
  });

  it('serializes config, connect and integration actions, releases the guard after failure and permits explicit disable', async () => {
    const f = makeApp();
    let release!: () => void;
    f.desktopIntegration.setEnabled.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      throw new Error('Synthetic check failed');
    });
    const pending = f.app.inject({ url: '/api/codex/desktop-integration', method: 'POST', headers, payload: { enabled: true } }).then(response => response);
    await vi.waitFor(() => expect(f.desktopIntegration.setEnabled).toHaveBeenCalledOnce());
    for (const request of [
      { url: '/api/config', method: 'PUT' as const, payload: { codex: { transport: 'shared' } } },
      { url: '/api/codex/connect', method: 'POST' as const },
      { url: '/api/codex/desktop-integration', method: 'POST' as const, payload: { enabled: false } },
    ]) expect((await f.app.inject({ ...request, headers })).statusCode).toBe(409);
    expect(f.configure).not.toHaveBeenCalled();
    release(); expect((await pending).statusCode).toBe(400);
    f.config.config.codex.transport = 'websocket';
    expect((await f.app.inject({ url: '/api/codex/desktop-integration', method: 'POST', headers, payload: { enabled: false } })).statusCode).toBe(200);
    expect(f.desktopIntegration.setEnabled).toHaveBeenLastCalledWith(false);

    f.configure.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    const save = f.app.inject({ url: '/api/config', method: 'PUT', headers, payload: { codex: { transport: 'shared' } } }).then(response => response);
    await vi.waitFor(() => expect(f.configure).toHaveBeenCalledOnce());
    expect((await f.app.inject({ url: '/api/codex/desktop-integration', method: 'POST', headers, payload: { enabled: false } })).statusCode).toBe(409);
    release(); expect((await save).statusCode).toBe(200);
  });
});

describe('pending automatic Desktop integration', () => {
  it('retries a pending choice once after readiness and removes its listener on close', async () => {
    const f = makeApp();
    f.desktopIntegration.shouldRetry.mockResolvedValue(true);
    await f.app.ready();
    await vi.waitFor(() => expect(f.desktopIntegration.setEnabled).toHaveBeenCalledExactlyOnceWith(true, true));
    for (let i = 0; i < 3; i++) f.engine.emit('change');
    expect((await f.app.inject({ url: '/api/codex/desktop-integration', headers })).statusCode).toBe(200);
    expect((await f.app.inject({ url: '/api/state', headers })).statusCode).toBe(200);
    expect(f.desktopIntegration.setEnabled).toHaveBeenCalledOnce();
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.codex.connect).not.toHaveBeenCalled();
    expect(f.engine.listenerCount('change')).toBe(1);
    await f.app.close();
    expect(f.engine.listenerCount('change')).toBe(0);
    f.engine.emit('change');
    expect(f.desktopIntegration.setEnabled).toHaveBeenCalledOnce();
  });

  it('waits for saved shared mode and a verified runtime while allowing a fresh profile without a probed queue', async () => {
    const f = makeApp();
    f.desktopIntegration.shouldRetry.mockResolvedValue(true);
    f.codex.listThreads.mockResolvedValue([]);
    f.codex.isVerifiedVersion.mockReturnValue(false);
    const status = { configured: true, connected: false, queueSupported: false, desktopVerified: false };
    f.codex.status = () => status;
    await f.app.ready();
    expect(f.desktopIntegration.shouldRetry).not.toHaveBeenCalled();
    f.config.config.codex.transport = 'websocket';
    status.connected = true; f.codex.isVerifiedVersion.mockReturnValue(true); f.engine.emit('change');
    expect(f.desktopIntegration.shouldRetry).not.toHaveBeenCalled();
    f.config.config.codex.transport = 'shared'; f.codex.isVerifiedVersion.mockReturnValue(false); f.engine.emit('change');
    expect(f.desktopIntegration.shouldRetry).not.toHaveBeenCalled();
    f.codex.isVerifiedVersion.mockReturnValue(true); f.engine.emit('change');
    await vi.waitFor(() => expect(f.desktopIntegration.setEnabled).toHaveBeenCalledExactlyOnceWith(true, true));
    expect(status.queueSupported).toBe(false);
  });

  it('never launches without pending intent and respects an explicit opt-out for this gateway lifetime', async () => {
    const f = makeApp();
    await f.app.ready();
    for (let i = 0; i < 3; i++) { f.engine.emit('change'); await Promise.resolve(); }
    expect(f.desktopIntegration.shouldRetry).toHaveBeenCalledOnce();
    expect(f.desktopIntegration.setEnabled).not.toHaveBeenCalled();
    expect((await f.app.inject({ url: '/api/codex/desktop-integration', method: 'POST', headers, payload: { enabled: false } })).statusCode).toBe(200);
    f.desktopIntegration.shouldRetry.mockResolvedValue(true);
    f.engine.emit('change');
    expect(f.desktopIntegration.setEnabled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('holds the config guard during intent read and native retry and releases it after failure', async () => {
    const f = makeApp();
    let finishRead!: (value: boolean) => void;
    let finishRetry!: () => void;
    f.desktopIntegration.shouldRetry.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    f.desktopIntegration.setEnabled.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finishRetry = resolve; });
      throw new Error('PRIVATE_NATIVE_FAILURE with sensitive settings');
    });
    await f.app.ready();
    const requests = [
      { url: '/api/config', method: 'PUT' as const, payload: { codex: { transport: 'shared' } } },
      { url: '/api/codex/connect', method: 'POST' as const },
      { url: '/api/codex/desktop-integration', method: 'POST' as const, payload: { enabled: false } },
    ];
    for (const request of requests) expect((await f.app.inject({ ...request, headers })).statusCode).toBe(409);
    expect(f.desktopIntegration.setEnabled).not.toHaveBeenCalled();
    finishRead(true);
    await vi.waitFor(() => expect(f.desktopIntegration.setEnabled).toHaveBeenCalledOnce());
    for (const request of requests) expect((await f.app.inject({ ...request, headers })).statusCode).toBe(409);
    finishRetry();
    await vi.waitFor(async () => expect((await f.app.inject({ url: '/api/codex/connect', method: 'POST', headers })).statusCode).toBe(200));
    f.engine.emit('change'); f.engine.emit('change');
    const response = await f.app.inject({ url: '/api/codex/desktop-integration', headers });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('PRIVATE_NATIVE_FAILURE');
    expect(f.desktopIntegration.setEnabled).toHaveBeenCalledOnce();
    expect(f.configure).not.toHaveBeenCalled();
  });

  it.each(['shared', 'websocket'] as const)('rechecks the saved target after a concurrent config change to %s', async transport => {
    const f = makeApp();
    f.config.config.codex.transport = 'websocket';
    f.config.config.codex.endpoint = 'ws://127.0.0.1:4500';
    f.desktopIntegration.shouldRetry.mockResolvedValue(true);
    await f.app.ready();
    let finishSave!: () => void;
    f.configure.mockImplementationOnce(async next => {
      await new Promise<void>(resolve => { finishSave = resolve; });
      f.config.config = next;
    });
    const save = f.app.inject({ url: '/api/config', method: 'PUT', headers, payload: { codex: { transport } } }).then(response => response);
    await vi.waitFor(() => expect(f.configure).toHaveBeenCalledOnce());
    f.engine.emit('change');
    expect(f.desktopIntegration.setEnabled).not.toHaveBeenCalled();
    finishSave(); expect((await save).statusCode).toBe(200);
    if (transport === 'shared') await vi.waitFor(() => expect(f.desktopIntegration.setEnabled).toHaveBeenCalledExactlyOnceWith(true, true));
    else expect(f.desktopIntegration.setEnabled).not.toHaveBeenCalled();
  });

  it.each(['connection', 'verified version'] as const)('does not launch if the native %s disappears while pending intent is read', async lost => {
    const f = makeApp();
    let finishRead!: (value: boolean) => void;
    f.desktopIntegration.shouldRetry.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    await f.app.ready();
    if (lost === 'connection') f.codex.status = () => ({ configured: true, connected: false, queueSupported: false, desktopVerified: false });
    else f.codex.isVerifiedVersion.mockReturnValue(false);
    finishRead(true); await Promise.resolve();
    expect(f.desktopIntegration.setEnabled).not.toHaveBeenCalled();
    f.codex.status = () => ({ configured: true, connected: true, queueSupported: false, desktopVerified: false });
    f.codex.isVerifiedVersion.mockReturnValue(true);
    f.desktopIntegration.shouldRetry.mockResolvedValue(true);
    f.engine.emit('change');
    await vi.waitFor(() => expect(f.desktopIntegration.setEnabled).toHaveBeenCalledExactlyOnceWith(true, true));
  });
});

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

  it.each(['/api/state', '/api/auto-links', '/api/threads', '/api/catalog/slack/chats', '/api/catalog/slack/threads?chatId=CEXAMPLE', '/api/catalog/slack/people?endpointId=example', '/api/catalog/telegram', '/api/conversations/example/slack-sync', '/api/unknown', '/api'])(
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
      syntheticSlackBotToken,
      syntheticSlackAppToken,
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
    const { app, configure, codex } = makeApp();
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
    const connecting = await app.inject({ method: 'POST', url: '/api/codex/connect', headers });
    expect(connecting.statusCode).toBe(409);
    expect(codex.connect).not.toHaveBeenCalled();
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

  it('requests a full Codex catalog refresh only when explicitly selected', async () => {
    const f = makeApp();
    const response = await f.app.inject({ url: '/api/threads?refresh=true', headers });
    expect(response.statusCode).toBe(200);
    expect(f.codex.listThreads).toHaveBeenLastCalledWith({ archived: false, refresh: true });
    expect((await f.app.inject({ url: '/api/threads?refresh=maybe', headers })).statusCode).toBe(400);
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


describe('authenticated Slack sync journal API', () => {
  function journal() {
    const f = makeApp();
    const endpoint: Endpoint = { ...f.endpoint, id: 'slack-journal', platform: 'slack', accountId: 'T1:URELE', chatId: 'C1', threadId: '100.000000', title: 'Original thread' };
    f.store.upsertEndpoint(endpoint);
    const conversation = f.store.createConversation({ name: 'Journal conversation', threadId: 'journal-codex', cwd: '/journal', bindings: [{ platform: 'slack', endpointId: endpoint.id, allowedSenderIds: [] }] });
    const fullText = 'journal-only-private-context-' + 'x'.repeat(60_000);
    const entries = Array.from({ length: 105 }, (_, index) => f.store.recordSlackMessage({ endpointId: endpoint.id,
      accountId: endpoint.accountId, chatId: endpoint.chatId, threadId: endpoint.threadId,
      messageId: `110.${String(index).padStart(6, '0')}`, sender: { id: 'UAGENT', name: 'Other agent', isBot: true },
      text: index ? `Message ${index}` : fullText, payload: { text: index ? `Message ${index}` : fullText, files: [{ id: 'F1', title: 'Full attachment metadata' }] }, kind: 'message' })!);
    f.store.updateSlackSyncEntry(entries[0].id, { state: 'uncertain', error: 'Lost passive append ACK' });
    f.store.updateSlackSyncEntry(entries[1].id, { state: 'applied' });
    f.store.updateSlackSyncStream(entries[0].streamId, { state: 'blocked', coveredThrough: '200.000000', error: 'Slack rate limited' });
    f.store.setMeta(`endpoint-alias:${endpoint.id}`, 'Local journal title');
    return { ...f, endpoint, conversation, entries, fullText, url: `/api/conversations/${conversation.id}/slack-sync` };
  }

  it('requires local panel authentication and refuses unknown or foreign conversation streams', async () => {
    const f = journal();
    expect((await f.app.inject({ url: f.url, headers: { host: headers.host } })).statusCode).toBe(401);
    expect((await f.app.inject({ url: '/api/conversations/missing/slack-sync', headers })).statusCode).toBe(404);
    const otherEndpoint = { ...f.endpoint, id: 'slack-other-journal', chatId: 'C2' };
    f.store.upsertEndpoint(otherEndpoint);
    const other = f.store.createConversation({ name: 'Other conversation', threadId: 'other-journal-codex', cwd: '/other', bindings: [{ platform: 'slack', endpointId: otherEndpoint.id, allowedSenderIds: [] }] });
    const foreign = f.store.listSlackSyncStreams().find(stream => stream.conversationId === other.id)!;
    const rejected = await f.app.inject({ url: `${f.url}?streamId=${foreign.id}`, headers });
    expect(rejected.statusCode).toBe(404);
    expect(rejected.body).not.toContain(f.fullText);
    expect((await f.app.inject({ url: `${f.url}?streamId=missing`, headers })).statusCode).toBe(404);
  });

  it('returns exact counts, complete payloads and a bounded page with the requested stream', async () => {
    const f = journal();
    const response = await f.app.inject({ url: `${f.url}?streamId=${f.entries[0].streamId}&offset=0&limit=2`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body.streamId).toBe(f.entries[0].streamId);
    expect(body.nextOffset).toBe(2);
    expect(body.entries).toHaveLength(2);
    expect(body.streams).toEqual([{ id: f.entries[0].streamId, platform: 'slack', endpointId: f.endpoint.id, title: 'Local journal title',
      active: true, paused: false, state: 'blocked', coveredThrough: '200.000000', error: 'Slack rate limited',
      counts: { pending: 103, applying: 0, applied: 1, uncertain: 1 } }]);
    expect(body.entries[0]).toEqual({ id: f.entries[0].id, message: f.entries[0].message, state: 'uncertain', error: 'Lost passive append ACK', createdAt: f.entries[0].createdAt });
    expect(body.entries[0].message.text).toBe(f.fullText);
    expect(body.entries[0].message.payload.files[0].title).toBe('Full attachment metadata');
    const last = (await f.app.inject({ url: `${f.url}?offset=104&limit=2`, headers })).json();
    expect(last.entries.map((entry: { id: string }) => entry.id)).toEqual([f.entries[104].id]);
    expect(last.nextOffset).toBeUndefined();
    expect((await f.app.inject({ url: `${f.url}?offset=999&limit=100`, headers })).json().entries).toEqual([]);
    const state = await f.app.inject({ url: '/api/state', headers });
    expect(state.body).not.toContain('journal-only-private-context-');
    expect(state.json()).not.toHaveProperty('slackSync');
  });

  it('includes detached streams and selects the first stream by default without exposing another conversation', async () => {
    const f = journal();
    const replacement = { ...f.endpoint, id: 'slack-replacement', chatId: 'C3', title: 'Replacement title' };
    f.store.upsertEndpoint(replacement);
    f.store.setBinding(f.conversation.id, 'slack', replacement.id, []);
    f.store.updateConversation(f.conversation.id, { paused: true });
    const result = (await f.app.inject({ url: `${f.url}?limit=1`, headers })).json();
    expect(result.streamId).toBe(f.entries[0].streamId);
    expect(result.streams).toHaveLength(2);
    expect(result.streams[0]).toMatchObject({ active: false, paused: true, title: 'Local journal title' });
    expect(result.streams[1]).toMatchObject({ active: true, paused: true, title: 'Replacement title' });
    expect(result.entries).toHaveLength(1);
    const selected = (await f.app.inject({ url: `${f.url}?streamId=${result.streams[1].id}`, headers })).json();
    expect(selected.streamId).toBe(result.streams[1].id);
    expect(selected.entries).toEqual([]);
  });

  it('returns an empty journal for a conversation with no Slack stream', async () => {
    const f = makeApp();
    const conversation = f.store.createConversation({ name: 'No Slack', threadId: 'no-slack-codex', cwd: '/project' });
    const result = await f.app.inject({ url: `/api/conversations/${conversation.id}/slack-sync`, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ streams: [], entries: [] });
  });

  it.each(['unknown=true', 'streamId=', 'streamId=first&streamId=second', 'offset=-1', 'offset=1.5', 'offset=9007199254740992', 'offset=1&offset=2', 'limit=0', 'limit=101', 'limit=1.5', 'limit=1e2', 'limit=2&limit=3'])(
    'rejects invalid journal query %s', async query => {
      const f = makeApp();
      const conversation = f.store.createConversation({ name: 'Arguments', threadId: 'arguments-codex', cwd: '/project' });
      expect((await f.app.inject({ url: `/api/conversations/${conversation.id}/slack-sync?${query}`, headers })).statusCode).toBe(400);
    },
  );
});

describe('independent conversation origins', () => {
  it('creates four origins, edits and deletes by scoped ID, rejects duplicate endpoints and ambiguous legacy routes', async () => {
    const f = makeApp();
    const endpoints = Array.from({ length: 5 }, (_, index): Endpoint => ({ ...f.endpoint, id: `origin-${index}`, platform: index < 2 ? 'telegram' : 'slack', accountId: `account-${index < 2 ? 'telegram' : 'slack'}`, chatId: `chat-${index}`, people: [{ id: 'anna', name: 'Анна' }, { id: 'mikhail', name: 'Михаил' }] }));
    endpoints.forEach(endpoint => f.store.upsertEndpoint(endpoint));
    const created = await f.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: { name: 'Four origins', threadId: 'thread-example', cwd: '/work/example', bindings: endpoints.slice(0, 4).map(endpoint => ({ platform: endpoint.platform, endpointId: endpoint.id, allowedSenderIds: ['anna'] })) } });
    expect(created.statusCode).toBe(200);
    const conversation = created.json().conversation;
    expect(conversation.bindings).toHaveLength(4);
    const other = f.store.createConversation({ name: 'Other', threadId: 'thread-other', cwd: '/work/other' });
    const selected = conversation.bindings.find((binding: { endpointId: string }) => binding.endpointId === endpoints[2].id);
    const path = `/api/conversations/${conversation.id}/bindings/${selected.id}`;
    expect((await f.app.inject({ method: 'PUT', url: path, headers, payload: { endpointId: endpoints[4].id, allowedSenderIds: ['mikhail'] } })).statusCode).toBe(200);
    expect(f.store.getBinding(conversation.id, selected.id)).toMatchObject({ platform: 'slack', endpointId: endpoints[4].id, allowedSenderIds: ['mikhail'] });
    expect(f.store.getConversation(conversation.id)?.bindings.find(binding => binding.id !== selected.id)?.allowedSenderIds).toEqual(['anna']);
    for (const method of ['PUT', 'DELETE'] as const) expect((await f.app.inject({ method, url: `/api/conversations/${other.id}/bindings/${selected.id}`, headers, ...(method === 'PUT' ? { payload: { endpointId: endpoints[4].id, allowedSenderIds: [] } } : {}) })).statusCode).toBe(404);
    expect((await f.app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/bindings`, headers, payload: { platform: 'slack', endpointId: endpoints[4].id, allowedSenderIds: ['anna'] } })).statusCode).toBe(409);
    for (const method of ['PUT', 'DELETE'] as const) expect((await f.app.inject({ method, url: `/api/conversations/${conversation.id}/bindings/slack`, headers, ...(method === 'PUT' ? { payload: { endpointId: endpoints[4].id, allowedSenderIds: ['anna'] } } : {}) })).statusCode).toBe(409);
    expect((await f.app.inject({ method: 'DELETE', url: path, headers })).statusCode).toBe(200);
    expect(f.store.getConversation(conversation.id)?.bindings).toHaveLength(3);
    expect((await f.app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/bindings`, headers, payload: { platform: 'slack', endpointId: endpoints[2].id, allowedSenderIds: ['mikhail'] } })).statusCode).toBe(200);
    expect(f.store.getConversation(conversation.id)?.bindings).toHaveLength(4);
  });
});

describe('explicit automatic conversation rules', () => {
  const rule = { id: 'rule-example', enabled: false, platform: 'telegram' as const, accountId: 'bot-example', chatId: 'chat-example', cwd: '/work/example', allowedSenderIds: ['sender-anna'] };
  function connected(f: ReturnType<typeof makeApp>) {
    f.engine.channels.telegram = { state: { configured: true, connected: true, accountId: f.endpoint.accountId }, start: vi.fn(), stop: vi.fn(), deliver: vi.fn(), download: vi.fn() } as unknown as Channel;
  }
  it('defaults existing configs to no rules, preserves explicit opt-in and mention policy, exposes only authenticated local state', async () => {
    const f = makeApp(); connected(f);
    expect(mergeConfig(defaultConfig, {}).autoLinkRules).toEqual([]);
    expect((await f.app.inject({ url: '/api/state', headers })).json().config.autoLinkRules).toEqual([]);
    const response = await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [rule] } });
    expect(response.statusCode).toBe(200);
    expect(f.config.config.autoLinkRules).toEqual([{ ...rule, requireMention: true }]);
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [{ ...rule, enabled: true, requireMention: false }] } })).statusCode).toBe(200);
    expect(f.config.config.autoLinkRules[0]).toMatchObject({ enabled: true, requireMention: false });
    expect((await f.app.inject({ url: '/api/auto-links', headers })).json()).toEqual({ intents: [] });
    f.engine.channels.telegram = undefined;
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [{ ...rule, requireMention: false }] } })).statusCode).toBe(200);
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [] } })).statusCode).toBe(200);
  });
  it.each([
    null, [{ ...rule, arbitrary: true }], [{ ...rule, enabled: 'true' }], [{ ...rule, requireMention: 'false' }], [{ ...rule, cwd: 'relative' }], [{ ...rule, cwd: '\\\\server\\share' }], [{ ...rule, allowedSenderIds: [] }], [rule, rule], [{ ...rule, accountId: 'other-bot' }], [{ ...rule, chatId: 'unknown' }], [{ ...rule, allowedSenderIds: ['unknown'] }], [{ ...rule, cwd: 'C:\\work\\example' }],
  ])('rejects malformed or unobserved rules without persisting: %j', async autoLinkRules => {
    const f = makeApp(); connected(f);
    const response = await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules } });
    expect(response.statusCode).toBe(400);
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.config.config.autoLinkRules).toEqual([]);
  });
  it('validates paths against the actual Codex OS and requires identity for shared transports', async () => {
    const f = makeApp(); connected(f);
    f.codex.runtimeInfo.mockReturnValue({ platformOs: 'windows', platformFamily: 'windows', codexHome: 'C:\\Users\\Example\\.codex', userAgent: 'test' });
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [{ ...rule, cwd: 'C:\\work\\example' }] } })).statusCode).toBe(200);
    f.config.config.autoLinkRules = [];
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [rule] } })).statusCode).toBe(400);
    f.config.config.codex = { transport: 'websocket', executable: 'codex', endpoint: 'ws://127.0.0.1:9010' };
    f.codex.runtimeInfo.mockReturnValue(undefined as never);
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [rule] } })).statusCode).toBe(400);
  });
  it('loads people for a whole Slack channel before any thread exists, validates access, and fences account changes', async () => {
    const f = makeApp();
    const channel = { state: { configured: true, connected: true, accountId: 'TEAM:BOT' }, start: vi.fn(), stop: vi.fn(), deliver: vi.fn(), download: vi.fn(), listChats: vi.fn(), listThreads: vi.fn(), listPeople: vi.fn().mockResolvedValue({ items: [{ id: 'peer', name: 'Peer agent', isBot: true }] }) };
    f.engine.channels.slack = channel;
    const selected = { ...rule, platform: 'slack', accountId: 'TEAM:BOT', chatId: 'CEXAMPLE', allowedSenderIds: ['peer'] };
    expect((await f.app.inject({ url: '/api/catalog/slack/people?chatId=CEXAMPLE', headers })).json()).toMatchObject({ items: [{ id: 'peer' }] });
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [selected] } })).statusCode).toBe(200);
    expect(f.store.listConversations()).toEqual([]);
    f.config.config.autoLinkRules = [];
    channel.listPeople.mockImplementationOnce(async () => { f.engine.channels.slack = { ...channel, state: { ...channel.state, accountId: 'OTHER:BOT' } }; return { items: [{ id: 'peer', name: 'Peer' }] }; });
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [selected] } })).statusCode).toBe(409);
    expect(f.config.config.autoLinkRules).toEqual([]);
  });
});

describe('automatic group access and private chat boundaries', () => {
  it('permits explicit all-participant group rules without sender IDs and preserves the generated binding policy on edits', async () => {
    const f = makeApp();
    const endpoint = { ...f.endpoint, id: 'group-all', chatId: '-100123', people: [] };
    f.store.upsertEndpoint(endpoint);
    f.engine.channels.telegram = { state: { configured: true, connected: true, accountId: endpoint.accountId } } as Channel;
    const rule = { id: 'all-group', platform: 'telegram', accountId: endpoint.accountId, chatId: endpoint.chatId, cwd: '/work/example', enabled: true, allowAllSenders: true, allowedSenderIds: [], requireMention: false };
    const response = await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [rule] } });
    expect(response.statusCode).toBe(200);
    expect(f.config.config.autoLinkRules).toEqual([rule]);
    const conversation = f.store.createConversation({ name: 'Group policy', threadId: 'thread-example', cwd: '/work/example' });
    const created = await f.app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/bindings`, headers, payload: { platform: 'telegram', endpointId: endpoint.id, allowedSenderIds: [], allowAllSenders: true, requireMention: true } });
    expect(created.statusCode).toBe(200);
    const binding = created.json().conversation.bindings[0];
    expect(binding).toMatchObject({ allowAllSenders: true, requireMention: true });
    const path = `/api/conversations/${conversation.id}/bindings/${binding.id}`;
    expect((await f.app.inject({ method: 'PUT', url: path, headers, payload: { endpointId: endpoint.id, allowedSenderIds: [] } })).statusCode).toBe(200);
    expect(f.store.getBinding(conversation.id, binding.id)).toMatchObject({ allowAllSenders: true, requireMention: true });
    expect((await f.app.inject({ method: 'PUT', url: path, headers, payload: { endpointId: endpoint.id, allowedSenderIds: [], allowAllSenders: false, requireMention: false } })).statusCode).toBe(200);
    expect(f.store.getBinding(conversation.id, binding.id)).toMatchObject({ allowAllSenders: false, requireMention: false });
  });
  it('rejects all-participant access and bots in DMs, while accepting the selected human', async () => {
    const f = makeApp();
    const endpoint = { ...f.endpoint, id: 'private', chatId: '123456', people: [{ id: '123456', name: 'Human' }, { id: '888', name: 'Bot', isBot: true }] };
    f.store.upsertEndpoint(endpoint);
    f.engine.channels.telegram = { state: { configured: true, connected: true, accountId: endpoint.accountId } } as Channel;
    const rule = { id: 'private-rule', platform: 'telegram', accountId: endpoint.accountId, chatId: endpoint.chatId, cwd: '/work/example', enabled: true, allowedSenderIds: ['123456'], requireMention: true };
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [{ ...rule, allowAllSenders: true, allowedSenderIds: [] }] } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [{ ...rule, allowedSenderIds: ['888'] }] } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [rule] } })).statusCode).toBe(200);
    const channel = { state: { configured: true, connected: true, accountId: 'TEAM:BOT' }, listPeople: vi.fn().mockResolvedValue({ items: [{ id: 'agent', name: 'Peer agent', isBot: true }, { id: 'human', name: 'Human' }] }) };
    f.engine.channels.slack = channel as unknown as Channel;
    const slack = { ...rule, id: 'slack-private', platform: 'slack', accountId: 'TEAM:BOT', chatId: 'DEXAMPLE', allowedSenderIds: ['agent'] };
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [slack] } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [{ ...slack, allowedSenderIds: ['human'] }] } })).statusCode).toBe(200);
  });

  it('uses an explicit Slack profile classification to repair the cached DM rule identity', async () => {
    const f = makeApp();
    const listPeople = vi.fn().mockResolvedValue({ items: [{ id: 'UANNA', name: 'Participant', isBot: true }] });
    f.engine.channels.slack = { state: { configured: true, connected: true, accountId: 'TEAM:BOT' }, listChats: vi.fn(), listThreads: vi.fn(), listPeople } as unknown as Channel;
    const selected = { id: 'identity-rule', platform: 'slack', accountId: 'TEAM:BOT', chatId: 'DEXAMPLE', cwd: '/work/example', enabled: true,
      allowedSenderIds: ['UANNA'], requireMention: false };
    expect((await f.app.inject({ url: '/api/catalog/slack/people?chatId=DEXAMPLE', headers })).statusCode).toBe(200);
    listPeople.mockResolvedValueOnce({ items: [{ id: 'UANNA', name: 'Unclassified refresh' }] });
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [selected] } })).statusCode).toBe(400);
    listPeople.mockResolvedValueOnce({ items: [{ id: 'UANNA', name: 'Verified human', isBot: false }] });
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [selected] } })).statusCode).toBe(200);
    listPeople.mockResolvedValueOnce({ items: [{ id: 'UANNA', name: 'Verified bot', isBot: true }] });
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [{ ...selected, id: 'new-identity-rule' }] } })).statusCode).toBe(400);
  });
});


describe('automatic rules remain scoped to the selected Codex target', () => {
  const codexHome = resolve('synthetic-codex-home');
  it.each(['global rule', 'source route'])('preserves an enabled unchanged automatic %s during an executable-only shared selection change', async automatic => {
    const f = makeApp();
    f.config.config.codex = { transport: 'shared', executable: '/opt/codex-old', endpoint: '', codexHome };
    if (automatic === 'global rule') f.config.config = mergeConfig(f.config.config, { autoLinkRules: [{ id: 'same-profile-rule', platform: 'telegram', accountId: f.endpoint.accountId,
      chatId: f.endpoint.chatId, cwd: '/work/example', enabled: true, allowedSenderIds: ['sender-anna'], allowAllSenders: false, requireMention: true }] });
    else {
      f.store.routeSource(f.endpoint.id, null, '/work/example');
      f.store.setSourceAccess(f.endpoint.id, { mode: 'all', allowedSenderIds: [] });
    }
    const rules = structuredClone(f.config.config.autoLinkRules), route = f.store.getSourceRoute(f.endpoint.id), access = f.store.getSourceAccess(f.endpoint.id);
    const response = await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { codex: { executable: 'codex' } } });
    expect(response.statusCode).toBe(200);
    expect(f.configure).toHaveBeenCalledOnce();
    expect(f.config.config.codex).toEqual({ transport: 'shared', executable: 'codex', endpoint: '', codexHome });
    expect(f.config.config.autoLinkRules).toEqual(rules);
    expect(f.store.getSourceRoute(f.endpoint.id)).toEqual(route);
    expect(f.store.getSourceAccess(f.endpoint.id)).toEqual(access);
    expect(f.codex.connect).not.toHaveBeenCalled();
  });

  it.each([{ codexHome: resolve('synthetic-other-codex-home') }, { token: 'replacement-synthetic-token' }])('does not exempt a selection change combined with changed shared scope %j', async changed => {
    const f = makeApp();
    f.config.config.codex = { transport: 'shared', executable: '/opt/codex-old', endpoint: '', codexHome };
    f.store.routeSource(f.endpoint.id, null, '/work/example');
    f.store.setSourceAccess(f.endpoint.id, { mode: 'all', allowedSenderIds: [] });
    const before = structuredClone(f.config.config);
    const response = await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { codex: { executable: 'codex', ...changed } } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('Отключите правила');
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.config.config).toEqual(before);
  });

  it('requires disabling rules before changing the target and checks the new runtime before re-enabling', async () => {
    const f = makeApp();
    f.engine.channels.telegram = { state: { configured: true, connected: true, accountId: f.endpoint.accountId } } as Channel;
    const rule = { id: 'profile-rule', platform: 'telegram', accountId: f.endpoint.accountId, chatId: f.endpoint.chatId, cwd: '/work/example', enabled: true, allowedSenderIds: ['sender-anna'], requireMention: true };
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [rule] } })).statusCode).toBe(200);
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { codex: { token: 'replacement-synthetic-token' } } })).statusCode).toBe(200);
    const codex = { transport: 'websocket', endpoint: 'ws://127.0.0.1:9077' };
    const rejected = await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { codex } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain('Отключите правила');
    expect(f.config.config.codex.transport).toBe('shared');
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { codex, autoLinkRules: [{ ...rule, enabled: false }] } })).statusCode).toBe(200);
    f.codex.runtimeInfo.mockReturnValue({ platformOs: 'windows', platformFamily: 'windows', codexHome: 'C:\\Users\\Example\\.codex', userAgent: 'test' });
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [rule] } })).statusCode).toBe(400);
    expect(f.config.config.autoLinkRules[0].enabled).toBe(false);
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { autoLinkRules: [{ ...rule, cwd: 'C:\\work\\example' }] } })).statusCode).toBe(200);
  });
});


describe('source access and native thread routing', () => {
  function attachSource(f: ReturnType<typeof makeApp>, patch: Partial<Endpoint> = {}) {
    const endpoint: Endpoint = { ...f.endpoint, id: 'source-example', chatId: '-100001', threadId: '42', available: true,
      people: [{ id: 'UANNA', name: 'Анна' }, { id: 'UAGENT', name: 'Другой агент', isBot: true }], ...patch };
    f.store.upsertEndpoint(endpoint);
    const channel = { state: { configured: true, connected: true, accountId: endpoint.accountId },
      start: vi.fn(), stop: vi.fn(), deliver: vi.fn(), download: vi.fn(),
      listPeople: vi.fn().mockResolvedValue({ items: endpoint.people }) };
    f.engine.channels[endpoint.platform] = channel;
    return { endpoint, channel };
  }
  function put(f: ReturnType<typeof makeApp>, endpoint: Endpoint, operation: 'access' | 'route', payload: Record<string, unknown>) {
    return f.app.inject({ method: 'PUT', url: `/api/endpoints/${endpoint.id}/${operation}`, headers, payload });
  }

  it('authenticates new setters and leaves unbound discovered sources off without provisioning', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    for (const [operation, payload] of [['access', { mode: 'all' }], ['route', { threadId: 'thread-example' }]] as const) {
      const url = `/api/endpoints/${endpoint.id}/${operation}`;
      expect((await f.app.inject({ method: 'PUT', url, headers: { host: headers.host }, payload })).statusCode).toBe(401);
      expect((await f.app.inject({ method: 'PUT', url, headers: { ...headers, origin: 'https://example.invalid' }, payload })).statusCode).toBe(403);
    }
    const state = (await f.app.inject({ url: '/api/state', headers })).json();
    expect(state.sourceAccess.find((item: { endpointId: string }) => item.endpointId === endpoint.id)).toEqual({ endpointId: endpoint.id, mode: 'off', allowedSenderIds: [], legacy: false });
    expect(state.sourceRoutes.find((item: { endpointId: string }) => item.endpointId === endpoint.id)).toEqual({ endpointId: endpoint.id, mode: 'none' });
    expect(f.store.listConversations()).toEqual([]);
    expect(f.store.listRequests()).toEqual([]);
    expect(f.codex.listThreads).not.toHaveBeenCalled();
  });

  it('preserves legacy binding ACL until an explicit group mode changes reaction policy', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    const conversation = f.store.createConversation({ name: 'Локальное название', threadId: 'thread-example', cwd: '/work/example',
      bindings: [{ platform: endpoint.platform, endpointId: endpoint.id, allowedSenderIds: ['UANNA'], requireMention: true }] });
    const binding = structuredClone(conversation.bindings[0]);
    expect(f.store.getSourceAccess(endpoint.id)).toMatchObject({ mode: 'mention', allowedSenderIds: ['UANNA'], legacy: true });
    expect((await put(f, endpoint, 'access', { mode: 'off', allowedSenderIds: ['UAGENT'] })).statusCode).toBe(200);
    expect(f.store.getSourceAccess(endpoint.id)).toMatchObject({ mode: 'off', allowedSenderIds: ['UANNA'] });
    expect(f.store.getBinding(conversation.id, binding.id)).toEqual(binding);
    expect((await put(f, endpoint, 'access', { mode: 'all' })).statusCode).toBe(200);
    expect(f.store.getSourceAccess(endpoint.id)).toEqual({ endpointId: endpoint.id, mode: 'all', allowedSenderIds: [], legacy: false });
    expect(f.store.getBinding(conversation.id, binding.id)).toEqual(binding);
    expect((await put(f, endpoint, 'access', { mode: 'off' })).statusCode).toBe(200);
    expect(f.store.getBinding(conversation.id, binding.id)).toEqual(binding);
  });

  it.each([{}, { mode: 'unknown' }, { mode: true }, { mode: 'all', arbitrary: true }, { mode: 'all', allowedSenderIds: 'everyone' }, { mode: 'all', allowedSenderIds: [''] }])('rejects malformed access policy: %j', async payload => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    expect((await put(f, endpoint, 'access', payload)).statusCode).toBe(400);
    expect(f.store.getSourceAccess(endpoint.id).mode).toBe('off');
  });

  it.each(['slack', 'telegram'] as const)('requires selected participating humans in a %s DM', async platform => {
    const f = makeApp();
    const humanId = platform === 'slack' ? 'UANNA' : '123456';
    const { endpoint } = attachSource(f, { platform, chatId: platform === 'slack' ? 'DEXAMPLE' : humanId,
      people: [{ id: humanId, name: 'Анна' }, { id: 'UAGENT', name: 'Агент', isBot: true }, { id: '999', name: 'Другой человек' }] });
    for (const allowedSenderIds of [[], ['UAGENT'], ['unknown'], ...(platform === 'telegram' ? [['999']] : [])]) {
      expect((await put(f, endpoint, 'access', { mode: 'all', allowedSenderIds })).statusCode).toBe(400);
    }
    expect((await put(f, endpoint, 'access', { mode: 'all', allowedSenderIds: [humanId, humanId] })).statusCode).toBe(200);
    expect(f.store.getSourceAccess(endpoint.id)).toEqual({ endpointId: endpoint.id, mode: 'all', allowedSenderIds: [humanId], legacy: false });
    expect((await put(f, endpoint, 'access', { mode: 'mention' })).statusCode).toBe(200);
    expect(f.store.getSourceAccess(endpoint.id).allowedSenderIds).toEqual([humanId]);
  });

  it('repairs a stale Slack DM bot flag from the live participant catalog before enabling human access', async () => {
    const f = makeApp();
    const { endpoint, channel } = attachSource(f, { platform: 'slack', chatId: 'DEXAMPLE', people: [{ id: 'UANNA', name: 'Stale bot flag', isBot: true }] });
    channel.listPeople.mockResolvedValueOnce({ items: [{ id: 'UANNA', name: 'Verified human', isBot: false }] });
    expect((await put(f, endpoint, 'access', { mode: 'all', allowedSenderIds: ['UANNA'] })).statusCode).toBe(200);
    expect(f.store.getEndpoint(endpoint.id)?.people).toEqual([{ id: 'UANNA', name: 'Verified human', isBot: false }]);
  });

  it.each([{ available: false }, { accountId: 'previous-bot' }])('blocks enabling a stale source but permits disabling it offline: %j', async patch => {
    const f = makeApp(); const { endpoint, channel } = attachSource(f);
    if (patch.accountId !== undefined) channel.state.accountId = patch.accountId;
    else f.store.upsertEndpoint({ ...endpoint, ...patch });
    expect((await put(f, endpoint, 'access', { mode: 'all' })).statusCode).toBe(400);
    channel.state.connected = false;
    expect((await put(f, endpoint, 'access', { mode: 'off' })).statusCode).toBe(200);
    expect(f.store.getSourceAccess(endpoint.id).mode).toBe('off');
  });

  it('preserves the Telegram forum-topic validation for active access and routing', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f, { isForum: true, threadId: '', generalTopic: false });
    expect((await put(f, endpoint, 'access', { mode: 'all' })).statusCode).toBe(400);
    expect((await put(f, endpoint, 'route', { threadId: 'thread-example' })).statusCode).toBe(400);
    expect(f.codex.listThreads).not.toHaveBeenCalled();
    expect((await put(f, endpoint, 'access', { mode: 'off' })).statusCode).toBe(200);
    expect((await put(f, endpoint, 'route', { threadId: null })).statusCode).toBe(200);
  });

  it('serializes active access and route changes against configuration saves while keeping off and unlink available', async () => {
    const f = makeApp(); const { endpoint, channel } = attachSource(f, { platform: 'slack', chatId: 'CGROUP' });
    let resolvePeople!: (page: { items: Endpoint['people'] }) => void;
    channel.listPeople.mockImplementationOnce(() => new Promise(resolve => { resolvePeople = resolve; }));
    const access = put(f, endpoint, 'access', { mode: 'all' }).then(response => response);
    await vi.waitFor(() => expect(channel.listPeople).toHaveBeenCalledOnce());
    let completeSave!: () => void;
    f.configure.mockImplementationOnce(async next => { await new Promise<void>(resolve => { completeSave = resolve; }); f.config.config = next; });
    const saving = f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { voice: { language: 'en' } } }).then(response => response);
    await vi.waitFor(() => expect(f.configure).toHaveBeenCalledOnce());
    try {
      resolvePeople({ items: endpoint.people });
      expect((await access).statusCode).toBe(409);
      expect((await put(f, endpoint, 'access', { mode: 'all' })).statusCode).toBe(409);
      expect((await put(f, endpoint, 'route', { threadId: 'thread-example' })).statusCode).toBe(409);
      expect((await put(f, endpoint, 'access', { mode: 'off' })).statusCode).toBe(200);
      expect((await put(f, endpoint, 'route', { threadId: null })).statusCode).toBe(200);
    } finally { completeSave(); }
    expect((await saving).statusCode).toBe(200);
    expect(f.store.getSourceAccess(endpoint.id).mode).toBe('off');
    expect(f.store.listConversations()).toEqual([]);
  });

  it('discards Slack people from a replaced connector before writing source access', async () => {
    const f = makeApp(); const { endpoint, channel } = attachSource(f, { platform: 'slack', chatId: 'DEXAMPLE' });
    channel.listPeople.mockImplementationOnce(async () => {
      f.engine.channels.slack = { ...channel, state: { ...channel.state, accountId: 'other-bot' } };
      return { items: [{ id: 'UANNA', name: 'Анна' }] };
    });
    expect((await put(f, endpoint, 'access', { mode: 'all', allowedSenderIds: ['UANNA'] })).statusCode).toBe(409);
    expect(f.store.getSourceAccess(endpoint.id).mode).toBe('off');
  });

  it('routes several sources to the same existing native ID without creating a native thread or duplicate Rele conversation', async () => {
    const f = makeApp(); const createNative = vi.fn(); Object.assign(f.codex, { createThread: createNative });
    const original = f.store.createConversation({ name: 'Мой alias', threadId: 'thread-example', cwd: '/work/example' });
    for (let index = 0; index < 4; index++) {
      const { endpoint } = attachSource(f, { id: `source-${index}`, platform: index < 2 ? 'telegram' : 'slack', chatId: index < 2 ? `-10000${index}` : `CGROUP${index}` });
      expect((await put(f, endpoint, 'route', { threadId: 'thread-example' })).statusCode).toBe(200);
      expect((await put(f, endpoint, 'route', { threadId: 'thread-example' })).statusCode).toBe(200);
      expect(f.store.getSourceAccess(endpoint.id).mode).toBe('off');
    }
    expect(f.store.listConversations()).toHaveLength(1);
    expect(f.store.getConversation(original.id)).toMatchObject({ name: 'Мой alias', threadId: 'thread-example', cwd: '/work/example' });
    expect(f.store.getConversation(original.id)?.bindings).toHaveLength(4);
    expect(f.codex.listThreads.mock.calls).toEqual(Array.from({ length: 8 }, () => []));
    expect(createNative).not.toHaveBeenCalled();
    expect(f.store.listRequests()).toEqual([]);
  });

  it('creates only Rele metadata for an unbound observed native thread and preserves accepted requests across later reassignment', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    expect((await put(f, endpoint, 'route', { threadId: 'thread-example' })).statusCode).toBe(200);
    expect(f.store.listConversations()).toHaveLength(1);
    expect(f.store.listConversations()[0]).toMatchObject({ name: 'Пример проекта', threadId: 'thread-example', cwd: '/work/example' });
    expect((await put(f, endpoint, 'access', { mode: 'all' })).statusCode).toBe(200);
    const message = { endpoint, eventId: 'accepted-before-move', messageId: 'message-1', sender: { id: '123456', name: 'Участник' }, text: 'Accepted task' };
    const queued = f.store.ingest(message).request!;
    expect(queued).not.toBeNull();
    expect((await put(f, endpoint, 'route', { threadId: 'thread-other' })).statusCode).toBe(409);
    expect(f.store.listConversations()).toHaveLength(1);
    expect((await put(f, endpoint, 'route', { threadId: null })).statusCode).toBe(409);
    f.store.finishRequest(queued.id, { status: 'completed' }, []);
    const completed = structuredClone(f.store.getRequest(queued.id));
    const bindingId = f.store.bindingForEndpoint(endpoint.id)!.id;
    expect((await put(f, endpoint, 'route', { threadId: 'thread-other' })).statusCode).toBe(200);
    expect(f.store.getRequest(queued.id)).toEqual(completed);
    expect(f.store.bindingForEndpoint(endpoint.id)?.id).toBe(bindingId);
    const next = f.store.ingest({ ...message, eventId: 'accepted-after-move', messageId: 'message-2' }).request!;
    expect(next.conversationId).not.toBe(queued.conversationId);
    expect(f.store.getConversation(next.conversationId)?.threadId).toBe('thread-other');
  });

  it.each([false, true])('assigns an indexed thread when a full scan is unavailable (recovery: %s)', async recovery => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    const catalog = (await f.app.inject({ url: '/api/threads', headers })).json().threads;
    const intent = recovery ? autoIntent(f, endpoint) : undefined;
    f.codex.listThreads.mockClear();
    f.codex.listThreads.mockImplementation(async (options?: { refresh?: boolean }) => {
      if (options?.refresh) throw new Error('Synthetic full catalog timeout');
      return catalog;
    });
    const response = await put(f, endpoint, 'route', { threadId: 'thread-example', ...(intent ? { resolveAutoLinkId: intent.id } : {}) });
    expect(response.statusCode, response.body).toBe(200);
    expect(f.codex.listThreads).toHaveBeenCalledExactlyOnceWith();
    expect(f.store.listConversations()).toHaveLength(1);
    expect(f.store.listConversations()[0]).toMatchObject({ threadId: 'thread-example', cwd: '/work/example' });
  });

  it.each(['missing', 'archived'])('preserves the previous route when a displayed thread becomes %s before selection', async kind => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    expect((await put(f, endpoint, 'route', { threadId: 'thread-other' })).statusCode).toBe(200);
    const displayed = (await f.app.inject({ url: '/api/threads', headers })).json().threads;
    expect(displayed.some((thread: { id: string }) => thread.id === 'thread-example')).toBe(true);
    const before = f.store.listConversations();
    f.codex.listThreads.mockClear();
    f.codex.listThreads.mockResolvedValue(kind === 'missing' ? [] : [{ ...displayed[0], archived: true }]);
    expect((await put(f, endpoint, 'route', { threadId: 'thread-example' })).statusCode).toBe(400);
    expect(f.codex.listThreads.mock.calls).toEqual(kind === 'missing' ? [[], [{ refresh: true }]] : [[]]);
    expect(f.store.listConversations()).toEqual(before);
    expect(f.store.listRequests()).toEqual([]);
  });

  it('preserves assignment of older conversations found only by an explicit full catalog refresh', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    const legacy = [{ id: 'legacy-thread', name: 'Legacy', cwd: '/work/legacy', preview: '', updatedAt: 0 }];
    f.codex.listThreads.mockImplementation(async (options?: { refresh?: boolean }) => options?.refresh ? legacy : []);
    const catalog = await f.app.inject({ url: '/api/threads?refresh=true', headers });
    expect(catalog.json().threads).toEqual(legacy);
    f.codex.listThreads.mockClear();
    expect((await put(f, endpoint, 'route', { threadId: 'legacy-thread' })).statusCode).toBe(200);
    expect(f.codex.listThreads.mock.calls).toEqual([[], [{ refresh: true }]]);
    expect(f.store.listConversations()[0]).toMatchObject({ threadId: 'legacy-thread', cwd: '/work/legacy' });
  });

  it.each([{}, { threadId: 'thread-example', autoCreateCwd: '/work' }, { threadId: 'thread-example', cwd: '/work' }, { threadId: 42 }, { autoCreateCwd: 'relative' }, { autoCreateCwd: '\\\\server\\share' }, { autoCreateCwd: 'C:\\work' }])('rejects malformed or wrong-platform routes without local or native creation: %j', async payload => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    expect((await put(f, endpoint, 'route', payload)).statusCode).toBe(400);
    expect(f.store.listConversations()).toEqual([]);
    expect(f.store.getSourceRoute(endpoint.id).mode).toBe('none');
  });

  it.each(['missing', 'archived', 'relative'])('rejects a %s native catalog target without a copy or fallback', async kind => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    f.codex.listThreads.mockResolvedValue(kind === 'missing' ? [] : [{ id: 'thread-example', name: 'Native thread', cwd: kind === 'relative' ? 'relative' : '/work/example', preview: '', updatedAt: 0, ...(kind === 'archived' ? { archived: true } : {}) }]);
    expect((await put(f, endpoint, 'route', { threadId: 'thread-example' })).statusCode).toBe(400);
    expect(f.store.listConversations()).toEqual([]);
  });

  it.each(['codex', 'channel'] as const)('fences a changed %s while validating the native catalog', async changed => {
    const f = makeApp(); const { endpoint, channel } = attachSource(f);
    f.codex.listThreads.mockImplementationOnce(async () => {
      if (changed === 'codex') f.replaceCodex();
      else f.engine.channels[endpoint.platform] = { ...channel, state: { ...channel.state, accountId: 'replacement-bot' } };
      return [{ id: 'thread-example', name: 'Native', cwd: '/work/example', preview: '', updatedAt: 0 }];
    });
    expect((await put(f, endpoint, 'route', { threadId: 'thread-example' })).statusCode).toBe(409);
    expect(f.store.listConversations()).toEqual([]);
  });

  it('stores per-source automatic routing without a global rule and unlinks while disconnected', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    f.codex.runtimeInfo.mockReturnValue({ platformOs: 'windows', platformFamily: 'windows', codexHome: 'C:\\Users\\Example\\.codex', userAgent: 'test' });
    expect((await put(f, endpoint, 'route', { autoCreateCwd: 'C:\\work\\project' })).statusCode).toBe(200);
    expect(f.store.getSourceRoute(endpoint.id)).toEqual({ endpointId: endpoint.id, mode: 'auto', cwd: 'C:\\work\\project' });
    expect(f.store.getSourceAccess(endpoint.id).mode).toBe('off');
    expect(f.config.config.autoLinkRules).toEqual([]);
    expect(f.codex.listThreads).not.toHaveBeenCalled();
    f.engine.channels = {};
    expect((await put(f, endpoint, 'route', { threadId: null })).statusCode).toBe(200);
    expect(f.store.getSourceRoute(endpoint.id).mode).toBe('none');
  });

  function autoIntent(f: ReturnType<typeof makeApp>, endpoint: Endpoint, status: 'pending' | 'creating' | 'uncertain' | 'failed' | 'created' = 'uncertain') {
    f.store.routeSource(endpoint.id, null, '/work/example');
    f.store.setSourceAccess(endpoint.id, { mode: 'all', allowedSenderIds: [] });
    const rule = f.store.getSourceAutoRule(endpoint.id)!;
    const received = f.store.ingest({ endpoint, eventId: `accepted-${endpoint.id}`, messageId: '100.000001', sender: { id: '123456', name: 'Участник' }, text: 'Previously accepted task' }, { rule, targetFingerprint: f.engine.targetFingerprint() });
    const intent = received.autoLinkIntent!;
    expect(intent).toBeDefined();
    if (status !== 'pending') {
      expect(f.store.claimAutoLinkIntent(intent.id)?.status).toBe('creating');
      if (status !== 'creating') f.store.updateAutoLinkIntent(intent.id, { status, ...(status === 'created' ? { threadId: 'thread-example' } : {}) });
    }
    return f.store.getAutoLinkIntent(intent.id)!;
  }

  it('blocks ordinary reassignment of accepted auto-intent events before any local conversation is created', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f); const intent = autoIntent(f, endpoint, 'pending');
    expect((await put(f, endpoint, 'route', { threadId: 'thread-other' })).statusCode).toBe(409);
    expect(f.store.listConversations()).toEqual([]);
    expect(f.store.listRequests()).toEqual([]);
    expect(f.store.getAutoLinkIntent(intent.id)).toEqual(intent);
  });

  it.each(['pending', 'creating', 'uncertain', 'failed', 'created'] as const)('blocks legacy conversation creation for a %s auto-intent without leaving an orphan', async status => {
    const f = makeApp(); const { endpoint } = attachSource(f); const intent = autoIntent(f, endpoint, status);
    const response = await f.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: {
      name: 'Must not recover implicitly', threadId: 'thread-example', cwd: '/work/example',
      bindings: [{ platform: endpoint.platform, endpointId: endpoint.id, allowedSenderIds: ['UANNA'] }],
    } });
    expect(response.statusCode, response.body).toBe(409);
    expect(f.store.listConversations()).toEqual([]);
    expect(f.store.bindingForEndpoint(endpoint.id)).toBeUndefined();
    expect(f.store.listRequests()).toEqual([]);
    expect(f.store.getAutoLinkIntent(intent.id)).toEqual(intent);
  });

  it.each(['add', 'legacy-add', 'scoped-target', 'legacy-target', 'scoped-origin', 'legacy-origin'] as const)('blocks legacy binding %s from implicitly resolving or moving an auto-intent', async path => {
    const f = makeApp(); const { endpoint } = attachSource(f); const intent = autoIntent(f, endpoint);
    const other = attachSource(f, { id: 'other-source', chatId: '-100002' }).endpoint;
    const fromIntent = path.endsWith('origin');
    if (fromIntent) f.store.routeSourceToThread(endpoint.id, { threadId: 'thread-example', cwd: '/work/example', name: 'Explicit recovery' }, intent.id);
    const conversation = fromIntent
      ? f.store.listConversations()[0]
      : f.store.createConversation({ name: 'Existing', threadId: 'thread-example', cwd: '/work/example',
        bindings: path.endsWith('target') ? [{ platform: other.platform, endpointId: other.id, allowedSenderIds: ['UANNA'] }] : [] });
    const before = f.store.listConversations();
    const isAdd = path === 'add';
    const bindingId = path.startsWith('scoped') ? conversation.bindings[0].id : endpoint.platform;
    const target = fromIntent ? other : endpoint;
    const response = await f.app.inject({ method: isAdd ? 'POST' : 'PUT',
      url: `/api/conversations/${conversation.id}/bindings${isAdd ? '' : `/${bindingId}`}`, headers,
      payload: { ...(isAdd ? { platform: target.platform } : {}), endpointId: target.id, allowedSenderIds: ['UANNA'] },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(f.store.listConversations()).toEqual(before);
    expect(f.store.listRequests()).toEqual([]);
    expect(f.store.getAutoLinkIntent(intent.id)).toEqual(intent);
  });

  it.each([{ threadId: null, resolveAutoLinkId: 'intent' }, { autoCreateCwd: '/work', resolveAutoLinkId: 'intent' }, { threadId: 'thread-example', resolveAutoLinkId: true }, { threadId: 'thread-example', resolveAutoLinkId: '' }])('rejects malformed explicit recovery: %j', async payload => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    expect((await put(f, endpoint, 'route', payload)).statusCode).toBe(400);
    expect(f.store.listConversations()).toEqual([]);
    expect(f.codex.listThreads).not.toHaveBeenCalled();
  });

  it.each(['pending', 'creating'] as const)('rejects explicit recovery while an auto-intent is %s', async status => {
    const f = makeApp(); const { endpoint } = attachSource(f); const intent = autoIntent(f, endpoint, status);
    expect((await put(f, endpoint, 'route', { threadId: 'thread-example', resolveAutoLinkId: intent.id })).statusCode).toBe(409);
    expect(f.store.listConversations()).toEqual([]);
  });

  it('rejects a foreign source, stale profile, unknown intent, wrong workspace or different acknowledged native ID during recovery', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f); const intent = autoIntent(f, endpoint, 'created');
    const other = attachSource(f, { id: 'other-source', chatId: '-100002' }).endpoint;
    expect((await put(f, other, 'route', { threadId: 'thread-example', resolveAutoLinkId: intent.id })).statusCode).toBe(404);
    expect((await put(f, endpoint, 'route', { threadId: 'thread-example', resolveAutoLinkId: 'missing' })).statusCode).toBe(404);
    f.engine.targetFingerprint.mockReturnValue('changed-profile');
    expect((await put(f, endpoint, 'route', { threadId: 'thread-example', resolveAutoLinkId: intent.id })).statusCode).toBe(409);
    f.engine.targetFingerprint.mockReturnValue(intent.targetFingerprint);
    expect((await put(f, endpoint, 'route', { threadId: 'thread-other', resolveAutoLinkId: intent.id })).statusCode).toBe(409);
    f.codex.listThreads.mockResolvedValue([{ id: 'different-ack-target', name: 'Та же рабочая папка', cwd: '/work/example', preview: '', updatedAt: 0 }]);
    expect((await put(f, endpoint, 'route', { threadId: 'different-ack-target', resolveAutoLinkId: intent.id })).statusCode).toBe(409);
    expect(f.store.listConversations()).toEqual([]);
    expect(f.store.listRequests()).toEqual([]);
  });

  it('explicitly resolves an unknown create ACK into a selected existing native thread with the same workspace and no native creation', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f); const intent = autoIntent(f, endpoint);
    const createNative = vi.fn(); Object.assign(f.codex, { createThread: createNative });
    const response = await put(f, endpoint, 'route', { threadId: 'thread-example', resolveAutoLinkId: intent.id });
    expect(response.statusCode, response.body).toBe(200);
    expect(f.store.listConversations()).toHaveLength(1);
    expect(f.store.listConversations()[0]).toMatchObject({ threadId: 'thread-example', cwd: intent.rule.cwd });
    expect(f.store.bindingForEndpoint(endpoint.id)?.conversationId).toBe(f.store.listConversations()[0].id);
    expect(createNative).not.toHaveBeenCalled();
    expect(f.codex.listThreads).toHaveBeenCalledExactlyOnceWith();
  });

  it('rechecks the original recovery profile after awaiting the native catalog', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f); const intent = autoIntent(f, endpoint);
    f.codex.listThreads.mockImplementationOnce(async () => {
      f.engine.targetFingerprint.mockReturnValue('changed-during-catalog');
      return [{ id: 'thread-example', name: 'Native', cwd: '/work/example', preview: '', updatedAt: 0 }];
    });
    expect((await put(f, endpoint, 'route', { threadId: 'thread-example', resolveAutoLinkId: intent.id })).statusCode).toBe(409);
    expect(f.store.listConversations()).toEqual([]);
  });

  it('allows automatic routing and source access on a verified fresh profile before its queue can be probed', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    const status = { ...f.codex.status(), queueSupported: false };
    vi.spyOn(f.codex, 'status').mockReturnValue(status);
    f.codex.listThreads.mockResolvedValue([]);
    expect((await put(f, endpoint, 'route', { autoCreateCwd: '/work/example' })).statusCode).toBe(200);
    expect(f.store.getSourceRoute(endpoint.id)).toEqual({ endpointId: endpoint.id, mode: 'auto', cwd: '/work/example' });
    expect((await put(f, endpoint, 'access', { mode: 'all' })).statusCode).toBe(200);
    expect(f.store.getSourceAccess(endpoint.id).mode).toBe('all');
    expect(status.queueSupported).toBe(false);
    expect(f.codex.listThreads).not.toHaveBeenCalled();
    expect(f.store.listConversations()).toEqual([]);
    expect(f.store.listRequests()).toEqual([]);
  });

  it.each(['connection', 'verified version'] as const)('requires a native %s when selecting automatic routing and enabling it later', async missing => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    vi.spyOn(f.codex, 'status').mockReturnValue({ ...f.codex.status(), connected: missing !== 'connection', queueSupported: false });
    f.codex.isVerifiedVersion.mockReturnValue(missing !== 'verified version');
    expect((await put(f, endpoint, 'route', { autoCreateCwd: '/work/example' })).statusCode).toBe(400);
    expect(f.store.getSourceRoute(endpoint.id).mode).toBe('none');
    f.store.routeSource(endpoint.id, null, '/work/example');
    expect((await put(f, endpoint, 'access', { mode: 'all' })).statusCode).toBe(400);
    expect(f.store.getSourceAccess(endpoint.id).mode).toBe('off');
  });

  it('requires explicit auto sources to be disabled before a Codex target change and validates their workspace again on enable', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    expect((await put(f, endpoint, 'route', { autoCreateCwd: '/work/example' })).statusCode).toBe(200);
    expect((await put(f, endpoint, 'access', { mode: 'all' })).statusCode).toBe(200);
    const codex = { transport: 'websocket', endpoint: 'ws://127.0.0.1:9077' };
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { codex } })).statusCode).toBe(400);
    expect(f.config.config.codex.transport).toBe('shared');
    expect((await put(f, endpoint, 'access', { mode: 'off' })).statusCode).toBe(200);
    expect((await f.app.inject({ method: 'PUT', url: '/api/config', headers, payload: { codex } })).statusCode).toBe(200);
    f.codex.runtimeInfo.mockReturnValue({ platformOs: 'windows', platformFamily: 'windows', codexHome: 'C:\\Users\\Example\\.codex', userAgent: 'test' });
    expect((await put(f, endpoint, 'access', { mode: 'all' })).statusCode).toBe(400);
    expect(f.store.getSourceAccess(endpoint.id).mode).toBe('off');
    expect((await put(f, endpoint, 'route', { autoCreateCwd: 'C:\\work\\example' })).statusCode).toBe(200);
    expect((await put(f, endpoint, 'access', { mode: 'all' })).statusCode).toBe(200);
  });

  it('preserves config-only legacy ACL when first assigning an existing native conversation', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f, { people: [{ id: '123456', name: 'Разрешённый человек' }] });
    const rule = { id: 'legacy-group-before-attach', enabled: true, platform: endpoint.platform, accountId: endpoint.accountId, chatId: endpoint.chatId, cwd: '/legacy/automatic', allowedSenderIds: ['123456'], allowAllSenders: false, requireMention: true };
    f.config.config.autoLinkRules = [rule];
    expect((await put(f, endpoint, 'route', { threadId: 'missing-native' })).statusCode).toBe(400);
    expect(f.store.getSourceAccess(endpoint.id).mode).toBe('off');
    expect(f.store.getSourceAccess(endpoint.id, rule)).toMatchObject({ mode: 'mention', legacy: true, allowedSenderIds: ['123456'] });
    expect((await put(f, endpoint, 'route', { threadId: 'thread-example' })).statusCode).toBe(200);
    expect(f.store.getSourceAccess(endpoint.id)).toEqual({ endpointId: endpoint.id, mode: 'mention', allowedSenderIds: ['123456'], legacy: true });
    const incoming = { endpoint, eventId: 'unlisted-after-manual-route', messageId: '200', sender: { id: '999999', name: 'Другой участник' }, text: 'Not allowed', directMention: true };
    expect(f.store.ingest(incoming).request).toBeNull();
    expect(f.store.ingest({ ...incoming, eventId: 'listed-after-manual-route', messageId: '201', sender: endpoint.people[0] }).request).not.toBeNull();
    expect(f.config.config.autoLinkRules).toEqual([rule]);
  });

  it('preserves a config-only legacy DM allowlist when disabling offline and ignores client replacement IDs', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f, { chatId: '123456', people: [{ id: '123456', name: 'Анна' }, { id: 'UAGENT', name: 'Агент', isBot: true }] });
    const rule = { id: 'legacy-dm-rule', enabled: true, platform: endpoint.platform, accountId: endpoint.accountId, chatId: endpoint.chatId, cwd: '/work/example', allowedSenderIds: ['123456'], requireMention: true };
    f.config.config.autoLinkRules = [rule];
    expect(f.store.getSourceAccess(endpoint.id, rule)).toMatchObject({ mode: 'mention', allowedSenderIds: ['123456'], legacy: true });
    f.engine.channels = {};
    expect((await put(f, endpoint, 'access', { mode: 'off', allowedSenderIds: ['UAGENT'] })).statusCode).toBe(200);
    const state = (await f.app.inject({ url: '/api/state', headers })).json();
    expect(state.sourceAccess.find((item: { endpointId: string }) => item.endpointId === endpoint.id)).toEqual({ endpointId: endpoint.id, mode: 'off', allowedSenderIds: ['123456'], legacy: false });
    expect(f.config.config.autoLinkRules).toEqual([rule]);
    expect(f.store.bindingForEndpoint(endpoint.id)).toBeUndefined();
  });

  it('shows legacy automatic routing while access is off and an explicit unlink suppresses only this source', async () => {
    const f = makeApp(); const { endpoint } = attachSource(f);
    f.config.config.autoLinkRules = [{ id: 'legacy-chat-rule', enabled: true, platform: endpoint.platform, accountId: endpoint.accountId, chatId: endpoint.chatId, cwd: '/work/example', allowedSenderIds: [], allowAllSenders: true, requireMention: true }];
    const state = async () => (await f.app.inject({ url: '/api/state', headers })).json();
    expect((await state()).sourceAccess.find((item: { endpointId: string }) => item.endpointId === endpoint.id)).toMatchObject({ mode: 'mention', legacy: true });
    expect((await put(f, endpoint, 'access', { mode: 'off' })).statusCode).toBe(200);
    expect((await state()).sourceRoutes.find((item: { endpointId: string }) => item.endpointId === endpoint.id)).toMatchObject({ mode: 'auto', cwd: '/work/example' });
    expect((await put(f, endpoint, 'route', { threadId: null })).statusCode).toBe(200);
    expect((await state()).sourceRoutes.find((item: { endpointId: string }) => item.endpointId === endpoint.id)).toMatchObject({ mode: 'none' });
    expect(f.config.config.autoLinkRules[0].enabled).toBe(true);
  });
});

it('protects message tools with panel authentication and accepts only the explicit call envelope', async () => {
  const f = makeApp();
  const payload = { threadId: 'native-thread', callId: 'native-call', name: 'send_message',
    arguments: { endpointId: 'linked-source', text: 'Synthetic message', mentionIds: [] } };
  expect((await f.app.inject({ method: 'POST', url: '/api/tools/call', headers: { host: headers.host }, payload })).statusCode).toBe(401);
  expect((await f.app.inject({ method: 'POST', url: '/api/tools/call', headers: { ...headers, origin: 'https://foreign.example' }, payload })).statusCode).toBe(403);
  for (const invalid of [{ ...payload, extra: true }, { ...payload, name: 'arbitrary_send' }, { ...payload, threadId: '' }, { ...payload, callId: [] }, { ...payload, arguments: null }]) {
    expect((await f.app.inject({ method: 'POST', url: '/api/tools/call', headers, payload: invalid })).statusCode).toBe(400);
  }
  expect(f.engine.messageTool).not.toHaveBeenCalled();
  const response = await f.app.inject({ method: 'POST', url: '/api/tools/call', headers, payload });
  expect(response.statusCode).toBe(200);
  expect(f.engine.messageTool).toHaveBeenCalledExactlyOnceWith(payload);
  expect(response.json()).toEqual({ operationId: 'synthetic-operation', status: 'pending' });
});

it('returns only fixed message tool validation errors and hides unexpected engine details', async () => {
  const f = makeApp();
  const payload = { threadId: 'native-thread', callId: 'native-call', name: 'list_destinations', arguments: {} };
  f.engine.messageTool.mockRejectedValueOnce(new MessageToolValidationError('destination_unavailable'));
  const rejected = await f.app.inject({ method: 'POST', url: '/api/tools/call', headers, payload });
  expect(rejected.statusCode).toBe(200);
  expect(rejected.json()).toEqual({ isError: true, code: 'destination_unavailable', error: 'Источник недоступен этому разговору Codex. Обновите list_destinations.' });
  f.engine.messageTool.mockRejectedValueOnce(new Error('synthetic-private-engine-detail'));
  const failed = await f.app.inject({ method: 'POST', url: '/api/tools/call', headers, payload });
  expect(failed.statusCode).toBe(500);
  expect(failed.body).not.toContain('synthetic-private-engine-detail');
});


describe('read-only message trace', () => {
  function traceFixture() {
    const f = makeApp();
    const conversation = f.store.createConversation({ name: 'Trace fixture', threadId: 'native-trace-thread', cwd: '/fixture',
      bindings: [{ platform: f.endpoint.platform, endpointId: f.endpoint.id, allowedSenderIds: ['sender-anna'] }] });
    const message = { eventId: 'trace-event', endpoint: f.endpoint, sender: f.endpoint.people[0], messageId: 'trace-message', text: 'private request body' };
    const request = f.store.ingest(message).request!;
    return { ...f, conversation, message, request, url: `/api/traces/requests/${request.id}` };
  }

  it('joins by request and immutable origin, excludes bodies, and keeps inspection read-only', async () => {
    const f = traceFixture();
    const other = { ...f.endpoint, id: 'other-source', platform: 'slack' as const, chatId: 'other-chat' };
    f.store.upsertEndpoint(other);
    f.store.addBinding(f.conversation.id, other.platform, other.id, ['sender-anna']);
    const second = f.store.ingest({ ...f.message, endpoint: other }).request!;
    f.store.finishRequest(f.request.id, { status: 'completed', turnId: 'own-turn' }, [{ key: 'final', ordinal: 0, kind: 'answer', body: 'private answer body' }]);
    f.store.finishRequest(second.id, { status: 'completed', turnId: 'other-turn' }, [{ key: 'final', ordinal: 0, kind: 'answer', body: 'other private conversation' }]);
    const own = f.store.listDeliveries().find(d => d.requestId === f.request.id)!;
    f.store.updateDelivery(own.id, { status: 'sent', remoteMessageId: 'provider-receipt' });
    const baseline = { requests: f.store.listRequests(), deliveries: f.store.listDeliveries() };
    expect((await f.app.inject({ url: f.url })).statusCode).toBe(401);
    const response = await f.app.inject({ url: f.url, headers });
    expect(response.statusCode).toBe(200);
    const trace = response.json();
    expect(trace).toMatchObject({ requestId: f.request.id, eventId: 'trace-event', nativeThreadId: 'native-trace-thread',
      source: { endpointId: f.endpoint.id, messageId: 'trace-message' }, latest: { stage: 'delivery', status: 'sent' } });
    expect(trace.deliveries).toEqual([{ id: own.id, kind: 'answer', status: 'sent', at: f.store.getDelivery(own.id)!.updatedAt, receipt: true }]);
    for (const secret of ['private request body', 'private answer body', 'other private conversation', telegramToken, 'synthetic-codex-secret']) expect(response.body).not.toContain(secret);
    const fromDelivery = await f.app.inject({ url: `/api/traces/deliveries/${own.id}`, headers });
    expect(fromDelivery.json()).toMatchObject({ requestId: f.request.id, source: trace.source, latest: trace.latest });
    await f.app.inject({ url: f.url, headers });
    expect({ requests: f.store.listRequests(), deliveries: f.store.listDeliveries() }).toEqual(baseline);
    expect(f.codex.connect).not.toHaveBeenCalled(); expect(f.engine.resume).not.toHaveBeenCalled();
    expect(f.engine.reconcile).not.toHaveBeenCalled(); expect(f.engine.cancel).not.toHaveBeenCalled(); expect(f.engine.retryDelivery).not.toHaveBeenCalled();
    expect((await f.app.inject({ url: f.url, headers, method: 'POST', payload: {} })).statusCode).toBe(404);
  });

  it.each([
    ['queued', {}, 'admission', 'queued'],
    ['starting', { queuedSubmissionId: 'queue-1' }, 'native', 'accepted'],
    ['running', { turnId: 'turn-1' }, 'execution', 'running'],
    ['uncertain', {}, 'native', 'uncertain'],
    ['failed', { error: 'Queue refused (untyped old error)' }, 'execution', 'failed'],
  ] as const)('reports %s only at its evidenced stage', async (status, patch, stage, expected) => {
    const f = traceFixture(); f.store.updateRequest(f.request.id, { status, ...patch });
    const response = await f.app.inject({ url: f.url, headers }); expect(response.statusCode).toBe(200);
    const trace = response.json();
    expect(trace.latest).toMatchObject({ stage, status: expected });
    expect(trace.steps.find((s: { stage: string }) => s.stage === 'admission').detail).toContain('не сохраня');
    expect(trace.steps.find((s: { stage: string }) => s.stage === 'delivery').status).toBe('no-data');
    expect(trace.nextAction).not.toMatch(/Повторить|повторите отправку/u);
    if (status === 'failed') expect(trace.latest.status).not.toBe('rejected');
  });

  it('recognizes a typed explicit enqueue rejection without inferring it from arbitrary error text', async () => {
    const f = traceFixture(); f.store.updateRequest(f.request.id, { status: 'failed', error: 'not exposed' });
    f.store.setMeta(`enqueue-rejected:${f.request.id}`, '2026-11-12T12:00:00.000Z');
    const response = await f.app.inject({ url: f.url, headers }); expect(response.statusCode).toBe(200);
    expect(response.json().latest).toEqual({ stage: 'native', status: 'rejected', at: '2026-11-12T12:00:00.000Z' });
    expect(response.body).not.toContain('not exposed');
  });

  it('does not call an error notification or partial multipart answer a delivered final', async () => {
    const f = traceFixture();
    f.store.finishRequest(f.request.id, { status: 'completed', turnId: 'turn-1' }, [
      { key: 'final:0', ordinal: 0, kind: 'answer', body: 'private first' },
      { key: 'final:1', ordinal: 1, kind: 'answer', body: 'private second' },
      { key: 'error', ordinal: 0, kind: 'error', body: 'private error' },
    ]);
    for (const d of f.store.listDeliveries()) f.store.updateDelivery(d.id, { status: d.key === 'final:1' ? 'uncertain' : 'sent', remoteMessageId: d.key === 'final:1' ? undefined : `remote-${d.id}` });
    const response = await f.app.inject({ url: f.url, headers }); expect(response.statusCode).toBe(200);
    expect(response.json().latest).toMatchObject({ stage: 'delivery', status: 'uncertain' });
    expect(response.json().nextAction).toMatch(/исходн.*чат/u);
    expect(response.json().nextAction).toMatch(/не повтор/u);
  });

  it('distinguishes a suppressed final from missing delivery evidence', async () => {
    const f = traceFixture();
    f.store.finishRequest(f.request.id, { status: 'completed', turnId: 'turn-1' }, [], true);
    const response = await f.app.inject({ url: f.url, headers }); expect(response.statusCode).toBe(200);
    expect(response.json().latest).toMatchObject({ stage: 'execution', status: 'suppressed' });
    expect(response.json().steps.find((s: { stage: string }) => s.stage === 'delivery').status).toBe('suppressed');
  });

  it('keeps duplicate requests identical and labels pre-start records after restart', async () => {
    const f = traceFixture();
    expect(f.store.ingest(f.message).request!.id).toBe(f.request.id);
    await f.app.close();
    const restarted = createApp({ store: f.store, config: f.config, engine: f.engine as unknown as Engine, codex: () => f.codex, configure: f.configure, version: 'fixture-restart' });
    opened.push({ app: restarted, store: new Store(':memory:') });
    const response = await restarted.inject({ url: f.url, headers }); expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ requestId: f.request.id, provenance: 'saved' });
    expect(response.json().capturedAt).toBeTruthy(); expect(response.json().startedAt).toBeTruthy();
  });

  it('keeps disconnect separate from the saved delivery receipt', async () => {
    const f = traceFixture(); f.codex.status = () => ({ configured: true, connected: false, queueSupported: true, desktopVerified: false });
    const response = await f.app.inject({ url: f.url, headers }); expect(response.statusCode).toBe(200);
    expect(response.json().connected).toEqual({ codex: false, source: false });
    expect(response.json().latest).toMatchObject({ status: 'queued' });
    expect(response.json().warnings.join(' ')).toMatch(/отключ/u);
  });

  it('returns no-data for an independent agent delivery rather than linking a shared native thread', async () => {
    const f = traceFixture();
    const d = f.store.addToolMessage({ threadId: f.conversation.threadId, callId: 'independent', conversationId: f.conversation.id, origin: f.request.origin, arguments: {}, text: 'private tool body', mentions: [] });
    const response = await f.app.inject({ url: `/api/traces/deliveries/${d.id}`, headers }); expect(response.statusCode).toBe(200);
    expect(response.json().requestId).toBeUndefined();
    expect(response.json().steps.find((s: { stage: string }) => s.stage === 'ingress').status).toBe('no-data');
    expect(response.body).not.toContain('private tool body');
  });
});
