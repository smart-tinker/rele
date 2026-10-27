import { expect, test } from '@playwright/test';
import { fixtureEndpoint, fixtureState, installApi, openPanel } from './fixtures';

const navigation = (page: import('@playwright/test').Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });

test('all discovered unconfigured sources start off and viewing access never changes permissions', async ({ page }) => {
  const state = fixtureState(true); const api = await installApi(page, state);
  await openPanel(page); await navigation(page, 'Связи').click();
  await expect(page).toHaveTitle('Rele — Связи');
  await expect(navigation(page, 'Доступ')).toHaveCount(0);
  await expect(page.getByRole('table').getByRole('columnheader')).toHaveText(['Группа / чат', 'Тема / обсуждение', 'Разговор Codex', 'Доступ']);
  await expect(page.getByLabel('Режим для Команда Альфа', { exact: true })).toHaveValue('off');
  await page.getByRole('tab', { name: 'Slack', exact: true }).click();
  await expect(page.getByLabel('Режим для #alpha-dev', { exact: true })).toHaveValue('off');
  expect(api.mutations).toEqual([]);
});

test('selecting mention mode saves inline and leaves shared routing intact', async ({ page }) => {
  const state = fixtureState(); const original = structuredClone(state.conversations);
  const api = await installApi(page, state); await openPanel(page);
  await navigation(page, 'Связи').click();
  await page.getByLabel('Режим для Пример: новый чат', { exact: true }).selectOption('mention');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Режим для Пример: новый чат', { exact: true })).toHaveValue('mention');
  await expect(page.getByRole('row').filter({ has: page.getByLabel('Режим для Пример: новый чат', { exact: true }) })).toContainText('Доступ сохранён.');
  expect(api.mutations).toEqual([{ method: 'PUT', path: '/api/endpoints/tg-new/access', body: { mode: 'mention' } }]);
  expect(state.conversations).toEqual(original);
});

test('DM access requires selected humans and never offers other agents as senders', async ({ page }) => {
  const state = fixtureState();
  state.endpoints.push({ ...fixtureEndpoint('direct-source', 'slack', 'Личная задача', 'Личные сообщения'), chatId: 'DPRIVATE', chatTitle: 'Анна (пример)',
    people: [{ id: 'person-anna', name: 'Анна (пример)' }, { id: 'OTHERBOT', name: 'Другой агент', isBot: true }] });
  const api = await installApi(page, state); await openPanel(page);
  await navigation(page, 'Связи').click(); await page.getByRole('tab', { name: 'Slack', exact: true }).click();
  await page.getByLabel('Режим для Личная задача', { exact: true }).selectOption('all');
  const row = page.getByRole('row').filter({ has: page.getByLabel('Режим для Личная задача', { exact: true }) });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row.getByRole('checkbox', { name: /Другой агент/ })).toHaveCount(0);
  await expect(row.getByRole('alert')).toContainText('хотя бы одного человека');
  await expect(row).toContainText('Доступ выключен');
  expect(api.mutations).toEqual([]);
  await row.getByRole('button', { name: 'Разрешённые люди для Личная задача', exact: true }).click();
  await expect(row.getByLabel('Режим для Личная задача', { exact: true })).toHaveValue('off');
  expect(api.mutations).toEqual([]);
  await row.getByLabel('Режим для Личная задача', { exact: true }).selectOption('all');
  const peopleSearch = row.getByLabel('Поиск участников Slack', { exact: true });
  await peopleSearch.fill('никого');
  await expect(row.getByRole('checkbox', { name: 'Анна (пример)', exact: true })).toHaveCount(0);
  await row.getByRole('button', { name: 'Очистить поиск участников Slack', exact: true }).click();
  await expect(peopleSearch).toHaveValue('');
  await expect(peopleSearch).toBeFocused();
  await row.getByRole('checkbox', { name: 'Анна (пример)', exact: true }).check();
  await expect(row).toContainText('Доступ сохранён.');
  await expect(row.getByRole('checkbox', { name: 'Анна (пример)', exact: true })).toBeChecked();
  expect(api.mutations.at(-1)).toMatchObject({ method: 'PUT', path: '/api/endpoints/direct-source/access', body: { mode: 'all', allowedSenderIds: ['person-anna'] } });
  expect(state.conversations.some(item => item.bindings.some(binding => binding.endpointId === 'direct-source'))).toBe(false);
});

test('DM mode changes preserve saved humans and the last human cannot be silently removed', async ({ page }) => {
  const state = fixtureState(true);
  state.endpoints = [{ ...fixtureEndpoint('saved-dm', 'slack', 'Личная задача', 'Личные сообщения'), chatId: 'DPRIVATE' }];
  state.sourceAccess = [{ endpointId: 'saved-dm', mode: 'all', allowedSenderIds: ['person-anna'], legacy: false }];
  const api = await installApi(page, state); await openPanel(page);
  await page.getByRole('tab', { name: 'Slack', exact: true }).click();
  const select = page.getByLabel('Режим для Личная задача', { exact: true });
  const row = page.getByRole('row').filter({ has: select });
  await select.selectOption('off');
  await expect(row).toContainText('Доступ сохранён.');
  await expect(select).toBeEnabled();
  await select.selectOption('mention');
  await expect(select).toHaveValue('mention');
  await expect(select).toBeEnabled();
  expect(api.mutations.map(item => item.body)).toEqual([{ mode: 'off' }, { mode: 'mention' }]);
  expect(state.sourceAccess[0].allowedSenderIds).toEqual(['person-anna']);
  await row.getByRole('button', { name: 'Разрешённые люди для Личная задача', exact: true }).click();
  await row.getByRole('checkbox', { name: 'Анна (пример)', exact: true }).click();
  await expect(row.getByRole('alert')).toContainText('хотя бы одного человека');
  await expect(row.getByRole('checkbox', { name: 'Анна (пример)', exact: true })).toBeChecked();
  expect(api.mutations).toHaveLength(2);
});

test('an inline access failure keeps the saved mode and only disables the pending row', async ({ page }) => {
  const state = fixtureState(true); await installApi(page, state);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route('**/api/endpoints/tg-new/access', async route => {
    requests++;
    await gate;
    await route.fulfill({ status: 409, json: { error: 'Источник изменился. Обновите список.' } });
  });
  await openPanel(page);
  const select = page.getByLabel('Режим для Пример: новый чат', { exact: true });
  const row = page.getByRole('row').filter({ has: select });
  await select.selectOption('all');
  await expect(select).toBeDisabled();
  await expect(page.getByLabel('Режим для Команда Альфа', { exact: true })).toBeEnabled();
  release();
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue('off');
  await expect(row.getByRole('alert')).toContainText('Источник изменился');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(requests).toBe(1);
});

test('a bound source can queue a manual initial message without enabling access or changing routes', async ({ page }) => {
  const state = fixtureState(); const original = structuredClone(state.conversations);
  const api = await installApi(page, state);
  const sends: Array<{ method: string; body: string | null }> = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/conversations/conversation-0/initial-message', async route => {
    sends.push({ method: route.request().method(), body: route.request().postData() });
    await gate;
    await route.fulfill({ json: { status: 'queued', operationId: 'synthetic-initial-operation' } });
  });
  await openPanel(page);
  await page.getByRole('button', { name: 'Настройки источника Команда Альфа', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const send = dialog.getByRole('button', { name: 'Послать первичное сообщение', exact: true });
  await expect(send).toBeEnabled();
  expect(sends).toEqual([]);
  await send.click();
  await expect(send).toBeDisabled();
  await expect(dialog).not.toContainText('поставлено в очередь');
  release();
  await expect(dialog).toContainText('Первичное сообщение поставлено в очередь.');
  await expect(send).toBeEnabled();
  expect(sends).toEqual([{ method: 'POST', body: null }]);
  expect(api.mutations).toEqual([]);
  expect(state.conversations).toEqual(original);
});

test('manual initial-message errors stay inline and unbound sources have no send button', async ({ page }) => {
  await installApi(page);
  await page.route('**/api/conversations/conversation-0/initial-message', route => route.fulfill({ status: 409, json: { error: 'Сначала подключите Codex.' } }));
  await openPanel(page);
  await page.getByRole('button', { name: 'Настройки источника Пример: новый чат', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Послать первичное сообщение', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Настройки источника Команда Альфа', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Послать первичное сообщение', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Сначала подключите Codex.');
  await expect(dialog).not.toContainText('поставлено в очередь');
});

test('inline human access remains usable on desktop and mobile without page overflow', async ({ page }, testInfo) => {
  const state = fixtureState(true);
  state.endpoints = [{ ...fixtureEndpoint('mobile-dm', 'slack', 'Личная задача', 'Личные сообщения'), chatId: 'DPRIVATE' }];
  state.sourceAccess = [{ endpointId: 'mobile-dm', mode: 'all', allowedSenderIds: ['person-anna'], legacy: false }];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await installApi(page, state); await openPanel(page);
  await page.getByRole('tab', { name: 'Slack', exact: true }).click();
  await expect(page).toHaveTitle('Rele — Связи');
  await expect(page.getByRole('heading', { name: 'Связи', exact: true })).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: 'Разрешённые люди для Личная задача', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Анна (пример)', exact: true })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('inline-access-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Режим для Личная задача', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('checkbox', { name: 'Михаил (пример)', exact: true }).check();
  await expect(page.getByText('Разрешённых людей: 2', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('inline-access-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('legacy sender restrictions survive viewing and inline disabling without an implicit access expansion', async ({ page }) => {
  const state = fixtureState(); const original = structuredClone(state.conversations[0]);
  const api = await installApi(page, state); await openPanel(page); await navigation(page, 'Связи').click();
  const row = page.getByRole('row').filter({ has: page.getByLabel('Режим для Команда Альфа', { exact: true }) });
  await expect(row).toContainText('После смены режима доступ определяется выбранным вариантом для всех участников');
  expect(api.mutations).toEqual([]);
  await page.getByLabel('Режим для Команда Альфа', { exact: true }).selectOption('off');
  await expect(row).toContainText('Доступ сохранён.');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.conversations[0]).toEqual(original);
  expect(state.sourceAccess?.find(item => item.endpointId === 'tg-alpha')).toMatchObject({ mode: 'off', allowedSenderIds: original.bindings[0].allowedSenderIds });
});

test('per-source automatic routing does not enable access or change neighbouring sources', async ({ page }) => {
  const state = fixtureState(); const original = structuredClone(state.conversations);
  const api = await installApi(page, state); await openPanel(page);
  await page.getByLabel('Разговор Codex для Пример: новый чат', { exact: true }).selectOption('auto');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Первый разрешённый запрос');
  await dialog.getByLabel('Рабочая папка нового разговора').fill('/work/new-source');
  await dialog.getByRole('button', { name: 'Сохранить назначение', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Разговор Codex для Пример: новый чат', { exact: true })).toHaveValue('auto');
  expect(state.conversations).toEqual(original);
  expect(state.sourceAccess?.find(item => item.endpointId === 'tg-new')?.mode).toBe('off');
  expect(state.sourceRoutes).toEqual([{ endpointId: 'tg-new', mode: 'auto', cwd: '/work/new-source' }]);
  expect(api.mutations).toEqual([{ method: 'PUT', path: '/api/endpoints/tg-new/route', body: { autoCreateCwd: '/work/new-source' } }]);
});

test('an unavailable saved source can be disabled and unlinked without reconnecting or losing the conversation', async ({ page }) => {
  const state = fixtureState(); state.connections.telegram.connected = false;
  const api = await installApi(page, state); await openPanel(page);
  await page.getByLabel('Разговор Codex для Команда Альфа', { exact: true }).selectOption('');
  await expect.poll(() => state.conversations[0].bindings.some(item => item.endpointId === 'tg-alpha')).toBe(false);
  await navigation(page, 'Связи').click();
  await page.getByLabel('Режим для Команда Альфа', { exact: true }).selectOption('off');
  await expect(page.getByRole('row').filter({ has: page.getByLabel('Режим для Команда Альфа', { exact: true }) })).toContainText('Доступ сохранён.');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.conversations).toHaveLength(3);
  expect(api.mutations.map(item => item.path)).toEqual(['/api/endpoints/tg-alpha/route', '/api/endpoints/tg-alpha/access']);
});

test('accepted auto creation locks ordinary routing and uncertain recovery requires an explicit confirmation', async ({ page }) => {
  const state = fixtureState();
  const source = state.endpoints.find(item => item.id === 'tg-new')!;
  const rule = { id: `source:${source.id}`, enabled: true, platform: source.platform, accountId: source.accountId, chatId: source.chatId,
    cwd: '/work/alpha', allowedSenderIds: [], requireMention: false, allowAllSenders: true };
  state.sourceAccess = [{ endpointId: source.id, mode: 'all', allowedSenderIds: [], legacy: false }];
  state.sourceRoutes = [{ endpointId: source.id, mode: 'auto', cwd: rule.cwd }];
  state.autoLinks = [{ id: 'saved-auto-intent', endpointId: source.id, rule, targetFingerprint: 'synthetic-hash', status: 'pending', createdAt: '', updatedAt: '' }];
  const api = await installApi(page, state); await openPanel(page);
  const select = page.getByLabel('Разговор Codex для Пример: новый чат', { exact: true });
  await expect(select).toBeDisabled();
  state.autoLinks[0].status = 'uncertain'; state.autoLinks[0].error = 'Подтверждение создания не получено.';
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(select).toBeEnabled();
  await select.selectOption('thread-alpha');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('сохранён');
  expect(api.mutations).toEqual([]);
  await page.keyboard.press('Escape');
  expect(api.mutations).toEqual([]);
  await select.selectOption('thread-alpha');
  await page.getByRole('dialog').getByRole('button', { name: 'Продолжить сохранённые запросы', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(api.mutations).toEqual([{ method: 'PUT', path: '/api/endpoints/tg-new/route', body: { threadId: 'thread-alpha', resolveAutoLinkId: 'saved-auto-intent' } }]);
  expect(state.conversations[0].bindings.some(item => item.endpointId === source.id)).toBe(true);
  expect(state.sourceAccess[0].mode).toBe('all');
});

test('a created thread with a durable error can be recovered only into its known native ID', async ({ page }) => {
  const state = fixtureState(); const source = state.endpoints.find(item => item.id === 'tg-new')!;
  state.sourceRoutes = [{ endpointId: source.id, mode: 'auto', cwd: '/work/alpha' }];
  state.autoLinks = [{ id: 'known-created-intent', endpointId: source.id,
    rule: { id: 'rule', enabled: true, platform: source.platform, accountId: source.accountId, chatId: source.chatId, cwd: '/work/alpha', allowedSenderIds: ['person-anna'], requireMention: false },
    targetFingerprint: 'synthetic-hash', status: 'created', threadId: 'thread-alpha', error: 'Материализация требует проверки.', createdAt: '', updatedAt: '' }];
  const api = await installApi(page, state); await openPanel(page);
  const select = page.getByLabel('Разговор Codex для Пример: новый чат', { exact: true });
  await expect(select).toBeEnabled();
  await expect(select.locator('option[value="thread-docs"]')).toBeDisabled();
  await select.selectOption('thread-alpha');
  await expect(page.getByRole('dialog')).toContainText('сохранён');
  expect(api.mutations).toEqual([]);
  await page.keyboard.press('Escape');
});
