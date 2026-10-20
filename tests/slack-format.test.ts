import { describe, expect, it } from 'vitest';
import { escapeSlackText, formatSlackReply, splitSlackReply } from '../src/server/channels/slack-format.js';

describe('Slack reply formatting', () => {
  it('keeps native Markdown and readable source paths from a desktop answer', () => {
    const text = '# Проверка\n\n**Готово**: [документ](https://example.com/a_(b)).\n\n| Файл | Статус |\n| --- | --- |\n| Отчёт | готов |\n\n:codex-file-citation{path="C:/Users/владелец/Документы/Отчёт.md" purpose="source"}';
    expect(formatSlackReply(text)).toBe(text.replace(':codex-file-citation{path="C:/Users/владелец/Документы/Отчёт.md" purpose="source"}', '`C:/Users/владелец/Документы/Отчёт.md`'));
  });

  it('preserves directive examples in code while making unsupported/malformed directives readable', () => {
    const example = '`' + ':codex-file-citation{path="example.ts"}' + '`\n```md\n:codex-file-citation{path="sample.ts"}\n```';
    expect(formatSlackReply(example)).toBe(example);
    expect(formatSlackReply('``:codex-file-citation{path="sample.ts"}``')).toBe('``:codex-file-citation{path="sample.ts"}``');
    expect(formatSlackReply(':codex-followup[Продолжить]{prompt="continue"}')).toBe('Продолжить');
    expect(formatSlackReply(':codex-file-citation{path="C:/broken.md"')).toBe('`C:/broken.md`');
    expect(formatSlackReply(':codex-file-citation{purpose="source"}')).toBe('Источник');
    expect(formatSlackReply('Данные citeturn1search0')).toBe('Данные [источник]');
  });

  it('neutralizes broadcasts, users and user groups without breaking links', () => {
    const text = '<!here> <!channel> <!everyone> <@U123> <@U456|Анна> <!subteam^S123|@команда> @here [сайт](https://example.com) <https://example.com|сайт>';
    const formatted = formatSlackReply(text);
    expect(formatted).toBe('@\u200bhere @\u200bchannel @\u200beveryone @\u200bU123 @\u200bАнна @\u200bкоманда @\u200bhere [сайт](https://example.com) <https://example.com|сайт>');
    expect(formatSlackReply(formatted)).toBe(formatted);
    expect(formatSlackReply('[сайт](https://example.com/@here) <https://example.com/@channel|сайт>')).toBe('[сайт](https://example.com/@here) <https://example.com/@channel|сайт>');
    expect(escapeSlackText('a & b <@U123> <tag>')).toBe('a &amp; b &lt;@U123&gt; &lt;tag&gt;');
  });
});

describe('Slack reply splitting', () => {
  it('keeps a normal table and fenced code together when a chunk boundary is nearby', () => {
    const table = '| Файл | Статус |\n| --- | --- |\n| Отчёт | готов |\n';
    const code = '```ts\nconst x = "привет";\n```\n';
    const parts = splitSlackReply(`${'Начало. '.repeat(8)}\n${table}\n${code}`, 100);
    expect(parts.some((part) => part.includes(table))).toBe(true);
    expect(parts.some((part) => part.includes(code))).toBe(true);
    expect(parts.every((part) => part.length <= 100)).toBe(true);
    expect(parts.join('')).toBe(`${'Начало. '.repeat(8)}\n${table}\n${code}`);
  });

  it('repeats table headers while keeping every data row and native row limits', () => {
    const header = '| Имя | Ответ |\n| --- | --- |\n';
    const rows = Array.from({ length: 220 }, (_, index) => `| строка${index} | готово |\n`);
    const parts = splitSlackReply(header + rows.join(''));
    expect(parts).toHaveLength(3);
    expect(parts.every((part) => part.startsWith(header) && part.length <= 9000 && part.split('\n').filter(Boolean).length <= 101)).toBe(true);
    expect(parts.map((part) => part.slice(header.length)).join('')).toBe(rows.join(''));
  });

  it('uses readable code for overwide or overlong table rows', () => {
    const wide = `| ${Array.from({ length: 21 }, (_, i) => `c${i}`).join(' | ')} |\n| ${Array(21).fill('---').join(' | ')} |\n`;
    const long = '| Имя | Ответ |\n| --- | --- |\n| большой | ' + 'я😀'.repeat(8000) + ' |\n';
    for (const table of [wide, long]) {
      const parts = splitSlackReply(table);
      expect(parts.every((part) => part.startsWith('~~~\n') && part.endsWith('~~~\n') && part.length <= 9000)).toBe(true);
      expect(parts.map((part) => part.slice(4, -4).replace(/\n$/u, '')).join('')).toBe(table.replace(/\n$/u, ''));
    }
  });

  it('also bounds a long single-column table without losing rows', () => {
    const header = '| Имя |\n| --- |\n';
    const rows = Array.from({ length: 220 }, (_, index) => `| строка${index} |\n`).join('');
    const parts = splitSlackReply(header + rows);
    expect(parts).toHaveLength(3);
    expect(parts.every(part => part.startsWith(header) && part.split('\n').filter(Boolean).length <= 101)).toBe(true);
    expect(parts.map(part => part.slice(header.length)).join('')).toBe(rows);
  });

  it('closes and reopens long code without losing its body or Unicode characters', () => {
    const body = 'const текст = "😀 русский";\n'.repeat(700);
    const parts = splitSlackReply('```ts\n' + body + '```\n');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.startsWith('```ts\n') && part.endsWith('```\n') && part.length <= 9000)).toBe(true);
    expect(parts.map((part) => part.slice(6, -4)).join('')).toBe(body);
  });

  it('splits long plain pages without losing newlines or surrogate pairs', () => {
    const text = '😀 русский текст\n'.repeat(3000) + '😀'.repeat(9000);
    const parts = splitSlackReply(text);
    expect(parts.every((part) => part.length <= 9000 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(part))).toBe(true);
    expect(parts.join('')).toBe(text);
  });

  it('provides an empty answer and rejects impossible budgets', () => {
    expect(splitSlackReply('')).toEqual(['Codex завершил задачу без текстового ответа.']);
    for (const limit of [0, 1, 15, 12001, NaN]) expect(() => splitSlackReply('text', limit)).toThrow(RangeError);
  });
});
