import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SidebarTabs, type SidebarTabsProps } from './SidebarTabs.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

// L-COPY-02: shell.tabs.label, shell.tabs.channels, shell.tabs.dms.
type Tabs = SidebarTabsProps['tabs'];
const QUIET: Tabs = [{ id: 'channels', label: 'channels' }, { id: 'dms', label: 'direct messages' }];

function Controlled({ tabs = QUIET, onValue }: { tabs?: Tabs; onValue?: (id: string) => void }) {
  const [active, setActive] = useState('channels');
  return (
    <>
      <button type="button">before</button>
      <SidebarTabs label="sidebar" tabs={tabs} activeId={active} onSelect={id => { setActive(id); onValue?.(id); }} />
      <button type="button">after</button>
    </>
  );
}
const tab = (name: string) => screen.getByRole('tab', { name });

describe('SidebarTabs', () => {
  it('is a tablist named by its label, one tab button per entry, the active one selected', () => {
    const { container } = render(<SidebarTabs label="sidebar" tabs={QUIET} activeId="dms" onSelect={() => {}} />);
    const list = screen.getByRole('tablist', { name: 'sidebar' });
    expect(container.firstElementChild).toBe(list);
    expect(list).toHaveClass('d-sidebar-tabs');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map(t => t.tagName)).toEqual(['BUTTON', 'BUTTON']);
    expect(tabs.map(t => t.textContent)).toEqual(['channels', 'direct messages']);
    expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    expect(tabs.map(t => t.getAttribute('data-count'))).toEqual(['0', '0']);
  });

  it('is one tab stop, on the selected tab', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.tab();
    await user.tab();
    expect(tab('channels')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(tab('channels')).toHaveFocus();
  });

  it('moves and selects with ArrowLeft and ArrowRight, wrapping, and with Home and End', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Controlled onValue={onValue} />);
    await user.tab();
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(tab('direct messages')).toHaveFocus();
    expect(tab('direct messages')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(tab('channels')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(tab('direct messages')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tab('channels')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(tab('direct messages')).toHaveFocus();
    expect(onValue.mock.calls.map(c => c[0])).toEqual(['dms', 'channels', 'dms', 'channels', 'dms']);
  });

  it('leaves ArrowUp, ArrowDown and modified arrows alone, and selects on click', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Controlled onValue={onValue} />);
    await user.tab();
    await user.tab();
    await user.keyboard('{ArrowDown}{ArrowUp}{Alt>}{ArrowRight}{/Alt}');
    expect(tab('channels')).toHaveFocus();
    expect(onValue).not.toHaveBeenCalled();
    await user.click(tab('direct messages'));
    expect(onValue.mock.calls.map(c => c[0])).toEqual(['dms']);
  });

  it('shows the unread count as a pill, a mention pill in its place when there are mentions, and nothing at zero', () => {
    const { rerender } = render(<SidebarTabs label="sidebar" activeId="channels" onSelect={() => {}}
      tabs={[{ id: 'channels', label: 'channels' }, { id: 'dms', label: 'direct messages', count: 2 }]} />);
    expect(tab('direct messages 2 unread')).toHaveAttribute('data-count', '2');
    expect(tab('channels')).toHaveAttribute('data-count', '0');
    rerender(<SidebarTabs label="sidebar" activeId="channels" onSelect={() => {}}
      tabs={[{ id: 'channels', label: 'channels' }, { id: 'dms', label: 'direct messages', count: 2, mentions: 1 }]} />);
    expect(tab('direct messages 1 mention')).toHaveAttribute('data-mentions', '1');
    rerender(<SidebarTabs label="sidebar" activeId="channels" onSelect={() => {}}
      tabs={[{ id: 'channels', label: 'channels' }, { id: 'dms', label: 'direct messages', count: 0 }]} />);
    expect(tab('direct messages')).toHaveAttribute('data-count', '0');
    expect(document.querySelector('.d-pill')).toBeNull();
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><SidebarTabs label="sidebar" activeId="dms" onSelect={() => {}}
      tabs={[{ id: 'channels', label: 'channels', count: 12 }, { id: 'dms', label: 'direct messages', count: 3, mentions: 2 }]} /></div>);
    await expectNoAxeViolations(container);
  });
});
