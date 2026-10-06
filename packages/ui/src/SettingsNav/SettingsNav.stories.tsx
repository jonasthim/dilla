import type { Meta, StoryObj } from '@storybook/react-vite';
import { SettingsNav } from './SettingsNav.tsx';

// Every string is L-COPY-02's (settings.nav.*).
const meta = {
  title: 'Settings/SettingsNav', component: SettingsNav,
  args: { label: 'settings sections', activeId: 'devices', onSelect: () => {},
    items: [{ id: 'devices', label: 'devices' }, { id: 'notifications', label: 'notifications' }, { id: 'appearance', label: 'appearance' }] },
  decorators: [Story => <div style={{ width: '13.75rem', padding: '0.875rem 0.625rem', background: 'var(--bg-2)' }}><Story /></div>],
} satisfies Meta<typeof SettingsNav>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Devices: Story = {};
export const Notifications: Story = { args: { activeId: 'notifications' } };
