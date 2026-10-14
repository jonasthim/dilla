import type { Meta, StoryObj } from '@storybook/react-vite';
import { UnsupportedVoice } from './UnsupportedVoice.tsx';

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9).
const meta = {
  title: 'Voice/UnsupportedVoice', component: UnsupportedVoice,
  args: {
    open: true,
    labels: {
      title: 'Voice does not work in this browser',
      body: 'This browser lacks a feature dilla needs for voice. Use a current Chromium-based browser or Firefox.',
      close: 'Close',
    },
    onClose: () => {},
  },
} satisfies Meta<typeof UnsupportedVoice>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};
