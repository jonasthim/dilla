// UP7b fix round 2 (N1): upgrade.spec.ts tolerates livekit's "Received leave request while trying to (re)connect" only for
// the SFU's DisconnectReason PARTICIPANT_REMOVED (4), never DUPLICATE_IDENTITY (2), which a page's double start would give.
// This pins the tag (it reads `error.context`, the DisconnectReason, not `error.reason`, which is LeaveRequest = 4 for every
// leave) and the tolerated pattern, in Node: no browser, no host.
import { expect, test } from '@playwright/test';
import { OUTAGE_LINES, tagLeaveReasons } from './support/outage-lines';

/** livekit-client 2.22.3's ConnectionError as `leaveRequest(message, leave.reason)` builds it: reason LeaveRequest (4), the
 *  SFU's DisconnectReason in `context` (esm.mjs:12346, 19324). */
const leaveError = (context: number) => Object.assign(new Error('Received leave request while trying to (re)connect'),
  { name: 'ConnectionError', reason: 4, context });

/** The line a page prints for `log.error(error.message, { error })` once tagLeaveReasons wrapped console.error, as Chromium
 *  shows it (its fields) and as Firefox does (a JSHandle). */
function printed(context: number): { chromium: string; firefox: string } {
  const seen: unknown[][] = [];
  const saved = console.error;
  console.error = (...args: unknown[]) => { seen.push(args); };
  try {
    tagLeaveReasons();
    const error = leaveError(context);
    console.error(error.message, { room: 'r', roomID: 'RM_x', participant: 'p', participantID: 'PA_y', error });
  } finally {
    console.error = saved;
  }
  expect(seen).toHaveLength(1);
  const [message, , tag] = seen[0] as [string, unknown, string];
  return {
    chromium: `${message} {room: r, roomID: RM_x, participant: p, participantID: PA_y, error: ConnectionError: Received leave request while trying to (re)connect\n    at U.leaveRequest (http://127.0.0.1:8561/assets/x.js:1:1)…} ${tag}`,
    firefox: `${message} JSHandle@object ${tag}`,
  };
}
const tolerated = (line: string): boolean => OUTAGE_LINES.some((r) => r.test(line));

test('a leave the SFU sends for PARTICIPANT_REMOVED (4) is tolerated in an outage window, in both engines', () => {
  const line = printed(4);
  expect(line.chromium).toMatch(/\[leave reason 4\]$/);
  expect(tolerated(line.chromium)).toBe(true);
  expect(tolerated(line.firefox)).toBe(true);
});

test('a DUPLICATE_IDENTITY (2) leave, a double start, is refused although its error.reason is 4 too', () => {
  const line = printed(2);
  expect(line.chromium).toMatch(/\[leave reason 2\]$/);
  expect(tolerated(line.chromium)).toBe(false);
  expect(tolerated(line.firefox)).toBe(false);
  // An untagged line (no init script) is refused as well.
  expect(tolerated('Received leave request while trying to (re)connect JSHandle@object')).toBe(false);
});
