import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRowMenu } from '../test/row-menu.ts';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PHONE_QUERY } from '../layout.ts';
import { t } from '../strings/index.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import { A, callState, CHANNELS, DM, GENV, MUSIC, renderVoiceShell, TEXT, type VoiceHarnessOptions } from '../test/fake-client.ts';
import { pushHistoryState, replaceHistoryState } from '../router.ts';

/** A window of the given kind: only the phone query matches, so the wide-window defaults (the members column) stay off. */
function media(phone: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: phone && query === PHONE_QUERY, media: query,
    addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}
afterEach(() => {
  cleanup();
  replaceHistoryState(null, '', '/');
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
const homeTile = () => within(screen.getByRole('navigation', { name: t('shell.rail.label') })).getByRole('button', { name: t('home.tile') });
const goto = (path: string, state: unknown = null) => {
  act(() => pushHistoryState(state, '', path));
};
const here = () => window.location.pathname;
const manage = (fake: ReturnType<typeof renderVoiceShell>['client']) =>
  act(() => { fake.publish(`permissions:${A}`, { loaded: true, manageChannels: true } as never); });

describe('the phone shell: the servers list', () => {
  it('shows the tab bar, stays on the server (no first-channel redirect) and has no status bar or sidebar tabs, and exactly three tabs', async () => {
    phone({ path: `/c/${A}` });
    await screen.findByRole('navigation', { name: t('shell.channels.label') });
    expect(within(tabs()!).getAllByRole('link').map(l => l.textContent)).toEqual(['home', 'activity', 'you']);
    expect(tab('home')).toHaveAttribute('aria-current', 'page');
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
    expect(within(head).getAllByRole('button')).toEqual([search, gear, screen.getByRole('button', { name: 'Reminders' })]);
    expect(gear.querySelector('svg[data-icon="settings"]')).not.toBeNull();
    expect(search.querySelector('svg[data-icon="search"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: t('nav.server.menu') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('admin.leave.open') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('create.channel.open') })).toBeNull();
    manage(client);
    expect(screen.getByRole('button', { name: t('create.channel.open') })).toBeInTheDocument();
    await user.click(gear);
    const dialog = await screen.findByRole('dialog', { name: t('admin.title') });
    expect(within(dialog).getByRole('button', { name: t('workspace.danger') })).toBeInTheDocument();
  });

  it('has one "+" tile on the rail and no captions; it opens the add dialog', async () => {
    const { user } = phone({ path: `/c/${A}` });
    const rail = await screen.findByRole('navigation', { name: t('shell.rail.label') });
    expect(within(rail).queryByText(t('create.rail.join'))).toBeNull();
    expect(within(rail).queryByText(t('create.rail.new'))).toBeNull();
    await user.click(within(rail).getByRole('button', { name: t('layout.rail.add') }));
    const dialog = await screen.findByRole('dialog', { name: t('layout.add.title') });
    expect(within(dialog).getByRole('button', { name: t('layout.add.join') })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: t('layout.add.create') })).toBeInTheDocument();
  });

  it('a tap on a voice row only opens it; the join icon joins', async () => {
    const app = phone({ path: `/c/${A}` });
    await app.user.click(await screen.findByRole('button', { name: 'voice general' }));
    await waitFor(() => expect(here()).toBe(`/c/${A}/${GENV}`));
    expect(app.log).not.toContain(`callJoin:${GENV}`);
    goto(`/c/${A}`);
    const row = (await screen.findByRole('button', { name: 'voice music' })).closest('li') as HTMLElement;
    await app.user.click(within(row).getByRole('button', { name: t('voice.join') }));
    await waitFor(() => expect(app.log).toContain(`callJoin:${MUSIC}`));
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

  it('opens it from the channel header\'s search (Signal §5.10, Ruling U), scoped to the conversation', async () => {
    const { user, client } = phone({ path: `/c/${A}/${TEXT}` });
    const header = (await screen.findByRole('heading', { level: 2, name: 'lobby' })).closest('.d-phone-header') as HTMLElement;
    await user.click(within(header).getByRole('button', { name: t('search.open') }));
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

  it('has exactly Threads, Members and search in the header, no menu (Ruling X)', async () => {
    phone({ path: `/c/${A}/${TEXT}` });
    const header = (await screen.findByRole('heading', { level: 2, name: 'lobby' })).closest('.d-phone-header') as HTMLElement;
    const actions = header.querySelector<HTMLElement>('.d-phone-header__actions')!;
    expect(within(actions).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual([t('layout.header.threads'), expect.stringMatching(/^Members/), t('search.open')]);
    expect(within(header).queryByRole('button', { name: t('nav.channel.menu') })).toBeNull();
  });

  it('a channel row\'s context menu on the list holds pins, and edit channel for a person who may (Ruling X)', async () => {
    const { user, client } = phone({ path: `/c/${A}` });
    let menu = await openRowMenu(user, 'lobby');
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual([t('shell.pins.open')]);
    await user.keyboard('{Escape}');
    manage(client);
    menu = await openRowMenu(user, 'lobby');
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual([t('shell.pins.open'), t('admin.channel.open')]);
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

  it('the voice stage header has a search that opens search over every conversation', async () => {
    const { user, client } = phone({ path: `/c/${A}/${GENV}` });
    const header = (await screen.findByRole('heading', { level: 2, name: 'general' })).closest('.d-phone-header') as HTMLElement;
    await user.click(within(header).getByRole('button', { name: t('search.open') }));
    await user.type(screen.getByRole('combobox', { name: t('search.placeholder') }), 'lamp');
    await waitFor(() => expect(client.callsOf('search')).toContainEqual({ m: 'search', scope: 'all', id: null, query: 'lamp', cursor: null }));
  });

  it('gives the voice stage a phone header with its name and a back, under the tab bar', async () => {
    phone({ path: `/c/${A}/${GENV}` });
    expect(await screen.findByRole('heading', { level: 2, name: 'general' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('nav.back') })).toBeInTheDocument();
    expect(tabs()).not.toBeNull();
  });
});

describe('the phone shell: the members sheet', () => {
  it('opens as a history entry, closes on the system back and returns focus to the Members button', async () => {
    const { user } = phone({ path: `/c/${A}/${TEXT}` });
    const trigger = await screen.findByRole('button', { name: /^Members/ });
    await user.click(trigger);
    expect(await screen.findByRole('complementary', { name: 'members of Midgard' })).toBeInTheDocument();
    expect(window.history.state).toMatchObject({ phoneSheet: 'members' });
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('closes through its own back control by popping its entry', async () => {
    const { user } = phone({ path: `/c/${A}/${TEXT}` });
    await user.click(await screen.findByRole('button', { name: /^Members/ }));
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
  it('@ shows the DMs on Home; activity and you show each screen without a rail', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await screen.findByRole('navigation', { name: t('shell.channels.label') });
    expect(screen.getByRole('navigation', { name: t('shell.rail.label') })).toBeInTheDocument();
    // Home shows the rail and the list pane; the @ tile shows the DMs in the list pane, still on Home.
    await user.click(homeTile());
    expect(here()).toBe('/dm');
    expect(await screen.findByRole('button', { name: 'bob' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: t('shell.rail.label') })).toBeInTheDocument();
    expect(homeTile()).toHaveAttribute('aria-current', 'page');
    expect(tab('home')).toHaveAttribute('aria-current', 'page');
    await user.click(tab('activity'));
    expect(here()).toBe('/activity');
    expect(await screen.findByText(t('activity.emptyTitle'))).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: t('shell.rail.label') })).toBeNull();
    await user.click(tab('you'));
    expect(here()).toBe('/you');
    expect(await screen.findByRole('heading', { level: 2, name: t('you.title') })).toBeInTheDocument();
  });

  it('counts DMs unread on Home, and activity as channel mentions plus DM unread', async () => {
    const { client } = phone({ path: '/dm' });
    await screen.findByRole('button', { name: 'bob' });
    act(() => client.set('badges', { [TEXT]: { unread: 5, mentions: 2 }, [DM]: { unread: 3, mentions: 0 } }));
    expect(tab(t('nav.tab.unread', { name: 'home', count: 3 }))).toBeInTheDocument();
    expect(tab(t('nav.tab.unread', { name: 'activity', count: 5 }))).toBeInTheDocument();
  });

  it('opens a tab where it was left', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await user.click(await screen.findByRole('button', { name: 'lobby' }));
    expect(here()).toBe(`/c/${A}/${TEXT}`);
    goto('/activity', { phoneBack: true });
    await screen.findByText(t('activity.emptyTitle'));
    await user.click(tab('home'));
    expect(here()).toBe(`/c/${A}/${TEXT}`);
  });

  it('keeps the tab bar in a channel; the current tab goes back to its list', async () => {
    const { user } = phone({ path: `/c/${A}/${TEXT}` });
    await screen.findByRole('main');
    expect(tabs()).not.toBeNull();
    expect(tab('home')).toHaveAttribute('aria-current', 'page');
    await user.click(tab('home'));
    expect(here()).toBe(`/c/${A}`);
    expect(await screen.findByRole('navigation', { name: t('shell.channels.label') })).toBeInTheDocument();
  });

  it('Home opens where it was left: a DM, then a channel', async () => {
    const { user } = phone({ path: `/dm/${DM}` });
    await screen.findByRole('main');
    goto('/activity', { phoneBack: true });
    await screen.findByText(t('activity.emptyTitle'));
    await user.click(tab('home'));
    expect(here()).toBe(`/dm/${DM}`);
    goto(`/c/${A}/${TEXT}`, { phoneBack: true });
    goto('/activity', { phoneBack: true });
    await user.click(tab('home'));
    expect(here()).toBe(`/c/${A}/${TEXT}`);
  });

  it('an open members sheet closes when a tab is tapped: its entry is popped once and the new tab shows', async () => {
    const { user } = phone({ path: `/c/${A}/${TEXT}` });
    await user.click(await screen.findByRole('button', { name: /^Members/ }));
    await screen.findByRole('complementary', { name: 'members of Midgard' });
    expect(tabs()).not.toBeNull();
    const length = window.history.length;
    const back = vi.spyOn(window.history, 'back');
    await user.click(tab('activity'));
    await waitFor(() => expect(here()).toBe('/activity'));
    expect(back).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(await screen.findByText(t('activity.emptyTitle'))).toBeInTheDocument();
    expect(window.history.length).toBe(length);
    expect((window.history.state as { phoneSheet?: unknown } | null)?.phoneSheet).toBeUndefined();
  });

  it('hides the tab bar while server settings is open', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await user.click(await screen.findByRole('button', { name: t('admin.open') }));
    expect(await screen.findByRole('dialog', { name: t('admin.title') })).toBeInTheDocument();
    expect(tabs()).toBeNull();
    expect(here()).toBe(`/c/${A}/settings`);
  });

  it('two quick taps on a tab with a sheet open pop the sheet entry once', async () => {
    phone({ path: `/c/${A}/${TEXT}` });
    const { user } = { user: (await import('@testing-library/user-event')).default.setup() };
    await user.click(await screen.findByRole('button', { name: /^Members/ }));
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
    await user.click(tab('home'));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('the current tab lands on its own list, never on the screen the view was pushed from', async () => {
    const { user } = phone({ path: '/activity' });
    await screen.findByRole('heading', { name: t('activity.title') });
    goto(`/c/${A}/${TEXT}`, { phoneBack: true, phoneFrom: '/activity' });
    await screen.findByRole('textbox', { name: 'message #lobby' });
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await user.click(tab('home'));
    expect(back).not.toHaveBeenCalled();
    expect(here()).toBe(`/c/${A}`);
  });

  describe('the system forward button (N5, R-c)', () => {
    it('lands the current tab on its own list when back would land on another view', async () => {
      const { user } = phone({ path: '/dm' });
      await screen.findByRole('navigation', { name: t('shell.dms.label') });
      goto(`/c/${A}/${TEXT}`, { phoneBack: true, phoneFrom: `/c/${A}` });
      await screen.findByRole('textbox', { name: 'message #lobby' });
      const originalBack = window.history.back.bind(window.history);
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => originalBack());
      await user.click(tab('home'));
      expect(back).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(here()).toBe(`/c/${A}`));
    });

    it('control: back that lands on the tab list is left alone', async () => {
      const { user } = phone({ path: `/c/${A}` });
      await screen.findByRole('navigation', { name: t('shell.channels.label') });
      goto(`/c/${A}/${TEXT}`, { phoneBack: true, phoneFrom: `/c/${A}` });
      await screen.findByRole('textbox', { name: 'message #lobby' });
      const originalBack = window.history.back.bind(window.history);
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => originalBack());
      await user.click(tab('home'));
      expect(back).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(here()).toBe(`/c/${A}`));
    });

    it('two quick Home taps from a forward entry land on the Home list', async () => {
      const { user } = phone({ path: '/dm' });
      await screen.findByRole('navigation', { name: t('shell.dms.label') });
      goto(`/c/${A}/${TEXT}`, { phoneBack: true, phoneFrom: `/c/${A}` });
      await screen.findByRole('textbox', { name: 'message #lobby' });
      await user.click(tab('home'));
      await user.click(tab('home'));
      await waitFor(() => expect(here()).toBe(`/c/${A}`));
    });
  });

  it('a DM opened from the server list: the current Home tab goes back to that list', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await screen.findByRole('navigation', { name: t('shell.channels.label') });
    goto(`/dm/${DM}`, { phoneBack: true, phoneFrom: `/c/${A}` });
    await screen.findByRole('textbox');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await user.click(tab('home'));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('a deep-linked DM: the current Home tab lands on the DM list, never on a server', async () => {
    const { user } = phone({ path: `/dm/${DM}` });
    await screen.findByRole('textbox');
    await user.click(tab('home'));
    expect(here()).toBe('/dm');
    expect(await screen.findByRole('button', { name: 'bob' })).toBeInTheDocument();
  });

  it('a DM opened from the @ list: the current Home tab goes back to /dm', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await user.click(homeTile());
    await user.click(await screen.findByRole('button', { name: 'bob' }));
    expect(here()).toBe(`/dm/${DM}`);
    await screen.findByRole('textbox');
    await user.click(tab('home'));
    await waitFor(() => expect(here()).toBe('/dm'));
  });

  it('opens an unvisited tab at its root', async () => {
    const { user } = phone({ path: '/you' });
    await screen.findByRole('heading', { level: 2, name: t('you.title') });
    await user.click(tab('home'));
    expect(here()).toBe(`/c/${A}`);
  });
});

describe('the phone shell: history', () => {
  it('replaces the entry on every tab tap, so the history never grows', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await screen.findByRole('navigation', { name: t('shell.channels.label') });
    const before = window.history.length;
    await user.click(tab('activity'));
    await user.click(tab('you'));
    await user.click(tab('home'));
    expect(window.history.length).toBe(before);
    const state = window.history.state as { dillaHistoryIndex?: unknown };
    expect(Number.isSafeInteger(state.dillaHistoryIndex)).toBe(true);
  });

  it('goes back to the list from a view a tab restored', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await user.click(await screen.findByRole('button', { name: 'lobby' }));
    goto('/activity', { phoneBack: true });
    await screen.findByText(t('activity.emptyTitle'));
    await user.click(tab('home'));
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

  it('closes a direct Settings link with Escape without adding history', async () => {
    const { user } = phone({ path: '/settings/devices', withSettings: true });
    await screen.findByRole('dialog', { name: t('settings.title') });
    const before = window.history.length;
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('settings.title') })).toBeNull());
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
  it('opens a modal index from You, hides tabs, and pushes individual sections', async () => {
    const { user } = phone({ path: '/you', withSettings: true });
    await user.click(await screen.findByRole('button', { name: t('workspace.open') }));
    expect(here()).toBe('/settings');
    const dialog = screen.getByRole('dialog', { name: t('settings.title') });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(tabs()).toBeNull();
    const before = history.length;
    await user.click(within(dialog).getByRole('button', { name: 'Devices' }));
    expect(here()).toBe('/settings/devices');
    expect(history.length).toBe(before + 1);
    expect(history.state).toMatchObject({ settingsFrom: '/you' });
    await user.click(within(dialog).getByRole('button', { name: t('workspace.back') }));
    await waitFor(() => expect(here()).toBe('/settings'));
    const settingsDialog = screen.getByRole('dialog', { name: t('settings.title') });
    await within(settingsDialog).findByRole('button', { name: t('settings.close') });
    await user.click(within(settingsDialog).getByRole('button', { name: t('settings.close') }));
    await waitFor(() => expect(here()).toBe('/you'));
  });
  it('direct section links return to the settings index', async () => {
    const { user } = phone({ path: '/settings/devices', withSettings: true });
    await screen.findByRole('dialog', { name: t('settings.title') });
    const dialog = screen.getByRole('dialog', { name: t('settings.title') });
    await user.click(within(dialog).getByRole('button', { name: t('workspace.back') }));
    await waitFor(() => expect(here()).toBe('/settings'));
    const indexDialog = screen.getByRole('dialog', { name: t('settings.title') });
    await within(indexDialog).findByRole('navigation', { name: t('settings.nav.label') });
    expect(within(indexDialog).getByRole('navigation', { name: t('settings.nav.label') })).toBeVisible();
    expect(tabs()).toBeNull();
  });
  it('keeps the voice session running when settings opens and returns to the call', async () => {
    const app = phone({ path: `/c/${A}/${GENV}` });
    await app.user.click(await screen.findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    act(() => app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV })));
    goto('/settings', { settingsFrom: `/c/${A}/${GENV}` });
    const dialog = await screen.findByRole('dialog', { name: t('settings.title') });
    expect(app.session.leave).not.toHaveBeenCalled();
    await app.user.click(within(dialog).getByRole('button', { name: t('workspace.returnCall') }));
    await waitFor(() => expect(here()).toBe(`/c/${A}/${GENV}`));
    expect(app.sessions).toHaveLength(1);
    expect(app.session.leave).not.toHaveBeenCalled();
  });
});

describe('the phone shell: one header on every tab root (H1, H2, H3)', () => {
  it('Home on a server: the server name in the 48 head, with search, settings and, for a manager, the "+"', async () => {
    const { client } = phone({ path: `/c/${A}` });
    const gear = await screen.findByRole('button', { name: t('admin.open') });
    const head = gear.closest('.d-channel-list__head') as HTMLElement;
    expect(within(head).getByRole('heading', { level: 1 })).toHaveTextContent('Midgard');
    manage(client);
    expect(within(head).getByRole('button', { name: t('create.channel.open') })).toBeInTheDocument();
  });

  it('Home on @: "direct messages" in the head with the new-message action, and no footer', async () => {
    const { user } = phone({ path: '/dm' });
    const head = (await screen.findByRole('heading', { level: 1, name: t('shell.dms.label') })).closest('.d-channel-list__head') as HTMLElement;
    expect(head).not.toBeNull();
    const add = within(head).getByRole('button', { name: t('shell.dms.new') });
    expect(add.querySelector('svg[data-icon="square-pen"]')).not.toBeNull();
    expect(document.querySelector('.dw-phone-footer')).toBeNull();
    expect(screen.getAllByRole('button', { name: t('shell.dms.new') })).toHaveLength(1);
    await user.click(add);
    expect(await screen.findByRole('dialog', { name: t('shell.dms.newTitle') })).toBeInTheDocument();
  });

  it('Home on @ has a search in its head that opens search over every conversation', async () => {
    const { user, client } = phone({ path: '/dm' });
    const head = (await screen.findByRole('heading', { level: 1, name: t('shell.dms.label') })).closest('.d-channel-list__head') as HTMLElement;
    await user.click(within(head).getByRole('button', { name: t('search.open') }));
    await user.type(screen.getByRole('combobox', { name: t('search.placeholder') }), 'lamp');
    await waitFor(() => expect(client.callsOf('search')).toContainEqual({ m: 'search', scope: 'all', id: null, query: 'lamp', cursor: null }));
  });

  it('Activity and You each open with a phone header holding their title', async () => {
    const { user } = phone({ path: '/activity' });
    for (const title of [t('activity.title'), t('you.title')]) {
      const heading = await screen.findByRole('heading', { level: 2, name: title });
      expect(heading.closest('header')).toHaveClass('d-phone-header');
      if (title === t('activity.title')) await user.click(tab('you'));
    }
  });

  it('a DM view puts its call in the header, and the strip keeps no second button', async () => {
    const { user, sessions } = phone({ path: `/dm/${DM}` });
    const call = await screen.findByRole('button', { name: t('call.start') });
    expect(call.closest('.d-phone-header')).not.toBeNull();
    expect(call.querySelector('svg[data-icon="phone"]')).not.toBeNull();
    expect(screen.getAllByRole('button', { name: t('call.start') })).toHaveLength(1);
    // Nothing to say in the strip: it is empty and collapsed (data-empty), so no second hairline sits under the 48 bar.
    expect(document.querySelector('.dw-call-strip')).toHaveAttribute('data-empty', 'true');
    await user.click(call);
    await waitFor(() => expect(sessions).toHaveLength(1));
  });

  describe('while typing', () => {
    async function inCall() {
      const app = phone({ path: `/c/${A}/${GENV}` });
      await app.user.click(await screen.findByRole('button', { name: 'join voice' }));
      await waitFor(() => expect(app.sessions).toHaveLength(1));
      app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
      goto(`/c/${A}/${TEXT}`);
      await screen.findByRole('group', { name: t('voice.dock.region') });
      return app;
    }
    it('drops the call bar and shows an accent dot after the title, named by the bar\'s own label', async () => {
      await inCall();
      const label = t('nav.call.open', { where: 'general' });
      const header = () => document.querySelector('.d-app-shell__main .d-phone-header') as HTMLElement;
      expect(within(header()).queryByRole('button', { name: label })).toBeNull();
      act(() => { screen.getByRole('textbox', { name: /message/ }).focus(); });
      await waitFor(() => expect(screen.queryByRole('group', { name: t('voice.dock.region') })).toBeNull());
      expect(within(header()).getByRole('button', { name: label })).toHaveClass('d-phone-header__dot');
      act(() => { (document.activeElement as HTMLElement).blur(); });
      await screen.findByRole('group', { name: t('voice.dock.region') });
      expect(within(header()).queryByRole('button', { name: label })).toBeNull();
    });
    it('the dot is a button that opens the call, as the bar does', async () => {
      const app = await inCall();
      act(() => { screen.getByRole('textbox', { name: /message/ }).focus(); });
      const header = document.querySelector('.d-app-shell__main .d-phone-header') as HTMLElement;
      await app.user.click(await within(header).findByRole('button', { name: t('nav.call.open', { where: 'general' }) }));
      expect(here()).toBe(`/c/${A}/${GENV}`);
    });
    it('shows no dot when no call is up', () => {
      phone({ path: `/c/${A}/${TEXT}` });
      act(() => { screen.getByRole('textbox', { name: /message/ }).focus(); });
      expect(document.querySelector('.d-phone-header__dot')).toBeNull();
    });
  });
});

describe('the desktop keeps its shell', () => {
  it('turns /you into the Settings root and /activity into the server list', async () => {
    media(false);
    renderVoiceShell({ path: '/you', withSettings: true });
    await waitFor(() => expect(here()).toBe('/settings'));
    expect(window.history.state).toMatchObject({ settingsFrom: null });
  });

  it('leaves /activity for the first server', async () => {
    media(false);
    renderVoiceShell({ path: '/activity' });
    await waitFor(() => expect(here()).toBe(`/c/${A}/${TEXT}`));
  });

  it('selects the @ tile on /dm with no DM open, and shows the DM list', async () => {
    media(false);
    renderVoiceShell({ path: '/dm' });
    expect(await screen.findByRole('button', { name: t('home.tile') })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('navigation', { name: t('shell.dms.label') })).toBeInTheDocument();
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

describe('web3.9 WEB-AFK: a phone is exempt from the AFK move (R5)', () => {
  it('the first activity report after a join carries exempt, the second does not', async () => {
    const app = phone({ path: `/c/${A}/${GENV}` });
    act(() => app.client.publish(`afk:${A}`, { channelId: MUSIC, timeoutSeconds: 300, pending: false }));
    await app.user.click(await within(screen.getByRole('main')).findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    act(() => app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV })));
    await waitFor(() => expect(app.client.callsOf('afkActivity')).toHaveLength(1));
    expect(app.client.callsOf('afkActivity')[0]).toEqual({ m: 'afkActivity', communityId: A, channelId: GENV, exempt: true });
    const now = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now + 6_000);
    act(() => { window.dispatchEvent(new Event('pointerdown')); });
    await waitFor(() => expect(app.client.callsOf('afkActivity')).toHaveLength(2));
    expect(app.client.callsOf('afkActivity')[1]).toEqual({ m: 'afkActivity', communityId: A, channelId: GENV });
    dateNow.mockRestore();
  });

  it('final review M-1: a failed exempt report is retried after a backoff until it is accepted', async () => {
    const app = phone({ path: `/c/${A}/${GENV}` });
    let failures = 1;
    const base = app.client.handler;
    app.client.handler = command => command.m === 'afkActivity' && failures-- > 0
      ? Promise.reject(Object.assign(new Error('E_UNAVAILABLE'), { code: 'E_UNAVAILABLE' })) : base(command);
    act(() => app.client.publish(`afk:${A}`, { channelId: MUSIC, timeoutSeconds: 300, pending: false }));
    await app.user.click(await within(screen.getByRole('main')).findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    act(() => app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV })));
    await waitFor(() => expect(app.client.callsOf('afkActivity')).toHaveLength(1));
    await waitFor(() => expect(app.client.callsOf('afkActivity')).toHaveLength(2), { timeout: 3_000 });
    expect(app.client.callsOf('afkActivity')[1]).toEqual({ m: 'afkActivity', communityId: A, channelId: GENV, exempt: true });
    // Accepted: no further retry.
    await new Promise(r => setTimeout(r, 2_500));
    expect(app.client.callsOf('afkActivity')).toHaveLength(2);
  }, 10_000);
});

/** A desktop window whose one media fact is the pointer: coarse (a touch tablet) or fine (a mouse). */
function pointer(coarse: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: coarse && query === '(pointer: coarse)', media: query,
    addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

describe('search on a touch tablet, focus return and a server that did not load (E2 review)', () => {
  it('a fine pointer keeps the desktop server head to the gear alone', async () => {
    pointer(false);
    renderVoiceShell({ path: `/c/${A}` });
    const gear = await screen.findByRole('button', { name: t('admin.open') });
    const head = gear.closest('.d-channel-list__head') as HTMLElement;
    expect(within(head).getAllByRole('button')).toEqual([gear]);
  });

  it('a coarse pointer adds search beside the gear, and it opens search over every conversation', async () => {
    pointer(true);
    const { user, client } = renderVoiceShell({ path: `/c/${A}` });
    const gear = await screen.findByRole('button', { name: t('admin.open') });
    const head = gear.closest('.d-channel-list__head') as HTMLElement;
    await user.click(within(head).getByRole('button', { name: t('search.open') }));
    await user.type(screen.getByRole('combobox', { name: t('search.placeholder') }), 'lamp');
    await waitFor(() => expect(client.callsOf('search')).toContainEqual({ m: 'search', scope: 'all', id: null, query: 'lamp', cursor: null }));
  });

  it('closing the palette from a coarse-pointer server head focuses the button, though a click did not move focus', async () => {
    pointer(true);
    const { user } = renderVoiceShell({ path: `/c/${A}` });
    const gear = await screen.findByRole('button', { name: t('admin.open') });
    const search = within(gear.closest('.d-channel-list__head') as HTMLElement).getByRole('button', { name: t('search.open') });
    fireEvent.click(search);
    await screen.findByRole('dialog', { name: t('search.placeholder') });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(search).toHaveFocus());
  });

  it('closing the palette from the phone Home head focuses the search button, though a click did not move focus', async () => {
    const { user } = phone({ path: '/dm' });
    const head = (await screen.findByRole('heading', { level: 1, name: t('shell.dms.label') })).closest('.d-channel-list__head') as HTMLElement;
    const search = within(head).getByRole('button', { name: t('search.open') });
    fireEvent.click(search);
    await screen.findByRole('dialog', { name: t('search.placeholder') });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(search).toHaveFocus());
  });

  it('a server whose channels did not load keeps search in the phone list head, and it searches every conversation', async () => {
    const { user, client } = phone({ path: `/c/${A}`, refuseSelect: 'E_NETWORK' });
    await screen.findByText(/did not load/);
    await user.click(screen.getByRole('button', { name: t('search.open') }));
    await user.type(screen.getByRole('combobox', { name: t('search.placeholder') }), 'lamp');
    await waitFor(() => expect(client.callsOf('search')).toContainEqual({ m: 'search', scope: 'all', id: null, query: 'lamp', cursor: null }));
  });
});

// Ruling X: a channel's phone header has no "⋯"; the Activity tab's first row opens the inbox. A DM, the voice stage and the lists
// keep their button (below).
it('opens the reminder inbox from the Activity tab', async () => {
  const { user } = phone({ path: `/c/${A}/${TEXT}` });
  await user.click(await screen.findByRole('link', { name: new RegExp(`^${t('nav.tab.activity')}`) }));
  await user.click(await screen.findByRole('button', { name: 'Reminders' }));
  expect(screen.getAllByRole('dialog', { name: 'Your reminders' })).toHaveLength(1);
});

for (const [label, path, slot] of [
  ['DM', `/dm/${DM}`, '.d-phone-header__actions'],
  ['voice', `/c/${A}/${GENV}`, '.d-phone-header__actions'],
  ['channel list', `/c/${A}`, '.d-channel-list__head'],
  ['DM list', '/dm', '.d-channel-list__head'],
] as const) {
  it(`keeps the reminder inbox accessible in the existing phone ${label} action row`, async () => {
    const { user } = phone({ path });
    const trigger = await screen.findByRole('button', { name: 'Reminders' });
    expect(trigger.closest(slot)).not.toBeNull();
    await user.click(trigger);
    expect(screen.getAllByRole('dialog', { name: 'Your reminders' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Close reminders' }));
    expect(trigger).toHaveFocus();
  });
}
