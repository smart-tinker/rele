import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRelePlugin, registerRelePlugin } from '../src/server/rele-plugin.js';

const applicationRoot = fileURLToPath(new URL('../', import.meta.url));
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function options(version = '0.1.0-rc.22') {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'rele-plugin-')); directories.push(dataDirectory);
  return { dataDirectory, applicationRoot, version, node: process.execPath, codexHome: path.join(dataDirectory, 'native-profile') };
}
function native() {
  const state = { installed: false, enabled: true, foreignPath: '', loseAck: false, hideInstalled: false };
  const rpc = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'plugin/installed') {
      const root = (params.cwds as string[])[0];
      const manifest = JSON.parse(await readFile(path.join(root, 'rele/.codex-plugin/plugin.json'), 'utf8'));
      return { marketplaces: !state.installed || state.hideInstalled ? [] : [{ name: 'rele-local', path: state.foreignPath || path.join(root, '.agents/plugins/marketplace.json'), plugins: [{ id: 'rele@rele-local', installed: true, enabled: state.enabled, localVersion: manifest.version }] }] };
    }
    if (method === 'plugin/install') { state.installed = true; if (state.loseAck) throw new Error('synthetic lost install ACK'); }
    return {};
  });
  return { state, rpc };
}

describe('owned Rele native plugin', () => {
  it('installs and reloads only its local plugin through normal native APIs, keeping credentials out of assets', async () => {
    const opts = await options();
    const { rpc } = native();
    await registerRelePlugin(rpc, opts);
    const files = await prepareRelePlugin(opts);
    expect(rpc.mock.calls.map(row => row[0])).toEqual(['plugin/installed', 'plugin/install', 'config/mcpServer/reload', 'plugin/installed']);
    expect(rpc.mock.calls[1][1]).toMatchObject({ marketplacePath: files.marketplacePath, pluginName: 'rele' });
    const mcp = JSON.parse(await readFile(path.join(files.root, 'rele/.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.rele).toEqual({ command: process.execPath, args: [path.join(applicationRoot, 'dist/server/main.js'), 'mcp', '--data-dir', opts.dataDirectory] });
    expect(mcp.mcpServers.rele).not.toHaveProperty('env');
    expect(JSON.parse(await readFile(path.join(files.root, 'rele/.codex-plugin/plugin.json'), 'utf8')).version).toBe(files.pluginVersion);
  });

  it('leaves an unchanged installation alone, but installs a new own version without deleting the old one', async () => {
    const opts = await options(); const old = await prepareRelePlugin(opts);
    const { rpc } = native(); await registerRelePlugin(rpc, opts); rpc.mockClear();
    await registerRelePlugin(rpc, opts); expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockClear();
    await registerRelePlugin(rpc, { ...opts, version: '0.1.0-rc.23' });
    expect(rpc.mock.calls.map(row => row[0])).toEqual(['plugin/installed', 'plugin/install', 'config/mcpServer/reload', 'plugin/installed']);
    expect(rpc.mock.calls[1][1]).not.toHaveProperty('config');
    expect(await readFile(old.marketplacePath, 'utf8')).toContain('rele-local');
  });

  it('preserves a disabled plugin or foreign identity collision without install/config writes', async () => {
    const opts = await options(); const { state, rpc } = native();
    state.installed = true;
    await expect(registerRelePlugin(rpc, opts)).rejects.toThrow('без собственной записи'); expect(rpc).toHaveBeenCalledTimes(1);
    state.installed = false; await registerRelePlugin(rpc, opts); rpc.mockClear(); state.enabled = false;
    await expect(registerRelePlugin(rpc, opts)).rejects.toThrow('отключён'); expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockClear(); state.enabled = true; state.foreignPath = path.join(opts.dataDirectory, 'foreign.json');
    await expect(registerRelePlugin(rpc, opts)).rejects.toThrow('чужой'); expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('refuses modified own source assets and preserves unsupported plugin settings', async () => {
    const opts = await options(); const own = await prepareRelePlugin(opts);
    const target = path.join(own.root, 'rele/.mcp.json'); await writeFile(target, 'foreign modification');
    const rpc = vi.fn(); await expect(registerRelePlugin(rpc, opts)).rejects.toThrow('перезапись'); expect(rpc).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe('foreign modification');
    const other = await options(); const unavailable = vi.fn().mockRejectedValue(new Error('plugins disabled'));
    await expect(registerRelePlugin(unavailable, other)).rejects.toThrow('plugins disabled');
    expect(unavailable).toHaveBeenCalledExactlyOnceWith('plugin/installed', { cwds: [expect.any(String)] });
    // No config.json (Rele) or config.toml (Codex) is created by registration.
    await expect(readFile(path.join(other.dataDirectory, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not blindly repeat an install after lost acknowledgement or missing readback', async () => {
    for (const kind of ['lostAck', 'missingReadback']) {
      const opts = await options(); const { state, rpc } = native();
      if (kind === 'lostAck') state.loseAck = true; else state.hideInstalled = true;
      await expect(registerRelePlugin(rpc, opts)).rejects.toThrow();
      const installs = rpc.mock.calls.filter(row => row[0] === 'plugin/install').length;
      expect(installs).toBe(1); state.loseAck = false; state.hideInstalled = false;
      await expect(registerRelePlugin(rpc, opts)).rejects.toThrow('повтор запрещён');
      expect(rpc.mock.calls.filter(row => row[0] === 'plugin/install')).toHaveLength(1);
    }
  });

  it('keeps the model silence marker aligned with the exact Engine protocol', async () => {
    const skill = await readFile(path.join(applicationRoot, 'integrations/rele/skills/rele-messages/SKILL.md'), 'utf8');
    expect(skill.match(/output exactly\s+`([^`]+)`/u)?.[1]).toBe('NOREPLY');
    expect(skill).not.toContain('NO_REPLY');
    expect(skill).toContain('does not mean\nthe repository owner');
  });
});
