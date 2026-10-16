import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { VoiceDock } from './VoiceDock.tsx';
import { AudioMeter } from '../AudioMeter/AudioMeter.tsx';
import { expectOneRow, expectTipTakesNoPointer, expectVoiceTargets, nextFrame } from '../CallControls/CallControls.stories.tsx';

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9).
const meta = {
  title: 'Voice/VoiceDock', component: VoiceDock,
  args: {
    phase: 'connected', where: 'harbour', muted: false, deafened: false, announcement: '',
    labels: {
      region: 'voice controls', connecting: 'connecting', connected: 'in {where}', reconnecting: 'reconnecting', paused: 'paused in {where}',
      mute: 'mute', deafen: 'deafen', leave: 'leave', camera: 'camera', share: 'share screen',
      why: { paused: 'paused', joining: 'connecting', noShare: 'not available in this browser' },
    },
    camera: false, sharing: false, canCamera: true, canShare: true, shortcuts: { mute: 'Ctrl+Shift+M', deafen: 'Ctrl+Shift+D' },
    onMute: () => {}, onDeafen: () => {}, onCamera: () => {}, onShare: () => {}, onLeave: () => {},
  },
  // The dock at the app's real widths (review round 1, #1): the desktop sidebar (240 px, its dock wrapper's 1 px
  // edge), or with `parameters.sidebar: 'phone'` the phone drawer of a 360 px screen (300 px, the 60 px rail beside
  // it) with app.css's compact dock rules for it, copied here.
  // Under 48rem of viewport the app always shows the drawer, so every dock story does too.
  decorators: [(Story, ctx) => (ctx.parameters.sidebar === 'phone' || window.innerWidth < 768
    ? <PhoneDrawer><Story /></PhoneDrawer> : <DesktopSidebar><Story /></DesktopSidebar>)],
  // Each control is at least 40 × 40 CSS px (44 × 44 under 48rem of viewport), flow 06, and the five sit in one row.
  play: ({ canvasElement }) => { expectVoiceTargets(canvasElement, 'VoiceDock'); expectOneRow(canvasElement, 'VoiceDock'); },
} satisfies Meta<typeof VoiceDock>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = { args: { announcement: 'You joined harbour.', meter: <AudioMeter level={6} label="input level" /> } };
export const Connecting: Story = { args: { phase: 'connecting' } };
export const Reconnecting: Story = { args: { phase: 'reconnecting', meter: <AudioMeter level={0} label="input level" /> } };
export const MutedAndDeafened: Story = { args: { muted: true, deafened: true, announcement: 'Sound off.', meter: <AudioMeter level={0} label="input level" /> } };
/** Camera on and sharing: both glyphs swap (video, monitor-x) and take the accent tint. */
export const CameraAndSharing: Story = { args: { camera: true, sharing: true, meter: <AudioMeter level={4} label="input level" /> } };
/** Paused (RV-3): the dock says so, and camera and share are aria-disabled as on the stage; the banner with its action
 *  lives on the stage. */
export const Paused: Story = { args: { phase: 'paused', canCamera: false, canShare: false } };
/** Paused, with keyboard focus on camera: its tooltip says why it is disabled, "camera — paused" (Jonas, 2026-10-15),
 *  and the reason is its description; the name stays "camera". */
export const PausedWhy: Story = {
  args: { phase: 'paused', paused: true, canCamera: false, canShare: false, meter: <AudioMeter level={0} label="input level" /> },
  play: async ({ canvasElement }) => {
    expectVoiceTargets(canvasElement, 'VoiceDock');
    expectOneRow(canvasElement, 'VoiceDock');
    const camera = canvasElement.querySelector<HTMLButtonElement>('[role="toolbar"] button[data-control="camera"]');
    if (camera === null) throw new Error('VoiceDock: no camera control');
    camera.focus();
    await nextFrame();
    const tip = canvasElement.querySelector<HTMLElement>('.d-voice-toolbar__tip');
    if (tip === null || tip.hidden || tip.textContent !== 'camera — paused') {
      throw new Error(`VoiceDock: the camera tip says "${tip?.textContent ?? ''}", not "camera — paused"`);
    }
    if (camera.getAttribute('aria-label') !== 'camera') throw new Error('VoiceDock: the camera name changed');
    const ids = (camera.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    const described = ids.map(id => document.getElementById(id)?.textContent ?? '').join(' ');
    if (described !== 'paused') throw new Error(`VoiceDock: the camera is described as "${described}", not "paused"`);
    expectTipTakesNoPointer(canvasElement, 'VoiceDock');
  },
};
/** Joining: camera and share wait for the session (the stage's busy); mute, deafen and leave stay live. */
export const Joining: Story = { args: { phase: 'connecting', busy: true } };
/** Keyboard focus on mute shows its tooltip: the label and the shortcut. */
export const TooltipOnFocus: Story = {
  args: { muted: true },
  play: async ({ canvasElement }) => {
    expectVoiceTargets(canvasElement, 'VoiceDock');
    canvasElement.querySelector<HTMLButtonElement>('[role="toolbar"] button')?.focus();
    await nextFrame();
    // A focus tip takes no pointer: a click where it shows goes to whatever is under it (review round 1, #3).
    expectTipTakesNoPointer(canvasElement, 'VoiceDock');
  },
};
/** Before the web app wires camera and share (VI-2), the dock keeps its three controls. */
export const WithoutCameraAndShare: Story = {
  args: { onCamera: undefined, onShare: undefined, labels: { region: 'voice controls', connecting: 'connecting', connected: 'in {where}',
    reconnecting: 'reconnecting', paused: 'paused in {where}', mute: 'mute', deafen: 'deafen', leave: 'leave' } },
};
/** A DM call: `{where}` is the DM's name, and the outgoing ring is announced through the dock's status region. */
export const DmRinging: Story = { args: { where: 'ada', announcement: 'ringing ada' } };
/** Rejoining (WB a11y m8): the dock stays at connecting while the join waits for its earlier Remove; the status region
 *  says so once (`voice.announce.rejoining`). */
export const Rejoining: Story = { args: { phase: 'connecting', announcement: 'Rejoining harbour. This can take up to 30 seconds.' } };

/** The app's desktop sidebar: 240 px, and the dock wrapper's 1 px right edge (app.css `.dw-voice-dock`). */
function DesktopSidebar({ children }: { children: ReactNode }) {
  return <div style={{ width: 240 }}><div style={{ background: 'var(--bg-2)', borderRight: '1px solid var(--hairline)' }}>{children}</div></div>;
}

/** The phone drawer at 360 px: 300 px wide, the dock wrapper's edges, and app.css's compact dock (@container d-shell
 *  under 48rem: where and the meter on one line, the controls on the next, 0.5rem padding, square corners). */
function PhoneDrawer({ children }: { children: ReactNode }) {
  return (
    <div className="sb-phone-drawer" style={{ width: 300 }}>
      <style>{`
        .sb-phone-drawer .d-voice-dock { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.375rem 0.75rem; padding: 0.5rem; border-radius: 0; }
        .sb-phone-drawer .d-voice-dock__where { align-self: center; }
        .sb-phone-drawer .d-voice-dock__where:not(:has(+ .d-voice-dock__meter)) { grid-column: 1 / -1; }
        .sb-phone-drawer .d-voice-dock__controls { grid-column: 1 / -1; }
      `}</style>
      <div style={{ background: 'var(--bg-2)', borderRight: '1px solid var(--hairline)', borderTop: '1px solid var(--hairline)' }}>{children}</div>
    </div>
  );
}

const phone = { parameters: { sidebar: 'phone' } } as const;
/** The phone drawer (360 px screen): the five in one row at 44 px, leave set apart. */
export const PhoneConnected: Story = { ...phone, args: { meter: <AudioMeter level={6} label="input level" /> } };
export const PhoneMutedAndDeafened: Story = { ...phone, args: { muted: true, deafened: true, meter: <AudioMeter level={0} label="input level" /> } };
export const PhoneCameraAndSharing: Story = { ...phone, args: { camera: true, sharing: true, meter: <AudioMeter level={4} label="input level" /> } };
export const PhonePaused: Story = { ...phone, args: { phase: 'paused', canCamera: false, canShare: false, meter: <AudioMeter level={0} label="input level" /> } };
/** Paused with no meter in the phone drawer: the status takes the whole where/meter row, so "paused in harbour" shows
 *  in full (it still ends in an ellipsis when a long name does not fit). */
export const PhonePausedNoMeter: Story = {
  ...phone,
  args: { phase: 'paused', canCamera: false, canShare: false },
  play: ({ canvasElement }) => {
    expectVoiceTargets(canvasElement, 'VoiceDock');
    expectOneRow(canvasElement, 'VoiceDock');
    const text = canvasElement.querySelector<HTMLElement>('.d-voice-dock__text');
    if (text === null) throw new Error('VoiceDock: no status text');
    if (text.textContent !== 'paused in harbour') throw new Error(`VoiceDock: the status says "${text.textContent ?? ''}"`);
    if (text.scrollWidth > text.clientWidth) {
      throw new Error(`VoiceDock: "paused in harbour" is cut off (${String(text.scrollWidth)} px in ${String(text.clientWidth)} px)`);
    }
  },
};
