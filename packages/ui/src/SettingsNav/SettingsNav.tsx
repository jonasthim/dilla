import { Icon, type IconName } from '../Icon/Icon.tsx';
import { useRovingFocus } from '../internal/roving.ts';
import './SettingsNav.css';

export interface SettingsNavProps {
  label: string;
  /** `icon` draws a 16px glyph in the glyph column; when any item has one, the others keep the empty column so the names align. */
  items: readonly { id: string; label: string; icon?: IconName }[];
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
  const glyphs = items.some(i => i.icon);
  return (
    <nav className="d-settings-nav" aria-label={label}>
      <ul role="list" className="d-settings-nav__list" ref={roving.ref} onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
        {items.map(i => (
          <li key={i.id}>
            <button type="button" className="d-settings-nav__item" aria-current={i.id === activeId ? 'page' : undefined} onClick={() => onSelect(i.id)}>
              {glyphs ? <span className="d-settings-nav__glyph">{i.icon ? <Icon name={i.icon} size={16} /> : null}</span> : null}
              {i.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
