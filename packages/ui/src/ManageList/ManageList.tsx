import { Button } from '../Button/Button.tsx';
import './ManageList.css';

export interface ManageListRow { id: string; title: string; detail: readonly string[]; action: { label: string; ariaLabel: string } | null }
export interface ManageListProps {
  label: string;
  rows: readonly ManageListRow[];
  emptyLabel: string;
  /** The row whose action is running: only that row's button is disabled. */
  busyId: string | null;
  onAction(id: string): void;
}

/**
 * Rows of a title, detail lines and one action each (the server's invites, its bans). The action's visible `label` is
 * short ("revoke"); `ariaLabel` names the row it acts on and starts with that label (WCAG 2.5.3).
 */
export function ManageList({ label, rows, emptyLabel, busyId, onAction }: ManageListProps) {
  if (rows.length === 0) return <p className="d-manage-list__empty">{emptyLabel}</p>;
  return (
    <ul className="d-manage-list" role="list" aria-label={label}>
      {rows.map(row => (
        <li key={row.id} className="d-manage-list__row">
          <div className="d-manage-list__text">
            <span className="d-manage-list__title">{row.title}</span>
            {row.detail.map((line, i) => <span key={i} className="d-manage-list__detail">{line}</span>)}
          </div>
          {row.action !== null ? (
            <Button variant="ghost" aria-label={row.action.ariaLabel} disabled={busyId === row.id} aria-busy={busyId === row.id || undefined}
              onClick={() => onAction(row.id)}>
              {row.action.label}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
