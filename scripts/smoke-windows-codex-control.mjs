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
let recoveryDiagnostics;
let phase = 'preflight';
let failurePhase;
const controllerCalls = [];
function run(command, args, extra = {}) {
  const output = spawnSync(command, args, { env, windowsHide: true, encoding: 'utf8', timeout: 25_000, maxBuffer: 65536, ...extra });
  if (output.error) throw output.error;
  return output;
}
function powershell(code, extra = {}) {
  const output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${code}`], extra);
  assert.equal(output.status, 0, output.stderr || output.stdout);
  return output.stdout.trim();
}
function scheduledTaskExists(name) {
  return powershell(`$scheduler=New-Object -ComObject 'Schedule.Service'; $scheduler.Connect(); $folder=$scheduler.GetFolder('\\');
    try { $null=$folder.GetTask($env:RELE_CONTROL_TASK); 'true' }
    catch { $inner=$_.Exception.InnerException; $hresult=if ($inner) { $inner.HResult } else { $_.Exception.HResult }; if ($hresult -ne -2147024894) { throw }; 'false' }`,
  { env: { ...env, RELE_CONTROL_TASK: name } }) === 'true';
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
let successorDirectory;
let initialOwner;
const knownHelperHashes = new Set();
try {
  sid = powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  assert.equal(scheduledTaskExists(`${task}-Codex`), false, 'The random fixture Task must not already exist.');
  await mkdir(path.join(application, 'dist/native'), { recursive: true });
  await mkdir(data);
  await assert.rejects(access(home), { code: 'ENOENT' });
  await copyFile(path.join(stage, 'Rele.exe'), path.join(application, 'Rele.exe'));
  const guiHelper = await readFile(path.join(stage, 'dist/native/Rele.Process.exe'));
  assert.equal(guiHelper.subarray(0, 2).toString('ascii'), 'MZ');
  const pe = guiHelper.readUInt32LE(0x3c), subsystem = pe + 24 + 68;
  assert.equal(guiHelper.readUInt32LE(pe), 0x4550); assert.equal(guiHelper.readUInt16LE(subsystem), 2);
  // Only this private fixture emulates the previous console-subsystem build; published bytes stay unchanged.
  const legacyHelper = Buffer.from(guiHelper); legacyHelper.writeUInt16LE(3, subsystem);
  await writeFile(path.join(application, 'dist/native/Rele.Process.exe'), legacyHelper);
  const legacyHelperHash = digest(legacyHelper), guiHelperHash = digest(guiHelper);
  knownHelperHashes.add(legacyHelperHash); knownHelperHashes.add(guiHelperHash);
  helperHash = legacyHelperHash;
  await writeFile(target.installSettingsPath, JSON.stringify({ DataDirectory: data, TaskName: task,
    Port: 0, OwnerSid: sid, CodexHome: home, DesktopIntegrationOwned: false, DesktopIntegrationRequested: false }));
  let starts = 0;
  let nativeStartCalls = 0;
  const commandCounts = { 'codex-start': 0, 'codex-status': 0 };
  const controlCommand = async command => {
    if (command === 'codex-start') nativeStartCalls++;
    const errorFile = path.join(data, `control-error-${++starts}.txt`);
    const call = { sequence: controllerCalls.length + 1, command, commandIndex: ++commandCounts[command], phase };
    controllerCalls.push(call);
    console.error(JSON.stringify({ type: 'controller-call', ...call }));
    const began = performance.now();
    try {
      const output = run(path.join(application, 'Rele.exe'), [command, '--quiet', ...(command === 'codex-start' ? ['--codex-executable', executable] : []),
        '--codex-home', home, '--error-file', errorFile], { timeout: 60_000 });
      call.exitCode = output.status;
      if (output.status !== 0) output.errorReceipt = await readFile(errorFile, 'utf8').catch(() => '');
      return output;
    } catch (error) { call.errorCode = error.code || error.name; throw error; }
    finally { call.durationMs = Math.ceil(performance.now() - began); }
  };
  const start = () => controlCommand('codex-start');
  const status = () => controlCommand('codex-status');
  const initialSettings = await readFile(target.installSettingsPath);
  phase = 'status-missing';
  const missing = await status(); assert.equal(missing.status, 0, missing.errorReceipt || missing.stderr);
  assert.deepEqual(JSON.parse(missing.stdout), { status: 'notRunning' });
  assert.deepEqual(await readFile(target.installSettingsPath), initialSettings);
  assert.deepEqual(await readdir(data), []);
  await assert.rejects(access(home), { code: 'ENOENT' });
  phase = 'start-initial';
  const first = await start();
  assert.equal(first.status, 0, first.errorReceipt || first.stderr);
  const control = JSON.parse(first.stdout);
  assert.equal(control.status, 'started');
  assert.match(control.endpoint, /^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u);
  assert.ok(new URL(control.endpoint).port <= 65535);
  assert.ok(samePath(control.codexHome, await realpath(home)), 'UTF-8 original profile must round-trip.');
  assert.ok(samePath(control.executable, executable)); assert.equal(control.executableSha256, nativeHash);
  assert.equal(control.ownerSid, sid); assert.equal(control.taskName, `${task}-Codex`);
  assert.equal(scheduledTaskExists(`${task}-Codex`), true, 'The native owner Task must be registered.');
  assert.ok(Number.isSafeInteger(control.processId) && control.processId > 0);
  assert.ok(Number.isFinite(Date.parse(control.processStartTime)));
  await readOwnedState(sid, helperHash);
  initialOwner = { ...target.desktopOwner };
  assert.ok(samePath(control.ownerDirectory, target.desktopOwner.directory));
  const currentPointer = path.join(data, 'codex-websocket-owners/current.json');
  const beforeStatus = await Promise.all([readFile(target.installSettingsPath), readFile(currentPointer)]);
  const taskSnapshot = () => powershell(`$scheduler=New-Object -ComObject 'Schedule.Service'; $scheduler.Connect();
    $task=$scheduler.GetFolder('\\').GetTask($env:RELE_CONTROL_TASK);
    $hash=[Security.Cryptography.SHA256]::Create();
    try { $xmlHash=[BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$task.Xml))) } finally { $hash.Dispose() }
    $xmlHash + '|' + $task.LastRunTime.ToUniversalTime().ToString('o')`, { env: { ...env, RELE_CONTROL_TASK: `${task}-Codex` } });
  const beforeTask = taskSnapshot();
  phase = 'status-live';
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
  phase = 'native-initialize';
  const call = await connect(control.endpoint);
  const initialized = await call('initialize', { clientInfo: { name: 'rele_control_fixture', version: '1' }, capabilities: { experimentalApi: true } });
  socket.send('{"method":"initialized"}');
  assert.ok(samePath(initialized.codexHome, await realpath(home)));
  assert.equal((await call('server/diagnostics')).process.id, control.processId);
  // Emulate the prior own Task: a live owner with only its logon trigger.
  phase = 'legacy-task-fixture';
  powershell(`$expected=$env:RELE_CONTROL_PROCESS | ConvertFrom-Json;
    $scheduler=New-Object -ComObject 'Schedule.Service'; $scheduler.Connect(); $folder=$scheduler.GetFolder('\\');
    $task=$folder.GetTask($expected.taskName); $definition=$task.Definition; $action=$definition.Actions.Item(1);
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    $principalSid=if ($definition.Principal.UserId -like 'S-1-*') { [string]$definition.Principal.UserId } else {
      ([Security.Principal.NTAccount]::new([string]$definition.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value };
    if ($definition.Actions.Count -ne 1 -or $action.Type -ne 0 -or $principalSid -ne $sid -or
      [int]$definition.Principal.LogonType -ne 3 -or [int]$definition.Principal.RunLevel -ne 0 -or
      $action.Path -ne (Join-Path $expected.ownerDirectory 'Rele.Process.exe') -or
      $action.Arguments -ne ('--codex-websocket-owner "' + (Join-Path $expected.ownerDirectory 'owner.json') + '"') -or
      $action.WorkingDirectory -ne $expected.ownerDirectory) { throw 'Legacy recovery Task fixture identity changed.' }
    for ($index=$definition.Triggers.Count; $index -ge 1; $index--) {
      if ([int]$definition.Triggers.Item($index).Type -eq 1) { $definition.Triggers.Remove($index) }
    }
    $folder.RegisterTaskDefinition($expected.taskName,$definition,6,$sid,$null,3,$null) | Out-Null;`,
  { env: { ...env, RELE_CONTROL_PROCESS: JSON.stringify(control) } });
  phase = 'start-repair-active';
  const repeated = await start(); assert.equal(repeated.status, 0, repeated.errorReceipt || repeated.stderr);
  const second = JSON.parse(repeated.stdout);
  assert.equal(second.status, 'alreadyRunning');
  for (const key of ['endpoint', 'processId', 'processStartTime', 'ownerDirectory']) assert.equal(second[key], control[key]);
  assert.equal((await call('server/diagnostics')).process.id, control.processId);
  phase = 'stage-gui-successor';
  const oldMarkerBytes = await readFile(path.join(control.ownerDirectory, 'owner.json'));
  const oldReceiptBytes = await readFile(path.join(control.ownerDirectory, 'receipt.json'));
  await writeFile(path.join(application, 'dist/native/Rele.Process.exe'), guiHelper);
  const scheduledUpgrade = await start(); assert.equal(scheduledUpgrade.status, 0, scheduledUpgrade.errorReceipt || scheduledUpgrade.stderr);
  const activeUpgrade = JSON.parse(scheduledUpgrade.stdout);
  for (const key of ['processId', 'processStartTime', 'ownerDirectory', 'endpoint', 'codexHome', 'executable', 'executableSha256']) assert.equal(activeUpgrade[key], control[key]);
  successorDirectory = powershell(`$scheduler=New-Object -ComObject 'Schedule.Service'; $scheduler.Connect();
    $task=$scheduler.GetFolder('\\').GetTask($env:RELE_CONTROL_TASK); $definition=$task.Definition;
    if ($task.State -ne 4 -or [int]$definition.Settings.MultipleInstances -ne 2) { throw 'The same running IgnoreNew Task must survive upgrade.' }
    Split-Path -Parent $definition.Actions.Item(1).Path`, { env: { ...env, RELE_CONTROL_TASK: `${task}-Codex` } });
  assert.notEqual(successorDirectory, control.ownerDirectory);
  const successor = JSON.parse(await readFile(path.join(successorDirectory, 'owner.json'), 'utf8'));
  assert.equal(digest(await readFile(path.join(successorDirectory, 'owner.json'))), path.basename(successorDirectory));
  assert.equal(successor.HostSha256, guiHelperHash);
  assert.equal(digest(await readFile(path.join(successorDirectory, 'Rele.Process.exe'))), guiHelperHash);
  const oldMarker = JSON.parse(oldMarkerBytes);
  for (const key of ['OwnerSid', 'TaskName', 'Endpoint', 'CodexHome', 'Executable', 'ExecutableSha256']) assert.equal(successor[key], oldMarker[key]);
  assert.deepEqual(await readFile(path.join(control.ownerDirectory, 'owner.json')), oldMarkerBytes);
  assert.deepEqual(await readFile(path.join(control.ownerDirectory, 'receipt.json')), oldReceiptBytes);
  assert.equal(digest(await readFile(path.join(control.ownerDirectory, 'Rele.Process.exe'))), legacyHelperHash);
  await readOwnedState(sid, legacyHelperHash);
  assert.deepEqual(await Promise.all([readFile(target.installSettingsPath), readFile(currentPointer)]), beforeStatus);
  assert.equal((await call('server/diagnostics')).process.id, control.processId);
  const successorTaskSnapshot = taskSnapshot();
  const alterSuccessorArgument = bad => powershell(`$scheduler=New-Object -ComObject 'Schedule.Service'; $scheduler.Connect();
    $folder=$scheduler.GetFolder('\\'); $task=$folder.GetTask($env:RELE_CONTROL_TASK); $definition=$task.Definition; $action=$definition.Actions.Item(1);
    $expected='--codex-websocket-owner "' + (Join-Path $env:RELE_CONTROL_SUCCESSOR 'owner.json') + '"';
    $from=if($env:RELE_CONTROL_BAD -eq '1'){$expected}else{$expected+' --foreign-fixture'};
    if ($definition.Actions.Count -ne 1 -or $action.Type -ne 0 -or $action.Path -ne (Join-Path $env:RELE_CONTROL_SUCCESSOR 'Rele.Process.exe') -or
      $action.Arguments -ne $from -or $action.WorkingDirectory -ne $env:RELE_CONTROL_SUCCESSOR -or
      [int]$definition.Principal.LogonType -ne 3 -or [int]$definition.Principal.RunLevel -ne 0) { throw 'The private successor fixture Task changed.' }
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    $principalSid=if($definition.Principal.UserId -like 'S-1-*'){[string]$definition.Principal.UserId}else{([Security.Principal.NTAccount]::new([string]$definition.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value};
    if($principalSid -ne $sid){throw 'The private fixture owner changed.'}
    $action.Arguments=if($env:RELE_CONTROL_BAD -eq '1'){$expected+' --foreign-fixture'}else{$expected};
    $folder.RegisterTaskDefinition($env:RELE_CONTROL_TASK,$definition,6,$sid,$null,3,$null) | Out-Null`,
  { env: { ...env, RELE_CONTROL_TASK: `${task}-Codex`, RELE_CONTROL_SUCCESSOR: successorDirectory, RELE_CONTROL_BAD: bad ? '1' : '0' } });
  phase = 'reject-unknown-successor-action';
  alterSuccessorArgument(true);
  try {
    const unknownSnapshot = taskSnapshot();
    const refused = await status(); assert.equal(refused.status, 1, 'An unknown successor action must fail closed.');
    assert.equal(taskSnapshot(), unknownSnapshot, 'Refusal must leave the Task unchanged.');
    assert.deepEqual(await Promise.all([readFile(target.installSettingsPath), readFile(currentPointer)]), beforeStatus);
    assert.equal((await call('server/diagnostics')).process.id, control.processId);
  } finally { alterSuccessorArgument(false); }
  assert.equal(taskSnapshot(), successorTaskSnapshot);
  const recoveryTaskSnapshot = taskSnapshot();
  const closed = once(socket, 'close'); socket.close(); await closed; socket = undefined;
  const recoveryStartCalls = nativeStartCalls;
  phase = 'status-before-native-crash';
  const fresh = await status(); assert.equal(fresh.status, 0, fresh.errorReceipt || fresh.stderr);
  const beforeRecovery = JSON.parse(fresh.stdout);
  assert.equal(beforeRecovery.processId, control.processId);
  await readOwnedState(sid, helperHash);
  const recoveryReceiptHash = digest(await readFile(path.join(target.desktopOwner.directory, 'receipt.json')));
  phase = 'crash-own-native';
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
      $action.Path -ne (Join-Path $expected.scheduledOwnerDirectory 'Rele.Process.exe') -or
      $action.Arguments -ne ('--codex-websocket-owner "' + (Join-Path $expected.scheduledOwnerDirectory 'owner.json') + '"') -or
      $action.WorkingDirectory -ne $expected.scheduledOwnerDirectory -or $principalSid -ne $sid -or
      [int]$definition.Principal.LogonType -ne 3 -or [int]$definition.Principal.RunLevel -ne 0 -or
      -not $task.Enabled -or [int]$definition.Settings.MultipleInstances -ne 2 -or [int]$definition.Settings.RestartCount -lt 1 -or
      [Xml.XmlConvert]::ToTimeSpan([string]$definition.Settings.RestartInterval).TotalSeconds -ne 60) { throw 'Recovery task identity changed.' }
    $recurring=@($definition.Triggers | Where-Object { [int]$_.Type -eq 1 -and [bool]$_.Enabled -and
      -not [string]::IsNullOrEmpty([string]$_.Repetition.Interval) -and
      [Xml.XmlConvert]::ToTimeSpan([string]$_.Repetition.Interval).TotalSeconds -eq 60 -and
      [string]::IsNullOrEmpty([string]$_.Repetition.Duration) -and -not [bool]$_.Repetition.StopAtDurationEnd });
    if ($recurring.Count -ne 1) { throw 'The enabled indefinite recovery trigger is missing.' }
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
    { env: { ...env, RELE_CONTROL_PROCESS: JSON.stringify({ ...beforeRecovery, scheduledOwnerDirectory: successorDirectory, receiptSha256: recoveryReceiptHash }) } }));
  assert.equal(killed.nativePid, control.processId); assert.equal(killed.taskEnabled, true);
  const recoveryStartedAt = Date.now();
  await exited(killed.nativePid); await exited(killed.hostPid);
  let recovered;
  let recoveryStatusErrors = 0;
  let lastRecoveryError = '';
  phase = 'wait-task-recovery';
  while (Date.now() - recoveryStartedAt < 90_000) {
    const observed = await status();
    if (observed.status === 0) {
      const candidate = JSON.parse(observed.stdout);
      if (candidate.status === 'alreadyRunning' && candidate.processId !== control.processId) { recovered = candidate; break; }
      assert.equal(candidate.status, 'notRunning', 'The old native process must not be reported as recovered.');
    } else { recoveryStatusErrors++; lastRecoveryError = observed.errorReceipt || observed.stderr; }
    await delay(1000);
  }
  if (!recovered) {
    recoveryDiagnostics = JSON.parse(powershell(`$expected=$env:RELE_CONTROL_PROCESS | ConvertFrom-Json;
      $facts=[ordered]@{ taskPresent=$false; taskOwnership='absent'; taskState=$null; taskEnabled=$null;
        lastTaskResult=$null; lastTaskResultHex=$null; lastRunTime=$null; instances=$null; receiptPresent=$false };
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      $scheduler=New-Object -ComObject 'Schedule.Service'; $scheduler.Connect(); $task=$null;
      try { $task=$scheduler.GetFolder('\\').GetTask($expected.taskName) }
      catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
      if ($task) {
        $facts.taskPresent=$true; $definition=$task.Definition; $action=$definition.Actions.Item(1);
        $principalSid=if ($definition.Principal.UserId -like 'S-1-*') { [string]$definition.Principal.UserId } else {
          ([Security.Principal.NTAccount]::new([string]$definition.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value };
        $owned=$definition.Actions.Count -eq 1 -and $action.Type -eq 0 -and
          $action.Path -eq (Join-Path $expected.scheduledOwnerDirectory 'Rele.Process.exe') -and
          $action.Arguments -eq ('--codex-websocket-owner "' + (Join-Path $expected.scheduledOwnerDirectory 'owner.json') + '"') -and
          $action.WorkingDirectory -eq $expected.scheduledOwnerDirectory -and $principalSid -eq $sid -and
          [int]$definition.Principal.LogonType -eq 3 -and [int]$definition.Principal.RunLevel -eq 0;
        $facts.taskOwnership=if ($owned) { 'matched' } else { 'mismatch' };
        if ($owned) {
          $facts.taskState=[int]$task.State; $facts.taskEnabled=[bool]$task.Enabled;
          $code=[uint32]([int64]$task.LastTaskResult -band 4294967295);
          $facts.lastTaskResult=[long]$code; $facts.lastTaskResultHex=('0x{0:X8}' -f $code);
          $facts.lastRunTime=$task.LastRunTime.ToUniversalTime().ToString('o');
          $facts.instances=[int]$task.GetInstances(0).Count;
          $facts.restartCount=[int]$definition.Settings.RestartCount;
          $facts.restartIntervalSeconds=[Xml.XmlConvert]::ToTimeSpan([string]$definition.Settings.RestartInterval).TotalSeconds;
          $facts.multipleInstances=[int]$definition.Settings.MultipleInstances;
          $facts.timeTriggerCount=@($definition.Triggers | Where-Object { [int]$_.Type -eq 1 -and [bool]$_.Enabled }).Count;
        }
      }
      function ProcessFact([int]$id,[object]$birth,[string]$executable) {
        $process=$null;
        try { $process=[Diagnostics.Process]::GetProcessById($id) }
        catch [ArgumentException] { return @{ presence='absent'; birthMatches=$false; pathMatches=$null } }
        try {
          $date=if ($birth -is [datetime]) { $birth } else {
            [DateTime]::Parse([string]$birth,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind) };
          $sameBirth=$process.StartTime.ToUniversalTime().Ticks -eq $date.ToUniversalTime().Ticks;
          return @{ presence='present'; birthMatches=$sameBirth; pathMatches=$(if ($sameBirth) { $process.Path -eq $executable } else { $null }) };
        } catch { return @{ presence='unknown'; errorHResult=$_.Exception.HResult } }
        finally { if ($process) { $process.Dispose() } }
      }
      $file=Join-Path $expected.ownerDirectory 'receipt.json';
      if (Test-Path -LiteralPath $file) {
        $facts.receiptPresent=$true;
        try {
          $receipt=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($file)) | ConvertFrom-Json;
          $facts.receiptIdentityMatches=$receipt.ownerSid -eq $sid -and $receipt.endpoint -eq $expected.endpoint -and
            $receipt.codexHome -eq $expected.codexHome -and $receipt.executable -eq $expected.executable -and
            $receipt.executableSha256 -eq $expected.executableSha256;
          if ($facts.receiptIdentityMatches) {
            $facts.receiptStatus=[string]$receipt.status; $facts.nativeExitCode=$receipt.exitCode;
            $facts.hostPid=[int]$receipt.hostPid; $facts.nativePid=[int]$receipt.nativePid;
            $facts.host=ProcessFact $receipt.hostPid $receipt.hostStartedAt (Join-Path $expected.ownerDirectory 'Rele.Process.exe');
            $facts.native=ProcessFact $receipt.nativePid $receipt.nativeStartedAt $expected.executable;
          }
        } catch { $facts.receiptErrorHResult=$_.Exception.HResult }
      }
      $portErrors=@(); $rows=@(Get-NetTCPConnection -LocalPort $env:RELE_CONTROL_PORT -ErrorAction SilentlyContinue -ErrorVariable portErrors);
      $facts.portQuerySucceeded=$portErrors.Count -eq 0;
      if ($facts.portQuerySucceeded) {
        $facts.listenerCount=@($rows | Where-Object { $_.State -eq 'Listen' -and $_.LocalAddress -in @('127.0.0.1','0.0.0.0') }).Count;
        $facts.timeWaitCount=@($rows | Where-Object { $_.State -eq 'TimeWait' }).Count;
      }
      $facts | ConvertTo-Json -Depth 5 -Compress`, { env: { ...env,
      RELE_CONTROL_PROCESS: JSON.stringify({ ...beforeRecovery, scheduledOwnerDirectory: successorDirectory }), RELE_CONTROL_PORT: new URL(control.endpoint).port } }));
    throw new Error('The enabled owner Task did not recover native within 90 seconds.');
  }
  assert.equal(nativeStartCalls, recoveryStartCalls, 'Recovery must not call codex-start.');
  assert.notEqual(recovered.processStartTime, control.processStartTime);
  for (const key of ['endpoint', 'codexHome', 'executable', 'executableSha256', 'ownerSid', 'taskName']) assert.equal(recovered[key], control[key]);
  assert.ok(samePath(recovered.ownerDirectory, successorDirectory));
  assert.deepEqual(await Promise.all([readFile(target.installSettingsPath), readFile(currentPointer)]), beforeStatus, 'Status must not promote or write the cold successor.');
  phase = 'promote-cold-successor';
  const promoted = await start(); assert.equal(promoted.status, 0, promoted.errorReceipt || promoted.stderr);
  assert.deepEqual(JSON.parse(promoted.stdout), recovered);
  helperHash = guiHelperHash;
  await readOwnedState(sid, helperHash);
  const promotedState = await Promise.all([readFile(target.installSettingsPath), readFile(currentPointer)]);
  assert.ok(samePath(JSON.parse(promotedState[0]).CodexWebSocketOwnerDirectory, successorDirectory));
  assert.ok(samePath(JSON.parse(promotedState[1]).OwnerDirectory, successorDirectory));
  const afterRecoveryTask = taskSnapshot();
  assert.equal(afterRecoveryTask.split('|')[0], recoveryTaskSnapshot.split('|')[0], 'Recovery must preserve the repaired Task definition.');
  assert.ok(Date.parse(afterRecoveryTask.split('|')[1]) > Date.parse(recoveryTaskSnapshot.split('|')[1]), 'Task Scheduler must launch the recovery instance.');
  phase = 'verify-recovered-native';
  const recoveredCall = await connect(recovered.endpoint);
  const recoveredInitialize = await recoveredCall('initialize', { clientInfo: { name: 'rele_control_recovery_fixture', version: '1' }, capabilities: { experimentalApi: true } });
  socket.send('{"method":"initialized"}');
  assert.ok(samePath(recoveredInitialize.codexHome, await realpath(home)));
  assert.equal((await recoveredCall('server/diagnostics')).process.id, recovered.processId);
  const recoveredClosed = once(socket, 'close'); socket.close(); await recoveredClosed; socket = undefined;
  const receipt = JSON.parse(await readFile(path.join(target.desktopOwner.directory, 'receipt.json'), 'utf8'));
  phase = 'cleanup-after-recovery';
  stopInstallerCodex(target);
  await exited(receipt.hostPid); await exited(recovered.processId);
  phase = 'status-after-stop';
  const stopped = await status(); assert.equal(stopped.status, 0, stopped.errorReceipt || stopped.stderr);
  assert.deepEqual(JSON.parse(stopped.stdout), { status: 'notRunning' });
  assert.equal(scheduledTaskExists(`${task}-Codex`), false);
  assert.deepEqual(await Promise.all([readFile(target.installSettingsPath), readFile(currentPointer)]), promotedState);
  const address = new URL(control.endpoint);
  foreign = createServer(connection => connection.end());
  foreign.listen(Number(address.port), '127.0.0.1'); await once(foreign, 'listening');
  phase = 'foreign-port-refusal';
  const blocked = await start(); assert.equal(blocked.status, 1, 'An occupied stable endpoint must be refused.');
  assert.match(blocked.errorReceipt || blocked.stderr, /занят неподтверждённым процессом/u);
  assert.equal(foreign.listening, true, 'The foreign listener must remain alive.');
  await new Promise((resolve, reject) => foreign.close(error => error ? reject(error) : resolve())); foreign = undefined;
  result = { result: 'passed', nativeSha256: nativeHash, originalProfileInitialized: true, utf8Contract: true,
    actualNativeInitialize: true, diagnosticsAndKernelPidMatch: true, idempotentOwnerReuse: true,
    readonlyStatusMissingLiveStopped: true,
    legacyOwnerRecoveryTriggerRepaired: true, nativeTaskRecoveryWithoutGateway: true, recoveryStatusErrors,
    liveOwnerPreservedDuringGuiUpgrade: true, sameTaskGuiSuccessorStaged: true, coldSuccessorPromoted: true,
    unknownSuccessorActionRefusedWithoutMutation: true,
    serverSurvivesHelperExit: true, foreignOccupiedEndpointRefused: true, desktopActions: false };
} catch (error) { failure = error; failurePhase = phase; }
finally {
  phase = 'cleanup-final';
  if (socket) { socket.terminate(); socket = undefined; }
  if (foreign?.listening) await new Promise((resolve, reject) => foreign.close(error => error ? reject(error) : resolve()));
  try {
    if (sid && helperHash) {
      const settings = JSON.parse(await readFile(target.installSettingsPath, 'utf8'));
      if (settings.CodexWebSocketOwnerDirectory) {
        const marker = JSON.parse(await readFile(path.join(settings.CodexWebSocketOwnerDirectory, 'owner.json'), 'utf8'));
        assert.ok(knownHelperHashes.has(marker.HostSha256), "Cleanup must use one of this fixture's exact host builds.");
        await readOwnedState(sid, marker.HostSha256);
      }
    }
    if (target.desktopOwner) stopInstallerCodex(initialOwner ? { ...target, desktopOwner: initialOwner } : target, successorDirectory);
    cleanupConfirmed = true;
  } catch (error) { if (!failure) failure = error; }
  if (cleanupConfirmed) {
    try { await removeInstallerFixture(temporary); }
    catch (error) { cleanupConfirmed = false; if (!failure) failure = error; }
  }
}
if (failure) {
  console.error(JSON.stringify({ result: 'failed', cleanup: cleanupConfirmed ? 'passed' : 'unconfirmed',
    phase: failurePhase || phase, controllerCalls, error: failure.message, ...(recoveryDiagnostics ? { recovery: recoveryDiagnostics } : {}),
    ...(cleanupConfirmed ? {} : { retainedFixture: temporary }) }));
  throw failure;
}
console.log(JSON.stringify({ ...result, cleanup: 'passed', controllerCalls,
  controllerDeadline20sMet: controllerCalls.every(call => call.durationMs < 20_000) }));
