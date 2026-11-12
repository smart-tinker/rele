import { useEffect, useState } from 'react';
import type { MessageTrace, TraceStage } from '../shared/message-trace';
import { ReleApi, errorText } from './client';
import { Button, Drawer, Notice, Status, formatDate } from './ui';

const stages: Record<TraceStage, string> = { ingress: 'Приём', admission: 'Разрешение / пропуск', native: 'Приём Codex', execution: 'Выполнение', delivery: 'Доставка' };
const statuses: Record<string, string> = {
  'no-data': 'Нет данных', recorded: 'Запись сохранена', queued: 'В очереди Rele', transcribing: 'Обработка аудио', starting: 'Подготовка запуска',
  accepted: 'Принято Codex', running: 'Выполняется', waiting_approval: 'Ожидает решения', completed: 'Завершено', failed: 'Ошибка',
  interrupted: 'Прервано', cancelled: 'Отменено', uncertain: 'Исход неизвестен', rejected: 'Явный отказ enqueue', suppressed: 'Финальный ответ подавлен',
  steered: 'Добавлено в выполняющийся запрос', pending: 'Ожидает отправки', sending: 'Отправляется', sent: 'Квитанции доставки сохранены',
};
function label(stage: TraceStage, status: string): string {
  return stage === 'delivery' && status === 'uncertain' ? 'Доставка не подтверждена' : statuses[status] ?? 'Нет данных';
}

export function TraceLink({ kind, id, api }: { kind: 'requests' | 'deliveries'; id: string; api: ReleApi }) {
  const [open, setOpen] = useState(false);
  return <>
    <a href={`#trace/${kind}/${encodeURIComponent(id)}`} onClick={event => { event.preventDefault(); setOpen(true); }}>Трасса</a>
    {open && <TraceDrawer kind={kind} id={id} api={api} onClose={() => setOpen(false)} />}
  </>;
}

function TraceDrawer({ kind, id, api, onClose }: { kind: 'requests' | 'deliveries'; id: string; api: ReleApi; onClose: () => void }) {
  const [trace, setTrace] = useState<MessageTrace | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    void api.request<MessageTrace>(`/api/traces/${kind}/${encodeURIComponent(id)}`, 'GET', undefined, controller.signal).then(next => {
      if (!controller.signal.aborted) { setTrace(next); setError(''); setNow(Date.now()); }
    }, cause => { if (!controller.signal.aborted) setError(errorText(cause)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api, kind, id, revision]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 5000); return () => window.clearInterval(timer); }, []);
  const stale = trace && (!!error || now - Date.parse(trace.capturedAt) > 30_000);
  return <Drawer title="Трасса сообщения" onClose={onClose}>
    <div className="form-stack">
      <p className="field-hint">Только чтение сохранённых свидетельств. Просмотр и обновление ничего не отправляют.</p>
      {error && <Notice>{trace ? 'Снимок устарел: обновление не удалось.' : error}</Notice>}
      {stale && !error && <Notice tone="warning">Снимок устарел. Обновите его перед оценкой текущего состояния.</Notice>}
      {trace ? <>
        <div>
          <h3>Последнее подтверждённое состояние</h3>
          <p>{stages[trace.latest.stage]} · <Status tone={['uncertain', 'no-data'].includes(trace.latest.status) ? 'warning' : trace.latest.status === 'sent' ? 'good' : 'muted'}>{label(trace.latest.stage, trace.latest.status)}</Status></p>
          <p className="field-hint">{trace.latest.at ? <>Время записи: <time dateTime={trace.latest.at}>{formatDate(trace.latest.at)}</time></> : 'Время этапа не сохранялось.'}</p>
        </div>
        {trace.warnings.map(warning => <Notice key={warning} tone="warning">{warning}</Notice>)}
        <Notice tone="info">{trace.nextAction}</Notice>
        <dl className="codex-runtime" aria-label="Идентичность сообщения">
          <div><dt>Источник</dt><dd>{trace.source.platform} · {trace.source.endpointId}</dd></div>
          <div><dt>Аккаунт / чат / тред источника</dt><dd>{trace.source.accountId} / {trace.source.chatId} / {trace.source.threadId || 'общий'}</dd></div>
          <div><dt>Сообщение источника</dt><dd>{trace.source.messageId}</dd></div>
          <div><dt>Запрос Rele</dt><dd>{trace.requestId ?? 'Нет данных'}</dd></div>
          <div><dt>Событие</dt><dd>{trace.eventId ?? 'Нет данных'}</dd></div>
          <div><dt>Тред Codex</dt><dd>{trace.nativeThreadId ?? 'Нет данных'}</dd></div>
        </dl>
        <p className="field-hint">{trace.provenance === 'saved' ? 'Запись сохранена до запуска Rele. Это не новая live-проверка.' : 'Запись создана в текущем сеансе Rele. Это не новая live-проверка.'} Снимок: <time dateTime={trace.capturedAt}>{formatDate(trace.capturedAt)}</time>.</p>
        <div className="form-stack">{trace.steps.map(step => <section key={step.stage}>
          <h3>{stages[step.stage]} · {label(step.stage, step.status)}</h3>
          <p>{step.detail}</p>
          {step.at && <p className="field-hint"><time dateTime={step.at}>{formatDate(step.at)}</time></p>}
        </section>)}</div>
        {!!trace.deliveries.length && <details><summary>Связанные записи доставки ({trace.deliveries.length})</summary>
          <dl className="codex-runtime">{trace.deliveries.map(delivery => <div key={delivery.id}><dt>{delivery.id} · {delivery.kind}</dt>
            <dd>{label('delivery', delivery.status)} · {delivery.receipt ? 'Есть квитанция провайдера' : 'Квитанции нет'} · {formatDate(delivery.at)}</dd></div>)}</dl>
        </details>}
      </> : busy ? <p role="status">Загружаем свидетельства…</p> : null}
      <Button icon="refresh" busy={busy} onClick={() => setRevision(value => value + 1)}>Обновить снимок</Button>
    </div>
  </Drawer>;
}
