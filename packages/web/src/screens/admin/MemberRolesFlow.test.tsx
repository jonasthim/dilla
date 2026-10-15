import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { PERM } from '@dilla/client-core';
import { refusal } from '../../test/fake-client.ts';
import { ME } from '../../test/fixtures.ts';
import { ADMINS, CREW, EVERY, MODS, OWNER_ACCESS, ROLES, SERVER, harness, role, type HarnessOptions } from '../../test/roles-harness.tsx';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { en } from '../../strings/index.ts';
import { MemberRolesFlow } from './MemberRolesFlow.tsx';

const BOB = '28'.repeat(16);
const members = (bobRoles: string[] = []) => [{ userId: ME.id, username: 'ada', display: '', kind: 0 as const, roleIds: [] as string[] },
  { userId: BOB, username: 'bob', display: 'Bob', kind: 0 as const, roleIds: bobRoles }];

function setup(options: HarnessOptions & { bobRoles?: string[] } = {}) {
  const h = harness({ members: members(options.bobRoles), ...options });
  const onClose = vi.fn();
  const view = h.mount(<MemberRolesFlow communityId={SERVER} userId={BOB} onClose={onClose} announce={h.announce} />);
  return { ...h, view, onClose };
}
const ROLES_WITHOUT_MODS = ROLES.filter(r => r.id !== MODS);
const dialog = () => within(screen.getByRole('dialog'));

describe('MemberRolesFlow', () => {
  it('is titled for the member and lists the roles below @everyone, highest first, with the access note', () => {
    setup({ bobRoles: [CREW] });
    expect(screen.getByRole('heading', { name: 'Roles of Bob' })).toBeInTheDocument();
    expect(dialog().getAllByRole('checkbox').map(c => c.parentElement?.textContent)).toEqual(['admins', 'mods', 'crew']);
    expect(dialog().getByRole('checkbox', { name: 'crew' })).toBeChecked();
    expect(dialog().getByRole('checkbox', { name: 'mods' })).not.toBeChecked();
    expect(dialog().getByText(en['roles.access'])).toBeInTheDocument();
  });
  it('disables a role at or above my top with its detail, and a role carrying a bit I lack', () => {
    const roles = [role(EVERY, '@everyone', 0, { allow: PERM.viewChannel }), role(ADMINS, 'admins', 9), role(MODS, 'mods', 3, { allow: PERM.banMembers }),
      role(CREW, 'crew', 2, { allow: PERM.viewChannel })];
    setup({ roles, access: { ...OWNER_ACCESS, owner: false, top: 5 } });
    const admins = dialog().getByRole('checkbox', { name: 'admins' });
    expect(admins).toBeDisabled();
    expect(admins).toHaveAccessibleDescription('admins is at or above your highest role.');
    expect(dialog().getByRole('checkbox', { name: 'mods' })).toBeDisabled();
    expect(dialog().getByRole('checkbox', { name: 'mods' })).toHaveAccessibleDescription(en['roles.editor.notHeld']);
    expect(dialog().getByRole('checkbox', { name: 'crew' })).toBeEnabled();
  });
  it('grants then revokes, announcing each', async () => {
    const { fake, user, announce } = setup({ handler: (c, f) => {
      if (c.m === 'grantRole' || c.m === 'revokeRole') {
        f.set(`members:${SERVER}`, members(c.m === 'grantRole' ? [c.roleId] : []));
      }
      return Promise.resolve(null);
    } });
    await user.click(dialog().getByRole('checkbox', { name: 'mods' }));
    expect(fake.callsOf('grantRole')).toEqual([{ m: 'grantRole', communityId: SERVER, userId: BOB, roleId: MODS }]);
    await waitFor(() => expect(announce).toHaveBeenCalledWith('mods given to Bob.'));
    await waitFor(() => expect(dialog().getByRole('checkbox', { name: 'mods' })).toBeChecked());
    await user.click(dialog().getByRole('checkbox', { name: 'mods' }));
    expect(fake.callsOf('revokeRole')).toEqual([{ m: 'revokeRole', communityId: SERVER, userId: BOB, roleId: MODS }]);
    await waitFor(() => expect(announce).toHaveBeenCalledWith('mods taken from Bob.'));
  });
  it('marks the row busy while the change is in flight', async () => {
    let release: () => void = () => undefined;
    const { user } = setup({ handler: () => new Promise(r => { release = () => r(null); }) });
    await user.click(dialog().getByRole('checkbox', { name: 'mods' }));
    expect(dialog().getByRole('checkbox', { name: 'mods' })).toHaveAttribute('aria-busy', 'true');
    release();
    await waitFor(() => expect(dialog().getByRole('checkbox', { name: 'mods' })).not.toHaveAttribute('aria-busy'));
  });
  const cases: [string, Parameters<typeof refusal>[0], string][] = [
    ['403', { code: 'E_FORBIDDEN', status: 403 }, 'You cannot give or take mods. It is at or above your highest role, or it carries a permission you do not hold.'],
    ['404', { code: 'E_NOT_FOUND', status: 404 }, 'Bob is no longer in this server.'],
    ['other', { code: 'E_NETWORK' }, 'That did not work (E_NETWORK). Try again.'],
  ];
  for (const [label, init, text] of cases) {
    it(`maps ${label}`, async () => {
      const { user } = setup({ handler: () => Promise.reject(refusal(init)) });
      await user.click(dialog().getByRole('checkbox', { name: 'mods' }));
      expect(await dialog().findByRole('alert')).toHaveTextContent(text);
    });
  }
  it('maps a 404 to the role-gone copy when the role is no longer listed, else to the member-gone copy', async () => {
    const { user } = setup({ handler: (c, f) => {
      f.set(`roles:${SERVER}`, ROLES_WITHOUT_MODS);
      return Promise.reject(refusal({ code: 'E_NOT_FOUND', status: 404 }));
    } });
    await user.click(dialog().getByRole('checkbox', { name: 'mods' }));
    expect(await dialog().findByRole('alert')).toHaveTextContent(en['roles.error.gone']);
  });
  it('shows the loading line, not the empty note, while the roles are absent', () => {
    setup({ roles: null });
    expect(dialog().getByText(en['roles.loading'])).toBeInTheDocument();
    expect(screen.queryByText(en['roles.assign.none'])).toBeNull();
  });
  it('shows no blank name while the members are absent', () => {
    const h = harness();
    h.fake.set(`members:${SERVER}`, undefined as never);
    h.mount(<MemberRolesFlow communityId={SERVER} userId={BOB} onClose={() => undefined} announce={h.announce} />);
    expect(screen.queryByRole('heading', { name: 'Roles of' })).toBeNull();
    expect(dialog().getByText(en['roles.loading'])).toBeInTheDocument();
  });
  it('closes and announces when the member leaves while open', async () => {
    const { fake, onClose, announce } = setup();
    act(() => { fake.set(`members:${SERVER}`, members().slice(0, 1)); });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(announce).toHaveBeenCalledWith('Bob is no longer in this server.');
  });
  it('says there is nothing to give when no role can be assigned', () => {
    setup({ roles: [role(EVERY, '@everyone', 0, { allow: 3 })] });
    expect(dialog().getByText(en['roles.assign.none'])).toBeInTheDocument();
  });
  it('closes with the done button', async () => {
    const { user, onClose } = setup();
    await user.click(dialog().getByRole('button', { name: en['roles.assign.close'] }));
    expect(onClose).toHaveBeenCalled();
  });
  it('has no axe violations', async () => {
    setup();
    await expectNoAxeViolations(screen.getByRole('dialog'));
  });
});
