import type { Meta, StoryObj } from '@storybook/react-vite';
import { CallControls } from './CallControls.tsx';

/**
 * Flow 06 and task 7 step 3: every voice or player control (button, disclosure summary, volume range) is at least
 * 40 × 40 CSS px, and 44 × 44 under 48rem of viewport. A range is measured by its hit box's height only.
 */
export function expectVoiceTargets(root: HTMLElement, story: string): void {
  const min = window.innerWidth < 768 ? 44 : 40;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('button, summary, input[type="range"]'))) {
    const r = el.getBoundingClientRect();
    const range = el instanceof HTMLInputElement;
    if (r.height < min || (!range && r.width < min)) {
      throw new Error(`${story}: "${el.getAttribute('aria-label') ?? el.textContent ?? ''}" is ${String(r.width)} × ${String(r.height)}, under ${String(min)} px`);
    }
  }
}

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9).
const meta = {
  title: 'Voice/CallControls', component: CallControls,
  excludeStories: ['expectVoiceTargets'],
  args: {
    muted: false, deafened: false, camera: false, sharing: false, canCamera: true, canShare: true, busy: false,
    labels: {
      region: 'call controls', mute: 'mute', deafen: 'deafen', camera: 'camera',
      share: 'share screen', leave: 'leave',
    },
    shortcuts: { mute: 'Ctrl+Shift+M', deafen: 'Ctrl+Shift+D' },
    onMute: () => {}, onDeafen: () => {}, onCamera: () => {}, onShare: () => {}, onLeave: () => {},
  },
  // Each control is at least 40 × 40 CSS px (44 × 44 under 48rem of viewport), flow 06.
  play: ({ canvasElement }) => { expectVoiceTargets(canvasElement, 'CallControls'); },
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
/** Keyboard focus on mute shows its tooltip above it: the label and the shortcut. */
export const TooltipOnFocus: Story = {
  args: { muted: true },
  decorators: [Story => <div style={{ paddingTop: 40 }}><Story /></div>],
  play: ({ canvasElement }) => {
    expectVoiceTargets(canvasElement, 'CallControls');
    canvasElement.querySelector<HTMLButtonElement>('[role="toolbar"] button')?.focus();
  },
};
