import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexConnectionTarget, CodexDiscoveryResult } from '../src/shared/types.js';
import { ensureSharedCodex, prepareDesktopCodexPackage, resolveSharedCodexExecutable, type SharedCodexOptions } from '../src/server/codex-shared.js';
import { runCodexProbe } from '../src/server/codex-discovery.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'rele-shared-test-')));
  directories.push(home);
  const socketPath = path.join(home, 'app-server-control', 'app-server-control.sock');
  // A ready native daemon creates this directory before reporting its socket.
  await mkdir(path.dirname(socketPath));
  const executable = path.join(home, process.platform === 'win32' ? 'codex.exe' : 'codex');
  const target: CodexConnectionTarget = { transport: 'shared', executable: path.join(home, 'codex.mjs'), endpoint: '', codexHome: home };
  const daemon = { status: 'running', managedCodexPath: executable, managedCodexVersion: '0.163.0', socketPath };
  const run = vi.fn<NonNullable<SharedCodexOptions['run']>>(async (_command, args) => ({
    code: 0, stdout: args.at(-1) === '--version' ? 'codex-cli 0.163.0\n' : JSON.stringify(daemon),
  }));
  const discovery: CodexDiscoveryResult = { installations: [], issues: [], recommendedManaged: { ...target, transport: 'managed' } };
  const discover = vi.fn().mockResolvedValue(discovery);
  const env = { CODEX_HOME: '/inherited-profile', RELE_DATA_DIR: path.join(home, 'rele-data'), RELE_TEST_MARKER: 'preserved', OPENAI_API_KEY: 'synthetic-key' };
  const prepareControlDirectory = vi.fn<NonNullable<SharedCodexOptions['prepareControlDirectory']>>().mockResolvedValue(undefined);
  return { home, target, socketPath, executable, daemon, run, discovery, discover, env, prepareControlDirectory, options: { run, discover, env, prepareControlDirectory } };
}

async function packageFixture(root: string, version = '0.163.0'): Promise<string> {
  const target = `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-${process.platform === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-musl'}`;
  const entrypoint = `bin/${process.platform === 'win32' ? 'codex.exe' : 'codex'}`;
  const files = [entrypoint, `bin/${process.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'}`,
    process.platform === 'win32' ? 'codex-path/rg.exe' : 'codex-path/rg',
    ...(process.platform === 'win32' ? ['codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe'] : ['codex-resources/bwrap'])];
  for (const file of files) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), 'synthetic-package-file', { mode: 0o755 }); }
  await writeFile(path.join(root, 'codex-package.json'), JSON.stringify({ layoutVersion: 1, version, target, entrypoint }));
  return path.join(root, entrypoint);
}

const desktopFiles = ['codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe', 'rg.exe'];
async function desktopFixture(root: string): Promise<string> {
  const resources = path.join(root, 'app', 'resources');
  await mkdir(resources, { recursive: true });
  await writeFile(path.join(root, 'app', 'ChatGPT.exe'), 'synthetic-desktop-gui');
  await writeFile(path.join(resources, 'app.asar'), 'synthetic-desktop-archive');
  for (const name of desktopFiles) await writeFile(path.join(resources, name), `synthetic-desktop-${name}`);
  return path.join(resources, 'codex.exe');
}

describe('local Desktop native package preparation', () => {
  it('copies the five same-bundle helpers into the native layout and reuses only a verified immutable snapshot', async () => {
    const f = await fixture(), desktop = await desktopFixture(path.join(f.home, 'desktop'));
    const prepared = await prepareDesktopCodexPackage(desktop, f.options);
    expect(prepared).toBeTruthy();
    expect(path.relative(f.env.RELE_DATA_DIR, prepared!)).not.toMatch(/^\.\./u);
    const root = path.dirname(path.dirname(prepared!));
    expect(JSON.parse(await readFile(path.join(root, 'codex-package.json'), 'utf8'))).toMatchObject({ version: '0.163.0', target: 'x86_64-pc-windows-msvc', entrypoint: 'bin/codex.exe' });
    for (const [source, target] of [[desktop, prepared!], [path.join(path.dirname(desktop), 'rg.exe'), path.join(root, 'codex-path', 'rg.exe')],
      [path.join(path.dirname(desktop), 'codex-command-runner.exe'), path.join(root, 'codex-resources', 'codex-command-runner.exe')]]) {
      expect(await readFile(target)).toEqual(await readFile(source));
    }
    expect(await prepareDesktopCodexPackage(desktop, f.options)).toBe(prepared);
    expect(await readdir(path.dirname(root))).toEqual([path.basename(root)]);
    expect(f.run.mock.calls.every(([, args]) => args.join(' ') === '--version')).toBe(true);
    expect(await readdir(f.home)).not.toContain('packages');
  });

  it.each(['helper', 'asar', 'gui'])('does not stage a partial or unrecognized Desktop missing %s', async missing => {
    const f = await fixture(), desktop = await desktopFixture(path.join(f.home, 'desktop'));
    await rm(missing === 'gui' ? path.join(path.dirname(path.dirname(desktop)), 'ChatGPT.exe') : path.join(path.dirname(desktop), missing === 'asar' ? 'app.asar' : 'rg.exe'));
    expect(await prepareDesktopCodexPackage(desktop, f.options)).toBeUndefined();
    await expect(readdir(f.env.RELE_DATA_DIR)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.run).not.toHaveBeenCalled();
  });

  it('rejects an unsupported native version without preparing or starting another runtime', async () => {
    const f = await fixture(), desktop = await desktopFixture(path.join(f.home, 'desktop'));
    f.run.mockResolvedValue({ code: 0, stdout: 'codex-cli 0.164.0' });
    await expect(prepareDesktopCodexPackage(desktop, f.options)).rejects.toMatchObject({ code: 'shared-cli-unverified' });
    await expect(readdir(f.env.RELE_DATA_DIR)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.run.mock.calls.map(([, args]) => args)).toEqual([['--version']]);
  });

  it('rejects resources linked outside the canonical Desktop bundle', async () => {
    const f = await fixture(), desktop = await desktopFixture(path.join(f.home, 'desktop'));
    const foreign = path.join(f.home, 'foreign');
    await rename(path.dirname(desktop), foreign);
    // A directory junction works without Windows developer-mode symlink privileges.
    await symlink(foreign, path.dirname(desktop), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(prepareDesktopCodexPackage(desktop, f.options)).rejects.toMatchObject({ code: 'shared-desktop-package-invalid' });
    expect(f.run).not.toHaveBeenCalled();
  });

  it('detects a source change while preparing and leaves no published package', async () => {
    const f = await fixture(), desktop = await desktopFixture(path.join(f.home, 'desktop'));
    f.run.mockImplementation(async () => {
      await writeFile(path.join(path.dirname(desktop), 'rg.exe'), 'synthetic-changed-helper');
      return { code: 0, stdout: 'codex-cli 0.163.0' };
    });
    await expect(prepareDesktopCodexPackage(desktop, f.options)).rejects.toMatchObject({ code: 'shared-desktop-package-invalid' });
    expect(await readdir(path.join(f.env.RELE_DATA_DIR, 'codex-desktop-packages'))).toEqual([]);
  });

  it.each(['bytes', 'extra'])('fails closed on %s cache tampering without overwriting it', async tamper => {
    const f = await fixture(), desktop = await desktopFixture(path.join(f.home, 'desktop'));
    const prepared = (await prepareDesktopCodexPackage(desktop, f.options))!;
    const changed = tamper === 'bytes' ? prepared : path.join(path.dirname(prepared), 'unexpected.dll');
    await writeFile(changed, 'synthetic-cache-tamper');
    await expect(prepareDesktopCodexPackage(desktop, f.options)).rejects.toMatchObject({ code: 'shared-desktop-package-invalid' });
    expect(await readFile(changed, 'utf8')).toBe('synthetic-cache-tamper');
  });

  it('publishes one complete immutable package when two preparations race', async () => {
    const f = await fixture(), desktop = await desktopFixture(path.join(f.home, 'desktop'));
    const prepared = await Promise.all([prepareDesktopCodexPackage(desktop, f.options), prepareDesktopCodexPackage(desktop, f.options)]);
    expect(prepared[0]).toBe(prepared[1]);
    expect(await readdir(path.join(f.env.RELE_DATA_DIR, 'codex-desktop-packages'))).toHaveLength(1);
    expect(await readFile(prepared[0]!, 'utf8')).toBe('synthetic-desktop-codex.exe');
  });
});

describe('native shared Codex lifecycle', () => {
  it.skipIf(process.platform !== 'win32')('starts from an installed Desktop alone using its snapshot and the original profile', async () => {
    const f = await fixture(), desktop = await desktopFixture(path.join(f.home, 'desktop'));
    f.discovery.recommendedManaged = { ...f.target, executable: desktop, transport: 'managed' };
    f.discovery.installations.push({ executable: desktop, name: 'Desktop', source: 'desktop-install', version: '0.163.0', running: false });
    f.run.mockImplementation(async (_command, args) => ({ code: args.at(-1) === 'version' ? 1 : 0,
      stdout: args.at(-1) === '--version' ? 'codex-cli 0.163.0' : JSON.stringify({ ...f.daemon, status: 'started' }) }));
    const target = { ...f.target, executable: 'codex' }, before = structuredClone(target);
    expect(await ensureSharedCodex(target, f.options)).toMatchObject({ transport: 'proxy', codexHome: f.home, endpoint: f.socketPath });
    const starts = f.run.mock.calls.filter(([, args]) => args.at(-1) === 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0][0]).not.toBe(desktop);
    expect(path.relative(f.env.RELE_DATA_DIR, starts[0][0])).not.toMatch(/^\.\./u);
    expect(starts[0][3]).toMatchObject({ CODEX_HOME: f.home, RELE_TEST_MARKER: 'preserved' });
    expect(target).toEqual(before);
  });

  it.skipIf(process.platform !== 'win32').each(['complete', 'partial'])('keeps an explicit %s Desktop bound to only its selected bundle', async completeness => {
    const f = await fixture(), desktop = await desktopFixture(path.join(f.home, 'selected-desktop'));
    const alternate = await desktopFixture(path.join(f.home, 'other-desktop'));
    await writeFile(desktop, 'synthetic-explicit-selected-native');
    const full = await packageFixture(path.join(f.home, 'other-cli'));
    f.discovery.recommendedManaged = { ...f.target, executable: full, transport: 'managed' };
    f.discovery.installations.push(
      { executable: alternate, name: 'Other Desktop', source: 'desktop-install', version: '0.163.0', running: false },
      { executable: full, name: 'Other CLI', source: 'path', version: '0.163.0', running: false },
    );
    f.run.mockImplementation(async (_command, args) => ({ code: args.at(-1) === 'version' ? 1 : 0,
      stdout: args.at(-1) === '--version' ? 'codex-cli 0.163.0' : JSON.stringify({ ...f.daemon, status: 'started' }) }));
    const target = { ...f.target, executable: desktop }, before = structuredClone(target);
    if (completeness === 'partial') {
      await rm(path.join(path.dirname(desktop), 'rg.exe'));
      await expect(ensureSharedCodex(target, f.options)).rejects.toMatchObject({ code: 'shared-package-incomplete' });
      expect(f.run.mock.calls.some(([, args]) => args.at(-1) === 'start')).toBe(false);
      await expect(readdir(f.env.RELE_DATA_DIR)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(await ensureSharedCodex(target, f.options)).toMatchObject({ transport: 'proxy', codexHome: f.home });
      const starts = f.run.mock.calls.filter(([, args]) => args.at(-1) === 'start');
      expect(starts).toHaveLength(1);
      expect(await readFile(starts[0][0], 'utf8')).toBe('synthetic-explicit-selected-native');
    }
    expect(f.run.mock.calls.some(([command]) => command === alternate || command === full)).toBe(false);
    expect(f.discover).toHaveBeenCalledTimes(1);
    expect(f.discover).toHaveBeenCalledWith(expect.objectContaining({ processesOnly: true }));
    expect(target).toEqual(before);
  });

  it.each(['read-only', 'healthy'])('keeps Desktop package preparation out of %s resolution', async operation => {
    const f = await fixture(), desktop = await desktopFixture(path.join(f.home, 'desktop'));
    f.discovery.recommendedManaged = { ...f.target, executable: desktop, transport: 'managed' };
    f.discovery.installations.push({ executable: desktop, name: 'Desktop', source: 'desktop-install', version: '0.163.0', running: true });
    const target = { ...f.target, executable: 'codex' };
    if (operation === 'read-only') expect(await resolveSharedCodexExecutable(target, f.options)).toBe(desktop);
    else expect(await ensureSharedCodex(target, f.options)).toMatchObject({ transport: 'proxy', endpoint: f.socketPath });
    await expect(readdir(f.env.RELE_DATA_DIR)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.run.mock.calls.some(([, args]) => args.at(-1) === 'start')).toBe(false);
  });
  it('attaches an existing verified daemon without starting it or inspecting private Desktop owners', async () => {
    const f = await fixture();
    f.discovery.installations.push({ executable: f.target.executable, name: 'Private Desktop', source: 'desktop-process', running: true });
    const config = structuredClone(f.target);
    expect(await ensureSharedCodex(f.target, f.options)).toEqual({ ...f.target, transport: 'proxy', executable: f.executable, endpoint: f.socketPath });
    expect(f.run.mock.calls.map(([, args]) => args)).toEqual([[f.target.executable, '--version'], [f.target.executable, 'app-server', 'daemon', 'version']]);
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.target).toEqual(config);
    expect(f.run.mock.calls[0][3]).toMatchObject({ CODEX_HOME: f.home, RELE_TEST_MARKER: 'preserved', OPENAI_API_KEY: 'synthetic-key' });
    expect(f.env.CODEX_HOME).toBe('/inherited-profile');
  });

  it.each(['started', 'alreadyRunning'])('starts an absent native singleton with %s and never adds --json', async status => {
    const f = await fixture();
    f.target.executable = await packageFixture(path.join(f.home, 'source-package'));
    f.run.mockImplementation(async (_command, args) => args.at(-1) === '--version' ? { code: 0, stdout: 'codex-cli 0.163.0\n' }
      : args.at(-1) === 'version' ? { code: 1, stdout: '' } : { code: 0, stdout: JSON.stringify({ ...f.daemon, status }) });
    await ensureSharedCodex(f.target, f.options);
    expect(f.run.mock.calls.map(([, args]) => args).at(-1)).toEqual(['app-server', 'daemon', 'start']);
    expect(f.run.mock.calls.some(([, args]) => args.includes('--json'))).toBe(false);
    expect(f.prepareControlDirectory).toHaveBeenCalledExactlyOnceWith(f.home, expect.objectContaining({ executable: f.target.executable }), expect.objectContaining({ CODEX_HOME: f.home }));
  });

  it('keeps an existing ready daemon and its control directory untouched', async () => {
    const f = await fixture();
    await ensureSharedCodex(f.target, f.options);
    expect(f.prepareControlDirectory).not.toHaveBeenCalled();
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.run.mock.calls.map(([, args]) => args.at(-1))).toEqual(['--version', 'version']);
  });

  it.each(['stdio', 'websocket'])('does not let a stale marker bypass the private %s Desktop fence', async transport => {
    const f = await fixture();
    await writeFile(f.socketPath, 'owned-stale-marker');
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValueOnce({ code: 1, stdout: '' });
    f.discovery.installations.push({ executable: f.target.executable, name: 'Private Desktop', source: 'desktop-process', running: true,
      ...(transport === 'websocket' ? { connection: { ...f.target, transport: 'websocket', endpoint: 'ws://127.0.0.1:45678' } } : {}) });
    await expect(ensureSharedCodex(f.target, f.options)).rejects.toMatchObject({ code: 'shared-desktop-conflict' });
    expect(f.prepareControlDirectory).not.toHaveBeenCalled();
    expect(await readFile(f.socketPath, 'utf8')).toBe('owned-stale-marker');
    expect(f.run.mock.calls.some(([, args]) => args.at(-1) === 'start')).toBe(false);
  });

  it('does not migrate a stale control directory when process ownership is unknown', async () => {
    const f = await fixture();
    await writeFile(f.socketPath, 'owned-stale-marker');
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValueOnce({ code: 1, stdout: '' });
    f.discovery.issues.push({ code: 'process-owner-unavailable', message: 'synthetic-private-diagnostic' });
    await expect(ensureSharedCodex(f.target, f.options)).rejects.toMatchObject({ code: 'shared-owner-unknown' });
    expect(f.prepareControlDirectory).not.toHaveBeenCalled();
    expect(await readFile(f.socketPath, 'utf8')).toBe('owned-stale-marker');
  });

  it('does not start another runtime when safe control-directory preparation refuses', async () => {
    const f = await fixture();
    f.target.executable = await packageFixture(path.join(f.home, 'source-package'));
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValueOnce({ code: 1, stdout: '' });
    f.prepareControlDirectory.mockRejectedValue(new Error('fixed refusal'));
    await expect(ensureSharedCodex(f.target, f.options)).rejects.toThrow('fixed refusal');
    expect(f.run.mock.calls.some(([, args]) => args.at(-1) === 'start')).toBe(false);
  });

  it('lets the native singleton recover its stale socket instead of creating a private server', async () => {
    const f = await fixture();
    f.target.executable = await packageFixture(path.join(f.home, 'source-package'));
    await writeFile(f.socketPath, 'synthetic-stale-socket');
    f.run.mockImplementation(async (_command, args) => ({ code: args.at(-1) === 'version' ? 1 : 0,
      stdout: args.at(-1) === '--version' ? 'codex-cli 0.163.0' : JSON.stringify({ ...f.daemon, status: 'started' }) }));
    await ensureSharedCodex(f.target, f.options);
    expect(f.run.mock.calls.filter(([, args]) => args.at(-1) === 'start')).toHaveLength(1);
    expect(await readFile(f.socketPath, 'utf8')).toBe('synthetic-stale-socket');
    expect(f.run.mock.calls.some(([, args]) => args.includes('--listen'))).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('passes a real stale Windows AF_UNIX marker to native singleton recovery', async () => {
    const f = await fixture();
    f.target.executable = await packageFixture(path.join(f.home, 'source-package'));
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = fileURLToPath(new URL('./fixtures/windows-unix-socket.ps1', import.meta.url));
    try {
      const created = await runCodexProbe(powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-SocketPath', f.socketPath], 10_000);
      expect(created).toEqual({ code: 0, stdout: 'windows-unix-socket-created' });
      // The fixture is a native AF_UNIX reparse marker, not a regular-file stand-in.
      // Some supported Node/Windows versions cannot stat it even though it exists.
      await access(f.socketPath);
      f.run.mockImplementation(async (_command, args) => ({ code: args.at(-1) === 'version' ? 1 : 0,
        stdout: args.at(-1) === '--version' ? 'codex-cli 0.163.0' : JSON.stringify({ ...f.daemon, status: 'started' }) }));
      expect(await ensureSharedCodex(f.target, f.options)).toMatchObject({ transport: 'proxy', endpoint: f.socketPath, codexHome: f.home });
      expect(f.run.mock.calls.filter(([, args]) => args.at(-1) === 'start')).toHaveLength(1);
      expect(f.run.mock.calls.some(([, args]) => args.includes('--listen'))).toBe(false);
      await access(f.socketPath);
      await unlink(f.socketPath);
      f.discovery.installations.push({ executable: f.target.executable, name: 'Private Desktop', source: 'desktop-process', running: true });
      await expect(ensureSharedCodex(f.target, f.options)).rejects.toMatchObject({ code: 'shared-desktop-conflict' });
      expect(f.run.mock.calls.filter(([, args]) => args.at(-1) === 'start')).toHaveLength(1);
    } finally {
      // Delete the owned marker directly: recursive directory cleanup may also stat it.
      await unlink(f.socketPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  });

  it.each(['stdio', 'websocket'])('blocks a second owner when native daemon is absent and private Desktop uses %s', async transport => {
    const f = await fixture();
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValueOnce({ code: 1, stdout: '' });
    f.discovery.installations.push({ executable: f.target.executable, name: 'Desktop', source: 'desktop-process', running: true,
      ...(transport === 'websocket' ? { connection: { ...f.target, transport: 'websocket', endpoint: 'ws://127.0.0.1:45678' } } : {}) });
    await expect(ensureSharedCodex(f.target, f.options)).rejects.toMatchObject({ code: 'shared-desktop-conflict', message: expect.stringContaining('полностью закройте Desktop') });
    expect(f.run.mock.calls.some(([, args]) => args.at(-1) === 'start')).toBe(false);
  });

  it('does not create a daemon when Desktop ownership discovery is unavailable', async () => {
    const f = await fixture();
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValueOnce({ code: 1, stdout: '' });
    f.discovery.issues.push({ code: 'process-owner-unavailable', message: 'Private diagnostic' });
    await expect(ensureSharedCodex(f.target, f.options)).rejects.toMatchObject({ code: 'shared-owner-unknown' });
    expect(f.run.mock.calls.some(([, args]) => args.at(-1) === 'start')).toBe(false);
  });

  it.each(['process-provider', 'owner-query', 'json-provider'])('keeps %s failure diagnostics fixed and never starts on a failed process-only scan', async stage => {
    const f = await fixture();
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValueOnce({ code: 1, stdout: '' });
    f.discovery.issues.push({ code: 'windows-discovery-unavailable', message: 'synthetic-secret' },
      { code: `windows-probe-timeout-${stage}`, message: 'synthetic-secret' });
    const error = await ensureSharedCodex(f.target, f.options).catch(error => error);
    expect(error).toMatchObject({ code: 'shared-owner-unknown', message: expect.stringContaining(`windows-probe-timeout-${stage}`) });
    expect(error.message).not.toContain('synthetic-secret');
    expect(f.discover).toHaveBeenCalledWith(expect.objectContaining({ processesOnly: true }));
    expect(f.run.mock.calls.some(([, args]) => args.at(-1) === 'start')).toBe(false);
  });

  it('uses successful process-only proof even when optional package discovery failed', async () => {
    const f = await fixture(), executable = await packageFixture(path.join(f.home, 'full-cli'));
    f.discovery.recommendedManaged = { ...f.target, executable, transport: 'managed' };
    f.discovery.issues.push({ code: 'windows-discovery-unavailable', message: 'Optional package timeout' });
    f.discover.mockImplementation(async options => options.processesOnly ? { installations: [], issues: [] } : f.discovery);
    f.run.mockImplementation(async (_command, args) => ({ code: args.at(-1) === 'version' ? 1 : 0,
      stdout: args.at(-1) === '--version' ? 'codex-cli 0.163.0' : JSON.stringify({ ...f.daemon, status: 'started' }) }));
    await ensureSharedCodex({ ...f.target, executable: 'codex' }, f.options);
    expect(f.discover.mock.calls.map(([options]) => options.processesOnly ?? false)).toEqual([false, true]);
    expect(f.run.mock.calls.filter(([, args]) => args.at(-1) === 'start')).toHaveLength(1);
  });

  it.each(['0.163.0', '0.163.0-alpha.11'])('selects a complete CLI instead of the preferred incomplete Desktop %s before starting', async desktopVersion => {
    const f = await fixture();
    const fullVersion = '0.163.0-alpha.11', full = await packageFixture(path.join(f.home, 'full-cli'), fullVersion);
    f.discovery.installations.push(
      { executable: f.target.executable, name: 'Standalone Desktop binary', source: 'desktop-install', version: desktopVersion, running: false },
      { executable: full, name: 'Complete CLI', source: 'path', version: fullVersion, running: false },
    );
    f.run.mockImplementation(async (command, args) => ({ code: args.at(-1) === 'version' ? 1 : 0,
      stdout: args.at(-1) === '--version' ? `codex-cli ${command === full ? fullVersion : desktopVersion}` : JSON.stringify({ ...f.daemon, status: 'started', managedCodexVersion: fullVersion }) }));
    const target = { ...f.target, executable: 'codex' };
    await ensureSharedCodex(target, f.options);
    expect(f.run.mock.calls.filter(([, args]) => args.at(-1) === 'start').map(([command, args]) => [command, args])).toEqual([[full, ['app-server', 'daemon', 'start']]]);
    expect(target.executable).toBe('codex');
  });

  it('does not substitute another complete CLI for an explicit standalone path', async () => {
    const f = await fixture(), full = await packageFixture(path.join(f.home, 'full-cli'));
    f.discovery.recommendedManaged = { ...f.target, executable: full, transport: 'managed' };
    f.discovery.installations.push({ executable: full, name: 'Complete CLI', source: 'path', version: '0.163.0', running: false });
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValue({ code: 1, stdout: '' });
    await expect(ensureSharedCodex(f.target, f.options)).rejects.toMatchObject({ code: 'shared-package-incomplete', message: expect.stringContaining('полный пакет CLI') });
    expect(f.run.mock.calls.some(([command]) => command === full)).toBe(false);
    expect(f.run.mock.calls.some(([, args]) => args.at(-1) === 'start')).toBe(false);
  });

  it.each(['0.164.0', '0.163.0'])('rejects an unsupported package manifest even when discovery reports %s', async reportedVersion => {
    const f = await fixture(), full = await packageFixture(path.join(f.home, 'unsupported-cli'), '0.164.0');
    f.discovery.installations.push({ executable: full, name: 'Unsupported complete CLI', source: 'path', version: reportedVersion, running: false });
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValue({ code: 1, stdout: '' });
    await expect(ensureSharedCodex({ ...f.target, executable: 'codex' }, f.options)).rejects.toMatchObject({ code: 'shared-package-incomplete' });
    expect(f.run.mock.calls.some(([command]) => command === full)).toBe(false);
    expect(f.run.mock.calls.some(([, args]) => args.at(-1) === 'start')).toBe(false);
  });

  it('rejects a manifest-only partial package before native startup', async () => {
    const f = await fixture();
    f.target.executable = await packageFixture(path.join(f.home, 'partial-cli'));
    await rm(path.join(path.dirname(f.target.executable), process.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'));
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValue({ code: 1, stdout: '' });
    await expect(ensureSharedCodex(f.target, f.options)).rejects.toMatchObject({ code: 'shared-package-incomplete' });
    expect(f.run.mock.calls.some(([, args]) => args.at(-1) === 'start')).toBe(false);
  });

  it('accepts the complete native optional package behind an official npm wrapper without replacing its literal path', async () => {
    const f = await fixture(), npm = path.join(f.home, 'node_modules', '@openai', 'codex');
    const target = `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-${process.platform === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-musl'}`;
    const optional = path.join(f.home, 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`);
    await packageFixture(path.join(optional, 'vendor', target));
    await writeFile(path.join(optional, 'package.json'), JSON.stringify({ name: `@openai/codex-${process.platform}-${process.arch}` }));
    await mkdir(path.join(npm, 'bin'), { recursive: true });
    await writeFile(path.join(npm, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    f.target.executable = path.join(npm, 'bin', 'codex.js'); await writeFile(f.target.executable, '// synthetic official wrapper');
    f.run.mockImplementation(async (_command, args) => ({ code: args.at(-1) === 'version' ? 1 : 0,
      stdout: args.at(-1) === '--version' ? 'codex-cli 0.163.0' : JSON.stringify({ ...f.daemon, status: 'started' }) }));
    await ensureSharedCodex(f.target, f.options);
    expect(f.run.mock.calls.filter(([, args]) => args.at(-1) === 'start').map(([, args]) => args)).toEqual([[f.target.executable, 'app-server', 'daemon', 'start']]);
  });

  it('resolves automatic CLI discovery only in the selected profile', async () => {
    const f = await fixture();
    const result = await ensureSharedCodex({ ...f.target, executable: 'codex' }, f.options);
    expect(result.executable).toBe(f.executable);
    expect(f.discover).toHaveBeenCalledWith({ env: expect.objectContaining({ CODEX_HOME: f.home }), codexHome: f.home });
  });

  it.each(['missing', 'unverified'])('keeps a healthy durable daemon accessible after the Desktop CLI becomes %s', async desktop => {
    const f = await fixture();
    const native = path.join(f.home, 'packages', 'app-server-daemon', 'current', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    await mkdir(path.dirname(native), { recursive: true }); await writeFile(native, 'synthetic-native-package');
    f.discover.mockRejectedValue(new Error(`Desktop CLI ${desktop}`));
    const target = { ...f.target, executable: 'codex' };
    const result = await ensureSharedCodex(target, f.options);
    expect(result).toMatchObject({ transport: 'proxy', endpoint: f.socketPath });
    expect(f.run.mock.calls[0][0]).toBe(native);
    expect(f.run.mock.calls[1][0]).toBe(native);
    expect(f.discover).not.toHaveBeenCalled();
    expect(target).toMatchObject({ executable: 'codex', endpoint: '' });
  });

  it('resolves an installed CLI for read-only passthrough without a daemon lifecycle call', async () => {
    const f = await fixture();
    expect(await resolveSharedCodexExecutable({ ...f.target, executable: 'codex' }, f.options)).toBe(f.target.executable);
    expect(f.run.mock.calls.map(([, args]) => args)).toEqual([[f.target.executable, '--version']]);
  });

  it('inherits the native profile without creating or copying a separate Codex home', async () => {
    const f = await fixture();
    const { codexHome: _profile, ...target } = f.target;
    const result = await ensureSharedCodex(target, { ...f.options, env: { CODEX_HOME: f.home } });
    expect(result).toMatchObject({ transport: 'proxy', endpoint: f.socketPath });
    expect(result.codexHome).toBe(f.home);
    expect(target).not.toHaveProperty('codexHome');
    expect(f.run.mock.calls.every(([, , , env]) => env.CODEX_HOME === f.home)).toBe(true);
  });

  it('accepts the same selected profile through a directory alias and returns its canonical home', async () => {
    const f = await fixture();
    const directory = await mkdtemp(path.join(tmpdir(), 'rele-shared-alias-'));
    directories.push(directory);
    const alias = path.join(directory, 'profile');
    await symlink(f.home, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const target = { ...f.target, codexHome: alias };
    f.daemon.socketPath = path.join(alias, 'app-server-control', 'app-server-control.sock');
    const result = await ensureSharedCodex(target, f.options);
    expect(result).toMatchObject({ transport: 'proxy', codexHome: f.home, endpoint: f.daemon.socketPath });
    expect(target.codexHome).toBe(alias);
  });

  it('uses the external systemd daemon socket without starting a daemon in the service cgroup', async () => {
    const f = await fixture();
    const result = await ensureSharedCodex(f.target, { ...f.options, env: { ...f.env, RELE_CODEX_DAEMON_EXTERNAL: '1' } });
    expect(result).toMatchObject({ transport: 'proxy', endpoint: f.socketPath });
    expect(f.run.mock.calls.map(([, args]) => args)).toEqual([[f.target.executable, '--version'], [f.target.executable, 'app-server', 'daemon', 'version']]);
    expect(f.discover).not.toHaveBeenCalled();
  });

  it('waits for the first independent sidecar tick before returning an external socket', async () => {
    const f = await fixture();
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValueOnce({ code: 1, stdout: '' });
    const result = await ensureSharedCodex(f.target, { ...f.options, timeoutMs: 1_000, env: { ...f.env, RELE_CODEX_DAEMON_EXTERNAL: '1' } });
    expect(result).toMatchObject({ transport: 'proxy', endpoint: f.socketPath, executable: f.executable });
    expect(f.run.mock.calls.map(([, args]) => args.at(-1))).toEqual(['--version', 'version', 'version']);
    expect(f.discover).not.toHaveBeenCalled();
  });

  it('bounds external readiness errors without starting a daemon or exposing native output', async () => {
    const f = await fixture();
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValue({ code: 1, stdout: 'synthetic-foreign-error' });
    const error = await ensureSharedCodex(f.target, { ...f.options, timeoutMs: 30, env: { ...f.env, RELE_CODEX_DAEMON_EXTERNAL: '1' } }).catch(error => error);
    expect(error).toMatchObject({ code: 'shared-daemon-unavailable' });
    expect(error.message).not.toContain('synthetic-foreign');
    expect(f.run.mock.calls.slice(1).every(([, args]) => args.at(-1) === 'version')).toBe(true);
    expect(f.discover).not.toHaveBeenCalled();
  });

  it.each(['profile', 'version'])('rejects an external daemon with the wrong %s immediately without retrying or starting', async field => {
    const f = await fixture();
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValue({ code: 0, stdout: JSON.stringify({ ...f.daemon,
      ...(field === 'profile' ? { socketPath: path.join(path.dirname(f.home), 'foreign', 'control.sock') } : { managedCodexVersion: '0.164.0' }) }) });
    await expect(ensureSharedCodex(f.target, { ...f.options, env: { ...f.env, RELE_CODEX_DAEMON_EXTERNAL: '1' } })).rejects.toMatchObject({ code: field === 'profile' ? 'shared-profile-mismatch' : 'shared-daemon-invalid' });
    expect(f.run.mock.calls).toHaveLength(2);
  });

  it.each(['socket', 'executable', 'version', 'status', 'json'])('fails closed on an unconfirmed daemon %s without starting a replacement', async field => {
    const f = await fixture();
    const output = { ...f.daemon,
      ...(field === 'socket' ? { socketPath: path.join(path.dirname(f.home), 'other-profile', 'control.sock') } : {}),
      ...(field === 'executable' ? { managedCodexPath: 'relative' } : {}),
      ...(field === 'version' ? { managedCodexVersion: '0.164.0' } : {}),
      ...(field === 'status' ? { status: 'notRunning' } : {}),
    };
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValueOnce({ code: 0, stdout: field === 'json' ? 'synthetic-private-output' : JSON.stringify(output) });
    await expect(ensureSharedCodex(f.target, f.options)).rejects.toMatchObject({ code: field === 'socket' ? 'shared-profile-mismatch' : 'shared-daemon-invalid' });
    expect(f.run.mock.calls).toHaveLength(2);
  });

  it('keeps unsupported native CLI versions read only before any daemon operation', async () => {
    const f = await fixture(); f.run.mockResolvedValue({ code: 0, stdout: 'codex-cli 0.164.0' });
    await expect(ensureSharedCodex(f.target, f.options)).rejects.toMatchObject({ code: 'shared-cli-unverified' });
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it('reconciles a failed native start with delayed readiness without starting twice', async () => {
    const f = await fixture();
    f.target.executable = await packageFixture(path.join(f.home, 'source-package'));
    let startAttempted = false, versionCalls = 0;
    f.run.mockImplementation(async (_command, args) => {
      if (args.at(-1) === '--version') return { code: 0, stdout: 'codex-cli 0.163.0' };
      if (args.at(-1) === 'start') { startAttempted = true; return { code: 1, stdout: 'synthetic-private-error' }; }
      return startAttempted && ++versionCalls === 2 ? { code: 0, stdout: JSON.stringify(f.daemon) } : { code: 1, stdout: '' };
    });
    await expect(ensureSharedCodex(f.target, f.options)).resolves.toMatchObject({ transport: 'proxy', endpoint: f.socketPath, codexHome: f.home });
    expect(f.run.mock.calls.map(([, args]) => args.at(-1))).toEqual(['--version', 'version', 'start', 'version', 'version']);
    expect(f.run.mock.calls.at(-1)![2]).toBeLessThan(15_000);
  });

  it.each(['profile', 'version', 'json'])('rejects an invalid %s readiness receipt after failed startup', async field => {
    const f = await fixture();
    f.target.executable = await packageFixture(path.join(f.home, 'source-package'));
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' })
      .mockResolvedValueOnce({ code: 1, stdout: '' }).mockResolvedValueOnce({ code: 1, stdout: '' })
      .mockResolvedValue({ code: 0, stdout: field === 'json' ? 'synthetic-private-error' : JSON.stringify({ ...f.daemon,
        ...(field === 'profile' ? { socketPath: path.join(path.dirname(f.home), 'foreign', 'control.sock') } : { managedCodexVersion: '0.164.0' }) }) });
    const error = await ensureSharedCodex(f.target, f.options).catch(error => error);
    expect(error).toMatchObject({ code: field === 'profile' ? 'shared-profile-mismatch' : 'shared-daemon-invalid' });
    expect(error.message).not.toContain('synthetic-private');
    expect(f.run.mock.calls).toHaveLength(4);
  });

  it('keeps native startup failures sanitized without fallback to another runtime', async () => {
    const f = await fixture();
    f.target.executable = await packageFixture(path.join(f.home, 'source-package'));
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValue({ code: 1, stdout: 'synthetic-private-error' });
    const error = await ensureSharedCodex(f.target, { ...f.options, timeoutMs: 20 }).catch(error => error);
    expect(error).toMatchObject({ code: 'shared-daemon-unavailable' });
    expect(error.message).not.toContain('synthetic-private');
    expect(f.run.mock.calls.filter(([, args]) => args.at(-1) === 'start')).toHaveLength(1);
  });

  it('does not extend the native start budget for readiness readback', async () => {
    const f = await fixture();
    f.target.executable = await packageFixture(path.join(f.home, 'source-package'));
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValueOnce({ code: 1, stdout: '' })
      .mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { code: 1, stdout: '' }; });
    await expect(ensureSharedCodex(f.target, { ...f.options, timeoutMs: 5 })).rejects.toMatchObject({ code: 'shared-daemon-unavailable' });
    expect(f.run.mock.calls.map(([, args]) => args.at(-1))).toEqual(['--version', 'version', 'start']);
  });

  it('bounds and sanitizes real synthetic command output without reading native auth or history', async () => {
    const f = await fixture();
    await writeFile(f.target.executable, "process.stdout.write(process.argv.includes('--version') ? 'codex-cli 0.163.0' : 'synthetic-private-output');\n");
    const error = await ensureSharedCodex(f.target, { env: { CODEX_HOME: f.home }, timeoutMs: 2_000 }).catch(error => error);
    expect(error).toMatchObject({ code: 'shared-daemon-invalid' });
    expect(error.message).not.toContain('synthetic-private');
  });
});
