import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build the Debian package on Linux x64.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.resolve(process.argv[2]);
const metadata = JSON.parse(await readFile(path.join(stage, 'package.json'), 'utf8'));
const version = metadata.version.replace('-rc.', '~rc.');
const output = path.join(root, 'release');
const packageRoot = path.join(output, 'debian-stage');
await rm(packageRoot, { recursive: true, force: true });
for (const directory of ['DEBIAN', 'opt', 'usr/bin', 'usr/lib/systemd/system']) await mkdir(path.join(packageRoot, directory), { recursive: true });
await cp(stage, path.join(packageRoot, 'opt/rele'), { recursive: true });
await copyFile(path.join(root, 'scripts/linux-service.mjs'), path.join(packageRoot, 'opt/rele/scripts/linux-service.mjs'));
for (const file of ['rele', 'rele-codex', 'rele.service', 'rele-codex.service', 'rele-codex.timer', 'postinst', 'prerm', 'postrm']) {
  const unit = /\.(service|timer)$/u.test(file);
  const destination = file.startsWith('rele') ? (unit ? `usr/lib/systemd/system/${file}` : `usr/bin/${file}`) : `DEBIAN/${file}`;
  await copyFile(path.join(root, 'scripts/linux', file), path.join(packageRoot, destination));
  await chmod(path.join(packageRoot, destination), unit ? 0o644 : 0o755);
}
const size = spawnSync('du', ['-sk', path.join(packageRoot, 'opt')], { encoding: 'utf8' });
if (size.status !== 0) throw new Error('Cannot calculate Debian installed size.');
await writeFile(path.join(packageRoot, 'DEBIAN/control'), `Package: rele\nVersion: ${version}\nSection: utils\nPriority: optional\nArchitecture: amd64\nMaintainer: smart-tinker <maintainers@example.invalid>\nDepends: libc6 (>= 2.28), libstdc++6, systemd, util-linux\nInstalled-Size: ${Number(size.stdout.split(/\s/u)[0])}\nHomepage: https://github.com/smart-tinker/rele\nDescription: Local Slack and Telegram gateway for shared Codex conversations\n Includes the Node.js runtime. Runs as the selected Codex owner.\n Application removal preserves that user's configuration and conversations.\n`);
// The public root-owned payload must not inherit private build-checkout permissions.
const pending = [packageRoot];
while (pending.length) {
  const entry = pending.pop();
  const info = await lstat(entry);
  if (info.isSymbolicLink()) continue;
  if (info.isDirectory()) {
    await chmod(entry, 0o755);
    for (const name of await readdir(entry)) pending.push(path.join(entry, name));
  } else if (info.isFile()) {
    await chmod(entry, info.mode & 0o111 ? 0o755 : 0o644);
  } else throw new Error(`Unexpected Debian payload file type: ${path.relative(packageRoot, entry)}`);
}
const artifact = path.join(output, `rele-${metadata.version}-linux-x64.deb`);
const result = spawnSync('dpkg-deb', ['--root-owner-group', '--build', packageRoot, artifact], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('Building the Debian package failed.');
const hash = createHash('sha256');
for await (const chunk of createReadStream(artifact)) hash.update(chunk);
await writeFile(`${artifact}.sha256`, `${hash.digest('hex')}  ${path.basename(artifact)}\n`);
console.log(`Ubuntu installer: ${artifact}`);
