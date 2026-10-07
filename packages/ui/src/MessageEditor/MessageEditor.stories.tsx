import type { Meta, StoryObj } from '@storybook/react-vite';
import { MessageEditor } from './MessageEditor.tsx';

// Every string is L-COPY-03's, quoted (en.ts gains them in task 9). The editor is controlled: each story passes its value.
const meta = {
  title: 'Conversation/MessageEditor', component: MessageEditor,
  args: {
    label: 'edit your message', value: 'meet at the harbour at nine', onChange: () => {}, onSave: () => {}, onCancel: () => {},
    hint: 'escape to cancel · enter to save', saveLabel: 'save', cancelLabel: 'cancel', maxLength: 4000,
    counterLabel: (n: number) => `${String(n)} left`,
  },
  decorators: [Story => <div style={{ maxWidth: 720 }}><Story /></div>],
} satisfies Meta<typeof MessageEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Editing: Story = {};
// 38 bytes of a 40-byte budget: the counter shows.
export const NearTheLimit: Story = { args: { maxLength: 40, value: 'meet at the harbour, bring the old map' } };
// 26 bytes over a 20-byte budget: the counter takes the danger tone and save is refused.
export const OverTheLimit: Story = { args: { maxLength: 20, value: 'meet at the harbour at ten' } };
