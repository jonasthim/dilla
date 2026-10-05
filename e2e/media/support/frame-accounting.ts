import type { DillaMediaStats } from '../../../packages/media/src/protocol';
import type { DillaRemoteStats } from '../../../packages/media/harness/main';

// RTP counts every arrival; the worker counts what has reached it, and the two snapshots are not
// atomic. A developer machine stays within 4 packets. A 4-vCPU CI runner measured a gap of 10 on one
// audio track of the three-context call (PR #7; the cause was not isolated: packets queued for the
// worker, or arrivals before the receiver's transform was attached), so CI allows one second of Opus
// packets. The decoded-sample ceiling below is the security check and keeps its slack of 4.
const PACKET_SLACK = process.env.CI ? 50 : 4;

/** Compare decoder output with the worker's authenticated output for each remote track. */
export function frameAccountingErrors(
  tracks: DillaRemoteStats[], stats: DillaMediaStats, senderKids: Record<string, string[]>,
): string[] {
  const errors: string[] = [];
  for (const track of tracks) {
    const authenticated = stats.decryptedByTrack[track.trackId] ?? 0;
    const bySenderKids = (senderKids[track.participantIdentity] ?? []).reduce((n, kid) => n + (stats.decrypted[kid] ?? 0), 0);
    if (track.kind === 'video') {
      const ceiling = Math.min(authenticated, bySenderKids) + 2; // at most two frames crossing the stats snapshot
      if (track.framesDecoded > ceiling) errors.push(`video ${track.participantIdentity}/${track.trackId}: decoded ${track.framesDecoded}, authenticated ceiling ${ceiling}`);
    } else {
      // RTP counts arrivals, including empty DTX and frames the worker refuses. Each arrival must
      // appear in exactly one worker outcome; refused frames never reach the decoder.
      const empty = stats.emptyFramesByTrack[track.trackId] ?? 0;
      const dropped = stats.droppedByTrack[track.trackId] ?? 0;
      const ceiling = authenticated + empty + dropped + PACKET_SLACK;
      if (track.packetsReceived > ceiling) errors.push(`audio ${track.participantIdentity}/${track.trackId}: packets ${track.packetsReceived}, authenticated ${authenticated}, empty ${empty}, dropped ${dropped}`);
      // Opus decodes at 48 kHz and one packet can hold at most 120 ms (5,760 samples). Rejected
      // packets cannot excuse non-concealed decoder output; four frames cover snapshot skew.
      const decodedSamples = Math.max(0, track.totalSamplesReceived - track.concealedSamples);
      const sampleCeiling = (authenticated + empty + 4) * 5_760;
      if (decodedSamples > sampleCeiling) errors.push(`audio decoded ${track.participantIdentity}/${track.trackId}: samples ${decodedSamples}, authenticated/empty ceiling ${sampleCeiling}`);
    }
  }
  return errors;
}
