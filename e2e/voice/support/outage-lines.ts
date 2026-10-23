// UP7b (calls survive an upgrade): the console lines upgrade.spec.ts tolerates inside an outage window, and the init script
// that tags livekit's leave lines with the SFU's reason. Kept apart so upgrade-lines.spec.ts can pin them without a browser.

/** Console lines a page prints while its instance does not answer or reloads mid-call (a refused connection, a dropped
 *  socket), both engines. Tolerated only inside an outage window (`tolerate`), never elsewhere. */
export const OUTAGE_LINES: RegExp[] = [
  /^Failed to load resource: net::ERR_CONNECTION_REFUSED$/,
  /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:8561\/[^']*' failed/,
  /^\[JavaScript Error: "Firefox can.t establish a connection to the server at ws:\/\/127\.0\.0\.1:8561\//,
  // livekit-client's own log (Chromium prints its fields, Firefox a JSHandle): the signal socket the outage closed, its
  // reconnect's unreachable server and timed-out connect, and (case A, the SFU restarted) the room a reconnect asks for gone;
  // the page then rejoins through a start.
  /^error reading from signal stream (\{room: .*error: ConnectionError: WS closed unexpectedly with code 1006|JSHandle@object$)/s,
  /^(Failed to fetch \{room: .*ConnectionError: Failed to fetch|NetworkError when attempting to fetch resource\. JSHandle@object$)/s,
  /^room connection has timed out \(signal\) (\{room: |JSHandle@object$)/,
  /^requested room does not exist (\{room: .*ConnectionError: requested room does not exist|JSHandle@object$)/s,
  // UP7b fix rounds 1 and 2 (I3, N1): a reconnect told to leave by the SFU, tolerated only for DisconnectReason
  // PARTICIPANT_REMOVED (4; tagLeaveReasons appends the SFU's reason). A DUPLICATE_IDENTITY (2), which a page's double start
  // would give, is never tolerated (upgrade-lines.spec.ts pins both); each step counts every page's starts as well.
  /^Received leave request while trying to \(re\)connect (\{room: .*ConnectionError: Received leave request|JSHandle@object).* \[leave reason 4\]$/s,
  // The peer connection an outage or the SFU's restart closed takes its data channels with it.
  /^DataChannel error on (lossy|reliable): User-Initiated Abort, reason= ?(\{room: |JSHandle@object$)/,
  /^publisher data channel '[A-Z_]+' closed unexpectedly ?(\{room: |JSHandle@object$)/,
  // UP7b: with the instance noticed within 2 s, the peers come back almost together, and livekit-client logs a track whose
  // publication reached it before that participant's own join update. In 2.22.3 a connected room DROPS that track
  // (esm.mjs:35227-35234; only a room still connecting defers it), so nothing recovers it by itself: every step that can
  // log this ends in allHear(), which fails if a remote track was lost.
  /^Tried to add a track for a participant, that's not present\. Sid: PA_[A-Za-z0-9]+ ?(\{room: |JSHandle@object$)/,
];

/**
 * UP7b fix rounds 1 and 2 (I3, N1): livekit-client logs "Received leave request while trying to (re)connect" with the SFU's
 * leave reason only inside the error object: `ConnectionError.leaveRequest(message, leave.reason)` (2.22.3 esm.mjs:19324,
 * 12346) puts the DisconnectReason in `error.context`; `error.reason` is ConnectionErrorReason.LeaveRequest (4) for every
 * leave. This init script appends the DisconnectReason as `[leave reason N]`, so OUTAGE_LINES can tolerate one only. It
 * runs in the page (addInitScript), so it is self-contained.
 */
export function tagLeaveReasons(): void {
  const original = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    if (typeof args[0] === 'string' && args[0].startsWith('Received leave request while trying to (re)connect')) {
      const reason = (args[1] as { error?: { context?: unknown } } | undefined)?.error?.context;
      original(...args, `[leave reason ${String(reason)}]`);
      return;
    }
    original(...args);
  };
}
