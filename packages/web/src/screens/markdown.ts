// Message markdown: a small, pure, client-side parser. Its output is a tree of BodyPart values, never HTML, and a message
// body is rendered from that tree as React elements only. Nothing here fetches anything.
//
// Supported: **strong**, *em*, _em_, ~~strike~~, `code`, ```fenced code```, "> quote" lines, and bare http(s) and mailto
// links. A link always shows exactly the address it opens (the normalised href, with a non-ASCII host as punycode).
// Everything else, including [text](url) and raw HTML, stays literal text.
//
// Cost: every scan that could repeat (the closer of an emphasis marker, the closer of a code span, the closing fence) is
// answered from an index built once per call, so a parse is O(n log n); link attempts draw on a fixed work budget.
import { splitMentions } from '@dilla/client-core';
import type { BodyPart } from '@dilla/ui';

/** One character, or one mention token (kept whole so code can give its literal form back). */
type Item = string | { m: string };
export type MentionResolver = (target: string) => BodyPart;

/** A parsed body before mentions are resolved to pills, so it can be cached by the body text alone. */
type Tree =
  | { kind: 'text'; text: string }
  | { kind: 'ref'; target: string }
  | { kind: 'strong' | 'em' | 'strike' | 'quote'; children: Tree[] }
  | { kind: 'code'; text: string }
  | { kind: 'codeblock'; text: string; lang?: string }
  | { kind: 'link'; href: string; text: string };

const MAX_DEPTH = 6;
const LINK_BUDGET = 100_000;
const ESCAPABLE = new Set([...'\\`*_~>[]()<#']);
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;
// Controls, every format character (bidi controls, zero-width, tag characters), line and paragraph separators, and the
// blank fillers. None of them belongs in an address that is shown as its own text.
const HOSTILE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}͏ᅟᅠ᠎⠀ㅤﾠ\u{e0000}-\u{e007f}]/u;
// Bidi controls: removed from the text around a link so they cannot reorder the link's characters.
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
const SCHEME = /^(?:https?:\/\/(?=[^/\s])|mailto:)/i;
const MAILTO = /^mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)$/i;
const FENCE = /^```([A-Za-z0-9+#._-]{0,32})$/;
const TRAILING = new Set([...'.,;:!?\'"*_~>]}']);

const raw = (item: Item): string => typeof item === 'string' ? item : `<@${item.m}>`;
const rawOf = (items: readonly Item[]): string => items.map(raw).join('');
const isSpace = (item: Item | undefined): boolean => item === undefined || (typeof item === 'string' && SPACE.test(item));
const isWord = (item: Item | undefined): boolean => typeof item === 'string' && WORD.test(item);

/**
 * A link target we accept, as the address it opens: http or https with a real host and no credentials, or a bare
 * `mailto:address` (no query, so no `attach`, `body` or `cc`). Anything else is null. A non-ASCII host comes back as punycode.
 */
export function safeLink(text: string): string | null {
  if (!SCHEME.test(text) || HOSTILE.test(text)) return null;
  if (/^mailto:/i.test(text)) {
    const mail = MAILTO.exec(text);
    return mail === null ? null : `mailto:${mail[1]}`;
  }
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '' || url.username !== '' || url.password !== '') return null;
  return url.href;
}

class Out {
  private readonly out: Tree[] = [];
  private buf: string[] = [];
  /** Plain text is gathered as chunks and joined once, not appended a character at a time. */
  text(s: string): void { if (s !== '') this.buf.push(s); }
  push(part: Tree): void { this.flush(); this.out.push(part); }
  private flush(): void {
    if (this.buf.length > 0) this.out.push({ kind: 'text', text: this.buf.join('') });
    this.buf = [];
  }
  get parts(): Tree[] { this.flush(); return this.out; }
}

/** Per-call lookups, built in one pass, that replace the forward scans. */
interface Index {
  /** Length of the run of equal characters that starts at i. */
  run: Int32Array;
  /** Inside a code span, or escaped by a backslash. */
  skip: Uint8Array;
  /** The next end of a word (a space, `<`, `>` or a mention) at or after i. */
  stop: Int32Array;
  ticks: Map<number, number[]>;
  closers: Map<string, number[]>;
  budget: number;
}

/** The first element of a sorted list that is >= at, or -1. */
function firstFrom(list: readonly number[] | undefined, at: number): number {
  if (list === undefined) return -1;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < at) lo = mid + 1; else hi = mid; }
  return lo < list.length ? list[lo] : -1;
}

function buildIndex(items: readonly Item[]): Index {
  const n = items.length;
  const run = new Int32Array(n + 1);
  const stop = new Int32Array(n + 1);
  stop[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const it = items[i];
    run[i] = i + 1 < n && items[i + 1] === it ? run[i + 1] + 1 : 1;
    stop[i] = typeof it !== 'string' || SPACE.test(it) || it === '<' || it === '>' ? i : stop[i + 1];
  }
  const ticks = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (items[i] !== '`' || (i > 0 && items[i - 1] === '`')) continue;
    const list = ticks.get(run[i]);
    if (list === undefined) ticks.set(run[i], [i]); else list.push(i);
  }
  const skip = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const it = items[i];
    if (it === '\\') {
      const next = items[i + 1];
      if (typeof next === 'string' && ESCAPABLE.has(next)) { skip[i] = 1; skip[i + 1] = 1; i++; }
    } else if (it === '`') {
      const len = run[i];
      const end = firstFrom(ticks.get(len), i + len);
      if (end === -1) { i += len - 1; continue; }
      for (let k = i; k < end + len; k++) skip[k] = 1;
      i = end + len - 1;
    }
  }
  const closers = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const it = items[i];
    if (skip[i] === 1 || (it !== '*' && it !== '~' && it !== '_')) continue;
    const len = run[i];
    if (i > 0 && !isSpace(items[i - 1]) && (it !== '_' || !isWord(items[i + len]))) {
      const key = `${it}${len}`;
      const list = closers.get(key);
      if (list === undefined) closers.set(key, [i]); else list.push(i);
    }
    i += len - 1;
  }
  return { run, skip, stop, ticks, closers, budget: LINK_BUDGET };
}

/** The run of `marker`, exactly `len` long, that closes an opener whose marker ends at `from`, or -1. */
const findClose = (idx: Index, marker: string, len: number, from: number): number => firstFrom(idx.closers.get(`${marker}${len}`), from + 1);

function linkAt(items: readonly Item[], idx: Index, i: number): { part: Tree; end: number } | null {
  const before = items[i - 1];
  if (before !== undefined && typeof before === 'string' && !SPACE.test(before) && !'([{"\''.includes(before)) return null;
  const head = items.slice(i, i + 9);
  if (!head.every((h): h is string => typeof h === 'string') || !SCHEME.test(head.join(''))) return null;
  const end = idx.stop[i];
  idx.budget -= end - i;
  if (idx.budget < 0) return null;
  const chars = items.slice(i, end) as string[];
  let opens = 0;
  let closes = 0;
  for (const c of chars) { if (c === '(') opens++; else if (c === ')') closes++; }
  for (let last = chars[chars.length - 1]; last !== undefined; last = chars[chars.length - 1]) {
    if (last === ')' && closes > opens) { closes--; chars.pop(); } else if (TRAILING.has(last)) chars.pop(); else break;
  }
  const href = safeLink(chars.join(''));
  if (href === null) return null;
  return { part: { kind: 'link', href, text: href }, end: i + chars.length };
}

function inline(items: readonly Item[], depth: number): Tree[] {
  const out = new Out();
  const idx = buildIndex(items);
  const wrap = (kind: 'strong' | 'em' | 'strike', inner: readonly Item[]): Tree => ({ kind, children: inline(inner, depth + 1) });
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (typeof it !== 'string') { out.push({ kind: 'ref', target: it.m }); continue; }
    if (it === '\\') {
      const next = items[i + 1];
      if (typeof next === 'string' && ESCAPABLE.has(next)) { out.text(next); i++; } else out.text('\\');
      continue;
    }
    if (it === '`') {
      const n = idx.run[i];
      const end = firstFrom(idx.ticks.get(n), i + n);
      if (end > i + n) { out.push({ kind: 'code', text: rawOf(items.slice(i + n, end)) }); i = end + n - 1; } else { out.text('`'.repeat(n)); i += n - 1; }
      continue;
    }
    if (it === 'h' || it === 'H' || it === 'm' || it === 'M') {
      const link = linkAt(items, idx, i);
      if (link !== null) { out.push(link.part); i = link.end - 1; continue; }
    }
    if (depth < MAX_DEPTH && (it === '*' || it === '~' || it === '_')) {
      const n = idx.run[i];
      let done = false;
      if (!isSpace(items[i + n]) && !(it === '_' && (n !== 1 || isWord(items[i - 1]))) && !(it === '~' && n !== 2)) {
        if (it === '*' && n === 3) {
          const close = findClose(idx, '*', 3, i + 3);
          if (close !== -1) { out.push({ kind: 'strong', children: [wrap('em', items.slice(i + 3, close))] }); i = close + 2; done = true; }
        }
        const len = it === '*' ? Math.min(n, 2) : n;
        const close = done ? -1 : findClose(idx, it, len, i + len);
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
const isQuoteText = (t: string): boolean => t === '>' || t.startsWith('> ');

interface Parsed { tree: Tree[]; links: boolean }

function parseUncached(body: string): Parsed {
  const items = splitMentions(body).flatMap((part): Item[] => part.kind === 'text' ? Array.from(part.text) : [{ m: part.target }]);
  const ls = splitLines(items);
  const lt = ls.map(l => rawOf(l).trim());
  // The first line at or after k that is exactly a fence, found once for every opener.
  const nextFence = new Int32Array(ls.length + 1).fill(-1);
  for (let k = ls.length - 1; k >= 0; k--) nextFence[k] = lt[k] === '```' ? k : nextFence[k + 1];
  const out: Tree[] = [];
  let para: Item[][] = [];
  const flush = (): void => {
    if (para.length > 0) out.push(...inline(joinLines(para), 0));
    para = [];
  };
  // A block takes the line break that ends the text before it.
  const block = (part: Tree): void => {
    flush();
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text = last.text.replace(/\n$/, '');
    out.push(part);
  };
  for (let n = 0; n < ls.length; n++) {
    const fence = FENCE.exec(lt[n]);
    // A fence that is never closed, or whose opening line says more than a language, is literal text.
    if (fence !== null && nextFence[n + 1] !== -1) {
      const close = nextFence[n + 1];
      block({ kind: 'codeblock', text: ls.slice(n + 1, close).map(rawOf).join('\n'), ...(fence[1] === '' ? {} : { lang: fence[1] }) });
      n = close;
      continue;
    }
    if (isQuoteText(lt[n])) {
      const quoted: Item[][] = [];
      for (; n < ls.length && isQuoteText(lt[n]); n++) {
        const at = ls[n].indexOf('>');
        quoted.push(ls[n].slice(at + (ls[n][at + 1] === ' ' ? 2 : 1)));
      }
      n--;
      block({ kind: 'quote', children: inline(joinLines(quoted), 1) });
      continue;
    }
    // The line break after a block is the block's own: a text line right after one starts fresh.
    para.push(ls[n]);
  }
  flush();
  const links = hasLink(out);
  return { tree: links ? out.map(strip) : out, links };
}

const hasLink = (tree: readonly Tree[]): boolean => tree.some(p => p.kind === 'link' || ('children' in p && hasLink(p.children)));
const unbidi = (s: string): string => s.replace(BIDI, '');
function strip(p: Tree): Tree {
  switch (p.kind) {
    case 'text': case 'code': case 'codeblock': return { ...p, text: unbidi(p.text) };
    case 'strong': case 'em': case 'strike': case 'quote': return { ...p, children: p.children.map(strip) };
    default: return p;
  }
}

/** The memo holds at most this many bodies and this many characters of them, and never a body longer than a message can be. */
export const CACHE_LIMITS = { entries: 200, chars: 2_000_000, body: 4000 } as const;
const cache = new Map<string, Parsed>();
let cachedChars = 0;
export const cacheSize = (): { entries: number; chars: number } => ({ entries: cache.size, chars: cachedChars });
/** The parse of a body, remembered by the body text (least recently used goes first), so a re-render of an unchanged message does not parse again. */
export function parseTree(body: string): Parsed {
  const hit = cache.get(body);
  if (hit !== undefined) { cache.delete(body); cache.set(body, hit); return hit; }
  const parsed = parseUncached(body);
  if (body.length > CACHE_LIMITS.body) return parsed;
  cache.set(body, parsed);
  cachedChars += body.length;
  for (const [key] of cache) {
    if (cache.size <= CACHE_LIMITS.entries && cachedChars <= CACHE_LIMITS.chars) break;
    cache.delete(key);
    cachedChars -= key.length;
  }
  return parsed;
}
/** The same parse without the memo (for timing). */
export const parseTreeUncached = parseUncached;

function resolveTree(tree: readonly Tree[], resolve: MentionResolver, links: boolean): BodyPart[] {
  return tree.map((p): BodyPart => {
    switch (p.kind) {
      case 'ref': {
        const pill = resolve(p.target);
        return links && pill.kind === 'mention' ? { ...pill, label: unbidi(pill.label) } : pill;
      }
      case 'strong': case 'em': case 'strike': case 'quote': return { kind: p.kind, children: resolveTree(p.children, resolve, links) };
      default: return p;
    }
  });
}

/**
 * Parses a message body (raw text with literal mention tokens) into parts. `resolve` turns a mention target into its pill;
 * code never resolves one, it keeps the literal token. Every character of the input is kept in the output except the
 * markers (`\ * _ ~` and a quote's `>`, and the fence lines) and the line breaks next to a block. In a body that holds a
 * link, bidi controls are removed from the text around it, so nothing can reorder the link's characters.
 */
export function parseMarkdown(body: string, resolve: MentionResolver): BodyPart[] {
  const { tree, links } = parseTree(body);
  return resolveTree(tree, resolve, links);
}
