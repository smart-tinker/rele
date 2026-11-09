import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CodexConnectionState, CodexConnectionTarget, CodexDiscoveryResult } from '../src/shared/types.js';
import { CodexUpdate } from '../src/server/codex-update.js';
import { nativeCodexExecutable } from '../src/server/codex-shared.js';
import { LinuxCodexUpdateError, type LinuxCodexInspection, type LinuxCodexCandidate } from '../src/server/codex-linux-update.js';

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
    if (args.length === 1 && args[0] === '--version') {
      const executable = await realpath(command).catch(() => undefined);
      const version = executable && (await Promise.all(discovery.installations.map(async item => {
        try { return (await realpath(item.executable)).toLowerCase() === executable.toLowerCase() ? item.version : undefined; }
        catch { return undefined; }
      }))).find(Boolean);
      return { code: version ? 0 : 1, stdout: version ? `codex-cli ${version}\n` : '' };
    }
    if (args[0] === 'codex-apply-update') {
      if (!native.pendingUpdate) return { code: 1, stdout: '' };
      native = { ...native, status: 'alreadyRunning', pendingUpdate: false, ownerDirectory: successor,
        executable: native.successorExe ?? native.pendingExe, executableSha256: native.successorSha256 ?? native.pendingSha256,
        processId: 54321, processStartTime: '2026-10-29T01:00:00.000Z' };
      return { code: 0, stdout: JSON.stringify(native) };
    }
    if (args[0] !== 'codex-update') throw new Error('Unexpected synthetic launcher operation');
    const selected = args[args.indexOf('--codex-executable') + 1];
    const digest = createHash('sha256').update(await readFile(selected)).digest('hex');
    if (args[args.indexOf('--expected-sha256') + 1] !== digest) return { code: 1, stdout: '' };
    native = { ...native, pendingUpdate: true, successorDirectory: successor,
      successorExe: selected, successorSha256: digest };
    return { code: 0, stdout: JSON.stringify({ ...native, status: 'updatePrepared' }) };
  });
  const discover = vi.fn(async () => discovery);
  const resolveNative = vi.fn(async (executable: string) => realpath(executable));
  const service = () => new CodexUpdate(root, data, () => target, () => current, { platform: 'win32', discover, run, resolveNative });
  return { root, data, home, old, installed, successor, marker, save, config, target, current, discovery, run, discover,
    service, update: service(), resolveNative, setNative: (value: Record<string, unknown>) => { native = value; }, getNative: () => native };
}

async function linuxFixture() {
  const f = await fixture();
  let inspection: LinuxCodexInspection = { available: true, owner: { kind: 'daemon', codexHome: f.home,
    endpoint: f.current.endpoint!, executable: f.old, version: '0.163.0-alpha.11.2', sha256: 'a'.repeat(64),
    pid: 12345, startTicks: '123', uid: 1000, pidRecordPath: path.join(f.home, 'daemon.pid'), pidRecordSha256: 'b'.repeat(64) } };
  const linux = {
    inspect: vi.fn(async () => inspection),
    prepare: vi.fn(async (_target: CodexConnectionTarget, _current: CodexConnectionState, candidate: LinuxCodexCandidate) => {
      inspection.pending = { candidate, owner: inspection.owner!, phase: 'ready' };
      return inspection;
    }),
    apply: vi.fn(async () => {
      const pending = inspection.pending!;
      const result = { ...pending.candidate, codexHome: pending.owner.codexHome, endpoint: pending.owner.endpoint,
        pid: 54321, startTicks: '456', uid: 1000, cleanup: 'native-managed' as const };
      inspection = { available: true, owner: { ...pending.owner, ...result }, pending: { ...pending, phase: 'verified' } };
      return result;
    }),
  };
  const update = new CodexUpdate(f.root, f.data, () => f.target, () => f.current,
    { platform: 'linux', linux, discover: f.discover, run: f.run, resolveNative: f.resolveNative });
  return { ...f, update, linux, inspect: () => inspection };
}

describe('Linux controlled update API policy', () => {
  it('matches the selected executable when discovery and execution use different path spellings', async () => {
    const f = await linuxFixture();
    const alias = path.join(f.root, 'path-alias');
    await mkdir(alias);
    f.discovery.installations[1]!.executable = `${alias}${path.sep}..${path.sep}installed-codex.exe`;
    await expect(f.update.prepare()).resolves.toMatchObject({ phase: 'ready', pendingVersion: '0.164.0-alpha.11.1' });
  });

  it('recognizes the verified native-managed copy of a pinned source package instead of offering the same update again', async () => {
    const f = await linuxFixture();
    f.target.executable = f.installed;
    await f.update.prepare();
    await f.update.apply();
    const state = f.inspect();
    state.owner!.executable = path.join(f.home, 'packages/app-server-daemon/releases/verified-copy/bin/codex');
    expect(await f.update.status()).toMatchObject({ phase: 'current', selectionMode: 'manual', currentVersion: '0.164.0-alpha.11.1' });
    await expect(f.update.prepare()).rejects.toThrow('Подготовка обновления доступна');
    expect(f.linux.apply).toHaveBeenCalledTimes(1);
  });
  it('selects and prepares the installed candidate, then applies after Rele closes its client', async () => {
    const f = await linuxFixture();
    expect(await f.update.status()).toMatchObject({ available: true, phase: 'available', selectedVersion: '0.164.0-alpha.11.1' });
    expect(await f.update.prepare()).toMatchObject({ phase: 'ready', pendingVersion: '0.164.0-alpha.11.1' });
    f.current.connected = false;
    f.current.codexHome = undefined;
    expect(await f.update.apply()).toMatchObject({ phase: 'current', currentVersion: '0.164.0-alpha.11.1' });
    expect(f.linux.apply).toHaveBeenCalledTimes(1);
    expect(await readFile(f.config, 'utf8')).toBe('protected synthetic settings; must not be read or changed');
  });

  it('explains an external owner without probing or changing a candidate', async () => {
    const f = await linuxFixture();
    f.linux.inspect.mockResolvedValue({ available: false, reason: 'Codex запущен внешней службой. Обновите его через владельца службы.' });
    expect(await f.update.status()).toMatchObject({ available: false, error: expect.stringContaining('внешней службой') });
    await expect(f.update.prepare()).rejects.toMatchObject({ statusCode: 409 });
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.linux.apply).not.toHaveBeenCalled();
  });

  it('preserves an uncertain native result without blind replay', async () => {
    const f = await linuxFixture();
    await f.update.prepare();
    f.linux.apply.mockRejectedValue(new LinuxCodexUpdateError('Исход переключения требует сверки.', 503, 'uncertain'));
    await expect(f.update.apply()).rejects.toMatchObject({ statusCode: 503, reasonCode: 'uncertain' });
    expect(f.linux.apply).toHaveBeenCalledTimes(1);
    expect((await f.update.status()).error).toContain('сверки');
  });

  it('rejects a manual selection that no longer matches the prepared candidate', async () => {
    const f = await linuxFixture();
    await f.update.prepare();
    f.target.executable = f.old;
    await expect(f.update.apply()).rejects.toThrow('Подготовлен другой файл');
    expect(f.linux.apply).not.toHaveBeenCalled();
  });
});

async function desktopInstallation(f: Awaited<ReturnType<typeof fixture>>) {
  const bundle = path.join(f.root, 'desktop', 'app'), resources = path.join(bundle, 'resources');
  await mkdir(resources, { recursive: true }); await writeFile(path.join(bundle, 'ChatGPT.exe'), 'synthetic gui');
  await writeFile(path.join(resources, 'app.asar'), 'synthetic archive');
  for (const name of ['codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe', 'rg.exe']) await writeFile(path.join(resources, name), 'synthetic bundled ' + name);
  const source = path.join(resources, 'codex.exe'); f.target.executable = source;
  f.discovery.installations = [{ executable: source, source: 'desktop-install', name: 'Desktop', version: '0.164.0-alpha.11.1', running: false }];
  return { bundle, resources, source };
}

describe('controlled shared Codex update', () => {
  it('recognizes an unchanged manual Desktop source as the running cached package, but not source drift', async () => {
    const f = await fixture(), { source } = await desktopInstallation(f);
    try { await f.update.prepare(); } catch (error) {
      const cache = path.join(f.data, 'codex-desktop-packages');
      const packages = await readdir(cache).catch(() => []);
      const evidence = await Promise.all(packages.map(async directory => {
        const manifest = JSON.parse(await readFile(path.join(cache, directory, 'codex-package.json'), 'utf8'));
        const executable = await readFile(path.join(cache, directory, 'bin', 'codex.exe'));
        return { version: manifest.version, sourceHash: createHash('sha256').update(await readFile(source)).digest('hex'),
          preparedHash: createHash('sha256').update(executable).digest('hex'), manifestHash: manifest.files?.find((file: { path: string }) => file.path === 'bin/codex.exe')?.sha256 };
      }));
      console.error(`prepared-package-diagnostic ${JSON.stringify(evidence)}`);
      throw error;
    }
    await f.update.apply();
    f.current.executable = f.getNative().executable as string; f.current.name = 'Codex 0.164.0-alpha.11.1';
    expect(await f.service().status()).toMatchObject({ phase: 'current', selectedVersion: '0.164.0-alpha.11.1' });
    await writeFile(source, 'same-version source replacement');
    expect(await f.service().status()).toMatchObject({ phase: 'available' });
  });

  it.each(['present', 'gone'])('keeps exact manual npm wrapper identity with its %s canonical source across service recreation', async sourceState => {
    const f = await fixture(), npm = path.join(f.root, 'npm'), root = path.join(npm, 'vendor', 'x86_64-pc-windows-msvc');
    const files = ['bin/codex.exe', 'bin/codex-code-mode-host.exe', 'bin/codex-exec-server.exe', 'codex-path/rg.exe', 'codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe'];
    for (const file of files) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), 'canonical-' + file); }
    await writeFile(path.join(root, 'codex-package.json'), JSON.stringify({ layoutVersion: 1, version: '0.164.0-alpha.11.1', target: 'x86_64-pc-windows-msvc', entrypoint: 'bin/codex.exe', execServer: 'bin/codex-exec-server.exe', resourcesDir: 'codex-resources', pathDir: 'codex-path' }));
    await mkdir(path.join(npm, 'bin')); await writeFile(path.join(npm, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    const wrapper = path.join(npm, 'bin/codex.js'), source = path.join(root, 'bin/codex.exe'); await writeFile(wrapper, '// official wrapper fixture');
    f.target.executable = wrapper; f.resolveNative.mockImplementation(executable => nativeCodexExecutable(executable, 'win32'));
    f.discovery.installations = [{ executable: wrapper, source: 'path', name: 'Official wrapper', version: '0.164.0-alpha.11.1', running: false }];
    const run = f.run.getMockImplementation()!;
    f.run.mockImplementation((command, args) => args[0] === '--version' ? Promise.resolve({ code: 0, stdout: 'codex-cli 0.164.0-alpha.11.1' }) : run(command, args));
    await f.update.prepare(); const cached = f.getNative().successorExe as string;
    expect(cached).not.toBe(source);
    if (sourceState === 'gone') { await rm(npm, { recursive: true }); f.discovery.installations = []; }
    const ready = await f.service().status();
    expect(ready).toMatchObject({ phase: 'ready', pendingVersion: '0.164.0-alpha.11.1' });
    expect(ready.error).toBeUndefined();
    await f.service().apply();
    f.current.executable = cached; f.current.name = 'Codex 0.164.0-alpha.11.1';
    expect(await f.service().status()).toMatchObject({ phase: 'current' });
    f.target.executable = source;
    expect((await f.service().status()).phase).not.toBe('current');
  });

  it('refuses a selected canonical package with a missing manifest before native preparation', async () => {
    const f = await fixture(), root = path.join(f.root, 'canonical');
    const source = path.join(root, 'bin/codex.exe');
    for (const file of ['bin/codex.exe', 'bin/codex-code-mode-host.exe', 'codex-path/rg.exe', 'codex-resources/codex-command-runner.exe']) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), 'canonical-' + file); }
    f.target.executable = source;
    f.discovery.installations = [{ executable: source, source: 'path', name: 'Canonical package', version: '0.166.0-alpha.6', running: false }];
    await expect(f.update.prepare()).rejects.toThrow();
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'codex-update')).toBe(false);
  });

  it.each(['missing', 'changed', 'extra'])('refuses %s prepared helper bytes before native apply and never repairs the cache', async tamper => {
    const f = await fixture(); await desktopInstallation(f); await f.update.prepare();
    const native = f.getNative(), executable = native.successorExe as string;
    const file = path.join(path.dirname(executable), tamper === 'extra' ? 'unexpected.dll' : 'codex-code-mode-host.exe');
    if (tamper === 'missing') await rm(file); else await writeFile(file, 'untrusted helper bytes');
    await expect(f.update.apply()).rejects.toThrow();
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'codex-apply-update')).toBe(false);
    expect(f.getNative()).toEqual(native);
    if (tamper !== 'missing') expect(await readFile(file, 'utf8')).toBe('untrusted helper bytes');
  });

  it('keeps the exact prepared package when its original Desktop is updated in place', async () => {
    const f = await fixture(), { source } = await desktopInstallation(f); await f.update.prepare();
    const executable = f.getNative().successorExe;
    await writeFile(source, 'new Desktop release bytes'); f.discovery.installations[0].version = '0.165.0-alpha.1.2';
    expect(await f.service().status()).toMatchObject({ phase: 'ready', pendingVersion: '0.164.0-alpha.11.1', selectedVersion: '0.164.0-alpha.11.1' });
    await f.service().apply(); expect(f.getNative().executable).toBe(executable);
  });

  it('prepares a full immutable Desktop candidate only on explicit preparation and applies after source deletion', async () => {
    const f = await fixture(), { bundle, source } = await desktopInstallation(f);
    expect(await f.update.status()).toMatchObject({ phase: 'available' });
    expect(await readdir(f.data)).not.toContain('codex-desktop-packages');
    await f.update.prepare(); const pending = f.getNative().successorExe as string;
    expect(pending).not.toBe(source);
    expect(path.relative(f.data, pending)).toMatch(/^codex-desktop-packages[/\\][a-f0-9]{64}[/\\]bin[/\\]codex\.exe$/u);
    expect(await readFile(path.join(path.dirname(pending), 'codex-code-mode-host.exe'), 'utf8')).toBe('synthetic bundled codex-code-mode-host.exe');
    await rm(bundle, { recursive: true }); f.discovery.installations = [];
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation((command, args) => args[0] === '--version' && command === pending ? Promise.resolve({ code: 0, stdout: 'codex-cli 0.164.0-alpha.11.1' }) : original(command, args));
    expect(await f.service().status()).toMatchObject({ phase: 'ready', pendingVersion: '0.164.0-alpha.11.1' });
    expect(await f.service().apply()).toMatchObject({ phase: 'current', currentVersion: '0.164.0-alpha.11.1' });
    expect(f.current.executable).toBe(f.old); expect(await readFile(f.config, 'utf8')).toBe('protected synthetic settings; must not be read or changed');
  });
  it('cleans only after a verified connection and shares one in-flight postflight', async () => {
    const f = await fixture();
    const original = f.run.getMockImplementation()!;
    let finish!: () => void;
    f.run.mockImplementation(async (command, args) => {
      if (args[0] !== 'codex-postflight') return original(command, args);
      await new Promise<void>(resolve => { finish = resolve; });
      return { code: 0, stdout: JSON.stringify({ status: 'verified', cleanup: { freedBytes: 4096, deletedCount: 2, keptCount: 1 } }) };
    });
    f.current.connected = false;
    expect(await f.update.postflight()).toBeUndefined();
    expect(f.run).not.toHaveBeenCalled();
    f.current.connected = true;
    const first = f.update.postflight(), second = f.update.postflight();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const save = vi.fn(async () => {});
    await expect(f.update.changeSelection({ ...f.target, executable: f.installed }, save)).rejects.toMatchObject({ statusCode: 409 });
    expect(save).not.toHaveBeenCalled();
    finish();
    expect(await first).toEqual({ status: 'partial', freedBytes: 4096, deletedCount: 2, keptCount: 1 });
    expect(await second).toEqual(await first);
    expect(f.run.mock.calls.filter(([, args]) => args[0] === 'codex-postflight')).toHaveLength(1);
    expect((await f.update.status()).cleanup).toMatchObject({ freedBytes: 4096, keptCount: 1 });
    expect(await readFile(f.config, 'utf8')).toBe('protected synthetic settings; must not be read or changed');
  });

  it('refuses cleanup when the target changes during installation-marker IO before launching a native command', async () => {
    const f = await fixture();
    const waiting = f.update.postflight();
    f.target.executable = f.installed;
    expect(await waiting).toMatchObject({ status: 'partial', freedBytes: 0 });
    expect(f.run).not.toHaveBeenCalled();
  });

  it('reports deferred cleanup without turning a successful installed server into an update failure', async () => {
    const f = await fixture();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation((command, args) => args[0] === 'codex-postflight'
      ? Promise.resolve({ code: 1, stdout: 'private-child-output' }) : original(command, args));
    expect(await f.update.postflight()).toEqual({ status: 'partial', freedBytes: 0, deletedCount: 0, keptCount: 1 });
    expect(f.current.connected).toBe(true);
  });

  it.each([
    ['clients-open', 409, 'Закройте Desktop'],
    ['busy', 409, 'В Codex ещё выполняется работа'],
    ['unsupported-diagnostics', 503, 'безопасный простой'],
    ['uncertain', 503, 'Исход операции'],
  ] as const)('preserves safe native refusal %s without exposing child output or retrying apply', async (reasonCode, statusCode, text) => {
    const f = await fixture();
    await f.update.prepare();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation((command, args) => args[0] === 'codex-apply-update'
      ? Promise.resolve({ code: 1, stdout: JSON.stringify({ status: 'refused', reasonCode, raw: 'private-child-output' }) })
      : original(command, args));
    await expect(f.update.apply()).rejects.toMatchObject({ statusCode, reasonCode, message: expect.stringContaining(text) });
    expect(f.run.mock.calls.filter(([, args]) => args[0] === 'codex-apply-update')).toHaveLength(1);
    expect((await f.update.status()).error).not.toContain('private-child-output');
    expect(await readFile(f.config, 'utf8')).toBe('protected synthetic settings; must not be read or changed');
  });
  async function addInstallation(f: Awaited<ReturnType<typeof fixture>>, filename: string, version: string, source: 'path' | 'desktop-install' = 'path') {
    const executable = path.join(f.root, filename);
    await writeFile(executable, `synthetic native ${filename}; never executed`);
    f.discovery.installations.push({ executable, version, source, name: filename, running: false });
    return executable;
  }

  it('keeps an explicit current pin even when a newer supported Desktop is installed', async () => {
    const f = await fixture();
    f.target.executable = f.old;
    expect(await f.update.status()).toMatchObject({ available: true, phase: 'current', selectionMode: 'manual', selectedVersion: '0.163.0-alpha.11.2', installedVersion: '0.164.0-alpha.11.1' });
    await expect(f.update.prepare()).rejects.toThrow('Подготовка обновления доступна');
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'codex-update')).toBe(false);
  });

  it.each(['0.165.0-alpha.1.2', '0.166.0-alpha.5.1'])('selects supported %s across sources in automatic mode', async version => {
    const f = await fixture(), cli = await addInstallation(f, 'cli-native.exe', version);
    await addInstallation(f, 'unverified-newer.exe', '9.0.0', 'desktop-install');
    expect(await f.update.status()).toMatchObject({ selectionMode: 'auto', selectedVersion: version, installedVersion: '9.0.0', phase: 'available' });
    await f.update.prepare();
    expect(f.getNative().successorExe).toBe(cli);
  });

  it('uses deterministic equal-version ordering and skips an unusable wrapper', async () => {
    const f = await fixture();
    const preferred = await addInstallation(f, 'aaa-desktop.exe', '0.164.0-alpha.11.1', 'desktop-install');
    const wrapper = await addInstallation(f, 'newer-invalid.cmd', '0.165.0-alpha.1.2');
    const resolve = f.resolveNative.getMockImplementation()!;
    f.resolveNative.mockImplementation((executable, ...rest) => executable === wrapper ? Promise.reject(new Error('No official native package.')) : resolve(executable, ...rest));
    f.discovery.installations.reverse();
    await f.update.prepare();
    expect(f.getNative().successorExe).toBe(preferred);
  });

  it.each(['newer', 'same-version-other-file', 'official-wrapper'] as const)('prepares exactly the manual %s selection without choosing another installation', async kind => {
    const f = await fixture();
    const version = kind === 'same-version-other-file' ? '0.163.0-alpha.11.2' : '0.164.0-alpha.11.1';
    const selected = await addInstallation(f, 'chosen-native.exe', version);
    const configured = kind === 'official-wrapper' ? path.join(f.root, 'codex.cmd') : selected;
    if (kind === 'official-wrapper') {
      const resolve = f.resolveNative.getMockImplementation()!;
      f.resolveNative.mockImplementation(executable => executable === configured ? Promise.resolve(selected) : resolve(executable));
    }
    f.target.executable = configured;
    await addInstallation(f, 'newer-unused.exe', '0.165.0-alpha.1.2');
    expect(await f.update.status()).toMatchObject({ selectionMode: 'manual', selectedVersion: version, phase: 'available' });
    await f.update.prepare();
    expect(f.getNative().successorExe).toBe(selected);
    expect(f.target.executable).toBe(configured);
  });

  it.each(['missing', 'unsupported', 'downgrade'] as const)('blocks a manual %s rather than falling back to another candidate', async kind => {
    const f = await fixture();
    f.target.executable = kind === 'missing' ? path.join(f.root, 'missing.exe')
      : kind === 'unsupported' ? await addInstallation(f, 'unsupported.exe', '9.0.0') : f.old;
    if (kind === 'downgrade') {
      f.current.name = 'Codex 0.164.0-alpha.11.1';
      f.current.executable = f.installed;
      f.setNative({ ...f.getNative(), executable: f.installed });
    }
    expect(await f.update.status()).toMatchObject({ selectionMode: 'manual', phase: 'unsupported', error: expect.stringContaining(kind === 'downgrade' ? 'Понижение' : 'не подтверждён') });
    await expect(f.update.prepare()).rejects.toThrow(kind === 'downgrade' ? 'Понижение' : 'не подтверждён');
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'codex-update')).toBe(false);
  });

  it('does not automatically downgrade a profile that ran a newer version', async () => {
    const f = await fixture();
    f.current.name = 'Codex 0.165.0-alpha.1.2';
    expect(await f.update.status()).toMatchObject({ selectionMode: 'auto', phase: 'unsupported', error: expect.stringContaining('Понижение') });
    await expect(f.update.prepare()).rejects.toThrow('Понижение');
  });

  it('probes a manual native not present in discovery without falling back', async () => {
    const f = await fixture(), selected = path.join(f.root, 'undiscovered-native.exe'), original = f.run.getMockImplementation()!;
    await writeFile(selected, 'synthetic manually chosen file');
    f.target.executable = selected;
    f.run.mockImplementation((command, args) => command === selected && args[0] === '--version'
      ? Promise.resolve({ code: 0, stdout: 'codex-cli 0.164.0-alpha.11.1\n' }) : original(command, args));
    expect(await f.update.status()).toMatchObject({ selectionMode: 'manual', selectedVersion: '0.164.0-alpha.11.1', phase: 'available' });
    await f.update.prepare();
    expect(f.getNative().successorExe).toBe(selected);
  });

  it('never applies a pending preparation after the manual exact-file selection changes', async () => {
    const f = await fixture();
    f.target.executable = f.installed;
    await f.update.prepare();
    f.target.executable = await addInstallation(f, 'same-version-new-choice.exe', '0.164.0-alpha.11.1');
    expect(await f.update.status()).toMatchObject({ phase: 'ready', selectionMode: 'manual', error: expect.stringContaining('другой файл') });
    await expect(f.update.prepare()).rejects.toMatchObject({ statusCode: 409 });
    await expect(f.update.apply()).rejects.toMatchObject({ statusCode: 409 });
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'codex-apply-update')).toBe(false);
  });

  it('clears stale selection versions and errors when the selected identity changes', async () => {
    const f = await fixture();
    await f.update.status();
    f.target.executable = path.join(f.root, 'missing.exe');
    expect(await f.update.status()).toMatchObject({ phase: 'unsupported', selectionMode: 'manual' });
    expect((await f.update.status()).selectedVersion).toBeUndefined();
    f.target.executable = f.old;
    expect(await f.update.status()).toMatchObject({ phase: 'current', selectionMode: 'manual', selectedVersion: '0.163.0-alpha.11.2' });
    expect((await f.update.status()).error).toBeUndefined();
    f.target.transport = 'managed';
    expect(await f.update.status()).toMatchObject({ available: false, phase: 'current' });
    expect((await f.update.status()).installedVersion).toBeUndefined();
  });

  it('allows executable-only selection changes on the same verified live shared server', async () => {
    const f = await fixture(), next = { ...f.target, executable: f.installed };
    expect(await f.update.canChangeSelection(next)).toBe(true);
    f.target.executable = f.installed;
    expect(await f.update.canChangeSelection({ ...f.target, executable: 'codex' })).toBe(true);
    expect(f.run.mock.calls.every(([, args]) => args[0] === 'codex-status')).toBe(true);
  });

  it('holds the selection fence through deferred persistence and releases it when persistence fails', async () => {
    const f = await fixture(), next = { ...f.target, executable: f.installed };
    let rejectSave!: (error: Error) => void;
    const save = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
    const changing = f.update.changeSelection(next, save);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await expect(f.update.prepare()).rejects.toMatchObject({ statusCode: 409 });
    await expect(f.update.apply()).rejects.toMatchObject({ statusCode: 409 });
    await expect(f.update.changeSelection(next, async () => {})).rejects.toMatchObject({ statusCode: 409 });
    rejectSave(new Error('Synthetic persistence failure.'));
    await expect(changing).rejects.toThrow('Synthetic persistence failure.');
    expect(await f.update.changeSelection(next, async () => { f.target.executable = next.executable; })).toBe(true);
    expect(await f.update.status()).toMatchObject({ selectionMode: 'manual', selectedVersion: '0.164.0-alpha.11.1' });
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'codex-update' || args[0] === 'codex-apply-update')).toBe(false);
    const ordinarySave = vi.fn(async () => {});
    expect(await f.update.changeSelection({ ...f.target, codexHome: f.data }, ordinarySave)).toBe(false);
    expect(ordinarySave).not.toHaveBeenCalled();
  });

  it.each(['platform', 'profile', 'transport', 'endpoint', 'token', 'extra-field', 'same-selection'] as const)('does not treat an ordinary %s change as a selection-only update', async kind => {
    const f = await fixture();
    const next: CodexConnectionTarget & { token?: string; other?: string } = { ...f.target, executable: f.installed };
    if (kind === 'profile') next.codexHome = f.data;
    if (kind === 'transport') next.transport = 'managed';
    if (kind === 'endpoint') next.endpoint = 'ws://127.0.0.1:3220';
    if (kind === 'token') next.token = 'synthetic';
    if (kind === 'extra-field') next.other = 'different';
    if (kind === 'same-selection') next.executable = f.target.executable;
    const service = kind === 'platform' ? new CodexUpdate(f.root, f.data, () => f.target, () => f.current, { platform: 'linux' }) : f.update;
    expect(await service.canChangeSelection(next)).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(['disconnected', 'missing-home', 'foreign-endpoint', 'foreign-owner', 'pending'] as const)('does not bypass reconnect guards for an unverified %s server', async kind => {
    const f = await fixture();
    if (kind === 'disconnected') f.current.connected = false;
    if (kind === 'missing-home') delete f.current.codexHome;
    if (kind === 'foreign-endpoint') f.current.endpoint = 'ws://127.0.0.1:3220';
    if (kind === 'foreign-owner') f.setNative({ ...f.getNative(), ownerSid: 'S-1-5-21-999' });
    if (kind === 'pending') await f.update.prepare();
    const result = f.update.canChangeSelection({ ...f.target, executable: f.installed });
    if (kind === 'disconnected' || kind === 'missing-home') expect(await result).toBe(false);
    else await expect(result).rejects.toMatchObject({ statusCode: kind === 'foreign-owner' ? 502 : 409 });
  });

  it('reports the newest installed Desktop independently of an old running backend and changes nothing during status reads', async () => {
    const f = await fixture(), before = await readFile(f.config, 'utf8');
    f.discovery.installations.push({ executable: path.join(f.root, 'cli'), source: 'path', name: 'Unrelated CLI', version: '99.0.0', running: false });
    expect(await f.update.status()).toEqual({ available: true, phase: 'available', selectionMode: 'auto', selectedVersion: '0.164.0-alpha.11.1', currentVersion: '0.163.0-alpha.11.2', installedVersion: '0.164.0-alpha.11.1' });
    expect(f.run.mock.calls.map(([, args]) => args[0])).toEqual(['codex-status']);
    expect(await readFile(f.config, 'utf8')).toBe(before);
  });

  it('skips an unsupported newer Desktop and selects the newest supported installed native', async () => {
    const f = await fixture();
    f.discovery.installations.push({ executable: path.join(f.root, 'newest-codex.exe'), source: 'desktop-install', name: 'Newest Desktop', version: '9.0.0', running: false });
    expect(await f.update.status()).toMatchObject({ available: true, phase: 'available', installedVersion: '9.0.0', selectedVersion: '0.164.0-alpha.11.1' });
    await f.update.prepare();
    expect(f.getNative().successorExe).toBe(f.installed);
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

  it.each(['platform', 'portable', 'profile', 'transport'] as const)('keeps an unavailable %s installation read-only', async kind => {
    const f = await fixture();
    let service = f.update;
    if (kind === 'platform') service = new CodexUpdate(f.root, f.data, () => f.target, () => f.current, { platform: 'darwin', discover: f.discover, run: f.run });
    if (kind === 'portable') await rm(path.join(f.root, 'rele-install.json'));
    if (kind === 'profile') { f.marker.DataDirectory = f.home; await f.save(); }
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

  it('finishes an automatic prepared successor even if a newer supported Desktop appears later', async () => {
    const f = await fixture();
    await f.update.prepare();
    const later = path.join(f.root, 'later-codex.exe');
    await writeFile(later, 'synthetic newer Desktop');
    f.discovery.installations.push({ executable: later, source: 'desktop-install', name: 'Later Desktop', version: '0.165.0-alpha.1.2', running: false });
    expect(await f.service().status()).toMatchObject({ phase: 'ready', installedVersion: '0.165.0-alpha.1.2', selectedVersion: '0.165.0-alpha.1.2', pendingVersion: '0.164.0-alpha.11.1' });
    expect((await f.service().status()).error).toBeUndefined();
    expect((await f.service().prepare()).phase).toBe('ready');
    expect(f.run.mock.calls.filter(([, args]) => args[0] === 'codex-update')).toHaveLength(1);
    f.current.connected = false;
    expect(await f.service().apply()).toMatchObject({ currentVersion: '0.164.0-alpha.11.1', selectedVersion: '0.165.0-alpha.1.2' });
    expect(f.getNative().executable).toBe(f.installed);
    expect(await f.service().status()).toMatchObject({ phase: 'available', currentVersion: '0.164.0-alpha.11.1', selectedVersion: '0.165.0-alpha.1.2' });
  });

  it('recovers the exact prepared file version when the older Desktop disappears from discovery', async () => {
    const f = await fixture(), original = f.run.getMockImplementation()!;
    await f.update.prepare();
    f.discovery.installations = f.discovery.installations.filter(item => item.executable !== f.installed);
    await addInstallation(f, 'later-supported.exe', '0.165.0-alpha.1.2', 'desktop-install');
    f.run.mockImplementation((command, args) => command === f.installed && args[0] === '--version'
      ? Promise.resolve({ code: 0, stdout: 'codex-cli 0.164.0-alpha.11.1\n' }) : original(command, args));
    expect(await f.service().status()).toMatchObject({ phase: 'ready', pendingVersion: '0.164.0-alpha.11.1', selectedVersion: '0.165.0-alpha.1.2' });
    f.current.connected = false;
    expect(await f.service().apply()).toMatchObject({ currentVersion: '0.164.0-alpha.11.1' });
    expect(f.getNative().executable).toBe(f.installed);
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
    await expect(f.update.canChangeSelection({ ...f.target, executable: f.installed })).rejects.toMatchObject({ statusCode: 409 });
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
    expect(await f.update.apply()).toEqual({ available: true, phase: 'current', selectionMode: 'auto', selectedVersion: '0.164.0-alpha.11.1', currentVersion: '0.164.0-alpha.11.1', installedVersion: '0.164.0-alpha.11.1' });
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
