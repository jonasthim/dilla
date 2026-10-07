import { SettingsFrame, SettingsNav } from '@dilla/ui';
import { routeOf, useRoute, type SettingsSection } from '../router.ts';
import { t, type StringKey } from '../strings/index.ts';
import { Appearance } from './settings/Appearance.tsx';
import { Devices } from './settings/Devices.tsx';
import { Notifications } from './settings/Notifications.tsx';

const NAV: readonly { id: SettingsSection; key: StringKey }[] = [
  { id: 'devices', key: 'settings.nav.devices' },
  { id: 'notifications', key: 'settings.nav.notifications' },
  { id: 'appearance', key: 'settings.nav.appearance' },
];

/**
 * The Settings dialog of a settings route (L-TS-27, L-UI-24), and nothing for any other route. A section switch
 * replaces the history entry, so opening Settings adds one entry however many sections are visited; Escape and
 * the close button replace it with the route Settings was opened from, or `/`.
 */
export function Settings(): React.JSX.Element {
  const [route, navigate] = useRoute();
  if (route.name !== 'settings') return <></>;
  const { section, from } = route;

  const select = (id: string) => {
    switch (id) {
      case 'devices': case 'notifications': case 'appearance':
        navigate({ name: 'settings', section: id, from }, true);
        break;
      default: break;
    }
  };
  const close = () => navigate(from === null ? { name: 'root' } : routeOf(from), true);

  return (
    <SettingsFrame open title={t('settings.title')} closeLabel={t('settings.close')} onClose={close}
      nav={<SettingsNav label={t('settings.nav.label')} items={NAV.map(i => ({ id: i.id, label: t(i.key) }))}
        activeId={section} onSelect={select} />}>
      {section === 'devices' ? <Devices /> : section === 'notifications' ? <Notifications /> : <Appearance />}
    </SettingsFrame>
  );
}
