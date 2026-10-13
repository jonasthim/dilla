import { useEffect, useRef, useState } from 'react';
import { SearchPalette } from '@dilla/ui';
import { t } from '../strings/index.ts';

export interface SearchHitView { id: string; channelId: string; communityId: string | null; seq: string; snippet: string; location: string }
export interface SearchProps {
  open: boolean; query: string; scope: 'channel' | 'community' | 'all'; requestId: number; currentRequestId: number;
  hits: readonly SearchHitView[]; onQuery: (query: string) => void; onScope: (scope: 'channel' | 'community' | 'all') => void;
  onPick: (hit: SearchHitView) => Promise<boolean>; onClose: () => void;
  /** The page still waits for the worker's answer to its newest search command. */
  loading?: boolean;
}

/**
 * The search overlay is a modal <dialog> (W-06): the top layer makes the shell beneath it inert, so Tab cannot reach the
 * covered rail, list or composer and a screen reader does not read them. Escape closes it from anywhere in the palette,
 * never during IME composition; the shell returns focus to where search was opened.
 */
export function Search(p: SearchProps): React.JSX.Element | null {
  const [unavailable, setUnavailable] = useState(false);
  const root = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = root.current;
    if (!p.open || dialog === null) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLInputElement>('input[type="text"]')?.focus();
  }, [p.open]);
  if (!p.open) return null;
  const current = p.requestId === p.currentRequestId;
  const hits = current ? p.hits.slice(0, 50) : [];
  const pick = async (id: string) => {
    const hit = hits.find(row => row.id === id);
    if (!hit) return;
    if (await p.onPick(hit)) p.onClose();
    else { setUnavailable(true); root.current?.querySelector<HTMLInputElement>('input[type="text"]')?.focus(); }
  };
  return <dialog ref={root} className="dw-search" aria-label={t('search.placeholder')} data-doc-state={hits.length > 0 ? 'search-results' : undefined}
    onCancel={event => { event.preventDefault(); p.onClose(); }}>
    <SearchPalette open query={p.query} scope={p.scope} hits={hits} onQuery={value => { setUnavailable(false); p.onQuery(value); }}
      onScope={p.onScope} onPick={id => { void pick(id); }} onClose={p.onClose}
      status={unavailable ? t('search.unavailable') : undefined}
      labels={{ search: t('search.placeholder'), empty: !current || p.loading === true ? t('search.loading')
        : p.query.trim() === '' ? '' : p.scope === 'all' ? t('search.empty') : t('search.noResults'),
        close: t('dialog.close'), scope: { channel: t('search.scope.channel'), community: t('search.scope.community'), all: t('search.scope.all') } }} />
  </dialog>;
}
