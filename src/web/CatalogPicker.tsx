import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type {
  CatalogChat,
  CatalogPage,
  DashboardState,
  Endpoint,
  Person,
  Platform,
} from '../shared/types';
import { errorText, ReleApi, safeHref } from './client';
import { Button, Field, Notice } from './ui';

function mergeItems<T extends { id: string }>(before: T[], after: T[]): T[] {
  return [
    ...new Map([...before, ...after].map((item) => [item.id, item])).values(),
  ];
}

function preventSearchSubmit(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Enter') event.preventDefault();
}

function matches(query: string, ...values: Array<string | undefined>): boolean {
  return values
    .join(' ')
    .toLocaleLowerCase('ru')
    .includes(query.trim().toLocaleLowerCase('ru'));
}

function useCatalog<T extends { id: string }>(
  api: ReleApi,
  path: string | undefined,
  refresh?: () => Promise<void>,
) {
  const [result, setResult] = useState<{
    path?: string;
    items: T[];
    nextCursor?: string;
    loading: boolean;
    error: string;
  }>({ items: [], loading: false, error: '' });
  const request = useRef<AbortController | null>(null);
  const load = useCallback(
    async (cursor?: string) => {
      request.current?.abort();
      if (!path) return;
      const controller = new AbortController();
      request.current = controller;
      setResult((current) => ({
        ...current,
        path,
        items: current.path === path ? current.items : [],
        nextCursor: current.path === path ? current.nextCursor : undefined,
        loading: true,
        error: '',
      }));
      try {
        const url = cursor
          ? `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`
          : path;
        const page = await api.request<CatalogPage<T>>(
          url,
          'GET',
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setResult((current) => ({
          path,
          items:
            cursor && current.path === path
              ? mergeItems(current.items, page.items)
              : page.items,
          nextCursor: page.nextCursor,
          loading: false,
          error: '',
        }));
        await refresh?.();
      } catch (cause) {
        if (!controller.signal.aborted)
          setResult((current) => ({
            ...current,
            loading: false,
            error: errorText(cause),
          }));
      }
    },
    [api, path, refresh],
  );
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);
  // A previous page must never appear under the newly selected chat.
  const current =
    result.path === path
      ? result
      : { items: [] as T[], loading: !!path, error: '', nextCursor: undefined };
  return {
    ...current,
    reload: () => void load(),
    loadMore: () => void load(current.nextCursor),
  };
}

function CatalogControls({
  catalog,
  label,
  disabled,
}: {
  catalog: {
    loading: boolean;
    error: string;
    nextCursor?: string;
    reload: () => void;
    loadMore: () => void;
  };
  label: string;
  disabled: boolean;
}) {
  return (
    <>
      <div className="catalog-controls">
        <Button
          icon="refresh"
          aria-label={`Обновить ${label}`}
          busy={catalog.loading}
          disabled={disabled}
          onClick={catalog.reload}
        >
          Обновить
        </Button>
        {catalog.nextCursor && (
          <Button
            aria-label={`Загрузить ещё ${label}`}
            busy={catalog.loading}
            disabled={disabled}
            onClick={catalog.loadMore}
          >
            Загрузить ещё
          </Button>
        )}
      </div>
      {catalog.loading && (
        <p className="field-hint" role="status">
          Загружаем {label}…
        </p>
      )}
      {catalog.error && <Notice>{catalog.error}</Notice>}
    </>
  );
}

function owner(
  state: DashboardState,
  endpointId: string,
  conversationId?: string,
) {
  return state.conversations.find(
    (conversation) =>
      conversation.id !== conversationId &&
      conversation.bindings.some(
        (binding) => binding.endpointId === endpointId,
      ),
  );
}

function optionReason(
  state: DashboardState,
  endpoint: Endpoint,
  conversationId?: string,
): string {
  const occupied = owner(state, endpoint.id, conversationId);
  return occupied
    ? `В связке «${occupied.name}»`
    : endpoint.available === false
      ? 'Недоступен'
      : '';
}

function accountEndpoints(state: DashboardState, platform: Platform) {
  const accountId = state.connections[platform].accountId;
  return state.endpoints.filter(
    (endpoint) =>
      endpoint.platform === platform &&
      (!accountId || endpoint.accountId === accountId),
  );
}

interface PickerProps {
  state: DashboardState;
  api: ReleApi;
  refresh: () => Promise<void>;
  value: string;
  onChange: (endpoint: Endpoint | undefined) => void;
  disabled: boolean;
  conversationId?: string;
}

const telegramGroupKey = (endpoint: Endpoint) =>
  JSON.stringify([endpoint.accountId, endpoint.chatId]);

export function TelegramCatalogPicker({
  state,
  api,
  refresh,
  value,
  onChange,
  disabled,
  conversationId,
}: PickerProps) {
  const endpoints = accountEndpoints(state, 'telegram');
  const selected = endpoints.find((endpoint) => endpoint.id === value);
  const [groupKey, setGroupKey] = useState(
    selected ? telegramGroupKey(selected) : '',
  );
  const [query, setQuery] = useState('');
  const [info, setInfo] = useState<{ botUrl?: string; command: string }>({
    command: '/rele_register',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const loadInfo = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError('');
    try {
      const result = await api.request<typeof info>(
        '/api/catalog/telegram',
        'GET',
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted) setInfo(result);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorText(cause));
    }
  }, [api]);
  useEffect(() => {
    void loadInfo();
    return () => request.current?.abort();
  }, [loadInfo]);
  useEffect(() => {
    if (selected) setGroupKey(telegramGroupKey(selected));
  }, [selected?.id]);
  const groups = new Map<
    string,
    { name: string; endpoints: Endpoint[]; isForum: boolean }
  >();
  for (const endpoint of endpoints) {
    const key = telegramGroupKey(endpoint);
    const group = groups.get(key) ?? {
      name: endpoint.chatTitle || endpoint.title,
      endpoints: [],
      isForum: false,
    };
    if (endpoint.chatTitle) group.name = endpoint.chatTitle;
    group.endpoints.push(endpoint);
    group.isForum ||= !!endpoint.isForum;
    groups.set(key, group);
  }
  const visibleGroups = [...groups].filter(
    ([key, item]) =>
      key === groupKey ||
      matches(
        query,
        item.name,
        ...item.endpoints.flatMap((endpoint) => [
          endpoint.title,
          endpoint.subtitle,
          endpoint.topicTitle,
        ]),
      ),
  );
  const group = groups.get(groupKey);
  const targets =
    group?.endpoints.filter(
      (endpoint) =>
        !(group.isForum && !endpoint.threadId && !endpoint.generalTopic),
    ) ?? [];
  const botUrl = safeHref(info.botUrl);
  return (
    <div className="catalog-picker">
      <p className="field-hint">
        Обнаруженные чаты. Telegram показывает Rele те группы, личные чаты и
        темы, которые уже стали доступны боту.
      </p>
      <Field label="Поиск в обнаруженных чатах Telegram">
        <input
          type="search"
          onKeyDown={preventSearchSubmit}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Название группы или темы"
          disabled={disabled}
        />
      </Field>
      <Field label="Чат Telegram">
        <select
          value={groupKey}
          disabled={disabled}
          onChange={(event) => {
            setGroupKey(event.target.value);
            onChange(undefined);
          }}
        >
          <option value="">Выберите группу или личный чат</option>
          {visibleGroups.map(([key, item]) => (
            <option
              key={key}
              value={key}
              disabled={item.endpoints.every(
                (endpoint) => endpoint.available === false,
              )}
            >
              {item.name}
              {item.isForum ? ' · Группа с темами' : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Разговор Telegram"
        hint={
          group?.isForum
            ? 'Выберите отдельную тему. Группа с темами целиком не привязывается.'
            : undefined
        }
      >
        <select
          value={value}
          disabled={disabled || !group}
          onChange={(event) =>
            onChange(
              targets.find((endpoint) => endpoint.id === event.target.value),
            )
          }
        >
          <option value="">Не подключать</option>
          {targets
            .filter(
              (endpoint) =>
                endpoint.id === value ||
                matches(
                  query,
                  group?.name,
                  endpoint.title,
                  endpoint.subtitle,
                  endpoint.topicTitle,
                ),
            )
            .map((endpoint) => {
              const reason = optionReason(state, endpoint, conversationId);
              return (
                <option
                  key={endpoint.id}
                  value={endpoint.id}
                  disabled={!!reason}
                >
                  {endpoint.title}
                  {endpoint.subtitle ? ` · ${endpoint.subtitle}` : ''}
                  {reason ? ` · ${reason}` : ''}
                </option>
              );
            })}
        </select>
      </Field>
      {group && !targets.length && (
        <p className="field-hint">
          В этой группе пока не обнаружены темы. Откройте нужную тему в Telegram
          и зарегистрируйте её командой ниже.
        </p>
      )}
      {!!groups.size && !visibleGroups.length && (
        <p className="field-hint">В обнаруженных чатах совпадений нет.</p>
      )}
      {!groups.size && (
        <p className="field-hint">
          Обнаруженных чатов пока нет. Выберите группу в Telegram или
          зарегистрируйте нужный разговор.
        </p>
      )}
      <div className="catalog-controls">
        <Button
          icon="refresh"
          aria-label="Обновить обнаруженные чаты Telegram"
          busy={loading}
          disabled={disabled}
          onClick={async () => {
            setLoading(true);
            try {
              await Promise.all([refresh(), loadInfo()]);
            } finally {
              setLoading(false);
            }
          }}
        >
          Обновить
        </Button>
        {botUrl ? (
          <a className="button" href={botUrl} target="_blank" rel="noreferrer">
            Выбрать группу в Telegram
          </a>
        ) : (
          <Button disabled>Выбрать группу в Telegram</Button>
        )}
      </div>
      <div className="catalog-instruction">
        <strong>Не хватает чата или темы?</strong>
        <p>
          В нужном разговоре отправьте боту <code>{info.command} [имя]</code>,
          затем нажмите «Обновить». Имя можно не указывать. Команда добавляет
          разговор в каталог и не запускает Codex.
        </p>
        {!botUrl && (
          <p>
            Для выбора группы подключите токен бота в разделе «Подключения».
          </p>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

export function SlackCatalogPicker({
  state,
  api,
  refresh,
  value,
  onChange,
  disabled,
  conversationId,
}: PickerProps) {
  const known = accountEndpoints(state, 'slack');
  const selected = known.find((endpoint) => endpoint.id === value);
  const [chatId, setChatId] = useState(selected?.chatId ?? '');
  const [chatQuery, setChatQuery] = useState('');
  const [threadQuery, setThreadQuery] = useState('');
  const chats = useCatalog<CatalogChat>(api, '/api/catalog/slack/chats');
  const threads = useCatalog<Endpoint>(
    api,
    chatId
      ? `/api/catalog/slack/threads?chatId=${encodeURIComponent(chatId)}`
      : undefined,
    refresh,
  );
  useEffect(() => {
    if (selected) setChatId(selected.chatId);
  }, [selected?.id]);
  const fallbackChats: CatalogChat[] = known.map((endpoint) => ({
    id: endpoint.chatId,
    name: endpoint.chatTitle || endpoint.title,
    subtitle: '',
    kind: 'channel',
  }));
  const choices = mergeItems(fallbackChats, chats.items);
  const visibleChats = choices.filter(
    (chat) =>
      chat.id === chatId || matches(chatQuery, chat.name, chat.subtitle),
  );
  const accountId = state.connections.slack.accountId;
  const endpoints = mergeItems(
    threads.items.filter(
      (endpoint) =>
        endpoint.chatId === chatId &&
        (!accountId || endpoint.accountId === accountId),
    ),
    known.filter((endpoint) => endpoint.chatId === chatId),
  );
  const kinds = { channel: 'Канал', group: 'Группа', direct: 'Личный чат' };
  const filteredThreads = endpoints.filter(
    (endpoint) =>
      endpoint.id === value ||
      matches(threadQuery, endpoint.title, endpoint.subtitle),
  );
  const selectedThread = endpoints.find((endpoint) => endpoint.id === value);
  return (
    <div className="catalog-picker">
      <Field
        label="Поиск каналов и личных чатов Slack"
        hint="Поиск по уже загруженным чатам. Для продолжения каталога нажмите «Загрузить ещё»."
      >
        <input
          type="search"
          onKeyDown={preventSearchSubmit}
          value={chatQuery}
          onChange={(event) => setChatQuery(event.target.value)}
          placeholder="Название канала или участника"
          disabled={disabled}
        />
      </Field>
      <Field label="Чат Slack">
        <select
          value={chatId}
          disabled={disabled}
          onChange={(event) => {
            setChatId(event.target.value);
            setThreadQuery('');
            onChange(undefined);
          }}
        >
          <option value="">Выберите канал или личный чат</option>
          {visibleChats.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chat.name} · {kinds[chat.kind]}
              {chat.subtitle ? ` · ${chat.subtitle}` : ''}
            </option>
          ))}
        </select>
      </Field>
      <CatalogControls catalog={chats} label="чаты Slack" disabled={disabled} />
      {!chats.loading && !!choices.length && !visibleChats.length && (
        <p className="field-hint">Среди загруженных чатов совпадений нет.</p>
      )}
      {!chats.loading && !chats.error && !choices.length && (
        <p className="field-hint">
          Нет доступных каналов или личных чатов. Проверьте подключение Slack и
          доступ бота.
        </p>
      )}
      {chatId && (
        <>
          <Field
            label="Поиск тредов Slack"
            hint="Поиск по уже загруженным тредам выбранного чата."
          >
            <input
              type="search"
              onKeyDown={preventSearchSubmit}
              value={threadQuery}
              onChange={(event) => setThreadQuery(event.target.value)}
              placeholder="Текст начала разговора"
              disabled={disabled}
            />
          </Field>
          <Field label="Разговор Slack">
            <select
              value={value}
              disabled={disabled}
              onChange={(event) =>
                onChange(
                  endpoints.find(
                    (endpoint) => endpoint.id === event.target.value,
                  ),
                )
              }
            >
              <option value="">Не подключать</option>
              {filteredThreads.map((endpoint) => {
                const reason = optionReason(state, endpoint, conversationId);
                return (
                  <option
                    key={endpoint.id}
                    value={endpoint.id}
                    disabled={!!reason}
                  >
                    {endpoint.title}
                    {endpoint.subtitle ? ` · ${endpoint.subtitle}` : ''}
                    {reason ? ` · ${reason}` : ''}
                  </option>
                );
              })}
            </select>
          </Field>
          {selectedThread && (
            <div className="catalog-preview" aria-label="Выбранный тред Slack">
              <strong>{selectedThread.title}</strong>
              {selectedThread.subtitle && <div>{selectedThread.subtitle}</div>}
            </div>
          )}
          <CatalogControls
            catalog={threads}
            label="треды Slack"
            disabled={disabled}
          />
          {!threads.loading && !threads.error && !filteredThreads.length && (
            <p className="field-hint">
              {threadQuery
                ? 'Среди загруженных тредов совпадений нет.'
                : 'В этом чате пока нет доступных тредов.'}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function AllowedSenders({
  endpoint,
  accountId,
  api,
  refresh,
  value,
  onChange,
  disabled,
}: {
  endpoint: Endpoint;
  accountId?: string;
  api: ReleApi;
  refresh: () => Promise<void>;
  value: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
}) {
  const sameAccount = !accountId || endpoint.accountId === accountId;
  const catalog = useCatalog<Person>(
    api,
    endpoint.platform === 'slack' && sameAccount
      ? `/api/catalog/slack/people?endpointId=${encodeURIComponent(endpoint.id)}`
      : undefined,
    refresh,
  );
  const [query, setQuery] = useState('');
  const people = mergeItems(endpoint.people, catalog.items);
  const unavailable = value.filter(
    (id) => !people.some((person) => person.id === id),
  );
  const filtered = people.filter((person) => matches(query, person.name));
  return (
    <fieldset className="people-fieldset" disabled={disabled || !sameAccount}>
      <legend>Кто может отправлять запросы</legend>
      <p className="field-hint">
        Разрешите хотя бы одного отправителя. Все участники связки используют
        общий контекст Codex.
      </p>
      {endpoint.platform === 'slack' && sameAccount && (
        <div className="catalog-people-tools">
          <Field
            label="Поиск участников Slack"
            hint="Поиск по загруженным участникам. Доступ выдаётся только отмеченным людям."
          >
            <input
              type="search"
              onKeyDown={preventSearchSubmit}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Имя участника"
            />
          </Field>
          <CatalogControls
            catalog={catalog}
            label="участников Slack"
            disabled={disabled}
          />
        </div>
      )}
      {filtered.length ? (
        <div className="people-list">
          {filtered.map((person) => (
            <label className="check-row" key={person.id}>
              <input
                type="checkbox"
                checked={value.includes(person.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...new Set([...value, person.id])]
                      : value.filter((id) => id !== person.id),
                  )
                }
              />
              <span>{person.name}</span>
            </label>
          ))}
        </div>
      ) : (
        !catalog.loading && (
          <p className="muted">
            {query
              ? 'Среди загруженных участников совпадений нет.'
              : endpoint.platform === 'slack'
                ? 'Участники пока недоступны. Обновите список или проверьте доступ бота к чату.'
                : 'В этом разговоре ещё не замечены отправители. Попросите нужного участника отправить боту команду регистрации.'}
          </p>
        )
      )}
      {unavailable.length > 0 && (
        <div className="field-hint">
          Сохранённые отправители, чьи имена сейчас недоступны:{' '}
          {unavailable.length}.{' '}
          <button
            type="button"
            className="text-button"
            onClick={() =>
              onChange(
                value.filter((id) => people.some((person) => person.id === id)),
              )
            }
          >
            Убрать из доступа
          </button>
        </div>
      )}
    </fieldset>
  );
}
