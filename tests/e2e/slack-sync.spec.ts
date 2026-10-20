import { expect, test, type Page } from '@playwright/test';
import type { SlackSyncEntryState, SlackSyncJournal } from '../../src/shared/types';
import { fixtureState, installApi, openPanel, panelToken } from './fixtures';

function entry(index: number, state: SlackSyncEntryState = 'applied'): SlackSyncJournal['entries'][number] {
  return {
    id: `entry-${index}`, state, createdAt: '2026-10-20T06:00:00Z',
    message: {
      endpointId: 'sl-alpha', accountId: 'slack-test-account', chatId: 'CALPHA', threadId: '1792400000.0',
      messageId: String(1792400000 + index), sender: { id: index ? 'UHUMAN' : 'BOTHER', name: index ? 'Анна (пример)' : 'Другой агент', isBot: !index },
      text: `Пример сообщения ${index + 1}`, kind: 'message',
      payload: { type: 'message', text: `Пример сообщения ${index + 1}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Полное поле Block Kit' } }] },
    },
  };
}

function stream(extra: Partial<SlackSyncJournal['streams'][number]> = {}): SlackSyncJournal['streams'][number] {
  return {
    id: 'stream-active', endpointId: 'sl-alpha', title: '#alpha-dev · Обсуждение API', active: true, paused: false, state: 'ready',
    counts: { pending: 0, applying: 0, applied: 1, uncertain: 0 }, ...extra,
  };
}

async function openJournal(page: Page) {
  await openPanel(page);
  await page.getByRole('button', { name: 'Открыть связку Пример: проект Альфа' }).click();
  return page.getByRole('region', { name: 'Журнал контекста Slack' });
}

const journalRoute = /\/api\/conversations\/[^/]+\/slack-sync(?:\?|$)/;

test('shows source backfill, pending/applied/uncertain bot context and full payload without claiming full synchronization', async ({ page }) => {
  const api = await installApi(page);
  const entries = [entry(0, 'pending'), entry(1), entry(2), entry(3, 'uncertain')];
  entries[0].message.text = '<img src=x onerror="window.journalUnsafe=true">';
  entries[3].error = 'Подтверждение записи ещё не получено';
  const data: SlackSyncJournal = {
    streamId: 'stream-active', entries,
    streams: [stream({ state: 'backfill', counts: { pending: 1, applying: 0, applied: 2, uncertain: 1 } })],
  };
  const reads: string[] = [];
  await page.route(journalRoute, async route => {
    expect(route.request().method()).toBe('GET');
    expect(route.request().headers().authorization).toBe(`Bearer ${panelToken}`);
    reads.push(route.request().url());
    await route.fulfill({ json: data });
  });
  const journal = await openJournal(page);
  await expect(journal.getByText('Загружается история треда.', { exact: true })).toBeVisible();
  await expect(journal).toContainText('Получено: 4 · В контексте Codex: 2 · Ожидают: 2');
  await expect(journal.getByText('Другой агент · Бот', { exact: true })).toBeVisible();
  await expect(journal).toContainText('Передача не подтверждена');
  await expect(journal).toContainText('Подтверждение записи ещё не получено');
  await expect(journal.getByText('Полученные сообщения переданы в контекст Codex.', { exact: true })).toHaveCount(0);
  await expect(journal.getByRole('article').first()).toContainText('<img src=x');
  await expect(journal.locator('img')).toHaveCount(0);
  await journal.getByRole('article').first().getByText('Данные Slack (JSON)', { exact: true }).click();
  await expect(journal.getByRole('article').first().locator('pre')).toContainText('Полное поле Block Kit');
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).journalUnsafe)).toBeUndefined();
  const query = new URL(reads[0]).searchParams;
  expect(query.get('offset')).toBe('0');
  expect(query.get('limit')).toBe('50');
  expect(api.mutations).toEqual([]);
});

test('paginates source messages and opens blocked detached streams using escaped identifiers and GET only', async ({ page }) => {
  const state = fixtureState();
  const conversationId = 'conversation/with ?#&';
  state.conversations[0].id = conversationId;
  const api = await installApi(page, state);
  const oldStreamId = 'stream/old ?#&';
  const streams = [stream({ counts: { pending: 0, applying: 0, applied: 51, uncertain: 0 } }), stream({ id: oldStreamId, title: '#old · Старый тред', active: false, state: 'blocked', error: 'Нет доступа к старому треду', counts: { pending: 1, applying: 0, applied: 0, uncertain: 0 } })];
  const entries = Array.from({ length: 51 }, (_, index) => entry(index));
  const reads: Array<{ method: string; url: URL }> = [];
  await page.route(journalRoute, async route => {
    const url = new URL(route.request().url());
    reads.push({ method: route.request().method(), url });
    const selected = url.searchParams.get('streamId') || 'stream-active';
    const offset = Number(url.searchParams.get('offset'));
    const data: SlackSyncJournal = selected === oldStreamId
      ? { streams, streamId: selected, entries: [entry(99, 'pending')] }
      : { streams, streamId: selected, entries: entries.slice(offset, offset + 50), nextOffset: offset === 0 ? 50 : undefined };
    await route.fulfill({ json: data });
  });
  const journal = await openJournal(page);
  await expect(journal.getByRole('article')).toHaveCount(50);
  await journal.getByRole('button', { name: 'Показать ещё', exact: true }).click();
  await expect(journal.getByRole('article')).toHaveCount(51);
  await expect(journal).toContainText('Пример сообщения 51');
  await expect(journal.getByRole('button', { name: 'Показать ещё', exact: true })).toHaveCount(0);
  expect(reads.some(read => read.url.searchParams.get('offset') === '50')).toBe(true);
  await journal.getByLabel('Источник журнала Slack').selectOption(oldStreamId);
  await expect(journal.getByRole('article')).toHaveCount(1);
  await expect(journal).toContainText('Синхронизация заблокирована.');
  await expect(journal).toContainText('Нет доступа к старому треду');
  await expect(journal).toContainText('Источник отвязан');
  await expect(journal.getByText('Полученные сообщения переданы в контекст Codex.', { exact: true })).toHaveCount(0);
  expect(reads.every(read => read.method === 'GET' && read.url.pathname === `/api/conversations/${encodeURIComponent(conversationId)}/slack-sync`)).toBe(true);
  expect(reads.at(-1)?.url.searchParams.get('streamId')).toBe(oldStreamId);
  expect(api.mutations).toEqual([]);
});

test('polls pending entries to applied and stops journal polling when its dialog closes', async ({ page }) => {
  await page.clock.install();
  const api = await installApi(page);
  let applied = false;
  let reads = 0;
  await page.route(journalRoute, async route => {
    reads++;
    await route.fulfill({ json: {
      streamId: 'stream-active', streams: [stream({ counts: { pending: applied ? 0 : 1, applying: 0, applied: applied ? 1 : 0, uncertain: 0 } })],
      entries: [entry(0, applied ? 'applied' : 'pending')],
    } satisfies SlackSyncJournal });
  });
  const journal = await openJournal(page);
  await expect(journal).toContainText('Контекст ожидает передачи в Codex.');
  await expect(journal.getByText('Полученные сообщения переданы в контекст Codex.', { exact: true })).toHaveCount(0);
  applied = true;
  await page.clock.fastForward(5000);
  await expect(journal).toContainText('Полученные сообщения переданы в контекст Codex.');
  await expect(journal).toContainText('Получено: 1 · В контексте Codex: 1 · Ожидают: 0');
  expect(reads).toBeGreaterThan(1);
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
  const atClose = reads;
  await page.clock.fastForward(10_000);
  expect(reads).toBe(atClose);
  expect(api.mutations).toEqual([]);
});

test('shows read errors, refreshes explicitly and keeps block-only payloads bounded on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installApi(page);
  let failed = true;
  const blockOnly = entry(0);
  blockOnly.message.text = '';
  blockOnly.message.payload = { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Длинное поле '.repeat(500) } }], extra: { received: true } };
  await page.route(journalRoute, async route => {
    if (failed) await route.fulfill({ status: 503, json: { error: 'Журнал временно недоступен' } });
    else await route.fulfill({ json: { streamId: 'stream-active', streams: [stream()], entries: [blockOnly] } satisfies SlackSyncJournal });
  });
  const journal = await openJournal(page);
  await expect(journal.getByRole('alert')).toContainText('Журнал временно недоступен');
  failed = false;
  await journal.getByRole('button', { name: 'Обновить журнал Slack' }).click();
  await expect(journal.getByRole('alert')).toHaveCount(0);
  await expect(journal).toContainText('Сообщение без текстового поля. Полные данные Slack доступны ниже.');
  await journal.getByText('Данные Slack (JSON)', { exact: true }).click();
  const raw = journal.locator('pre');
  await expect(raw).toContainText('"received": true');
  expect(await raw.evaluate(element => element.getBoundingClientRect().height <= 260)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await raw.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(api.mutations).toEqual([]);
});

test('keeps empty journals out of existing conversation forms', async ({ page }) => {
  const api = await installApi(page);
  await openPanel(page);
  await page.getByRole('button', { name: 'Открыть связку Пример: проект Альфа' }).click();
  await expect.poll(() => api.reads.some(path => path.startsWith('/api/conversations/conversation-0/slack-sync?'))).toBe(true);
  await expect(page.getByRole('heading', { name: 'Журнал контекста Slack' })).toHaveCount(0);
  expect(api.mutations).toEqual([]);
});

test('keeps other bots selectable for explicit mention-based launches while all messages remain context', async ({ page }) => {
  const api = await installApi(page, fixtureState(), {
    people: { 'sl-alpha': [{ items: [{ id: 'BOTOTHER', name: 'Другой агент', isBot: true }] }] },
  });
  await openPanel(page);
  await page.getByRole('button', { name: 'Открыть связку Пример: проект Альфа' }).click();
  const slack = page.getByRole('dialog').locator('form').filter({ has: page.getByRole('heading', { name: 'Slack', exact: true }) });
  await expect(slack).toContainText('Все сообщения обсуждения, включая ботов, передаются как контекст.');
  await expect(slack).toContainText('Отмеченный бот запускает запрос только по новому упоминанию Rele.');
  const bot = slack.getByRole('checkbox', { name: 'Другой агент · бот, запуск по @Rele' });
  await expect(bot).toBeEnabled();
  await expect(bot).not.toBeChecked();
  await bot.check();
  expect(api.mutations).toEqual([]);
  await slack.getByRole('button', { name: 'Сохранить Slack', exact: true }).click();
  await expect(slack).toContainText('Slack подключён. Доступ сохранён.');
  expect(api.mutations).toEqual([{
    method: 'PUT', path: '/api/conversations/conversation-0/bindings/slack',
    body: { endpointId: 'sl-alpha', allowedSenderIds: ['person-anna', 'BOTOTHER'] },
  }]);
});

test('shows captured detached context without claiming its unfinished history scan is still running', async ({ page }) => {
  const api = await installApi(page);
  const reads: string[] = [];
  await page.route(journalRoute, async route => {
    expect(route.request().method()).toBe('GET');
    reads.push(route.request().url());
    await route.fulfill({ json: {
      streamId: 'stream-active',
      streams: [stream({ active: false, state: 'backfill', error: 'История не была загружена полностью до отвязки.', counts: { pending: 1, applying: 0, applied: 1, uncertain: 0 } })],
      entries: [entry(0, 'pending'), entry(1)],
    } satisfies SlackSyncJournal });
  });
  const journal = await openJournal(page);
  await expect(journal).toContainText('Полученные сообщения отвязанного источника ожидают передачи в Codex.');
  await expect(journal.getByText('Загружается история треда.', { exact: true })).toHaveCount(0);
  await expect(journal).toContainText('Источник отвязан');
  await expect(journal).toContainText('Получено: 2 · В контексте Codex: 1 · Ожидают: 1');
  await expect(journal).toContainText('История не была загружена полностью до отвязки.');
  expect(reads.length).toBeGreaterThan(0);
  expect(api.mutations).toEqual([]);
});
