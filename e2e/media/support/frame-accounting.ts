import type { DillaMediaStats } from '../../../packages/media/src/protocol';
import type { DillaRemoteStats } from '../../../packages/media/harness/main';

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
      // Zero-byte Opus frames are explicitly excluded; refused SIF and bad frames never reach the decoder.
      const empty = stats.emptyFramesByTrack[track.trackId] ?? 0;
      const ceiling = authenticated + empty + 4; // RTP and worker snapshots are not atomic; refused frames cannot count as authenticated
      if (track.packetsReceived > ceiling) errors.push(`audio ${track.participantIdentity}/${track.trackId}: packets ${track.packetsReceived}, authenticated ${authenticated}, empty ${empty}`);
    }
  }
  return errors;
}
