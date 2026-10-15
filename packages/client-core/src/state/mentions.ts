// Literal mention tokens and composer mention matching.
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- literal forms are part of the public ledger interface.
export type MentionTarget = 'everyone' | 'here' | string;
export type MentionPart = { kind: 'text'; text: string } | { kind: 'mention'; target: MentionTarget };
export interface MentionMember { userId: string; username: string; }
export interface MentionRole { roleId: string; handle: string; }
/** The text after `@` that names a role: NFC, lower case, whitespace runs as one dash. */
export function roleHandle(name: string): string { return name.normalize('NFC').toLowerCase().trim().replace(/\s+/g, '-'); }
const TOKEN = /<@(everyone|here|[0-9a-f]{32})>/g;
const BOUNDARY = /[\s([{"']/;
const WORD = /[\p{L}\p{M}\p{N}._-]/u;
const NAME_CHAR = /[\p{L}\p{M}\p{N}_-]/u;
// CJK has no spaces, so a mention ends where such text starts.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
function boundary(text: string, at: number): boolean { return at === 0 || BOUNDARY.test(text[at - 1]); }
export function splitMentions(body: string): MentionPart[] {
  const out: MentionPart[] = [];
  let start = 0;
  for (const match of body.matchAll(TOKEN)) {
    const at = match.index;
    if (at > start) out.push({ kind: 'text', text: body.slice(start, at) });
    out.push({ kind: 'mention', target: match[1] });
    start = at + match[0].length;
  }
  if (start < body.length) out.push({ kind: 'text', text: body.slice(start) });
  return out;
}
// A candidate ends a mention at the end of the text, before CJK text, at a dot run that no name continues past,
// or at any other non-name character, so `@ada@bob` still reads `@ada`.
function endsMention(text: string, at: number): boolean {
  if (at >= text.length) return true;
  const ch = String.fromCodePoint(text.codePointAt(at) ?? 0);
  if (CJK.test(ch)) return true;
  if (ch === '.') {
    let dots = at;
    while (dots < text.length && text[dots] === '.') dots++;
    return dots >= text.length || !NAME_CHAR.test(String.fromCodePoint(text.codePointAt(dots) ?? 0)) || CJK.test(String.fromCodePoint(text.codePointAt(dots) ?? 0));
  }
  return !NAME_CHAR.test(ch);
}
// Longest match wins; on equal length broadcast beats member, member beats role (first listed wins ties).
export function encodeMentions(text: string, members: readonly MentionMember[], broadcast: boolean, roles: readonly MentionRole[] = []): string {
  if (!text.includes('@')) return text;
  text = text.normalize('NFC');
  const candidates: { handle: string; target: string }[] = [];
  if (broadcast) candidates.push({ handle: 'everyone', target: 'everyone' }, { handle: 'here', target: 'here' });
  for (const m of members) candidates.push({ handle: m.username.normalize('NFC').toLowerCase(), target: m.userId });
  for (const r of roles) candidates.push({ handle: r.handle.normalize('NFC').toLowerCase(), target: r.roleId });
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] !== '@' || !boundary(text, i)) { out += text[i++]; continue; }
    let best: { handle: string; target: string } | undefined;
    for (const c of candidates) {
      if (!c.handle || (best && c.handle.length <= best.handle.length)) continue;
      if (text.slice(i + 1, i + 1 + c.handle.length).toLowerCase() === c.handle && endsMention(text, i + 1 + c.handle.length)) best = c;
    }
    if (best) { out += `<@${best.target}>`; i += 1 + best.handle.length; }
    else out += text[i++];
  }
  return out;
}
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  if (caret < 0 || caret > text.length) return null;
  let at = caret;
  while (at > 0 && WORD.test(text[at - 1])) at--;
  if (at === 0 || text[at - 1] !== '@' || !boundary(text, at - 1) || caret - at > 32) return null;
  return { start: at - 1, query: text.slice(at, caret) };
}
export function mentionsMe(body: string, userHex: string, roleHexes: readonly string[]): boolean {
  return body.includes(`<@${userHex}>`) || body.includes('<@everyone>') || body.includes('<@here>') ||
    roleHexes.some((role) => body.includes(`<@${role}>`));
}
/** Like `mentionsMe` without @everyone and @here: the user or one of their roles, named. */
export function mentionsDirectly(body: string, userHex: string, roleHexes: readonly string[]): boolean {
  return body.includes(`<@${userHex}>`) || roleHexes.some((role) => body.includes(`<@${role}>`));
}
