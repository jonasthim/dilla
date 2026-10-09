import './TabHandover.css';
export type TabHandoverProps = { phase: 'other-tab' | 'waiting' | 'failed' | 'paused'; labels: { use: string; wait: string; failed: string; paused: string }; onUse(): void; onRetry(): void };
export function TabHandover({ phase, labels, onUse, onRetry }: TabHandoverProps) {
  return <section className="d-tab-handover" role="status" aria-live="polite"><h2>{phase === 'failed' ? labels.failed : phase === 'other-tab' ? labels.use : phase === 'paused' ? labels.paused : labels.wait}</h2>{phase === 'other-tab' && <button type="button" onClick={onUse}>{labels.use}</button>}{phase === 'failed' && <button type="button" onClick={onRetry}>{labels.use}</button>}</section>;
}
