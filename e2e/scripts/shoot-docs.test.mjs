import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DOC_SHOTS, DOC_VIEWPORTS, PHONE_APP, PHONE_SHOTS, SIGNIN_SHOTS, WEB38_SHOTS, WEB39_SHOTS, shootNamedState } from './shoot-docs.mjs';

test('new guide images have unique state names and the required real viewport sizes', () => {
  assert.deepEqual(DOC_VIEWPORTS, { desktop: { width: 1280, height: 800 }, phone: { width: 360, height: 740 } });
  const names = DOC_SHOTS.map(shot => shot.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names, [
    'trust-privacy-desktop', 'trust-privacy-phone', 'trust-compare-desktop', 'trust-compare-phone',
    'trust-conversation-desktop', 'trust-conversation-phone', 'trust-changed-desktop', 'trust-changed-phone',
    'search-results-desktop', 'search-results-phone', 'settings-diagnostics-desktop',
    'settings-diagnostics-phone', 'tabs-handover-desktop', 'tabs-handover-phone',
    // L-DOC-24 (web-3): the voice guide's six states.
    'voice-stage-desktop', 'voice-stage-phone', 'voice-dock-desktop',
    'voice-settings-desktop', 'voice-settings-phone', 'voice-blocked-desktop', 'voice-blocked-phone',
    'call-ring-desktop', 'call-ring-phone', 'media-player-desktop', 'media-player-phone',
  ]);
  for (const shot of DOC_SHOTS) {
    assert.match(shot.state, /^\[data-doc-state="[a-z-]+"\]$/);
    assert.ok(!/key|token|body|secret/i.test(shot.name));
  }
});

test('waits for the state and closes the owned context after a failed capture', async () => {
  const order = [];
  const context = { close: async () => { order.push('close'); } };
  const page = {
    waitForSelector: async (selector) => { assert.equal(selector, '[data-doc-state="trust-privacy"]'); order.push('wait'); },
    screenshot: async () => { order.push('shot'); throw new Error('capture failed'); },
  };
  await assert.rejects(shootNamedState({ context, page, state: '[data-doc-state="trust-privacy"]', outFile: '/tmp/trust-privacy-desktop.png' }), /capture failed/);
  assert.deepEqual(order, ['wait', 'shot', 'close']);
});

test('every screenshot the voice guide names is one the shooter makes', () => {
  const guide = readFileSync(new URL('../../docs/user/voice.md', import.meta.url), 'utf8');
  const named = [...guide.matchAll(/screenshots\/([a-z0-9-]+)\.png/g)].map((m) => m[1]);
  assert.ok(named.length > 0, 'docs/user/voice.md names no screenshot');
  const shot = new Set([...DOC_SHOTS.map((s) => s.name), ...PHONE_SHOTS, ...WEB38_SHOTS, ...WEB39_SHOTS]);
  for (const name of named) assert.ok(shot.has(name), `docs/user/voice.md names ${name}.png, which the shooter does not make`);
});

test('the phone set is shot at 390 by 844 and every image of "On your phone" is one the shooter makes', () => {
  assert.deepEqual(PHONE_APP, { width: 390, height: 844 });
  assert.deepEqual(PHONE_SHOTS, ['phone-home', 'phone-channel', 'phone-activity', 'phone-callbar']);
  const guide = readFileSync(new URL('../../docs/user/getting-started.md', import.meta.url), 'utf8');
  const named = [...guide.matchAll(/screenshots\/(phone-[a-z0-9-]+)\.png/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(named)].sort(), [...PHONE_SHOTS].sort());
});

test('the sign-in is shot in its new order and every web3.8 image the guides name is one the shooter makes', () => {
  assert.deepEqual(SIGNIN_SHOTS, ['signin-0-entry', 'signin-1-login', 'signin-2-code', 'signin-3-recovery-key', 'signin-4-done']);
  const guide = readFileSync(new URL('../../docs/user/getting-started.md', import.meta.url), 'utf8');
  const signin = [...guide.matchAll(/screenshots\/(signin-[a-z0-9-]+)\.png/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(signin)].sort(), [...SIGNIN_SHOTS].sort());
  for (const name of WEB38_SHOTS) assert.ok(guide.includes(`screenshots/${name}.png`) || readFileSync(new URL('../../docs/user/voice.md', import.meta.url), 'utf8').includes(`screenshots/${name}.png`), `${name}.png is in no guide`);
});

test('every web3.9 image is named in a guide, and every image the guides name is on disk', () => {
  const dir = new URL('../../docs/user/', import.meta.url);
  const guides = ['getting-started.md', 'voice.md'].map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  for (const name of WEB39_SHOTS) assert.ok(guides.includes(`screenshots/${name}.png`), `${name}.png is in no guide`);
  for (const m of guides.matchAll(/screenshots\/([a-z0-9-]+\.png)/g)) assert.ok(existsSync(new URL(`screenshots/${m[1]}`, dir)), `${m[1]} is missing`);
});
