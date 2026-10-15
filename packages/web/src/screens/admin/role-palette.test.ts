import { describe, expect, it } from 'vitest';
import { paletteFor } from './role-palette.ts';

describe('paletteFor', () => {
  it('names the twelve colours', () => {
    const p = paletteFor(0);
    expect(p).toHaveLength(12);
    expect(p[0]).toEqual({ value: 0xE5484D, name: 'red' });
    expect(p[11]).toEqual({ value: 0x8B8D98, name: 'grey' });
    expect(p.map(x => x.name)).toEqual(['red', 'orange', 'amber', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown', 'grey']);
  });
  it('adds the current colour only when it is non-zero and not in the palette', () => {
    expect(paletteFor(0x0090FF)).toHaveLength(12);
    expect(paletteFor(0x123456)).toHaveLength(13);
    expect(paletteFor(0x123456)[12]).toEqual({ value: 0x123456, name: 'current colour' });
  });
});
