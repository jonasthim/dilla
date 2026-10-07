import type { Meta, StoryObj } from '@storybook/react-vite';
import { ReplyChip } from './ReplyChip.tsx';

// Every string is L-COPY-03's, quoted (en.ts gains them in task 9).
const meta = {
  title: 'Conversation/ReplyChip', component: ReplyChip,
  args: { label: 'replying to björn', excerpt: 'after nine, still on the boat', cancelLabel: 'cancel reply', onCancel: () => {} },
  decorators: [Story => <div style={{ maxWidth: 720 }}><Story /></div>],
} satisfies Meta<typeof ReplyChip>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Replying: Story = {};
