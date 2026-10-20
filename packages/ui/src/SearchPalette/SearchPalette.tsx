import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../Button/Button.tsx';
import { KeyHint } from '../KeyHint/KeyHint.tsx';
import { usePhoneLayout } from '../internal/phoneLayout.ts';
import './SearchPalette.css';

export type SearchPaletteProps = {
  open: boolean;
  query: string;
  scope: 'channel' | 'community' | 'all';
  /** `location` is the shown place (`#general`); `author` and `time` are optional and left out of the row when unknown (J1). */
  hits: readonly { id: string; snippet: string; location: string; author?: string; time?: string }[];
  /** `hints` are the footer's three phrases (J1): "to move", "to open", "to close"; with none given there is no footer. */
  labels: { search: string; empty: string; close: string; scope: { channel: string; community: string; all: string }; hints?: { move: string; open: string; close: string } };
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

/**
 * The search palette: a combobox textbox that keeps focus while the arrows move the active result, the scopes, the
 * results and Close. One polite status stays mounted and only its text changes (M-03). On a desktop it is a modal centred
 * overlay of at most 40rem (J1, a native dialog with a scrim; the shell stays mounted and goes inert); opening focuses the textbox and closing returns focus to the opener.
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
    <input ref={inputRef} type="text" role="combobox" aria-label={labels.search} aria-expanded={options.length > 0} aria-autocomplete="list"
      aria-controls={options.length ? listId : undefined} aria-activedescendant={options.length ? options[activeIndex].id : undefined}
      value={query} onChange={event => { setActive(0); onQuery(event.target.value); }} onKeyDown={handleInputKey} />
    <div className="d-search-palette__scopes">{(['channel', 'community', 'all'] as const).map(item => <button type="button" key={item} aria-pressed={scope === item} onClick={() => onScope(item)}>{labels.scope[item]}</button>)}</div>
    {options.length ? <div id={listId} role="listbox" aria-label={labels.search}>{options.map((hit, index) => <div role="option" id={hit.id} key={hit.id} aria-selected={index === activeIndex} onClick={() => pick(hit.id)}>
      <span className="d-search-palette__meta"><span className="d-search-palette__where">{hit.location}</span>{hit.author ? <span className="d-search-palette__author">{hit.author}</span> : null}{hit.time ? <span className="d-search-palette__time">{hit.time}</span> : null}</span>
      <span className="d-search-palette__snippet">{hit.snippet}</span></div>)}</div> : null}
    <div className="d-search-palette__status" role="status" aria-live="polite">{text}</div>
    <div className="d-search-palette__foot">
      {labels.hints && !phone ? <div className="d-search-palette__hints">
        <KeyHint keys={['↑', '↓']} label={labels.hints.move} /><KeyHint keys={['↵']} label={labels.hints.open} /><KeyHint keys={['esc']} label={labels.hints.close} />
      </div> : null}
      <Button variant="ghost" {...(labels.hints ? {} : { keyHint: 'esc' })} className="d-search-palette__close" onClick={onClose}>{labels.close}</Button>
    </div>
  </section>;
  if (!asDialog) return palette;
  // Escape is handled on the section (it also covers IME composition); the native cancel is the fallback (a back gesture). A click on the scrim closes.
  return <dialog ref={dialogRef} className="d-search-palette-dialog" aria-label={labels.search}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === dialogRef.current) onClose(); }}>{palette}</dialog>;
}
