import type { Meta, StoryObj } from '@storybook/react-vite';
import { AudioMeter } from './AudioMeter.tsx';

// The label is L-COPY-05's `settings.voice.level`, quoted.
const meta = {
  title: 'Voice/AudioMeter', component: AudioMeter,
  args: { level: 6, label: 'input level' },
} satisfies Meta<typeof AudioMeter>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Talking: Story = {};
export const Silent: Story = { args: { level: 0 } };
export const Full: Story = { args: { level: 12 } };
