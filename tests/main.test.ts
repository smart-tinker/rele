import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore, mergeConfig } from '../src/server/config.js';
import { Store } from '../src/server/store.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const directories: string[] = [];
const healthServers: ReturnType<typeof createServer>[] = [];
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
  for (const server of healthServers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('CLI lifecycle and durable backup', () => {
  it('opens a running instance with a single-use link and stops it without losing data', async () => {
    const { config } = await fixture();
    expect((await result(launch(config.directory, ['stop']))).code).toBe(0);
    const server = launch(config.directory);
    const address = await ready(server);
    const status = await result(launch(config.directory, ['status', '--wait']));
    expect(status.code, status.errors).toBe(0);
    expect(JSON.parse(status.output)).toMatchObject({ running: true, pid: server.child.pid, address: new URL(address).origin });
    expect(status.output).not.toContain(config.panelToken);
    const opened = await result(launch(config.directory, ['open', '--print-url']));
    expect(opened.code, opened.errors).toBe(0);
    expect(opened.output).not.toContain(config.panelToken);
    const link = new URL(opened.output.trim());
    expect(link.origin).toBe(new URL(address).origin);
    const token = new URLSearchParams(link.hash.slice(1)).get('rele-launch');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const exchange = () => fetch(new URL('/api/session/launch', address), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    });
    const login = await exchange();
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ key: config.panelToken });
    expect((await exchange()).status).toBe(401);
    const stopped = await result(launch(config.directory, ['stop']));
    expect(stopped.code, stopped.errors).toBe(0);
    expect((await result(server)).code).toBe(0);
    expect((await result(launch(config.directory, ['stop']))).code).toBe(0);
    expect((await result(launch(config.directory, ['status']))).code).toBe(1);
    const saved = new ConfigStore(config.directory);
    await saved.load();
    expect(saved.panelToken).toBe(config.panelToken);
    expect(await readFile(join(config.directory, 'rele.sqlite'))).not.toHaveLength(0);
    await ready(launch(config.directory));
  }, 60_000);

  it('rejects a non-local instance address before sending a panel key or stopping anything', async () => {
    const { config } = await fixture();
    await writeFile(join(config.directory, 'instance.json'), JSON.stringify({ pid: process.pid, address: 'https://example.com', version: 'test' }));
    for (const command of ['open', 'stop']) {
      const attempted = await result(launch(config.directory, [command, '--print-url']));
      expect(attempted.code).toBe(1);
      expect(attempted.errors).toMatch(/Некорректный локальный адрес/u);
      expect(attempted.errors + attempted.output).not.toContain(config.panelToken);
    }
  }, 30_000);

  it('refuses to stop a live instance whose PID does not match its authenticated identity', async () => {
    const { config } = await fixture();
    const server = launch(config.directory);
    const address = await ready(server);
    const file = join(config.directory, 'instance.json');
    const marker = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...marker, pid: process.pid }));
    const attempted = await result(launch(config.directory, ['stop']));
    expect(attempted.code).toBe(1);
    expect(attempted.errors).toMatch(/не совпадает/u);
    expect((await fetch(new URL('/api/health', address))).status).toBe(200);
    await writeFile(file, JSON.stringify(marker));
  }, 30_000);

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


describe('restricted CLI diagnostics', () => {
  async function directory() {
    const value = await mkdtemp(join(tmpdir(), 'Rele diagnostics test '));
    directories.push(value);
    return value;
  }
  async function healthFixture(options: { status?: number; body?: string; location?: string; silent?: boolean } = {}) {
    const root = await directory();
    const version = (JSON.parse(await readFile(join(project, 'package.json'), 'utf8')) as { version: string }).version;
    const requests: Array<{ method?: string; url?: string; authorization?: string; cookie?: string }> = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie });
      if (options.silent) return;
      response.writeHead(options.status ?? 200, options.location ? { location: options.location } : {});
      response.end(options.body ?? JSON.stringify({ ok: true, version, extra: 'PRIVATE_HEALTH_BODY' }));
    });
    healthServers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const marker = { pid: process.pid, address, version, privatePath: root, secret: 'PRIVATE_MARKER_SECRET' };
    await writeFile(join(root, 'instance.json'), JSON.stringify(marker));
    return { root, version, server, address, marker, requests, run: () => result(launch(root, ['diagnostics'])) };
  }

  it('reports an absent marker without creating a missing data directory or configuration', async () => {
    const root = await directory(); const missing = join(root, 'nonexistent');
    const report = await result(launch(missing, ['diagnostics']));
    expect(report.code, report.errors).toBe(0);
    expect(JSON.parse(report.output)).toEqual({ version: expect.any(String), platform: process.platform, arch: process.arch,
      node: process.version, instance: { marker: 'absent', health: 'not-checked' }, desktopVerified: false });
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(report.output + report.errors).not.toContain(missing);
  });

  it('reads only the marker and unauthenticated public health, preserving config and database bytes and timestamps', async () => {
    const f = await healthFixture();
    const config = join(f.root, 'config.json'); const database = join(f.root, 'rele.sqlite');
    await writeFile(config, 'MALFORMED_CONFIG_MUST_NOT_BE_READ_OR_DECRYPTED');
    await writeFile(database, 'PRIVATE_DATABASE_MUST_NOT_BE_OPENED');
    const files = [config, database, join(f.root, 'instance.json')];
    const before = await Promise.all(files.map(async file => ({ bytes: await readFile(file), modified: (await stat(file)).mtimeMs })));
    const report = await f.run();
    expect(report.code, report.errors).toBe(0);
    expect(JSON.parse(report.output)).toEqual({ version: f.version, platform: process.platform, arch: process.arch, node: process.version,
      instance: { marker: 'valid', pid: process.pid, processAlive: true, health: 'responding', httpStatus: 200, versionMatch: true }, desktopVerified: false });
    expect(f.requests).toEqual([{ method: 'GET', url: '/api/health', authorization: undefined, cookie: undefined }]);
    const after = await Promise.all(files.map(async file => ({ bytes: await readFile(file), modified: (await stat(file)).mtimeMs })));
    expect(after).toEqual(before);
    expect(report.output + report.errors).not.toMatch(/PRIVATE_|MALFORMED_|dataDirectory|codexTransport|telegramEnabled|slackEnabled|voiceEnabled/u);
    expect(report.output + report.errors).not.toContain(f.root);
    expect(report.output + report.errors).not.toContain(f.address);
  });

  it.each(['https://example.invalid', 'http://localhost', 'http://user:secret@127.0.0.1:3210',
    'http://127.0.0.1:3210/redirect', 'http://127.0.0.1:3210/?token=secret', 'http://127.0.0.1:3210/#secret'])('rejects an invalid marker URL before fetching (%s)', async address => {
    const f = await healthFixture();
    await writeFile(join(f.root, 'instance.json'), JSON.stringify({ ...f.marker, address }));
    const report = await f.run();
    expect(report.code, report.errors).toBe(0);
    expect(JSON.parse(report.output).instance).toEqual({ marker: 'invalid', health: 'not-checked' });
    expect(f.requests).toEqual([]);
    expect(report.output + report.errors).not.toContain(address);
  });

  it('rejects a PID outside the supported process range before checking health', async () => {
    const f = await healthFixture();
    await writeFile(join(f.root, 'instance.json'), JSON.stringify({ ...f.marker, pid: Number.MAX_SAFE_INTEGER }));
    const report = await f.run();
    expect(JSON.parse(report.output).instance).toEqual({ marker: 'invalid', health: 'not-checked' });
    expect(f.requests).toEqual([]);
  });

  it.each(['malformed', 'invalid-pid', 'unreadable'])('classifies a %s marker without raw fields or errors', async kind => {
    const root = await directory(); const file = join(root, 'instance.json');
    if (kind === 'unreadable') await mkdir(file);
    else await writeFile(file, kind === 'malformed' ? 'PRIVATE_INVALID_JSON' : JSON.stringify({ pid: 0, address: 'http://127.0.0.1:3210', version: 'PRIVATE_VERSION' }));
    const report = await result(launch(root, ['diagnostics']));
    expect(report.code, report.errors).toBe(0);
    expect(JSON.parse(report.output).instance).toEqual({ marker: kind === 'unreadable' ? 'unreadable' : 'invalid', health: 'not-checked' });
    expect(report.output + report.errors).not.toMatch(/PRIVATE_|instance.json|EISDIR|EPERM/u);
    expect(report.output + report.errors).not.toContain(root);
    await expect(stat(join(root, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([JSON.stringify({ ok: true, version: 'PRIVATE_WRONG_VERSION' }), JSON.stringify({ ok: false }), 'PRIVATE_NON_JSON'])('reports a mismatched health response without exposing its body (%s)', async body => {
    const f = await healthFixture({ body }); const report = await f.run();
    expect(JSON.parse(report.output).instance).toMatchObject({ marker: 'valid', health: 'mismatch', httpStatus: 200, versionMatch: false });
    expect(report.output + report.errors).not.toContain('PRIVATE_');
  });

  it('compares the marker version as well as the health version', async () => {
    const f = await healthFixture();
    await writeFile(join(f.root, 'instance.json'), JSON.stringify({ ...f.marker, version: 'PRIVATE_STALE_MARKER_VERSION' }));
    const report = await f.run();
    expect(JSON.parse(report.output).instance).toMatchObject({ health: 'mismatch', versionMatch: false });
    expect(report.output + report.errors).not.toContain('PRIVATE_');
  });

  it('does not follow a health redirect or send credentials to its destination', async () => {
    const target = await healthFixture(); const f = await healthFixture({ status: 302, location: `${target.address}/private-target` });
    const report = await f.run();
    expect(JSON.parse(report.output).instance).toEqual({ marker: 'valid', pid: process.pid, processAlive: true, health: 'unavailable' });
    expect(f.requests).toEqual([{ method: 'GET', url: '/api/health', authorization: undefined, cookie: undefined }]);
    expect(target.requests).toEqual([]);
    expect(report.output + report.errors).not.toContain(target.address);
  });

  it('reports a fixed unavailable category for non-success HTTP status or an offline listener', async () => {
    const f = await healthFixture({ status: 503, body: 'PRIVATE_SERVER_ERROR' });
    expect(JSON.parse((await f.run()).output).instance).toMatchObject({ health: 'unavailable', httpStatus: 503 });
    f.server.closeAllConnections(); await new Promise<void>(resolve => f.server.close(() => resolve()));
    healthServers.splice(healthServers.indexOf(f.server), 1);
    const report = await f.run();
    expect(JSON.parse(report.output).instance).toEqual({ marker: 'valid', pid: process.pid, processAlive: true, health: 'unavailable' });
    expect(report.output + report.errors).not.toMatch(/PRIVATE_|ECONNREFUSED/u);
  });

  it('bounds a stalled health request without falling back to another API', async () => {
    const f = await healthFixture({ silent: true }); const report = await f.run();
    expect(report.code, report.errors).toBe(0);
    expect(JSON.parse(report.output).instance).toEqual({ marker: 'valid', pid: process.pid, processAlive: true, health: 'unavailable' });
    expect(f.requests.map(request => request.url)).toEqual(['/api/health']);
    expect(report.output + report.errors).not.toMatch(/Timeout|Abort|config.json/u);
  });
});
