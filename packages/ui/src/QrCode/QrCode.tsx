import { useMemo } from 'react';
import { qrcodegen } from './qrcodegen.ts';
import './QrCode.css';

export interface QrCodeProps {
  value: string;
  label: string;
  size?: number;
}

const QUIET_ZONE = 4;

/** One SVG path (a move and a unit square per dark module) for the symbol, offset by the quiet zone. */
function darkModulesPath(value: string): { path: string; side: number } {
  const { QrCode: Code, QrSegment } = qrcodegen;
  // ECC M, never boosted: the symbol stays as small as the payload allows.
  const code = Code.encodeSegments(QrSegment.makeSegments(value), Code.Ecc.MEDIUM, Code.MIN_VERSION, Code.MAX_VERSION, -1, false);
  const parts: string[] = [];
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.getModule(x, y)) parts.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`);
    }
  }
  return { path: parts.join(''), side: code.size + 2 * QUIET_ZONE };
}

/**
 * A QR code drawn as one SVG path. It is always dark modules on a light field,
 * also in dark mode, because scanners expect that: the SVG pins the light
 * theme's tokens for itself (data-theme="light"). The text alternative is the
 * caller's label; the setup key beside it is the readable equivalent.
 */
export function QrCode({ value, label, size = 192 }: QrCodeProps) {
  const { path, side } = useMemo(() => darkModulesPath(value), [value]);
  return (
    <svg className="d-qr" data-theme="light" role="img" aria-label={label} width={size} height={size}
      viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
      <rect className="d-qr__light" width={side} height={side} />
      <path className="d-qr__dark" d={path} />
    </svg>
  );
}
