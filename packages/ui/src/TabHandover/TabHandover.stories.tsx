import type { Meta, StoryObj } from '@storybook/react-vite';
import { TabHandover } from './TabHandover.tsx';
const labels = { use: 'Use this tab', wait: 'Moving to this tab…', failed: 'Close the other tab, then try again.' };
const meta: Meta<typeof TabHandover> = { id: 'shell-tabhand-over', title: 'Shell/TabHandOver', component: TabHandover };
export default meta;
type Story = StoryObj<typeof TabHandover>;
export const Waiting: Story = { args: { phase: 'waiting', labels, onUse: () => {}, onRetry: () => {} } };
export const Failure: Story = { args: { phase: 'failed', labels, onUse: () => {}, onRetry: () => {} } };
