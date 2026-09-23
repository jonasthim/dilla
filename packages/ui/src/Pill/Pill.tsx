import './Pill.css';
export type PillProps = { kind: 'unread' | 'mention'; count: number };
export function Pill({ kind, count }: PillProps) {
  if (count <= 0) return null;
  const label = kind === 'unread' ? `${count} unread` : `${count} ${count === 1 ? 'mention' : 'mentions'}`;
  // No role="status": a pill is part of the row it sits in, and a live
  // region would announce every count change over whatever the user is
  // doing. The digits are the sighted half (capped at 99+); the hidden
  // span carries the real count into the row's accessible name.
  return (
    <span className="d-pill" data-kind={kind}>
      <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
      <span className="d-sr-only">{label}</span>
    </span>
  );
}
