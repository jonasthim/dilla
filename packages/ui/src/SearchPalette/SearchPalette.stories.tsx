import type { Meta, StoryObj } from '@storybook/react-vite';
import { SearchPalette } from './SearchPalette.tsx';
import { PhoneLayoutProvider } from '../internal/phoneLayout.ts';
const noop = () => {};
const labels = { search: 'Search your messages', empty: 'No results in this scope', close: 'Close', scope: { channel: 'this conversation', community: 'this community', all: 'everything' },
  hints: { move: 'to move', open: 'to open', close: 'to close' } };
const hits = [{ id: 'hit-1', snippet: 'lamp one', location: '#general', author: 'Mira', time: '14:02' }, { id: 'hit-2', snippet: 'lamp two', location: '#loot', author: 'Ada', time: 'Oct 19 09:41' }];
const meta: Meta<typeof SearchPalette> = { title: 'Search/SearchPalette', component: SearchPalette };
export default meta;
type Story = StoryObj<typeof SearchPalette>;
const args = { open: true, query: 'lamp', scope: 'all' as const, hits, labels, onQuery: noop, onScope: noop, onPick: noop, onClose: noop };
export const Empty: Story = { args: { ...args, query: 'absent', hits: [] } };
export const Results: Story = { args };

// J1: a centred overlay of at most 40rem over the app, which stays visible behind it.
export const OverShell: Story = {
  args: { ...args, modal: true },
  parameters: { layout: 'fullscreen' },
  decorators: [Story => (
    <div style={{ minHeight: '100vh', padding: '1rem', background: 'var(--bg)', color: 'var(--fg-2)', fontFamily: 'var(--font-mono)' }}>
      <p>general</p><p>loot</p><p>harbour</p>
      <Story />
    </div>
  )],
};
// A phone keeps today's inline palette.
export const Phone: Story = {
  args,
  decorators: [Story => <PhoneLayoutProvider value><div style={{ width: '22.5rem' }}><Story /></div></PhoneLayoutProvider>],
};
