import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { findCSharpCompiler } from './build-process-host.mjs';

if (process.platform !== 'win32' || process.env.CI !== 'true') throw new Error('Use only an isolated Windows fixture.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'Rele owner primitive '));
const children = new Map();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const env = { ...process.env, RELE_OWNER_FIXTURE: temporary };
function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { env, windowsHide: true, encoding: 'utf8', timeout: 30_000, ...extra });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function child(command, args, extra = {}) {
  const process = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...extra });
  const closed = once(process, 'exit');
  void closed.catch(() => {});
  process.stdout.resume(); process.stderr.resume();
  children.set(process, closed);
  return { process, closed };
}
async function waitFile(file) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch {}
    await delay(50);
  }
  throw new Error('Owned fixture did not start.');
}
async function exited(pid) {
  for (let count = 0; count < 200; count++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(50);
  }
  throw new Error('An owned fixture process survived its private Job.');
}
try {
  const compiler = await findCSharpCompiler();
  const source = path.join(temporary, 'Native.cs');
  const native = path.join(temporary, 'Native.exe');
  await writeFile(source, `using System; using System.Diagnostics; using System.IO; using System.Threading; using System.Web.Script.Serialization;
internal static class Native { static int Main(string[] args) {
  if (args.Length == 1 && args[0] == "--descendant") { Thread.Sleep(120000); return 0; }
  string directory = Environment.GetEnvironmentVariable("RELE_OWNER_FIXTURE");
  using (var descendant = Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "--descendant") { UseShellExecute = false, CreateNoWindow = true })) {
    File.WriteAllText(Path.Combine(directory, "started.json"), new JavaScriptSerializer().Serialize(new {
      pid = Process.GetCurrentProcess().Id, descendant = descendant.Id, args = args,
      home = Environment.GetEnvironmentVariable("CODEX_HOME"), cli = Environment.GetEnvironmentVariable("CODEX_CLI_PATH"),
      force = Environment.GetEnvironmentVariable("CODEX_APP_SERVER_FORCE_CLI"), ws = Environment.GetEnvironmentVariable("CODEX_APP_SERVER_WS_URL") }));
    while (!File.Exists(Path.Combine(directory, "finish"))) Thread.Sleep(20);
    return 37;
  }
} }`);
  run(compiler, ['/nologo', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', `/out:${native}`, source]);
  const sid = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value']);
  const home = path.join(temporary, 'Original profile'); await mkdir(home);
  const host = path.join(root, 'dist/native/Rele.Process.exe');
  const marker = { Version: 1, OwnerSid: sid, Executable: native, ExecutableSha256: digest(await readFile(native)),
    HostSha256: digest(await readFile(host)), CodexHome: home, Endpoint: 'ws://127.0.0.1:57439', TaskName: `Rele-OwnerFixture-${randomUUID()}` };
  const serialized = JSON.stringify(marker);
  const directory = path.join(temporary, digest(serialized));
  env.RELE_OWNER_DIRECTORY = directory;
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop';
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false);
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'));
    [IO.Directory]::CreateDirectory($env:RELE_OWNER_DIRECTORY,$acl) | Out-Null`]);
  const copiedHost = path.join(directory, 'Rele.Process.exe'); await copyFile(host, copiedHost);
  const markerPath = path.join(directory, 'owner.json'); await writeFile(markerPath, serialized);
  const sentinel = child(native, ['--descendant']);
  const first = child(copiedHost, ['--codex-websocket-owner', markerPath], { env: { ...env,
    CODEX_CLI_PATH: 'foreign-fixture', CODEX_APP_SERVER_FORCE_CLI: '1', CODEX_APP_SERVER_WS_URL: 'ws://127.0.0.1:1' } });
  first.process.stdin.end();
  const started = await waitFile(path.join(temporary, 'started.json'));
  assert.deepEqual(started.args, ['-c', 'features.code_mode_host=true', 'app-server', '--listen', marker.Endpoint]);
  assert.equal(started.home, home);
  for (const key of ['cli', 'force', 'ws']) assert.equal(started[key], null);
  await delay(200); assert.equal(first.process.exitCode, null, 'Owner must ignore stdin EOF.');
  const receipt = await waitFile(path.join(directory, 'receipt.json'));
  assert.equal(receipt.nativePid, started.pid); assert.equal(receipt.hostPid, first.process.pid);
  assert.ok(receipt.nativeStartedAt); assert.ok(receipt.hostStartedAt);
  await writeFile(path.join(temporary, 'finish'), 'finish');
  assert.equal((await first.closed)[0], 37, 'Owner must preserve native exit code.');
  await exited(started.descendant);
  process.kill(sentinel.process.pid, 0);
  await rm(path.join(temporary, 'finish')); await rm(path.join(temporary, 'started.json'));
  const second = child(copiedHost, ['--codex-websocket-owner', markerPath]); second.process.stdin.end();
  const secondStarted = await waitFile(path.join(temporary, 'started.json'));
  second.process.kill(); await second.closed;
  await exited(secondStarted.pid); await exited(secondStarted.descendant);
  process.kill(sentinel.process.pid, 0);
  await rm(path.join(temporary, 'started.json'));
  const relay = child(host, ['--', native]);
  const relayStarted = await waitFile(path.join(temporary, 'started.json'));
  relay.process.stdin.end(); assert.equal((await relay.closed)[0], 0);
  await exited(relayStarted.pid); await exited(relayStarted.descendant);
  process.kill(sentinel.process.pid, 0);
  await writeFile(markerPath, serialized + '\n');
  const tampered = spawnSync(copiedHost, ['--codex-websocket-owner', markerPath], { env, windowsHide: true, timeout: 10_000, encoding: 'utf8' });
  assert.equal(tampered.status, 1); assert.match(tampered.stderr, /marker changed/u);
  sentinel.process.kill(); await sentinel.closed;
  console.log(JSON.stringify({ result: 'passed', ownerIgnoresStdinEof: true, nativeExitCode: true,
    fixedNativeArgvAndProfile: true, inheritedAdapterRemoved: true, privateJobCleanup: true,
    foreignProcessPreserved: true, stdioEofUnchanged: true, immutableMarkerChecked: true }));
} finally {
  for (const process of children.keys()) if (process.exitCode === null && process.signalCode === null) process.kill();
  await Promise.all([...children.values()].map(closed => Promise.race([closed.catch(() => {}), delay(3000)])));
  await rm(temporary, { recursive: true, force: true });
}
