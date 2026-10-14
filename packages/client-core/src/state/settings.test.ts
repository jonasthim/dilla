import { describe, expect, it } from 'vitest';
import { SETTINGS, VOICE_DEFAULTS, effectiveNotifyMode, isMuted, isSettingKey, isSettingValue } from './settings';

it('accepts only bounded device-local appearance and search choices', () => {
  const choices = [
    [SETTINGS.density, ['regular', 'compact']],
    [SETTINGS.reduceMotion, ['system', 'on', 'off']],
    [SETTINGS.searchScope, ['channel', 'community', 'all']],
  ] as const;
  for (const [key, values] of choices) {
    expect(isSettingKey(key)).toBe(true);
    for (const value of values) expect(isSettingValue(key, value)).toBe(true);
    expect(isSettingValue(key, 'x'.repeat(129))).toBe(false);
  }
  expect(isSettingKey('theme')).toBe(false);
  expect(isSettingKey('density.extra')).toBe(false);
  expect(isSettingValue(SETTINGS.searchScope, 'everywhere')).toBe(false);
});

const HEX = 'ab'.repeat(16);

describe('settings keys (L-TS-25)', () => {
  it('names the three key shapes', () => {
    expect(SETTINGS.notifyDefault).toBe('notify.default');
    expect(SETTINGS.notifyChannel(HEX)).toBe(`notify.channel.${HEX}`);
    expect(SETTINGS.muteChannel(HEX)).toBe(`mute.channel.${HEX}`);
  });

  it('accepts exactly those shapes', () => {
    expect(isSettingKey('notify.default')).toBe(true);
    expect(isSettingKey(`notify.channel.${HEX}`)).toBe(true);
    expect(isSettingKey(`mute.channel.${HEX}`)).toBe(true);
    for (const bad of ['', 'theme', 'notify', 'notify.default.x', ` notify.default`, `notify.channel.${HEX.toUpperCase()}`,
      `notify.channel.${HEX}0`, `mute.channel.${HEX.slice(1)}`, `mute.channel.${HEX} `, `notify.channel.`, `mute.channel.${'g'.repeat(32)}`]) {
      expect(isSettingKey(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('admits each shape only its values', () => {
    for (const v of ['dms-mentions', 'everything', 'nothing']) expect(isSettingValue('notify.default', v)).toBe(true);
    for (const v of ['all', 'mentions', 'nothing']) expect(isSettingValue(`notify.channel.${HEX}`, v)).toBe(true);
    expect(isSettingValue(`mute.channel.${HEX}`, '1')).toBe(true);
    expect(isSettingValue('notify.default', 'all')).toBe(false);
    expect(isSettingValue(`notify.channel.${HEX}`, 'everything')).toBe(false);
    expect(isSettingValue(`mute.channel.${HEX}`, '0')).toBe(false);
    expect(isSettingValue(`mute.channel.${HEX}`, '')).toBe(false);
    expect(isSettingValue('theme', 'mesh')).toBe(false);
  });
});

describe('effectiveNotifyMode (Q09)', () => {
  it('defaults to DMs and mentions', () => {
    expect(effectiveNotifyMode({}, HEX, 0)).toBe('mentions');
    expect(effectiveNotifyMode({}, HEX, 3)).toBe('all');
    expect(effectiveNotifyMode({}, HEX, 4)).toBe('all');
    expect(effectiveNotifyMode({ 'notify.default': 'dms-mentions' }, HEX, 0)).toBe('mentions');
  });

  it('follows the default', () => {
    expect(effectiveNotifyMode({ 'notify.default': 'everything' }, HEX, 0)).toBe('all');
    expect(effectiveNotifyMode({ 'notify.default': 'everything' }, HEX, 3)).toBe('all');
    expect(effectiveNotifyMode({ 'notify.default': 'nothing' }, HEX, 0)).toBe('nothing');
    expect(effectiveNotifyMode({ 'notify.default': 'nothing' }, HEX, 4)).toBe('nothing');
  });

  it('lets a channel override the default', () => {
    expect(effectiveNotifyMode({ 'notify.default': 'everything', [`notify.channel.${HEX}`]: 'nothing' }, HEX, 0)).toBe('nothing');
    expect(effectiveNotifyMode({ 'notify.default': 'nothing', [`notify.channel.${HEX}`]: 'all' }, HEX, 0)).toBe('all');
    expect(effectiveNotifyMode({ [`notify.channel.${HEX}`]: 'mentions' }, HEX, 3)).toBe('mentions');
    expect(effectiveNotifyMode({ [`notify.channel.${'cd'.repeat(16)}`]: 'nothing' }, HEX, 0)).toBe('mentions');
  });

  it('ignores a value it does not admit', () => {
    expect(effectiveNotifyMode({ [`notify.channel.${HEX}`]: 'loud' }, HEX, 0)).toBe('mentions');
    expect(effectiveNotifyMode({ 'notify.default': 'loud' }, HEX, 0)).toBe('mentions');
    expect(effectiveNotifyMode({ 'notify.default': 'loud' }, HEX, 3)).toBe('all');
  });
});

describe('isMuted', () => {
  it('is true only for the value 1', () => {
    expect(isMuted({ [`mute.channel.${HEX}`]: '1' }, HEX)).toBe(true);
    expect(isMuted({ [`mute.channel.${HEX}`]: '0' }, HEX)).toBe(false);
    expect(isMuted({}, HEX)).toBe(false);
    expect(isMuted({ [`mute.channel.${'cd'.repeat(16)}`]: '1' }, HEX)).toBe(false);
  });
});

// L-TS-54: the voice and sound keys web-3 adds. Each admits only its own values, so a page cannot turn the
// settings table into a general store (architect ruling 14).
describe('voice and sound settings (L-TS-54)', () => {
  const ID = 'cd'.repeat(16);
  it('accepts one value and refuses another for every key', () => {
    const cases: [string, string[], string[]][] = [
      [SETTINGS.voiceInput, ['default', 'Ab0+/=_-', 'x'.repeat(128)], ['', 'x'.repeat(129), 'a b', 'a.b']],
      [SETTINGS.voiceOutput, ['f00d', 'x'.repeat(128)], ['', 'x'.repeat(129), 'é']],
      [SETTINGS.voiceMode, ['vad', 'ptt'], ['', 'VAD', 'push']],
      [SETTINGS.voicePttKey, ['KeyV', 'F13', 'Space', 'a' + '1'.repeat(31)], ['', '1Key', 'Key V', 'a' + '1'.repeat(32)]],
      [SETTINGS.voiceNoise, ['on', 'off'], ['1', 'true']],
      [SETTINGS.voiceVolume(ID), ['0', '10', '100', '110', '200'], ['05', '15', '210', '-10', '100.0', '']],
      [SETTINGS.soundVoice, ['on', 'off'], ['0', '1']],
      [SETTINGS.soundRing, ['on', 'off'], ['0', 'quiet']],
      // Product walk M5: the own mute and deafen kept across a reload.
      [SETTINGS.voiceSelf, ['muted', 'deafened'], ['', 'on', 'live', '1']],
    ];
    for (const [key, good, bad] of cases) {
      expect(isSettingKey(key), key).toBe(true);
      for (const v of good) expect(isSettingValue(key, v), `${key}=${v}`).toBe(true);
      for (const v of bad) expect(isSettingValue(key, v), `${key}=${v}`).toBe(false);
    }
  });

  it('names the keys and refuses near misses', () => {
    expect([SETTINGS.voiceInput, SETTINGS.voiceOutput, SETTINGS.voiceMode, SETTINGS.voicePttKey, SETTINGS.voiceNoise,
      SETTINGS.voiceVolume(ID), SETTINGS.soundVoice, SETTINGS.soundRing]).toEqual(['voice.input', 'voice.output', 'voice.mode',
      'voice.pttKey', 'voice.noise', `voice.volume.${ID}`, 'sound.voice', 'sound.ring']);
    for (const bad of ['voice', 'voice.volume.', `voice.volume.${ID.toUpperCase()}`, `voice.volume.${ID}0`, 'sound', 'sound.mention', 'voice.ptt']) {
      expect(isSettingKey(bad), bad).toBe(false);
    }
  });

  it('defaults to voice activity, noise suppression on, full volume and both sounds on', () => {
    expect(VOICE_DEFAULTS).toEqual({ mode: 'vad', pttKey: null, noise: 'on', volume: '100', soundVoice: 'on', soundRing: 'on' });
  });
});
