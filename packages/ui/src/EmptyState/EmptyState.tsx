import { useId } from 'react';
import { Button } from '../Button/Button.tsx';
import './EmptyState.css';

export interface EmptyStateProps {
  title: string;
  body: string;
  action?: { label: string; onAction(): void };
  /** A second way forward after the primary action, as a plain button (flow 07: start a server, or join one). */
  secondary?: { label: string; onAction(): void };
}

/** A region named by its heading, for a pane that has nothing to show yet. */
export function EmptyState({ title, body, action, secondary }: EmptyStateProps) {
  const titleId = useId();
  return (
    <section className="d-empty-state" aria-labelledby={titleId}>
      <h2 id={titleId} className="d-empty-state__title">{title}</h2>
      <p className="d-empty-state__body">{body}</p>
      {action || secondary ? (
        <div className="d-empty-state__actions">
          {action ? <Button variant="accent" onClick={action.onAction}>{action.label}</Button> : null}
          {secondary ? <Button onClick={secondary.onAction}>{secondary.label}</Button> : null}
        </div>
      ) : null}
    </section>
  );
}
