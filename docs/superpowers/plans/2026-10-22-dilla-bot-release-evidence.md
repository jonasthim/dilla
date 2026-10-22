# Dilla Bot release evidence — 22 October 2026

This is an implementation checkpoint for `feat/dilla-bot`, not a release sign-off. The complete-release gate in [the plan](2026-10-21-dilla-bot.md) remains in force. The bot is a separate Linux service on the same host as `dillad`; Spotify authorization belongs in Dilla server settings. Librespot is the selected Spotify playback backend.

## Verified on this branch

- `npm test -w @dilla/client-core`: 57 files, 2,048 tests passed.
- `npm test -w @dilla/web`: 112 files, 2,224 tests passed.
- `npm run lint`, both client/web typechecks, the web production build, `npm run check:docs`, `npm run vectors`, and the brief/copy/CSS/CI checks passed.
- `go test ./...` passed after the wire-v3, managed-bot fixture, and SFU fixed-port test repairs. Focused race tests passed for the new reaction and signed-removal paths. A local PostgreSQL 17 container passed full `internal/store` and `internal/api` packages with `DILLA_TEST_PG` set.
- The recent reaction-role grant changes and signed-removal retry were independently reviewed. The identified channel/message deletion cleanup races were fixed and re-reviewed; the final incremental review found no further concrete defect in that range.
- The full `cargo test -p dilla-core --features vectors` and `cargo test -p dilla-bot-core` suites passed after the typed interaction binding change. The focused Rust tests, library clippy/check, formatting gate, and earlier WASM build/size gate passed too.

## Open release blockers

1. **Encrypted interactions:** kind-3 Bot interaction groups remain refused by the Go dispatcher. The v2 binding now includes participant device ID, but Rust load, Welcome, registration and the server must validate the actual authenticated roster end to end; admitting groups now would bypass those checks. Consequently the settings/command control plane is not fully reachable.
2. **Production music path:** `cmd/dillabot` reconciles identities and performs welcome/announcement passes, but does not own persistent interaction/event dispatch or connect queue revisions to voice-channel supervisors. YouTube PCM is fail-closed with `ErrSandboxUnavailable` until a production subprocess egress broker is implemented and tested.
3. **Spotify qualification:** no dedicated Premium account was connected; actual librespot audio, playlist expansion, playback controls, and encrypted browser playback on the intended host remain unverified. The qualification gate cannot be inferred from passing unit tests.
4. **Community and moderation integration:** one constrained join-role approval can now be configured, but automatic role assignment on a membership episode is not wired. A complete music panel, encrypted moderation evidence access, and whole-release browser scenarios remain open. Full backup/restore acceptance has not been run.

The broad `go test ./...` failures were limited to stale wire-v3 and managed-bot test fixtures and an SFU test's fixed UDP port collision. Those fixtures were corrected, and the whole-repository rerun passed after the final interaction-binding and fail-closed YouTube changes. No live deployment or release has been performed.
