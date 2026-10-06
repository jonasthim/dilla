import type { Meta, StoryObj } from '@storybook/react-vite';
import { EmptyState } from './EmptyState.tsx';

const meta = { title: 'Form/EmptyState', component: EmptyState, args: { title: 'No servers yet', body: 'Paste an invite to join one.' } } satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Plain: Story = {};
export const WithAction: Story = { args: { action: { label: 'join a server', onAction: () => {} } } };
