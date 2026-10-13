import { SettingsFrame, SettingsNav } from '@dilla/ui';
import { routeOf, useRoute, type SettingsSection } from '../router.ts';
import { t, type StringKey } from '../strings/index.ts';
import { Appearance } from './settings/Appearance.tsx';
import { Devices } from './settings/Devices.tsx';
import { Notifications } from './settings/Notifications.tsx';
import { Privacy } from './settings/Privacy.tsx';
import { Diagnostics } from './settings/Diagnostics.tsx';
import { Keyboard } from './settings/Keyboard.tsx';
import { useSlice } from '../core/use-slice.ts';
import { useCore } from '../core/context.tsx';
import { errorOf } from '../core/errors.ts';
import { SafetyCompare } from '@dilla/ui';
import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRef } from 'react';
import type { TrustSummary } from '@dilla/client-core';

const NAV: readonly { id: SettingsSection; key: StringKey }[] = [
  { id: 'devices', key: 'settings.nav.devices' },
  { id: 'notifications', key: 'settings.nav.notifications' },
  { id: 'appearance', key: 'settings.nav.appearance' },
  { id: 'privacy', key: 'settings.nav.privacy' },
  { id: 'keyboard', key: 'settings.nav.keyboard' },
  { id: 'diagnostics', key: 'settings.nav.diagnostics' },
];

/**
 * The Settings dialog of a settings route (L-TS-27, L-UI-24), and nothing for any other route. A section switch
 * replaces the history entry, so opening Settings adds one entry however many sections are visited; Escape and
 * the close button replace it with the route Settings was opened from, or `/`.
 */
export function Settings(): React.JSX.Element {
  const [route, navigate] = useRoute();
  const client = useCore();
  const records = useSlice('trust') ?? [];
  const diagnostics = useSlice('diagnostics');
  const [comparison, setComparison] = useState<{ record: TrustSummary; umk: string; number: string | null } | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const compare = (record: TrustSummary) => {
    const umk = record.changedUmk ?? record.umk;
    setVerifyError(null);
    setComparison({ record, umk, number: null });
    void client.call({ m: 'safetyNumber', userId: record.userId }).then(result => {
      const live = client.get('trust')?.find(row => row.userId === record.userId);
      if (typeof result === 'string' && (live?.changedUmk ?? live?.umk) === umk)
        setComparison(current => current?.record.userId === record.userId && current.umk === umk ? { ...current, number: result } : current);
    }).catch(() => setComparison(current => current?.record.userId === record.userId ? null : current));
  };
  const section = route.name === 'settings' ? route.section : 'devices';
  const previousSection = useRef(section);
  useLayoutEffect(() => {
    if (route.name === 'settings' && previousSection.current !== section) document.querySelector<HTMLElement>('.d-settings-frame__body h2')?.focus();
    previousSection.current = section;
  }, [section, route.name]);
  if (route.name !== 'settings') return <></>;
  const { from } = route;

  const select = (id: string) => {
    switch (id) {
      case 'devices': case 'notifications': case 'appearance': case 'privacy': case 'keyboard': case 'diagnostics':
        if (id !== 'privacy') setComparison(null);
        navigate({ name: 'settings', section: id, from }, true);
        break;
      default: break;
    }
  };
  const close = () => { setComparison(null); navigate(from === null ? { name: 'root' } : routeOf(from), true); };

  return (
    <SettingsFrame open title={t('settings.title')} closeLabel={t('settings.close')} onClose={close}
      nav={<SettingsNav label={t('settings.nav.label')} items={NAV.map(i => ({ id: i.id, label: t(i.key) }))}
        activeId={section} onSelect={select} />}>
      {section === 'devices' ? <Devices /> : section === 'notifications' ? <Notifications /> : section === 'appearance' ? <Appearance />
        : section === 'privacy' ? <Privacy records={records} onCompare={compare} /> : section === 'keyboard' ? <Keyboard />
          : <Diagnostics data={diagnostics ?? { connection: 'offline', generation: null, instance: '', devices: 0, errors: [] }}
            writeText={text => navigator.clipboard?.writeText(text) ?? Promise.resolve()} />}
      {verifyError !== null && document.querySelector('.d-safety-compare')?.parentElement
        ? createPortal(<p role="alert">{t('shell.banner.commandError', { code: verifyError })}</p>, document.querySelector('.d-safety-compare')!.parentElement!) : null}
      <SafetyCompare open={comparison !== null} contactName={comparison?.record.name ?? ''}
        state={comparison === null ? 'first-seen' : comparison.record.changedUmk !== null ? 'changed'
          : comparison.record.unlisted === true ? 'unlisted' : comparison.record.verified ? 'verified' : 'first-seen'}
        approvedUmk={comparison?.umk ?? null} groups={comparison?.number?.split(' ') ?? []}
        canVerify={comparison !== null && comparison.record.shared && comparison.record.unlisted !== true && comparison.number !== null}
        labels={{ title: t('privacy.title'), copy: t('privacy.copy'), verify: t('privacy.verify'), close: t('settings.close'),
          instructions: t('privacy.instructions'), confirm: t('privacy.confirm'), firstSeen: t('privacy.firstSeen', { name: comparison?.record.name ?? '' }),
          states: { 'first-seen': t('privacy.firstSeenLabel'), changed: t('privacy.changed'), verified: t('privacy.verifiedLabel'),
            unlisted: t('privacy.unlisted') } }}
        onCopy={() => { if (comparison?.number) void navigator.clipboard?.writeText(comparison.number); }}
        onVerify={umk => {
          if (comparison?.umk !== umk || comparison.number === null) return;
          void client.call({ m: 'verifyContact', userId: comparison.record.userId, umk }).then(() => {
            setVerifyError(null);
            setComparison(null);
          }).catch(e => setVerifyError(errorOf(e).code));
        }}
        onClose={() => setComparison(null)} />
    </SettingsFrame>
  );
}
