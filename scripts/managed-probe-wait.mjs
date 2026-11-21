import { performance } from 'node:perf_hooks';

async function within(deadline, phase, operation) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return { ok: false, phase, failure: 'timeout' };
  let timer;
  let outcome;
  try {
    await Promise.race([
      Promise.resolve().then(operation).then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; }),
      new Promise(resolve => { timer = setTimeout(() => { outcome = 'timeout'; resolve(); }, remaining); }),
    ]);
    if (outcome === 'timeout' || performance.now() >= deadline) return { ok: false, phase, failure: 'timeout' };
    return outcome === 'rejected' ? { ok: false, phase, failure: 'rejected' } : { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

export async function waitManagedQueue(activeCount, pump, settled, pause, timeoutMs = 40_000) {
  const deadline = performance.now() + timeoutMs;
  while (activeCount() && performance.now() < deadline) {
    let result = await within(deadline, 'engine.pump', pump);
    if (!result.ok) return result;
    result = await within(deadline, 'engine.settled', settled);
    if (!result.ok) return result;
    result = await within(deadline, 'wait.pause', pause);
    if (!result.ok) return result;
  }
  if (activeCount()) return { ok: false, phase: 'active-requests', failure: 'timeout' };
  let result = await within(deadline, 'final-settled', settled);
  if (!result.ok) return result;
  result = await within(deadline, 'final-pump', pump);
  if (!result.ok) return result;
  return { ok: true };
}

export async function closeManagedFixture(stopEngine, closeCodex, ownedChildExited, timeoutMs = 25_000) {
  const deadline = performance.now() + timeoutMs;
  let engineRejected = false;
  const stopping = Promise.resolve().then(stopEngine).then(() => {}, () => { engineRejected = true; });
  const exited = () => { try { return ownedChildExited() === true; } catch { return false; } };
  const closed = await within(deadline, 'codex.close', closeCodex);
  if (!closed.ok) return { ...closed, childExited: exited() };
  if (!exited()) return { ok: false, phase: 'owned-child-exit', failure: 'not-exited', childExited: false };
  const stopped = await within(deadline, 'engine.stop', () => stopping);
  if (!stopped.ok) return { ...stopped, childExited: true };
  if (engineRejected) return { ok: false, phase: 'engine.stop', failure: 'rejected', childExited: true };
  return { ok: true, childExited: true };
}

export function createManagedOperationTrace() {
  const pending = new Map();
  const rejected = new Set();
  let next = 0;
  return {
    observe(label, operation) {
      const id = ++next;
      pending.set(id, label);
      let result;
      try {
        result = operation();
      } catch (error) {
        rejected.add(label);
        pending.delete(id);
        throw error;
      }
      return Promise.resolve(result)
        .catch(error => { rejected.add(label); throw error; })
        .finally(() => pending.delete(id));
    },
    pendingOperations() { return [...new Set(pending.values())].sort(); },
    rejectedOperations() { return [...rejected].sort(); },
    clearRejected() { rejected.clear(); },
  };
}

export function closeManagedBridgeInput(lines, input) {
  lines.close();
  input.destroy();
}
