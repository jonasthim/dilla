import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { baseRoute, goBack, parseRoute, PHONE_BACK, routeOf, routePath, SETTINGS_FROM, tabOf, useRoute, type Route } from './router.ts';

const C = '0123456789abcdef'.repeat(2);
const CH = 'fedcba9876543210'.repeat(2);

const DM = '9a'.repeat(16);
describe('parseRoute', () => {
  const cases: [string, string, unknown, Route][] = [
    ['/', '', null, { name: 'root' }],
    ['/welcome', '', null, { name: 'welcome', invite: null, signin: null }],
    ['/welcome', '?invite=ABCD-EFGH', null, { name: 'welcome', invite: 'ABCD-EFGH', signin: null }],
    ['/welcome', '?invite=', null, { name: 'welcome', invite: null, signin: null }],
    ['/welcome', '?invite=a%20b', null, { name: 'welcome', invite: 'a b', signin: null }],
    ['/welcome', '?signin=race', null, { name: 'welcome', invite: null, signin: 'race' }],
    ['/welcome', '?invite=ABCD-EFGH&signin=race', null, { name: 'welcome', invite: 'ABCD-EFGH', signin: 'race' }],
    ['/welcome', '?signin=evicted', null, { name: 'welcome', invite: null, signin: 'evicted' }],
    ['/welcome', '?signin=other', null, { name: 'welcome', invite: null, signin: null }],
    [`/c/${C}`, '', null, { name: 'channel', communityId: C, channelId: null }],
    [`/c/${C}/${CH}`, '?x=1', null, { name: 'channel', communityId: C, channelId: CH }],
    [`/c/${C.toUpperCase()}`, '', null, { name: 'root' }],
    [`/c/${C}/`, '', null, { name: 'root' }],
    [`/c/${C}/${CH}/x`, '', null, { name: 'root' }],
    ['/c/abc', '', null, { name: 'root' }],
    ['/welcome/', '', null, { name: 'root' }],
    ['/v1/instance', '', null, { name: 'root' }],
    [`/dm/${DM}`, '', null, { name: 'dm', channelId: DM }],
    [`/dm/${DM.toUpperCase()}`, '', null, { name: 'root' }],
    ['/dm/', '', null, { name: 'root' }],
    [`/dm/${DM}/x`, '', null, { name: 'root' }],
    ['/settings', '', null, { name: 'settings', section: 'devices', from: null }],
    ['/settings/devices', '', { settingsFrom: `/c/${C}/${CH}` }, { name: 'settings', section: 'devices', from: `/c/${C}/${CH}` }],
    ['/settings/notifications', '', { settingsFrom: `/dm/${DM}` }, { name: 'settings', section: 'notifications', from: `/dm/${DM}` }],
    ['/settings/appearance', '', { settingsFrom: '/welcome?invite=X' }, { name: 'settings', section: 'appearance', from: '/welcome?invite=X' }],
    ['/settings/devices', '', { settingsFrom: '/settings/appearance' }, { name: 'settings', section: 'devices', from: null }],
    ['/settings/devices', '', { settingsFrom: '//evil.example/x' }, { name: 'settings', section: 'devices', from: null }],
    ['/settings/devices', '', { settingsFrom: 'https://evil.example/' }, { name: 'settings', section: 'devices', from: null }],
    ['/settings/devices', '', { settingsFrom: 7 }, { name: 'settings', section: 'devices', from: null }],
    ['/settings/privacy', '', null, { name: 'settings', section: 'privacy', from: null }],
    ['/settings/keyboard', '', null, { name: 'settings', section: 'keyboard', from: null }],
    ['/settings/voice', '', null, { name: 'settings', section: 'voice', from: null }],
    ['/settings/privacy', '', { settingsFrom: null, compareUser: 'ab'.repeat(16) }, { name: 'settings', section: 'privacy', from: null, compare: 'ab'.repeat(16) }],
    ['/settings/privacy', '', { settingsFrom: null, compareUser: 'not-hex' }, { name: 'settings', section: 'privacy', from: null }],
    ['/settings/diagnostics', '', null, { name: 'settings', section: 'diagnostics', from: null }],
    ['/settings/signin', '', null, { name: 'settings', section: 'signin', from: null }],
    ['/settings/', '', null, { name: 'root' }],
  ];
  it.each(cases)('%s%s', (path, search, state, want) => {
    expect(parseRoute(path, search, state)).toEqual(want);
  });
  it('defaults the state to none', () => {
    expect(parseRoute('/settings/devices', '')).toEqual({ name: 'settings', section: 'devices', from: null });
  });
});

describe('routePath', () => {
  it('inverts parseRoute', () => {
    expect(routePath({ name: 'root' })).toBe('/');
    expect(routePath({ name: 'welcome', invite: null, signin: null })).toBe('/welcome');
    expect(routePath({ name: 'welcome', invite: 'a b&c', signin: null })).toBe('/welcome?invite=a%20b%26c');
    expect(routePath({ name: 'welcome', invite: 'a b&c', signin: 'race' })).toBe('/welcome?invite=a%20b%26c&signin=race');
    expect(routePath({ name: 'welcome', invite: null, signin: 'race' })).toBe('/welcome?signin=race');
    expect(routePath({ name: 'welcome', invite: null, signin: 'evicted' })).toBe('/welcome?signin=evicted');
    expect(routePath({ name: 'channel', communityId: C, channelId: null })).toBe(`/c/${C}`);
    expect(routePath({ name: 'channel', communityId: C, channelId: CH })).toBe(`/c/${C}/${CH}`);
    expect(routePath({ name: 'dm', channelId: DM })).toBe(`/dm/${DM}`);
    expect(routePath({ name: 'settings', section: 'notifications', from: '/x' })).toBe('/settings/notifications');
    expect(routeOf('/welcome?invite=a%20b%26c')).toEqual({ name: 'welcome', invite: 'a b&c', signin: null });
    expect(routeOf('/welcome?signin=race')).toEqual({ name: 'welcome', invite: null, signin: 'race' });
    expect(routeOf('/welcome?invite=a%20b%26c&signin=race')).toEqual({ name: 'welcome', invite: 'a b&c', signin: 'race' });
    expect(routeOf(`/c/${C}/${CH}`)).toEqual({ name: 'channel', communityId: C, channelId: CH });
    expect(routeOf('/settings/devices')).toEqual({ name: 'settings', section: 'devices', from: null });
  });
});

function Probe() {
  const [route, go] = useRoute();
  return (
    <>
      <output>{JSON.stringify(route)}</output>
      <button type="button" onClick={() => go({ name: 'channel', communityId: C, channelId: null })}>push</button>
      <button type="button" onClick={() => go({ name: 'welcome', invite: 'X', signin: null }, true)}>replace</button>
    </>
  );
}

describe('useRoute', () => {
  it('pushes, replaces and follows popstate', async () => {
    const user = userEvent.setup();
    render(<Probe />);
    expect(screen.getByRole('status')).toHaveTextContent('{"name":"root"}');
    const before = window.history.length;
    await user.click(screen.getByRole('button', { name: 'push' }));
    expect(window.location.pathname).toBe(`/c/${C}`);
    expect(window.history.length).toBe(before + 1);
    expect(screen.getByRole('status')).toHaveTextContent(`{"name":"channel","communityId":"${C}","channelId":null}`);
    await user.click(screen.getByRole('button', { name: 'push' }));
    expect(window.history.length).toBe(before + 1);
    await user.click(screen.getByRole('button', { name: 'replace' }));
    expect(window.location.pathname + window.location.search).toBe('/welcome?invite=X');
    expect(window.history.length).toBe(before + 1);
    act(() => {
      window.history.pushState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByRole('status')).toHaveTextContent('{"name":"root"}');
  });
});

function SettingsProbe() {
  const [route, go] = useRoute();
  return (
    <>
      <output>{JSON.stringify(route)}</output>
      <button type="button" onClick={() => go({ name: 'settings', section: 'devices', from: null })}>open</button>
      <button type="button" onClick={() => go({ name: 'settings', section: 'appearance', from: 'ignored' }, true)}>section</button>
    </>
  );
}

describe('the settings route', () => {
  it('remembers where it was opened from in one history entry', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/c/${C}/${CH}`);
    render(<SettingsProbe />);
    const before = window.history.length;
    await user.click(screen.getByRole('button', { name: 'open' }));
    expect(window.location.pathname).toBe('/settings/devices');
    expect(window.history.state).toEqual({ [SETTINGS_FROM]: `/c/${C}/${CH}` });
    expect(screen.getByRole('status')).toHaveTextContent(`{"name":"settings","section":"devices","from":"/c/${C}/${CH}"}`);
    await user.click(screen.getByRole('button', { name: 'section' }));
    expect(window.location.pathname).toBe('/settings/appearance');
    expect(window.history.state).toEqual({ [SETTINGS_FROM]: `/c/${C}/${CH}` });
    expect(window.history.length).toBe(before + 1);
  });
});

describe('baseRoute', () => {
  it('shows what settings was opened over', () => {
    expect(baseRoute({ name: 'settings', section: 'devices', from: `/c/${C}/${CH}` })).toEqual({ name: 'channel', communityId: C, channelId: CH });
    expect(baseRoute({ name: 'settings', section: 'notifications', from: null })).toEqual({ name: 'root' });
    expect(baseRoute({ name: 'dm', channelId: CH })).toEqual({ name: 'dm', channelId: CH });
  });
});

describe('the phone routes', () => {
  it('parses /dm, /activity and /you and writes them back', () => {
    expect(parseRoute('/dm', '')).toEqual({ name: 'dms' });
    expect(parseRoute('/activity', '')).toEqual({ name: 'activity' });
    expect(parseRoute('/you', '')).toEqual({ name: 'you' });
    expect(parseRoute('/dm/', '')).toEqual({ name: 'root' });
    expect(routePath({ name: 'dms' })).toBe('/dm');
    expect(routePath({ name: 'activity' })).toBe('/activity');
    expect(routePath({ name: 'you' })).toBe('/you');
    expect(routeOf('/you')).toEqual({ name: 'you' });
  });

  it('/dm is Home with the @ tile selected: it parses to dms, which belongs to the home tab', () => {
    expect(parseRoute('/dm', '')).toEqual({ name: 'dms' });
    expect(tabOf(parseRoute('/dm', ''))).toBe('home');
  });

  it('tabOf names the tab of every route', () => {
    expect(tabOf({ name: 'channel', communityId: C, channelId: null })).toBe('home');
    expect(tabOf({ name: 'root' })).toBe('home');
    expect(tabOf({ name: 'welcome', invite: null, signin: null })).toBe('home');
    expect(tabOf({ name: 'dm', channelId: DM })).toBe('home');
    expect(tabOf({ name: 'dms' })).toBe('home');
    expect(tabOf({ name: 'activity' })).toBe('activity');
    expect(tabOf({ name: 'you' })).toBe('you');
    expect(tabOf({ name: 'settings', section: 'devices', from: null })).toBe('you');
  });
});

function PhoneProbe() {
  const [route, go] = useRoute();
  return (
    <>
      <output>{JSON.stringify(route)}</output>
      <button type="button" onClick={() => go({ name: 'channel', communityId: C, channelId: CH }, false, { phoneBack: true })}>push back</button>
      <button type="button" onClick={() => go({ name: 'settings', section: 'devices', from: null }, false, { phoneBack: true })}>open settings</button>
      <button type="button" onClick={() => go({ name: 'you' })}>plain</button>
    </>
  );
}

describe('navigate with phoneBack', () => {
  it('writes phoneBack into the pushed state, and only when asked', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/you');
    render(<PhoneProbe />);
    await user.click(screen.getByRole('button', { name: 'push back' }));
    expect(window.history.state).toEqual({ [PHONE_BACK]: true, phoneFrom: '/you' });
    window.history.replaceState(null, '', '/activity');
    await user.click(screen.getByRole('button', { name: 'plain' }));
    expect(window.history.state).toBeNull();
  });

  it('keeps settingsFrom beside phoneBack on a settings route', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/you');
    render(<PhoneProbe />);
    await user.click(screen.getByRole('button', { name: 'open settings' }));
    expect(window.history.state).toEqual({ [SETTINGS_FROM]: '/you', [PHONE_BACK]: true, phoneFrom: '/you' });
  });
});

describe('goBack', () => {
  it('goes back in history when the entry was pushed by the app', () => {
    window.history.replaceState({ [PHONE_BACK]: true }, '', `/c/${C}/${CH}`);
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const navigate = vi.fn();
    goBack({ name: 'channel', communityId: C, channelId: null }, navigate);
    expect(back).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    back.mockRestore();
  });

  describe('with an expected route (N5: the system forward button)', () => {
    const expected: Route = { name: 'channel', communityId: C, channelId: null };
    /** history.back() that lands on `path` and fires the popstate the browser would. */
    const backTo = (path: string) => vi.spyOn(window.history, 'back').mockImplementation(() => {
      window.history.replaceState(null, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    it('goes to the expected route when back landed somewhere else (a forward entry)', () => {
      window.history.replaceState({ [PHONE_BACK]: true }, '', `/c/${C}/${CH}`);
      const back = backTo('/dm');
      const navigate = vi.fn();
      goBack({ name: 'dms' }, navigate, expected);
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith(expected, true);
      back.mockRestore();
    });

    it('does nothing more when back landed on the expected route (control)', () => {
      window.history.replaceState({ [PHONE_BACK]: true }, '', `/c/${C}/${CH}`);
      const back = backTo(routePath(expected));
      const navigate = vi.fn();
      goBack({ name: 'dms' }, navigate, expected);
      expect(navigate).not.toHaveBeenCalled();
      back.mockRestore();
    });

    it('listens once: a later popstate is not corrected', () => {
      window.history.replaceState({ [PHONE_BACK]: true }, '', `/c/${C}/${CH}`);
      const back = backTo(routePath(expected));
      const navigate = vi.fn();
      goBack({ name: 'dms' }, navigate, expected);
      window.history.replaceState(null, '', '/dm');
      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(navigate).not.toHaveBeenCalled();
      back.mockRestore();
    });

    it('adds no listener on the deep-link path', () => {
      window.history.replaceState(null, '', `/c/${C}/${CH}`);
      const add = vi.spyOn(window, 'addEventListener');
      const navigate = vi.fn();
      goBack(expected, navigate, expected);
      expect(add).not.toHaveBeenCalledWith('popstate', expect.anything(), expect.anything());
      expect(navigate).toHaveBeenCalledWith(expected, true);
      add.mockRestore();
    });
  });

  it('replaces with the fallback on a deep link', () => {
    window.history.replaceState(null, '', `/c/${C}/${CH}`);
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const navigate = vi.fn();
    const fallback: Route = { name: 'channel', communityId: C, channelId: null };
    goBack(fallback, navigate);
    expect(back).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(fallback, true);
    back.mockRestore();
  });
});
