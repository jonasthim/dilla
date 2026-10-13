import type { Meta, StoryObj } from '@storybook/react-vite';
import { TrustAlert } from './TrustAlert.tsx';
const labels = { changed: 'This contact’s identity changed. Compare the number before sending.', unlisted: 'This device is not on the contact’s list.', verify: 'Compare with Ada' };
const meta: Meta<typeof TrustAlert> = { title: 'Trust/TrustAlert', component: TrustAlert };
export default meta;
type Story = StoryObj<typeof TrustAlert>;
export const Changed: Story = { args: { kind: 'changed', name: 'Ada', labels, onVerify: () => {} } };
export const Unlisted: Story = { args: { kind: 'unlisted', name: 'Ada', labels, onVerify: () => {} } };
