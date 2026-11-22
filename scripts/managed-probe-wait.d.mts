export type ManagedWaitPhase =
  | 'engine.pump'
  | 'engine.settled'
  | 'wait.pause'
  | 'active-requests'
  | 'final-settled'
  | 'final-pump';

export type ManagedClosePhase = 'codex.close' | 'owned-child-exit' | 'engine.stop';
export type ManagedFailure = 'timeout' | 'rejected';
export type ManagedWaitResult = { ok: true } | { ok: false; phase: ManagedWaitPhase; failure: ManagedFailure };
export type ManagedCloseResult = { ok: true; childExited: true } | {
  ok: false;
  phase: ManagedClosePhase;
  failure: ManagedFailure | 'not-exited';
  childExited: boolean;
};

export interface ManagedOperationTrace {
  observe<T>(label: string, operation: () => Promise<T>): Promise<T>;
  pendingOperations(): string[];
  rejectedOperations(): string[];
  clearRejected(): void;
}

export function createManagedOperationTrace(): ManagedOperationTrace;

export function waitManagedQueue(
  activeCount: () => number,
  pump: () => Promise<unknown>,
  settled: () => Promise<unknown>,
  pause: () => Promise<unknown>,
  timeoutMs?: number,
): Promise<ManagedWaitResult>;

export function closeManagedFixture(
  stopEngine: () => Promise<unknown>,
  closeCodex: () => Promise<unknown>,
  ownedChildExited: () => boolean,
  timeoutMs?: number,
): Promise<ManagedCloseResult>;

export function closeManagedBridgeInput(
  lines: { close(): void },
  input: { destroy(): unknown },
): void;
