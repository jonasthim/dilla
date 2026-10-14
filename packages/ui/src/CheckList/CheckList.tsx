import { useEffect, useId, useRef, type CSSProperties } from 'react';
import './CheckList.css';

export interface CheckListItem { id: string; label: string; detail?: string; checked: boolean; disabled: boolean; color?: number | null }
export interface CheckListProps {
  label: string;
  items: readonly CheckListItem[];
  /** The one row whose change is in flight: disabled and `aria-busy` until it is null again. */
  busyId: string | null;
  emptyLabel: string;
  onToggle(id: string, checked: boolean): void;
}

const hex = (v: number): string => `#${(v & 0xffffff).toString(16).padStart(6, '0')}`;

/**
 * A set of native checkboxes in a `fieldset` named by its `legend`: "which of these apply". A row's `detail` describes
 * its checkbox; a non-null, non-zero `color` draws the role dot before the label. The busy row is disabled while its
 * change is in flight; when it ends, focus returns to that checkbox if the browser dropped it.
 */
export function CheckList({ label, items, busyId, emptyLabel, onToggle }: CheckListProps) {
  const uid = useId();
  const boxes = useRef(new Map<string, HTMLInputElement>());
  const lastToggled = useRef<string | null>(null);
  const prevBusy = useRef<string | null>(null);

  // A disabled control cannot keep focus, so a keyboard user would land on the page body after every change.
  useEffect(() => {
    const was = prevBusy.current;
    prevBusy.current = busyId;
    // Only at the end of a change: a row that was busy, is not any more, and was toggled by the person.
    if (busyId !== null || was === null || lastToggled.current !== was) return;
    const el = boxes.current.get(was);
    lastToggled.current = null;
    const active = document.activeElement;
    if (el && !el.disabled && (active === null || active === document.body)) el.focus();
  }, [busyId]);

  return (
    <fieldset className="d-check-list">
      <legend className="d-check-list__legend">{label}</legend>
      {items.length === 0 ? (
        <p className="d-check-list__empty">{emptyLabel}</p>
      ) : (
        <ul className="d-check-list__rows" role="list">
          {items.map(item => {
            const busy = item.id === busyId;
            const inputId = `${uid}-${item.id}`;
            const detailId = `${inputId}-detail`;
            return (
              <li key={item.id} className="d-check-list__row" aria-busy={busy || undefined}>
                <input ref={el => { if (el) boxes.current.set(item.id, el); else boxes.current.delete(item.id); }}
                  id={inputId} type="checkbox" className="d-check-list__box" checked={item.checked} disabled={item.disabled || busy}
                  aria-busy={busy || undefined} aria-describedby={item.detail ? detailId : undefined}
                  onChange={e => { lastToggled.current = item.id; onToggle(item.id, e.currentTarget.checked); }} />
                <label htmlFor={inputId} className="d-check-list__label">
                  {item.color ? <span className="d-check-list__dot" aria-hidden="true" style={{ '--d-swatch': hex(item.color) } as CSSProperties} /> : null}
                  <span className="d-check-list__text">{item.label}</span>
                </label>
                {item.detail ? <span id={detailId} className="d-check-list__detail">{item.detail}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}
