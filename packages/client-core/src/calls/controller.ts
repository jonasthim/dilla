// The worker's call controller (L-TS-56, L-TS-57): it joins, keys, leaves, pauses and rotates this device's call, keeps
// who is in voice (step 7) and the incoming DM rings (step 8). Every key, the join epoch's included, leaves the worker
// only as a `callKeys` push with its buffer transferred (L-TS-52); no command result and no slice carries a key byte.
import { CoreError, isTrustBlock, type ApplyResult, type CallMediaEpoch, type CorePort, type Id } from '../core-port';
import { callRingOf, Op, voiceStateOf, type Frame } from '../gateway/frames';
import { fromHex, toHex } from '../hex';
import { DillaHttpError } from '../http/errors';
import type { CallStats, Routes } from '../http/routes';
import { isMuted } from '../state/settings';
import { CALL_IDLE, type CallJoinResult, type CallKeys, type CallPhase, type CallState, type SliceTypes,
  type VoiceParticipant, type WorkerError } from '../state/types';
import type { FromWorker } from '../worker/protocol';
import { joinCall, JoinRefused, type JoinRoutes } from './join';
import { Rings } from './ring';
import { VoiceBook, type VoiceRoutes } from './voice';

/** L-TS-56 step 5: a fresh leaf secret every hour of a call, and a conflicted rotation tried again a minute later. */
export const CALL_ROTATE_MS = 3_600_000;
export const CALL_ROTATE_RETRY_MS = 60_000;
/** L-TS-56 step 1: the list refresh of a call's pending leaves waits at most this long for the whole batch. */
export const WAIT_LIST_MS = 10_000;

export type CallRoutes = VoiceRoutes & JoinRoutes & Pick<Routes, 'shareCall' | 'unshareCall' | 'postCallStats' | 'postProposal'
  | 'declineCall' | 'postCommit'>;

/** What the call controller reads from, and publishes through, the worker's composition root. */
export interface CallDeps {
  core(): CorePort | null;
  routes: CallRoutes;
  post(message: FromWorker, transfer: Transferable[]): void;
  publish<K extends 'call' | 'voice' | 'rings'>(name: K, value: SliceTypes[K]): void;
  errorOf(e: unknown): WorkerError;
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  randomId(): Id;
  me(): { userId: Id; deviceId: Id } | null;
  instance(): { policyVersion: bigint; externalSenderPub: Uint8Array } | null;
  settings(): Record<string, string>;
  nameOf(userHex: string): string;
  participant(userHex: string, deviceHex: string, flags: number): VoiceParticipant;
  voiceChannels(communityHex: string): string[];
  /** A known channel (any kind) or DM. */
  known(channelHex: string): boolean;
  /** A known voice channel's community, or a known DM (community null, with its participants); undefined otherwise. */
  callTarget(channelHex: string): { communityId: string | null; members: string[] } | undefined;
  communityListed(communityHex: string): boolean;
  /** The worker's trust refresh of a group's leaves (the existing one, L-TS-56: no second implementation). */
  refreshLeaves(groupId: Id): Promise<void>;
  /** Runs a job on the sync engine's lane of the group, so a rotation never interleaves with an apply. */
  serial(groupId: Id, job: () => Promise<void>): Promise<void>;
  /** An own commit of a call group (the rotation) was confirmed: reported like any other group change. */
  onCommitted(groupId: Id, result: ApplyResult): void;
  /** After a join's answer: the engine takes the group up (held frames, catch-up). */
  afterJoin(groupId: Id): void;
  track(job: Promise<unknown>): void;
}

/** A refusal of the call controller's own; the worker's error mapping reads its code. */
export class CallRefusal extends CoreError {}

interface Live {
  channel: string; channelId: Id; dm: boolean; members: string[]; groupId: Id; callId: Id; vdec: string;
  postedEpoch: bigint; leaving: boolean; outgoing: { ringing: string[]; declined: string[] } | null;
}

const IN_A_CALL: readonly CallPhase[] = ['joining', 'in', 'paused', 'leaving'];

export class CallController {
  private readonly book: VoiceBook;
  private readonly rings: Rings;
  private state: CallState = CALL_IDLE;
  private live: Live | null = null;
  private rotateTimer: number | null = null;

  constructor(private readonly deps: CallDeps) {
    this.book = new VoiceBook({
      routes: deps.routes,
      publish: (value) => { deps.publish('voice', value); },
      participant: (user, device, flags) => deps.participant(user, device, flags),
      voiceChannels: (community) => deps.voiceChannels(community),
      known: (channel) => deps.known(channel),
    });
    this.rings = new Rings({
      now: () => deps.now(), setTimeout: (fn, ms) => deps.setTimeout(fn, ms), clearTimeout: (id) => { deps.clearTimeout(id); },
      publish: (rings) => { deps.publish('rings', rings); },
      ownUser: () => { const me = deps.me(); return me === null ? null : toHex(me.userId); },
      dmMembers: (channel) => { const t = deps.callTarget(channel); return t === undefined || t.communityId !== null ? undefined : t.members; },
      blocked: (channel) => this.channelBlocked(channel),
      busy: () => IN_A_CALL.includes(this.state.phase),
      quiet: (channel) => isMuted(deps.settings(), channel),
      nameOf: (user) => deps.nameOf(user),
    });
  }

  /** The three slices' initial values (L-TS-51), published when the worker is ready. */
  publishInitial(): void {
    this.deps.publish('call', this.state);
    this.deps.publish('voice', this.book.current());
    this.deps.publish('rings', this.rings.list());
  }

  // ---- step 1: the join ----

  async join(channel: string, vdec: string): Promise<CallJoinResult> {
    const target = this.deps.callTarget(channel);
    if (target === undefined) throw new CallRefusal('E_BAD_INPUT', 'not a voice channel or a DM');
    if (!(['idle', 'blocked', 'removed', 'failed'] as CallPhase[]).includes(this.state.phase)) throw new CallRefusal('E_CALL_ACTIVE', '');
    const core = this.deps.core();
    const instance = this.deps.instance();
    if (core === null || instance === null) throw new CallRefusal('E_NOT_READY', '');
    const dm = target.communityId === null;
    // Decision 4: a DM call is refused while the DM's text group is send-blocked, before anything reaches the instance.
    if (dm) {
      const text = this.textGroup(channel);
      const code = text === null ? null : core.sendBlockCode(text);
      if (code !== null) {
        this.setState({ ...CALL_IDLE, phase: 'blocked', channelId: channel, error: this.deps.errorOf(new CallRefusal(code, '')),
          changedUser: code === 'E_UMK_CHANGED' ? this.changedUser(text === null ? [] : [text], target.members) : null });
        throw new CallRefusal(code, '');
      }
    }
    this.setState({ ...CALL_IDLE, phase: 'joining', channelId: channel });
    const channelId = fromHex(channel);
    let joined;
    try {
      joined = await joinCall({
        core, routes: this.deps.routes, policyVersion: instance.policyVersion, externalSenderPub: instance.externalSenderPub,
        randomId: () => this.deps.randomId(), refreshLeaves: (g) => this.deps.refreshLeaves(g),
      }, { channelId, communityId: target.communityId === null ? null : fromHex(target.communityId), vdec });
    } catch (e) {
      const cause = e instanceof JoinRefused ? e.cause : e;
      if (e instanceof JoinRefused && e.leave !== null) await this.leaveGroup(e.leave);
      const phase = e instanceof JoinRefused ? e.phase : 'failed';
      const code = this.deps.errorOf(cause).code;
      this.setState({ ...CALL_IDLE, phase, channelId: channel, error: this.deps.errorOf(cause),
        changedUser: code === 'E_UMK_CHANGED' ? this.changedUser([], target.members) : null });
      throw cause;
    }
    const { groupId, media, started } = joined;
    const own = toHex(this.deps.me()?.userId ?? new Uint8Array(16));
    const others = target.members.filter((u) => u !== own);
    const outgoing = dm && started.created ? { ringing: others.filter((u) => !this.book.usersIn(channel).has(u)), declined: [] } : null;
    this.live = { channel, channelId, dm, members: target.members, groupId, callId: started.callId, vdec, postedEpoch: media.epoch,
      leaving: false, outgoing };
    // The join epoch's key: a push posted before this command's ret, its buffer transferred (L-TS-52).
    this.postKeys(this.live, media);
    this.setIn(media);
    this.rings.remove(channel);
    this.armRotation(CALL_ROTATE_MS);
    this.deps.afterJoin(groupId);
    return { callId: toHex(started.callId), groupId: toHex(groupId), livekitUrl: started.livekitUrl, token: started.token,
      iceServers: started.iceServers, caps: started.caps, epoch: media.epoch.toString() };
  }

  // ---- step 2: the keys of later epochs ----

  /** A batch applied in a group: for the call group, a new epoch is keyed, and a gone own leaf is phase removed. */
  onGroupChanged(groupId: Id, result: ApplyResult): void {
    const live = this.live;
    if (live === null || toHex(live.groupId) !== toHex(groupId)) return;
    if (result.state === 4) {
      if (live.leaving) return;
      // Step 3: the own leaf is gone (another member committed its Remove).
      this.stopRotation();
      this.live = null;
      this.setState({ ...CALL_IDLE, phase: 'removed', channelId: live.channel });
      return;
    }
    if (result.epochChanged) this.rekey(true);
  }

  /** After every trust refresh: a pause may end (the changed contact verified), a pending leaf may now validate, and a
   *  block the refresh found mid-epoch is acted on. */
  onTrust(): void { this.rekey(false); }

  private rekey(fromEpoch: boolean): void {
    const live = this.live;
    const core = this.deps.core();
    // The block check: a device that is leaving, blocked or paused-and-refused posts no key.
    if (live === null || core === null || live.leaving || (this.state.phase !== 'in' && this.state.phase !== 'paused')) return;
    let media: CallMediaEpoch;
    try {
      media = core.callMediaEpoch(live.groupId);
    } catch (e) {
      const code = e instanceof CoreError ? e.code : 'E_INTERNAL';
      // A pending leaf: no key until a refresh validates it (the refresh ends in onTrust, which keys then).
      if (code === 'E_DEVICE_LIST_STALE') { if (fromEpoch) this.deps.track(this.deps.refreshLeaves(live.groupId)); return; }
      // RV-3: a changed identity pauses this device; it stays in the call group and the room.
      if (code === 'E_UMK_CHANGED') {
        const text = live.dm ? this.textGroup(live.channel) : null;
        this.setState({ ...this.state, phase: 'paused', error: this.deps.errorOf(e),
          changedUser: this.changedUser(text === null ? [live.groupId] : [live.groupId, text], live.members) });
        return;
      }
      // Any other gate refusal (unlisted, credential, tier, binding): blocked, and the device leaves.
      if (isTrustBlock(code)) {
        this.setState({ ...this.state, phase: 'blocked', error: this.deps.errorOf(e), changedUser: null });
        this.deps.track(this.leave(true));
      }
      return;
    }
    if (media.epoch === live.postedEpoch) {
      // The page holds this epoch's key already; nothing is posted, and a pause on it ends.
      new Uint8Array(media.baseKey).fill(0);
      if (this.state.phase === 'paused') this.setIn(media);
      return;
    }
    live.postedEpoch = media.epoch;
    this.postKeys(live, media);
    this.setIn(media);
  }

  private postKeys(live: Live, media: CallMediaEpoch): void {
    const keys: CallKeys = { groupId: toHex(live.groupId), epoch: media.epoch.toString(), baseKey: media.baseKey, selfLeaf: media.ownLeaf,
      roster: media.roster.map((r) => ({ leaf: r.leaf, deviceId: toHex(r.deviceId), userId: toHex(r.userId) })) };
    this.deps.post({ t: 'callKeys', callId: toHex(live.callId), keys }, [media.baseKey]);
  }

  private setIn(media: CallMediaEpoch): void {
    const live = this.live;
    if (live === null) return;
    this.setState({ phase: 'in', channelId: live.channel, callId: toHex(live.callId), epoch: media.epoch.toString(), code: media.code,
      error: null, roster: media.roster.map((r) => ({ userId: toHex(r.userId), deviceId: toHex(r.deviceId), leaf: r.leaf })),
      outgoing: this.outgoingNames(live), changedUser: null });
  }

  // ---- step 4: the leave ----

  async leave(blocked = false): Promise<null> {
    const live = this.live;
    if (live === null) {
      if (this.state.phase !== 'joining' && !blocked) this.setState({ ...CALL_IDLE });
      return null;
    }
    // Never a rotation after this point: call_rotate would cancel the posted self-Remove (task 5, progress note).
    live.leaving = true;
    this.stopRotation();
    if (!blocked) this.setState({ ...this.state, phase: 'leaving' });
    await this.leaveGroup(live.groupId);
    if (this.live === live) this.live = null;
    this.setState(blocked ? { ...this.state, phase: 'blocked' } : { ...CALL_IDLE });
    return null;
  }

  /** The self-Remove (a 409 E_REMOVE_PENDING is fine, any failure leaves the group to the instance) and the forget. */
  private async leaveGroup(groupId: Id): Promise<void> {
    const core = this.deps.core();
    if (core === null) return;
    try { await this.deps.routes.postProposal(groupId, core.callLeaveProposal(groupId)); }
    catch { /* E_REMOVE_PENDING, or the instance removes the leaf when the call ends */ }
    try { core.callGroupForget(groupId); } catch { /* forgotten already */ }
  }

  // ---- step 5: the rotation ----

  private armRotation(ms: number): void {
    this.stopRotation();
    this.rotateTimer = this.deps.setTimeout(() => { this.rotateTimer = null; this.deps.track(this.rotate()); }, ms);
  }

  private stopRotation(): void {
    if (this.rotateTimer !== null) { this.deps.clearTimeout(this.rotateTimer); this.rotateTimer = null; }
  }

  private async rotate(): Promise<void> {
    const live = this.live;
    const core = this.deps.core();
    if (live === null || core === null || live.leaving) return;
    // RV-3: while paused nothing is sent; the rotation waits for the next tick.
    if (this.state.phase === 'paused') { this.armRotation(CALL_ROTATE_MS); return; }
    if (this.state.phase !== 'in') return;
    await this.deps.serial(live.groupId, async () => {
      if (this.live !== live || live.leaving) return;
      let body: Uint8Array;
      try { body = core.callRotate(live.groupId); }
      catch { this.armRotation(CALL_ROTATE_RETRY_MS); return; }
      try {
        await this.deps.routes.postCommit(live.groupId, body);
      } catch {
        try { core.commitAbort(live.groupId); } catch { /* nothing pending */ }
        if (this.live === live && !live.leaving) this.armRotation(CALL_ROTATE_RETRY_MS);
        return;
      }
      const result = core.commitConfirm(live.groupId);
      if (this.live === live && !live.leaving) this.armRotation(CALL_ROTATE_MS);
      this.deps.onCommitted(live.groupId, result);
    });
  }

  // ---- step 6: share, refresh, stats ----

  async share(on: boolean): Promise<null> {
    const live = this.requireLive();
    if (on && this.state.phase === 'paused') throw new CallRefusal('E_UNAVAILABLE', 'paused');
    if (on) await this.deps.routes.shareCall(live.callId); else await this.deps.routes.unshareCall(live.callId);
    return null;
  }

  async refresh(): Promise<{ token: string; iceServers: CallJoinResult['iceServers'] }> {
    const live = this.requireLive();
    const started = await this.deps.routes.startCall(live.channelId, live.vdec);
    return { token: started.token, iceServers: started.iceServers };
  }

  async stats(report: CallStats): Promise<null> {
    const live = this.requireLive();
    try { await this.deps.routes.postCallStats(live.callId, report); }
    catch (e) { if (!(e instanceof DillaHttpError && e.status === 429)) throw e; }
    return null;
  }

  private requireLive(): Live {
    if (this.live === null || this.live.leaving) throw new CallRefusal('E_NO_CALL', '');
    return this.live;
  }

  // ---- steps 7 and 8: voice presence and rings ----

  /** loadVoice: exactly one id (the shape rules checked it); an unknown channel or community is refused. */
  async loadVoice(communityId: string | null, channelId: string | null): Promise<null> {
    if (channelId !== null) {
      if (this.deps.callTarget(channelId) === undefined) throw new CallRefusal('E_BAD_INPUT', 'unknown channel');
      await this.book.loadChannel(fromHex(channelId));
    } else if (communityId !== null) {
      if (!this.deps.communityListed(communityId)) throw new CallRefusal('E_BAD_INPUT', 'unknown community');
      await this.book.loadCommunity(fromHex(communityId));
    }
    this.shrinkRinging();
    return null;
  }

  /** callDecline: the ring goes here whatever the instance answers (a 404 is expected after the ring ended). */
  async decline(callId: string, ringTs: number): Promise<null> {
    this.rings.removeCall(callId);
    try { await this.deps.routes.declineCall(fromHex(callId), ringTs); }
    catch (e) { if (!(e instanceof DillaHttpError)) throw e; }
    return null;
  }

  /** A gateway frame of ops 50 and 53; a frame that does not read is dropped (L-GW-33). */
  onFrame(frame: Frame): void {
    if (frame.op === Op.voiceState) {
      let f;
      try { f = voiceStateOf(frame); } catch { return; }
      this.book.frame(f);
      this.shrinkRinging();
      return;
    }
    if (frame.op !== Op.callRing) return;
    let f;
    try { f = callRingOf(frame); } catch { return; }
    if (f.state !== 2) { this.rings.frame(f); return; }
    // State 2: a participant declined the call this device opened (R7).
    const live = this.live;
    const user = toHex(f.userId);
    if (live?.outgoing == null || live.channel !== toHex(f.channelId) || !live.members.includes(user)
      || user === toHex(this.deps.me()?.userId ?? new Uint8Array(16))) return;
    live.outgoing = { ringing: live.outgoing.ringing.filter((u) => u !== user),
      declined: live.outgoing.declined.includes(user) ? live.outgoing.declined : [...live.outgoing.declined, user] };
    this.setState({ ...this.state, outgoing: this.outgoingNames(live) });
  }

  private shrinkRinging(): void {
    const live = this.live;
    if (live?.outgoing == null) return;
    const inCall = this.book.usersIn(live.channel);
    const ringing = live.outgoing.ringing.filter((u) => !inCall.has(u));
    if (ringing.length === live.outgoing.ringing.length) return;
    live.outgoing = { ...live.outgoing, ringing };
    this.setState({ ...this.state, outgoing: this.outgoingNames(live) });
  }

  // ---- step 9: resign and wipe ----

  /** resign: the call is left (its self-Remove posted) and the rings cleared before the store is released. */
  async shutdown(): Promise<void> {
    try { await this.leave(); } catch { /* the instance removes the leaf when the call ends */ }
    this.rings.clear();
    this.setState({ ...CALL_IDLE });
  }

  /** Everything this account's calls left in the worker goes with the account (wipe, release); nothing is sent. */
  reset(): void {
    this.stopRotation();
    this.live = null;
    this.state = CALL_IDLE;
    this.rings.clear();
    this.book.clear();
    this.deps.publish('call', this.state);
  }

  isCallGroup(groupId: Id): boolean {
    return this.deps.core()?.groupRow(groupId)?.kind === 1;
  }

  // ---- helpers ----

  private setState(next: CallState): void {
    this.state = next;
    this.deps.publish('call', next);
  }

  private outgoingNames(live: Live): CallState['outgoing'] {
    return live.outgoing === null ? null
      : { ringing: live.outgoing.ringing.map((u) => this.deps.nameOf(u)), declined: live.outgoing.declined.map((u) => this.deps.nameOf(u)) };
  }

  /** The active text group of a DM (kind 0), never its call group (L-CORE-51). */
  private textGroup(channel: string): Id | null {
    return this.deps.core()?.groups().find((g) => g.kind === 0 && g.state === 2 && toHex(g.targetId) === channel)?.groupId ?? null;
  }

  /** A ring's decision 4: the DM's text group, or its call group when this device holds it, is send-blocked. */
  private channelBlocked(channel: string): boolean {
    const core = this.deps.core();
    if (core === null) return true;
    for (const g of core.groups()) {
      if (g.state !== 2 || toHex(g.targetId) !== channel) continue;
      try { if (core.sendBlockCode(g.groupId) !== null) return true; } catch { return true; }
    }
    return false;
  }

  /** Ruling I2: the changed contact, the first by user id: a changed leaf of the groups in question, else a contact among
   *  the candidates (the DM's participants) whose key changed. */
  private changedUser(groups: readonly Id[], candidates: readonly string[]): string | null {
    const core = this.deps.core();
    const me = this.deps.me();
    if (core === null) return null;
    const own = me === null ? '' : toHex(me.userId);
    const inGroups = new Set(groups.map(toHex));
    try {
      const leaves = core.pendingLeaves().filter((l) => l.reason === 'changed' && inGroups.has(toHex(l.groupId)))
        .map((l) => toHex(l.userId)).filter((u) => u !== own).sort();
      if (leaves.length > 0) return leaves[0] ?? null;
      const rows = core.trustState().filter((r) => r.changedUmk !== null || r.blocked === 'E_UMK_CHANGED').map((r) => toHex(r.userId))
        .filter((u) => u !== own && (candidates.length === 0 || candidates.includes(u))).sort();
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }
}
