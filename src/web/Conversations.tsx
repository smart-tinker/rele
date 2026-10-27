import { useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AutoLinkIntent, CodexThread, Conversation, DashboardState, Endpoint, Platform, ReactionMode, SourceAccess } from '../shared/types';
import { ReleApi, safeHref } from './client';
import { useAction } from './hooks';
import { useCodexThreads } from './useCodexThreads';
import { SlackSyncJournal } from './SlackSyncJournal';
import { AllowedSenders, SlackCatalogPicker, TelegramCatalogPicker } from './CatalogPicker';
import { AutoLinks } from './AutoLinks';
import { ActionMessages, Button, ClearableInput, Drawer, EmptyState, Field, Icon, Notice, PageHeading, PlatformIcon, Status } from './ui';
const modes: Record<ReactionMode, string> = { off: 'Выключено', mention: 'По упоминанию', all: 'Все сообщения' };

export const platformLabel = (platform: Platform) => platform === 'telegram' ? 'Telegram' : 'Slack';
export const sourceIsDirect = (endpoint: Endpoint) => endpoint.platform === 'slack' ? endpoint.chatId.startsWith('D') : /^\d+$/u.test(endpoint.chatId);
export const sourceConversation = (state: DashboardState, endpointId: string) => state.conversations.find(conversation => conversation.bindings.some(binding => binding.endpointId === endpointId));

export function sourceAccess(state: DashboardState, endpoint: Endpoint): SourceAccess {
  const saved = state.sourceAccess?.find(access => access.endpointId === endpoint.id);
  if (saved) return saved;
  const binding = sourceConversation(state, endpoint.id)?.bindings.find(binding => binding.endpointId === endpoint.id);
  return { endpointId: endpoint.id, mode: binding ? binding.requireMention ? 'mention' : 'all' : 'off', allowedSenderIds: binding?.allowedSenderIds ?? [], legacy: !!binding };
}
export const sourceTitle = (endpoint: Endpoint) => endpoint.topicTitle && endpoint.title === `${endpoint.chatTitle} / ${endpoint.topicTitle}` ? endpoint.topicTitle : endpoint.title || endpoint.topicTitle || 'Обсуждение';
export const sourceChat = (endpoint: Endpoint) => endpoint.chatTitle || (sourceIsDirect(endpoint) ? 'Личный чат' : endpoint.title);
export const sourceMatches = (endpoint: Endpoint, query: string, extra = '') => `${sourceChat(endpoint)} ${sourceTitle(endpoint)} ${endpoint.subtitle} ${extra}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'));
export const sourceConnected = (state: DashboardState, endpoint: Endpoint) => state.connections[endpoint.platform].connected && state.connections[endpoint.platform].accountId === endpoint.accountId && endpoint.available !== false;

export function SourceTabs({ platform, onChange, id }: { platform: Platform; onChange: (platform: Platform) => void; id: string }) {
  const platforms: Platform[] = ['telegram', 'slack'];
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? 1 - index : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onChange(platforms[next]);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return <div
    className="source-tabs"
    role="tablist"
    aria-label="Мессенджер источников"
  >
    {platforms.map((item, index) => <button
      key={item}
      id={`${id}-${item}`}
      role="tab"
      aria-selected={platform === item}
      aria-controls={`${id}-panel`}
      tabIndex={platform === item ? 0 : -1}
      className={`source-tab ${platform === item ? 'active' : ''}`}
      onClick={() => onChange(item)}
      onKeyDown={event => move(event, index)}
    >
      <PlatformIcon platform={item} />
      {platformLabel(item)}
    </button>)}
  </div>;
}

export function Conversations({ state, api, refresh, onNavigate }: {
  state: DashboardState; api: ReleApi; refresh: () => Promise<void>; onNavigate: (view: 'connections' | 'codex') => void;
}) {
  const [platform, setPlatform] = useState<Platform>('telegram');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [automatic, setAutomatic] = useState<Endpoint | null>(null);
  const [recovery, setRecovery] = useState<{ endpoint: Endpoint; intent: AutoLinkIntent; thread: CodexThread } | null>(null);
  const action = useAction();
  const catalog = useCodexThreads(api, state);
  const endpoints = state.endpoints.filter(endpoint => endpoint.platform === platform);
  const filtered = endpoints.filter(endpoint => {
    const conversation = sourceConversation(state, endpoint.id);
    return sourceMatches(endpoint, query, `${conversation?.name ?? ''} ${conversation?.cwd ?? ''}`);
  });
  const current = state.endpoints.find(endpoint => endpoint.id === editing);
  return <>
    <PageHeading title="Связи" description="Назначьте разговор Codex и доступ каждому источнику. Несколько чатов могут использовать общий контекст." />
    <SourceTabs
      platform={platform}
      onChange={setPlatform}
      id="links"
    />
    <section
      id="links-panel"
      role="tabpanel"
      aria-labelledby={`links-${platform}`}
    >
      <div className="toolbar">
        <div className="search-field">
          <Icon name="search" />
          <ClearableInput
            clearLabel="Очистить поиск источников"
            onClear={() => setQuery('')}
            aria-label="Найти группу или тред"
            placeholder="Название чата или темы"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </div>
        <div className="inline-controls">
          <Button
            icon="refresh"
            busy={action.busy}
            onClick={() => void action.run(async () => {
              catalog.reload(true);
              await refresh();
            })}
          >Обновить</Button>
          <Button
            icon="plus"
            disabled={!state.connections[platform].connected}
            onClick={() => setDiscovering(true)}
          >Найти источники</Button>
        </div>
      </div>
      {catalog.error && <Notice>
        {catalog.error}{' '}
        <button className="text-button" onClick={() => onNavigate('codex')}>Настроить Codex</button>
      </Notice>}
      {!state.codex.connected && <Notice tone="warning">
        Codex не подключён. Сохранённые назначения показаны ниже.{' '}
        <button className="text-button" onClick={() => onNavigate('codex')}>Настроить Codex</button>
      </Notice>}
      <ActionMessages error={action.error} success={action.success} />
      <div className="table-panel">
        {filtered.length ? <div className="table-wrap">
          <table className="source-table" aria-label={`Связи ${platformLabel(platform)}`}>
            <thead>
              <tr>
                <th scope="col">Группа / чат</th>
                <th scope="col">Тема / обсуждение</th>
                <th scope="col">Разговор Codex</th>
                <th scope="col">Доступ</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(endpoint => <SourceRow
                key={endpoint.id}
                endpoint={endpoint}
                state={state}
                api={api}
                refresh={refresh}
                catalog={catalog}
                onDetails={() => setEditing(endpoint.id)}
                onAutomatic={() => setAutomatic(endpoint)}
                onRecovery={(intent, thread) => setRecovery({ endpoint, intent, thread })}
              />)}
            </tbody>
          </table>
        </div> : <EmptyState title={query ? 'Источники не найдены' : `Нет источников ${platformLabel(platform)}`} action={query ? <Button onClick={() => setQuery('')}>Сбросить поиск</Button> : <Button onClick={() => state.connections[platform].connected ? setDiscovering(true) : onNavigate('connections')}>
          {state.connections[platform].connected ? 'Найти источники' : 'Подключить мессенджер'}
        </Button>}>
          {query ? 'Попробуйте другое название чата, темы или разговора Codex.' : platform === 'slack' ? 'Откройте каталог Slack или отправьте сообщение в нужном обсуждении. Найденные источники появятся здесь.' : 'Отправьте боту /rele_register в нужном чате или теме и обновите список.'}
        </EmptyState>}
        <footer className="table-footer">
          <span>
            Источников:{' '}
            {filtered.length}
            {query && ` из ${endpoints.length}`}
          </span>
          <span>Смена назначения действует только для будущих запросов</span>
        </footer>
      </div>
      <p className="field-hint">
        У новых источников доступ выключен. Назначение Codex и доступ можно менять независимо в этой таблице.
      </p>
    </section>
    <AutoLinks state={state} api={api} refresh={refresh} />
    {discovering && <Drawer title={`Источники ${platformLabel(platform)}`} onClose={() => setDiscovering(false)}>
      <p className="muted">Выберите реальный чат и обсуждение из каталога. Найденные обсуждения появятся в таблице.</p>
      {platform === 'slack' ? <SlackCatalogPicker
        state={state}
        api={api}
        refresh={refresh}
        value=""
        disabled={false}
        onChange={async endpoint => {
          if (endpoint) {
            await refresh();
            setDiscovering(false);
            setEditing(endpoint.id);
          }
        }}
      /> : <TelegramCatalogPicker
        state={state}
        api={api}
        refresh={refresh}
        value=""
        disabled={false}
        onChange={async endpoint => {
          if (endpoint) {
            await refresh();
            setDiscovering(false);
            setEditing(endpoint.id);
          }
        }}
      />}
    </Drawer>}
    {current && <Drawer title={sourceTitle(current)} onClose={() => setEditing(null)}>
      <SourceDetails
        key={current.id}
        endpoint={current}
        state={state}
        api={api}
        refresh={refresh}
      />
    </Drawer>}
    {recovery && <Drawer title="Продолжение сохранённых запросов" onClose={() => setRecovery(null)}>
      <RecoverSource
        endpoint={recovery.endpoint}
        intent={recovery.intent}
        thread={recovery.thread}
        api={api}
        refresh={refresh}
        onSaved={() => setRecovery(null)}
      />
    </Drawer>}
    {automatic && <Drawer title="Новый Codex для источника" onClose={() => setAutomatic(null)}>
      <AutomaticSource
        endpoint={automatic}
        api={api}
        refresh={refresh}
        onSaved={() => setAutomatic(null)}
      />
    </Drawer>}
  </>;
}

function SourceRow({ endpoint, state, api, refresh, catalog, onDetails, onAutomatic, onRecovery }: {
  endpoint: Endpoint; state: DashboardState; api: ReleApi; refresh: () => Promise<void>; catalog: ReturnType<typeof useCodexThreads>; onDetails: () => void; onAutomatic: () => void; onRecovery: (intent: AutoLinkIntent, thread: CodexThread) => void;
}) {
  const action = useAction();
  const conversation = sourceConversation(state, endpoint.id);
  const route = state.sourceRoutes?.find(route => route.endpointId === endpoint.id);
  const value = conversation?.threadId ?? (route?.mode === 'auto' ? 'auto' : '');
  const intent = state.autoLinks?.find(intent => intent.endpointId === endpoint.id && intent.status !== 'completed');
  const recoverable = !!intent && (['uncertain', 'failed'].includes(intent.status) || intent.status === 'created' && !!intent.error && !!intent.threadId);
  const creating = intent && !recoverable && ['pending', 'creating', 'created'].includes(intent.status);
  const unresolved = recoverable ? intent : undefined;
  const locked = !!creating || state.requests.some(request => request.origin.endpointId === endpoint.id && !['completed', 'failed', 'interrupted', 'cancelled'].includes(request.status));
  const connected = sourceConnected(state, endpoint);
  const href = safeHref(endpoint.url);
  const change = async (threadId: string) => {
    if (unresolved) {
      const thread = catalog.threads.find(thread => thread.id === threadId);
      if (thread) onRecovery(unresolved, thread);
      return;
    }
    if (threadId === 'auto') {
      onAutomatic();
      return;
    }
    const result = await action.run(() => api.request(`/api/endpoints/${encodeURIComponent(endpoint.id)}/route`, 'PUT', { threadId: threadId || null }), threadId ? 'Назначение сохранено для будущих запросов.' : 'Источник отвязан.');
    if (result.ok) await refresh();
  };
  return <tr>
    <td data-label="Группа / чат">
      <div className="cell-copy">
        <strong>
          {sourceChat(endpoint)}
        </strong>
        <small>
          {sourceIsDirect(endpoint) ? 'Личный чат' : platformLabel(endpoint.platform)}
        </small>
        {!connected && <Status tone="warning">
          {state.connections[endpoint.platform].accountId && state.connections[endpoint.platform].accountId !== endpoint.accountId ? 'Другое подключение' : endpoint.available === false ? 'Источник недоступен' : 'Нет соединения'}
        </Status>}
      </div>
    </td>
    <td data-label="Тема / обсуждение">
      <div className="cell-copy">
        {href ? <a
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          {sourceTitle(endpoint)}
        </a> : <span>
          {sourceTitle(endpoint)}
        </span>}
        <small>
          {endpoint.subtitle}
        </small>
        <Button aria-label={`Настройки источника ${endpoint.title}`} onClick={onDetails}>Сведения</Button>
      </div>
    </td>
    <td data-label="Разговор Codex">
      <div className="form-stack source-routing">
        <select
          aria-label={`Разговор Codex для ${endpoint.title}`}
          value={value}
          disabled={action.busy || locked}
          onChange={event => void change(event.target.value)}
        >
          <option value="" disabled={!!unresolved}>Не связан</option>
          <option value="auto" disabled={!connected || !!unresolved}>Создать при первом запросе…</option>
          {conversation && !catalog.threads.some(thread => thread.id === conversation.threadId) && <option value={conversation.threadId} disabled>
            {conversation.name}
            {conversation.cwd ? ` · ${conversation.cwd}` : ''}
          </option>}
          {catalog.threads.map(thread => <option
            key={thread.id}
            value={thread.id}
            disabled={!connected || !catalog.ready || thread.archived || !!unresolved?.threadId && unresolved.threadId !== thread.id}
          >
            {thread.name || 'Без названия'}
            {thread.cwd ? ` · ${thread.cwd}` : ''}
            {thread.archived ? ' · Архив' : ''}
          </option>)}
        </select>
        {locked ? <p className="field-hint">{creating ? 'Дождитесь завершения автосоздания' : 'Сначала завершите или отмените запросы этого источника.'}</p> : null}
        {unresolved && <p className="field-hint">Автосоздание не завершено. Выберите существующий разговор для сохранённых запросов.{unresolved.threadId ? ' Допустим только уже созданный разговор.' : ''} Рабочая папка должна совпадать с сохранённой.</p>}
        {route?.mode === 'auto' && route.cwd && <small className="field-hint">
          Новый разговор:{' '}
          {route.cwd}
        </small>}
        {conversation?.paused && <Status tone="warning">Общий разговор на паузе</Status>}
        <ActionMessages error={action.error} success={action.success} />
      </div>
    </td>
    <td data-label="Доступ">
      <SourceAccessControls endpoint={endpoint} state={state} api={api} refresh={refresh} />
    </td>
  </tr>;
}

function RecoverSource({ endpoint, intent, thread, api, refresh, onSaved }: {
  endpoint: Endpoint; intent: AutoLinkIntent; thread: CodexThread; api: ReleApi; refresh: () => Promise<void>; onSaved: () => void;
}) {
  const action = useAction();
  const recover = async () => {
    const result = await action.run(() => api.request(`/api/endpoints/${encodeURIComponent(endpoint.id)}/route`, 'PUT', {
      threadId: thread.id,
      resolveAutoLinkId: intent.id,
    }));
    if (result.ok) { await refresh(); onSaved(); }
  };
  return <div className="form-stack">
    <Notice tone="warning">Уже принятые сообщения из «{sourceTitle(endpoint)}» будут выполнены в выбранном разговоре Codex. Действие восстанавливает незавершённое автосоздание.</Notice>
    <h3>{thread.name || 'Без названия'}</h3>
    <div className="selected-path">Рабочая папка Codex<span>{thread.cwd}</span></div>
    <p className="field-hint">Рабочая папка должна совпадать с сохранённой: {intent.rule.cwd}.</p>
    <ActionMessages error={action.error} success={action.success} />
    <div><Button variant="primary" busy={action.busy} onClick={() => void recover()}>Продолжить сохранённые запросы</Button></div>
  </div>;
}

function AutomaticSource({ endpoint, api, refresh, onSaved }: { endpoint: Endpoint; api: ReleApi; refresh: () => Promise<void>; onSaved: () => void }) {
  const [cwd, setCwd] = useState('');
  const action = useAction();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const result = await action.run(() => api.request(`/api/endpoints/${encodeURIComponent(endpoint.id)}/route`, 'PUT', { autoCreateCwd: cwd.trim() }));
    if (result.ok) {
      await refresh();
      onSaved();
    }
  };
  return <form className="form-stack" onSubmit={save}>
    <p className="muted">
      Первый разрешённый запрос из «
      {sourceTitle(endpoint)}
      » создаст отдельный разговор Codex. Доступ к запуску задаётся в колонке «Доступ».
    </p>
    <Field label="Рабочая папка нового разговора" hint="Абсолютный путь на компьютере, где работает Codex.">
      <input
        autoFocus
        value={cwd}
        required
        maxLength={4096}
        onChange={event => setCwd(event.target.value)}
        disabled={action.busy}
        placeholder="C:\Projects\app или /srv/projects/app"
      />
    </Field>
    <ActionMessages error={action.error} success={action.success} />
    <div>
      <Button
        type="submit"
        variant="primary"
        busy={action.busy}
        disabled={!cwd.trim()}
      >Сохранить назначение</Button>
    </div>
  </form>;
}

function SourceDetails({ endpoint, state, api, refresh }: { endpoint: Endpoint; state: DashboardState; api: ReleApi; refresh: () => Promise<void> }) {
  const conversation = sourceConversation(state, endpoint.id);
  const action = useAction();
  const initialMessage = useAction();
  const pause = async (value: Conversation) => {
    const result = await action.run(() => api.request(`/api/conversations/${encodeURIComponent(value.id)}`, 'PATCH', { paused: !value.paused }), value.paused ? 'Общий разговор возобновлён.' : 'Общий разговор приостановлен.');
    if (result.ok) await refresh();
  };
  return <div className="form-stack">
    <p className="muted">
      {sourceChat(endpoint)}
      {' · '}
      {sourceTitle(endpoint)}
    </p>
    <EndpointNameEditor
      endpoint={endpoint}
      api={api}
      refresh={refresh}
      disabled={false}
    />
    {conversation && <section className="form-section form-stack">
      <h3>
        {conversation.name}
      </h3>
      <div className="selected-path">
        Рабочая папка Codex
        <span>
          {conversation.cwd || 'Не указана'}
        </span>
      </div>
      <Status tone={conversation.paused ? 'warning' : 'good'}>
        {conversation.paused ? 'Общий разговор приостановлен' : 'Общий разговор активен'}
      </Status>
      <p className="field-hint">Пауза действует на все источники этого разговора Codex. Текущий запрос можно отменить в очереди.</p>
      <div>
        <Button
          icon={conversation.paused ? 'play' : 'pause'}
          busy={action.busy}
          onClick={() => void pause(conversation)}
        >
          {conversation.paused ? 'Возобновить общий разговор' : 'Приостановить общий разговор'}
        </Button>
      </div>
      <ActionMessages error={action.error} success={action.success} />
      <div>
        <Button
          icon="send"
          busy={initialMessage.busy}
          onClick={() => void initialMessage.run(() => api.request<{ status: 'queued'; operationId: string }>(`/api/conversations/${encodeURIComponent(conversation.id)}/initial-message`, 'POST'), 'Первичное сообщение поставлено в очередь.')}
        >Послать первичное сообщение</Button>
      </div>
      <p className="field-hint">Добавит инструкции Rele в этот разговор Codex. Доступ и назначения источников сохранятся.</p>
      <ActionMessages error={initialMessage.error} success={initialMessage.success} />
    </section>}
    {conversation && <SlackSyncJournal api={api} conversationId={conversation.id} platform={endpoint.platform} />}
  </div>;
}

function EndpointNameEditor({ endpoint, api, refresh, disabled }: { endpoint: Endpoint; api: ReleApi; refresh: () => Promise<void>; disabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(endpoint.title);
  const action = useAction();
  const save = async (next: string) => {
    const result = await action.run(() => api.request(`/api/endpoints/${encodeURIComponent(endpoint.id)}`, 'PATCH', { title: next }));
    if (result.ok) {
      await refresh();
      setEditing(false);
    }
  };
  return <div className="endpoint-name-editor">
    {editing ? <><Field label="Название чата в Rele" hint="Это название видно только в Rele.">
      <input
        autoFocus
        value={title}
        maxLength={200}
        disabled={disabled || action.busy}
        onChange={event => setTitle(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (title.trim() && !disabled) void save(title.trim());
          }
        }}
      />
    </Field><div className="form-actions">
        <Button
          busy={action.busy}
          disabled={disabled || !title.trim()}
          onClick={() => void save(title.trim())}
        >Сохранить имя чата</Button>
        <Button
          busy={action.busy}
          disabled={disabled}
          onClick={() => void save('')}
        >Имя из мессенджера</Button>
        <Button disabled={disabled || action.busy} onClick={() => setEditing(false)}>Закрыть поле</Button>
      </div><ActionMessages error={action.error} success="" /></> : <button
        type="button"
        className="text-button"
        aria-label={`Изменить название разговора ${platformLabel(endpoint.platform)} только в Rele`}
        disabled={disabled}
        onClick={() => {
          setTitle(endpoint.title);
          action.setError('');
          setEditing(true);
        }}
      >Изменить название только в Rele</button>}
  </div>;
}

function SourceAccessControls({ endpoint, state, api, refresh }: { endpoint: Endpoint; state: DashboardState; api: ReleApi; refresh: () => Promise<void> }) {
  const policy = sourceAccess(state, endpoint);
  const [pendingMode, setPendingMode] = useState<ReactionMode | null>(null);
  const [savingPeople, setSavingPeople] = useState<string[] | null>(null);
  const [showPeople, setShowPeople] = useState(false);
  const action = useAction();
  const direct = sourceIsDirect(endpoint);
  const connected = sourceConnected(state, endpoint);
  const mode = pendingMode ?? policy.mode;
  const save = async (nextMode: ReactionMode, people?: string[]) => {
    if (direct && nextMode !== 'off' && !(people ?? policy.allowedSenderIds).length) {
      setPendingMode(nextMode);
      setShowPeople(true);
      action.setError('Разрешите хотя бы одного человека для личного чата.');
      return;
    }
    setPendingMode(nextMode);
    setSavingPeople(people ?? null);
    await action.run(async () => {
      await api.request(`/api/endpoints/${encodeURIComponent(endpoint.id)}/access`, 'PUT', { mode: nextMode, ...(people === undefined ? {} : { allowedSenderIds: people }) });
      await refresh();
    }, 'Доступ сохранён.');
    setPendingMode(null);
    setSavingPeople(null);
  };
  return <div className="cell-copy source-access" aria-busy={action.busy}>
    <select
      aria-label={`Режим для ${endpoint.title}`}
      value={mode}
      disabled={action.busy}
      onChange={event => void save(event.target.value as ReactionMode)}
    >
      {Object.entries(modes).map(([value, label]) => <option key={value} value={value} disabled={value !== 'off' && !connected}>{label}</option>)}
    </select>
    <small>{policy.mode === 'off' ? 'Доступ выключен' : direct ? `Разрешённых людей: ${policy.allowedSenderIds.length}` : policy.legacy ? 'Ранее сохранённый доступ' : 'Все участники, включая агентов'}</small>
    {mode === 'mention' && <small>Запуск по упоминанию подключённого агента.</small>}
    {!direct && policy.legacy && <small>После смены режима доступ определяется выбранным вариантом для всех участников, включая агентов.</small>}
    {direct && <>
      <Button
        aria-label={`Разрешённые люди для ${endpoint.title}`}
        aria-expanded={showPeople}
        aria-controls={`source-people-${endpoint.id}`}
        disabled={action.busy}
        onClick={() => {
          if (showPeople) {
            setPendingMode(null);
            action.setError('');
          }
          setShowPeople(value => !value);
        }}
      >{showPeople ? 'Скрыть людей' : 'Разрешённые люди'}</Button>
      {showPeople && <div className="source-people" id={`source-people-${endpoint.id}`}>
        {mode === 'off' && <p className="field-hint">Выберите режим доступа, чтобы изменить список людей.</p>}
        <AllowedSenders
          endpoint={endpoint}
          accountId={state.connections[endpoint.platform].accountId}
          api={api}
          refresh={refresh}
          value={savingPeople ?? policy.allowedSenderIds}
          onChange={people => void save(mode, people)}
          disabled={action.busy || !connected || mode === 'off'}
          humansOnly
        />
      </div>}
    </>}
    <ActionMessages error={action.error} success={action.error ? '' : action.success} />
  </div>;
}
