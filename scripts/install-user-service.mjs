import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') throw new Error('This installer is for a Linux systemd user session.');
const releaseDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unitDirectory = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'systemd', 'user');
const unitPath = path.join(unitDirectory, 'rele.service');
const remove = process.argv.includes('--remove');
const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('\n', '\\n') + '"';
function systemctl(args) {
  const result = spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('systemctl --user failed. Run this installer in the Codex owner’s login session.');
}

if (remove) {
  systemctl(['disable', '--now', 'rele.service']);
  await rm(unitPath, { force: true });
  systemctl(['daemon-reload']);
  console.log('Rele user service removed; saved data is unchanged.');
} else {
  const environment = ['PATH', 'CODEX_HOME', 'RELE_DATA_DIR']
    .filter(key => process.env[key]).map(key => `Environment=${quote(`${key}=${process.env[key]}`)}`).join('\n');
  await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
  await writeFile(unitPath, `[Unit]
Description=Rele local Codex gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=${quote(releaseDirectory)}
ExecStart=${quote(path.join(releaseDirectory, 'runtime', 'node'))} ${quote(path.join(releaseDirectory, 'dist', 'server', 'main.js'))}
${environment}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`, { mode: 0o600 });
  systemctl(['daemon-reload']);
  systemctl(['enable', '--now', 'rele.service']);
  console.log('Rele runs as the current user. View its panel address with: journalctl --user -u rele -n 30');
  console.log('To keep the user session running after logout, enable lingering for this user through the server administrator.');
}
