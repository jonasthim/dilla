/** Music transport is deliberately absent until the authenticated client protocol exists. */
export interface VoiceMusicTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  durationMs: number;
}

export interface VoiceMusicQueueItem {
  id: string;
  track: VoiceMusicTrack;
}

export interface VoiceMusicPermissions {
  control: boolean;
  manageQueue: boolean;
}

export type VoiceMusicState =
  | { status: 'unavailable'; reason: 'authenticated-transport-missing' }
  | {
      status: 'available';
      track: VoiceMusicTrack | null;
      queue: readonly VoiceMusicQueueItem[];
      positionMs: number;
      volume: number;
      paused: boolean;
      shuffle: boolean;
      repeat: 'off' | 'one' | 'all';
      permissions: VoiceMusicPermissions;
    };

export interface VoiceMusicAdapter {
  state(channelId: string): VoiceMusicState;
  pause(channelId: string, paused: boolean): void | Promise<void>;
  skip(channelId: string): void | Promise<void>;
  stop(channelId: string): void | Promise<void>;
  seek(channelId: string, positionMs: number): void | Promise<void>;
  setVolume(channelId: string, volume: number): void | Promise<void>;
  setShuffle(channelId: string, enabled: boolean): void | Promise<void>;
  setRepeat(channelId: string, repeat: 'off' | 'one' | 'all'): void | Promise<void>;
  remove(channelId: string, queueItemId: string): void | Promise<void>;
  move(channelId: string, queueItemId: string, destinationIndex: number): void | Promise<void>;
}

export const voiceMusicAdapter: VoiceMusicAdapter = {
  state: () => ({ status: 'unavailable', reason: 'authenticated-transport-missing' }),
  pause: unavailable, skip: unavailable, stop: unavailable, seek: unavailable,
  setVolume: unavailable, setShuffle: unavailable, setRepeat: unavailable,
  remove: unavailable, move: unavailable,
};

function unavailable(): never {
  throw new Error('Authenticated voice music transport is unavailable.');
}
