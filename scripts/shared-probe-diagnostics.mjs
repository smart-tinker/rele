export function summarizeSharedWaitFailure(expectedStatus, state) {
 return {
  expectedStatus,
  requests: state.requests.slice(-8).map(({id,eventId,status,turnId,queuedSubmissionId})=>({id,eventId,status,turnId,queuedSubmissionId})),
  approvals: state.approvals.slice(-8).map(({id,requestId,method,status,turnId})=>({id,requestId,method,status,turnId})),
  observedTurns: state.observedTurns.slice(-8).map(({method,turnId})=>({method,turnId})),
  protocolEvents: (state.observedProtocolEvents ?? []).slice(-24).map(event=>({
   kind: ['request','notification'].includes(event.kind) ? event.kind : 'other',
   method: typeof event.method === 'string' && /^[A-Za-z0-9._/-]{1,100}$/u.test(event.method) ? event.method : 'other',
   hasThreadId: event.hasThreadId === true,
   hasTurnId: event.hasTurnId === true,
   hasRequestId: event.hasRequestId === true,
   hasItemId: event.hasItemId === true,
   hasApprovalId: event.hasApprovalId === true,
  })),
  completionObservations: (state.completionObservations ?? []).slice(-32).map(event=>({
   eventId: typeof event.eventId === 'string' && /^[A-Za-z0-9_-]{1,48}$/u.test(event.eventId) ? event.eventId : 'other',
   status: ['queued','transcribing','starting','running','waiting_approval','completed','failed','interrupted','cancelled','uncertain'].includes(event.status) ? event.status : 'other',
   turnMatches: event.turnMatches === true,
  })),
  reconciliationTrace: (state.reconciliationTrace ?? []).slice(-48).map(event=>({
   eventId: typeof event.eventId === 'string' && /^[A-Za-z0-9_-]{1,48}$/u.test(event.eventId) ? event.eventId : 'other',
   phase: ['start','done','error'].includes(event.phase) ? event.phase : 'other',
   status: typeof event.status === 'string' && /^[A-Za-z_]{1,32}$/u.test(event.status) ? event.status : 'other',
   completionNotification: event.completionNotification === true,
   turnProvided: event.turnProvided === true,
   ...(Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0 ? { elapsedMs: event.elapsedMs } : {}),
   ...(typeof event.errorType === 'string' && /^[A-Za-z]{1,48}$/u.test(event.errorType) ? { errorType: event.errorType } : {}),
  })),
  rpcTrace: (state.rpcTrace ?? []).slice(-64).map(event=>({
   attempt: Number.isSafeInteger(event.attempt) && event.attempt >= 0 ? event.attempt : 0,
   method: typeof event.method === 'string' && /^[A-Za-z0-9._/-]{1,100}$/u.test(event.method) ? event.method : 'other',
   phase: ['start','done','error'].includes(event.phase) ? event.phase : 'other',
   ...(Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0 ? { elapsedMs: event.elapsedMs } : {}),
   ...(typeof event.errorType === 'string' && /^[A-Za-z]{1,48}$/u.test(event.errorType) ? { errorType: event.errorType } : {}),
  })),
  serverRequestTrace: (state.serverRequestTrace ?? []).slice(-8).map(event=>({
   method: typeof event.method === 'string' && /^[A-Za-z0-9._/-]{1,100}$/u.test(event.method) ? event.method : 'other',
   pendingAtEntry: event.pendingAtEntry === true,
   activeRequests: Number.isSafeInteger(event.activeRequests) && event.activeRequests >= 0 ? event.activeRequests : 0,
   threadMatches: Number.isSafeInteger(event.threadMatches) && event.threadMatches >= 0 ? event.threadMatches : 0,
   exactMatches: Number.isSafeInteger(event.exactMatches) && event.exactMatches >= 0 ? event.exactMatches : 0,
   ...(typeof event.historyState === 'string' && ['queued','running','completed','failed','interrupted','not_found'].includes(event.historyState) ? { historyState: event.historyState } : {}),
   ...(typeof event.historyTurnMatches === 'boolean' ? { historyTurnMatches: event.historyTurnMatches } : {}),
   ...(typeof event.historyMixed === 'boolean' ? { historyMixed: event.historyMixed } : {}),
   pendingAtExit: event.pendingAtExit === true,
   ...(typeof event.statusAfter === 'string' && ['queued','transcribing','starting','running','waiting_approval','completed','failed','interrupted','cancelled','uncertain','missing'].includes(event.statusAfter) ? { statusAfter: event.statusAfter } : {}),
   approvalsAdded: Number.isSafeInteger(event.approvalsAdded) && event.approvalsAdded >= 0 ? event.approvalsAdded : 0,
   ...(typeof event.errorType === 'string' && /^[A-Za-z]{1,48}$/u.test(event.errorType) ? { errorType: event.errorType } : {}),
  })),
  driverOperations: state.driverOperations.slice(-40),
 };
}
export function summarizeSharedNativeRequest(location) {
 const state = location?.state;
 return {
  state: ['queued','running','completed','failed','interrupted','not_found'].includes(state) ? state : 'unknown',
  turnAssigned: typeof location?.turnId === 'string' && location.turnId.length > 0,
  queuedSubmissionFound: typeof location?.queuedSubmissionId === 'string' && location.queuedSubmissionId.length > 0,
  mixed: location?.mixed === true,
  finalAnswerPresent: typeof location?.text === 'string' && location.text.trim().length > 0 && location.text !== 'NOREPLY',
 };
}
