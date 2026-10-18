import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type IconName = 'link' | 'clock' | 'send' | 'plug' | 'terminal' | 'search' | 'refresh' | 'plus' | 'close' | 'pause' | 'play' | 'logout' | 'check' | 'warning' | 'arrow';
const paths: Record<IconName, ReactNode> = {
  link: <><path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>,
  send: <><path d="m21 3-7 18-4-7-7-4L21 3Z"/><path d="m10 14 5-5"/></>,
  plug: <><path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v4"/></>,
  terminal: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8m-8 4h4"/></>,
  search: <><circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 2l1 4M4 12l1 4a8 8 0 0 0 13 2"/></>,
  plus: <path d="M12 4v16M4 12h16"/>, close: <path d="m6 6 12 12M6 18 18 6"/>,
  pause: <><path d="M8 5v14M16 5v14"/></>, play: <path d="m7 4 13 8-13 8V4Z"/>,
  logout: <><path d="M10 4H5v16h5m5-4 4-4-4-4m-6 4h10"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  warning: <><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
};
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return <svg className={`icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function PlatformIcon({ platform }: { platform: 'telegram' | 'slack' }) {
  return platform === 'telegram'
    ? <svg className="platform-icon" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#229ed9"/><path d="m7 15 18-7-3 17-6-5-4 3 1-6 9-7-11 7-4-2Z" fill="white"/></svg>
    : <svg className="platform-icon" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><g strokeWidth="5" strokeLinecap="round"><path d="M12 4v9m-8-1h1" stroke="#36c5f0"/><path d="M20 4h1m-1 8h9" stroke="#2eb67d"/><path d="M20 20v9m8-9h1" stroke="#ecb22e"/><path d="M4 20h9m-1 8v1" stroke="#e01e5a"/></g></svg>;
}

export function Button({ children, variant = 'secondary', busy, icon, className = '', disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; busy?: boolean; icon?: IconName }) {
  return <button type="button" {...props} className={`button button-${variant} ${className}`} disabled={disabled || busy} aria-busy={busy || undefined}>{busy ? <span className="spinner" aria-hidden="true"/> : icon && <Icon name={icon}/>}<span>{children}</span></button>;
}

export function PageHeading({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <header className="page-heading"><div><h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function Notice({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'success' | 'info' | 'warning' }) {
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function ActionMessages({ error, success }: { error: string; success: string }) {
  return <>{error && <Notice>{error}</Notice>}{success && <Notice tone="success">{success}</Notice>}</>;
}

export function EmptyState({ title, children, action, icon = 'link' }: { title: string; children: ReactNode; action?: ReactNode; icon?: IconName }) {
  return <div className="empty-state"><div className="empty-icon"><Icon name={icon}/></div><h2>{title}</h2><p>{children}</p>{action}</div>;
}

export function Status({ children, tone = 'muted' }: { children: ReactNode; tone?: 'good' | 'muted' | 'bad' | 'warning' }) {
  return <span className={`status status-${tone}`}><span className="status-dot" aria-hidden="true"/>{children}</span>;
}

export function Drawer({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => { dialog?.close(); }; }, []);
  return <dialog ref={ref} className="drawer" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="drawer-header"><h2 id={titleId}>{title}</h2><Button variant="quiet" icon="close" aria-label="Закрыть" onClick={onClose}><span className="sr-only">Закрыть</span></Button></div>
    <div className="drawer-content">{children}</div>
  </dialog>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}

export function formatDate(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Дата неизвестна' : new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

export const requestLabels: Record<string, string> = { queued: 'В очереди', transcribing: 'Распознавание', starting: 'Запускается', running: 'Выполняется', waiting_approval: 'Нужно подтверждение', completed: 'Завершён', failed: 'Ошибка', interrupted: 'Прерван', cancelled: 'Отменён', uncertain: 'Нужно проверить' };
export const deliveryLabels: Record<string, string> = { pending: 'Ожидает отправки', sending: 'Отправляется', sent: 'Доставлено', failed: 'Ошибка доставки', uncertain: 'Доставка не подтверждена', cancelled: 'Отменено' };
export function statusTone(status: string): 'good' | 'muted' | 'bad' | 'warning' {
  return ['completed', 'sent', 'running'].includes(status) ? 'good' : status === 'failed' ? 'bad' : ['uncertain', 'waiting_approval'].includes(status) ? 'warning' : 'muted';
}
