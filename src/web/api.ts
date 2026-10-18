import type { DashboardState } from '../shared/types';

const TOKEN_KEY = 'rele.panelToken';

export function initialToken(): string {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const supplied = fragment.get('token');
  if (supplied !== null) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    saveToken(supplied);
    return supplied;
  }
  try { return window.sessionStorage.getItem(TOKEN_KEY) ?? ''; }
  catch { return ''; }
}

export function saveToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* The in-memory session still works when browser storage is disabled. */ }
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export class ReleApi {
  constructor(private token: string, private onUnauthorized: () => void) {}

  async request<T = unknown>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError('Нет связи с Rele. Проверьте, что приложение запущено, и повторите попытку.', 0);
    }
    const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) {
      if (response.status === 401) this.onUnauthorized();
      const message = response.status === 401 ? 'Токен панели не принят. Введите действующий токен.'
        : typeof payload?.message === 'string' ? payload.message
        : typeof payload?.error === 'string' ? payload.error
        : `Не удалось выполнить запрос (${response.status}). Повторите попытку.`;
      throw new ApiError(message, response.status);
    }
    return payload as T;
  }

  state(signal?: AbortSignal): Promise<DashboardState> { return this.request('/api/state', 'GET', undefined, signal); }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие. Повторите попытку.';
}

export function safeHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}
