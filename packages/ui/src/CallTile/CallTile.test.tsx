import { fireEvent, render, screen, within } from '@testing-library/react';
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
  volumeValue: '{n} %',
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

  it('speaking is shown by a named dot as well as the outline', () => {
    const { container } = render(<CallTile view={{ ...view, speaking: true }} {...rest} />);
    const dot = screen.getByRole('img', { name: 'speaking' });
    expect(dot).toHaveAttribute('title', 'speaking');
    expect(dot.querySelector('.d-state-dot')).toHaveAttribute('data-tone', 'ok');
    expect(dot).toHaveAttribute('data-state', 'speaking');
    expect(container.firstElementChild).toHaveAttribute('data-speaking', 'true');
  });

  it('shows each glyph-only state as a named image, the stream states as glyph plus word, and the state hook', () => {
    const { container, rerender } = render(<CallTile view={{ ...view, muted: true, deafened: true, video: true, screen: true }} {...rest} />);
    for (const word of ['muted', 'deafened', 'camera on', 'sharing screen']) {
      const img = screen.getByRole('img', { name: word });
      expect(img).toHaveAttribute('title', word);
      expect(img).toHaveClass('d-call-tile__state');
      expect(img.textContent).toBe('');
    }
    expect([...container.querySelectorAll('svg')].map(i => i.getAttribute('data-icon'))).toEqual(['mic-off', 'headphone-off', 'video', 'monitor-up']);
    expect(screen.getByText('web')).toBeInTheDocument();
    rerender(<CallTile view={{ ...view, state: 'not-heard' }} {...rest} />);
    expect(screen.getByText('not heard yet')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('data-voice-state', 'not-heard');
    rerender(<CallTile view={{ ...view, state: 'connecting' }} {...rest} />);
    expect(screen.getByText('connecting')).toBeInTheDocument();
  });

  it('the caption wraps the name and the states in one row: name, icons, then the stream-state words', () => {
    const { container } = render(<CallTile view={{ ...view, muted: true, video: true, state: 'unverified' }} {...rest} />);
    const caption = container.querySelector('.d-call-tile__caption')!;
    expect(caption.querySelector(':scope > .d-call-tile__name')).toHaveTextContent('ada');
    const states = [...caption.querySelectorAll<HTMLElement>('.d-call-tile__state')].map(s => s.dataset.state);
    expect(states).toEqual(['muted', 'video', 'unverified']);
    expect(caption.querySelectorAll('svg[data-icon]')).toHaveLength(2);
    expect(within(caption as HTMLElement).getByText('unverified stream')).toBeInTheDocument();
  });

  it('the old font glyphs are gone', () => {
    const { container } = render(<CallTile view={{ ...view, muted: true, deafened: true }} {...rest} />);
    expect(container.textContent).not.toMatch(/[⊘⊗]/);
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

  it('speaks the volume through the localised value label (M6)', () => {
    render(<CallTile view={view} {...rest} volume={120} labels={{ ...labels, volumeValue: '{n} procent' }} />);
    expect(screen.getByRole('slider', { name: 'volume for ada' })).toHaveAttribute('aria-valuetext', '120 procent');
  });

  it('product walk I2: a screen and a camera show together, the screen as the tile and the camera as an inset', () => {
    const screenStream = new MediaStream();
    const cam = new MediaStream();
    const { container } = render(<CallTile view={{ ...view, video: true, screen: true }} {...rest} media={screenStream} inset={cam} />);
    const [main, inset] = [...container.querySelectorAll('video')];
    expect(main.srcObject).toBe(screenStream);
    expect(inset.srcObject).toBe(cam);
    expect(inset).toHaveClass('d-call-tile__inset');
    expect(inset.muted).toBe(true);
  });

  it('product walk I3: the own camera is mirrored, the own screen is not', () => {
    const cam = new MediaStream();
    const { container, rerender } = render(<CallTile view={{ ...view, video: true }} {...rest} own media={cam} mirror="media" />);
    expect(container.querySelector('video')).toHaveAttribute('data-mirror', 'true');
    rerender(<CallTile view={{ ...view, video: true, screen: true }} {...rest} own media={new MediaStream()} inset={cam} mirror="inset" />);
    const [main, inset] = [...container.querySelectorAll('video')];
    expect(main).not.toHaveAttribute('data-mirror');
    expect(inset).toHaveAttribute('data-mirror', 'true');
  });

  it('product walk M6: the volume shows its value and marks 100 %', () => {
    const { container } = render(<CallTile view={view} {...rest} volume={120} />);
    expect(container.querySelector('.d-call-tile__volume-value')).toHaveTextContent('120 %');
    const range = screen.getByRole('slider', { name: 'volume for ada' });
    const list = container.querySelector(`datalist#${CSS.escape(range.getAttribute('list') ?? '')}`);
    expect([...(list?.querySelectorAll('option') ?? [])].map(o => o.getAttribute('value'))).toEqual(['100']);
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><CallTile {...(meta.args as CallTileProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
