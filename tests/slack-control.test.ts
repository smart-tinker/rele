import { expect, it } from 'vitest';
import { controlModal } from '../src/server/channels/slack-control.js';

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
  const status = (modal.blocks as { type: string; text?: { text: string } }[]).find(row => row.type === 'section' && row.text?.text.includes('модель:'))!.text!.text;
  expect(status).toContain('модель: неизвестна; глубина: неизвестна.');
  expect(status).not.toMatch(/унаследована|по умолчанию/u);
});
