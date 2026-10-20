// The message log's folding rules (R29): which rows continue the author's run above them, and which rows start a day.
import type { TimelineItem } from '@dilla/client-core';
import { formatDay, t } from '../../strings/index.ts';

/** A row continues the run above it when the same author wrote it within this many seconds of that row. */
export const GROUP_SECONDS = 7 * 60;

const dayStart = (ts: number): number => {
  const d = new Date(ts * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const DAY_MS = 24 * 60 * 60 * 1000;

/** True when `item` starts a local day that the row above it (if any) is not in. */
export function startsDay(prev: TimelineItem | undefined, item: TimelineItem): boolean {
  return prev === undefined || dayStart(prev.ts) !== dayStart(item.ts);
}

/** The divider's name: today, yesterday, else the date. `nowMs` is the clock the log was rendered with. */
export function dayLabel(ts: number, nowMs: number): string {
  const days = Math.round((dayStart(nowMs / 1000) - dayStart(ts)) / DAY_MS);
  if (days === 0) return t('layout.log.today');
  if (days === 1) return t('layout.log.yesterday');
  return formatDay(ts);
}

const readable = (item: TimelineItem) => item.state === 'ok' || item.state === 'pending' || item.state === 'failed';

/**
 * Whether `item` folds into the run above it: the same known author, both shown, within 7 minutes of the row above (not of the
 * run's first row), the same day (a divider between always starts a group), and `item` answers nothing (a reply line names
 * its context, so it keeps its own head).
 */
export function groupedWithAbove(prev: TimelineItem | undefined, item: TimelineItem): boolean {
  if (prev === undefined || item.senderUser === null || prev.senderUser !== item.senderUser) return false;
  if (!readable(prev) || !readable(item) || item.reply !== null) return false;
  if (startsDay(prev, item)) return false;
  const gap = item.ts - prev.ts;
  return gap >= 0 && gap <= GROUP_SECONDS;
}
