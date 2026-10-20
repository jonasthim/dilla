import { useId, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { ActionMenu, type ActionMenuItem } from '../ActionMenu/ActionMenu.tsx';
import { Avatar } from '../Avatar/Avatar.tsx';
import { RoleDot } from '../internal/RoleDot.tsx';
import { hex } from '../internal/hex.ts';
import './MemberList.css';

export interface MemberListMember {
  id: string; name: string; tags: readonly string[]; actionsLabel: string; actions: readonly ActionMenuItem[];
  /** The colour of the member's top coloured role, 0xRRGGBB. Null or 0: no dot. The name keeps its token colour. */
  color?: number | null;
  presence?: 'online' | 'idle' | 'dnd' | 'offline';
}
export interface MemberListGroup {
  id: string;
  /** `role` is a hoisted role (the default), `online` and `offline` are the presence sections; offline rows are dimmed (R28). With a kind the heading reads `{title} — {n}`; without one the title is drawn as given (legacy callers that count themselves). */
  kind?: 'role' | 'online' | 'offline';
  /** The section's name; the heading reads `{title} — {n}`. */
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
  onAction(memberId: string, actionId: string): void;
}

interface OpenMenu { id: string; at: { x: number; y: number } | null }

/**
 * The members of a server, one section per group (an `h3` and a list of rows). A row with actions has an ActionMenu
 * trigger; a right-click opens the same menu at the pointer, and Shift+F10 or the ContextMenu key opens it at the
 * trigger. A row without actions has no trigger and no context menu.
 */
export function MemberList({ label, groups, loading, loadingLabel, emptyLabel, onAction }: MemberListProps) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const shown = groups.filter(g => g.members.length > 0);

  const onContextMenu = (m: MemberListMember, e: MouseEvent<HTMLLIElement>) => {
    if (m.actions.length === 0) return;
    e.preventDefault();
    // A contextmenu event from the keyboard has button -1 and no pointer: open at the trigger. (Chromium's mouse
    // right-click has button 2 and detail 0, so the click count says nothing.)
    const fromKeyboard = e.nativeEvent.button === -1;
    setMenu({ id: m.id, at: fromKeyboard ? null : { x: e.clientX, y: e.clientY } });
  };
  const onKeyDown = (m: MemberListMember, e: KeyboardEvent<HTMLLIElement>) => {
    if (m.actions.length === 0) return;
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
    e.preventDefault();
    setMenu({ id: m.id, at: null });
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
        <div key={group.id} className="d-member-list__group" data-kind={group.kind ?? 'role'}>
          <h3 className={`d-member-list__title${group.color ? ' d-member-list__title--colored' : ''}`}
            style={group.color ? { '--d-group-color': hex(group.color) } as CSSProperties : undefined}>{group.kind === undefined ? group.title : `${group.title} — ${String(group.members.length)}`}</h3>
          <ul className="d-member-list__rows" role="list">
            {group.members.map(m => (
              <li key={m.id} className="d-member-list__row" data-row="" onContextMenu={e => onContextMenu(m, e)} onKeyDown={e => onKeyDown(m, e)}>
                {/* The name is the row's own text, so the avatar is decorative; the presence is read as a word. */}
                <span className="d-member-list__avatar" aria-hidden="true"><Avatar name={m.name} size="row" presence={m.presence} /></span>
                {m.presence ? <span className="d-sr-only">{({ online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', offline: 'Offline' } as const)[m.presence]}</span> : null}
                <span className="d-member-list__text">
                  <span className="d-member-list__line1">
                    <span className="d-member-list__name">{m.name}</span>
                    {/* After the name, so every name in the list starts at one x (the layout grammar). */}
                    {m.color ? <RoleDot color={m.color} /> : null}
                    {m.tags.map(tag => <span key={tag} className="d-member-list__tag">{tag}</span>)}
                  </span>
                  {/* Line 2 is reserved for a custom status. */}
                  <span className="d-member-list__line2" aria-hidden="true" />
                </span>
                {m.actions.length > 0 ? (
                  <ActionMenu label={m.actionsLabel} items={m.actions} focusKey={`member:${m.id}`} open={menu?.id === m.id} at={menu?.id === m.id ? menu.at : null}
                    onOpenChange={open => setMenu(open ? { id: m.id, at: null } : cur => (cur?.id === m.id ? null : cur))}
                    onSelect={id => onAction(m.id, id)} />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Root>
  );
}
