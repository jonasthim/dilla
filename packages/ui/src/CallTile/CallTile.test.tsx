import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { CallTile, type CallTileProps, type VoiceParticipantView } from './CallTile.tsx';
import meta from './CallTile.stories.tsx';

// jsdom has no MediaStream: a bare stand-in is enough, the tile only hands it to a <video>'s srcObject.
if (typeof globalThis.MediaStream === 'undefined') {
  (globalThis as { MediaStream?: unknown }).MediaStream = class MediaStream {};
}

const view: VoiceParticipantView = {
  deviceId: 'd1', userId: 'u1', name: 'ada', state: 'ok', speaking: false, muted: false, deafened: false,
  video: false, screen: false, web: true, bot: false,
};
const labels: CallTileProps['labels'] = {
  state: {
    speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream',
    connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot',
  },
  volume: 'volume for ada',
};
const rest = { own: false, volume: 100, media: null, labels, onVolume: () => {} };

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('CallTile', () => {
  it('CallTile never attaches media for an unverified stream', () => {
    const { container } = render(<CallTile view={{ ...view, state: 'unverified' }} own={false} volume={100} media={new MediaStream()} labels={labels} onVolume={() => {}} />);
    expect(container.querySelector('video, audio')).toBeNull();
    expect(screen.getByText('unverified stream')).toBeInTheDocument();
  });

  it('attaches a verified stream to a muted video that never plays sound', () => {
    const stream = new MediaStream();
    const { container } = render(<CallTile view={{ ...view, video: true }} {...rest} media={stream} />);
    const video = container.querySelector('video')!;
    expect(video).not.toBeNull();
    expect(video.srcObject).toBe(stream);
    expect(video.muted).toBe(true);
    expect(container.querySelector('audio')).toBeNull();
  });

  it('speaking is shown by text as well as the outline', () => {
    const { container } = render(<CallTile view={{ ...view, speaking: true }} {...rest} />);
    expect(screen.getByText('speaking')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('data-speaking', 'true');
  });

  it('shows each state as a word, and the state hook', () => {
    const { container, rerender } = render(<CallTile view={{ ...view, muted: true, deafened: true, video: true, screen: true }} {...rest} />);
    for (const word of ['muted', 'deafened', 'camera on', 'sharing screen', 'web']) expect(screen.getByText(word)).toBeInTheDocument();
    rerender(<CallTile view={{ ...view, state: 'not-heard' }} {...rest} />);
    expect(screen.getByText('not heard yet')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('data-voice-state', 'not-heard');
    rerender(<CallTile view={{ ...view, state: 'connecting' }} {...rest} />);
    expect(screen.getByText('connecting')).toBeInTheDocument();
  });

  it('a native range sets the volume of another person, and the own tile has none', () => {
    const onVolume = vi.fn();
    const { rerender } = render(<CallTile view={view} {...rest} volume={120} onVolume={onVolume} />);
    const range = screen.getByRole('slider', { name: 'volume for ada' });
    expect(range).toHaveAttribute('type', 'range');
    expect(range).toHaveAttribute('min', '0');
    expect(range).toHaveAttribute('max', '200');
    expect(range).toHaveAttribute('step', '10');
    expect(range).toHaveValue('120');
    fireEvent.change(range, { target: { value: '150' } });
    expect(onVolume).toHaveBeenCalledWith(150);
    rerender(<CallTile view={view} {...rest} own />);
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><CallTile {...(meta.args as CallTileProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
