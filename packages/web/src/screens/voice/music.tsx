// Task 8b (Signal README §6.6, §9): the one music player state the three NowPlaying views read. It is the Bot's authenticated
// music snapshot for the voice channel of this device's call (client-core's per-community adapter, one store per channel), read
// while the Bot is in that call. Nothing here invents a value the snapshot does not carry: the position is the snapshot's
// (the Bot records it at a seek or a track change, not as it plays), the requester is the member the Bot recorded.
import { useCallback, useEffect, useState } from 'react';
import { createVoiceMusicAdapter, type CoreClient, type MemberSummary, type TrustSummary, type VoiceMusicState, type VoiceMusicTrack } from '@dilla/client-core';
import { NowPlaying, type NowPlayingProps } from '@dilla/ui';
import { en, t } from '../../strings/index.ts';
import { userName } from '../shell-model.ts';

/** NowPlaying's props for one player, without the variant; a control returns the adapter's promise (MusicPlayer reports a refusal). */
export type MusicPlayerView = Omit<NowPlayingProps, 'variant' | 'onToggle' | 'onSkip' | 'onStop'> & {
  onToggle: () => Promise<void> | void; onSkip: () => Promise<void> | void; onStop: () => Promise<void> | void;
};

/** How often the open player re-reads the Bot's snapshot (the adapter re-reads on its own only while unavailable). */
export const MUSIC_REFRESH_MS = 10_000;

export const MUSIC_LABELS = (): NowPlayingProps['labels'] => ({
  region: t('music.region'), playing: t('music.playing'), paused: t('music.paused'), stopped: t('music.stopped'), idle: t('music.idle'),
  play: t('music.play'), pause: t('music.pause'), skip: t('music.skip'), stop: t('music.stop'),
  // The templates go as they are: NowPlaying fills {pos}, {dur} and {n}.
  position: t('music.position'), positionValue: en['music.positionValue'], queue: en['music.queue'], upNext: en['music.upNext'],
  volume: en['music.volume'], volumeName: t('music.volumeName'), queueList: t('music.queueList'),
});

function useMusicState(client: CoreClient, communityId: string | null, channelId: string | null): VoiceMusicState | null {
  const [state, setState] = useState<VoiceMusicState | null>(null);
  useEffect(() => {
    setState(null);
    if (communityId === null || channelId === null) return;
    let adapter: ReturnType<typeof createVoiceMusicAdapter>;
    try { adapter = createVoiceMusicAdapter(client, communityId); } catch { return; }
    const read = () => setState(adapter.state(channelId));
    const unsubscribe = adapter.subscribe(channelId, read);
    read();
    const timer = setInterval(() => { void adapter.refresh(channelId).catch(() => undefined); }, MUSIC_REFRESH_MS);
    return () => { clearInterval(timer); unsubscribe(); };
  }, [client, communityId, channelId]);
  return state;
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
 * The player for this device's call: null without a call in a community, without the Bot in it, or while the Bot's music
 * state is unavailable. Controls act through the adapter (they are only live with the Bot's control grant, which already
 * requires being in this call).
 */
export function useMusicPlayer({ client, communityId, channelId, room, bot, members, trust }: MusicPlayerInput): MusicPlayerView | null {
  const state = useMusicState(client, bot === null ? null : communityId, bot === null ? null : channelId);
  const adapter = communityId === null ? null : (() => { try { return createVoiceMusicAdapter(client, communityId); } catch { return null; } })();
  const paused = state?.status === 'available' ? state.paused : true;
  const onToggle = useCallback(() => (adapter !== null && channelId !== null ? adapter.pause(channelId, !paused) : undefined), [adapter, channelId, paused]);
  const onSkip = useCallback(() => (adapter !== null && channelId !== null ? adapter.skip(channelId) : undefined), [adapter, channelId]);
  const onStop = useCallback(() => (adapter !== null && channelId !== null ? adapter.stop(channelId) : undefined), [adapter, channelId]);
  if (state === null || state.status !== 'available' || bot === null) return null;
  const requester = (track: VoiceMusicTrack) => (track.requesterId === undefined ? '' : userName(track.requesterId, members, trust));
  const current = state.track;
  const source = (track: VoiceMusicTrack) => t(track.provider === 'spotify' ? 'music.source.spotify' : 'music.source.youtube');
  const meta = current === null ? t('music.idleIn', { bot, room })
    : current.requesterId === undefined ? t('music.metaNoRequester', { source: source(current), room })
      : t('music.meta', { source: source(current), name: requester(current), room });
  return {
    ...(current === null ? {} : { track: { title: current.title, by: requester(current), durationS: current.durationMs / 1000 } }),
    positionS: state.positionMs / 1000, playing: !state.paused, room, meta, volume: state.volume, bot: { name: bot },
    canControl: state.permissions.control,
    blocked: state.permissions.control ? t('music.blocked.join', { room }) : t('music.blocked.dj'),
    queue: [
      ...(current === null ? [] : [{ title: current.title, by: requester(current), durationS: current.durationMs / 1000, current: true }]),
      ...state.queue.map(item => ({ title: item.track.title, by: requester(item.track), durationS: item.track.durationMs / 1000 })),
    ],
    onToggle, onSkip, onStop, labels: MUSIC_LABELS(),
  };
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
