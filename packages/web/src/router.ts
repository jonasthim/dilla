import { useMemo, useSyncExternalStore } from 'react';
import { errorOf, type UiError } from './core/errors.ts';
import type { PhoneTab } from './layout.ts';

export type SettingsSection =
  | 'devices'
  | 'signin'
  | 'notifications'
  | 'appearance'
  | 'voice'
  | 'privacy'
  | 'keyboard'
  | 'diagnostics';
export type SignInNotice = 'race' | 'evicted';
export type Route = { name: 'root' } | { name: 'welcome'; invite: string | null; signin: SignInNotice | null }
  | { name: 'channel'; communityId: string; channelId: string | null }
  | { name: 'dm'; channelId: string }
  /** The phone's DMs tab (and, on a desktop, the DMs sidebar tab with no DM open). */
  | { name: 'dms' } | { name: 'activity' } | { name: 'you' }
  | { name: 'settings'; section: SettingsSection; from: string | null;
    /** Privacy only: the contact whose comparison opens at once (the voice pause banner's action, flow 06). */
    compare?: string };

/** The history-state key that carries a settings route's `from`: the path Settings was opened over. */
export const SETTINGS_FROM = 'settingsFrom';
/** The history-state key that carries a privacy route's `compare`: a 32-hex user id, nothing else. */
export const SETTINGS_COMPARE = 'compareUser';

/** The history-state key that marks an entry this app pushed on a phone: back is then `history.back()`, else a deep link's fallback. */
export const PHONE_BACK = 'phoneBack';
/** The path of the screen a pushed phone view was pushed from, kept beside `phoneBack` in the history state. */
const PHONE_FROM = 'phoneFrom';

const DM = /^\/dm\/([0-9a-f]{32})$/;
const SETTINGS_SECTION = /^\/settings\/(devices|signin|notifications|appearance|voice|privacy|keyboard|diagnostics)$/;
const HEX32 = /^[0-9a-f]{32}$/;

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

/** The comparison a privacy route's history state asks for: a 32-hex user id, else nothing. */
function compareState(state: unknown): { compare?: string } {
  if (typeof state !== 'object' || state === null) return {};
  const user = (state as Record<string, unknown>)[SETTINGS_COMPARE];
  return typeof user === 'string' && HEX32.test(user) ? { compare: user } : {};
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
  if (pathname === '/dm') return { name: 'dms' };
  if (pathname === '/activity') return { name: 'activity' };
  if (pathname === '/you') return { name: 'you' };
  if (pathname === '/settings') return { name: 'settings', section: 'devices', from: fromState(state) };
  const section = SETTINGS_SECTION.exec(pathname);
  if (section) {
    const name = section[1] as SettingsSection;
    return { name: 'settings', section: name, from: fromState(state), ...(name === 'privacy' ? compareState(state) : {}) };
  }
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
    case 'dms': return '/dm';
    case 'activity': return '/activity';
    case 'you': return '/you';
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
function navigate(route: Route, replace = false, opts?: { phoneBack?: boolean; from?: string | null }): void {
  const path = routePath(route);
  if (!replace && path === snapshot()) return;
  let state: { [SETTINGS_FROM]?: string | null; [SETTINGS_COMPARE]?: string; [PHONE_BACK]?: true; [PHONE_FROM]?: string } | null = null;
  if (route.name === 'settings') {
    const current = parseRoute(location.pathname, location.search, history.state);
    state = { [SETTINGS_FROM]: opts?.from !== undefined ? opts.from : current.name === 'settings' ? current.from : snapshot() };
    if (route.section === 'privacy' && route.compare !== undefined && HEX32.test(route.compare)) state[SETTINGS_COMPARE] = route.compare;
  }
  if (opts?.phoneBack === true) state = { ...state, [PHONE_BACK]: true, [PHONE_FROM]: snapshot() };
  if (replace) history.replaceState(state, '', path);
  else history.pushState(state, '', path);
  for (const listener of listeners) listener();
}

/**
 * Back on a phone's pushed view: `history.back()` when this entry was pushed by the app (`phoneBack`), else (a deep
 * link, a reload into the view) the tab's list route, replacing the entry, so back never leaves the app.
 *
 * With `expect` (N5), the entry back lands on may not be the one the caller means: after the system forward button the
 * entry below is a forward one. A one-shot popstate listener checks where back landed and, when that is not `expect`,
 * replaces with `expect`. It returns a function that removes that listener (a caller that unmounts before the pop calls it).
 */
export function goBack(fallback: Route, go: (route: Route, replace?: boolean) => void, expect?: Route): () => void {
  const state: unknown = history.state;
  if (typeof state === 'object' && state !== null && (state as Record<string, unknown>)[PHONE_BACK] === true) {
    let off = () => undefined as void;
    if (expect !== undefined) {
      const onPop = () => { if (snapshot() !== routePath(expect)) go(expect, true); };
      window.addEventListener('popstate', onPop, { once: true });
      off = () => window.removeEventListener('popstate', onPop);
    }
    history.back();
    return off;
  }
  go(fallback, true);
  return () => undefined;
}

/** Where the current history entry's phone view was pushed from, or null (a deep link, a reload, no push by the app). */
export function pushedFrom(): Route | null {
  const state: unknown = history.state;
  const from = typeof state === 'object' && state !== null ? (state as Record<string, unknown>)[PHONE_FROM] : undefined;
  return typeof from === 'string' ? routeOf(from) : null;
}

/** The phone tab a route belongs to: a channel is servers, a DM is dms, Settings is you. */
export function tabOf(route: Route): PhoneTab {
  switch (route.name) {
    case 'dm': case 'dms': return 'dms';
    case 'activity': return 'activity';
    case 'you': case 'settings': return 'you';
    case 'channel': case 'root': case 'welcome': return 'servers';
  }
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

export function useRoute(): [Route, (r: Route, replace?: boolean, opts?: { phoneBack?: boolean; from?: string | null }) => void] {
  const path = useSyncExternalStore(subscribe, snapshot);
  const route = useMemo(() => {
    const mark = path.indexOf('?');
    return parseRoute(mark < 0 ? path : path.slice(0, mark), mark < 0 ? '' : path.slice(mark), window.history.state);
  }, [path]);
  return [route, navigate];
}
