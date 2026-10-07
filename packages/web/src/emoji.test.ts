import { describe, it, expect } from 'vitest';
import { en } from './strings/en.ts';
import { REACTION_EMOJI, reactionName } from './emoji.ts';

describe('the reaction set (ruling 22)', () => {
  it('is Mesh’s 32, in order, each named by its key', () => {
    expect(REACTION_EMOJI.map(e => e.emoji)).toEqual([
      '\u{1F44D}', '\u{1F44E}', '❤️', '\u{1F604}', '\u{1F602}', '\u{1F622}', '\u{1F621}', '\u{1F60D}',
      '\u{1F389}', '\u{1F525}', '\u{1F4AF}', '✨', '\u{1F64F}', '\u{1F440}', '\u{1F914}', '\u{1F634}',
      '\u{1F6E0}', '\u{1F680}', '✅', '❌', '\u{1F4A1}', '\u{1F4CC}', '\u{1F41B}', '\u{1F4E6}',
      '☕', '\u{1F355}', '\u{1F32E}', '\u{1F3A8}', '\u{1F3B5}', '\u{1F319}', '☀️', '\u{1F980}',
    ]);
    expect(REACTION_EMOJI.map(e => e.key)).toEqual(Array.from({ length: 32 }, (_, i) => `shell.emoji.${String(i + 1).padStart(2, '0')}`));
    expect(REACTION_EMOJI.map(e => en[e.key])).toEqual([
      'thumbs up', 'thumbs down', 'red heart', 'grinning face', 'tears of joy', 'crying face', 'angry face', 'heart eyes',
      'party popper', 'fire', 'hundred points', 'sparkles', 'folded hands', 'eyes', 'thinking face', 'sleeping face',
      'hammer and wrench', 'rocket', 'check mark', 'cross mark', 'light bulb', 'pushpin', 'bug', 'package',
      'hot beverage', 'pizza', 'taco', 'artist palette', 'musical note', 'crescent moon', 'sun', 'crab',
    ]);
  });
  it('names an emoji outside the set by itself', () => {
    expect(reactionName('\u{1F680}')).toBe('rocket');
    expect(reactionName('❤️')).toBe('red heart');
    expect(reactionName('\u{1F984}')).toBe('\u{1F984}');
  });
});
