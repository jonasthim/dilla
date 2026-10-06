import { useMemo, useSyncExternalStore } from 'react';
import { errorOf, type UiError } from './core/errors.ts';

export type Route = { name: 'root' } | { name: 'welcome'; invite: string | null; signin: 'race' | null }
  | { name: 'channel'; communityId: string; channelId: string | null };

export function parseRoute(pathname: string, search: string): Route {
  if (pathname === '/') return { name: 'root' };
  if (pathname === '/welcome') {
    const params = new URLSearchParams(search);
    return { name: 'welcome', invite: params.get('invite') || null, signin: params.get('signin') === 'race' ? 'race' : null };
  }
  const match = /^\/c\/([0-9a-f]{32})(?:\/([0-9a-f]{32}))?$/.exec(pathname);
  if (match) return { name: 'channel', communityId: match[1], channelId: match[2] ?? null };
  return { name: 'root' };
}

export function routePath(route: Route): string {
  switch (route.name) {
    case 'root': return '/';
    case 'welcome': {
      const parts: string[] = [];
      if (route.invite) parts.push(`invite=${encodeURIComponent(route.invite)}`);
      if (route.signin === 'race') parts.push('signin=race');
      return parts.length > 0 ? `/welcome?${parts.join('&')}` : '/welcome';
    }
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

/**
 * The history state that carries a server join refused right after signup to /welcome?invite=…, so
 * the shell's join dialog opens with that error shown (pre-flight ruling (e), tasks 23 and 24). The
 * server's detail text is not carried: it is shown nowhere and parsed never.
 */
export function joinErrorState(error: UiError): { joinError: UiError } {
  return { joinError: { code: error.code, detail: '', status: error.status, retryAfterMs: error.retryAfterMs } };
}

/** The refused join a history state carries, or null. */
export function readJoinError(state: unknown): UiError | null {
  if (typeof state !== 'object' || state === null) return null;
  const { joinError } = state as Record<string, unknown>;
  if (typeof joinError !== 'object' || joinError === null || typeof (joinError as Record<string, unknown>).code !== 'string') return null;
  return errorOf(joinError);
}

export function useRoute(): [Route, (r: Route, replace?: boolean) => void] {
  const path = useSyncExternalStore(subscribe, snapshot);
  const route = useMemo(() => {
    const mark = path.indexOf('?');
    return parseRoute(mark < 0 ? path : path.slice(0, mark), mark < 0 ? '' : path.slice(mark));
  }, [path]);
  return [route, navigate];
}
