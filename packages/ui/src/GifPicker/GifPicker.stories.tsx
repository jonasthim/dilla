import type { Meta, StoryObj } from '@storybook/react-vite';
import { GifPicker } from './GifPicker.tsx';

// Previews are page-minted URLs in the app; the stories use inline SVG data URLs so they need no network.
const swatch = (hue: number): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="113"><rect width="200" height="113" fill="hsl(${hue} 40% 40%)"/></svg>`)}`;
const ITEMS = ['cat typing', 'dog', 'fish', '', 'bird', 'otter'].map((title, i) => ({
  id: `g${i}`, title, width: 200, height: 113, src: i === 3 ? null : swatch(i * 55),
}));

const meta = {
  title: 'Conversation/GifPicker', component: GifPicker,
  args: {
    label: 'gifs', searchLabel: 'search gifs', searchPlaceholder: 'search giphy', query: '', onQuery: () => {}, items: ITEMS,
    status: null, poweredBy: 'Powered by GIPHY', untitled: 'gif', moreLabel: 'more', hasMore: true, onMore: () => {},
    pickingId: null, onPick: () => {}, onClose: () => {},
  },
  decorators: [Story => <div style={{ maxWidth: 420 }}><Story /></div>],
} satisfies Meta<typeof GifPicker>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Results: Story = {};
export const Empty: Story = { args: { items: [], status: { kind: 'empty', text: 'no gifs for that' }, hasMore: false, query: 'zzzz' } };
export const Failed: Story = { args: { items: [], status: { kind: 'error', text: 'could not reach the gif service' }, hasMore: false } };
export const Picking: Story = { args: { pickingId: 'g1', status: { kind: 'busy', text: 'adding the gif' } } };
