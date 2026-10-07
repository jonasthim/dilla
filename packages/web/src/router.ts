import { useMemo, useSyncExternalStore } from 'react';
import { errorOf, type UiError } from './core/errors.ts';

export type SettingsSection = 'devices' | 'notifications' | 'appearance';
export type SignInNotice = 'race' | 'evicted';
export type Route = { name: 'root' } | { name: 'welcome'; invite: string | null; signin: SignInNotice | null }
  | { name: 'channel'; communityId: string; channelId: string | null }
  | { name: 'dm'; channelId: string }
  | { name: 'settings'; section: SettingsSection; from: string | null };

/** The history-state key that carries a settings route's `from`: the path Settings was opened over. */
export const SETTINGS_FROM = 'settingsFrom';

const DM = /^\/dm\/([0-9a-f]{32})$/;
const SETTINGS_SECTION = /^\/settings\/(devices|notifications|appearance)$/;

/**
 * The `from` a history state names: a same-origin path (one leading slash, never two) that is not itself a
 * settings path, so a crafted state can name only a page of this origin and never loops back into Settings.
 */
function fromState(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const from = (state as Record<string, unknown>)[SETTINGS_FROM];
  if (typeof from !== 'string') return null;
  if (!from.startsWith('/') || from.startsWith('//') || from.startsWith('/settings')) return null;
  return from;
}

export function parseRoute(pathname: string, search: string, state: unknown = null): Route {
  if (pathname === '/') return { name: 'root' };
  if (pathname === '/welcome') {
    const params = new URLSearchParams(search);
    const signin = params.get('signin');
    return { name: 'welcome', invite: params.get('invite') || null, signin: signin === 'race' || signin === 'evicted' ? signin : null };
  }
  const match = /^\/c\/([0-9a-f]{32})(?:\/([0-9a-f]{32}))?$/.exec(pathname);
  if (match) return { name: 'channel', communityId: match[1], channelId: match[2] ?? null };
  const dm = DM.exec(pathname);
  if (dm) return { name: 'dm', channelId: dm[1] };
  if (pathname === '/settings') return { name: 'settings', section: 'devices', from: fromState(state) };
  const section = SETTINGS_SECTION.exec(pathname);
  if (section) return { name: 'settings', section: section[1] as SettingsSection, from: fromState(state) };
  return { name: 'root' };
}

export function routePath(route: Route): string {
  switch (route.name) {
    case 'root': return '/';
    case 'welcome': {
      const parts: string[] = [];
      if (route.invite) parts.push(`invite=${encodeURIComponent(route.invite)}`);
      if (route.signin !== null) parts.push(`signin=${route.signin}`);
      return parts.length > 0 ? `/welcome?${parts.join('&')}` : '/welcome';
    }
    case 'channel': return `/c/${route.communityId}${route.channelId ? `/${route.channelId}` : ''}`;
    case 'dm': return `/dm/${route.channelId}`;
    case 'settings': return `/settings/${route.section}`;
  }
}

/** parseRoute of a path that may carry a ?search, with no history state. */
export function routeOf(path: string): Route {
  const mark = path.indexOf('?');
  return parseRoute(mark < 0 ? path : path.slice(0, mark), mark < 0 ? '' : path.slice(mark), null);
}

/**
 * The route the shell shows (L-TS-27): under a settings route, the route Settings was opened over (`/` when it
 * names none); any other route as it is. `fromState` never yields a settings path, so the result is never one.
 */
export function baseRoute(route: Route): Route {
  if (route.name !== 'settings') return route;
  return route.from === null ? { name: 'root' } : routeOf(route.from);
}

const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => { listeners.delete(listener); window.removeEventListener('popstate', listener); };
}
const snapshot = () => location.pathname + location.search;
/**
 * A settings route records where Settings was opened from in the history state: the current path when the
 * current route is not a settings route, else the current route's own `from` (a section switch keeps it). The
 * `from` of the route given is ignored. Every other route writes no state.
 */
function navigate(route: Route, replace = false): void {
  const path = routePath(route);
  if (!replace && path === snapshot()) return;
  let state: { [SETTINGS_FROM]: string | null } | null = null;
  if (route.name === 'settings') {
    const current = parseRoute(location.pathname, location.search, history.state);
    state = { [SETTINGS_FROM]: current.name === 'settings' ? current.from : snapshot() };
  }
  if (replace) history.replaceState(state, '', path);
  else history.pushState(state, '', path);
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
    return parseRoute(mark < 0 ? path : path.slice(0, mark), mark < 0 ? '' : path.slice(mark), window.history.state);
  }, [path]);
  return [route, navigate];
}
