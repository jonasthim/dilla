import type { Meta, StoryObj } from '@storybook/react-vite';
import { Pill } from './Pill.tsx';
const meta = { title: 'Primitives/Pill', component: Pill } satisfies Meta<typeof Pill>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unread: Story = { args: { kind: 'unread', count: 4 } };
export const Mention: Story = { args: { kind: 'mention', count: 12 } };
export const Capped: Story = { args: { kind: 'unread', count: 140 } };
