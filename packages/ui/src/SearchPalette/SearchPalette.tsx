import { useId, useState, type KeyboardEvent } from 'react';
import './SearchPalette.css';

export type SearchPaletteProps = {
  open: boolean;
  query: string;
  scope: 'channel' | 'community' | 'all';
  hits: readonly { id: string; snippet: string; location: string }[];
  labels: { search: string; empty: string; close: string; scope: { channel: string; community: string; all: string } };
  onQuery(s: string): void;
  onScope(s: 'channel' | 'community' | 'all'): void;
  onPick(id: string): void;
  onClose(): void;
};

export function SearchPalette({ open, query, scope, hits, labels, onQuery, onScope, onPick, onClose }: SearchPaletteProps) {
  const [active, setActive] = useState(0);
  const listId = useId();
  const options = hits.slice(0, 50);
  if (!open) return null;
  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && options.length) { event.preventDefault(); setActive(index => (index + 1) % options.length); }
    else if (event.key === 'ArrowUp' && options.length) { event.preventDefault(); setActive(index => (index - 1 + options.length) % options.length); }
    else if (event.key === 'Enter' && options.length) { event.preventDefault(); onPick(options[Math.min(active, options.length - 1)].id); }
    else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
  };
  return <section className="d-search-palette" role="search" aria-label={labels.search}>
    <input type="text" aria-label={labels.search} aria-controls={options.length ? listId : undefined} aria-activedescendant={options.length ? options[Math.min(active, options.length - 1)].id : undefined} value={query} onChange={event => { setActive(0); onQuery(event.target.value); }} onKeyDown={handleKey} />
    <div className="d-search-palette__scopes">{(['channel', 'community', 'all'] as const).map(item => <button type="button" key={item} aria-pressed={scope === item} onClick={() => onScope(item)}>{labels.scope[item]}</button>)}</div>
    {options.length ? <div id={listId} role="listbox" aria-label={labels.search}>{options.map((hit, index) => <div role="option" id={hit.id} key={hit.id} aria-selected={index === active} onClick={() => onPick(hit.id)}>{hit.snippet}<small>{hit.location}</small></div>)}</div> : <div role="status" aria-live="polite">{labels.empty}</div>}
    <button type="button" onClick={onClose}>{labels.close}</button>
  </section>;
}
