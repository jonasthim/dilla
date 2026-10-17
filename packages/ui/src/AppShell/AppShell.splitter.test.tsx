import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ComposedShell } from './AppShell.fixture.tsx';
import { clampPanes } from './AppShell.tsx';

const REM = 16;
const labels = { sidebar: 'resize the channel list', aside: 'resize the member list' };
const aside = <div><button type="button">pane control</button></div>;

describe('clampPanes (16px rem)', () => {
  const base = { rail: 60, rem: REM };

  it('shell 1280 with an aside column of 240: the sidebar may reach 24rem', () => {
    expect(clampPanes({ ...base, shell: 1280, sidebar: 500, aside: 240, asideColumn: true })).toEqual({ sidebar: 384, aside: 240 });
  });

  it('shell 1000 with an aside column of 240: the sidebar max is 316, so a requested 360 clamps to 316', () => {
    expect(clampPanes({ ...base, shell: 1000, sidebar: 360, aside: 240, asideColumn: true }).sidebar).toBe(316);
  });

  it('shell 800 with an aside column of 224: the minimums win (192 and 224)', () => {
    expect(clampPanes({ ...base, shell: 800, sidebar: 240, aside: 224, asideColumn: true })).toEqual({ sidebar: 192, aside: 224 });
  });

  it('shell 900 with an aside column of 224: they do not win (main is 424)', () => {
    const r = clampPanes({ ...base, shell: 900, sidebar: 240, aside: 224, asideColumn: true });
    expect(900 - 60 - r.sidebar - r.aside).toBeGreaterThanOrEqual(24 * REM);
    expect(r.sidebar).toBe(232);
  });

  it('keeps the sidebar in [12rem, 24rem] and the aside in [14rem, 28rem]', () => {
    expect(clampPanes({ ...base, shell: 2000, sidebar: 10, aside: 10, asideColumn: true })).toEqual({ sidebar: 192, aside: 224 });
    expect(clampPanes({ ...base, shell: 2000, sidebar: 900, aside: 900, asideColumn: true })).toEqual({ sidebar: 384, aside: 448 });
  });

  it('without an aside column the aside takes no room from main', () => {
    expect(clampPanes({ ...base, shell: 700, sidebar: 384, aside: 448, asideColumn: false }).sidebar).toBe(256);
  });

  it('scales with the root font size', () => {
    expect(clampPanes({ ...base, rem: 20, shell: 2400, sidebar: 900, aside: 240, asideColumn: false }).sidebar).toBe(480);
  });
});

describe('AppShell splitters', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  let shellW = 1280;
  const stubWidths = () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('d-app-shell') ? shellW : this.classList.contains('d-app-shell__rail') ? 60 : 0;
    });
  };
  const shellProps = (over: Record<string, unknown> = {}) => ({
    resizeLabels: labels, paneWidths: { sidebar: 240, aside: 240 }, onPaneResize: vi.fn(),
    aside, asideLabel: 'members', asideOpen: true, onAsideClose: vi.fn(), ...over,
  });
  const sep = (name: string) => screen.getByRole('separator', { name });

  it('renders a vertical separator with px values; the sidebar one ends the sidebar, the aside one starts the aside', () => {
    shellW = 1280; stubWidths();
    const { container } = render(<ComposedShell shell={shellProps()} />);
    const s = sep(labels.sidebar);
    expect(s).toHaveAttribute('aria-orientation', 'vertical');
    expect(s).toHaveAttribute('tabindex', '0');
    expect(s).toHaveAttribute('aria-valuenow', '240');
    expect(s).toHaveAttribute('aria-valuemin', '192');
    expect(s).toHaveAttribute('aria-valuemax', '384');
    const sidebar = container.querySelector('.d-app-shell__sidebar')!;
    expect(sidebar.lastElementChild).toBe(s);
    expect(s).toHaveAttribute('aria-controls', sidebar.id);
    expect(sidebar.id).not.toBe('');
    const a = sep(labels.aside);
    const side = screen.getByRole('complementary', { name: 'members' });
    expect(side.firstElementChild).toBe(a);
    expect(a).toHaveAttribute('aria-controls', side.id);
    expect(a).toHaveAttribute('aria-valuemin', '224');
    expect(a).toHaveAttribute('aria-valuemax', '448');
    expect(container.querySelector('.d-app-shell')).toHaveStyle({ '--d-sidebar-w': '240px', '--d-aside-w': '240px' });
  });

  it('focus order: sidebar, its splitter, then main', () => {
    shellW = 1280; stubWidths();
    const { container } = render(<ComposedShell shell={shellProps({ aside: undefined })} />);
    const s = sep(labels.sidebar);
    const main = container.querySelector('main')!;
    expect(s.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('separator', { name: labels.aside })).toBeNull();
  });

  it('no splitter on a phone, none without resizeLabels, none for an overlay aside', () => {
    shellW = 1280; stubWidths();
    const { unmount } = render(<ComposedShell shell={shellProps({ layout: 'phone' })} />);
    expect(screen.queryAllByRole('separator')).toHaveLength(0);
    unmount();
    const b = render(<ComposedShell shell={shellProps({ resizeLabels: undefined })} />);
    expect(screen.queryAllByRole('separator')).toHaveLength(0);
    expect(b.container.querySelector('.d-app-shell')?.getAttribute('style') ?? '').not.toContain('--d-sidebar-w');
    b.unmount();
    shellW = 800; stubWidths();
    render(<ComposedShell shell={shellProps()} />);
    expect(screen.getByRole('separator', { name: labels.sidebar })).toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: labels.aside })).toBeNull();
  });

  const key = (el: HTMLElement, k: string, shiftKey = false) => fireEvent.keyDown(el, { key: k, shiftKey });

  it('ArrowRight and ArrowLeft move the sidebar by 16px, 64px with Shift', () => {
    shellW = 1280; stubWidths();
    const onPaneResize = vi.fn();
    render(<ComposedShell shell={shellProps({ onPaneResize })} />);
    const s = sep(labels.sidebar);
    key(s, 'ArrowRight');
    expect(onPaneResize).toHaveBeenLastCalledWith('sidebar', 256);
    key(s, 'ArrowLeft');
    expect(onPaneResize).toHaveBeenLastCalledWith('sidebar', 224);
    key(s, 'ArrowRight', true);
    expect(onPaneResize).toHaveBeenLastCalledWith('sidebar', 304);
    key(s, 'ArrowLeft', true);
    expect(onPaneResize).toHaveBeenLastCalledWith('sidebar', 192);
  });

  it('the aside splitter is mirrored: ArrowLeft widens it', () => {
    shellW = 1280; stubWidths();
    const onPaneResize = vi.fn();
    render(<ComposedShell shell={shellProps({ onPaneResize })} />);
    const a = sep(labels.aside);
    key(a, 'ArrowLeft');
    expect(onPaneResize).toHaveBeenLastCalledWith('aside', 256);
    key(a, 'ArrowRight', true);
    expect(onPaneResize).toHaveBeenLastCalledWith('aside', 224);
  });

  it('Home goes to the minimum, End to the maximum, Enter resets', () => {
    shellW = 1280; stubWidths();
    const onPaneResize = vi.fn();
    render(<ComposedShell shell={shellProps({ onPaneResize })} />);
    const s = sep(labels.sidebar);
    key(s, 'Home');
    expect(onPaneResize).toHaveBeenLastCalledWith('sidebar', 192);
    key(s, 'End');
    expect(onPaneResize).toHaveBeenLastCalledWith('sidebar', 384);
    key(s, 'Enter');
    expect(onPaneResize).toHaveBeenLastCalledWith('sidebar', null);
    const a = sep(labels.aside);
    key(a, 'Home');
    expect(onPaneResize).toHaveBeenLastCalledWith('aside', 224);
    key(a, 'End');
    expect(onPaneResize).toHaveBeenLastCalledWith('aside', 448);
  });

  it('a key stops at the limit that keeps main at 24rem', () => {
    // 64rem is the narrowest shell with an aside column: 1024 - 60 - 224 - 384 = 356.
    shellW = 1024; stubWidths();
    const onPaneResize = vi.fn();
    render(<ComposedShell shell={shellProps({ onPaneResize, paneWidths: { sidebar: 240, aside: 224 } })} />);
    const s = sep(labels.sidebar);
    expect(s).toHaveAttribute('aria-valuemax', '356');
    key(s, 'End');
    expect(onPaneResize).toHaveBeenLastCalledWith('sidebar', 356);
  });

  const pointer = (el: HTMLElement, type: string, clientX: number, button = 0) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button });
    Object.assign(e, { pointerId: 7 });
    act(() => { el.dispatchEvent(e); });
  };

  it('a pointer drag moves the property live, sets data-resizing, and commits once on pointerup', () => {
    shellW = 1280; stubWidths();
    const onPaneResize = vi.fn();
    const { container } = render(<ComposedShell shell={shellProps({ onPaneResize })} />);
    const s = sep(labels.sidebar);
    const capture = vi.fn();
    Object.assign(s, { setPointerCapture: capture, releasePointerCapture: vi.fn(), hasPointerCapture: () => true });
    const root = container.querySelector('.d-app-shell') as HTMLElement;
    pointer(s, 'pointerdown', 300);
    expect(capture).toHaveBeenCalledWith(7);
    pointer(s, 'pointermove', 340);
    expect(root).toHaveAttribute('data-resizing');
    expect(root).toHaveStyle({ '--d-sidebar-w': '280px' });
    expect(onPaneResize).not.toHaveBeenCalled();
    pointer(s, 'pointermove', 360);
    pointer(s, 'pointerup', 360);
    pointer(s, 'lostpointercapture', 360);
    expect(onPaneResize).toHaveBeenCalledTimes(1);
    expect(onPaneResize).toHaveBeenCalledWith('sidebar', 300);
    expect(root).not.toHaveAttribute('data-resizing');
  });

  it('the aside drags the other way and a drag past the limit stops there', () => {
    shellW = 1280; stubWidths();
    const onPaneResize = vi.fn();
    render(<ComposedShell shell={shellProps({ onPaneResize })} />);
    const a = sep(labels.aside);
    Object.assign(a, { setPointerCapture: vi.fn() });
    pointer(a, 'pointerdown', 900);
    pointer(a, 'pointermove', 1500);
    pointer(a, 'pointerup', 1500);
    expect(onPaneResize).toHaveBeenCalledWith('aside', 224);
  });

  it('a secondary button does not start a drag', () => {
    shellW = 1280; stubWidths();
    const onPaneResize = vi.fn();
    const { container } = render(<ComposedShell shell={shellProps({ onPaneResize })} />);
    const s = sep(labels.sidebar);
    const capture = vi.fn();
    Object.assign(s, { setPointerCapture: capture });
    pointer(s, 'pointerdown', 300, 2);
    pointer(s, 'pointermove', 340);
    pointer(s, 'pointerup', 340);
    expect(capture).not.toHaveBeenCalled();
    expect(onPaneResize).not.toHaveBeenCalled();
    expect(container.querySelector('.d-app-shell')).not.toHaveAttribute('data-resizing');
  });

  it('a double-click resets', () => {
    shellW = 1280; stubWidths();
    const onPaneResize = vi.fn();
    render(<ComposedShell shell={shellProps({ onPaneResize })} />);
    fireEvent.doubleClick(sep(labels.sidebar));
    expect(onPaneResize).toHaveBeenCalledWith('sidebar', null);
    fireEvent.doubleClick(sep(labels.aside));
    expect(onPaneResize).toHaveBeenLastCalledWith('aside', null);
  });

  it('a reset shows the default width again', () => {
    shellW = 1280; stubWidths();
    const { container } = render(<ComposedShell shell={shellProps({ paneWidths: {} })} />);
    expect(sep(labels.sidebar)).toHaveAttribute('aria-valuenow', '240');
    expect(container.querySelector('.d-app-shell')?.getAttribute('style') ?? '').not.toContain('--d-sidebar-w');
  });

  it('re-clamps when the shell shrinks, reporting only the width that had to change', () => {
    shellW = 1280;
    let notify: () => void = () => {};
    stubWidths();
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { notify = cb; }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const onPaneResize = vi.fn();
    const { container } = render(<ComposedShell shell={shellProps({ onPaneResize, paneWidths: { sidebar: 360, aside: 224 } })} />);
    expect(onPaneResize).not.toHaveBeenCalled();
    shellW = 1024;
    act(() => notify());
    expect(onPaneResize).toHaveBeenCalledTimes(1);
    expect(onPaneResize).toHaveBeenCalledWith('sidebar', 356);
    expect(container.querySelector('.d-app-shell')).toHaveStyle({ '--d-sidebar-w': '356px' });
  });
});
