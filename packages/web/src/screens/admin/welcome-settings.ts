import { decode, encode, fromHex, toHex } from '@dilla/client-core';

export interface WelcomeSettingsValue {
  channelId: string;
  template: string;
  serverName: string;
}

const ID = /^[0-9a-f]{32}$/u;
const UTF8 = new TextEncoder();

export function encodeWelcomeSettings(value: WelcomeSettingsValue): Uint8Array {
  if (!ID.test(value.channelId) || value.channelId === '0'.repeat(32)) throw new Error('invalid channel');
  const templateBytes = UTF8.encode(value.template).length;
  const serverBytes = UTF8.encode(value.serverName).length;
  if (templateBytes < 1 || templateBytes > 2000 || serverBytes < 1 || serverBytes > 256
    || value.serverName.trim() === '' || /[\u0000-\u001f\u007f]/u.test(value.serverName)) {
    throw new Error('invalid welcome settings text');
  }
  return encode([1n, fromHex(value.channelId), value.template, value.serverName]);
}

/** Returns null for the encrypted empty-array document that means unconfigured. */
export function decodeWelcomeSettings(data: Uint8Array): WelcomeSettingsValue | null {
  const value = decode(data);
  if (!Array.isArray(value)) throw new Error('invalid welcome settings document');
  if (value.length === 0) return null;
  if (value.length !== 4 || value[0] !== 1n || !(value[1] instanceof Uint8Array) || value[1].length !== 16
    || value[1].every(byte => byte === 0) || typeof value[2] !== 'string' || typeof value[3] !== 'string') {
    throw new Error('invalid welcome settings document');
  }
  const config = { channelId: toHex(value[1]), template: value[2], serverName: value[3] };
  // Keep rendering inputs within the same bounds accepted by the service.
  encodeWelcomeSettings(config);
  return config;
}
