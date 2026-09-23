import type { ReactNode } from 'react';
import './StatusBar.css';

export function StatusBar({ position, label, children }: { position: 'top' | 'bottom'; label: string; children: ReactNode }) {
  // A region, not a toolbar: the bar is a strip of status facts with the
  // occasional button, not a grouped control set with roving tab order and
  // arrow-key navigation, which is what role="toolbar" promises.
  return <div className="d-statusbar" data-position={position} role="region" aria-label={label}>{children}</div>;
}

/** Tone is never colour alone: a glyph carries it for sighted users… */
const TONE_GLYPH = { ok: '●', warn: '▲', danger: '✕' } as const;
/** …and a visually hidden word carries it for assistive tech. */
const TONE_TEXT = { ok: 'ok', warn: 'warning', danger: 'error' } as const;

export function StatusChunk({ label, children, onClick, tone }: { label?: string; children: ReactNode; onClick?: () => void; tone?: 'ok' | 'warn' | 'danger' }) {
  const inner = (
    <>
      {label ? <span className="d-chunk__k">{label}</span> : null}
      <span className="d-chunk__v" data-tone={tone}>
        {tone ? <><span className="d-chunk__tone" aria-hidden="true">{TONE_GLYPH[tone]}</span><span className="d-sr-only">{TONE_TEXT[tone]}</span></> : null}
        {children}
      </span>
    </>
  );
  return onClick
    ? <button type="button" className="d-chunk d-chunk--clickable" onClick={onClick}>{inner}</button>
    : <span className="d-chunk">{inner}</span>;
}

/** Twelve-bar audio meter, decorative: the accessible state lives on the mute button. */
export function Meter({ levels }: { levels: number[] }) {
  const bars = Array.from({ length: 12 }, (_, i) => Math.max(0, Math.min(6, levels[i] ?? 0)));
  return <span className="d-meter" aria-hidden="true">{bars.map((h, i) => <i key={i} style={{ height: `${2 + h * 1.5}px` }} />)}</span>;
}

export function BrandMark() {
  return (
    <span className="d-brand">
      <span className="d-brand__tile" aria-hidden="true">D</span>
      <span className="d-brand__name">DILLA</span>
      <span className="d-brand__caret" aria-hidden="true" />
    </span>
  );
}
