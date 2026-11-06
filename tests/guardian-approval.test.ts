import { describe, expect, it, vi } from 'vitest';
import { CodexClient, CodexTransportError } from '../src/server/codex.js';
import { GUARDIAN_APPROVAL_CODEX_VERSION, parseGuardianDenial } from '../src/server/guardian-approval.js';

const denial = {
  threadId: 'thread-1', turnId: 'turn-1', reviewId: 'review-1', targetItemId: null,
  startedAtMs: 1_000, completedAtMs: 1_100, decisionSource: 'agent',
  review: { status: 'denied', riskLevel: 'high', userAuthorization: 'low', rationale: 'Confirmation needed' },
  action: { type: 'command', source: 'unifiedExec', command: 'printf %s approval-fixture', cwd: '/tmp/fixture' },
};

describe('native Auto-review denial', () => {
  it('preserves the exact command and converts the v2 envelope to the native event', () => {
    expect(parseGuardianDenial(denial)).toEqual({
      threadId: 'thread-1', turnId: 'turn-1', reviewId: 'review-1', completedAtMs: 1_100,
      preview: 'Запуск: терминал Codex\nКаталог: /tmp/fixture\nКоманда: printf %s approval-fixture',
      event: { id: 'review-1', turn_id: 'turn-1', started_at_ms: 1_000, completed_at_ms: 1_100, status: 'denied',
        risk_level: 'high', user_authorization: 'low', rationale: 'Confirmation needed', decision_source: 'agent',
        action: { ...denial.action, source: 'unified_exec' } },
    });
  });

  it('displays execve arguments without losing empty or whitespace-bearing arguments', () => {
    const action = { type: 'execve', source: 'shell', program: '/bin/printf', argv: ['printf', '', ' a b '], cwd: '/tmp' };
    const parsed = parseGuardianDenial({ ...denial, action });
    expect(parsed?.event.action).toEqual(action);
    expect(parsed?.preview).toContain('Аргументы: ["printf",""," a b "]');
    action.argv[0] = 'different';
    expect(parsed?.event.action).toMatchObject({ argv: ['printf', '', ' a b '] });
  });

  it.each([
    null,
    { ...denial, decisionSource: 'unknown' },
    { ...denial, completedAtMs: 999 },
    { ...denial, review: { ...denial.review, status: 'timedOut' } },
    { ...denial, review: { ...denial.review, riskLevel: 'critical' } },
    { ...denial, review: { ...denial.review, riskLevel: null } },
    { ...denial, action: { ...denial.action, type: 'networkAccess' } },
    { ...denial, action: { ...denial.action, source: 'unexpected' } },
    { ...denial, action: { ...denial.action, extraPermissions: true } },
    { ...denial, action: { ...denial.action, command: 'echo first\necho second' } },
    { ...denial, action: { ...denial.action, command: 'echo \u202efirst' } },
    { ...denial, action: { ...denial.action, command: 'echo\u00a0word' } },
    { ...denial, action: { ...denial.action, command: 'echo word\u034f' } },
    { ...denial, action: { ...denial.action, command: 'a'.repeat(1501) } },
    { ...denial, action: { ...denial.action, cwd: '../other' } },
    { ...denial, action: { ...denial.action, cwd: '//server/share' } },
    { ...denial, action: { ...denial.action, type: 'execve', program: 'printf', argv: [1] } },
  ])('rejects unsupported or ambiguous input without creating an approval', value => {
    expect(parseGuardianDenial(value)).toBeUndefined();
  });
});

function fixture(version = GUARDIAN_APPROVAL_CODEX_VERSION) {
  const client = new CodexClient({ transport: 'websocket', endpoint: 'ws://127.0.0.1:1', executable: 'codex' });
  Object.assign(client, { version, runtime: {}, state: { ...client.status(), connected: true, queueSupported: true } });
  const call = vi.spyOn(client as unknown as { call(method: string, params: object): Promise<unknown> }, 'call');
  return { client, call };
}

const emptyQueue = { data: [], nextCursor: null };
const history = { data: [{ id: denial.turnId }], nextCursor: null };
const event = parseGuardianDenial(denial)!.event;

describe('native Auto-review decision delivery', () => {
  it('records one native approval without launching a turn or executing the command', async () => {
    const { client, call } = fixture();
    call.mockResolvedValueOnce(emptyQueue).mockResolvedValueOnce(history).mockResolvedValueOnce({});
    await expect(client.approveGuardianDeniedAction(denial.threadId, event, () => true)).resolves.toBe(true);
    expect(call.mock.calls).toEqual([
      ['thread/queue/list', { threadId: denial.threadId, limit: 1 }],
      ['thread/turns/list', { threadId: denial.threadId, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc' }],
      ['thread/approveGuardianDeniedAction', { threadId: denial.threadId, event }],
    ]);
  });

  it('refuses before sending when a newer turn, pending queue, or changed owner is observed', async () => {
    const { client, call } = fixture();
    call.mockResolvedValueOnce({ data: [{}], nextCursor: null });
    await expect(client.approveGuardianDeniedAction(denial.threadId, event, () => true)).resolves.toBe(false);
    call.mockResolvedValueOnce(emptyQueue).mockResolvedValueOnce({ data: [{ id: 'newer' }], nextCursor: null });
    await expect(client.approveGuardianDeniedAction(denial.threadId, event, () => true)).resolves.toBe(false);
    call.mockResolvedValueOnce(emptyQueue).mockResolvedValueOnce(history);
    await expect(client.approveGuardianDeniedAction(denial.threadId, event, () => false)).resolves.toBe(false);
    expect(call.mock.calls.every(([method]) => method !== 'thread/approveGuardianDeniedAction')).toBe(true);
  });

  it('fails closed outside alpha.6 and treats a malformed acknowledgment as unconfirmed', async () => {
    const unsupported = fixture('0.166.0-alpha.5.1');
    await expect(unsupported.client.approveGuardianDeniedAction(denial.threadId, event, () => true)).rejects.toThrow('alpha.6');
    expect(unsupported.call).not.toHaveBeenCalled();

    const { client, call } = fixture();
    call.mockResolvedValueOnce(emptyQueue).mockResolvedValueOnce(history).mockResolvedValueOnce(null);
    await expect(client.approveGuardianDeniedAction(denial.threadId, event, () => true)).rejects.toMatchObject({ code: 'guardian-approval-unconfirmed' });
    expect(call.mock.calls.filter(([method]) => method === 'thread/approveGuardianDeniedAction')).toHaveLength(1);
  });

  it('does not retry a native write with a lost acknowledgment', async () => {
    const { client, call } = fixture();
    const lost = new CodexTransportError('RPC acknowledgment lost', 'rpc-timeout');
    call.mockResolvedValueOnce(emptyQueue).mockResolvedValueOnce(history).mockRejectedValueOnce(lost);
    await expect(client.approveGuardianDeniedAction(denial.threadId, event, () => true)).rejects.toBe(lost);
    expect(call.mock.calls.filter(([method]) => method === 'thread/approveGuardianDeniedAction')).toHaveLength(1);
  });
});
