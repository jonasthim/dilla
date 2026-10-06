import { describe, expect, it } from 'vitest';
import { SETTINGS, effectiveNotifyMode, isMuted, isSettingKey, isSettingValue } from './settings';

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
