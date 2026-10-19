import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
// Windows enumerates and terminates a whole process tree. Its helper must not be
// interrupted by the shorter Unix SIGTERM escalation timer.
const WINDOWS_SHUTDOWN_TIMEOUT_MS = 15_000;

export class CodexStdioError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'CodexStdioError'; }
}

interface StdioCallbacks {
  message: (line: string) => void;
  stderr: (chunk: string) => void;
  failure: (error: CodexStdioError) => void;
  closed: () => void;
}

interface StdioOptions {
  maxFrameBytes?: number;
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
}

/** One owned foreground child. Its stdout is NDJSON, never a WebSocket stream. */
export class CodexStdioTransport {
  readonly ready: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private readonly chunks: Buffer[] = [];
  private frameBytes = 0;
  private spawned = false;
  private rootExited = false;
  private ended = false;
  private stopping = false;
  private failed = false;
  private shutdown?: Promise<void>;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv, private readonly callbacks: StdioCallbacks, private readonly options: StdioOptions = {}) {
    this.child = (options.spawnProcess ?? spawn)(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true,
      // A private Unix process group lets us also stop the official npm wrapper's child.
      // The process remains attached to Rele through its pipes and is never unref'ed.
      detached: (options.platform ?? process.platform) !== 'win32',
    });
    this.ready = new Promise((resolve, reject) => {
      this.child.once('spawn', () => { this.spawned = true; resolve(); });
      this.child.once('error', () => reject(new CodexStdioError('Не удалось запустить выбранный Codex CLI.', 'cli-unavailable')));
    });
    this.exited = new Promise(resolve => this.child.once('close', () => {
      this.ended = true;
      resolve();
      this.callbacks.closed();
    }));
    this.child.once('exit', () => { this.rootExited = true; });
    this.child.on('error', () => this.fail('Не удалось запустить выбранный Codex CLI.', 'cli-unavailable'));
    this.child.stdin.on('error', () => this.fail('Соединение с управляемым Codex прервано; неподтверждённые запросы требуют сверки.', 'connection-closed'));
    this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    this.child.stdout.once('end', () => {
      if (!this.stopping && this.frameBytes) this.fail('Codex завершил неполное сообщение протокола.', 'invalid-protocol');
    });
    this.child.stdout.on('error', () => this.fail('Не удалось прочитать сообщение управляемого Codex.', 'connection-closed'));
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => this.callbacks.stderr(chunk));
  }

  send(raw: string): Promise<void> {
    if (!this.spawned || this.stopping || this.ended || this.child.stdin.destroyed) {
      return Promise.reject(new CodexStdioError('Codex не подключён.', 'connection-closed'));
    }
    if (Buffer.byteLength(raw, 'utf8') > (this.options.maxFrameBytes ?? MAX_FRAME_BYTES)) {
      return Promise.reject(new CodexStdioError('Сообщение Codex превышает допустимый размер.', 'frame-too-large'));
    }
    return new Promise((resolve, reject) => this.child.stdin.write(`${raw}\n`, error => error
      ? reject(new CodexStdioError('Codex не подтвердил передачу сообщения; требуется сверка.', 'connection-closed')) : resolve()));
  }

  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopping = true;
    this.shutdown = this.stop();
    return this.shutdown;
  }

  private read(chunk: Buffer): void {
    if (this.stopping || this.failed) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const part = chunk.subarray(start, newline === -1 ? chunk.length : newline);
      this.frameBytes += part.length;
      if (this.frameBytes > (this.options.maxFrameBytes ?? MAX_FRAME_BYTES)) {
        this.fail('Сообщение Codex превышает допустимый размер.', 'frame-too-large');
        return;
      }
      this.chunks.push(part);
      if (newline === -1) return;
      const frame = Buffer.concat(this.chunks, this.frameBytes);
      this.chunks.length = 0;
      this.frameBytes = 0;
      let raw: string;
      try { raw = new TextDecoder('utf-8', { fatal: true }).decode(frame); }
      catch { this.fail('Codex вернул некорректное сообщение UTF-8.', 'invalid-protocol'); return; }
      if (raw.trim()) this.callbacks.message(raw);
      if (this.stopping || this.failed) return;
      start = newline + 1;
    }
  }

  private fail(message: string, code: string): void {
    if (this.failed || this.stopping) return;
    this.failed = true;
    this.callbacks.failure(new CodexStdioError(message, code));
  }

  private async stop(): Promise<void> {
    if (this.ended) return;
    const pid = this.child.pid;
    if (pid && (this.options.platform ?? process.platform) === 'win32') return this.stopWindows(pid);
    const killGroup = (signal: NodeJS.Signals) => {
      if (this.ended || !pid) return;
      try { process.kill(-pid, signal); }
      catch { this.child.kill(signal); }
    };
    if (pid) killGroup('SIGTERM');
    this.child.stdin.end();
    let forceTimer: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    try {
      forceTimer = setTimeout(() => killGroup('SIGKILL'), 2_000);
      forceTimer.unref();
      await Promise.race([
        this.exited,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new CodexStdioError('Не удалось подтвердить остановку управляемого Codex. Новый процесс не будет запущен до перезапуска Rele.', 'shutdown-timeout')), 4_000);
          deadline.unref();
        }),
      ]);
    } finally {
      clearTimeout(forceTimer);
      clearTimeout(deadline);
    }
  }

  private async stopWindows(pid: number): Promise<void> {
    // Keep stdin open until /T finishes: EOF can make Codex or the npm wrapper
    // exit before taskkill enumerates its descendants, losing the root PID.
    let treeKill: ReturnType<typeof spawn> | undefined;
    let helperEnded = true;
    let deadline: NodeJS.Timeout | undefined;
    let treeStopped: Promise<void> = Promise.resolve();
    // An exited root can leave inherited pipes open. Its PID may be reused, so
    // never issue a new kill by that PID; wait for close or fail the deadline.
    if (!this.rootExited && this.child.exitCode == null && this.child.signalCode == null) {
      treeKill = (this.options.spawnProcess ?? spawn)('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      helperEnded = false;
      treeStopped = new Promise<void>((resolve, reject) => {
        treeKill!.once('error', () => {
          helperEnded = true;
          reject(new CodexStdioError('Windows не смог запустить остановку дерева управляемого Codex. Новый процесс не будет запущен до перезапуска Rele.', 'shutdown-failed'));
        });
        treeKill!.once('close', code => {
          helperEnded = true;
          if (code !== 0) reject(new CodexStdioError('Windows не подтвердил остановку дерева управляемого Codex. Новый процесс не будет запущен до перезапуска Rele.', 'shutdown-failed'));
          else resolve();
        });
      }).then(() => { this.child.stdin.end(); });
    }
    try {
      await Promise.race([
        // A successful taskkill is insufficient while inherited pipes are open;
        // likewise, direct-child close alone cannot establish tree-kill success.
        Promise.all([treeStopped, this.exited]),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new CodexStdioError('Не удалось подтвердить остановку дерева управляемого Codex за 15 секунд. Новый процесс не будет запущен до перезапуска Rele.', 'shutdown-timeout')), WINDOWS_SHUTDOWN_TIMEOUT_MS);
          deadline.unref();
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      // Only the overall failure deadline may stop our helper. Never replace an
      // incomplete tree operation with a direct-parent kill and report success.
      if (!helperEnded) treeKill?.kill();
    }
  }
}
