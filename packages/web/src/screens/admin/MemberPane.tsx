// Flow 08: the member pane. W3 mounts it in the shell's aside; it reads the members, roles and permissions slices.
import { useState } from 'react';
import { MemberList, type MemberListGroup } from '@dilla/ui';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';
import { memberGroups, memberName, menuFor, type MenuAction } from './members-model.ts';
import { BanFlow, KickFlow, type ModTarget } from './Moderation.tsx';

export interface MemberPaneProps {
  communityId: string;
  selfId: string;
  /** Opens (or finds) the direct message with `userId` and goes there. */
  onMessage(userId: string): void;
  /** Goes to the privacy screen's safety-number comparison for `userId`. */
  onCompare(userId: string): void;
  /** The shell's polite announcer. */
  announce(text: string): void;
}

export function MemberPane(props: MemberPaneProps): React.JSX.Element {
  const { communityId, selfId } = props;
  const communities = useSlice('communities');
  const members = useSlice(`members:${communityId}`);
  const roles = useSlice(`roles:${communityId}`);
  const access = useSlice(`permissions:${communityId}`);
  const [kick, setKick] = useState<ModTarget | null>(null);
  const [ban, setBan] = useState<ModTarget | null>(null);
  const [kickOpen, setKickOpen] = useState(false);
  const [banOpen, setBanOpen] = useState(false);

  const community = communities?.find(c => c.id === communityId);
  const serverName = community?.name ?? '';
  const ownerId = community?.owner ?? '';
  const list = members ?? [];
  const roleList = roles ?? [];
  const ctx = { selfId, ownerId, roles: roleList };
  const byId = new Map(list.map(m => [m.userId, m]));

  const labelOf: Record<MenuAction, string> = {
    message: t('members.menu.message'), compare: t('members.menu.compare'), kick: t('members.menu.kick'), ban: t('members.menu.ban'),
  };
  const groups: MemberListGroup[] = memberGroups(list, roleList, ownerId, selfId).map(g => ({
    id: g.id,
    title: t('members.group', { name: g.role?.name ?? t('members.groupMembers'), count: g.members.length }),
    members: g.members.map(row => {
      const summary = byId.get(row.userId);
      const items = summary === undefined ? [] : menuFor(summary, access, ctx);
      return { id: row.userId, name: row.name, tags: row.tags.map(tag => t(`members.${tag}`)), actionsLabel: t('members.actions', { name: row.name }),
        actions: items.map(id => ({ id, label: labelOf[id], danger: id === 'kick' || id === 'ban' })) };
    }),
  }));

  const onAction = (userId: string, action: string) => {
    const row = byId.get(userId);
    if (row === undefined) return;
    const target = { userId, name: memberName(row) };
    if (action === 'message') props.onMessage(userId);
    else if (action === 'compare') props.onCompare(userId);
    else if (action === 'kick') { setKick(target); setKickOpen(true); }
    else if (action === 'ban') { setBan(target); setBanOpen(true); }
  };

  return (
    <>
      <MemberList label={t('members.region', { server: serverName })} groups={groups} loading={members === undefined}
        loadingLabel={t('members.loading')} emptyLabel={t('members.empty')} onAction={onAction} />
      <KickFlow open={kickOpen} communityId={communityId} serverName={serverName} target={kick} announce={text => props.announce(text)}
        onClose={() => setKickOpen(false)} onDone={() => setKickOpen(false)} />
      <BanFlow open={banOpen} communityId={communityId} serverName={serverName} target={ban} announce={text => props.announce(text)}
        onClose={() => setBanOpen(false)} onDone={() => setBanOpen(false)} />
    </>
  );
}
