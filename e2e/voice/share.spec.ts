// VOICE-E2E (web-3 task 10): a screen share and a camera, on and off, as the other browser sees them. Chromium only:
// headless Firefox has no screen capture to pick and its fake camera is not a capture Playwright can grant (media plan
// DEV-63; NV-10 records screen share as a Chromium-measured path). Screen share starts from the person's own click
// (`getDisplayMedia` needs that activation); the fake UI flag picks the screen.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator } from '@playwright/test';
import { expect, test } from './support/peer-browser';
import { watchContexts } from './support/leaks';
import {
  AUDIBLE_RMS, VoicePeer, WAIT, audible, audibleLevel, copy, dock, framesPass, heard, joinVoice, onboard, self, sentCount, tile,
} from './support/voice';
import { chromiumMediaArgs, writeFixtures } from '../media/support/fixtures';

watchContexts(test);

test('a screen share and a camera reach the other browser verified, and stop', async ({ peerBrowser, browserName }) => {
  test.skip(browserName !== 'chromium', 'DEV-63 / NV-10: screen and camera capture are proven on Chromium only');
  const peer = peerBrowser.track(await VoicePeer.start());
  const alice = await peerBrowser.open('alice');
  const bob = await peerBrowser.open('bob');
  try {
    await peer.setup();
    await onboard(alice, peer, 'alice');
    await onboard(bob, peer, 'bob');
    await peer.seat(2); // no hello: a voice tile names a member the page loaded after it (task 10, concern 4)
    const a = await self(alice.page);
    await joinVoice(alice.page, peer.communityName, peer.voiceName);
    await joinVoice(bob.page, peer.communityName, peer.voiceName);
    const seen = tile(bob.page, 'alice');
    await expect(seen).toHaveAttribute('data-voice-state', 'ok', { timeout: WAIT });
    await heard(bob.page, a.device);
    const controls = alice.page.getByRole('toolbar', { name: copy('voice.controls.voice'), exact: true });
    const word = (key: string) => seen.locator(`.d-call-tile__state[data-state="${key}"]`);
    const video = seen.locator('video.d-call-tile__video');

    await test.step('share the screen after a click, then stop', async () => {
      const share = controls.getByRole('button', { name: copy('voice.shareOn'), exact: true });
      await share.click();
      await expect(share).toHaveAttribute('aria-pressed', 'true', { timeout: WAIT });
      await expect(word('screen')).toBeVisible({ timeout: WAIT });
      // Only a verified stream is shown (L-UI-61…69): the tile renders the video once bob verified alice's frames.
      await expect(seen).toHaveAttribute('data-media', 'true', { timeout: WAIT });
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: WAIT }).toBeGreaterThan(0);
      await share.click();
      await expect(word('screen')).toHaveCount(0, { timeout: WAIT });
      await expect(seen).not.toHaveAttribute('data-media', 'true', { timeout: WAIT });
    });

    await test.step('camera on, then off', async () => {
      const camera = controls.getByRole('button', { name: copy('voice.cameraOn'), exact: true });
      await camera.click();
      await expect(word('video')).toBeVisible({ timeout: WAIT });
      await expect(seen).toHaveAttribute('data-media', 'true', { timeout: WAIT });
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: WAIT }).toBeGreaterThan(0);
      await expect(camera).toHaveAttribute('aria-pressed', 'true');
      await camera.click();
      await expect(word('video')).toHaveCount(0, { timeout: WAIT });
      await expect(seen).not.toHaveAttribute('data-media', 'true', { timeout: WAIT });
    });
  } finally {
    await peerBrowser.close(bob);
    await peerBrowser.close(alice);
    await peer.close();
  }
});

// web3.4 V4: the share's sound, not only its picture. With the fake picker off, Chromium picks the tab that
// `--auto-select-tab-capture-source-by-title` names instead of the screen, and that tab's sound comes with it as the
// share's audio track. Playwright launches Chromium with `--mute-audio`, which silences every tab and so the captured
// sound too: this test drops it (measured: a tab capture reads an RMS of 0 with it, about 0.6 without). Playwright
// allows launch options only per file or worker, so the test launches a browser of its own with these switches; the
// rest of the suite keeps the worker's browser and its fake picker. That browser follows the config's `headless`; a
// headed run (`--headed`) plays the tab's 440 Hz tone and the fake microphone's 1 kHz tone aloud on this machine.
const TONE_TITLE = 'dilla-share-tone';
const fixtures = writeFixtures(join(tmpdir(), 'dilla-media-fixtures'));
const stateWord = (seen: Locator, key: string): Locator => seen.locator(`.d-call-tile__state[data-state="${key}"]`);

test('a shared tab’s sound is heard by the other browser', async ({ peerBrowser, browserName, playwright, channel, headless }) => {
  test.skip(browserName !== 'chromium', 'DEV-63 / NV-10: screen capture, and a tab picked by its title, are Chromium only');
  const tabPicking = await playwright.chromium.launch({
    ...(channel === undefined ? {} : { channel }),
    headless,
    args: [
      ...chromiumMediaArgs(fixtures).filter((a) => a !== '--use-fake-ui-for-media-stream'),
      `--auto-select-tab-capture-source-by-title=${TONE_TITLE}`,
    ],
    ignoreDefaultArgs: ['--mute-audio'],
  });
  // The people close (the app's leave included) before their browser does, whatever threw.
  try {
    const peer = peerBrowser.track(await VoicePeer.start());
    const alice = await peerBrowser.open('alice', { browser: tabPicking });
    const bob = await peerBrowser.open('bob', { browser: tabPicking });
    try {
      // The tab alice shares: a 440 Hz tone (the fake microphone sends 1 kHz), under the title the switch picks.
      const tab = await alice.context.newPage();
      await tab.setContent(`<!doctype html><title>${TONE_TITLE}</title><p>tone</p>`);
      await tab.evaluate(() => {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        osc.frequency.value = 440;
        osc.connect(ctx.destination);
        osc.start();
      });
      await alice.page.bringToFront();
      await peer.setup();
      await onboard(alice, peer, 'alice');
      await onboard(bob, peer, 'bob');
      await peer.seat(2); // no hello: a voice tile names a member the page loaded after it (task 10, concern 4)
      const a = await self(alice.page);
      await joinVoice(alice.page, peer.communityName, peer.voiceName);
      await joinVoice(bob.page, peer.communityName, peer.voiceName);
      const seen = tile(bob.page, 'alice');
      await expect(seen).toHaveAttribute('data-voice-state', 'ok', { timeout: WAIT });
      await heard(bob.page, a.device);

      // Alice's microphone goes quiet, so the only sound of hers bob can hear is the share's.
      await dock(alice.page).getByRole('button', { name: copy('voice.mute'), exact: true }).click();
      await expect(stateWord(seen, 'muted')).toBeVisible({ timeout: WAIT });
      // Positive control for `audible` below: once the mute has reached the frames, bob's page plays nothing of alice's.
      await framesPass(alice.page, await sentCount(alice.page), 25);
      expect(await audibleLevel(bob.page), 'the level bob’s page plays of alice’s muted microphone').toBeLessThan(AUDIBLE_RMS);

      const share = alice.page.getByRole('toolbar', { name: copy('voice.controls.voice'), exact: true })
        .getByRole('button', { name: copy('voice.shareOn'), exact: true });
      await share.click();
      await expect(share).toHaveAttribute('aria-pressed', 'true', { timeout: WAIT });
      await expect(stateWord(seen, 'screen')).toBeVisible({ timeout: WAIT });
      await expect(seen).toHaveAttribute('data-media', 'true', { timeout: WAIT });
      await audible(bob.page);
      await share.click();
      await expect(stateWord(seen, 'screen')).toHaveCount(0, { timeout: WAIT });
    } finally {
      await peerBrowser.close(bob);
      await peerBrowser.close(alice);
      await peer.close();
    }
  } finally {
    await tabPicking.close();
  }
});
