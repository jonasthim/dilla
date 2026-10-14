import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { CallTile, type CallTileProps } from './CallTile.tsx';
import { expectVoiceTargets } from '../CallControls/CallControls.stories.tsx';

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9).
const LABELS: CallTileProps['labels'] = {
  state: {
    speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream',
    connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot',
  },
  volume: 'volume for ada',
  volumeValue: '{n} %',
};
const VIEW: CallTileProps['view'] = {
  deviceId: 'd1', userId: 'u1', name: 'ada', state: 'ok', speaking: false, muted: false, deafened: false,
  video: false, screen: false, web: true, bot: false,
};

/** A 16:9 stream drawn on a canvas at story time (a stand-in camera); its tracks stop on unmount. */
function useDrawnStream(): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null);
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const gradient = ctx.createLinearGradient(0, 0, 320, 180);
    gradient.addColorStop(0, '#1A1E22'); gradient.addColorStop(1, '#363B41');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#A0A6A0'; ctx.beginPath(); ctx.arc(160, 80, 34, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(100, 124, 120, 56);
    const s = canvas.captureStream(5);
    setStream(s);
    return () => { s.getTracks().forEach(t => t.stop()); };
  }, []);
  return stream;
}

function WithCamera(props: CallTileProps) {
  const media = useDrawnStream();
  return <CallTile {...props} media={media} />;
}

/** Product walk I2 and I3: a screen with the camera as its inset; `mirror` names the own camera's element. */
function WithScreenAndCamera(props: CallTileProps) {
  const screen = useDrawnStream();
  const camera = useDrawnStream();
  return <CallTile {...props} media={screen} inset={camera} />;
}

const meta = {
  title: 'Voice/CallTile', component: CallTile,
  args: { view: VIEW, own: false, volume: 100, media: null, labels: LABELS, onVolume: () => {} },
  decorators: [Story => <div style={{ width: 280 }}><Story /></div>],
  // The volume range is a voice control: 40 px high, 44 px on a phone (flow 06).
  play: ({ canvasElement }) => { expectVoiceTargets(canvasElement, 'CallTile'); },
} satisfies Meta<typeof CallTile>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = {};
export const Speaking: Story = { args: { view: { ...VIEW, speaking: true } } };
export const MutedAndDeafened: Story = { args: { view: { ...VIEW, name: 'bo', muted: true, deafened: true }, labels: { ...LABELS, volume: 'volume for bo' } } };
export const Connecting: Story = { args: { view: { ...VIEW, state: 'connecting' } } };
export const NotHeard: Story = { args: { view: { ...VIEW, state: 'not-heard' } } };
/** An unverified stream: the tile says so and never attaches the stream, even when one is given. */
export const Unverified: Story = { args: { view: { ...VIEW, state: 'unverified', video: true } }, render: args => <WithCamera {...args} /> };
export const Own: Story = { args: { view: { ...VIEW, name: 'you', deviceId: 'd0', userId: 'u0' }, own: true } };
export const Camera: Story = { args: { view: { ...VIEW, video: true, speaking: true } }, render: args => <WithCamera {...args} /> };
export const SharingScreen: Story = { args: { view: { ...VIEW, screen: true } }, render: args => <WithCamera {...args} /> };
export const Bot: Story = { args: { view: { ...VIEW, name: 'relay', web: false, bot: true }, labels: { ...LABELS, volume: 'volume for relay' } } };
/** Product walk I2: camera and screen together; the screen is the tile, the camera an inset. */
export const ScreenAndCamera: Story = { args: { view: { ...VIEW, video: true, screen: true } }, render: args => <WithScreenAndCamera {...args} /> };
/** Product walk I3: the own tile's self-view, the camera mirrored. */
export const OwnSelfView: Story = { args: { view: { ...VIEW, name: 'you', deviceId: 'd0', userId: 'u0', video: true }, own: true, mirror: 'media' }, render: args => <WithCamera {...args} /> };
/** Product walk M6: the volume above 100 %, its value beside the range. */
export const LouderVolume: Story = { args: { volume: 150 } };
