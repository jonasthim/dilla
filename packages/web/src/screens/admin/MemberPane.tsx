// Flow 08: the member pane. W3 mounts it in the shell's aside; it reads the members, roles and permissions slices.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MemberList, focusReturnTarget, type MemberListGroup } from '@dilla/ui';
import { useSlice } from '../../core/use-slice.ts';
import { usePhoneLayout } from '../../layout.ts';
import { t } from '../../strings/index.ts';
import { memberGroups } from './members-model.ts';
import { MemberCardHost, presenceLabels, type OpenCard } from './MemberCardHost.tsx';

export interface MemberPaneProps {
  communityId: string;
  selfId: string;
  /** Opens (or finds) the direct message with `userId` and goes there. */
  onMessage: (userId: string) => void;
  /** Goes to the privacy screen's safety-number comparison for `userId`. */
  onCompare: (userId: string) => void;
  /** The shell's polite announcer. */
  announce: (text: string) => void;
  /** The card open from a mention pill or an author name (the shell holds it). While one is open the pane's own card is closed. */
  messageCard?: OpenCard | null;
  /** The pane opened a card from a row: the shell closes its message card. */
  onCardOpen?: () => void;
}

export function MemberPane(props: MemberPaneProps): React.JSX.Element {
  const { communityId, selfId } = props;
  const phone = usePhoneLayout();
  const members = useSlice(`members:${communityId}`);
  const presence = useSlice(`presence:${communityId}`);
  const roles = useSlice(`roles:${communityId}`);
  const communities = useSlice('communities');
  // The card open from a row of this list. One card at a time across the app: a message card closes it.
  const [card, setCard] = useState<OpenCard | null>(null);

  // A presence snapshot can briefly replace every row with a loading message. Keep the old row key while focus rests on
  // the pane, then return to its new trigger when the snapshot brings the row back.
  const region = useRef<HTMLDivElement>(null);
  const focusedRow = useRef<HTMLElement | null>(null);
  // A card opened from a pill or an author name has taken focus away from the rows: the pane must not take it back
  // (when that card closes, focus goes to the pill) if a row was re-mounted meanwhile.
  const fromMessage = props.messageCard != null;
  useEffect(() => {
    if (!fromMessage) return;
    focusedRow.current = null;
    setCard(null);
  }, [fromMessage, props.messageCard]);
  useLayoutEffect(() => {
    const old = focusedRow.current;
    if (old === null || old.isConnected) return;
    const active = document.activeElement;
    if (active !== document.body && active !== region.current) return;
    const target = focusReturnTarget(old);
    if (target !== null) {
      target.focus();
      focusedRow.current = target;
    } else {
      if (active === document.body) region.current?.focus();
      if (members !== undefined && presence != null && !members.some(m => old.dataset.focusKey === `member:${m.userId}`)) focusedRow.current = null;
    }
  });

  const ownerId = communities?.find(c => c.id === communityId)?.owner ?? '';
  const list = members ?? [];
  const roleList = roles ?? [];

  const groups: MemberListGroup[] = memberGroups(list, roleList, ownerId, selfId, presence ?? undefined).map(g => ({
    id: g.id,
    kind: g.role !== null ? 'role' as const : g.id === 'offline' ? 'offline' as const : 'online' as const,
    title: g.role?.name ?? t(g.id === 'offline' ? 'layout.members.offline' : 'layout.members.online'),
    color: g.role?.color ?? null,
    members: g.members.map(row => ({ id: row.userId, name: row.name, color: row.color, presence: presence?.[row.userId] ?? 'offline',
      isOwner: row.tags.includes('owner'), isBot: row.tags.includes('bot') })),
  }));

  // A primary click on the open member's row closes the card, another row switches it (the card itself ignores a pointerdown on its anchor).
  // Enter, a right-click, Shift+F10 and the ContextMenu key only ever open.
  const onOpen = (userId: string, anchor: HTMLElement, via: 'click' | 'menu') => {
    const closes = card !== null && card.id === userId && via === 'click';
    if (!closes) props.onCardOpen?.();
    setCard(closes ? null : { id: userId, source: 'list', anchor });
  };

  return (
    <div ref={region} tabIndex={-1} onFocusCapture={event => {
      if (event.target instanceof HTMLElement && event.target.dataset.focusKey?.startsWith('member:')) focusedRow.current = event.target;
    }}>
      {/* The shell's aside carries the name "members of {server}"; the list's own 48 bar (S3) is the word "members", on the header's hairline.
          A phone's sheet already has its PhoneHeader, so it draws no second bar. */}
      <MemberList label={phone ? undefined : t('members.toggle')} groups={groups} loading={members === undefined || presence === undefined || presence === null}
        loadingLabel={t('members.loading')} emptyLabel={t('members.empty')} presenceLabels={presenceLabels()}
        ownerLabel={t('layout.profile.owner')} botLabel={t('layout.profile.bot')} openId={card?.id ?? null} onOpen={onOpen} />
      <MemberCardHost communityId={communityId} selfId={selfId} card={card} onCard={setCard} onMessage={props.onMessage} onCompare={props.onCompare}
        announce={props.announce} fallbackFocus={() => region.current} />
    </div>
  );
}
