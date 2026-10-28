import type { Meta, StoryObj } from '@storybook/react-vite';
import { RoleEditor } from './RoleEditor.tsx';
import { ALLOWS, GROUPS, LABELS, LiveRoleEditor, ROLES, ALL_KEYS } from './RoleEditor.fixture.tsx';
import { t } from '../../../web/src/strings/index.ts';
import { signalPalette } from '../../../web/src/screens/admin/role-palette.ts';

const meta: Meta<typeof RoleEditor> = { title: 'Settings/RoleEditor', component: RoleEditor, parameters: { layout: 'padded' } };
export default meta;
type Story = StoryObj<typeof RoleEditor>;

export const RaidLead: Story = { render: () => <LiveRoleEditor /> };
export const Everyone: Story = { render: () => <LiveRoleEditor initial="everyone" /> };
export const DJRole: Story = { render: () => <LiveRoleEditor initial="dj" /> };
export const Saved: Story = {
  args: {
    roles: ROLES, selectedId: 'crew', onSelect: () => {}, name: 'crew', nameReadOnly: false, onName: () => {}, onNameCommit: () => {},
    colors: signalPalette(0x5AA8E6), color: 0x5AA8E6, onColor: () => {}, groups: GROUPS,
    values: Object.fromEntries(ALL_KEYS.map(k => [k, ALLOWS.crew.includes(k) ? 'allow' : 'inherit'])),
    onPermission: () => {}, labels: LABELS, status: { text: t('roles.editor.saved', { name: 'crew' }), alert: false, n: 1 },
  },
};
export const NameRefused: Story = {
  args: { ...Saved.args, name: '', nameError: t('roles.error.empty'), status: null },
};
export const Phone: Story = { parameters: { phoneViewport: true }, render: () => <LiveRoleEditor /> };
