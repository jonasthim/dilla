import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, InviteLink, ManageList, Select } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { errorOf } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { t, type StringKey } from '../../strings/index.ts';
import { messageTime } from '../shell-model.ts';
import { forbidden, shownName, type SectionProps } from './shared.ts';

/** "Expires after" and "Max uses" (flow 08): the instance accepts at most 30 days and 1000 uses. */
export const TTL_OPTIONS: readonly { seconds: number; key: StringKey }[] = [
  { seconds: 1800, key: 'admin.invites.ttl.halfHour' }, { seconds: 3600, key: 'admin.invites.ttl.hour' },
  { seconds: 21_600, key: 'admin.invites.ttl.sixHours' }, { seconds: 43_200, key: 'admin.invites.ttl.halfDay' },
  { seconds: 86_400, key: 'admin.invites.ttl.day' }, { seconds: 604_800, key: 'admin.invites.ttl.week' },
  { seconds: 2_592_000, key: 'admin.invites.ttl.month' },
];
export const USES_OPTIONS: readonly number[] = [1, 5, 10, 25, 50, 100, 1000];
export const DEFAULT_TTL_S = 604_800;
export const DEFAULT_USES = 10;
const usesLabel = (n: number): string => (n === 1 ? t('admin.invites.uses.one') : t('admin.invites.uses.n', { n }));

interface Made { state: 'creating' | 'ready' | 'failed'; url: string; status: string; error: string | null; attempt: number; limits: string }

/** Copies `text`; true when the browser let it. */
async function copied(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/**
 * Invites tab: make a link with an expiry and a use limit (shown by the existing InviteLink, once: the instance keeps only a
 * fingerprint, so a link cannot be shown again) and the live links with a revoke each. The list is read when the tab opens
 * and again after a make or a revoke.
 */
export function InvitesSection({ communityId, serverName, announce }: SectionProps): React.JSX.Element {
  const client = useCore();
  const base = useId();
  const invites = useSlice(`invites:${communityId}`);
  const members = useSlice(`members:${communityId}`);
  const access = useSlice(`permissions:${communityId}`);
  const selfId = useSlice('account')?.user?.id ?? null;
  const [ttl, setTtl] = useState(String(DEFAULT_TTL_S));
  const [uses, setUses] = useState(String(DEFAULT_USES));
  const [made, setMade] = useState<Made | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<{ message: string; n: number } | null>(null);
  const revoking = useRef(false);
  const making = useRef(0);
  const inflight = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(() => {
    setLoadError(null);
    client.call({ m: 'loadInvites', communityId }).catch((e: unknown) => setLoadError(t('admin.invites.error.load', { code: errorOf(e).code })));
  }, [client, communityId]);
  useEffect(load, [load]);

  const make = () => {
    if (inflight.current) return;
    inflight.current = true;
    const ttlSeconds = Number(ttl);
    const maxUses = Number(uses);
    const ttlLabel = t(TTL_OPTIONS.find(o => o.seconds === ttlSeconds)?.key ?? 'admin.invites.ttl.week');
    const limits = `${t('admin.invites.expires')}: ${ttlLabel}. ${t('admin.invites.uses')}: ${usesLabel(maxUses)}. ${t('admin.invites.codeHidden')}`;
    const mine = ++making.current;
    setMade(m => ({ state: 'creating', url: '', status: '', error: null, attempt: m?.attempt ?? 0, limits }));
    void (async () => {
      try {
        const value = await client.call({ m: 'createInvite', communityId, maxUses, ttlSeconds })
          .finally(() => { if (making.current === mine) inflight.current = false; });
        const url = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).url : undefined;
        if (typeof url !== 'string' || url === '') throw Object.assign(new Error('E_BAD_RESULT'), { code: 'E_BAD_RESULT' });
        if (making.current !== mine) return;
        setMade(m => ({ state: 'ready', url, status: '', error: null, attempt: m?.attempt ?? 0, limits }));
        load();
        const ok = await copied(url);
        if (making.current === mine) setMade(m => (m === null ? m : { ...m, status: t(ok ? 'invite.copied' : 'invite.blocked') }));
      } catch (e) {
        if (making.current !== mine) return;
        const err = errorOf(e);
        setMade(m => ({ state: 'failed', url: '', status: '', limits,
          error: forbidden(err) ? t('invite.error.forbidden') : t('invite.error.other', { code: err.code }), attempt: (m?.attempt ?? 0) + 1 }));
      }
    })();
  };
  const closeMade = () => { making.current += 1; inflight.current = false; setMade(null); };

  const revoke = (id: string) => {
    const row = invites?.find(i => i.id === id);
    if (row === undefined || revoking.current) return;
    revoking.current = true;
    setBusyId(id);
    setRevokeError(null);
    client.call({ m: 'revokeInvite', communityId, inviteId: id }).then(() => {
      announce(t('admin.invites.revoked'));
      headingRef.current?.focus();
    }).catch((e: unknown) => {
      const err = errorOf(e);
      setRevokeError(r => ({ message: forbidden(err) ? t('admin.invites.error.forbidden') : t('admin.invites.error.other', { code: err.code }), n: (r?.n ?? 0) + 1 }));
    }).finally(() => { revoking.current = false; setBusyId(null); });
  };

  // No maker on record is an account the instance no longer names; a maker who is not in the member list has left.
  const nameOf = (userId: string | null, listed: readonly { userId: string; display: string; username: string }[]): string => {
    if (userId === null) return t('admin.bans.unknownUser');
    const m = listed.find(x => x.userId === userId);
    return m === undefined ? t('admin.member.former') : shownName(m);
  };
  const now = Date.now();
  // Until the members are read a maker cannot be named, so no row is listed rather than naming one wrongly.
  const rows = (members === undefined ? [] : invites ?? []).map(i => {
    const name = nameOf(i.createdBy, members ?? []);
    const date = messageTime(i.expires, now);
    // Final fix M1: revoke is offered on a link this account made, or to someone who manages the server (the instance's rule).
    const mayRevoke = (selfId !== null && i.createdBy === selfId) || access?.manageCommunity === true;
    return { id: i.id, title: t('admin.invites.row', { name, used: i.uses, max: i.maxUses, date }), detail: [] as string[],
      action: mayRevoke ? { label: t('admin.invites.revoke'), ariaLabel: t('admin.invites.revokeLabel', { name, date }) } : null };
  });

  return (
    <section className="dw-settings-section" aria-labelledby={`${base}-title`}>
      <h2 id={`${base}-title`} ref={headingRef} tabIndex={-1}>{t('admin.invites.title')}</h2>
      <h3>{t('admin.invites.new')}</h3>
      <form className="dw-admin-form" onSubmit={e => { e.preventDefault(); make(); }}>
        <Select label={t('admin.invites.expires')} value={ttl} onChange={setTtl}
          options={TTL_OPTIONS.map(o => ({ value: String(o.seconds), label: t(o.key) }))} />
        <Select label={t('admin.invites.uses')} value={uses} onChange={setUses}
          options={USES_OPTIONS.map(n => ({ value: String(n), label: usesLabel(n) }))} hint={t('admin.invites.limitsNote')} />
        <div className="dw-settings-actions">
          <Button type="submit" variant="accent" aria-disabled={made?.state === 'creating' || undefined}>{t('admin.invites.create')}</Button>
        </div>
      </form>
      <p>{t('admin.invites.codeHidden')}</p>
      {loadError !== null ? (
        <div role="alert" className="dw-admin-error">
          <p>{loadError}</p>
          <Button onClick={load}>{t('invite.retry')}</Button>
        </div>
      ) : null}
      {revokeError !== null ? <p key={revokeError.n} role="alert" className="dw-admin-error">{revokeError.message}</p> : null}
      {invites !== undefined && members !== undefined ? (
        <ManageList label={t('admin.invites.title')} rows={rows} emptyLabel={t('admin.invites.empty')} busyId={busyId} onAction={revoke} />
      ) : null}
      <InviteLink open={made !== null} state={made?.state ?? 'creating'} url={made?.url ?? ''} status={made?.status ?? ''}
        limits={made?.limits ?? ''} error={made?.error ?? null} attempt={made?.attempt ?? 0}
        labels={{ title: t('invite.title', { server: serverName }), creating: t('admin.invites.creating'), link: t('invite.link'),
          copy: t('invite.copy'), close: t('admin.cancel'), retry: t('invite.retry') }}
        onCopy={() => { const url = made?.url ?? ''; void copied(url).then(ok => setMade(m => (m === null ? m : { ...m, status: t(ok ? 'invite.copied' : 'invite.blocked') }))); }}
        onRetry={make} onClose={closeMade} />
    </section>
  );
}
