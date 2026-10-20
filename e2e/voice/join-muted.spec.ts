// web3.8 WS6 (item 13, R25) and MUTE: a mute pressed in the user panel is in force from the first frame the microphone
// publishes. Pressed before a call, the next join starts muted; pressed while the join is still starting (the microphone
// prompt held open until the click has landed), the track goes to the publish already disabled. In both, every audio
// sender the page hands a peer connection carries a disabled track, and no audio goes out while she stays muted. What the
// others see (bob's tile for her, the voice_state self_mute bit) is the last test.
import { expect, test } from './support/peer-browser';
import { watchContexts } from './support/leaks';
import type { Person } from './support/peer-browser';
import {
  VoicePeer, WAIT, POLL, callSlice, connected, copy, joinVoice, noiseOff, openVoice, onboard, self, slice, stage, tile,
} from './support/voice';
import type { VoiceState } from '../../packages/client-core/src/state/types';

watchContexts(test);

const panelMute = (alice: Person) => alice.page.locator('.d-user-panel').getByRole('button', { name: copy('voice.mute'), exact: true });

interface Watch { pcs: RTCPeerConnection[]; handed: { at: string; enabled: boolean }[]; mics: WeakSet<MediaStreamTrack>; opened: number }

/**
 * From here on: every peer connection the page makes, and every audio track handed to one (addTransceiver, addTrack, or a
 * sender's replaceTrack, which LiveKit uses for the noise processor's output and a capture restart), with whether the
 * track was enabled at the moment it was handed over; and `opened`, how often a microphone track the page captured
 * actually turned enabled (LiveKit enables the track it publishes; the session must not let it while muted).
 */
async function watchAudio(alice: Person): Promise<void> {
  await alice.page.evaluate(() => {
    const w = window as unknown as { __watch: Watch };
    w.__watch = { pcs: [], handed: [], mics: new WeakSet(), opened: 0 };
    const enabled = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled')!;
    Object.defineProperty(MediaStreamTrack.prototype, 'enabled', {
      ...enabled,
      set(this: MediaStreamTrack, v: boolean) {
        const was = enabled.get!.call(this) as boolean;
        enabled.set!.call(this, v);
        if (!was && (enabled.get!.call(this) as boolean) && w.__watch.mics.has(this)) w.__watch.opened += 1;
      },
    });
    const md = navigator.mediaDevices;
    const capture = md.getUserMedia.bind(md);
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      const stream = await capture(c);
      for (const t of stream.getAudioTracks()) w.__watch.mics.add(t);
      return stream;
    };
    const hand = (at: string, track: MediaStreamTrack | null | undefined) => {
      if (track?.kind === 'audio') w.__watch.handed.push({ at, enabled: track.enabled });
    };
    const Native = window.RTCPeerConnection;
    const proto = Native.prototype;
    const addTransceiver = proto.addTransceiver;
    proto.addTransceiver = function (this: RTCPeerConnection, trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) {
      if (typeof trackOrKind !== 'string') hand('addTransceiver', trackOrKind);
      return addTransceiver.call(this, trackOrKind as MediaStreamTrack, init);
    } as typeof proto.addTransceiver;
    const addTrack = proto.addTrack;
    proto.addTrack = function (this: RTCPeerConnection, track: MediaStreamTrack, ...streams: MediaStream[]) {
      hand('addTrack', track);
      return addTrack.call(this, track, ...streams);
    };
    const replaceTrack = RTCRtpSender.prototype.replaceTrack;
    RTCRtpSender.prototype.replaceTrack = function (this: RTCRtpSender, track: MediaStreamTrack | null) {
      hand('replaceTrack', track);
      return replaceTrack.call(this, track);
    };
    class Watched extends Native {
      constructor(config?: RTCConfiguration) { super(config); w.__watch.pcs.push(this); }
    }
    window.RTCPeerConnection = Watched as typeof RTCPeerConnection;
  });
}

/** What alice's open peer connections send as audio now: each audio sender's track ('on', 'off', or 'none'), the
 *  outbound audio packets and bytes summed over every connection, and the media-source audio energy, or null where the
 *  browser reports none (Firefox has no media-source `totalAudioEnergy`). */
async function audioOut(alice: Person): Promise<{ senders: string[]; packets: number; bytes: number; energy: number | null }> {
  return alice.page.evaluate(async () => {
    const w = window as unknown as { __watch: Watch };
    const senders: string[] = [];
    let packets = 0;
    let bytes = 0;
    let energy: number | null = null;
    for (const pc of w.__watch.pcs) {
      if (pc.connectionState === 'closed') continue;
      for (const t of pc.getTransceivers()) {
        if (t.receiver.track.kind !== 'audio' || t.currentDirection === 'recvonly' || t.direction === 'recvonly' || t.currentDirection === 'stopped') continue;
        const track = t.sender.track;
        senders.push(track === null ? 'none' : track.enabled && track.readyState === 'live' ? 'on' : 'off');
      }
      const stats = await pc.getStats();
      stats.forEach((r: { type: string; kind?: string; packetsSent?: number; bytesSent?: number; totalAudioEnergy?: number }) => {
        if (r.type === 'outbound-rtp' && r.kind === 'audio') { packets += r.packetsSent ?? 0; bytes += r.bytesSent ?? 0; }
        if (r.type === 'media-source' && r.kind === 'audio' && typeof r.totalAudioEnergy === 'number') energy = (energy ?? 0) + r.totalAudioEnergy;
      });
    }
    return { senders, packets, bytes, energy };
  });
}

/**
 * A muted microphone still lets Opus send its discontinuous-transmission frames: on chromium about ten a second of some
 * twenty bytes each (a disabled track is silence, and silence is what DTX sends); the encoder's first second may send a
 * little more. A live one with the fake microphone's 1 kHz tone sends about 9 KB a second, with audio energy. The proof
 * that nothing went out is: every hand-off disabled, no captured track ever enabled (`opened`), no audio energy at the
 * sender where the browser measures it, and only DTX-sized frames after a settle period.
 */
const DTX_BYTES_PER_PACKET = 40;
const SETTLE_MS = 1_000;
/** The unmuted control: a live tone sends far more than DTX in half a second. */
const LIVE_BYTES_PER_HALF_S = 1_000;

/** Every audio track she handed over was disabled when it was handed, no captured microphone track ever turned enabled,
 *  each audio sender's track is disabled now, no audio energy has reached a sender, and once settled only DTX frames go
 *  out. */
async function sendsNoAudio(alice: Person): Promise<void> {
  await expect.poll(async () => (await audioOut(alice)).senders.join(','), { ...POLL, message: 'her audio senders' }).toMatch(/^(off|none)(,(off|none))*$/);
  const handed = await alice.page.evaluate(() => (window as unknown as { __watch: Watch }).__watch.handed);
  expect(handed.length, 'an audio track was handed to a peer connection').toBeGreaterThan(0);
  expect(handed.filter((h) => h.enabled), 'audio tracks handed over enabled').toEqual([]);
  expect(await alice.page.evaluate(() => (window as unknown as { __watch: Watch }).__watch.opened), 'times a microphone track turned enabled').toBe(0);
  const first = await audioOut(alice);
  if (first.energy === null) {
    // No media-source energy in this browser (Firefox): the proof rests on the disabled hand-offs and `opened == 0`
    // above, and the frame size below. Said in the report, never checked as a vacuous 0.
    test.info().annotations.push({ type: 'audio-energy', description: 'not reported by this browser; hand-offs, opened and frame size are the proof' });
  } else {
    expect(first.energy, 'audio energy that ever reached her sender').toBe(0);
  }
  await alice.page.waitForTimeout(SETTLE_MS);
  const before = await audioOut(alice);
  await alice.page.waitForTimeout(1_000);
  const after = await audioOut(alice);
  if (after.energy !== null) expect(after.energy, 'audio energy while muted').toBe(0);
  const bytes = after.bytes - before.bytes;
  const packets = after.packets - before.packets;
  expect(packets === 0 ? 0 : bytes / packets, 'bytes per audio packet while muted, once settled (DTX frames only)').toBeLessThanOrEqual(DTX_BYTES_PER_PACKET);
}

/** The control for the measure above: once she unmutes, the tone goes out (live-sized bytes, and energy where reported). */
async function sendsAudio(alice: Person): Promise<void> {
  await expect.poll(async () => {
    const a = await audioOut(alice);
    await alice.page.waitForTimeout(500);
    const b = await audioOut(alice);
    const louder = a.energy === null || b.energy === null || b.energy > a.energy;
    return louder && b.bytes - a.bytes > LIVE_BYTES_PER_HALF_S;
  }, { ...POLL, message: 'her unmuted microphone sends the tone' }).toBe(true);
}

/** Holds the microphone prompt of the next call start open until `releaseMic`; `micAsked` counts the prompts held. */
async function holdMic(alice: Person): Promise<void> {
  await alice.page.evaluate(() => {
    const w = window as unknown as { __micAsked: number; __releaseMic: () => void };
    const md = navigator.mediaDevices;
    const real = md.getUserMedia.bind(md);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    w.__micAsked = 0;
    w.__releaseMic = () => release();
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      if (c?.audio !== undefined && c.audio !== false) { w.__micAsked += 1; await gate; }
      return real(c);
    };
  });
}
const micAsked = (alice: Person) => alice.page.evaluate(() => (window as unknown as { __micAsked: number }).__micAsked);
const releaseMic = (alice: Person) => alice.page.evaluate(() => { (window as unknown as { __releaseMic: () => void }).__releaseMic(); });

test('mute pressed in the user panel before joining: alice joins muted, on her tile, her panel and every audio sender', async ({ peerBrowser }) => {
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

    await watchAudio(alice);
    await joinVoice(bob.page, peer.communityName, peer.voiceName);
    await joinVoice(alice.page, peer.communityName, peer.voiceName);

    await test.step('her own tile and her panel say muted from the first frame', async () => {
      const own = stage(alice.page).locator('.d-call-tile[data-own]');
      await expect(own.locator('.d-call-tile__state[data-state="muted"]')).toBeVisible({ timeout: WAIT });
      expect((await callSlice(alice.page))?.phase).toBe('in');
      await expect(panelMute(alice)).toHaveAttribute('aria-pressed', 'true');
    });

    await test.step('no audio sender carries an enabled track, and no audio goes out', async () => {
      await sendsNoAudio(alice);
    });
  } finally {
    await peerBrowser.close(bob);
    await peerBrowser.close(alice);
    await peer.close();
  }
});

// Fail closed (WS6 fix round 1, MUTE): a mute pressed while the join is still starting. The microphone prompt is held open
// until the click has landed, so the press is provably inside the start; the track then goes to the publish disabled.
// It runs with noise suppression off (the sender carries the capture track itself, and the unmuted control hears the
// tone) and on, the default (the sender carries the noise processor's output).
for (const noise of ['off', 'on'] as const) test(`mute pressed while the join is pending (noise ${noise}): the call starts muted and no audio sender is ever enabled`, async ({ peerBrowser }) => {
  const peer = peerBrowser.track(await VoicePeer.start());
  const alice = await peerBrowser.open('alice');
  try {
    await peer.setup();
    await onboard(alice, peer, 'alice');
    await peer.seat(1);
    // Noise off: the sender carries the capture track itself. Noise on (the default): it carries the processor's output.
    if (noise === 'off') await noiseOff(alice.page);
    await watchAudio(alice);
    await holdMic(alice);
    await openVoice(alice.page, peer.communityName, peer.voiceName);
    await stage(alice.page).getByRole('button', { name: copy('voice.join'), exact: true }).click();
    await expect.poll(() => micAsked(alice), { ...POLL, message: 'the start asked for the microphone' }).toBe(1);
    await panelMute(alice).click();
    await expect(panelMute(alice)).toHaveAttribute('aria-pressed', 'true', { timeout: WAIT });
    expect(await alice.page.evaluate(() => (window as unknown as { __watch: Watch }).__watch.pcs.length), 'no peer connection before the prompt answers').toBe(0);
    await releaseMic(alice);
    await connected(alice.page);
    await expect(panelMute(alice)).toHaveAttribute('aria-pressed', 'true');
    await expect(stage(alice.page).locator('.d-call-tile[data-own] .d-call-tile__state[data-state="muted"]')).toBeVisible({ timeout: WAIT });
    await sendsNoAudio(alice);
    // The measure tells the two apart: unmuted, her tone goes out. Only with noise suppression off: RNNoise removes the
    // fake microphone's steady tone, so the noise-on path has no audible control.
    if (noise === 'off') {
      await panelMute(alice).click();
      await expect(panelMute(alice)).toHaveAttribute('aria-pressed', 'false', { timeout: WAIT });
      await sendsAudio(alice);
    }
  } finally {
    await peerBrowser.close(alice);
    await peer.close();
  }
});

test('a join that starts muted shows bob the muted glyph, and the voice_state carries self_mute', async ({ peerBrowser }) => {
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
