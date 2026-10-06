import { createContext, useContext } from 'react';
import type { CoreClient } from '@dilla/client-core';

const CoreContext = createContext<CoreClient | null>(null);

export function CoreProvider(props: { client: CoreClient; children: React.ReactNode }): React.JSX.Element {
  return <CoreContext.Provider value={props.client}>{props.children}</CoreContext.Provider>;
}

export function useCore(): CoreClient {
  const client = useContext(CoreContext);
  if (client === null) throw new Error('useCore: no CoreProvider');
  return client;
}
