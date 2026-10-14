// L-PROBE-1: the network probe's report. Pure functions over getStats() rows and the media worker's counters, so the
// arithmetic is unit-tested in Node (test/probe-report.test.ts) and the page only collects.

export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';

export interface ProbeSample {
  t: number; // ms since the Start press
  rttMs: number | null;
  packetsReceived: number; // cumulative, from the session's first packet
  packetsLost: number; // cumulative, from the session's first packet
  jitterMs: number | null;
  verifiedRemote: number; // frames the media worker authenticated and bound to a roster device
  decryptDrops: number; // frames the media worker refused, every reason
}

export interface ProbePair {
  local: CandidateType;
  remote: CandidateType;
  protocol: 'udp' | 'tcp';
  relayProtocol: 'udp' | 'tcp' | 'tls' | null;
  // Kept in the downloaded JSON only (git-ignored target/netprobe/reports/); the spike document records yes/no and
  // the port, never an address (task 2's redaction gate).
  remoteAddress: string;
  remotePort: number;
}

export interface ProbeSummary { lossPct: number; rttP50Ms: number | null; jitterP50Ms: number | null; relayUnavailable: boolean }

/** Something that happened during the run, for leg 3: ICE and room state changes and the silence window. */
export interface ProbeEvent { t: number; what: string }

export interface ProbeReport {
  v: 1; label: string; ua: string; startedAt: string;
  // From the button press. `connected` is null when the join failed (the `join failed` event says when).
  joinMs: { connected: number | null; firstVerifiedRemote: number | null };
  pair: ProbePair | null;
  candidates: { type: string; protocol: string }[]; // gathered, addresses dropped
  samples: ProbeSample[];
  summary: ProbeSummary;
  events: ProbeEvent[];
}

type Row = Record<string, unknown>;

function rows(stats: RTCStatsReport): Map<string, Row> {
  const byId = new Map<string, Row>();
  stats.forEach((s: Row) => byId.set(s.id as string, s));
  return byId;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The run's figures. Loss comes from the cumulative counters of the LAST sample, lost / (lost + received) × 100: the
 * counters start at the session's first packet, so what was lost before the first 1 s sample counts against the run.
 */
export function summarise(samples: ProbeSample[]): Omit<ProbeSummary, 'relayUnavailable'> {
  const last = samples.at(-1);
  const lost = last?.packetsLost ?? 0;
  const received = last?.packetsReceived ?? 0;
  const lossPct = lost + received === 0 ? 0 : (lost / (lost + received)) * 100;
  return {
    lossPct,
    rttP50Ms: median(samples.flatMap((s) => (s.rttMs === null ? [] : [s.rttMs]))),
    jitterP50Ms: median(samples.flatMap((s) => (s.jitterMs === null ? [] : [s.jitterMs]))),
  };
}

function selectedPair(byId: Map<string, Row>): Row | undefined {
  for (const r of byId.values()) {
    if (r.type !== 'transport' || typeof r.selectedCandidatePairId !== 'string') continue;
    const p = byId.get(r.selectedCandidatePairId);
    if (p !== undefined) return p;
  }
  // Firefox reports no transport row: the nominated, succeeded pair is the selected one.
  for (const r of byId.values()) {
    if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated === true || r.selected === true)) return r;
  }
  return undefined;
}

const CANDIDATE_TYPES = new Set<string>(['host', 'srflx', 'prflx', 'relay']);

function candidateType(v: unknown): CandidateType | null {
  return typeof v === 'string' && CANDIDATE_TYPES.has(v) ? (v as CandidateType) : null;
}

/** The selected candidate pair: local and remote candidate types, its protocol, the relay protocol and the remote end. */
export function pairFromStats(stats: RTCStatsReport): ProbePair | null {
  const byId = rows(stats);
  const p = selectedPair(byId);
  if (p === undefined) return null;
  const l = byId.get(p.localCandidateId as string);
  const r = byId.get(p.remoteCandidateId as string);
  const local = candidateType(l?.candidateType);
  const remote = candidateType(r?.candidateType);
  const protocol = l?.protocol ?? r?.protocol;
  if (local === null || remote === null || (protocol !== 'udp' && protocol !== 'tcp')) return null;
  const relay = l?.relayProtocol;
  return {
    local, remote, protocol,
    relayProtocol: relay === 'udp' || relay === 'tcp' || relay === 'tls' ? relay : null,
    remoteAddress: String(r?.address ?? r?.ip ?? ''),
    remotePort: Number(r?.port ?? 0),
  };
}

/** The gathered local candidates, type and protocol only: no address leaves this function. */
export function candidatesFromStats(stats: RTCStatsReport): { type: string; protocol: string }[] {
  const out: { type: string; protocol: string }[] = [];
  for (const r of rows(stats).values()) {
    if (r.type === 'local-candidate') out.push({ type: String(r.candidateType), protocol: String(r.protocol) });
  }
  return out;
}

/** Each inbound audio stream's last counters, by stats id, kept for the whole run. */
export type RtpTotals = Map<string, { received: number; lost: number }>;

/**
 * The audio receive counters and the selected pair's RTT of one getStats() report. The counters are the run's: each
 * inbound audio stream's last values are kept in `totals`, so a stream that ends (the other side left first, a
 * re-subscription after a reconnect) still counts with what it received and lost.
 */
export function rtpFromStats(stats: RTCStatsReport, totals: RtpTotals = new Map()): Pick<ProbeSample, 'rttMs' | 'packetsReceived' | 'packetsLost' | 'jitterMs'> {
  const byId = rows(stats);
  const jitters: number[] = [];
  for (const r of byId.values()) {
    if (r.type !== 'inbound-rtp' || r.kind !== 'audio') continue;
    const prev = totals.get(r.id as string);
    totals.set(r.id as string, {
      received: Math.max(prev?.received ?? 0, Number(r.packetsReceived ?? 0)),
      lost: Math.max(prev?.lost ?? 0, Number(r.packetsLost ?? 0)),
    });
    if (typeof r.jitter === 'number') jitters.push(r.jitter * 1000);
  }
  let packetsReceived = 0;
  let packetsLost = 0;
  for (const t of totals.values()) {
    packetsReceived += t.received;
    packetsLost += t.lost;
  }
  const rtt = selectedPair(byId)?.currentRoundTripTime;
  return {
    rttMs: typeof rtt === 'number' ? rtt * 1000 : null,
    packetsReceived,
    packetsLost,
    jitterMs: jitters.length === 0 ? null : Math.max(...jitters),
  };
}

export interface RunInput {
  iceState: string;
  candidates: { type: string; protocol: string }[];
  samples: ProbeSample[];
  pair?: ProbePair | null;
}

/**
 * The report's measured half. `relayUnavailable` is ICE failing with no relay candidate gathered: nothing could have
 * carried the media past a path that drops UDP, which is leg 1's expected outcome without TURN.
 */
export function summariseRun(run: RunInput): Pick<ProbeReport, 'pair' | 'candidates' | 'samples' | 'summary'> {
  const candidates = run.candidates.map((c) => ({ type: String(c.type), protocol: String(c.protocol) }));
  const relayUnavailable = run.iceState === 'failed' && !candidates.some((c) => c.type === 'relay');
  return {
    pair: run.pair ?? null,
    candidates,
    samples: run.samples,
    summary: { ...summarise(run.samples), relayUnavailable },
  };
}

/** Sum of a counter record (the media worker's per-device and per-reason maps). */
export function total(record: Record<string, number> | undefined): number {
  let n = 0;
  for (const v of Object.values(record ?? {})) n += v;
  return n;
}
