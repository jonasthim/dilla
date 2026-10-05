import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parseRoute, routePath, useRoute, type Route } from './router.ts';

const C = '0123456789abcdef'.repeat(2);
const CH = 'fedcba9876543210'.repeat(2);

describe('parseRoute', () => {
  const cases: [string, string, Route][] = [
    ['/', '', { name: 'root' }],
    ['/welcome', '', { name: 'welcome', invite: null }],
    ['/welcome', '?invite=ABCD-EFGH', { name: 'welcome', invite: 'ABCD-EFGH' }],
    ['/welcome', '?invite=', { name: 'welcome', invite: null }],
    ['/welcome', '?invite=a%20b', { name: 'welcome', invite: 'a b' }],
    [`/c/${C}`, '', { name: 'channel', communityId: C, channelId: null }],
    [`/c/${C}/${CH}`, '?x=1', { name: 'channel', communityId: C, channelId: CH }],
    [`/c/${C.toUpperCase()}`, '', { name: 'root' }],
    [`/c/${C}/`, '', { name: 'root' }],
    [`/c/${C}/${CH}/x`, '', { name: 'root' }],
    ['/c/abc', '', { name: 'root' }],
    ['/welcome/', '', { name: 'root' }],
    ['/v1/instance', '', { name: 'root' }],
  ];
  it.each(cases)('%s%s', (path, search, want) => {
    expect(parseRoute(path, search)).toEqual(want);
  });
});

describe('routePath', () => {
  it('inverts parseRoute', () => {
    expect(routePath({ name: 'root' })).toBe('/');
    expect(routePath({ name: 'welcome', invite: null })).toBe('/welcome');
    expect(routePath({ name: 'welcome', invite: 'a b&c' })).toBe('/welcome?invite=a%20b%26c');
    expect(routePath({ name: 'channel', communityId: C, channelId: null })).toBe(`/c/${C}`);
    expect(routePath({ name: 'channel', communityId: C, channelId: CH })).toBe(`/c/${C}/${CH}`);
    const p = routePath({ name: 'welcome', invite: 'a b&c' });
    const [path, search] = [p.slice(0, p.indexOf('?')), p.slice(p.indexOf('?'))];
    expect(parseRoute(path, search)).toEqual({ name: 'welcome', invite: 'a b&c' });
  });
});

function Probe() {
  const [route, go] = useRoute();
  return (
    <>
      <output>{JSON.stringify(route)}</output>
      <button type="button" onClick={() => go({ name: 'channel', communityId: C, channelId: null })}>push</button>
      <button type="button" onClick={() => go({ name: 'welcome', invite: 'X' }, true)}>replace</button>
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
