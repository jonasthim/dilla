// Flow 08: the member pane. W3 mounts it in the shell's aside; it reads the members, roles and permissions slices.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MemberList, focusReturnTarget, type MemberListGroup } from '@dilla/ui';
import { useSlice } from '../../core/use-slice.ts';
import { usePhoneLayout } from '../../layout.ts';
import { t } from '../../strings/index.ts';
import { memberGroups, memberName, menuFor, type MenuAction } from './members-model.ts';
import { BanFlow, KickFlow, type ModTarget } from './Moderation.tsx';
import { MemberRolesFlow } from './MemberRolesFlow.tsx';

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

  // Where focus goes when a dialog closes: the row's trigger that opened it, or that member's trigger re-mounted in another
  // group (a hoisted role given meanwhile), else (a kicked member's row is gone) the pane. The same rule as Dialog's own.
  const region = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const focusedRow = useRef<HTMLElement | null>(null);
  const restore = useRef(false);
  const anyOpen = kickOpen || banOpen || rolesFor !== null;
  useEffect(() => {
    if (anyOpen || !restore.current) return;
    restore.current = false;
    focusReturnTarget(opener.current, () => region.current)?.focus();
  }, [anyOpen]);
  useLayoutEffect(() => {
    const old = focusedRow.current;
    if (old === null || old.isConnected) return;
    // A presence snapshot can briefly replace every row with a loading message as a role dialog closes. Keep the old
    // row key while focus rests on the pane, then return to its new trigger when the snapshot brings the row back.
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

  const community = communities?.find(c => c.id === communityId);
  const serverName = community?.name ?? '';
  const ownerId = community?.owner ?? '';
  const list = members ?? [];
  const roleList = roles ?? [];
  const ctx = { selfId, ownerId, roles: roleList };
  const byId = new Map(list.map(m => [m.userId, m]));

  const labelOf: Record<MenuAction, string> = {
    message: t('members.menu.message'), compare: t('members.menu.compare'), roles: t('roles.menu.assign'), kick: t('members.menu.kick'), ban: t('members.menu.ban'),
  };
  const groups: MemberListGroup[] = memberGroups(list, roleList, ownerId, selfId, presence ?? undefined).map(g => ({
    id: g.id,
    kind: g.role !== null ? 'role' as const : g.id === 'offline' ? 'offline' as const : 'online' as const,
    title: g.role?.name ?? t(g.id === 'offline' ? 'layout.members.offline' : 'layout.members.online'),
    color: g.role?.color ?? null,
    members: g.members.map(row => {
      const summary = byId.get(row.userId);
      const items = summary === undefined ? [] : menuFor(summary, access, ctx);
      return { id: row.userId, name: row.name, color: row.color, presence: presence?.[row.userId] ?? 'offline', tags: row.tags.map(tag => t(`members.${tag}`)), actionsLabel: t('members.actions', { name: row.name }),
        actions: items.map(id => ({ id, label: labelOf[id], danger: id === 'kick' || id === 'ban' })) };
    }),
  }));

  const onAction = (userId: string, action: string) => {
    const row = byId.get(userId);
    if (row === undefined) return;
    const target = { userId, name: memberName(row) };
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    restore.current = action === 'kick' || action === 'ban' || action === 'roles';
    if (action === 'message') props.onMessage(userId);
    else if (action === 'compare') props.onCompare(userId);
    else if (action === 'roles') setRolesFor(userId);
    else if (action === 'kick') { setKick(target); setKickOpen(true); }
    else if (action === 'ban') { setBan(target); setBanOpen(true); }
  };

  return (
    <div ref={region} tabIndex={-1} onFocusCapture={event => {
      if (event.target instanceof HTMLElement && event.target.dataset.focusKey?.startsWith('member:')) focusedRow.current = event.target;
    }}>
      {/* The shell's aside carries the name "members of {server}"; the list's own 48 bar (S3) is the word "members", on the header's hairline.
          A phone's sheet already has its PhoneHeader, so it draws no second bar. */}
      <MemberList label={phone ? undefined : t('members.toggle')} groups={groups} loading={members === undefined || presence === undefined || presence === null}
        loadingLabel={t('members.loading')} emptyLabel={t('members.empty')} onAction={onAction} />
      <KickFlow open={kickOpen} communityId={communityId} serverName={serverName} target={kick} announce={text => props.announce(text)}
        onClose={() => setKickOpen(false)} onDone={() => setKickOpen(false)} />
      <BanFlow open={banOpen} communityId={communityId} serverName={serverName} target={ban} announce={text => props.announce(text)}
        onClose={() => setBanOpen(false)} onDone={() => setBanOpen(false)} />
      {rolesFor !== null
        ? <MemberRolesFlow communityId={communityId} userId={rolesFor} announce={text => props.announce(text)} onClose={() => setRolesFor(null)} />
        : null}
    </div>
  );
}
