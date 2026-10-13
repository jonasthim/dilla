import type { Meta, StoryObj } from '@storybook/react-vite';
import { CallControls } from './CallControls.tsx';

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9).
const meta = {
  title: 'Voice/CallControls', component: CallControls,
  args: {
    muted: false, deafened: false, camera: false, sharing: false, canCamera: true, canShare: true, busy: false,
    labels: {
      region: 'call controls', mute: 'mute', unmute: 'unmute', deafen: 'deafen', undeafen: 'undeafen', cameraOn: 'camera',
      cameraOff: 'stop camera', shareOn: 'share screen', shareOff: 'stop sharing', leave: 'leave',
    },
    onMute: () => {}, onDeafen: () => {}, onCamera: () => {}, onShare: () => {}, onLeave: () => {},
  },
  // Each control is at least 40 × 40 CSS px (44 × 44 under 48rem of viewport), flow 06.
  play: ({ canvasElement }) => {
    const min = window.innerWidth < 768 ? 44 : 40;
    for (const b of Array.from(canvasElement.querySelectorAll('button'))) {
      const r = b.getBoundingClientRect();
      if (r.width < min || r.height < min) throw new Error(`CallControls: "${b.textContent ?? ''}" is ${String(r.width)} × ${String(r.height)}, under ${String(min)} px`);
    }
  },
} satisfies Meta<typeof CallControls>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = {};
export const MutedAndDeafened: Story = { args: { muted: true, deafened: true } };
export const CameraAndSharing: Story = { args: { camera: true, sharing: true } };
/** Joining: the controls appear but stay aria-disabled. */
export const Joining: Story = { args: { busy: true } };
/** Paused (RV-3): camera and share are aria-disabled until the call continues. */
export const Paused: Story = { args: { canCamera: false, canShare: false } };
