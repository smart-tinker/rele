import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Origin, ReleRequest, RequestStatus } from '../src/shared/types.js';
import { SlackActivity } from '../src/server/slack-activity.js';
import type { SlackSessionStatus } from '../src/server/channels/common.js';

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

function make(initial: ReleRequest[] = [], saved?: { getMeta(key: string): string | undefined; setMeta(key: string, value: string): void }) {
  let rows = initial;
  const send = vi.fn<(origin: Origin, status: SlackSessionStatus) => Promise<void>>().mockResolvedValue(undefined);
  const diagnostic = vi.fn();
  const activity = new SlackActivity(() => rows, send, diagnostic, saved);
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
  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)('recovers a busy origin after a crash with only a %s request left', async status => {
    const meta = new Map<string, string>();
    const saved = { getMeta: (key: string) => meta.get(key), setMeta: (key: string, value: string) => { meta.set(key, value); } };
    const first = make([request()], saved);
    first.activity.refresh(); await settle();
    expect(sentStatuses(first.send)).toEqual(['processing']);
    const restarted = make([request(status)], saved);
    restarted.activity.refresh(); await settle();
    expect(restarted.send).toHaveBeenCalledExactlyOnceWith(request().origin, 'active');
    const settled = make([], saved);
    settled.activity.refresh(); await settle();
    expect(settled.send).not.toHaveBeenCalled();
  });

  it('restores a busy origin without clearing another running request in the same thread', async () => {
    const meta = new Map<string, string>();
    const saved = { getMeta: (key: string) => meta.get(key), setMeta: (key: string, value: string) => { meta.set(key, value); } };
    const first = make([request('waiting_approval')], saved);
    first.activity.refresh(); await settle();
    const restarted = make([request('completed'), { ...request(), id: 'next' }], saved);
    restarted.activity.refresh(); await settle();
    expect(sentStatuses(restarted.send)).toEqual(['processing']);
    restarted.set([]); restarted.activity.refresh(); await settle();
    expect(sentStatuses(restarted.send)).toEqual(['processing', 'active']);
  });

  it.each(['busy', 'clear'] as const)('retains a recovery target after a lost %s acknowledgement', async phase => {
    const meta = new Map<string, string>();
    const saved = { getMeta: (key: string) => meta.get(key), setMeta: (key: string, value: string) => { meta.set(key, value); } };
    const first = make([request()], saved);
    if (phase === 'busy') first.send.mockRejectedValueOnce(new Error('Lost busy ACK'));
    first.activity.refresh(); await settle();
    if (phase === 'clear') {
      first.send.mockRejectedValueOnce(new Error('Lost clear ACK'));
      first.set([]); first.activity.refresh(); await settle();
    }
    const restarted = make([], saved);
    restarted.activity.refresh(); await settle();
    expect(restarted.send).toHaveBeenCalledExactlyOnceWith(request().origin, 'active');
    expect(first.diagnostic).toHaveBeenCalledOnce();
  });

  it('rejects invalid saved origins while continuing to represent current requests', async () => {
    const { activity, send, diagnostic } = make([request()], { getMeta: () => '[{"platform":"slack"}]', setMeta: () => {} });
    activity.refresh(); await settle();
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledExactlyOnceWith(request().origin, 'processing');
  });

  it('prioritizes suspended approvals over processing and coalesces work in a shared thread', async () => {
    const running = request();
    const transcribing = { ...request('transcribing'), id: 'transcribing' };
    const waiting = (['queued', 'starting', 'uncertain'] as const).map(status => ({ ...request(status), id: status }));
    const approval = { ...request('waiting_approval'), id: 'approval' };
    const { activity, send, set } = make([approval, ...waiting, transcribing, running]);
    activity.refresh();
    await settle();
    activity.refresh();
    expect(sentStatuses(send)).toEqual(['suspended']);
    set([...waiting, transcribing, running]);
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['suspended', 'processing']);
    set([...waiting, transcribing]);
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['suspended', 'processing']);
    set(waiting);
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['suspended', 'processing', 'active']);
    set([]);
    activity.refresh();
    await settle();
    activity.refresh();
    expect(sentStatuses(send)).toEqual(['suspended', 'processing', 'active']);
  });

  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)('clears native status on %s without repeated clear calls', async status => {
    const { activity, send, set } = make([request()]);
    activity.refresh();
    await settle();
    set([request(status)]);
    activity.refresh();
    await settle();
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['processing', 'active']);
  });

  it.each([
    ['queued', 'active'], ['starting', 'active'], ['waiting_approval', 'suspended'], ['uncertain', 'active'],
    ['transcribing', 'processing'],
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
    expect(sentStatuses(send)).toEqual(['processing', 'active']);
    for (let i = 0; i < 10; i++) activity.refresh();
    await vi.advanceTimersByTimeAsync(180_000);
    activity.refresh(true);
    await settle();
    expect(sentStatuses(send)).toEqual(['processing', 'active']);
    set([request('starting')]);
    activity.refresh();
    await settle();
    set([queued]);
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['processing', 'active']);
    set([request()]);
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['processing', 'active', 'processing']);
  });

  it('renews suspended approval status and resumes processing after approval', async () => {
    const { activity, send, set } = make([request()]);
    activity.start();
    await settle();
    set([request('waiting_approval')]);
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['processing', 'suspended']);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(sentStatuses(send)).toEqual(['processing', 'suspended', 'suspended']);
    activity.refresh(true);
    await settle();
    expect(sentStatuses(send)).toEqual(['processing', 'suspended', 'suspended', 'suspended']);
    set([request()]);
    activity.refresh();
    await settle();
    expect(sentStatuses(send)).toEqual(['processing', 'suspended', 'suspended', 'suspended', 'processing']);
  });

  it('clears a suspended approval after completion and culls its heartbeat target', async () => {
    const { activity, send, set } = make([request('waiting_approval')]);
    activity.start();
    await settle();
    set([request('completed')]);
    activity.refresh();
    await settle();
    await vi.advanceTimersByTimeAsync(90_000);
    activity.refresh(true);
    await settle();
    expect(sentStatuses(send)).toEqual(['suspended', 'active']);
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

  it('keeps two parallel threads processing when one finishes or waits for approval', async () => {
    const first = request();
    const second = { ...request('running', { threadId: '200.1' }), id: 'second', conversationId: 'second-conversation' };
    const { activity, send, set } = make([first, second]);
    activity.start(); await settle();
    expect(send.mock.calls.map(([origin, status]) => [origin.threadId, status])).toEqual([['100.1', 'processing'], ['200.1', 'processing']]);
    set([{ ...first, status: 'waiting_approval' }, second]); activity.refresh(); await settle();
    expect(send.mock.calls.at(-1)?.map(value => typeof value === 'object' ? value.threadId : value)).toEqual(['100.1', 'suspended']);
    set([{ ...first, status: 'completed' }, second]); activity.refresh(); await settle();
    await vi.advanceTimersByTimeAsync(45_000);
    const secondWrites = send.mock.calls.filter(([origin]) => origin.threadId === second.origin.threadId);
    expect(secondWrites.map(([, status]) => status)).toEqual(['processing', 'processing']);
    expect(send.mock.calls.filter(([origin]) => origin.threadId === first.origin.threadId).map(([, status]) => status)).toEqual(['processing', 'suspended', 'active']);
  });

  it('does not block the second thread behind a slow or failed status write for the first', async () => {
    const slow = deferred();
    const { activity, send } = make([request(), { ...request('running', { threadId: '200.1' }), id: 'second' }]);
    send.mockImplementationOnce(() => slow.promise);
    activity.start(); await settle();
    expect(send.mock.calls.map(([origin, status]) => [origin.threadId, status])).toEqual([['100.1', 'processing'], ['200.1', 'processing']]);
    slow.reject(new Error('First thread status unavailable')); await settle();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(send.mock.calls.filter(([origin]) => origin.threadId === '200.1').map(([, status]) => status)).toEqual(['processing', 'processing']);
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
    expect(sentStatuses(send)).toEqual(['processing']);
    pending.resolve();
    await settle();
    expect(sentStatuses(send)).toEqual(['processing', 'active']);
  });

  it('reasserts activity after delivery invalidation even if a status write was already in flight', async () => {
    const pending = deferred();
    const { activity, send } = make([request()]);
    send.mockImplementationOnce(() => pending.promise);
    activity.refresh();
    activity.refresh(true);
    pending.resolve();
    await settle();
    expect(sentStatuses(send)).toEqual(['processing', 'processing']);
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
    expect(sentStatuses(send)).toEqual(['processing', 'processing', 'active']);
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
    expect(sentStatuses(send)).toEqual(['processing', 'active']);
  });

  it.each(['running', 'waiting_approval'] as const)('waits for an in-flight %s write and then clears during stop', async status => {
    const pending = deferred();
    const { activity, send } = make([request(status)]);
    send.mockImplementationOnce(() => pending.promise);
    activity.start();
    let stopped = false;
    const stopping = activity.stop().then(() => { stopped = true; });
    await settle();
    expect(stopped).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    pending.resolve();
    await stopping;
    expect(sentStatuses(send)).toEqual([status === 'running' ? 'processing' : 'suspended', 'active']);
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
