// Incoming DM rings (flow 06, decision 6, R1–R8): the banner at the top of the main landmark, answer and decline, and the
// desktop notification of each ring that may raise one. The ring sound is useSounds'. A ring never moves focus.
import { useEffect, useRef } from 'react';
import type { CoreClient, DmSummary, Ring } from '@dilla/client-core';
import { RingBanner } from '@dilla/ui';
import { notificationCtor, ringNotification, type NotificationHandle } from '../../notify.ts';
import { t } from '../../strings/index.ts';

export interface RingFlowProps {
  client: Pick<CoreClient, 'call'>;
  rings: readonly Ring[] | undefined;
  dms: readonly DmSummary[] | undefined;
  settings: Readonly<Record<string, string>>;
  /** The name of the voice this device is in, for the busy text; null outside a call. */
  inCallWhere: string | null;
  /** Opens the DM (the notification's click) and joins its call (answer). */
  onOpen(channelId: string): void;
  onAnswer(channelId: string): void;
}

const key = (r: Ring) => `${r.callId}:${r.ringTs}`;

/** Each ring's notification while it lasts; closed when it ends, and all of them when the shell goes. */
function useRingNotifications(p: RingFlowProps): void {
  const open = useRef(new Map<string, NotificationHandle>());
  const live = useRef(p);
  live.current = p;
  useEffect(() => {
    const rings = p.rings ?? [];
    const now = new Set(rings.map(key));
    for (const [k, note] of open.current) {
      if (now.has(k)) continue;
      note.close();
      open.current.delete(k);
    }
    for (const ring of rings) {
      const k = key(ring);
      if (open.current.has(k)) continue;
      const kind = p.dms?.find(d => d.id === ring.channelId)?.kind ?? 3;
      const note = ringNotification(ring, { Notification: notificationCtor(), settings: p.settings, kind,
        focus: () => window.focus(), open: id => live.current.onOpen(id) });
      // A ring that may not notify is remembered too, so a later render never raises it.
      open.current.set(k, note ?? { onclick: null, close: () => undefined });
    }
  }, [p.rings, p.dms, p.settings]);
  useEffect(() => () => {
    for (const note of open.current.values()) note.close();
    open.current.clear();
  }, []);
}

/** The ring banner (L-UI-70) and the ring's notifications; nothing renders without a ring. */
export function RingFlow(p: RingFlowProps): React.JSX.Element | null {
  useRingNotifications(p);
  const rings = p.rings ?? [];
  if (rings.length === 0) return null;
  const decline = (callId: string) => {
    const ring = rings.find(r => r.callId === callId);
    if (ring !== undefined) p.client.call({ m: 'callDecline', callId, ringTs: ring.ringTs }).catch(() => undefined);
  };
  const answer = (callId: string) => {
    const ring = rings.find(r => r.callId === callId);
    if (ring !== undefined) p.onAnswer(ring.channelId);
  };
  return (
    <div className="dw-ring" data-doc-state="call-ring">
      <RingBanner rings={rings.map(r => ({
        callId: r.callId, busy: r.busy,
        text: r.busy && p.inCallWhere !== null ? t('call.ring.busy', { name: r.callerName, where: p.inCallWhere })
          : t('call.ring.incoming', { name: r.callerName }),
      }))} labels={{ region: t('call.ring.region'), answer: t('call.ring.answer'), decline: t('call.ring.decline') }}
        onAnswer={answer} onDecline={decline} />
    </div>
  );
}
