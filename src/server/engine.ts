import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Approval, ApprovalQuestion, InboundMessage, Platform, ReleRequest } from '../shared/types.js';
import { CodexClient, CodexRpcError, type CodexNotification, type CodexServerRequest, type RequestLocation } from './codex.js';
import { Store } from './store.js';
import type { AppConfig } from './config.js';
import { ChannelError, splitReply, type ApprovalAction, type Channel } from './channels/common.js';
import { transcribeAudio } from './voice.js';

export type CodexGateway = Pick<CodexClient, 'status' | 'subscribe' | 'enqueue' | 'interrupt' | 'findRequest' | 'respond' | 'deleteQueued' | 'startQueued'> & Pick<EventEmitter, 'on' | 'off'>;
export interface EngineOptions {
  config: () => AppConfig;
  temporaryRoot: string;
  redact: (error: unknown) => string;
  transcribe?: typeof transcribeAudio;
}
const terminal = (status: ReleRequest['status']) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
const mixedMessage = 'В ход Rele добавлено сообщение из другого клиента Codex. Смешанный ответ не отправляется в мессенджер.';

/** The request's immutable origin, never the last active channel, owns all its deliveries. */
export class Engine extends EventEmitter {
  channels: Partial<Record<Platform, Channel>> = {};
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private tasks = new Set<Promise<unknown>>();
  private dispatching = new Set<string>();
  private reconciling = new Set<string>();
  private sending = false;
  private events: Promise<void> = Promise.resolve();
  private abort = new AbortController();
  private connected = false;
  private epoch = randomUUID();
  private approvals = new Map<string, { accept: boolean; decline: string }>();
  private fileChanges = new Map<string, string>();
  private resolutions = new Set<string>();
  private lastReconcile = 0;
  private suspended = false;
  private readonly notification = (event: CodexNotification) => this.event(() => this.onNotification(event));
  private readonly serverRequest = (event: CodexServerRequest) => this.event(() => this.onServerRequest(event));
  private readonly connection = () => this.connectionChanged();

  constructor(readonly store: Store, public codex: CodexGateway, private readonly options: EngineOptions) {
    super();
    codex.on('notification', this.notification);
    codex.on('request', this.serverRequest);
    codex.on('status', this.connection);
  }

  suspend(value: boolean): void { this.suspended = value; }
  replaceCodex(next: CodexGateway): void {
    this.codex.off('notification', this.notification); this.codex.off('request', this.serverRequest); this.codex.off('status', this.connection);
    this.expireApprovals(); this.epoch = randomUUID(); this.connected = false;
    this.codex = next;
    next.on('notification', this.notification); next.on('request', this.serverRequest); next.on('status', this.connection);
    this.connectionChanged();
  }

  start(): void {
    this.stopped = false;
    this.store.recoverInterrupted();
    this.expireApprovals();
    this.connectionChanged();
    this.timer = setInterval(() => this.track(this.pump()), 1000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.abort.abort();
    this.codex.off('notification', this.notification);
    this.codex.off('request', this.serverRequest);
    this.codex.off('status', this.connection);
    await this.events;
    await Promise.allSettled([...this.tasks]);
  }

  async receive(message: InboundMessage): Promise<void> {
    if (this.stopped) throw new ChannelError('Rele завершает работу; событие будет доставлено повторно.', true);
    // A reply to a pending, single non-secret question belongs to that approval.
    const pending = this.store.listApprovals(1000).filter(approval => approval.status === 'pending' && approval.questions?.length === 1 && !approval.questions[0].isSecret);
    const approval = pending.find(candidate => {
      const request = this.store.getRequest(candidate.requestId);
      if (!request || !this.sameOrigin(request, message)) return false;
      const delivered = this.store.listDeliveries(2000).find(delivery => delivery.approvalId === candidate.id && delivery.status === 'sent');
      return message.endpoint.platform === 'slack' ? !!delivered : !!delivered && delivered.remoteMessageId === message.replyToMessageId;
    });
    if (approval && message.text.trim() && !message.audio) {
      // Record first: after any crash this event cannot become a fresh Codex turn.
      // A crash before resolution leaves the question available in the panel.
      if (this.store.recordInbound(message).duplicate) return;
      await this.resolveApproval(approval.id, 'accept', { [approval.questions![0].id]: [message.text] });
    } else {
      this.store.ingest(message);
    }
    this.changed();
    this.track(this.pump());
  }

  async action(action: ApprovalAction): Promise<void> {
    const approval = this.store.getApproval(action.approvalId);
    const request = approval && this.store.getRequest(approval.requestId);
    const origin = request?.origin;
    if (!origin || origin.platform !== action.platform || origin.accountId !== action.accountId || origin.chatId !== action.chatId || origin.senderId !== action.senderId || origin.threadId !== (action.threadId ?? '')) throw new Error('Это подтверждение доступно только отправителю исходного запроса.');
    await this.resolveApproval(action.approvalId, action.decision);
  }

  async resolveApproval(id: string, decision: 'accept' | 'decline', answers?: Record<string, string[]>): Promise<void> {
    const approval = this.store.getApproval(id);
    const request = approval && this.store.getRequest(approval.requestId);
    if (!approval || approval.status !== 'pending' || !request || terminal(request.status) || this.resolutions.has(id)) throw new Error('Подтверждение уже завершено или недоступно.');
    if (!this.codex.status().connected) throw new ChannelError('Codex отключён. Дождитесь повторного подключения.', true);
    if (this.isMixed(request.id)) throw new Error('Ход изменён другим клиентом. Продолжите подтверждение в Codex.');
    let result: unknown;
    if (approval.method === 'item/tool/requestUserInput') {
      const values: Record<string, { answers: string[] }> = {};
      for (const question of approval.questions ?? []) {
        const answer = answers?.[question.id];
        if (decision === 'accept' && (!Array.isArray(answer) || !answer.length || answer.some(text => typeof text !== 'string' || !text.trim() || text.length > 10_000))) throw new Error('Ответьте на каждый вопрос.');
        values[question.id] = { answers: decision === 'accept' ? answer! : [] };
      }
      result = { answers: values };
    } else {
      const capability = this.approvals.get(id);
      if (!capability || (decision === 'accept' && !capability.accept)) throw new Error('Это подтверждение нужно выполнить в Codex.');
      result = { decision: decision === 'accept' ? 'accept' : capability.decline };
    }
    this.resolutions.add(id);
    // Persist intent before the wire write. On a crash or disconnect this is not replayed.
    this.store.updateApproval(id, { status: 'answered', decision });
    try {
      await this.codex.respond(approval.rpcId, result);
      const current = this.store.getRequest(request.id)!;
      if (current.status === 'waiting_approval') this.store.updateRequest(request.id, { status: 'running' });
      this.cancelPendingApprovalDeliveries(id);
    } catch (error) {
      this.store.updateApproval(id, { status: 'expired', decision: 'uncertain' });
      if (!terminal(this.store.getRequest(request.id)!.status)) this.store.updateRequest(request.id, { status: 'uncertain', error: 'Результат подтверждения неизвестен. Проверьте запрос в Codex.' });
      throw new Error(this.options.redact(error));
    } finally { this.resolutions.delete(id); this.changed(); }
  }

  async cancel(id: string): Promise<void> {
    const request = this.store.getRequest(id);
    if (!request || terminal(request.status)) throw new Error('Запрос уже завершён.');
    if (request.status === 'queued' || request.status === 'transcribing') {
      this.store.finishRequest(id, { status: 'cancelled' }, []);
      this.changed(); return;
    }
    const conversation = this.store.getConversation(request.conversationId)!;
    const found = await this.codex.findRequest(conversation.threadId, request.id);
    if (found.state === 'queued' && found.queuedSubmissionId) {
      const removed = await this.codex.deleteQueued(conversation.threadId, found.queuedSubmissionId);
      if (!removed.deleted) throw new Error('Запрос уже начал выполняться. Сверьте состояние и повторите отмену.');
      this.store.finishRequest(id, { status: 'cancelled' }, []);
    } else if (found.state === 'running' && found.turnId) {
      await this.codex.interrupt(conversation.threadId, found.turnId);
    } else if (found.state !== 'not_found') {
      this.finishFromHistory(request, found);
    } else throw new Error('Codex пока не подтвердил состояние запроса. Отмена без сверки недоступна.');
    this.changed();
  }

  async resume(id: string): Promise<void> {
    const request = this.store.getRequest(id);
    if (!request || terminal(request.status)) throw new Error('Запрос уже завершён.');
    const conversation = this.store.getConversation(request.conversationId)!;
    const found = await this.codex.findRequest(conversation.threadId, id);
    if (found.state !== 'queued' || !found.queuedSubmissionId) throw new Error('Запрос не находится в очереди Codex.');
    await this.codex.startQueued(conversation.threadId, found.queuedSubmissionId);
    await this.reconcile(id);
  }

  retryDelivery(id: string): void {
    const delivery = this.store.getDelivery(id);
    if (!delivery || delivery.status !== 'failed') throw new Error('Повтор допустим только для доставки с подтверждённым отказом. Неопределённую доставку сначала проверьте в мессенджере.');
    this.store.updateDelivery(id, { status: 'pending', error: undefined, nextAttemptAt: undefined });
    this.track(this.deliver());
    this.changed();
  }

  async reconcile(id: string): Promise<void> {
    if (this.reconciling.has(id)) return;
    const request = this.store.getRequest(id);
    if (!request || terminal(request.status) || ['queued', 'transcribing'].includes(request.status)) return;
    this.reconciling.add(id);
    try {
      const conversation = this.store.getConversation(request.conversationId)!;
      await this.codex.subscribe(conversation.threadId);
      const found = await this.codex.findRequest(conversation.threadId, id);
      if (terminal(this.store.getRequest(id)!.status)) return;
      if (found.mixed) this.store.setMeta(`mixed:${id}`, '1');
      if (found.state === 'not_found') this.store.updateRequest(id, { status: 'uncertain', error: 'Запрос не найден в очереди и истории Codex. Автоматическая повторная отправка запрещена; требуется сверка.' });
      else if (found.state === 'queued') this.store.updateRequest(id, { status: 'starting', queuedSubmissionId: found.queuedSubmissionId, error: undefined });
      else if (found.state === 'running') {
        const pending = this.store.listApprovals(1000).some(approval => approval.requestId === id && approval.status === 'pending');
        this.store.updateRequest(id, { status: this.isMixed(id) ? 'uncertain' : pending ? 'waiting_approval' : 'running', turnId: found.turnId, error: this.isMixed(id) ? mixedMessage : undefined });
      } else this.finishFromHistory(request, found);
    } catch (error) {
      if (!terminal(this.store.getRequest(id)!.status)) this.store.updateRequest(id, { status: 'uncertain', error: this.options.redact(error) });
    } finally { this.reconciling.delete(id); this.changed(); }
  }

  /** Exposed to deterministic integration tests; the timer uses this same path. */
  async pump(): Promise<void> {
    if (this.stopped) return;
    const work: Promise<unknown>[] = [this.deliver()];
    if (!this.suspended && this.codex.status().connected) for (const conversation of this.store.listConversations()) {
      if (!conversation.paused && !this.dispatching.has(conversation.id)) work.push(this.dispatch(conversation.id));
    }
    if (this.codex.status().connected && Date.now() - this.lastReconcile > 15_000) {
      this.lastReconcile = Date.now();
      for (const request of this.store.activeRequests()) if (!['queued', 'transcribing'].includes(request.status) && !this.dispatching.has(request.conversationId)) work.push(this.reconcile(request.id));
    }
    await Promise.allSettled(work);
  }

  async settled(): Promise<void> { await this.events; await Promise.allSettled([...this.tasks]); }

  private async dispatch(conversationId: string): Promise<void> {
    this.dispatching.add(conversationId);
    let request: ReleRequest | undefined;
    let attempted = false;
    try {
      const conversation = this.store.getConversation(conversationId)!;
      if (!this.store.listPendingRequests().some(row => row.conversationId === conversationId)) return;
      await this.codex.subscribe(conversation.threadId);
      if (!this.codex.status().queueSupported || this.stopped || this.suspended) return;
      request = this.store.claimNextRequest(conversationId);
      if (!request) return;
      if (request.audio) {
        this.store.updateRequest(request.id, { status: 'transcribing' });
        const channel = this.channels[request.origin.platform];
        if (!channel) throw new Error('Источник аудио отключён.');
        const spoken = await (this.options.transcribe ?? transcribeAudio)(request.audio, channel, this.options.config().voice, this.options.temporaryRoot, this.abort.signal);
        if (this.store.getRequest(request.id)!.status === 'cancelled') return;
        if (this.stopped) { this.store.updateRequest(request.id, { status: 'queued' }); return; }
        request = this.store.updateRequest(request.id, { status: 'starting', text: [request.text, spoken].filter(Boolean).join('\n\n') });
      }
      if (this.stopped) { this.store.updateRequest(request.id, { status: 'queued' }); return; }
      attempted = true;
      const result = await this.codex.enqueue(conversation.threadId, request.text, request.id);
      // The userMessage and completion notifications may arrive before this ACK.
      this.store.updateRequest(request.id, { queuedSubmissionId: result.queuedSubmissionId });
    } catch (error) {
      if (request && !terminal(this.store.getRequest(request.id)!.status)) {
        if (attempted && !(error instanceof CodexRpcError)) this.store.updateRequest(request.id, { status: 'uncertain', error: this.options.redact(error) });
        else if (this.stopped) this.store.updateRequest(request.id, { status: 'queued' });
        else this.fail(request.id, this.options.redact(error));
      }
    } finally { this.dispatching.delete(conversationId); this.changed(); }
  }

  private async deliver(): Promise<void> {
    if (this.sending || this.stopped) return;
    this.sending = true;
    try {
      for (let count = 0; count < 20 && !this.stopped; count++) {
        const delivery = this.store.claimDelivery();
        if (!delivery) break;
        const approval = delivery.approvalId ? this.store.getApproval(delivery.approvalId) : undefined;
        if (delivery.kind === 'approval' && approval?.status !== 'pending') {
          this.store.updateDelivery(delivery.id, { status: 'cancelled', error: 'Подтверждение уже завершено.' }); continue;
        }
        const channel = this.channels[delivery.origin.platform];
        if (!channel?.state.connected) {
          this.store.updateDelivery(delivery.id, { status: 'pending', nextAttemptAt: new Date(Date.now() + 5000).toISOString() }); continue;
        }
        try {
          const remoteMessageId = await channel.deliver(delivery, approval);
          this.store.updateDelivery(delivery.id, { status: 'sent', remoteMessageId, error: undefined });
        } catch (error) {
          const classified = error instanceof ChannelError ? error : new ChannelError('Результат доставки неизвестен.', false, true);
          this.store.updateDelivery(delivery.id, {
            status: classified.uncertain ? 'uncertain' : classified.retryable ? 'pending' : 'failed',
            error: this.options.redact(classified),
            ...(classified.retryable && !classified.uncertain ? { nextAttemptAt: new Date(Date.now() + classified.retryAfterMs).toISOString() } : {}),
          });
        }
      }
    } finally { this.sending = false; this.changed(); }
  }

  private async onNotification({ method, params }: CodexNotification): Promise<void> {
    const p = params as Record<string, any>;
    if (['item/started', 'item/completed'].includes(method) && p.item?.type === 'fileChange') {
      this.fileChanges.set(String(p.item.id), JSON.stringify(p.item.changes ?? [], null, 2).slice(0, 12_000));
      if (this.fileChanges.size > 100) this.fileChanges.delete(this.fileChanges.keys().next().value!);
    }
    if (['item/started', 'item/completed'].includes(method) && p.item?.type === 'userMessage' && typeof p.turnId === 'string') {
      const own = typeof p.item.clientId === 'string' ? this.store.getRequest(p.item.clientId) : undefined;
      const conversation = own && this.store.getConversation(own.conversationId);
      if (own && conversation?.threadId === p.threadId && !terminal(own.status)) {
        this.store.updateRequest(own.id, { turnId: p.turnId, status: this.isMixed(own.id) ? 'uncertain' : 'running' });
      }
      for (const active of this.store.activeRequests()) {
        if (active.turnId === p.turnId && this.store.getConversation(active.conversationId)?.threadId === p.threadId && active.id !== p.item.clientId) {
          this.store.setMeta(`mixed:${active.id}`, '1');
          this.store.updateRequest(active.id, { status: 'uncertain', error: mixedMessage });
          for (const approval of this.store.listApprovals(1000)) if (approval.requestId === active.id && approval.status === 'pending') {
            this.store.updateApproval(approval.id, { status: 'expired' }); this.cancelPendingApprovalDeliveries(approval.id);
          }
        }
      }
    } else if (method === 'turn/completed' && p.turn?.id) {
      for (const request of this.store.activeRequests()) if (request.turnId === p.turn.id || (request.status === 'starting' && this.store.getConversation(request.conversationId)?.threadId === p.threadId)) await this.reconcile(request.id);
    } else if (method === 'serverRequest/resolved') {
      for (const approval of this.store.listApprovals(1000)) if (approval.rpcId === p.requestId && approval.status === 'pending') {
        const request = this.store.getRequest(approval.requestId)!;
        if (this.store.getConversation(request.conversationId)?.threadId !== p.threadId) continue;
        this.store.updateApproval(approval.id, { status: 'answered', decision: 'resolved_in_codex' });
        this.cancelPendingApprovalDeliveries(approval.id);
        if (request.status === 'waiting_approval') this.store.updateRequest(request.id, { status: 'running' });
      }
    }
    this.changed();
  }

  private async onServerRequest(event: CodexServerRequest): Promise<void> {
    const p = event.params as Record<string, any>;
    const request = this.store.activeRequests().find(row => row.turnId === p.turnId && this.store.getConversation(row.conversationId)?.threadId === p.threadId);
    // Desktop requests belong to Desktop. A broadcast is not authorization to answer them.
    if (!request || this.isMixed(request.id)) return;
    const question = event.method === 'item/tool/requestUserInput';
    const command = event.method === 'item/commandExecution/requestApproval';
    const files = event.method === 'item/fileChange/requestApproval';
    if (!question && !command && !files) {
      this.store.updateRequest(request.id, { status: 'waiting_approval', error: 'Codex запросил действие, которое нужно подтвердить в самом Codex.' }); this.changed(); return;
    }
    const questions: ApprovalQuestion[] | undefined = question && Array.isArray(p.questions) ? p.questions.map((entry: Record<string, any>) => ({ id: String(entry.id), header: String(entry.header ?? ''), question: String(entry.question ?? ''), isSecret: !!entry.isSecret, ...(Array.isArray(entry.options) ? { options: entry.options.map((option: Record<string, any>) => ({ label: String(option.label), description: String(option.description ?? '') })) } : {}) })) : undefined;
    const title = question ? 'Codex ждёт уточнения' : command ? 'Codex запрашивает выполнение команды' : 'Codex запрашивает изменение файлов';
    const details = [p.reason, p.command, p.cwd ? `Каталог: ${p.cwd}` : '', p.grantRoot ? `Доступ на запись: ${p.grantRoot}` : '', p.additionalPermissions ? JSON.stringify(p.additionalPermissions) : '', files ? this.fileChanges.get(String(p.itemId)) : '', questions?.map(value => `${value.header}: ${value.question}${value.options?.length ? '\n' + value.options.map(option => `${option.label} — ${option.description}`).join('\n') : ''}`).join('\n\n')].filter(Boolean).join('\n\n').slice(0, 16_000);
    const approval = this.store.addApproval({ requestId: request.id, turnId: p.turnId, itemId: `${p.itemId}:${p.approvalId ?? event.id}:${this.epoch}`, rpcId: event.id, method: event.method, title, details, questions });
    const choices: unknown[] | undefined = Array.isArray(p.availableDecisions) ? p.availableDecisions : undefined;
    this.approvals.set(approval.id, { accept: !choices || choices.includes('accept'), decline: choices?.includes('cancel') && !choices.includes('decline') ? 'cancel' : 'decline' });
    this.store.updateRequest(request.id, { status: 'waiting_approval' });
    const guidance = questions?.length === 1 && !questions[0].isSecret ? '\n\nОтветьте на это сообщение. Все вопросы также доступны в локальной панели Rele.' : questions?.length ? '\n\nОтветьте на вопросы в локальной панели Rele.' : '';
    // Short transport preview; full details are available only in the authenticated panel.
    this.store.addDeliveries(request.id, [{ key: `approval:${approval.id}`, ordinal: 0, kind: 'approval', body: `${title}\n\n${details.slice(0, 2400)}${details.length > 2400 ? '\n… Полный запрос доступен в панели Rele.' : ''}${guidance}`, approvalId: approval.id }]);
    this.changed();
    this.track(this.deliver());
  }

  private finishFromHistory(request: ReleRequest, found: RequestLocation): void {
    if (found.mixed || this.isMixed(request.id)) { this.store.setMeta(`mixed:${request.id}`, '1'); this.store.finishRequest(request.id, { status: 'failed', turnId: found.turnId, error: mixedMessage }, []); return; }
    if (found.state === 'completed') {
      this.store.finishRequest(request.id, { status: 'completed', turnId: found.turnId, error: undefined }, splitReply(found.text ?? '').map((body, ordinal) => ({ key: `answer:${ordinal}`, ordinal, kind: 'answer' as const, body })));
    } else if (found.state === 'failed' || found.state === 'interrupted') {
      const error = found.state === 'interrupted' ? 'Выполнение запроса остановлено в Codex.' : 'Codex завершил запрос с ошибкой. Подробности доступны в Codex.';
      this.store.finishRequest(request.id, { status: found.state, turnId: found.turnId, error }, [{ key: 'terminal:error', ordinal: 0, kind: 'error', body: error }]);
    }
  }

  private fail(id: string, error: string): void { this.store.finishRequest(id, { status: 'failed', error }, [{ key: 'terminal:error', ordinal: 0, kind: 'error', body: error }]); }
  private isMixed(id: string): boolean { return this.store.getMeta(`mixed:${id}`) === '1'; }
  private sameOrigin(request: ReleRequest, message: InboundMessage): boolean { const origin = request.origin; return origin.platform === message.endpoint.platform && origin.accountId === message.endpoint.accountId && origin.chatId === message.endpoint.chatId && origin.threadId === message.endpoint.threadId && origin.senderId === message.sender.id; }
  private cancelPendingApprovalDeliveries(id: string): void { for (const delivery of this.store.listDeliveries(2000)) if (delivery.approvalId === id && delivery.status === 'pending') this.store.updateDelivery(delivery.id, { status: 'cancelled' }); }
  private expireApprovals(): void {
    for (const approval of this.store.listApprovals(1000)) if (approval.status === 'pending') { this.store.updateApproval(approval.id, { status: 'expired' }); this.cancelPendingApprovalDeliveries(approval.id); }
    this.approvals.clear();
  }
  private connectionChanged(): void {
    if (this.stopped) return;
    const connected = this.codex.status().connected;
    if (!connected && this.connected) {
      this.epoch = randomUUID(); this.expireApprovals();
      for (const request of this.store.activeRequests()) if (['starting', 'running', 'waiting_approval'].includes(request.status)) this.store.updateRequest(request.id, { status: 'uncertain', error: 'Соединение с Codex прервано. Требуется сверка очереди и истории.' });
    }
    if (connected && !this.connected) for (const request of this.store.activeRequests()) if (!['queued', 'transcribing'].includes(request.status)) this.track(this.reconcile(request.id));
    this.connected = connected;
    this.changed();
  }
  private event(action: () => Promise<void>): void { if (!this.stopped) this.events = this.events.then(action).catch(error => { this.emit('diagnostic', this.options.redact(error)); }); }
  private track<T>(task: Promise<T>): void { this.tasks.add(task); void task.catch(error => this.emit('diagnostic', this.options.redact(error))).finally(() => this.tasks.delete(task)); }
  private changed(): void { this.emit('change'); }
}
