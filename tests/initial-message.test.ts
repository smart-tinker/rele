import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRpcError, CodexThreadBusyError, CodexTransportError, type CodexClient, type RequestLocation } from '../src/server/codex.js';
import { INITIAL_RELE_MESSAGE } from '../src/server/inbound-context.js';
import { InitialMessages, initialMessageKey } from '../src/server/initial-message.js';
import { Store } from '../src/server/store.js';
import type { CodexConnectionState, Endpoint } from '../src/shared/types.js';

const fixtures: Array<{ store: Store; directory: string }> = [];
afterEach(() => { for (const { store, directory } of fixtures.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }); } });

function fixture(bound = true) {
  const directory = mkdtempSync(join(tmpdir(), 'rele-initial-')), store = new Store(join(directory, 'rele.sqlite'));
  fixtures.push({ store, directory });
  const endpoint: Endpoint = { id: 'source', platform: 'slack', accountId: 'T:BOT', chatId: 'C', threadId: '1', title: 'Test', subtitle: '', people: [], updatedAt: '' };
  store.upsertEndpoint(endpoint);
  const conversation = store.createConversation({ name: 'Test', threadId: 'native-thread', cwd: '/project',
    bindings: bound ? [{ platform: 'slack', endpointId: endpoint.id, allowedSenderIds: ['U'] }] : [] });
  const status: CodexConnectionState = { configured: true, connected: true, queueSupported: true, desktopVerified: false, transport: 'websocket', codexHome: '/actual/profile' };
  let verified = true;
  const locations = new Map<string, RequestLocation>();
  const codex = {
    status: vi.fn(() => ({ ...status })), isVerifiedVersion: vi.fn(() => verified),
    subscribe: vi.fn<CodexClient['subscribe']>().mockResolvedValue(undefined), releaseThread: vi.fn<CodexClient['releaseThread']>().mockResolvedValue(undefined),
    enqueue: vi.fn<CodexClient['enqueue']>(async (_thread, _text, id) => {
      locations.set(id, { state: 'completed', turnId: 'initial-turn', text: 'NOREPLY' });
      return { queuedSubmissionId: `queue-${id}` };
    }),
    findRequest: vi.fn<CodexClient['findRequest']>(async (_thread, id) => locations.get(id) ?? { state: 'not_found' }),
    startQueued: vi.fn<CodexClient['startQueued']>().mockResolvedValue({ turn: { id: 'initial-turn', status: 'inProgress', items: [] } }),
  };
  const initial = new InitialMessages(store, () => codex);
  const key = () => initialMessageKey(status.codexHome!, conversation.threadId);
  const state = () => JSON.parse(store.getMeta(key()) ?? '{"applied":false}');
  return { store, conversation, endpoint, initial, codex, status, locations, key, state, setVerified: (value: boolean) => { verified = value; } };
}

describe('durable standalone initial Rele message', () => {
  it('persists submission intent before one visible native turn and applies only its completed NOREPLY', async () => {
    const f = fixture();
    f.codex.enqueue.mockImplementation(async (thread, text, id) => {
      expect(f.state()).toEqual({ applied: false, operation: { id, status: 'submitting' } });
      expect(thread).toBe(f.conversation.threadId); expect(text).toBe(INITIAL_RELE_MESSAGE);
      f.locations.set(id, { state: 'completed', turnId: 'initial-turn', text: ' \nNOREPLY\n ' });
      return { queuedSubmissionId: 'queue-1' };
    });
    expect(await f.initial.ensure(f.conversation.id)).toBe(true);
    expect(f.state()).toEqual({ applied: true });
    expect(await f.initial.ensure(f.conversation.id)).toBe(true);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1); expect(f.codex.startQueued).not.toHaveBeenCalled();
    expect(f.codex.subscribe).toHaveBeenCalledExactlyOnceWith(f.conversation.threadId);
    expect(f.codex.releaseThread).toHaveBeenCalledExactlyOnceWith(f.conversation.threadId);
    expect(f.store.listRequests()).toEqual([]); expect(f.store.listDeliveries()).toEqual([]);
  });

  it('coalesces explicit double clicks and permits a new standalone resend after success', async () => {
    const f = fixture(), first = f.initial.queue(f.conversation.id);
    expect(first.status).toBe('queued'); expect(f.initial.queue(f.conversation.id)).toEqual(first);
    expect(f.initial.hasPending(f.conversation.id)).toBe(true);
    expect(await f.initial.ensure(f.conversation.id)).toBe(true);
    const second = f.initial.queue(f.conversation.id); expect(second.operationId).not.toBe(first.operationId);
    expect(f.initial.queue(f.conversation.id)).toEqual(second);
    expect(await f.initial.ensure(f.conversation.id)).toBe(true);
    expect(f.codex.enqueue.mock.calls.map(([, text]) => text)).toEqual([INITIAL_RELE_MESSAGE, INITIAL_RELE_MESSAGE]);
  });

  it('waits on a foreign writer before recording an automatic submission and never releases an unacquired subscription', async () => {
    const f = fixture(); f.codex.subscribe.mockRejectedValue(new CodexThreadBusyError(f.conversation.threadId));
    expect(await f.initial.ensure(f.conversation.id)).toBe(false);
    expect(f.store.getMeta(f.key())).toBeUndefined(); expect(f.codex.enqueue).not.toHaveBeenCalled(); expect(f.codex.releaseThread).not.toHaveBeenCalled();
  });

  it.each(['failed', 'interrupted', 'completed'] as const)('keeps the confirmed initial instruction after an unsuccessful manual resend: %s', async status => {
    const f = fixture();
    expect(await f.initial.ensure(f.conversation.id)).toBe(true);
    const { operationId } = f.initial.queue(f.conversation.id);
    f.codex.enqueue.mockImplementation(async () => {
      f.locations.set(operationId, { state: status, turnId: 'resend-turn', text: 'unexpected answer' });
      return { queuedSubmissionId: 'resend-queue' };
    });
    expect(await f.initial.ensure(f.conversation.id)).toBe(true);
    expect(f.state()).toMatchObject({ applied: true, operation: { id: operationId, status: 'failed' } });
    expect(await new InitialMessages(f.store, () => f.codex).ensure(f.conversation.id)).toBe(true);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(2);
    expect(f.initial.queue(f.conversation.id).operationId).not.toBe(operationId);
  });

  it.each(['paused', 'disconnected', 'unverified', 'unsupported', 'active-request'])('does not acquire or enqueue while %s', async guard => {
    const f = fixture();
    if (guard === 'paused') f.store.updateConversation(f.conversation.id, { paused: true });
    if (guard === 'disconnected') f.status.connected = false;
    if (guard === 'unverified') f.setVerified(false);
    if (guard === 'unsupported') f.status.queueSupported = false;
    if (guard === 'active-request') {
      const request = f.store.ingest({ eventId: 'user-event', endpoint: f.endpoint, sender: { id: 'U', name: 'User' }, messageId: '2', text: 'ordinary' }).request!;
      f.store.updateRequest(request.id, { status: 'running' });
    }
    expect(await f.initial.ensure(f.conversation.id)).toBe(false);
    expect(f.codex.subscribe).not.toHaveBeenCalled(); expect(f.codex.enqueue).not.toHaveBeenCalled();
  });

  it('does not automatically initialize an unbound conversation, even before the native home is known', async () => {
    const f = fixture(false); delete f.status.codexHome;
    expect(await f.initial.ensure(f.conversation.id)).toBe(true); expect(f.codex.enqueue).not.toHaveBeenCalled();
    expect(() => f.initial.queue(f.conversation.id)).toThrow(/источник/u);
  });

  it('preserves unresolved metadata when the last binding is removed and reconciles the same ID after rebinding', async () => {
    const f = fixture(), id = randomUUID();
    const raw = JSON.stringify({ applied: false, operation: { id, status: 'uncertain', error: 'Ожидается сверка.' } });
    f.store.setMeta(f.key(), raw);
    f.store.removeBinding(f.conversation.id, f.store.getConversation(f.conversation.id)!.bindings[0].id);
    expect(await f.initial.ensure(f.conversation.id)).toBe(true);
    expect(f.codex.findRequest).not.toHaveBeenCalled(); expect(f.codex.subscribe).not.toHaveBeenCalled();
    expect(() => f.initial.queue(f.conversation.id)).toThrow(/источник/u);
    expect(f.store.getMeta(f.key())).toBe(raw);
    f.store.addBinding(f.conversation.id, 'slack', f.endpoint.id, ['U']);
    f.locations.set(id, { state: 'completed', turnId: 'initial-turn', text: 'NOREPLY' });
    expect(await f.initial.ensure(f.conversation.id)).toBe(true);
    expect(f.codex.findRequest).toHaveBeenCalledExactlyOnceWith(f.conversation.threadId, id); expect(f.codex.enqueue).not.toHaveBeenCalled();
  });

  it('requires the actual native profile for bound auto and manual messages', async () => {
    const f = fixture(); delete f.status.codexHome;
    expect(() => f.initial.queue(f.conversation.id)).toThrow(/профиль/u);
    await expect(f.initial.ensure(f.conversation.id)).rejects.toThrow(/профиль/u);
    expect(f.codex.subscribe).not.toHaveBeenCalled();
  });

  it('does not resend an unknown enqueue after restart and later applies the exact recovered receipt', async () => {
    const f = fixture(); f.codex.enqueue.mockRejectedValue(new CodexTransportError('synthetic lost ACK'));
    await expect(f.initial.ensure(f.conversation.id)).rejects.toThrow(/не подтверждена/u);
    const id = f.state().operation.id;
    const restarted = new InitialMessages(f.store, () => f.codex);
    expect(() => restarted.queue(f.conversation.id)).toThrow(/Повтор не выполнен/u);
    await expect(restarted.ensure(f.conversation.id)).rejects.toThrow(/не найдено/u);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1); expect(f.codex.startQueued).not.toHaveBeenCalled();
    f.locations.set(id, { state: 'completed', turnId: 'initial-turn', text: 'NOREPLY' });
    expect(await restarted.ensure(f.conversation.id)).toBe(true);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1); expect(f.codex.releaseThread).toHaveBeenCalledTimes(1);
  });

  it('reconciles a persisted submitting intent without re-enqueueing or claiming a new manual operation', async () => {
    const f = fixture(), id = randomUUID();
    f.store.setMeta(f.key(), JSON.stringify({ applied: false, operation: { id, status: 'submitting' } }));
    expect(() => f.initial.queue(f.conversation.id)).toThrow(/Повтор не выполнен/u);
    f.locations.set(id, { state: 'completed', turnId: 'initial-turn', text: 'NOREPLY' });
    expect(await f.initial.ensure(f.conversation.id)).toBe(true);
    expect(f.codex.enqueue).not.toHaveBeenCalled(); expect(f.codex.subscribe).not.toHaveBeenCalled(); expect(f.codex.releaseThread).not.toHaveBeenCalled();
  });

  it('starts a confirmed sole queued entry once and never blindly retries a lost queue/start ACK', async () => {
    const f = fixture();
    f.codex.enqueue.mockImplementation(async (_thread, _text, id) => {
      f.locations.set(id, { state: 'queued', queuedSubmissionId: 'queue-1', soleQueuedSubmission: true });
      return { queuedSubmissionId: 'queue-1' };
    });
    f.codex.startQueued.mockImplementation(async () => {
      expect(f.state().operation).toMatchObject({ status: 'running', queuedSubmissionId: 'queue-1' });
      throw new CodexTransportError('synthetic lost queue/start ACK');
    });
    await expect(f.initial.ensure(f.conversation.id)).rejects.toThrow(/Запуск.*не подтверждён/u);
    const id = f.state().operation.id;
    expect(f.codex.startQueued).toHaveBeenCalledExactlyOnceWith(f.conversation.threadId, 'queue-1');
    await expect(new InitialMessages(f.store, () => f.codex).ensure(f.conversation.id)).rejects.toThrow(/Запуск.*не подтверждён/u);
    expect(f.codex.startQueued).toHaveBeenCalledTimes(1); expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    f.locations.set(id, { state: 'completed', turnId: 'initial-turn', text: 'NOREPLY' });
    expect(await f.initial.ensure(f.conversation.id)).toBe(true);
  });

  it('does not start an entry ahead of another queued input or duplicate a native auto-drained turn', async () => {
    const f = fixture(), id = f.initial.queue(f.conversation.id).operationId;
    f.store.setMeta(f.key(), JSON.stringify({ applied: false, operation: { id, status: 'queued', queuedSubmissionId: 'queue-1' } }));
    f.locations.set(id, { state: 'queued', queuedSubmissionId: 'queue-1', soleQueuedSubmission: false });
    expect(await f.initial.ensure(f.conversation.id)).toBe(false); expect(f.codex.startQueued).not.toHaveBeenCalled();
    f.locations.set(id, { state: 'running', turnId: 'initial-turn' });
    expect(await f.initial.ensure(f.conversation.id)).toBe(false); expect(f.codex.startQueued).not.toHaveBeenCalled();
    f.locations.set(id, { state: 'completed', turnId: 'initial-turn', text: 'NOREPLY' });
    expect(await f.initial.ensure(f.conversation.id)).toBe(true); expect(f.codex.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    { state: 'completed', turnId: 'initial-turn', text: 'NOREPLY because it is complete' },
    { state: 'completed', turnId: 'initial-turn', text: 'NOREPLY', mixed: true },
    { state: 'failed', turnId: 'initial-turn' },
    { state: 'interrupted', turnId: 'initial-turn' },
  ] satisfies RequestLocation[])('requires explicit retry after a confirmed unsuccessful turn: %j', async found => {
    const f = fixture(), id = f.initial.queue(f.conversation.id).operationId;
    f.codex.enqueue.mockImplementation(async () => { f.locations.set(id, found); return { queuedSubmissionId: 'queue-1' }; });
    await expect(f.initial.ensure(f.conversation.id)).rejects.toThrow(/без подтверждённого NOREPLY/u);
    await expect(f.initial.ensure(f.conversation.id)).rejects.toThrow(/без подтверждённого NOREPLY/u);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1); expect(f.state().applied).toBe(false);
    expect(f.initial.queue(f.conversation.id).operationId).not.toBe(id);
  });

  it('does not start again after a mixed running receipt, even without the earlier enqueue ACK', async () => {
    const f = fixture(), id = randomUUID();
    f.store.setMeta(f.key(), JSON.stringify({ applied: false, operation: { id, status: 'submitting' } }));
    f.locations.set(id, { state: 'running', turnId: 'initial-turn', mixed: true });
    await expect(f.initial.ensure(f.conversation.id)).rejects.toThrow(/чужой ввод/u);
    f.locations.set(id, { state: 'queued', queuedSubmissionId: 'queue-1', soleQueuedSubmission: true });
    await expect(f.initial.ensure(f.conversation.id)).rejects.toThrow(/чужой ввод/u);
    expect(f.codex.startQueued).not.toHaveBeenCalled(); expect(f.codex.enqueue).not.toHaveBeenCalled();
  });

  it('keeps completion scoped to the normalized actual profile and native thread', async () => {
    const f = fixture(); f.status.codexHome = 'C:\\Users\\Alice\\.codex\\';
    expect(await f.initial.ensure(f.conversation.id)).toBe(true);
    f.status.codexHome = 'c:/users/ALICE/.codex';
    expect(await new InitialMessages(f.store, () => f.codex).ensure(f.conversation.id)).toBe(true);
    expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
    f.status.codexHome = 'C:\\Users\\Other\\.codex';
    expect(await f.initial.ensure(f.conversation.id)).toBe(true); expect(f.codex.enqueue).toHaveBeenCalledTimes(2);
    expect(initialMessageKey('/a/b/../profile/', 'thread')).toBe(`initial-rele-message:v1:${createHash('sha256').update(JSON.stringify(['/a/profile', 'thread'])).digest('hex')}`);
    expect(initialMessageKey('/a/profile', 'thread')).not.toBe(initialMessageKey('/a/profile', 'another-thread'));
  });

  it('does not enqueue if Engine stops while subscribe is awaiting, and releases only the acquired subscription', async () => {
    const f = fixture(); let canWork = true, acquired!: () => void;
    f.codex.subscribe.mockImplementation(() => new Promise(resolve => { acquired = () => resolve(); }));
    const initial = new InitialMessages(f.store, () => f.codex, () => canWork);
    const pending = initial.ensure(f.conversation.id);
    await vi.waitFor(() => expect(f.codex.subscribe).toHaveBeenCalledOnce());
    canWork = false; acquired();
    expect(await pending).toBe(false); expect(f.codex.enqueue).not.toHaveBeenCalled();
    expect(f.store.getMeta(f.key())).toBeUndefined(); expect(f.codex.releaseThread).toHaveBeenCalledExactlyOnceWith(f.conversation.threadId);
  });

  it('does not mistake an unresolved steered input for the controlling native turn', async () => {
    const f = fixture();
    const request = f.store.ingest({ eventId: 'steered', endpoint: f.endpoint, sender: { id: 'U', name: 'User' }, messageId: '2', text: 'input' }).request!;
    vi.spyOn(f.store, 'activeRequests').mockReturnValue([{ ...request, status: 'uncertain', steeredInto: 'completed-parent' }]);
    expect(await f.initial.ensure(f.conversation.id)).toBe(true); expect(f.codex.enqueue).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent ensure calls while native enqueue is still awaiting its ACK', async () => {
    const f = fixture(); let finish!: () => void;
    f.codex.enqueue.mockImplementation((_thread, _text, id) => new Promise(resolve => { finish = () => {
      f.locations.set(id, { state: 'completed', turnId: 'initial-turn', text: 'NOREPLY' }); resolve({ queuedSubmissionId: 'queue-1' });
    }; }));
    const first = f.initial.ensure(f.conversation.id);
    await vi.waitFor(() => expect(f.codex.enqueue).toHaveBeenCalledTimes(1));
    expect(await f.initial.ensure(f.conversation.id)).toBe(false); finish();
    expect(await first).toBe(true); expect(f.codex.enqueue).toHaveBeenCalledTimes(1);
  });

  it('never overwrites corrupt durable state with a new automatic or explicit submission', async () => {
    const f = fixture(); f.store.setMeta(f.key(), '{broken');
    expect(() => f.initial.queue(f.conversation.id)).toThrow(/повреждено/u);
    await expect(f.initial.ensure(f.conversation.id)).rejects.toThrow(/повреждено/u);
    expect(f.codex.enqueue).not.toHaveBeenCalled(); expect(f.store.getMeta(f.key())).toBe('{broken');
  });
});
