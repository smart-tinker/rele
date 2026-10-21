import { expect, test } from '@playwright/test';
import type {
  CodexConnectionTarget,
  CodexDiscoveryResult,
  CodexThread,
} from '../../src/shared/types';
import { fixtureState, installApi, openPanel, panelToken } from './fixtures';

test('one-time launch links are exchanged once after the URL is cleaned and survive reload', async ({
  page,
}) => {
  await installApi(page);
  const launchToken = 'synthetic-one-time-launch';
  const exchanges: Array<{ body: unknown; authorization?: string }> = [];
  const apiUrls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  page.on('request', (request) => {
    if (request.url().includes('/api/')) apiUrls.push(request.url());
  });
  await page.route('**/api/session/launch', async (route) => {
    exchanges.push({
      body: route.request().postDataJSON(),
      authorization: route.request().headers().authorization,
    });
    await gate;
    await route.fulfill({ json: { key: panelToken } });
  });
  await page.goto(`/#rele-launch=${launchToken}`);
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('status')).toContainText(
    'Проверяем одноразовую ссылку',
  );
  await expect
    .poll(() => exchanges)
    .toEqual([{ body: { token: launchToken }, authorization: undefined }]);
  expect(
    await page.evaluate(() => sessionStorage.getItem('rele.panelToken')),
  ).toBeNull();
  release();
  await expect(
    page.getByRole('heading', { name: 'Связи', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem('rele.panelToken')),
  ).toBe(panelToken);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Связи', exact: true }),
  ).toBeVisible();
  expect(exchanges).toHaveLength(1);
  expect(
    apiUrls.every(
      (url) => !url.includes(launchToken) && !url.includes(panelToken),
    ),
  ).toBe(true);
});

test('expired launch links offer manual sign-in and are never retried on reload', async ({
  page,
}) => {
  await installApi(page);
  let exchanges = 0;
  await page.route('**/api/session/launch', async (route) => {
    exchanges += 1;
    await route.fulfill({
      status: 401,
      json: { error: 'Launch token is invalid or expired' },
    });
  });
  await page.goto('/#rele-launch=synthetic-expired-link');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('alert')).toContainText(
    'Ссылка для входа истекла или уже использована',
  );
  await expect(page.getByLabel('Токен панели')).toBeEnabled();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Вход в панель', exact: true }),
  ).toBeVisible();
  expect(exchanges).toBe(1);
  await page.getByLabel('Токен панели').fill(panelToken);
  await page.getByRole('button', { name: 'Открыть Rele', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Связи', exact: true }),
  ).toBeVisible();
});

test('disconnected and failing Codex catalogs never appear as empty and can recover', async ({
  page,
}) => {
  const state = fixtureState(true);
  state.codex.connected = false;
  state.codex.error = 'Пример: общий сервер Codex не запущен.';
  const api = await installApi(page, state);
  await openPanel(page);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Codex', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Codex не подключён', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Список разговоров пока пуст', { exact: true }),
  ).toHaveCount(0);
  expect(api.reads.filter((path) => path.startsWith('/api/threads'))).toEqual(
    [],
  );
  state.codex.connected = true;
  state.codex.error = undefined;
  await page.route('**/api/threads?*', (route) => {
    expect(new URL(route.request().url()).searchParams.get('refresh')).not.toBe('true');
    return route.fulfill({
      status: 503,
      json: { error: 'Пример: список разговоров временно недоступен.' },
    });
  });
  await page
    .getByRole('button', { name: 'Переподключить', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Не удалось загрузить разговоры',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Список разговоров пока пуст', { exact: true }),
  ).toHaveCount(0);
  await page.unroute('**/api/threads?*');
  await page.getByRole('button', { name: 'Обновить разговоры', exact: true }).click();
  await expect(page.getByRole('table')).toContainText('Пример: новый проект');
});

test('saved managed mode recommends a usable Desktop executable independently of its external connection', async ({
  page,
}, testInfo) => {
  const state = fixtureState(true);
  state.config.codex.codexHome = '/profiles/shared';
  state.codex.codexHome = '/profiles/shared';
  const candidate: CodexConnectionTarget = {
    executable: '/opt/example/desktop/codex',
    transport: 'managed',
    endpoint: '',
  };
  const otherManaged: CodexConnectionTarget = {
    executable: '/opt/example/cli/codex',
    transport: 'managed',
    endpoint: '',
  };
  const external: CodexConnectionTarget = {
    ...otherManaged,
    transport: 'websocket',
    endpoint: 'ws://127.0.0.1:4500',
  };
  const discovery: CodexDiscoveryResult = {
    installations: [
      {
        executable: candidate.executable,
        name: 'Codex Desktop (пример)',
        source: 'desktop-process',
        version: '0.164.0-alpha.1',
        running: true,
        managedConnection: candidate,
      },
      {
        executable: otherManaged.executable,
        name: 'Codex CLI (пример)',
        source: 'path',
        version: '0.163.0-alpha.10.2',
        running: false,
        connection: external,
        managedConnection: otherManaged,
      },
      {
        executable: '/opt/example/unavailable/codex',
        name: 'Недоступная установка (пример)',
        source: 'standard',
        running: false,
      },
    ],
    recommended: external,
    recommendedManaged: candidate,
    issues: [
      {
        code: 'desktop-stdio',
        message: 'Пример: внешнее подключение к процессу Desktop недоступно.',
      },
      {
        code: 'probe-failed',
        message: 'Пример: третья установка не отвечает.',
      },
    ],
  };
  const api = await installApi(page, state, { discovery });
  const oldThread: CodexThread = {
    id: 'old-runtime',
    name: 'Пример: прежний сервер',
    cwd: '/work/old',
    preview: '',
    updatedAt: 1792353600,
  };
  const newThread: CodexThread = {
    ...oldThread,
    id: 'new-runtime',
    name: 'Пример: выбранный сервер',
    cwd: '/work/new',
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let nextRequested = false;
  await page.route('**/api/threads?*', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('refresh')).not.toBe('true');
    const changed = state.config.codex.executable === candidate.executable;
    if (changed) {
      nextRequested = true;
      await gate;
    }
    await route.fulfill({
      json: { threads: [changed ? newThread : oldThread] },
    });
  });
  await openPanel(page);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Codex', exact: true })
    .click();
  await expect(page.getByLabel('Режим работы', { exact: true })).toHaveValue('managed');
  await expect(page.getByRole('radio', { name: /Находить Codex автоматически/ })).toBeChecked();
  await expect(page.getByRole('table')).toContainText(oldThread.name);
  await expect(page.getByLabel('Фактическое подключение Codex')).toContainText(
    'Codex 0.163.0-alpha.10.2',
  );
  await expect(page.getByLabel('Фактическое подключение Codex')).toContainText('/profiles/shared');
  await expect(page.getByText('CLI: 0.164.0-alpha.1', { exact: false })).toBeVisible();
  await expect(page.getByText(discovery.issues[0].message, { exact: true })).toHaveCount(0);
  await expect(page.getByText(discovery.issues[1].message, { exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Недоступная установка/ })).toBeDisabled();
  await expect(page.getByRole('radio', { name: /Codex Desktop \(пример\)/ })).toBeEnabled();
  expect(api.mutations).toEqual([]);
  await page.getByRole('button', { name: 'Выбрать рекомендуемый', exact: true }).click();
  await expect(page.getByRole('radio', { name: /Codex Desktop \(пример\)/ })).toBeChecked();
  await expect(page.getByLabel('Папка профиля Codex', { exact: true })).toHaveValue('/profiles/shared');
  expect(api.mutations).toEqual([]);
  await page.getByRole('button', { name: 'Сохранить Codex', exact: true }).click();
  await expect.poll(() => api.mutations.at(-1)?.body).toEqual({
    codex: { ...candidate, codexHome: '/profiles/shared' },
  });
  await expect.poll(() => nextRequested).toBe(true);
  await expect(page.getByText(oldThread.name, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Загружаем разговоры…', exact: true })).toBeVisible();
  release();
  await expect(page.getByRole('table')).toContainText(newThread.name);
  await expect(page.getByRole('radio', { name: /Codex Desktop \(пример\)/ })).toBeChecked();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('managed-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Режим работы', { exact: true })).toHaveValue('managed');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('managed-mobile.png'), fullPage: true });
  await page.getByRole('radio', { name: /Codex CLI \(пример\)/ }).check();
  await page.getByRole('button', { name: 'Сохранить Codex', exact: true }).click();
  await expect.poll(() => api.mutations.at(-1)?.body).toEqual({
    codex: { ...otherManaged, codexHome: '/profiles/shared' },
  });
  await page.getByRole('radio', { name: /Находить Codex автоматически/ }).check();
  await page.getByLabel('Папка профиля Codex', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Сохранить Codex', exact: true }).click();
  await expect.poll(() => api.mutations.at(-1)?.body).toEqual({
    codex: { executable: 'codex', transport: 'managed', endpoint: '', codexHome: '' },
  });
  const readsBefore = api.reads.filter((path) => path === '/api/codex/discovery').length;
  await page.getByRole('button', { name: 'Повторить поиск', exact: true }).click();
  await expect.poll(() => api.reads.filter((path) => path === '/api/codex/discovery').length)
    .toBeGreaterThan(readsBefore);
});

for (const transport of ['proxy', 'websocket'] as const) {
  test(`saved ${transport} stays external until an explicit change and never carries its endpoint into shared mode`, async ({ page }) => {
    const state = fixtureState(true);
    const saved: CodexConnectionTarget = {
      executable: '/opt/example/external/codex',
      transport,
      endpoint: transport === 'proxy' ? '/run/example/codex.sock' : 'ws://127.0.0.1:4500',
      codexHome: '/profiles/legacy',
    };
    state.config.codex = { ...saved, tokenConfigured: true };
    state.codex = { ...state.codex, ...saved };
    const api = await installApi(page, state);
    await openPanel(page);
    await page.getByRole('navigation').getByRole('button', { name: 'Codex', exact: true }).click();
    await expect(page.getByLabel('Режим работы', { exact: true })).toHaveValue(transport);
    await expect(page.getByRole('radio', { name: /Указать параметры вручную/ })).toBeChecked();
    await expect(page.getByLabel('Исполняемый файл Codex', { exact: true })).toHaveValue(saved.executable);
    await expect(page.getByLabel(transport === 'proxy' ? 'Локальный сокет Codex' : 'Адрес app-server', { exact: true })).toHaveValue(saved.endpoint);
    await expect(page.getByLabel('Папка профиля Codex', { exact: true })).toHaveValue('/profiles/legacy');
    await expect(page.getByRole('button', { name: 'Перейти на общий Codex', exact: true })).toBeVisible();
    await expect(page.getByText('CLI: 0.163.0-alpha.10.2', { exact: false })).toBeVisible();
    expect(api.mutations).toEqual([]);
    await page.getByRole('button', { name: 'Сохранить Codex', exact: true }).click();
    await expect.poll(() => api.mutations.at(-1)?.body).toEqual({ codex: saved });
    if (transport === 'websocket') {
      await page.getByLabel('Токен app-server', { exact: true }).fill('synthetic-unsaved-websocket-key');
      await page.getByLabel('Режим работы', { exact: true }).selectOption('proxy');
      await expect(page.getByLabel('Адрес app-server', { exact: true })).toHaveCount(0);
      await expect(page.getByLabel('Локальный сокет Codex', { exact: true })).toHaveValue('');
      await page.getByRole('button', { name: 'Сохранить Codex', exact: true }).click();
      await expect.poll(() => api.mutations.at(-1)?.body).toEqual({
        codex: { ...saved, transport: 'proxy', endpoint: '' },
      });
    }
    const writesBefore = api.mutations.length;
    await page.getByRole('button', { name: 'Перейти на общий Codex', exact: true }).click();
    await expect(page.getByLabel('Режим работы', { exact: true })).toHaveValue('shared');
    await expect(page.getByRole('radio', { name: /Находить Codex автоматически/ })).toBeChecked();
    await expect(page.getByLabel('Папка профиля Codex', { exact: true })).toHaveValue('/profiles/legacy');
    expect(api.mutations).toHaveLength(writesBefore);
    await page.getByRole('button', { name: 'Сохранить Codex', exact: true }).click();
    await expect.poll(() => api.mutations.at(-1)?.body).toEqual({
      codex: { executable: 'codex', transport: 'shared', endpoint: '', codexHome: '/profiles/legacy' },
    });
  });
}

test('an actual profile change clears the previous thread catalog even when saved settings are unchanged', async ({ page }) => {
  const state = fixtureState(true);
  state.codex.codexHome = '/profiles/first';
  await installApi(page, state);
  const firstThread: CodexThread = {
    id: 'profile-first-thread',
    name: 'Пример: первый профиль',
    cwd: '/work/first',
    preview: '',
    updatedAt: 1792353600,
  };
  const secondThread = { ...firstThread, id: 'profile-second-thread', name: 'Пример: второй профиль' };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let nextRequested = false;
  await page.route('**/api/threads?*', async (route) => {
    const changed = state.codex.codexHome === '/profiles/second';
    if (changed) {
      nextRequested = true;
      await gate;
    }
    await route.fulfill({ json: { threads: [changed ? secondThread : firstThread] } });
  });
  await openPanel(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Codex', exact: true }).click();
  await expect(page.getByRole('table')).toContainText(firstThread.name);
  await expect(page.getByLabel('Папка профиля Codex', { exact: true })).toHaveValue('');
  state.codex.codexHome = '/profiles/second';
  await expect(page.getByLabel('Фактическое подключение Codex')).toContainText('/profiles/second', { timeout: 10000 });
  await expect.poll(() => nextRequested).toBe(true);
  await expect(page.getByText(firstThread.name, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Загружаем разговоры…', exact: true })).toBeVisible();
  release();
  await expect(page.getByRole('table')).toContainText(secondThread.name);
  await expect(page.getByLabel('Папка профиля Codex', { exact: true })).toHaveValue('');
});


test('shared mode saves an automatic policy without a transient endpoint and preserves its profile', async ({ page }, testInfo) => {
  const state = fixtureState(true);
  state.config.codex = { executable: 'codex', transport: 'shared', endpoint: '', codexHome: '/profiles/shared', tokenConfigured: false };
  state.codex = { ...state.codex, transport: 'shared', endpoint: '/profiles/shared/app-server-control/app-server-control.sock', codexHome: '/profiles/shared' };
  const api = await installApi(page, state);
  await openPanel(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Codex', exact: true }).click();
  await expect(page.getByLabel('Режим работы', { exact: true })).toHaveValue('shared');
  await expect(page.getByRole('radio', { name: /Находить Codex автоматически/ })).toBeChecked();
  await expect(page.getByText('Rele подключается к общему Codex или запускает его.', { exact: false })).toBeVisible();
  expect(api.mutations).toEqual([]);
  await page.getByRole('button', { name: 'Выбрать рекомендуемый', exact: true }).click();
  await expect(page.getByRole('radio', { name: /Находить Codex автоматически/ })).toBeChecked();
  await page.getByRole('button', { name: 'Сохранить Codex', exact: true }).click();
  await expect.poll(() => api.mutations.at(-1)?.body).toEqual({ codex: { executable: 'codex', transport: 'shared', endpoint: '', codexHome: '/profiles/shared' } });
  await page.screenshot({ path: testInfo.outputPath('shared-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Режим работы', { exact: true })).toHaveValue('shared');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('shared-mobile.png'), fullPage: true });
});
