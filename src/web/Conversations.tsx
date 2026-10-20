import { useMemo, useState, type FormEvent } from 'react';
import type {
  Binding,
  Conversation,
  DashboardState,
  Endpoint,
  Platform,
} from '../shared/types';
import { ReleApi, safeHref } from './client';
import { useAction } from './hooks';
import { useCodexThreads } from './useCodexThreads';
import { SlackSyncJournal } from './SlackSyncJournal';
import {
  AllowedSenders,
  SlackCatalogPicker,
  TelegramCatalogPicker,
} from './CatalogPicker';
import {
  ActionMessages,
  Button,
  Drawer,
  EmptyState,
  Field,
  Icon,
  Notice,
  PageHeading,
  PlatformIcon,
  Status,
} from './ui';

const platforms: Platform[] = ['telegram', 'slack'];
const platformLabel = (platform: Platform) =>
  platform === 'telegram' ? 'Telegram' : 'Slack';
interface BindingDraft {
  endpointId: string;
  allowedSenderIds: string[];
  allowAllSenders?: boolean;
  requireMention?: boolean;
}
const emptyBinding = (): BindingDraft => ({
  endpointId: '',
  allowedSenderIds: [],
});

export function Conversations({
  state,
  api,
  refresh,
  onNavigate,
}: {
  state: DashboardState;
  api: ReleApi;
  refresh: () => Promise<void>;
  onNavigate: (view: 'connections' | 'codex') => void;
}) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const endpoints = useMemo(
    () => new Map(state.endpoints.map((item) => [item.id, item])),
    [state.endpoints],
  );
  const filtered = state.conversations.filter((conversation) => {
    const names = conversation.bindings
      .map((binding) => {
        const endpoint = endpoints.get(binding.endpointId);
        return `${endpoint?.title ?? ''} ${endpoint?.subtitle ?? ''}`;
      })
      .join(' ');
    return `${conversation.name} ${conversation.cwd} ${names}`
      .toLocaleLowerCase('ru')
      .includes(query.toLocaleLowerCase('ru').trim());
  });
  const current = state.conversations.find((item) => item.id === editing);

  const bindingCell = (binding: Binding, platform: Platform) => {
    const endpoint = binding && endpoints.get(binding.endpointId);
    if (!endpoint)
      return (
        <div className="cell-copy cell-muted">
          <span>Разговор недоступен</span>
          <small>Проверьте подключение</small>
        </div>
      );
    const href = safeHref(endpoint.url);
    return (
      <div className="platform-cell">
        <PlatformIcon platform={platform} />
        <div className="cell-copy">
          {href ? (
            <a href={href} target="_blank" rel="noreferrer">
              {endpoint.title}
            </a>
          ) : (
            <span>{endpoint.title}</span>
          )}
          <small>{endpoint.subtitle || platformLabel(platform)}</small>
        </div>
      </div>
    );
  };

  const connectionCell = (conversation: Conversation, platform: Platform) => {
    const bindings = conversation.bindings.filter(item => item.platform === platform);
    return bindings.length ? <div className="binding-cells">{bindings.map(binding => <div key={binding.id}>{bindingCell(binding, platform)}</div>)}</div>
      : <div className="cell-copy cell-muted"><span>—</span><small>Не подключён</small></div>;
  };

  const conversationStatus = (conversation: Conversation) => {
    if (conversation.paused) return <Status>Пауза</Status>;
    const active = state.requests.find(
      (request) =>
        request.conversationId === conversation.id &&
        [
          'queued',
          'starting',
          'running',
          'transcribing',
          'waiting_approval',
          'uncertain',
        ].includes(request.status),
    );
    if (active?.status === 'waiting_approval')
      return <Status tone="warning">Подтверждение</Status>;
    if (active?.status === 'uncertain')
      return <Status tone="warning">Нужно проверить</Status>;
    if (active?.status === 'queued') return <Status>В очереди</Status>;
    if (active) return <Status tone="good">Выполняется</Status>;
    if (!state.codex.connected)
      return <Status tone="warning">Codex недоступен</Status>;
    if (!state.codex.queueSupported)
      return <Status tone="warning">Очередь недоступна</Status>;
    if (!conversation.bindings.length) return <Status>Нет подключений</Status>;
    return <Status tone="good">Готова</Status>;
  };

  return (
    <>
      <PageHeading
        title="Связки"
        description="Общий контекст Codex. Ответ — в исходный чат."
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setEditing('new')}
          >
            Новая связка
          </Button>
        }
      />
      <div className="toolbar">
        <label className="search-field">
          <Icon name="search" />
          <input
            aria-label="Найти связку или чат"
            placeholder="Найти связку или чат"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Button
          icon="refresh"
          busy={refreshing}
          onClick={async () => {
            setRefreshing(true);
            await refresh();
            setRefreshing(false);
          }}
        >
          Обновить
        </Button>
      </div>
      <div className="table-panel">
        {filtered.length ? (
          <div className="table-wrap">
            <table className="conversation-table">
              <thead>
                <tr>
                  <th scope="col">Связка / Codex</th>
                  <th scope="col">Telegram</th>
                  <th scope="col">Slack</th>
                  <th scope="col">Состояние</th>
                  <th scope="col">
                    <span className="sr-only">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((conversation) => (
                  <tr key={conversation.id}>
                    <td data-label="Связка / Codex">
                      <div className="cell-copy">
                        <strong>{conversation.name}</strong>
                        <small title={conversation.cwd}>
                          {conversation.cwd || 'Рабочая папка не указана'}
                        </small>
                      </div>
                    </td>
                    <td data-label="Telegram">
                      {connectionCell(conversation, 'telegram')}
                    </td>
                    <td data-label="Slack">
                      {connectionCell(conversation, 'slack')}
                    </td>
                    <td data-label="Состояние">
                      {conversationStatus(conversation)}
                    </td>
                    <td className="row-action">
                      <Button
                        onClick={() => setEditing(conversation.id)}
                        aria-label={`Открыть связку ${conversation.name}`}
                      >
                        Открыть
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={query ? 'Связки не найдены' : 'Создайте первую связку'}
            action={
              query ? (
                <Button onClick={() => setQuery('')}>Сбросить поиск</Button>
              ) : (
                <Button
                  variant="primary"
                  icon="plus"
                  onClick={() => setEditing('new')}
                >
                  Новая связка
                </Button>
              )
            }
          >
            {query
              ? 'Попробуйте другое название проекта, канала или разговора.'
              : 'Подключите Codex и мессенджеры, затем выберите разговоры по названиям.'}
          </EmptyState>
        )}
        <footer className="table-footer">
          <span>
            Связок: {filtered.length}
            {query && ` из ${state.conversations.length}`}
          </span>
          <span>Названия обновляются из подключений</span>
        </footer>
      </div>
      <section className="setup-guide" aria-labelledby="setup-title">
        <h2 id="setup-title">Как связать разговоры</h2>
        <ol>
          <li>
            <span>1</span>
            <button onClick={() => onNavigate('connections')}>
              Подключите Codex и мессенджеры
            </button>
          </li>
          <li>
            <span>2</span>
            <button onClick={() => setEditing('new')}>
              Выберите разговоры по названиям
            </button>
          </li>
          <li>
            <span>3</span>
            <p>Разрешите отправителей</p>
          </li>
        </ol>
      </section>
      {editing === 'new' && (
        <Drawer title="Новая связка" onClose={() => setEditing(null)}>
          <NewConversation
            state={state}
            api={api}
            refresh={refresh}
            onCodex={() => onNavigate('codex')}
            onCreated={async (id) => {
              await refresh();
              setEditing(id);
            }}
          />
        </Drawer>
      )}
      {current && (
        <Drawer title={current.name} onClose={() => setEditing(null)}>
          <EditConversation
            key={current.id}
            conversation={current}
            state={state}
            api={api}
            refresh={refresh}
          />
        </Drawer>
      )}
    </>
  );
}

function BindingFields({
  platform,
  value,
  onChange,
  state,
  disabled,
  api,
  refresh,
  bindingId,
}: {
  platform: Platform;
  value: BindingDraft;
  onChange: (value: BindingDraft) => void;
  state: DashboardState;
  disabled: boolean;
  api: ReleApi;
  refresh: () => Promise<void>;
  bindingId?: string;
}) {
  const [loadedEndpoint, setLoadedEndpoint] = useState<Endpoint>();
  const endpoint =
    state.endpoints.find((item) => item.id === value.endpointId) ??
    (loadedEndpoint?.id === value.endpointId ? loadedEndpoint : undefined);
  const Picker =
    platform === 'telegram' ? TelegramCatalogPicker : SlackCatalogPicker;
  const accountId = state.connections[platform].accountId;
  const differentAccount =
    endpoint && accountId && endpoint.accountId !== accountId;
  return (
    <>
      <Picker
        // Account changes reset catalogs and abort responses from the previous bot.
        key={accountId ?? platform}
        state={state}
        api={api}
        refresh={refresh}
        value={value.endpointId}
        onChange={(next) => {
          setLoadedEndpoint(next);
          onChange({ endpointId: next?.id ?? '', allowedSenderIds: [], allowAllSenders: false, requireMention: false });
        }}
        disabled={disabled}
        bindingId={bindingId}
      />
      {value.endpointId && !endpoint && (
        <Notice tone="warning">
          Сохранённый разговор сейчас недоступен. Можно выбрать другой разговор
          или отвязать подключение.
        </Notice>
      )}
      {endpoint && (
        <>
          {(endpoint.available === false || differentAccount) && (
            <Notice tone="warning">
              Сохранённый разговор «{endpoint.title}»{' '}
              {differentAccount
                ? 'относится к другому подключению'
                : 'сейчас недоступен'}
              . Можно выбрать другой разговор или отвязать подключение.
            </Notice>
          )}
          <EndpointNameEditor
            key={`name:${endpoint.id}`}
            endpoint={endpoint}
            api={api}
            refresh={refresh}
            disabled={disabled}
          />
          {value.allowAllSenders ? <Notice tone="info">Все участники этого канала или группы, включая других агентов, могут отправлять запросы.</Notice> : <AllowedSenders
            key={`people:${accountId ?? platform}:${endpoint.id}`}
            endpoint={endpoint}
            accountId={accountId}
            api={api}
            refresh={refresh}
            value={value.allowedSenderIds}
            onChange={(allowedSenderIds) =>
              onChange({ ...value, allowedSenderIds })
            }
            disabled={disabled}
          />}
          <label className="check-row"><input type="checkbox" checked={!!value.allowAllSenders} disabled={disabled || (endpoint.platform === 'slack' ? !/^[CG][A-Z0-9]+$/u.test(endpoint.chatId) : !/^-\d+$/u.test(endpoint.chatId))} onChange={event => onChange({ ...value, allowAllSenders: event.target.checked, ...(event.target.checked ? { allowedSenderIds: [] } : {}) })} /><span>Разрешить всем участникам группы, включая агентов</span></label>
          <label className="check-row"><input type="checkbox" checked={!!value.requireMention} disabled={disabled} onChange={event => onChange({ ...value, requireMention: event.target.checked })} /><span>В группах запускать только при упоминании подключённого агента</span></label>
        </>
      )}
    </>
  );
}

function EndpointNameEditor({
  endpoint,
  api,
  refresh,
  disabled,
}: {
  endpoint: Endpoint;
  api: ReleApi;
  refresh: () => Promise<void>;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(endpoint.title);
  const action = useAction();
  const save = async (next: string) => {
    const result = await action.run(() =>
      api.request(
        `/api/endpoints/${encodeURIComponent(endpoint.id)}`,
        'PATCH',
        {
          title: next,
        },
      ),
    );
    if (result.ok) {
      await refresh();
      setEditing(false);
    }
  };
  return (
    <div className="endpoint-name-editor">
      {editing ? (
        <>
          <Field
            label="Название чата в Rele"
            hint="Это название видно только в Rele. Можно дать теме удобное, узнаваемое имя."
          >
            <input
              autoFocus
              value={title}
              maxLength={200}
              disabled={disabled || action.busy}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.stopPropagation();
                  if (title.trim() && !disabled) void save(title.trim());
                }
              }}
            />
          </Field>
          <div className="form-actions">
            <Button
              busy={action.busy}
              disabled={disabled || !title.trim()}
              onClick={() => void save(title.trim())}
            >
              Сохранить имя чата
            </Button>
            <Button
              busy={action.busy}
              disabled={disabled}
              onClick={() => void save('')}
            >
              Имя из мессенджера
            </Button>
            <Button
              disabled={disabled || action.busy}
              onClick={() => setEditing(false)}
            >
              Закрыть поле
            </Button>
          </div>
          <ActionMessages error={action.error} success="" />
        </>
      ) : (
        <button
          type="button"
          className="text-button"
          aria-label={`Изменить название разговора ${platformLabel(endpoint.platform)} только в Rele`}
          disabled={disabled}
          onClick={() => {
            setTitle(endpoint.title);
            action.setError('');
            setEditing(true);
          }}
        >
          Изменить название только в Rele
        </button>
      )}
    </div>
  );
}

function NewConversation({
  state,
  api,
  refresh,
  onCreated,
  onCodex,
}: {
  state: DashboardState;
  api: ReleApi;
  refresh: () => Promise<void>;
  onCreated: (id: string) => Promise<void>;
  onCodex: () => void;
}) {
  const [name, setName] = useState('');
  const [threadId, setThreadId] = useState('');
  const [bindings, setBindings] = useState<Record<Platform, BindingDraft[]>>({
    telegram: [emptyBinding()],
    slack: [emptyBinding()],
  });
  const action = useAction();
  const [threadQuery, setThreadQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const {
    threads,
    loading: threadsLoading,
    error: threadsError,
    ready: threadsReady,
    reload: loadThreads,
  } = useCodexThreads(api, state, includeArchived);
  const threadOwner = (id: string) =>
    state.conversations.find((item) => item.threadId === id);
  const selected = threadsReady
    ? threads.find(
        (item) =>
          item.id === threadId && !item.archived && !threadOwner(item.id),
      )
    : undefined;
  const filteredThreads = threads.filter(
    (thread) =>
      thread.id === threadId ||
      `${thread.name} ${thread.cwd} ${thread.preview}`
        .toLocaleLowerCase('ru')
        .includes(threadQuery.trim().toLocaleLowerCase('ru')),
  );
  const availableThreads = threads.filter(
    (thread) => !thread.archived && !threadOwner(thread.id),
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) {
      action.setError('Выберите разговор Codex.');
      return;
    }
    const chosen = platforms.flatMap(platform => bindings[platform]
      .filter(value => value.endpointId).map(value => ({ platform, ...value })));
    if (new Set(chosen.map(value => value.endpointId)).size !== chosen.length) {
      action.setError('Каждый разговор можно подключить только один раз.');
      return;
    }
    if (chosen.some((binding) => !binding.allowAllSenders && !binding.allowedSenderIds.length)) {
      action.setError(
        'Для каждого подключённого разговора разрешите хотя бы одного отправителя.',
      );
      return;
    }
    const result = await action.run(() =>
      api.request<{ conversation: Conversation }>(
        '/api/conversations',
        'POST',
        { name: name.trim(), threadId, cwd: selected.cwd, bindings: chosen },
      ),
    );
    if (result.ok) await onCreated(result.value.conversation.id);
  };
  return (
    <form className="form-stack" onSubmit={submit}>
      <p className="muted">
        Выберите один разговор Codex и подключите к нему нужные чаты. Ответы
        возвращаются в источник запроса.
      </p>
      <Field label="Название связки">
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={160}
          placeholder="Например, разработка приложения"
          disabled={action.busy}
        />
      </Field>
      <Field
        label="Поиск разговоров Codex"
        hint="Поиск по названию, рабочей папке и фрагменту разговора."
      >
        <input
          type="search"
          value={threadQuery}
          onChange={(event) => setThreadQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault();
          }}
          placeholder="Название, папка или текст"
          disabled={action.busy}
        />
      </Field>
      <label className="check-row">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => setIncludeArchived(event.target.checked)}
          disabled={action.busy}
        />
        <span>Показать архивные разговоры</span>
      </label>
      <Field
        label="Разговор Codex"
        hint="Показаны пользовательские разговоры. Если старого разговора нет, нажмите «Обновить разговоры» для полного перечитывания."
      >
        <select
          value={threadId}
          required
          disabled={!threadsReady || action.busy}
          onChange={(event) => {
            const thread = threads.find(
              (item) => item.id === event.target.value,
            );
            setThreadId(event.target.value);
            if (!name && thread) setName(thread.name);
          }}
        >
          <option value="">
            {threadsLoading
              ? 'Загружаем разговоры…'
              : !state.codex.connected
                ? 'Сначала подключите Codex'
                : threadsError
                  ? 'Не удалось загрузить разговоры'
                  : 'Выберите разговор по названию'}
          </option>
          {filteredThreads.map((thread) => {
            const occupied = threadOwner(thread.id);
            return (
              <option
                key={thread.id}
                value={thread.id}
                disabled={thread.archived || !!occupied}
              >
                {thread.name || 'Без названия'}
                {thread.cwd ? ` · ${thread.cwd}` : ''}
                {thread.archived ? ' · Архив' : ''}
                {occupied ? ` · В связке «${occupied.name}»` : ''}
              </option>
            );
          })}
        </select>
      </Field>
      {threadsReady && (
        <p className="field-hint">
          Свободных: {availableThreads.length}. В связках:{' '}
          {threads.filter((thread) => !!threadOwner(thread.id)).length}.
          {includeArchived
            ? ` Архивных: ${threads.filter((thread) => thread.archived).length}.`
            : ''}
        </p>
      )}
      {threadsReady && !!threadQuery && !filteredThreads.length && (
        <p className="field-hint">
          Разговоров с таким названием, папкой или текстом не найдено.
        </p>
      )}
      {includeArchived && (
        <Notice tone="info">
          Архивные разговоры доступны для просмотра. Чтобы связать такой
          разговор, сначала разархивируйте его в Codex, затем обновите список.
        </Notice>
      )}
      {selected?.preview && (
        <p className="catalog-preview">{selected.preview}</p>
      )}
      {selected?.cwd && (
        <div className="selected-path">
          Рабочая папка: <span>{selected.cwd}</span>
        </div>
      )}
      {threadsError && <Notice>{threadsError}</Notice>}
      {!state.codex.connected && (
        <Notice tone="warning">
          Codex не подключён. Откройте настройки Codex и выберите найденное
          подключение, затем вернитесь к созданию связки.
          {state.codex.error && ` ${state.codex.error}`}
        </Notice>
      )}
      {threadsReady && !availableThreads.length && (
        <Notice tone="info">
          Нет свободных разговоров Codex. Создайте разговор в Codex, затем
          обновите список.
        </Notice>
      )}
      <div>
        <Button
          icon="refresh"
          busy={threadsLoading}
          disabled={!state.codex.connected}
          onClick={() => void loadThreads(true)}
        >
          Обновить разговоры
        </Button>
        {(!state.codex.connected || threadsError) && (
          <Button onClick={onCodex}>Настроить Codex</Button>
        )}
      </div>
      {platforms.map((platform) => (
        <section className="form-section" key={platform}>
          <h3><PlatformIcon platform={platform} />{platformLabel(platform)}</h3>
          {bindings[platform].map((value, index) => (
            <div className="form-stack binding-draft" key={index}>
              {index > 0 && <h4>{platformLabel(platform)} · {index + 1}</h4>}
              <BindingFields platform={platform} value={value}
                onChange={next => setBindings(current => ({ ...current, [platform]: current[platform].map((item, position) => position === index ? next : item) }))}
                state={state} disabled={action.busy} api={api} refresh={refresh} />
              {index > 0 && <Button disabled={action.busy} onClick={() => setBindings(current => ({ ...current, [platform]: current[platform].filter((_, position) => position !== index) }))}>Убрать подключение</Button>}
            </div>
          ))}
          <Button disabled={action.busy} onClick={() => setBindings(current => ({ ...current, [platform]: [...current[platform], emptyBinding()] }))}>Добавить ещё {platformLabel(platform)}</Button>
        </section>
      ))}
      <ActionMessages error={action.error} success={action.success} />
      <div className="form-actions">
        <Button
          type="submit"
          variant="primary"
          busy={action.busy}
          disabled={!selected || !name.trim() || threadsLoading}
        >
          Создать связку
        </Button>
      </div>
    </form>
  );
}

function EditConversation({
  conversation,
  state,
  api,
  refresh,
}: {
  conversation: Conversation;
  state: DashboardState;
  api: ReleApi;
  refresh: () => Promise<void>;
}) {
  const [name, setName] = useState(conversation.name);
  const [drafts, setDrafts] = useState<Array<{ id: string; platform: Platform }>>([]);
  const [bindingMessage, setBindingMessage] = useState('');
  const action = useAction();
  const update = async (body: unknown, message: string) => {
    const result = await action.run(
      () =>
        api.request(
          `/api/conversations/${encodeURIComponent(conversation.id)}`,
          'PATCH',
          body,
        ),
      message,
    );
    if (result.ok) await refresh();
  };
  return (
    <div className="form-stack">
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void update({ name: name.trim() }, 'Название сохранено.');
        }}
      >
        <Field label="Название связки">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={160}
            required
            disabled={action.busy}
          />
        </Field>
        <div>
          <Button
            type="submit"
            busy={action.busy}
            disabled={!name.trim() || name.trim() === conversation.name}
          >
            Сохранить название
          </Button>
        </div>
      </form>
      <div className="selected-path">
        Рабочая папка Codex<span>{conversation.cwd || 'Не указана'}</span>
      </div>
      <div className="inline-controls">
        <Status tone={conversation.paused ? 'muted' : 'good'}>
          {conversation.paused ? 'Связка приостановлена' : 'Связка активна'}
        </Status>
        <Button
          icon={conversation.paused ? 'play' : 'pause'}
          busy={action.busy}
          onClick={() =>
            void update(
              { paused: !conversation.paused },
              conversation.paused
                ? 'Связка возобновлена.'
                : 'Связка приостановлена.',
            )
          }
        >
          {conversation.paused ? 'Возобновить' : 'Приостановить'}
        </Button>
      </div>
      <p className="field-hint">
        Во время паузы новые запросы не принимаются, очередь приостановлена.
        Выполняющуюся задачу можно прервать отдельно в очереди.
      </p>
      <ActionMessages error={action.error} success={action.success} />
      {bindingMessage && <p className="action-success" role="status">{bindingMessage}</p>}
      {platforms.map(platform => {
        const existing = conversation.bindings.filter(binding => binding.platform === platform);
        const pending = drafts.filter(draft => draft.platform === platform);
        return <div className="form-stack" key={platform}>
          {existing.map((binding, index) => <EditBinding key={binding.id} platform={platform}
            ordinal={index + 1} conversation={conversation} binding={binding} state={state} api={api} refresh={refresh} onSaved={setBindingMessage} />)}
          {!existing.length && !pending.length && <EditBinding key={`empty-${platform}`} platform={platform}
            conversation={conversation} state={state} api={api} refresh={refresh} onSaved={setBindingMessage} />}
          {pending.map((draft, index) => <EditBinding key={draft.id} platform={platform} ordinal={existing.length + index + 1}
            conversation={conversation} state={state} api={api} refresh={refresh}
            onSaved={message => { setBindingMessage(message); setDrafts(current => current.filter(item => item.id !== draft.id)); }}
            onDiscard={() => setDrafts(current => current.filter(item => item.id !== draft.id))} />)}
          <Button onClick={() => { setBindingMessage(''); setDrafts(current => [...current, { id: crypto.randomUUID(), platform }]); }}>Добавить ещё {platformLabel(platform)}</Button>
        </div>;
      })}
      <SlackSyncJournal api={api} conversationId={conversation.id} />
    </div>
  );
}

function EditBinding({
  platform,
  conversation,
  binding,
  state,
  api,
  refresh,
  ordinal = 1,
  onSaved,
  onDiscard,
}: {
  platform: Platform;
  ordinal?: number;
  onSaved: (message: string) => void;
  onDiscard?: () => void;
  conversation: Conversation;
  binding?: Binding;
  state: DashboardState;
  api: ReleApi;
  refresh: () => Promise<void>;
}) {
  const [value, setValue] = useState<BindingDraft>(
    binding
      ? {
          endpointId: binding.endpointId,
          allowedSenderIds: binding.allowedSenderIds,
          ...(binding.allowAllSenders !== undefined ? { allowAllSenders: binding.allowAllSenders } : {}),
          ...(binding.requireMention !== undefined ? { requireMention: binding.requireMention } : {}),
        }
      : emptyBinding(),
  );
  const action = useAction();
  const collection = `/api/conversations/${encodeURIComponent(conversation.id)}/bindings`;
  const path = binding ? `${collection}/${encodeURIComponent(binding.id)}` : collection;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (value.endpointId && !value.allowAllSenders && !value.allowedSenderIds.length) {
      action.setError('Разрешите хотя бы одного отправителя.');
      return;
    }
    const result = await action.run(
      () =>
        api.request(
          path,
          value.endpointId ? binding ? 'PUT' : 'POST' : 'DELETE',
          value.endpointId ? binding ? value : { platform, ...value } : undefined,
        ),
      value.endpointId
        ? `${platformLabel(platform)} подключён. Доступ сохранён.`
        : `${platformLabel(platform)} отвязан.`,
    );
    if (result.ok) { await refresh(); onSaved(value.endpointId ? `${platformLabel(platform)} подключён. Доступ сохранён.` : `${platformLabel(platform)} отвязан.`); }
  };
  const remove = async () => {
    const result = await action.run(
      () => api.request(path, 'DELETE'),
      `${platformLabel(platform)} отвязан.`,
    );
    if (result.ok) {
      setValue(emptyBinding());
      await refresh();
      onSaved(`${platformLabel(platform)} отвязан.`);
    }
  };
  return (
    <form className="form-section form-stack" aria-label={`Подключение ${platformLabel(platform)} ${ordinal}`} onSubmit={save}>
      <h3>
        <PlatformIcon platform={platform} />
        {platformLabel(platform)}{ordinal > 1 && ` · ${ordinal}`}
      </h3>
      <BindingFields
        platform={platform}
        value={value}
        onChange={setValue}
        state={state}
        bindingId={binding?.id}
        disabled={action.busy}
        api={api}
        refresh={refresh}
      />
      <ActionMessages error={action.error} success={action.success} />
      <div className="form-actions">
        <Button
          type="submit"
          busy={action.busy}
          disabled={!value.endpointId && !binding}
        >
          Сохранить {platformLabel(platform)}
        </Button>
        {onDiscard && <Button onClick={onDiscard} disabled={action.busy}>Убрать подключение</Button>}
        {binding && (
          <Button
            variant="danger"
            busy={action.busy}
            onClick={() => void remove()}
          >
            Отвязать
          </Button>
        )}
      </div>
    </form>
  );
}
