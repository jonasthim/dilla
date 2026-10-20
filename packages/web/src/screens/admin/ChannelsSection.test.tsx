import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelSummary } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient, refusal } from '../../test/fake-client.ts';
import { account } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { en } from '../../strings/index.ts';
import { ChannelsSection } from './ChannelsSection.tsx';
import { ServerSettings } from './ServerSettings.tsx';

const SERVER = 'a1'.repeat(16);
const TALK = 'c1'.repeat(16);
const MUSIC = 'c2'.repeat(16);
const LOBBY = 'c3'.repeat(16);
const DEV = 'c4'.repeat(16);
const GENERAL = 'c5'.repeat(16);
const RANDOM = 'c6'.repeat(16);

const row = (id: string, kind: 0 | 1 | 2, name: string, parentId: string | null, position: number, topic = ''): ChannelSummary =>
  ({ id, communityId: SERVER, kind, mode: 0, name, topic, parentId, position, slowmode: 0, announcement: false, group: 'active' });
const CHANNELS: ChannelSummary[] = [
  row(RANDOM, 0, 'random', null, 0),
  row(TALK, 2, 'Talk', null, 0),
  row(MUSIC, 2, 'Music', null, 1),
  row(LOBBY, 0, 'lobby', TALK, 0, 'hello'),
  row(DEV, 0, 'dev', TALK, 1),
  row(GENERAL, 1, 'General voice', MUSIC, 0),
];

function setup(channels = CHANNELS) {
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('communities', [{ id: SERVER, name: 'Midgard', owner: 'ee'.repeat(16) }]);
  fake.set(`channels:${SERVER}`, channels);
  const announce = vi.fn();
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}>
    <ChannelsSection communityId={SERVER} serverName="Midgard" announce={announce} />
  </CoreProvider></div>);
  return { fake, user, view, announce };
}
const btn = (name: string) => screen.getByRole('button', { name });

describe('the channels section', () => {
  it('lists channels under their category, uncategorised ones first', () => {
    setup();
    const headings = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent);
    expect(headings).toEqual([en['admin.channels.noCategory'], 'Talk', 'Music']);
    const talk = screen.getByRole('list', { name: 'Talk' });
    expect(within(talk).getAllByRole('listitem').map(li => li.querySelector('.dw-admin-name')?.textContent)).toEqual(['#lobby', '#dev']);
  });
  it('sends moveChannel for a move up and a move down, and announces it', async () => {
    const { fake, user, announce } = setup();
    await user.click(btn('move dev up'));
    await user.click(btn('move lobby down'));
    expect(fake.callsOf('moveChannel')).toEqual([
      { m: 'moveChannel', channelId: DEV, direction: 'up' }, { m: 'moveChannel', channelId: LOBBY, direction: 'down' },
    ]);
    await waitFor(() => expect(announce).toHaveBeenCalledWith('dev moved.'));
  });
  it('cannot move the first of a group up or the last down', () => {
    setup();
    expect(btn('move lobby up')).toBeDisabled();
    expect(btn('move dev down')).toBeDisabled();
    expect(btn('move Talk up')).toBeDisabled();
    expect(btn('move Music down')).toBeDisabled();
    expect(btn('move Talk down')).toBeEnabled();
  });
  it('says a failed move with its code', async () => {
    const { fake, user } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_NETWORK' }));
    await user.click(btn('move dev up'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not move dev (E_NETWORK). Try again.');
  });
  it('creates a category from the new category dialog', async () => {
    const { fake, user } = setup();
    fake.handler = () => Promise.resolve({ channelId: 'd0'.repeat(16) });
    await user.click(btn('new category'));
    const dialog = await screen.findByRole('dialog', { name: 'New category in Midgard' });
    await user.type(within(dialog).getByRole('textbox', { name: en['admin.category.name'] }), '  Games ');
    await user.click(within(dialog).getByRole('button', { name: en['admin.category.submit'] }));
    await waitFor(() => expect(fake.callsOf('createCategory')).toEqual([{ m: 'createCategory', communityId: SERVER, name: 'Games' }]));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New category in Midgard' })).toBeNull());
  });
  it('asks for a category name, and says a failed create with its code', async () => {
    const { fake, user } = setup();
    await user.click(btn('new category'));
    const dialog = await screen.findByRole('dialog', { name: 'New category in Midgard' });
    await user.click(within(dialog).getByRole('button', { name: en['admin.category.submit'] }));
    expect(await within(dialog).findByText(en['admin.category.error.empty'])).toBeInTheDocument();
    expect(fake.callsOf('createCategory')).toEqual([]);
    fake.handler = () => Promise.reject(refusal({ code: 'E_NETWORK' }));
    await user.type(within(dialog).getByRole('textbox', { name: en['admin.category.name'] }), 'Games');
    await user.click(within(dialog).getByRole('button', { name: en['admin.category.submit'] }));
    expect(await within(dialog).findByText('Could not add the category (E_NETWORK). Try again.')).toBeInTheDocument();
  });
  it('has no axe violations', async () => {
    const { view } = setup();
    await expectNoAxeViolations(view.container);
  });
});

describe('the channel edit dialog', () => {
  it('sends parent top when the channel is moved out of its category, and only the fields that changed', async () => {
    const { fake, user } = setup();
    await user.click(btn('edit lobby'));
    const dialog = await screen.findByRole('dialog', { name: 'Edit #lobby' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: en['admin.channel.category'] }), en['admin.channels.noCategory']);
    await user.click(within(dialog).getByRole('button', { name: en['admin.channel.save'] }));
    await waitFor(() => expect(fake.callsOf('updateChannel')).toEqual([{ m: 'updateChannel', channelId: LOBBY, name: null, topic: null, parent: 'top', slowmode: null }]));
  });
  it('sends keep for an unchanged category, the slug of a new name and a new topic', async () => {
    const { fake, user } = setup();
    await user.click(btn('edit lobby'));
    const dialog = await screen.findByRole('dialog', { name: 'Edit #lobby' });
    const name = within(dialog).getByRole('textbox', { name: en['admin.channel.name'] });
    await user.clear(name);
    await user.type(name, 'Ship Talk');
    const topic = within(dialog).getByRole('textbox', { name: en['admin.channel.topic'] });
    await user.clear(topic);
    await user.type(topic, 'new topic');
    await user.click(within(dialog).getByRole('button', { name: en['admin.channel.save'] }));
    await waitFor(() => expect(fake.callsOf('updateChannel')).toEqual([{ m: 'updateChannel', channelId: LOBBY, name: 'ship-talk', topic: 'new topic', parent: 'keep', slowmode: null }]));
  });
  it('moves a channel into another category by its id', async () => {
    const { fake, user } = setup();
    await user.click(btn('edit random'));
    const dialog = await screen.findByRole('dialog', { name: 'Edit #random' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: en['admin.channel.category'] }), 'Music');
    await user.click(within(dialog).getByRole('button', { name: en['admin.channel.save'] }));
    await waitFor(() => expect(fake.callsOf('updateChannel')[0]?.parent).toBe(MUSIC));
  });
  it('edits a category by its name only, with no topic or category field', async () => {
    const { fake, user } = setup();
    await user.click(btn('edit Talk'));
    const dialog = await screen.findByRole('dialog', { name: 'Edit category Talk' });
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).queryByRole('textbox', { name: en['admin.channel.topic'] })).toBeNull();
    const name = within(dialog).getByRole('textbox', { name: en['admin.channel.name'] });
    await user.clear(name);
    await user.type(name, 'Chat');
    await user.click(within(dialog).getByRole('button', { name: en['admin.channel.save'] }));
    await waitFor(() => expect(fake.callsOf('updateChannel')).toEqual([{ m: 'updateChannel', channelId: TALK, name: 'Chat', topic: null, parent: 'keep', slowmode: null }]));
  });
  it('titles a voice channel without the hash', async () => {
    const { user } = setup();
    await user.click(btn('edit General voice'));
    expect(await screen.findByRole('dialog', { name: 'Edit General voice' })).toBeInTheDocument();
  });
  it('says refusals by their copy: empty name, 403, 404, 400', async () => {
    const { fake, user } = setup();
    await user.click(btn('edit lobby'));
    const dialog = await screen.findByRole('dialog', { name: 'Edit #lobby' });
    const name = within(dialog).getByRole('textbox', { name: en['admin.channel.name'] });
    const save = () => user.click(within(dialog).getByRole('button', { name: en['admin.channel.save'] }));
    await user.clear(name);
    await save();
    expect(await within(dialog).findByText(en['admin.channel.error.empty'])).toBeInTheDocument();
    expect(fake.callsOf('updateChannel')).toEqual([]);
    await user.type(name, 'x');
    for (const [r, copy] of [
      [refusal({ code: 'E_FORBIDDEN', status: 403 }), en['admin.channel.error.forbidden']],
      [refusal({ code: 'E_NOT_FOUND', status: 404 }), en['admin.channel.error.gone']],
      [refusal({ code: 'E_INVALID_REQUEST', status: 400 }), en['admin.channel.error.refused']],
      [refusal({ code: 'E_NETWORK' }), 'Could not save the channel (E_NETWORK). Try again.'],
    ] as const) {
      fake.handler = () => Promise.reject(r);
      await save();
      expect(await within(dialog).findByText(copy)).toBeInTheDocument();
    }
  });
});

describe('the channel delete confirm', () => {
  it.each([
    ['delete lobby', 'Delete #lobby?', en['admin.channelDelete.body'], LOBBY],
    ['delete General voice', 'Delete General voice?', en['admin.channelDelete.bodyVoice'], GENERAL],
    ['delete Talk', 'Delete category Talk?', en['admin.channelDelete.bodyCategory'], TALK],
  ] as const)('%s asks "%s" with the body of its kind, then deletes', async (button, title, body, id) => {
    const { fake, user } = setup();
    await user.click(btn(button));
    const dialog = await screen.findByRole('dialog', { name: title });
    expect(within(dialog).getByText(body)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: en['admin.cancel'] })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: en['admin.channelDelete.confirm'] }));
    await waitFor(() => expect(fake.callsOf('deleteChannel')).toEqual([{ m: 'deleteChannel', channelId: id }]));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).toBeNull());
  });
  it('keeps the confirm open with a coded refusal', async () => {
    const { fake, user } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_NETWORK' }));
    await user.click(btn('delete lobby'));
    const dialog = await screen.findByRole('dialog', { name: 'Delete #lobby?' });
    await user.click(within(dialog).getByRole('button', { name: en['admin.channelDelete.confirm'] }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not delete (E_NETWORK). Try again.');
  });
});

describe('the channels tab of ServerSettings', () => {
  it('mounts the section for a person who manages channels', () => {
    const fake = new FakeClient();
    fake.set('account', account());
    fake.set('communities', [{ id: SERVER, name: 'Midgard', owner: 'ee'.repeat(16) }]);
    fake.set(`channels:${SERVER}`, CHANNELS);
    fake.set(`permissions:${SERVER}`, { top: 1, owner: false, manageCommunity: false, manageChannels: true, kickMembers: false,
      banMembers: false, createInvite: false, manageRoles: false, loaded: true, overwritesLoaded: true, everyoneId: 'ab'.repeat(16) });
    render(<div className="d-root"><CoreProvider client={fake}>
      <ServerSettings communityId={SERVER} tab="channels" onTab={vi.fn()} onClose={vi.fn()} announce={vi.fn()} />
    </CoreProvider></div>);
    expect(screen.getByRole('heading', { name: en['admin.channels.title'], level: 2 })).toBeInTheDocument();
  });
});

describe('fix round 1: focus and the category select', () => {
  it('moves focus to the heading after a delete even when the list is published before the command resolves', async () => {
    const { fake, user } = setup();
    fake.handler = command => {
      if (command.m === 'deleteChannel') fake.publish(`channels:${SERVER}`, CHANNELS.filter(c => c.id !== LOBBY));
      return Promise.resolve(null);
    };
    await user.click(btn('delete lobby'));
    const dialog = await screen.findByRole('dialog', { name: 'Delete #lobby?' });
    await user.click(within(dialog).getByRole('button', { name: en['admin.channelDelete.confirm'] }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete #lobby?' })).toBeNull());
    await waitFor(() => expect(screen.getByRole('heading', { name: en['admin.channels.title'], level: 2 })).toHaveFocus());
  });
  it('keeps focus on the moved row button when the new order is published before the command resolves', async () => {
    const { fake, user } = setup();
    fake.handler = command => {
      if (command.m === 'moveChannel') {
        fake.publish(`channels:${SERVER}`, CHANNELS.map(c => (c.id === DEV ? { ...c, position: 0 } : c.id === LOBBY ? { ...c, position: 1 } : c)));
      }
      return Promise.resolve(null);
    };
    await user.click(btn('move dev up'));
    await waitFor(() => expect(btn('move dev up')).toBeDisabled());
    await waitFor(() => expect(btn('move dev down')).toHaveFocus());
  });
  it('selects no category when the channel names a category that is not listed', async () => {
    const { user } = setup([...CHANNELS.filter(c => c.id !== TALK)]);
    await user.click(btn('edit lobby'));
    const dialog = await screen.findByRole('dialog', { name: 'Edit #lobby' });
    expect(within(dialog).getByRole('combobox', { name: en['admin.channel.category'] })).toHaveValue('top');
  });
});

describe('private channels in the channels tab', () => {
  const EVERYONE = 'e0'.repeat(16);
  const access = (over: Record<string, unknown> = {}) => ({ top: 5, owner: false, manageCommunity: false, manageChannels: true, kickMembers: false,
    banMembers: false, createInvite: false, manageRoles: true, loaded: true, everyoneId: EVERYONE, overwritesLoaded: true, ...over });
  it('tags a private channel with chperm.privateTag, and no other', () => {
    const { fake } = setup();
    fake.publish(`permissions:${SERVER}`, access());
    fake.publish(`overwrites:${SERVER}`, { [DEV]: [{ kind: 0, targetId: EVERYONE, allow: 0, deny: 1 }] });
    const rows = within(screen.getByRole('list', { name: 'Talk' })).getAllByRole('listitem');
    expect(rows[1]).toHaveTextContent(`#dev${en['chperm.privateTag']}`);
    expect(rows[0]).not.toHaveTextContent(en['chperm.privateTag']);
  });
  it('tags nothing while the overwrites are not loaded', () => {
    const { fake } = setup();
    fake.publish(`permissions:${SERVER}`, access({ overwritesLoaded: false }));
    fake.publish(`overwrites:${SERVER}`, { [DEV]: [{ kind: 0, targetId: EVERYONE, allow: 0, deny: 1 }] });
    expect(screen.queryByText(en['chperm.privateTag'])).toBeNull();
  });
  it('shows the permissions of a channel in its edit dialog with the manage-roles right, and not for a category', async () => {
    const { fake, user } = setup();
    fake.publish(`permissions:${SERVER}`, access());
    fake.publish(`roles:${SERVER}`, []);
    await user.click(btn('edit lobby'));
    expect(await within(await screen.findByRole('dialog', { name: 'Edit #lobby' })).findByRole('heading', { name: en['chperm.title'] })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(btn('edit Talk'));
    expect(within(await screen.findByRole('dialog', { name: 'Edit category Talk' })).queryByRole('heading', { name: en['chperm.title'] })).toBeNull();
  });
  it('hides the permissions without the manage-roles right', async () => {
    const { fake, user } = setup();
    fake.publish(`permissions:${SERVER}`, access({ manageRoles: false }));
    await user.click(btn('edit lobby'));
    expect(within(await screen.findByRole('dialog', { name: 'Edit #lobby' })).queryByRole('heading', { name: en['chperm.title'] })).toBeNull();
  });
  it('closes only the confirm on Escape, leaving the channel dialog open, and returns focus to the switch', async () => {
    const { fake, user } = setup();
    fake.publish(`permissions:${SERVER}`, access());
    fake.publish(`roles:${SERVER}`, []);
    fake.publish(`members:${SERVER}`, []);
    fake.publish(`overwrites:${SERVER}`, {});
    await user.click(btn('edit lobby'));
    await user.click(await screen.findByRole('switch', { name: en['chperm.private'] }));
    expect(await screen.findByRole('dialog', { name: 'Make #lobby private?' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Make #lobby private?' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Edit #lobby' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: en['chperm.private'] })).toHaveFocus();
  });
});

// I6, R39: move up, move down, edit and delete are icon actions in four trailing slots; the AFK row has edit and no delete, and the slot stays reserved.
describe('the channel row actions', () => {
  it('draws move up, move down, edit and delete as icon buttons in four trailing slots per row', () => {
    setup();
    const row = screen.getByRole('button', { name: 'edit lobby' }).closest('li') as HTMLElement;
    expect(row.querySelectorAll('.d-slot')).toHaveLength(4);
    for (const name of ['move lobby up', 'move lobby down', 'edit lobby']) expect(within(row).getByRole('button', { name }).querySelector('svg')).not.toBeNull();
    // I6: the moves have no text label of their own.
    expect(within(row).getByRole('button', { name: 'move lobby down' })).toHaveTextContent('');
    expect(within(row).getByRole('button', { name: 'delete lobby' })).toBeInTheDocument();
  });
  it('gives the AFK channel an edit and no delete, keeping the slot', () => {
    const fake = new FakeClient();
    fake.set('account', account());
    fake.set('communities', [{ id: SERVER, name: 'Midgard', owner: 'ee'.repeat(16) }]);
    fake.set(`channels:${SERVER}`, CHANNELS);
    fake.set(`afk:${SERVER}`, { channelId: GENERAL, timeoutSeconds: 300, pending: false });
    render(<div className="d-root"><CoreProvider client={fake}>
      <ChannelsSection communityId={SERVER} serverName="Midgard" announce={vi.fn()} />
    </CoreProvider></div>);
    const afk = screen.getByRole('button', { name: 'edit General voice' }).closest('li') as HTMLElement;
    expect(within(afk).queryByRole('button', { name: 'delete General voice' })).toBeNull();
    expect(afk.querySelectorAll('.d-slot')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'delete lobby' })).toBeInTheDocument();
  });
});
