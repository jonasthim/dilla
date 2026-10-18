/** The visible position of a scroll region, measured from its end so new messages keep the reader's place. */
export interface ScrollPlace { fromBottom: number }
export type FocusPlace = 'composer' | 'thread-composer' | 'log' | 'thread-log' | 'search' | null;
export interface ViewPlace { main: ScrollPlace | null; thread: ScrollPlace | null; focus: FocusPlace }

function scrollPlace(selector: string): ScrollPlace | null {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) return null;
  return { fromBottom: Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop) };
}

export function captureViewPlace(): ViewPlace {
  const active = document.activeElement;
  let focus: FocusPlace = null;
  if (active?.matches('.dw-thread .d-composer textarea')) focus = 'thread-composer';
  else if (active?.matches('.d-app-shell__main .d-composer textarea')) focus = 'composer';
  else if (active?.matches('.dw-thread .d-message-log')) focus = 'thread-log';
  else if (active?.matches('.d-app-shell__main .d-message-log')) focus = 'log';
  else if (active?.matches('.dw-search [role="combobox"]')) focus = 'search';
  return { main: scrollPlace('.d-app-shell__main .d-message-log'),
    thread: scrollPlace('.dw-thread .d-message-log'), focus };
}

export function validViewPlace(value: unknown): ViewPlace | null {
  if (typeof value !== 'object' || value === null) return null;
  const view = value as Partial<ViewPlace>;
  const validScroll = (p: unknown) => p === null || (typeof p === 'object' && p !== null
    && typeof (p as ScrollPlace).fromBottom === 'number' && Number.isFinite((p as ScrollPlace).fromBottom)
    && (p as ScrollPlace).fromBottom >= 0);
  if (!validScroll(view.main) || !validScroll(view.thread)
    || ![null, 'composer', 'thread-composer', 'log', 'thread-log', 'search'].includes(view.focus as FocusPlace)) return null;
  return view as ViewPlace;
}

/** Returns false while a saved region is still loading; the caller can retry when it appears. */
export function restoreViewPlace(view: ViewPlace): boolean {
  for (const [place, selector] of [
    [view.main, '.d-app-shell__main .d-message-log'],
    [view.thread, '.dw-thread .d-message-log'],
  ] as const) {
    if (place === null) continue;
    const element = document.querySelector<HTMLElement>(selector);
    if (element === null || element.getAttribute('aria-busy') === 'true') return false;
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - place.fromBottom);
    element.dispatchEvent(new Event('scroll'));
  }
  const focusSelector: Record<Exclude<FocusPlace, null>, string> = {
    composer: '.d-app-shell__main .d-composer textarea',
    'thread-composer': '.dw-thread .d-composer textarea',
    log: '.d-app-shell__main .d-message-log',
    'thread-log': '.dw-thread .d-message-log',
    search: '.dw-search [role="combobox"]',
  };
  if (view.focus !== null) document.querySelector<HTMLElement>(focusSelector[view.focus])?.focus();
  return true;
}
