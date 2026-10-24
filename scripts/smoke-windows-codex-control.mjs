import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { removeInstallerFixture, stopInstallerCodex } from './installer-codex-fixture.mjs';

if (process.platform !== 'win32' || process.env.CI !== 'true') throw new Error('Use only an isolated Windows fixture.');
assert.ok(process.env.RELE_TEST_CODEX_EXE && path.isAbsolute(process.env.RELE_TEST_CODEX_EXE), 'Provide the installed Desktop native executable.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.resolve(process.env.RELE_TEST_RELE_STAGE || root);
let WebSocket;
for (const base of [stage, root, path.dirname(path.dirname(process.execPath))]) {
  try { WebSocket = createRequire(path.join(base, 'package.json'))('ws'); break; } catch {}
}
assert.ok(WebSocket, 'The public Rele ws dependency was not found.');
const temporary = await mkdtemp(path.join(tmpdir(), 'Rele control primitive '));
const application = path.join(temporary, 'Приложение Rele');
const data = path.join(temporary, 'Данные Rele');
const home = path.join(temporary, 'Профиль Codex');
const task = `Rele-ControlFixture-${randomUUID()}`;
const executable = await realpath(process.env.RELE_TEST_CODEX_EXE);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const nativeHash = digest(await readFile(executable));
const env = { ...process.env };
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_HOME', 'CODEX_CLI_PATH',
  'CODEX_APP_SERVER_FORCE_CLI', 'CODEX_APP_SERVER_WS_URL', 'RELE_DESKTOP_CLI']) delete env[key];
const target = { executable, codexHome: home, installSettingsPath: path.join(application, 'rele-install.json') };
let socket;
let foreign;
let result;
let failure;
let cleanupConfirmed = false;
function run(command, args, extra = {}) {
  const output = spawnSync(command, args, { env, windowsHide: true, encoding: 'utf8', timeout: 25_000, maxBuffer: 65536, ...extra });
  if (output.error) throw output.error;
  return output;
}
function powershell(code, extra = {}) {
  const output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${code}`], extra);
  assert.equal(output.status, 0, output.stderr || output.stdout);
  return output.stdout.trim();
}
const samePath = (first, second) => path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase();
async function exited(pid) {
  for (let count = 0; count < 100; count++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(100);
  }
  throw new Error('An owned fixture process survived cleanup.');
}
async function readOwnedState(sid, helperHash) {
  const settings = JSON.parse(await readFile(target.installSettingsPath, 'utf8'));
  assert.equal(settings.OwnerSid, sid); assert.equal(settings.TaskName, task);
  assert.ok(samePath(settings.DataDirectory, data));
  if (!settings.CodexWebSocketOwnerDirectory) return;
  const directory = settings.CodexWebSocketOwnerDirectory;
  assert.ok(samePath(path.dirname(directory), path.join(data, 'codex-websocket-owners')));
  assert.match(path.basename(directory), /^[a-f0-9]{64}$/u);
  assert.equal(settings.CodexWebSocketTaskName, `${task}-Codex`);
  const bytes = await readFile(path.join(directory, 'owner.json'));
  assert.equal(digest(bytes), path.basename(directory));
  const marker = JSON.parse(bytes);
  assert.equal(marker.Version, 1); assert.equal(marker.OwnerSid, sid);
  assert.equal(marker.TaskName, `${task}-Codex`);
  assert.equal(marker.Endpoint, settings.CodexWebSocketEndpoint);
  assert.ok(samePath(marker.CodexHome, home)); assert.ok(samePath(marker.Executable, executable));
  assert.equal(marker.ExecutableSha256, nativeHash);
  assert.equal(marker.HostSha256, helperHash);
  assert.equal(digest(await readFile(path.join(directory, 'Rele.Process.exe'))), helperHash);
  target.desktopOwner = { directory, taskName: marker.TaskName, ownerSid: sid };
}
async function connect(endpoint) {
  socket = new WebSocket(endpoint, { handshakeTimeout: 5000, followRedirects: false, maxPayload: 2 * 1024 * 1024 });
  const pending = new Map();
  let sequence = 0;
  socket.on('error', () => {});
  socket.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString('utf8')); }
    catch {
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Malformed native fixture message.')); }
      pending.clear(); socket.terminate(); return;
    }
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    if (message.error) call.reject(new Error('Native fixture RPC failed.')); else call.resolve(message.result);
  });
  socket.on('close', () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Native fixture disconnected.')); } pending.clear(); });
  await once(socket, 'open');
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native fixture RPC timed out.')); }, 5000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }), error => {
      if (error && pending.delete(id)) { clearTimeout(timer); reject(error); }
    });
  });
}
let sid;
let helperHash;
try {
  sid = powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  assert.equal(powershell("(@(Get-ScheduledTask -TaskName $env:RELE_CONTROL_TASK -ErrorAction SilentlyContinue)).Count",
    { env: { ...env, RELE_CONTROL_TASK: `${task}-Codex` } }), '0', 'The random fixture Task must not already exist.');
  await mkdir(path.join(application, 'dist/native'), { recursive: true });
  await mkdir(data);
  await assert.rejects(access(home), { code: 'ENOENT' });
  await copyFile(path.join(stage, 'Rele.exe'), path.join(application, 'Rele.exe'));
  await copyFile(path.join(stage, 'dist/native/Rele.Process.exe'), path.join(application, 'dist/native/Rele.Process.exe'));
  helperHash = digest(await readFile(path.join(application, 'dist/native/Rele.Process.exe')));
  await writeFile(target.installSettingsPath, JSON.stringify({ DataDirectory: data, TaskName: task,
    Port: 0, OwnerSid: sid, CodexHome: home, DesktopIntegrationOwned: false, DesktopIntegrationRequested: false }));
  let starts = 0;
  let nativeStartCalls = 0;
  const controlCommand = async command => {
    if (command === 'codex-start') nativeStartCalls++;
    const errorFile = path.join(data, `control-error-${++starts}.txt`);
    const output = run(path.join(application, 'Rele.exe'), [command, '--quiet', ...(command === 'codex-start' ? ['--codex-executable', executable] : []),
      '--codex-home', home, '--error-file', errorFile]);
    if (output.status !== 0) output.errorReceipt = await readFile(errorFile, 'utf8').catch(() => '');
    return output;
  };
  const start = () => controlCommand('codex-start');
  const status = () => controlCommand('codex-status');
  const initialSettings = await readFile(target.installSettingsPath);
  const missing = await status(); assert.equal(missing.status, 0, missing.errorReceipt || missing.stderr);
  assert.deepEqual(JSON.parse(missing.stdout), { status: 'notRunning' });
  assert.deepEqual(await readFile(target.installSettingsPath), initialSettings);
  assert.deepEqual(await readdir(data), []);
  await assert.rejects(access(home), { code: 'ENOENT' });
  const first = await start();
  assert.equal(first.status, 0, first.errorReceipt || first.stderr);
  const control = JSON.parse(first.stdout);
  assert.equal(control.status, 'started');
  assert.match(control.endpoint, /^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u);
  assert.ok(new URL(control.endpoint).port <= 65535);
  assert.ok(samePath(control.codexHome, await realpath(home)), 'UTF-8 original profile must round-trip.');
  assert.ok(samePath(control.executable, executable)); assert.equal(control.executableSha256, nativeHash);
  assert.equal(control.ownerSid, sid); assert.equal(control.taskName, `${task}-Codex`);
  assert.ok(Number.isSafeInteger(control.processId) && control.processId > 0);
  assert.ok(Number.isFinite(Date.parse(control.processStartTime)));
  await readOwnedState(sid, helperHash);
  assert.ok(samePath(control.ownerDirectory, target.desktopOwner.directory));
  const currentPointer = path.join(data, 'codex-websocket-owners/current.json');
  const beforeStatus = await Promise.all([readFile(target.installSettingsPath), readFile(currentPointer)]);
  const taskSnapshot = () => powershell(`$scheduler=New-Object -ComObject 'Schedule.Service'; $scheduler.Connect();
    $task=$scheduler.GetFolder('\\').GetTask($env:RELE_CONTROL_TASK);
    $hash=[Security.Cryptography.SHA256]::Create();
    try { $xmlHash=[BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$task.Xml))) } finally { $hash.Dispose() }
    $xmlHash + '|' + $task.LastRunTime.ToUniversalTime().ToString('o')`, { env: { ...env, RELE_CONTROL_TASK: `${task}-Codex` } });
  const beforeTask = taskSnapshot();
  const live = await status(); assert.equal(live.status, 0, live.errorReceipt || live.stderr);
  const liveControl = JSON.parse(live.stdout);
  assert.equal(liveControl.status, 'alreadyRunning');
  for (const key of ['endpoint', 'processId', 'processStartTime', 'ownerDirectory']) assert.equal(liveControl[key], control[key]);
  assert.deepEqual(await Promise.all([readFile(target.installSettingsPath), readFile(currentPointer)]), beforeStatus);
  assert.equal(taskSnapshot(), beforeTask);
  process.kill(control.processId, 0);
  const listeners = JSON.parse(powershell(`$rows=@(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $env:RELE_CONTROL_PORT);
    if ($rows.Count -ne 1) { throw 'Native listener is not unique.' }
    [pscustomobject]@{ pid=[int]$rows[0].OwningProcess } | ConvertTo-Json -Compress`,
    { env: { ...env, RELE_CONTROL_PORT: new URL(control.endpoint).port } }));
  assert.equal(listeners.pid, control.processId, 'The kernel listener must belong to the receipt PID.');
  const call = await connect(control.endpoint);
  const initialized = await call('initialize', { clientInfo: { name: 'rele_control_fixture', version: '1' }, capabilities: { experimentalApi: true } });
  socket.send('{"method":"initialized"}');
  assert.ok(samePath(initialized.codexHome, await realpath(home)));
  assert.equal((await call('server/diagnostics')).process.id, control.processId);
  const repeated = await start(); assert.equal(repeated.status, 0, repeated.errorReceipt || repeated.stderr);
  const second = JSON.parse(repeated.stdout);
  assert.equal(second.status, 'alreadyRunning');
  for (const key of ['endpoint', 'processId', 'processStartTime', 'ownerDirectory']) assert.equal(second[key], control[key]);
  assert.equal((await call('server/diagnostics')).process.id, control.processId);
  const closed = once(socket, 'close'); socket.close(); await closed; socket = undefined;
  const recoveryStartCalls = nativeStartCalls;
  const fresh = await status(); assert.equal(fresh.status, 0, fresh.errorReceipt || fresh.stderr);
  const beforeRecovery = JSON.parse(fresh.stdout);
  assert.equal(beforeRecovery.processId, control.processId);
  await readOwnedState(sid, helperHash);
  const recoveryReceiptHash = digest(await readFile(path.join(target.desktopOwner.directory, 'receipt.json')));
  const recoveryStartedAt = Date.now();
  const killed = JSON.parse(powershell(`$expected=$env:RELE_CONTROL_PROCESS | ConvertFrom-Json;
    $bytes=[IO.File]::ReadAllBytes((Join-Path $expected.ownerDirectory 'receipt.json'));
    $hash=[Security.Cryptography.SHA256]::Create();
    try { $receiptHash=[BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
    if ($receiptHash -ne $expected.receiptSha256) { throw 'Recovery receipt changed: rawSha256.' }
    $receipt=[Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json;
    function UtcBirthTicks([object]$value) {
      if ($value -is [datetime]) { return $value.ToUniversalTime().Ticks }
      return [DateTime]::Parse([string]$value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime().Ticks;
    }
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    if ($receipt.ownerSid -ne $sid -or $expected.ownerSid -ne $sid) { throw 'Recovery receipt changed: ownerSid.' }
    if ([int]$receipt.nativePid -ne [int]$expected.processId) { throw 'Recovery receipt changed: nativePid.' }
    if ((UtcBirthTicks $receipt.nativeStartedAt) -ne (UtcBirthTicks $expected.processStartTime)) { throw 'Recovery receipt changed: nativeStartedAt.' }
    if ($receipt.executable -ne $expected.executable) { throw 'Recovery receipt changed: executable.' }
    if ($receipt.executableSha256 -ne $expected.executableSha256) { throw 'Recovery receipt changed: executableSha256.' }
    if ($receipt.codexHome -ne $expected.codexHome) { throw 'Recovery receipt changed: codexHome.' }
    if ($receipt.endpoint -ne $expected.endpoint) { throw 'Recovery receipt changed: endpoint.' }
    $scheduler=New-Object -ComObject 'Schedule.Service'; $scheduler.Connect();
    $task=$scheduler.GetFolder('\\').GetTask($expected.taskName); $definition=$task.Definition;
    $principalSid=if ($definition.Principal.UserId -like 'S-1-*') { [string]$definition.Principal.UserId } else {
      ([Security.Principal.NTAccount]::new([string]$definition.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value };
    $action=$definition.Actions.Item(1);
    if ($definition.Actions.Count -ne 1 -or $action.Type -ne 0 -or
      $action.Path -ne (Join-Path $expected.ownerDirectory 'Rele.Process.exe') -or
      $action.Arguments -ne ('--codex-websocket-owner "' + (Join-Path $expected.ownerDirectory 'owner.json') + '"') -or
      $action.WorkingDirectory -ne $expected.ownerDirectory -or $principalSid -ne $sid -or
      [int]$definition.Principal.LogonType -ne 3 -or [int]$definition.Principal.RunLevel -ne 0 -or
      -not $task.Enabled -or [int]$definition.Settings.RestartCount -lt 1 -or
      [Xml.XmlConvert]::ToTimeSpan([string]$definition.Settings.RestartInterval).TotalSeconds -ne 60) { throw 'Recovery task identity changed.' }
    $native=Get-Process -Id $expected.processId -ErrorAction Stop; $pin=$native.Handle;
    $hostProcess=Get-Process -Id $receipt.hostPid -ErrorAction Stop;
    if ($native.StartTime.ToUniversalTime().Ticks -ne (UtcBirthTicks $expected.processStartTime)) { throw 'Recovery process changed: nativeStartedAt.' }
    if ($native.Path -ne $expected.executable) { throw 'Recovery process changed: nativeExecutable.' }
    if ($hostProcess.Path -ne (Join-Path $expected.ownerDirectory 'Rele.Process.exe')) { throw 'Recovery process changed: hostExecutable.' }
    if ($hostProcess.StartTime.ToUniversalTime().Ticks -ne (UtcBirthTicks $receipt.hostStartedAt)) { throw 'Recovery process changed: hostStartedAt.' }
    if ((Get-FileHash -LiteralPath $native.Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected.executableSha256) { throw 'Recovery process changed: executableSha256.' }
    $nativeInfo=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $native.Id);
    $hostInfo=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $hostProcess.Id);
    if ($nativeInfo.ParentProcessId -ne $hostProcess.Id -or
      (Invoke-CimMethod -InputObject $nativeInfo -MethodName GetOwnerSid).Sid -ne $sid -or
      (Invoke-CimMethod -InputObject $hostInfo -MethodName GetOwnerSid).Sid -ne $sid) { throw 'Recovery process owner changed.' }
    $native.Kill(); if (-not $native.WaitForExit(10000)) { throw 'The exact owned native process did not exit.' }
    [pscustomobject]@{ nativePid=[int]$native.Id; hostPid=[int]$hostProcess.Id; taskEnabled=[bool]$task.Enabled } | ConvertTo-Json -Compress`,
    { env: { ...env, RELE_CONTROL_PROCESS: JSON.stringify({ ...beforeRecovery, receiptSha256: recoveryReceiptHash }) } }));
  assert.equal(killed.nativePid, control.processId); assert.equal(killed.taskEnabled, true);
  await exited(killed.nativePid); await exited(killed.hostPid);
  let recovered;
  let recoveryStatusErrors = 0;
  let lastRecoveryError = '';
  while (Date.now() - recoveryStartedAt < 90_000) {
    const observed = await status();
    if (observed.status === 0) {
      const candidate = JSON.parse(observed.stdout);
      if (candidate.status === 'alreadyRunning' && candidate.processId !== control.processId) { recovered = candidate; break; }
      assert.equal(candidate.status, 'notRunning', 'The old native process must not be reported as recovered.');
    } else { recoveryStatusErrors++; lastRecoveryError = observed.errorReceipt || observed.stderr; }
    await delay(1000);
  }
  assert.ok(recovered, `The enabled owner Task did not recover native within 90 seconds. ${lastRecoveryError}`);
  assert.equal(nativeStartCalls, recoveryStartCalls, 'Recovery must not call codex-start.');
  assert.notEqual(recovered.processStartTime, control.processStartTime);
  for (const key of ['endpoint', 'codexHome', 'executable', 'executableSha256', 'ownerSid', 'ownerDirectory', 'taskName']) assert.equal(recovered[key], control[key]);
  const afterRecoveryTask = taskSnapshot();
  assert.equal(afterRecoveryTask.split('|')[0], beforeTask.split('|')[0], 'Recovery must preserve the Task definition.');
  assert.ok(Date.parse(afterRecoveryTask.split('|')[1]) > Date.parse(beforeTask.split('|')[1]), 'Task Scheduler must launch the recovery instance.');
  const recoveredCall = await connect(recovered.endpoint);
  const recoveredInitialize = await recoveredCall('initialize', { clientInfo: { name: 'rele_control_recovery_fixture', version: '1' }, capabilities: { experimentalApi: true } });
  socket.send('{"method":"initialized"}');
  assert.ok(samePath(recoveredInitialize.codexHome, await realpath(home)));
  assert.equal((await recoveredCall('server/diagnostics')).process.id, recovered.processId);
  const recoveredClosed = once(socket, 'close'); socket.close(); await recoveredClosed; socket = undefined;
  const receipt = JSON.parse(await readFile(path.join(target.desktopOwner.directory, 'receipt.json'), 'utf8'));
  stopInstallerCodex(target);
  await exited(receipt.hostPid); await exited(recovered.processId);
  const stopped = await status(); assert.equal(stopped.status, 0, stopped.errorReceipt || stopped.stderr);
  assert.deepEqual(JSON.parse(stopped.stdout), { status: 'notRunning' });
  assert.equal(powershell("(@(Get-ScheduledTask -TaskName $env:RELE_CONTROL_TASK -ErrorAction SilentlyContinue)).Count",
    { env: { ...env, RELE_CONTROL_TASK: `${task}-Codex` } }), '0');
  assert.deepEqual(await Promise.all([readFile(target.installSettingsPath), readFile(currentPointer)]), beforeStatus);
  const address = new URL(control.endpoint);
  foreign = createServer(connection => connection.end());
  foreign.listen(Number(address.port), '127.0.0.1'); await once(foreign, 'listening');
  const blocked = await start(); assert.equal(blocked.status, 1, 'An occupied stable endpoint must be refused.');
  assert.match(blocked.errorReceipt || blocked.stderr, /занят неподтверждённым процессом/u);
  assert.equal(foreign.listening, true, 'The foreign listener must remain alive.');
  await new Promise((resolve, reject) => foreign.close(error => error ? reject(error) : resolve())); foreign = undefined;
  result = { result: 'passed', nativeSha256: nativeHash, originalProfileInitialized: true, utf8Contract: true,
    actualNativeInitialize: true, diagnosticsAndKernelPidMatch: true, idempotentOwnerReuse: true,
    readonlyStatusMissingLiveStopped: true,
    nativeTaskRecoveryWithoutGateway: true, recoveryStatusErrors,
    serverSurvivesHelperExit: true, foreignOccupiedEndpointRefused: true, desktopActions: false };
} catch (error) { failure = error; }
finally {
  if (socket) { socket.terminate(); socket = undefined; }
  if (foreign?.listening) await new Promise((resolve, reject) => foreign.close(error => error ? reject(error) : resolve()));
  try {
    if (sid && helperHash) await readOwnedState(sid, helperHash);
    if (target.desktopOwner) stopInstallerCodex(target);
    cleanupConfirmed = true;
  } catch (error) { if (!failure) failure = error; }
  if (cleanupConfirmed) {
    try { await removeInstallerFixture(temporary); }
    catch (error) { cleanupConfirmed = false; if (!failure) failure = error; }
  }
}
if (failure) {
  console.error(JSON.stringify({ result: 'failed', cleanup: cleanupConfirmed ? 'passed' : 'unconfirmed',
    error: failure.message, ...(cleanupConfirmed ? {} : { retainedFixture: temporary }) }));
  throw failure;
}
console.log(JSON.stringify({ ...result, cleanup: 'passed' }));
