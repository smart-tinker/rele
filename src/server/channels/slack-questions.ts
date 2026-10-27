import { createHash } from 'node:crypto';
import type { Approval, Delivery } from '../../shared/types.js';
import { splitReply, type ApprovalContext, type ApprovalResolution } from './common.js';

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
  return approval.method === 'item/tool/requestUserInput' && !!questions?.length
    && questions.every(question => !question.isSecret && question.id && question.question?.trim()
      && (question.options?.length ?? 0) <= 9 && question.options?.every(option => option.label?.trim()) !== false)
    && new Set(questions.map(question => question.id)).size === questions.length
    && modalBlocks(approval, false).length <= 100;
}

function modalBlocks(approval: Approval, custom: boolean): Block[] {
  return (approval.questions ?? []).flatMap((question, index) => [
    ...questionSections(questionText(question)),
    ...(!custom && question.options?.length ? [{ type: 'input', block_id: `q${index}-choice`, label: plain('Выберите ответ'), element: {
      type: 'radio_buttons', action_id: 'answer', options: [
        ...question.options.map((option, optionIndex) => ({ text: plain(short(option.label)), value: String(optionIndex) })),
        { text: plain('Свой ответ'), value: 'custom' },
      ],
    } }] : []),
    { type: 'input', block_id: `q${index}-text`, label: plain(!custom && question.options?.length ? 'Свой ответ (если выбран)' : 'Ваш ответ'),
      optional: !custom && !!question.options?.length,
      element: { type: 'plain_text_input', action_id: 'answer', multiline: true, max_length: 3000 } },
  ]);
}

export function questionCard(delivery: Delivery, approval: Approval): Block[] | undefined {
  if (delivery.ordinal !== 0 || approval.status !== 'pending' || !supportsQuestionForm(approval)) return;
  const questions = approval.questions!, first = questions[0], hash = questionHash(approval);
  const button = (text: string, action: string) => ({ type: 'button', action_id: `rele_question_${action}`,
    text: plain(short(text)), value: `releq:${approval.id}:${hash}:${action}` });
  const shortQuestion = questions.length === 1 && !!first.options?.length && first.options.length <= 5
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
    if (metadata.mode === 'all' && question.options?.length && choice !== 'custom') {
      if (typeof choice === 'string' && /^[0-8]$/u.test(choice)) answer = question.options[Number(choice)]?.label;
      if (!answer) errors[`q${index}-choice`] = 'Выберите один из вариантов или свой ответ.';
    } else {
      const text = values?.[`q${index}-text`]?.answer?.value;
      if (typeof text === 'string' && text.trim() && text.length <= 3000) answer = text;
      else errors[`q${index}-text`] = 'Введите ответ длиной до 3000 символов.';
    }
    if (answer) answers[question.id] = [answer];
  }
  return { answers, errors };
}

export function resolvedQuestion(delivery: Delivery, approval: Approval, resolution?: ApprovalResolution): { text: string; blocks: Block[] } {
  const sections = questionSections(delivery.body);
  if (delivery.ordinal !== 0) return { text: delivery.body, blocks: sections };
  const uncertain = approval.decision === 'uncertain', secret = approval.questions?.some(question => question.isSecret);
  const title = uncertain ? 'Результат отправки ответа неизвестен. Проверьте в Codex.'
    : resolution?.source === 'codex' ? 'Вопрос закрыт в Codex' : approval.decision === 'decline' ? 'Вопрос отклонён'
      : secret ? 'Вопрос закрыт' : approval.status === 'expired' ? 'Вопрос больше не актуален' : 'Ответ отправлен в Codex';
  const actor = !uncertain && !secret && resolution?.source !== 'codex' ? resolution?.senderName || resolution?.senderId : undefined;
  const details = !uncertain && !secret && approval.decision !== 'decline' && resolution?.source !== 'codex' && resolution?.answers ? (approval.questions ?? []).flatMap(question =>
    resolution.answers![question.id]?.map(answer => `${question.header || question.question}: ${answer}`) ?? []).join('\n') : '';
  const actorLine = actor ? `${approval.decision === 'decline' ? 'Отклонил(а)' : 'Ответил(а)'}: ${actor}` : '';
  let footer = [title, actorLine, details].filter(Boolean).join('\n');
  if (sections.length + questionSections(footer).length > 50 || delivery.body.length + footer.length > 35_000) {
    footer = [title, actorLine, details ? 'Полный ответ доступен в Codex.' : ''].filter(Boolean).join('\n');
  }
  return { text: `${delivery.body}\n\n${footer}`, blocks: [...sections, ...questionSections(footer)] };
}
