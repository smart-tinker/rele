import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ConfigStore, mergeConfig } from '../dist/server/config.js';
import { findCSharpCompiler } from './build-process-host.mjs';
import { installerCodex, sharedBackendPid, stopInstallerCodex, openInstallerAdapter } from './installer-codex-fixture.mjs';

if (process.platform !== 'win32' || process.env.CI !== 'true') throw new Error('The installer smoke test runs only on an isolated Windows CI runner.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDirectory = path.resolve(process.env.RELE_TEST_REPORT_DIR || root);
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const installer = path.resolve(process.argv[2] || path.join(root, 'release', `rele-${metadata.version}-windows-x64-setup.exe`));
const hash = createHash('sha256');
for await (const chunk of createReadStream(installer)) hash.update(chunk);
assert.equal(hash.digest('hex'), (await readFile(`${installer}.sha256`, 'utf8')).split(/\s/u)[0], 'Installer checksum mismatch');
const temporary = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'ri-'));
const application = path.join(temporary, 'Installed Rele');
const data = path.join(temporary, 'User Data');
const codexHome = path.join(temporary, 'Isolated Codex');
const task = `Rele-Smoke-${randomUUID()}`;
const uninstallKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{3F09F239-2927-4ED8-9431-A74CCED1D5EB}_is1';
const env = { ...process.env, RELE_SMOKE_APP: application, RELE_SMOKE_TASK: task, RELE_SMOKE_REGISTRY: uninstallKey, RELE_DATA_DIR: data, RELE_PORT: '0', CODEX_HOME: codexHome };
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_CLI_PATH', 'CODEX_APP_SERVER_FORCE_CLI', 'CODEX_APP_SERVER_WS_URL']) delete env[key];
let instance;
let installationAttempted = false;
let uninstalled = false;
let legacyStartup;
let legacyContents;
let legacyProcess;
let originalDesktopEnvironment;
let codexFixture;
let sharedPid;
let heldAdapter;
let heldAdapterPath;
let fixturePanelToken;
let failed = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || `${path.basename(command)} exited ${result.status}`);
  return result.stdout.trim();
}
function powershell(code, options) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${code}`], options);
}
function desktopEnvironment(values) {
  if (values) {
    powershell(`$values = $env:RELE_SMOKE_DESKTOP_ENV | ConvertFrom-Json;
      foreach ($name in @('CODEX_CLI_PATH', 'CODEX_APP_SERVER_FORCE_CLI', 'CODEX_APP_SERVER_WS_URL')) {
        [Environment]::SetEnvironmentVariable($name, $values.$name, 'User');
      }`, { env: { ...env, RELE_SMOKE_DESKTOP_ENV: JSON.stringify(values) } });
    return;
  }
  return JSON.parse(powershell(`$values = @{};
    foreach ($name in @('CODEX_CLI_PATH', 'CODEX_APP_SERVER_FORCE_CLI', 'CODEX_APP_SERVER_WS_URL')) {
      $values[$name] = [Environment]::GetEnvironmentVariable($name, 'User');
    }; $values | ConvertTo-Json -Compress`));
}
const emptyDesktopEnvironment = { CODEX_CLI_PATH: null, CODEX_APP_SERVER_FORCE_CLI: null, CODEX_APP_SERVER_WS_URL: null };
async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}
async function assertSamePath(actual, expected) {
  const [actualPath, expectedPath] = await Promise.all([realpath(actual), realpath(expected)]);
  assert.equal(actualPath.toLowerCase(), expectedPath.toLowerCase());
}
async function ready(previousPid) {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const current = JSON.parse(await readFile(path.join(data, 'instance.json'), 'utf8'));
      const address = new URL(current.address);
      assert.equal(address.hostname, '127.0.0.1');
      if (current.pid !== previousPid) {
        const response = await fetch(new URL('/api/health', address), { signal: AbortSignal.timeout(500) });
        if (response.ok && (await response.json()).version === metadata.version) return current;
      }
    } catch {}
    await delay(100);
  }
  const log = await readFile(path.join(data, 'logs', 'service.log'), 'utf8').catch(() => 'No service log.');
  throw new Error(`Installed Rele did not become ready. ${log.slice(-6000)}`);
}
async function stopped(address) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fetch(new URL('/api/health', address), { signal: AbortSignal.timeout(300) }); }
    catch { return; }
    await delay(100);
  }
  throw new Error('The installed Rele server is still running.');
}

const installArguments = ['/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
  '/TASKS=desktop', `/DIR=${application}`, `/RELEDATADIR=${data}`, `/RELETASKNAME=${task}`, '/RELEPORT=0', `/RELECODEXHOME=${codexHome}`];
try {
  // A fixed AppId is deliberate; refuse to disturb any existing installation on a reused runner.
  assert.equal(powershell('Test-Path -LiteralPath $env:RELE_SMOKE_REGISTRY'), 'False', 'The CI user already has Rele installed.');
  assert.equal(powershell('(@(Get-ScheduledTask -TaskName $env:RELE_SMOKE_TASK -ErrorAction SilentlyContinue)).Count'), '0');
  originalDesktopEnvironment = desktopEnvironment();
  desktopEnvironment(emptyDesktopEnvironment);
  await mkdir(data, { recursive: true });
  codexFixture = await installerCodex(codexHome);
  const nativeConfig = new ConfigStore(data);
  await nativeConfig.load();
  fixturePanelToken = nativeConfig.panelToken;
  await nativeConfig.save(mergeConfig(nativeConfig.config, { codex: codexFixture }));
  await writeFile(path.join(data, 'preserve-me.txt'), 'installer smoke data\n');

  legacyStartup = path.join(powershell("[Environment]::GetFolderPath([Environment+SpecialFolder]::Startup, [Environment+SpecialFolderOption]::DoNotVerify)"), 'Rele.cmd');
  assert.equal(await exists(legacyStartup), false, 'The CI user already has a Rele startup script.');
  await mkdir(path.dirname(legacyStartup), { recursive: true });
  console.log('Windows installer smoke: an unknown startup script is preserved');
  legacyContents = '@echo off\r\necho unrelated startup fixture\r\n';
  await writeFile(legacyStartup, legacyContents);
  installationAttempted = true;
  const unknown = spawnSync(installer, [...installArguments, `/LOG=${path.join(temporary, 'blocked-unknown.log')}`], { env, windowsHide: true, timeout: 60_000 });
  if (unknown.error) throw unknown.error;
  assert.notEqual(unknown.status, 0, 'An unknown startup file must require manual review.');
  assert.match(await readFile(path.join(temporary, 'blocked-unknown.log'), 'utf8'), /В автозагрузке найден Rele\.cmd, который нельзя безопасно перенести/u,
    'The refusal must identify the unknown startup script, not an unrelated installer error.');
  assert.equal(await readFile(legacyStartup, 'utf8'), legacyContents);
  assert.equal(await exists(path.join(application, 'runtime', 'node.exe')), false);

  console.log('Windows installer smoke: a previous portable process is not killed');
  const legacyRoot = path.join(temporary, 'Legacy Rele % fixture');
  await mkdir(path.join(legacyRoot, 'runtime'), { recursive: true });
  await mkdir(path.join(legacyRoot, 'dist', 'server'), { recursive: true });
  await copyFile(process.execPath, path.join(legacyRoot, 'runtime', 'node.exe'));
  await writeFile(path.join(legacyRoot, 'dist', 'server', 'main.js'), 'setInterval(() => {}, 1000);\n');
  await writeFile(path.join(legacyRoot, 'package.json'), JSON.stringify({ name: 'rele', version: '0.1.0-rc.2' }));
  const literal = value => value.replaceAll('%', '%%');
  legacyContents = ['@echo off', 'chcp 65001 >nul', 'setlocal DisableDelayedExpansion',
    `set "CODEX_HOME=${literal(codexHome)}"`, `set "RELE_DATA_DIR=${literal(data)}"`, `cd /d "${literal(legacyRoot)}"`,
    `start "Rele" /min "${literal(path.join(legacyRoot, 'runtime', 'node.exe'))}" "${literal(path.join(legacyRoot, 'dist', 'server', 'main.js'))}"`, ''].join('\r\n');
  await writeFile(legacyStartup, legacyContents);
  legacyProcess = spawn(path.join(legacyRoot, 'runtime', 'node.exe'), [path.join(legacyRoot, 'dist', 'server', 'main.js')], { env, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { legacyProcess.once('spawn', resolve); legacyProcess.once('error', reject); });
  await writeFile(path.join(data, 'instance.json'), JSON.stringify({ pid: legacyProcess.pid, address: 'http://127.0.0.1:1', version: '0.1.0-rc.2' }));
  const blocked = spawnSync(installer, [...installArguments, `/LOG=${path.join(temporary, 'blocked-legacy.log')}`], { env, windowsHide: true, timeout: 60_000 });
  if (blocked.error) throw blocked.error;
  assert.notEqual(blocked.status, 0);
  assert.match(await readFile(path.join(temporary, 'blocked-legacy.log'), 'utf8'), /Rele с этим каталогом данных запущен из другой папки/u,
    'The refusal must identify the previous portable process, not an unrelated installer error.');
  process.kill(legacyProcess.pid, 0);
  assert.equal(await readFile(legacyStartup, 'utf8'), legacyContents);
  assert.equal(await exists(path.join(application, 'runtime', 'node.exe')), false);
  legacyProcess.kill();
  await new Promise(resolve => legacyProcess.once('exit', resolve));
  legacyProcess = undefined;
  await rm(path.join(data, 'instance.json'));

  console.log('Windows installer smoke: foreign Desktop settings are preserved without blocking installation');
  const foreignDesktopEnvironment = { CODEX_CLI_PATH: 'C:\\Foreign Codex\\codex.exe', CODEX_APP_SERVER_FORCE_CLI: '0', CODEX_APP_SERVER_WS_URL: 'ws://127.0.0.1:59999' };
  desktopEnvironment(foreignDesktopEnvironment);
  run(installer, [...installArguments, `/LOG=${path.join(temporary, 'install.log')}`]);
  const launcher = path.join(application, 'Rele.exe');
  const runtime = path.join(application, 'runtime', 'node.exe');
  const main = path.join(application, 'dist', 'server', 'main.js');
  assert.equal(await exists(launcher), true);
  assert.equal(await exists(path.join(application, 'start-rele.cmd')), false, 'Installed startup must not depend on cmd.');
  assert.equal(run(runtime, [main, '--version']), metadata.version);
  instance = await ready();
  const initialPid = instance.pid;
  sharedPid = await sharedBackendPid(codexFixture);
  const settings = JSON.parse(await readFile(path.join(application, 'rele-install.json'), 'utf8'));
  await assertSamePath(settings.DataDirectory, data);
  assert.equal(settings.TaskName, task);
  await assertSamePath(settings.CodexHome, codexHome);
  assert.equal(settings.DesktopIntegrationOwned, false);
  assert.ok(settings.DesktopIntegrationWarning);
  assert.deepEqual(desktopEnvironment(), foreignDesktopEnvironment);
  const refused = spawnSync(launcher, ['desktop-integrate', '--quiet'], { env, windowsHide: true, timeout: 60_000 });
  assert.equal(refused.status, 1);
  assert.deepEqual(desktopEnvironment(), foreignDesktopEnvironment);
  desktopEnvironment(emptyDesktopEnvironment);
  run(launcher, ['desktop-integrate', '--quiet']);
  const integratedEnvironment = desktopEnvironment();
  await assertSamePath(integratedEnvironment.CODEX_CLI_PATH, JSON.parse(await readFile(path.join(application, 'rele-install.json'), 'utf8')).DesktopCliPath);
  assert.ok(integratedEnvironment.CODEX_CLI_PATH.startsWith(path.join(data, 'codex-adapters') + path.sep));
  assert.equal(integratedEnvironment.CODEX_APP_SERVER_FORCE_CLI, '1');
  assert.equal(integratedEnvironment.CODEX_APP_SERVER_WS_URL, null);
  console.log('Windows installer smoke: the Codex wrapper preserves argv, profile, data and raw bytes');
  const shim = path.join(application, 'dist', 'server', 'codex-cli.js');
  const originalShim = await readFile(shim);
  try {
    await writeFile(shim, `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), data: process.env.RELE_DATA_DIR, profile: process.env.CODEX_HOME }) + '\\n'); process.stdin.pipe(process.stdout);`);
    const argv = ['app-server', 'two words', 'a"quote', 'C:\\space folder\\', 'Кодекс 🙂'];
    const payload = Buffer.from([0, 1, 0xff, 13, 10, 0x5c]);
    const wrapped = spawnSync(path.join(application, 'Rele.Codex.exe'), argv, { env, input: payload, windowsHide: true, timeout: 60_000 });
    assert.equal(wrapped.status, 0, wrapped.stderr?.toString());
    const newline = wrapped.stdout.indexOf(10);
    assert.deepEqual(JSON.parse(wrapped.stdout.subarray(0, newline).toString('utf8')), { args: argv, data, profile: codexHome });
    assert.deepEqual(wrapped.stdout.subarray(newline + 1), payload);
  } finally { await writeFile(shim, originalShim); }
  // A content change creates a fresh immutable bundle even when the app version stays the same.
  const packageFile = path.join(application, 'package.json');
  const packageMetadata = JSON.parse(await readFile(packageFile, 'utf8'));
  await writeFile(packageFile, JSON.stringify({ ...packageMetadata, installerSnapshotFixture: randomUUID() }));
  run(launcher, ['desktop-integrate', '--quiet']);
  heldAdapterPath = desktopEnvironment().CODEX_CLI_PATH;
  assert.notEqual(heldAdapterPath, integratedEnvironment.CODEX_CLI_PATH);
  heldAdapter = await openInstallerAdapter(heldAdapterPath, env);
  assert.equal((await heldAdapter.call('server/diagnostics')).process.id, sharedPid);
  assert.equal(await exists(legacyStartup), false, 'The known old startup script must be migrated after readiness.');
  const legacyBackup = (await readdir(path.join(data, 'backups'))).find(name => name.startsWith('legacy-startup-'));
  assert.ok(legacyBackup);
  assert.equal(await readFile(path.join(data, 'backups', legacyBackup, 'Rele.cmd'), 'utf8'), legacyContents);
  const configured = await readFile(path.join(data, 'config.json'), 'utf8');
  const taskInfo = JSON.parse(powershell(`
    function Resolve-UserSid([string]$UserId) {
      if ([string]::IsNullOrWhiteSpace($UserId)) { throw 'The task must identify its user.' }
      if ($UserId -match '^S-1-') { return ([System.Security.Principal.SecurityIdentifier]::new($UserId)).Value }
      return ([System.Security.Principal.NTAccount]::new($UserId)).Translate([System.Security.Principal.SecurityIdentifier]).Value;
    }
    $scheduler = New-Object -ComObject 'Schedule.Service';
    $scheduler.Connect();
    $definition = $scheduler.GetFolder('\\').GetTask($env:RELE_SMOKE_TASK).Definition;
    if ($definition.Actions.Count -ne 1) { throw 'The task must have exactly one action.' }
    $action = $definition.Actions.Item(1);
    if ($action.Type -ne 0) { throw 'The task action must be Exec.' }
    if ($definition.Triggers.Count -ne 1) { throw 'The task must have exactly one logon trigger.' }
    $trigger = $definition.Triggers.Item(1);
    if ($trigger.Type -ne 9) { throw 'The task trigger must be Logon.' }
    $limit = [string]$definition.Settings.ExecutionTimeLimit;
    $limitTicks = if ([string]::IsNullOrEmpty($limit)) { 0 } else { [System.Xml.XmlConvert]::ToTimeSpan($limit).Ticks };
    [pscustomobject]@{
      UserId = (Resolve-UserSid ([string]$definition.Principal.UserId));
      CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      LogonType = [int]$definition.Principal.LogonType;
      RunLevel = [int]$definition.Principal.RunLevel;
      TriggerUser = (Resolve-UserSid ([string]$trigger.UserId));
      Command = [string]$action.Path;
      Arguments = [string]$action.Arguments;
      ExecutionTimeLimitTicks = $limitTicks;
      RestartCount = [int]$definition.Settings.RestartCount;
      RegistryPath = (Get-ItemProperty -LiteralPath $env:RELE_SMOKE_REGISTRY).InstallLocation;
    } | ConvertTo-Json -Compress`));
  assert.equal(taskInfo.UserId, taskInfo.CurrentUser);
  assert.equal(taskInfo.TriggerUser, taskInfo.CurrentUser);
  assert.equal(taskInfo.LogonType, 3, 'The task must use the current user interactive token.');
  assert.equal(taskInfo.RunLevel, 0, 'The task must run with least privilege.');
  await assertSamePath(taskInfo.Command, launcher);
  assert.equal(taskInfo.Arguments, 'serve');
  assert.equal(taskInfo.ExecutionTimeLimitTicks, 0, 'The background task must have no execution time limit.');
  assert.ok(taskInfo.RestartCount > 0);
  await assertSamePath(taskInfo.RegistryPath, application);
  assert.equal((await fetch(new URL('/api/state', instance.address))).status, 401);
  const login = new URL(run(runtime, [main, 'open', '--print-url']));
  assert.equal(login.origin, new URL(instance.address).origin, 'The explicit browser link must point to this installed instance.');

  console.log('Windows installer smoke: launcher restart');
  run(launcher, ['restart', '--quiet']);
  instance = await ready(initialPid);
  assert.equal(await readFile(path.join(data, 'config.json'), 'utf8'), configured);
  await sharedBackendPid(codexFixture, sharedPid);
  assert.equal((await heldAdapter.call('server/diagnostics')).process.id, sharedPid);

  console.log('Windows installer smoke: same-version upgrade with backup');
  const beforeUpgradePid = instance.pid;
  run(installer, [...installArguments, `/LOG=${path.join(temporary, 'upgrade.log')}`]);
  instance = await ready(beforeUpgradePid);
  await sharedBackendPid(codexFixture, sharedPid);
  assert.equal((await heldAdapter.call('server/diagnostics')).process.id, sharedPid);
  process.kill(heldAdapter.child.pid, 0);
  const upgradedSettings = JSON.parse(await readFile(path.join(application, 'rele-install.json'), 'utf8'));
  assert.notEqual(upgradedSettings.DesktopCliPath, heldAdapterPath);
  assert.equal(await exists(heldAdapterPath), true);
  assert.equal(await readFile(path.join(data, 'preserve-me.txt'), 'utf8'), 'installer smoke data\n');
  assert.equal(await readFile(path.join(data, 'config.json'), 'utf8'), configured);
  const backups = (await readdir(path.join(data, 'backups'))).filter(name => !name.startsWith('legacy-startup-'));
  assert.ok(backups.length > 0, 'An upgrade must create a backup before replacing the program.');
  assert.equal(await exists(path.join(data, 'backups', backups[0], 'rele.sqlite')), true);
  assert.equal(await readFile(path.join(data, 'backups', backups[0], 'config.json'), 'utf8'), configured);

  console.log('Windows installer smoke: owned Desktop settings restore and later foreign changes survive uninstall');
  run(launcher, ['desktop-unintegrate', '--quiet']);
  assert.deepEqual(desktopEnvironment(), emptyDesktopEnvironment);
  run(launcher, ['desktop-integrate', '--quiet']);
  const changedDesktopEnvironment = { ...desktopEnvironment(), CODEX_CLI_PATH: foreignDesktopEnvironment.CODEX_CLI_PATH };
  desktopEnvironment(changedDesktopEnvironment);
  console.log('Windows installer smoke: uninstall preserves data');
  run(path.join(application, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${path.join(temporary, 'uninstall.log')}`]);
  uninstalled = true;
  await stopped(instance.address);
  await sharedBackendPid(codexFixture, sharedPid);
  assert.equal((await heldAdapter.call('server/diagnostics')).process.id, sharedPid);
  process.kill(heldAdapter.child.pid, 0);
  assert.equal(await exists(heldAdapterPath), true);
  assert.equal(powershell('(@(Get-ScheduledTask -TaskName $env:RELE_SMOKE_TASK -ErrorAction SilentlyContinue)).Count'), '0');
  assert.equal(powershell('Test-Path -LiteralPath $env:RELE_SMOKE_REGISTRY'), 'False');
  assert.equal(await exists(launcher), false);
  assert.deepEqual(desktopEnvironment(), { ...emptyDesktopEnvironment, CODEX_CLI_PATH: foreignDesktopEnvironment.CODEX_CLI_PATH, CODEX_APP_SERVER_FORCE_CLI: '1' });
  assert.equal(await exists(path.join(data, 'rele.sqlite')), true);
  assert.equal(await readFile(path.join(data, 'config.json'), 'utf8'), configured);
  assert.equal(await readFile(path.join(data, 'preserve-me.txt'), 'utf8'), 'installer smoke data\n');
  const report = { platform: 'windows', version: metadata.version, installer: path.basename(installer), result: 'passed', perUser: true, interactiveToken: true, nativeLauncher: true, legacyStartupMigrated: true, foreignProcessPreserved: true, codexConsoleWrapper: true, immutableOpenAdapterPreservedAcrossUpgradeRemove: true, desktopEnvironmentOwnership: true, nativeBackendPreservedAcrossRestartUpgradeRemove: true, health: true, restart: true, upgradeBackup: true, uninstall: true, dataPreserved: true };
  await writeFile(path.join(reportDirectory, 'installer-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch (error) {
  failed = true;
  // This profile contains only an offline fixture; capture startup evidence before teardown.
  const sanitize = value => {
    let text = String(value || '');
    if (fixturePanelToken) text = text.split(fixturePanelToken).join('[fixture-panel-key]');
    return text.replace(/#rele-launch=[A-Za-z0-9_-]+/gu, '#rele-launch=[redacted]');
  };
  const serviceLog = await readFile(path.join(data, 'logs', 'service.log'), 'utf8').catch(() => 'No fixture service log.');
  const evidence = { platform: 'windows', result: 'failed', error: sanitize(error.message), serviceLog: sanitize(serviceLog.slice(-12_000)), native: {} };
  if (instance) {
    try {
      const address = new URL(instance.address);
      if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.username || address.password) throw new Error('Invalid fixture address.');
      const response = await fetch(new URL('/api/state', address), { headers: { Authorization: `Bearer ${fixturePanelToken}` }, redirect: 'error', signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`Fixture state HTTP ${response.status}.`);
      const state = await response.json();
      evidence.codex = {};
      for (const key of ['connected', 'error', 'errorCode', 'transport', 'executable', 'endpoint', 'codexHome', 'queueSupported']) {
        const value = state.codex?.[key];
        if (typeof value === 'string' || typeof value === 'boolean') evidence.codex[key] = typeof value === 'string' ? sanitize(value) : value;
      }
    } catch (stateError) { evidence.fixtureStateError = sanitize(stateError.message); }
    try {
      const compiler = await findCSharpCompiler();
      const helper = path.join(temporary, 'FixtureElevation.exe');
      const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/codepage:65001', `/out:${helper}`, path.join(root, 'scripts/windows/FixtureElevation.cs')], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      if (compiled.status !== 0) throw new Error('Fixture elevation helper compilation failed.');
      const queried = spawnSync(helper, [String(instance.pid), path.join(application, 'runtime/node.exe')], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      if (queried.status !== 0) throw new Error('Fixture process identity or token elevation could not be verified.');
      evidence.taskProcessToken = JSON.parse(queried.stdout);
    } catch (tokenError) { evidence.fixtureTokenError = sanitize(tokenError.message); }
  }
  if (codexFixture) {
    // Diagnostic start runs only after this test has already failed; it can never satisfy the lifecycle assertion.
    for (const operation of ['version', 'start']) {
      const control = spawnSync(codexFixture.executable, ['app-server', 'daemon', operation], { env, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      evidence.native[operation] = { code: control.status, error: control.error?.code, stdout: sanitize(control.stdout?.slice(-4000)), stderr: sanitize(control.stderr?.slice(-4000)) };
    }
  }
  await writeFile(path.join(reportDirectory, 'installer-failure-results.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.error(JSON.stringify(evidence));
  throw error;
} finally {
  if (legacyProcess && legacyProcess.exitCode === null && legacyProcess.signalCode === null) {
    legacyProcess.kill();
    await new Promise(resolve => legacyProcess.once('exit', resolve));
  }
  if (installationAttempted && !uninstalled) {
    const uninstaller = path.join(application, 'unins000.exe');
    if (await exists(uninstaller)) {
      try { run(uninstaller, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']); } catch {}
    }
    // This fallback is limited to the random test task whose executable is inside this test directory.
    try {
      powershell(`
        $task = Get-ScheduledTask -TaskName $env:RELE_SMOKE_TASK -ErrorAction SilentlyContinue;
        if ($task) {
          $expected = Join-Path $env:RELE_SMOKE_APP 'Rele.exe';
          if ($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne $expected) { throw 'Refusing to touch another task.' }
          Stop-ScheduledTask -TaskName $env:RELE_SMOKE_TASK;
          Unregister-ScheduledTask -TaskName $env:RELE_SMOKE_TASK -Confirm:$false;
        }`);
    } catch {}
  }
  if (legacyStartup && legacyContents && await readFile(legacyStartup, 'utf8').catch(() => '') === legacyContents) await rm(legacyStartup);
  for (const file of ['blocked-unknown.log', 'blocked-legacy.log', 'install.log', 'upgrade.log', 'uninstall.log']) {
    const contents = await readFile(path.join(temporary, file), 'utf8').catch(() => '');
    if (contents && !uninstalled) console.error(`${file}:\n${contents.slice(-7000)}`);
  }
  if (originalDesktopEnvironment) desktopEnvironment(originalDesktopEnvironment);
  if (heldAdapter) await heldAdapter.close();
  stopInstallerCodex(codexFixture);
  if (!failed) await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  else console.error(`Failed fixture files retained until runner disposal: ${temporary}`);
}
