import type { ThemeName } from '@dilla/design-tokens';

export const THEME_QUERIES = { light: '(prefers-color-scheme: light)', contrast: '(prefers-contrast: more)' } as const;

export function preferredTheme(matchMedia: (query: string) => { matches: boolean }): ThemeName {
  if (matchMedia(THEME_QUERIES.contrast).matches) return 'high-contrast';
  if (matchMedia(THEME_QUERIES.light).matches) return 'light';
  return 'mesh';
}

export function applyTheme(root: HTMLElement, theme: ThemeName): void {
  root.dataset.theme = theme;
  root.dataset.density = 'regular';
}

export function followSystemTheme(win: Pick<Window, 'matchMedia' | 'document'>): () => void {
  const light = win.matchMedia(THEME_QUERIES.light);
  const contrast = win.matchMedia(THEME_QUERIES.contrast);
  const update = () => applyTheme(win.document.documentElement, preferredTheme(win.matchMedia));
  update();
  light.addEventListener('change', update);
  contrast.addEventListener('change', update);
  return () => {
    light.removeEventListener('change', update);
    contrast.removeEventListener('change', update);
  };
}
