# SP-21 — LiveKit v1.13.7 webhooks, end to end in process

Question: what does the in-process LiveKit v1.13.7 deliver to a webhook receiver, how fast, in what
order, what happens when the receiver fails, and does a mismatched `webhook.api_key` fail the boot
instead of panicking? The receiver task 12 builds is decided by the answers. The controller's ruling
for this task adds one more: how long a killed client takes to become `participant_left` (the facts
derived 20–22 s from source; task 12 writes the number into protocol/09).

Rig: `internal/sfu/spike_webhooks_test.go`
(`go test -tags spike -count=1 -v -run 'TestSpike(Webhook|Mismatched|Crash)' ./internal/sfu/`, run with
`GOMAXPROCS=4` to match the CI runner), dilla's own `sfu.Start` with task 8's `webhook` block
(`api_key` = the `keys:` key, `urls: [<httptest loopback>/livekit/webhook]`, the seven
`include_events`), `room.auto_create: false` with every room opened by `CreateRoom`,
`departure_timeout: 20`, Go `lksdk` participants on loopback, and a receiver that verifies **every**
POST with `webhook.ReceiveWebhookEvent` (also the ones it refuses, so each attempt is attributed to an
event id) and answers in microseconds. The killed client is a child process (the test binary
re-executed into `TestSpikeCrashChildParticipant`) that joins, publishes an Opus track, pumps silence
every 20 ms and is then `SIGKILL`ed by the parent once its `track_published` arrived (RTP flowing,
ICE connected) and 3 s more passed; ten children in ten rooms, killed 700 ms apart.
Commit, date, host and `go version` of the run: `c741fce2c4a23fd7bcfa73dde0d180db23988ba0` with the
spike file uncommitted (it is committed unchanged with this document), `2026-10-04`, `jonas-pc`
(16 threads, `GOMAXPROCS=4`), `go version go1.27.0 linux/amd64`. The whole run was made twice; both
runs are quoted below. After them, a lint fix changed one line of the rig (`exec.Command` →
`exec.CommandContext(t.Context(), …)` for the crash child, golangci-lint's `noctx`), so run 3 repeated
`TestSpikeCrashLeaveLatency` on the committed file; the other tests did not change.

## Results

| # | measurement | expected (facts) | measured | pass criterion | pass |
|---|---|---|---|---|---|
| 1 | `participant_joined` after `ConnectToRoomWithToken` returns, 20 cycles | p50 < 100 ms (notifier p50 44 µs, p99 241 µs, plus the telemetry queue hop; G28) | arrives **before** the call returns in 20 of 20 cycles (run 1: p50 −9.33 ms, max −8.45 ms; run 2: p50 −9.31 ms, max −8.26 ms). From the start of the call: run 1 p50 2.49 ms, p95 2.93 ms, max 3.68 ms; run 2 p50 2.50 ms, p95 3.32 ms, max 3.52 ms | p95 < 1 s | pass |
| 2 | `participant_left` after `Disconnect()`, 20 cycles (graceful leave) | immediate (LeaveRequest; G29 E6) | run 1: p50 198 µs, p95 255 µs, max 339 µs; run 2: p50 189 µs, p95 244 µs, max 534 µs | p95 < 1 s | pass |
| 3 | per-room order joined → left | FIFO per room (`EventKey` = room name, one worker per key) | 0 violations in 20 rooms, each room exactly `room_started → participant_joined → participant_left → room_finished` (both runs). Under failure too: in row 7, room 0's `participant_joined` waited behind its failing `room_started` until those 5 attempts were spent | 0 | pass |
| 4 | duplicate event ids in 20 cycles | 0 without retries | 0 of 80 events (both runs); under retries (row 7) every attempt of one event carried the same id | 0 | pass |
| 5 | `track_published` for an `Encryption_NONE` publication | `encryption=NONE type=AUDIO source=MICROPHONE` | `encryption=NONE type=AUDIO source=MICROPHONE mime=audio/opus`, 23.0 ms / 22.8 ms after `PublishTrack` | as expected | pass |
| 6 | `track_published` for an `Encryption_CUSTOM` publication | `encryption=CUSTOM` | `encryption=CUSTOM type=AUDIO source=MICROPHONE mime=audio/opus`, 22.1 ms / 22.5 ms after `PublishTrack` | as expected | pass |
| 7 | attempts per event while the receiver answers 500 | 5, at +0, +1, +3, +7, +15 s (retryablehttp `RetryMax 4`) | 5 per event for every event dequeued while down, at exactly +0, +1, +3, +7, +15 s from its first attempt (23 attempts answered 500 over 6 events; both runs identical) | ≤ 5 per event | pass |
| 8 | events delivered after the receiver recovers at +35 s | none of the three rooms' early events (attempts exhausted by ~+26 s; `max_age` 30 s) | lost: `room_started` and `participant_joined` of room 0, `room_started` of room 1. **Delivered:** `room_started@spike-down-2` on its 5th attempt at +35 s, `participant_joined@spike-down-2` at +35 s, `participant_joined@spike-down-1` at **+40 s, 30 s after it was queued** (both runs identical) | the early events are lost | **fail** |
| 9 | mismatched `webhook.api_key` | `ErrWebHookMissingAPIKey` "api_key is required to use webhooks" from `InitializeServer` (wire_gen.go:224-233) | `api_key is required to use webhooks`, `errors.Is(err, service.ErrWebHookMissingAPIKey) = true`, no panic; `sfu.Start` with a webhook URL boots, because it renders `api_key` from `Config.APIKey` | the error, no panic | pass |
| 10 | crash leave (transport dies without a Leave) | 20–22 s (ICE 15–17 s + 5 s cleanup) | **run here** with a `SIGKILL`ed Go participant process (not a browser renderer, which stays NV-1): 10 of 10 `participant_left` (none `participant_connection_aborted`), min 20.41 s, p50 21.13 s, max 21.85 s; runs 2 and 3 reproduced every value within 10 ms | inside 20–22 s | pass |
| 11 | *(added)* `room_finished` after the last `participant_left` | `departure_timeout` 20 s | run 1: min 19.74 s, p50 20.60 s, max 20.73 s; run 2: min 19.64 s, p50 19.76 s, max 19.89 s | ≈ 20 s | pass |
| 12 | *(added)* attempts while the receiver answers 503 with `Retry-After: 1` | `Retry-After` honoured for 503 (G28) | 5 attempts at +0, +1, +2, +3, +4 s, then the event is gone (both runs) | honoured | pass |

Why row 8 fails: `max_age` is checked once, when an event is **dequeued**
(`livekit/protocol` `webhook/resource_url_notifier.go`, `Process`: `queueDuration > MaxAge` drops it
before `send`), never during its retries. An event queued behind a failing event of the same room
waits up to 15 s, is dequeued younger than 30 s, and then gets its own 15 s of retries. So a webhook
can arrive up to about 30 s + 15 s ≈ 45 s after LiveKit queued it; this run saw 30 s. The pre-written
expectation treated `max_age` as a bound on delivery; it is only a bound on the wait in the queue.

Row 10, shape: the ten latencies fall in three clusters (20.41–20.49, 21.09–21.17, 21.72–21.85 s)
that step down by about 0.68 s per 0.7 s of kill spacing; in absolute time the ten
`participant_left` arrivals land in groups about 2 s apart, which is what a periodic 2 s failure
check over ten connections that joined within a short window produces. The rig schedules every
child the same way, so runs 2 and 3 repeating run 1 to 10 ms say the phase was set by the rig, not
that the real spread is that narrow: the source bound
(15–17 s ICE failure at a 2 s check, plus the 5 s `disconnectCleanupDuration`; G29 E6) remains the
figure to state.

Not run here: a browser renderer `SIGKILL` (NV-1; the Go child kills the same two transports — the
signalling WebSocket and the ICE/UDP socket — but no browser was driven), TURN/UDP and TURN/TCP legs
(G29's S-G29a), and anything off loopback.

Raw output, run 1 (`SPIKE` lines verbatim):

```text
SPIKE joined_latency (from ConnectToRoomWithToken's return) n=20 min=-9.989152ms p50=-9.329866ms p95=-8.502853ms max=-8.453213ms; arrived before the return: 20
SPIKE joined_latency_from_connect_start n=20 min=2.203173ms p50=2.49039ms p95=2.931887ms max=3.68021ms
SPIKE left_latency n=20 min=149.779µs p50=197.869µs p95=254.807µs max=339.457µs
SPIKE room_finished_after_participant_left n=20 min=19.742606266s p50=20.597902571s p95=20.715209147s max=20.728536891s (departure_timeout 20 s)
SPIKE per_room_order_violations=0 duplicate_ids=0 events=80 rooms=20 sequence=[room_started participant_joined participant_left room_finished]
SPIKE track_published pub-none: encryption=NONE type=AUDIO source=MICROPHONE mime=audio/opus after=22.980018ms
SPIKE track_published pub-custom: encryption=CUSTOM type=AUDIO source=MICROPHONE mime=audio/opus after=22.102396ms
SPIKE receiver_recovered_at=+35s
SPIKE attempts_while_down=23 (answered 500) events_attempted=6 unverified=0
SPIKE attempt room_started@spike-down-0 id=EV_SPpC2vigQVTB attempts=5 at=[+0s +1s +3s +7s +15s] status=[500 500 500 500 500]
SPIKE attempt room_started@spike-down-1 id=EV_mbBnx43emNq5 attempts=5 at=[+10s +11s +13s +17s +25s] status=[500 500 500 500 500]
SPIKE attempt participant_joined@spike-down-0 id=EV_bSZzY8auntfD attempts=5 at=[+15s +16s +18s +22s +30s] status=[500 500 500 500 500]
SPIKE attempt room_started@spike-down-2 id=EV_9VUqYNL79oBd attempts=5 at=[+20s +21s +23s +27s +35s] status=[500 500 500 500 200]
SPIKE attempt participant_joined@spike-down-1 id=EV_g3XAnYqmWhR7 attempts=5 at=[+25s +26s +28s +32s +40s] status=[500 500 500 500 200]
SPIKE attempt participant_joined@spike-down-2 id=EV_2TmMhcs7PTxt attempts=1 at=[+35s] status=[200]
SPIKE delivered_after_recovery=[room_started@spike-down-2(+35s) participant_joined@spike-down-2(+35s) participant_joined@spike-down-1(+40s)]
SPIKE retry_after_1_attempts=5 at=[room_started+0s room_started+1s room_started+2s room_started+3s room_started+4s]
SPIKE crash crash-00: participant_left after 21.85s
SPIKE crash crash-01: participant_left after 21.17s
SPIKE crash crash-02: participant_left after 20.49s
SPIKE crash crash-03: participant_left after 21.81s
SPIKE crash crash-04: participant_left after 21.13s
SPIKE crash crash-05: participant_left after 20.45s
SPIKE crash crash-06: participant_left after 21.77s
SPIKE crash crash-07: participant_left after 21.09s
SPIKE crash crash-08: participant_left after 20.41s
SPIKE crash crash-09: participant_left after 21.72s
SPIKE crash_left_latency n=10 min=20.405311914s p50=21.128243844s p95=21.853167138s max=21.853167138s events=map[participant_left:10]
SPIKE mismatched_api_key: api_key is required to use webhooks (is ErrWebHookMissingAPIKey: true)
SPIKE start_with_webhook_url: boots (api_key rendered from Config.APIKey)
```

Raw output, run 2 (the lines that differ from run 1; the attempt schedules, the delivered list, the
`Retry-After` schedule and the per-child crash values repeated exactly, with new event ids):

```text
SPIKE joined_latency (from ConnectToRoomWithToken's return) n=20 min=-9.487225ms p50=-9.311337ms p95=-8.319804ms max=-8.257245ms; arrived before the return: 20
SPIKE joined_latency_from_connect_start n=20 min=2.103393ms p50=2.50361ms p95=3.322774ms max=3.520492ms
SPIKE left_latency n=20 min=140.079µs p50=189.268µs p95=243.678µs max=534.006µs
SPIKE room_finished_after_participant_left n=20 min=19.638651083s p50=19.75561692s p95=19.873358602s max=19.886850846s (departure_timeout 20 s)
SPIKE track_published pub-none: encryption=NONE type=AUDIO source=MICROPHONE mime=audio/opus after=22.77909ms
SPIKE track_published pub-custom: encryption=CUSTOM type=AUDIO source=MICROPHONE mime=audio/opus after=22.518632ms
SPIKE crash_left_latency n=10 min=20.405137442s p50=21.129396662s p95=21.851913464s max=21.851913464s events=map[participant_left:10]
```

Raw output, run 3 (`TestSpikeCrashLeaveLatency` alone, on the committed file):

```text
SPIKE crash crash-00: participant_left after 21.86s
SPIKE crash crash-01: participant_left after 21.18s
SPIKE crash crash-02: participant_left after 20.49s
SPIKE crash crash-03: participant_left after 21.81s
SPIKE crash crash-04: participant_left after 21.13s
SPIKE crash crash-05: participant_left after 20.45s
SPIKE crash crash-06: participant_left after 21.77s
SPIKE crash crash-07: participant_left after 21.09s
SPIKE crash crash-08: participant_left after 20.41s
SPIKE crash crash-09: participant_left after 21.72s
SPIKE crash_left_latency n=10 min=20.405083126s p50=21.129515604s p95=21.856407093s max=21.856407093s events=map[participant_left:10]
```

## What this means

- Webhooks are **lossy by construction**: 5 attempts within ~15 s on a 5xx, then dropped; anything
  older than 30 s when dequeued, or past 200 queued per room, is dropped; a 4xx counts as sent.
  Nothing in the call lifecycle may depend on one webhook alone.
- Webhooks are also **late**: `max_age` bounds the wait in the queue, not delivery. After a receiver
  outage or a backlog an event can arrive up to ~45 s after it happened (30 s measured), and it
  arrives in room order behind everything older. A handler must judge an event against the current
  state, not trust it as news.
- A `503` with `Retry-After: 1` buys exactly four more seconds (attempts at +1…+4 s); a full queue
  that lasts longer loses the event.
- Order holds **per room only**; events of different rooms interleave freely.
- The receiver must answer in microseconds: one slow answer stalls every later event of that room.
- `participant_joined` is emitted when the participant turns active, before the Go SDK's connect call
  returns; a graceful leave reaches the receiver in under a millisecond on loopback; a killed client
  takes 20.4–21.9 s (source bound 20–22 s) and is reported as `participant_left`, not
  `participant_connection_aborted`, once it had connected.

## Decision (task 12 consumes it)

1. The receiver is its own loopback listener, `livekit.webhook_listen` (default `127.0.0.1:7883`),
   serving exactly `POST /livekit/webhook`; LiveKit's `webhook.urls` points at it.
2. `sfu.NewWebhookHandler` verifies with `webhook.ReceiveWebhookEvent`, enqueues without blocking and
   answers **200**; a bad signature is **401** (LiveKit does not retry a 4xx, correct for a forgery);
   a full queue is **503** with `Retry-After: 1` (measured: honoured, four more attempts one second
   apart, so the queue must drain within ~4 s). One worker dispatches, deduplicating on
   `WebhookEvent.Id` (measured: a retried event resends the same id).
3. `api.CallEvents` tolerates cross-room interleaving and a missing **or late** event: the `/rtc` join
   gate, the delivery service's call evictor and `room.auto_create: false` hold without webhooks;
   webhooks add `voice_state`, mid-call Remove proposals, the F11 checks and the lease reconciliation.
   Because an event can arrive up to ~45 s late (row 8), a `participant_left` /
   `participant_connection_aborted` changes state only if the departed identity is not in the room
   now (LiveKit's participant list, or the participant `Sid` the handler recorded at
   `participant_joined` differs from the event's): a stale leave delivered after the device rejoined
   (and, through the HTTP routes, re-took its sharing slot) must neither release that slot nor
   propose its Remove.
4. protocol/09 § Voice states the measured graceful-leave latency (row 2: under a millisecond on
   loopback, p95 255 µs) and the crash figure: 20–22 s, measured 20.4–21.9 s with a killed Go
   participant (row 10); a browser renderer kill stays NV-1.
5. Rows 1–12 that did not pass, and what task 12 changes because of them:
   - **Row 8** (late delivery, not only loss). Task 12 step 8 (`internal/api/callevents.go`,
     `(*CallEvents).left`): before `leases.release` (which, after task 10's security fixes, goes
     through the per-call lock and reconcile path) and before `ProposeRemoveDevice`, drop a leave
     whose identity is present in the room under another participant `Sid` (item 3); task 12 step 5
     gains a test for it (a stale `participant_left` after a rejoin and share changes nothing).
     Task 12 step 3's receiver comment ("until they age past 30 s and are dropped") becomes "until
     they wait 30 s in the queue; a dequeued event retries for 15 s more, so delivery can be ~45 s
     late". The receiver itself (step 1's and step 3's tests and code) is unchanged.
