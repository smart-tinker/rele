export function summarizeSharedWaitFailure(expectedStatus: string, state: {
 requests: Array<{id: string; eventId: string; status: string; turnId?: string; queuedSubmissionId?: string}>;
 approvals: Array<{id: string; requestId: string; method: string; status: string; turnId: string}>;
 observedTurns: Array<{method: string; turnId: string}>;
 driverOperations: string[];
}): {
 expectedStatus: string;
 requests: Array<{id: string; eventId: string; status: string; turnId?: string; queuedSubmissionId?: string}>;
 approvals: Array<{id: string; requestId: string; method: string; status: string; turnId: string}>;
 observedTurns: Array<{method: string; turnId: string}>;
 driverOperations: string[];
};
