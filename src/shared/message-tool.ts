import { createHash } from 'node:crypto';

export function messageToolOperationId(threadId: string, callId: string): string {
  return `tool-${createHash('sha256').update(JSON.stringify([threadId, callId])).digest('hex')}`;
}

const errors = {
  stopping: 'Rele завершает работу. Проверьте состояние перед повторной отправкой.',
  invalid_call: 'Не подтверждён исходный вызов Codex.',
  invalid_arguments: 'Аргументы инструмента должны быть объектом.',
  unknown_arguments: 'Неизвестные аргументы инструмента.',
  operation_required: 'Укажите идентификатор операции.',
  operation_unknown: 'Операция не найдена в этом разговоре Codex.',
  unknown_tool: 'Неизвестный инструмент Rele.',
  destination_required: 'Выберите один конкретный источник из list_destinations.',
  text_invalid: 'Текст должен содержать от 1 до 3000 символов.',
  mentions_invalid: 'Укажите уникальные ID известных участников.',
  destination_unavailable: 'Источник недоступен этому разговору Codex. Обновите list_destinations.',
  participant_unknown: 'Участник не известен в выбранном треде.',
  mention_unavailable: 'Для этого участника нет проверенного адреса упоминания. Сообщение не создано.',
  call_conflict: 'Этот вызов уже сохранён с другими аргументами. Не повторяйте отправку.',
} as const;

/** Only these fixed validation messages may be returned to the model. */
export class MessageToolValidationError extends Error {
  constructor(readonly code: keyof typeof errors) { super(errors[code]); }
}
