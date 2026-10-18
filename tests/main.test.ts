import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore, mergeConfig } from '../src/server/config.js';
import { Store } from '../src/server/store.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const directories: string[] = [];
const children: Array<{ child: ChildProcessWithoutNullStreams; done: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }> = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'Rele CLI test '));
  directories.push(directory);
  const config = new ConfigStore(join(directory, 'state'));
  await config.load();
  // No external server or credentials: every attempted Codex spawn fails locally.
  await config.save(mergeConfig(config.config, { codex: { executable: join(directory, 'missing-codex-executable') } }));
  return { directory, config };
}

function launch(directory: string, args: string[] = [], environment: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts', ...args], {
    cwd: project, windowsHide: true,
    env: { ...process.env, RELE_DATA_DIR: directory, RELE_PORT: '0', ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  let output = '', errors = '';
  child.stdout.setEncoding('utf8').on('data', (value: string) => { output += value; });
  child.stderr.setEncoding('utf8').on('data', (value: string) => { errors += value; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  void done.catch(() => {});
  children.push({ child, done });
  return { child, done, get output() { return output; }, get errors() { return errors; } };
}

async function result(process: ReturnType<typeof launch>) {
  let finished: Awaited<typeof process.done> | undefined;
  let failed: unknown;
  void process.done.then(value => { finished = value; }, error => { failed = error; });
  await vi.waitFor(() => {
    if (failed) throw failed;
    expect(finished, `CLI did not exit: ${process.errors}`).toBeDefined();
  }, { timeout: 15_000, interval: 25 });
  return { ...finished!, output: process.output, errors: process.errors };
}

async function ready(process: ReturnType<typeof launch>) {
  await vi.waitFor(() => {
    expect(process.child.exitCode, process.errors).toBeNull();
    expect(process.output).toMatch(/Rele: http:\/\/127\.0\.0\.1:\d+\//u);
  }, { timeout: 15_000, interval: 25 });
  return process.output.match(/Rele: (http:\/\/127\.0\.0\.1:\d+\/)/u)![1];
}

afterEach(async () => {
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.allSettled(children.splice(0).map(process => process.done));
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('CLI lifecycle and durable backup', () => {
  it('rejects a second owner of the data directory and releases its lock after a killed process', async () => {
    const { config } = await fixture();
    const first = launch(config.directory);
    const address = await ready(first);
    const second = await result(launch(config.directory));
    expect(second.code).toBe(1);
    expect(second.errors).toMatch(/уже запущен/u);
    expect(second.output).not.toContain('Rele: http');

    const token = await result(launch(config.directory, ['token']));
    expect(token.code).toBe(0);
    expect(token.output.trim()).toBe(config.panelToken);
    const state = await fetch(new URL('api/state', address), { headers: { authorization: `Bearer ${token.output.trim()}` } });
    expect(state.status).toBe(200);

    first.child.kill('SIGKILL');
    await result(first);
    const replacement = launch(config.directory);
    await ready(replacement);
    expect(replacement.child.exitCode).toBeNull();
  }, 45_000);

  it('backs up live WAL data and restores the same bindings and panel key without overwriting a backup', async () => {
    const { directory, config } = await fixture();
    const server = launch(config.directory);
    await ready(server);
    const store = new Store(join(config.directory, 'rele.sqlite'));
    let conversationId: string;
    try {
      store.upsertEndpoint({ id: 'telegram-example', platform: 'telegram', accountId: '999', chatId: '-100123', threadId: '17',
        title: 'Пример / Резервные копии', subtitle: 'Тема Telegram', people: [{ id: '123', name: 'Анна (пример)' }], updatedAt: new Date().toISOString() });
      conversationId = store.createConversation({ name: 'Пример связки', threadId: 'codex-example', cwd: directory,
        bindings: [{ platform: 'telegram', endpointId: 'telegram-example', allowedSenderIds: ['123'] }] }).id;
      store.setMeta('smoke:committed', 'saved while the server was running');
    } finally { store.close(); }

    const backup = join(directory, 'backup');
    const saved = await result(launch(config.directory, ['backup', backup]));
    expect(saved.code, saved.errors).toBe(0);
    expect(saved.output).not.toContain(config.panelToken);
    expect(JSON.parse(await readFile(join(backup, 'backup.json'), 'utf8'))).toMatchObject({ platform: process.platform });
    const repeated = await result(launch(config.directory, ['backup', backup]));
    expect(repeated.code).toBe(1);
    expect(repeated.errors).toMatch(/уже существует/u);
    server.child.kill('SIGTERM');
    await result(server);

    const restored = join(directory, 'restored');
    await mkdir(restored);
    await Promise.all(['rele.sqlite', 'config.json'].map(file => copyFile(join(backup, file), join(restored, file))));
    const restoredConfig = new ConfigStore(restored);
    await restoredConfig.load();
    expect(restoredConfig.panelToken).toBe(config.panelToken);
    const restoredStore = new Store(join(restored, 'rele.sqlite'));
    try {
      expect(restoredStore.getMeta('smoke:committed')).toBe('saved while the server was running');
      expect(restoredStore.getConversation(conversationId!)).toMatchObject({ name: 'Пример связки', bindings: [{ endpointId: 'telegram-example', allowedSenderIds: ['123'] }] });
    } finally { restoredStore.close(); }
    const restarted = launch(restored);
    const address = await ready(restarted);
    const state = await fetch(new URL('api/state', address), { headers: { authorization: `Bearer ${restoredConfig.panelToken}` } });
    expect(state.status).toBe(200);
    expect((await state.json() as { conversations: Array<{ id: string }> }).conversations[0].id).toBe(conversationId!);
  }, 60_000);

  it('exits cleanly on an invalid port and on failure after the HTTP listener has opened', async () => {
    const { config } = await fixture();
    const invalid = await result(launch(config.directory, [], { RELE_PORT: 'invalid' }));
    expect(invalid.code).toBe(1);
    expect(invalid.errors).toContain('RELE_PORT');
    // Opening a listener succeeds, but writing the instance marker then fails.
    await mkdir(join(config.directory, 'instance.json'));
    const failed = await result(launch(config.directory));
    expect(failed.code).toBe(1);
    expect(failed.output).not.toContain('Rele: http');
    await rm(join(config.directory, 'instance.json'), { recursive: true });
    await ready(launch(config.directory));
  }, 45_000);
});
