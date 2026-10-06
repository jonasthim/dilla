import { useRef, type KeyboardEvent } from 'react';
import { Pill } from '../Pill/Pill.tsx';
import { arrowIndex } from '../internal/arrow-select.ts';
import './SidebarTabs.css';

export interface SidebarTabsProps {
  label: string;
  tabs: readonly { id: string; label: string; count?: number; mentions?: number }[];
  activeId: string;
  onSelect(id: string): void;
}

/**
 * The sidebar's channels / direct messages switch, the Mesh tabs. One tab stop, on the selected tab
 * (the first when none matches); ArrowLeft and ArrowRight move between the tabs, wrapping, and Home
 * and End go to the ends. Selection follows focus (the APG automatic-activation pattern), so the
 * panel shows at once. A tab with mentions shows a mention pill, else one with a count an unread
 * pill, else none.
 */
export function SidebarTabs({ label, tabs, activeId, onSelect }: SidebarTabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = tabs.findIndex(t => t.id === activeId);
  const stop = activeIndex >= 0 ? activeIndex : 0;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target: EventTarget = event.target;
    const from = refs.current.findIndex(el => el !== null && el === target);
    if (from < 0) return;
    const next = arrowIndex(event, from, tabs.length, 'horizontal');
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
    const id = tabs[next].id;
    if (id !== activeId) onSelect(id);
  };

  return (
    <div className="d-sidebar-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t, i) => (
        <button key={t.id} ref={el => { refs.current[i] = el; }} type="button" role="tab" className="d-sidebar-tabs__tab"
          aria-selected={t.id === activeId} tabIndex={i === stop ? 0 : -1}
          data-count={String(t.count ?? 0)} data-mentions={String(t.mentions ?? 0)} onClick={() => onSelect(t.id)}>
          <span className="d-sidebar-tabs__label">{t.label}</span>
          {(t.mentions ?? 0) > 0 ? <Pill kind="mention" count={t.mentions ?? 0} /> : (t.count ?? 0) > 0 ? <Pill kind="unread" count={t.count ?? 0} /> : null}
        </button>
      ))}
    </div>
  );
}
