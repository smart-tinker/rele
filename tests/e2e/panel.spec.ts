import { expect, test } from '@playwright/test';
import { fixtureEndpoint, fixtureRequest, fixtureState, installApi, openPanel, panelToken } from './fixtures';

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
    page.getByRole('heading', { name: 'Связи', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Вход в панель' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem('rele.panelToken')),
  ).toBeNull();
  await page.getByRole('button', { name: 'Ввести токен вручную', exact: true }).click();
  await page.getByLabel('Токен панели').fill('invalid-synthetic-token');
  await page.getByRole('button', { name: 'Открыть Rele' }).click();
  await expect(page.getByRole('alert')).toContainText('Токен панели не принят');
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


test('a clarification answer receipt is distinguished from the final answer in deliveries', async ({ page }) => {
  const state = fixtureState();
  state.deliveries = [{
    id: 'answer-marker', requestId: state.requests[0].id, origin: state.requests[0].origin,
    key: 'question-answer:approval-1', ordinal: 0, kind: 'answer', body: 'Ответ получен от владелеца',
    status: 'sent', attempts: 1, createdAt: '2026-10-18T20:00:00Z', updatedAt: '2026-10-18T20:00:00Z',
  }];
  const api = await installApi(page, state);
  await openPanel(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Доставка' }).click();
  const row = page.getByRole('row').filter({ hasText: 'Ответ получен от владелеца' });
  await expect(row).toContainText('Ответ на уточнение');
  await expect(row).not.toContainText('Сообщение об ошибке');
  await expect(row).not.toContainText('Ответ · часть');
  expect(api.mutations).toEqual([]);
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
  ).toHaveCount(0);
});


test('network loss keeps last known data visible and can recover', async ({
  page,
}) => {
  const api = await installApi(page);
  await openPanel(page);
  api.setOffline(true);
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Отображаются последние полученные данные' })).toContainText(
    'Отображаются последние полученные данные',
  );
  await expect(page.getByRole('table')).toContainText('Пример: проект Альфа');
  api.setOffline(false);
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Отображаются последние полученные данные' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('routes several Telegram and Slack sources into the same Codex without changing access', async ({ page }) => {
  const state = fixtureState();
  const api = await installApi(page, state);
  await openPanel(page);
  await expect(page).toHaveTitle('Rele — Связи');
  await expect(page.getByRole('tab', { name: 'Telegram', exact: true })).toHaveAttribute('aria-selected', 'true');
  const target = page.getByLabel('Разговор Codex для Пример: новый чат', { exact: true });
  await expect(target).toBeEnabled();
  await target.selectOption('thread-alpha');
  await expect.poll(() => state.conversations[0].bindings.some(item => item.endpointId === 'tg-new')).toBe(true);
  await page.getByRole('tab', { name: 'Slack', exact: true }).click();
  await page.getByLabel('Разговор Codex для #example-new', { exact: true }).selectOption('thread-alpha');
  await expect.poll(() => state.conversations[0].bindings.some(item => item.endpointId === 'sl-new')).toBe(true);
  expect(state.conversations.filter(item => item.threadId === 'thread-alpha')).toHaveLength(1);
  expect(state.sourceAccess?.filter(item => ['tg-new', 'sl-new'].includes(item.endpointId)).every(item => item.mode === 'off')).toBe(true);
  expect(api.mutations.every(item => item.method === 'PUT' && item.path.endsWith('/route'))).toBe(true);
  expect(state.requests).toHaveLength(1);
});

test('lists unbound and unavailable discovered sources and searches their group and thread names', async ({ page }) => {
  const state = fixtureState();
  state.endpoints.push({ ...fixtureEndpoint('tg-inaccessible', 'telegram', 'Старый источник', 'Сохранённый тред'), available: false, accountId: 'previous-account' });
  await installApi(page, state);
  await openPanel(page);
  await expect(page.getByRole('table')).toContainText('Пример: новый чат');
  await expect(page.getByRole('table')).toContainText('Старый источник');
  await page.getByLabel('Найти группу или тред', { exact: true }).fill('Документация');
  await expect(page.getByRole('table')).toContainText('Документация');
  await expect(page.getByRole('table')).not.toContainText('Команда Альфа');
  await page.getByRole('button', { name: 'Очистить поиск источников', exact: true }).click();
  await expect(page.getByLabel('Найти группу или тред', { exact: true })).toBeFocused();
  await page.getByRole('tab', { name: 'Slack', exact: true }).click();
  await expect(page.getByRole('table')).toContainText('#example-new');
  await expect(page.getByRole('table')).not.toContainText('Команда Альфа');
});

test('keeps the previous destination when a route update fails and supports explicit unlink', async ({ page }) => {
  const state = fixtureState(); const api = await installApi(page, state);
  await openPanel(page);
  const select = page.getByLabel('Разговор Codex для Команда Альфа', { exact: true });
  await expect(select).toHaveValue('thread-alpha');
  api.setMutationError('Пример: назначение не сохранено');
  await select.selectOption('thread-docs');
  await expect(page.getByRole('alert')).toContainText('назначение не сохранено');
  expect(state.conversations[0].bindings.some(item => item.endpointId === 'tg-alpha')).toBe(true);
  api.setMutationError('');
  await select.selectOption('');
  await expect.poll(() => state.conversations.flatMap(item => item.bindings).some(item => item.endpointId === 'tg-alpha')).toBe(false);
  expect(state.conversations).toHaveLength(3);
  expect(state.requests).toHaveLength(1);
  expect(api.mutations.at(-1)).toMatchObject({ method: 'PUT', path: '/api/endpoints/tg-alpha/route', body: { threadId: null } });
});

test('protects the route of an accepted task while other rows can still change', async ({ page }) => {
  await installApi(page);
  await openPanel(page);
  await expect(page.getByLabel('Разговор Codex для Поддержка', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Разговор Codex для Пример: новый чат', { exact: true })).toBeEnabled();
});

test('mobile source table and dialogs stay within the viewport and support keyboard dismissal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page); await openPanel(page);
  await expect(page.getByRole('table')).toContainText('Команда Альфа');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const trigger = page.getByRole('button', { name: 'Настройки источника Команда Альфа', exact: true });
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('fresh Slack DM discovery pages real endpoints into the table without enabling a route or access', async ({ page }) => {
  const state = fixtureState(true); state.endpoints = [];
  const direct = { ...fixtureEndpoint('discovered-dm', 'slack', 'Новая личная задача', 'Тред личного чата'), chatId: 'DANNA', threadId: '1792500000.000001', chatTitle: 'Анна (пример)' };
  const api = await installApi(page, state, {
    chats: [{ items: [{ id: 'CPUBLIC', name: '#команда', subtitle: 'Канал', kind: 'channel' }], nextCursor: 'dm-page' }, { items: [{ id: 'DANNA', name: 'Анна (пример)', subtitle: 'Личные сообщения', kind: 'direct' }] }],
    threads: { DANNA: [{ items: [direct] }] },
  });
  await openPanel(page); await page.getByRole('tab', { name: 'Slack', exact: true }).click();
  await page.getByRole('button', { name: 'Найти источники', exact: true }).first().click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Загрузить ещё чаты Slack', exact: true }).click();
  await dialog.getByLabel('Чат Slack', { exact: true }).selectOption('DANNA');
  await dialog.getByLabel('Разговор Slack', { exact: true }).selectOption(direct.id);
  await expect(page.getByRole('dialog').getByRole('heading', { name: direct.title, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('table')).toContainText('Анна (пример)');
  await expect(page.getByLabel(`Разговор Codex для ${direct.title}`, { exact: true })).toHaveValue('');
  await expect(page.getByRole('table')).toContainText('Доступ выключен');
  expect(api.mutations).toEqual([]);
  expect(api.completedThreadChats).toEqual(['DANNA']);
});

test('a late Slack discovery page cannot replace the current chat or create a route', async ({ page }) => {
  const state = fixtureState(true); state.endpoints = [];
  const slow = { ...fixtureEndpoint('slow-source', 'slack', 'Старый медленный тред', 'Первый канал'), chatId: 'CSLOW' };
  const fresh = { ...fixtureEndpoint('fresh-source', 'slack', 'Текущий тред', 'Второй канал'), chatId: 'CFRESH' };
  let release!: () => void; let requested = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const api = await installApi(page, state, {
    chats: [{ items: [{ id: 'CSLOW', name: '#медленный', subtitle: '', kind: 'channel' }, { id: 'CFRESH', name: '#текущий', subtitle: '', kind: 'channel' }] }],
    threads: { CSLOW: [{ items: [slow] }], CFRESH: [{ items: [fresh] }] },
    beforeThreads: async chatId => { if (chatId === 'CSLOW') { requested = true; await gate; } },
  });
  await openPanel(page); await page.getByRole('tab', { name: 'Slack', exact: true }).click();
  await page.getByRole('button', { name: 'Найти источники', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Чат Slack', { exact: true }).selectOption('CSLOW');
  await expect.poll(() => requested).toBe(true);
  await dialog.getByLabel('Чат Slack', { exact: true }).selectOption('CFRESH');
  await expect(dialog.getByLabel('Разговор Slack', { exact: true }).locator('option')).toContainText(['Не подключать', fresh.title]);
  release();
  await expect.poll(() => api.completedThreadChats.includes('CSLOW')).toBe(true);
  await expect(dialog.getByLabel('Чат Slack', { exact: true })).toHaveValue('CFRESH');
  await expect(dialog.getByLabel('Разговор Slack', { exact: true }).locator('option')).not.toContainText([slow.title]);
  expect(api.mutations).toEqual([]);
});

test('local aliases save on Enter and reset without changing routing or access', async ({ page }) => {
  const state = fixtureState(); const api = await installApi(page, state);
  const original = structuredClone(state.conversations);
  await openPanel(page);
  await page.getByRole('button', { name: 'Настройки источника Команда Альфа', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Изменить название разговора Telegram только в Rele', exact: true }).click();
  await dialog.getByLabel('Название чата в Rele').fill('Моё локальное название');
  await dialog.getByLabel('Название чата в Rele').press('Enter');
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Моё локальное название');
  await dialog.getByRole('button', { name: 'Изменить название разговора Telegram только в Rele', exact: true }).click();
  await dialog.getByRole('button', { name: 'Имя из мессенджера', exact: true }).click();
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Команда Альфа');
  expect(state.conversations).toEqual(original);
  expect(api.mutations.map(item => item.body)).toEqual([{ title: 'Моё локальное название' }, { title: '' }]);
});

test('Telegram forum rows distinguish group and topic while a local alias keeps priority', async ({ page }) => {
  const state = fixtureState(true);
  state.endpoints = [{ ...fixtureEndpoint('forum-one', 'telegram', 'Команда / Поставки', 'Тема Telegram'), chatId: '-100100', threadId: '17', chatTitle: 'Команда', topicTitle: 'Поставки', isForum: true },
    { ...fixtureEndpoint('forum-two', 'telegram', 'Особое локальное имя', 'Тема Telegram'), chatId: '-100100', threadId: '18', chatTitle: 'Команда', topicTitle: 'Учёт', isForum: true }];
  await installApi(page, state); await openPanel(page);
  const rows = page.getByRole('table').getByRole('row');
  await expect(rows.nth(1).getByRole('cell').nth(0)).toContainText('Команда');
  await expect(rows.nth(1).getByRole('cell').nth(1)).toContainText('Поставки');
  await expect(rows.nth(1).getByRole('cell').nth(1)).not.toContainText('Команда /');
  await expect(rows.nth(2).getByRole('cell').nth(1)).toContainText('Особое локальное имя');
});


test('unified source table and every catalog filter clear without mutations and keep focus', async ({ page }) => {
  const state = fixtureState();
  const api = await installApi(page, state);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await openPanel(page);
  await expect(page).toHaveTitle('Rele — Связи');
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Доступ', exact: true })).toHaveCount(0);
  await expect(page.getByRole('table').getByRole('columnheader')).toHaveText(['Группа / чат', 'Тема / обсуждение', 'Разговор Codex', 'Доступ']);
  const clear = async (label: string, button: string) => {
    const input = page.getByLabel(label, { exact: true });
    await input.fill('нет совпадений');
    await page.getByRole('button', { name: button, exact: true }).click();
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await expect(page.getByRole('button', { name: button, exact: true })).toHaveCount(0);
  };
  await clear('Найти группу или тред', 'Очистить поиск источников');
  await page.screenshot({ path: test.info().outputPath('unified-telegram-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('unified-telegram-mobile.png') });
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.getByRole('button', { name: 'Найти источники', exact: true }).click();
  await clear('Поиск в обнаруженных чатах Telegram', 'Очистить поиск чатов Telegram');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Slack', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('unified-slack-desktop.png') });
  await page.getByRole('button', { name: 'Найти источники', exact: true }).click();
  await clear('Поиск каналов и личных чатов Slack', 'Очистить поиск чатов Slack');
  await page.getByRole('dialog').getByLabel('Чат Slack', { exact: true }).selectOption('sl-alpha-chat');
  await clear('Поиск тредов Slack', 'Очистить поиск тредов Slack');
  await page.keyboard.press('Escape');
  await page.getByRole('navigation').getByRole('button', { name: 'Codex', exact: true }).click();
  await clear('Найти разговор Codex', 'Очистить поиск разговоров Codex');
  await page.getByRole('navigation').getByRole('button', { name: 'Связи', exact: true }).click();
  await page.getByRole('tab', { name: 'Slack', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('unified-slack-mobile.png') });
  expect(api.mutations).toEqual([]);
  expect(errors).toEqual([]);
});

test('completed NOREPLY is visible in the queue without creating a delivery', async ({ page }) => {
  const state = fixtureState();
  state.requests = [{ ...fixtureRequest('silent-request', 'completed'), suppressedFinal: true }];
  state.deliveries = [];
  const api = await installApi(page, state);
  await openPanel(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Очередь', exact: true }).click();
  await page.getByRole('button', { name: 'Все запросы' }).click();
  await expect(page.getByText('Агент завершил запрос без отправки ответа (NOREPLY).')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'NOREPLY' })).toContainText('Завершён');
  expect(api.mutations).toEqual([]);
});

test('an agent tool message has its conversation and mentions without inventing an inbound request', async ({ page }, testInfo) => {
  const state = fixtureState();
  const endpoint = state.endpoints.find((item) => item.id === 'tg-alpha')!;
  const origin = { ...fixtureRequest('unused').origin, endpointId: endpoint.id, chatId: endpoint.chatId,
    threadId: endpoint.threadId, senderId: 'connected-agent', senderName: 'Тереза (пример)', senderIsBot: true, messageId: '' };
  state.requests = [];
  state.deliveries = [{ id: 'tool-delivery', operationId: 'tool-operation', conversationId: state.conversations[0].id,
    nativeThreadId: 'thread-alpha', callId: 'native-call', origin, key: 'tool-operation', ordinal: 0,
    kind: 'message', body: 'Синтетическое сообщение агенту', mentions: [{ id: 'known-agent', name: 'Оскар (пример)', isBot: true }],
    status: 'uncertain', attempts: 1, createdAt: '2026-10-26T12:00:00Z', updatedAt: '2026-10-26T12:00:00Z' }];
  const api = await installApi(page, state);
  await openPanel(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Доставка', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'Сообщение агента' });
  await expect(row).toContainText(state.conversations[0].name);
  await expect(row).toContainText('Упоминания: Оскар (пример)');
  await expect(row).toContainText('Повторная отправка заблокирована');
  await expect(row.getByRole('button', { name: 'Повторить' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('agent-message-delivery.png'), fullPage: true });
  expect(api.mutations).toEqual([]);
});
