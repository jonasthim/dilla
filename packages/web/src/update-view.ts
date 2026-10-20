/** The visible position of a scroll region, measured from its end so new messages keep the reader's place. */
export interface ScrollPlace { fromBottom: number; anchor?: { seq: string; offset: number } }
export type FocusPlace = 'composer' | 'thread-composer' | 'log' | 'thread-log' | 'search' | null;
export interface ViewPlace { main: ScrollPlace | null; thread: ScrollPlace | null; focus: FocusPlace }

function scrollPlace(selector: string): ScrollPlace | null {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) return null;
  const top = element.getBoundingClientRect().top;
  const visible = [...element.querySelectorAll<HTMLElement>('.d-message-row[data-seq]')].find(row => row.getBoundingClientRect().bottom > top);
  const seq = visible?.dataset.seq;
  return { fromBottom: Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop),
    ...(seq !== undefined && /^\d{1,20}$/.test(seq) && visible !== undefined
      ? { anchor: { seq, offset: visible.getBoundingClientRect().top - top } } : {}) };
}

export function captureViewPlace(): ViewPlace {
  const active = document.activeElement;
  let focus: FocusPlace = null;
  if (active?.matches('.dw-thread .d-composer textarea')) focus = 'thread-composer';
  else if (active?.matches('.d-app-shell__main .d-composer textarea')) focus = 'composer';
  else if (active?.matches('.dw-thread .d-message-log')) focus = 'thread-log';
  else if (active?.matches('.d-app-shell__main .d-message-log')) focus = 'log';
  else if (active?.matches('.d-search-palette [role="combobox"]')) focus = 'search';
  return { main: scrollPlace('.d-app-shell__main .d-message-log'),
    thread: scrollPlace('.dw-thread .d-message-log'), focus };
}

export function validViewPlace(value: unknown): ViewPlace | null {
  if (typeof value !== 'object' || value === null) return null;
  const view = value as Partial<ViewPlace>;
  const validScroll = (p: unknown) => p === null || (typeof p === 'object' && p !== null
    && typeof (p as ScrollPlace).fromBottom === 'number' && Number.isFinite((p as ScrollPlace).fromBottom)
    && (p as ScrollPlace).fromBottom >= 0
    && ((p as ScrollPlace).anchor === undefined || (typeof (p as ScrollPlace).anchor === 'object'
      && typeof (p as ScrollPlace).anchor?.seq === 'string' && /^\d{1,20}$/.test((p as ScrollPlace).anchor!.seq)
      && Number.isFinite((p as ScrollPlace).anchor?.offset))));
  if (!validScroll(view.main) || !validScroll(view.thread)
    || ![null, 'composer', 'thread-composer', 'log', 'thread-log', 'search'].includes(view.focus as FocusPlace)) return null;
  return view as ViewPlace;
}

/** Returns false while a saved region is still loading; the caller can retry when it appears. */
export function restoreViewPlace(view: ViewPlace, allowMissingAnchor = false): boolean {
  for (const [place, selector] of [
    [view.main, '.d-app-shell__main .d-message-log'],
    [view.thread, '.dw-thread .d-message-log'],
  ] as const) {
    if (place === null) continue;
    const element = document.querySelector<HTMLElement>(selector);
    if (element === null || element.getAttribute('aria-busy') === 'true') return false;
    const anchor = place.anchor === undefined ? null : [...element.querySelectorAll<HTMLElement>('.d-message-row[data-seq]')]
      .find(row => row.dataset.seq === place.anchor?.seq) ?? null;
    if (place.anchor !== undefined && anchor === null && !allowMissingAnchor) return false;
    if (anchor !== null) element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - place.anchor!.offset;
    else element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - place.fromBottom);
    element.dispatchEvent(new Event('scroll'));
  }
  const focusSelector: Record<Exclude<FocusPlace, null>, string> = {
    composer: '.d-app-shell__main .d-composer textarea',
    'thread-composer': '.dw-thread .d-composer textarea',
    log: '.d-app-shell__main .d-message-log',
    'thread-log': '.dw-thread .d-message-log',
    search: '.d-search-palette [role="combobox"]',
  };
  if (view.focus !== null) document.querySelector<HTMLElement>(focusSelector[view.focus])?.focus();
  return true;
}
