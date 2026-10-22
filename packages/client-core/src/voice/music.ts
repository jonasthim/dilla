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
  /** Return the same immutable snapshot until a change is published to subscribers. */
  state(channelId: string): VoiceMusicState;
  /** Notify after each optimistic update, confirmed update or server rollback. */
  subscribe(channelId: string, onChange: () => void): () => void;
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

const UNAVAILABLE: VoiceMusicState = { status: 'unavailable', reason: 'authenticated-transport-missing' };
export const voiceMusicAdapter: VoiceMusicAdapter = {
  state: () => UNAVAILABLE,
  subscribe: () => () => undefined,
  pause: unavailable, skip: unavailable, stop: unavailable, seek: unavailable,
  setVolume: unavailable, setShuffle: unavailable, setRepeat: unavailable,
  remove: unavailable, move: unavailable,
};

function unavailable(): Promise<never> {
  return Promise.reject(new Error('Authenticated voice music transport is unavailable.'));
}
