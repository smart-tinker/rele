import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CodexConnectionTarget, CodexDiscoveryIssue, CodexDiscoveryResult, CodexInstallation } from '../shared/types.js';
import { isLocalEndpoint, isLocalSocketPath } from './config.js';
import { environmentValue, fileExists, isDesktopLauncher, resolveCodexLaunch } from './codex-launch.js';

// Command lines are inspected inside this fixed script and never returned. No auth,
// history, environment, or Codex configuration files are read during discovery.
export const WINDOWS_CODEX_METADATA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$processes = @()
$packages = @()
$issues = @()
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
try {
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'")) {
    if (-not $process.ExecutablePath -or -not $process.CommandLine) { continue }
    $words = @([regex]::Matches($process.CommandLine, '"[^"]*"|[^\s]+') | ForEach-Object { $_.Value.Trim('"') })
    $index = [Array]::IndexOf($words, 'app-server')
    if ($index -lt 0 -or ($index + 1 -lt $words.Count -and $words[$index + 1] -eq 'proxy')) { continue }
    try {
      $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
      if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid) { continue }
    } catch { $issues += 'process-owner-unavailable'; continue }
    $desktop = $process.ExecutablePath -match '(?i)[\\/]resources[\\/]codex\.exe$'
    $parentId = $process.ParentProcessId
    for ($depth = 0; -not $desktop -and $parentId -gt 0 -and $depth -lt 4; $depth++) {
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId" -Property Name,ExecutablePath,ParentProcessId -ErrorAction SilentlyContinue
      if (-not $parent) { break }
      if ($parent.Name -match '^(?i:Codex|ChatGPT)\.exe$' -and $parent.ExecutablePath) {
        $parentRoot = [IO.Path]::GetDirectoryName($parent.ExecutablePath)
        $desktop = (Test-Path -LiteralPath (Join-Path $parentRoot 'resources\app.asar')) -or (Test-Path -LiteralPath (Join-Path $parentRoot 'resources\codex.exe'))
      }
      $parentId = $parent.ParentProcessId
    }
    if (-not $desktop) { continue }
    $listen = $null
    $listenKind = 'unspecified'
    $socket = $null
    $socketDefault = $false
    $socketInvalid = $false
    for ($i = $index + 1; $i -lt $words.Count; $i++) {
      $word = $words[$i]
      $value = $null
      $kind = $null
      if ($word -eq '--listen' -or $word -eq '--sock') { $kind = $word; if ($i + 1 -lt $words.Count) { $i++; $value = $words[$i] } }
      elseif ($word.StartsWith('--listen=')) { $kind = '--listen'; $value = $word.Substring(9) }
      elseif ($word.StartsWith('--sock=')) { $kind = '--sock'; $value = $word.Substring(7) }
      if ($kind -eq '--listen') {
        $listenKind = 'unsupported'
        if ($value -eq 'stdio://') { $listenKind = 'stdio' }
        elseif ($value -eq 'unix://') { $listenKind = 'unix'; $socketDefault = $true }
        elseif ($value -and $value.StartsWith('unix://')) {
          $unixPath = $value.Substring(7)
          if ($unixPath.Length -le 4096 -and $unixPath -notmatch '[\x00-\x1f]' -and $unixPath -match '^(?:[A-Za-z]:[\\/]|/(?!/)|\\\\\.\\pipe\\)') { $socket = $unixPath; $listenKind = 'unix' }
        }
        else {
          $uri = $null
          if ([Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -in @('ws','wss') -and $uri.Host -in @('localhost','127.0.0.1','[::1]','::1') -and -not $uri.UserInfo -and -not $uri.Query -and -not $uri.Fragment) {
            $listen = $uri.AbsoluteUri
            $listenKind = 'websocket'
          }
        }
      }
      elseif ($kind -eq '--sock') {
        if ($value -and $value.Length -le 4096 -and $value -notmatch '[\x00-\x1f]' -and $value -match '^(?:[A-Za-z]:[\\/]|\\\\\.\\pipe\\)') { $socket = $value }
        else { $socketInvalid = $true }
      }
    }
    $processes += [pscustomobject]@{ executable = $process.ExecutablePath; processId = [int]$process.ProcessId; listenKind = $listenKind; listen = $listen; socket = $socket; socketDefault = $socketDefault; socketInvalid = $socketInvalid }
  }
} catch { $issues += 'process-discovery-unavailable' }
try {
  $packages = @(Get-AppxPackage -Name 'OpenAI.*' | Where-Object { $_.Name -in @('OpenAI.Codex', 'OpenAI.ChatGPT') -and $_.InstallLocation } | ForEach-Object { [pscustomobject]@{ location = $_.InstallLocation; name = $_.Name } })
} catch { $issues += 'package-discovery-unavailable' }
[pscustomobject]@{ processes = @($processes); packages = @($packages); issues = @($issues | Select-Object -Unique) } | ConvertTo-Json -Depth 5 -Compress
`;

interface CommandResult { stdout: string; code: number | null }
export interface CodexDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (file: string) => Promise<boolean>;
  readText?: (file: string) => Promise<string>;
  readDirectory?: (directory: string) => Promise<string[]>;
  run?: (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>;
}
interface WindowsProcess {
  executable: string;
  processId: number;
  listenKind: 'unspecified' | 'stdio' | 'websocket' | 'unix' | 'unsupported';
  listen?: string;
  socket?: string;
  socketDefault?: boolean;
  socketInvalid?: boolean;
}
interface Candidate {
  executable: string;
  source: CodexInstallation['source'];
  process?: WindowsProcess;
}

/** Bounded, shell-free metadata/version probes. Child stderr is never published. */
export function runCodexProbe(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    let settled = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve({ stdout, code });
    };
    const stop = () => {
      if (process.platform === 'win32' && child.pid) {
        const cleanup = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        cleanup.on('error', () => child.kill());
        const killTimer = setTimeout(() => { cleanup.kill(); child.kill(); }, 2_000);
        killTimer.unref();
        cleanup.once('close', () => { clearTimeout(killTimer); child.kill(); });
      } else child.kill();
      child.stdout.destroy();
    };
    const timer = setTimeout(() => { stop(); finish(new Error('probe-timeout')); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 128 * 1024) { stop(); finish(new Error('probe-output-limit')); }
    });
    child.once('error', () => finish(new Error('probe-unavailable')));
    child.once('close', code => finish(undefined, code));
  });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function safePath(value: unknown): value is string {
  return typeof value === 'string' && !!value && value.length <= 4096 && !/[\x00-\x1f]/u.test(value);
}
function version(stdout: string): string | undefined {
  return stdout.trim().match(/^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)/iu)?.[1];
}

/** Read installed CLI metadata and existing server addresses; never start a server. */
let defaultDiscovery: Promise<CodexDiscoveryResult> | undefined;
export function discoverCodex(options?: CodexDiscoveryOptions): Promise<CodexDiscoveryResult> {
  if (options) return collectCodex(options);
  if (!defaultDiscovery) defaultDiscovery = collectCodex({}).finally(() => { defaultDiscovery = undefined; });
  return defaultDiscovery;
}

async function collectCodex(options: CodexDiscoveryOptions): Promise<CodexDiscoveryResult> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const codexHome = environmentValue(env, 'CODEX_HOME') || paths.join(home, '.codex');
  const defaultSocket = paths.isAbsolute(codexHome) ? paths.join(codexHome, 'app-server-control', 'app-server-control.sock') : undefined;
  const exists = options.exists ?? fileExists;
  const readText = options.readText ?? (file => readFile(file, 'utf8'));
  const readDirectory = options.readDirectory ?? (directory => readdir(directory));
  const run = options.run ?? runCodexProbe;
  const issues: CodexDiscoveryIssue[] = [];
  const candidates: Candidate[] = [];
  const keys = new Set<string>();
  const add = (executable: string, source: Candidate['source'], process?: WindowsProcess) => {
    if (!safePath(executable) || !paths.isAbsolute(executable)) return;
    const normalized = paths.normalize(executable);
    const key = `${platform === 'win32' ? normalized.toLowerCase() : normalized}:${process?.processId ?? ''}`;
    if (keys.has(key)) return;
    if (!process && candidates.some(item => (platform === 'win32' ? item.executable.toLowerCase() : item.executable) === (platform === 'win32' ? normalized.toLowerCase() : normalized))) return;
    keys.add(key);
    candidates.push({ executable: normalized, source, process });
  };
  const desktopRoot = (root: string) => {
    if (!safePath(root) || !paths.isAbsolute(root)) return;
    add(paths.join(root, 'resources', 'codex.exe'), 'desktop-install');
    add(paths.join(root, 'app', 'resources', 'codex.exe'), 'desktop-install');
  };
  if (platform === 'win32') {
    const systemRoot = environmentValue(env, 'SystemRoot') || 'C:\\Windows';
    try {
      const result = await run(paths.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CODEX_METADATA_SCRIPT], 8_000);
      if (result.code !== 0) throw new Error('metadata-unavailable');
      const metadata = object(JSON.parse(result.stdout.replace(/^\uFEFF/u, '')));
      if (!metadata || !Array.isArray(metadata.processes) || !Array.isArray(metadata.packages)) throw new Error('invalid-metadata');
      for (const value of metadata.processes) {
        const process = object(value);
        if (!process || !safePath(process.executable) || !Number.isSafeInteger(process.processId) || Number(process.processId) <= 0) continue;
        const listenKind = ['unspecified', 'stdio', 'websocket', 'unix', 'unsupported'].includes(String(process.listenKind)) ? process.listenKind as WindowsProcess['listenKind'] : 'unsupported';
        add(process.executable, 'desktop-process', {
          executable: process.executable, processId: Number(process.processId), listenKind,
          ...(safePath(process.listen) && isLocalEndpoint(process.listen) ? { listen: process.listen } : {}),
          ...(safePath(process.socket) && isLocalSocketPath(process.socket) ? { socket: process.socket } : {}),
          socketInvalid: process.socketInvalid === true,
          socketDefault: process.socketDefault === true,
        });
      }
      for (const value of metadata.packages) {
        const item = object(value);
        if (item && safePath(item.location)) desktopRoot(item.location);
      }
      if (Array.isArray(metadata.issues)) for (const code of new Set(metadata.issues)) {
        if (typeof code === 'string' && ['process-discovery-unavailable', 'process-owner-unavailable', 'package-discovery-unavailable'].includes(code)) issues.push({ code, message: code === 'package-discovery-unavailable' ? 'Windows не предоставил список пакетов Codex. Проверяем обычные каталоги установки и PATH.' : 'Windows не предоставил все сведения о серверных процессах Codex текущего пользователя.' });
      }
    } catch {
      issues.push({ code: 'windows-discovery-unavailable', message: 'Не удалось получить сведения Windows о процессах и пакетах Codex. Проверяем обычные каталоги установки и PATH.' });
    }
    const local = environmentValue(env, 'LOCALAPPDATA');
    const roaming = environmentValue(env, 'APPDATA');
    for (const root of [
      local && paths.join(local, 'Programs', 'Codex'), local && paths.join(local, 'Codex'),
      local && paths.join(local, 'Programs', 'OpenAI', 'Codex'), local && paths.join(local, 'OpenAI', 'Codex'),
      local && paths.join(local, 'Programs', 'ChatGPT'),
      environmentValue(env, 'ProgramFiles') && paths.join(environmentValue(env, 'ProgramFiles'), 'Codex'),
      environmentValue(env, 'ProgramFiles') && paths.join(environmentValue(env, 'ProgramFiles'), 'OpenAI', 'Codex'),
    ].filter(Boolean)) desktopRoot(root);
    if (local) {
      add(paths.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), 'standard');
      add(paths.join(local, 'OpenAI', 'Codex', 'bin', 'codex.exe'), 'standard');
    }
    if (roaming) add(paths.join(roaming, 'npm', 'codex.cmd'), 'standard');
  }
  const pathDirectories = environmentValue(env, 'PATH').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const directory of pathDirectories) {
    const root = directory.replace(/^"|"$/gu, '');
    if (!paths.isAbsolute(root)) continue;
    if (platform === 'win32') {
      // A GUI directory in PATH is useful only for its bundled CLI.
      desktopRoot(root);
      add(paths.join(root, 'codex.cmd'), 'path');
      add(paths.join(root, 'codex.exe'), 'path');
    } else add(paths.join(root, 'codex'), 'path');
  }
  if (platform !== 'win32') {
    for (const root of [paths.join(home, '.local', 'bin'), paths.join(home, '.npm-global', 'bin'), paths.join(home, '.local', 'share', 'mise', 'shims'), '/usr/local/bin', '/usr/bin', '/opt/homebrew/bin']) add(paths.join(root, 'codex'), 'standard');
    for (const root of [paths.join(home, '.nvm', 'versions', 'node'), paths.join(home, '.local', 'share', 'fnm', 'node-versions')]) {
      try {
        for (const name of (await readDirectory(root)).filter(name => /^v\d+\.\d+\.\d+$/u.test(name)).sort().reverse().slice(0, 12)) {
          add(paths.join(root, name, 'bin', 'codex'), 'standard');
          add(paths.join(root, name, 'installation', 'bin', 'codex'), 'standard');
        }
      } catch { /* This optional installation root does not exist. */ }
    }
  }
  const existing: Candidate[] = [];
  for (const candidate of candidates) if (await exists(candidate.executable) && !await isDesktopLauncher(candidate.executable, exists, platform)) existing.push(candidate);
  if (existing.length > 24) issues.push({ code: 'installation-limit', message: 'Найдено много установок Codex; проверены первые 24 по приоритету.' });
  const installations: CodexInstallation[] = [];
  const probes = new Map<string, Promise<{ version?: string; executable: string }>>();
  const probeKey = (candidate: Candidate) => platform === 'win32' ? candidate.executable.toLowerCase() : candidate.executable;
  const selected = existing.slice(0, 24);
  const prepare = (candidate: Candidate) => {
    let probe = probes.get(probeKey(candidate));
    if (!probe) {
      probe = (async () => {
        const launch = await resolveCodexLaunch(candidate.executable, { platform, env, exists, readText });
        const result = await run(launch.command, [...launch.args, '--version'], 4_000);
        return { executable: launch.executable, version: result.code === 0 ? version(result.stdout) : undefined };
      })();
      probes.set(probeKey(candidate), probe);
    }
    return probe;
  };
  for (let offset = 0; offset < selected.length; offset += 4) await Promise.allSettled(selected.slice(offset, offset + 4).map(prepare));
  for (const candidate of selected) {
    const installation: CodexInstallation = {
      executable: candidate.executable,
      name: candidate.source.startsWith('desktop') ? 'Codex из Desktop' : 'Codex CLI',
      source: candidate.source, running: !!candidate.process,
      ...(candidate.process ? { processId: candidate.process.processId } : {}),
    };
    installations.push(installation);
    let found: { version?: string; executable: string };
    try { found = await prepare(candidate); }
    catch { issues.push({ code: 'cli-probe-failed', executable: candidate.executable, message: 'Найденный Codex CLI не ответил на проверку версии. Проверьте доступ к файлу и установку.' }); continue; }
    if (!found.version) { issues.push({ code: 'cli-not-confirmed', executable: candidate.executable, message: 'Файл найден, но проверка версии не подтвердила Codex CLI.' }); continue; }
    installation.executable = found.executable;
    installation.version = found.version;
    const process = candidate.process;
    const serverSocket = process?.socket ?? (process?.listenKind === 'unix' && process.socketDefault ? defaultSocket : undefined);
    if (serverSocket && await exists(serverSocket)) {
      installation.connection = { executable: found.executable, transport: 'proxy', endpoint: serverSocket };
      if (process?.socketDefault) issues.push({ code: 'default-socket-profile', executable: found.executable, message: 'Сервер объявил unix:// без пути. Найден стандартный сокет профиля Rele; совпадение с нужным runtime Desktop нужно проверить после подключения.' });
    }
    else if (process?.listenKind === 'websocket' && process.listen) installation.connection = { executable: found.executable, transport: 'websocket', endpoint: process.listen };
    else if (process) {
      const code = serverSocket || process.listenKind === 'unix' ? 'socket-not-found' : process.listenKind === 'stdio' || process.listenKind === 'unspecified' ? 'desktop-stdio' : 'desktop-listener-unsupported';
      issues.push({ code, executable: found.executable, message: code === 'socket-not-found'
        ? 'Desktop запущен, но указанный сокет общего app-server недоступен.'
        : code === 'desktop-stdio'
          ? 'Сервер Desktop найден. Доступный общий сокет или WebSocket не обнаружен; stdio-соединение Desktop нельзя использовать как внешнее подключение Rele.'
          : 'Сервер Desktop найден, но его адрес не подходит для локального подключения Rele.' });
    } else installation.connection = { executable: found.executable, transport: 'proxy', endpoint: '' };
  }
  const running = installations.filter(item => item.running);
  const attachable = running.filter(item => item.connection);
  let recommended: CodexConnectionTarget | undefined;
  if (attachable.length === 1) recommended = attachable[0].connection;
  else if (attachable.length > 1) issues.push({ code: 'multiple-desktop-servers', message: 'Найдено несколько доступных серверов Desktop. Выберите нужное подключение явно.' });
  else if (!running.length) recommended = installations.find(item => item.source === 'path' && item.connection)?.connection ?? installations.find(item => item.connection)?.connection;
  if (!installations.length) issues.push({ code: 'cli-not-found', message: 'Codex CLI не найден среди процессов Desktop, установленных пакетов и каталогов CLI. Укажите путь к CLI или установите Codex.' });
  if (recommended?.transport === 'proxy' && !recommended.endpoint) {
    if (!defaultSocket || !await exists(defaultSocket)) issues.push({ code: 'shared-socket-not-found', message: 'CLI найден, но стандартный сокет общего app-server текущего профиля не обнаружен. Rele проверит подключение без запуска нового сервера.' });
  }
  return { installations, ...(recommended ? { recommended } : {}), issues };
}
