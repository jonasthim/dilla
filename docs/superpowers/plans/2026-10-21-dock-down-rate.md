# The dock's down rate is never a dash in a working call: plan

**Context:** On the deployed web3.10 (2026-10-21), Jonas was alone in a call, muted and deafened. The dock read `0 ms · ↑1 ↓— kb/s`, and he asked "why is kb/s '-'?".

**Cause:** `readLink` in `packages/web/src/call/session.ts` (around line 1310) reads `pcManager.subscriber.getStats()`. When nothing is subscribed, LiveKit has no subscriber peer connection, so the read is `undefined`. The engine may also run in single-peer-connection mode, where inbound RTP sits on the publisher connection. `linkSample` treats a missing report as "this tick had no read" and returns null, and the dock shows "—" for null. The dash is meant for a read that failed, not for "nothing to receive".

## Task FD1 (sonnet): read the down rate correctly
- **Missing vs failed:**
  - A missing subscriber connection (`pcs.subscriber` undefined, or `getStats` absent) means nothing is received. Down is 0, unless the publisher report carries inbound-rtp entries (single-PC mode).
  - Only a `getStats` that rejects counts as "no read", which gives null and the existing one-tick carry, then "—".
  - Make `readLink` pass a distinct marker for "no connection" and "failed" to `linkSample`, or resolve it before the call.
- **Count inbound-rtp from every report** that exists (publisher and subscriber). Dedupe by stats id, so single-PC mode counts the down rate once. Per-stream totals stay keyed by id.
- **Ping under 1 ms:** an RTT that rounds to 0 shows as `<1 ms` (`voice.dock.pingSub` '<1 ms'). A real 0 is a LAN, not a missing reading. Add the string to flow 06 and its test.
- **Tests (`stats.test.ts` / `session.test.ts`):**
  - no subscriber connection gives ↓0;
  - a rejected subscriber `getStats` gives null, then the dash after one tick;
  - single-PC inbound on the publisher report is counted once;
  - an RTT of 0.0004 s shows `<1 ms`.
- **Gates:** web vitest (`call/`, `VoiceView`, strings), ui vitest (VoiceDock), typecheck, `npm run lint`, check:copy.
- **Release:** a client-only patch, v0.1.0-web3.10.1. Release notes; schema 20, store 5 and wire 2 unchanged.
