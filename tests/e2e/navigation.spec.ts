import { expect, test, type Page } from '@playwright/test';
import { fixtureRequest, fixtureState, installApi, openPanel, panelToken } from './fixtures';

const nav = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });

for (const [view, label] of [
  ['conversations', 'Связи'], ['queue', 'Очередь'], ['deliveries', 'Доставка'],
  ['connections', 'Подключения'], ['codex', 'Codex'],
]) {
  test(`direct ${view} URL and refresh restore title and active navigation`, async ({ page }) => {
    const api = await installApi(page);
    await page.goto(`/?view=${view}#token=${panelToken}`);
    await expect(page).toHaveTitle(`Rele — ${label}`);
    await expect(nav(page, label)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1, name: label, exact: true })).toBeVisible();
    await page.reload();
    await expect(page).toHaveTitle(`Rele — ${label}`);
    await expect(nav(page, label)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1, name: label, exact: true })).toBeVisible();
    expect(api.mutations).toEqual([]);
  });
}

test('queue filter and Back/Forward restore states without duplicate history entries', async ({ page }) => {
  const state = fixtureState();
  state.requests.push({ ...fixtureRequest('completed-example', 'completed'), text: 'Синтетический завершённый запрос' });
  const api = await installApi(page, state);
  await openPanel(page);
  await nav(page, 'Очередь').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/?view=queue');
  await expect(page.getByText('Синтетический завершённый запрос', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Все запросы', exact: true }).click();
  await expect(page).toHaveURL('/?view=queue&queue=all');
  await expect(page.getByRole('row').filter({ hasText: 'Синтетический завершённый запрос' })).toBeVisible();
  const length = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: 'Все запросы', exact: true }).click();
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Все запросы', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goBack();
  await expect(page).toHaveURL('/?view=queue');
  await expect(page.getByRole('button', { name: 'Активные', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Синтетический завершённый запрос', { exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveTitle('Rele — Связи');
  await page.goForward();
  await expect(page).toHaveTitle('Rele — Очередь');
  await page.goForward();
  await expect(page.getByRole('button', { name: 'Все запросы', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(api.mutations).toEqual([]);
});

for (const [query, path, title] of [
  ['view=retired&queue=all&redirect=https%3A%2F%2Fexample.invalid', '/', 'Связи'],
  ['view=queue&queue=invalid', '/?view=queue', 'Очередь'],
  ['view=deliveries&queue=all', '/?view=deliveries', 'Доставка'],
]) {
  test(`unsupported navigation ${query} falls back safely without mutations`, async ({ page }) => {
    const state = fixtureState(true);
    const api = await installApi(page, state);
    await page.goto(`/?${query}#token=${panelToken}`);
    await expect(page).toHaveTitle(`Rele — ${title}`);
    await expect(page).toHaveURL(path);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect(api.mutations).toEqual([]);
  });
}

test('unauthorized direct link keeps its safe destination through sign-in and logout', async ({ page }) => {
  const state = fixtureState(true);
  const api = await installApi(page, state);
  await page.goto('/?view=queue&queue=all');
  await expect(page.getByRole('heading', { name: 'Вход в панель' })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ввести токен вручную', exact: true }).click();
  await page.getByLabel('Токен панели', { exact: true }).fill(panelToken);
  await page.getByRole('button', { name: 'Открыть Rele', exact: true }).click();
  await expect(page).toHaveTitle('Rele — Очередь');
  await expect(page.getByRole('button', { name: 'Все запросы', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Запросов пока нет', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page).toHaveURL('/?view=queue&queue=all');
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Запросов пока нет', exact: true })).toHaveCount(0);
  const reads = api.reads.length;
  await page.waitForTimeout(4200);
  expect(api.reads).toHaveLength(reads);
  expect(await page.evaluate(() => sessionStorage.getItem('rele.panelToken'))).toBeNull();
  expect(api.mutations).toEqual([]);
});

test('quick navigation survives a late data refresh and does not add entries for polling', async ({ page }) => {
  const state = fixtureState();
  await installApi(page, state);
  await openPanel(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let pending = false;
  await page.route('**/api/state', async route => {
    pending = true;
    await gate;
    await route.fulfill({ json: state });
  });
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect.poll(() => pending).toBe(true);
  await nav(page, 'Очередь').click();
  await nav(page, 'Доставка').click();
  await expect(page).toHaveURL('/?view=deliveries');
  const length = await page.evaluate(() => history.length);
  release();
  await expect(page).toHaveTitle('Rele — Доставка');
  await expect(nav(page, 'Доставка')).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goBack();
  await expect(page).toHaveTitle('Rele — Очередь');
});
