import { describe, expect, it } from 'vitest';
import { safeName } from './name';

const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe('safeName (L-TS-32)', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['../etc/passwd', '.._etc_passwd'],
    ['a\\b.txt', 'a_b.txt'],
    ['‮gnp.exe', 'gnp.exe'],
    ['⁦x⁩.png', 'x.png'],
    ['invoice.pdf\u200e\u200f.exe', 'invoice.pdf.exe'],
    ['photo.jpg\u061c.exe', 'photo.jpg.exe'],
    ['report.pdf\u206a\u206f.exe', 'report.pdf.exe'],
    ['tab\there', 'tabhere'],
    ['\u0085x\u007f\u009f', 'x'],
    ['  spaced  ', 'spaced'],
  ])('%j becomes %j', (input, want) => {
    expect(safeName(input, 'file')).toBe(want);
  });

  it('falls back when nothing is left', () => {
    expect(safeName('', 'file')).toBe('file');
    expect(safeName('⁦⁩ \u0000', 'file')).toBe('file');
    expect(safeName('', '')).toBe('');
  });

  it('cuts to 255 UTF-8 bytes at a scalar boundary', () => {
    expect(safeName('a'.repeat(300), 'file')).toBe('a'.repeat(255));
    const e = safeName('é'.repeat(200), 'file');
    expect(e).toBe('é'.repeat(127));
    expect(bytes(e)).toBe(254);
    const smile = safeName('😀'.repeat(70), 'file');
    expect(smile).toBe('😀'.repeat(63));
    expect(bytes(smile)).toBe(252);
  });
});
