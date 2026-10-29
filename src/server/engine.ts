import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Approval, ApprovalQuestion, AutoLinkIntent, Delivery, Endpoint, InboundMessage, MessageDestination, MessageToolCall, MessageToolReceipt, Person, Platform, ReleRequest } from '../shared/types.js';
import { CodexClient, CodexRpcError, CodexSteerRefusedError, CodexThreadBusyError, codexCommandItem, type CodexCommandItem, type CodexNotification, type CodexServerRequest, type CodexTerminal, type CodexTerminalSnapshot, type RequestLocation } from './codex.js';
import { Store, type SteeringInput } from './store.js';
import type { AppConfig } from './config.js';
import { ChannelError, splitReply, type ApprovalAction, type ApprovalContext, type ApprovalResolution, type Channel, type RequestProgress } from './channels/common.js';
import { transcribeAudio } from './voice.js';
import { SlackSync, quotedEntry } from './slack-sync.js';
import { InitialMessages } from './initial-message.js';
import { splitSlackReply } from './channels/slack-format.js';
import { effectiveSharedCodexHome } from './codex-shared.js';
import { requestInput } from './inbound-context.js';
import { MessageToolValidationError } from '../shared/message-tool.js';

export type CodexGateway = Pick<CodexClient, 'status' | 'isVerifiedVersion' | 'createThread' | 'setThreadName' | 'injectContext' | 'subscribe' | 'releaseThread' | 'enqueue' | 'steer' | 'findSteerReceipt' | 'interrupt' | 'backgroundTerminals' | 'terminateBackgroundTerminal' | 'findRequest' | 'retryOverloaded' | 'respond' | 'rejectRequest' | 'deleteQueued' | 'startQueued'> & Partial<Pick<CodexClient, 'hasPendingRequest'>> & Pick<EventEmitter, 'on' | 'off'>;
export interface EngineOptions {
  config: () => AppConfig;
  temporaryRoot: string;
  redact: (error: unknown) => string;
  transcribe?: typeof transcribeAudio;
}
const terminal = (status: ReleRequest['status']) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
const mixedMessage = 'В ход Rele добавлено сообщение из другого клиента Codex. Смешанный ответ не отправляется в мессенджер.';
const uncertainProgress = 'Проверяю состояние Codex';
const overloadDelays = [15, 30, 60, 120];
interface OverloadRetry { turnId: string; attempts: number; dueAt: number; sending?: boolean; target: string }
interface CancelCleanup {
  epoch: string; target: string; done: boolean; turnId?: string; interruptAttempted?: boolean; terminalAttempts?: CodexTerminal[];
}
interface TerminalBaseline extends CodexTerminalSnapshot { epoch: string; target: string }
function terminalPair(value: unknown): value is CodexTerminal {
  if (!value || typeof value !== 'object') return false;
  const entry = value as CodexTerminal;
  return typeof entry.processId === 'string' && !!codexCommandItem({ type: 'commandExecution', id: entry.itemId, processId: entry.processId });
}

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
  private startingQueued = new Map<string, Promise<void>>();
  private cancelling = new Map<string, Promise<void>>();
  private lastReconcile = 0;
  private suspended = false;
  private readonly slackSync: SlackSync;
  private readonly initialMessages: InitialMessages;
  private steering = new Set<string>();
  private progressSending = false;
  private progressRetryAfter = new Map<string, number>();
  private approvalUpdatesSending = false;
  private approvalUpdateRetry = new Map<string, number>();
  private pendingQuestions = new Map<string, { event: CodexServerRequest; epoch: string; retryAt: number }>();
  private retryingQuestions = false;
  private retryingOverloads = new Map<string, Promise<{ turnId: string } | undefined>>();
  private slackConnection?: string;
  private readonly notification = (event: CodexNotification) => this.event(() => this.onNotification(event));
  private readonly serverRequest = (event: CodexServerRequest) => this.event(() => this.onServerRequest(event));
  private readonly connection = () => this.connectionChanged();

  constructor(readonly store: Store, public codex: CodexGateway, private readonly options: EngineOptions) {
    super();
    this.slackSync = new SlackSync(store, platform => this.channels[platform ?? 'slack'], () => this.codex);
    this.initialMessages = new InitialMessages(store, () => this.codex, () => !this.stopped && !this.suspended);
    codex.on('notification', this.notification);
    codex.on('request', this.serverRequest);
    codex.on('status', this.connection);
  }

  suspend(value: boolean): void { this.suspended = value; }
  async maintainCodex<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped || this.suspended) throw new Error('Rele уже приостановлен или завершает работу.');
    this.suspended = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const busy = () => this.store.activeRequests().some(request => request.status !== 'queued')
      || this.resolutions.size > 0 || this.cancelling.size > 0 || this.startingQueued.size > 0 || this.retryingOverloads.size > 0
      || this.store.listConversations().some(conversation => this.initialMessages.hasPending(conversation.id));
    try {
      if (busy()) throw new Error('Сначала завершите активные запросы и начальные сообщения Rele.');
      await Promise.race([this.settled(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Операции Rele ещё завершаются. Повторите обновление позже.')), 15_000);
      })]);
      if (busy()) throw new Error('Сначала завершите активные запросы и начальные сообщения Rele.');
      return await operation();
    } finally {
      clearTimeout(timeout);
      this.suspended = false;
      this.changed();
      this.track(this.pump());
    }
  }
  sendInitialMessage(conversationId: string): { status: 'queued'; operationId: string } {
    if (this.stopped || this.suspended) throw new Error('Rele временно не принимает новые операции.');
    const result = this.initialMessages.queue(conversationId);
    this.changed(); this.track(this.pump());
    return result;
  }
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
    await Promise.allSettled([...this.cancelling.values()]);
  }

  async receive(message: InboundMessage): Promise<void> {
    if (this.stopped) throw new ChannelError('Rele завершает работу; событие будет доставлено повторно.', true);
    const controlText = message.endpoint.platform === 'slack'
      ? message.text.replaceAll(`<@${message.endpoint.accountId.split(':').at(-1)}>`, '').trim() : message.text.trim();
    if (message.control === 'stop' || !message.contextOnly && !message.audio && /^(?:rele:cancel|\/rele_cancel(?:@[A-Za-z0-9_]+)?)$/iu.test(controlText)) {
      if (this.suspended) throw new ChannelError('Rele временно приостановлен. Повторите управление запросом после обновления.', true);
      if (this.store.recordInbound(message).duplicate) return;
      const requests = this.store.activeRequests().filter(request => !request.steeredInto && this.sameOrigin(request, message)
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
        return !!request && this.sameOrigin(request, message)
          && this.store.approvalDeliveryProgress(candidate.id).sent;
      });
    if (approval && (message.endpoint.platform === 'telegram' || (message.text.trim() && !message.audio))) {
      if (this.suspended) throw new ChannelError('Rele временно приостановлен. Ответ на вопрос пока не принят.', true);
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
          await this.resolveApproval(approval.id, 'accept', Object.fromEntries(questions.map((question, index) => [question.id, [questions.length === 1 ? lines[index] : lines[index].slice(lines[index].indexOf(' ') + 1)]])),
            { source: message.endpoint.platform, senderId: message.sender.id, senderName: message.sender.name });
        }
      }
    } else {
      const config = this.options.config();
      const legacyRule = config.autoLinkRules?.find(rule => rule.enabled && rule.platform === message.endpoint.platform &&
        rule.accountId === message.endpoint.accountId && rule.chatId === message.endpoint.chatId);
      const rule = this.store.getEndpoint(message.endpoint.id) ? this.store.getSourceAutoRule(message.endpoint.id, legacyRule) : legacyRule;
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
    if (!request || !this.sameOrigin(request, { endpoint: { platform: action.platform, accountId: action.accountId, chatId: action.chatId,
      threadId: action.threadId ?? '' }, sender: { id: action.senderId, isBot: action.senderIsBot } })) throw new Error('Это подтверждение недоступно этому участнику источника.');
    if (approval?.method === 'mcpServer/elicitation/request' && action.decision === 'accept' && !this.store.approvalDeliveryProgress(approval.id).complete) {
      throw new Error('Дождитесь полной доставки запроса подтверждения.');
    }
    if (approval?.questions?.length) this.question(action);
    await this.resolveApproval(action.approvalId, action.decision, action.answers,
      { source: action.platform, senderId: action.senderId, ...(action.senderName ? { senderName: action.senderName } : {}) });
  }

  question(context: ApprovalContext): Approval {
    const approval = this.store.getApproval(context.approvalId);
    const request = approval && this.store.getRequest(approval.requestId);
    if (this.stopped || this.suspended || !approval || approval.status !== 'pending' || !request || terminal(request.status)
      || this.resolutions.has(approval.id) || !approval.questions?.length || approval.questions.some(question => question.isSecret)
      || this.store.getMeta(`approval-epoch:${approval.id}`) !== this.epoch
      || this.codex.hasPendingRequest?.(approval.rpcId) === false
      || this.isMixed(request.id) || approval.turnId !== request.turnId
      || !this.sameOrigin(request, { endpoint: { platform: context.platform, accountId: context.accountId,
        chatId: context.chatId, threadId: context.threadId ?? '' }, sender: { id: context.senderId, isBot: context.senderIsBot } })) {
      throw new Error('Этот вопрос закрыт или недоступен этому участнику.');
    }
    if (!this.codex.status().connected || !this.codex.status().queueSupported || !this.codex.isVerifiedVersion())
      throw new ChannelError('Codex временно недоступен. Повторите после подключения.', true);
    if (!this.store.approvalDeliveryProgress(approval.id).complete) throw new Error('Дождитесь полной доставки вопроса.');
    if (context.platform === 'slack' && (!context.messageId || this.store.findReplyApproval({ platform: context.platform,
      accountId: context.accountId, chatId: context.chatId, threadId: context.threadId ?? '' }, context.messageId)?.id !== approval.id))
      throw new Error('Исходное сообщение вопроса не подтверждено.');
    return approval;
  }

  async resolveApproval(id: string, decision: 'accept' | 'decline', answers?: Record<string, string[]>, resolution: ApprovalResolution = { source: 'rele' }): Promise<void> {
    if (this.suspended) throw new Error('Rele временно приостановлен. Повторите ответ после обновления.');
    const approval = this.store.getApproval(id);
    const request = approval && this.store.getRequest(approval.requestId);
    if (!approval || approval.status !== 'pending' || !request || terminal(request.status) || this.resolutions.has(id)
      || this.store.getMeta(`approval-epoch:${id}`) !== this.epoch
      || this.codex.hasPendingRequest?.(approval.rpcId) === false) throw new Error('Подтверждение уже завершено или недоступно.');
    if (!this.codex.status().connected) throw new ChannelError('Codex отключён. Дождитесь повторного подключения.', true);
    if (!this.codex.status().queueSupported) throw new Error('Подтверждения недоступны для непроверенного runtime Codex.');
    if (this.isMixed(request.id)) throw new Error('Ход изменён другим клиентом. Продолжите подтверждение в Codex.');
    let result: unknown;
    if (approval.method === 'item/tool/requestUserInput') {
      const values: Record<string, { answers: string[] }> = Object.create(null);
      for (const question of approval.questions ?? []) {
        const answer = answers?.[question.id];
        if (decision === 'accept' && (!Array.isArray(answer) || !answer.length || answer.some(text => typeof text !== 'string' || !text.trim() || text.length > 10_000))) throw new Error('Ответьте на каждый вопрос.');
        values[question.id] = { answers: decision === 'accept' ? answer! : [] };
      }
      result = { answers: values };
    } else {
      const capability = this.approvals.get(id);
      if (!capability || (decision === 'accept' && !capability.accept)) throw new Error('Это подтверждение нужно выполнить в Codex.');
      result = approval.method === 'mcpServer/elicitation/request'
        ? { action: decision, content: decision === 'accept' ? {} : null, _meta: null }
        : { decision: decision === 'accept' ? 'accept' : capability.decline };
    }
    this.resolutions.add(id);
    if (approval.questions?.length) this.store.setMeta(`approval-resolution:${id}`, JSON.stringify({ source: resolution.source,
      ...(resolution.senderId ? { senderId: resolution.senderId } : {}), ...(resolution.senderName ? { senderName: resolution.senderName } : {}),
      ...(decision === 'accept' && !approval.questions.some(question => question.isSecret) ? { answers } : {}) }));
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
    if (this.suspended) throw new Error('Rele временно приостановлен. Повторите отмену после обновления.');
    const pending = this.cancelling.get(id);
    if (pending) return pending;
    const request = this.store.getRequest(id);
    if (!request || terminal(request.status)) throw new Error('Запрос уже завершён.');
    if (request.steeredInto) throw new Error('Дополнение относится к уже выполняющемуся запросу. Остановить можно исходный запрос.');
    // A lost cancellation ACK must never let reconciliation restart the original request.
    this.store.setMeta(`cancel-requested:${id}`, '1');
    if (this.retryingOverloads.has(id)) {
      await this.retryingOverloads.get(id)!.catch(() => {});
      return this.cancel(id);
    }
    const retryRaw = this.store.getMeta(`overload-retry:${id}`);
    if (retryRaw && (JSON.parse(retryRaw) as OverloadRetry).sending) {
      const found = await this.findOwnRequest(this.codex, this.store.getConversation(request.conversationId)!.threadId, id);
      if (found.turnId === (JSON.parse(retryRaw) as OverloadRetry).turnId || found.state === 'not_found') {
        this.store.updateRequest(id, { status: 'uncertain', error: 'Отмена сохранена. Ожидается подтверждение запуска повтора в Codex.' });
        return;
      }
    }
    if (request.status === 'queued' || request.status === 'transcribing'
      || request.status === 'starting' && this.dispatching.has(request.conversationId) && !this.store.getMeta(`request-terminal-baseline:${id}`)) {
      this.store.finishRequest(id, { status: 'cancelled', error: undefined }, []);
      await this.releaseIdleThread(request.conversationId);
      this.changed(); return;
    }
    const state = this.cancelCleanup(id) ?? { epoch: this.epoch, target: this.targetFingerprint(), done: false };
    this.store.setMeta(`cancel-cleanup:${id}`, JSON.stringify(state));
    const operation = this.cancelAccepted(request, state).catch(error => {
      if (!terminal(this.store.getRequest(id)!.status)) this.store.updateRequest(id, { status: 'uncertain', error: this.options.redact(error) });
      throw error;
    }).finally(async () => {
      if (this.cancelling.get(id) === operation) this.cancelling.delete(id);
      await this.releaseIdleThread(request.conversationId);
      this.changed();
    });
    this.cancelling.set(id, operation);
    return operation;
  }

  private async cancelAccepted(request: ReleRequest, state: CancelCleanup): Promise<void> {
    const id = request.id;
    const client = this.codex, epoch = this.epoch;
    const current = () => {
      if (this.stopped || client !== this.codex || epoch !== this.epoch || state.epoch !== epoch || state.target !== this.targetFingerprint()) {
        throw new Error('Исходное соединение отмены потеряно. Завершение фоновых команд не подтверждено; требуется сверка.');
      }
    };
    current();
    const conversation = this.store.getConversation(request.conversationId)!;
    let found = await this.findOwnRequest(client, conversation.threadId, request.id);
    current();
    if (found.mixed || this.isMixed(request.id)) throw new Error('В ход добавлено сообщение другого клиента Codex. Автоматическая отмена смешанного хода недоступна.');
    if (found.state === 'queued' && found.queuedSubmissionId) {
      const removed = await client.deleteQueued(conversation.threadId, found.queuedSubmissionId);
      if (client !== this.codex || epoch !== this.epoch) throw new Error('Соединение Codex изменилось. Сверьте отмену запроса.');
      if (removed.deleted) {
        state.done = true; this.store.setMeta(`cancel-cleanup:${id}`, JSON.stringify(state));
        this.store.finishRequest(id, { status: 'cancelled' }, []);
        await this.releaseIdleThread(request.conversationId);
        this.changed(); return;
      }
      found = await this.findOwnRequest(client, conversation.threadId, request.id);
      if (['queued', 'not_found'].includes(found.state) && this.startingQueued.has(id)) {
        await this.startingQueued.get(id)!.catch(() => {});
        found = await this.findOwnRequest(client, conversation.threadId, request.id);
      }
    }
    if (client !== this.codex || epoch !== this.epoch) throw new Error('Соединение Codex изменилось. Сверьте отмену запроса.');
    if (found.mixed || this.isMixed(request.id)) throw new Error('В ход добавлено сообщение другого клиента Codex. Автоматическая отмена смешанного хода недоступна.');
    if (!found.turnId || ['queued', 'not_found'].includes(found.state)) throw new Error('Codex пока не подтвердил состояние запроса. Отмена без сверки недоступна.');
    if (state.turnId && state.turnId !== found.turnId) throw new Error('Ход отменяемого запроса изменился. Требуется сверка.');
    state.turnId = found.turnId;
    this.store.updateRequest(id, { status: 'uncertain', turnId: found.turnId, error: 'Проверяется остановка запроса и его фоновых команд.' });
    this.rememberCommandItems(id, found.commandItems ?? []);
    if (found.state === 'running' && !state.interruptAttempted) {
      state.interruptAttempted = true; this.store.setMeta(`cancel-cleanup:${id}`, JSON.stringify(state));
      try { await client.interrupt(conversation.threadId, found.turnId); }
      catch (error) { current(); this.emit('diagnostic', this.options.redact(error)); }
    }
    this.store.setMeta(`cancel-cleanup:${id}`, JSON.stringify(state));
    const rawBaseline = this.store.getMeta(`request-terminal-baseline:${id}`);
    const baseline = rawBaseline ? JSON.parse(rawBaseline) as TerminalBaseline : undefined;
    const attempted = new Set<string>(), deadline = performance.now() + 2000;
    do {
      current();
      found = await this.findOwnRequest(client, conversation.threadId, id);
      current();
      if (found.mixed || this.isMixed(id) || found.turnId !== state.turnId) throw new Error('Ход отменяемого запроса больше не подтверждён как собственный. Фоновые команды сохранены.');
      const items = this.rememberCommandItems(id, found.commandItems ?? []);
      if (['completed', 'failed', 'interrupted'].includes(found.state)) {
        const snapshot = await client.backgroundTerminals(conversation.threadId);
        current();
        if (!baseline || baseline.epoch !== epoch || baseline.target !== state.target || baseline.serverId !== snapshot.serverId
          || !Array.isArray(baseline.terminals) || baseline.terminals.some(entry => !terminalPair(entry))) {
          throw new Error('Исходный сервер или снимок команд не подтверждён. Отсутствие терминалов не доказывает завершение прежних процессов.');
        }
        const fresh = snapshot.terminals.filter(entry => !baseline.terminals.some(old => old.itemId === entry.itemId && old.processId === entry.processId));
        for (const entry of fresh) {
          const commands = items.filter(item => item.id === entry.itemId);
          if (!commands.length || commands.some(item => item.processId !== null && item.processId !== entry.processId)
            || snapshot.terminals.filter(other => other.itemId === entry.itemId).length !== 1 || attempted.has(JSON.stringify(entry))) continue;
          const location = await this.findOwnRequest(client, conversation.threadId, id);
          current();
          if (location.mixed || this.isMixed(id) || location.turnId !== state.turnId) throw new Error('Привязка команды к исходному ходу изменилась. Завершение не отправлено.');
          const verified = this.rememberCommandItems(id, location.commandItems ?? []);
          if (verified.some(item => item.id === entry.itemId && item.processId !== null && item.processId !== entry.processId)) {
            throw new Error('Canonical process ID команды изменился. Завершение не отправлено.');
          }
          state.terminalAttempts = [...(state.terminalAttempts ?? []), entry]; this.store.setMeta(`cancel-cleanup:${id}`, JSON.stringify(state));
          attempted.add(JSON.stringify(entry));
          await client.terminateBackgroundTerminal(conversation.threadId, { ...entry, serverId: snapshot.serverId });
          current();
        }
        const after = await client.backgroundTerminals(conversation.threadId);
        current();
        if (after.serverId !== baseline.serverId) throw new Error('Сервер Codex изменился во время отмены. Завершение прежних процессов не подтверждено.');
        const latestItems = this.rememberCommandItems(id, []);
        const pendingStarts = latestItems.some(item => !latestItems.some(other => other.id === item.id && other.completed)
          && !state.terminalAttempts?.some(attempt => attempt.itemId === item.id));
        if (!pendingStarts && !after.terminals.some(entry => !baseline.terminals.some(old => old.itemId === entry.itemId && old.processId === entry.processId))) {
          state.done = true; this.store.setMeta(`cancel-cleanup:${id}`, JSON.stringify(state));
          this.finishFromHistory(request, found); return;
        }
      }
      if (performance.now() >= deadline) break;
      await delay(100);
    } while (performance.now() < deadline);
    throw new Error('Остановка модели или привязка её фоновых команд пока не подтверждены. Запрос удерживается до сверки.');
  }

  private cancelCleanup(id: string): CancelCleanup | undefined {
    const raw = this.store.getMeta(`cancel-cleanup:${id}`);
    if (!raw) return;
    const state = JSON.parse(raw) as CancelCleanup;
    if (!state || typeof state.epoch !== 'string' || typeof state.target !== 'string' || typeof state.done !== 'boolean'
      || state.turnId !== undefined && typeof state.turnId !== 'string'
      || state.interruptAttempted !== undefined && typeof state.interruptAttempted !== 'boolean'
      || state.terminalAttempts !== undefined && (!Array.isArray(state.terminalAttempts) || state.terminalAttempts.some(entry => !terminalPair(entry)))) throw new Error('Журнал отмены требует проверки.');
    return state;
  }

  private rememberCommandItems(id: string, additional: CodexCommandItem[]): CodexCommandItem[] {
    const raw = JSON.parse(this.store.getMeta(`request-command-items:${id}`) ?? '[]') as CodexCommandItem[];
    if (!Array.isArray(raw) || raw.some(item => !codexCommandItem({ ...item, type: 'commandExecution' })
      || item.completed !== undefined && item.completed !== true)) throw new Error('Журнал команд отменяемого запроса требует проверки.');
    const items = [...new Map([...raw, ...additional].map(item => [JSON.stringify(item), item])).values()];
    if (additional.length) this.store.setMeta(`request-command-items:${id}`, JSON.stringify(items));
    return items;
  }

  async resume(id: string): Promise<void> {
    if (this.suspended) throw new Error('Rele временно приостановлен. Повторите продолжение после обновления.');
    const request = this.store.getRequest(id);
    if (!request || terminal(request.status)) throw new Error('Запрос уже завершён.');
    const conversation = this.store.getConversation(request.conversationId)!;
    const client = this.codex, epoch = this.epoch;
    const found = await this.findOwnRequest(client, conversation.threadId, id);
    if (client !== this.codex || epoch !== this.epoch) throw new Error('Соединение Codex изменилось. Сверьте запрос перед продолжением.');
    if (found.state !== 'queued' || !found.queuedSubmissionId) throw new Error('Запрос не находится в очереди Codex.');
    await this.continueQueued(request, found, false);
    await this.reconcile(id);
  }

  private continueQueued(request: ReleRequest, found: RequestLocation, automatic: boolean): Promise<void> {
    const pending = this.startingQueued.get(request.id);
    if (pending) return pending;
    const client = this.codex, epoch = this.epoch;
    const operation = (async () => {
      const current = this.store.getRequest(request.id)!;
      if (terminal(current.status)) return;
      if (this.suspended) {
        if (automatic) return;
        throw new Error('Rele временно приостановлен. Повторите продолжение после обновления.');
      }
      if (current.turnId || this.isMixed(current.id) || this.store.getMeta(`cancel-requested:${current.id}`)) {
        throw new Error('Этот запрос нельзя продолжить; сверьте его состояние и отмену.');
      }
      const key = `queue-start-attempt:${current.id}`;
      if (this.store.getMeta(key)) throw new Error('Результат прежнего запуска очереди ещё не подтверждён. Требуется сверка без повторного запуска.');
      if (automatic && (!found.soleQueuedSubmission || this.stopped || this.suspended || this.waitsForSource(current)
        || this.store.getConversation(current.conversationId)?.paused || !client.status().connected
        || !client.status().queueSupported || !client.isVerifiedVersion())) return;
      if (!found.queuedSubmissionId) throw new Error('Элемент очереди Codex не подтверждён.');
      // Starting a queued item is a separate mutation; persist its fence before the wire write.
      this.store.setMeta(key, found.queuedSubmissionId);
      try {
        await client.startQueued(this.store.getConversation(current.conversationId)!.threadId, found.queuedSubmissionId);
        if (client !== this.codex || epoch !== this.epoch) throw new Error('Соединение изменилось во время запуска очереди. Требуется сверка.');
      } catch (error) {
        if (error instanceof CodexThreadBusyError) this.store.setMeta(key, '');
        throw error;
      }
    })().finally(() => { if (this.startingQueued.get(request.id) === operation) this.startingQueued.delete(request.id); });
    this.startingQueued.set(request.id, operation);
    return operation;
  }

  retryDelivery(id: string): void {
    const delivery = this.store.getDelivery(id);
    if (!delivery || delivery.status !== 'failed') throw new Error('Повтор допустим только для доставки с подтверждённым отказом. Неопределённую доставку сначала проверьте в мессенджере.');
    this.store.updateDelivery(id, { status: 'pending', error: undefined, nextAttemptAt: undefined });
    this.track(this.deliver());
    this.changed();
  }

  async reconcile(id: string): Promise<void> {
    // Do not block the notification queue behind cleanup; later canonical command items must flow.
    if (this.cancelling.has(id)) return;
    if (this.reconciling.has(id)) { this.reconcileAgain.add(id); return; }
    const request = this.store.getRequest(id);
    if (!request || terminal(request.status) || ['queued', 'transcribing'].includes(request.status)) return;
    if (request.steeredInto) {
      const input = this.store.getSteeringInput(id);
      if (input) await this.reconcileSteering(input);
      return;
    }
    this.reconciling.add(id);
    const client = this.codex, epoch = this.epoch;
    try {
      const conversation = this.store.getConversation(request.conversationId)!;
      const cleanup = this.cancelCleanup(id);
      if (cleanup && !cleanup.done && (cleanup.epoch !== epoch || cleanup.target !== this.targetFingerprint())) {
        this.store.updateRequest(id, { status: 'uncertain', error: 'Исходное соединение отмены потеряно. Завершение прежних процессов требует сверки.' });
        return;
      }
      await this.releasing.get(conversation.id);
      await client.subscribe(conversation.threadId);
      if (client !== this.codex || epoch !== this.epoch) return;
      this.ownedThreads.add(conversation.id);
      if (cleanup && !cleanup.done) {
        if (cleanup.turnId) this.track(this.cancel(id));
        else this.store.updateRequest(id, { status: 'uncertain', error: 'Результат отмены не подтверждён. Повторный запуск запроса запрещён.' });
        return;
      }
      const found = await this.findOwnRequest(client, conversation.threadId, id);
      if (client !== this.codex || epoch !== this.epoch || terminal(this.store.getRequest(id)!.status)) return;
      if (found.mixed) this.store.setMeta(`mixed:${id}`, '1');
      else if (found.commentary?.length && !this.isMixed(id)) this.recordProgress(id, { steps: found.commentary }, true);
      if (found.state === 'not_found') this.store.updateRequest(id, { status: 'uncertain', error: 'Запрос не найден в очереди и истории Codex. Автоматическая повторная отправка запрещена; требуется сверка.' });
      else if (found.state === 'queued') {
        this.store.updateRequest(id, { status: 'starting', queuedSubmissionId: found.queuedSubmissionId, error: undefined });
        await this.continueQueued(request, found, true);
      }
      else if (found.state === 'running') {
        if (this.store.getMeta(`cancel-requested:${id}`)) { this.track(this.cancel(id)); return; }
        const pending = this.store.listApprovals(1000).some(approval => approval.requestId === id && approval.status === 'pending');
        this.store.updateRequest(id, { status: this.isMixed(id) ? 'uncertain' : pending ? 'waiting_approval' : 'running', turnId: found.turnId, error: this.isMixed(id) ? mixedMessage : undefined });
      } else if (!await this.retryOverload(request, found)) this.finishFromHistory(request, found);
    } catch (error) {
      if (client === this.codex && epoch === this.epoch && !terminal(this.store.getRequest(id)!.status)) {
        this.store.updateRequest(id, { status: error instanceof CodexThreadBusyError && this.store.getRequest(id)?.queuedSubmissionId ? 'starting' : 'uncertain', error: this.options.redact(error) });
      }
    } finally {
      const current = this.store.getRequest(id), progress = this.store.getMeta(`request-progress:${id}`);
      if (current && !terminal(current.status) && progress && !this.isMixed(id)) {
        if (current.status === 'uncertain') this.recordProgress(id, { statusText: uncertainProgress });
        else if (JSON.parse(progress).statusText === uncertainProgress) this.recordProgress(id, { statusText: undefined });
      }
      this.reconciling.delete(id);
      if (this.reconcileAgain.delete(id) && !this.stopped) this.track(this.reconcile(id));
      await this.releaseIdleThread(request.conversationId);
      this.changed();
    }
  }

  /** Exposed to deterministic integration tests; the timer uses this same path. */
  async pump(): Promise<void> {
    if (this.stopped) return;
    const work: Promise<unknown>[] = [this.deliver(), this.flushProgress(), this.flushApprovalUpdates(), this.retryPendingQuestions()];
    if (!this.suspended) {
      await Promise.allSettled(this.store.listAutoLinkIntents().filter(intent => intent.status !== 'completed').map(intent => this.provision(intent)));
      await this.slackSync.backfill();
    }
    if (this.stopped) { await Promise.allSettled(work); return; }
    if (this.codex.status().connected) {
      const periodic = Date.now() - this.lastReconcile > 15_000;
      if (periodic) this.lastReconcile = Date.now();
      for (const request of this.store.activeRequests()) {
        const raw = this.store.getMeta(`overload-retry:${request.id}`), retry = raw ? JSON.parse(raw) as OverloadRetry : undefined;
        if ((periodic || retry && !retry.sending && retry.dueAt <= Date.now()) && !['queued', 'transcribing'].includes(request.status)
          && !this.dispatching.has(request.conversationId)) work.push(this.reconcile(request.id));
      }
    }
    if (!this.suspended && this.codex.status().connected) for (const conversation of this.store.listConversations()) {
      if (!conversation.paused && !this.dispatching.has(conversation.id) && !this.releasing.has(conversation.id)
          && Date.now() >= (this.retryThreadAfter.get(conversation.id) ?? 0)) work.push(this.dispatch(conversation.id));
    }
    await Promise.allSettled(work);
  }

  targetFingerprint(): string {
    const { transport, executable, endpoint, codexHome } = this.options.config().codex;
    let home = codexHome ?? null;
    if (transport === 'shared' && !codexHome) {
      home = effectiveSharedCodexHome();
      if (process.platform === 'win32') home = home.toLowerCase();
    }
    return createHash('sha256').update(JSON.stringify([transport, executable, endpoint, home])).digest('hex');
  }

  private currentAutoRule(endpointId: string): AutoLinkIntent['rule'] | undefined {
    const endpoint = this.store.getEndpoint(endpointId);
    if (!endpoint) return undefined;
    const legacy = this.options.config().autoLinkRules?.find(rule => rule.enabled && rule.platform === endpoint.platform &&
      rule.accountId === endpoint.accountId && rule.chatId === endpoint.chatId);
    return this.store.getSourceAutoRule(endpointId, legacy);
  }

  private async provision(intent: AutoLinkIntent): Promise<void> {
    if (this.provisioning.has(intent.id)) return;
    this.provisioning.add(intent.id);
    const client = this.codex;
    let releasableThreadId: string | undefined;
    const sameTarget = () => {
      const config = this.options.config();
      const account = this.channels[intent.rule.platform]?.state;
      return !this.stopped && !this.suspended && config[intent.rule.platform].enabled && client === this.codex && account?.connected && account.accountId === intent.rule.accountId &&
        this.targetFingerprint() === intent.targetFingerprint && client.status().connected && client.isVerifiedVersion();
    };
    const allowed = () => {
      const rule = this.currentAutoRule(intent.endpointId);
      return sameTarget() && !!rule && JSON.stringify(rule) === JSON.stringify(intent.rule) && rule.enabled;
    };
    try {
      // A manual binding can resolve even a lost native create ACK, using its current ACL.
      const manual = this.store.bindingForEndpoint(intent.endpointId);
      if (manual) {
        if (!sameTarget()) {
          const error = 'Подключение автосоздания изменилось или недоступно. Принятые события сохранены; восстановите исходное подключение.';
          if (intent.error !== error) this.store.updateAutoLinkIntent(intent.id, { error });
          return;
        }
        // A manually chosen target abandons the unused auto-created thread, even if still lazy.
        if (intent.threadId && intent.threadId !== this.store.getConversation(manual.conversationId)!.threadId) releasableThreadId = intent.threadId;
        this.store.finalizeAutoLinkIntent(intent.id); return;
      }
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
      releasableThreadId = threadId;
      if (allowed()) this.store.finalizeAutoLinkIntent(intent.id);
    } catch (error) {
      const current = this.store.getAutoLinkIntent(intent.id)!;
      // thread/start has no client idempotency key: never repeat an unknown result.
      this.store.updateAutoLinkIntent(intent.id, { status: current.threadId ? 'created' : error instanceof CodexRpcError ? 'failed' : 'uncertain', error: this.options.redact(error) });
    } finally {
      if (releasableThreadId) {
        try { await client.releaseThread(releasableThreadId); }
        catch (error) { this.emit('diagnostic', this.options.redact(error)); }
      }
      this.provisioning.delete(intent.id); this.changed();
    }
  }

  async settled(): Promise<void> { await this.events; await Promise.allSettled([...this.tasks]); }

  private waitsForSource(request: ReleRequest): boolean {
    return request.origin.platform === 'slack' && this.store.getSourceAccess(request.origin.endpointId).mode === 'off';
  }

  private findOwnRequest(client: CodexGateway, threadId: string, requestId: string): Promise<RequestLocation> {
    const inputs = this.ownInputIds(requestId);
    return client.findRequest(threadId, requestId, inputs, true);
  }

  private ownInputIds(requestId: string): string[] {
    return [requestId, ...this.store.steeringInputs(requestId)
      .filter(input => input.state !== 'refused').map(input => input.id)];
  }

  private async reconcileSteering(input: SteeringInput): Promise<void> {
    if (input.state === 'applied' || input.state === 'refused') return;
    const parent = this.store.getRequest(input.parentRequestId);
    const conversation = parent && this.store.getConversation(parent.conversationId);
    const client = this.codex, epoch = this.epoch;
    if (!conversation || this.store.getMeta(`steer-target:${input.id}`) !== this.targetFingerprint() || !client.status().connected) return;
    try {
      const found = await client.findSteerReceipt(conversation.threadId, input.id, input.turnId, this.ownInputIds(parent!.id));
      if (client !== this.codex || epoch !== this.epoch) return;
      if (found.turnId === input.turnId && found.state !== 'not_found') {
        this.store.finishSteeringInput(input.id, 'applied');
        if (found.mixed) this.store.setMeta(`mixed:${parent!.id}`, '1');
        this.track(this.reconcile(parent!.id));
      } else {
        this.store.finishSteeringInput(input.id, 'uncertain', 'Добавление сообщения пока не подтверждено в истории Codex. Повторная отправка запрещена.');
        if (found.mixed) this.store.setMeta(`mixed:${parent!.id}`, '1');
      }
    } catch (error) {
      if (client === this.codex && epoch === this.epoch && this.store.getSteeringInput(input.id)?.state !== 'applied') {
        this.store.finishSteeringInput(input.id, 'uncertain', this.options.redact(error));
      }
    }
    this.changed();
  }

  private async steerPending(parent: ReleRequest): Promise<void> {
    const conversation = this.store.getConversation(parent.conversationId)!;
    const client = this.codex, epoch = this.epoch;
    if (this.steering.has(parent.id) || parent.status !== 'running' || !parent.turnId || this.isMixed(parent.id)
      || this.store.getMeta(`cancel-requested:${parent.id}`) || !client.isVerifiedVersion() || !client.status().queueSupported
      || this.store.getSourceAccess(parent.origin.endpointId).mode === 'off'
      || this.store.listApprovals(1000).some(approval => approval.requestId === parent.id && approval.status === 'pending')) return;
    this.steering.add(parent.id);
    try {
      for (const input of this.store.steeringInputs(parent.id)) if (input.state === 'sending' || input.state === 'uncertain') await this.reconcileSteering(input);
      if (this.store.steeringInputs(parent.id).some(input => input.state === 'sending' || input.state === 'uncertain')) return;
      const stream = this.store.listSlackSyncStreams().find(row => row.conversationId === conversation.id && row.endpointId === parent.origin.endpointId && row.active && !row.paused);
      const channel = this.channels[parent.origin.platform];
      const self = channel && this.ownIdentity(channel, parent.origin.platform).id;
      const entry = stream && this.store.listSlackSyncEntries(stream.id, { pending: true, limit: 100 }).find(row => {
        if (row.state !== 'pending' || row.message.sender.id === self || this.store.getSteeringInput(row.id)) return false;
        const request = row.requestId && this.store.getRequest(row.requestId);
        return !request || request.status === 'queued' && !request.audio && !this.store.getSteeringInput(request.id);
      });
      const candidate = entry?.requestId ? this.store.getRequest(entry.requestId)
        : entry ? undefined : this.store.listPendingRequests().find(row => row.conversationId === parent.conversationId && !row.audio && !this.store.getSteeringInput(row.id) && this.sameSource(parent, { endpoint: row.origin }));
      if (!entry && !candidate) return;
      const found = await this.findOwnRequest(client, conversation.threadId, parent.id);
      const current = this.store.getRequest(parent.id);
      if (client !== this.codex || epoch !== this.epoch || this.stopped || this.suspended || current?.status !== 'running'
        || current.turnId !== parent.turnId || this.store.getMeta(`cancel-requested:${parent.id}`) || conversation.paused
        || this.store.getSourceAccess(parent.origin.endpointId).mode === 'off'
        || this.store.listApprovals(1000).some(approval => approval.requestId === parent.id && approval.status === 'pending')) return;
      if (found.state !== 'running' || found.turnId !== parent.turnId || found.mixed) {
        if (found.mixed) this.store.setMeta(`mixed:${parent.id}`, '1');
        this.track(this.reconcile(parent.id)); return;
      }
      const id = candidate?.id ?? entry!.id;
      this.store.setMeta(`steer-target:${id}`, this.targetFingerprint());
      const input = this.store.beginSteeringInput(parent.id, { id, ...(candidate ? { requestId: candidate.id } : {}),
        ...(entry ? { entryId: entry.id } : {}), text: candidate ? requestInput(candidate) : quotedEntry(entry!) });
      if (input.state !== 'sending') return;
      try {
        await client.steer(conversation.threadId, input.text, input.id, input.turnId);
        if (client !== this.codex || epoch !== this.epoch) throw new Error('Подключение изменилось во время дополнения запроса.');
        await this.reconcileSteering(input);
      } catch (error) {
        if (this.store.getSteeringInput(input.id)?.state !== 'applied') {
          this.store.finishSteeringInput(input.id, error instanceof CodexSteerRefusedError ? 'refused' : 'uncertain', this.options.redact(error));
        }
      }
      this.track(this.reconcile(parent.id));
    } catch (error) { this.emit('diagnostic', this.options.redact(error)); }
    finally { this.steering.delete(parent.id); this.changed(); }
  }

  private async dispatch(conversationId: string): Promise<void> {
    this.dispatching.add(conversationId);
    let request: ReleRequest | undefined;
    let waiting: ReleRequest | undefined;
    let attempted = false;
    try {
      const conversation = this.store.getConversation(conversationId)!;
      const queued = this.store.listPendingRequests().filter(row => row.conversationId === conversationId);
      const blockedReason = 'Источник выключен. Включите его для проверки полного контекста или отмените принятый запрос.';
      for (const row of queued) if (this.waitsForSource(row) && row.error !== blockedReason) this.store.updateRequest(row.id, { error: blockedReason });
      waiting = queued.find(row => !this.waitsForSource(row));
      const active = this.store.activeRequests().find(row => row.conversationId === conversationId && row.status !== 'queued' && !row.steeredInto);
      if (active) { await this.steerPending(active); return; }
      if (this.store.listAutoLinkIntents().some(intent => intent.status !== 'completed' && this.store.bindingForEndpoint(intent.endpointId)?.conversationId === conversationId)) return;
      const hasContext = this.store.listSlackSyncStreams().some(stream => stream.conversationId === conversationId && stream.active && !stream.paused
        && this.store.hasPendingSlackSyncEntries(stream.id));
      if (!waiting && !hasContext && !this.initialMessages.hasPending(conversationId)) return;
      if (!await this.initialMessages.ensure(conversationId)) return;
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
      if (!this.codex.status().queueSupported || this.stopped || this.suspended || this.store.getRequest(waiting.id)?.status !== 'queued' || this.waitsForSource(waiting)) return;
      request = this.store.claimNextRequest(conversationId, waiting.id);
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
      const epoch = this.epoch;
      let baseline: CodexTerminalSnapshot;
      try { baseline = await client.backgroundTerminals(conversation.threadId); }
      catch (error) {
        if (!terminal(this.store.getRequest(request.id)!.status) && !this.store.getMeta(`cancel-requested:${request.id}`)) {
          this.store.updateRequest(request.id, { status: 'queued', error: this.options.redact(error) });
        }
        this.retryThreadAfter.set(conversationId, Date.now() + 5000);
        return;
      }
      if (client !== this.codex || epoch !== this.epoch || this.stopped || this.suspended || this.store.getMeta(`cancel-requested:${request.id}`)
        || terminal(this.store.getRequest(request.id)!.status)) {
        if (!terminal(this.store.getRequest(request.id)!.status) && !this.store.getMeta(`cancel-requested:${request.id}`)) this.store.updateRequest(request.id, { status: 'queued' });
        return;
      }
      this.store.setMeta(`request-terminal-baseline:${request.id}`, JSON.stringify({ ...baseline, epoch, target: this.targetFingerprint() } satisfies TerminalBaseline));
      attempted = true;
      const result = await client.enqueue(conversation.threadId, requestInput(request), request.id);
      // The userMessage and completion notifications may arrive before this ACK.
      this.store.updateRequest(request.id, { queuedSubmissionId: result.queuedSubmissionId });
      this.track(this.reconcile(request.id));
    } catch (error) {
      if (error instanceof CodexThreadBusyError) {
        // Ownership failed before queue/add: the original request and origin stay durable.
        const current = request ?? waiting;
        if (current && !terminal(this.store.getRequest(current.id)!.status)) this.store.updateRequest(current.id, { status: 'queued', error: this.options.redact(error) });
        this.retryThreadAfter.set(conversationId, Date.now() + 5_000);
      } else if (request && !terminal(this.store.getRequest(request.id)!.status)) {
        if (attempted && !(error instanceof CodexRpcError)) this.store.updateRequest(request.id, { status: 'uncertain', error: this.options.redact(error) });
        else if (this.stopped) this.store.updateRequest(request.id, { status: 'queued' });
        else this.fail(request.id, this.options.redact(error));
      } else if (!request) {
        if (waiting && this.store.getRequest(waiting.id)?.status === 'queued') this.store.updateRequest(waiting.id, { error: this.options.redact(error) });
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

  private toolDestinations(threadId: string, requireConnected = true): Array<MessageDestination & { conversationId: string; endpoint: Endpoint; channel: Channel }> {
    const conversation = this.store.listConversations().find(row => row.threadId === threadId);
    if (!conversation || conversation.paused) return [];
    return conversation.bindings.flatMap(binding => {
      const endpoint = this.store.getEndpoint(binding.endpointId), channel = this.channels[binding.platform];
      if (!endpoint || endpoint.available === false || this.store.getSourceAccess(endpoint.id).mode === 'off'
        || !this.options.config()[binding.platform].enabled || !channel || channel.state.accountId !== endpoint.accountId
        || requireConnected && !channel.state.connected) return [];
      return [{ endpointId: endpoint.id, platform: endpoint.platform,
        title: this.store.getMeta(`endpoint-alias:${endpoint.id}`) || endpoint.title,
        participants: this.store.getThreadParticipants(endpoint.id), conversationId: conversation.id, endpoint, channel }];
    });
  }
  private toolReceipt(delivery: Delivery): MessageToolReceipt {
    return { operationId: delivery.id, endpointId: delivery.origin.endpointId, status: delivery.status,
      ...(delivery.remoteMessageId ? { remoteMessageId: delivery.remoteMessageId } : {}),
      ...(delivery.error ? { error: delivery.kind === 'message' && delivery.status === 'cancelled' ? 'Связь или доступ к источнику изменились. Сообщение не отправлено.'
        : delivery.status === 'uncertain' ? 'Результат отправки неизвестен. Проверьте исходный чат; не повторяйте отправку.' : 'Сообщение пока не доставлено. Проверьте состояние в Rele.' } : {}) };
  }
  /** Only our native send approval is forwarded; generic MCP forms may contain secrets. */
  private mcpMessageApproval(p: Record<string, any>): string | undefined {
    const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
    const schema = p.requestedSchema, meta = p._meta, args = meta?.tool_params;
    if (p.serverName !== 'rele' || p.mode !== 'form' || !object(meta) || meta.codex_approval_kind !== 'mcp_tool_call'
      || !object(schema) || schema.type !== 'object' || !object(schema.properties) || Object.keys(schema.properties).length
      || Object.keys(schema).some(key => !['type', 'properties', 'required'].includes(key))
      || schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length)
      || !object(args) || Object.keys(args).some(key => !['endpointId', 'text', 'mentionIds'].includes(key))
      || typeof args.endpointId !== 'string' || typeof args.text !== 'string' || !args.text.trim() || [...args.text].length > 3000
      || /[\x00-\x08\x0b-\x1f\x7f]/u.test(args.text)) return;
    const target = this.toolDestinations(p.threadId, false).find(value => value.endpointId === args.endpointId);
    const ids = args.mentionIds === undefined ? [] : args.mentionIds;
    if (!target || !Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) return;
    const people = ids.map(id => target.participants.find(person => person.id === id));
    if (people.some(person => !person)) return;
    // Approval previews describe the intended pings without issuing those pings themselves.
    return [`Инструмент: Rele · send_message`, `Адресат: ${target.platform} · ${target.title}`,
      ...(people.length ? [`Упоминания: ${people.map(person => `${person!.name} (${person!.id})`).join(', ')}`] : []),
      `Сообщение:\n${args.text}`].join('\n\n').replaceAll('@', '@\u200b');
  }
  private ownIdentity(channel: Channel, platform: Platform): Person {
    return channel.identity ?? { id: platform === 'slack' ? channel.state.accountId!.split(':').at(-1)! : channel.state.accountId!,
      name: channel.state.name ?? 'Подключённый агент', isBot: true };
  }

  async messageTool(call: MessageToolCall): Promise<{ destinations: MessageDestination[] } | MessageToolReceipt> {
    if (this.stopped) throw new MessageToolValidationError('stopping');
    if (typeof call.threadId !== 'string' || !call.threadId.trim() || call.threadId.length > 200
      || typeof call.callId !== 'string' || !call.callId.trim() || call.callId.length > 300) throw new MessageToolValidationError('invalid_call');
    if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw new MessageToolValidationError('invalid_arguments');
    const args = call.arguments as Record<string, unknown>;
    const fields = (allowed: string[]) => { if (Object.keys(args).some(key => !allowed.includes(key))) throw new MessageToolValidationError('unknown_arguments'); };
    if (call.name === 'list_destinations') {
      fields([]);
      return { destinations: this.toolDestinations(call.threadId).map(({ endpointId, platform, title, participants }) => ({ endpointId, platform, title, participants })) };
    }
    if (call.name === 'get_message_status') {
      fields(['operationId']);
      if (typeof args.operationId !== 'string' || args.operationId.length > 100) throw new MessageToolValidationError('operation_required');
      const delivery = this.store.toolMessageStatus(call.threadId, args.operationId);
      if (!delivery) throw new MessageToolValidationError('operation_unknown');
      return this.toolReceipt(delivery);
    }
    if (call.name !== 'send_message') throw new MessageToolValidationError('unknown_tool');
    fields(['endpointId', 'text', 'mentionIds']);
    if (typeof args.endpointId !== 'string' || !args.endpointId || args.endpointId.length > 200) throw new MessageToolValidationError('destination_required');
    if (typeof args.text !== 'string' || !args.text.trim() || [...args.text].length > 3000) throw new MessageToolValidationError('text_invalid');
    const mentionIds = args.mentionIds === undefined ? [] : args.mentionIds;
    if (!Array.isArray(mentionIds) || mentionIds.some(id => typeof id !== 'string' || !id || id.length > 200)
      || new Set(mentionIds).size !== mentionIds.length) throw new MessageToolValidationError('mentions_invalid');
    const canonical = { endpointId: args.endpointId, text: args.text, mentionIds };
    const existing = this.store.toolMessageForCall(call.threadId, call.callId, canonical);
    if (existing) return this.toolReceipt(existing);
    const target = this.toolDestinations(call.threadId).find(destination => destination.endpointId === args.endpointId);
    if (!target) throw new MessageToolValidationError('destination_unavailable');
    const mentions = (mentionIds as string[]).map(id => {
      const person = target.participants.find(value => value.id === id);
      if (!person) throw new MessageToolValidationError('participant_unknown');
      if (target.platform === 'slack' ? !/^[UW][A-Z0-9]+$/u.test(person.id) : !person.username || !/^[A-Za-z0-9_]{1,32}$/u.test(person.username)) {
        throw new MessageToolValidationError('mention_unavailable');
      }
      return { ...person };
    });
    const sender = this.ownIdentity(target.channel, target.platform), endpoint = target.endpoint;
    const delivery = this.store.addToolMessage({ threadId: call.threadId, callId: call.callId, conversationId: target.conversationId,
      arguments: canonical, text: args.text, mentions, origin: { platform: target.platform, accountId: endpoint.accountId, endpointId: endpoint.id,
        chatId: endpoint.chatId, threadId: endpoint.threadId, senderId: sender.id, senderName: sender.name, senderIsBot: true, messageId: '' } });
    this.changed(); this.track(this.deliver());
    return this.toolReceipt(this.store.getDelivery(delivery.id)!);
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
        if (delivery.kind === 'message') {
          const target = this.toolDestinations(delivery.nativeThreadId!, false).find(value => value.endpointId === delivery.origin.endpointId);
          if (!target || target.conversationId !== delivery.conversationId || target.endpoint.accountId !== delivery.origin.accountId
            || delivery.mentions?.some(person => !target.participants.some(known => known.id === person.id && known.username === person.username))) {
            this.store.updateDelivery(delivery.id, { status: 'cancelled', error: 'Tool message source access changed.' }); continue;
          }
        }
        if (!channel?.state.connected) {
          this.store.updateDelivery(delivery.id, { status: 'pending', nextAttemptAt: new Date(Date.now() + 5000).toISOString() }); continue;
        }
        try {
          const remoteMessageId = await channel.deliver(delivery, approval);
          const sender = this.ownIdentity(channel, delivery.origin.platform);
          const ownReceipt: InboundMessage | undefined = delivery.kind === 'message' && delivery.origin.platform === 'telegram'
            ? { eventId: `tool-outgoing:${delivery.id}`, endpoint: this.store.getEndpoint(delivery.origin.endpointId)!, sender,
              messageId: remoteMessageId, text: channel.deliveryText?.(delivery) ?? delivery.body, contextOnly: true } : undefined;
          this.store.updateDelivery(delivery.id, { status: 'sent', remoteMessageId, error: undefined }, ownReceipt);
          if (channel.state.accountId) {
            try {
              if (!ownReceipt) this.store.rememberThreadParticipant(delivery.origin.endpointId, sender, remoteMessageId);
            } catch (error) { this.emit('diagnostic', this.options.redact(error)); }
          }
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
    if (method === 'turn/started') for (const active of this.store.activeRequests()) {
      if (!active.steeredInto && this.store.getMeta(`overload-retry:${active.id}`) && this.store.getConversation(active.conversationId)?.threadId === p.threadId) await this.reconcile(active.id);
    }
    const progressRequest = this.store.activeRequests().find(request => !request.steeredInto && request.turnId === p.turnId
      && this.store.getConversation(request.conversationId)?.threadId === p.threadId);
    if (progressRequest && !this.isMixed(progressRequest.id)) {
      if (method === 'error' && p.willRetry === true && p.error?.codexErrorInfo === 'serverOverloaded') {
        this.retryNotice(progressRequest, `native:${p.turnId}`, 'Codex временно перегружен и автоматически повторяет попытку. Ожидаю продолжения.');
      }
      if (method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase === 'commentary' && typeof p.item.text === 'string' && p.item.text.trim()) {
        this.recordProgress(progressRequest.id, { statusText: undefined, steps: [{
          id: `${p.turnId}:${p.item.id ?? createHash('sha256').update(p.item.text).digest('hex')}`, text: p.item.text,
        }] });
      } else if (method === 'turn/plan/updated' && Array.isArray(p.plan) && p.plan.length <= 50
        && p.plan.every((item: any) => typeof item?.step === 'string' && item.step.trim() && ['pending', 'in_progress', 'completed'].includes(item.status))) {
        this.recordProgress(progressRequest.id, { plan: p.plan.map((item: any) => ({ step: this.options.redact(item.step).slice(0, 300), status: item.status })) });
      }
    }
    const command = ['item/started', 'item/completed'].includes(method) && codexCommandItem(p.item);
    if (command && typeof p.threadId === 'string' && typeof p.turnId === 'string') {
      const own = this.store.activeRequests().find(request => request.turnId === p.turnId && this.store.getConversation(request.conversationId)?.threadId === p.threadId);
      if (own && !this.isMixed(own.id)) this.rememberCommandItems(own.id, [{ ...command, ...(method === 'item/completed' ? { completed: true as const } : {}) }]);
    }
    if (['item/started', 'item/completed'].includes(method) && p.item?.type === 'fileChange') {
      this.fileChanges.set(String(p.item.id), JSON.stringify(p.item.changes ?? [], null, 2).slice(0, 12_000));
      if (this.fileChanges.size > 100) this.fileChanges.delete(this.fileChanges.keys().next().value!);
    }
    if (['item/started', 'item/completed'].includes(method) && p.item?.type === 'userMessage' && typeof p.turnId === 'string') {
      const input = typeof p.item.clientId === 'string' ? this.store.getSteeringInput(p.item.clientId) : undefined;
      const own = typeof p.item.clientId === 'string' ? this.store.getRequest(input && input.state !== 'refused' && input.turnId === p.turnId ? input.parentRequestId : p.item.clientId) : undefined;
      const conversation = own && this.store.getConversation(own.conversationId);
      if (own && conversation?.threadId === p.threadId && !terminal(own.status)) {
        this.store.updateRequest(own.id, { turnId: p.turnId, status: this.isMixed(own.id) ? 'uncertain' : own.status === 'waiting_approval' ? 'waiting_approval' : 'running' });
      }
      for (const active of this.store.activeRequests()) {
        if (!active.steeredInto && active.turnId === p.turnId && this.store.getConversation(active.conversationId)?.threadId === p.threadId && !this.ownInputIds(active.id).includes(p.item.clientId)) {
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
      for (const [key, pending] of this.pendingQuestions) if (pending.epoch === this.epoch
        && pending.event.id === p.requestId && (pending.event.params as Record<string, unknown>).threadId === p.threadId) this.pendingQuestions.delete(key);
      for (const approval of this.store.listApprovals(1000)) if (approval.rpcId === p.requestId && approval.status === 'pending') {
        const request = this.store.getRequest(approval.requestId)!;
        if (this.store.getConversation(request.conversationId)?.threadId !== p.threadId) continue;
        this.store.setMeta(`approval-resolution:${approval.id}`, JSON.stringify({ source: 'codex' }));
        this.store.updateApproval(approval.id, { status: 'answered', decision: 'resolved_in_codex' });
        this.store.cancelApprovalDeliveries(approval.id);
        if (request.status === 'waiting_approval') this.store.updateRequest(request.id, { status: 'running' });
      }
    }
    this.changed();
  }

  private pendingProgress(): string[] {
    return JSON.parse(this.store.getMeta('request-progress:pending') ?? '[]') as string[];
  }

  private async flushApprovalUpdates(): Promise<void> {
    if (this.approvalUpdatesSending || this.stopped) return;
    const channel = this.channels.slack;
    if (!channel?.state.connected || !channel.updateApproval) return;
    this.approvalUpdatesSending = true;
    try {
      for (const { delivery, approval, version } of this.store.resolvedApprovalDeliveries()) {
        if (this.stopped || channel !== this.channels.slack || channel.state.accountId !== delivery.origin.accountId
          || Date.now() < (this.approvalUpdateRetry.get(delivery.id) ?? 0)) continue;
        try {
          const raw = this.store.getMeta(`approval-resolution:${approval.id}`);
          await channel.updateApproval(delivery, approval, raw ? JSON.parse(raw) as ApprovalResolution : undefined);
          this.store.setMeta(`approval-ui-updated:${delivery.id}`, version);
          this.approvalUpdateRetry.delete(delivery.id);
        } catch (error) {
          this.approvalUpdateRetry.set(delivery.id, Date.now() + 5000);
          this.store.setMeta(`approval-ui-attempted:${delivery.id}`, String(Date.now()));
          this.emit('diagnostic', this.options.redact(error));
        }
      }
    } finally { this.approvalUpdatesSending = false; }
  }
  private recordProgress(id: string, patch: RequestProgress, historyOrder = false): void {
    const request = this.store.getRequest(id);
    if (!request || request.origin.platform !== 'slack' || request.steeredInto) return;
    const key = `request-progress:${id}`, previous = this.store.getMeta(key);
    if (!previous && patch.terminal) return;
    const old = JSON.parse(previous ?? '{}') as RequestProgress;
    if (patch.steps) {
      const incoming = patch.steps.map(step => ({ ...step, text: this.options.redact(step.text) }));
      const before = old.steps ?? (old.commentary ? [{ id: 'legacy', text: old.commentary }] : []);
      const retained = before.filter(step => step.id !== 'legacy' || !incoming.some(next => next.text === step.text));
      const byId = new Map(retained.map(step => [step.id, step]));
      for (const step of incoming) byId.set(step.id, step);
      patch.steps = historyOrder ? [...incoming, ...retained.filter(step => !incoming.some(next => next.id === step.id))] : [...byId.values()];
      patch.commentary = patch.steps.at(-1)?.text;
    }
    const next = JSON.stringify({ ...old, ...patch });
    if (previous === next) return;
    this.store.setMeta(key, next);
    this.store.setMeta('request-progress:pending', JSON.stringify([...new Set([...this.pendingProgress(), id])]));
  }
  private async flushProgress(): Promise<void> {
    if (this.progressSending || this.stopped || !this.codex.status().connected) return;
    this.progressSending = true;
    try {
      for (const id of this.pendingProgress()) {
        if (this.stopped || Date.now() < (this.progressRetryAfter.get(id) ?? 0)) continue;
        const request = this.store.getRequest(id), channel = this.channels.slack, client = this.codex;
        if (!request || request.origin.platform !== 'slack' || request.steeredInto) continue;
        if (!channel?.updateProgress || !channel.state.connected || channel.state.accountId !== request.origin.accountId) continue;
        const conversation = this.store.getConversation(request.conversationId);
        if (!conversation || !request.turnId) continue;
        const key = `request-progress:${id}`, saved = this.store.getMeta(key);
        if (!saved) continue;
        try {
          if (request.status === 'uncertain' && !this.isMixed(id)) {
            // Only relabel an already published card; unverified details stay local.
            await channel.updateProgress(id, request.origin, { statusText: uncertainProgress, existingOnly: true });
            if (this.store.getMeta(key) === saved) this.store.setMeta('request-progress:pending', JSON.stringify(this.pendingProgress().filter(value => value !== id)));
            this.progressRetryAfter.delete(id);
            continue;
          }
          const found = await this.findOwnRequest(client, conversation.threadId, id);
          if (client !== this.codex || this.stopped) continue;
          if (found.mixed || this.isMixed(id)) {
            await channel.updateProgress(id, request.origin, { terminal: 'failed', existingOnly: true });
            this.store.setMeta('request-progress:pending', JSON.stringify(this.pendingProgress().filter(value => value !== id)));
            continue;
          }
          if (found.turnId !== request.turnId || !['running', 'completed', 'failed', 'interrupted'].includes(found.state)) {
            this.store.setMeta('request-progress:pending', JSON.stringify(this.pendingProgress().filter(value => value !== id)));
            continue;
          }
          await channel.updateProgress(id, request.origin, JSON.parse(saved) as RequestProgress);
          if (this.store.getMeta(key) === saved) this.store.setMeta('request-progress:pending', JSON.stringify(this.pendingProgress().filter(value => value !== id)));
          this.progressRetryAfter.delete(id);
        } catch (error) {
          this.progressRetryAfter.set(id, Date.now() + 5000);
          this.emit('diagnostic', this.options.redact(error));
        }
      }
    } finally { this.progressSending = false; }
  }

  private deferQuestion(event: CodexServerRequest, epoch: string): void {
    if (event.method === 'item/tool/requestUserInput' && epoch === this.epoch && !this.stopped)
      this.pendingQuestions.set(JSON.stringify([epoch, (event.params as Record<string, unknown>).threadId, event.id]), { event, epoch, retryAt: Date.now() + 5000 });
  }

  private async retryPendingQuestions(): Promise<void> {
    if (this.retryingQuestions || this.stopped || !this.codex.status().connected) return;
    this.retryingQuestions = true;
    try {
      for (const [key, pending] of this.pendingQuestions) {
        if (pending.retryAt > Date.now()) continue;
        this.pendingQuestions.delete(key);
        if (pending.epoch === this.epoch && this.codex.hasPendingRequest?.(pending.event.id) !== false) await this.onServerRequest(pending.event);
      }
    } finally { this.retryingQuestions = false; }
  }

  private async onServerRequest(event: CodexServerRequest): Promise<void> {
    const client = this.codex, epoch = this.epoch;
    const current = () => client === this.codex && epoch === this.epoch && !this.stopped && client.hasPendingRequest?.(event.id) !== false;
    if (!current()) return;
    const managed = client.status().transport === 'managed';
    const rejectUnowned = async () => { if (managed) await client.rejectRequest(event.id, 'Rele cannot authorize this request without its original message.'); };
    const reviewHint = managed ? 'Действие отклонено. Сверьте запрос в панели Rele.' : 'Продолжите в Codex.';
    const p = event.params as Record<string, any>;
    for (const active of this.store.activeRequests()) if (!active.steeredInto && this.store.getConversation(active.conversationId)?.threadId === p.threadId
      && this.retryingOverloads.has(active.id)) await this.retryingOverloads.get(active.id)!.catch(() => {});
    if (!current()) return;
    const request = this.store.activeRequests().find(row => !row.steeredInto && row.turnId === p.turnId && this.store.getConversation(row.conversationId)?.threadId === p.threadId);
    // An external server may broadcast another client's request. In our own child,
    // an unowned request has no authorized handler and must receive an explicit error.
    if (!request || this.isMixed(request.id)) {
      await rejectUnowned();
      return;
    }
    // A foreign user message may have arrived before our own correlation event.
    // Verify history before publishing approval details outside the local runtime.
    let location: RequestLocation;
    try { location = await this.findOwnRequest(client, p.threadId, request.id); }
    catch {
      if (!current()) return;
      if (!terminal(this.store.getRequest(request.id)!.status)) this.store.updateRequest(request.id, { status: 'uncertain', error: `Не удалось проверить происхождение подтверждения. ${event.method === 'item/tool/requestUserInput' ? 'Вопрос сохранён; сверка повторится автоматически.' : reviewHint}` });
      if (event.method === 'item/tool/requestUserInput') this.deferQuestion(event, epoch);
      else await rejectUnowned();
      this.changed(); return;
    }
    if (!current()) return;
    if (terminal(this.store.getRequest(request.id)!.status)) { await rejectUnowned(); return; }
    if (location.mixed) {
      this.store.setMeta(`mixed:${request.id}`, '1');
      this.store.updateRequest(request.id, { status: 'uncertain', error: mixedMessage });
      await rejectUnowned();
      this.changed(); return;
    }
    if (location.state !== 'running' || location.turnId !== p.turnId) {
      const retryQuestion = event.method === 'item/tool/requestUserInput' && location.state === 'not_found';
      if (retryQuestion) this.deferQuestion(event, epoch);
      this.store.updateRequest(request.id, { status: 'uncertain', error: `Подтверждение не совпало с активным ходом запроса. ${retryQuestion ? 'Вопрос сохранён; сверка повторится автоматически.' : reviewHint}` });
      if (!retryQuestion) await rejectUnowned();
      this.changed(); return;
    }
    const question = event.method === 'item/tool/requestUserInput';
    const command = event.method === 'item/commandExecution/requestApproval';
    const files = event.method === 'item/fileChange/requestApproval';
    const mcp = event.method === 'mcpServer/elicitation/request' ? this.mcpMessageApproval(p) : undefined;
    if (!question && !command && !files && !mcp) {
      if (this.codex.status().transport === 'managed') {
        await this.codex.rejectRequest(event.id, 'This Codex interaction is not supported by Rele.');
        this.store.updateRequest(request.id, { error: 'Codex запросил действие, которое Rele пока не поддерживает. Действие отклонено; выполнение можно отменить в панели.' });
      } else this.store.updateRequest(request.id, { status: 'waiting_approval', error: 'Codex запросил действие, которое нужно подтвердить в самом Codex.' });
      this.changed(); return;
    }
    const questions: ApprovalQuestion[] | undefined = question && Array.isArray(p.questions) ? p.questions.map((entry: Record<string, any>) => ({ id: String(entry.id), header: String(entry.header ?? ''), question: String(entry.question ?? ''), isSecret: !!entry.isSecret, ...(Array.isArray(entry.options) ? { options: entry.options.map((option: Record<string, any>) => ({ label: String(option.label), description: String(option.description ?? '') })) } : {}) })) : undefined;
    const title = mcp ? 'Codex запрашивает отправку сообщения' : question ? 'Codex ждёт уточнения' : command ? 'Codex запрашивает выполнение команды' : 'Codex запрашивает изменение файлов';
    const metadata = mcp ?? [p.reason, p.command, p.cwd ? `Каталог: ${p.cwd}` : '', p.grantRoot ? `Доступ на запись: ${p.grantRoot}` : '', p.additionalPermissions ? JSON.stringify(p.additionalPermissions) : '', files ? this.fileChanges.get(String(p.itemId)) : ''].filter(Boolean).join('\n\n').slice(0, 16_000);
    const questionDetails = questions?.map((value, index) => `${questions.length > 1 ? `${index + 1}. ` : ''}${value.header}: ${value.question}${value.options?.length ? '\n' + value.options.map(option => `${option.label} — ${option.description}`).join('\n') : ''}`).join('\n\n');
    const details = [metadata, questionDetails].filter(Boolean).join('\n\n');
    const approval = this.store.addApproval({ requestId: request.id, turnId: p.turnId, itemId: `${mcp ? 'mcp' : p.itemId}:${p.approvalId ?? event.id}:${this.epoch}`, rpcId: event.id, method: event.method, title, details, questions });
    this.store.setMeta(`approval-epoch:${approval.id}`, this.epoch);
    const choices: unknown[] | undefined = Array.isArray(p.availableDecisions) ? p.availableDecisions : undefined;
    this.approvals.set(approval.id, { accept: !choices || choices.includes('accept'), decline: choices?.includes('cancel') && !choices.includes('decline') ? 'cancel' : 'decline' });
    this.store.updateRequest(request.id, { status: 'waiting_approval' });
    const guidance = questions?.length && !questions.some(question => question.isSecret)
      ? questions.length === 1 ? '\n\nОтветьте на это сообщение.' : '\n\nОтветьте на это сообщение: по строке на каждый вопрос, по порядку — 1. ответ, затем с новой строки 2. ответ.'
      : questions?.length ? '\n\nСекретные ответы вводятся только в локальной панели Rele.' : '';
    // Nonsecret questions must be visible in full before the origin can answer them.
    const bodies = mcp ? splitReply(`${title}\n\n${details}`, 3000) : questions?.length && !questions.some(value => value.isSecret)
      ? splitReply(`${title}\n\n${details}${guidance}`, 3000)
      : [`${title}\n\n${details.slice(0, 2400)}${details.length > 2400 ? '\n… Полный запрос доступен в панели Rele.' : ''}${guidance}`];
    this.store.addDeliveries(request.id, bodies.map((body, ordinal) => ({ key: ordinal ? `approval:${approval.id}:${ordinal}` : `approval:${approval.id}`, ordinal, kind: 'approval' as const, body, approvalId: approval.id })));
    this.changed();
    this.track(this.deliver());
  }

  private retryNotice(request: ReleRequest, key: string, text: string): void {
    if (this.store.getMeta(`retry-notice:${request.id}:${key}`)) return;
    this.store.addDeliveries(request.id, [{ key: `retry:${key}`, ordinal: 0, kind: 'answer', body: text }]);
    this.store.setMeta(`retry-notice:${request.id}:${key}`, '1');
    this.recordProgress(request.id, { statusText: text });
  }

  private async retryOverload(request: ReleRequest, found: RequestLocation): Promise<boolean> {
    if (found.state !== 'failed' || found.failureReason !== 'serverOverloaded' || !found.turnId || found.mixed || this.isMixed(request.id)) return false;
    if (this.store.getMeta(`cancel-requested:${request.id}`)) { this.track(this.cancel(request.id)); return true; }
    if (found.retryBlocked) return false;
    const key = `overload-retry:${request.id}`, raw = this.store.getMeta(key);
    let retry = raw ? JSON.parse(raw) as OverloadRetry : undefined;
    if (retry && retry.target !== this.targetFingerprint()) {
      this.store.updateRequest(request.id, { status: 'uncertain', error: 'Подключение Codex изменилось. Автоматический повтор приостановлен до сверки.' });
      return true;
    }
    if (retry?.turnId !== found.turnId) {
      const attempts = Math.max(retry?.attempts ?? 0, found.retryCount ?? 0);
      if (attempts >= overloadDelays.length) return false;
      retry = { turnId: found.turnId, attempts, dueAt: Date.now() + overloadDelays[attempts] * 1000, target: this.targetFingerprint() };
      this.store.setMeta(key, JSON.stringify(retry));
      this.retryNotice(request, found.turnId, `Codex временно перегружен. Автоматический повтор ${attempts + 1}/${overloadDelays.length} — через ${overloadDelays[attempts]} с. Запрос можно остановить.`);
    }
    if (retry!.sending) {
      const error = 'Проверяется результат повтора Codex. Повторная отправка запрещена до подтверждения в истории.';
      this.store.updateRequest(request.id, { status: 'uncertain', error });
      this.retryNotice(request, `uncertain:${found.turnId}`, error);
      return true;
    }
    this.store.updateRequest(request.id, { status: 'running', turnId: found.turnId, error: `Codex перегружен. Ожидается автоматический повтор ${retry!.attempts + 1}/${overloadDelays.length}.` });
    const conversation = this.store.getConversation(request.conversationId)!;
    if (Date.now() < retry!.dueAt || this.stopped || this.suspended || conversation.paused || this.waitsForSource(request)) return true;
    const client = this.codex, epoch = this.epoch;
    if (this.store.steeringInputs(request.id).some(input => input.state === 'sending' || input.state === 'uncertain')) return true;
    try {
      const operation = client.retryOverloaded(conversation.threadId, request.id, found.turnId, this.ownInputIds(request.id), () => {
        if (this.stopped || this.suspended || client !== this.codex || epoch !== this.epoch || this.store.getMeta(`cancel-requested:${request.id}`)
          || terminal(this.store.getRequest(request.id)!.status) || this.store.getConversation(request.conversationId)?.paused || this.waitsForSource(request)) return false;
        retry!.sending = true; retry!.attempts++;
        this.store.setMeta(key, JSON.stringify(retry));
        return true;
      });
      this.retryingOverloads.set(request.id, operation);
      let result: { turnId: string } | undefined;
      try { result = await operation; } finally { this.retryingOverloads.delete(request.id); }
      if (client !== this.codex || epoch !== this.epoch) return true;
      if (result) {
        this.store.updateRequest(request.id, { turnId: result.turnId, status: 'running', error: undefined });
        this.recordProgress(request.id, { statusText: `Автоматический повтор ${retry!.attempts}/${overloadDelays.length}: Codex продолжает работу.` });
      }
      if (result) this.reconcileAgain.add(request.id);
      else { retry!.dueAt = Date.now() + 15_000; this.store.setMeta(key, JSON.stringify(retry)); }
    } catch (error) {
      if (error instanceof CodexThreadBusyError) {
        retry!.sending = false; retry!.attempts--; retry!.dueAt = Date.now() + 15_000;
        this.store.setMeta(key, JSON.stringify(retry));
      } else throw error;
    }
    return true;
  }

  private finishFromHistory(request: ReleRequest, found: RequestLocation): void {
    const cleanup = this.cancelCleanup(request.id);
    if (this.cancelling.has(request.id) && !cleanup?.done || cleanup && !cleanup.done) {
      this.store.updateRequest(request.id, { status: 'uncertain', error: 'Ожидается подтверждение остановки фоновых команд.' });
      return;
    }
    if (cleanup?.done && found.failureReason === 'serverOverloaded' && this.store.getMeta(`cancel-requested:${request.id}`)) {
      this.store.finishRequest(request.id, { status: 'cancelled', error: undefined, turnId: found.turnId }, []);
      this.recordProgress(request.id, { terminal: 'cancelled' });
      return;
    }
    if (found.mixed || this.isMixed(request.id)) {
      this.store.setMeta(`mixed:${request.id}`, '1');
      this.store.finishRequest(request.id, { status: 'failed', turnId: found.turnId, error: mixedMessage }, []);
      this.recordProgress(request.id, { terminal: 'failed', existingOnly: true });
      return;
    }
    const pending = this.store.steeringInputs(request.id).filter(input => input.state === 'sending' || input.state === 'uncertain');
    if (pending.length) {
      this.store.updateRequest(request.id, { status: 'uncertain', error: 'Проверяется добавление сообщений в текущий ответ. Повторная отправка запрещена.' });
      for (const input of pending) this.track(this.reconcileSteering(input));
      return;
    }
    if (found.state === 'completed') {
      const suppressed = found.text?.trim() === 'NOREPLY';
      this.store.finishRequest(request.id, { status: 'completed', turnId: found.turnId, error: undefined }, suppressed ? []
        : (request.origin.platform === 'slack' ? splitSlackReply(found.text ?? '') : splitReply(found.text ?? '')).map((body, ordinal) => ({ key: `answer:${ordinal}`, ordinal, kind: 'answer' as const, body })), suppressed);
      this.recordProgress(request.id, { terminal: 'completed' });
    } else if (found.state === 'failed' || found.state === 'interrupted') {
      const error = found.state === 'interrupted' ? 'Выполнение запроса остановлено в Codex.'
        : found.failureReason === 'serverOverloaded' ? found.retryBlocked ? 'Codex временно перегружен. В чате уже началась другая задача; автоматические повторы этого запроса остановлены.' : 'Codex остаётся перегружен после автоматических повторов. Запрос завершён с ошибкой.'
          : 'Codex завершил запрос с ошибкой. Подробности доступны в Codex.';
      this.store.finishRequest(request.id, { status: found.state, turnId: found.turnId, error }, [{ key: 'terminal:error', ordinal: 0, kind: 'error', body: error }]);
      this.recordProgress(request.id, { terminal: found.state });
    }
  }

  private fail(id: string, error: string): void { this.store.finishRequest(id, { status: 'failed', error }, [{ key: 'terminal:error', ordinal: 0, kind: 'error', body: error }]); }
  private isMixed(id: string): boolean { return this.store.getMeta(`mixed:${id}`) === '1'; }
  private sameSource(request: ReleRequest, message: { endpoint: Pick<InboundMessage['endpoint'], 'platform' | 'accountId' | 'chatId' | 'threadId'> }): boolean {
    const origin = request.origin;
    return origin.platform === message.endpoint.platform && origin.accountId === message.endpoint.accountId && origin.chatId === message.endpoint.chatId && origin.threadId === message.endpoint.threadId;
  }
  private sameOrigin(request: ReleRequest, message: { endpoint: Pick<InboundMessage['endpoint'], 'platform' | 'accountId' | 'chatId' | 'threadId'>; sender: Pick<InboundMessage['sender'], 'id' | 'isBot'> }): boolean {
    if (!this.sameSource(request, message) || message.sender.isBot === true) return false;
    const origin = request.origin;
    if (origin.senderIsBot !== true) return origin.senderId === message.sender.id;
    const group = origin.platform === 'slack' ? /^[CG]/u.test(origin.chatId) : /^-/u.test(origin.chatId);
    return group && message.sender.isBot === false;
  }
  private expireApprovals(): void {
    this.pendingQuestions.clear();
    this.store.expirePendingApprovals();
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
