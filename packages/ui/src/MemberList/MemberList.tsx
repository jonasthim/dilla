import { useId, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import type { ActionMenuItem } from '../ActionMenu/ActionMenu.tsx';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { hex } from '../internal/hex.ts';
import { PRESENCE_WORD } from '../internal/presenceWord.ts';
import { roleNameColor, useThemeName } from '../internal/roleColor.ts';
import './MemberList.css';

export interface MemberListMember {
  id: string; name: string;
  /** The member owns the server: a crown after the name, and the word `ownerLabel` for screen readers. */
  isOwner?: boolean;
  /** A bot keeps a small tag (`botLabel`) after its name, as in Discord; no other tag is drawn. */
  isBot?: boolean;
  /** A custom status, drawn as line 2. Without one the row has a single line and the name is centred in it. */
  status?: string;
  /** @deprecated The row draws no tags any more: the owner has a crown and "you" lives in the profile card. Ignored. */
  tags?: readonly string[];
  /** @deprecated The row has no action menu any more: the actions live in the profile card. Ignored. */
  actionsLabel?: string;
  /** @deprecated See `actionsLabel`. Ignored. */
  actions?: readonly ActionMenuItem[];
  /** The colour of the member's top coloured role, 0xRRGGBB. Null or 0: none. The name takes it when it keeps 4.5:1 in the current theme, else the text token. */
  color?: number | null;
  presence?: 'online' | 'idle' | 'dnd' | 'offline';
}
export interface MemberListGroup {
  id: string;
  /** `role` is a hoisted role, `online` and `offline` are the presence sections; offline rows are dimmed (R28). */
  kind: 'role' | 'online' | 'offline';
  /** The section's raw name; the heading reads `{title} — {n}`, the count is drawn here. */
  title: string;
  color?: number | null;
  members: readonly MemberListMember[];
}
export interface MemberListProps {
  /** The region's name, drawn as the list's 48 bar. Left out inside a landmark that already names the list (the shell's aside): a plain container with no bar. */
  label?: string;
  groups: readonly MemberListGroup[];
  loading: boolean;
  loadingLabel: string;
  emptyLabel: string;
  /** The word read after an owner's name (the crown itself is decorative). Default `owner`. */
  ownerLabel?: string;
  /** The word of a bot's tag. Default `bot`. */
  botLabel?: string;
  /** The member whose card is open, if any: that row's button reports `aria-expanded`. */
  openId?: string | null;
  /** `via` is `click` for a primary pointer click and `menu` for Enter, a right-click, Shift+F10 and the ContextMenu key: a caller that toggles closes only on `click`.
   * A click or Enter on a row, a right-click and Shift+F10 or the ContextMenu key: open that member's profile card beside `anchor`, the row's button. */
  onOpen?(memberId: string, anchor: HTMLElement, via: 'click' | 'menu'): void;
  /** @deprecated The row has no action menu any more; the profile card reports its actions. Ignored. */
  onAction?(memberId: string, actionId: string): void;
}


/**
 * The members of a server, one section per group (an `h3` and a list of rows). Each row is one button, so Enter and a
 * click open the member's profile card; a right-click, Shift+F10 and the ContextMenu key open it too. The name is
 * centred in the row while there is no status line, and drawn in the member's role colour when that is readable.
 */
export function MemberList({ label, groups, loading, loadingLabel, emptyLabel, ownerLabel = 'owner', botLabel = 'bot', openId = null, onOpen }: MemberListProps) {
  const shown = groups.filter(g => g.members.length > 0);
  const theme = useThemeName();

  // Where the platform sends both a keydown and a contextmenu for one Shift+F10, the card opens once.
  const keyOpenedAt = useRef(-Infinity);
  const openFrom = (m: MemberListMember, row: HTMLElement) => {
    const button = row.querySelector<HTMLElement>('.d-member-list__open');
    if (button !== null) onOpen?.(m.id, button, 'menu');
  };
  const onContextMenu = (m: MemberListMember, e: MouseEvent<HTMLLIElement>) => {
    if (onOpen === undefined) return;
    e.preventDefault();
    if (e.timeStamp - keyOpenedAt.current < 500) return;
    openFrom(m, e.currentTarget);
  };
  const onKeyDown = (m: MemberListMember, e: KeyboardEvent<HTMLLIElement>) => {
    if (onOpen === undefined) return;
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
    e.preventDefault();
    keyOpenedAt.current = e.timeStamp;
    openFrom(m, e.currentTarget);
  };

  const Root = label === undefined ? 'div' : 'section';
  const barId = useId();
  return (
    <Root className="d-member-list" aria-labelledby={label === undefined ? undefined : barId}>
      {label !== undefined ? <h2 id={barId} className="d-member-list__bar">{label}</h2> : null}
      {loading ? (
        <p className="d-member-list__note" role="status">{loadingLabel}</p>
      ) : shown.length === 0 ? (
        <p className="d-member-list__note">{emptyLabel}</p>
      ) : shown.map(group => (
        <div key={group.id} className="d-member-list__group" data-kind={group.kind}>
          <h3 className={`d-member-list__title${group.color ? ' d-member-list__title--colored' : ''}`}
            style={group.color ? { '--d-group-color': hex(group.color) } as CSSProperties : undefined}>{`${group.title} — ${String(group.members.length)}`}</h3>
          <ul className="d-member-list__rows" role="list">
            {group.members.map(m => {
              const tint = roleNameColor(m.color, theme, group.kind === 'offline' ? 0.8 : 1);
              return (
                <li key={m.id} className="d-member-list__row" data-row="" onContextMenu={e => onContextMenu(m, e)} onKeyDown={e => onKeyDown(m, e)}>
                  <button type="button" className="d-member-list__open" data-focus-key={`member:${m.id}`} aria-haspopup="dialog" aria-expanded={openId === m.id} onClick={e => onOpen?.(m.id, e.currentTarget, e.detail > 0 ? 'click' : 'menu')}>
                    {/* The name is the button's own text, so the avatar is decorative; the presence is read as a word. */}
                    <span className="d-member-list__avatar" aria-hidden="true"><Avatar name={m.name} size="row" presence={m.presence} /></span>
                    {m.presence ? <span className="d-sr-only">{PRESENCE_WORD[m.presence]}</span> : null}
                    <span className="d-member-list__text">
                      <span className="d-member-list__line1">
                        <span className="d-member-list__name" style={tint === null ? undefined : { color: tint }}>{m.name}</span>
                        {m.isOwner ? <><span className="d-member-list__crown"><Icon name="crown" size={14} /></span><span className="d-sr-only">{ownerLabel}</span></> : null}
                        {m.isBot ? <span className="d-member-list__bot">{botLabel}</span> : null}
                      </span>
                      {m.status ? <span className="d-member-list__line2">{m.status}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </Root>
  );
}
