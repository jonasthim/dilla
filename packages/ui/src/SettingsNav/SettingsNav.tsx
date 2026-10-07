import { useRovingFocus } from '../internal/roving.ts';
import './SettingsNav.css';

export interface SettingsNavProps {
  label: string;
  items: readonly { id: string; label: string }[];
  activeId: string;
  onSelect(id: string): void;
}

/**
 * The section list of Settings: one tab stop with roving focus (ArrowUp/ArrowDown, Home/End move
 * focus without selecting); Enter, Space and a click select. The current section is the page.
 */
export function SettingsNav({ label, items, activeId, onSelect }: SettingsNavProps) {
  const activeIndex = items.findIndex(i => i.id === activeId);
  const roving = useRovingFocus(activeIndex);
  return (
    <nav className="d-settings-nav" aria-label={label}>
      <ul role="list" className="d-settings-nav__list" ref={roving.ref} onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
        {items.map(i => (
          <li key={i.id}>
            <button type="button" className="d-settings-nav__item" aria-current={i.id === activeId ? 'page' : undefined} onClick={() => onSelect(i.id)}>{i.label}</button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
