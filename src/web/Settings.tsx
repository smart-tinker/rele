import { useEffect, useState, type FormEvent } from 'react';
import type {
  CodexTransport,
  ConnectionState,
  DashboardState,
  DesktopIntegrationState,
} from '../shared/types';
import { errorText, ReleApi } from './client';
import { useAction } from './hooks';
import { useCodexThreads } from './useCodexThreads';
import {
  automaticCodex,
  CodexDiscovery,
  codexTargetKey,
} from './CodexDiscovery';
import {
  ActionMessages,
  Button,
  ClearableInput,
  EmptyState,
  Field,
  Notice,
  PageHeading,
  PlatformIcon,
  Status,
  formatDate,
} from './ui';

function ConnectionStatus({ value }: { value: ConnectionState }) {
  return (
    <Status
      tone={value.connected ? 'good' : value.configured ? 'warning' : 'muted'}
    >
      {value.connected
        ? value.name
          ? `Подключён: ${value.name}`
          : 'Подключён'
        : value.configured
          ? 'Нет соединения'
          : 'Не настроен'}
    </Status>
  );
}

export function Connections({
  state,
  api,
  refresh,
  onCodex,
}: {
  state: DashboardState;
  api: ReleApi;
  refresh: () => Promise<void>;
  onCodex: () => void;
}) {
  return (
    <>
      <PageHeading
        title="Подключения"
        description="Мессенджеры и локальное распознавание голосовых сообщений."
      />
      <div className="connection-summary">
        <div>
          <strong>Codex</strong>
          <ConnectionStatus value={state.codex} />
        </div>
        <Button icon="arrow" onClick={onCodex}>
          Настроить Codex
        </Button>
      </div>
      <div className="settings-list">
        <TelegramSettings state={state} api={api} refresh={refresh} />
        <SlackSettings state={state} api={api} refresh={refresh} />
        <VoiceSettings state={state} api={api} refresh={refresh} />
      </div>
    </>
  );
}

function TelegramSettings({
  state,
  api,
  refresh,
}: {
  state: DashboardState;
  api: ReleApi;
  refresh: () => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(state.config.telegram.enabled);
  const [token, setToken] = useState('');
  const action = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await action.run(
      () =>
        api.request('/api/config', 'PUT', {
          telegram: {
            enabled,
            ...(token.trim() ? { token: token.trim() } : {}),
          },
        }),
      'Настройки Telegram сохранены. Состояние подключения обновится автоматически.',
    );
    if (result.ok) {
      setToken('');
      await refresh();
    }
  };
  return (
    <form className="settings-section" onSubmit={submit}>
      <div className="settings-heading">
        <h2>
          <PlatformIcon platform="telegram" />
          Telegram
        </h2>
        <ConnectionStatus value={state.connections.telegram} />
      </div>
      <p className="muted">
        Бот получает сообщения в доступных ему личных чатах, группах и темах.
        Чтобы разговор появился в связках, отправьте в него сообщение боту.
      </p>
      <div className="form-stack">
        <label className="check-row">
          <input
            type="checkbox"
            checked={enabled}
            disabled={action.busy}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>Включить Telegram</span>
        </label>
        <Field
          label="Токен бота Telegram"
          hint={
            state.config.telegram.tokenConfigured
              ? 'Токен сохранён. Оставьте поле пустым, чтобы использовать его.'
              : 'Укажите токен созданного бота. После сохранения он не отображается в панели.'
          }
        >
          <input
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={action.busy}
            placeholder={
              state.config.telegram.tokenConfigured
                ? 'Сохранённый токен'
                : 'Токен бота'
            }
            required={enabled && !state.config.telegram.tokenConfigured}
          />
        </Field>
        {state.connections.telegram.error && (
          <Notice tone="warning">{state.connections.telegram.error}</Notice>
        )}
        <ActionMessages error={action.error} success={action.success} />
        <div>
          <Button type="submit" busy={action.busy}>
            Сохранить Telegram
          </Button>
        </div>
      </div>
    </form>
  );
}

function SlackSettings({
  state,
  api,
  refresh,
}: {
  state: DashboardState;
  api: ReleApi;
  refresh: () => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(state.config.slack.enabled);
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const action = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await action.run(
      () =>
        api.request('/api/config', 'PUT', {
          slack: {
            enabled,
            ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
            ...(appToken.trim() ? { appToken: appToken.trim() } : {}),
          },
        }),
      'Настройки Slack сохранены. Состояние подключения обновится автоматически.',
    );
    if (result.ok) {
      setBotToken('');
      setAppToken('');
      await refresh();
    }
  };
  return (
    <form className="settings-section" onSubmit={submit}>
      <div className="settings-heading">
        <h2>
          <PlatformIcon platform="slack" />
          Slack
        </h2>
        <ConnectionStatus value={state.connections.slack} />
      </div>
      <p className="muted">
        Подключение через Socket Mode. Добавьте приложение Slack в нужный канал
        и отправьте сообщение в тред, который хотите связать с Codex.
      </p>
      <div className="form-stack">
        <label className="check-row">
          <input
            type="checkbox"
            checked={enabled}
            disabled={action.busy}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>Включить Slack</span>
        </label>
        <div className="form-grid">
          <Field
            label="Bot User OAuth Token"
            hint={
              state.config.slack.botTokenConfigured
                ? 'Токен сохранён. Пустое поле оставит его без изменений.'
                : 'Токен бота установленного приложения Slack.'
            }
          >
            <input
              type="password"
              autoComplete="new-password"
              value={botToken}
              onChange={(event) => setBotToken(event.target.value)}
              disabled={action.busy}
              placeholder={
                state.config.slack.botTokenConfigured
                  ? 'Сохранённый токен'
                  : 'xoxb-…'
              }
              required={enabled && !state.config.slack.botTokenConfigured}
            />
          </Field>
          <Field
            label="App-Level Token"
            hint={
              state.config.slack.appTokenConfigured
                ? 'Токен сохранён. Пустое поле оставит его без изменений.'
                : 'Токен приложения для соединения Socket Mode.'
            }
          >
            <input
              type="password"
              autoComplete="new-password"
              value={appToken}
              onChange={(event) => setAppToken(event.target.value)}
              disabled={action.busy}
              placeholder={
                state.config.slack.appTokenConfigured
                  ? 'Сохранённый токен'
                  : 'xapp-…'
              }
              required={enabled && !state.config.slack.appTokenConfigured}
            />
          </Field>
        </div>
        {state.connections.slack.error && (
          <Notice tone="warning">{state.connections.slack.error}</Notice>
        )}
        <ActionMessages error={action.error} success={action.success} />
        <div>
          <Button type="submit" busy={action.busy}>
            Сохранить Slack
          </Button>
        </div>
      </div>
    </form>
  );
}

function VoiceSettings({
  state,
  api,
  refresh,
}: {
  state: DashboardState;
  api: ReleApi;
  refresh: () => Promise<void>;
}) {
  const [value, setValue] = useState(state.config.voice);
  const action = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await action.run(
      () => api.request('/api/config', 'PUT', { voice: value }),
      'Настройки распознавания сохранены.',
    );
    if (result.ok) await refresh();
  };
  return (
    <form className="settings-section" onSubmit={submit}>
      <div className="settings-heading">
        <h2>Голосовые сообщения</h2>
        <Status tone={state.config.voice.enabled ? 'good' : 'muted'}>
          {state.config.voice.enabled ? 'Включено' : 'Выключено'}
        </Status>
      </div>
      <p className="muted">
        Rele распознаёт голосовое локально и передаёт текст в общий разговор
        Codex. В выбранном окружении Python должен быть установлен
        faster-whisper.
      </p>
      <div className="form-stack">
        <label className="check-row">
          <input
            type="checkbox"
            checked={value.enabled}
            disabled={action.busy}
            onChange={(event) =>
              setValue((current) => ({
                ...current,
                enabled: event.target.checked,
              }))
            }
          />
          <span>Распознавать голосовые сообщения</span>
        </label>
        <div className="form-grid">
          <Field label="Исполняемый файл Python">
            <input
              value={value.python}
              disabled={action.busy}
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  python: event.target.value,
                }))
              }
              required={value.enabled}
              placeholder="python"
            />
          </Field>
          <Field
            label="Папка локальной модели"
            hint="Полный путь к установленной модели faster-whisper на этом компьютере."
          >
            <input
              value={value.model}
              disabled={action.busy}
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  model: event.target.value,
                }))
              }
              required={value.enabled}
              placeholder="Полный путь к папке модели"
            />
          </Field>
          <Field
            label="Язык"
            hint="Код языка, например ru. Оставьте пустым для автоматического определения."
          >
            <input
              value={value.language}
              disabled={action.busy}
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  language: event.target.value,
                }))
              }
              placeholder="Автоматически"
            />
          </Field>
          <Field label="Устройство">
            <select
              value={value.device}
              disabled={action.busy}
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  device: event.target.value as 'cpu' | 'cuda',
                }))
              }
            >
              <option value="cpu">CPU</option>
              <option value="cuda">CUDA</option>
            </select>
          </Field>
        </div>
        <ActionMessages error={action.error} success={action.success} />
        <div>
          <Button type="submit" busy={action.busy}>
            Сохранить распознавание
          </Button>
        </div>
      </div>
    </form>
  );
}

export function CodexSettings({
  state,
  api,
  refresh,
}: {
  state: DashboardState;
  api: ReleApi;
  refresh: () => Promise<void>;
}) {
  const [transport, setTransport] = useState(state.config.codex.transport);
  const [executable, setExecutable] = useState(state.config.codex.executable);
  const [endpoint, setEndpoint] = useState(state.config.codex.endpoint);
  const [codexHome, setCodexHome] = useState(state.config.codex.codexHome ?? '');
  const [token, setToken] = useState('');
  const [selection, setSelection] = useState(
    ['shared', 'managed'].includes(state.config.codex.transport) &&
    codexTargetKey(state.config.codex) === codexTargetKey({ ...automaticCodex, transport: state.config.codex.transport })
      ? 'auto'
      : 'manual',
  );
  const [discoveryRevision, setDiscoveryRevision] = useState(0);
  const {
    threads,
    loading: threadsLoading,
    error: threadsError,
    reload: loadThreads,
  } = useCodexThreads(api, state);
  const [threadQuery, setThreadQuery] = useState('');
  const action = useAction();
  const [desktop, setDesktop] = useState<DesktopIntegrationState | null>(null);
  const [desktopError, setDesktopError] = useState('');
  const [desktopRevision, setDesktopRevision] = useState(0);
  const savedTarget = JSON.stringify([codexTargetKey(state.config.codex), state.config.codex.codexHome ?? '']);
  const pendingTarget = selection === 'auto'
    ? { ...automaticCodex, transport }
    : { transport, executable: executable.trim(), endpoint: ['shared', 'managed'].includes(transport) ? '' : endpoint.trim() };
  const unsavedCodex = savedTarget !== JSON.stringify([codexTargetKey(pendingTarget), codexHome.trim()]) || !!token.trim();
  useEffect(() => {
    const controller = new AbortController();
    setDesktop(null); setDesktopError('');
    void api.request<DesktopIntegrationState>('/api/codex/desktop-integration', 'GET', undefined, controller.signal).then(
      value => { if (!controller.signal.aborted) setDesktop(value); },
      error => { if (!controller.signal.aborted) setDesktopError(errorText(error)); },
    );
    return () => controller.abort();
  }, [api, desktopRevision, savedTarget]);
  const setDesktopEnabled = async (enabled: boolean) => {
    const result = await action.run(
      () => api.request<DesktopIntegrationState>('/api/codex/desktop-integration', 'POST', { enabled }),
      enabled
        ? 'Интеграция Desktop включена. После завершения текущих задач полностью выйдите из Desktop и откройте его обычным способом.'
        : 'Интеграция Desktop отключена. Работающие окна и задачи продолжают работу.',
    );
    if (result.ok) setDesktop(result.value);
    else setDesktopRevision(value => value + 1);
  };
  const chooseMode = (mode: CodexTransport) => {
    setTransport(mode);
    setEndpoint('');
    setToken('');
    setSelection(['shared', 'managed'].includes(mode) ? 'auto' : 'manual');
    if (['shared', 'managed'].includes(mode)) setExecutable(automaticCodex.executable);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await action.run(
      () =>
        api.request('/api/config', 'PUT', {
          codex: {
            ...(selection === 'auto'
              ? { ...automaticCodex, transport }
              : {
                  transport,
                  executable: executable.trim(),
                  endpoint: ['shared', 'managed'].includes(transport) ? '' : endpoint.trim(),
                }),
            codexHome: codexHome.trim(),
            ...(selection === 'manual' &&
            transport === 'websocket' &&
            token.trim()
              ? { token: token.trim() }
              : {}),
          },
        }),
      'Настройки Codex сохранены. Состояние подключения обновится автоматически.',
    );
    if (result.ok) {
      setToken('');
      await refresh();
      loadThreads();
      setDiscoveryRevision((value) => value + 1);
    }
  };
  const connect = async () => {
    const result = await action.run(
      () => api.request('/api/codex/connect', 'POST'),
      'Переподключение Codex запрошено.',
    );
    if (result.ok) {
      await refresh();
      loadThreads();
      setDiscoveryRevision((value) => value + 1);
    }
  };
  const filtered = threads.filter((thread) =>
    `${thread.name} ${thread.cwd} ${thread.preview}`
      .toLocaleLowerCase('ru')
      .includes(threadQuery.toLocaleLowerCase('ru').trim()),
  );
  return (
    <>
      <PageHeading
        title="Codex"
        description="Существующие разговоры Codex и сервер для Rele."
        actions={
          <Button
            icon="refresh"
            busy={action.busy}
            onClick={() => void connect()}
          >
            Переподключить
          </Button>
        }
      />
      <div className="diagnostic-strip">
        <ConnectionStatus value={state.codex} />
        <Status tone={state.codex.queueSupported ? 'good' : 'warning'}>
          {state.codex.queueSupported
            ? 'Очередь сервера доступна'
            : 'Очередь сервера недоступна'}
        </Status>
        <Status tone={state.codex.desktopVerified ? 'good' : 'warning'}>
          {state.codex.desktopVerified
            ? 'Desktop: проверен'
            : 'Desktop: требуется проверка'}
        </Status>
      </div>
      {state.codex.error && <Notice tone="warning">{state.codex.error}</Notice>}
      <dl className="codex-runtime" aria-label="Фактическое подключение Codex">
        <div>
          <dt>Подключённый сервер</dt>
          <dd>
            {state.codex.connected
              ? state.codex.name || 'Сервер ответил, версия не указана'
              : 'Нет соединения с сервером'}
          </dd>
        </div>
        <div>
          <dt>Исполняемый файл</dt>
          <dd>{state.codex.executable || 'Пока не определён'}</dd>
        </div>
        <div>
          <dt>Подключение</dt>
          <dd>
            {state.codex.transport
              ? state.codex.transport === 'shared'
                ? 'Общий Codex'
                : state.codex.transport === 'managed'
                ? 'Сервер Rele'
                : state.codex.transport === 'websocket'
                  ? 'WebSocket'
                  : 'Существующий локальный сервер'
              : 'Пока не определено'}
            {state.codex.endpoint && <span>{state.codex.endpoint}</span>}
          </dd>
        </div>
        <div>
          <dt>Профиль Codex</dt>
          <dd>
            {state.codex.connected && state.codex.codexHome
              ? state.codex.codexHome
              : 'Пока не определён'}
          </dd>
        </div>
      </dl>
      <form className="settings-section codex-form" onSubmit={submit}>
        <h2>Настройки Codex</h2>
        <div className="form-stack">
          <Field label="Режим работы">
            <select
              value={transport}
              disabled={action.busy}
              onChange={(event) =>
                chooseMode(event.target.value as CodexTransport)
              }
            >
              <option value="shared">Общий Codex (рекомендуется)</option>
              <optgroup label="Дополнительно">
                <option value="managed">Сервер Rele</option>
                <option value="proxy">Существующий локальный сервер</option>
                <option value="websocket">WebSocket</option>
              </optgroup>
            </select>
          </Field>
          {transport === 'shared' ? (
            <div className="codex-mode-copy">
              <p>Rele подключается к общему Codex или запускает его. Сервер восстанавливается после перезапусков и работает без открытого Desktop.</p>
              <p className="field-hint">Для совместной работы подключите обычный запуск Desktop ниже. Существующие разговоры и профиль сохраняются.</p>
              <p className="field-hint">На Windows после обновления Rele исправления инструментов Desktop вступают при следующем запуске общего сервера или перезагрузке Windows. Работающие задачи сохраняются; перезапуска одного Desktop недостаточно.</p>
            </div>
          ) : transport === 'managed' ? (
            <div className="codex-mode-copy">
              <p>
                Rele самостоятельно запускает Codex. Codex Desktop можно
                закрыть.
              </p>
              <p className="field-hint">
                При использовании того же профиля история общая. Пока другой
                клиент удерживает тред, запрос ждёт; после хода Rele освобождает
                тред. Обновление открытого окна Desktop проверяется отдельно.
              </p>
            </div>
          ) : (
            <Notice tone="info">
              {transport === 'proxy'
                ? 'Rele подключается к уже запущенному локальному серверу Codex.'
                : 'Rele подключается к уже запущенному серверу Codex по указанному адресу.'}
              <p>Для автоматического подключения и запуска выберите общий Codex.</p>
              <Button
                disabled={action.busy}
                onClick={() => chooseMode('shared')}
              >
                Перейти на общий Codex
              </Button>
            </Notice>
          )}
          <CodexDiscovery
            api={api}
            transport={transport}
            value={selection}
            refreshKey={discoveryRevision}
            disabled={action.busy}
            onChange={(choice) => {
              if (choice === 'auto') chooseMode(transport === 'managed' ? 'managed' : 'shared');
              else if (choice === 'manual') setSelection(choice);
              else if (choice.transport === 'shared' && codexTargetKey(choice) === codexTargetKey(automaticCodex)) chooseMode('shared');
              else {
                setSelection(codexTargetKey(choice));
                setTransport(choice.transport);
                setExecutable(choice.executable);
                setEndpoint(
                  ['shared', 'managed'].includes(choice.transport) ? '' : choice.endpoint,
                );
                if (choice.codexHome !== undefined)
                  setCodexHome(choice.codexHome);
                setToken('');
              }
            }}
          />
          {selection === 'manual' && (
            <div className="form-stack codex-manual">
              <Field
                label="Исполняемый файл Codex"
                hint="Имя команды или полный путь к Codex на этом компьютере."
              >
                <input
                  value={executable}
                  disabled={action.busy}
                  required
                  onChange={(event) => setExecutable(event.target.value)}
                  placeholder="codex"
                />
              </Field>
              {transport === 'proxy' && (
                <Field
                  label="Локальный сокет Codex"
                  hint="Оставьте пустым для стандартного подключения или укажите путь к существующему сокету."
                >
                  <input
                    value={endpoint}
                    disabled={action.busy}
                    onChange={(event) => setEndpoint(event.target.value)}
                    placeholder="Стандартное подключение"
                  />
                </Field>
              )}
              {transport === 'websocket' && (
                <>
                  <Field label="Адрес app-server">
                    <input
                      value={endpoint}
                      disabled={action.busy}
                      required
                      onChange={(event) => setEndpoint(event.target.value)}
                      placeholder="ws://127.0.0.1:4500"
                    />
                  </Field>
                  <Field
                    label="Токен app-server"
                    hint={
                      state.config.codex.tokenConfigured
                        ? 'Токен сохранён. Пустое поле оставит его без изменений.'
                        : 'Заполните, если app-server требует токен.'
                    }
                  >
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={token}
                      disabled={action.busy}
                      onChange={(event) => setToken(event.target.value)}
                    />
                  </Field>
                </>
              )}
            </div>
          )}
          <Field
            label="Папка профиля Codex"
            hint="Необязательно. Пусто — CODEX_HOME или профиль пользователя, от которого запущен Rele. Для существующих разговоров выберите тот же профиль, что в Codex Desktop или CLI."
          >
            <input
              value={codexHome}
              disabled={action.busy}
              onChange={(event) => setCodexHome(event.target.value)}
              placeholder="Профиль текущего пользователя"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <p className="field-hint">Изменения применятся после сохранения.</p>
          <ActionMessages error={action.error} success={action.success} />
          <div>
            <Button type="submit" busy={action.busy}>
              Сохранить Codex
            </Button>
          </div>
        </div>
      </form>
      <section className="settings-section" aria-labelledby="desktop-integration-title">
        <h2 id="desktop-integration-title">Обычный запуск Codex Desktop</h2>
        <div className="form-stack">
          {desktopError ? <Notice>{desktopError}</Notice> : desktop ? (
            desktop.available ? (
              <>
                <Status tone={desktop.enabled ? 'good' : 'warning'}>
                  {desktop.enabled ? 'Интеграция включена в настройках установки' : 'Интеграция отключена в настройках установки'}
                </Status>
                {desktop.lastCheckFailed && <Notice tone="warning">Последняя попытка подключения Desktop не прошла проверку. Проверьте подключение Codex и повторите попытку.</Notice>}
                <p className="field-hint">Это настройка следующего запуска Desktop. Работающие окна и задачи не закрываются. После включения дождитесь завершения задач, полностью выйдите из Desktop и откройте его обычным способом.</p>
                {desktop.enabled ? <p className="field-hint">Перед сменой сервера или профиля Codex сначала отключите интеграцию.</p> : unsavedCodex ? <p className="field-hint">Сначала сохраните настройки Codex.</p> : state.config.codex.transport !== 'shared' ? <p className="field-hint">Для подключения выберите «Общий Codex» с исходным профилем и сохраните настройки.</p> : null}
                <div>
                  <Button
                    busy={action.busy}
                    disabled={!desktop.enabled && (unsavedCodex || state.config.codex.transport !== 'shared')}
                    onClick={() => void setDesktopEnabled(!desktop.enabled)}
                  >
                    {desktop.enabled ? 'Отключить интеграцию Desktop' : 'Подключить обычный Codex Desktop'}
                  </Button>
                </div>
              </>
            ) : <p className="field-hint">Управление интеграцией доступно в установленном Rele для Windows. Здесь настройки обычного запуска Desktop не изменяются.</p>
          ) : <p className="field-hint">Проверяем настройки интеграции…</p>}
          <div><Button icon="refresh" disabled={action.busy || !desktop && !desktopError} onClick={() => setDesktopRevision(value => value + 1)}>Обновить статус Desktop</Button></div>
        </div>
      </section>
      <section className="threads-section" aria-labelledby="threads-title">
        <div className="section-heading">
          <h2 id="threads-title">Разговоры Codex</h2>
          <Button
            icon="refresh"
            busy={threadsLoading}
            disabled={!state.codex.connected || action.busy}
            onClick={() => void loadThreads(true)}
          >
            Обновить разговоры
          </Button>
        </div>
        {threadsError && <Notice>{threadsError}</Notice>}
        {threads.length > 0 && (
          <div className="search-field thread-search">
            <ClearableInput
              clearLabel="Очистить поиск разговоров Codex"
              onClear={() => setThreadQuery('')}
              value={threadQuery}
              onChange={(event) => setThreadQuery(event.target.value)}
              aria-label="Найти разговор Codex"
              placeholder="Найти разговор Codex"
            />
          </div>
        )}
        <div className="table-panel">
          {filtered.length ? (
            <div className="table-wrap">
              <table className="threads-table">
                <thead>
                  <tr>
                    <th scope="col">Разговор</th>
                    <th scope="col">Рабочая папка</th>
                    <th scope="col">Обновлён</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((thread) => (
                    <tr key={thread.id}>
                      <td data-label="Разговор">
                        <div className="cell-copy">
                          <strong>{thread.name || 'Без названия'}</strong>
                          {thread.preview && (
                            <small className="thread-preview">
                              {thread.preview}
                            </small>
                          )}
                        </div>
                      </td>
                      <td data-label="Рабочая папка" className="path-cell">
                        {thread.cwd || 'Не указана'}
                      </td>
                      <td data-label="Обновлён">
                        {thread.updatedAt
                          ? formatDate(
                              thread.updatedAt < 100000000000
                                ? thread.updatedAt * 1000
                                : thread.updatedAt,
                            )
                          : 'Неизвестно'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon="terminal"
              title={
                !state.codex.connected
                  ? 'Codex не подключён'
                  : threadsError
                    ? 'Не удалось загрузить разговоры'
                    : threadsLoading
                      ? 'Загружаем разговоры…'
                      : threadQuery
                        ? 'Разговоры не найдены'
                        : 'Список разговоров пока пуст'
              }
            >
              {!state.codex.connected
                ? 'Выберите Codex для сервера Rele или настройте существующий сервер и сохраните настройки.'
                : threadsError
                  ? 'Исправьте ошибку подключения и нажмите «Обновить разговоры».'
                  : threadsLoading
                    ? 'Получаем названия и рабочие папки из Codex.'
                    : threadQuery
                      ? 'Измените поисковый запрос.'
                      : 'Создайте разговор в Codex и обновите список.'}
            </EmptyState>
          )}
        </div>
      </section>
    </>
  );
}
