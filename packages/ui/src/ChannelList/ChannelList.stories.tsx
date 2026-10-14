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
// Flow 07: the owner's server actions under the name (a member who does not own the server sees only the invite).
const ACTIONS = <>
  <Button aria-label="new channel"><span aria-hidden="true">+</span> channel</Button>
  <Button>invite link</Button>
</>;
// Flow 07 (whole-branch walk): in the 240 px sidebar both actions sit on one row, each at least 24 px tall and wide; a
// long channel name is cut inside its row and never widens the list.
export const WithActions: Story = { args: { activeId: 'g', rowLabel: ROW_LABEL, actions: ACTIONS, actionsLabel: 'server actions',
  channels: [...BADGED, { id: 'f', name: 'fika-på-fredag-och-veckans-planering', kind: 'text', readable: false },
    { id: 'm', name: 'midsommar-'.repeat(10), kind: 'voice', readable: false }],
  tabs: <SidebarTabs label="sidebar" activeId="channels" onSelect={() => {}}
    tabs={[{ id: 'channels', label: 'channels' }, { id: 'dms', label: 'direct messages' }]} /> },
  play: ({ canvasElement }) => {
    const buttons = Array.from(canvasElement.querySelectorAll<HTMLElement>('.d-channel-list__actions .d-btn')).map(b => b.getBoundingClientRect());
    if (buttons.length !== 2 || buttons[0].top !== buttons[1].top) {
      throw new Error(`WithActions: the server actions wrap (tops ${buttons.map(b => String(b.top)).join(', ')})`);
    }
    for (const b of buttons) if (b.height < 24 || b.width < 24) throw new Error(`WithActions: an action is ${String(b.width)} × ${String(b.height)}`);
    const list = canvasElement.querySelector<HTMLElement>('.d-channel-list');
    if (list === null || list.scrollWidth > list.clientWidth + 1) throw new Error(`WithActions: the list is ${String(list?.scrollWidth)} wide`);
  } };
export const WithTabs: Story = { args: { activeId: 'g', rowLabel: ROW_LABEL, channels: BADGED,
  tabs: <SidebarTabs label="sidebar" activeId="channels" onSelect={() => {}}
    tabs={[{ id: 'channels', label: 'channels' }, { id: 'dms', label: 'direct messages', count: 2 }]} /> } };
