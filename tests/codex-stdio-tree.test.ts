import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { CodexStdioTransport } from '../src/server/codex-stdio.js';

async function isRunning(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // An orphan may await reaping by PID 1, but a zombie cannot keep pipes open.
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      return !['Z', 'X', 'x'].includes(state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

test('close waits for the owned root and its grandchild to stop even when the grandchild inherits both output pipes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'Rele stdio tree '));
  const rootScript = path.join(directory, 'root.cjs');
  const grandchildScript = path.join(directory, 'grandchild.cjs');
  const grandchildSource = String.raw`
    process.stdout.write(JSON.stringify({ kind: 'grandchild-ready', pid: process.pid, parentPid: process.ppid }) + '\n');
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(90), 30000).unref();
  `;
  const rootSource = `
    const { spawn } = require('node:child_process');
    const report = value => process.stdout.write(JSON.stringify(value) + '\\n');
    report({ kind: 'root', pid: process.pid });
    const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], {
      stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true
    });
    grandchild.once('spawn', () => report({ kind: 'grandchild-started', pid: grandchild.pid }));
    grandchild.once('error', () => process.exit(91));
    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
    setTimeout(() => process.exit(92), 30000).unref();
  `;
  await Promise.all([
    writeFile(rootScript, rootSource),
    writeFile(grandchildScript, grandchildSource),
  ]);
  // The fixture expires only as a safety net if the test runner itself is killed.
  const ownedPids = new Set<number>();
  let rootPid: number | undefined;
  let grandchildPid: number | undefined;
  let grandchildParentPid: number | undefined;
  let grandchildReady = false;
  let closed = 0;
  let stderr = '';
  const failures: string[] = [];
  const transport = new CodexStdioTransport(
    process.execPath, [rootScript], process.env,
    {
      message: raw => {
        const message = JSON.parse(raw) as { kind: string; pid: number; parentPid?: number };
        if (!Number.isSafeInteger(message.pid) || message.pid <= 0 || message.pid === process.pid) return;
        if (message.kind === 'root') rootPid = message.pid;
        else if (message.kind === 'grandchild-started' || message.kind === 'grandchild-ready') {
          grandchildPid = message.pid;
          if (message.kind === 'grandchild-ready') {
            grandchildReady = true;
            grandchildParentPid = message.parentPid;
          }
        } else return;
        ownedPids.add(message.pid);
      },
      stderr: chunk => { stderr += chunk; },
      failure: error => failures.push(error.code),
      closed: () => { closed += 1; },
    },
  );
  let closing: Promise<void> | undefined;
  try {
    await bounded(transport.ready, 4000, 'The fixture root did not spawn');
    await expect.poll(
      () => rootPid && grandchildReady ? 'ready' : stderr || JSON.stringify({ rootPid, grandchildPid, failures }),
      { timeout: 4000, interval: 20 },
    ).toBe('ready');
    expect(grandchildParentPid).toBe(rootPid);
    expect(grandchildPid).not.toBe(rootPid);
    expect(await Promise.all([...ownedPids].map(isRunning))).toEqual([true, true]);
    closing = transport.close();
    await bounded(closing, 16000, 'Transport close did not finish within its shutdown deadline');
    expect(closed).toBe(1);
    expect(failures).toEqual([]);
    await expect.poll(() => Promise.all([...ownedPids].map(isRunning)), { timeout: 2000, interval: 20 })
      .toEqual([false, false]);
  } finally {
    const cleanup = async () => {
      // These two IDs came only from our fixture; never kill by executable name.
      for (const pid of [...ownedPids].reverse()) {
        if (!await isRunning(pid)) continue;
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      const deadline = Date.now() + 2000;
      while ((await Promise.all([...ownedPids].map(isRunning))).some(Boolean)) {
        if (Date.now() >= deadline) throw new Error('Owned fixture PID survived SIGKILL');
        await delay(20);
      }
      await (closing ?? transport.close()).catch(() => {});
    };
    try { await bounded(cleanup(), 18000, 'The fixture processes did not finish emergency cleanup'); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}, 45000);
