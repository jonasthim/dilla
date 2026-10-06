import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';

/**
 * Single-tab-stop roving focus over a list whose every <li> holds one <button>
 * (the community rail, the channel list). Exactly one item carries tabIndex 0:
 * the item that last had focus, or, when `activeIndex` changes, the active item
 * (the first item when none is active). Arrows move focus without wrapping and
 * never select; Enter and Space activate the native button. A key pressed with
 * Alt, Ctrl, Meta or Shift is left alone: Alt+ArrowUp/Down belong to the shell.
 */
export interface RovingFocus {
  ref: RefObject<HTMLUListElement | null>;
  onKeyDown(event: KeyboardEvent<HTMLUListElement>): void;
  onFocus(event: FocusEvent<HTMLUListElement>): void;
}

export function useRovingFocus(activeIndex: number): RovingFocus {
  const ref = useRef<HTMLUListElement>(null);
  // The index of the item that holds tabIndex 0; null until the next render places it.
  const stop = useRef<number | null>(null);

  const items = (): HTMLButtonElement[] =>
    Array.from(ref.current?.children ?? [])
      .map(child => child.firstElementChild)
      .filter((el): el is HTMLButtonElement => el instanceof HTMLButtonElement);

  const apply = (index: number) => {
    items().forEach((item, i) => { item.tabIndex = i === index ? 0 : -1; });
  };

  // Declared first, so a new active item resets the stop before the placement below runs.
  useLayoutEffect(() => { stop.current = null; }, [activeIndex]);

  // No dependency list: runs after every render, so items added or removed are covered.
  useLayoutEffect(() => {
    const list = items();
    if (list.length === 0) return;
    let i = stop.current;
    if (i === null || i >= list.length) i = activeIndex >= 0 && activeIndex < list.length ? activeIndex : 0;
    stop.current = i;
    apply(i);
  });

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const list = items();
    const target: EventTarget = event.target;
    const from = target instanceof HTMLButtonElement ? list.indexOf(target) : -1;
    if (from < 0) return;
    let next: number;
    switch (event.key) {
      case 'ArrowDown': next = Math.min(from + 1, list.length - 1); break;
      case 'ArrowUp': next = Math.max(from - 1, 0); break;
      case 'Home': next = 0; break;
      case 'End': next = list.length - 1; break;
      default: return;
    }
    event.preventDefault();
    stop.current = next;
    apply(next);
    list[next].focus();
  };

  // A click or a programmatic focus moves the stop too.
  const onFocus = (event: FocusEvent<HTMLUListElement>) => {
    const target: EventTarget = event.target;
    const idx = target instanceof HTMLButtonElement ? items().indexOf(target) : -1;
    if (idx >= 0 && idx !== stop.current) {
      stop.current = idx;
      apply(idx);
    }
  };

  return { ref, onKeyDown, onFocus };
}
