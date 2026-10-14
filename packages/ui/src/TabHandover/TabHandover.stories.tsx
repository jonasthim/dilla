import type { Meta, StoryObj } from '@storybook/react-vite';
import { TabHandover } from './TabHandover.tsx';
const labels = { otherTab: 'dilla is open in another tab', use: 'Use this tab', wait: 'Moving to this tab…', failed: 'Close the other tab, then try again.', paused: 'This tab is paused' };
const meta: Meta<typeof TabHandover> = { id: 'shell-tabhand-over', title: 'Shell/TabHandOver', component: TabHandover };
export default meta;
type Story = StoryObj<typeof TabHandover>;
export const OtherTab: Story = { args: { phase: 'other-tab', labels, onUse: () => {}, onRetry: () => {} } };
export const Waiting: Story = { args: { phase: 'waiting', labels, onUse: () => {}, onRetry: () => {} } };
export const Failure: Story = { args: { phase: 'failed', labels, onUse: () => {}, onRetry: () => {} } };
/** Product walk I7: the tab that holds dilla is in a call; Use this tab asks before ending it. */
export const CallInOtherTab: Story = { args: { phase: 'confirm', labels: { ...labels, voiceWarning: 'You are in a call in the other tab. Using this tab ends that call.', voiceUse: 'Leave the call and use this tab', voiceKeep: 'Keep the call' }, onUse: () => {}, onRetry: () => {}, onConfirm: () => {}, onKeep: () => {} } };
