import { useId } from 'react';
import { Button } from '../Button/Button.tsx';
import './CodeList.css';

export interface CodeListProps {
  codes: readonly string[];
  label: string;
  onCopy(): void;
  onPrint(): void;
  labels: { copy: string; print: string };
}

const GROUP = 5;

/** "k3m7qw9dx2" becomes "k3m7q w9dx2": groups of five, the last holding the rest. */
function grouped(code: string): string {
  const parts: string[] = [];
  for (let i = 0; i < code.length; i += GROUP) parts.push(code.slice(i, i + GROUP));
  return parts.join(' ');
}

/**
 * One-time codes as selectable text in a real ordered list, two columns from 480 px up. Copy and Print
 * are callbacks, as in RecoveryKey; the actions are hidden when printing so the page holds the codes only.
 */
export function CodeList({ codes, label, onCopy, onPrint, labels }: CodeListProps) {
  const labelId = useId();
  return (
    <div className="d-code-list">
      <p id={labelId} className="d-code-list__label d-label">{label}</p>
      <ol role="list" className="d-code-list__grid" aria-labelledby={labelId}>
        {codes.map((c, i) => <li key={i} className="d-code-list__code">{grouped(c)}</li>)}
      </ol>
      <div className="d-code-list__actions">
        <Button onClick={onCopy}>{labels.copy}</Button>
        <Button onClick={onPrint}>{labels.print}</Button>
      </div>
    </div>
  );
}
