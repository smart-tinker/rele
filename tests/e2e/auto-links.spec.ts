import { expect, test } from '@playwright/test';
import type { CatalogChat, CatalogPage, Person } from '../../src/shared/types';
import { fixtureEndpoint, fixtureState, installApi, openPanel } from './fixtures';

test('automatic conversation creation is explicit, named, editable, and leaves existing bindings intact', async ({ page }) => {
  const state = fixtureState();
  const api = await installApi(page, state);
  const originals = structuredClone(state.conversations);
  const consoleErrors: string[] = [];
  page.on('pageerror', error => consoleErrors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) consoleErrors.push(message.text()); });
  await openPanel(page);
  await page.getByRole('button', { name: 'Доступ', exact: true }).click();
  await expect(page).toHaveTitle('Rele — Доступ');
  await expect(page.getByRole('heading', { name: 'Новые разговоры из мессенджера' })).toBeVisible();
  await page.getByRole('button', { name: 'Добавить правило', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Разрешить автоматическое создание новых разговоров в этом чате')).not.toBeChecked();
  await expect(dialog.getByLabel('В группах создавать разговор только при упоминании подключённого агента')).toBeChecked();
  await dialog.getByLabel('Чат для новых разговоров').selectOption('sl-alpha-chat');
  await dialog.getByLabel('Рабочая папка новых разговоров').fill('/work/alpha');
  await expect(dialog.getByText('Все участники выбранной группы или канала, включая агентов, получают право запускать Codex. Отдельный список отправителей не требуется.')).toBeVisible();
  await expect(dialog.getByRole('group', { name: 'Кто может отправлять запросы' })).toHaveCount(0);
  await dialog.getByLabel('В группах создавать разговор только при упоминании подключённого агента').uncheck();
  await dialog.getByLabel('Разрешить автоматическое создание новых разговоров в этом чате').check();
  await dialog.getByRole('button', { name: 'Сохранить правило', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.config.autoLinkRules).toHaveLength(1);
  expect(state.config.autoLinkRules![0]).toMatchObject({ enabled: true, platform: 'slack', accountId: 'slack-test-account', chatId: 'sl-alpha-chat', cwd: '/work/alpha', allowedSenderIds: [], requireMention: false, allowAllSenders: true });
  expect(JSON.stringify(api.mutations)).not.toContain('tokenConfigured');
  await page.getByRole('button', { name: 'Выключить правило', exact: true }).click();
  await expect(page.getByText('Автосоздание выключено.', { exact: true })).toBeVisible();
  expect(state.config.autoLinkRules![0].enabled).toBe(false);
  await page.getByRole('button', { name: 'Удалить правило', exact: true }).click();
  await expect(page.getByText('Правило удалено. Созданные связки сохранены.', { exact: true })).toBeVisible();
  expect(state.config.autoLinkRules).toEqual([]);
  expect(state.conversations).toEqual(originals);
  expect(consoleErrors).toEqual([]);
  await page.getByRole('heading', { name: 'Новые разговоры из мессенджера' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/rele-auto-links-desktop.png', fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Добавить правило', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('heading', { name: 'Новые разговоры из мессенджера' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/rele-auto-links-mobile.png', fullPage: false });
});


test('private automatic rules require selected humans and uncertain creation stays visible without retrying', async ({ page }) => {
  const state = fixtureState();
  const direct = { ...fixtureEndpoint('private-people', 'slack', 'Личный чат с Анной', 'Личные сообщения'), chatId: 'DPRIVATE', people: [{ id: 'human', name: 'Анна лично' }, { id: 'agent', name: 'Агент (бот)', isBot: true }] };
  state.endpoints.push(direct);
  const api = await installApi(page, state);
  await openPanel(page);
  await page.getByRole('button', { name: 'Доступ', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить правило', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Чат для новых разговоров').selectOption('DPRIVATE');
  await dialog.getByLabel('Рабочая папка новых разговоров').fill('/work/private');
  await expect(dialog.getByLabel('Агент (бот)')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Сохранить правило', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('разрешённых людей');
  expect(api.mutations).toHaveLength(0);
  await dialog.getByLabel('Анна лично').check();
  await dialog.getByLabel('Разрешить автоматическое создание новых разговоров в этом чате').check();
  await dialog.getByRole('button', { name: 'Сохранить правило', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const rule = state.config.autoLinkRules![0];
  expect(rule).toMatchObject({ allowAllSenders: false, allowedSenderIds: ['human'] });
  state.autoLinks = [{ id: 'uncertain-example', endpointId: direct.id, rule, targetFingerprint: 'synthetic-hash', status: 'uncertain', error: 'Подтверждение создания не получено.', createdAt: '', updatedAt: '' }];
  await page.getByRole('button', { name: 'Связи', exact: true }).click();
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await page.getByRole('button', { name: 'Доступ', exact: true }).click();
  const journal = page.getByLabel('Журнал автосоздания');
  await expect(journal).toContainText('Нужно проверить');
  await expect(journal).toContainText('Повторное создание автоматически не выполняется.');
  expect(api.mutations).toHaveLength(1);
});



test('fresh partial Slack catalog makes an unavailable cached DM selectable with a human-only rule', async ({ page }) => {
  const state = fixtureState(true);
  state.endpoints = [{
    ...fixtureEndpoint('observed-private', 'slack', 'Старая подпись DM', 'Личные сообщения'),
    chatId: 'DANNA', threadId: '1770000000.100000', chatTitle: 'Устаревшее название', available: false,
  }];
  const warning = 'Каталог Slack частичный: не выданы разрешения mpim:read. Чтобы добавить остальные типы чатов, обновите разрешения приложения в workspace.';
  const channel: CatalogChat = { id: 'CPUBLIC', name: '#публичный', subtitle: 'Канал', kind: 'channel' };
  const direct: CatalogChat = { id: 'DANNA', name: 'Анна из Slack', subtitle: 'Личные сообщения', kind: 'direct' };
  const catalog: { chats: CatalogPage<CatalogChat>[]; people: Record<string, CatalogPage<Person>[]> } = {
    chats: [{ items: [channel], nextCursor: 'dm-page', warning }, { items: [direct] }],
    people: { DANNA: [{ items: [{ id: 'UANNA', name: 'Анна из Slack' }, { id: 'UPEERBOT', name: 'Другой агент', isBot: true }] }] },
  };
  const api = await installApi(page, state, catalog);
  const consoleErrors: string[] = [];
  page.on('pageerror', error => consoleErrors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) consoleErrors.push(message.text()); });
  await openPanel(page);
  await page.getByRole('button', { name: 'Доступ', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить правило', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const chat = dialog.getByLabel('Чат для новых разговоров');
  const notice = dialog.getByText(warning, { exact: true });
  await expect(notice).toBeVisible();
  await expect(notice).toHaveClass(/notice-warning/);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(chat.locator('option[value="DANNA"]')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Загрузить ещё чаты для автосоздания', exact: true }).click();
  await expect(chat.locator('option[value="DANNA"]')).toHaveText('Анна из Slack');
  await expect(notice).toBeVisible();
  await expect(chat).not.toContainText('Устаревшее название');
  await chat.selectOption('DANNA');
  await dialog.getByLabel('Рабочая папка новых разговоров').fill('/work/private');
  await expect(dialog.getByLabel('Другой агент')).toHaveCount(0);
  await dialog.getByLabel('Анна из Slack', { exact: true }).check();
  await dialog.getByLabel('Разрешить автоматическое создание новых разговоров в этом чате').check();
  await page.screenshot({ path: test.info().outputPath('dm-catalog-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(notice).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('dm-catalog-mobile.png') });
  await page.setViewportSize({ width: 1536, height: 1024 });
  // A fresh complete response clears the earlier warning without losing the selected DM.
  catalog.chats = [{ items: [channel, direct] }];
  await dialog.getByRole('button', { name: 'Обновить чаты для автосоздания', exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(chat).toHaveValue('DANNA');
  await expect(dialog.getByLabel('Анна из Slack', { exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Сохранить правило', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(api.mutations).toEqual([{ method: 'PUT', path: '/api/config', body: { autoLinkRules: [{
    id: expect.any(String), enabled: true, platform: 'slack', accountId: 'slack-test-account', chatId: 'DANNA',
    cwd: '/work/private', allowedSenderIds: ['UANNA'], requireMention: true, allowAllSenders: false,
  }] } }]);
  expect(state.config.autoLinkRules).toHaveLength(1);
  expect(consoleErrors).toEqual([]);
});
