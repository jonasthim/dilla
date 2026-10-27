import type { Meta, StoryObj } from '@storybook/react-vite';
import { TabBar, type TabBarItem } from './TabBar.tsx';

// Switch the theme in the toolbar (signal, light, high-contrast). A real 390px phone width.
const meta = { title: 'Shell/TabBar', component: TabBar, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof TabBar>;
export default meta;
type Story = StoryObj<typeof meta>;

const items = (current: string): TabBarItem[] => [
  { id: 'servers', label: 'servers', href: '#servers', icon: 'server', current: current === 'servers' },
  { id: 'dms', label: 'dms', href: '#dms', icon: 'message-square', current: current === 'dms', count: 3, countLabel: 'dms, 3 unread' },
  { id: 'activity', label: 'activity', href: '#activity', icon: 'activity', current: current === 'activity', count: 120, countLabel: 'activity, 120 unread' },
  { id: 'you', label: 'you', href: '#you', icon: 'user', current: current === 'you' },
];

export const Counts: Story = {
  args: { label: 'main', items: items('servers'), onSelect: () => {} },
  render: args => <div style={{ maxWidth: 390 }}><TabBar {...args} /></div>,
};
export const CurrentYou: Story = {
  args: { label: 'main', items: items('you'), onSelect: () => {} },
  render: args => <div style={{ maxWidth: 390 }}><TabBar {...args} /></div>,
};
