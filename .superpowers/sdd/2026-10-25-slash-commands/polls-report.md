# Poll backend report

Implemented the durable poll backend in `internal/bot/polls/` and the interaction handlers in `internal/bot/service/poll_interactions.go`.

- Native encrypted state uses area 8 and separate metadata, per-user vote, and actor/request receipt keys. Create quota reservation, vote counts, vote replacement/withdrawal, early close, and durable mutation outcomes are committed with CAS transactions. Poll IDs equal create request IDs; replay outcomes survive store recreation.
- Handlers bind requests to the configured community, require human actors and current membership, and recheck the actor's effective channel permissions on each operation. View, send, manage-messages, and read-history masks match `internal/api/perm.go` and `protocol/vectors/permissions.json` (manage messages is bit 2).
- Publication uses `PollPublisher.PublishPoll(ctx, polls.Poll)`. Create returns unavailable when publishing or receipt persistence fails. `Reconcile` retries the same poll ID and closes expired polls from absolute Unix deadlines.
- List and voter pagination use bounded opaque cursors scoped to community/channel/thread or poll/option. Reads and response pages are bounded.

Tests added in `internal/bot/polls/store_test.go` and `internal/bot/service/poll_interactions_test.go` cover vote replacement/withdrawal, single/multi choice constraints, deadlines, early close, read permissions, community and actor checks, stale revisions, durable replay and request ID reuse, publication recovery, concurrent counts, cursor scoping/size, and the 128 open-poll quota.

Verification:

- `go test ./internal/bot/polls ./internal/bot/service` — passed.
- `go test -race ./internal/bot/polls ./internal/bot/service` — passed.
- `go vet ./internal/bot/polls ./internal/bot/service` — passed.
- `go test ./internal/bot/...` — poll and service packages passed. The wider run had unrelated failures: identity tests could not find `internal/mlswasi/testdata/dilla_core_wasi.wasm`; `TestIsolatedMetadataRunnerUsesArgvWithoutShellExpansion` failed with `youtube: metadata extraction failed`.

The runtime must provide a `PollAuthority` that resolves the authenticated human's current channel permissions and community membership, plus a durable publisher that records the same poll ID as its external operation receipt.
