import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, DeviceSummary } from '@dilla/client-core';
import { Banner, Button, DeviceRow, Dialog } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { errorOf, type UiError } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';
import { messageTime } from '../shell-model.ts';
import { KeyDialog } from './KeyDialog.tsx';

const TITLE_ID = 'devices-title';

type Target = { kind: 'revoke'; deviceId: string } | { kind: 'removeUnlisted'; deviceId: string }
  | { kind: 'signOut' } | { kind: 'forget' } | null;

function byId(a: DeviceSummary, b: DeviceSummary): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The device list in display order: this device first, then the devices that are not removed by last seen
 * (newest first), then the removed ones by when they were removed (newest first); ties by id. Returns a new array.
 */
export function orderDevices(devices: readonly DeviceSummary[]): DeviceSummary[] {
  return [...devices].sort((a, b) => {
    if (a.own !== b.own) return a.own ? -1 : 1;
    if (a.revokedAt === null && b.revokedAt !== null) return -1;
    if (a.revokedAt !== null && b.revokedAt === null) return 1;
    if (a.revokedAt === null || b.revokedAt === null) return b.lastSeen - a.lastSeen || byId(a, b);
    return b.revokedAt - a.revokedAt || byId(a, b);
  });
}

/**
 * Settings → Devices (flow 03; Q13, rulings 17, 30, 33). It asks the worker for a fresh list once per mount. A
 * listed device is removed with the recovery key; a live device in no signed list is removed without it (the
 * worker decides from its own refreshed list, so this page's choice of dialog grants nothing). After a sign-out
 * or a forget the worker wipes the store and publishes `cleared`, which the App answers with a reload: nothing
 * here navigates. After a removal the opener's row has no button any more, so focus goes to the heading.
 */
export function Devices(): React.JSX.Element {
  const client = useCore();
  const devices = useSlice('devices');
  const [target, setTarget] = useState<Target>(null);
  const [loadError, setLoadError] = useState<UiError | null>(null);
  const [plainBusy, setPlainBusy] = useState(false);
  const [plainError, setPlainError] = useState<UiError | null>(null);
  const plainRunning = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Set by a resolved removal; read once the dialog has closed (its own close effect runs first, as a child's).
  const focusHeading = useRef(false);

  const refresh = useCallback(() => {
    setLoadError(null);
    client.call({ m: 'refreshDevices' }).catch((e: unknown) => setLoadError(errorOf(e)));
  }, [client]);
  useEffect(refresh, [refresh]);

  useEffect(() => {
    if (target !== null || !focusHeading.current) return;
    focusHeading.current = false;
    headingRef.current?.focus();
  }, [target]);

  const choose = (next: Target) => {
    setPlainError(null);
    setTarget(next);
  };
  const close = () => { if (!plainRunning.current) setTarget(null); };

  const confirmPlain = async (command: Command, removal: boolean) => {
    if (plainRunning.current) return;
    plainRunning.current = true;
    setPlainBusy(true);
    setPlainError(null);
    try {
      await client.call(command);
      if (removal) focusHeading.current = true;
      setTarget(null);
    } catch (e) {
      setPlainError(errorOf(e));
    } finally {
      plainRunning.current = false;
      setPlainBusy(false);
    }
  };

  const ordered = devices === undefined ? [] : orderDevices(devices);
  const live = devices?.filter(d => d.revokedAt === null).length;
  const count = live === undefined ? t('devices.cap.other', { n: t('shell.status.unknown') })
    : live === 1 ? t('devices.cap.one') : t('devices.cap.other', { n: live });
  const now = Date.now();

  const revokeId = target?.kind === 'revoke' ? target.deviceId : null;
  const unlistedId = target?.kind === 'removeUnlisted' ? target.deviceId : null;
  const plainBanner = plainError === null ? null : <Banner tone="danger">{t('settings.error.other', { code: plainError.code })}</Banner>;
  const plainConfirm = (label: 'devices.confirmRevoke' | 'devices.confirmForget', onPress: () => void) => (
    <Button variant="danger" onClick={onPress} {...(plainBusy ? { 'aria-disabled': true } : {})}>
      {plainBusy ? t('devices.working') : t(label)}
    </Button>
  );

  return (
    <section className="dw-settings-section" aria-labelledby={TITLE_ID}>
      <h2 id={TITLE_ID} ref={headingRef} tabIndex={-1} className="dw-settings-heading">{t('devices.title')}</h2>
      {loadError === null ? null : <Banner tone="danger">{t('settings.error.other', { code: loadError.code })}</Banner>}
      <p>{t('devices.body')}</p>
      <ul className="dw-device-list">
        {ordered.map(d => (
          <DeviceRow key={d.id} name={d.id.slice(0, 8)} tier={d.tier === 1 ? 'web' : 'native'}
            tierLabel={t(d.tier === 1 ? 'devices.tier.web' : 'devices.tier.native')}
            own={d.own} ownLabel={d.own ? t('devices.thisBrowser') : undefined}
            state={d.revokedAt !== null ? t('devices.revoked') : !d.listed ? t('devices.unlisted') : undefined}
            lastSeen={d.lastSeen > 0 ? t('devices.lastSeen', { when: messageTime(d.lastSeen, now) }) : undefined}
            action={d.revokedAt === null && !d.own ? {
              label: t('devices.revoke'), danger: true,
              onAction: () => choose(d.listed ? { kind: 'revoke', deviceId: d.id } : { kind: 'removeUnlisted', deviceId: d.id }),
            } : undefined} />
        ))}
      </ul>
      <div className="dw-settings-actions">
        <p>{count}</p>
        <Button size="sm" onClick={refresh}>{t('devices.refresh')}</Button>
      </div>
      <div className="dw-settings-actions dw-settings-actions--below">
        <Button variant="danger" onClick={() => choose({ kind: 'signOut' })}>{t('devices.signOut')}</Button>
        <Button onClick={() => choose({ kind: 'forget' })}>{t('devices.forget')}</Button>
      </div>

      <KeyDialog open={revokeId !== null} id="devices-revoke" title={t('devices.revokeTitle')} body={t('devices.revokeBody')}
        confirmLabel={t('devices.confirmRevoke')} onClose={() => setTarget(null)}
        onConfirm={async key => {
          if (revokeId === null) return;
          await client.call({ m: 'revokeDevice', deviceId: revokeId, recoveryKey: key });
          focusHeading.current = true;
        }} />
      <KeyDialog open={target?.kind === 'signOut'} id="devices-signout" title={t('devices.signOutTitle')} body={t('devices.signOutBody')}
        confirmLabel={t('devices.confirmSignOut')} onClose={() => setTarget(null)}
        onConfirm={key => client.call({ m: 'signOutRevoke', recoveryKey: key })} />
      <Dialog open={unlistedId !== null} title={t('devices.removeUnlistedTitle')} closeLabel={t('dialog.close')} onClose={close}
        footer={plainConfirm('devices.confirmRevoke', () => {
          if (unlistedId !== null) void confirmPlain({ m: 'revokeDevice', deviceId: unlistedId, recoveryKey: null }, true);
        })}>
        {plainBanner}
        <p>{t('devices.removeUnlistedBody')}</p>
      </Dialog>
      <Dialog open={target?.kind === 'forget'} title={t('devices.forgetTitle')} closeLabel={t('dialog.close')} onClose={close}
        footer={plainConfirm('devices.confirmForget', () => { void confirmPlain({ m: 'forgetBrowser' }, false); })}>
        {plainBanner}
        <p>{t('devices.forgetBody')}</p>
      </Dialog>
    </section>
  );
}
