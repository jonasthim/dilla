import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { CallTile, type CallTileProps } from '../CallTile/CallTile.tsx';
import '../Button/Button.css';
import './CallStage.css';
import { Icon } from '../Icon/Icon.tsx';

export interface CallStageNotice {
  /**
   * `paused` is the RV-3 pause banner and `blocked` a block notice (`voice.blocked`, `voice.blockedJoin`,
   * `voice.blockedChanged`): while either shows, no tile renders a media element. `info` is a transient notice
   * (`voice.full`, `voice.micDenied` and the like) that leaves the tiles as they are.
   */
  kind: 'paused' | 'blocked' | 'info';
  text: string;
  action: { label: string; onAction(): void } | null;
  /** Move focus to the notice (its action, or the notice itself) once, when this text first shows. */
  focusOnce: boolean;
}

export interface CallStageProps {
  /** The stage's heading, e.g. 'voice harbour' or the DM's name. */
  title: string;
  /** The tiles, in one stable order, keyed by `id` (R27). `focused` and `onFocusTile` are injected here, never passed. */
  tiles: readonly Omit<CallTileProps, 'focused' | 'onFocusTile'>[];
  /** The focused tile's id, or null for the grid. An id that names no current tile renders the grid. Additive: without
   *  `onFocus` the tiles have no focus button (pre-flight C-2). */
  focusedId?: string | null;
  /** Focus a tile (`id`) or clear the focus (`null`): a click on a tile's focus button, Escape, or a pause notice. */
  onFocus?(id: string | null): void;
  /** The call code, 30 digits (spaces are ignored), or null when there is none yet. */
  code: string | null;
  /** A notice on the stage: the RV-3 pause banner (with its `voice.pausedAction`), a block notice or a transient one. */
  notice: CallStageNotice | null;
  /** The call controls (a `CallControls`). */
  controls: ReactNode;
  /** The DM call strip while this device's call rings others ('ringing {names}', '{name} declined.', 'No answer.'). */
  outgoing: { text: string } | null;
  labels: { code: string; codeHelp: string; empty: string; tiles: string };
}

const NOTICE_GLYPH = { paused: <Icon name="pause" size={14} />, blocked: '!', info: '›' } as const;

/** Six groups of five digits; anything that is not 30 digits is shown as given. */
function groupCode(code: string): string {
  const digits = code.replace(/\s+/g, '');
  return /^\d{30}$/.test(digits) ? (digits.match(/\d{5}/g) ?? []).join(' ') : code;
}

const TILE_GAP_PX = 12; // 0.75rem at the root size the stage is laid out for; the CSS gap is the same 0.75rem.

/**
 * The column count c in 1..n that makes the 16:9 tiles of an n-tile grid widest in a `w` x `h` area with `gap` between
 * them: the tile width is `min((w - gap(c-1))/c, ((h - gap(r-1))/r) * 16/9)` with `r = ceil(n/c)`. A tie goes to
 * the fewer columns.
 */
export function stageColumns(n: number, w: number, h: number, gap: number): number {
  let best = 1;
  let bestWidth = -Infinity;
  for (let c = 1; c <= n; c++) {
    const width = tileWidth(c, n, w, h, gap);
    if (width > bestWidth + 1e-9) { best = c; bestWidth = width; }
  }
  return best;
}

/** The width of a 16:9 tile when `n` tiles sit in `c` columns of a `w` x `h` area. */
function tileWidth(c: number, n: number, w: number, h: number, gap: number): number {
  const r = Math.ceil(n / c);
  return Math.min((w - gap * (c - 1)) / c, ((h - gap * (r - 1)) / r) * (16 / 9));
}

/**
 * The call stage: the heading, the outgoing ring, the call code behind a closed disclosure (Escape closes it and
 * returns focus to it), a notice region, the tiles as a list named `voice.tiles` (or `voice.empty`), and the
 * controls. The notice region is a `role="status"` that is always present, so its text is announced; a notice
 * with `focusOnce` takes focus once per text. While a pause or block notice shows, no tile renders media, no screen
 * tile renders and the focus is cleared; while any notice shows, the stage does not also say that nobody is in voice.
 *
 * The tiles are one keyed list that never changes order or parent: focus only sets `data-focused-stage` on the stage
 * and `data-focused` on the tile, and CSS grid does the rest (R27). In the grid a ResizeObserver writes
 * `--d-stage-cols` and `--d-tile-w` from `stageColumns`. Escape unfocuses a tile, unless full screen is on.
 */
export function CallStage({ title, tiles: allTiles, focusedId = null, onFocus, code, notice, controls, outgoing, labels }: CallStageProps) {
  const titleId = useId();
  const tilesRef = useRef<HTMLUListElement>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const focusedFor = useRef<string | null>(null);
  const noticeText = notice?.text ?? null;
  const focusOnce = notice?.focusOnce ?? false;

  useEffect(() => {
    if (noticeText === null) { focusedFor.current = null; return; }
    if (!focusOnce || focusedFor.current === noticeText) return;
    focusedFor.current = noticeText;
    (actionRef.current ?? noticeRef.current)?.focus();
  }, [noticeText, focusOnce]);

  const onCodeKey = (e: KeyboardEvent<HTMLDetailsElement>) => {
    const details = detailsRef.current;
    if (e.key !== 'Escape' || !details?.open) return;
    e.preventDefault();
    e.stopPropagation();
    details.open = false;
    details.querySelector('summary')?.focus();
  };

  const hideMedia = notice !== null && notice.kind !== 'info';
  const tiles = hideMedia ? allTiles.filter(t => t.source !== 'screen') : allTiles;
  const idOf = (t: (typeof allTiles)[number]) => t.id ?? t.view.deviceId;
  const stageMode = onFocus !== undefined;
  const focusedHere = !hideMedia && focusedId !== null && tiles.some(t => idOf(t) === focusedId);
  // A lone focused tile keeps the grid: a filmstrip row of nothing would only shrink it.
  const focusedLayout = focusedHere && tiles.length > 1;
  const tileCount = tiles.length;

  useEffect(() => {
    if (hideMedia && focusedId !== null) onFocus?.(null);
  }, [hideMedia, focusedId, onFocus]);

  useEffect(() => {
    const el = tilesRef.current;
    if (!stageMode || !el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const { clientWidth: w, clientHeight: h } = el;
      if (w <= 0 || h <= 0 || tileCount === 0) return;
      const gap = TILE_GAP_PX * (parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1);
      const cols = stageColumns(tileCount, w, h, gap);
      const width = tileWidth(cols, tileCount, w, h, gap);
      el.style.setProperty('--d-stage-cols', String(cols));
      el.style.setProperty('--d-tile-w', `${String(Math.max(0, Math.floor(width)))}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, [stageMode, tileCount]);

  const onStageKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || !focusedHere || document.fullscreenElement) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus?.(null);
  };

  return (
    <section className="d-call-stage" aria-labelledby={titleId} data-media-hidden={hideMedia ? 'true' : undefined}
      data-focused-stage={focusedLayout ? 'true' : undefined} onKeyDown={onStageKey}>
      <header className="d-call-stage__head">
        <h2 id={titleId} className="d-call-stage__title">{title}</h2>
        {outgoing !== null ? <p className="d-call-stage__outgoing">{outgoing.text}</p> : null}
        {code !== null ? (
          <details ref={detailsRef} className="d-call-stage__code" onKeyDown={onCodeKey}>
            <summary className="d-call-stage__summary">{labels.code}</summary>
            <div className="d-call-stage__code-body">
              <p className="d-call-stage__digits">{groupCode(code)}</p>
              <p className="d-call-stage__help">{labels.codeHelp}</p>
            </div>
          </details>
        ) : null}
      </header>
      <div ref={noticeRef} role="status" className="d-call-stage__notice" data-empty={notice === null ? 'true' : undefined} data-kind={notice?.kind}
        tabIndex={notice !== null && notice.action === null ? -1 : undefined}>
        {notice !== null ? (
          <>
            <span className="d-call-stage__notice-glyph" aria-hidden="true">{NOTICE_GLYPH[notice.kind]}</span>
            <p className="d-call-stage__notice-text">{notice.text}</p>
            {notice.action !== null ? (
              <button ref={actionRef} type="button" className="d-btn d-call-stage__notice-action" data-variant="default" data-size="md"
                onClick={notice.action.onAction}>{notice.action.label}</button>
            ) : null}
          </>
        ) : null}
      </div>
      {tiles.length === 0 ? (
        notice === null ? <p className="d-call-stage__empty">{labels.empty}</p> : null
      ) : (
        <ul ref={tilesRef} role="list" aria-label={labels.tiles} className="d-call-stage__tiles" data-tiles={stageMode ? 'stage' : undefined}
          data-many={tiles.length > 2 ? 'true' : undefined}
          style={focusedLayout ? { '--d-strip-n': Math.max(1, tiles.length - 1) } as React.CSSProperties : undefined}>
          {tiles.map(t => {
            const id = idOf(t);
            const focused = focusedHere && id === focusedId;
            return (
              <CallTile key={id} {...t} media={hideMedia ? null : t.media}
                focused={focused} onFocusTile={onFocus ? () => { onFocus(focused ? null : id); } : undefined} />
            );
          })}
        </ul>
      )}
      <div className="d-call-stage__controls">{controls}</div>
    </section>
  );
}
