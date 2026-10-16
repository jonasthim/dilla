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

/** Review round 1 (#1): a voice toolbar's controls sit in one row at the width they are given. */
export function expectOneRow(root: HTMLElement, story: string): void {
  for (const bar of Array.from(root.querySelectorAll<HTMLElement>('.d-voice-toolbar'))) {
    const tops = Array.from(bar.querySelectorAll<HTMLElement>(':scope > button')).map(b => Math.round(b.getBoundingClientRect().top));
    if (new Set(tops).size > 1) throw new Error(`${story}: the voice controls wrap (tops ${tops.join(', ')}) at ${String(bar.clientWidth)} px`);
    if (bar.scrollWidth > bar.clientWidth + 1) throw new Error(`${story}: the voice controls scroll sideways`);
  }
}

/** Review round 1 (#2, #3): a tip shown by keyboard focus takes no pointer; a click where it shows passes through. */
export function expectTipTakesNoPointer(root: HTMLElement, story: string): void {
  const tip = root.querySelector<HTMLElement>('.d-voice-toolbar__tip');
  if (tip === null || tip.hidden) throw new Error(`${story}: no tooltip shows after keyboard focus`);
  const r = tip.getBoundingClientRect();
  const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (under !== null && tip.contains(under)) throw new Error(`${story}: the focus tooltip takes the pointer`);
  for (const b of Array.from(root.querySelectorAll('button'))) if (b.contains(tip)) throw new Error(`${story}: the tooltip sits inside a button`);
}

/** One rendered frame, for a check after a focus or a layout effect. */
export function nextFrame(): Promise<void> { return new Promise(resolve => { requestAnimationFrame(() => { resolve(); }); }); }

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9).
const meta = {
  title: 'Voice/CallControls', component: CallControls,
  excludeStories: ['expectVoiceTargets', 'expectOneRow', 'expectTipTakesNoPointer', 'nextFrame'],
  args: {
    muted: false, deafened: false, camera: false, sharing: false, canCamera: true, canShare: true, busy: false,
    labels: {
      region: 'call controls', mute: 'mute', deafen: 'deafen', camera: 'camera',
      share: 'share screen', leave: 'leave',
      why: { paused: 'paused', joining: 'connecting', noShare: 'not available in this browser' },
    },
    shortcuts: { mute: 'Ctrl+Shift+M', deafen: 'Ctrl+Shift+D' },
    onMute: () => {}, onDeafen: () => {}, onCamera: () => {}, onShare: () => {}, onLeave: () => {},
  },
  // Each control is at least 40 × 40 CSS px (44 × 44 under 48rem of viewport), flow 06, and the five sit in one row.
  play: ({ canvasElement }) => { expectVoiceTargets(canvasElement, 'CallControls'); expectOneRow(canvasElement, 'CallControls'); },
} satisfies Meta<typeof CallControls>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = {};
export const MutedAndDeafened: Story = { args: { muted: true, deafened: true } };
export const CameraAndSharing: Story = { args: { camera: true, sharing: true } };
/** Joining: the controls appear but stay aria-disabled. */
export const Joining: Story = { args: { busy: true } };
/** Paused (RV-3): camera and share are aria-disabled until the call continues. */
export const Paused: Story = { args: { paused: true, canCamera: false, canShare: false } };
/** Keyboard focus on mute shows its tooltip above it: the label and the shortcut. */
export const TooltipOnFocus: Story = {
  args: { muted: true },
  decorators: [Story => <div style={{ paddingTop: 40 }}><Story /></div>],
  play: async ({ canvasElement }) => {
    expectVoiceTargets(canvasElement, 'CallControls');
    canvasElement.querySelector<HTMLButtonElement>('[role="toolbar"] button')?.focus();
    await nextFrame();
    expectTipTakesNoPointer(canvasElement, 'CallControls');
  },
};
