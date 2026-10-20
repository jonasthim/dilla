import { readFileSync } from 'node:fs';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { VoiceDock, type VoiceDockProps } from './VoiceDock.tsx';
import meta from './VoiceDock.stories.tsx';

const css = readFileSync(`${process.cwd()}/src/VoiceDock/VoiceDock.css`, 'utf8');

const dock: VoiceDockProps = {
  phase: 'connected', where: 'harbour', muted: false, deafened: false, announcement: '',
  labels: {
    region: 'voice controls', connecting: 'connecting', connected: 'voice connected', where: 'harbour · Midgard Crew', reconnecting: 'reconnecting',
    paused: 'paused', mute: 'mute', deafen: 'deafen', leave: 'leave', camera: 'camera', share: 'share screen',
  },
  onCamera: () => {}, onShare: () => {}, onLeave: () => {},
};

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('VoiceDock (R26)', () => {
  it('line 1 is the status, line 2 is the caller-filled "{channel} · {server}"', () => {
    const { container } = render(<VoiceDock {...dock} />);
    expect(container.querySelector('.d-voice-dock__text')).toHaveTextContent('voice connected');
    expect(container.querySelector('.d-voice-dock__where')).toHaveTextContent('harbour · Midgard Crew');
  });

  it('without labels.where, line 2 is the where prop; and "{where}" in the status labels is still filled', () => {
    const { container } = render(<VoiceDock {...dock} labels={{ ...dock.labels, where: undefined, connected: 'in {where}' }} />);
    expect(container.querySelector('.d-voice-dock__text')).toHaveTextContent('in harbour');
    expect(container.querySelector('.d-voice-dock__where')).toHaveTextContent('harbour');
  });

  it('draws no meter unless a legacy caller passes one (deprecated, removed in WEB-DOCK)', () => {
    const { container, rerender } = render(<VoiceDock {...dock} />);
    expect(container.querySelector('.d-voice-dock__meter, .d-audio-meter')).toBeNull();
    rerender(<VoiceDock {...dock} meter={<div data-testid="meter" />} />);
    expect(screen.getByTestId('meter').parentElement).toHaveClass('d-voice-dock__meter');
  });

  it('the status is a button calling onStatus (it opens Diagnostics, R26)', async () => {
    const onStatus = vi.fn();
    render(<VoiceDock {...dock} onStatus={onStatus} />);
    await userEvent.click(screen.getByRole('button', { name: 'voice connected' }));
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it('without onStatus the status is plain text, not a button', () => {
    render(<VoiceDock {...dock} />);
    expect(screen.queryByRole('button', { name: 'voice connected' })).toBeNull();
    expect(screen.getByText('voice connected')).toBeInTheDocument();
  });

  it('camera, share and leave are 32px icon buttons in one group, each with a tooltip anchor; there is no mute or deafen', () => {
    const { container } = render(<VoiceDock {...dock} onMute={() => {}} onDeafen={() => {}} />);
    const group = screen.getByRole('group', { name: 'voice controls' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map(b => b.getAttribute('aria-label'))).toEqual(['camera', 'share screen', 'leave']);
    for (const b of buttons) {
      expect(b).toHaveClass('d-icon-button');
      expect(b).toHaveAttribute('data-size', '32');
      expect(b.parentElement).toHaveClass('d-tooltip-anchor');
    }
    expect(screen.queryByRole('button', { name: 'mute' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'deafen' })).toBeNull();
    expect(container.querySelector('.d-voice-toolbar')).toBeNull();
  });

  it('a keyboard-focused control shows its tooltip', async () => {
    render(<VoiceDock {...dock} />);
    await userEvent.keyboard('{Tab}');
    expect(screen.getByRole('button', { name: 'camera' })).toHaveFocus();
    expect(screen.getByRole('tooltip')).toHaveTextContent('camera');
  });

  it('without camera and share handlers (or their labels) the dock keeps leave only', () => {
    render(<VoiceDock {...dock} onCamera={undefined} onShare={undefined} />);
    expect(within(screen.getByRole('group', { name: 'voice controls' })).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['leave']);
  });

  it.each([['connecting', 'span.d-state-dot[data-tone="pending"]'], ['reconnecting', 'span.d-state-dot[data-tone="pending"]'],
    ['connected', 'span.d-state-dot[data-tone="ok"]'], ['paused', 'svg[data-icon="pause"]']] as const)('the %s phase marker is drawn, not a font glyph', (phase, sel) => {
    const { container } = render(<VoiceDock {...dock} phase={phase} />);
    expect(container.querySelector(`.d-voice-dock__glyph ${sel}`)).not.toBeNull();
    expect(container.querySelector('.d-voice-dock__glyph')?.textContent).toBe('');
  });

  it('with controls={false} there is no group, but the status, where and the status region stay', () => {
    render(<VoiceDock {...dock} controls={false} announcement="Joined harbour." />);
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('voice connected')).toBeInTheDocument();
    expect(screen.getByText('harbour · Midgard Crew')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Joined harbour.');
  });

  it('says the phase on line 1', () => {
    const { rerender } = render(<VoiceDock {...dock} phase="paused" />);
    expect(screen.getByText('paused')).toBeInTheDocument();
    rerender(<VoiceDock {...dock} phase="connecting" />);
    expect(screen.getByText('connecting')).toBeInTheDocument();
    rerender(<VoiceDock {...dock} phase="reconnecting" />);
    expect(screen.getByText('reconnecting')).toBeInTheDocument();
  });

  it('camera, share and leave call their handlers', async () => {
    const handlers = { onCamera: vi.fn(), onShare: vi.fn(), onLeave: vi.fn() };
    render(<VoiceDock {...dock} {...handlers} />);
    for (const b of within(screen.getByRole('group', { name: 'voice controls' })).getAllByRole('button')) await userEvent.click(b);
    for (const fn of Object.values(handlers)) expect(fn).toHaveBeenCalledTimes(1);
  });

  it('camera and share are pressed toggles whose glyph follows the state', () => {
    const icon = (name: string) => screen.getByRole('button', { name }).querySelector('svg')?.getAttribute('data-icon');
    const { rerender } = render(<VoiceDock {...dock} />);
    expect(screen.getByRole('button', { name: 'camera' })).toHaveAttribute('aria-pressed', 'false');
    expect(['camera', 'share screen', 'leave'].map(icon)).toEqual(['video-off', 'monitor-up', 'phone-off']);
    rerender(<VoiceDock {...dock} camera sharing />);
    expect(screen.getByRole('button', { name: 'camera' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'share screen' })).toHaveAttribute('aria-pressed', 'true');
    expect(['camera', 'share screen', 'leave'].map(icon)).toEqual(['video', 'monitor-x', 'phone-off']);
  });

  it('camera and share are inert under the stage rules: no camera, no capture, or joining (busy); leave stays live', async () => {
    const onCamera = vi.fn();
    const onShare = vi.fn();
    const { rerender } = render(<VoiceDock {...dock} canCamera={false} canShare={false} onCamera={onCamera} onShare={onShare} />);
    for (const name of ['camera', 'share screen']) {
      const b = screen.getByRole('button', { name });
      expect(b).toHaveAttribute('aria-disabled', 'true');
      expect(b).not.toBeDisabled();
      await userEvent.click(b);
    }
    expect(onCamera).not.toHaveBeenCalled();
    expect(onShare).not.toHaveBeenCalled();
    rerender(<VoiceDock {...dock} busy onCamera={onCamera} onShare={onShare} />);
    expect(screen.getByRole('button', { name: 'camera' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'share screen' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'leave' })).not.toHaveAttribute('aria-disabled');
    rerender(<VoiceDock {...dock} onCamera={onCamera} onShare={onShare} />);
    for (const name of ['camera', 'share screen']) expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-disabled');
  });

  it('a disabled camera or share says why: connecting, then paused, then not available; leave never', () => {
    const why = { paused: 'paused', joining: 'connecting', noShare: 'not available in this browser' };
    const withWhy: VoiceDockProps = { ...dock, labels: { ...dock.labels, why } };
    const { rerender } = render(<VoiceDock {...withWhy} phase="paused" paused canCamera={false} canShare={false} />);
    const b = (name: string) => screen.getByRole('button', { name });
    expect(b('camera')).toHaveAccessibleName('camera');
    expect(b('camera')).toHaveAccessibleDescription('paused');
    expect(b('share screen')).toHaveAccessibleDescription('paused');
    expect(b('leave')).not.toHaveAttribute('aria-describedby');
    rerender(<VoiceDock {...withWhy} phase="connecting" busy canCamera canShare />);
    expect(b('camera')).toHaveAccessibleDescription('connecting');
    rerender(<VoiceDock {...withWhy} canShare={false} />);
    expect(b('camera')).not.toHaveAttribute('aria-describedby');
    expect(b('share screen')).toHaveAccessibleDescription('not available in this browser');
    rerender(<VoiceDock {...withWhy} />);
    for (const name of ['camera', 'share screen']) expect(b(name)).not.toHaveAttribute('aria-describedby');
  });

  it('has no card: a hairline top, the panel inset, no radius and no fill (CSS pin, E1, E2)', () => {
    const rule = css.match(/^\.d-voice-dock \{([^}]*)\}/m)![1]!;
    expect(rule).toMatch(/border-top: 1px solid var\(--hairline\)/);
    expect(rule).toMatch(/padding: 0\.75rem/);
    expect(rule).not.toMatch(/border-radius|background|border: 1px/);
  });

  it('the controls are one flex row (CSS pin)', () => {
    expect(css).toMatch(/\.d-voice-dock__controls \{[^}]*display: flex/);
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe with all controls in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><VoiceDock {...dock} onStatus={() => {}} camera canShare={false} /></div>);
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><VoiceDock {...(meta.args as VoiceDockProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
