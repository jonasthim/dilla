import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChannelList } from './ChannelList.tsx';
import { SidebarTabs } from '../SidebarTabs/SidebarTabs.tsx';
import { Button } from '../Button/Button.tsx';

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

// L-COPY-02 shell.channels.rowLabel and rowLabelMuted, filled in as en.ts's t() will; shell.dms.new.
const ROW_LABEL = (c: { name: string; unread: number; mentions: number; muted: boolean }) =>
  c.muted ? `${c.name}, muted, mentions ${c.mentions}` : `${c.name}, unread ${c.unread}, mentions ${c.mentions}`;
const BADGED = [
  { id: 'g', name: 'general', kind: 'text', readable: false },
  { id: 'l', name: 'lfg', kind: 'text', readable: true, unread: 3 },
  { id: 't', name: 'loot', kind: 'text', readable: false, unread: 150 },
  { id: 's', name: 'screenshots', kind: 'text', readable: false, unread: 5, mentions: 2 },
  { id: 'r', name: 'random', kind: 'text', readable: false, unread: 7, mentions: 3, muted: true },
  { id: 'v', name: 'longhouse', kind: 'voice', readable: false },
] as const;
export const Badges: Story = { args: { activeId: 'g', rowLabel: ROW_LABEL, channels: BADGED } };
export const DirectMessages: Story = { args: { label: 'direct messages', activeId: 'd2', rowLabel: ROW_LABEL, channels: [
  { id: 'd1', name: 'ada', kind: 'dm', readable: false, unread: 2 },
  { id: 'd2', name: 'björn', kind: 'dm', readable: false },
  { id: 'd3', name: 'mira, ada', kind: 'dm', readable: false, unread: 4, mentions: 2 },
], footer: <Button variant="ghost" size="sm">message someone</Button> } };
export const WithTabs: Story = { args: { activeId: 'g', rowLabel: ROW_LABEL, channels: BADGED,
  tabs: <SidebarTabs label="sidebar" activeId="channels" onSelect={() => {}}
    tabs={[{ id: 'channels', label: 'channels' }, { id: 'dms', label: 'direct messages', count: 2 }]} /> } };
