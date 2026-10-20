import type { Meta, StoryObj } from '@storybook/react-vite';
import { PhoneLayoutProvider } from '../internal/phoneLayout.ts';
import { CommunityRail } from './CommunityRail.tsx';

const ITEMS = [{ id: 'a1', name: 'Midgard Crew' }, { id: 'b2', name: 'Night Owls', unread: 4 }, { id: 'c3', name: 'raid planning', unread: 120, mentions: 2 }, { id: 'd4', name: 'Quiet Corner' }];
const HOME = { label: 'direct messages', selected: false, unread: 0, mentions: 0, itemLabel: 'direct messages, unread', onSelect: () => {} };

/** The rail is 72px wide (--rail-w); the story gives it the shell's column. */
const meta = {
  title: 'Shell/CommunityRail', component: CommunityRail,
  args: { label: 'servers', items: [{ id: 'a1', name: 'Midgard Crew' }, { id: 'b2', name: 'Night Owls' }, { id: 'c3', name: 'raid planning' }],
    activeId: 'a1', onSelect: () => {}, addLabel: 'add a server', onAdd: () => {} },
  decorators: [Story => <div style={{ width: 72, height: 420 }}><Story /></div>],
} satisfies Meta<typeof CommunityRail>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const NoneActive: Story = { args: { activeId: null } };
export const Empty: Story = { args: { items: [], activeId: null } };
export const Badges: Story = { args: { items: ITEMS } };
export const WithSettings: Story = { args: { settingsLabel: 'settings', onSettings: () => {} } };
export const FreshInstance: Story = { args: { items: [], activeId: null, settingsLabel: 'settings', onSettings: () => {} } };

// web3.9 (UI-2): the `@` tile first, a hairline, the servers, one dashed "+" tile, the pill at the left edge.
const FULL = { items: ITEMS, activeId: 'a1', home: HOME, addLabel: 'add a server', onAdd: () => {}, settingsLabel: 'settings', onSettings: () => {} };
const rgb = (c: string): [number, number, number] => { const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/.exec(c); if (m === null) throw new Error(`cannot read colour ${c}`); return [Number(m[1]), Number(m[2]), Number(m[3])]; };
const lum = ([r, g, b]: [number, number, number]) => { const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
/** Unread is the left-edge pill alone (no visible count); a mention is a count at the tile's bottom right, readable at 3:1 or better. */
const badgePlay = (story: string) => ({ canvasElement }: { canvasElement: HTMLElement }) => {
  for (const sr of Array.from(canvasElement.querySelectorAll<HTMLElement>('.d-sr-only'))) {
    const r = sr.getBoundingClientRect(); if (r.width > 1 || r.height > 1) throw new Error(`${story}: an unread count is visible`);
  }
  const mention = canvasElement.querySelector<HTMLElement>('.d-community-rail__badge .d-pill');
  if (mention === null) return;
  const tile = mention.closest('.d-community-rail__item') as HTMLElement;
  const t = tile.getBoundingClientRect(); const m = mention.getBoundingClientRect();
  if (m.left + m.width / 2 < t.left + t.width / 2 || m.top + m.height / 2 < t.top + t.height / 2) throw new Error(`${story}: the mention badge is not at the bottom right`);
  const st = getComputedStyle(mention);
  const a = lum(rgb(st.color)); const b = lum(rgb(st.backgroundColor));
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  if (ratio < 3) throw new Error(`${story}: the mention count is ${ratio.toFixed(2)}:1`);
};
/** A server selected (the 40px pill), unread servers (the 8px pill), and the `@` tile quiet. */
export const WithHome: Story = { args: FULL, globals: { theme: 'mesh' }, play: badgePlay('WithHome') };
export const WithHomeLight: Story = { args: FULL, globals: { theme: 'light' }, play: badgePlay('WithHomeLight') };
export const WithHomeHighContrast: Story = { args: FULL, globals: { theme: 'high-contrast' }, play: badgePlay('WithHomeHighContrast') };
/** Home selected (DMs open) with unread messages and a mention (the count at the bottom right). */
export const HomeSelected: Story = { args: { ...FULL, activeId: null, home: { ...HOME, selected: true, unread: 3, mentions: 1, itemLabel: 'direct messages, unread 3, mentions 1' } }, globals: { theme: 'mesh' }, play: badgePlay('HomeSelected') };
export const HomeUnread: Story = { args: { ...FULL, home: { ...HOME, unread: 5, itemLabel: 'direct messages, unread 5' } }, globals: { theme: 'mesh' }, play: badgePlay('HomeUnread') };
/** On a phone the settings tile is gone (the You tab is the way) and the tiles stay 48. */
export const OnPhone: Story = { args: FULL, globals: { theme: 'mesh' },
  decorators: [Story => <PhoneLayoutProvider value><div data-layout="phone" data-phone style={{ width: 72, height: 'calc(100vh - 32px)' }}><Story /></div></PhoneLayoutProvider>],
  play: ({ canvasElement }) => {
    const tiles = Array.from(canvasElement.querySelectorAll<HTMLElement>('.d-community-rail__item'));
    for (const t of tiles) { const b = t.getBoundingClientRect(); if (b.width !== 48 || b.height !== 48) throw new Error(`OnPhone: a tile is ${String(b.width)} x ${String(b.height)}`); }
    if (tiles.length === 0 || canvasElement.querySelector('.d-community-rail__settings') !== null) throw new Error('OnPhone: no tiles, or the settings tile shows');
  } };
