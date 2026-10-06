import type { Meta, StoryObj } from '@storybook/react-vite';
import { RecoveryKey } from './RecoveryKey.tsx';

const meta = {
  title: 'Ceremony/RecoveryKey', component: RecoveryKey,
  args: {
    groups: ['7K3M', 'QW9D', 'X2RT', '0PNA', 'HV5C', 'J8ZE', 'M4TB', 'S6YF', '1GKD', 'R3WP', 'ZN7H', 'C9QX', '5TVA'],
    label: 'Recovery key', acknowledgeLabel: 'I have written down or printed my recovery key', acknowledged: false,
    onAcknowledge: () => {}, printLabel: 'Print', onPrint: () => {},
  },
  decorators: [Story => <div style={{ maxWidth: 640 }}><Story /></div>],
} satisfies Meta<typeof RecoveryKey>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unacknowledged: Story = {};
export const Acknowledged: Story = { args: { acknowledged: true } };
export const Narrow: Story = { decorators: [Story => <div style={{ width: 312 }}><Story /></div>] };
