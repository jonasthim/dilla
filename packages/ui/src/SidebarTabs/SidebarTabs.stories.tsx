import type { Meta, StoryObj } from '@storybook/react-vite';
import { SidebarTabs } from './SidebarTabs.tsx';

// Every string is L-COPY-02's (shell.tabs.*).
const meta = {
  title: 'Shell/SidebarTabs', component: SidebarTabs,
  args: { label: 'sidebar', activeId: 'channels', onSelect: () => {},
    tabs: [{ id: 'channels', label: 'channels' }, { id: 'dms', label: 'direct messages', count: 3 }] },
  decorators: [Story => <div style={{ width: 240, background: 'var(--bg-2)' }}><Story /></div>],
} satisfies Meta<typeof SidebarTabs>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Channels: Story = {};
export const DirectMessages: Story = { args: { activeId: 'dms',
  tabs: [{ id: 'channels', label: 'channels', count: 12 }, { id: 'dms', label: 'direct messages', count: 3, mentions: 2 }] } };
export const Quiet: Story = { args: { tabs: [{ id: 'channels', label: 'channels' }, { id: 'dms', label: 'direct messages' }] } };
