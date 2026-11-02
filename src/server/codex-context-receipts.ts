import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_LINE_BYTES = 32 * 1024 * 1024;
const READ_BYTES = 64 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const RECEIPT_ERROR = 'Не удалось подтвердить сохранение контекста Codex.';

export interface CodexContextReceipt { itemId: string; text: string }
interface ReceiptQuery extends CodexContextReceipt {
  codexHome: string; rolloutPath: string; threadId: string;
  alternatives?: CodexContextReceipt[];
}
interface ScanState {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  offset: number;
  verified: boolean;
  parts: Buffer[];
  partialBytes: number;
  receipts: Map<string, Set<string>>;
}

function textHash(text: string): string {
  return createHash('sha256').update(JSON.stringify(text)).digest('hex');
}

function contextItemId(id: string): boolean {
  return /^rele-context-[a-f0-9]{48}$/u.test(id) || /^msg_[a-f0-9]{48}$/u.test(id)
    || id.startsWith('rele_slack_') && id.length > 'rele_slack_'.length;
}

function inside(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Read persisted raw items only; an inject_items ACK is not a durable receipt. */
export class CodexContextReceipts {
  private files = new Map<string, ScanState>();
  private scanning: Promise<void> = Promise.resolve();

  has(query: ReceiptQuery): Promise<boolean> {
    const result = this.scanning.then(() => this.scan(query));
    this.scanning = result.then(() => undefined, () => undefined);
    return result;
  }

  clear(): void { this.files.clear(); }

  private async scan(query: ReceiptQuery): Promise<boolean> {
    let key: string | undefined;
    try {
      const candidates = [query, ...(query.alternatives ?? [])];
      if (!path.isAbsolute(query.codexHome) || !path.isAbsolute(query.rolloutPath)
        || path.extname(query.rolloutPath) !== '.jsonl' || !query.threadId
        || candidates.some(candidate => typeof candidate.itemId !== 'string' || !contextItemId(candidate.itemId) || typeof candidate.text !== 'string')) throw new Error();
      const home = await realpath(query.codexHome);
      const file = await realpath(query.rolloutPath);
      if (path.extname(file) !== '.jsonl'
        || !['sessions', 'archived_sessions'].some(directory => inside(path.join(home, directory), file))) throw new Error();
      key = JSON.stringify([home, file, query.threadId]);
      const target = await stat(file, { bigint: true });
      if (!target.isFile()) throw new Error();
      const handle = await open(file, 'r');
      try {
        const info = await handle.stat({ bigint: true });
        if (!info.isFile() || await realpath(query.rolloutPath) !== file || await realpath(file) !== file
          || target.dev !== info.dev || target.ino !== info.ino || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
        const end = Number(info.size);
        let state = this.files.get(key);
        if (!state || state.dev !== info.dev || state.ino !== info.ino || state.birthtimeNs !== info.birthtimeNs || end < state.offset) {
          state = { dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs, offset: 0, verified: false, parts: [], partialBytes: 0, receipts: new Map() };
          this.files.set(key, state);
        }
        // shortcut: native rollouts append or replace; detect in-place rewrites if that contract changes.
        while (state.offset < end) {
          const buffer = Buffer.allocUnsafe(Math.min(READ_BYTES, end - state.offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset);
          if (!bytesRead) throw new Error();
          const chunk = buffer.subarray(0, bytesRead);
          let start = 0;
          while (start < chunk.length) {
            const newline = chunk.indexOf(10, start);
            const part = chunk.subarray(start, newline === -1 ? chunk.length : newline);
            state.partialBytes += part.length;
            if (state.partialBytes > MAX_LINE_BYTES) throw new Error();
            state.parts.push(newline === -1 ? Buffer.from(part) : part);
            if (newline === -1) break;
            this.record(decoder.decode(Buffer.concat(state.parts, state.partialBytes)), state, query.threadId);
            state.parts = [];
            state.partialBytes = 0;
            start = newline + 1;
          }
          state.offset += bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const current = await stat(file, { bigint: true });
        if (after.size < info.size || current.dev !== info.dev || current.ino !== info.ino
          || await realpath(query.rolloutPath) !== file || await realpath(file) !== file) throw new Error();
        return state.verified && candidates.some(candidate => state.receipts.get(candidate.itemId)?.has(textHash(candidate.text)) === true);
      } finally {
        await handle.close();
      }
    } catch {
      if (key) this.files.delete(key);
      throw new Error(RECEIPT_ERROR);
    }
  }

  private record(line: string, state: ScanState, threadId: string): void {
    // Native rollouts can contain NUL-only rows after their session header.
    if (state.verified && /^\0+$/u.test(line)) return;
    const row = JSON.parse(line) as { type?: string; payload?: { type?: string; id?: string; role?: string; content?: { type?: string; text?: string }[] } } | null;
    if (!state.verified) {
      if (row?.type !== 'session_meta' || row.payload?.id !== threadId) throw new Error();
      state.verified = true;
      return;
    }
    const item = row?.payload;
    if (row?.type !== 'response_item' || item?.type !== 'message' || item.role !== 'user'
      || typeof item.id !== 'string' || !contextItemId(item.id) || !Array.isArray(item.content)
      || item.content.length !== 1 || item.content[0]?.type !== 'input_text' || typeof item.content[0].text !== 'string') return;
    const hashes = state.receipts.get(item.id) ?? new Set<string>();
    hashes.add(textHash(item.content[0].text));
    state.receipts.set(item.id, hashes);
  }
}
