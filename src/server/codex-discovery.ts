import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { SUPPORTED_CODEX_VERSIONS } from '../shared/codex-runtime.js';
import type { CodexConnectionTarget, CodexDiscoveryIssue, CodexDiscoveryResult, CodexInstallation } from '../shared/types.js';
import { isLocalEndpoint, isLocalSocketPath } from './config.js';
import { codexEnvironment, environmentValue, fileExists, isDesktopLauncher, resolveCodexLaunch } from './codex-launch.js';

// Command lines are inspected inside this fixed script and never returned. No auth,
// history, environment, or Codex configuration files are read during discovery.
export const WINDOWS_CODEX_PROCESS_PROVIDER_SCRIPT = String.raw`
[void][Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
function Close-ReleProcessQuery($query) {
  try { foreach ($row in $query.objects) { $row.Dispose() } }
  finally { try { if ($query.collection) { $query.collection.Dispose() } } finally { $query.searcher.Dispose() } }
}
function Get-ReleProcessQuery([string]$filter, [bool]$parentOnly = $false) {
  $fields = if ($parentOnly) { 'Name,ExecutablePath,ParentProcessId' } else { 'Name,ExecutablePath,CommandLine,ProcessId,ParentProcessId' }
  $query = @{ searcher = [Management.ManagementObjectSearcher]::new('root\CIMV2', "SELECT $fields FROM Win32_Process WHERE $filter"); collection = $null; objects = [Collections.Generic.List[object]]::new() }
  try {
    $query.searcher.Options.EnsureLocatable = $true
    $query.collection = $query.searcher.Get()
    foreach ($row in $query.collection) { $query.objects.Add($row) }
    return $query
  } catch { Close-ReleProcessQuery $query; throw }
}
function Get-ReleProcessOwner($process) {
  $owner = $null
  try {
    $owner = $process.InvokeMethod('GetOwnerSid', $null, $null)
    return @{ ReturnValue = $owner.ReturnValue; Sid = $owner.Sid }
  } finally { if ($owner) { $owner.Dispose() } }
}
`;
export const WINDOWS_CODEX_METADATA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::Error.WriteLine('rele-discovery:startup')
$processes = [Collections.Generic.List[object]]::new()
$packages = [Collections.Generic.List[object]]::new()
$issues = @()
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Add-ReleJsonRecord([Collections.Generic.List[object]]$records, [hashtable]$values) {
  $record = [Collections.Generic.Dictionary[string,object]]::new()
  foreach ($key in $values.Keys) { $record.Add([string]$key, $values[$key]) }
  $records.Add($record)
}
$query = $null
try {
  [Console]::Error.WriteLine('rele-discovery:process-provider')
  ${WINDOWS_CODEX_PROCESS_PROVIDER_SCRIPT}
  [Console]::Error.WriteLine('rele-discovery:process-query')
  $query = Get-ReleProcessQuery "Name = 'codex.exe'"
  foreach ($process in $query.objects) {
    try {
      [Console]::Error.WriteLine('rele-discovery:owner-query')
      $owner = Get-ReleProcessOwner $process
      if ($owner.ReturnValue -ne 0 -or -not $owner.Sid) { $issues += 'process-owner-unavailable'; continue }
      if ($owner.Sid -ne $sid) { continue }
    } catch { $issues += 'process-owner-unavailable'; continue }
    if (-not $process.ExecutablePath -or -not $process.CommandLine) { $issues += 'process-owner-unavailable'; continue }
    [Console]::Error.WriteLine('rele-discovery:process-parse')
    $words = @([regex]::Matches($process.CommandLine, '"[^"]*"|[^\s]+') | ForEach-Object { $_.Value.Trim('"') })
    $index = [Array]::IndexOf($words, 'app-server')
    if ($index -lt 0 -or ($index + 1 -lt $words.Count -and $words[$index + 1] -eq 'proxy')) { continue }
    $desktop = $process.ExecutablePath -match '(?i)[\\/]resources[\\/]codex\.exe$'
    $parentId = $process.ParentProcessId
    for ($depth = 0; -not $desktop -and $parentId -gt 0 -and $depth -lt 4; $depth++) {
      [Console]::Error.WriteLine('rele-discovery:parent-query')
      $parents = $null
      try {
        $parents = Get-ReleProcessQuery "ProcessId = $parentId" $true
        if ($parents.objects.Count -eq 0) { break }
        $parent = $parents.objects[0]
        if ($parent.Name -match '^(?i:Codex|ChatGPT)\.exe$' -and $parent.ExecutablePath) {
          $parentRoot = [IO.Path]::GetDirectoryName($parent.ExecutablePath)
          $desktop = [IO.File]::Exists([IO.Path]::Combine($parentRoot, 'resources\app.asar')) -or [IO.File]::Exists([IO.Path]::Combine($parentRoot, 'resources\codex.exe'))
        }
        $parentId = $parent.ParentProcessId
      } finally { if ($parents) { Close-ReleProcessQuery $parents } }
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
    Add-ReleJsonRecord $processes @{ executable = [string]$process.ExecutablePath; processId = [int]$process.ProcessId; listenKind = $listenKind; listen = $listen; socket = $socket; socketDefault = $socketDefault; socketInvalid = $socketInvalid }
  }
} catch { $issues += 'process-discovery-unavailable' } finally { if ($query) { Close-ReleProcessQuery $query } }
if (-not $releProcessesOnly) { try {
  [Console]::Error.WriteLine('rele-discovery:packages')
  foreach ($package in @(Get-AppxPackage -Name 'OpenAI.*')) {
    if ($package.Name -in @('OpenAI.Codex', 'OpenAI.ChatGPT') -and $package.InstallLocation) { Add-ReleJsonRecord $packages @{ location = [string]$package.InstallLocation; name = [string]$package.Name } }
  }
} catch { $issues += 'package-discovery-unavailable' } }
[Console]::Error.WriteLine('rele-discovery:json-provider')
[void][Reflection.Assembly]::Load('System.Runtime.Serialization, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
[Console]::Error.WriteLine('rele-discovery:json')
$uniqueIssues = @()
foreach ($issue in $issues) { if ($uniqueIssues -notcontains $issue) { $uniqueIssues += [string]$issue } }
$settings = [Runtime.Serialization.Json.DataContractJsonSerializerSettings]::new()
$settings.UseSimpleDictionaryFormat = $true
$settings.EmitTypeInformation = [Runtime.Serialization.EmitTypeInformation]::Never
# Keep dictionary records in a declared dictionary-array contract. A dictionary
# nested under Object is otherwise serialized as enumerable Key/Value entries.
$recordArrayType = [Collections.Generic.Dictionary[string,object][]]
$fields = @(
  @{ name = 'processes'; type = $recordArrayType; value = [Collections.Generic.Dictionary[string,object][]]$processes.ToArray() },
  @{ name = 'packages'; type = $recordArrayType; value = [Collections.Generic.Dictionary[string,object][]]$packages.ToArray() },
  @{ name = 'issues'; type = [string[]]; value = [string[]]$uniqueIssues }
)
$jsonFields = [Collections.Generic.List[string]]::new()
foreach ($field in $fields) {
  $serializer = [Runtime.Serialization.Json.DataContractJsonSerializer]::new($field.type, $settings)
  $stream = [IO.MemoryStream]::new()
  try { $serializer.WriteObject($stream, $field.value); $jsonFields.Add('"' + $field.name + '":' + [Text.Encoding]::UTF8.GetString($stream.ToArray())) }
  finally { $stream.Dispose() }
}
[Console]::Out.Write('{' + [string]::Join(',', $jsonFields.ToArray()) + '}')
[Console]::Error.WriteLine('rele-discovery:done')
`;
export const WINDOWS_CODEX_PROCESS_METADATA_SCRIPT = '$releProcessesOnly = $true\n' + WINDOWS_CODEX_METADATA_SCRIPT;

interface CommandResult { stdout: string; code: number | null; stage?: string }
export interface CodexDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  codexHome?: string;
  processesOnly?: boolean;
  exists?: (file: string) => Promise<boolean>;
  readText?: (file: string) => Promise<string>;
  readDirectory?: (directory: string) => Promise<string[]>;
  run?: (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>;
}

function probeStage(value: unknown): string | undefined {
  return typeof value === 'string' && ['startup', 'process-provider', 'process-query', 'process-parse', 'owner-query', 'parent-query', 'packages', 'json-provider', 'json', 'done'].includes(value) ? value : undefined;
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
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderrLine = '', stage: string | undefined;
    let settled = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(Object.assign(error, stage ? { stage } : {})) : resolve({ stdout, code, ...(stage ? { stage } : {}) });
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
      child.stderr.destroy();
    };
    const timer = setTimeout(() => { stop(); finish(new Error('probe-timeout')); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 128 * 1024) { stop(); finish(new Error('probe-output-limit')); }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      const lines = (stderrLine + chunk).split(/\r?\n/u);
      stderrLine = lines.pop()!.slice(-128);
      for (const line of lines) if (line.startsWith('rele-discovery:')) stage = probeStage(line.slice(15)) ?? stage;
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
  const env = codexEnvironment(options.codexHome, options.env ?? process.env, platform);
  const home = options.home ?? homedir();
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const localAppData = platform === 'win32' && environmentValue(env, 'LOCALAPPDATA');
  const desktopCacheRoot = localAppData ? paths.join(localAppData, 'OpenAI', 'Codex', 'bin') : undefined;
  const codexHome = (platform === 'win32' ? environmentValue(env, 'CODEX_HOME') : env.CODEX_HOME) || paths.join(home, '.codex');
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
    let stage = 'startup';
    try {
      const script = options.processesOnly ? WINDOWS_CODEX_PROCESS_METADATA_SCRIPT : WINDOWS_CODEX_METADATA_SCRIPT;
      const result = await run(paths.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], 8_000);
      stage = probeStage(result.stage) ?? stage;
      if (result.code !== 0) throw new Error('metadata-exit');
      let parsed: unknown;
      try { parsed = JSON.parse(result.stdout.replace(/^\uFEFF/u, '')); }
      catch { throw new Error('metadata-json'); }
      const metadata = object(parsed);
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
    } catch (error) {
      const cause: Record<string, string> = { 'probe-timeout': 'timeout', 'probe-unavailable': 'unavailable', 'probe-output-limit': 'output-limit', 'metadata-exit': 'exit', 'metadata-json': 'json', 'invalid-metadata': 'json' };
      const reason = error instanceof Error ? cause[error.message] ?? 'failed' : 'failed';
      stage = probeStage(object(error)?.stage) ?? stage;
      issues.push({ code: 'windows-discovery-unavailable', message: 'Не удалось получить сведения Windows о процессах и пакетах Codex. Проверяем обычные каталоги установки и PATH.' });
      issues.push({ code: `windows-probe-${reason}-${stage}`, message: 'Этап и категория ошибки проверки Windows; содержимое процесса не публикуется.' });
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
      for (const root of [paths.join(local, 'Programs', 'OpenAI', 'Codex', 'bin'), paths.join(local, 'OpenAI', 'Codex', 'bin')]) {
        add(paths.join(root, 'codex.exe'), 'standard');
        try {
          for (const name of (await readDirectory(root)).filter(name => /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(name)).sort().reverse().slice(0, 12)) {
            add(paths.join(root, name, 'codex.exe'), 'standard');
          }
        } catch { /* This optional versioned CLI installation does not exist. */ }
      }
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
    // Desktop relocates its WindowsApps backend into this content-addressed directory.
    const desktopWorkingCopy = desktopCacheRoot && /^[a-f0-9]{16}\\codex\.exe$/iu.test(paths.relative(desktopCacheRoot, candidate.executable));
    const installation: CodexInstallation = {
      executable: candidate.executable,
      name: desktopWorkingCopy ? 'Рабочая копия Codex Desktop' : candidate.source.startsWith('desktop') ? 'Codex из Desktop' : 'Codex CLI',
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
    const profile = options.codexHome ? { codexHome: options.codexHome } : {};
    installation.managedConnection = { executable: found.executable, transport: 'managed', endpoint: '', ...profile };
    if (!SUPPORTED_CODEX_VERSIONS.includes(found.version)) issues.push({ code: 'cli-version-unverified', executable: found.executable, message: `Codex ${found.version} не проверен для отправки через Rele. Его можно выбрать явно для чтения тредов.` });
    const process = candidate.process;
    const serverSocket = process?.socket ?? (process?.listenKind === 'unix' && process.socketDefault ? defaultSocket : undefined);
    if (serverSocket && await exists(serverSocket)) {
      installation.connection = { executable: found.executable, transport: 'proxy', endpoint: serverSocket, ...profile };
      if (process?.socketDefault) issues.push({ code: 'default-socket-profile', executable: found.executable, message: 'Сервер объявил unix:// без пути. Найден стандартный сокет профиля Rele; совпадение с нужным runtime Desktop нужно проверить после подключения.' });
    }
    else if (process?.listenKind === 'websocket' && process.listen) installation.connection = { executable: found.executable, transport: 'websocket', endpoint: process.listen, ...profile };
    else if (process) {
      const code = serverSocket || process.listenKind === 'unix' ? 'socket-not-found' : process.listenKind === 'stdio' || process.listenKind === 'unspecified' ? 'desktop-stdio' : 'desktop-listener-unsupported';
      issues.push({ code, executable: found.executable, message: code === 'socket-not-found'
        ? 'Desktop запущен, но указанный сокет app-server недоступен для внешнего подключения.'
        : code === 'desktop-stdio'
          ? 'Сервер Desktop найден. Доступный общий сокет или WebSocket не обнаружен; stdio-соединение Desktop нельзя использовать как внешнее подключение Rele.'
          : 'Сервер Desktop найден, но его адрес не подходит для локального подключения Rele.' });
    } else installation.connection = { executable: found.executable, transport: 'proxy', endpoint: '', ...profile };
  }
  const verified = installations.filter(item => item.version && SUPPORTED_CODEX_VERSIONS.includes(item.version))
    .sort((a, b) => SUPPORTED_CODEX_VERSIONS.indexOf(a.version!) - SUPPORTED_CODEX_VERSIONS.indexOf(b.version!));
  const recommendedManaged = verified.find(item => item.managedConnection)?.managedConnection;
  const running = installations.filter(item => item.running);
  const attachable = running.filter(item => item.connection);
  let recommended: CodexConnectionTarget | undefined;
  if (attachable.length === 1 && verified.includes(attachable[0])) recommended = attachable[0].connection;
  else if (attachable.length > 1) issues.push({ code: 'multiple-desktop-servers', message: 'Найдено несколько доступных серверов Desktop. Выберите нужное подключение явно.' });
  else if (!running.length) {
    const preferred = verified.filter(item => item.version === verified[0]?.version);
    recommended = preferred.find(item => item.source === 'path' && item.connection)?.connection ?? preferred.find(item => item.connection)?.connection;
  }
  if (!installations.length) issues.push({ code: 'cli-not-found', message: 'Codex CLI не найден среди процессов Desktop, установленных пакетов и каталогов CLI. Укажите путь к CLI или установите Codex.' });
  if (recommended?.transport === 'proxy' && !recommended.endpoint) {
    if (!defaultSocket || !await exists(defaultSocket)) issues.push({ code: 'shared-socket-not-found', message: 'CLI найден, но стандартный сокет текущего профиля для внешнего подключения не обнаружен. Запуск app-server через Rele не требует этого сокета.' });
  }
  return { installations, ...(recommended ? { recommended } : {}), ...(recommendedManaged ? { recommendedManaged } : {}), issues };
}
