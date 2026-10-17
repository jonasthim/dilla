import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/** The phone breakpoint (flow 12). The same 47.99rem as the shell's container query and the page's media query in base.css. */
export const PHONE_QUERY = '(max-width: 47.99rem)';

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
const snapshot = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;

/** The layout right now, read from the window (not from a render): for handlers that must act on the live viewport. */
export const phoneNow = snapshot;

/** True on a phone-width window; false where there is no matchMedia (the server, the test DOM). */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/**
 * Keeps `--d-vvh` on <html> at the visual viewport's height while enabled, so the phone shell shrinks above a soft
 * keyboard and the composer stays in view. The property is removed when the hook unmounts or turns off.
 */
export function useVisualViewportHeight(enabled = true): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || vv === null || vv === undefined) return;
    const root = document.documentElement;
    const set = () => root.style.setProperty('--d-vvh', `${vv.height}px`);
    set();
    vv.addEventListener('resize', set);
    vv.addEventListener('scroll', set);
    return () => {
      vv.removeEventListener('resize', set);
      vv.removeEventListener('scroll', set);
      root.style.removeProperty('--d-vvh');
    };
  }, [enabled]);
}

export type PhoneTab = 'servers' | 'dms' | 'activity' | 'you';

const TAB_KEY = 'dilla.phoneTab.';

/** Remembers where a tab was last left, for this browser tab only. A blocked sessionStorage remembers nothing. */
export function rememberTab(tab: PhoneTab, path: string): void {
  // eslint-disable-next-line no-restricted-globals -- a remembered path is not a key, a token or state worth protecting (flow 12)
  try { sessionStorage.setItem(TAB_KEY + tab, path); } catch { /* blocked storage: no memory, the tab opens at its root */ }
}

/** The path a tab was last left at, or null. */
export function rememberedTab(tab: PhoneTab): string | null {
  // eslint-disable-next-line no-restricted-globals -- a remembered path is not a key, a token or state worth protecting (flow 12)
  try { return sessionStorage.getItem(TAB_KEY + tab); } catch { return null; }
}

/** The history-state key of an open sheet (R13). */
const SHEET = 'phoneSheet';
const sheetOf = (state: unknown): unknown =>
  typeof state === 'object' && state !== null ? (state as Record<string, unknown>)[SHEET] : undefined;

/**
 * A sheet on a phone is a history entry, so the system back closes the sheet and not the view under it. While `open`,
 * one entry carrying `phoneSheet: <name>` is pushed on top of the current one (its state kept). A popstate that leaves
 * that entry calls `onClose`. `close()` is what the sheet's own controls call: it pops the entry (which ends in
 * `onClose` through the popstate, and returns true), or calls `onClose` at once when the sheet has no entry (returns false).
 */
export function usePhoneSheet(name: 'members' | 'thread', open: boolean, onClose: () => void): { close: () => boolean } {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const pushed = useRef(false);
  useEffect(() => {
    // An entry that names this sheet while it is closed is stale (a reload, a forward, a restored tab): it is stripped,
    // so a later close never pops the view itself.
    const strip = () => {
      if (sheetOf(window.history.state) !== name) return;
      const rest = { ...(window.history.state as Record<string, unknown>) };
      delete rest[SHEET];
      window.history.replaceState(Object.keys(rest).length === 0 ? null : rest, '', location.href);
    };
    if (!open) {
      pushed.current = false;
      strip();
      window.addEventListener('popstate', strip);
      return () => window.removeEventListener('popstate', strip);
    }
    strip();
    const current = typeof window.history.state === 'object' && window.history.state !== null ? window.history.state as Record<string, unknown> : {};
    window.history.pushState({ ...current, [SHEET]: name }, '', location.href);
    pushed.current = true;
    const onPop = () => {
      if (sheetOf(window.history.state) === name) return;
      pushed.current = false;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open, name]);
  const close = useCallback(() => {
    if (pushed.current && sheetOf(window.history.state) === name) { window.history.back(); return true; }
    onCloseRef.current();
    return false;
  }, [name]);
  return { close };
}
