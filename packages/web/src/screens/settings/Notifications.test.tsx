import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelSummary, DmSummary } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient, refusal } from '../../test/fake-client.ts';
import { account } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { Notifications } from './Notifications.tsx';

const A = 'a1'.repeat(16);
const GEN = 'c3'.repeat(16);
const RAND = 'd4'.repeat(16);
const VOICE = 'e5'.repeat(16);
const DM = '9a'.repeat(16);
const ch = (id: string, name: string, over: Partial<ChannelSummary> = {}): ChannelSummary =>
  ({ id, communityId: A, kind: 0, mode: 0, name, topic: '', parentId: null, position: 0, slowmode: 0, announcement: false, group: 'active', ...over });
const DMS: DmSummary[] = [{ id: DM, kind: 3, members: ['bb'.repeat(16), '28'.repeat(16)], name: 'bob', group: 'active' }];

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static asked = 0;
  static requestPermission(): Promise<NotificationPermission> {
    FakeNotification.asked += 1;
    FakeNotification.permission = 'granted';
    return Promise.resolve('granted');
  }
}

afterEach(() => { vi.unstubAllGlobals(); });

function setup(opts: { settings?: Record<string, string>; permission?: NotificationPermission | null } = {}) {
  if (opts.permission !== null) {
    FakeNotification.permission = opts.permission ?? 'default';
    FakeNotification.asked = 0;
    vi.stubGlobal('Notification', FakeNotification);
  }
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('communities', [{ id: A, name: 'Midgard', owner: 'ee'.repeat(16) }]);
  fake.set(`channels:${A}`, [ch(RAND, 'random', { position: 2 }), ch(VOICE, 'lounge', { kind: 1, position: 0 }), ch(GEN, 'general', { position: 1 })]);
  fake.set('dms', DMS);
  fake.set('settings', opts.settings ?? {});
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><Notifications /></CoreProvider></div>);
  return { fake, user, view };
}
const group = (name: string) => screen.getByRole('group', { name });

describe('the permission', () => {
  it('is asked only from the click, never on render', async () => {
    const { user, view } = setup();
    expect(FakeNotification.asked).toBe(0);
    expect(screen.getByRole('heading', { level: 2, name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByText('Desktop notifications show while a dilla tab is open. Nothing is shown when every tab is closed.')).toBeInTheDocument();
    await expectNoAxeViolations(view.container);
    await user.click(within(group('desktop notifications')).getByRole('button', { name: 'turn on' }));
    expect(FakeNotification.asked).toBe(1);
    expect(await within(group('desktop notifications')).findByText('on')).toBeInTheDocument();
    expect(within(group('desktop notifications')).queryByRole('button')).toBeNull();
  });
  it.each([
    ['granted', 'on'],
    ['denied', 'Blocked in the browser. Allow notifications for this site in the browser’s settings.'],
  ] as const)('shows %s as it is', (permission, text) => {
    setup({ permission });
    expect(within(group('desktop notifications')).getByText(text)).toBeInTheDocument();
    expect(within(group('desktop notifications')).queryByRole('button')).toBeNull();
    expect(FakeNotification.asked).toBe(0);
  });
  it('says when the browser has no notifications', () => {
    setup({ permission: null });
    expect(within(group('desktop notifications')).getByText('This browser cannot show notifications.')).toBeInTheDocument();
  });
});

describe('the default and per channel', () => {
  it('writes the default', async () => {
    const { fake, user } = setup();
    const choice = screen.getByRole('radiogroup', { name: 'notify me about' });
    expect(within(choice).getByRole('radio', { name: 'direct messages and mentions' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(choice).getByRole('radio', { name: 'every message' }));
    expect(fake.callsOf('setSetting')).toEqual([{ m: 'setSetting', key: 'notify.default', value: 'everything' }]);
  });
  it('lists every text channel by server and every direct message, in order', async () => {
    const { view } = setup();
    expect(screen.getByRole('heading', { level: 3, name: 'Per channel' })).toBeInTheDocument();
    expect(screen.getByText('Every channel and direct message. Rows left on default follow the choice above.')).toBeInTheDocument();
    const order = ['notify me about', '#general · Midgard', '#random · Midgard', 'bob'].map(name => screen.getByRole('radiogroup', { name }));
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getAllByRole('radiogroup')).toHaveLength(5);
    expect(screen.queryByRole('group', { name: '#lounge · Midgard' })).toBeNull();
    await expectNoAxeViolations(view.container);
  });
  it('writes a channel mode, and default deletes it', async () => {
    const { fake, user } = setup({ settings: { [`notify.channel.${GEN}`]: 'all' } });
    const modes = within(group('#general · Midgard')).getByRole('radiogroup', { name: '#general · Midgard' });
    expect(within(modes).getByRole('radio', { name: 'all' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(modes).getByRole('radio', { name: 'mentions' }));
    await user.click(within(modes).getByRole('radio', { name: 'default' }));
    await user.click(within(group('bob')).getByRole('radio', { name: 'nothing' }));
    expect(fake.callsOf('setSetting')).toEqual([
      { m: 'setSetting', key: `notify.channel.${GEN}`, value: 'mentions' },
      { m: 'setSetting', key: `notify.channel.${GEN}`, value: null },
      { m: 'setSetting', key: `notify.channel.${DM}`, value: 'nothing' },
    ]);
  });
  it('mutes and unmutes a channel', async () => {
    const { fake, user } = setup({ settings: { [`mute.channel.${RAND}`]: '1' } });
    const rand = within(group('#random · Midgard')).getByRole('switch', { name: 'mute' });
    expect(rand).toHaveAttribute('aria-checked', 'true');
    expect(rand).toHaveAttribute('aria-labelledby');
    expect(within(group('#random · Midgard')).getByText('mute')).toBeVisible();
    await user.click(rand);
    await user.click(within(group('#general · Midgard')).getByRole('switch', { name: 'mute' }));
    expect(fake.callsOf('setSetting')).toEqual([
      { m: 'setSetting', key: `mute.channel.${RAND}`, value: null },
      { m: 'setSetting', key: `mute.channel.${GEN}`, value: '1' },
    ]);
  });
  it('shows a refused write by its code', async () => {
    const { fake, user } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_SETTING_KEY' }));
    await user.click(within(group('bob')).getByRole('switch', { name: 'mute' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not work (E_SETTING_KEY). Try again.');
  });
});

describe('per server (web3.5 WA5)', () => {
  const NAME = 'Midgard';
  it('lists the server before the channels, with a mode, a mute and an @everyone switch, and passes axe', async () => {
    const { view } = setup();
    expect(screen.getByRole('heading', { level: 3, name: 'Servers' })).toBeInTheDocument();
    expect(screen.getByText('A server’s setting applies to its channels unless a channel has its own.')).toBeInTheDocument();
    const server = group(NAME);
    expect(within(within(server).getByRole('radiogroup', { name: NAME })).getAllByRole('radio').map(r => r.textContent))
      .toEqual(['default', 'all messages', 'mentions', 'nothing']);
    expect(within(server).getByRole('switch', { name: 'mute server' })).toBeInTheDocument();
    expect(within(server).getByRole('switch', { name: 'ignore @everyone and @here' })).toBeInTheDocument();
    const channels = screen.getByRole('heading', { level: 3, name: 'Per channel' });
    expect(screen.getByRole('heading', { level: 3, name: 'Servers' }).compareDocumentPosition(channels) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expectNoAxeViolations(view.container);
  });
  it('writes a mode under notify.community.<hex>, and default deletes the key', async () => {
    const { fake, user } = setup({ settings: { [`notify.community.${A}`]: 'nothing' } });
    const modes = within(group(NAME)).getByRole('radiogroup', { name: NAME });
    expect(within(modes).getByRole('radio', { name: 'nothing' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(modes).getByRole('radio', { name: 'mentions' }));
    await user.click(within(modes).getByRole('radio', { name: 'default' }));
    expect(fake.callsOf('setSetting')).toEqual([
      { m: 'setSetting', key: `notify.community.${A}`, value: 'mentions' },
      { m: 'setSetting', key: `notify.community.${A}`, value: null },
    ]);
  });
  it('mutes the server and ignores @everyone, each deleting its key when switched off', async () => {
    const { fake, user } = setup({ settings: { [`mute.community.${A}`]: '1' } });
    const server = within(group(NAME));
    const mute = server.getByRole('switch', { name: 'mute server' });
    expect(mute).toHaveAttribute('aria-checked', 'true');
    await user.click(mute);
    await user.click(server.getByRole('switch', { name: 'ignore @everyone and @here' }));
    expect(fake.callsOf('setSetting')).toEqual([
      { m: 'setSetting', key: `mute.community.${A}`, value: null },
      { m: 'setSetting', key: `everyone.community.${A}`, value: '1' },
    ]);
  });
});

describe('sounds (flow 06, R4)', () => {
  it('Settings → Voice and → Notifications store their keys through setSetting (the Notifications half)', async () => {
    const { fake, user } = setup();
    const voice = screen.getByRole('switch', { name: 'join and leave sounds' });
    const ring = screen.getByRole('switch', { name: 'ring for calls' });
    // Both on by default.
    expect(voice).toHaveAttribute('aria-checked', 'true');
    expect(ring).toHaveAttribute('aria-checked', 'true');
    await user.click(voice);
    expect(fake.callsOf('setSetting').at(-1)).toEqual({ m: 'setSetting', key: 'sound.voice', value: 'off' });
    await user.click(ring);
    expect(fake.callsOf('setSetting').at(-1)).toEqual({ m: 'setSetting', key: 'sound.ring', value: 'off' });
    expect(screen.getByRole('heading', { name: 'sounds' })).toBeInTheDocument();
  });
  it('shows a stored off and turns it back on', async () => {
    const { fake, user } = setup({ settings: { 'sound.ring': 'off' } });
    const ring = screen.getByRole('switch', { name: 'ring for calls' });
    expect(ring).toHaveAttribute('aria-checked', 'false');
    await user.click(ring);
    expect(fake.callsOf('setSetting').at(-1)).toEqual({ m: 'setSetting', key: 'sound.ring', value: 'on' });
  });
});
