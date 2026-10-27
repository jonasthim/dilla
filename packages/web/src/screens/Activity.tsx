import { useMemo } from 'react';
import type { ChannelSummary } from '@dilla/client-core';
import { EmptyState, Icon, PhoneHeader, Pill } from '@dilla/ui';
import { useSlice, useSlices } from '../core/use-slice.ts';
import { t } from '../strings/index.ts';
import { requestThread } from '../thread-request.ts';
import { mergeMembers, messageTime, nameBook, plainBody, rowBadge } from './shell-model.ts';

const CATEGORY = 2;
const CHEVRON = 'chevron-right';

/**
 * The phone's Activity tab (flow 12): the mentions and direct messages the worker noticed since this tab opened,
 * newest first, then every other channel or DM with something unread. A row opens the channel or DM it names, and a
 * reply that shows in a thread opens that thread too. With `reminders`, the first row opens the reminders inbox and says how many
 * are due (the prototype lists due reminders first; Ruling X: the phone's channel header has no "⋯" to reach it from).
 */
export function Activity(props: {
  onOpen(target: { communityId: string | null; channelId: string }): void;
  reminders?: { due: number; onOpen(): void };
}): React.JSX.Element {
  const notices = useSlice('notices');
  const badges = useSlice('badges');
  const settings = useSlice('settings');
  const dms = useSlice('dms');
  const communities = useSlice('communities');
  const account = useSlice('account');
  const memberLists = useSlices((communities ?? []).map(c => `members:${c.id}` as const));
  // A mention in a body names its person, as it does in the conversation, never the raw id.
  const book = useMemo(() => nameBook(account?.user ?? null, mergeMembers(memberLists)), [account, memberLists]);
  const channelLists = useSlices((communities ?? []).map(c => `channels:${c.id}` as const));
  const channels = useMemo(() => channelLists.flatMap(list => (list ?? []) as readonly ChannelSummary[]).filter(c => c.kind !== CATEGORY), [channelLists]);
  const communityName = (id: string | null) => communities?.find(c => c.id === id)?.name ?? null;
  const nameOf = (channelId: string) => channels.find(c => c.id === channelId)?.name ?? dms?.find(d => d.id === channelId)?.name ?? channelId.slice(0, 8);
  const now = Date.now();

  const listed = [...(notices?.items ?? [])].filter(n => n.kind !== 'message').reverse();
  const named = new Set(listed.map(n => n.channelId));
  const elsewhere = [
    ...channels.map(c => ({ id: c.id, communityId: c.communityId, name: `#${c.name}`, place: communityName(c.communityId) })),
    ...(dms ?? []).map(d => ({ id: d.id, communityId: null as string | null, name: d.name, place: null as string | null })),
  ].map(row => ({ ...row, badge: rowBadge(badges, settings, row.id, row.communityId ?? undefined) }))
    .filter(row => (row.badge.unread > 0 || row.badge.mentions > 0) && !named.has(row.id));

  const reminders = props.reminders === undefined ? null : (
    <ul className="dw-phone-list">
      <li>
        <button type="button" className="dw-phone-row" aria-haspopup="dialog" onClick={() => props.reminders?.onOpen()}>
          <span className="dw-phone-row__text">
            <span className="dw-phone-row__line">{t('reminder.inbox')}</span>
            {props.reminders.due > 0 ? <span className="dw-phone-row__meta">{t('reminder.badge', { count: props.reminders.due })}</span> : null}
          </span>
          <Icon name={CHEVRON} size={18} />
        </button>
      </li>
    </ul>
  );

  if (listed.length === 0 && elsewhere.length === 0) {
    return (
      <div className="dw-phone-pane dw-phone-pane--empty">
        <PhoneHeader title={t('activity.title')} />
        {reminders}
        <div className="dw-phone-pane__frame"><EmptyState title={t('activity.emptyTitle')} body={t('activity.since')} /></div>
      </div>
    );
  }
  return (
    <div className="dw-phone-pane">
      <PhoneHeader title={t('activity.title')} />
      {reminders}
      {listed.length === 0 ? null : (
        <ul className="dw-phone-list" aria-label={t('activity.title')}>
          {listed.map(n => {
            const place = communityName(n.communityId);
            return (
              <li key={n.id}>
                <button type="button" className="dw-phone-row" onClick={() => {
                  props.onOpen({ communityId: n.communityId, channelId: n.channelId });
                  if (n.threadRoot !== null && n.communityId !== null) requestThread(n.channelId, n.threadRoot);
                }}>
                  <span className="dw-phone-row__text">
                    <span className="dw-phone-row__line">
                      <strong className="dw-phone-row__who">{n.senderName}</strong>
                      {n.kind === 'mention' ? ` ${t('activity.mention', { channel: nameOf(n.channelId) })}` : ` · ${t('activity.dm')}`}
                    </span>
                    {n.body === '' ? null : <span className="dw-phone-row__line">{plainBody(n.body, book)}</span>}
                    <span className="dw-phone-row__meta">{place === null ? messageTime(n.ts, now) : `${messageTime(n.ts, now)} · ${place}`}</span>
                  </span>
                  {n.kind === 'mention' ? <Pill kind="mention" count={1} /> : null}
                  <Icon name={CHEVRON} size={18} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {elsewhere.length === 0 ? null : (
        <section aria-labelledby="dw-activity-elsewhere">
          <h2 id="dw-activity-elsewhere" className="d-label dw-you__listhead">{t('activity.elsewhere')}</h2>
          <ul className="dw-phone-list">
            {elsewhere.map(row => (
              <li key={row.id}>
                <button type="button" className="dw-phone-row" onClick={() => props.onOpen({ communityId: row.communityId, channelId: row.id })}>
                  <span className="dw-phone-row__text">
                    <span className="dw-phone-row__line">{row.name}</span>
                    {row.place === null ? null : <span className="dw-phone-row__meta">{row.place}</span>}
                  </span>
                  <Pill kind="mention" count={row.badge.mentions} />
                  <Pill kind="unread" count={row.badge.unread} />
                  <Icon name={CHEVRON} size={18} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="dw-phone-note">{t('activity.since')}</p>
    </div>
  );
}
