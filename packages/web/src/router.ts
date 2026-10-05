import { useMemo, useSyncExternalStore } from 'react';

export type Route = { name: 'root' } | { name: 'welcome'; invite: string | null }
  | { name: 'channel'; communityId: string; channelId: string | null };

export function parseRoute(pathname: string, search: string): Route {
  if (pathname === '/') return { name: 'root' };
  if (pathname === '/welcome') return { name: 'welcome', invite: new URLSearchParams(search).get('invite') || null };
  const match = /^\/c\/([0-9a-f]{32})(?:\/([0-9a-f]{32}))?$/.exec(pathname);
  if (match) return { name: 'channel', communityId: match[1], channelId: match[2] ?? null };
  return { name: 'root' };
}

export function routePath(route: Route): string {
  switch (route.name) {
    case 'root': return '/';
    case 'welcome': return route.invite ? `/welcome?invite=${encodeURIComponent(route.invite)}` : '/welcome';
    case 'channel': return `/c/${route.communityId}${route.channelId ? `/${route.channelId}` : ''}`;
  }
}

const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => { listeners.delete(listener); window.removeEventListener('popstate', listener); };
}
const snapshot = () => location.pathname + location.search;
function navigate(route: Route, replace = false): void {
  const path = routePath(route);
  if (!replace && path === snapshot()) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  for (const listener of listeners) listener();
}

export function useRoute(): [Route, (r: Route, replace?: boolean) => void] {
  const path = useSyncExternalStore(subscribe, snapshot);
  const route = useMemo(() => {
    const mark = path.indexOf('?');
    return parseRoute(mark < 0 ? path : path.slice(0, mark), mark < 0 ? '' : path.slice(mark));
  }, [path]);
  return [route, navigate];
}
