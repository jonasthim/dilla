import { useId, useState, type KeyboardEvent } from 'react';
import { Button } from '../Button/Button.tsx';
import './SearchPalette.css';

export type SearchPaletteProps = {
  open: boolean;
  query: string;
  scope: 'channel' | 'community' | 'all';
  hits: readonly { id: string; snippet: string; location: string }[];
  labels: { search: string; empty: string; close: string; scope: { channel: string; community: string; all: string } };
  /** A status that replaces the empty text, such as a picked hit that is no longer available. */
  status?: string;
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
 * results and Close. One polite status stays mounted and only its text changes (M-03).
 */
export function SearchPalette({ open, query, scope, hits, labels, status, onQuery, onScope, onPick, onClose }: SearchPaletteProps) {
  const [active, setActive] = useState(0);
  const listId = useId();
  const options = hits.slice(0, 50);
  if (!open) return null;
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const handleInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing(event)) return;
    if (event.key === 'ArrowDown' && options.length) { event.preventDefault(); setActive((activeIndex + 1) % options.length); }
    else if (event.key === 'ArrowUp' && options.length) { event.preventDefault(); setActive((activeIndex - 1 + options.length) % options.length); }
    else if (event.key === 'Enter' && options.length) { event.preventDefault(); onPick(options[activeIndex].id); }
  };
  // Escape closes from anywhere in the palette (Flow 05 "any top overlay"), never during IME composition.
  const handleKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (!composing(event)) onClose();
  };
  const text = status ?? (options.length ? '' : labels.empty);
  return <section className="d-search-palette" role="search" aria-label={labels.search} onKeyDown={handleKey}>
    <input type="text" role="combobox" aria-label={labels.search} aria-expanded={options.length > 0} aria-autocomplete="list"
      aria-controls={options.length ? listId : undefined} aria-activedescendant={options.length ? options[activeIndex].id : undefined}
      value={query} onChange={event => { setActive(0); onQuery(event.target.value); }} onKeyDown={handleInputKey} />
    <div className="d-search-palette__scopes">{(['channel', 'community', 'all'] as const).map(item => <button type="button" key={item} aria-pressed={scope === item} onClick={() => onScope(item)}>{labels.scope[item]}</button>)}</div>
    {options.length ? <div id={listId} role="listbox" aria-label={labels.search}>{options.map((hit, index) => <div role="option" id={hit.id} key={hit.id} aria-selected={index === activeIndex} onClick={() => onPick(hit.id)}>{hit.snippet}<small>{hit.location}</small></div>)}</div> : null}
    <div className="d-search-palette__status" role="status" aria-live="polite">{text}</div>
    <Button variant="ghost" keyHint="esc" className="d-search-palette__close" onClick={onClose}>{labels.close}</Button>
  </section>;
}
