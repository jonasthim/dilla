import { Button } from '../Button/Button.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';
import { TrailingSlot } from '../TrailingSlot/TrailingSlot.tsx';
import './ManageList.css';

export interface ManageListRow {
  id: string;
  title: string;
  detail: readonly string[];
  /** A text action: one ghost button in the trailing area (the server's invites, its bans, the privacy rows). */
  action: { label: string; ariaLabel: string } | null;
  /** An icon action (`square-pen`) in the first trailing slot. `ariaLabel` names the row it edits and is the tooltip. */
  edit?: { ariaLabel: string };
  /** An icon action (`x`) in the second trailing slot. Omitted for a `fixed` row. */
  remove?: { ariaLabel: string };
  /** No delete action (the AFK channel, R39): the slot stays reserved so the edit icons keep one right edge. */
  fixed?: boolean;
}
export interface ManageListProps {
  label: string;
  rows: readonly ManageListRow[];
  emptyLabel: string;
  /** The row whose action is running: only that row's buttons are disabled. */
  busyId: string | null;
  onAction(id: string): void;
  onEdit?(id: string): void;
  onDelete?(id: string): void;
}

/**
 * Rows of a title, detail lines and their actions (the server's invites, its bans, its channels). A text action's visible
 * `label` is short ("revoke"); `ariaLabel` names the row it acts on and starts with that label (WCAG 2.5.3). Icon actions
 * (edit, delete) sit in fixed trailing slots (R13); a `fixed` row has no delete (I6).
 */
export function ManageList({ label, rows, emptyLabel, busyId, onAction, onEdit, onDelete }: ManageListProps) {
  if (rows.length === 0) return <p className="d-manage-list__empty">{emptyLabel}</p>;
  const icons = rows.some(row => row.edit || row.remove);
  return (
    <ul className="d-manage-list" role="list" aria-label={label}>
      {rows.map(row => {
        const busy = busyId === row.id;
        return (
          <li key={row.id} className="d-manage-list__row" data-row>
            <div className="d-manage-list__text">
              <span className="d-manage-list__title">{row.title}</span>
              {row.detail.map((line, i) => <span key={i} className="d-manage-list__detail">{line}</span>)}
            </div>
            {row.action !== null || icons ? (
              <div className="d-manage-list__trail">
                {row.action !== null ? (
                  <Button variant="ghost" aria-label={row.action.ariaLabel} disabled={busy} aria-busy={busy || undefined}
                    onClick={() => onAction(row.id)}>
                    {row.action.label}
                  </Button>
                ) : null}
                {icons ? (
                  <>
                    <TrailingSlot>
                      {row.edit ? <IconButton icon="square-pen" label={row.edit.ariaLabel} disabled={busy} onClick={() => onEdit?.(row.id)} /> : null}
                    </TrailingSlot>
                    <TrailingSlot>
                      {row.remove && !row.fixed ? <IconButton icon="x" label={row.remove.ariaLabel} disabled={busy} onClick={() => onDelete?.(row.id)} /> : null}
                    </TrailingSlot>
                  </>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
