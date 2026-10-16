/*
 * Vendored icon geometry from Lucide (https://lucide.dev), release tag 1.57.0:
 * https://github.com/lucide-icons/lucide/tree/1.57.0/icons
 * Generated from the upstream SVG files; only the child elements are kept. Every icon is drawn on a 24 × 24
 * viewBox with fill none, stroke currentColor, stroke width 2 and round caps and joins (the Icon component sets these).
 * Do not edit by hand: re-fetch at a pinned tag and regenerate with packages/ui/scripts/vendor-icons.mjs.
 *
 * SHA-256 of each upstream file at 1.57.0:
 *   icons/mic.svg  9b940cd735d1ffa270ba670c4e677d9a09400f3fa81d6b3f405b12a3b67a59a8
 *   icons/mic-off.svg  bcb5a033b4ecd182ec8d0d0945810ccc5147219b1a21c017b47fd4d5ae3a8320
 *   icons/headphones.svg  7719585dafa921805aefc21fc3262bbcc621507610a653b84e1632236650b35a
 *   icons/headphone-off.svg  356f8e3ac35f24d51c6d7b09c4e4c726410c5b6acb44863dc78feadef366d798
 *   icons/video.svg  d4fb6587f282c1152b953fe9494cd8ccafdf1e9f44957fbb7fe8dc7af0457597
 *   icons/video-off.svg  a2e53dcae00b37cbb7fb75373f28fa6b7c455b8b5e992cc620e3890dde80a178
 *   icons/monitor-up.svg  6d72719398041d19f6980d34162715ca6e22d745b31f5458680f987ff3d32a5a
 *   icons/monitor-x.svg  9f1a50af23976d76745641f8c14e1aad2d26a77e47296fd43a49c2a1447b9f63
 *   icons/phone-off.svg  d0f41abb10dc5e45d3b2d484ab7462b1e4f41b282b1d69f332425707c29cec15
 *
 * Lucide's licence (LICENSE at 1.57.0):
 *
 * ISC License
 *
 * Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * headphones is derived from the Feather project, under:
 *
 * The MIT License (MIT) (for the icons listed above)
 *
 * Copyright (c) 2013-present Cole Bemis
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export type IconElement =
  | readonly ['path', { readonly d: string }]
  | readonly ['rect', { readonly x?: string; readonly y?: string; readonly width: string; readonly height: string; readonly rx?: string; readonly ry?: string }]
  | readonly ['circle', { readonly cx: string; readonly cy: string; readonly r: string }]
  | readonly ['line', { readonly x1: string; readonly y1: string; readonly x2: string; readonly y2: string }];

export const ICONS = {
  'mic': [
    ['path', { d: 'M12 19v3' }],
    ['path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }],
    ['rect', { x: '9', y: '2', width: '6', height: '13', rx: '3' }],
  ],
  'mic-off': [
    ['path', { d: 'M12 19v3' }],
    ['path', { d: 'M15 9.34V5a3 3 0 0 0-5.68-1.33' }],
    ['path', { d: 'M16.95 16.95A7 7 0 0 1 5 12v-2' }],
    ['path', { d: 'M18.89 13.23A7 7 0 0 0 19 12v-2' }],
    ['path', { d: 'm2 2 20 20' }],
    ['path', { d: 'M9 9v3a3 3 0 0 0 5.12 2.12' }],
  ],
  'headphones': [
    ['path', { d: 'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3' }],
  ],
  'headphone-off': [
    ['path', { d: 'M21 14h-1.343' }],
    ['path', { d: 'M9.128 3.47A9 9 0 0 1 21 12v3.343' }],
    ['path', { d: 'm2 2 20 20' }],
    ['path', { d: 'M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3' }],
    ['path', { d: 'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364' }],
  ],
  'video': [
    ['path', { d: 'm16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5' }],
    ['rect', { x: '2', y: '6', width: '14', height: '12', rx: '2' }],
  ],
  'video-off': [
    ['path', { d: 'M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196' }],
    ['path', { d: 'M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2' }],
    ['path', { d: 'm2 2 20 20' }],
  ],
  'monitor-up': [
    ['path', { d: 'm9 10 3-3 3 3' }],
    ['path', { d: 'M12 13V7' }],
    ['rect', { width: '20', height: '14', x: '2', y: '3', rx: '2' }],
    ['path', { d: 'M12 17v4' }],
    ['path', { d: 'M8 21h8' }],
  ],
  'monitor-x': [
    ['path', { d: 'm14.5 12.5-5-5' }],
    ['path', { d: 'm9.5 12.5 5-5' }],
    ['rect', { width: '20', height: '14', x: '2', y: '3', rx: '2' }],
    ['path', { d: 'M12 17v4' }],
    ['path', { d: 'M8 21h8' }],
  ],
  'phone-off': [
    ['path', { d: 'M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272' }],
    ['path', { d: 'M22 2 2 22' }],
    ['path', { d: 'M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473' }],
  ],
} as const satisfies Record<string, readonly IconElement[]>;

export type IconName = keyof typeof ICONS;
