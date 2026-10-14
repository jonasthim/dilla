import type { Meta, StoryObj } from '@storybook/react-vite';
import { EmptyState } from './EmptyState.tsx';

const meta = { title: 'Form/EmptyState', component: EmptyState, args: { title: 'No servers yet', body: 'Paste an invite to join one.' } } satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Plain: Story = {};
export const WithAction: Story = { args: { action: { label: 'join a server', onAction: () => {} } } };
// Flow 07, the shell with no server: start one, or join one.
export const TwoWays: Story = { args: { title: 'You are not in a server yet',
  body: 'Start a server and invite your friends, or join one with an invite someone sent you.',
  action: { label: 'Start a server', onAction: () => {} }, secondary: { label: 'Join a server', onAction: () => {} } } };
