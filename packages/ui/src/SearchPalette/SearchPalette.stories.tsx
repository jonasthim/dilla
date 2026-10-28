import type { Meta, StoryObj } from '@storybook/react-vite';
import { SearchPalette } from './SearchPalette.tsx';
import { PhoneLayoutProvider } from '../internal/phoneLayout.ts';
const noop = () => {};
// As packages/web/src/screens/Search.tsx passes them (task 9).
const labels = { search: 'Search your messages', empty: '', close: 'Close', scope: { channel: 'this conversation', community: 'this community', all: 'everything' },
  hints: { move: 'move', open: 'open' }, note: 'Searches messages held in this browser', group: 'Messages' };
const hits = [
  { id: 'hit-1', snippet: 'bring a rope this time', location: '#general', author: 'Ada', time: '20:31' },
  { id: 'hit-2', snippet: 'two ropes', location: '#general', author: 'Mira', time: '20:32' },
  { id: 'hit-3', snippet: 'the rope is in the loot pile', location: '#loot', author: 'Björn', time: 'Oct 19 09:41' },
];
const meta: Meta<typeof SearchPalette> = { title: 'Search/SearchPalette', component: SearchPalette };
export default meta;
type Story = StoryObj<typeof SearchPalette>;
const args = { open: true, query: 'rope', scope: 'all' as const, hits, labels, onQuery: noop, onScope: noop, onPick: noop, onClose: noop, modal: true };
// The desktop palette over the app (Signal §5.8): the app stays visible behind the scrim.
const overShell = [(Story: () => React.JSX.Element) => (
  <div style={{ minHeight: '100vh', padding: '1rem', background: 'var(--bg)', color: 'var(--fg-2)', fontFamily: 'var(--font-mono)' }}>
    <p>general</p><p>loot</p><p>harbour</p>
    <Story />
  </div>
)];
/** Opened, nothing typed yet. */
export const Empty: Story = { args: { ...args, query: '', hits: [] }, parameters: { layout: 'fullscreen' }, decorators: overShell };
/** A query typed, the worker still answering. */
export const Query: Story = { args: { ...args, query: 'ro', hits: [], labels: { ...labels, empty: 'Searching your messages' } }, parameters: { layout: 'fullscreen' }, decorators: overShell };
/** Message results: the group heading, the selected row with its accent bar and ↵, each with #place · author · time. */
export const MessagesResults: Story = { args, parameters: { layout: 'fullscreen' }, decorators: overShell };
/** Nothing matches. */
export const NoResults: Story = { args: { ...args, query: 'lantern', hits: [], labels: { ...labels, empty: 'Nothing in this browser matches “lantern”.' } }, parameters: { layout: 'fullscreen' }, decorators: overShell };
/** A phone: the inline palette (the web app's full-screen dialog around it puts it 12px from the top over the scrim). */
export const Phone: Story = {
  args: { ...args, modal: false },
  decorators: [Story => <PhoneLayoutProvider value><div style={{ width: '366px', padding: '12px', background: 'var(--scrim)' }}><Story /></div></PhoneLayoutProvider>],
};
