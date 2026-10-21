import type { Meta, StoryObj } from '@storybook/react-vite';
import { ComposedShell, fixtureStatusBar } from './AppShell.fixture.tsx';
import { LinkBanner } from '../LinkBanner/LinkBanner.tsx';
import { MemberList } from '../MemberList/MemberList.tsx';
import { UserPanel } from '../UserPanel/UserPanel.tsx';
import { VoiceDock } from '../VoiceDock/VoiceDock.tsx';

const meta: Meta = { title: 'Shell/AppShell' };
export default meta;
type Story = StoryObj;
// 1280×800 less the preview decorator's 16px padding on each side.
export const Shell: Story = { render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell /></div> };
export const ShellNarrow: Story = { render: () => <div style={{ width: 360, ['--d-shell-h' as string]: '740px' }}><ComposedShell /></div> };
// web3.4: the aside open at 1280 (a fourth column), 900 and 360 (the overlay drawer).
const members = (
  <MemberList label="members" loading={false} loadingLabel="Loading members…" emptyLabel="No members yet." onAction={() => {}}
    groups={[
      { id: 'mods', kind: 'role', title: 'moderators', members: [{ id: 'u1', name: 'Astrid', tags: ['owner'], actionsLabel: 'actions for Astrid', actions: [], presence: 'online' }] },
      { id: 'online', kind: 'online', title: 'online', members: [{ id: 'u2', name: 'Bjorn', tags: [], actionsLabel: 'actions for Bjorn', actions: [{ id: 'kick', label: 'kick' }, { id: 'ban', label: 'ban', danger: true }], presence: 'online' }] },
      { id: 'offline', kind: 'offline', title: 'offline', members: [{ id: 'u3', name: 'Cleo', tags: [], actionsLabel: 'actions for Cleo', actions: [], presence: 'offline' }] },
    ]} />
);
const withAside = { aside: members, asideLabel: 'members', asideOpen: true, onAsideClose: () => {}, asideCloseLabel: 'close members' };
export const AsideWide: Story = { render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell shell={withAside} /></div> };
export const AsideMedium: Story = { render: () => <div style={{ width: 900, ['--d-shell-h' as string]: '768px' }}><ComposedShell shell={withAside} /></div> };
// Final fix I2: the drawer's close button, at the top of the overlay (a column has none).
export const AsideNarrowClose: Story = {
  render: () => <div style={{ width: 360, ['--d-shell-h' as string]: '740px' }}><ComposedShell shell={withAside} /></div>,
  play: ({ canvasElement }) => {
    const close = canvasElement.querySelector<HTMLButtonElement>('.d-app-shell__aside-head button');
    if (close === null) throw new Error('the overlay drawer has no close button');
  },
};
// UI-3 review I1, B1: with the aside open at 1024 (the overlay) and at 1440 (a column), the members bar and the header bar end at the same y.
const barsAlign = (name: string) => ({ canvasElement }: { canvasElement: HTMLElement }) => {
  const header = canvasElement.querySelector<HTMLElement>('.d-channel-header');
  const bar = canvasElement.querySelector<HTMLElement>('.d-member-list__bar');
  if (header === null || bar === null) throw new Error(`${name}: no header or members bar`);
  const [h, b] = [header.getBoundingClientRect().bottom, bar.getBoundingClientRect().bottom];
  if (Math.abs(h - b) > 0.5) throw new Error(`${name}: the header bar ends at y=${String(h)}, the members bar at y=${String(b)}`);
};
export const Aside1024Bars: Story = { render: () => <div style={{ width: 1024, ['--d-shell-h' as string]: '768px' }}><ComposedShell shell={withAside} /></div>, play: barsAlign('Aside1024Bars') };
export const Aside1440Bars: Story = { render: () => <div style={{ width: 1440, ['--d-shell-h' as string]: '768px' }}><ComposedShell shell={withAside} /></div>, play: barsAlign('Aside1440Bars') };
export const AsideNarrow: Story = { render: () => <div style={{ width: 360, ['--d-shell-h' as string]: '740px' }}><ComposedShell shell={withAside} /></div> };
export const Offline: Story = { render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell banner /></div> };
// web3.8 (R4): the desktop shell has no status bar, so the link banner is the only word on the link, in the banner slot as on a phone.
export const LinkBannerDesktop: Story = {
  render: () => (
    <div style={{ ['--d-shell-h' as string]: '768px' }}>
      <ComposedShell shell={{ banner: <LinkBanner status="offline" labels={{ offline: 'offline · reconnecting to dilla.thim.dev', connecting: 'connecting to dilla.thim.dev' }} /> }} />
    </div>
  ),
};
// The optional status row, still available to a shell that passes one.
export const WithStatusBar: Story = { render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell shell={{ statusBar: fixtureStatusBar }} /></div> };
// web3.8 (U2): both splitters at 1280 (the aside is a column), with widths already dragged. Strict target size applies here (Shell/).
export const Splitters: Story = {
  render: () => (
    <div style={{ ['--d-shell-h' as string]: '768px' }}>
      <ComposedShell shell={{ ...withAside, paneWidths: { sidebar: 288, aside: 264 }, onPaneResize: () => {}, resizeLabels: { sidebar: 'resize the channel list', aside: 'resize the member list' } }} />
    </div>
  ),
};

// web3.8 (U3, R23): the bottom-left area spans under the rail and the sidebar: the voice dock over the user panel.
const userPanel = (
  <UserPanel name="Ada Lovelace" username="ada" muted={false} deafened={false} shortcuts={{ mute: 'Ctrl+Shift+M', deafen: 'Ctrl+Shift+D' }}
    labels={{ region: 'your account', mute: 'mute', deafen: 'deafen', settings: 'settings' }}
    onMute={() => {}} onDeafen={() => {}} onSettings={() => {}}
    status={{ current: 'online', label: 'your status: Online', items: [{ id: 'online', label: 'Online' }, { id: 'invisible', label: 'Invisible' }], onChoose: () => {} }} />
);
const dock = (
  <VoiceDock phase="connected" where="longhouse" muted={false} deafened={false} announcement="" onCamera={() => {}} onShare={() => {}} onLeave={() => {}}
    labels={{ region: 'voice controls', connecting: 'connecting', reconnecting: 'reconnecting', paused: 'paused in {where}',
      ping: '{ms} ms', pingNone: '— ms', rate: '↑{up} ↓{down} kb/s', stats: 'Ping {ms} milliseconds, {quality}. Sending {up}, receiving {down} kilobits per second.',
      quality: { good: 'good', poor: 'poor', bad: 'bad' },
      mute: 'mute', deafen: 'deafen', leave: 'leave', camera: 'camera', share: 'share screen' }} />
);
const bottomPlay = ({ canvasElement }: { canvasElement: HTMLElement }) => {
  const panel = canvasElement.querySelector<HTMLElement>('.d-app-shell__panel');
  const rail = canvasElement.querySelector<HTMLElement>('.d-app-shell__rail');
  const main = canvasElement.querySelector<HTMLElement>('.d-app-shell__main');
  if (panel === null || rail === null || main === null) throw new Error('the shell has no panel, rail or main');
  const [p, r, m] = [panel, rail, main].map(e => e.getBoundingClientRect());
  if (p.left > r.left + 1 || p.top < r.bottom - 1) throw new Error('the panel does not sit under the rail');
  if (p.right > m.left + 1) throw new Error('the panel overlaps main');
};
export const BottomPanel: Story = {
  render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell shell={{ bottom: <>{dock}{userPanel}</> }} /></div>,
  globals: { theme: 'mesh' }, play: bottomPlay,
};
/** MP8: the sidebar splitter runs from the sidebar's top to the panel's bottom, and a drag from the panel's edge resizes the sidebar. */
const fullHeightPlay = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  const q = (sel: string) => canvasElement.querySelector<HTMLElement>(sel);
  const sep = canvasElement.querySelector<HTMLElement>('[role="separator"][aria-label="resize the channel list"]');
  const sidebar = q('.d-app-shell__sidebar');
  const panel = q('.d-app-shell__panel');
  if (sep === null || sidebar === null || panel === null) throw new Error('the shell has no sidebar splitter, sidebar or panel');
  const [s, sb, p] = [sep, sidebar, panel].map(e => e.getBoundingClientRect());
  if (Math.abs(s.top - sb.top) > 1) throw new Error(`the splitter starts at ${s.top}, the sidebar at ${sb.top}`);
  if (Math.abs(s.bottom - p.bottom) > 1) throw new Error(`the splitter ends at ${s.bottom}, the panel at ${p.bottom}`);
  sep.scrollIntoView({ block: 'end' });
  const pr = panel.getBoundingClientRect();
  const x = pr.right - 1, y = pr.bottom - 10;
  if (document.elementFromPoint(x, y) !== sep) throw new Error('the panel edge, 10px above its bottom, does not hit the splitter');
  // The resting hairline is the splitter's own one line, drawn above the sidebar and the panel (what they paint under it cannot cut it).
  const line = getComputedStyle(sep, '::before');
  if (line.backgroundColor === 'rgba(0, 0, 0, 0)' || line.width !== '1px') throw new Error(`the splitter draws no 1px resting line (${line.backgroundColor}, ${line.width})`);
  if (Math.abs(parseFloat(line.height) - s.height) > 1) throw new Error(`the resting line is ${line.height} high, the splitter ${s.height}px`);
  if (getComputedStyle(panel).boxShadow !== 'none') throw new Error('the panel draws a second line');
  const userRow = canvasElement.querySelector<HTMLElement>('.d-user-panel');
  if (userRow === null) throw new Error('no user panel');
  const u = userRow.getBoundingClientRect();
  if (u.top < s.top || u.bottom > s.bottom + 1) throw new Error('the line does not cover the user panel rows');
  const before = Number(sep.getAttribute('aria-valuenow'));
  const ev = (type: string, dx: number) => sep.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x + dx, clientY: y }));
  ev('pointerdown', 0); ev('pointermove', 40);
  await new Promise(r => setTimeout(r, 50));
  const after = Number(sep.getAttribute('aria-valuenow'));
  ev('pointerup', 40);
  if (after <= before) throw new Error(`a drag from the panel edge did not widen the sidebar (${before} -> ${after})`);
};
export const BottomPanelSplitter: Story = {
  render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell shell={{ bottom: <>{dock}{userPanel}</>, paneWidths: { sidebar: 240, aside: 264 }, onPaneResize: () => {}, resizeLabels: { sidebar: 'resize the channel list', aside: 'resize the member list' } }} /></div>,
  globals: { theme: 'mesh' }, play: fullHeightPlay,
};
/** MP8: with a status bar the splitter stops above the status row. */
export const BottomPanelSplitterStatus: Story = {
  render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell shell={{ bottom: <>{dock}{userPanel}</>, statusBar: fixtureStatusBar, paneWidths: { sidebar: 240, aside: 264 }, onPaneResize: () => {}, resizeLabels: { sidebar: 'resize the channel list', aside: 'resize the member list' } }} /></div>,
  globals: { theme: 'mesh' },
  play: async ({ canvasElement }) => {
    await fullHeightPlay({ canvasElement });
    const sep = canvasElement.querySelector<HTMLElement>('[role="separator"][aria-label="resize the channel list"]');
    const status = canvasElement.querySelector<HTMLElement>('.d-app-shell__status');
    if (sep === null || status === null) throw new Error('no splitter or status bar');
    if (sep.getBoundingClientRect().bottom > status.getBoundingClientRect().top + 1) throw new Error('the splitter runs into the status bar');
  },
};
export const BottomPanelLight: Story = {
  render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell shell={{ bottom: <>{dock}{userPanel}</> }} /></div>,
  globals: { theme: 'light' }, play: bottomPlay,
};
export const BottomPanelHighContrast: Story = {
  render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell shell={{ bottom: <>{dock}{userPanel}</> }} /></div>,
  globals: { theme: 'high-contrast' }, play: bottomPlay,
};
/** The user panel alone, with the optional status bar still passed: the status row stays below the panel (C-22). */
export const BottomPanelWithStatus: Story = {
  render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell shell={{ bottom: userPanel, statusBar: fixtureStatusBar, aside: members, asideLabel: 'members', asideOpen: true, onAsideClose: () => {}, asideCloseLabel: 'close members' }} /></div>,
  play: ({ canvasElement }) => {
    bottomPlay({ canvasElement });
    const status = canvasElement.querySelector<HTMLElement>('.d-app-shell__status');
    const panel = canvasElement.querySelector<HTMLElement>('.d-app-shell__panel');
    if (status === null || panel === null) throw new Error('no status bar or panel');
    if (status.getBoundingClientRect().top < panel.getBoundingClientRect().bottom - 1) throw new Error('the status bar is not below the panel');
  },
};

/**
 * B1, R12: the main header and the members bar both have their hairline at y=48 from the shell's top, and the user panel is 52 high.
 * (The sidebar head is UI-2's half of the same line; the E-GEO rect checks cover all four at integration.)
 */
export const Desktop: Story = {
  render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell shell={{ ...withAside, bottom: userPanel }} /></div>,
  globals: { theme: 'mesh' },
  play: ({ canvasElement }) => {
    const shell = canvasElement.querySelector<HTMLElement>('.d-app-shell')!.getBoundingClientRect();
    const edge = (selector: string) => {
      const el = canvasElement.querySelector<HTMLElement>(selector);
      if (el === null) throw new Error(`Desktop: no ${selector}`);
      return el.getBoundingClientRect().bottom - shell.top;
    };
    for (const selector of ['.d-channel-header', '.d-member-list__bar']) {
      const y = edge(selector);
      if (Math.abs(y - 48) > 0.5) throw new Error(`Desktop: the hairline of ${selector} is at y=${String(y)}, not 48`);
    }
    const panel = canvasElement.querySelector<HTMLElement>('.d-user-panel')!.getBoundingClientRect();
    if (Math.abs(panel.height - 52) > 0.5) throw new Error(`Desktop: the user panel is ${String(panel.height)} high, not 52`);
  },
};
