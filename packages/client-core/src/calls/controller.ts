// The worker's call controller (L-TS-56): who is in voice (step 7). The join, the keys, the leave, the pause and the
// rings come with task 6b.
import { CoreError, type CorePort, type Id } from '../core-port';
import { Op, voiceStateOf, type Frame } from '../gateway/frames';
import { fromHex } from '../hex';
import { CALL_IDLE, RINGS_EMPTY, type CallState, type SliceTypes, type VoiceParticipant } from '../state/types';
import { VoiceBook, type VoiceRoutes } from './voice';

export type CallRoutes = VoiceRoutes;

/** What the call controller reads from, and publishes through, the worker's composition root. */
export interface CallDeps {
  core(): CorePort | null;
  routes: CallRoutes;
  publish<K extends 'call' | 'voice' | 'rings'>(name: K, value: SliceTypes[K]): void;
  participant(userHex: string, deviceHex: string, flags: number): VoiceParticipant;
  voiceChannels(communityHex: string): string[];
  /** A known channel (any kind) or DM. */
  known(channelHex: string): boolean;
  /** A known voice channel's community, or a known DM (community null); undefined for anything else. */
  callTarget(channelHex: string): { communityId: string | null } | undefined;
  communityListed(communityHex: string): boolean;
}

/** A refusal of the call controller's own; the worker's error mapping reads its code. */
export class CallRefusal extends CoreError {}

export class CallController {
  private readonly book: VoiceBook;
  private state: CallState = CALL_IDLE;

  constructor(private readonly deps: CallDeps) {
    this.book = new VoiceBook({
      routes: deps.routes,
      publish: (value) => { deps.publish('voice', value); },
      participant: (user, device, flags) => deps.participant(user, device, flags),
      voiceChannels: (community) => deps.voiceChannels(community),
      known: (channel) => deps.known(channel),
    });
  }

  /** The three slices' initial values (L-TS-51), published when the worker is ready. */
  publishInitial(): void {
    this.deps.publish('call', this.state);
    this.deps.publish('voice', this.book.current());
    this.deps.publish('rings', RINGS_EMPTY);
  }

  /** loadVoice: exactly one id (the shape rules checked it); an unknown channel or community is refused. */
  async loadVoice(communityId: string | null, channelId: string | null): Promise<null> {
    if (channelId !== null) {
      if (this.deps.callTarget(channelId) === undefined) throw new CallRefusal('E_BAD_INPUT', 'unknown channel');
      await this.book.loadChannel(fromHex(channelId));
    } else if (communityId !== null) {
      if (!this.deps.communityListed(communityId)) throw new CallRefusal('E_BAD_INPUT', 'unknown community');
      await this.book.loadCommunity(fromHex(communityId));
    }
    return null;
  }

  /** A gateway frame of ops 50 and 53; a frame that does not read is dropped (L-GW-33). */
  onFrame(frame: Frame): void {
    if (frame.op !== Op.voiceState) return;
    let f;
    try { f = voiceStateOf(frame); } catch { return; }
    this.book.frame(f);
  }

  /** Everything this account's calls left in the worker goes with the account (wipe, release). */
  reset(): void {
    this.state = CALL_IDLE;
    this.book.clear();
    this.deps.publish('call', this.state);
    this.deps.publish('rings', RINGS_EMPTY);
  }

  /** The group ids this worker holds as call groups, for the paths that must leave them alone. */
  isCallGroup(groupId: Id): boolean {
    return this.deps.core()?.groupRow(groupId)?.kind === 1;
  }
}
