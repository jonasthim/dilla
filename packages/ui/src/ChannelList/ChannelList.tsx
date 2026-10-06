import type { ReactNode } from 'react';
import { ChannelRow } from '../ChannelRow/ChannelRow.tsx';
import { useRovingFocus } from '../internal/roving.ts';
import './ChannelList.css';

export interface ChannelListProps {
  label: string;
  title: string;
  channels: readonly { id: string; name: string; kind: 'text' | 'voice' | 'dm'; readable: boolean; unread?: number; mentions?: number; muted?: boolean }[];
  activeId: string | null;
  onSelect(id: string): void;
  emptyLabel: string;
  rowLabel?(c: { name: string; unread: number; mentions: number; muted: boolean }): string;
  tabs?: ReactNode;
  footer?: ReactNode;
}

/**
 * The sidebar: the server name as the shell's <h1> (pre-flight ruling (e)), in
 * serif italic and never case-transformed, then the channels as the existing
 * ChannelRow buttons. One tab stop with roving focus. A row with something to
 * report (an unread count, mentions, or muted) is named by `rowLabel` when one
 * is given; a quiet row keeps its bare name. With `tabs`, the tabs sit between
 * the heading and a tab panel named like the list; an optional footer ends the
 * list, outside the roving group.
 */
export function ChannelList({ label, title, channels, activeId, onSelect, emptyLabel, rowLabel, tabs, footer }: ChannelListProps) {
  const activeIndex = channels.findIndex(c => c.id === activeId);
  const roving = useRovingFocus(activeIndex);
  const body = channels.length === 0 ? (
    <p className="d-channel-list__empty">{emptyLabel}</p>
  ) : (
    <ul role="list" className="d-channel-list__list" ref={roving.ref} onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
      {channels.map(c => {
        const unread = c.unread ?? 0;
        const mentions = c.mentions ?? 0;
        const muted = c.muted ?? false;
        const ariaLabel = rowLabel && (unread > 0 || mentions > 0 || muted) ? rowLabel({ name: c.name, unread, mentions, muted }) : undefined;
        return (
          <li key={c.id}>
            <ChannelRow name={c.name} kind={c.kind} readable={c.readable} active={c.id === activeId}
              unread={unread} mentions={mentions} muted={muted} ariaLabel={ariaLabel} onSelect={() => onSelect(c.id)} />
          </li>
        );
      })}
    </ul>
  );
  const foot = footer !== undefined ? <div className="d-channel-list__footer">{footer}</div> : null;
  return (
    <nav className="d-channel-list" aria-label={label}>
      <h1 className="d-channel-list__title">{title}</h1>
      {tabs !== undefined ? (
        <>
          {tabs}
          <div className="d-channel-list__panel" role="tabpanel" aria-label={label}>{body}{foot}</div>
        </>
      ) : (
        <>{body}{foot}</>
      )}
    </nav>
  );
}
