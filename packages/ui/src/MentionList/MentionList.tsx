import type { MouseEvent } from 'react';
import './MentionList.css';

export interface MentionListProps {
  id: string;
  label: string;
  options: readonly { id: string; primary: string; secondary: string }[];
  activeId: string | null;
  onPick(id: string): void;
}

/**
 * The people (and `@everyone`) to mention, as a listbox the composer's textarea points at with
 * `aria-activedescendant`: no option takes focus. A pointer down on an option picks it and keeps the focus in the
 * textarea (its default is prevented).
 */
export function MentionList({ id, label, options, activeId, onPick }: MentionListProps) {
  return (
    <ul role="listbox" id={id} aria-label={label} className="d-mention-list">
      {options.map(option => (
        <li key={option.id} role="option" id={option.id} aria-selected={option.id === activeId}
          onMouseDown={(e: MouseEvent<HTMLLIElement>) => { e.preventDefault(); onPick(option.id); }}>
          <span className="d-mention-list__primary">{option.primary}</span>
          <span className="d-mention-list__secondary">{option.secondary}</span>
        </li>
      ))}
    </ul>
  );
}
