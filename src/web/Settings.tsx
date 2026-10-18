import { useEffect, useState, type FormEvent } from 'react';
import type { CodexThread, ConnectionState, DashboardState } from '../shared/types';
import { errorText, ReleApi } from './api';
import { useAction } from './hooks';
import { ActionMessages, Button, EmptyState, Field, Notice, PageHeading, PlatformIcon, Status, formatDate } from './ui';

function ConnectionStatus({ value }: { value: ConnectionState }) {
  return <Status tone={value.connected ? 'good' : value.configured ? 'warning' : 'muted'}>{value.connected ? value.name ? `Подключён: ${value.name}` : 'Подключён' : value.configured ? 'Нет соединения' : 'Не настроен'}</Status>;
}

export function Connections({ state, api, refresh, onCodex }: { state: DashboardState; api: ReleApi; refresh: () => Promise<void>; onCodex: () => void }) {
  return <>
    <PageHeading title="Подключения" description="Мессенджеры и локальное распознавание голосовых сообщений."/>
    <div className="connection-summary"><div><strong>Codex</strong><ConnectionStatus value={state.codex}/></div><Button icon="arrow" onClick={onCodex}>Настроить Codex</Button></div>
    <div className="settings-list"><TelegramSettings state={state} api={api} refresh={refresh}/><SlackSettings state={state} api={api} refresh={refresh}/><VoiceSettings state={state} api={api} refresh={refresh}/></div>
  </>;
}

function TelegramSettings({ state, api, refresh }: { state: DashboardState; api: ReleApi; refresh: () => Promise<void> }) {
  const [enabled, setEnabled] = useState(state.config.telegram.enabled);
  const [token, setToken] = useState('');
  const action = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await action.run(() => api.request('/api/config', 'PUT', { telegram: { enabled, ...(token.trim() ? { token: token.trim() } : {}) } }), 'Настройки Telegram сохранены. Состояние подключения обновится автоматически.');
    if (result.ok) { setToken(''); await refresh(); }
  };
  return <form className="settings-section" onSubmit={submit}><div className="settings-heading"><h2><PlatformIcon platform="telegram"/>Telegram</h2><ConnectionStatus value={state.connections.telegram}/></div><p className="muted">Бот получает сообщения в доступных ему личных чатах, группах и темах. Чтобы разговор появился в связках, отправьте в него сообщение боту.</p><div className="form-stack"><label className="check-row"><input type="checkbox" checked={enabled} disabled={action.busy} onChange={event => setEnabled(event.target.checked)}/><span>Включить Telegram</span></label><Field label="Токен бота Telegram" hint={state.config.telegram.tokenConfigured ? 'Токен сохранён. Оставьте поле пустым, чтобы использовать его.' : 'Укажите токен созданного бота. После сохранения он не отображается в панели.'}><input type="password" autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} disabled={action.busy} placeholder={state.config.telegram.tokenConfigured ? 'Сохранённый токен' : 'Токен бота'} required={enabled && !state.config.telegram.tokenConfigured}/></Field>{state.connections.telegram.error && <Notice tone="warning">{state.connections.telegram.error}</Notice>}<ActionMessages error={action.error} success={action.success}/><div><Button type="submit" busy={action.busy}>Сохранить Telegram</Button></div></div></form>;
}

function SlackSettings({ state, api, refresh }: { state: DashboardState; api: ReleApi; refresh: () => Promise<void> }) {
  const [enabled, setEnabled] = useState(state.config.slack.enabled);
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const action = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await action.run(() => api.request('/api/config', 'PUT', { slack: { enabled, ...(botToken.trim() ? { botToken: botToken.trim() } : {}), ...(appToken.trim() ? { appToken: appToken.trim() } : {}) } }), 'Настройки Slack сохранены. Состояние подключения обновится автоматически.');
    if (result.ok) { setBotToken(''); setAppToken(''); await refresh(); }
  };
  return <form className="settings-section" onSubmit={submit}><div className="settings-heading"><h2><PlatformIcon platform="slack"/>Slack</h2><ConnectionStatus value={state.connections.slack}/></div><p className="muted">Подключение через Socket Mode. Добавьте приложение Slack в нужный канал и отправьте сообщение в тред, который хотите связать с Codex.</p><div className="form-stack"><label className="check-row"><input type="checkbox" checked={enabled} disabled={action.busy} onChange={event => setEnabled(event.target.checked)}/><span>Включить Slack</span></label><div className="form-grid"><Field label="Bot User OAuth Token" hint={state.config.slack.botTokenConfigured ? 'Токен сохранён. Пустое поле оставит его без изменений.' : 'Токен бота установленного приложения Slack.'}><input type="password" autoComplete="new-password" value={botToken} onChange={event => setBotToken(event.target.value)} disabled={action.busy} placeholder={state.config.slack.botTokenConfigured ? 'Сохранённый токен' : 'xoxb-…'} required={enabled && !state.config.slack.botTokenConfigured}/></Field><Field label="App-Level Token" hint={state.config.slack.appTokenConfigured ? 'Токен сохранён. Пустое поле оставит его без изменений.' : 'Токен приложения для соединения Socket Mode.'}><input type="password" autoComplete="new-password" value={appToken} onChange={event => setAppToken(event.target.value)} disabled={action.busy} placeholder={state.config.slack.appTokenConfigured ? 'Сохранённый токен' : 'xapp-…'} required={enabled && !state.config.slack.appTokenConfigured}/></Field></div>{state.connections.slack.error && <Notice tone="warning">{state.connections.slack.error}</Notice>}<ActionMessages error={action.error} success={action.success}/><div><Button type="submit" busy={action.busy}>Сохранить Slack</Button></div></div></form>;
}

function VoiceSettings({ state, api, refresh }: { state: DashboardState; api: ReleApi; refresh: () => Promise<void> }) {
  const [value, setValue] = useState(state.config.voice);
  const action = useAction();
  const submit = async (event: FormEvent) => { event.preventDefault(); const result = await action.run(() => api.request('/api/config', 'PUT', { voice: value }), 'Настройки распознавания сохранены.'); if (result.ok) await refresh(); };
  return <form className="settings-section" onSubmit={submit}><div className="settings-heading"><h2>Голосовые сообщения</h2><Status tone={state.config.voice.enabled ? 'good' : 'muted'}>{state.config.voice.enabled ? 'Включено' : 'Выключено'}</Status></div><p className="muted">Rele распознаёт голосовое локально и передаёт текст в общий разговор Codex. В выбранном окружении Python должен быть установлен faster-whisper.</p><div className="form-stack"><label className="check-row"><input type="checkbox" checked={value.enabled} disabled={action.busy} onChange={event => setValue(current => ({ ...current, enabled: event.target.checked }))}/><span>Распознавать голосовые сообщения</span></label><div className="form-grid"><Field label="Исполняемый файл Python"><input value={value.python} disabled={action.busy} onChange={event => setValue(current => ({ ...current, python: event.target.value }))} required={value.enabled} placeholder="python"/></Field><Field label="Папка локальной модели" hint="Полный путь к установленной модели faster-whisper на этом компьютере."><input value={value.model} disabled={action.busy} onChange={event => setValue(current => ({ ...current, model: event.target.value }))} required={value.enabled} placeholder="Полный путь к папке модели"/></Field><Field label="Язык" hint="Код языка, например ru. Оставьте пустым для автоматического определения."><input value={value.language} disabled={action.busy} onChange={event => setValue(current => ({ ...current, language: event.target.value }))} placeholder="Автоматически"/></Field><Field label="Устройство"><select value={value.device} disabled={action.busy} onChange={event => setValue(current => ({ ...current, device: event.target.value as 'cpu' | 'cuda' }))}><option value="cpu">CPU</option><option value="cuda">CUDA</option></select></Field></div><ActionMessages error={action.error} success={action.success}/><div><Button type="submit" busy={action.busy}>Сохранить распознавание</Button></div></div></form>;
}

export function CodexSettings({ state, api, refresh }: { state: DashboardState; api: ReleApi; refresh: () => Promise<void> }) {
  const [transport, setTransport] = useState(state.config.codex.transport);
  const [executable, setExecutable] = useState(state.config.codex.executable);
  const [endpoint, setEndpoint] = useState(state.config.codex.endpoint);
  const [token, setToken] = useState('');
  const [threads, setThreads] = useState<CodexThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState('');
  const [threadQuery, setThreadQuery] = useState('');
  const action = useAction();
  const loadThreads = async (signal?: AbortSignal) => {
    setThreadsLoading(true); setThreadsError('');
    try { const result = await api.request<{ threads: CodexThread[] }>('/api/threads', 'GET', undefined, signal); if (!signal?.aborted) setThreads(result.threads); }
    catch (cause) { if (!signal?.aborted) setThreadsError(errorText(cause)); }
    finally { if (!signal?.aborted) setThreadsLoading(false); }
  };
  useEffect(() => { const controller = new AbortController(); if (state.codex.connected) void loadThreads(controller.signal); return () => controller.abort(); }, [api, state.codex.connected]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await action.run(() => api.request('/api/config', 'PUT', { codex: { transport, executable: executable.trim(), endpoint: endpoint.trim(), ...(token.trim() ? { token: token.trim() } : {}) } }), 'Настройки Codex сохранены. Состояние подключения обновится автоматически.');
    if (result.ok) { setToken(''); await refresh(); }
  };
  const connect = async () => { const result = await action.run(() => api.request('/api/codex/connect', 'POST'), 'Переподключение Codex запрошено.'); if (result.ok) { await refresh(); await loadThreads(); } };
  const filtered = threads.filter(thread => `${thread.name} ${thread.cwd} ${thread.preview}`.toLocaleLowerCase('ru').includes(threadQuery.toLocaleLowerCase('ru').trim()));
  return <>
    <PageHeading title="Codex" description="Общий сервер разговоров на этом компьютере." actions={<Button icon="refresh" busy={action.busy} onClick={() => void connect()}>Переподключить</Button>}/>
    <div className="diagnostic-strip"><ConnectionStatus value={state.codex}/><Status tone={state.codex.queueSupported ? 'good' : 'warning'}>{state.codex.queueSupported ? 'Очередь сервера доступна' : 'Очередь сервера недоступна'}</Status><Status tone={state.codex.desktopVerified ? 'good' : 'warning'}>{state.codex.desktopVerified ? 'Desktop: проверен' : 'Desktop: требуется проверка'}</Status></div>
    {state.codex.error && <Notice tone="warning">{state.codex.error}</Notice>}
    <form className="settings-section codex-form" onSubmit={submit}><h2>Подключение к app-server</h2><div className="form-stack"><Field label="Способ подключения"><select value={transport} disabled={action.busy} onChange={event => setTransport(event.target.value as 'proxy' | 'websocket')}><option value="proxy">Локальный общий сервер</option><option value="websocket">WebSocket</option></select></Field><Field label="Исполняемый файл Codex" hint="Имя команды или полный путь к Codex на этом компьютере."><input value={executable} disabled={action.busy} required onChange={event => setExecutable(event.target.value)} placeholder="codex"/></Field>{transport === 'websocket' && <><Field label="Адрес app-server"><input value={endpoint} disabled={action.busy} required onChange={event => setEndpoint(event.target.value)} placeholder="ws://127.0.0.1:4500"/></Field><Field label="Токен app-server" hint={state.config.codex.tokenConfigured ? 'Токен сохранён. Пустое поле оставит его без изменений.' : 'Заполните, если app-server требует токен.'}><input type="password" autoComplete="new-password" value={token} disabled={action.busy} onChange={event => setToken(event.target.value)}/></Field></>}<p className="field-hint">Rele и Codex должны использовать профиль одного пользователя. На Windows совместная работа с установленным Desktop проверяется отдельно. На Ubuntu Server используется CLI.</p><ActionMessages error={action.error} success={action.success}/><div><Button type="submit" busy={action.busy}>Сохранить Codex</Button></div></div></form>
    <section className="threads-section" aria-labelledby="threads-title"><div className="section-heading"><h2 id="threads-title">Разговоры Codex</h2><Button icon="refresh" busy={threadsLoading} onClick={() => void loadThreads()}>Обновить разговоры</Button></div>{threadsError && <Notice>{threadsError}</Notice>}{threads.length > 0 && <label className="search-field thread-search"><input value={threadQuery} onChange={event => setThreadQuery(event.target.value)} aria-label="Найти разговор Codex" placeholder="Найти разговор Codex"/></label>}<div className="table-panel">{filtered.length ? <div className="table-wrap"><table className="threads-table"><thead><tr><th scope="col">Разговор</th><th scope="col">Рабочая папка</th><th scope="col">Обновлён</th></tr></thead><tbody>{filtered.map(thread => <tr key={thread.id}><td data-label="Разговор"><div className="cell-copy"><strong>{thread.name || 'Без названия'}</strong>{thread.preview && <small className="thread-preview">{thread.preview}</small>}</div></td><td data-label="Рабочая папка" className="path-cell">{thread.cwd || 'Не указана'}</td><td data-label="Обновлён">{thread.updatedAt ? formatDate(thread.updatedAt < 100000000000 ? thread.updatedAt * 1000 : thread.updatedAt) : 'Неизвестно'}</td></tr>)}</tbody></table></div> : <EmptyState icon="terminal" title={threadsLoading ? 'Загружаем разговоры…' : threadQuery ? 'Разговоры не найдены' : 'Список разговоров пока пуст'}>{threadsLoading ? 'Получаем названия и рабочие папки из Codex.' : state.codex.connected ? 'Создайте разговор в Codex и обновите список.' : 'Настройте подключение к Codex, затем обновите список.'}</EmptyState>}</div></section>
  </>;
}
