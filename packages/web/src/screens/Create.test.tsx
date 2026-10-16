import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelSummary } from '@dilla/client-core';
import { CoreProvider } from '../core/context.tsx';
import { FakeClient, refusal } from '../test/fake-client.ts';
import { account, ME } from '../test/fixtures.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import {
  CreateChannelFlow, CreateServerFlow, INVITE_MAX_USES, INVITE_TTL_DAYS, INVITE_TTL_S, InviteFlow, channelName, nameProblem,
} from './Create.tsx';

const SERVER = 'a1'.repeat(16);
const BLOCKED = 'This browser did not copy the link. Press copy link to try again, or select the link and copy it yourself.';
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
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That name was refused. Try another.'));
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
      'Midgard is ready, but #general was not added (E_UNAVAILABLE). Try again, or close this and add it from the channel list.'));
    expect(onServer).toHaveBeenCalledWith(SERVER);
    expect(onDone).not.toHaveBeenCalled();
    expect(fake.callsOf('createChannel').map(c => c.kind)).toEqual(['text', 'voice']);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ communityId: SERVER, channelId: TEXT }));
    expect(fake.callsOf('createChannel').map(c => c.kind)).toEqual(['text', 'voice', 'text']);
    expect(fake.callsOf('createCommunity')).toHaveLength(1);
  });

  // Review Focus 4: the edges are the instance's, checked before any request.
  it('refuses a whitespace-only name as empty and sends nothing', async () => {
    const { fake, user } = setup();
    await user.type(nameField('Server name'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give the server a name.');
    expect(nameField('Server name')).toHaveFocus();
    expect(fake.calls).toEqual([]);
  });

  it('takes a name of exactly 255 bytes of emoji; one byte more is refused before any request', async () => {
    const edge = `${'🦊'.repeat(63)}åx`;   // 63 × 4 + 2 + 1 = 255 bytes
    expect(new TextEncoder().encode(edge)).toHaveLength(255);
    const { fake, user, onDone } = setup();
    await user.click(nameField('Server name'));
    await user.paste(`${edge}y`);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('That name is too long. A server name is up to 255 bytes.');
    expect(fake.calls).toEqual([]);
    await user.keyboard('{Backspace}{Enter}');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fake.callsOf('createCommunity')).toEqual([{ m: 'createCommunity', name: edge }]);
  });

  // Review Focus 1: two submits before React renders the busy state (a double click, a key repeat) still make one server.
  it('makes one server for two submits in the same tick, before the busy state renders', async () => {
    let release = (): void => undefined;
    const { fake, user } = setup((m) => m === 'createCommunity'
      ? new Promise(resolve => { release = () => resolve({ communityId: SERVER }); })
      : Promise.resolve({ channelId: fake.calls.at(-1)?.m === 'createChannel' && (fake.calls.at(-1) as { kind: string }).kind === 'voice' ? VOICE : TEXT }));
    await user.type(nameField('Server name'), 'Midgard');
    const form = nameField('Server name').closest('form');
    if (form === null) throw new Error('no form');
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(screen.getByRole('button', { name: 'Creating…' })).toHaveAttribute('aria-disabled', 'true');
    act(() => release());
    await waitFor(() => expect(fake.callsOf('createChannel')).toHaveLength(2));
    expect(fake.callsOf('createCommunity')).toHaveLength(1);
  });

  // Review Focus 2: the server stays; the error says what is missing; a retry adds only that, never a second #general.
  it('when only the voice channel fails, says the voice channel is missing and a retry adds only it', async () => {
    let failVoice = true;
    let releaseRetry = (): void => undefined;
    const { fake, user, onServer, onDone } = setup((m, n) => {
      if (m === 'createCommunity') return Promise.resolve({ communityId: SERVER });
      const last = fake.calls[n - 1];
      if (last?.m === 'createChannel' && last.kind === 'voice') {
        if (failVoice) { failVoice = false; return Promise.reject(refusal({ code: 'E_UNAVAILABLE', status: 503 })); }
        return new Promise(resolve => { releaseRetry = () => resolve({ channelId: VOICE }); });
      }
      return Promise.resolve({ channelId: TEXT });
    });
    await user.type(nameField('Server name'), 'Midgard{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Midgard is ready, but its voice channel general was not added (E_UNAVAILABLE). Try again, or close this and add it from the channel list.'));
    expect(onServer).toHaveBeenCalledWith(SERVER);
    expect(onDone).not.toHaveBeenCalled();
    // The field is gone, so focus moves to the retry rather than falling to the page.
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    // While the retry runs, the notice stays (the name field does not come back) and the submit is busy.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Creating…' })).toHaveAttribute('aria-disabled', 'true');
    act(() => releaseRetry());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ communityId: SERVER, channelId: TEXT }));
    expect(fake.callsOf('createChannel').map(c => c.kind)).toEqual(['text', 'voice', 'voice']);
    expect(fake.callsOf('createChannel').filter(c => c.kind === 'text' && c.name === 'general')).toHaveLength(1);
    expect(fake.callsOf('createCommunity')).toHaveLength(1);
  });

  it('when both starter channels fail, says its channels are missing and a retry adds both, in order', async () => {
    let down = true;
    const { fake, user, onDone } = setup((m, n) => {
      if (m === 'createCommunity') return Promise.resolve({ communityId: SERVER });
      if (down) return Promise.reject(refusal({ code: 'E_NETWORK', status: 0 }));
      const last = fake.calls[n - 1];
      return Promise.resolve({ channelId: last?.m === 'createChannel' && last.kind === 'voice' ? VOICE : TEXT });
    });
    await user.type(nameField('Server name'), 'Midgard{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Midgard is ready, but its channels were not added (E_NETWORK). Try again, or close this and add them from the channel list.'));
    down = false;
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ communityId: SERVER, channelId: TEXT }));
    expect(fake.callsOf('createChannel').map(c => c.kind)).toEqual(['text', 'voice', 'text', 'voice']);
    expect(fake.callsOf('createCommunity')).toHaveLength(1);
  });

  // Review I1: dillad keeps no uniqueness on channel names, so a create whose answer was lost may still have made the
  // channel. The retry reads the server's list first and counts a listed starter as made.
  it('a retry after a lost answer reads the list first and never makes a second #general', async () => {
    const listed: ChannelSummary[] = [];
    const row = (id: string, kind: 0 | 1): ChannelSummary =>
      ({ id, communityId: SERVER, kind, mode: 0, name: 'general', topic: '', parentId: null, position: listed.length, slowmode: 0, announcement: false, group: 'none' });
    const { fake, user, onDone } = setup((m, n) => {
      const c = fake.calls[n - 1];
      if (m === 'createCommunity') return Promise.resolve({ communityId: SERVER });
      if (c?.m === 'selectCommunity') { fake.set(`channels:${SERVER}`, [...listed]); return Promise.resolve(null); }
      if (c?.m === 'createChannel' && c.kind === 'text') {
        listed.push(row(TEXT, 0));   // the instance made it; the answer never arrives
        return Promise.reject(refusal({ code: 'E_NETWORK', status: 0 }));
      }
      listed.push(row(VOICE, 1));
      return Promise.resolve({ channelId: VOICE });
    });
    await user.type(nameField('Server name'), 'Midgard{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Midgard is ready, but #general was not added (E_NETWORK).'));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ communityId: SERVER, channelId: TEXT }));
    expect(fake.callsOf('selectCommunity')).toEqual([{ m: 'selectCommunity', communityId: SERVER }]);
    expect(fake.callsOf('createChannel').map(c => c.kind)).toEqual(['text', 'voice']);
  });

  it('a retry whose list read fails sends no create and says why', async () => {
    let failText = true;
    const { fake, user, onDone } = setup((m, n) => {
      const c = fake.calls[n - 1];
      if (m === 'createCommunity') return Promise.resolve({ communityId: SERVER });
      if (c?.m === 'selectCommunity') return Promise.reject(refusal({ code: 'E_UNAVAILABLE', status: 503 }));
      if (c?.m === 'createChannel' && c.kind === 'text' && failText) { failText = false; return Promise.reject(refusal({ code: 'E_NETWORK' })); }
      return Promise.resolve({ channelId: VOICE });
    });
    await user.type(nameField('Server name'), 'Midgard{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('(E_NETWORK)'));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Midgard is ready, but #general was not added (E_UNAVAILABLE).'));
    expect(fake.callsOf('createChannel')).toHaveLength(2);
    expect(onDone).not.toHaveBeenCalled();
  });

  // Review M3: the same failure twice is a new alert, so it is announced again.
  it('the same refusal twice is announced twice', async () => {
    const { user } = setup(() => Promise.reject(refusal({ code: 'E_INVALID_REQUEST', status: 400 })));
    await user.type(nameField('Server name'), 'Midgard{Enter}');
    const first = await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByRole('alert')).not.toBe(first));
    expect(screen.getByRole('alert')).toHaveTextContent('That name was refused. Try another.');
    expect(nameField('Server name')).toHaveFocus();
  });

  it('the same channel failure twice is announced twice', async () => {
    const { user } = setup((m) => (m === 'createCommunity' ? Promise.resolve({ communityId: SERVER })
      : m === 'createChannel' ? Promise.reject(refusal({ code: 'E_UNAVAILABLE', status: 503 })) : Promise.resolve(null)));
    await user.type(nameField('Server name'), 'Midgard{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('(E_UNAVAILABLE)'));
    const first = screen.getByRole('alert');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).not.toBe(first));
    expect(screen.getByRole('alert')).toHaveTextContent('Midgard is ready, but its channels were not added (E_UNAVAILABLE).');
  });

  // Review M1: busy is said in a status region, since focus stays in the field.
  it('says it is creating in a status region while busy', async () => {
    let release = (): void => undefined;
    const { user } = setup((m) => m === 'createCommunity'
      ? new Promise(resolve => { release = () => resolve({ communityId: SERVER }); }) : Promise.resolve({ channelId: TEXT }));
    expect(screen.getByRole('status')).toHaveTextContent('');
    await user.type(nameField('Server name'), 'Midgard{Enter}');
    expect(screen.getByRole('status')).toHaveTextContent('Creating…');
    act(() => release());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(''));
  });

  // Review M5: a dialog reopened while an earlier create still runs says so, and sends nothing more until it ends.
  it('reopened while an earlier create runs, it shows that create as busy until it ends', async () => {
    let release = (): void => undefined;
    const fake = client();
    fake.handler = command => command.m === 'createCommunity'
      ? new Promise(resolve => { release = () => resolve({ communityId: SERVER }); })
      : Promise.resolve({ channelId: TEXT });
    const user = userEvent.setup();
    const tree = (open: boolean) => <div className="d-root"><CoreProvider client={fake}>
      <CreateServerFlow open={open} onServer={vi.fn()} onDone={vi.fn()} onClose={vi.fn()} /></CoreProvider></div>;
    const view = render(tree(true));
    await user.type(nameField('Server name'), 'Midgard{Enter}');
    view.rerender(tree(false));
    view.rerender(tree(true));
    expect(screen.getByRole('button', { name: 'Creating…' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Creating…');
    await user.type(nameField('Server name'), 'Asgard{Enter}');
    expect(fake.callsOf('createCommunity')).toHaveLength(1);
    act(() => release());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).not.toHaveAttribute('aria-disabled'));
  });

  // WB m4: a starter that fails after the dialog closed is not lost. The next open says what is missing, once, with the
  // retry that adds only that; a starter create that succeeds after the close leaves nothing to say.
  it('a starter that fails after the dialog closed is named on the next open, once', async () => {
    let release = (): void => undefined;
    const fake = client();
    fake.handler = command => {
      if (command.m === 'createCommunity') return new Promise(resolve => { release = () => resolve({ communityId: SERVER }); });
      if (command.m === 'createChannel' && command.kind === 'voice') return Promise.reject(refusal({ code: 'E_UNAVAILABLE', status: 503 }));
      return Promise.resolve({ channelId: TEXT });
    };
    const onServer = vi.fn();
    const onDone = vi.fn();
    const user = userEvent.setup();
    const tree = (open: boolean) => <div className="d-root"><CoreProvider client={fake}>
      <CreateServerFlow open={open} onServer={onServer} onDone={onDone} onClose={vi.fn()} /></CoreProvider></div>;
    const view = render(tree(true));
    await user.type(nameField('Server name'), 'Midgard{Enter}');
    view.rerender(tree(false));
    act(() => release());
    await waitFor(() => expect(fake.callsOf('createChannel')).toHaveLength(2));
    await act(async () => { await Promise.resolve(); });
    view.rerender(tree(true));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Midgard is ready, but its voice channel general was not added (E_UNAVAILABLE).'));
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveFocus();
    expect(onDone).not.toHaveBeenCalled();
    // Told once: closed again without the retry, the next open is a fresh dialog.
    view.rerender(tree(false));
    view.rerender(tree(true));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(nameField('Server name')).toHaveValue('');
    expect(fake.callsOf('createChannel').map(c => c.kind)).toEqual(['text', 'voice']);
  });

  it('the retry from a notice shown on a later open adds only what is missing and hands the server over', async () => {
    let release = (): void => undefined;
    let down = true;
    const fake = client();
    fake.handler = command => {
      if (command.m === 'createCommunity') return new Promise(resolve => { release = () => resolve({ communityId: SERVER }); });
      if (command.m === 'selectCommunity') return Promise.resolve(null);
      if (command.m === 'createChannel' && command.kind === 'voice' && down) return Promise.reject(refusal({ code: 'E_UNAVAILABLE', status: 503 }));
      return Promise.resolve({ channelId: command.m === 'createChannel' && command.kind === 'voice' ? VOICE : TEXT });
    };
    const onDone = vi.fn();
    const user = userEvent.setup();
    const tree = (open: boolean) => <div className="d-root"><CoreProvider client={fake}>
      <CreateServerFlow open={open} onServer={vi.fn()} onDone={onDone} onClose={vi.fn()} /></CoreProvider></div>;
    const view = render(tree(true));
    await user.type(nameField('Server name'), 'Midgard{Enter}');
    view.rerender(tree(false));
    act(() => release());
    await waitFor(() => expect(fake.callsOf('createChannel')).toHaveLength(2));
    await act(async () => { await Promise.resolve(); });
    view.rerender(tree(true));
    await screen.findByRole('alert');
    down = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ communityId: SERVER, channelId: TEXT }));
    expect(fake.callsOf('createChannel').map(c => c.kind)).toEqual(['text', 'voice', 'voice']);
    expect(fake.callsOf('createCommunity')).toHaveLength(1);
  });

  it('a create that finishes well after the dialog closed leaves no notice for the next open', async () => {
    let release = (): void => undefined;
    const fake = client();
    fake.handler = command => command.m === 'createCommunity'
      ? new Promise(resolve => { release = () => resolve({ communityId: SERVER }); })
      : Promise.resolve({ channelId: command.m === 'createChannel' && command.kind === 'voice' ? VOICE : TEXT });
    const onDone = vi.fn();
    const user = userEvent.setup();
    const tree = (open: boolean) => <div className="d-root"><CoreProvider client={fake}>
      <CreateServerFlow open={open} onServer={vi.fn()} onDone={onDone} onClose={vi.fn()} /></CoreProvider></div>;
    const view = render(tree(true));
    await user.type(nameField('Server name'), 'Midgard{Enter}');
    view.rerender(tree(false));
    act(() => release());
    await waitFor(() => expect(fake.callsOf('createChannel')).toHaveLength(2));
    await act(async () => { await Promise.resolve(); });
    view.rerender(tree(true));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(nameField('Server name')).toHaveValue('');
    expect(onDone).not.toHaveBeenCalled();
  });

  // WB m5: a create whose answer was lost (E_NETWORK) may still have made the server. A server this account owns, with
  // exactly that name, listed now but not before the press, is that server: it is adopted and gets its starters, never a
  // second server.
  describe('a lost answer to the create', () => {
    function lost() {
      const fake = client();
      fake.set('communities', [{ id: 'f0'.repeat(16), name: 'Midgard', owner: 'ee'.repeat(16) }]);
      const onServer = vi.fn();
      const onDone = vi.fn();
      const r = mount(fake, <CreateServerFlow open onServer={onServer} onDone={onDone} onClose={vi.fn()} />);
      return { fake, onServer, onDone, ...r };
    }
    const ours = { id: SERVER, name: 'Midgard', owner: ME.id };
    const starter = (c: { m: string }) => Promise.resolve({ channelId: 'kind' in c && c.kind === 'voice' ? VOICE : TEXT });

    /** The instance as the worker sees it with the socket up: a create may make the server and lose its answer; only
     *  refreshCommunities (or a ready, which never comes here) publishes the instance's list. */
    function instance(fake: FakeClient, opts: { makes: boolean; listFails?: () => boolean; createFails?: () => boolean }) {
      const made: typeof ours[] = [];
      const base = fake.get('communities') ?? [];
      fake.handler = c => {
        if (c.m === 'createCommunity') {
          const fails = opts.createFails?.() ?? true;
          if (opts.makes || !fails) made.push(ours);
          if (fails) return Promise.reject(refusal({ code: 'E_NETWORK' }));
          fake.set('communities', [...base, ...made]);
          return Promise.resolve({ communityId: SERVER });
        }
        if (c.m === 'refreshCommunities') {
          if (opts.listFails?.() === true) return Promise.reject(refusal({ code: 'E_NETWORK' }));
          fake.set('communities', [...base, ...made]);
          return Promise.resolve(null);
        }
        return starter(c);
      };
      return made;
    }

    it('reads the server list again after a lost answer and adopts the server it made, with the socket up', async () => {
      const { fake, user, onServer, onDone } = lost();
      instance(fake, { makes: true });
      await user.type(nameField('Server name'), 'Midgard{Enter}');
      await waitFor(() => expect(onDone).toHaveBeenCalledWith({ communityId: SERVER, channelId: TEXT }));
      expect(onServer).toHaveBeenCalledWith(SERVER);
      expect(fake.calls.map(c => c.m)).toEqual(['createCommunity', 'refreshCommunities', 'createChannel', 'createChannel']);
    });

    it('a second press reads the list again before it creates: never a second server', async () => {
      const { fake, user, onDone } = lost();
      let down = true;
      instance(fake, { makes: true, listFails: () => down });
      await user.type(nameField('Server name'), 'Midgard{Enter}');
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not start the server (E_NETWORK). Try again.'));
      down = false;
      await user.keyboard('{Enter}');
      await waitFor(() => expect(onDone).toHaveBeenCalledWith({ communityId: SERVER, channelId: TEXT }));
      expect(fake.callsOf('createCommunity')).toHaveLength(1);
      expect(fake.callsOf('refreshCommunities')).toHaveLength(2);
    });

    it('a second press whose list read fails sends no create and says why', async () => {
      const { fake, user, onDone } = lost();
      instance(fake, { makes: true, listFails: () => true });
      await user.type(nameField('Server name'), 'Midgard{Enter}');
      const first = await screen.findByRole('alert');
      await user.keyboard('{Enter}');
      await waitFor(() => expect(screen.getByRole('alert')).not.toBe(first));
      expect(screen.getByRole('alert')).toHaveTextContent('Could not start the server (E_NETWORK). Try again.');
      expect(fake.callsOf('createCommunity')).toHaveLength(1);
      expect(onDone).not.toHaveBeenCalled();
    });

    it('when the lost create made nothing, the second press creates the server once', async () => {
      const { fake, user, onDone } = lost();
      let fails = true;
      instance(fake, { makes: false, createFails: () => fails });
      await user.type(nameField('Server name'), 'Midgard{Enter}');
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('(E_NETWORK)'));
      fails = false;
      await user.keyboard('{Enter}');
      await waitFor(() => expect(onDone).toHaveBeenCalledWith({ communityId: SERVER, channelId: TEXT }));
      expect(fake.calls.map(c => c.m)).toEqual(['createCommunity', 'refreshCommunities', 'refreshCommunities', 'createCommunity',
        'createChannel', 'createChannel']);
    });

    it('never adopts a server that was listed before the press, or one this account does not own', async () => {
      const { fake, user } = lost();
      fake.set('communities', [...(fake.get('communities') ?? []), ours]);
      fake.handler = c => {
        if (c.m === 'createCommunity') {
          fake.set('communities', [...(fake.get('communities') ?? []), { id: 'f1'.repeat(16), name: 'Midgard', owner: 'ee'.repeat(16) }]);
          return Promise.reject(refusal({ code: 'E_NETWORK' }));
        }
        return starter(c);
      };
      await user.type(nameField('Server name'), 'Midgard{Enter}');
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('(E_NETWORK)'));
      await user.keyboard('{Enter}');
      await waitFor(() => expect(fake.callsOf('createCommunity')).toHaveLength(2));
      expect(fake.callsOf('createChannel')).toEqual([]);
    });

    // Final re-review m6: adoption is only for an unambiguous match. Two new servers this account owns with that exact
    // name (another tab pressed too, say) cannot be told apart, so neither is adopted, the dialog says so, and no further
    // create is sent, on this press or the next.
    it('adopts nothing when two new servers of this account carry the name, and sends no second create', async () => {
      const { fake, user, onServer, onDone } = lost();
      const twin = { id: 'f2'.repeat(16), name: 'Midgard', owner: ME.id };
      const base = fake.get('communities') ?? [];
      fake.handler = c => {
        if (c.m === 'createCommunity') return Promise.reject(refusal({ code: 'E_NETWORK' }));
        if (c.m === 'refreshCommunities') {
          fake.set('communities', [...base, ours, twin]);
          return Promise.resolve(null);
        }
        return starter(c);
      };
      await user.type(nameField('Server name'), 'Midgard{Enter}');
      const first = await screen.findByRole('alert');
      expect(first).toHaveTextContent('More than one new server of yours is named Midgard. Open the one you meant from the server list.');
      await user.keyboard('{Enter}');
      await waitFor(() => expect(fake.callsOf('refreshCommunities')).toHaveLength(2));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('More than one new server of yours is named Midgard.'));
      expect(fake.callsOf('createCommunity')).toHaveLength(1);
      expect(fake.callsOf('createChannel')).toEqual([]);
      expect(onServer).not.toHaveBeenCalled();
      expect(onDone).not.toHaveBeenCalled();
    });
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

  it('refuses a whitespace-only name as empty and sends nothing', async () => {
    const { fake, user } = setup();
    await user.type(nameField('Channel name'), '   {Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Give the channel a name.');
    expect(fake.calls).toEqual([]);
  });

  it('takes a voice name of exactly 100 bytes of emoji; one byte more is refused before any request', async () => {
    const edge = '🦊'.repeat(25);   // 100 bytes
    const { fake, user, onDone } = setup(() => Promise.resolve({ channelId: VOICE }));
    await user.click(screen.getByRole('radio', { name: 'voice' }));
    await user.click(nameField('Channel name'));
    await user.paste(`${edge}x`);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('That name is too long. A channel name is up to 100 bytes.');
    expect(fake.calls).toEqual([]);
    await user.keyboard('{Backspace}{Enter}');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(VOICE, 'voice'));
    expect(fake.calls).toEqual([{ m: 'createChannel', communityId: SERVER, kind: 'voice', name: edge }]);
  });

  // Review M7: E_BAD_INPUT from the worker is not about the name (an unknown server); only E_INVALID_REQUEST is.
  it('says E_BAD_INPUT by its code, not as a refused name', async () => {
    const { user } = setup(() => Promise.reject(refusal({ code: 'E_BAD_INPUT' })));
    await user.type(nameField('Channel name'), 'loot{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not add the channel (E_BAD_INPUT). Try again.'));
  });

  it('says E_INVALID_REQUEST as a refused name', async () => {
    const { user } = setup(() => Promise.reject(refusal({ code: 'E_INVALID_REQUEST', status: 400 })));
    await user.type(nameField('Channel name'), 'loot{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That name was refused. Try another.'));
  });

  // Review M8: two submits before the busy state renders make one channel.
  it('makes one channel for two submits in the same tick', async () => {
    let release = (): void => undefined;
    const { fake, user, onDone } = setup(() => new Promise(resolve => { release = () => resolve({ channelId: TEXT }); }));
    await user.type(nameField('Channel name'), 'loot');
    const form = nameField('Channel name').closest('form');
    if (form === null) throw new Error('no form');
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(screen.getByRole('button', { name: 'Creating…' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Creating…');
    act(() => release());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(fake.callsOf('createChannel')).toHaveLength(1);
  });

  // Review I2: a create still running at close neither speaks to the next open nor hands over its channel.
  it('a create still running when the dialog closes leaves no stale error, hands nothing over, and is busy on reopen', async () => {
    const pending: { settle(ok: boolean): void }[] = [];
    const fake = client();
    fake.handler = () => new Promise((resolve, reject) => {
      pending.push({ settle: ok => (ok ? resolve({ channelId: TEXT }) : reject(refusal({ code: 'E_UNAVAILABLE', status: 503 }))) });
    });
    const onDone = vi.fn();
    const user = userEvent.setup();
    const tree = (open: boolean) => <div className="d-root"><CoreProvider client={fake}>
      <CreateChannelFlow open={open} community={{ id: SERVER, name: 'Midgard Crew' }} onDone={onDone} onClose={vi.fn()} /></CoreProvider></div>;
    const view = render(tree(true));
    await user.type(nameField('Channel name'), 'loot{Enter}');
    view.rerender(tree(false));
    view.rerender(tree(true));
    // C: the earlier create is still running, and the dialog says so.
    expect(screen.getByRole('button', { name: 'Creating…' })).toHaveAttribute('aria-disabled', 'true');
    // A: its late failure is not shown here.
    await act(async () => { pending[0].settle(false); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
    // B: a late success after a close hands nothing over.
    await user.type(nameField('Channel name'), 'gold{Enter}');
    view.rerender(tree(false));
    await act(async () => { pending[1].settle(true); await Promise.resolve(); });
    view.rerender(tree(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
    expect(nameField('Channel name')).toHaveValue('');
  });

  // Product walk M2: dillad keeps no uniqueness on channel names, so the dialog refuses a name the server's list already
  // holds for that kind, as it will be stored (a text name as its slug), before any request.
  it('refuses a name the server already has for that kind, and sends nothing', async () => {
    const fake = client();
    fake.handler = () => Promise.resolve({ channelId: VOICE });
    fake.set(`channels:${SERVER}`, [
      { id: TEXT, communityId: SERVER, kind: 0, mode: 0, name: 'ship-talk', topic: '', parentId: null, position: 0, slowmode: 0, announcement: false, group: 'active' },
      { id: VOICE, communityId: SERVER, kind: 1, mode: 0, name: 'general', topic: '', parentId: null, position: 1, slowmode: 0, announcement: false, group: 'none' },
    ]);
    const onDone = vi.fn();
    const { user } = mount(fake, <CreateChannelFlow open community={{ id: SERVER, name: 'Midgard Crew' }} onDone={onDone} onClose={vi.fn()} />);
    await user.type(nameField('Channel name'), ' Ship  Talk {Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('There is already a text channel called #ship-talk. Try another.');
    expect(nameField('Channel name')).toHaveFocus();
    await user.click(screen.getByRole('radio', { name: 'voice' }));
    await user.clear(nameField('Channel name'));
    await user.type(nameField('Channel name'), 'general{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('There is already a voice channel called general. Try another.');
    expect(fake.calls).toEqual([]);
    // The same name of the other kind is a different channel.
    await user.click(screen.getByRole('radio', { name: 'text' }));
    await user.click(nameField('Channel name'));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fake.calls).toEqual([{ m: 'createChannel', communityId: SERVER, kind: 'text', name: 'general' }]);
  });

  it('says why a create was refused, by code', async () => {
    const { user, onDone } = setup(() => Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 })));
    await user.type(nameField('Channel name'), 'loot{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('You cannot add channels to this server.'));
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('CreateChannelFlow, private create', () => {
  const EVERYONE = 'e0'.repeat(16);
  const LOW = 'b2'.repeat(16);
  const LOWER = 'b4'.repeat(16);
  const HIGH = 'b3'.repeat(16);
  const role = (id: string, name: string, position: number) => ({ id, name, color: 0, position, hoist: false, mentionable: false, allow: 0, deny: 0, members: 0 });
  function setup(opts: { manageRoles?: boolean; owner?: boolean; roles?: ReturnType<typeof role>[] } = {}) {
    const fake = client();
    fake.set(`permissions:${SERVER}`, { top: 5, owner: opts.owner ?? false, manageCommunity: false, manageChannels: true, kickMembers: false, banMembers: false,
      createInvite: false, manageRoles: opts.manageRoles ?? true, loaded: true, everyoneId: EVERYONE, overwritesLoaded: true });
    fake.set(`roles:${SERVER}`, opts.roles ?? [role(EVERYONE, '@everyone', 0), role(LOWER, 'Newcomers', 1), role(LOW, 'Players', 2), role(HIGH, 'Council', 9)]);
    fake.handler = () => Promise.resolve({ channelId: TEXT });
    const onDone = vi.fn();
    const r = mount(fake, <CreateChannelFlow open community={{ id: SERVER, name: 'Midgard Crew' }} onDone={onDone} onClose={vi.fn()} />);
    return { fake, onDone, ...r };
  }
  const privateSwitch = () => screen.getByRole('switch', { name: 'private channel' });

  it('offers the private switch only with the manage-roles right', () => {
    setup({ manageRoles: false });
    expect(screen.queryByRole('switch', { name: 'private channel' })).toBeNull();
  });
  it('lists only the roles below mine once private is on, and sends the ticked ones', async () => {
    const { fake, user } = setup();
    expect(screen.queryByRole('group', { name: 'Roles that can see it' })).toBeNull();
    await user.click(privateSwitch());
    const group = screen.getByRole('group', { name: 'Roles that can see it' });
    expect(screen.getAllByRole('checkbox').map(c => (c as HTMLInputElement).labels?.[0]?.textContent)).toEqual(['Players', 'Newcomers']);
    await user.click(screen.getByRole('checkbox', { name: 'Players' }));
    expect(group).toBeInTheDocument();
    await user.type(nameField('Channel name'), 'staff');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(fake.calls).toEqual([{ m: 'createChannel', communityId: SERVER, kind: 'text', name: 'staff', private: { roleIds: [LOW] } }]));
  });
  it('creates a private channel for nobody but me when no role is ticked', async () => {
    const { fake, user } = setup();
    await user.click(privateSwitch());
    await user.type(nameField('Channel name'), 'staff');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(fake.calls[0]).toMatchObject({ private: { roleIds: [] } }));
  });
  it('says there are no lower roles to add', async () => {
    const { user } = setup({ roles: [role(EVERYONE, '@everyone', 0), role(HIGH, 'Council', 9)] });
    await user.click(privateSwitch());
    expect(screen.getByText('There are no roles below yours to add. You can add people later in the channel’s permissions.')).toBeInTheDocument();
  });
  it('does not send private when the switch is off, even after ticking and switching back', async () => {
    const { fake, user } = setup();
    await user.click(privateSwitch());
    await user.click(screen.getByRole('checkbox', { name: 'Players' }));
    await user.click(privateSwitch());
    await user.type(nameField('Channel name'), 'open');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(fake.calls).toEqual([{ m: 'createChannel', communityId: SERVER, kind: 'text', name: 'open' }]));
  });
  it('offers every role but @everyone to the owner, whatever the positions', async () => {
    const { user } = setup({ owner: true });
    await user.click(privateSwitch());
    expect(screen.getAllByRole('checkbox').map(c => (c as HTMLInputElement).labels?.[0]?.textContent)).toEqual(['Council', 'Players', 'Newcomers']);
  });
  it('caps the ticks at 98 roles, disabling the rest with the too-many hint', async () => {
    const roles = [role(EVERYONE, '@everyone', 0), ...Array.from({ length: 100 }, (_, i) => role(`${String(i + 16).padStart(2, '0')}`.repeat(16), `R${String(i).padStart(3, '0')}`, 1))];
    const { fake, user } = setup({ owner: true, roles });
    await user.click(privateSwitch());
    const boxes = screen.getAllByRole<HTMLInputElement>('checkbox');
    expect(boxes).toHaveLength(100);
    for (const box of boxes.slice(0, 98)) await user.click(box);
    expect(boxes.filter(b => b.checked)).toHaveLength(98);
    expect(boxes[98]).toBeDisabled();
    expect(boxes[98]).toHaveAccessibleDescription('A private channel can be opened to at most 98 roles. Untick some and try again.');
    expect(boxes[0]).toBeEnabled();
    await user.type(nameField('Channel name'), 'staff');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect((fake.calls[0] as { private: { roleIds: string[] } }).private.roleIds).toHaveLength(98));
  }, 30000);
  // Review 8: the worker's E_BAD_INPUT also means "roles not loaded" or "unknown server", and the code cannot tell those
  // from the 98-role cap (which the ticks already prevent), so it is worded by its code, never as the cap.
  it('words the worker’s E_BAD_INPUT of a private create by its code, not as the too-many copy', async () => {
    const { fake, user } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_BAD_INPUT' }));
    await user.click(privateSwitch());
    await user.type(nameField('Channel name'), 'staff');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Could not add the channel (E_BAD_INPUT). Try again.')).toBeInTheDocument();
    expect(screen.queryByText('A private channel can be opened to at most 98 roles. Untick some and try again.')).toBeNull();
  });
  it('words any other refusal of a private create with its code', async () => {
    const { fake, user } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_NETWORK' }));
    await user.click(privateSwitch());
    await user.type(nameField('Channel name'), 'staff');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Could not add the channel (E_NETWORK). Try again.')).toBeInTheDocument();
  });
  it('has no serious axe violations with the roles listed', async () => {
    const { user, view } = setup();
    await user.click(privateSwitch());
    await expectNoAxeViolations(view.container);
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
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(BLOCKED));
    write.mockImplementationOnce(() => Promise.resolve());
    await user.click(screen.getByRole('button', { name: 'copy link' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Invite link copied.'));
    expect(write).toHaveBeenCalledTimes(2);
  });

  // Review Focus 3: a blocked clipboard never reads as copied; the link stays in a selectable field with how to copy it.
  it.each([
    ['denies the write', () => ({ writeText: () => Promise.reject(new DOMException('blocked', 'NotAllowedError')) })],
    ['does not exist (an insecure context)', () => undefined],
    ['throws before it starts', () => ({ writeText: () => { throw new TypeError('no'); } })],
  ])('when the clipboard %s, shows the link to copy by hand and never says copied', async (_how, clipboard) => {
    const fake = client();
    fake.handler = () => Promise.resolve({ url: URL, code: '7KQ2', expires: 1_900_000_000 });
    mount(fake, <InviteFlow open community={{ id: SERVER, name: 'Midgard Crew' }} onClose={vi.fn()} />);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: clipboard });
    const said: string[] = [];
    const region = screen.getByRole('status');
    const watch = new MutationObserver(() => { said.push(region.textContent ?? ''); });
    watch.observe(region, { childList: true, characterData: true, subtree: true });
    await waitFor(() => expect(region).toHaveTextContent(BLOCKED));
    watch.disconnect();
    expect(said.some(s => s.includes('Invite link copied.'))).toBe(false);
    const field = nameField('Invite link');
    expect(field).toHaveValue(URL);
    expect(field).toHaveAttribute('readonly');
  });

  it('the same refusal twice is announced twice', async () => {
    const { user } = setup(() => Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 })));
    const first = await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('alert')).not.toBe(first));
    expect(screen.getByRole('alert')).toHaveTextContent('You cannot invite people to this server.');
  });

  // WB m3: an open of the dialog, or a switch between servers, does not mint another invite. The last one per server is
  // reused for this page session while more than a day of it is left; its days count what is left.
  describe('reuse', () => {
    const B = 'b2'.repeat(16);
    const DAY = 86_400_000;
    function reuse(answer?: () => Promise<unknown>) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_900_000_000_000);
      const write = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
      const fake = client();
      let n = 0;
      fake.handler = answer ?? (c => {
        n += 1;
        return Promise.resolve(c.m === 'createInvite' ? { url: `https://chat.example.org/i/K${String(n)}`, code: `K${String(n)}`, expires: 1_900_604_800 } : null);
      });
      const user = userEvent.setup({ advanceTimers: () => undefined });
      const tree = (open: boolean, community = { id: SERVER, name: 'Midgard Crew' }) => <div className="d-root"><CoreProvider client={fake}>
        <InviteFlow open={open} community={community} onClose={vi.fn()} /></CoreProvider></div>;
      const view = render(tree(true));
      Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => ({ writeText: write }) });
      return { fake, write, user, view, tree };
    }
    afterEach(() => { vi.useRealTimers(); });

    it('reuses the last link per server on a reopen and on a switch back, and copies it again', async () => {
      const { fake, write, view, tree } = reuse();
      await waitFor(() => expect(nameField('Invite link')).toHaveValue('https://chat.example.org/i/K1'));
      view.rerender(tree(false));
      view.rerender(tree(true));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Invite link copied.'));
      expect(nameField('Invite link')).toHaveValue('https://chat.example.org/i/K1');
      view.rerender(tree(true, { id: B, name: 'Asgard' }));
      await waitFor(() => expect(nameField('Invite link')).toHaveValue('https://chat.example.org/i/K2'));
      view.rerender(tree(true));
      await waitFor(() => expect(nameField('Invite link')).toHaveValue('https://chat.example.org/i/K1'));
      expect(fake.callsOf('createInvite').map(c => c.communityId)).toEqual([SERVER, B]);
      expect(write).toHaveBeenLastCalledWith('https://chat.example.org/i/K1');
    });

    it('counts the days that are left, and makes a new link once a day or less is left', async () => {
      const { fake, view, tree } = reuse();
      await waitFor(() => expect(nameField('Invite link')).toHaveValue('https://chat.example.org/i/K1'));
      view.rerender(tree(false));
      vi.setSystemTime(1_900_000_000_000 + 3 * DAY + 1);
      view.rerender(tree(true));
      await waitFor(() => expect(nameField('Invite link')).toHaveValue('https://chat.example.org/i/K1'));
      expect(nameField('Invite link')).toHaveAccessibleDescription('It can be used 10 times and expires in 4 days. Anyone who has it can join Midgard Crew.');
      view.rerender(tree(false));
      vi.setSystemTime(1_900_000_000_000 + 6 * DAY);
      view.rerender(tree(true));
      await waitFor(() => expect(nameField('Invite link')).toHaveValue('https://chat.example.org/i/K2'));
      expect(nameField('Invite link')).toHaveAccessibleDescription('It can be used 10 times and expires in 7 days. Anyone who has it can join Midgard Crew.');
      expect(fake.callsOf('createInvite')).toHaveLength(2);
    });

    it('copies by itself only when the answer came within a second; a slow one shows the link and copy link, with no blocked message', async () => {
      const { write, user } = reuse(() => {
        vi.setSystemTime(Date.now() + 1_500);
        return Promise.resolve({ url: URL, code: '7KQ2', expires: 1_900_604_800 });
      });
      await waitFor(() => expect(nameField('Invite link')).toHaveValue(URL));
      await act(async () => { await Promise.resolve(); });
      expect(write).not.toHaveBeenCalled();
      expect(screen.getByRole('status')).toHaveTextContent('');
      await user.click(screen.getByRole('button', { name: 'copy link' }));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Invite link copied.'));
      expect(write).toHaveBeenCalledWith(URL);
    });
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
