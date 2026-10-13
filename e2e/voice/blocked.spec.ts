// VOICE-E2E (web-3 task 10): a poisoned call group stops the call in the browser (decision 4, RV-1, RV-3), through the
// real SFU, against a native peer that poisons it:
// (a) before join: a contact whose identity changed is in the call group, so the join is refused before anything is
//     posted, and the browser never reaches the group or the room;
// (b) mid-call: a device that fails the signed-list check joins, so the browser leaves and its leaf goes;
// (c) mid-call identity change (RV-3): the call pauses on each browser that saw it, without ending for anyone, until
//     the contact is verified or leaves;
// DM: a blocked DM call leaves the DM's composer as the text group has it.
// Attackers: (a) and (c) a contact's identity replaced by an instance or account takeover (rotate_umk); (b) a device
// the instance admits but the owner's signed device list does not vouch for (a forged tier, forge_device).
import type { Page } from '@playwright/test';
import { expect, test } from './support/peer-browser';
import { watchContexts } from './support/leaks';
import {
  POLL, VoicePeer, WAIT, callSlice, changedSeen, connected, copy, dock, framesPass, heard, heardCount, introduce, joinVoice, noiseOff,
  onboard, openVoice, peerName, self, sentCount, stage, tile,
} from './support/voice';
import { dmComposer, dmsNav, sidebarTab } from '../web/support/app';

watchContexts(test);

/** The stage's (or DM strip's) notice text, as the person reads it. */
function notice(page: Page, text: string) {
  return page.locator('.dw-voice-stage, .dw-call-strip').getByText(text, { exact: true });
}

test('(a) a changed contact in the call group refuses the join before anything is posted; the room never sees the browser', async ({ peerBrowser }) => {
  const peer = await VoicePeer.start();
  const alice = await peerBrowser.open('alice');
  const bob = await peerBrowser.open('bob');
  try {
    const s = await peer.setup();
    const call = s.voice_channel_id;
    await onboard(alice, peer, 'alice');
    await introduce(peer, [alice]);
    const a = await self(alice.page);

    // The peer's identity is replaced (a new UMK and device) and alice's text group shows it; then the new device opens
    // the voice's call group. The peer first takes in what the browsers committed (its rotation commits in that group).
    await peer.sync();
    await peer.rotateUmk();
    await changedSeen(alice.page, s.user_id);
    await peer.callJoin(call);
    await openVoice(alice.page, peer.communityName, peer.voiceName);
    await stage(alice.page).getByRole('button', { name: copy('voice.join'), exact: true }).click();
    await expect(stage(alice.page)).toHaveAttribute('data-call-phase', 'blocked', { timeout: WAIT });
    expect((await callSlice(alice.page))?.error?.code).toBe('E_UMK_CHANGED');
    // The notice names the changed contact only when they are among the call's participants in the room (task-6 review
    // M4); the native peer holds a leaf of the group but never enters the room, so the notice is the unnamed one
    // (voice.blockedJoin rather than voice.blockedChanged; task 10 report, concern 3).
    await expect(notice(alice.page, copy('voice.blockedJoin'))).toBeVisible({ timeout: WAIT });
    await expect(dock(alice.page)).toHaveCount(0);
    // The join stays held while the contact is changed (flow 06: no join button until the cause is gone).
    await expect(stage(alice.page).getByRole('button', { name: copy('voice.join'), exact: true })).toHaveCount(0);
    expect((await callSlice(alice.page))?.error?.code).toBe('E_UMK_CHANGED');

    // Positive control: bob, who met the peer only after the rotation, joins after alice's attempt; the peer's group
    // and the room both see him, so a device that had reached either would be seen too.
    await onboard(bob, peer, 'bob');
    await introduce(peer, [bob], 2);
    const b = await self(bob.page);
    await joinVoice(bob.page, peer.communityName, peer.voiceName);
    await peer.waitForCallMembers(call, (d) => d.includes(b.device), 'lists bob');
    await expect.poll(async () => (await peer.callRead(call)).participants.map((p) => p.device), POLL).toContain(b.device);
    const members = (await peer.callMembers(call)).devices;
    const room = (await peer.callRead(call)).participants.map((p) => p.device);
    expect(members, 'the call group after bob joined').not.toContain(a.device);
    expect(room, 'the room after bob joined').not.toContain(a.device);
    await expect(stage(alice.page)).toHaveAttribute('data-call-phase', 'blocked');
  } finally {
    await peerBrowser.close(bob);
    await peerBrowser.close(alice);
    await peer.close();
  }
});

test('(b) a device that fails the signed-list check joins mid-call: alice leaves, her dock goes and so does her leaf', async ({ peerBrowser }) => {
  const peer = await VoicePeer.start();
  const alice = await peerBrowser.open('alice');
  try {
    const s = await peer.setup({ password: 'peer-password-1234' });
    const call = s.voice_channel_id;
    await onboard(alice, peer, 'alice');
    await introduce(peer, [alice]);
    const a = await self(alice.page);
    await peer.callJoin(call);
    await joinVoice(alice.page, peer.communityName, peer.voiceName);
    await peer.waitForCallMembers(call, (d) => d.includes(a.device), 'lists alice');

    // A device of the peer that the instance admits but whose signed-list entry carries the wrong tier.
    await peer.forgeDevice();
    await peer.callJoin(call, 'second');
    await expect(notice(alice.page, copy('voice.blocked'))).toBeVisible({ timeout: WAIT });
    await expect(dock(alice.page)).toHaveCount(0, { timeout: WAIT });
    await expect(stage(alice.page)).toHaveAttribute('data-call-phase', 'blocked');
    await peer.waitForCallMembers(call, (d) => !d.includes(a.device), 'drops alice');
    await expect.poll(async () => (await peer.callRead(call)).participants.map((p) => p.device), POLL).not.toContain(a.device);
  } finally {
    await peerBrowser.close(alice);
    await peer.close();
  }
});

test('(c) a contact whose identity changes mid-call pauses the call for each browser until verified or gone (RV-3)', async ({ peerBrowser }) => {
  const peer = await VoicePeer.start();
  const alice = await peerBrowser.open('alice');
  const bob = await peerBrowser.open('bob');
  try {
    const s = await peer.setup();
    const call = s.voice_channel_id;
    await onboard(alice, peer, 'alice');
    await onboard(bob, peer, 'bob');
    await introduce(peer, [alice, bob]);
    const a = await self(alice.page);
    const b = await self(bob.page);
    const name = peerName(s);
    await noiseOff(alice.page);
    await noiseOff(bob.page);
    await peer.callJoin(call);
    await joinVoice(alice.page, peer.communityName, peer.voiceName);
    await joinVoice(bob.page, peer.communityName, peer.voiceName);
    await heard(alice.page, b.device);
    await heard(bob.page, a.device);

    // The peer's identity is replaced and its new device joins the call. Ordered so that the change reaches the call as
    // the new key's leaf: the old device's leaf is gone from the call group (its leave, committed by both browsers)
    // before the rotation, and both browsers' text group shows the new key before the new device joins the call group.
    // (While an old-key leaf of a changing contact is still in the call group, a list refresh through it fails the call
    // with E_CREDENTIAL instead of pausing it, about one run in two: task 10 report, concern 1.)
    // (The peer first takes in both joins: a leave proposed at an older epoch is refused.)
    await peer.waitForCallMembers(call, (d) => d.includes(a.device) && d.includes(b.device), 'lists alice and bob');
    await peer.callLeave(call);
    for (const p of [alice.page, bob.page]) {
      await expect.poll(async () => (await callSlice(p))?.roster.map((r) => r.deviceId).sort(), POLL).toEqual([a.device, b.device].sort());
    }
    await peer.sync();
    await peer.rotateUmk();
    await changedSeen(alice.page, s.user_id);
    await changedSeen(bob.page, s.user_id);
    await peer.callJoin(call);
    const paused = copy('voice.paused', { name });
    for (const p of [alice.page, bob.page]) {
      await expect(stage(p)).toHaveAttribute('data-call-phase', 'paused', { timeout: WAIT });
      await expect(stage(p).getByText(paused, { exact: true })).toBeVisible({ timeout: WAIT });
    }
    // The call does not end for anyone: both stay in the group.
    await peer.waitForCallMembers(call, (d) => d.includes(a.device) && d.includes(b.device), 'keeps alice and bob');

    // Nothing is heard while paused. Each side's own frames are the clock (a muted sender still encodes); after a settle
    // window for frames already in flight, neither counter moves for a fixed number of them.
    const still = async (listener: Page, speaker: Page, device: string) => {
      await framesPass(speaker, await sentCount(speaker), 10);
      const h0 = await heardCount(listener, device);
      await framesPass(speaker, await sentCount(speaker), 25);
      return (await heardCount(listener, device)) - h0;
    };
    expect(await still(alice.page, bob.page, b.device), 'frames alice verified from bob while paused').toBe(0);
    expect(await still(bob.page, alice.page, a.device), 'frames bob verified from alice while paused').toBe(0);

    await test.step('alice compares and verifies the peer: her call resumes', async () => {
      await stage(alice.page).getByRole('button', { name: copy('voice.pausedAction'), exact: true }).click();
      const dialog = alice.page.getByRole('dialog', { name: copy('privacy.title') });
      await expect(dialog).toBeVisible({ timeout: WAIT });
      await dialog.getByRole('button', { name: copy('privacy.copy') }).click();
      await dialog.getByRole('checkbox', { name: copy('privacy.confirm') }).check();
      await dialog.getByRole('button', { name: copy('privacy.verify') }).click();
      await expect(dialog).toHaveCount(0, { timeout: WAIT });
      await alice.page.keyboard.press('Escape');
      await expect(alice.page.getByRole('dialog', { name: copy('settings.title'), exact: true })).toBeHidden({ timeout: WAIT });
      await expect(stage(alice.page)).toHaveAttribute('data-call-phase', 'in', { timeout: WAIT });
      await expect(stage(bob.page)).toHaveAttribute('data-call-phase', 'paused');
    });

    await test.step('the peer leaves: bob resumes, and both hear each other again', async () => {
      const h0 = await heardCount(alice.page, b.device);
      const h1 = await heardCount(bob.page, a.device);
      await peer.callLeave(call);
      await expect(stage(bob.page)).toHaveAttribute('data-call-phase', 'in', { timeout: WAIT });
      await connected(bob.page);
      await expect.poll(() => heardCount(alice.page, b.device), POLL).toBeGreaterThan(h0);
      await expect.poll(() => heardCount(bob.page, a.device), POLL).toBeGreaterThan(h1);
      await expect(tile(alice.page, 'bob')).toHaveAttribute('data-voice-state', 'ok', { timeout: WAIT });
    });
  } finally {
    await peerBrowser.close(bob);
    await peerBrowser.close(alice);
    await peer.close();
  }
});

test('DM: a blocked DM call leaves the DM composer enabled', async ({ peerBrowser }) => {
  const peer = await VoicePeer.start();
  const alice = await peerBrowser.open('alice');
  try {
    await peer.setup({ password: 'peer-password-1234' });
    await onboard(alice, peer, 'alice');
    await introduce(peer, [alice]);
    const a = await self(alice.page);
    const dm = await peer.openDm(a.user);
    await expect.poll(async () => (await peer.syncDm(dm.channel_id)).members, POLL).toBe(2);
    await sidebarTab(alice.page, 'dms').click();
    await dmsNav(alice.page).locator('.d-chrow').first().click();
    await expect(alice.page).toHaveURL(new RegExp(`/dm/${dm.channel_id}$`), { timeout: WAIT });
    await expect(dmComposer(alice.page)).toBeEnabled({ timeout: WAIT });

    await peer.callJoin(dm.channel_id);
    // The peer holds the call group but is in no room: no live call, so the strip offers `call`.
    await alice.page.locator('.dw-call-strip').getByRole('button', { name: copy('call.start'), exact: true }).click();
    await connected(alice.page);
    await peer.waitForCallMembers(dm.channel_id, (d) => d.includes(a.device), 'lists alice');
    await peer.forgeDevice();
    await peer.callJoin(dm.channel_id, 'second');
    await expect(notice(alice.page, copy('voice.blocked'))).toBeVisible({ timeout: WAIT });
    await expect(dock(alice.page)).toHaveCount(0, { timeout: WAIT });
    // The call group's block is the call's only: the DM's text group is unaffected and so is its composer.
    await expect(dmComposer(alice.page)).toBeEnabled();
    await expect(dmComposer(alice.page)).not.toHaveAttribute('aria-disabled', 'true');
  } finally {
    await peerBrowser.close(alice);
    await peer.close();
  }
});
