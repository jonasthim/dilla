import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import type { ChannelSummary } from '@dilla/client-core';
import { A, BOB, BOB_DEV, callState, OWN_DEV, renderVoiceShell } from '../test/fake-client.ts';
import { ME } from '../test/fixtures.ts';

// Web3.8 (WS5, item 12): one channel list. The voice channels stand in position among the text channels, with their people
// nested under them; there is no "active voice" and no "voice" heading.
const TA = '51'.repeat(16);
const VV = '52'.repeat(16);
const TB = '53'.repeat(16);
const VW = '54'.repeat(16);
const ch = (id: string, name: string, kind: 0 | 1 | 2, position: number): ChannelSummary => ({
  id, communityId: A, kind, mode: 0, name, topic: '', parentId: null, position, slowmode: 0, announcement: false,
  group: kind === 1 ? 'unsupported' : 'active' });
const CHANNELS = [ch(TA, 'alpha', 0, 0), ch(VV, 'lounge', 1, 1), ch(TB, 'beta', 0, 2), ch(VW, 'studio', 1, 3)];

afterEach(() => { vi.restoreAllMocks(); });

function mount() {
  const app = renderVoiceShell({ path: `/c/${A}/${TA}`, voice: {
    [VV]: { callId: VV, participants: [
      { userId: ME.id, deviceId: OWN_DEV, name: 'ada', flags: 0, own: true, web: true, bot: false },
      { userId: BOB, deviceId: BOB_DEV, name: 'bob', flags: 1, own: false, web: true, bot: false },
    ] } } });
  act(() => app.client.publish(`channels:${A}`, CHANNELS));
  return app;
}
const list = () => screen.getByRole('navigation', { name: 'channels' });

describe('one channel list (web3.8 item 12)', () => {
  it('lists text and voice channels in position order, in one list', async () => {
    mount();
    await within(list()).findByRole('button', { name: 'voice lounge' });
    const text = list().textContent ?? '';
    const order = ['alpha', 'lounge', 'beta', 'studio'].map(n => text.indexOf(n));
    expect(order.every(i => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(list().querySelectorAll('ul[role="list"]:not(.d-voice-row__people)').length).toBe(1);
  });

  it('has no "active voice" and no "voice" heading, and gives the voice row its speaker icon', async () => {
    mount();
    const lounge = await within(list()).findByRole('button', { name: 'voice lounge' });
    expect(screen.queryByRole('heading', { name: 'active voice' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'voice' })).toBeNull();
    expect(lounge.querySelector('[data-icon="volume-2"]')).not.toBeNull();
    expect(document.querySelector('.dw-voice-section, .d-active-voice')).toBeNull();
  });

  it('nests the people under their voice row, speaking from the call', async () => {
    const app = mount();
    const lounge = await within(list()).findByRole('button', { name: 'voice lounge' });
    const item = lounge.closest('li')!;
    const names = [...item.querySelectorAll('.d-voice-row__person-name')].map(n => n.textContent);
    expect(names).toEqual(['ada', 'bob']);
    expect(item.querySelector('[data-speaking="true"]')).toBeNull();
    await app.user.click(lounge);
    await app.user.click(await within(screen.getByRole('main')).findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    app.client.publish('call', callState({ phase: 'in', channelId: VV, callId: VV }));
    act(() => app.session.update({ speaking: true }));
    await waitFor(() => expect(item.querySelector('[data-speaking="true"] .d-voice-row__person-name')).toHaveTextContent('ada'));
  });

  it('shows no unread badge on a voice row', async () => {
    const app = mount();
    act(() => app.client.publish('badges', { [VV]: { unread: 4, mentions: 0 }, [TB]: { unread: 2, mentions: 0 } }));
    const lounge = await within(list()).findByRole('button', { name: 'voice lounge' });
    expect(lounge).toHaveAccessibleName('voice lounge');
    expect(lounge.closest('li')!.querySelector('.d-pill')).toBeNull();
    // The control: the text row beside it does show its count.
    expect(within(list()).getByRole('button', { name: /^beta/ })).toHaveAccessibleName(/2/);
  });

  it('moves with ArrowDown from the text row to the voice row to the next text row', async () => {
    const app = mount();
    await within(list()).findByRole('button', { name: 'voice lounge' });
    within(list()).getByRole('button', { name: /^alpha/ }).focus();
    await app.user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(within(list()).getByRole('button', { name: 'voice lounge' }));
    await app.user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(within(list()).getByRole('button', { name: /^beta/ }));
  });

  it('opens a voice room from its join button', async () => {
    const app = mount();
    await within(list()).findByRole('button', { name: 'voice lounge' });
    await app.user.click(within(list()).getAllByRole('button', { name: 'join voice' })[0]);
    await waitFor(() => expect(app.log).toContain(`callJoin:${VV}`));
    expect(window.location.pathname).toBe(`/c/${A}/${VV}`);
  });
});
