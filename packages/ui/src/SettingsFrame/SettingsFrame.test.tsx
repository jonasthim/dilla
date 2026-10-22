import { useLayoutEffect } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { SettingsFrame, type SettingsFrameProps } from './SettingsFrame.tsx';
import { SettingsNav } from '../SettingsNav/SettingsNav.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import { PhoneLayoutProvider } from '../internal/phoneLayout.ts';
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

  // web3.8 (N6): an Escape that ends an input-method composition belongs to the composition, and a bare <dialog> child
  // (not a ui Dialog) owns its own Escape too.
  it('an Escape that ends a composition does not close the frame, on a control inside it or at the document', () => {
    const p = props({ children: <input aria-label="name" /> });
    render(<SettingsFrame {...p} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'name' }), { key: 'Escape', isComposing: true });
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'name' }), { key: 'Escape' });
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('with focus in a bare <dialog open> child, a document Escape does not close the frame', () => {
    const p = props({ children: <dialog open aria-label="bare"><button type="button">inside</button></dialog> });
    render(<PhoneLayoutProvider value><SettingsFrame {...p} /></PhoneLayoutProvider>);
    act(() => { screen.getByRole('button', { name: 'inside' }).focus(); });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'inside' }), { key: 'Escape' });
    expect(p.onClose).not.toHaveBeenCalled();
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

  it('closes the native dialog in the commit that empties it, before any passive effect runs', () => {
    // As Dialog's: a later sibling's layout effect sees what a key event before React's next task would meet.
    const seen: string[] = [];
    function Probe({ open }: { open: boolean }) {
      useLayoutEffect(() => {
        const el = document.querySelector('dialog');
        seen.push(`${String(open)}:${String(el?.open)}:${String(el?.childElementCount)}`);
      }, [open]);
      return null;
    }
    const p = props();
    const { rerender } = render(<><SettingsFrame {...p} /><Probe open /></>);
    rerender(<><SettingsFrame {...p} open={false} /><Probe open={false} /></>);
    expect(seen.at(-1)).toBe('false:false:0');
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

  it('on desktop opens with showModal', () => {
    const modal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const plain = vi.spyOn(HTMLDialogElement.prototype, 'show');
    render(<SettingsFrame {...props()} />);
    expect(modal).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  describe('inside the phone layout', () => {
    const phone = (over: Partial<SettingsFrameProps> = {}) => render(<PhoneLayoutProvider value><SettingsFrame {...props(over)} /></PhoneLayoutProvider>);

    it('opens non-modal (show, not showModal) and the title takes focus', () => {
      const modal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
      const plain = vi.spyOn(HTMLDialogElement.prototype, 'show');
      phone();
      expect(modal).not.toHaveBeenCalled();
      expect(plain).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('dialog', { name: 'Settings' })).not.toHaveAttribute('aria-modal');
      expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toHaveFocus();
      vi.restoreAllMocks();
    });

    it('closes on Escape through its own key handler', async () => {
      const user = userEvent.setup();
      const p = props();
      render(<PhoneLayoutProvider value><SettingsFrame {...p} /></PhoneLayoutProvider>);
      await user.keyboard('{Escape}');
      expect(p.onClose).toHaveBeenCalledTimes(1);
    });

    it('closes on Escape pressed outside the frame (focus on the tab bar), once', async () => {
      const user = userEvent.setup();
      const p = props();
      render(<><PhoneLayoutProvider value><SettingsFrame {...p} /></PhoneLayoutProvider><button type="button">tab</button></>);
      screen.getByRole('button', { name: 'tab' }).focus();
      await user.keyboard('{Escape}');
      expect(p.onClose).toHaveBeenCalledTimes(1);
    });

    it('does not close on an Escape a nested dialog handled', async () => {
      const user = userEvent.setup();
      const p = props();
      render(<PhoneLayoutProvider value><SettingsFrame {...p}><Dialog open title="Remove this device?" onClose={vi.fn()}><p>x</p></Dialog></SettingsFrame></PhoneLayoutProvider>);
      act(() => { screen.getByRole('dialog', { name: 'Remove this device?' }).focus(); });
      await user.keyboard('{Escape}');
      expect(p.onClose).not.toHaveBeenCalled();
    });

    it('stays open when a nested element handled Escape (preventDefault)', () => {
      const p = props();
      render(<PhoneLayoutProvider value><SettingsFrame {...p}><input aria-label="key capture" onKeyDown={e => e.preventDefault()} /></SettingsFrame></PhoneLayoutProvider>);
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'key capture' }), { key: 'Escape' });
      expect(p.onClose).not.toHaveBeenCalled();
    });

    it('ignores an Escape that ends an input-method composition', () => {
      const p = props();
      render(<><PhoneLayoutProvider value><SettingsFrame {...p} /></PhoneLayoutProvider><button type="button">tab</button></>);
      fireEvent.keyDown(screen.getByRole('button', { name: 'tab' }), { key: 'Escape', isComposing: true });
      expect(p.onClose).not.toHaveBeenCalled();
    });

    it('an explicit modal prop wins', () => {
      const modal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
      phone({ modal: true });
      expect(modal).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    });
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

// R17, I5, I8: one hairline at y=48 across the side title and the section bar; the one sticky save footer; no repeated
// title on a phone (H5). jsdom has no layout, so these read the rules.
describe('SettingsFrame bar and footer (I8, R17)', () => {
  let css = '';
  let base = '';
  beforeAll(async () => {
    const fs = await import(/* @vite-ignore */ 'node:fs' as string) as { readFileSync(path: string, encoding: 'utf8'): string };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    css = fs.readFileSync(`${cwd}/src/SettingsFrame/SettingsFrame.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    base = fs.readFileSync(`${cwd}/src/styles/base.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  });
  const rule = (src: string, selector: string) => new RegExp(`${selector.replace(/[.[\]"=-]/g, '\\$&')} \\{([^}]*)\\}`).exec(src)?.[1] ?? '';

  it('the side title and the section bar are the same height, with the same hairline: one line at y=48', () => {
    for (const sel of ['.d-settings-frame__title', '.d-settings-frame__bar']) {
      const r = rule(css, sel);
      expect(r, sel).toMatch(/box-sizing: border-box;/);
      expect(r, sel).toMatch(/height: var\(--bar-h\);/);
      expect(r, sel).toMatch(/border-bottom: 1px solid var\(--hairline\);/);
    }
  });

  it('renders the footer after the body, in the pane, and is absent without it', () => {
    const { rerender } = render(<SettingsFrame {...props({ footer: <button type="button">save</button> })} />);
    const footer = screen.getByRole('button', { name: 'save' }).closest('.d-settings-frame__footer');
    expect(footer).not.toBeNull();
    expect(footer?.previousElementSibling).toHaveClass('d-settings-frame__body');
    expect(footer?.parentElement).toHaveClass('d-settings-frame__pane');
    rerender(<SettingsFrame {...props()} />);
    expect(document.querySelector('.d-settings-frame__footer')).toBeNull();
  });

  it('the footer is sticky to the bottom of the pane', () => {
    const r = rule(css, '.d-settings-frame__footer');
    expect(r).toMatch(/position: sticky;/);
    expect(r).toMatch(/bottom: 0;/);
  });

  it('a phone layout sets data-layout and does not repeat the title', () => {
    render(<PhoneLayoutProvider value><SettingsFrame {...props()} /></PhoneLayoutProvider>);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveAttribute('data-layout', 'phone');
    expect(rule(base, '.d-settings-frame[data-layout="phone"] .d-settings-frame__title')).toMatch(/clip-path: inset\(50%\);/);
  });

  // H5: the PhoneHeader is the heading, so the section's own h2 is visually hidden on a phone and kept for its name and focus.
  it('hides the section heading on a phone, where the PhoneHeader is the heading', () => {
    expect(rule(css, '.d-settings-frame[data-layout="phone"] .d-settings-frame__body section > h2:first-child')).toMatch(/clip-path: inset\(50%\);/);
  });

  it('a desktop frame has no data-layout', () => {
    render(<SettingsFrame {...props()} />);
    expect(screen.getByRole('dialog', { name: 'Settings' })).not.toHaveAttribute('data-layout');
  });
});
