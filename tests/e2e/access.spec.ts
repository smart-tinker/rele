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

test('saving mention mode changes only access for that source and leaves shared routing intact', async ({ page }) => {
  const state = fixtureState(); const original = structuredClone(state.conversations);
  const api = await installApi(page, state); await openPanel(page);
  await navigation(page, 'Связи').click();
  await page.getByLabel('Режим для Пример: новый чат', { exact: true }).selectOption('mention');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Режим реакции')).toHaveValue('mention');
  await expect(dialog).toContainText('Все участники');
  expect(api.mutations).toEqual([]);
  await dialog.getByRole('button', { name: 'Сохранить доступ', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Режим для Пример: новый чат', { exact: true })).toHaveValue('mention');
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
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('checkbox', { name: /Другой агент/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Сохранить доступ', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('хотя бы одного человека');
  expect(api.mutations).toEqual([]);
  const peopleSearch = dialog.getByLabel('Поиск участников Slack', { exact: true });
  await peopleSearch.fill('никого');
  await expect(dialog.getByRole('checkbox', { name: 'Анна (пример)', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Очистить поиск участников Slack', exact: true }).click();
  await expect(peopleSearch).toHaveValue('');
  await expect(peopleSearch).toBeFocused();
  await dialog.getByRole('checkbox', { name: 'Анна (пример)', exact: true }).check();
  await dialog.getByRole('button', { name: 'Сохранить доступ', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.mutations.at(-1)).toMatchObject({ method: 'PUT', path: '/api/endpoints/direct-source/access', body: { mode: 'all', allowedSenderIds: ['person-anna'] } });
  expect(state.conversations.some(item => item.bindings.some(binding => binding.endpointId === 'direct-source'))).toBe(false);
});

test('legacy sender restrictions survive viewing, cancelling and disabling without an implicit access expansion', async ({ page }) => {
  const state = fixtureState(); const original = structuredClone(state.conversations[0]);
  const api = await installApi(page, state); await openPanel(page); await navigation(page, 'Связи').click();
  await page.getByRole('button', { name: 'Изменить доступ Команда Альфа', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Сохранение заменит прежний доступ');
  await page.keyboard.press('Escape');
  expect(api.mutations).toEqual([]);
  await page.getByLabel('Режим для Команда Альфа', { exact: true }).selectOption('off');
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить доступ', exact: true }).click();
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
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить доступ', exact: true }).click();
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
