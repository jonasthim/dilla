import type { Meta, StoryObj } from '@storybook/react-vite';
import { Select } from './Select.tsx';

const meta = {
  title: 'Form/Select', component: Select,
  args: {
    label: 'Category', value: 'none', onChange: () => {},
    options: [{ value: 'none', label: 'no category' }, { value: 'c1', label: 'Text channels' }, { value: 'c2', label: 'Voice channels' }],
  },
} satisfies Meta<typeof Select>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithHint: Story = { args: { hint: 'Channels in a category move with it.' } };
export const Disabled: Story = { args: { disabled: true } };
