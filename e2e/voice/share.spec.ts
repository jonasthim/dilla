// VOICE-E2E (web-3 task 10): a screen share and a camera, on and off, as the other browser sees them. Chromium only:
// headless Firefox has no screen capture to pick and its fake camera is not a capture Playwright can grant (media plan
// DEV-63; NV-10 records screen share as a Chromium-measured path). Screen share starts from the person's own click
// (`getDisplayMedia` needs that activation); the fake UI flag picks the screen.
import { expect, test } from './support/peer-browser';
import { watchContexts } from './support/leaks';
import { VoicePeer, WAIT, copy, heard, introduce, joinVoice, onboard, self, tile } from './support/voice';

watchContexts(test);

test('a screen share and a camera reach the other browser verified, and stop', async ({ people, browserName }) => {
  test.skip(browserName !== 'chromium', 'DEV-63 / NV-10: screen and camera capture are proven on Chromium only');
  const peer = await VoicePeer.start();
  const alice = await people.open('alice');
  const bob = await people.open('bob');
  try {
    await peer.setup();
    await onboard(alice, peer, 'alice');
    await onboard(bob, peer, 'bob');
    await introduce(peer, [alice, bob]);
    const a = await self(alice.page);
    await joinVoice(alice.page, peer.communityName, peer.voiceName);
    await joinVoice(bob.page, peer.communityName, peer.voiceName);
    const seen = tile(bob.page, 'alice');
    await expect(seen).toHaveAttribute('data-voice-state', 'ok', { timeout: WAIT });
    await heard(bob.page, a.device);
    const controls = alice.page.getByRole('toolbar', { name: copy('voice.controls.region'), exact: true });
    const word = (key: string) => seen.locator(`.d-call-tile__state[data-state="${key}"]`);
    const video = seen.locator('video.d-call-tile__video');

    await test.step('share the screen after a click, then stop', async () => {
      await controls.getByRole('button', { name: copy('voice.shareOn'), exact: true }).click();
      await expect(controls.getByRole('button', { name: copy('voice.shareOff'), exact: true })).toBeVisible({ timeout: WAIT });
      await expect(word('screen')).toBeVisible({ timeout: WAIT });
      // Only a verified stream is shown (L-UI-61…69): the tile renders the video once bob verified alice's frames.
      await expect(seen).toHaveAttribute('data-media', 'true', { timeout: WAIT });
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: WAIT }).toBeGreaterThan(0);
      await controls.getByRole('button', { name: copy('voice.shareOff'), exact: true }).click();
      await expect(word('screen')).toHaveCount(0, { timeout: WAIT });
      await expect(seen).not.toHaveAttribute('data-media', 'true', { timeout: WAIT });
    });

    await test.step('camera on, then off', async () => {
      await controls.getByRole('button', { name: copy('voice.cameraOn'), exact: true }).click();
      await expect(word('video')).toBeVisible({ timeout: WAIT });
      await expect(seen).toHaveAttribute('data-media', 'true', { timeout: WAIT });
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: WAIT }).toBeGreaterThan(0);
      await controls.getByRole('button', { name: copy('voice.cameraOff'), exact: true }).click();
      await expect(word('video')).toHaveCount(0, { timeout: WAIT });
      await expect(seen).not.toHaveAttribute('data-media', 'true', { timeout: WAIT });
    });
  } finally {
    await people.close(bob);
    await people.close(alice);
    await peer.close();
  }
});
