import type { ReactNode } from 'react';
import { ChannelRow } from '../ChannelRow/ChannelRow.tsx';
import { VoiceChannelRow, type VoiceChannelRowProps } from '../VoiceChannelRow/VoiceChannelRow.tsx';
import type { VoiceParticipantView } from '../CallTile/CallTile.tsx';
import { useRovingFocus } from '../internal/roving.ts';
import './ChannelList.css';

export interface ChannelListProps {
  label: string;
  title: string;
  /** 'server' (default) sets the title in the display serif, which is only for the server name. 'plain' (a list's own heading, such as direct messages) is the mono heading style. */
  titleKind?: 'server' | 'plain';
  channels: readonly { id: string; name: string; kind: 'text' | 'voice' | 'dm' | 'announcement'; readable: boolean; unread?: number; mentions?: number; muted?: boolean; badge?: string }[];
  activeId: string | null;
  onSelect(id: string): void;
  emptyLabel: string;
  rowLabel?(c: { name: string; unread: number; mentions: number; muted: boolean }): string;
  tabs?: ReactNode;
  footer?: ReactNode;
  /** The server's own actions (a new channel, an invite link), a group named `actionsLabel` beside the heading, before the
   *  tabs and outside the rows' roving group (flow 07). */
  actions?: ReactNode;
  actionsLabel?: string;
  /** A control at the right of the server's name (the phone's server menu), in one row with the heading. */
  headerAction?: ReactNode;
  /** Shown in place of the rows (and the empty label), inside the tab panel when there are tabs: a server that did
   *  not load, or no server at all, while the tabs stay (WORKER-WEB-02, A11Y-DESIGN-02). */
  content?: ReactNode;
  /** With it, every voice channel is a VoiceChannelRow: its people (by channel id; absent is nobody) under the row. */
  voice?: {
    labels: VoiceChannelRowProps['labels'];
    rooms: Readonly<Record<string, { joined: boolean; participants: readonly VoiceParticipantView[] }>>;
  };
}

/**
 * The sidebar: the server name as the shell's <h1> (pre-flight ruling (e)), in
 * serif italic and never case-transformed, then the channels as the existing
 * ChannelRow buttons. One tab stop with roving focus. A row with something to
 * report (an unread count, mentions, or muted) is named by `rowLabel` when one
 * is given; a quiet row keeps its bare name. With `tabs`, the tabs sit between
 * the heading and a tab panel named like the list; an optional footer ends the
 * list, outside the roving group. `content`, when given, stands in place of the
 * rows inside the panel. With `voice`, a voice channel is a VoiceChannelRow with its people below it, still one
 * stop of the same roving group.
 */
export function ChannelList({ label, title, channels, activeId, onSelect, emptyLabel, rowLabel, tabs, footer, content, voice, actions, actionsLabel, headerAction, titleKind = 'server' }: ChannelListProps) {
  const activeIndex = channels.findIndex(c => c.id === activeId);
  const roving = useRovingFocus(activeIndex);
  const body = content !== undefined ? content : channels.length === 0 ? (
    <p className="d-channel-list__empty">{emptyLabel}</p>
  ) : (
    <ul role="list" className="d-channel-list__list" ref={roving.ref} onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
      {channels.map(c => {
        const unread = c.unread ?? 0;
        const mentions = c.mentions ?? 0;
        const muted = c.muted ?? false;
        const ariaLabel = rowLabel && (unread > 0 || mentions > 0 || muted) ? rowLabel({ name: c.badge === undefined ? c.name : `${c.name}, ${c.badge}`, unread, mentions, muted }) : undefined;
        if (c.kind === 'voice' && voice !== undefined) {
          const room = Object.hasOwn(voice.rooms, c.id) ? voice.rooms[c.id] : undefined;
          return (
            <li key={c.id}>
              <VoiceChannelRow name={c.name} current={c.id === activeId} joined={room?.joined ?? false} participants={room?.participants ?? []}
                readable={c.readable}
                labels={voice.labels} onOpen={() => onSelect(c.id)} />
            </li>
          );
        }
        return (
          <li key={c.id}>
            <ChannelRow name={c.name} kind={c.kind} readable={c.readable} active={c.id === activeId}
              unread={unread} mentions={mentions} muted={muted} badge={c.badge} ariaLabel={ariaLabel} onSelect={() => onSelect(c.id)} />
          </li>
        );
      })}
    </ul>
  );
  const foot = footer !== undefined ? <div className="d-channel-list__footer">{footer}</div> : null;
  return (
    <nav className="d-channel-list" aria-label={label}>
      {headerAction !== undefined ? (
        <div className="d-channel-list__head"><h1 className="d-channel-list__title" data-kind={titleKind === 'plain' ? 'plain' : undefined}>{title}</h1>{headerAction}</div>
      ) : <h1 className="d-channel-list__title" data-kind={titleKind === 'plain' ? 'plain' : undefined}>{title}</h1>}
      {actions !== undefined ? <div className="d-channel-list__actions" role="group" aria-label={actionsLabel}>{actions}</div> : null}
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
