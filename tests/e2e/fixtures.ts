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
    version: '0.1.0-rc.5',
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
    config: {
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
      await route.fulfill({ json: state });
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
                kind: 'channel' as const,
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
        (item) => item.id === url.searchParams.get('endpointId'),
      );
      const found = catalogPage(
        catalog.people?.[endpoint?.id ?? ''] ?? [
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
    const bindingMatch = url.pathname.match(
      /^\/api\/conversations\/([^/]+)\/bindings\/(telegram|slack)$/,
    );
    if (bindingMatch) {
      const conversation = state.conversations.find(
        (item) => item.id === bindingMatch[1],
      )!;
      conversation.bindings = conversation.bindings.filter(
        (item) => item.platform !== bindingMatch[2],
      );
      if (request.method() === 'PUT')
        conversation.bindings.push({
          id: `binding-${bindingMatch[2]}`,
          conversationId: conversation.id,
          platform: bindingMatch[2] as Platform,
          endpointId: body!.endpointId,
          allowedSenderIds: body!.allowedSenderIds,
        });
      await route.fulfill({ json: { ok: true } });
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
  await page.getByRole('heading', { level: 1, name: 'Связки' }).waitFor();
}
