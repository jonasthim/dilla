// Literal mention tokens and composer mention matching.
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- literal forms are part of the public ledger interface.
export type MentionTarget = 'everyone' | 'here' | string;
export type MentionPart = { kind: 'text'; text: string } | { kind: 'mention'; target: MentionTarget };
export interface MentionMember { userId: string; username: string; }
const TOKEN = /<@(everyone|here|[0-9a-f]{32})>/g;
const BOUNDARY = /[\s([{"']/;
const WORD = /[A-Za-z0-9._-]/;
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
export function encodeMentions(text: string, members: readonly MentionMember[], broadcast: boolean): string {
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] !== '@' || !boundary(text, i)) { out += text[i++]; continue; }
    let end = i + 1;
    while (end < text.length && WORD.test(text[end])) end++;
    let wordEnd = end;
    while (wordEnd > i + 1 && text[wordEnd - 1] === '.') wordEnd--;
    const word = text.slice(i + 1, wordEnd);
    const lower = word.toLowerCase();
    const target = broadcast && (lower === 'everyone' || lower === 'here') ? lower :
      members.find((m) => m.username.toLowerCase() === lower)?.userId;
    if (word && target) { out += `<@${target}>`; i = wordEnd; }
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
