// Incoming DM rings (L-TS-56 step 8, L-GW-33, decision 6, R1, R5, RV-4). The instance is the only sender of op 53, so
// every ring is checked against what this device knows: a DM or group DM it holds in its own list, a caller who is
// another participant of it, and no send block on the DM's text group or on its call group (decision 4 extended to
// rings). A ring lasts 30 s from its arrival here whatever the instance says (and whatever this page's clock says of its
// expires_ts), one per channel, at most eight.
import type { CallRingFrame } from '../gateway/frames';
import { toHex } from '../hex';
import type { Ring, RingsState } from '../state/types';

/** R5: a ring lasts 30 s from its arrival at the latest. */
export const RING_MS = 30_000;
/** RV-4: at most eight concurrent rings per client. */
export const RINGS_MAX = 8;

export interface RingDeps {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  publish(rings: RingsState): void;
  ownUser(): string | null;
  /** The participants (user hex, the own user included) of a DM or group DM this device knows; undefined otherwise. */
  dmMembers(channelHex: string): readonly string[] | undefined;
  /** Whether the DM's text group, or its call group when this device holds it, is send-blocked. */
  blocked(channelHex: string): boolean;
  /** This device is in a call (in, joining or paused): no sound, no notification. */
  busy(): boolean;
  /** The DM is muted (mute.channel.<id>): the banner only (R1). */
  quiet(channelHex: string): boolean;
  nameOf(userHex: string): string;
}

export class Rings {
  private rings: Ring[] = [];
  private readonly timers = new Map<string, number>();

  constructor(private readonly deps: RingDeps) {}

  list(): RingsState { return this.rings; }

  /** op 53 states 1 (ringing) and 0 (over). State 2 belongs to the caller's side (the call controller). */
  frame(f: CallRingFrame): void {
    const channel = toHex(f.channelId);
    if (f.state === 0) {
      const callId = toHex(f.callId);
      if (this.rings.some((r) => r.channelId === channel && r.callId === callId)) this.remove(channel);
      return;
    }
    if (f.state !== 1) return;
    // Attacker: an instance ringing in the name of a channel this person does not share with the caller, or as themself.
    const members = this.deps.dmMembers(channel);
    const caller = toHex(f.userId);
    if (members === undefined || caller === this.deps.ownUser() || !members.includes(caller)) return;
    // Decision 4 extended to rings: a send-blocked DM gets no ring entry at all (an earlier one goes too).
    if (this.deps.blocked(channel)) { this.remove(channel); return; }
    const existing = this.rings.findIndex((r) => r.channelId === channel);
    if (existing < 0 && this.rings.length >= RINGS_MAX) return;
    // f10app m8: the same ring again (its call and expires_ts unchanged) keeps its first arrival's 30 s and its timer.
    const same = existing >= 0 && this.rings[existing].callId === toHex(f.callId) && this.rings[existing].ringTs === f.expiresTs;
    if (same) return;
    const now = this.deps.now();
    const ring: Ring = {
      // Web-3 task 10, concern 5: expires_ts is a second on the instance's clock, never compared with this page's (a page
      // clock 30 s ahead would see every ring over on arrival). State 1 is sent once, when the ring starts (never persisted
      // or replayed: 02 § call_ring), so the ring's 30 s run from its arrival here; the instance's state 0 ends it sooner.
      // expires_ts stays the ring's identity for the decline (ringTs).
      callId: toHex(f.callId), channelId: channel, callerUser: caller, callerName: this.deps.nameOf(caller), ringTs: f.expiresTs,
      expiresAt: now + RING_MS, busy: this.deps.busy(), quiet: this.deps.quiet(channel),
    };
    this.rings = existing < 0 ? [...this.rings, ring] : this.rings.map((r, i) => (i === existing ? ring : r));
    this.arm(ring);
    this.deps.publish(this.rings);
  }

  /** The ring of a channel ends (answered here, declined, or its call joined). */
  remove(channelHex: string): void {
    const timer = this.timers.get(channelHex);
    if (timer !== undefined) { this.deps.clearTimeout(timer); this.timers.delete(channelHex); }
    if (!this.rings.some((r) => r.channelId === channelHex)) return;
    this.rings = this.rings.filter((r) => r.channelId !== channelHex);
    this.deps.publish(this.rings);
  }

  /** The ring a decline answers: its call and its expires_ts both match (a later ring of the same DM stays). */
  removeCall(callHex: string, ringTs: number): void {
    for (const r of this.rings.filter((x) => x.callId === callHex && x.ringTs === ringTs)) this.remove(r.channelId);
  }

  clear(): void {
    for (const timer of this.timers.values()) this.deps.clearTimeout(timer);
    this.timers.clear();
    this.rings = [];
    this.deps.publish(this.rings);
  }

  /** A local timer ends the ring at expiresAt when no state 0 arrives (R5). */
  private arm(ring: Ring): void {
    const previous = this.timers.get(ring.channelId);
    if (previous !== undefined) this.deps.clearTimeout(previous);
    this.timers.set(ring.channelId, this.deps.setTimeout(() => {
      this.timers.delete(ring.channelId);
      if (this.rings.some((r) => r.channelId === ring.channelId && r.ringTs === ring.ringTs)) this.remove(ring.channelId);
    }, Math.max(0, ring.expiresAt - this.deps.now())));
  }
}
