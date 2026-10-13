import { Button } from '../Button/Button.tsx';
import './TabHandover.css';

export type TabHandoverProps = {
  phase: 'other-tab' | 'waiting' | 'failed' | 'paused';
  labels: { otherTab: string; use: string; wait: string; failed: string; paused: string; pausedDetail?: string };
  onUse(): void;
  onRetry(): void;
};

/**
 * The hand-over surface. Only the heading is the polite status (M-08), so a phase change reads the new state and not the
 * button again; the heading is the focus target. A paused tab says what happened and can take dilla back (P6, M-07).
 */
export function TabHandover({ phase, labels, onUse, onRetry }: TabHandoverProps) {
  const heading = phase === 'failed' ? labels.failed : phase === 'other-tab' ? labels.otherTab : phase === 'paused' ? labels.paused : labels.wait;
  return <section className="d-tab-handover">
    <div role="status" aria-live="polite"><h2 tabIndex={-1} className="d-tab-handover__heading">{heading}</h2></div>
    {phase === 'paused' && labels.pausedDetail ? <p className="d-tab-handover__detail">{labels.pausedDetail}</p> : null}
    {phase === 'other-tab' || phase === 'paused' ? <Button variant="accent" onClick={onUse}>{labels.use}</Button> : null}
    {phase === 'failed' ? <Button variant="accent" onClick={onRetry}>{labels.use}</Button> : null}
  </section>;
}
