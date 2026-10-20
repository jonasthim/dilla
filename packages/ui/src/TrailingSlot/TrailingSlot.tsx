import type { ReactNode } from 'react';
import './TrailingSlot.css';

/** The trailing column of a list row (R13): `var(--slot-w)` wide, never shrinking, its content centred; empty it still holds its width. */
export function TrailingSlot({ children }: { children?: ReactNode }) {
  return <span className="d-slot">{children}</span>;
}
