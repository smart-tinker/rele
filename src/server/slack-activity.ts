import type { Origin, ReleRequest } from '../shared/types.js';

const refreshMs = 45_000;
const retryMs = 15_000;
// Slack treats every non-empty status as processing; waiting states must stay clear.
const statuses = {
  queued: [0, ''],
  waiting_approval: [0, ''],
  transcribing: [1, 'Распознаёт аудио…'],
  starting: [0, ''],
  running: [2, 'Выполняет запрос…'],
  uncertain: [0, ''],
} as const;

type Target = {
  origin: Origin;
  status: string;
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

  constructor(
    private readonly readRequests: () => ReleRequest[],
    private readonly send: (origin: Origin, status: string) => Promise<void>,
    private readonly diagnostic: (error: unknown) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), refreshMs);
    this.timer.unref();
  }

  refresh(force = false): void {
    if (this.stopped) return;
    const current = new Map<string, { origin: Origin; priority: number; status: string }>();
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
      const status = current.get(key)?.status ?? '';
      if (target.status !== status || (force && status)) {
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
      if (target.status) { target.status = ''; target.revision++; }
      target.retryAt = 0;
      this.flush(key, target);
    }
    await Promise.all([...this.targets.values()].map(target => target.task));
  }

  private needsSend(target: Target): boolean {
    return Date.now() >= target.retryAt && (target.sentRevision !== target.revision || (!!target.status && Date.now() - target.sentAt >= refreshMs));
  }

  private flush(key: string, target: Target): void {
    if (target.task || !this.needsSend(target)) return;
    target.task = this.write(target).finally(() => {
      target.task = undefined;
      if (!target.active && !target.status && target.sentRevision === target.revision) this.targets.delete(key);
      else this.flush(key, target);
    });
  }

  private async write(target: Target): Promise<void> {
    while (this.needsSend(target)) {
      const { revision, status } = target;
      try {
        await this.send(target.origin, status);
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
