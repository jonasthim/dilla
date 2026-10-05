import { expect, test } from '@playwright/test';
import { frameAccountingErrors } from './support/frame-accounting';
import type { DillaMediaStats } from '../../packages/media/src/protocol';
import type { DillaRemoteStats } from '../../packages/media/harness/main';

test('frame accounting rejects decoded plaintext video and non-empty audio', () => {
  const device = 'a1'.repeat(16);
  const stats = {
    decrypted: { '107': 1 }, decryptedByTrack: { video: 1, audio: 1 },
    emptyFrames: { encode: 0, decode: 1 }, emptyFramesByTrack: { audio: 1 },
    // Rejected frames must not excuse decoder output, even when plentiful.
    droppedByTrack: { audio: 100, video: 100 },
  } as unknown as DillaMediaStats;
  const track = (kind: 'video' | 'audio', trackId: string): DillaRemoteStats => ({
    trackId, participantIdentity: device, kind, source: kind === 'video' ? 'camera' : 'microphone',
    framesDecoded: kind === 'video' ? 7 : 0, packetsReceived: kind === 'audio' ? 12 : 0,
    keyFramesDecoded: 0, freezeCount: 0, totalSamplesReceived: 0, concealedSamples: 0, jitterBufferDelay: 0, jitterBufferEmittedCount: 0,
  });
  const errors = frameAccountingErrors([track('video', 'video'), track('audio', 'audio')], stats, { [device]: ['107'] });
  expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('video'), expect.stringContaining('audio')]));
});
