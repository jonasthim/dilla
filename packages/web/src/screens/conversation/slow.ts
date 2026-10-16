// Slow mode in the composer (flow 11): the wait as text, and when the countdown is spoken.

/** The steps a channel's slow mode takes, in seconds, with the copy key of each (flow 11, in order). */
export const SLOW_STEPS = [
  [0, 'slow.off'], [5, 'slow.s5'], [10, 'slow.s10'], [30, 'slow.s30'], [60, 'slow.m1'], [300, 'slow.m5'], [900, 'slow.m15'],
  [3600, 'slow.h1'], [21_600, 'slow.h6'],
] as const;

/** A wait as `m:ss`, or `h:mm:ss` from an hour; rounded up to whole seconds (R7). */
export function formatWait(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * The spoken countdown changes only when this value does: the minute while more than a minute is left, else the
 * 10 s step (flow 11: a polite status, never every second). 0 when the wait is over.
 */
export function spokenStep(remainingMs: number): string {
  if (remainingMs <= 0) return '';
  const seconds = Math.ceil(remainingMs / 1000);
  return seconds > 60 ? `m${Math.ceil(seconds / 60)}` : `s${Math.ceil(seconds / 10)}`;
}
