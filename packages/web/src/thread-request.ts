// A notice of a thread reply opens its thread (FX-core, final review I1). An Activity row or a notification click
// navigates to the channel and leaves this request; the Shell opens the thread once that channel is the open one, as it
// does for a search hit, and drops a request whose channel is no longer the route's.
import { useSyncExternalStore } from 'react';

export interface ThreadRequest { channelId: string; rootMsgId: string; }

let current: ThreadRequest | null = null;
const listeners = new Set<() => void>();

function set(next: ThreadRequest | null): void {
  current = next;
  for (const listener of listeners) listener();
}

/** Asks the Shell to open the thread of rootMsgId in channelId (both 32 hex) once that channel is open. */
export function requestThread(channelId: string, rootMsgId: string): void { set({ channelId, rootMsgId }); }

/** The request as it stands, and clears it. */
export function takeThreadRequest(): ThreadRequest | null {
  const taken = current;
  if (taken !== null) set(null);
  return taken;
}

export function useThreadRequest(): ThreadRequest | null {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current);
}
