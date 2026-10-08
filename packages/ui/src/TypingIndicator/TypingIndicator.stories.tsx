import type { Meta, StoryObj } from '@storybook/react-vite';
import { TypingIndicator } from './TypingIndicator.tsx';
const labels = { one: '{name} is typing', many: 'Several people are typing' };
const meta: Meta<typeof TypingIndicator> = { title: 'Status/TypingIndicator', component: TypingIndicator };
export default meta;
type Story = StoryObj<typeof TypingIndicator>;
export const One: Story = { args: { names: ['Ada', 'Ada'], labels } };
export const Many: Story = { args: { names: ['Ada', 'Mira'], labels } };
