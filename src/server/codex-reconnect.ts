import path from 'node:path';
import type { CodexConnectionState } from '../shared/types.js';
import { CodexUpdateError } from './codex-update.js';

interface Client {
  status(): CodexConnectionState;
  isVerifiedVersion(): boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  on(event: 'status', listener: () => void): unknown;
  off(event: 'status', listener: () => void): unknown;
}

/** Observe the existing reconnect backoff; never repeat the native update. */
export async function waitForCodexReconnect(client: Client, expected: {
  version?: string; home?: string; queueSupported?: boolean;
}, options: { timeoutMs?: number; platform?: NodeJS.Platform } = {}): Promise<void> {
  const canonical = (value: string) => (options.platform ?? process.platform) === 'win32'
    ? path.resolve(value).toLowerCase() : path.resolve(value);
  await new Promise<void>((resolve, reject) => {
    let settled = false, rejectingIdentity = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off('status', check);
      error ? reject(error) : resolve();
    };
    const check = () => {
      if (settled || rejectingIdentity) return;
      const state = client.status();
      if (!state.connected) return;
      if (!client.isVerifiedVersion() || expected.version && state.name !== `Codex ${expected.version}`
        || expected.home && (!state.codexHome || canonical(state.codexHome) !== canonical(expected.home))) {
        rejectingIdentity = true;
        clearTimeout(timer);
        const error = new CodexUpdateError('Codex не подтвердил ожидаемую версию и исходный профиль. Очередь сохранена.', 503, 'uncertain');
        // Disconnect before Engine leaves maintenance and can pump its queue again.
        void client.close().then(() => finish(error), () => finish(error));
      } else if (!expected.queueSupported || state.queueSupported) finish();
    };
    const timer = setTimeout(() => finish(new CodexUpdateError(
      'Rele ещё ожидает подключения к Codex. Очередь сохранена; обновите состояние перед повтором операции.', 503, 'uncertain')),
    options.timeoutMs ?? 45_000);
    client.on('status', check);
    check();
    if (!settled) void client.connect().then(check, () => { /* Existing backoff continues. */ });
  });
}
