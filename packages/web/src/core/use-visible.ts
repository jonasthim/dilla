import { useSyncExternalStore } from 'react';

// Module-level, so the hook keeps one subscription for the life of the component.
function subscribe(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

function visible(): boolean {
  return document.visibilityState === 'visible';
}

/** True while the page is visible (`document.visibilityState === 'visible'`), following `visibilitychange`. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, visible);
}
