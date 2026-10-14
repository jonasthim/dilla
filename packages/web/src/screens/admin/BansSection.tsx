import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, ConfirmDialog, ManageList } from '@dilla/ui';
import type { BanSummary } from '@dilla/client-core';
import { useCore } from '../../core/context.tsx';
import { errorOf } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { formatDay, t } from '../../strings/index.ts';
import { shownName, useRun, type SectionProps } from './shared.ts';

/** How long a ban lasts, as the row says it: running to a date, until lifted, or already ended (the person can join again). */
function lastsLine(ban: BanSummary, nowSeconds: number): string {
  if (ban.expires === null) return t('admin.bans.forever');
  return ban.expires <= nowSeconds ? t('admin.bans.lapsed', { date: formatDay(ban.expires) }) : t('admin.bans.until', { date: formatDay(ban.expires) });
}

/**
 * Bans tab: the ban list of the server (`bans:<cid>`, read when the tab opens) through ManageList, with an unban behind a
 * confirm. A lapsed ban stays in the list until the instance forgets it, and says it ended. The name `admin.bans.unknownUser`
 * stands only for an account the instance no longer names (an empty name).
 */
export function BansSection({ communityId, serverName, announce }: SectionProps): React.JSX.Element {
  const client = useCore();
  const base = useId();
  const bans = useSlice(`bans:${communityId}`);
  const members = useSlice(`members:${communityId}`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<BanSummary | null>(null);
  const action = useRun();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Set by a resolved unban; read once its dialog has closed. The opener row is gone then, so focus goes to the heading.
  const focusHeading = useRef(false);
  const last = useRef<BanSummary | null>(null);
  if (target !== null) last.current = target;

  const load = useCallback(() => {
    setLoadError(null);
    client.call({ m: 'loadBans', communityId }).catch((e: unknown) => setLoadError(t('admin.bans.error.load', { code: errorOf(e).code })));
  }, [client, communityId]);
  useEffect(load, [load]);
  useEffect(() => {
    if (target !== null || !focusHeading.current) return;
    focusHeading.current = false;
    headingRef.current?.focus();
  }, [target]);
  // A ban that leaves the list while its confirm is open (lifted elsewhere) closes the confirm.
  const gone = target !== null && bans !== undefined && !bans.some(b => b.userId === target.userId);
  useEffect(() => { if (gone) { focusHeading.current = true; setTarget(null); } }, [gone]);

  // A banner who is not in the member list has left; until the members are read the clause is left out.
  const nameOf = (userId: string): string | null => {
    if (members === undefined) return null;
    const m = members.find(x => x.userId === userId);
    return m === undefined ? t('admin.member.former') : shownName(m);
  };
  const shownBan = (b: BanSummary): string => (b.name !== '' ? b.name : t('admin.bans.unknownUser'));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const rows = (bans ?? []).map(b => ({
    id: b.userId,
    title: shownBan(b),
    detail: [...(nameOf(b.byUser) === null ? [] : [t('admin.bans.by', { name: nameOf(b.byUser) ?? '', date: formatDay(b.created) })]),
      lastsLine(b, nowSeconds), b.reason !== '' ? b.reason : t('admin.bans.noReason')],
    action: { label: t('admin.bans.unban'), ariaLabel: t('admin.bans.unbanLabel', { name: shownBan(b) }) },
  }));

  const open = (userId: string) => {
    const ban = bans?.find(b => b.userId === userId);
    if (ban === undefined) return;
    action.reset();
    setTarget(ban);
  };
  const close = () => { if (!action.busy) { action.reset(); setTarget(null); } };
  const unban = () => {
    if (target === null) return;
    const ban = target;
    void action.run(() => client.call({ m: 'unbanMember', communityId, userId: ban.userId }), e => t('mod.error.other', { code: e.code }))
      .then(ok => {
        if (!ok) return;
        announce(t('admin.bans.unbanned', { name: shownBan(ban) }));
        focusHeading.current = true;
        setTarget(null);
        headingRef.current?.focus();
      });
  };
  const named = shownBan(target ?? last.current ?? { name: '' } as BanSummary);

  return (
    <section className="dw-settings-section" aria-labelledby={`${base}-title`}>
      <h2 id={`${base}-title`} ref={headingRef} tabIndex={-1}>{t('admin.bans.title')}</h2>
      {loadError !== null ? (
        <div role="alert" className="dw-admin-error">
          <p>{loadError}</p>
          <Button onClick={load}>{t('admin.bans.retry')}</Button>
        </div>
      ) : bans === undefined ? (
        <p>{t('admin.bans.loading')}</p>
      ) : (
        <ManageList label={t('admin.bans.title')} rows={rows} emptyLabel={t('admin.bans.empty', { server: serverName })} busyId={null}
          onAction={open} />
      )}
      <ConfirmDialog open={target !== null} title={t('admin.bans.unbanTitle', { name: named })}
        body={t('admin.bans.unbanBody', { name: named, server: serverName })} confirmLabel={t('admin.bans.unbanConfirm')}
        busyLabel={t('admin.bans.unbanBusy')} cancelLabel={t('admin.cancel')} tone="accent"
        busy={action.busy} error={action.error} attempt={action.attempt} onConfirm={unban} onClose={close} />
    </section>
  );
}
