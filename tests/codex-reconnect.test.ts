import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexConnectionState } from '../src/shared/types.js';
import { waitForCodexReconnect } from '../src/server/codex-reconnect.js';

afterEach(() => vi.useRealTimers());

function fixture() {
  const events = new EventEmitter();
  let state: CodexConnectionState = { configured: true, connected: false, queueSupported: false, desktopVerified: false };
  const client = Object.assign(events, {
    status: () => state,
    isVerifiedVersion: () => state.name === 'Codex 0.166.0-alpha.5.1',
    connect: vi.fn(async () => { throw new Error('first transient connection failure'); }),
    close: vi.fn(async () => { state = { ...state, connected: false, queueSupported: false }; events.emit('status'); }),
  });
  return { client, set: (value: Partial<CodexConnectionState>) => { state = { ...state, ...value }; events.emit('status'); } };
}

describe('Codex update reconnect postflight', () => {
  it('waits for existing backoff to recover the expected home/version/queue after a transient failure', async () => {
    const f = fixture();
    const waiting = waitForCodexReconnect(f.client, { version: '0.166.0-alpha.5.1', home: '/original-profile', queueSupported: true });
    let done = false;
    void waiting.then(() => { done = true; });
    f.set({ connected: true, name: 'Codex 0.166.0-alpha.5.1', codexHome: '/original-profile' });
    await Promise.resolve();
    expect(done).toBe(false);
    f.set({ queueSupported: true });
    await waiting;
    expect(f.client.connect).toHaveBeenCalledTimes(1);
    expect(f.client.listenerCount('status')).toBe(0);
  });

  it('refuses a different connected profile without accepting a supported version alone', async () => {
    const f = fixture();
    const waiting = waitForCodexReconnect(f.client, { version: '0.166.0-alpha.5.1', home: '/original-profile' });
    const rejected = expect(waiting).rejects.toMatchObject({ statusCode: 503, reasonCode: 'uncertain' });
    f.set({ connected: true, name: 'Codex 0.166.0-alpha.5.1', codexHome: '/other-profile' });
    await rejected;
    expect(f.client.close).toHaveBeenCalledTimes(1);
    expect(f.client.status().connected).toBe(false);
    expect(f.client.listenerCount('status')).toBe(0);
  });

  it('bounds waiting and leaves the normal reconnect mechanism running', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const waiting = waitForCodexReconnect(f.client, { home: '/original-profile' }, { timeoutMs: 200 });
    const rejected = expect(waiting).rejects.toMatchObject({ statusCode: 503, reasonCode: 'uncertain' });
    await vi.advanceTimersByTimeAsync(200);
    await rejected;
    expect(f.client.connect).toHaveBeenCalledTimes(1);
    expect(f.client.listenerCount('status')).toBe(0);
  });
});
