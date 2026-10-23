import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DesktopIntegration } from '../src/server/desktop-integration.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture(enabled = false, requested?: boolean | null) {
  const root = await mkdtemp(path.join(tmpdir(), 'rele-desktop-'));
  directories.push(root);
  const directory = path.join(root, 'data');
  await mkdir(directory);
  await writeFile(path.join(root, 'Rele.exe'), 'synthetic launcher, never executed');
  const marker = { DataDirectory: directory, OwnerSid: 'S-1-5-21-123-456-789-1001', TaskName: 'Rele-Synthetic',
    DesktopIntegrationOwned: enabled, DesktopIntegrationRequested: requested, DesktopIntegrationWarning: 'PRIVATE_OLD_WARNING must not reach the panel' };
  const save = async () => { await writeFile(path.join(root, 'rele-install.json'), JSON.stringify(marker)); };
  await save();
  const run = vi.fn(async (_executable: string, args: string[]) => {
    marker.DesktopIntegrationOwned = args[0] === 'desktop-integrate';
    marker.DesktopIntegrationRequested = marker.DesktopIntegrationOwned;
    marker.DesktopIntegrationWarning = '';
    await save();
  });
  return { root, directory, marker, save, run, integration: new DesktopIntegration(root, directory, 'win32', run) };
}

describe('installed Desktop integration', () => {
  it('retries only a recorded pending choice, without starting the launcher during metadata reads', async () => {
    for (const requested of [undefined, null, false, true]) {
      const f = await fixture(false, requested);
      expect(await f.integration.shouldRetry()).toBe(requested === true);
      expect(await f.integration.status()).toEqual({ available: true, enabled: false, lastCheckFailed: true });
      f.marker.DesktopIntegrationOwned = true; await f.save();
      expect(await f.integration.shouldRetry()).toBe(false);
      expect(f.run).not.toHaveBeenCalled();
    }
  });

  it('reads only matching installation metadata and projects no raw warning or environment values', async () => {
    const f = await fixture();
    await writeFile(path.join(f.directory, 'config.json'), 'protected settings must not be read');
    expect(await f.integration.status()).toEqual({ available: true, enabled: false, lastCheckFailed: true });
    expect(f.run).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.integration.status())).not.toContain('PRIVATE_OLD_WARNING');
    expect(await readFile(path.join(f.directory, 'config.json'), 'utf8')).toBe('protected settings must not be read');
  });

  it('keeps portable, Linux, malformed and foreign-data installations unavailable without starting a launcher', async () => {
    const f = await fixture(false, true);
    const unavailable = { available: false, enabled: false, lastCheckFailed: false };
    expect(await new DesktopIntegration(f.root, f.directory, 'linux', f.run).status()).toEqual(unavailable);
    expect(await new DesktopIntegration(f.root, f.directory, 'linux', f.run).shouldRetry()).toBe(false);
    await mkdir(path.join(f.root, 'other'));
    f.marker.DataDirectory = path.join(f.root, 'other'); await f.save();
    expect(await f.integration.status()).toEqual(unavailable);
    expect(await f.integration.shouldRetry()).toBe(false);
    await expect(f.integration.setEnabled(true)).rejects.toThrow('этим каталогом данных');
    f.marker.DataDirectory = f.directory; f.marker.OwnerSid = 'other-user'; await f.save();
    expect(await f.integration.status()).toEqual(unavailable);
    expect(await f.integration.shouldRetry()).toBe(false);
    await writeFile(path.join(f.root, 'rele-install.json'), JSON.stringify({ ...f.marker, OwnerSid: 'S-1-5-21-123-456-789-1001', DesktopIntegrationRequested: 'true' }));
    expect(await f.integration.shouldRetry()).toBe(false);
    await writeFile(path.join(f.root, 'rele-install.json'), '{');
    expect(await f.integration.status()).toEqual(unavailable);
    expect(await f.integration.shouldRetry()).toBe(false);
    await rm(path.join(f.root, 'rele-install.json'));
    expect(await f.integration.status()).toEqual(unavailable);
    expect(await f.integration.shouldRetry()).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });

  it('delegates explicit enable/disable to the fixed launcher and requires metadata readback, preserving settings', async () => {
    const f = await fixture();
    const config = path.join(f.directory, 'config.json');
    await writeFile(config, 'protected synthetic settings');
    expect(await f.integration.setEnabled(true)).toEqual({ available: true, enabled: true, lastCheckFailed: false });
    expect(f.run).toHaveBeenLastCalledWith(path.join(f.root, 'Rele.exe'), ['desktop-integrate', '--quiet', '--data-dir', f.directory]);
    expect(await f.integration.setEnabled(false)).toEqual({ available: true, enabled: false, lastCheckFailed: false });
    expect(f.run).toHaveBeenLastCalledWith(path.join(f.root, 'Rele.exe'), ['desktop-unintegrate', '--quiet', '--data-dir', f.directory]);
    expect(await readFile(config, 'utf8')).toBe('protected synthetic settings');
  });

  it('returns a fixed failure instead of raw launcher output and never reports an unconfirmed success', async () => {
    const f = await fixture();
    f.run.mockRejectedValueOnce(new Error('PRIVATE_NATIVE_OUTPUT with auth/settings'));
    await expect(f.integration.setEnabled(true)).rejects.toThrow('Проверьте подключение Codex');
    expect(await f.integration.status()).toEqual({ available: true, enabled: false, lastCheckFailed: true });
    f.run.mockImplementationOnce(async () => {});
    await expect(f.integration.setEnabled(true)).rejects.toThrow('не подтвердила');
  });
});
