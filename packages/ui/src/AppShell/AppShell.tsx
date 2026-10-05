import { useId, useRef, type MouseEvent, type ReactNode } from 'react';
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
}

/**
 * The Mesh shell: rail | sidebar | main (header, content, composer), a banner
 * above and the status bar below. DOM order is the focus order of the web-1
 * keyboard map: skip link → banner → rail → sidebar → main → status bar.
 */
export function AppShell({ skipLabel, rail, sidebar, header, children, composer, statusBar, banner }: AppShellProps) {
  const mainId = useId();
  const mainRef = useRef<HTMLElement>(null);
  const hasBanner = banner !== undefined && banner !== null && banner !== false;
  // No hash change and no history entry: focus moves to <main> and the URL stays.
  const onSkip = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    mainRef.current?.focus();
  };
  return (
    <div className="d-app-shell">
      <a className="d-app-shell__skip" href={`#${mainId}`} onClick={onSkip}>{skipLabel}</a>
      <div className="d-app-shell__grid">
        {hasBanner ? <div className="d-app-shell__banner">{banner}</div> : null}
        <div className="d-app-shell__rail">{rail}</div>
        <div className="d-app-shell__sidebar">{sidebar}</div>
        <main id={mainId} ref={mainRef} tabIndex={-1} className="d-app-shell__main">
          {header}
          <div className="d-app-shell__content">{children}</div>
          {composer}
        </main>
        <div className="d-app-shell__status">{statusBar}</div>
      </div>
    </div>
  );
}
