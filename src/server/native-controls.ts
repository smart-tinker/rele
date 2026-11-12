export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
export interface NativeGoal {
  threadId: string; objective: string; status: GoalStatus; tokenBudget: number | null;
  tokensUsed: number; timeUsedSeconds: number; createdAt: number; updatedAt: number;
}
export interface ControlModel { model: string; displayName: string; efforts: string[]; defaultEffort: string }
export interface NativeControlSnapshot {
  model: string | null; effort: string | null; runtimeStatus: string;
  goalSupported: boolean; goal: NativeGoal | null; queued: number;
}
export interface ControlTurn {
  id: string; status: string; startedAt?: number | null;
  items: { type: string; id?: string; text?: string; phase?: string | null; clientId?: string | null; [key: string]: unknown }[];
}
export function nativeGoal(value: unknown, threadId: string): NativeGoal {
  const goal = value as NativeGoal;
  if (!goal || goal.threadId !== threadId || typeof goal.objective !== 'string' || !goal.objective.trim() || [...goal.objective].length > 4000
    || !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(goal.status)
    || goal.tokenBudget !== null && (!Number.isSafeInteger(goal.tokenBudget) || goal.tokenBudget <= 0)
    || [goal.tokensUsed, goal.timeUsedSeconds, goal.createdAt, goal.updatedAt].some(n => !Number.isFinite(n) || n < 0)) throw new Error('Codex вернул неподтверждённое состояние цели.');
  return goal;
}
