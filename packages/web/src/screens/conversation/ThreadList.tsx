// The threads of one channel (flow 11, state 12): one button each, newest first; a click opens that thread.
import { useEffect } from 'react';
import { Button } from '@dilla/ui';
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
      <h2>{t('thread.list')}</h2>
      {rows !== undefined && rows.length === 0 ? <p>{t('thread.empty', { name: p.channelName })}</p> : null}
      {newest.length > 0 ? (
        <ul>
          {newest.map(r => (
            <li key={r.rootMsgId}>
              <Button variant="ghost" onClick={() => p.onOpen(r.rootMsgId)}>
                {`${r.excerpt === '' ? t('thread.rootMissing') : r.excerpt} · ${r.count === 1 ? t('thread.summary.one') : t('thread.summary.other', { count: r.count })}`}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
