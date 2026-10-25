import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ConfigStore, mergeConfig } from '../dist/server/config.js';
import { findCSharpCompiler } from './build-process-host.mjs';
import { installerCodex, sharedBackendPid, captureInstallerOwner, stopInstallerCodex, openInstallerWebSocket, removeInstallerFixture, closeInstallerChild } from './installer-codex-fixture.mjs';

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
let legacyClosed;
let originalDesktopEnvironment;
let codexFixture;
let sharedPid;
let heldAdapter;
let heldOwnerDirectory;
let fixturePanelToken;
let failed = false;

function run(command, args, options = {}) {
  const errorFile = path.basename(command).toLowerCase() === 'rele.exe' && ['desktop-integrate', 'desktop-unintegrate'].includes(args[0])
    ? path.join(temporary, `controller-${randomUUID()}.txt`) : undefined;
  const result = spawnSync(command, errorFile ? [...args, '--error-file', errorFile] : args,
    { encoding: 'utf8', env, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024, ...options });
  if (result.error) throw result.error;
  const controllerError = result.status !== 0 && errorFile && existsSync(errorFile) ? readFileSync(errorFile, 'utf8') : '';
  assert.equal(result.status, 0, result.stderr || controllerError || `${path.basename(command)} exited ${result.status}`);
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
async function assertOwnedDesktopEnvironment() {
  const settings = JSON.parse(await readFile(path.join(application, 'rele-install.json'), 'utf8'));
  assert.equal(settings.DesktopIntegrationOwned, true);
  assert.equal(settings.DesktopIntegrationRequested, true);
  assert.ok(!settings.DesktopIntegrationWarning);
  const values = desktopEnvironment();
  assert.equal(values.CODEX_CLI_PATH, null);
  assert.equal(values.CODEX_APP_SERVER_FORCE_CLI, null);
  assert.equal(values.CODEX_APP_SERVER_WS_URL, settings.CodexWebSocketEndpoint);
  assert.equal(settings.InstalledCodexWebSocketUrl, settings.CodexWebSocketEndpoint);
  assert.match(settings.CodexWebSocketEndpoint, /^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u);
  assert.ok(settings.CodexWebSocketOwnerDirectory.startsWith(path.join(data, 'codex-websocket-owners') + path.sep));
  return settings;
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
  `/DIR=${application}`, `/RELEDATADIR=${data}`, `/RELETASKNAME=${task}`, '/RELEPORT=0', `/RELECODEXHOME=${codexHome}`];
try {
  // A fixed AppId is deliberate; refuse to disturb any existing installation on a reused runner.
  assert.equal(powershell('Test-Path -LiteralPath $env:RELE_SMOKE_REGISTRY'), 'False', 'The CI user already has Rele installed.');
  assert.equal(powershell('(@(Get-ScheduledTask -TaskName $env:RELE_SMOKE_TASK -ErrorAction SilentlyContinue)).Count'), '0');
  assert.equal(powershell("(@(Get-ScheduledTask -TaskName ($env:RELE_SMOKE_TASK + '-Codex') -ErrorAction SilentlyContinue)).Count"), '0');
  originalDesktopEnvironment = desktopEnvironment();
  desktopEnvironment(emptyDesktopEnvironment);
  await mkdir(data, { recursive: true });
  codexFixture = await installerCodex(codexHome);
  const nativeConfig = new ConfigStore(data);
  await nativeConfig.load();
  fixturePanelToken = nativeConfig.panelToken;
  await nativeConfig.save(mergeConfig(nativeConfig.config, { codex: codexFixture }));
  codexFixture.installSettingsPath = path.join(application, 'rele-install.json');
  codexFixture.fixtureDataDirectory = data;
  codexFixture.fixtureTaskName = task;
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
  const legacyOwner = randomUUID();
  // Explorer may observe this real Startup fixture; only our explicitly owned child may persist.
  await writeFile(path.join(legacyRoot, 'dist', 'server', 'main.js'), `if (process.env.RELE_SMOKE_LEGACY_OWNER === ${JSON.stringify(legacyOwner)}) setInterval(() => {}, 1000);\n`);
  await writeFile(path.join(legacyRoot, 'package.json'), JSON.stringify({ name: 'rele', version: '0.1.0-rc.2' }));
  const literal = value => value.replaceAll('%', '%%');
  legacyContents = ['@echo off', 'chcp 65001 >nul', 'setlocal DisableDelayedExpansion',
    `set "CODEX_HOME=${literal(codexHome)}"`, `set "RELE_DATA_DIR=${literal(data)}"`, `cd /d "${literal(legacyRoot)}"`,
    `start "Rele" /min "${literal(path.join(legacyRoot, 'runtime', 'node.exe'))}" "${literal(path.join(legacyRoot, 'dist', 'server', 'main.js'))}"`, ''].join('\r\n');
  await writeFile(legacyStartup, legacyContents);
  legacyProcess = spawn(path.join(legacyRoot, 'runtime', 'node.exe'), [path.join(legacyRoot, 'dist', 'server', 'main.js')], { env: { ...env, RELE_SMOKE_LEGACY_OWNER: legacyOwner }, cwd: temporary, windowsHide: true, stdio: 'ignore' });
  legacyClosed = once(legacyProcess, 'close');
  void legacyClosed.catch(() => {});
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
  await closeInstallerChild(legacyProcess, legacyClosed);
  legacyProcess = undefined;
  legacyClosed = undefined;
  await rm(path.join(data, 'instance.json'));

  console.log('Windows installer smoke: fresh installation enables Desktop environment integration by default');
  run(installer, [...installArguments, `/LOG=${path.join(temporary, 'install.log')}`]);
  const launcher = path.join(application, 'Rele.exe');
  const runtime = path.join(application, 'runtime', 'node.exe');
  const main = path.join(application, 'dist', 'server', 'main.js');
  assert.equal(await exists(launcher), true);
  assert.equal(await exists(path.join(application, 'start-rele.cmd')), false, 'Installed startup must not depend on cmd.');
  assert.equal(run(runtime, [main, '--version']), metadata.version);
  instance = await ready();
  sharedPid = await sharedBackendPid(codexFixture);
  await assertOwnedDesktopEnvironment();

  console.log('Windows installer smoke: RC19 owned CLI hook migrates to address-only integration');
  run(launcher, ['desktop-unintegrate', '--quiet']);
  const legacyAdapter = path.join(data, 'codex-adapters', 'a'.repeat(64));
  await mkdir(legacyAdapter, { recursive: true });
  await copyFile(path.join(application, 'Rele.Codex.exe'), path.join(legacyAdapter, 'Rele.Codex.exe'));
  const legacySettings = JSON.parse(await readFile(path.join(application, 'rele-install.json'), 'utf8'));
  await writeFile(path.join(legacyAdapter, 'rele-install.json'), JSON.stringify({ DesktopAdapterVersion: 1, OwnerSid: legacySettings.OwnerSid, DataDirectory: data }));
  Object.assign(legacySettings, { DesktopIntegrationOwned: true, InstalledCodexWebSocketUrl: null,
    DesktopCliPath: path.join(legacyAdapter, 'Rele.Codex.exe'), PreviousCodexCliPath: null, PreviousForceCli: null });
  await writeFile(path.join(application, 'rele-install.json'), JSON.stringify(legacySettings));
  desktopEnvironment({ ...emptyDesktopEnvironment, CODEX_CLI_PATH: legacySettings.DesktopCliPath, CODEX_APP_SERVER_FORCE_CLI: '1' });
  run(launcher, ['desktop-integrate', '--quiet']);
  await assertOwnedDesktopEnvironment();
  await sharedBackendPid(codexFixture, sharedPid);

  console.log('Windows installer smoke: foreign Desktop settings are preserved without blocking installation');
  run(launcher, ['desktop-unintegrate', '--quiet']);
  assert.deepEqual(desktopEnvironment(), emptyDesktopEnvironment);
  const foreignDesktopEnvironment = { CODEX_CLI_PATH: 'C:\\Foreign Codex\\codex.exe', CODEX_APP_SERVER_FORCE_CLI: '0', CODEX_APP_SERVER_WS_URL: 'ws://127.0.0.1:59999' };
  desktopEnvironment(foreignDesktopEnvironment);
  const beforeConflictPid = instance.pid;
  run(installer, [...installArguments, '/TASKS=desktop', `/LOG=${path.join(temporary, 'foreign-desktop-upgrade.log')}`]);
  instance = await ready(beforeConflictPid);
  await sharedBackendPid(codexFixture, sharedPid);
  const settings = JSON.parse(await readFile(path.join(application, 'rele-install.json'), 'utf8'));
  await assertSamePath(settings.DataDirectory, data);
  assert.equal(settings.TaskName, task);
  await assertSamePath(settings.CodexHome, codexHome);
  assert.equal(settings.DesktopIntegrationOwned, false);
  assert.equal(settings.DesktopIntegrationRequested, true);
  assert.ok(settings.DesktopIntegrationWarning);
  assert.deepEqual(desktopEnvironment(), foreignDesktopEnvironment);
  const refused = spawnSync(launcher, ['desktop-integrate', '--quiet'], { env, windowsHide: true, timeout: 60_000 });
  assert.equal(refused.status, 1);
  assert.deepEqual(desktopEnvironment(), foreignDesktopEnvironment);
  desktopEnvironment(emptyDesktopEnvironment);
  run(launcher, ['desktop-integrate', '--quiet']);
  await assertOwnedDesktopEnvironment();
  const configBeforeRejectedChange = await readFile(path.join(data, 'config.json'));
  const environmentBeforeRejectedChange = desktopEnvironment();
  const rejectedChange = await fetch(new URL('/api/config', instance.address), { method: 'PUT',
    headers: { Authorization: `Bearer ${fixturePanelToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ codex: { transport: 'websocket', endpoint: 'ws://127.0.0.1:59998' } }), signal: AbortSignal.timeout(5000) });
  assert.equal(rejectedChange.status, 400);
  assert.match((await rejectedChange.json()).error, /отключите интеграцию Desktop/u);
  assert.deepEqual(await readFile(path.join(data, 'config.json')), configBeforeRejectedChange);
  assert.deepEqual(desktopEnvironment(), environmentBeforeRejectedChange);
  console.log('Windows installer smoke: selected upgrade automatically replaces a stale local WebSocket target');
  const configFile = path.join(data, 'config.json');
  await nativeConfig.save(mergeConfig(nativeConfig.config, { codex: { transport: 'websocket',
    executable: path.join(temporary, 'removed-desktop-version', 'codex.exe'), endpoint: 'ws://127.0.0.1:59998' } }));
  const legacyConfig = structuredClone(nativeConfig.config);
  const legacyConfigBytes = await readFile(configFile);
  assert.equal(JSON.parse(legacyConfigBytes).encoding, 'dpapi');
  const backupsBeforeSetup = new Set(await readdir(path.join(data, 'backups')));
  const beforeLegacyPid = instance.pid;
  run(installer, [...installArguments, `/LOG=${path.join(temporary, 'legacy-target-upgrade.log')}`]);
  instance = await ready(beforeLegacyPid);
  const migratedConfig = new ConfigStore(data);
  await migratedConfig.load();
  assert.deepEqual(migratedConfig.config, mergeConfig(legacyConfig, { codex: { transport: 'shared', executable: 'codex', endpoint: '' } }));
  assert.equal(migratedConfig.panelToken, fixturePanelToken);
  const sharedConfigBytes = await readFile(configFile);
  assert.equal(JSON.parse(sharedConfigBytes).encoding, 'dpapi');
  const setupBackups = (await readdir(path.join(data, 'backups'))).filter(name => name.startsWith('codex-setup-') && !backupsBeforeSetup.has(name));
  assert.equal(setupBackups.length, 1, 'Automatic migration must preserve exactly one original configuration backup.');
  const setupBackup = path.join(data, 'backups', setupBackups[0]);
  assert.deepEqual(await readdir(setupBackup), ['config.json'], 'The migration backup must contain only encrypted Rele configuration.');
  assert.deepEqual(await readFile(path.join(setupBackup, 'config.json')), legacyConfigBytes);
  await sharedBackendPid(codexFixture, sharedPid);
  await assertOwnedDesktopEnvironment();

  console.log('Windows installer smoke: explicit panel integration controls remain available after automatic setup');
  const integrationUrl = new URL('/api/codex/desktop-integration', instance.address);
  const panelHeaders = { authorization: `Bearer ${fixturePanelToken}`, 'content-type': 'application/json' };
  const integrationStatus = async () => {
    const response = await fetch(integrationUrl, { headers: panelHeaders, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual(await integrationStatus(), { available: true, enabled: true, lastCheckFailed: false });
  const disableDesktop = await fetch(integrationUrl, { method: 'POST', headers: panelHeaders,
    body: JSON.stringify({ enabled: false }), signal: AbortSignal.timeout(100_000) });
  assert.equal(disableDesktop.status, 200);
  assert.deepEqual(await disableDesktop.json(), { available: true, enabled: false, lastCheckFailed: false });
  assert.deepEqual(desktopEnvironment(), emptyDesktopEnvironment);
  assert.deepEqual(await readFile(configFile), sharedConfigBytes);
  const enableDesktop = await fetch(integrationUrl, { method: 'POST', headers: panelHeaders,
    body: JSON.stringify({ enabled: true }), signal: AbortSignal.timeout(100_000) });
  assert.equal(enableDesktop.status, 200);
  assert.deepEqual(await enableDesktop.json(), { available: true, enabled: true, lastCheckFailed: false });
  assert.equal(JSON.parse(await readFile(path.join(data, 'instance.json'), 'utf8')).pid, instance.pid, 'Integration retry must not restart Rele.');
  assert.deepEqual(await readFile(configFile), sharedConfigBytes);
  await sharedBackendPid(codexFixture, sharedPid);
  await assertOwnedDesktopEnvironment();

  console.log('Windows installer smoke: protected-settings failure removes only an owned hook and preserves settings bytes');
  const unreadableConfig = Buffer.from(JSON.stringify({ version: 1, encoding: 'dpapi', value: 'invalid-fixture-ciphertext' }));
  await writeFile(configFile, unreadableConfig);
  const protectedRefused = spawnSync(launcher, ['desktop-integrate', '--quiet'], { env, windowsHide: true, timeout: 60_000 });
  assert.equal(protectedRefused.status, 1);
  assert.deepEqual(desktopEnvironment(), emptyDesktopEnvironment);
  assert.deepEqual(await readFile(configFile), unreadableConfig);
  const protectedSettings = JSON.parse(await readFile(path.join(application, 'rele-install.json'), 'utf8'));
  assert.equal(protectedSettings.DesktopIntegrationOwned, false);
  assert.equal(protectedSettings.DesktopIntegrationRequested, true);
  assert.match(protectedSettings.DesktopIntegrationWarning, /защищённые настройки Rele/u);
  await writeFile(configFile, sharedConfigBytes);
  run(launcher, ['desktop-integrate', '--quiet']);
  const healthySettings = await assertOwnedDesktopEnvironment();
  const earlyPolicy = await openInstallerWebSocket(codexFixture);
  try {
    await earlyPolicy.call('configRequirements/read', {});
    await earlyPolicy.call('config/read', { includeLayers: false });
    assert.equal((await earlyPolicy.call('server/diagnostics')).process.id, sharedPid);
  } finally { await earlyPolicy.close(); }
  assert.deepEqual(await readFile(configFile), sharedConfigBytes);
  const integratedEnvironment = desktopEnvironment();
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
  // A gateway package change must preserve the independent native owner and address.
  const packageFile = path.join(application, 'package.json');
  const packageMetadata = JSON.parse(await readFile(packageFile, 'utf8'));
  await writeFile(packageFile, JSON.stringify({ ...packageMetadata, installerSnapshotFixture: randomUUID() }));
  run(launcher, ['desktop-integrate', '--quiet']);
  const heldSettings = await assertOwnedDesktopEnvironment();
  heldOwnerDirectory = heldSettings.CodexWebSocketOwnerDirectory;
  assert.equal(desktopEnvironment().CODEX_APP_SERVER_WS_URL, integratedEnvironment.CODEX_APP_SERVER_WS_URL);
  heldAdapter = await openInstallerWebSocket(codexFixture);
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
  const beforeRestartPid = instance.pid;
  run(launcher, ['restart', '--quiet']);
  instance = await ready(beforeRestartPid);
  assert.equal(await readFile(path.join(data, 'config.json'), 'utf8'), configured);
  await sharedBackendPid(codexFixture, sharedPid);
  assert.equal((await heldAdapter.call('server/diagnostics')).process.id, sharedPid);

  console.log('Windows installer smoke: same-version upgrade with backup');
  const beforeUpgradePid = instance.pid;
  const backupsBeforeUpgrade = new Set(await readdir(path.join(data, 'backups')));
  run(installer, [...installArguments, `/LOG=${path.join(temporary, 'upgrade.log')}`]);
  instance = await ready(beforeUpgradePid);
  await sharedBackendPid(codexFixture, sharedPid);
  assert.equal((await heldAdapter.call('server/diagnostics')).process.id, sharedPid);
  process.kill(sharedPid, 0);
  const upgradedSettings = await assertOwnedDesktopEnvironment();
  assert.equal(upgradedSettings.CodexWebSocketOwnerDirectory, heldOwnerDirectory);
  assert.equal(await exists(path.join(heldOwnerDirectory, 'Rele.Process.exe')), true);
  assert.equal(await readFile(path.join(data, 'preserve-me.txt'), 'utf8'), 'installer smoke data\n');
  assert.equal(await readFile(path.join(data, 'config.json'), 'utf8'), configured);
  const backups = (await readdir(path.join(data, 'backups'))).filter(name => !backupsBeforeUpgrade.has(name));
  assert.equal(backups.length, 1, 'An upgrade must create a backup before replacing the program.');
  assert.equal(await exists(path.join(data, 'backups', backups[0], 'rele.sqlite')), true);
  assert.equal(await readFile(path.join(data, 'backups', backups[0], 'config.json'), 'utf8'), configured);

  console.log('Windows installer smoke: panel opt-out survives default upgrade and explicit installer choices take precedence');
  run(launcher, ['desktop-unintegrate', '--quiet']);
  const manuallyDisabled = JSON.parse(await readFile(path.join(application, 'rele-install.json'), 'utf8'));
  assert.equal(manuallyDisabled.DesktopIntegrationRequested, false);
  assert.deepEqual(desktopEnvironment(), emptyDesktopEnvironment);
  for (const [suffix, options, enabled] of [
    ['preserve-panel-opt-out', [], false],
    ['override-panel-opt-out', ['/TASKS=desktop'], true],
    ['opt-out', ['/MERGETASKS=!desktop'], false],
    ['preserve-opt-out', [], false],
  ]) {
    const previousPid = instance.pid;
    run(installer, [...installArguments, ...options, `/LOG=${path.join(temporary, suffix + '.log')}`]);
    instance = await ready(previousPid);
    const choice = JSON.parse(await readFile(path.join(application, 'rele-install.json'), 'utf8'));
    assert.equal(choice.DesktopIntegrationRequested, enabled);
    assert.equal(choice.DesktopIntegrationOwned, enabled);
    assert.ok(!choice.DesktopIntegrationWarning);
    if (enabled) await assertOwnedDesktopEnvironment();
    else assert.deepEqual(desktopEnvironment(), emptyDesktopEnvironment);
    await sharedBackendPid(codexFixture, sharedPid);
    assert.equal((await heldAdapter.call('server/diagnostics')).process.id, sharedPid);
    assert.equal(await readFile(path.join(data, 'config.json'), 'utf8'), configured);
  }

  console.log('Windows installer smoke: owned Desktop settings restore and later foreign changes survive uninstall');
  run(launcher, ['desktop-integrate', '--quiet']);
  await assertOwnedDesktopEnvironment();
  run(launcher, ['desktop-unintegrate', '--quiet']);
  assert.deepEqual(desktopEnvironment(), emptyDesktopEnvironment);
  run(launcher, ['desktop-integrate', '--quiet']);
  const changedDesktopEnvironment = { ...desktopEnvironment(), CODEX_APP_SERVER_WS_URL: foreignDesktopEnvironment.CODEX_APP_SERVER_WS_URL };
  desktopEnvironment(changedDesktopEnvironment);
  console.log('Windows installer smoke: uninstall preserves data');
  run(path.join(application, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${path.join(temporary, 'uninstall.log')}`]);
  uninstalled = true;
  await stopped(instance.address);
  await sharedBackendPid(codexFixture, sharedPid);
  assert.equal((await heldAdapter.call('server/diagnostics')).process.id, sharedPid);
  process.kill(sharedPid, 0);
  assert.equal(await exists(path.join(heldOwnerDirectory, 'Rele.Process.exe')), true);
  assert.equal(powershell('(@(Get-ScheduledTask -TaskName $env:RELE_SMOKE_TASK -ErrorAction SilentlyContinue)).Count'), '0');
  assert.equal(powershell('Test-Path -LiteralPath $env:RELE_SMOKE_REGISTRY'), 'False');
  assert.equal(await exists(launcher), false);
  assert.deepEqual(desktopEnvironment(), { ...emptyDesktopEnvironment, CODEX_APP_SERVER_WS_URL: foreignDesktopEnvironment.CODEX_APP_SERVER_WS_URL });
  assert.equal(await exists(path.join(data, 'rele.sqlite')), true);
  assert.equal(await readFile(path.join(data, 'config.json'), 'utf8'), configured);
  assert.equal(await readFile(path.join(data, 'preserve-me.txt'), 'utf8'), 'installer smoke data\n');
  assert.equal(powershell("(@(Get-ScheduledTask -TaskName ($env:RELE_SMOKE_TASK + '-Codex') -ErrorAction SilentlyContinue)).Count"), '0');
  console.log('Windows installer smoke: reinstall adopts the surviving native owner without a second launch');
  desktopEnvironment(emptyDesktopEnvironment);
  uninstalled = false;
  run(installer, [...installArguments, '/TASKS=desktop', `/LOG=${path.join(temporary, 'reinstall.log')}`]);
  instance = await ready();
  await sharedBackendPid(codexFixture, sharedPid);
  const reinstalled = await assertOwnedDesktopEnvironment();
  assert.equal(reinstalled.CodexWebSocketOwnerDirectory, heldOwnerDirectory);
  assert.equal(reinstalled.CodexWebSocketEndpoint, integratedEnvironment.CODEX_APP_SERVER_WS_URL);
  assert.equal((await heldAdapter.call('server/diagnostics')).process.id, sharedPid);
  assert.equal(await readFile(path.join(data, 'config.json'), 'utf8'), configured);
  run(path.join(application, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
  uninstalled = true;
  await stopped(instance.address);
  await sharedBackendPid(codexFixture, sharedPid);
  assert.equal((await heldAdapter.call('server/diagnostics')).process.id, sharedPid);
  assert.deepEqual(desktopEnvironment(), emptyDesktopEnvironment);
  assert.equal(powershell("(@(Get-ScheduledTask -TaskName ($env:RELE_SMOKE_TASK + '-Codex') -ErrorAction SilentlyContinue)).Count"), '0');
  const preflightTasks = powershell(`(@(Get-ScheduledTask -TaskName 'Rele-DesktopCheck-*' -ErrorAction SilentlyContinue | Where-Object {
    $_.Actions.Count -eq 1 -and $_.Actions[0].Execute -eq (Join-Path $env:RELE_SMOKE_APP 'Rele.exe') -and
    $_.Actions[0].Arguments -like 'desktop-check *'
  })).Count`);
  assert.equal(preflightTasks, '0', 'Completed and failed Desktop preflight tasks must be removed.');
  const report = { platform: 'windows', version: metadata.version, installer: path.basename(installer), result: 'passed', perUser: true, interactiveToken: true, nativeLauncher: true, legacyStartupMigrated: true, foreignProcessPreserved: true, codexConsoleWrapper: true, immutableNativeOwnerPreservedAcrossUpgradeRemove: true, desktopAddressOnly: true, desktopEnvironmentOwnership: true, desktopEnvironmentFreshDefault: true, desktopEnvironmentUpgradeChoice: true, desktopEnvironmentOptOutPreserved: true, desktopLegacyLocalTargetAutomaticallyMigrated: true, desktopLegacyEncryptedConfigurationPreserved: true, desktopPanelOptOutPreserved: true, desktopExplicitInstallerChoiceOverridesPanelOptOut: true, desktopPanelControls: true, desktopProtectedSettingsFailureSafelySkipped: true, desktopConfigChangeWhileIntegratedRejected: true, actualEarlyDesktopPolicyRpc: true, temporaryDesktopPreflightTasksRemoved: true, nativeBackendPreservedAcrossRestartUpgradeRemove: true, nativeOwnerAdoptedAfterReinstall: true, health: true, restart: true, upgradeBackup: true, uninstall: true, dataPreserved: true };
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
  const describeUrl = value => {
    if (value == null || value === '') return { kind: 'empty' };
    if (typeof value !== 'string') return { kind: 'invalid' };
    const match = /^ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/u.exec(value);
    return match?.[0] === value && Number(match[1]) <= 65535 ? { kind: 'loopback', value }
      : { kind: 'other', sha256: createHash('sha256').update(value).digest('hex') };
  };
  try {
    const marker = JSON.parse(await readFile(path.join(application, 'rele-install.json'), 'utf8'));
    evidence.desktopIntegration = {};
    for (const key of ['DesktopIntegrationRequested', 'DesktopIntegrationOwned']) {
      evidence.desktopIntegration[key] = typeof marker[key] === 'boolean' ? marker[key] : null;
    }
    for (const key of ['InstalledCodexWebSocketUrl', 'PreviousCodexWebSocketUrl', 'CodexWebSocketEndpoint']) evidence.desktopIntegration[key] = describeUrl(marker[key]);
    const warning = marker.DesktopIntegrationWarning;
    evidence.desktopIntegration.DesktopIntegrationWarning = typeof warning === 'string' && warning
      ? { present: true, sha256: createHash('sha256').update(warning).digest('hex') } : { present: false };
  } catch { evidence.desktopIntegration = { unavailable: true }; }
  evidence.desktopEnvironment = { caller: Object.entries(env).filter(([key]) => key.toUpperCase() === 'CODEX_APP_SERVER_WS_URL')
    .map(([key, value]) => ({ key, ...describeUrl(value) })) };
  try { evidence.desktopEnvironment.user = describeUrl(desktopEnvironment().CODEX_APP_SERVER_WS_URL); }
  catch { evidence.desktopEnvironment.user = { unavailable: true }; }
  try {
    evidence.desktopEnvironment.machine = describeUrl(JSON.parse(powershell("@{ value = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'Machine') } | ConvertTo-Json -Compress")).value);
  } catch { evidence.desktopEnvironment.machine = { unavailable: true }; }
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
  if (codexFixture?.desktopOwner) {
    try {
      const receipt = JSON.parse(await readFile(path.join(codexFixture.desktopOwner.directory, 'receipt.json'), 'utf8'));
      evidence.native = Object.fromEntries(['status', 'hostPid', 'nativePid', 'exitCode'].map(key => [key, receipt[key]]));
    } catch { evidence.native = { receipt: 'unavailable' }; }
  }
  await writeFile(path.join(reportDirectory, 'installer-failure-results.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.error(JSON.stringify(evidence));
  throw error;
} finally {
  if (legacyProcess) await closeInstallerChild(legacyProcess, legacyClosed);
  if (codexFixture && !codexFixture.desktopOwner) {
    try { await captureInstallerOwner(codexFixture); } catch {}
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
  console.log('Windows installer cleanup: desktop-environment');
  if (originalDesktopEnvironment) desktopEnvironment(originalDesktopEnvironment);
  console.log('Windows installer cleanup: direct-client');
  if (heldAdapter) await heldAdapter.close();
  console.log('Windows installer cleanup: native-owner');
  stopInstallerCodex(codexFixture);
  console.log('Windows installer cleanup: files');
  if (!failed) {
    const reportPath = path.join(reportDirectory, 'installer-results.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    try { await removeInstallerFixture(temporary); }
    catch (error) {
      report.cleanup = { result: 'failed', code: error.code, ...(error.relativePath ? { relativePath: error.relativePath } : {}) };
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      throw error;
    }
    report.cleanup = { result: 'passed' };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  else console.error(`Failed fixture files retained until runner disposal: ${temporary}`);
  console.log('Windows installer cleanup: complete');
}
