// E-reload (web3.7, R31): a reload in a call leaves exactly one tile for the reloaded person, and a reload that is never
// followed by a rejoin leaves no ghost either. The second half suppresses the pagehide leave (an init script that stops
// the event before the app's own listener sees it), so the room's departure timeout (90 s in this suite) and the boot
// sweep are the only things left that can remove alice's old device: only the sweep is fast enough to pass.
import type { Page } from '@playwright/test';
import { expect, test } from './support/peer-browser';
import { watchContexts } from './support/leaks';
import {
  VoicePeer, WAIT, callSlice, expectShellReady, heard, joinVoice, onboard, self, tile,
} from './support/voice';

watchContexts(test);

/** The sweep must beat the room's 90 s departure timeout by a wide margin; it is one read and one proposal. */
const SWEEP_BOUND = 30_000;

/** The devices a page's call roster lists, in order (the worker's call slice). */
async function rosterDevices(page: Page): Promise<string[]> {
  const s = await callSlice(page);
  return (s?.roster ?? []).map((r) => r.deviceId).sort();
}

/** Stops every `pagehide` before the app's listener (on `window`, no capture) can see it: the leave a page sends as it
 *  goes away never happens. The init script reaches documents loaded after it is added. */
function suppressPagehide(): void {
  window.addEventListener('pagehide', (e) => e.stopImmediatePropagation(), { capture: true });
}

/** True when a `pagehide` dispatched on the page reaches no listener below the capture phase (the suppression holds). */
async function pagehideIsSuppressed(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    let reached = false;
    const probe = (): void => { reached = true; };
    window.addEventListener('pagehide', probe);
    window.dispatchEvent(new Event('pagehide'));
    window.removeEventListener('pagehide', probe);
    return !reached;
  });
}

test('a reload mid-call leaves one tile for alice, and a reload without a rejoin leaves none within the sweep bound', async ({ peerBrowser }) => {
  const peer = peerBrowser.track(await VoicePeer.start());
  const alice = await peerBrowser.open('alice');
  const bob = await peerBrowser.open('bob');
  try {
    const s = await peer.setup();
    await onboard(alice, peer, 'alice');
    await onboard(bob, peer, 'bob');
    await peer.seat(2);
    const a = await self(alice.page);
    const b = await self(bob.page);

    await test.step('alice and bob are in the call and bob hears alice', async () => {
      await joinVoice(alice.page, peer.communityName, peer.voiceName);
      await joinVoice(bob.page, peer.communityName, peer.voiceName);
      await expect(tile(bob.page, 'alice')).toHaveAttribute('data-voice-state', 'ok', { timeout: WAIT });
      await heard(bob.page, a.device);
      await expect.poll(() => rosterDevices(bob.page), { timeout: WAIT }).toEqual([a.device, b.device].sort());
    });

    await test.step('alice reloads and rejoins: bob shows exactly one tile for her and lists her device once', async () => {
      await alice.page.addInitScript(suppressPagehide);
      await alice.page.reload();
      await expectShellReady(alice.page);
      await expect.poll(() => pagehideIsSuppressed(alice.page), { timeout: WAIT, message: 'the reloaded page carries the suppressing listener' }).toBe(true);
      await joinVoice(alice.page, peer.communityName, peer.voiceName);
      await expect(tile(bob.page, 'alice')).toHaveAttribute('data-voice-state', 'ok', { timeout: WAIT });
      await expect(tile(bob.page, 'alice')).toHaveCount(1, { timeout: WAIT });
      await expect.poll(() => rosterDevices(bob.page), { timeout: WAIT }).toEqual([a.device, b.device].sort());
      await expect.poll(async () => (await callSlice(bob.page))?.roster.filter((r) => r.deviceId === a.device).length, { timeout: WAIT }).toBe(1);
    });

    await test.step('alice reloads again with the pagehide leave suppressed and does not rejoin: the boot sweep removes her old device', async () => {
      expect(await pagehideIsSuppressed(alice.page), 'the page that is about to reload suppresses its pagehide leave').toBe(true);
      // The boot sweep's own request: alice's worker reads the call of the channel it was in, with no join pressed.
      const reads: string[] = [];
      alice.context.on('request', (r) => { if (r.method() === 'GET' && r.url().endsWith(`/v1/channels/${s.voice_channel_id}/call`)) reads.push(r.url()); });
      await alice.page.reload();
      await expectShellReady(alice.page);
      await expect.poll(() => reads.length, { timeout: SWEEP_BOUND, message: 'the reloaded page sweeps the call it left behind' }).toBeGreaterThan(0);
      await expect.poll(() => rosterDevices(bob.page), { timeout: SWEEP_BOUND, message: 'bob\'s roster drops alice\'s old device' }).toEqual([b.device]);
      await expect(tile(bob.page, 'alice')).toHaveCount(0, { timeout: SWEEP_BOUND });
    });
  } finally {
    await peerBrowser.close(bob);
    await peerBrowser.close(alice);
    await peer.close();
  }
});
