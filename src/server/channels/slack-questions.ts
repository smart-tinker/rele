import { createHash } from 'node:crypto';
import type { Approval, Delivery } from '../../shared/types.js';
import { splitReply, type ApprovalContext, type ApprovalResolution } from './common.js';
import { ASYNC_QUESTION_METHOD } from '../async-questions.js';

type Block = Record<string, any>;
export const QUESTION_VIEW = 'rele_questions';
export interface QuestionMetadata {
  approvalId: string; accountId: string; chatId: string; threadId: string;
  senderId: string; messageId: string; questionHash: string; mode: 'all' | 'custom';
}
const plain = (text: string) => ({ type: 'plain_text', text });
const short = (text: string, limit = 75) => {
  if (text.length <= limit) return text;
  const end = /[\uD800-\uDBFF]/u.test(text[limit - 2]) ? limit - 2 : limit - 1;
  return text.slice(0, end) + '…';
};
export const questionHash = (approval: Approval): string => createHash('sha256').update(JSON.stringify(approval.questions)).digest('hex');
export const questionSections = (text: string): Block[] => splitReply(text, 1450).map(text => ({ type: 'section', text: plain(text) }));
const questionText = (question: NonNullable<Approval['questions']>[number]) => [question.header, question.question,
  ...(question.options ?? []).map(option => `${option.label}${option.description ? ` — ${option.description}` : ''}`)].filter(Boolean).join('\n');

export function supportsQuestionForm(approval: Approval): boolean {
  const questions = approval.questions;
  return ['item/tool/requestUserInput', ASYNC_QUESTION_METHOD].includes(approval.method) && !!questions?.length
    && questions.every(question => !question.isSecret && question.id && question.question?.trim()
      && (question.options?.length ?? 0) <= 9 && question.options?.every(option => option.label?.trim()) !== false)
    && new Set(questions.map(question => question.id)).size === questions.length
    && modalBlocks(approval, false).length <= 100;
}

function modalBlocks(approval: Approval, custom: boolean): Block[] {
  return (approval.questions ?? []).flatMap((question, index) => {
    // Slack limits option text and descriptions to 75 characters; keep longer values fully readable above the controls.
    const compact = !custom && !!question.options?.length && question.options.every(option =>
      option.label.length <= 75 && (option.description?.length ?? 0) <= 75);
    return [
      ...questionSections(compact ? [question.header, question.question].filter(Boolean).join('\n') : questionText(question)),
      ...(!custom && question.options?.length ? [{ type: 'input', block_id: `q${index}-choice`, label: plain('Выберите ответ'), element: {
        type: 'radio_buttons', action_id: 'answer', options: [
          ...question.options.map((option, optionIndex) => ({ text: plain(short(option.label)), value: String(optionIndex),
            ...(compact && option.description ? { description: plain(option.description) } : {}) })),
          { text: plain('Свой ответ'), value: 'custom' },
        ],
      } }] : []),
      { type: 'input', block_id: `q${index}-text`, label: plain(!custom && question.options?.length ? 'Свой ответ (если выбран)' : 'Ваш ответ'),
        optional: !custom && !!question.options?.length,
        element: { type: 'plain_text_input', action_id: 'answer', multiline: true, max_length: 3000,
          placeholder: plain(!custom && question.options?.length ? 'Введите текст и выберите «Свой ответ»' : 'Введите ваш ответ') } },
    ];
  });
}

export function questionCard(delivery: Delivery, approval: Approval): Block[] | undefined {
  if (delivery.ordinal !== 0 || approval.status !== 'pending' || !supportsQuestionForm(approval)) return;
  const questions = approval.questions!, first = questions[0], hash = questionHash(approval);
  const button = (text: string, action: string) => ({ type: 'button', action_id: `rele_question_${action}`,
    text: plain(short(text)), value: `releq:${approval.id}:${hash}:${action}` });
  // Slack clips button labels before its 75-character API limit; full options remain readable in the form.
  const shortQuestion = questions.length === 1 && !!first.options?.length && first.options.length <= 5
    && first.options.every(option => option.label.length <= 30)
    && questionText(first).length <= 1500 && delivery.body.length <= 2900;
  const elements = shortQuestion ? [...first.options!.map((option, index) => button(option.label, String(index))), button('Свой ответ', 'custom')]
    : [button('Ответить', 'all')];
  const blocks = [...questionSections(delivery.body), { type: 'actions', elements }];
  return blocks.length <= 50 ? blocks : undefined;
}

export function questionView(approval: Approval, context: ApprovalContext, mode: 'all' | 'custom'): Block {
  if (!supportsQuestionForm(approval) || mode === 'custom' && approval.questions!.length !== 1 || !context.messageId) throw new Error('Question form unavailable');
  const metadata: QuestionMetadata = { approvalId: approval.id, accountId: context.accountId, chatId: context.chatId,
    threadId: context.threadId!, senderId: context.senderId, messageId: context.messageId, questionHash: questionHash(approval), mode };
  return { type: 'modal', callback_id: QUESTION_VIEW, title: plain('Уточнение Codex'), submit: plain('Отправить'), close: plain('Отмена'),
    private_metadata: JSON.stringify(metadata), blocks: modalBlocks(approval, mode === 'custom') };
}

export function parseQuestionMetadata(raw: unknown): QuestionMetadata | undefined {
  if (typeof raw !== 'string' || raw.length > 3000) return;
  let value: QuestionMetadata;
  try { value = JSON.parse(raw); } catch { return; }
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['approvalId', 'accountId', 'chatId', 'threadId', 'senderId', 'messageId', 'questionHash', 'mode'].includes(key))
    || !/^[a-f0-9-]{36}$/u.test(value.approvalId) || !/^[A-Z0-9]+:[UW][A-Z0-9]+$/u.test(value.accountId)
    || !/^[CDG][A-Z0-9]+$/u.test(value.chatId) || !/^\d+\.\d+$/u.test(value.threadId) || !/^\d+\.\d+$/u.test(value.messageId)
    || !/^[UW][A-Z0-9]+$/u.test(value.senderId) || !/^[a-f0-9]{64}$/u.test(value.questionHash) || !['all', 'custom'].includes(value.mode)) return;
  return value;
}

export function questionAnswers(approval: Approval, metadata: QuestionMetadata, values: Record<string, any>): { answers: Record<string, string[]>; errors: Record<string, string> } {
  const answers: Record<string, string[]> = Object.create(null), errors: Record<string, string> = {};
  for (const [index, question] of (approval.questions ?? []).entries()) {
    let answer: string | undefined;
    const choice = values?.[`q${index}-choice`]?.answer?.selected_option?.value;
    const text = values?.[`q${index}-text`]?.answer?.value;
    if (metadata.mode === 'all' && question.options?.length && choice !== 'custom') {
      if (typeof choice === 'string' && /^[0-8]$/u.test(choice)) answer = question.options[Number(choice)]?.label;
      if (!answer) errors[`q${index}-choice`] = 'Выберите один из вариантов или свой ответ.';
      else if (typeof text === 'string' && text.trim()) {
        errors[`q${index}-text`] = 'Выбран обычный вариант. Очистите поле или выберите «Свой ответ».';
        answer = undefined;
      }
    } else {
      if (typeof text === 'string' && text.trim() && text.length <= 3000) answer = text;
      else errors[`q${index}-text`] = 'Введите ответ длиной до 3000 символов.';
    }
    if (answer) answers[question.id] = [answer];
  }
  return { answers, errors };
}

// Only the typed async resolver stores native answers; serverRequest/resolved stores source alone.
function codexQuestionAnswers(approval: Approval, resolution?: ApprovalResolution): ApprovalResolution['answers'] {
  return resolution?.source === 'codex' && approval.method === ASYNC_QUESTION_METHOD
    && approval.status === 'answered' && approval.decision === 'accept' && approval.questions?.length === 1
    && !approval.questions[0].isSecret && resolution.answers?.[approval.questions[0].id]?.length === 1
    ? resolution.answers : undefined;
}

export function resolvedQuestionStatus(approval: Approval, resolution?: ApprovalResolution): string {
  return approval.decision === 'uncertain' ? 'Результат отправки ответа неизвестен. Проверьте в Codex.'
    : approval.decision === 'sending' ? 'Ответ отправляется в Codex'
    : approval.decision === 'queued' ? 'Ответ ожидает отправки в Codex'
    : resolution?.source === 'codex' ? codexQuestionAnswers(approval, resolution) ? 'Ответ подтверждён в Codex' : 'Вопрос закрыт в Codex'
      : approval.decision === 'decline' ? 'Вопрос отклонён'
      : approval.questions?.some(question => question.isSecret) ? 'Вопрос закрыт'
        : approval.status === 'expired' ? 'Вопрос больше не актуален' : 'Ответ отправлен в Codex';
}

export function resolvedQuestion(delivery: Delivery, approval: Approval, resolution?: ApprovalResolution): { text: string; blocks: Block[] } {
  const title = resolvedQuestionStatus(approval, resolution);
  if (delivery.ordinal !== 0) {
    const text = `${title}\n\nИстория вопроса — в первой части сообщения.`;
    return { text, blocks: questionSections(text) };
  }
  const uncertain = approval.decision === 'uncertain', secret = approval.questions?.some(question => question.isSecret);
  const actor = !uncertain && !secret && resolution?.source !== 'codex' ? resolution?.senderName || resolution?.senderId : undefined;
  const answers = !uncertain && !secret && approval.status !== 'expired' && approval.decision !== 'decline'
    ? resolution?.source === 'codex' ? codexQuestionAnswers(approval, resolution) : resolution?.answers : undefined;
  const questions = approval.questions ?? [];
  const summary = questions.map(question => {
    const values = answers?.[question.id];
    return [short(question.question || question.header, 120), ...(values ?? []).map(answer =>
      `${answer.length > 500 ? 'Ответ (фрагмент)' : 'Ответ'}: ${short(answer, 500)}`)].join('\n');
  }).join('\n\n');
  const actorLine = actor ? `${approval.decision === 'decline' ? 'Отклонил(а)' : 'Ответил(а)'}: ${actor}` : '';
  const source = !actor && answers && resolution ? `Источник ответа: ${resolution.source === 'slack' ? 'Slack' : resolution.source === 'telegram' ? 'Telegram' : resolution.source === 'codex' ? 'Codex' : 'Rele'}` : '';
  const history = questions.flatMap((question, index) => (answers?.[question.id] ?? []).map(answer =>
    `${question.header || `Вопрос ${index + 1}`}\nОтвет: ${answer}`)).join('\n\n');
  const details = [questions.map(questionText).join('\n\n'), title, history, actorLine || source].filter(Boolean).join('\n\n');
  const pages = splitReply(details, 6000);
  const text = [title, short(summary, 4000), actorLine || source,
    pages.length > 45 ? 'Продолжение истории доступно в Codex.' : 'Полная история — в подробностях вопроса.'].filter(Boolean).join('\n\n');
  // Keep Slack's 50-block budget even for answers larger than the question form accepts.
  const blocks = [...questionSections(text), ...pages.slice(0, 45).map((page, index) => ({
    type: 'task_card', task_id: `${approval.id}:question:${index}`,
    title: index ? `Подробнее о вопросе · часть ${index + 1}` : 'Подробнее о вопросе',
    status: ['queued', 'sending'].includes(approval.decision ?? '') ? 'in_progress' : uncertain || approval.status === 'expired' ? 'error' : 'complete',
    details: { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: splitReply(page, 1450).map(text => ({ type: 'text', text })) }] },
  }))];
  return { text, blocks };
}
