import { describe, expect, it } from 'vitest';
import { ASYNC_QUESTION_METHOD, asyncQuestions, encodeAsyncAnswers, matchAsyncAnswer, parseAsyncAnswers } from '../src/server/async-questions.js';

const item = { type: 'agentMessage', delivery: 'async', id: 'call-original', text: 'UI question', questions: [
  { title: 'Куда доставить?', options: ['Slack', 'Codex'] }, { title: 'Комментарий', options: null },
] };
const questions = asyncQuestions(item).map(ref => ref.question);
const wrap = (rows: unknown) => `<send_user_message_question_reply>\n${JSON.stringify(rows)}\n</send_user_message_question_reply>`;
const content = (text: string) => [{ type: 'text', text }];
const row = { questionItemId: questions[0].id, question: questions[0].question, answer: 'Slack' };

describe('typed async Codex questions', () => {
  it('keeps each original item/index identity and exact title/options', () => {
    expect(ASYNC_QUESTION_METHOD).toBe('rele/asyncUserInput');
    expect(asyncQuestions(item)).toEqual([
      { itemId: 'call-original', question: { id: '["request_user_input_async","call-original",0]', header: '', question: 'Куда доставить?',
        options: [{ label: 'Slack', description: '' }, { label: 'Codex', description: '' }] } },
      { itemId: 'call-original', question: { id: '["request_user_input_async","call-original",1]', header: '', question: 'Комментарий' } },
    ]);
  });

  it.each([
    { ...item, delivery: null }, { ...item, type: 'dynamicToolCall' }, { ...item, id: '' },
    { ...item, questions: 'Куда доставить?' }, { ...item, questions: [{ title: '' }] },
    { ...item, questions: [{ title: 'Title', options: [1] }] }, { ...item, questions: new Array(101).fill({ title: 'Title' }) },
    { ...item, questions: [{ title: 'x'.repeat(10_001) }] },
  ])('does not infer a question from malformed or ordinary output %#', value => {
    expect(asyncQuestions(value)).toEqual([]);
  });
});

describe('Desktop async answer envelope', () => {
  it('encodes exactly one plain envelope with the stored question identities and titles', () => {
    const text = encodeAsyncAnswers(questions, { [questions[0].id]: ['Slack'], [questions[1].id]: ['Мой ответ\nсо строкой'] });
    expect(text).toBe(wrap([row, { questionItemId: questions[1].id, question: 'Комментарий', answer: 'Мой ответ\nсо строкой' }]));
    expect(parseAsyncAnswers([{ type: 'text', text, text_elements: [] }])).toEqual([
      row, { questionItemId: questions[1].id, question: 'Комментарий', answer: 'Мой ответ\nсо строкой' },
    ]);
    expect(matchAsyncAnswer(row, questions[0])).toBe(true);
    expect(matchAsyncAnswer({ ...row, questionItemId: questions[1].id }, questions[0])).toBe(false);
    expect(matchAsyncAnswer({ ...row, question: 'Forged title' }, questions[0])).toBe(false);
  });

  it.each([
    content(`Rele input\n${wrap([row])}`), content(`${wrap([row])}\nOther text`),
    [...content(wrap([row])), { type: 'text', text: 'extra' }], [{ type: 'image', text: wrap([row]) }],
    content(wrap(row)), content(wrap([])), content(wrap([row, row])),
    content(wrap([{ ...row, questionItemId: '["request_user_input_async","call-original",-1]' }])),
    content(wrap([{ ...row, questionItemId: '["request_user_input_async", "call-original",0]' }])),
    content(wrap([{ ...row, questionItemId: '["other","call-original",0]' }])),
    content(wrap([{ ...row, questionItemId: '["request_user_input_async","call-original",100]' }])),
    content(wrap([{ ...row, answer: 1 }])), content(wrap([{ ...row, answer: ' ' }])),
    content(wrap([{ ...row, answer: 'x'.repeat(10_001) }])), content(wrap([{ ...row, extra: 'not accepted' }])),
    [{ type: 'text', text: wrap([row]), text_elements: [{ placeholder: 'changed' }] }],
    [{ type: 'text', text: wrap([row]), text_elements: null }],
  ].map(value => ({ value })))('rejects prefixes, ambiguous inputs and malformed reply IDs/types %#', ({ value }) => {
    expect(parseAsyncAnswers(value)).toBeUndefined();
  });

  it.each([
    {}, { [questions[0].id]: ['Slack', 'Codex'] }, { [questions[0].id]: [''] },
    { [questions[0].id]: ['Slack'], other: ['forged'] },
  ])('refuses to serialize answers beyond the exact saved question set %#', answers => {
    expect(() => encodeAsyncAnswers([questions[0]], answers)).toThrow('сохранённым вопросам');
  });
});
