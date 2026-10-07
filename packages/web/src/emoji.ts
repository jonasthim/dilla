// Mesh's fixed, named reaction set.
import { t, type StringKey } from './strings/index.ts';

const EMOJI = [
  '\u{1F44D}', '\u{1F44E}', '❤️', '\u{1F604}', '\u{1F602}', '\u{1F622}', '\u{1F621}', '\u{1F60D}',
  '\u{1F389}', '\u{1F525}', '\u{1F4AF}', '✨', '\u{1F64F}', '\u{1F440}', '\u{1F914}', '\u{1F634}',
  '\u{1F6E0}', '\u{1F680}', '✅', '❌', '\u{1F4A1}', '\u{1F4CC}', '\u{1F41B}', '\u{1F4E6}',
  '☕', '\u{1F355}', '\u{1F32E}', '\u{1F3A8}', '\u{1F3B5}', '\u{1F319}', '☀️', '\u{1F980}',
] as const;

export const REACTION_EMOJI: readonly { emoji: string; key: StringKey }[] = Object.freeze(EMOJI.map((emoji, i) => ({
  emoji, key: `shell.emoji.${String(i + 1).padStart(2, '0')}` as StringKey,
})));

export function reactionName(emoji: string): string {
  const item = REACTION_EMOJI.find(e => e.emoji === emoji);
  return item === undefined ? emoji : t(item.key);
}
