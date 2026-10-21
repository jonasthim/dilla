import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { VoiceDock } from './VoiceDock.tsx';
import { UserPanel } from '../UserPanel/UserPanel.tsx';
import { nextFrame } from '../CallControls/CallControls.stories.tsx';

/**
 * R26, E1, E2: the dock is Discord's. No meter, no card (a hairline top and the panel's 12px inset), line 1 the status,
 * line 2 where, then camera, share and leave as 32px icon buttons in one row.
 */
function expectDock(root: HTMLElement, story: string): void {
  const dock = root.querySelector<HTMLElement>('.d-voice-dock');
  if (dock === null) throw new Error(`${story}: no dock`);
  const style = getComputedStyle(dock);
  if (style.borderTopWidth !== '1px' || parseFloat(style.borderTopLeftRadius) !== 0 || style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
    throw new Error(`${story}: the dock is a card (top border ${style.borderTopWidth}, radius ${style.borderTopLeftRadius}, fill ${style.backgroundColor})`);
  }
  if (parseFloat(style.paddingLeft) !== 12 || parseFloat(style.paddingRight) !== 12) throw new Error(`${story}: the dock's inset is ${style.paddingLeft}, not 12px`);
  if (dock.querySelector('[role="meter"], .d-audio-meter, .d-voice-dock__meter') !== null) throw new Error(`${story}: the dock draws a meter`);
  const buttons = Array.from(dock.querySelectorAll<HTMLElement>('.d-voice-dock__controls .d-icon-button'));
  if (buttons.length === 0) return;
  const tops = new Set(buttons.map(b => Math.round(b.getBoundingClientRect().top)));
  if (tops.size > 1) throw new Error(`${story}: the dock controls wrap (tops ${[...tops].join(', ')})`);
  for (const b of buttons) {
    const r = b.getBoundingClientRect();
    if (Math.abs(r.width - 32) > 0.5 || Math.abs(r.height - 32) > 0.5) throw new Error(`${story}: "${b.getAttribute('aria-label') ?? ''}" is ${String(r.width)} × ${String(r.height)}, not 32 × 32`);
  }
  const controls = dock.querySelector<HTMLElement>('.d-voice-dock__controls')!;
  if (controls.scrollWidth > controls.clientWidth + 1) throw new Error(`${story}: the dock controls scroll sideways`);
  if (dock.scrollWidth > dock.clientWidth + 1) throw new Error(`${story}: the dock scrolls sideways`);
}

// Every string is L-COPY-05's / layout's, quoted.
const meta = {
  title: 'Voice/VoiceDock', component: VoiceDock,
  args: {
    phase: 'connected', where: 'harbour', muted: false, deafened: false, announcement: '',
    labels: {
      region: 'voice controls', connecting: 'connecting', connected: 'voice connected', where: 'harbour · Midgard Crew', reconnecting: 'reconnecting',
      paused: 'paused', mute: 'mute', deafen: 'deafen', leave: 'leave', camera: 'camera', share: 'share screen',
      why: { paused: 'paused', joining: 'connecting', noShare: 'not available in this browser' },
    },
    camera: false, sharing: false, canCamera: true, canShare: true,
    onStatus: () => {}, onCamera: () => {}, onShare: () => {}, onLeave: () => {},
  },
  // The dock at the app's real widths: the desktop sidebar (240 px, its dock wrapper's 1 px edge), or with
  // `parameters.sidebar: 'phone'` the phone drawer of a 360 px screen (300 px, the 60 px rail beside it).
  decorators: [(Story, ctx) => (ctx.parameters.sidebar === 'phone' || window.innerWidth < 768
    ? <PhoneDrawer><Story /></PhoneDrawer> : <DesktopSidebar><Story /></DesktopSidebar>)],
  play: ({ canvasElement }) => { expectDock(canvasElement, 'VoiceDock'); },
} satisfies Meta<typeof VoiceDock>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = { args: { announcement: 'You joined harbour.' } };
export const Connecting: Story = { args: { phase: 'connecting' } };
export const Reconnecting: Story = { args: { phase: 'reconnecting' } };
/** Camera on and sharing: both glyphs swap (video, monitor-x) and are pressed toggles. */
/** V3: camera, share and leave sit together at the right end of the controls row. */
export const ControlsOnTheRight: Story = {
  play: ({ canvasElement }) => {
    const dock = canvasElement.querySelector<HTMLElement>('.d-voice-dock')!.getBoundingClientRect();
    const camera = canvasElement.querySelector<HTMLElement>('.d-voice-dock__controls .d-icon-button')!.getBoundingClientRect();
    if (camera.left <= dock.left + dock.width / 2) throw new Error(`ControlsOnTheRight: the camera starts at ${String(camera.left)}, left of the dock's centre`);
  },
};
export const CameraAndSharing: Story = { args: { camera: true, sharing: true } };
/** Paused (RV-3): the dock says so, and camera and share are aria-disabled as on the stage; the banner with its action
 *  lives on the stage. */
export const Paused: Story = { args: { phase: 'paused', canCamera: false, canShare: false } };
/** Paused, with keyboard focus on camera: its tooltip shows the name, and the reason is its description; the name stays "camera". */
export const PausedWhy: Story = {
  args: { phase: 'paused', paused: true, canCamera: false, canShare: false },
  play: async ({ canvasElement }) => {
    expectDock(canvasElement, 'VoiceDock');
    const camera = canvasElement.querySelector<HTMLButtonElement>('.d-voice-dock__controls button[aria-label="camera"]');
    if (camera === null) throw new Error('VoiceDock: no camera control');
    camera.focus();
    await nextFrame();
    if (camera.getAttribute('aria-disabled') !== 'true') throw new Error('VoiceDock: the paused camera is not aria-disabled');
    const ids = (camera.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    const described = ids.map(id => document.getElementById(id)?.textContent ?? '').join(' ');
    if (described !== 'paused') throw new Error(`VoiceDock: the camera is described as "${described}", not "paused"`);
  },
};
/** Joining: camera and share wait for the session (the stage's busy); leave stays live. */
export const Joining: Story = { args: { phase: 'connecting', busy: true } };
/** Keyboard focus on camera shows its tooltip, drawn in a portal and never inside a button. */
export const TooltipOnFocus: Story = {
  play: async ({ canvasElement }) => {
    expectDock(canvasElement, 'VoiceDock');
    canvasElement.querySelector<HTMLButtonElement>('.d-voice-dock__controls button')?.focus();
    await nextFrame();
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]');
    if (tip === null || tip.textContent !== 'camera') throw new Error(`VoiceDock: the tooltip says "${tip?.textContent ?? ''}", not "camera"`);
    if (canvasElement.contains(tip)) throw new Error('VoiceDock: the tooltip sits inside the dock');
  },
};
/** Without a status handler, line 1 is plain text. */
export const StatusIsText: Story = {
  args: { onStatus: undefined },
  play: ({ canvasElement }) => {
    expectDock(canvasElement, 'VoiceDock');
    if (canvasElement.querySelector('button.d-voice-dock__line1') !== null) throw new Error('VoiceDock: line 1 is a button without onStatus');
  },
};
/** With a handler, "voice connected" is a button (it opens Diagnostics); it is at least 24px high (WCAG 2.5.8). */
export const StatusIsButton: Story = {
  play: ({ canvasElement }) => {
    expectDock(canvasElement, 'VoiceDock');
    const b = canvasElement.querySelector<HTMLElement>('button.d-voice-dock__line1');
    if (b === null) throw new Error('VoiceDock: line 1 is not a button');
    if (b.getBoundingClientRect().height < 24) throw new Error('VoiceDock: the status button is under 24px high');
  },
};
/** Before the web app wires camera and share, the dock keeps leave. */
export const WithoutCameraAndShare: Story = { args: { onCamera: undefined, onShare: undefined } };
/** A DM call: line 2 is the DM's name, and the outgoing ring is announced through the dock's status region. */
export const DmRinging: Story = { args: { where: 'ada', announcement: 'ringing ada', labels: { ...meta.args.labels, where: 'ada' } } };
/** Rejoining: the dock stays at connecting while the join waits for its earlier Remove; the status region says so once. */
export const Rejoining: Story = { args: { phase: 'connecting', announcement: 'Rejoining harbour. This can take up to 30 seconds.' } };
/** A long channel and server name are cut with an ellipsis on line 2; nothing scrolls sideways. */
export const LongNames: Story = {
  args: { labels: { ...meta.args.labels, where: 'planning-for-the-midsummer-weekend · Midgard Crew and the Night Owls Society' } },
};

const userPanel = (
  <UserPanel name="Ada Lovelace" username="ada" muted={false} deafened={false} shortcuts={{ mute: 'Ctrl+Shift+M', deafen: 'Ctrl+Shift+D' }}
    labels={{ region: 'your account', mute: 'mute', deafen: 'deafen', settings: 'settings' }}
    onMute={() => {}} onDeafen={() => {}} onSettings={() => {}}
    status={{ current: 'online', label: 'your status: Online', items: [{ id: 'online', label: 'Online' }, { id: 'invisible', label: 'Invisible' }], onChoose: () => {} }} />
);
/** In a call: the dock above the 52px user panel, both with the same 32px icon buttons, the panel's top flush under the dock. */
export const InCall: Story = {
  render: args => <><VoiceDock {...args} />{userPanel}</>,
  play: ({ canvasElement }) => {
    expectDock(canvasElement, 'VoiceDock');
    const dock = canvasElement.querySelector<HTMLElement>('.d-voice-dock')!.getBoundingClientRect();
    const panel = canvasElement.querySelector<HTMLElement>('.d-user-panel')!.getBoundingClientRect();
    if (Math.abs(panel.top - dock.bottom) > 1) throw new Error(`VoiceDock: the panel starts at ${String(panel.top)}, the dock ends at ${String(dock.bottom)}`);
    if (Math.abs(panel.height - 52) > 0.5) throw new Error(`VoiceDock: the panel is ${String(panel.height)} high, not 52`);
    for (const b of Array.from(canvasElement.querySelectorAll<HTMLElement>('.d-icon-button'))) {
      const r = b.getBoundingClientRect();
      if (Math.abs(r.width - 32) > 0.5 || Math.abs(r.height - 32) > 0.5) throw new Error(`VoiceDock: "${b.getAttribute('aria-label') ?? ''}" is ${String(r.width)} × ${String(r.height)}`);
    }
  },
};

/** The app's desktop sidebar: 240 px, and the dock wrapper's 1 px right edge (app.css `.dw-voice-dock`). */
function DesktopSidebar({ children }: { children: ReactNode }) {
  return <div style={{ width: 240 }}><div style={{ background: 'var(--bg-2)', borderRight: '1px solid var(--hairline)' }}>{children}</div></div>;
}

/** The phone drawer at 360 px: 300 px wide, the dock wrapper's edges. */
function PhoneDrawer({ children }: { children: ReactNode }) {
  return (
    <div className="sb-phone-drawer" style={{ width: 300 }}>
      <div style={{ background: 'var(--bg-2)', borderRight: '1px solid var(--hairline)' }}>{children}</div>
    </div>
  );
}

const phone = { parameters: { sidebar: 'phone' } } as const;
/** The phone drawer (360 px screen): status, where, and the three controls in one row. */
export const PhoneConnected: Story = { ...phone };
export const PhoneCameraAndSharing: Story = { ...phone, args: { camera: true, sharing: true } };
export const PhonePaused: Story = { ...phone, args: { phase: 'paused', canCamera: false, canShare: false } };
