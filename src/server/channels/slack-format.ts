const EMPTY_REPLY = 'Codex завершил задачу без текстового ответа.';
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u;

export function formatSlackReply(text: string): string {
  // Keep quoted examples opaque while translating Codex's UI-only references.
  return text.split(/(`{3,}[\s\S]*?(?:`{3,}|$)|~{3,}[\s\S]*?(?:~{3,}|$)|``[^\n]*?``|`[^`\n]*`)/gu).map((part, index) => {
    if (index % 2) return part;
    const lines = part.split(/(\r?\n)/u);
    for (let line = 0; line < lines.length; line += 2) {
      let removed = false, atEnd = false;
      const original = lines[line];
      lines[line] = original.replace(/:{1,2}codex-annotation(?![\w-])(?:\[[^\]\n]*(?:\]|$))?(?:\{[^}\n]*(?:\}|$))?(?:[ \t]*$)?/gu, (match, offset: number) => {
        removed = true;
        atEnd = offset + match.length === original.length;
        return '';
      });
      if (removed && !lines[line].trim()) { lines[line] = ''; if (line + 1 < lines.length) lines[line + 1] = ''; }
      else if (atEnd) lines[line] = lines[line].trimEnd();
    }
    return lines.join('').replace(/:{1,2}(codex-[\w-]+|code-comment)(?:\[([^\]\n]*)\])?(?:\{([^}\n]*)(?:\}|$))?/gmu, (_match, name: string, label: string | undefined, attributes: string | undefined) => {
      const path = attributes?.match(/\bpath\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s}]+))/u);
      if (path) return `\`${(path[1] ?? path[2] ?? path[3]).replace(/`/gu, 'ˋ')}\``;
      return label || attributes?.match(/\b(?:title|text|label)="([^"]*)"/u)?.[1] || (name === 'codex-file-citation' ? 'Источник' : attributes || '');
    }).replace(/(?:cite|filecite)[^\n]*(?:|$)/gu, '[источник]')
      .split(/(https?:\/\/[^\s<>]+)/gu).map((span, spanIndex) => spanIndex % 2 ? span : span.replace(/<([@!])([^>\n]+)>/gu, (match, kind: string, value: string) => {
        const [id, label] = value.split('|');
        return kind === '@' || /^(?:here|channel|everyone|subteam\^)/u.test(id)
          ? `@\u200b${(label || id.replace(/^subteam\^/u, '')).replace(/^@/u, '')}` : match;
      }).replace(/(?<![\w@])@(here|channel|everyone)\b/giu, '@\u200b$1')).join('');
  }).join('');
}

export function escapeSlackText(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function splitText(text: string, limit: number): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline > start + limit / 2) end = newline + 1;
    }
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function splitCode(text: string, opening: string, body: string, fence: string, limit: number): string[] {
  const budget = limit - opening.length - fence.length - 2;
  // shortcut: oversized fence labels become readable text; use a file for such code blocks.
  if (budget < 2) return splitText(text.replace(/^([ \t]*)([`~])(?=\2{2})/gmu, '$1$2\u200b'), limit);
  const parts = splitText(body, budget);
  return (parts.length ? parts : ['']).map((part) => `${opening}${part}${part.endsWith('\n') ? '' : '\n'}${fence}\n`);
}

function splitTable(lines: string[], limit: number): string[] {
  limit = Math.min(limit, 10_000);
  const header = lines.slice(0, 2).join('');
  const columns = (line: string) => line.trim().replace(/^\||\|$/gu, '').split(/(?<!\\)\|/u).length;
  // shortcut: overwide tables/rows use fenced text; use a file for tables beyond Slack's grid limits.
  if (lines.some((line) => columns(line) > 20) || header.length >= limit || lines.slice(2).some((line) => header.length + line.length > limit)) {
    const text = lines.join('');
    return splitCode(text, '~~~\n', text, '~~~', limit);
  }
  const parts: string[] = [];
  let current = header;
  let rows = 1;
  for (const line of lines.slice(2)) {
    if (current.length + line.length > limit || rows === 100) {
      parts.push(current);
      current = header;
      rows = 1;
    }
    current += line;
    rows++;
  }
  parts.push(current);
  return parts;
}

export function splitSlackReply(raw: string, limit = 9000): string[] {
  if (!Number.isSafeInteger(limit) || limit < 16 || limit > 12_000) throw new RangeError('Slack message limit must be between 16 and 12000.');
  const text = formatSlackReply(raw);
  if (!text.trim()) return [EMPTY_REPLY];
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const parts: string[] = [];
  let current = '';
  const flush = () => { if (current) parts.push(current); current = ''; };
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const fence = line.match(/^[ \t]*(`{3,}|~{3,})[^\n]*\n?$/u)?.[1];
    let blocks: string[];
    if (fence) {
      let end = index + 1;
      const closing = new RegExp(`^[ \\t]*${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n)?$`, 'u');
      while (end < lines.length && !closing.test(lines[end])) end++;
      const block = lines.slice(index, end + (end < lines.length ? 1 : 0)).join('');
      blocks = end < lines.length && block.length <= limit ? [block]
        : splitCode(block, line.endsWith('\n') ? line : `${line}\n`, lines.slice(index + 1, end).join(''), fence, limit);
      index = end + (end < lines.length ? 1 : 0);
    } else if (line.includes('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1])) {
      let end = index + 2;
      while (end < lines.length && lines[end].trim() && lines[end].includes('|')) end++;
      blocks = splitTable(lines.slice(index, end), limit);
      index = end;
    } else {
      blocks = splitText(line, limit);
      index++;
    }
    if (blocks.length > 1) {
      flush();
      parts.push(...blocks);
    } else for (const block of blocks) {
      if (current.length + block.length > limit) flush();
      current += block;
    }
  }
  flush();
  return parts;
}
