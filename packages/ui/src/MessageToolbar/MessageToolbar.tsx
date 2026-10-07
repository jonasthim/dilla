import { useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Button } from '../Button/Button.tsx';
import { arrowIndex } from '../internal/arrow-select.ts';
import './MessageToolbar.css';

export interface MessageToolbarProps {
  label: string;
  tabbable: boolean;
  items: readonly {
    id: 'react' | 'reply' | 'edit' | 'pin' | 'delete'; label: string; danger?: boolean;
    onAction(e: MouseEvent | KeyboardEvent): void;
  }[];
}

/** The index of the event's target among the buttons, or -1. */
function indexOfTarget(list: readonly HTMLButtonElement[], target: EventTarget): number {
  return target instanceof HTMLButtonElement ? list.indexOf(target) : -1;
}

/**
 * A message's actions as one tab stop (`role="toolbar"`): the button that last had focus (initially the first)
 * holds the stop while `tabbable`, and none does otherwise (a row that is not the log's active row). ArrowLeft and
 * ArrowRight move with wrap, Home and End go to the ends; Escape is left to bubble, so the row takes focus.
 */
export function MessageToolbar({ label, tabbable, items }: MessageToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [stop, setStop] = useState(0);
  const buttons = (): HTMLButtonElement[] => Array.from(ref.current?.querySelectorAll('button') ?? []);
  const current = stop < items.length ? stop : 0;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = buttons();
    const from = indexOfTarget(list, e.target);
    if (from < 0) return;
    const next = arrowIndex(e, from, list.length, 'horizontal');
    if (next === null) return;
    e.preventDefault();
    setStop(next);
    list[next].focus();
  };

  // A click or a programmatic focus moves the stop too.
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const i = indexOfTarget(buttons(), e.target);
    if (i >= 0) setStop(i);
  };

  return (
    <div ref={ref} role="toolbar" aria-label={label} aria-orientation="horizontal" className="d-message-toolbar"
      onKeyDown={onKeyDown} onFocus={onFocus}>
      {items.map((item, i) => (
        <Button key={item.id} variant={item.danger === true ? 'danger' : 'ghost'} size="md" data-action={item.id}
          tabIndex={tabbable && i === current ? 0 : -1} onClick={e => item.onAction(e)}>{item.label}</Button>
      ))}
    </div>
  );
}
