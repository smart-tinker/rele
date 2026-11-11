export function summarizeSharedWaitFailure(expectedStatus, state) {
 return {
  expectedStatus,
  requests: state.requests.slice(-8).map(({id,eventId,status,turnId,queuedSubmissionId})=>({id,eventId,status,turnId,queuedSubmissionId})),
  approvals: state.approvals.slice(-8).map(({id,requestId,method,status,turnId})=>({id,requestId,method,status,turnId})),
  observedTurns: state.observedTurns.slice(-8).map(({method,turnId})=>({method,turnId})),
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
