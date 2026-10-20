import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommunityAccess, MemberSummary, RoleSummary } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient, refusal } from '../../test/fake-client.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { MemberPane } from './MemberPane.tsx';
import { reasonProblem } from './Moderation.tsx';

const id = (n: number) => n.toString(16).padStart(2, '0').repeat(16);
const CID = id(9), OWNER = id(1), ME = id(2), BOB = id(3), CAL = id(4);
const MOD: RoleSummary = { id: id(10), name: 'mods', color: 0, position: 5, hoist: true, mentionable: false, allow: 0, deny: 0, members: 0 };
const m = (userId: string, username: string, roleIds: string[] = []): MemberSummary => ({ userId, username, display: '', kind: 0, roleIds });
const EVERYONE = 'ab'.repeat(16);
const access = (over: Partial<CommunityAccess> = {}): CommunityAccess => ({ top: 5, owner: false, manageCommunity: false, manageChannels: false,
  kickMembers: true, banMembers: true, createInvite: false, manageRoles: false, loaded: true, overwritesLoaded: true, everyoneId: EVERYONE, ...over });

function setup(acc: CommunityAccess | undefined = access()) {
  const fake = new FakeClient();
  fake.set('communities', [{ id: CID, name: 'Midgard', owner: OWNER }]);
  fake.set(`members:${CID}`, [m(OWNER, 'olof'), m(ME, 'ada', [MOD.id]), m(BOB, 'bob'), m(CAL, 'carol', [MOD.id])]);
  fake.set(`presence:${CID}`, { [OWNER]: 'online', [ME]: 'online', [BOB]: 'online', [CAL]: 'online' });
  fake.set(`roles:${CID}`, [MOD]);
  if (acc) fake.set(`permissions:${CID}`, acc);
  const announce = vi.fn();
  const onMessage = vi.fn();
  const onCompare = vi.fn();
  const view = render(<div className="d-root"><CoreProvider client={fake}>
    <MemberPane communityId={CID} selfId={ME} onMessage={onMessage} onCompare={onCompare} announce={announce} /></CoreProvider></div>);
  return { fake, announce, onMessage, onCompare, view, user: userEvent.setup() };
}
async function pick(user: ReturnType<typeof userEvent.setup>, who: string, item: string) {
  await user.click(screen.getByRole('button', { name: `actions for ${who}` }));
  await user.click(screen.getByRole('menuitem', { name: item }));
}

describe('MemberPane', () => {
  it('waits for presence, then places offline members at the bottom with a spoken label', () => {
    const { fake } = setup();
    act(() => fake.set(`presence:${CID}`, null));
    expect(screen.getByRole('status')).toHaveTextContent('Loading members');
    act(() => fake.set(`presence:${CID}`, { [OWNER]: 'offline', [ME]: 'online', [BOB]: 'dnd', [CAL]: 'idle' }));
    expect(screen.getByRole('heading', { name: 'offline — 1' })).toBeInTheDocument();
    expect(screen.getByText('Do Not Disturb')).toBeInTheDocument();
  });
  it('orders a hoisted role section, then online, then offline, each with its count', () => {
    const { fake } = setup();
    act(() => fake.set(`presence:${CID}`, { [OWNER]: 'online', [ME]: 'online', [BOB]: 'offline', [CAL]: 'online' }));
    const titles = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent);
    expect(titles).toEqual(['mods — 2', 'online — 1', 'offline — 1']);
  });
  it('keeps keyboard focus on a member action when presence moves its row', () => {
    const { fake } = setup();
    const before = screen.getByRole('button', { name: 'actions for bob' });
    act(() => before.focus());
    act(() => fake.set(`presence:${CID}`, { [OWNER]: 'online', [ME]: 'online', [BOB]: 'offline', [CAL]: 'online' }));
    const after = screen.getByRole('button', { name: 'actions for bob' });
    expect(after).not.toBe(before);
    expect(after).toHaveFocus();
  });
  it('lists groups with the owner and you tags', async () => {
    const { view } = setup();
    expect(screen.getByRole('heading', { name: 'mods — 2' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'online — 2' })).toBeInTheDocument();
    expect(screen.getByText('owner')).toBeInTheDocument();
    expect(screen.getByText('you')).toBeInTheDocument();
    await expectNoAxeViolations(view.container);
  });
  it('offers kick and ban on bob, and none on the owner or an equal rank', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'actions for bob' }));
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['message', 'compare safety numbers', 'kick', 'ban']);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'actions for olof' }));
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['message', 'compare safety numbers']);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'actions for carol' }));
    expect(screen.queryByRole('menuitem', { name: 'kick' })).toBeNull();
  });
  it('shows no kick or ban until permissions have loaded', async () => {
    const { user } = setup(access({ loaded: false }));
    await user.click(screen.getByRole('button', { name: 'actions for bob' }));
    expect(screen.queryByRole('menuitem', { name: 'kick' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'ban' })).toBeNull();
  });
  it('hands message and compare to the shell', async () => {
    const { user, onMessage, onCompare } = setup();
    await pick(user, 'bob', 'message');
    await pick(user, 'bob', 'compare safety numbers');
    expect(onMessage).toHaveBeenCalledWith(BOB);
    expect(onCompare).toHaveBeenCalledWith(BOB);
  });
});

describe('role assignment', () => {
  it('offers roles only with manageRoles, opens the dialog and closes it with done', async () => {
    const { user } = setup(access({ manageRoles: true }));
    await user.click(screen.getByRole('button', { name: 'actions for bob' }));
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['message', 'compare safety numbers', 'roles', 'kick', 'ban']);
    await user.click(screen.getByRole('menuitem', { name: 'roles' }));
    const dialog = screen.getByRole('dialog', { name: 'Roles of bob' });
    expect(within(dialog).getByRole('checkbox', { name: 'mods' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('has no roles item without manageRoles', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'actions for bob' }));
    expect(screen.queryByRole('menuitem', { name: 'roles' })).toBeNull();
  });
});

describe('KickFlow', () => {
  it('kicks, announces and closes', async () => {
    const { user, fake, announce } = setup();
    await pick(user, 'bob', 'kick');
    const dialog = screen.getByRole('dialog', { name: 'Kick bob from Midgard?' });
    await user.click(within(dialog).getByRole('button', { name: 'Kick' }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith('bob was kicked.'));
    expect(fake.callsOf('kickMember')).toEqual([{ m: 'kickMember', communityId: CID, userId: BOB }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it.each([
    ['E_FORBIDDEN', 'You cannot kick bob. Their highest role is at or above yours, or your roles do not allow kicking.'],
    ['E_NOT_FOUND', 'bob is no longer in Midgard.'],
    ['E_NETWORK', 'That did not work (E_NETWORK). Try again.'],
  ])('maps %s to its copy and keeps the dialog open', async (code, text) => {
    const { user, fake } = setup();
    fake.handler = () => Promise.reject(refusal({ code }));
    await pick(user, 'bob', 'kick');
    await user.click(screen.getByRole('button', { name: 'Kick' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });
});

describe('focus and reopening', () => {
  it('Cancel returns focus to the row trigger', async () => {
    const { user } = setup();
    await pick(user, 'bob', 'kick');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'actions for bob' })).toHaveFocus());
  });
  it('a successful kick leaves focus on the member region, not body', async () => {
    const { user, fake } = setup();
    await pick(user, 'bob', 'kick');
    fake.handler = () => { fake.set(`members:${CID}`, [m(OWNER, 'olof'), m(ME, 'ada', [MOD.id]), m(CAL, 'carol', [MOD.id])]); return Promise.resolve(null); };
    await user.click(screen.getByRole('button', { name: 'Kick' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.body).not.toHaveFocus());
    expect(document.activeElement).toBe(document.querySelector('.d-member-list')?.parentElement);
  });
  it('reopening on another member does not show the busy label of the closed dialog', async () => {
    const { user, fake } = setup();
    fake.handler = () => new Promise(() => undefined);
    await pick(user, 'bob', 'kick');
    await user.click(screen.getByRole('button', { name: 'Kick' }));
    expect(screen.getByRole('button', { name: 'Kicking…' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await pick(user, 'bob', 'kick');
    expect(screen.getByRole('button', { name: 'Kick' })).toBeEnabled();
  });
});

describe('BanFlow', () => {
  it('sends the reason and a day by default', async () => {
    const { user, fake, announce } = setup();
    await pick(user, 'bob', 'ban');
    await user.type(screen.getByRole('textbox', { name: 'Reason' }), 'spam');
    await user.click(screen.getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith('bob was banned.'));
    expect(fake.callsOf('banMember')).toEqual([{ m: 'banMember', communityId: CID, userId: BOB, reason: 'spam', seconds: 86400 }]);
  });
  it('sends the chosen length: a week, and forever as null', async () => {
    const { user, fake } = setup();
    await pick(user, 'bob', 'ban');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Ban length' }), '7 days');
    await user.click(screen.getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(fake.callsOf('banMember')).toHaveLength(1));
    expect(fake.callsOf('banMember')[0]?.seconds).toBe(604800);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await pick(user, 'bob', 'ban');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Ban length' }), 'until lifted');
    await user.click(screen.getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(fake.callsOf('banMember')).toHaveLength(2));
    expect(fake.callsOf('banMember')[1]?.seconds).toBeNull();
  });
  it('refuses a long or control-character reason locally, with no call', async () => {
    const { user, fake } = setup();
    await pick(user, 'bob', 'ban');
    const reason = screen.getByRole('textbox', { name: 'Reason' });
    await user.click(reason);
    await user.paste('x'.repeat(513));
    await user.click(screen.getByRole('button', { name: 'Ban' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That reason is too long. A reason is up to 512 characters (fewer for some letters).');
    await user.clear(reason);
    await user.paste('bad\u0007bell');
    await user.click(screen.getByRole('button', { name: 'Ban' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A reason cannot hold control characters');
    expect(fake.callsOf('banMember')).toHaveLength(0);
  });
  it.each([
    [{ code: 'E_FORBIDDEN' }, 'You cannot ban bob.'],
    [{ code: 'E_BAD_INPUT', detail: 'unknown community', status: 400 }, 'That did not work (E_BAD_INPUT). Try again.'],
    [{ code: 'E_NOT_FOUND', status: 404 }, 'That did not work (E_NOT_FOUND). Try again.'],
    [{ code: 'E_INVALID_REQUEST', status: 400 }, 'The ban length was refused.'],
    [{ code: 'E_NETWORK' }, 'That did not work (E_NETWORK). Try again.'],
  ])('maps %o to its copy', async (init, text) => {
    const { user, fake } = setup();
    fake.handler = () => Promise.reject(refusal(init));
    await pick(user, 'bob', 'ban');
    await user.click(screen.getByRole('button', { name: 'Ban' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });
  it('refuses a reason by its bytes: 257 x e-acute is too long, 200 passes', async () => {
    const { user, fake } = setup();
    await pick(user, 'bob', 'ban');
    const reason = screen.getByRole('textbox', { name: 'Reason' });
    await user.click(reason);
    await user.paste('é'.repeat(257));
    await user.click(screen.getByRole('button', { name: 'Ban' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('too long');
    expect(fake.callsOf('banMember')).toHaveLength(0);
    await user.clear(reason);
    await user.paste('é'.repeat(200));
    await user.click(screen.getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(fake.callsOf('banMember')).toHaveLength(1));
  });
  it('counts a carriage return as a control character', () => {
    expect(reasonProblem('a\rb')).toBe('control');
    expect(reasonProblem('a\nb\tc')).toBeNull();
  });
  it('one call for a double click while the first is pending', async () => {
    const { user, fake } = setup();
    fake.handler = () => new Promise(() => undefined);
    await pick(user, 'bob', 'ban');
    const ban = screen.getByRole('button', { name: 'Ban' });
    // Both clicks land before React renders the disabled button.
    act(() => { ban.click(); ban.click(); });
    expect(fake.callsOf('banMember')).toHaveLength(1);
  });
  it('has no axe violations open', async () => {
    const { user } = setup();
    await pick(user, 'bob', 'ban');
    await expectNoAxeViolations(document.body);
  });
});

describe('role assignment focus', () => {
  it('returns focus when the member list reloads while the dialog closes', async () => {
    const { user, fake } = setup(access({ manageRoles: true, top: 6 }));
    await pick(user, 'bob', 'roles');
    act(() => fake.set(`presence:${CID}`, null));
    expect(screen.getByRole('status')).toHaveTextContent('Loading members');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => fake.set(`presence:${CID}`, { [OWNER]: 'online', [ME]: 'online', [BOB]: 'online', [CAL]: 'online' }));
    expect(screen.getByRole('button', { name: 'actions for bob' })).toHaveFocus();
  });
  it('Done after a grant that moves the member into a hoisted group returns focus to his re-mounted menu trigger', async () => {
    const { user, fake } = setup(access({ manageRoles: true, top: 6 }));
    fake.handler = c => {
      if (c.m === 'grantRole') fake.set(`members:${CID}`, [m(OWNER, 'olof'), m(ME, 'ada', [MOD.id]), m(BOB, 'bob', [MOD.id]), m(CAL, 'carol', [MOD.id])]);
      return Promise.resolve(null);
    };
    const before = screen.getByRole('button', { name: 'actions for bob' });
    await pick(user, 'bob', 'roles');
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'mods' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'actions for bob' })).not.toBe(before));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'actions for bob' })).toHaveFocus();
  });
});
