import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type { AppConfig, ConfigStore } from './config.js';
import { mergeConfig, publicConfig } from './config.js';
import type { Store } from './store.js';
import type { Engine } from './engine.js';
import type { CodexClient } from './codex.js';
import type { DashboardState, Platform } from '../shared/types.js';

export interface AppServices {
  store: Store;
  config: ConfigStore;
  engine: Engine;
  codex: () => Pick<CodexClient, 'listThreads' | 'connect' | 'status'>;
  configure: (next: AppConfig) => Promise<void>;
  version: string;
  webDirectory?: string;
}

class ApiError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Ожидается объект.');
  return value as Record<string, unknown>;
}
function fields(body: Record<string, unknown>, allowed: string[]): void { if (Object.keys(body).some(key => !allowed.includes(key))) throw new ApiError(400, 'Неизвестное поле запроса.'); }
function string(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/u.test(value)) throw new ApiError(400, `Некорректное поле «${name}».`);
  return value.trim();
}
function platform(value: unknown): Platform { if (value !== 'telegram' && value !== 'slack') throw new ApiError(400, 'Неизвестный мессенджер.'); return value; }
function localHost(host: string | undefined): boolean {
  try { const url = new URL(`http://${host}`); return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { return false; }
}

export function createApp(services: AppServices) {
  const app = Fastify({ logger: false, bodyLimit: 100_000, requestTimeout: 30_000, trustProxy: false });
  const { store, config, engine } = services;
  app.addHook('onRequest', async (request, reply) => {
    if (!localHost(request.headers.host)) return reply.code(403).send({ error: 'Панель доступна только через локальный адрес.' });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}`) return reply.code(403).send({ error: 'Запрос с другого сайта запрещён.' });
    if ((request.url === '/api' || request.url.startsWith('/api/')) && request.url.split('?')[0] !== '/api/health' && !config.authorized(request.headers.authorization)) return reply.code(401).send({ error: 'Нужен ключ локальной панели Rele.' });
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (request.url.startsWith('/api')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    const message = config.redact(error);
    const duplicate = /UNIQUE constraint failed|already bound|already linked/u.test(message);
    const code = (error as { statusCode?: unknown }).statusCode;
    const status = duplicate ? 409 : error instanceof ApiError ? error.statusCode : typeof code === 'number' ? code : 400;
    reply.code(status).send({ error: duplicate ? 'Этот тред или чат уже используется в другой связке.' : message });
  });

  app.get('/api/health', async () => ({ ok: true, version: services.version }));
  app.get('/api/state', async (): Promise<DashboardState> => ({
    version: services.version,
    codex: services.codex().status(),
    connections: {
      telegram: engine.channels.telegram?.state ?? { configured: !!config.config.telegram.token, connected: false },
      slack: engine.channels.slack?.state ?? { configured: !!config.config.slack.botToken && !!config.config.slack.appToken, connected: false },
    },
    conversations: store.listConversations(), endpoints: store.listEndpoints().map(endpoint => ({ ...endpoint, title: store.getMeta(`endpoint-alias:${endpoint.id}`) || endpoint.title })), requests: store.listRequests(250), deliveries: store.listDeliveries(500), approvals: store.listApprovals(250), config: publicConfig(config.config),
  }));
  app.get('/api/threads', async () => ({ threads: await services.codex().listThreads() }));
  app.patch<{ Params: { id: string } }>('/api/endpoints/:id', async request => {
    const input = object(request.body); fields(input, ['title']);
    if (!store.getEndpoint(request.params.id)) throw new ApiError(404, 'Чат не найден.');
    const title = input.title === '' ? '' : string(input.title, 'название чата', 200);
    store.setMeta(`endpoint-alias:${request.params.id}`, title);
    return { ok: true };
  });
  app.post('/api/codex/connect', async () => { await services.codex().connect(); return { ok: true }; });
  let configuring = false;
  app.put('/api/config', async request => {
    if (configuring) throw new ApiError(409, 'Настройки уже сохраняются.');
    configuring = true;
    try { const next = mergeConfig(config.config, request.body); await services.configure(next); return { config: publicConfig(config.config) }; }
    finally { configuring = false; }
  });

  function binding(body: unknown, selected?: Platform) {
    const input = object(body);
    fields(input, selected ? ['endpointId', 'allowedSenderIds'] : ['platform', 'endpointId', 'allowedSenderIds']);
    const source = selected ?? platform(input.platform);
    const endpointId = string(input.endpointId, 'чат', 200);
    const endpoint = store.getEndpoint(endpointId);
    if (!endpoint || endpoint.platform !== source) throw new ApiError(400, 'Выберите известный чат нужного мессенджера.');
    const senders = input.allowedSenderIds;
    if (!Array.isArray(senders) || senders.length > 100 || senders.some(id => typeof id !== 'string' || !endpoint.people.some(person => person.id === id))) throw new ApiError(400, 'Выберите отправителей из участников чата.');
    return { platform: source, endpointId, allowedSenderIds: [...new Set(senders as string[])] };
  }
  app.post('/api/conversations', async request => {
    const input = object(request.body);
    fields(input, ['name', 'threadId', 'cwd', 'bindings']);
    const name = string(input.name, 'название', 200);
    const threadId = string(input.threadId, 'тред', 200);
    const cwd = string(input.cwd, 'каталог');
    const thread = (await services.codex().listThreads()).find(candidate => candidate.id === threadId);
    if (!thread || thread.cwd !== cwd) throw new ApiError(400, 'Тред или рабочий каталог изменился. Обновите список Codex.');
    if (input.bindings !== undefined && (!Array.isArray(input.bindings) || input.bindings.length > 2)) throw new ApiError(400, 'У связки может быть один Telegram и один Slack.');
    const bindings = (input.bindings as unknown[] | undefined)?.map(value => binding(value));
    const conversation = store.createConversation({ name, threadId, cwd, bindings });
    return { conversation };
  });
  app.patch<{ Params: { id: string } }>('/api/conversations/:id', async request => {
    const input = object(request.body); fields(input, ['name', 'paused']);
    if (!store.getConversation(request.params.id)) throw new ApiError(404, 'Связка не найдена.');
    const patch: { name?: string; paused?: boolean } = {};
    if (input.name !== undefined) patch.name = string(input.name, 'название', 200);
    if (input.paused !== undefined) { if (typeof input.paused !== 'boolean') throw new ApiError(400, 'Некорректное состояние паузы.'); patch.paused = input.paused; }
    const conversation = store.updateConversation(request.params.id, patch);
    return { conversation };
  });
  app.put<{ Params: { id: string; platform: string } }>('/api/conversations/:id/bindings/:platform', async request => {
    const selected = platform(request.params.platform);
    const value = binding(request.body, selected);
    if (!store.getConversation(request.params.id)) throw new ApiError(404, 'Связка не найдена.');
    store.setBinding(request.params.id, selected, value.endpointId, value.allowedSenderIds);
    return { conversation: store.getConversation(request.params.id) };
  });
  app.delete<{ Params: { id: string; platform: string } }>('/api/conversations/:id/bindings/:platform', async request => {
    if (!store.getConversation(request.params.id)) throw new ApiError(404, 'Связка не найдена.');
    store.removeBinding(request.params.id, platform(request.params.platform));
    return { conversation: store.getConversation(request.params.id) };
  });
  app.post<{ Params: { id: string } }>('/api/requests/:id/cancel', async request => { await engine.cancel(request.params.id); return { ok: true }; });
  app.post<{ Params: { id: string } }>('/api/requests/:id/resume', async request => { await engine.resume(request.params.id); return { ok: true }; });
  app.post<{ Params: { id: string } }>('/api/requests/:id/reconcile', async request => { await engine.reconcile(request.params.id); return { ok: true }; });
  app.post<{ Params: { id: string } }>('/api/deliveries/:id/retry', async request => { engine.retryDelivery(request.params.id); return { ok: true }; });
  app.post<{ Params: { id: string } }>('/api/approvals/:id/resolve', async request => {
    const input = object(request.body); fields(input, ['decision', 'answers']);
    if (input.decision !== 'accept' && input.decision !== 'decline') throw new ApiError(400, 'Неизвестный ответ на подтверждение.');
    const answers = input.answers === undefined ? undefined : object(input.answers);
    if (answers && Object.values(answers).some(value => !Array.isArray(value) || value.some(text => typeof text !== 'string' || text.length > 10_000))) throw new ApiError(400, 'Некорректные ответы.');
    await engine.resolveApproval(request.params.id, input.decision, answers as Record<string, string[]> | undefined);
    return { ok: true };
  });

  if (services.webDirectory && existsSync(services.webDirectory)) {
    app.register(fastifyStatic, { root: services.webDirectory, wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api') && !request.url.split('?')[0].includes('.')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Не найдено.' });
    });
  } else app.get('/', async (_request, reply) => reply.type('text/plain').send('Rele запущен. Соберите интерфейс командой npm run build.'));
  return app;
}
