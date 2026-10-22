// The Firefox misroute watchdog (fix/firefox-misrouted-audio). livekit-server 1.13.7 forwards a re-subscribed track's
// RTP on a reused transceiver before the client has applied the answer that signals its SSRC, and writes no MID header
// extension; Firefox then demuxes that SSRC by payload type onto a spare audio section that LiveKit never bound, and
// keeps it there. The bound receiver gets nothing. The watchdog sees both halves in getStats and re-subscribes once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MISROUTE_POLL_MS, MISROUTE_WINDOW_MS, MisrouteWatch, RESUBSCRIBE_GAP_MS, type MisrouteDeps } from '../src/misroute';
import { isFirefox } from '../src/support';

/** A receiver whose inbound-rtp packetsReceived the test moves. `null` is "no inbound-rtp entry at all". */
class FakeReceiver {
  packets: number | null = null;
  reads = 0;
  async getStats(): Promise<Map<string, unknown>> {
    this.reads += 1;
    const m = new Map<string, unknown>();
    m.set('t1', { type: 'transport', id: 't1' });
    if (this.packets !== null) m.set('in1', { type: 'inbound-rtp', id: 'in1', kind: 'audio', packetsReceived: this.packets });
    return m;
  }
}

class FakePublication {
  isSubscribed = true;
  isMuted = false;
  isDesired = true;
  /** When set, setSubscribed throws it (a publication LiveKit no longer holds). */
  throwOnSet: Error | null = null;
  readonly calls: boolean[] = [];
  constructor(readonly trackSid: string) {}
  setSubscribed(on: boolean): void {
    if (this.throwOnSet !== null) throw this.throwOnSet;
    this.calls.push(on);
    this.isSubscribed = on;
  }
}

const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0';
const CHROMIUM_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

function setup(o: { firefox?: boolean } = {}): { w: MisrouteWatch; deps: MisrouteDeps & { recovered: string[]; missed: string[]; logs: string[] } } {
  const recovered: string[] = [];
  const missed: string[] = [];
  const logs: string[] = [];
  const deps = {
    enabled: o.firefox ?? true,
    log: (level: string, msg: string) => { logs.push(`${level} ${msg}`); },
    onRecover: (identity: string) => { recovered.push(identity); },
    onMiss: (identity: string) => { missed.push(identity); },
    recovered, missed, logs,
  };
  return { w: new MisrouteWatch(deps), deps };
}

const audio = (receiver: FakeReceiver) => ({ kind: 'audio', receiver: receiver as unknown as RTCRtpReceiver });
const peer = (sid = 'PA_carol', identity = 'c3'.repeat(16)) => ({ sid, identity });

/** Runs the 3 s window: every poll, with `step` run before it (a packet counter moving). */
async function runWindow(step: (tick: number) => void = () => undefined): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  for (let t = 1; t * MISROUTE_POLL_MS <= MISROUTE_WINDOW_MS; t++) {
    step(t);
    await vi.advanceTimersByTimeAsync(MISROUTE_POLL_MS);
  }
  await vi.advanceTimersByTimeAsync(RESUBSCRIBE_GAP_MS);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('isFirefox, the one place that decides the watchdog runs', () => {
  it('is true for every Gecko browser (Firefox, Firefox for Android, SeaMonkey) and false for Chromium, Safari and an empty agent', () => {
    expect(isFirefox(FIREFOX_UA)).toBe(true);
    expect(isFirefox('Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0')).toBe(true);
    expect(isFirefox('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 SeaMonkey/2.53.20')).toBe(true);
    expect(isFirefox(CHROMIUM_UA)).toBe(false);
    expect(isFirefox('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe(false);
    expect(isFirefox('')).toBe(false);
  });
});

describe('MisrouteWatch', () => {
  it('fires on a misroute: the bound receiver gets nothing while a never-bound receiver gets RTP; re-subscribes once', async () => {
    const { w, deps } = setup();
    const bound = new FakeReceiver();
    const spare = new FakeReceiver();
    w.receiverAdded(bound as unknown as RTCRtpReceiver);
    w.receiverAdded(spare as unknown as RTCRtpReceiver);
    spare.packets = 10;
    const pub = new FakePublication('TR_a');
    w.subscribed(audio(bound), pub, peer());
    await runWindow(() => { spare.packets! += 25; });
    expect(pub.calls).toEqual([false, true]);
    expect(deps.recovered).toEqual(['c3'.repeat(16)]);
    expect(deps.missed).toEqual([]);
    expect(deps.logs.some((l) => l.startsWith('error E_MEDIA_MISROUTE'))).toBe(true);
  });

  it('does not fire on a slow first packet when no spare receiver gets RTP', async () => {
    const { w, deps } = setup();
    const bound = new FakeReceiver();
    const spare = new FakeReceiver();
    w.receiverAdded(bound as unknown as RTCRtpReceiver);
    w.receiverAdded(spare as unknown as RTCRtpReceiver);
    const pub = new FakePublication('TR_a');
    w.subscribed(audio(bound), pub, peer());
    await runWindow();
    expect(pub.calls).toEqual([]);
    expect(deps.recovered).toEqual([]);
  });

  // Review I2: a receiver that MediaTrackAdded delivers mid-window (another peer whose TrackSubscribed LiveKit defers)
  // carries that peer's RTP; it is not a spare of the watched subscription.
  it('does not fire on RTP of a receiver that appeared after the window began', async () => {
    const { w, deps } = setup();
    const bound = new FakeReceiver();
    const late = new FakeReceiver();
    const pub = new FakePublication('TR_a');
    w.subscribed(audio(bound), pub, peer());
    await vi.advanceTimersByTimeAsync(MISROUTE_POLL_MS);
    w.receiverAdded(late as unknown as RTCRtpReceiver);
    late.packets = 0;
    await runWindow(() => { late.packets! += 25; });
    expect(pub.calls).toEqual([]);
    expect(deps.recovered).toEqual([]);
  });

  // Review I1: a muted peer's bound receiver legitimately gets nothing; another peer's misroute must not re-subscribe it
  // nor name it in E_MEDIA_MISROUTE.
  it('does not fire for a muted publication, whatever a spare receiver does', async () => {
    const { w, deps } = setup();
    const bound = new FakeReceiver();
    const spare = new FakeReceiver();
    w.receiverAdded(spare as unknown as RTCRtpReceiver);
    spare.packets = 0;
    const pub = new FakePublication('TR_muted');
    pub.isMuted = true;
    w.subscribed(audio(bound), pub, peer('PA_yves', 'd4'.repeat(16)));
    await runWindow(() => { spare.packets! += 25; });
    expect(pub.calls).toEqual([]);
    expect(deps.recovered).toEqual([]);
    expect(deps.logs.filter((l) => l.startsWith('error'))).toEqual([]);
  });

  it('does not fire for a publication muted during the window, nor for one no longer desired', async () => {
    const { w, deps } = setup();
    const spare = new FakeReceiver();
    w.receiverAdded(spare as unknown as RTCRtpReceiver);
    spare.packets = 0;
    const mutedLate = new FakePublication('TR_m');
    const undesired = new FakePublication('TR_u');
    w.subscribed(audio(new FakeReceiver()), mutedLate, peer('PA_m'));
    w.subscribed(audio(new FakeReceiver()), undesired, peer('PA_u'));
    await runWindow((t) => { spare.packets! += 25; if (t === 3) { mutedLate.isMuted = true; undesired.isDesired = false; } });
    expect(mutedLate.calls).toEqual([]);
    expect(undesired.calls).toEqual([]);
    expect(deps.recovered).toEqual([]);
  });

  // Review M3: the recovery is counted only when the re-subscription was actually asked for.
  it('counts nothing when the unsubscribe throws', async () => {
    const { w, deps } = setup();
    const spare = new FakeReceiver();
    w.receiverAdded(spare as unknown as RTCRtpReceiver);
    spare.packets = 0;
    const pub = new FakePublication('TR_a');
    pub.throwOnSet = new Error('gone');
    w.subscribed(audio(new FakeReceiver()), pub, peer());
    await runWindow(() => { spare.packets! += 25; });
    expect(deps.recovered).toEqual([]);
  });

  it('does not fire when a spare receiver holds an old, still count: only a count that rises is RTP arriving', async () => {
    const { w } = setup();
    const bound = new FakeReceiver();
    const spare = new FakeReceiver();
    spare.packets = 400;
    w.receiverAdded(spare as unknown as RTCRtpReceiver);
    const pub = new FakePublication('TR_a');
    w.subscribed(audio(bound), pub, peer());
    await runWindow();
    expect(pub.calls).toEqual([]);
  });

  it('does not fire when the bound receiver gets packets, whatever a spare one does', async () => {
    const { w } = setup();
    const bound = new FakeReceiver();
    const spare = new FakeReceiver();
    spare.packets = 0;
    w.receiverAdded(spare as unknown as RTCRtpReceiver);
    const pub = new FakePublication('TR_a');
    w.subscribed(audio(bound), pub, peer());
    await runWindow((t) => { spare.packets! += 25; if (t === 4) bound.packets = 2; });
    expect(pub.calls).toEqual([]);
  });

  it('does not count a receiver once bound to a subscribed track as spare', async () => {
    const { w } = setup();
    const other = new FakeReceiver();
    const bound = new FakeReceiver();
    w.receiverAdded(other as unknown as RTCRtpReceiver);
    w.subscribed(audio(other), new FakePublication('TR_alice'), peer('PA_alice', 'a1'.repeat(16)));
    other.packets = 0;
    const pub = new FakePublication('TR_a');
    w.subscribed(audio(bound), pub, peer());
    await runWindow(() => { other.packets! += 25; });
    expect(pub.calls).toEqual([]);
  });

  it('does not run on Chromium', async () => {
    const { w, deps } = setup({ firefox: false });
    const bound = new FakeReceiver();
    const spare = new FakeReceiver();
    w.receiverAdded(spare as unknown as RTCRtpReceiver);
    spare.packets = 0;
    const pub = new FakePublication('TR_a');
    w.subscribed(audio(bound), pub, peer());
    await runWindow(() => { spare.packets! += 25; });
    expect(pub.calls).toEqual([]);
    expect(bound.reads + spare.reads).toBe(0);
    expect(deps.recovered).toEqual([]);
  });

  it('does not watch a video track', async () => {
    const { w } = setup();
    const bound = new FakeReceiver();
    const spare = new FakeReceiver();
    w.receiverAdded(spare as unknown as RTCRtpReceiver);
    spare.packets = 0;
    const pub = new FakePublication('TR_v');
    w.subscribed({ kind: 'video', receiver: bound as unknown as RTCRtpReceiver }, pub, peer());
    await runWindow(() => { spare.packets! += 25; });
    expect(pub.calls).toEqual([]);
  });

  it('fires once per publication: a second misroute of the re-subscription only logs and counts a miss', async () => {
    const { w, deps } = setup();
    const bound = new FakeReceiver();
    const spare = new FakeReceiver();
    w.receiverAdded(spare as unknown as RTCRtpReceiver);
    spare.packets = 0;
    const pub = new FakePublication('TR_a');
    w.subscribed(audio(bound), pub, peer());
    await runWindow(() => { spare.packets! += 25; });
    expect(pub.calls).toEqual([false, true]);
    // The re-subscription lands on the same bound receiver and misroutes again.
    w.subscribed(audio(bound), pub, peer());
    await runWindow(() => { spare.packets! += 25; });
    expect(pub.calls).toEqual([false, true]);
    expect(deps.recovered).toHaveLength(1);
    expect(deps.missed).toEqual(['c3'.repeat(16)]);
    expect(deps.logs.filter((l) => l.startsWith('error E_MEDIA_MISROUTE'))).toHaveLength(2);
  });

  it('a new participant session of the same identity is a new publication and may be recovered again', async () => {
    const { w, deps } = setup();
    const bound = new FakeReceiver();
    const spare = new FakeReceiver();
    w.receiverAdded(spare as unknown as RTCRtpReceiver);
    spare.packets = 0;
    w.subscribed(audio(bound), new FakePublication('TR_a'), peer('PA_one'));
    await runWindow(() => { spare.packets! += 25; });
    const next = new FakePublication('TR_b');
    w.subscribed(audio(bound), next, peer('PA_two'));
    await runWindow(() => { spare.packets! += 25; });
    expect(next.calls).toEqual([false, true]);
    expect(deps.recovered).toHaveLength(2);
  });

  it('stops on unsubscribe: no read and no action after it', async () => {
    const { w } = setup();
    const bound = new FakeReceiver();
    const spare = new FakeReceiver();
    w.receiverAdded(spare as unknown as RTCRtpReceiver);
    spare.packets = 0;
    const pub = new FakePublication('TR_a');
    const track = audio(bound);
    w.subscribed(track, pub, peer());
    await vi.advanceTimersByTimeAsync(MISROUTE_POLL_MS);
    w.unsubscribed(track);
    const reads = bound.reads;
    await runWindow(() => { spare.packets! += 25; });
    expect(pub.calls).toEqual([]);
    expect(bound.reads).toBe(reads);
  });

  it('stops on leave (dispose), also between the unsubscribe and the subscribe of a recovery', async () => {
    const { w } = setup();
    const bound = new FakeReceiver();
    const spare = new FakeReceiver();
    w.receiverAdded(spare as unknown as RTCRtpReceiver);
    spare.packets = 0;
    const pub = new FakePublication('TR_a');
    w.subscribed(audio(bound), pub, peer());
    await runWindow(() => { spare.packets! += 25; });
    expect(pub.calls).toEqual([false, true]);

    const { w: w2 } = setup();
    const pub2 = new FakePublication('TR_b');
    w2.receiverAdded(spare as unknown as RTCRtpReceiver);
    const bound2 = new FakeReceiver();
    w2.subscribed(audio(bound2), pub2, peer());
    await vi.advanceTimersByTimeAsync(MISROUTE_POLL_MS);
    w2.dispose();
    const reads2 = bound2.reads;
    await runWindow(() => { spare.packets! += 25; });
    expect(pub2.calls).toEqual([]);
    expect(bound2.reads).toBe(reads2); // no getStats after the leave

    // Disposed after setSubscribed(false): the true is not sent to a room that is gone.
    const { w: w3 } = setup();
    const pub3 = new FakePublication('TR_c');
    w3.receiverAdded(spare as unknown as RTCRtpReceiver);
    w3.subscribed(audio(new FakeReceiver()), pub3, peer());
    await vi.advanceTimersByTimeAsync(0);
    for (let t = 1; t * MISROUTE_POLL_MS <= MISROUTE_WINDOW_MS; t++) { spare.packets! += 25; await vi.advanceTimersByTimeAsync(MISROUTE_POLL_MS); }
    expect(pub3.calls).toEqual([false]);
    w3.dispose();
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_GAP_MS);
    expect(pub3.calls).toEqual([false]);
  });

  it('a getStats that throws is no reading: nothing fires', async () => {
    const { w } = setup();
    const bound = { getStats: () => Promise.reject(new Error('closed')) };
    const spare = new FakeReceiver();
    w.receiverAdded(spare as unknown as RTCRtpReceiver);
    spare.packets = 0;
    const pub = new FakePublication('TR_a');
    w.subscribed({ kind: 'audio', receiver: bound as unknown as RTCRtpReceiver }, pub, peer());
    await runWindow(() => { spare.packets! += 25; });
    expect(pub.calls).toEqual([]);
  });
});
