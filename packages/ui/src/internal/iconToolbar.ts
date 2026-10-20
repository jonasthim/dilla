import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';
import { arrowIndex } from './arrow-select.ts';

/**
 * Roving focus for a horizontal `role="toolbar"` of `IconButton`s (the voice dock, the user panel's mute and deafen).
 * One button holds the tab stop: the one that last had focus, initially the first. ArrowLeft and ArrowRight move with
 * wrap, Home and End go to the ends; a key with Alt, Ctrl, Meta or Shift is left alone (the shell owns those). An
 * `aria-disabled` button is skipped by the arrows and holds no stop, but stays in the tree with its description.
 * The buttons sit inside tooltip anchors, so they are found by class, not as direct children.
 */
export interface IconToolbarFocus {
  ref: RefObject<HTMLDivElement | null>;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onFocus(event: FocusEvent<HTMLDivElement>): void;
}

export function useIconToolbar(): IconToolbarFocus {
  const ref = useRef<HTMLDivElement>(null);
  const stop = useRef<HTMLButtonElement | null>(null);
  const all = (): HTMLButtonElement[] => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button.d-icon-button') ?? []);
  const live = (): HTMLButtonElement[] => all().filter(b => b.getAttribute('aria-disabled') !== 'true');
  const apply = () => {
    const list = live();
    if (stop.current === null || !list.includes(stop.current)) stop.current = list[0] ?? null;
    for (const b of all()) b.tabIndex = b === stop.current ? 0 : -1;
  };
  // No dependency list: runs after every render, so a control that turns inert or is added is covered.
  useLayoutEffect(apply);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = live();
    const target: EventTarget = event.target;
    const from = target instanceof HTMLButtonElement ? list.indexOf(target) : -1;
    if (from < 0) return;
    const next = arrowIndex(event, from, list.length, 'horizontal');
    if (next === null) return;
    event.preventDefault();
    stop.current = list[next] ?? null;
    apply();
    stop.current?.focus();
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const target: EventTarget = event.target;
    if (target instanceof HTMLButtonElement && live().includes(target)) { stop.current = target; apply(); }
  };
  return { ref, onKeyDown, onFocus };
}
