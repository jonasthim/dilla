import { describe, expect, it } from 'vitest';
import { decodeWelcomeSettings, encodeWelcomeSettings } from './welcome-settings.ts';

const CHANNEL = 'ab'.repeat(16);

describe('welcome settings interaction documents', () => {
  it('encodes and decodes the versioned encrypted welcome configuration', () => {
    const config = { channelId: CHANNEL, template: 'Hej {member} 👋', serverName: 'Midgård' };
    expect(decodeWelcomeSettings(encodeWelcomeSettings(config))).toEqual(config);
  });

  it('recognizes the empty array as an unconfigured welcome setting', () => {
    expect(decodeWelcomeSettings(new Uint8Array([0x80]))).toBeNull();
  });

  it('rejects malformed or non-canonical welcome configuration fields', () => {
    expect(() => decodeWelcomeSettings(new Uint8Array([0x80, 0x00]))).toThrow();
    expect(() => encodeWelcomeSettings({ channelId: '00'.repeat(16), template: 'Hi {member}', serverName: 'Dilla' })).toThrow();
  });
});
