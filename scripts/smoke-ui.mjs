import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { ConfigStore, mergeConfig } from '../dist/server/config.js';

// Exercise the built UI against the real HTTP server without a live account,
// model, or messenger. The deliberately missing executable prevents attachment
// to an existing Codex runtime; all data lives in a disposable directory.
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'Rele UI smoke '));
const syntheticToken = '123456:synthetic_ui_smoke_secret_123456';
const config = new ConfigStore(directory);
const browserErrors = [];
const bearerFailures = [];
let server;
let browser;
const runFile = promisify(execFile);

async function launchUrl(address) {
  let output;
  try {
    output = await runFile(
      process.execPath,
      ['dist/server/main.js', 'open', '--print-url'],
      {
        cwd: root,
        env: { ...process.env, RELE_DATA_DIR: directory, RELE_PORT: '0' },
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
  } catch (cause) {
    throw new Error(
      `Opening the production panel failed: ${config.redact(String(cause.stderr || cause.message))}`,
    );
  }
  const url = new URL(output.stdout.trim());
  assert.equal(url.origin + url.pathname, address);
  assert.equal(url.search, '');
  const fragment = new URLSearchParams(url.hash.slice(1));
  assert.deepEqual([...fragment.keys()], ['rele-launch']);
  assert.ok(
    fragment.get('rele-launch'),
    'CLI did not return a one-time launch credential',
  );
  assert.equal(
    url.href.includes(config.panelToken),
    false,
    'CLI put the permanent panel key in the launch URL',
  );
  return url.href;
}

async function start() {
  const child = spawn(process.execPath, ['dist/server/main.js'], {
    cwd: root,
    env: { ...process.env, RELE_DATA_DIR: directory, RELE_PORT: '0' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk.toString();
  });
  child.on('error', (error) => {
    errors += error.message;
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    const address = output.match(/Rele: (http:\/\/127\.0\.0\.1:\d+\/)/u)?.[1];
    if (address) return address;
    assert.equal(
      child.exitCode,
      null,
      `Server stopped during startup: ${config.redact(errors)}`,
    );
    await delay(100);
  }
  throw new Error(
    `Server did not report its listening address: ${config.redact(errors)}`,
  );
}

async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill();
  for (
    let attempt = 0;
    attempt < 50 && server.exitCode === null && server.signalCode === null;
    attempt++
  )
    await delay(100);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    for (
      let attempt = 0;
      attempt < 20 && server.exitCode === null && server.signalCode === null;
      attempt++
    )
      await delay(100);
  }
}

async function state(address) {
  const response = await fetch(new URL('api/state', address), {
    headers: { authorization: `Bearer ${config.panelToken}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = await response.json();
  assert.equal(
    JSON.stringify(value).includes(config.panelToken),
    false,
    'State exposed the panel credential',
  );
  assert.equal(
    JSON.stringify(value).includes(syntheticToken),
    false,
    'State exposed a saved messenger credential',
  );
  return value;
}

async function pageFor(address, launch = false) {
  const context = await browser.newContext({
    viewport: { width: 1536, height: 1024 },
  });
  const page = await context.newPage();
  const launchRequests = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /Content Security Policy/iu.test(message.text())
    )
      browserErrors.push(message.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      if (
        url.pathname === '/api/session/launch' &&
        request.method() === 'POST'
      ) {
        launchRequests.push(request);
        if (request.headers().authorization)
          bearerFailures.push('Launch exchange sent an Authorization header');
        return;
      }
      if (request.headers().authorization !== `Bearer ${config.panelToken}`)
        bearerFailures.push(url.pathname);
      if (request.url().includes(config.panelToken))
        bearerFailures.push('An API URL exposed the panel credential');
    }
  });
  const response = await page.goto(address);
  assert.equal(response.status(), 200);
  assert.ok(
    response
      .headers()
      ['content-security-policy']?.includes("script-src 'self'"),
  );
  await expect(
    page.getByRole('heading', { name: 'Вход в панель', exact: true }),
  ).toBeVisible();
  await page.goto('about:blank');
  const loginUrl = launch
    ? await launchUrl(address)
    : `${address}#token=${config.panelToken}`;
  await page.goto(loginUrl);
  await expect(
    page.getByRole('heading', { name: 'Связки', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(address);
  await expect(
    page.getByRole('heading', { name: 'Создайте первую связку', exact: true }),
  ).toBeVisible();
  if (launch) {
    assert.equal(
      launchRequests.length,
      1,
      'One-time login was exchanged more than once',
    );
    assert.equal(
      launchRequests[0].postDataJSON().token ===
        new URLSearchParams(new URL(loginUrl).hash.slice(1)).get('rele-launch'),
      true,
      'UI did not exchange the CLI launch credential',
    );
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Связки', exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(address);
    assert.equal(
      launchRequests.length,
      1,
      'Reload reused the one-time login link',
    );
  }
  return { context, page };
}

async function catalogUnavailable(page, address) {
  let reason = '';
  await expect
    .poll(async () => {
      reason = (await state(address)).codex.error || '';
      return reason;
    })
    .not.toBe('');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Codex', exact: true })
    .click();
  await expect(page.getByText(reason, { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Codex не подключён', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Список разговоров пока пуст', { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Связки', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Новая связка', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByLabel('Разговор Codex', { exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByText('Codex не подключён.', { exact: false }),
  ).toBeVisible();
  await expect(
    dialog.getByText('Нет свободных разговоров Codex.', { exact: false }),
  ).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
}

try {
  await config.load();
  await config.save(
    mergeConfig(config.config, {
      codex: {
        executable: path.join(directory, 'codex-deliberately-not-installed'),
      },
    }),
  );
  let address = await start();
  assert.equal((await fetch(new URL('api/health', address))).status, 200);
  assert.equal((await fetch(new URL('api/state', address))).status, 401);
  const initial = await state(address);
  assert.deepEqual(initial.conversations, []);
  assert.deepEqual(initial.endpoints, []);
  assert.equal(initial.codex.desktopVerified, false);
  browser = await chromium.launch(
    process.env.RELE_TEST_BROWSER
      ? { executablePath: process.env.RELE_TEST_BROWSER }
      : {},
  );
  const first = await pageFor(address, true);
  await catalogUnavailable(first.page, address);
  await first.page
    .getByRole('navigation')
    .getByRole('button', { name: 'Подключения', exact: true })
    .click();
  await expect(
    first.page.getByLabel('Включить Telegram', { exact: true }),
  ).not.toBeChecked();
  await first.page
    .getByLabel('Токен бота Telegram', { exact: true })
    .fill(syntheticToken);
  await first.page
    .getByRole('button', { name: 'Сохранить Telegram', exact: true })
    .click();
  await expect(
    first.page.getByText(
      'Настройки Telegram сохранены. Состояние подключения обновится автоматически.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    first.page.getByLabel('Токен бота Telegram', { exact: true }),
  ).toHaveValue('');
  assert.deepEqual((await state(address)).config.telegram, {
    enabled: false,
    tokenConfigured: true,
  });
  await first.context.close();
  await stop();
  const persisted = new ConfigStore(directory);
  await persisted.load();
  assert.equal(
    persisted.panelToken === config.panelToken,
    true,
    'Panel credential changed after a configuration save',
  );
  assert.equal(
    persisted.config.telegram.token === syntheticToken,
    true,
    'Saved configuration was not retained',
  );
  address = await start();
  const restarted = await state(address);
  assert.deepEqual(restarted.config.telegram, {
    enabled: false,
    tokenConfigured: true,
  });
  assert.deepEqual(restarted.conversations, []);
  const second = await pageFor(address);
  await second.page
    .getByRole('navigation')
    .getByRole('button', { name: 'Подключения', exact: true })
    .click();
  await expect(
    second.page.getByLabel('Токен бота Telegram', { exact: true }),
  ).toHaveValue('');
  await expect(
    second.page.getByText(
      'Токен сохранён. Оставьте поле пустым, чтобы использовать его.',
      { exact: true },
    ),
  ).toBeVisible();
  await second.context.close();
  assert.deepEqual(browserErrors, [], 'Production JavaScript or CSP errors');
  assert.deepEqual(
    bearerFailures,
    [],
    'A UI API request was missing its bearer',
  );
  console.log(
    JSON.stringify({
      result: 'passed',
      productionJavaScript: true,
      csp: true,
      bearer: true,
      oneTimeBrowserLogin: true,
      catalogConnectionError: true,
      emptyState: true,
      configWriteOnly: true,
      configSurvivesRestart: true,
    }),
  );
} finally {
  await browser?.close();
  await stop();
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
