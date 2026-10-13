import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { CallStage, type CallStageProps } from './CallStage.tsx';
import { CallControls, type CallControlsProps } from '../CallControls/CallControls.tsx';
import type { CallTileProps, VoiceParticipantView } from '../CallTile/CallTile.tsx';

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9).
const STATE: CallTileProps['labels']['state'] = {
  speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream',
  connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot',
};
const CONTROL_LABELS: CallControlsProps['labels'] = {
  region: 'call controls', mute: 'mute', unmute: 'unmute', deafen: 'deafen', undeafen: 'undeafen', cameraOn: 'camera',
  cameraOff: 'stop camera', shareOn: 'share screen', shareOff: 'stop sharing', leave: 'leave',
};
const noop = () => {};
const controls = (more: Partial<CallControlsProps> = {}) => (
  <CallControls muted={false} deafened={false} camera={false} sharing={false} canCamera canShare busy={false} labels={CONTROL_LABELS}
    onMute={noop} onDeafen={noop} onCamera={noop} onShare={noop} onLeave={noop} {...more} />
);
function tile(name: string, more: Partial<VoiceParticipantView> = {}, own = false): CallTileProps {
  return {
    view: { deviceId: `d-${name}`, userId: `u-${name}`, name, state: 'ok', speaking: false, muted: false, deafened: false,
      video: false, screen: false, web: true, bot: false, ...more },
    own, volume: 100, media: null, labels: { state: STATE, volume: `volume for ${name}` }, onVolume: noop,
  };
}
const TILES = [tile('ada', { speaking: true }), tile('bo', { muted: true }), tile('you', {}, true)];
const LABELS: CallStageProps['labels'] = {
  code: 'call code',
  codeHelp: 'The code changes whenever someone joins or leaves. Read it aloud: if every screen shows the same code, everyone is hearing the same set of devices.',
  empty: 'Nobody is in voice yet.', tiles: 'people in voice',
};
const PAUSED = 'ada’s identity changed, so this call is paused for you: nothing you say is sent and nothing is played. Compare safety numbers in Privacy to continue, or wait until ada leaves.';

/** A 16:9 stream drawn on a canvas at story time (a stand-in camera); its tracks stop on unmount. */
function useDrawnStream(): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null);
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#1A1E22'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#A0A6A0'; ctx.beginPath(); ctx.arc(160, 80, 34, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(100, 124, 120, 56);
    const s = canvas.captureStream(5);
    setStream(s);
    return () => { s.getTracks().forEach(t => t.stop()); };
  }, []);
  return stream;
}

/** The stage with a drawn camera on ada's tile. */
function WithCamera(props: CallStageProps) {
  const media = useDrawnStream();
  return <CallStage {...props} tiles={props.tiles.map((t, i) => (i === 0 ? { ...t, media, view: { ...t.view, video: true } } : t))} />;
}

const meta = {
  title: 'Voice/CallStage', component: CallStage,
  args: { title: 'voice harbour', tiles: TILES, code: '284719306451873920465128390715', notice: null, controls: controls(), outgoing: null, labels: LABELS },
  decorators: [Story => <div style={{ maxWidth: 960 }}><Story /></div>],
} satisfies Meta<typeof CallStage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = {};
/** No one in voice: the stage says so. */
export const Empty: Story = { args: { tiles: [], code: null } };
/** Joining: the controls appear but stay aria-disabled, and the tiles are connecting. */
export const Joining: Story = {
  args: { tiles: [tile('ada', { state: 'connecting' }), tile('you', { state: 'connecting' }, true)], code: null, controls: controls({ busy: true }) },
};
export const Camera: Story = { render: args => <WithCamera {...args} /> };
/** The call code opened: six groups of five digits and the help under them. */
export const CodeOpen: Story = {
  play: ({ canvasElement }) => {
    const summary = canvasElement.querySelector('summary');
    if (!summary) throw new Error('CodeOpen: no call code disclosure');
    summary.click();
  },
};
/** RV-3: paused on this device. The banner and its action, no media in any tile, camera and share aria-disabled. */
export const Paused: Story = {
  args: {
    notice: { text: PAUSED, action: { label: 'compare safety numbers', onAction: noop }, focusOnce: true },
    controls: controls({ canCamera: false, canShare: false }),
  },
  render: args => <WithCamera {...args} />,
};
/** Blocked at join: the notice takes focus once; there is no join until the cause is gone. */
export const BlockedJoin: Story = {
  args: { tiles: [], code: null, controls: null,
    notice: { text: 'A device in this voice failed the identity check. Joining is paused until it is removed.', action: null, focusOnce: true } },
};
export const Unverified: Story = { args: { tiles: [tile('ada', { state: 'unverified' }), tile('bo', { state: 'not-heard' }), tile('you', {}, true)] } };
/** A DM call ringing others: the strip text under the heading, no ringback tone. */
export const DmRinging: Story = {
  args: { title: 'ada', outgoing: { text: 'ringing ada' }, tiles: [tile('you', {}, true)], code: null },
};
export const DmDeclined: Story = { args: { title: 'ada', outgoing: { text: 'ada declined.' }, tiles: [tile('you', {}, true)], code: null } };
