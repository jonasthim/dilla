# Combined security and realtime acceptance

Status: complete implementation; final browser matrix and remote CI pending. One draft PR contains the full scope. No release or deployment is authorized by this status alone.

## Independent review

Two independent read-only reviews found seven unique Important issues. Regression tests reproduced each before the fix: terminal refusal cleanup after restart; disabled/log-only receipt reconciliation; capability-revoked accepted receipts; journal aging of durable moderation failures; removal proof recovery after membership loss; cache-capacity deferral classification; and unresolved build-hint verification. All targeted fixes pass under race; no deferred minors.

## Verified so far

- Full Go package suite and all 942 API race tests (four exhaustive disjoint shards); focused final authority/moderation/rate race suites.
- Full Rust workspace/all-features; native helper socket suite 16/16. The initial unread-stderr-pipe hang is preserved and fixed without changing protocol assertions.
- Full JavaScript workspace tests and lint; final update watcher 10/10; TypeScript web/e2e checks; shipping build.
- Three-engine real-browser transport probes 6/6: fifteen idle minutes, no recurring version/activity/stats HTTP on healthy wire 5, real input coalescing, reconnects, build verification and legacy fallback.
- Two-engine live-call transport/update probes 2/2; existing Chromium voice suite and correctly configured Firefox voice suite passed applicable cases. Platform/noise-mode skips retain their existing conditions.
- Compiled-helper production dependency recovery tests run with accepted/absent receipts under both disabled and log-only policies; CI now downloads the same-commit helper and requires these integrations instead of silently skipping them.

The first Firefox runs lacked a reachable audio backend; explicit XDG_RUNTIME_DIR/PULSE_SERVER corrected that environment. Earlier baseline-failure classification is superseded by the corrected passing runs. Initial traces and logs remain in the task evidence archive. The full three-engine web matrix and final CI are still required.

## Implementation rulings

These are the ordered decisions from the execution ledger, including their tradeoffs.

1. Ruling: Apply the ordinary body deadline at NewHTTPServer's handler boundary, before any application read. Existing commit/blob route deadlines may extend it; outer defer clears for keep-alive. This avoids test-only code or changing every DecodeBody caller. Add a configurable server.read_body_timeout (default30s, zero falls back30s) for short real-transport tests. Non-body WebSocket upgrades are unaffected. Cost if wrong: route override tests must catch shortened upload budgets.

2. Ruling: Use 256 fixed hash-of-actor checkpoint shards and 1,024 reusable pending slots in protected area 8, with one native CAS committing touched shards + frontier + decision. Reusable slots bound tombstones too. A failed transaction reloads durable shards before another evaluation. Overflow defers without ACK. Cost if wrong: hostile concentration in a shard can defer intake rather than exceed 256 KiB.

3. Ruling: Persist the policy activation checkpoint after settings CAS and before acknowledging its PUT, including receipts during the CAS. If that second write fails the PUT fails; restart detects a missing matching policy checkpoint and seeds a conservative boundary once. This preserves the existing config interface and its retry receipts; no acknowledged boundary slides on restart. Cost if wrong: a failed/unacknowledged activation may conservatively classify additional events as historical.

4. Ruling: Add receipt_only=1 to the existing moderation acceptance routes, with identical session/signature/source identity validation and a no-write exit when no prior receipt exists. A changed/disabled/expired pending policy may reconcile an uncertain acceptance but cannot create a new effect. Persist accepted cases before attaching evidence so revocation cannot prevent a known receipt finishing local evidence. Case v3 adds an explicit refusal flag, retaining v2 reads.

5. Ruling: Bound native receipts specifically for new area-8 checkpoint-only transactions to the latest 64, retaining ordinary configuration/command receipts. The additive encrypted index has no core/helper wire-version change. After eviction, CAS + row/frontier reconciliation still prevents reapplying an old checkpoint. RED test retained 257 receipts instead of 65. Checkpoint snapshots also omit expired rolling/dedup entries so a long-lived actor cannot permanently fill a shard with old history (RED reproduced overflow after 3,000 benign spaced messages). Native byte-limited scan pages are bounded by total fixed rows, not an assumed 100 rows per page.

6. Ruling: Binding an anonymous token into an existing device debits its spent allowance against the device instead of discarding it. This is a conservative one-time rate reservation; ordinary waits still never reserve future tokens. Source waiters prevent merging, and only idle/full target entries may be pruned to make a combined target map fit. Cost if wrong: binding can defer rather than reset a live allowance.

7. Task 5: Ruling: wire-5 down migration maps its transport-only selection to wire 4 instead of deleting bearer sessions — wire 5 retains the exact wire-4 HTTP/attestation baseline, so rollback preserves authentication and live-call recovery — if the baseline later diverges, this mapping must be revisited before another rollback. SQLite up/down preservation is covered.

8. Task 5: Ruling: the served web handler is immutable during a process lifetime; advertise its verified entry on ready/resume, with no file watcher — deployment restarts the API and reconnect supplies the replacement handler's entry — a future in-process handler swap must explicitly publish its new verified entry.

9. Task 5: Ruling: pre-login fallback shows a manual update notice instead of reloading forms — no signed-in draft checkpoint exists there — unattended sign-in pages stay on the older build until a person finishes or reloads.

10. Task 6: Ruling: wire-5 sockets start Idle and become active only on real pointer/key input; legacy sockets retain their existing initial Online behavior — avoids fabricating input on wire-5 reconnect while preserving old clients — until a fresh input after reconnect the new tab can show Idle. Foreground and mount do not emit activity; heartbeat active is now zero and never changes the activity clock, even when an older sender sets it to one.

11. Task 6: Ruling: bound the shared activity allowance to 8192 devices per five-second window, fail closed at capacity — keeps authenticated device churn from growing the budget map without bound — excess new devices can remain Idle until the next window. HTTP and WSS coalesce silently on the same budget and never persist/replay input.

12. Task 6/7: Ruling: continue the stats implementation after Task 6's code commit while its unchanged long AFK browser gate runs — its unit/race/type gates are green and the running host/bundle are immutable; no rebuild until that browser run ends — any browser failure must be resolved before Task 6 is recorded complete or the combined PR is opened.

13. Task 7: Ruling: count running devices inside the 128 global telemetry-device slots — a tighter bound than 128 queued plus eight running is easier to reason about and always meets the queue ceiling — at saturation up to eight fewer new devices can queue. Each running device retains at most one replaceable latest sample, with no goroutine per report. Two-second job deadlines and a ten-second queue-age ceiling bound stale work.

14. Task 7: Ruling: preserve the existing bare HTTP handler's trusted-session integration contract while installing Sessions.ResolveHash explicitly in production CallStats — existing in-process API fixtures inject authorized contexts; production rechecks the exact bearer authority before and after repository work, and WSS additionally revalidates from the connection before the shared service — external embedders must install the resolver if their session authority can change during a request.

15. Task 6: Ruling: classify Firefox AFK case 9's unchanged microphone-tone failure as a pre-existing baseline limitation, not a transport regression — detached f53e213 main reproduced the identical enabled/connected-but-DTX failure (8 prior cases pass, final serial case does not run), with shipping baseline bundle and unchanged assertions/timeouts — full local browser runs remain non-green for this known baseline failure; independent review and required CI/release gates still apply, and no unrelated audio behavior or weaker test enters this PR. Evidence preserved in task6-browser-baseline, task6-browser-initial and task6-browser-rerun.

16. Task 7/8: Ruling: continue integration/docs work after the Task 7 code commit while its already-built voice suite and full Go race run finish — do not rebuild or change the served web assets while that suite runs — failures remain required gates before task completion or PR delivery, and rebased main's affected areas receive fresh checks.

17. Task 8: Ruling: inventory the actual current timers rather than the plan’s assumed Activity/Bot polling frequencies — Activity is a local slice view, reminders refresh at sixty seconds, and command status is on demand; retain encrypted interactions, AFK commands and the separate SFU RTT attribute path — moving those distinct authority/encryption workflows into the coarse telemetry frame would be an unreviewed scope expansion. Cost if wrong: some intentional HTTP requests remain, documented in docs/realtime-transport.md.

18. Task 8: Ruling: supersede the earlier Firefox baseline classification pending a correctly configured audio rerun — this shell omitted XDG_RUNTIME_DIR/PULSE_SERVER; pactl failed by default but succeeds at unix:/run/user/1000/pulse/native. Suspended contexts invalidate media checks on both baseline and branch. Interrupted the remaining invalid Firefox run, preserved all initial traces, and will rerun with the CI-required reachable audio backend. Cost if wrong: a branch media defect must still be diagnosed if it persists with audio available. No product assertions/timeouts changed.

19. Task 8: Ruling: start the two required independent read-only reviews against the frozen product implementation while final browser/whole-repository acceptance runs — Task 8 itself contains review and delivery, so its completion line cannot precede them — any subsequent product fix must be recorded and tested RED→GREEN; reviewers see the current docs/probes and ledger. Cost if wrong: a later implementation change needs explicit evidence rather than being silently covered by the old review. Reviewers security_protocol_final and whole_branch_final use gpt-6-astra/xhigh with fresh contexts; no implementer delegation.

20. Final: Ruling: plain Session(token) alias-rotation behavior is outside this fix pass because shipping callers bind SessionForDevice and no production failing path was established — device-bound sessions preserve the key — a future unbound caller must use the binding API or establish its own compatibility coverage.

21. Final: Ruling: retain synchronous presence authority lookup; no new contention defect was established and stats processing is separately bounded — current authority must be checked before recording input — a slow auth backend can delay a presence input/its socket reader; future measurements can justify a separate bounded mechanism.

22. Final: Ruling: durable moderation errors retain journal responsibility instead of the ordinary twenty-four-hour age-out — checkpoint overflow must not ACK and accepted effects require durable completion; there is no independent drain to take responsibility — prolonged native-store failure can block that journal until repaired, rather than silently abandon enforcement. Other age policies remain covered unchanged.

23. Task 8: Ruling: publish the complete implementation as one draft PR while the remaining full browser matrix runs — every planned subsystem and all seven review fixes are included, and remote CI can run concurrently — this is not acceptance or merge approval; mark ready/merge/release/deploy only after the required gates pass. Initial failures remain preserved, and the PR description identifies pending checks.
