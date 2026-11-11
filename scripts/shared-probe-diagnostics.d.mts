export function summarizeSharedWaitFailure(expectedStatus: string, state: {
 requests: Array<{id: string; eventId: string; status: string; turnId?: string; queuedSubmissionId?: string}>;
 approvals: Array<{id: string; requestId: string; method: string; status: string; turnId: string}>;
 observedTurns: Array<{method: string; turnId: string}>;
 serverRequestTrace?: Array<{
  method: string; pendingAtEntry: boolean; activeRequests: number; threadMatches: number; exactMatches: number;
  historyState?: string; historyTurnMatches?: boolean; historyMixed?: boolean; pendingAtExit: boolean;
  statusAfter?: string; approvalsAdded: number; errorType?: string;
 }>;
 reconciliationStageTrace?: Array<{ operation?: string; phase?: string; elapsedMs?: number; resultState?: string; errorType?: string }>;
 driverOperations: string[];
}): {
 expectedStatus: string;
 requests: Array<{id: string; eventId: string; status: string; turnId?: string; queuedSubmissionId?: string}>;
 approvals: Array<{id: string; requestId: string; method: string; status: string; turnId: string}>;
 observedTurns: Array<{method: string; turnId: string}>;
 serverRequestTrace: Array<{
  method: string; pendingAtEntry: boolean; activeRequests: number; threadMatches: number; exactMatches: number;
  historyState?: string; historyTurnMatches?: boolean; historyMixed?: boolean; pendingAtExit: boolean;
  statusAfter?: string; approvalsAdded: number; errorType?: string;
 }>;
 reconciliationStageTrace: Array<{
  operation: 'releaseWait' | 'subscribe' | 'releaseThread' | 'findCompletionHistory' | 'findOwnRequest' | 'other';
  phase: 'start' | 'done' | 'error' | 'other'; elapsedMs?: number;
  resultState?: 'queued' | 'starting' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'uncertain' | 'not_found' | 'unknown';
  errorType?: string;
 }>;
 driverOperations: string[];
};
export function summarizeSharedNativeRequest(location: {
 state?: string;
 turnId?: string;
 queuedSubmissionId?: string;
 mixed?: boolean;
 text?: string;
} | undefined): {
 state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'not_found' | 'unknown';
 turnAssigned: boolean;
 queuedSubmissionFound: boolean;
 mixed: boolean;
 finalAnswerPresent: boolean;
};
