import { describe, expect, it } from 'vitest';
import type { DillaMediaStats } from '@dilla/media';
import { callStatsReport, connectionOf, linkQuality, linkSample, mediaTotals } from './stats.ts';

describe('linkQuality (the dock ping colour, MP5)', () => {
  it('is good under 150 ms, poor from 150 to 300 ms, bad above 300 ms', () => {
    expect(linkQuality(0, 0)).toBe('good');
    expect(linkQuality(149, 0)).toBe('good');
    expect(linkQuality(150, 0)).toBe('poor');
    expect(linkQuality(300, 0)).toBe('poor');
    expect(linkQuality(301, 0)).toBe('bad');
  });
  it('is bad above 5 % loss whatever the ping; exactly 5 % does not count', () => {
    expect(linkQuality(20, 5)).toBe('good');
    expect(linkQuality(20, 5.1)).toBe('bad');
    expect(linkQuality(200, 6)).toBe('bad');
  });
});

const rtc = (entries: Array<Record<string, unknown>>) => new Map(entries.map((e) => [e.id as string, e]));

function media(sent: number, failed: number): DillaMediaStats {
  const frames: Record<string, Record<number, number>> = { aa: { 0: sent } };
  return {
    encrypted: frames,
    decrypted: {}, decryptedByTrack: {}, decryptedByTrackKid: {}, verifiedByTrack: {}, verified: {},
    emptyFrames: { send: 0, recv: 0 } as unknown as DillaMediaStats['emptyFrames'], emptyFramesByTrack: {},
    dropped: { aeadFail: failed, foreignLeaf: 0, senderMismatch: 0 } as unknown as DillaMediaStats['dropped'],
    droppedByTrack: {}, passedThrough: 0, currentEpoch: '1', knownKids: [], sifTrailerLen: 0,
  };
}

describe('call stats (protocol/09 § Call stats)', () => {
  it('reads the selected pair: candidate type, relay transport, rtt and loss', () => {
    const report = rtc([
      { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
      { id: 'P', type: 'candidate-pair', localCandidateId: 'L', currentRoundTripTime: 0.0425 },
      { id: 'L', type: 'local-candidate', candidateType: 'relay', relayProtocol: 'tcp' },
      { id: 'R', type: 'remote-inbound-rtp', fractionLost: 0.0123 },
    ]);
    expect(connectionOf(report)).toEqual({ candidateType: 3, relayProtocol: 1, rttMs: 43, lossPermille: 12 });
  });

  it('falls back to the nominated succeeded pair, and gives null relay for a host candidate', () => {
    const report = rtc([
      { id: 'P', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'L', currentRoundTripTime: 0.01 },
      { id: 'L', type: 'local-candidate', candidateType: 'srflx' },
    ]);
    expect(connectionOf(report)).toEqual({ candidateType: 1, relayProtocol: null, rttMs: 10, lossPermille: 0 });
  });

  it('nothing known is host, no relay, 0 ms, no loss', () => {
    expect(connectionOf(null)).toEqual({ candidateType: 0, relayProtocol: null, rttMs: 0, lossPermille: 0 });
  });

  it('clamps rtt to 60 000 ms and loss to 1000', () => {
    const report = rtc([
      { id: 'P', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'L', currentRoundTripTime: 99 },
      { id: 'L', type: 'local-candidate', candidateType: 'prflx' },
      { id: 'R', type: 'remote-inbound-rtp', fractionLost: 3 },
    ]);
    expect(connectionOf(report)).toEqual({ candidateType: 2, relayProtocol: null, rttMs: 60_000, lossPermille: 1000 });
  });

  it('reports the frames since the previous report, each at most 1 048 576', () => {
    const first = callStatsReport(connectionOf(null), mediaTotals(media(500, 3)), { sent: 0, failed: 0 });
    expect(first.report).toEqual([0, null, 0, 0, 3, 500]);
    const second = callStatsReport(connectionOf(null), mediaTotals(media(2_000_000, 3)), first.totals);
    expect(second.report).toEqual([0, null, 0, 0, 0, 1_048_576]);
    // A reset counter (a fresh worker) never reports a negative count.
    const third = callStatsReport(connectionOf(null), mediaTotals(media(10, 0)), second.totals);
    expect(third.report).toEqual([0, null, 0, 0, 0, 10]);
  });
});

describe('linkSample (the dock link read, MP5)', () => {
  const pair = (rtt: number) => [
    { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
    { id: 'P', type: 'candidate-pair', localCandidateId: 'L', currentRoundTripTime: rtt },
    { id: 'L', type: 'local-candidate', candidateType: 'host' },
  ];
  const out = (id: string, bytesSent: number) => ({ id, type: 'outbound-rtp', kind: 'audio', bytesSent });
  const inn = (id: string, bytesReceived: number, packetsReceived = 0, packetsLost = 0) =>
    ({ id, type: 'inbound-rtp', kind: 'audio', bytesReceived, packetsReceived, packetsLost });
  const pub = (...extra: Array<Record<string, unknown>>) => rtc([...pair(0.024), ...extra]);
  const sub = (...extra: Array<Record<string, unknown>>) => rtc(extra);
  /** A baseline read, so the next one has previous totals. */
  const base = (p: ReturnType<typeof pub> | undefined, s: ReturnType<typeof sub> | undefined) => linkSample(null, p, s, 2000).totals;

  it('the first read is only a baseline: no sample, so the dock keeps "— ms"', () => {
    const r = linkSample(null, pub(out('O1', 50_000)), sub(inn('I1', 50_000)), 2000);
    expect(r.sample).toBeNull();
    expect(r.totals).toBeDefined();
  });

  it('turns per-stream byte deltas into integer kb/s and reads the ping from the selected pair', () => {
    const t = base(pub(out('O1', 10_000)), sub(inn('I1', 20_000)));
    const r = linkSample(t, pub(out('O1', 22_000)), sub(inn('I1', 44_000)), 2000);
    expect(r.sample).toEqual({ rttMs: 24, upKbps: 48, downKbps: 96, lossPct: 0 });
  });

  it('sums every outbound and inbound rtp (mic, camera, screen) across both peer connections', () => {
    const t = base(pub(out('O1', 0), out('O2', 0)), sub(inn('I1', 0), inn('I2', 0)));
    const r = linkSample(t, pub(out('O1', 1000), out('O2', 3000)), sub(inn('I1', 500), inn('I2', 1500)), 1000);
    expect(r.sample).toMatchObject({ upKbps: 32, downKbps: 16 });
  });

  it('a stream whose counter went down (a new one under the same id) counts from 0', () => {
    const t = base(pub(out('O1', 90_000)), sub(inn('I1', 90_000)));
    expect(linkSample(t, pub(out('O1', 2500)), sub(inn('I1', 5000)), 2000).sample).toMatchObject({ upKbps: 10, downKbps: 20 });
  });

  it('a stream that disappears or appears adds no delta (a remote person leaves)', () => {
    const t = base(pub(out('O1', 10_000_000)), sub(inn('I1', 10_000_000), inn('I2', 10_000_000)));
    const gone = linkSample(t, pub(out('O1', 10_002_000)), sub(inn('I1', 10_004_000)), 2000);
    expect(gone.sample).toMatchObject({ upKbps: 8, downKbps: 16 });
    const back = linkSample(gone.totals, pub(out('O1', 10_004_000)), sub(inn('I1', 10_008_000), inn('I3', 7_000_000)), 2000);
    expect(back.sample).toMatchObject({ upKbps: 8, downKbps: 16 });
  });

  it('a missing report (a failed getStats) is no data for that side: the next good read is not a spike', () => {
    const t = base(pub(out('O1', 10_000_000)), sub(inn('I1', 10_000_000)));
    const failed = linkSample(t, undefined, rtc([...pair(0.03), inn('I1', 10_004_000)]), 2000);
    expect(failed.sample).toMatchObject({ downKbps: 16 });
    expect(failed.sample?.upKbps).toBeNull();
    // the publisher is back after one lost interval: its delta spans two intervals (4 s), not the whole counter
    const good = linkSample(failed.totals, pub(out('O1', 10_004_000)), sub(inn('I1', 10_008_000)), 2000);
    expect(good.sample).toMatchObject({ upKbps: 8, downKbps: 16 });
  });

  it('no selected pair on either side: no sample, but the totals still advance', () => {
    const t = base(pub(out('O1', 0)), sub());
    expect(linkSample(t, rtc([out('O1', 800)]), sub(), 1000).sample).toBeNull();
    expect(linkSample(null, undefined, undefined, 2000).sample).toBeNull();
  });

  it('falls back to the subscriber pair when the publisher has none', () => {
    const s = rtc([...pair(0.2), inn('I1', 0)]);
    const t = base(rtc([]), s);
    expect(linkSample(t, rtc([]), rtc([...pair(0.2), inn('I1', 0)]), 2000).sample).toMatchObject({ rttMs: 200 });
  });

  it('loss is the worse of outgoing (remote-inbound-rtp) and incoming (packetsLost over received plus lost, per stream)', () => {
    const t = base(pub(), sub(inn('I1', 0, 1000, 0), inn('I2', 0, 1000, 0)));
    const outgoing = { id: 'R', type: 'remote-inbound-rtp', fractionLost: 0.02 };
    // I1 lost 10 of 100 packets in the interval (10 %), I2 none; outgoing 2 %
    const r = linkSample(t, pub(outgoing), sub(inn('I1', 0, 1090, 10), inn('I2', 0, 1100, 0)), 2000);
    expect(r.sample).toMatchObject({ lossPct: 10 });
    const t2 = base(pub(), sub(inn('I1', 0, 1000, 0)));
    expect(linkSample(t2, pub({ ...outgoing, fractionLost: 0.0625 }), sub(inn('I1', 0, 1100, 0)), 2000).sample).toMatchObject({ lossPct: 6.3 });
  });

  it('a zero interval gives 0 kb/s', () => {
    const t = base(pub(out('O1', 0)), sub(inn('I1', 0)));
    expect(linkSample(t, pub(out('O1', 9000)), sub(inn('I1', 9000)), 0).sample).toMatchObject({ upKbps: 0, downKbps: 0 });
  });
});
