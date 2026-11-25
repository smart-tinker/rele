import assert from 'node:assert/strict';
import test from 'node:test';

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('reports only allowlisted operations from a synthetic managed wait RED', () => {
  const python = [
    'import json, sys',
    "sys.path.insert(0, 'scripts')",
    'from managed_probe_report import managed_wait_failure',
    'report = {}',
    "result = {'phase': 'engine.pump', 'failure': 'timeout', 'pendingOperations': ['dispatch.slackSync.drain', 'rpc.thread/inject_items', 'rpc.thread/inject_items', 'synthetic-private-provider-detail', {'private': 'payload'}], 'rejectedOperations': ['rpc.thread/read', 'rpc.thread/read', 'synthetic-private-provider-detail', {'private': 'rejected-payload'}]}",
    'error = managed_wait_failure(result, report)',
    "print(json.dumps({'error': error, 'report': report}, sort_keys=True))",
  ].join('\n');
  const output = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', python], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
  });
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(JSON.parse(output.stdout), {
    error: 'Managed fixture wait timeout during engine.pump',
    report: { pendingOperations: ['dispatch.slackSync.drain', 'rpc.thread/inject_items'], rejectedOperations: ['rpc.thread/read'] },
  });
  assert.doesNotMatch(output.stdout, /synthetic-private-provider-detail|payload/);
});

test('retains a rejected operation label after removing it from the pending snapshot', async () => {
  const { createManagedOperationTrace } = await import('../scripts/managed-probe-wait.mjs');
  const trace = createManagedOperationTrace();
  const error = new Error('synthetic-private-provider-detail');
  await assert.rejects(trace.observe('rpc.thread/read', () => Promise.reject(error)), value => value === error);
  assert.deepEqual(trace.pendingOperations(), []);
  assert.deepEqual(trace.rejectedOperations(), ['rpc.thread/read']);
  assert.doesNotMatch(JSON.stringify(trace.rejectedOperations()), /synthetic-private-provider-detail/);
});
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

test('destroys managed bridge stdin before exit, before fallback cleanup', { timeout: 5000 }, async () => {
  const helperUrl = new URL('../scripts/managed-probe-wait.mjs', import.meta.url).href;
  const bridgeSource = [
    "import { createInterface } from 'node:readline';",
    "import { closeManagedBridgeInput } from " + JSON.stringify(helperUrl) + ";",
    "const input = process.stdin;",
    "const lines = createInterface({ input });",
    "for await (const line of lines) {",
    "  if (line !== 'close') continue;",
    "  process.stdout.write('ACK\\n');",
    "  closeManagedBridgeInput(lines, input);",
    "  process.stdout.write(JSON.stringify({ inputDestroyed: input.destroyed }) + '\\n');",
    "  break;",
    "}",
  ].join('\n');
  const bridge = spawn(process.execPath, ['--input-type=module', '-e', bridgeSource], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  bridge.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  bridge.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  let timer;
  try {
    bridge.stdin.write('close\n');
    const [code, signal] = await Promise.race([
      once(bridge, 'close'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('synthetic bridge did not exit before fallback cleanup')), 1500);
      }),
    ]);
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
    const [ack, result, ...extra] = output.trim().split(/\r?\n/);
    assert.equal(ack, 'ACK');
    assert.deepEqual(JSON.parse(result), { inputDestroyed: true });
    assert.deepEqual(extra, []);
  } finally {
    clearTimeout(timer);
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill();
    bridge.stdin.destroy();
    bridge.stdout.destroy();
    bridge.stderr.destroy();
  }
});

test('closes managed bridge stdin before waiting for child exit', { timeout: 5000 }, () => {
  const python = [
    'import asyncio, json, sys',
    "sys.path.insert(0, 'scripts')",
    'from managed_probe_bridge import wait_for_bridge_exit',
    'async def main():',
    "    child_code = \"import sys; sys.stdin.buffer.readline(); print('ACK', flush=True); sys.stdin.buffer.read()\"",
    "    child = await asyncio.create_subprocess_exec(sys.executable, '-c', child_code, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)",
    "    outcome = 'timeout'",
    '    try:',
    "        child.stdin.write(b'close' + bytes([10]))",
    '        await child.stdin.drain()',
    '        ack = await asyncio.wait_for(child.stdout.readline(), 2)',
    "        assert ack.rstrip(bytes([13, 10])) == b'ACK'",
    '        try:',
    '            await wait_for_bridge_exit(child, 0.2)',
    '        except TimeoutError:',
    '            pass',
    '        else:',
    "            outcome = 'exited'",
    '    finally:',
    '        if child.returncode is None:',
    '            child.stdin.close()',
    '            await asyncio.wait_for(child.wait(), 2)',
    "    print(json.dumps({'outcome': outcome, 'returncode': child.returncode}, sort_keys=True))",
    'asyncio.run(main())',
  ].join('\n');
  const output = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', python], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 3000,
  });
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(JSON.parse(output.stdout), { outcome: 'exited', returncode: 0 });
});
