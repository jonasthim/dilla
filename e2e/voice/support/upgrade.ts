// UP9 (calls survive an upgrade): what upgrade.spec.ts reads besides the voice suite's own helpers. Page-side recorders that
// keep a history (every `call` and `connection` slice, every join's answer, every peer connection, each with its time), a
// sampler inside each media worker that times inbound frames per device, the SFU's own participant list (LiveKit's
// RoomService with the sidecar's key), and the instance database read-only (node:sqlite) for the call group's rows.
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { mediaWorkers } from './peer-browser';

// ---------------------------------------------------------------------------------------------------
// Page-side history.

export interface CallMark { at: number; phase: string; epoch: string | null; code: string | null; error: string | null; rejoining: boolean }
export interface UpgradeRecord {
  calls: CallMark[];
  /** The dock's session phase (`.d-voice-dock` data-phase: connecting, connected, reconnecting …; '' with no dock), on change. */
  dock: { at: number; phase: string }[];
  conn: { at: number; status: string }[];
  joins: { at: number; resumed: boolean }[];
  requests: { at: number; method: string; path: string; status: number }[];
}

/** The init script (serialised: it closes over nothing). `relay` forces this page's peer connections through TURN
 *  (iceTransportPolicy 'relay'), as a client behind a UDP-blocking firewall. Times are performance.timeOrigin +
 *  performance.now(), never Date.now(), which the spec moves. */
export function installUpgradeRecorder(relay: boolean): void {
  type Rec = { calls: unknown[]; conn: unknown[]; joins: unknown[]; dock: { at: number; phase: string }[]; pcs: RTCPeerConnection[] };
  const w = window as unknown as { __up9?: Rec };
  if (w.__up9 !== undefined) return;
  const now = () => performance.timeOrigin + performance.now();
  const rec: Rec = { calls: [], conn: [], joins: [], dock: [], pcs: [] };
  w.__up9 = rec;
  // The dock's session phase, sampled every 50 ms (its changes only).
  setInterval(() => {
    const phase = document.querySelector('.dw-voice-dock .d-voice-dock')?.getAttribute('data-phase') ?? '';
    if (rec.dock.at(-1)?.phase !== phase) rec.dock.push({ at: now(), phase });
  }, 50);
  const NativeWorker = window.Worker;
  class UpgradeWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener('message', (e) => {
        const m = (e as MessageEvent).data as { t?: unknown; name?: unknown; ok?: unknown; value?: unknown } | null;
        if (m === null || typeof m !== 'object') return;
        const v = m.value as Record<string, unknown> | null;
        if (m.t === 'slice' && m.name === 'call' && v !== null && typeof v === 'object') {
          const err = v.error as { code?: unknown } | null;
          rec.calls.push({ at: now(), phase: String(v.phase), epoch: (v.epoch as string | null) ?? null, code: (v.code as string | null) ?? null,
            error: typeof err?.code === 'string' ? err.code : null, rejoining: v.rejoining === true });
        }
        if (m.t === 'slice' && m.name === 'connection' && v !== null && typeof v === 'object') rec.conn.push({ at: now(), status: String(v.status) });
        if (m.t === 'ret' && m.ok === true && v !== null && typeof v === 'object' && 'livekitUrl' in v) rec.joins.push({ at: now(), resumed: v.resumed === true });
      });
    }
  }
  Object.defineProperty(window, 'Worker', { value: UpgradeWorker, configurable: true, writable: true });
  const NativePC = window.RTCPeerConnection;
  const policy = (c?: RTCConfiguration): RTCConfiguration | undefined => (relay ? { ...(c ?? {}), iceTransportPolicy: 'relay' } : c);
  class UpgradePC extends NativePC {
    constructor(config?: RTCConfiguration) {
      super(policy(config));
      rec.pcs.push(this);
    }
    override setConfiguration(config?: RTCConfiguration): void { super.setConfiguration(policy(config)); }
  }
  Object.defineProperty(window, 'RTCPeerConnection', { value: UpgradePC, configurable: true, writable: true });
}

/** Records every /v1 request the context makes (the page's and its workers'), with its answer's status and time. */
export function recordRequests(context: BrowserContext, out: UpgradeRecord['requests']): void {
  context.on('requestfinished', (r) => {
    void r.response().then((res) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/v1/')) out.push({ at: Date.now(), method: r.method(), path: u.pathname, status: res?.status() ?? 0 });
    }).catch(() => undefined);
  });
  context.on('requestfailed', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/v1/')) out.push({ at: Date.now(), method: r.method(), path: u.pathname, status: 0 });
  });
}

/** The page's history so far (`calls`, `conn`, `joins`). */
export async function history(page: Page): Promise<Omit<UpgradeRecord, 'requests'>> {
  return page.evaluate(() => {
    const r = (window as unknown as { __up9: Omit<UpgradeRecord, 'requests'> }).__up9;
    return { calls: [...r.calls], conn: [...r.conn], joins: [...r.joins], dock: [...r.dock] };
  });
}

/** Whether a selected candidate pair of the page's live peer connections runs through a TURN relay (its local candidate is
 *  `relay`), and whether any runs without one. */
export async function relayUse(page: Page): Promise<{ relayed: number; direct: number }> {
  return page.evaluate(async () => {
    const pcs = (window as unknown as { __up9: { pcs: RTCPeerConnection[] } }).__up9.pcs.filter((p) => p.connectionState === 'connected');
    let relayed = 0, direct = 0;
    for (const pc of pcs) {
      const stats = await pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      stats.forEach((s: Record<string, unknown>) => { byId.set(String(s.id), s); });
      for (const s of byId.values()) {
        if (s.type !== 'candidate-pair' || s.state !== 'succeeded' || (s.nominated !== true && s.selected !== true)) continue;
        const local = byId.get(String(s.localCandidateId));
        if (local?.candidateType === 'relay') relayed += 1; else direct += 1;
      }
    }
    return { relayed, direct };
  });
}

/** Moves the page's Date.now() `ms` ahead from now on (the plan's "page clock moved 10 min ahead"); performance.now is untouched. */
export async function movePageClock(page: Page, ms: number): Promise<void> {
  await page.evaluate((d) => {
    const native = Date.now.bind(Date);
    Date.now = () => native() + d;
  }, ms);
}

// ---------------------------------------------------------------------------------------------------
// Inbound frames, timed inside each media worker.

export interface FrameTimes { first: Record<string, number>; resumes: Record<string, number[]>; maxGap: Record<string, number>; since: number }

/** A 50 ms sampler in a media worker: for each device, when its verified frames first rose, every time they rose again after
 *  at least 300 ms without (a resume), and the longest time between two rises since the last `resetGaps`. Wall-clock times. */
async function installSampler(wk: Worker): Promise<void> {
  await wk.evaluate(() => {
    const g = globalThis as unknown as { __up9s?: FrameTimes & { last: Record<string, number>; lastAt: Record<string, number> };
      __dillaMediaStats?: { verified?: Record<string, number> } };
    if (g.__up9s !== undefined) return;
    const s = { first: {} as Record<string, number>, resumes: {} as Record<string, number[]>, maxGap: {} as Record<string, number>, since: Date.now(),
      last: {} as Record<string, number>, lastAt: {} as Record<string, number> };
    g.__up9s = s;
    setInterval(() => {
      const verified = g.__dillaMediaStats?.verified ?? {};
      const t = Date.now();
      for (const [d, n] of Object.entries(verified)) {
        if (n <= (s.last[d] ?? 0)) continue;
        const prev = s.lastAt[d];
        if (s.first[d] === undefined) s.first[d] = t;
        if (prev === undefined || t - prev >= 300) (s.resumes[d] ??= []).push(t);
        if (prev !== undefined && prev >= s.since) s.maxGap[d] = Math.max(s.maxGap[d] ?? 0, t - prev);
        s.lastAt[d] = t;
        s.last[d] = n;
      }
    }, 50);
  }).catch(() => undefined);
}

/** Puts the sampler in every media worker the page has now and will start. */
export function sampleFrames(page: Page): void {
  page.on('worker', (wk) => { if (!/\/assets\/entry-[\w-]+\.js$/.test(wk.url())) void installSampler(wk); });
  for (const wk of mediaWorkers(page)) void installSampler(wk);
}

/** The page's media worker frame times (the newest worker that answers), or null when none does. */
export async function frameTimes(page: Page): Promise<FrameTimes | null> {
  for (const wk of [...mediaWorkers(page)].reverse()) {
    await installSampler(wk);
    const t = await wk.evaluate(() => {
      const s = (globalThis as unknown as { __up9s?: FrameTimes }).__up9s;
      return s === undefined ? null : { first: s.first, resumes: s.resumes, maxGap: s.maxGap, since: s.since };
    }).catch(() => null);
    if (t !== null) return t;
  }
  return null;
}

/** Starts a fresh gap window in every media worker of the page. */
export async function resetGaps(page: Page): Promise<void> {
  for (const wk of mediaWorkers(page)) {
    await installSampler(wk);
    await wk.evaluate(() => {
      const s = (globalThis as unknown as { __up9s?: FrameTimes }).__up9s;
      if (s !== undefined) { s.maxGap = {}; s.since = Date.now(); }
    }).catch(() => undefined);
  }
}

/** The core worker's hourly call rotation (client-core CALL_ROTATE_MS) armed `ms` after each join from now on, so that a
 *  `call_rotate` is seen within the test: the worker's timers are its global setTimeout, looked up at each call. */
export async function shortenRotation(page: Page, ms: number): Promise<void> {
  const core = page.workers().filter((wk) => /\/assets\/entry-[\w-]+\.js$/.test(wk.url()));
  if (core.length === 0) throw new Error('no core worker on the page');
  for (const wk of core) {
    await wk.evaluate((d) => {
      const g = self as unknown as { __up9rot?: boolean; setTimeout: typeof setTimeout };
      if (g.__up9rot === true) return;
      g.__up9rot = true;
      const native = g.setTimeout.bind(g);
      g.setTimeout = ((fn: TimerHandler, ms?: number, ...a: unknown[]) => native(fn, ms === 3_600_000 ? d : ms, ...a)) as typeof setTimeout;
    }, ms);
  }
}

// ---------------------------------------------------------------------------------------------------
// The SFU: LiveKit's RoomService, with the API key the sidecar config names and its secret.

function lkToken(secret: string, grants: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ iss: 'dilla', sub: 'up9', nbf: now - 10, exp: now + 600, video: grants });
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

/** The room's participants as the SFU lists them (identity and session sid), or null when the room does not exist. */
export async function sfuParticipants(sfuPort: number, secretFile: string, room: string): Promise<{ identity: string; sid: string }[] | null> {
  const secret = readFileSync(secretFile, 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${String(sfuPort)}/twirp/livekit.RoomService/ListParticipants`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${lkToken(secret, { roomAdmin: true, room })}` },
    body: JSON.stringify({ room }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ListParticipants ${room}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { participants?: { identity: string; sid: string }[] };
  return (body.participants ?? []).map((p) => ({ identity: p.identity, sid: p.sid }));
}

// ---------------------------------------------------------------------------------------------------
// The instance database, read-only.

export interface GroupRows {
  group: string; room: string; epoch: number;
  /** The instance's withdrawable Removes of the group at its current epoch: target device, withdrawn, voided. */
  removes: { device: string; withdrawn: boolean; void: boolean }[];
  /** Outstanding proposals of the current epoch (not voided, not withdrawn): what a commit must still cover. */
  outstanding: number;
  /** Handshake rows of kind 3 (`withdrawn`), ever. */
  withdrawnRows: number;
}

/** The live call of `channel` and its call group's rows. */
export function groupRows(dbPath: string, channel: string): GroupRows {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const call = db.prepare('SELECT lower(hex(group_id)) AS g, livekit_room AS room FROM voice_sessions WHERE lower(hex(channel_id)) = ? AND ended IS NULL')
      .get(channel) as { g: string | null; room: string } | undefined;
    if (call?.g == null) throw new Error(`no live call with a group in channel ${channel}`);
    const g = call.g;
    const epoch = Number((db.prepare('SELECT epoch FROM mls_groups WHERE lower(hex(group_id)) = ?').get(g) as { epoch: number }).epoch);
    const removes = (db.prepare(`SELECT lower(hex(target_device)) AS d, withdrawn_at AS w, void_at AS v FROM mls_pending_proposals
      WHERE lower(hex(group_id)) = ? AND epoch = ? AND kind = 3 AND withdrawable = 1`).all(g, epoch) as { d: string; w: number | null; v: number | null }[])
      .map((r) => ({ device: r.d, withdrawn: r.w !== null, void: r.v !== null }));
    const outstanding = Number((db.prepare(`SELECT count(*) AS n FROM mls_pending_proposals
      WHERE lower(hex(group_id)) = ? AND epoch = ? AND void_at IS NULL AND withdrawn_at IS NULL`).get(g, epoch) as { n: number }).n);
    const withdrawnRows = Number((db.prepare('SELECT count(*) AS n FROM mls_handshakes WHERE lower(hex(group_id)) = ? AND kind = 3').get(g) as { n: number }).n);
    return { group: g, room: call.room, epoch, removes, outstanding, withdrawnRows };
  } finally {
    db.close();
  }
}
