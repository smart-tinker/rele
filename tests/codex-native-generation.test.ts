import { afterEach, expect, it } from 'vitest';
import { realpathSync, statSync } from 'node:fs';
import { spawn, execFile, execFileSync } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { copyFile, lstat, lutimes, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CodexClient } from '../src/server/codex.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('matches filesystem aliases for an owned Windows stdio profile', async () => {
  const { codexNativeGeneration } = await import('../src/server/codex-native-generation.js');
  const name = `rele-native-generation-${process.pid}-${Date.now()}`;
  const root = process.platform === 'win32' ? await mkdtemp(path.join(tmpdir(), name)) : `C:\\Users\\Owner\\${name}`;
  if (process.platform === 'win32') cleanup.push(() => rm(root, { recursive:true, force:true }));
  const home = path.win32.join(root, 'home'), aliasHome = path.win32.join(root, 'home-alias');
  await mkdir(home, { recursive:true });
  await symlink(home, aliasHome, process.platform === 'win32' ? 'junction' : 'dir');
  cleanup.push(async () => { await rm(aliasHome, { recursive:true, force:true }); await rm(home, { recursive:true, force:true }); });

  const executable = process.platform === 'win32' ? process.execPath : 'C:\\native\\codex.exe';
  const proof = { pid:process.pid, birth:'2026-11-03T10:00:00.1234567Z', boot:'2026-11-01T01:02:03.0000000Z', executable,
    sha256:'a'.repeat(64), owner:'S-1-5-21-1001', gatewayOwner:'S-1-5-21-1001', codexHome:aliasHome,
    peerVerified:true, parentPid:process.pid, gatewayId:process.pid };
  const peer = { kind:'stdio' as const, pid:process.pid, executable, codexHome:aliasHome };
  const run = async () => ({ stdout:JSON.stringify(proof), code:0 });
  expect(await codexNativeGeneration(peer, process.pid, home, { platform:'win32', run })).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
});

it('accepts a short executable alias only when Windows proof confirms matching bytes', async () => {
  const { codexNativeGeneration } = await import('../src/server/codex-native-generation.js');
  const home = 'C:\\Users\\Owner\\fixture', executable = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\node.exe';
  const shortExecutable = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\node.exe';
  const proof = { pid:process.pid, birth:'2026-11-03T10:00:00.1234567Z', boot:'2026-11-01T01:02:03.0000000Z', executable,
    executableContentMatchesExpected:true, sha256:'a'.repeat(64), owner:'S-1-5-21-1001', gatewayOwner:'S-1-5-21-1001', codexHome:home,
    peerVerified:true, parentPid:process.pid, gatewayId:process.pid };
  const peer = { kind:'stdio' as const, pid:process.pid, executable:shortExecutable, codexHome:home };
  const run = async () => ({ stdout:JSON.stringify(proof), code:0 });
  expect(await codexNativeGeneration(peer, process.pid, home, { platform:'win32', run })).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
  expect(await codexNativeGeneration(peer, process.pid, home, { platform:'win32', run:async () => ({ stdout:JSON.stringify({ ...proof, executableContentMatchesExpected:false }), code:0 }) })).toBeUndefined();
});

it.skipIf(process.platform !== 'win32')('proves an owned Windows stdio process when its executable is supplied by an 8.3 alias', async () => {
  const { codexNativeGeneration } = await import('../src/server/codex-native-generation.js');
  const root = path.join(tmpdir(), `R${process.pid.toString(36).slice(-4)}${Date.now().toString(36).slice(-3)}`);
  await mkdir(root);
  cleanup.push(() => rm(root, { recursive:true, force:true }));
  const home = path.join(root, 'home'), executable = path.join(root, 'node.exe');
  await mkdir(home);
  await copyFile(process.execPath, executable);
  const shortExecutable = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `for %I in ("${executable}") do @echo %~sI`], { encoding:'utf8' }).trim();
  expect(shortExecutable.toLowerCase()).not.toBe(executable.toLowerCase());
  const child = spawn(executable, ['-e', 'setInterval(() => {}, 1000)'], { stdio:'ignore', windowsHide:true });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'close'); } });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  let proofStage: string | undefined;
  const sameFile = (left: unknown, right: string) => {
    if (typeof left !== 'string') return false;
    if (path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase()) return true;
    try {
      const a = statSync(left, { bigint:true }), b = statSync(right, { bigint:true });
      if (a.dev !== 0n && b.dev !== 0n && a.ino !== 0n && b.ino !== 0n) return a.dev === b.dev && a.ino === b.ino;
      return path.win32.normalize(realpathSync.native(left)).toLowerCase() === path.win32.normalize(realpathSync.native(right)).toLowerCase();
    } catch { return false; }
  };
  expect(sameFile(shortExecutable, executable)).toBe(true);
  const run = async (command:string, args:string[]) => {
    try {
      const result = await promisify(execFile)(command, args, { timeout:30_000, maxBuffer:128*1024, windowsHide:true });
      try {
        const proof = JSON.parse(result.stdout) as Record<string, unknown>;
        const checks = [
          ['peer', proof.peerVerified === true], ['pid', proof.pid === child.pid], ['gateway', proof.gatewayId === process.pid],
          ['birth', typeof proof.birth === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(proof.birth) && Number.isFinite(Date.parse(proof.birth))],
          ['owner', typeof proof.owner === 'string' && /^S-1-\d+(?:-\d+)+$/u.test(proof.owner)],
          ['hash', typeof proof.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(proof.sha256)],
          ['executable-path', typeof proof.executable === 'string' && /^[A-Za-z]:\\/u.test(proof.executable) && path.win32.isAbsolute(proof.executable)],
          ['home-path', typeof proof.codexHome === 'string' && /^[A-Za-z]:\\/u.test(proof.codexHome) && path.win32.isAbsolute(proof.codexHome)],
          ['image-hash', proof.executableContentMatchesExpected === true],
          ['executable', sameFile(proof.executable, shortExecutable)], ['home', sameFile(proof.codexHome, home)],
          ['boot', typeof proof.boot === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(proof.boot) && Number.isFinite(Date.parse(proof.boot))],
          ['parent', proof.parentPid === process.pid], ['gateway-owner', proof.gatewayOwner === proof.owner],
        ];
        proofStage = `proof-fields:${checks.filter(([, ok]) => !ok).map(([name]) => name).join(',') || 'ok'}`;
      } catch { proofStage = `proof-output:${result.stdout.trim() ? 'invalid-json' : 'empty'}`; }
      return { stdout:result.stdout, code:0 };
    } catch (error) {
      const stderr = String((error as { stderr?:string }).stderr ?? '');
      const marker = /rele-native-proof:([a-z-]+)(?::([A-Za-z]+):([A-Za-z]+)(?::([A-Za-z0-9-]+))?)?/u.exec(stderr);
      proofStage = marker ? [marker[1], marker[2], marker[3], marker[4]].filter(Boolean).join(':') : 'powershell-invocation';
      return { stdout:'', code:1 };
    }
  };
  const generation = await codexNativeGeneration({ kind:'stdio', pid:child.pid!, codexHome:home, executable:shortExecutable }, child.pid!, home, { platform:'win32', run });
  if (!generation) throw new Error(`Windows native proof failed at ${proofStage ?? 'unknown stage'}`);
  expect(generation).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
}, 60000);

async function proxyFixture(churn = false, coldExecutable = false, symlinkEndpoint = false, pidRecord = true) {
  const home = await mkdtemp(path.join(tmpdir(), 'rele-generation-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'app-server-control'), endpoint = path.join(directory, 'app-server-control.sock');
  await mkdir(directory);
  await mkdir(path.join(home, 'app-server-daemon'));
  const claimed = path.join(home, 'claimed-pid');
  const nativeExecutable = coldExecutable ? path.join(home, 'cold-node') : process.execPath;
  if (coldExecutable) await copyFile(process.execPath, nativeExecutable);
  const ws = createRequire(import.meta.url).resolve('ws');
  const source = `
    const { createServer } = require('node:http');
    const { writeFileSync, readFileSync } = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const { WebSocketServer } = require(${JSON.stringify(ws)});
    const home = ${JSON.stringify(home)}, endpoint = ${JSON.stringify(endpoint)}, boundEndpoint = ${JSON.stringify(symlinkEndpoint ? endpoint + '.bound' : endpoint)};
    const server = createServer(), websocket = new WebSocketServer({ server });
    websocket.on('connection', socket => socket.on('message', raw => {
      const m = JSON.parse(raw); if (m.id === undefined) return;
      let result;
      if (m.method === 'initialize') result = { userAgent:'rele/0.166.0-alpha.5.1 (Linux)', codexHome:home, platformFamily:'unix', platformOs:'linux' };
      else if (m.method === 'server/diagnostics') {
        let pid = process.pid; try { pid = Number(readFileSync(${JSON.stringify(claimed)}, 'utf8')); } catch {}
        result = { process:{ id:pid }, gauges:[] };
      } else if (m.method === 'thread/list') result = { data:[{ id:'fixture', cwd:home, preview:'Fixture', updatedAt:1, status:{ type:'idle' } }], nextCursor:null };
      else if (m.method === 'thread/backgroundTerminals/list' || m.method === 'thread/queue/list') result = { data:[], nextCursor:null };
      else { socket.send(JSON.stringify({ id:m.id, error:{ code:-32601, message:'fixture method' } })); return; }
      socket.send(JSON.stringify({ id:m.id, result }));
    }));
    server.listen(boundEndpoint, () => {
      if (${JSON.stringify(symlinkEndpoint)}) require('node:fs').symlinkSync(boundEndpoint, endpoint);
      if (${JSON.stringify(pidRecord)}) writeFileSync(home + '/app-server-daemon/daemon.pid', JSON.stringify({ pid:process.pid, processStartTime:execFileSync('/usr/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding:'utf8' }).trim() }));
      if (${JSON.stringify(churn)}) { let noisy; setInterval(() => { noisy?.destroy(); noisy=require('node:net').createConnection(endpoint); noisy.on('error',()=>{}); }, 3); }
      process.stdout.write('ready\\n');
    });
  `;
  async function native() {
    const child = spawn(nativeExecutable, ['-e', source], { env:{ ...process.env, CODEX_HOME:home }, stdio:['ignore','pipe','pipe'] });
    cleanup.push(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'close'); } });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject); child.once('exit', () => reject(new Error('native fixture exited before listening')));
    });
    return child;
  }
  const server = await native();
  const executable = path.join(home, 'proxy.mjs');
  await writeFile(executable, `import net from 'node:net'; const socket=net.createConnection(process.argv.at(-1)); process.stdin.pipe(socket); socket.pipe(process.stdout); socket.on('error',()=>process.exit(1)); socket.on('close',()=>process.exit(0));`);
  const client = new CodexClient({ executable, transport:'shared', codexHome:home }, {
    shared:async target => ({ ...target, transport:'proxy', endpoint }),
  });
  cleanup.push(() => client.close());
  return { client, server, home, endpoint, claimed, native, nativeExecutable };
}

it.skipIf(process.platform !== 'linux')('keeps a daemon generation across replacement of the actual owned Unix proxy connection', async () => {
  const f = await proxyFixture();
  await f.client.connect();
  const first = await f.client.backgroundTerminals('fixture');
  expect(first.serverId).toBe(f.server.pid);
  expect(first).toHaveProperty('serverGeneration', expect.stringMatching(/^[a-f0-9]{64}$/u));
  await f.client.close();
  await f.client.connect();
  expect(await f.client.backgroundTerminals('fixture')).toEqual(first);
});

it.skipIf(process.platform !== 'linux')('does not attest a replacement listener and claimed PID while the transport is still connected to the old daemon', async () => {
  const f = await proxyFixture();
  await f.client.connect();
  const first = await f.client.backgroundTerminals('fixture');
  expect(first).toHaveProperty('serverGeneration', expect.stringMatching(/^[a-f0-9]{64}$/u));
  await rename(f.endpoint, f.endpoint + '.old');
  const replacement = await f.native();
  await writeFile(f.claimed, String(replacement.pid));
  const after = await f.client.backgroundTerminals('fixture');
  expect(after.serverId).toBe(replacement.pid);
  expect(after).not.toHaveProperty('serverGeneration');
});

it.skipIf(process.platform !== 'linux')('keeps the proven Unix peer generation while unrelated native sockets change', async () => {
  const f = await proxyFixture(true);
  await f.client.connect();
  let generation: string | undefined;
  for (let i = 0; i < 3; i++) {
    const snapshot = await f.client.backgroundTerminals('fixture');
    expect(snapshot.serverId).toBe(f.server.pid);
    expect(snapshot.serverGeneration).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
    if (generation) expect(snapshot.serverGeneration).toBe(generation);
    generation = snapshot.serverGeneration;
  }
}, 15000);

it.skipIf(process.platform !== 'linux')('proves a cold native executable when reading its hash updates only access time', async () => {
  const f = await proxyFixture(false, true);
  await f.client.connect();
  const executable = await stat(f.nativeExecutable);
  await utimes(f.nativeExecutable, new Date('2000-01-01T00:00:00Z'), executable.mtime);
  const snapshot = await f.client.backgroundTerminals('fixture');
  expect(snapshot.serverId).toBe(f.server.pid);
  expect(snapshot.serverGeneration).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
}, 15000);

it.skipIf(process.platform !== 'linux')('proves a symlink native endpoint when readlink changes only its access time', async () => {
  const f = await proxyFixture(false, false, true);
  await f.client.connect();
  const endpoint = await lstat(f.endpoint);
  expect(endpoint.isSymbolicLink()).toBe(true);
  await lutimes(f.endpoint, new Date('2000-01-01T00:00:00Z'), endpoint.mtime);
  const snapshot = await f.client.backgroundTerminals('fixture');
  expect(snapshot.serverId).toBe(f.server.pid);
  expect(snapshot.serverGeneration).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
  expect(await f.client.backgroundTerminals('fixture')).toEqual(snapshot);
}, 15000);

it.skipIf(process.platform !== 'linux')('proves a legacy Unix daemon without pid-records across proxy reconnects', async () => {
  const f = await proxyFixture(false, false, true, false);
  await f.client.connect();
  const first = await f.client.backgroundTerminals('fixture');
  expect(first.serverId).toBe(f.server.pid);
  expect(first.serverGeneration).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
  await f.client.close();
  await f.client.connect();
  expect(await f.client.backgroundTerminals('fixture')).toEqual(first);
}, 15000);

it.skipIf(process.platform !== 'linux').each(['malformed', 'wrong-pid', 'wrong-birth', 'multiple', 'directory'] as const)('refuses an existing %s Unix pid-record', async invalid => {
  const f = await proxyFixture();
  const record = path.join(f.home, 'app-server-daemon', 'daemon.pid');
  const valid = await readFile(record, 'utf8');
  if (invalid === 'malformed') await writeFile(record, '{');
  if (invalid === 'wrong-pid') await writeFile(record, JSON.stringify({ ...JSON.parse(valid), pid:f.server.pid! + 1 }));
  if (invalid === 'wrong-birth') await writeFile(record, JSON.stringify({ ...JSON.parse(valid), processStartTime:'foreign birth' }));
  if (invalid === 'multiple') await writeFile(path.join(f.home, 'app-server-daemon', 'app-server.pid'), valid);
  if (invalid === 'directory') { await unlink(record); await mkdir(record); }
  await f.client.connect();
  const snapshot = await f.client.backgroundTerminals('fixture');
  expect(snapshot.serverId).toBe(f.server.pid);
  expect(snapshot).not.toHaveProperty('serverGeneration');
});

it.skipIf(process.platform !== 'linux').each(['appeared', 'disappeared', 'rewritten', 'replaced'] as const)('refuses a Unix pid-record that %s during physical proof', async change => {
  const f = await proxyFixture(false, true);
  const record = path.join(f.home, 'app-server-daemon', 'daemon.pid');
  const valid = await readFile(record, 'utf8');
  if (change === 'appeared') await unlink(record);
  await f.client.connect();
  const executable = await stat(f.nativeExecutable);
  const oldAccess = new Date('2000-01-01T00:00:00Z');
  await utimes(f.nativeExecutable, oldAccess, executable.mtime);
  const pending = f.client.backgroundTerminals('fixture');
  // A copied executable belongs only to this fixture. Its first hash read signals
  // that physical proof has begun, without hooks in the production proof code.
  const deadline = Date.now() + 5000;
  while ((await stat(f.nativeExecutable)).atimeMs <= oldAccess.getTime()) {
    if (Date.now() >= deadline) throw new Error('fixture executable was not read');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  if (change === 'appeared') await writeFile(record, valid);
  if (change === 'disappeared') await unlink(record);
  if (change === 'rewritten') await writeFile(record, JSON.stringify({ ...JSON.parse(valid), changedDuringProof:true }));
  if (change === 'replaced') { await rename(record, record + '.old'); await writeFile(record, valid); }
  const snapshot = await pending;
  expect(snapshot.serverId).toBe(f.server.pid);
  expect(snapshot).not.toHaveProperty('serverGeneration');
}, 15000);

// Windows commands are the external OS boundary on this Linux builder. The same
// parser must refuse forged/incomplete evidence without falling back to diagnostics.
it('Windows proof survives a new client port and future controller while keeping the actual native identity', async () => {
  const { codexNativeGeneration } = await import('../src/server/codex-native-generation.js');
  const home = 'C:\\Users\\Owner\\fixture', executable = 'C:\\native\\codex.exe';
  const receipt = { status:'alreadyRunning', endpoint:'ws://127.0.0.1:62662', codexHome:home, executable, executableSha256:'a'.repeat(64), ownerSid:'S-1-5-21-1001', processId:10944, processStartTime:'2026-11-03T10:00:00.1234567Z', taskName:'Rele-Old-Codex', ownerDirectory:'C:\\old-controller' };
  let localPort = 55001;
  const run = async (command: string) => ({ stdout:JSON.stringify(command.endsWith('Rele.exe') ? receipt : { pid:10944, birth:receipt.processStartTime, boot:'2026-11-01T01:02:03.0000000Z', executable, sha256:'a'.repeat(64), owner:receipt.ownerSid, codexHome:home, peerVerified:true, localPort, remotePort:62662, gatewayId:process.pid }), code:0 });
  const prove = () => Reflect.apply(codexNativeGeneration, undefined, [{ kind:'windows-shared', endpoint:receipt.endpoint, localPort, remotePort:62662 }, 10944, home, { platform:'win32', run, installationDirectory:'C:\\Rele' }]);
  const first = await prove();
  expect(first).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
  localPort = 55002; receipt.taskName = 'Rele-New-Codex'; receipt.ownerDirectory = 'C:\\new-controller';
  expect(await prove()).toBe(first);
  receipt.processStartTime = '2026-11-03T10:00:00.1234568Z';
  expect(await prove()).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
  expect(await prove()).not.toBe(first);
});

it('limits Windows proof diagnostics to a fixed stage, exception type and category', async () => {
  const { codexNativeGeneration } = await import('../src/server/codex-native-generation.js');
  const home = 'C:\\Users\\Owner\\fixture', executable = 'C:\\native\\codex.exe';
  const receipt = { status:'alreadyRunning', endpoint:'ws://127.0.0.1:62662', codexHome:home, executable, executableSha256:'a'.repeat(64), ownerSid:'S-1-5-21-1001', processId:10944, processStartTime:'2026-11-03T10:00:00.1234567Z' };
  let proof = '';
  const run = async (command: string, args: string[]) => {
    if (command.endsWith('Rele.exe')) return { stdout:JSON.stringify(receipt), code:0 };
    proof = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
    return { stdout:'', code:1 };
  };
  const generation = await Reflect.apply(codexNativeGeneration, undefined, [{ kind:'windows-shared', endpoint:receipt.endpoint, localPort:55001, remotePort:62662 }, 10944, home, { platform:'win32', run, installationDirectory:'C:\\Rele' }]);
  expect(generation).toBeUndefined();
  expect(proof).toContain("$failureType += '-' + $detail.NativeErrorCode");
  expect(proof).toContain("[Console]::Error.WriteLine('rele-native-proof:' + $script:stage + ':' + $_.Exception.GetType().Name + ':' + $_.CategoryInfo.Category + ':' + $failureType)");
  expect(proof).not.toContain('$_.Exception.Message');
  expect(proof).toContain("$script:stage='tcp-query'");
});

it.each([
  { peerVerified:false }, { pid:10945 }, { owner:'S-1-5-21-1002' }, { sha256:'b'.repeat(64) },
  { codexHome:'C:\\Users\\Other\\fixture' }, { birth:'2026-11-03T10:00:00.1234568Z' },
  { localPort:55002 }, { remotePort:62663 }, { gatewayId:999 }, { boot:null },
])('Windows proof refuses mismatched physical peer evidence %j', async change => {
  const { codexNativeGeneration } = await import('../src/server/codex-native-generation.js');
  const home = 'C:\\Users\\Owner\\fixture', executable = 'C:\\native\\codex.exe';
  const receipt = { status:'alreadyRunning', endpoint:'ws://127.0.0.1:62662', codexHome:home, executable, executableSha256:'a'.repeat(64), ownerSid:'S-1-5-21-1001', processId:10944, processStartTime:'2026-11-03T10:00:00.1234567Z' };
  const proof = { pid:10944, birth:receipt.processStartTime, boot:'2026-11-01T01:02:03.0000000Z', executable, sha256:'a'.repeat(64), owner:receipt.ownerSid, codexHome:home, peerVerified:true, localPort:55001, remotePort:62662, gatewayId:process.pid, ...change };
  const run = async (command: string) => ({ stdout:JSON.stringify(command.endsWith('Rele.exe') ? receipt : proof), code:0 });
  expect(await Reflect.apply(codexNativeGeneration, undefined, [{ kind:'windows-shared', endpoint:receipt.endpoint, localPort:55001, remotePort:62662 }, 10944, home, { platform:'win32', run, installationDirectory:'C:\\Rele' }])).toBeUndefined();
});


it.skipIf(process.platform !== 'win32')('binds the real Windows TCP peer and full-precision process birth under the builder owner', async () => {
  const { codexNativeGeneration } = await import('../src/server/codex-native-generation.js');
  const home = await mkdtemp(path.join(tmpdir(), 'rele-tcp-generation-'));
  cleanup.push(() => rm(home, { recursive:true, force:true }));
  const server = spawn(process.execPath, ['-e', "const net=require('node:net'); const server=net.createServer(s=>s.write('ready')); server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\\n'))"], { env:{ ...process.env, CODEX_HOME:home }, stdio:['ignore','pipe','pipe'] });
  cleanup.push(async () => { if (server.exitCode === null) { server.kill(); await once(server, 'close'); } });
  const port = await new Promise<number>((resolve, reject) => { server.stdout.once('data', value => resolve(Number(value.toString().trim()))); server.once('error', reject); });
  const socket = net.createConnection({ host:'127.0.0.1', port });
  cleanup.push(async () => { socket.destroy(); });
  await once(socket, 'data');
  const execute = promisify(execFile);
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const inspect = `$ErrorActionPreference='Stop'; $p=[Diagnostics.Process]::GetProcessById(${server.pid}); $o=Invoke-CimMethod -InputObject (Get-CimInstance Win32_Process -Filter 'ProcessId=${server.pid}') -MethodName GetOwnerSid; [ordered]@{processId=$p.Id;processStartTime=$p.StartTime.ToUniversalTime().ToString('o');ownerSid=$o.Sid;executable=$p.MainModule.FileName;executableSha256=(Get-FileHash -LiteralPath $p.MainModule.FileName -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json -Compress`;
  const physical = JSON.parse((await execute(powershell, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(inspect,'utf16le').toString('base64')], { timeout:30000 })).stdout);
  const receipt = { ...physical, status:'alreadyRunning', endpoint:`ws://127.0.0.1:${port}`, codexHome:home };
  let failureStage: string | undefined;
  const run = async (command: string, args: string[]) => {
    if (command.endsWith('Rele.exe')) return { stdout:JSON.stringify(receipt), code:0 };
    try { return { ...(await execute(command,args,{ timeout:30000 })), code:0 }; }
    catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      failureStage = `${failure.stderr ?? ''}\n${failure.stdout ?? ''}`.match(/rele-native-proof:([a-z-]+)/u)?.[1];
      return { stdout:failure.stdout ?? '', code:typeof failure.code === 'number' ? failure.code : 1 };
    }
  };
  const peer = { kind:'windows-shared' as const, endpoint:receipt.endpoint, localPort:socket.localPort!, remotePort:port };
  const first = await codexNativeGeneration(peer, server.pid!, home, { run });
  expect(first, `Windows native proof failed at fixed stage: ${failureStage ?? 'unreported'}`).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
  expect(await codexNativeGeneration({ ...peer, localPort:peer.localPort+1 }, server.pid!, home, { run })).toBeUndefined();
  // Same listener/PID but no actual connected peer must never earn the proof.
  socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(await codexNativeGeneration(peer, server.pid!, home, { run })).toBeUndefined();
}, 60000);


it('proves a direct owned Windows stdio child without controller or TCP evidence', async () => {
  const { codexNativeGeneration } = await import('../src/server/codex-native-generation.js');
  const home = 'C:\\Users\\Owner\\fixture', executable = 'C:\\native\\codex.exe';
  let birth = '2026-11-03T10:00:00.1234567Z';
  const commands: string[] = [];
  const run = async (command: string) => {
    commands.push(command);
    if (command.endsWith('Rele.exe')) throw new Error('stdio proof must not query an unrelated installed controller');
    return { stdout:JSON.stringify({ pid:10944, birth, boot:'2026-11-01T01:02:03.0000000Z', executable, sha256:'a'.repeat(64), owner:'S-1-5-21-1001', gatewayOwner:'S-1-5-21-1001', codexHome:home, peerVerified:true, parentPid:process.pid, gatewayId:process.pid }), code:0 };
  };
  const peer = { kind:'stdio', pid:10944, codexHome:home, executable };
  const prove = () => Reflect.apply(codexNativeGeneration, undefined, [peer, 10944, home, { platform:'win32', run }]);
  const first = await prove();
  expect(first).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
  expect(await prove()).toBe(first);
  birth = '2026-11-03T10:00:00.1234568Z';
  expect(await prove()).not.toBe(first);
  expect(commands.length).toBeGreaterThan(0);
  expect(commands.every(command => command.endsWith('powershell.exe'))).toBe(true);
});

it.each([
  { pid:10945 }, { parentPid:999 }, { gatewayId:999 }, { peerVerified:false },
  { owner:'S-1-5-21-1002' }, { gatewayOwner:null }, { sha256:'bad' }, { boot:null },
  { birth:'bad' }, { codexHome:'C:\\Other' }, { executable:'C:\\other.exe' },
])('refuses incomplete or foreign Windows stdio proof %j', async change => {
  const { codexNativeGeneration } = await import('../src/server/codex-native-generation.js');
  const home = 'C:\\Users\\Owner\\fixture', executable = 'C:\\native\\codex.exe';
  const proof = { pid:10944, birth:'2026-11-03T10:00:00.1234567Z', boot:'2026-11-01T01:02:03.0000000Z', executable, sha256:'a'.repeat(64), owner:'S-1-5-21-1001', gatewayOwner:'S-1-5-21-1001', codexHome:home, peerVerified:true, parentPid:process.pid, gatewayId:process.pid, ...change };
  const run = async () => ({ stdout:JSON.stringify(proof), code:0 });
  expect(await Reflect.apply(codexNativeGeneration, undefined, [{ kind:'stdio', pid:10944, codexHome:home, executable }, 10944, home, { platform:'win32', run }])).toBeUndefined();
});


it('proves only the exact owned Windows process helper and its direct selected native child', async () => {
  const { codexNativeGeneration } = await import('../src/server/codex-native-generation.js');
  const home = 'C:\\Users\\Owner\\fixture', executable = 'C:\\native\\codex.exe', helperExecutable='C:\\Rele\\dist\\native\\Rele.Process.exe';
  const proof = { pid:10944, birth:'2026-11-03T10:00:00.1234567Z', boot:'2026-11-01T01:02:03.0000000Z', executable, sha256:'a'.repeat(64), owner:'S-1-5-21-1001', gatewayOwner:'S-1-5-21-1001', codexHome:home, peerVerified:true, parentPid:10900, gatewayId:process.pid, helperPid:10900, helperParentPid:process.pid, helperExecutable, helperBirth:'2026-11-03T10:00:00.0000000Z', helperOwner:'S-1-5-21-1001', helperSha256:'b'.repeat(64) };
  const run = async (command: string) => { expect(command.endsWith('Rele.exe')).toBe(false); return { stdout:JSON.stringify(proof), code:0 }; };
  const peer = { kind:'stdio', pid:10900, codexHome:home, executable, helperExecutable };
  const prove = () => Reflect.apply(codexNativeGeneration, undefined, [peer, 10944, home, { platform:'win32', run, installationDirectory:'C:\\Rele' }]);
  expect(await prove()).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
  for (const change of [
    { parentPid:999 }, { helperPid:999 }, { helperParentPid:999 }, { helperExecutable:'C:\\Other\\Rele.Process.exe' },
    { helperOwner:'S-1-5-21-1002' }, { helperBirth:null }, { helperSha256:'bad' },
  ]) {
    const bad = { ...proof, ...change };
    expect(await Reflect.apply(codexNativeGeneration, undefined, [peer, 10944, home, { platform:'win32', run:async () => ({ stdout:JSON.stringify(bad), code:0 }), installationDirectory:'C:\\Rele' }])).toBeUndefined();
  }
});
