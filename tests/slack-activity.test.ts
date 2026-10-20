import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Origin, ReleRequest, RequestStatus } from '../src/shared/types.js';
import { SlackActivity } from '../src/server/slack-activity.js';

const activities: SlackActivity[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const activity of activities.splice(0)) await activity.stop();
  vi.useRealTimers();
});

function request(status: RequestStatus = 'running', extra: Partial<Origin> = {}): ReleRequest {
  return {
    id: 'request', conversationId: 'conversation', eventId: 'event', text: 'Question', status,
    origin: { platform: 'slack', accountId: 'T1:UBOT', endpointId: 'endpoint', chatId: 'C1', threadId: '100.1', senderId: 'U1', senderName: 'User', messageId: '100.2', ...extra },
    createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
  };
}

function make(initial: ReleRequest[] = []) {
  let rows = initial;
  const send = vi.fn<(origin: Origin, status: string) => Promise<void>>().mockResolvedValue(undefined);
  const diagnostic = vi.fn();
  const activity = new SlackActivity(() => rows, send, diagnostic);
  activities.push(activity);
  return { activity, send, diagnostic, set: (next: ReleRequest[]) => { rows = next; } };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const sentStatuses = (send: ReturnType<typeof make>['send']) => send.mock.calls.map(([, status]) => status);

describe('Slack request activity', () => {
  it('prefers actual work over waiting requests in a shared thread and clears when only waiting remains', async () => {
    const running = request();
    const transcribing = { ...request('transcribing'), id: 'transcribing' };
    const waiting = (['queued', 'starting', 'waiting_approval', 'uncertain'] as const).map(status => ({ ...request(status), id: status }));
    const { activity, send, set } = make([...waiting, transcribing, running]);
    activity.refresh();
    await settle();
    activity.refresh();
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…']);
    set([...waiting, transcribing]);
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…', 'Распознаёт аудио…']);
    set(waiting);
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…', 'Распознаёт аудио…', '']);
    set([]);
    activity.refresh();
    await settle();
    activity.refresh();
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…', 'Распознаёт аудио…', '']);
  });

  it.each(['completed', 'failed', 'cancelled', 'interrupted', 'uncertain'] as const)('clears native status on %s without repeated clear calls', async status => {
    const { activity, send, set } = make([request()]);
    activity.refresh();
    await settle();
    set([request(status)]);
    activity.refresh();
    await settle();
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…', '']);
  });

  it.each([
    ['queued', ''], ['starting', ''], ['waiting_approval', ''], ['uncertain', ''],
    ['transcribing', 'Распознаёт аудио…'],
  ] as const)('represents persisted %s requests', async (status, label) => {
    const { activity, send } = make([request(status)]);
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual([label]);
  });

  it('keeps a foreign-busy request clear through retries and heartbeats until execution starts', async () => {
    const queued = { ...request('queued'), error: 'Codex thread is busy in another client.' };
    const { activity, send, set } = make([request()]);
    activity.start();
    await settle();
    set([queued]);
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…', '']);
    for (let i = 0; i < 10; i++) activity.refresh();
    await vi.advanceTimersByTimeAsync(180_000);
    activity.refresh(true);
    await settle();
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…', '']);
    set([request('starting')]);
    activity.refresh();
    await settle();
    set([queued]);
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…', '']);
    set([request()]);
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…', '', 'Выполняет запрос…']);
  });

  it('clears processing while approval is pending and resumes after approval', async () => {
    const { activity, send, set } = make([request()]);
    activity.start();
    await settle();
    set([request('waiting_approval')]);
    activity.refresh();
    await settle();
    await vi.advanceTimersByTimeAsync(90_000);
    activity.refresh(true);
    await settle();
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…', '']);
    set([request()]);
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…', '', 'Выполняет запрос…']);
  });

  it('uses only persisted Slack origins and keeps account, chat and thread targets separate', async () => {
    const { activity, send, set } = make([request('running', { platform: 'telegram' })]);
    activity.refresh();
    await settle();
    expect(send).not.toHaveBeenCalled();
    set([request(), request('running', { accountId: 'T2:UBOT' }), request('transcribing', { chatId: 'C2' }), request('running', { threadId: '200.1' })]);
    activity.refresh();
    await settle();
    expect(send.mock.calls.map(([origin]) => [origin.accountId, origin.chatId, origin.threadId])).toEqual([
      ['T1:UBOT', 'C1', '100.1'], ['T2:UBOT', 'C1', '100.1'], ['T1:UBOT', 'C2', '100.1'], ['T1:UBOT', 'C1', '200.1'],
    ]);
  });

  it('serializes slow writes and coalesces intermediate states before clearing a quick completion', async () => {
    const pending = deferred();
    const { activity, send, set } = make([request('transcribing')]);
    send.mockImplementationOnce(() => pending.promise);
    activity.refresh();
    set([request('starting')]);
    activity.refresh();
    set([request()]);
    activity.refresh();
    set([]);
    activity.refresh();
    expect(sentStatuses(send)).toEqual(['Распознаёт аудио…']);
    pending.resolve();
    await settle();
    expect(sentStatuses(send)).toEqual(['Распознаёт аудио…', '']);
  });

  it('reasserts activity after delivery invalidation even if a status write was already in flight', async () => {
    const pending = deferred();
    const { activity, send } = make([request()]);
    send.mockImplementationOnce(() => pending.promise);
    activity.refresh();
    activity.refresh(true);
    pending.resolve();
    await settle();
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…', 'Выполняет запрос…']);
  });

  it('renews busy statuses before Slack expires them and stops the heartbeat at shutdown', async () => {
    const { activity, send } = make([request()]);
    activity.start();
    await settle();
    await vi.advanceTimersByTimeAsync(44_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await activity.stop();
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…', 'Выполняет запрос…', '']);
    await vi.advanceTimersByTimeAsync(180_000);
    activity.refresh();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('diagnoses status failures and backs off instead of retrying on each engine refresh', async () => {
    const failure = new Error('Synthetic Slack status failure');
    const { activity, send, diagnostic } = make([request()]);
    send.mockRejectedValueOnce(failure);
    activity.refresh();
    await settle();
    for (let i = 0; i < 10; i++) activity.refresh();
    await vi.advanceTimersByTimeAsync(14_999);
    activity.refresh();
    expect(send).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith(failure);
    await vi.advanceTimersByTimeAsync(1);
    activity.refresh();
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('clears after an in-flight failure when the request has already completed', async () => {
    const pending = deferred();
    const { activity, send, diagnostic, set } = make([request()]);
    send.mockImplementationOnce(() => pending.promise);
    activity.refresh();
    set([]);
    activity.refresh();
    pending.reject(new Error('Synthetic late failure'));
    await settle();
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…', '']);
  });

  it('waits for an in-flight write and then clears during stop', async () => {
    const pending = deferred();
    const { activity, send } = make([request()]);
    send.mockImplementationOnce(() => pending.promise);
    activity.start();
    let stopped = false;
    const stopping = activity.stop().then(() => { stopped = true; });
    await settle();
    expect(stopped).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    pending.resolve();
    await stopping;
    expect(sentStatuses(send)).toEqual(['Выполняет запрос…', '']);
    expect(stopped).toBe(true);
  });

  it('does not throw when shutdown clearing fails', async () => {
    const { activity, send, diagnostic } = make([request()]);
    activity.refresh();
    await settle();
    send.mockRejectedValueOnce(new Error('Synthetic clear failure'));
    await expect(activity.stop()).resolves.toBeUndefined();
    expect(diagnostic).toHaveBeenCalledOnce();
  });
});
