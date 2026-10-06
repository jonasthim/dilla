import type { Meta, StoryObj } from '@storybook/react-vite';
import { ComposedShell } from './AppShell.fixture.tsx';

const meta: Meta = { title: 'Shell/AppShell' };
export default meta;
type Story = StoryObj;
// 1280×800 less the preview decorator's 16px padding on each side.
export const Shell: Story = { render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell /></div> };
export const ShellNarrow: Story = { render: () => <div style={{ width: 360, ['--d-shell-h' as string]: '740px' }}><ComposedShell /></div> };
export const Offline: Story = { render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell banner /></div> };
