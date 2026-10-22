import { describe, expect, it } from 'vitest';
import { voiceMusicAdapter, type VoiceMusicAdapter } from './music.ts';

describe('voice music adapter', () => {
  it('reports unavailable until the authenticated music transport exists', async () => {
    expect(voiceMusicAdapter.state('ab'.repeat(16))).toEqual({
      status: 'unavailable', reason: 'authenticated-transport-missing',
    });
    await expect(voiceMusicAdapter.pause('channel', true)).rejects.toThrow(/transport is unavailable/);
  });

  it('defines typed track, queue, state and authorized commands for an injected client', () => {
    const adapter: VoiceMusicAdapter = {
      state: () => ({
        status: 'available',
        track: { id: 'track-1', title: 'North', artist: 'Harbor', durationMs: 180_000 },
        queue: [{ id: 'queue-1', track: { id: 'track-2', title: 'South', artist: 'Harbor', durationMs: 190_000 } }],
        positionMs: 30_000, volume: 75, paused: false, shuffle: true, repeat: 'all',
        permissions: { control: true, manageQueue: false },
      }),
      subscribe: () => () => undefined,
      pause: () => undefined, skip: () => undefined, stop: () => undefined, seek: () => undefined,
      setVolume: () => undefined, setShuffle: () => undefined, setRepeat: () => undefined,
      remove: () => undefined, move: () => undefined,
    };
    expect(adapter.state('channel').status).toBe('available');
  });
});
