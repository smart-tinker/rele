import { expect, it } from 'vitest';
import { controlModal } from '../src/server/channels/slack-control.js';

const context = { accountId: 'TTEST:UBOT', chatId: 'CTEST', threadId: '1000.1', messageId: '1000.2', senderId: 'UALICE', senderName: 'Alice', senderIsBot: false };
const goalWriteUnavailable = 'Безопасное изменение native-цели из Slack недоступно: поддерживаемые версии Codex не связывают запись цели с состоянием, показанным в Slack. Создание делает upsert, остановка меняет текущую цель; при гонке запись может заменить или приостановить другую цель.';

it('keeps a long native Goal fully visible without splitting emoji inside a Slack section', () => {
  const objective = '🙂'.repeat(1500) + ' important completion criterion';
  const modal = controlModal({ id: '12345678-1234-1234-1234-123456789abc', sourceTitle: 'Synthetic thread', conversationTitle: 'Synthetic Codex', nativeThreadId: 'native',
    action: 'goal', connected: true, ownQueued: 0, ownRunning: 0, boundSources: 1, snapshot: { model: null, effort: null, runtimeStatus: 'idle', queued: 0, goalSupported: true,
      goal: { threadId: 'native', objective, status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } } },
  { accountId: 'TTEST:UBOT', chatId: 'CTEST', threadId: '1000.1', messageId: '1000.2', senderId: 'UALICE', senderName: 'Alice', senderIsBot: false });
  const sections = (modal.blocks as { type: string; text?: { text: string } }[]).filter(row => row.type === 'section').map(row => row.text!.text);
  expect(sections.join('')).toContain(objective);
  expect(sections.every(text => text.length <= 2900 && !/[\uD800-\uDBFF]$/u.test(text))).toBe(true);
});

it.each(['notLoaded', 'idle'])('reports missing model and effort as unknown when runtime is %s', runtimeStatus => {
  const modal = controlModal({ id: '12345678-1234-1234-1234-123456789abc', sourceTitle: 'Synthetic thread', conversationTitle: 'Synthetic Codex', nativeThreadId: 'native',
    action: 'status', connected: true, ownQueued: 0, ownRunning: 0, boundSources: 1,
    snapshot: { model: null, effort: null, runtimeStatus, queued: 0, goalSupported: false, goal: null } },
  { accountId: 'TTEST:UBOT', chatId: 'CTEST', threadId: '1000.1', messageId: '1000.2', senderId: 'UALICE', senderName: 'Alice', senderIsBot: false });
  const status = (modal.blocks as { type: string; text?: { text: string } }[]).find(row => row.type === 'section' && row.text?.text.toLowerCase().includes('модель:'))!.text!.text;
  expect(status).toContain('Модель: неизвестна; глубина: неизвестна.');
  expect(status).not.toMatch(/унаследована|по умолчанию/u);
});

it('does not call a non-null thread/read model configured when its origin is unknown', () => {
  const modal = controlModal({ id: '12345678-1234-1234-1234-123456789abc', sourceTitle: 'Synthetic thread', conversationTitle: 'Synthetic Codex', nativeThreadId: 'native',
    action: 'status', connected: true, ownQueued: 0, ownRunning: 0, boundSources: 1,
    snapshot: { model: 'fixture-model', effort: 'high', runtimeStatus: 'idle', queued: 0, goalSupported: false, goal: null } },
  { accountId: 'TTEST:UBOT', chatId: 'CTEST', threadId: '1000.1', messageId: '1000.2', senderId: 'UALICE', senderName: 'Alice', senderIsBot: false });
  const status = (modal.blocks as { type: string; text?: { text: string } }[]).find(row => row.type === 'section' && row.text?.text.toLowerCase().includes('модель:'))!.text!.text;
  expect(status).toContain('Модель: fixture-model; глубина: high. Происхождение значений не подтверждено.');
  expect(status).not.toMatch(/Настроенная|Сохранённая|Унаследованная|по умолчанию/u);
});

const goal = { threadId: 'native', objective: 'Goal from the current snapshot', status: 'active' as 'active' | 'complete', tokenBudget: null,
    tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
const modal = (action: 'goal' | 'stop', currentGoal: typeof goal | null) => controlModal({
    id: '12345678-1234-1234-1234-123456789abc', sourceTitle: 'Synthetic thread', conversationTitle: 'Synthetic Codex', nativeThreadId: 'native',
    action, connected: true, ownQueued: 0, ownRunning: 0, boundSources: 1, goalWriteUnavailable,
    snapshot: { model: 'fixture-model', effort: 'high', runtimeStatus: 'idle', queued: 0, goalSupported: true, goal: currentGoal },
  } as Parameters<typeof controlModal>[0], context);

it('disables unsafe Slack Goal creation and explains the missing native binding', () => {
  const create = modal('goal', null);
  expect(create).not.toHaveProperty('submit');
  expect((create.blocks as { type: string; block_id?: string }[]).filter(block => block.type === 'input').map(block => block.block_id)).toEqual(['operation']);
  expect(JSON.stringify(create)).toContain(goalWriteUnavailable);

  const completed = modal('goal', { ...goal, status: 'complete' });
  expect(completed).not.toHaveProperty('submit');
  expect(JSON.stringify(completed)).toContain(goal.objective);
});

it('keeps Goal reads visible and disables unsafe Slack pause', () => {
  const view = modal('stop', goal);
  expect(view).not.toHaveProperty('submit');
  expect(JSON.stringify(view)).toContain(goal.objective);
  expect(JSON.stringify(view)).toContain(goalWriteUnavailable);
});
