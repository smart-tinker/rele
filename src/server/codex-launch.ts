import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface CodexLaunch {
  command: string;
  args: string[];
  executable: string;
}

export interface CodexLaunchOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => Promise<boolean>;
  readText?: (file: string) => Promise<string>;
}

export async function fileExists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

export function environmentValue(env: NodeJS.ProcessEnv, key: string): string {
  const found = Object.keys(env).find(name => name.toLowerCase() === key.toLowerCase());
  return found ? env[found] || '' : '';
}

/** The npm batch file is never executed. Only the official package entry is used. */
export async function resolveCodexLaunch(executable: string, options: CodexLaunchOptions = {}): Promise<CodexLaunch> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fileExists;
  const readText = options.readText ?? (file => readFile(file, 'utf8'));
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (/\.[cm]?js$/iu.test(executable)) return { command: process.execPath, args: [executable], executable };
  if (platform !== 'win32') return { command: executable, args: [], executable };
  const candidates = paths.isAbsolute(executable) || /[\\/]/u.test(executable)
    ? [paths.resolve(executable)]
    : environmentValue(env, 'PATH').split(';').filter(Boolean).flatMap(directory => paths.extname(executable)
      ? [paths.join(directory.replace(/^"|"$/gu, ''), executable)]
      : [paths.join(directory.replace(/^"|"$/gu, ''), `${executable}.cmd`), paths.join(directory.replace(/^"|"$/gu, ''), `${executable}.exe`)]);
  for (const candidate of candidates) {
    if (!await exists(candidate)) continue;
    if (/\.(cmd|bat)$/iu.test(candidate)) {
      const root = paths.join(paths.dirname(candidate), 'node_modules', '@openai', 'codex');
      const entry = paths.join(root, 'bin', 'codex.js');
      try {
        const manifest = JSON.parse(await readText(paths.join(root, 'package.json'))) as { name?: unknown };
        if (manifest.name === '@openai/codex' && await exists(entry)) return { command: process.execPath, args: [entry], executable: entry };
      } catch { /* An unrelated batch file is not an official Codex CLI. */ }
      continue;
    }
    if (await isDesktopLauncher(candidate, exists, platform)) continue;
    return { command: candidate, args: [], executable: candidate };
  }
  throw new Error('Не найден исполняемый файл Codex CLI. Выберите найденную установку или укажите путь к CLI внутри Desktop.');
}

/** App execution aliases and Electron launchers must never be probed with --version. */
export async function isDesktopLauncher(executable: string, exists = fileExists, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== 'win32') return false;
  const normalized = path.win32.normalize(executable);
  if (!/\.exe$/iu.test(normalized)) return false;
  if (/\\Microsoft\\WindowsApps\\[^\\]+\.exe$/iu.test(normalized)) return true;
  if (/\\(?:ChatGPT|OpenAI)\.exe$/iu.test(normalized)) return true;
  if (!/\\codex\.exe$/iu.test(normalized)) return false;
  const root = path.win32.dirname(normalized);
  if (path.win32.basename(root).toLowerCase() === 'resources') return false;
  return await exists(path.win32.join(root, 'resources', 'app.asar'))
    || await exists(path.win32.join(root, 'resources', 'codex.exe'))
    || await exists(path.win32.join(root, 'app', 'resources', 'codex.exe'));
}
