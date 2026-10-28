import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';

/**
 * Ruling X's context-menu routes for an element (a voice row's person, a stage tile): a right-click, the ContextMenu key or
 * Shift+F10 (where both a keydown and a contextmenu arrive for one press, the menu opens once), and a touch held 500ms (the
 * click that ends it is swallowed, so it does not also act). `open` gets the element and where the menu should sit.
 * Without `open` the element gets no handlers.
 */
export function useContextMenuTrigger<T extends HTMLElement>(open: ((el: T, at: { x: number; y: number }) => void) | undefined) {
  const keyOpenedAt = useRef(-Infinity);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const swallowClick = useRef(false);
  useEffect(() => () => { if (press.current !== null) clearTimeout(press.current.timer); }, []);
  if (open === undefined) return {};
  const cancel = () => { if (press.current !== null) { clearTimeout(press.current.timer); press.current = null; } };
  return {
    onContextMenu: (e: MouseEvent<T>) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.timeStamp - keyOpenedAt.current < 500) return;
      open(e.currentTarget, { x: e.clientX, y: e.clientY });
    },
    onKeyDown: (e: KeyboardEvent<T>) => {
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
      e.preventDefault();
      e.stopPropagation();
      keyOpenedAt.current = e.timeStamp;
      const box = e.currentTarget.getBoundingClientRect();
      open(e.currentTarget, { x: box.left + 8, y: box.bottom });
    },
    onPointerDown: (e: PointerEvent<T>) => {
      swallowClick.current = false;
      if (e.pointerType !== 'touch') return;
      const el = e.currentTarget;
      const at = { x: e.clientX, y: e.clientY };
      cancel();
      press.current = { x: at.x, y: at.y, timer: setTimeout(() => {
        press.current = null;
        swallowClick.current = true;
        setTimeout(() => { swallowClick.current = false; }, 1000);
        open(el, at);
      }, 500) };
    },
    onPointerMove: (e: PointerEvent<T>) => {
      const p = press.current;
      if (p !== null && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (e: MouseEvent<T>) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
