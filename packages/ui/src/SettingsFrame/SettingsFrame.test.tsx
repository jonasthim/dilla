import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, it, expect, vi } from 'vitest';
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

// A11Y-DESIGN-01: at 320 × 256 (400 % zoom) the stacked frame left the section a strip two lines high. Stacked, the
// whole panel scrolls as one column. jsdom computes no layout or container query, so this reads the rules themselves;
// the Settings/SettingsFrame ZoomedIn story measures the result in a browser (.storybook/test-runner.ts).
describe('SettingsFrame stacked (A11Y-DESIGN-01)', () => {
  // The test config reads no CSS (css: false), and this package has no Node types: the file is read through a dynamic
  // import of node:fs, from the package directory the runner starts in.
  let stacked = '';
  beforeAll(async () => {
    const fs = await import(/* @vite-ignore */ 'node:fs' as string) as { readFileSync(path: string, encoding: 'utf8'): string };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const base = fs.readFileSync(`${cwd}/src/styles/base.css`, 'utf8');
    stacked = /@container d-settings \(max-width: 44\.99rem\) \{([\s\S]*?)\n\}/.exec(base)?.[1] ?? '';
  });
  const rule = (selector: string): string => new RegExp(`\\.d-settings-frame \\.${selector} \\{([^}]*)\\}`).exec(stacked)?.[1] ?? '';

  it('scrolls the panel as one column: two auto rows and its own vertical scroll', () => {
    expect(stacked).not.toBe('');
    expect(rule('d-settings-frame__panel')).toMatch(/grid-template-rows: auto auto;/);
    expect(rule('d-settings-frame__panel')).toMatch(/overflow-y: auto;/);
  });

  it('lets the navigation and the section grow with their content instead of scrolling each', () => {
    expect(rule('d-settings-frame__side')).toMatch(/overflow: visible;/);
    expect(rule('d-settings-frame__side')).toMatch(/min-height: auto;/);
    expect(rule('d-settings-frame__body')).toMatch(/overflow: visible;/);
    expect(rule('d-settings-frame__pane')).toMatch(/min-height: auto;/);
  });
});
