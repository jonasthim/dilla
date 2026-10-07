import type { Meta, StoryObj } from '@storybook/react-vite';
import { ReactionBar } from './ReactionBar.tsx';

// Every string is L-COPY-03's, quoted (en.ts gains them in task 9): `shell.message.reaction` is `{name}, {count}`.
const FIRST_TWELVE = [
  ['👍', 'thumbs up'], ['👎', 'thumbs down'], ['❤️', 'red heart'], ['😄', 'grinning face'], ['😂', 'tears of joy'], ['😢', 'crying face'],
  ['😡', 'angry face'], ['😍', 'heart eyes'], ['🎉', 'party popper'], ['🔥', 'fire'], ['💯', 'hundred points'], ['✨', 'sparkles'],
] as const;

const meta = {
  title: 'Conversation/ReactionBar', component: ReactionBar,
  args: { label: 'reactions', tabbable: true, items: [], onToggle: () => {}, addLabel: 'add a reaction', onAdd: () => {} },
  decorators: [Story => <div style={{ maxWidth: 720 }}><Story /></div>],
} satisfies Meta<typeof ReactionBar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const None: Story = {};
export const One: Story = { args: { items: [{ emoji: '👍', count: 1, mine: true, name: 'thumbs up, 1' }] } };
export const Twelve: Story = {
  args: {
    items: FIRST_TWELVE.map(([emoji, name], i) => ({ emoji, count: i + 1, mine: (i + 1) % 3 === 0, name: `${name}, ${String(i + 1)}` })),
  },
};
