/** Isolated native shared gate driver: real Rele client/engine/store, synthetic channels. */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { summarizeSharedNativeRequest, summarizeSharedWaitFailure } from './shared-probe-diagnostics.mjs';
import { ConfigStore, defaultConfig, defaultDataDirectory } from '../src/server/config.js';
import { CodexClient as SourceCodexClient, type CodexServerRequest } from '../src/server/codex.js';
import { Engine as SourceEngine } from '../src/server/engine.js';
import { Store as SourceStore } from '../src/server/store.js';
import { ensureWindowsSharedCodex, readPreparedDesktopCodexPackage } from '../src/server/codex-shared.js';
import type { Channel } from '../src/server/channels/common.js';
import type { Endpoint, Platform, SlackTranscriptMessage } from '../src/shared/types.js';

const { values } = parseArgs({ options: {
  executable: { type: 'string' }, home: { type: 'string' }, directory: { type: 'string' },
  thread: { type: 'string' }, prepare: { type: 'boolean' }, 'profile-socket': { type: 'string' }, 'expect-error': { type: 'string' },
  'windows-install-dir': { type: 'string' }, 'runtime-directory': { type: 'string' },
} });
const ENGINE_WAIT_TIMEOUT_MS = 90_000;
const emitProbeStage = (probeStage: 'codex-connect' | 'thread-catalog' | 'engine-start' | 'native-diagnostics' | 'desktop-package-verification' | 'ready') =>
  process.stdout.write(JSON.stringify({ probeStage }) + '\n');
if (!values.executable || !values.home || !values.directory || !process.env.RELE_DATA_DIR) throw new Error('Missing isolated fixture paths');
if ((values['windows-install-dir'] || values['runtime-directory']) && process.platform !== 'win32') throw new Error('Windows fixture options require Windows');
if (values['windows-install-dir'] && values['runtime-directory']) throw new Error('Choose source installation seam or packaged default location');
const load = (name: string) => import(pathToFileURL(join(values['runtime-directory']!, 'dist/server', `${name}.js`)).href);
const { CodexClient } = values['runtime-directory'] ? await load('codex') as typeof import('../src/server/codex.js') : { CodexClient: SourceCodexClient };
const { Engine } = values['runtime-directory'] ? await load('engine') as typeof import('../src/server/engine.js') : { Engine: SourceEngine };
const { Store } = values['runtime-directory'] ? await load('store') as typeof import('../src/server/store.js') : { Store: SourceStore };
const configModule = values['runtime-directory'] ? await load('config') as typeof import('../src/server/config.js') : { ConfigStore, defaultConfig, defaultDataDirectory };
// Source gates select their disposable installation through the existing production seam.
// Packaged gates use the compiled module's default installation location, without this seam.
const options = values['windows-install-dir'] ? { shared: (target: Parameters<typeof ensureWindowsSharedCodex>[0], settings: Parameters<typeof ensureWindowsSharedCodex>[1]) => ensureWindowsSharedCodex(target, settings, values['windows-install-dir']) } : {};
const config = { ...structuredClone(configModule.defaultConfig), codex: {
  transport: 'shared' as const, executable: values.executable, endpoint: '', codexHome: values.home,
} };
const saved = new configModule.ConfigStore(configModule.defaultDataDirectory());
await saved.load();
await saved.save(config);
if (values['expect-error']) {
  const client = new CodexClient(config.codex, options);
  try { await client.connect(); } catch { /* Assert the exact production fence below. */ }
  const status = client.status();
  await client.close();
  if (status.connected || status.errorCode !== values['expect-error']) throw new Error('Expected production shared owner fence was not observed');
  process.stdout.write(JSON.stringify({ expectedError: status.errorCode, disconnected: true }) + '\n');
} else if (values['profile-socket']) {
  // Test-only resolver fault: the real native initialize response must still fence another profile.
  const client = new CodexClient(config.codex, { shared: async target => ({
    ...target, transport: values['profile-socket']!.startsWith('ws://') ? 'websocket' : 'proxy', endpoint: values['profile-socket']!,
  }) });
  let rejected = false;
  try { await client.connect(); } catch { rejected = client.status().errorCode === 'shared-profile-mismatch'; }
  const disconnected = !client.status().connected;
  await client.close();
  if (!rejected || !disconnected) throw new Error('Native wrong-profile initialize was not fenced');
  process.stdout.write(JSON.stringify({ profileRejected: true, disconnected }) + '\n');
} else if (values.prepare) {
  process.stdout.write(JSON.stringify({ prepared: true, platform: process.platform }) + '\n');
} else {
  const store = new Store(join(values.directory, 'rele.sqlite'));
  const endpoints = Object.fromEntries((['slack', 'telegram'] as const).map(platform => [platform, {
    id: `shared-${platform}`, platform, accountId: 'fixture-account', chatId: platform === 'slack' ? 'CSHARED' : '-100123',
    threadId: platform === 'slack' ? '1700000000.000000' : '17', title: `Shared ${platform}`, subtitle: 'Synthetic origin',
    people: [{ id: 'fixture-user', name: 'Fixture human' }], updatedAt: new Date().toISOString(),
  } satisfies Endpoint])) as Record<Platform, Endpoint>;
  for (const endpoint of Object.values(endpoints)) store.upsertEndpoint(endpoint);
  const history: SlackTranscriptMessage[] = [{ endpointId: endpoints.slack.id, accountId: endpoints.slack.accountId,
    chatId: endpoints.slack.chatId, threadId: endpoints.slack.threadId, messageId: '1700000000.000001',
    sender: { id: 'fixture-agent', name: 'Other agent', isBot: true }, text: 'shared-passive-agent-context',
    payload: { text: 'shared-passive-agent-context', preserved: { full: true } }, kind: 'message' }];
  const diagnostics: string[] = [];
  const driverOperations: string[] = [];
  const recordDriverOperation = (operation: string) => {
    driverOperations.push(operation);
    if (driverOperations.length > 64) driverOperations.shift();
  };
  const fixtureLabel = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,48}$/u.test(value) ? value : 'other';
  const observe = <TArgs extends unknown[], TResult>(name: string, operation: (...args: TArgs) => Promise<TResult>) => async (...args: TArgs): Promise<TResult> => {
    recordDriverOperation(`${name}:start`);
    try {
      const result = await operation(...args);
      recordDriverOperation(`${name}:done`);
      return result;
    } catch (error) {
      recordDriverOperation(`${name}:error`);
      throw error;
    }
  };
  const observedTurns: Array<{ method: string; threadId: string; turnId: string }> = [];
  const completionObservations: Array<{ eventId: string; status: string; turnMatches: boolean }> = [];
  const reconciliationTrace: Array<{ eventId: string; phase: 'start' | 'done' | 'error'; status: string; completionNotification: boolean; turnProvided: boolean; elapsedMs?: number; errorType?: string }> = [];
  type ReconciliationStage = { operation: 'releaseWait' | 'subscribe' | 'releaseThread' | 'findCompletionHistory' | 'findOwnRequest'; phase: 'start' | 'done' | 'error'; elapsedMs?: number; resultState?: string; errorType?: string };
  const reconciliationStageTrace: ReconciliationStage[] = [];
  const recordReconciliationStage = (event: ReconciliationStage) => {
    reconciliationStageTrace.push(event);
    if (reconciliationStageTrace.length > 128) reconciliationStageTrace.shift();
  };
  const traceReconciliationStage = <TArgs extends unknown[], TResult>(operation: ReconciliationStage['operation'], run: (...args: TArgs) => Promise<TResult>, resultState?: (result: TResult) => string) => async (...args: TArgs): Promise<TResult> => {
    const started = Date.now();
    recordReconciliationStage({ operation, phase: 'start' });
    try {
      const result = await run(...args);
      recordReconciliationStage({ operation, phase: 'done', elapsedMs: Date.now() - started,
        ...(resultState ? { resultState: resultState(result) } : {}) });
      return result;
    } catch (error) {
      const errorType = error instanceof Error && /^[A-Za-z]{1,48}$/u.test(error.name) ? error.name : 'UnknownError';
      recordReconciliationStage({ operation, phase: 'error', elapsedMs: Date.now() - started, errorType });
      throw error;
    }
  };
  const rpcTrace: Array<{ attempt: number; method: string; phase: 'start' | 'done' | 'error'; elapsedMs?: number; errorType?: string }> = [];
  let rpcAttempt = 0;
  const observedProtocolEvents: Array<{ kind: 'request' | 'notification'; method: string; hasThreadId: boolean; hasTurnId: boolean; hasRequestId: boolean; hasItemId: boolean; hasApprovalId: boolean }> = [];
  type ServerRequestTrace = { method: string; pendingAtEntry: boolean; activeRequests: number; threadMatches: number; exactMatches: number;
    historyState?: string; historyTurnMatches?: boolean; historyMixed?: boolean; pendingAtExit: boolean; statusAfter?: string;
    approvalsAdded: number; errorType?: string };
  const serverRequestTrace: ServerRequestTrace[] = [];
  let currentServerRequest: { requestId?: string; turnId?: string; trace: ServerRequestTrace } | undefined;
  const recordProtocolEvent = (kind: 'request' | 'notification', event: { method: string; params?: Record<string, unknown> }) => {
    const params = event.params ?? {};
    observedProtocolEvents.push({ kind, method: /^[A-Za-z0-9._/-]{1,100}$/u.test(event.method) ? event.method : 'other',
      hasThreadId: typeof params.threadId === 'string', hasTurnId: typeof params.turnId === 'string',
      hasRequestId: typeof params.requestId === 'string' || typeof params.requestId === 'number',
      hasItemId: typeof params.itemId === 'string', hasApprovalId: typeof params.approvalId === 'string' });
    if (observedProtocolEvents.length > 64) observedProtocolEvents.shift();
  };
  const cancellationProcessChecks: Array<{ turnId: string; processAlive: boolean }> = [];
  const cancellationInterruptWitnesses: Array<{ threadId: string; turnId: string; processId: number; processAlive: boolean; markerExists: boolean }> = [];
  let cancellationProcess: { id: number; threadId: string; turnId: string } | undefined;
  let codex: SourceCodexClient | undefined, engine: SourceEngine | undefined;
  let threadId = values.thread;
  let loseNextQueueAck = false, droppedQueueAcks = 0, catalogValidated = false;
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  };
  async function start() {
    codex = new CodexClient(config.codex, options);
    codex.on('notification', (event: { method: string; params: { threadId?: unknown; turn?: { id?: unknown } } }) => {
      recordProtocolEvent('notification', event);
      if (['turn/started', 'turn/completed'].includes(event.method) && typeof event.params.threadId === 'string' && typeof event.params.turn?.id === 'string') {
        observedTurns.push({ method: event.method, threadId: event.params.threadId, turnId: event.params.turn.id });
        if (observedTurns.length > 100) observedTurns.shift();
        if (event.method === 'turn/completed') {
          for (const request of store.activeRequests().filter(row => store.getConversation(row.conversationId)?.threadId === event.params.threadId)) {
            completionObservations.push({ eventId: fixtureLabel(request.eventId), status: request.status, turnMatches: request.turnId === event.params.turn.id });
            if (completionObservations.length > 64) completionObservations.shift();
          }
        }
        if (event.method === 'turn/started' && event.params.threadId === threadId
            && cancellationProcess && event.params.turn.id !== cancellationProcess.turnId) {
          cancellationProcessChecks.push({ turnId: event.params.turn.id, processAlive: alive(cancellationProcess.id) });
          cancellationProcess = undefined;
        }
      }
    });
    codex.on('request', recordProtocolEvent.bind(null, 'request'));
    const rpcClient = codex as unknown as { call<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs?: number, confirmHealth?: boolean): Promise<T> };
    const call = rpcClient.call.bind(codex);
    rpcClient.call = async <T = unknown>(method: string, params: Record<string, unknown>, timeoutMs?: number, confirmHealth?: boolean): Promise<T> => {
      const attempt = ++rpcAttempt, started = Date.now();
      const safeMethod = /^[A-Za-z0-9._/-]{1,100}$/u.test(method) ? method : 'other';
      rpcTrace.push({ attempt, method: safeMethod, phase: 'start' });
      if (rpcTrace.length > 128) rpcTrace.shift();
      try {
        const result = await call<T>(method, params, timeoutMs, confirmHealth);
        rpcTrace.push({ attempt, method: safeMethod, phase: 'done', elapsedMs: Date.now() - started });
        if (rpcTrace.length > 128) rpcTrace.shift();
        return result;
      } catch (error) {
        rpcTrace.push({ attempt, method: safeMethod, phase: 'error', elapsedMs: Date.now() - started,
          errorType: error instanceof Error ? error.name : 'UnknownError' });
        if (rpcTrace.length > 128) rpcTrace.shift();
        throw error;
      }
    };
    emitProbeStage('codex-connect');
    await codex.connect();
    // Snapshot polling would evict the dispatch stages from this bounded trace.
    codex.subscribe = observe('subscribe', traceReconciliationStage('subscribe', codex.subscribe.bind(codex)));
    codex.releaseThread = observe('releaseThread', traceReconciliationStage('releaseThread', codex.releaseThread.bind(codex)));
    codex.backgroundTerminals = observe('backgroundTerminals', codex.backgroundTerminals.bind(codex));
    const internals = codex as unknown as { pages: <T>(method: string, params: Record<string, unknown>) => Promise<T[]> };
    const pages = internals.pages.bind(codex);
    internals.pages = async <T>(method: string, params: Record<string, unknown>) => observe('pages', () => pages<T>(method, params))();
    const findRequest = codex.findRequest.bind(codex);
    codex.findRequest = async (...args) => {
      try {
        const found = await findRequest(...args);
        recordDriverOperation(`findRequest:${found.state}${found.turnId ? ':turn' : ''}${found.queuedSubmissionId ? ':queue' : ''}`);
        return found;
      } catch (error) {
        recordDriverOperation('findRequest:error');
        throw error;
      }
    };
    const interrupt = codex.interrupt.bind(codex);
    codex.interrupt = async (...args) => {
      const owned = cancellationProcess;
      if (owned && args[0] === owned.threadId && args[1] === owned.turnId) {
        cancellationInterruptWitnesses.push({ threadId: args[0], turnId: args[1], processId: owned.id,
          processAlive: alive(owned.id), markerExists: existsSync(join(values.directory!, 'cancel-late.txt')) });
      }
      return interrupt(...args);
    };
    const enqueue = codex.enqueue.bind(codex);
    codex.enqueue = observe('enqueue', async (...args) => {
      const result = await enqueue(...args);
      if (loseNextQueueAck) { loseNextQueueAck = false; droppedQueueAcks++; throw new Error('Synthetic lost queue ACK after native acceptance'); }
      return result;
    });
    emitProbeStage('thread-catalog');
    const previous = store.listConversations()[0];
    threadId = previous?.threadId ?? threadId;
    if (!threadId) {
      threadId = await codex.createThread(values.directory!);
      await codex.setThreadName(threadId, 'Original shared fixture');
    }
    if (values.thread || previous) {
      // Match manual selection in the real source route API, without pre-subscribing.
      let catalog = await codex.listThreads({ refresh: true });
      const deadline = Date.now() + 5_000;
      while (!catalog.some(thread => thread.id === threadId) && Date.now() < deadline) {
        await delay(100); catalog = await codex.listThreads({ refresh: true });
      }
      if (!catalog.some(thread => thread.id === threadId)) throw new Error('Original shared thread absent from refreshed production catalog');
      catalogValidated = true;
    }
    if (!previous) store.createConversation({ name: 'Original shared fixture', threadId, cwd: values.directory!,
      bindings: Object.values(endpoints).map(endpoint => ({ platform: endpoint.platform, endpointId: endpoint.id, allowedSenderIds: ['fixture-user'] })) });
    emitProbeStage('engine-start');
    engine = new Engine(store, codex, { config: () => config, temporaryRoot: values.directory!, redact: value => String(value) });
    const engineInternals = engine as unknown as {
      dispatch: (conversationId: string) => Promise<void>;
      reconcile: (id: string, completionNotification?: boolean, completionTurnId?: string) => Promise<void>;
      onServerRequest: (event: CodexServerRequest) => Promise<void>;
      findOwnRequest: (client: SourceCodexClient, threadId: string, requestId: string) => Promise<{ state: string; turnId?: string; mixed?: boolean }>;
      findCompletionHistory: (client: SourceCodexClient, threadId: string, requestId: string) => Promise<{ state: string; turnId?: string; mixed?: boolean }>;
      releasing: Map<string, Promise<void>>;
      initialMessages: { ensure: (conversationId: string) => Promise<boolean> };
      slackSync: { drain: (conversationId: string, cutoff?: string) => Promise<boolean> };
    };
    const activeCodex = codex!;
    const findOwnRequest = engineInternals.findOwnRequest.bind(engine);
    engineInternals.findOwnRequest = async (client, requestThread, requestId) => {
      const found = await traceReconciliationStage('findOwnRequest', findOwnRequest, result => fixtureLabel(result.state))(client, requestThread, requestId);
      if (currentServerRequest?.requestId === requestId) {
        currentServerRequest.trace.historyState = found.state;
        currentServerRequest.trace.historyTurnMatches = typeof currentServerRequest.turnId === 'string' && found.turnId === currentServerRequest.turnId;
        currentServerRequest.trace.historyMixed = found.mixed === true;
      }
      return found;
    };
    const findCompletionHistory = engineInternals.findCompletionHistory.bind(engine);
    engineInternals.findCompletionHistory = traceReconciliationStage('findCompletionHistory', findCompletionHistory, result => fixtureLabel(result.state));
    const releasingGet = engineInternals.releasing.get.bind(engineInternals.releasing);
    engineInternals.releasing.get = key => {
      const pendingRelease = releasingGet(key);
      if (pendingRelease) {
        const started = Date.now();
        recordReconciliationStage({ operation: 'releaseWait', phase: 'start' });
        void pendingRelease.then(
          () => recordReconciliationStage({ operation: 'releaseWait', phase: 'done', elapsedMs: Date.now() - started }),
          error => recordReconciliationStage({ operation: 'releaseWait', phase: 'error', elapsedMs: Date.now() - started,
            errorType: error instanceof Error && /^[A-Za-z]{1,48}$/u.test(error.name) ? error.name : 'UnknownError' }),
        );
      }
      return pendingRelease;
    };
    const onServerRequest = engineInternals.onServerRequest.bind(engine);
    engineInternals.onServerRequest = async event => {
      const params = event.params as Record<string, unknown>;
      const active = store.activeRequests();
      const sameThread = active.filter(row => store.getConversation(row.conversationId)?.threadId === params.threadId);
      const matches = sameThread.filter(row => !row.steeredInto && row.turnId === params.turnId);
      const trace: ServerRequestTrace = { method: /^[A-Za-z0-9._/-]{1,100}$/u.test(event.method) ? event.method : 'other',
        pendingAtEntry: activeCodex.hasPendingRequest(event.id), activeRequests: active.length,
        threadMatches: sameThread.length, exactMatches: matches.length, pendingAtExit: false, approvalsAdded: 0 };
      const previous = currentServerRequest;
      currentServerRequest = { requestId: matches[0]?.id, turnId: typeof params.turnId === 'string' ? params.turnId : undefined, trace };
      const approvalsBefore = store.listApprovals().length;
      try { await onServerRequest(event); }
      catch (error) { trace.errorType = error instanceof Error ? error.name : 'UnknownError'; throw error; }
      finally {
        trace.pendingAtExit = activeCodex.hasPendingRequest(event.id);
        trace.statusAfter = matches[0] ? store.getRequest(matches[0].id)?.status ?? 'missing' : 'missing';
        trace.approvalsAdded = Math.max(0, store.listApprovals().length - approvalsBefore);
        serverRequestTrace.push(trace);
        if (serverRequestTrace.length > 24) serverRequestTrace.shift();
        currentServerRequest = previous;
      }
    };
    engineInternals.dispatch = observe('dispatch', engineInternals.dispatch.bind(engine));
    const reconcile = engineInternals.reconcile.bind(engine);
    engineInternals.reconcile = async (id, completionNotification = false, completionTurnId) => {
      const request = store.getRequest(id), started = Date.now();
      const eventId = fixtureLabel(request?.eventId);
      const phase = (value: 'start' | 'done' | 'error', error?: unknown) => {
        reconciliationTrace.push({ eventId, phase: value, status: store.getRequest(id)?.status ?? 'missing',
          completionNotification, turnProvided: typeof completionTurnId === 'string',
          ...(value === 'start' ? {} : { elapsedMs: Date.now() - started }),
          ...(value === 'error' ? { errorType: error instanceof Error ? error.name : 'UnknownError' } : {}) });
        if (reconciliationTrace.length > 128) reconciliationTrace.shift();
      };
      phase('start');
      try { await reconcile(id, completionNotification, completionTurnId); phase('done'); }
      catch (error) { phase('error', error); throw error; }
    };
    engineInternals.initialMessages.ensure = observe('initialMessage.ensure', engineInternals.initialMessages.ensure.bind(engineInternals.initialMessages));
    engineInternals.slackSync.drain = observe('slackSync.drain', engineInternals.slackSync.drain.bind(engineInternals.slackSync));
    for (const platform of ['slack', 'telegram'] as const) engine.channels[platform] = {
      state: { configured: true, connected: true, name: platform, accountId: endpoints[platform].accountId },
      readThreadPage: async () => ({ messages: platform === 'slack' ? [...history] : [] }),
      start: async () => {}, stop: async () => {}, download: async () => { throw new Error('No audio in shared fixture'); },
      deliver: async delivery => `${platform}:${delivery.id}`,
    } satisfies Channel;
    engine.on('diagnostic', message => diagnostics.push(String(message)));
    engine.start();
  }
  async function snapshot(processId?: number) {
    if (!codex) throw new Error('Client is closed');
    const runtimeProcessId = (await codex.diagnostics()).process.id;
    const requests = store.listRequests();
    const cancelCleanups = Object.fromEntries(requests.flatMap(request => {
      const raw = store.getMeta(`cancel-cleanup:${request.id}`);
      return raw ? [[request.id, JSON.parse(raw)]] : [];
    }));
    return { threadId, configuredExecutable: config.codex.executable, status: codex.status(), runtime: codex.runtimeInfo(), runtimeProcessId,
      droppedQueueAcks, catalogValidated, observedTurns, observedProtocolEvents, cancellationProcessChecks, cancellationInterruptWitnesses,
      ...(processId ? { probeProcessAlive: alive(processId) } : {}),
      requests, cancelCleanups, deliveries: store.listDeliveries(), approvals: store.listApprovals(), diagnostics,
      driverOperations: driverOperations.slice(-40), completionObservations: completionObservations.slice(-32),
      serverRequestTrace: serverRequestTrace.slice(-24),
      reconciliationTrace: reconciliationTrace.slice(-48), reconciliationStageTrace: reconciliationStageTrace.slice(-32), rpcTrace: rpcTrace.slice(-64) };
  }
  const input = createInterface({ input: process.stdin });
  try {
    await start();
    emitProbeStage('native-diagnostics');
    const ready = await snapshot();
    let preparedRuntime;
    if (process.platform === 'win32') {
      emitProbeStage('desktop-package-verification');
      const shared = values['runtime-directory'] ? await load('codex-shared') as typeof import('../src/server/codex-shared.js') : { readPreparedDesktopCodexPackage };
      preparedRuntime = await shared.readPreparedDesktopCodexPackage(ready.status.executable!, {}, true);
    }
    emitProbeStage('ready');
    process.stdout.write(JSON.stringify({ ready: true, ...ready, preparedRuntime }) + '\n');
    for await (const line of input) {
      const command = JSON.parse(line) as { action: string; platform?: Platform; text?: string; eventId?: string;
        requestId?: string; approvalId?: string; status?: string; turnId?: string; loseAck?: boolean;
        decision?: 'accept' | 'decline'; processId?: number };
      if (command.processId !== undefined && (!Number.isSafeInteger(command.processId) || command.processId <= 0)) throw new Error('Invalid fixture process ID');
      if (command.action === 'ingest') {
        loseNextQueueAck = command.loseAck === true;
        const platform = command.platform!;
        if (!endpoints[platform]) throw new Error('Unknown fixture origin');
        const messageId = platform === 'slack' ? `1700000001.${String(history.length).padStart(6, '0')}` : command.eventId!;
        const slack: SlackTranscriptMessage | undefined = platform === 'slack' ? { endpointId: endpoints.slack.id,
          accountId: endpoints.slack.accountId, chatId: endpoints.slack.chatId, threadId: endpoints.slack.threadId,
          messageId, sender: endpoints.slack.people[0], text: command.text!, payload: { text: command.text!, ts: messageId }, kind: 'message' } : undefined;
        if (slack) history.push(slack);
        await engine!.receive({ eventId: command.eventId!, endpoint: endpoints[platform], sender: endpoints[platform].people[0],
          messageId, text: command.text!, ...(slack ? { slack } : {}) });
        if (command.loseAck !== true) await engine!.settled();
      } else if (command.action === 'wait') {
        const until = Date.now() + ENGINE_WAIT_TIMEOUT_MS;
        const pending = () => command.turnId ? !observedTurns.some(event =>
          event.method === 'turn/completed' && event.threadId === threadId && event.turnId === command.turnId) : command.status ? !store.listRequests().some(request =>
          (!command.requestId || request.id === command.requestId) && request.status === command.status) : store.activeRequests().length > 0;
        while (pending() && Date.now() < until) { await engine!.pump(); await engine!.settled(); await delay(50); }
        if (pending()) {
          let evidence: Record<string, unknown>;
          try { evidence = summarizeSharedWaitFailure(command.status ?? 'active', await snapshot()); }
          catch (error) { evidence = { snapshotErrorType: error instanceof Error ? error.name : 'UnknownError' }; }
          const target = store.activeRequests().at(-1);
          if (codex && threadId && target) {
            const lookup = codex.findRequest(threadId, target.id, [target.id], true).then(
              location => ({ location }), error => ({ error }));
            const native = await Promise.race([lookup, delay(5000).then(() => ({ timeout: true as const }))]);
            if ('location' in native) evidence.nativeRequest = summarizeSharedNativeRequest(native.location);
            else if ('error' in native) {
              const errorType = native.error instanceof Error ? native.error.name : 'UnknownError';
              evidence.nativeRequestErrorType = ['ConnectionResetError', 'CodexTransportError', 'CodexRpcError', 'Error', 'UnknownError'].includes(errorType) ? errorType : 'other';
            }
            else evidence.nativeRequestTimedOut = true;
          }
          throw new Error(`Shared requests did not reach expected state: ${JSON.stringify(evidence)}`);
        }
        await engine!.pump(); await engine!.settled();
      } else if (command.action === 'answer') {
        if (command.decision !== undefined && !['accept', 'decline'].includes(command.decision)) throw new Error('Invalid fixture approval decision');
        await engine!.resolveApproval(command.approvalId!, command.decision ?? 'decline');
      } else if (command.action === 'resume') {
        await engine!.resume(command.requestId!);
      } else if (command.action === 'cancel') {
        if (command.processId) {
          const request = store.listRequests().find(request => request.id === command.requestId);
          if (!request?.turnId) throw new Error('Missing cancellation fixture turn');
          cancellationProcess = { id: command.processId, threadId: threadId!, turnId: request.turnId };
        }
        try { await engine!.cancel(command.requestId!); } catch (error) {
          let terminals: unknown;
          try { terminals = await codex!.backgroundTerminals(threadId!); }
          catch (diagnostic) { terminals = { errorCode: (diagnostic as { code?: unknown }).code ?? 'unavailable' }; }
          let state: Awaited<ReturnType<typeof snapshot>> | undefined;
          let snapshotErrorType: string | undefined;
          try { state = await snapshot(command.processId); }
          catch (diagnostic) { snapshotErrorType = diagnostic instanceof Error ? diagnostic.name : 'UnknownError'; }
          const request = store.listRequests().find(row => row.id === command.requestId);
          const identityFailures = ['server-id-changed', 'target-generation-invalid', 'server-generation-unconfirmed', 'server-generation-changed', 'terminal-ambiguous', 'terminal-process-changed'] as const;
          const identityFailure = (error as { identityFailure?: unknown }).identityFailure;
          const safeIdentityFailure = identityFailures.includes(identityFailure as typeof identityFailures[number]) ? identityFailure : undefined;
          process.stderr.write(JSON.stringify({ event: 'shared-cancel-diagnostic', errorCode: (error as { code?: unknown }).code,
            requestId: command.requestId, turnId: request?.turnId, cleanup: state?.cancelCleanups[command.requestId!],
            terminals, cancellationInterruptWitnesses: state?.cancellationInterruptWitnesses,
            probeProcessAlive: state?.probeProcessAlive, snapshotErrorType, identityFailure: safeIdentityFailure }) + '\n');
          throw error;
        }
      } else if (command.action === 'close') {
        const pid = (await codex!.diagnostics()).process.id;
        await engine!.stop(); await codex!.close();
        process.stdout.write(JSON.stringify({ stopped: true, runtimeProcessId: pid, backendAlive: alive(pid) }) + '\n');
        break;
      } else if (command.action !== 'snapshot') throw new Error('Unknown shared fixture command');
      process.stdout.write(JSON.stringify({ action: command.action, ...(await snapshot(command.processId)) }) + '\n');
    }
  } finally {
    input.close();
    if (engine) await engine.stop();
    if (codex) await codex.close();
    store.close();
  }
}
