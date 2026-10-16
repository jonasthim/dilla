import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelSummary } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient, refusal } from '../../test/fake-client.ts';
import { account } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { en } from '../../strings/index.ts';
import { ChannelEditFlow } from './ChannelEditFlow.tsx';

const SERVER = 'a1'.repeat(16);
const LOBBY = 'c3'.repeat(16);
const VOICE = 'c5'.repeat(16);

const channel = (over: Partial<ChannelSummary> = {}): ChannelSummary =>
  ({ id: LOBBY, communityId: SERVER, kind: 0, mode: 0, name: 'lobby', topic: '', parentId: null, position: 0, slowmode: 0, announcement: false, group: 'active', ...over });

function setup(ch: ChannelSummary = channel()) {
  const fake = new FakeClient();
  fake.set('account', account());
  const onClose = vi.fn();
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}>
    <ChannelEditFlow channel={ch} categories={[]} announce={vi.fn()} onClose={onClose} />
  </CoreProvider></div>);
  return { fake, user, view, onClose };
}
const dialog = () => screen.getByRole('dialog');
const select = () => within(dialog()).getByRole('combobox', { name: en['slow.label'] });
const save = () => within(dialog()).getByRole('button', { name: en['admin.channel.save'] });

describe('slow mode in the channel settings (web3.7)', () => {
  const KEYS = ['slow.off', 'slow.s5', 'slow.s10', 'slow.s30', 'slow.m1', 'slow.m5', 'slow.m15', 'slow.h1', 'slow.h6'] as const;
  it('offers the nine steps in order, labelled and hinted, for a text channel', () => {
    setup();
    expect(select()).toHaveAccessibleDescription(en['slow.hint']);
    const options = within(select()).getAllByRole<HTMLOptionElement>('option');
    expect(options.map(o => o.value)).toEqual(['0', '5', '10', '30', '60', '300', '900', '3600', '21600']);
    expect(options.map(o => o.textContent)).toEqual(KEYS.map(k => en[k]));
    expect(select()).toHaveValue('0');
  });
  it('preselects the channel’s current step and sends nothing when it is saved unchanged', async () => {
    const { fake, user, onClose } = setup(channel({ slowmode: 300 }));
    expect(select()).toHaveValue('300');
    await user.click(save());
    expect(onClose).toHaveBeenCalled();
    expect(fake.callsOf('updateChannel')).toEqual([]);
  });
  it('sends the chosen step as slowmode and nothing else', async () => {
    const { fake, user } = setup();
    await user.selectOptions(select(), en['slow.s30']);
    await user.click(save());
    await waitFor(() => expect(fake.callsOf('updateChannel')).toEqual([{ m: 'updateChannel', channelId: LOBBY, name: null, topic: null, parent: 'keep', slowmode: 30 }]));
  });
  it('sends 0 to turn slow mode off', async () => {
    const { fake, user } = setup(channel({ slowmode: 60 }));
    await user.selectOptions(select(), en['slow.off']);
    await user.click(save());
    await waitFor(() => expect(fake.callsOf('updateChannel')[0]?.slowmode).toBe(0));
  });
  it('keeps the dialog open with its error when the instance refuses, then closes on the retry', async () => {
    const { fake, user, onClose } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 }));
    await user.selectOptions(select(), en['slow.m5']);
    await user.click(save());
    expect(await within(dialog()).findByText(en['admin.channel.error.forbidden'])).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(select()).toHaveValue('300');
    fake.handler = () => Promise.resolve(null);
    await user.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
  it('has no slow mode field for a voice channel', () => {
    setup(channel({ id: VOICE, kind: 1, name: 'General voice' }));
    expect(within(dialog()).queryByRole('combobox', { name: en['slow.label'] })).toBeNull();
  });
  it('passes axe with the field', async () => {
    const { view } = setup();
    await expectNoAxeViolations(view.baseElement);
  });
});
