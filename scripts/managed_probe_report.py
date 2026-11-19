SAFE_PENDING_OPERATIONS = frozenset({
    'pump.deliver',
    'pump.flushProgress',
    'pump.flushApprovalUpdates',
    'pump.retryPendingQuestions',
    'pump.refreshAsyncQuestions',
    'pump.provision',
    'pump.reconcile',
    'pump.dispatch',
    'pump.sourceControls.recover',
    'pump.slackSync.backfill',
    'dispatch.slackSync.drain',
    'dispatch.initialMessages.ensure',
    'dispatch.codex.injectContext',
    'dispatch.codex.subscribe',
    'dispatch.codex.backgroundTerminals',
    'dispatch.codex.enqueue',
    'dispatch.codex.releaseThread',
    'rpc.server/diagnostics',
    'rpc.thread/backgroundTerminals/list',
    'rpc.thread/inject_items',
    'rpc.thread/queue/add',
    'rpc.thread/queue/list',
    'rpc.thread/read',
    'rpc.thread/resume',
    'rpc.thread/turns/list',
    'rpc.thread/unsubscribe',
    'rpc.other',
})
WAIT_PHASES = frozenset({
    'engine.pump', 'engine.settled', 'wait.pause', 'active-requests', 'final-settled', 'final-pump',
})
WAIT_FAILURES = frozenset({'timeout', 'rejected'})


def managed_wait_failure(result, report):
    if not isinstance(result, dict):
        return None
    phase = result.get('phase')
    failure = result.get('failure')
    if not isinstance(phase, str) or phase not in WAIT_PHASES or not isinstance(failure, str) or failure not in WAIT_FAILURES:
        return None
    for field in ('pendingOperations', 'rejectedOperations'):
        operations = result.get(field)
        if isinstance(operations, list):
            report[field] = sorted({
                operation for operation in operations
                if isinstance(operation, str) and operation in SAFE_PENDING_OPERATIONS
            })
    return f'Managed fixture wait {failure} during {phase}'
