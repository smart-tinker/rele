import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, rename, rm, link } from 'node:fs/promises';
import path from 'node:path';

const PLUGIN = 'rele';
const MARKETPLACE = 'rele-local';
const IDENTITY = `${PLUGIN}@${MARKETPLACE}`;
const OWNER = 'rele-channel-tools-v1';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;
interface PluginFiles { marketplacePath: string; pluginVersion: string; root: string }
interface PluginOptions { dataDirectory: string; applicationRoot: string; version: string; node?: string; codexHome: string }
interface Receipt { owner: string; profileHash: string; marketplacePath: string; fingerprint: string; pluginVersion: string; state: 'intent' | 'installed'; attemptId: string }
interface Registration { marketplaces: Array<{ name: string; path: string | null; plugins: Array<{ id: string; installed: boolean; enabled: boolean; localVersion?: string | null }> }> }
const relativeFiles = ['.agents/plugins/marketplace.json', 'rele/.codex-plugin/plugin.json', 'rele/.mcp.json', 'rele/skills/rele-messages/SKILL.md'];

async function directory(file: string): Promise<void> {
  try { await mkdir(file, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const value = await lstat(file);
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('Каталог плагина Rele занят другим объектом.');
}
async function fixedFile(file: string, content: string): Promise<void> {
  try { await writeFile(file, content, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const value = await lstat(file);
    if (!value.isFile() || value.isSymbolicLink() || await readFile(file, 'utf8') !== content) throw new Error('Файлы плагина Rele изменены извне; перезапись запрещена.');
  }
}

/** All assets live in an immutable, versioned Rele-owned directory; native config is not rewritten. */
export async function prepareRelePlugin(options: Omit<PluginOptions, 'codexHome'>): Promise<PluginFiles> {
  const node = options.node ?? process.execPath;
  const entry = path.join(options.applicationRoot, 'dist', 'server', 'main.js');
  const skill = await readFile(path.join(options.applicationRoot, 'integrations', 'rele', 'skills', 'rele-messages', 'SKILL.md'), 'utf8');
  const fingerprint = digest(JSON.stringify([options.version, node, entry, path.resolve(options.dataDirectory), skill]));
  const base = path.join(options.dataDirectory, 'codex-plugins');
  await directory(base);
  const root = path.join(base, fingerprint);
  await directory(root);
  const pluginVersion = `${options.version}+rele.${fingerprint.slice(0, 12)}`;
  const files: Record<string, string> = {
    '.agents/plugins/marketplace.json': JSON.stringify({ name: MARKETPLACE, plugins: [{ name: PLUGIN, source: { source: 'local', path: './rele' } }] }),
    'rele/.codex-plugin/plugin.json': JSON.stringify({ name: PLUGIN, version: pluginVersion, description: 'Rele messages for linked Slack and Telegram sources' }),
    'rele/.mcp.json': JSON.stringify({ mcpServers: { rele: { command: node, args: [entry, 'mcp', '--data-dir', path.resolve(options.dataDirectory)] } } }),
    'rele/skills/rele-messages/SKILL.md': skill,
  };
  for (const name of ['.agents', '.agents/plugins', 'rele', 'rele/.codex-plugin', 'rele/skills', 'rele/skills/rele-messages']) await directory(path.join(root, name));
  for (const [name, content] of Object.entries(files)) await fixedFile(path.join(root, name), content);
  await fixedFile(path.join(root, 'owned.json'), JSON.stringify({ owner: OWNER, fingerprint, files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)])) }));
  return { root, marketplacePath: path.join(root, '.agents', 'plugins', 'marketplace.json'), pluginVersion };
}

async function readReceipt(file: string, profileHash: string, dataDirectory: string): Promise<Receipt | undefined> {
  try {
    const state = await lstat(file);
    if (!state.isFile() || state.isSymbolicLink()) throw new Error();
    const value = JSON.parse(await readFile(file, 'utf8')) as Receipt;
    if (value.owner !== OWNER || value.profileHash !== profileHash || !['intent', 'installed'].includes(value.state)
      || !/^[a-f0-9]{64}$/u.test(value.fingerprint) || typeof value.attemptId !== 'string' || typeof value.pluginVersion !== 'string'
      || path.basename(path.resolve(value.marketplacePath, '../../..')) !== value.fingerprint
      || !await isOwnedMarketplace(value.marketplacePath, dataDirectory)) throw new Error();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Запись установки плагина Rele не подтверждена; перезапись запрещена.');
  }
}
async function writeReceipt(file: string, receipt: Receipt, exclusive = false): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 }); if (exclusive) await link(temporary, file); else await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
function installed(value: unknown): { marketplacePath: string | null; plugin: Registration['marketplaces'][number]['plugins'][number] } | undefined {
  const result = value as Registration;
  if (!result || !Array.isArray(result.marketplaces)) throw new Error('Codex не подтвердил поддержку плагинов Rele.');
  const matches = result.marketplaces.flatMap(market => (market.plugins ?? []).filter(plugin => plugin.id === IDENTITY && plugin.installed).map(plugin => ({ marketplacePath: market.path, plugin })));
  if (matches.length > 1) throw new Error('Обнаружено несколько плагинов с именем Rele; автоматическая замена запрещена.');
  return matches[0];
}

async function isOwnedMarketplace(value: string, dataDirectory: string): Promise<boolean> {
  const root = path.resolve(value, '../../..');
  if (path.dirname(root) !== path.resolve(dataDirectory, 'codex-plugins') || !/^[a-f0-9]{64}$/u.test(path.basename(root))
    || path.resolve(value) !== path.join(root, '.agents', 'plugins', 'marketplace.json')) return false;
  try {
    const marker = JSON.parse(await readFile(path.join(root, 'owned.json'), 'utf8')) as { owner?: string; fingerprint?: string; files?: Record<string, string> };
    if (marker.owner !== OWNER || marker.fingerprint !== path.basename(root) || !marker.files || Object.keys(marker.files).length !== relativeFiles.length) return false;
    for (const file of relativeFiles) {
      const state = await lstat(path.join(root, file));
      if (!state.isFile() || state.isSymbolicLink() || marker.files[file] !== digest(await readFile(path.join(root, file), 'utf8'))) return false;
    }
    return true;
  } catch { return false; }
}

/** Called once per connection, not from the polling loop. Preserve a disabled/foreign plugin. */
export async function registerRelePlugin(rpc: Rpc, options: PluginOptions): Promise<void> {
  if (!path.isAbsolute(options.codexHome)) throw new Error('Codex не подтвердил локальный профиль плагина Rele.');
  const files = await prepareRelePlugin(options);
  const profileHash = digest(path.resolve(options.codexHome));
  const receiptFile = path.join(options.dataDirectory, 'codex-plugins', `${profileHash}.registration.json`);
  const receipt = await readReceipt(receiptFile, profileHash, options.dataDirectory);
  // Local plugin catalog values describe the supplied marketplace, not the
  // cached installed source. Only our per-profile receipt establishes ownership.
  const query = { cwds: [files.root] };
  const current = installed(await rpc('plugin/installed', query));
  if (current) {
    if (!receipt) throw new Error('Имя плагина Rele занято установкой без собственной записи; перезапись запрещена.');
    if (!current.marketplacePath || !await isOwnedMarketplace(current.marketplacePath, options.dataDirectory)) throw new Error('Имя плагина Rele занято чужой установкой; перезапись запрещена.');
    if (!current.plugin.enabled) throw new Error('Плагин Rele отключён в Codex. Его состояние сохранено.');
    if (receipt.state === 'intent') throw new Error('Предыдущая установка плагина Rele не подтверждена. Автоматический повтор запрещён.');
    if (receipt.marketplacePath === files.marketplacePath && receipt.pluginVersion === files.pluginVersion) return;
  } else if (receipt) {
    throw new Error('Состояние плагина Rele изменилось или установка не подтверждена. Автоматический повтор запрещён.');
  }
  const next: Receipt = { owner: OWNER, profileHash, marketplacePath: files.marketplacePath, fingerprint: path.basename(files.root), pluginVersion: files.pluginVersion, state: 'intent', attemptId: randomUUID() };
  await writeReceipt(receiptFile, next, !receipt);
  await rpc('plugin/install', { marketplacePath: files.marketplacePath, pluginName: PLUGIN, installAttemptId: next.attemptId });
  // Native reload refreshes existing loaded threads. It does not select a model or alter turn policy.
  await rpc('config/mcpServer/reload', {});
  const confirmed = installed(await rpc('plugin/installed', query));
  if (!confirmed?.plugin.enabled || confirmed.marketplacePath !== files.marketplacePath || confirmed.plugin.localVersion !== files.pluginVersion) throw new Error('Codex не подтвердил включённый плагин Rele. Настройки сохранены.');
  await writeReceipt(receiptFile, { ...next, state: 'installed' });
}
