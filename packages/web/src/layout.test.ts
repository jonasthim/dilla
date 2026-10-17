import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHONE_QUERY, rememberedTab, rememberTab, usePhoneLayout, usePhoneSheet, useVisualViewportHeight } from './layout.ts';

const here = dirname(fileURLToPath(import.meta.url));

describe('the phone breakpoint', () => {
  it('is the same 47.99rem in the query, the shell container and the page media query', () => {
    expect(PHONE_QUERY).toBe('(max-width: 47.99rem)');
    const css = readFileSync(join(here, '..', '..', 'ui', 'src', 'styles', 'base.css'), 'utf8');
    expect(css).toContain('@container d-shell (max-width: 47.99rem)');
    expect(css).toContain('@media (max-width: 47.99rem)');
  });
});

describe('the phone shell follows the visual viewport (web3.7.2)', () => {
  const base = readFileSync(join(here, '..', '..', 'ui', 'src', 'styles', 'base.css'), 'utf8');
  const app = readFileSync(join(here, 'app.css'), 'utf8');
  const rule = (css: string, selector: string) => css.split('\n').find(l => l.trimStart().startsWith(selector)) ?? '';

  it('fixes the phone shell at --d-vvtop', () => {
    const shell = rule(base, '.d-app-shell[data-layout="phone"] {');
    expect(shell).toContain('position: fixed');
    expect(shell).toContain('top: var(--d-vvtop, 0px)');
  });
  it('moves the ring and the modeless Settings frame with it', () => {
    expect(rule(base, '.d-app-shell .d-app-shell__ring')).toContain('var(--d-vvtop, 0px)');
    expect(rule(base, '.d-settings-frame.d-settings-frame[data-modeless]')).toContain('var(--d-vvtop, 0px)');
  });
  it('moves the search palette and the other-tab overlay with it', () => {
    expect(rule(app, '.dw-search {')).toContain('var(--d-vvtop, 0px)');
    expect(rule(app, '.dw-other-tab--overlay')).toContain('var(--d-vvtop, 0px)');
  });
  it('stops the page itself scrolling on a phone, and only while the phone shell is mounted', () => {
    const phone = app.slice(app.indexOf('@media (max-width: 47.99rem)'));
    expect(phone).toMatch(/html:has\(\.d-app-shell\[data-layout="phone"\]\), body:has\(\.d-app-shell\[data-layout="phone"\]\) \{[^}]*overflow: hidden/);
    expect(app).not.toMatch(/(^|\n)\s*html, body \{[^}]*overflow/);
  });
});

describe('usePhoneLayout', () => {
  afterEach(() => { Reflect.deleteProperty(window, 'matchMedia'); });

  it('is false without matchMedia', () => {
    const { result } = renderHook(() => usePhoneLayout());
    expect(result.current).toBe(false);
  });

  it('follows a change event of the query', () => {
    let matches = false;
    const listeners = new Set<() => void>();
    window.matchMedia = vi.fn((query: string) => ({
      get matches() { return query === PHONE_QUERY && matches; },
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    })) as unknown as typeof window.matchMedia;
    const { result, unmount } = renderHook(() => usePhoneLayout());
    expect(result.current).toBe(false);
    act(() => { matches = true; listeners.forEach(l => l()); });
    expect(result.current).toBe(true);
    unmount();
    expect(listeners.size).toBe(0);
  });
});

describe('useVisualViewportHeight', () => {
  afterEach(() => { Reflect.deleteProperty(window, 'visualViewport'); document.documentElement.style.removeProperty('--d-vvh'); document.documentElement.style.removeProperty('--d-vvtop'); });

  it('sets --d-vvtop from the visual viewport offset, follows a scroll, and removes it on unmount', () => {
    const target = new EventTarget();
    const vv = Object.assign(target, { height: 500, offsetTop: 95 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    const { unmount } = renderHook(() => useVisualViewportHeight());
    expect(document.documentElement.style.getPropertyValue('--d-vvtop')).toBe('95px');
    vv.offsetTop = 0;
    act(() => { target.dispatchEvent(new Event('scroll')); });
    expect(document.documentElement.style.getPropertyValue('--d-vvtop')).toBe('0px');
    unmount();
    expect(document.documentElement.style.getPropertyValue('--d-vvtop')).toBe('');
  });

  it('sets --d-vvh from the visual viewport on resize and scroll, and removes it on unmount', () => {
    const target = new EventTarget();
    const vv = Object.assign(target, { height: 600 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    const { unmount } = renderHook(() => useVisualViewportHeight());
    expect(document.documentElement.style.getPropertyValue('--d-vvh')).toBe('600px');
    vv.height = 400;
    act(() => { target.dispatchEvent(new Event('resize')); });
    expect(document.documentElement.style.getPropertyValue('--d-vvh')).toBe('400px');
    vv.height = 350;
    act(() => { target.dispatchEvent(new Event('scroll')); });
    expect(document.documentElement.style.getPropertyValue('--d-vvh')).toBe('350px');
    unmount();
    expect(document.documentElement.style.getPropertyValue('--d-vvh')).toBe('');
  });

  it('does nothing when disabled', () => {
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: Object.assign(new EventTarget(), { height: 600 }) });
    renderHook(() => useVisualViewportHeight(false));
    expect(document.documentElement.style.getPropertyValue('--d-vvh')).toBe('');
  });
});

describe('tab memory', () => {
  it('round-trips through sessionStorage', () => {
    // eslint-disable-next-line no-restricted-properties -- the tab memory test reads the one key it writes
    window.sessionStorage.clear();
    expect(rememberedTab('dms')).toBeNull();
    rememberTab('dms', '/dm/abc');
    expect(rememberedTab('dms')).toBe('/dm/abc');
    // eslint-disable-next-line no-restricted-properties -- the tab memory test reads the one key it writes
    expect(window.sessionStorage.getItem('dilla.phoneTab.dms')).toBe('/dm/abc');
  });

  it('returns null without throwing when sessionStorage throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(rememberedTab('you')).toBeNull();
    expect(() => rememberTab('you', '/you')).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});

describe('usePhoneSheet', () => {
  afterEach(() => { window.history.replaceState(null, '', '/'); });

  it('pushes a sheet entry on open, closes on the system back, and pops its own entry on close()', () => {
    window.history.replaceState({ phoneBack: true }, '', '/c/x');
    const onClose = vi.fn();
    const { result, rerender } = renderHook(({ open }) => usePhoneSheet('members', open, onClose), { initialProps: { open: false } });
    const before = window.history.length;
    rerender({ open: true });
    expect(window.history.state).toEqual({ phoneBack: true, phoneSheet: 'members' });
    expect(window.history.length).toBe(before + 1);
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {
      window.history.replaceState({ phoneBack: true }, '', '/c/x');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    act(() => { result.current.close(); });
    expect(back).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });

  it('close() twice before the pop arrives calls history.back() once', () => {
    window.history.replaceState({ phoneBack: true }, '', '/c/x');
    const { result, rerender } = renderHook(({ open }) => usePhoneSheet('members', open, vi.fn()), { initialProps: { open: false } });
    rerender({ open: true });
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    act(() => { result.current.close(); result.current.close(); });
    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });

  it('strips a stale sheet entry (a reload, a forward) so closing never pops the view', () => {
    window.history.replaceState({ phoneBack: true, phoneSheet: 'members' }, '', '/c/x');
    const onClose = vi.fn();
    const { result, rerender } = renderHook(({ open }) => usePhoneSheet('members', open, onClose), { initialProps: { open: false } });
    expect(window.history.state).toEqual({ phoneBack: true });
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    rerender({ open: true });
    expect(window.history.state).toEqual({ phoneBack: true, phoneSheet: 'members' });
    act(() => { result.current.close(); });
    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
    // A forward onto a sheet entry while closed is stripped too, and its close is not a back.
    rerender({ open: false });
    window.history.replaceState({ phoneSheet: 'members' }, '', '/c/x');
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(window.history.state).toBeNull();
    const again = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    act(() => { result.current.close(); });
    expect(again).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    again.mockRestore();
  });

  it('close() does not pop an entry this instance did not push', () => {
    window.history.replaceState({ phoneSheet: 'members' }, '', '/c/x');
    const onClose = vi.fn();
    // Closed, so the stale key is stripped; an open sheet whose own entry was lost (a replace) is the other case.
    const { result, rerender } = renderHook(({ open }) => usePhoneSheet('members', open, onClose), { initialProps: { open: true } });
    rerender({ open: false });
    window.history.replaceState({ phoneSheet: 'members' }, '', '/c/x');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    act(() => { result.current.close(); });
    expect(back).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });

  it('calls onClose at once when the sheet has no entry', () => {
    window.history.replaceState(null, '', '/c/x');
    const onClose = vi.fn();
    const { result } = renderHook(() => usePhoneSheet('thread', false, onClose));
    act(() => { result.current.close(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
