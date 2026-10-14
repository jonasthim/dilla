import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { Button } from '../Button/Button.tsx';
import './AppShell.css';

export interface AppShellProps {
  skipLabel: string;
  rail: ReactNode;
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
  composer: ReactNode;
  statusBar: ReactNode;
  banner?: ReactNode;
  /**
   * The incoming-ring banner (web-3, flow 06): the first thing in main, so its answer and decline are main's first
   * controls. On a phone it is fixed to the top of the shell and the grid moves down by its measured height, so it never
   * covers the stage controls.
   */
  ring?: ReactNode;
  /**
   * web3.4: a pane after main (the member list). Rendered only while `asideOpen`. From 64rem of shell width it is a
   * fourth grid column. Below that it is a modal overlay drawer from the right: the rest of the shell is inert behind a
   * backdrop (a click on it closes), focus moves in on open, Escape anywhere calls `onAsideClose` (unless something in
   * the pane handled it), and focus goes back to the opener.
   */
  aside?: ReactNode;
  asideLabel?: string;
  asideOpen?: boolean;
  onAsideClose?(): void;
  /** The drawer's close button (final fix I2): shown at its top only as the overlay, where it calls `onAsideClose`. */
  asideCloseLabel?: string;
  /** The control that opens the aside: focus goes back to it when the drawer closes and the opener was `body`. */
  asideReturnRef?: RefObject<HTMLElement | null>;
}

/** The shell width from which the aside is a column (base.css holds the same 64rem in its container query). */
const COLUMN_REM = 64;
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The Mesh shell: rail | sidebar | main (header, content, composer), a banner
 * above and the status bar below. DOM order is the focus order of the web-1
 * keyboard map: skip link → banner → rail → sidebar → main → status bar.
 */
export function AppShell({
  skipLabel, rail, sidebar, header, children, composer, statusBar, banner, ring, aside, asideLabel, asideOpen, onAsideClose, asideCloseLabel, asideReturnRef,
}: AppShellProps) {
  const mainId = useId();
  const mainRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const hasRing = ring !== undefined && ring !== null && ring !== false;
  const showAside = asideOpen === true && aside !== undefined && aside !== null && aside !== false;

  // Narrower than 64rem (root font size) of shell width: the aside is the overlay drawer. jsdom has no layout: width 0 reads as narrow.
  const [narrow, setNarrow] = useState(true);
  const narrowRef = useRef(true);
  const measure = () => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const next = (rootRef.current?.offsetWidth ?? 0) < COLUMN_REM * rem;
    narrowRef.current = next;
    setNarrow(next);
    return next;
  };
  // Live: the shell's own size decides, so a resize or a rotation while open switches column and drawer at once.
  useLayoutEffect(() => {
    const root = rootRef.current;
    measure();
    if (root === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { measure(); });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const overlay = showAside && narrow;

  // The drawer takes focus on open and hands it back to its opener when it closes; a column does neither.
  // It also runs when an open aside turns into the overlay (a resize), so focus left in now-inert content comes along.
  const showRef = useRef(showAside);
  showRef.current = showAside;
  useEffect(() => {
    if (!overlay || !measure()) return;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const el = asideRef.current;
    (el?.querySelector<HTMLElement>(FOCUSABLE) ?? el)?.focus();
    return () => {
      // Only a close hands focus back; turning into a column (still shown) leaves it where it is.
      if (showRef.current) return;
      if (document.activeElement !== document.body && !el?.contains(document.activeElement)) return;
      const back = opener?.isConnected ? opener : asideReturnRef?.current;
      back?.focus();
    };
  }, [overlay]);

  // Escape anywhere closes the drawer, unless a control inside (an open menu) already took it.
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onAsideClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [overlay, onAsideClose]);

  // --d-ring-h is the ring's height, which the narrow layout moves the grid down by; 0px without a ring.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const el = ringRef.current;
    if (root === null) return;
    const measureRing = () => root.style.setProperty('--d-ring-h', `${el?.offsetHeight ?? 0}px`);
    measureRing();
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measureRing);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasRing]);
  const hasBanner = banner !== undefined && banner !== null && banner !== false;
  // No hash change and no history entry: focus moves to <main> and the URL stays.
  const onSkip = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    mainRef.current?.focus();
  };
  return (
    <div ref={rootRef} className="d-app-shell">
      <a className="d-app-shell__skip" href={`#${mainId}`} onClick={onSkip}>{skipLabel}</a>
      <div className={showAside ? 'd-app-shell__grid d-app-shell__grid--aside' : 'd-app-shell__grid'}>
        {hasBanner ? <div className="d-app-shell__banner" inert={overlay || undefined}>{banner}</div> : null}
        <div className="d-app-shell__rail" inert={overlay || undefined}>{rail}</div>
        <div className="d-app-shell__sidebar" inert={overlay || undefined}>{sidebar}</div>
        <main id={mainId} ref={mainRef} tabIndex={-1} className="d-app-shell__main" inert={overlay || undefined}>
          {hasRing ? <div ref={ringRef} className="d-app-shell__ring">{ring}</div> : null}
          {header}
          <div className="d-app-shell__content">{children}</div>
          {composer}
        </main>
        {overlay ? <div className="d-app-shell__backdrop" aria-hidden="true" onClick={() => onAsideClose?.()} /> : null}
        {showAside ? <aside ref={asideRef} aria-label={asideLabel} tabIndex={-1} className="d-app-shell__aside">
          {overlay && asideCloseLabel !== undefined ? (
            <div className="d-app-shell__aside-head">
              <Button variant="ghost" size="sm" onClick={() => onAsideClose?.()}>{asideCloseLabel}</Button>
            </div>
          ) : null}
          {aside}
        </aside> : null}
        <div className="d-app-shell__status" inert={overlay || undefined}>{statusBar}</div>
      </div>
    </div>
  );
}
