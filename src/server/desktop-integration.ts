import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DesktopIntegrationState } from '../shared/types.js';

const unavailable: DesktopIntegrationState = { available: false, enabled: false, lastCheckFailed: false };
const execute = promisify(execFile);
type Installation = { DesktopIntegrationOwned: boolean; DesktopIntegrationRequested?: boolean | null; DesktopIntegrationWarning?: unknown };

async function runLauncher(executable: string, args: string[]): Promise<void> {
  await execute(executable, args, { windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1024 });
}

/** Installer metadata records intent; it does not prove a running Desktop uses the adapter. */
export class DesktopIntegration {
  constructor(
    private readonly root: string,
    private readonly directory: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly run = runLauncher,
  ) {}

  private async installation(): Promise<Installation | undefined> {
    if (this.platform !== 'win32') return;
    try {
      const file = path.join(this.root, 'rele-install.json');
      if ((await stat(file)).size > 64 * 1024 || !(await stat(path.join(this.root, 'Rele.exe'))).isFile()) return;
      const marker = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      if (typeof marker.DataDirectory !== 'string' || typeof marker.OwnerSid !== 'string' || !/^S-1-\d+(?:-\d+)+$/u.test(marker.OwnerSid) ||
          typeof marker.TaskName !== 'string' || !/^Rele-[A-Za-z0-9._-]{1,120}$/u.test(marker.TaskName) ||
          typeof marker.DesktopIntegrationOwned !== 'boolean' ||
          marker.DesktopIntegrationRequested != null && typeof marker.DesktopIntegrationRequested !== 'boolean') return;
      const [installed, running] = await Promise.all([realpath(marker.DataDirectory), realpath(this.directory)]);
      if (installed.toLowerCase() !== running.toLowerCase()) return;
      return marker as Installation;
    } catch { return; }
  }

  async status(): Promise<DesktopIntegrationState> {
    const marker = await this.installation();
    return marker ? { available: true, enabled: marker.DesktopIntegrationOwned, lastCheckFailed: typeof marker.DesktopIntegrationWarning === 'string' && !!marker.DesktopIntegrationWarning } : { ...unavailable };
  }

  async shouldRetry(): Promise<boolean> {
    const marker = await this.installation();
    return marker?.DesktopIntegrationRequested === true && !marker.DesktopIntegrationOwned;
  }

  async setEnabled(enabled: boolean, retry = false): Promise<DesktopIntegrationState> {
    if (!(await this.status()).available) throw new Error('Управление интеграцией доступно в установленном Rele для Windows с этим каталогом данных.');
    try {
      // The native launcher checks the current SID, foreign environment values and Codex readiness.
      await this.run(path.join(this.root, 'Rele.exe'), [enabled ? 'desktop-integrate' : 'desktop-unintegrate', '--quiet', '--data-dir', this.directory,
        ...(retry ? ['--retry-desktop-integration'] : [])]);
    } catch {
      // Native warnings can contain private paths or settings; never return their raw contents.
      throw new Error(enabled
        ? 'Не удалось подключить обычный запуск Desktop. Проверьте подключение Codex и конфликтующие настройки Desktop, затем повторите попытку.'
        : 'Не удалось отключить интеграцию Desktop. Проверьте установку Rele и повторите попытку.');
    }
    const state = await this.status();
    if (!state.available || !retry && state.enabled !== enabled) throw new Error('Установка Rele не подтвердила изменение интеграции Desktop. Обновите её состояние перед повторной попыткой.');
    return state;
  }
}
