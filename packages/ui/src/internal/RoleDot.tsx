import type { CSSProperties } from 'react';
import { hex } from './hex.ts';
import './RoleDot.css';

/** The 8 px role colour dot: decorative (`aria-hidden`), filled from data through `--d-swatch`. `inline` is the mention pill's. */
export function RoleDot({ color, inline = false }: { color: number; inline?: boolean }) {
  return <span className={inline ? 'd-role-dot d-role-dot--inline' : 'd-role-dot'} aria-hidden="true" style={{ '--d-swatch': hex(color) } as CSSProperties} />;
}
