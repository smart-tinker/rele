import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ConfigStore, mergeConfig } from '../dist/server/config.js';
import { Store } from '../dist/server/store.js';
import { installerCodex, sharedBackendPid, stopInstallerCodex, removeInstallerFixture } from './installer-codex-fixture.mjs';

// This test installs a real OS package and unit only on a disposable CI runner.
if (process.platform !== 'linux' || process.env.CI !== 'true' || !existsSync('/run/systemd/system')) throw new Error('Run the installer smoke only on a disposable Linux CI runner with systemd.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const artifact = path.resolve(process.argv[2] || path.join(root, 'release', `rele-${metadata.version}-linux-x64.deb`));
const owner = os.userInfo().username;
const work = await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'Rele Debian smoke '));
const config = new ConfigStore(path.join(work, 'data'));
const report = { platform: 'linux', version: metadata.version, passed: [] };
function run(program, args, allowFailure = false) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`${program}: ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const sudo = args => run('/usr/bin/sudo', ['-n', ...args]);
const ctl = (...args) => run('/usr/bin/systemctl', args);
function preserved() {
  const store = new Store(path.join(config.directory, 'rele.sqlite'));
  try { assert.equal(store.getMeta('installer:preserve'), 'Bindings and delivery data survive package changes.'); }
  finally { store.close(); }
}
async function healthy(previousPid) {
  const deadline = Date.now() + 20_000;
  do {
    try {
      const current = JSON.parse(await readFile(path.join(config.directory, 'instance.json'), 'utf8'));
      assert.equal(current.pid, Number(ctl('show', 'rele.service', '--property=MainPID', '--value').stdout.trim()));
      if (previousPid) assert.notEqual(current.pid, previousPid);
      const response = await fetch(new URL('/api/health', current.address), { signal: AbortSignal.timeout(1000) });
      assert.deepEqual(await response.json(), { ok: true, version: metadata.version });
      return current;
    } catch { await delay(200); }
  } while (Date.now() < deadline);
  throw new Error('Installed systemd service never became healthy.');
}
await config.load();
const codexFixture = await installerCodex(path.join(work, 'codex'));
await config.save(mergeConfig(config.config, { codex: codexFixture }));
assert.notEqual(run('/usr/bin/dpkg-query', ['-W', '-f=${db:Status-Status}', 'rele'], true).stdout.trim(), 'installed', 'Runner must not already have Rele installed.');
try {
  sudo(['/usr/bin/env', `SUDO_USER=${owner}`, `RELE_INSTALL_DATA_DIR=${config.directory}`, `RELE_INSTALL_CODEX_HOME=${path.join(work, 'codex')}`, 'RELE_INSTALL_PORT=0', '/usr/bin/dpkg', '-i', artifact]);
  assert.equal(ctl('show', 'rele.service', '--property=User', '--value').stdout.trim(), owner);
  assert.equal(ctl('is-enabled', 'rele.service').stdout.trim(), 'enabled');
  assert.ok(ctl('show', 'rele.service', '--property=Environment', '--value').stdout.includes('PATH=/opt/rele/runtime:'), 'npm-installed Codex must be able to resolve bundled Node even when no system Node exists.');
  assert.equal(ctl('is-enabled', 'rele-codex.timer').stdout.trim(), 'enabled');
  assert.equal(ctl('show', 'rele-codex.service', '--property=User', '--value').stdout.trim(), owner);
  assert.equal(ctl('show', 'rele-codex.service', '--property=KillMode', '--value').stdout.trim(), 'process');
  assert.ok(ctl('show', 'rele.service', '--property=Environment', '--value').stdout.includes('RELE_CODEX_DAEMON_EXTERNAL=1'));
  const installed = await healthy();
  const sharedPid = await sharedBackendPid(codexFixture);
  const backendCgroup = await readFile(`/proc/${sharedPid}/cgroup`, 'utf8');
  assert.ok(backendCgroup.includes('rele-codex.service'), 'Native daemon must start in its independent sidecar cgroup.');
  assert.ok(!backendCgroup.includes('/rele.service'), 'Native daemon must not belong to the Rele gateway cgroup.');
  assert.ok(existsSync('/usr/bin/rele-codex'));
  const store = new Store(path.join(config.directory, 'rele.sqlite'));
  try { store.setMeta('installer:preserve', 'Bindings and delivery data survive package changes.'); } finally { store.close(); }
  assert.equal(run('/usr/bin/rele', ['token']).stdout.trim(), config.panelToken);
  const link = new URL(run('/usr/bin/rele', ['open', '--print-url']).stdout.trim());
  assert.equal(link.origin, installed.address);
  assert.ok(link.hash.startsWith('#rele-launch='));
  assert.ok(!link.href.includes(config.panelToken));
  report.passed.push('install, same-user service, autostart, health, one-time panel link');
  sudo(['/usr/bin/rele', 'service', 'restart']);
  const restarted = await healthy(installed.pid);
  await sharedBackendPid(codexFixture, sharedPid);
  preserved();
  report.passed.push('restart and durable data');
  sudo(['/usr/bin/dpkg', '-i', artifact]);
  await healthy(restarted.pid);
  await sharedBackendPid(codexFixture, sharedPid);
  preserved();
  assert.equal(run('/usr/bin/rele', ['token']).stdout.trim(), config.panelToken);
  const backups = await readdir(path.join(config.directory, 'backups'));
  assert.ok(backups.length > 0, 'An upgrade must back up the previous data before replacement.');
  const backup = new Store(path.join(config.directory, 'backups', backups.at(-1), 'rele.sqlite'));
  try { assert.equal(backup.getMeta('installer:preserve'), 'Bindings and delivery data survive package changes.'); } finally { backup.close(); }
  report.passed.push('upgrade, pre-upgrade SQLite backup, preserved panel key, native shared daemon PID outside Rele cgroup survives restart and upgrade');
  const settings = JSON.parse(await readFile('/etc/rele/service.json', 'utf8'));
  const goodSettings = path.join(work, 'service-good.json');
  const missingOwner = path.join(work, 'service-missing-owner.json');
  await writeFile(goodSettings, JSON.stringify(settings));
  await writeFile(missingOwner, JSON.stringify({ ...settings, user: 'rele-ci-owner-no-longer-exists' }));
  sudo(['/usr/bin/install', '-m', '644', missingOwner, '/etc/rele/service.json']);
  sudo(['/usr/bin/dpkg', '--remove', 'rele']);
  assert.ok(!existsSync('/usr/bin/rele'));
  assert.notEqual(run('/usr/bin/systemctl', ['is-active', 'rele.service'], true).status, 0);
  preserved();
  await sharedBackendPid(codexFixture, sharedPid);
  assert.notEqual(run('/usr/bin/systemctl', ['is-active', 'rele-codex.timer'], true).status, 0);
  assert.ok(existsSync(path.join(config.directory, 'config.json')));
  report.passed.push('uninstall removes application and service, preserves user data');
  sudo(['/usr/bin/install', '-m', '644', goodSettings, '/etc/rele/service.json']);
  sudo(['/usr/bin/dpkg', '-i', artifact]);
  await healthy();
  preserved();
  assert.equal(run('/usr/bin/rele', ['token']).stdout.trim(), config.panelToken);
  const badSettings = path.join(work, 'service-damaged.json');
  await writeFile(badSettings, '{damaged-json');
  sudo(['/usr/bin/install', '-m', '644', badSettings, '/etc/rele/service.json']);
  sudo(['/usr/bin/dpkg', '--purge', 'rele']);
  assert.ok(!existsSync('/etc/rele/service.json'));
  assert.ok(!existsSync('/etc/systemd/system/rele.service.d/rele-user.conf'));
  assert.ok(!existsSync('/etc/systemd/system/rele-codex.service.d/rele-user.conf'));
  await sharedBackendPid(codexFixture, sharedPid);
  preserved();
  report.passed.push('reinstall resumes saved configuration; remove/purge work with missing owner or damaged service settings and retain user data');
  await writeFile(path.join(root, 'installer-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Debian installer verified: install, restart, upgrade, backup, remove, reinstall, purge.');
} catch (error) {
  console.error(run('/usr/bin/journalctl', ['-u', 'rele', '--no-pager', '-n', '60'], true).stdout);
  throw error;
} finally {
  run('/usr/bin/sudo', ['-n', '/usr/bin/dpkg', '--purge', 'rele'], true);
  stopInstallerCodex(codexFixture);
  await removeInstallerFixture(work);
}
