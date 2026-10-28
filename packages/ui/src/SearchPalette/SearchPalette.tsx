import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import { usePhoneLayout } from '../internal/phoneLayout.ts';
import './SearchPalette.css';

export type SearchPaletteProps = {
  open: boolean;
  query: string;
  scope: 'channel' | 'community' | 'all';
  /** `location` is the shown place (`#general`); `author` and `time` are optional and left out of the row when unknown (J1). */
  hits: readonly { id: string; snippet: string; location: string; author?: string; time?: string }[];
  /**
   * `hints` are the footer's key words ("move", "open"; the prototype's footer), `note` its right-hand line ("Searches messages held in
   * this browser"), `group` the results' heading ("Messages"). `close` names the esc key cap, which closes.
   */
  labels: { search: string; empty: string; close: string; scope: { channel: string; community: string; all: string }; hints?: { move: string; open: string }; note?: string; group?: string };
  /** A status that replaces the empty text, such as a picked hit that is no longer available. */
  status?: string;
  /** True: a desktop palette is a modal native dialog with a scrim, focus moves in on open and back to the opener on close (R-S4). Default: the inline section. */
  modal?: boolean;
  onQuery(s: string): void;
  onScope(s: 'channel' | 'community' | 'all'): void;
  onPick(id: string): void;
  onClose(): void;
};

/** True while an input method is composing: its Enter and Escape belong to the IME (Flow 05, W-07). */
function composing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

const SCOPES = ['channel', 'community', 'all'] as const;

/**
 * The search palette (Signal §5.8): a 50px input row (the accent glyph, the combobox textbox, the scope and the esc key cap that
 * closes), the results (a 10px uppercase group heading, then rows of at least 38px: a 24px glyph tile, the snippet over its
 * `#place · author · time` line, the selected row on --surface-hi with a 2px accent bar and ↵), and the footer of key words and the
 * note. The textbox keeps focus while the arrows move the active result. One polite status stays mounted and only its text
 * changes (M-03). On a desktop it is a modal native dialog at 14vh, centred by `margin: 0 auto` (never a transform), over the
 * --scrim; opening focuses the textbox and closing returns focus to the opener.
 */
export function SearchPalette({ open, query, scope, hits, labels, status, modal = false, onQuery, onScope, onPick, onClose }: SearchPaletteProps) {
  const [active, setActive] = useState(0);
  const listId = useId();
  const phone = usePhoneLayout();
  const asDialog = modal && !phone;
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const picked = useRef(false);
  // A desktop palette is a modal <dialog> (R-S1): the browser traps focus, makes the shell inert and draws the ::backdrop scrim.
  useEffect(() => {
    const el = dialogRef.current;
    if (!open || !asDialog || !el) return;
    if (!el.open) el.showModal();
    return () => { if (el.open) el.close(); };
  }, [open, asDialog]);
  // Focus goes to the textbox on open and back to whatever opened the palette when it closes (contract 2), unless a pick moved it on purpose.
  useEffect(() => {
    if (!open || !modal) return;
    picked.current = false;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => { if (!picked.current && opener?.isConnected) opener.focus(); };
  }, [open, modal]);
  const pick = (id: string) => { picked.current = true; onPick(id); };
  const options = hits.slice(0, 50);
  if (!open) return null;
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const handleInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing(event)) return;
    if (event.key === 'ArrowDown' && options.length) { event.preventDefault(); setActive((activeIndex + 1) % options.length); }
    else if (event.key === 'ArrowUp' && options.length) { event.preventDefault(); setActive((activeIndex - 1 + options.length) % options.length); }
    else if (event.key === 'Enter' && options.length) { event.preventDefault(); pick(options[activeIndex].id); }
  };
  // Escape closes from anywhere in the palette (Flow 05 "any top overlay"), never during IME composition.
  const handleKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (!composing(event)) onClose();
  };
  const text = status ?? (options.length ? '' : labels.empty);
  const palette = <section className="d-search-palette" data-layout={phone ? 'phone' : undefined} role="search" aria-label={labels.search} onKeyDown={handleKey}>
    <div className="d-search-palette__field">
      <span className="d-search-palette__glyph" aria-hidden="true"><Icon name="search" size={16} /></span>
      <input ref={inputRef} type="text" role="combobox" aria-label={labels.search} aria-expanded={options.length > 0} aria-autocomplete="list"
        aria-controls={options.length ? listId : undefined} aria-activedescendant={options.length ? options[activeIndex].id : undefined}
        value={query} onChange={event => { setActive(0); onQuery(event.target.value); }} onKeyDown={handleInputKey} />
      <div className="d-search-palette__scopes" role="group" aria-label={labels.scope[scope]}>{SCOPES.map(item => <button type="button" key={item} aria-pressed={scope === item} onClick={() => onScope(item)}>{labels.scope[item]}</button>)}</div>
      <button type="button" className="d-search-palette__esc" aria-label={labels.close} onClick={onClose}>esc</button>
    </div>
    <div className="d-search-palette__results">
      {options.length ? <>
        {labels.group ? <div className="d-search-palette__group" aria-hidden="true">{labels.group}</div> : null}
        <div id={listId} role="listbox" aria-label={labels.group ?? labels.search}>{options.map((hit, index) => <div role="option" id={hit.id} key={hit.id} aria-selected={index === activeIndex}
          onClick={() => pick(hit.id)} onMouseEnter={() => setActive(index)}>
          <span className="d-search-palette__tile" aria-hidden="true"><Icon name="message-square" size={13} /></span>
          <span className="d-search-palette__text">
            <span className="d-search-palette__snippet">{hit.snippet}</span>
            <span className="d-search-palette__meta"><span className="d-search-palette__where">{hit.location}</span>{hit.author ? <> · <span className="d-search-palette__author">{hit.author}</span></> : null}{hit.time ? <> · <span className="d-search-palette__time">{hit.time}</span></> : null}</span>
          </span>
          {index === activeIndex ? <span className="d-search-palette__enter" aria-hidden="true">↵</span> : null}
        </div>)}</div>
      </> : null}
      <div className="d-search-palette__status" role="status" aria-live="polite">{text}</div>
    </div>
    {labels.hints || labels.note ? <div className="d-search-palette__foot">
      {labels.hints ? <span className="d-search-palette__hints"><span>↑↓ {labels.hints.move}</span><span>↵ {labels.hints.open}</span></span> : null}
      <span className="d-search-palette__spacer" />
      {labels.note ? <span className="d-search-palette__note">{labels.note}</span> : null}
    </div> : null}
  </section>;
  if (!asDialog) return palette;
  // Escape is handled on the section (it also covers IME composition); the native cancel is the fallback (a back gesture). A click on the scrim closes.
  return <dialog ref={dialogRef} className="d-search-palette-dialog" aria-label={labels.search}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === dialogRef.current) onClose(); }}>{palette}</dialog>;
}
