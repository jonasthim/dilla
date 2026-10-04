import { RoomEvent, Track, type Participant, type RemoteParticipant, type RemoteTrackPublication, type Room } from 'livekit-client';

/**
 * The spec's "top-6 active-speaker forwarding" as client policy (ruling DEV-04 a): LiveKit has no
 * top-N audio forwarding (`Room.GetActiveSpeakers` returns every active speaker, uncapped), so each
 * client subscribes to at most `max` remote microphones and lets `setSubscribed(false)` stop the
 * rest at the SFU. `ActiveSpeakersChanged` arrives every `audio.update_interval` (400 ms), sorted
 * loudest first. Hysteresis: a newcomer to the top `max` enters only after it has stayed there for
 * `holdMs`, and then displaces the member that has been out of the top the longest. Capacity math
 * still counts N×(N−1) audio downtracks: the policy saves receive bandwidth, the SFU's ingress and
 * per-subscriber egress for subscribed tracks are unchanged.
 * An excluded, camera-less participant yields no decrypted frames and stays "not heard yet" in
 * verifiedIdentities(); the UI must distinguish that state from a failed verification.
 */
export class SpeakerPolicy {
  private readonly max: number;
  private readonly holdMs: number;
  private readonly now: () => number;
  /** identity → when it was last in the top `max`. */
  private readonly selected = new Map<string, number>();
  /** identity → since when it has been in the top `max` without being selected. */
  private readonly candidates = new Map<string, number>();
  /** Publications this policy turned off, rather than an application mute. */
  private readonly excluded = new WeakSet<RemoteTrackPublication>();
  private timer?: ReturnType<typeof setTimeout>;
  private lastSpeakers: Participant[] = [];
  private readonly onSpeakers = (speakers: Participant[]) => this.update(speakers);
  private readonly onConnected = (p: RemoteParticipant) => {
    if (this.selected.size < this.max) this.selected.set(p.identity, this.now());
    this.apply();
  };
  private readonly onDisconnected = (p: RemoteParticipant) => {
    this.selected.delete(p.identity);
    this.candidates.delete(p.identity);
    this.apply();
  };
  private readonly onPublished = () => this.apply();

  constructor(
    private readonly room: Room,
    opts: { max?: number; holdMs?: number; now?: () => number } = {},
  ) {
    this.max = opts.max ?? 6;
    this.holdMs = opts.holdMs ?? 2_000;
    this.now = opts.now ?? (() => performance.now());
    const t = this.now();
    for (const p of this.remotes()) {
      if (this.selected.size >= this.max) break;
      this.selected.set(p.identity, t);
    }
    room.on(RoomEvent.ActiveSpeakersChanged, this.onSpeakers);
    room.on(RoomEvent.ParticipantConnected, this.onConnected);
    room.on(RoomEvent.ParticipantDisconnected, this.onDisconnected);
    room.on(RoomEvent.TrackPublished, this.onPublished);
    this.apply();
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.room.off(RoomEvent.ActiveSpeakersChanged, this.onSpeakers);
    this.room.off(RoomEvent.ParticipantConnected, this.onConnected);
    this.room.off(RoomEvent.ParticipantDisconnected, this.onDisconnected);
    this.room.off(RoomEvent.TrackPublished, this.onPublished);
    for (const p of this.remotes()) {
      const pub = p.getTrackPublication(Track.Source.Microphone);
      if (pub && this.excluded.has(pub)) {
        if (!pub.isDesired) pub.setSubscribed(true);
        this.excluded.delete(pub);
      }
    }
  }

  private remotes(): RemoteParticipant[] {
    return [...this.room.remoteParticipants.values()];
  }

  private update(speakers: Participant[]): void {
    this.lastSpeakers = speakers;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const t = this.now();
    const remote = new Set(this.remotes().map((p) => p.identity));
    const top = speakers.map((p) => p.identity).filter((id) => remote.has(id)).slice(0, this.max);
    const inTop = new Set(top);
    for (const id of [...this.selected.keys()]) if (!remote.has(id)) this.selected.delete(id);
    for (const id of top) {
      if (this.selected.has(id)) this.selected.set(id, t);
      else if (!this.candidates.has(id)) this.candidates.set(id, t);
    }
    for (const id of [...this.candidates.keys()]) if (!inTop.has(id)) this.candidates.delete(id);
    for (const [id, since] of [...this.candidates.entries()].sort((a, b) => a[1] - b[1])) {
      if (this.selected.size < this.max) {
        this.selected.set(id, t);
        this.candidates.delete(id);
        continue;
      }
      if (t - since < this.holdMs) continue;
      let victim: string | null = null;
      let oldest = Infinity;
      for (const [sid, last] of this.selected) {
        if (inTop.has(sid)) continue;
        if (last < oldest) {
          oldest = last;
          victim = sid;
        }
      }
      if (victim === null) continue;
      this.selected.delete(victim);
      this.selected.set(id, t);
      this.candidates.delete(id);
    }
    this.apply();
    if (this.candidates.size > 0) {
      const next = Math.min(...[...this.candidates.values()].map((since) => since + this.holdMs));
      this.timer = setTimeout(() => this.update(this.lastSpeakers), Math.max(1, next - this.now()));
    }
  }

  private apply(): void {
    const remotes = this.remotes();
    const everyone = remotes.length <= this.max;
    for (const p of remotes) {
      const pub = p.getTrackPublication(Track.Source.Microphone);
      if (!pub) continue;
      if (everyone || this.selected.has(p.identity)) {
        if (this.excluded.has(pub)) {
          if (!pub.isDesired) pub.setSubscribed(true);
          this.excluded.delete(pub);
        }
      } else if (pub.isDesired) {
        pub.setSubscribed(false);
        this.excluded.add(pub);
      }
    }
  }
}
