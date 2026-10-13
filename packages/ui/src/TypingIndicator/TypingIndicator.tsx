import './TypingIndicator.css';
export type TypingIndicatorProps = { names: readonly string[]; labels: { one: string; many: string } };
export function TypingIndicator({ names, labels }: TypingIndicatorProps) {
  const distinct = [...new Set(names)];
  if (distinct.length === 0) return null;
  return <div className="d-typing-indicator" role="status" aria-live="polite">{distinct.length === 1 ? labels.one.replace('{name}', distinct[0]) : labels.many}</div>;
}
