import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, glob, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// A single budget avoids fs.rm's recursive retry budget multiplying at every directory level.
export async function removeInstallerFixture(directory, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await rm(directory, { recursive: true, force: true, maxRetries: 0 }); return; }
    catch (error) {
      if (['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'].includes(error.code) && Date.now() < deadline) { await delay(200); continue; }
      const code = typeof error.code === 'string' && /^[A-Z_]{1,32}$/u.test(error.code) ? error.code : 'UNKNOWN';
      const relative = typeof error.path === 'string' ? path.relative(directory, path.resolve(error.path)) : '';
      const safePath = relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && relative.length <= 240 && !/[\x00-\x1f\x7f]/u.test(relative) ? relative : undefined;
      const failure = new Error(`Installer fixture cleanup failed (${code}${safePath ? `, ${safePath}` : ''}).`);
      failure.code = code;
      if (safePath) failure.relativePath = safePath;
      throw failure;
    }
  }
}

// The close promise is attached at spawn so process exit cannot race teardown's listener.
export async function closeInstallerChild(child, closed) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  let timeout;
  try { await Promise.race([closed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The owned installer fixture process did not close.')), 5000); })]); }
  finally { clearTimeout(timeout); }
}

// Only disposable installer CI calls this; it never uses a user profile or sends a model request.
export async function installerCodex(home) {
  assert.ok(process.env.RELE_TEST_CODEX_PREFIX, 'Installer smoke requires an isolated full native Codex package.');
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const pattern = path.join(process.env.RELE_TEST_CODEX_PREFIX, 'node_modules/@openai/codex-*/vendor/*/bin', binary).replaceAll('\\', '/');
  const candidates = [];
  for await (const file of glob(pattern)) candidates.push(path.resolve(file));
  assert.equal(candidates.length, 1, 'Expected one isolated native Codex binary.');
  const executable = candidates[0];
  const metadata = JSON.parse(await readFile(path.join(path.dirname(executable), '..', 'codex-package.json'), 'utf8'));
  assert.equal(metadata.version, '0.163.0');
  assert.equal(metadata.entrypoint, `bin/${binary}`);
  const settings = path.join(home, 'app-server-daemon');
  await assert.rejects(access(settings), { code: 'ENOENT' });
  await assert.rejects(access(path.join(home, 'app-server-control', 'app-server-control.sock')), { code: 'ENOENT' });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'config.toml'), 'model = "installer-fixture"\nmodel_provider = "installer-fixture"\n[model_providers.installer-fixture]\nname = "Offline installer fixture"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n', { flag: 'wx' });
  const target = { executable, transport: 'shared', endpoint: '', codexHome: home };
  // Native stop initializes its owner-private Windows DACL without starting a backend.
  if (process.platform === 'win32') assert.equal(stopInstallerCodex(target).status, 'notRunning');
  else await mkdir(settings, { mode: 0o700 });
  // Offline fixture policy only: the separate optional updater is not stopped by daemon stop.
  await writeFile(path.join(settings, 'settings.json'), JSON.stringify({ updater: { autoUpdateEnabled: false } }), { flag: 'wx' });
  return target;
}

export async function sharedBackendPid(target, expectedPid) {
  const { CodexClient } = await import('../dist/server/codex.js');
  const deadline = Date.now() + 45_000;
  let failure = 'no-connection';
  do {
    const client = new CodexClient({ ...target, transport: 'proxy', endpoint: path.join(target.codexHome, 'app-server-control', 'app-server-control.sock') });
    try {
      await client.connect();
      const pid = (await client.diagnostics()).process.id;
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      process.kill(pid, 0);
      if (expectedPid) assert.equal(pid, expectedPid, 'Rele lifecycle must preserve the native shared backend PID.');
      return pid;
    } catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error;
      failure = typeof error.code === 'string' ? error.code : error.name;
    } finally { await client.close(); }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`The installer did not establish the native shared Codex backend (${failure}).`);
}

export function stopInstallerCodex(target) {
  if (!target) return;
  const env = { ...process.env, CODEX_HOME: target.codexHome };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[key];
  const result = spawnSync(target.executable, ['app-server', 'daemon', 'stop'], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, 'The isolated fixture daemon must stop before its profile is removed.');
  const output = JSON.parse(result.stdout);
  assert.ok(['stopped', 'notRunning'].includes(output.status));
  return output;
}

// Keep the installed immutable adapter open as Desktop would, including its executable/file locks.
export async function openInstallerAdapter(executable, env, args = ['app-server', '--listen', 'stdio://']) {
  const child = spawn(executable, args, { env, cwd: path.dirname(executable), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.resume();
  const pending = new Map();
  let nextId = 0;
  const closed = once(child, 'exit');
  void closed.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  const fail = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('The held installer adapter disconnected.')); } pending.clear(); };
  child.on('error', fail); child.on('exit', fail);
  lines.on('line', line => {
    try {
      const message = JSON.parse(line), request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error('The held installer adapter returned an RPC error.')); else request.resolve(message.result);
    } catch { fail(); }
  });
  const call = (method, params = method === 'configRequirements/read' ? undefined : {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The held installer adapter RPC timed out.')); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const close = async () => {
    child.stdin.end();
    let timeout;
    try { await Promise.race([closed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The held adapter did not close after EOF.')), 15_000); })]); }
    finally { clearTimeout(timeout); lines.close(); if (child.exitCode === null && child.signalCode === null) child.kill(); fail(); }
  };
  try {
    await call('initialize', { clientInfo: { name: 'rele_installer_desktop', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    return { child, call, close };
  } catch (error) { await close(); throw error; }
}
