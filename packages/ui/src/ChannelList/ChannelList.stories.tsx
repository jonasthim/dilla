import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChannelList } from './ChannelList.tsx';
import { SidebarTabs } from '../SidebarTabs/SidebarTabs.tsx';
import { Button } from '../Button/Button.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { expectGlyphLine } from '../VoiceChannelRow/VoiceChannelRow.stories.tsx';
import type { VoiceParticipantView } from '../CallTile/CallTile.tsx';

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
export const AnnouncementSlow: Story = { args: { activeId: 'g', channels: [
  { id: 'n', name: 'news', kind: 'announcement', readable: false, unread: 2 },
  { id: 'g', name: 'general', kind: 'text', readable: false, badge: 'slow mode' },
  { id: 's', name: 'announcements-and-everything-else', kind: 'announcement', readable: false, badge: 'slow mode' },
  { id: 'v', name: 'longhouse', kind: 'voice', readable: false },
] } };

// web3.8 (U3): one list, the voice channels in place with their people under them, a "+" in the list's header row, and
// the join button on hover or focus. The strings are the shell's, quoted.
const person = (name: string, more: Partial<VoiceParticipantView> = {}): VoiceParticipantView => ({
  deviceId: `d-${name}`, userId: `u-${name}`, name, state: 'ok', speaking: false, muted: false, deafened: false,
  video: false, screen: false, web: true, bot: false, ...more,
});
const VOICE = {
  labels: {
    open: 'voice {name}', count: '{n} in voice', canHear: 'can hear', join: 'join voice',
    state: { speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream',
      connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot' },
  },
  rooms: {
    v1: { joined: false, participants: [person('ada', { speaking: true }), person('bo', { muted: true, video: true }), person('cy', { state: 'unverified' })] },
    v2: { joined: true, participants: [person('you', { deafened: true })] },
  },
  onJoin: () => {},
};
const ONE_LIST = [
  { id: 'g', name: 'general', kind: 'text', readable: false, unread: 3 },
  { id: 'v1', name: 'longhouse', kind: 'voice', readable: false },
  { id: 'n', name: 'news', kind: 'announcement', readable: false },
  { id: 'v2', name: 'workshop', kind: 'voice', readable: false },
  { id: 'l', name: 'lfg', kind: 'text', readable: true },
] as const;
const ONE_LIST_ARGS = {
  activeId: 'g', rowLabel: ROW_LABEL, channels: ONE_LIST, voice: VOICE,
  tabs: <SidebarTabs label="sidebar" activeId="channels" onSelect={() => {}}
    tabs={[{ id: 'channels', label: 'channels' }, { id: 'dms', label: 'direct messages' }]} />,
  listAction: <Button variant="ghost" size="sm" aria-label="new channel"><Icon name="plus" size={16} /></Button>,
};
const oneListPlay = ({ canvasElement }: { canvasElement: HTMLElement }) => {
  expectGlyphLine(canvasElement, 'OneList');
  const people = canvasElement.querySelectorAll('.d-voice-row__person');
  if (people.length !== 4) throw new Error(`OneList: ${String(people.length)} nested people, not 4`);
};
export const OneList: Story = { args: ONE_LIST_ARGS, globals: { theme: 'mesh' }, play: oneListPlay };
export const OneListLight: Story = { args: ONE_LIST_ARGS, globals: { theme: 'light' }, play: oneListPlay };
export const OneListHighContrast: Story = { args: ONE_LIST_ARGS, globals: { theme: 'high-contrast' }, play: oneListPlay };

// G1: the join and the member count never overlap. With the join showing (focus-within here, as hover would) the count is
// hidden; in the phone layout the join is always shown and the row reserves its width, so the two sit side by side.
const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
function expectJoinClearsCount(root: HTMLElement, name: string): void {
  const item = Array.from(root.querySelectorAll<HTMLElement>('.d-channel-list__voice')).find(li => li.querySelector('.d-channel-list__join') !== null);
  const join = item?.querySelector<HTMLElement>('.d-channel-list__join');
  const count = item?.querySelector<HTMLElement>('.d-voice-row__count');
  if (!join || !count) throw new Error(`${name}: no join or no count to measure`);
  if (getComputedStyle(join).opacity !== '1') throw new Error(`${name}: the join is not shown`);
  if (getComputedStyle(count).visibility !== 'hidden' && overlap(join.getBoundingClientRect(), count.getBoundingClientRect())) {
    throw new Error(`${name}: the join overlaps the count`);
  }
}
export const JoinShownHidesCount: Story = { args: ONE_LIST_ARGS, globals: { theme: 'mesh' },
  play: async ({ canvasElement }) => {
    const join = canvasElement.querySelector<HTMLElement>('.d-channel-list__join');
    join?.focus();
    await Promise.all((join?.getAnimations() ?? []).map(a => a.finished));
    expectJoinClearsCount(canvasElement, 'JoinShownHidesCount');
  } };
export const JoinOnPhone: Story = { args: ONE_LIST_ARGS, globals: { theme: 'mesh' },
  decorators: [Story => <div data-layout="phone" style={{ width: 240, height: 360 }}><Story /></div>],
  play: async ({ canvasElement }) => {
    await Promise.all(canvasElement.getAnimations({ subtree: true }).map(a => a.finished));
    const count = canvasElement.querySelector<HTMLElement>('.d-voice-row__count');
    if (count !== null && getComputedStyle(count).visibility === 'hidden') throw new Error('JoinOnPhone: the count is hidden without hover');
    expectJoinClearsCount(canvasElement, 'JoinOnPhone');
  } };
