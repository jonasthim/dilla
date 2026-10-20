import type { Meta, StoryObj } from '@storybook/react-vite';
import { ManageList } from './ManageList.tsx';
import { SettingsFrame } from '../SettingsFrame/SettingsFrame.tsx';
import { PhoneLayoutProvider } from '../internal/phoneLayout.ts';

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

const channels = [
  { id: 'c1', title: 'general', detail: ['text'], action: null, edit: { ariaLabel: 'edit general' }, remove: { ariaLabel: 'delete general' } },
  { id: 'c2', title: 'standup', detail: ['voice'], action: null, edit: { ariaLabel: 'edit standup' }, remove: { ariaLabel: 'delete standup' } },
  // The built-in AFK channel is fixed: no delete (R39), and the slot stays reserved.
  { id: 'c3', title: 'AFK', detail: ['voice, built in'], action: null, fixed: true, edit: { ariaLabel: 'edit AFK' }, remove: { ariaLabel: 'delete AFK' } },
];
export const Channels: Story = { args: { label: 'channels', rows: channels, onEdit: () => {}, onDelete: () => {} } };
export const ChannelBusy: Story = { args: { label: 'channels', rows: channels, busyId: 'c1', onEdit: () => {}, onDelete: () => {} } };
// Privacy rows (I7): one ghost button per row in the trailing area.
export const Privacy: Story = {
  args: {
    label: 'members',
    rows: [
      { id: 'm1', title: 'Astrid', detail: ['can see your status'], action: { label: 'hide', ariaLabel: 'hide status from Astrid' } },
      { id: 'm2', title: 'Bjorn', detail: ['cannot see your status'], action: { label: 'show', ariaLabel: 'show status to Bjorn' } },
    ],
  },
};
// A phone frame: 44px icon buttons and 44px slots, the name wraps, nothing clips at 390.
export const Phone: Story = {
  args: { label: 'channels', rows: channels, onEdit: () => {}, onDelete: () => {} },
  parameters: { layout: 'fullscreen' },
  decorators: [Story => (
    <PhoneLayoutProvider value>
      <SettingsFrame open modal={false} title="Settings" closeLabel="Close settings" onClose={() => {}} nav={<span />}><Story /></SettingsFrame>
    </PhoneLayoutProvider>
  )],
};
