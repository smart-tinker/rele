import { useState, type FormEvent } from 'react';
import type { DashboardState, Endpoint, Platform, ReactionMode } from '../shared/types';
import { ReleApi } from './client';
import { useAction } from './hooks';
import { AllowedSenders } from './CatalogPicker';
import { AutoLinks } from './AutoLinks';
import { SourceTabs, sourceAccess, sourceChat, sourceConnected, sourceIsDirect, sourceMatches, sourceTitle } from './Conversations';
import { ActionMessages, Button, Drawer, EmptyState, Field, Icon, Notice, PageHeading } from './ui';
const modes: Record<ReactionMode, string> = { off: 'Выключено', mention: 'По упоминанию', all: 'Все сообщения' };

export function Access({ state, api, refresh }: { state: DashboardState; api: ReleApi; refresh: () => Promise<void> }) {
  const [platform, setPlatform] = useState<Platform>('telegram');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ endpointId: string; mode: ReactionMode } | null>(null);
  const endpoints = state.endpoints.filter(endpoint => endpoint.platform === platform && sourceMatches(endpoint, query));
  const current = state.endpoints.find(endpoint => endpoint.id === editing?.endpointId);
  return <>
    <PageHeading title="Доступ" description="Определите, какие источники могут передавать контекст и запускать Codex." />
    <SourceTabs
      platform={platform}
      onChange={setPlatform}
      id="access"
    />
    <section
      id="access-panel"
      role="tabpanel"
      aria-labelledby={`access-${platform}`}
    >
      <div className="toolbar">
        <label className="search-field">
          <Icon name="search" />
          <input
            aria-label="Найти источник доступа"
            placeholder="Название чата или темы"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="table-panel">
        {endpoints.length ? <div className="table-wrap">
          <table className="source-table access-table">
            <thead>
              <tr>
                <th scope="col">Группа / чат</th>
                <th scope="col">Тема / обсуждение</th>
                <th scope="col">Доступ</th>
                <th scope="col">
                  <span className="sr-only">Изменить</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map(endpoint => {
                const policy = sourceAccess(state, endpoint);
                return <tr key={endpoint.id}>
                  <td data-label="Группа / чат">
                    <div className="cell-copy">
                      <strong>
                        {sourceChat(endpoint)}
                      </strong>
                      {!sourceConnected(state, endpoint) && <small>Источник недоступен в текущем подключении</small>}
                    </div>
                  </td>
                  <td data-label="Тема / обсуждение">
                    <div className="cell-copy">
                      <span>
                        {sourceTitle(endpoint)}
                      </span>
                      <small>
                        {endpoint.subtitle}
                      </small>
                    </div>
                  </td>
                  <td data-label="Доступ">
                    <div className="cell-copy">
                      <select
                        aria-label={`Режим для ${endpoint.title}`}
                        value={policy.mode}
                        onChange={event => setEditing({ endpointId: endpoint.id, mode: event.target.value as ReactionMode })}
                      >
                        {Object.entries(modes).map(([value, label]) => <option
                          key={value}
                          value={value}
                          disabled={value !== 'off' && !sourceConnected(state, endpoint)}
                        >
                          {label}
                        </option>)}
                      </select>
                      {policy.mode !== 'off' && <small>
                        {sourceIsDirect(endpoint) ? `Разрешённых людей: ${policy.allowedSenderIds.length}` : policy.legacy ? 'Ранее сохранённый доступ' : 'Все участники, включая агентов'}
                      </small>}
                    </div>
                  </td>
                  <td className="row-action">
                    <Button aria-label={`Изменить доступ ${endpoint.title}`} onClick={() => setEditing({ endpointId: endpoint.id, mode: policy.mode })}>Изменить</Button>
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div> : <EmptyState title={query ? 'Источники не найдены' : 'Нет обнаруженных источников'}>
          {query ? 'Попробуйте другое название чата или темы.' : 'Источники появляются после регистрации или обнаружения в каталоге мессенджера. У новых источников доступ выключен.'}
        </EmptyState>}
        <footer className="table-footer">
          <span>
            Источников:{' '}
            {endpoints.length}
          </span>
          <span>Выключенный источник не передаёт новые запросы и контекст</span>
        </footer>
      </div>
    </section>
    <AutoLinks
      state={state}
      api={api}
      refresh={refresh}
    />
    {current && <Drawer title={`Доступ: ${sourceTitle(current)}`} onClose={() => setEditing(null)}>
      <SourceAccessEditor
        key={current.id}
        endpoint={current}
        state={state}
        api={api}
        refresh={refresh}
        initialMode={editing!.mode}
        onSaved={() => setEditing(null)}
      />
    </Drawer>}
  </>;
}

function SourceAccessEditor({ endpoint, state, api, refresh, initialMode, onSaved }: { endpoint: Endpoint; state: DashboardState; api: ReleApi; refresh: () => Promise<void>; initialMode: ReactionMode; onSaved: () => void }) {
  const policy = sourceAccess(state, endpoint);
  const [mode, setMode] = useState<ReactionMode>(initialMode);
  const [people, setPeople] = useState(policy.allowedSenderIds);
  const action = useAction();
  const direct = sourceIsDirect(endpoint);
  const connected = sourceConnected(state, endpoint);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (direct && mode !== 'off' && !people.length) {
      action.setError('Разрешите хотя бы одного человека для личного чата.');
      return;
    }
    const result = await action.run(() => api.request(`/api/endpoints/${encodeURIComponent(endpoint.id)}/access`, 'PUT', { mode, ...(direct && mode !== 'off' ? { allowedSenderIds: people } : {}) }));
    if (result.ok) {
      await refresh();
      onSaved();
    }
  };
  return <form className="form-stack" onSubmit={save}>
    <p className="muted">
      {sourceChat(endpoint)}
      {' · '}
      {sourceTitle(endpoint)}
    </p>
    <Field label="Режим реакции">
      <select
        value={mode}
        disabled={action.busy}
        onChange={event => setMode(event.target.value as ReactionMode)}
      >
        {Object.entries(modes).map(([value, label]) => <option
          key={value}
          value={value}
          disabled={value !== 'off' && !connected}
        >
          {label}
        </option>)}
      </select>
    </Field>
    {!connected && <Notice tone="warning">Для включения доступа нужен доступный источник текущего подключённого бота. Выключить доступ можно сейчас.</Notice>}
    {mode === 'off' ? <p className="field-hint">Новые сообщения этого источника не запускают запросы и не передаются как контекст. Уже принятые задачи сохраняются.</p> : <>
      <p className="field-hint">
        {mode === 'mention' ? 'Новый запрос запускается по настоящему упоминанию подключённого агента.' : 'Каждое разрешённое новое сообщение запускает запрос.'}{' '}
        Назначение разговора Codex задаётся на странице «Связи».
      </p>
      {direct ? <AllowedSenders
        endpoint={endpoint}
        accountId={state.connections[endpoint.platform].accountId}
        api={api}
        refresh={refresh}
        value={people}
        onChange={setPeople}
        disabled={action.busy || !connected}
        humansOnly
      /> : <Notice tone="info">Все участники этой группы или канала, включая агентов, смогут запускать запросы в выбранном режиме.</Notice>}
      {!direct && policy.legacy && <Notice tone="warning">Сохранение заменит прежний доступ выбранным режимом для всех участников этого источника.</Notice>}
    </>}
    <ActionMessages error={action.error} success={action.success} />
    <div>
      <Button
        type="submit"
        variant="primary"
        busy={action.busy}
        disabled={mode !== 'off' && !connected}
      >Сохранить доступ</Button>
    </div>
  </form>;
}
