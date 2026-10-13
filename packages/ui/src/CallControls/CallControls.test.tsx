import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { CallControls, type CallControlsProps } from './CallControls.tsx';
import meta from './CallControls.stories.tsx';

const labels: CallControlsProps['labels'] = {
  region: 'call controls', mute: 'mute', unmute: 'unmute', deafen: 'deafen', undeafen: 'undeafen', cameraOn: 'camera',
  cameraOff: 'stop camera', shareOn: 'share screen', shareOff: 'stop sharing', leave: 'leave',
};
const base: CallControlsProps = {
  muted: false, deafened: false, camera: false, sharing: false, canCamera: true, canShare: true, busy: false, labels,
  onMute: () => {}, onDeafen: () => {}, onCamera: () => {}, onShare: () => {}, onLeave: () => {},
};

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('CallControls', () => {
  it('is one toolbar named call controls with one tab stop and roving arrows', async () => {
    render(<CallControls {...base} />);
    const bar = screen.getByRole('toolbar', { name: 'call controls' });
    const buttons = within(bar).getAllByRole('button');
    ['mute', 'deafen', 'camera', 'share screen', 'leave'].forEach((name, i) => expect(buttons[i]).toHaveAccessibleName(name));
    expect(buttons).toHaveLength(5);
    expect(buttons.filter(b => b.tabIndex === 0)).toEqual([buttons[0]]);
    await userEvent.keyboard('{Tab}{End}');
    expect(buttons[4]).toHaveFocus();
    expect(buttons[4].tabIndex).toBe(0);
    await userEvent.keyboard('{ArrowRight}');
    expect(buttons[0]).toHaveFocus();
  });

  it('labels say the next action, and each control calls its handler', async () => {
    const handlers = { onMute: vi.fn(), onDeafen: vi.fn(), onCamera: vi.fn(), onShare: vi.fn(), onLeave: vi.fn() };
    render(<CallControls {...base} {...handlers} muted deafened camera sharing />);
    for (const name of ['unmute', 'undeafen', 'stop camera', 'stop sharing', 'leave']) await userEvent.click(screen.getByRole('button', { name }));
    for (const fn of Object.values(handlers)) expect(fn).toHaveBeenCalledTimes(1);
  });

  it('busy, or a missing camera or share, is aria-disabled: still focusable, and it does nothing', async () => {
    const onCamera = vi.fn();
    const onShare = vi.fn();
    const onMute = vi.fn();
    const { rerender } = render(<CallControls {...base} canCamera={false} canShare={false} onCamera={onCamera} onShare={onShare} onMute={onMute} />);
    const camera = screen.getByRole('button', { name: 'camera' });
    expect(camera).toHaveAttribute('aria-disabled', 'true');
    expect(camera).not.toBeDisabled();
    await userEvent.click(camera);
    await userEvent.click(screen.getByRole('button', { name: 'share screen' }));
    expect(onCamera).not.toHaveBeenCalled();
    expect(onShare).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'mute' })).not.toHaveAttribute('aria-disabled');
    rerender(<CallControls {...base} busy onMute={onMute} />);
    for (const b of screen.getAllByRole('button')) expect(b).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'mute' }));
    expect(onMute).not.toHaveBeenCalled();
  });

  it('mute, deafen, camera and share are Button toggles with aria-pressed; mute and deafen carry their shortcuts (M4, M5)', () => {
    const { rerender } = render(<CallControls {...base} />);
    const mute = screen.getByRole('button', { name: 'mute' });
    expect(mute).toHaveAttribute('aria-pressed', 'false');
    expect(mute).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+M Meta+Shift+M');
    expect(screen.getByRole('button', { name: 'deafen' })).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+D Meta+Shift+D');
    expect(screen.getByRole('button', { name: 'camera' })).not.toHaveAttribute('aria-keyshortcuts');
    expect(screen.getByRole('button', { name: 'leave' })).not.toHaveAttribute('aria-pressed');
    rerender(<CallControls {...base} muted deafened camera sharing />);
    for (const name of ['unmute', 'undeafen', 'stop camera', 'stop sharing']) expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><CallControls {...(meta.args as CallControlsProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
