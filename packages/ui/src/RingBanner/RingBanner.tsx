import { useId } from 'react';
import { Button } from '../Button/Button.tsx';
import './RingBanner.css';

export interface RingBannerProps {
  /** `text` is the filled `call.ring.incoming` or, while this device is in voice, `call.ring.busy`. */
  rings: readonly { callId: string; text: string; busy: boolean }[];
  labels: { region: string; answer: string; decline: string };
  onAnswer(callId: string): void;
  onDecline(callId: string): void;
}

function Ring({ ring, labels, onAnswer, onDecline }: { ring: RingBannerProps['rings'][number] } & Omit<RingBannerProps, 'rings'>) {
  const textId = useId();
  return (
    <li className="d-ring-banner__ring" data-ring={ring.busy ? 'busy' : 'incoming'}>
      <span className="d-ring-banner__glyph" aria-hidden="true">◉</span>
      <p id={textId} role="alert" className="d-ring-banner__text">{ring.text}</p>
      <span className="d-ring-banner__actions">
        <Button variant="accent" className="d-ring-banner__answer" aria-describedby={textId} onClick={() => onAnswer(ring.callId)}>{labels.answer}</Button>
        <Button variant="default" className="d-ring-banner__decline" aria-describedby={textId} onClick={() => onDecline(ring.callId)}>{labels.decline}</Button>
      </span>
    </li>
  );
}

/**
 * Incoming calls, at the top of the main landmark while a ring lasts (L-UI-70): a section named `call.ring.region`
 * with one `role="alert"` per ring. A ring's alert node is keyed by its call id and inserted once, so it is
 * announced once. It never takes focus; its answer and decline buttons are described by the ring's text, so two
 * rings' buttons can be told apart. Nothing renders without rings.
 */
export function RingBanner({ rings, labels, onAnswer, onDecline }: RingBannerProps) {
  if (rings.length === 0) return null;
  return (
    <section className="d-ring-banner" aria-label={labels.region}>
      <ul role="list" className="d-ring-banner__list">
        {rings.map(r => <Ring key={r.callId} ring={r} labels={labels} onAnswer={onAnswer} onDecline={onDecline} />)}
      </ul>
    </section>
  );
}
