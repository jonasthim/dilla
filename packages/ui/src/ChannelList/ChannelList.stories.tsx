import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChannelList } from './ChannelList.tsx';

const meta = {
  title: 'Shell/ChannelList', component: ChannelList,
  args: { label: 'channels', title: 'Midgard Crew', activeId: 'g', onSelect: () => {}, emptyLabel: 'No channels yet.',
    channels: [{ id: 'g', name: 'general', kind: 'text', readable: false }, { id: 't', name: 'loot', kind: 'text', readable: false }] },
  decorators: [Story => <div style={{ width: 240, height: 360 }}><Story /></div>],
} satisfies Meta<typeof ChannelList>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const WithVoiceAndReadable: Story = { args: { channels: [
  { id: 'g', name: 'general', kind: 'text', readable: false }, { id: 'l', name: 'lfg', kind: 'text', readable: true },
  { id: 't', name: 'loot', kind: 'text', readable: false }, { id: 'v', name: 'longhouse', kind: 'voice', readable: false },
] } };
export const Empty: Story = { args: { channels: [], activeId: null } };
