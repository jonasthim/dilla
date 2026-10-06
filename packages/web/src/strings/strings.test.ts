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
  it('says what the recovery key does now, and promises no history on a second browser (L-COPY-02)', () => {
    expect(en['onboarding.keys.loss']).toBe('This key is the only way to get your account back or to add another browser. If every browser you use loses its data and you do not have the key, the account and its history are gone, and the host cannot bring them back.');
    expect(en['onboarding.browser.oneBrowser']).toBe('To use this account in another browser, sign in there with your password and this recovery key. Messages sent before that browser joins are not shown in it.');
    expect(en['signin.done.body']).toBe('This browser is now a device of {username} on {instance}. Messages sent before now are not shown here.');
    expect(en['signin.step']).toBe('Step {n} of 4');
    expect(en['signin.error.totpFailed']).toBe('That code did not work. Sign in again with a fresh code.');
    expect(en['signin.error.required']).toBe('Fill in this field.');
    expect(Object.keys(en).filter(k => k.startsWith('signin.'))).toHaveLength(33);
  });
  // Flow 03 as task 15 froze it (L-COPY-02): the count line has two forms, `devices.cap.one` and `devices.cap.other`, in
  // place of the one `devices.cap`, so the settings rows are 62; the two buttons under the list are lower-case chrome.
  it('names settings in lower case in the chrome and sentence case on its surfaces (Q14)', () => {
    for (const k of ['settings.nav.devices', 'settings.nav.notifications', 'settings.nav.appearance', 'devices.revoke', 'devices.refresh',
      'devices.signOut', 'devices.forget', 'notify.channel.default', 'notify.mute', 'appearance.theme.contrast',
      'notify.permission.label', 'notify.permission.ask', 'notify.default.label', 'appearance.theme.label'] as const) expect(en[k], k).toMatch(/^[a-z#]/);
    for (const k of ['settings.title', 'devices.title', 'devices.revokeTitle', 'devices.removeUnlistedTitle', 'devices.signOutTitle',
      'devices.forgetTitle', 'devices.keyLabel', 'notify.title', 'appearance.title', 'notify.channels.title'] as const) expect(en[k], k).toMatch(/^[A-Z]/);
    expect(en['notify.title.channel']).toBe('#{channel} · {server}');
    expect(en['devices.cap.other']).toBe('{n} devices');
    expect(en['devices.cap.one']).toBe('one device');
    expect(en['settings.error.other']).toBe('That did not work ({code}). Try again.');
    expect(Object.keys(en).filter(k => /^(settings|devices|notify|appearance)\./.test(k))).toHaveLength(62);
    expect(Object.keys(en)).not.toContain('devices.error.other');
    expect(Object.keys(en)).not.toContain('devices.cap');
  });
  it('keeps the shell chrome in lower case and names badges by count (L-COPY-02)', () => {
    for (const k of ['shell.rail.settings', 'shell.tabs.label', 'shell.tabs.channels', 'shell.tabs.dms', 'shell.dms.label', 'shell.dms.empty',
      'shell.dms.new', 'shell.dms.open', 'shell.status.devices', 'shell.dm.log', 'shell.dm.composer'] as const) expect(en[k], k).toMatch(/^[a-z]/);
    expect(en['shell.channels.rowLabel']).toBe('{name}, unread {unread}, mentions {mentions}');
    expect(en['shell.channels.rowLabelMuted']).toBe('{name}, muted, mentions {mentions}');
    expect(en['shell.rail.itemLabel']).toBe('{name}, unread {unread}, mentions {mentions}');
    expect(en['shell.dm.log']).toBe('messages with {name}');
    // Pre-flight ruling (rows 1.10, loop note 15): `@` before the name, so the composer keeps the name's case (web-1's label rule).
    expect(en['shell.dm.composer']).toBe('message @{name}');
    expect(Object.keys(en).filter(k => k.startsWith('shell.'))).toHaveLength(70);
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
