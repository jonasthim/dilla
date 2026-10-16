// The threads of one channel (flow 11, state 12): one button each, newest first; a click opens that thread.
import { useEffect } from 'react';
import { useCore } from '../../core/context.tsx';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';

export function ThreadList(p: { channelId: string; channelName: string; onOpen(rootMsgId: string): void }): React.JSX.Element {
  const client = useCore();
  const rows = useSlice(`threads:${p.channelId}`);
  useEffect(() => {
    client.call({ m: 'loadThreads', channelId: p.channelId }).catch(() => undefined);
  }, [client, p.channelId]);
  const newest = [...(rows ?? [])].sort((a, b) => b.lastTs - a.lastTs);
  return (
    <section className="dw-thread-list">
      <h2 className="dw-thread-list__title">{t('thread.list')}</h2>
      {rows !== undefined && rows.length === 0 ? <p className="dw-thread-list__empty">{t('thread.empty', { name: p.channelName })}</p> : null}
      {newest.length > 0 ? (
        <ul>
          {newest.map(r => (
            <li key={r.rootMsgId}>
              <button type="button" className="dw-thread-list__row" onClick={() => p.onOpen(r.rootMsgId)}>
                <span className="dw-thread-list__excerpt">{r.excerpt === '' ? t('thread.rootMissing') : r.excerpt}</span>
                <span className="dw-thread-list__count">{` · ${r.count === 1 ? t('thread.summary.one') : t('thread.summary.other', { count: r.count })}`}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
