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
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TrustSummary } from '@dilla/client-core';

/** Why a comparison cannot go on, as Copy-table text (W-04): never a raw code inside the trust ceremony. */
type CompareError = 'privacy.loadFailed' | 'privacy.keyMoved' | 'privacy.verifyFailed' | 'privacy.noShared';
function compareError(code: string, step: 'load' | 'verify'): CompareError {
  if (code === 'E_DEVICE_LIST_STALE' || code === 'E_UMK_CHANGED') return 'privacy.keyMoved';
  if (code === 'E_CORE_NOT_FOUND') return 'privacy.noShared';
  return step === 'load' ? 'privacy.loadFailed' : 'privacy.verifyFailed';
}
/** The state a comparison shows: changed covers a pending key and a changed-key verdict alike (C1). */
function compareState(record: TrustSummary): 'first-seen' | 'changed' | 'verified' | 'unlisted' {
  if (record.changedUmk !== null || record.blocked === 'E_UMK_CHANGED') return 'changed';
  return record.unlisted === true ? 'unlisted' : record.verified ? 'verified' : 'first-seen';
}

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
  const account = useSlice('account');
  const [comparison, setComparison] = useState<{ record: TrustSummary; umk: string; number: string | null; error: CompareError | null } | null>(null);
  // After an approval the compared row changes under the dialog, so focus goes to the Privacy heading (W-11, P7).
  const focusHeading = useRef(false);
  useEffect(() => {
    if (comparison !== null || !focusHeading.current) return;
    focusHeading.current = false;
    document.querySelector<HTMLElement>('[data-privacy-heading]')?.focus();
  }, [comparison]);
  const failCompare = (userId: string, umk: string, error: CompareError) =>
    setComparison(current => current?.record.userId === userId && current.umk === umk ? { ...current, error } : current);
  const compare = (record: TrustSummary) => {
    // The page names the key it compares; the core works out the digits for exactly that key (ABI 8).
    const umk = record.changedUmk ?? record.umk;
    setComparison({ record, umk, number: null, error: null });
    void client.call({ m: 'safetyNumber', userId: record.userId, umk }).then(result => {
      const live = client.get('trust')?.find(row => row.userId === record.userId);
      if (typeof result !== 'string') { failCompare(record.userId, umk, 'privacy.loadFailed'); return; }
      if ((live?.changedUmk ?? live?.umk) !== umk) { failCompare(record.userId, umk, 'privacy.keyMoved'); return; }
      setComparison(current => current?.record.userId === record.userId && current.umk === umk ? { ...current, number: result } : current);
    }).catch((e: unknown) => failCompare(record.userId, umk, compareError(errorOf(e).code, 'load')));
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
            instanceName={account?.instance?.name ?? null} writeText={text => navigator.clipboard?.writeText(text) ?? Promise.resolve()} />}
      <SafetyCompare open={comparison !== null} contactName={comparison?.record.name ?? ''}
        state={comparison === null ? 'first-seen' : compareState(comparison.record)}
        approvedUmk={comparison?.umk ?? null} groups={comparison?.number?.split(' ') ?? []}
        canVerify={comparison !== null && comparison.record.shared && comparison.record.unlisted !== true && comparison.number !== null
          && comparison.error !== 'privacy.keyMoved'}
        error={comparison?.error ? t(comparison.error) : null}
        labels={{ title: t('privacy.title'), copy: t('privacy.copy'), verify: t('privacy.verify'), close: t('dialog.close'), loading: t('privacy.loading'),
          instructions: t('privacy.instructions'), confirm: t('privacy.confirm'), firstSeen: t('privacy.firstSeen', { name: comparison?.record.name ?? '' }),
          states: { 'first-seen': t('privacy.firstSeenLabel'), changed: t('privacy.changed'), verified: t('privacy.verifiedLabel'),
            unlisted: t('privacy.unlisted') } }}
        onCopy={() => { if (comparison?.number) void navigator.clipboard?.writeText(comparison.number); }}
        onVerify={umk => {
          if (comparison?.umk !== umk || comparison.number === null) return;
          const { userId } = comparison.record;
          void client.call({ m: 'verifyContact', userId, umk }).then(() => {
            focusHeading.current = true;
            setComparison(current => current?.record.userId === userId && current.umk === umk ? null : current);
          }).catch((e: unknown) => failCompare(userId, umk, compareError(errorOf(e).code, 'verify')));
        }}
        onClose={() => setComparison(null)} />
    </SettingsFrame>
  );
}
