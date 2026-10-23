import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';

/** The OS releases this data-directory lock even after a crash or power loss. */
export async function acquireGatewayLock(directory: string): Promise<Server> {
  const name = createHash('sha256').update(await realpath(directory)).digest('hex').slice(0, 24);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\rele-${name}` : `\0rele-${name}`;
  const lock = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    lock.once('error', () => reject(new Error('Rele уже запущен с этим каталогом данных.')));
    lock.listen(address, resolve);
  });
  return lock;
}
