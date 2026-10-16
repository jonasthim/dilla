import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { PHONE_QUERY } from '../layout.ts';
import { t } from '../strings/index.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import { A, callState, DM, GENV, renderVoiceShell, TEXT, type VoiceHarnessOptions } from '../test/fake-client.ts';

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

  it('holds the server actions in one menu, and the new-channel action only for a person who may', async () => {
    const { user, client } = phone({ path: `/c/${A}` });
    await user.click(await screen.findByRole('button', { name: t('nav.server.menu') }));
    const names = () => screen.getAllByRole('menuitem').map(i => i.textContent);
    expect(names()).toEqual([t('invite.open'), t('admin.open'), t('admin.leave.open')]);
    await user.keyboard('{Escape}');
    manage(client);
    await user.click(screen.getByRole('button', { name: t('nav.server.menu') }));
    expect(names()).toEqual([t('create.channel.open'), t('invite.open'), t('admin.open'), t('admin.leave.open')]);
    expect(screen.queryByRole('button', { name: t('create.channel.open') })).toBeNull();
  });

  it('has no axe violations', async () => {
    const { view } = phone({ path: `/c/${A}` });
    await screen.findByRole('button', { name: t('nav.server.menu') });
    await expectNoAxeViolations(view.container);
  });
});

describe('the phone shell: pushed views', () => {
  it('pushes a channel with phoneBack, shows it alone, and back calls history.back()', async () => {
    const { user } = phone({ path: `/c/${A}` });
    await user.click(await screen.findByRole('button', { name: 'lobby' }));
    expect(here()).toBe(`/c/${A}/${TEXT}`);
    expect(window.history.state).toMatchObject({ phoneBack: true });
    expect(tabs()).toBeNull();
    expect(screen.getByRole('main')).not.toHaveAttribute('hidden');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: t('nav.back') }));
    expect(back).toHaveBeenCalledTimes(1);
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
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual([t('shell.pins.open'), t('members.toggle')]);
    await user.keyboard('{Escape}');
    manage(client);
    await user.click(screen.getByRole('button', { name: t('nav.channel.menu') }));
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual([t('shell.pins.open'), t('admin.channel.open'), t('members.toggle')]);
  });

  it('opens a DM as a pushed view with a pins menu', async () => {
    const { user } = phone({ path: '/dm' });
    await user.click(await screen.findByRole('button', { name: 'bob' }));
    expect(here()).toBe(`/dm/${DM}`);
    expect(window.history.state).toMatchObject({ phoneBack: true });
    expect(tabs()).toBeNull();
    await user.click(screen.getByRole('button', { name: t('nav.channel.menu') }));
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual([t('shell.pins.open')]);
  });

  it('gives the voice stage a phone header with its name and a back', async () => {
    phone({ path: `/c/${A}/${GENV}` });
    expect(await screen.findByRole('heading', { level: 2, name: 'general' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('nav.back') })).toBeInTheDocument();
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

  it('opens an unvisited tab at its root', async () => {
    const { user } = phone({ path: '/you' });
    await screen.findByRole('heading', { level: 1, name: t('you.title') });
    await user.click(tab('servers'));
    expect(here()).toBe(`/c/${A}`);
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
  it('opens from You as a pushed view of the You tab, with a header and no tab bar', async () => {
    const { user } = phone({ path: '/you', withSettings: true });
    await user.click(await screen.findByRole('button', { name: t('settings.nav.devices') }));
    expect(here()).toBe('/settings/devices');
    expect(window.history.state).toMatchObject({ phoneBack: true, settingsFrom: '/you' });
    const header = document.querySelector('.d-phone-header') as HTMLElement;
    expect(within(header).getByRole('heading', { level: 2 })).toHaveTextContent(t('settings.nav.devices'));
    expect(within(header).getByRole('button', { name: t('nav.back') })).toBeInTheDocument();
    expect(tabs()).toBeNull();
    expect(screen.queryByRole('navigation', { name: t('settings.nav.label') })).toBeNull();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await user.click(within(header).getByRole('button', { name: t('nav.back') }));
    expect(back).toHaveBeenCalledTimes(1);
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
    expect(document.querySelector('.d-link-banner')).toBeNull();
    expect(screen.getByRole('region', { name: t('shell.status.label') })).toBeInTheDocument();
  });
});
