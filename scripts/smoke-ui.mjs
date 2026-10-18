import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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

async function pageFor(address) {
  const context = await browser.newContext({
    viewport: { width: 1536, height: 1024 },
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /Content Security Policy/iu.test(message.text())
    )
      browserErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) {
      if (request.headers().authorization !== `Bearer ${config.panelToken}`)
        bearerFailures.push(new URL(request.url()).pathname);
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
  await page.goto(`${address}#token=${config.panelToken}`);
  await expect(
    page.getByRole('heading', { name: 'Связки', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(address);
  await expect(
    page.getByRole('heading', { name: 'Создайте первую связку', exact: true }),
  ).toBeVisible();
  return { context, page };
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
  const first = await pageFor(address);
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
