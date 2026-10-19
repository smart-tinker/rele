import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function findCSharpCompiler() {
  for (const framework of ['Framework64', 'Framework']) {
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    try { await access(compiler); return compiler; } catch {}
  }
  throw new Error('.NET Framework C# compiler was not found on this Windows runner.');
}

export async function buildProcessHost(output = path.join(root, 'dist', 'native', 'Rele.Process.exe')) {
  if (process.platform !== 'win32') return;
  if (process.arch !== 'x64') throw new Error('Build the native process host on a Windows x64 runner.');
  const compiler = await findCSharpCompiler();
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/u.exec(metadata.version);
  if (!version || version.slice(1).some(part => part && Number(part) > 65535)) throw new Error('Unsupported native process host version.');
  const nativeVersion = `${version[1]}.${version[2]}.${version[3]}.${version[4] || '0'}`;
  const temporary = await mkdtemp(path.join(tmpdir(), 'Rele process host build '));
  try {
    const assembly = path.join(temporary, 'AssemblyInfo.cs');
    await writeFile(assembly, `using System.Reflection;\n[assembly: AssemblyTitle("Rele Process Host")]\n[assembly: AssemblyProduct("Rele")]\n[assembly: AssemblyVersion("${nativeVersion}")]\n[assembly: AssemblyFileVersion("${nativeVersion}")]\n[assembly: AssemblyInformationalVersion("${metadata.version}")]\n`);
    const compiled = path.join(temporary, 'Rele.Process.exe');
    const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/codepage:65001',
      `/out:${compiled}`, path.join(root, 'scripts', 'windows', 'ProcessHost.cs'), assembly], { stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Native process host compilation exited ${result.status}.`);
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(compiled, output);
    console.log(`Windows process host: ${output}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildProcessHost(process.argv[2] && path.resolve(process.argv[2]));
}
