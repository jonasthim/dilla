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

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><VoiceDock {...(meta.args as VoiceDockProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
