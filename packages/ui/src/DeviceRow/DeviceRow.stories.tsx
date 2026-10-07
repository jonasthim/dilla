import type { Meta, StoryObj } from '@storybook/react-vite';
import { DeviceRow } from './DeviceRow.tsx';

// Every string is L-COPY-02's (devices.*); names are the first eight hex characters of a device id (flow 03).
const meta = {
  title: 'Settings/DeviceRow', component: DeviceRow,
  args: { name: '3f9a2c1d', tier: 'web', tierLabel: 'browser' },
  decorators: [Story => <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0, maxWidth: 640 }}><Story /></ul>],
} satisfies Meta<typeof DeviceRow>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ThisBrowser: Story = { args: { own: true, ownLabel: 'this browser', lastSeen: 'last seen 21:04' } };
export const OtherBrowser: Story = { args: { name: '7c01e5aa', lastSeen: 'last seen 5 Oct 2026', action: { label: 'remove', onAction: () => {} } } };
export const App: Story = { args: { name: 'b2d4e6f8', tier: 'native', tierLabel: 'app', lastSeen: 'last seen 21:02', action: { label: 'remove', onAction: () => {} } } };
// An unlisted live row is removed without the recovery key (ruling 30), so it carries the action too.
export const Unlisted: Story = { args: { name: '0a1b2c3d', state: 'not yet in the device list', lastSeen: 'last seen 20:40', action: { label: 'remove', onAction: () => {} } } };
export const Removed: Story = { args: { name: '99ee0f11', state: 'removed', lastSeen: 'last seen 1 Oct 2026' } };
