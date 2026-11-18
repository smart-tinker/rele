import { performance } from 'node:perf_hooks';

async function within(deadline, phase, operation) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return { ok: false, phase };
  let timer;
  let expired = false;
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve(); }, remaining); }),
    ]);
    return expired || performance.now() >= deadline ? { ok: false, phase } : { ok: true };
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
    await pause();
  }
  if (activeCount()) return { ok: false, phase: 'active-requests' };
  let result = await within(deadline, 'final-settled', settled);
  if (!result.ok) return result;
  result = await within(deadline, 'final-pump', pump);
  if (!result.ok) return result;
  return { ok: true };
}
