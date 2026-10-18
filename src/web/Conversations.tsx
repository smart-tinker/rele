import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  Binding,
  CodexThread,
  Conversation,
  DashboardState,
  Endpoint,
  Platform,
} from '../shared/types';
import { errorText, ReleApi, safeHref } from './client';
import { useAction } from './hooks';
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

  const connectionCell = (conversation: Conversation, platform: Platform) => {
    const binding = conversation.bindings.find(
      (item) => item.platform === platform,
    );
    const endpoint = binding && endpoints.get(binding.endpointId);
    if (!binding)
      return (
        <div className="cell-copy cell-muted">
          <span>—</span>
          <small>Не подключён</small>
        </div>
      );
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
  endpoints,
  disabled,
  api,
  refresh,
}: {
  platform: Platform;
  value: BindingDraft;
  onChange: (value: BindingDraft) => void;
  endpoints: Endpoint[];
  disabled: boolean;
  api: ReleApi;
  refresh: () => Promise<void>;
}) {
  const endpoint = endpoints.find((item) => item.id === value.endpointId);
  const knownPeople = endpoint?.people ?? [];
  const unavailable = value.allowedSenderIds.filter(
    (id) => !knownPeople.some((person) => person.id === id),
  );
  const toggle = (id: string, checked: boolean) =>
    onChange({
      ...value,
      allowedSenderIds: checked
        ? [...new Set([...value.allowedSenderIds, id])]
        : value.allowedSenderIds.filter((item) => item !== id),
    });
  return (
    <>
      <Field
        label={`Разговор ${platformLabel(platform)}`}
        hint={
          !endpoints.length
            ? `Пока нет доступных разговоров. Подключите ${platformLabel(platform)} и отправьте сообщение боту в нужный разговор.`
            : undefined
        }
      >
        <select
          value={value.endpointId}
          disabled={disabled}
          onChange={(event) =>
            onChange({ endpointId: event.target.value, allowedSenderIds: [] })
          }
        >
          <option value="">Не подключать</option>
          {endpoints.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
              {item.subtitle ? ` · ${item.subtitle}` : ''}
            </option>
          ))}
        </select>
      </Field>
      {endpoint && (
        <EndpointNameEditor
          key={endpoint.id}
          endpoint={endpoint}
          api={api}
          refresh={refresh}
          disabled={disabled}
        />
      )}
      {endpoint && (
        <fieldset className="people-fieldset" disabled={disabled}>
          <legend>Кто может отправлять запросы</legend>
          <p className="field-hint">
            Разрешите хотя бы одного отправителя. Все участники связки
            используют общий контекст Codex.
          </p>
          {knownPeople.length ? (
            <div className="people-list">
              {knownPeople.map((person) => (
                <label className="check-row" key={person.id}>
                  <input
                    type="checkbox"
                    checked={value.allowedSenderIds.includes(person.id)}
                    onChange={(event) =>
                      toggle(person.id, event.target.checked)
                    }
                  />
                  <span>{person.name}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="muted">
              В этом разговоре ещё не замечены отправители. Попросите нужного
              участника написать боту.
            </p>
          )}
          {unavailable.length > 0 && (
            <div className="field-hint">
              Сохранённые отправители, чьи имена сейчас недоступны:{' '}
              {unavailable.length}.{' '}
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  onChange({
                    ...value,
                    allowedSenderIds: value.allowedSenderIds.filter(
                      (id) => !unavailable.includes(id),
                    ),
                  })
                }
              >
                Убрать из доступа
              </button>
            </div>
          )}
        </fieldset>
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
          aria-label={`Переименовать разговор ${platformLabel(endpoint.platform)}`}
          disabled={disabled}
          onClick={() => {
            setTitle(endpoint.title);
            action.setError('');
            setEditing(true);
          }}
        >
          Переименовать в Rele
        </button>
      )}
    </div>
  );
}

function availableEndpoints(
  state: DashboardState,
  platform: Platform,
  conversationId?: string,
): Endpoint[] {
  const occupied = new Set(
    state.conversations
      .filter((item) => item.id !== conversationId)
      .flatMap((item) => item.bindings.map((binding) => binding.endpointId)),
  );
  return state.endpoints.filter(
    (item) => item.platform === platform && !occupied.has(item.id),
  );
}

function NewConversation({
  state,
  api,
  refresh,
  onCreated,
}: {
  state: DashboardState;
  api: ReleApi;
  refresh: () => Promise<void>;
  onCreated: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [threadId, setThreadId] = useState('');
  const [threads, setThreads] = useState<CodexThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState('');
  const [bindings, setBindings] = useState<Record<Platform, BindingDraft>>({
    telegram: emptyBinding(),
    slack: emptyBinding(),
  });
  const action = useAction();
  const selected = threads.find((item) => item.id === threadId);
  const loadThreads = async (signal?: AbortSignal) => {
    setThreadsLoading(true);
    setThreadsError('');
    try {
      const result = await api.request<{ threads: CodexThread[] }>(
        '/api/threads',
        'GET',
        undefined,
        signal,
      );
      if (!signal?.aborted) setThreads(result.threads);
    } catch (cause) {
      if (!signal?.aborted) setThreadsError(errorText(cause));
    } finally {
      if (!signal?.aborted) setThreadsLoading(false);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void loadThreads(controller.signal);
    return () => controller.abort();
  }, [api]);
  const availableThreads = threads.filter(
    (thread) =>
      !state.conversations.some((item) => item.threadId === thread.id),
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) {
      action.setError('Выберите разговор Codex.');
      return;
    }
    const chosen = platforms
      .filter((platform) => bindings[platform].endpointId)
      .map((platform) => ({ platform, ...bindings[platform] }));
    if (chosen.some((binding) => !binding.allowedSenderIds.length)) {
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
      <Field label="Разговор Codex">
        <select
          value={threadId}
          required
          disabled={threadsLoading || action.busy}
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
              : 'Выберите разговор по названию'}
          </option>
          {availableThreads.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.name || 'Без названия'}
              {thread.cwd ? ` · ${thread.cwd}` : ''}
            </option>
          ))}
        </select>
      </Field>
      {selected?.cwd && (
        <div className="selected-path">
          Рабочая папка: <span>{selected.cwd}</span>
        </div>
      )}
      {threadsError && <Notice>{threadsError}</Notice>}
      {!threadsLoading && !availableThreads.length && (
        <Notice tone="info">
          Нет свободных разговоров Codex. Создайте разговор в Codex, затем
          обновите список.
        </Notice>
      )}
      <div>
        <Button
          icon="refresh"
          busy={threadsLoading}
          onClick={() => void loadThreads()}
        >
          Обновить разговоры
        </Button>
      </div>
      {platforms.map((platform) => (
        <section className="form-section" key={platform}>
          <h3>
            <PlatformIcon platform={platform} />
            {platformLabel(platform)}
          </h3>
          <BindingFields
            platform={platform}
            value={bindings[platform]}
            onChange={(value) =>
              setBindings((current) => ({ ...current, [platform]: value }))
            }
            endpoints={availableEndpoints(state, platform)}
            disabled={action.busy}
            api={api}
            refresh={refresh}
          />
        </section>
      ))}
      <ActionMessages error={action.error} success={action.success} />
      <div className="form-actions">
        <Button
          type="submit"
          variant="primary"
          busy={action.busy}
          disabled={!selected || !name.trim()}
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
      {platforms.map((platform) => (
        <EditBinding
          key={`${conversation.id}-${platform}`}
          platform={platform}
          conversation={conversation}
          binding={conversation.bindings.find(
            (item) => item.platform === platform,
          )}
          state={state}
          api={api}
          refresh={refresh}
        />
      ))}
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
}: {
  platform: Platform;
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
        }
      : emptyBinding(),
  );
  const action = useAction();
  const path = `/api/conversations/${encodeURIComponent(conversation.id)}/bindings/${platform}`;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (value.endpointId && !value.allowedSenderIds.length) {
      action.setError('Разрешите хотя бы одного отправителя.');
      return;
    }
    const result = await action.run(
      () =>
        api.request(
          path,
          value.endpointId ? 'PUT' : 'DELETE',
          value.endpointId ? value : undefined,
        ),
      value.endpointId
        ? `${platformLabel(platform)} подключён. Доступ сохранён.`
        : `${platformLabel(platform)} отвязан.`,
    );
    if (result.ok) await refresh();
  };
  const remove = async () => {
    const result = await action.run(
      () => api.request(path, 'DELETE'),
      `${platformLabel(platform)} отвязан.`,
    );
    if (result.ok) {
      setValue(emptyBinding());
      await refresh();
    }
  };
  return (
    <form className="form-section form-stack" onSubmit={save}>
      <h3>
        <PlatformIcon platform={platform} />
        {platformLabel(platform)}
      </h3>
      <BindingFields
        platform={platform}
        value={value}
        onChange={setValue}
        endpoints={availableEndpoints(state, platform, conversation.id)}
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
