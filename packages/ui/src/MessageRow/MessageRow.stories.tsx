import type { Meta, StoryObj } from '@storybook/react-vite';
import { MessageRow } from './MessageRow.tsx';

// The state strings are task 24's to own in en.ts; these are the drafts it starts from.
const meta = {
  title: 'Conversation/MessageRow', component: MessageRow,
  args: { author: 'ada', time: '21:02', body: 'anyone up for a round tonight?', state: 'ok' },
  decorators: [Story => <div style={{ maxWidth: 720 }}><Story /></div>],
} satisfies Meta<typeof MessageRow>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ok: Story = {};
export const Own: Story = { args: { author: 'mira', body: 'count me in', own: true } };
export const Web: Story = { args: { author: 'björn', body: 'after nine, still on the boat', tag: 'web' } };
export const Bot: Story = { args: { author: 'loot-bot', body: 'weekly reset in 2 h', tag: 'bot' } };
export const Pending: Story = { args: { author: 'mira', body: 'count me in', own: true, state: 'pending', stateLabel: 'sending' } };
export const Failed: Story = { args: { author: 'mira', body: 'count me in', own: true, state: 'failed', stateLabel: 'not sent', detail: 'E_TOO_LARGE',
  actions: [{ label: 'retry', onAction: () => {} }, { label: 'discard', onAction: () => {} }] } };
export const CannotRead: Story = { args: { state: 'cannot-read', stateLabel: 'This message could not be read on this device.', detail: 'E_SENDER_MISMATCH' } };
export const Deleted: Story = { args: { state: 'deleted', stateLabel: 'message deleted' } };
export const Multiline: Story = { args: { body: 'route for tonight:\n1. harbour\n2. the old mill\n3. back by midnight' } };
