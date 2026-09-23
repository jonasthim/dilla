export type Rgba = [number, number, number, number];

export function parseColor(input: string): Rgba {
  const s = input.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) { const n = parseInt(hex[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(s);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`unsupported colour: ${input}`);
}

const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');

/** Alpha-composite `fg` over an opaque `bg`; returns #rrggbb. */
export function composite(fg: string, bg: string): string {
  const [r, g, b, a] = parseColor(fg);
  const [br, bgc, bb] = parseColor(bg);
  return `#${toHex(r * a + br * (1 - a))}${toHex(g * a + bgc * (1 - a))}${toHex(b * a + bb * (1 - a))}`;
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function relativeLuminance(color: string): number {
  const [r, g, b] = parseColor(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio; `fg` may have alpha and is flattened onto `bg` first. */
export function contrastRatio(fg: string, bg: string): number {
  const f = relativeLuminance(composite(fg, bg));
  const b = relativeLuminance(composite(bg, '#000000'));
  const [hi, lo] = f > b ? [f, b] : [b, f];
  return (hi + 0.05) / (lo + 0.05);
}
