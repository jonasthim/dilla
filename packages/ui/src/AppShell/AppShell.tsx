import { useId, useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react';
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
}

/**
 * The Mesh shell: rail | sidebar | main (header, content, composer), a banner
 * above and the status bar below. DOM order is the focus order of the web-1
 * keyboard map: skip link → banner → rail → sidebar → main → status bar.
 */
export function AppShell({ skipLabel, rail, sidebar, header, children, composer, statusBar, banner, ring }: AppShellProps) {
  const mainId = useId();
  const mainRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const hasRing = ring !== undefined && ring !== null && ring !== false;
  // --d-ring-h is the ring's height, which the narrow layout moves the grid down by; 0px without a ring.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const el = ringRef.current;
    if (root === null) return;
    const measure = () => root.style.setProperty('--d-ring-h', `${el?.offsetHeight ?? 0}px`);
    measure();
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
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
      <div className="d-app-shell__grid">
        {hasBanner ? <div className="d-app-shell__banner">{banner}</div> : null}
        <div className="d-app-shell__rail">{rail}</div>
        <div className="d-app-shell__sidebar">{sidebar}</div>
        <main id={mainId} ref={mainRef} tabIndex={-1} className="d-app-shell__main">
          {hasRing ? <div ref={ringRef} className="d-app-shell__ring">{ring}</div> : null}
          {header}
          <div className="d-app-shell__content">{children}</div>
          {composer}
        </main>
        <div className="d-app-shell__status">{statusBar}</div>
      </div>
    </div>
  );
}
