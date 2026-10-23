import type { Page } from '@playwright/test';
import type {
  CodexThread,
  CodexDiscoveryResult,
  CatalogChat,
  CatalogPage,
  Conversation,
  DashboardState,
  Endpoint,
  Platform,
  Person,
  ReleRequest,
  SourceAccess,
  SourceRoute,
} from '../../src/shared/types';

// Entirely fictional data. Never imported by the production application.
export const panelToken = 'rele-e2e-synthetic-panel-token';
export function fixtureDiscovery(): CodexDiscoveryResult {
  const connection = {
    executable: '/opt/example/codex',
    transport: 'proxy' as const,
    endpoint: '',
  };
  const managedConnection = { ...connection, transport: 'managed' as const };
  return {
    installations: [
      {
        executable: connection.executable,
        name: 'Codex CLI (пример)',
        source: 'path',
        version: '0.163.0-alpha.10.2',
        running: false,
        connection,
        managedConnection,
      },
    ],
    recommended: connection,
    recommendedManaged: managedConnection,
    issues: [],
  };
}
const now = '2026-10-18T20:00:00.000Z';
export const threads: CodexThread[] = [
  {
    id: 'thread-alpha',
    name: 'Пример: проект Альфа',
    cwd: '/work/alpha',
    preview: 'Обсуждение API',
    updatedAt: 1792353600,
  },
  {
    id: 'thread-docs',
    name: 'Пример: документация',
    cwd: '/work/docs',
    preview: 'Описание приложения',
    updatedAt: 1792353600,
  },
  {
    id: 'thread-support',
    name: 'Пример: поддержка',
    cwd: '/work/support',
    preview: 'Разбор обращений',
    updatedAt: 1792353600,
  },
  {
    id: 'thread-new',
    name: 'Пример: новый проект',
    cwd: '/work/new',
    preview: 'Новая задача',
    updatedAt: 1792353600,
  },
  {
    id: 'thread-archived',
    name: 'Пример: архивный проект',
    cwd: '/work/archive',
    preview: 'Старая идея приложения',
    updatedAt: 1792353600,
    archived: true,
  },
];

export function fixtureEndpoint(
  id: string,
  platform: Platform,
  title: string,
  subtitle: string,
): Endpoint {
  return {
    id,
    platform,
    accountId: `${platform}-test-account`,
    chatId: `${id}-chat`,
    threadId: `${id}-thread`,
    title,
    subtitle,
    people: [
      { id: 'person-anna', name: 'Анна (пример)' },
      { id: 'person-mikhail', name: 'Михаил (пример)' },
    ],
    updatedAt: now,
  };
}

export function fixtureState(empty = false): DashboardState {
  const endpoints = [
    fixtureEndpoint('tg-alpha', 'telegram', 'Команда Альфа', 'Разработка'),
    fixtureEndpoint('sl-alpha', 'slack', '#alpha-dev', 'Обсуждение API'),
    fixtureEndpoint('tg-docs', 'telegram', 'Документация', 'Общий'),
    fixtureEndpoint('tg-support', 'telegram', 'Поддержка', 'Заявки'),
    fixtureEndpoint('sl-support', 'slack', '#support', 'Разбор обращений'),
    fixtureEndpoint('tg-new', 'telegram', 'Пример: новый чат', 'Разработка'),
    fixtureEndpoint('sl-new', 'slack', '#example-new', 'Пример нового треда'),
  ];
  const conversations: Conversation[] = empty
    ? []
    : threads.slice(0, 3).map((thread, index) => {
        const conversationId = `conversation-${index}`;
        const targets =
          index === 0
            ? ['tg-alpha', 'sl-alpha']
            : index === 1
              ? ['tg-docs']
              : ['tg-support', 'sl-support'];
        return {
          id: conversationId,
          name: thread.name,
          threadId: thread.id,
          cwd: thread.cwd,
          paused: index === 1,
          createdAt: now,
          updatedAt: now,
          bindings: targets.map((id) => {
            const target = endpoints.find((item) => item.id === id)!;
            return {
              id: `binding-${id}`,
              conversationId,
              endpointId: target.id,
              platform: target.platform,
              allowedSenderIds: ['person-anna'],
            };
          }),
        };
      });
  return {
    version: '0.1.0-rc.13',
    codex: {
      configured: true,
      connected: true,
      queueSupported: true,
      desktopVerified: false,
      name: 'Codex 0.163.0-alpha.10.2',
      executable: '/opt/example/codex',
      transport: 'managed',
      endpoint: '',
      codexHome: '/home/example/.codex',
    },
    connections: {
      telegram: {
        configured: true,
        connected: true,
        name: 'Пример бота',
        accountId: 'telegram-test-account',
      },
      slack: {
        configured: true,
        connected: true,
        name: 'Пример workspace',
        accountId: 'slack-test-account',
      },
    },
    conversations,
    endpoints,
    requests: empty ? [] : [fixtureRequest('request-running', 'running')],
    deliveries: [],
    approvals: [],
    autoLinks: [],
    config: {
      autoLinkRules: [],
      codex: {
        transport: 'managed',
        executable: 'codex',
        endpoint: '',
        tokenConfigured: false,
      },
      telegram: { enabled: true, tokenConfigured: true },
      slack: {
        enabled: true,
        botTokenConfigured: true,
        appTokenConfigured: true,
      },
      voice: {
        enabled: false,
        python: 'python3',
        model: '',
        language: 'ru',
        device: 'cpu',
      },
    },
  };
}

export function fixtureRequest(
  id: string,
  status: ReleRequest['status'] = 'queued',
): ReleRequest {
  return {
    id,
    conversationId: 'conversation-2',
    eventId: `event-${id}`,
    origin: {
      platform: 'telegram',
      accountId: 'telegram-test-account',
      endpointId: 'tg-support',
      chatId: 'tg-support-chat',
      threadId: 'tg-support-thread',
      senderId: 'person-anna',
      senderName: 'Анна (пример)',
      messageId: `message-${id}`,
    },
    text: 'Пример запроса: проверь описание API.',
    status,
    turnId: status === 'queued' ? undefined : `turn-${id}`,
    createdAt: now,
    updatedAt: now,
  };
}

interface CatalogFixture {
  discovery?: CodexDiscoveryResult;
  telegram?: { botUrl?: string; command: string };
  chats?: CatalogPage<CatalogChat>[];
  threads?: Record<string, CatalogPage<Endpoint>[]>;
  people?: Record<string, CatalogPage<Person>[]>;
  beforeThreads?: (chatId: string) => Promise<void>;
}

export async function installApi(
  page: Page,
  state = fixtureState(),
  catalog: CatalogFixture = {},
) {
  const mutations: Array<{ method: string; path: string; body: unknown }> = [];
  const reads: string[] = [];
  const completedThreadChats: string[] = [];
  const sourceTitles = new Map(
    state.endpoints.map((item) => [item.id, item.title]),
  );
  const sourceAccess = (endpoint: Endpoint): SourceAccess => {
    const saved = state.sourceAccess?.find(item => item.endpointId === endpoint.id);
    if (saved) return saved;
    const binding = state.conversations.flatMap(item => item.bindings).find(item => item.endpointId === endpoint.id);
    const rule = state.config.autoLinkRules?.find(item => item.enabled && item.platform === endpoint.platform && item.accountId === endpoint.accountId && item.chatId === endpoint.chatId);
    const policy = binding ?? rule;
    return { endpointId: endpoint.id, mode: policy && (policy.allowAllSenders || policy.allowedSenderIds.length) ? policy.requireMention ? 'mention' : 'all' : 'off', allowedSenderIds: policy?.allowedSenderIds ?? [], legacy: !!policy };
  };
  const sourceRoute = (endpoint: Endpoint): SourceRoute => {
    const saved = state.sourceRoutes?.find(item => item.endpointId === endpoint.id);
    if (saved) return saved;
    const bound = state.conversations.some(item => item.bindings.some(binding => binding.endpointId === endpoint.id));
    const rule = state.config.autoLinkRules?.find(item => item.enabled && item.platform === endpoint.platform && item.accountId === endpoint.accountId && item.chatId === endpoint.chatId);
    return { endpointId: endpoint.id, mode: bound ? 'manual' : rule ? 'auto' : 'none', ...(rule && !bound ? { cwd: rule.cwd } : {}) };
  };
  let offline = false;
  let mutationError = '';
  const catalogPage = <T>(
    pages: CatalogPage<T>[],
    cursor: string | null,
  ): CatalogPage<T> => {
    const index = cursor
      ? pages.findIndex(
          (item, i) => i > 0 && pages[i - 1].nextCursor === cursor,
        )
      : 0;
    return pages[index] ?? { items: [] };
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (offline) {
      await route.abort('connectionrefused');
      return;
    }
    if (request.headers().authorization !== `Bearer ${panelToken}`) {
      await route.fulfill({ status: 401, json: { error: 'Unauthorized' } });
      return;
    }
    if (request.method() === 'GET') reads.push(url.pathname + url.search);
    if (request.method() === 'GET' && url.pathname === '/api/state') {
      await route.fulfill({ json: { ...state, sourceAccess: state.endpoints.map(sourceAccess), sourceRoutes: state.endpoints.map(sourceRoute) } });
      return;
    }
    if (request.method() === 'GET' && /^\/api\/conversations\/[^/]+\/slack-sync$/.test(url.pathname)) {
      await route.fulfill({ json: { streams: [], entries: [] } });
      return;
    }
    if (request.method() === 'GET' && url.pathname === '/api/codex/discovery') {
      await route.fulfill({ json: catalog.discovery ?? fixtureDiscovery() });
      return;
    }
    if (request.method() === 'GET' && url.pathname === '/api/codex/desktop-integration') {
      await route.fulfill({ json: { available: false, enabled: false, lastCheckFailed: false } });
      return;
    }
    if (request.method() === 'GET' && url.pathname === '/api/threads') {
      await route.fulfill({
        json: {
          threads: threads.filter(
            (thread) =>
              !!thread.archived ===
              (url.searchParams.get('archived') === 'true'),
          ),
        },
      });
      return;
    }
    if (
      request.method() === 'GET' &&
      url.pathname === '/api/catalog/telegram'
    ) {
      await route.fulfill({
        json: catalog.telegram ?? {
          botUrl: 'https://t.me/example_rele_bot?startgroup=rele_register',
          command: '/rele_register@example_rele_bot',
        },
      });
      return;
    }
    if (
      request.method() === 'GET' &&
      url.pathname === '/api/catalog/slack/chats'
    ) {
      const known: CatalogChat[] = [
        ...new Map(
          state.endpoints
            .filter((endpoint) => endpoint.platform === 'slack')
            .map((endpoint) => [
              endpoint.chatId,
              {
                id: endpoint.chatId,
                name: endpoint.chatTitle || endpoint.title,
                subtitle: '',
                kind: endpoint.chatId.startsWith('D') ? 'direct' as const : 'channel' as const,
              },
            ]),
        ).values(),
      ];
      await route.fulfill({
        json: catalogPage(
          catalog.chats ?? [{ items: known }],
          url.searchParams.get('cursor'),
        ),
      });
      return;
    }
    if (
      request.method() === 'GET' &&
      url.pathname === '/api/catalog/slack/threads'
    ) {
      const chatId = url.searchParams.get('chatId') ?? '';
      await catalog.beforeThreads?.(chatId);
      const found = catalogPage(
        catalog.threads?.[chatId] ?? [
          {
            items: state.endpoints.filter(
              (endpoint) =>
                endpoint.platform === 'slack' && endpoint.chatId === chatId,
            ),
          },
        ],
        url.searchParams.get('cursor'),
      );
      for (const item of found.items) {
        if (!state.endpoints.some((endpoint) => endpoint.id === item.id))
          state.endpoints.push(structuredClone(item));
      }
      await route.fulfill({ json: found });
      completedThreadChats.push(chatId);
      return;
    }
    if (
      request.method() === 'GET' &&
      url.pathname === '/api/catalog/slack/people'
    ) {
      const endpoint = state.endpoints.find(
        (item) => item.id === url.searchParams.get('endpointId') || item.chatId === url.searchParams.get('chatId'),
      );
      const found = catalogPage(
        catalog.people?.[url.searchParams.get('chatId') ?? endpoint?.id ?? ''] ?? [
          { items: endpoint?.people ?? [] },
        ],
        url.searchParams.get('cursor'),
      );
      if (endpoint)
        endpoint.people = [
          ...new Map(
            [...endpoint.people, ...found.items].map((person) => [
              person.id,
              person,
            ]),
          ).values(),
        ];
      await route.fulfill({ json: found });
      return;
    }
    const body = request.postData()
      ? (request.postDataJSON() as Record<string, any>)
      : undefined;
    mutations.push({ method: request.method(), path: url.pathname, body });
    if (mutationError) {
      await route.fulfill({ status: 409, json: { error: mutationError } });
      return;
    }
    const sourceMatch = url.pathname.match(/^\/api\/endpoints\/([^/]+)\/(route|access)$/);
    if (sourceMatch && request.method() === 'PUT') {
      const endpoint = state.endpoints.find(item => item.id === decodeURIComponent(sourceMatch[1]));
      if (!endpoint) { await route.fulfill({ status: 404, json: { error: 'Источник не найден.' } }); return; }
      if (sourceMatch[2] === 'access') {
        const previous = sourceAccess(endpoint);
        const access: SourceAccess = { endpointId: endpoint.id, mode: body!.mode, allowedSenderIds: body!.allowedSenderIds ?? previous.allowedSenderIds, legacy: false };
        state.sourceAccess = [...(state.sourceAccess ?? []).filter(item => item.endpointId !== endpoint.id), access];
      } else {
        const pending = state.autoLinks?.find(item => item.endpointId === endpoint.id && item.status !== 'completed');
        if (pending && (!body!.resolveAutoLinkId || body!.resolveAutoLinkId !== pending.id || !['uncertain', 'failed', 'created'].includes(pending.status))) {
          await route.fulfill({ status: 409, json: { error: 'Сначала проверьте сохранённое автосоздание этого источника.' } }); return;
        }
        if (body!.resolveAutoLinkId && !pending) { await route.fulfill({ status: 409, json: { error: 'Запись автосоздания изменилась.' } }); return; }
        if (state.requests.some(item => item.origin.endpointId === endpoint.id && !['completed','failed','cancelled','interrupted'].includes(item.status))) {
          await route.fulfill({ status: 409, json: { error: 'Сначала завершите запросы этого источника.' } }); return;
        }
        const previous = state.conversations.flatMap(item => item.bindings).find(item => item.endpointId === endpoint.id);
        if (!state.sourceAccess?.some(item => item.endpointId === endpoint.id)) state.sourceAccess = [...(state.sourceAccess ?? []), previous ? sourceAccess(endpoint) : { endpointId: endpoint.id, mode: 'off', allowedSenderIds: [], legacy: false }];
        let target: Conversation | undefined;
        if (typeof body!.threadId === 'string') {
          target = state.conversations.find(item => item.threadId === body!.threadId);
          if (!target) {
            const native = threads.find(item => item.id === body!.threadId)!;
            target = { id: `routed-conversation-${mutations.length}`, name: native.name, threadId: native.id, cwd: native.cwd, paused: false, bindings: [], createdAt: now, updatedAt: now };
            state.conversations.push(target);
          }
        }
        for (const conversation of state.conversations) conversation.bindings = conversation.bindings.filter(item => item.endpointId !== endpoint.id);
        if (target) target.bindings.push({ ...(previous ?? { id: `route-binding-${mutations.length}`, platform: endpoint.platform, endpointId: endpoint.id, allowedSenderIds: [] }), conversationId: target.id });
        const selected: SourceRoute = { endpointId: endpoint.id, mode: target ? 'manual' : body!.autoCreateCwd ? 'auto' : 'none', ...(body!.autoCreateCwd ? { cwd: body!.autoCreateCwd } : {}) };
        state.sourceRoutes = [...(state.sourceRoutes ?? []).filter(item => item.endpointId !== endpoint.id), selected];
        if (pending && body!.resolveAutoLinkId && target) { pending.status = 'completed'; pending.conversationId = target.id; }
      }
      await route.fulfill({ json: { ok: true } }); return;
    }
    if (request.method() === 'POST' && url.pathname === '/api/conversations') {
      const conversation: Conversation = {
        id: 'conversation-created',
        name: body!.name,
        threadId: body!.threadId,
        cwd: body!.cwd,
        paused: false,
        bindings: (body!.bindings ?? []).map((binding: any, index: number) => ({
          ...binding,
          id: `created-binding-${index}`,
          conversationId: 'conversation-created',
        })),
        createdAt: now,
        updatedAt: now,
      };
      state.conversations.push(conversation);
      await route.fulfill({ json: { conversation } });
      return;
    }
    const conversationMatch = url.pathname.match(
      /^\/api\/conversations\/([^/]+)$/,
    );
    if (conversationMatch && request.method() === 'PATCH') {
      const conversation = state.conversations.find(
        (item) => item.id === conversationMatch[1],
      )!;
      Object.assign(conversation, body);
      await route.fulfill({ json: { conversation } });
      return;
    }
    const endpointMatch = url.pathname.match(/^\/api\/endpoints\/([^/]+)$/);
    if (endpointMatch && request.method() === 'PATCH') {
      const endpoint = state.endpoints.find(
        (item) => item.id === endpointMatch[1],
      )!;
      endpoint.title = body!.title || sourceTitles.get(endpoint.id)!;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    const bindingMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/bindings(?:\/([^/]+))?$/);
    if (bindingMatch) {
      const conversation = state.conversations.find(item => item.id === bindingMatch[1])!;
      const binding = conversation.bindings.find(item => item.id === bindingMatch[2]);
      if (request.method() === 'POST') conversation.bindings.push({ ...body!, id: `added-binding-${mutations.length}` } as any);
      if (request.method() === 'PUT' && binding) Object.assign(binding, body);
      if (request.method() === 'DELETE') conversation.bindings = conversation.bindings.filter(item => item.id !== bindingMatch[2]);
      await route.fulfill({ json: { conversation } });
      return;
    }
    const requestMatch = url.pathname.match(
      /^\/api\/requests\/([^/]+)\/(cancel|reconcile|resume)$/,
    );
    if (requestMatch) {
      const found = state.requests.find((item) => item.id === requestMatch[1]);
      if (found)
        found.status =
          requestMatch[2] === 'cancel'
            ? 'cancelled'
            : requestMatch[2] === 'resume'
              ? 'running'
              : 'completed';
      await route.fulfill({ json: { ok: true } });
      return;
    }
    const retryMatch = url.pathname.match(
      /^\/api\/deliveries\/([^/]+)\/retry$/,
    );
    if (retryMatch) {
      const found = state.deliveries.find((item) => item.id === retryMatch[1]);
      if (found) found.status = 'pending';
      await route.fulfill({ json: { ok: true } });
      return;
    }
    const approvalMatch = url.pathname.match(
      /^\/api\/approvals\/([^/]+)\/resolve$/,
    );
    if (approvalMatch) {
      const found = state.approvals.find(
        (item) => item.id === approvalMatch[1],
      );
      if (found) found.status = 'answered';
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.pathname === '/api/config') {
      for (const [section, values] of Object.entries(body ?? {})) {
        if (section === 'autoLinkRules') { state.config.autoLinkRules = structuredClone(values as any); continue; }
        for (const [key, value] of Object.entries(
          values as Record<string, unknown>,
        )) {
          const config = state.config[
            section as keyof typeof state.config
          ] as unknown as Record<string, unknown>;
          if (['token', 'appToken', 'botToken'].includes(key)) {
            if (value) config[`${key}Configured`] = true;
          } else config[key] = value;
        }
      }
      await route.fulfill({ json: { config: state.config } });
      return;
    }
    if (url.pathname === '/api/codex/connect') {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({
      status: 404,
      json: { error: 'Mock API route is not implemented' },
    });
  });
  return {
    state,
    reads,
    completedThreadChats,
    mutations,
    setOffline: (value: boolean) => {
      offline = value;
    },
    setMutationError: (value: string) => {
      mutationError = value;
    },
  };
}

export async function openPanel(page: Page) {
  await page.goto(`/#token=${panelToken}`);
  await page.getByRole('heading', { level: 1, name: 'Связи' }).waitFor();
}
