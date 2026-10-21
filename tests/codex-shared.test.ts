import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexConnectionTarget, CodexDiscoveryResult } from '../src/shared/types.js';
import { ensureSharedCodex, resolveSharedCodexExecutable, type SharedCodexOptions } from '../src/server/codex-shared.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'rele-shared-test-'));
  directories.push(home);
  const socketPath = path.join(home, 'app-server-control', 'app-server-control.sock');
  const executable = path.join(home, process.platform === 'win32' ? 'codex.exe' : 'codex');
  const target: CodexConnectionTarget = { transport: 'shared', executable: path.join(home, 'codex.mjs'), endpoint: '', codexHome: home };
  const daemon = { status: 'running', managedCodexPath: executable, managedCodexVersion: '0.163.0', socketPath };
  const run = vi.fn<NonNullable<SharedCodexOptions['run']>>(async (_command, args) => ({
    code: 0, stdout: args.at(-1) === '--version' ? 'codex-cli 0.163.0\n' : JSON.stringify(daemon),
  }));
  const discovery: CodexDiscoveryResult = { installations: [], issues: [], recommendedManaged: { ...target, transport: 'managed' } };
  const discover = vi.fn().mockResolvedValue(discovery);
  const env = { CODEX_HOME: '/inherited-profile', RELE_TEST_MARKER: 'preserved', OPENAI_API_KEY: 'synthetic-key' };
  return { home, target, socketPath, executable, daemon, run, discovery, discover, env, options: { run, discover, env } };
}

describe('native shared Codex lifecycle', () => {
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
    f.run.mockImplementation(async (_command, args) => args.at(-1) === '--version' ? { code: 0, stdout: 'codex-cli 0.163.0\n' }
      : args.at(-1) === 'version' ? { code: 1, stdout: '' } : { code: 0, stdout: JSON.stringify({ ...f.daemon, status }) });
    await ensureSharedCodex(f.target, f.options);
    expect(f.run.mock.calls.map(([, args]) => args).at(-1)).toEqual([f.target.executable, 'app-server', 'daemon', 'start']);
    expect(f.run.mock.calls.some(([, args]) => args.includes('--json'))).toBe(false);
  });

  it('lets the native singleton recover its stale socket instead of creating a private server', async () => {
    const f = await fixture();
    await mkdir(path.dirname(f.socketPath)); await writeFile(f.socketPath, 'synthetic-stale-socket');
    f.run.mockImplementation(async (_command, args) => ({ code: args.at(-1) === 'version' ? 1 : 0,
      stdout: args.at(-1) === '--version' ? 'codex-cli 0.163.0' : JSON.stringify({ ...f.daemon, status: 'started' }) }));
    await ensureSharedCodex(f.target, f.options);
    expect(f.run.mock.calls.filter(([, args]) => args.at(-1) === 'start')).toHaveLength(1);
    expect(await readFile(f.socketPath, 'utf8')).toBe('synthetic-stale-socket');
    expect(f.run.mock.calls.some(([, args]) => args.includes('--listen'))).toBe(false);
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

  it('keeps native startup failures sanitized without fallback to another runtime', async () => {
    const f = await fixture();
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'codex-cli 0.163.0' }).mockResolvedValue({ code: 1, stdout: 'synthetic-private-error' });
    const error = await ensureSharedCodex(f.target, f.options).catch(error => error);
    expect(error).toMatchObject({ code: 'shared-daemon-unavailable' });
    expect(error.message).not.toContain('synthetic-private');
    expect(f.run.mock.calls.filter(([, args]) => args.at(-1) === 'start')).toHaveLength(1);
  });

  it('bounds and sanitizes real synthetic command output without reading native auth or history', async () => {
    const f = await fixture();
    await writeFile(f.target.executable, "process.stdout.write(process.argv.includes('--version') ? 'codex-cli 0.163.0' : 'synthetic-private-output');\n");
    const error = await ensureSharedCodex(f.target, { env: { CODEX_HOME: f.home }, timeoutMs: 2_000 }).catch(error => error);
    expect(error).toMatchObject({ code: 'shared-daemon-invalid' });
    expect(error.message).not.toContain('synthetic-private');
  });
});
