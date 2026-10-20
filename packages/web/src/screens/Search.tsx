import { useEffect, useRef, useState } from 'react';
import { SearchPalette } from '@dilla/ui';
import { usePhoneLayout } from '../layout.ts';
import { t } from '../strings/index.ts';

export interface SearchHitView { id: string; channelId: string; communityId: string | null; seq: string; snippet: string; location: string }
export interface SearchProps {
  open: boolean; query: string; scope: 'channel' | 'community' | 'all'; requestId: number; currentRequestId: number;
  hits: readonly SearchHitView[]; onQuery: (query: string) => void; onScope: (scope: 'channel' | 'community' | 'all') => void;
  onPick: (hit: SearchHitView) => Promise<boolean>; onClose: () => void;
  /** The page still waits for the worker's answer to its newest search command. */
  loading?: boolean;
}

const TEXTBOX = 'input[type="text"]';

/**
 * The search overlay (W-06, J1). On a desktop it is the palette's own modal <dialog> (`SearchPalette modal`, R-S4): a centred
 * overlay over the shell, which stays mounted and goes inert, so Tab cannot reach the covered rail, list or composer. Escape
 * closes it from anywhere in the palette, never during IME composition; focus returns to where search was opened. On a phone
 * it is a full-screen <dialog> that follows the visual viewport (`.dw-search`, web3.7.2) around the inline palette.
 */
export function Search(p: SearchProps): React.JSX.Element | null {
  const phone = usePhoneLayout();
  const [unavailable, setUnavailable] = useState(false);
  const root = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = root.current;
    if (!p.open || dialog === null) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLInputElement>(TEXTBOX)?.focus();
  }, [p.open, phone]);
  const current = p.requestId === p.currentRequestId;
  const hits = current ? p.hits.slice(0, 50) : [];
  // The docs shoot names the open palette with results (the desktop dialog belongs to the component, so it is marked here).
  const marked = p.open && hits.length > 0;
  useEffect(() => {
    if (!marked) return;
    const el = phone ? root.current : document.querySelector<HTMLElement>('dialog.d-search-palette-dialog');
    el?.setAttribute('data-doc-state', 'search-results');
    return () => el?.removeAttribute('data-doc-state');
  }, [marked, phone]);
  if (!p.open) return null;
  const pick = async (id: string) => {
    const hit = hits.find(row => row.id === id);
    if (!hit) return;
    if (await p.onPick(hit)) p.onClose();
    else { setUnavailable(true); document.querySelector<HTMLInputElement>(`.d-search-palette ${TEXTBOX}`)?.focus(); }
  };
  const palette = <SearchPalette open modal={!phone} query={p.query} scope={p.scope} hits={hits} onQuery={value => { setUnavailable(false); p.onQuery(value); }}
    onScope={p.onScope} onPick={id => { void pick(id); }} onClose={p.onClose}
    status={unavailable ? t('search.unavailable') : undefined}
    labels={{ search: t('search.placeholder'), empty: !current || p.loading === true ? t('search.loading')
      : p.query.trim() === '' ? '' : p.scope === 'all' ? t('search.empty') : t('search.noResults'),
      close: t('dialog.close'), scope: { channel: t('search.scope.channel'), community: t('search.scope.community'), all: t('search.scope.all') } }} />;
  if (!phone) return palette;
  return <dialog ref={root} className="dw-search" aria-label={t('search.placeholder')}
    onCancel={event => { event.preventDefault(); p.onClose(); }}>{palette}</dialog>;
}
