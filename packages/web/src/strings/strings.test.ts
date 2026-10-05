import { describe, it, expect } from 'vitest';
import { en } from './en.ts';
import { t, formatTime, formatDay } from './index.ts';

describe('t', () => {
  it('fills placeholders and ignores extra variables', () => {
    expect(t('boot.error.detail', { code: 'E_NETWORK', unused: 1 })).toBe('Error E_NETWORK. Reload the page to try again.');
  });
  it('throws when a placeholder has no variable', () => {
    expect(() => t('boot.error.detail')).toThrow('strings: boot.error.detail needs {code}');
  });
  it('returns a value without placeholders unchanged', () => {
    expect(t('boot.loading.status')).toBe(en['boot.loading.status']);
  });
});

describe('the copy rules', () => {
  const values = Object.entries(en) as [string, string][];
  it('has no empty value and only one-word placeholders', () => {
    for (const [key, value] of values) {
      expect(value.trim(), key).not.toBe('');
      for (const m of value.matchAll(/\{([^}]*)\}/g)) expect(m[1], key).toMatch(/^[a-zA-Z]+$/);
    }
  });
  it('never exclaims and never reassures', () => {
    for (const [key, value] of values) {
      expect(value, key).not.toMatch(/!|\bsecure\b|\bsafe\b|\bprotected\b|\u{1F512}/iu);
    }
  });
  it('keeps the boot truth rule of L-COPY-01 and names the dialog close button', () => {
    expect(en['boot.revoked.detail']).toBe('Your account no longer accepts this browser. Ask the host if you did not expect this. To start over here, clear this site’s data in the browser’s settings.');
    expect(en['boot.storeLost.detail']).not.toMatch(/recovery/i);
    expect(en['dialog.close']).toBe('Close');
  });
});

describe('dates', () => {
  it('formats unix seconds, not milliseconds', () => {
    const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
    const day = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    expect(formatTime(18_420)).toBe(time.format(new Date(18_420_000)));
    expect(formatTime(18_420)).not.toBe(time.format(new Date(18_420)));
    expect(formatDay(1_790_000_000)).toBe(day.format(new Date(1_790_000_000_000)));
  });
});
