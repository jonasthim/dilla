import { arr, bin, decode, encode, u64 } from '../cbor';
import { CoreError, type ApplyResult, type CorePort, type ExpectedGroup, type GroupInfo, type Id } from '../core-port';
import { Op, type Frame } from '../gateway/frames';
import type { Gateway, GatewayEvent, ReadyInfo } from '../gateway/gateway';
import { toHex } from '../hex';
import { DillaHttpError } from '../http/errors';
import type { Instance, Routes } from '../http/routes';
import { openChannelFlow, resyncGroup, welcomeFrame, welcomeStep } from './channel';
import { SyncError } from './errors';
import { SerialQueues } from './group-queue';
import { JoinAll } from './joinall';
import type { SyncInternals } from './internals';
import { discardSend, drainOne, retrySend, sendMessage } from './send';

export type SyncRoutes = Pick<Routes, 'listChannels' | 'postGroup' | 'getGroupInfo' | 'getGroupTree' | 'getHandshakes' | 'getMessages'
  | 'getProposals' | 'postCommit' | 'postMessage' | 'postCursor' | 'postResync' | 'getWelcomes' | 'deleteWelcome' | 'getChannel'>;
export type SyncGateway = Pick<Gateway, 'subscribe' | 'commitAck'>;
export interface SyncDeps {
  core: CorePort; routes: SyncRoutes; gateway: SyncGateway; instance: Instance; deviceId: Id;
  now(): number; random(): number; setTimeout(fn: () => void, ms: number): number; clearTimeout(id: number): void;
  onGroupChanged(groupId: Id, result: ApplyResult): void; onOutboxChanged(groupId: Id): void;
  onMembership(groupId: Id, status: 'resyncing' | 'not-member'): void;
  onJoinAll(progress: { done: number; total: number; failed: number }): void;
  /** A Welcome for an unexpected group; the controller reloads DMs. */
  onUnexpectedWelcome(groupId: Id): void;
}
export const SYNC = {
  handshakePage: 512, messagePage: 256, commitRetryMax: 5, commitJitterMs: 400,
  membershipWaitMs: 2000, echoWaitMs: 5000, registerRetryMax: 3, cursorDebounceMs: 30000, joinAllConcurrency: 1, joinAllRetryMs: 60000,
} as const;
export interface PageInfo { count: number; lastSeq: bigint | null; }
export function throughOf(ms: PageInfo, hs: PageInfo, carry: bigint | null): bigint {
  const max = (a: bigint, b: bigint): bigint => a > b ? a : b;
  const m = ms.lastSeq;
  const h = hs.lastSeq;
  const boundM = ms.count === SYNC.messagePage ? (m ?? 0n) : max(m ?? 0n, carry ?? 0n);
  const boundH = hs.count === SYNC.handshakePage ? (h ?? 0n) : max(h ?? 0n, m ?? 0n);
  return boundM < boundH ? boundM : boundH;
}
const key = (g: Id): string => `g:${toHex(g)}`;
const HELD_MAX = 512;

export class SyncEngine implements SyncInternals {
  readonly queues = new SerialQueues();
  readonly echoWait = new Map<string, { msgHex: string; timer: number }>();
  readonly epochWait = new Map<string, number>();
  readonly count425 = new Map<string, number>();
  readonly reframedOnce = new Set<string>();
  readonly resyncTried = new Set<string>();
  readonly quiet = new Set<string>();
  private expectedList: ExpectedGroup[] = [];
  private readonly joinAll = new JoinAll(this, (p) => { this.deps.onJoinAll(p); });
  private readonly opened = new Map<string, ExpectedGroup>();
  private ready: ReadyInfo | null = null;
  private readonly held = new Map<string, Frame[]>();
  private readonly volunteer = new Map<string, number>();
  private readonly cursorTimer = new Map<string, number>();
  private readonly timers = new Set<number>();
  private readonly waiters = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private isStopped = false;

  constructor(readonly deps: SyncDeps) {}
  stopped(): boolean { return this.isStopped; }
  start(): void {
    if (this.unsubscribe !== null || this.isStopped) return;
    this.unsubscribe = this.deps.gateway.subscribe((e) => { this.onEvent(e); });
  }
  stop(): void {
    if (this.isStopped) return;
    this.joinAll.stop();
    this.isStopped = true;
    this.unsubscribe?.(); this.unsubscribe = null;
    for (const id of this.timers) this.deps.clearTimeout(id);
    this.timers.clear(); this.volunteer.clear(); this.cursorTimer.clear(); this.epochWait.clear(); this.echoWait.clear(); this.reframedOnce.clear();
    this.queues.clear();
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  /** Resolves after ms, or at once when the engine stops (its timers are cleared); the caller checks stopped(). */
  wait(ms: number): Promise<void> {
    if (this.isStopped) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = (): void => { this.waiters.delete(wake); resolve(); };
      this.waiters.add(wake);
      this.armTimer(ms, wake);
    });
  }
  setExpected(groups: ExpectedGroup[]): void {
    this.expectedList = [...groups];
    if (this.ready !== null && !this.isStopped) this.joinAll.request();
  }
  setChannels(channels: ExpectedGroup[]): void { this.setExpected(channels); }
  expected(): ExpectedGroup[] {
    const byId = new Map<string, ExpectedGroup>();
    for (const g of [...this.expectedList, ...this.opened.values()]) byId.set(toHex(g.groupId), g);
    return [...byId.values()];
  }
  addExpected(g: ExpectedGroup): void { this.opened.set(toHex(g.groupId), g); }
  row(g: Id): GroupInfo | undefined { return this.deps.core.groupRow(g) ?? undefined; }
  snapshot(g: Id): ApplyResult | null {
    const r = this.row(g);
    return r === undefined ? null : {
      state: r.state, epoch: r.epoch, nextSeq: r.nextSeq, newSeqs: [], proposalsPending: r.proposalsPending,
      epochChanged: false, ownAdopted: false,
    };
  }
  armTimer(ms: number, fn: () => void): number {
    const id = this.deps.setTimeout(() => { this.timers.delete(id); if (!this.isStopped) fn(); }, ms);
    this.timers.add(id);
    return id;
  }
  cancelTimer(id: number): void { this.deps.clearTimeout(id); this.timers.delete(id); }
  private onEvent(e: GatewayEvent): void {
    if (this.isStopped) return;
    if (e.type === 'ready') {
      this.ready = e.info; this.quiet.clear(); this.resyncTried.clear();
      for (const g of e.info.groups) if (g.proposalsOutstanding > 0 && this.row(g.groupId)?.state === 2) this.armVolunteer(g.groupId);
      void this.queues.run('w', async () => {
        try { await welcomeStep(this); } catch { /* later ready retries */ }
        if (this.isStopped) return;
        for (const g of this.deps.core.groups()) {
          if (g.state === 2) { this.requestCatchUp(g.groupId); this.requestDrain(g.groupId); }
          else if (g.state === 3 && !this.resyncTried.has(toHex(g.groupId))) {
            this.queues.coalesce(key(g.groupId), 'resync', async () => { await resyncGroup(this, g.groupId, false); });
          }
        }
        if (!this.isStopped) this.joinAll.request();
      }).catch(() => undefined);
      return;
    }
    if (e.type !== 'frame') return;
    const f = e.frame; const g = f.groupId;
    if (g === null || f.op === Op.epochChanged) return;
    if (f.op === Op.commitNeeded) {
      let round: bigint;
      try { round = u64(f.payload[3] ?? null); } catch { return; }
      if (this.row(g)?.state !== 2) return;
      this.deps.gateway.commitAck(g, round); this.disarmVolunteer(g); this.quiet.delete(toHex(g)); this.requestCommit(g, 0);
    } else if (f.op === Op.handshake || f.op === Op.messageCt) {
      void this.queues.run(key(g), () => this.frameJob(f)).catch(() => undefined);
    } else if (f.op === Op.messageDeleted) {
      void this.queues.run(key(g), () => this.deletedJob(f)).catch(() => undefined);
    } else if (f.op === Op.welcome) {
      void this.queues.run('w', () => welcomeFrame(this, f)).catch(() => undefined);
    }
  }
  private async frameJob(f: Frame): Promise<void> {
    const g = f.groupId;
    if (g === null || this.isStopped) return;
    const r = this.row(g);
    if (r === undefined || r.state === 3 || r.state === 4) return;
    if (r.state === 0 || r.state === 1) {
      const h = this.held.get(toHex(g)) ?? []; h.push(f); if (h.length > HELD_MAX) h.shift(); this.held.set(toHex(g), h); return;
    }
    let seq: bigint; let hs: Uint8Array; let ms: Uint8Array;
    try {
      if (f.op === Op.handshake) {
        const p = arr(f.payload, 5); seq = u64(p[0]); u64(p[1]); u64(p[2]);
        if (p[3] !== null) u64(p[3]);
        bin(p[4]); hs = encode([p]); ms = encode([]);
      } else {
        const p = arr(f.payload, 6); seq = u64(p[0]); u64(p[1]); bin(p[2], 16); bin(p[3]); bin(p[4], 32); u64(p[5]);
        hs = encode([]); ms = encode([[p[0]!, p[1]!, p[2]!, p[3]!, null, p[4]!, p[5]!, 0]]);
      }
    } catch { this.requestCatchUp(g); return; }
    if (seq < r.nextSeq) return;
    if (seq > r.nextSeq) { await this.catchUpNow(g, 'catch-up'); return; }
    try {
      const result = this.deps.core.groupApply(g, hs, ms, seq);
      await this.applyHook(g, result, 'frame');
      if (result.state === 2) this.armCursor(g);
    } catch (e) { if (e instanceof CoreError) this.requestCatchUp(g); else throw e; }
  }
  private async deletedJob(f: Frame): Promise<void> {
    await Promise.resolve();
    const g = f.groupId; if (g === null || this.isStopped) return;
    let seq: bigint;
    try { const p = arr(f.payload, 2); seq = u64(p[0]); u64(p[1]); } catch { return; }
    const row = this.row(g); if (row === undefined || row.state === 4) return;
    try {
      const result = this.deps.core.messageDeleted(g, seq);
      if (result.newSeqs.length > 0) this.deps.onGroupChanged(g, result);
    } catch (e) { if (!(e instanceof CoreError)) throw e; }
  }
  private armCursor(g: Id): void {
    const hex = toHex(g); if (this.cursorTimer.has(hex)) return;
    this.cursorTimer.set(hex, this.armTimer(SYNC.cursorDebounceMs, () => {
      this.cursorTimer.delete(hex);
      void this.queues.run(key(g), () => this.cursorStep(g)).catch(() => undefined);
    }));
  }
  private disarmCursor(g: Id): void {
    const h = toHex(g); const id = this.cursorTimer.get(h); if (id !== undefined) this.cancelTimer(id); this.cursorTimer.delete(h);
  }
  private async cursorStep(g: Id): Promise<void> {
    if (this.isStopped || this.row(g)?.state !== 2) return;
    try {
      const body = this.deps.core.cursorBody(g); if (body === null) return;
      const p = arr(decode(body), 2);
      await this.deps.routes.postCursor(g, body);
      if (!this.isStopped) this.deps.core.cursorAcked(g, u64(p[0]), u64(p[1]));
    } catch { /* next catch-up retries */ }
  }
  /**
   * Catches the group up to what the server holds. Resolves true only when it read the group to the end
   * with the group still active, so the caller may conclude that a row the server stored would have been
   * seen; false when it stopped early, met a refusal (HTTP layer retries spent, network down), or ended
   * in a resync, which restarts above the resync commit and can never see an earlier row (TS-01).
   */
  async catchUpNow(g: Id, source: 'catch-up' | 'commit'): Promise<boolean> {
    this.disarmCursor(g);
    let carry: bigint | null = null;
    try {
      for (;;) {
        if (this.isStopped) return false;
        const r = this.row(g); if (r?.state !== 2) return false;
        const from = r.nextSeq;
        const ms = await this.deps.routes.getMessages(g, from, SYNC.messagePage);
        if (this.isStopped) return false;
        const hs = await this.deps.routes.getHandshakes(g, from, SYNC.handshakePage);
        if (this.isStopped) return false;
        const through = throughOf(ms, hs, carry);
        if (through >= from) await this.applyHook(g, this.deps.core.groupApply(g, hs.raw, ms.raw, through), source);
        carry = hs.lastSeq;
        if (this.row(g)?.state !== 2) return false;
        if (ms.count < SYNC.messagePage && hs.count < SYNC.handshakePage && !(hs.lastSeq !== null && hs.lastSeq > through)) break;
      }
      await this.cursorStep(g);
      return true;
    } catch (e) {
      if ((this.membershipLost(g, e) || (e instanceof DillaHttpError && e.status === 410 && e.code === 'E_PRUNED'))
        && !this.resyncTried.has(toHex(g))) {
        await resyncGroup(this, g, false);
      }
      return false;
    }
  }
  /** A group read answering 404 E_NOT_FOUND for an active group: the device holds no leaf any more (a kick
   *  or a removal it never saw; protocol/02 invariant 5), which only an external join can repair. */
  private membershipLost(g: Id, e: unknown): boolean {
    return e instanceof DillaHttpError && e.status === 404 && e.code === 'E_NOT_FOUND' && this.row(g)?.state === 2;
  }
  async applyHook(g: Id, r: ApplyResult, source: 'frame' | 'catch-up' | 'commit'): Promise<void> {
    this.deps.onGroupChanged(g, r);
    const hex = toHex(g);
    if (r.ownAdopted) {
      const rows = this.deps.core.outbox(g);
      for (const id of this.count425.keys()) if (!rows.some((x) => toHex(x.msgId) === id)) this.count425.delete(id);
      for (const id of this.reframedOnce) {
        if (id.startsWith(`${hex}:`) && !rows.some((x) => `${hex}:${toHex(x.msgId)}` === id && x.state !== 2)) this.reframedOnce.delete(id);
      }
      this.deps.onOutboxChanged(g);
      const wait = this.echoWait.get(hex);
      if (wait !== undefined && !rows.some((x) => toHex(x.msgId) === wait.msgHex && x.state === 1)) {
        this.cancelTimer(wait.timer); this.echoWait.delete(hex); this.requestDrain(g);
      }
    }
    if (r.epochChanged) {
      const id = this.epochWait.get(hex);
      if (id !== undefined) { this.cancelTimer(id); this.epochWait.delete(hex); this.requestDrain(g); }
      else if (!this.echoWait.has(hex) && this.deps.core.outbox(g).some((x) => x.state === 0)) this.requestDrain(g);
    }
    if (r.state === 3 && !this.resyncTried.has(hex)) await resyncGroup(this, g, false);
    if (source !== 'commit' && r.state === 2) {
      if (r.proposalsPending > 0) this.armVolunteer(g); else this.disarmVolunteer(g);
    }
  }
  requestCatchUp(g: Id): void { if (!this.isStopped) this.queues.coalesce(key(g), 'catch-up', async () => { await this.catchUpNow(g, 'catch-up'); }); }
  requestDrain(g: Id): void { if (!this.isStopped) this.queues.coalesce(key(g), 'drain', () => drainOne(this, g)); }
  requestCommit(g: Id, attempt: number): void {
    if (!this.isStopped) this.queues.coalesce(key(g), 'commit', async () => { await this.commitNow(g, attempt); });
  }
  async commitNow(g: Id, attempt: number): Promise<boolean> {
    const row = this.row(g); if (row?.state !== 2 || this.isStopped) return false;
    let built = false;
    try {
      const proposals = await this.deps.routes.getProposals(g);
      if (this.isStopped) return false;
      const active = arr(decode(proposals)).some((x) => u64(arr(x, 5)[4]) === 0n);
      if (!active && row.proposalsPending === 0) return false;
      const body = this.deps.core.commitBuild(g, proposals); built = true;
      await this.deps.routes.postCommit(g, body);
      if (this.isStopped) return false;
      const result = this.deps.core.commitConfirm(g);
      await this.applyHook(g, result, 'commit');
      this.disarmVolunteer(g); this.quiet.delete(toHex(g)); this.requestDrain(g);
      return true;
    } catch (e) {
      if (built || e instanceof CoreError) {
        try { this.deps.core.commitAbort(g); } catch { /* no pending state */ }
      }
      if (e instanceof DillaHttpError) {
        if (e.status === 409 && e.code === 'E_COMMIT_CONFLICT') {
          await this.catchUpNow(g, 'commit');
          if ((this.row(g)?.proposalsPending ?? 0) > 0) {
            if (attempt < SYNC.commitRetryMax) this.armTimer(this.deps.random() * SYNC.commitJitterMs, () => this.requestCommit(g, attempt + 1));
            else this.quiet.add(toHex(g));
          }
        } else if (e.status === 425 || e.status === 422) {
          await this.catchUpNow(g, 'commit');
          if (e.status === 422) this.quiet.add(toHex(g));
        } else if (((e.status === 403 && e.code === 'E_LEAF_NOT_CURRENT') || this.membershipLost(g, e)) && !this.resyncTried.has(toHex(g))) {
          await resyncGroup(this, g, false);
        }
      }
      this.requestDrain(g);
      return false;
    }
  }
  private armVolunteer(g: Id): void {
    const hex = toHex(g); if (this.volunteer.has(hex) || this.quiet.has(hex)) return;
    const id = this.armTimer((this.ready?.backoffMs ?? 300) + this.deps.random() * (this.ready?.backoffJitterMs ?? 300), () => {
      this.volunteer.delete(hex); this.requestCommit(g, 0);
    });
    this.volunteer.set(hex, id);
  }
  private disarmVolunteer(g: Id): void {
    const hex = toHex(g); const id = this.volunteer.get(hex); if (id !== undefined) this.cancelTimer(id); this.volunteer.delete(hex);
  }
  async activate(g: Id): Promise<void> {
    const snap = this.snapshot(g); if (snap !== null) this.deps.onGroupChanged(g, snap);
    const frames = this.held.get(toHex(g)) ?? []; this.held.delete(toHex(g));
    const ordered: { frame: Frame; seq: bigint }[] = [];
    for (const frame of frames) {
      try { ordered.push({ frame, seq: u64(frame.payload[0] ?? null) }); }
      catch { this.requestCatchUp(g); }
    }
    ordered.sort((a, b) => a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);
    for (const { frame } of ordered) await this.frameJob(frame);
    this.requestCatchUp(g); this.requestDrain(g);
  }
  async pollWelcomes(): Promise<void> { await this.queues.run('w', () => welcomeStep(this)).catch(() => undefined); }
  openChannel(ch: { communityId: Id | null; channelId: Id; textGroupId: Id | null }): Promise<{ groupId: Id; state: 0 | 1 | 2 | 3 | 4 }> {
    if (this.isStopped) return Promise.reject(new SyncError('E_SYNC_STOPPED'));
    return this.queues.run(`c:${toHex(ch.channelId)}`, () => openChannelFlow(this, ch));
  }
  send(g: Id, text: string): Id { return sendMessage(this, g, text); }
  retry(msgId: Id): void { retrySend(this, msgId); }
  discard(msgId: Id): void { discardSend(this, msgId); }
}
export { SyncError } from './errors';
