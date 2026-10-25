# Upstream merge report

## Merge record

- Feature parent: `67179465dbc4af69cf6b8005edd460f2429e6c22`.
- Upstream: `1f7443f4` (`fullscreen user and server settings workspaces`, PR #112).
- Strategy: merge `origin/main` into `feat/structured-slash-commands`; prior feature commits and IDs are preserved.
- Actual content conflicts: `core/dilla-core/src/bot/mod.rs`, `core/dilla-core/tests/bot_vectors.rs`, `internal/bot/protocol/codec.go`, `packages/client-core/src/worker/controller.ts`, and `packages/client-core/src/worker/controller.test.ts`.

## Resolutions and integration

- Kept the selective response ACK leases and exact request filtering from the transport. Added read operations 0 and 24 to worker request/response allowlists, and retained operations 3, 70–75, and 80–84.
- Added operation 24 to Rust and Go request codecs as read-only, no-channel, no-argument traffic. The Rust response binding changes from upstream remain intact: operations 0/24 require the exact request and community with null outer channel. Combined the operation lists in the shared-vector tests and JSON; no vectors were regenerated or removed.
- Replaced the private provider-status operation number in command capability discovery with `protocol.OpMusicProvidersStatus`; the status capability still requires Music and Manage Community.
- Migrated the extracted `bot-settings-context` response poller to send exact request IDs, persist only matching request/community/operation/null-channel responses, then ACK with the opaque lease. Removed delivery cursor arithmetic and delivery-ID equality checks.
- Migrated `MusicProviderStatus` to the shared Bot interaction client for sequential capability operation 0 and provider-status operation 24 reads. Its adapter filters by exact request ID and ACKs the read lease. The manager-only settings GET remains unchanged.
- Kept the upstream fullscreen settings routes, dirty-edit guard, and Bot settings provider. The slash-command provider remains around the shell and route outlets, with command hosts on normal and thread composers. Existing GIF and invite prefills remain connected.
- Updated the Bot settings page test call trace for its new member-safe command-status read.

## Checks

- `cargo fmt --all -- --check` — passed.
- `cargo test -p dilla-core --features vectors --quiet` — passed across the crate suites.
- `go test ./internal/bot/protocol ./internal/bot/service ./cmd/dillabot -count=1` — passed.
- `npm test -w @dilla/protocol-vectors` — 143 tests passed; merged JSON parsed successfully.
- `npm test -w @dilla/client-core -- --run src/bot/protocol.test.ts src/worker/controller.test.ts` — 426 tests passed.
- `npm run typecheck -w @dilla/client-core` and `npm run typecheck -w @dilla/web` — passed.
- Web Bot consumer/provider focused tests — 65 tests passed. The preceding wider focused batch passed 134 tests across seven files and exposed one stale BotSection call-trace expectation; the expectation was updated and its file passed in the focused rerun.
- Fullscreen router/settings/edit-state/Bot page tests — 163 tests passed.
- `npm run check:docs`, `git diff --check`, and `git diff --cached --check` — passed.

Browser E2E was not run as part of this merge integration.
