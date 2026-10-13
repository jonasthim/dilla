// L-PROBE-1: the probe page's report arithmetic. Node only: the RTCStatsReport is a Map of plain objects.
import { describe, expect, it } from 'vitest';
import { pairFromStats, rtpFromStats, summarise, summariseRun, type ProbeSample } from '../probe/report';

function sample(t: number, o: Partial<ProbeSample> & { received?: number; lost?: number } = {}): ProbeSample {
  return {
    t,
    rttMs: o.rttMs ?? null,
    packetsReceived: o.received ?? o.packetsReceived ?? 0,
    packetsLost: o.lost ?? o.packetsLost ?? 0,
    jitterMs: o.jitterMs ?? null,
    verifiedRemote: o.verifiedRemote ?? 0,
    decryptDrops: o.decryptDrops ?? 0,
  };
}

function fakeStats(o: { local: string; remote: string; protocol: string; relayProtocol?: string }): RTCStatsReport {
  const rows: Record<string, unknown>[] = [
    { id: 'T1', type: 'transport', selectedCandidatePairId: 'P2' },
    // A pair that is not the selected one, so the reader cannot just take the first pair it sees.
    { id: 'P1', type: 'candidate-pair', state: 'failed', nominated: false, localCandidateId: 'L0', remoteCandidateId: 'R1' },
    { id: 'P2', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L1', remoteCandidateId: 'R1' },
    { id: 'L0', type: 'local-candidate', candidateType: 'host', protocol: 'tcp', address: '192.0.2.1', port: 9 },
    {
      id: 'L1', type: 'local-candidate', candidateType: o.local, protocol: o.protocol, address: '192.0.2.7', port: 50000,
      ...(o.relayProtocol === undefined ? {} : { relayProtocol: o.relayProtocol }),
    },
    { id: 'R1', type: 'remote-candidate', candidateType: o.remote, protocol: o.protocol, address: '198.51.100.4', port: 7882 },
  ];
  return new Map(rows.map((r) => [r.id as string, r])) as unknown as RTCStatsReport;
}

describe('probe report', () => {
  it('loss counts packets lost before the first sample against the run', () => {
    const s = [sample(0, { received: 100, lost: 5 }), sample(1000, { received: 150, lost: 5 }), sample(2000, { received: 200, lost: 9 })];
    expect(summarise(s).lossPct).toBeCloseTo((9) / (9 + 200) * 100, 5);
  });
  it('pairFromStats reads the nominated pair and its local and remote candidate types', () => {
    expect(pairFromStats(fakeStats({ local: 'srflx', remote: 'host', protocol: 'udp' }))).toMatchObject({ local: 'srflx', remote: 'host', protocol: 'udp', relayProtocol: null });
  });
  it('relayUnavailable is true when ICE failed with no relay candidate gathered', () => {
    const r = summariseRun({ iceState: 'failed', candidates: [{ type: 'host', protocol: 'udp' }, { type: 'srflx', protocol: 'udp' }], samples: [] });
    expect(r.summary.relayUnavailable).toBe(true);
    expect(summariseRun({ iceState: 'failed', candidates: [{ type: 'relay', protocol: 'udp' }], samples: [] }).summary.relayUnavailable).toBe(false);
  });
  it('the report never carries a local address', () => {
    const r = summariseRun({ iceState: 'connected', candidates: [{ type: 'host', protocol: 'udp', address: '192.0.2.7' } as never], samples: [] });
    expect(JSON.stringify(r.candidates)).not.toContain('192.0.2.7');
  });

  // Beyond the four pinned cases: the parts of the report the session reads.
  it('pairFromStats keeps the remote address and port, the relay protocol, and answers null without a selected pair', () => {
    expect(pairFromStats(fakeStats({ local: 'relay', remote: 'srflx', protocol: 'udp', relayProtocol: 'tcp' }))).toEqual({
      local: 'relay', remote: 'srflx', protocol: 'udp', relayProtocol: 'tcp', remoteAddress: '198.51.100.4', remotePort: 7882,
    });
    expect(pairFromStats(new Map() as unknown as RTCStatsReport)).toBeNull();
  });
  it('summarise takes medians over the samples that have a value and reports no loss without packets', () => {
    const s = [sample(0, { rttMs: 30, jitterMs: 2 }), sample(1000, { rttMs: 10 }), sample(2000, { rttMs: 20, jitterMs: 4 })];
    expect(summarise(s)).toEqual({ lossPct: 0, rttP50Ms: 20, jitterP50Ms: 3 });
    expect(summarise([])).toEqual({ lossPct: 0, rttP50Ms: null, jitterP50Ms: null });
  });
  it('rtpFromStats keeps the counters of a stream that ended, so the last sample still carries the run', () => {
    const inbound = (id: string, received: number, lost: number, jitter: number) => ({ id, type: 'inbound-rtp', kind: 'audio', packetsReceived: received, packetsLost: lost, jitter });
    const report = (...r: Record<string, unknown>[]) => new Map(r.map((x) => [x.id as string, x])) as unknown as RTCStatsReport;
    const totals = new Map();
    expect(rtpFromStats(report(inbound('A', 100, 2, 0.002)), totals)).toMatchObject({ packetsReceived: 100, packetsLost: 2, jitterMs: 2 });
    expect(rtpFromStats(report(inbound('A', 150, 3, 0.004), inbound('B', 10, 0, 0.001)), totals)).toMatchObject({ packetsReceived: 160, packetsLost: 3, jitterMs: 4 });
    // The other side left: no inbound row any more.
    expect(rtpFromStats(report(), totals)).toMatchObject({ packetsReceived: 160, packetsLost: 3, jitterMs: null, rttMs: null });
  });
  it('relayUnavailable is false while ICE has not failed', () => {
    expect(summariseRun({ iceState: 'connected', candidates: [{ type: 'host', protocol: 'udp' }], samples: [] }).summary.relayUnavailable).toBe(false);
  });
});
