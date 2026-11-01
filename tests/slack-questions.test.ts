import { describe, expect, it } from 'vitest';
import type { Approval, Delivery } from '../src/shared/types.js';
import type { ApprovalResolution } from '../src/server/channels/common.js';
import { questionAnswers, questionCard, questionView, resolvedQuestion } from '../src/server/channels/slack-questions.js';

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

function form(question: Approval, mode: 'all' | 'custom' = 'all') {
  return questionView(question, { ...delivery().origin, approvalId: question.id, messageId: '1000.2000', senderIsBot: false }, mode);
}

describe('Slack question forms', () => {
  it.each([undefined, null, '', ' \n '])('accepts an ordinary choice with blank custom text %j', text => {
    const question = approval(), metadata = JSON.parse(form(question).private_metadata);
    const result = questionAnswers(question, metadata, { 'q0-choice': { answer: { selected_option: { value: '0' } } },
      'q0-text': { answer: { value: text } } });
    expect(result.errors).toEqual({});
    expect(result.answers).toEqual({ scope: ['57, 58 и 59'] });
  });

  it('rejects an ordinary choice with custom text without replacing either input', () => {
    const question = approval(), metadata = JSON.parse(form(question).private_metadata);
    const values = { 'q0-choice': { answer: { selected_option: { value: '0' } } },
      'q0-text': { answer: { value: '  уточнение 🙂\nвторая строка  ' } } };
    const before = JSON.stringify(values), result = questionAnswers(question, metadata, values);
    expect(result.errors).toEqual({ 'q0-text': 'Выбран обычный вариант. Очистите поле или выберите «Свой ответ».' });
    expect(result.answers).toEqual({});
    expect(JSON.stringify(values)).toBe(before);
    values['q0-choice'].answer.selected_option.value = 'custom';
    expect(questionAnswers(question, metadata, values)).toEqual({ answers: { scope: [values['q0-text'].answer.value] }, errors: {} });
  });

  it.each([undefined, '8'])('does not infer custom from text when choice is %j', choice => {
    const question = approval(), metadata = JSON.parse(form(question).private_metadata);
    const result = questionAnswers(question, metadata, { 'q0-choice': { answer: { selected_option: { value: choice } } },
      'q0-text': { answer: { value: 'Свой текст' } } });
    expect(result.answers).toEqual({});
    expect(result.errors).toEqual({ 'q0-choice': 'Выберите один из вариантов или свой ответ.' });
  });

  it.each(['label', 'description'] as const)('shows native %s at 75 units and retains a complete fallback at 76', field => {
    const question = approval(), option = question.questions![0].options![0];
    option[field] = 'я'.repeat(73) + '🙂';
    const native = form(question), choice = native.blocks.find((block: any) => block.block_id === 'q0-choice');
    expect(native.blocks.filter((block: any) => block.type === 'section').map((block: any) => block.text.text).join(''))
      .toBe(`${question.questions![0].header}\n${question.questions![0].question}`);
    expect(choice.element.options[0]).toEqual({ text: { type: 'plain_text', text: option.label },
      description: { type: 'plain_text', text: option.description }, value: '0' });
    option[field] += 'я';
    const fallback = form(question), fallbackChoice = fallback.blocks.find((block: any) => block.block_id === 'q0-choice');
    expect(fallback.blocks.filter((block: any) => block.type === 'section').map((block: any) => block.text.text).join(''))
      .toContain(`${option.label} — ${option.description}`);
    expect(fallbackChoice.element.options[0].description).toBeUndefined();
    expect(fallbackChoice.element.options[0].text.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    expect(questionAnswers(question, JSON.parse(fallback.private_metadata), {
      'q0-choice': { answer: { selected_option: { value: '0', text: { text: 'FORGED' } } } },
    }).answers).toEqual({ scope: [option.label] });
  });

  it('keeps mixed questions complete and uses Russian placeholders without blank descriptions', () => {
    const question = approval();
    question.questions![0].question = 'Полный исходный вопрос 🙂 '.repeat(150);
    question.questions![0].options![1].description = '';
    question.questions!.push({ id: 'second', header: 'Другой', question: 'Что проверить?', options: [
      { label: 'Длинный вариант '.repeat(10), description: 'Полное описание' },
    ] });
    const view = form(question), sections = view.blocks.filter((block: any) => block.type === 'section').map((block: any) => block.text.text).join('');
    expect(sections).toContain(question.questions![0].question);
    expect(sections).toContain(question.questions![1].options![0].label);
    expect(sections).not.toContain('Все согласованные исправления');
    expect(view.blocks.find((block: any) => block.block_id === 'q0-choice').element.options[1].description).toBeUndefined();
    expect(view.blocks.find((block: any) => block.block_id === 'q0-text').element.placeholder.text).toBe('Введите текст и выберите «Свой ответ»');
    const custom = form(approval(), 'custom');
    expect(custom.blocks.some((block: any) => block.block_id === 'q0-choice')).toBe(false);
    expect(custom.blocks.filter((block: any) => block.type === 'section').map((block: any) => block.text.text).join('')).toContain('Все согласованные исправления');
    expect(custom.blocks.find((block: any) => block.block_id === 'q0-text')).toMatchObject({ optional: false,
      element: { placeholder: { type: 'plain_text', text: 'Введите ваш ответ' } } });
  });
});

describe('resolved Slack questions', () => {
  it('shows the question meaning before a short header and keeps header as a historical fallback', () => {
    const question = approval();
    question.questions![0].header = 'RC6';
    question.questions![0].question = 'Продолжить проверку?';
    const resolution: ApprovalResolution = { source: 'slack', answers: { scope: ['Да, RC6'] } };
    expect(resolvedQuestion(delivery(), question, resolution).text).toContain('Продолжить проверку?\nОтвет: Да, RC6');
    question.questions![0].question = '';
    expect(resolvedQuestion(delivery(), question, resolution).text).toContain('RC6\nОтвет: Да, RC6');
  });

  it('shows the exact answer once in a compact record and puts original questions/options in native read-only details', () => {
    const question = approval(), input = delivery();
    const answer = '  57 и 58 и 59\n🙂 <@UPEER> @everyone  ';
    const resolution: ApprovalResolution = { source: 'slack', senderName: 'владелец', answers: { scope: [answer] } };
    const before = JSON.stringify({ question, input, resolution });
    const result = resolvedQuestion(input, question, resolution);
    expect(result.text).toContain(`Какие исправления включить в выпуск?\nОтвет: ${answer}`);
    expect(result.text).toContain('Ответил(а): владелец');
    expect(result.text).toContain('Ответ отправлен в Codex');
    expect(result.text).not.toMatch(/Codex ждёт уточнения|Выберите вариант|Устаревшая часть|Все согласованные/);
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
    expect(result.text).toContain('Какие исправления включить в выпуск?\nОтвет: 57, 58 и 59\nОтвет: С отдельной приёмкой');
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
