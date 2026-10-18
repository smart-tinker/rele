import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';
import type { AudioAttachment } from '../shared/types.js';
import type { Channel } from './channels/common.js';

export async function transcribeAudio(audio: AudioAttachment, channel: Channel, config: AppConfig['voice'], temporaryRoot: string, signal?: AbortSignal): Promise<string> {
  if (!config.enabled) throw new Error('Локальное распознавание голосовых отключено. Включите его в настройках Rele.');
  if (!path.isAbsolute(config.model) || !(await stat(config.model).catch(() => null))?.isDirectory()) throw new Error('Каталог локальной модели распознавания недоступен.');
  const directory = await mkdtemp(path.join(temporaryRoot, 'voice-'));
  try {
    const file = path.join(directory, 'input.audio');
    await channel.download(audio, file);
    if (signal?.aborted) throw new Error('Распознавание остановлено.');
    const script = fileURLToPath(new URL('../../../scripts/transcribe.py', import.meta.url));
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(config.python, [script, '--input', file, '--model', config.model, '--language', config.language, '--device', config.device], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
      });
      let output = '';
      let finished = false;
      const finish = (error?: Error, text?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) { child.kill(); reject(error); } else resolve(text!);
      };
      const abort = () => finish(new Error('Распознавание остановлено.'));
      const timer = setTimeout(() => finish(new Error('Локальное распознавание превысило лимит 10 минут.')), 600_000);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
        if (output.length > 200_000) finish(new Error('Результат распознавания слишком длинный.'));
      });
      child.stderr.resume();
      child.once('error', () => finish(new Error('Не удалось запустить Python. Проверьте окружение faster-whisper.')));
      child.once('close', code => {
        if (code !== 0) { finish(new Error('Локальное распознавание не выполнено. Проверьте модель и зависимости Python.')); return; }
        try {
          const result = JSON.parse(output) as { text?: unknown };
          if (typeof result.text !== 'string' || !result.text.trim()) throw new Error();
          finish(undefined, result.text.trim().slice(0, 50_000));
        } catch { finish(new Error('В аудио не удалось распознать речь.')); }
      });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
