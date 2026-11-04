import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinuxCodexUpdate, type LinuxCodexUpdateOptions } from '../src/server/codex-linux-update.js';
import type { CodexConnectionState, CodexConnectionTarget } from '../src/shared/types.js';

const directories: string[] = [], servers = new Map<WebSocketServer, Server>();
const version = '0.166.0-alpha.5.1', id = '01a1559e-da99-7460-9fb7-103637d52982';
afterEach(async () => {
  for (const [server, transport] of [...servers]) { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve => transport.close(() => resolve())); servers.delete(server); }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const hash = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');

async function packageFixture(root: string, text: string, packageVersion = version) {
  for (const file of ['bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg', 'codex-resources/bwrap']) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text, { mode: 0o755 });
  }
  await writeFile(path.join(root, 'codex-package.json'), JSON.stringify({ layoutVersion: 1, version: packageVersion, target: `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-unknown-linux-musl`, entrypoint: 'bin/codex' }));
  return path.join(root, 'bin/codex');
}
async function fixture(externalStarter = false, candidateVersion = version) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rlu-'))); directories.push(directory);
  const home = path.join(directory, 'c'), data = path.join(directory, 'd'), endpoint = path.join(home, 'app-server-control/app-server-control.sock');
  await mkdir(path.dirname(endpoint), { recursive: true }); await mkdir(data); await mkdir(path.join(home, 'app-server-daemon'));
  const releaseRoot = path.join(home, 'packages/app-server-daemon/releases'), oldRoot = path.join(releaseRoot, 'old');
  const old = await packageFixture(oldRoot, 'old-native'), selectedRoot = path.join(directory, 'selected'), selected = await packageFixture(selectedRoot, 'selected-native', candidateVersion);
  const alias = path.join(home, 'packages/app-server-daemon/current'); await symlink(oldRoot, alias);
  const managed = path.join(alias, 'bin/codex'), pidFile = path.join(home, 'app-server-daemon/daemon.pid');
  const state = { pid: 20001, start: '100', executable: old, oldAlive: true, newAlive: false, cgroup: externalStarter ? '0::/system.slice/rele-codex.service' : '0::/user.slice/session.scope', ephemeral: false, status: { type: 'idle', activeFlags: [] as string[] }, queue: [] as object[], terminals: [] as object[], requests: [] as object[], peers: 0, losesStartAck: false, startEffect: true, losesSelectionAck: false,
    gauges: [{ name: 'app.requests.in_flight', value: 1 }, { name: 'app.requests.queued', value: 0 }, { name: 'core.threads.live', value: 1 }, { name: 'core.turns.active', value: 0 }] };
  const record = async () => writeFile(pidFile, JSON.stringify({ pid: state.pid, processStartTime: 'fixture-stamp' }), { mode: 0o600 }); await record();
  let server: WebSocketServer, transport: Server;
  const listen = async () => {
    transport = createServer(); server = new WebSocketServer({ server: transport }); servers.set(server, transport); server.once('close', () => servers.delete(server));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); transport.once('error', reject); transport.once('listening', resolve); transport.listen(endpoint); });
    server.on('connection', client => client.on('message', raw => {
      const message = JSON.parse(String(raw)); if (!message.id) return;
      let result: unknown;
      if (message.method === 'initialize') result = { userAgent: `fixture/${version} (Linux)`, codexHome: home, platformFamily: 'unix' };
      else if (message.method === 'server/diagnostics') result = { process: { id: state.pid }, gauges: state.gauges };
      else if (message.method === 'thread/loaded/list') result = { data: [id], nextCursor: null };
      else if (message.method === 'thread/read') result = { thread: { id, ephemeral: state.ephemeral, status: state.status, requests: state.requests } };
      else if (message.method === 'thread/queue/list') { if (state.ephemeral) { client.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'ephemeral' } })); return; } result = { data: state.queue, nextCursor: null }; }
      else if (message.method === 'thread/backgroundTerminals/list') result = { data: state.terminals, nextCursor: null };
      else if (message.method === 'thread/list') result = { data: message.params.archived ? [] : [{ id }], nextCursor: null };
      client.send(JSON.stringify({ id: message.id, result }));
    }));
  };
  await listen();
  const calls: string[][] = [];
  const run: NonNullable<LinuxCodexUpdateOptions['run']> = vi.fn(async (command, args, env) => {
    expect(env.CODEX_HOME).toBe(home); calls.push([command, ...args]);
    if (args[0] === '--version') return { code: 0, stdout: `codex-cli ${candidateVersion}` };
    if (command === '/usr/bin/ps') return { code: 0, stdout: 'fixture-stamp\n' };
    if (args.includes('--check')) return { code: 0, stdout: '{"supported":true}' };
    if (args.includes('--peers')) return { code: 0, stdout: JSON.stringify({ listener: true, peers: state.peers }) };
    if (args.includes('--signal')) {
      state.oldAlive = false; for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve => transport.close(() => resolve())); await unlink(endpoint).catch(() => {});
      return { code: 0, stdout: '{"status":"signalSent"}' };
    }
    if (args[2] === 'version') return { code: 0, stdout: JSON.stringify({ status: 'running', backend: 'pid', socketPath: endpoint, appServerVersion: version, managedCodexVersion: version, managedCodexPath: managed }) };
    if (args[2] === 'update') {
      const nextRoot = path.join(releaseRoot, 'new'); await cp(selectedRoot, nextRoot, { recursive: true }); await unlink(alias); await symlink(nextRoot, alias);
      if (state.losesSelectionAck) throw new Error('lost package ACK');
      return { code: 0, stdout: JSON.stringify({ status: 'updated', installedVersion: version, runningVersion: null, managedCodexPath: managed }) };
    }
    if (args[2] === 'start') {
      if (externalStarter) expect(env.RELE_CODEX_DAEMON_EXTERNAL).not.toBe('1');
      if (state.startEffect) { state.pid = 20002; state.start = '200'; state.executable = await realpath(managed); state.newAlive = true; await record(); await listen(); }
      if (state.losesStartAck) throw new Error('lost start ACK');
      return { code: 0, stdout: JSON.stringify({ status: 'started', socketPath: endpoint, managedCodexVersion: version, appServerVersion: version, managedCodexPath: managed }) };
    }
    throw new Error('Unexpected command');
  });
  const readProcess: NonNullable<LinuxCodexUpdateOptions['readProcess']> = async pid => {
    if (pid === 20001 && !state.oldAlive || pid === 20002 && !state.newAlive) return;
    return { pid, startTicks: pid === 20001 ? '100' : '200', uid: process.getuid!(), executable: state.executable, sha256: await hash(state.executable), cgroup: state.cgroup };
  };
  const target: CodexConnectionTarget = { transport: 'shared', executable: 'codex', endpoint: '', codexHome: home };
  const current: CodexConnectionState = { configured: true, connected: true, name: `Codex ${version}`, queueSupported: true, desktopVerified: false, executable: old, transport: 'proxy', endpoint, codexHome: home };
  const candidate = { executable: selected, version: candidateVersion, sha256: await hash(selected) };
  const pending = async () => JSON.parse(await readFile(path.join(data, 'codex-linux-update.json'), 'utf8')).pending;
  const starter = new LinuxCodexUpdate(data, { run, readProcess });
  const service = new LinuxCodexUpdate(data, { run, readProcess, ...(externalStarter ? { env: { RELE_CODEX_DAEMON_EXTERNAL: '1' } } : {}), wait: async () => { if (externalStarter && (await pending()).startAttempted) await starter.startPrepared(target); } });
  return { service, starter, target, current, candidate, state, calls, pending, data, run };
}

describe.skipIf(process.platform !== 'linux')('Linux native controlled update', () => {
  it('prepares without stopping work, then selects through native and verifies the original home/catalog after client close', async () => {
    const f = await fixture();
    expect((await f.service.prepare(f.target, f.current, f.candidate)).pending?.phase).toBe('ready');
    expect(f.calls.some(call => call.includes('--signal'))).toBe(false);
    const result = await f.service.apply(f.target, { configured: true, connected: false, queueSupported: false, desktopVerified: false });
    expect(result).toMatchObject({ version, pid: 20002, codexHome: f.current.codexHome, endpoint: f.current.endpoint, cleanup: 'native-managed' });
    expect((await f.pending()).phase).toBe('verified');
    expect(f.calls.filter(call => call.includes('--signal'))).toHaveLength(1);
    expect(f.calls.filter(call => call[3] === 'update')).toHaveLength(1);
    expect(f.calls.some(call => call.some(value => ['stop', 'restart', 'SIGTERM', 'SIGKILL'].includes(value)))).toBe(false);
  });
  it.each([
    ['0.166.0-alpha.6', 'linux-graceful-unsupported'],
    ['0.166.0-alpha.6.1', 'linux-owner-unconfirmed'],
  ])('refuses unverified graceful candidate %s before persisting or changing native state', async (candidateVersion, code) => {
    const f = await fixture(false, candidateVersion);
    await expect(f.service.prepare(f.target, f.current, f.candidate)).rejects.toMatchObject({ code });
    await expect(readFile(path.join(f.data, 'codex-linux-update.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls.some(call => call.includes('--signal') || ['update', 'start'].includes(call[3]))).toBe(false);
    expect(f.calls.some(call => call[1] === '--version')).toBe(false);
    expect(f.state.oldAlive).toBe(true);
    expect(f.state.newAlive).toBe(false);
  });
  it('explains external service ownership and does not prepare or signal it', async () => {
    const f = await fixture(); f.state.cgroup = '0::/user.slice/app.slice/codex-app-server.service';
    expect(await f.service.inspect(f.target, f.current)).toMatchObject({ available: false, reasonCode: 'linux-owner-external' });
    await expect(f.service.prepare(f.target, f.current, f.candidate)).rejects.toThrow(/внешней службой/u);
    expect(f.calls.some(call => call.includes('--signal'))).toBe(false);
  });
  it('starts the successor only through the independent existing sidecar and never dispatches it twice', async () => {
    const f = await fixture(true); await f.service.prepare(f.target, f.current, f.candidate);
    expect(await f.service.apply(f.target, f.current)).toMatchObject({ pid: 20002 });
    expect(f.state.cgroup).toContain('/rele-codex.service');
    expect(f.calls.filter(call => call[3] === 'start')).toHaveLength(1);
    const settled = await f.pending(); settled.phase = 'start-intent'; await writeFile(path.join(f.data, 'codex-linux-update.json'), JSON.stringify({ schema: 1, pending: settled }), { mode: 0o600 });
    expect(await f.starter.startPrepared(f.target)).toBe(true);
    expect(f.calls.filter(call => call[3] === 'start')).toHaveLength(1);
  });
  it.each(['queue', 'terminals', 'requests', 'approval', 'gauges'] as const)('refuses %s work before any signal', async kind => {
    const f = await fixture(); await f.service.prepare(f.target, f.current, f.candidate);
    if (kind === 'approval') f.state.status.activeFlags = ['waitingOnApproval'];
    else if (kind === 'gauges') f.state.gauges.push({ name: 'other.active.work', value: 1 });
    else f.state[kind] = [{}];
    await expect(f.service.apply(f.target, f.current)).rejects.toMatchObject({ code: 'linux-native-busy' });
    expect(f.calls.some(call => call.includes('--signal'))).toBe(false);
    expect((await f.pending()).phase).toBe('ready');
  });
  it('skips only the inapplicable ephemeral queue and keeps terminal checks', async () => {
    const f = await fixture(); f.state.ephemeral = true; f.state.terminals = [{}]; await f.service.prepare(f.target, f.current, f.candidate);
    await expect(f.service.apply(f.target, f.current)).rejects.toMatchObject({ code: 'linux-native-busy' });
    expect(f.calls.some(call => call.includes('--signal'))).toBe(false);
  });
  it('accepts the native lazy-zero gauge snapshot with persistent idle MCP connections', async () => {
    const f = await fixture(); f.state.gauges = [{ name: 'app.requests.in_flight', value: 1 }, { name: 'app.requests.queued', value: 0 }, { name: 'core.threads.live', value: 1 }, { name: 'mcp.connections.live', value: 2 }];
    await f.service.prepare(f.target, f.current, f.candidate);
    expect(await f.service.apply(f.target, f.current)).toMatchObject({ pid: 20002 });
  });
  it.each([{ name: 'app.server_requests.pending', value: 1 }, { name: 'core.mailbox.pending', value: 1 }, { name: 'unknown.metric', value: 0 }])('refuses an active or unknown gauge $name', async gauge => {
    const f = await fixture(); f.state.gauges.push(gauge); await f.service.prepare(f.target, f.current, f.candidate);
    await expect(f.service.apply(f.target, f.current)).rejects.toMatchObject({ code: 'linux-native-busy' });
    expect(f.calls.some(call => call.includes('--signal'))).toBe(false);
  });
  it('reconciles a lost successful start ACK without a second start or signal', async () => {
    const f = await fixture(); f.state.losesStartAck = true; await f.service.prepare(f.target, f.current, f.candidate);
    await expect(f.service.apply(f.target, f.current)).rejects.toThrow();
    expect((await f.pending()).phase).toBe('uncertain');
    expect(await f.service.apply(f.target, f.current)).toMatchObject({ pid: 20002 });
    expect(f.calls.filter(call => call[3] === 'start')).toHaveLength(1);
    expect(f.calls.filter(call => call.includes('--signal'))).toHaveLength(1);
  });
  it('does not repeat an unconfirmed start when no successor is found', async () => {
    const f = await fixture(); f.state.losesStartAck = true; f.state.startEffect = false; await f.service.prepare(f.target, f.current, f.candidate);
    await expect(f.service.apply(f.target, f.current)).rejects.toThrow();
    await expect(f.service.apply(f.target, f.current)).rejects.toThrow();
    expect(f.calls.filter(call => call[3] === 'start')).toHaveLength(1);
  });
  it('does not replay selection after an unconfirmed native package ACK', async () => {
    const f = await fixture(); f.state.losesSelectionAck = true; await f.service.prepare(f.target, f.current, f.candidate);
    await expect(f.service.apply(f.target, f.current)).rejects.toThrow();
    await expect(f.service.apply(f.target, f.current)).rejects.toThrow();
    expect(f.calls.filter(call => call[3] === 'update')).toHaveLength(1);
    expect(f.calls.filter(call => call[3] === 'start')).toHaveLength(0);
  });
  it('detects changed candidate bytes without signaling or consuming the prepared operation', async () => {
    const f = await fixture(); await f.service.prepare(f.target, f.current, f.candidate); await writeFile(f.candidate.executable, 'changed');
    await expect(f.service.apply(f.target, f.current)).rejects.toMatchObject({ code: 'linux-candidate-changed' });
    expect(f.calls.some(call => call.includes('--signal'))).toBe(false);
  });
});
