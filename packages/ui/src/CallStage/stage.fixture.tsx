// Task 8 (restyle rule 3d): the voice stage as packages/web/src/screens/voice/VoiceView.tsx composes it in Signal, with the
// prototype's sample room (harbour: Ada and Kari share, Björn and Kari have cameras, Ole, Mira (you), Glenn the bot). The props
// are the ones the web passes: `bar` (the room and the stats line), the call bar's words (`labels.bar`), `labels.grid`, the
// tile ids `${device}:person` / `${device}:screen`, "{name} (you)" and "{name} · playback only", and the not-joined `preview`.
import { useEffect, useState, type ReactNode } from 'react';
import { CallStage, type CallStageProps } from './CallStage.tsx';
import { CallControls, type CallControlsProps } from '../CallControls/CallControls.tsx';
import type { CallTileProps, VoiceParticipantView } from '../CallTile/CallTile.tsx';
import { ChannelHeader } from '../ChannelHeader/ChannelHeader.tsx';

const noop = () => {};
export const STAGE_STATE: CallTileProps['labels']['state'] = {
  speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream',
  connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot', noSound: 'no sound',
};
export const STAGE_LABELS: CallStageProps['labels'] = {
  code: 'call code', empty: 'Nobody is in voice yet.', tiles: 'people in voice', grid: 'Grid',
  codeHelp: 'The code changes whenever someone joins or leaves. Read it aloud: if every screen shows the same code, everyone is hearing the same set of devices.',
};
/** VoiceView `Controls` for a channel: the region, the names, why, and the call bar's words. */
export const BAR_CONTROL_LABELS: CallControlsProps['labels'] = {
  region: 'voice channel controls', mute: 'mute', deafen: 'deafen', camera: 'camera', share: 'share screen', leave: 'leave',
  why: { paused: 'paused', joining: 'connecting', noShare: 'not available in this browser' },
  bar: { mute: 'Mute', unmute: 'Unmute', deafen: 'Deafen', undeafen: 'Undeafen', camera: 'Camera', share: 'Share', stopShare: 'Stop sharing', leave: 'Leave' },
};

export function stageControls(more: Partial<CallControlsProps> = {}): ReactNode {
  return (
    <CallControls muted={false} deafened={false} camera={false} sharing={false} canCamera canShare busy={false} paused={false}
      labels={BAR_CONTROL_LABELS} shortcuts={{ mute: '⌘⇧M', deafen: '⌘⇧D' }} keyshortcuts={false}
      onMute={noop} onDeafen={noop} onCamera={noop} onShare={noop} onLeave={noop} {...more} />
  );
}

type StageTile = CallStageProps['tiles'][number];
const view = (name: string, more: Partial<VoiceParticipantView> = {}): VoiceParticipantView => ({
  deviceId: `d-${name}`, userId: `u-${name}`, name, state: 'ok', speaking: false, muted: false, deafened: false,
  video: false, screen: false, web: false, bot: false, ...more,
});
const labels = (name: string): CallTileProps['labels'] => ({ state: STAGE_STATE, volume: `volume for ${name}`, volumeValue: '{n} %' });

/** A person's tile as VoiceView's deviceTiles makes it: camera with a stream, else avatar; one id either way. */
export function personTile(name: string, more: Partial<VoiceParticipantView> & { own?: boolean; title?: string } = {}): StageTile {
  const { own = false, title, ...v } = more;
  const vw = view(name, v);
  return { view: vw, own, volume: 100, media: null, labels: labels(name), onVolume: noop, id: `${vw.deviceId}:person`,
    source: vw.video ? 'camera' : 'avatar', title: title ?? name, fullscreenLabel: 'full screen', mirror: own && vw.video };
}
export function screenTile(name: string): StageTile {
  const vw = view(name, { screen: true });
  return { view: vw, own: false, volume: 100, media: null, labels: labels(name), onVolume: noop, id: `${vw.deviceId}:screen`,
    source: 'screen', title: `${name}’s screen`, fullscreenLabel: 'full screen', mirror: false };
}

/** The prototype's harbour, joined: the two shares first, then the people in the room's order, Mira (you) and Glenn last. */
export function harbourTiles(speaking: string | null = null): StageTile[] {
  const s = (n: string) => (speaking === n ? { speaking: true } : {});
  return [
    screenTile('Ada'), screenTile('Kari'),
    personTile('Ada', s('Ada')), personTile('Björn', { video: true, ...s('Björn') }), personTile('Kari', { video: true, ...s('Kari') }),
    personTile('Ole', s('Ole')), personTile('Mira', { own: true, title: 'Mira (you)', ...s('Mira') }),
    personTile('Glenn', { bot: true, title: 'Glenn · playback only', ...s('Glenn') }),
  ];
}

/**
 * A stand-in picture drawn once on a canvas at story time: a share is the prototype's 135° stripe on the tile colour, a camera
 * the stripe over a dim radial glow of the person's hue. Its tracks stop on unmount.
 */
export function useDrawnStream(kind: 'screen' | 'camera', hue = 211): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null);
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#0E1116'; ctx.fillRect(0, 0, 640, 360);
    if (kind === 'camera') {
      const g = ctx.createRadialGradient(320, 126, 0, 320, 126, 480);
      g.addColorStop(0, `hsl(${String(hue)} 30% 20%)`); g.addColorStop(0.75, '#0C0F13');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 640, 360);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 16 / Math.SQRT2;
    for (let x = -360; x < 1000; x += 16 * Math.SQRT2) { ctx.beginPath(); ctx.moveTo(x, 360); ctx.lineTo(x + 360, 0); ctx.stroke(); }
    const s = canvas.captureStream(1);
    setStream(s);
    return () => { s.getTracks().forEach(t => t.stop()); };
  }, [kind, hue]);
  return stream;
}

/** The tiles with the drawn pictures the web would attach (a share's stream, a camera's), as remote verified streams. */
export function WithPictures({ tiles, children }: { tiles: readonly StageTile[]; children: (tiles: StageTile[]) => ReactNode }) {
  const screen = useDrawnStream('screen');
  const bjorn = useDrawnStream('camera', 211);
  const kari = useDrawnStream('camera', 12);
  const media = (t: StageTile): MediaStream | null => t.source === 'screen' ? screen : t.source === 'camera' ? (t.view.name === 'Kari' ? kari : bjorn) : null;
  return <>{children(tiles.map(t => ({ ...t, media: media(t) })))}</>;
}

/** The voice header the web passes on desktop (Ruling Z: the name and its topic, no controls). */
export const harbourHeader = (topic: string) => <ChannelHeader kind="voice" name="harbour" topic={topic} />;

/** The stage of a joined channel, as VoiceView's Stage renders it, with its own focus state. */
export function HarbourStage({ tiles, focus = null, controls, header = true, stats = '24 ms · ↑ 38 ↓ 71 kb/s · hearing 5 of 5', topic = '6 in voice',
  name = 'harbour' }: {
  tiles: readonly StageTile[]; focus?: string | null; controls?: ReactNode; header?: boolean; stats?: string; topic?: string; name?: string;
}) {
  const [focusedId, setFocusedId] = useState<string | null>(focus);
  return (
    <WithPictures tiles={tiles}>
      {pictured => (
        <CallStage title={`voice ${name}`} tiles={pictured} {...(header ? { header: <ChannelHeader kind="voice" name={name} topic={topic} /> } : {})}
          focusedId={focusedId} onFocus={setFocusedId} code={null} notice={null} outgoing={null}
          bar={{ name, stats }} controls={controls ?? stageControls()} labels={STAGE_LABELS} />
      )}
    </WithPictures>
  );
}

/** The not-joined preview of harbour, as VoiceView passes it (who is inside, the room, Join voice). */
export function HarbourPreview({ header = true }: { header?: boolean }) {
  return (
    <CallStage title="voice harbour" tiles={[]} {...(header ? { header: harbourHeader('voice channel') } : {})} code={null} notice={null} outgoing={null}
      controls={null} labels={STAGE_LABELS}
      preview={{ name: 'harbour', text: 'Ada and Björn and Kari and Ole and Glenn are here', join: { label: 'Join voice', onJoin: noop },
        people: ['Ada', 'Björn', 'Kari', 'Ole', 'Glenn'].map(n => ({ id: n, name: n, speaking: false, bot: n === 'Glenn' })) }} />
  );
}
