import { useEffect, useId, useRef, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent } from 'react';
import './GifPicker.css';

export interface GifPickerItem {
  id: string;
  title: string;
  width: number;
  height: number;
  /** The preview as a page-minted URL, or null while it loads. It is never a remote URL. */
  src: string | null;
}

export interface GifPickerStatus {
  kind: 'loading' | 'empty' | 'error' | 'busy';
  text: string;
}

export interface GifPickerProps {
  /** The dialog's id, for the opener's `aria-controls`. */
  id?: string;
  label: string;
  searchLabel: string;
  searchPlaceholder: string;
  query: string;
  onQuery(query: string): void;
  items: readonly GifPickerItem[];
  /** Said politely in the one status line; null says nothing. */
  status: GifPickerStatus | null;
  /** The attribution Giphy asks for. */
  poweredBy: string;
  /** The accessible name of a result that has no title. */
  untitled: string;
  moreLabel: string;
  hasMore: boolean;
  onMore(): void;
  /** The result being downloaded to be attached; a second pick is ignored meanwhile. */
  pickingId: string | null;
  onPick(id: string): void;
  /** Escape asks to close and return focus to the opener; a pointer down outside closes and leaves focus where it landed. */
  onClose(reason: 'escape' | 'outside'): void;
}

const COLUMNS = 3;

/**
 * A non-modal popover dialog above the composer: a search box (focused on mount), a grid of preview buttons in
 * three columns, "more" when there is more, and the attribution. The grid is one tab stop that follows focus;
 * arrows move in two dimensions without wrapping, ArrowDown from the search box enters the grid, ArrowUp from the
 * first row goes back to it; Home and End go to the ends; Enter, Space or a click picks. Escape closes and goes no
 * further; a pointer down outside closes it, except on the opener (`[data-gif-toggle]`), which toggles it itself.
 * The previews are decorative (`alt=""`): each button is named by the GIF's title. Returning focus is the caller's.
 */
export function GifPicker({
  id, label, searchLabel, searchPlaceholder, query, onQuery, items, status, poweredBy, untitled, moreLabel, hasMore, onMore,
  pickingId, onPick, onClose,
}: GifPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const statusId = useId();

  const cells = (): HTMLButtonElement[] => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button[data-gif-id]') ?? []);

  useEffect(() => {
    searchRef.current?.focus();
    const onPointerDown = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Node) || ref.current === null || ref.current.contains(target)) return;
      if (target instanceof Element && target.closest('[data-gif-toggle]') !== null) return;
      onCloseRef.current('outside');
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose('escape');
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const list = cells();
    if (e.target === searchRef.current) {
      if (e.key === 'ArrowDown' && list.length > 0) {
        e.preventDefault();
        setFocus(0);
        list[0].focus();
      }
      return;
    }
    const i = e.target instanceof HTMLButtonElement ? list.indexOf(e.target) : -1;
    if (i < 0) return;
    const n = list.length;
    let next: number;
    switch (e.key) {
      case 'ArrowRight': next = i + 1 < n ? i + 1 : i; break;
      case 'ArrowLeft': next = i - 1 >= 0 ? i - 1 : i; break;
      case 'ArrowDown': next = i + COLUMNS < n ? i + COLUMNS : i; break;
      case 'ArrowUp':
        if (i < COLUMNS) {
          e.preventDefault();
          searchRef.current?.focus();
          return;
        }
        next = i - COLUMNS;
        break;
      case 'Home': next = 0; break;
      case 'End': next = n - 1; break;
      default: return;
    }
    e.preventDefault();
    setFocus(next);
    list[next].focus();
  };

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const i = e.target instanceof HTMLButtonElement ? cells().indexOf(e.target) : -1;
    if (i >= 0) setFocus(i);
  };

  const tab = Math.min(focus, Math.max(items.length - 1, 0));
  return (
    <div ref={ref} id={id} role="dialog" aria-label={label} className="d-gif-picker" onKeyDown={onKeyDown}>
      <input ref={searchRef} type="search" className="d-gif-picker__search" aria-label={searchLabel} placeholder={searchPlaceholder}
        value={query} autoComplete="off" spellCheck={false} aria-describedby={statusId}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onQuery(e.currentTarget.value)} />
      <div role="group" aria-label={label} className="d-gif-picker__grid" onFocus={onFocus}>
        {items.map((item, i) => (
          <button key={item.id} type="button" className="d-gif-picker__cell" data-gif-id={item.id}
            aria-label={item.title === '' ? untitled : item.title} aria-busy={pickingId === item.id ? true : undefined}
            tabIndex={i === tab ? 0 : -1} style={{ aspectRatio: item.width > 0 && item.height > 0 ? `${item.width} / ${item.height}` : undefined }}
            onClick={() => { if (pickingId === null) onPick(item.id); }}>
            {item.src === null
              ? <span className="d-gif-picker__loading" data-loading="" aria-hidden="true" />
              : <img className="d-gif-picker__img" src={item.src} alt="" draggable={false} />}
          </button>
        ))}
      </div>
      <p id={statusId} className="d-gif-picker__status" role="status" data-kind={status?.kind}>{status?.text ?? ''}</p>
      <div className="d-gif-picker__foot">
        {hasMore ? <button type="button" className="d-gif-picker__more" onClick={onMore}>{moreLabel}</button> : <span />}
        <span className="d-gif-picker__powered">{poweredBy}</span>
      </div>
    </div>
  );
}
