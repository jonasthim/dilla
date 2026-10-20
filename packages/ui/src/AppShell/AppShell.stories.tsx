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
      { id: 'mods', title: 'moderators', members: [{ id: 'u1', name: 'Astrid', tags: ['owner'], actionsLabel: 'actions for Astrid', actions: [] }] },
      { id: 'members', title: 'members', members: [{ id: 'u2', name: 'Bjorn', tags: [], actionsLabel: 'actions for Bjorn', actions: [{ id: 'kick', label: 'kick' }, { id: 'ban', label: 'ban', danger: true }] }] },
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
    labels={{ region: 'voice controls', connecting: 'connecting', connected: 'in {where}', reconnecting: 'reconnecting', paused: 'paused in {where}',
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
