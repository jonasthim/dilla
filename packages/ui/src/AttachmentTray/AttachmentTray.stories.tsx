import type { Meta, StoryObj } from '@storybook/react-vite';
import { AttachmentTray, type AttachmentTrayProps } from './AttachmentTray.tsx';

// Every string is L-COPY-03's, quoted (en.ts gains them in task 9). The tray never says how a file is protected.
const STEPS = ['reading', 'preparing', 'uploading', 'ready', 'failed'] as const;
const NAMES = ['drawn.png', 'notes.txt', 'route.gpx', 'harbour.jpg', 'packing-list.pdf'];
const SIZES = ['48 KB', '2 KB', '12.4 KB', '1.2 MB', '310 KB'];
const HINT = 'Remove it and attach it again.';

const everyPhase: AttachmentTrayProps['items'] = STEPS.map((step, i) => ({
  id: `t${String(i)}`, name: NAMES[i] ?? '', size: SIZES[i] ?? '', step, failed: step === 'failed',
  phase: step === 'failed' ? 'failed (E_TOO_LARGE)' : step, ...(step === 'failed' ? { hint: HINT } : {}),
  removeLabel: `remove ${NAMES[i] ?? ''}`, onRemove: () => {},
}));

const meta = {
  title: 'Conversation/AttachmentTray', component: AttachmentTray,
  args: { label: 'files to send', items: everyPhase },
  decorators: [Story => <div style={{ maxWidth: 720 }}><Story /></div>],
} satisfies Meta<typeof AttachmentTray>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EveryPhase: Story = {};
// The refusal the page shows above the tray is not this component's: this story is one failed entry.
export const TooLarge: Story = {
  args: {
    items: [{ id: 't0', name: 'harbour-video.mov', size: '31.5 MB', step: 'failed', failed: true, phase: 'failed (E_ATTACHMENT_TOO_LARGE)',
      hint: HINT, removeLabel: 'remove harbour-video.mov', onRemove: () => {} }],
  },
};
