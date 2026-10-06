import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SettingsFrame, type SettingsFrameProps } from './SettingsFrame.tsx';
import { SettingsNav } from '../SettingsNav/SettingsNav.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

// L-COPY-02: settings.title, settings.close, settings.nav.*, devices.title, devices.refresh.
const ITEMS = [{ id: 'devices', label: 'devices' }, { id: 'notifications', label: 'notifications' }, { id: 'appearance', label: 'appearance' }] as const;
function props(over: Partial<SettingsFrameProps> = {}): SettingsFrameProps {
  return {
    open: true, title: 'Settings', closeLabel: 'Close settings', onClose: vi.fn(),
    nav: <SettingsNav label="settings sections" items={ITEMS} activeId="devices" onSelect={() => {}} />,
    children: <section aria-labelledby="devices-title"><h2 id="devices-title">Devices</h2><button type="button">refresh</button></section>,
    ...over,
  };
}

describe('SettingsFrame', () => {
  it('opens as a modal dialog named by its h1, and the h1 takes focus', () => {
    render(<SettingsFrame {...props()} />);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog).toHaveClass('d-settings-frame');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { level: 1, name: 'Settings' })).toHaveFocus();
  });

  it('holds the navigation and the section', () => {
    render(<SettingsFrame {...props()} />);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('navigation', { name: 'settings sections' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Devices' })).toBeInTheDocument();
  });

  it('tabs from the heading to the navigation, the close button, then the section', async () => {
    const user = userEvent.setup();
    render(<SettingsFrame {...props()} />);
    await user.tab();
    expect(screen.getByRole('button', { name: 'devices' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close settings' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'refresh' })).toHaveFocus();
  });

  it('calls onClose on Escape and from the close button', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<SettingsFrame {...p} />);
    await user.keyboard('{Escape}');
    expect(p.onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });

  // Pre-flight ruling (row 1.2): Escape inside a nested dialog (remove, sign out, forget) belongs to that
  // dialog and never reaches the frame, so a revoke in flight is never unmounted with the frame.
  it('leaves an Escape or a cancel inside a nested dialog to that dialog', async () => {
    const user = userEvent.setup();
    const p = props();
    const onDialogClose = vi.fn();
    render(
      <SettingsFrame {...p}>
        <section aria-labelledby="devices-title">
          <h2 id="devices-title">Devices</h2>
          <Dialog open title="Remove this device?" onClose={onDialogClose}><p>x</p></Dialog>
        </section>
      </SettingsFrame>,
    );
    const nested = screen.getByRole('dialog', { name: 'Remove this device?' });
    act(() => { nested.focus(); });
    expect(nested).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onDialogClose).toHaveBeenCalledTimes(1);
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent(nested, new Event('cancel', { cancelable: true }));
    expect(onDialogClose).toHaveBeenCalledTimes(2);
    expect(p.onClose).not.toHaveBeenCalled();
    act(() => { screen.getByRole('heading', { level: 1, name: 'Settings' }).focus(); });
    await user.keyboard('{Escape}');
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes the native dialog when open flips to false, so the browser returns focus', () => {
    const close = vi.spyOn(HTMLDialogElement.prototype, 'close');
    const p = props();
    const { rerender } = render(<SettingsFrame {...p} />);
    expect(close).not.toHaveBeenCalled();
    rerender(<SettingsFrame {...p} open={false} />);
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
  });

  it('renders no content while closed', () => {
    render(<SettingsFrame {...props({ open: false })} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('focuses the heading again when it reopens', () => {
    const p = props();
    const { rerender } = render(<SettingsFrame {...p} />);
    rerender(<SettingsFrame {...p} open={false} />);
    rerender(<SettingsFrame {...p} open />);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toHaveFocus();
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><SettingsFrame {...props()} /></div>);
    await expectNoAxeViolations(container);
  });
});
