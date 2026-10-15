import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { PERM } from '@dilla/client-core';
import { refusal } from '../../test/fake-client.ts';
import { ME } from '../../test/fixtures.ts';
import { ADMINS, EVERY, MODS, OWNER_ACCESS, ROLES, SERVER, harness, role, type HarnessOptions } from '../../test/roles-harness.tsx';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { en } from '../../strings/index.ts';
import { RolesSection } from './RolesSection.tsx';

function setup(options: HarnessOptions = {}) {
  const h = harness(options);
  const view = h.mount(<RolesSection communityId={SERVER} serverName="Björn" announce={h.announce} />);
  return { ...h, view };
}
const dialog = () => within(screen.getByRole('dialog'));
const nameField = () => dialog().getByRole('textbox', { name: en['roles.editor.name'] });
const created = () => Promise.resolve({ roleId: 'f'.repeat(32) });

describe('RoleEditorFlow create', () => {
  it('creates a role with the chosen fields and announces', async () => {
    const { fake, user, announce } = setup({ handler: created });
    await user.click(screen.getByRole('button', { name: en['roles.new'] }));
    expect(screen.getByRole('heading', { name: 'New role in Björn' })).toBeInTheDocument();
    await user.type(nameField(), 'helpers');
    await user.click(dialog().getByRole('radio', { name: 'green' }));
    await user.click(dialog().getByRole('switch', { name: en['roles.editor.hoist'] }));
    await user.click(dialog().getByRole('switch', { name: en['perm.send'] }));
    await user.click(dialog().getByRole('button', { name: en['roles.editor.create'] }));
    expect(fake.callsOf('createRole')).toEqual([{ m: 'createRole', communityId: SERVER, name: 'helpers', color: 0x30A46C, hoist: true,
      mentionable: false, allow: PERM.sendMessages }]);
    await waitFor(() => expect(announce).toHaveBeenCalledWith('helpers created.'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('refuses a blank name without a call', async () => {
    const { fake, user } = setup();
    await user.click(screen.getByRole('button', { name: en['roles.new'] }));
    await user.click(dialog().getByRole('button', { name: en['roles.editor.create'] }));
    expect(dialog().getByText(en['roles.error.empty'])).toBeInTheDocument();
    expect(fake.callsOf('createRole')).toHaveLength(0);
  });
  it('refuses a name over 100 bytes', async () => {
    const { fake, user } = setup();
    await user.click(screen.getByRole('button', { name: en['roles.new'] }));
    await user.type(nameField(), 'é'.repeat(51));
    await user.click(dialog().getByRole('button', { name: en['roles.editor.create'] }));
    expect(dialog().getByText(en['roles.error.long'])).toBeInTheDocument();
    expect(fake.callsOf('createRole')).toHaveLength(0);
  });
  it('keeps focus in the name field while typing after a name error', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: en['roles.new'] }));
    await user.click(dialog().getByRole('button', { name: en['roles.editor.create'] }));
    expect(dialog().getByText(en['roles.error.empty'])).toBeInTheDocument();
    await user.keyboard('ab');
    expect(nameField()).toHaveFocus();
    expect(nameField()).toHaveValue('ab');
  });
  it('sends an NFD name as NFC', async () => {
    const { fake, user } = setup({ handler: created });
    await user.click(screen.getByRole('button', { name: en['roles.new'] }));
    await user.type(nameField(), 'Björn');
    await user.click(dialog().getByRole('button', { name: en['roles.editor.create'] }));
    expect(fake.callsOf('createRole')[0].name).toBe('Björn');
  });
  it('names every colour, none first', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: en['roles.new'] }));
    expect(dialog().getAllByRole('radio').map(r => r.getAttribute('aria-label'))).toEqual(
      ['no colour', 'red', 'orange', 'amber', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown', 'grey']);
  });
  it('adds roles.color.custom when editing a role with an off-palette colour', async () => {
    const { user } = setup({ roles: [role(EVERY, '@everyone', 0, { allow: 3 }), role(MODS, 'mods', 5, { color: 0x123456 })] });
    await user.click(screen.getByRole('button', { name: 'edit mods' }));
    expect(dialog().getByRole('radio', { name: en['roles.color.custom'] })).toBeChecked();
  });
  it('has no axe violations', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: en['roles.new'] }));
    await expectNoAxeViolations(screen.getByRole('dialog'));
  });
});

describe('RoleEditorFlow refusals', () => {
  const cases: [string, Parameters<typeof refusal>[0], string][] = [
    ['403', { code: 'E_FORBIDDEN', status: 403 }, en['roles.error.forbidden']],
    ['409', { code: 'E_CONFLICT', status: 409 }, en['roles.error.conflict']],
    ['400 on create', { code: 'E_INVALID_REQUEST', status: 400 }, en['roles.error.full']],
    ['404', { code: 'E_NOT_FOUND', status: 404 }, en['roles.error.gone']],
    ['other', { code: 'E_NETWORK' }, 'Could not save the role (E_NETWORK). Try again.'],
  ];
  for (const [label, init, text] of cases) {
    it(`maps ${label}`, async () => {
      const { user } = setup({ handler: () => Promise.reject(refusal(init)) });
      await user.click(screen.getByRole('button', { name: en['roles.new'] }));
      await user.type(nameField(), 'x');
      await user.click(dialog().getByRole('button', { name: en['roles.editor.create'] }));
      expect(await dialog().findByRole('alert')).toHaveTextContent(text);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  }
});

describe('RoleEditorFlow edit refusals', () => {
  const edits: [string, Parameters<typeof refusal>[0], string][] = [
    ['400 is not "full"', { code: 'E_INVALID_REQUEST', status: 400 }, 'Could not save the role (E_INVALID_REQUEST). Try again.'],
    ['404', { code: 'E_NOT_FOUND', status: 404 }, en['roles.error.gone']],
    ['409', { code: 'E_CONFLICT', status: 409 }, en['roles.error.conflict']],
  ];
  for (const [label, init, text] of edits) {
    it(`maps ${label}`, async () => {
      const { user } = setup({ handler: () => Promise.reject(refusal(init)) });
      await user.click(screen.getByRole('button', { name: 'edit mods' }));
      await user.click(dialog().getByRole('switch', { name: en['roles.editor.hoist'] }));
      await user.click(dialog().getByRole('button', { name: en['roles.editor.save'] }));
      expect(await dialog().findByRole('alert')).toHaveTextContent(text);
    });
  }
});

describe('RoleEditorFlow edit', () => {
  it('sends a bit I do not hold unchanged in the mask, neither added nor stripped', async () => {
    const roles = [role(EVERY, '@everyone', 0, { allow: PERM.viewChannel | PERM.pinMessages }),
      role(MODS, 'mods', 1, { allow: PERM.banMembers | PERM.sendMessages })];
    const { fake, user } = setup({ roles, access: { ...OWNER_ACCESS, owner: false, top: 5 } });
    await user.click(screen.getByRole('button', { name: 'edit mods' }));
    expect(dialog().getByRole('switch', { name: en['perm.ban'] })).toHaveAttribute('aria-disabled', 'true');
    await user.click(dialog().getByRole('switch', { name: en['perm.pin'] }));
    await user.click(dialog().getByRole('button', { name: en['roles.editor.save'] }));
    expect(fake.callsOf('updateRole')[0].allow).toBe(PERM.banMembers | PERM.sendMessages | PERM.pinMessages);
  });
  it('has no axe violations in edit mode with disabled rows', async () => {
    const roles = [role(EVERY, '@everyone', 0, { allow: PERM.viewChannel }), role(MODS, 'mods', 1)];
    const { user } = setup({ roles, access: { ...OWNER_ACCESS, owner: false, top: 5 } });
    await user.click(screen.getByRole('button', { name: 'edit mods' }));
    await expectNoAxeViolations(screen.getByRole('dialog'));
  });
  it('sends only the changed fields', async () => {
    const { fake, user, announce } = setup();
    await user.click(screen.getByRole('button', { name: 'edit mods' }));
    expect(screen.getByRole('heading', { name: 'Edit mods' })).toBeInTheDocument();
    await user.click(dialog().getByRole('switch', { name: en['roles.editor.mentionable'] }));
    await user.click(dialog().getByRole('button', { name: en['roles.editor.save'] }));
    expect(fake.callsOf('updateRole')).toEqual([{ m: 'updateRole', communityId: SERVER, roleId: MODS, name: null, color: null, hoist: null,
      mentionable: true, allow: null }]);
    await waitFor(() => expect(announce).toHaveBeenCalledWith('mods saved.'));
  });
  it('sends allow when a permission changed', async () => {
    const { fake, user } = setup();
    await user.click(screen.getByRole('button', { name: 'edit mods' }));
    await user.click(dialog().getByRole('switch', { name: en['perm.pin'] }));
    await user.click(dialog().getByRole('button', { name: en['roles.editor.save'] }));
    expect(fake.callsOf('updateRole')[0].allow).toBe(PERM.pinMessages);
  });
  it('closes an unchanged submit without a call', async () => {
    const { fake, user } = setup();
    await user.click(screen.getByRole('button', { name: 'edit mods' }));
    await user.click(dialog().getByRole('button', { name: en['roles.editor.save'] }));
    expect(fake.callsOf('updateRole')).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('makes the @everyone name fixed and hides colour, hoist and mentionable', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'edit @everyone' }));
    expect(nameField()).toBeDisabled();
    expect(dialog().queryByRole('radiogroup')).toBeNull();
    expect(dialog().queryByRole('switch', { name: en['roles.editor.hoist'] })).toBeNull();
    expect(dialog().queryByRole('switch', { name: en['roles.editor.mentionable'] })).toBeNull();
  });
  it('disables a permission I do not hold, with the hint, and ignores clicks on it', async () => {
    const roles = [role(EVERY, '@everyone', 0, { allow: PERM.viewChannel | PERM.pinMessages }), role(MODS, 'mods', 1)];
    const { fake, user } = setup({ roles, access: { ...OWNER_ACCESS, owner: false, top: 5 } });
    await user.click(screen.getByRole('button', { name: 'edit mods' }));
    const send = dialog().getByRole('switch', { name: en['perm.send'] });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).toHaveAccessibleDescription(new RegExp(en['roles.editor.notHeld']));
    expect(dialog().getByRole('switch', { name: en['perm.pin'] })).not.toHaveAttribute('aria-disabled');
    await user.click(send);
    await user.click(dialog().getByRole('button', { name: en['roles.editor.save'] }));
    expect(fake.callsOf('updateRole')).toHaveLength(0);
  });
  it('treats an administrator as holding every permission', async () => {
    const roles = [role(EVERY, '@everyone', 0, { allow: PERM.viewChannel }), role(ADMINS, 'admins', 9, { allow: PERM.administrator }), role(MODS, 'mods', 1)];
    const { user } = setup({ roles, access: { ...OWNER_ACCESS, owner: false, top: 20 },
      members: [{ userId: ME.id, username: 'ada', display: '', kind: 0, roleIds: [ADMINS] }] });
    await user.click(screen.getByRole('button', { name: 'edit mods' }));
    expect(dialog().getByRole('switch', { name: en['perm.send'] })).not.toHaveAttribute('aria-disabled');
  });
});

describe('RoleEditorFlow focus', () => {
  it('opens a new role on the name field', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: en['roles.new'] }));
    expect(nameField()).toHaveFocus();
  });
  it('opens an existing role on the name field', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'edit mods' }));
    expect(nameField()).toHaveFocus();
  });
  it('Escape closes the editor and focus goes back to the new role button, not the body', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: en['roles.new'] }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: en['roles.new'] })).toHaveFocus();
  });
  it('after a create focus goes back to the new role button', async () => {
    const { user, announce } = setup({ handler: created });
    await user.click(screen.getByRole('button', { name: en['roles.new'] }));
    await user.type(nameField(), 'helpers');
    await user.click(dialog().getByRole('button', { name: en['roles.editor.create'] }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith('helpers created.'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: en['roles.new'] })).toHaveFocus();
  });
  it('after a save focus goes back to that row\'s edit button', async () => {
    const { user, announce } = setup();
    await user.click(screen.getByRole('button', { name: 'edit mods' }));
    await user.click(dialog().getByRole('switch', { name: en['roles.editor.mentionable'] }));
    await user.click(dialog().getByRole('button', { name: en['roles.editor.save'] }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith('mods saved.'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'edit mods' })).toHaveFocus();
  });
  it('a role deleted elsewhere while open closes the editor onto the new role button, not the body', async () => {
    const { user, fake } = setup();
    await user.click(screen.getByRole('button', { name: 'edit mods' }));
    act(() => fake.set(`roles:${SERVER}`, ROLES.filter(r => r.id !== MODS)));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: en['roles.new'] })).toHaveFocus();
  });
});
