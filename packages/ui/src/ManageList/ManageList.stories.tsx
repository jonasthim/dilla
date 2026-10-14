import type { Meta, StoryObj } from '@storybook/react-vite';
import { ManageList } from './ManageList.tsx';

const meta = {
  title: 'Settings/ManageList', component: ManageList,
  args: {
    label: 'invites', emptyLabel: 'No invites yet.', busyId: null, onAction: () => {},
    rows: [
      { id: 'i1', title: 'Invite 1', detail: ['made by Astrid', '3 of 10 uses'], action: { label: 'revoke', ariaLabel: 'revoke invite 1' } },
      { id: 'i2', title: 'Invite 2', detail: ['made by Bjorn'], action: { label: 'revoke', ariaLabel: 'revoke invite 2' } },
      { id: 'i3', title: 'Invite 3', detail: ['ended 2026-10-01'], action: null },
    ],
  },
  decorators: [Story => <div style={{ width: '24rem', padding: '1rem' }}><Story /></div>],
} satisfies Meta<typeof ManageList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Busy: Story = { args: { busyId: 'i1' } };
export const Empty: Story = { args: { rows: [] } };
