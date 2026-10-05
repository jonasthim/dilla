import type { ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import './Banner.css';

export interface BannerProps {
  tone: 'info' | 'warn' | 'danger';
  children: ReactNode;
  action?: { label: string; onAction(): void };
}

/** Tone is never colour alone: a glyph, hidden from assistive tech, carries it too. */
const GLYPH = { info: '›', warn: '▲', danger: '✕' } as const;

/** A one-line notice: a status for info, an alert for warn and danger. */
export function Banner({ tone, children, action }: BannerProps) {
  return (
    <div className="d-banner" data-tone={tone} role={tone === 'info' ? 'status' : 'alert'}>
      <span className="d-banner__glyph" aria-hidden="true">{GLYPH[tone]}</span>
      <div className="d-banner__text">{children}</div>
      {action ? <Button className="d-banner__action" onClick={action.onAction}>{action.label}</Button> : null}
    </div>
  );
}
