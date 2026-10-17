import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { UserPanel, type UserPanelProps } from './UserPanel.tsx';
import { VOICE_SHORTCUTS } from '../CallControls/CallControls.tsx';
import { readFileSync } from 'node:fs';
import meta from './UserPanel.stories.tsx';

const panelCss = readFileSync(`${process.cwd()}/src/UserPanel/UserPanel.css`, 'utf8');

const panel = (over: Partial<UserPanelProps> = {}): UserPanelProps => ({
  name: 'Ada Lovelace', username: 'ada', muted: false, deafened: false,
  shortcuts: { mute: 'Ctrl+Shift+M', deafen: 'Ctrl+Shift+D' },
  labels: { region: 'your account', mute: 'mute', deafen: 'deafen', settings: 'settings' },
  onMute: () => {}, onDeafen: () => {}, onSettings: () => {}, onOpenSelf: () => {}, ...over,
});

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('UserPanel', () => {
  it('is a plain div with no role and no name; its toolbar carries the region name', () => {
    const { container } = render(<UserPanel {...panel()} />);
    const root = container.firstElementChild!;
    expect(root).toHaveClass('d-user-panel');
    expect(root.tagName).toBe('DIV');
    expect(root).not.toHaveAttribute('role');
    expect(root).not.toHaveAttribute('aria-label');
    expect(root).not.toHaveAttribute('aria-labelledby');
    expect(screen.getByRole('toolbar', { name: 'your account' })).toBeInTheDocument();
    expect(screen.getAllByRole('toolbar')).toHaveLength(1);
  });

  it('names mute and deafen in the toolbar, as toggles carrying the shortcuts', () => {
    render(<UserPanel {...panel({ muted: true })} />);
    const bar = screen.getByRole('toolbar', { name: 'your account' });
    const mute = within(bar).getByRole('button', { name: 'mute' });
    const deafen = within(bar).getByRole('button', { name: 'deafen' });
    expect(mute).toHaveAttribute('aria-pressed', 'true');
    expect(deafen).toHaveAttribute('aria-pressed', 'false');
    expect(mute).toHaveAttribute('aria-keyshortcuts', VOICE_SHORTCUTS.mute);
    expect(deafen).toHaveAttribute('aria-keyshortcuts', VOICE_SHORTCUTS.deafen);
  });

  it('mute and deafen call their handlers; the settings button, outside the toolbar, calls onSettings', async () => {
    const [onMute, onDeafen, onSettings] = [vi.fn(), vi.fn(), vi.fn()];
    render(<UserPanel {...panel({ onMute, onDeafen, onSettings })} />);
    await userEvent.click(screen.getByRole('button', { name: 'mute' }));
    await userEvent.click(screen.getByRole('button', { name: 'deafen' }));
    expect(onMute).toHaveBeenCalledTimes(1);
    expect(onDeafen).toHaveBeenCalledTimes(1);
    const gear = screen.getByRole('button', { name: 'settings' });
    expect(within(screen.getByRole('toolbar')).queryByRole('button', { name: 'settings' })).toBeNull();
    expect(gear.querySelector('[data-icon="settings"]')).not.toBeNull();
    await userEvent.click(gear);
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it('shows the name and @username; a click on that block calls onOpenSelf, and it is no tab stop', async () => {
    const onOpenSelf = vi.fn();
    render(<UserPanel {...panel({ onOpenSelf })} />);
    const who = screen.getByText('Ada Lovelace').closest('.d-user-panel__who')!;
    expect(who).toHaveTextContent('@ada');
    expect(who).not.toHaveAttribute('role');
    expect(who).not.toHaveAttribute('tabindex');
    await userEvent.click(screen.getByText('@ada'));
    expect(onOpenSelf).toHaveBeenCalledTimes(1);
    // The toolbar is one tab stop and the gear is the other.
    expect(screen.getAllByRole('button').filter(b => b.tabIndex === 0)).toHaveLength(2);
  });

  it('mute and deafen are at least 2rem square too (CSS pin)', () => {
    expect(panelCss).toMatch(/\.d-user-panel \.d-voice-toolbar \.d-voice-toolbar__control \{[^}]*min-width: 2rem; min-height: 2rem/);
  });

  it('the settings button is at least 2rem square (CSS pin)', () => {
    expect(panelCss).toMatch(/\.d-user-panel__settings \{[^}]*min-width: 2rem; min-height: 2rem/);
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><UserPanel {...(meta.args as UserPanelProps)} /></div>);
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
