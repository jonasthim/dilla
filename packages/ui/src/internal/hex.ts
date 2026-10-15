/** A colour held as 0xRRGGBB, as the `#rrggbb` text of the `--d-swatch` custom property. */
export const hex = (v: number): string => `#${(v & 0xffffff).toString(16).padStart(6, '0')}`;
