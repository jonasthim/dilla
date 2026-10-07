import type { Meta, StoryObj } from '@storybook/react-vite';
import { CommunityRail } from './CommunityRail.tsx';

const meta = {
  title: 'Shell/CommunityRail', component: CommunityRail,
  args: { label: 'servers', items: [{ id: 'a1', name: 'Midgard Crew' }, { id: 'b2', name: 'Night Owls' }, { id: 'c3', name: 'raid planning' }],
    activeId: 'a1', onSelect: () => {}, joinLabel: 'join a server', onJoin: () => {} },
  decorators: [Story => <div style={{ width: 60, height: 320 }}><Story /></div>],
} satisfies Meta<typeof CommunityRail>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const NoneActive: Story = { args: { activeId: null } };
export const Empty: Story = { args: { items: [], activeId: null } };
export const Badges: Story = { args: { items: [{ id: 'a1', name: 'Midgard Crew' }, { id: 'b2', name: 'Night Owls', unread: 4 }, { id: 'c3', name: 'raid planning', unread: 120, mentions: 2 }] } };
export const WithSettings: Story = { args: { settingsLabel: 'settings', onSettings: () => {} } };
