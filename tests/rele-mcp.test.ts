import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { ConfigStore } from '../src/server/config.js';
import { callLocalMessageTool, MessageToolAcknowledgementError } from '../src/server/lifecycle.js';
import { invokeReleTool, parseReleToolCall, runReleMcp } from '../src/server/rele-mcp.js';
import { messageToolOperationId } from '../src/shared/message-tool.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
const meta = { threadId: 'native-thread', callId: 'native-call' };
const params = (name: string, args: Record<string, unknown> = {}) => ({ name, arguments: args, _meta: meta });
async function temporary() {
  const value = await mkdtemp(path.join(tmpdir(), 'rele-mcp-'));
  cleanup.push(() => rm(value, { force: true, recursive: true })); return value;
}

describe('Rele MCP trusted identity and receipts', () => {
  it('accepts native metadata and rejects model-selected location or unsupported metadata', async () => {
    const call = vi.fn().mockResolvedValue({ destinations: [] });
    await expect(invokeReleTool(params('list_destinations'), call)).resolves.toEqual({ destinations: [] });
    expect(call).toHaveBeenCalledExactlyOnceWith({ ...meta, name: 'list_destinations', arguments: {} });
    for (const value of [
      { name: 'list_destinations', arguments: { threadId: 'model-thread', callId: 'model-call' } },
      { ...params('list_destinations'), _meta: { threadId: meta.threadId } },
      params('list_destinations', { threadId: 'model-thread' }),
      { ...params('list_destinations'), _meta: { ...meta, callId: '' } },
    ]) await expect(invokeReleTool(value, call)).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('bounds explicit sends and allows zero, one or many stable recipients', () => {
    for (const mentionIds of [undefined, [], ['agent-1'], ['agent-1', 'human-2']]) {
      const args = { endpointId: 'linked-source', text: 'hello', ...(mentionIds ? { mentionIds } : {}) };
      expect(parseReleToolCall(params('send_message', args))).toEqual({ ...meta, name: 'send_message', arguments: args });
    }
    for (const args of [
      { endpointId: 'linked-source', text: 'x'.repeat(3001) },
      { endpointId: 'linked-source', text: 'hello', mentionIds: ['same', 'same'] },
      { endpointId: 'linked-source', text: 'hello', threadId: 'spoof' },
      { endpointId: 'linked-source', text: '\u0000' },
    ]) expect(() => parseReleToolCall(params('send_message', args))).toThrow();
    expect(parseReleToolCall(params('send_message', { endpointId: 'linked-source', text: 'x'.repeat(3000) })).arguments.text).toHaveLength(3000);
  });

  it('returns a stable uncertain receipt after lost acknowledgement without retrying or reflecting errors', async () => {
    const call = vi.fn().mockRejectedValue(new MessageToolAcknowledgementError());
    const value = await invokeReleTool(params('send_message', { endpointId: 'source', text: 'one request' }), call);
    expect(value).toMatchObject({ operationId: messageToolOperationId(meta.threadId, meta.callId), status: 'uncertain', endpointId: 'source' });
    expect(JSON.stringify(value)).not.toContain('secret'); expect(call).toHaveBeenCalledTimes(1);
    await expect(invokeReleTool(params('get_message_status', { operationId: 'tool-known' }), call)).rejects.toThrow();
    const refused = vi.fn().mockRejectedValue(new Error('synthetic-panel-token=secret'));
    await expect(invokeReleTool(params('send_message', { endpointId: 'source', text: 'rejected' }), refused)).rejects.toThrow();
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('keeps stdout protocol-only and rejects missing metadata without forwarding', async () => {
    const call = vi.fn().mockRejectedValue(new Error('synthetic-secret'));
    const input = Readable.from([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n',
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n',
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_message', arguments: { endpointId: 'e', text: 'x', threadId: 'model' } } }) + '\n',
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: params('list_destinations') }) + '\n',
    ]);
    const output = new PassThrough(); let source = ''; output.on('data', chunk => { source += chunk.toString(); });
    await runReleMcp('/unused', input, output, call);
    const replies = source.trim().split('\n').map(line => JSON.parse(line));
    expect(replies.map(row => row.id)).toEqual([1, 2, 3, 4]);
    expect(replies[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual(['list_destinations', 'send_message', 'get_message_status']);
    expect(replies[2].result.isError).toBe(true); expect(replies[3].result.isError).toBe(true);
    expect(source).not.toContain('synthetic-secret'); expect(call).toHaveBeenCalledTimes(1);
  });

  it('returns the backend’s fixed validation result as a tool error', async () => {
    const fixed = { isError: true, error: 'У участника Telegram нет проверенного имени для упоминания.' };
    const input = Readable.from([JSON.stringify({ id: 'known-rejection', method: 'tools/call', params: params('send_message', { endpointId: 'e', text: 'x' }) }) + '\n']);
    const output = new PassThrough(); let source = ''; output.on('data', chunk => { source += chunk.toString(); });
    await runReleMcp('/unused', input, output, async () => fixed);
    const reply = JSON.parse(source);
    expect(reply.result).toMatchObject({ isError: true, structuredContent: fixed });
    expect(JSON.parse(reply.result.content[0].text)).toEqual(fixed);
  });
});

describe('MCP local instance access', () => {
  it('loads only existing credentials without creating a missing directory or mutating bytes', async () => {
    const parent = await temporary(), missing = path.join(parent, 'missing');
    await expect(new ConfigStore(missing).loadExisting()).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    const config = new ConfigStore(parent); await config.load();
    const bytes = await readFile(path.join(parent, 'config.json'));
    const reader = new ConfigStore(parent); await reader.loadExisting();
    expect(reader.panelToken).toBe(config.panelToken);
    expect(await readFile(path.join(parent, 'config.json'))).toEqual(bytes);
    expect(await readdir(parent)).toEqual(['config.json']);
  });

  it('verifies the authenticated instance and sends exactly one POST, rejecting a mismatch first', async () => {
    const directory = await temporary(), config = new ConfigStore(directory); await config.load();
    let posts = 0, expectedPid = process.pid;
    vi.stubGlobal('fetch', vi.fn(async (input: URL, options: RequestInit) => {
      expect(new Headers(options.headers).get('authorization')).toBe(`Bearer ${config.panelToken}`);
      expect(options.redirect).toBe('error');
      if (input.pathname === '/api/instance') return Response.json({ pid: expectedPid, version: 'test-version' });
      expect(input.href).toBe('http://127.0.0.1:3210/api/tools/call'); expect(options.method).toBe('POST'); posts++;
      expect(JSON.parse(String(options.body))).toEqual({ ...meta, name: 'list_destinations', arguments: {} });
      return Response.json({ destinations: [] });
    }));
    await writeFile(path.join(directory, 'instance.json'), JSON.stringify({ pid: process.pid, version: 'test-version', address: 'http://127.0.0.1:3210' }));
    await expect(callLocalMessageTool(config, { ...meta, name: 'list_destinations', arguments: {} })).resolves.toEqual({ destinations: [] });
    expect(posts).toBe(1); expectedPid++;
    await expect(callLocalMessageTool(config, {})).rejects.toThrow('не совпадает'); expect(posts).toBe(1);
    await writeFile(path.join(directory, 'instance.json'), JSON.stringify({ pid: process.pid, version: 'test-version', address: 'https://remote.example' }));
    await expect(callLocalMessageTool(config, {})).rejects.toThrow('локальный адрес'); expect(posts).toBe(1);
  });

  it('distinguishes a known refusal from a lost POST acknowledgement without retries', async () => {
    const directory = await temporary(), config = new ConfigStore(directory); await config.load();
    await writeFile(path.join(directory, 'instance.json'), JSON.stringify({ pid: process.pid, version: 'test', address: 'http://127.0.0.1:3210' }));
    let lost = false, posts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: URL) => {
      if (input.pathname === '/api/instance') return Response.json({ pid: process.pid, version: 'test' });
      posts++;
      if (lost) throw new Error('synthetic-secret-in-transport');
      return Response.json({ error: 'synthetic-secret-in-refusal' }, { status: 403 });
    }));
    await expect(callLocalMessageTool(config, {})).rejects.not.toBeInstanceOf(MessageToolAcknowledgementError);
    expect(posts).toBe(1); lost = true;
    await expect(callLocalMessageTool(config, {})).rejects.toBeInstanceOf(MessageToolAcknowledgementError);
    expect(posts).toBe(2);
  });
});
