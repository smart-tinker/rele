import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  ReleApi,
  exchangeLaunchToken,
  errorText,
  saveToken,
  type InitialSession,
} from './client';
import { useDashboard } from './hooks';
import { Conversations } from './Conversations';
import { Deliveries, Queue } from './Activity';
import { CodexSettings, Connections } from './Settings';
import { Button, Field, Icon, Notice, Status, type IconName } from './ui';

type View = 'conversations' | 'queue' | 'deliveries' | 'connections' | 'codex';
const navigation: Array<{ id: View; label: string; icon: IconName }> = [
  { id: 'conversations', label: 'Связи', icon: 'link' },
  { id: 'queue', label: 'Очередь', icon: 'clock' },
  { id: 'deliveries', label: 'Доставка', icon: 'send' },
  { id: 'connections', label: 'Подключения', icon: 'plug' },
  { id: 'codex', label: 'Codex', icon: 'terminal' },
];

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <main className="auth-page">
        <div className="auth-panel">
          <div className="wordmark">Rele</div>
          <h1>Не удалось открыть панель</h1>
          <p className="muted">
            Обновите страницу. Если ошибка повторяется, проверьте журнал Rele.
          </p>
          <Button onClick={() => window.location.reload()}>
            Обновить страницу
          </Button>
        </div>
      </main>
    ) : (
      this.props.children
    );
  }
}

export function App({ initialSession }: { initialSession: InitialSession }) {
  return (
    <ErrorBoundary>
      <Session initial={initialSession} />
    </ErrorBoundary>
  );
}

function Session({ initial }: { initial: InitialSession }) {
  const [token, setToken] = useState(initial.token);
  const [authError, setAuthError] = useState('');
  const [launching, setLaunching] = useState(initial.launchToken !== undefined);
  const launchRequest = useRef<Promise<string> | null>(null);
  useEffect(() => {
    if (initial.launchToken === undefined) return;
    let active = true;
    // StrictMode runs effects twice; a one-time link must be redeemed only once.
    launchRequest.current ??= exchangeLaunchToken(initial.launchToken);
    void launchRequest.current.then(
      (next) => {
        if (!active) return;
        saveToken(next);
        setToken(next);
        setAuthError('');
        setLaunching(false);
      },
      (cause) => {
        if (!active) return;
        setAuthError(errorText(cause));
        setLaunching(false);
      },
    );
    return () => {
      active = false;
    };
  }, [initial.launchToken]);
  const signOut = useCallback(() => {
    saveToken('');
    setToken('');
  }, []);
  const unauthorized = useCallback(() => {
    signOut();
    setAuthError('Токен панели не принят. Откройте Rele через ярлык или получите новую ссылку запуска.');
  }, [signOut]);
  const signIn = (next: string) => {
    saveToken(next);
    setAuthError('');
    setToken(next);
  };
  return token ? (
    <Dashboard
      key={token}
      token={token}
      onUnauthorized={unauthorized}
      onSignOut={signOut}
    />
  ) : (
    <SignIn error={authError} onSignIn={signIn} launching={launching} />
  );
}

function SignIn({
  error,
  onSignIn,
  launching,
}: {
  error: string;
  onSignIn: (token: string) => void;
  launching: boolean;
}) {
  const [token, setToken] = useState('');
  const [manual, setManual] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!launching && token.trim()) onSignIn(token.trim());
  };
  return (
    <main className="auth-page">
      <div className="auth-panel">
        <div className="wordmark">Rele</div>
        <h1>Вход в панель</h1>
        <p className="muted">
          В Windows откройте Rele через меню «Пуск» или ярлык Rele. На сервере
          выполните <code>rele open --print-url</code> и откройте выданную ссылку
          в браузере. Вводить токен не нужно.
        </p>
        {error && <Notice>{error}</Notice>}
        {launching && (
          <p className="field-hint" role="status">
            Проверяем одноразовую ссылку…
          </p>
        )}
        <Button
          variant="quiet"
          aria-expanded={manual}
          aria-controls="manual-sign-in"
          disabled={launching}
          onClick={() => setManual(!manual)}
        >
          Ввести токен вручную
        </Button>
        {manual && (
          <form id="manual-sign-in" className="form-stack" onSubmit={submit}>
            <p className="field-hint">Резервный способ, если у вас уже есть токен панели.</p>
            <Field label="Токен панели">
              <input
                type="password"
                autoFocus
                autoComplete="off"
                required
                disabled={launching}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Токен доступа"
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              disabled={!token.trim()}
              busy={launching}
            >
              Открыть Rele
            </Button>
          </form>
        )}
        <p className="auth-note">
          После перезапуска браузера вход в этой вкладке может не сохраниться.
          Откройте Rele заново указанным выше способом или введите токен панели,
          если он у вас есть.
        </p>
      </div>
    </main>
  );
}

function Dashboard({
  token,
  onUnauthorized,
  onSignOut,
}: {
  token: string;
  onUnauthorized: () => void;
  onSignOut: () => void;
}) {
  const [view, setView] = useState<View>('conversations');
  const api = useMemo(
    () => new ReleApi(token, onUnauthorized),
    [token, onUnauthorized],
  );
  const { state, error, loading, refresh } = useDashboard(api);
  useEffect(() => {
    document.title = `Rele — ${navigation.find((item) => item.id === view)?.label}`;
  }, [view]);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Перейти к содержимому
      </a>
      <aside className="sidebar">
        <div className="wordmark">Rele</div>
        <nav aria-label="Основная навигация">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => setView(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.id === 'queue' &&
                !!state?.approvals.filter(
                  (approval) => approval.status === 'pending',
                ).length && (
                  <span
                    className="nav-attention"
                    aria-label="Есть запросы подтверждения"
                  />
                )}
            </button>
          ))}
        </nav>
        <footer className="sidebar-footer">
          <span>Локальный шлюз</span>
          <small>v{state?.version ?? '0.1.0-rc.1'}</small>
          {state && (
            <Status tone={error ? 'warning' : 'good'}>
              {error ? 'Нет связи с Rele' : 'Панель подключена'}
            </Status>
          )}
          <Button variant="quiet" icon="logout" onClick={onSignOut}>
            Выйти
          </Button>
        </footer>
      </aside>
      <main id="main-content" className="main-content" tabIndex={-1}>
        {error && (
          <div className="connection-error">
            <Notice>
              {error}
              {state && ' Отображаются последние полученные данные.'}
            </Notice>
            <Button icon="refresh" onClick={() => void refresh()}>
              Повторить
            </Button>
          </div>
        )}
        {loading && !state && (
          <div className="loading-state" role="status">
            <span className="spinner" />
            <h1>Подключаемся к Rele…</h1>
            <p>Загружаем связки и состояние подключений.</p>
          </div>
        )}
        {!loading && !state && !error && (
          <Notice>Данные панели недоступны. Обновите страницу.</Notice>
        )}
        {state && (
          <>
            {view === 'conversations' && (
              <Conversations
                state={state}
                api={api}
                refresh={refresh}
                onNavigate={setView}
              />
            )}{' '}
            {view === 'queue' && (
              <Queue state={state} api={api} refresh={refresh} />
            )}{' '}
            {view === 'deliveries' && (
              <Deliveries state={state} api={api} refresh={refresh} />
            )}{' '}
            {view === 'connections' && (
              <Connections
                state={state}
                api={api}
                refresh={refresh}
                onCodex={() => setView('codex')}
              />
            )}{' '}
            {view === 'codex' && (
              <CodexSettings state={state} api={api} refresh={refresh} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
