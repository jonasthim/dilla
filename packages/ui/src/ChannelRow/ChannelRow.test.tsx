import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ChannelRow } from './ChannelRow.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('ChannelRow', () => {
  it('is a button named after the channel and selectable by keyboard', async () => {
    const onSelect = vi.fn();
    render(<ChannelRow name="loot" kind="text" onSelect={onSelect} />);
    const row = screen.getByRole('button', { name: /^loot/ });
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
  it('marks the active channel with aria-current', () => {
    render(<ChannelRow name="loot" kind="text" active onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: /^loot/ })).toHaveAttribute('aria-current', 'page');
  });
  it('shows the unread pill, the mention pill (which replaces unread), and the readable glyph', () => {
    render(<><ChannelRow name="general" kind="text" unread={3} onSelect={() => {}} /><ChannelRow name="screenshots" kind="text" unread={3} mentions={12} onSelect={() => {}} /><ChannelRow name="lfg" kind="text" readable onSelect={() => {}} /></>);
    expect(screen.getByLabelText('3 unread')).toBeInTheDocument();
    expect(screen.getByLabelText('12 mentions')).toBeInTheDocument();
    expect(screen.queryAllByLabelText('3 unread')).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'Readable by this server' })).toBeInTheDocument();
  });
  it('shows the lock on private voice channels and a muted state', () => {
    render(<ChannelRow name="sauna" kind="voice" private muted onSelect={() => {}} />);
    const row = screen.getByRole('button', { name: /^sauna/ });
    expect(row).toHaveAttribute('data-muted', 'true');
    expect(screen.getByRole('img', { name: 'Private' })).toBeInTheDocument();
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><ChannelRow name="loot" kind="text" active unread={4} onSelect={() => {}} /></div>);
    await expectNoAxeViolations(container);
  });
});
