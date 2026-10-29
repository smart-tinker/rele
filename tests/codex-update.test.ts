import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CodexConnectionState, CodexConnectionTarget, CodexDiscoveryResult } from '../src/shared/types.js';
import { CodexUpdate } from '../src/server/codex-update.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'rele-codex-update-'));
  directories.push(root);
  const data = path.join(root, 'data'), home = path.join(root, 'codex-home');
  const owners = path.join(data, 'codex-websocket-owners'), successor = path.join(owners, 'b'.repeat(64));
  await Promise.all([mkdir(successor, { recursive: true }), mkdir(home)]);
  await writeFile(path.join(root, 'Rele.exe'), 'synthetic launcher; never executed');
  const old = path.join(root, 'old-codex.exe'), installed = path.join(root, 'installed-codex.exe');
  await writeFile(old, 'synthetic running backend; never executed');
  await writeFile(installed, 'synthetic installed backend; never executed');
  const marker = { DataDirectory: data, OwnerSid: 'S-1-5-21-123-456-789-1001', TaskName: 'Rele-Synthetic', CodexHome: home };
  const save = () => writeFile(path.join(root, 'rele-install.json'), JSON.stringify(marker));
  await save();
  const config = path.join(data, 'config.json');
  await writeFile(config, 'protected synthetic settings; must not be read or changed');
  const target: CodexConnectionTarget = { transport: 'shared', executable: 'codex', endpoint: '', codexHome: home };
  const current: CodexConnectionState = { configured: true, connected: true, queueSupported: true, desktopVerified: false,
    name: 'Codex 0.163.0-alpha.11.2', transport: 'shared', executable: old, endpoint: 'ws://127.0.0.1:3219', codexHome: home };
  const discovery: CodexDiscoveryResult = { installations: [
    { executable: old, name: 'Old running Desktop', source: 'desktop-process', version: '0.163.0-alpha.11.2', running: true },
    { executable: installed, name: 'Installed Desktop', source: 'desktop-install', version: '0.164.0-alpha.11.1', running: false },
  ], issues: [] };
  let native: Record<string, unknown> = { status: 'alreadyRunning', ownerSid: marker.OwnerSid, taskName: `${marker.TaskName}-Codex`,
    endpoint: current.endpoint, codexHome: home, executable: old, executableSha256: 'a'.repeat(64),
    processId: 12345, processStartTime: '2026-10-29T00:00:00.000Z' };
  const run = vi.fn(async (command: string, args: string[]) => {
    if (args[0] === 'codex-status') return { code: 0, stdout: JSON.stringify(native) };
    if (command === installed && args.length === 1 && args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.164.0-alpha.11.1\n' };
    if (args[0] === 'codex-apply-update') {
      if (!native.pendingUpdate) return { code: 1, stdout: '' };
      native = { ...native, status: 'alreadyRunning', pendingUpdate: false, ownerDirectory: successor,
        executable: installed, executableSha256: native.successorSha256 ?? native.pendingSha256,
        processId: 54321, processStartTime: '2026-10-29T01:00:00.000Z' };
      return { code: 0, stdout: JSON.stringify(native) };
    }
    if (args[0] !== 'codex-update') throw new Error('Unexpected synthetic launcher operation');
    const digest = createHash('sha256').update(await readFile(installed)).digest('hex');
    if (args[args.indexOf('--expected-sha256') + 1] !== digest) return { code: 1, stdout: '' };
    native = { ...native, pendingUpdate: true, successorDirectory: successor,
      successorExe: installed, successorSha256: digest };
    return { code: 0, stdout: JSON.stringify({ ...native, status: 'updatePrepared' }) };
  });
  const discover = vi.fn(async () => discovery);
  const service = () => new CodexUpdate(root, data, () => target, () => current, { platform: 'win32', discover, run });
  return { root, data, home, old, installed, successor, marker, save, config, target, current, discovery, run, discover,
    service, update: service(), setNative: (value: Record<string, unknown>) => { native = value; }, getNative: () => native };
}

describe('controlled shared Codex update', () => {
  it('reports the newest installed Desktop independently of an old running backend and changes nothing during status reads', async () => {
    const f = await fixture(), before = await readFile(f.config, 'utf8');
    f.discovery.installations.push({ executable: path.join(f.root, 'cli'), source: 'path', name: 'Unrelated CLI', version: '99.0.0', running: false });
    expect(await f.update.status()).toEqual({ available: true, phase: 'available', currentVersion: '0.163.0-alpha.11.2', installedVersion: '0.164.0-alpha.11.1' });
    expect(f.run.mock.calls.map(([, args]) => args[0])).toEqual(['codex-status']);
    expect(await readFile(f.config, 'utf8')).toBe(before);
  });

  it('shows an unsupported newest Desktop without preparing it or silently choosing an older installation', async () => {
    const f = await fixture();
    f.discovery.installations.push({ executable: path.join(f.root, 'newest-codex.exe'), source: 'desktop-install', name: 'Newest Desktop', version: '9.0.0', running: false });
    expect(await f.update.status()).toMatchObject({ available: true, phase: 'unsupported', installedVersion: '9.0.0' });
    await expect(f.update.prepare()).rejects.toThrow('пока не проверена');
    expect(f.run.mock.calls.every(([, args]) => args[0] === 'codex-status')).toBe(true);
  });

  it('stages the supported installed backend through the fixed launcher and preserves the live target and settings', async () => {
    const f = await fixture(), before = structuredClone({ target: f.target, current: f.current });
    const settings = await readFile(f.config, 'utf8');
    expect(await f.update.prepare()).toMatchObject({ available: true, phase: 'ready', installedVersion: '0.164.0-alpha.11.1', pendingVersion: '0.164.0-alpha.11.1' });
    const digest = createHash('sha256').update(await readFile(f.installed)).digest('hex');
    expect(f.run).toHaveBeenLastCalledWith(path.join(f.root, 'Rele.exe'), ['codex-update', '--quiet', '--codex-executable', f.installed, '--expected-sha256', digest, '--codex-home', f.home]);
    expect({ target: f.target, current: f.current }).toEqual(before);
    expect(await readFile(f.config, 'utf8')).toBe(settings);
    expect((await f.update.status()).phase).toBe('ready');
    await f.update.prepare();
    expect(f.run.mock.calls.filter(([, args]) => args[0] === 'codex-update')).toHaveLength(1);
  });

  it.each(['platform', 'portable', 'profile', 'manual', 'transport'] as const)('keeps an unavailable %s installation read-only', async kind => {
    const f = await fixture();
    let service = f.update;
    if (kind === 'platform') service = new CodexUpdate(f.root, f.data, () => f.target, () => f.current, { platform: 'linux', discover: f.discover, run: f.run });
    if (kind === 'portable') await rm(path.join(f.root, 'rele-install.json'));
    if (kind === 'profile') { f.marker.DataDirectory = f.home; await f.save(); }
    if (kind === 'manual') f.target.executable = f.installed;
    if (kind === 'transport') f.target.transport = 'websocket';
    expect(await service.status()).toMatchObject({ available: false, phase: 'current' });
    await expect(service.prepare()).rejects.toThrow('Подготовка обновления доступна');
    expect(f.run).not.toHaveBeenCalled(); expect(f.discover).not.toHaveBeenCalled();
  });

  it.each(['target', 'runtime'] as const)('rejects a changed %s after discovery before touching the native task', async changed => {
    const f = await fixture();
    f.discover.mockImplementationOnce(async () => {
      if (changed === 'target') f.target.codexHome = path.join(f.root, 'other-profile');
      else f.current.endpoint = 'ws://127.0.0.1:3220';
      return f.discovery;
    });
    await expect(f.update.prepare()).rejects.toMatchObject({ statusCode: 409 });
    expect(f.run).not.toHaveBeenCalled();
  });

  it('recovers a prepared update in a new gateway service without repeating preparation', async () => {
    const f = await fixture();
    await f.update.prepare();
    f.current.connected = false; delete f.current.name; delete f.current.codexHome;
    const fresh = f.service();
    expect(await fresh.status()).toMatchObject({ available: true, phase: 'ready', currentVersion: '0.163.0-alpha.11.2', installedVersion: '0.164.0-alpha.11.1', pendingVersion: '0.164.0-alpha.11.1' });
    await fresh.prepare();
    expect(f.run.mock.calls.filter(([, args]) => args[0] === 'codex-update')).toHaveLength(1);
    f.setNative({ ...f.getNative(), pendingUpdate: false, executable: f.installed, executableSha256: 'b'.repeat(64) });
    expect(await f.service().status()).toMatchObject({ phase: 'current', currentVersion: '0.164.0-alpha.11.1' });
  });

  it('reports a prepared stopped owner without claiming the update is applied', async () => {
    const f = await fixture();
    f.current.connected = false;
    f.setNative({ status: 'notRunning', ownerSid: f.marker.OwnerSid, taskName: `${f.marker.TaskName}-Codex`, pendingUpdate: true, pendingExe: f.installed, pendingSha256: 'b'.repeat(64),
      successorDirectory: f.successor, endpoint: f.current.endpoint, codexHome: f.home });
    expect(await f.update.status()).toMatchObject({ phase: 'ready', pendingVersion: '0.164.0-alpha.11.1' });
    expect(f.run.mock.calls.map(([, args]) => args[0])).toEqual(['codex-status']);
  });

  it.each(['version', 'bytes'] as const)('rejects installed %s changing during the version check before staging', async changed => {
    const f = await fixture(), original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (command, args) => {
      if (args[0] === '--version') {
        if (changed === 'version') return { code: 0, stdout: 'codex-cli 9.0.0\n' };
        await writeFile(f.installed, 'replacement installed backend during version probe');
      }
      return original(command, args);
    });
    await expect(f.update.prepare()).rejects.toMatchObject({ statusCode: 409 });
    expect(f.run.mock.calls.filter(([, args]) => args[0] === 'codex-update')).toHaveLength(0);
    expect(f.getNative().pendingUpdate).toBeUndefined();
  });

  it('passes the probed digest so native staging rejects a replacement after the version check', async () => {
    const f = await fixture(), original = f.run.getMockImplementation()!;
    const digest = createHash('sha256').update(await readFile(f.installed)).digest('hex');
    f.run.mockImplementation(async (command, args) => {
      if (args[0] === 'codex-update') await writeFile(f.installed, 'replacement installed backend before native file hold');
      return original(command, args);
    });
    await expect(f.update.prepare()).rejects.toMatchObject({ statusCode: 502 });
    const updateCalls = f.run.mock.calls.filter(([, args]) => args[0] === 'codex-update');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][1]).toContain('--expected-sha256');
    expect(updateCalls[0][1]).toContain(digest);
    expect(f.getNative().pendingUpdate).toBeUndefined();
  });

  it('distinguishes the prepared successor from a newer Desktop installed later', async () => {
    const f = await fixture();
    await f.update.prepare();
    f.discovery.installations.push({ executable: path.join(f.root, 'later-codex.exe'), source: 'desktop-install', name: 'Later Desktop', version: '0.165.0-alpha.1.2', running: false });
    expect(await f.service().status()).toMatchObject({ phase: 'ready', installedVersion: '0.165.0-alpha.1.2', pendingVersion: '0.164.0-alpha.11.1' });
    expect(f.run.mock.calls.filter(([, args]) => args[0] === 'codex-update')).toHaveLength(1);
  });

  it('fences an installation profile change between status inspection and future-task mutation', async () => {
    const f = await fixture(), original = f.run.getMockImplementation()!;
    f.run.mockImplementationOnce(async (command, args) => {
      f.marker.CodexHome = path.join(f.root, 'replacement-profile');
      await f.save();
      return original(command, args);
    });
    await expect(f.update.prepare()).rejects.toMatchObject({ statusCode: 409 });
    expect(f.run.mock.calls.map(([, args]) => args[0])).toEqual(['codex-status', '--version']);
  });

  it('rejects overlapping preparation while status remains readable', async () => {
    const f = await fixture();
    let release!: () => void;
    f.discover.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return f.discovery; });
    const pending = f.update.prepare();
    await vi.waitFor(() => expect(f.discover).toHaveBeenCalledOnce());
    await expect(f.update.prepare()).rejects.toMatchObject({ statusCode: 409 });
    expect((await f.update.status()).phase).toBe('preparing');
    release();
    expect((await pending).phase).toBe('ready');
    expect(f.run.mock.calls.filter(([, args]) => args[0] === 'codex-update')).toHaveLength(1);
  });

  it('applies the exact prepared successor after Rele disconnects, without changing the target or settings', async () => {
    const f = await fixture();
    await f.update.prepare();
    f.current.connected = false;
    const target = structuredClone(f.target), settings = await readFile(f.config, 'utf8');
    expect(await f.update.apply()).toEqual({ available: true, phase: 'current', currentVersion: '0.164.0-alpha.11.1', installedVersion: '0.164.0-alpha.11.1' });
    expect(f.run).toHaveBeenLastCalledWith(path.join(f.root, 'Rele.exe'), ['codex-apply-update', '--quiet', '--codex-home', f.home]);
    expect(f.target).toEqual(target);
    expect(await readFile(f.config, 'utf8')).toBe(settings);
    expect(await f.service().status()).toMatchObject({ phase: 'current', currentVersion: '0.164.0-alpha.11.1' });
    expect(f.getNative().processId).toBe(54321);
  });

  it('requires a verified own pending update before applying', async () => {
    const f = await fixture();
    await expect(f.update.apply()).rejects.toThrow('Сначала подготовьте');
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'codex-apply-update')).toBe(false);
  });

  it.each(['target', 'runtime', 'marker', 'hash'] as const)('rejects a changed %s before applying the prepared update', async changed => {
    const f = await fixture();
    await f.update.prepare();
    f.current.connected = false;
    if (changed === 'target' || changed === 'runtime') f.discover.mockImplementationOnce(async () => {
      if (changed === 'target') f.target.codexHome = path.join(f.root, 'replacement-profile');
      else f.current.endpoint = 'ws://127.0.0.1:3220';
      return f.discovery;
    });
    if (changed === 'marker') {
      const original = f.run.getMockImplementation()!;
      f.run.mockImplementationOnce(async (command, args) => {
        f.marker.TaskName = 'Rele-Replacement'; await f.save();
        return original(command, args);
      });
    }
    if (changed === 'hash') await writeFile(f.installed, 'replaced prepared backend');
    await expect(f.update.apply()).rejects.toMatchObject({ statusCode: 409 });
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'codex-apply-update')).toBe(false);
    expect(f.getNative().processId).toBe(12345);
  });

  it('keeps a native busy refusal retryable and does not promise the old PID after an unconfirmed apply', async () => {
    const f = await fixture(), original = f.run.getMockImplementation()!;
    await f.update.prepare();
    f.current.connected = false;
    f.run.mockImplementation(async (command, args) => args[0] === 'codex-apply-update'
      ? { code: 1, stdout: 'PRIVATE_OUTPUT busy details' } : original(command, args));
    await expect(f.update.apply()).rejects.toMatchObject({ statusCode: 502, message: 'Обновление не подтверждено. Проверьте состояние Codex; очередь сохранена.' });
    expect(await f.update.status()).toMatchObject({ phase: 'ready', pendingVersion: '0.164.0-alpha.11.1' });
    expect(f.getNative().processId).toBe(12345);
    expect(JSON.stringify(await f.update.status())).not.toContain('PRIVATE_OUTPUT');
    f.run.mockImplementation(original);
    expect((await f.update.apply()).phase).toBe('current');
  });

  it('serializes apply with preparation and exposes applying status', async () => {
    const f = await fixture(), original = f.run.getMockImplementation()!;
    await f.update.prepare(); f.current.connected = false;
    let release!: () => void;
    f.run.mockImplementation(async (command, args) => {
      if (args[0] === 'codex-apply-update') await new Promise<void>(resolve => { release = resolve; });
      return original(command, args);
    });
    const applying = f.update.apply();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect((await f.update.status()).phase).toBe('applying');
    await expect(f.update.prepare()).rejects.toMatchObject({ statusCode: 409 });
    await expect(f.update.apply()).rejects.toMatchObject({ statusCode: 409 });
    release();
    expect((await applying).phase).toBe('current');
  });

  it.each(['owner', 'task', 'profile', 'endpoint', 'executable', 'hash', 'directory', 'pid', 'birth'] as const)('does not accept an applied receipt with a different %s', async field => {
    const f = await fixture(), original = f.run.getMockImplementation()!;
    await f.update.prepare(); f.current.connected = false;
    const patch = { owner: { ownerSid: 'S-1-5-21-999' }, task: { taskName: 'Rele-Foreign-Codex' },
      profile: { codexHome: f.data }, endpoint: { endpoint: 'ws://127.0.0.1:3220' }, executable: { executable: f.old },
      hash: { executableSha256: '0'.repeat(64) }, directory: { ownerDirectory: path.dirname(f.successor) },
      pid: { processId: 0 }, birth: { processStartTime: 'unconfirmed' } }[field];
    f.run.mockImplementation(async (command, args) => {
      const result = await original(command, args);
      return args[0] === 'codex-apply-update' ? { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), ...patch }) } : result;
    });
    await expect(f.update.apply()).rejects.toMatchObject({ statusCode: 502, message: 'Обновление не подтверждено. Проверьте состояние Codex; очередь сохранена.' });
  });

  it.each(['throw', 'unconfirmed', 'foreign-successor', 'foreign-hash'] as const)('never leaks native output or accepts an unconfirmed %s preparation', async kind => {
    const f = await fixture(), original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (command, args) => {
      if (args[0] !== 'codex-update') return original(command, args);
      if (kind === 'throw') throw new Error('PRIVATE_OUTPUT auth/settings');
      if (kind === 'unconfirmed') return { code: 0, stdout: '{"status":"started","secret":"PRIVATE_OUTPUT"}' };
      const result = await original(command, args);
      return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), ...(kind === 'foreign-hash' ? { successorSha256: '0'.repeat(64) } : { successorExe: f.old }) }) };
    });
    await expect(f.update.prepare()).rejects.toMatchObject({ statusCode: 502 });
    const status = await f.update.status();
    expect(JSON.stringify(status)).not.toContain('PRIVATE_OUTPUT');
    expect(status.error ?? '').not.toContain(f.root);
  });
});
