import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { SlackSyncEntryState, SlackSyncJournal as Journal } from '../shared/types';
import { errorText, type ReleApi } from './client';
import { Button, Field, formatDate, Notice } from './ui';

const entryLabels: Record<SlackSyncEntryState, string> = {
  pending: 'Ожидает передачи',
  applying: 'Передаётся в Codex',
  applied: 'В контексте Codex',
  uncertain: 'Передача не подтверждена',
};

export function SlackSyncJournal({ api, conversationId }: { api: ReleApi; conversationId: string }) {
  const titleId = useId();
  const [view, setView] = useState({ conversationId, streamId: '', pages: 1 });
  const streamId = view.conversationId === conversationId ? view.streamId : '';
  const pages = view.conversationId === conversationId ? view.pages : 1;
  const scope = JSON.stringify([conversationId, streamId]);
  const [result, setResult] = useState<{ scope: string; data?: Journal; loading: boolean; error: string }>({ scope, loading: true, error: '' });
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setResult(current => ({ scope, data: current.scope === scope ? current.data : undefined, loading: true, error: '' }));
    const read = (offset: number, selected: string) => {
      const query = new URLSearchParams({ offset: String(offset), limit: '50' });
      if (selected) query.set('streamId', selected);
      return api.request<Journal>(`/api/conversations/${encodeURIComponent(conversationId)}/slack-sync?${query}`, 'GET', undefined, controller.signal);
    };
    try {
      const first = await read(0, streamId);
      const remaining = first.streamId
        ? await Promise.all(Array.from({ length: pages - 1 }, (_, index) => read((index + 1) * 50, first.streamId!)))
        : [];
      if (controller.signal.aborted) return;
      const all = [first, ...remaining];
      const entries = [...new Map(all.flatMap(page => page.entries).map(entry => [entry.id, entry])).values()];
      setResult({ scope, data: { ...first, entries, nextOffset: all.at(-1)?.nextOffset }, loading: false, error: '' });
    } catch (cause) {
      if (!controller.signal.aborted) {
        setResult(current => ({ ...current, loading: false, error: errorText(cause) }));
        controller.abort();
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [api, conversationId, pages, scope, streamId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden && !request.current) void load(); }, 5000);
    return () => { request.current?.abort(); window.clearInterval(timer); };
  }, [load]);

  const current = result.scope === scope ? result : { loading: true, error: '', data: undefined };
  const data = current.data;
  if (data && !data.streams.length && !current.error) return null;
  const stream = data?.streams.find(item => item.id === data.streamId);
  const received = stream ? Object.values(stream.counts).reduce((total, count) => total + count, 0) : 0;
  const applied = stream ? stream.counts.applied : 0;
  const pending = stream ? stream.counts.pending + stream.counts.applying + stream.counts.uncertain : 0;
  const phase = stream && !stream.active && stream.state === 'backfill'
    ? pending ? 'Полученные сообщения отвязанного источника ожидают передачи в Codex.' : 'Полученные сообщения отвязанного источника переданы в контекст Codex.'
    : stream?.state === 'backfill' ? 'Загружается история треда.'
    : stream?.state === 'blocked' ? 'Синхронизация заблокирована.'
    : pending ? 'Контекст ожидает передачи в Codex.'
    : 'Полученные сообщения переданы в контекст Codex.';

  return (
    <section className="form-section form-stack" aria-labelledby={titleId}>
      <h3 id={titleId}>Журнал контекста Slack</h3>
      <p className="muted">Здесь хранится контекст модели Codex, включая сообщения ботов. Пассивные записи не создают отдельные сообщения в Desktop и не запускают ответ. Запуск разрешён выбранным выше отправителям.</p>
      <div className="catalog-controls">
        <Button icon="refresh" busy={current.loading} aria-label="Обновить журнал Slack" onClick={() => void load()}>Обновить</Button>
      </div>
      {current.loading && !data ? <p className="field-hint" role="status">Загружаем журнал…</p> : null}
      {current.error ? <Notice>{current.error}</Notice> : null}
      {data && data.streams.length > 1 ? (
        <Field label="Источник журнала Slack">
          <select value={data.streamId ?? ''} onChange={event => setView({ conversationId, streamId: event.target.value, pages: 1 })}>
            {data.streams.map(item => <option key={item.id} value={item.id}>{item.title}{item.active ? '' : ' · Отвязан'}</option>)}
          </select>
        </Field>
      ) : null}
      {stream ? <>
        <p className="field-hint">{stream.title}{stream.active ? '' : ' · Источник отвязан; ранее полученный контекст остаётся в журнале.'}</p>
        <Notice tone={stream.state === 'blocked' || stream.paused ? 'warning' : stream.state === 'ready' && !pending ? 'success' : 'info'}>{phase}</Notice>
        {stream.paused ? <p className="field-hint">Связка приостановлена: передача ожидает возобновления.</p> : null}
        {stream.error ? <Notice tone="warning">{stream.error}</Notice> : null}
        <p className="field-hint" aria-live="polite">Получено: {received} · В контексте Codex: {applied} · Ожидают: {pending}</p>
      </> : null}
      {data ? <div className="form-stack">
        {data.entries.map(entry => {
          const messageDate = new Date(Number(entry.message.messageId) * 1000);
          const timestamp = Number.isNaN(messageDate.getTime()) ? entry.createdAt : messageDate.toISOString();
          return <article className="catalog-instruction" key={entry.id} aria-label={`Сообщение ${entry.message.sender.name}`}>
            <div className="cell-copy">
              <strong>{entry.message.sender.name}{entry.message.sender.isBot ? ' · Бот' : ''}</strong>
              <small><time dateTime={timestamp}>{formatDate(timestamp)}</time> · {entryLabels[entry.state]}{entry.message.kind === 'edit' ? ' · Изменено' : entry.message.kind === 'deleted' ? ' · Удалено' : ''}</small>
            </div>
            <div className="message-details"><p>{entry.message.text || 'Сообщение без текстового поля. Полные данные Slack доступны ниже.'}</p></div>
            {entry.error ? <Notice tone="warning">{entry.error}</Notice> : null}
            <details className="message-details"><summary>Данные Slack (JSON)</summary><pre className="approval-details">{JSON.stringify(entry.message.payload, null, 2)}</pre></details>
          </article>;
        })}
        {!data.entries.length && stream ? <p className="muted">В журнале пока нет полученных сообщений.</p> : null}
        {data.nextOffset !== undefined ? <div><Button busy={current.loading} onClick={() => setView({ conversationId, streamId: data.streamId ?? streamId, pages: pages + 1 })}>Показать ещё</Button></div> : null}
      </div> : null}
    </section>
  );
}
