// VOICE-E2E (web-3 task 10): a reload mid-call is a leave the other side sees, and the rejoin takes a fresh leaf of the
// call group; a person's leave hands focus back to the voice row (flow 06 § Focus rules). Every step waits for the call
// slice, the voice snapshot or the DOM, never for a duration.
import type { Page } from '@playwright/test';
import { expect, test } from './support/peer-browser';
import { watchContexts } from './support/leaks';
import {
  VoicePeer, WAIT, callSlice, copy, dock, expectShellReady, heard, introduce, joinVoice, onboard, self, snapshotDevices,
  tile, voiceRow,
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
    await introduce(peer, [alice, bob]);
    const a = await self(alice.page);
    const b = await self(bob.page);
    const call = s.voice_channel_id;

    await joinVoice(alice.page, peer.communityName, peer.voiceName);
    await joinVoice(bob.page, peer.communityName, peer.voiceName);
    await expect(tile(bob.page, 'alice')).toHaveAttribute('data-voice-state', 'ok', { timeout: WAIT });
    await heard(bob.page, a.device);
    await expect.poll(() => rosterDevices(bob.page), { timeout: WAIT }).toEqual([a.device, b.device].sort());
    const before = await roster(bob.page);

    await test.step('a reload mid-call: bob sees alice leave the room and the group', async () => {
      await alice.page.reload();
      // The pagehide leave reaches the room (LiveKit's participant_left, the snapshot) and the group (bob commits the
      // Remove its leave proposed).
      await expect(tile(bob.page, 'alice')).toHaveCount(0, { timeout: WAIT });
      await expect.poll(() => snapshotDevices(bob.page, call), { timeout: WAIT }).toEqual([b.device]);
      await expect.poll(() => rosterDevices(bob.page), { timeout: WAIT }).toEqual([b.device]);
    });
    const left = await roster(bob.page);
    expect(left.epoch).toBeGreaterThan(before.epoch);

    await test.step('alice rejoins with a fresh leaf', async () => {
      await expectShellReady(alice.page);
      await joinVoice(alice.page, peer.communityName, peer.voiceName);
      await expect.poll(() => rosterDevices(bob.page), { timeout: WAIT }).toEqual([a.device, b.device].sort());
      const back = await roster(bob.page);
      // One leaf of alice's device, taken in an epoch after her Remove: a new membership, not the old one kept.
      expect(back.devices.filter((d) => d.deviceId === a.device)).toHaveLength(1);
      expect(back.epoch).toBeGreaterThan(left.epoch);
      await expect(tile(bob.page, 'alice')).toHaveAttribute('data-voice-state', 'ok', { timeout: WAIT });
      await expect(tile(alice.page, 'bob')).toHaveAttribute('data-voice-state', 'ok', { timeout: WAIT });
    });

    await test.step('leave from the dock returns focus to the voice row', async () => {
      await dock(alice.page).getByRole('button', { name: copy('voice.leave'), exact: true }).click();
      await expect(dock(alice.page)).toHaveCount(0, { timeout: WAIT });
      await expect(voiceRow(alice.page, peer.voiceName)).toBeFocused({ timeout: WAIT });
      await expect(tile(bob.page, 'alice')).toHaveCount(0, { timeout: WAIT });
    });
  } finally {
    await peerBrowser.close(bob);
    await peerBrowser.close(alice);
    await peer.close();
  }
});
