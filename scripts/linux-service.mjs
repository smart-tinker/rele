import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = '/opt/rele';
const configuration = '/etc/rele/service.json';
const restartFile = '/var/lib/rele/restart.json';
const dropIn = '/etc/systemd/system/rele.service.d/rele-user.conf';
const sharedDropIn = '/etc/systemd/system/rele-codex.service.d/rele-user.conf';
const [command = 'open', ...arguments_] = process.argv.slice(2);
const isRoot = process.getuid?.() === 0;

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 60_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${path.basename(program)} завершился с кодом ${result.status}. ${result.stderr?.trim() || ''}`);
  return result;
}
function requireRoot() { if (!isRoot) throw new Error('Для управления системной службой используйте sudo rele service <команда>.'); }
function systemd() { if (!existsSync('/run/systemd/system')) throw new Error('Пакет Rele требует Ubuntu Server с работающим systemd.'); }
function ctl(args, allowFailure = false) { return run('/usr/bin/systemctl', args, { allowFailure }); }
function account(user) {
  if (typeof user !== 'string' || !/^[a-z_][a-z0-9_.-]*\$?$/iu.test(user)) throw new Error('Укажите существующего владельца Codex: sudo rele service install --user <имя>.');
  const record = run('/usr/bin/getent', ['passwd', user]).stdout.trim().split(':');
  const uid = Number(record[2]);
  if (record.length !== 7 || record[0] !== user || !Number.isInteger(uid) || uid <= 0 || !path.isAbsolute(record[5]) || record[5] === '/') throw new Error('Служба Rele должна работать под обычным владельцем Codex, а не root.');
  return { user, uid, directory: record[5] };
}
function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/u.test(value) || value.length > 4096) throw new Error(`Нужен абсолютный путь: ${label}.`);
  return path.resolve(value);
}
function validate(value) {
  const owner = account(value.user);
  const port = Number(value.port ?? 3210);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Порт Rele должен быть от 0 до 65535.');
  return { user: owner.user, dataDirectory: absolute(value.dataDirectory ?? path.join(owner.directory, '.local/state/rele'), 'каталог данных'),
    codexHome: absolute(value.codexHome ?? path.join(owner.directory, '.codex'), 'профиль Codex'), port };
}
async function saved() {
  try { return validate(JSON.parse(await readFile(configuration, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function environment(config) {
  const owner = account(config.user);
  return { RELE_DATA_DIR: config.dataDirectory, CODEX_HOME: config.codexHome, RELE_PORT: String(config.port), RELE_CODEX_DAEMON_EXTERNAL: '1',
    PATH: `${root}/runtime:${owner.directory}/.local/bin:${owner.directory}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin` };
}
function asOwner(config, args, options = {}, script = 'main.js') {
  const owner = account(config.user);
  const vars = environment(config);
  if (isRoot) return run('/usr/sbin/runuser', ['-u', owner.user, '--', '/usr/bin/env', ...Object.entries(vars).map(([key, value]) => `${key}=${value}`),
    path.join(root, 'runtime/node'), path.join(root, 'dist/server', script), ...args], options);
  if (process.getuid() !== owner.uid) throw new Error(`Rele установлен для ${owner.user}. Выполните команду под этой учётной записью.`);
  return run(path.join(root, 'runtime/node'), [path.join(root, 'dist/server', script), ...args], { ...options, env: { ...process.env, ...vars } });
}
async function ready(config) {
  const deadline = Date.now() + 15_000;
  do {
    try {
      const marker = JSON.parse(await readFile(path.join(config.dataDirectory, 'instance.json'), 'utf8'));
      const pid = Number(ctl(['show', 'rele.service', '--property=MainPID', '--value']).stdout.trim());
      const address = new URL(marker.address);
      if (pid > 0 && marker.pid === pid && address.protocol === 'http:' && address.hostname === '127.0.0.1' &&
          !address.username && !address.password && address.pathname === '/' && !address.search && !address.hash) {
        const response = await fetch(new URL('/api/health', address), { redirect: 'error', signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).ok === true) return;
      }
    } catch { /* The listener and instance marker appear shortly after systemd starts Node. */ }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error('Служба Rele не готова. Проверьте: sudo journalctl -u rele -n 50. Если работает переносимая версия, завершите её (Ctrl+C) и выполните sudo rele service restart.');
}
async function stopLegacyUserService(config) {
  const owner = account(config.user);
  const file = path.join(owner.directory, '.config/systemd/user/rele.service');
  const source = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  if (!source.includes('Description=Rele local Codex gateway') || !source.includes('dist/server/main.js')) return;
  run('/usr/sbin/runuser', ['-u', owner.user, '--', '/usr/bin/env', `XDG_RUNTIME_DIR=/run/user/${owner.uid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${owner.uid}/bus`, '/usr/bin/systemctl', '--user',
    ...(existsSync(`/run/user/${owner.uid}/bus`) ? ['disable', '--now'] : ['--no-reload', 'disable']), 'rele.service']);
}
const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
async function configure(config, restart = null) {
  requireRoot(); systemd();
  await stopLegacyUserService(config);
  await mkdir(path.dirname(configuration), { recursive: true, mode: 0o755 });
  await mkdir(path.dirname(dropIn), { recursive: true, mode: 0o755 });
  await mkdir(path.dirname(sharedDropIn), { recursive: true, mode: 0o755 });
  await writeFile(configuration, JSON.stringify(config, null, 2) + '\n', { mode: 0o644 });
  const variables = Object.entries(environment(config)).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`).join('\n');
  for (const file of [dropIn, sharedDropIn]) await writeFile(file, `[Service]\nUser=${config.user}\n${variables}\n`, { mode: 0o644 });
  ctl(['daemon-reload']);
  if (restart?.sharedEnabled ?? restart?.enabled ?? true) ctl(['enable', 'rele-codex.timer']);
  if (restart?.sharedActive ?? restart?.active ?? true) ctl(['start', 'rele-codex.timer']);
  if (!restart || restart.enabled) ctl(['enable', 'rele.service']);
  if (!restart || restart.active) { ctl(['restart', 'rele.service']); await ready(config); }
  await rm(restartFile, { force: true });
  console.log(`Rele установлен для ${config.user}. Данные: ${config.dataDirectory}\nПанель: rele open --print-url\nСостояние: rele service status; перезапуск: sudo rele service restart\nУдаление: sudo apt remove rele. Данные сохраняются.`);
}
function options(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--user', '--data-dir', '--codex-home', '--port'].includes(args[i]) || !args[i + 1]) throw new Error('Используйте: sudo rele service install --user <владелец Codex> [--data-dir <путь>] [--codex-home <путь>] [--port <порт>].');
    if (Object.hasOwn(values, args[i])) throw new Error('Параметр установки указан дважды.');
    values[args[i]] = args[i + 1];
  }
  return values;
}
async function main() {
  if (process.platform !== 'linux') throw new Error('Эта команда предназначена для Ubuntu Server.');
  // Removal must still work when an administrator has deleted the old owner
  // or the saved service configuration is damaged. Stopping this fixed unit
  // needs neither user credentials nor access to the user's data.
  if (command === '--package-remove') {
    requireRoot();
    if (existsSync('/run/systemd/system')) {
      ctl(['disable', '--now', 'rele-codex.timer', 'rele.service']);
      ctl(['stop', 'rele-codex.service']); // Only the short starter; the native daemon remains alive.
    }
    await rm(restartFile, { force: true }); return;
  }
  const config = await saved();
  if (command === '--package-configure') {
    requireRoot(); systemd();
    let next = config;
    if (!next && process.env.SUDO_USER && process.env.SUDO_USER !== 'root') next = validate({ user: process.env.SUDO_USER,
      dataDirectory: process.env.RELE_INSTALL_DATA_DIR, codexHome: process.env.RELE_INSTALL_CODEX_HOME, port: process.env.RELE_INSTALL_PORT });
    if (!next) { ctl(['daemon-reload']); console.log('Программа Rele установлена. Назначьте владельца Codex и запустите службу: sudo rele service install --user <имя>.'); return; }
    const restart = await readFile(restartFile, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    await configure(next, restart); return;
  }
  if (command === '--package-before-upgrade') {
    requireRoot(); systemd();
    if (!config) return;
    await mkdir(path.dirname(restartFile), { recursive: true, mode: 0o755 });
    await writeFile(restartFile, JSON.stringify({ enabled: ctl(['is-enabled', '--quiet', 'rele.service'], true).status === 0,
      active: ctl(['is-active', '--quiet', 'rele.service'], true).status === 0,
      sharedEnabled: ctl(['is-enabled', '--quiet', 'rele-codex.timer'], true).status === 0,
      sharedActive: ctl(['is-active', '--quiet', 'rele-codex.timer'], true).status === 0 }), { mode: 0o600 });
    ctl(['stop', 'rele-codex.timer', 'rele-codex.service', 'rele.service']);
    if (existsSync(path.join(config.dataDirectory, 'config.json'))) asOwner(config, ['backup'], { stdio: 'inherit' });
    return;
  }
  if (command.startsWith('--package-')) throw new Error('Неизвестная команда пакета.');
  if (command === 'service') {
    const [action = 'status', ...args] = arguments_;
    if (action === 'install') {
      requireRoot(); const values = options(args);
      const user = values['--user'] ?? config?.user ?? process.env.SUDO_USER;
      if (config && user !== config.user) throw new Error(`Служба уже принадлежит ${config.user}. Сначала удалите пакет с purge; сохранённые пользовательские данные останутся на месте.`);
      const next = validate({ ...config, user, ...(values['--data-dir'] ? { dataDirectory: values['--data-dir'] } : {}),
        ...(values['--codex-home'] ? { codexHome: values['--codex-home'] } : {}), ...(values['--port'] ? { port: values['--port'] } : {}) });
      if (config) { ctl(['stop', 'rele-codex.timer', 'rele-codex.service', 'rele.service']); if (existsSync(path.join(config.dataDirectory, 'config.json'))) asOwner(config, ['backup'], { stdio: 'inherit' }); }
      await configure(next); return;
    }
    if (!['start', 'stop', 'restart', 'status'].includes(action) || args.length) throw new Error('Команды службы: install, start, stop, restart, status.');
    systemd(); if (action !== 'status') requireRoot();
    if (!config) throw new Error('Сначала назначьте владельца: sudo rele service install --user <имя>.');
    const result = run('/usr/bin/systemctl', [action, 'rele.service', '--no-pager'], { stdio: 'inherit', allowFailure: action === 'status' });
    if (['start', 'restart'].includes(action)) await ready(config);
    process.exitCode = result.status; return;
  }
  if (command === 'codex') {
    if (config) asOwner(config, ['--rele-cli', ...arguments_], { stdio: 'inherit', timeout: 0 }, 'codex-cli.js');
    else {
      if (isRoot) throw new Error('Запустите общий Codex под назначенным владельцем профиля.');
      run(path.join(root, 'runtime/node'), [path.join(root, 'dist/server/codex-cli.js'), '--rele-cli', ...arguments_], { stdio: 'inherit', timeout: 0 });
    }
    return;
  }
  if (config) { asOwner(config, [command, ...arguments_], { stdio: 'inherit' }); return; }
  if (isRoot && !['help', '--help', 'version', '--version'].includes(command)) throw new Error('Назначьте обычного владельца Codex: sudo rele service install --user <имя>.');
  run(path.join(root, 'runtime/node'), [path.join(root, 'dist/server/main.js'), command, ...arguments_], { stdio: 'inherit' });
}
main().catch(error => { console.error(`Rele: ${error.message}`); process.exitCode = 1; });
