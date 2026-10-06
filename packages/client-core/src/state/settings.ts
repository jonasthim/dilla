// The device-local settings the worker accepts (L-TS-25): three key shapes and the values each admits.
// Anything else is refused, so the settings table never becomes a general store (architect ruling 14).

export const SETTINGS = {
  notifyDefault: 'notify.default',                           // 'dms-mentions' (default) | 'everything' | 'nothing'
  notifyChannel: (hex: string) => `notify.channel.${hex}`,   // 'all' | 'mentions' | 'nothing'
  muteChannel: (hex: string) => `mute.channel.${hex}`,       // '1' when muted; absent otherwise
} as const;

export type NotifyMode = 'all' | 'mentions' | 'nothing';

const HEX32 = /^[0-9a-f]{32}$/;
const NOTIFY_CHANNEL = 'notify.channel.';
const MUTE_CHANNEL = 'mute.channel.';
const DEFAULTS: readonly string[] = ['dms-mentions', 'everything', 'nothing'];
const MODES: readonly string[] = ['all', 'mentions', 'nothing'];

export function isSettingKey(key: string): boolean {
  if (key === SETTINGS.notifyDefault) return true;
  if (key.startsWith(NOTIFY_CHANNEL)) return HEX32.test(key.slice(NOTIFY_CHANNEL.length));
  if (key.startsWith(MUTE_CHANNEL)) return HEX32.test(key.slice(MUTE_CHANNEL.length));
  return false;
}

/** The value set each key shape admits (notify.default: the three; notify.channel.*: the three modes; mute.channel.*: '1'). */
export function isSettingValue(key: string, value: string): boolean {
  if (!isSettingKey(key)) return false;
  if (key === SETTINGS.notifyDefault) return DEFAULTS.includes(value);
  if (key.startsWith(NOTIFY_CHANNEL)) return MODES.includes(value);
  return value === '1';
}

export function effectiveNotifyMode(settings: Record<string, string>, channelHex: string, kind: 0 | 3 | 4): NotifyMode {
  const override = settings[SETTINGS.notifyChannel(channelHex)];
  if (override !== undefined && MODES.includes(override)) return override as NotifyMode;
  const stored = settings[SETTINGS.notifyDefault];
  const fallback = stored !== undefined && DEFAULTS.includes(stored) ? stored : 'dms-mentions';
  if (fallback === 'everything') return 'all';
  if (fallback === 'nothing') return 'nothing';
  return kind === 3 || kind === 4 ? 'all' : 'mentions';
}

export function isMuted(settings: Record<string, string>, channelHex: string): boolean {
  return settings[SETTINGS.muteChannel(channelHex)] === '1';
}
