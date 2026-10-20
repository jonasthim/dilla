import type { Meta, StoryObj } from '@storybook/react-vite';
import { TrailingSlot } from './TrailingSlot.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { Pill } from '../Pill/Pill.tsx';

const meta = { title: 'Primitives/TrailingSlot', component: TrailingSlot } satisfies Meta<typeof TrailingSlot>;
export default meta;
type Story = StoryObj<typeof meta>;

const row = { display: 'flex', alignItems: 'center', gap: 8, height: 'var(--row-h)', padding: '0 8px', background: 'var(--bg-2)', borderBottom: '1px solid var(--hairline)' } as const;
const name = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;

// The column is reserved on every row, empty or not, so the right edges line up down the list.
export const Aligned: Story = {
  render: () => (
    <div style={{ width: 240 }}>
      <div style={row}><span style={name}>general</span><TrailingSlot /></div>
      <div style={row}><span style={name}>loot</span><TrailingSlot><Pill kind="unread" count={4} /></TrailingSlot></div>
      <div style={row}><span style={name}>longhouse</span><TrailingSlot><Icon name="volume-2" size={16} /></TrailingSlot></div>
      <div style={row}><span style={name}>a channel with a very long name that is cut</span><TrailingSlot><Icon name="lock" size={16} /></TrailingSlot></div>
    </div>
  ),
};
export const Empty: Story = { render: () => <div style={{ ...row, width: 120 }}><span style={name}>empty</span><TrailingSlot /></div> };
