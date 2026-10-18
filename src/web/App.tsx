import { Component, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ReleApi, initialToken, saveToken } from './api';
import { useDashboard } from './hooks';
import { Conversations } from './Conversations';
import { Deliveries, Queue } from './Activity';
import { CodexSettings, Connections } from './Settings';
import { Button, Field, Icon, Notice, Status, type IconName } from './ui';

type View = 'conversations' | 'queue' | 'deliveries' | 'connections' | 'codex';
const navigation: Array<{ id: View; label: string; icon: IconName }> = [{ id: 'conversations', label: 'Связки', icon: 'link' }, { id: 'queue', label: 'Очередь', icon: 'clock' }, { id: 'deliveries', label: 'Доставка', icon: 'send' }, { id: 'connections', label: 'Подключения', icon: 'plug' }, { id: 'codex', label: 'Codex', icon: 'terminal' }];

class ErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <main className="auth-page"><div className="auth-panel"><div className="wordmark">Rele</div><h1>Не удалось открыть панель</h1><p className="muted">Обновите страницу. Если ошибка повторяется, проверьте журнал Rele.</p><Button onClick={() => window.location.reload()}>Обновить страницу</Button></div></main> : this.props.children; }
}

export function App() { return <ErrorBoundary><Session /></ErrorBoundary>; }

function Session() {
  const [token, setToken] = useState(initialToken);
  const [authError, setAuthError] = useState('');
  const signOut = useCallback(() => { saveToken(''); setToken(''); }, []);
  const unauthorized = useCallback(() => { signOut(); setAuthError('Токен панели не принят. Введите действующий токен.'); }, [signOut]);
  const signIn = (next: string) => { saveToken(next); setAuthError(''); setToken(next); };
  return token ? <Dashboard key={token} token={token} onUnauthorized={unauthorized} onSignOut={signOut}/> : <SignIn error={authError} onSignIn={signIn}/>;
}

function SignIn({ error, onSignIn }: { error: string; onSignIn: (token: string) => void }) {
  const [token, setToken] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); if (token.trim()) onSignIn(token.trim()); };
  return <main className="auth-page"><div className="auth-panel"><div className="wordmark">Rele</div><h1>Вход в панель</h1><p className="muted">Откройте ссылку из запуска Rele или введите токен доступа к локальной панели.</p><form className="form-stack" onSubmit={submit}><Field label="Токен панели"><input type="password" autoFocus autoComplete="off" required value={token} onChange={event => setToken(event.target.value)} placeholder="Токен доступа"/></Field>{error && <Notice>{error}</Notice>}<Button type="submit" variant="primary" disabled={!token.trim()}>Открыть Rele</Button></form><p className="auth-note">Токен действует в этой вкладке и удаляется при выходе из панели.</p></div></main>;
}

function Dashboard({ token, onUnauthorized, onSignOut }: { token: string; onUnauthorized: () => void; onSignOut: () => void }) {
  const [view, setView] = useState<View>('conversations');
  const api = useMemo(() => new ReleApi(token, onUnauthorized), [token, onUnauthorized]);
  const { state, error, loading, refresh } = useDashboard(api);
  useEffect(() => { document.title = `Rele — ${navigation.find(item => item.id === view)?.label}`; }, [view]);
  return <div className="app-shell"><a className="skip-link" href="#main-content">Перейти к содержимому</a><aside className="sidebar"><div className="wordmark">Rele</div><nav aria-label="Основная навигация">{navigation.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}><Icon name={item.icon}/><span>{item.label}</span>{item.id === 'queue' && !!state?.approvals.filter(approval => approval.status === 'pending').length && <span className="nav-attention" aria-label="Есть запросы подтверждения"/>}</button>)}</nav><footer className="sidebar-footer"><span>Локальный шлюз</span><small>v{state?.version ?? '0.1.0-rc.1'}</small>{state && <Status tone={error ? 'warning' : 'good'}>{error ? 'Нет связи с Rele' : 'Панель подключена'}</Status>}<Button variant="quiet" icon="logout" onClick={onSignOut}>Выйти</Button></footer></aside><main id="main-content" className="main-content" tabIndex={-1}>{error && <div className="connection-error"><Notice>{error}{state && ' Отображаются последние полученные данные.'}</Notice><Button icon="refresh" onClick={() => void refresh()}>Повторить</Button></div>}{loading && !state && <div className="loading-state" role="status"><span className="spinner"/><h1>Подключаемся к Rele…</h1><p>Загружаем связки и состояние подключений.</p></div>}{!loading && !state && !error && <Notice>Данные панели недоступны. Обновите страницу.</Notice>}{state && <>{view === 'conversations' && <Conversations state={state} api={api} refresh={refresh} onNavigate={setView}/>} {view === 'queue' && <Queue state={state} api={api} refresh={refresh}/>} {view === 'deliveries' && <Deliveries state={state} api={api} refresh={refresh}/>} {view === 'connections' && <Connections state={state} api={api} refresh={refresh} onCodex={() => setView('codex')}/>} {view === 'codex' && <CodexSettings state={state} api={api} refresh={refresh}/>}</>}</main></div>;
}
