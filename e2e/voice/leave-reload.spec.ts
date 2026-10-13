// VOICE-E2E (web-3 task 10): a reload mid-call is a leave the other side sees, and the rejoin takes a fresh leaf of the
// call group; a person's leave hands focus back to the voice row (flow 06 § Focus rules). Every step waits for the call
// slice, the voice snapshot or the DOM, never for a duration.
import type { Page } from '@playwright/test';
import { expect, test } from './support/peer-browser';
import { watchContexts } from './support/leaks';
import {
  VoicePeer, WAIT, callSlice, copy, dock, expectShellReady, heard, joinVoice, onboard, self, snapshotDevices,
  stage, tile, voiceRow,
} from './support/voice';

watchContexts(test);

/** A page's call roster (the worker's call slice): each device with its leaf, and the epoch. */
async function roster(page: Page): Promise<{ epoch: number; devices: { deviceId: string; leaf: number }[] }> {
  const s = await callSlice(page);
  return { epoch: Number(s?.epoch ?? -1), devices: (s?.roster ?? []).map((r) => ({ deviceId: r.deviceId, leaf: r.leaf })) };
}
const rosterDevices = async (page: Page) => (await roster(page)).devices.map((d) => d.deviceId).sort();

test('a reload mid-call is a leave bob sees, the rejoin is a fresh leaf, and leave returns focus to the voice row', async ({ peerBrowser }) => {
  const peer = await VoicePeer.start();
  const alice = await peerBrowser.open('alice');
  const bob = await peerBrowser.open('bob');
  try {
    const s = await peer.setup();
    await onboard(alice, peer, 'alice');
    await onboard(bob, peer, 'bob');
    await peer.seat(2); // no hello: a voice tile names a member the page loaded after it (task 10, concern 4)
    const a = await self(alice.page);
    const b = await self(bob.page);
    const call = s.voice_channel_id;

    await joinVoice(alice.page, peer.communityName, peer.voiceName);
    await joinVoice(bob.page, peer.communityName, peer.voiceName);
    await expect(tile(bob.page, 'alice')).toHaveAttribute('data-voice-state', 'ok', { timeout: WAIT });
    await heard(bob.page, a.device);
    await expect.poll(() => rosterDevices(bob.page), { timeout: WAIT }).toEqual([a.device, b.device].sort());
    const before = await roster(bob.page);

    await test.step('a reload mid-call: bob sees alice leave the room', async () => {
      await alice.page.reload();
      // The pagehide leave reaches the room (LiveKit's participant_left, the snapshot).
      await expect(tile(bob.page, 'alice')).toHaveCount(0, { timeout: WAIT });
      await expect.poll(() => snapshotDevices(bob.page, call), { timeout: WAIT }).toEqual([b.device]);
    });

    await test.step('alice rejoins at once with a fresh leaf, her Remove committed or not yet (task 10, concern 2)', async () => {
      await expectShellReady(alice.page);
      // No wait for bob to commit the Remove her leave caused: a resync refused while it stands waits for the commit.
      await joinVoice(alice.page, peer.communityName, peer.voiceName);
      await expect.poll(() => rosterDevices(bob.page), { timeout: WAIT }).toEqual([a.device, b.device].sort());
      const back = await roster(bob.page);
      // One leaf of alice's device, taken in an epoch after her Remove: a new membership, not the old one kept.
      expect(back.devices.filter((d) => d.deviceId === a.device)).toHaveLength(1);
      expect(back.epoch).toBeGreaterThan(before.epoch + 1);
      await expect(tile(bob.page, 'alice')).toHaveAttribute('data-voice-state', 'ok', { timeout: WAIT });
      await expect(tile(alice.page, 'bob')).toHaveAttribute('data-voice-state', 'ok', { timeout: WAIT });
    });

    await test.step('leave from the dock returns focus to the voice row', async () => {
      await dock(alice.page).getByRole('button', { name: copy('voice.leave'), exact: true }).click();
      await expect(dock(alice.page)).toHaveCount(0, { timeout: WAIT });
      await expect(voiceRow(alice.page, peer.voiceName)).toBeFocused({ timeout: WAIT });
      await expect(tile(bob.page, 'alice')).toHaveCount(0, { timeout: WAIT });
    });

    await test.step('alone in voice: a leave and an immediate rejoin connect at once (task 10, concern 2)', async () => {
      await dock(bob.page).getByRole('button', { name: copy('voice.leave'), exact: true }).click();
      await expect(dock(bob.page)).toHaveCount(0, { timeout: WAIT });
      await joinVoice(alice.page, peer.communityName, peer.voiceName);
      await expect.poll(() => snapshotDevices(alice.page, call), { timeout: WAIT }).toEqual([a.device]);
      await dock(alice.page).getByRole('button', { name: copy('voice.leave'), exact: true }).click();
      await expect(dock(alice.page)).toHaveCount(0, { timeout: WAIT });
      // Nobody can commit the Remove of the only leaf; the leave ended the call, so the rejoin registers a fresh group
      // well inside the room's 20 s departure timeout.
      await stage(alice.page).getByRole('button', { name: copy('voice.join'), exact: true }).click();
      await expect(stage(alice.page)).toHaveAttribute('data-call-phase', 'in', { timeout: 10_000 });
    });
  } finally {
    await peerBrowser.close(bob);
    await peerBrowser.close(alice);
    await peer.close();
  }
});
