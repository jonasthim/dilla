import './Pill.css';
export type PillProps = { kind: 'unread' | 'mention'; count: number };
export function Pill({ kind, count }: PillProps) {
  if (count <= 0) return null;
  const label = kind === 'unread' ? `${count} unread` : `${count} ${count === 1 ? 'mention' : 'mentions'}`;
  return <span className="d-pill" data-kind={kind} aria-label={label} role="status">{count > 99 ? '99+' : count}</span>;
}
