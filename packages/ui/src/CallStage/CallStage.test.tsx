import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { CallStage, type CallStageProps } from './CallStage.tsx';
import type { CallTileProps } from '../CallTile/CallTile.tsx';
import meta from './CallStage.stories.tsx';

if (typeof globalThis.MediaStream === 'undefined') {
  (globalThis as { MediaStream?: unknown }).MediaStream = class MediaStream {};
}

const stateLabels: CallTileProps['labels']['state'] = {
  speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream',
  connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot',
};
function tile(name: string, media: MediaStream | null): CallTileProps {
  return {
    view: { deviceId: `d-${name}`, userId: `u-${name}`, name, state: 'ok', speaking: false, muted: false, deafened: false,
      video: media !== null, screen: false, web: true, bot: false },
    own: false, volume: 100, media, labels: { state: stateLabels, volume: `volume for ${name}` }, onVolume: () => {},
  };
}
const labels: CallStageProps['labels'] = {
  code: 'call code', codeHelp: 'The code changes whenever someone joins or leaves.', empty: 'Nobody is in voice yet.', tiles: 'people in voice',
};
const base: CallStageProps = {
  title: 'voice harbour', tiles: [tile('ada', new MediaStream()), tile('bo', new MediaStream())], code: '012345678901234567890123456789',
  notice: null, controls: <button type="button">mute</button>, outgoing: null, labels,
};
const pausedText = 'ada’s identity changed, so this call is paused for you: nothing you say is sent and nothing is played.';

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('CallStage', () => {
  it('CallStage with the pause notice (RV-3) shows its action, focuses it once, and renders no media element', async () => {
    const onAction = vi.fn();
    const notice = { text: pausedText, action: { label: 'compare safety numbers', onAction }, focusOnce: true };
    const { container, rerender } = render(<CallStage {...base} notice={notice} />);
    expect(container.querySelector('video, audio')).toBeNull();
    const action = screen.getByRole('button', { name: 'compare safety numbers' });
    expect(action).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent(pausedText);
    screen.getByRole('button', { name: 'mute' }).focus();
    rerender(<CallStage {...base} notice={{ ...notice }} />);
    expect(action).not.toHaveFocus();
    expect(container.querySelector('video, audio')).toBeNull();
    await userEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('without a notice the tiles show their verified video, as a list named for the people', () => {
    const { container } = render(<CallStage {...base} />);
    expect(container.querySelectorAll('video')).toHaveLength(2);
    expect(screen.getByRole('list', { name: 'people in voice' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'voice harbour' })).toBeInTheDocument();
  });

  it('keeps the call code behind a closed disclosure, in six groups of five; Escape closes it and returns focus', async () => {
    const { container } = render(<CallStage {...base} />);
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    const summary = container.querySelector('summary')!;
    expect(summary).toHaveTextContent('call code');
    await userEvent.click(summary);
    expect(details.open).toBe(true);
    expect(screen.getByText('01234 56789 01234 56789 01234 56789')).toBeInTheDocument();
    expect(screen.getByText('The code changes whenever someone joins or leaves.')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(details.open).toBe(false);
    expect(summary).toHaveFocus();
  });

  it('says so when nobody is in voice, shows the outgoing ring, and a notice without an action takes focus once', () => {
    const { rerender } = render(<CallStage {...base} tiles={[]} code={null} outgoing={{ text: 'ringing ada' }} />);
    expect(screen.getByText('Nobody is in voice yet.')).toBeInTheDocument();
    expect(screen.getByText('ringing ada')).toBeInTheDocument();
    expect(document.querySelector('details')).toBeNull();
    rerender(<CallStage {...base} notice={{ text: 'This voice is full.', action: null, focusOnce: true }} />);
    expect(screen.getByRole('status')).toHaveFocus();
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><CallStage {...(meta.args as CallStageProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
