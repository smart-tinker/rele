import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexContextReceipts } from '../src/server/codex-context-receipts.js';

const roots: string[] = [];
const threadId = 'synthetic-thread';
const itemId = 'rele_slack_synthetic-entry';
const text = 'Quoted synthetic Slack context: Привет 👋';
const meta = (id = threadId) => JSON.stringify({ timestamp: '2026-10-20T00:00:00Z', type: 'session_meta', payload: { id } });
const item = (options: { id?: string; role?: string; text?: string } = {}) => JSON.stringify({
  timestamp: '2026-10-20T00:00:01Z', type: 'response_item',
  payload: { type: 'message', id: options.id ?? itemId, role: options.role ?? 'user', content: [{ type: 'input_text', text: options.text ?? text }] },
});

async function fixture(lines = [meta(), item()], directory = 'sessions') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rele-receipts-'));
  roots.push(root);
  const codexHome = path.join(root, 'profile');
  const sessionDirectory = path.join(codexHome, directory);
  await mkdir(sessionDirectory, { recursive: true });
  const rolloutPath = path.join(sessionDirectory, 'synthetic-rollout.jsonl');
  await writeFile(rolloutPath, lines.length ? `${lines.join('\n')}\n` : '');
  const receipts = new CodexContextReceipts();
  return { root, receipts, rolloutPath, query: { codexHome, rolloutPath, threadId, itemId, text } };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('persisted Codex passive context receipts', () => {
  it.each(['sessions', 'archived_sessions'])('matches exact persisted user ID and text under %s without changing the file', async directory => {
    const f = await fixture(undefined, directory);
    const before = await readFile(f.rolloutPath);
    expect(await f.receipts.has(f.query)).toBe(true);
    expect(await f.receipts.has({ ...f.query, itemId: 'rele_slack_other' })).toBe(false);
    expect(await f.receipts.has({ ...f.query, text: `${text} changed` })).toBe(false);
    expect(await readFile(f.rolloutPath)).toEqual(before);
  });

  it('ignores another role, another ID, and non-exact text', async () => {
    const f = await fixture([meta(), item({ role: 'assistant' }), item({ id: 'another-id' }), item({ text: `${text}\n` })]);
    expect(await f.receipts.has(f.query)).toBe(false);
    await appendFile(f.rolloutPath, `${item()}\n`);
    expect(await f.receipts.has(f.query)).toBe(true);
  });

  it('requires exactly one raw input_text content item', async () => {
    const row = JSON.parse(item());
    row.payload.content.push({ type: 'input_text', text: 'extra content' });
    const f = await fixture([meta(), JSON.stringify(row)]);
    expect(await f.receipts.has(f.query)).toBe(false);
  });

  it('rejects invalid UTF-8 rather than matching replacement characters', async () => {
    const f = await fixture([meta()]);
    const row = Buffer.from(item({ text: 'synthetic-byte' }));
    row[row.indexOf('synthetic-byte')] = 255;
    await appendFile(f.rolloutPath, Buffer.concat([row, Buffer.from('\n')]));
    await expect(f.receipts.has({ ...f.query, text: '�ynthetic-byte' })).rejects.toThrow('Не удалось подтвердить сохранение контекста Codex.');
  });

  it('keeps distinct text hashes when an ID appears more than once', async () => {
    const f = await fixture([meta(), item({ text: 'first text' }), item({ text: 'second text' })]);
    expect(await f.receipts.has({ ...f.query, text: 'first text' })).toBe(true);
    expect(await f.receipts.has({ ...f.query, text: 'second text' })).toBe(true);
    expect(await f.receipts.has({ ...f.query, text: 'third text' })).toBe(false);
  });

  it('requires the first complete record to identify the requested thread', async () => {
    const f = await fixture([meta('different-thread'), item(), meta()]);
    await expect(f.receipts.has(f.query)).rejects.toThrow('Не удалось подтвердить сохранение контекста Codex.');
    await writeFile(f.rolloutPath, `${item()}\n${meta()}\n`);
    await expect(f.receipts.has(f.query)).rejects.toThrow('Не удалось подтвердить сохранение контекста Codex.');
  });

  it('buffers partial records, including a split UTF-8 character, until their newline', async () => {
    const f = await fixture([meta()]);
    const record = Buffer.from(item());
    const split = record.indexOf(Buffer.from('👋')) + 1;
    await appendFile(f.rolloutPath, record.subarray(0, split));
    expect(await f.receipts.has(f.query)).toBe(false);
    await appendFile(f.rolloutPath, record.subarray(split));
    expect(await f.receipts.has(f.query)).toBe(false);
    await appendFile(f.rolloutPath, '\n');
    expect(await f.receipts.has(f.query)).toBe(true);
    await appendFile(f.rolloutPath, `${item({ id: 'rele_slack_later', text: 'later' })}\n`);
    expect(await f.receipts.has({ ...f.query, itemId: 'rele_slack_later', text: 'later' })).toBe(true);
    expect(await f.receipts.has(f.query)).toBe(true);
  });

  it('does not treat a partial session header as a verified thread', async () => {
    const f = await fixture([]);
    await appendFile(f.rolloutPath, meta());
    expect(await f.receipts.has(f.query)).toBe(false);
    await appendFile(f.rolloutPath, `\n${item()}\n`);
    expect(await f.receipts.has(f.query)).toBe(true);
  });

  it('drops cached receipts and partial bytes after truncation', async () => {
    const f = await fixture();
    expect(await f.receipts.has(f.query)).toBe(true);
    await appendFile(f.rolloutPath, item().slice(0, 30));
    expect(await f.receipts.has(f.query)).toBe(true);
    await truncate(f.rolloutPath, Buffer.byteLength(`${meta()}\n`));
    expect(await f.receipts.has(f.query)).toBe(false);
    await appendFile(f.rolloutPath, `${item()}\n`);
    expect(await f.receipts.has(f.query)).toBe(true);
  });

  it('drops cached receipts when a different file replaces the rollout', async () => {
    const f = await fixture();
    expect(await f.receipts.has(f.query)).toBe(true);
    const replacement = path.join(path.dirname(f.rolloutPath), 'replacement.jsonl');
    await writeFile(replacement, `${meta()}\n${item({ text: 'different replacement text that is long enough to exceed the first file' })}\n`);
    await rename(replacement, f.rolloutPath);
    expect(await f.receipts.has(f.query)).toBe(false);
  });

  it('clears cached receipts explicitly', async () => {
    const f = await fixture();
    expect(await f.receipts.has(f.query)).toBe(true);
    f.receipts.clear();
    await writeFile(f.rolloutPath, `${meta()}\n`);
    expect(await f.receipts.has(f.query)).toBe(false);
  });

  it.each(['other', 'sessions-neighbor'])('rejects a file outside the permitted %s tree with a generic error', async directory => {
    const f = await fixture(undefined, directory);
    let error: unknown;
    try { await f.receipts.has(f.query); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe('Error: Не удалось подтвердить сохранение контекста Codex.');
    expect(String(error)).not.toContain(f.root);
    expect(String(error)).not.toContain(text);
  });

  it('rejects a symlink escaping the canonical profile', async () => {
    const f = await fixture();
    const outside = path.join(f.root, 'outside.jsonl');
    await rename(f.rolloutPath, outside);
    const link = path.join(f.query.codexHome, 'sessions', 'escape');
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(f.root, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.receipts.has({ ...f.query, rolloutPath: path.join(link, 'outside.jsonl') })).rejects.toThrow('Не удалось подтвердить сохранение контекста Codex.');
  });

  it('accepts a canonicalized profile alias with an in-profile rollout', async () => {
    const f = await fixture();
    const alias = path.join(f.root, 'profile-alias');
    await symlink(f.query.codexHome, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await f.receipts.has({ ...f.query, codexHome: alias, rolloutPath: path.join(alias, 'sessions', path.basename(f.rolloutPath)) })).toBe(true);
  });

  it('rejects compressed files, non-files, relative paths, and unreadable files', async () => {
    const f = await fixture();
    const compressed = `${f.rolloutPath}.zst`;
    await writeFile(compressed, `${meta()}\n${item()}\n`);
    const directory = path.join(path.dirname(f.rolloutPath), 'directory.jsonl');
    await mkdir(directory);
    for (const rolloutPath of [compressed, directory, 'relative.jsonl', path.join(path.dirname(f.rolloutPath), 'missing.jsonl')]) {
      await expect(f.receipts.has({ ...f.query, rolloutPath })).rejects.toThrow('Не удалось подтвердить сохранение контекста Codex.');
    }
  });

  it('rejects malformed complete records and bounds an incomplete line', async () => {
    const f = await fixture([meta(), '{broken synthetic json']);
    await expect(f.receipts.has(f.query)).rejects.toThrow('Не удалось подтвердить сохранение контекста Codex.');
    await writeFile(f.rolloutPath, `${meta()}\n`);
    await appendFile(f.rolloutPath, Buffer.alloc(32 * 1024 * 1024 + 1, 97));
    await expect(f.receipts.has(f.query)).rejects.toThrow('Не удалось подтвердить сохранение контекста Codex.');
  });
});
