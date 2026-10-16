// The threads of one channel (flow 11, state 12): one button each, newest first; a click opens that thread.
import { useEffect, useState } from 'react';
import { useCore } from '../../core/context.tsx';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';
import { authorName, messageTime } from '../shell-model.ts';

export function ThreadList(p: { channelId: string; channelName: string; onOpen(rootMsgId: string): void;
  /** False: the caller's pane already carries the heading. */
  heading?: boolean;
  /** The server the channel belongs to: its members name the roots' authors. */
  communityId?: string | null }): React.JSX.Element {
  const client = useCore();
  const rows = useSlice(`threads:${p.channelId}`);
  const timeline = useSlice(`timeline:${p.channelId}`);
  const members = useSlice(`members:${p.communityId ?? ''}`);
  const account = useSlice('account');
  const self = account?.user ?? null;
  const now = Date.now();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    client.call({ m: 'loadThreads', channelId: p.channelId }).catch(() => setFailed(true));
  }, [client, p.channelId]);
  const newest = [...(rows ?? [])].sort((a, b) => b.lastTs - a.lastTs);
  return (
    <section className="dw-thread-list">
      {p.heading === false ? null : <h2 className="dw-thread-list__title">{t('thread.list')}</h2>}
      {failed ? <p role="alert" className="dw-thread-list__empty">{t('thread.loadFailed')}</p> : null}
      {!failed && rows !== undefined && rows.length === 0 ? <p className="dw-thread-list__empty">{t('thread.empty', { name: p.channelName })}</p> : null}
      {newest.length > 0 ? (
        // eslint-disable-next-line jsx-a11y/no-redundant-roles -- Safari drops list semantics from a list with list-style: none
        <ul role="list">
          {newest.map(r => {
            // Walk 15: the root's author, from the held timeline (absent when the root is not loaded), a two-line excerpt, the last reply's time.
            const root = timeline?.items.find(i => i.msgId === r.rootMsgId);
            const author = root === undefined ? null : authorName(root, members, self);
            return (
              <li key={r.rootMsgId}>
                <button type="button" className="dw-thread-list__row" onClick={() => p.onOpen(r.rootMsgId)}>
                  {author === null ? null : <span className="dw-thread-list__author">{author}</span>}
                  <span className="dw-thread-list__excerpt">{r.excerpt === '' ? t('thread.rootMissing') : r.excerpt}</span>
                  <span className="dw-thread-list__count">{`${r.count === 1 ? t('thread.summary.one') : t('thread.summary.other', { count: r.count })} · ${messageTime(r.lastTs, now)}`}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
