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
