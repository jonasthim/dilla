import type { CoreClient } from '../bridge';
import { decode, type CborValue } from '../cbor';

export interface VoiceMusicTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  durationMs: number;
}

export interface VoiceMusicQueueItem { id: string; track: VoiceMusicTrack; }
export interface VoiceMusicSearchResult extends VoiceMusicTrack { input: string; }
export interface VoiceMusicPermissions { control: boolean; manageQueue: boolean; }
export type VoiceMusicErrorCode = 'forbidden' | 'conflict' | 'spotify-unavailable' | 'spotify-busy' | 'unavailable';
export class VoiceMusicError extends Error {
  constructor(readonly code: VoiceMusicErrorCode, message: string) {
    super(message);
    this.name = 'VoiceMusicError';
  }
}
export type VoiceMusicState =
  | { status: 'unavailable'; reason: 'authenticated-transport-missing' | 'bot-unavailable' }
  | { status: 'available'; track: VoiceMusicTrack | null; queue: readonly VoiceMusicQueueItem[]; positionMs: number;
      volume: number; paused: boolean; shuffle: boolean; repeat: 'off' | 'one' | 'all'; permissions: VoiceMusicPermissions };

export interface VoiceMusicAdapter {
  state(channelId: string): VoiceMusicState;
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
  search(channelId: string, query: string): Promise<readonly VoiceMusicSearchResult[]>;
  enqueue(channelId: string, input: string): void | Promise<void>;
}

const MUSIC_OPERATIONS = Array.from({ length: 14 }, (_, i) => i + 10);
const ID = /^[0-9a-f]{32}$/;
const EMPTY: VoiceMusicState = { status: 'unavailable', reason: 'authenticated-transport-missing' };
const adapters = new WeakMap<CoreClient, Map<string, VoiceMusicAdapter>>();

/** One adapter per authenticated client/community, shared by all voice panels in that community. */
export function createVoiceMusicAdapter(client: CoreClient, communityId: string): VoiceMusicAdapter {
  const existing = adapters.get(client)?.get(communityId);
  if (existing !== undefined) return existing;
  if (!ID.test(communityId)) throw new Error('Invalid community id.');
  const states = new Map<string, VoiceMusicState>();
  const revisions = new Map<string, string>();
  const staleChannels = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  const refreshStarted = new Map<string, number>();
  const refreshing = new Set<string>();
  const waiters = new Map<string, { resolve: (response: InteractionResponse) => void; reject: (error: Error) => void }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling: Promise<void> | null = null;

  const publish = (channelId: string, state: VoiceMusicState) => {
    states.set(channelId, state);
    for (const listener of [...(listeners.get(channelId) ?? [])]) listener();
  };
  const poll = async () => {
    if (polling !== null) return polling;
    polling = (async () => {
      const result = await client.call({ m: 'readBotInteractionResponses', communityId, operations: MUSIC_OPERATIONS,
        requestIds: [...waiters.keys()] }) as ReadResult;
      // Apply every returned event before acknowledging the contiguous prefix. The worker leaves any
      // interleaved operation/community unacknowledged, so this reader never advances past another consumer.
      for (const response of result.responses) {
        if (response.operation === 10 && response.status === 0 && response.channelId !== null) {
          const snapshot = decodeSnapshot(response.data);
          revisions.set(response.channelId, snapshot.revision);
          publish(response.channelId, snapshot.state);
        } else if (response.operation === 10 && response.channelId !== null && response.status !== 0) {
          publish(response.channelId, { status: 'unavailable', reason: 'bot-unavailable' });
        }
        waiters.get(response.requestId)?.resolve(response);
      }
      if (result.through !== null) {
        await client.call({ m: 'ackBotInteractionResponses', communityId, through: result.through });
      }
    })().finally(() => { polling = null; });
    return polling;
  };
  const ensurePolling = () => {
    if (timer === null) {
      timer = setInterval(() => {
        void poll().catch(() => undefined);
        for (const channelId of listeners.keys()) {
          if (states.get(channelId)?.status !== 'available' && Date.now() - (refreshStarted.get(channelId) ?? 0) >= 5_000) {
            refreshSubscribed(channelId);
          }
        }
      }, 500);
    }
  };
  const waitFor = async (response: Promise<InteractionResponse>): Promise<InteractionResponse> => {
    ensurePolling();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await poll().catch(() => undefined);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const value = await Promise.race([response, delay(Math.min(200, remaining)).then(() => null)]);
      if (value !== null) return value;
    }
    throw new Error('Timed out waiting for the Bot music response.');
  };
  const request = async (channelId: string, operation: number, args: readonly (string | number | Uint8Array | null)[], revision: string | null) => {
    if (!ID.test(channelId)) throw new Error('Invalid voice channel id.');
    const requestId = newRequestId();
    const resultPromise = new Promise<InteractionResponse>(resolve => waiters.set(requestId, { resolve, reject: () => undefined }));
    try {
      const sent = await client.call({ m: 'humanInteractionRequest', communityId, channelId, requestId, operation, args, revision }) as UploadResult;
      if (sent.upload !== 'accepted') throw new Error(sent.upload === 'pending'
        ? 'The music request is still pending upload.'
        : sent.upload === 'rejected' ? 'The music request was rejected.' : 'The music request upload is unknown.');
      return await waitFor(resultPromise);
    } finally {
      waiters.delete(requestId);
    }
  };
  const refresh = async (channelId: string) => {
    const response = await request(channelId, 10, [], null);
    if (response.status !== 0) throw responseError(response.status);
    if (response.revision === null || response.revision !== revisions.get(channelId)) {
      throw new Error('The Bot music snapshot revision does not match its authenticated operation response.');
    }
    const state = states.get(channelId);
    if (state?.status !== 'available') throw new Error('The Bot did not return a music snapshot.');
    staleChannels.delete(channelId);
  };
  const refreshSubscribed = (channelId: string): void => {
    if (refreshing.has(channelId)) return;
    refreshing.add(channelId);
    refreshStarted.set(channelId, Date.now());
    void refresh(channelId).catch(() => publish(channelId, { status: 'unavailable', reason: 'bot-unavailable' }))
      .finally(() => { refreshing.delete(channelId); });
  };
  const mutate = async (channelId: string, operation: number, args: readonly (string | number | Uint8Array | null)[]) => {
    const current = states.get(channelId);
    if (current?.status !== 'available' || staleChannels.has(channelId)) await refresh(channelId);
    const before = states.get(channelId);
    if (before?.status !== 'available') throw new Error('Music state is unavailable.');
    const result = await request(channelId, operation, args, revisions.get(channelId) ?? null);
    if (result.status === 4) {
      // A conflict means our cached revision is stale. Refresh before rejecting so the next action can proceed.
      staleChannels.add(channelId);
      await refresh(channelId);
      throw responseError(result.status);
    }
    if (result.status !== 0) throw responseError(result.status, operation === 12 && isSpotifyInput(args[0]));
    // A successful operation response is not the accepted state. Wait for an authenticated state read
    // after the operation result so the panel only settles when the server-confirmed snapshot arrives.
    await refresh(channelId);
    if (result.revision !== null) {
      const after = states.get(channelId);
      if (after?.status !== 'available' || BigInt(revisions.get(channelId) ?? '0') < BigInt(result.revision)) {
        throw new Error('The Bot operation succeeded but its resulting music state is not yet visible.');
      }
    }
  };
  const adapter: VoiceMusicAdapter = {
    state: channelId => states.get(channelId) ?? EMPTY,
    subscribe(channelId, onChange) {
      const channelListeners = listeners.get(channelId) ?? new Set<() => void>();
      channelListeners.add(onChange);
      listeners.set(channelId, channelListeners);
      ensurePolling();
      refreshSubscribed(channelId);
      return () => {
        channelListeners.delete(onChange);
        if (channelListeners.size === 0) { listeners.delete(channelId); refreshStarted.delete(channelId); }
        if (listeners.size === 0 && timer !== null) { clearInterval(timer); timer = null; }
      };
    },
    pause: (id, paused) => mutate(id, paused ? 13 : 14, []),
    skip: id => mutate(id, 15, []),
    stop: id => mutate(id, 16, []),
    seek: (id, ms) => mutate(id, 17, [safeInteger(ms, 'seek position')]),
    setVolume: (id, value) => mutate(id, 18, [bounded(value, 0, 100, 'volume')]),
    setShuffle: (id, enabled) => {
      const current = states.get(id);
      return current?.status === 'available' && current.shuffle === enabled ? undefined : mutate(id, 19, []);
    },
    setRepeat: (id, repeat) => mutate(id, 20, [repeat === 'off' ? 0 : repeat === 'one' ? 1 : 2]),
    remove: (id, queueId) => mutate(id, 21, [queueId]),
    search: async (id, query) => {
      const response = await request(id, 11, [validatedInput(query, 200, 'search query')], null);
      if (response.status !== 0) throw responseError(response.status);
      return decodeSearchResults(response.data);
    },
    enqueue: (id, input) => mutate(id, 12, [validatedInput(input, 2048, 'queue input')]),
    move: (id, queueId, destinationIndex) => {
      const state = states.get(id);
      if (state?.status !== 'available') return Promise.reject(new Error('Music state is unavailable.'));
      const queue = state.queue.filter(item => item.id !== queueId);
      const target = Math.max(0, Math.min(queue.length, safeInteger(destinationIndex, 'queue position')));
      const before = queue[target];
      return mutate(id, 22, [queueId, before === undefined ? null : before.id]);
    },
  };
  const communityAdapters = adapters.get(client) ?? new Map<string, VoiceMusicAdapter>();
  communityAdapters.set(communityId, adapter);
  adapters.set(client, communityAdapters);
  return adapter;
}

/** Compatibility export remains unavailable until a page supplies its authenticated CoreClient. */
export const voiceMusicAdapter: VoiceMusicAdapter = {
  state: () => EMPTY, subscribe: () => () => undefined,
  pause: unavailable, skip: unavailable, stop: unavailable, seek: unavailable, setVolume: unavailable,
  setShuffle: unavailable, setRepeat: unavailable, remove: unavailable, move: unavailable,
  search: unavailable, enqueue: unavailable,
};

interface InteractionResponse { requestId: string; channelId: string | null; operation: number; status: number; revision: string | null; data: Uint8Array; }
interface ReadResult { responses: InteractionResponse[]; through: string | null; blocked: boolean; }
interface UploadResult { upload: 'accepted' | 'pending' | 'rejected' | 'unknown'; }
function unavailable(): Promise<never> { return Promise.reject(new Error('Authenticated voice music transport is unavailable.')); }
function responseError(status: number, spotifyInput = false): Error {
  if (spotifyInput && status === 5) return new VoiceMusicError('spotify-unavailable', 'Spotify is unavailable or not linked for this community.');
  if (spotifyInput && status === 6) return new VoiceMusicError('spotify-busy', 'Spotify playback is already active in another voice channel.');
  return status === 2 ? new VoiceMusicError('forbidden', 'You do not have permission to control this Bot.')
    : status === 4 ? new VoiceMusicError('conflict', 'Music state changed. Refresh and try again.')
      : new VoiceMusicError('unavailable', 'The Bot could not complete the music request.');
}
function isSpotifyInput(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (/^spotify:(?:track|album|playlist):/iu.test(value.trim())) return true;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'spotify.link' || host === 'spotify.com' || host.endsWith('.spotify.com');
  } catch { return false; }
}
function delay(ms: number): Promise<null> { return new Promise(resolve => setTimeout(() => resolve(null), ms)); }
function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  if (bytes.every(value => value === 0)) bytes[15] = 1;
  return toHex(bytes);
}
function toHex(bytes: Uint8Array): string { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''); }
function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}.`);
  return value;
}
function bounded(value: number, min: number, max: number, label: string): number {
  const number = safeInteger(value, label);
  if (number < min || number > max) throw new Error(`Invalid ${label}.`);
  return number;
}
function field(row: CborValue[], index: number): CborValue {
  const value = row[index];
  if (value === undefined) throw new Error('Malformed music snapshot.');
  return value;
}
function array(value: CborValue, length?: number): CborValue[] {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)) throw new Error('Malformed music snapshot.');
  return value;
}
function uint(value: CborValue, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'bigint' || value > BigInt(max)) throw new Error('Malformed music snapshot.');
  return Number(value);
}
function text(value: CborValue): string {
  if (typeof value !== 'string') throw new Error('Malformed music snapshot.');
  return value;
}
function track(value: CborValue): VoiceMusicTrack | null {
  if (value === null) return null;
  const row = array(value, 8);
  const provider = text(field(row, 1));
  const canonicalId = text(field(row, 2));
  const itemId = text(field(row, 0));
  const supported = provider === 'youtube' && /^[A-Za-z0-9_-]{11}$/u.test(canonicalId)
    || provider === 'spotify' && /^spotify:track:[A-Za-z0-9]{22}$/u.test(canonicalId);
  if (!supported || !ID.test(itemId)) throw new Error('Unsupported music track.');
  const album = text(field(row, 5));
  const result: VoiceMusicTrack = { id: itemId, title: text(field(row, 3)), artist: text(field(row, 4)), durationMs: uint(field(row, 6)) };
  if (album !== '') result.album = album;
  return result;
}
function decodeSnapshot(data: Uint8Array): { state: VoiceMusicState; revision: string } {
  const row = array(decode(data), 10);
  if (uint(field(row, 0), 1) !== 1) throw new Error('Unsupported music snapshot version.');
  const revisionValue = field(row, 1);
  if (typeof revisionValue !== 'bigint') throw new Error('Malformed music snapshot.');
  const revision = revisionValue.toString();
  const current = track(field(row, 2));
  const queue = array(field(row, 3)).map(value => {
    const decoded = track(value);
    if (decoded === null) throw new Error('Malformed music queue.');
    return { id: decoded.id, track: decoded };
  });
  const repeat = uint(field(row, 8), 2);
  const canControl = uint(field(row, 9), 1) === 1;
  return { revision, state: { status: 'available', track: current, queue, positionMs: uint(field(row, 4)), paused: uint(field(row, 5), 1) === 1,
    volume: uint(field(row, 6), 100), shuffle: uint(field(row, 7), 1) === 1,
    repeat: repeat === 0 ? 'off' : repeat === 1 ? 'one' : 'all', permissions: { control: canControl, manageQueue: canControl } } };
}
function decodeSearchResults(data: Uint8Array): VoiceMusicSearchResult[] {
  const result = array(decode(data), 2);
  if (uint(field(result, 0), 1) !== 1) throw new Error('Unsupported music search response.');
  return array(field(result, 1)).map(value => {
    const row = array(value, 8);
    const id = text(field(row, 0));
    const provider = text(field(row, 1));
    const canonicalId = text(field(row, 2));
    const requesterId = text(field(row, 7));
    if (provider !== 'youtube' || !/^[A-Za-z0-9_-]{11}$/u.test(canonicalId) || id !== `yt:${canonicalId}`) {
      throw new Error('Unsupported music search result.');
    }
    if (requesterId !== '') throw new Error('Malformed music search result.');
    const album = text(field(row, 5));
    const track: VoiceMusicSearchResult = {
      id, title: text(field(row, 3)), artist: text(field(row, 4)), durationMs: uint(field(row, 6)),
      input: `https://www.youtube.com/watch?v=${canonicalId}`,
    };
    if (album !== '') track.album = album;
    return track;
  });
}
function validatedInput(value: string, limit: number, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || new TextEncoder().encode(trimmed).length > limit || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new Error(`Invalid music ${label}.`);
  }
  return trimmed;
}
