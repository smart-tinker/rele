import { readFile, writeFile, mkdir, rm, copyFile, chmod, stat, realpath, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { ConfigStore, defaultDataDirectory, type AppConfig } from './config.js';
import { Store } from './store.js';
import { CodexClient } from './codex.js';
import { Engine } from './engine.js';
import { SlackActivity } from './slack-activity.js';
import { createApp } from './app.js';
import { TelegramChannel } from './channels/telegram.js';
import { SlackChannel } from './channels/slack.js';
import type { ChannelCallbacks } from './channels/common.js';
import { instanceDiagnostics, openPanel, serverStatus, stopServer } from './lifecycle.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const version = (JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
const command = process.argv[2] ?? 'serve';

async function main(): Promise<void> {
  if (['--version', 'version'].includes(command)) { process.stdout.write(`${version}\n`); return; }
  if (['--help', 'help'].includes(command)) {
    process.stdout.write('Rele — локальный gateway Codex\n\nserve (по умолчанию)  запустить на 127.0.0.1\nopen [--print-url]   открыть панель работающего Rele\nstatus [--wait]      проверить готовность своего Rele\nstop                 штатно остановить свой Rele\ntoken                показать ключ локальной панели\nbackup [каталог]     создать снимок базы и настроек\ndiagnostics          показать состояние без секретов\n\nRELE_DATA_DIR — каталог данных; RELE_PORT — локальный порт (по умолчанию 3210).\n'); return;
  }
  if (!['serve', 'open', 'status', 'stop', 'token', 'backup', 'diagnostics'].includes(command)) throw new Error('Неизвестная команда. Используйте --help.');
  if (command === 'diagnostics') {
    const instance = await instanceDiagnostics(defaultDataDirectory(), version);
    process.stdout.write(JSON.stringify({ version, platform: process.platform, arch: process.arch, node: process.version, instance, desktopVerified: false }, null, 2) + '\n');
    return;
  }
  const config = new ConfigStore(defaultDataDirectory());
  await config.load();
  if (command === 'token') { process.stdout.write(`${config.panelToken}\n`); return; }
  if (command === 'open') { await openPanel(config, process.argv.includes('--print-url')); return; }
  if (command === 'stop') { await stopServer(config); return; }
  if (command === 'status') { await serverStatus(config, process.argv.includes('--wait')); return; }
  const database = path.join(config.directory, 'rele.sqlite');
  if (command === 'backup') {
    const destination = process.argv[3] ? path.resolve(process.argv[3]) : path.join(config.directory, 'backups', new Date().toISOString().replace(/[:.]/gu, '-'));
    if (await stat(destination).catch(() => null)) throw new Error('Каталог резервной копии уже существует. Выберите новый каталог.');
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const store = new Store(database);
    try {
      await store.backup(path.join(destination, 'rele.sqlite'));
      await copyFile(path.join(config.directory, 'config.json'), path.join(destination, 'config.json'));
      await chmod(path.join(destination, 'rele.sqlite'), 0o600);
      await chmod(path.join(destination, 'config.json'), 0o600);
      await writeFile(path.join(destination, 'backup.json'), JSON.stringify({ version, createdAt: new Date().toISOString(), platform: process.platform, note: 'Stop Rele before restore. DPAPI secrets require the same Windows user and machine.' }, null, 2), { mode: 0o600 });
    } finally { store.close(); }
    process.stdout.write(`Резервная копия: ${destination}\n`); return;
  }

  const port = Number(process.env.RELE_PORT ?? 3210);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('RELE_PORT должен быть от 0 до 65535.');
  // The OS owns this socket lock; it is released even after SIGKILL or a power loss.
  // Its name is local to this data directory and exposes no protocol or credentials.
  const { createHash } = await import('node:crypto');
  const lockName = createHash('sha256').update(await realpath(config.directory)).digest('hex').slice(0, 24);
  const lockAddress = process.platform === 'win32' ? `\\\\.\\pipe\\rele-${lockName}` : `\0rele-${lockName}`;
  const lock = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => { lock.once('error', () => reject(new Error('Rele уже запущен с этим каталогом данных.'))); lock.listen(lockAddress, resolve); });
  let store: Store;
  try { store = new Store(database); } catch (error) { lock.close(); throw error; }
  const temporaryRoot = path.join(config.directory, 'temp');
  try { await mkdir(temporaryRoot, { recursive: true, mode: 0o700 }); } catch (error) { store.close(); lock.close(); throw error; }
  // A previous hard stop cannot run the worker's finally block. Only clean our
  // own temporary directories after taking the single-instance lock.
  for (const entry of await readdir(temporaryRoot, { withFileTypes: true })) if (entry.isDirectory() && entry.name.startsWith('voice-')) {
    await rm(path.join(temporaryRoot, entry.name), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {
      process.stderr.write('Rele: временный аудиофайл занят; очистка будет повторена при следующем запуске.\n');
    });
  }
  let codex = new CodexClient(config.config.codex);
  const engine = new Engine(store, codex, { config: () => config.config, temporaryRoot, redact: value => config.redact(value) });
  const activity = new SlackActivity(() => store.activeRequests(), async (origin, status) => {
    const channel = engine.channels.slack;
    if (!channel?.state.connected || !channel.setThreadStatus) throw new Error('Slack отключён; индикатор будет обновлён после подключения.');
    await channel.setThreadStatus(origin, status);
  }, error => { process.stderr.write(`Rele Slack: ${config.redact(error)}\n`); });
  engine.on('change', () => activity.refresh());
  engine.on('delivered', delivery => { if (delivery.origin.platform === 'slack') activity.refresh(true); });
  let shuttingDown = false;
  let app: ReturnType<typeof createApp>;

  function attachChannels(): void {
    const callbacks: ChannelCallbacks = {
      message: message => engine.receive(message),
      endpoint: endpoint => { store.upsertEndpoint(endpoint); },
      action: action => engine.action(action), status: () => { engine.channelStatus(); activity.refresh(true); },
    };
    const next = config.config;
    engine.channels = {
      ...(next.telegram.enabled && next.telegram.token ? { telegram: new TelegramChannel(next.telegram.token, callbacks, { get: () => Number(store.getMeta(`telegram.offset:${next.telegram.token!.split(':')[0]}`) ?? 0), set: offset => store.setMeta(`telegram.offset:${next.telegram.token!.split(':')[0]}`, String(offset)) }, { knownEndpoints: store.listEndpoints() }) } : {}),
      ...(next.slack.enabled && next.slack.botToken && next.slack.appToken ? { slack: new SlackChannel(next.slack.botToken, next.slack.appToken, callbacks, { knownEndpoints: store.listEndpoints() }) } : {}),
    };
    for (const channel of Object.values(engine.channels)) void channel.start().catch(() => {});
  }
  async function configure(next: AppConfig): Promise<void> {
    if (shuttingDown) throw new Error('Rele завершает работу.');
    engine.suspend(true);
    try {
      const codexChanged = JSON.stringify(next.codex) !== JSON.stringify(config.config.codex);
      if (codexChanged && store.activeRequests().some(request => request.status !== 'queued')) throw new Error('Завершите или отмените активные запросы перед сменой подключения Codex.');
      // Voice-only changes do not reconnect transports or expire approvals.
      const channelsChanged = JSON.stringify([next.telegram, next.slack]) !== JSON.stringify([config.config.telegram, config.config.slack]);
      await config.save(next);
      if (channelsChanged) {
        await activity.stop();
        await Promise.allSettled(Object.values(engine.channels).map(channel => channel.stop()));
      }
      if (codexChanged) {
        const old = codex;
        await old.close();
        codex = new CodexClient(next.codex);
        engine.replaceCodex(codex);
        void codex.connect().catch(() => {});
      }
      if (channelsChanged) { attachChannels(); activity.start(); }
    } finally { engine.suspend(false); }
  }
  app = createApp({ store, config, engine, codex: () => codex, configure, version, webDirectory: path.join(root, 'dist', 'web'), shutdown });
  const instanceFile = path.join(config.directory, 'instance.json');
  const temporaryInstance = path.join(config.directory, `instance-${process.pid}.tmp`);
  try {
    const address = await app.listen({ host: '127.0.0.1', port });
    await writeFile(temporaryInstance, JSON.stringify({ pid: process.pid, address, version }), { mode: 0o600 });
    await rename(temporaryInstance, instanceFile);
    engine.start(); attachChannels(); activity.start();
    void codex.connect().catch(() => {});
    process.stdout.write(`Rele: ${address}/\nОткрыть панель: rele open. Ключ панели: rele token или npm start -- token.\n`);
  } catch (error) { await app.close(); await activity.stop(); await engine.stop(); await codex.close(); store.close(); await rm(temporaryInstance, { force: true }); lock.close(); throw error; }
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    engine.suspend(true);
    await app.close();
    await activity.stop();
    await Promise.allSettled(Object.values(engine.channels).map(channel => channel.stop()));
    await engine.stop(); await codex.close(); store.close();
    // Keep the data-directory lock until our marker is removed, so another
    // starting instance cannot have its fresh marker removed by this shutdown.
    await rm(instanceFile, { force: true });
    lock.close();
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

main().catch(error => { process.stderr.write(`Rele: ${error instanceof Error ? error.message : 'Ошибка запуска.'}\n`); process.exitCode = 1; });
