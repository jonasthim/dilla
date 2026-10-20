import { describe, it, expect } from 'vitest';
import { ariaKeyshortcuts } from './ariaKeys.ts';

describe('ariaKeyshortcuts', () => {
  it('maps display key names to ARIA key names and joins the chord with +', () => {
    expect(ariaKeyshortcuts(['Ctrl', 'K'])).toBe('Control+K');
    expect(ariaKeyshortcuts(['⌘', '⇧', 'P'])).toBe('Meta+Shift+P');
    expect(ariaKeyshortcuts(['⌥', 'Enter'])).toBe('Alt+Enter');
    expect(ariaKeyshortcuts(['Esc'])).toBe('Escape');
    expect(ariaKeyshortcuts(['Alt', '↑'])).toBe('Alt+ArrowUp');
    expect(ariaKeyshortcuts(['↓', '←', '→'])).toBe('ArrowDown+ArrowLeft+ArrowRight');
    expect(ariaKeyshortcuts(['Del', 'PgUp', 'Space', '↵'])).toBe('Delete+PageUp+Space+Enter');
  });
  it('keeps a key it does not know and the case of a letter', () => {
    expect(ariaKeyshortcuts(['Ctrl', '/'])).toBe('Control+/');
    expect(ariaKeyshortcuts(['F6'])).toBe('F6');
  });
});
