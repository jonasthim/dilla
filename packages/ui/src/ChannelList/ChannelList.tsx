import { useId, useLayoutEffect, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
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
  /** Rendered right-aligned in the list's own header row (a "+" for a new channel): inside the tab panel, above the rows
   *  and outside their roving group (web3.8, item 11). */
  listAction?: ReactNode;
  /**
   * With it, every voice channel is a VoiceChannelRow in its place among the others: its people (by channel id; absent
   * is nobody) under the row. `labels.join` is `voice.join`; with `onJoin` and `labels.join` a row that is neither `joined` nor `held`
   * shows a join button while it is hovered or focused, which follows the row's tab index.
   */
  voice?: {
    labels: VoiceChannelRowProps['labels'] & { join?: string };
    rooms: Readonly<Record<string, { joined: boolean; held?: boolean; participants: readonly VoiceParticipantView[] }>>;
    onJoin?(id: string): void;
  };
}

/** One voice row of the list with its join button, which has its own place in the row's line (it never covers the row's
 *  count or focus ring) and is described by the channel's name, so a list of buttons tells them apart. */
function VoiceItem({ id, name, current, readable, room, voice, onOpen }: {
  id: string; name: string; current: boolean; readable: boolean; room: { joined: boolean; held?: boolean; participants: readonly VoiceParticipantView[] } | undefined;
  voice: NonNullable<ChannelListProps['voice']>; onOpen(): void;
}) {
  const nameId = useId();
  const joined = room?.joined ?? false;
  return (
    <li className="d-channel-list__voice" data-joined={joined ? 'true' : undefined}>
      <VoiceChannelRow name={name} current={current} joined={joined} participants={room?.participants ?? []}
        readable={readable} labels={voice.labels} onOpen={onOpen} />
      {voice.onJoin === undefined || voice.labels.join === undefined || joined || room?.held === true ? null : (
        <>
          <span id={nameId} hidden>{name}</span>
          <Button variant="ghost" size="sm" className="d-channel-list__join" tabIndex={-1} aria-describedby={nameId}
            onClick={() => voice.onJoin?.(id)}>{voice.labels.join}</Button>
        </>
      )}
    </li>
  );
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
export function ChannelList({ label, title, channels, activeId, onSelect, emptyLabel, rowLabel, tabs, footer, content, voice, listAction, actions, actionsLabel, headerAction, titleKind = 'server' }: ChannelListProps) {
  const activeIndex = channels.findIndex(c => c.id === activeId);
  const roving = useRovingFocus(activeIndex);
  // A voice row's join button holds the row's tab index: the stop row's join is a tab stop, no other is.
  const syncJoins = () => {
    for (const li of Array.from(roving.ref.current?.children ?? [])) {
      const row = li.firstElementChild;
      const join = li.querySelector<HTMLButtonElement>(':scope > .d-channel-list__join');
      if (row instanceof HTMLButtonElement && join !== null) join.tabIndex = row.tabIndex;
    }
  };
  // Declared after the roving hook, so its placement has run when this does.
  useLayoutEffect(syncJoins);
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => { roving.onKeyDown(e); syncJoins(); };
  const onFocus = (e: FocusEvent<HTMLUListElement>) => { roving.onFocus(e); syncJoins(); };
  const body = content !== undefined ? content : channels.length === 0 ? (
    <p className="d-channel-list__empty">{emptyLabel}</p>
  ) : (
    <ul role="list" className="d-channel-list__list" ref={roving.ref} onKeyDown={onKeyDown} onFocus={onFocus}>
      {channels.map(c => {
        const unread = c.unread ?? 0;
        const mentions = c.mentions ?? 0;
        const muted = c.muted ?? false;
        const ariaLabel = rowLabel && (unread > 0 || mentions > 0 || muted) ? rowLabel({ name: c.badge === undefined ? c.name : `${c.name}, ${c.badge}`, unread, mentions, muted }) : undefined;
        if (c.kind === 'voice' && voice !== undefined) {
          const room = Object.hasOwn(voice.rooms, c.id) ? voice.rooms[c.id] : undefined;
          return (
            <VoiceItem key={c.id} id={c.id} name={c.name} current={c.id === activeId} readable={c.readable} room={room}
              voice={voice} onOpen={() => onSelect(c.id)} />
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
  const head = listAction !== undefined ? <div className="d-channel-list__list-head">{listAction}</div> : null;
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
          <div className="d-channel-list__panel" role="tabpanel" aria-label={label}>{head}{body}{foot}</div>
        </>
      ) : (
        <>{head}{body}{foot}</>
      )}
    </nav>
  );
}
