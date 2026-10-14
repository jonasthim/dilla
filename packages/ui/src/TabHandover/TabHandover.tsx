import { useEffect, useRef } from 'react';
import { Button } from '../Button/Button.tsx';
import './TabHandover.css';

export type TabHandoverProps = {
  /** `confirm` (product walk I7): the tab that holds dilla is in a call; taking over would end it, so ask first. */
  phase: 'other-tab' | 'waiting' | 'failed' | 'paused' | 'confirm';
  labels: { otherTab: string; use: string; wait: string; failed: string; paused: string; pausedDetail?: string;
    /** The `confirm` phase's heading and its two actions. */
    voiceWarning?: string; voiceUse?: string; voiceKeep?: string };
  onUse(): void;
  onRetry(): void;
  /** `confirm`: take over and end the other tab's call. */
  onConfirm?(): void;
  /** `confirm`: keep the call; nothing is taken over. */
  onKeep?(): void;
};

/**
 * The hand-over surface. Only the heading is the polite status (M-08), so a phase change reads the new state and not the
 * button again; the heading is the focus target. A paused tab says what happened and can take dilla back (P6, M-07).
 */
export function TabHandover({ phase, labels, onUse, onRetry, onConfirm, onKeep }: TabHandoverProps) {
  const keep = useRef<HTMLDivElement>(null);
  // The confirm phase replaces the Use button under focus: focus starts on the safe choice, keeping the call.
  useEffect(() => { if (phase === 'confirm') keep.current?.querySelector('button')?.focus(); }, [phase]);
  // Fix round 3 (m3): leaving the question (Keep the call) returns focus to the Use this tab it came from.
  const section = useRef<HTMLElement>(null);
  const was = useRef(phase);
  useEffect(() => {
    if (was.current === 'confirm' && (phase === 'other-tab' || phase === 'paused')) section.current?.querySelector<HTMLButtonElement>(':scope > .d-btn')?.focus();
    was.current = phase;
  }, [phase]);
  const heading = phase === 'failed' ? labels.failed : phase === 'other-tab' ? labels.otherTab : phase === 'paused' ? labels.paused
    : phase === 'confirm' ? labels.voiceWarning ?? labels.otherTab : labels.wait;
  return <section ref={section} className="d-tab-handover">
    <div role="status" aria-live="polite"><h2 tabIndex={-1} className="d-tab-handover__heading">{heading}</h2></div>
    {phase === 'paused' && labels.pausedDetail ? <p className="d-tab-handover__detail">{labels.pausedDetail}</p> : null}
    {phase === 'other-tab' || phase === 'paused' ? <Button variant="accent" onClick={onUse}>{labels.use}</Button> : null}
    {phase === 'failed' ? <Button variant="accent" onClick={onRetry}>{labels.use}</Button> : null}
    {phase === 'confirm' ? (
      <div ref={keep} className="d-tab-handover__confirm">
        <Button variant="accent" onClick={() => onKeep?.()}>{labels.voiceKeep}</Button>
        <Button variant="danger" onClick={() => onConfirm?.()}>{labels.voiceUse}</Button>
      </div>
    ) : null}
  </section>;
}
