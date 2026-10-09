import { useEffect, useRef, useState } from 'react';
import { SearchPalette } from '@dilla/ui';
import { t } from '../strings/index.ts';

export interface SearchHitView { id: string; channelId: string; communityId: string | null; seq: string; snippet: string; location: string }
export interface SearchProps {
  open: boolean; query: string; scope: 'channel' | 'community' | 'all'; requestId: number; currentRequestId: number;
  hits: readonly SearchHitView[]; onQuery: (query: string) => void; onScope: (scope: 'channel' | 'community' | 'all') => void;
  onPick: (hit: SearchHitView) => Promise<boolean>; onClose: () => void;
}

export function Search(p: SearchProps): React.JSX.Element | null {
  const [unavailable, setUnavailable] = useState(false);
  const root = useRef<HTMLElement>(null);
  useEffect(() => { if (p.open) root.current?.querySelector<HTMLInputElement>('input[type="text"]')?.focus(); }, [p.open]);
  if (!p.open) return null;
  const current = p.requestId === p.currentRequestId;
  const hits = current ? p.hits.slice(0, 50) : [];
  const pick = async (id: string) => {
    const hit = hits.find(row => row.id === id);
    if (!hit) return;
    if (await p.onPick(hit)) p.onClose();
    else { setUnavailable(true); root.current?.querySelector<HTMLInputElement>('input[type="text"]')?.focus(); }
  };
  return <section ref={root} className="dw-search" data-doc-state={hits.length > 0 ? 'search-results' : undefined}>
    <SearchPalette open query={p.query} scope={p.scope} hits={hits} onQuery={value => { setUnavailable(false); p.onQuery(value); }}
      onScope={p.onScope} onPick={id => { void pick(id); }} onClose={p.onClose}
      labels={{ search: t('search.placeholder'), empty: current ? t('search.noResults') : t('search.loading'),
        close: t('settings.close'), scope: { channel: t('search.scope.channel'), community: t('search.scope.community'), all: t('search.scope.all') } }} />
    {unavailable && <p role="status">{t('search.unavailable')}</p>}
  </section>;
}
