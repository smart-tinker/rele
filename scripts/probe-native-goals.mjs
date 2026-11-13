/** Disposable native protocol fixture: no account, external provider, Slack, or user profile. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs, promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: { executable: { type: 'string' }, directory: { type: 'string' }, 'expected-version': { type: 'string' } } });
assert(values.executable && values.directory && values['expected-version'], 'Pass an explicit fixture executable, expected version, and fresh directory.');
const directory = resolve(values.directory), home = join(directory, 'home');
await mkdir(directory, { recursive: true, mode: 0o700 });
assert.equal((await readdir(directory)).length, 0, 'Fixture directory must be fresh and empty.');
await mkdir(home, { mode: 0o700 });
const env = { PATH: process.env.PATH, CODEX_HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), RUST_LOG: 'off' };
const { stdout: versionOutput } = await promisify(execFile)(values.executable, ['--version'], { env });
const version = /codex-cli\s+(\S+)/u.exec(versionOutput)?.[1];
assert.equal(version, values['expected-version'], 'Native executable does not match the requested exact contract.');
const schemaDirectory = join(directory, 'schema');
await promisify(execFile)(values.executable, ['app-server', 'generate-ts', '--experimental', '--out', schemaDirectory], { env });
const schemaFiles = ['ClientRequest.ts', 'v2/ThreadGoal.ts', 'v2/ThreadGoalSetParams.ts', 'v2/ThreadGoalUpdatedNotification.ts', 'v2/Turn.ts', 'v2/ThreadTimelineEntry.ts'];
const schemaHashes = Object.fromEntries(await Promise.all(schemaFiles.map(async file => [file, createHash('sha256').update(await readFile(join(schemaDirectory, file))).digest('hex')])));

const requests = [], notifications = [], ordering = [], approvals = [], children = [], held = [];
let phase = 'pause', completing = 0, approving = 0;
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const completed = id => ({ type: 'response.completed', response: { id, usage: { input_tokens: 17, input_tokens_details: null, output_tokens: 3, output_tokens_details: null, total_tokens: 20 } } });
const message = (id, text) => ({ type: 'response.output_item.done', item: { id, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const response = (res, events) => { if (res.destroyed) return; res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' }); res.end(sse(events)); };
const provider = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const nativeTurnId = notifications.findLast(event => event.method === 'turn/started')?.params.turn.id;
  requests.push({ path: req.url, phase, nativeTurnId, goalNotificationSeenBeforeResponse: notifications.some(event => event.method === 'thread/goal/updated' && event.params.turnId === nativeTurnId),
    model: body.model, hasGoalContext: JSON.stringify(body.input).includes('<goal_context>'),
    toolNames: (body.tools ?? []).map(tool => tool.name).filter(Boolean) });
  if (phase === 'approval') {
    if (++approving === 1) response(res, [
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'fixture-declined-command', name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'printf fixture', sandbox_permissions: 'require_escalated', justification: 'Synthetic fixture: decline this command; do not execute it.' }) } }, completed('approval-response'),
    ]);
    else if (approving === 2) response(res, [
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'fixture-complete-approved-goal', name: 'update_goal', arguments: '{"status":"complete"}' } }, completed('approval-complete-response'),
    ]);
    else response(res, [message('approval-final', 'Fixture declined command and completed Goal.'), completed('approval-final-response')]);
  } else if (phase === 'pause') held.push(res);
  else if (++completing === 1) response(res, [message('unpaused-stage', 'Fixture resumed public stage.'), completed('stage-response')]);
  else if (completing === 2) response(res, [
    { type: 'response.created', response: { id: 'complete-tool-response' } },
    { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'fixture-complete-goal', name: 'update_goal', arguments: '{"status":"complete"}' } },
    completed('complete-tool-response'),
  ]);
  else response(res, [message(`final-${completing}`, 'Fixture goal complete.'), completed(`final-response-${completing}`)]);
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const port = provider.address().port;
await writeFile(join(home, 'config.toml'), `model_provider = "fixture"\nmodel = "fixture-model"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n[features]\ngoals = true\n[model_providers.fixture]\nname = "Loopback fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`, { mode: 0o600 });

let step = 'start';
async function until(predicate, label, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Native fixture timed out at ${label}`); await delay(20); }
}
function start() {
  const child = spawn(values.executable, ['app-server', '--listen', 'stdio://'], { env, cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
  const pending = new Map(); let sequence = 0, stderr = '';
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-12_000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let packet; try { packet = JSON.parse(line); } catch { return; }
    if (packet.method) {
      if (packet.id === undefined) {
        notifications.push(packet);
        if (['thread/goal/updated', 'turn/started', 'item/started', 'item/completed', 'turn/completed'].includes(packet.method)) ordering.push({
          method: packet.method, phase, turnId: packet.params.turnId ?? packet.params.turn?.id ?? null, goalStatus: packet.params.goal?.status ?? null,
          itemType: packet.params.item?.type ?? null, providerRequests: requests.length,
        });
      }
      else if (packet.method === 'item/commandExecution/requestApproval') {
        const approval = { method: packet.method, turnId: packet.params.turnId,
          goalAttributionBeforeRequest: notifications.some(event => event.method === 'thread/goal/updated' && event.params.turnId === packet.params.turnId), declined: false };
        approvals.push(approval);
        setTimeout(() => {
          approval.goalAttributionBeforeDecline = notifications.some(event => event.method === 'thread/goal/updated' && event.params.turnId === packet.params.turnId);
          approval.declined = true;
          child.stdin.write(JSON.stringify({ id: packet.id, result: { decision: 'decline' } }) + '\n');
        }, 300);
      } else child.stdin.write(JSON.stringify({ id: packet.id, error: { code: -32601, message: 'Fixture does not authorize tools.' } }) + '\n');
      return;
    }
    const waiter = pending.get(packet.id); if (!waiter) return;
    pending.delete(packet.id); clearTimeout(waiter.timer);
    if (packet.error) waiter.reject(new Error(`${packet.error.code}: ${packet.error.message}`)); else waiter.resolve(packet.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native fixture RPC timed out: ${method}`)); }, 12_000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  child.on('close', () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Native fixture child exited.')); } pending.clear(); });
  return { child, call, async initialize() {
    const result = await call('initialize', { clientInfo: { name: 'rele_native_goal_fixture', title: 'Isolated Rele Goal fixture', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n'); return result;
  }, async stop() {
    lines.close(); child.stdin.end();
    await Promise.race([once(child, 'close'), delay(1500)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'close'); }
    await writeFile(join(directory, `native-${children.indexOf(child)}-stderr.log`), stderr, { mode: 0o600 });
  } };
}

let native;
try {
  native = start(); await native.initialize();
  step = 'thread/start';
  const created = await native.call('thread/start', { cwd: directory, model: 'fixture-model' });
  const threadId = created.thread.id;
  step = 'goal/set';
  const set = await native.call('thread/goal/set', { threadId, origin: 'user', objective: 'Complete the isolated fixture Goal.', tokenBudget: 5000 });
  assert.equal(set.goal.status, 'active');
  const read = await native.call('thread/goal/get', { threadId }); assert.deepEqual(read.goal, set.goal);
  await until(() => requests.length >= 1, 'first autonomous provider request');
  const started = notifications.find(event => event.method === 'turn/started' && event.params.threadId === threadId)?.params.turn.id;
  assert(started, 'Native Goal did not start an autonomous turn.');
  step = 'goal/pause';
  const paused = await native.call('thread/goal/set', { threadId, origin: 'user', status: 'paused' }); assert.equal(paused.goal.status, 'paused');
  await delay(150);
  const pausedCompletion = notifications.find(event => event.method === 'turn/completed' && event.params.turn.id === started);
  const activeTurnInterruptedByPause = pausedCompletion?.params.turn.status === 'interrupted';
  for (const res of held.splice(0)) response(res, [message('paused-stage', 'Fixture stage while paused.'), completed('paused-response')]);
  await until(() => notifications.some(event => event.method === 'turn/completed' && event.params.turn.id === started), 'paused turn completion');
  const afterPauseRequests = requests.length; await delay(200); assert.equal(requests.length, afterPauseRequests, 'Paused Goal continued automatically.');
  const persisted = (await native.call('thread/goal/get', { threadId })).goal; assert.equal(persisted.status, 'paused');
  step = 'restart';
  await native.stop(); native = start(); await native.initialize();
  await native.call('thread/resume', { threadId, excludeTurns: true });
  const resumed = (await native.call('thread/goal/get', { threadId })).goal;
  assert.equal(resumed.objective, set.goal.objective); assert.equal(resumed.createdAt, set.goal.createdAt); assert.equal(resumed.status, 'paused');
  const beforeRestartRequests = requests.length; await delay(200); assert.equal(requests.length, beforeRestartRequests, 'Paused resume started a model request.');
  step = 'goal/resume-and-complete'; phase = 'complete';
  await native.call('thread/goal/set', { threadId, origin: 'user', status: 'active' });
  await until(() => notifications.some(event => event.method === 'thread/goal/updated' && event.params.goal?.status === 'complete'), 'native Goal complete');
  await until(() => notifications.filter(event => event.method === 'turn/completed' && event.params.threadId === threadId).length >= 3, 'completion turn');
  const goal = (await native.call('thread/goal/get', { threadId })).goal; assert.equal(goal.status, 'complete');
  const page = await native.call('thread/turns/list', { threadId, limit: 100, itemsView: 'full', sortDirection: 'asc' });
  const turns = page.data.map(turn => ({ id: turn.id, rootTurnId: turn.rootTurnId, status: turn.status,
    fields: Object.keys(turn), itemTypes: turn.items.map(item => item.type), goalField: Object.keys(turn).some(field => /goal/iu.test(field)) }));
  const goalEvents = notifications.filter(event => event.method === 'thread/goal/updated' && event.params.threadId === threadId && typeof event.params.turnId === 'string');
  step = 'first-Goal-command-approval'; phase = 'approval';
  const approvalThread = (await native.call('thread/start', { cwd: directory, model: 'fixture-model', approvalPolicy: 'on-request' })).thread.id;
  await native.call('thread/goal/set', { threadId: approvalThread, origin: 'user', objective: 'Exercise a declined synthetic command approval.', tokenBudget: 5000 });
  await until(() => approvals.length > 0, 'first native command approval');
  await until(() => notifications.some(event => event.method === 'turn/completed' && event.params.threadId === approvalThread), 'approval Goal completion');
  const approvalPage = await native.call('thread/turns/list', { threadId: approvalThread, limit: 100, itemsView: 'full', sortDirection: 'asc' });
  const commandItems = notifications.filter(event => event.method === 'item/completed' && event.params.threadId === approvalThread
    && event.params.item?.type === 'commandExecution').map(event => event.params.item);
  const commandReceipts = commandItems.map(item => ({ status: item.status, exitCode: item.exitCode, processId: item.processId ?? null,
    rejectedByUser: /rejected by user/iu.test(item.aggregatedOutput ?? '') }));
  const noCommandExecution = commandReceipts.length > 0 && commandReceipts.every(item => item.status === 'declined' && item.processId === null);
  const unpausedStage = requests.find(request => request.phase === 'complete');
  const unpausedStageAccounted = goalEvents.some(event => event.params.turnId === unpausedStage?.nativeTurnId);
  const result = { version, schemaRecorded: true, schemaHashes, isolatedHome: true, provider: 'loopback-fixture', paidInferenceRequests: 0, goalCreated: true, goalReadBack: true, ordinaryTurnsSubmitted: 0,
    pause: { persisted: true, noFurtherContinuation: true, activeTurnInterruptedByPause },
    restart: { sameGoal: true, remainsPaused: true, didNotRunModel: true }, completion: { nativeComplete: true, finalTurnCompleted: true, unpausedStageAccounted },
    approval: { requested: approvals.length > 0, declined: approvals.every(row => row.declined), goalAttributionBeforeRequest: approvals[0]?.goalAttributionBeforeRequest,
      goalAttributionBeforeDecline: approvals[0]?.goalAttributionBeforeDecline,
      noCommandExecution, commandReceipts, persistedCommandItems: approvalPage.data.flatMap(turn => turn.items).filter(item => item.type === 'commandExecution').length },
    goalTurnNotifications: goalEvents.length, notifiedTurnIds: [...new Set(goalEvents.map(event => event.params.turnId))], turns,
    requests: requests.map(({ toolNames, ...request }) => ({ ...request, hasUpdateGoalTool: toolNames.includes('update_goal') })),
    eventMethods: [...new Set(notifications.map(event => event.method))], ordering, finalGoalStatus: goal.status };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  throw new Error(`${step}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
} finally {
  if (native) await native.stop();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  for (const res of held) res.destroy();
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}
