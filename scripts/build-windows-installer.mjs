import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCSharpCompiler } from './build-process-host.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the Windows installer on a Windows x64 runner.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/u.exec(metadata.version);
if (!version || version.slice(1).some(part => part && Number(part) > 65535)) throw new Error('Unsupported installer version.');
const nativeVersion = `${version[1]}.${version[2]}.${version[3]}.${version[4] || '0'}`;
const stage = path.resolve(process.argv[2] || path.join(root, 'release', `rele-${metadata.version}-windows-x64`));
for (const file of ['runtime/node.exe', 'dist/server/main.js', 'dist/web/index.html', 'dist/native/Rele.Process.exe', 'manifest.json']) await access(path.join(stage, file));
const stagedMetadata = JSON.parse(await readFile(path.join(stage, 'package.json'), 'utf8'));
if (stagedMetadata.version !== metadata.version) throw new Error('Installer stage and package versions do not match.');
const output = path.join(root, 'release');
const temporary = await mkdtemp(path.join(tmpdir(), 'Rele installer build '));

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited ${result.status}.`);
}
async function find(candidates, label) {
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error(`${label} was not found on this Windows runner.`);
}

try {
  const compiler = await findCSharpCompiler();
  const inno = await find([
    process.env.RELE_ISCC,
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
  ], 'Inno Setup 6');
  const assembly = path.join(temporary, 'AssemblyInfo.cs');
  await writeFile(assembly, `using System.Reflection;\n[assembly: AssemblyTitle("Rele")]\n[assembly: AssemblyProduct("Rele")]\n[assembly: AssemblyVersion("${nativeVersion}")]\n[assembly: AssemblyFileVersion("${nativeVersion}")]\n[assembly: AssemblyInformationalVersion("${metadata.version}")]\n`);
  run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
    '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', '/r:System.Management.dll', '/r:Microsoft.CSharp.dll',
    `/out:${path.join(stage, 'Rele.exe')}`, path.join(root, 'scripts', 'windows', 'Rele.cs'), assembly]);
  run(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/codepage:65001',
    '/r:System.Web.Extensions.dll', `/out:${path.join(stage, 'Rele.Codex.exe')}`,
    path.join(root, 'scripts', 'windows', 'Codex.cs'), assembly]);
  const setupScript = path.join(temporary, 'rele.iss');
  await writeFile(setupScript, '\uFEFF' + await readFile(path.join(root, 'scripts', 'windows', 'rele.iss'), 'utf8'));
  run(inno, ['/Qp', `/DStageDir=${stage}`, `/DAppVersion=${metadata.version}`, `/DNativeVersion=${nativeVersion}`,
    `/DOutputDir=${output}`, setupScript]);
  const installer = path.join(output, `rele-${metadata.version}-windows-x64-setup.exe`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(installer)) hash.update(chunk);
  await writeFile(`${installer}.sha256`, `${hash.digest('hex')}  ${path.basename(installer)}\n`);
  console.log(`Windows installer: ${installer}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
