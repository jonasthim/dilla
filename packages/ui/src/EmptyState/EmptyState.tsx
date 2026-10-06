import { useId } from 'react';
import { Button } from '../Button/Button.tsx';
import './EmptyState.css';

export interface EmptyStateProps {
  title: string;
  body: string;
  action?: { label: string; onAction(): void };
}

/** A region named by its heading, for a pane that has nothing to show yet. */
export function EmptyState({ title, body, action }: EmptyStateProps) {
  const titleId = useId();
  return (
    <section className="d-empty-state" aria-labelledby={titleId}>
      <h2 id={titleId} className="d-empty-state__title">{title}</h2>
      <p className="d-empty-state__body">{body}</p>
      {action ? <Button variant="accent" onClick={action.onAction}>{action.label}</Button> : null}
    </section>
  );
}
