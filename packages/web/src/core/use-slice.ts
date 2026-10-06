import { useCallback, useSyncExternalStore } from 'react';
import type { SliceName, SliceTypes } from '@dilla/client-core';
import { useCore } from './context.tsx';

export function useSlice<N extends SliceName>(name: N): SliceTypes[N] | undefined {
  const client = useCore();
  const subscribe = useCallback((listener: () => void) => client.subscribe(name, listener), [client, name]);
  const getSnapshot = useCallback(() => client.get(name), [client, name]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
