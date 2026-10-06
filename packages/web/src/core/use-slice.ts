import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { SliceName, SliceTypes } from '@dilla/client-core';
import { useCore } from './context.tsx';

export function useSlice<N extends SliceName>(name: N): SliceTypes[N] | undefined {
  const client = useCore();
  const subscribe = useCallback((listener: () => void) => client.subscribe(name, listener), [client, name]);
  const getSnapshot = useCallback(() => client.get(name), [client, name]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

const NONE: readonly never[] = [];

/**
 * The values of every named slice, in order. The snapshot is the same array object until one of the values
 * changes, so useSyncExternalStore does not loop and the component re-renders only for its own slices. The
 * names are keyed by their joined text: a new array of the same names neither resubscribes nor re-reads.
 */
export function useSlices<N extends SliceName>(names: readonly N[]): readonly (SliceTypes[N] | undefined)[] {
  const client = useCore();
  const key = names.join('\n');
  const last = useRef<readonly (SliceTypes[N] | undefined)[]>(NONE);
  const subscribe = useCallback((listener: () => void) => {
    const list = key === '' ? [] : (key.split('\n') as N[]);
    const stops = list.map(name => client.subscribe(name, listener));
    return () => { for (const stop of stops) stop(); };
  }, [client, key]);
  const getSnapshot = useCallback(() => {
    const list = key === '' ? [] : (key.split('\n') as N[]);
    const next = list.map(name => client.get(name));
    const prev = last.current;
    if (prev.length === next.length && next.every((v, i) => v === prev[i])) return prev;
    last.current = next;
    return next;
  }, [client, key]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
