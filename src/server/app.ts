import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { AppConfig, ConfigStore } from './config.js';
import { isLocalCodexHome, isLocalWorkspace, mergeConfig, publicConfig } from './config.js';
import type { Store } from './store.js';
import type { Engine } from './engine.js';
import type { CodexClient } from './codex.js';
import type { DashboardState, DesktopIntegrationState, Endpoint, Platform, SlackSyncJournal } from '../shared/types.js';
import { ChannelError } from './channels/common.js';
import { discoverCodex } from './codex-discovery.js';

export interface AppServices {
  store: Store;
  config: ConfigStore;
  engine: Engine;
  codex: () => Pick<CodexClient, 'listThreads' | 'connect' | 'status'> & Partial<Pick<CodexClient, 'runtimeInfo'>>;
  configure: (next: AppConfig) => Promise<void>;
  version: string;
  webDirectory?: string;
  shutdown?: () => Promise<void>;
  discoverCodex?: typeof discoverCodex;
  desktopIntegration?: {
    status(): Promise<DesktopIntegrationState>;
    shouldRetry(): Promise<boolean>;
    setEnabled(enabled: boolean): Promise<DesktopIntegrationState>;
  };
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
  const launchTokens = new Map<string, number>();
  app.addHook('onClose', async () => { launchTokens.clear(); });
  app.addHook('onRequest', async (request, reply) => {
    if (!localHost(request.headers.host)) return reply.code(403).send({ error: 'Панель доступна только через локальный адрес.' });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}`) return reply.code(403).send({ error: 'Запрос с другого сайта запрещён.' });
    const route = request.url.split('?')[0];
    const publicRequest = route === '/api/health' || (route === '/api/session/launch' && request.method === 'POST');
    if ((route === '/api' || route.startsWith('/api/')) && !publicRequest && !config.authorized(request.headers.authorization)) return reply.code(401).send({ error: 'Нужен ключ локальной панели Rele.' });
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
    if (status === 429 && error instanceof ChannelError) {
      const seconds = Number.isFinite(error.retryAfterMs) ? Math.max(1, Math.ceil(error.retryAfterMs / 1000)) : 30;
      reply.header('Retry-After', String(seconds));
      return reply.code(status).send({ error: `${message} Повторите через ${seconds} с.`, retryAfterSeconds: seconds });
    }
    reply.code(status).send({ error: duplicate ? 'Этот тред или чат уже используется в другой связке.' : message });
  });

  app.get('/api/health', async () => ({ ok: true, version: services.version }));
  app.get('/api/instance', async () => ({ pid: process.pid, version: services.version }));
  app.post('/api/session/launch-token', async () => {
    const now = Date.now();
    for (const [token, expires] of launchTokens) if (expires <= now) launchTokens.delete(token);
    // A launcher link grants local panel access once, for at most one minute.
    // Bound the map even when an authenticated launcher is called repeatedly.
    while (launchTokens.size >= 16) launchTokens.delete(launchTokens.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    launchTokens.set(token, now + 60_000);
    return { token, expiresInSeconds: 60 };
  });
  app.post('/api/session/launch', async request => {
    const body = object(request.body); fields(body, ['token']);
    const token = string(body.token, 'одноразовая ссылка', 128);
    const expires = launchTokens.get(token);
    launchTokens.delete(token);
    if (!expires || expires <= Date.now()) throw new ApiError(401, 'Ссылка недействительна или истекла. Откройте Rele заново.');
    return { key: config.panelToken };
  });
  app.post('/api/shutdown', async (_request, reply) => {
    if (!services.shutdown) throw new ApiError(503, 'Управление завершением недоступно в этом режиме.');
    // Finish the authenticated response before closing the HTTP listener.
    reply.raw.once('finish', () => {
      void services.shutdown!().catch(() => { process.stderr.write('Rele: не удалось штатно завершить фоновый процесс.\n'); });
    });
    return { ok: true };
  });
  app.get('/api/codex/discovery', async () => (services.discoverCodex ?? discoverCodex)(
    config.config.codex.codexHome ? { codexHome: config.config.codex.codexHome } : undefined,
  ));
  const autoLinks = () => store.listAutoLinkIntents().slice(-250).reverse().map(intent => ({ ...intent, ...(intent.error ? { error: config.redact(intent.error) } : {}) }));
  app.get('/api/auto-links', async () => ({ intents: autoLinks() }));
  app.get('/api/state', async (): Promise<DashboardState> => {
    const endpoints = store.listEndpoints().map(namedEndpoint);
    return {
      version: services.version,
      codex: services.codex().status(),
      connections: {
        telegram: engine.channels.telegram?.state ?? { configured: !!config.config.telegram.token, connected: false },
        slack: engine.channels.slack?.state ?? { configured: !!config.config.slack.botToken && !!config.config.slack.appToken, connected: false },
      },
      autoLinks: autoLinks(),
      sourceAccess: endpoints.map(endpoint => store.getSourceAccess(endpoint.id, legacyRule(endpoint))),
      sourceRoutes: endpoints.map(endpoint => store.getSourceRoute(endpoint.id, legacyRule(endpoint))),
      conversations: store.listConversations(), endpoints, requests: store.listRequests(250), deliveries: store.listDeliveries(500), approvals: store.listApprovals(250), config: publicConfig(config.config),
    };
  });
  app.get('/api/threads', async request => {
    const query = object(request.query); fields(query, ['archived', 'refresh']);
    if (query.archived !== undefined && query.archived !== 'true' && query.archived !== 'false') throw new ApiError(400, 'Некорректный фильтр архива Codex.');
    if (query.refresh !== undefined && query.refresh !== 'true' && query.refresh !== 'false') throw new ApiError(400, 'Некорректный режим обновления каталога Codex.');
    const codex = services.codex();
    const threads = await codex.listThreads({ archived: query.archived === 'true', ...(query.refresh === 'true' ? { refresh: true } : {}) });
    if (services.codex() !== codex) throw new ApiError(409, 'Подключение Codex изменилось. Обновите список разговоров.');
    return { threads };
  });
  const peopleCatalog = new Map<string, { channel: unknown; people: Map<string, boolean> }>();
  function rememberPeople(channel: unknown, accountId: string, chatId: string, people: Array<{ id: string; isBot?: boolean }>) {
    const key = JSON.stringify([accountId, chatId]);
    const known = peopleCatalog.get(key);
    const entry = known && known.channel === channel ? known : { channel, people: new Map<string, boolean>() };
    people.forEach(person => entry.people.set(person.id, !!person.isBot || !!entry.people.get(person.id)));
    peopleCatalog.set(key, entry);
    while (peopleCatalog.size > 100) peopleCatalog.delete(peopleCatalog.keys().next().value!);
  }
  function slackCatalog() {
    const channel = engine.channels.slack;
    if (!channel?.state.connected || !channel.listChats || !channel.listThreads || !channel.listPeople) throw new ApiError(503, 'Подключите Slack в разделе «Подключения», чтобы загрузить каталог.');
    return channel as typeof channel & Required<Pick<typeof channel, 'listChats' | 'listThreads' | 'listPeople'>>;
  }
  function catalogQuery(value: unknown, extra: string[] = []) {
    const query = object(value); fields(query, ['cursor', ...extra]);
    const cursor = query.cursor === undefined ? undefined : string(query.cursor, 'страница каталога', 2048);
    return { query, cursor };
  }
  function namedEndpoint(endpoint: Endpoint): Endpoint {
    return { ...endpoint, title: store.getMeta(`endpoint-alias:${endpoint.id}`) || endpoint.title };
  }
  app.get('/api/catalog/slack/chats', async request => {
    const { cursor } = catalogQuery(request.query);
    const channel = slackCatalog();
    const page = await channel.listChats(cursor);
    if (engine.channels.slack !== channel) throw new ApiError(409, 'Подключение Slack изменилось. Обновите каталог.');
    return page;
  });
  app.get('/api/catalog/slack/threads', async request => {
    const { query, cursor } = catalogQuery(request.query, ['chatId']);
    const channel = slackCatalog();
    const page = await channel.listThreads(string(query.chatId, 'канал Slack', 200), cursor);
    if (engine.channels.slack !== channel) throw new ApiError(409, 'Подключение Slack изменилось. Обновите каталог.');
    return { ...page, items: page.items.map(namedEndpoint) };
  });
  app.get('/api/catalog/slack/people', async request => {
    const { query, cursor } = catalogQuery(request.query, ['endpointId', 'chatId']);
    const channel = slackCatalog();
    if ((query.endpointId === undefined) === (query.chatId === undefined)) throw new ApiError(400, 'Выберите чат или обсуждение Slack.');
    const endpoint = query.endpointId === undefined ? undefined : store.getEndpoint(string(query.endpointId, 'обсуждение Slack', 200));
    if (query.endpointId !== undefined && (!endpoint || endpoint.platform !== 'slack' || endpoint.accountId !== channel.state.accountId)) throw new ApiError(404, 'Обсуждение не относится к подключённому Slack. Обновите каталог.');
    const chatId = endpoint?.chatId ?? string(query.chatId, 'канал Slack', 200);
    const accountId = channel.state.accountId!;
    const page = await channel.listPeople(chatId, cursor);
    if (engine.channels.slack !== channel || channel.state.accountId !== accountId) throw new ApiError(409, 'Подключение Slack изменилось. Обновите каталог.');
    rememberPeople(channel, accountId, chatId, page.items);
    if (endpoint) {
      const current = store.getEndpoint(endpoint.id)!;
      store.upsertEndpoint({ ...current, people: page.items });
    }
    return page;
  });
  app.get('/api/catalog/telegram', async () => engine.channels.telegram?.discoveryInfo?.() ?? { command: '/rele_register' });
  let configuring = false;
  let closing = false;
  let automaticIntegrationChecked = false;
  let automaticIntegration: Promise<void> | undefined;
  function retryDesktopIntegration(): void {
    const integration = services.desktopIntegration;
    if (!integration || closing || configuring || automaticIntegrationChecked || config.config.codex.transport !== 'shared') return;
    const codex = services.codex();
    const ready = () => {
      const status = codex.status();
      return !closing && config.config.codex.transport === 'shared' && services.codex() === codex && status.connected && status.queueSupported;
    };
    if (!ready()) return;
    configuring = true;
    automaticIntegration = (async () => {
      try {
        const pending = await integration.shouldRetry();
        if (!ready()) return;
        automaticIntegrationChecked = true;
        if (pending) await integration.setEnabled(true);
      } catch {
        // The native launcher records a warning; a failed automatic retry must not stop the gateway.
      } finally { configuring = false; automaticIntegration = undefined; }
    })();
  }
  app.addHook('onReady', async () => { engine.on('change', retryDesktopIntegration); retryDesktopIntegration(); });
  app.addHook('onClose', async () => {
    closing = true;
    engine.off('change', retryDesktopIntegration);
    await automaticIntegration;
  });
  app.get('/api/codex/desktop-integration', async (): Promise<DesktopIntegrationState> =>
    services.desktopIntegration?.status() ?? { available: false, enabled: false, lastCheckFailed: false });
  app.post('/api/codex/desktop-integration', async request => {
    const body = object(request.body); fields(body, ['enabled']);
    if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'enabled должен быть логическим значением.');
    if (configuring) throw new ApiError(409, 'Настройки сохраняются. Дождитесь завершения изменения подключения.');
    if (!services.desktopIntegration) throw new ApiError(400, 'Управление интеграцией доступно в установленном Rele для Windows.');
    if (body.enabled && config.config.codex.transport !== 'shared') throw new ApiError(400, 'Сначала выберите «Общий Codex» с исходным профилем и сохраните настройки.');
    automaticIntegrationChecked = true;
    configuring = true;
    try { return await services.desktopIntegration.setEnabled(body.enabled); }
    finally { configuring = false; }
  });
  function legacyRule(endpoint: Endpoint) {
    return config.config.autoLinkRules.find(rule => rule.enabled && rule.platform === endpoint.platform && rule.accountId === endpoint.accountId && rule.chatId === endpoint.chatId);
  }
  function sourceEndpoint(id: string, active: boolean) {
    const endpoint = store.getEndpoint(string(id, 'источник', 200));
    if (!endpoint) throw new ApiError(404, 'Источник не найден.');
    const channel = engine.channels[endpoint.platform];
    if (active && configuring) throw new ApiError(409, 'Настройки сохраняются. Дождитесь завершения подключения.');
    if (active && endpoint.platform === 'telegram' && endpoint.isForum && !endpoint.threadId && !endpoint.generalTopic) throw new ApiError(400, 'Выберите тему внутри группы Telegram.');
    if (active && (!config.config[endpoint.platform].enabled || !channel?.state.connected || channel.state.accountId !== endpoint.accountId || endpoint.available === false)) throw new ApiError(400, 'Выберите доступный источник текущего подключённого бота.');
    return { endpoint, channel };
  }
  function checkSource(source: ReturnType<typeof sourceEndpoint>) {
    if (configuring) throw new ApiError(409, 'Настройки сохраняются. Дождитесь завершения подключения.');
    const current = store.getEndpoint(source.endpoint.id);
    if (!current || current.accountId !== source.endpoint.accountId || current.chatId !== source.endpoint.chatId || current.threadId !== source.endpoint.threadId || current.available === false || engine.channels[current.platform] !== source.channel || !source.channel?.state.connected || source.channel.state.accountId !== current.accountId || !config.config[current.platform].enabled) throw new ApiError(409, 'Подключение источника изменилось. Обновите каталог.');
  }
  function validWorkspace(codex: ReturnType<AppServices['codex']>, cwd: string): boolean {
    const os = codex.runtimeInfo?.()?.platformOs ?? (config.config.codex.transport === 'managed' ? process.platform : undefined);
    return isLocalWorkspace(cwd) && (os === 'windows' || os === 'win32' ? isLocalCodexHome(cwd, 'win32')
      : !!os && ['linux', 'macos', 'darwin', 'freebsd', 'openbsd'].includes(os) && isLocalCodexHome(cwd, 'linux'));
  }
  function automaticWorkspace(codex: ReturnType<AppServices['codex']>, cwd: string) {
    const status = codex.status();
    if (!status.connected || !status.queueSupported) throw new ApiError(400, 'Для автосоздания подключите Codex с поддержкой штатной очереди.');
    if (!validWorkspace(codex, cwd)) throw new ApiError(400, 'Укажите абсолютную локальную рабочую папку операционной системы Codex.');
  }
  app.put<{ Params: { id: string } }>('/api/endpoints/:id/access', async request => {
    const input = object(request.body); fields(input, ['mode', 'allowedSenderIds']);
    if (input.mode !== 'off' && input.mode !== 'mention' && input.mode !== 'all') throw new ApiError(400, 'Неизвестный режим доступа источника.');
    const mode = input.mode;
    const source = sourceEndpoint(request.params.id, mode !== 'off');
    const { endpoint, channel } = source;
    const codex = services.codex();
    const selectedSenders = input.allowedSenderIds === undefined ? store.getSourceAccess(endpoint.id, legacyRule(endpoint)).allowedSenderIds : input.allowedSenderIds;
    if (!Array.isArray(selectedSenders) || selectedSenders.length > 100 || selectedSenders.some(id => typeof id !== 'string' || !id.trim() || id.length > 200 || /[\x00-\x1f\x7f]/u.test(id))) throw new ApiError(400, 'Некорректный список отправителей источника.');
    const senders = [...new Set(selectedSenders as string[])];
    const direct = endpoint.platform === 'slack' ? /^D[A-Z0-9]+$/u.test(endpoint.chatId) : /^\d+$/u.test(endpoint.chatId);
    const group = endpoint.platform === 'slack' ? /^[CG][A-Z0-9]+$/u.test(endpoint.chatId) : /^-\d+$/u.test(endpoint.chatId);
    if (mode !== 'off') {
      if (!direct && !group) throw new ApiError(400, 'Некорректный чат источника. Обновите каталог.');
      if (endpoint.platform === 'slack') {
        if (!channel?.listPeople) throw new ApiError(400, 'Каталог участников Slack недоступен.');
        const page = await channel.listPeople(endpoint.chatId);
        checkSource(source);
        rememberPeople(channel, endpoint.accountId, endpoint.chatId, page.items);
        const people = new Map(store.getEndpoint(endpoint.id)!.people.map(person => [person.id, person]));
        for (const person of page.items) people.set(person.id, { ...person, isBot: !!person.isBot || !!people.get(person.id)?.isBot });
        store.upsertEndpoint({ ...store.getEndpoint(endpoint.id)!, people: [...people.values()] });
      }
      const people = new Map(store.getEndpoint(endpoint.id)!.people.map(person => [person.id, !!person.isBot]));
      if (direct && (!senders.length || senders.some(id => !people.has(id) || people.get(id) || endpoint.platform === 'telegram' && id !== endpoint.chatId))) throw new ApiError(400, 'В личном чате выберите только участвующих в нём людей.');
      checkSource(source);
      const route = store.getSourceRoute(endpoint.id, legacyRule(endpoint));
      if (route.mode === 'auto') {
        if (services.codex() !== codex) throw new ApiError(409, 'Подключение Codex изменилось. Проверьте маршрут источника.');
        automaticWorkspace(codex, route.cwd ?? '');
      }
    }
    store.setSourceAccess(endpoint.id, mode === 'off' ? { mode, allowedSenderIds: store.getSourceAccess(endpoint.id, legacyRule(endpoint)).allowedSenderIds } : { mode, allowedSenderIds: direct ? senders : [] });
    return { ok: true };
  });
  function recoverableAutoLink(endpoint: Endpoint, id: string) {
    const intent = store.getAutoLinkIntent(id);
    if (!intent || intent.endpointId !== endpoint.id) throw new ApiError(404, 'Автосоздание не относится к этому источнику.');
    if (!['uncertain', 'failed', 'created'].includes(intent.status)) throw new ApiError(409, 'Автосоздание ещё выполняется или уже завершено. Обновите состояние.');
    if (engine.targetFingerprint() !== intent.targetFingerprint) throw new ApiError(409, 'Подключение Codex отличается от принятого запроса автосоздания.');
    return intent;
  }
  app.put<{ Params: { id: string } }>('/api/endpoints/:id/route', async request => {
    const input = object(request.body); fields(input, ['threadId', 'autoCreateCwd', 'resolveAutoLinkId']);
    if (input.resolveAutoLinkId !== undefined && (typeof input.threadId !== 'string' || input.autoCreateCwd !== undefined)) throw new ApiError(400, 'Восстановление автосоздания требует конкретный разговор Codex.');
    const resolveAutoLinkId = input.resolveAutoLinkId === undefined ? undefined : string(input.resolveAutoLinkId, 'автосоздание', 200);
    if ((input.threadId === undefined) === (input.autoCreateCwd === undefined)) throw new ApiError(400, 'Выберите разговор Codex, автосоздание или отключение маршрута.');
    const source = sourceEndpoint(request.params.id, input.threadId !== null);
    if (input.threadId === null) { store.routeSource(source.endpoint.id, null, undefined, legacyRule(source.endpoint)); return { ok: true }; }
    const codex = services.codex();
    if (input.autoCreateCwd !== undefined) {
      const cwd = string(input.autoCreateCwd, 'рабочая папка');
      automaticWorkspace(codex, cwd);
      checkSource(source);
      store.routeSource(source.endpoint.id, null, cwd, legacyRule(source.endpoint));
    } else {
      if (!codex.status().connected) throw new ApiError(400, 'Подключите Codex перед выбором маршрута.');
      const threadId = string(input.threadId, 'разговор Codex', 200);
      if (resolveAutoLinkId) recoverableAutoLink(source.endpoint, resolveAutoLinkId);
      const thread = (await codex.listThreads({ refresh: true })).find(candidate => candidate.id === threadId);
      if (services.codex() !== codex || !codex.status().connected) throw new ApiError(409, 'Подключение Codex изменилось. Обновите список разговоров.');
      checkSource(source);
      if (!thread || thread.archived || !validWorkspace(codex, thread.cwd)) throw new ApiError(400, 'Выберите доступный разговор Codex с локальной рабочей папкой.');
      if (resolveAutoLinkId) {
        const intent = recoverableAutoLink(source.endpoint, resolveAutoLinkId);
        if (intent.threadId && intent.threadId !== thread.id) throw new ApiError(409, 'Выберите известный разговор принятого автосоздания.');
      }
      store.routeSourceToThread(source.endpoint.id, { threadId: thread.id, cwd: thread.cwd, name: thread.name || 'Разговор Codex' }, resolveAutoLinkId, legacyRule(source.endpoint));
    }
    return { ok: true };
  });
  app.patch<{ Params: { id: string } }>('/api/endpoints/:id', async request => {
    const input = object(request.body); fields(input, ['title']);
    if (!store.getEndpoint(request.params.id)) throw new ApiError(404, 'Чат не найден.');
    const title = input.title === '' ? '' : string(input.title, 'название чата', 200);
    store.setMeta(`endpoint-alias:${request.params.id}`, title);
    return { ok: true };
  });
  app.post('/api/codex/connect', async () => {
    if (configuring) throw new ApiError(409, 'Настройки сохраняются. Дождитесь перезапуска подключения Codex.');
    await services.codex().connect(); return { ok: true };
  });
  app.put('/api/config', async request => {
    if (configuring) throw new ApiError(409, 'Настройки уже сохраняются.');
    configuring = true;
    try { const next = mergeConfig(config.config, request.body); await validateAutoLinkRules(next); await services.configure(next); return { config: publicConfig(config.config) }; }
    finally { configuring = false; retryDesktopIntegration(); }
  });

  async function validateAutoLinkRules(next: AppConfig) {
    const target = (value: AppConfig) => JSON.stringify([value.codex.transport, value.codex.executable, value.codex.endpoint, value.codex.codexHome ?? '']);
    const targetChanged = target(next) !== target(config.config);
    const activeAutomaticSource = store.listEndpoints().some(endpoint => store.getSourceRoute(endpoint.id).mode === 'auto' && store.getSourceAccess(endpoint.id).mode !== 'off');
    if (targetChanged && (next.autoLinkRules.some(rule => rule.enabled) || activeAutomaticSource)) throw new ApiError(400, 'Отключите правила автосоздания и доступ источников с автосозданием, затем смените подключение Codex, проверьте рабочие папки и включите доступ заново.');
    if (targetChanged) return;
    const codex = services.codex();
    for (const rule of next.autoLinkRules) {
      const previous = config.config.autoLinkRules?.find(candidate => candidate.id === rule.id);
      if (previous && JSON.stringify(previous) === JSON.stringify(rule)) continue;
      // Disabling an existing rule must remain possible while its connector is offline.
      if (previous && !rule.enabled && JSON.stringify({ ...previous, enabled: false }) === JSON.stringify(rule)) continue;
      if (!codex.status().connected || !validWorkspace(codex, rule.cwd)) throw new ApiError(400, 'Подключите Codex и укажите абсолютную рабочую папку его операционной системы.');
      const channel = engine.channels[rule.platform];
      if (!next[rule.platform].enabled || !channel?.state.connected || channel.state.accountId !== rule.accountId) throw new ApiError(400, 'Правило должно относиться к текущему подключённому боту.');
      const endpoints = store.listEndpoints().filter(endpoint => endpoint.platform === rule.platform && endpoint.accountId === rule.accountId && endpoint.chatId === rule.chatId && endpoint.available !== false);
      let people = new Map(endpoints.flatMap(endpoint => endpoint.people.map(person => [person.id, !!person.isBot] as const)));
      if (rule.platform === 'slack') {
        if (!channel.listPeople) throw new ApiError(400, 'Каталог участников Slack недоступен.');
        // This read also verifies that the selected channel is currently available to this bot.
        const page = await channel.listPeople(rule.chatId);
        if (engine.channels.slack !== channel || channel.state.accountId !== rule.accountId || services.codex() !== codex) throw new ApiError(409, 'Подключение изменилось. Обновите каталог.');
        rememberPeople(channel, rule.accountId, rule.chatId, page.items);
        people = peopleCatalog.get(JSON.stringify([rule.accountId, rule.chatId]))!.people;
      } else if (!endpoints.length) throw new ApiError(400, 'Выберите доступный обнаруженный чат Telegram.');
      if (rule.allowedSenderIds.some(id => !people.has(id))) throw new ApiError(400, 'Выберите отправителей правила из участников выбранного чата.');
      const direct = rule.platform === 'slack' ? rule.chatId.startsWith('D') : /^\d+$/u.test(rule.chatId);
      if (direct && (rule.allowAllSenders || rule.allowedSenderIds.some(id => people.get(id) || rule.platform === 'telegram' && id !== rule.chatId))) throw new ApiError(400, 'В личном чате разрешите только людей, участвующих в этом чате.');
      if (engine.channels[rule.platform] !== channel || !channel.state.connected || channel.state.accountId !== rule.accountId || services.codex() !== codex) throw new ApiError(409, 'Подключение изменилось. Обновите каталог.');
    }
  }

  function guardLegacyBinding(endpointId: string) {
    if (store.listAutoLinkIntents().some(intent => intent.endpointId === endpointId && intent.status !== 'completed')) throw new ApiError(409, 'Принято автосоздание этого источника. Восстановите его явно через назначение разговора Codex.');
  }
  function binding(body: unknown, selected?: Platform) {
    const input = object(body);
    fields(input, selected ? ['endpointId', 'allowedSenderIds', 'allowAllSenders', 'requireMention'] : ['platform', 'endpointId', 'allowedSenderIds', 'allowAllSenders', 'requireMention']);
    const source = selected ?? platform(input.platform);
    const endpointId = string(input.endpointId, 'чат', 200);
    const endpoint = store.getEndpoint(endpointId);
    if (!endpoint || endpoint.platform !== source) throw new ApiError(400, 'Выберите известный чат нужного мессенджера.');
    guardLegacyBinding(endpointId);
    const accountId = engine.channels[source]?.state.accountId;
    if (accountId && endpoint.accountId !== accountId) throw new ApiError(400, 'Этот чат относится к другому боту. Обновите каталог.');
    if (endpoint.available === false) throw new ApiError(400, 'У бота больше нет доступа к этому чату. Добавьте бота и обновите каталог.');
    if (source === 'telegram' && endpoint.isForum && !endpoint.threadId && !endpoint.generalTopic) throw new ApiError(400, 'Выберите тему внутри группы Telegram.');
    for (const key of ['allowAllSenders', 'requireMention']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new ApiError(400, 'Некорректная политика доступа подключения.');
    if (input.allowAllSenders && (source === 'slack' ? !/^[CG][A-Z0-9]+$/u.test(endpoint.chatId) : !/^-\d+$/u.test(endpoint.chatId))) throw new ApiError(400, 'В личных чатах выберите отдельных людей.');
    const senders = input.allowedSenderIds;
    if (!Array.isArray(senders) || senders.length > 100 || senders.some(id => typeof id !== 'string' || !endpoint.people.some(person => person.id === id))) throw new ApiError(400, 'Выберите отправителей из участников чата.');
    return { platform: source, endpointId, allowedSenderIds: [...new Set(senders as string[])], ...(input.allowAllSenders !== undefined ? { allowAllSenders: input.allowAllSenders as boolean } : {}), ...(input.requireMention !== undefined ? { requireMention: input.requireMention as boolean } : {}) };
  }
  app.post('/api/conversations', async request => {
    const input = object(request.body);
    fields(input, ['name', 'threadId', 'cwd', 'bindings']);
    const name = string(input.name, 'название', 200);
    const threadId = string(input.threadId, 'тред', 200);
    const cwd = string(input.cwd, 'каталог');
    const codex = services.codex();
    const thread = (await codex.listThreads()).find(candidate => candidate.id === threadId);
    if (services.codex() !== codex) throw new ApiError(409, 'Подключение Codex изменилось. Обновите список разговоров.');
    if (!thread || thread.archived || thread.cwd !== cwd) throw new ApiError(400, 'Тред или рабочий каталог изменился. Обновите список Codex; архивный разговор сначала восстановите в Codex.');
    if (input.bindings !== undefined && (!Array.isArray(input.bindings) || input.bindings.length > 100)) throw new ApiError(400, 'У связки может быть не более 100 подключений.');
    const bindings = (input.bindings as unknown[] | undefined)?.map(value => binding(value));
    const conversation = store.createConversation({ name, threadId, cwd, bindings });
    return { conversation };
  });
  app.get<{ Params: { id: string } }>('/api/conversations/:id/slack-sync', async (request): Promise<SlackSyncJournal> => {
    const conversationId = string(request.params.id, 'связка', 200);
    if (!store.getConversation(conversationId)) throw new ApiError(404, 'Связка не найдена.');
    const query = object(request.query); fields(query, ['streamId', 'offset', 'limit']);
    const streamId = query.streamId === undefined ? undefined : string(query.streamId, 'журнал Slack', 200);
    const integer = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw new ApiError(400, 'Некорректная страница журнала Slack.');
      return Number(value);
    };
    const offset = integer(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(query.limit, 50, 1, 100);
    const streams = store.listSlackSyncStreams().filter(stream => stream.conversationId === conversationId);
    const selected = streamId === undefined ? streams[0] : streams.find(stream => stream.id === streamId);
    if (streamId !== undefined && !selected) throw new ApiError(404, 'Журнал Slack не относится к этой связке.');
    const page = selected ? store.listSlackSyncEntries(selected.id, { offset, limit: limit + 1 }) : [];
    return {
      streams: streams.map(stream => ({ id: stream.id, endpointId: stream.endpointId,
        title: store.getMeta(`endpoint-alias:${stream.endpointId}`) || store.getEndpoint(stream.endpointId)?.title || 'Обсуждение Slack',
        active: stream.active, paused: stream.paused, state: stream.state, coveredThrough: stream.coveredThrough,
        error: stream.error, counts: store.getSlackSyncCounts(stream.id) })),
      ...(selected ? { streamId: selected.id } : {}),
      entries: page.slice(0, limit).map(entry => ({ id: entry.id, message: entry.message, state: entry.state, error: entry.error, createdAt: entry.createdAt })),
      ...(page.length > limit ? { nextOffset: offset + limit } : {}),
    };
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
  app.post<{ Params: { id: string } }>('/api/conversations/:id/bindings', async request => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) throw new ApiError(404, 'Связка не найдена.');
    if (conversation.bindings.length >= 100) throw new ApiError(400, 'У связки может быть не более 100 подключений.');
    const value = binding(request.body);
    store.addBinding(conversation.id, value.platform, value.endpointId, value.allowedSenderIds, value);
    return { conversation: store.getConversation(conversation.id) };
  });
  function selectedBinding(conversationId: string, bindingId: string) {
    const conversation = store.getConversation(conversationId);
    if (!conversation) throw new ApiError(404, 'Связка не найдена.');
    // Old panels address a platform. Never let that route modify several independent origins.
    if (bindingId === 'slack' || bindingId === 'telegram') {
      const matches = conversation.bindings.filter(item => item.platform === bindingId);
      if (matches.length > 1) throw new ApiError(409, 'Укажите отдельное подключение этой связки. Обновите панель.');
      return { conversation, value: matches[0], legacy: bindingId };
    }
    const value = store.getBinding(conversationId, bindingId);
    if (!value) throw new ApiError(404, 'Подключение не относится к этой связке.');
    return { conversation, value };
  }
  app.put<{ Params: { id: string; bindingId: string } }>('/api/conversations/:id/bindings/:bindingId', async request => {
    const selected = selectedBinding(request.params.id, request.params.bindingId);
    if (selected.value) guardLegacyBinding(selected.value.endpointId);
    if (!selected.value && selected.conversation.bindings.length >= 100) throw new ApiError(400, 'У связки может быть не более 100 подключений.');
    const value = binding(request.body, selected.value?.platform ?? platform(selected.legacy));
    if (selected.value) store.updateBinding(selected.conversation.id, selected.value.id, value.endpointId, value.allowedSenderIds, value);
    else store.addBinding(selected.conversation.id, value.platform, value.endpointId, value.allowedSenderIds, value);
    return { conversation: store.getConversation(selected.conversation.id) };
  });
  app.delete<{ Params: { id: string; bindingId: string } }>('/api/conversations/:id/bindings/:bindingId', async request => {
    const selected = selectedBinding(request.params.id, request.params.bindingId);
    if (selected.value) store.removeBinding(selected.conversation.id, selected.value.id);
    return { conversation: store.getConversation(selected.conversation.id) };
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
