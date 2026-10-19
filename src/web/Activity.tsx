import { useState, type FormEvent } from 'react';
import type { Approval, DashboardState, ReleRequest } from '../shared/types';
import { ReleApi } from './client';
import { useAction } from './hooks';
import {
  ActionMessages,
  Button,
  EmptyState,
  Field,
  Notice,
  PageHeading,
  PlatformIcon,
  Status,
  deliveryLabels,
  formatDate,
  requestLabels,
  statusTone,
} from './ui';

const activeStatuses = [
  'queued',
  'transcribing',
  'starting',
  'running',
  'waiting_approval',
  'uncertain',
];
const cancellableStatuses = [
  'queued',
  'transcribing',
  'starting',
  'running',
  'waiting_approval',
];
function conversationName(
  state: DashboardState,
  request: ReleRequest | undefined,
): string {
  return (
    state.conversations.find((item) => item.id === request?.conversationId)
      ?.name ?? 'Связка недоступна'
  );
}

function OriginCell({
  state,
  origin,
}: {
  state: DashboardState;
  origin: ReleRequest['origin'];
}) {
  const endpoint = state.endpoints.find(
    (item) => item.id === origin.endpointId,
  );
  return (
    <div className="platform-cell">
      <PlatformIcon platform={origin.platform} />
      <div className="cell-copy">
        <span>
          {endpoint?.title ??
            (origin.platform === 'telegram' ? 'Telegram' : 'Slack')}
        </span>
        <small>
          {origin.senderName}
          {endpoint?.subtitle ? ` · ${endpoint.subtitle}` : ''}
        </small>
      </div>
    </div>
  );
}

export function Queue({
  state,
  api,
  refresh,
}: {
  state: DashboardState;
  api: ReleApi;
  refresh: () => Promise<void>;
}) {
  const [showAll, setShowAll] = useState(false);
  const [working, setWorking] = useState('');
  const action = useAction();
  const requests = [...state.requests]
    .filter((request) => showAll || activeStatuses.includes(request.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const approvals = state.approvals.filter(
    (approval) => approval.status === 'pending',
  );
  const requestAction = async (
    request: ReleRequest,
    operation: 'cancel' | 'reconcile' | 'resume',
  ) => {
    setWorking(`${request.id}/${operation}`);
    const result = await action.run(
      () =>
        api.request(
          `/api/requests/${encodeURIComponent(request.id)}/${operation}`,
          'POST',
        ),
      operation === 'reconcile'
        ? 'Состояние сверено с Codex.'
        : operation === 'resume'
          ? 'Запрос на продолжение очереди отправлен.'
          : request.status === 'queued'
            ? 'Запрос отменён.'
            : 'Запрос на прерывание отправлен.',
    );
    if (result.ok) await refresh();
    setWorking('');
  };
  return (
    <>
      <PageHeading
        title="Очередь"
        description="Запросы выполняются последовательно в каждом разговоре Codex."
        actions={
          <Button icon="refresh" onClick={() => void refresh()}>
            Обновить
          </Button>
        }
      />
      {approvals.length > 0 && (
        <section className="approvals-section" aria-labelledby="approval-title">
          <h2 id="approval-title">Нужно ваше решение</h2>
          {approvals.map((approval) => (
            <ApprovalForm
              key={approval.id}
              approval={approval}
              state={state}
              api={api}
              refresh={refresh}
            />
          ))}
        </section>
      )}
      <div className="toolbar">
        <div className="segmented" aria-label="Показать запросы">
          <button aria-pressed={!showAll} onClick={() => setShowAll(false)}>
            Активные
          </button>
          <button aria-pressed={showAll} onClick={() => setShowAll(true)}>
            Все запросы
          </button>
        </div>
      </div>
      <ActionMessages error={action.error} success={action.success} />
      <div className="table-panel">
        {requests.length ? (
          <div className="table-wrap">
            <table className="activity-table">
              <thead>
                <tr>
                  <th scope="col">Запрос / связка</th>
                  <th scope="col">Источник</th>
                  <th scope="col">Состояние</th>
                  <th scope="col">Поступил</th>
                  <th scope="col">
                    <span className="sr-only">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id}>
                    <td data-label="Запрос / связка">
                      <div className="cell-copy">
                        <strong>{conversationName(state, request)}</strong>
                        <details className="message-details">
                          <summary>
                            {request.text ||
                              (request.audio
                                ? 'Голосовое сообщение'
                                : 'Сообщение без текста')}
                          </summary>
                          <p>{request.text || request.audio?.name}</p>
                        </details>
                        {request.error && (
                          <span
                            className={
                              request.status === 'queued'
                                ? 'inline-warning'
                                : 'inline-error'
                            }
                          >
                            {request.error}
                          </span>
                        )}
                        {request.status === 'uncertain' && (
                          <span className="inline-warning">
                            Запуск мог состояться. Проверьте разговор Codex
                            перед новым запросом.
                          </span>
                        )}
                      </div>
                    </td>
                    <td data-label="Источник">
                      <OriginCell state={state} origin={request.origin} />
                    </td>
                    <td data-label="Состояние">
                      <Status tone={statusTone(request.status)}>
                        {requestLabels[request.status]}
                      </Status>
                    </td>
                    <td data-label="Поступил">
                      <time dateTime={request.createdAt}>
                        {formatDate(request.createdAt)}
                      </time>
                    </td>
                    <td className="row-action">
                      <div className="request-actions">
                        {['starting', 'uncertain'].includes(request.status) && (
                          <Button
                            disabled={action.busy}
                            busy={working === `${request.id}/reconcile`}
                            onClick={() =>
                              void requestAction(request, 'reconcile')
                            }
                          >
                            Сверить
                          </Button>
                        )}
                        {request.status === 'starting' &&
                          request.queuedSubmissionId && (
                            <Button
                              disabled={action.busy}
                              busy={working === `${request.id}/resume`}
                              onClick={() =>
                                void requestAction(request, 'resume')
                              }
                            >
                              Продолжить
                            </Button>
                          )}
                        {cancellableStatuses.includes(request.status) && (
                          <Button
                            variant="quiet"
                            disabled={action.busy}
                            busy={working === `${request.id}/cancel`}
                            onClick={() =>
                              void requestAction(request, 'cancel')
                            }
                          >
                            {['queued', 'transcribing'].includes(request.status)
                              ? 'Отменить'
                              : 'Прервать'}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon="clock"
            title={showAll ? 'Запросов пока нет' : 'Очередь свободна'}
          >
            {showAll
              ? 'Отправьте сообщение в разрешённый разговор Telegram или Slack — запрос появится здесь.'
              : 'Новые запросы появятся здесь. Завершённые доступны во вкладке «Все запросы».'}
          </EmptyState>
        )}
      </div>
    </>
  );
}

function ApprovalForm({
  approval,
  state,
  api,
  refresh,
}: {
  approval: Approval;
  state: DashboardState;
  api: ReleApi;
  refresh: () => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  const action = useAction();
  const request = state.requests.find((item) => item.id === approval.requestId);
  const resolve = async (decision: 'accept' | 'decline') => {
    if (
      decision === 'accept' &&
      approval.questions?.some(
        (question) => !answers[question.id]?.some((answer) => answer.trim()),
      )
    ) {
      action.setError('Ответьте на каждый вопрос Codex.');
      return;
    }
    const result = await action.run(() =>
      api.request(
        `/api/approvals/${encodeURIComponent(approval.id)}/resolve`,
        'POST',
        {
          decision,
          ...(decision === 'accept' && approval.questions?.length
            ? { answers }
            : {}),
        },
      ),
    );
    if (result.ok) {
      setAnswers({});
      await refresh();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void resolve('accept');
  };
  return (
    <form className="approval-panel form-stack" onSubmit={submit}>
      <div className="approval-header">
        <div>
          <h3>{approval.title}</h3>
          <p>
            {conversationName(state, request)}
            {request ? ` · ${request.origin.senderName}` : ''}
          </p>
        </div>
        <Status tone="warning">Ожидает решения</Status>
      </div>
      {approval.details && (
        <pre className="approval-details">{approval.details}</pre>
      )}
      {approval.questions?.map((question) => (
        <fieldset
          className="question-fieldset"
          key={question.id}
          disabled={action.busy}
        >
          <legend>{question.header || 'Вопрос Codex'}</legend>
          <p>{question.question}</p>
          {question.options?.length && !question.isSecret ? (
            <>
              <div className="question-options">
                {question.options.map((option) => (
                  <label className="check-row" key={option.label}>
                    <input
                      type="radio"
                      name={`${approval.id}-${question.id}`}
                      checked={
                        !custom[question.id] &&
                        answers[question.id]?.[0] === option.label
                      }
                      onChange={() => {
                        setCustom((value) => ({
                          ...value,
                          [question.id]: false,
                        }));
                        setAnswers((value) => ({
                          ...value,
                          [question.id]: [option.label],
                        }));
                      }}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                  </label>
                ))}
                <label className="check-row">
                  <input
                    type="radio"
                    name={`${approval.id}-${question.id}`}
                    checked={custom[question.id] ?? false}
                    onChange={() => {
                      setCustom((value) => ({ ...value, [question.id]: true }));
                      setAnswers((value) => ({
                        ...value,
                        [question.id]: [''],
                      }));
                    }}
                  />
                  <span>Свой ответ</span>
                </label>
              </div>
              {custom[question.id] && (
                <Field
                  label={`Свой ответ: ${question.header || question.question}`}
                >
                  <textarea
                    required
                    value={answers[question.id]?.[0] ?? ''}
                    onChange={(event) =>
                      setAnswers((value) => ({
                        ...value,
                        [question.id]: [event.target.value],
                      }))
                    }
                  />
                </Field>
              )}
            </>
          ) : (
            <Field
              label={question.isSecret ? 'Конфиденциальный ответ' : 'Ваш ответ'}
            >
              {question.isSecret ? (
                <input
                  type="password"
                  autoComplete="off"
                  required
                  value={answers[question.id]?.[0] ?? ''}
                  onChange={(event) =>
                    setAnswers((value) => ({
                      ...value,
                      [question.id]: [event.target.value],
                    }))
                  }
                />
              ) : (
                <textarea
                  required
                  value={answers[question.id]?.[0] ?? ''}
                  onChange={(event) =>
                    setAnswers((value) => ({
                      ...value,
                      [question.id]: [event.target.value],
                    }))
                  }
                />
              )}
            </Field>
          )}
        </fieldset>
      ))}
      <ActionMessages error={action.error} success={action.success} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={action.busy}>
          {approval.questions?.length ? 'Отправить ответы' : 'Разрешить'}
        </Button>
        <Button
          variant="danger"
          busy={action.busy}
          onClick={() => void resolve('decline')}
        >
          Отклонить
        </Button>
      </div>
    </form>
  );
}

export function Deliveries({
  state,
  api,
  refresh,
}: {
  state: DashboardState;
  api: ReleApi;
  refresh: () => Promise<void>;
}) {
  const [filter, setFilter] = useState('all');
  const [working, setWorking] = useState('');
  const action = useAction();
  const deliveries = [...state.deliveries]
    .filter(
      (item) =>
        filter === 'all' ||
        (filter === 'attention' &&
          ['failed', 'uncertain'].includes(item.status)) ||
        (filter === 'pending' && ['pending', 'sending'].includes(item.status)),
    )
    .sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || a.ordinal - b.ordinal,
    );
  const retry = async (id: string) => {
    setWorking(id);
    const result = await action.run(
      () =>
        api.request(`/api/deliveries/${encodeURIComponent(id)}/retry`, 'POST'),
      'Готовый ответ поставлен на повторную доставку. Задача Codex не запускается повторно.',
    );
    if (result.ok) await refresh();
    setWorking('');
  };
  return (
    <>
      <PageHeading
        title="Доставка"
        description="Готовые ответы и подтверждение их отправки в исходный разговор."
        actions={
          <Button icon="refresh" onClick={() => void refresh()}>
            Обновить
          </Button>
        }
      />
      <div className="toolbar">
        <div className="segmented" aria-label="Фильтр доставки">
          {[
            ['all', 'Все ответы'],
            ['attention', 'Требуют внимания'],
            ['pending', 'Ожидают отправки'],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <ActionMessages error={action.error} success={action.success} />
      <div className="table-panel">
        {deliveries.length ? (
          <div className="table-wrap">
            <table className="activity-table delivery-table">
              <thead>
                <tr>
                  <th scope="col">Ответ / связка</th>
                  <th scope="col">Получатель</th>
                  <th scope="col">Доставка</th>
                  <th scope="col">Обновлена</th>
                  <th scope="col">
                    <span className="sr-only">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td data-label="Ответ / связка">
                      <div className="cell-copy">
                        <strong>
                          {conversationName(
                            state,
                            state.requests.find(
                              (request) => request.id === delivery.requestId,
                            ),
                          )}
                        </strong>
                        <small>
                          {delivery.kind === 'approval'
                            ? 'Подтверждение'
                            : delivery.kind === 'error'
                              ? 'Сообщение об ошибке'
                              : `Ответ · часть ${delivery.ordinal + 1}`}
                        </small>
                        <details className="message-details">
                          <summary>{delivery.body}</summary>
                          <p>{delivery.body}</p>
                        </details>
                      </div>
                    </td>
                    <td data-label="Получатель">
                      <OriginCell state={state} origin={delivery.origin} />
                    </td>
                    <td data-label="Доставка">
                      <div className="cell-copy">
                        <Status tone={statusTone(delivery.status)}>
                          {deliveryLabels[delivery.status]}
                        </Status>
                        {delivery.error && (
                          <small className="inline-error">
                            {delivery.error}
                          </small>
                        )}
                        {delivery.status === 'uncertain' && (
                          <small className="inline-warning">
                            Ответ мог быть доставлен. Проверьте исходный
                            разговор. Повторная отправка заблокирована.
                          </small>
                        )}
                        {delivery.nextAttemptAt &&
                          delivery.status === 'pending' && (
                            <small>
                              Следующая попытка:{' '}
                              {formatDate(delivery.nextAttemptAt)}
                            </small>
                          )}
                      </div>
                    </td>
                    <td data-label="Обновлена">
                      <time dateTime={delivery.updatedAt}>
                        {formatDate(delivery.updatedAt)}
                      </time>
                    </td>
                    <td className="row-action">
                      {delivery.status === 'failed' && (
                        <Button
                          disabled={action.busy}
                          busy={working === delivery.id}
                          icon="refresh"
                          onClick={() => void retry(delivery.id)}
                        >
                          Повторить
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon="send"
            title={
              filter === 'all'
                ? 'Ответов для доставки пока нет'
                : 'В этой группе нет ответов'
            }
          >
            {filter === 'all'
              ? 'Когда Codex завершит запрос, здесь появится ответ и состояние его доставки.'
              : 'Состояние обновляется автоматически. Все отправленные сообщения доступны во вкладке «Все ответы».'}
          </EmptyState>
        )}
      </div>
      {state.deliveries.some((item) => item.status === 'uncertain') && (
        <div className="section-note">
          <Notice tone="warning">
            Если связь оборвалась после отправки, Rele не может гарантировать
            результат доставки. Проверьте разговор перед дальнейшими действиями.
          </Notice>
        </div>
      )}
    </>
  );
}
