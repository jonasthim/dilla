import type { Meta, StoryObj } from '@storybook/react-vite';
import { CallControls } from './CallControls.tsx';
import { HarbourStage, personTile, stageControls } from '../CallStage/stage.fixture.tsx';

/**
 * Flow 06 and task 7 step 3: every voice or player control (button, disclosure summary, volume range) is at least
 * 40 × 40 CSS px, and 44 × 44 under 48rem of viewport. A range is measured by its hit box's height only.
 */
export function expectVoiceTargets(root: HTMLElement, story: string): void {
  const min = window.innerWidth < 768 ? 44 : 40;
  // Signal (rule 0): the call bar's controls and the tile tools are the prototype's sizes, measured in scripts/story-a11y.ts instead.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('button, summary, input[type="range"]')).filter(e => e.closest('.d-call-controls--bar, .d-call-tile__tools, .d-call-stage__code') === null)) {
    if (el.getClientRects().length === 0) continue; // not drawn (a phone-only control on a desktop width): no target
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

// ---- Signal §5.6: the call bar (the web's channel stage passes `labels.bar`): 40px controls with their words and keycaps ----
/** The call bar as it ends the stage (the prototype's stove, joined): the room, the stats, the controls. */
const inBar = (controls: React.ReactNode) => (
  <div style={{ width: 980, height: 756, display: 'grid', gridTemplateRows: 'minmax(0, 1fr)', background: 'var(--bg)', margin: -16 }}>
    <HarbourStage name="stove" topic="2 in voice" stats="24 ms · ↑ 38 ↓ 71 kb/s · hearing 1 of 1" controls={controls}
      tiles={[personTile('Liv'), personTile('Mira', { own: true, title: 'Mira (you)' })]} />
  </div>
);
const barPlay = ({ canvasElement }: { canvasElement: HTMLElement }) => { expectOneRow(canvasElement, 'CallBar'); };
export const Default: Story = { render: () => inBar(stageControls()), play: barPlay };
export const Muted: Story = { render: () => inBar(stageControls({ muted: true })), play: barPlay };
export const Deafened: Story = { render: () => inBar(stageControls({ muted: true, deafened: true })), play: barPlay };
export const CameraOn: Story = { render: () => inBar(stageControls({ camera: true })), play: barPlay };
export const Sharing: Story = { render: () => inBar(stageControls({ sharing: true })), play: barPlay };
