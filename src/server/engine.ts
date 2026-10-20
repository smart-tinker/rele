import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import type { Approval, ApprovalQuestion, AutoLinkIntent, InboundMessage, Platform, ReleRequest } from '../shared/types.js';
import { CodexClient, CodexRpcError, CodexThreadBusyError, type CodexNotification, type CodexServerRequest, type RequestLocation } from './codex.js';
import { Store } from './store.js';
import type { AppConfig } from './config.js';
import { ChannelError, splitReply, type ApprovalAction, type Channel } from './channels/common.js';
import { transcribeAudio } from './voice.js';
import { SlackSync } from './slack-sync.js';
import { splitSlackReply } from './channels/slack-format.js';

export type CodexGateway = Pick<CodexClient, 'status' | 'isVerifiedVersion' | 'createThread' | 'setThreadName' | 'injectContext' | 'subscribe' | 'releaseThread' | 'enqueue' | 'interrupt' | 'findRequest' | 'respond' | 'rejectRequest' | 'deleteQueued' | 'startQueued'> & Pick<EventEmitter, 'on' | 'off'>;
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
  private reconcileAgain = new Set<string>();
  private provisioning = new Set<string>();
  private ownedThreads = new Set<string>();
  private releasing = new Map<string, Promise<void>>();
  private retryThreadAfter = new Map<string, number>();
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
  private readonly slackSync: SlackSync;
  private slackConnection?: string;
  private readonly notification = (event: CodexNotification) => this.event(() => this.onNotification(event));
  private readonly serverRequest = (event: CodexServerRequest) => this.event(() => this.onServerRequest(event));
  private readonly connection = () => this.connectionChanged();

  constructor(readonly store: Store, public codex: CodexGateway, private readonly options: EngineOptions) {
    super();
    this.slackSync = new SlackSync(store, () => this.channels.slack, () => this.codex);
    codex.on('notification', this.notification);
    codex.on('request', this.serverRequest);
    codex.on('status', this.connection);
  }

  suspend(value: boolean): void { this.suspended = value; }
  channelStatus(): void {
    const channel = this.channels.slack;
    const identity = JSON.stringify([channel?.state.accountId, channel?.state.connected]);
    if (this.slackConnection !== identity) { this.slackConnection = identity; this.slackSync.invalidate(); }
  }
  replaceCodex(next: CodexGateway): void {
    this.codex.off('notification', this.notification); this.codex.off('request', this.serverRequest); this.codex.off('status', this.connection);
    this.expireApprovals(); this.epoch = randomUUID(); this.connected = false;
    this.ownedThreads.clear(); this.releasing.clear(); this.retryThreadAfter.clear();
    this.codex = next;
    next.on('notification', this.notification); next.on('request', this.serverRequest); next.on('status', this.connection);
    this.connectionChanged();
  }

  start(): void {
    this.stopped = false;
    this.store.recoverInterrupted();
    for (const request of this.store.activeRequests()) if (request.status !== 'queued' && !this.store.getMeta(`request-started:${request.id}`)) {
      this.store.setMeta(`request-started:${request.id}`, String(Date.now()));
    }
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
    if (message.control === 'stop' || !message.contextOnly && !message.audio && /^(?:rele:cancel|\/rele_cancel)$/iu.test(message.text.trim())) {
      if (this.store.recordInbound(message).duplicate) return;
      const requests = this.store.activeRequests().filter(request => this.sameOrigin(request, message)
        // A delayed native Stop must not reach the next run, even if it was queued before the click.
        && (!message.control || request.status !== 'queued' && Number(this.store.getMeta(`request-started:${request.id}`) ?? Infinity) <= Number(message.messageId) * 1000));
      const request = requests.find(request => request.status !== 'queued') ?? requests[0];
      if (request) {
        const cancellation = this.cancelFromOrigin(request.id, message.eventId);
        // Socket Mode ACK follows the durable intent, without waiting for native RPC.
        if (message.control) this.track(cancellation);
        else await cancellation;
      }
      this.changed();
      this.track(this.pump());
      return;
    }
    // Telegram has an explicit reply target. Even a stale approval reply remains
    // an approval receipt, never a new agent task. Slack uses its active question.
    const approval = message.contextOnly ? undefined : message.endpoint.platform === 'telegram'
      ? message.replyToMessageId ? this.store.findReplyApproval(message.endpoint, message.replyToMessageId) : undefined
      : this.store.listApprovals(1000).find(candidate => {
        if (candidate.status !== 'pending' || !candidate.questions?.length || candidate.questions.some(question => question.isSecret)) return false;
        const request = this.store.getRequest(candidate.requestId);
        return !!request && this.sameOrigin(request, message) && this.store.approvalDeliveryProgress(candidate.id).sent;
      });
    if (approval && (message.endpoint.platform === 'telegram' || (message.text.trim() && !message.audio))) {
      // Record first: after any crash this event cannot become a fresh Codex turn.
      // A crash before resolution leaves the question available in the panel.
      if (this.store.recordInbound(message).duplicate) return;
      const request = this.store.getRequest(approval.requestId);
      const allPartsSent = this.store.approvalDeliveryProgress(approval.id).complete;
      if (approval.status === 'pending' && allPartsSent && request && !terminal(request.status) && this.sameOrigin(request, message)
          && approval.questions?.length && !approval.questions.some(question => question.isSecret) && message.text.trim() && !message.audio) {
        const questions = approval.questions;
        const lines = questions.length === 1 ? [message.text] : message.text.trim().split(/\r?\n/u).filter(line => line.trim());
        if (questions.length > 1 && (lines.length !== questions.length || lines.some((line, index) => !line.startsWith(`${index + 1}. `) || !line.slice(line.indexOf(' ') + 1).trim()))) {
          this.store.addDeliveries(request.id, [{ key: `question-format:${message.eventId}`, ordinal: 0, kind: 'error', body: 'Ответьте одной строкой на каждый вопрос, по порядку: 1. ответ, затем с новой строки 2. ответ.' }]);
        } else {
          await this.resolveApproval(approval.id, 'accept', Object.fromEntries(questions.map((question, index) => [question.id, [questions.length === 1 ? lines[index] : lines[index].slice(lines[index].indexOf(' ') + 1)]])));
        }
      }
    } else {
      const config = this.options.config();
      const rule = config.autoLinkRules?.find(rule => rule.enabled && rule.platform === message.endpoint.platform &&
        rule.accountId === message.endpoint.accountId && rule.chatId === message.endpoint.chatId);
      const channel = this.channels[message.endpoint.platform];
      this.store.ingest(message, rule && config[rule.platform].enabled && channel?.state.accountId === rule.accountId
        ? { rule, targetFingerprint: this.targetFingerprint() } : undefined);
    }
    this.changed();
    this.track(this.pump());
  }

  private async cancelFromOrigin(requestId: string, eventId: string): Promise<void> {
    let body: string;
    try {
      await this.cancel(requestId);
      body = this.store.getRequest(requestId)?.status === 'cancelled'
        ? 'Запрос отменён в Rele.' : 'Отмена передана Codex. Rele проверит завершение выполнения.';
    } catch (error) { body = this.options.redact(error); }
    this.store.addDeliveries(requestId, [{ key: `control:${eventId}`, ordinal: 0, kind: 'error', body }]);
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
    if (!this.codex.status().queueSupported) throw new Error('Подтверждения недоступны для непроверенного runtime Codex.');
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
      this.store.cancelApprovalDeliveries(id);
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
      this.store.finishRequest(id, { status: 'cancelled', error: undefined }, []);
      await this.releaseIdleThread(request.conversationId);
      this.changed(); return;
    }
    const conversation = this.store.getConversation(request.conversationId)!;
    const found = await this.codex.findRequest(conversation.threadId, request.id);
    if (found.mixed || this.isMixed(request.id)) throw new Error('В ход добавлено сообщение другого клиента Codex. Автоматическая отмена смешанного хода недоступна.');
    if (found.state === 'queued' && found.queuedSubmissionId) {
      const removed = await this.codex.deleteQueued(conversation.threadId, found.queuedSubmissionId);
      if (!removed.deleted) throw new Error('Запрос уже начал выполняться. Сверьте состояние и повторите отмену.');
      this.store.finishRequest(id, { status: 'cancelled' }, []);
    } else if (found.state === 'running' && found.turnId) {
      await this.codex.interrupt(conversation.threadId, found.turnId);
    } else if (found.state !== 'not_found') {
      this.finishFromHistory(request, found);
    } else throw new Error('Codex пока не подтвердил состояние запроса. Отмена без сверки недоступна.');
    await this.releaseIdleThread(request.conversationId);
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
    if (this.reconciling.has(id)) { this.reconcileAgain.add(id); return; }
    const request = this.store.getRequest(id);
    if (!request || terminal(request.status) || ['queued', 'transcribing'].includes(request.status)) return;
    this.reconciling.add(id);
    try {
      const conversation = this.store.getConversation(request.conversationId)!;
      await this.releasing.get(conversation.id);
      await this.codex.subscribe(conversation.threadId);
      this.ownedThreads.add(conversation.id);
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
    } finally {
      this.reconciling.delete(id);
      if (this.reconcileAgain.delete(id) && !this.stopped) this.track(this.reconcile(id));
      await this.releaseIdleThread(request.conversationId);
      this.changed();
    }
  }

  /** Exposed to deterministic integration tests; the timer uses this same path. */
  async pump(): Promise<void> {
    if (this.stopped) return;
    const work: Promise<unknown>[] = [this.deliver()];
    if (!this.suspended) {
      await Promise.allSettled(this.store.listAutoLinkIntents().filter(intent => intent.status !== 'completed').map(intent => this.provision(intent)));
      await this.slackSync.backfill();
    }
    if (this.stopped) { await Promise.allSettled(work); return; }
    if (!this.suspended && this.codex.status().connected) for (const conversation of this.store.listConversations()) {
      if (!conversation.paused && !this.dispatching.has(conversation.id) && !this.releasing.has(conversation.id)
          && Date.now() >= (this.retryThreadAfter.get(conversation.id) ?? 0)) work.push(this.dispatch(conversation.id));
    }
    if (this.codex.status().connected && Date.now() - this.lastReconcile > 15_000) {
      this.lastReconcile = Date.now();
      for (const request of this.store.activeRequests()) if (!['queued', 'transcribing'].includes(request.status) && !this.dispatching.has(request.conversationId)) work.push(this.reconcile(request.id));
    }
    await Promise.allSettled(work);
  }

  private targetFingerprint(): string {
    const { transport, executable, endpoint, codexHome } = this.options.config().codex;
    return createHash('sha256').update(JSON.stringify([transport, executable, endpoint, codexHome ?? null])).digest('hex');
  }

  private async provision(intent: AutoLinkIntent): Promise<void> {
    if (this.provisioning.has(intent.id)) return;
    this.provisioning.add(intent.id);
    const client = this.codex;
    let persistedThreadId: string | undefined;
    const allowed = () => {
      const config = this.options.config();
      const rule = config.autoLinkRules?.find(rule => rule.id === intent.rule.id);
      const account = this.channels[intent.rule.platform]?.state;
      return !this.stopped && !this.suspended && config[intent.rule.platform].enabled && client === this.codex && account?.connected && account.accountId === intent.rule.accountId &&
        this.targetFingerprint() === intent.targetFingerprint && !!rule && JSON.stringify(rule) === JSON.stringify(intent.rule) && rule.enabled;
    };
    try {
      // A manual binding can resolve even a lost native create ACK, using its current ACL.
      if (this.store.bindingForEndpoint(intent.endpointId)) { this.store.finalizeAutoLinkIntent(intent.id); return; }
      if (intent.status !== 'pending' && intent.status !== 'created') return;
      if (!allowed() || !client.status().connected || !client.isVerifiedVersion()) {
        const error = !client.status().connected || !client.isVerifiedVersion()
          ? intent.status === 'pending' ? 'Ожидается подключённый проверенный Codex. Создание ещё не отправлялось.'
            : 'Тред уже создан. Ожидается подключённый проверенный Codex для продолжения.'
          : 'Правило или подключение изменились. Принятые события сохранены; проверьте автосоздание.';
        if (intent.error !== error) this.store.updateAutoLinkIntent(intent.id, { error });
        return;
      }
      let threadId = intent.threadId;
      if (intent.status === 'pending') {
        if (!this.store.claimAutoLinkIntent(intent.id)) return;
        threadId = await client.createThread(intent.rule.cwd);
        this.store.updateAutoLinkIntent(intent.id, { status: 'created', threadId, error: undefined });
      }
      if (!threadId) return;
      // A new native thread is lazy: metadata must materialize it before releasing its writer.
      await client.setThreadName(threadId, this.store.getEndpoint(intent.endpointId)!.title);
      persistedThreadId = threadId;
      if (allowed()) this.store.finalizeAutoLinkIntent(intent.id);
    } catch (error) {
      const current = this.store.getAutoLinkIntent(intent.id)!;
      // thread/start has no client idempotency key: never repeat an unknown result.
      this.store.updateAutoLinkIntent(intent.id, { status: current.threadId ? 'created' : error instanceof CodexRpcError ? 'failed' : 'uncertain', error: this.options.redact(error) });
    } finally {
      if (persistedThreadId) {
        try { await client.releaseThread(persistedThreadId); }
        catch (error) { this.emit('diagnostic', this.options.redact(error)); }
      }
      this.provisioning.delete(intent.id); this.changed();
    }
  }

  async settled(): Promise<void> { await this.events; await Promise.allSettled([...this.tasks]); }

  private async dispatch(conversationId: string): Promise<void> {
    this.dispatching.add(conversationId);
    let request: ReleRequest | undefined;
    let attempted = false;
    try {
      const conversation = this.store.getConversation(conversationId)!;
      const waiting = this.store.listPendingRequests().find(row => row.conversationId === conversationId);
      if (this.store.activeRequests().some(row => row.conversationId === conversationId && row.status !== 'queued')) return;
      const client = this.codex;
      const cutoff = waiting ? waiting.origin.platform === 'slack' ? waiting.origin.messageId
        : `${Math.floor(Date.parse(waiting.createdAt) / 1000)}.${String(Date.parse(waiting.createdAt) % 1000).padStart(3, '0')}000` : undefined;
      if (!await this.slackSync.drain(conversationId, cutoff)) {
        const error = this.store.listSlackSyncStreams().find(stream => stream.conversationId === conversationId &&
          (stream.active || this.store.hasPendingSlackSyncEntries(stream.id, cutoff)) && stream.error)?.error
          ?? 'Ожидается синхронизация полного контекста Slack. Запрос остаётся в очереди Rele.';
        const current = waiting && this.store.getRequest(waiting.id);
        if (current?.status === 'queued' && current.error !== error) this.store.updateRequest(current.id, { error });
        return;
      }
      if (!waiting || client !== this.codex || this.stopped || this.suspended) return;
      await client.subscribe(conversation.threadId);
      if (client !== this.codex) { await client.releaseThread(conversation.threadId); return; }
      this.ownedThreads.add(conversationId);
      if (!this.codex.status().queueSupported || this.stopped || this.suspended || this.store.getRequest(waiting.id)?.status !== 'queued') return;
      request = this.store.claimNextRequest(conversationId);
      if (!request) return;
      if (request.id !== waiting.id) { this.store.updateRequest(request.id, { status: 'queued' }); request = undefined; return; }
      this.retryThreadAfter.delete(conversationId);
      if (request.error) request = this.store.updateRequest(request.id, { error: undefined });
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
      if (error instanceof CodexThreadBusyError) {
        // Ownership failed before queue/add: the original request and origin stay durable.
        const waiting = request ?? this.store.listPendingRequests().find(row => row.conversationId === conversationId);
        if (waiting && !terminal(this.store.getRequest(waiting.id)!.status)) this.store.updateRequest(waiting.id, { status: 'queued', error: this.options.redact(error) });
        this.retryThreadAfter.set(conversationId, Date.now() + 5_000);
      } else if (request && !terminal(this.store.getRequest(request.id)!.status)) {
        if (attempted && !(error instanceof CodexRpcError)) this.store.updateRequest(request.id, { status: 'uncertain', error: this.options.redact(error) });
        else if (this.stopped) this.store.updateRequest(request.id, { status: 'queued' });
        else this.fail(request.id, this.options.redact(error));
      } else if (!request) {
        const waiting = this.store.listPendingRequests().find(row => row.conversationId === conversationId);
        if (waiting) this.store.updateRequest(waiting.id, { error: this.options.redact(error) });
        this.retryThreadAfter.set(conversationId, Date.now() + 5_000);
      }
    } finally {
      this.dispatching.delete(conversationId);
      await this.releaseIdleThread(conversationId);
      this.changed();
    }
  }

  /** Release only after reconciliation and an enqueue ACK have both settled. */
  private async releaseIdleThread(conversationId: string): Promise<void> {
    if (this.releasing.has(conversationId)) return this.releasing.get(conversationId);
    if (!this.ownedThreads.has(conversationId) || this.dispatching.has(conversationId)) return;
    if ([...this.reconciling].some(id => this.store.getRequest(id)?.conversationId === conversationId)) return;
    if (this.store.activeRequests().some(row => row.conversationId === conversationId && row.status !== 'queued')) return;
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) return;
    const client = this.codex;
    const release = client.releaseThread(conversation.threadId).then(() => {
      if (this.codex === client) this.ownedThreads.delete(conversationId);
    }).catch(error => {
      this.emit('diagnostic', this.options.redact(error));
    }).finally(() => { if (this.releasing.get(conversationId) === release) this.releasing.delete(conversationId); });
    this.releasing.set(conversationId, release);
    return release;
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
          this.emit('delivered', delivery);
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
            this.store.updateApproval(approval.id, { status: 'expired' }); this.store.cancelApprovalDeliveries(approval.id);
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
        this.store.cancelApprovalDeliveries(approval.id);
        if (request.status === 'waiting_approval') this.store.updateRequest(request.id, { status: 'running' });
      }
    }
    this.changed();
  }

  private async onServerRequest(event: CodexServerRequest): Promise<void> {
    const client = this.codex;
    const managed = client.status().transport === 'managed';
    const rejectUnowned = async () => { if (managed) await client.rejectRequest(event.id, 'Rele cannot authorize this request without its original message.'); };
    const reviewHint = managed ? 'Действие отклонено. Сверьте запрос в панели Rele.' : 'Продолжите в Codex.';
    const p = event.params as Record<string, any>;
    const request = this.store.activeRequests().find(row => row.turnId === p.turnId && this.store.getConversation(row.conversationId)?.threadId === p.threadId);
    // An external server may broadcast another client's request. In our own child,
    // an unowned request has no authorized handler and must receive an explicit error.
    if (!request || this.isMixed(request.id)) {
      await rejectUnowned();
      return;
    }
    // A foreign user message may have arrived before our own correlation event.
    // Verify history before publishing approval details outside the local runtime.
    let location: RequestLocation;
    try { location = await client.findRequest(p.threadId, request.id); }
    catch {
      if (client !== this.codex) return;
      if (!terminal(this.store.getRequest(request.id)!.status)) this.store.updateRequest(request.id, { status: 'uncertain', error: `Не удалось проверить происхождение подтверждения. ${reviewHint}` });
      await rejectUnowned();
      this.changed(); return;
    }
    if (client !== this.codex) return;
    if (terminal(this.store.getRequest(request.id)!.status)) { await rejectUnowned(); return; }
    if (location.mixed) {
      this.store.setMeta(`mixed:${request.id}`, '1');
      this.store.updateRequest(request.id, { status: 'uncertain', error: mixedMessage });
      await rejectUnowned();
      this.changed(); return;
    }
    if (location.state !== 'running' || location.turnId !== p.turnId) {
      this.store.updateRequest(request.id, { status: 'uncertain', error: `Подтверждение не совпало с активным ходом запроса. ${reviewHint}` });
      await rejectUnowned();
      this.changed(); return;
    }
    const question = event.method === 'item/tool/requestUserInput';
    const command = event.method === 'item/commandExecution/requestApproval';
    const files = event.method === 'item/fileChange/requestApproval';
    if (!question && !command && !files) {
      if (this.codex.status().transport === 'managed') {
        await this.codex.rejectRequest(event.id, 'This Codex interaction is not supported by Rele.');
        this.store.updateRequest(request.id, { error: 'Codex запросил действие, которое Rele пока не поддерживает. Действие отклонено; выполнение можно отменить в панели.' });
      } else this.store.updateRequest(request.id, { status: 'waiting_approval', error: 'Codex запросил действие, которое нужно подтвердить в самом Codex.' });
      this.changed(); return;
    }
    const questions: ApprovalQuestion[] | undefined = question && Array.isArray(p.questions) ? p.questions.map((entry: Record<string, any>) => ({ id: String(entry.id), header: String(entry.header ?? ''), question: String(entry.question ?? ''), isSecret: !!entry.isSecret, ...(Array.isArray(entry.options) ? { options: entry.options.map((option: Record<string, any>) => ({ label: String(option.label), description: String(option.description ?? '') })) } : {}) })) : undefined;
    const title = question ? 'Codex ждёт уточнения' : command ? 'Codex запрашивает выполнение команды' : 'Codex запрашивает изменение файлов';
    const metadata = [p.reason, p.command, p.cwd ? `Каталог: ${p.cwd}` : '', p.grantRoot ? `Доступ на запись: ${p.grantRoot}` : '', p.additionalPermissions ? JSON.stringify(p.additionalPermissions) : '', files ? this.fileChanges.get(String(p.itemId)) : ''].filter(Boolean).join('\n\n').slice(0, 16_000);
    const questionDetails = questions?.map((value, index) => `${questions.length > 1 ? `${index + 1}. ` : ''}${value.header}: ${value.question}${value.options?.length ? '\n' + value.options.map(option => `${option.label} — ${option.description}`).join('\n') : ''}`).join('\n\n');
    const details = [metadata, questionDetails].filter(Boolean).join('\n\n');
    const approval = this.store.addApproval({ requestId: request.id, turnId: p.turnId, itemId: `${p.itemId}:${p.approvalId ?? event.id}:${this.epoch}`, rpcId: event.id, method: event.method, title, details, questions });
    const choices: unknown[] | undefined = Array.isArray(p.availableDecisions) ? p.availableDecisions : undefined;
    this.approvals.set(approval.id, { accept: !choices || choices.includes('accept'), decline: choices?.includes('cancel') && !choices.includes('decline') ? 'cancel' : 'decline' });
    this.store.updateRequest(request.id, { status: 'waiting_approval' });
    const guidance = questions?.length && !questions.some(question => question.isSecret)
      ? questions.length === 1 ? '\n\nОтветьте на это сообщение.' : '\n\nОтветьте на это сообщение: по строке на каждый вопрос, по порядку — 1. ответ, затем с новой строки 2. ответ.'
      : questions?.length ? '\n\nСекретные ответы вводятся только в локальной панели Rele.' : '';
    // Nonsecret questions must be visible in full before the origin can answer them.
    const bodies = questions?.length && !questions.some(value => value.isSecret)
      ? splitReply(`${title}\n\n${details}${guidance}`, 3000)
      : [`${title}\n\n${details.slice(0, 2400)}${details.length > 2400 ? '\n… Полный запрос доступен в панели Rele.' : ''}${guidance}`];
    this.store.addDeliveries(request.id, bodies.map((body, ordinal) => ({ key: ordinal ? `approval:${approval.id}:${ordinal}` : `approval:${approval.id}`, ordinal, kind: 'approval' as const, body, approvalId: approval.id })));
    this.changed();
    this.track(this.deliver());
  }

  private finishFromHistory(request: ReleRequest, found: RequestLocation): void {
    if (found.mixed || this.isMixed(request.id)) { this.store.setMeta(`mixed:${request.id}`, '1'); this.store.finishRequest(request.id, { status: 'failed', turnId: found.turnId, error: mixedMessage }, []); return; }
    if (found.state === 'completed') {
      this.store.finishRequest(request.id, { status: 'completed', turnId: found.turnId, error: undefined }, (request.origin.platform === 'slack' ? splitSlackReply(found.text ?? '') : splitReply(found.text ?? '')).map((body, ordinal) => ({ key: `answer:${ordinal}`, ordinal, kind: 'answer' as const, body })));
    } else if (found.state === 'failed' || found.state === 'interrupted') {
      const error = found.state === 'interrupted' ? 'Выполнение запроса остановлено в Codex.' : 'Codex завершил запрос с ошибкой. Подробности доступны в Codex.';
      this.store.finishRequest(request.id, { status: found.state, turnId: found.turnId, error }, [{ key: 'terminal:error', ordinal: 0, kind: 'error', body: error }]);
    }
  }

  private fail(id: string, error: string): void { this.store.finishRequest(id, { status: 'failed', error }, [{ key: 'terminal:error', ordinal: 0, kind: 'error', body: error }]); }
  private isMixed(id: string): boolean { return this.store.getMeta(`mixed:${id}`) === '1'; }
  private sameOrigin(request: ReleRequest, message: InboundMessage): boolean { const origin = request.origin; return origin.platform === message.endpoint.platform && origin.accountId === message.endpoint.accountId && origin.chatId === message.endpoint.chatId && origin.threadId === message.endpoint.threadId && origin.senderId === message.sender.id; }
  private expireApprovals(): void {
    for (const approval of this.store.listApprovals(1000)) if (approval.status === 'pending') { this.store.updateApproval(approval.id, { status: 'expired' }); this.store.cancelApprovalDeliveries(approval.id); }
    this.approvals.clear();
  }
  private connectionChanged(): void {
    if (this.stopped) return;
    const connected = this.codex.status().connected;
    if (!connected && this.connected) {
      this.epoch = randomUUID(); this.expireApprovals();
      this.ownedThreads.clear(); this.retryThreadAfter.clear();
      for (const request of this.store.activeRequests()) if (['starting', 'running', 'waiting_approval'].includes(request.status)) this.store.updateRequest(request.id, { status: 'uncertain', error: 'Соединение с Codex прервано. Требуется сверка очереди и истории.' });
    }
    if (connected && !this.connected) for (const request of this.store.activeRequests()) if (!['queued', 'transcribing'].includes(request.status)) this.track(this.reconcile(request.id));
    this.connected = connected;
    this.changed();
  }
  private event(action: () => Promise<void>): void {
    const epoch = this.epoch;
    if (!this.stopped) this.events = this.events.then(() => {
      if (!this.stopped && this.epoch === epoch) return action();
    }).catch(error => { this.emit('diagnostic', this.options.redact(error)); });
  }
  private track<T>(task: Promise<T>): void { this.tasks.add(task); void task.catch(error => this.emit('diagnostic', this.options.redact(error))).finally(() => this.tasks.delete(task)); }
  private changed(): void { this.emit('change'); }
}
