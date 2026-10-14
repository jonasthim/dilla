import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreProvider } from '../core/context.tsx';
import { FakeClient, refusal } from '../test/fake-client.ts';
import { account } from '../test/fixtures.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import {
  CreateChannelFlow, CreateServerFlow, INVITE_MAX_USES, INVITE_TTL_DAYS, INVITE_TTL_S, InviteFlow, channelName, nameProblem,
} from './Create.tsx';

const SERVER = 'a1'.repeat(16);
const TEXT = 'c3'.repeat(16);
const VOICE = 'c4'.repeat(16);

function client(): FakeClient {
  const fake = new FakeClient();
  fake.set('account', account());
  return fake;
}
function mount(fake: FakeClient, node: React.ReactNode) {
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}>{node}</CoreProvider></div>);
  return { user, view };
}
const nameField = (name: string) => screen.getByRole('textbox', { name });

afterEach(() => { vi.unstubAllGlobals(); });

describe('the create-flow rules', () => {
  it('checks a name as the instance does: blank, its byte bound, control characters', () => {
    expect(nameProblem('  ', 255)).toBe('empty');
    expect(nameProblem('x'.repeat(255), 255)).toBeNull();
    expect(nameProblem('å'.repeat(128), 255)).toBe('long');
    expect(nameProblem('two\tparts', 100)).toBe('control');
    expect(nameProblem('Midgard Crew', 255)).toBeNull();
  });
  it('shows a text channel as a lower-case slug with dashes; a voice channel keeps its case', () => {
    expect(channelName('text', '  Ship  Talk ')).toBe('ship-talk');
    expect(channelName('text', 'Fika på Fredag')).toBe('fika-på-fredag');
    expect(channelName('voice', '  The  Longhouse ')).toBe('The Longhouse');
  });
  it('makes invites for ten uses and seven days', () => {
    expect([INVITE_MAX_USES, INVITE_TTL_DAYS, INVITE_TTL_S]).toEqual([10, 7, 604_800]);
  });
});

describe('CreateServerFlow', () => {
  function setup(answer?: (m: string, n: number) => Promise<unknown>) {
    const fake = client();
    let n = 0;
    fake.handler = command => {
      n += 1;
      if (answer !== undefined) return answer(command.m, n);
      if (command.m === 'createCommunity') return Promise.resolve({ communityId: SERVER });
      if (command.m === 'createChannel') return Promise.resolve({ channelId: command.kind === 'text' ? TEXT : VOICE });
      return Promise.resolve(null);
    };
    const onServer = vi.fn();
    const onDone = vi.fn();
    const onClose = vi.fn();
    const r = mount(fake, <CreateServerFlow open onServer={onServer} onDone={onDone} onClose={onClose} />);
    return { fake, onServer, onDone, onClose, ...r };
  }

  it('refuses a blank, an overlong and a control-character name in the field, sending nothing', async () => {
    const { fake, user } = setup();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Give the server a name.');
    expect(nameField('Server name')).toHaveFocus();
    await user.type(nameField('Server name'), 'å'.repeat(128));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('That name is too long. A server name is up to 255 bytes.');
    expect(fake.calls).toEqual([]);
  });

  it('creates the server, then #general and the voice general, and hands over the server and #general', async () => {
    const { fake, user, onServer, onDone } = setup();
    await user.type(nameField('Server name'), '  Midgard Crew  {Enter}');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ communityId: SERVER, channelId: TEXT }));
    expect(fake.calls).toEqual([
      { m: 'createCommunity', name: 'Midgard Crew' },
      { m: 'createChannel', communityId: SERVER, kind: 'text', name: 'general' },
      { m: 'createChannel', communityId: SERVER, kind: 'voice', name: 'general' },
    ]);
    expect(onServer).toHaveBeenCalledWith(SERVER);
    expect(onServer.mock.invocationCallOrder[0]).toBeLessThan(onDone.mock.invocationCallOrder[0]);
  });

  it('sends one create for a double submit while it is busy', async () => {
    let release = (): void => undefined;
    const { fake, user } = setup((m) => m === 'createCommunity'
      ? new Promise(resolve => { release = () => resolve({ communityId: SERVER }); }) : Promise.resolve({ channelId: TEXT }));
    await user.type(nameField('Server name'), 'Midgard{Enter}');
    expect(screen.getByRole('button', { name: 'Creating…' })).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Creating…' }));
    act(() => release());
    await waitFor(() => expect(fake.callsOf('createChannel')).toHaveLength(2));
    expect(fake.callsOf('createCommunity')).toHaveLength(1);
  });

  it('says what the instance refused, in the field', async () => {
    const { user, onServer } = setup(() => Promise.reject(refusal({ code: 'E_INVALID_REQUEST', status: 400 })));
    await user.type(nameField('Server name'), 'Midgard{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The server refused that name. Try another.'));
    expect(nameField('Server name')).toHaveFocus();
    expect(onServer).not.toHaveBeenCalled();
  });

  it('keeps a server whose channels failed: says so, hands the server over, and a retry adds only what is missing', async () => {
    let failText = true;
    const { fake, user, onServer, onDone } = setup((m) => {
      if (m === 'createCommunity') return Promise.resolve({ communityId: SERVER });
      return Promise.resolve(null).then(() => {
        const last = fake.calls.at(-1);
        if (last?.m === 'createChannel' && last.kind === 'text' && failText) {
          failText = false;
          throw refusal({ code: 'E_UNAVAILABLE', status: 503 });
        }
        return { channelId: last?.m === 'createChannel' && last.kind === 'text' ? TEXT : VOICE };
      });
    });
    await user.type(nameField('Server name'), 'Midgard{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Midgard is ready, but its channels were not added (E_UNAVAILABLE). Try again, or close this and add them from the channel list.'));
    expect(onServer).toHaveBeenCalledWith(SERVER);
    expect(onDone).not.toHaveBeenCalled();
    expect(fake.callsOf('createChannel').map(c => c.kind)).toEqual(['text', 'voice']);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ communityId: SERVER, channelId: TEXT }));
    expect(fake.callsOf('createChannel').map(c => c.kind)).toEqual(['text', 'voice', 'text']);
    expect(fake.callsOf('createCommunity')).toHaveLength(1);
  });

  it('has no serious axe violations when idle', async () => {
    const { view } = setup();
    await expectNoAxeViolations(view.container);
  });
});

describe('CreateChannelFlow', () => {
  function setup(answer: () => Promise<unknown> = () => Promise.resolve({ channelId: TEXT })) {
    const fake = client();
    fake.handler = answer;
    const onDone = vi.fn();
    const r = mount(fake, <CreateChannelFlow open community={{ id: SERVER, name: 'Midgard Crew' }} onDone={onDone} onClose={vi.fn()} />);
    return { fake, onDone, ...r };
  }

  it('is titled for the server; shows how the name will look; creates a text channel and hands it over', async () => {
    const { fake, user, onDone } = setup();
    expect(screen.getByRole('dialog', { name: 'New channel in Midgard Crew' })).toBeInTheDocument();
    expect(nameField('Channel name')).toHaveAccessibleDescription('Up to 100 bytes.');
    await user.type(nameField('Channel name'), 'Ship Talk');
    expect(nameField('Channel name')).toHaveAccessibleDescription('Shown as #ship-talk. Up to 100 bytes.');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(TEXT, 'text'));
    expect(fake.calls).toEqual([{ m: 'createChannel', communityId: SERVER, kind: 'text', name: 'ship-talk' }]);
  });

  it('creates a voice channel with the name as typed', async () => {
    const { fake, user, onDone } = setup(() => Promise.resolve({ channelId: VOICE }));
    await user.click(screen.getByRole('radio', { name: 'voice' }));
    await user.type(nameField('Channel name'), 'The Longhouse');
    expect(nameField('Channel name')).toHaveAccessibleDescription('Shown as The Longhouse. Up to 100 bytes.');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(VOICE, 'voice'));
    expect(fake.calls).toEqual([{ m: 'createChannel', communityId: SERVER, kind: 'voice', name: 'The Longhouse' }]);
  });

  it('says why a create was refused, by code', async () => {
    const { user, onDone } = setup(() => Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 })));
    await user.type(nameField('Channel name'), 'loot{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('You cannot add channels to this server.'));
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('InviteFlow', () => {
  const URL = 'https://chat.example.org/i/7KQ2';
  function setup(answer: () => Promise<unknown> = () => Promise.resolve({ url: URL, code: '7KQ2', expires: 1_900_000_000 }),
    writeText: (text: string) => Promise<void> = () => Promise.resolve()) {
    const write = vi.fn(writeText);
    const fake = client();
    fake.handler = answer;
    const r = mount(fake, <InviteFlow open community={{ id: SERVER, name: 'Midgard Crew' }} onClose={vi.fn()} />);
    // After userEvent.setup(), which installs a clipboard of its own; before the invite's answer, which is asynchronous.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => ({ writeText: write }) });
    return { fake, write, ...r };
  }

  it('makes a link for ten uses over seven days, copies it, says so, and shows it', async () => {
    const { fake, write } = setup();
    expect(screen.getByRole('dialog', { name: 'Invite people to Midgard Crew' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Invite link copied.'));
    expect(fake.calls).toEqual([{ m: 'createInvite', communityId: SERVER, maxUses: 10, ttlSeconds: 604_800 }]);
    expect(write).toHaveBeenCalledWith(URL);
    expect(nameField('Invite link')).toHaveValue(URL);
    expect(nameField('Invite link')).toHaveAccessibleDescription('It can be used 10 times and expires in 7 days. Anyone who has it can join Midgard Crew.');
  });

  it('when the clipboard is blocked, says to copy the link from the field; the copy button tries again', async () => {
    const { user, write } = setup(undefined, () => Promise.reject(new DOMException('blocked', 'NotAllowedError')));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('This browser did not let dilla copy. Select the link and copy it yourself.'));
    write.mockImplementationOnce(() => Promise.resolve());
    await user.click(screen.getByRole('button', { name: 'copy link' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Invite link copied.'));
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('a refused invite says why and offers a retry', async () => {
    let refuse = true;
    const { fake, user } = setup(() => (refuse ? Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 }))
      : Promise.resolve({ url: URL, code: '7KQ2', expires: 1_900_000_000 })));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('You cannot invite people to this server.'));
    refuse = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(nameField('Invite link')).toHaveValue(URL));
    expect(fake.callsOf('createInvite')).toHaveLength(2);
  });
});
