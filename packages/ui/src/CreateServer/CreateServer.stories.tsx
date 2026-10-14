import type { Meta, StoryObj } from '@storybook/react-vite';
import { CreateServer } from './CreateServer.tsx';

// Every string is flow 07's (docs/design/flows/07-create.md), as en.ts holds it.
const meta = {
  title: 'Shell/CreateServer', component: CreateServer,
  args: {
    open: true, name: '', error: null, busy: false, partial: null,
    labels: {
      title: 'Start a server',
      body: 'You own it: you add its channels and invite people. It starts with a text channel and a voice channel, both called general.',
      name: 'Server name',
      hint: 'Up to 255 bytes.',
      submit: 'Create',
      busy: 'Creating…',
      close: 'Close',
      retry: 'Try again',
    },
    onName: () => {}, onSubmit: () => {}, onRetry: () => {}, onClose: () => {},
  },
} satisfies Meta<typeof CreateServer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const Typed: Story = { args: { name: 'Midgard Crew' } };
export const Refused: Story = { args: { name: '', error: 'Give the server a name.' } };
export const Busy: Story = { args: { name: 'Midgard Crew', busy: true } };
export const Partial = {
  args: { partial: 'Midgard Crew is ready, but its channels were not added (E_UNAVAILABLE). Try again, or close this and add them from the channel list.' },
} satisfies Story;
// The voice channel failed (flow 07): the notice names what is missing, and stays while the retry runs.
export const PartialVoice = {
  args: { partial: 'Midgard Crew is ready, but its voice channel general was not added (E_UNAVAILABLE). Try again, or close this and add it from the channel list.' },
} satisfies Story;
export const Retrying: Story = { args: { partial: PartialVoice.args.partial, busy: true } };
