import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeVersion = '24.19.0';
if (!['linux', 'win32'].includes(process.platform) || process.arch !== 'x64') throw new Error('The first portable packages support Linux x64 and Windows x64.');
if (process.version !== `v${nodeVersion}`) throw new Error(`Build the portable package with Node ${nodeVersion}, which will be bundled with it.`);
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run package so the package builder uses the same npm installation.');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u.test(metadata.version)) throw new Error('Unexpected package version.');
await access(path.join(root, 'dist/server/main.js'));
await access(path.join(root, 'dist/web/index.html'));
const name = `rele-${metadata.version}-${process.platform === 'win32' ? 'windows' : 'linux'}-x64`;
const output = path.join(root, 'release');
const stage = path.join(output, name);
await mkdir(output, { recursive: true });
await rm(stage, { recursive: true, force: true });
await mkdir(path.join(stage, 'runtime'), { recursive: true });
await mkdir(path.join(stage, 'scripts'), { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited ${result.status}.`);
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

for (const file of ['package.json', 'package-lock.json', 'README.md']) await copyFile(path.join(root, file), path.join(stage, file));
await cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
await cp(path.join(root, 'docs'), path.join(stage, 'docs'), { recursive: true });
await cp(path.join(root, 'integrations'), path.join(stage, 'integrations'), { recursive: true });
for (const file of ['install-user-service.mjs', 'install-autostart.mjs']) {
  await copyFile(path.join(root, 'scripts', file), path.join(stage, 'scripts', file));
}
for (const file of ['transcribe.py', 'voice-requirements.txt']) {
  await copyFile(path.join(root, 'scripts', file), path.join(stage, 'scripts', file));
}
const nodeBinary = path.join(stage, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
await copyFile(process.execPath, nodeBinary);
if (process.platform !== 'win32') await chmod(nodeBinary, 0o755);

const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`;
const licenseResponse = await fetch(licenseUrl);
if (!licenseResponse.ok) throw new Error(`Node license download failed: HTTP ${licenseResponse.status}.`);
const license = Buffer.from(await licenseResponse.arrayBuffer());
if (createHash('sha256').update(license).digest('hex') !== '148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5') {
  throw new Error('The official Node license did not match the reviewed version.');
}
await writeFile(path.join(stage, 'runtime/LICENSE'), license);
run(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage });

await writeFile(path.join(stage, 'start-rele.sh'), '#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nexec ./runtime/node ./dist/server/main.js "$@"\n', { mode: 0o755 });
await writeFile(path.join(stage, 'start-rele.cmd'), '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\server\\main.js" %*\r\n');
await writeFile(path.join(stage, 'install-user-service.sh'), '#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nexec ./runtime/node ./scripts/install-user-service.mjs "$@"\n', { mode: 0o755 });
await writeFile(path.join(stage, 'install-autostart.cmd'), '@echo off\r\nsetlocal\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\install-autostart.mjs" %*\r\n');
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
const commit = process.env.GITHUB_SHA || (git.status === 0 ? git.stdout.trim() : null);
await writeFile(path.join(stage, 'manifest.json'), JSON.stringify({
  name: 'Rele', version: metadata.version, platform: process.platform, arch: process.arch,
  node: nodeVersion, codexProtocol: '0.163.0', commit,
  nodeBinarySha256: await sha256(nodeBinary), desktopVerified: false,
}, null, 2) + '\n');
const archive = path.join(output, name + (process.platform === 'win32' ? '.zip' : '.tar.gz'));
if (process.platform === 'win32') {
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -LiteralPath $env:RELE_PACKAGE_STAGE -DestinationPath $env:RELE_PACKAGE_ARCHIVE -Force'],
  { env: { ...process.env, RELE_PACKAGE_STAGE: stage, RELE_PACKAGE_ARCHIVE: archive } });
} else run('tar', ['-czf', archive, '-C', output, name]);
await writeFile(`${archive}.sha256`, `${await sha256(archive)}  ${path.basename(archive)}\n`);
console.log(`Portable package: ${archive}`);
