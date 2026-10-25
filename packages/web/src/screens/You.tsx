import { useEffect } from 'react';
import { Avatar, Icon, PhoneHeader, StateDot } from '@dilla/ui';
import { useCore } from '../core/context.tsx';
import { useSlice, useSlices } from '../core/use-slice.ts';
import type { SettingsSection } from '../router.ts';
import { t } from '../strings/index.ts';
import { devicesChunk, mergeMembers, selfName } from './shell-model.ts';
import { SignOutAction } from './settings/SignOut.tsx';
import { PresencePicker } from './PresencePicker.tsx';

const CHEVRON = 'chevron-right';
/**
 * The phone's You tab (flow 12): who this is, the four facts the desktop holds in Settings → Diagnostics (this device's node, link,
 * generation and devices), one entry to the settings index, and sign out.
 */
export function You(props: { onOpenSettings(section: SettingsSection | null): void }): React.JSX.Element {
  const client = useCore();
  const account = useSlice('account');
  const connection = useSlice('connection');
  const devices = useSlice('devices');
  const communities = useSlice('communities');
  const memberLists = useSlices((communities ?? []).map(c => `members:${c.id}` as const));
  const self = account?.user ?? null;
  const name = selfName(self, mergeMembers(memberLists));
  // The device list, once per mount, for the devices fact; a refusal leaves the fact unknown.
  useEffect(() => {
    client.call({ m: 'refreshDevices' }).catch(() => undefined);
  }, [client]);
  const status = connection?.status ?? 'connecting';
  const tone = status === 'online' ? 'ok' : status === 'connecting' ? 'pending' : 'danger';
  return (
    <div className="dw-phone-pane dw-you">
      <PhoneHeader title={t('you.title')} />
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
        <li>
          <button type="button" className="dw-phone-row" data-settings-section="index" onClick={() => props.onOpenSettings(null)}>
            <Icon name="settings" size={20} />
            <span className="dw-phone-row__text"><span>{t('workspace.open')}</span></span>
            <Icon name={CHEVRON} size={18} />
          </button>
        </li>
      </ul>
      <div className="dw-you__signout"><SignOutAction icon /></div>
    </div>
  );
}
