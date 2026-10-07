import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import './EmojiGrid.css';

export interface EmojiGridProps {
  label: string;
  items: readonly { emoji: string; name: string }[];
  onPick(emoji: string): void;
  onClose(): void;
}

const COLUMNS = 8;

/** The index of the event's target among the buttons, or -1. */
function indexOfTarget(list: readonly HTMLButtonElement[], target: EventTarget): number {
  return target instanceof HTMLButtonElement ? list.indexOf(target) : -1;
}

/**
 * The fixed reactions as a non-modal popover dialog: buttons in 8 columns named by their names, one tab stop that
 * follows focus, the first focused on mount. Arrows move in two dimensions without wrapping, Home and End go to the
 * ends; Enter, Space or a click picks (the native button). Escape closes and goes no further (the row never sees
 * it); a pointer down outside the grid closes it too. Returning focus to the opener is the caller's.
 */
export function EmojiGrid({ label, items, onPick, onClose }: EmojiGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const buttons = (): HTMLButtonElement[] => Array.from(ref.current?.querySelectorAll('button') ?? []);

  useEffect(() => {
    buttons()[0]?.focus();
    const onPointerDown = (e: Event) => {
      const target = e.target;
      if (ref.current && target instanceof Node && !ref.current.contains(target)) onCloseRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const list = buttons();
    const i = indexOfTarget(list, e.target);
    if (i < 0) return;
    const n = list.length;
    let next: number;
    switch (e.key) {
      case 'ArrowRight': next = i + 1 < n ? i + 1 : i; break;
      case 'ArrowLeft': next = i - 1 >= 0 ? i - 1 : i; break;
      case 'ArrowDown': next = i + COLUMNS < n ? i + COLUMNS : i; break;
      case 'ArrowUp': next = i - COLUMNS >= 0 ? i - COLUMNS : i; break;
      case 'Home': next = 0; break;
      case 'End': next = n - 1; break;
      default: return;
    }
    e.preventDefault();
    setFocus(next);
    list[next].focus();
  };

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const i = indexOfTarget(buttons(), e.target);
    if (i >= 0) setFocus(i);
  };

  return (
    <div ref={ref} role="dialog" aria-label={label} className="d-emoji-grid">
      <div role="group" className="d-emoji-grid__grid" onKeyDown={onKeyDown} onFocus={onFocus}>
        {items.map((item, i) => (
          <button key={item.emoji} type="button" className="d-emoji-grid__emoji" aria-label={item.name} data-emoji={item.emoji}
            tabIndex={i === focus ? 0 : -1} onClick={() => onPick(item.emoji)}>
            <span aria-hidden="true">{item.emoji}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
