// fix/firefox-misrouted-audio: a peer whose audio lands on a spare receiver (Firefox only).
//
// livekit-server 1.13.7 (single peer connection, pre-requested spare media sections) can forward the first RTP of a
// re-subscribed track on a reused transceiver before this client has applied the answer that signals its SSRC, and its
// DownTrack writes no MID header extension although the answer negotiates one. Firefox then demuxes that SSRC by payload
// type onto a spare audio section that LiveKit never bound to a track, and keeps it there after the answer: the receiver
// LiveKit bound (track.receiver) gets nothing and the peer stays silent. Measured (fix/media-receiver-map rounds 1-2): the
// spare mid 2 held the SSRC that the SDP put on mid 0 or 1; Chromium never misroutes.
//
// The watch reads getStats only. Frames on the spare receiver are never mapped, so the worker keeps holding and dropping
// them (never decrypted under a guessed identity); the remedy is LiveKit's own re-subscription, which binds a new
// downtrack (a new SSRC) once the client has the answer.
//
// Known limit (review M2): a receiver once bound to a subscribed track is never counted as spare, also after its peer
// left and its transceiver is free. Were Firefox's payload-type fallback to pick such a section rather than a
// pre-requested spare, the watch would not fire; every measured case used the pre-requested spare (mid 2).

/** How long after TrackSubscribed the bound receiver may stay without RTP before the watch decides. */
export const MISROUTE_WINDOW_MS = 3_000;
export const MISROUTE_POLL_MS = 500;
/** setSubscribed(false), then this long, then setSubscribed(true): the SFU sees an unsubscribe before the subscribe. */
export const RESUBSCRIBE_GAP_MS = 300;
export const MISROUTE_CODE = 'E_MEDIA_MISROUTE';

type Level = 'error' | 'warn' | 'info' | 'debug';
type StatsSource = Pick<RTCRtpReceiver, 'getStats'>;
interface WatchedTrack { kind: unknown; receiver?: RTCRtpReceiver; isMuted?: boolean }
/** isMuted / isDesired as livekit-client's RemoteTrackPublication has them; absent reads as unmuted and desired. */
interface WatchedPublication { trackSid: string; isMuted?: boolean; isDesired?: boolean; setSubscribed(on: boolean): void }
interface WatchedParticipant { sid: string; identity: string }

export interface MisrouteDeps {
  /** Firefox only (support.ts isFirefox); false makes every method a no-op. */
  enabled: boolean;
  log(level: Level, msg: string): void;
  /** A misroute was seen and the publication re-subscribed (setSubscribed false, then true, both done). */
  onRecover(identity: string): void;
  /** A misroute was seen again for a publication already re-subscribed once: logged and counted only. */
  onMiss(identity: string): void;
}

interface Episode { cancelled: boolean; timer: ReturnType<typeof setTimeout> | undefined }

/** packetsReceived summed over the receiver's inbound-rtp entries; 0 without one; null when getStats failed. */
async function inboundPackets(r: StatsSource): Promise<number | null> {
  try {
    const report = await r.getStats();
    let n = 0;
    report.forEach((v: unknown) => {
      const e = v as { type?: unknown; packetsReceived?: unknown };
      if (e?.type === 'inbound-rtp' && typeof e.packetsReceived === 'number') n += e.packetsReceived;
    });
    return n;
  } catch {
    return null;
  }
}

export class MisrouteWatch {
  /** Every receiver MediaTrackAdded delivered (spare sections included). */
  private readonly receivers = new Set<StatsSource>();
  /** Receivers LiveKit ever bound to a subscribed track: never spare, whatever they carry now. */
  private readonly bound = new WeakSet<object>();
  private readonly episodes = new Map<object, Episode>();
  /** Publications (participant sid / track sid) re-subscribed once already. */
  private readonly recovered = new Set<string>();
  private disposed = false;

  constructor(private readonly deps: MisrouteDeps) {}

  receiverAdded(receiver: RTCRtpReceiver): void {
    if (!this.deps.enabled || this.disposed) return;
    this.receivers.add(receiver);
  }

  subscribed(track: WatchedTrack, pub: WatchedPublication, participant: WatchedParticipant): void {
    if (!this.deps.enabled || this.disposed) return;
    const receiver = track.receiver;
    if (receiver === undefined) return;
    this.bound.add(receiver);
    this.receivers.add(receiver);
    if (String(track.kind) !== 'audio') return;
    this.cancel(receiver);
    const episode: Episode = { cancelled: false, timer: undefined };
    this.episodes.set(receiver, episode);
    void this.run(episode, track, receiver, pub, participant);
  }

  unsubscribed(track: WatchedTrack): void {
    if (track.receiver !== undefined) this.cancel(track.receiver);
  }

  dispose(): void {
    this.disposed = true;
    for (const r of [...this.episodes.keys()]) this.cancel(r);
    this.receivers.clear();
  }

  private cancel(receiver: object): void {
    const e = this.episodes.get(receiver);
    if (e === undefined) return;
    e.cancelled = true;
    clearTimeout(e.timer);
    this.episodes.delete(receiver);
  }

  private wait(episode: Episode, ms: number): Promise<void> {
    return new Promise((resolve) => { episode.timer = setTimeout(resolve, ms); });
  }

  /**
   * The spare receivers' counts now: every never-bound receiver whose getStats answered, with 0 when it has no inbound-rtp
   * entry yet (so a spare silent until now is seen when it starts receiving); one whose getStats failed is left out.
   */
  private async spareCounts(): Promise<Map<StatsSource, number>> {
    const out = new Map<StatsSource, number>();
    await Promise.all([...this.receivers].filter((r) => !this.bound.has(r)).map(async (r) => {
      const n = await inboundPackets(r);
      if (n !== null) out.set(r, n);
    }));
    return out;
  }

  private async run(episode: Episode, track: WatchedTrack, receiver: RTCRtpReceiver, pub: WatchedPublication, participant: WatchedParticipant): Promise<void> {
    const baseline = await this.spareCounts();
    if (episode.cancelled) return; // review M4: no timer is armed for an episode cancelled during the baseline read
    for (let elapsed = MISROUTE_POLL_MS; elapsed <= MISROUTE_WINDOW_MS; elapsed += MISROUTE_POLL_MS) {
      await this.wait(episode, MISROUTE_POLL_MS);
      if (episode.cancelled) return;
      const own = await inboundPackets(receiver);
      if (episode.cancelled) return;
      if (own === null || own > 0) return this.finish(episode, receiver); // RTP arrived, or no reading at all: no case
    }
    // The window is over and the bound receiver got nothing. A slow first packet is no case: only a never-bound receiver
    // whose count rose during the window (RTP arriving where nothing reads it) is.
    const now = await this.spareCounts();
    if (episode.cancelled) return;
    this.finish(episode, receiver);
    // Review I1: a muted peer (or one SpeakerPolicy no longer wants) legitimately sends nothing, and nothing ties a spare's
    // RTP to this peer: such a publication is never re-subscribed nor named for another peer's misroute.
    if (pub.isMuted === true || track.isMuted === true || pub.isDesired === false) return;
    const spare = [...now].some(([r, n]) => n > (baseline.get(r) ?? Number.POSITIVE_INFINITY));
    if (!spare) return;
    const key = `${participant.sid}/${pub.trackSid}`;
    if (this.recovered.has(key)) {
      this.deps.log('error', `${MISROUTE_CODE}: ${participant.identity} ${pub.trackSid} is on a spare receiver again; not re-subscribed twice`);
      this.deps.onMiss(participant.identity);
      return;
    }
    this.recovered.add(key);
    this.deps.log('error', `${MISROUTE_CODE}: ${participant.identity} ${pub.trackSid} landed on a spare receiver; re-subscribing`);
    try {
      pub.setSubscribed(false);
    } catch (err) {
      this.deps.log('warn', `${MISROUTE_CODE}: unsubscribe failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const gap: Episode = { cancelled: false, timer: undefined };
    this.episodes.set(pub, gap);
    await this.wait(gap, RESUBSCRIBE_GAP_MS);
    if (gap.cancelled || this.disposed) return;
    this.episodes.delete(pub);
    try {
      pub.setSubscribed(true);
    } catch (err) {
      this.deps.log('warn', `${MISROUTE_CODE}: subscribe failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Review M3: counted (and noted for Diagnostics) only once the re-subscription was actually asked for.
    this.deps.onRecover(participant.identity);
  }

  private finish(episode: Episode, receiver: object): void {
    if (this.episodes.get(receiver) === episode) this.episodes.delete(receiver);
  }
}
