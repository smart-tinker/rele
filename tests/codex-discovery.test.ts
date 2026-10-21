import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { discoverCodex, runCodexProbe, WINDOWS_CODEX_PROCESS_PROVIDER_SCRIPT, WINDOWS_CODEX_METADATA_SCRIPT, WINDOWS_CODEX_PROCESS_METADATA_SCRIPT, type CodexDiscoveryOptions } from '../src/server/codex-discovery.js';
import { codexEnvironment, resolveCodexLaunch } from '../src/server/codex-launch.js';

const win = path.win32;
const desktop = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1_x64__example\\app\\resources\\codex.exe';
const desktopGui = win.join(win.dirname(win.dirname(desktop)), 'Codex.exe');
const npmRoot = 'C:\\Users\\Example User\\AppData\\Roaming\\npm';
const npmShim = win.join(npmRoot, 'codex.cmd');
const npmPackage = win.join(npmRoot, 'node_modules', '@openai', 'codex');
const npmEntry = win.join(npmPackage, 'bin', 'codex.js');
const socket = 'C:\\Users\\Example User\\.codex\\app-server-control\\app-server-control.sock';

function windowsMetadataFixture(provider: string, script: string, appx = 'function Get-AppxPackage { [CmdletBinding()] param([string]$Name); @() }') {
  expect(script.split(WINDOWS_CODEX_PROCESS_PROVIDER_SCRIPT)).toHaveLength(2);
  const fake = '$script:releFixtureQueries = 0; $script:releFixtureClosures = 0\n' + provider + '\nfunction Close-ReleProcessQuery { $script:releFixtureClosures++ }\n';
  const fixtureScript = script.replace(WINDOWS_CODEX_PROCESS_PROVIDER_SCRIPT, fake);
  const verify = "if ($script:releFixtureQueries -lt 1 -or $script:releFixtureClosures -ne $script:releFixtureQueries) { throw 'The fixture process queries were not called and closed' };\n";
  return runCodexProbe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', appx + '\n' + fixtureScript + '\n' + verify], 25_000);
}

function windowsFixture(metadata: object = { processes: [], packages: [], issues: [] }, extra: string[] = []) {
  const files = new Set(extra.map(value => win.normalize(value).toLowerCase()));
  const run = vi.fn<CodexDiscoveryOptions['run'] extends ((...args: infer A) => infer R) | undefined ? (...args: A) => R : never>(async (command, args) => {
    if (args.includes(WINDOWS_CODEX_METADATA_SCRIPT)) return { stdout: JSON.stringify(metadata), code: 0 };
    if (args.at(-1) !== '--version') throw new Error('Only version probes are allowed');
    return { stdout: 'codex-cli 0.163.0\n', code: 0 };
  });
  const options: CodexDiscoveryOptions = {
    platform: 'win32', home: 'C:\\Users\\Example User',
    env: { Path: npmRoot, SystemRoot: 'C:\\Windows', APPDATA: win.dirname(npmRoot) },
    exists: async file => files.has(win.normalize(file).toLowerCase()),
    readText: async file => {
      if (win.normalize(file).toLowerCase() === win.join(npmPackage, 'package.json').toLowerCase()) return JSON.stringify({ name: '@openai/codex' });
      throw new Error('No file');
    },
    readDirectory: async () => [], run,
  };
  return { options, files, run };
}

describe('Codex installation and existing Desktop discovery', () => {
  it('uses a separate process-only ownership scan while ordinary discovery retains packages', async () => {
    const f = windowsFixture();
    f.run.mockImplementation(async (_command, args) => ({ stdout: JSON.stringify({ processes: [], packages: [], issues: [] }), code: 0 }));
    await discoverCodex({ ...f.options, processesOnly: true });
    expect(f.run.mock.calls[0][1]).toContain(WINDOWS_CODEX_PROCESS_METADATA_SCRIPT);
    expect(f.run.mock.calls[0][2]).toBe(8_000);
    await discoverCodex(f.options);
    expect(f.run.mock.calls[1][1]).toContain(WINDOWS_CODEX_METADATA_SCRIPT);
  });

  it('reports only a fixed failed probe stage and reason', async () => {
    const f = windowsFixture();
    f.run.mockRejectedValue(Object.assign(new Error('probe-timeout'), { stage: 'owner-query', sensitive: 'synthetic-secret' }));
    const result = await discoverCodex({ ...f.options, processesOnly: true });
    expect(result.issues.map(issue => issue.code)).toContain('windows-probe-timeout-owner-query');
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });

  it('prefers an existing Desktop WebSocket and only returns filtered process metadata', async () => {
    const f = windowsFixture({
      processes: [{ executable: desktop, processId: 1234, listenKind: 'websocket', listen: 'ws://127.0.0.1:45678', commandLine: 'synthetic-private-arguments', auth: 'synthetic-secret' }],
      packages: [{ name: 'OpenAI.Codex', location: win.dirname(win.dirname(win.dirname(desktop))) }], issues: [],
    }, [desktop, desktopGui, npmShim, npmEntry]);
    const result = await discoverCodex(f.options);
    expect(result.recommended).toEqual({ executable: desktop, transport: 'websocket', endpoint: 'ws://127.0.0.1:45678' });
    expect(result.installations).toContainEqual(expect.objectContaining({ executable: desktop, source: 'desktop-process', version: '0.163.0', running: true, processId: 1234 }));
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|synthetic-secret|commandLine|auth/);
    expect(f.run.mock.calls.filter(([, args]) => args.at(-1) === '--version')).toHaveLength(2);
    expect(f.run.mock.calls.some(([command]) => command === desktopGui || command === npmShim)).toBe(false);
    expect(f.run.mock.calls.find(([command]) => command === process.execPath)?.[1]).toEqual([npmEntry, '--version']);
  });

  it('finds MSIX resources while skipping the GUI and Windows application alias', async () => {
    const aliasRoot = 'C:\\Users\\Example User\\AppData\\Local\\Microsoft\\WindowsApps';
    const alias = win.join(aliasRoot, 'codex.exe');
    const f = windowsFixture({ processes: [], packages: [{ name: 'OpenAI.Codex', location: win.dirname(win.dirname(win.dirname(desktop))) }], issues: [] }, [desktop, desktopGui, alias]);
    f.options.env = { Path: `${win.dirname(desktopGui)};${aliasRoot}` };
    const result = await discoverCodex(f.options);
    expect(result.installations).toHaveLength(1);
    expect(result.installations[0]).toMatchObject({ executable: desktop, source: 'desktop-install', running: false });
    expect(result.recommended).toEqual({ executable: desktop, transport: 'proxy', endpoint: '' });
    expect(f.run.mock.calls.filter(([, args]) => args.at(-1) === '--version').map(([command]) => command)).toEqual([desktop]);
    expect(result.issues.map(item => item.code)).toContain('shared-socket-not-found');
  });

  it.each(['stdio', 'unspecified'])('reports a Desktop %s connection without choosing an unrelated PATH runtime', async listenKind => {
    const f = windowsFixture({ processes: [{ executable: desktop, processId: 1234, listenKind }], packages: [], issues: [] }, [desktop, npmShim, npmEntry, socket]);
    const result = await discoverCodex(f.options);
    expect(result.recommended).toBeUndefined();
    expect(result.installations[0].connection).toBeUndefined();
    expect(result.recommendedManaged).toEqual({ executable: desktop, transport: 'managed', endpoint: '' });
    expect(result.installations.some(item => item.connection?.executable === npmEntry)).toBe(true);
    expect(result.issues.map(item => item.code)).toContain('desktop-stdio');
    expect(f.run.mock.calls.every(([, args]) => args.at(-1) === '--version' || args.includes(WINDOWS_CODEX_METADATA_SCRIPT))).toBe(true);
  });

  it('uses an explicit existing control socket and reports a missing one', async () => {
    const f = windowsFixture({ processes: [{ executable: desktop, processId: 1234, listenKind: 'unspecified', socket }], packages: [], issues: [] }, [desktop, socket]);
    expect((await discoverCodex(f.options)).recommended).toEqual({ executable: desktop, transport: 'proxy', endpoint: socket });
    f.files.delete(socket.toLowerCase());
    const unavailable = await discoverCodex(f.options);
    expect(unavailable.recommended).toBeUndefined();
    expect(unavailable.issues.map(item => item.code)).toContain('socket-not-found');
  });

  it('attaches an explicit unix listener and only resolves its omitted path against an existing profile socket', async () => {
    const f = windowsFixture({ processes: [{ executable: desktop, processId: 1234, listenKind: 'unix', socket }], packages: [], issues: [] }, [desktop, socket]);
    expect((await discoverCodex(f.options)).recommended).toEqual({ executable: desktop, transport: 'proxy', endpoint: socket });
    f.run.mockImplementation(async (_command, args) => args.includes(WINDOWS_CODEX_METADATA_SCRIPT)
      ? { stdout: JSON.stringify({ processes: [{ executable: desktop, processId: 1234, listenKind: 'unix', socketDefault: true }], packages: [], issues: [] }), code: 0 }
      : { stdout: 'codex-cli 0.163.0', code: 0 });
    const defaultResult = await discoverCodex(f.options);
    expect(defaultResult.recommended?.endpoint).toBe(socket);
    expect(defaultResult.issues.map(item => item.code)).toContain('default-socket-profile');
    f.options.env = { ...f.options.env, CODEX_HOME: 'C:\\Different Profile' };
    const otherProfile = await discoverCodex(f.options);
    expect(otherProfile.recommended).toBeUndefined();
    expect(otherProfile.issues.map(item => item.code)).toContain('socket-not-found');
  });

  it('finds the Windows standalone installer CLI without claiming it is a Desktop backend', async () => {
    const local = 'C:\\Users\\Example User\\AppData\\Local';
    const executable = win.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    const f = windowsFixture(undefined, [executable]);
    f.options.env = { LOCALAPPDATA: local, PATH: '' };
    const result = await discoverCodex(f.options);
    expect(result.installations).toHaveLength(1);
    expect(result.installations[0]).toMatchObject({ executable, name: 'Codex CLI', source: 'standard', running: false });
    expect(result.recommended).toEqual({ executable, transport: 'proxy', endpoint: '' });
  });

  it('finds the versioned Windows CLI while Desktop is closed and prefers supported versions over an older PATH CLI', async () => {
    const local = 'C:\\Users\\Example User\\AppData\\Local';
    const root = win.join(local, 'OpenAI', 'Codex', 'bin');
    const directory = '896a97d617f44716aaf5e6130569dc5c';
    const executable = win.join(root, directory, 'codex.exe');
    const f = windowsFixture(undefined, [executable, npmShim, npmEntry]);
    f.options.env = { ...f.options.env, LOCALAPPDATA: local };
    f.options.readDirectory = async requested => requested === root ? [directory, '../outside'] : [];
    f.run.mockImplementation(async (command, args) => {
      if (args.includes(WINDOWS_CODEX_METADATA_SCRIPT)) return { stdout: JSON.stringify({ processes: [], packages: [], issues: [] }), code: 0 };
      return { stdout: `codex-cli ${command === executable ? '0.163.0-alpha.10.2' : '0.159.0'}`, code: 0 };
    });
    const result = await discoverCodex(f.options);
    expect(result.installations.find(item => item.executable === executable)).toMatchObject({ version: '0.163.0-alpha.10.2', running: false, managedConnection: { executable, transport: 'managed', endpoint: '' } });
    expect(result.recommendedManaged).toEqual({ executable, transport: 'managed', endpoint: '' });
    expect(result.recommended?.executable).toBe(executable);
    expect(result.issues.map(item => item.code)).toContain('cli-version-unverified');
    expect(f.run.mock.calls.every(([, args]) => args.at(-1) === '--version' || args.includes(WINDOWS_CODEX_METADATA_SCRIPT))).toBe(true);
    expect(f.run.mock.calls.some(([command]) => command.includes('outside'))).toBe(false);
  });

  it('prefers the stable supported managed CLI over a running Desktop alpha without changing the external recommendation', async () => {
    const metadata = { processes: [{ executable: desktop, processId: 1234, listenKind: 'websocket', listen: 'ws://127.0.0.1:4500' }], packages: [], issues: [] };
    const f = windowsFixture(metadata, [desktop, npmShim, npmEntry]);
    f.run.mockImplementation(async (command, args) => args.includes(WINDOWS_CODEX_METADATA_SCRIPT)
      ? { stdout: JSON.stringify(metadata), code: 0 }
      : { stdout: `codex-cli ${command === desktop ? '0.163.0-alpha.10.2' : '0.163.0'}`, code: 0 });
    const result = await discoverCodex(f.options);
    expect(result.recommendedManaged).toEqual({ executable: npmEntry, transport: 'managed', endpoint: '' });
    expect(result.recommended).toEqual({ executable: desktop, transport: 'websocket', endpoint: 'ws://127.0.0.1:4500' });
  });

  it('keeps an unverified CLI available for explicit read-only selection without recommending it', async () => {
    const f = windowsFixture(undefined, [npmShim, npmEntry]);
    f.run.mockImplementation(async (_command, args) => args.includes(WINDOWS_CODEX_METADATA_SCRIPT)
      ? { stdout: JSON.stringify({ processes: [], packages: [], issues: [] }), code: 0 }
      : { stdout: 'codex-cli 0.159.0', code: 0 });
    const result = await discoverCodex(f.options);
    expect(result.installations[0].managedConnection).toEqual({ executable: npmEntry, transport: 'managed', endpoint: '' });
    expect(result.recommendedManaged).toBeUndefined();
    expect(result.recommended).toBeUndefined();
    expect(result.issues.map(item => item.code)).toContain('cli-version-unverified');
  });

  it('keeps an explicit native profile on both targets without reading or creating profile files', async () => {
    const codexHome = 'C:\\Users\\Example User\\Selected Codex';
    const selectedSocket = win.join(codexHome, 'app-server-control', 'app-server-control.sock');
    const metadata = { processes: [{ executable: desktop, processId: 1234, listenKind: 'unix', socketDefault: true }], packages: [], issues: [] };
    const f = windowsFixture(metadata, [desktop, selectedSocket]);
    f.options.env = { ...f.options.env, codex_home: 'C:\\Unselected Codex' };
    f.options.codexHome = codexHome;
    const readText = vi.fn(async () => { throw new Error('Profile files must not be read'); });
    f.options.readText = readText;
    const result = await discoverCodex(f.options);
    expect(result.recommended).toEqual({ executable: desktop, transport: 'proxy', endpoint: selectedSocket, codexHome });
    expect(result.recommendedManaged).toEqual({ executable: desktop, transport: 'managed', endpoint: '', codexHome });
    expect(readText).not.toHaveBeenCalled();
    expect(f.options.env.codex_home).toBe('C:\\Unselected Codex');
  });

  it('does not expose or use a nonlocal or secret-bearing process address', async () => {
    const f = windowsFixture({ processes: [{ executable: desktop, processId: 1234, listenKind: 'websocket', listen: 'ws://127.0.0.1:4500/?token=synthetic-secret', socket: 'ws://remote.invalid/private' }], packages: [], issues: [] }, [desktop]);
    const result = await discoverCodex(f.options);
    expect(result.recommended).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|remote\.invalid/);
    expect(result.issues.map(item => item.code)).toContain('desktop-listener-unsupported');
  });

  it('requires explicit selection when several Desktop server processes can be attached', async () => {
    const f = windowsFixture({ processes: [
      { executable: desktop, processId: 1234, listenKind: 'websocket', listen: 'ws://127.0.0.1:4501' },
      { executable: desktop, processId: 5678, listenKind: 'websocket', listen: 'ws://127.0.0.1:4502' },
    ], packages: [], issues: [] }, [desktop]);
    const result = await discoverCodex(f.options);
    expect(result.installations).toHaveLength(2);
    expect(result.recommended).toBeUndefined();
    expect(result.issues.map(item => item.code)).toContain('multiple-desktop-servers');
    expect(f.run.mock.calls.filter(([, args]) => args.at(-1) === '--version')).toHaveLength(1);
  });

  it('keeps an unconfirmed running installation visible and never publishes a failed probe output', async () => {
    const f = windowsFixture({ processes: [{ executable: desktop, processId: 1234, listenKind: 'websocket', listen: 'ws://127.0.0.1:4500' }], packages: [], issues: [] }, [desktop, npmShim, npmEntry]);
    f.run.mockImplementation(async (command, args) => {
      if (args.includes(WINDOWS_CODEX_METADATA_SCRIPT)) return { stdout: JSON.stringify({ processes: [{ executable: desktop, processId: 1234, listenKind: 'websocket', listen: 'ws://127.0.0.1:4500' }], packages: [], issues: [] }), code: 0 };
      if (command === desktop) throw new Error('synthetic-private-path-or-token');
      return { stdout: 'codex-cli 0.163.0', code: 0 };
    });
    const result = await discoverCodex(f.options);
    expect(result.installations[0]).toMatchObject({ executable: desktop, running: true });
    expect(result.installations[0].connection).toBeUndefined();
    expect(result.recommended).toBeUndefined();
    expect(result.issues.map(item => item.code)).toContain('cli-probe-failed');
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
  });

  it('falls back to the official npm CLI when Windows metadata is unavailable without executing a batch file', async () => {
    const f = windowsFixture(undefined, [npmShim, npmEntry]);
    f.run.mockImplementation(async (_command, args) => {
      if (args.includes(WINDOWS_CODEX_METADATA_SCRIPT)) throw new Error('synthetic-sensitive-WMI-error');
      return { stdout: 'codex-cli 0.163.0', code: 0 };
    });
    const result = await discoverCodex(f.options);
    expect(result.recommended).toEqual({ executable: npmEntry, transport: 'proxy', endpoint: '' });
    expect(result.issues.map(item => item.code)).toContain('windows-discovery-unavailable');
    expect(JSON.stringify(result)).not.toContain('synthetic-sensitive');
    expect(f.run.mock.calls.some(([command]) => /\.cmd$/i.test(command))).toBe(false);
    f.options.readText = async () => JSON.stringify({ name: 'unrelated-package' });
    await expect(resolveCodexLaunch(npmShim, f.options)).rejects.toThrow('Codex CLI');
  });

  it('discovers a Linux CLI from PATH and standard user installations without running app-server', async () => {
    const files = new Set(['/opt/codex/bin/codex', '/home/example/.local/bin/codex', '/home/example/.nvm/versions/node/v24.19.0/bin/codex']);
    const run = vi.fn(async (_command: string, args: string[]) => {
      expect(args).toEqual(['--version']);
      return { stdout: 'codex-cli 0.163.0', code: 0 };
    });
    const result = await discoverCodex({ platform: 'linux', home: '/home/example', env: { PATH: '/opt/codex/bin' }, exists: async file => files.has(file), readDirectory: async root => root.includes('.nvm') ? ['v24.19.0'] : [], run });
    expect(result.installations).toHaveLength(3);
    expect(result.recommended).toEqual({ executable: '/opt/codex/bin/codex', transport: 'proxy', endpoint: '' });
    expect(result.recommendedManaged).toEqual({ executable: '/opt/codex/bin/codex', transport: 'managed', endpoint: '' });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('bounds real child probes by time and output volume', async () => {
    await expect(runCodexProbe(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 100)).rejects.toThrow('probe-timeout');
    await expect(runCodexProbe(process.execPath, ['-e', 'require("node:fs").writeSync(1, "x".repeat(200000))'], 4_000)).rejects.toThrow('probe-output-limit');
  });

  it.each(['process-provider', 'owner-query', 'json-provider'])('captures fixed %s stage without publishing other child stderr', async stage => {
    const error = await runCodexProbe(process.execPath, ['-e', `process.stderr.write("synthetic-secret\\nrele-discovery:${stage}\\nrele-discovery:synthetic-secret\\n"); setInterval(() => {}, 1000)`], 250).catch(error => error);
    expect(error).toMatchObject({ message: 'probe-timeout', stage });
    expect(JSON.stringify(error)).not.toContain('synthetic-secret');
  });

  it.skipIf(process.platform !== 'win32')('verifies the real current-user WMI owner and closes its query resources', async () => {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$stage = 'provider-load'
$query = $null
try {
  [Console]::Error.WriteLine('rele-discovery:process-provider')
  ${WINDOWS_CODEX_PROCESS_PROVIDER_SCRIPT}
  try {
    $stage = 'process-query'
    [Console]::Error.WriteLine('rele-discovery:process-query')
    $query = Get-ReleProcessQuery "ProcessId = $PID"
    $stage = 'row-count'
    if ($query.objects.Count -ne 1) { throw 'Current process query did not return one row' }
    $stage = 'row-path'
    if (-not $query.objects[0].psbase.Path.RelativePath) { throw 'Current process query did not return a locatable row' }
    $stage = 'owner-query'
    [Console]::Error.WriteLine('rele-discovery:owner-query')
    $owner = Get-ReleProcessOwner ($query.objects[0])
    $stage = 'owner-check'
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Current process owner was not confirmed' }
  } finally {
    if ($query) {
      $beforeClose = $stage; $stage = 'query-close'
      [Console]::Error.WriteLine('rele-discovery:done')
      Close-ReleProcessQuery $query; $stage = $beforeClose
    }
  }
} catch {
  $exception = $_.Exception
  while ($exception.InnerException) { $exception = $exception.InnerException }
  [Console]::Out.Write('provider-failed:' + $stage + ':' + $exception.GetType().FullName + ':0x' + $exception.HResult.ToString('X8'))
  exit 1
}
[Console]::Out.Write('provider-current-user-ok')
`;
    const result = await runCodexProbe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 8_000).catch(error => ({
      error: ['probe-timeout', 'probe-output-limit', 'probe-unavailable'].includes(error?.message) ? error.message : 'probe-error',
      // Reuse a whitelisted marker so this diagnostic leaves the product probe unchanged.
      stage: error?.stage === 'done' ? 'query-close' : error?.stage,
    }));
    expect(result).toEqual({ code: 0, stdout: 'provider-current-user-ok', stage: 'done' });
  }, 10_000);

  it.skipIf(process.platform !== 'win32')('completes a process-only scan without calling optional Appx discovery', async () => {
    const fixtures = String.raw`
function Get-ReleProcessQuery([string]$filter, [bool]$parentOnly = $false) {
  $script:releFixtureQueries++
  if ($filter -like 'ProcessId = *') {
    if (-not $parentOnly -or $filter -ne 'ProcessId = 3') { throw 'Parent query must use its narrow projection' }
    return @{ objects = @() }
  }
  if ($parentOnly) { throw 'Main query must include app-server fields' }
  @{ objects = @(
    [pscustomobject]@{ ProcessId = 1; ExecutablePath = $null; CommandLine = $null },
    [pscustomobject]@{ ProcessId = 2; ParentProcessId = 3; ExecutablePath = 'C:\Fixture\codex.exe'; CommandLine = 'codex.exe app-server --listen stdio://' }
  ) }
}
function Get-ReleProcessOwner($process) {
  @{ ReturnValue = 0; Sid = $(if ($process.ProcessId -eq 1) { 'another-user' } else { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }) }
}
`;
    const result = await windowsMetadataFixture(fixtures, WINDOWS_CODEX_PROCESS_METADATA_SCRIPT, "function Get-AppxPackage { throw 'Appx must not run' }");
    expect(result.code).toBe(0);
    expect(result.stage).toBe('done');
    expect(JSON.parse(result.stdout)).toEqual({ processes: [], packages: [], issues: [] });
  }, 35_000);

  it.skipIf(process.platform !== 'win32').each(['owner', 'fields'])('parses same-user metadata and fails closed on unreadable %s', async unavailable => {
    const fixtures = String.raw`
$releFixtureMissingFields = ${unavailable === 'fields' ? '$true' : '$false'}
function Get-ReleProcessQuery {
  [CmdletBinding()] param([string]$Filter, [bool]$ParentOnly = $false)
  $script:releFixtureQueries++
  @{ objects = @(
    [pscustomobject]@{ ProcessId = 101; ParentProcessId = 1; ExecutablePath = 'C:\Program Files\Codex\resources\codex.exe'; CommandLine = '"C:\Program Files\Codex\resources\codex.exe" -c model="synthetic-private-option" app-server --listen "ws://127.0.0.1:45678"' },
    [pscustomobject]@{ ProcessId = 102; ParentProcessId = 1; ExecutablePath = 'C:\Program Files\Codex\resources\codex.exe'; CommandLine = 'codex.exe app-server --listen stdio://' },
    [pscustomobject]@{ ProcessId = 103; ParentProcessId = 1; ExecutablePath = 'C:\Program Files\Codex\resources\codex.exe'; CommandLine = 'codex.exe app-server --listen=ws://localhost:45678/?token=synthetic-secret' },
    [pscustomobject]@{ ProcessId = 104; ParentProcessId = 1; ExecutablePath = 'C:\Program Files\Codex\resources\codex.exe'; CommandLine = 'codex.exe app-server --sock "C:\Example User\control.sock"' },
    [pscustomobject]@{ ProcessId = 105; ParentProcessId = 1; ExecutablePath = 'C:\Program Files\Codex\resources\codex.exe'; CommandLine = 'codex.exe app-server --listen ws://127.0.0.1:5000' },
    [pscustomobject]@{ ProcessId = 106; ParentProcessId = 1; ExecutablePath = 'C:\Program Files\Codex\Codex.exe'; CommandLine = 'Codex.exe --synthetic-gui-argument' },
    [pscustomobject]@{ ProcessId = 107; ParentProcessId = 1; ExecutablePath = 'C:\Program Files\Codex\resources\codex.exe'; CommandLine = 'codex.exe app-server proxy' },
    [pscustomobject]@{ ProcessId = 108; ParentProcessId = 1; ExecutablePath = 'C:\Program Files\Codex\resources\codex.exe'; CommandLine = 'codex.exe app-server --listen "unix://C:\Example User\custom.sock"' },
    [pscustomobject]@{ ProcessId = 109; ParentProcessId = 1; ExecutablePath = 'C:\Program Files\Codex\resources\codex.exe'; CommandLine = 'codex.exe app-server --listen=unix://' },
    [pscustomobject]@{ ProcessId = 110; ParentProcessId = 1; ExecutablePath = $(if (-not $releFixtureMissingFields) { 'C:\Program Files\Codex\resources\codex.exe' }); CommandLine = $(if (-not $releFixtureMissingFields) { 'codex.exe app-server --listen=stdio://' }) }
  ) }
}
function Get-ReleProcessOwner {
  [CmdletBinding()] param($InputObject)
  if ($InputObject.ProcessId -eq 110 -and -not $releFixtureMissingFields) { return [pscustomobject]@{ ReturnValue = 2; Sid = $null } }
  [pscustomobject]@{ ReturnValue = 0; Sid = $(if ($InputObject.ProcessId -eq 105) { 'another-user' } else { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }) }
}
`;
    // This parser fixture includes cold PowerShell startup on a shared CI runner.
    // Its deadline is separate from production probe budgets and the limit test above.
    const result = await windowsMetadataFixture(fixtures, WINDOWS_CODEX_METADATA_SCRIPT);
    expect(result.code).toBe(0);
    expect(result.stage).toBe('done');
    const parsed = JSON.parse(result.stdout);
    expect(parsed.issues).toEqual(['process-owner-unavailable']);
    expect(parsed.processes.map((item: { processId: number }) => item.processId), `Synthetic fixture JSON: ${result.stdout}`).toEqual([101, 102, 103, 104, 108, 109]);
    expect(parsed.processes[0]).toMatchObject({ listenKind: 'websocket', listen: 'ws://127.0.0.1:45678/' });
    expect(parsed.processes[1]).toMatchObject({ listenKind: 'stdio', listen: null });
    expect(parsed.processes[2]).toMatchObject({ listenKind: 'unsupported', listen: null });
    expect(parsed.processes[3]).toMatchObject({ socket: 'C:\\Example User\\control.sock' });
    expect(parsed.processes[4]).toMatchObject({ listenKind: 'unix', socket: 'C:\\Example User\\custom.sock', socketDefault: false });
    expect(parsed.processes[5]).toMatchObject({ listenKind: 'unix', socket: null, socketDefault: true });
    expect(result.stdout).not.toMatch(/synthetic-private|synthetic-secret|CommandLine|another-user|synthetic-gui/);
  }, 35_000);
});

describe('native Codex profile environment', () => {
  it('inherits the existing environment unless an absolute profile is explicitly selected', () => {
    const env = { CODEX_HOME: '/home/example/.codex', CODEX_SQLITE_HOME: '/home/example/native-state', OPENAI_API_KEY: 'synthetic-key' };
    expect(codexEnvironment(undefined, env, 'linux')).toEqual(env);
    expect(codexEnvironment('', env, 'linux')).toEqual(env);
    expect(codexEnvironment('/home/example/selected', env, 'linux')).toEqual({ ...env, CODEX_HOME: '/home/example/selected' });
    expect(env.CODEX_HOME).toBe('/home/example/.codex');
    expect(() => codexEnvironment('relative-home', env, 'linux')).toThrow('абсолютным');
  });

  it('replaces Windows environment casing aliases without mutating the service environment', () => {
    const env = { CODEX_HOME: 'C:\\Old Native', codex_home: 'C:\\Other Native', Path: 'C:\\Tools' };
    expect(codexEnvironment('C:\\Selected Native', env, 'win32')).toEqual({ CODEX_HOME: 'C:\\Selected Native', Path: 'C:\\Tools' });
    expect(env).toHaveProperty('codex_home');
    expect(() => codexEnvironment('\\\\server\\share', env, 'win32')).toThrow('абсолютным');
  });
});
