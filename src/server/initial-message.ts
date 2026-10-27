import { createHash, randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { CodexRpcError, CodexThreadBusyError, type CodexClient } from './codex.js';
import { INITIAL_RELE_MESSAGE } from './inbound-context.js';
import type { Store } from './store.js';

type Gateway = Pick<CodexClient, 'status' | 'isVerifiedVersion' | 'subscribe' | 'releaseThread' | 'enqueue' | 'findRequest' | 'startQueued'>;
type Operation = { id: string; status: 'queued' | 'submitting' | 'running' | 'uncertain' | 'failed'; queuedSubmissionId?: string; turnId?: string; error?: string };
type State = { applied: boolean; operation?: Operation };

export function initialMessageKey(codexHome: string, threadId: string): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/u.test(codexHome);
  const paths = windows ? win32 : posix;
  if (!codexHome?.trim() || !paths.isAbsolute(codexHome) || !threadId?.trim()) throw new Error('Codex ещё не подтвердил исходный профиль и разговор.');
  let home = paths.normalize(codexHome);
  if (windows) home = home.toLowerCase();
  if (home.length > paths.parse(home).root.length) home = home.replace(/[\\/]+$/u, '');
  return `initial-rele-message:v1:${createHash('sha256').update(JSON.stringify([home, threadId])).digest('hex')}`;
}

/** One visible native turn per actual profile/thread, with durable non-idempotent submission intent. */
export class InitialMessages {
  private readonly working = new Set<string>();

  constructor(private readonly store: Store, private readonly getCodex: () => Gateway, private readonly canWork: () => boolean = () => true) {}

  private scope(conversationId: string) {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error('Разговор Rele не найден.');
    const client = this.getCodex(), home = client.status().codexHome;
    if (!home) throw new Error('Codex ещё не подтвердил исходный профиль.');
    return { conversation, client, key: initialMessageKey(home, conversation.threadId) };
  }

  private read(key: string): State {
    const raw = this.store.getMeta(key);
    if (raw === undefined) return { applied: false };
    try {
      const state = JSON.parse(raw) as State, op = state.operation;
      if (typeof state.applied !== 'boolean' || op !== undefined && (!op || typeof op !== 'object' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(op.id) ||
        !['queued', 'submitting', 'running', 'uncertain', 'failed'].includes(op.status) ||
        [op.queuedSubmissionId, op.turnId].some(value => value !== undefined && (typeof value !== 'string' || !value.trim())) ||
        op.error !== undefined && typeof op.error !== 'string')) throw new Error();
      return state;
    } catch { throw new Error('Состояние начального сообщения повреждено. Автоматическая повторная отправка заблокирована.'); }
  }

  private write(key: string, state: State): void { this.store.setMeta(key, JSON.stringify(state)); }

  queue(conversationId: string): { status: 'queued'; operationId: string } {
    if (!this.store.getConversation(conversationId)?.bindings.length) throw new Error('Сначала подключите источник к разговору Rele.');
    const { key } = this.scope(conversationId), state = this.read(key);
    if (state.operation && (['uncertain', 'submitting'].includes(state.operation.status) || state.operation.status === 'running' && !state.operation.turnId))
      throw new Error('Результат прежней отправки начального сообщения не подтверждён. Повтор не выполнен; ожидается сверка Codex.');
    if (!state.operation || state.operation.status === 'failed') {
      state.operation = { id: randomUUID(), status: 'queued' };
      this.write(key, state);
    }
    return { status: 'queued', operationId: state.operation.id };
  }

  hasPending(conversationId: string): boolean {
    try { const op = this.read(this.scope(conversationId).key).operation; return !!op && op.status !== 'failed'; }
    catch { return false; }
  }

  async ensure(conversationId: string): Promise<boolean> {
    const ready = await this.advance(conversationId);
    if (!ready) {
      const state = this.read(this.scope(conversationId).key);
      if (state.operation?.error) throw new Error(state.operation.error);
    }
    return ready;
  }

  private async advance(conversationId: string): Promise<boolean> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) return false;
    if (!conversation.bindings.length) return true;
    let scope: ReturnType<InitialMessages['scope']>;
    try { scope = this.scope(conversationId); } catch { return false; }
    const { client, key } = scope, threadId = scope.conversation.threadId;
    const allowed = () => {
      try {
        const current = this.scope(conversationId), status = client.status();
        return this.canWork() && current.client === client && current.key === key && current.conversation.bindings.length > 0 && !current.conversation.paused && status.connected && status.queueSupported &&
          client.isVerifiedVersion() && !this.store.activeRequests().some(request => request.conversationId === conversationId && !request.steeredInto && request.status !== 'queued');
      } catch { return false; }
    };
    if (!allowed() || this.working.has(key)) return false;
    let state: State;
    try { state = this.read(key); } catch { return false; }
    if (state.operation?.status === 'failed') return state.applied;
    if (state.applied && !state.operation) return true;
    this.working.add(key);
    let acquired = false, releaseFailed = false;
    try {
      if (!state.operation || state.operation.status === 'queued' && !state.operation.queuedSubmissionId) {
        await client.subscribe(threadId); acquired = true;
        if (!allowed()) return false;
        state = this.read(key); // A manual queue or another ensure may have settled while subscribe awaited.
        if (!state.applied && !state.operation) state.operation = { id: randomUUID(), status: 'queued' };
        const op = state.operation;
        if (op?.status === 'queued' && !op.queuedSubmissionId) {
          op.status = 'submitting'; this.write(key, state);
          try {
            const result = await client.enqueue(threadId, INITIAL_RELE_MESSAGE, op.id);
            op.queuedSubmissionId = result.queuedSubmissionId; op.status = 'queued'; delete op.error;
            this.write(key, state);
          } catch (error) {
            op.status = error instanceof CodexThreadBusyError ? 'queued' : error instanceof CodexRpcError ? 'failed' : 'uncertain';
            op.error = error instanceof CodexThreadBusyError ? 'Codex занят; начальное сообщение ожидает.' : 'Отправка начального сообщения не подтверждена. Требуется сверка без повторной отправки.';
            this.write(key, state); return state.applied && op.status === 'failed';
          }
        }
      }
      if (!allowed()) return false;
      const op = state.operation;
      if (op?.status === 'failed') return state.applied;
      if (op) {
        let found;
        try { found = await client.findRequest(threadId, op.id); }
        catch { op.error = 'Квитанция начального сообщения пока не подтверждена. Ожидается сверка.'; this.write(key, state); return false; }
        if (!allowed()) return false;
        if (op.turnId && found.turnId && op.turnId !== found.turnId) {
          op.status = 'uncertain'; op.error = 'Ход начального сообщения изменился. Повторная отправка заблокирована.';
        } else if (['completed', 'failed', 'interrupted'].includes(found.state)) {
          if (found.state === 'completed' && found.turnId && !found.mixed && found.text?.trim() === 'NOREPLY') {
            state.applied = true; delete state.operation;
          } else {
            op.status = 'failed'; op.turnId = found.turnId;
            op.error = 'Начальное сообщение завершилось без подтверждённого NOREPLY. Повтор возможен только по явному запросу.';
          }
        } else if (found.mixed) {
          op.status = 'uncertain'; op.turnId = found.turnId; op.error = 'В ход начального сообщения добавлен чужой ввод. Ожидается сверка завершения.';
        } else if (found.state === 'running') {
          op.status = 'running'; op.turnId = found.turnId; delete op.error;
        } else if (found.state === 'queued' && found.queuedSubmissionId) {
          if (op.queuedSubmissionId && op.queuedSubmissionId !== found.queuedSubmissionId) {
            op.status = 'uncertain'; op.error = 'Элемент очереди начального сообщения изменился. Повтор заблокирован.';
          } else {
            // running/uncertain + a queue ID records a prior queue/start intent, even if its ACK was lost.
            const started = !!op.turnId || op.status === 'running' || op.status === 'uncertain' && !!op.queuedSubmissionId;
            op.queuedSubmissionId = found.queuedSubmissionId;
            if (!started) op.status = 'queued';
            this.write(key, state);
            if (started || !found.soleQueuedSubmission) return false;
            if (!acquired) { await client.subscribe(threadId); acquired = true; }
            if (!allowed()) return false;
            op.status = 'running'; this.write(key, state);
            try {
              const result = await client.startQueued(threadId, found.queuedSubmissionId);
              op.turnId = result.turn.id; delete op.error;
            } catch (error) {
              // A definite busy refusal did not start this entry; an unknown result must never be retried.
              op.status = error instanceof CodexThreadBusyError ? 'queued' : 'uncertain';
              op.error = error instanceof CodexThreadBusyError ? 'Codex занят; начальное сообщение ожидает.' : 'Запуск начального сообщения не подтверждён. Ожидается сверка без повтора.';
            }
            this.write(key, state); return false;
          }
        } else {
          op.error = 'Начальное сообщение пока не найдено в Codex. Ожидается сверка без повторной отправки.';
        }
        this.write(key, state);
      }
    } catch {
      return false;
    } finally {
      if (acquired) { try { await client.releaseThread(threadId); } catch { releaseFailed = true; } }
      this.working.delete(key);
    }
    try { const latest = this.read(key); return !releaseFailed && allowed() && latest.applied && (!latest.operation || latest.operation.status === 'failed'); }
    catch { return false; }
  }
}
