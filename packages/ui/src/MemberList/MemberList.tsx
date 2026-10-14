import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ActionMenu, type ActionMenuItem } from '../ActionMenu/ActionMenu.tsx';
import './MemberList.css';

export interface MemberListMember { id: string; name: string; tags: readonly string[]; actionsLabel: string; actions: readonly ActionMenuItem[] }
export interface MemberListGroup { id: string; title: string; members: readonly MemberListMember[] }
export interface MemberListProps {
  label: string;
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

  return (
    <section className="d-member-list" aria-label={label}>
      {loading ? (
        <p className="d-member-list__note" role="status">{loadingLabel}</p>
      ) : shown.length === 0 ? (
        <p className="d-member-list__note">{emptyLabel}</p>
      ) : shown.map(group => (
        <div key={group.id} className="d-member-list__group">
          <h3 className="d-member-list__title">{group.title}</h3>
          <ul className="d-member-list__rows" role="list">
            {group.members.map(m => (
              <li key={m.id} className="d-member-list__row" onContextMenu={e => onContextMenu(m, e)} onKeyDown={e => onKeyDown(m, e)}>
                <span className="d-member-list__name">{m.name}</span>
                {m.tags.map(tag => <span key={tag} className="d-member-list__tag">{tag}</span>)}
                {m.actions.length > 0 ? (
                  <ActionMenu label={m.actionsLabel} items={m.actions} open={menu?.id === m.id} at={menu?.id === m.id ? menu.at : null}
                    onOpenChange={open => setMenu(open ? { id: m.id, at: null } : cur => (cur?.id === m.id ? null : cur))}
                    onSelect={id => onAction(m.id, id)} />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
