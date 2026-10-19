import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemberList } from './MemberList.tsx';

const kickBan = [{ id: 'kick', label: 'kick' }, { id: 'ban', label: 'ban', danger: true }];
const meta = {
  title: 'Shell/MemberList', component: MemberList,
  args: {
    label: 'members', loading: false, loadingLabel: 'Loading members…', emptyLabel: 'No members yet.', onAction: () => {},
    groups: [
      { id: 'mods', title: 'moderators', color: 0xe74c3c, members: [{ id: 'u1', name: 'Astrid', tags: ['owner'], actionsLabel: 'actions for Astrid', actions: [], color: 0xe74c3c }] },
      { id: 'members', title: 'members', members: [
        { id: 'u2', name: 'Bjorn', tags: [], actionsLabel: 'actions for Bjorn', actions: kickBan, color: 0x3498db },
        { id: 'u3', name: 'Sigrid', tags: ['you'], actionsLabel: 'actions for Sigrid', actions: [] },
      ] },
    ],
  },
  decorators: [Story => <div style={{ width: '16rem', minHeight: '14rem' }}><Story /></div>],
} satisfies Meta<typeof MemberList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = { args: { groups: [] } };
