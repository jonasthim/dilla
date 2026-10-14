import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Command, CommunityAccess, InviteSummary } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient, refusal } from '../../test/fake-client.ts';
import { account, ME } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { en } from '../../strings/index.ts';
import { messageTime } from '../shell-model.ts';
import { InviteFlow } from '../Create.tsx';
import { InvitesSection } from './InvitesSection.tsx';

const SERVER = 'a1'.repeat(16);
const BOB = '28'.repeat(16);
const INV1 = 'f1'.repeat(16);
const INV2 = 'f2'.repeat(16);
const EXPIRES = 1_900_000_000;

const INVITES: InviteSummary[] = [
  { id: INV1, createdBy: BOB, maxUses: 10, uses: 3, created: 1_800_000_000, expires: EXPIRES },
  { id: INV2, createdBy: null, maxUses: 1, uses: 0, created: 1_800_000_000, expires: EXPIRES + 86_400 },
];

const access = (over: Partial<CommunityAccess> = {}): CommunityAccess => ({ top: 0, owner: false, manageCommunity: false, manageChannels: false,
  kickMembers: false, banMembers: false, createInvite: true, manageRoles: false, loaded: true, ...over });

function setup(invites: InviteSummary[] | null = INVITES, handler?: (command: Command) => Promise<unknown>, members = true) {
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('communities', [{ id: SERVER, name: 'Midgard', owner: ME.id }]);
  if (members) {
    fake.set(`members:${SERVER}`, [
      { userId: ME.id, username: 'ada', display: '', kind: 0, roleIds: [] },
      { userId: BOB, username: 'bob', display: 'Bob B', kind: 0, roleIds: [] },
    ]);
  }
  if (invites !== null) fake.set(`invites:${SERVER}`, invites);
  fake.set(`permissions:${SERVER}`, access({ manageCommunity: true }));
  fake.handler = handler ?? (command => Promise.resolve(command.m === 'createInvite'
    ? { url: 'https://dilla.test/join/abc', code: 'abc', expires: EXPIRES } : null));
  const announce = vi.fn();
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}>
    <InvitesSection communityId={SERVER} serverName="Midgard" announce={announce} />
  </CoreProvider></div>);
  return { fake, user, view, announce };
}
const make = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: en['admin.invites.create'] }));

describe('the invites section', () => {
  it('reads the live list when it opens', async () => {
    const { fake } = setup();
    await waitFor(() => expect(fake.callsOf('loadInvites')).toEqual([{ m: 'loadInvites', communityId: SERVER }]));
  });
  it('makes a link for 7 days and 10 uses by default', async () => {
    const { fake, user } = setup();
    await make(user);
    await waitFor(() => expect(fake.callsOf('createInvite')).toEqual([{ m: 'createInvite', communityId: SERVER, maxUses: 10, ttlSeconds: 604_800 }]));
    expect(await screen.findByDisplayValue('https://dilla.test/join/abc')).toBeInTheDocument();
  });
  it.each([
    ['30 minutes', 1800], ['1 hour', 3600], ['6 hours', 21_600], ['12 hours', 43_200], ['1 day', 86_400], ['7 days', 604_800], ['30 days', 2_592_000],
  ] as const)('maps "Expires after: %s" to %i seconds', async (label, seconds) => {
    const { fake, user } = setup();
    await user.selectOptions(screen.getByRole('combobox', { name: en['admin.invites.expires'] }), label);
    await make(user);
    await waitFor(() => expect(fake.callsOf('createInvite')[0]?.ttlSeconds).toBe(seconds));
  });
  it.each([['1 use', 1], ['5 uses', 5], ['10 uses', 10], ['25 uses', 25], ['50 uses', 50], ['100 uses', 100], ['1000 uses', 1000]] as const)(
    'maps "Max uses: %s" to %i', async (label, uses) => {
      const { fake, user } = setup();
      await user.selectOptions(screen.getByRole('combobox', { name: en['admin.invites.uses'] }), label);
      await make(user);
      await waitFor(() => expect(fake.callsOf('createInvite')[0]?.maxUses).toBe(uses));
    });
  it('says a refused make by its copy, with a retry', async () => {
    const { fake, user } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 }));
    await make(user);
    expect(await screen.findByText(en['invite.error.forbidden'])).toBeInTheDocument();
  });
  it('lists the live links with who made them and when they end, and always says a link cannot be shown again', () => {
    setup();
    expect(screen.getByText(en['admin.invites.codeHidden'])).toBeInTheDocument();
    expect(screen.getByText(en['admin.invites.limitsNote'])).toBeInTheDocument();
    const list = screen.getByRole('list', { name: en['admin.invites.title'] });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(`by Bob B, 3 of 10 uses, expires ${messageTime(EXPIRES, Date.now())}`);
    expect(rows[1]).toHaveTextContent('by a deleted account, 0 of 1 uses');
  });
  it('shows the codeHidden note also with no live links', () => {
    setup([]);
    expect(screen.getByText(en['admin.invites.empty'])).toBeInTheDocument();
    expect(screen.getByText(en['admin.invites.codeHidden'])).toBeInTheDocument();
  });
  it('revokes a link and announces it', async () => {
    const { fake, user, announce } = setup();
    await user.click(screen.getByRole('button', { name: `revoke the link by Bob B that expires ${messageTime(EXPIRES, Date.now())}` }));
    await waitFor(() => expect(fake.callsOf('revokeInvite')).toEqual([{ m: 'revokeInvite', communityId: SERVER, inviteId: INV1 }]));
    await waitFor(() => expect(announce).toHaveBeenCalledWith(en['admin.invites.revoked']));
  });
  // Final fix M1: revoke is offered on a link this account made, or to someone who manages the server.
  it('without manageCommunity only the links this account made offer revoke', () => {
    const MINE = 'f3'.repeat(16);
    const { fake } = setup([...INVITES, { id: MINE, createdBy: ME.id, maxUses: 5, uses: 0, created: 1_800_000_000, expires: EXPIRES }]);
    expect(screen.getAllByRole('button', { name: /^revoke/ })).toHaveLength(3);
    act(() => { fake.publish(`permissions:${SERVER}`, access({ manageCommunity: false })); });
    const revokes = screen.getAllByRole('button', { name: /^revoke/ });
    expect(revokes).toHaveLength(1);
    expect(revokes[0]).toHaveAccessibleName(`revoke the link by ada that expires ${messageTime(EXPIRES, Date.now())}`);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
  it('says a revoke refusal (403) by its copy and other failures by their code', async () => {
    const { fake, user, announce } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 }));
    const revoke = () => user.click(screen.getAllByRole('button', { name: /^revoke/ })[0]);
    await revoke();
    expect(await screen.findByRole('alert')).toHaveTextContent(en['admin.invites.error.forbidden']);
    fake.handler = () => Promise.reject(refusal({ code: 'E_NETWORK' }));
    await revoke();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That did not work (E_NETWORK). Try again.'));
    expect(announce).not.toHaveBeenCalled();
  });
  it('says a failed list read with its code, and reads again on retry', async () => {
    const { fake, user } = setup(null, command => (command.m === 'loadInvites' ? Promise.reject(refusal({ code: 'E_NETWORK' })) : Promise.resolve(null)));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the invite links (E_NETWORK).');
    await user.click(screen.getByRole('button', { name: en['invite.retry'] }));
    await waitFor(() => expect(fake.callsOf('loadInvites')).toHaveLength(2));
  });
  it('has no axe violations', async () => {
    const { view } = setup();
    await expectNoAxeViolations(view.container);
  });
});

describe('InviteFlow more options', () => {
  function flow(onMoreOptions?: () => void) {
    const fake = new FakeClient();
    fake.set('account', account());
    fake.handler = () => Promise.resolve({ url: 'https://dilla.test/join/q', code: 'q', expires: EXPIRES });
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: () => Promise.resolve() } });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<div className="d-root"><CoreProvider client={fake}>
      <InviteFlow open community={{ id: SERVER, name: 'Midgard' }} onClose={onClose} onMoreOptions={onMoreOptions} />
    </CoreProvider></div>);
    return { fake, user, onClose };
  }
  it('keeps the quick path: ten uses, seven days, with no link to options when nobody wired it', async () => {
    const { fake } = flow();
    await screen.findByDisplayValue('https://dilla.test/join/q');
    expect(fake.callsOf('createInvite')).toEqual([{ m: 'createInvite', communityId: SERVER, maxUses: 10, ttlSeconds: 604_800 }]);
    expect(screen.queryByRole('button', { name: en['invite.options'] })).toBeNull();
  });
  it('offers more options, which closes the dialog and asks the shell for the invites tab', async () => {
    const onMore = vi.fn();
    const { user, onClose } = flow(onMore);
    await screen.findByDisplayValue('https://dilla.test/join/q');
    await user.click(await screen.findByRole('button', { name: en['invite.options'] }));
    expect(onMore).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('fix round 1: honest names and one make at a time', () => {
  it('calls a maker who is no longer a member a former member', () => {
    setup([{ id: INV1, createdBy: 'ab'.repeat(16), maxUses: 10, uses: 0, created: 1, expires: EXPIRES }]);
    expect(screen.getByRole('listitem')).toHaveTextContent(`by ${en['admin.member.former']}, 0 of 10 uses`);
  });
  it('lists no link while the members are not read, rather than naming a maker wrongly', () => {
    setup(INVITES, undefined, false);
    expect(screen.queryByRole('listitem')).toBeNull();
  });
  it('sends one createInvite when make is pressed again before the first answers', async () => {
    const { fake, user } = setup();
    let release: (v: unknown) => void = () => undefined;
    fake.handler = command => (command.m === 'createInvite' ? new Promise(r => { release = r; }) : Promise.resolve(null));
    const button = screen.getByRole('button', { name: en['admin.invites.create'] });
    await user.click(button);
    await user.click(button);
    expect(fake.callsOf('createInvite')).toHaveLength(1);
    release({ url: 'https://dilla.test/join/z', code: 'z', expires: EXPIRES });
    await screen.findByDisplayValue('https://dilla.test/join/z');
  });
});
