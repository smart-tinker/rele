import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, chmod, rm, link } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AutoLinkRule, CodexConnectionTarget, PublicConfig } from '../shared/types.js';

export interface AppConfig {
  codex: CodexConnectionTarget & { token?: string };
  telegram: { enabled: boolean; token?: string };
  slack: { enabled: boolean; botToken?: string; appToken?: string };
  voice: PublicConfig['voice'];
  autoLinkRules: AutoLinkRule[];
}

export const defaultConfig: AppConfig = {
  codex: { transport: 'shared', executable: 'codex', endpoint: '' },
  autoLinkRules: [],
  telegram: { enabled: false },
  slack: { enabled: false },
  voice: { enabled: false, python: process.platform === 'win32' ? 'python' : 'python3', model: '', language: 'ru', device: 'cpu' },
};

export function defaultDataDirectory(): string {
  return process.env.RELE_DATA_DIR ? path.resolve(process.env.RELE_DATA_DIR) : process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Rele')
    : path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'rele');
}

export function isLocalEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return ['ws:', 'wss:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.hash && !url.search;
  } catch { return false; }
}

/** An app-server proxy takes a local control socket path, never a WebSocket URL. */
export function isLocalSocketPath(value: string): boolean {
  return !!value && value.length <= 4096 && !/[\x00-\x1f]/u.test(value)
    && (/^\/(?!\/)/u.test(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\\.\\pipe\\[^\\]+/iu.test(value));
}

export function isLocalCodexHome(value: string, platform: NodeJS.Platform = process.platform): boolean {
  return !!value && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value)
    && (platform === 'win32' ? /^[A-Za-z]:[\\/]/u.test(value) : /^\/(?!\/)/u.test(value));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ожидается объект настроек.');
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b-\x1f]/u.test(value)) throw new Error(`Некорректное поле ${name}.`);
  return value.trim();
}

/** Workspaces are selected on the Codex host; accept either local absolute syntax here. */
export function isLocalWorkspace(value: string): boolean {
  return !!value && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value)
    && (/^\/(?!\/)/u.test(value) || /^[A-Za-z]:[\\/]/u.test(value));
}

function autoLinkRules(value: unknown): AutoLinkRule[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Допустимо не более 100 правил автосоздания.');
  const ids = new Set<string>();
  const scopes = new Set<string>();
  return value.map(item => {
    const rule = record(item);
    if (Object.keys(rule).some(key => !['id', 'enabled', 'platform', 'accountId', 'chatId', 'cwd', 'allowedSenderIds', 'requireMention', 'allowAllSenders'].includes(key))) throw new Error('Неизвестное поле правила автосоздания.');
    const identifier = (key: string) => {
      const result = text(rule[key], key, 200);
      if (!result || /[\x00-\x1f\x7f]/u.test(result)) throw new Error('Некорректный идентификатор правила автосоздания.');
      return result;
    };
    const id = identifier('id');
    if (ids.has(id)) throw new Error('Идентификаторы правил должны быть уникальны.');
    ids.add(id);
    if (rule.platform !== 'slack' && rule.platform !== 'telegram') throw new Error('Неизвестный мессенджер правила.');
    if (typeof rule.enabled !== 'boolean' || (rule.requireMention !== undefined && typeof rule.requireMention !== 'boolean') || (rule.allowAllSenders !== undefined && typeof rule.allowAllSenders !== 'boolean')) throw new Error('Состояние правила и упоминания должно быть логическим.');
    const accountId = identifier('accountId');
    const chatId = identifier('chatId');
    const scope = JSON.stringify([rule.platform, accountId, chatId]);
    if (scopes.has(scope)) throw new Error('Для чата допустимо только одно правило автосоздания.');
    scopes.add(scope);
    const cwd = text(rule.cwd, 'рабочая папка');
    if (!isLocalWorkspace(cwd)) throw new Error('Рабочая папка должна быть абсолютным локальным путём.');
    const group = rule.platform === 'slack' ? /^[CG][A-Z0-9]+$/u.test(chatId) : /^-\d+$/u.test(chatId);
    if (rule.allowAllSenders && !group) throw new Error('Доступ всех участников допустим только для группы или канала. Для личных чатов выберите людей.');
    const senders = rule.allowedSenderIds;
    if (!Array.isArray(senders) || (!rule.allowAllSenders && !senders.length) || senders.length > 100 || senders.some(sender => typeof sender !== 'string' || !sender.trim() || sender.length > 200 || /[\x00-\x1f\x7f]/u.test(sender))) throw new Error('Разрешите от 1 до 100 отправителей правила.');
    return { id, enabled: rule.enabled, platform: rule.platform, accountId, chatId, cwd, allowedSenderIds: [...new Set(senders as string[])], requireMention: rule.requireMention ?? true, ...(rule.allowAllSenders !== undefined ? { allowAllSenders: rule.allowAllSenders } : {}) };
  });
}

export function mergeConfig(current: AppConfig, input: unknown): AppConfig {
  const patch = record(input);
  const next = structuredClone(current);
  next.autoLinkRules = autoLinkRules('autoLinkRules' in patch ? patch.autoLinkRules : current.autoLinkRules ?? []);
  for (const key of Object.keys(patch)) if (!['codex', 'telegram', 'slack', 'voice', 'autoLinkRules'].includes(key)) throw new Error('Неизвестный раздел настроек.');
  for (const section of ['codex', 'telegram', 'slack', 'voice'] as const) {
    if (!(section in patch)) continue;
    const changes = record(patch[section]);
    const allowed = section === 'codex' ? ['transport', 'executable', 'endpoint', 'codexHome', 'token'] : section === 'telegram' ? ['enabled', 'token'] : section === 'slack' ? ['enabled', 'botToken', 'appToken'] : ['enabled', 'python', 'model', 'language', 'device'];
    for (const [key, value] of Object.entries(changes)) {
      if (!allowed.includes(key)) throw new Error(`Неизвестное поле ${section}.`);
      if (section === 'codex' && key === 'codexHome') {
        if (value !== undefined && typeof value !== 'string') throw new Error('Некорректное поле codexHome.');
        if (typeof value === 'string' && /[\x00-\x1f\x7f]/u.test(value)) throw new Error('Путь профиля Codex не должен содержать управляющие символы.');
        const cleaned = value === undefined ? '' : text(value, key);
        if (cleaned) next.codex.codexHome = cleaned;
        else delete next.codex.codexHome;
      } else if (key === 'enabled') {
        if (typeof value !== 'boolean') throw new Error('enabled должен быть логическим значением.');
        (next[section] as unknown as Record<string, unknown>)[key] = value;
      } else {
        const cleaned = text(value, key);
        // Empty password fields preserve a saved secret; disabling a connector stops its use.
        if (['token', 'botToken', 'appToken'].includes(key) && !cleaned) continue;
        (next[section] as unknown as Record<string, unknown>)[key] = cleaned;
      }
    }
  }
  if (!['shared', 'managed', 'proxy', 'websocket'].includes(next.codex.transport)) throw new Error('Неизвестный транспорт Codex.');
  if (!next.codex.executable || /[\r\n]/u.test(next.codex.executable)) throw new Error('Укажите путь к Codex CLI.');
  if (next.codex.codexHome && !isLocalCodexHome(next.codex.codexHome)) throw new Error('Профиль Codex должен быть абсолютным локальным путём без сетевых каталогов.');
  if (['shared', 'managed'].includes(next.codex.transport) && current.codex.transport !== next.codex.transport && next.codex.endpoint === current.codex.endpoint) next.codex.endpoint = '';
  if (['shared', 'managed'].includes(next.codex.transport) && next.codex.endpoint) throw new Error('В автоматическом режиме не нужен адрес app-server. Оставьте endpoint пустым.');
  // Older panels submit the now-hidden WebSocket field when switching to proxy.
  if (next.codex.transport === 'proxy' && current.codex.transport === 'websocket' && next.codex.endpoint === current.codex.endpoint) next.codex.endpoint = '';
  if (next.codex.transport === 'proxy' && next.codex.endpoint && !isLocalSocketPath(next.codex.endpoint)) throw new Error('Для локального proxy нужен абсолютный путь к сокету, а не WebSocket URL. Для автоматического подключения оставьте адрес пустым.');
  if (next.codex.transport === 'websocket' && !isLocalEndpoint(next.codex.endpoint)) throw new Error('Codex должен использовать локальный ws:// или wss:// адрес без параметров и пароля.');
  if (next.telegram.token && !/^\d+:[A-Za-z0-9_-]{20,}$/u.test(next.telegram.token)) throw new Error('Некорректный токен Telegram.');
  if (next.telegram.enabled && !next.telegram.token) throw new Error('Для Telegram нужен токен бота.');
  if (next.slack.botToken && !/^xoxb-[A-Za-z0-9-]+$/u.test(next.slack.botToken)) throw new Error('Нужен bot token Slack с префиксом xoxb-.');
  if (next.slack.appToken && !/^xapp-[A-Za-z0-9-]+$/u.test(next.slack.appToken)) throw new Error('Нужен app token Slack с префиксом xapp-.');
  if (next.slack.enabled && (!next.slack.botToken || !next.slack.appToken)) throw new Error('Для Slack нужны bot token и app token.');
  if (!['cpu', 'cuda'].includes(next.voice.device)) throw new Error('Неизвестное устройство распознавания.');
  if (!/^[a-z]{0,3}$/u.test(next.voice.language)) throw new Error('Код языка должен содержать до трёх строчных латинских букв.');
  if (next.voice.enabled && (!next.voice.python || !next.voice.model || !path.isAbsolute(next.voice.model))) throw new Error('Для голосовых укажите Python и абсолютный путь к локальной модели.');
  return next;
}

export function publicConfig(config: AppConfig): PublicConfig {
  return {
    codex: { transport: config.codex.transport, executable: config.codex.executable, endpoint: config.codex.endpoint, ...(config.codex.codexHome ? { codexHome: config.codex.codexHome } : {}), tokenConfigured: !!config.codex.token },
    telegram: { enabled: config.telegram.enabled, tokenConfigured: !!config.telegram.token },
    slack: { enabled: config.slack.enabled, botTokenConfigured: !!config.slack.botToken, appTokenConfigured: !!config.slack.appToken },
    voice: { ...config.voice },
    autoLinkRules: structuredClone(config.autoLinkRules ?? []),
  };
}

async function protectWindows(input: string, decrypt: boolean): Promise<string> {
  const script = 'Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); ' + (decrypt
    ? '$b=[Convert]::FromBase64String($s); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))'
    : '$b=[Text.Encoding]::UTF8.GetBytes($s); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Хранилище Windows не ответило.')); }, 15_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('Не удалось открыть защищённое хранилище Windows.')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error('Секреты Windows доступны только исходному пользователю и машине.')); });
    child.stdin.on('error', () => {});
    child.stdin.end(input, 'utf8');
  });
}

async function atomicWrite(file: string, value: string, exclusive = false): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try { await writeFile(temporary, value, { mode: 0o600, flag: 'wx', flush: true }); if (exclusive) await link(temporary, file); else await rename(temporary, file); await chmod(file, 0o600); }
  finally { await rm(temporary, { force: true }); }
}

export class ConfigStore {
  config: AppConfig = structuredClone(defaultConfig);
  panelToken = '';
  constructor(readonly directory: string) {}
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const file = path.join(this.directory, 'config.json');
    try {
      const envelope = JSON.parse(await readFile(file, 'utf8')) as { version: number; encoding: string; value: string };
      if (envelope.version !== 1 || !['dpapi', 'plain'].includes(envelope.encoding)) throw new Error('Версия конфигурации не поддерживается.');
      if (process.platform === 'win32' && envelope.encoding !== 'dpapi') throw new Error('Импорт открытых секретов на Windows требует повторной настройки.');
      const decoded = envelope.encoding === 'dpapi' ? await protectWindows(envelope.value, true) : envelope.value;
      const saved = JSON.parse(decoded) as { config: AppConfig; panelToken: string };
      // rc.2 could persist the hidden WebSocket field after a switch to proxy.
      // Repair only that invalid combination in memory; keep valid explicit targets.
      const legacyCodex = saved?.config?.codex;
      if (legacyCodex?.transport === 'proxy' && typeof legacyCodex.endpoint === 'string' && /^wss?:\/\//iu.test(legacyCodex.endpoint.trim())) legacyCodex.endpoint = '';
      this.config = mergeConfig(defaultConfig, saved.config);
      if (typeof saved.panelToken !== 'string' || !/^[a-f0-9]{64}$/u.test(saved.panelToken)) throw new Error('Некорректный ключ панели.');
      this.panelToken = saved.panelToken;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.panelToken = randomBytes(32).toString('hex');
      try { await this.save(this.config, true); }
      catch (creationError) { if ((creationError as NodeJS.ErrnoException).code === 'EEXIST') await this.load(); else throw creationError; }
    }
  }
  async save(config: AppConfig, exclusive = false): Promise<void> {
    const value = JSON.stringify({ config, panelToken: this.panelToken });
    const encoding = process.platform === 'win32' ? 'dpapi' : 'plain';
    await atomicWrite(path.join(this.directory, 'config.json'), JSON.stringify({ version: 1, encoding, value: encoding === 'dpapi' ? await protectWindows(value, false) : value }) + '\n', exclusive);
    this.config = structuredClone(config);
  }
  authorized(header: string | undefined): boolean {
    const provided = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(this.panelToken);
    return provided.length === expected.length && expected.length > 0 && timingSafeEqual(provided, expected);
  }
  redact(value: unknown): string {
    let result = value instanceof Error ? value.message : String(value);
    for (const secret of [this.panelToken, this.config.codex.token, this.config.telegram.token, this.config.slack.botToken, this.config.slack.appToken]) {
      if (secret) result = result.split(secret).join('[скрыто]');
    }
    return result.slice(0,1500);
  }
}
