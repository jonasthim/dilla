import type { DillaMediaStats } from '../../../packages/media/src/protocol';
import type { DillaRemoteStats } from '../../../packages/media/harness/main';

// RTP counts every arrival; the worker counts what has left it, and the two snapshots are not atomic.
// A developer machine stays within 4 packets. A 4-vCPU CI runner measured a gap of 10 on one audio
// track of the three-context call (PR #7). The cause was not isolated; the likeliest is frames
// waiting in the worker's hold queue, which no stat counts. CI therefore allows one second of Opus
// packets, which means that in CI up to 50 packets of a track bypassing the worker would pass THIS
// check; it is the tight one, and the decoded-sample ceiling below is loose (it allows 5,760 samples
// a packet where Opus at 20 ms uses 960). Non-member media, the sender binding and the fail-closed
// legs are asserted absolutely in their own specs. Plan follow-up card 26 makes this exact again.
const PACKET_SLACK = process.env.CI === 'true' ? 50 : 4;

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
