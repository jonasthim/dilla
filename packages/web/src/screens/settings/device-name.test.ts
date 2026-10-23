import { describe, it, expect } from 'vitest';
import { suggestDeviceName } from './device-name.ts';

describe('suggestDeviceName', () => {
  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', { browser: 'Firefox', os: 'Linux' }],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', { browser: 'Chrome', os: 'Linux' }],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', { browser: 'Edge', os: 'Windows' }],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', { browser: 'Safari', os: 'macOS' }],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', { browser: 'Chrome', os: 'Android' }],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', { browser: 'Safari', os: 'iOS' }],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', { browser: 'Chrome', os: 'ChromeOS' }],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0', { browser: 'Opera', os: 'Linux' }],
  ])('reads %s', (ua, want) => {
    expect(suggestDeviceName(ua)).toEqual(want);
  });
  it('gives nothing for an agent it does not know', () => {
    expect(suggestDeviceName('')).toBeNull();
    expect(suggestDeviceName('curl/8.0')).toBeNull();
    expect(suggestDeviceName('Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/26.0.0')).toBeNull();
  });
});
