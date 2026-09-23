import type { ReactNode } from 'react';
import './StatusBar.css';

export function StatusBar({ position, label, children }: { position: 'top' | 'bottom'; label: string; children: ReactNode }) {
  return <div className="d-statusbar" data-position={position} role="toolbar" aria-label={label}>{children}</div>;
}

export function StatusChunk({ label, children, onClick, tone }: { label?: string; children: ReactNode; onClick?: () => void; tone?: 'ok' | 'warn' | 'danger' }) {
  const inner = <>{label ? <span className="d-chunk__k">{label}</span> : null}<span className="d-chunk__v" data-tone={tone}>{children}</span></>;
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
