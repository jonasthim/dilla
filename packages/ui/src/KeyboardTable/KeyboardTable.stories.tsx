import type { Meta, StoryObj } from '@storybook/react-vite';
import { KeyboardTable } from './KeyboardTable.tsx';

// The chords are the shipped ones (docs/design/flows, Keyboard). The caption is the section's heading text.
const meta = {
  title: 'Settings/KeyboardTable', component: KeyboardTable,
  args: {
    caption: 'Keyboard shortcuts',
    rows: [
      { action: 'search', keys: ['ctrl', 'k'] },
      { action: 'previous channel', keys: ['alt', '↑'] },
      { action: 'next channel', keys: ['alt', '↓'] },
      { action: 'mark channel read', keys: ['esc'] },
      { action: 'mute or unmute', keys: ['ctrl', 'shift', 'm'] },
    ],
  },
  decorators: [Story => <div style={{ maxWidth: '28rem', padding: '1rem' }}><Story /></div>],
} satisfies Meta<typeof KeyboardTable>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const OneRow: Story = { args: { rows: [{ action: 'search', keys: ['ctrl', 'k'] }] } };
// A phone width: the chord keeps its right edge, a long action wraps.
export const Narrow: Story = {
  args: { rows: [{ action: 'switch to the previous unread channel in this server', keys: ['alt', 'shift', '↑'] }, { action: 'close', keys: ['esc'] }] },
  decorators: [Story => <div style={{ width: '20rem' }}><Story /></div>],
};
