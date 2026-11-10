export function summarizeSharedWaitFailure(expectedStatus, state) {
 return {
  expectedStatus,
  requests: state.requests.slice(-8).map(({id,eventId,status,turnId,queuedSubmissionId})=>({id,eventId,status,turnId,queuedSubmissionId})),
  approvals: state.approvals.slice(-8).map(({id,requestId,method,status,turnId})=>({id,requestId,method,status,turnId})),
  observedTurns: state.observedTurns.slice(-8).map(({method,turnId})=>({method,turnId})),
  driverOperations: state.driverOperations.slice(-40),
 };
}
