import type { Delivery, Origin, ReleRequest } from './types.js';

export type TraceStage = 'request' | 'ingress' | 'admission' | 'native' | 'execution' | 'delivery';
export interface TraceStep { stage: TraceStage; status: string; detail: string; at?: string }
export interface MessageTrace {
  source: Pick<Origin, 'platform' | 'accountId' | 'endpointId' | 'chatId' | 'threadId' | 'messageId'>;
  requestId?: string; eventId?: string; nativeThreadId?: string;
  capturedAt: string; startedAt: string; provenance: 'saved' | 'current';
  connected: { codex: boolean; source: boolean };
  latest: Pick<TraceStep, 'stage' | 'status' | 'at'>;
  steps: TraceStep[];
  deliveries: Array<{ id: string; kind: Delivery['kind']; status: Delivery['status']; at: string; receipt: boolean }>;
  nextAction: string; warnings: string[];
}

export function sameTraceOrigin(left: Origin, right: Origin): boolean {
  return (['platform', 'accountId', 'endpointId', 'chatId', 'threadId', 'messageId', 'senderId'] as const)
    .every(key => left[key] === right[key]);
}

export function messageTrace(input: {
  origin: Origin; request?: ReleRequest; deliveries: Delivery[];
  receivedAt?: string; enqueueRejectedAt?: string; nativeThreadId?: string;
  startedAt: string; capturedAt: string; connected: MessageTrace['connected'];
}): MessageTrace {
  const { origin, startedAt, capturedAt, connected } = input;
  const request = input.request && sameTraceOrigin(input.request.origin, origin) ? input.request : undefined;
  const deliveries = [...new Map(input.deliveries.filter(item => sameTraceOrigin(item.origin, origin)
    && (request ? item.requestId === request.id : !item.requestId)).map(item => [item.id, item])).values()];
  const { platform, accountId, endpointId, chatId, threadId, messageId } = origin;
  const steps: TraceStep[] = [
    { stage: 'ingress', status: input.receivedAt ? 'recorded' : 'no-data',
      detail: input.receivedAt ? 'Есть сохранённая квитанция приёма Rele.' : 'Нет данных о приёме. Это не означает, что сообщение не поступило.', at: input.receivedAt },
    { stage: 'admission', status: request ? request.status === 'queued' ? 'queued' : 'recorded' : 'no-data',
      detail: request ? 'Запрос создан; детали решения фильтра не сохранялись.' : 'Нет данных: историческое решение разрешить или пропустить не сохранялось.', at: request?.createdAt },
    { stage: 'native', status: 'no-data', detail: 'Нет подтверждения приёма Codex.' },
    { stage: 'execution', status: 'no-data', detail: 'Нет данных о выполнении.' },
    { stage: 'delivery', status: 'no-data', detail: 'Нет данных о доставке. Отсутствие записи не доказывает отсутствие ответа.' },
  ];
  const native = steps[2], execution = steps[3], delivery = steps[4];
  let latest: MessageTrace['latest'] = { stage: 'ingress', status: steps[0].status, at: input.receivedAt };
  let nextAction = 'Проверьте исходный чат и существующие записи; отсутствие данных не доказывает отсутствие сообщения.';
  if (request) {
    latest = { stage: 'admission', status: request.status, at: request.updatedAt };
    nextAction = 'Дождитесь обновления снимка. Выполнение и доставка ещё не подтверждены.';
    if (request.queuedSubmissionId || request.turnId) {
      Object.assign(native, { status: 'accepted', detail: request.turnId ? 'Сохранён идентификатор native turn.' : 'Получено подтверждение native очереди. Это ещё не запуск выполнения.' });
      latest = { stage: 'native', status: 'accepted', at: request.updatedAt };
    }
    if (['running', 'waiting_approval', 'completed', 'failed', 'interrupted', 'cancelled'].includes(request.status)) {
      Object.assign(execution, { status: request.steeredInto ? 'steered' : request.status,
        detail: request.steeredInto ? 'Сообщение добавлено в выполняющийся запрос; завершение общего хода здесь не доказано.'
          : request.status === 'failed' ? 'Сохранена ошибка запроса; без отдельной квитанции тип отказа неизвестен.'
          : 'Сохранено состояние запроса Rele; время относится к последнему изменению записи.', at: request.updatedAt });
      latest = { stage: 'execution', status: execution.status, at: request.updatedAt };
      nextAction = request.status === 'waiting_approval' ? 'Просмотрите отдельное подтверждение в очереди.'
        : request.status === 'running' ? 'Дождитесь завершения и обновите снимок.'
        : 'Проверьте исходный чат и сохранённое состояние запроса; карточка не запускает новый ход.';
    }
    if (!request.turnId && ['completed', 'failed', 'interrupted', 'cancelled'].includes(request.status)) {
      Object.assign(execution, { status: 'no-data', detail: 'Сохранён итог запроса Rele, но фактическое выполнение Codex не подтверждено.', at: undefined });
      latest = { stage: 'request', status: request.status, at: request.updatedAt };
    }
    if (request.status === 'uncertain') {
      Object.assign(native, { status: 'uncertain', detail: 'Исход native операции не подтверждён; сохранённые идентификаторы не снимают неопределённость.', at: request.updatedAt });
      latest = { stage: request.turnId ? 'execution' : 'native', status: 'uncertain', at: request.updatedAt };
      if (request.turnId) Object.assign(execution, { status: 'uncertain', detail: 'Исход выполнения неизвестен.', at: request.updatedAt });
      nextAction = 'Проверьте очередь и историю Codex; не повторяйте запрос до подтверждения исхода. Защищённая сверка доступна отдельно в очереди.';
    }
    if (request.status === 'failed' && input.enqueueRejectedAt === request.updatedAt) {
      Object.assign(native, { status: 'rejected', detail: 'Сохранён явный RPC-отказ при enqueue. Это не потеря подтверждения.', at: input.enqueueRejectedAt });
      latest = { stage: 'native', status: 'rejected', at: input.enqueueRejectedAt };
      nextAction = 'Просмотрите причину отказа в очереди. Карточка не отправляет запрос заново.';
    }
    if (request.suppressedFinal && request.status === 'completed') {
      Object.assign(execution, { status: 'suppressed', detail: 'Агент завершил запрос без отправки финального ответа (NOREPLY).', at: request.updatedAt });
      Object.assign(delivery, { status: 'suppressed', detail: 'Финальный ответ намеренно не отправлялся (NOREPLY).', at: request.updatedAt });
      latest = { stage: 'execution', status: 'suppressed', at: request.updatedAt };
      nextAction = 'Отправка финального ответа намеренно подавлена; проверьте результат в Codex, если ответ ожидался.';
    }
  }
  // Clarification receipts, approvals and error notices do not prove delivery of a final answer.
  const answers = deliveries.filter(item => request ? item.kind === 'answer' && !item.key.startsWith('question-answer:') : item.kind === 'message');
  if (answers.length) {
    const status = answers.some(item => item.status === 'uncertain') ? 'uncertain'
      : answers.some(item => item.status === 'sending') ? 'sending'
      : answers.some(item => item.status === 'pending') ? 'pending'
      : answers.some(item => item.status === 'failed') ? 'failed'
      : answers.every(item => item.status === 'sent' && !!item.remoteMessageId) ? 'sent'
      : answers.every(item => item.status === 'cancelled') ? 'cancelled' : 'no-data';
    const at = answers.map(item => item.updatedAt).sort().at(-1);
    Object.assign(delivery, { status, at, detail: status === 'sent'
      ? 'Для всех сохранённых частей есть квитанции провайдера. Прочтение получателем не подтверждено.'
      : status === 'uncertain' ? 'Исход хотя бы одной части неизвестен; другие квитанции этого не отменяют.'
      : 'Сохранено состояние частей ответа; доставка всего ответа не подтверждена.' });
    latest = { stage: 'delivery', status, at };
    nextAction = status === 'sent' ? 'Квитанции отправки сохранены. При необходимости проверьте исходный чат; прочтение не подтверждено.'
      : status === 'uncertain' || status === 'sending' ? 'Проверьте исходный чат; не повторяйте отправку до подтверждения результата.'
      : status === 'pending' ? 'Дождитесь штатной доставки и обновите снимок.'
      : 'Проверьте сохранённое состояние в разделе доставки; явные действия остаются отдельно.';
  }
  const createdAt = request?.createdAt ?? deliveries[0]?.createdAt;
  return { source: { platform, accountId, endpointId, chatId, threadId, messageId },
    requestId: request?.id, eventId: request?.eventId, nativeThreadId: input.nativeThreadId,
    capturedAt, startedAt, provenance: createdAt && createdAt < startedAt ? 'saved' : 'current',
    connected, latest, steps, deliveries: deliveries.map(item => ({ id: item.id, kind: item.kind, status: item.status, at: item.updatedAt, receipt: !!item.remoteMessageId })),
    nextAction, warnings: [
      ...(!connected.codex ? ['Codex отключён; показаны сохранённые данные.'] : []),
      ...(!connected.source ? ['Источник отключён; показаны сохранённые данные.'] : []),
    ] };
}
