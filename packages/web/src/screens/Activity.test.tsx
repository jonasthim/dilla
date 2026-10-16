import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelSummary, Notice } from '@dilla/client-core';
import { CoreProvider } from '../core/context.tsx';
import { FakeClient } from '../test/fake-client.ts';
import { account, ME } from '../test/fixtures.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import { t } from '../strings/index.ts';
import { Activity } from './Activity.tsx';

const A = 'a1'.repeat(16);
const LOOT = 'b2'.repeat(16);
const GEN = 'c3'.repeat(16);
const LFG = 'd4'.repeat(16);
const DM = 'e5'.repeat(16);
const DM2 = 'f6'.repeat(16);
const NOW = Math.floor(Date.now() / 1000);
const notice = (id: number, over: Partial<Notice>): Notice =>
  ({ id, channelId: LOOT, communityId: A, kind: 'mention', senderUser: null, senderName: 'ada', body: 'hello', ts: NOW - 60 * (10 - id), ...over });
const ch = (id: string, name: string): ChannelSummary => ({ id, communityId: A, kind: 0, mode: 0, name, topic: '', parentId: null, position: 0, group: 'none' });

function setup(opts: { notices?: Notice[]; badges?: Record<string, { unread: number; mentions: number }> } = {}) {
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('communities', [{ id: A, name: 'Midgard', owner: 'ee'.repeat(16) }]);
  fake.set(`channels:${A}`, [ch(LOOT, 'loot'), ch(GEN, 'general'), ch(LFG, 'lfg')]);
  fake.set('dms', [{ id: DM, name: 'bjorn', members: [], group: 'active' }, { id: DM2, name: 'mira', members: [], group: 'active' }] as never);
  fake.set('notices', { nextId: 10, items: opts.notices ?? [] });
  fake.set('badges', opts.badges ?? {});
  const onOpen = vi.fn();
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><Activity onOpen={onOpen} /></CoreProvider></div>);
  return { fake, user, view, onOpen };
}

describe('Activity', () => {
  it('lists mentions and DMs newest first and leaves plain messages out', () => {
    setup({ notices: [
      notice(1, { kind: 'message', body: 'plain', channelId: GEN }),
      notice(2, { kind: 'mention', senderName: 'ada', body: 'bring the tank gear', channelId: LOOT }),
      notice(3, { kind: 'dm', senderName: 'bjorn', body: 'after nine', channelId: DM, communityId: null }),
    ] });
    expect(screen.getByRole('heading', { level: 1, name: t('activity.title') })).toBeInTheDocument();
    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(`bjorn · ${t('activity.dm')}`);
    expect(rows[0]).toHaveTextContent('after nine');
    expect(rows[1]).toHaveTextContent(`ada ${t('activity.mention', { channel: 'loot' })}`);
    expect(rows[1]).toHaveTextContent('bring the tank gear');
    expect(screen.queryByText('plain')).toBeNull();
  });

  it('lists what is unread elsewhere, once, with its count', () => {
    setup({
      notices: [notice(1, { kind: 'mention', channelId: LOOT })],
      badges: { [LOOT]: { unread: 4, mentions: 1 }, [GEN]: { unread: 3, mentions: 0 }, [DM2]: { unread: 2, mentions: 0 }, [LFG]: { unread: 0, mentions: 0 } },
    });
    const section = screen.getByRole('region', { name: t('activity.elsewhere') });
    const rows = within(section).getAllByRole('button');
    expect(rows.map(r => r.textContent)).toEqual([expect.stringContaining('general'), expect.stringContaining('mira')]);
    expect(within(rows[0]).getByText('3 unread')).toBeInTheDocument();
    expect(within(section).queryByText('loot')).toBeNull();
    expect(screen.getByText(t('activity.since'))).toBeInTheDocument();
  });

  it('says there is nothing new when there are no notices and nothing unread', async () => {
    const { view } = setup();
    expect(screen.getByText(t('activity.empty'))).toBeInTheDocument();
    expect(screen.queryByText(t('activity.since'))).toBeNull();
    await expectNoAxeViolations(view.container);
  });

  it('opens the channel or DM a row names', async () => {
    const { user, onOpen } = setup({
      notices: [notice(1, { kind: 'mention', channelId: LOOT }), notice(2, { kind: 'dm', channelId: DM, communityId: null, senderName: 'bjorn' })],
      badges: { [GEN]: { unread: 1, mentions: 0 } },
    });
    await user.click(screen.getByRole('button', { name: new RegExp(t('activity.dm')) }));
    expect(onOpen).toHaveBeenLastCalledWith({ communityId: null, channelId: DM });
    await user.click(screen.getByRole('button', { name: new RegExp('mentioned you') }));
    expect(onOpen).toHaveBeenLastCalledWith({ communityId: A, channelId: LOOT });
    await user.click(screen.getByRole('button', { name: /general/ }));
    expect(onOpen).toHaveBeenLastCalledWith({ communityId: A, channelId: GEN });
  });

  it('shows a mention by its name, never as its raw id', () => {
    setup({ notices: [notice(1, { kind: 'mention', body: `<@${ME.id}> bring the tank gear` })] });
    expect(screen.getByRole('button', { name: /mentioned you/ })).toHaveTextContent('@ada bring the tank gear');
    expect(screen.queryByText(/<@/)).toBeNull();
  });

  it('lists a muted channel that only has a mention, which the tab count includes', () => {
    const { fake } = setup({ badges: { [GEN]: { unread: 3, mentions: 1 } } });
    act(() => fake.set('settings', { [`mute.channel.${GEN}`]: '1' }));
    const row = screen.getByRole('button', { name: /general/ });
    expect(row).toHaveTextContent('1 mention');
    expect(row).not.toHaveTextContent('unread');
    expect(screen.queryByText(t('activity.empty'))).toBeNull();
  });

  it('has no axe violations with rows', async () => {
    const { view } = setup({ notices: [notice(1, { kind: 'mention' })], badges: { [GEN]: { unread: 2, mentions: 0 } } });
    await expectNoAxeViolations(view.container);
  });
});
