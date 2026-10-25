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

  it('always opens as a native modal workspace, including inside the phone layout', () => {
    const modal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const plain = vi.spyOn(HTMLDialogElement.prototype, 'show');
    render(<PhoneLayoutProvider value><SettingsFrame {...props()} /></PhoneLayoutProvider>);
    expect(modal).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveAttribute('aria-modal', 'true');
    vi.restoreAllMocks();
  });

  it('shows the grouped index and identity on the phone index page', () => {
    render(<PhoneLayoutProvider value><SettingsFrame {...props({
      phonePage: 'index', identity: <div>Signed in as Ada</div>, search: <input aria-label="Search settings" />,
    })} /></PhoneLayoutProvider>);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByText('Signed in as Ada')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Search settings' })).toBeInTheDocument();
    expect(within(dialog).getByRole('navigation', { name: 'settings sections' })).toBeVisible();
    expect(within(dialog).queryByRole('heading', { level: 2, name: 'Devices' })).toBeNull();
  });

  it('shows Back and the section on a phone section page, with no section index', () => {
    const onBack = vi.fn();
    render(<PhoneLayoutProvider value><SettingsFrame {...props({ phonePage: 'section', sectionTitle: 'Devices', onBack })} /></PhoneLayoutProvider>);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(dialog).queryByRole('navigation', { name: 'settings sections' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Devices' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Close settings' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('moves focus between the selected section and Back across phone pages', () => {
    const onBack = vi.fn();
    const p = props({ phonePage: 'index', onBack });
    const { rerender } = render(<PhoneLayoutProvider value><SettingsFrame {...p} /></PhoneLayoutProvider>);
    rerender(<PhoneLayoutProvider value><SettingsFrame {...p} phonePage="section" sectionTitle="Devices" /></PhoneLayoutProvider>);
    expect(screen.getByRole('button', { name: 'Back' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    rerender(<PhoneLayoutProvider value><SettingsFrame {...p} phonePage="index" /></PhoneLayoutProvider>);
    expect(screen.getByRole('button', { name: 'devices' })).toHaveFocus();
  });

  it('keeps Close on a phone index page and makes backdrop clicks inert', () => {
    const p = props({ phonePage: 'index' });
    render(<PhoneLayoutProvider value><SettingsFrame {...p} /></PhoneLayoutProvider>);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('button', { name: 'Close settings' })).toBeInTheDocument();
    fireEvent.click(dialog);
    expect(p.onClose).not.toHaveBeenCalled();
  });

  it('places activity controls inside the dialog and exposes the content container ref and wide measure', () => {
    let content: HTMLDivElement | null = null;
    render(<SettingsFrame {...props({
      activity: <button type="button">Return to call</button>, wide: true, contentRef: node => { content = node; },
    })} />);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('button', { name: 'Return to call' })).toBeInTheDocument();
    expect(content).toBe(dialog.querySelector('.d-settings-frame__body'));
    expect(content).toHaveClass('d-settings-frame__body--wide');
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

  it('returns focus to the opener, or to a visible main landmark when the opener disappeared', () => {
    const p = props();
    function Fixture({ open, showOpener }: { open: boolean; showOpener: boolean }) {
      return <><main tabIndex={-1} aria-label="Main content" />{showOpener ? <button type="button" data-testid="opener">Open settings</button> : null}<SettingsFrame {...p} open={open} /></>;
    }
    const { rerender } = render(<Fixture open={false} showOpener />);
    const opener = screen.getByTestId('opener');
    opener.focus();
    rerender(<Fixture open showOpener />);
    rerender(<Fixture open={false} showOpener />);
    expect(opener).toHaveFocus();
    rerender(<Fixture open showOpener />);
    rerender(<Fixture open={false} showOpener={false} />);
    expect(screen.getByRole('main', { name: 'Main content' })).toHaveFocus();
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

    it('uses the fullscreen phone layout and the title takes focus', () => {
      const modal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
      const plain = vi.spyOn(HTMLDialogElement.prototype, 'show');
      phone();
      expect(modal).toHaveBeenCalledTimes(1);
      expect(plain).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveAttribute('aria-modal', 'true');
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

    it('keeps Escape outside the frame within the modal workspace', async () => {
      const user = userEvent.setup();
      const p = props();
      render(<><PhoneLayoutProvider value><SettingsFrame {...p} /></PhoneLayoutProvider><button type="button">tab</button></>);
      screen.getByRole('button', { name: 'tab' }).focus();
      await user.keyboard('{Escape}');
      expect(p.onClose).not.toHaveBeenCalled();
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

    it('stays modal when the deprecated modal prop is false', () => {
      const modal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
      phone({ modal: false });
      expect(modal).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    });
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><SettingsFrame {...props()} /></div>);
    await expectNoAxeViolations(container);
  });
});

// jsdom computes no layout, so the frame geometry assertions below read the layout rules themselves.
describe('SettingsFrame stacked (A11Y-DESIGN-01)', () => {
  let stacked = '';
  beforeAll(async () => {
    const fs = await import(/* @vite-ignore */ 'node:fs' as string) as { readFileSync(path: string, encoding: 'utf8'): string };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    stacked = fs.readFileSync(`${cwd}/src/SettingsFrame/SettingsFrame.css`, 'utf8');
  });

  it('keeps the sidebar and content as independent columns with their own scroll regions', () => {
    expect(stacked).not.toBe('');
    expect(stacked).toMatch(/\.d-settings-frame__side \{[^}]*overflow-y: auto;/);
    expect(stacked).toMatch(/\.d-settings-frame__body \{[^}]*overflow-y: auto;/);
  });

  it('uses a 15rem grouped sidebar and bounded 48rem and 64rem content measures', async () => {
    const fs = await import(/* @vite-ignore */ 'node:fs' as string) as { readFileSync(path: string, encoding: 'utf8'): string };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = fs.readFileSync(`${cwd}/src/SettingsFrame/SettingsFrame.css`, 'utf8');
    expect(css).toMatch(/grid-template-columns: 15rem minmax\(0, 1fr\)/);
    expect(css).toContain('width: min(100%, 48rem)');
    expect(css).toContain('width: min(100%, 64rem)');
    expect(css).toContain('min\(80rem');
  });
});

// R17, I5, I8: one hairline at y=48 across the side title and the section bar; the one sticky save footer; no repeated
// title on a phone (H5). jsdom has no layout, so these read the rules.
describe('SettingsFrame bar and footer (I8, R17)', () => {
  let css = '';
  beforeAll(async () => {
    const fs = await import(/* @vite-ignore */ 'node:fs' as string) as { readFileSync(path: string, encoding: 'utf8'): string };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    css = fs.readFileSync(`${cwd}/src/SettingsFrame/SettingsFrame.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  });
  const rule = (src: string, selector: string) => new RegExp(`${selector.replace(/[.[\]"=-]/g, '\\$&')} \\{([^}]*)\\}`).exec(src)?.[1] ?? '';

  it('uses the 2rem and 1rem body spacing and has no floating shadow or perimeter', () => {
    const body = rule(css, '.d-settings-frame__body');
    const frame = rule(css, '.d-settings-frame');
    expect(body).toMatch(/padding: 2rem 1rem 1rem;/);
    expect(frame).toMatch(/border: 0;/);
    expect(frame).toMatch(/box-shadow: none;/);
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

  it('a phone layout sets the section page and hides the repeated title', () => {
    render(<PhoneLayoutProvider value><SettingsFrame {...props()} /></PhoneLayoutProvider>);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveAttribute('data-layout', 'phone');
    expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveAttribute('data-phone-page', 'section');
    expect(rule(css, '.d-settings-frame[data-layout="phone"] .d-settings-frame__title')).toMatch(/clip-path: inset\(50%\);/);
  });

  it('uses the existing narrow and landscape/coarse-pointer phone breakpoint with visual viewport and safe area', () => {
    expect(css).toContain('.d-settings-frame.d-settings-frame[data-layout="phone"]');
    expect(css).toContain('var(--d-vvtop, 0px)');
    expect(css).toContain('var(--d-vvh, 100dvh)');
    expect(css).toContain('env(safe-area-inset-bottom)');
  });

  it('keeps the content section heading available to assistive technology without repeating the phone bar title', () => {
    const selector = '.d-settings-frame[data-layout="phone"][data-phone-page="section"] .d-settings-frame__body > section > h2:first-child';
    expect(rule(css, selector)).toMatch(/clip-path: inset\(50%\);/);
  });

  it('a desktop frame has no data-layout', () => {
    render(<SettingsFrame {...props()} />);
    expect(screen.getByRole('dialog', { name: 'Settings' })).not.toHaveAttribute('data-layout');
  });
});
