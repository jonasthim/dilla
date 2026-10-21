// Message markdown: a small, pure, client-side parser. Its output is a tree of BodyPart values, never HTML, and a message
// body is rendered from that tree as React elements only. Nothing here fetches anything.
//
// Supported: **strong**, *em*, _em_, ~~strike~~, `code`, ```fenced code```, "> quote" lines, and bare http(s) and mailto
// links (shown as their own text). Everything else, including [text](url) and raw HTML, stays literal text.
import { splitMentions } from '@dilla/client-core';
import type { BodyPart } from '@dilla/ui';

/** One character, or one mention token (kept whole so code can give its literal form back). */
type Item = string | { m: string };
export type MentionResolver = (target: string) => BodyPart;

const MAX_DEPTH = 6;
const ESCAPABLE = new Set([...'\\`*_~>[]()<#']);
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;
// Controls, zero-width and bidi override characters never belong in a link that is shown as its own text.
const HOSTILE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const SCHEME = /^(?:https?:\/\/(?=[^/\s])|mailto:)/i;
const TRAILING = new Set([...'.,;:!?\'"*_~>]}']);

const raw = (item: Item): string => typeof item === 'string' ? item : `<@${item.m}>`;
const rawOf = (items: readonly Item[]): string => items.map(raw).join('');
const isSpace = (item: Item | undefined): boolean => item === undefined || (typeof item === 'string' && SPACE.test(item));
const isWord = (item: Item | undefined): boolean => typeof item === 'string' && WORD.test(item);
const runLength = (items: readonly Item[], at: number): number => {
  let n = 0;
  while (items[at + n] === items[at]) n++;
  return n;
};

/** A link target we accept: http, https or mailto, no credentials, no hostile characters. Anything else is null. */
export function safeLink(text: string): string | null {
  if (!SCHEME.test(text) || HOSTILE.test(text)) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol === 'mailto:') return url.pathname !== '' ? url.href : null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '' || url.username !== '' || url.password !== '') return null;
  return url.href;
}

class Out {
  readonly parts: BodyPart[] = [];
  text(s: string): void {
    if (s === '') return;
    const last = this.parts[this.parts.length - 1];
    if (last?.kind === 'text') last.text += s; else this.parts.push({ kind: 'text', text: s });
  }
  push(part: BodyPart): void { this.parts.push(part); }
}

function findTicks(items: readonly Item[], from: number, len: number): number {
  for (let i = from; i < items.length; i++) {
    if (items[i] !== '`') continue;
    const n = runLength(items, i);
    if (n === len) return i;
    i += n - 1;
  }
  return -1;
}

/** The index of the run of `marker`, exactly `len` long, that closes an opener, or -1. Code spans and escapes are skipped. */
function findClose(items: readonly Item[], from: number, marker: string, len: number, underscore: boolean): number {
  for (let i = from; i < items.length; i++) {
    const it = items[i];
    if (it === '\\') { i++; continue; }
    if (it === '`') {
      const n = runLength(items, i);
      const end = findTicks(items, i + n, n);
      i = end === -1 ? i + n - 1 : end + n - 1;
      continue;
    }
    if (it !== marker) continue;
    const n = runLength(items, i);
    if (n === len && i > from && !isSpace(items[i - 1]) && (!underscore || !isWord(items[i + n]))) return i;
    i += n - 1;
  }
  return -1;
}

function linkAt(items: readonly Item[], i: number): { part: BodyPart; end: number } | null {
  const before = items[i - 1];
  if (before !== undefined && typeof before === 'string' && !SPACE.test(before) && !'([{"\''.includes(before)) return null;
  let end = i;
  while (end < items.length) {
    const it = items[end];
    if (typeof it !== 'string' || SPACE.test(it) || it === '<' || it === '>') break;
    end++;
  }
  let chars = items.slice(i, end) as string[];
  if (!SCHEME.test(chars.join(''))) return null;
  for (;;) {
    const last = chars[chars.length - 1];
    if (last === undefined) return null;
    const opens = chars.filter(c => c === '(').length;
    const closes = chars.filter(c => c === ')').length;
    if (TRAILING.has(last) || (last === ')' && closes > opens)) chars = chars.slice(0, -1); else break;
  }
  const text = chars.join('');
  const href = safeLink(text);
  if (href === null) return null;
  return { part: { kind: 'link', href, text }, end: i + chars.length };
}

function inline(items: readonly Item[], resolve: MentionResolver, depth: number): BodyPart[] {
  const out = new Out();
  const wrap = (kind: 'strong' | 'em' | 'strike', inner: readonly Item[]): BodyPart => ({ kind, children: inline(inner, resolve, depth + 1) });
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (typeof it !== 'string') { out.push(resolve(it.m)); continue; }
    if (it === '\\') {
      const next = items[i + 1];
      if (typeof next === 'string' && ESCAPABLE.has(next)) { out.text(next); i++; } else out.text('\\');
      continue;
    }
    if (it === '`') {
      const n = runLength(items, i);
      const end = findTicks(items, i + n, n);
      if (end > i + n) { out.push({ kind: 'code', text: rawOf(items.slice(i + n, end)) }); i = end + n - 1; } else { out.text('`'.repeat(n)); i += n - 1; }
      continue;
    }
    if (it === 'h' || it === 'H' || it === 'm' || it === 'M') {
      const link = linkAt(items, i);
      if (link !== null) { out.push(link.part); i = link.end - 1; continue; }
    }
    if (depth < MAX_DEPTH && (it === '*' || it === '~' || it === '_')) {
      const n = runLength(items, i);
      let done = false;
      if (!isSpace(items[i + n]) && !(it === '_' && (n !== 1 || isWord(items[i - 1]))) && !(it === '~' && n !== 2)) {
        if (it === '*' && n === 3) {
          const close = findClose(items, i + 3, '*', 3, false);
          if (close !== -1) { out.push({ kind: 'strong', children: [wrap('em', items.slice(i + 3, close))] }); i = close + 2; done = true; }
        }
        const len = it === '*' ? Math.min(n, 2) : n;
        const close = done ? -1 : findClose(items, i + len, it, len, it === '_');
        if (close !== -1) {
          out.push(wrap(it === '~' ? 'strike' : len === 2 ? 'strong' : 'em', items.slice(i + len, close)));
          i = close + len - 1;
          done = true;
        }
      }
      if (!done) { out.text(it.repeat(n)); i += n - 1; }
      continue;
    }
    out.text(it);
  }
  return out.parts;
}

const splitLines = (items: readonly Item[]): Item[][] => {
  const out: Item[][] = [[]];
  for (const it of items) { if (it === '\n') out.push([]); else out[out.length - 1].push(it); }
  return out;
};
const joinLines = (ls: readonly (readonly Item[])[]): Item[] => ls.flatMap((l, n) => n === 0 ? [...l] : ['\n', ...l]);
const trimmed = (line: readonly Item[]): string => rawOf(line).trim();
const isQuote = (line: readonly Item[]): boolean => { const t = trimmed(line); return t === '>' || t.startsWith('> '); };

/**
 * Parses a message body (raw text with literal mention tokens) into parts. `resolve` turns a mention target into its pill;
 * code never resolves one, it keeps the literal token. Every character of the input is kept in the output except the
 * markers (`\ * _ ~` and a quote's `>`, and the fence lines) and the line breaks next to a block.
 */
export function parseMarkdown(body: string, resolve: MentionResolver): BodyPart[] {
  const items = splitMentions(body).flatMap((part): Item[] => part.kind === 'text' ? Array.from(part.text) : [{ m: part.target }]);
  const ls = splitLines(items);
  const out: BodyPart[] = [];
  let para: Item[][] = [];
  const flush = (): void => {
    if (para.length > 0) out.push(...inline(joinLines(para), resolve, 0));
    para = [];
  };
  // A block takes the line break that ends the text before it.
  const block = (part: BodyPart): void => {
    flush();
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text = last.text.replace(/\n$/, '');
    out.push(part);
  };
  for (let n = 0; n < ls.length; n++) {
    if (trimmed(ls[n]).startsWith('```')) {
      const close = ls.findIndex((l, k) => k > n && trimmed(l) === '```');
      if (close !== -1) {
        block({ kind: 'codeblock', text: ls.slice(n + 1, close).map(rawOf).join('\n') });
        n = close;
        continue;
      }
    }
    if (isQuote(ls[n])) {
      const quoted: Item[][] = [];
      for (; n < ls.length && isQuote(ls[n]); n++) {
        const at = ls[n].indexOf('>');
        quoted.push(ls[n].slice(at + (ls[n][at + 1] === ' ' ? 2 : 1)));
      }
      n--;
      block({ kind: 'quote', children: inline(joinLines(quoted), resolve, 1) });
      continue;
    }
    // The line break after a block is the block's own: a text line right after one starts fresh.
    para.push(ls[n]);
  }
  flush();
  return out;
}
