import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/server/channels/common.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
import { transcribeAudio } from '../src/server/voice.js';

class Worker extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
  finish(code: number, output = ''): void {
    this.stdout.end(output); this.stderr.end(); this.emit('close', code);
  }
}
let directory: string, model: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'rele-voice-test-'));
  model = path.join(directory, 'model with spaces ; literal');
  await mkdir(model);
  mocks.spawn.mockReset();
});
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const audio = { platform: 'telegram' as const, fileId: 'fixture-audio', name: 'voice.ogg' };
function setup(download?: (_audio: typeof audio, destination: string) => Promise<void>) {
  const worker = new Worker();
  let announce: () => void = () => {};
  const started = new Promise<void>(resolve => { announce = resolve; });
  mocks.spawn.mockImplementation(() => { announce(); return worker; });
  const channel = { download: vi.fn(download ?? (async (_audio, destination) => { await writeFile(destination, 'synthetic audio'); })) } as unknown as Channel;
  const config = { enabled: true, python: 'configured-python', model, language: 'ru', device: 'cpu' as const };
  return { worker, started, channel, config };
}
async function voiceDirectories() { return (await readdir(directory)).filter(name => name.startsWith('voice-')); }

describe('local voice worker boundaries', () => {
  it('passes literal argument paths, forces offline mode, and omits API credentials', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-openai-secret');
    vi.stubEnv('HF_TOKEN', 'synthetic-hub-secret');
    vi.stubEnv('SLACK_BOT_TOKEN', 'synthetic-slack-secret');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic-aws-secret');
    vi.stubEnv('RELE_PANEL_TOKEN', 'synthetic-panel-secret');
    const f = setup();
    const result = transcribeAudio(audio, f.channel, f.config, directory);
    await f.started;
    const [executable, args, options] = mocks.spawn.mock.calls[0];
    expect(executable).toBe('configured-python');
    expect(args).toEqual([expect.stringMatching(/scripts[/\\]transcribe\.py$/u), '--input', expect.any(String), '--model', model, '--language', 'ru', '--device', 'cpu']);
    expect(options).toMatchObject({ shell: false, windowsHide: true, env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1' } });
    expect(JSON.stringify(options.env)).not.toContain('synthetic-');
    const inputFile = args[2] as string;
    expect(await readFile(inputFile, 'utf8')).toBe('synthetic audio');
    f.worker.finish(0, JSON.stringify({ text: '  Распознанный запрос  ' }));
    expect(await result).toBe('Распознанный запрос');
    expect(await voiceDirectories()).toEqual([]);
  });

  it('cleans partial downloads without starting Python', async () => {
    const f = setup(async (_audio, destination) => {
      await writeFile(destination, 'partial bytes');
      throw new Error('Download failed');
    });
    await expect(transcribeAudio(audio, f.channel, f.config, directory)).rejects.toThrow('Download failed');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(await voiceDirectories()).toEqual([]);
  });

  it('does not download disabled, missing-model, or already cancelled requests', async () => {
    const f = setup();
    await expect(transcribeAudio(audio, f.channel, { ...f.config, enabled: false }, directory)).rejects.toThrow('отключено');
    await expect(transcribeAudio(audio, f.channel, { ...f.config, model: path.join(directory, 'missing') }, directory)).rejects.toThrow('модели');
    const abort = new AbortController(); abort.abort();
    await expect(transcribeAudio(audio, f.channel, f.config, directory, abort.signal)).rejects.toThrow('остановлено');
    expect(f.channel.download).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('stops after a cancellation during download and removes its input', async () => {
    const abort = new AbortController();
    const f = setup(async (_audio, destination) => { await writeFile(destination, 'partial'); abort.abort(); });
    await expect(transcribeAudio(audio, f.channel, f.config, directory, abort.signal)).rejects.toThrow('остановлено');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(await voiceDirectories()).toEqual([]);
  });

  it('waits for worker close before removing a cancelled input (Windows file locks)', async () => {
    const abort = new AbortController(), f = setup();
    const result = transcribeAudio(audio, f.channel, f.config, directory, abort.signal);
    const rejected = expect(result).rejects.toThrow('остановлено');
    await f.started;
    abort.abort();
    expect(f.worker.kill).toHaveBeenCalledOnce();
    expect(await voiceDirectories()).toHaveLength(1);
    f.worker.finish(1);
    await rejected;
    expect(await voiceDirectories()).toEqual([]);
  });

  it('enforces the timeout, escalates an unresponsive worker, and removes audio after close', async () => {
    vi.useFakeTimers();
    const f = setup();
    const result = transcribeAudio(audio, f.channel, f.config, directory);
    const rejected = expect(result).rejects.toThrow('10 минут');
    await f.started;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.worker.kill).toHaveBeenCalledWith();
    expect(await voiceDirectories()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.worker.kill).toHaveBeenLastCalledWith('SIGKILL');
    f.worker.finish(1);
    await rejected;
    expect(await voiceDirectories()).toEqual([]);
  });

  it('bounds stdout and never includes stderr/audio content in the reported error', async () => {
    const f = setup();
    const result = transcribeAudio(audio, f.channel, f.config, directory);
    const rejected = expect(result).rejects.toThrow('слишком длинный');
    await f.started;
    f.worker.stderr.write('synthetic-private-audio-text and secret');
    f.worker.stdout.write('x'.repeat(200_001));
    expect(f.worker.kill).toHaveBeenCalled();
    f.worker.finish(1);
    await rejected;
    expect(await voiceDirectories()).toEqual([]);
  });

  it.each(['not JSON', JSON.stringify({ text: '' }), JSON.stringify({ text: 42 })])('rejects unusable worker output: %s', async output => {
    const f = setup();
    const result = transcribeAudio(audio, f.channel, f.config, directory);
    const rejected = expect(result).rejects.toThrow('распознать речь');
    await f.started; f.worker.finish(0, output); await rejected;
    expect(await voiceDirectories()).toEqual([]);
  });

  it('cleans the download when the Python executable cannot start', async () => {
    const f = setup();
    const result = transcribeAudio(audio, f.channel, f.config, directory);
    const rejected = expect(result).rejects.toThrow('запустить Python');
    await f.started; f.worker.emit('error', new Error('ENOENT with synthetic environment detail')); await rejected;
    expect(await voiceDirectories()).toEqual([]);
  });
});
