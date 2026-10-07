import { Pill } from '../Pill/Pill.tsx';
import { useRovingFocus } from '../internal/roving.ts';
import './CommunityRail.css';

export interface CommunityRailProps {
  label: string;
  items: readonly { id: string; name: string; unread?: number; mentions?: number }[];
  activeId: string | null;
  onSelect(id: string): void;
  joinLabel: string;
  onJoin(): void;
  settingsLabel?: string;
  onSettings?(): void;
  itemLabel?(i: { name: string; unread: number; mentions: number }): string;
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
 * (the initials are decoration), a "join" tile and, when given, the settings
 * button last. A tile with unread messages or mentions carries a pill at its
 * corner and is named by `itemLabel` when one is given. One tab stop with
 * roving focus over every tile, the settings button included (Global
 * Constraints keyboard map).
 */
export function CommunityRail({ label, items, activeId, onSelect, joinLabel, onJoin, settingsLabel, onSettings, itemLabel }: CommunityRailProps) {
  const activeIndex = items.findIndex(i => i.id === activeId);
  const roving = useRovingFocus(activeIndex);
  return (
    <nav className="d-community-rail" aria-label={label}>
      <ul role="list" className="d-community-rail__list" ref={roving.ref} onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
        {items.map(item => {
          const unread = item.unread ?? 0;
          const mentions = item.mentions ?? 0;
          const ariaLabel = itemLabel && (unread > 0 || mentions > 0) ? itemLabel({ name: item.name, unread, mentions }) : undefined;
          return (
            <li key={item.id}>
              <button type="button" className="d-community-rail__item" aria-current={item.id === activeId ? 'page' : undefined}
                data-unread={String(unread)} data-mentions={String(mentions)} aria-label={ariaLabel} onClick={() => onSelect(item.id)}>
                <span className="d-community-rail__initials" aria-hidden="true">{initials(item.name)}</span>
                <span className="d-sr-only">{item.name}</span>
                {mentions > 0 ? <span className="d-community-rail__badge"><Pill kind="mention" count={mentions} /></span>
                  : unread > 0 ? <span className="d-community-rail__badge"><Pill kind="unread" count={unread} /></span> : null}
              </button>
            </li>
          );
        })}
        <li>
          <button type="button" className="d-community-rail__join" aria-label={joinLabel} onClick={onJoin}><span aria-hidden="true">+</span></button>
        </li>
        {settingsLabel !== undefined && onSettings !== undefined ? (
          <li className="d-community-rail__settings-item">
            <button type="button" className="d-community-rail__settings" aria-label={settingsLabel} onClick={onSettings}>
              <svg className="d-community-rail__cog" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
                <path fillRule="evenodd" clipRule="evenodd" d="M9.4 1.4l.25 1.5c.5.15.95.35 1.4.6l1.25-.85 1.55 1.55-.85 1.25c.25.45.45.9.6 1.4l1.5.25v2.2l-1.5.25c-.15.5-.35.95-.6 1.4l.85 1.25-1.55 1.55-1.25-.85c-.45.25-.9.45-1.4.6l-.25 1.5H6.6l-.25-1.5c-.5-.15-.95-.35-1.4-.6l-1.25.85-1.55-1.55.85-1.25c-.25-.45-.45-.9-.6-1.4l-1.5-.25v-2.2l1.5-.25c.15-.5.35-.95.6-1.4L2.15 4.45 3.7 2.9l1.25.85c.45-.25.9-.45 1.4-.6l.25-1.5h2.8zM8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z" />
              </svg>
            </button>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
