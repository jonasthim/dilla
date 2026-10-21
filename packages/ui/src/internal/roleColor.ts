import { useSyncExternalStore } from 'react';
import { contrastRatio, themes, type ThemeName } from '@dilla/design-tokens';
import { hex } from './hex.ts';

const NAMES = Object.keys(themes) as ThemeName[];

function currentTheme(): ThemeName {
  const t = typeof document === 'undefined' ? undefined : document.documentElement.dataset.theme;
  return NAMES.find(n => n === t) ?? 'mesh';
}
function subscribe(notify: () => void): () => void {
  if (typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
/** The active theme (`data-theme` on the document element; mesh when unset), re-read when it changes. */
export function useThemeName(): ThemeName {
  return useSyncExternalStore(subscribe, currentTheme, () => 'mesh');
}

/**
 * The colour a member's name is drawn in: the top coloured role's `#rrggbb` when it keeps 4.5:1 against both surfaces a
 * row sits on in `theme` (the row and its hover), else null, and the name keeps its text token (WCAG 1.4.3).
 */
export function roleNameColor(color: number | null | undefined, theme: ThemeName): string | null {
  if (!color) return null;
  const c = hex(color);
  const t = themes[theme];
  return contrastRatio(c, t.surface) >= 4.5 && contrastRatio(c, t.surface2) >= 4.5 ? c : null;
}
