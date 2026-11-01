import { describe, expect, it } from 'vitest';
import type { Approval, Delivery } from '../src/shared/types.js';
import type { ApprovalResolution } from '../src/server/channels/common.js';
import { questionCard, resolvedQuestion } from '../src/server/channels/slack-questions.js';

function approval(): Approval {
  return { id: 'question-id', requestId: 'request-id', turnId: 'turn-id', itemId: 'item-id', rpcId: 'rpc-id',
    method: 'item/tool/requestUserInput', title: 'Codex ждёт уточнения', details: 'Исходный запрос', status: 'answered', decision: 'accept',
    questions: [{ id: 'scope', header: 'Состав RC6', question: 'Какие исправления включить в выпуск?', options: [
      { label: '57, 58 и 59', description: 'Все согласованные исправления' }, { label: 'Только 57', description: 'Компактные вопросы' },
    ] }], createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
}

function delivery(ordinal = 0): Delivery {
  return { id: 'delivery-id', requestId: 'request-id', key: 'approval:question-id', ordinal, kind: 'approval', approvalId: 'question-id',
    origin: { platform: 'slack', accountId: 'TEXAMPLE:UBOT', chatId: 'CEXAMPLE', threadId: '1000.1000', endpointId: 'endpoint-id',
      senderId: 'UOWNER', senderName: 'владелец', messageId: '1000.1000' },
    body: 'Codex ждёт уточнения\n\nУстаревшая часть вопроса\n\nВыберите вариант или ответьте на это сообщение.',
    status: 'sent', attempts: 1, remoteMessageId: '1000.2000', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
}

function details(blocks: Record<string, any>[]): string {
  return blocks.filter(block => block.type === 'task_card').flatMap(block => block.details.elements)
    .flatMap(element => element.elements).map(element => element.text).join('');
}

describe('resolved Slack questions', () => {
  it('shows the exact answer once in a compact record and puts original questions/options in native read-only details', () => {
    const question = approval(), input = delivery();
    const answer = '  57 и 58 и 59\n🙂 <@UPEER> @everyone  ';
    const resolution: ApprovalResolution = { source: 'slack', senderName: 'владелец', answers: { scope: [answer] } };
    const before = JSON.stringify({ question, input, resolution });
    const result = resolvedQuestion(input, question, resolution);
    expect(result.text).toContain(`Состав RC6\nОтвет: ${answer}`);
    expect(result.text).toContain('Ответил(а): владелец');
    expect(result.text).toContain('Ответ отправлен в Codex');
    expect(result.text).not.toMatch(/Codex ждёт уточнения|Выберите вариант|Устаревшая часть|Какие исправления|Все согласованные/);
    expect(result.text.split(answer)).toHaveLength(2);
    const history = details(result.blocks);
    expect(history).toContain(question.questions![0].question);
    for (const option of question.questions![0].options!) expect(history).toContain(`${option.label} — ${option.description}`);
    expect(history).toContain(`Ответ: ${answer}`);
    expect(result.blocks.find(block => block.type === 'task_card')).toMatchObject({
      title: 'Подробнее о вопросе', status: 'complete', details: { type: 'rich_text' },
    });
    expect(JSON.stringify(result.blocks)).not.toMatch(/"(?:actions|input|button|submit|action_id|callback_id)"/);
    expect(JSON.stringify({ question, input, resolution })).toBe(before);
  });

  it('keeps several question IDs and answers separate, with a bounded original fragment when no header exists', () => {
    const question = approval();
    question.questions!.push({ id: 'timing', header: '', question: 'Когда начинать? '.repeat(20) });
    const result = resolvedQuestion(delivery(), question, { source: 'telegram', senderId: '88995359', answers: {
      scope: ['57, 58 и 59', 'С отдельной приёмкой'], timing: ['После проверки 🙂'], unknown: ['НЕСВЯЗАННЫЙ ОТВЕТ'],
    } });
    expect(result.text).toContain('Состав RC6\nОтвет: 57, 58 и 59\nОтвет: С отдельной приёмкой');
    expect(result.text).toContain('Когда начинать?');
    expect(result.text).toContain('…\nОтвет: После проверки 🙂');
    expect(result.text).toContain('Ответил(а): 88995359');
    expect(details(result.blocks)).toContain(question.questions![1].question);
    expect(details(result.blocks)).toContain('Вопрос 2\nОтвет: После проверки 🙂');
    expect(JSON.stringify(result)).not.toContain('НЕСВЯЗАННЫЙ ОТВЕТ');
  });

  it.each([
    ['queued', 'Ответ ожидает отправки в Codex', 'in_progress'],
    ['sending', 'Ответ отправляется в Codex', 'in_progress'],
    ['uncertain', 'Результат отправки ответа неизвестен. Проверьте в Codex.', 'error'],
  ])('does not confirm a %s answer', (decision, title, status) => {
    const result = resolvedQuestion(delivery(), { ...approval(), decision }, {
      source: 'slack', senderName: 'владелец', answers: { scope: ['НЕПОДТВЕРЖДЁННЫЙ ОТВЕТ'] },
    });
    expect(result.text).toContain(title);
    expect(JSON.stringify(result)).not.toMatch(/Ответ отправлен в Codex|принят/);
    expect(result.blocks.find(block => block.type === 'task_card')?.status).toBe(status);
    if (decision === 'uncertain') expect(JSON.stringify(result)).not.toMatch(/НЕПОДТВЕРЖДЁННЫЙ ОТВЕТ|владелец/);
    else expect(result.text).toContain('НЕПОДТВЕРЖДЁННЫЙ ОТВЕТ');
  });

  it('shows only generic native closure even when unproved answer fields are present', () => {
    const result = resolvedQuestion(delivery(), approval(), {
      source: 'codex', senderName: 'НЕПОДТВЕРЖДЁННЫЙ АВТОР', answers: { scope: ['НЕПОДТВЕРЖДЁННЫЙ ОТВЕТ'] },
    });
    expect(result.text).toContain('Вопрос закрыт в Codex');
    expect(JSON.stringify(result)).not.toMatch(/НЕПОДТВЕРЖДЁННЫЙ|Ответ отправлен в Codex/);
    expect(details(result.blocks)).toContain('Какие исправления включить в выпуск?');
  });

  it('shows the exact proven typed async answer from Codex without inventing an actor', () => {
    const question = { ...approval(), method: 'rele/asyncUserInput', rpcId: null };
    const id = JSON.stringify(['request_user_input_async', 'native-question-item', 0]);
    question.questions![0].id = id;
    const answer = '  57 и 58 и 59\nПосле проверки 🙂  ';
    const result = resolvedQuestion(delivery(), question, {
      source: 'codex', senderName: 'НЕПОДТВЕРЖДЁННЫЙ АВТОР', answers: { [id]: [answer], other: ['ЧУЖОЙ ОТВЕТ'] },
    });
    expect(result.text).toContain('Ответ подтверждён в Codex');
    expect(result.text).toContain(`Ответ: ${answer}`);
    expect(result.text).toContain('Источник ответа: Codex');
    expect(details(result.blocks)).toContain(answer);
    expect(JSON.stringify(result)).not.toMatch(/НЕПОДТВЕРЖДЁННЫЙ АВТОР|ЧУЖОЙ ОТВЕТ|Ответил\(а\)/);
  });

  it.each(['no-answer', 'other-id', 'secret', 'uncertain', 'expired', 'queued'])('keeps typed async native %s closure conservative', state => {
    const question = { ...approval(), method: 'rele/asyncUserInput', rpcId: null };
    const resolution: ApprovalResolution = { source: 'codex', senderId: 'UNPROVEN', answers: { scope: ['NATIVE ANSWER'] } };
    if (state === 'no-answer') delete resolution.answers;
    if (state === 'other-id') resolution.answers = { other: ['NATIVE ANSWER'] };
    if (state === 'secret') question.questions![0].isSecret = true;
    if (state === 'uncertain' || state === 'queued') question.decision = state;
    if (state === 'expired') question.status = 'expired';
    const result = resolvedQuestion(delivery(), question, resolution);
    expect(JSON.stringify(result)).not.toMatch(/NATIVE ANSWER|UNPROVEN|Ответ подтверждён в Codex/);
    if (!['uncertain', 'queued'].includes(state)) expect(result.text).toContain('Вопрос закрыт в Codex');
  });

  it.each(['decline', 'secret', 'expired'])('keeps %s answers out of every payload field', state => {
    const question = approval();
    if (state === 'secret') question.questions![0].isSecret = true;
    if (state === 'decline') question.decision = 'decline';
    if (state === 'expired') { question.status = 'expired'; question.decision = undefined; }
    const result = resolvedQuestion(delivery(), question, { source: 'rele', answers: { scope: ['SECRET ANSWER MUST STAY LOCAL'] } });
    expect(JSON.stringify(result)).not.toContain('SECRET ANSWER MUST STAY LOCAL');
    expect(result.text).toContain(state === 'decline' ? 'Вопрос отклонён' : state === 'expired' ? 'Вопрос больше не актуален' : 'Вопрос закрыт');
  });

  it('names the known response source without inventing an actor', () => {
    const result = resolvedQuestion(delivery(), approval(), { source: 'telegram', answers: { scope: ['57, 58 и 59'] } });
    expect(result.text).toContain('Источник ответа: Telegram');
    expect(result.text).not.toContain('Ответил(а)');
  });

  it('preserves long Unicode questions, options and exact answers inside bounded read-only cards', () => {
    const question = approval(), answer = '🙂 Абзац\n'.repeat(900);
    question.questions![0].question = `Начало вопроса ${'🙂'.repeat(3500)} Конец вопроса`;
    question.questions![0].options![0].description = `Начало варианта ${'🧪'.repeat(5000)} Конец варианта`;
    const result = resolvedQuestion(delivery(), question, { source: 'slack', answers: { scope: [answer] } });
    expect(result.text).toContain('Ответ (фрагмент):');
    expect(result.text.length).toBeLessThan(4500);
    const history = details(result.blocks);
    expect(history).toContain(question.questions![0].question);
    expect(history).toContain(question.questions![0].options![0].description);
    expect(history).toContain(answer);
    expect(result.blocks.length).toBeLessThanOrEqual(50);
    for (const block of result.blocks) {
      if (block.type === 'section') {
        expect(block.text.type).toBe('plain_text');
        expect(block.text.text.length).toBeLessThanOrEqual(2900);
      } else {
        const textNodes = block.details.elements.flatMap((element: any) => element.elements);
        expect([...textNodes.map((element: any) => element.text).join('')].length).toBeLessThanOrEqual(6000);
        for (const node of textNodes) {
          expect(node.type).toBe('text');
          expect(node.text.length).toBeLessThanOrEqual(2900);
          expect(node.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
        }
      }
    }
  });

  it('removes stale prompts from every multipart message without repeating all questions or answers', () => {
    const question = approval();
    question.questions![0].question = 'Полный исходный вопрос 🙂 '.repeat(600);
    const resolution: ApprovalResolution = { source: 'slack', senderName: 'владелец', answers: { scope: ['57 и 58 и 59'] } };
    const main = resolvedQuestion(delivery(), question, resolution);
    expect(details(main.blocks)).toContain(question.questions![0].question);
    for (const ordinal of [1, 2, 17]) {
      const result = resolvedQuestion(delivery(ordinal), question, resolution);
      expect(result.text).toContain('Ответ отправлен в Codex');
      expect(result.text).toContain('История вопроса — в первой части сообщения.');
      expect(JSON.stringify(result)).not.toMatch(/Codex ждёт уточнения|Выберите вариант|Устаревшая часть|Полный исходный|57 и 58 и 59|"actions"|"input"/);
    }
  });

  it('bounds oversized historical records honestly and leaves their stored exact values intact', () => {
    const question = approval(), answer = 'Длинный точный ответ 🙂 '.repeat(20_000);
    const resolution: ApprovalResolution = { source: 'slack', answers: { scope: [answer] } };
    const result = resolvedQuestion(delivery(), question, resolution);
    expect(result.blocks.length).toBeLessThanOrEqual(50);
    expect(result.text).toContain('Продолжение истории доступно в Codex.');
    expect(resolution.answers!.scope).toEqual([answer]);
  });

  it('keeps pending async question controls available', () => {
    const question = { ...approval(), method: 'rele/asyncUserInput', rpcId: null, status: 'pending' as const, decision: undefined };
    expect(questionCard(delivery(), question)?.at(-1)?.type).toBe('actions');
  });
});
