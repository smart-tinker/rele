import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';
import type { AudioAttachment } from '../shared/types.js';
import type { Channel } from './channels/common.js';

function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'VIRTUAL_ENV', 'LD_LIBRARY_PATH']);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    allowed.has(key.toUpperCase()) || /^(?:CUDA_|CUDNN_|OMP_|MKL_|OPENBLAS_)/u.test(key)));
  return { ...environment, PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1' };
}

export async function transcribeAudio(audio: AudioAttachment, channel: Channel, config: AppConfig['voice'], temporaryRoot: string, signal?: AbortSignal): Promise<string> {
  if (!config.enabled) throw new Error('Локальное распознавание голосовых отключено. Включите его в настройках Rele.');
  if (signal?.aborted) throw new Error('Распознавание остановлено.');
  if (!path.isAbsolute(config.model) || !(await stat(config.model).catch(() => null))?.isDirectory()) throw new Error('Каталог локальной модели распознавания недоступен.');
  const directory = await mkdtemp(path.join(temporaryRoot, 'voice-'));
  try {
    const file = path.join(directory, 'input.audio');
    await channel.download(audio, file);
    if (signal?.aborted) throw new Error('Распознавание остановлено.');
    const script = fileURLToPath(new URL('../../scripts/transcribe.py', import.meta.url));
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(config.python, [script, '--input', file, '--model', config.model, '--language', config.language, '--device', config.device], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: workerEnvironment(),
      });
      let output = '';
      let finished = false;
      let stopping: Error | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const finish = (error?: Error, text?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(text!);
      };
      const stop = (error: Error) => {
        if (finished || stopping) return;
        stopping = error;
        child.kill();
        // Wait for close before deleting the input: Windows keeps open files locked.
        killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 2_000);
        killTimer.unref();
      };
      const abort = () => stop(new Error('Распознавание остановлено.'));
      const timer = setTimeout(() => stop(new Error('Локальное распознавание превысило лимит 10 минут.')), 600_000);
      timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        if (finished || stopping) return;
        if (output.length + chunk.length > 200_000) stop(new Error('Результат распознавания слишком длинный.'));
        else output += chunk;
      });
      child.stderr.resume();
      child.once('error', () => finish(new Error('Не удалось запустить Python. Проверьте окружение faster-whisper.')));
      child.once('close', code => {
        if (stopping) { finish(stopping); return; }
        if (code !== 0) { finish(new Error('Локальное распознавание не выполнено. Проверьте модель и зависимости Python.')); return; }
        try {
          const result = JSON.parse(output) as { text?: unknown };
          if (typeof result.text !== 'string' || !result.text.trim()) throw new Error();
          finish(undefined, result.text.trim().slice(0, 50_000));
        } catch { finish(new Error('В аудио не удалось распознать речь.')); }
      });
    });
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
