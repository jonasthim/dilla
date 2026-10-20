import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { PHONE_QUERY } from '../layout.ts';
import { t } from '../strings/index.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import { A, callState, CHANNELS, DM, GENV, renderVoiceShell, TEXT, type VoiceHarnessOptions } from '../test/fake-client.ts';

/** A window of the given kind: only the phone query matches, so the wide-window defaults (the members column) stay off. */
function media(phone: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: phone && query === PHONE_QUERY, media: query,
    addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}
afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  // eslint-disable-next-line no-restricted-properties -- clears the tab memory the shell writes
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function phone(o: VoiceHarnessOptions = {}) {
  media(true);
  return renderVoiceShell(o);
}
const tabs = () => screen.queryByRole('navigation', { name: t('nav.tabs.label') });
const tab = (name: string) => within(tabs()!).getByRole('link', { name });
const goto = (path: string, state: unknown = null) => {
  act(() => {
    window.history.pushState(state, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
};
const here = () => window.location.pathname;
const manage = (fake: ReturnType<typeof renderVoiceShell>['client']) =>
  act(() => { fake.publish(`permissions:${A}`, { loaded: true, manageChannels: true } as never); });

describe('the phone shell: the servers list', () => {
  it('shows the tab bar, stays on the server (no first-channel redirect) and has no status bar or sidebar tabs', async () => {
    phone({ path: `/c/${A}` });
    await screen.findByRole('navigation', { name: t('shell.channels.label') });
    expect(within(tabs()!).getAllByRole('link').map(l => l.textContent)).toEqual(['servers', 'DMs', 'activity', 'you']);
    expect(tab('servers')).toHaveAttribute('aria-current', 'page');
    expect(here()).toBe(`/c/${A}`);
    expect(screen.queryByRole('region', { name: t('shell.status.label') })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.querySelector('.dw-voice-dock')).toBeNull();
  });

  it('has the gear and the search icon beside the server name, no menu; the list header has the "+" only for a person who may', async () => {
    const { user, client } = phone({ path: `/c/${A}` });
    const gear = await screen.findByRole('button', { name: t('admin.open') });
    const search = screen.getByRole('button', { name: t('search.open') });
    const head = gear.closest('.d-channel-list__head') as HTMLElement;
    expect(within(head).getAllByRole('button')).toEqual([search, gear]);
    expect(gear.querySelector('svg[data-icon="settings"]')).not.toBeNull();
    expect(search.querySelector('svg[data-icon="search"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: t('nav.server.menu') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('admin.leave.open') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('create.channel.open') })).toBeNull();
    manage(client);
    expect(screen.getByRole('button', { name: t('create.channel.open') })).toBeInTheDocument();
    await user.click(gear);
    const dialog = await screen.findByRole('dialog', { name: t('admin.title') });
    expect(within(dialog).getByRole('button', { name: t('admin.nav.leave') })).toBeInTheDocument();
  });

  it('labels the rail’s join and new buttons with visible captions (walk 24)', async () => {
    phone({ path: `/c/${A}` });
    const rail = await screen.findByRole('navigation', { name: t('shell.rail.label') });
    expect(within(rail).getByText(t('create.rail.join'))).toBeVisible();
    expect(within(rail).getByText(t('create.rail.new'))).toBeVisible();
  });

  it('has no axe violations', async () => {
    const { view } = phone({ path: `/c/${A}` });
    await screen.findByRole('button', { name: t('admin.open') });
    await expectNoAxeViolations(view.container);
  });
});

describe('the phone shell: search (walk 1)', () => {
  it('opens the full-screen search from the servers list menu', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await user.click(await screen.findByRole('button', { name: t('search.open') }));
    const dialog = screen.getByRole('dialog', { name: t('search.placeholder') });
    expect(dialog.className).toContain('dw-search');
    expect(screen.getByRole('combobox', { name: t('search.placeholder') })).toHaveFocus();
  });

  it('opens it from the channel menu, scoped to the conversation', async () => {
    const { user, client } = phone({ path: `/c/${A}/${TEXT}` });
    await user.click(await screen.findByRole('button', { name: t('nav.channel.menu') }));
    await user.click(screen.getByRole('menuitem', { name: t('search.open') }));
    await user.type(screen.getByRole('combobox', { name: t('search.placeholder') }), 'lamp');
    await waitFor(() => expect(client.callsOf('search')).toContainEqual({ m: 'search', scope: 'channel', id: TEXT, query: 'lamp', cursor: null }));
  });
});

describe('the phone shell: pushed views', () => {
  it('pushes a channel with phoneBack, shows it alone, and back calls history.back()', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await user.click(await screen.findByRole('button', { name: 'lobby' }));
    expect(here()).toBe(`/c/${A}/${TEXT}`);
    expect(window.history.state).toMatchObject({ phoneBack: true });
    expect(tabs()).not.toBeNull();
    expect(screen.getByRole('main')).not.toHaveAttribute('hidden');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: t('nav.back') }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('opening a channel focuses no field: the composer is not active and the tab bar is shown', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await user.click(await screen.findByRole('button', { name: 'lobby' }));
    const box = await screen.findByRole('textbox', { name: 'message #lobby' });
    expect(box).not.toHaveFocus();
    expect(tabs()).toBeVisible();
    expect(document.querySelector('.d-app-shell')).not.toHaveAttribute('data-typing');
  });

  it('replaces a deep-linked channel with its server on back', async () => {
    const { user } = phone({ path: `/c/${A}/${TEXT}` });
    const before = window.history.length;
    await user.click(await screen.findByRole('button', { name: t('nav.back') }));
    expect(here()).toBe(`/c/${A}`);
    expect(window.history.length).toBe(before);
    expect(await screen.findByRole('navigation', { name: t('nav.tabs.label') })).toBeInTheDocument();
  });

  it('names the channel menu: pins and members, and edit channel for a person who may', async () => {
    const { user, client } = phone({ path: `/c/${A}/${TEXT}` });
    await user.click(await screen.findByRole('button', { name: t('nav.channel.menu') }));
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual([t('search.open'), t('shell.pins.open'), t('thread.list'), t('members.toggle')]);
    await user.keyboard('{Escape}');
    manage(client);
    await user.click(screen.getByRole('button', { name: t('nav.channel.menu') }));
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual([t('search.open'), t('shell.pins.open'), t('thread.list'), t('admin.channel.open'), t('members.toggle')]);
  });

  it('opens a DM as a pushed view with a pins menu', async () => {
    const { user } = phone({ path: '/dm' });
    await user.click(await screen.findByRole('button', { name: 'bob' }));
    expect(here()).toBe(`/dm/${DM}`);
    expect(window.history.state).toMatchObject({ phoneBack: true });
    expect(tabs()).not.toBeNull();
    await user.click(screen.getByRole('button', { name: t('nav.channel.menu') }));
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual([t('search.open'), t('shell.pins.open')]);
  });

  it('gives the voice stage a phone header with its name and a back, under the tab bar', async () => {
    phone({ path: `/c/${A}/${GENV}` });
    expect(await screen.findByRole('heading', { level: 2, name: 'general' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('nav.back') })).toBeInTheDocument();
    expect(tabs()).not.toBeNull();
  });
});

describe('the phone shell: the members sheet', () => {
  it('opens as a history entry, closes on the system back and returns focus to the menu', async () => {
    const { user } = phone({ path: `/c/${A}/${TEXT}` });
    const trigger = await screen.findByRole('button', { name: t('nav.channel.menu') });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: t('members.toggle') }));
    expect(await screen.findByRole('complementary', { name: 'members of Midgard' })).toBeInTheDocument();
    expect(window.history.state).toMatchObject({ phoneSheet: 'members' });
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('closes through its own back control by popping its entry', async () => {
    const { user } = phone({ path: `/c/${A}/${TEXT}` });
    await user.click(await screen.findByRole('button', { name: t('nav.channel.menu') }));
    await user.click(screen.getByRole('menuitem', { name: t('members.toggle') }));
    const sheet = await screen.findByRole('complementary', { name: 'members of Midgard' });
    const length = window.history.length;
    await user.click(within(sheet).getByRole('button', { name: t('members.close') }));
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(window.history.length).toBe(length);
    expect((window.history.state as { phoneSheet?: unknown } | null)?.phoneSheet).toBeUndefined();
  });
});

describe('the phone shell: the link banner', () => {
  const line = () => document.querySelector('.d-link-banner');
  it('says nothing online, offline when the link is down, and where it connects while connecting', async () => {
    const { client } = phone({ path: `/c/${A}` });
    await screen.findByRole('navigation', { name: t('shell.channels.label') });
    expect(line()).toHaveAttribute('role', 'status');
    expect(line()).toHaveTextContent('');
    act(() => client.set('connection', { status: 'offline', generation: '1' }));
    expect(screen.getByText(t('nav.link.offline'))).toBeInTheDocument();
    expect(screen.getByText(t('nav.link.offline')).closest('[role="status"]')).toBe(line());
    act(() => client.set('connection', { status: 'connecting', generation: '1' }));
    expect(line()).toHaveTextContent(t('nav.link.connecting', { node: 'dilla.test' }));
    act(() => client.set('connection', { status: 'online', generation: '1' }));
    expect(line()).toHaveTextContent('');
  });
});

describe('the phone shell: tabs', () => {
  it('goes to the DMs, activity and you tabs and shows each screen without a rail', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await screen.findByRole('navigation', { name: t('shell.channels.label') });
    expect(screen.getByRole('navigation', { name: t('shell.rail.label') })).toBeInTheDocument();
    await user.click(tab('DMs'));
    expect(here()).toBe('/dm');
    expect(await screen.findByRole('button', { name: 'bob' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: t('shell.rail.label') })).toBeNull();
    expect(tab('DMs')).toHaveAttribute('aria-current', 'page');
    await user.click(tab('activity'));
    expect(here()).toBe('/activity');
    expect(await screen.findByText(t('activity.empty'))).toBeInTheDocument();
    await user.click(tab('you'));
    expect(here()).toBe('/you');
    expect(await screen.findByRole('heading', { level: 1, name: t('you.title') })).toBeInTheDocument();
  });

  it('counts DMs unread, and activity as channel mentions plus DM unread', async () => {
    const { client } = phone({ path: '/dm' });
    await screen.findByRole('button', { name: 'bob' });
    act(() => client.set('badges', { [TEXT]: { unread: 5, mentions: 2 }, [DM]: { unread: 3, mentions: 0 } }));
    expect(tab(t('nav.tab.unread', { name: 'DMs', count: 3 }))).toBeInTheDocument();
    expect(tab(t('nav.tab.unread', { name: 'activity', count: 5 }))).toBeInTheDocument();
  });

  it('opens a tab where it was left', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await user.click(await screen.findByRole('button', { name: 'lobby' }));
    expect(here()).toBe(`/c/${A}/${TEXT}`);
    goto('/dm', { phoneBack: true });
    await screen.findByRole('button', { name: 'bob' });
    await user.click(tab('servers'));
    expect(here()).toBe(`/c/${A}/${TEXT}`);
  });

  it('keeps the tab bar in a channel; the current tab goes back to its list', async () => {
    const { user } = phone({ path: `/c/${A}/${TEXT}` });
    await screen.findByRole('main');
    expect(tabs()).not.toBeNull();
    expect(tab('servers')).toHaveAttribute('aria-current', 'page');
    await user.click(tab('servers'));
    expect(here()).toBe(`/c/${A}`);
    expect(await screen.findByRole('navigation', { name: t('shell.channels.label') })).toBeInTheDocument();
  });

  it('opens the remembered DMs route from a channel, and servers again returns to that channel list', async () => {
    const { user } = phone({ path: `/dm/${DM}` });
    await screen.findByRole('main');
    goto(`/c/${A}/${TEXT}`, { phoneBack: true });
    await user.click(tab('DMs'));
    expect(here()).toBe(`/dm/${DM}`);
    await user.click(tab('servers'));
    expect(here()).toBe(`/c/${A}/${TEXT}`);
  });

  it('an open members sheet closes when a tab is tapped: its entry is popped once and the new tab shows', async () => {
    const { user } = phone({ path: `/c/${A}/${TEXT}` });
    await user.click(await screen.findByRole('button', { name: t('nav.channel.menu') }));
    await user.click(screen.getByRole('menuitem', { name: t('members.toggle') }));
    await screen.findByRole('complementary', { name: 'members of Midgard' });
    expect(tabs()).not.toBeNull();
    const length = window.history.length;
    const back = vi.spyOn(window.history, 'back');
    await user.click(tab('activity'));
    await waitFor(() => expect(here()).toBe('/activity'));
    expect(back).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(await screen.findByText(t('activity.empty'))).toBeInTheDocument();
    expect(window.history.length).toBe(length);
    expect((window.history.state as { phoneSheet?: unknown } | null)?.phoneSheet).toBeUndefined();
  });

  it('a tab tap closes server settings too', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await user.click(await screen.findByRole('button', { name: t('admin.open') }));
    expect(await screen.findByRole('dialog', { name: t('admin.title') })).toBeInTheDocument();
    await user.click(tab('DMs'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('admin.title') })).toBeNull());
    expect(here()).toBe('/dm');
    expect(document.querySelector('main')).not.toHaveAttribute('inert');
  });

  it('two quick taps on a tab with a sheet open pop the sheet entry once', async () => {
    phone({ path: `/c/${A}/${TEXT}` });
    const { user } = { user: (await import('@testing-library/user-event')).default.setup() };
    await user.click(await screen.findByRole('button', { name: t('nav.channel.menu') }));
    await user.click(screen.getByRole('menuitem', { name: t('members.toggle') }));
    await screen.findByRole('complementary', { name: 'members of Midgard' });
    const back = vi.spyOn(window.history, 'back');
    const link = tab('activity');
    act(() => { link.click(); link.click(); });
    await waitFor(() => expect(here()).toBe('/activity'));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('the current tab in a view the app pushed goes back instead of replacing it', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await user.click(await screen.findByRole('button', { name: 'lobby' }));
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await user.click(tab('servers'));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('the current tab lands on its own list, never on the screen the view was pushed from', async () => {
    const { user } = phone({ path: '/activity' });
    await screen.findByRole('heading', { name: t('activity.title') });
    goto(`/c/${A}/${TEXT}`, { phoneBack: true, phoneFrom: '/activity' });
    await screen.findByRole('textbox', { name: 'message #lobby' });
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await user.click(tab('servers'));
    expect(back).not.toHaveBeenCalled();
    expect(here()).toBe(`/c/${A}`);
  });

  describe('the system forward button (N5, R-c)', () => {
    /** history.back() that lands on the DMs list, as it does when the person went forward onto this view. */
    const backToDms = () => {
      let pop: () => void = () => undefined;
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => {
        pop = () => {
          window.history.replaceState(null, '', '/dm');
          window.dispatchEvent(new PopStateEvent('popstate'));
        };
      });
      return { back, pop: () => pop() };
    };

    it('lands the current tab on its own list when back would land on another view', async () => {
      const { user } = phone({ path: '/dm' });
      await screen.findByRole('navigation', { name: t('shell.dms.label') });
      goto(`/c/${A}/${TEXT}`, { phoneBack: true, phoneFrom: `/c/${A}` });
      await screen.findByRole('textbox', { name: 'message #lobby' });
      const { back, pop } = backToDms();
      await user.click(tab('servers'));
      expect(back).toHaveBeenCalledTimes(1);
      act(() => pop());
      await waitFor(() => expect(here()).toBe(`/c/${A}`));
    });

    it('control: back that lands on the tab list is left alone', async () => {
      const { user } = phone({ path: `/c/${A}` });
      await screen.findByRole('navigation', { name: t('shell.channels.label') });
      goto(`/c/${A}/${TEXT}`, { phoneBack: true, phoneFrom: `/c/${A}` });
      await screen.findByRole('textbox', { name: 'message #lobby' });
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => {
        window.history.replaceState(null, '', `/c/${A}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      const replace = vi.spyOn(window.history, 'replaceState');
      await user.click(tab('servers'));
      expect(back).toHaveBeenCalledTimes(1);
      expect(replace).toHaveBeenCalledTimes(1); // the mock's own
      expect(here()).toBe(`/c/${A}`);
    });

    it('a second tap before the pop removes the first tap’s popstate listener, and the shell going away removes the last', async () => {
      const { user, view } = phone({ path: '/dm' });
      await screen.findByRole('navigation', { name: t('shell.dms.label') });
      goto(`/c/${A}/${TEXT}`, { phoneBack: true, phoneFrom: `/c/${A}` });
      await screen.findByRole('textbox', { name: 'message #lobby' });
      backToDms();
      const added = vi.spyOn(window, 'addEventListener');
      const removed = vi.spyOn(window, 'removeEventListener');
      const popstate = (spy: typeof added) => spy.mock.calls.filter(c => c[0] === 'popstate').length;
      await user.click(tab('servers'));
      const afterFirst = { added: popstate(added), removed: popstate(removed) };
      expect(afterFirst.added).toBeGreaterThan(0);
      await user.click(tab('servers'));
      // The second tap adds its own listener and first removes the one the first tap left.
      expect(popstate(added)).toBeGreaterThan(afterFirst.added);
      expect(popstate(removed)).toBeGreaterThan(afterFirst.removed);
      const beforeUnmount = popstate(removed);
      view.unmount();
      expect(popstate(removed)).toBeGreaterThan(beforeUnmount);
    });
  });

  it('a DM opened from the servers list: the DMs tab lands on /dm', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await screen.findByRole('navigation', { name: t('shell.channels.label') });
    goto(`/dm/${DM}`, { phoneBack: true, phoneFrom: `/c/${A}` });
    await screen.findByRole('textbox');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await user.click(tab('DMs'));
    expect(back).not.toHaveBeenCalled();
    expect(here()).toBe('/dm');
  });

  it('opens an unvisited tab at its root', async () => {
    const { user } = phone({ path: '/you' });
    await screen.findByRole('heading', { level: 1, name: t('you.title') });
    await user.click(tab('servers'));
    expect(here()).toBe(`/c/${A}`);
  });
});

describe('the phone shell: history', () => {
  it('replaces the entry on every tab tap, so the history never grows', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await screen.findByRole('navigation', { name: t('shell.channels.label') });
    const before = window.history.length;
    await user.click(tab('DMs'));
    await user.click(tab('activity'));
    await user.click(tab('you'));
    await user.click(tab('servers'));
    expect(window.history.length).toBe(before);
    expect(window.history.state).toBeNull();
  });

  it('goes back to the list from a view a tab restored', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await user.click(await screen.findByRole('button', { name: 'lobby' }));
    goto('/activity', { phoneBack: true });
    await screen.findByText(t('activity.empty'));
    await user.click(tab('servers'));
    expect(here()).toBe(`/c/${A}/${TEXT}`);
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: t('nav.back') }));
    expect(back).not.toHaveBeenCalled();
    expect(here()).toBe(`/c/${A}`);
  });

  it('puts focus on the row that opened the view when back returns to the list', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await user.click(await screen.findByRole('button', { name: 'lobby' }));
    await screen.findByRole('log');
    goto(`/c/${A}`, { phoneBack: true });
    await screen.findByRole('button', { name: 'lobby' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'lobby' })).toHaveFocus());
  });

  it('focuses the exact row it left when another name starts with it', async () => {
    const { user, client } = phone({ path: `/c/${A}` });
    const more = ['general', 'gen'].map((name, i) => ({ id: `${i}f`.repeat(16), communityId: A, kind: 0 as const, mode: 0 as const, name,
      topic: '', parentId: null, position: 5 + i, group: 'active' as const, slowmode: 0, announcement: false }));
    act(() => client.set(`channels:${A}`, [...CHANNELS, ...more]));
    await user.click(await screen.findByRole('button', { name: 'gen' }));
    await screen.findByRole('log');
    goto(`/c/${A}`, { phoneBack: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'gen' })).toHaveFocus());
  });

  it('closes Settings with Escape the way the header back does, with no duplicate entry', async () => {
    window.history.replaceState({ settingsFrom: null }, '', '/settings/devices');
    const { user } = phone({ path: '/settings/devices', withSettings: true });
    await waitFor(() => expect(document.querySelector('.d-phone-header')).not.toBeNull());
    const before = window.history.length;
    await user.keyboard('{Escape}');
    expect(here()).toBe('/you');
    expect(window.history.length).toBe(before);
  });

  it('shows no link banner for a version refusal, only the newer-client banner', async () => {
    const { client } = phone({ path: `/c/${A}` });
    await screen.findByRole('navigation', { name: t('shell.channels.label') });
    act(() => client.set('connection', { status: 'offline', generation: '1', reason: 'version' }));
    expect(screen.getByText(t('shell.banner.clientTooOld'))).toBeInTheDocument();
    expect(document.querySelector('.d-link-banner')).toBeNull();
    expect(screen.queryByText(t('nav.link.offline'))).toBeNull();
  });
});

describe('the phone shell: the call bar', () => {
  /** Joins voice 'general' from its stage, as the shell does; the call bar follows the person off the stage. */
  async function joined() {
    const app = phone({ path: `/c/${A}/${GENV}` });
    await app.user.click(await screen.findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
    return app;
  }

  it('shows a call bar on the list, with no dock, and its open button pushes the call', async () => {
    const { user } = await joined();
    expect(screen.queryByRole('group', { name: t('voice.dock.region') })).toBeNull();
    goto(`/c/${A}`);
    const open = await screen.findByRole('button', { name: t('nav.call.open', { where: 'general' }) });
    expect(screen.getByRole('group', { name: t('voice.dock.region') })).toBeInTheDocument();
    expect(document.querySelector('.dw-voice-dock')).toBeNull();
    await user.click(open);
    expect(here()).toBe(`/c/${A}/${GENV}`);
    expect(window.history.state).toMatchObject({ phoneBack: true });
    await screen.findByRole('toolbar', { name: 'voice channel controls' });
    expect(screen.queryByRole('group', { name: t('voice.dock.region') })).toBeNull();
  });

  it('keeps the call bar on another view, and mutes and leaves from it', async () => {
    const app = await joined();
    goto(`/c/${A}/${TEXT}`);
    const bar = await screen.findByRole('group', { name: t('voice.dock.region') });
    await app.user.click(within(bar).getByRole('button', { name: t('voice.mute') }));
    expect(app.session.muted).toBe(true);
    await app.user.click(within(bar).getByRole('button', { name: t('voice.leave') }));
    await waitFor(() => expect(app.session.leave).toHaveBeenCalledWith('user'));
  });
});

describe('the phone shell: settings', () => {
  it('opens from You as a pushed view of the You tab, with a header and the tab bar under it', async () => {
    const { user } = phone({ path: '/you', withSettings: true });
    await user.click(await screen.findByRole('button', { name: t('settings.nav.devices') }));
    expect(here()).toBe('/settings/devices');
    expect(window.history.state).toMatchObject({ phoneBack: true, settingsFrom: '/you' });
    const header = document.querySelector('.d-phone-header') as HTMLElement;
    expect(within(header).getByRole('heading', { level: 2 })).toHaveTextContent(t('settings.nav.devices'));
    expect(within(header).getByRole('button', { name: t('nav.back') })).toBeInTheDocument();
    expect(tabs()).not.toBeNull();
    expect(screen.queryByRole('navigation', { name: t('settings.nav.label') })).toBeNull();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await user.click(within(header).getByRole('button', { name: t('nav.back') }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('keeps the tab bar under Settings, and a tab leaves Settings', async () => {
    window.history.replaceState({ settingsFrom: null }, '', '/settings/devices');
    const { user } = phone({ path: '/settings/devices', withSettings: true });
    await waitFor(() => expect(document.querySelector('.d-phone-header')).not.toBeNull());
    expect(tabs()).not.toBeNull();
    expect(screen.getByRole('dialog', { name: t('settings.title') })).not.toHaveAttribute('aria-modal');
    await user.click(tab('servers'));
    expect(here()).toBe(`/c/${A}`);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('settings.title') })).toBeNull());
  });

  it('puts Settings inside the shell, in tab order: its title, then its controls, then the tab bar', async () => {
    window.history.replaceState({ settingsFrom: null }, '', '/settings/devices');
    const { user } = phone({ path: '/settings/devices', withSettings: true });
    const header = await waitFor(() => { const h = document.querySelector<HTMLElement>('.d-phone-header'); expect(h).not.toBeNull(); return h!; });
    const dialog = screen.getByRole('dialog', { name: t('settings.title') });
    expect(dialog.closest('.d-app-shell__page')).not.toBeNull();
    const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const title = within(header).getByRole('heading', { level: 2 });
    const back = within(header).getByRole('button', { name: t('nav.back') });
    expect(follows(title, back) || follows(back, title)).toBe(true);
    expect(follows(dialog, tabs()!)).toBe(true);
    // Walk the real Tab order from the top: every stop in the page comes before the first stop in the tab bar.
    const where: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      await user.tab();
      const el = document.activeElement;
      where.push(el !== null && dialog.contains(el) ? 'page' : el !== null && tabs()!.contains(el) ? 'tabs' : 'other');
    }
    expect(where).toContain('page');
    expect(where).toContain('tabs');
    expect(where.indexOf('tabs')).toBeGreaterThan(where.lastIndexOf('page', where.indexOf('tabs')));
    expect(where.slice(0, where.indexOf('tabs')).every(w => w !== 'other')).toBe(true);
  });

  it('makes the shell behind a phone Settings inert, except the tab bar', async () => {
    window.history.replaceState({ settingsFrom: null }, '', '/settings/devices');
    phone({ path: '/settings/devices', withSettings: true });
    await waitFor(() => expect(document.querySelector('.d-phone-header')).not.toBeNull());
    expect(document.querySelector('main')).toHaveAttribute('inert');
    expect(tabs()!.closest('.d-app-shell__tabbar')).not.toHaveAttribute('inert');
    expect(tabs()!.closest('[inert]')).toBeNull();
  });

  it('replaces a deep-linked settings route with You on back', async () => {
    window.history.replaceState({ settingsFrom: null }, '', '/settings/devices');
    const { user } = phone({ path: '/settings/devices', withSettings: true });
    const header = await waitFor(() => { const h = document.querySelector<HTMLElement>('.d-phone-header'); expect(h).not.toBeNull(); return h!; });
    await user.click(within(header).getByRole('button', { name: t('nav.back') }));
    expect(here()).toBe('/you');
  });
});

describe('the desktop keeps its shell', () => {
  it('turns /you into Settings → devices and /activity into the server list', async () => {
    media(false);
    renderVoiceShell({ path: '/you', withSettings: true });
    await waitFor(() => expect(here()).toBe('/settings/devices'));
    expect(window.history.state).toMatchObject({ settingsFrom: null });
  });

  it('leaves /activity for the first server', async () => {
    media(false);
    renderVoiceShell({ path: '/activity' });
    await waitFor(() => expect(here()).toBe(`/c/${A}/${TEXT}`));
  });

  it('shows the DMs tab on /dm with no DM open', async () => {
    media(false);
    renderVoiceShell({ path: '/dm' });
    expect(await screen.findByRole('tab', { name: 'direct messages' })).toHaveAttribute('aria-selected', 'true');
    expect(here()).toBe('/dm');
    expect(screen.queryByRole('navigation', { name: t('nav.tabs.label') })).toBeNull();
  });

  it('renders no phone chrome', async () => {
    media(false);
    renderVoiceShell({ path: `/c/${A}/${TEXT}` });
    await screen.findByRole('log');
    expect(document.querySelector('[data-layout="phone"]')).toBeNull();
    expect(screen.queryByRole('region', { name: t('shell.status.label') })).toBeNull();
    expect(document.querySelector('.d-link-banner')).toHaveAttribute('role', 'status');
    expect(document.querySelector('.d-link-banner')).toBeEmptyDOMElement();
  });
});

describe('the phone shell: one channel list (web3.8 item 12)', () => {
  it('lists the voice channels in the one list on the servers tab, with no active voice', async () => {
    phone({ path: `/c/${A}` });
    const nav = await screen.findByRole('navigation', { name: t('shell.channels.label') });
    expect(within(nav).getByRole('button', { name: 'voice general' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: /^lobby/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'active voice' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'voice' })).toBeNull();
    expect(document.querySelector('.d-active-voice, .dw-voice-section')).toBeNull();
    expect(nav.querySelectorAll('ul[role="list"]:not(.d-voice-row__people)').length).toBe(1);
  });
});
