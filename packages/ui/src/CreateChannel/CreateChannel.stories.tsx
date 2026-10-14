import type { Meta, StoryObj } from '@storybook/react-vite';
import { CreateChannel } from './CreateChannel.tsx';

// Every string is flow 07's (docs/design/flows/07-create.md), as en.ts holds it.
const meta = {
  title: 'Shell/CreateChannel', component: CreateChannel,
  args: {
    open: true, kind: 'text', name: '', hint: 'Up to 100 bytes.', error: null, busy: false,
    labels: {
      title: 'New channel in Midgard Crew',
      kind: 'Kind',
      text: 'text',
      voice: 'voice',
      name: 'Channel name',
      submit: 'Create',
      busy: 'Creating…',
      close: 'Close',
    },
    onKind: () => {}, onName: () => {}, onSubmit: () => {}, onClose: () => {},
  },
} satisfies Meta<typeof CreateChannel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Text: Story = {};
export const Typed: Story = { args: { name: 'Ship Talk', hint: 'Shown as #ship-talk. Up to 100 bytes.' } };
export const Voice: Story = { args: { kind: 'voice', name: 'Lounge', hint: 'Shown as Lounge. Up to 100 bytes.' } };
export const Refused: Story = { args: { name: 'ship-talk', hint: 'Shown as #ship-talk. Up to 100 bytes.', error: 'You cannot add channels to this server.' } };
export const Busy: Story = { args: { name: 'ship-talk', hint: 'Shown as #ship-talk. Up to 100 bytes.', busy: true } };
