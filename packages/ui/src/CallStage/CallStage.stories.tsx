import { useEffect, useState } from 'react';
import { userEvent } from 'storybook/test';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { CallStage, type CallStageProps } from './CallStage.tsx';
import { CallControls, type CallControlsProps } from '../CallControls/CallControls.tsx';
import type { CallTileProps, VoiceParticipantView } from '../CallTile/CallTile.tsx';
import { expectVoiceTargets, nextFrame } from '../CallControls/CallControls.stories.tsx';
import { ChannelHeader } from '../ChannelHeader/ChannelHeader.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9).
const STATE: CallTileProps['labels']['state'] = {
  speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream',
  connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot', noSound: 'no sound',
};
const CONTROL_LABELS: CallControlsProps['labels'] = {
  region: 'call controls', mute: 'mute', deafen: 'deafen', camera: 'camera',
  share: 'share screen', leave: 'leave',
};
const noop = () => {};
const controls = (more: Partial<CallControlsProps> = {}) => (
  <CallControls muted={false} deafened={false} camera={false} sharing={false} canCamera canShare busy={false} labels={CONTROL_LABELS}
    onMute={noop} onDeafen={noop} onCamera={noop} onShare={noop} onLeave={noop} {...more} />
);
function tile(name: string, more: Partial<VoiceParticipantView> = {}, own = false): CallTileProps {
  return {
    view: { deviceId: `d-${name}`, userId: `u-${name}`, name, state: 'ok', speaking: false, muted: false, deafened: false,
      video: false, screen: false, web: true, bot: false, ...more },
    own, volume: 100, media: null, labels: { state: STATE, volume: `volume for ${name}`, volumeValue: '{n} %' }, onVolume: noop,
  };
}
const TILES = [tile('ada', { speaking: true }), tile('bo', { muted: true }), tile('you', {}, true)];
const LABELS: CallStageProps['labels'] = {
  code: 'call code',
  codeHelp: 'The code changes whenever someone joins or leaves. Read it aloud: if every screen shows the same code, everyone is hearing the same set of devices.',
  empty: 'Nobody is in voice yet.', tiles: 'people in voice',
};
const PAUSED = 'ada’s identity changed, so this call is paused for you: nothing you say is sent and nothing is played. Compare safety numbers in Privacy to continue, or wait until ada leaves.';

/** A 16:9 stream drawn on a canvas at story time (a stand-in camera); its tracks stop on unmount. */
function useDrawnStream(): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null);
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#1A1E22'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#A0A6A0'; ctx.beginPath(); ctx.arc(160, 80, 34, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(100, 124, 120, 56);
    const s = canvas.captureStream(5);
    setStream(s);
    return () => { s.getTracks().forEach(t => t.stop()); };
  }, []);
  return stream;
}

/** The stage with a drawn camera on ada's tile. */
function WithCamera(props: CallStageProps) {
  const media = useDrawnStream();
  return <CallStage {...props} tiles={props.tiles.map((t, i) => (i === 0 ? { ...t, media, view: { ...t.view, video: true } } : t))} />;
}

const meta = {
  title: 'Voice/CallStage', component: CallStage,
  args: { title: 'voice harbour', tiles: TILES, code: '284719306451873920465128390715', notice: null, controls: controls(), outgoing: null, labels: LABELS },
  decorators: [Story => <div style={{ maxWidth: 960 }}><Story /></div>],
  // Every control on the stage (code summary, volume ranges, notice action, call controls) is 40/44 px, flow 06.
  play: ({ canvasElement }) => { expectVoiceTargets(canvasElement, 'CallStage'); },
} satisfies Meta<typeof CallStage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = {};
/** No one in voice: the stage says so. */
export const Empty: Story = { args: { tiles: [], code: null } };
/** Joining: the controls appear but stay aria-disabled, and the tiles are connecting. */
export const Joining: Story = {
  args: { tiles: [tile('ada', { state: 'connecting' }), tile('you', { state: 'connecting' }, true)], code: null, controls: controls({ busy: true }) },
};
export const Camera: Story = { render: args => <WithCamera {...args} /> };
/** The call code opened: six groups of five digits and the help under them. */
export const CodeOpen: Story = {
  play: ({ canvasElement }) => {
    const summary = canvasElement.querySelector('summary');
    if (!summary) throw new Error('CodeOpen: no call code disclosure');
    summary.click();
    expectVoiceTargets(canvasElement, 'CallStage');
  },
};
/** RV-3: paused on this device. The banner and its action, no media in any tile, camera and share aria-disabled. */
export const Paused: Story = {
  args: {
    notice: { kind: 'paused', text: PAUSED, action: { label: 'compare safety numbers', onAction: noop }, focusOnce: true },
    controls: controls({ canCamera: false, canShare: false }),
  },
  render: args => <WithCamera {...args} />,
};
/** Blocked at join: the notice takes focus once; there is no join until the cause is gone. */
export const BlockedJoin: Story = {
  args: { tiles: [], code: null, controls: null,
    notice: { kind: 'blocked', text: 'A device in this voice failed the identity check. Joining is paused until it is removed.', action: null, focusOnce: true } },
};
/** Blocked at join because exactly one contact's identity changed (`voice.blockedChanged`, `{name}` from `call.changedUser`). */
export const BlockedChanged: Story = {
  args: { tiles: [], code: null, controls: null,
    notice: { kind: 'blocked', text: 'ada’s identity changed. Compare safety numbers in Privacy before joining.', action: null, focusOnce: true } },
};
/** Blocked mid-call (`voice.blocked`): this device left; the notice stays where the stage was. */
export const BlockedMidCall: Story = {
  args: { tiles: [], code: null, controls: null,
    notice: { kind: 'blocked', text: 'A device in this voice failed the identity check, so you left. Joining stays paused until it is removed.', action: null, focusOnce: true } },
};
/** A transient notice (`voice.micDenied`): listen-only, the tiles and their video stay. */
export const MicDenied: Story = {
  args: { notice: { kind: 'info', text: 'The microphone is blocked. You can listen; allow the microphone in the browser to talk.', action: null, focusOnce: false } },
  render: args => <WithCamera {...args} />,
};
export const Unverified: Story = { args: { tiles: [tile('ada', { state: 'unverified' }), tile('bo', { state: 'not-heard' }), tile('you', {}, true)] } };
/** A DM call ringing others: the strip text under the heading, no ringback tone. */
export const DmRinging: Story = {
  args: { title: 'ada', outgoing: { text: 'ringing ada' }, tiles: [tile('you', {}, true)], code: null },
};
export const DmDeclined: Story = { args: { title: 'ada', outgoing: { text: 'ada declined.' }, tiles: [tile('you', {}, true)], code: null } };

// WB a11y m8: the info notices of flow 06 § States, each a story, so the axe and target-size runs see them.
const info = (text: string): CallStageProps['notice'] => ({ kind: 'info', text, action: null, focusOnce: false });
const notJoined = { tiles: [tile('ada', { speaking: true }), tile('bo', { muted: true })], code: null };
/** `voice.full`: the join was refused; the join button is offered again. */
export const InfoFull: Story = { args: { ...notJoined, notice: info('This voice is full.'), controls: null } };
/** `voice.sharersFull`: the camera or share was refused; the call goes on. */
export const InfoSharersFull: Story = { args: { notice: info('Too many people are sharing. Try again when someone stops.') } };
/** `voice.failed`. */
export const InfoFailed: Story = { args: { ...notJoined, notice: info('Could not join voice. Try again.'), controls: null } };
/** `voice.removed`. */
export const InfoRemoved: Story = { args: { ...notJoined, notice: info('You were removed from voice.'), controls: null } };
/** `voice.disconnected` (WB client I3). */
export const InfoDisconnected: Story = { args: { ...notJoined, notice: info('The connection to voice was lost. Join again to continue.'), controls: null } };
/** `voice.ended` (WB client I3). */
export const InfoEnded: Story = { args: { ...notJoined, notice: info('Voice ended for everyone.'), controls: null } };
/** `voice.otherTab`. */
export const InfoOtherTab: Story = { args: { ...notJoined, notice: info('Voice is open in another tab of this browser.'), controls: null } };
/** `voice.micMissing`: listen-only. */
export const InfoMicMissing: Story = { args: { notice: info('No microphone found. You can listen.') } };
/** `voice.micFailed`: listen-only. */
export const InfoMicFailed: Story = { args: { notice: info('The microphone could not be connected. You can listen.') } };
/** An info notice at 360 CSS px: the notice wraps, nothing scrolls sideways, the controls stay 44 px. */
export const InfoPhone: Story = {
  args: { notice: info('The connection to voice was lost. Join again to continue.') },
  decorators: [Story => <div style={{ width: 360 }}><Story /></div>],
};
/** The hold after a refused rekey (`voice.held`, WB security I1): no action, no media, camera and share aria-disabled. */
export const Held: Story = {
  args: {
    notice: { kind: 'paused', text: 'A device in this call could not be checked yet, so this call is paused for you: nothing you say is sent and nothing is played. It continues once the check is done.', action: null, focusOnce: false },
    controls: controls({ canCamera: false, canShare: false }),
  },
};
/** Reconnecting: the tiles keep their last state; the dock says reconnecting. */
export const Reconnecting: Story = { args: { tiles: [tile('ada', { state: 'not-heard' }), tile('bo', { muted: true }), tile('you', {}, true)] } };
/** Toggles pressed (WB a11y I4): the labels stay mute, deafen, camera and share screen; `[x]` and aria-pressed say on. */
export const TogglesPressed: Story = { args: { controls: controls({ muted: true, deafened: true, camera: true, sharing: true }) } };

// U4: the grid, the focus layout and full screen. Tiles are keyed by `${deviceId}:${source}` and have a focus button.
type StageTile = CallStageProps['tiles'][number];
function person(name: string, more: Partial<VoiceParticipantView> = {}, own = false): StageTile {
  const t = tile(name, more, own);
  const source = more.video ? 'camera' : 'avatar';
  return { ...t, id: `${t.view.deviceId}:${source}`, source, title: name, fullscreenLabel: `full screen ${name}`, mirror: own };
}
function shared(name: string): StageTile {
  const t = tile(name, { screen: true });
  return { ...t, id: `${t.view.deviceId}:screen`, source: 'screen', title: `${name} screen`, fullscreenLabel: `full screen ${name} screen` };
}
const NAMES = ['ada', 'bo', 'cy', 'di', 'ed', 'fy', 'gu', 'hi'];
function people(n: number): StageTile[] {
  return [...NAMES.slice(0, n - 1).map((name, i) => person(name, { video: i % 2 === 0, speaking: i === 1, muted: i === 2 })), person('you', { video: true }, true)];
}

/** A stateful stage: the focus button toggles `focusedId`; the stand-in cameras are drawn at story time. */
function StageDemo(props: CallStageProps & { initialFocus?: string | null }) {
  const media = useDrawnStream();
  const [focusedId, setFocusedId] = useState<string | null>(props.initialFocus ?? null);
  return <CallStage {...props} tiles={props.tiles.map(t => (t.view.video || t.source === 'screen' ? { ...t, media } : t))} focusedId={focusedId} onFocus={setFocusedId} />;
}
const stageBox = (Story: () => React.JSX.Element) => (
  <div style={{ width: '100%', maxWidth: 960, height: 620, display: 'grid', gridTemplateRows: 'minmax(0, 1fr)' }}><Story /></div>
);

/** The stage's phone layout (CallStage.css) follows the browser viewport, not the story frame: the story shooter also runs at 360×740. */
const onPhone = (): boolean => window.matchMedia('(max-width: 47.99rem)').matches;
/** Phone (R9): one column for up to two tiles and two above, every tile inside the area's width, no filmstrip. */
function expectPhoneStage(root: HTMLElement, story: string, n: number): void {
  const tiles = Array.from(root.querySelectorAll<HTMLElement>('li.d-call-stage__tile'));
  const area = root.querySelector<HTMLElement>('.d-call-stage__tiles')!.getBoundingClientRect();
  const columns = new Set(tiles.map(li => Math.round(li.getBoundingClientRect().left)));
  if (tiles.length !== n) throw new Error(`${story}: ${String(tiles.length)} tiles, expected ${String(n)}`);
  if (columns.size !== (n > 2 ? 2 : 1)) throw new Error(`${story}: ${String(columns.size)} columns on a phone, expected ${String(n > 2 ? 2 : 1)}`);
  for (const li of tiles) {
    const r = li.getBoundingClientRect();
    if (r.left < area.left - 1 || r.right > area.right + 1) throw new Error(`${story}: a phone tile overflows the area's width`);
  }
  // An odd last tile does not sit alone beside an empty cell: it spans both columns.
  if (n > 2 && n % 2 === 1) {
    const last = tiles[tiles.length - 1].getBoundingClientRect();
    if (last.width < area.width - 2) throw new Error(`${story}: the odd last tile is ${String(last.width)} wide in ${String(area.width)}`);
  }
  expectVisibleTargets(root, story);
}
/** The tiles are 16:9, none overflows the area, and they are as wide as the area allows (no tile is smaller than a row's worth). */
function expectGrid(root: HTMLElement, story: string, n: number): void {
  if (onPhone()) { expectPhoneStage(root, story, n); return; }
  const tiles = Array.from(root.querySelectorAll<HTMLElement>('li.d-call-stage__tile'));
  const area = root.querySelector<HTMLElement>('.d-call-stage__tiles')!.getBoundingClientRect();
  if (tiles.length !== n) throw new Error(`${story}: ${String(tiles.length)} tiles, expected ${String(n)}`);
  for (const li of tiles) {
    const r = li.getBoundingClientRect();
    if (Math.abs(r.width / r.height - 16 / 9) > 0.03) throw new Error(`${story}: a tile is ${String(r.width)} × ${String(r.height)}, not 16:9`);
    if (r.right > area.right + 1 || r.bottom > area.bottom + 1 || r.left < area.left - 1 || r.top < area.top - 1) throw new Error(`${story}: a tile overflows the area`);
  }
  expectVoiceTargets(root, story);
}
/** Focused: the focused tile spans row 1 at the visible width, the others are 7.5rem high and flow in one row below it. */
function expectFocused(root: HTMLElement, story: string): void {
  const stage = root.querySelector('.d-call-stage');
  if (stage?.hasAttribute('data-focused-stage') !== true) throw new Error(`${story}: the stage is not focused`);
  if (onPhone()) {
    // Phone: no filmstrip; the focused tile goes first and takes the area's full width.
    const first = root.querySelector<HTMLElement>('li[data-focused="true"]')!.getBoundingClientRect();
    const rest = Array.from(root.querySelectorAll<HTMLElement>('li[data-focused="false"]')).map(li => li.getBoundingClientRect());
    const box = root.querySelector<HTMLElement>('.d-call-stage__tiles')!.getBoundingClientRect();
    if (first.width < box.width - 2) throw new Error(`${story}: the focused tile is ${String(first.width)} wide on a phone, in ${String(box.width)}`);
    if (rest.some(r => r.top < first.bottom - 1)) throw new Error(`${story}: a phone tile is not under the focused tile`);
    expectVisibleTargets(root, story);
    return;
  }
  const big = root.querySelector<HTMLElement>('li[data-focused="true"]')!.getBoundingClientRect();
  const area = root.querySelector<HTMLElement>('.d-call-stage__tiles')!.getBoundingClientRect();
  const strip = Array.from(root.querySelectorAll<HTMLElement>('li[data-focused="false"]')).map(li => li.getBoundingClientRect());
  if (big.width < area.width - 2) throw new Error(`${story}: the focused tile is ${String(big.width)} wide in ${String(area.width)}`);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  for (const r of strip) {
    if (Math.abs(r.height - 7.5 * rem) > 1 || r.top < big.bottom - 1 || Math.abs(r.top - strip[0].top) > 1) throw new Error(`${story}: the filmstrip is not one row of 7.5rem tiles under the focused tile`);
  }
  for (const volume of Array.from(root.querySelectorAll<HTMLElement>('li[data-focused="false"] .d-call-tile__volume'))) {
    if (getComputedStyle(volume).display !== 'none') throw new Error(`${story}: a filmstrip tile shows its volume`);
  }
  // The strip tiles sit together (neighbours less than twice the grid gap apart) and, when they fit, are centred as a group.
  const gap = 0.75 * rem;
  const gaps = strip.slice(1).map((r, i) => r.left - strip[i].right);
  if (gaps.some(g => g >= 2 * gap)) throw new Error(`${story}: the filmstrip is spread out (gaps ${gaps.join(', ')}, grid gap ${String(gap)})`);
  const before = strip[0].left - area.left;
  const after = area.right - strip[strip.length - 1].right;
  if (before > 1 && after > 1 && Math.abs(before - after) > 2) throw new Error(`${story}: the filmstrip is not centred (${String(before)} against ${String(after)})`);
  // The focused tile starts at the area's left edge (scrolled or not) and its full-screen button is on screen.
  if (Math.abs(big.left - area.left) > 1) throw new Error(`${story}: the focused tile starts at ${String(big.left)}, not at the area's ${String(area.left)}`);
  const fs = root.querySelector<HTMLElement>('li[data-focused="true"] .d-call-tile__fullscreen');
  if (fs !== null) {
    const f = fs.getBoundingClientRect();
    if (f.right > area.right + 1 || f.right > window.innerWidth) throw new Error(`${story}: the focused tile's full-screen button is off screen (right edge ${String(f.right)})`);
  }
  expectVisibleTargets(root, story);
}
/** `expectVoiceTargets` for what is drawn: an element with no client rects (the strip's `display: none` volume) is no target. */
function expectVisibleTargets(root: HTMLElement, story: string): void {
  const min = window.innerWidth < 768 ? 44 : 40;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('button, summary, input[type="range"]'))) {
    if (el.getClientRects().length === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.height < min || (!(el instanceof HTMLInputElement) && r.width < min)) {
      throw new Error(`${story}: "${el.getAttribute('aria-label') ?? el.textContent ?? ''}" is ${String(r.width)} × ${String(r.height)}, under ${String(min)} px`);
    }
  }
}

const gridStory = (n: number, theme: 'mesh' | 'light' | 'high-contrast'): Story => ({
  args: { tiles: people(n), code: null }, globals: { theme }, decorators: [stageBox],
  render: args => <StageDemo {...args} />,
  play: async ({ canvasElement }) => { await nextFrame(); await nextFrame(); expectGrid(canvasElement, `Grid${String(n)}`, n); },
});
const focusedStory = (theme: 'mesh' | 'light' | 'high-contrast'): Story => ({
  args: { tiles: [person('ada', { video: true }), shared('ada'), person('bo', { video: true, speaking: true }), person('cy', { muted: true }), person('you', { video: true }, true)], code: null },
  globals: { theme }, decorators: [stageBox],
  render: args => <StageDemo {...args} initialFocus="d-ada:screen" />,
  play: async ({ canvasElement }) => { await nextFrame(); await nextFrame(); expectFocused(canvasElement, 'Focused'); },
});
/** Two strip tiles under a focused screen: they sit together, centred as a group, not spread over equal shares. */
export const FocusedFew: Story = {
  args: { tiles: [person('ada', { video: true }), shared('ada'), person('you', { video: true }, true)], code: null },
  decorators: [stageBox],
  render: args => <StageDemo {...args} initialFocus="d-ada:screen" />,
  play: async ({ canvasElement }) => { await nextFrame(); await nextFrame(); expectFocused(canvasElement, 'FocusedFew'); },
};
/** Nine tiles with a person focused: the filmstrip overflows and scrolls, and the focused tile stays at the left edge. */
const focusedNineStory = (theme: 'mesh' | 'light' | 'high-contrast'): Story => ({
  args: { tiles: people(9), code: null }, globals: { theme }, decorators: [stageBox],
  render: args => <StageDemo {...args} initialFocus="d-ed:camera" />,
  play: async ({ canvasElement }) => { await nextFrame(); await nextFrame(); expectFocused(canvasElement, 'Focused9'); },
});
/** One tile fills the area above the toolbar. */
export const Grid1: Story = gridStory(1, 'mesh');
export const Grid1Light: Story = gridStory(1, 'light');
export const Grid1HighContrast: Story = gridStory(1, 'high-contrast');
/** Two tiles: one column or two, whichever makes the tiles widest. */
export const Grid2: Story = gridStory(2, 'mesh');
export const Grid2Light: Story = gridStory(2, 'light');
export const Grid2HighContrast: Story = gridStory(2, 'high-contrast');
/** Three tiles: on a phone the odd last one spans both columns. */
export const Grid3: Story = gridStory(3, 'mesh');
export const Grid5: Story = gridStory(5, 'mesh');
export const Grid4: Story = gridStory(4, 'mesh');
export const Grid4Light: Story = gridStory(4, 'light');
export const Grid4HighContrast: Story = gridStory(4, 'high-contrast');
export const Grid9: Story = gridStory(9, 'mesh');
export const Grid9Light: Story = gridStory(9, 'light');
export const Grid9HighContrast: Story = gridStory(9, 'high-contrast');
/** A shared screen focused: it spans row 1 and the people flow into the filmstrip under it; the same video elements stay. */
export const Focused: Story = focusedStory('mesh');
export const FocusedLight: Story = focusedStory('light');
export const FocusedHighContrast: Story = focusedStory('high-contrast');
export const Focused9: Story = focusedNineStory('mesh');
export const Focused9Light: Story = focusedNineStory('light');
export const Focused9HighContrast: Story = focusedNineStory('high-contrast');


// #37: remote screens on the stage: one without sound (the mark in its caption), one with sound (its own range and mute), one muted.
function silentScreen(name: string): StageTile { return { ...shared(name), silent: true }; }
function soundScreen(name: string, volume: number): StageTile {
  return { ...shared(name), stream: { volume, labels: { volume: `stream volume for ${name}`, mute: 'mute stream' }, onVolume: noop, onMute: noop } };
}
const screensStory = (theme: 'mesh' | 'light' | 'high-contrast'): Story => ({
  args: { tiles: [person('you', { video: true }, true), silentScreen('ada'), soundScreen('bo', 100), soundScreen('cy', 0)], code: null },
  globals: { theme }, decorators: [stageBox],
  render: args => <StageDemo {...args} />,
  play: async ({ canvasElement }) => {
    await nextFrame(); await nextFrame();
    expectGrid(canvasElement, 'Screens', 4);
    const marks = canvasElement.querySelectorAll('[data-state="no-sound"]').length;
    if (marks !== 1) throw new Error(`Screens: ${String(marks)} no-sound marks, expected 1 (only the silent screen; a muted stream is not silent)`);
  },
});
export const ScreensSound: Story = screensStory('mesh');
/** Phone (visited at 360 × 740): a real tap on the volume button inside the stage opens the popover, and the range is wide enough. */
export const ScreensPhonePopover: Story = {
  ...screensStory('mesh'),
  parameters: { phoneViewport: true },
  play: async ({ canvasElement }) => {
    await nextFrame(); await nextFrame();
    if (window.innerWidth >= 768) throw new Error('ScreensPhonePopover: not visited at the phone viewport');
    const button = canvasElement.querySelector<HTMLElement>('.d-call-tile__streamvol');
    if (button === null) throw new Error('ScreensPhonePopover: no volume button');
    // elementFromPoint at its centre is the button itself: a tile or a parent with pointer-events none would answer instead.
    const r = button.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit === null || !button.contains(hit)) throw new Error('ScreensPhonePopover: a tap on the volume button hits ' + (hit?.className ?? 'nothing'));
    await userEvent.click(button);
    const range = canvasElement.querySelector<HTMLInputElement>('.d-call-tile__popover input[type="range"]');
    if (range === null) throw new Error('ScreensPhonePopover: the tap opened no popover');
    if (range.getBoundingClientRect().width < 120) throw new Error(`ScreensPhonePopover: the range is ${String(range.getBoundingClientRect().width)} px, under 120`);
    const pop = range.closest<HTMLElement>('.d-call-tile__popover')!.getBoundingClientRect();
    const tileBox = range.closest<HTMLElement>('.d-call-tile')!.getBoundingClientRect();
    if (pop.left < tileBox.left - 1 || pop.right > tileBox.right + 1) throw new Error('ScreensPhonePopover: the popover leaves its tile');
  },
};

export const ScreensSoundLight: Story = screensStory('light');
export const ScreensSoundHighContrast: Story = screensStory('high-contrast');

// D1: a partial last row is centred in the area, not left under the first column.
function expectOrphanCentred(root: HTMLElement, story: string, expected: boolean): void {
  if (onPhone()) return;
  const orphans = Array.from(root.querySelectorAll<HTMLElement>('li[data-orphan]')).map(li => li.getBoundingClientRect());
  if (!expected) { if (orphans.length > 0) throw new Error(`${story}: ${String(orphans.length)} orphan tiles in a full grid`); return; }
  if (orphans.length === 0) throw new Error(`${story}: no orphan tile`);
  const area = root.querySelector<HTMLElement>('.d-call-stage__tiles')!.getBoundingClientRect();
  const mid = (Math.min(...orphans.map(r => r.left)) + Math.max(...orphans.map(r => r.right))) / 2;
  if (Math.abs(mid - (area.left + area.right) / 2) > 2) throw new Error(`${story}: the last row is centred at ${String(mid)}, the area at ${String((area.left + area.right) / 2)}`);
}
/** Three tiles at desktop widths: two columns, the third centred under them. */
export const Grid3Orphan: Story = {
  args: { tiles: people(3), code: null }, decorators: [stageBox],
  render: args => <StageDemo {...args} />,
  play: async ({ canvasElement }) => { await nextFrame(); await nextFrame(); expectGrid(canvasElement, 'Grid3Orphan', 3); expectOrphanCentred(canvasElement, 'Grid3Orphan', true); },
};
/** Five tiles, one of them speaking (the ring) and one at 70 % (the chip in its caption, away from the corner). */
export const Grid5SpeakingAndChip: Story = {
  args: { tiles: people(5).map((t, i) => (i === 0 ? { ...t, volume: 70 } : t)), code: null }, decorators: [stageBox],
  render: args => <StageDemo {...args} />,
  play: async ({ canvasElement }) => {
    await nextFrame(); await nextFrame();
    expectGrid(canvasElement, 'Grid5SpeakingAndChip', 5);
    const chip = canvasElement.querySelector<HTMLElement>('.d-call-tile__chip');
    if (chip === null || chip.textContent !== '70 %') throw new Error('Grid5SpeakingAndChip: no 70 % chip');
    const tileEl = chip.closest<HTMLElement>('.d-call-tile')!;
    const tile = tileEl.getBoundingClientRect();
    if (onPhone()) {
      // The phone tile is a column (CallTile.css): the caption, chip included, sits under the 16:9 media, so nothing covers the face
      // and the full-screen corner is the media's, not the caption's; the chip stays inside its tile.
      const media = tileEl.querySelector<HTMLElement>('.d-call-tile__media, .d-call-tile__avatar')!.getBoundingClientRect();
      const box = chip.getBoundingClientRect();
      if (box.top < media.bottom - 0.5) throw new Error('Grid5SpeakingAndChip: on a phone the chip sits over the media, not under it');
      if (box.right > tile.right + 0.5 || box.left < tile.left - 0.5) throw new Error('Grid5SpeakingAndChip: on a phone the chip leaves its tile');
    } else if (chip.getBoundingClientRect().right > tile.right - 40) throw new Error('Grid5SpeakingAndChip: the chip reaches the corner of the tile');
    if (canvasElement.querySelector('.d-call-tile[data-speaking="true"]') === null) throw new Error('Grid5SpeakingAndChip: nobody speaks');
  },
};
/** Each element has its room: in a 2-column phone grid a long name beside the web tag, a mute glyph and a volume chip keeps its first 8 characters. */
export const GridLongNames: Story = {
  args: { tiles: ['Björn Ironside', 'Ragnhild Lothbrok', 'Ivar Ragnarsson', 'you'].map((n, i) => person(n, { video: i % 2 === 0, muted: true }, i === 3)).map((t, i) => (i < 3 ? { ...t, volume: 70 } : t)), code: null },
  decorators: [stageBox], render: args => <StageDemo {...args} />,
  play: async ({ canvasElement }) => {
    await nextFrame(); await nextFrame();
    for (const name of Array.from(canvasElement.querySelectorAll<HTMLElement>('.d-call-tile__name'))) {
      const probe = document.createElement('span');
      probe.textContent = name.textContent.slice(0, 8);
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
      name.append(probe);
      const need = probe.getBoundingClientRect().width;
      probe.remove();
      if (name.scrollWidth > name.clientWidth + 1 && name.clientWidth + 1 < need) {
        throw new Error(`GridLongNames: "${name.textContent}" shows ${String(name.clientWidth)} px, under its first 8 characters (${String(need)} px)`);
      }
    }
  },
};
/** D3: the volume range is hidden until the pointer is over the tile or focus is inside it; the keyboard still reaches it. */
export const VolumeOnHoverAndFocus: Story = {
  args: { tiles: people(2), code: null }, decorators: [stageBox],
  render: args => <StageDemo {...args} />,
  play: async ({ canvasElement }) => {
    await nextFrame();
    const vol = canvasElement.querySelector<HTMLElement>('li[data-stage] .d-call-tile__volume');
    if (vol === null) throw new Error('VolumeOnHoverAndFocus: no volume');
    if (onPhone()) {
      // The phone has no hover: the range stays shown under the caption (CallTile.css), and focus changes nothing.
      if (getComputedStyle(vol).opacity !== '1') throw new Error('VolumeOnHoverAndFocus: on a phone the volume is hidden at rest');
      return;
    }
    if (getComputedStyle(vol).opacity !== '0') throw new Error('VolumeOnHoverAndFocus: the volume shows at rest');
    vol.querySelector<HTMLInputElement>('input')!.focus();
    await nextFrame();
    await new Promise(r => setTimeout(r, 250));
    if (getComputedStyle(vol).opacity !== '1') throw new Error('VolumeOnHoverAndFocus: the volume stays hidden while focused');
  },
};
/** C4: the voice ChannelHeader is the stage's 48 bar, its hairline at y=48 over the full stage width. */
export const WithHeader: Story = {
  args: {
    header: (
      <ChannelHeader name="voice harbour" actions={<><IconButton icon="users" label="members" /><IconButton icon="search" label="search" /></>} />
    ),
    tiles: people(3), code: null,
  },
  decorators: [stageBox],
  render: args => <StageDemo {...args} />,
  play: async ({ canvasElement }) => {
    await nextFrame(); await nextFrame();
    const stage = canvasElement.querySelector<HTMLElement>('.d-call-stage')!.getBoundingClientRect();
    const bar = canvasElement.querySelector<HTMLElement>('.d-call-stage__bar')!.getBoundingClientRect();
    if (Math.abs(bar.bottom - stage.top - 48) > 0.5) throw new Error(`WithHeader: the bar's hairline is at y=${String(bar.bottom - stage.top)}, not 48`);
    if (Math.abs(bar.width - stage.width) > 1) throw new Error('WithHeader: the bar is not the stage width');
  },
};
