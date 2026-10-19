import type { DashboardState } from '../shared/types';

const TOKEN_KEY = 'rele.panelToken';

export interface InitialSession {
  token: string;
  launchToken?: string;
}

export function initialSession(): InitialSession {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const launchToken = fragment.get('rele-launch');
  const supplied = fragment.get('token');
  if (launchToken !== null || supplied !== null) {
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search,
    );
  }
  if (launchToken !== null) {
    saveToken('');
    return { token: '', launchToken };
  }
  if (supplied !== null) {
    saveToken(supplied);
    return { token: supplied };
  }
  try {
    return { token: window.sessionStorage.getItem(TOKEN_KEY) ?? '' };
  } catch {
    return { token: '' };
  }
}

export async function exchangeLaunchToken(token: string): Promise<string> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/api/session/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      if ([400, 401, 403, 410].includes(response.status))
        throw new ApiError(
          'Ссылка для входа истекла или уже использована. Откройте Rele ещё раз ярлыком или командой запуска либо введите токен панели.',
          response.status,
        );
      throw new ApiError(
        'Не удалось открыть Rele по ссылке. Запустите приложение ещё раз либо введите токен панели.',
        response.status,
      );
    }
    if (typeof payload?.key !== 'string' || !payload.key)
      throw new ApiError(
        'Rele не вернул ключ доступа. Откройте приложение ещё раз.',
        0,
      );
    return payload.key;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      'Нет связи с Rele. Проверьте, что приложение запущено, и откройте его ещё раз либо введите токен панели.',
      0,
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

export function saveToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* The in-memory session still works when browser storage is disabled. */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export class ReleApi {
  constructor(
    private token: string,
    private onUnauthorized: () => void,
  ) {}

  async request<T = unknown>(
    path: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError')
        throw error;
      throw new ApiError(
        'Нет связи с Rele. Проверьте, что приложение запущено, и повторите попытку.',
        0,
      );
    }
    const payload =
      response.status === 204
        ? undefined
        : await response.json().catch(() => undefined);
    if (!response.ok) {
      if (response.status === 401) this.onUnauthorized();
      const message =
        response.status === 401
          ? 'Токен панели не принят. Введите действующий токен.'
          : typeof payload?.message === 'string'
            ? payload.message
            : typeof payload?.error === 'string'
              ? payload.error
              : `Не удалось выполнить запрос (${response.status}). Повторите попытку.`;
      throw new ApiError(message, response.status);
    }
    return payload as T;
  }

  state(signal?: AbortSignal): Promise<DashboardState> {
    return this.request('/api/state', 'GET', undefined, signal);
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Не удалось выполнить действие. Повторите попытку.';
}

export function safeHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
