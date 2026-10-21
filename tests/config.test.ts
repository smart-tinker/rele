import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as childProcess from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigStore,
  defaultConfig,
  isLocalCodexHome,
  isLocalEndpoint,
  isLocalSocketPath,
  mergeConfig,
  publicConfig,
} from '../src/server/config.js';

const syntheticSecrets = {
  codex: 'synthetic-codex-secret',
  telegram: '123456:synthetic_telegram_secret_123456',
  slackBot: 'SLACK_TOKEN_PLACEHOLDER_6819402',
  slackApp: 'SLACK_TOKEN_PLACEHOLDER_3378106',
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'rele-config-test-'));
  directories.push(value);
  return value;
}
function configured() {
  return mergeConfig(defaultConfig, {
    codex: { token: syntheticSecrets.codex },
    telegram: { enabled: true, token: syntheticSecrets.telegram },
    slack: {
      enabled: true,
      botToken: syntheticSecrets.slackBot,
      appToken: syntheticSecrets.slackApp,
    },
  });
}

describe('configuration validation and public projection', () => {
  it('defaults to the shared native server while inheriting the Codex home', () => {
    expect(defaultConfig.codex).toEqual({ transport: 'shared', executable: 'codex', endpoint: '' });
    const selected = mergeConfig(defaultConfig, { codex: { codexHome: resolve('synthetic-codex-home') } });
    expect(publicConfig(selected).codex.codexHome).toBe(resolve('synthetic-codex-home'));
    expect(mergeConfig(selected, { codex: { codexHome: '' } }).codex).not.toHaveProperty('codexHome');
    expect(mergeConfig(selected, { codex: { codexHome: undefined } }).codex).not.toHaveProperty('codexHome');
    expect(defaultConfig.codex).not.toHaveProperty('codexHome');
  });

  it.each(['shared', 'managed'] as const)('clears the old address only when explicitly switching to %s', transport => {
    const current = mergeConfig(defaultConfig, { codex: { transport: 'websocket', endpoint: 'ws://127.0.0.1:4500', codexHome: resolve('native-home') } });
    expect(mergeConfig(current, { codex: { transport } }).codex).toMatchObject({ transport, endpoint: '', codexHome: current.codex.codexHome });
    expect(mergeConfig(current, { telegram: { enabled: false } }).codex).toEqual(current.codex);
    expect(() => mergeConfig(defaultConfig, { codex: { endpoint: 'ws://127.0.0.1:4500' } })).toThrow('endpoint');
    expect(() => mergeConfig(current, { codex: { transport, endpoint: 'ws://127.0.0.1:4501' } })).toThrow('endpoint');
  });

  it('accepts only an absolute local Codex home for the native platform', () => {
    expect(isLocalCodexHome('C:\\Users\\Example User\\.codex', 'win32')).toBe(true);
    expect(isLocalCodexHome('C:/Users/Example User/.codex', 'win32')).toBe(true);
    expect(isLocalCodexHome('/home/example/.codex', 'linux')).toBe(true);
    for (const home of ['relative', 'C:relative', '\\\\server\\share', '//server/share', '\\\\.\\pipe\\codex', '/home/example/\n.codex', '/home/example/\t.codex', '/home/example/\x7f.codex']) {
      expect(isLocalCodexHome(home, 'linux')).toBe(false);
      expect(isLocalCodexHome(home, 'win32')).toBe(false);
      expect(() => mergeConfig(defaultConfig, { codex: { codexHome: home } })).toThrow();
    }
    expect(isLocalCodexHome('/home/example/.codex', 'win32')).toBe(false);
    expect(isLocalCodexHome('C:\\Users\\Example\\.codex', 'linux')).toBe(false);
    expect(() => mergeConfig(defaultConfig, { codex: { codexHome: null } })).toThrow('codexHome');
  });

  it('clears the previous hidden WebSocket address when switching back to automatic proxy', () => {
    const websocket = mergeConfig(defaultConfig, { codex: { transport: 'websocket', endpoint: 'ws://127.0.0.1:4500' } });
    const proxy = mergeConfig(websocket, { codex: { transport: 'proxy', executable: 'codex', endpoint: websocket.codex.endpoint } });
    expect(proxy.codex).toMatchObject({ transport: 'proxy', executable: 'codex', endpoint: '' });
    expect(websocket.codex.endpoint).toBe('ws://127.0.0.1:4500');
  });

  it('preserves an explicit local control socket and refuses URLs or network paths in proxy mode', () => {
    for (const endpoint of ['/home/example/.codex/control.sock', 'C:\\Example User\\.codex\\control.sock', '\\\\.\\pipe\\codex-control']) {
      expect(isLocalSocketPath(endpoint)).toBe(true);
      expect(mergeConfig(defaultConfig, { codex: { transport: 'proxy', executable: 'custom-cli', endpoint } }).codex).toMatchObject({ transport: 'proxy', executable: 'custom-cli', endpoint });
    }
    for (const endpoint of ['ws://127.0.0.1:4500', 'relative.sock', '\\\\remote-server\\share\\control.sock', '//remote-server/share/control.sock']) {
      expect(isLocalSocketPath(endpoint)).toBe(false);
      expect(() => mergeConfig(defaultConfig, { codex: { transport: 'proxy', endpoint } })).toThrow('сокету');
    }
  });

  it('preserves existing secrets for empty fields, replaces explicit values and never mutates defaults', () => {
    const current = configured();
    const next = mergeConfig(current, {
      codex: { token: '' },
      telegram: { token: '  ', enabled: false },
      slack: { botToken: '', appToken: '' },
    });
    expect(next.codex.token).toBe(syntheticSecrets.codex);
    expect(next.telegram.token).toBe(syntheticSecrets.telegram);
    expect(next.telegram.enabled).toBe(false);
    expect(current.telegram.enabled).toBe(true);
    expect(defaultConfig.telegram).toEqual({ enabled: false });
    const replaced = mergeConfig(next, {
      telegram: { token: '987654:another_synthetic_secret_123456' },
    });
    expect(replaced.telegram.token).toBe(
      '987654:another_synthetic_secret_123456',
    );
  });

  it('returns only secret-presence flags to the panel', () => {
    const value = publicConfig(configured());
    const serialized = JSON.stringify(value);
    for (const secret of Object.values(syntheticSecrets))
      expect(serialized).not.toContain(secret);
    expect(value.codex).not.toHaveProperty('token');
    expect(value.telegram).toEqual({ enabled: true, tokenConfigured: true });
    expect(value.slack).toEqual({
      enabled: true,
      botTokenConfigured: true,
      appTokenConfigured: true,
    });
  });

  it.each([
    { arbitrary: true },
    { telegram: { enabled: 'true' } },
    { telegram: { enabled: true } },
    { slack: { enabled: true, botToken: 'xoxb-test' } },
    { codex: { transport: 'stdio' } },
    { codex: { executable: 'codex\nextra' } },
    {
      codex: {
        transport: 'websocket',
        endpoint: 'wss://example.invalid/codex',
      },
    },
    {
      codex: {
        transport: 'websocket',
        endpoint: 'ws://localhost:4500/?token=secret',
      },
    },
    { voice: { enabled: true, model: 'small' } },
    { voice: { device: 'auto' } },
    { voice: { language: 'russian' } },
    { voice: { shell: 'unexpected' } },
  ])('rejects unsupported or incomplete settings: %j', (patch) => {
    expect(() => mergeConfig(defaultConfig, patch)).toThrow();
  });

  it('accepts a local model directory without requiring any network download', () => {
    const model = resolve('synthetic-local-model');
    const value = mergeConfig(defaultConfig, {
      voice: {
        enabled: true,
        python: 'python',
        model,
        language: '',
        device: 'cpu',
      },
    });
    expect(value.voice).toMatchObject({ model, language: '', enabled: true });
  });

  it.each([
    'ws://127.0.0.1:4500',
    'wss://localhost:4500/codex',
    'ws://[::1]:4500',
  ])('accepts a loopback app-server endpoint: %s', (endpoint) => {
    expect(isLocalEndpoint(endpoint)).toBe(true);
  });

  it.each([
    'https://127.0.0.1:4500',
    'ws://localhost.evil.invalid',
    'ws://user:secret@localhost:4500',
    'ws://127.0.0.1:4500#token',
    'ws://127.0.0.1:4500?token=secret',
    'not-a-url',
  ])('rejects an endpoint outside the local contract: %s', (endpoint) => {
    expect(isLocalEndpoint(endpoint)).toBe(false);
  });
});

describe('configuration storage and panel credentials', () => {
  it.each([
    { transport: 'proxy', endpoint: '', restored: '' },
    { transport: 'proxy', endpoint: 'ws://127.0.0.1:4500', restored: '' },
    { transport: 'proxy', endpoint: 'wss://localhost:4500', restored: '' },
    { transport: 'proxy', endpoint: 'C:\\Example User\\control.sock', restored: 'C:\\Example User\\control.sock' },
    { transport: 'websocket', endpoint: 'ws://127.0.0.1:4500', restored: 'ws://127.0.0.1:4500' },
  ] as const)('loads an rc.2 configuration while preserving valid connection targets: $transport $endpoint', async example => {
    const root = await directory();
    const first = new ConfigStore(root);
    first.panelToken = 'f'.repeat(64);
    const value = configured();
    value.codex = { ...value.codex, executable: 'custom-cli', transport: example.transport, endpoint: example.endpoint, codexHome: resolve('selected-native-profile') };
    await first.save(value);
    const original = await readFile(join(root, 'config.json'), 'utf8');
    const restored = new ConfigStore(root);
    await restored.load();
    expect(restored.config.codex).toMatchObject({ executable: 'custom-cli', transport: example.transport, endpoint: example.restored, codexHome: value.codex.codexHome, token: syntheticSecrets.codex });
    expect(restored.panelToken).toBe(first.panelToken);
    expect(await readFile(join(root, 'config.json'), 'utf8')).toBe(original);
  }, 15_000);

  it('shares one complete configuration when several instances initialize the same directory at once', async () => {
    const root = await directory();
    const stores = Array.from({ length: 4 }, () => new ConfigStore(root));
    await Promise.all(stores.map((store) => store.load()));
    expect(new Set(stores.map((store) => store.panelToken)).size).toBe(1);
    expect(stores[0].panelToken).toMatch(/^[a-f0-9]{64}$/);
    const restored = new ConfigStore(root);
    await restored.load();
    expect(restored.panelToken).toBe(stores[0].panelToken);
    expect(restored.config).toEqual(defaultConfig);
    expect(await readdir(root)).toEqual(['config.json']);
  });

  it('retains the panel token and settings after reload, with no abandoned temporary file', async () => {
    const root = await directory();
    const first = new ConfigStore(root);
    await first.load();
    expect(first.panelToken).toMatch(/^[a-f0-9]{64}$/);
    await first.save(configured());
    const second = new ConfigStore(root);
    await second.load();
    expect(second.panelToken).toBe(first.panelToken);
    expect(second.config).toEqual(first.config);
    expect(await readdir(root)).toEqual(['config.json']);
    if (process.platform !== 'win32') {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, 'config.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('requires the exact bearer value and redacts configured secrets from errors', () => {
    const store = new ConfigStore('unused');
    store.panelToken = 'a'.repeat(64);
    store.config = configured();
    expect(store.authorized(`Bearer ${store.panelToken}`)).toBe(true);
    for (const header of [
      undefined,
      store.panelToken,
      `Basic ${store.panelToken}`,
      `Bearer ${'b'.repeat(64)}`,
      `Bearer ${store.panelToken}x`,
    ])
      expect(store.authorized(header)).toBe(false);
    const message = store.redact(
      new Error(
        [store.panelToken, ...Object.values(syntheticSecrets)].join(' / '),
      ),
    );
    expect(message).toBe(Array(5).fill('[скрыто]').join(' / '));
  });

  it('refuses a corrupted file without overwriting the original settings', async () => {
    const root = await directory();
    const file = join(root, 'config.json');
    const original = '{ invalid synthetic configuration';
    await writeFile(file, original);
    await expect(new ConfigStore(root).load()).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it.runIf(process.platform === 'win32')(
    'round-trips Windows DPAPI without module autoload or plaintext secrets',
    async () => {
      const nativeSpawn = childProcess.spawn;
      const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation(((command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
        return nativeSpawn(command, [...args.slice(0, -1), `$ErrorActionPreference='Stop'; $PSModuleAutoLoadingPreference='None'; ${args.at(-1)}`], options);
      }) as typeof childProcess.spawn);
      try {
        const root = await directory();
        const first = new ConfigStore(root);
        await first.load();
        await first.save(configured());
        const raw = await readFile(join(root, 'config.json'), 'utf8');
        expect(JSON.parse(raw).encoding).toBe('dpapi');
        for (const secret of [
          first.panelToken,
          ...Object.values(syntheticSecrets),
        ])
          expect(raw).not.toContain(secret);
        const restored = new ConfigStore(root);
        await restored.load();
        expect(restored.config).toEqual(first.config);
        expect(restored.authorized(`Bearer ${first.panelToken}`)).toBe(true);
      } finally {
        spawn.mockRestore();
      }
    },
  );
});
