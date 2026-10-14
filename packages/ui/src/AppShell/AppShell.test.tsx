import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ComposedShell } from './AppShell.fixture.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('AppShell', () => {
  it('follows the focus order of the keyboard map', async () => {
    const user = userEvent.setup();
    const { container } = render(<ComposedShell />);
    expect(container.firstElementChild).toHaveClass('d-app-shell');
    await user.tab();
    expect(screen.getByRole('link', { name: 'skip to messages' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Midgard Crew' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('tab', { name: 'channels' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'general' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('log', { name: 'messages in #general' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'message #general' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'send' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: /connection/ })).toHaveFocus();
  });

  it('moves focus to main from the skip link without changing the URL', async () => {
    const user = userEvent.setup();
    render(<ComposedShell />);
    const before = window.location.href;
    await user.tab();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
    expect(window.location.href).toBe(before);
  });

  it('holds the header, the log and the composer in main', () => {
    render(<ComposedShell />);
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { level: 2, name: 'general' })).toBeInTheDocument();
    expect(within(main).getByRole('log')).toBeInTheDocument();
    expect(within(main).getByRole('textbox', { name: 'message #general' })).toBeInTheDocument();
    expect(within(main).queryByRole('navigation')).toBeNull();
  });

  it('puts the banner above the rail in reading and focus order, only when given', async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<ComposedShell />);
    expect(container.querySelector('.d-app-shell__banner')).toBeNull();
    rerender(<ComposedShell banner />);
    const banner = container.querySelector('.d-app-shell__banner');
    const rail = container.querySelector('.d-app-shell__rail');
    expect(banner).not.toBeNull();
    expect(banner?.compareDocumentPosition(rail as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'retry now' })).toHaveFocus();
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><ComposedShell banner /></div>);
    await expectNoAxeViolations(container);
  });

  // web-3 (flow 06, task-9 ruling): the incoming-ring banner is the first thing in main; on a phone it is fixed to the top
  // of the shell and the grid moves down by its height, so it never covers the stage controls.
  it('puts the ring slot first in main, measures it and gives nothing without a ring', () => {
    const { rerender } = render(<ComposedShell ring={<section aria-label="incoming calls"><button type="button">answer</button></section>} />);
    const main = screen.getByRole('main');
    const slot = main.firstElementChild as HTMLElement;
    expect(slot).toHaveClass('d-app-shell__ring');
    expect(within(slot).getByRole('button', { name: 'answer' })).toBeInTheDocument();
    expect(within(main).getAllByRole('button')[0]).toHaveAccessibleName('answer');
    rerender(<ComposedShell />);
    expect(document.querySelector('.d-app-shell__ring')).toBeNull();
    expect(document.querySelector<HTMLElement>('.d-app-shell')!.style.getPropertyValue('--d-ring-h')).toBe('0px');
  });
});

// web3.4 (U6): the aside slot. Below 64rem of shell width it is an overlay drawer; at or above, a fourth grid column.
describe('AppShell aside', () => {
  const aside = <div><button type="button">pane control</button></div>;
  const open = (over: Record<string, unknown> = {}) =>
    ({ aside, asideLabel: 'members', asideOpen: true, onAsideClose: vi.fn(), ...over });

  it('without an aside the shell is unchanged: no aside landmark and no aside grid class', () => {
    const { container } = render(<ComposedShell />);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(container.querySelector('.d-app-shell__grid')?.className).toBe('d-app-shell__grid');
  });

  it('open: an aside landmark after main and before the status bar', () => {
    const { container } = render(<ComposedShell shell={open()} />);
    const side = screen.getByRole('complementary', { name: 'members' });
    const main = screen.getByRole('main');
    const status = container.querySelector('.d-app-shell__status') as Node;
    expect(main.compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(side.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.d-app-shell__grid')).toHaveClass('d-app-shell__grid--aside');
  });

  it('closed: absent, with the content not rendered either', () => {
    render(<ComposedShell shell={open({ asideOpen: false })} />);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('button', { name: 'pane control' })).toBeNull();
  });

  it('the focus order runs main, aside, status bar', async () => {
    const user = userEvent.setup();
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1280);
    render(<ComposedShell shell={open()} />);
    screen.getByRole('button', { name: 'send' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'pane control' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: /connection/ })).toHaveFocus();
    width.mockRestore();
  });

  it('as an overlay, focus moves into the aside on open, Escape calls onAsideClose and focus goes back to the opener', async () => {
    const user = userEvent.setup();
    const onAsideClose = vi.fn();
    const { rerender } = render(<ComposedShell shell={open({ asideOpen: false, onAsideClose })} />);
    const opener = screen.getByRole('button', { name: 'send' });
    opener.focus();
    rerender(<ComposedShell shell={open({ onAsideClose })} />);
    expect(screen.getByRole('button', { name: 'pane control' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onAsideClose).toHaveBeenCalledTimes(1);
    rerender(<ComposedShell shell={open({ asideOpen: false, onAsideClose })} />);
    expect(opener).toHaveFocus();
  });

  it('as a column (64rem or wider) Escape does not close it and opening does not take focus', async () => {
    const user = userEvent.setup();
    const onAsideClose = vi.fn();
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1280);
    const { rerender } = render(<ComposedShell shell={open({ asideOpen: false, onAsideClose })} />);
    const opener = screen.getByRole('button', { name: 'send' });
    opener.focus();
    rerender(<ComposedShell shell={open({ onAsideClose })} />);
    expect(opener).toHaveFocus();
    screen.getByRole('button', { name: 'pane control' }).focus();
    await user.keyboard('{Escape}');
    expect(onAsideClose).not.toHaveBeenCalled();
    width.mockRestore();
  });

  it('has no serious axe violations with the aside open', async () => {
    const { container } = render(<div className="d-root"><ComposedShell shell={open()} /></div>);
    await expectNoAxeViolations(container);
  });
});
