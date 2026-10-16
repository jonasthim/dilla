import { useId } from 'react';
import { RoleDot } from '../internal/RoleDot.tsx';
import './CheckList.css';

export interface CheckListItem { id: string; label: string; detail?: string; checked: boolean; disabled: boolean; color?: number | null }
export interface CheckListProps {
  label: string;
  items: readonly CheckListItem[];
  /** The one row whose change is in flight: `aria-disabled` and `aria-busy` (it keeps focus) until it is null again. */
  busyId: string | null;
  emptyLabel: string;
  onToggle(id: string, checked: boolean): void;
  /** Marks the first enabled box `data-autofocus`: a Dialog around the list opens on it. */
  initialFocus?: boolean;
  /** The id of a hint the caller renders for the whole list. */
  describedBy?: string;
}

/**
 * A set of native checkboxes in a `fieldset` named by its `legend`: "which of these apply". A row's `detail` describes
 * its checkbox; a non-null, non-zero `color` draws the role dot before the label. The busy row is `aria-disabled`, as
 * Toggle's disabled state is: it ignores clicks and keys but stays focusable, so focus never leaves while the change is
 * in flight. A locked row (`disabled`) is natively disabled.
 */
export function CheckList({ label, items, busyId, emptyLabel, onToggle, initialFocus, describedBy }: CheckListProps) {
  const uid = useId();
  const first = initialFocus ? items.find(i => !i.disabled)?.id : undefined;
  return (
    <fieldset className="d-check-list" aria-describedby={describedBy}>
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
                <input id={inputId} type="checkbox" className="d-check-list__box" checked={item.checked} disabled={item.disabled}
                  aria-disabled={busy || undefined} aria-busy={busy || undefined} aria-describedby={item.detail ? detailId : undefined}
                  data-autofocus={item.id === first ? '' : undefined}
                  onChange={e => { if (!busy) onToggle(item.id, e.currentTarget.checked); }} />
                <label htmlFor={inputId} className="d-check-list__label">
                  {item.color ? <RoleDot color={item.color} /> : null}
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
