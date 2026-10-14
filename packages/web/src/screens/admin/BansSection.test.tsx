import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BanSummary, Command } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient, refusal } from '../../test/fake-client.ts';
import { account, ME } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { en, formatDay } from '../../strings/index.ts';
import { BansSection } from './BansSection.tsx';
import { ServerSettings } from './ServerSettings.tsx';

const SERVER = 'a1'.repeat(16);
const BOB = '28'.repeat(16);
const CAROL = '3c'.repeat(16);
const DAVE = '4d'.repeat(16);
const GONE = '5e'.repeat(16);
const CREATED = 1_700_000_000;
const PAST = 1_750_000_000;
const FUTURE = 4_000_000_000;

const BANS: BanSummary[] = [
  { userId: BOB, name: 'Bob B', reason: 'spam', byUser: ME.id, created: CREATED, expires: PAST },
  { userId: CAROL, name: 'carol', reason: '', byUser: ME.id, created: CREATED, expires: null },
  { userId: DAVE, name: 'dave', reason: 'rude', byUser: ME.id, created: CREATED, expires: FUTURE },
  { userId: GONE, name: '', reason: '', byUser: ME.id, created: CREATED, expires: null },
];

function setup(bans: BanSummary[] | null = BANS, handler?: (command: Command) => Promise<unknown>, members: boolean = true) {
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('communities', [{ id: SERVER, name: 'Midgard', owner: ME.id }]);
  if (members) fake.set(`members:${SERVER}`, [{ userId: ME.id, username: 'ada', display: '', kind: 0, roleIds: [] }]);
  if (bans !== null) fake.set(`bans:${SERVER}`, bans);
  fake.handler = handler ?? (() => Promise.resolve(null));
  const announce = vi.fn();
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}>
    <BansSection communityId={SERVER} serverName="Midgard" announce={announce} />
  </CoreProvider></div>);
  return { fake, user, view, announce };
}
const rowOf = (text: string) => screen.getAllByRole('listitem').find(li => li.textContent?.includes(text))!;

describe('the bans section', () => {
  it('reads the ban list when it opens', async () => {
    const { fake } = setup();
    await waitFor(() => expect(fake.callsOf('loadBans')).toEqual([{ m: 'loadBans', communityId: SERVER }]));
  });
  it('shows who banned, when, and until when for a ban that is still running', () => {
    setup();
    const row = rowOf('dave');
    expect(row).toHaveTextContent(`banned by ada on ${formatDay(CREATED)}`);
    expect(row).toHaveTextContent(`ends ${formatDay(FUTURE)}`);
    expect(row).toHaveTextContent('rude');
  });
  it('says a lapsed ban ended and that the person can join again', () => {
    setup();
    const row = rowOf('Bob B');
    expect(row).toHaveTextContent(`ended ${formatDay(PAST)}; can join again`);
    expect(row).not.toHaveTextContent('ends ');
    expect(row).toHaveTextContent('spam');
  });
  it('says a forever ban is until lifted, and no reason when there is none', () => {
    setup();
    const row = rowOf('carol');
    expect(row).toHaveTextContent(en['admin.bans.forever']);
    expect(row).toHaveTextContent(en['admin.bans.noReason']);
  });
  it('names an unknown user only when the name is empty', () => {
    setup();
    expect(within(rowOf(en['admin.bans.unknownUser'])).getByRole('button', { name: `unban ${en['admin.bans.unknownUser']}` })).toBeInTheDocument();
    expect(screen.getAllByText(en['admin.bans.unknownUser'])).toHaveLength(1);
  });
  it('says it is loading until the list arrives', () => {
    setup(null);
    expect(screen.getByText(en['admin.bans.loading'])).toBeInTheDocument();
  });
  it('says nobody is banned from the server', () => {
    setup([]);
    expect(screen.getByText('Nobody is banned from Midgard.')).toBeInTheDocument();
  });
  it('says a failed read with its code, and reads again on retry', async () => {
    const { fake, user } = setup(null, command => (command.m === 'loadBans' ? Promise.reject(refusal({ code: 'E_NETWORK' })) : Promise.resolve(null)));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the ban list (E_NETWORK).');
    await user.click(screen.getByRole('button', { name: en['admin.bans.retry'] }));
    await waitFor(() => expect(fake.callsOf('loadBans')).toHaveLength(2));
  });
  it('unbans through a confirm, with focus on Cancel, and announces it', async () => {
    const { fake, user, announce } = setup();
    await user.click(screen.getByRole('button', { name: 'unban carol' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unban carol?' });
    expect(within(dialog).getByText('carol can join Midgard again with an invite. This does not add them back.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: en['admin.cancel'] })).toHaveFocus();
    expect(fake.callsOf('unbanMember')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: en['admin.bans.unbanConfirm'] }));
    await waitFor(() => expect(fake.callsOf('unbanMember')).toEqual([{ m: 'unbanMember', communityId: SERVER, userId: CAROL }]));
    await waitFor(() => expect(announce).toHaveBeenCalledWith('carol was unbanned.'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Unban carol?' })).toBeNull());
  });
  it('keeps the confirm open with a coded refusal', async () => {
    const { fake, user, announce } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_NETWORK' }));
    await user.click(screen.getByRole('button', { name: 'unban carol' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unban carol?' });
    await user.click(within(dialog).getByRole('button', { name: en['admin.bans.unbanConfirm'] }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That did not work (E_NETWORK). Try again.');
    expect(announce).not.toHaveBeenCalled();
  });
  it('cancels without sending anything', async () => {
    const { fake, user } = setup();
    await user.click(screen.getByRole('button', { name: 'unban carol' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unban carol?' });
    await user.click(within(dialog).getByRole('button', { name: en['admin.cancel'] }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Unban carol?' })).toBeNull());
    expect(fake.callsOf('unbanMember')).toEqual([]);
  });
  it('has no axe violations', async () => {
    const { view } = setup();
    await expectNoAxeViolations(view.container);
  });
});

describe('the bans tab of ServerSettings', () => {
  it('mounts the section for a person who can ban', () => {
    const fake = new FakeClient();
    fake.set('account', account());
    fake.set('communities', [{ id: SERVER, name: 'Midgard', owner: 'ee'.repeat(16) }]);
    fake.set(`permissions:${SERVER}`, { top: 1, owner: false, manageCommunity: false, manageChannels: false, kickMembers: false,
      banMembers: true, createInvite: false, manageRoles: false, loaded: true });
    fake.set(`bans:${SERVER}`, BANS);
    render(<div className="d-root"><CoreProvider client={fake}>
      <ServerSettings communityId={SERVER} tab="bans" onTab={vi.fn()} onClose={vi.fn()} announce={vi.fn()} />
    </CoreProvider></div>);
    expect(screen.getByRole('heading', { name: en['admin.bans.title'], level: 2 })).toBeInTheDocument();
  });
});

describe('fix round 1: focus and honest names', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('moves focus to the heading after an unban even when the list is published before the command resolves', async () => {
    const { fake, user } = setup();
    fake.handler = command => {
      if (command.m === 'unbanMember') fake.publish(`bans:${SERVER}`, BANS.filter(b => b.userId !== CAROL));
      return Promise.resolve(null);
    };
    await user.click(screen.getByRole('button', { name: 'unban carol' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unban carol?' });
    await user.click(within(dialog).getByRole('button', { name: en['admin.bans.unbanConfirm'] }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Unban carol?' })).toBeNull());
    await waitFor(() => expect(screen.getByRole('heading', { name: en['admin.bans.title'], level: 2 })).toHaveFocus());
  });
  it('calls a banner who is no longer a member a former member, not a deleted account', () => {
    setup([{ userId: CAROL, name: 'carol', reason: '', byUser: BOB, created: CREATED, expires: null }]);
    const row = rowOf('carol');
    expect(row).toHaveTextContent(`banned by ${en['admin.member.former']} on`);
    expect(row).not.toHaveTextContent(en['admin.bans.unknownUser']);
  });
  it('leaves out the by-clause while the members are not read', () => {
    setup(BANS, undefined, false);
    const row = rowOf('carol');
    expect(row).not.toHaveTextContent('banned by');
    expect(row).toHaveTextContent(en['admin.bans.forever']);
  });
  it('reads a ban that ends exactly now as ended', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(PAST * 1000));
    setup();
    expect(rowOf('Bob B')).toHaveTextContent(`ended ${formatDay(PAST)}; can join again`);
  });
});
