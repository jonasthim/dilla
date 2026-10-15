import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { refusal } from '../../test/fake-client.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { CREW, MODS, OWNER_ACCESS, ROLES, SERVER, harness, type HarnessOptions } from '../../test/roles-harness.tsx';
import { en } from '../../strings/index.ts';
import { RolesSection } from './RolesSection.tsx';

function setup(options: HarnessOptions = {}) {
  const h = harness(options);
  const view = h.mount(<RolesSection communityId={SERVER} serverName="Björn" announce={h.announce} />);
  return { ...h, view };
}
const row = (name: string) => within(screen.getByText(name, { selector: '.dw-admin-name' }).closest('li')!);

describe('RolesSection list', () => {
  it('lists roles highest first with @everyone last and its hint', () => {
    setup();
    expect(screen.getAllByRole('listitem').map(li => li.querySelector('.dw-admin-name')?.textContent)).toEqual(['admins', 'mods', 'crew', '@everyone']);
    expect(screen.getByText('2 members')).toBeInTheDocument();
    expect(screen.getAllByText('1 member')).toHaveLength(2);
    expect(screen.getByText(en['roles.everyoneHint'])).toBeInTheDocument();
  });
  it('gives @everyone edit only', () => {
    setup();
    expect(row('@everyone').getAllByRole('button').map(b => b.textContent)).toEqual(['edit']);
  });
  it('hides up on the top movable row and down on the lowest', () => {
    setup();
    expect(row('admins').queryByRole('button', { name: 'move admins up' })).toBeNull();
    expect(row('admins').getByRole('button', { name: 'move admins down' })).toBeInTheDocument();
    expect(row('crew').queryByRole('button', { name: 'move crew down' })).toBeNull();
    expect(row('crew').getByRole('button', { name: 'move crew up' })).toBeInTheDocument();
  });
  it('locks rows at or above my top: roles.locked and no actions', () => {
    setup({ access: { ...OWNER_ACCESS, owner: false, top: 5 } });
    expect(row('admins').queryAllByRole('button')).toHaveLength(0);
    expect(row('admins').getByText(new RegExp(en['roles.locked']))).toBeInTheDocument();
    expect(row('mods').queryAllByRole('button')).toHaveLength(0);
    expect(row('crew').queryByText(new RegExp(en['roles.locked']))).toBeNull();
    // crew is the only movable row: neither direction.
    expect(row('crew').queryByRole('button', { name: 'move crew up' })).toBeNull();
    expect(row('crew').queryByRole('button', { name: 'move crew down' })).toBeNull();
    expect(row('crew').getByRole('button', { name: 'edit crew' })).toBeInTheDocument();
  });
  it('shows a loading line while the roles are absent', () => {
    setup({ roles: null });
    expect(screen.getByText(en['roles.loading'])).toBeInTheDocument();
  });
  it('shows no retry beside a plain loading line, and reads once itself', async () => {
    const { fake } = setup({ roles: null });
    expect(screen.queryByRole('button', { name: en['roles.retry'] })).toBeNull();
    await waitFor(() => expect(fake.callsOf('selectCommunity')).toHaveLength(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('after a failed read shows roles.error.load with a retry that selects the server again', async () => {
    const { fake, user } = setup({ roles: null, handler: () => Promise.reject(refusal({ code: 'E_NETWORK' })) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the roles (E_NETWORK).');
    await user.click(screen.getByRole('button', { name: en['roles.retry'] }));
    expect(fake.callsOf('selectCommunity')).toEqual([{ m: 'selectCommunity', communityId: SERVER }, { m: 'selectCommunity', communityId: SERVER }]);
  });
  it('has no axe violations', async () => {
    const { view } = setup();
    await expectNoAxeViolations(view.container);
  });
});

describe('RolesSection move', () => {
  it('calls moveRole with the direction and announces', async () => {
    const { fake, user, announce } = setup();
    await user.click(screen.getByRole('button', { name: 'move mods down' }));
    expect(fake.callsOf('moveRole')).toEqual([{ m: 'moveRole', communityId: SERVER, roleId: MODS, direction: 'down' }]);
    await waitFor(() => expect(announce).toHaveBeenCalledWith('mods moved.'));
    await user.click(screen.getByRole('button', { name: 'move mods up' }));
    expect(fake.callsOf('moveRole')[1].direction).toBe('up');
  });
  it('keeps focus on the moved role: its button follows the row', async () => {
    const { user } = setup({ handler: (c, f) => {
      if (c.m === 'moveRole') {
        f.set(`roles:${SERVER}`, ROLES.map(r => (r.id === MODS ? { ...r, position: 1 } : r.id === CREW ? { ...r, position: 5 } : r)));
      }
      return Promise.resolve(null);
    } });
    await user.click(screen.getByRole('button', { name: 'move mods down' }));
    // mods is now the lowest role, so it can only move up: focus lands on that button.
    await waitFor(() => expect(screen.getByRole('button', { name: 'move mods up' })).toHaveFocus());
  });
  it('shows roles.error.move on a failure', async () => {
    const { user } = setup({ handler: () => Promise.reject(refusal({ code: 'E_NETWORK' })) });
    await user.click(screen.getByRole('button', { name: 'move mods down' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not move mods (E_NETWORK). Try again.');
  });
});

describe('RolesSection delete', () => {
  it('confirms, deletes, announces and focuses the new role button', async () => {
    const { fake, user, announce } = setup({ handler: (c, f) => {
      if (c.m === 'deleteRole') f.set(`roles:${SERVER}`, ROLES.filter(r => r.id !== c.roleId));
      return Promise.resolve(null);
    } });
    await user.click(screen.getByRole('button', { name: 'delete crew' }));
    expect(screen.getByRole('heading', { name: 'Delete crew?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: en['roles.deleteConfirm'] }));
    expect(fake.callsOf('deleteRole')).toEqual([{ m: 'deleteRole', communityId: SERVER, roleId: CREW }]);
    await waitFor(() => expect(announce).toHaveBeenCalledWith('crew deleted.'));
    await waitFor(() => expect(screen.getByRole('button', { name: en['roles.new'] })).toHaveFocus());
  });
  it('shows the error with an enabled confirm on failure', async () => {
    const { user } = setup({ handler: () => Promise.reject(refusal({ code: 'E_NETWORK' })) });
    await user.click(screen.getByRole('button', { name: 'delete admins' }));
    await user.click(screen.getByRole('button', { name: en['roles.deleteConfirm'] }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete admins (E_NETWORK). Try again.');
    expect(screen.getByRole('button', { name: en['roles.deleteConfirm'] })).toBeEnabled();
    expect(screen.getByRole('button', { name: en['roles.editor.cancel'] })).toHaveFocus();
  });
});
