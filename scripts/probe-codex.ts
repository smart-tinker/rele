import { parseArgs } from 'node:util';
import { CodexClient } from '../src/server/codex.js';
import { SUPPORTED_CODEX_VERSIONS } from '../src/shared/codex-runtime.js';
import type { CodexTransport } from '../src/shared/types.js';

const { values } = parseArgs({ options: {
  transport: { type: 'string', default: 'proxy' },
  executable: { type: 'string', default: 'codex' },
  endpoint: { type: 'string', default: '' },
  'codex-home': { type: 'string' },
  thread: { type: 'string' },
  archived: { type: 'boolean' },
  refresh: { type: 'boolean' },
  'token-env': { type: 'string' },
  help: { type: 'boolean' },
} });

if (values.help) {
  console.log(`Read-only catalog probe for Rele (tested Codex ${SUPPORTED_CODEX_VERSIONS.join(', ')}).

npm run probe:codex -- --transport managed [--executable /path/to/codex] [--codex-home /path/to/profile]
npm run probe:codex -- --transport proxy [--executable /path/to/codex] [--endpoint /path/to/socket]
npm run probe:codex -- --transport websocket --endpoint ws://127.0.0.1:4500 [--token-env CODEX_SERVER_TOKEN]

Optional --thread UUID reads existing thread metadata without resuming it.
Optional --archived lists archived metadata without restoring conversations.
Optional --refresh scans rollouts to refresh the Codex metadata index; defaults to the fast indexed catalog.
Managed starts an owned child and closes it after reading. Other modes attach to an existing server.
This probe does not create or resume threads, submit model input, or change authentication.
The runtime PID and CODEX_HOME help compare two attachments; Windows Desktop live verification is separate.`);
} else {
  if (!['managed', 'proxy', 'websocket'].includes(values.transport!)) throw new Error('--transport must be managed, proxy or websocket.');
  const token = values['token-env'] ? process.env[values['token-env']] : undefined;
  if (values['token-env'] && !token) throw new Error('The selected token environment variable is empty.');
  const client = new CodexClient({
    transport: values.transport as CodexTransport, executable: values.executable!, endpoint: values.endpoint, token, codexHome: values['codex-home'],
  });
  try {
    await client.connect();
    const runtime = client.runtimeInfo();
    const diagnostics = await client.diagnostics();
    const threads = await client.listThreads({ archived: values.archived, refresh: values.refresh });
    const thread = values.thread ? await client.readThread(values.thread) : undefined;
    console.log(JSON.stringify({
      status: client.status(), runtime, runtimeProcessId: diagnostics.process.id,
      threadCount: threads.length, ...(thread ? { thread } : {}),
      checks: { attachedToExistingServer: values.transport !== 'managed', managedChild: values.transport === 'managed', mutatingRequestsSent: false, desktopLiveVerified: false,
        ...(values.thread ? { requestedThreadListed: threads.some(candidate => candidate.id === values.thread) } : {}),
      },
    }, null, 2));
    if (!client.status().queueSupported) process.exitCode = 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(token ? message.split(token).join('[redacted]') : message);
    process.exitCode = 1;
  } finally { await client.close(); }
}
