import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Engine, type CodexGateway } from '../src/server/engine.js';
import { defaultConfig } from '../src/server/config.js';
import type { Channel } from '../src/server/channels/common.js';
import { Store } from '../src/server/store.js';
import { SourceControls, type ControlContext } from '../src/server/source-control.js';
import { endpointId } from '../src/server/channels/common.js';
import type { Delivery, Endpoint } from '../src/shared/types.js';
import type { NativeControlSnapshot, NativeGoal, ControlTurn } from '../src/server/native-controls.js';
import { messageTrace } from '../src/shared/message-trace.js';

const paths: string[] = [], stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); vi.useRealTimers(); });
const context: ControlContext = { accountId: 'TTEST:UBOT', chatId: 'CTEST', threadId: '1000.1', messageId: '1000.2', senderId: 'UALICE', senderName: 'Alice', senderIsBot: false };
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'rele-controls-')); paths.push(path);
  const store = new Store(join(path, 'rele.sqlite')); stores.push(store);
  const endpoint: Endpoint = { id: endpointId('slack', context.accountId, context.chatId, context.threadId), platform: 'slack',
    accountId: context.accountId, chatId: context.chatId, threadId: context.threadId, title: 'Synthetic thread', subtitle: '', people: [{ id: 'UALICE', name: 'Alice', isBot: false }], updatedAt: new Date().toISOString() };
  store.upsertEndpoint(endpoint);
  const conversation = store.createConversation({ name: 'Synthetic Codex', cwd: '/fixture', threadId: 'native-thread', bindings: [{ platform: 'slack', endpointId: endpoint.id, allowedSenderIds: ['UALICE'], requireMention: true }] });
  let goal: NativeGoal | null = null, connected = true, generation = 'generation-1';
  let model = 'model-one', effort = 'high', subscribed = false;
  const turns: ControlTurn[] = [], sent: Delivery[] = [], mutations: string[] = [];
  const native = {
    status: () => ({ connected }), isVerifiedVersion: () => true,
    controlSnapshot: async (): Promise<NativeControlSnapshot> => ({ model, effort, runtimeStatus: 'idle', queued: 0, goalSupported: true, goal }),
    controlModels: async () => [{ model: 'model-one', displayName: 'Model one', efforts: ['high'], defaultEffort: 'high' }, { model: 'model-two', displayName: 'Model two', efforts: ['low'], defaultEffort: 'low' }],
    readControlGoal: async () => goal,
    updateControlModel: async (_thread: string, next: string, nextEffort: string, beforeSend?: () => void) => { beforeSend?.(); mutations.push('model'); model = next; effort = nextEffort; },
    updateControlGoal: async (_thread: string, patch: { objective?: string; status?: 'paused'; tokenBudget?: number }, beforeSend?: () => void) => {
      beforeSend?.();
      mutations.push(patch.status === 'paused' ? 'pause' : 'goal');
      goal = { threadId: 'native-thread', objective: patch.objective ?? goal!.objective, status: patch.status ?? 'active', tokenBudget: patch.tokenBudget ?? null,
        tokensUsed: goal?.tokensUsed ?? 0, timeUsedSeconds: 0, createdAt: goal?.createdAt ?? Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000) };
      return goal;
    },
    subscribe: async () => { if (!subscribed) { mutations.push('resume'); subscribed = true; } },
    controlTurns: async () => turns,
    controlTurnIndex: async () => turns.map(({ id, status, startedAt }) => ({ id, status, startedAt })),
    controlTurnLocation: async (_thread: string, id: string) => {
      const turn = turns.find(turn => turn.id === id);
      return turn ? { state: (turn.status === 'inProgress' ? 'running' : turn.status) as 'running' | 'completed' | 'failed' | 'interrupted', turnId: turn.id,
        mixed: turn.items.some(item => item.type === 'userMessage') } : { state: 'not_found' as const };
    },
    interrupt: async (_thread: string, turn: string) => { mutations.push(`interrupt:${turn}`); },
  };
  const options = { native: () => native, generation: () => generation, target: () => 'configured-native-target', available: () => true,
    channel: () => ({ state: { connected, accountId: context.accountId }, deliver: async (delivery: Delivery) => { sent.push(structuredClone(delivery)); return `remote-${sent.length}`; } }),
    redact: (error: unknown) => error instanceof Error ? error.message : 'error' };
  const controls = new SourceControls(store, options);
  return { controls, store, native, options, endpoint, conversation, turns, sent, mutations, get goal() { return goal; }, set goal(value) { goal = value; },
    disconnect: () => { connected = false; }, changeGeneration: () => { generation = 'generation-2'; } };
}

async function runningGoalEngine() {
  const f = fixture(), native = Object.assign(new EventEmitter(), f.native, { releaseThread: vi.fn(async () => {}) });
  const engine = new Engine(f.store, native as unknown as CodexGateway, { config: () => ({ ...defaultConfig, slack: { enabled: true } }), temporaryRoot: tmpdir(), redact: f.options.redact });
  engine.channels.slack = f.options.channel() as unknown as Channel;
  const form = await engine.control(context, { kind: 'open' });
  await engine.control(context, { kind: 'submit', id: form.id, input: { action: 'goal', objective: 'Finish', criterion: 'Done' } });
  const turn: ControlTurn = { id: 'goal-turn', status: 'inProgress', items: [] }; f.turns.push(turn);
  native.emit('notification', { method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: turn.id, goal: f.goal } }); await engine.settled();
  return { ...f, native, engine, turn, request: f.store.activeRequests()[0] };
}

function expectGoalTerminal(store: Store, requestId: string, status: 'completed' | 'failed' | 'interrupted') {
  const request = store.getRequest(requestId)!;
  expect(request).toMatchObject({ status });
  expect(request.suppressedFinal).toBeUndefined();
  expect(store.getMeta(`suppressed-final:${requestId}`)).toBeUndefined();
  const deliveries = store.listDeliveries().filter(row => row.requestId === requestId);
  expect(deliveries).toEqual([]);
  const trace = messageTrace({ request, origin: request.origin, deliveries, connected: { codex: true, source: true }, startedAt: request.createdAt, capturedAt: request.updatedAt });
  expect(trace.latest).toMatchObject({ stage: 'execution', status });
  expect(trace.steps.find(step => step.stage === 'delivery')?.status).toBe('no-data');
}

describe('native Goal terminal receipts', () => {
  it.each(['completed', 'failed', 'interrupted'] as const)('reconciles an Engine Goal turn as %s without NOREPLY or duplicate ordinary output', async status => {
    const f = await runningGoalEngine();
    try {
      f.turn.status = status;
      f.turn.items.push({ type: 'agentMessage', id: 'terminal-output', phase: null, text: 'Actual public Goal output' });
      await f.engine.reconcile(f.request.id);
      expectGoalTerminal(f.store, f.request.id, status);
      await f.engine.pump(); await f.engine.pump(); await f.engine.settled();
      expectGoalTerminal(f.store, f.request.id, status);
      expect(f.sent.filter(row => row.key === 'item:goal-turn:terminal-output').map(row => row.body)).toEqual(['Actual public Goal output']);
    } finally { await f.engine.stop(); }
  });

  it.each(['completed', 'failed', 'interrupted'] as const)('advances SourceControls after a %s prior turn without NOREPLY or ordinary output', async status => {
    const f = fixture(), form = await f.controls.open(context);
    await f.controls.submit(context, form.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    const previous: ControlTurn = { id: 'previous-turn', status: 'inProgress', items: [] }; f.turns.push(previous);
    f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: previous.id, goal: f.goal } });
    await f.controls.ensureRequest('native-thread', previous.id);
    const request = f.store.activeRequests()[0];
    previous.status = status; previous.items.push({ type: 'agentMessage', id: 'terminal-output', phase: null, text: 'Actual prior Goal output' });
    f.turns.push({ id: 'next-turn', status: 'inProgress', items: [] });
    f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'next-turn', goal: f.goal } });
    await expect(f.controls.ensureRequest('native-thread', 'next-turn')).resolves.toBeUndefined();
    expectGoalTerminal(f.store, request.id, status);
    expect(f.store.activeRequests().map(row => row.turnId)).toEqual(['next-turn']);
    await f.controls.recover(); await f.controls.recover();
    expectGoalTerminal(f.store, request.id, status);
    expect(f.sent.filter(row => row.key === 'item:previous-turn:terminal-output').map(row => row.body)).toEqual(['Actual prior Goal output']);
  });

  it('refuses generic queue cancellation of a Goal turn before writing ordinary cancellation markers', async () => {
    const f = await runningGoalEngine(), before = f.store.getRequest(f.request.id);
    try {
      await expect(f.engine.cancel(f.request.id)).rejects.toThrow('меню');
      expect(f.store.getRequest(f.request.id)).toEqual(before);
      for (const key of ['cancel-requested', 'cancel-cleanup', 'request-terminal-baseline']) expect(f.store.getMeta(`${key}:${f.request.id}`)).toBeUndefined();
      expect(f.mutations).toEqual(['resume', 'goal']);
      expect(f.store.listDeliveries()).toEqual([]);
    } finally { await f.engine.stop(); }
  });
});

describe('personal Slack source controls', () => {
  it('connects Engine controls to the current gateway and source without any ordinary request', async () => {
    const f = fixture(), native = Object.assign(new EventEmitter(), f.native);
    const engine = new Engine(f.store, native as unknown as CodexGateway, { config: () => ({ ...defaultConfig, slack: { enabled: true } }), temporaryRoot: tmpdir(), redact: f.options.redact });
    engine.channels.slack = f.options.channel() as unknown as Channel;
    const opened = await engine.control(context, { kind: 'open' });
    const saved = await engine.control(context, { kind: 'submit', id: opened.id, input: { action: 'model', model: 'model-two', effort: 'low' } });
    expect(saved.message).toContain('сохран'); expect(f.mutations).toEqual(['model']);
    expect(f.store.listRequests()).toEqual([]); await engine.stop();
  });

  it('attaches native autonomous Goal turns to the existing approval mechanism without enqueueing input', async () => {
    const f = fixture(), native = Object.assign(new EventEmitter(), f.native);
    const engine = new Engine(f.store, native as unknown as CodexGateway, { config: () => ({ ...defaultConfig, slack: { enabled: true } }), temporaryRoot: tmpdir(), redact: f.options.redact });
    engine.channels.slack = f.options.channel() as unknown as Channel;
    const opened = await engine.control(context, { kind: 'open' });
    await engine.control(context, { kind: 'submit', id: opened.id, input: { action: 'goal', objective: 'Finish', criterion: 'Done' } });
    f.turns.push({ id: 'goal-turn', status: 'inProgress', items: [] });
    native.emit('notification', { method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'goal-turn', goal: f.goal } });
    await engine.settled();
    native.emit('request', { id: 'native-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread', turnId: 'goal-turn', itemId: 'goal-command', command: 'echo fixture' } });
    await engine.settled();
    const approval = f.store.listApprovals()[0], request = approval && f.store.getRequest(approval.requestId);
    expect(approval).toMatchObject({ turnId: 'goal-turn', status: 'pending' });
    expect(request).toMatchObject({ turnId: 'goal-turn', origin: { accountId: context.accountId, threadId: context.threadId, senderId: context.senderId } });
    expect(f.mutations).toEqual(['resume', 'goal']);
    await engine.stop();
  });

  it('reads only the exact admitted source without creating a request or resuming native', async () => {
    const f = fixture();
    const view = await f.controls.open(context);
    expect(view).toMatchObject({ sourceTitle: 'Synthetic thread', conversationTitle: 'Synthetic Codex', accessMode: 'mention', connected: true, snapshot: { model: 'model-one' } });
    expect(f.mutations).toEqual([]); expect(f.store.listRequests()).toEqual([]);
    await expect(f.controls.open({ ...context, senderId: 'UMALLORY' })).rejects.toThrow();
    await expect(f.controls.open({ ...context, accountId: 'TOTHER:UBOT' })).rejects.toThrow();
    await expect(f.controls.open({ ...context, senderIsBot: true })).rejects.toThrow();
    f.store.setSourceAccess(f.endpoint.id, { mode: 'off' });
    await expect(f.controls.open(context)).rejects.toThrow();
  });

  it('does not show a settled Goal from the previous conversation after a source rebind', async () => {
    const f = fixture(), form = await f.controls.open(context);
    await f.controls.submit(context, form.id, { action: 'goal', objective: 'Finish old work', criterion: 'Done' });
    f.goal = { ...f.goal!, status: 'complete' };
    await f.controls.recover();
    expect((await f.controls.open(context)).goalDeliveryState).toBe('complete');

    const next = f.store.createConversation({ name: 'Next Codex', cwd: '/fixture', threadId: 'next-native-thread' });
    f.store.routeSource(f.endpoint.id, next.id);
    f.native.controlSnapshot = async () => ({ model: 'model-one', effort: 'high', runtimeStatus: 'idle', queued: 0, goalSupported: true, goal: null });

    expect(await f.controls.open(context)).not.toHaveProperty('goalDeliveryState');
  });

  it('revalidates actor, binding, runtime generation and expiry before any mutation', async () => {
    for (const change of ['actor', 'binding', 'generation', 'expired'] as const) {
      const f = fixture(); const view = await f.controls.open(context);
      let actor = context;
      if (change === 'actor') actor = { ...context, senderId: 'UMALLORY' };
      if (change === 'binding') f.store.setSourceAccess(f.endpoint.id, { mode: 'off' });
      if (change === 'generation') f.changeGeneration();
      if (change === 'expired') { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 16 * 60_000); }
      await expect(f.controls.submit(actor, view.id, { action: 'model', model: 'model-two', effort: 'low' })).rejects.toThrow();
      expect(f.mutations).toEqual([]); vi.useRealTimers();
    }
  });

  it('changes shared future defaults once, preserves a lost ACK and never probes the provider', async () => {
    const f = fixture(), view = await f.controls.open(context);
    const original = f.native.updateControlModel;
    f.native.updateControlModel = async (...args) => { await original(...args); throw new Error('lost ACK'); };
    const result = await f.controls.submit(context, view.id, { action: 'model', model: 'model-two', effort: 'low' });
    expect(result.message).toContain('сохран');
    await f.controls.submit(context, view.id, { action: 'model', model: 'model-two', effort: 'low' });
    const restarted = new SourceControls(f.store, f.options);
    await restarted.submit(context, view.id, { action: 'model', model: 'model-two', effort: 'low' });
    expect(f.mutations).toEqual(['model']);
    expect(f.store.listRequests()).toEqual([]);
  });

  it('keeps uncertain failures visible and does not retry or claim an applied model', async () => {
    const f = fixture(), view = await f.controls.open(context);
    f.native.updateControlModel = async (_thread, _model, _effort, beforeSend) => { beforeSend?.(); f.mutations.push('model'); throw new Error('lost ACK'); };
    expect((await f.controls.submit(context, view.id, { action: 'model', model: 'model-two', effort: 'low' })).message).toContain('неизвест');
    await f.controls.submit(context, view.id, { action: 'model', model: 'model-two', effort: 'low' });
    expect(f.mutations).toEqual(['model']);
    expect((await f.controls.open(context)).message).toContain('неизвест');
    f.disconnect();
    const offline = await f.controls.open(context);
    expect(offline.connected).toBe(false); expect(offline.snapshot).toBeUndefined();
  });

  it('restores native Goal origin, publishes completed public stages in order and gives a separate native final', async () => {
    const f = fixture(), view = await f.controls.open(context);
    await f.controls.submit(context, view.id, { action: 'goal', objective: 'Finish migration', criterion: 'Tests pass', tokenBudget: 5000 });
    expect(f.mutations).toEqual(['resume', 'goal']);
    await f.controls.submit(context, view.id, { action: 'goal', objective: 'Finish migration', criterion: 'Tests pass', tokenBudget: 5000 });
    f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'goal-turn', goal: f.goal } });
    f.turns.push({ id: 'goal-turn', status: 'completed', startedAt: f.goal!.createdAt, items: [
      { type: 'reasoning', id: 'secret', text: 'PRIVATE' }, { type: 'commandExecution', id: 'command', text: 'PRIVATE' },
      { type: 'agentMessage', id: 'stage', phase: 'commentary', text: 'Migration complete; checking tests' },
      { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Tests passed' },
    ] });
    const restarted = new SourceControls(f.store, f.options); await restarted.recover(); await restarted.recover();
    expect(f.sent.map(delivery => delivery.body).join('\n')).not.toContain('PRIVATE');
    expect(f.sent.filter(delivery => delivery.key.includes('item:')).map(delivery => delivery.body)).toEqual(['Migration complete; checking tests', 'Tests passed']);
    expect(f.sent.every(delivery => delivery.origin.accountId === context.accountId && delivery.origin.threadId === context.threadId)).toBe(true);
    expect(f.sent.some(delivery => delivery.key === 'goal:terminal')).toBe(false);
    f.goal = { ...f.goal!, status: 'complete' }; await restarted.recover();
    expect(f.sent.filter(delivery => delivery.key === 'goal:terminal')).toHaveLength(1);
    expect(f.mutations).toEqual(['resume', 'goal']);
  });

  it('pauses the native Goal and interrupts only its verified own running turn, never clears it', async () => {
    const f = fixture(), view = await f.controls.open(context);
    await f.controls.submit(context, view.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'goal-turn', goal: f.goal } });
    f.turns.push({ id: 'goal-turn', status: 'inProgress', startedAt: f.goal!.createdAt, items: [] });
    const stop = await f.controls.open(context); await f.controls.submit(context, stop.id, { action: 'stop' });
    expect(f.mutations).toEqual(['resume', 'goal', 'pause', 'interrupt:goal-turn']);
    expect(f.goal?.status).toBe('paused');
  });

  it('withholds a Goal turn containing foreign input and never replays uncertain delivery after restart', async () => {
    const f = fixture(), view = await f.controls.open(context);
    await f.controls.submit(context, view.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'foreign-turn', goal: f.goal } });
    f.turns.push({ id: 'foreign-turn', status: 'completed', startedAt: f.goal!.createdAt, items: [
      { type: 'userMessage', id: 'foreign', clientId: 'other-client' }, { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'DO NOT LEAK' },
    ] });
    await f.controls.recover();
    expect(f.sent.map(row => row.body).join('\n')).not.toContain('DO NOT LEAK');
    expect(f.store.listRequests()).toEqual([]);
  });

  it('journals each new delivery before sending and blocks all later stages after an unknown Slack ACK', async () => {
    const f = fixture(), view = await f.controls.open(context);
    let count = 0;
    f.options.channel = () => ({ state: { connected: true, accountId: context.accountId }, deliver: async (delivery: Delivery) => {
      const saved = JSON.parse(f.store.getMeta(`source-control:${view.id}`)!);
      expect(saved.outbox.find((row: Delivery) => row.id === delivery.id).status).toBe('sending');
      if (++count === 3) throw new Error('lost Slack ACK');
      f.sent.push(delivery); return 'known-receipt';
    } });
    await f.controls.submit(context, view.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'goal-turn', goal: f.goal } });
    f.turns.push({ id: 'goal-turn', status: 'completed', items: [
      { type: 'agentMessage', id: 'first', phase: 'commentary', text: 'First stage' },
      { type: 'agentMessage', id: 'second', phase: 'commentary', text: 'Second stage' },
      { type: 'agentMessage', id: 'third', phase: 'final_answer', text: 'Third stage' },
    ] });
    await f.controls.recover();
    const restarted = new SourceControls(f.store, f.options); await restarted.recover();
    expect(count).toBe(3);
    expect(JSON.parse(f.store.getMeta(`source-control:${view.id}`)!).outbox.filter((row: Delivery) => row.key !== 'goal:delivery-uncertain').map((row: Delivery) => row.status)).toEqual(['sent', 'sent', 'uncertain', 'pending']);
  });

  it('retains a native Goal turn notification that arrives before its creation response', async () => {
    const f = fixture(), view = await f.controls.open(context), update = f.native.updateControlGoal;
    f.native.updateControlGoal = async (...args) => {
      const goal = await update(...args);
      f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'early-turn', goal } });
      return goal;
    };
    await f.controls.submit(context, view.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    f.turns.push({ id: 'early-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Early result' }] });
    await f.controls.recover();
    expect(f.sent.map(row => row.body)).toContain('Early result');
  });

  it('publishes native public messages with an unspecified phase while suppressing NOREPLY', async () => {
    const f = fixture(), view = await f.controls.open(context);
    await f.controls.submit(context, view.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'goal-turn', goal: f.goal } });
    f.turns.push({ id: 'goal-turn', status: 'completed', items: [
      { type: 'agentMessage', id: 'native-stage', phase: null, text: 'Native public stage' },
      { type: 'agentMessage', id: 'no-reply', phase: 'final_answer', text: 'NOREPLY' },
    ] });
    await f.controls.recover();
    expect(f.sent.filter(row => row.key.startsWith('item:')).map(row => row.body)).toEqual(['Native public stage']);
  });

  it('withholds a history read if the native Goal changes before delivery', async () => {
    const f = fixture(), view = await f.controls.open(context);
    await f.controls.submit(context, view.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'old-turn', goal: f.goal } });
    f.native.controlTurns = async () => {
      f.goal = { ...f.goal!, objective: 'Another native goal' };
      return [{ id: 'old-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'UNVERIFIED RESULT' }] }];
    };
    await f.controls.recover();
    expect(f.sent.map(row => row.body).join('\n')).not.toContain('UNVERIFIED RESULT');
  });

  it('does not show success for a model save across a changed runtime generation', async () => {
    const f = fixture(), view = await f.controls.open(context), update = f.native.updateControlModel;
    f.native.updateControlModel = async (...args) => { await update(...args); f.changeGeneration(); };
    const result = await f.controls.submit(context, view.id, { action: 'model', model: 'model-two', effort: 'low' });
    expect(result.message).toContain('неизвест');
  });

  it('keeps accepted native Goals and sending controls inside the existing runtime-selection guard', async () => {
    const f = fixture(), view = await f.controls.open(context);
    await f.controls.submit(context, view.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    expect(f.store.hasUnfinishedCodexOperations()).toBe(true);
    f.goal = { ...f.goal!, status: 'complete' }; await f.controls.recover();
    expect(f.store.hasUnfinishedCodexOperations()).toBe(false);
  });

  it('waits for native execution to settle before publishing the final Goal state', async () => {
    const f = fixture(), view = await f.controls.open(context), snapshot = f.native.controlSnapshot;
    await f.controls.submit(context, view.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    f.goal = { ...f.goal!, status: 'complete' };
    f.native.controlSnapshot = async () => ({ ...await snapshot(), runtimeStatus: 'active' });
    await f.controls.recover();
    expect(f.sent.filter(row => row.key === 'goal:terminal')).toHaveLength(0);
    f.native.controlSnapshot = snapshot; await f.controls.recover();
    expect(f.sent.filter(row => row.key === 'goal:terminal')).toHaveLength(1);
  });

  it('keeps a genuine queued request separate from an autonomous Goal turn', async () => {
    const f = fixture(), native = Object.assign(new EventEmitter(), f.native, { status: () => ({ connected: true, queueSupported: true }), steer: vi.fn() });
    const engine = new Engine(f.store, native as unknown as CodexGateway, { config: () => ({ ...defaultConfig, slack: { enabled: true } }), temporaryRoot: tmpdir(), redact: f.options.redact });
    engine.channels.slack = f.options.channel() as unknown as Channel;
    const opened = await engine.control(context, { kind: 'open' });
    await engine.control(context, { kind: 'submit', id: opened.id, input: { action: 'goal', objective: 'Finish', criterion: 'Done' } });
    f.turns.push({ id: 'goal-turn', status: 'inProgress', items: [] });
    native.emit('notification', { method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'goal-turn', goal: f.goal } }); await engine.settled();
    const request = f.store.ingest({ eventId: 'new-human-message', endpoint: f.endpoint, sender: { id: context.senderId, name: 'Alice', isBot: false }, messageId: '1000.3', text: 'A genuine new request', directMention: true }).request!;
    await engine.pump(); await engine.settled();
    expect(f.store.getRequest(request.id)).toMatchObject({ status: 'queued' });
    expect(f.store.getRequest(request.id)?.steeredInto).toBeUndefined();
    expect(native.steer).not.toHaveBeenCalled(); await engine.stop();
  });

  it('rechecks source admission after native Goal preparation and immediately before a model wire write', async () => {
    const goal = fixture(), goalForm = await goal.controls.open(context);
    goal.native.readControlGoal = async () => { goal.store.setSourceAccess(goal.endpoint.id, { mode: 'off' }); return null; };
    await expect(goal.controls.submit(context, goalForm.id, { action: 'goal', objective: 'Finish', criterion: 'Done' })).rejects.toThrow();
    expect(goal.mutations).toEqual(['resume']);
    const model = fixture(), modelForm = await model.controls.open(context), original = model.native.updateControlModel;
    model.native.updateControlModel = async (...args) => { model.store.setSourceAccess(model.endpoint.id, { mode: 'off' }); await original(...args); };
    await expect(model.controls.submit(context, modelForm.id, { action: 'model', model: 'model-two', effort: 'low' })).rejects.toThrow();
    expect(model.mutations).toEqual([]);
  });

  it('uses validated async-answer provenance for stopping and publishing the same Goal turn', async () => {
    const f = fixture(), form = await f.controls.open(context);
    await f.controls.submit(context, form.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'goal-turn', goal: f.goal } });
    const turn: ControlTurn = { id: 'goal-turn', status: 'inProgress', items: [{ type: 'userMessage', clientId: 'registered-question-answer' }] }; f.turns.push(turn);
    f.native.controlTurnLocation = async () => ({ state: turn.status === 'inProgress' ? 'running' : 'completed', turnId: turn.id, mixed: false });
    const stop = await f.controls.open(context); await f.controls.submit(context, stop.id, { action: 'stop' });
    expect(f.mutations).toContain('interrupt:goal-turn');
    turn.status = 'completed'; turn.items.push({ type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Legitimate result after answer' });
    await f.controls.recover();
    expect(f.sent.map(row => row.body)).toContain('Legitimate result after answer');
  });

  it('holds final Goal delivery visibly when a recorded turn has not materialized in native history', async () => {
    const f = fixture(), form = await f.controls.open(context);
    await f.controls.submit(context, form.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'missing-turn', goal: f.goal } });
    f.goal = { ...f.goal!, status: 'complete' }; await f.controls.recover();
    expect(f.sent.some(row => row.key === 'goal:terminal')).toBe(false);
    expect(JSON.parse(f.store.getMeta(`source-control:${form.id}`)!).goalClosed).not.toBe(true);
    expect((await f.controls.open(context)).message).toContain('истори');
  });

  it('keeps Goal public commentary out of the ordinary progress-card reconciliation path', async () => {
    const f = fixture(), native = Object.assign(new EventEmitter(), f.native);
    native.controlTurnLocation = async () => ({ state: 'running' as const, turnId: 'goal-turn', mixed: false,
      commentary: [{ id: 'goal-comment', text: 'Goal public comment' }], publicHistory: [{ step: { id: 'goal-comment', text: 'Goal public comment' } }] });
    const engine = new Engine(f.store, native as unknown as CodexGateway, { config: () => ({ ...defaultConfig, slack: { enabled: true } }), temporaryRoot: tmpdir(), redact: f.options.redact });
    engine.channels.slack = f.options.channel() as unknown as Channel;
    const form = await engine.control(context, { kind: 'open' }); await engine.control(context, { kind: 'submit', id: form.id, input: { action: 'goal', objective: 'Finish', criterion: 'Done' } });
    f.turns.push({ id: 'goal-turn', status: 'inProgress', items: [] });
    native.emit('notification', { method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'goal-turn', goal: f.goal } }); await engine.settled();
    const request = f.store.activeRequests()[0]; await engine.reconcile(request.id);
    expect(f.store.getMeta(`request-progress:${request.id}`)).toBeUndefined(); await engine.stop();
  });

  it('keeps managed native subscribed between Goal turns and releases only an idle paused Goal', async () => {
    const f = fixture(), snapshot = f.native.controlSnapshot;
    let runtimeStatus = 'idle';
    const native = Object.assign(new EventEmitter(), f.native, { status: () => ({ connected: true, queueSupported: true, transport: 'managed' }),
      controlSnapshot: async () => ({ ...await snapshot(), runtimeStatus }), releaseThread: vi.fn(async () => {}) });
    let managed = false; native.status = () => ({ connected: true, queueSupported: true, transport: managed ? 'managed' : 'shared' });
    const engine = new Engine(f.store, native as unknown as CodexGateway, { config: () => ({ ...defaultConfig, slack: { enabled: true } }), temporaryRoot: tmpdir(), redact: f.options.redact });
    engine.channels.slack = f.options.channel() as unknown as Channel;
    const form = await engine.control(context, { kind: 'open' }); await engine.control(context, { kind: 'submit', id: form.id, input: { action: 'goal', objective: 'Finish', criterion: 'Done' } });
    managed = true;
    const turn: ControlTurn = { id: 'goal-turn', status: 'inProgress', items: [] }; f.turns.push(turn);
    native.emit('notification', { method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'goal-turn', goal: f.goal } }); await engine.settled();
    const request = f.store.activeRequests()[0]; turn.status = 'completed'; await engine.reconcile(request.id);
    expect(native.releaseThread).not.toHaveBeenCalled();
    f.goal = { ...f.goal!, status: 'paused' }; runtimeStatus = 'active'; await engine.pump();
    expect(native.releaseThread).not.toHaveBeenCalled();
    runtimeStatus = 'idle'; await engine.pump();
    expect(native.releaseThread).toHaveBeenCalledOnce(); await engine.stop();
  });

  it('gates only new managed Goal launch, keeps Status and Model available, and explains native UI capability', async () => {
    const f = fixture(); f.native.status = () => ({ connected: true, transport: 'managed' });
    const form = await f.controls.open(context);
    expect(form.goalLaunchUnavailable).toContain('Codex');
    await expect(f.controls.submit(context, form.id, { action: 'goal', objective: 'Finish', criterion: 'Done' })).rejects.toThrow('подтвержден');
    expect(f.mutations).toEqual([]);
    await f.controls.submit(context, form.id, { action: 'model', model: 'model-two', effort: 'low' });
    expect(f.mutations).toEqual(['model']);
  });

  it('preserves a visible subscription-gap uncertainty across restart and native completion without replay', async () => {
    const f = fixture(), form = await f.controls.open(context);
    await f.controls.submit(context, form.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    f.changeGeneration(); await f.controls.recover();
    f.goal = { ...f.goal!, status: 'complete' }; await f.controls.recover();
    const reopened = await f.controls.open(context);
    expect(reopened).toMatchObject({ goalDeliveryState: 'uncertain', snapshot: { goal: { status: 'complete' } } });
    expect(reopened.message).toContain('не полностью');
    const restarted = new SourceControls(f.store, f.options); await restarted.recover();
    expect(f.sent.filter(row => row.key === 'goal:delivery-uncertain')).toHaveLength(1);
    expect(f.sent.some(row => row.key === 'goal:native-complete')).toBe(true);
    expect(f.sent.some(row => row.key === 'goal:terminal')).toBe(false);
    expect(f.mutations).toEqual(['resume', 'goal']);
  });

  it('keeps entirely missed native links uncertain even when the next history page no longer contains the turn', async () => {
    const f = fixture(), form = await f.controls.open(context);
    await f.controls.submit(context, form.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    f.turns.push({ id: 'unattributed-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'result', phase: null, text: 'UNATTRIBUTED' }] });
    f.goal = { ...f.goal!, status: 'complete' }; await f.controls.recover();
    f.turns.length = 0; await f.controls.recover();
    expect((await f.controls.open(context)).goalDeliveryState).toBe('uncertain');
    expect(f.sent.map(row => row.body).join('\n')).not.toContain('UNATTRIBUTED');
    expect(f.sent.some(row => row.key === 'goal:terminal')).toBe(false);
    expect(JSON.parse(f.store.getMeta(`source-control:${form.id}`)!).goalClosed).not.toBe(true);
    expect(f.store.hasUnfinishedCodexOperations()).toBe(false);
  });

  it('merges a new native Goal turn received during proof before deciding final delivery', async () => {
    const f = fixture(), form = await f.controls.open(context);
    await f.controls.submit(context, form.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'turn-a', goal: f.goal } });
    f.turns.push({ id: 'turn-a', status: 'completed', items: [{ type: 'agentMessage', id: 'answer-a', phase: null, text: 'A' }] });
    f.goal = { ...f.goal!, status: 'complete' };
    f.native.controlTurnLocation = async (_thread, id) => {
      f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'turn-b', goal: f.goal } });
      return { state: 'completed', turnId: id, mixed: false };
    };
    await f.controls.recover();
    const saved = JSON.parse(f.store.getMeta(`source-control:${form.id}`)!);
    expect(saved.turns).toEqual(['turn-a', 'turn-b']);
    expect(saved.completedTurns).toEqual(['turn-a']);
    expect(f.sent.some(row => row.key === 'goal:terminal')).toBe(false);
  });

  it('leaves an unlinked shared Goal approval in native Codex without exposing it in Slack', async () => {
    const f = fixture(), native = Object.assign(new EventEmitter(), f.native, { status: () => ({ connected: true, transport: 'shared' }), rejectRequest: vi.fn(async () => {}) });
    const engine = new Engine(f.store, native as unknown as CodexGateway, { config: () => ({ ...defaultConfig, slack: { enabled: true } }), temporaryRoot: tmpdir(), redact: f.options.redact });
    engine.channels.slack = f.options.channel() as unknown as Channel;
    const form = await engine.control(context, { kind: 'open' }); await engine.control(context, { kind: 'submit', id: form.id, input: { action: 'goal', objective: 'Finish', criterion: 'Done' } });
    native.emit('request', { id: 'first-native-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread', turnId: 'not-linked-yet', itemId: 'command', command: 'PRIVATE NATIVE COMMAND' } }); await engine.settled();
    expect(native.rejectRequest).not.toHaveBeenCalled(); expect(f.store.listApprovals()).toEqual([]);
    expect(f.sent.map(row => row.body).join('\n')).not.toContain('PRIVATE NATIVE COMMAND');
    expect(f.mutations).toEqual(['resume', 'goal']); await engine.stop();
  });

  it('quarantines colliding native Goal identities across two sources, including an event before ACK', async () => {
    const f = fixture(), a = await f.controls.open(context);
    await f.controls.submit(context, a.id, { action: 'goal', objective: 'Repeat objective', criterion: 'Done' });
    f.goal = { ...f.goal!, status: 'complete' };
    const contextB = { ...context, threadId: '2000.1', messageId: '2000.2' };
    const endpointB = { ...f.endpoint, id: endpointId('slack', context.accountId, context.chatId, contextB.threadId), threadId: contextB.threadId };
    f.store.upsertEndpoint(endpointB); f.store.addBinding(f.conversation.id, 'slack', endpointB.id, [context.senderId], { requireMention: true });
    const update = f.native.updateControlGoal;
    f.native.updateControlGoal = async (...args) => {
      const goal = await update(...args);
      f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'goal-b-turn', goal } });
      f.turns.push({ id: 'goal-b-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'b-result', phase: null, text: 'PRIVATE B RESULT' }] });
      await f.controls.recover(); return goal;
    };
    const b = await f.controls.open(contextB); const result = await f.controls.submit(contextB, b.id, { action: 'goal', objective: 'Repeat objective', criterion: 'Done' });
    expect(result.message).toContain('не полностью');
    await f.controls.recover();
    expect(f.sent.filter(row => row.body === 'PRIVATE B RESULT')).toEqual([]);
    expect((await f.controls.open(contextB)).goalDeliveryState).toBe('uncertain');
  });

  it('keeps delivery uncertain when a new Goal turn arrives during the final Slack ACK', async () => {
    const f = fixture(), form = await f.controls.open(context);
    await f.controls.submit(context, form.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    f.goal = { ...f.goal!, status: 'complete' };
    f.options.channel = () => ({ state: { connected: true, accountId: context.accountId }, deliver: async (delivery: Delivery) => {
      if (delivery.key === 'goal:terminal') f.controls.notification({ method: 'thread/goal/updated', params: { threadId: 'native-thread', turnId: 'late-turn', goal: f.goal } });
      f.sent.push(delivery); return 'known-receipt';
    } });
    await f.controls.recover();
    const saved = JSON.parse(f.store.getMeta(`source-control:${form.id}`)!);
    expect(saved.turns).toContain('late-turn'); expect(saved.goalClosed).not.toBe(true);
    expect((await f.controls.open(context)).goalDeliveryState).toBe('uncertain');
    expect(f.sent.some(row => row.key === 'goal:delivery-uncertain')).toBe(true);
  });

  it('explains that native pause may leave an unlinked active turn running without claiming an interrupt', async () => {
    const f = fixture(), form = await f.controls.open(context), snapshot = f.native.controlSnapshot;
    await f.controls.submit(context, form.id, { action: 'goal', objective: 'Finish', criterion: 'Done' });
    f.native.controlSnapshot = async () => ({ ...await snapshot(), runtimeStatus: 'active' });
    const stop = await f.controls.open(context), result = await f.controls.submit(context, stop.id, { action: 'stop' });
    expect(result.message).toContain('может продолж');
    expect(f.mutations).toEqual(['resume', 'goal', 'pause']);
  });

  it('preserves old missed-turn uncertainty when a different source starts the next Goal before recovery', async () => {
    const f = fixture(), a = await f.controls.open(context);
    await f.controls.submit(context, a.id, { action: 'goal', objective: 'First objective', criterion: 'Done' });
    f.turns.push({ id: 'missed-a', status: 'completed', items: [{ type: 'agentMessage', id: 'a-result', phase: null, text: 'UNATTRIBUTED A' }] });
    f.goal = { ...f.goal!, status: 'complete' };
    const contextB = { ...context, threadId: '2000.1', messageId: '2000.2' };
    const endpointB = { ...f.endpoint, id: endpointId('slack', context.accountId, context.chatId, contextB.threadId), threadId: contextB.threadId };
    f.store.upsertEndpoint(endpointB); f.store.addBinding(f.conversation.id, 'slack', endpointB.id, [context.senderId], { requireMention: true });
    const b = await f.controls.open(contextB); await f.controls.submit(contextB, b.id, { action: 'goal', objective: 'Different second objective', criterion: 'Done' });
    await f.controls.recover();
    expect((await f.controls.open(context)).goalDeliveryState).toBe('uncertain');
    expect(f.sent.some(row => row.origin.threadId === context.threadId && row.key === 'goal:terminal')).toBe(false);
    expect(f.sent.map(row => row.body).join('\n')).not.toContain('UNATTRIBUTED A');
  });
});
