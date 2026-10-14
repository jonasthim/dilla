import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChannelSettings } from './ChannelSettings.tsx';

const meta = {
  title: 'Shell/ChannelSettings', component: ChannelSettings,
  args: {
    open: true, kind: 'text', name: 'ship-talk', topic: 'Where the crew plans trips.', parent: '',
    parents: [{ value: '', label: 'no category' }, { value: 'c1', label: 'Text channels' }, { value: 'c2', label: 'Voice channels' }],
    error: null, busy: false,
    labels: {
      title: 'Edit #ship-talk',
      name: 'Channel name',
      nameHint: 'Up to 100 bytes. The host can read it.',
      topic: 'Topic',
      topicHint: 'Up to 1024 bytes. The host can read it.',
      category: 'Category',
      submit: 'Save',
      busy: 'Saving…',
      close: 'Close',
    },
    onName: () => {}, onTopic: () => {}, onParent: () => {}, onSubmit: () => {}, onClose: () => {},
  },
} satisfies Meta<typeof ChannelSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Text: Story = {};
export const Voice: Story = { args: { kind: 'voice', name: 'Lounge' } };
export const Category: Story = { args: { kind: 'category', name: 'Text channels' } };
export const Refused: Story = { args: { error: 'You cannot edit this channel.' } };
export const Busy: Story = { args: { busy: true } };
