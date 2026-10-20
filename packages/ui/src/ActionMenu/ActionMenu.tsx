import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../Icon/Icon.tsx';
import './ActionMenu.css';

export interface ActionMenuItem { id: string; label: string; danger?: boolean; /** The item that is the current choice (`aria-current`). */ current?: boolean }

export interface ActionMenuProps {
  /** The trigger's accessible name and the menu's (`actions for Astrid`). */
  label: string;
  items: readonly ActionMenuItem[];
  open: boolean;
  onOpenChange(open: boolean): void;
  onSelect(id: string): void;
  /** Where the popup sits when it was opened by a context menu: the pointer, clamped to the viewport. */
  at?: { x: number; y: number } | null;
  /**
   * A stable key for the trigger (`data-focus-key`): a Dialog opened from this menu finds the trigger by it on close,
   * even when the row was re-mounted meanwhile.
   */
  focusKey?: string;
  /** A monoline icon on the trigger in place of the "⋯" glyph. */
  icon?: IconName;
  /** The trigger's content in place of the icon or glyph (the user panel's avatar and name block). The trigger is still one button named by `label`. */
  triggerContent?: ReactNode;
  /** Extra classes on the wrapper and on the trigger, for a caller that lays the trigger out itself. */
  className?: string;
  triggerClassName?: string;
}

/**
 * A WAI-ARIA menu button. Enter, Space or ArrowDown on the trigger opens the menu on its first item; ArrowUp opens it
 * on the last. Arrows wrap, Home and End jump. Escape closes and refocuses the trigger, Tab closes and moves on, and a
 * pointerdown outside closes. `open` is the caller's, so a row can also open the menu from a context menu (`at`).
 */
export function ActionMenu({ label, items, open, onOpenChange, onSelect, at, focusKey, icon, triggerContent, className, triggerClassName }: ActionMenuProps) {
  const base = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const startAt = useRef<'first' | 'last'>('first');
  const [clamped, setClamped] = useState<{ x: number; y: number } | null>(null);
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom');

  // Focus goes to the first item (the last after ArrowUp) every time the menu opens.
  useEffect(() => {
    if (!open) return;
    const list = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!list || list.length === 0) return;
    (startAt.current === 'last' ? list[list.length - 1] : list[0])?.focus();
    startAt.current = 'first';
  }, [open]);

  // The pointer position, kept inside the popup's containing block once the popup's size is known. A fixed popup is
  // placed against the viewport, except inside the app shell, which is a size container and so its containing block:
  // there the position is relative to the shell's corner and clamped to the shell.
  useLayoutEffect(() => {
    if (!open || !at) { setClamped(null); return; }
    const w = menuRef.current?.offsetWidth ?? 0;
    const h = menuRef.current?.offsetHeight ?? 0;
    const shell = rootRef.current?.closest('.d-app-shell')?.getBoundingClientRect();
    const box = shell ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    setClamped({
      x: Math.max(0, Math.min(at.x - box.left, box.width - w)),
      y: Math.max(0, Math.min(at.y - box.top, box.height - h)),
    });
  }, [open, at]);

  // Without `at` the popup hangs under the trigger, or above it when the trigger is in the bottom half of its nearest
  // scrollable ancestor (the viewport when there is none).
  useLayoutEffect(() => {
    if (!open || at || !triggerRef.current) return;
    let scroller: Element | null = triggerRef.current.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const area = scroller?.getBoundingClientRect() ?? { top: 0, height: window.innerHeight };
    const t = triggerRef.current.getBoundingClientRect();
    setPlacement(t.top + t.height / 2 > area.top + area.height / 2 ? 'top' : 'bottom');
  }, [open, at]);

  // A pointerdown anywhere outside the trigger and the popup closes the menu.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      onOpenChange(false);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [open, onOpenChange]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      startAt.current = e.key === 'ArrowUp' ? 'last' : 'first';
      onOpenChange(true);
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at0 = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); list[(i + list.length) % list.length]?.focus(); };
    switch (e.key) {
      case 'ArrowDown': go(at0 + 1); break;
      case 'ArrowUp': go(at0 < 0 ? list.length - 1 : at0 - 1); break;
      case 'Home': go(0); break;
      case 'End': go(list.length - 1); break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        onOpenChange(false);
        triggerRef.current?.focus();
        break;
      case 'Tab':
        // Focus goes to the trigger first, so the browser's Tab moves on from there rather than into the popup.
        triggerRef.current?.focus();
        onOpenChange(false);
        break;
    }
  };

  const select = (id: string) => {
    onOpenChange(false);
    triggerRef.current?.focus();
    onSelect(id);
  };

  const style = at
    ? { position: 'fixed' as const, left: `${clamped?.x ?? at.x}px`, top: `${clamped?.y ?? at.y}px` }
    : undefined;

  return (
    <span ref={rootRef} className={className === undefined ? 'd-action-menu' : `d-action-menu ${className}`}>
      <button ref={triggerRef} type="button" className={triggerClassName === undefined ? 'd-action-menu__trigger' : `d-action-menu__trigger ${triggerClassName}`} aria-label={label} aria-haspopup="menu" data-focus-key={focusKey}
        aria-expanded={open} aria-controls={open ? `${base}-menu` : undefined}
        onClick={() => onOpenChange(!open)} onKeyDown={onTriggerKey}>
        {triggerContent ?? (icon !== undefined ? <Icon name={icon} size={22} /> : <span aria-hidden="true">⋯</span>)}
      </button>
      {open ? (
        <div ref={menuRef} id={`${base}-menu`} role="menu" aria-label={label} className="d-action-menu__popup" style={style} data-placement={at ? undefined : placement}
          onKeyDown={onMenuKey}>
          {items.map(item => (
            <button key={item.id} type="button" role="menuitem" tabIndex={-1} className="d-action-menu__item"
              data-danger={item.danger ? 'true' : undefined} aria-current={item.current ? 'true' : undefined} onClick={() => select(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
