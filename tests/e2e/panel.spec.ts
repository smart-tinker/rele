import { expect, test } from '@playwright/test';
import type {
  CatalogChat,
  CatalogPage,
  Endpoint,
} from '../../src/shared/types';
import {
  fixtureEndpoint,
  fixtureRequest,
  fixtureState,
  installApi,
  openPanel,
  panelToken,
} from './fixtures';

test('fragment authentication is cleaned, survives reload, and is removed at sign-out', async ({
  page,
}) => {
  await installApi(page);
  await openPanel(page);
  await expect(page).toHaveURL('/');
  expect(
    await page.evaluate(() => sessionStorage.getItem('rele.panelToken')),
  ).toBe(panelToken);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Связки', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Вход в панель' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem('rele.panelToken')),
  ).toBeNull();
  await page.getByLabel('Токен панели').fill('invalid-synthetic-token');
  await page.getByRole('button', { name: 'Открыть Rele' }).click();
  await expect(page.getByRole('alert')).toContainText('Токен панели не принят');
});

test('new binding uses named choices and sends both bindings atomically with explicit people', async ({
  page,
}) => {
  const api = await installApi(page, fixtureState(true));
  await openPanel(page);
  await expect(
    page.getByRole('heading', { name: 'Создайте первую связку' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Новая связка', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название связки').fill('Пример созданной связки');
  await dialog
    .getByLabel('Разговор Codex', { exact: true })
    .selectOption('thread-new');
  await dialog
    .getByLabel('Чат Telegram', { exact: true })
    .selectOption({ label: 'Пример: новый чат' });
  await dialog
    .getByLabel('Разговор Telegram', { exact: true })
    .selectOption('tg-new');
  await dialog
    .getByRole('button', { name: 'Создать связку', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText(
    'разрешите хотя бы одного',
  );
  expect(api.mutations).toHaveLength(0);
  await dialog.getByLabel('Анна (пример)').check();
  await dialog
    .getByLabel('Чат Slack', { exact: true })
    .selectOption('sl-new-chat');
  await dialog
    .getByLabel('Разговор Slack', { exact: true })
    .selectOption('sl-new');
  await dialog.getByLabel('Михаил (пример)').last().check();
  await dialog
    .getByRole('button', { name: 'Создать связку', exact: true })
    .click();
  await expect(
    dialog.getByRole('heading', {
      name: 'Пример созданной связки',
      exact: true,
    }),
  ).toBeVisible();
  expect(api.mutations[0]).toMatchObject({
    path: '/api/conversations',
    body: {
      name: 'Пример созданной связки',
      threadId: 'thread-new',
      bindings: [
        {
          platform: 'telegram',
          endpointId: 'tg-new',
          allowedSenderIds: ['person-anna'],
        },
        {
          platform: 'slack',
          endpointId: 'sl-new',
          allowedSenderIds: ['person-mikhail'],
        },
      ],
    },
  });
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(page.getByRole('table')).toContainText(
    'Пример созданной связки',
  );
});

test('chat aliases can be saved with Enter and reset without submitting the binding', async ({
  page,
}) => {
  const api = await installApi(page, fixtureState(true));
  await openPanel(page);
  await page
    .getByRole('button', { name: 'Новая связка', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Разговор Codex', { exact: true })
    .selectOption('thread-new');
  await dialog
    .getByLabel('Чат Telegram', { exact: true })
    .selectOption({ label: 'Пример: новый чат' });
  await dialog
    .getByLabel('Разговор Telegram', { exact: true })
    .selectOption('tg-new');
  await dialog.getByLabel('Анна (пример)').check();
  await dialog
    .getByRole('button', {
      name: 'Переименовать разговор Telegram',
      exact: true,
    })
    .click();
  await dialog.getByLabel('Название чата в Rele').fill('Пример: старая тема');
  await dialog.getByLabel('Название чата в Rele').press('Enter');
  await expect(
    dialog.getByLabel('Разговор Telegram', { exact: true }),
  ).toContainText('Пример: старая тема');
  expect(api.mutations).toEqual([
    {
      method: 'PATCH',
      path: '/api/endpoints/tg-new',
      body: { title: 'Пример: старая тема' },
    },
  ]);
  await dialog
    .getByRole('button', {
      name: 'Переименовать разговор Telegram',
      exact: true,
    })
    .click();
  await dialog
    .getByRole('button', { name: 'Имя из мессенджера', exact: true })
    .click();
  await expect(
    dialog.getByLabel('Разговор Telegram', { exact: true }),
  ).toContainText('Пример: новый чат');
  expect(api.mutations.at(-1)).toEqual({
    method: 'PATCH',
    path: '/api/endpoints/tg-new',
    body: { title: '' },
  });
  expect(api.state.conversations).toEqual([]);
});

test('search, rename, pause and unlink are real API actions', async ({
  page,
}) => {
  const api = await installApi(page);
  await openPanel(page);
  await page.getByLabel('Найти связку или чат').fill('alpha-dev');
  await expect(page.getByRole('row')).toHaveCount(2);
  await page
    .getByRole('button', { name: 'Открыть связку Пример: проект Альфа' })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название связки').fill('Пример: Альфа после правки');
  await dialog.getByRole('button', { name: 'Сохранить название' }).click();
  await expect(
    dialog.getByRole('heading', { name: 'Пример: Альфа после правки' }),
  ).toBeVisible();
  await dialog
    .getByRole('button', { name: 'Приостановить', exact: true })
    .click();
  await expect(
    dialog.getByText('Связка приостановлена', { exact: true }),
  ).toBeVisible();
  await dialog
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Slack', exact: true }) })
    .getByRole('button', { name: 'Отвязать', exact: true })
    .click();
  await expect(
    dialog.getByText('Slack отвязан.', { exact: true }),
  ).toBeVisible();
  expect(api.mutations.map((item) => item.method)).toEqual([
    'PATCH',
    'PATCH',
    'DELETE',
  ]);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('queue cancels only a selected task, approvals preserve answers, uncertain delivery is not retried', async ({
  page,
}) => {
  const state = fixtureState();
  state.requests.push(
    {
      ...fixtureRequest('request-queued'),
      error: 'Тред занят другим клиентом Codex. Запрос ждёт освобождения треда.',
    },
    fixtureRequest('request-approval', 'waiting_approval'),
  );
  state.approvals.push({
    id: 'approval-1',
    requestId: 'request-approval',
    turnId: 'turn-approval',
    itemId: 'item-1',
    rpcId: 42,
    method: 'item/tool/requestUserInput',
    title: 'Выберите способ проверки',
    details: 'Пример запроса уточнения',
    questions: [
      {
        id: 'q1',
        header: 'Проверка',
        question: 'Что проверить?',
        options: [
          {
            label: 'Только документацию',
            description: 'Пример: проверить описание.',
          },
          {
            label: 'Документацию и примеры',
            description: 'Пример: проверить всё.',
          },
        ],
      },
    ],
    status: 'pending',
    createdAt: '2026-10-18T20:00:00Z',
    updatedAt: '2026-10-18T20:00:00Z',
  });
  state.deliveries = ['uncertain', 'failed'].map((status, index) => ({
    id: `delivery-${index}`,
    requestId: 'request-running',
    origin: state.requests[0].origin,
    key: `delivery-${index}`,
    ordinal: index,
    kind: 'answer',
    body: `Пример ответа ${index}`,
    status: status as 'uncertain' | 'failed',
    attempts: 1,
    createdAt: '2026-10-18T20:00:00Z',
    updatedAt: '2026-10-18T20:00:00Z',
  }));
  const api = await installApi(page, state);
  await openPanel(page);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Очередь' })
    .click();
  const waitingRow = page.getByRole('row').filter({ hasText: 'Тред занят' });
  await expect(waitingRow).toContainText('Запрос ждёт освобождения треда');
  await expect(waitingRow).toContainText('В очереди');
  await expect(
    waitingRow.getByRole('button', { name: 'Отменить', exact: true }),
  ).toBeEnabled();
  await page.getByLabel('Документацию и примеры').check();
  await page.getByRole('button', { name: 'Отправить ответы' }).click();
  await expect(
    page.getByRole('heading', { name: 'Выберите способ проверки' }),
  ).not.toBeVisible();
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect.poll(() => api.mutations).toContainEqual({
    method: 'POST',
    path: '/api/requests/request-queued/cancel',
    body: undefined,
  });
  expect(api.mutations[0]).toMatchObject({
    path: '/api/approvals/approval-1/resolve',
    body: { decision: 'accept', answers: { q1: ['Документацию и примеры'] } },
  });
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Доставка', exact: true })
    .click();
  const uncertainRow = page
    .getByRole('row')
    .filter({ hasText: 'Доставка не подтверждена' });
  await expect(uncertainRow.getByRole('button')).toHaveCount(0);
  await expect(uncertainRow).toContainText('Повторная отправка заблокирована');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect
    .poll(() => api.mutations.at(-1)?.path)
    .toBe('/api/deliveries/delivery-1/retry');
});

test('uncertain launches can be reconciled and only an existing queued submission can be resumed', async ({
  page,
}) => {
  const state = fixtureState();
  const uncertain = {
    ...fixtureRequest('request-uncertain', 'uncertain'),
    text: 'Пример: потерянное подтверждение запуска',
  };
  const starting = {
    ...fixtureRequest('request-starting', 'starting'),
    text: 'Пример: запуск очереди',
    queuedSubmissionId: 'submission-existing',
  };
  state.requests = [uncertain, starting];
  const api = await installApi(page, state);
  await openPanel(page);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Очередь' })
    .click();
  const uncertainRow = page
    .getByRole('row')
    .filter({ hasText: uncertain.text });
  await expect(
    uncertainRow.getByRole('button', { name: 'Продолжить' }),
  ).toHaveCount(0);
  await uncertainRow
    .getByRole('button', { name: 'Сверить', exact: true })
    .click();
  await expect(uncertainRow).toHaveCount(0);
  const startingRow = page.getByRole('row').filter({ hasText: starting.text });
  await startingRow
    .getByRole('button', { name: 'Продолжить', exact: true })
    .click();
  await expect(
    startingRow.getByText('Выполняется', { exact: true }),
  ).toBeVisible();
  expect(api.mutations).toEqual([
    {
      method: 'POST',
      path: '/api/requests/request-uncertain/reconcile',
      body: undefined,
    },
    {
      method: 'POST',
      path: '/api/requests/request-starting/resume',
      body: undefined,
    },
  ]);
});

test('connection forms keep saved secrets write-only and report real API failures', async ({
  page,
}) => {
  const api = await installApi(page);
  await openPanel(page);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Подключения', exact: true })
    .click();
  const telegramToken = page.getByLabel('Токен бота Telegram');
  await expect(telegramToken).toHaveValue('');
  await page.getByRole('button', { name: 'Сохранить Telegram' }).click();
  expect(api.mutations.at(-1)?.body).toEqual({ telegram: { enabled: true } });
  await telegramToken.fill('123456:synthetic-only-test-token');
  await page.getByRole('button', { name: 'Сохранить Telegram' }).click();
  await expect(telegramToken).toHaveValue('');
  expect(api.mutations.at(-1)?.body).toEqual({
    telegram: { enabled: true, token: '123456:synthetic-only-test-token' },
  });
  api.setMutationError('Пример: соединение отклонено сервером.');
  await page.getByRole('button', { name: 'Сохранить Slack' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'соединение отклонено сервером',
  );
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Codex', exact: true })
    .click();
  await expect(
    page.getByText('Desktop: требуется проверка', { exact: true }),
  ).toBeVisible();
});

test('mobile layout has no horizontal page overflow and dialog is keyboard accessible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page);
  await openPanel(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Новая связка', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Название связки')).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Новая связка', exact: true }),
  ).toBeFocused();
});

test('Codex catalog searches previews and folders while occupied and archived conversations stay visible but disabled', async ({
  page,
}) => {
  const api = await installApi(page);
  await openPanel(page);
  await page.getByRole('button', { name: 'Новая связка', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const choice = dialog.getByLabel('Разговор Codex', { exact: true });
  await dialog.getByLabel('Поиск разговоров Codex').fill('Обсуждение API');
  await expect(choice.locator('option[value="thread-alpha"]')).toBeDisabled();
  await expect(choice).toContainText('В связке «Пример: проект Альфа»');
  await dialog.getByLabel('Поиск разговоров Codex').fill('/work/new');
  await expect(choice.locator('option[value="thread-new"]')).toBeEnabled();
  await expect(choice.locator('option[value="thread-alpha"]')).toHaveCount(0);
  await dialog.getByLabel('Поиск разговоров Codex').fill('Старая идея');
  await dialog.getByLabel('Показать архивные разговоры').check();
  await expect(
    choice.locator('option[value="thread-archived"]'),
  ).toBeDisabled();
  await expect(choice).toContainText('Пример: архивный проект');
  await expect(
    dialog.getByText(/сначала разархивируйте его в Codex/),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Создать связку', exact: true }),
  ).toBeDisabled();
  expect(api.reads).toContain('/api/threads?archived=true');
  expect(api.reads.some((url) => url.includes('refresh=true'))).toBe(false);
  await dialog.getByRole('button', { name: 'Обновить разговоры', exact: true }).click();
  await expect.poll(() => api.reads).toContain('/api/threads?archived=false&refresh=true');
  await expect.poll(() => api.reads).toContain('/api/threads?archived=true&refresh=true');
  await expect(choice.locator('option[value="thread-archived"]')).toBeDisabled();
  expect(api.mutations).toEqual([]);
});

test('Slack catalog pages discover a direct chat, threads and explicit people without initial endpoints and can recover a catalog error', async ({
  page,
}) => {
  const state = fixtureState(true);
  state.endpoints = [];
  const first = {
    ...fixtureEndpoint(
      'sl-catalog-first',
      'slack',
      'Пример: прошлое обсуждение',
      'Личный разговор',
    ),
    chatId: 'chat-direct',
    chatTitle: 'Анна (пример)',
    people: [],
  };
  const target = {
    ...first,
    id: 'sl-catalog-target',
    threadId: 'thread-target',
    title: 'Пример: план API',
  };
  const api = await installApi(page, state, {
    chats: [
      {
        items: [
          {
            id: 'chat-general',
            name: '#example-general',
            subtitle: 'Общий канал',
            kind: 'channel',
          },
        ],
        nextCursor: 'chats/page+2',
      },
      {
        items: [
          {
            id: 'chat-direct',
            name: 'Анна (пример)',
            subtitle: 'Личный разговор',
            kind: 'direct',
          },
        ],
      },
    ],
    threads: {
      'chat-direct': [
        { items: [first], nextCursor: 'threads/page+2' },
        { items: [target] },
      ],
    },
    people: {
      'sl-catalog-target': [
        {
          items: [{ id: 'person-anna', name: 'Анна (пример)' }],
          nextCursor: 'people/page+2',
        },
        { items: [{ id: 'person-mikhail', name: 'Михаил (пример)' }] },
      ],
    },
  });
  let failThreads = true;
  await page.route('**/api/catalog/slack/threads?*', async (route) => {
    if (failThreads) {
      failThreads = false;
      await route.fulfill({
        status: 503,
        json: { error: 'Пример: каталог временно недоступен' },
      });
    } else await route.fallback();
  });
  await openPanel(page);
  await page
    .getByRole('button', { name: 'Новая связка', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Название связки', { exact: true })
    .fill('Пример: связка из каталога');
  await dialog
    .getByLabel('Разговор Codex', { exact: true })
    .selectOption('thread-new');
  await dialog.getByLabel('Поиск каналов и личных чатов Slack').fill('Анна');
  await expect(
    dialog
      .getByLabel('Чат Slack', { exact: true })
      .locator('option[value="chat-direct"]'),
  ).toHaveCount(0);
  await dialog
    .getByRole('button', { name: 'Загрузить ещё чаты Slack', exact: true })
    .click();
  await dialog
    .getByLabel('Чат Slack', { exact: true })
    .selectOption('chat-direct');
  await expect(dialog.getByRole('alert')).toContainText(
    'каталог временно недоступен',
  );
  await dialog
    .getByRole('button', { name: 'Обновить треды Slack', exact: true })
    .click();
  await expect(
    dialog.getByLabel('Разговор Slack', { exact: true }),
  ).toContainText(first.title);
  await dialog.getByLabel('Поиск тредов Slack').fill('план API');
  await expect(
    dialog.getByText('Среди загруженных тредов совпадений нет.', {
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByRole('button', { name: 'Загрузить ещё треды Slack', exact: true })
    .click();
  await dialog
    .getByLabel('Разговор Slack', { exact: true })
    .selectOption(target.id);
  await expect(
    dialog.getByLabel('Анна (пример)', { exact: true }),
  ).not.toBeChecked();
  await dialog
    .getByRole('button', { name: 'Создать связку', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText(
    'разрешите хотя бы одного',
  );
  expect(api.mutations).toEqual([]);
  await dialog
    .getByRole('button', {
      name: 'Загрузить ещё участников Slack',
      exact: true,
    })
    .click();
  await dialog.getByLabel('Поиск участников Slack').fill('Михаил');
  await dialog.getByLabel('Михаил (пример)', { exact: true }).check();
  await dialog
    .getByRole('button', { name: 'Создать связку', exact: true })
    .click();
  await expect(
    dialog.getByRole('heading', {
      name: 'Пример: связка из каталога',
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() => api.mutations)
    .toContainEqual({
      method: 'POST',
      path: '/api/conversations',
      body: {
        name: 'Пример: связка из каталога',
        threadId: 'thread-new',
        cwd: '/work/new',
        bindings: [
          {
            platform: 'slack',
            endpointId: target.id,
            allowedSenderIds: ['person-mikhail'],
            allowAllSenders: false,
            requireMention: false,
          },
        ],
      },
    });
});

test('Telegram groups forum topics for the current bot, preserves aliases and discovers a registered topic on refresh', async ({
  page,
}) => {
  const state = fixtureState();
  const forum: Endpoint = {
    ...fixtureEndpoint('tg-forum', 'telegram', 'Пример: команда', ''),
    chatId: 'forum-current',
    threadId: '',
    chatTitle: 'Пример: команда',
    isForum: true,
  };
  const occupied = {
    ...forum,
    id: 'tg-topic-occupied',
    threadId: 'topic-occupied',
    title: 'Пример: занятая тема',
    topicTitle: 'Занятая тема',
  };
  const free = {
    ...forum,
    id: 'tg-topic-free',
    threadId: 'topic-free',
    title: 'Пример: имя темы в Rele',
    topicTitle: 'Исходное название темы',
  };
  state.endpoints = [
    forum,
    occupied,
    free,
    {
      ...forum,
      id: 'tg-old-account',
      accountId: 'previous-bot',
      chatTitle: 'Пример: старый бот',
      title: 'Пример: старая группа',
    },
  ];
  state.conversations = [
    {
      ...state.conversations[0],
      bindings: [
        {
          id: 'binding-topic',
          conversationId: state.conversations[0].id,
          platform: 'telegram',
          endpointId: occupied.id,
          allowedSenderIds: ['person-anna'],
        },
      ],
    },
  ];
  const api = await installApi(page, state);
  await openPanel(page);
  await page.getByRole('button', { name: 'Новая связка', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Разговор Codex', { exact: true })
    .selectOption('thread-new');
  await expect(
    dialog.getByLabel('Чат Telegram', { exact: true }),
  ).not.toContainText('старый бот');
  await dialog
    .getByLabel('Чат Telegram', { exact: true })
    .selectOption({ label: 'Пример: команда · Группа с темами' });
  const choice = dialog.getByLabel('Разговор Telegram', { exact: true });
  await expect(choice.locator('option[value="tg-forum"]')).toHaveCount(0);
  await expect(
    choice.locator('option[value="tg-topic-occupied"]'),
  ).toBeDisabled();
  await expect(choice).toContainText('В связке «Пример: проект Альфа»');
  await expect(choice).toContainText('Пример: имя темы в Rele');
  await expect(
    dialog.getByRole('link', {
      name: 'Выбрать группу в Telegram',
      exact: true,
    }),
  ).toHaveAttribute(
    'href',
    'https://t.me/example_rele_bot?startgroup=rele_register',
  );
  await expect(dialog.getByText('/rele_register [имя]', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText('/rele_register@example_rele_bot [имя]', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(/Если бот не отвечает в группе/)).toBeVisible();
  const registered = {
    ...forum,
    id: 'tg-topic-registered',
    threadId: 'topic-registered',
    title: 'Пример: новая зарегистрированная тема',
    topicTitle: 'Новая тема',
  };
  api.state.endpoints[0] = {
    ...forum,
    generalTopic: true,
    title: 'Пример: команда / Общая тема',
  };
  api.state.endpoints.push(registered);
  await dialog
    .getByRole('button', {
      name: 'Обновить обнаруженные чаты Telegram',
      exact: true,
    })
    .click();
  await expect(choice).toContainText(registered.title);
  await expect(choice.locator('option[value="tg-forum"]')).toBeEnabled();
  await choice.selectOption(forum.id);
  await expect(choice).toHaveValue(forum.id);
  await expect(choice).toContainText('Пример: команда / Общая тема');
  expect(api.mutations).toEqual([]);
  await choice.selectOption(registered.id);
  await dialog.getByLabel('Анна (пример)', { exact: true }).check();
  await dialog
    .getByRole('button', { name: 'Создать связку', exact: true })
    .click();
  await expect
    .poll(() => api.mutations.at(-1)?.body)
    .toMatchObject({
      bindings: [
        {
          platform: 'telegram',
          endpointId: registered.id,
          allowedSenderIds: ['person-anna'],
        },
      ],
    });
});

test('a late Slack thread page never replaces the currently selected chat or thread', async ({
  page,
}) => {
  const state = fixtureState(true);
  state.endpoints = [];
  const oldThread = {
    ...fixtureEndpoint(
      'sl-race-old',
      'slack',
      'Пример: старый ответ каталога',
      '',
    ),
    chatId: 'chat-old',
  };
  const newThread = {
    ...fixtureEndpoint('sl-race-new', 'slack', 'Пример: текущий тред', ''),
    chatId: 'chat-new',
  };
  let releaseOld!: () => void;
  let oldStarted = false;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const api = await installApi(page, state, {
    chats: [
      {
        items: [
          {
            id: 'chat-old',
            name: '#example-old',
            subtitle: '',
            kind: 'channel',
          },
          {
            id: 'chat-new',
            name: '#example-new',
            subtitle: '',
            kind: 'channel',
          },
        ],
      },
    ],
    threads: {
      'chat-old': [{ items: [oldThread] }],
      'chat-new': [{ items: [newThread] }],
    },
    beforeThreads: async (chatId) => {
      if (chatId === 'chat-old') {
        oldStarted = true;
        await oldGate;
      }
    },
  });
  await openPanel(page);
  await page
    .getByRole('button', { name: 'Новая связка', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Чат Slack', { exact: true })
    .selectOption('chat-old');
  await expect.poll(() => oldStarted).toBe(true);
  await dialog
    .getByLabel('Чат Slack', { exact: true })
    .selectOption('chat-new');
  await dialog
    .getByLabel('Разговор Slack', { exact: true })
    .selectOption(newThread.id);
  releaseOld();
  await expect.poll(() => api.completedThreadChats).toContain('chat-old');
  await expect(dialog.getByLabel('Чат Slack', { exact: true })).toHaveValue(
    'chat-new',
  );
  await expect(
    dialog.getByLabel('Разговор Slack', { exact: true }),
  ).toHaveValue(newThread.id);
  await expect(
    dialog.getByLabel('Разговор Slack', { exact: true }),
  ).not.toContainText(oldThread.title);
  expect(api.mutations).toEqual([]);
});

test('changing bot accounts resets catalogs and the Telegram picker while an old named binding can still be unlinked', async ({
  page,
}) => {
  const state = fixtureState();
  const originalSlackBindingId = state.conversations[0].bindings.find(binding => binding.platform === 'slack')!.id;
  const catalog: {
    chats: CatalogPage<CatalogChat>[];
    telegram?: { botUrl?: string; command: string };
  } = {
    chats: [
      {
        items: [
          {
            id: 'old-workspace-chat',
            name: '#example-old-workspace',
            subtitle: '',
            kind: 'channel',
          },
        ],
      },
    ],
  };
  const api = await installApi(page, state, catalog);
  await openPanel(page);
  await page
    .getByRole('button', {
      name: 'Открыть связку Пример: проект Альфа',
      exact: true,
    })
    .click();
  const dialog = page.getByRole('dialog');
  const slack = dialog.getByLabel('Чат Slack', { exact: true });
  await expect(slack).toContainText('#example-old-workspace');
  catalog.chats = [
    {
      items: [
        {
          id: 'new-workspace-chat',
          name: '#example-new-workspace',
          subtitle: '',
          kind: 'channel',
        },
      ],
    },
  ];
  catalog.telegram = {
    botUrl: 'https://t.me/example_new_bot?startgroup=rele_register',
    command: '/rele_register@example_new_bot',
  };
  api.state.connections.slack.accountId = 'slack-new-account';
  api.state.connections.telegram.accountId = 'telegram-new-account';
  await dialog
    .getByRole('button', {
      name: 'Обновить обнаруженные чаты Telegram',
      exact: true,
    })
    .click();
  await expect(slack).toContainText('#example-new-workspace');
  await expect(slack).not.toContainText('#example-old-workspace');
  await expect(slack).not.toContainText('#alpha-dev');
  await expect(
    dialog.getByLabel('Чат Telegram', { exact: true }),
  ).not.toContainText('Команда Альфа');
  await expect(
    dialog.getByRole('link', {
      name: 'Выбрать группу в Telegram',
      exact: true,
    }),
  ).toHaveAttribute('href', catalog.telegram.botUrl!);
  await expect(
    dialog.getByText(
      /Сохранённый разговор «#alpha-dev» относится к другому подключению/,
    ),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      /Сохранённый разговор «Команда Альфа» относится к другому подключению/,
    ),
  ).toBeVisible();
  await dialog
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Slack', exact: true }) })
    .getByRole('button', { name: 'Отвязать', exact: true })
    .click();
  await expect
    .poll(() => api.mutations.at(-1)?.path)
    .toBe(`/api/conversations/conversation-0/bindings/${originalSlackBindingId}`);
  expect(api.mutations.at(-1)?.method).toBe('DELETE');
});

test('network loss keeps last known data visible and can recover', async ({
  page,
}) => {
  const api = await installApi(page);
  await openPanel(page);
  api.setOffline(true);
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Отображаются последние полученные данные',
  );
  await expect(page.getByRole('table')).toContainText('Пример: проект Альфа');
  api.setOffline(false);
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByRole('alert')).not.toBeVisible();
});
