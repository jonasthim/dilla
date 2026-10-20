import type { Meta, StoryObj } from '@storybook/react-vite';
import { PhoneLayoutProvider } from '../internal/phoneLayout.ts';
import { CommunityRail } from './CommunityRail.tsx';

const ITEMS = [{ id: 'a1', name: 'Midgard Crew' }, { id: 'b2', name: 'Night Owls', unread: 4 }, { id: 'c3', name: 'raid planning', unread: 120, mentions: 2 }, { id: 'd4', name: 'Quiet Corner' }];
const HOME = { label: 'direct messages', selected: false, unread: 0, mentions: 0, itemLabel: 'direct messages, unread', onSelect: () => {} };

/** The rail is 72px wide (--rail-w); the story gives it the shell's column. */
const meta = {
  title: 'Shell/CommunityRail', component: CommunityRail,
  args: { label: 'servers', items: [{ id: 'a1', name: 'Midgard Crew' }, { id: 'b2', name: 'Night Owls' }, { id: 'c3', name: 'raid planning' }],
    activeId: 'a1', onSelect: () => {}, joinLabel: 'join a server', onJoin: () => {} },
  decorators: [Story => <div style={{ width: 72, height: 420 }}><Story /></div>],
} satisfies Meta<typeof CommunityRail>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const NoneActive: Story = { args: { activeId: null } };
export const Empty: Story = { args: { items: [], activeId: null } };
export const Badges: Story = { args: { items: ITEMS } };
export const WithSettings: Story = { args: { settingsLabel: 'settings', onSettings: () => {} } };
/** Join and create as two tiles (the shell until WEB-LIST), no captions. */
export const WithCreate: Story = { args: { createLabel: 'new server', onCreate: () => {}, settingsLabel: 'settings', onSettings: () => {} } };
export const FreshInstance: Story = { args: { items: [], activeId: null, createLabel: 'new server', onCreate: () => {}, settingsLabel: 'settings', onSettings: () => {} } };

// web3.9 (UI-2): the `@` tile first, a hairline, the servers, one dashed "+" tile, the pill at the left edge.
const FULL = { items: ITEMS, activeId: 'a1', home: HOME, addLabel: 'add a server', createLabel: 'new server', onCreate: () => {}, settingsLabel: 'settings', onSettings: () => {} };
/** A server selected (the 40px pill), unread servers (the 8px pill), and the `@` tile quiet. */
export const WithHome: Story = { args: FULL, globals: { theme: 'mesh' } };
export const WithHomeLight: Story = { args: FULL, globals: { theme: 'light' } };
export const WithHomeHighContrast: Story = { args: FULL, globals: { theme: 'high-contrast' } };
/** Home selected (DMs open) with unread messages and a mention. */
export const HomeSelected: Story = { args: { ...FULL, activeId: null, home: { ...HOME, selected: true, unread: 3, mentions: 1, itemLabel: 'direct messages, unread 3, mentions 1' } }, globals: { theme: 'mesh' } };
export const HomeUnread: Story = { args: { ...FULL, home: { ...HOME, unread: 5, itemLabel: 'direct messages, unread 5' } }, globals: { theme: 'mesh' } };
/** The "+" menu open: join and create. */
export const AddMenuOpen: Story = { args: FULL, globals: { theme: 'mesh' },
  play: ({ canvasElement }) => { canvasElement.querySelector<HTMLElement>('.d-action-menu__trigger')?.click(); } };
/** On a phone the settings tile is gone (the You tab is the way) and the tiles stay 48. */
export const OnPhone: Story = { args: FULL, globals: { theme: 'mesh' },
  decorators: [Story => <PhoneLayoutProvider value><div data-layout="phone" data-phone style={{ width: 72, height: 'calc(100vh - 32px)' }}><Story /></div></PhoneLayoutProvider>],
  play: ({ canvasElement }) => {
    const tiles = Array.from(canvasElement.querySelectorAll<HTMLElement>('.d-community-rail__item'));
    for (const t of tiles) { const b = t.getBoundingClientRect(); if (b.width !== 48 || b.height !== 48) throw new Error(`OnPhone: a tile is ${String(b.width)} x ${String(b.height)}`); }
    if (tiles.length === 0 || canvasElement.querySelector('.d-community-rail__settings') !== null) throw new Error('OnPhone: no tiles, or the settings tile shows');
  } };
