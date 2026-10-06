import type { Meta, StoryObj } from '@storybook/react-vite';
import { SettingsFrame } from './SettingsFrame.tsx';
import { SettingsNav } from '../SettingsNav/SettingsNav.tsx';
import { SettingsRow } from '../SettingsRow/SettingsRow.tsx';
import { Segmented } from '../Segmented/Segmented.tsx';
import { Toggle } from '../Toggle/Toggle.tsx';
import { DeviceRow } from '../DeviceRow/DeviceRow.tsx';
import { Button } from '../Button/Button.tsx';

// Every string is L-COPY-02's (settings.*, devices.*, notify.*). The composed Screens/Settings stories of
// task 19 quote en.ts; these show the frame itself.
const meta: Meta = { title: 'Settings/SettingsFrame', parameters: { layout: 'fullscreen' } };
export default meta;
type Story = StoryObj;
const noop = () => {};
const ITEMS = [{ id: 'devices', label: 'devices' }, { id: 'notifications', label: 'notifications' }, { id: 'appearance', label: 'appearance' }];
const NOTIFY = [{ value: 'dms-mentions', label: 'direct messages and mentions' }, { value: 'everything', label: 'every message' }, { value: 'nothing', label: 'nothing' }];
const MODES = [{ value: 'default', label: 'default' }, { value: 'all', label: 'all' }, { value: 'mentions', label: 'mentions' }, { value: 'nothing', label: 'nothing' }];
const remove = { label: 'remove', onAction: noop };

function DevicesSection() {
  return (
    <section aria-labelledby="devices-title">
      <h2 id="devices-title">Devices</h2>
      <p>Every browser and app signed in to your account. Removing a device needs your recovery key.</p>
      <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        <DeviceRow name="3f9a2c1d" tier="web" tierLabel="browser" own ownLabel="this browser" lastSeen="last seen 21:04" />
        <DeviceRow name="b2d4e6f8" tier="native" tierLabel="app" lastSeen="last seen 21:02" action={remove} />
        <DeviceRow name="0a1b2c3d" tier="web" tierLabel="browser" state="not yet in the device list" lastSeen="last seen 20:40" action={remove} />
        <DeviceRow name="99ee0f11" tier="web" tierLabel="browser" state="removed" lastSeen="last seen 1 Oct 2026" />
      </ul>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.75rem 0' }}>
        <span>3 devices</span>
        <Button>refresh</Button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', paddingTop: '0.75rem', borderTop: '1px solid var(--hairline)' }}>
        <Button variant="danger">Sign out and remove this browser</Button>
        <Button>Forget this browser</Button>
      </div>
    </section>
  );
}

function NotificationsSection() {
  return (
    <section aria-labelledby="notify-title">
      <h2 id="notify-title">Notifications</h2>
      <p>Desktop notifications show while a dilla tab is open. Nothing is shown when every tab is closed.</p>
      <SettingsRow id="notify-permission" label="desktop notifications"><Button variant="accent">turn on</Button></SettingsRow>
      <SettingsRow id="notify-default" label="notify me about">
        <Segmented id="notify-default-control" label="notify me about" options={NOTIFY} value="dms-mentions" onChange={noop} />
      </SettingsRow>
      <h3>Per channel</h3>
      <p>Every channel and direct message. Rows left on default follow the choice above.</p>
      <SettingsRow id="notify-general" label="#general · Midgard Crew">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
          <Segmented id="notify-general-mode" label="#general · Midgard Crew" options={MODES} value="all" onChange={noop} />
          <Toggle id="mute-general" label="mute" checked={false} onChange={noop} showLabel />
        </div>
      </SettingsRow>
      <SettingsRow id="notify-random" label="#random · Midgard Crew">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
          <Segmented id="notify-random-mode" label="#random · Midgard Crew" options={MODES} value="nothing" onChange={noop} />
          <Toggle id="mute-random" label="mute" checked onChange={noop} showLabel />
        </div>
      </SettingsRow>
      <SettingsRow id="notify-ada" label="ada">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
          <Segmented id="notify-ada-mode" label="ada" options={MODES} value="default" onChange={noop} />
          <Toggle id="mute-ada" label="mute" checked={false} onChange={noop} showLabel />
        </div>
      </SettingsRow>
    </section>
  );
}

function Frame({ section }: { section: 'devices' | 'notifications' }) {
  return (
    <SettingsFrame open title="Settings" closeLabel="Close settings" onClose={noop}
      nav={<SettingsNav label="settings sections" items={ITEMS} activeId={section} onSelect={noop} />}>
      {section === 'devices' ? <DevicesSection /> : <NotificationsSection />}
    </SettingsFrame>
  );
}

export const Devices: Story = { render: () => <Frame section="devices" /> };
export const Notifications: Story = { render: () => <Frame section="notifications" /> };
// 360 × 740 through the frame's own size variables: the container query stacks the navigation.
export const Narrow: Story = {
  render: () => <div style={{ ['--d-settings-w' as string]: '22.5rem', ['--d-settings-h' as string]: '46.25rem' }}><Frame section="devices" /></div>,
};
