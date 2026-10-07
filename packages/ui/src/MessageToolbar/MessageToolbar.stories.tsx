import type { Meta, StoryObj } from '@storybook/react-vite';
import { MessageToolbar } from './MessageToolbar.tsx';

// Every string is L-COPY-03's, quoted (en.ts gains them in task 9).
const meta = {
  title: 'Conversation/MessageToolbar', component: MessageToolbar,
  args: {
    label: 'actions for this message', tabbable: true,
    items: [
      { id: 'react', label: 'react', onAction: () => {} }, { id: 'reply', label: 'reply', onAction: () => {} },
      { id: 'edit', label: 'edit', onAction: () => {} }, { id: 'pin', label: 'pin', onAction: () => {} },
      { id: 'delete', label: 'delete', danger: true, onAction: () => {} },
    ],
  },
  decorators: [Story => <div style={{ maxWidth: 720 }}><Story /></div>],
} satisfies Meta<typeof MessageToolbar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Own: Story = {};
export const Others: Story = {
  args: { items: [{ id: 'react', label: 'react', onAction: () => {} }, { id: 'reply', label: 'reply', onAction: () => {} }, { id: 'pin', label: 'pin', onAction: () => {} }] },
};
