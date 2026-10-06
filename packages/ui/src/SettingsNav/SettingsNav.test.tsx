import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SettingsNav, type SettingsNavProps } from './SettingsNav.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

// L-COPY-02: settings.nav.label and settings.nav.{devices,notifications,appearance}.
const ITEMS = [{ id: 'devices', label: 'devices' }, { id: 'notifications', label: 'notifications' }, { id: 'appearance', label: 'appearance' }] as const;
function props(over: Partial<SettingsNavProps> = {}): SettingsNavProps {
  return { label: 'settings sections', items: ITEMS, activeId: 'notifications', onSelect: vi.fn(), ...over };
}
const btn = (name: string) => screen.getByRole('button', { name });

describe('SettingsNav', () => {
  it('is a navigation landmark of buttons in order, the active one the current page', () => {
    render(<SettingsNav {...props()} />);
    const nav = screen.getByRole('navigation', { name: 'settings sections' });
    expect(nav).toHaveClass('d-settings-nav');
    const items = within(nav).getAllByRole('button');
    expect(items.map(b => b.textContent)).toEqual(['devices', 'notifications', 'appearance']);
    expect(items.map(b => b.getAttribute('aria-current'))).toEqual([null, 'page', null]);
  });

  it('is one tab stop on the active section; arrows, Home and End move focus without selecting; Enter selects', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<><button type="button">before</button><SettingsNav {...p} /><button type="button">after</button></>);
    await user.tab();
    await user.tab();
    expect(btn('notifications')).toHaveFocus();
    await user.tab();
    expect(btn('after')).toHaveFocus();
    await user.tab({ shift: true });
    await user.keyboard('{ArrowDown}');
    expect(btn('appearance')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(btn('appearance')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(btn('devices')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(btn('devices')).toHaveFocus();
    await user.keyboard('{End}');
    expect(btn('appearance')).toHaveFocus();
    expect(p.onSelect).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(p.onSelect).toHaveBeenCalledTimes(1);
    expect(p.onSelect).toHaveBeenLastCalledWith('appearance');
  });

  it('selects on click', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<SettingsNav {...p} />);
    await user.click(btn('devices'));
    expect(p.onSelect).toHaveBeenLastCalledWith('devices');
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><SettingsNav {...props()} /></div>);
    await expectNoAxeViolations(container);
  });
});
