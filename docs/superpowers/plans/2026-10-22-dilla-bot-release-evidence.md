# Dilla Bot release evidence — 22 October 2026

This is an implementation checkpoint for `feat/dilla-bot`, not a release sign-off. The complete-release gate in [the plan](2026-10-21-dilla-bot.md) remains in force. The bot is a separate Linux service on the same host as `dillad`; Spotify authorization belongs in Dilla server settings. Librespot is the selected Spotify playback backend.

## Verified on this branch

- `npm test -w @dilla/client-core`: 57 files, 2,049 tests passed after the join-role worker changes.
- `npm test -w @dilla/web`: 112 files, 2,227 tests passed after registering the join-role copy in flow 08.
- `npm run lint`, both client/web typechecks, the web production build, `npm run check:docs`, `npm run vectors`, and the brief/copy/CSS/CI checks passed.
- `go test ./...` passed after the wire-v3, managed-bot fixture, and SFU fixed-port test repairs. Focused race tests passed for the new reaction and signed-removal paths. A local PostgreSQL 17 container passed full `internal/store` and `internal/api` packages with `DILLA_TEST_PG` set.
- The recent reaction-role grant changes and signed-removal retry were independently reviewed. The identified channel/message deletion cleanup races were fixed and re-reviewed; the final incremental review found no further concrete defect in that range.
- The constrained join-role approval is visible in server settings. Its GET and PUT APIs require current `manage_roles`; PUT compares the expected installation ID under the community lock, so a replacement bot cannot receive a stale setting. The UI states clearly that automatic assignment is not active yet. Focused Go, client and web tests, typechecks, lint, and protocol-doc checks pass for this path.
- Moderation evidence retention now processes one bounded page during each installation reconciliation pass, with its cursor persisted in encrypted bot state. A restart-resume test passes, and an independent review found no concrete defect in the retention change. The service reports a bounded removed-record count or a fixed failure stage without logging backend state text.
- The full `cargo test -p dilla-core --features vectors` and `cargo test -p dilla-bot-core` suites passed after the typed interaction binding change. The focused Rust tests, library clippy/check, formatting gate, and earlier WASM build/size gate passed too.

## Open release blockers

1. **Encrypted interactions:** kind-3 Bot interaction groups remain refused by the Go dispatcher. The v2 binding now includes participant device ID, but Rust load, Welcome, registration and the server must validate the actual authenticated roster end to end; admitting groups now would bypass those checks. Consequently the settings/command control plane is not fully reachable.
2. **Production music path:** `cmd/dillabot` reconciles identities and performs welcome/announcement passes, but does not own persistent interaction/event dispatch or connect queue revisions to voice-channel supervisors. YouTube PCM is fail-closed with `ErrSandboxUnavailable` until a production subprocess egress broker is implemented and tested.
3. **Spotify qualification:** the local pinned librespot probe builds as version 0.8.0 and synthetic PCM through FFmpeg passes. The dependency doctor sees yt-dlp 2026.8.19, FFmpeg/ffprobe 9.0.2, and Node 24.15.0, but reports provider qualification unverified. No dedicated Premium account was connected (`DILLA_PROBE_STATE` is unset); actual librespot audio, playlist expansion, playback controls, and encrypted browser playback on the intended host remain unverified. The qualification gate cannot be inferred from passing unit tests.
4. **Community and moderation integration:** one constrained join-role approval can now be configured, but automatic role assignment on a membership episode is not wired. The existing role-grant service deliberately fails closed until an episode-bound, idempotent server mutation and current approver-rank check are available. A complete music panel, encrypted moderation evidence access, and whole-release browser scenarios remain open. Full backup/restore acceptance has not been run.

The broad `go test ./...` failures were limited to stale wire-v3 and managed-bot test fixtures and an SFU test's fixed UDP port collision. Those fixtures were corrected, and the whole-repository rerun passed after the final interaction-binding and fail-closed YouTube changes. No live deployment or release has been performed.
