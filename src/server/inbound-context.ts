import type { Origin, Person, Platform, ReleRequest } from '../shared/types.js';

const instructions = 'Это разговор нескольких участников через Rele. Техническая роль user не означает, что сообщение написал владелец: автор указан в заголовке. Список известных участников не означает адресатов и может быть неполным. Упоминания находятся в исходном тексте. Решай по содержанию, кому и нужно ли отвечать. Если ответ не нужен, заверши точным NOREPLY без другого текста.';
const encoded = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
const identity = (person: Person) => ({ id: person.id, name: person.name,
  type: person.isBot === true ? 'bot' : person.isBot === false ? 'human' : 'unknown' });

export function attributionHeader(source: Pick<Origin, 'accountId' | 'chatId' | 'threadId' | 'messageId'> & { platform: Platform }, sender: Person, participants: Person[]): string {
  return `Источник Rele: ${encoded(source)}\nАвтор: ${encoded(identity(sender))}\nИзвестные участники этого треда на момент сообщения: ${encoded(participants.map(identity))}`;
}

export function requestInput(request: ReleRequest): string {
  const origin = request.origin;
  const sender: Person = { id: origin.senderId, name: origin.senderName, isBot: origin.senderIsBot };
  return `${instructions}\n${attributionHeader({ platform: origin.platform, accountId: origin.accountId, chatId: origin.chatId,
    threadId: origin.threadId, messageId: origin.messageId }, sender, origin.participants ?? [sender])}\n\nИсходное сообщение:\n${request.text}`;
}
