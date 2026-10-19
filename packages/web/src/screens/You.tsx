import { useEffect } from 'react';
import { Avatar, Icon, StateDot, type IconName } from '@dilla/ui';
import { useCore } from '../core/context.tsx';
import { useSlice, useSlices } from '../core/use-slice.ts';
import type { SettingsSection } from '../router.ts';
import { t } from '../strings/index.ts';
import { devicesChunk, mergeMembers } from './shell-model.ts';
import { NAV } from './Settings.tsx';
import { SignOutAction } from './settings/SignOut.tsx';
import { PresencePicker } from './PresencePicker.tsx';

const CHEVRON = 'chevron-right';
const SECTION_ICON: Record<SettingsSection, IconName> = {
  devices: 'server', signin: 'user', notifications: 'megaphone', appearance: 'eye', voice: 'volume-2', privacy: 'check', keyboard: 'hash', diagnostics: 'activity',
};

/**
 * The phone's You tab (flow 12): who this is, the four facts the desktop holds in Settings → Diagnostics (this device's node, link,
 * generation and devices), one row per Settings section in Settings' own order, and sign out.
 */
export function You(props: { onOpenSettings(section: SettingsSection): void }): React.JSX.Element {
  const client = useCore();
  const account = useSlice('account');
  const connection = useSlice('connection');
  const devices = useSlice('devices');
  const communities = useSlice('communities');
  const memberLists = useSlices((communities ?? []).map(c => `members:${c.id}` as const));
  const self = account?.user ?? null;
  const display = self === null ? undefined : mergeMembers(memberLists).find(m => m.userId === self.id)?.display;
  const name = display === undefined || display === '' ? self?.username ?? t('shell.status.unknown') : display;
  // The device list, once per mount, for the devices fact; a refusal leaves the fact unknown.
  useEffect(() => {
    client.call({ m: 'refreshDevices' }).catch(() => undefined);
  }, [client]);
  const status = connection?.status ?? 'connecting';
  const tone = status === 'online' ? 'ok' : status === 'connecting' ? 'pending' : 'danger';
  return (
    <div className="dw-phone-pane dw-you">
      <h1 className="dw-phone-heading">{t('you.title')}</h1>
      <div className="dw-you__account">
        <Avatar name={name} size="md" />
        <div className="dw-you__who">
          <strong className="dw-you__name">{name}</strong>
          {self === null ? null : <span className="dw-phone-row__meta">{`@${self.username}`}</span>}
        </div>
      </div>
      <div className="dw-you__presence"><PresencePicker /></div>
      <section className="dw-you__card" aria-labelledby="dw-you-status">
        <h2 id="dw-you-status" className="d-label dw-you__cardhead">{t('you.status')}</h2>
        <dl className="dw-you__facts">
          <div className="dw-you__fact"><dt className="d-label">{t('shell.status.node')}</dt><dd>{account?.instance?.name ?? t('shell.status.unknown')}</dd></div>
          <div className="dw-you__fact"><dt className="d-label">{t('shell.status.link')}</dt>
            <dd><StateDot tone={tone} /><span>{t(`shell.status.${status}`)}</span></dd></div>
          <div className="dw-you__fact"><dt className="d-label">{t('shell.status.gen')}</dt><dd>{connection?.generation ?? t('shell.status.unknown')}</dd></div>
          <div className="dw-you__fact"><dt className="d-label">{t('shell.status.devices')}</dt><dd>{devicesChunk(devices)}</dd></div>
        </dl>
      </section>
      <h2 id="dw-you-settings" className="d-label dw-you__listhead">{t('you.settings')}</h2>
      <ul className="dw-phone-list dw-you__sections" aria-labelledby="dw-you-settings">
        {NAV.map(item => (
          <li key={item.id}>
            <button type="button" className="dw-phone-row" data-settings-section={item.id} onClick={() => props.onOpenSettings(item.id)}>
              <Icon name={SECTION_ICON[item.id]} size={20} />
              <span className="dw-phone-row__text"><span>{t(item.key)}</span></span>
              <Icon name={CHEVRON} size={18} />
            </button>
          </li>
        ))}
      </ul>
      <div className="dw-you__signout"><SignOutAction /></div>
    </div>
  );
}
