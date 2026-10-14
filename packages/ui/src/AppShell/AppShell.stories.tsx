import type { Meta, StoryObj } from '@storybook/react-vite';
import { ComposedShell } from './AppShell.fixture.tsx';
import { MemberList } from '../MemberList/MemberList.tsx';

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
const withAside = { aside: members, asideLabel: 'members', asideOpen: true, onAsideClose: () => {} };
export const AsideWide: Story = { render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell shell={withAside} /></div> };
export const AsideMedium: Story = { render: () => <div style={{ width: 900, ['--d-shell-h' as string]: '768px' }}><ComposedShell shell={withAside} /></div> };
export const AsideNarrow: Story = { render: () => <div style={{ width: 360, ['--d-shell-h' as string]: '740px' }}><ComposedShell shell={withAside} /></div> };
export const Offline: Story = { render: () => <div style={{ ['--d-shell-h' as string]: '768px' }}><ComposedShell banner /></div> };
