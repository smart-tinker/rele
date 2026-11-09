import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { closeInstallerChild, removeInstallerFixture } from './installer-codex-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const name = `rele-${metadata.version}-${process.platform === 'win32' ? 'windows' : 'linux'}-x64`;
const archive = path.resolve(process.argv[2] || path.join(root, 'release', name + (process.platform === 'win32' ? '.zip' : '.tar.gz')));
const expected = (await readFile(`${archive}.sha256`, 'utf8')).split(/\s/u)[0];
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
assert.equal(hash.digest('hex'), expected, 'Archive checksum mismatch');
const temporary = await mkdtemp(path.join(tmpdir(), 'Rele smoke '));
let child;
let closed;
let childError;
let primaryError;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || `${command} failed`);
  return result.stdout;
}
try {
  if (process.platform === 'win32') run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Expand-Archive -LiteralPath $env:RELE_SMOKE_ARCHIVE -DestinationPath $env:RELE_SMOKE_DIRECTORY'],
  { env: { ...process.env, RELE_SMOKE_ARCHIVE: archive, RELE_SMOKE_DIRECTORY: temporary } });
  else run('tar', ['-xzf', archive, '-C', temporary]);
  const extracted = path.join(temporary, name);
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    assert.equal(await readFile(path.join(extracted, file), 'utf8'), await readFile(path.join(root, file), 'utf8'), `${file} must survive packaging`);
  }
  const manifest = JSON.parse(await readFile(path.join(extracted, 'manifest.json'), 'utf8'));
  const runtime = path.join(extracted, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  assert.equal(run(runtime, ['--version']).trim(), 'v24.19.0');
  assert.equal(manifest.version, metadata.version);
  const env = { ...process.env, RELE_PORT: '0', RELE_DATA_DIR: path.join(temporary, 'state'), CODEX_HOME: path.join(temporary, 'codex-profile') };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[key];
  const launcher = process.platform === 'win32'
    ? run('cmd.exe', ['/d', '/s', '/c', 'start-rele.cmd --version'], { cwd: extracted, env })
    : run(path.join(extracted, 'start-rele.sh'), ['--version'], { cwd: extracted, env });
  assert.ok(launcher.includes(metadata.version), 'The packaged launcher did not report the version');
  child = spawn(process.platform === 'win32' ? path.join(extracted, 'dist/native/Rele.Process.exe') : path.join(extracted, 'start-rele.sh'),
    process.platform === 'win32' ? ['--', 'cmd.exe', '/d', '/s', '/c', 'start-rele.cmd'] : [],
    { cwd: extracted, env, windowsHide: true, stdio: [process.platform === 'win32' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  closed = new Promise(resolve => child.once('close', resolve));
  child.once('error', error => { childError = error; });
  child.stdin?.on('error', error => { childError ??= error; });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  let address;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (childError) throw childError;
    address = output.match(/Rele: (http:\/\/127\.0\.0\.1:\d+\/)/u)?.[1];
    if (address) break;
    assert.equal(child.exitCode, null, `Packaged server stopped: ${errors}`);
    await delay(100);
  }
  assert.ok(address, `Packaged server did not report its listening address: ${errors}`);
  const health = await fetch(new URL('api/health', address));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, version: metadata.version });
  const page = await fetch(address);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/iu);
  const privateState = await fetch(new URL('api/state', address));
  assert.equal(privateState.status, 401, 'Dashboard state must require its local access key');
  console.log(JSON.stringify({ package: path.basename(archive), result: 'passed', runtimeBundled: true, launcher: true, health: true, webPage: true, stateRequiresKey: true }));
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  let cleanupError;
  try {
    if (process.platform === 'win32' && child) {
      // EOF stops the private Job; exit 0 confirms all launcher descendants are gone.
      if (!child.stdin.destroyed) child.stdin.end();
      let timer;
      try {
        await Promise.race([closed, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('The packaged Windows process host did not close.')), 15_000);
        })]);
      } catch (error) {
        await closeInstallerChild(child, closed);
        throw error;
      } finally { clearTimeout(timer); }
      assert.equal(child.exitCode, 0, 'The packaged Windows process host did not confirm an empty Job.');
    } else if (child && child.exitCode === null) {
      child.kill();
      for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) await delay(100);
      if (child.exitCode === null) child.kill('SIGKILL');
      await delay(100);
    }
  } catch (error) { cleanupError = error; }
  try {
    if (process.platform === 'win32') await removeInstallerFixture(temporary);
    else await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) { cleanupError ??= error; }
  if (cleanupError) {
    if (primaryError) console.error(`Portable smoke cleanup also failed: ${cleanupError.message}`);
    else throw cleanupError;
  }
}
