import { expect, test } from '@playwright/test';
import { fixtureRequest, fixtureState, installApi, openPanel } from './fixtures';

test('request and delivery open the same safe origin-specific trace; failed refresh keeps a labelled snapshot', async ({ page }) => {
  const state = fixtureState();
  const request = { ...fixtureRequest('trace-telegram', 'completed'), conversationId: 'conversation-0' };
  const other = { ...request, id: 'trace-slack', origin: { ...request.origin, platform: 'slack' as const, endpointId: 'sl-alpha', accountId: 'slack-test-account', chatId: 'other-chat' } };
  state.requests = [request, other];
  state.deliveries = [{ id: 'trace-delivery', requestId: request.id, origin: request.origin, key: 'final', ordinal: 0, kind: 'answer', body: 'private answer excluded from trace', status: 'uncertain', attempts: 1, createdAt: request.createdAt, updatedAt: request.updatedAt }];
  const api = await installApi(page, state);
  let fail = false; const reads: string[] = [];
  await page.route('**/api/traces/**', async route => {
    reads.push(new URL(route.request().url()).pathname);
    if (fail) { await route.fulfill({ status: 503, json: { error: 'Trace offline' } }); return; }
    await route.fulfill({ json: {
      source: { platform: 'telegram', accountId: request.origin.accountId, endpointId: request.origin.endpointId, chatId: request.origin.chatId, threadId: request.origin.threadId, messageId: request.origin.messageId },
      requestId: request.id, eventId: request.eventId, nativeThreadId: 'thread-alpha', capturedAt: new Date().toISOString(), startedAt: new Date().toISOString(), provenance: 'saved',
      connected: { codex: false, source: true }, warnings: ['Codex отключён; показаны сохранённые данные.'],
      latest: { stage: 'delivery', status: 'uncertain', at: request.updatedAt },
      steps: [
        { stage: 'ingress', status: 'recorded', detail: 'Есть сохранённый запрос.', at: request.createdAt },
        { stage: 'admission', status: 'recorded', detail: 'Запрос создан; детали решения фильтра не сохранялись.' },
        { stage: 'native', status: 'accepted', detail: 'Есть turnId.' },
        { stage: 'execution', status: 'completed', detail: 'Сохранено завершение.' },
        { stage: 'delivery', status: 'uncertain', detail: 'Исход отправки неизвестен.', at: request.updatedAt },
      ],
      deliveries: [{ id: 'trace-delivery', kind: 'answer', status: 'uncertain', at: request.updatedAt, receipt: false }],
      nextAction: 'Проверьте исходный чат; не повторяйте отправку до подтверждения результата.',
    } });
  });
  await openPanel(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Очередь', exact: true }).click();
  await page.getByRole('button', { name: 'Все запросы', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: request.text }).filter({ hasText: 'Поддержка' });
  await row.getByRole('link', { name: 'Трасса', exact: true }).click();
  const card = page.getByRole('dialog', { name: 'Трасса сообщения' });
  await expect(card).toContainText('trace-telegram'); await expect(card).toContainText('tg-support');
  await expect(card).not.toContainText('trace-slack'); await expect(card).not.toContainText(request.text);
  await expect(card).toContainText('Доставка не подтверждена');
  await expect(card).toContainText('до запуска Rele');
  await expect(card).toContainText('Codex отключён');
  await expect(card.getByRole('button', { name: /Отправить|Повторить|Сверить|Продолжить|Отменить/u })).toHaveCount(0);
  await card.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Доставка', exact: true }).click();
  await page.getByRole('row').filter({ hasText: 'private answer excluded from trace' }).getByRole('link', { name: 'Трасса', exact: true }).click();
  await expect(card).toContainText('trace-telegram'); await expect(card).not.toContainText('trace-slack');
  await expect(card).not.toContainText('private answer excluded from trace');
  expect(reads).toEqual(['/api/traces/requests/trace-telegram', '/api/traces/deliveries/trace-delivery']);
  fail = true; await card.getByRole('button', { name: 'Обновить снимок', exact: true }).click();
  await expect(card).toContainText('Снимок устарел'); await expect(card).toContainText('trace-telegram');
  expect(api.mutations).toEqual([]);
  await page.screenshot({ path: process.env.RELE_TRACE_SCREENSHOT || 'test-results/message-trace.png', fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});
