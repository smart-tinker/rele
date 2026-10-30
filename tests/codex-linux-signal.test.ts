import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile), helper = fileURLToPath(new URL('../scripts/linux/rele-codex-signal.py', import.meta.url));
describe.skipIf(process.platform !== 'linux')('exact Linux pidfd helper', () => {
  it('reports capability and refuses a mismatched process birth before sending SIGHUP', async () => {
    const checked = await execute('/usr/bin/python3', ['-I', helper, '--check']); expect(JSON.parse(checked.stdout)).toEqual({ supported: true });
    const raw = await readFile(`/proc/${process.pid}/stat`, 'utf8'), birth = raw.slice(raw.lastIndexOf(') ') + 2).split(/\s+/u)[19];
    const wrongBirth = String(BigInt(birth) + 1n), executable = await readlink(`/proc/${process.pid}/exe`);
    await expect(execute('/usr/bin/python3', ['-I', helper, '--signal', String(process.pid), wrongBirth, String(process.getuid!()), executable, 'a'.repeat(64)]))
      .rejects.toMatchObject({ code: 1, stdout: '{"status": "refused"}\n' });
  });
  it.each(['direct', 'published-link'])('counts only clients attached to its exact owned %s UDS listener', async kind => {
    const directory = await mkdtemp(path.join(tmpdir(), 'rlp-')), endpoint = path.join(directory, 'c/app-server-control.sock'), bound = kind === 'direct' ? endpoint : path.join(directory, 'native.sock');
    await mkdir(path.dirname(endpoint));
    const accepted = new Set<Socket>(), server = createServer(socket => { accepted.add(socket); socket.once('close', () => accepted.delete(socket)); });
    let client: Socket | undefined;
    const peers = async () => JSON.parse((await execute('/usr/bin/python3', ['-I', helper, '--peers', String(process.pid), endpoint])).stdout);
    try {
      server.listen(bound); await once(server, 'listening');
      if (kind === 'published-link') await symlink(bound, endpoint);
      expect(await peers()).toEqual({ listener: true, peers: 0 });
      const connected = once(server, 'connection'); client = createConnection(endpoint); await once(client, 'connect'); await connected;
      expect(await peers()).toEqual({ listener: true, peers: 1 });
      await expect(execute('/usr/bin/python3', ['-I', helper, '--peers', String(process.pid), path.join(directory, 'different.sock')])).rejects.toMatchObject({ code: 1 });
    } finally {
      client?.destroy(); for (const socket of accepted) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
    }
  });
});
