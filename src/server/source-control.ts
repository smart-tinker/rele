import { createHash, randomUUID } from 'node:crypto';
import type { Delivery, Origin } from '../shared/types.js';
import { endpointId, splitReply } from './channels/common.js';
import type { Store } from './store.js';
import type { CodexNotification, RequestLocation } from './codex.js';
import { nativeGoal, type ControlModel, type ControlTurn, type NativeControlSnapshot, type NativeGoal } from './native-controls.js';

export interface ControlContext {
  accountId: string; chatId: string; threadId: string; messageId: string;
  senderId: string; senderName: string; senderIsBot: boolean;
}
export type ControlSelection = 'status' | 'goal' | 'stop' | 'model';
export interface ControlInput { action: ControlSelection; objective?: string; criterion?: string; tokenBudget?: number; model?: string; effort?: string }
export interface ControlView {
  id: string; sourceTitle: string; conversationTitle: string; nativeThreadId: string; action: ControlSelection;
  connected: boolean; snapshot?: NativeControlSnapshot; models?: ControlModel[]; boundSources: number;
  ownQueued: number; ownRunning: number; message?: string; finished?: boolean;
  accessMode?: string; goalLaunchUnavailable?: string; goalDeliveryState?: 'tracking' | 'complete' | 'uncertain';
}
interface NativeControls {
  status(): { connected: boolean; transport?: string }; isVerifiedVersion(): boolean;
  controlSnapshot(threadId: string): Promise<NativeControlSnapshot>; controlModels(): Promise<ControlModel[]>;
  readControlGoal(threadId: string): Promise<NativeGoal | null>;
  updateControlGoal(threadId: string, patch: { objective?: string; tokenBudget?: number; status?: 'paused' }, beforeSend?: () => void): Promise<NativeGoal>;
  updateControlModel(threadId: string, model: string, effort: string, beforeSend?: () => void): Promise<void>;
  subscribe(threadId: string): Promise<void>; interrupt(threadId: string, turnId: string): Promise<void>;
  controlTurns(threadId: string, turnIds?: readonly string[]): Promise<ControlTurn[]>;
  controlTurnIndex(threadId: string): Promise<Pick<ControlTurn, 'id' | 'status' | 'startedAt'>[]>;
  controlTurnLocation(threadId: string, turnId: string, ownInputIds?: readonly string[]): Promise<RequestLocation>;
}
interface Options {
  native(): NativeControls | undefined; generation(): string; target?: () => string; available(): boolean;
  channel(): { state: { connected: boolean; accountId?: string }; deliver(delivery: Delivery): Promise<string> } | undefined;
  redact(error: unknown): string;
}
interface Receipt {
  id: string; context: ControlContext; origin: Origin; conversationId: string; threadId: string;
  source: string; target: string; generation: string; createdAt: number; expiresAt: number;
  state: 'open' | 'sending' | 'applied' | 'uncertain' | 'refused'; input?: ControlInput; message?: string; warning?: string;
  goal?: NativeGoal; turns?: string[]; completedTurns?: string[]; goalClosed?: boolean;
  earlyTurns?: { turnId: string; goal: NativeGoal }[];
  baselineTurns?: string[]; lastGeneration?: string; provenanceUncertain?: boolean; unattributedTurns?: string[]; deliveryUncertain?: boolean; nativeSettled?: boolean;
  attributionRetired?: boolean; identityAmbiguous?: boolean;
  outbox?: Delivery[];
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (id: string) => `source-control:${id}`;
const identity = (goal: NativeGoal) => [goal.threadId, goal.objective, goal.createdAt];
const sameGoal = (a: NativeGoal, b: NativeGoal) => JSON.stringify(identity(a)) === JSON.stringify(identity(b));
const managedGoalReason = 'Запуск цели в режиме «Сервер Rele» недоступен: первые native подтверждения не могут быть показаны через Rele и отклоняются. Используйте существующее подключение с доступным приложением Codex; режим автоматически не меняется.';
const deliveryWarning = 'Доставка этапов цели подтверждена не полностью. После перерыва или неподтверждённого хода часть результатов могла остаться в Codex. Native состояние цели показывается отдельно; неизвестные отправки не повторяются.';
const text = (value: unknown, limit: number) => {
  if (typeof value !== 'string' || !value.trim() || [...value].length > limit || /[\x00-\x08\x0b-\x1f]/u.test(value)) throw new Error('Заполните цель и критерий завершения в пределах 4000 символов.');
  return value.trim();
};

/** One native operation and immutable delivery origin per submitted Slack form. */
export class SourceControls {
  private locks = new Map<string, Promise<unknown>>();
  private recovering?: Promise<void>;
  constructor(private readonly store: Store, private readonly options: Options) {}

  private ids(): string[] { return JSON.parse(this.store.getMeta('source-control:index') ?? '[]') as string[]; }
  private read(id: string): Receipt {
    if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('Форма управления недоступна.');
    const saved = this.store.getMeta(key(id));
    if (!saved) throw new Error('Форма управления истекла. Откройте меню сообщения снова.');
    return JSON.parse(saved) as Receipt;
  }
  private mergeJournal(receipt: Receipt): Receipt {
    const raw = this.store.getMeta(key(receipt.id));
    if (!raw) return receipt;
    const stored = JSON.parse(raw) as Receipt;
    receipt.attributionRetired ||= stored.attributionRetired;
    receipt.identityAmbiguous ||= stored.identityAmbiguous;
    if (stored.attributionRetired) { receipt.goal = stored.goal; receipt.nativeSettled = stored.nativeSettled; }
    receipt.turns = [...new Set([...(stored.turns ?? []), ...(receipt.turns ?? [])])];
    receipt.completedTurns = [...new Set([...(stored.completedTurns ?? []), ...(receipt.completedTurns ?? [])])];
    receipt.provenanceUncertain ||= stored.provenanceUncertain;
    receipt.unattributedTurns = [...new Set([...(stored.unattributedTurns ?? []), ...(receipt.unattributedTurns ?? [])])].filter(id => !receipt.turns!.includes(id));
    const early = [...(stored.earlyTurns ?? []), ...(receipt.earlyTurns ?? [])];
    if (receipt.goal) {
      if (!receipt.identityAmbiguous) receipt.turns = [...new Set([...receipt.turns, ...early.filter(event => sameGoal(event.goal, receipt.goal!) && !receipt.baselineTurns?.includes(event.turnId)).map(event => event.turnId)])];
      delete receipt.earlyTurns;
    } else if (early.length) receipt.earlyTurns = [...new Map(early.map(event => [event.turnId, event])).values()].slice(-100);
    return receipt;
  }
  private save(receipt: Receipt): void { this.store.setMeta(key(receipt.id), JSON.stringify(this.mergeJournal(receipt))); }
  private source(context: ControlContext) {
    if (!this.options.available() || context.senderIsBot !== false || !/^[UW][A-Z0-9]+$/u.test(context.senderId)) throw new Error('Управление недоступно этому участнику.');
    const channel = this.options.channel();
    if (channel?.state.accountId !== context.accountId) throw new Error('Учётная запись Slack изменилась. Откройте форму снова.');
    const id = endpointId('slack', context.accountId, context.chatId, context.threadId);
    const endpoint = this.store.getEndpoint(id), binding = this.store.bindingForEndpoint(id);
    const conversation = binding && this.store.getConversation(binding.conversationId);
    if (!endpoint || endpoint.available === false || !binding || !conversation || conversation.paused
      || !this.store.sourceAllowsControl(id, context.senderId)) throw new Error('В этом треде нет доступной связи с Codex. Проверьте источник в Rele.');
    const access = this.store.getSourceAccess(id);
    return { endpoint, binding, conversation, fingerprint: digest([endpoint.accountId, endpoint.chatId, endpoint.threadId, binding, conversation.threadId, conversation.paused, access]) };
  }
  private current(context: ControlContext, id: string, mutable = false): Receipt {
    const receipt = this.read(id), source = this.source(context);
    if (receipt.expiresAt < Date.now() || receipt.context.senderId !== context.senderId || receipt.context.accountId !== context.accountId
      || receipt.context.chatId !== context.chatId || receipt.context.threadId !== context.threadId || receipt.context.messageId !== context.messageId
      || receipt.source !== source.fingerprint || receipt.threadId !== source.conversation.threadId
      || receipt.target !== (this.options.target?.() ?? this.options.generation())
      || mutable && receipt.generation !== this.options.generation()) throw new Error('Форма устарела: источник, доступ или подключение изменились. Откройте меню сообщения снова.');
    return receipt;
  }
  private native(): NativeControls {
    const native = this.options.native();
    if (!native?.status().connected || !native.isVerifiedVersion()) throw new Error('Codex отключён или его версия не проверена. Настройки не изменены.');
    return native;
  }
  private async view(receipt: Receipt, action: ControlSelection = 'status'): Promise<ControlView> {
    const source = this.source(receipt.context), native = this.options.native();
    const connected = !!native?.status().connected && native.isVerifiedVersion();
    const requests = this.store.listRequests(1000).filter(request => request.origin.endpointId === source.endpoint.id);
    const records = this.ids().map(id => this.read(id));
    const pending = records.find(row => row.origin.endpointId === source.endpoint.id
      && (['sending', 'uncertain'].includes(row.state) || row.warning || row.outbox?.some(delivery => ['sending', 'uncertain'].includes(delivery.status))));
    const owner = [...records].reverse().find(row => row.origin.endpointId === source.endpoint.id && row.goal);
    return { id: receipt.id, sourceTitle: source.endpoint.title, conversationTitle: source.conversation.name,
      nativeThreadId: receipt.threadId, action, connected, boundSources: source.conversation.bindings.length,
      accessMode: this.store.getSourceAccess(source.endpoint.id).mode,
      ...(native?.status().transport === 'managed' ? { goalLaunchUnavailable: managedGoalReason } : {}),
      ...(owner ? { goalDeliveryState: owner.deliveryUncertain || owner.outbox?.some(row => ['sending', 'uncertain'].includes(row.status))
        ? 'uncertain' as const : owner.goalClosed ? 'complete' as const : 'tracking' as const } : {}),
      ownQueued: requests.filter(request => ['queued', 'transcribing'].includes(request.status)).length,
      ownRunning: requests.filter(request => ['starting', 'running', 'waiting_approval', 'uncertain'].includes(request.status)).length,
      ...(connected ? { snapshot: await native!.controlSnapshot(receipt.threadId) } : {}),
      ...(connected && action === 'model' ? { models: await native!.controlModels() } : {}),
      ...(receipt.message ? { message: [receipt.message, receipt.warning].filter(Boolean).join('\n'), finished: receipt.state !== 'open' }
        : pending ? { message: pending.warning ?? 'Результат предыдущей операции неизвестен. Проверьте native состояние; автоматического повтора не будет.' } : {}) };
  }
  async open(context: ControlContext): Promise<ControlView> {
    const source = this.source(context), id = randomUUID(), now = Date.now();
    const ids = this.ids().filter(id => {
      const row = this.read(id);
      return row.expiresAt >= now || row.state === 'sending' || row.state === 'uncertain' || row.deliveryUncertain || row.goal && !row.goalClosed;
    });
    if (ids.length >= 500) throw new Error('Слишком много незавершённых операций. Проверьте состояние Rele.');
    const receipt: Receipt = { id, context: structuredClone(context), source: source.fingerprint,
      conversationId: source.conversation.id, threadId: source.conversation.threadId,
      target: this.options.target?.() ?? this.options.generation(), generation: this.options.generation(), createdAt: now, expiresAt: now + 15 * 60_000, state: 'open',
      origin: { platform: 'slack', endpointId: source.endpoint.id, ...context } };
    this.save(receipt); this.store.setMeta('source-control:index', JSON.stringify([...ids, id]));
    return this.view(receipt);
  }
  async preview(context: ControlContext, id: string, action: ControlSelection): Promise<ControlView> {
    if (!['status', 'goal', 'stop', 'model'].includes(action)) throw new Error('Неизвестное действие.');
    return this.view(this.current(context, id), action);
  }
  async submit(context: ControlContext, id: string, input: ControlInput): Promise<ControlView> {
    const first = this.current(context, id, true);
    const previous = this.locks.get(first.threadId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.apply(context, id, input));
    this.locks.set(first.threadId, task);
    try { return await task; } finally { if (this.locks.get(first.threadId) === task) this.locks.delete(first.threadId); }
  }
  private async apply(context: ControlContext, id: string, input: ControlInput): Promise<ControlView> {
    let receipt = this.current(context, id, true);
    if (!input || !['status', 'goal', 'stop', 'model'].includes(input.action)) throw new Error('Неизвестное действие.');
    if (input.action === 'status') return this.view(receipt);
    if (receipt.state !== 'open') {
      if (digest(receipt.input) !== digest(input)) throw new Error('Эта форма уже отправлена с другими значениями.');
      return this.view(receipt, input.action);
    }
    const native = this.native(), snapshot = await native.controlSnapshot(receipt.threadId);
    let objective: string | undefined;
    if (input.action === 'model') {
      const model = (await native.controlModels()).find(row => row.model === input.model);
      if (!model || typeof input.effort !== 'string' || !model.efforts.includes(input.effort)) throw new Error('Модель и глубина не поддерживаются текущим каталогом Codex.');
    } else {
      if (!snapshot.goalSupported) throw new Error('Этот Codex не подтвердил включённый native Goals API. Цель не запущена.');
      if (input.action === 'goal') {
        if (native.status().transport === 'managed') throw new Error(managedGoalReason);
        objective = `${text(input.objective, 4000)}\nКритерий завершения: ${text(input.criterion, 4000)}`;
        text(objective, 4000);
        if (input.tokenBudget !== undefined && (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0)) throw new Error('Бюджет токенов должен быть положительным целым числом.');
        if (snapshot.goal && snapshot.goal.status !== 'complete') throw new Error('В этом разговоре уже есть цель. Просмотрите или остановите её; новая цель не создана.');
        if (!['idle', 'notLoaded'].includes(snapshot.runtimeStatus) || snapshot.queued) throw new Error('Дождитесь завершения текущего хода и очереди Codex перед запуском цели.');
      } else if (!snapshot.goal) throw new Error('В этом разговоре нет цели для остановки.');
    }
    receipt = this.current(context, id, true);
    receipt.state = 'sending'; receipt.input = structuredClone(input); this.save(receipt);
    let mutationStarted = false;
    const fence = () => {
      this.current(context, id, true);
      if (this.native() !== native) throw new Error('Подключение Codex изменилось. Операция не отправлена.');
    };
    const beforeSend = () => { fence(); mutationStarted = true; };
    try {
      if (input.action === 'model') {
        await native.updateControlModel(receipt.threadId, input.model!, input.effort!, beforeSend);
        const readback = await native.controlSnapshot(receipt.threadId);
        if (readback.model !== input.model || readback.effort !== input.effort) throw new Error('Codex ещё не подтвердил сохранённую пару.');
        receipt.message = 'Настройка общего Codex-чата сохранена для последующих запросов всех связанных источников. Текущий ход не изменён. Доступ провайдера и фактическое исполнение ещё не подтверждены.';
      } else if (input.action === 'goal') {
        await native.subscribe(receipt.threadId);
        const current = await native.readControlGoal(receipt.threadId);
        if (current && current.status !== 'complete') throw new Error('Цель изменилась до запуска. Проверьте native состояние.');
        receipt.baselineTurns = (await native.controlTurnIndex(receipt.threadId)).map(turn => turn.id);
        this.save(receipt);
        const ready = await native.controlSnapshot(receipt.threadId);
        if (!['idle', 'notLoaded'].includes(ready.runtimeStatus) || ready.queued || ready.goal && ready.goal.status !== 'complete') throw new Error('Codex занят или цель изменилась до запуска.');
        fence();
        if (ready.goal) for (const ownerId of this.ids()) {
          const owner = this.read(ownerId);
          if (!owner.goal || !sameGoal(owner.goal, ready.goal)) continue;
          const missed = receipt.baselineTurns.filter(turnId => !owner.baselineTurns?.includes(turnId) && !owner.turns?.includes(turnId));
          if (missed.length) {
            owner.unattributedTurns = [...new Set([...(owner.unattributedTurns ?? []), ...missed])];
            owner.provenanceUncertain = true; owner.deliveryUncertain = true; owner.warning = deliveryWarning;
          }
          owner.attributionRetired = true; owner.goal = ready.goal; owner.nativeSettled = true; this.save(owner);
        }
        const created = await native.updateControlGoal(receipt.threadId, { objective, ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}) }, beforeSend);
        receipt = this.read(id); receipt.goal = created;
        receipt.turns = [...new Set((receipt.earlyTurns ?? []).filter(event => sameGoal(event.goal, created)).map(event => event.turnId))];
        delete receipt.earlyTurns; receipt.completedTurns = []; receipt.outbox = [];
        receipt.lastGeneration = this.options.generation(); receipt.unattributedTurns = [];
        for (const ownerId of this.ids().filter(ownerId => ownerId !== id)) {
          const owner = this.read(ownerId);
          if (!owner.goal || !sameGoal(owner.goal, created)) continue;
          owner.identityAmbiguous = true; owner.provenanceUncertain = true; owner.deliveryUncertain = true; owner.warning = deliveryWarning; this.save(owner);
          receipt.identityAmbiguous = true; receipt.provenanceUncertain = true; receipt.deliveryUncertain = true; receipt.warning = deliveryWarning; receipt.turns = [];
        }
        receipt.message = 'Native цель создана. Подтверждённые этапы и итог будут отправлены в этот Slack-тред.';
        this.enqueue(receipt, 'goal:created', `Цель: ${receipt.goal.objective}\nСостояние Codex: ${receipt.goal.status}`);
      } else {
        const current = await native.readControlGoal(receipt.threadId);
        if (!current || !sameGoal(snapshot.goal!, current)) throw new Error('Native цель изменилась. Откройте форму снова.');
        const paused = await native.updateControlGoal(receipt.threadId, { status: 'paused' }, beforeSend);
        if (!sameGoal(current, paused) || paused.status !== 'paused') throw new Error('Codex не подтвердил приостановку этой цели.');
        const owner = this.ids().map(id => this.read(id)).find(row => row.goal && sameGoal(row.goal, paused));
        let interruptRequested = false;
        if (owner) {
          const turns = await native.controlTurns(receipt.threadId, owner.turns);
          for (const turn of turns.filter(turn => owner.turns?.includes(turn.id) && turn.status === 'inProgress')) {
            const request = this.store.listRequests(1000).find(row => row.eventId === `native-goal:${owner.id}:${turn.id}`);
            const proof = await native.controlTurnLocation(receipt.threadId, turn.id, request ? this.knownInputs(request.id) : []);
            const current = await native.readControlGoal(receipt.threadId);
            if (proof.state === 'running' && proof.turnId === turn.id && !proof.mixed && current && sameGoal(current, paused) && current.status === 'paused') {
              fence(); await native.interrupt(receipt.threadId, turn.id); interruptRequested = true;
            }
          }
        }
        receipt.message = `Codex подтвердил приостановку цели. ${interruptRequested
          ? 'Остановка подтверждённого хода цели запрошена; завершение хода проверяется отдельно.'
          : snapshot.runtimeStatus === 'active' ? 'Принадлежность активного хода не подтверждена; он может продолжиться. Проверьте его в Codex.' : 'Новых автоматических продолжений не будет.'}`;
      }
      this.current(context, id, true);
      receipt.state = 'applied';
    } catch (error) {
      receipt.state = mutationStarted ? 'uncertain' : 'refused';
      receipt.message = mutationStarted ? 'Результат операции неизвестен. Rele не будет повторять её. Проверьте native состояние через Статус.'
        : `Операция не отправлена: ${this.options.redact(error)}`;
      if (mutationStarted && input.action === 'model' && receipt.generation === this.options.generation()) {
        try {
          fence();
          const found = await native.controlSnapshot(receipt.threadId);
          fence();
          if (found.model === input.model && found.effort === input.effort) { receipt.state = 'applied'; receipt.message = 'Настройка общего чата сохранена: пара подтверждена чтением Codex. Фактическое исполнение и доступ провайдера ещё не подтверждены.'; }
        } catch {}
      }
      // A lost Goal ACK has no native operation key: matching text alone cannot establish ownership.
      if (receipt.goal) receipt.goalClosed = true;
      void error;
    }
    this.save(receipt);
    await this.recover();
    return this.view(this.read(id), input.action);
  }
  notification(event: CodexNotification): void {
    if (event.method !== 'thread/goal/updated') return;
    const p = event.params;
    if (typeof p.threadId !== 'string' || typeof p.turnId !== 'string') return;
    let goal: NativeGoal;
    try { goal = nativeGoal(p.goal, p.threadId); } catch { return; }
    for (const id of this.ids()) {
      const receipt = this.read(id);
      if (receipt.state === 'sending' && receipt.threadId === p.threadId && receipt.input?.action === 'goal'
        && goal.objective === `${receipt.input.objective?.trim()}\nКритерий завершения: ${receipt.input.criterion?.trim()}`
        && goal.createdAt >= Math.floor(receipt.createdAt / 1000)) {
        receipt.earlyTurns = [...(receipt.earlyTurns ?? []).filter(row => row.turnId !== p.turnId), { turnId: p.turnId, goal }].slice(-100);
        this.save(receipt);
      }
      if (!receipt.goal || receipt.goalClosed || receipt.attributionRetired || receipt.identityAmbiguous || receipt.threadId !== p.threadId || !sameGoal(receipt.goal, goal)) continue;
      receipt.turns = [...new Set([...(receipt.turns ?? []), p.turnId])]; this.save(receipt);
      receipt.unattributedTurns = receipt.unattributedTurns?.filter(id => id !== p.turnId); this.save(receipt);
    }
  }
  async ensureRequest(threadId: string, turnId: string): Promise<void> {
    const receipt = this.ids().map(id => this.read(id)).find(row => row.goal && !row.goalClosed && !row.attributionRetired && !row.identityAmbiguous && row.threadId === threadId && row.turns?.includes(turnId));
    if (!receipt || receipt.target !== (this.options.target?.() ?? this.options.generation())) return;
    const source = this.source(receipt.context), native = this.native();
    if (source.fingerprint !== receipt.source) return;
    const current = await native.readControlGoal(threadId);
    if (!current || !sameGoal(receipt.goal!, current)) return;
    const existing = this.store.listRequests(1000).find(request => request.eventId === `native-goal:${receipt.id}:${turnId}`);
    const known = existing ? this.knownInputs(existing.id) : [];
    const found = await native.controlTurnLocation(threadId, turnId, known);
    if (found.state !== 'running' || found.mixed) return;
    for (const active of this.store.activeRequests().filter(request => request.conversationId === receipt.conversationId && request.status !== 'queued' && request.turnId !== turnId)) {
      if (this.store.getMeta(`control-goal-request:${active.id}`) !== receipt.id || !active.turnId) return;
      const previous = await native.controlTurnLocation(threadId, active.turnId, this.knownInputs(active.id));
      if (!['completed', 'failed', 'interrupted'].includes(previous.state)) return;
      this.store.finishRequest(active.id, { status: previous.state as 'completed' | 'failed' | 'interrupted', turnId: active.turnId }, [], true);
      for (const approval of this.store.listApprovals(1000).filter(row => row.requestId === active.id && row.status === 'pending')) {
        this.store.updateApproval(approval.id, { status: 'expired' }); this.store.cancelApprovalDeliveries(approval.id);
      }
    }
    this.store.recordGoalTurn({ ownerId: receipt.id, conversationId: receipt.conversationId, threadId, turnId, origin: receipt.origin, objective: receipt.goal!.objective });
  }
  async requestLocation(requestId: string): Promise<RequestLocation> {
    const owner = this.store.getMeta(`control-goal-request:${requestId}`), request = this.store.getRequest(requestId);
    if (!owner || !request?.turnId) return { state: 'not_found' };
    const receipt = this.read(owner), source = this.source(receipt.context), native = this.native();
    const goal = await native.readControlGoal(receipt.threadId);
    if (source.fingerprint !== receipt.source || receipt.target !== (this.options.target?.() ?? this.options.generation())
      || !receipt.goal || !receipt.attributionRetired && (!goal || !sameGoal(receipt.goal, goal)) || !receipt.turns?.includes(request.turnId)) return { state: 'not_found', mixed: true };
    return native.controlTurnLocation(receipt.threadId, request.turnId, this.knownInputs(requestId));
  }
  private knownInputs(requestId: string): string[] { return this.store.steeringInputs(requestId).filter(input => input.state !== 'refused').map(input => input.id); }
  async canReleaseNative(conversationId: string): Promise<boolean> {
    const owners = this.ids().map(id => this.read(id)).filter(row => row.conversationId === conversationId && row.goal && !row.goalClosed);
    if (!owners.length) return true;
    const threadId = owners[0].threadId;
    if (this.locks.has(threadId)) return false;
    try {
      const snapshot = await this.native().controlSnapshot(threadId);
      if (this.locks.has(threadId) || snapshot.goal?.status === 'active' || !['idle', 'notLoaded'].includes(snapshot.runtimeStatus)) return false;
      const before = new Set(owners.map(row => row.id));
      return !this.ids().map(id => this.read(id)).some(row => row.conversationId === conversationId
        && (row.state === 'sending' || row.goal && !row.goalClosed && !before.has(row.id)));
    } catch { return false; }
  }
  recover(): Promise<void> {
    if (this.recovering) return this.recovering;
    this.recovering = this.recoverGoals().finally(() => { this.recovering = undefined; });
    return this.recovering;
  }
  private async recoverGoals(): Promise<void> {
    const native = this.options.native();
    if (!this.options.available() || !native?.status().connected || !native.isVerifiedVersion()) return;
    for (const id of this.ids()) {
      let receipt = this.read(id);
      if (!receipt.goal || receipt.goalClosed || receipt.target !== (this.options.target?.() ?? this.options.generation())) continue;
      try {
        const source = this.source(receipt.context);
        if (source.fingerprint !== receipt.source) continue;
        if (receipt.lastGeneration !== this.options.generation()) {
          receipt.provenanceUncertain = true; receipt.deliveryUncertain = true; receipt.warning = deliveryWarning;
          receipt.lastGeneration = this.options.generation(); this.save(receipt);
        }
        let goal = receipt.attributionRetired ? receipt.goal! : await native.readControlGoal(receipt.threadId);
        if (!goal || !sameGoal(receipt.goal, goal)) {
          receipt.goalClosed = true; receipt.message = 'Native цель изменена другим действием. Доставка остановлена; требуется сверка.'; this.save(receipt); continue;
        }
        // Resume recovers this already-owned Goal; it never submits a new objective.
        if (goal.status === 'active') await native.subscribe(receipt.threadId);
        const turns = await native.controlTurns(receipt.threadId, receipt.turns?.filter(id => !receipt.completedTurns?.includes(id)));
        const index = await native.controlTurnIndex(receipt.threadId);
        const verifiedGoal = receipt.attributionRetired ? goal : await native.readControlGoal(receipt.threadId);
        if (!verifiedGoal || !sameGoal(goal, verifiedGoal)) {
          receipt = this.read(id); receipt.goalClosed = true;
          receipt.message = 'Native цель изменилась при проверке истории. Доставка остановлена; требуется сверка.'; this.save(receipt); continue;
        }
        receipt = this.read(id);
        const unlinked = receipt.attributionRetired ? [] : index.filter(turn => ['completed', 'failed', 'interrupted'].includes(turn.status)
          && !receipt.baselineTurns?.includes(turn.id) && !receipt.turns?.includes(turn.id)).map(turn => turn.id);
        receipt.unattributedTurns = [...new Set([...(receipt.unattributedTurns ?? []), ...unlinked])].filter(id => !receipt.turns?.includes(id));
        for (const turn of turns) if (receipt.turns?.includes(turn.id) && turn.status === 'inProgress') await this.ensureRequest(receipt.threadId, turn.id);
        for (const turn of receipt.identityAmbiguous ? [] : [...turns].reverse()) {
          if (!receipt.turns?.includes(turn.id) || receipt.completedTurns?.includes(turn.id) || !['completed', 'failed', 'interrupted'].includes(turn.status)) continue;
          const request = this.store.listRequests(1000).find(row => row.eventId === `native-goal:${receipt.id}:${turn.id}`);
          const proof = await native.controlTurnLocation(receipt.threadId, turn.id, request ? this.knownInputs(request.id) : []);
          if (proof.turnId !== turn.id || !['completed', 'failed', 'interrupted'].includes(proof.state)) continue;
          receipt.completedTurns = [...(receipt.completedTurns ?? []), turn.id];
          if (proof.mixed || turn.items.some(item => item.type === 'enteredReviewMode')) {
            receipt.provenanceUncertain = true;
            receipt.message = 'В ходе цели обнаружен другой ввод. Его содержимое не отправлено в Slack.'; continue;
          }
          for (const item of turn.items) if (item.type === 'agentMessage' && item.delivery !== 'async' && !item.questions
            && (item.phase == null || ['commentary', 'final_answer'].includes(item.phase)) && typeof item.text === 'string'
            && item.text.trim() && item.text.trim() !== 'NOREPLY' && item.id) {
            this.enqueue(receipt, `item:${turn.id}:${item.id}`, item.text);
          }
        }
        const terminalSnapshot = goal.status === 'complete' && !receipt.attributionRetired ? await native.controlSnapshot(receipt.threadId) : undefined;
        receipt = this.mergeJournal(receipt);
        if (receipt.attributionRetired) goal = receipt.goal!;
        receipt.goal = goal;
        receipt.nativeSettled = receipt.attributionRetired && receipt.nativeSettled === true || goal.status === 'complete' && terminalSnapshot?.goal?.status === 'complete' && sameGoal(goal, terminalSnapshot.goal)
          && ['idle', 'notLoaded'].includes(terminalSnapshot.runtimeStatus);
        const unresolved = receipt.turns?.some(id => !receipt.completedTurns?.includes(id)) ?? false;
        receipt.deliveryUncertain = !!receipt.provenanceUncertain || !!receipt.unattributedTurns?.length
          || !!receipt.outbox?.some(delivery => ['sending', 'uncertain'].includes(delivery.status));
        if (receipt.deliveryUncertain) { receipt.warning = deliveryWarning; this.enqueue(receipt, 'goal:delivery-uncertain', deliveryWarning); }
        else if (unresolved) receipt.warning = 'История ходов цели ещё не подтверждена полностью. Итог ожидает сверки native истории.';
        else delete receipt.warning;
        const running = unresolved || turns.some(turn => receipt.turns?.includes(turn.id) && turn.status === 'inProgress')
          || goal.status === 'complete' && !receipt.nativeSettled;
        if (goal.status === 'complete' && !running) {
          this.enqueue(receipt, receipt.deliveryUncertain ? 'goal:native-complete' : 'goal:terminal',
            `Цель завершена по состоянию Codex.\n${goal.objective}\nИспользовано токенов: ${goal.tokensUsed}; времени: ${goal.timeUsedSeconds} с.${receipt.deliveryUncertain ? '\nДоставка этапов неполна или не подтверждена; это сообщение подтверждает только native состояние цели.' : ''}`);
        } else if (goal.status !== 'active') this.enqueue(receipt, `goal:state:${goal.status}:${goal.updatedAt}`, `Состояние цели Codex: ${goal.status}.\nИспользовано токенов: ${goal.tokensUsed}.`);
        this.save(receipt);
        await this.flush(id);
        receipt = this.read(id);
        const lateUnknown = receipt.turns?.some(id => !receipt.completedTurns?.includes(id)) || receipt.lastGeneration !== this.options.generation();
        if (goal.status === 'complete' && !running && lateUnknown) {
          receipt.provenanceUncertain = true; receipt.deliveryUncertain = true; receipt.warning = deliveryWarning;
          this.enqueue(receipt, 'goal:delivery-uncertain', deliveryWarning); this.save(receipt); await this.flush(id); receipt = this.read(id);
        }
        if (goal.status === 'complete' && !running && !lateUnknown && !receipt.deliveryUncertain && receipt.outbox?.some(row => row.key === 'goal:terminal' && row.status === 'sent')
          && receipt.outbox.every(row => row.status === 'sent')) { receipt.goalClosed = true; this.save(receipt); }
      } catch { /* Keep the native owner and outbox intact for the next read-only reconciliation. */ }
    }
  }
  private enqueue(receipt: Receipt, deliveryKey: string, body: string): void {
    for (const [part, chunk] of splitReply(body, 3000).entries()) {
      const key = part ? `${deliveryKey}:${part}` : deliveryKey;
      if (receipt.outbox?.some(row => row.key === key)) continue;
      if ((receipt.outbox?.length ?? 0) >= 1000) { receipt.message = 'Достигнут предел истории цели. Требуется сверка; доставка новых этапов приостановлена.'; return; }
      const now = new Date().toISOString();
      (receipt.outbox ??= []).push({ id: randomUUID(), operationId: receipt.id, conversationId: receipt.conversationId,
        nativeThreadId: receipt.threadId, origin: receipt.origin, key, ordinal: receipt.outbox?.length ?? 0,
        kind: 'message', body: chunk, status: 'pending', attempts: 0, createdAt: now, updatedAt: now });
    }
  }
  private async flush(id: string): Promise<void> {
    let receipt = this.read(id);
    for (const deliveryId of (receipt.outbox ?? []).map(row => row.id)) {
      receipt = this.read(id);
      const delivery = receipt.outbox!.find(row => row.id === deliveryId)!;
      if (delivery.status === 'sent') continue;
      if (receipt.identityAmbiguous && delivery.key.startsWith('item:')) delivery.status = 'uncertain';
      if (delivery.status === 'sending' || delivery.status === 'uncertain') {
        delivery.status = 'uncertain'; receipt.message = 'Результат доставки этапа неизвестен. Проверьте исходный Slack-тред; автоматического повтора не будет.'; this.save(receipt); break;
      }
      const source = this.source(receipt.context), channel = this.options.channel();
      if (source.fingerprint !== receipt.source || !channel?.state.connected || channel.state.accountId !== receipt.context.accountId) break;
      delivery.status = 'sending'; delivery.attempts++; this.save(receipt);
      try {
        const remote = await channel.deliver(delivery);
        receipt = this.read(id);
        const current = receipt.outbox!.find(row => row.id === delivery.id)!;
        current.status = 'sent'; current.remoteMessageId = remote; this.save(receipt);
      } catch (error) {
        receipt = this.read(id); receipt.outbox!.find(row => row.id === delivery.id)!.status = 'uncertain';
        receipt.message = `Результат доставки неизвестен. ${this.options.redact(error)}`; this.save(receipt); break;
      }
    }
  }
}
