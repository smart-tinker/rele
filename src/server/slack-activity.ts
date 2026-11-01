import type { Origin, ReleRequest } from '../shared/types.js';
import type { SlackSessionStatus } from './channels/common.js';
import type { Store } from './store.js';

const refreshMs = 45_000;
const retryMs = 15_000;
const statuses = {
  queued: [0, 'active'],
  waiting_approval: [3, 'suspended'],
  transcribing: [1, 'processing'],
  starting: [0, 'active'],
  running: [2, 'processing'],
  uncertain: [0, 'active'],
} as const;

type Target = {
  origin: Origin;
  status: SlackSessionStatus;
  active: boolean;
  revision: number;
  sentRevision: number;
  sentAt: number;
  retryAt: number;
  task?: Promise<void>;
};

/** Persisted requests own status targets; passive Slack history never creates activity. */
export class SlackActivity {
  private targets = new Map<string, Target>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private pending = new Map<string, Origin>();

  constructor(
    private readonly readRequests: () => ReleRequest[],
    private readonly send: (origin: Origin, status: SlackSessionStatus) => Promise<void>,
    private readonly diagnostic: (error: unknown) => void,
    private readonly store?: Pick<Store, 'getMeta' | 'setMeta'>,
  ) {
    try {
      const saved = store?.getMeta('slack-activity:targets');
      if (!saved) return;
      const origins = JSON.parse(saved) as Origin[];
      if (!Array.isArray(origins) || origins.some(origin => !origin || origin.platform !== 'slack'
        || ['accountId', 'endpointId', 'chatId', 'threadId', 'senderId', 'senderName', 'messageId'].some(field => typeof origin[field as keyof Origin] !== 'string')
        || !origin.accountId || !origin.chatId || !origin.threadId)) throw new Error('Invalid saved Slack activity target');
      for (const origin of origins) {
        const key = JSON.stringify([origin.accountId, origin.chatId, origin.threadId]);
        this.pending.set(key, origin);
        this.targets.set(key, { origin, status: 'active', active: false, revision: 1, sentRevision: 0, sentAt: 0, retryAt: 0 });
      }
    } catch (error) { this.report(error); }
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), refreshMs);
    this.timer.unref();
  }

  refresh(force = false): void {
    if (this.stopped) return;
    const current = new Map<string, { origin: Origin; priority: number; status: SlackSessionStatus }>();
    try {
      for (const request of this.readRequests()) {
        const origin = request.origin;
        if (origin.platform !== 'slack' || !origin.accountId || !origin.chatId || !origin.threadId || !(request.status in statuses)) continue;
        const [priority, status] = statuses[request.status as keyof typeof statuses];
        const key = JSON.stringify([origin.accountId, origin.chatId, origin.threadId]);
        if (!current.has(key) || current.get(key)!.priority < priority) current.set(key, { origin, priority, status });
      }
    } catch (error) { this.report(error); return; }

    for (const [key, value] of current) if (!this.targets.has(key)) this.targets.set(key, {
      origin: { ...value.origin }, status: value.status, active: true,
      revision: 1, sentRevision: 0, sentAt: 0, retryAt: 0,
    });
    for (const [key, target] of this.targets) {
      target.active = current.has(key);
      const status = current.get(key)?.status ?? 'active';
      if (target.status !== status || (force && status !== 'active')) {
        target.status = status;
        target.revision++;
        target.retryAt = 0;
      }
      this.flush(key, target);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const [key, target] of this.targets) {
      target.active = false;
      if (target.status !== 'active') { target.status = 'active'; target.revision++; }
      target.retryAt = 0;
      this.flush(key, target);
    }
    await Promise.all([...this.targets.values()].map(target => target.task));
  }

  private needsSend(target: Target): boolean {
    return Date.now() >= target.retryAt && (target.sentRevision !== target.revision || (target.status !== 'active' && Date.now() - target.sentAt >= refreshMs));
  }

  private flush(key: string, target: Target): void {
    if (target.task || !this.needsSend(target)) return;
    target.task = this.write(key, target).finally(() => {
      target.task = undefined;
      if (!target.active && target.status === 'active' && target.sentRevision === target.revision) this.targets.delete(key);
      else this.flush(key, target);
    });
  }

  private async write(key: string, target: Target): Promise<void> {
    while (this.needsSend(target)) {
      const { revision, status } = target;
      try {
        // A crash or lost ACK must leave the original busy target available for clearing.
        if (status !== 'active') {
          this.pending.set(key, target.origin);
          this.store?.setMeta('slack-activity:targets', JSON.stringify([...this.pending.values()]));
        }
        await this.send(target.origin, status);
        if (status === 'active') {
          this.pending.delete(key);
          this.store?.setMeta('slack-activity:targets', JSON.stringify([...this.pending.values()]));
        }
        target.sentRevision = revision;
        target.sentAt = Date.now();
        target.retryAt = 0;
      } catch (error) {
        this.report(error);
        target.retryAt = revision === target.revision ? Date.now() + retryMs : 0;
      }
    }
  }

  private report(error: unknown): void {
    try { this.diagnostic(error); } catch { /* Status diagnostics cannot fail a request. */ }
  }
}
