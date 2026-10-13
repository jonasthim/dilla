import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MediaPlayer, type MediaPlayerProps } from './MediaPlayer.tsx';

/**
 * A one-second 440 Hz tone, written as a WAV file at story time and shown through a page-minted blob: URL that is
 * revoked on unmount (the inline players play only blob: URLs, RV-5). The video stories use it too: a video
 * element with a sound-only source draws its native controls over a dark frame, as a video does before its first
 * frame; nothing autoplays either way.
 */
export function useToneUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const rate = 8000;
    const n = rate;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 6000), true);
    const u = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, []);
  return url;
}

function WithTone(props: MediaPlayerProps) {
  const src = useToneUrl();
  return <MediaPlayer {...props} src={src} />;
}

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9).
const meta = {
  title: 'Media/MediaPlayer', component: MediaPlayer,
  excludeStories: ['useToneUrl'],
  args: {
    kind: 'audio', src: null, name: 'harbour-voice.ogg', state: 'idle',
    labels: { play: 'play {name}', loading: 'loading', error: 'This browser cannot play this file.', save: 'save' },
    onPlay: () => {}, onSave: () => {}, onError: () => {},
  },
  decorators: [Story => <div style={{ maxWidth: 720 }}><Story /></div>],
} satisfies Meta<typeof MediaPlayer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AudioIdle: Story = {};
export const AudioLoading: Story = { args: { state: 'loading' } };
export const AudioReady: Story = { args: { state: 'ready' }, render: args => <WithTone {...args} /> };
export const AudioError: Story = { args: { state: 'error' } };
export const VideoIdle: Story = { args: { kind: 'video', name: 'harbour-walk.webm' } };
export const VideoLoading: Story = { args: { kind: 'video', name: 'harbour-walk.webm', state: 'loading' } };
export const VideoReady: Story = { args: { kind: 'video', name: 'harbour-walk.webm', state: 'ready' }, render: args => <WithTone {...args} /> };
export const VideoError: Story = { args: { kind: 'video', name: 'harbour-walk.webm', state: 'error' } };
