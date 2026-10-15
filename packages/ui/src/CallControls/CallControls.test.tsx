import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { CallControls, type CallControlsProps } from './CallControls.tsx';
import meta from './CallControls.stories.tsx';

const labels: CallControlsProps['labels'] = {
  region: 'call controls', mute: 'mute', deafen: 'deafen', camera: 'camera', share: 'share screen', leave: 'leave',
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

  // WB a11y I4 (ruling 2026-10-14): a toggle keeps one visible label; aria-pressed and the aria-hidden [x] mark carry its
  // state, so "mute, toggle button, pressed" means muted and is never contradicted by a swapped label.
  it('toggles keep their label whatever their state, and each control calls its handler', async () => {
    const handlers = { onMute: vi.fn(), onDeafen: vi.fn(), onCamera: vi.fn(), onShare: vi.fn(), onLeave: vi.fn() };
    render(<CallControls {...base} {...handlers} muted deafened camera sharing />);
    for (const name of ['mute', 'deafen', 'camera', 'share screen', 'leave']) await userEvent.click(screen.getByRole('button', { name }));
    for (const gone of ['unmute', 'undeafen', 'stop camera', 'stop sharing']) expect(screen.queryByText(gone)).toBeNull();
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
    for (const name of ['mute', 'deafen', 'camera', 'share screen']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    }
  });

  // Voice controls as icons (plan 2026-10-15, VI-1): the name is the label via aria-label, the icon is decorative,
  // and the voice toolbar drops the Button primitive's [x] / [ ] mark; the swapped glyph carries the state instead.
  it('each control is an icon button named by its label, with no [x] mark', () => {
    render(<CallControls {...base} muted />);
    for (const name of ['mute', 'deafen', 'camera', 'share screen', 'leave']) {
      const b = screen.getByRole('button', { name });
      expect(b).toHaveAttribute('aria-label', name);
      expect(b.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1);
      expect(b.textContent).not.toMatch(/\[[x ]\]/);
    }
  });

  it('a toggle swaps its glyph with its state, and leave is always phone-off', () => {
    const icon = (name: string) => screen.getByRole('button', { name }).querySelector('svg')?.getAttribute('data-icon');
    const { rerender } = render(<CallControls {...base} />);
    expect(['mute', 'deafen', 'camera', 'share screen', 'leave'].map(icon)).toEqual(['mic', 'headphones', 'video-off', 'monitor-up', 'phone-off']);
    rerender(<CallControls {...base} muted deafened camera sharing />);
    expect(['mute', 'deafen', 'camera', 'share screen', 'leave'].map(icon)).toEqual(['mic-off', 'headphone-off', 'video', 'monitor-x', 'phone-off']);
  });

  it('pressed toggles carry a tint: danger for mute and deafen, accent for camera and share; leave is the danger variant', () => {
    render(<CallControls {...base} muted deafened camera sharing />);
    expect(screen.getByRole('button', { name: 'mute' })).toHaveAttribute('data-tint', 'danger');
    expect(screen.getByRole('button', { name: 'deafen' })).toHaveAttribute('data-tint', 'danger');
    expect(screen.getByRole('button', { name: 'camera' })).toHaveAttribute('data-tint', 'accent');
    expect(screen.getByRole('button', { name: 'share screen' })).toHaveAttribute('data-tint', 'accent');
    expect(screen.getByRole('button', { name: 'leave' })).toHaveAttribute('data-variant', 'danger');
  });

  it('the tooltip shows the label on keyboard focus, with the shortcut as the description, and Escape hides it', async () => {
    const onLeave = vi.fn();
    const outer = vi.fn();
    render(<div onKeyDown={e => { outer(e.key); }}><CallControls {...base} onLeave={onLeave} shortcuts={{ mute: 'Ctrl+Shift+M', deafen: 'Ctrl+Shift+D' }} /></div>);
    const mute = screen.getByRole('button', { name: 'mute' });
    const tip = () => mute.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tip()).not.toBeVisible();
    await userEvent.keyboard('{Tab}');
    expect(mute).toHaveFocus();
    expect(tip()).toBeVisible();
    expect(tip()).toHaveTextContent('mute');
    expect(tip()).toHaveTextContent('Ctrl+Shift+M');
    // Described by the shortcut alone, so the name is not read twice; never a title attribute.
    expect(mute).toHaveAccessibleDescription('Ctrl+Shift+M');
    expect(mute).toHaveAccessibleName('mute');
    expect(mute).not.toHaveAttribute('title');
    await userEvent.keyboard('{Escape}');
    expect(tip()).not.toBeVisible();
    expect(mute).toHaveFocus();
    expect(onLeave).not.toHaveBeenCalled();
    expect(outer).toHaveBeenCalledWith('Escape');
    // Moving on shows the next control's tooltip; camera has no shortcut, so it has no description.
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    const camera = screen.getByRole('button', { name: 'camera' });
    expect(camera).toHaveFocus();
    expect(camera.querySelector('[role="tooltip"]')).toBeVisible();
    expect(camera.querySelector('[role="tooltip"]')).toHaveTextContent('camera');
    expect(camera).not.toHaveAttribute('aria-describedby');
    expect(tip()).not.toBeVisible();
  });

  it('the tooltip shows on hover and hides when the pointer leaves; a click on it does not press the control', async () => {
    const onLeave = vi.fn();
    render(<CallControls {...base} onLeave={onLeave} />);
    const leave = screen.getByRole('button', { name: 'leave' });
    const tip = leave.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tip).not.toBeVisible();
    await userEvent.hover(leave);
    expect(tip).toBeVisible();
    expect(tip).toHaveTextContent('leave');
    await userEvent.unhover(leave);
    expect(tip).not.toBeVisible();
    // The tooltip is hoverable (it sits inside the button), so a click on it must not leave the call.
    await userEvent.hover(leave);
    if (tip) await userEvent.click(tip);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><CallControls {...(meta.args as CallControlsProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
