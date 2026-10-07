import type { Meta, StoryObj } from '@storybook/react-vite';
import { PinsDialog } from './PinsDialog.tsx';

// Every string is L-COPY-03's, quoted (en.ts gains them in task 9).
const PINS = [
  { author: 'björn', time: '21:03', excerpt: 'after nine, still on the boat', by: 'pinned by ada' },
  { author: 'mira', time: '21:05', excerpt: 'count me in', by: 'pinned by mira' },
  { author: 'ada', time: '21:07', excerpt: 'route for tonight: harbour, the old mill, back by midnight', by: 'pinned by ada' },
  { author: 'björn', time: '21:12', excerpt: 'bring the rope and the good lantern', by: 'pinned by mira' },
  { author: 'mira', time: '21:20', excerpt: 'the ferry leaves at 23:40 from the north pier', by: 'pinned by ada' },
];

const meta = {
  title: 'Conversation/PinsDialog', component: PinsDialog,
  args: { open: true, title: 'Pinned in #general', closeLabel: 'Close', onClose: () => {}, emptyLabel: 'Nothing is pinned here yet.', items: [] },
} satisfies Meta<typeof PinsDialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const FivePins: Story = {
  args: {
    items: PINS.map((p, i) => ({
      id: `pin-${String(i)}`, author: p.author, time: p.time, excerpt: p.excerpt, pinnedBy: p.by,
      jumpLabel: 'go to message', onJump: () => {}, unpinLabel: 'unpin', onUnpin: () => {},
    })),
  },
};
