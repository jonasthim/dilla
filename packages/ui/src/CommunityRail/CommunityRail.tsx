import { useRovingFocus } from '../internal/roving.ts';
import './CommunityRail.css';

export interface CommunityRailProps {
  label: string;
  items: readonly { id: string; name: string }[];
  activeId: string | null;
  onSelect(id: string): void;
  joinLabel: string;
  onJoin(): void;
}

/** The tile's initials, by the rule Avatar uses: two words → their first letters, else the first two letters. */
function initials(name: string): string {
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/);
  const raw = parts.length >= 2 ? `${parts[0].charAt(0)}${parts[1].charAt(0)}` : trimmed.slice(0, 2);
  return raw.toUpperCase();
}

/**
 * The server rail: one square tile per server, named by the server's full name
 * (the initials are decoration), and a last "join" tile. One tab stop with
 * roving focus (Global Constraints keyboard map).
 */
export function CommunityRail({ label, items, activeId, onSelect, joinLabel, onJoin }: CommunityRailProps) {
  const activeIndex = items.findIndex(i => i.id === activeId);
  const roving = useRovingFocus(activeIndex);
  return (
    <nav className="d-community-rail" aria-label={label}>
      <ul role="list" className="d-community-rail__list" ref={roving.ref} onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
        {items.map(item => (
          <li key={item.id}>
            <button type="button" className="d-community-rail__item" aria-current={item.id === activeId ? 'page' : undefined} onClick={() => onSelect(item.id)}>
              <span className="d-community-rail__initials" aria-hidden="true">{initials(item.name)}</span>
              <span className="d-sr-only">{item.name}</span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" className="d-community-rail__join" aria-label={joinLabel} onClick={onJoin}><span aria-hidden="true">+</span></button>
        </li>
      </ul>
    </nav>
  );
}
