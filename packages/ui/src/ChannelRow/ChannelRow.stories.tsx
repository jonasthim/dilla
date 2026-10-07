import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChannelRow } from './ChannelRow.tsx';
const meta = { title: 'Primitives/ChannelRow', component: ChannelRow, args: { onSelect: () => {} },
  decorators: [Story => <div style={{ width: 240, background: 'var(--bg-2)', padding: 8 }}><Story /></div>] } satisfies Meta<typeof ChannelRow>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Text: Story = { args: { name: 'general', kind: 'text' } };
export const Active: Story = { args: { name: 'loot', kind: 'text', active: true, unread: 4 } };
export const Mentions: Story = { args: { name: 'screenshots', kind: 'text', unread: 3, mentions: 12 } };
export const ReadableByServer: Story = { args: { name: 'lfg', kind: 'text', readable: true } };
export const Voice: Story = { args: { name: 'longhouse', kind: 'voice' } };
export const PrivateVoice: Story = { args: { name: 'sauna', kind: 'voice', private: true } };
export const Muted: Story = { args: { name: 'random', kind: 'text', muted: true } };
export const DirectMessage: Story = { args: { name: 'ada', kind: 'dm', unread: 2 } };
export const MutedWithMention: Story = { args: { name: 'random', kind: 'text', unread: 7, mentions: 2, muted: true } };
