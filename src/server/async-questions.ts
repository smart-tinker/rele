import type { ApprovalQuestion } from '../shared/types.js';

export const ASYNC_QUESTION_METHOD = 'rele/asyncUserInput';
const OPEN = '<send_user_message_question_reply>', CLOSE = '</send_user_message_question_reply>';
const MAX_QUESTIONS = 100, MAX_TEXT = 10_000;
export interface AsyncQuestion { itemId: string; question: ApprovalQuestion }
export interface AsyncAnswer { questionItemId: string; question: string; answer: string; clientId?: string }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum = MAX_TEXT): value is string => typeof value === 'string' && !!value.trim() && value.length <= maximum;

function validQuestionId(value: unknown): value is string {
  if (!text(value, 8_192)) return false;
  try {
    const id: unknown = JSON.parse(value);
    return Array.isArray(id) && id.length === 3 && id[0] === 'request_user_input_async'
      && text(id[1], 1_024) && Number.isSafeInteger(id[2]) && id[2] >= 0 && id[2] < MAX_QUESTIONS
      && JSON.stringify(id) === value;
  } catch { return false; }
}

/** Typed native questions only: prose or a tool name alone cannot register a question. */
export function asyncQuestions(value: unknown): AsyncQuestion[] {
  if (!record(value) || value.type !== 'agentMessage' || value.delivery !== 'async' || !text(value.id, 1_024)
    || !Array.isArray(value.questions) || !value.questions.length || value.questions.length > MAX_QUESTIONS) return [];
  if (value.questions.some(question => !record(question) || !text(question.title)
    || question.options != null && (!Array.isArray(question.options) || question.options.length > MAX_QUESTIONS
      || question.options.some(option => !text(option))))) return [];
  return value.questions.map((question: { title: string; options?: string[] | null }, index) => ({
    itemId: value.id as string,
    question: { id: JSON.stringify(['request_user_input_async', value.id, index]), header: '', question: question.title,
      ...(question.options?.length ? { options: question.options.map(label => ({ label, description: '' })) } : {}) },
  }));
}

/** Parsing identifies candidates; callers must still match the stored typed question. */
export function parseAsyncAnswers(content: unknown): AsyncAnswer[] | undefined {
  if (!Array.isArray(content) || content.length !== 1 || !record(content[0]) || content[0].type !== 'text'
    || typeof content[0].text !== 'string' || content[0].text.length > 16_000_000
    || content[0].text_elements !== undefined && (!Array.isArray(content[0].text_elements) || content[0].text_elements.length)) return;
  const body = content[0].text.trim();
  if (!body.startsWith(OPEN) || !body.endsWith(CLOSE)) return;
  try {
    const rows: unknown = JSON.parse(body.slice(OPEN.length, -CLOSE.length));
    if (!Array.isArray(rows) || !rows.length || rows.length > MAX_QUESTIONS
      || rows.some(row => !record(row) || Object.keys(row).some(key => !['questionItemId', 'question', 'answer'].includes(key))
        || !validQuestionId(row.questionItemId) || !text(row.question) || !text(row.answer))
      || new Set(rows.map(row => row.questionItemId)).size !== rows.length) return;
    return rows.map(({ questionItemId, question, answer }) => ({ questionItemId, question, answer }));
  } catch { return; }
}

export function matchAsyncAnswer(answer: AsyncAnswer, question: ApprovalQuestion): boolean {
  return validQuestionId(answer.questionItemId) && answer.questionItemId === question.id && answer.question === question.question;
}

/** The Desktop consumes exactly one text envelope, without Rele's ordinary input prefix. */
export function encodeAsyncAnswers(questions: ApprovalQuestion[], answers: Record<string, string[]>): string {
  if (!questions.length || questions.length > MAX_QUESTIONS || new Set(questions.map(question => question.id)).size !== questions.length
    || !record(answers) || Object.keys(answers).length !== questions.length
    || questions.some(question => !validQuestionId(question.id) || !text(question.question)
      || !Object.hasOwn(answers, question.id) || !Array.isArray(answers[question.id]) || answers[question.id].length !== 1
      || !text(answers[question.id][0]))) throw new Error('Ответ не соответствует сохранённым вопросам Codex.');
  const rows = questions.map(question => ({ questionItemId: question.id, question: question.question, answer: answers[question.id][0] }));
  return `${OPEN}\n${JSON.stringify(rows)}\n${CLOSE}`;
}
