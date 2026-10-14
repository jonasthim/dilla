import type { Meta, StoryObj } from '@storybook/react-vite';
import { ActionMenu } from './ActionMenu.tsx';

const meta = {
  title: 'Shell/ActionMenu', component: ActionMenu,
  args: {
    label: 'actions for Astrid',
    items: [{ id: 'kick', label: 'kick' }, { id: 'ban', label: 'ban', danger: true }],
    open: false, onOpenChange: () => {}, onSelect: () => {},
  },
  decorators: [Story => <div style={{ minHeight: '9rem', padding: '1rem' }}><Story /></div>],
} satisfies Meta<typeof ActionMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};
export const Open: Story = { args: { open: true } };
export const AtPointer: Story = { args: { open: true, at: { x: 48, y: 40 } } };
