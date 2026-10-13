// VOICE-E2E (web-3 task 10): the mute and deafen shortcuts (decision 1, Control+Shift+M and Control+Shift+D) as the
// other browser sees them, and push to talk (decision 2): the other side verifies alice's frames only while her key is
// held. Frame counts are compared over a fixed number of bob's own encrypted frames, never over a sleep (lesson c).
import { expect, test } from './support/peer-browser';
import { watchContexts } from './support/leaks';
import {
  VoicePeer, WAIT, audioRunning, copy, framesPass, heard, heardCount, introduce, joinVoice, noiseOff, onboard, pushToTalk, self,
  sentCount, tile,
} from './support/voice';

watchContexts(test);

/** Bob's own frames per measuring window: 100 Opus frames, about 2 s of his steady tone. */
const WINDOW = 100;

test('Control+Shift+M and Control+Shift+D show alice muted and deafened to bob; push to talk sends only while held', async ({ people, browserName }) => {
  const peer = await VoicePeer.start();
  const alice = await people.open('alice');
  const bob = await people.open('bob');
  try {
    await peer.setup();
    await onboard(alice, peer, 'alice');
    await onboard(bob, peer, 'bob');
    await introduce(peer, [alice, bob]);
    const a = await self(alice.page);
    // Without noise suppression the fake microphone's steady tone is sent as full frames, a frame clock of its own.
    await noiseOff(alice.page);
    await noiseOff(bob.page);
    await joinVoice(alice.page, peer.communityName, peer.voiceName);
    await joinVoice(bob.page, peer.communityName, peer.voiceName);
    if (browserName === 'firefox') await audioRunning(bob.page);
    await expect(tile(bob.page, 'alice')).toHaveAttribute('data-voice-state', 'ok', { timeout: WAIT });
    await heard(bob.page, a.device);
    const word = (key: string) => tile(bob.page, 'alice').locator(`.d-call-tile__state[data-state="${key}"]`);

    await test.step('Control+Shift+M mutes alice as bob sees it, and again unmutes', async () => {
      await expect(word('muted')).toHaveCount(0);
      await alice.page.keyboard.press('Control+Shift+M');
      await expect(word('muted')).toBeVisible({ timeout: WAIT });
      await expect(alice.page.getByRole('toolbar', { name: copy('voice.dock.region'), exact: true })
        .getByRole('button', { name: copy('voice.unmute'), exact: true })).toBeVisible();
      await alice.page.keyboard.press('Control+Shift+M');
      await expect(word('muted')).toHaveCount(0, { timeout: WAIT });
    });

    await test.step('Control+Shift+D deafens alice as bob sees it, and again undeafens', async () => {
      await alice.page.keyboard.press('Control+Shift+D');
      await expect(word('deafened')).toBeVisible({ timeout: WAIT });
      await alice.page.keyboard.press('Control+Shift+D');
      await expect(word('deafened')).toHaveCount(0, { timeout: WAIT });
    });

    await test.step('push to talk: bob verifies alice only while her key is held', async () => {
      // Insert: a non-text key push to talk accepts on its own (task-8b ruling I2).
      await pushToTalk(alice.page, 'Insert');
      await alice.page.locator('body').click({ position: { x: 1, y: 1 } });
      // The key is up: the microphone closes. Let frames in flight land, then measure one window.
      await framesPass(bob.page, await sentCount(bob.page), WINDOW / 4);
      const idle0 = await heardCount(bob.page, a.device);
      await framesPass(bob.page, await sentCount(bob.page), WINDOW);
      const idle = (await heardCount(bob.page, a.device)) - idle0;

      await alice.page.keyboard.down('Insert');
      let held = 0;
      try {
        const held0 = await heardCount(bob.page, a.device);
        await framesPass(bob.page, await sentCount(bob.page), WINDOW);
        held = (await heardCount(bob.page, a.device)) - held0;
      } finally {
        await alice.page.keyboard.up('Insert');
      }

      await framesPass(bob.page, await sentCount(bob.page), WINDOW / 4);
      const after0 = await heardCount(bob.page, a.device);
      await framesPass(bob.page, await sentCount(bob.page), WINDOW);
      const after = (await heardCount(bob.page, a.device)) - after0;

      const deltas = `idle ${idle}, held ${held}, after ${after} frames per ${WINDOW} of bob's own`;
      test.info().annotations.push({ type: 'push to talk', description: deltas });
      console.log(`push to talk (${browserName}): ${deltas}`);
      expect(held, deltas).toBeGreaterThanOrEqual(WINDOW / 2);
      expect(idle, deltas).toBeLessThanOrEqual(WINDOW / 10);
      expect(after, deltas).toBeLessThanOrEqual(WINDOW / 10);
    });
  } finally {
    await people.close(bob);
    await people.close(alice);
    await peer.close();
  }
});
