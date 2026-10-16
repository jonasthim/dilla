import './AudioMeter.css';

export interface AudioMeterProps {
  /** 0..12; anything else is clamped, and a non-number reads as 0. */
  level: number;
  /** The meter's accessible name, e.g. `settings.voice.level` ('input level'). */
  label: string;
}

const BARS = 12;

/**
 * The twelve-bar input meter (`role="meter"`, 0..12). It has no motion of its own: the caller redraws it every
 * 120 ms in every motion mode (flow 06), and a bar is either lit or not, so nothing animates between frames. The bars rise from 30 % to 100 % of the height.
 */
export function AudioMeter({ level, label }: AudioMeterProps) {
  const n = Number.isFinite(level) ? Math.min(BARS, Math.max(0, Math.round(level))) : 0;
  return (
    <div className="d-audio-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={BARS} aria-valuenow={n}>
      {Array.from({ length: BARS }, (_, i) => (
        <span key={i} className="d-audio-meter__bar" data-on={i < n ? 'true' : 'false'} style={{ height: `${30 + Math.round((70 * i) / (BARS - 1))}%` }} aria-hidden="true" />
      ))}
    </div>
  );
}
