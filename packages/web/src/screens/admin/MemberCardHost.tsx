// Flow 08/14: the one open profile card of the app, its actions and the dialogs they open. The member pane (a row) and the
// conversation (a mention pill, an author name or avatar) both open it; the shell holds the one open state.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ProfileCard, focusReturnTarget } from '@dilla/ui';
import { useSlice } from '../../core/use-slice.ts';
import { usePhoneLayout } from '../../layout.ts';
import { t } from '../../strings/index.ts';
import { memberName, type MenuAction } from './members-model.ts';
import { memberCardData } from './member-card.ts';
import { BanFlow, KickFlow, type ModTarget } from './Moderation.tsx';
import { MemberRolesFlow } from './MemberRolesFlow.tsx';

/**
 * The open card: whose it is, and what it is anchored to. A `list` card follows its member's row (found again by id on
 * every render, so a re-mounted row neither closes it nor strands it). A `mention` or `author` card is anchored to that
 * element and closes when the element is gone. `name` is the label to show when the person is no longer a member.
 */
export interface OpenCard { id: string; source: 'list' | 'mention' | 'author'; anchor: HTMLElement; name?: string }

export const presenceLabels = (): Record<'online' | 'idle' | 'dnd' | 'offline', string> => ({
  online: t('layout.presence.online'), idle: t('layout.presence.idle'), dnd: t('layout.presence.dnd'), offline: t('layout.presence.offline'),
});

export interface MemberCardHostProps {
  communityId: string;
  selfId: string;
  card: OpenCard | null;
  onCard(next: OpenCard | null): void;
  onMessage(userId: string): void;
  onCompare(userId: string): void;
  announce(text: string): void;
  /** Where focus goes when a dialog closes and its trigger is gone. */
  fallbackFocus?(): HTMLElement | null;
}

export function MemberCardHost(props: MemberCardHostProps): React.JSX.Element {
  const { communityId, selfId, card, onCard } = props;
  const phone = usePhoneLayout();
  const communities = useSlice('communities');
  const members = useSlice(`members:${communityId}`);
  const presence = useSlice(`presence:${communityId}`);
  const roles = useSlice(`roles:${communityId}`);
  const access = useSlice(`permissions:${communityId}`);
  const [kick, setKick] = useState<ModTarget | null>(null);
  const [ban, setBan] = useState<ModTarget | null>(null);
  const [kickOpen, setKickOpen] = useState(false);
  const [banOpen, setBanOpen] = useState(false);
  const [rolesFor, setRolesFor] = useState<string | null>(null);

  // Where focus goes when a dialog closes: the trigger that opened it (the card's anchor), else the caller's fallback.
  const opener = useRef<HTMLElement | null>(null);
  const restore = useRef(false);
  const anyOpen = kickOpen || banOpen || rolesFor !== null;
  useEffect(() => {
    if (anyOpen || !restore.current) return;
    restore.current = false;
    focusReturnTarget(opener.current, () => props.fallbackFocus?.() ?? null)?.focus();
  }, [anyOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const community = communities?.find(c => c.id === communityId);
  const ownerId = community?.owner ?? '';
  const byId = new Map((members ?? []).map(m => [m.userId, m]));

  // A list card follows its member's row: look the row up by id after every render and re-anchor when it is a new element.
  // A message card closes when its element is gone.
  useLayoutEffect(() => {
    if (card === null) return;
    if (card.source !== 'list') {
      if (!card.anchor.isConnected) onCard(null);
      return;
    }
    const row = document.querySelector<HTMLElement>(`[data-focus-key="member:${card.id}"]`);
    if (row !== null && row !== card.anchor) onCard({ ...card, anchor: row });
  });
  // A member who leaves or is kicked closes their card; a rejoin never brings it back.
  const seen = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (card === null) { seen.current = null; return; }
    if (members === undefined) return;
    if (byId.has(card.id)) seen.current = card.id;
    else if (seen.current === card.id || card.source === 'list') { seen.current = null; onCard(null); }
  });

  const member = card === null ? undefined : byId.get(card.id);
  const data = member === undefined ? null : memberCardData(member, { selfId, ownerId, roles: roles ?? [], access });

  const labelOf: Record<MenuAction, string> = {
    message: t('members.menu.message'), compare: t('members.menu.compare'), roles: t('layout.profile.manageRoles'), kick: t('members.menu.kick'), ban: t('members.menu.ban'),
  };
  const onAction = (userId: string, action: string) => {
    const row = byId.get(userId);
    if (row === undefined) return;
    const target = { userId, name: memberName(row) };
    opener.current = card?.anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    restore.current = action === 'kick' || action === 'ban' || action === 'roles';
    if (action === 'message') props.onMessage(userId);
    else if (action === 'compare') props.onCompare(userId);
    else if (action === 'roles') setRolesFor(userId);
    else if (action === 'kick') { setKick(target); setKickOpen(true); }
    else if (action === 'ban') { setBan(target); setBanOpen(true); }
    onCard(null);
  };

  const labels = {
    ownerLabel: t('layout.profile.owner'), youLabel: t('layout.profile.you'), rolesLabel: t('layout.profile.roles'),
    closeLabel: t('layout.profile.close'), presenceLabels: presenceLabels(),
  };
  const layout = phone ? 'sheet' : 'popover';
  return (
    <>
      {card !== null && data !== null ? (
        <ProfileCard name={data.name} username={data.username} presence={presence?.[data.userId] ?? 'offline'} isOwner={data.isOwner} isYou={data.isYou}
          roles={data.roles} actions={data.actions.map(id => ({ id, label: labelOf[id], danger: id === 'kick' || id === 'ban' }))}
          onAction={id => onAction(data.userId, id)} onClose={() => onCard(null)} anchor={card.anchor} layout={layout} {...labels} />
      ) : card !== null && card.source !== 'list' && card.name !== undefined && members !== undefined ? (
        <ProfileCard name={card.name} username="" roles={[]} actions={[]} onAction={() => {}} onClose={() => onCard(null)} anchor={card.anchor} layout={layout} {...labels} />
      ) : null}
      <KickFlow open={kickOpen} communityId={communityId} serverName={community?.name ?? ''} target={kick} announce={text => props.announce(text)}
        onClose={() => setKickOpen(false)} onDone={() => setKickOpen(false)} />
      <BanFlow open={banOpen} communityId={communityId} serverName={community?.name ?? ''} target={ban} announce={text => props.announce(text)}
        onClose={() => setBanOpen(false)} onDone={() => setBanOpen(false)} />
      {rolesFor !== null
        ? <MemberRolesFlow communityId={communityId} userId={rolesFor} announce={text => props.announce(text)} onClose={() => setRolesFor(null)} />
        : null}
    </>
  );
}
