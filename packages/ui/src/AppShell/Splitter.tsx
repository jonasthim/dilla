import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import './Splitter.css';

export type Pane = 'sidebar' | 'aside';

export interface SplitterProps {
  pane: Pane;
  label: string;
  controls: string;
  /** The current width, and its limits, in CSS px. */
  now: number;
  min: number;
  max: number;
  /** One rem in CSS px: a key moves by 1rem, 4rem with Shift. */
  rem: number;
  /** A pointer move: the requested width. The shell clamps it and shows it live. */
  onDrag(px: number): void;
  /** The drag ended: the shell commits what it showed (once). */
  onDragEnd(): void;
  /** A key or a reset: the requested width, or null for the default. */
  onSet(px: number | null): void;
  /** Out of the tab order and the pointer's reach (the aside overlay is open). */
  inert?: boolean;
}

/**
 * Internal (not exported from the package): the separator between two panes of the desktop shell.
 * A 24px hit area centred on the 1px line the neighbouring pane already draws.
 */
export function Splitter({ pane, label, controls, now, min, max, rem, onDrag, onDragEnd, onSet, inert }: SplitterProps) {
  const start = useRef<{ x: number; width: number } | null>(null);
  // The aside's splitter sits on its left edge, so moving left widens it.
  const sign = pane === 'sidebar' ? 1 : -1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    start.current = { x: e.clientX, width: now };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (s === null) return;
    onDrag(s.width + sign * (e.clientX - s.x));
  };
  const end = () => {
    if (start.current === null) return;
    start.current = null;
    onDragEnd();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const step = (e.shiftKey ? 4 : 1) * rem;
    let next: number | null | undefined;
    if (e.key === 'ArrowRight') next = now + sign * step;
    else if (e.key === 'ArrowLeft') next = now - sign * step;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else if (e.key === 'Enter') next = null;
    if (next === undefined) return;
    e.preventDefault();
    onSet(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={Math.round(now)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      inert={inert || undefined}
      className={`d-splitter d-splitter--${pane}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onLostPointerCapture={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onSet(null)}
    />
  );
}
