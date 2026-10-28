// Task 8b (Signal README §6.6, §9): the one music player state the three NowPlaying views read. It is the Bot's authenticated
// music snapshot for one voice channel (client-core's per-community adapter keeps one store per channel), read while the Bot is
// in that channel's call. Nothing here invents a value the snapshot does not carry: the requester is the member the Bot
// recorded, and the playhead runs on only from the Bot's own stamp (Ruling AI; an older Bot's snapshot stays static).
import { useCallback, useEffect, useState } from 'react';
import { createVoiceMusicAdapter, musicPlayheadMs, type CoreClient, type MemberSummary, type TrustSummary, type VoiceMusicAdapter,
  type VoiceMusicState, type VoiceMusicTrack } from '@dilla/client-core';
import { NowPlaying, type NowPlayingProps } from '@dilla/ui';
import { en, t } from '../../strings/index.ts';
import { userName } from '../shell-model.ts';
import { useSlice } from '../../core/use-slice.ts';

/** NowPlaying's props for one player, without the variant; a control returns the adapter's promise (MusicPlayer reports a refusal). */
export type MusicPlayerView = Omit<NowPlayingProps, 'variant' | 'onToggle' | 'onSkip' | 'onStop'> & {
  onToggle: () => Promise<void> | void; onSkip: () => Promise<void> | void; onStop: () => Promise<void> | void;
};

/**
 * Fix round 1 (item 3): the Bot has no push for music changes (interaction responses answer requests; nothing streams state),
 * so an open player re-reads the snapshot every 10 s as the fallback. One timer per channel, however many views read it.
 */
export const MUSIC_REFRESH_MS = 10_000;

export const MUSIC_LABELS = (): NowPlayingProps['labels'] => ({
  region: t('music.region'), playing: t('music.playing'), paused: t('music.paused'), stopped: t('music.stopped'), idle: t('music.idle'),
  play: t('music.play'), pause: t('music.pause'), skip: t('music.skip'), stop: t('music.stop'),
  // The templates go as they are: NowPlaying fills {pos}, {dur} and {n}.
  position: t('music.position'), positionValue: en['music.positionValue'], queue: en['music.queue'], upNext: en['music.upNext'],
  volume: en['music.volume'], volumeName: t('music.volumeName'), queueList: t('music.queueList'),
});

function adapterFor(client: CoreClient, communityId: string | null): VoiceMusicAdapter | null {
  if (communityId === null) return null;
  try { return createVoiceMusicAdapter(client, communityId); } catch { return null; }
}

const refreshers = new WeakMap<VoiceMusicAdapter, Map<string, { count: number; timer: ReturnType<typeof setInterval> }>>();
/** One 10 s re-read per (adapter, channel) while any view holds it. */
function holdRefresh(adapter: VoiceMusicAdapter, channelId: string): () => void {
  let channels = refreshers.get(adapter);
  if (channels === undefined) { channels = new Map(); refreshers.set(adapter, channels); }
  const held = channels.get(channelId);
  if (held !== undefined) held.count++;
  else channels.set(channelId, { count: 1, timer: setInterval(() => { void adapter.refresh(channelId).catch(() => undefined); }, MUSIC_REFRESH_MS) });
  return () => {
    const row = channels.get(channelId);
    if (row === undefined) return;
    if (--row.count === 0) { clearInterval(row.timer); channels.delete(channelId); }
  };
}

function useMusicState(client: CoreClient, communityId: string | null, channelId: string | null): VoiceMusicState | null {
  const [state, setState] = useState<VoiceMusicState | null>(null);
  useEffect(() => {
    setState(null);
    const adapter = adapterFor(client, communityId);
    if (adapter === null || channelId === null) return;
    const read = () => setState(adapter.state(channelId));
    const unsubscribe = adapter.subscribe(channelId, read);
    read();
    const release = holdRefresh(adapter, channelId);
    return () => { release(); unsubscribe(); };
  }, [client, communityId, channelId]);
  return state;
}

/** Ruling AI: a 1 s clock while the playhead runs (a playing track with the Bot's stamp); idle otherwise. */
function usePlayheadNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

interface ViewInput {
  state: VoiceMusicState | null; room: string; bot: string; members: readonly MemberSummary[]; trust: readonly TrustSummary[] | undefined;
  /** This device is in the player's voice call (else a press says "Join {room} to control playback"). */
  inCall: boolean; now: number;
  onToggle: () => Promise<void> | void; onSkip: () => Promise<void> | void; onStop: () => Promise<void> | void;
}

function musicView({ state, room, bot, members, trust, inCall, now, onToggle, onSkip, onStop }: ViewInput): MusicPlayerView {
  const base = { room, bot: { name: bot }, onToggle, onSkip, onStop, labels: MUSIC_LABELS() };
  if (state === null || state.status !== 'available') {
    // The Bot is not playing in that room any more: the prototype's "Glenn left voice".
    return { ...base, positionS: 0, playing: false, meta: t('music.left', { bot }), canControl: false,
      blocked: inCall ? t('music.blocked.dj') : t('music.blocked.join', { room }), queue: [] };
  }
  const requester = (track: VoiceMusicTrack) => (track.requesterId === undefined ? '' : userName(track.requesterId, members, trust));
  const current = state.track;
  const source = (track: VoiceMusicTrack) => t(track.provider === 'spotify' ? 'music.source.spotify' : 'music.source.youtube');
  const meta = current === null ? t('music.idleIn', { bot, room })
    : current.requesterId === undefined ? t('music.metaNoRequester', { source: source(current), room })
      : t('music.meta', { source: source(current), name: requester(current), room });
  return {
    ...base,
    ...(current === null ? {} : { track: { title: current.title, by: requester(current), durationS: current.durationMs / 1000 } }),
    positionS: musicPlayheadMs(state, now) / 1000, playing: !state.paused, meta, volume: state.volume,
    canControl: state.permissions.control,
    blocked: inCall ? t('music.blocked.dj') : t('music.blocked.join', { room }),
    queue: [
      ...(current === null ? [] : [{ title: current.title, by: requester(current), durationS: current.durationMs / 1000, current: true }]),
      ...state.queue.map(item => ({ title: item.track.title, by: requester(item.track), durationS: item.track.durationMs / 1000 })),
    ],
  };
}

function useChannelPlayer(client: CoreClient, communityId: string | null, channelId: string | null, read: boolean) {
  const state = useMusicState(client, read ? communityId : null, read ? channelId : null);
  const adapter = adapterFor(client, communityId);
  const paused = state?.status === 'available' ? state.paused : true;
  const running = state?.status === 'available' && state.track !== null && !state.paused && state.clock !== undefined;
  const now = usePlayheadNow(running);
  const onToggle = useCallback(() => (adapter !== null && channelId !== null ? adapter.pause(channelId, !paused) : undefined), [adapter, channelId, paused]);
  const onSkip = useCallback(() => (adapter !== null && channelId !== null ? adapter.skip(channelId) : undefined), [adapter, channelId]);
  const onStop = useCallback(() => (adapter !== null && channelId !== null ? adapter.stop(channelId) : undefined), [adapter, channelId]);
  return { state, now, onToggle, onSkip, onStop };
}

export interface MusicPlayerInput {
  client: CoreClient;
  /** The community of the call's voice channel; null for a DM call or no call. */
  communityId: string | null;
  /** The call's voice channel; null without a call. */
  channelId: string | null;
  /** The voice channel's name (the player's room). */
  room: string;
  /** The Bot's name while it is in that call; null while it is not (then there is no player to read). */
  bot: string | null;
  members: readonly MemberSummary[];
  trust: readonly TrustSummary[] | undefined;
}

/**
 * The player for this device's call (the dock row and the stage bar): null without a call in a community, without the Bot in
 * it, or while the Bot's music state is unavailable.
 */
export function useMusicPlayer({ client, communityId, channelId, room, bot, members, trust }: MusicPlayerInput): MusicPlayerView | null {
  const player = useChannelPlayer(client, communityId, channelId, bot !== null);
  if (player.state === null || player.state.status !== 'available' || bot === null) return null;
  return musicView({ ...player, room, bot, members, trust, inCall: true });
}

export interface MusicCardInput extends Omit<MusicPlayerInput, 'bot'> {
  /** The Bot's name (the message's author). */
  bot: string;
  /** The Bot is in that voice channel's call now (else the card says it left voice). */
  botInRoom: boolean;
  /** This device is in that voice channel's call. */
  inCall: boolean;
}

/** The card on Glenn's "started music" message: the same player state, read while the Bot is in that room. */
export function useMusicCard({ client, communityId, channelId, room, bot, botInRoom, inCall, members, trust }: MusicCardInput): MusicPlayerView {
  const player = useChannelPlayer(client, communityId, channelId, botInRoom);
  return musicView({ ...player, state: botInRoom ? player.state : null, room, bot, members, trust, inCall });
}

/**
 * One view of the player. A control the Bot refuses (or that fails) says why in the player's toast; the control's promise
 * settles when the Bot's confirmed snapshot has arrived (the adapter refreshes after every mutation).
 */
export function MusicPlayer({ view, variant }: { view: MusicPlayerView; variant: NowPlayingProps['variant'] }) {
  const [toast, setToast] = useState<{ text: string; id: number } | undefined>(undefined);
  const run = (action: () => unknown) => () => {
    void Promise.resolve().then(action).catch((error: unknown) => {
      setToast(prev => ({ text: error instanceof Error ? error.message : t('music.blocked.dj'), id: (prev?.id ?? 0) + 1 }));
    });
  };
  return <NowPlaying {...view} variant={variant} {...(toast === undefined ? {} : { toast })}
    onToggle={run(view.onToggle)} onSkip={run(view.onSkip)} onStop={run(view.onStop)} />;
}

/** The player marker Glenn's public "started music" message ends with: the voice channel and the requester. */
const MARKER = /\n?\[dilla-music:v1:([0-9a-f]{32}):([0-9a-f]{32})\]$/u;
export function musicMarker(body: string): { voiceChannelId: string; requesterId: string } | null {
  const match = MARKER.exec(body);
  return match === null ? null : { voiceChannelId: match[1], requesterId: match[2] };
}

/**
 * Jonas 2026-10-28: the card on Glenn's public "started music" message in the channel where /play ran. It reads the same player
 * state as the dock row and the stage bar, for the voice channel the marker names, while the Bot is in that room.
 */
export function MusicMessageCard({ client, communityId, voiceChannelId, bot }: { client: CoreClient; communityId: string | null; voiceChannelId: string; bot: string }) {
  const voice = useSlice('voice');
  const call = useSlice('call');
  const trust = useSlice('trust');
  const members = useSlice(`members:${communityId ?? ''}`) ?? [];
  const room = useMusicRoom(communityId, voiceChannelId);
  const botInRoom = voice?.[voiceChannelId]?.participants.some(p => p.bot) === true;
  const view = useMusicCard({ client, communityId, channelId: voiceChannelId, room, bot, botInRoom, inCall: call?.channelId === voiceChannelId, members, trust });
  return <MusicPlayer view={view} variant="card" />;
}

/** The voice channel's name (the player's room); its id's start while the channel list has not arrived. */
export function useMusicRoom(communityId: string | null, voiceChannelId: string): string {
  const channels = useSlice(`channels:${communityId ?? ''}`);
  return channels?.find(c => c.id === voiceChannelId)?.name ?? voiceChannelId.slice(0, 8);
}
