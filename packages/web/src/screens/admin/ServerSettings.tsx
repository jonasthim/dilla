import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SettingsFrame } from '@dilla/ui';
import { useSlice } from '../../core/use-slice.ts';
import { usePhoneLayout } from '../../layout.ts';
import { SettingsEditProvider, useSettingsWorkspace } from '../../settings/edit-state.tsx';
import { SettingsNavigation } from '../../settings/SettingsNavigation.tsx';
import { availableSettings, type ServerSettingsSection, type SettingsAccess } from '../../settings/registry.ts';
import { useSettingsFocus } from '../../settings/use-settings-focus.ts';
import { t } from '../../strings/index.ts';
import { BansSection } from './BansSection.tsx';
import { ChannelsSection } from './ChannelsSection.tsx';
import { DangerSection } from './DangerSection.tsx';
import { InvitesSection } from './InvitesSection.tsx';
import { RolesSection } from './RolesSection.tsx';
import { OverviewSection } from './OverviewSection.tsx';
import { BotSection } from './BotSection.tsx';
import { SelfRolesSection } from './SelfRolesSection.tsx';
import { GifsSettings } from './GifsSettings.tsx';
import { MembersSection } from './MembersSection.tsx';

/** Kept for the shell's existing admin actions while routes move to ServerSettingsSection. */
export type AdminTab = ServerSettingsSection;

export interface ServerSettingsProps {
  communityId: string;
  tab: ServerSettingsSection | null;
  onTab: (tab: ServerSettingsSection | null) => void;
  onClose: () => void;
  announce: (message: string) => void;
  activity?: ReactNode;
  onMessage?: (userId: string) => void;
  onCompare?: (userId: string) => void;
}

export function ServerSettings(props: ServerSettingsProps): React.JSX.Element {
  return <SettingsEditProvider><ServerSettingsWorkspace {...props} /></SettingsEditProvider>;
}

function ServerSettingsWorkspace({ communityId, tab, onTab, onClose, announce, activity, onMessage = () => undefined, onCompare = () => undefined }: ServerSettingsProps): React.JSX.Element {
  const phone = usePhoneLayout();
  const community = useSlice('communities')?.find(c => c.id === communityId);
  const rawAccess = useSlice(`permissions:${communityId}`);
  const access: SettingsAccess | undefined = rawAccess;
  const account = useSlice('account');
  const allowed = useMemo(() => availableSettings('server', access), [access]);
  const active = phone && tab === null ? null
    : (allowed.find(entry => entry.id === tab)?.id as ServerSettingsSection | undefined)
      ?? (tab === null || access?.loaded === true ? (allowed[0]?.id as ServerSettingsSection | undefined) ?? null : null);
  const [closed, setClosed] = useState(false);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [permissionNotice, setPermissionNotice] = useState('');
  const workspace = useSettingsWorkspace();
  const told = useRef(false);
  const previousActive = useRef<ServerSettingsSection | null>(null);
  const announcedLossFor = useRef<ServerSettingsSection | null>(null);
  const known = useRef(community);
  if (community !== undefined) known.current = community;
  const shown = community ?? known.current;
  const gone = community === undefined && known.current !== undefined;
  const finish = () => {
    if (told.current) return;
    told.current = true;
    workspace?.clear();
    setClosed(true);
    onClose();
  };

  useEffect(() => { if (gone) finish(); }, [gone]); // leave/delete drop the server before the request resolves
  useEffect(() => {
    if (access?.loaded !== true) return;
    const lost = previousActive.current !== null && !allowed.some(entry => entry.id === previousActive.current);
    const requestedAllowed = tab === null || allowed.some(entry => entry.id === tab);
    const newRequestedLoss = tab !== null && !requestedAllowed && announcedLossFor.current !== tab;
    if (lost || newRequestedLoss) {
      workspace?.clear();
    }
    if (newRequestedLoss && tab !== null) {
      setPermissionNotice(t('workspace.permissionChanged'));
      announcedLossFor.current = tab;
      if (active !== null) onTab(active);
    } else if (tab === null || allowed.some(entry => entry.id === tab)) {
      announcedLossFor.current = null;
    }
    previousActive.current = active;
  }, [access?.loaded, allowed, active, onTab, tab, workspace]);

  const select = (section: ServerSettingsSection | null, nextAnchor: string | null = null) => {
    setAnchor(nextAnchor);
    if (section === tab) return;
    onTab(section);
  };
  const close = onClose;

  const contentRef = useSettingsFocus(active, anchor);
  const entry = allowed.find(item => item.id === active);
  const footer = workspace?.footer ?? null;
  const sectionTitle = entry ? t(entry.labelKey) : undefined;
  const common = { communityId, serverName: shown?.name ?? '', announce };
  const content = useMemo(() => {
    if (!access?.loaded || active === null || shown === undefined) return null;
    switch (active) {
      case 'overview': return <OverviewSection {...common} />;
      case 'channels': return <ChannelsSection {...common} />;
      case 'gifs': return <section className="dw-settings-section"><h2 tabIndex={-1}>{t('workspace.gifs')}</h2><GifsSettings communityId={communityId} announce={announce} /></section>;
      case 'members': return <MembersSection communityId={communityId} selfId={account?.user?.id ?? ''} onMessage={onMessage} onCompare={onCompare} announce={announce} />;
      case 'roles': return <RolesSection {...common} />;
      case 'invites': return <InvitesSection {...common} />;
      case 'selfRoles': return <SelfRolesSection {...common} />;
      case 'bot': return <BotSection {...common} />;
      case 'welcome': case 'joinRoles': case 'music': case 'automoderation': case 'moderationLog': return null;
      case 'bans': return <BansSection {...common} />;
      case 'danger': return <DangerSection {...common} owner={access.owner === true} onGone={finish} />;
      default: return null;
    }
  // These components own their draft state. Recreate the selected section only when its identity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, access?.loaded, access?.owner, communityId, shown?.name, account?.user?.id, onMessage, onCompare, announce]);

  return <>
    <SettingsFrame open={!closed && !gone} title={t('admin.title')} closeLabel={t('admin.cancel')} onClose={close}
      identity={shown ? <span>{shown.name}</span> : undefined}
      nav={<SettingsNavigation scope="server" access={access} activeId={active ?? ''} onSelect={(id, target) => select(id as ServerSettingsSection, target ?? null)} />}
      footer={footer} phonePage={phone && tab === null ? 'index' : 'section'} sectionTitle={sectionTitle}
      backLabel={t('workspace.back')} onBack={() => select(null)} contentRef={contentRef} wide={entry?.wide} activity={activity}>
      {!access?.loaded ? <p aria-busy="true">{t('admin.loading')}</p> : null}
      {permissionNotice ? <p role="status" aria-live="polite">{permissionNotice}</p> : null}
      {content}
      {workspace?.confirmation}
    </SettingsFrame>
  </>;
}
