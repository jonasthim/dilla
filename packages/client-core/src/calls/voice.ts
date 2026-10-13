// Who is in voice (L-GW-32, L-TS-56 step 7): the snapshot of L-HTTP-100 or 101 first, then the voice_state frames
// received while that read was in flight, in arrival order. A frame for a device the snapshot does not list adds it;
// flags 0 removes it. The slice is advisory presence only (02 § voice_state): it never decides who may join or publish.
import type { VoiceStateFrame } from '../gateway/frames';
import { toHex } from '../hex';
import type { CallParticipant, Routes } from '../http/routes';
import type { Id } from '../core-port';
import type { VoiceParticipant, VoiceState } from '../state/types';

export type VoiceRoutes = Pick<Routes, 'getChannelCall' | 'getCommunityCalls'>;

export interface VoiceDeps {
  routes: VoiceRoutes;
  publish(state: VoiceState): void;
  /** The slice row of one device in a channel's call: its name, and the own, web and bot marks from the worker's badge
   *  sources. */
  participant(userHex: string, deviceHex: string, flags: number, channelHex: string): VoiceParticipant;
  /** The voice channels of a community this worker knows (hex), so a community read can drop calls that ended. */
  voiceChannels(communityHex: string): string[];
  /** Whether a channel or DM is known here: a frame for a call no snapshot named lands in the channel of its id. */
  known(channelHex: string): boolean;
}

/** Review M5: the instance alone sends voice_state, so the book holds at most this many devices per call (the snapshot
 *  decoder's bound, L-TS-55) and keeps at most this many frames per read in flight. */
export const VOICE_MAX = 1024;

/** A read in flight; `overflow` once more frames arrived during it than it keeps: its snapshot is then older than what the
 *  frames already showed, so the live state stands and the snapshot is not placed. */
interface Read { channels: Set<string> | 'community'; community: string | null; frames: VoiceStateFrame[]; overflow: boolean }

export class VoiceBook {
  private state: VoiceState = {};
  private readonly reads = new Set<Read>();

  constructor(private readonly deps: VoiceDeps) {}

  current(): VoiceState { return this.state; }

  /** One channel's call (L-HTTP-100). */
  async loadChannel(channelId: Id): Promise<void> {
    const channel = toHex(channelId);
    const read: Read = { channels: new Set([channel]), community: null, frames: [], overflow: false };
    this.reads.add(read);
    try {
      const snap = await this.deps.routes.getChannelCall(channelId);
      if (read.overflow) return;
      this.place(channel, snap.callId === null ? null : toHex(snap.callId), snap.participants);
      this.replay(read);
    } finally {
      this.reads.delete(read);
    }
  }

  /** Every live call of a community's voice channels (L-HTTP-101); a known voice channel it does not list has none. */
  async loadCommunity(communityId: Id): Promise<void> {
    const community = toHex(communityId);
    const read: Read = { channels: 'community', community, frames: [], overflow: false };
    this.reads.add(read);
    try {
      const calls = await this.deps.routes.getCommunityCalls(communityId);
      if (read.overflow) return;
      const listed = new Set<string>();
      for (const call of calls) {
        const channel = toHex(call.channelId);
        listed.add(channel);
        this.place(channel, toHex(call.callId), call.participants, false);
      }
      for (const channel of this.deps.voiceChannels(community)) if (!listed.has(channel)) this.drop(channel, false);
      read.channels = new Set([...listed, ...this.deps.voiceChannels(community)]);
      this.deps.publish(this.state);
      this.replay(read);
    } finally {
      this.reads.delete(read);
    }
  }

  /** A voice_state frame: applied now, and kept for every read in flight, which applies it again after its snapshot. */
  frame(f: VoiceStateFrame): void {
    for (const read of this.reads) {
      if (read.frames.length >= VOICE_MAX) read.overflow = true;
      else read.frames.push(f);
    }
    if (this.apply(f)) this.deps.publish(this.state);
  }

  /** The users the snapshot and the frames show in a channel's call, by user hex. */
  usersIn(channelHex: string): Set<string> {
    return new Set((this.state[channelHex]?.participants ?? []).map((p) => p.userId));
  }

  /** The member lists changed (web-3 task 10, concern 4): every row is built again, so a participant the lists lacked
   *  when the row was made is named now; published only when a row changed. */
  renamed(): void {
    let changed = false;
    const next: VoiceState = {};
    for (const [channel, call] of Object.entries(this.state)) {
      const participants = call.participants.map((p) => {
        const row = this.deps.participant(p.userId, p.deviceId, p.flags, channel);
        if (row.name === p.name) return p;
        changed = true;
        return row;
      });
      next[channel] = { ...call, participants };
    }
    if (!changed) return;
    this.state = next;
    this.deps.publish(this.state);
  }

  clear(): void {
    this.reads.clear();
    this.state = {};
    this.deps.publish(this.state);
  }

  private replay(read: Read): void {
    let changed = false;
    for (const f of read.frames) {
      const channel = this.channelOf(toHex(f.callId));
      if (channel === null || (read.channels !== 'community' && !read.channels.has(channel))) continue;
      if (this.apply(f)) changed = true;
    }
    if (changed) this.deps.publish(this.state);
  }

  private place(channel: string, callId: string | null, participants: readonly CallParticipant[], publish = true): void {
    if (callId === null || participants.length === 0) this.drop(channel, false);
    else {
      this.state = { ...this.state, [channel]: { callId, participants: sorted(participants.slice(0, VOICE_MAX).map((p) =>
        this.deps.participant(toHex(p.userId), toHex(p.deviceId), p.flags, channel))) } };
    }
    if (publish) this.deps.publish(this.state);
  }

  private drop(channel: string, publish: boolean): void {
    if (!(channel in this.state)) return;
    const next = { ...this.state };
    delete next[channel];
    this.state = next;
    if (publish) this.deps.publish(this.state);
  }

  /** The channel a frame's call belongs to: the one whose call it is, else the channel of that id (a call id is its
   *  channel's id, 09 § Voice); null for a call of a channel this worker does not know. */
  private channelOf(callHex: string): string | null {
    for (const [channel, call] of Object.entries(this.state)) if (call.callId === callHex) return channel;
    return this.deps.known(callHex) ? callHex : null;
  }

  private apply(f: VoiceStateFrame): boolean {
    const callHex = toHex(f.callId);
    const channel = this.channelOf(callHex);
    if (channel === null) return false;
    const user = toHex(f.userId);
    const device = toHex(f.deviceId);
    const before = this.state[channel]?.participants ?? [];
    const rest = before.filter((p) => p.deviceId !== device);
    // Review M5: a device beyond the bound is not added (one already listed is still updated or removed).
    if (f.flags !== 0 && rest.length === before.length && rest.length >= VOICE_MAX) return false;
    const next = f.flags === 0 ? rest : sorted([...rest, this.deps.participant(user, device, f.flags, channel)]);
    if (next.length === 0) { const had = channel in this.state; this.drop(channel, false); return had; }
    this.state = { ...this.state, [channel]: { callId: this.state[channel]?.callId ?? callHex, participants: next } };
    return true;
  }
}

function sorted(rows: VoiceParticipant[]): VoiceParticipant[] {
  return rows.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
}
