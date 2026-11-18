import assert from 'node:assert/strict';
import test from 'node:test';
import { waitManagedQueue } from '../scripts/managed-probe-wait.mjs';

const never = () => new Promise(() => {});
function withWatchdog(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('test watchdog: wait helper remained pending')), 100);
  })]).finally(() => clearTimeout(timer));
}

test('reports a bounded pump timeout and leaves the active request queued', { timeout: 500 }, async () => {
  const request = { id: 'synthetic-request', status: 'running', origin: 'original' };
  let settledCalls = 0;
  const result = await withWatchdog(waitManagedQueue(() => Number(request.status !== 'completed'), never, async () => { settledCalls++; }, async () => {}, 10));
  assert.deepEqual(result, { ok: false, phase: 'engine.pump', failure: 'timeout' });
  assert.deepEqual(request, { id: 'synthetic-request', status: 'running', origin: 'original' });
  assert.equal(settledCalls, 0);
});

test('reports a bounded final settle timeout after the queue empties', { timeout: 500 }, async () => {
  const result = await withWatchdog(waitManagedQueue(() => 0, async () => {}, never, async () => {}, 10));
  assert.deepEqual(result, { ok: false, phase: 'final-settled', failure: 'timeout' });
});

test('reports a bounded in-loop settle timeout', { timeout: 500 }, async () => {
  const result = await withWatchdog(waitManagedQueue(() => 1, async () => {}, never, async () => {}, 10));
  assert.deepEqual(result, { ok: false, phase: 'engine.settled', failure: 'timeout' });
});

test('reports a bounded final pump timeout after the queue empties', { timeout: 500 }, async () => {
  const result = await withWatchdog(waitManagedQueue(() => 0, never, async () => {}, async () => {}, 10));
  assert.deepEqual(result, { ok: false, phase: 'final-pump', failure: 'timeout' });
});

test('does not report success while a request remains active past the deadline', { timeout: 500 }, async () => {
  const result = await withWatchdog(waitManagedQueue(() => 1, async () => {}, async () => {}, () => new Promise(resolve => setTimeout(resolve, 3)), 10));
  assert.equal(result.ok, false);
});

test('waits through pump, settle and final checks before reporting success', { timeout: 500 }, async () => {
  const order = [];
  const request = { id: 'same-request', status: 'queued', origin: 'original-source' };
  const deliveries = [];
  const result = await waitManagedQueue(() => Number(request.status !== 'completed'), async () => {
    order.push('pump');
    if (request.status === 'queued') request.status = 'running';
  }, async () => {
    order.push('settled');
    if (request.status === 'running') {
      request.status = 'completed';
      deliveries.push({ requestId: request.id, origin: request.origin, status: 'sent' });
    }
  }, async () => { order.push('pause'); }, 250);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(order, ['pump', 'settled', 'pause', 'settled', 'pump']);
  assert.deepEqual(request, { id: 'same-request', status: 'completed', origin: 'original-source' });
  assert.deepEqual(deliveries, [{ requestId: 'same-request', origin: 'original-source', status: 'sent' }]);
});

test('reports an RPC rejection with its active wait phase and no raw error detail', async () => {
  const result = await withWatchdog(waitManagedQueue(() => 1, async () => {
    throw new Error('synthetic-private-provider-detail');
  }, async () => {}, async () => {}, 50));
  assert.deepEqual(result, { ok: false, phase: 'engine.pump', failure: 'rejected' });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-provider-detail/);
});

test('closes the owned Codex and confirms its exit before bounded engine cleanup', async () => {
  const { closeManagedFixture } = await import('../scripts/managed-probe-wait.mjs');
  const sequence = [];
  let childAlive = true;
  const result = await withWatchdog(closeManagedFixture(
    () => { sequence.push('engine.stop'); return new Promise(() => {}); },
    async () => { sequence.push('codex.close'); childAlive = false; },
    () => !childAlive,
    20,
  ));
  assert.deepEqual(sequence, ['engine.stop', 'codex.close']);
  assert.deepEqual(result, { ok: false, phase: 'engine.stop', failure: 'timeout', childExited: true });
});

test('cleanup fails closed when the owned Codex is still alive', async () => {
  const { closeManagedFixture } = await import('../scripts/managed-probe-wait.mjs');
  const result = await closeManagedFixture(async () => {}, async () => {}, () => false, 50);
  assert.deepEqual(result, { ok: false, phase: 'owned-child-exit', failure: 'not-exited', childExited: false });
});
