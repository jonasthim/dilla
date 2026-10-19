// web3.8 WS6 (item 13, R25): mute pressed in the user panel before a call is the state the next join starts in. Alice presses
// mute outside a call, then joins voice: her own tile and the user panel say muted from the first frame, and the microphone
// track her peer connection publishes is disabled. What the others see (bob's tile for her, the voice_state self_mute bit)
// is the second test.
import { expect, test } from './support/peer-browser';
import { watchContexts } from './support/leaks';
import type { Person } from './support/peer-browser';
import {
  VoicePeer, WAIT, POLL, callSlice, connected, copy, joinVoice, openVoice, onboard, self, slice, stage, tile,
} from './support/voice';
import type { VoiceState } from '../../packages/client-core/src/state/types';

watchContexts(test);

const panelMute = (alice: Person) => alice.page.locator('.d-user-panel').getByRole('button', { name: copy('voice.mute'), exact: true });

/** Every audio track alice hands to a peer connection from here on, kept on the page for the assertions. */
async function recordSentAudio(alice: Person): Promise<void> {
  await alice.page.evaluate(() => {
    const w = window as unknown as { __sent: MediaStreamTrack[] };
    w.__sent = [];
    const addTransceiver = RTCPeerConnection.prototype.addTransceiver;
    RTCPeerConnection.prototype.addTransceiver = function (this: RTCPeerConnection, trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) {
      if (typeof trackOrKind !== 'string' && trackOrKind.kind === 'audio') w.__sent.push(trackOrKind);
      return addTransceiver.call(this, trackOrKind as MediaStreamTrack, init);
    } as typeof RTCPeerConnection.prototype.addTransceiver;
    const addTrack = RTCPeerConnection.prototype.addTrack;
    RTCPeerConnection.prototype.addTrack = function (this: RTCPeerConnection, track: MediaStreamTrack, ...streams: MediaStream[]) {
      if (track.kind === 'audio') w.__sent.push(track);
      return addTrack.call(this, track, ...streams);
    };
  });
}

test('mute pressed in the user panel before joining: alice joins muted, on her tile, her panel and her microphone track', async ({ peerBrowser }) => {
  const peer = peerBrowser.track(await VoicePeer.start());
  const alice = await peerBrowser.open('alice');
  const bob = await peerBrowser.open('bob');
  try {
    await peer.setup();
    await onboard(alice, peer, 'alice');
    await onboard(bob, peer, 'bob');
    await peer.seat(2);

    await test.step('mute in the user panel with no call', async () => {
      const mute = panelMute(alice);
      await expect(mute).toHaveAttribute('aria-pressed', 'false');
      await mute.click();
      await expect(mute).toHaveAttribute('aria-pressed', 'true', { timeout: WAIT });
    });

    await recordSentAudio(alice);
    await joinVoice(bob.page, peer.communityName, peer.voiceName);
    await joinVoice(alice.page, peer.communityName, peer.voiceName);

    await test.step('her own tile and her panel say muted from the first frame', async () => {
      const own = stage(alice.page).locator('.d-call-tile[data-own]');
      await expect(own.locator('.d-call-tile__state[data-state="muted"]')).toBeVisible({ timeout: WAIT });
      expect((await callSlice(alice.page))?.phase).toBe('in');
      await expect(panelMute(alice)).toHaveAttribute('aria-pressed', 'true');
    });

    await test.step('the microphone track she published is disabled', async () => {
      await expect.poll(() => alice.page.evaluate(() => {
        const sent = (window as unknown as { __sent: MediaStreamTrack[] }).__sent;
        return sent.length === 0 ? 'none' : sent.map((t) => (t.enabled ? 'on' : 'off')).join(',');
      }), { ...POLL, message: 'the published audio tracks' }).toMatch(/^off(,off)*$/);
    });
  } finally {
    await peerBrowser.close(bob);
    await peerBrowser.close(alice);
    await peer.close();
  }
});

// Fail closed (WS6 fix round 1): a mute pressed while the join is still starting is applied to the session when it attaches,
// so the microphone she publishes is disabled although the start read the setting before the press.
test('mute pressed while the join is pending: the call starts muted and the published mic is disabled', async ({ peerBrowser }) => {
  const peer = peerBrowser.track(await VoicePeer.start());
  const alice = await peerBrowser.open('alice');
  try {
    await peer.setup();
    await onboard(alice, peer, 'alice');
    await peer.seat(1);
    await recordSentAudio(alice);
    await openVoice(alice.page, peer.communityName, peer.voiceName);
    await stage(alice.page).getByRole('button', { name: copy('voice.join'), exact: true }).click();
    // The press lands in the window of the start (the join is a token, an SFU connect and a mic grant).
    await panelMute(alice).click();
    await connected(alice.page);
    await expect(panelMute(alice)).toHaveAttribute('aria-pressed', 'true');
    await expect(stage(alice.page).locator('.d-call-tile[data-own] .d-call-tile__state[data-state="muted"]')).toBeVisible({ timeout: WAIT });
    await expect.poll(() => alice.page.evaluate(() => {
      const sent = (window as unknown as { __sent: MediaStreamTrack[] }).__sent;
      return sent.length === 0 ? 'none' : sent.map((t) => (t.enabled ? 'on' : 'off')).join(',');
    }), { ...POLL, message: 'the published audio tracks' }).toMatch(/^off(,off)*$/);
  } finally {
    await peerBrowser.close(alice);
    await peer.close();
  }
});

// Red until the worker re-sends voice_self when its own voice_state lacks the self bits (the instance refuses a voice_self
// that reaches it before the SFU lists the device, and nothing re-sends it): see WS6-report.md, concern 1.
test.fixme('a join that starts muted shows bob the muted glyph, and the voice_state carries self_mute', async ({ peerBrowser }) => {
  const peer = peerBrowser.track(await VoicePeer.start());
  const alice = await peerBrowser.open('alice');
  const bob = await peerBrowser.open('bob');
  try {
    await peer.setup();
    await onboard(alice, peer, 'alice');
    await onboard(bob, peer, 'bob');
    await peer.seat(2);
    const a = await self(alice.page);
    await panelMute(alice).click();
    await expect(panelMute(alice)).toHaveAttribute('aria-pressed', 'true', { timeout: WAIT });
    // Bob is in the room first: the self-mute is a voice_state broadcast, which a later joiner would not replay.
    await joinVoice(bob.page, peer.communityName, peer.voiceName);
    await joinVoice(alice.page, peer.communityName, peer.voiceName);
    await expect.poll(async () => {
      const voice = await slice<VoiceState>(alice.page, 'voice');
      const mine = Object.values(voice ?? {}).flatMap((c) => c.participants).find((p) => p.deviceId === a.device);
      // voice_state flags (protocol/02): bit 0 in_call, bit 1 self_mute.
      return mine === undefined ? null : (mine.flags & 2) === 2;
    }, { ...POLL, message: 'her own participant says self_mute' }).toBe(true);
    await expect(tile(bob.page, 'alice').locator('.d-call-tile__state[data-state="muted"]')).toBeVisible({ timeout: WAIT });
  } finally {
    await peerBrowser.close(bob);
    await peerBrowser.close(alice);
    await peer.close();
  }
});
