import { expect, test } from '@playwright/test';
import { installApi, panelToken } from './fixtures';

test('launcher instructions come first and manual sign-in requires keyboard opt-in', async ({ page }) => {
  const api = await installApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Вход в панель' })).toBeVisible();
  await expect(page.getByText('rele open --print-url', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Токен панели', { exact: true })).toHaveCount(0);
  const manual = page.getByRole('button', { name: 'Ввести токен вручную', exact: true });
  await page.keyboard.press('Tab');
  await expect(manual).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(manual).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Токен панели', { exact: true })).toBeFocused();
  await page.getByLabel('Токен панели', { exact: true }).fill(panelToken);
  await manual.click();
  await expect(page.getByLabel('Токен панели', { exact: true })).toHaveCount(0);
  await manual.click();
  await expect(page.getByLabel('Токен панели', { exact: true })).toHaveValue(panelToken);
  await page.getByRole('button', { name: 'Открыть Rele', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Связи', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByLabel('Токен панели', { exact: true })).toHaveCount(0);
  expect(api.mutations).toEqual([]);
  await expect(page).toHaveURL('/');
});

test('one-time launch exchange is single in StrictMode and logout never replays it', async ({ page }) => {
  await installApi(page);
  let attempts = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/session/launch', async route => {
    attempts++;
    expect(route.request().postDataJSON()).toEqual({ token: 'synthetic-one-time-link' });
    await gate;
    await route.fulfill({ json: { key: panelToken } });
  });
  await page.goto('/#rele-launch=synthetic-one-time-link');
  await expect(page.getByRole('status')).toContainText('Проверяем одноразовую ссылку');
  await expect(page.getByRole('button', { name: 'Ввести токен вручную', exact: true })).toBeDisabled();
  await expect(page).toHaveURL('/');
  release();
  await expect(page.getByRole('heading', { name: 'Связи', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вход в панель' })).toBeVisible();
  await page.getByRole('button', { name: 'Ввести токен вручную', exact: true }).click();
  await page.getByRole('button', { name: 'Ввести токен вручную', exact: true }).click();
  expect(attempts).toBe(1);
});

for (const failure of ['expired', 'invalid', 'network', 'unauthorized'] as const) {
  test(`${failure} launch keeps recovery error across manual form toggles`, async ({ page }) => {
    const api = await installApi(page);
    let attempts = 0;
    await page.route('**/api/session/launch', async route => {
      attempts++;
      if (failure === 'network') await route.abort('connectionrefused');
      else await route.fulfill({ status: failure === 'expired' ? 410 : failure === 'invalid' ? 400 : 401, json: { error: 'synthetic rejection' } });
    });
    await page.goto('/#rele-launch=synthetic-rejected-link');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('получите новую ссылку запуска');
    await expect(page.getByRole('navigation')).toHaveCount(0);
    const error = await alert.textContent();
    await page.getByRole('button', { name: 'Ввести токен вручную', exact: true }).click();
    await expect(alert).toHaveText(error!);
    await page.getByRole('button', { name: 'Ввести токен вручную', exact: true }).click();
    await expect(alert).toHaveText(error!);
    expect(attempts).toBe(1);
    expect(api.mutations).toEqual([]);
    await expect(page).toHaveURL('/');
    expect(await page.evaluate(() => sessionStorage.getItem('rele.panelToken'))).toBeNull();
  });
}
