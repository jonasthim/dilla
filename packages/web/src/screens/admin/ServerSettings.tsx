// Flow 08 (v0.1.0-web3.4): the Server settings dialog. A SettingsFrame whose tabs follow the viewer's permissions in
// `permissions:<cid>`; every gate here is advisory, the instance answers each request again.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SettingsFrame, SettingsNav } from '@dilla/ui';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';
import { BansSection } from './BansSection.tsx';
import { ChannelsSection } from './ChannelsSection.tsx';
import { DangerSection } from './DangerSection.tsx';
import { InvitesSection } from './InvitesSection.tsx';
import { OverviewSection } from './OverviewSection.tsx';
import type { Announce } from './shared.ts';

export type AdminTab =
  | 'overview'
  | 'channels'
  | 'invites'
  | 'bans'
  | 'danger';

export interface ServerSettingsProps {
  communityId: string;
  /** The tab asked for. One the viewer may not use falls back to the first they may. */
  tab: AdminTab;
  onTab: (tab: AdminTab) => void;
  onClose: () => void;
  /** The shell's polite announcer (its status region outlives this dialog, which closes after leave and delete). */
  announce: Announce;
}

/**
 * The dialog for one server, mounted by whoever opens it. Until the permissions are read (`loaded` false) it shows no tab
 * rather than hiding tabs as forbidden. Overview needs manageCommunity, channels manageChannels, invites createInvite and
 * bans banMembers; the danger tab (leave, or for the owner delete and hand over) is always there. A server that leaves the
 * list while this is open (kicked, deleted) closes it.
 */
export function ServerSettings({ communityId, tab, onTab, onClose, announce }: ServerSettingsProps): React.JSX.Element | null {
  const community = useSlice('communities')?.find(c => c.id === communityId);
  const access = useSlice(`permissions:${communityId}`);
  // The last community seen: leave and delete drop the server from the list before their command resolves, and the dialog
  // keeps showing it until it has been told to close, so the close path restores focus and the message is still announced.
  const known = useRef(community);
  if (community !== undefined) known.current = community;
  const shown = community ?? known.current;
  const [closed, setClosed] = useState(false);
  const told = useRef(false);
  const finish = () => {
    if (told.current) return;
    told.current = true;
    setClosed(true);
    onClose();
  };
  const gone = community === undefined && known.current !== undefined;
  useEffect(() => { if (gone) finish(); });

  const loaded = access?.loaded === true;
  const tabs: { id: AdminTab; label: string }[] = [];
  if (access !== undefined && loaded) {
    if (access.manageCommunity) tabs.push({ id: 'overview', label: t('admin.nav.overview') });
    if (access.manageChannels) tabs.push({ id: 'channels', label: t('admin.nav.channels') });
    if (access.createInvite) tabs.push({ id: 'invites', label: t('admin.nav.invites') });
    if (access.banMembers) tabs.push({ id: 'bans', label: t('admin.nav.bans') });
    tabs.push({ id: 'danger', label: t(access.owner ? 'admin.nav.delete' : 'admin.nav.leave') });
  }
  const active = tabs.find(x => x.id === tab)?.id ?? tabs[0]?.id ?? null;

  const previous = useRef(active);
  useLayoutEffect(() => {
    if (previous.current !== null && active !== null && previous.current !== active) {
      document.querySelector<HTMLElement>('.d-settings-frame__body h2')?.focus();
    }
    previous.current = active;
  }, [active]);

  if (shown === undefined) return null;
  const common = { communityId, serverName: shown.name, announce };
  return (
    <SettingsFrame open={!closed && !gone} title={t('admin.title')} closeLabel={t('admin.cancel')} onClose={onClose}
      nav={<SettingsNav label={t('admin.nav')} items={tabs} activeId={active ?? ''} onSelect={id => onTab(id as AdminTab)} />}>
      {!loaded ? <p aria-busy="true">{t('admin.loading')}</p> : null}
      {active === 'overview' ? <OverviewSection {...common} /> : null}
      {active === 'channels' ? <ChannelsSection {...common} /> : null}
      {active === 'invites' ? <InvitesSection {...common} /> : null}
      {active === 'bans' ? <BansSection {...common} /> : null}
      {active === 'danger' ? <DangerSection {...common} owner={access?.owner === true} onGone={finish} /> : null}
    </SettingsFrame>
  );
}
