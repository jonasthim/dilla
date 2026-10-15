import { useId, useRef, type KeyboardEvent } from 'react';
import { arrowIndex } from '../internal/arrow-select.ts';
import { Toggle } from '../Toggle/Toggle.tsx';
import './PermissionGrid.css';

export type PermValue = 'allow' | 'inherit' | 'deny';
export interface PermissionGridRow { id: string; label: string; hint: string; disabled: boolean; disabledHint?: string }
export interface PermissionGridGroup { id: string; title: string; rows: readonly PermissionGridRow[] }
export interface PermissionGridProps {
  label: string;
  groups: readonly PermissionGridGroup[];
  mode: 'toggle' | 'tri';
  values: Readonly<Record<string, PermValue>>;
  labels: { allow: string; inherit: string; deny: string };
  onChange(id: string, v: PermValue): void;
  /** The level of each group's heading (default 3): one below the heading the grid sits under. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
}

const ORDER: readonly PermValue[] = ['allow', 'inherit', 'deny'];

interface RowProps {
  base: string;
  row: PermissionGridRow;
  value: PermValue;
  labels: PermissionGridProps['labels'];
  onChange(v: PermValue): void;
}

/** One right as a three-way choice: the ARIA radio group, selection following focus, wrapping arrows, one tab stop. */
function TriRow({ base, row, value, labels, onChange }: RowProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const hintId = `${base}-hint`;
  const reasonId = `${base}-reason`;
  const reason = row.disabled && row.disabledHint ? row.disabledHint : null;
  const describedBy = reason ? `${hintId} ${reasonId}` : hintId;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = refs.current.findIndex(el => el !== null && el === event.target);
    if (from < 0) return;
    const next = arrowIndex(event, from, ORDER.length, 'both');
    if (next === null) return;
    event.preventDefault();
    if (row.disabled) return;
    refs.current[next]?.focus();
    if (ORDER[next] !== value) onChange(ORDER[next]);
  };

  return (
    <div className="d-permission-grid__row" data-disabled={row.disabled ? 'true' : undefined}>
      <div className="d-permission-grid__text">
        <span id={`${base}-label`} className="d-permission-grid__name">{row.label}</span>
        <span id={hintId} className="d-permission-grid__hint">{row.hint}</span>
        {reason ? <span id={reasonId} className="d-permission-grid__hint d-permission-grid__reason">{reason}</span> : null}
      </div>
      <div role="radiogroup" className="d-permission-grid__tri" aria-labelledby={`${base}-label`}
        aria-describedby={describedBy} aria-disabled={row.disabled ? true : undefined} onKeyDown={onKeyDown}>
        {ORDER.map((v, i) => (
          <button key={v} ref={el => { refs.current[i] = el; }} type="button" role="radio" className="d-permission-grid__radio" data-value={v}
            aria-checked={v === value} aria-disabled={row.disabled ? true : undefined} aria-describedby={describedBy} tabIndex={v === value ? 0 : -1}
            onClick={() => { if (!row.disabled && v !== value) onChange(v); }}>{labels[v]}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * The permission editor body: a labelled group with one `h3` per group of rights. In `toggle` mode each right is a
 * switch (on is allow, off is inherit). In `tri` mode each right is a radio group of allow, inherit and deny: the
 * arrows move and select within the row, wrapping, and Tab moves to the next row. A disabled row ignores input but
 * stays a tab stop, so its reason (`disabledHint`) can be read; the reason is also drawn as text. At narrow widths
 * the label and hint stack above the control.
 *
 * Layout: the grid measures its own width (a container query), so it must sit in a block-level container, or in a flex
 * or grid item that has a width of its own (`flex: 1`, `min-width: 0`). It is never sized by its content.
 */
export function PermissionGrid({ label, groups, mode, values, labels, onChange, headingLevel = 3 }: PermissionGridProps) {
  const uid = useId();
  const Heading = `h${headingLevel}` as const;
  return (
    <div role="group" aria-label={label} className="d-permission-grid">
      {groups.map(group => (
        <section key={group.id} className="d-permission-grid__group">
          <Heading className="d-permission-grid__title">{group.title}</Heading>
          {group.rows.map(row => {
            const base = `${uid}-${group.id}-${row.id}`;
            const value = values[row.id] ?? 'inherit';
            if (mode === 'tri') return <TriRow key={row.id} base={base} row={row} value={value} labels={labels} onChange={v => onChange(row.id, v)} />;
            const reason = row.disabled && row.disabledHint ? row.disabledHint : null;
            const reasonId = `${base}-reason`;
            return (
              <div key={row.id} className="d-permission-grid__row d-permission-grid__row--toggle" data-disabled={row.disabled ? 'true' : undefined}>
                <Toggle id={base} label={row.label} showLabel hint={row.hint} disabled={row.disabled} checked={value === 'allow'}
                  describedBy={reason ? reasonId : undefined} onChange={on => onChange(row.id, on ? 'allow' : 'inherit')} />
                {reason ? <span id={reasonId} className="d-permission-grid__hint d-permission-grid__reason">{reason}</span> : null}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
