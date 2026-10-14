import { describe, expect, it } from 'vitest';
import type { DillaMediaStats } from '@dilla/media';
import { callStatsReport, connectionOf, mediaTotals } from './stats.ts';

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
