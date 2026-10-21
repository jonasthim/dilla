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
  const pub = (bytesSent: number, extra: Array<Record<string, unknown>> = []) =>
    rtc([...pair(0.024), { id: 'O1', type: 'outbound-rtp', kind: 'audio', bytesSent }, ...extra]);
  const sub = (bytesReceived: number) => rtc([{ id: 'I1', type: 'inbound-rtp', kind: 'audio', bytesReceived }]);

  it('turns byte deltas into integer kb/s and reads the ping from the selected pair', () => {
    const r = linkSample({ up: 10_000, down: 20_000 }, pub(22_000), sub(44_000), 2000);
    expect(r.sample).toEqual({ rttMs: 24, upKbps: 48, downKbps: 96, lossPct: 0 });
    expect(r.totals).toEqual({ up: 22_000, down: 44_000 });
  });

  it('sums every outbound and inbound rtp (mic, camera, screen) across both peer connections', () => {
    const p = pub(1000, [{ id: 'O2', type: 'outbound-rtp', kind: 'video', bytesSent: 3000 }]);
    const s = rtc([{ id: 'I1', type: 'inbound-rtp', bytesReceived: 500 }, { id: 'I2', type: 'inbound-rtp', bytesReceived: 1500 }]);
    const r = linkSample({ up: 0, down: 0 }, p, s, 1000);
    expect(r.totals).toEqual({ up: 4000, down: 2000 });
    expect(r.sample).toMatchObject({ upKbps: 32, downKbps: 16 });
  });

  it('a counter that went down (a new peer connection) counts from 0 for that sample', () => {
    const r = linkSample({ up: 90_000, down: 90_000 }, pub(2500), sub(5000), 2000);
    expect(r.sample).toMatchObject({ upKbps: 10, downKbps: 20 });
    expect(r.totals).toEqual({ up: 2500, down: 5000 });
  });

  it('the first sample has no previous totals: 0 kb/s, not the whole counter', () => {
    expect(linkSample(null, pub(50_000), sub(50_000), 2000).sample).toMatchObject({ upKbps: 0, downKbps: 0 });
  });

  it('no selected pair on either side: no sample, but the totals still advance', () => {
    const r = linkSample({ up: 0, down: 0 }, rtc([{ id: 'O1', type: 'outbound-rtp', bytesSent: 800 }]), sub(100), 1000);
    expect(r.sample).toBeNull();
    expect(r.totals).toEqual({ up: 800, down: 100 });
    expect(linkSample(null, undefined, undefined, 2000)).toEqual({ sample: null, totals: { up: 0, down: 0 } });
  });

  it('falls back to the subscriber pair when the publisher has none, and gives loss in percent', () => {
    const s = rtc([...pair(0.2), { id: 'R', type: 'remote-inbound-rtp', fractionLost: 0.0625 }]);
    expect(linkSample(null, rtc([]), s, 2000).sample).toMatchObject({ rttMs: 200, lossPct: 6.3 });
  });

  it('a zero interval gives 0 kb/s', () => {
    expect(linkSample({ up: 0, down: 0 }, pub(9000), sub(9000), 0).sample).toMatchObject({ upKbps: 0, downKbps: 0 });
  });
});
