import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || !process.env.APPDATA) throw new Error('This installer is for the current Windows user.');
const releaseDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startupDirectory = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const startupFile = path.join(startupDirectory, 'Rele.cmd');
if (process.argv.includes('--remove')) {
  await rm(startupFile, { force: true });
  console.log('Rele autostart removed for the current user; saved data is unchanged.');
} else {
  const runtime = path.join(releaseDirectory, 'runtime', 'node.exe');
  const main = path.join(releaseDirectory, 'dist', 'server', 'main.js');
  await access(runtime); await access(main);
  // cmd expands percent signs even inside quotes. Delayed expansion stays off.
  const literal = value => {
    if (/[\r\n"]/u.test(value)) throw new Error('Autostart paths cannot contain quotes or line breaks.');
    return value.replaceAll('%', '%%');
  };
  const environment = ['CODEX_HOME', 'RELE_DATA_DIR'].filter(key => process.env[key])
    .map(key => `set "${key}=${literal(process.env[key])}"`);
  await mkdir(startupDirectory, { recursive: true });
  await writeFile(startupFile, ['@echo off', 'chcp 65001 >nul', 'setlocal DisableDelayedExpansion',
    ...environment, `cd /d "${literal(releaseDirectory)}"`,
    `start "Rele" /min "${literal(runtime)}" "${literal(main)}"`, '',
  ].join('\r\n'));
  console.log('Rele will start at the next sign-in of the current user. Launch start-rele.cmd to run it now.');
}
