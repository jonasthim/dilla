import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { VoiceDock, type VoiceDockProps } from './VoiceDock.tsx';
import meta from './VoiceDock.stories.tsx';

const dock: VoiceDockProps = {
  phase: 'connected', where: 'harbour', muted: false, deafened: false, announcement: '',
  labels: {
    region: 'voice controls', connecting: 'connecting', connected: 'in {where}', reconnecting: 'reconnecting', paused: 'paused in {where}',
    mute: 'mute', deafen: 'deafen', leave: 'leave',
  },
  onMute: () => {}, onDeafen: () => {}, onLeave: () => {},
};

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('VoiceDock', () => {
  it('VoiceDock is one toolbar with roving focus and a status region', async () => {
    render(<VoiceDock {...dock} announcement="Microphone muted." />);
    const bar = screen.getByRole('toolbar', { name: 'voice controls' });
    expect(within(bar).getAllByRole('button').filter((b) => b.tabIndex === 0)).toHaveLength(1);
    await userEvent.keyboard('{Tab}{ArrowRight}');
    expect(within(bar).getByRole('button', { name: 'deafen' })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Microphone muted.');
  });

  it.each([['connecting', 'span.d-state-dot[data-tone="pending"]'], ['reconnecting', 'span.d-state-dot[data-tone="pending"]'],
    ['connected', 'span.d-state-dot[data-tone="ok"]'], ['paused', 'svg[data-icon="pause"]']] as const)('the %s phase marker is drawn, not a font glyph', (phase, sel) => {
    const { container } = render(<VoiceDock {...dock} phase={phase} />);
    expect(container.querySelector(`.d-voice-dock__glyph ${sel}`)).not.toBeNull();
    expect(container.querySelector('.d-voice-dock__glyph')?.textContent).toBe('');
  });

  it('arrows wrap, Home and End go to the ends, and Tab returns to the last-focused control', async () => {
    render(<><VoiceDock {...dock} /><button type="button">after</button></>);
    const bar = screen.getByRole('toolbar', { name: 'voice controls' });
    await userEvent.keyboard('{Tab}{ArrowLeft}');
    expect(within(bar).getByRole('button', { name: 'leave' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(within(bar).getByRole('button', { name: 'mute' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(within(bar).getByRole('button', { name: 'leave' })).toHaveFocus();
    await userEvent.keyboard('{Home}{ArrowRight}{Tab}');
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(within(bar).getByRole('button', { name: 'deafen' })).toHaveFocus();
  });

  it('says where it is per phase, and the toggles keep their labels (WB a11y I4)', async () => {
    const onMute = vi.fn();
    const onDeafen = vi.fn();
    const onLeave = vi.fn();
    const { rerender } = render(<VoiceDock {...dock} onMute={onMute} onDeafen={onDeafen} onLeave={onLeave} />);
    expect(screen.getByText('in harbour')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'mute' }));
    await userEvent.click(screen.getByRole('button', { name: 'deafen' }));
    await userEvent.click(screen.getByRole('button', { name: 'leave' }));
    expect([onMute.mock.calls.length, onDeafen.mock.calls.length, onLeave.mock.calls.length]).toEqual([1, 1, 1]);
    rerender(<VoiceDock {...dock} phase="paused" muted deafened />);
    expect(screen.getByText('paused in harbour')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'mute' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'deafen' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('unmute')).toBeNull();
    rerender(<VoiceDock {...dock} phase="connecting" />);
    expect(screen.getByText('connecting')).toBeInTheDocument();
    rerender(<VoiceDock {...dock} phase="reconnecting" />);
    expect(screen.getByText('reconnecting')).toBeInTheDocument();
  });

  it('mute and deafen are pressed toggles that carry their shortcuts (M4, M5)', () => {
    render(<VoiceDock {...dock} muted />);
    const mute = screen.getByRole('button', { name: 'mute' });
    expect(mute).toHaveAttribute('aria-pressed', 'true');
    expect(mute).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+M Meta+Shift+M');
    expect(screen.getByRole('button', { name: 'deafen' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'deafen' })).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+D Meta+Shift+D');
  });

  // Plan 2026-10-15 (VI-1): all five voice controls in the dock, in the stage's order.
  const five: VoiceDockProps = {
    ...dock, labels: { ...dock.labels, camera: 'camera', share: 'share screen' },
    camera: false, sharing: false, canCamera: true, canShare: true, onCamera: () => {}, onShare: () => {},
  };

  it('with camera and share handlers, the dock holds mute, deafen, camera, share and leave in that order', async () => {
    const handlers = { onMute: vi.fn(), onDeafen: vi.fn(), onCamera: vi.fn(), onShare: vi.fn(), onLeave: vi.fn() };
    render(<VoiceDock {...five} {...handlers} />);
    const buttons = within(screen.getByRole('toolbar', { name: 'voice controls' })).getAllByRole('button');
    expect(buttons.map(b => b.getAttribute('aria-label'))).toEqual(['mute', 'deafen', 'camera', 'share screen', 'leave']);
    for (const b of buttons) await userEvent.click(b);
    for (const fn of Object.values(handlers)) expect(fn).toHaveBeenCalledTimes(1);
  });

  it('without camera and share handlers, the dock keeps its three controls', () => {
    render(<VoiceDock {...dock} />);
    const buttons = within(screen.getByRole('toolbar', { name: 'voice controls' })).getAllByRole('button');
    expect(buttons.map(b => b.getAttribute('aria-label'))).toEqual(['mute', 'deafen', 'leave']);
  });

  it('camera and share are pressed toggles whose glyph follows the state', () => {
    const icon = (name: string) => screen.getByRole('button', { name }).querySelector('svg')?.getAttribute('data-icon');
    const { rerender } = render(<VoiceDock {...five} />);
    expect(screen.getByRole('button', { name: 'camera' })).toHaveAttribute('aria-pressed', 'false');
    expect(['mute', 'deafen', 'camera', 'share screen', 'leave'].map(icon)).toEqual(['mic', 'headphones', 'video-off', 'monitor-up', 'phone-off']);
    rerender(<VoiceDock {...five} muted deafened camera sharing />);
    expect(screen.getByRole('button', { name: 'camera' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'share screen' })).toHaveAttribute('aria-pressed', 'true');
    expect(['mute', 'deafen', 'camera', 'share screen', 'leave'].map(icon)).toEqual(['mic-off', 'headphone-off', 'video', 'monitor-x', 'phone-off']);
  });

  it('camera and share are inert under the stage rules: no camera, no capture, or joining (busy); the rest stay live', async () => {
    const onCamera = vi.fn();
    const onShare = vi.fn();
    const { rerender } = render(<VoiceDock {...five} canCamera={false} canShare={false} onCamera={onCamera} onShare={onShare} />);
    for (const name of ['camera', 'share screen']) {
      const b = screen.getByRole('button', { name });
      expect(b).toHaveAttribute('aria-disabled', 'true');
      expect(b).not.toBeDisabled();
      await userEvent.click(b);
    }
    expect(onCamera).not.toHaveBeenCalled();
    expect(onShare).not.toHaveBeenCalled();
    rerender(<VoiceDock {...five} busy onCamera={onCamera} onShare={onShare} />);
    expect(screen.getByRole('button', { name: 'camera' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'share screen' })).toHaveAttribute('aria-disabled', 'true');
    for (const name of ['mute', 'deafen', 'leave']) expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-disabled');
    rerender(<VoiceDock {...five} onCamera={onCamera} onShare={onShare} />);
    for (const name of ['camera', 'share screen']) expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-disabled');
  });

  // Jonas, 2026-10-15: the dock's disabled camera and share say why, as on the stage.
  it('a disabled camera or share says why: connecting, then paused, then not available; mute, deafen and leave never', async () => {
    const why = { paused: 'paused', joining: 'connecting', noShare: 'not available in this browser' };
    const withWhy: VoiceDockProps = { ...five, labels: { ...five.labels, why } };
    const { rerender } = render(<VoiceDock {...withWhy} phase="paused" paused canCamera={false} canShare={false} />);
    const desc = (name: string) => screen.getByRole('button', { name });
    expect(desc('camera')).toHaveAccessibleName('camera');
    expect(desc('camera')).toHaveAccessibleDescription('paused');
    expect(desc('share screen')).toHaveAccessibleDescription('paused');
    for (const name of ['mute', 'deafen', 'leave']) expect(desc(name)).not.toHaveAttribute('aria-describedby');
    await userEvent.keyboard('{Tab}{ArrowRight}{ArrowRight}');
    const tip = screen.getByRole('toolbar', { name: 'voice controls' }).querySelector('[role="tooltip"]');
    expect(tip).toHaveTextContent(/^camera — paused$/);
    rerender(<VoiceDock {...withWhy} phase="connecting" busy canCamera canShare />);
    expect(desc('camera')).toHaveAccessibleDescription('connecting');
    expect(desc('share screen')).toHaveAccessibleDescription('connecting');
    rerender(<VoiceDock {...withWhy} canShare={false} />);
    expect(desc('camera')).not.toHaveAttribute('aria-describedby');
    expect(desc('share screen')).toHaveAccessibleDescription('not available in this browser');
    rerender(<VoiceDock {...withWhy} />);
    for (const name of ['camera', 'share screen']) expect(desc(name)).not.toHaveAttribute('aria-describedby');
  });

  it('the shortcuts show in the mute and deafen tooltips and describe those controls', async () => {
    render(<VoiceDock {...five} shortcuts={{ mute: '⌘⇧M', deafen: '⌘⇧D' }} />);
    await userEvent.keyboard('{Tab}');
    const mute = screen.getByRole('button', { name: 'mute' });
    expect(mute).toHaveAccessibleDescription('⌘⇧M');
    const tip = screen.getByRole('toolbar', { name: 'voice controls' }).querySelector('[role="tooltip"]');
    expect(tip).toBeVisible();
    expect(tip).toHaveTextContent('mute⌘⇧M');
    expect(mute.contains(tip)).toBe(false);
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'deafen' })).toHaveAccessibleDescription('⌘⇧D');
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe with all five controls in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><VoiceDock {...five} muted camera canShare={false} /></div>);
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><VoiceDock {...(meta.args as VoiceDockProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
