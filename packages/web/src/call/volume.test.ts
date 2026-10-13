import { describe, expect, it } from 'vitest';
import { gainOf, isVolume, volumesFromSettings } from './volume.ts';

const BOB = 'b0'.repeat(16);
const CAROL = 'c0'.repeat(16);

describe('per-person volume (L-TS-54 voice.volume.<user>)', () => {
  it('maps 0..200 to a gain of 0..2, 100 by default', () => {
    expect(gainOf(BOB, { [BOB]: 150 }, { deafened: false, paused: false })).toBe(1.5);
    expect(gainOf(CAROL, { [BOB]: 150 }, { deafened: false, paused: false })).toBe(1);
    expect(gainOf(BOB, { [BOB]: 0 }, { deafened: false, paused: false })).toBe(0);
    expect(gainOf(BOB, { [BOB]: 200 }, { deafened: false, paused: false })).toBe(2);
  });

  it('is 0 for everyone while deafened or paused (RV-3)', () => {
    expect(gainOf(BOB, { [BOB]: 150 }, { deafened: true, paused: false })).toBe(0);
    expect(gainOf(BOB, { [BOB]: 150 }, { deafened: false, paused: true })).toBe(0);
  });

  it('accepts only 0..200 in steps of 10', () => {
    expect([0, 10, 100, 200].every(isVolume)).toBe(true);
    expect([-10, 5, 210, 1.5, Number.NaN].some(isVolume)).toBe(false);
  });

  it('reads the voice.volume.<user> settings and ignores anything else', () => {
    expect(volumesFromSettings({ [`voice.volume.${BOB}`]: '150', [`voice.volume.${CAROL}`]: '05', 'voice.mode': 'vad', 'voice.volume.x': '10' }))
      .toEqual({ [BOB]: 150 });
  });
});
