import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, glob, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// A single budget avoids fs.rm's recursive retry budget multiplying at every directory level.
export async function removeInstallerFixture(directory, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await rm(directory, { recursive: true, force: true, maxRetries: 0 }); return; }
    catch (error) {
      if (['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'].includes(error.code) && Date.now() < deadline) { await delay(200); continue; }
      const code = typeof error.code === 'string' && /^[A-Z_]{1,32}$/u.test(error.code) ? error.code : 'UNKNOWN';
      const relative = typeof error.path === 'string' ? path.relative(directory, path.resolve(error.path)) : '';
      const safePath = relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && relative.length <= 240 && !/[\x00-\x1f\x7f]/u.test(relative) ? relative : undefined;
      const failure = new Error(`Installer fixture cleanup failed (${code}${safePath ? `, ${safePath}` : ''}).`);
      failure.code = code;
      if (safePath) failure.relativePath = safePath;
      throw failure;
    }
  }
}

// The close promise is attached at spawn so process exit cannot race teardown's listener.
export async function closeInstallerChild(child, closed) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  let timeout;
  try { await Promise.race([closed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The owned installer fixture process did not close.')), 5000); })]); }
  finally { clearTimeout(timeout); }
}

// Only disposable installer CI calls this; it never uses a user profile or sends a model request.
export async function installerCodex(home) {
  assert.ok(process.env.RELE_TEST_CODEX_PREFIX, 'Installer smoke requires an isolated full native Codex package.');
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const pattern = path.join(process.env.RELE_TEST_CODEX_PREFIX, 'node_modules/@openai/codex-*/vendor/*/bin', binary).replaceAll('\\', '/');
  const candidates = [];
  for await (const file of glob(pattern)) candidates.push(path.resolve(file));
  assert.equal(candidates.length, 1, 'Expected one isolated native Codex binary.');
  const executable = candidates[0];
  const metadata = JSON.parse(await readFile(path.join(path.dirname(executable), '..', 'codex-package.json'), 'utf8'));
  const { SUPPORTED_CODEX_VERSIONS } = await import('../dist/shared/codex-runtime.js');
  assert.ok(SUPPORTED_CODEX_VERSIONS.includes(metadata.version), 'Expected a supported native Codex version.');
  assert.equal(metadata.entrypoint, `bin/${binary}`);
  const settings = path.join(home, 'app-server-daemon');
  await assert.rejects(access(settings), { code: 'ENOENT' });
  await assert.rejects(access(path.join(home, 'app-server-control', 'app-server-control.sock')), { code: 'ENOENT' });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'config.toml'), 'model = "installer-fixture"\nmodel_provider = "installer-fixture"\n[model_providers.installer-fixture]\nname = "Offline installer fixture"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n', { flag: 'wx' });
  const target = { executable, transport: 'shared', endpoint: '', codexHome: home };
  // Native stop initializes its owner-private Windows DACL without starting a backend.
  if (process.platform === 'win32') assert.equal(stopInstallerCodex(target).status, 'notRunning');
  else await mkdir(settings, { mode: 0o700 });
  // Offline fixture policy only: the separate optional updater is not stopped by daemon stop.
  await writeFile(path.join(settings, 'settings.json'), JSON.stringify({ updater: { autoUpdateEnabled: false } }), { flag: 'wx' });
  return target;
}

export async function sharedBackendPid(target, expectedPid) {
  const { CodexClient } = await import('../dist/server/codex.js');
  await captureInstallerOwner(target);
  const deadline = Date.now() + 45_000;
  let failure = 'no-connection';
  do {
    const client = new CodexClient({ ...target, transport: target.desktopOwner ? 'websocket' : 'proxy',
      endpoint: target.desktopOwner ? target.endpoint : path.join(target.codexHome, 'app-server-control', 'app-server-control.sock') });
    try {
      await client.connect();
      const pid = (await client.diagnostics()).process.id;
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      process.kill(pid, 0);
      if (expectedPid) assert.equal(pid, expectedPid, 'Rele lifecycle must preserve the native shared backend PID.');
      return pid;
    } catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error;
      failure = typeof error.code === 'string' ? error.code : error.name;
    } finally { await client.close(); }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`The installer did not establish the native shared Codex backend (${failure}).`);
}

export async function captureInstallerOwner(target) {
  if (process.platform !== 'win32' || !target?.installSettingsPath) return;
  let contents;
  try { contents = await readFile(target.installSettingsPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' && target.desktopOwner) return; throw error; }
  const settings = JSON.parse(contents);
  if (!settings.CodexWebSocketOwnerDirectory) return;
  assert.match(settings.CodexWebSocketEndpoint, /^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u);
  assert.ok(new URL(settings.CodexWebSocketEndpoint).port <= 65535);
  const cache = path.join(target.fixtureDataDirectory, 'codex-websocket-owners');
  assert.equal(path.dirname(settings.CodexWebSocketOwnerDirectory).toLowerCase(), cache.toLowerCase());
  assert.match(path.basename(settings.CodexWebSocketOwnerDirectory), /^[a-f0-9]{64}$/u);
  assert.equal(settings.CodexWebSocketTaskName, `${target.fixtureTaskName}-Codex`);
  target.endpoint = settings.CodexWebSocketEndpoint;
  target.desktopOwner = { directory: settings.CodexWebSocketOwnerDirectory, taskName: settings.CodexWebSocketTaskName, ownerSid: settings.OwnerSid };
}

export function stopInstallerCodex(target, scheduledDirectory) {
  if (!target) return;
  if (process.platform === 'win32' && target.installSettingsPath && !target.desktopOwner)
    throw new Error('The isolated owner state is unconfirmed; preserve its fixture files for inspection.');
  if (process.platform === 'win32' && target.desktopOwner) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop';
      $owner = $env:RELE_FIXTURE_OWNER | ConvertFrom-Json;
      $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      if ($owner.ownerSid -ne $sid) { throw 'Foreign fixture owner.' }
      $scheduled = if ($owner.scheduledDirectory) { [string]$owner.scheduledDirectory } else { [string]$owner.directory };
      $directories = @([string]$owner.directory);
      function Read-FixtureMarker([string]$directory) {
        if ((Split-Path -Parent $directory) -ne (Split-Path -Parent $owner.directory) -or
          (Split-Path -Leaf $directory) -notmatch '^[a-f0-9]{64}$' -or
          ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Foreign fixture directory.' }
        $file=Join-Path $directory 'owner.json';
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne (Split-Path -Leaf $directory)) { throw 'Fixture marker changed.' }
        $marker=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json;
        if ($marker.Version -ne 1 -or $marker.OwnerSid -ne $sid -or $marker.TaskName -ne $owner.taskName -or
          (Get-FileHash -LiteralPath (Join-Path $directory 'Rele.Process.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $marker.HostSha256) { throw 'Foreign fixture marker.' }
        return $marker;
      }
      $marker = Read-FixtureMarker $owner.directory;
      if ($scheduled -ne $owner.directory) {
        $next = Read-FixtureMarker $scheduled;
        foreach($field in @('OwnerSid','TaskName','Endpoint','CodexHome','Executable','ExecutableSha256')) {
          if($marker.$field -ne $next.$field) { throw 'Foreign fixture successor scope.' }
        }
        $directories += $scheduled;
      }
      $scheduler = New-Object -ComObject 'Schedule.Service'; $scheduler.Connect(); $folder = $scheduler.GetFolder('\\');
      $task = $null;
      try { $task = $folder.GetTask($owner.taskName) } catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
      if ($task) {
        $definition = $task.Definition; $action = $definition.Actions.Item(1);
        $principalSid = if ($definition.Principal.UserId -like 'S-1-*') { [string]$definition.Principal.UserId } else {
          ([Security.Principal.NTAccount]::new([string]$definition.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
        };
        if ($definition.Actions.Count -ne 1 -or $action.Type -ne 0 -or
          $action.Path -ne (Join-Path $scheduled 'Rele.Process.exe') -or
          $action.Arguments -ne ('--codex-websocket-owner "' + (Join-Path $scheduled 'owner.json') + '"') -or
          $action.WorkingDirectory -ne $scheduled -or $principalSid -ne $sid -or
          [int]$definition.Principal.LogonType -ne 3 -or [int]$definition.Principal.RunLevel -ne 0) { throw 'Foreign fixture task.' }
        $task.Enabled = $false;
      }
      if ($task -and $task.State -in @(2,4) -and -not (Test-Path -LiteralPath (Join-Path $scheduled 'receipt.json'))) {
        $oldStillRunning=$false;
        if($scheduled -ne $owner.directory) {
          $prior=Get-Content -LiteralPath (Join-Path $owner.directory 'receipt.json') -Raw | ConvertFrom-Json;
          $priorHost=Get-Process -Id $prior.hostPid -ErrorAction SilentlyContinue;
          $oldStillRunning=$priorHost -and $priorHost.Path -eq (Join-Path $owner.directory 'Rele.Process.exe') -and
            $priorHost.StartTime.ToUniversalTime().ToString('o') -eq [string]$prior.hostStartedAt;
        }
        if(-not $oldStillRunning) {
          $wait=[Diagnostics.Stopwatch]::StartNew();
          while($task.State -in @(2,4) -and -not (Test-Path -LiteralPath (Join-Path $scheduled 'receipt.json')) -and $wait.ElapsedMilliseconds -lt 15000) { Start-Sleep -Milliseconds 100 }
          if($task.State -in @(2,4) -and -not (Test-Path -LiteralPath (Join-Path $scheduled 'receipt.json'))) { throw 'Successor receipt is unconfirmed; retain the fixture.' }
        }
      }
      foreach($directory in $directories) {
        $receiptFile=Join-Path $directory 'receipt.json';
        if(-not (Test-Path -LiteralPath $receiptFile)) {
          if($directory -eq $owner.directory) { throw 'The original fixture receipt is missing; retain the fixture.' }
          continue;
        }
        $receipt=Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json;
        if($receipt.ownerSid -ne $sid -or $receipt.endpoint -ne $marker.Endpoint -or $receipt.codexHome -ne $marker.CodexHome -or
          $receipt.executable -ne $marker.Executable -or $receipt.executableSha256 -ne $marker.ExecutableSha256) { throw 'Foreign fixture receipt.' }
        $hostProcess = Get-Process -Id $receipt.hostPid -ErrorAction SilentlyContinue;
        if (-not $hostProcess) { continue }
        $hostPin=$hostProcess.Handle;
        if ($hostProcess.Path -ne (Join-Path $directory 'Rele.Process.exe') -or
          $hostProcess.StartTime.ToUniversalTime().ToString('o') -ne [string]$receipt.hostStartedAt) { throw 'Stale fixture host PID.' }
        $identity = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $hostProcess.Id);
        if ((Invoke-CimMethod -InputObject $identity -MethodName GetOwnerSid).Sid -ne $sid) { throw 'Foreign fixture process.' }
        $native = Get-Process -Id $receipt.nativePid -ErrorAction SilentlyContinue;
        if($native) {
          $nativePin=$native.Handle;
          $nativeIdentity=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $native.Id);
          if($native.Path -ne [string]$receipt.executable -or $native.StartTime.ToUniversalTime().ToString('o') -ne [string]$receipt.nativeStartedAt -or
            $nativeIdentity.ParentProcessId -ne $hostProcess.Id -or (Invoke-CimMethod -InputObject $nativeIdentity -MethodName GetOwnerSid).Sid -ne $sid -or
            (Get-FileHash -LiteralPath $native.Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $marker.ExecutableSha256) { throw 'Stale fixture native PID.' }
        }
        $hostProcess.Kill();
        if (-not $hostProcess.WaitForExit(10000) -or ($native -and -not $native.WaitForExit(10000))) { throw 'Fixture Job did not exit.' }
      }
      if ($task) {
        $drain=[Diagnostics.Stopwatch]::StartNew();
        while (($task.State -in @(2,4) -or $task.GetInstances(0).Count -gt 0) -and $drain.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 100 }
        if ($task.State -notin @(1,3) -or $task.GetInstances(0).Count -ne 0) { throw 'The disabled fixture Task still has an unconfirmed instance; retain it and the fixture.' }
        $folder.DeleteTask($owner.taskName, 0);
      }
      '{"status":"stopped"}'`], { env: { ...process.env, RELE_FIXTURE_OWNER: JSON.stringify({ ...target.desktopOwner, ...(scheduledDirectory ? { scheduledDirectory } : {}) }) },
      encoding: 'utf8', timeout: scheduledDirectory ? 75_000 : 45_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || 'The isolated WebSocket owner must stop before its profile is removed.');
    return JSON.parse(result.stdout);
  }
  const env = { ...process.env, CODEX_HOME: target.codexHome };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[key];
  const result = spawnSync(target.executable, ['app-server', 'daemon', 'stop'], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, 'The isolated fixture daemon must stop before its profile is removed.');
  const output = JSON.parse(result.stdout);
  assert.ok(['stopped', 'notRunning'].includes(output.status));
  return output;
}

// Exercise Desktop's direct protocol without a CLI adapter or an additional native server.
export async function openInstallerWebSocket(target) {
  const { CodexClient } = await import('../dist/server/codex.js');
  const client = new CodexClient({ ...target, transport: 'websocket', endpoint: target.endpoint });
  await client.connect();
  return { call: (method, params = {}) => client.call(method, params), close: () => client.close() };
}

// Keep the installed immutable adapter open as Desktop would, including its executable/file locks.
export async function openInstallerAdapter(executable, env, args = ['app-server', '--listen', 'stdio://']) {
  const child = spawn(executable, args, { env, cwd: path.dirname(executable), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.resume();
  const pending = new Map();
  let nextId = 0;
  const closed = once(child, 'exit');
  void closed.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  const fail = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('The held installer adapter disconnected.')); } pending.clear(); };
  child.on('error', fail); child.on('exit', fail);
  lines.on('line', line => {
    try {
      const message = JSON.parse(line), request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error('The held installer adapter returned an RPC error.')); else request.resolve(message.result);
    } catch { fail(); }
  });
  const call = (method, params = method === 'configRequirements/read' ? undefined : {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The held installer adapter RPC timed out.')); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const close = async () => {
    child.stdin.end();
    let timeout;
    try { await Promise.race([closed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The held adapter did not close after EOF.')), 15_000); })]); }
    finally { clearTimeout(timeout); lines.close(); if (child.exitCode === null && child.signalCode === null) child.kill(); fail(); }
  };
  try {
    await call('initialize', { clientInfo: { name: 'rele_installer_desktop', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    return { child, call, close };
  } catch (error) { await close(); throw error; }
}
