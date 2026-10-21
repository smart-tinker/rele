import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeInstallerFixture } from './installer-codex-fixture.mjs';

if (process.platform !== 'win32' || process.env.CI !== 'true') throw new Error('Run this primitive only on a disposable Windows CI runner.');
const directory = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'rele-cleanup-'));
const relative = path.join('one', 'two', 'three', 'locked-node.exe');
const executable = path.join(directory, relative);
let child;
let exited;
const report = { platform: 'windows', result: 'failed', stage: 'prepare' };
async function closeChild() {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  let timeout;
  try { await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The owned lock process did not exit.')), 5000); })]); }
  finally { clearTimeout(timeout); }
}
try {
  await mkdir(path.dirname(executable), { recursive: true });
  await copyFile(process.execPath, executable);
  child = spawn(executable, ['-e', 'process.stdout.write("ready\\n"); process.stdin.resume();'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.resume();
  exited = once(child, 'exit');
  void exited.catch(() => {});
  let timeout;
  try {
    const [ready] = await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The owned lock process did not become ready.')), 5000); })]);
    assert.equal(ready.toString(), 'ready\n');
  } finally { clearTimeout(timeout); }
  const started = Date.now();
  let lockFailure;
  report.stage = 'locked-cleanup';
  await assert.rejects(removeInstallerFixture(directory, 1000), error => {
    lockFailure = error;
    return ['EPERM', 'EBUSY'].includes(error.code) && error.relativePath === relative;
  });
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs >= 1000 && elapsedMs < 5000, `The single retry budget took ${elapsedMs}ms.`);
  await access(executable);
  report.stage = 'unlock';
  await closeChild();
  report.stage = 'remove-after-unlock';
  await removeInstallerFixture(directory);
  await assert.rejects(access(directory), { code: 'ENOENT' });
  Object.assign(report, { lockedFailureCode: lockFailure.code, lockedFailureRelativePath: lockFailure.relativePath, elapsedMs, removedAfterUnlock: true });
} catch (error) {
  report.errorCode = typeof error.code === 'string' && /^[A-Z_]{1,32}$/u.test(error.code) ? error.code : 'UNKNOWN';
  throw error;
} finally {
  try {
    await closeChild();
    await removeInstallerFixture(directory);
    if (!report.errorCode && report.removedAfterUnlock) { report.result = 'passed'; report.stage = 'complete'; }
  } catch (error) {
    report.cleanupErrorCode = typeof error.code === 'string' && /^[A-Z_]{1,32}$/u.test(error.code) ? error.code : 'UNKNOWN';
    throw error;
  } finally {
    await writeFile(path.resolve('installer-cleanup-probe-results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }
}
