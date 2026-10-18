import { expect, test } from '@playwright/test';
import {
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
    fixtureRequest('request-queued'),
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
  await page.getByLabel('Документацию и примеры').check();
  await page.getByRole('button', { name: 'Отправить ответы' }).click();
  await expect(
    page.getByRole('heading', { name: 'Выберите способ проверки' }),
  ).not.toBeVisible();
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  expect(api.mutations).toContainEqual({
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
  expect(api.mutations.at(-1)?.path).toBe('/api/deliveries/delivery-1/retry');
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
