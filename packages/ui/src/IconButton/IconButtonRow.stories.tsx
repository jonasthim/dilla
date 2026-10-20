import type { Meta, StoryObj } from '@storybook/react-vite';
import { IconButton } from './IconButton.tsx';

// Under Shell/ so the test runner's strict target-size axe rule covers the row: every button is at least 24 x 24 with
// its neighbours clear of each other's 24px circle (WCAG 2.5.8).
const meta = { title: 'Shell/IconButton', component: IconButton, args: { icon: 'hash', label: 'channels' } } satisfies Meta<typeof IconButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const HeaderRow: Story = {
  render: () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 8px', height: '3rem', background: 'var(--bg-2)', borderBottom: '1px solid var(--hairline)' }}>
      <IconButton icon="hash" label="channels" size={28} />
      <IconButton icon="pin" label="pinned messages" size={28} />
      <IconButton icon="users" label="members" size={28} pressed keys={['Ctrl', 'U']} />
      <IconButton icon="search" label="search" size={28} keys={['Ctrl', 'K']} />
      <IconButton icon="ellipsis" label="more" size={28} />
    </div>
  ),
};
