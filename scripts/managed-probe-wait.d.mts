export type ManagedWaitPhase =
  | 'engine.pump'
  | 'engine.settled'
  | 'active-requests'
  | 'final-settled'
  | 'final-pump';

export type ManagedWaitResult = { ok: true } | { ok: false; phase: ManagedWaitPhase };

export function waitManagedQueue(
  activeCount: () => number,
  pump: () => Promise<unknown>,
  settled: () => Promise<unknown>,
  pause: () => Promise<unknown>,
  timeoutMs?: number,
): Promise<ManagedWaitResult>;
