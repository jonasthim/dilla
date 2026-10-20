import { useId, useLayoutEffect, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import { ChannelRow } from '../ChannelRow/ChannelRow.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';
import { TrailingSlot } from '../TrailingSlot/TrailingSlot.tsx';
import { VoiceChannelRow, type VoiceChannelRowProps } from '../VoiceChannelRow/VoiceChannelRow.tsx';
import type { VoiceParticipantView } from '../CallTile/CallTile.tsx';
import { useRovingFocus } from '../internal/roving.ts';
import './ChannelList.css';

export interface ChannelListChannel {
  id: string; name: string; kind: 'text' | 'voice' | 'dm' | 'announcement'; readable: boolean; unread?: number; mentions?: number; muted?: boolean; badge?: string;
  /** The category this channel sits in; absent, null or an unknown id is top level. */
  parentId?: string | null;
  /** This device is in this voice channel (a collapsed category keeps the row, R23). */
  joined?: boolean;
  /** The built-in AFK channel. */
  afk?: boolean;
}

export interface ChannelListProps {
  label: string;
  title: string;
  /** 'server' (default) sets the title in the display serif, which is only for the server name. 'plain' (a list's own heading, such as direct messages) is the mono heading style. */
  titleKind?: 'server' | 'plain';
  channels: readonly ChannelListChannel[];
  /** The categories in display order. The uncategorised rows come first, then each category's header and its children. */
  categories?: readonly { id: string; name: string; collapsed: boolean }[];
  /** A header is a button; Enter or a click on it asks to fold or unfold the category. */
  onToggleCategory?(id: string): void;
  /** With it, each category header has a trailing "+" named `addInCategoryLabel(name)` (`layout.category.add`). */
  onAddInCategory?(id: string): void;
  addInCategoryLabel?(name: string): string;
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
  /** @deprecated removed in WEB-LIST. The lone list-header "+" row (A1) is replaced by each category header's "+" (`onAddInCategory`); rendered only while a caller still passes it. */
  listAction?: ReactNode;
  /**
   * With it, every voice channel is a VoiceChannelRow in its place among the others: its people (by channel id; absent
   * is nobody) under the row. `labels.join` (required) is `voice.join`; with `onJoin` a row that is neither `joined` nor `held`
   * has a join icon in its trailing slot, which follows the row's tab index.
   */
  voice?: {
    labels: VoiceChannelRowProps['labels'];
    /** The join is an icon button in the row's trailing slot. Without it the legacy text button is drawn (@deprecated, removed in WEB-LIST). */
    iconJoin?: boolean;
    rooms: Readonly<Record<string, { joined: boolean; held?: boolean; participants: readonly VoiceParticipantView[] }>>;
    onJoin?(id: string): void;
  };
}

/** @deprecated removed in WEB-LIST. The web3.8 voice row: a text join button beside the row, described by the channel's name. */
function LegacyVoiceItem({ id, name, current, readable, room, voice, onOpen }: {
  id: string; name: string; current: boolean; readable: boolean; room: { joined: boolean; held?: boolean; participants: readonly VoiceParticipantView[] } | undefined;
  voice: NonNullable<ChannelListProps['voice']>; onOpen(): void;
}) {
  const nameId = useId();
  const joined = room?.joined ?? false;
  return (
    <li className="d-channel-list__voice" data-joined={joined ? 'true' : undefined}>
      <VoiceChannelRow name={name} current={current} joined={joined} participants={room?.participants ?? []}
        readable={readable} labels={voice.labels} onOpen={onOpen} />
      {voice.onJoin === undefined || joined || room?.held === true ? null : (
        <>
          <span id={nameId} hidden>{name}</span>
          <Button variant="ghost" size="sm" className="d-channel-list__join" tabIndex={-1} aria-describedby={nameId}
            onClick={() => voice.onJoin?.(id)}>{voice.labels.join}</Button>
        </>
      )}
    </li>
  );
}

type Entry =
  | { kind: 'category'; id: string; name: string; collapsed: boolean }
  | { kind: 'channel'; channel: ChannelListChannel };

/**
 * The rows in display order: the uncategorised channels, then each category's header and its children. A collapsed
 * category still shows the children that are the active one, that have unread or mentions, or that this device has joined (R23).
 */
function entriesOf(channels: readonly ChannelListChannel[], categories: NonNullable<ChannelListProps['categories']>,
  activeId: string | null, joined: (c: ChannelListChannel) => boolean): Entry[] {
  const known = new Set(categories.map(c => c.id));
  const out: Entry[] = channels.filter(c => c.parentId == null || !known.has(c.parentId)).map(channel => ({ kind: 'channel', channel }));
  for (const cat of categories) {
    out.push({ kind: 'category', id: cat.id, name: cat.name, collapsed: cat.collapsed });
    for (const channel of channels) {
      if (channel.parentId !== cat.id) continue;
      if (cat.collapsed && channel.id !== activeId && (channel.unread ?? 0) === 0 && (channel.mentions ?? 0) === 0 && !joined(channel)) continue;
      out.push({ kind: 'channel', channel });
    }
  }
  return out;
}

/**
 * The sidebar: the server name as the shell's <h1> (pre-flight ruling (e)), in
 * serif italic and never case-transformed, then the channels as the existing
 * ChannelRow buttons. One tab stop with roving focus, the category headers included. A row with something to
 * report (an unread count, mentions, or muted) is named by `rowLabel` when one
 * is given; a quiet row keeps its bare name. With `tabs`, the tabs sit between
 * the heading and a tab panel named like the list; an optional footer ends the
 * list, outside the roving group. `content`, when given, stands in place of the
 * rows inside the panel. With `voice`, a voice channel is a VoiceChannelRow with its people below it, still one
 * stop of the same roving group.
 */
export function ChannelList({ label, title, channels, categories = [], onToggleCategory, onAddInCategory, addInCategoryLabel, activeId, onSelect, emptyLabel, rowLabel, tabs, footer, content, voice, listAction, actions, actionsLabel, headerAction, titleKind = 'server' }: ChannelListProps) {
  const isJoined = (c: ChannelListChannel) => c.joined === true || (voice !== undefined && Object.hasOwn(voice.rooms, c.id) && voice.rooms[c.id].joined);
  const entries = entriesOf(channels, categories, activeId, isJoined);
  const roving = useRovingFocus(entries.findIndex(e => e.kind === 'channel' && e.channel.id === activeId));
  // A join or add icon holds its row's tab index: the stop row's icon is a tab stop, no other is.
  const syncExtras = () => {
    for (const li of Array.from(roving.ref.current?.children ?? [])) {
      const row = li.firstElementChild;
      const extra = li.querySelector<HTMLButtonElement>(':scope > .d-voice-row__join button, :scope > .d-channel-list__cat-add button, :scope > .d-channel-list__join');
      if (row instanceof HTMLButtonElement && extra !== null) extra.tabIndex = row.tabIndex;
    }
  };
  // Declared after the roving hook, so its placement has run when this does.
  useLayoutEffect(syncExtras);
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => { roving.onKeyDown(e); syncExtras(); };
  const onFocus = (e: FocusEvent<HTMLUListElement>) => { roving.onFocus(e); syncExtras(); };
  const renderChannel = (c: ChannelListChannel) => {
    const unread = c.unread ?? 0;
    const mentions = c.mentions ?? 0;
    const muted = c.muted ?? false;
    const ariaLabel = rowLabel && (unread > 0 || mentions > 0 || muted) ? rowLabel({ name: c.badge === undefined ? c.name : `${c.name}, ${c.badge}`, unread, mentions, muted }) : undefined;
    if (c.kind === 'voice' && voice !== undefined) {
      const room = Object.hasOwn(voice.rooms, c.id) ? voice.rooms[c.id] : undefined;
      const joined = room?.joined ?? false;
      if (voice.iconJoin !== true) {
        return <LegacyVoiceItem key={c.id} id={c.id} name={c.name} current={c.id === activeId} readable={c.readable} room={room} voice={voice} onOpen={() => onSelect(c.id)} />;
      }
      const canJoin = voice.onJoin !== undefined && !joined && room?.held !== true;
      return (
        <li key={c.id} className="d-voice-item" data-joined={joined ? 'true' : undefined}>
          <VoiceChannelRow name={c.name} current={c.id === activeId} joined={joined} participants={room?.participants ?? []}
            readable={c.readable} labels={voice.labels} onOpen={() => onSelect(c.id)} onJoin={canJoin ? () => voice.onJoin?.(c.id) : undefined} />
        </li>
      );
    }
    return (
      <li key={c.id}>
        <ChannelRow name={c.name} kind={c.kind} readable={c.readable} active={c.id === activeId}
          unread={unread} mentions={mentions} muted={muted} badge={c.badge} ariaLabel={ariaLabel} onSelect={() => onSelect(c.id)} />
      </li>
    );
  };
  const body = content !== undefined ? content : channels.length === 0 && categories.length === 0 ? (
    <p className="d-channel-list__empty">{emptyLabel}</p>
  ) : (
    <ul role="list" className="d-channel-list__list" ref={roving.ref} onKeyDown={onKeyDown} onFocus={onFocus}>
      {entries.map(e => e.kind === 'channel' ? renderChannel(e.channel) : (
        <li key={`cat:${e.id}`} className="d-channel-list__cat">
          <button type="button" className="d-channel-list__cat-head" data-row aria-expanded={!e.collapsed} data-collapsed={e.collapsed ? 'true' : undefined}
            onClick={() => onToggleCategory?.(e.id)}>
            <span className="d-channel-list__cat-chevron" aria-hidden="true"><Icon name="chevron-down" size={14} /></span>
            <span className="d-channel-list__cat-label">{e.name}</span>
            <TrailingSlot />
          </button>
          {onAddInCategory !== undefined ? (
            <span className="d-channel-list__cat-add">
              <TrailingSlot>
                <IconButton icon="plus" size={28} label={addInCategoryLabel?.(e.name) ?? e.name} onClick={() => onAddInCategory(e.id)} />
              </TrailingSlot>
            </span>
          ) : null}
        </li>
      ))}
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
