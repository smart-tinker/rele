import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeInstallerFixture, closeInstallerChild, installerCodex, stopInstallerCodex } from './installer-codex-fixture.mjs';

if (process.platform !== 'win32' || process.env.CI !== 'true') throw new Error('Run this primitive only on a disposable Windows CI runner.');
async function lockProbe() {
  const directory = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'rele-cleanup-'));
  let child;
  let closed;
  const report = { platform: 'windows', result: 'failed', stage: 'prepare' };
  try {
    for (const test of [
      { name: 'pe', relative: path.join('one', 'two', 'three', 'locked-node.exe'), codes: ['EPERM', 'EBUSY'] },
      { name: 'cwd', relative: 'Legacy Rele % fixture', codes: ['EBUSY'] },
    ]) {
      report.stage = test.name + '-prepare';
      const target = path.join(directory, test.relative);
      await mkdir(test.name === 'pe' ? path.dirname(target) : target, { recursive: true });
      if (test.name === 'pe') await copyFile(process.execPath, target);
      child = spawn(test.name === 'pe' ? target : process.execPath, ['-e', 'process.stdout.write("ready\\n"); process.stdin.resume();'], { cwd: test.name === 'pe' ? path.dirname(directory) : target, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stderr.resume();
      closed = once(child, 'close');
      void closed.catch(() => {});
      let timeout;
      try {
        const [ready] = await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The owned lock process did not become ready.')), 5000); })]);
        assert.equal(ready.toString(), 'ready\n');
      } finally { clearTimeout(timeout); }
      const started = Date.now();
      let lockFailure;
      report.stage = test.name + '-locked-cleanup';
      await assert.rejects(removeInstallerFixture(directory, 1000), error => {
        lockFailure = error;
        return test.codes.includes(error.code) && error.relativePath === test.relative;
      });
      const elapsedMs = Date.now() - started;
      assert.ok(elapsedMs >= 1000 && elapsedMs < 5000, `The single retry budget took ${elapsedMs}ms.`);
      await access(target);
      report.stage = test.name + '-unlock';
      await closeInstallerChild(child, closed);
      child = undefined; closed = undefined;
      report.stage = test.name + '-remove-after-unlock';
      await removeInstallerFixture(directory);
      await assert.rejects(access(directory), { code: 'ENOENT' });
      const result = { lockedFailureCode: lockFailure.code, lockedFailureRelativePath: lockFailure.relativePath, elapsedMs, removedAfterUnlock: true };
      if (test.name === 'pe') Object.assign(report, result); else report.cwdLock = result;
    }
  } catch (error) {
    report.errorCode = typeof error.code === 'string' && /^[A-Z_]{1,32}$/u.test(error.code) ? error.code : 'UNKNOWN';
    throw error;
  } finally {
    try {
      await closeInstallerChild(child, closed);
      await removeInstallerFixture(directory);
      if (!report.errorCode && report.removedAfterUnlock && report.cwdLock?.removedAfterUnlock) { report.result = 'passed'; report.stage = 'complete'; }
    } catch (error) {
      report.cleanupErrorCode = typeof error.code === 'string' && /^[A-Z_]{1,32}$/u.test(error.code) ? error.code : 'UNKNOWN';
      throw error;
    } finally {
      await writeFile(path.resolve('installer-cleanup-probe-results.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify(report));
    }
  }
}

async function nativeProbe() {
  const directory = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'rele-native-cleanup-'));
  const report = { platform: 'windows', codexVersion: '0.163.0', result: 'failed', stage: 'prepare' };
  let target;
  try {
    target = await installerCodex(path.join(directory, 'Isolated Codex'));
    const env = { ...process.env, CODEX_HOME: target.codexHome };
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[key];
    report.stage = 'native-start';
    const started = spawnSync(target.executable, ['app-server', 'daemon', 'start'], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(started.status, 0, 'The isolated native cleanup backend did not start.');
    const output = JSON.parse(started.stdout);
    assert.equal(output.status, 'started');
    assert.ok(Number.isSafeInteger(output.pid) && output.pid > 0);
    process.kill(output.pid, 0);
    const state = path.join(target.codexHome, 'app-server-daemon');
    for (const file of ['daemon-updater.pid', 'app-server-updater.pid']) await assert.rejects(access(path.join(state, file)), { code: 'ENOENT' });
    report.updaterPidAbsent = true;
    await access(path.join(state, 'workdir'));
    report.stage = 'native-stop';
    assert.equal(stopInstallerCodex(target).status, 'stopped');
    assert.throws(() => process.kill(output.pid, 0), { code: 'ESRCH' });
    report.backendExitConfirmed = true;
    report.stage = 'workdir-release';
    await removeInstallerFixture(directory);
    await assert.rejects(access(directory), { code: 'ENOENT' });
    report.workdirReleased = true;
  } catch (error) {
    report.errorCode = typeof error.code === 'string' && /^[A-Z_]{1,32}$/u.test(error.code) ? error.code : 'UNKNOWN';
    if (error.relativePath) report.relativePath = error.relativePath;
    throw error;
  } finally {
    try {
      if (target && !report.backendExitConfirmed) stopInstallerCodex(target);
      await removeInstallerFixture(directory);
      if (!report.errorCode && report.updaterPidAbsent && report.backendExitConfirmed && report.workdirReleased) { report.result = 'passed'; report.stage = 'complete'; }
    } catch (error) {
      report.cleanupErrorCode = typeof error.code === 'string' && /^[A-Z_]{1,32}$/u.test(error.code) ? error.code : 'UNKNOWN';
      if (error.relativePath) report.cleanupRelativePath = error.relativePath;
      throw error;
    } finally {
      await writeFile(path.resolve(process.env.RELE_TEST_REPORT_DIR || '.', 'installer-native-cleanup-results.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify(report));
    }
  }
}

if (process.argv.length === 2) await lockProbe();
else if (process.argv.length === 3 && process.argv[2] === '--native') await nativeProbe();
else throw new Error('Unknown installer cleanup probe argument.');
