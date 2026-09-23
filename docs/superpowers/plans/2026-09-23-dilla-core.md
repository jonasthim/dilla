# dilla-core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build dilla's Rust core — the cryptographic, protocol and storage layer every tier shares — on OpenMLS 0.9.0 with a custom SQLite `StorageProvider` that compiles and is tested natively, for `wasm32-unknown-unknown` (browser) and for `wasm32-wasip1` (the delivery service's structural view under wazero), plus the two binding crates, the cross-target conformance vector runner, and `dilla-testkit` v0: an in-memory delivery-service stub, headless clients, a scenario DSL and the committed 1,500-leaf `PublicGroup` benchmark fixture.

**Architecture:** A Cargo workspace at the repository root next to the existing npm workspaces. `core/dilla-core` is one target-agnostic library crate (deterministic CBOR, identifiers and error codes, identity, envelope and franking, SFrame key schedule, the MLS layer, the `PublicGroup` view, the vector runner); `core/dilla-core-wasm` and `core/dilla-core-wasi` are thin binding crates, because `wasm-pack` forces `crate-type = ["cdylib"]` on whatever crate it is pointed at (D5). `testkit/` is a library plus a `dilla-testkit` binary. The MLS state lives in dilla's own 53-method `StorageProvider` over rusqlite — SQLCipher natively, SQLite3MultipleCiphers through `sqlite-wasm-rs` in the browser (D10) — with `BEGIN IMMEDIATE … COMMIT` wrapped around each OpenMLS call from the outside, because the trait has no transaction hook (R12). The delivery-service tier holds no group secret: it carries a `PublicGroup` behind a 16-method in-memory `PublicStorageProvider` whose state is exported as a versioned blob (D11, R9).

**Tech Stack:** Rust 1.98.1 (pinned in `rust-toolchain.toml`, installed user-scoped by task 0), edition 2024, `openmls 0.9.0` + `openmls_traits`/`openmls_rust_crypto`/`openmls_basic_credential` 0.6.0, `tls_codec 0.5.0`, `rusqlite 0.40.2`, `sqlite-wasm-rs 0.5.5`, `ed25519-dalek 2.2`, `sha2`/`hmac`/`hkdf` 0.13-line, `aes-gcm 0.10.3`, `ciborium 0.2.2` (OpenMLS storage blobs only), `thiserror 2.0`, `clap 4`; `wasm-bindgen 0.2.128` with `wasm-pack 0.15.0`; Node 24 for the existing `@dilla/protocol-vectors` package. No protobuf, no `minicbor` (A1-1), no nightly.

**Spec:** `docs/superpowers/specs/2026-09-23-dilla-design.md` (sections "Rust core (crypto, sync, storage, search)", "Server (Go)", "E2EE protocol layer", "Media", "Data model", "Testing and verification strategy", the 90-day roadmap W1 line, "Subprojects").

## Global Constraints

- Repository: `github.com/jonasthim/dilla`, public. Licences: `core/*` **Apache-2.0**, `testkit/` **AGPL-3.0-or-later**; each crate carries its own `LICENSE` file and `license` field (R3).
- Every commit is signed off (`git commit -s`) per the DCO, with a conventional-commit subject; trailers after a blank line. CI is fail-closed: no `|| true`, no `continue-on-error` (R22).
- Rust toolchain: `1.98.1`, edition 2024, workspace `rust-version = "1.98"`, targets `wasm32-unknown-unknown` and `wasm32-wasip1`, components `clippy` and `rustfmt`. The dev box has the Arch `rust` package and **no rustup**, so task 0 installs rustup user-scoped and every later command calls `/home/thim/.cargo/bin/cargo` by absolute path (R4).
- Mandatory MLS ciphersuite at v1: `0x0001` (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`). Media suite: SFrame `0x0004` (`AES_128_GCM_SHA256_128`), `NK = 16`, `NN = 12`.
- `e2ee_version = 1`, `media_version = 1`, `wire_version = 1`, `abi_version = 1`. Padding: application ciphertext to a multiple of **256** bytes.
- Standards-only cryptography: MLS is RFC 9420, media frames follow the RFC 9605 shape, hashes are SHA-256, MACs are HMAC-SHA256 (compared with `Mac::verify_slice`, never `==`), KDF is HKDF-SHA256, signatures are Ed25519 verified with `verify_strict`.
- Every normative dilla format is **deterministic CBOR** over fixed-position arrays — majors 0, 2, 3, 4 and the simple value `0xf6`; no maps, tags, floats, negatives or indefinite lengths, shortest-form integers only, trailing bytes rejected, nesting capped at 8 (D4, A1-1). `ciborium` appears only as the serde codec for OpenMLS's own storage blobs and never decodes a dilla format (A1-5).
- KeyPackage lifetime **90 days**; inactivity Remove **90 days** (D9, R15). At most **256** Adds per commit.
- Past-epoch secrets: `PastEpochDeletionPolicy::MaxEpochs(n)` plus `delete_past_epoch_secrets(..., PastEpochDeletion::older_than_duration(..))` — 300 s for text, 10 s for call, nothing kept for pairing and interaction (D3, R16).
- `required_capabilities.extension_types` lists **only** `ExtensionType::Unknown(0xF001)`; `ExternalSenders` is a default type and MUST NOT be listed (D2).
- The wasi ABI is deterministic CBOR in and out, never protobuf (D1, R8); the wasip1 vector check runs under **wazero from Go**, not wasmtime (D6, R7).
- No `--cfg getrandom_backend` in `RUSTFLAGS` or `.cargo/config.toml`: the backend is selected by the `js` / `wasm_js` crate features alone (D7, R5).
- `dilla-core` is `#![forbid(unsafe_code)]`; only `core/dilla-core-wasi` opts back in, for its `extern "C"` exports.
- Tests assert behaviour against the committed vectors and real OpenMLS objects; nothing mocks the thing under test.

## Deviations from the spec (verified)

Copied verbatim from `interfaces.md` §0.2. Each row is a place where the spec's text is factually
wrong about an API, a version or a number, and the verified fact wins.

| # | Spec text | Correct value | Source |
|---|---|---|---|
| D1 | line 449 "wasi ABI … **protobuf-in/out**" | deterministic **CBOR** in/out, fixed-position arrays; no `.proto`, no `protoc`, no protobuf crate | gap-16 §0/§1, R8 |
| D2 | line 436 "**external senders** and `dilla_binding` in `required_capabilities`" | only `ExtensionType::Unknown(0xF001)` goes in `required_capabilities.extension_types`; `ExternalSenders` is a default type and MUST NOT be listed | gap-28 §0, gap-5 §4.2, `protocol/01-groups.md` |
| D3 | line 436 "Past-epoch secrets: `KeepAll` plus a core-owned timer" | `PastEpochDeletionPolicy::MaxEpochs(n)` as the standing policy plus `MlsGroup::delete_past_epoch_secrets(provider, PastEpochDeletion::older_than_duration(..))` as the sweep; no core-owned timer | gap-8 §2/§3, R16 |
| D4 | line 438 "(ciborium does not canonicalise map keys)" | the real defect is that `ciborium`'s `serialize_struct` emits a **map** and its decoder accepts non-minimal ints, indefinite lengths, maps, tags, floats and trailing bytes. dilla ships its own strict encoder/decoder | gap-27 §0/§1, gap-16 §0 item 7 |
| D5 | line 422 "built three ways from **one crate**" | one library crate plus two thin binding crates (`dilla-core-wasm`, `dilla-core-wasi`); `wasm-pack` forces `crate-type = ["cdylib"]` on whatever crate it is pointed at | gap-24 §0/§2.1, R2 |
| D6 | line 629 / facts-ci §4 `runner = "wasmtime"` | the wasip1 vector check runs **under wazero, from Go** (Plan B task 4). wasmtime is not installed and not needed | gap-31 §0, R7 |
| D7 | facts-ci §2/§4 `--cfg getrandom_backend="wasm_js"` in RUSTFLAGS | **delete it.** getrandom ≥ 0.3.4 selects the backend from the `wasm_js` *feature*; in 0.4.x the cfg value is not even in the check-cfg vocabulary | gap-29 §0, R5 |
| D8 | line 412 "Go 1.26" | `go 1.27.0` in `go.mod` (local toolchain is go1.27.0) | R17; gap-33 recommends `go 1.26.0` + `toolchain go1.27.1` — **the ruling overrides the gap** |
| D9 | chaos list line 627 "30-day inactivity Remove" | **90 days** | `protocol/01-groups.md`, R15 |
| D10 | line 441 "sqlite3mc / bundled-sqlcipher" read as one format | two different on-disk formats: browser = SQLite3MultipleCiphers `chacha20` (sqleet), native = SQLCipher. The store file is deliberately **not** portable between tiers | gap-13 §0/§4 |
| D11 | line 443 `public_group` "wasi export only" with no state story | state lives in module memory behind an in-memory `PublicStorageProvider`; dillad persists a versioned blob via `public_group_export_state` / `public_group_import_state` | R9 (overrides gap-17's host-function recommendation) |
| D12 | line 625 DSL verbs `kick`, `restore_snapshot`, `expect_425` | v0 verbs are `join`, `send`, `expect_decrypts`, `external_join`, `remove`, `go_offline`, `expect_reject` | R20 |

## Rulings that bind this plan

Summarised from `scratchpad/planning/core/rulings.md`. The rulings settle the questions that are
decisions rather than facts; where a ruling and a verified fact disagree about an API or a version,
the fact wins and the row appears in "Deviations from the spec (verified)" above.

| # | Ruling, as it binds this plan | Where it lands |
|---|---|---|
| R1 | Identifiers are real and carry no codename: Go module `github.com/jonasthim/dilla`, Rust crate `dilla-core`, package scope `@dilla/*`. | every `Cargo.toml`, task 1 |
| R2 | Polyglot root: a root `Cargo.toml` workspace with members `core/dilla-core` (library, target-agnostic, **no `js` feature**), `core/dilla-core-wasm` (wasm-bindgen cdylib, enables `openmls/js` and the getrandom `js`/`wasm_js` features), `core/dilla-core-wasi` (wasm32-wasip1 cdylib exposing the `public_group` exports, no `js` feature) and `testkit/`. Edition 2024 (`#[unsafe(no_mangle)]`), `rust-toolchain.toml` pinning the verified current stable with targets `wasm32-unknown-unknown` and `wasm32-wasip1` and components `rustfmt`, `clippy`. | tasks 0, 1, 14, 15 |
| R3 | Licences: `core/*` Apache-2.0; `testkit/` AGPL-3.0-or-later. Every crate `publish = false`, every crate a `LICENSE` file. | task 1 |
| R4 | The local toolchain bootstrap is a **plan task, not a prerequisite**: the dev box has Arch `rust` 1.98.1 without rustup, no wasm targets and no sudo. Task 0 installs rustup user-scoped (official installer, `--no-modify-path --default-toolchain none`), lets `rust-toolchain.toml` pull the toolchain and targets, and ships `scripts/doctor-rust.sh` that prints what is missing and exits non-zero. `wasm-bindgen-cli` is installed at the exact version the workspace resolves, which is only knowable once `Cargo.lock` exists — so it lands in task 1 (deviation A1-6). Every later command invokes `/home/thim/.cargo/bin/cargo` explicitly. The Arch package stays untouched. | tasks 0, 1 |
| R5 | No `--cfg getrandom_backend` RUSTFLAGS anywhere; features only (`getrandom 0.2` feature `js`, `getrandom 0.4` feature `wasm_js`), selected per binding crate. | tasks 1, 15, 19 |
| R6 | Browser tests run through Playwright (Chromium, headless, `channel: 'chromium'`); pure-wasm unit tests run under Node with `wasm-bindgen-test`. No chromedriver exists on this box. CI installs Playwright's browsers with `--with-deps`. | tasks 16, 17, 18, 19 |
| R7 | The wasip1 vector check runs **under wazero in Go**, not wasmtime; the same `vectors_check` export is exercised natively and under wasm-bindgen/Node so the three builds cannot diverge. | tasks 8, 14, 16 (Plan B task 4 is the wazero leg) |
| R8 | The wasi ABI is deterministic CBOR, not protobuf: every export takes `(ptr, len)` of a CBOR request and returns a packed `(ptr<<32 \| len)` u64 to a CBOR response allocated by the module (`dilla_alloc` / `dilla_free` exports). One codec for the whole project. | tasks 2, 14 |
| R9 | `PublicGroup` state on the wasi side lives in module memory behind an in-memory `PublicStorageProvider`, with exports `public_group_export_state` / `public_group_import_state` (a serde-encoded blob carrying a version byte from day one) so dillad persists it in its own transaction. No WASI filesystem, no host functions beyond WASI preview1. | tasks 11, 14 |
| R10 | The wazero go/no-go fixture is **generated, not hand-written**: `dilla-testkit gen-public-group --leaves 1500` emits a committed fixture under `testkit/fixtures/` — GroupInfo without tree, the exported ratchet tree and ten commits (batched adds, one remove, one update). | task 13 |
| R11 | Group context extensions follow `protocol/01-groups.md`: `required_capabilities`, `external_senders` carrying the instance key, and `dilla_binding` as `Extension::Unknown(0xF001, …)` with a deterministic-CBOR body; all three installed with `MlsGroupCreateConfig::builder().with_group_context_extensions(Extensions)` because OpenMLS 0.9 has no `required_capabilities()` / `external_senders()` builder methods. | task 10 |
| R12 | Transactions around OpenMLS: `dilla-core` owns the rusqlite `Connection` behind interior mutability (every `StorageProvider` method takes `&self`) and wraps `BEGIN IMMEDIATE … COMMIT` around each state-changing OpenMLS call from **outside** the provider; a failed call rolls back. | task 9 |
| R13 | One CBOR subset for the project. `gap-27-repo.md` leaves the crate choice open and recommends the dependency-free route, so §2.3 is implemented directly over `&[u8]` (deviation A1-1): shortest-form integers, definite lengths, a `deterministic` decode check that rejects non-shortest forms and indefinite lengths. | task 2 |
| R14 | Vectors: the Rust core verifies the four existing vector files, and this plan adds credential-signature vectors with real Ed25519 keys generated deterministically from a seed by `packages/protocol-vectors` `generate.ts` (WebCrypto Ed25519 on Node 24), so `identity.json` stops carrying filler signatures. `npm run vectors` stays the single generator and CI's fail-closed vector gate stays. `signer_tier` accepts `0..=2`. | tasks 7, 8 |
| R15 | Inactivity Remove is **90 days** (`protocol/01-groups.md`), not the spec's chaos-scenario 30-day line. | tasks 4, 10 |
| R16 | Past-epoch secrets use OpenMLS 0.9's `PastEpochDeletion::older_than_duration` (300 s text, 10 s call, nothing for pairing and interaction); the spec's core-owned timer is unnecessary. | task 10 |
| R20 | Testkit v0 is Rust only: `dilla-testkit` runs N native `dilla-core` clients against an in-memory delivery-service stub enforcing the week-1 subset of DS invariants (one commit per epoch with a 409-equivalent, a registry with `dilla_binding`, a KeyPackage directory, GroupInfo without tree plus a served tree) and a scenario DSL (`join`, `send`, `expect_decrypts`, `external_join`, `remove`, `go_offline`, `expect_reject`). The Go-driven in-process-dillad mode arrives with the dillad plan. | tasks 12, 13 |
| R21 | Plan split: this file is Plan A (workspace + formats + MLS core + bindings + browser spike + testkit v0 + CI); `docs/superpowers/plans/2026-09-23-dillad-spikes.md` is Plan B and consumes this plan's wasi artefact and fixture. | whole plan |
| R22 | Commit conventions: conventional-commit subject, DCO sign-off via `-s`, trailers after a blank line; CI fail-closed, no `|| true`, no `continue-on-error`. | every task's commit step; task 19 |

Rulings **R17**, **R18** and **R19** (Go version, LiveKit in-process pins, modernc SQLite) bind Plan B
only and are restated there.

**One ruling is applied at a different value than its literal text.** R2 writes workspace
`rust-version = "1.91"`; this plan writes `rust-version = "1.98"`, because `interfaces.md` §4.2 — the
binding interface contract every drafter worked from — fixes the root manifest at `rust-version =
"1.98"`, and `rust-toolchain.toml` pins `1.98.1`, the verified current stable on this box
(`facts-local-toolchain.md`: Arch `rust 1:1.98.1-1.1`). `1.91.0` is only `openmls 0.9.0`'s own MSRV
floor (`interfaces.md` §3.1 comment), not a ceiling. Recorded again under "Assembly notes".

## File structure

Root = the existing worktree. Existing paths (`package.json`, `packages/*`, `protocol/*`,
`scripts/*`, `docs/*`, `.github/*`) are unchanged except where a task names them. Paths below are
repository-relative; every command in a task step uses the absolute form.

**Root files created by this plan:** `Cargo.toml` (task 1) · `Cargo.lock` (generated, committed,
task 1) · `rust-toolchain.toml` (task 0) · `.cargo/config.toml` (task 1) · `deny.toml` (task 1) ·
`scripts/doctor-rust.sh` (task 0) · `scripts/check-ci-workflow.mjs` and
`scripts/check-ci-workflow.test.mjs` (task 19, deviation A2-8).

**`core/dilla-core/`** — crate `dilla-core`, `crate-type = ["rlib"]`, Apache-2.0, `#![forbid(unsafe_code)]`:

| Path | Responsibility | Task |
|---|---|---|
| `Cargo.toml`, `LICENSE` | crate manifest and licence | 1 |
| `src/lib.rs` | crate root, module declarations, the `pub use` surface | 1, then every task adds its module |
| `src/error.rs` | `CoreError`, the `E_*` protocol error codes | 3 (extended by 9, 10) |
| `src/ids.rs` | identifier newtypes | 3 |
| `src/cbor/{mod,enc,dec}.rs` | the deterministic-CBOR encoder and the strict decoder | 2 |
| `src/identity/{mod,credential,device_list,safety,recovery,pairing}.rs` | credentials, device lists, safety numbers, recovery keys, pairing | 3, 4 |
| `src/envelope/{mod,frank}.rs` | the message envelope and franking commitments and tags | 5 |
| `src/sframe/{mod,header,ctr}.rs` | the SFrame key schedule, the counter partition and the header codec | 6 |
| `src/mls/{mod,provider,storage,tx}.rs` | `DillaProvider`, the 53-method SQLite `StorageProvider`, the transaction wrapper | 9 |
| `src/mls/{binding,config,policy,group}.rs` | `dilla_binding`, the group configuration, the commit policy, `DillaGroup` | 10 |
| `src/public_group/{mod,storage,state}.rs` | the `PublicGroup` wrapper, the in-memory `PublicStorageProvider`, the versioned state blob | 11 |
| `src/vectors/{mod,report}.rs` | the cross-target conformance runner (feature `vectors`) | 8 |
| `tests/cbor_reject.rs` | the CBOR reject corpus | 2 |
| `tests/vectors_native.rs` | the native vector run | 8 |
| `tests/coherence.rs`, `tests/coherence/both_traits.rs` (+ generated `.stderr`) | the `trybuild` compile-fail proof that one type cannot implement both storage traits | 9 |
| `tests/mls_roundtrip.rs` | group create/add/commit/decrypt against real OpenMLS objects | 10 (extended by 11) |
| `tests/workspace_policy.rs` | the workspace-file policy assertions | 1 |

**`core/dilla-core-wasm/`** — crate `dilla-core-wasm`, `cdylib` + `rlib`, Apache-2.0:
`Cargo.toml` · `LICENSE` (task 1) · `src/{lib,store,probe}.rs` (task 15; task 17 adds
`unencrypted_vfs_probe` and `wrong_key_probe` to `src/store.rs`, deviation A2-10) ·
`tests/node.rs` (task 16) · `spike/{package.json,vite.config.ts,tsconfig.json,tsconfig.worker.json,index.html}`
and `spike/src/{main,worker,leader,probe}.ts` (task 17) · `spike/pkg/` and `spike/node_modules/`
(wasm-pack and npm output, git-ignored).

**`core/dilla-core-wasi/`** — crate `dilla-core-wasi`, `cdylib`, Apache-2.0, the only crate that opts
back into `unsafe`: `Cargo.toml` · `LICENSE` · `src/lib.rs` (task 1) · `src/{abi,exports,handles}.rs`
(task 14). Its `wasm32-wasip1` artefact is what Plan B loads under wazero.

**`testkit/`** — crate `dilla-testkit`, lib + bin, AGPL-3.0-or-later:
`Cargo.toml` · `LICENSE` (task 1) · `src/lib.rs` · `src/client.rs` · `src/ds/{mod,state,invariants}.rs` ·
`src/scenario/{mod,parse,run}.rs` · `src/bin/dilla-testkit.rs` ·
`scenarios/{two-client-text,external-join,commit-conflict}.scn` · `tests/scenarios.rs` (task 12) ·
`src/fixtures.rs` · `tests/fixtures.rs` ·
`fixtures/ds-1500/{manifest.json,group_info.mls,ratchet_tree.mls,public_group_state.bin,commits/00.mls … commits/09.mls}`
(task 13 — the committed fixture Plan B's benchmark consumes).

**`e2e/`** — npm workspace `@dilla/e2e`: `package.json` · `playwright.config.ts` ·
`tests/opfs-leader.spec.ts` (task 17) · `tests/persistence-matrix.spec.ts` (task 18) ·
`test-results/` (git-ignored, deviation A2-15).

**Reports:** `docs/spikes/2026-09-browser.md` (task 20). The three wazero, LiveKit and FTS5 reports
belong to Plan B.

**Modified existing files:** `packages/protocol-vectors/src/{identity.ts,generate.ts}` and new
`src/{ed25519.ts,ed25519.test.ts}` · `protocol/vectors/identity.json` (regenerated, never hand-edited) ·
`protocol/vectors/README.md` · `protocol/03-identity.md` (gains a `## Vectors` section) ·
`protocol/07-versioning.md` (change-process row) — all task 7 · `CONTRIBUTING.md` (task 0, a
`## Rust toolchain` section) · `.gitignore` and `.editorconfig` (task 1; task 18 adds
`e2e/test-results/`) · `package.json` (task 17 adds `e2e` and `core/dilla-core-wasm/spike` to the
workspaces; task 19 adds `check:ci` and `test:ci-check`) · `.github/workflows/ci.yml` (task 16 adds
`rust-wasm-node`; task 19 adds `concurrency`, `env` and the jobs `rust-native`, `rust-wasi`,
`vectors`, `browser-spike`, `deny`).

## Interface deviations (part A1)

Recorded per the drafting contract. Everything not listed here follows
`scratchpad/planning/core/interfaces.md` exactly.

| # | interfaces.md says | This plan writes | Reason |
|---|---|---|---|
| A1-1 | §3.1 `minicbor = { version = "2.3.0", default-features = false, features = ["alloc"] }` in `core/dilla-core/Cargo.toml` | **no `minicbor` dependency**; `cbor::{Encoder, Decoder}` are hand-written over `&[u8]` | §2.3's own instruction: "if they do not fit, implement §2.3 directly over `&[u8]` (gap-27 §6 route A, ~150 lines) and drop the `minicbor` dependency line". `minicbor 2.3.0`'s `Encoder`/`Decoder` method names and its decoder's minimality/trailing-byte behaviour are **unverified** in every facts file (gap-27 §8 bullet 3), and a plan step may not be written against an unverified API. gap-27 §6/§7 item 2 recommends the hand-rolled route outright ("the smallest thing that can be *right*"). The public surface of §2.3 is unchanged. |
| A1-2 | §3.3 `minicbor` in `core/dilla-core-wasi/Cargo.toml` | **no `minicbor` dependency**; the wasi crate uses `dilla_core::cbor` | Same as A1-1. Task 1 creates that manifest, so the decision lands here; task 14 (part A2) writes the code against `dilla_core::cbor`, which is the same API §2.3 defines. |
| A1-3 | §4.4 `deny.toml` `[licenses] allow` includes `BlueOak-1.0.0` | `BlueOak-1.0.0` **removed** from the allow list | §4.4's own note: "`BlueOak-1.0.0` is in the allow list only because `minicbor` carries it; drop it if §2.3's [NV] resolves to the dependency-free route." It did (A1-1). |
| A1-4 | §3.1 / §3.4 `rusqlite = { version = "0.40.2", features = ["bundled-sqlcipher"] }` | `features = ["bundled-sqlcipher-vendored-openssl"]` | Resolves the §3.1 **[NV]**. Both feature names exist (`facts-browser.md` §194-197, verbatim manifest). `bundled-sqlcipher` "searches for and links against a **system-installed** crypto library" (facts-browser §234, rusqlite README verbatim), which needs OpenSSL headers on the dev box (no sudo, `facts-local-toolchain.md`) and on the CI runner. `bundled-sqlcipher-vendored-openssl` vendors OpenSSL through `openssl-sys` and needs nothing installed; facts-browser §334 and gap-12 §272 both write exactly that line. |
| A1-5 | §2.7.3 `CborCodec` with the codec crate unstated (open question 1) | `CborCodec` is implemented over **`ciborium 0.2.2`** (`ciborium::into_writer` / `ciborium::from_reader`), added as a `core/dilla-core` dependency | Settles open question 1. R12 wants "the same deterministic CBOR crate the core uses … via its serde support"; with A1-1 the core's protocol codec has **no serde support at all** (it is hand-written for fixed-position arrays), so a serde codec must be named. gap-6 §0/§3/§4 verifies `ciborium 0.2.2` is self-describing (the hard 0.9.0 requirement), Apache-2.0, and is the exact codec upstream exercises as its "alternative current-version store" in `compat_tests`. `ciborium::de` is never used on a **normative** format — only on OpenMLS's own serde blobs — so gap-27 §7 item 4's prohibition is respected. |
| A1-6 | §6 task 0 *Files* lists `rust-toolchain.toml` and `scripts/doctor-rust.sh` only | also installs `wasm-bindgen-cli` 0.2.128 and `wasm-pack` 0.15.0, in **task 1** (after `Cargo.lock` exists) | R4 requires task 0 to install `wasm-bindgen-cli` "at the exact version of the `wasm-bindgen` crate the workspace resolves" — that version is only knowable once `Cargo.lock` exists, which task 1 produces. The doctor's check 4 (§4.5) therefore skips when `Cargo.lock` is absent and is enforced from task 1 on. |
| A1-7 | §2.9 `include_str!("../../../protocol/vectors/envelope.json")` | `include_str!("../../../../protocol/vectors/envelope.json")` — **four** levels, in `vectors/mod.rs` and in the task 5 and 6 unit tests | `include_str!` resolves relative to the containing file's directory. From `core/dilla-core/src/vectors/`, three `..` reach `core/`, not the repository root; the file is at `<root>/protocol/vectors/`. Arithmetic, not a design change. |
| A1-8 | §2.7.5 `DillaGroup::export_group_info(..) -> Result<GroupInfo, MlsError>` | `-> Result<MlsMessageOut, MlsError>` | `MlsGroup::export_group_info(crypto, signer, with_ratchet_tree)` returns `MlsMessageOut`, not a bare `GroupInfo` (facts-openmls §4.7, verified from docs.rs). No verified conversion from the message to a `GroupInfo` value exists in this plan's inputs, and the DS wants the serialisable message anyway. `CommitBundle.group_info` keeps the contract's `Option<GroupInfo>`, because `add_members` and `remove_members` hand that type back directly. |
| A1-9 | §2.8 `PublicStore::export` = `[STATE_VERSION] \|\| CBOR([group_data: [[key, value], …], proposals: [[key, value], …]])` | entries are **3-element** arrays: `[group_id(bstr), discriminant(uint), value(bstr)]` and `[group_id(bstr), proposal_ref(bstr), proposal(bstr)]` | Both maps have a **two-part** key. A single `key` byte string cannot encode `(group_id, proposal_ref)` unambiguously — both parts are variable-length. The version byte, the two-section layout and the `PublicStoreError` variants are unchanged, and `STATE_VERSION` exists precisely so this can be pinned down now rather than guessed at. |
| A1-10 | §2.1 `<Id>::random(rng: &mut impl rand_core::CryptoRng) -> Self` | **not written** | The contract already marks the `rand_core` major **[NV]** (`openmls_rust_crypto 0.6.0` carries both 0.6.4 and 0.10.1, gap-10 §2) and §3.1 advises taking randomness from `OpenMlsRand` instead. Writing a public bound against an unresolved major would fix the wrong one into the API. The two week-1 callers that need fresh bytes take them from `openmls_traits::random::OpenMlsRand`, already in the graph. |
| A1-11 | §2.12 `DsStub` method list | adds `post_message_from`, `attach_public_group`, `add_member_device`, `binding`, `epoch`; `TestClient` adds `invite`, `provider`, `signer` | `post_message` as specified takes only `(group_id, epoch, private_message)`, but the stub must store the franking commitment `C`, which the real DS reads out of `private_message.authenticated_data` — parsing that needs the MLS deserialiser the stub deliberately does not carry. `post_message_from` takes `C` explicitly; the contract's `post_message` stays and returns `CommitmentInvalid` without it, which is the same refusal the real DS makes for a missing commitment. The other five are the plumbing a scenario needs (attaching the structural validator, tracking membership for fan-out, the inviter's Add commit) and none replaces a contract method. |
| A1-12 | §2.7.3 "`impl openmls::storage::OpenMlsProvider for DillaProvider`" | `impl openmls_traits::OpenMlsProvider for DillaProvider` | `openmls::storage::OpenMlsProvider` is a convenience re-declaration "with a blanket impl for any `openmls_traits::OpenMlsProvider` whose storage matches" (facts-openmls.md §3). Implementing it directly would conflict with that blanket impl; implementing the `openmls_traits` trait satisfies every `openmls` bound. |
| A1-13 | §3.1 `[dev-dependencies]` = `serde_json`, `hex` | adds `trybuild` | §6 task 9's own test list requires "a `trybuild` compile-fail test [that] pins that one type cannot implement both `StorageProvider` and `PublicStorageProvider` (E0119)", which needs the crate. The resolved patch version is recorded in task 9's commit body, and task 9 step 4 states what to do if `cargo deny bans` trips on a duplicate in its tree. |
| A1-14 | §3.3 `[profile.release]` inside `core/dilla-core-wasi/Cargo.toml` | **removed**; the workspace-root `[profile.release]` governs the wasi artefact | Cargo ignores profile tables outside the workspace root and warns "profiles for the non root package will be ignored", so the block never applied. `panic = "abort"` is already the wasip1 default and cannot be set per package. Task 1 step 5 records this, so the size numbers Plan B measures are taken against the profile that is actually in force. |
| A1-15 | §0.2 D12's seven DSL verbs | the grammar also carries `instance`, `client`, `group`, `sync` and `join … via=welcome\|external` | Not a widening of R20: §2.12's own EBNF defines these as "structural — not in R20's list, but required to make a scenario runnable", and `external_join x g` stays exactly `join x g via=external`. Recorded here so a reviewer comparing against D12 alone can see it is deliberate. |
| A1-16 | §2.12 `Scenario` (fields unspecified) | `Scenario { name, stmts, lines }` — a parallel `Vec<usize>` of source line numbers | `StepResult { line, .. }` must report the **source** line; the parser skips comments and blank lines, so the statement's index in `stmts` is not it, and every committed `.scn` file opens with a comment. |

## Interface deviations (part A2)

These depart from `scratchpad/planning/core/interfaces.md`. Everything not listed here follows it exactly.

| # | interfaces.md says | A2 writes | Reason |
|---|---|---|---|
| A2-1 | §3.3 `core/dilla-core-wasi/Cargo.toml` depends only on `dilla-core` + `minicbor` | adds `openmls 0.9.0`, `openmls_rust_crypto 0.6.0`, `openmls_basic_credential 0.6.0`, `tls_codec 0.5.0` at the §3.1 pins, and keeps `minicbor` **out** (Plan A1's deviation A1-2 already removed it) | §2.10's exports take MLS objects as "CBOR byte strings holding their RFC 9420 TLS encoding", so the crate must TLS-decode `MlsMessageIn` / `RatchetTreeIn` and construct a `SignatureKeyPair`. §2.8's `from_external` also needs an `impl OpenMlsCrypto`. `openmls_traits` is **not** added: no step in A2 names a trait from it, and the `&impl OpenMlsCrypto` bounds are satisfied by passing a concrete `RustCrypto`. `minicbor` is not restored either: A2 encodes exclusively through `dilla_core::cbor`, and A1-2 is the standing decision (its final fate follows Plan A task 2's §2.3 [NV] resolution). No new versions enter the lock: every crate is already a `dilla-core` dependency at the same pin. |
| A2-2 | §3.2 `core/dilla-core-wasm/Cargo.toml` has no SQLite dependency | adds a `[target.'cfg(all(target_arch = "wasm32", target_os = "unknown"))'.dependencies]` block with `rusqlite 0.40.2`, `sqlite-wasm-rs 0.5.5` (`default-features = false, features = ["sqlite3mc"]`), `sqlite-wasm-vfs 0.2.0` | §2.11's `StoreHandle` holds a `rusqlite::Connection` and an `OpfsSAHPoolUtil`, and `store_open` calls `sahpool::install`. Versions are copied verbatim from §3.1's wasm block; feature unification with `dilla-core` keeps the single `links = "wsqlite3"` copy (gap-11 §9 item 1). |
| A2-3 | §2.11 `pub async fn store_open(cfg) -> Result<StoreHandle, JsError>` | `-> Result<StoreHandle, JsValue>` | `is_sah_contention(err: &JsValue)` classifies by the DOMException's `name` / `message` properties (gap-14 §4). A `JsError` is a fresh `Error` whose `name` is `"Error"`, so wrapping would make `is_sah_contention` unable to match anything and the retry loop dead code. The original `JsValue` is rethrown unchanged. |
| A2-4 | §2.11 `StoreHandle::pause(&self)` alongside `close(self)` | unchanged signatures; `pause()` internally drops the `Connection` before calling `pause_vfs()`, and `resume()` reopens it and replays the two pragmas | `pause_vfs()` errors while any SQLite file handle is open (gap-11 §9 item 5), and `close(self)` consumes the handle, so a caller cannot close-then-pause. The connection lives in a `RefCell<Option<Connection>>`. |
| A2-5 | §6 task 18 creates `e2e/{package.json,playwright.config.ts}` and both spec files | task **17** creates `e2e/package.json`, `e2e/playwright.config.ts` and `e2e/tests/opfs-leader.spec.ts` (boot + single-leader, Chromium only); task **18** creates `e2e/tests/persistence-matrix.spec.ts` and modifies `playwright.config.ts` (adds the Firefox and WebKit projects) and `opfs-leader.spec.ts` (hand-over timing and the metrics file) | writing-plans requires every task to end with an independently testable deliverable. Without a runnable Playwright harness, task 17's spike has no test at all. |
| A2-6 | §5 `browser-spike` job runs `npx playwright install --with-deps chromium` | `npx playwright install --with-deps chromium firefox webkit` | task 18's persistence matrix asserts Firefox private-browsing and WebKit ephemeral behaviour (gap-15 AC-1, AC-2); those engines must be installed or the job cannot run those assertions. |
| A2-7 | §5 CI jobs use `actions/setup-node@v7` with `node-version-file: .node-version` | `node-version-file: .nvmrc` | the repository has `.nvmrc` (contents `24`) and no `.node-version`; `setup-node` accepts `.nvmrc` (facts-ci §1.4). Adding a second, redundant version file would be a new source of drift. |
| A2-8 | §1 lists no new file under `scripts/` | adds `scripts/check-ci-workflow.mjs` and `scripts/check-ci-workflow.test.mjs` | task 19's acceptance ("no step contains `\|\| true`, `continue-on-error` or `if: always()`", "every named job exists") must be an executable assertion, not prose. The repository already uses exactly this `scripts/check-*.mjs` + `check-*.test.mjs` pattern for its three other fail-closed gates. |
| A2-9 | §2.10 export 4 `vectors_check` success response is "the `VectorReport::encode` body" | `[0, passed, failed, [[suite_name, [[case, field, ok, expected, actual], …]], …]]`, built directly by the wasi crate's encoder | `VectorReport::encode` (§2.9) produces a **3-element top-level array**; splicing it whole after the `0` would nest it. The element layout is byte-identical to §2.9's, so `mlswasi.VectorReport` (§2.13) decodes unchanged. |
| A2-10 | §2.11 has no `unencrypted_vfs_probe` | task 17 adds `#[wasm_bindgen] pub fn unencrypted_vfs_probe(db_name: &str, kek_hex: &str) -> Result<String, JsError>` and `#[wasm_bindgen] pub async fn wrong_key_probe(db_name: &str, kek_hex: &str) -> Result<String, JsError>` to `core/dilla-core-wasm/src/store.rs` | interfaces §6 task 17 requires two assertions nothing in §2.11 can reach: "opening plain `opfs-sahpool` yields the exact message `Setting key failed. Encryption is not supported by the VFS.`" and "a wrong key fails on the **SELECT**, not on the pragma". Both would otherwise have been untestable prose. The two functions exist only to keep the gap-13 §3 and §2.2 traps from silently returning. |
| A2-11 | §2.10 export 14 `public_group_proposal_list` returns `[[proposal_ref(bstr), proposal(bstr)], …]`, which reads as a bare `Proposal` | the second element is the **original `MLSMessage` bytes the DS received**, kept alongside the `QueuedProposal` | the DS hands this list straight back to clients in §2.12's `DsError::CommitConflict { winning_commit, proposals }` and `CommitRequired { proposals }`. A bare `Proposal` has lost its `FramedContent` and its signature, so a client cannot process what it gets back — an interoperability defect, not a formatting choice. §2.10's own field note ("MLS objects travel as CBOR byte strings holding their RFC 9420 TLS encoding") is satisfied only by the `MLSMessage`. **Resolved by ruling: task 11 declares it.** Task 11 now carries `DillaPublicGroup::queue_proposal`, which keeps the received bytes, and `queued_proposals() -> Vec<(ProposalRef, Vec<u8>)>`, which yields them; task 14 consumes the declared API and no longer stops on it. |
| A2-12 | §6 task 18 requires "in memory mode a reload produces a fresh client that **rejoins by external commit** and never reads an epoch from storage" (gap-15 AC-4) | task 18 asserts only the second half — the order log stops at `memory-boot`, `install` never appears, and no row survives the reload | the week-1 spike is store-only: it has no MLS group, no delivery service and no wire, so "exactly one external commit on the wire" cannot be observed by it at all. The external-commit half is carried by Plan A task 13's testkit scenarios and by the first browser-client task (W2), which is the first place an MLS client exists in the browser tier. |
| A2-13 | §2.10 field note: "`binding` is the 8-element `dilla_binding` CBOR, **spliced verbatim**" | element 5 of `public_group_state` is a CBOR **byte string** wrapping the 8-element binding array (`e.bytes(&binding)`), exactly as the same section's export table types it (`binding(bstr)`) | the field note and the table contradict each other. The table wins: splicing a bare array where the table promises a `bstr` would make §2.13's `mlswasi` decoder read a major-4 head where it expects major 2. The Go side decodes the `bstr`, then decodes the binding array out of those bytes. |
| A2-14 | §3.2 `core/dilla-core-wasm/Cargo.toml` has no `zeroize` | adds `zeroize = { version = "1", features = ["zeroize_derive"] }` (the §3.1 pin) to the crate's plain `[dependencies]` | `StoreHandle` has to keep the 256-bit device KEK for the lifetime of the handle so `resume()` can replay `PRAGMA key`, and it builds a pragma string containing that key on every open and resume. Holding both in `Zeroizing` is the only thing that keeps the KEK from lingering in freed wasm linear memory. |
| A2-15 | §1's `.gitignore` list (`!internal/mlswasi/testdata/*.wasm`, `core/dilla-core-wasm/spike/pkg/`, `core/dilla-core-wasm/spike/node_modules/`) | task 18 also adds `e2e/test-results/` | Playwright writes its report directory and `opfs-leader-metrics.json` there; task 20 transcribes those numbers into the spike report, so the directory is a local artefact, never a committed one. |
| A2-16 | the spec's memory-mode wording "no persistence in this browser" | the banner reads "Messages in this window won't be saved on this device." | gap-15 AC-7: the copy must name the **effect**, never the browser mode or the storage technology — the identical `SecurityError` fires in a normal Firefox window with site storage blocked, so "in this browser" would be wrong there. The exact string is asserted by task 18. |

---

### Task 0: Local Rust toolchain bootstrap and doctor script

**Files:**
- Create: `rust-toolchain.toml`
- Create: `scripts/doctor-rust.sh`
- Modify: `CONTRIBUTING.md` (add a `## Rust toolchain` section)
- Test: `scripts/doctor-rust.sh` is itself the test — it is an executable check with a non-zero exit code, run before and after the install.

**Interfaces:**
- Consumes: nothing.
- Produces: `rust-toolchain.toml` (`[toolchain] channel = "1.98.1"`); `scripts/doctor-rust.sh` (exit 0 when the toolchain is complete, non-zero with a list of what is missing); the binaries `/home/thim/.cargo/bin/{rustup,cargo,rustc,rustfmt,cargo-clippy}` and the target libdirs for `wasm32-unknown-unknown` and `wasm32-wasip1`.

Background the implementer needs (all verified in `gap-32-ci.md` §1 and §7, `facts-local-toolchain.md`):

- This machine has the Arch package `rust 1:1.98.1-1.1` at `/usr/bin/cargo` and **no rustup**. A distro `cargo` is a real binary, not a rustup proxy, so `rust-toolchain.toml` is read by nothing — it produces **zero** diagnostics and is silently ignored (reproduced in gap-32 §1.1). That is why the doctor script exists.
- `sudo` is not available, so `pacman -S rust-wasm` is not an option; the install is user-scoped rustup (gap-32 §7 Option B).
- Do **not** `pacman -S rustup`: that package `Conflicts With: rust` and would remove the system compiler (gap-32 §7, verbatim `pacman -Si` output).
- After the install, `~/.cargo/bin` is still **not** on `PATH` (verified). Every later step in this plan therefore calls `/home/thim/.cargo/bin/cargo` by absolute path.
- The whole change is reversible with `/home/thim/.cargo/bin/rustup self uninstall`; nothing under `/usr` is touched.

- [ ] **Step 1: Write the toolchain pin**

Create `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.98.1"
profile = "minimal"
components = ["clippy", "rustfmt"]
targets = ["wasm32-unknown-unknown", "wasm32-wasip1"]
```

- [ ] **Step 2: Write the failing test — `scripts/doctor-rust.sh`**

Create `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/scripts/doctor-rust.sh`. It is POSIX `sh`, it prints one line per problem, and it exits with the number of problems (capped at 125) so a caller can branch on it. `rustc --print target-libdir --target <t>` is used for the target check because it works with **and** without rustup (gap-32 §7, executed).

```sh
#!/bin/sh
# doctor-rust.sh - assert the Rust toolchain this repository pins is the one in use.
#
# rust-toolchain.toml is a rustup feature. A distro cargo ignores it silently, with no
# warning of any kind (gap-32-ci.md 1.1), so the pin has to be asserted out of band.
# Run from anywhere: every path below is derived from this script's own location.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cargo_home=${CARGO_HOME:-$HOME/.cargo}
problems=0

note() {
  printf 'MISSING: %s\n' "$1"
  problems=$((problems + 1))
}

want=$(sed -n 's/^channel = "\(.*\)"/\1/p' "$here/rust-toolchain.toml")
if [ -z "$want" ]; then
  note "rust-toolchain.toml has no [toolchain] channel"
  exit 1
fi

# 1. a user-scoped rustup toolchain at the pinned version
if [ ! -x "$cargo_home/bin/rustc" ]; then
  note "$cargo_home/bin/rustc (repo pins rustc $want)"
  printf '  fix: curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain none --profile minimal\n'
else
  have=$("$cargo_home/bin/rustc" --version | awk '{print $2}')
  [ "$have" = "$want" ] || note "rustc $want (found $have at $cargo_home/bin/rustc)"
fi

# 2. both wasm targets, checked through the pinned rustc
for t in wasm32-unknown-unknown wasm32-wasip1; do
  if [ -x "$cargo_home/bin/rustc" ]; then
    d=$("$cargo_home/bin/rustc" --print target-libdir --target "$t" 2>/dev/null || true)
    if [ -z "$d" ] || [ ! -d "$d" ]; then
      note "target $t (fix: $cargo_home/bin/rustup target add $t)"
    fi
  else
    note "target $t (no pinned rustc to check it with)"
  fi
done

# 3. clippy and rustfmt
for c in cargo-clippy rustfmt; do
  [ -x "$cargo_home/bin/$c" ] || note "component binary $cargo_home/bin/$c"
done

# 4. wasm-bindgen-cli must match the wasm-bindgen crate in Cargo.lock exactly:
#    the crate and the CLI share a SCHEMA_VERSION (facts-ci.md 1.6).
#    Skipped until the workspace lockfile exists (it arrives in task 1).
if [ -f "$here/Cargo.lock" ]; then
  locked=$(awk '/^name = "wasm-bindgen"$/{getline; sub(/^version = "/,""); sub(/"$/,""); print; exit}' "$here/Cargo.lock")
  if [ -z "$locked" ]; then
    printf 'note: Cargo.lock does not contain wasm-bindgen; skipping the CLI check\n'
  elif [ ! -x "$cargo_home/bin/wasm-bindgen" ]; then
    note "$cargo_home/bin/wasm-bindgen (Cargo.lock pins wasm-bindgen $locked)"
  else
    cli=$("$cargo_home/bin/wasm-bindgen" --version | awk '{print $2}')
    [ "$cli" = "$locked" ] || note "wasm-bindgen CLI $locked (found $cli)"
  fi
else
  printf 'note: no Cargo.lock yet; skipping the wasm-bindgen CLI check\n'
fi

# 5. the other two toolchains this repository builds with
node_major=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 || true)
if [ -z "$node_major" ] || [ "$node_major" -lt 24 ]; then
  note "node >= 24 (found ${node_major:-none})"
fi
# Go is user-installed at ~/.local/go/bin on this box (facts-local-toolchain.md) and may not be
# on PATH; probe both. The minor version is compared numerically - a glob would accept go1.3 and
# reject go1.40.
go_bin=$(command -v go 2>/dev/null || true)
[ -n "$go_bin" ] || { [ -x "$HOME/.local/go/bin/go" ] && go_bin="$HOME/.local/go/bin/go"; }
if [ -z "$go_bin" ]; then
  note "go >= go1.27.0 (found none)"
else
  go_ver=$("$go_bin" version | awk '{print $3}')
  go_minor=$(printf '%s' "$go_ver" | sed -n 's/^go1\.\([0-9][0-9]*\).*$/\1/p')
  if [ -z "$go_minor" ] || [ "$go_minor" -lt 27 ]; then
    note "go >= go1.27.0 (found ${go_ver:-none})"
  fi
fi

if [ "$problems" -eq 0 ]; then
  printf 'toolchain ok: rustc %s, wasm32-unknown-unknown + wasm32-wasip1, clippy, rustfmt\n' "$want"
  exit 0
fi
printf '%d problem(s)\n' "$problems"
[ "$problems" -gt 125 ] && exit 125
exit "$problems"
```

- [ ] **Step 3: Make it executable and run it to verify it fails**

```bash
chmod +x /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/scripts/doctor-rust.sh
```

```bash
/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/scripts/doctor-rust.sh
```

Expected: **FAIL**, exit code 5, printing (in this order)
`MISSING: /home/thim/.cargo/bin/rustc (repo pins rustc 1.98.1)`, the `fix:` line,
`MISSING: target wasm32-unknown-unknown (no pinned rustc to check it with)`,
`MISSING: target wasm32-wasip1 (no pinned rustc to check it with)`,
`MISSING: component binary /home/thim/.cargo/bin/cargo-clippy`,
`MISSING: component binary /home/thim/.cargo/bin/rustfmt`,
`note: no Cargo.lock yet; skipping the wasm-bindgen CLI check`,
`5 problem(s)`.

The count is 5 only when `node` and a `go` >= go1.27.0 are both reachable — `go` either on `PATH` or
at `$HOME/.local/go/bin/go`, which is where this box has it. If either is missing the doctor prints
its line too and exits 6 or 7; that is a correct report, not a failure of this step.

- [ ] **Step 4: Install rustup user-scoped, with no toolchain and no PATH edit**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/claude-1000/-home-thim-Repositories-dilla/77aae878-1e83-42c6-a875-6c5e93f17581/scratchpad/rustup-init.sh
```

```bash
sh /tmp/claude-1000/-home-thim-Repositories-dilla/77aae878-1e83-42c6-a875-6c5e93f17581/scratchpad/rustup-init.sh -y --no-modify-path --default-toolchain none --profile minimal
```

Expected: `Rust is installed now. Great!`, with binaries under `/home/thim/.cargo/bin` and no toolchain yet. `/usr/bin/cargo` is untouched.

- [ ] **Step 5: Install exactly the toolchain, components and targets the pin names**

Install them by name rather than relying on the working directory, so the command is correct wherever it runs:

```bash
/home/thim/.cargo/bin/rustup toolchain install 1.98.1 --profile minimal --component clippy --component rustfmt --target wasm32-unknown-unknown --target wasm32-wasip1
```

```bash
/home/thim/.cargo/bin/rustup default 1.98.1
```

Expected: `info: default toolchain set to '1.98.1-x86_64-unknown-linux-gnu'`.

- [ ] **Step 6: Run the doctor again to verify it passes**

```bash
/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/scripts/doctor-rust.sh
```

Expected: **PASS**, exit code 0, printing
`note: no Cargo.lock yet; skipping the wasm-bindgen CLI check` and
`toolchain ok: rustc 1.98.1, wasm32-unknown-unknown + wasm32-wasip1, clippy, rustfmt`.

- [ ] **Step 7: Verify the Arch package is untouched and the two installs are distinct**

```bash
pacman -Qo /usr/bin/cargo
```

Expected: `/usr/bin/cargo is owned by rust 1:1.98.1-1.1`.

```bash
/home/thim/.cargo/bin/rustc --version
```

Expected: a line beginning `rustc 1.98.1 ` **without** the `(Arch Linux rust 1:1.98.1-1.1)` suffix
that `/usr/bin/rustc` prints — that suffix is how the two installs are told apart. (The upstream
build hash and date are not recorded in any facts file; do not compare them.)

```bash
/home/thim/.cargo/bin/rustc --print target-libdir --target wasm32-wasip1
```

Expected: a path under `/home/thim/.rustup/toolchains/1.98.1-x86_64-unknown-linux-gnu/lib/rustlib/wasm32-wasip1/lib` that exists.

- [ ] **Step 8: Document the bootstrap in CONTRIBUTING.md**

Insert this section into `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/CONTRIBUTING.md` immediately **before** the existing `## Protocol changes` heading. The block below is fenced with **four** backticks because it contains a three-backtick fence of its own; insert only what is between them:

````markdown
## Rust toolchain

The repository pins its Rust toolchain in `rust-toolchain.toml`. That file is a **rustup**
feature: a distribution-packaged `cargo` ignores it without printing anything at all, so a
contributor on such a machine builds with whatever their package manager last installed while
believing the pin applies. Run `scripts/doctor-rust.sh` to find out; it exits non-zero and lists
what is missing.

Install a user-scoped rustup once, without touching the system compiler:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --no-modify-path --default-toolchain none --profile minimal
~/.cargo/bin/rustup toolchain install 1.98.1 --profile minimal \
  --component clippy --component rustfmt \
  --target wasm32-unknown-unknown --target wasm32-wasip1
```

Then put `~/.cargo/bin` at the front of your `PATH`. That makes `cargo` and `rustc` rustup proxies
for every project on the machine, not only this one; it is the intended effect, and
`rustup self uninstall` reverses all of it. Nothing under `/usr` is modified, so a
distribution-packaged Rust keeps working if you remove the `PATH` entry.
````

- [ ] **Step 9: Verify the documentation checks still pass**

```bash
npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run check:docs
```

Expected: PASS with no output problems (`CONTRIBUTING.md` is outside `protocol/`, so the placeholder scan does not apply to it, but the run confirms nothing else regressed).

- [ ] **Step 10: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add rust-toolchain.toml scripts/doctor-rust.sh CONTRIBUTING.md && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'chore: bootstrap a user-scoped rustup toolchain and a doctor script'
```

---

### Task 1: Cargo workspace, crate skeletons, cargo config and deny policy

**Files:**
- Create: `Cargo.toml`, `.cargo/config.toml`, `deny.toml`, `Cargo.lock` (generated, committed)
- Create: `core/dilla-core/{Cargo.toml,LICENSE,src/lib.rs}`
- Create: `core/dilla-core-wasm/{Cargo.toml,LICENSE,src/lib.rs}`
- Create: `core/dilla-core-wasi/{Cargo.toml,LICENSE,src/lib.rs}`
- Create: `testkit/{Cargo.toml,LICENSE,src/lib.rs}`
- Modify: `.gitignore`, `.editorconfig`
- Test: `core/dilla-core/tests/workspace_policy.rs`

All paths are relative to `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol`.

**Interfaces:**
- Consumes: `rust-toolchain.toml`, `scripts/doctor-rust.sh` (task 0).
- Produces: the four-crate workspace; `dilla_core::{CORE_VERSION, E2EE_VERSION, MEDIA_VERSION, WIRE_VERSION, ABI_VERSION}` with the exact signatures
  `pub const CORE_VERSION: &str`, `pub const E2EE_VERSION: u64 = 1`, `pub const MEDIA_VERSION: u64 = 1`, `pub const WIRE_VERSION: u64 = 1`, `pub const ABI_VERSION: u64 = 1`.

- [ ] **Step 1: Write the failing test**

Create `core/dilla-core/tests/workspace_policy.rs`. It pins the two workspace rules that are
invisible to the compiler: `.cargo/config.toml` must carry no `rustflags` key (a workflow-level
`RUSTFLAGS` would override every `target.*.rustflags` outright, and `--cfg getrandom_backend` is not
an allowed cfg value in getrandom 0.4.x — gap-29, D7), and the version constants must be the ones
every wire format is keyed to.

```rust
//! Workspace-level policy that the compiler cannot enforce on its own.

const CARGO_CONFIG: &str = include_str!("../../../.cargo/config.toml");

#[test]
fn cargo_config_sets_no_rustflags() {
    for (n, line) in CARGO_CONFIG.lines().enumerate() {
        let code = line.split('#').next().unwrap_or("").trim();
        assert!(
            !code.starts_with("rustflags"),
            ".cargo/config.toml line {} sets rustflags; \
             getrandom >= 0.3.4 selects its backend from the `wasm_js` crate feature and a \
             workflow-level RUSTFLAGS would override this table outright",
            n + 1
        );
    }
}

#[test]
fn cargo_config_pins_the_node_runner_for_wasm32_unknown_unknown() {
    assert!(CARGO_CONFIG.contains("[target.wasm32-unknown-unknown]"));
    assert!(CARGO_CONFIG.contains("runner = \"wasm-bindgen-test-runner\""));
}

#[test]
fn cargo_config_pins_no_wasip1_runner() {
    // The wasip1 vector check runs under wazero from Go, not under wasmtime (D6, R7).
    assert!(!CARGO_CONFIG.contains("[target.wasm32-wasip1]"));
}

#[test]
fn version_constants_are_the_wire_values() {
    assert_eq!(dilla_core::E2EE_VERSION, 1);
    assert_eq!(dilla_core::MEDIA_VERSION, 1);
    assert_eq!(dilla_core::WIRE_VERSION, 1);
    assert_eq!(dilla_core::ABI_VERSION, 1);
    assert_eq!(dilla_core::CORE_VERSION, "0.1.0");
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --test workspace_policy
```

Expected: FAIL with ``error: manifest path `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml` does not exist`` — there is no workspace yet. (Cargo prints "the manifest-path must be a path to a Cargo.toml file" only when the path's file name is not `Cargo.toml`.)

- [ ] **Step 3: Write the workspace manifest**

Create `Cargo.toml` (virtual manifest). `default-members` keeps a bare `cargo build` from linking the
two `cdylib` shims natively (gap-24 §2.3). Editions are per crate and interoperate by design, so
edition 2024 next to edition-2021 `openmls 0.9.0` is not a conflict (gap-32 §2).

```toml
[workspace]
resolver = "3"
members = [
    "core/dilla-core",
    "core/dilla-core-wasm",
    "core/dilla-core-wasi",
    "testkit",
]
default-members = ["core/dilla-core", "testkit"]

[workspace.package]
edition = "2024"
rust-version = "1.98"
repository = "https://github.com/jonasthim/dilla"

[workspace.lints.rust]
unsafe_code = "warn"          # dilla-core forbids it outright; the wasi crate opts back in

[profile.release]
lto = "thin"
codegen-units = 1
```

- [ ] **Step 4: Write `.cargo/config.toml`**

Create `.cargo/config.toml`. Any edit to this file invalidates every `Swatinem/rust-cache` key in the
repository, so it is written once here and not churned (gap-29 §4 iii).

```toml
# Pure-wasm unit tests run under Node (R6): no chromedriver on this box, and Playwright's
# Chromium cannot drive wasm-bindgen-test.
[target.wasm32-unknown-unknown]
runner = "wasm-bindgen-test-runner"

# NOTE: deliberately NO rustflags here.
# getrandom >= 0.3.4 selects the Web Crypto backend from the `wasm_js` CRATE FEATURE alone;
# `--cfg getrandom_backend="wasm_js"` is not an allowed value of that cfg in 0.4.x, so setting it
# would be silently inert (gap-29). Also: a workflow-level `RUSTFLAGS` env var would override every
# `target.*.rustflags` entry outright, not merge with it.
#
# NOTE: deliberately NO [target.wasm32-wasip1] runner.
# The wasip1 vector check runs under wazero from Go (Plan B task 4, R7), not under wasmtime.
```

- [ ] **Step 5: Write the four crate manifests**

`core/dilla-core/Cargo.toml`:

```toml
[package]
name = "dilla-core"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
license = "Apache-2.0"
repository.workspace = true
publish = false

[lib]
crate-type = ["rlib"]

[features]
default = []
vectors = ["dep:serde_json"]

[dependencies]
# MLS - pinned by the spec; openmls 0.9.0 rust-version = 1.91.0
openmls                  = { version = "0.9.0", default-features = false }
openmls_traits           = "0.6.0"
openmls_rust_crypto      = "0.6.0"
openmls_basic_credential = "0.6.0"
tls_codec                = { version = "0.5.0", features = ["derive", "serde", "mls"] }
# primitives - the majors openmls_rust_crypto 0.6.0 already requires (gap-10 section 1);
# taking "latest" would add a SECOND major of ed25519-dalek, curve25519-dalek and aes-gcm.
ed25519-dalek = { version = "2.2", default-features = false, features = ["std", "zeroize"] }
sha2          = "0.11"
hmac          = "0.13"
hkdf          = "0.13"
aes-gcm       = { version = "0.10.3", default-features = false, features = ["aes", "alloc"] }
# serde codec for the OpenMLS StorageProvider blobs ONLY (deviation A1-5, gap-6 section 4).
# Never used to decode a normative dilla format: those go through crate::cbor.
ciborium   = { version = "0.2.2", default-features = false, features = ["std"] }
serde      = { version = "1", features = ["derive"] }
serde_json = { version = "1.0.151", optional = true }     # feature `vectors` only
thiserror  = "2.0"
zeroize    = { version = "1", features = ["zeroize_derive"] }

[target.'cfg(not(target_arch = "wasm32"))'.dependencies]
rusqlite = { version = "0.40.2", features = ["bundled-sqlcipher-vendored-openssl"] }

[target.'cfg(all(target_arch = "wasm32", target_os = "unknown"))'.dependencies]
# rusqlite's default features include `ffi-sqlite-wasm-rs`; dropping them breaks the wasm FFI
# backend entirely (gap-12 T1). Keep defaults, and add `sqlite3mc` on sqlite-wasm-rs so feature
# unification compiles the encrypting amalgamation into rusqlite's single copy.
rusqlite        = { version = "0.40.2" }
sqlite-wasm-rs  = { version = "0.5.5", default-features = false, features = ["sqlite3mc"] }
sqlite-wasm-vfs = "0.2.0"       # NO [features] table on 0.2.0 - do not write features = [...]
getrandom_02    = { package = "getrandom", version = "0.2.17", features = ["js"] }
getrandom_04    = { package = "getrandom", version = "0.4.3",  features = ["wasm_js"] }
openmls         = { version = "0.9.0", default-features = false, features = ["js"] }

[dev-dependencies]
serde_json = "1.0.151"
hex        = "0.4"

[lints]
workspace = true
```

Three rules the implementer must not "tidy away":

1. The target gates use **`target_os`**, not `target_arch`. `wasm32-unknown-unknown` is
   `target_os = "unknown"` and `wasm32-wasip1` is `target_os = "wasi"`; a bare
   `target_arch = "wasm32"` would wrongly turn the JS backends on for the wasip1 build (gap-10 §3.2).
2. `getrandom` stays on **two** majors (0.2.17 and 0.4.3) for as long as `openmls_rust_crypto 0.6.0`
   is pinned. This is not fixable by dilla (gap-10 §2).
3. `openmls`'s `js-test` feature is for openmls's own test suite; never enable it in a build. Do
   **not** enable `openmls/js` for wasip1 either: there `SystemTime::now()` goes through WASI
   `clock_time_get`, which wazero serves (facts-wazero §6). The `0-8-1-storage-format` feature stays
   off and is inert under a self-describing codec (gap-6 §2.4).

`core/dilla-core-wasm/Cargo.toml`:

```toml
[package]
name = "dilla-core-wasm"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
license = "Apache-2.0"
repository.workspace = true
publish = false

[lib]
crate-type = ["cdylib", "rlib"]      # wasm-pack requires cdylib on the crate it is given

[dependencies]
dilla-core = { path = "../dilla-core", features = ["vectors"] }
wasm-bindgen         = "0.2.128"
wasm-bindgen-futures = "0.4.54"
js-sys               = "0.3.81"
web-sys  = { version = "0.3.81", features = [
  "StorageManager", "FileSystemSyncAccessHandle", "FileSystemDirectoryHandle",
  "FileSystemGetDirectoryOptions", "FileSystemReadWriteOptions", "WorkerGlobalScope",
  "WorkerNavigator", "FileSystemGetFileOptions", "FileSystemFileHandle",
  "DedicatedWorkerGlobalScope", "Navigator", "Lock", "LockManager",
] }
serde_json = "1.0.151"
console_error_panic_hook = "0.1"

[dev-dependencies]
wasm-bindgen-test = "0.3.78"

[lints]
workspace = true
```

`core/dilla-core-wasi/Cargo.toml` (deviation A1-2: no `minicbor`; the crate uses `dilla_core::cbor`):

```toml
[package]
name = "dilla-core-wasi"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
license = "Apache-2.0"
repository.workspace = true
publish = false

[lib]
crate-type = ["cdylib"]

[dependencies]
dilla-core = { path = "../dilla-core", features = ["vectors"] }
```

**No `[profile.release]` table here** (deviation A1-14, against interfaces §3.3). Cargo ignores
profile sections outside the workspace root and prints `warning: profiles for the non root package
will be ignored, specify profiles at the workspace root`, so `opt-level = "s"` / `lto = true` /
`panic = "abort"` written here would never apply — while reading as though they had. The root
`[profile.release]` (`lto = "thin"`, `codegen-units = 1`) governs this cdylib, and `panic = "abort"`
is already the wasip1 default and is not settable per package. Plan B task 5 benchmarks the artefact
this profile produces, so the two must not disagree.

No `js` feature, no `wasm-bindgen`, no `getrandom` feature: on wasip1 randomness resolves to WASI
`random_get` and time to `clock_time_get`, both served by wazero's `ModuleConfig`. This crate does not
inherit `[lints] workspace = true`, because it re-enables `unsafe_code` for the `extern "C"` exports
(task 14).

`testkit/Cargo.toml`:

```toml
[package]
name = "dilla-testkit"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
license = "AGPL-3.0-or-later"
repository.workspace = true
publish = false

[dependencies]
dilla-core = { path = "../core/dilla-core", features = ["vectors"] }
openmls                  = "0.9.0"
openmls_traits           = "0.6.0"
openmls_rust_crypto      = "0.6.0"
openmls_basic_credential = "0.6.0"
rusqlite    = { version = "0.40.2", features = ["bundled-sqlcipher-vendored-openssl"] }
serde       = { version = "1", features = ["derive"] }
serde_json  = "1.0.151"
thiserror   = "2.0"
hex         = "0.4"
rand_chacha = "0.3"     # deterministic seeding; matches openmls_rust_crypto's major
clap        = { version = "4", features = ["derive"] }

[[bin]]
name = "dilla-testkit"
path = "src/bin/dilla-testkit.rs"

[lints]
workspace = true
```

- [ ] **Step 6: Write the crate roots and the licence files**

`core/dilla-core/src/lib.rs`. The module declarations are **not** written here: each later task adds
its own `pub mod` line together with the file it declares, so the crate compiles after every task.
The end state is §2.0 of the interface contract, reached at task 11.

```rust
//! dilla-core: the cryptographic, protocol and storage core of dilla.
//!
//! Every module here is target-agnostic. The two binding crates
//! (`dilla-core-wasm`, `dilla-core-wasi`) hold the target-specific glue.
#![forbid(unsafe_code)]

/// The crate version, reported over every binding.
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");
/// `e2ee_version` as recorded in every `dilla_binding` (protocol/07-versioning.md).
pub const E2EE_VERSION: u64 = 1;
/// `media_version` for call groups (protocol/07-versioning.md).
pub const MEDIA_VERSION: u64 = 1;
/// The HTTP `/v1` and gateway frame version (protocol/07-versioning.md).
pub const WIRE_VERSION: u64 = 1;
/// The wasi ABI version carried in every request and response envelope.
pub const ABI_VERSION: u64 = 1;
```

`core/dilla-core-wasm/src/lib.rs`:

```rust
//! wasm-bindgen bindings for the browser tier. Filled in by task 15 of this plan.
```

`core/dilla-core-wasi/src/lib.rs`:

```rust
//! wasm32-wasip1 C-ABI exports for the wazero host. Filled in by task 14 of this plan.
```

`testkit/src/lib.rs`:

```rust
//! dilla-testkit: an in-memory delivery service, headless clients and a scenario DSL.
//! Filled in by tasks 12 and 13 of this plan.
```

`testkit/src/bin/dilla-testkit.rs`:

```rust
fn main() {
    // Subcommands `run`, `vectors` and `gen-public-group` arrive in tasks 12 and 13.
    eprintln!("dilla-testkit: no subcommand implemented yet");
    std::process::exit(2);
}
```

Copy the licence files:

```bash
cp /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/LICENSE-APACHE /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core/LICENSE
```

```bash
cp /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/LICENSE-APACHE /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasm/LICENSE
```

```bash
cp /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/LICENSE-APACHE /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasi/LICENSE
```

```bash
cp /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/LICENSE /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/testkit/LICENSE
```

- [ ] **Step 7: Extend `.gitignore` and `.editorconfig`**

Append to `.gitignore` (the root file already ignores `/target/`, `*.wasm`, `*.db`, `*.sqlite`):

```
# rust / wasm
!internal/mlswasi/testdata/*.wasm
core/dilla-core-wasm/spike/pkg/
core/dilla-core-wasm/spike/node_modules/
```

Append to `.editorconfig` (rustfmt's default is 4 spaces, which fights the file's 2-space `[*]` rule):

```
[*.rs]
indent_size = 4
```

- [ ] **Step 8: Write the dependency policy**

Create `deny.toml`. Each `[[bans.skip]]` names the upstream condition that would remove it, so the
list shrinks by itself rather than rotting (gap-10 §2 enumerates exactly these seven).

```toml
[graph]
targets = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu",
           "wasm32-unknown-unknown", "wasm32-wasip1"]
all-features = true

[advisories]
yanked = "deny"
unmaintained = "workspace"
ignore = []

[licenses]
allow = ["Apache-2.0", "MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unicode-3.0",
         "Zlib", "MPL-2.0"]
confidence-threshold = 0.9

[licenses.private]
ignore = true                      # every dilla crate is publish = false

[bans]
multiple-versions = "deny"
wildcards = "deny"

[[bans.skip]]
crate = "sha2"
reason = "ed25519-dalek 2.2 needs sha2 0.10; openmls_rust_crypto needs 0.11. Collapses when openmls_rust_crypto adopts ed25519-dalek 3."

[[bans.skip]]
crate = "digest"
reason = "sha2 0.10 pulls digest 0.10 while sha2 0.11 pulls digest 0.11. Collapses with the sha2 entry."

[[bans.skip]]
crate = "crypto-common"
reason = "digest 0.10 and digest 0.11 each pin their own crypto-common major. Collapses with the digest entry."

[[bans.skip]]
crate = "signature"
reason = "ed25519-dalek 2.2 pins signature 2.x while the 0.11 digest stack pins signature 3.x. Collapses when ed25519-dalek 3 ships."

[[bans.skip]]
crate = "rand_core"
reason = "openmls_rust_crypto 0.6.0 carries both rand_core 0.6.4 (ed25519-dalek 2.2) and 0.10.1 (the 0.11 digest stack). Collapses when ed25519-dalek 3 ships."

[[bans.skip]]
crate = "rand_chacha"
reason = "rand_chacha follows rand_core's two majors. Collapses with the rand_core entry."

[[bans.skip]]
crate = "getrandom"
reason = "getrandom 0.2.17 serves rand_core 0.6 and 0.4.3 serves rand_core 0.10; both are required while openmls_rust_crypto 0.6.0 is pinned. Not fixable by dilla (gap-10 section 2)."

[sources]
unknown-registry = "deny"
unknown-git = "deny"
```

- [ ] **Step 9: Resolve the dependency graph and commit the lockfile**

```bash
/home/thim/.cargo/bin/cargo metadata --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml --format-version 1 --locked
```

Expected on the **first** run: FAIL with `error: the lock file … needs to be updated but --locked was passed`. Generate it, then re-run:

```bash
/home/thim/.cargo/bin/cargo generate-lockfile --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml
```

```bash
/home/thim/.cargo/bin/cargo metadata --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml --format-version 1 --locked
```

Expected: PASS — a JSON document on stdout, exit 0.

Then record the two versions that §3.4 marks **[NV]** (`clap 4` and `rand_chacha 0.3` are chosen by
this plan, not pinned by any facts file) so the plan's claim and the lockfile agree:

```bash
grep -A1 -E '^name = "(clap|rand_chacha|wasm-bindgen|ciborium|half)"$' /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.lock
```

Expected: `wasm-bindgen` resolves to `0.2.128`, `ciborium` to `0.2.2`, and `clap`/`rand_chacha`/`half`
to some exact patch versions. Write the four observed versions into the commit body.

- [ ] **Step 10: Install the two wasm CLIs at the locked versions**

`wasm-bindgen-cli` must be **exactly** the `wasm-bindgen` version in `Cargo.lock`: the crate and the
CLI share a `SCHEMA_VERSION` (facts-ci §1.6). `wasm-pack 0.15.0` is the version CI installs (§5).

```bash
/home/thim/.cargo/bin/cargo install wasm-bindgen-cli --version 0.2.128 --locked
```

```bash
/home/thim/.cargo/bin/cargo install wasm-pack --version 0.15.0 --locked
```

```bash
/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/scripts/doctor-rust.sh
```

Expected: PASS, exit 0, and this time **without** the "no Cargo.lock yet" note — the wasm-bindgen CLI
check now runs and matches.

- [ ] **Step 11: Run the test to verify it passes, natively and on both wasm targets**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --test workspace_policy --locked
```

Expected: PASS, `test result: ok. 4 passed; 0 failed`.

```bash
/home/thim/.cargo/bin/cargo build --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml --workspace --locked
```

Expected: PASS — all four crates compile natively.

```bash
/home/thim/.cargo/bin/cargo build --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core -p dilla-core-wasm --target wasm32-unknown-unknown --locked
```

Expected: PASS.

```bash
/home/thim/.cargo/bin/cargo build --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core-wasi --target wasm32-wasip1 --locked
```

Expected: PASS.

- [ ] **Step 12: Run the dependency policy**

```bash
/home/thim/.cargo/bin/cargo install cargo-deny --version 0.20.2 --locked
```

```bash
/home/thim/.cargo/bin/cargo deny --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml --all-features check advisories bans licenses sources
```

Expected: PASS, `advisories ok, bans ok, licenses ok, sources ok`. If the `licenses` check names a
licence that is not in the allow list — the only candidate the facts files do not pin is `half`, a
transitive dependency of `ciborium-ll` — add exactly that SPDX identifier to `[licenses] allow` with a
one-line comment naming the crate that carries it, and re-run. Do **not** widen the list speculatively.

- [ ] **Step 13: Format and lint**

```bash
/home/thim/.cargo/bin/cargo fmt --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml --all
```

```bash
/home/thim/.cargo/bin/cargo clippy --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml --workspace --all-targets --all-features --locked -- -D warnings
```

Expected: PASS with no warnings.

- [ ] **Step 14: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add Cargo.toml Cargo.lock .cargo/config.toml deny.toml .gitignore .editorconfig core testkit && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'chore: add the cargo workspace, dilla-core crate skeletons and the dependency policy'
```
---

### Task 2: Deterministic CBOR encoder and strict decoder

**Files:**
- Create: `core/dilla-core/src/cbor/mod.rs`, `core/dilla-core/src/cbor/enc.rs`, `core/dilla-core/src/cbor/dec.rs`
- Modify: `core/dilla-core/src/lib.rs` (add `pub mod cbor;`)
- Test: `core/dilla-core/tests/cbor_reject.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  `cbor::MAX_NESTING: usize = 8`;
  `cbor::head_len(arg: u64) -> usize`;
  `cbor::CborError` (the 14 variants of the contract);
  `cbor::Encoder` with `new()`, `with_capacity(usize)`, and the chainable `array(usize)`, `uint(u64)`, `bytes(&[u8])`, `text(&str)`, `null()`, `opt_bytes(Option<&[u8]>)`, `opt_uint(Option<u64>)`, `raw(&[u8])` all returning `&mut Self`, plus `as_slice(&self) -> &[u8]` and `into_vec(self) -> Vec<u8>`;
  `cbor::Decoder<'a>` with `new(&'a [u8])`, `array(usize) -> Result<(), CborError>`, `array_len() -> Result<usize, CborError>`, `uint() -> Result<u64, CborError>`, `bytes() -> Result<&'a [u8], CborError>`, `bytes_exact::<N>() -> Result<[u8; N], CborError>`, `text() -> Result<&'a str, CborError>`, `null() -> Result<(), CborError>`, `try_null() -> Result<bool, CborError>`, `opt_bytes_exact::<N>() -> Result<Option<[u8; N]>, CborError>`, `opt_uint() -> Result<Option<u64>, CborError>`, `skip() -> Result<&'a [u8], CborError>`, `position() -> usize`, `finish(self) -> Result<(), CborError>`;
  `cbor::decode_strict<T>(&[u8], impl FnOnce(&mut Decoder<'_>) -> Result<T, CborError>) -> Result<T, CborError>`.

This is the subset `protocol/00-overview.md` and `protocol/04-envelope-and-franking.md` define:
majors 0 (uint), 2 (bstr), 3 (tstr), 4 (array) and the simple value 22 (`null`, `0xf6`). No
negatives, no maps, no tags, no floats, no indefinite items, no other simple values. It is a
one-for-one port of `packages/protocol-vectors/src/cbor.ts`, which is the de-facto normative
reference (`facts-repo.md` §1.1) and generates the committed vectors.

- [ ] **Step 1: Write the failing test**

Create `core/dilla-core/tests/cbor_reject.rs`:

```rust
//! The accept and reject corpora of protocol/04 "Deterministic CBOR",
//! ported from packages/protocol-vectors/src/cbor.test.ts and extended with the
//! cases gap-27 section 7 item 5 found ciborium accepting.

use dilla_core::cbor::{decode_strict, CborError, Decoder, Encoder, MAX_NESTING};

fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len() % 2 == 0, "odd hex length: {s}");
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit"))
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Every reject case must fail when the item is merely *skipped*: strictness lives in the
/// decoder's head parser, not in the typed readers.
fn skip_all(bytes: &[u8]) -> Result<(), CborError> {
    decode_strict(bytes, |d| d.skip().map(|_| ()))
}

#[test]
fn accepts_and_round_trips_the_uint_corpus() {
    for (v, expect) in [
        (0u64, "00"),
        (1, "01"),
        (10, "0a"),
        (23, "17"),
        (24, "1818"),
        (25, "1819"),
        (100, "1864"),
        (1000, "1903e8"),
        (1_000_000, "1a000f4240"),
        (1_000_000_000_000, "1b000000e8d4a51000"),
    ] {
        let mut e = Encoder::new();
        e.uint(v);
        assert_eq!(hex(e.as_slice()), expect, "encoding {v}");
        assert_eq!(decode_strict(e.as_slice(), |d| d.uint()).unwrap(), v);
    }
}

#[test]
fn accepts_and_round_trips_the_string_and_bytes_corpus() {
    for (s, expect) in [("", "60"), ("a", "6161"), ("IETF", "6449455446"), ("\u{fc}", "62c3bc")] {
        let mut e = Encoder::new();
        e.text(s);
        assert_eq!(hex(e.as_slice()), expect, "encoding {s:?}");
        assert_eq!(decode_strict(e.as_slice(), |d| d.text().map(str::to_owned)).unwrap(), s);
    }
    for (b, expect) in [(&[][..], "40"), (&[1, 2, 3, 4][..], "4401020304")] {
        let mut e = Encoder::new();
        e.bytes(b);
        assert_eq!(hex(e.as_slice()), expect);
        assert_eq!(decode_strict(e.as_slice(), |d| d.bytes().map(<[u8]>::to_vec)).unwrap(), b);
    }
}

#[test]
fn accepts_and_round_trips_null_and_arrays() {
    let mut e = Encoder::new();
    e.null();
    assert_eq!(hex(e.as_slice()), "f6");
    assert!(decode_strict(e.as_slice(), |d| d.null()).is_ok());

    let mut e = Encoder::new();
    e.array(0);
    assert_eq!(hex(e.as_slice()), "80");

    let mut e = Encoder::new();
    e.array(3).uint(1).uint(2).uint(3);
    assert_eq!(hex(e.as_slice()), "83010203");
    let got = decode_strict(e.as_slice(), |d| {
        d.array(3)?;
        Ok([d.uint()?, d.uint()?, d.uint()?])
    })
    .unwrap();
    assert_eq!(got, [1, 2, 3]);

    // [1, [2, 3], [4, 5]] - fixed-position nesting, no automatic descent
    let mut e = Encoder::new();
    e.array(3).uint(1).array(2).uint(2).uint(3).array(2).uint(4).uint(5);
    assert_eq!(hex(e.as_slice()), "8301820203820405");
}

#[test]
fn head_len_matches_the_encoder() {
    for arg in [0u64, 23, 24, 255, 256, 65_535, 65_536, 0xffff_ffff, 0x1_0000_0000, u64::MAX] {
        let mut e = Encoder::new();
        e.uint(arg);
        assert_eq!(
            dilla_core::cbor::head_len(arg),
            e.as_slice().len(),
            "head_len disagrees with the encoder for {arg}"
        );
    }
}

#[test]
fn rejects_non_minimal_integer_arguments() {
    for case in ["1801", "1817", "190017", "1a00000017", "1b0000000000000017", "1900ff"] {
        assert_eq!(skip_all(&unhex(case)), Err(CborError::NonMinimalInt), "case {case}");
    }
}

#[test]
fn rejects_non_minimal_lengths_on_majors_2_3_4() {
    for case in ["5800", "7800", "9800", "990003010203"] {
        assert_eq!(skip_all(&unhex(case)), Err(CborError::NonMinimalInt), "case {case}");
    }
}

#[test]
fn rejects_indefinite_lengths() {
    for (case, ai) in [("9f01ff", 31u8), ("5f41014102ff", 31), ("7f6161ff", 31), ("bf0101ff", 31)] {
        assert_eq!(
            skip_all(&unhex(case)),
            Err(CborError::IndefiniteOrReserved(ai)),
            "case {case}"
        );
    }
}

#[test]
fn rejects_maps_tags_floats_and_negatives() {
    for case in ["a0", "a10102"] {
        assert_eq!(skip_all(&unhex(case)), Err(CborError::MapForbidden), "case {case}");
    }
    for case in ["c11a514b67b0", "d8ff01", "c001"] {
        assert_eq!(skip_all(&unhex(case)), Err(CborError::TagForbidden), "case {case}");
    }
    for case in ["fb3ff0000000000000", "f93c00"] {
        assert_eq!(skip_all(&unhex(case)), Err(CborError::FloatForbidden), "case {case}");
    }
    assert_eq!(skip_all(&unhex("20")), Err(CborError::NegativeForbidden));
}

#[test]
fn rejects_every_simple_value_but_null() {
    assert_eq!(skip_all(&unhex("f7")), Err(CborError::SimpleForbidden(23)));  // undefined
    assert_eq!(skip_all(&unhex("f816")), Err(CborError::SimpleForbidden(22))); // non-minimal null
    assert_eq!(skip_all(&unhex("f4")), Err(CborError::SimpleForbidden(20)));  // false
    assert_eq!(skip_all(&unhex("f5")), Err(CborError::SimpleForbidden(21)));  // true
}

#[test]
fn rejects_reserved_additional_information() {
    for (case, ai) in [("1c", 28u8), ("1d", 29), ("1e", 30)] {
        assert_eq!(
            skip_all(&unhex(case)),
            Err(CborError::IndefiniteOrReserved(ai)),
            "case {case}"
        );
    }
}

#[test]
fn rejects_trailing_bytes() {
    for case in ["0101", "01a0", "83010203ff", "83010203ffffffff"] {
        assert_eq!(skip_all(&unhex(case)), Err(CborError::TrailingBytes), "case {case}");
    }
}

#[test]
fn rejects_truncation_and_bad_utf8() {
    assert_eq!(skip_all(&unhex("5820")), Err(CborError::Truncated));
    assert_eq!(skip_all(&unhex("6263c3")), Err(CborError::InvalidUtf8));
}

#[test]
fn rejects_shape_confusion_in_both_directions() {
    // an array offered where a byte string is required
    let err = decode_strict(&unhex("820102"), |d| d.bytes().map(|_| ())).unwrap_err();
    assert!(matches!(err, CborError::TypeMismatch { expected: "bytes", offset: 0 }), "{err:?}");
    // a byte string offered where an array is required
    let err = decode_strict(&unhex("420102"), |d| d.array(2)).unwrap_err();
    assert!(matches!(err, CborError::TypeMismatch { expected: "array", offset: 0 }), "{err:?}");
}

#[test]
fn rejects_wrong_array_and_byte_lengths() {
    let err = decode_strict(&unhex("83010203"), |d| d.array(9)).unwrap_err();
    assert_eq!(err, CborError::WrongArrayLen { expected: 9, actual: 3 });
    let err = decode_strict(&unhex("4401020304"), |d| d.bytes_exact::<16>().map(|_| ())).unwrap_err();
    assert_eq!(err, CborError::WrongByteLen { expected: 16, actual: 4 });
}

#[test]
fn accepts_nesting_up_to_the_limit_and_rejects_deeper() {
    let ok: Vec<u8> = std::iter::repeat_n(0x81u8, MAX_NESTING).chain([0x00]).collect();
    assert!(skip_all(&ok).is_ok(), "{} nested arrays must be accepted", MAX_NESTING);

    // The boundary itself, not a comfortably deeper case: an off-by-one in `skip_inner`'s
    // `depth > MAX_NESTING` would accept 9 levels and still pass a `MAX_NESTING + 2` assertion.
    let one_too_deep: Vec<u8> =
        std::iter::repeat_n(0x81u8, MAX_NESTING + 1).chain([0x00]).collect();
    assert_eq!(skip_all(&one_too_deep), Err(CborError::TooDeep(MAX_NESTING)));

    let deep: Vec<u8> = std::iter::repeat_n(0x81u8, MAX_NESTING + 8).chain([0x00]).collect();
    assert_eq!(skip_all(&deep), Err(CborError::TooDeep(MAX_NESTING)));
}

#[test]
fn skip_returns_the_bytes_it_consumed_and_position_tracks() {
    let bytes = unhex("83010203" /* [1,2,3] */);
    let mut d = Decoder::new(&bytes);
    assert_eq!(d.position(), 0);
    assert_eq!(d.skip().unwrap(), &bytes[..]);
    assert_eq!(d.position(), bytes.len());
    assert!(d.finish().is_ok());
}

#[test]
fn optional_readers_consume_nothing_on_a_non_null() {
    let bytes = unhex("5001020304050607080910111213141516");
    let got = decode_strict(&bytes, |d| d.opt_bytes_exact::<16>()).unwrap();
    assert_eq!(got.unwrap()[0], 0x01);

    let got = decode_strict(&unhex("f6"), |d| d.opt_bytes_exact::<16>()).unwrap();
    assert!(got.is_none());

    let got = decode_strict(&unhex("1864"), |d| d.opt_uint()).unwrap();
    assert_eq!(got, Some(100));
}

#[test]
fn raw_splices_an_already_encoded_sub_item() {
    let mut inner = Encoder::new();
    inner.array(2).uint(2).uint(3);
    let mut outer = Encoder::new();
    outer.array(2).uint(1).raw(inner.as_slice());
    assert_eq!(hex(outer.as_slice()), "8201820203");
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --test cbor_reject --locked
```

Expected: FAIL with `error[E0432]: unresolved import dilla_core::cbor` — the module does not exist yet.

- [ ] **Step 3: Write the module root**

Create `core/dilla-core/src/cbor/mod.rs`:

```rust
//! Deterministic CBOR (RFC 8949 section 4.2.1 core deterministic encoding) restricted to the
//! subset protocol/00-overview.md and protocol/04-envelope-and-franking.md define:
//! majors 0 (uint), 2 (bstr), 3 (tstr), 4 (array) and the simple value 22 (`null`).
//!
//! Every structure is a **fixed-position array**; there are no maps, so there is no map-key
//! ordering question. The decoder rejects non-minimal integer arguments, indefinite lengths,
//! reserved additional information, tags, floats, negative integers, every simple value other
//! than `null`, invalid UTF-8 and trailing bytes.
//!
//! This is a port of `packages/protocol-vectors/src/cbor.ts`, the reference implementation that
//! generates `protocol/vectors/*.json`. Keep the two in step: CI diffs the vectors in both
//! directions.

mod dec;
mod enc;

pub use dec::{decode_strict, Decoder};
pub use enc::Encoder;

/// The deepest array nesting `Decoder::skip` will descend through.
///
/// The typed readers (`array`, `uint`, `bytes`, ...) are driven by hand-written decoders whose
/// nesting is fixed at compile time, so the limit exists for `skip`, which is the only place an
/// attacker chooses the depth.
pub const MAX_NESTING: usize = 8;

/// Every way a strict decode can fail.
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
#[non_exhaustive]
pub enum CborError {
    #[error("non-minimal integer argument")]
    NonMinimalInt,
    #[error("indefinite length or reserved additional info {0}")]
    IndefiniteOrReserved(u8),
    #[error("map not allowed")]
    MapForbidden,
    #[error("tag not allowed")]
    TagForbidden,
    #[error("float not allowed")]
    FloatForbidden,
    #[error("negative integer not allowed")]
    NegativeForbidden,
    #[error("simple value {0} not allowed")]
    SimpleForbidden(u8),
    #[error("trailing bytes after the top-level item")]
    TrailingBytes,
    #[error("truncated input")]
    Truncated,
    #[error("invalid utf-8 in text string")]
    InvalidUtf8,
    #[error("array length {actual}, expected {expected}")]
    WrongArrayLen { expected: usize, actual: usize },
    #[error("byte string length {actual}, expected {expected}")]
    WrongByteLen { expected: usize, actual: usize },
    #[error("expected {expected} at offset {offset}")]
    TypeMismatch { expected: &'static str, offset: usize },
    #[error("integer does not fit")]
    IntegerOverflow,
    #[error("nesting deeper than {0}")]
    TooDeep(usize),
}

/// The number of bytes CBOR's preferred serialization spends on a head whose argument is `arg`,
/// the head byte included.
pub const fn head_len(arg: u64) -> usize {
    if arg < 24 {
        1
    } else if arg < 0x100 {
        2
    } else if arg < 0x1_0000 {
        3
    } else if arg < 0x1_0000_0000 {
        5
    } else {
        9
    }
}
```

- [ ] **Step 4: Write the encoder**

Create `core/dilla-core/src/cbor/enc.rs`:

```rust
use super::head_len;

/// A deterministic CBOR encoder for fixed-position arrays.
///
/// Every method is chainable and infallible: the caller decides the array lengths, so there is
/// nothing to validate here. Shortest-form integers and definite lengths are structural.
#[derive(Clone, Debug, Default)]
pub struct Encoder {
    buf: Vec<u8>,
}

impl Encoder {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn with_capacity(n: usize) -> Self {
        Self { buf: Vec::with_capacity(n) }
    }

    fn head(&mut self, major: u8, arg: u64) {
        let m = major << 5;
        match head_len(arg) {
            1 => self.buf.push(m | arg as u8),
            2 => {
                self.buf.push(m | 24);
                self.buf.push(arg as u8);
            }
            3 => {
                self.buf.push(m | 25);
                self.buf.extend_from_slice(&(arg as u16).to_be_bytes());
            }
            5 => {
                self.buf.push(m | 26);
                self.buf.extend_from_slice(&(arg as u32).to_be_bytes());
            }
            _ => {
                self.buf.push(m | 27);
                self.buf.extend_from_slice(&arg.to_be_bytes());
            }
        }
    }

    /// Writes an array head of `len` elements. The elements follow as separate calls.
    pub fn array(&mut self, len: usize) -> &mut Self {
        self.head(4, len as u64);
        self
    }

    pub fn uint(&mut self, v: u64) -> &mut Self {
        self.head(0, v);
        self
    }

    pub fn bytes(&mut self, v: &[u8]) -> &mut Self {
        self.head(2, v.len() as u64);
        self.buf.extend_from_slice(v);
        self
    }

    pub fn text(&mut self, v: &str) -> &mut Self {
        self.head(3, v.len() as u64);
        self.buf.extend_from_slice(v.as_bytes());
        self
    }

    pub fn null(&mut self) -> &mut Self {
        self.buf.push(0xf6);
        self
    }

    pub fn opt_bytes(&mut self, v: Option<&[u8]>) -> &mut Self {
        match v {
            Some(b) => self.bytes(b),
            None => self.null(),
        }
    }

    pub fn opt_uint(&mut self, v: Option<u64>) -> &mut Self {
        match v {
            Some(n) => self.uint(n),
            None => self.null(),
        }
    }

    /// Splices an already-encoded sub-item in verbatim. Used where a nested structure has its own
    /// `encode()` (a `dilla_binding` inside an ABI response, an envelope inside an archive chunk).
    pub fn raw(&mut self, already_encoded: &[u8]) -> &mut Self {
        self.buf.extend_from_slice(already_encoded);
        self
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.buf
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.buf
    }
}
```

- [ ] **Step 5: Write the strict decoder**

Create `core/dilla-core/src/cbor/dec.rs`:

```rust
use super::{CborError, MAX_NESTING};

/// A strict, borrowing, position-tracking CBOR decoder.
///
/// Byte strings and text strings are returned as slices of the input, so decoding allocates
/// nothing. Every read that fails on a *type* leaves the position untouched, so a caller can
/// branch (that is how `try_null` is built); every read that fails on *well-formedness* leaves
/// the decoder unusable, which is fine because such an input is rejected outright.
pub struct Decoder<'a> {
    input: &'a [u8],
    pos: usize,
}

impl<'a> Decoder<'a> {
    pub fn new(input: &'a [u8]) -> Self {
        Self { input, pos: 0 }
    }

    pub fn position(&self) -> usize {
        self.pos
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], CborError> {
        let end = self.pos.checked_add(n).ok_or(CborError::Truncated)?;
        if end > self.input.len() {
            return Err(CborError::Truncated);
        }
        let s = &self.input[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    /// Reads one head and returns `(major, argument)`.
    ///
    /// This is where every strictness rule lives: majors 1, 5 and 6 are refused outright, so are
    /// additional-information values 28..=31, floats and every simple value but 22, and an
    /// argument encoded in more bytes than it needs.
    fn head(&mut self) -> Result<(u8, u64), CborError> {
        let b = *self.input.get(self.pos).ok_or(CborError::Truncated)?;
        self.pos += 1;
        let major = b >> 5;
        let ai = b & 0x1f;

        if major == 7 {
            return match ai {
                22 => Ok((7, 22)), // null
                0..=21 | 23 => Err(CborError::SimpleForbidden(ai)),
                24 => Err(CborError::SimpleForbidden(self.take(1)?[0])),
                25 | 26 | 27 => Err(CborError::FloatForbidden),
                other => Err(CborError::IndefiniteOrReserved(other)),
            };
        }
        if ai >= 28 {
            return Err(CborError::IndefiniteOrReserved(ai));
        }
        match major {
            1 => return Err(CborError::NegativeForbidden),
            5 => return Err(CborError::MapForbidden),
            6 => return Err(CborError::TagForbidden),
            _ => {}
        }

        let arg = match ai {
            0..=23 => u64::from(ai),
            24 => {
                let v = u64::from(self.take(1)?[0]);
                if v < 24 {
                    return Err(CborError::NonMinimalInt);
                }
                v
            }
            25 => {
                let mut a = [0u8; 2];
                a.copy_from_slice(self.take(2)?);
                let v = u64::from(u16::from_be_bytes(a));
                if v < 0x100 {
                    return Err(CborError::NonMinimalInt);
                }
                v
            }
            26 => {
                let mut a = [0u8; 4];
                a.copy_from_slice(self.take(4)?);
                let v = u64::from(u32::from_be_bytes(a));
                if v < 0x1_0000 {
                    return Err(CborError::NonMinimalInt);
                }
                v
            }
            _ => {
                let mut a = [0u8; 8];
                a.copy_from_slice(self.take(8)?);
                let v = u64::from_be_bytes(a);
                if v < 0x1_0000_0000 {
                    return Err(CborError::NonMinimalInt);
                }
                v
            }
        };
        Ok((major, arg))
    }

    /// Reads an array head and requires exactly `expected` elements.
    pub fn array(&mut self, expected: usize) -> Result<(), CborError> {
        let actual = self.array_len()?;
        if actual != expected {
            return Err(CborError::WrongArrayLen { expected, actual });
        }
        Ok(())
    }

    pub fn array_len(&mut self) -> Result<usize, CborError> {
        let at = self.pos;
        let (major, arg) = self.head()?;
        if major != 4 {
            self.pos = at;
            return Err(CborError::TypeMismatch { expected: "array", offset: at });
        }
        usize::try_from(arg).map_err(|_| CborError::IntegerOverflow)
    }

    pub fn uint(&mut self) -> Result<u64, CborError> {
        let at = self.pos;
        let (major, arg) = self.head()?;
        if major != 0 {
            self.pos = at;
            return Err(CborError::TypeMismatch { expected: "uint", offset: at });
        }
        Ok(arg)
    }

    pub fn bytes(&mut self) -> Result<&'a [u8], CborError> {
        let at = self.pos;
        let (major, arg) = self.head()?;
        if major != 2 {
            self.pos = at;
            return Err(CborError::TypeMismatch { expected: "bytes", offset: at });
        }
        let n = usize::try_from(arg).map_err(|_| CborError::IntegerOverflow)?;
        self.take(n)
    }

    pub fn bytes_exact<const N: usize>(&mut self) -> Result<[u8; N], CborError> {
        let s = self.bytes()?;
        if s.len() != N {
            return Err(CborError::WrongByteLen { expected: N, actual: s.len() });
        }
        let mut out = [0u8; N];
        out.copy_from_slice(s);
        Ok(out)
    }

    pub fn text(&mut self) -> Result<&'a str, CborError> {
        let at = self.pos;
        let (major, arg) = self.head()?;
        if major != 3 {
            self.pos = at;
            return Err(CborError::TypeMismatch { expected: "text", offset: at });
        }
        let n = usize::try_from(arg).map_err(|_| CborError::IntegerOverflow)?;
        core::str::from_utf8(self.take(n)?).map_err(|_| CborError::InvalidUtf8)
    }

    pub fn null(&mut self) -> Result<(), CborError> {
        let at = self.pos;
        let (major, arg) = self.head()?;
        if major != 7 || arg != 22 {
            self.pos = at;
            return Err(CborError::TypeMismatch { expected: "null", offset: at });
        }
        Ok(())
    }

    /// Consumes `0xf6` and returns true; otherwise consumes nothing and returns false.
    pub fn try_null(&mut self) -> Result<bool, CborError> {
        if self.input.get(self.pos) == Some(&0xf6) {
            self.pos += 1;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn opt_bytes_exact<const N: usize>(&mut self) -> Result<Option<[u8; N]>, CborError> {
        if self.try_null()? {
            Ok(None)
        } else {
            Ok(Some(self.bytes_exact::<N>()?))
        }
    }

    pub fn opt_uint(&mut self) -> Result<Option<u64>, CborError> {
        if self.try_null()? {
            Ok(None)
        } else {
            Ok(Some(self.uint()?))
        }
    }

    /// Skips one complete item, enforcing every strictness rule on the way, and returns the bytes
    /// it consumed.
    pub fn skip(&mut self) -> Result<&'a [u8], CborError> {
        let start = self.pos;
        self.skip_inner(0)?;
        Ok(&self.input[start..self.pos])
    }

    fn skip_inner(&mut self, depth: usize) -> Result<(), CborError> {
        if depth > MAX_NESTING {
            return Err(CborError::TooDeep(MAX_NESTING));
        }
        let (major, arg) = self.head()?;
        match major {
            2 | 3 => {
                let n = usize::try_from(arg).map_err(|_| CborError::IntegerOverflow)?;
                let s = self.take(n)?;
                if major == 3 {
                    core::str::from_utf8(s).map_err(|_| CborError::InvalidUtf8)?;
                }
                Ok(())
            }
            4 => {
                let n = usize::try_from(arg).map_err(|_| CborError::IntegerOverflow)?;
                for _ in 0..n {
                    self.skip_inner(depth + 1)?;
                }
                Ok(())
            }
            // major 0 (uint) and major 7 arg 22 (null) carry no payload; every other major and
            // every other simple value already errored inside `head`.
            _ => Ok(()),
        }
    }

    /// `Err(TrailingBytes)` if anything remains after the top-level item.
    pub fn finish(self) -> Result<(), CborError> {
        if self.pos == self.input.len() {
            Ok(())
        } else {
            Err(CborError::TrailingBytes)
        }
    }
}

/// Decodes a whole buffer with trailing-byte rejection built in.
pub fn decode_strict<T>(
    input: &[u8],
    f: impl FnOnce(&mut Decoder<'_>) -> Result<T, CborError>,
) -> Result<T, CborError> {
    let mut d = Decoder::new(input);
    let value = f(&mut d)?;
    d.finish()?;
    Ok(value)
}
```

- [ ] **Step 6: Declare the module**

Add to `core/dilla-core/src/lib.rs`, immediately after the `#![forbid(unsafe_code)]` line:

```rust
pub mod cbor;
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --test cbor_reject --locked
```

Expected: PASS, `test result: ok. 18 passed; 0 failed; 0 ignored`. The number that matters is
`0 failed`: if a later change adds a case here, correct the count rather than treating the
mismatch as a failure.

```bash
/home/thim/.cargo/bin/cargo clippy --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --all-targets --locked -- -D warnings
```

Expected: PASS with no warnings.

- [ ] **Step 8: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add core/dilla-core/src/cbor core/dilla-core/src/lib.rs core/dilla-core/tests/cbor_reject.rs && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(core): deterministic CBOR encoder and a strict decoder'
```

---

### Task 3: Identifier newtypes, error codes and crypto helpers

**Files:**
- Create: `core/dilla-core/src/ids.rs`, `core/dilla-core/src/error.rs`, `core/dilla-core/src/identity/mod.rs`
- Modify: `core/dilla-core/src/lib.rs` (add `pub mod error;`, `pub mod identity;`, `pub mod ids;` and the `pub use`)
- Test: unit tests inside `core/dilla-core/src/ids.rs`, `src/error.rs` and `src/identity/mod.rs`

**Interfaces:**
- Consumes: `cbor::CborError` (task 2).
- Produces:
  `ids::{InstanceId, CommunityId, ChannelId, UserId, DeviceId, MsgId}`, each
  `#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)] pub struct X(pub [u8; 16])` with
  `pub const fn from_bytes([u8; 16]) -> Self`, `pub const fn as_bytes(&self) -> &[u8; 16]`,
  `pub fn from_hex(&str) -> Result<Self, ProtocolError>`, `pub fn to_hex(&self) -> String`;
  `error::ProtocolError` (20 variants) with `pub const fn code(self) -> &'static str`,
  `pub fn from_code(&str) -> Option<Self>`, `pub const fn is_hard_reject(self) -> bool`;
  `error::CoreError`;
  `identity::{sha256, hmac_sha256, hmac_sha256_verify, hkdf_sha256}` with signatures
  `pub fn sha256(data: &[u8]) -> [u8; 32]`,
  `pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32]`,
  `pub fn hmac_sha256_verify(key: &[u8], data: &[u8], tag: &[u8; 32]) -> bool`,
  `pub fn hkdf_sha256(salt: Option<&[u8]>, ikm: &[u8], info: &[u8], okm: &mut [u8]) -> Result<(), ProtocolError>`.

Note on `ids::random`: the contract marks it **[NV]** because `openmls_rust_crypto 0.6.0` carries
both `rand_core` 0.6.4 and 0.10.1 (gap-10 §2) and nothing records which major an `impl
rand_core::CryptoRng` bound would resolve to. §3.1's own advice is to take randomness from
`OpenMlsRand` instead, so **`ids::random` is not written**. The two callers that need a fresh
identifier (`Envelope::msg_id` in task 12, `GroupId` in task 10) take bytes from
`openmls_traits::random::OpenMlsRand::random_array`, which is already in the dependency graph. This
is recorded under "Needs verification" at the end of this plan.

- [ ] **Step 1: Write the failing tests**

Append to `core/dilla-core/src/ids.rs` (the file is created in step 3; write the tests first and
watch them fail to compile — that is the failure signal for a module that does not exist yet):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips_for_every_id_type() {
        let raw = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
            0xee, 0xff,
        ];
        let expect = "00112233445566778899aabbccddeeff";
        assert_eq!(InstanceId::from_bytes(raw).to_hex(), expect);
        assert_eq!(CommunityId::from_bytes(raw).to_hex(), expect);
        assert_eq!(ChannelId::from_bytes(raw).to_hex(), expect);
        assert_eq!(UserId::from_bytes(raw).to_hex(), expect);
        assert_eq!(DeviceId::from_bytes(raw).to_hex(), expect);
        assert_eq!(MsgId::from_bytes(raw).to_hex(), expect);

        assert_eq!(InstanceId::from_hex(expect).unwrap(), InstanceId::from_bytes(raw));
        assert_eq!(UserId::from_hex(expect).unwrap(), UserId::from_bytes(raw));
        assert_eq!(MsgId::from_hex(expect).unwrap().as_bytes(), &raw);
    }

    #[test]
    fn from_hex_rejects_bad_input() {
        assert!(UserId::from_hex("00112233445566778899aabbccddee").is_err()); // 15 bytes
        assert!(UserId::from_hex("00112233445566778899aabbccddeeffaa").is_err()); // 17 bytes
        assert!(UserId::from_hex("00112233445566778899aabbccddeegg").is_err()); // not hex
        assert!(UserId::from_hex("00112233445566778899AABBCCDDEEFF").is_err()); // uppercase
        // 32 *bytes* but only 30 chars: a '\u{20ac}' whose UTF-8 boundary falls inside the
        // second digit pair. Must reject, not panic — this is a parser for wire-supplied text.
        assert!(UserId::from_hex("\u{20ac}0112233445566778899aabbccddee").is_err());
    }
}
```

Append to `core/dilla-core/src/error.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// The 20 stable strings of protocol/01, /03, /04 and /07 (facts-repo.md section 1.11).
    const ALL: [(ProtocolError, &str); 20] = [
        (ProtocolError::Binding, "E_BINDING"),
        (ProtocolError::ExternalSenderForbidden, "E_EXTERNAL_SENDER_FORBIDDEN"),
        (ProtocolError::MemberRemoveForbidden, "E_MEMBER_REMOVE_FORBIDDEN"),
        (ProtocolError::ExternalCommitRemove, "E_EXTERNAL_COMMIT_REMOVE"),
        (ProtocolError::UnsupportedVersion, "E_UNSUPPORTED_VERSION"),
        (ProtocolError::UnsupportedSuite, "E_UNSUPPORTED_SUITE"),
        (ProtocolError::Credential, "E_CREDENTIAL"),
        (ProtocolError::UmkChanged, "E_UMK_CHANGED"),
        (ProtocolError::DeviceUnlisted, "E_DEVICE_UNLISTED"),
        (ProtocolError::DeviceListStale, "E_DEVICE_LIST_STALE"),
        (ProtocolError::PairingLeaves, "E_PAIRING_LEAVES"),
        (ProtocolError::PairingFingerprint, "E_PAIRING_FINGERPRINT"),
        (ProtocolError::TierMismatch, "E_TIER_MISMATCH"),
        (ProtocolError::ProvisionalOutsidePairing, "E_PROVISIONAL_OUTSIDE_PAIRING"),
        (ProtocolError::EnvelopeShape, "E_ENVELOPE_SHAPE"),
        (ProtocolError::EnvelopeType, "E_ENVELOPE_TYPE"),
        (ProtocolError::EnvelopeLimit, "E_ENVELOPE_LIMIT"),
        (ProtocolError::FrankMismatch, "E_FRANK_MISMATCH"),
        (ProtocolError::BlobHash, "E_BLOB_HASH"),
        (ProtocolError::Version, "E_VERSION"),
    ];

    #[test]
    fn codes_round_trip_and_match_the_protocol_documents() {
        for (err, code) in ALL {
            assert_eq!(err.code(), code);
            assert_eq!(ProtocolError::from_code(code), Some(err));
            assert_eq!(err.to_string(), code, "Display must be the code itself");
        }
        assert_eq!(ProtocolError::from_code("E_NOT_A_CODE"), None);
    }

    #[test]
    fn only_umk_changed_and_frank_mismatch_are_hard_rejects() {
        for (err, code) in ALL {
            let hard = matches!(err, ProtocolError::UmkChanged | ProtocolError::FrankMismatch);
            assert_eq!(err.is_hard_reject(), hard, "{code}");
        }
    }
}
```

Append to `core/dilla-core/src/identity/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit"))
            .collect()
    }

    #[test]
    fn sha256_matches_the_empty_string_digest() {
        assert_eq!(
            sha256(b"").to_vec(),
            unhex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
    }

    /// RFC 5869 test case 3: empty salt, empty info, 22-byte IKM, L = 42.
    /// The same vector is asserted by packages/protocol-vectors/src/hkdf.test.ts.
    #[test]
    fn hkdf_reproduces_rfc_5869_case_3() {
        let ikm = [0x0bu8; 22];
        let mut okm = [0u8; 42];
        hkdf_sha256(Some(&[]), &ikm, &[], &mut okm).unwrap();
        assert_eq!(
            okm.to_vec(),
            unhex(
                "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d\
                 9d201395faa4b61a96c8"
            )
        );
        // `None` and `Some(&[])` are the same salt for HMAC, so both reproduce the vector.
        let mut okm_none = [0u8; 42];
        hkdf_sha256(None, &ikm, &[], &mut okm_none).unwrap();
        assert_eq!(okm, okm_none);
    }

    #[test]
    fn hkdf_rejects_an_output_longer_than_255_hash_lengths() {
        let mut okm = vec![0u8; 255 * 32 + 1];
        assert_eq!(hkdf_sha256(None, b"ikm", b"info", &mut okm), Err(ProtocolError::Credential));
    }

    #[test]
    fn hmac_matches_rfc_4231_case_1_truncated_to_sha256() {
        let tag = hmac_sha256(&[0x0bu8; 20], b"Hi There");
        assert_eq!(
            tag.to_vec(),
            unhex("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7")
        );
    }

    #[test]
    fn hmac_verify_is_constant_time_and_rejects_a_flipped_bit() {
        let key = [0x09u8; 32];
        let tag = hmac_sha256(&key, b"payload");
        assert!(hmac_sha256_verify(&key, b"payload", &tag));
        let mut bad = tag;
        bad[31] ^= 0x01;
        assert!(!hmac_sha256_verify(&key, b"payload", &bad));
        assert!(!hmac_sha256_verify(&[0x0au8; 32], b"payload", &tag));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --lib --locked
```

Step 1 created the three files but nothing declares them yet, so `cargo` would compile none of
them and report `0 tests` — which is an exit code 0, not a failure. Add the declarations from
step 6 to `core/dilla-core/src/lib.rs` **first** (`pub mod cbor; pub mod error; pub mod identity;
pub mod ids;`), then run the command above.

Expected: FAIL with resolution errors naming the items the tests use and step 3-5 have not written
yet — `error[E0412]: cannot find type DeviceId in this scope`, `error[E0433]: failed to resolve: use
of undeclared type ProtocolError`, `error[E0425]: cannot find function sha256 in this scope` — and a
non-zero exit code. Confirm those before writing step 3.

- [ ] **Step 3: Write the identifiers**

Prepend to `core/dilla-core/src/ids.rs`, above the test module:

```rust
//! The six 16-byte identifiers of protocol/00-overview.md.
//!
//! Every one is a CBOR byte string on the wire and lowercase hex without a prefix in JSON and in
//! the vector files. They are distinct types on purpose: passing a `ChannelId` where a `UserId`
//! belongs is the single easiest way to build a group nobody can join.

use crate::error::ProtocolError;

macro_rules! id16 {
    ($($(#[$meta:meta])* $name:ident),* $(,)?) => {$(
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
        pub struct $name(pub [u8; 16]);

        impl $name {
            pub const fn from_bytes(b: [u8; 16]) -> Self {
                Self(b)
            }

            pub const fn as_bytes(&self) -> &[u8; 16] {
                &self.0
            }

            /// Parses exactly 32 lowercase hex digits. Uppercase is rejected: the protocol
            /// documents and the vectors are lowercase without a prefix, and accepting both
            /// spellings would make two different strings name the same identifier.
            pub fn from_hex(s: &str) -> Result<Self, ProtocolError> {
                let bytes = s.as_bytes();
                if bytes.len() != 32 {
                    return Err(ProtocolError::Credential);
                }
                // Decode straight from the bytes, never by slicing the `&str`: the guard above
                // counts bytes, and a 32-byte string may hold a multi-byte character whose
                // boundary falls inside a digit pair, where slicing panics. This is a parser for
                // caller- and wire-supplied text, so every malformed input must return `Err`.
                let mut out = [0u8; 16];
                for (byte, pair) in out.iter_mut().zip(bytes.chunks_exact(2)) {
                    let mut value = 0u8;
                    for &c in pair {
                        let digit = match c {
                            b'0'..=b'9' => c - b'0',
                            b'a'..=b'f' => c - b'a' + 10,
                            _ => return Err(ProtocolError::Credential),
                        };
                        value = (value << 4) | digit;
                    }
                    *byte = value;
                }
                Ok(Self(out))
            }

            /// Lowercase, no prefix.
            pub fn to_hex(&self) -> String {
                let mut s = String::with_capacity(32);
                for b in self.0 {
                    s.push(char::from_digit(u32::from(b >> 4), 16).expect("nibble"));
                    s.push(char::from_digit(u32::from(b & 0x0f), 16).expect("nibble"));
                }
                s
            }
        }
    )*};
}

id16! {
    /// The instance (server) this group belongs to.
    InstanceId,
    /// A community. `null` in a DM, group DM, pairing or interaction group.
    CommunityId,
    /// A text or voice channel.
    ChannelId,
    /// A member.
    UserId,
    /// One device of one member. This is what a leaf is bound to.
    DeviceId,
    /// A message, chosen by the sender; edits, deletes and reactions reference it.
    MsgId,
}
```

- [ ] **Step 4: Write the error codes**

Prepend to `core/dilla-core/src/error.rs`, above the test module:

```rust
//! Stable protocol error codes.
//!
//! `code()` returns the exact string the protocol documents publish; those strings cross the wasi
//! ABI, the HTTP API and the gateway, so they are part of the compatibility surface and change
//! only through protocol/07-versioning.md's change process.

/// A rejection named by one of the protocol documents.
#[derive(Clone, Copy, PartialEq, Eq, Debug, thiserror::Error)]
pub enum ProtocolError {
    // protocol/01-groups.md
    #[error("E_BINDING")]
    Binding,
    #[error("E_EXTERNAL_SENDER_FORBIDDEN")]
    ExternalSenderForbidden,
    #[error("E_MEMBER_REMOVE_FORBIDDEN")]
    MemberRemoveForbidden,
    #[error("E_EXTERNAL_COMMIT_REMOVE")]
    ExternalCommitRemove,
    #[error("E_UNSUPPORTED_VERSION")]
    UnsupportedVersion,
    #[error("E_UNSUPPORTED_SUITE")]
    UnsupportedSuite,
    // protocol/03-identity.md
    #[error("E_CREDENTIAL")]
    Credential,
    #[error("E_UMK_CHANGED")]
    UmkChanged,
    #[error("E_DEVICE_UNLISTED")]
    DeviceUnlisted,
    #[error("E_DEVICE_LIST_STALE")]
    DeviceListStale,
    #[error("E_PAIRING_LEAVES")]
    PairingLeaves,
    #[error("E_PAIRING_FINGERPRINT")]
    PairingFingerprint,
    #[error("E_TIER_MISMATCH")]
    TierMismatch,
    #[error("E_PROVISIONAL_OUTSIDE_PAIRING")]
    ProvisionalOutsidePairing,
    // protocol/04-envelope-and-franking.md
    #[error("E_ENVELOPE_SHAPE")]
    EnvelopeShape,
    #[error("E_ENVELOPE_TYPE")]
    EnvelopeType,
    #[error("E_ENVELOPE_LIMIT")]
    EnvelopeLimit,
    #[error("E_FRANK_MISMATCH")]
    FrankMismatch,
    #[error("E_BLOB_HASH")]
    BlobHash,
    // protocol/07-versioning.md
    #[error("E_VERSION")]
    Version,
}

impl ProtocolError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Binding => "E_BINDING",
            Self::ExternalSenderForbidden => "E_EXTERNAL_SENDER_FORBIDDEN",
            Self::MemberRemoveForbidden => "E_MEMBER_REMOVE_FORBIDDEN",
            Self::ExternalCommitRemove => "E_EXTERNAL_COMMIT_REMOVE",
            Self::UnsupportedVersion => "E_UNSUPPORTED_VERSION",
            Self::UnsupportedSuite => "E_UNSUPPORTED_SUITE",
            Self::Credential => "E_CREDENTIAL",
            Self::UmkChanged => "E_UMK_CHANGED",
            Self::DeviceUnlisted => "E_DEVICE_UNLISTED",
            Self::DeviceListStale => "E_DEVICE_LIST_STALE",
            Self::PairingLeaves => "E_PAIRING_LEAVES",
            Self::PairingFingerprint => "E_PAIRING_FINGERPRINT",
            Self::TierMismatch => "E_TIER_MISMATCH",
            Self::ProvisionalOutsidePairing => "E_PROVISIONAL_OUTSIDE_PAIRING",
            Self::EnvelopeShape => "E_ENVELOPE_SHAPE",
            Self::EnvelopeType => "E_ENVELOPE_TYPE",
            Self::EnvelopeLimit => "E_ENVELOPE_LIMIT",
            Self::FrankMismatch => "E_FRANK_MISMATCH",
            Self::BlobHash => "E_BLOB_HASH",
            Self::Version => "E_VERSION",
        }
    }

    pub fn from_code(s: &str) -> Option<Self> {
        Some(match s {
            "E_BINDING" => Self::Binding,
            "E_EXTERNAL_SENDER_FORBIDDEN" => Self::ExternalSenderForbidden,
            "E_MEMBER_REMOVE_FORBIDDEN" => Self::MemberRemoveForbidden,
            "E_EXTERNAL_COMMIT_REMOVE" => Self::ExternalCommitRemove,
            "E_UNSUPPORTED_VERSION" => Self::UnsupportedVersion,
            "E_UNSUPPORTED_SUITE" => Self::UnsupportedSuite,
            "E_CREDENTIAL" => Self::Credential,
            "E_UMK_CHANGED" => Self::UmkChanged,
            "E_DEVICE_UNLISTED" => Self::DeviceUnlisted,
            "E_DEVICE_LIST_STALE" => Self::DeviceListStale,
            "E_PAIRING_LEAVES" => Self::PairingLeaves,
            "E_PAIRING_FINGERPRINT" => Self::PairingFingerprint,
            "E_TIER_MISMATCH" => Self::TierMismatch,
            "E_PROVISIONAL_OUTSIDE_PAIRING" => Self::ProvisionalOutsidePairing,
            "E_ENVELOPE_SHAPE" => Self::EnvelopeShape,
            "E_ENVELOPE_TYPE" => Self::EnvelopeType,
            "E_ENVELOPE_LIMIT" => Self::EnvelopeLimit,
            "E_FRANK_MISMATCH" => Self::FrankMismatch,
            "E_BLOB_HASH" => Self::BlobHash,
            "E_VERSION" => Self::Version,
            _ => return None,
        })
    }

    /// True for the two rejections protocol/03 and /04 mark as hard: a changed user master key
    /// (`E_UMK_CHANGED`) and a franking commitment that does not match the decrypted envelope
    /// (`E_FRANK_MISMATCH`). A hard reject is never retried and never rendered partially.
    pub const fn is_hard_reject(self) -> bool {
        matches!(self, Self::UmkChanged | Self::FrankMismatch)
    }
}

/// Everything `dilla-core` can return to a caller.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum CoreError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error(transparent)]
    Cbor(#[from] crate::cbor::CborError),
    #[error("crypto: {0}")]
    Crypto(String),
}
```

`CoreError` gains its `Storage` and `Mls` variants in task 9 and task 10, when the types they wrap
exist. That is stated here so a reader of task 9 knows the variant is an addition, not a redefinition.

- [ ] **Step 5: Write the hash, MAC and KDF helpers**

Prepend to `core/dilla-core/src/identity/mod.rs`, above the test module:

```rust
//! Identity: keys, credentials, the signed device list, safety numbers, recovery and pairing
//! (protocol/03-identity.md). This file holds the primitives every submodule shares.

use crate::error::ProtocolError;
use hkdf::Hkdf;
// `KeyInit` is not optional: `new_from_slice` is a method of `KeyInit` (re-exported by `hmac` from
// crypto-common), not of `Mac`. gap-10-openmls.md section 4: "`Mac` and `KeyInit` must both be in
// scope." Without it the two calls below are error[E0599].
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts a key of any length");
    mac.update(data);
    let tag = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&tag);
    out
}

/// Constant-time tag comparison. Never compare MAC output with `==`.
pub fn hmac_sha256_verify(key: &[u8], data: &[u8], tag: &[u8; 32]) -> bool {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts a key of any length");
    mac.update(data);
    mac.verify_slice(tag).is_ok()
}

/// HKDF-SHA256 (RFC 5869): Expand(Extract(salt, ikm), info) into `okm`.
///
/// `None` and `Some(&[])` are the same salt for HMAC, so both reproduce the vectors.
/// `Err(ProtocolError::Credential)` on RFC 5869's 255 x HashLen output ceiling: protocol/03
/// defines no separate code for a key-derivation failure, and every caller in dilla asks for 32
/// bytes, so the error is unreachable in practice.
pub fn hkdf_sha256(
    salt: Option<&[u8]>,
    ikm: &[u8],
    info: &[u8],
    okm: &mut [u8],
) -> Result<(), ProtocolError> {
    Hkdf::<Sha256>::new(salt, ikm)
        .expand(info, okm)
        .map_err(|_| ProtocolError::Credential)
}
```

- [ ] **Step 6: Declare the modules**

Replace the module block in `core/dilla-core/src/lib.rs` so it reads:

```rust
pub mod cbor;
pub mod error;
pub mod identity;
pub mod ids;

pub use error::{CoreError, ProtocolError};
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --lib --locked
```

Expected: PASS, `test result: ok. 9 passed; 0 failed; 0 ignored` — 2 in `ids.rs`, 2 in `error.rs`
and 5 in `identity/mod.rs`. `0 failed` is the signal; correct the count if a later change adds a
test here.

```bash
/home/thim/.cargo/bin/cargo clippy --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --all-targets --locked -- -D warnings
```

Expected: PASS with no warnings.

- [ ] **Step 8: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add core/dilla-core/src/ids.rs core/dilla-core/src/error.rs core/dilla-core/src/identity core/dilla-core/src/lib.rs && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(core): identifiers, stable protocol error codes and hash primitives'
```
---

### Task 4: Identity — credential, device list, safety numbers, recovery, pairing

**Files:**
- Create: `core/dilla-core/src/identity/credential.rs`, `device_list.rs`, `safety.rs`, `recovery.rs`, `pairing.rs`
- Modify: `core/dilla-core/src/identity/mod.rs` (constants, the three enums, submodules and re-exports)
- Test: unit tests inside each of the five new files

**Interfaces:**
- Consumes: `cbor::{Encoder, Decoder, decode_strict, CborError}`, `ids::{UserId, DeviceId}`, `error::ProtocolError`, `identity::{sha256, hmac_sha256, hkdf_sha256}`.
- Produces, all under `identity::`:
  the constants `DOMAIN_SSK`, `DOMAIN_DSK`, `DOMAIN_DEVICES`, `DOMAIN_INSTANCE_ROTATE`, `DOMAIN_MANIFEST`, `INFO_HEADER`, `INFO_ARCHIVE` (each `&[u8]`) and `CROCKFORD: &[u8; 32]`;
  `Kind { User = 0, Bot = 1 }`, `Tier { Native = 0, Browser = 1 }`, `SignerTier { Native = 0, Browser = 1, Provisional = 2 }`, each with `pub const fn as_u8(self) -> u8` and `pub fn from_u64(v: u64) -> Result<Self, ProtocolError>`;
  `CredentialIdentity { v: u64, umk_pub: [u8; 32], user_id: UserId, device_id: DeviceId, kind: Kind, tier: Tier, signer_tier: SignerTier, ssk_pub: [u8; 32], sig_umk_ssk: [u8; 64], sig_ssk_dev: [u8; 64] }` with `encode`, `decode`, `ssk_message`, `dsk_message`, `verify_signatures`, `provisional`, `is_provisional`;
  `SskSigner` with `from_bytes(&[u8; 32]) -> Self`, `public(&self) -> [u8; 32]`, `sign_device(...) -> [u8; 64]`, `sign_device_list(&DeviceListUnsigned) -> [u8; 64]`;
  `UmkSigner` with `from_bytes`, `public`, `sign_ssk(&[u8; 32]) -> [u8; 64]`;
  `DeviceEntry`, `DeviceListUnsigned`, `DeviceList` with `encode`, `decode`, `hash`, `verify`, `accept`, `lookup`, `check_leaf`;
  `decimal_digits(&[u8; 32]) -> String`, `safety_number(&[u8; 32], &[u8; 32]) -> String`, `sas(&[u8; 32]) -> String`, `group_digits(&str, usize) -> String`;
  `recovery_key_base32(&[u8; 32]) -> String`, `recovery_key_from_base32(&str) -> Result<[u8; 32], ProtocolError>`, `k_header(&[u8; 32]) -> [u8; 32]`, `k_backup(&[u8; 32]) -> [u8; 32]`;
  `PairingQr`, `fingerprint(&[u8; 32]) -> String`, `Pin`, `PairingPayload`.

Two scope rules, both from the interface contract:

- The **BIP-39 24-word** form of the recovery key is not written. No reference implementation and no
  vector exists anywhere in the repository (`facts-repo.md` §1.9), so there is nothing to check it
  against.
- `signer_tier` accepts **0..=2** (R14). The TypeScript reference types it `0 | 1`, which is
  narrower than protocol/03 (`facts-repo.md` §1.4, "corrected"); Rust follows the document.

- [ ] **Step 1: Write the failing tests**

Create `core/dilla-core/src/identity/credential.rs` containing only this test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{DeviceId, UserId};

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit"))
            .collect()
    }

    fn arr32(b: u8) -> [u8; 32] {
        [b; 32]
    }

    /// Read from the vector file rather than transcribed from it. Task 7 regenerates
    /// `identity.json` with real Ed25519 keys and signatures; a hand-copied constant would silently
    /// stop being "the exact case in the vector" at that point, and the contract's acceptance for
    /// this task is "`credential_identity.cbor` from `identity.json` reproduces byte-for-byte".
    /// `serde_json` is already a dev-dependency, so this compiles in `cargo test --lib`.
    const IDENTITY_JSON: &str = include_str!("../../../../protocol/vectors/identity.json");

    fn vector_doc() -> serde_json::Value {
        serde_json::from_str(IDENTITY_JSON).expect("identity.json parses")
    }

    fn unhex_n<const N: usize>(s: &str) -> [u8; N] {
        let v = unhex(s);
        assert_eq!(v.len(), N, "expected {N} bytes, got {}", v.len());
        let mut out = [0u8; N];
        out.copy_from_slice(&v);
        out
    }

    fn vector_credential() -> CredentialIdentity {
        let doc = vector_doc();
        let f = doc["credential_identity"]["fields"].clone();
        let hex_field = |key: &str| -> String {
            f[key].as_str().unwrap_or_else(|| panic!("identity.json: {key} is a hex string")).to_owned()
        };
        let uint_field = |key: &str| -> u64 {
            f[key].as_u64().unwrap_or_else(|| panic!("identity.json: {key} is an integer"))
        };
        CredentialIdentity {
            v: 1,
            umk_pub: unhex_n::<32>(&hex_field("umk_pub")),
            user_id: UserId::from_bytes(unhex_n::<16>(&hex_field("user_id"))),
            device_id: DeviceId::from_bytes(unhex_n::<16>(&hex_field("device_id"))),
            kind: Kind::from_u64(uint_field("kind")).expect("kind"),
            tier: Tier::from_u64(uint_field("tier")).expect("tier"),
            signer_tier: SignerTier::from_u64(uint_field("signer_tier")).expect("signer_tier"),
            ssk_pub: unhex_n::<32>(&hex_field("ssk_pub")),
            sig_umk_ssk: unhex_n::<64>(&hex_field("sig_umk_ssk")),
            sig_ssk_dev: unhex_n::<64>(&hex_field("sig_ssk_dev")),
        }
    }

    #[test]
    fn credential_identity_reproduces_the_vector_cbor() {
        let doc = vector_doc();
        let expected = doc["credential_identity"]["cbor"].as_str().expect("cbor is a hex string");
        assert_eq!(hex_of(&vector_credential().encode()), expected);
    }

    fn hex_of(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn credential_identity_round_trips() {
        let c = vector_credential();
        assert_eq!(CredentialIdentity::decode(&c.encode()).unwrap(), c);
    }

    #[test]
    fn decode_rejects_the_wrong_shape_with_e_credential() {
        let c = vector_credential();
        let mut bytes = c.encode();
        bytes.push(0x00); // trailing byte
        assert_eq!(CredentialIdentity::decode(&bytes), Err(ProtocolError::Credential));

        let mut short = c.encode();
        short[0] = 0x89; // array of 9
        assert_eq!(CredentialIdentity::decode(&short), Err(ProtocolError::Credential));
    }

    #[test]
    fn signer_tier_accepts_0_1_2_and_rejects_3() {
        assert_eq!(SignerTier::from_u64(0), Ok(SignerTier::Native));
        assert_eq!(SignerTier::from_u64(1), Ok(SignerTier::Browser));
        assert_eq!(SignerTier::from_u64(2), Ok(SignerTier::Provisional));
        assert_eq!(SignerTier::from_u64(3), Err(ProtocolError::Credential));
        assert_eq!(Kind::from_u64(2), Err(ProtocolError::Credential));
        assert_eq!(Tier::from_u64(2), Err(ProtocolError::Credential));
    }

    #[test]
    fn signing_messages_are_the_documented_preimages() {
        let ssk_pub = arr32(0xf6);
        let mut want = b"dilla ssk v1".to_vec();
        want.extend_from_slice(&ssk_pub);
        assert_eq!(CredentialIdentity::ssk_message(&ssk_pub), want);

        let device_id = DeviceId::from_bytes([0xe5; 16]);
        let dsk_pub = arr32(0x5a);
        let mut want = b"dilla dsk v1".to_vec();
        want.extend_from_slice(device_id.as_bytes());
        want.extend_from_slice(&dsk_pub);
        want.extend_from_slice(&[0u8, 1u8, 0u8]); // kind, tier, signer_tier - one byte each
        assert_eq!(
            CredentialIdentity::dsk_message(
                &device_id,
                &dsk_pub,
                Kind::User,
                Tier::Browser,
                SignerTier::Native
            ),
            want
        );
    }

    #[test]
    fn verify_signatures_accepts_a_real_chain_and_rejects_a_tampered_one() {
        let umk = UmkSigner::from_bytes(&arr32(0x31));
        let ssk = SskSigner::from_bytes(&arr32(0x32));
        let dsk = SskSigner::from_bytes(&arr32(0x33)); // the device key lives in the MLS leaf
        let device_id = DeviceId::from_bytes([0xe5; 16]);
        let dsk_pub = dsk.public();

        let c = CredentialIdentity {
            v: 1,
            umk_pub: umk.public(),
            user_id: UserId::from_bytes([0xd4; 16]),
            device_id,
            kind: Kind::User,
            tier: Tier::Native,
            signer_tier: SignerTier::Native,
            ssk_pub: ssk.public(),
            sig_umk_ssk: umk.sign_ssk(&ssk.public()),
            sig_ssk_dev: ssk.sign_device(
                &device_id,
                &dsk_pub,
                Kind::User,
                Tier::Native,
                SignerTier::Native,
            ),
        };
        assert_eq!(c.verify_signatures(&dsk_pub), Ok(()));

        // a different leaf key breaks sig_ssk_dev
        let other = SskSigner::from_bytes(&arr32(0x34)).public();
        assert_eq!(c.verify_signatures(&other), Err(ProtocolError::Credential));

        // a flipped bit in sig_umk_ssk breaks the first signature
        let mut tampered = c.clone();
        tampered.sig_umk_ssk[0] ^= 0x01;
        assert_eq!(tampered.verify_signatures(&dsk_pub), Err(ProtocolError::Credential));
    }

    /// The all-zero point is not a usable Ed25519 public key; `verify_strict` rejects it outright.
    ///
    /// This does **not** on its own prove `verify_strict` is in use: the signature here is also
    /// wrong, so plain `verify` would reject it too. A case that `verify` accepts and only
    /// `verify_strict` refuses needs a signature crafted under a small-order key, which no vector
    /// in this repository carries — see "Needs verification" item 20. The test is named for what it
    /// actually covers.
    #[test]
    fn verify_signatures_rejects_an_all_zero_public_key() {
        let mut c = vector_credential();
        c.umk_pub = [0u8; 32];
        assert_eq!(c.verify_signatures(&arr32(0x5a)), Err(ProtocolError::Credential));
        // and the genuine chain of the test above still verifies, so the rejection is the key,
        // not a blanket failure of `verify_signatures`.
        let umk = UmkSigner::from_bytes(&arr32(0x31));
        assert_ne!(umk.public(), [0u8; 32]);
    }

    #[test]
    fn provisional_credentials_are_blank_and_self_describing() {
        let c = CredentialIdentity::provisional(
            arr32(0xa1),
            UserId::from_bytes([0xd4; 16]),
            DeviceId::from_bytes([0xe5; 16]),
            Kind::User,
            Tier::Browser,
        );
        assert!(c.is_provisional());
        assert_eq!(c.signer_tier, SignerTier::Provisional);
        assert_eq!(c.ssk_pub, [0u8; 32]);
        assert_eq!(c.sig_umk_ssk, [0u8; 64]);
        assert_eq!(c.sig_ssk_dev, [0u8; 64]);
        assert_eq!(CredentialIdentity::decode(&c.encode()).unwrap(), c);
        assert!(!vector_credential().is_provisional());
    }
}
```

Create `core/dilla-core/src/identity/device_list.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    // `SskSigner` lives in `identity::credential` and is re-exported at `identity`; `super` here is
    // `identity::device_list`, whose own `use super::{sha256, Tier, DOMAIN_DEVICES}` does not bring
    // it in, so `use super::*` does not either.
    use crate::identity::SskSigner;
    use crate::ids::{DeviceId, UserId};

    fn signer() -> SskSigner {
        SskSigner::from_bytes(&[0x32; 32])
    }

    fn entry(id: u8, revoked: Option<u64>) -> DeviceEntry {
        DeviceEntry {
            device_id: DeviceId::from_bytes([id; 16]),
            dsk_pub: [id.wrapping_add(1); 32],
            tier: Tier::Native,
            added_at: 1_758_659_640,
            revoked_at: revoked,
        }
    }

    fn list(version: u64, prev_hash: [u8; 32], entries: Vec<DeviceEntry>) -> DeviceList {
        let unsigned = DeviceListUnsigned {
            v: 1,
            user_id: UserId::from_bytes([0xd4; 16]),
            version,
            prev_hash,
            entries,
        };
        let sig_ssk = signer().sign_device_list(&unsigned);
        DeviceList { unsigned, sig_ssk }
    }

    #[test]
    fn device_list_round_trips_and_signs_over_the_five_element_array() {
        let l = list(1, [0u8; 32], vec![entry(0x01, None), entry(0x02, Some(1_758_700_000))]);
        assert_eq!(DeviceList::decode(&l.encode()).unwrap(), l);
        assert_eq!(l.verify(&signer().public()), Ok(()));

        let mut msg = b"dilla devices v1".to_vec();
        msg.extend_from_slice(&l.unsigned.encode());
        assert_eq!(l.unsigned.signing_message(), msg);
    }

    #[test]
    fn verify_rejects_a_bad_signature_and_a_wrong_key() {
        let mut l = list(1, [0u8; 32], vec![entry(0x01, None)]);
        assert_eq!(l.verify(&SskSigner::from_bytes(&[0x99; 32]).public()), Err(ProtocolError::Credential));
        l.sig_ssk[0] ^= 0x01;
        assert_eq!(l.verify(&signer().public()), Err(ProtocolError::Credential));
    }

    #[test]
    fn accept_requires_a_strictly_greater_version_and_a_matching_prev_hash() {
        let key = signer().public();
        let v1 = list(1, [0u8; 32], vec![entry(0x01, None)]);
        assert_eq!(v1.accept(None, &key), Ok(()));

        let v2 = list(2, v1.hash(), vec![entry(0x01, None), entry(0x02, None)]);
        assert_eq!(v2.accept(Some(&v1), &key), Ok(()));

        // same version again
        let stale = list(1, v1.hash(), vec![entry(0x01, None)]);
        assert_eq!(stale.accept(Some(&v1), &key), Err(ProtocolError::DeviceListStale));

        // right version, wrong chain link
        let forked = list(2, [0xff; 32], vec![entry(0x01, None)]);
        assert_eq!(forked.accept(Some(&v1), &key), Err(ProtocolError::DeviceListStale));

        // version 1 must chain from 32 zero bytes
        let bad_root = list(1, [0x01; 32], vec![entry(0x01, None)]);
        assert_eq!(bad_root.accept(None, &key), Err(ProtocolError::DeviceListStale));
    }

    /// Not `assert_eq!(l.hash(), sha256(&l.encode()))`: that is the definition of `hash()`, so it
    /// holds for any encoding and cannot fail. What must hold is that the digest covers every
    /// field and is what the next version chains from.
    #[test]
    fn hash_covers_every_field_and_is_what_the_next_version_chains_from() {
        let a = list(1, [0u8; 32], vec![entry(0x01, None)]);
        let revoked = list(1, [0u8; 32], vec![entry(0x01, Some(1_758_700_000))]);
        assert_ne!(a.hash(), revoked.hash(), "a revocation must change the hash");
        let two_devices = list(1, [0u8; 32], vec![entry(0x01, None), entry(0x02, None)]);
        assert_ne!(a.hash(), two_devices.hash(), "an added device must change the hash");
        let bumped = list(2, a.hash(), vec![entry(0x01, None)]);
        assert_ne!(a.hash(), bumped.hash(), "the version is inside the hash");
        assert_eq!(bumped.accept(Some(&a), &signer().public()), Ok(()));
        assert_ne!(a.hash(), [0u8; 32]);
    }

    #[test]
    fn check_leaf_enforces_presence_revocation_and_tier() {
        let present = entry(0x01, None);
        let revoked = entry(0x02, Some(1_758_700_000));
        let l = list(1, [0u8; 32], vec![present.clone(), revoked.clone()]);

        assert_eq!(l.check_leaf(&present.device_id, &present.dsk_pub, Tier::Native), Ok(()));
        assert_eq!(
            l.check_leaf(&present.device_id, &present.dsk_pub, Tier::Browser),
            Err(ProtocolError::TierMismatch)
        );
        assert_eq!(
            l.check_leaf(&revoked.device_id, &revoked.dsk_pub, Tier::Native),
            Err(ProtocolError::DeviceUnlisted)
        );
        assert_eq!(
            l.check_leaf(&DeviceId::from_bytes([0x77; 16]), &[0u8; 32], Tier::Native),
            Err(ProtocolError::DeviceUnlisted)
        );
        // present, unrevoked, right tier, but a different leaf key
        assert_eq!(
            l.check_leaf(&present.device_id, &[0xaa; 32], Tier::Native),
            Err(ProtocolError::DeviceUnlisted)
        );
        assert!(l.lookup(&present.device_id).is_some());
        assert!(l.lookup(&DeviceId::from_bytes([0x77; 16])).is_none());
    }
}
```

Create `core/dilla-core/src/identity/safety.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_digits_pads_to_78_and_reproduces_the_anchors() {
        assert_eq!(decimal_digits(&[0u8; 32]), "0".repeat(78));
        let mut one = [0u8; 32];
        one[31] = 1;
        assert_eq!(decimal_digits(&one), format!("{}1", "0".repeat(77)));
        assert_eq!(
            decimal_digits(&[0xff; 32]),
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        );
    }

    /// protocol/vectors/identity.json, `safety_number`.
    #[test]
    fn safety_number_reproduces_the_vector_and_is_symmetric() {
        let a = [0xa1u8; 32];
        let b = [0xb2u8; 32];
        let expect = "097797588879462191319159221653839944788022939511249052334637";
        assert_eq!(safety_number(&a, &b), expect);
        assert_eq!(safety_number(&b, &a), expect);
        assert_eq!(safety_number(&a, &b).len(), 60);
        assert_ne!(safety_number(&a, &[0x03u8; 32]), expect);
    }

    /// protocol/vectors/identity.json, `sas`.
    #[test]
    fn sas_reproduces_the_vector_and_the_anchors() {
        assert_eq!(sas(&[0xc3u8; 32]), "088546891769712384735671929712");
        assert_eq!(sas(&[0xffu8; 32]), "115792089237316195423570985008");
        assert_eq!(sas(&[0u8; 32]), "0".repeat(30));
    }

    #[test]
    fn group_digits_joins_fixed_size_groups_with_single_spaces() {
        assert_eq!(group_digits("1234567890", 5), "12345 67890");
        assert_eq!(group_digits("123456789", 5), "12345 6789");
        assert_eq!(group_digits(&"0".repeat(60), 5).split(' ').count(), 12);
        assert_eq!(group_digits(&"0".repeat(30), 5).split(' ').count(), 6);
    }
}
```

Create `core/dilla-core/src/identity/recovery.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn unhex32(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit");
        }
        out
    }

    /// protocol/vectors/identity.json, `recovery_key`.
    #[test]
    fn recovery_key_base32_reproduces_the_vector_and_round_trips() {
        let rk = [0x0bu8; 32];
        let expect = "1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5G";
        assert_eq!(recovery_key_base32(&rk), expect);
        assert_eq!(expect.len(), 52);
        assert_eq!(recovery_key_from_base32(expect).unwrap(), rk);

        assert_eq!(recovery_key_base32(&[0u8; 32]), "0".repeat(52));
        assert_eq!(recovery_key_from_base32(&"0".repeat(52)).unwrap(), [0u8; 32]);
    }

    #[test]
    fn recovery_key_from_base32_rejects_bad_input() {
        let ok = recovery_key_base32(&[0x0bu8; 32]);
        assert_eq!(recovery_key_from_base32(&ok[..51]), Err(ProtocolError::Credential));
        assert_eq!(recovery_key_from_base32(&format!("{ok}0")), Err(ProtocolError::Credential));
        // U, I, L and O are outside the Crockford alphabet
        assert_eq!(recovery_key_from_base32(&format!("U{}", &ok[1..])), Err(ProtocolError::Credential));
        assert_eq!(recovery_key_from_base32(&ok.to_lowercase()), Err(ProtocolError::Credential));
        // the 52nd character carries 1 payload bit and 4 zero bits; a non-zero remainder is invalid
        let mut bad: Vec<char> = ok.chars().collect();
        bad[51] = 'Z';
        assert_eq!(
            recovery_key_from_base32(&bad.into_iter().collect::<String>()),
            Err(ProtocolError::Credential)
        );
    }

    /// protocol/vectors/identity.json, `recovery_key.k_header` / `k_backup`.
    #[test]
    fn derived_keys_reproduce_the_vector() {
        let rk = [0x0bu8; 32];
        assert_eq!(
            k_header(&rk),
            unhex32("9fbf18dbf25c74e20589a850571aa504c9fe2d05fdbd303a1d0e3a20f27e6967")
        );
        assert_eq!(
            k_backup(&rk),
            unhex32("2888f1d18f96115fb632fd340d1e3bfbcb765e9883a12cc5afa0c76b2fbf72d2")
        );
        assert_ne!(k_header(&rk), k_backup(&rk));
    }
}
```

Create `core/dilla-core/src/identity/pairing.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{DeviceId, UserId};

    fn qr() -> PairingQr {
        PairingQr {
            v: 1,
            device_id: DeviceId::from_bytes([0xe5; 16]),
            dsk_pub: [0x5a; 32],
            umk_pub: [0xa1; 32],
        }
    }

    #[test]
    fn pairing_qr_round_trips_through_cbor_and_base32() {
        let q = qr();
        assert_eq!(PairingQr::decode(&q.encode()).unwrap(), q);
        let s = q.to_base32();
        assert!(s.chars().all(|c| CROCKFORD.contains(&(c as u8))), "{s}");
        assert_eq!(PairingQr::from_base32(&s).unwrap(), q);
    }

    #[test]
    fn pairing_qr_decode_rejects_trailing_bytes_and_wrong_lengths() {
        let mut bytes = qr().encode();
        bytes.push(0x00);
        assert_eq!(PairingQr::decode(&bytes), Err(ProtocolError::Credential));
        assert_eq!(PairingQr::from_base32("NOTVALID"), Err(ProtocolError::Credential));
    }

    #[test]
    fn fingerprint_is_twelve_crockford_characters_of_the_key_digest() {
        let f = fingerprint(&[0x5a; 32]);
        assert_eq!(f.len(), 12);
        assert!(f.chars().all(|c| CROCKFORD.contains(&(c as u8))), "{f}");
        assert_ne!(f, fingerprint(&[0x5b; 32]));
    }

    #[test]
    fn pairing_payload_round_trips_with_and_without_its_optional_fields() {
        let full = PairingPayload {
            v: 1,
            credential: vec![0x8a, 0x01, 0x02],
            ssk_priv: Some([0x32; 32]),
            k_backup: Some([0x28; 32]),
            pins: Some(vec![Pin {
                user_id: UserId::from_bytes([0xd4; 16]),
                umk_pub: [0xa1; 32],
                first_seen: 1_758_659_640,
                verified: 1,
            }]),
        };
        assert_eq!(PairingPayload::decode(&full.encode()).unwrap(), full);

        // a browser device carries neither the SSK nor the pin table
        let browser = PairingPayload {
            v: 1,
            credential: vec![0x8a, 0x01, 0x02],
            ssk_priv: None,
            k_backup: None,
            pins: None,
        };
        assert_eq!(PairingPayload::decode(&browser.encode()).unwrap(), browser);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --lib --locked
```

Step 1 created the five files but nothing declares them, so `cargo` compiles none of them and
exits 0 with `0 tests` added — which is not a failure. Write the five `mod` lines from **step 3**
into `core/dilla-core/src/identity/mod.rs` first (`mod credential; mod device_list; mod pairing;
mod recovery; mod safety;` and the matching `pub use` lines), then run the command above.

Expected: FAIL, non-zero exit, with resolution errors naming what step 3-6 have not written yet —
`error[E0412]: cannot find type CredentialIdentity in this scope`, `error[E0433]: failed to resolve:
use of undeclared type SskSigner`, `error[E0425]: cannot find function safety_number in this scope`
— roughly 30 of them. Confirm them before writing step 3's bodies.

- [ ] **Step 3: Write the shared constants and the three enums**

Insert into `core/dilla-core/src/identity/mod.rs`, between the existing `use` block and the
`sha256` function:

```rust
mod credential;
mod device_list;
mod pairing;
mod recovery;
mod safety;

pub use credential::{CredentialIdentity, SskSigner, UmkSigner};
pub use device_list::{DeviceEntry, DeviceList, DeviceListUnsigned};
pub use pairing::{fingerprint, PairingPayload, PairingQr, Pin};
pub use recovery::{k_backup, k_header, recovery_key_base32, recovery_key_from_base32};
pub use safety::{decimal_digits, group_digits, safety_number, sas};

// Domain separation strings (protocol/03-identity.md "Keys", protocol/06-backup-archive.md).
// They are UTF-8 and are concatenated with the fields directly: no separators, no length prefix.

/// `sig_umk_ssk` covers `DOMAIN_SSK || ssk_pub`.
pub const DOMAIN_SSK: &[u8] = b"dilla ssk v1";
/// `sig_ssk_dev` covers `DOMAIN_DSK || device_id || dsk_pub || kind || tier || signer_tier`.
pub const DOMAIN_DSK: &[u8] = b"dilla dsk v1";
/// The device list's `sig_ssk` covers `DOMAIN_DEVICES || CBOR(unsigned)`.
pub const DOMAIN_DEVICES: &[u8] = b"dilla devices v1";
/// Instance key rotation. Note the order: the key comes FIRST and the domain string AFTER,
/// unlike every other domain in dilla (protocol/03 "Instance key rotation").
pub const DOMAIN_INSTANCE_ROTATE: &[u8] = b"dilla instance rotate v1";
/// The archive manifest's `sig_ssk` covers `DOMAIN_MANIFEST || CBOR([v, user_id, chunks])`.
pub const DOMAIN_MANIFEST: &[u8] = b"dilla manifest v1";
/// HKDF info for `K_header`.
pub const INFO_HEADER: &[u8] = b"dilla header v1";
/// HKDF info for `K_backup`.
pub const INFO_ARCHIVE: &[u8] = b"dilla archive v1";
/// Crockford base32, MSB-first. No `I`, `L`, `O` or `U`.
pub const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Whether a member is a person or a bot.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Kind {
    User = 0,
    Bot = 1,
}

/// Where a device keeps its keys: a native key store, or a browser.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Tier {
    Native = 0,
    Browser = 1,
}

/// The tier of the device (or one-shot recovery entry) that signed a device into existence.
/// `Provisional` exists only inside a pairing group (protocol/03 "Pairing", R14).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum SignerTier {
    Native = 0,
    Browser = 1,
    Provisional = 2,
}

macro_rules! small_enum {
    ($name:ident { $($variant:ident = $value:expr),* $(,)? }) => {
        impl $name {
            pub const fn as_u8(self) -> u8 {
                self as u8
            }

            pub fn from_u64(v: u64) -> Result<Self, ProtocolError> {
                match v {
                    $($value => Ok(Self::$variant),)*
                    _ => Err(ProtocolError::Credential),
                }
            }
        }
    };
}

small_enum!(Kind { User = 0, Bot = 1 });
small_enum!(Tier { Native = 0, Browser = 1 });
small_enum!(SignerTier { Native = 0, Browser = 1, Provisional = 2 });
```

- [ ] **Step 4: Write the credential**

Prepend to `core/dilla-core/src/identity/credential.rs`, above its test module:

```rust
//! The MLS `basic` credential identity: a 10-element deterministic-CBOR array
//! (protocol/03-identity.md "Credential").
//!
//! `dsk_pub` is deliberately **not** in the array. The verifier takes it from the MLS leaf's
//! `signature_key`, which is what binds the credential to the leaf it arrived on.

use super::{
    DeviceListUnsigned, Kind, SignerTier, Tier, DOMAIN_DEVICES, DOMAIN_DSK, DOMAIN_SSK,
};
use crate::cbor::{decode_strict, Decoder, Encoder};
use crate::error::ProtocolError;
use crate::ids::{DeviceId, UserId};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CredentialIdentity {
    pub v: u64,
    pub umk_pub: [u8; 32],
    pub user_id: UserId,
    pub device_id: DeviceId,
    pub kind: Kind,
    pub tier: Tier,
    pub signer_tier: SignerTier,
    pub ssk_pub: [u8; 32],
    pub sig_umk_ssk: [u8; 64],
    pub sig_ssk_dev: [u8; 64],
}

impl CredentialIdentity {
    pub fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::with_capacity(224);
        e.array(10)
            .uint(self.v)
            .bytes(&self.umk_pub)
            .bytes(self.user_id.as_bytes())
            .bytes(self.device_id.as_bytes())
            .uint(u64::from(self.kind.as_u8()))
            .uint(u64::from(self.tier.as_u8()))
            .uint(u64::from(self.signer_tier.as_u8()))
            .bytes(&self.ssk_pub)
            .bytes(&self.sig_umk_ssk)
            .bytes(&self.sig_ssk_dev);
        e.into_vec()
    }

    /// Every shape failure is `E_CREDENTIAL`, including trailing bytes and a non-minimal encoding.
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        decode_strict(bytes, Self::read).map_err(|_| ProtocolError::Credential)
    }

    fn read(d: &mut Decoder<'_>) -> Result<Self, crate::cbor::CborError> {
        d.array(10)?;
        let v = d.uint()?;
        let umk_pub = d.bytes_exact::<32>()?;
        let user_id = UserId::from_bytes(d.bytes_exact::<16>()?);
        let device_id = DeviceId::from_bytes(d.bytes_exact::<16>()?);
        let kind = d.uint()?;
        let tier = d.uint()?;
        let signer_tier = d.uint()?;
        let ssk_pub = d.bytes_exact::<32>()?;
        let sig_umk_ssk = d.bytes_exact::<64>()?;
        let sig_ssk_dev = d.bytes_exact::<64>()?;
        // The enum conversions cannot be expressed as CborError, so they are checked here and
        // reported through the same TypeMismatch channel the caller maps to E_CREDENTIAL.
        let mismatch = crate::cbor::CborError::TypeMismatch { expected: "enum", offset: 0 };
        if v != 1 {
            return Err(mismatch);
        }
        let kind = Kind::from_u64(kind).map_err(|_| mismatch.clone())?;
        let tier = Tier::from_u64(tier).map_err(|_| mismatch.clone())?;
        let signer_tier = SignerTier::from_u64(signer_tier).map_err(|_| mismatch)?;
        Ok(Self {
            v,
            umk_pub,
            user_id,
            device_id,
            kind,
            tier,
            signer_tier,
            ssk_pub,
            sig_umk_ssk,
            sig_ssk_dev,
        })
    }

    /// `"dilla ssk v1" || ssk_pub`
    pub fn ssk_message(ssk_pub: &[u8; 32]) -> Vec<u8> {
        let mut m = Vec::with_capacity(DOMAIN_SSK.len() + 32);
        m.extend_from_slice(DOMAIN_SSK);
        m.extend_from_slice(ssk_pub);
        m
    }

    /// `"dilla dsk v1" || device_id || dsk_pub || kind || tier || signer_tier`
    /// - the three enum fields are one byte each, not CBOR.
    pub fn dsk_message(
        device_id: &DeviceId,
        dsk_pub: &[u8; 32],
        kind: Kind,
        tier: Tier,
        signer_tier: SignerTier,
    ) -> Vec<u8> {
        let mut m = Vec::with_capacity(DOMAIN_DSK.len() + 16 + 32 + 3);
        m.extend_from_slice(DOMAIN_DSK);
        m.extend_from_slice(device_id.as_bytes());
        m.extend_from_slice(dsk_pub);
        m.push(kind.as_u8());
        m.push(tier.as_u8());
        m.push(signer_tier.as_u8());
        m
    }

    /// Rule 1 of protocol/03: both signatures verify, with `dsk_pub` taken from the MLS leaf.
    ///
    /// `verify_strict` rather than `verify`: it rejects small-order and non-canonical public keys
    /// and gives the strongly-binding semantics a device list needs (gap-10 section 4).
    pub fn verify_signatures(&self, dsk_pub: &[u8; 32]) -> Result<(), ProtocolError> {
        let umk =
            VerifyingKey::from_bytes(&self.umk_pub).map_err(|_| ProtocolError::Credential)?;
        umk.verify_strict(
            &Self::ssk_message(&self.ssk_pub),
            &Signature::from_bytes(&self.sig_umk_ssk),
        )
        .map_err(|_| ProtocolError::Credential)?;

        let ssk =
            VerifyingKey::from_bytes(&self.ssk_pub).map_err(|_| ProtocolError::Credential)?;
        ssk.verify_strict(
            &Self::dsk_message(&self.device_id, dsk_pub, self.kind, self.tier, self.signer_tier),
            &Signature::from_bytes(&self.sig_ssk_dev),
        )
        .map_err(|_| ProtocolError::Credential)?;
        Ok(())
    }

    /// The credential a new device presents as the second leaf of a pairing group: no SSK, no
    /// signatures. It is accepted only there, and only when the group's `dilla_binding.target_id`
    /// equals this `device_id` (`E_PROVISIONAL_OUTSIDE_PAIRING`, enforced in task 10).
    pub fn provisional(
        umk_pub: [u8; 32],
        user_id: UserId,
        device_id: DeviceId,
        kind: Kind,
        tier: Tier,
    ) -> Self {
        Self {
            v: 1,
            umk_pub,
            user_id,
            device_id,
            kind,
            tier,
            signer_tier: SignerTier::Provisional,
            ssk_pub: [0u8; 32],
            sig_umk_ssk: [0u8; 64],
            sig_ssk_dev: [0u8; 64],
        }
    }

    pub fn is_provisional(&self) -> bool {
        self.signer_tier == SignerTier::Provisional
    }
}

/// The subordinate signing key. It signs devices into the list and signs the list itself.
pub struct SskSigner {
    key: SigningKey,
}

impl SskSigner {
    pub fn from_bytes(sk: &[u8; 32]) -> Self {
        Self { key: SigningKey::from_bytes(sk) }
    }

    pub fn public(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    pub fn sign_device(
        &self,
        device_id: &DeviceId,
        dsk_pub: &[u8; 32],
        kind: Kind,
        tier: Tier,
        signer_tier: SignerTier,
    ) -> [u8; 64] {
        self.key
            .sign(&CredentialIdentity::dsk_message(device_id, dsk_pub, kind, tier, signer_tier))
            .to_bytes()
    }

    pub fn sign_device_list(&self, unsigned: &DeviceListUnsigned) -> [u8; 64] {
        debug_assert_eq!(&unsigned.signing_message()[..DOMAIN_DEVICES.len()], DOMAIN_DEVICES);
        self.key.sign(&unsigned.signing_message()).to_bytes()
    }
}

/// The user master key. It signs exactly one thing: the SSK.
pub struct UmkSigner {
    key: SigningKey,
}

impl UmkSigner {
    pub fn from_bytes(sk: &[u8; 32]) -> Self {
        Self { key: SigningKey::from_bytes(sk) }
    }

    pub fn public(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    pub fn sign_ssk(&self, ssk_pub: &[u8; 32]) -> [u8; 64] {
        self.key.sign(&CredentialIdentity::ssk_message(ssk_pub)).to_bytes()
    }
}
```

- [ ] **Step 5: Write the signed device list**

Prepend to `core/dilla-core/src/identity/device_list.rs`:

```rust
//! The SSK-signed device list: a hash-chained, monotonically versioned 6-element array
//! (protocol/03-identity.md "Device list").

use super::{sha256, Tier, DOMAIN_DEVICES};
use crate::cbor::{decode_strict, CborError, Decoder, Encoder};
use crate::error::ProtocolError;
use crate::ids::{DeviceId, UserId};
use ed25519_dalek::{Signature, VerifyingKey};

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DeviceEntry {
    pub device_id: DeviceId,
    pub dsk_pub: [u8; 32],
    pub tier: Tier,
    pub added_at: u64,
    pub revoked_at: Option<u64>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DeviceListUnsigned {
    pub v: u64,
    pub user_id: UserId,
    /// Monotonically increasing from 1.
    pub version: u64,
    /// SHA-256 of the previous list's full 6-element encoding; 32 zero bytes for version 1.
    pub prev_hash: [u8; 32],
    pub entries: Vec<DeviceEntry>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DeviceList {
    pub unsigned: DeviceListUnsigned,
    pub sig_ssk: [u8; 64],
}

fn write_entries(e: &mut Encoder, entries: &[DeviceEntry]) {
    e.array(entries.len());
    for entry in entries {
        e.array(5)
            .bytes(entry.device_id.as_bytes())
            .bytes(&entry.dsk_pub)
            .uint(u64::from(entry.tier.as_u8()))
            .uint(entry.added_at)
            .opt_uint(entry.revoked_at);
    }
}

fn read_entries(d: &mut Decoder<'_>) -> Result<Vec<DeviceEntry>, CborError> {
    let n = d.array_len()?;
    let mut entries = Vec::with_capacity(n);
    for _ in 0..n {
        d.array(5)?;
        let device_id = DeviceId::from_bytes(d.bytes_exact::<16>()?);
        let dsk_pub = d.bytes_exact::<32>()?;
        let tier = Tier::from_u64(d.uint()?)
            .map_err(|_| CborError::TypeMismatch { expected: "tier", offset: 0 })?;
        let added_at = d.uint()?;
        let revoked_at = d.opt_uint()?;
        entries.push(DeviceEntry { device_id, dsk_pub, tier, added_at, revoked_at });
    }
    Ok(entries)
}

impl DeviceListUnsigned {
    /// The 5-element array `[v, user_id, version, prev_hash, entries]`.
    pub fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::with_capacity(96 + 90 * self.entries.len());
        e.array(5)
            .uint(self.v)
            .bytes(self.user_id.as_bytes())
            .uint(self.version)
            .bytes(&self.prev_hash);
        write_entries(&mut e, &self.entries);
        e.into_vec()
    }

    /// `"dilla devices v1" || encode()`
    pub fn signing_message(&self) -> Vec<u8> {
        let body = self.encode();
        let mut m = Vec::with_capacity(DOMAIN_DEVICES.len() + body.len());
        m.extend_from_slice(DOMAIN_DEVICES);
        m.extend_from_slice(&body);
        m
    }
}

impl DeviceList {
    /// The 6-element array: the five unsigned fields plus `sig_ssk`.
    pub fn encode(&self) -> Vec<u8> {
        let u = &self.unsigned;
        let mut e = Encoder::with_capacity(160 + 90 * u.entries.len());
        e.array(6).uint(u.v).bytes(u.user_id.as_bytes()).uint(u.version).bytes(&u.prev_hash);
        write_entries(&mut e, &u.entries);
        e.bytes(&self.sig_ssk);
        e.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        decode_strict(bytes, |d| {
            d.array(6)?;
            let v = d.uint()?;
            let user_id = UserId::from_bytes(d.bytes_exact::<16>()?);
            let version = d.uint()?;
            let prev_hash = d.bytes_exact::<32>()?;
            let entries = read_entries(d)?;
            let sig_ssk = d.bytes_exact::<64>()?;
            Ok(Self {
                unsigned: DeviceListUnsigned { v, user_id, version, prev_hash, entries },
                sig_ssk,
            })
        })
        .map_err(|_| ProtocolError::Credential)
    }

    /// SHA-256 of the full 6-element encoding. This is what the next version's `prev_hash` carries.
    pub fn hash(&self) -> [u8; 32] {
        sha256(&self.encode())
    }

    pub fn verify(&self, ssk_pub: &[u8; 32]) -> Result<(), ProtocolError> {
        let key = VerifyingKey::from_bytes(ssk_pub).map_err(|_| ProtocolError::Credential)?;
        key.verify_strict(&self.unsigned.signing_message(), &Signature::from_bytes(&self.sig_ssk))
            .map_err(|_| ProtocolError::Credential)
    }

    /// A verifier keeps the newest validated list per user and accepts a replacement only if the
    /// version is strictly greater, the chain link matches and the signature verifies.
    pub fn accept(
        &self,
        prev: Option<&DeviceList>,
        ssk_pub: &[u8; 32],
    ) -> Result<(), ProtocolError> {
        match prev {
            Some(p) => {
                if self.unsigned.version <= p.unsigned.version {
                    return Err(ProtocolError::DeviceListStale);
                }
                if self.unsigned.prev_hash != p.hash() {
                    return Err(ProtocolError::DeviceListStale);
                }
            }
            None => {
                if self.unsigned.version != 1 || self.unsigned.prev_hash != [0u8; 32] {
                    return Err(ProtocolError::DeviceListStale);
                }
            }
        }
        self.verify(ssk_pub)
    }

    pub fn lookup(&self, device_id: &DeviceId) -> Option<&DeviceEntry> {
        self.unsigned.entries.iter().find(|e| &e.device_id == device_id)
    }

    /// Rules 3 and 5 of protocol/03: the leaf's device is listed, is not revoked, carries this
    /// exact `dsk_pub`, and its recorded tier equals the credential's.
    pub fn check_leaf(
        &self,
        device_id: &DeviceId,
        dsk_pub: &[u8; 32],
        tier: Tier,
    ) -> Result<(), ProtocolError> {
        let entry = self.lookup(device_id).ok_or(ProtocolError::DeviceUnlisted)?;
        if entry.revoked_at.is_some() || &entry.dsk_pub != dsk_pub {
            return Err(ProtocolError::DeviceUnlisted);
        }
        if entry.tier != tier {
            return Err(ProtocolError::TierMismatch);
        }
        Ok(())
    }
}
```

- [ ] **Step 6: Write the safety number, the recovery encodings and the pairing payloads**

Prepend to `core/dilla-core/src/identity/safety.rs`:

```rust
//! Safety numbers and the pairing/call SAS (protocol/03-identity.md "Safety number").

use super::sha256;

/// The bytes as one unsigned big-endian integer, in decimal, left-padded with zeros to 78 digits
/// (2^256 has 78 decimal digits).
pub fn decimal_digits(bytes: &[u8; 32]) -> String {
    let mut n = *bytes;
    let mut digits: Vec<u8> = Vec::with_capacity(78);
    loop {
        let mut rem = 0u16;
        let mut nonzero = false;
        for b in n.iter_mut() {
            let cur = rem * 256 + u16::from(*b);
            *b = (cur / 10) as u8;
            rem = cur % 10;
            if *b != 0 {
                nonzero = true;
            }
        }
        digits.push(b'0' + rem as u8);
        if !nonzero {
            break;
        }
    }
    while digits.len() < 78 {
        digits.push(b'0');
    }
    digits.reverse();
    String::from_utf8(digits).expect("ascii digits")
}

/// The first 60 digits of `decimal(SHA-256(min(a, b) || max(a, b)))`, compared byte-wise.
/// Displayed as 12 groups of 5.
pub fn safety_number(umk_a: &[u8; 32], umk_b: &[u8; 32]) -> String {
    let (lo, hi) = if umk_a <= umk_b { (umk_a, umk_b) } else { (umk_b, umk_a) };
    let mut input = [0u8; 64];
    input[..32].copy_from_slice(lo);
    input[32..].copy_from_slice(hi);
    let mut digits = decimal_digits(&sha256(&input));
    digits.truncate(60);
    digits
}

/// The first 30 digits of the MLS `epoch_authenticator`. Displayed as 6 groups of 5.
pub fn sas(epoch_authenticator: &[u8; 32]) -> String {
    let mut digits = decimal_digits(epoch_authenticator);
    digits.truncate(30);
    digits
}

/// Display helper: split into fixed-size groups joined by single spaces.
pub fn group_digits(digits: &str, per_group: usize) -> String {
    assert!(per_group > 0, "group size must be positive");
    let bytes = digits.as_bytes();
    let mut out = String::with_capacity(digits.len() + digits.len() / per_group);
    for (i, chunk) in bytes.chunks(per_group).enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(core::str::from_utf8(chunk).expect("ascii digits"));
    }
    out
}
```

Prepend to `core/dilla-core/src/identity/recovery.rs`:

```rust
//! The recovery key's Crockford base32 form and the two keys derived from it
//! (protocol/03-identity.md "Recovery", protocol/06-backup-archive.md "Keys").
//!
//! The 24-word BIP-39 form is deliberately absent: no reference implementation and no vector for
//! it exists in this repository, so there is nothing to check an implementation against.

use super::{hkdf_sha256, CROCKFORD, INFO_ARCHIVE, INFO_HEADER};
use crate::error::ProtocolError;

/// MSB-first 5-bit groups, uppercase, ungrouped. The final character of a 32-byte input carries
/// one payload bit followed by four zero bits.
pub(super) fn crockford_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let (mut acc, mut bits) = (0u16, 0u8);
    for b in bytes {
        acc = (acc << 8) | u16::from(*b);
        bits += 8;
        while bits >= 5 {
            out.push(char::from(CROCKFORD[usize::from((acc >> (bits - 5)) & 31)]));
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(char::from(CROCKFORD[usize::from((acc << (5 - bits)) & 31)]));
    }
    out
}

/// The inverse. Uppercase only, and any bits past the byte boundary must be zero, so one byte
/// string has exactly one spelling.
pub(super) fn crockford_decode(s: &str) -> Result<Vec<u8>, ProtocolError> {
    let out_len = s.len() * 5 / 8;
    if out_len == 0 || s.len() != out_len * 8 / 5 + usize::from(out_len * 8 % 5 != 0) {
        return Err(ProtocolError::Credential);
    }
    let mut out = Vec::with_capacity(out_len);
    let (mut acc, mut bits) = (0u16, 0u8);
    for c in s.bytes() {
        let value = CROCKFORD
            .iter()
            .position(|k| *k == c)
            .ok_or(ProtocolError::Credential)? as u16;
        acc = (acc << 5) | value;
        bits += 5;
        if bits >= 8 {
            out.push(((acc >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    if out.len() != out_len || (acc & ((1 << bits) - 1)) != 0 {
        return Err(ProtocolError::Credential);
    }
    Ok(out)
}

/// 256 bits as 52 Crockford base32 characters, uppercase and ungrouped. The display form is
/// 13 groups of 4; grouping is a rendering concern, not part of the encoding.
pub fn recovery_key_base32(rk: &[u8; 32]) -> String {
    crockford_encode(rk)
}

pub fn recovery_key_from_base32(s: &str) -> Result<[u8; 32], ProtocolError> {
    if s.len() != 52 {
        return Err(ProtocolError::Credential);
    }
    let bytes = crockford_decode(s)?;
    let mut out = [0u8; 32];
    if bytes.len() != 32 {
        return Err(ProtocolError::Credential);
    }
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// `HKDF-SHA256(salt = "", IKM = RK, info = "dilla header v1", L = 32)`
pub fn k_header(rk: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    hkdf_sha256(Some(&[]), rk, INFO_HEADER, &mut out).expect("32 bytes is within the HKDF limit");
    out
}

/// `HKDF-SHA256(salt = "", IKM = RK, info = "dilla archive v1", L = 32)`
pub fn k_backup(rk: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    hkdf_sha256(Some(&[]), rk, INFO_ARCHIVE, &mut out).expect("32 bytes is within the HKDF limit");
    out
}
```

Prepend to `core/dilla-core/src/identity/pairing.rs`:

```rust
//! Pairing: the QR payload, the no-camera fingerprint, the TOFU pin record and the one
//! application message a pairing group ever carries (protocol/03-identity.md "Pairing").

use super::recovery::{crockford_decode, crockford_encode};
use super::{sha256, CROCKFORD};
use crate::cbor::{decode_strict, Encoder};
use crate::error::ProtocolError;
use crate::ids::{DeviceId, UserId};

/// The 4-element array a new device shows as a QR code.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PairingQr {
    pub v: u64,
    pub device_id: DeviceId,
    pub dsk_pub: [u8; 32],
    pub umk_pub: [u8; 32],
}

impl PairingQr {
    pub fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::with_capacity(96);
        e.array(4)
            .uint(self.v)
            .bytes(self.device_id.as_bytes())
            .bytes(&self.dsk_pub)
            .bytes(&self.umk_pub);
        e.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        decode_strict(bytes, |d| {
            d.array(4)?;
            Ok(Self {
                v: d.uint()?,
                device_id: DeviceId::from_bytes(d.bytes_exact::<16>()?),
                dsk_pub: d.bytes_exact::<32>()?,
                umk_pub: d.bytes_exact::<32>()?,
            })
        })
        .map_err(|_| ProtocolError::Credential)
        .and_then(|q| if q.v == 1 { Ok(q) } else { Err(ProtocolError::Credential) })
    }

    pub fn to_base32(&self) -> String {
        crockford_encode(&self.encode())
    }

    pub fn from_base32(s: &str) -> Result<Self, ProtocolError> {
        Self::decode(&crockford_decode(s)?)
    }
}

/// The first 12 Crockford base32 characters of `SHA-256(dsk_pub)`, for the no-camera path.
pub fn fingerprint(dsk_pub: &[u8; 32]) -> String {
    let mut s = crockford_encode(&sha256(dsk_pub));
    s.truncate(12);
    debug_assert!(s.bytes().all(|c| CROCKFORD.contains(&c)));
    s
}

/// One row of the trust-on-first-use pin table.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Pin {
    pub user_id: UserId,
    pub umk_pub: [u8; 32],
    pub first_seen: u64,
    /// 0 or 1: whether a safety number was compared out of band.
    pub verified: u64,
}

/// The only application message a pairing group carries.
/// For a browser device `ssk_priv` and `pins` are null, and `k_backup` is null unless opted in.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PairingPayload {
    pub v: u64,
    /// The SSK-signed credential identity CBOR of the new device.
    pub credential: Vec<u8>,
    pub ssk_priv: Option<[u8; 32]>,
    pub k_backup: Option<[u8; 32]>,
    pub pins: Option<Vec<Pin>>,
}

impl PairingPayload {
    pub fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::with_capacity(256 + self.credential.len());
        e.array(5)
            .uint(self.v)
            .bytes(&self.credential)
            .opt_bytes(self.ssk_priv.as_ref().map(|k| &k[..]))
            .opt_bytes(self.k_backup.as_ref().map(|k| &k[..]));
        match &self.pins {
            None => {
                e.null();
            }
            Some(pins) => {
                e.array(pins.len());
                for p in pins {
                    e.array(4)
                        .bytes(p.user_id.as_bytes())
                        .bytes(&p.umk_pub)
                        .uint(p.first_seen)
                        .uint(p.verified);
                }
            }
        }
        e.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        decode_strict(bytes, |d| {
            d.array(5)?;
            let v = d.uint()?;
            let credential = d.bytes()?.to_vec();
            let ssk_priv = d.opt_bytes_exact::<32>()?;
            let k_backup = d.opt_bytes_exact::<32>()?;
            let pins = if d.try_null()? {
                None
            } else {
                let n = d.array_len()?;
                let mut pins = Vec::with_capacity(n);
                for _ in 0..n {
                    d.array(4)?;
                    pins.push(Pin {
                        user_id: UserId::from_bytes(d.bytes_exact::<16>()?),
                        umk_pub: d.bytes_exact::<32>()?,
                        first_seen: d.uint()?,
                        verified: d.uint()?,
                    });
                }
                Some(pins)
            };
            Ok(Self { v, credential, ssk_priv, k_backup, pins })
        })
        .map_err(|_| ProtocolError::Credential)
    }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --lib --locked
```

Expected: PASS, `test result: ok. 0 failed; 0 ignored` — the 9 unit tests from task 3 plus the 24
written here, so 33 at the time this task was drafted. Treat `0 failed` as the signal and correct
the count rather than the code if it differs.

```bash
/home/thim/.cargo/bin/cargo clippy --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --all-targets --locked -- -D warnings
```

Expected: PASS with no warnings.

- [ ] **Step 8: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add core/dilla-core/src/identity && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(core): credentials, signed device lists, safety numbers and recovery encodings'
```
---

### Task 5: Envelope and franking

**Files:**
- Create: `core/dilla-core/src/envelope/mod.rs`, `core/dilla-core/src/envelope/frank.rs`
- Modify: `core/dilla-core/src/lib.rs` (add `pub mod envelope;`)
- Test: unit tests inside both new files

**Interfaces:**
- Consumes: `cbor::{Encoder, Decoder, decode_strict}`, `ids::{MsgId, DeviceId}`, `error::ProtocolError`, `identity::{hmac_sha256, hmac_sha256_verify}`.
- Produces, all under `envelope::`:
  `MAX_BODY_LONG: usize = 4_000`, `MAX_BODY_SHORT: usize = 32`, `MAX_ATTACHMENTS: usize = 10`, `MAX_PREVIEWS: usize = 5`, `MAX_PREVIEW_IMAGE: usize = 32_768`, `MAX_THUMB: usize = 16_384`, `PADDING_MULTIPLE: usize = 256`, `DOMAIN_FRANK: &[u8]`, `DOMAIN_FRANK_TAG: &[u8]`;
  `EnvelopeType { Message = 0, Edit = 1, Delete = 2, ReactionAdd = 3, ReactionRemove = 4, Pin = 5, Unpin = 6 }` with `as_u8`, `from_u64`, `body_limit`;
  `Attachment { blob_id: [u8; 32], key: [u8; 32], nonce: [u8; 12], size: u64, mime: String, w: Option<u64>, h: Option<u64>, thumb: Option<Vec<u8>> }`;
  `Preview { url: String, title: String, description: String, image: Option<Vec<u8>> }`;
  `Envelope { v: u64, msg_id: MsgId, kind: EnvelopeType, thread_id: Option<MsgId>, reply_to: Option<MsgId>, body: String, attachments: Vec<Attachment>, previews: Vec<Preview>, k_f: [u8; 32] }` with `encode`, `decode`, `validate`, `commitment_preimage`, `commitment`, `verify_commitment`;
  `FrankingTagInput { group_id: [u8; 16], epoch: u64, seq: u64, uploader_device: DeviceId, commitment: [u8; 32], recv_ts: u64 }` with `preimage`;
  `franking_tag(&[u8; 32], &FrankingTagInput) -> [u8; 32]`, `verify_franking_tag(&[u8; 32], &FrankingTagInput, &[u8; 32]) -> bool`.

- [ ] **Step 1: Write the failing tests**

Create `core/dilla-core/src/envelope/mod.rs` containing only this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::MsgId;

    const ENVELOPE_JSON: &str = include_str!("../../../../protocol/vectors/envelope.json");

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit"))
            .collect()
    }

    fn unhex_n<const N: usize>(s: &str) -> [u8; N] {
        let v = unhex(s);
        assert_eq!(v.len(), N, "expected {N} bytes, got {}", v.len());
        let mut out = [0u8; N];
        out.copy_from_slice(&v);
        out
    }

    fn hex_of(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn opt_msg_id(v: &serde_json::Value) -> Option<MsgId> {
        v.as_str().map(|s| MsgId::from_bytes(unhex_n::<16>(s)))
    }

    fn opt_bytes(v: &serde_json::Value) -> Option<Vec<u8>> {
        v.as_str().map(unhex)
    }

    fn envelope_from_json(j: &serde_json::Value) -> Envelope {
        Envelope {
            v: j["v"].as_u64().expect("v"),
            msg_id: MsgId::from_bytes(unhex_n::<16>(j["msgId"].as_str().expect("msgId"))),
            kind: EnvelopeType::from_u64(j["type"].as_u64().expect("type")).expect("type"),
            thread_id: opt_msg_id(&j["threadId"]),
            reply_to: opt_msg_id(&j["replyTo"]),
            body: j["body"].as_str().expect("body").to_owned(),
            attachments: j["attachments"]
                .as_array()
                .expect("attachments")
                .iter()
                .map(|a| Attachment {
                    blob_id: unhex_n::<32>(a["blobId"].as_str().expect("blobId")),
                    key: unhex_n::<32>(a["key"].as_str().expect("key")),
                    nonce: unhex_n::<12>(a["nonce"].as_str().expect("nonce")),
                    size: a["size"].as_u64().expect("size"),
                    mime: a["mime"].as_str().expect("mime").to_owned(),
                    w: a["w"].as_u64(),
                    h: a["h"].as_u64(),
                    thumb: opt_bytes(&a["thumb"]),
                })
                .collect(),
            previews: j["previews"]
                .as_array()
                .expect("previews")
                .iter()
                .map(|p| Preview {
                    url: p["url"].as_str().expect("url").to_owned(),
                    title: p["title"].as_str().expect("title").to_owned(),
                    description: p["description"].as_str().expect("description").to_owned(),
                    image: opt_bytes(&p["image"]),
                })
                .collect(),
            k_f: unhex_n::<32>(j["kf"].as_str().expect("kf")),
        }
    }

    #[test]
    fn every_envelope_vector_reproduces_cbor_length_and_commitment() {
        let doc: serde_json::Value = serde_json::from_str(ENVELOPE_JSON).expect("envelope.json");
        let cases = doc["cases"].as_array().expect("cases");
        assert_eq!(cases.len(), 4, "envelope.json is expected to carry four cases");
        for case in cases {
            let name = case["name"].as_str().expect("name");
            let env = envelope_from_json(&case["envelope"]);
            let bytes = env.encode().unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(hex_of(&bytes), case["cbor"].as_str().expect("cbor"), "{name}: cbor");
            assert_eq!(
                bytes.len() as u64,
                case["length"].as_u64().expect("length"),
                "{name}: length"
            );
            assert_eq!(
                hex_of(&env.commitment().unwrap()),
                case["commitment"].as_str().expect("commitment"),
                "{name}: commitment"
            );
            assert_eq!(Envelope::decode(&bytes).unwrap(), env, "{name}: round trip");
        }
    }

    #[test]
    fn commitment_preimage_blanks_only_the_ninth_element() {
        let doc: serde_json::Value = serde_json::from_str(ENVELOPE_JSON).expect("envelope.json");
        let env = envelope_from_json(&doc["cases"][0]["envelope"]);
        let full = env.encode().unwrap();
        let pre = env.commitment_preimage().unwrap();
        // the full encoding ends with `58 20` + 32 bytes of k_f; the preimage ends with `40`
        assert_eq!(&pre[..full.len() - 34], &full[..full.len() - 34]);
        assert_eq!(pre[pre.len() - 1], 0x40);
        assert_eq!(pre.len(), full.len() - 33);
    }

    fn base() -> Envelope {
        Envelope {
            v: 1,
            msg_id: MsgId::from_bytes([0x01; 16]),
            kind: EnvelopeType::Message,
            thread_id: None,
            reply_to: None,
            body: String::new(),
            attachments: Vec::new(),
            previews: Vec::new(),
            k_f: [0x06; 32],
        }
    }

    #[test]
    fn decode_rejects_in_the_documented_order() {
        // wrong element count
        let mut bytes = base().encode().unwrap();
        bytes[0] = 0x88; // array of 8
        assert_eq!(Envelope::decode(&bytes), Err(ProtocolError::EnvelopeShape));

        // v != 1. The bad byte is patched into a valid encoding: `Envelope::encode` begins with
        // `self.validate()?`, which rejects `v != 1`, so `base().v = 2; ...encode().unwrap()`
        // would panic and the decode path under test would never run. Element 2 of the array,
        // `v`, sits at offset 1, straight after the `0x89` array head.
        let mut bytes = base().encode().unwrap();
        assert_eq!(bytes[1], 0x01, "the v element must be where this test expects it");
        bytes[1] = 0x02;
        assert_eq!(Envelope::decode(&bytes), Err(ProtocolError::EnvelopeShape));

        // unknown type: element 3 of the array sits at offset 19
        // (1 array head + 1 v + 17 msg_id)
        let mut bytes = base().encode().unwrap();
        assert_eq!(bytes[19], 0x00, "the type element must be where this test expects it");
        bytes[19] = 0x07;
        assert_eq!(Envelope::decode(&bytes), Err(ProtocolError::EnvelopeType));

        // trailing bytes
        let mut bytes = base().encode().unwrap();
        bytes.push(0x00);
        assert_eq!(Envelope::decode(&bytes), Err(ProtocolError::EnvelopeShape));
    }

    #[test]
    fn validate_enforces_every_limit() {
        assert_eq!(base().validate(), Ok(()));

        let mut long = base();
        long.body = "a".repeat(MAX_BODY_LONG);
        assert_eq!(long.validate(), Ok(()));
        long.body = "a".repeat(MAX_BODY_LONG + 1);
        assert_eq!(long.validate(), Err(ProtocolError::EnvelopeLimit));

        let mut reaction = base();
        reaction.kind = EnvelopeType::ReactionAdd;
        reaction.body = "a".repeat(MAX_BODY_SHORT);
        assert_eq!(reaction.validate(), Ok(()));
        reaction.body = "a".repeat(MAX_BODY_SHORT + 1);
        assert_eq!(reaction.validate(), Err(ProtocolError::EnvelopeLimit));

        let attachment = Attachment {
            blob_id: [0x03; 32],
            key: [0x04; 32],
            nonce: [0x05; 12],
            size: 1,
            mime: "image/jpeg".to_owned(),
            w: None,
            h: None,
            thumb: None,
        };
        let mut many = base();
        many.attachments = vec![attachment.clone(); MAX_ATTACHMENTS];
        assert_eq!(many.validate(), Ok(()));
        many.attachments.push(attachment.clone());
        assert_eq!(many.validate(), Err(ProtocolError::EnvelopeLimit));

        let mut fat_thumb = base();
        let mut a = attachment.clone();
        a.thumb = Some(vec![0u8; MAX_THUMB]);
        fat_thumb.attachments = vec![a.clone()];
        assert_eq!(fat_thumb.validate(), Ok(()));
        a.thumb = Some(vec![0u8; MAX_THUMB + 1]);
        fat_thumb.attachments = vec![a];
        assert_eq!(fat_thumb.validate(), Err(ProtocolError::EnvelopeLimit));

        let preview = Preview {
            url: "https://example.invalid/".to_owned(),
            title: "t".to_owned(),
            description: "d".to_owned(),
            image: None,
        };
        let mut many = base();
        many.previews = vec![preview.clone(); MAX_PREVIEWS];
        assert_eq!(many.validate(), Ok(()));
        many.previews.push(preview.clone());
        assert_eq!(many.validate(), Err(ProtocolError::EnvelopeLimit));

        let mut fat_image = base();
        let mut p = preview;
        p.image = Some(vec![0u8; MAX_PREVIEW_IMAGE]);
        fat_image.previews = vec![p.clone()];
        assert_eq!(fat_image.validate(), Ok(()));
        p.image = Some(vec![0u8; MAX_PREVIEW_IMAGE + 1]);
        fat_image.previews = vec![p];
        assert_eq!(fat_image.validate(), Err(ProtocolError::EnvelopeLimit));
    }

    #[test]
    fn body_limit_is_per_type() {
        assert_eq!(EnvelopeType::Message.body_limit(), MAX_BODY_LONG);
        assert_eq!(EnvelopeType::Edit.body_limit(), MAX_BODY_LONG);
        assert_eq!(EnvelopeType::ReactionAdd.body_limit(), MAX_BODY_SHORT);
        assert_eq!(EnvelopeType::ReactionRemove.body_limit(), MAX_BODY_SHORT);
        for t in [EnvelopeType::Delete, EnvelopeType::Pin, EnvelopeType::Unpin] {
            assert_eq!(t.body_limit(), 0);
        }
        assert_eq!(EnvelopeType::from_u64(7), Err(ProtocolError::EnvelopeType));
    }

    #[test]
    fn verify_commitment_requires_exactly_thirty_two_authenticated_bytes() {
        let env = base();
        let c = env.commitment().unwrap();
        assert_eq!(env.verify_commitment(&c), Ok(()));
        assert_eq!(env.verify_commitment(&c[..31]), Err(ProtocolError::FrankMismatch));
        assert_eq!(env.verify_commitment(&[]), Err(ProtocolError::FrankMismatch));
        let mut wrong = c;
        wrong[0] ^= 0x01;
        assert_eq!(env.verify_commitment(&wrong), Err(ProtocolError::FrankMismatch));
    }
}
```
Create `core/dilla-core/src/envelope/frank.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::Envelope;
    use crate::ids::DeviceId;

    const FRANKING_JSON: &str = include_str!("../../../../protocol/vectors/franking.json");

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit"))
            .collect()
    }

    fn unhex_n<const N: usize>(s: &str) -> [u8; N] {
        let v = unhex(s);
        assert_eq!(v.len(), N);
        let mut out = [0u8; N];
        out.copy_from_slice(&v);
        out
    }

    fn hex_of(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn every_franking_vector_reproduces_its_tag() {
        let doc: serde_json::Value = serde_json::from_str(FRANKING_JSON).expect("franking.json");
        let k_frank = unhex_n::<32>(doc["instance_franking_key"].as_str().expect("key"));
        let cases = doc["cases"].as_array().expect("cases");
        assert_eq!(cases.len(), 3, "franking.json is expected to carry three cases");
        for case in cases {
            let input = FrankingTagInput {
                group_id: unhex_n::<16>(case["group_id"].as_str().expect("group_id")),
                epoch: case["epoch"].as_u64().expect("epoch"),
                seq: case["seq"].as_u64().expect("seq"),
                uploader_device: DeviceId::from_bytes(unhex_n::<16>(
                    case["uploader_device"].as_str().expect("uploader_device"),
                )),
                commitment: unhex_n::<32>(case["commitment"].as_str().expect("commitment")),
                recv_ts: case["recv_ts"].as_u64().expect("recv_ts"),
            };
            let tag = franking_tag(&k_frank, &input);
            assert_eq!(hex_of(&tag), case["tag"].as_str().expect("tag"));
            assert!(verify_franking_tag(&k_frank, &input, &tag));
            let mut wrong = tag;
            wrong[31] ^= 0x01;
            assert!(!verify_franking_tag(&k_frank, &input, &wrong));
        }
    }

    /// The shared envelope in franking.json must produce the commitment all three cases carry.
    #[test]
    fn the_shared_envelope_reproduces_the_shared_commitment() {
        let doc: serde_json::Value = serde_json::from_str(FRANKING_JSON).expect("franking.json");
        let bytes = unhex(doc["envelope_cbor"].as_str().expect("envelope_cbor"));
        let env = Envelope::decode(&bytes).expect("decode");
        assert_eq!(env.encode().unwrap(), bytes, "re-encoding must be byte-identical");
        assert_eq!(
            hex_of(&env.commitment().unwrap()),
            doc["cases"][0]["commitment"].as_str().expect("commitment")
        );
    }

    #[test]
    fn the_tag_preimage_is_the_documented_concatenation() {
        let input = FrankingTagInput {
            group_id: [0x07; 16],
            epoch: 41,
            seq: 4127,
            uploader_device: DeviceId::from_bytes([0x08; 16]),
            commitment: [0x0c; 32],
            recv_ts: 1_758_659_640,
        };
        let mut want = b"dilla frank tag v1".to_vec();
        want.extend_from_slice(&[0x07; 16]);
        want.extend_from_slice(&41u64.to_be_bytes());
        want.extend_from_slice(&4127u64.to_be_bytes());
        want.extend_from_slice(&[0x08; 16]);
        want.extend_from_slice(&[0x0c; 32]);
        want.extend_from_slice(&1_758_659_640u64.to_be_bytes());
        assert_eq!(input.preimage(), want);
        assert_eq!(want.len(), 18 + 16 + 8 + 8 + 16 + 32 + 8);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --lib --locked
```

Declare the module first — step 1 only created the files, and an undeclared module is never
compiled, so this run would exit 0 with `0 tests` added rather than failing. Add step 5's
`pub mod envelope;` to `core/dilla-core/src/lib.rs` and `mod frank;` to `envelope/mod.rs`, then
re-run the command above.

Expected: FAIL, non-zero exit, with `error[E0412]: cannot find type Envelope in this scope`,
`error[E0425]: cannot find function franking_tag in this scope` and the rest of the items steps 3
and 4 have not written yet.

- [ ] **Step 3: Write the envelope**

Prepend to `core/dilla-core/src/envelope/mod.rs`:

```rust
//! The message envelope and its franking commitment (protocol/04-envelope-and-franking.md).
//!
//! The envelope is a 9-element fixed-position CBOR array. It travels inside an MLS
//! `PrivateMessage` whose `authenticated_data` is exactly the 32-byte commitment `C`, and whose
//! ciphertext is padded to a multiple of `PADDING_MULTIPLE` bytes.

mod frank;

pub use frank::{franking_tag, verify_franking_tag, FrankingTagInput};

use crate::cbor::{decode_strict, CborError, Decoder, Encoder};
use crate::error::ProtocolError;
use crate::identity::{hmac_sha256, hmac_sha256_verify};
use crate::ids::MsgId;

/// `body` limit in UTF-8 bytes for types 0 and 1.
pub const MAX_BODY_LONG: usize = 4_000;
/// `body` limit in UTF-8 bytes for types 3 and 4 (the emoji).
pub const MAX_BODY_SHORT: usize = 32;
pub const MAX_ATTACHMENTS: usize = 10;
pub const MAX_PREVIEWS: usize = 5;
pub const MAX_PREVIEW_IMAGE: usize = 32_768;
pub const MAX_THUMB: usize = 16_384;
/// The `PrivateMessage` carrying an envelope is padded so its ciphertext length is a multiple of
/// this (RFC 9420 section 6.3.1).
pub const PADDING_MULTIPLE: usize = 256;
/// `C = HMAC-SHA256(k_f, DOMAIN_FRANK || CBOR(envelope with k_f blanked))`
pub const DOMAIN_FRANK: &[u8] = b"dilla frank v1";
/// `T = HMAC-SHA256(K_frank, DOMAIN_FRANK_TAG || ...)`
pub const DOMAIN_FRANK_TAG: &[u8] = b"dilla frank tag v1";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum EnvelopeType {
    Message = 0,
    Edit = 1,
    Delete = 2,
    ReactionAdd = 3,
    ReactionRemove = 4,
    Pin = 5,
    Unpin = 6,
}

impl EnvelopeType {
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    pub fn from_u64(v: u64) -> Result<Self, ProtocolError> {
        Ok(match v {
            0 => Self::Message,
            1 => Self::Edit,
            2 => Self::Delete,
            3 => Self::ReactionAdd,
            4 => Self::ReactionRemove,
            5 => Self::Pin,
            6 => Self::Unpin,
            _ => return Err(ProtocolError::EnvelopeType),
        })
    }

    /// 4 000 bytes for a message or an edit, 32 for a reaction, 0 for a tombstone or a pin.
    pub const fn body_limit(self) -> usize {
        match self {
            Self::Message | Self::Edit => MAX_BODY_LONG,
            Self::ReactionAdd | Self::ReactionRemove => MAX_BODY_SHORT,
            Self::Delete | Self::Pin | Self::Unpin => 0,
        }
    }
}

/// `blob_id` is the SHA-256 of the **ciphertext**; a receiver that fetches the blob must verify it
/// (`E_BLOB_HASH`). `thumb` uses the same key with the nonce's last byte XORed with 0x01.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Attachment {
    pub blob_id: [u8; 32],
    pub key: [u8; 32],
    pub nonce: [u8; 12],
    /// Plaintext bytes.
    pub size: u64,
    pub mime: String,
    pub w: Option<u64>,
    pub h: Option<u64>,
    pub thumb: Option<Vec<u8>>,
}

/// Sender-generated. A receiver MUST NOT fetch the remote resource.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Preview {
    pub url: String,
    pub title: String,
    pub description: String,
    pub image: Option<Vec<u8>>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Envelope {
    pub v: u64,
    pub msg_id: MsgId,
    pub kind: EnvelopeType,
    pub thread_id: Option<MsgId>,
    pub reply_to: Option<MsgId>,
    pub body: String,
    pub attachments: Vec<Attachment>,
    pub previews: Vec<Preview>,
    /// The franking key, random per envelope and per edit.
    pub k_f: [u8; 32],
}

impl Envelope {
    fn write(&self, e: &mut Encoder, k_f: Option<&[u8; 32]>) {
        e.array(9)
            .uint(self.v)
            .bytes(self.msg_id.as_bytes())
            .uint(u64::from(self.kind.as_u8()))
            .opt_bytes(self.thread_id.as_ref().map(|m| &m.0[..]))
            .opt_bytes(self.reply_to.as_ref().map(|m| &m.0[..]))
            .text(&self.body);
        e.array(self.attachments.len());
        for a in &self.attachments {
            e.array(8)
                .bytes(&a.blob_id)
                .bytes(&a.key)
                .bytes(&a.nonce)
                .uint(a.size)
                .text(&a.mime)
                .opt_uint(a.w)
                .opt_uint(a.h)
                .opt_bytes(a.thumb.as_deref());
        }
        e.array(self.previews.len());
        for p in &self.previews {
            e.array(4).text(&p.url).text(&p.title).text(&p.description).opt_bytes(p.image.as_deref());
        }
        match k_f {
            Some(k) => e.bytes(k),
            None => e.bytes(&[]),
        };
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        self.validate()?;
        let mut e = Encoder::with_capacity(256 + self.body.len());
        self.write(&mut e, Some(&self.k_f));
        Ok(e.into_vec())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        let env = decode_strict(bytes, Self::read).map_err(map_cbor)?;
        env.validate()?;
        Ok(env)
    }

    fn read(d: &mut Decoder<'_>) -> Result<Self, CborError> {
        d.array(9)?;
        let v = d.uint()?;
        if v != 1 {
            return Err(SHAPE);
        }
        let msg_id = MsgId::from_bytes(d.bytes_exact::<16>()?);
        let kind = EnvelopeType::from_u64(d.uint()?).map_err(|_| TYPE)?;
        let thread_id = d.opt_bytes_exact::<16>()?.map(MsgId::from_bytes);
        let reply_to = d.opt_bytes_exact::<16>()?.map(MsgId::from_bytes);
        let body = d.text()?.to_owned();

        let n = d.array_len()?;
        let mut attachments = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(8)?;
            attachments.push(Attachment {
                blob_id: d.bytes_exact::<32>()?,
                key: d.bytes_exact::<32>()?,
                nonce: d.bytes_exact::<12>()?,
                size: d.uint()?,
                mime: d.text()?.to_owned(),
                w: d.opt_uint()?,
                h: d.opt_uint()?,
                thumb: if d.try_null()? { None } else { Some(d.bytes()?.to_vec()) },
            });
        }

        let n = d.array_len()?;
        let mut previews = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(4)?;
            previews.push(Preview {
                url: d.text()?.to_owned(),
                title: d.text()?.to_owned(),
                description: d.text()?.to_owned(),
                image: if d.try_null()? { None } else { Some(d.bytes()?.to_vec()) },
            });
        }

        let k_f = d.bytes_exact::<32>()?;
        Ok(Self { v, msg_id, kind, thread_id, reply_to, body, attachments, previews, k_f })
    }

    /// The reference decoder's order, reproduced exactly: element count, then `v`, then `type`,
    /// then the two fixed lengths, then every limit.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.v != 1 {
            return Err(ProtocolError::EnvelopeShape);
        }
        if self.body.len() > self.kind.body_limit() {
            return Err(ProtocolError::EnvelopeLimit);
        }
        if self.attachments.len() > MAX_ATTACHMENTS || self.previews.len() > MAX_PREVIEWS {
            return Err(ProtocolError::EnvelopeLimit);
        }
        for a in &self.attachments {
            if a.thumb.as_ref().is_some_and(|t| t.len() > MAX_THUMB) {
                return Err(ProtocolError::EnvelopeLimit);
            }
        }
        for p in &self.previews {
            if p.image.as_ref().is_some_and(|i| i.len() > MAX_PREVIEW_IMAGE) {
                return Err(ProtocolError::EnvelopeLimit);
            }
        }
        Ok(())
    }

    /// The same 9-element array with element 9 replaced by the empty byte string (`0x40`).
    pub fn commitment_preimage(&self) -> Result<Vec<u8>, ProtocolError> {
        self.validate()?;
        let mut e = Encoder::with_capacity(256 + self.body.len());
        self.write(&mut e, None);
        Ok(e.into_vec())
    }

    /// `C = HMAC-SHA256(k_f, DOMAIN_FRANK || commitment_preimage())`
    pub fn commitment(&self) -> Result<[u8; 32], ProtocolError> {
        let pre = self.commitment_preimage()?;
        let mut data = Vec::with_capacity(DOMAIN_FRANK.len() + pre.len());
        data.extend_from_slice(DOMAIN_FRANK);
        data.extend_from_slice(&pre);
        Ok(hmac_sha256(&self.k_f, &data))
    }

    /// Recomputes `C` from the decrypted envelope and compares it, in constant time, with the MLS
    /// `authenticated_data`. Any mismatch is a hard reject (protocol/04).
    pub fn verify_commitment(&self, authenticated_data: &[u8]) -> Result<(), ProtocolError> {
        if authenticated_data.len() != 32 {
            return Err(ProtocolError::FrankMismatch);
        }
        let pre = self.commitment_preimage()?;
        let mut data = Vec::with_capacity(DOMAIN_FRANK.len() + pre.len());
        data.extend_from_slice(DOMAIN_FRANK);
        data.extend_from_slice(&pre);
        let mut tag = [0u8; 32];
        tag.copy_from_slice(authenticated_data);
        if hmac_sha256_verify(&self.k_f, &data, &tag) {
            Ok(())
        } else {
            Err(ProtocolError::FrankMismatch)
        }
    }
}

const SHAPE: CborError = CborError::TypeMismatch { expected: "envelope shape", offset: 0 };
const TYPE: CborError = CborError::TypeMismatch { expected: "envelope type", offset: 0 };

fn map_cbor(e: CborError) -> ProtocolError {
    match e {
        CborError::TypeMismatch { expected: "envelope type", .. } => ProtocolError::EnvelopeType,
        _ => ProtocolError::EnvelopeShape,
    }
}
```

- [ ] **Step 4: Write the franking tag**

Prepend to `core/dilla-core/src/envelope/frank.rs`:

```rust
//! The instance-side franking tag `T` (protocol/04-envelope-and-franking.md "Franking").
//!
//! `C` (the commitment) is computed by the sender and travels in the MLS `authenticated_data`.
//! `T` is computed by the delivery service over `C` and the delivery metadata, under a per-instance
//! key that is rotated yearly with old keys kept. A report is verified only when both match.

use super::DOMAIN_FRANK_TAG;
use crate::identity::{hmac_sha256, hmac_sha256_verify};
use crate::ids::DeviceId;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FrankingTagInput {
    pub group_id: [u8; 16],
    pub epoch: u64,
    pub seq: u64,
    pub uploader_device: DeviceId,
    pub commitment: [u8; 32],
    pub recv_ts: u64,
}

impl FrankingTagInput {
    /// `DOMAIN_FRANK_TAG || group_id || epoch(8 BE) || seq(8 BE) || uploader_device ||
    /// commitment || recv_ts(8 BE)`
    pub fn preimage(&self) -> Vec<u8> {
        let mut m = Vec::with_capacity(DOMAIN_FRANK_TAG.len() + 16 + 8 + 8 + 16 + 32 + 8);
        m.extend_from_slice(DOMAIN_FRANK_TAG);
        m.extend_from_slice(&self.group_id);
        m.extend_from_slice(&self.epoch.to_be_bytes());
        m.extend_from_slice(&self.seq.to_be_bytes());
        m.extend_from_slice(self.uploader_device.as_bytes());
        m.extend_from_slice(&self.commitment);
        m.extend_from_slice(&self.recv_ts.to_be_bytes());
        m
    }
}

pub fn franking_tag(k_frank: &[u8; 32], input: &FrankingTagInput) -> [u8; 32] {
    hmac_sha256(k_frank, &input.preimage())
}

pub fn verify_franking_tag(
    k_frank: &[u8; 32],
    input: &FrankingTagInput,
    tag: &[u8; 32],
) -> bool {
    hmac_sha256_verify(k_frank, &input.preimage(), tag)
}
```

- [ ] **Step 5: Declare the module**

Add `pub mod envelope;` to `core/dilla-core/src/lib.rs`, keeping the module list alphabetical:

```rust
pub mod cbor;
pub mod envelope;
pub mod error;
pub mod identity;
pub mod ids;
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --lib --locked
```

Expected: PASS, `test result: ok. 0 failed; 0 ignored` — the 33 unit tests from tasks 3 and 4 plus
the 9 written here, so 42 at the time this task was drafted. `0 failed` is the signal.

```bash
/home/thim/.cargo/bin/cargo clippy --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --all-targets --locked -- -D warnings
```

Expected: PASS with no warnings.

- [ ] **Step 7: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add core/dilla-core/src/envelope core/dilla-core/src/lib.rs && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(core): message envelope, franking commitment and franking tag'
```

---

### Task 6: SFrame key schedule, counter partition and header codec

**Files:**
- Create: `core/dilla-core/src/sframe/mod.rs`, `core/dilla-core/src/sframe/ctr.rs`, `core/dilla-core/src/sframe/header.rs`
- Modify: `core/dilla-core/src/lib.rs` (add `pub mod sframe;`)
- Test: unit tests inside `mod.rs`, `ctr.rs` and `header.rs`

**Interfaces:**
- Consumes: `error::ProtocolError`, `identity::hkdf_sha256`.
- Produces, all under `sframe::`:
  `SFRAME_SUITE: u16 = 0x0004`, `NK: usize = 16`, `NN: usize = 12`, `MAX_SEQ: u64 = (1 << 52) - 1`, `LABEL_BASE_KEY: &str`, `LABEL_KEY: &[u8]`, `LABEL_SALT: &[u8]`, `KID_EPOCH_WINDOW: u64 = 255`;
  `Kid` with `new(u16, u64) -> Self`, `from_raw(u64) -> Self`, `value(self) -> u64`, `leaf_index(self) -> u16`, `epoch_low(self) -> u8`;
  `Slot { Microphone = 0, Camera = 1, ScreenVideo = 2, ScreenAudio = 3 }`;
  `Ctr` with `new(u8, u8, u64) -> Result<Self, ProtocolError>`, `from_raw`, `value`, `slot`, `layer`, `seq`;
  `SframeKeys { key: [u8; NK], salt: [u8; NN] }`;
  `sframe_secret(&[u8; NK]) -> [u8; 32]`, `derive_keys(&[u8; NK], Kid) -> SframeKeys`, `nonce(&[u8; NN], Ctr) -> [u8; NN]`, `encode_header(Kid, Ctr) -> Vec<u8>`, `decode_header(&[u8]) -> Result<(Kid, Ctr, usize), ProtocolError>`.

Scope, straight from the contract: week 1 is the key schedule, the KID/CTR packing and the header
codec — exactly what `protocol/vectors/sframe.json` pins. The codec-prefix parsers (Opus, VP8, VP9,
H.264) and RBSP escaping named in the spec are **not** in this task; the `dilla-sframe/1` format
freezes at the end of W5 and those are declared then.

- [ ] **Step 1: Write the failing tests**

Create `core/dilla-core/src/sframe/mod.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const SFRAME_JSON: &str = include_str!("../../../../protocol/vectors/sframe.json");

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit"))
            .collect()
    }

    fn unhex_n<const N: usize>(s: &str) -> [u8; N] {
        let v = unhex(s);
        assert_eq!(v.len(), N);
        let mut out = [0u8; N];
        out.copy_from_slice(&v);
        out
    }

    fn hex_of(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// `kid` and `ctr` are decimal strings in the JSON even when small enough for a JSON number
    /// (protocol/vectors/README.md). Accept both spellings so a future regeneration cannot break
    /// the runner silently.
    fn as_u64(v: &serde_json::Value) -> u64 {
        match v {
            serde_json::Value::String(s) => s.parse().expect("decimal string"),
            other => other.as_u64().expect("number"),
        }
    }

    #[test]
    fn every_sframe_vector_reproduces_kid_key_salt_ctr_nonce_and_header() {
        let doc: serde_json::Value = serde_json::from_str(SFRAME_JSON).expect("sframe.json");
        assert_eq!(doc["suite"].as_u64(), Some(u64::from(SFRAME_SUITE)));
        let base_key = unhex_n::<NK>(doc["base_key"].as_str().expect("base_key"));
        let cases = doc["cases"].as_array().expect("cases");
        assert_eq!(cases.len(), 4, "sframe.json is expected to carry four cases");
        for case in cases {
            let leaf = u16::try_from(case["leaf_index"].as_u64().expect("leaf_index")).unwrap();
            let epoch = case["epoch"].as_u64().expect("epoch");
            let kid = Kid::new(leaf, epoch);
            assert_eq!(kid.value(), as_u64(&case["kid"]), "kid for leaf {leaf} epoch {epoch}");

            let keys = derive_keys(&base_key, kid);
            assert_eq!(hex_of(&keys.key), case["key"].as_str().expect("key"));
            assert_eq!(hex_of(&keys.salt), case["salt"].as_str().expect("salt"));

            let ctr = Ctr::new(
                u8::try_from(case["slot"].as_u64().expect("slot")).unwrap(),
                u8::try_from(case["layer"].as_u64().expect("layer")).unwrap(),
                case["seq"].as_u64().expect("seq"),
            )
            .expect("ctr");
            assert_eq!(ctr.value(), as_u64(&case["ctr"]), "ctr");
            assert_eq!(hex_of(&nonce(&keys.salt, ctr)), case["nonce"].as_str().expect("nonce"));
            assert_eq!(
                hex_of(&encode_header(kid, ctr)),
                case["header"].as_str().expect("header")
            );
        }
    }

    #[test]
    fn kid_packs_leaf_index_and_the_low_epoch_byte() {
        let kid = Kid::new(3, 297);
        assert_eq!(kid.value(), 809); // (3 << 8) | (297 mod 256 = 41)
        assert_eq!(kid.leaf_index(), 3);
        assert_eq!(kid.epoch_low(), 41);
        assert_eq!(Kid::new(3, 41).value(), Kid::new(3, 297).value());
        assert_eq!(Kid::new(65535, 255).value(), 16_777_215);
        assert_eq!(Kid::from_raw(16_777_215).leaf_index(), 65535);
        assert_eq!(KID_EPOCH_WINDOW, 255);
    }

    /// Anchored against a value computed outside this crate, not against
    /// `hmac_sha256(&[0u8; 32], base_key)` — that is `sframe_secret`'s own definition, so asserting
    /// it would hold for any implementation of either side.
    ///
    /// HKDF-Extract(salt = "", IKM) is HMAC-SHA256(key = 32 zero bytes, IKM) (RFC 5869 section
    /// 2.2). For IKM = `0x0a` x 16 that PRK is the constant below. `derive_keys` performs Extract
    /// and Expand in one `hkdf_sha256` call, so this test is `sframe_secret`'s only coverage: the
    /// sframe vectors do not reach it.
    #[test]
    fn sframe_secret_is_rfc_5869_extract_with_an_empty_salt() {
        let base_key = [0x0au8; NK];
        let expected: [u8; 32] = [
            0x2d, 0xe5, 0x3a, 0x7f, 0xec, 0xa0, 0xf6, 0x49, 0x68, 0x3f, 0xff, 0x23, 0x93, 0x1b,
            0x57, 0x6a, 0xce, 0x9f, 0x84, 0xb1, 0x95, 0xb2, 0x89, 0xb1, 0x65, 0xcd, 0x02, 0x4a,
            0xb8, 0x2b, 0x4c, 0x2c,
        ];
        assert_eq!(sframe_secret(&base_key), expected);
    }
}
```

Create `core/dilla-core/src/sframe/ctr.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctr_packs_slot_layer_and_seq() {
        let c = Ctr::new(1, 2, 1000).unwrap();
        assert_eq!(c.value(), 81_064_793_292_669_928);
        assert_eq!(c.slot(), 1);
        assert_eq!(c.layer(), 2);
        assert_eq!(c.seq(), 1000);

        let c = Ctr::new(3, 15, 1_073_741_824).unwrap();
        assert_eq!(c.value(), 283_726_777_598_083_072);
        assert_eq!(Ctr::from_raw(c.value()), c);
        assert_eq!(Ctr::new(0, 0, 0).unwrap().value(), 0);
    }

    #[test]
    fn ctr_refuses_an_out_of_range_layer_or_a_wrapped_sequence() {
        assert_eq!(Ctr::new(0, 16, 0), Err(ProtocolError::UnsupportedVersion));
        assert!(Ctr::new(0, 15, MAX_SEQ).is_ok());
        assert_eq!(Ctr::new(0, 0, MAX_SEQ + 1), Err(ProtocolError::UnsupportedVersion));
        assert_eq!(MAX_SEQ, (1u64 << 52) - 1);
    }

    #[test]
    fn slots_are_the_four_documented_sources() {
        assert_eq!(Slot::Microphone as u8, 0);
        assert_eq!(Slot::Camera as u8, 1);
        assert_eq!(Slot::ScreenVideo as u8, 2);
        assert_eq!(Slot::ScreenAudio as u8, 3);
    }

    #[test]
    fn nonce_is_the_salt_xor_the_counter_left_padded_to_twelve_bytes() {
        let salt = [0x11u8; 12];
        let ctr = Ctr::from_raw(0x0102_0304_0506_0708);
        let n = nonce(&salt, ctr);
        assert_eq!(&n[..4], &[0x11, 0x11, 0x11, 0x11]);
        assert_eq!(
            &n[4..],
            &[0x10, 0x13, 0x12, 0x15, 0x14, 0x17, 0x16, 0x19]
        );
        assert_eq!(nonce(&salt, Ctr::from_raw(0)), salt);
    }
}
```

Create `core/dilla-core/src/sframe/header.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn hex_of(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// RFC 9605 appendix C.1, as embedded in packages/protocol-vectors/src/sframe.test.ts.
    #[test]
    fn reproduces_the_rfc_9605_c1_header_vectors() {
        for (kid, ctr, expect) in [
            (0u64, 0u64, "00"),
            (0, 0x100, "090100"),
            (0xff, 0, "80ff"),
            (0x100, 0x100, "9901000100"),
        ] {
            let bytes = encode_header(Kid::from_raw(kid), Ctr::from_raw(ctr));
            assert_eq!(hex_of(&bytes), expect, "kid {kid} ctr {ctr}");
            let (k, c, read) = decode_header(&bytes).expect("decode");
            assert_eq!(k.value(), kid);
            assert_eq!(c.value(), ctr);
            assert_eq!(read, bytes.len());
        }
    }

    #[test]
    fn every_header_round_trips() {
        for kid in [0u64, 1, 7, 8, 0xff, 0x100, 0xffff, 0xff_ffff, u64::MAX] {
            for ctr in [0u64, 7, 8, 0xff, 0x100, 0x3e8, 0xffff_ffff, u64::MAX] {
                let bytes = encode_header(Kid::from_raw(kid), Ctr::from_raw(ctr));
                let (k, c, read) = decode_header(&bytes).expect("decode");
                assert_eq!((k.value(), c.value(), read), (kid, ctr, bytes.len()));
            }
        }
    }

    #[test]
    fn decode_rejects_a_truncated_header() {
        let bytes = encode_header(Kid::from_raw(0x100), Ctr::from_raw(0x100));
        assert_eq!(bytes.len(), 5);
        for cut in 0..bytes.len() {
            assert_eq!(
                decode_header(&bytes[..cut]),
                Err(ProtocolError::UnsupportedVersion),
                "truncated to {cut} bytes"
            );
        }
    }

    #[test]
    fn decode_returns_the_bytes_it_read_so_the_caller_can_advance() {
        let mut framed = encode_header(Kid::from_raw(41), Ctr::from_raw(0));
        let header_len = framed.len();
        framed.extend_from_slice(b"ciphertext");
        let (_, _, read) = decode_header(&framed).expect("decode");
        assert_eq!(read, header_len);
        assert_eq!(&framed[read..], b"ciphertext");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --lib --locked
```

Declare the module first (step 6's `pub mod sframe;`, plus `mod ctr; mod header;` inside
`sframe/mod.rs`): step 1 only created the files, and an undeclared module compiles nothing, so this
run would exit 0 with `0 tests` added instead of failing. Then re-run the command above.

Expected: FAIL, non-zero exit, with the resolution errors for `Kid`, `Ctr`, `derive_keys`, `nonce`,
`encode_header` and `decode_header` (`error[E0412]` / `error[E0425]`).

- [ ] **Step 3: Write the key schedule**

Prepend to `core/dilla-core/src/sframe/mod.rs`:

```rust
//! `dilla-sframe/1`: the RFC 9605 key schedule, KID and CTR packing and header codec for suite
//! 0x0004 (AES_128_GCM_SHA256_128), as pinned by protocol/05-media-frames.md.
//!
//! Week 1 covers exactly what protocol/vectors/sframe.json pins. The codec-prefix parsers for
//! Opus, VP8, VP9 and H.264 and the RBSP escaping arrive when the format is exercised end to end;
//! `dilla-sframe/1` freezes at the end of W5, never on paper.

mod ctr;
mod header;

pub use ctr::{nonce, Ctr, Slot, MAX_SEQ};
pub use header::{decode_header, encode_header};

use crate::identity::hkdf_sha256;

/// AES_128_GCM_SHA256_128.
pub const SFRAME_SUITE: u16 = 0x0004;
/// Key length in bytes.
pub const NK: usize = 16;
/// Nonce and salt length in bytes.
pub const NN: usize = 12;
/// A receiver MUST reject a KID that would resolve against an epoch more than this many commits
/// ago (protocol/05 "Rotation").
pub const KID_EPOCH_WINDOW: u64 = 255;
/// The MLS exporter label the call group's base key is derived under.
pub const LABEL_BASE_KEY: &str = "SFrame 1.0 Base Key";
/// Note the trailing space: it is part of the label.
pub const LABEL_KEY: &[u8] = b"SFrame 1.0 Secret key ";
/// Note the trailing space: it is part of the label.
pub const LABEL_SALT: &[u8] = b"SFrame 1.0 Secret salt ";

/// `(leaf_index << 8) | (epoch mod 256)`. `leaf_index` is capped at 2^16, so a KID uses 24 bits.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Kid(u64);

impl Kid {
    pub fn new(leaf_index: u16, epoch: u64) -> Self {
        Self((u64::from(leaf_index) << 8) | (epoch % 256))
    }

    pub const fn from_raw(v: u64) -> Self {
        Self(v)
    }

    pub const fn value(self) -> u64 {
        self.0
    }

    pub const fn leaf_index(self) -> u16 {
        ((self.0 >> 8) & 0xffff) as u16
    }

    pub const fn epoch_low(self) -> u8 {
        (self.0 & 0xff) as u8
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SframeKeys {
    pub key: [u8; NK],
    pub salt: [u8; NN],
}

/// `HKDF-Extract(salt = "", IKM = base_key)` (RFC 9605 section 4.4.2).
pub fn sframe_secret(base_key: &[u8; NK]) -> [u8; 32] {
    crate::identity::hmac_sha256(&[0u8; 32], base_key)
}

/// ```text
/// key  = HKDF-Expand(secret, "SFrame 1.0 Secret key "  || KID(8, BE) || 0x0004, 16)
/// salt = HKDF-Expand(secret, "SFrame 1.0 Secret salt " || KID(8, BE) || 0x0004, 12)
/// ```
///
/// The reference implementation performs Extract and Expand as one HKDF call with an empty salt,
/// which is what `hkdf_sha256(Some(&[]), base_key, info, out)` does here.
pub fn derive_keys(base_key: &[u8; NK], kid: Kid) -> SframeKeys {
    let mut info_key = Vec::with_capacity(LABEL_KEY.len() + 10);
    info_key.extend_from_slice(LABEL_KEY);
    info_key.extend_from_slice(&kid.value().to_be_bytes());
    info_key.extend_from_slice(&SFRAME_SUITE.to_be_bytes());

    let mut info_salt = Vec::with_capacity(LABEL_SALT.len() + 10);
    info_salt.extend_from_slice(LABEL_SALT);
    info_salt.extend_from_slice(&kid.value().to_be_bytes());
    info_salt.extend_from_slice(&SFRAME_SUITE.to_be_bytes());

    let mut key = [0u8; NK];
    let mut salt = [0u8; NN];
    hkdf_sha256(Some(&[]), base_key, &info_key, &mut key).expect("16 bytes is within the limit");
    hkdf_sha256(Some(&[]), base_key, &info_salt, &mut salt).expect("12 bytes is within the limit");
    SframeKeys { key, salt }
}
```

- [ ] **Step 4: Write the counter partition**

Prepend to `core/dilla-core/src/sframe/ctr.rs`:

```rust
//! The CTR partition and the nonce (protocol/05-media-frames.md "Counter partition").

use super::NN;
use crate::error::ProtocolError;

/// `seq` must stay below 2^52. On exhaustion the sender rekeys through an MLS `Update` rather
/// than wrapping.
pub const MAX_SEQ: u64 = (1u64 << 52) - 1;

/// Which source a frame came from. `seq` restarts at 0 per `(KID, slot, layer)`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Slot {
    Microphone = 0,
    Camera = 1,
    ScreenVideo = 2,
    ScreenAudio = 3,
}

/// `slot(8) || layer(4) || seq(52)`, packed into one 64-bit counter.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Ctr(u64);

impl Ctr {
    /// `E_UNSUPPORTED_VERSION` on `layer > 0xf` or `seq > MAX_SEQ`: both mean the sender is
    /// speaking a media version this one does not implement, or has exhausted its counter and
    /// must rekey. protocol/05 names no dedicated code, so the media-version code carries it.
    pub fn new(slot: u8, layer: u8, seq: u64) -> Result<Self, ProtocolError> {
        if layer > 0xf || seq > MAX_SEQ {
            return Err(ProtocolError::UnsupportedVersion);
        }
        Ok(Self((u64::from(slot) << 56) | (u64::from(layer) << 52) | seq))
    }

    pub const fn from_raw(v: u64) -> Self {
        Self(v)
    }

    pub const fn value(self) -> u64 {
        self.0
    }

    pub const fn slot(self) -> u8 {
        (self.0 >> 56) as u8
    }

    pub const fn layer(self) -> u8 {
        ((self.0 >> 52) & 0xf) as u8
    }

    pub const fn seq(self) -> u64 {
        self.0 & MAX_SEQ
    }
}

/// `salt XOR CTR`, with CTR big-endian left-padded to 12 bytes (so it XORs into the low 8).
pub fn nonce(salt: &[u8; NN], ctr: Ctr) -> [u8; NN] {
    let mut out = *salt;
    let c = ctr.value().to_be_bytes();
    for (o, b) in out[NN - 8..].iter_mut().zip(c) {
        *o ^= b;
    }
    out
}
```

- [ ] **Step 5: Write the header codec**

Prepend to `core/dilla-core/src/sframe/header.rs`:

```rust
//! The SFrame header (RFC 9605 section 4.3, as cited by protocol/05-media-frames.md).
//!
//! ```text
//! config byte = (X << 7) | (K << 4) | (Y << 3) | C
//! ```
//! `X` is set when the KID does not fit in three bits; `K` then holds `len(KID) - 1` and the KID
//! bytes follow. `Y` and `C` are the same for the counter. When a value does fit, its field holds
//! the value itself and no extension bytes follow.

use super::{Ctr, Kid};
use crate::error::ProtocolError;

/// The minimum number of big-endian bytes `v` needs, at least 1.
const fn min_len(v: u64) -> usize {
    let mut len = 8;
    while len > 1 && (v >> ((len - 1) * 8)) == 0 {
        len -= 1;
    }
    len
}

fn push_be(out: &mut Vec<u8>, v: u64, len: usize) {
    let bytes = v.to_be_bytes();
    out.extend_from_slice(&bytes[8 - len..]);
}

pub fn encode_header(kid: Kid, ctr: Ctr) -> Vec<u8> {
    let k = kid.value();
    let c = ctr.value();
    let extended_kid = k > 7;
    let extended_ctr = c > 7;
    let klen = min_len(k);
    let clen = min_len(c);

    let kfield = if extended_kid { (klen - 1) as u8 } else { k as u8 };
    let cfield = if extended_ctr { (clen - 1) as u8 } else { c as u8 };
    let config = (u8::from(extended_kid) << 7) | (kfield << 4) | (u8::from(extended_ctr) << 3) | cfield;

    let mut out = Vec::with_capacity(1 + klen + clen);
    out.push(config);
    if extended_kid {
        push_be(&mut out, k, klen);
    }
    if extended_ctr {
        push_be(&mut out, c, clen);
    }
    out
}

fn read_be(bytes: &[u8], at: usize, len: usize) -> Result<u64, ProtocolError> {
    let end = at.checked_add(len).ok_or(ProtocolError::UnsupportedVersion)?;
    if end > bytes.len() {
        return Err(ProtocolError::UnsupportedVersion);
    }
    let mut v = 0u64;
    for b in &bytes[at..end] {
        v = (v << 8) | u64::from(*b);
    }
    Ok(v)
}

/// Returns the KID, the counter and the number of bytes the header occupied, so the caller can
/// step over it to the ciphertext. `E_UNSUPPORTED_VERSION` on a truncated header.
///
/// That code is protocol/01's group-version code, reused here because protocol/05 assigns none to
/// a malformed media header; the same is true of `Ctr::new`'s two failures. It is recorded as
/// "Needs verification" item 21: either protocol/05 gains media codes through
/// protocol/07-versioning.md's change process, or these three cases move to a non-wire
/// `sframe::SframeError`. Do not build DS or client behaviour on the current spelling.
pub fn decode_header(bytes: &[u8]) -> Result<(Kid, Ctr, usize), ProtocolError> {
    let config = *bytes.first().ok_or(ProtocolError::UnsupportedVersion)?;
    let extended_kid = config & 0x80 != 0;
    let kfield = (config >> 4) & 0x7;
    let extended_ctr = config & 0x08 != 0;
    let cfield = config & 0x07;

    let mut at = 1usize;
    let kid = if extended_kid {
        let len = usize::from(kfield) + 1;
        let v = read_be(bytes, at, len)?;
        at += len;
        v
    } else {
        u64::from(kfield)
    };
    let ctr = if extended_ctr {
        let len = usize::from(cfield) + 1;
        let v = read_be(bytes, at, len)?;
        at += len;
        v
    } else {
        u64::from(cfield)
    };
    Ok((Kid::from_raw(kid), Ctr::from_raw(ctr), at))
}
```

- [ ] **Step 6: Declare the module**

Add `pub mod sframe;` to `core/dilla-core/src/lib.rs`:

```rust
pub mod cbor;
pub mod envelope;
pub mod error;
pub mod identity;
pub mod ids;
pub mod sframe;
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --lib --locked
```

Expected: PASS, `test result: ok. 0 failed; 0 ignored` — the 42 unit tests from tasks 3 to 5 plus
the 11 written here, so 53 at the time this task was drafted. `0 failed` is the signal.

```bash
/home/thim/.cargo/bin/cargo clippy --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --all-targets --locked -- -D warnings
```

Expected: PASS with no warnings.

- [ ] **Step 8: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add core/dilla-core/src/sframe core/dilla-core/src/lib.rs && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(core): dilla-sframe/1 key schedule, counter partition and header codec'
```
---

### Task 7: Real Ed25519 signature vectors in `packages/protocol-vectors`

**Files:**
- Create: `packages/protocol-vectors/src/ed25519.ts`, `packages/protocol-vectors/src/ed25519.test.ts`
- Modify: `packages/protocol-vectors/src/identity.ts`, `packages/protocol-vectors/src/generate.ts`, `protocol/vectors/identity.json` (regenerated, never hand-edited), `protocol/vectors/README.md`, `protocol/03-identity.md` (gains `## Vectors`), `protocol/07-versioning.md` (change-table row)
- Test: `packages/protocol-vectors/src/ed25519.test.ts`, plus the existing `src/generate.test.ts` and `src/identity.test.ts`

**Interfaces:**
- Consumes: nothing from Rust. This task runs entirely in the TypeScript reference package.
- Produces: `identity.json` whose `credential_identity` carries **real** `sig_umk_ssk` and
  `sig_ssk_dev`, generated deterministically from fixed seeds, together with `umk_priv`, `ssk_priv`
  and `dsk_pub` so any implementation can reproduce both signatures. New exports:
  `ed25519.ts` — `keyFromSeed(seed: Uint8Array): Promise<Ed25519Key>` where
  `Ed25519Key = { privateKey: CryptoKey; publicKey: Uint8Array }`,
  `sign(key: CryptoKey, message: Uint8Array): Promise<Uint8Array>`,
  `verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>`;
  `identity.ts` — `sskMessage(sskPub: Uint8Array): Uint8Array`,
  `dskMessage(deviceId: Uint8Array, dskPub: Uint8Array, kind: number, tier: number, signerTier: number): Uint8Array`,
  and `CredentialFields.signerTier` widened to `0 | 1 | 2`.

Why this matters: today `identity.json`'s two signatures are filler bytes (`0x17` x 64 and `0x28`
x 64), so the vector checks the CBOR **layout** and nothing else — no implementation's Ed25519
verification is exercised by any committed vector (`facts-repo.md` §7 item 2). Task 8's Rust runner
and task 16's wasm runner both check these fields, so they have to be real first.

Constraints carried from the repository: the generator runs under
`node --experimental-strip-types`, which **cannot execute TypeScript `enum`** — use `const` objects
(`envelope.ts` says so in a comment). `npm run vectors` must be idempotent, because CI diffs
`protocol/vectors` after re-running it. Nothing under `protocol/` may contain `TBD`, `TODO`,
`FIXME` or `XXX`: `scripts/check-protocol-docs.mjs` scans the whole tree, `vectors/` included.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol-vectors/src/ed25519.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { keyFromSeed, sign, verify } from './ed25519.ts';
import { sskMessage, dskMessage } from './identity.ts';
import { fromHex, hex } from './bytes.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VECTORS_DIR } from './generate.ts';

describe('Ed25519 through WebCrypto', () => {
  it('derives the same key pair from the same seed every time', async () => {
    const a = await keyFromSeed(new Uint8Array(32).fill(0x41));
    const b = await keyFromSeed(new Uint8Array(32).fill(0x41));
    expect(hex(a.publicKey)).toBe(hex(b.publicKey));
    expect(a.publicKey).toHaveLength(32);

    const c = await keyFromSeed(new Uint8Array(32).fill(0x42));
    expect(hex(c.publicKey)).not.toBe(hex(a.publicKey));
  });

  it('produces 64-byte signatures that verify and that reject a flipped bit', async () => {
    const key = await keyFromSeed(new Uint8Array(32).fill(0x41));
    const message = new TextEncoder().encode('dilla');
    const sig = await sign(key.privateKey, message);
    expect(sig).toHaveLength(64);
    expect(await verify(key.publicKey, message, sig)).toBe(true);

    const bad = Uint8Array.from(sig);
    bad[0] ^= 0x01;
    expect(await verify(key.publicKey, message, bad)).toBe(false);
    expect(await verify(key.publicKey, new TextEncoder().encode('dillb'), sig)).toBe(false);
  });

  it('rejects a seed that is not 32 bytes', async () => {
    await expect(keyFromSeed(new Uint8Array(31))).rejects.toThrow();
  });
});

describe('committed identity vectors', () => {
  const doc = JSON.parse(readFileSync(join(VECTORS_DIR, 'identity.json'), 'utf8'));

  it('carries real signatures, not filler bytes', () => {
    const f = doc.credential_identity.fields;
    expect(f.sig_umk_ssk).not.toBe('17'.repeat(64));
    expect(f.sig_ssk_dev).not.toBe('28'.repeat(64));
    expect(f.sig_umk_ssk).toHaveLength(128);
    expect(f.sig_ssk_dev).toHaveLength(128);
  });

  it('carries the private material a verifier needs to reproduce both signatures', () => {
    expect(doc.credential_identity.umk_priv).toHaveLength(64);
    expect(doc.credential_identity.ssk_priv).toHaveLength(64);
    expect(doc.credential_identity.dsk_pub).toHaveLength(64);
  });

  it('verifies sig_umk_ssk against umk_pub over "dilla ssk v1" || ssk_pub', async () => {
    const f = doc.credential_identity.fields;
    expect(
      await verify(
        fromHex(f.umk_pub),
        sskMessage(fromHex(f.ssk_pub)),
        fromHex(f.sig_umk_ssk),
      ),
    ).toBe(true);
  });

  it('verifies sig_ssk_dev against ssk_pub over the dsk message', async () => {
    const f = doc.credential_identity.fields;
    expect(
      await verify(
        fromHex(f.ssk_pub),
        dskMessage(
          fromHex(f.device_id),
          fromHex(doc.credential_identity.dsk_pub),
          f.kind,
          f.tier,
          f.signer_tier,
        ),
        fromHex(f.sig_ssk_dev),
      ),
    ).toBe(true);
  });

  it('reproduces both signatures from the recorded private keys', async () => {
    const f = doc.credential_identity.fields;
    const umk = await keyFromSeed(fromHex(doc.credential_identity.umk_priv));
    const ssk = await keyFromSeed(fromHex(doc.credential_identity.ssk_priv));
    expect(hex(umk.publicKey)).toBe(f.umk_pub);
    expect(hex(ssk.publicKey)).toBe(f.ssk_pub);
    expect(hex(await sign(umk.privateKey, sskMessage(fromHex(f.ssk_pub))))).toBe(f.sig_umk_ssk);
    expect(
      hex(
        await sign(
          ssk.privateKey,
          dskMessage(
            fromHex(f.device_id),
            fromHex(doc.credential_identity.dsk_pub),
            f.kind,
            f.tier,
            f.signer_tier,
          ),
        ),
      ),
    ).toBe(f.sig_ssk_dev);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol test -w @dilla/protocol-vectors
```

Expected: FAIL — `Failed to resolve import "./ed25519.ts"`, and the committed-vector block reports
`expected '1717...' not to be '1717...'`.

- [ ] **Step 3: Confirm the runtime actually offers Ed25519 in WebCrypto**

Node's WebCrypto exposes Ed25519 under the algorithm name `"Ed25519"`, but that is a runtime
property of this box, not something any facts file in this plan's inputs records. Check it before
writing code against it:

```bash
node -e "crypto.subtle.generateKey({name:'Ed25519'}, true, ['sign','verify']).then(k => console.log('Ed25519 available:', k.privateKey.algorithm.name)).catch(e => { console.error('Ed25519 NOT available:', e.message); process.exit(1); })"
```

Expected: `Ed25519 available: Ed25519`. If it exits non-zero, stop: the remaining steps assume this
and there is no second implementation in the repository to fall back to. Record the observed Node
version alongside the result:
```bash
node --version
```

- [ ] **Step 4: Write the Ed25519 helper**

Create `packages/protocol-vectors/src/ed25519.ts`:

```ts
/**
 * Ed25519 through WebCrypto, seeded deterministically so the committed vectors are reproducible.
 *
 * WebCrypto has no "import a raw private key" path for Ed25519: a private key arrives as PKCS#8.
 * The PKCS#8 wrapper for an Ed25519 seed is a fixed 16-byte prefix followed by the 32-byte seed,
 * so a deterministic seed becomes a deterministic CryptoKey with no extra dependency.
 */

/** SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING (32) } } */
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export type Ed25519Key = { privateKey: CryptoKey; publicKey: Uint8Array };

function base64urlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(Buffer.from(padded, 'base64'));
}

export async function keyFromSeed(seed: Uint8Array): Promise<Ed25519Key> {
  if (seed.length !== 32) throw new Error(`Ed25519 seed must be 32 bytes, got ${seed.length}`);
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  if (typeof jwk.x !== 'string') throw new Error('Ed25519 JWK has no public component');
  return { privateKey, publicKey: base64urlToBytes(jwk.x) };
}

export async function sign(key: CryptoKey, message: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, message));
}

export async function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, true, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
}
```

- [ ] **Step 5: Export the two signing messages and widen `signerTier`**

In `packages/protocol-vectors/src/identity.ts`, change the `CredentialFields` type and add the two
message builders. Replace the final two declarations of the file with:

```ts
export type CredentialFields = { umkPub: Uint8Array; userId: Uint8Array; deviceId: Uint8Array; kind: 0 | 1; tier: 0 | 1; signerTier: 0 | 1 | 2; sskPub: Uint8Array; sigUmkSsk: Uint8Array; sigSskDev: Uint8Array };
export function credentialIdentity(f: CredentialFields): Uint8Array {
  return encode([1, f.umkPub, f.userId, f.deviceId, f.kind, f.tier, f.signerTier, f.sskPub, f.sigUmkSsk, f.sigSskDev]);
}

/** `"dilla ssk v1" || ssk_pub` - the message UMK_priv signs (03-identity.md "Keys"). */
export function sskMessage(sskPub: Uint8Array): Uint8Array {
  return concat(utf8('dilla ssk v1'), sskPub);
}

/**
 * `"dilla dsk v1" || device_id || dsk_pub || kind || tier || signer_tier` - the message SSK_priv
 * signs. The three trailing fields are one byte each, not CBOR.
 */
export function dskMessage(deviceId: Uint8Array, dskPub: Uint8Array, kind: number, tier: number, signerTier: number): Uint8Array {
  return concat(utf8('dilla dsk v1'), deviceId, dskPub, new Uint8Array([kind, tier, signerTier]));
}
```

`concat` and `utf8` are already imported at the top of the file; no import change is needed.

- [ ] **Step 6: Generate the real signatures**

In `packages/protocol-vectors/src/generate.ts`, add the import

```ts
import { keyFromSeed, sign } from './ed25519.ts';
```

and replace the whole `identityVectors` function with:

```ts
export async function identityVectors() {
  const umkA = fill(32, 0xa1), umkB = fill(32, 0xb2);
  const rk = fill(32, 0x0b);
  const keys = await deriveRecoveryKeys(rk);

  // Deterministic seeds. They are published in the vector file so any implementation can
  // reproduce both signatures; they are test material and protect nothing.
  const umkSeed = fill(32, 0x41);
  const sskSeed = fill(32, 0x42);
  const dskSeed = fill(32, 0x43);
  const umk = await keyFromSeed(umkSeed);
  const ssk = await keyFromSeed(sskSeed);
  const dsk = await keyFromSeed(dskSeed);

  const userId = fill(16, 0xd4), deviceId = fill(16, 0xe5);
  const kind = 0, tier = 1, signerTier = 0;
  const sigUmkSsk = await sign(umk.privateKey, sskMessage(ssk.publicKey));
  const sigSskDev = await sign(ssk.privateKey, dskMessage(deviceId, dsk.publicKey, kind, tier, signerTier));

  return {
    version: 1,
    description: 'safety number (60 digits), SAS (30 digits), recovery key encodings and derived keys, credential identity CBOR with real Ed25519 signatures (03-identity.md)',
    safety_number: { umk_a: hex(umkA), umk_b: hex(umkB), digits: await safetyNumber(umkA, umkB) },
    sas: { epoch_authenticator: hex(fill(32, 0xc3)), digits: sas(fill(32, 0xc3)) },
    recovery_key: { rk: hex(rk), base32: recoveryKeyBase32(rk), k_header: hex(keys.header), k_backup: hex(keys.archive) },
    credential_identity: {
      umk_priv: hex(umkSeed),
      ssk_priv: hex(sskSeed),
      dsk_priv: hex(dskSeed),
      dsk_pub: hex(dsk.publicKey),
      fields: {
        umk_pub: hex(umk.publicKey), user_id: hex(userId), device_id: hex(deviceId),
        kind, tier, signer_tier: signerTier, ssk_pub: hex(ssk.publicKey),
        sig_umk_ssk: hex(sigUmkSsk), sig_ssk_dev: hex(sigSskDev),
      },
      cbor: hex(credentialIdentity({
        umkPub: umk.publicKey, userId, deviceId, kind, tier, signerTier,
        sskPub: ssk.publicKey, sigUmkSsk, sigSskDev,
      })),
    },
  };
}
```

and extend the `identity.ts` import line at the top of `generate.ts` to bring in the two message
builders:

```ts
import { safetyNumber, sas, recoveryKeyBase32, deriveRecoveryKeys, credentialIdentity, sskMessage, dskMessage } from './identity.ts';
```

`safety_number` and `sas` are deliberately untouched: their inputs are raw 32-byte patterns, not
public keys, so their digits do not move and the diff stays confined to `credential_identity`.

- [ ] **Step 7: Regenerate the vectors and check idempotence**

```bash
npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run vectors
```

Expected: `vectors written to …/protocol/vectors`.

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol diff --stat -- protocol/vectors
```

Expected: only `protocol/vectors/identity.json` changed.

```bash
npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run vectors
```

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol diff --stat -- protocol/vectors
```

Expected: identical to the previous `diff --stat` — a second run changes nothing, which is what
CI's `git diff --exit-code -- protocol/vectors` gate requires.

- [ ] **Step 8: Document the vectors in the normative files**

Add a `## Vectors` section to `protocol/03-identity.md`, immediately **before** the existing
`## Error codes` heading:

```markdown
## Vectors

`vectors/identity.json`. An implementation conforms when it reproduces `safety_number.digits`,
`sas.digits`, `recovery_key.base32`, `recovery_key.k_header`, `recovery_key.k_backup` and
`credential_identity.cbor`, and when it verifies `credential_identity.fields.sig_umk_ssk` against
`umk_pub` over `"dilla ssk v1" || ssk_pub`, and `sig_ssk_dev` against `ssk_pub` over
`"dilla dsk v1" || device_id || dsk_pub || kind || tier || signer_tier`.

`credential_identity` also carries `umk_priv`, `ssk_priv`, `dsk_priv` and `dsk_pub`. Those are
Ed25519 seeds chosen so the file is reproducible from a fixed input; they are test material and
protect nothing. `dsk_pub` is published because it is covered by `sig_ssk_dev` but is not itself a
field of the credential array: a verifier takes it from the MLS leaf's `signature_key`.
```

Make the new section enforceable — `scripts/check-protocol-docs.mjs` only checks the headings it
lists, so without this the section can be deleted later and `npm run check:docs` still passes. In
`scripts/check-protocol-docs.mjs`, extend the `'03-identity.md'` entry of `REQUIRED` with
`'## Vectors'`, keeping the array in the document's heading order:

```js
  '03-identity.md': ['## Keys', '## Credential', '## Device list', '## Custody by tier', '## Pairing', '## Recovery', '## Safety number', '## Vectors'],
```

Update the `identity.json` row of `protocol/vectors/README.md` so the table states what is now
checked:

```markdown
| `identity.json` | `03-identity.md` | `safety_number.digits`, `sas.digits`, `recovery_key.base32`, `k_header`, `k_backup`, `credential_identity.cbor`, and both Ed25519 signatures |
```

Add a row to the change table at the end of `protocol/07-versioning.md`:

```markdown
| 2026-09-23 | e2ee 1, media 1, wire 1 | `identity.json` gains real Ed25519 credential signatures and the seeds that reproduce them; no format change, so no version bump |
```

`CONTRIBUTING.md` "Protocol changes" asks for a version bump on any change under `protocol/`, and the
maintainer has ruled that this change is not one. **Record the ruling in the commit body — do not
argue it in the pull request.** The reasoning, in the commit body verbatim: *the credential array is
byte-for-byte the same shape it was; only filler bytes became real signatures, and
`credential_identity` gained the seeds that reproduce them. No wire format, field order, length or
domain string changed, so `e2ee_version` stays at 1. Adding a `## Vectors` section to a document that
has none is not a format change either, and the identity chain is in any case still **unfrozen**: the
spec's freeze rule is "formats freeze one week after their end-to-end scenario passes"
(`docs/superpowers/specs/2026-09-23-dilla-design.md:637`, with the credential chain's scenario due at
the end of W3, line 408), so protocol/07's change process does not bind this file yet.*

- [ ] **Step 9: Run the tests to verify they pass**

```bash
npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol test -w @dilla/protocol-vectors
```

Expected: PASS — 8 test files now (the 7 that existed plus `ed25519.test.ts`), every test green,
including the pre-existing `generate.test.ts` assertion that the committed `identity.json` is
byte-identical to the generator's output.

```bash
npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run check:docs
```

Expected: PASS — no placeholder text anywhere under `protocol/`.

```bash
npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run test:docs-check
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add packages/protocol-vectors/src protocol/vectors/identity.json protocol/vectors/README.md protocol/03-identity.md protocol/07-versioning.md scripts/check-protocol-docs.mjs && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(protocol-vectors): generate real Ed25519 credential signatures'
```

---

### Task 8: Native `vectors_check` runner

**Files:**
- Create: `core/dilla-core/src/vectors/mod.rs`, `core/dilla-core/src/vectors/report.rs`
- Modify: `core/dilla-core/src/lib.rs` (add the feature-gated `pub mod vectors;`)
- Test: `core/dilla-core/tests/vectors_native.rs`

**Interfaces:**
- Consumes: `cbor`, `identity`, `envelope`, `sframe`, and task 7's regenerated `identity.json`.
- Produces, all under `vectors::` (feature `vectors`):
  `ENVELOPE_JSON`, `FRANKING_JSON`, `SFRAME_JSON`, `IDENTITY_JSON` (each `&'static str`);
  `CaseReport { case: String, field: &'static str, ok: bool, expected: String, actual: String }`;
  `SuiteReport { name: &'static str, cases: Vec<CaseReport> }`;
  `VectorReport { suites: Vec<SuiteReport>, passed: u32, failed: u32 }` with
  `is_ok(&self) -> bool`, `to_text(&self) -> String`, `encode(&self) -> Vec<u8>`;
  `run_envelope()`, `run_franking()`, `run_sframe()`, `run_identity()`, `run_rejects()` each
  `-> SuiteReport`, and `run_all() -> VectorReport`.

Two constraints that shape the design:

- The JSON is embedded with `include_str!`. `std::fs` always errors on `wasm32-unknown-unknown`
  (gap-26 §1), so this is the only shape that compiles for all three targets, and the same module
  is what task 14's `vectors_check` export and task 16's Node test drive.
- `kid` and `ctr` in `sframe.json`, and any integer above 2^53, are **decimal strings**
  (`protocol/vectors/README.md`). The parser accepts a JSON number or a decimal string for every
  integer, so a future regeneration that changes the spelling cannot silently skip a field.

- [ ] **Step 1: Write the failing test**

Create `core/dilla-core/tests/vectors_native.rs`:

```rust
//! The native leg of the cross-target conformance triangle. The other two are
//! `cargo test -p dilla-core --target wasm32-unknown-unknown` (task 16) and the Go wazero test
//! (Plan B task 4); all three drive this same module.

use dilla_core::cbor::decode_strict;
use dilla_core::vectors::{run_all, run_envelope, run_franking, run_identity, run_rejects, run_sframe};

#[test]
fn every_suite_passes() {
    let report = run_all();
    assert!(report.is_ok(), "{}", report.to_text());
    assert_eq!(report.failed, 0);
    assert!(report.passed > 0);
    assert_eq!(report.suites.len(), 5);
}

#[test]
fn each_suite_reports_the_expected_number_of_cases() {
    // 4 envelope cases x 3 fields; 3 franking cases x 1 field; 4 sframe cases x 6 fields;
    // 8 identity cases (5 identity fields, the credential CBOR, and the two credential signatures
    // checked separately - interfaces.md section 2.9); the reject corpus.
    assert_eq!(run_envelope().cases.len(), 12);
    assert_eq!(run_franking().cases.len(), 3);
    assert_eq!(run_sframe().cases.len(), 24);
    assert_eq!(run_identity().cases.len(), 8);
    assert!(run_rejects().cases.len() >= 25);
    for suite in [run_envelope(), run_franking(), run_sframe(), run_identity(), run_rejects()] {
        for case in &suite.cases {
            assert!(case.ok, "{}: {} expected {} got {}", suite.name, case.case, case.expected, case.actual);
        }
    }
}

#[test]
fn the_report_encodes_as_deterministic_cbor_and_decodes_back() {
    let report = run_all();
    let bytes = report.encode();
    let decoded = decode_strict(&bytes, |d| {
        d.array(3)?;
        let passed = d.uint()?;
        let failed = d.uint()?;
        let suites = d.array_len()?;
        let mut names = Vec::with_capacity(suites);
        for _ in 0..suites {
            d.array(2)?;
            names.push(d.text()?.to_owned());
            let cases = d.array_len()?;
            for _ in 0..cases {
                d.array(5)?;
                let _case = d.text()?;
                let _field = d.text()?;
                let ok = d.uint()?;
                assert!(ok <= 1, "ok is encoded as 0 or 1");
                let _expected = d.text()?;
                let _actual = d.text()?;
            }
        }
        Ok((passed, failed, names))
    })
    .expect("the report must be strict deterministic CBOR");

    assert_eq!(decoded.0, u64::from(report.passed));
    assert_eq!(decoded.1, u64::from(report.failed));
    assert_eq!(decoded.2, vec!["envelope", "franking", "sframe", "identity", "rejects"]);
}

#[test]
fn a_corrupted_case_makes_the_report_fail() {
    let mut report = run_all();
    assert!(report.is_ok());
    report.suites[0].cases[0].ok = false;
    report.failed += 1;
    report.passed -= 1;
    assert!(!report.is_ok());
    assert!(report.to_text().contains("FAIL"));
}

#[test]
fn to_text_names_every_suite() {
    let text = run_all().to_text();
    for name in ["envelope", "franking", "sframe", "identity", "rejects"] {
        assert!(text.contains(name), "{text}");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --features vectors --test vectors_native --locked
```

Expected: FAIL with `error[E0432]: unresolved import dilla_core::vectors`.

- [ ] **Step 3: Write the report types**

Create `core/dilla-core/src/vectors/report.rs`:

```rust
//! The report shape every target returns: native as a Rust value, wasm32-unknown-unknown as JSON
//! over wasm-bindgen, wasm32-wasip1 as the CBOR body of the `vectors_check` ABI response.

use crate::cbor::Encoder;

/// One checked field of one case.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CaseReport {
    pub case: String,
    pub field: &'static str,
    pub ok: bool,
    pub expected: String,
    pub actual: String,
}

impl CaseReport {
    pub(crate) fn compare(
        case: impl Into<String>,
        field: &'static str,
        expected: impl Into<String>,
        actual: impl Into<String>,
    ) -> Self {
        let (expected, actual) = (expected.into(), actual.into());
        Self { case: case.into(), field, ok: expected == actual, expected, actual }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SuiteReport {
    pub name: &'static str,
    pub cases: Vec<CaseReport>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct VectorReport {
    pub suites: Vec<SuiteReport>,
    pub passed: u32,
    pub failed: u32,
}

impl VectorReport {
    pub(crate) fn from_suites(suites: Vec<SuiteReport>) -> Self {
        let mut passed = 0u32;
        let mut failed = 0u32;
        for suite in &suites {
            for case in &suite.cases {
                if case.ok {
                    passed += 1;
                } else {
                    failed += 1;
                }
            }
        }
        Self { suites, passed, failed }
    }

    pub fn is_ok(&self) -> bool {
        self.failed == 0
    }

    pub fn to_text(&self) -> String {
        let mut out = String::new();
        for suite in &self.suites {
            let failed = suite.cases.iter().filter(|c| !c.ok).count();
            out.push_str(&format!(
                "{}: {} case(s), {} failed\n",
                suite.name,
                suite.cases.len(),
                failed
            ));
            for case in suite.cases.iter().filter(|c| !c.ok) {
                out.push_str(&format!(
                    "  FAIL {} {}: expected {} got {}\n",
                    case.case, case.field, case.expected, case.actual
                ));
            }
        }
        out.push_str(&format!("passed {} failed {}\n", self.passed, self.failed));
        out
    }

    /// `[passed, failed, [[suite_name, [[case, field, ok, expected, actual], ...]], ...]]`,
    /// with `ok` as 0 or 1. This is the body of the wasi `vectors_check` response.
    pub fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::with_capacity(4096);
        e.array(3).uint(u64::from(self.passed)).uint(u64::from(self.failed));
        e.array(self.suites.len());
        for suite in &self.suites {
            e.array(2).text(suite.name);
            e.array(suite.cases.len());
            for case in &suite.cases {
                e.array(5)
                    .text(&case.case)
                    .text(case.field)
                    .uint(u64::from(case.ok))
                    .text(&case.expected)
                    .text(&case.actual);
            }
        }
        e.into_vec()
    }
}
```

- [ ] **Step 4: Write the runner**

Create `core/dilla-core/src/vectors/mod.rs`:

```rust
//! The cross-target conformance runner.
//!
//! The four vector files are embedded with `include_str!` rather than read from disk: `std::fs`
//! always errors on `wasm32-unknown-unknown`, so this is the only shape that compiles for native,
//! wasm32-unknown-unknown and wasm32-wasip1 alike. The same functions back the wasi
//! `vectors_check` export and the Node test, which is what stops the three builds diverging.

mod report;

pub use report::{CaseReport, SuiteReport, VectorReport};

use crate::cbor::decode_strict;
use crate::envelope::{
    franking_tag, Attachment, Envelope, EnvelopeType, FrankingTagInput, Preview,
};
use crate::identity::{
    k_backup, k_header, recovery_key_base32, safety_number, sas, CredentialIdentity, Kind,
    SignerTier, Tier,
};
use crate::ids::{DeviceId, MsgId, UserId};
use crate::sframe::{derive_keys, encode_header, nonce, Ctr, Kid, NK};
use serde_json::Value;

pub const ENVELOPE_JSON: &str = include_str!("../../../../protocol/vectors/envelope.json");
pub const FRANKING_JSON: &str = include_str!("../../../../protocol/vectors/franking.json");
pub const SFRAME_JSON: &str = include_str!("../../../../protocol/vectors/sframe.json");
pub const IDENTITY_JSON: &str = include_str!("../../../../protocol/vectors/identity.json");

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap_or(0))
        .collect()
}

fn unhex_n<const N: usize>(s: &str) -> [u8; N] {
    let v = unhex(s);
    let mut out = [0u8; N];
    let n = v.len().min(N);
    out[..n].copy_from_slice(&v[..n]);
    out
}

/// Integers above 2^53 are decimal strings in the vector files; small ones may be either.
fn int(v: &Value) -> u64 {
    match v {
        Value::String(s) => s.parse().unwrap_or(0),
        other => other.as_u64().unwrap_or(0),
    }
}

/// The **expected** side of a comparison, read out of the vector file.
///
/// A missing or renamed JSON key yields this sentinel rather than `""`, so it can never compare
/// equal to a defaulted actual value: `expected: ""` against an `encode()` that failed and
/// defaulted to an empty vector is two faults reporting `ok: true`. Nothing the runner computes
/// can produce this string, so an absent field is always a failed case. Input-side accessors keep
/// their `unwrap_or("")`: a missing input produces a wrong actual, which then fails against the
/// real expected value.
const MISSING: &str = "<missing field>";

fn expect_str(v: &Value) -> &str {
    v.as_str().unwrap_or(MISSING)
}

/// The expected side of an integer comparison, as a decimal string. Missing is a failure, not 0.
fn expect_int(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => MISSING.to_owned(),
    }
}

/// Ed25519 verification for the two credential signatures, checked one field at a time so a
/// failure names which signature broke (interfaces.md section 2.9). `verify_strict` is the same
/// check `CredentialIdentity::verify_signatures` performs over both at once.
/// NEEDS VERIFICATION item 2: `Signature::from_bytes(&[u8; 64])`'s exact spelling.
fn ed25519_verifies(public: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    use ed25519_dalek::{Signature, VerifyingKey};
    VerifyingKey::from_bytes(public)
        .map(|k| k.verify_strict(message, &Signature::from_bytes(signature)).is_ok())
        .unwrap_or(false)
}

fn opt_msg_id(v: &Value) -> Option<MsgId> {
    v.as_str().map(|s| MsgId::from_bytes(unhex_n::<16>(s)))
}

fn envelope_from_json(j: &Value) -> Envelope {
    Envelope {
        v: int(&j["v"]),
        msg_id: MsgId::from_bytes(unhex_n::<16>(j["msgId"].as_str().unwrap_or(""))),
        kind: EnvelopeType::from_u64(int(&j["type"])).unwrap_or(EnvelopeType::Message),
        thread_id: opt_msg_id(&j["threadId"]),
        reply_to: opt_msg_id(&j["replyTo"]),
        body: j["body"].as_str().unwrap_or("").to_owned(),
        attachments: j["attachments"]
            .as_array()
            .map(|xs| {
                xs.iter()
                    .map(|a| Attachment {
                        blob_id: unhex_n::<32>(a["blobId"].as_str().unwrap_or("")),
                        key: unhex_n::<32>(a["key"].as_str().unwrap_or("")),
                        nonce: unhex_n::<12>(a["nonce"].as_str().unwrap_or("")),
                        size: int(&a["size"]),
                        mime: a["mime"].as_str().unwrap_or("").to_owned(),
                        w: a["w"].as_u64(),
                        h: a["h"].as_u64(),
                        thumb: a["thumb"].as_str().map(unhex),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        previews: j["previews"]
            .as_array()
            .map(|xs| {
                xs.iter()
                    .map(|p| Preview {
                        url: p["url"].as_str().unwrap_or("").to_owned(),
                        title: p["title"].as_str().unwrap_or("").to_owned(),
                        description: p["description"].as_str().unwrap_or("").to_owned(),
                        image: p["image"].as_str().map(unhex),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        k_f: unhex_n::<32>(j["kf"].as_str().unwrap_or("")),
    }
}

pub fn run_envelope() -> SuiteReport {
    let mut cases = Vec::new();
    let doc: Value = serde_json::from_str(ENVELOPE_JSON).unwrap_or(Value::Null);
    for case in doc["cases"].as_array().unwrap_or(&Vec::new()) {
        let name = case["name"].as_str().unwrap_or("?").to_owned();
        let env = envelope_from_json(&case["envelope"]);
        let bytes = env.encode().unwrap_or_default();
        cases.push(CaseReport::compare(
            name.clone(),
            "cbor",
            expect_str(&case["cbor"]),
            hex(&bytes),
        ));
        cases.push(CaseReport::compare(
            name.clone(),
            "length",
            expect_int(&case["length"]),
            bytes.len().to_string(),
        ));
        cases.push(CaseReport::compare(
            name,
            "commitment",
            expect_str(&case["commitment"]),
            hex(&env.commitment().unwrap_or_default()),
        ));
    }
    SuiteReport { name: "envelope", cases }
}

pub fn run_franking() -> SuiteReport {
    let mut cases = Vec::new();
    let doc: Value = serde_json::from_str(FRANKING_JSON).unwrap_or(Value::Null);
    let k_frank = unhex_n::<32>(doc["instance_franking_key"].as_str().unwrap_or(""));
    for (i, case) in doc["cases"].as_array().unwrap_or(&Vec::new()).iter().enumerate() {
        let input = FrankingTagInput {
            group_id: unhex_n::<16>(case["group_id"].as_str().unwrap_or("")),
            epoch: int(&case["epoch"]),
            seq: int(&case["seq"]),
            uploader_device: DeviceId::from_bytes(unhex_n::<16>(
                case["uploader_device"].as_str().unwrap_or(""),
            )),
            commitment: unhex_n::<32>(case["commitment"].as_str().unwrap_or("")),
            recv_ts: int(&case["recv_ts"]),
        };
        cases.push(CaseReport::compare(
            format!("case {i}"),
            "tag",
            expect_str(&case["tag"]),
            hex(&franking_tag(&k_frank, &input)),
        ));
    }
    SuiteReport { name: "franking", cases }
}

pub fn run_sframe() -> SuiteReport {
    let mut cases = Vec::new();
    let doc: Value = serde_json::from_str(SFRAME_JSON).unwrap_or(Value::Null);
    let base_key = unhex_n::<NK>(doc["base_key"].as_str().unwrap_or(""));
    for case in doc["cases"].as_array().unwrap_or(&Vec::new()) {
        let leaf = u16::try_from(int(&case["leaf_index"])).unwrap_or(0);
        let epoch = int(&case["epoch"]);
        let name = format!("leaf {leaf} epoch {epoch}");
        let kid = Kid::new(leaf, epoch);
        cases.push(CaseReport::compare(
            name.clone(),
            "kid",
            expect_int(&case["kid"]),
            kid.value().to_string(),
        ));
        let keys = derive_keys(&base_key, kid);
        cases.push(CaseReport::compare(
            name.clone(),
            "key",
            expect_str(&case["key"]),
            hex(&keys.key),
        ));
        cases.push(CaseReport::compare(
            name.clone(),
            "salt",
            expect_str(&case["salt"]),
            hex(&keys.salt),
        ));
        let ctr = Ctr::new(
            u8::try_from(int(&case["slot"])).unwrap_or(0),
            u8::try_from(int(&case["layer"])).unwrap_or(0),
            int(&case["seq"]),
        )
        .unwrap_or(Ctr::from_raw(0));
        cases.push(CaseReport::compare(
            name.clone(),
            "ctr",
            expect_int(&case["ctr"]),
            ctr.value().to_string(),
        ));
        cases.push(CaseReport::compare(
            name.clone(),
            "nonce",
            expect_str(&case["nonce"]),
            hex(&nonce(&keys.salt, ctr)),
        ));
        cases.push(CaseReport::compare(
            name,
            "header",
            expect_str(&case["header"]),
            hex(&encode_header(kid, ctr)),
        ));
    }
    SuiteReport { name: "sframe", cases }
}

pub fn run_identity() -> SuiteReport {
    let mut cases = Vec::new();
    let doc: Value = serde_json::from_str(IDENTITY_JSON).unwrap_or(Value::Null);

    let sn = &doc["safety_number"];
    cases.push(CaseReport::compare(
        "safety_number",
        "digits",
        expect_str(&sn["digits"]),
        safety_number(
            &unhex_n::<32>(sn["umk_a"].as_str().unwrap_or("")),
            &unhex_n::<32>(sn["umk_b"].as_str().unwrap_or("")),
        ),
    ));

    let s = &doc["sas"];
    cases.push(CaseReport::compare(
        "sas",
        "digits",
        expect_str(&s["digits"]),
        sas(&unhex_n::<32>(s["epoch_authenticator"].as_str().unwrap_or(""))),
    ));

    let r = &doc["recovery_key"];
    let rk = unhex_n::<32>(r["rk"].as_str().unwrap_or(""));
    cases.push(CaseReport::compare(
        "recovery_key",
        "base32",
        expect_str(&r["base32"]),
        recovery_key_base32(&rk),
    ));
    cases.push(CaseReport::compare(
        "recovery_key",
        "k_header",
        expect_str(&r["k_header"]),
        hex(&k_header(&rk)),
    ));
    cases.push(CaseReport::compare(
        "recovery_key",
        "k_backup",
        expect_str(&r["k_backup"]),
        hex(&k_backup(&rk)),
    ));

    let ci = &doc["credential_identity"];
    let f = &ci["fields"];
    let credential = CredentialIdentity {
        v: 1,
        umk_pub: unhex_n::<32>(f["umk_pub"].as_str().unwrap_or("")),
        user_id: UserId::from_bytes(unhex_n::<16>(f["user_id"].as_str().unwrap_or(""))),
        device_id: DeviceId::from_bytes(unhex_n::<16>(f["device_id"].as_str().unwrap_or(""))),
        kind: Kind::from_u64(int(&f["kind"])).unwrap_or(Kind::User),
        tier: Tier::from_u64(int(&f["tier"])).unwrap_or(Tier::Native),
        signer_tier: SignerTier::from_u64(int(&f["signer_tier"])).unwrap_or(SignerTier::Native),
        ssk_pub: unhex_n::<32>(f["ssk_pub"].as_str().unwrap_or("")),
        sig_umk_ssk: unhex_n::<64>(f["sig_umk_ssk"].as_str().unwrap_or("")),
        sig_ssk_dev: unhex_n::<64>(f["sig_ssk_dev"].as_str().unwrap_or("")),
    };
    cases.push(CaseReport::compare(
        "credential_identity",
        "cbor",
        expect_str(&ci["cbor"]),
        hex(&credential.encode()),
    ));
    // Task 7 put real signatures and the leaf key in the file, so both are verifiable here.
    // They are two cases, not one: interfaces.md section 2.9 lists `sig_umk_ssk` and `sig_ssk_dev`
    // as separate fields of the identity suite, and a single "signatures" case cannot say which of
    // the two broke.
    let dsk_pub = unhex_n::<32>(ci["dsk_pub"].as_str().unwrap_or(""));
    cases.push(CaseReport::compare(
        "credential_identity",
        "sig_umk_ssk",
        "verified",
        if ed25519_verifies(
            &credential.umk_pub,
            &CredentialIdentity::ssk_message(&credential.ssk_pub),
            &credential.sig_umk_ssk,
        ) {
            "verified"
        } else {
            "rejected"
        },
    ));
    cases.push(CaseReport::compare(
        "credential_identity",
        "sig_ssk_dev",
        "verified",
        if ed25519_verifies(
            &credential.ssk_pub,
            &CredentialIdentity::dsk_message(
                &credential.device_id,
                &dsk_pub,
                credential.kind,
                credential.tier,
                credential.signer_tier,
            ),
            &credential.sig_ssk_dev,
        ) {
            "verified"
        } else {
            "rejected"
        },
    ));
    // The chain as a whole, through the production entry point, must agree with the two field
    // checks above.
    debug_assert_eq!(
        credential.verify_signatures(&dsk_pub).is_ok(),
        cases[cases.len() - 2].ok && cases[cases.len() - 1].ok
    );

    SuiteReport { name: "identity", cases }
}

/// Every input protocol/04 says a receiver must reject, plus the deterministic-CBOR reject corpus.
/// A case passes when the decoder **refuses** the input.
pub fn run_rejects() -> SuiteReport {
    let mut cases = Vec::new();
    let mut expect_cbor_reject = |name: &str, hex_input: &str| {
        let bytes = unhex(hex_input);
        let refused = decode_strict(&bytes, |d| d.skip().map(|_| ())).is_err();
        cases.push(CaseReport::compare(
            format!("{name} ({hex_input})"),
            "cbor",
            "rejected",
            if refused { "rejected" } else { "accepted" },
        ));
    };

    for (name, input) in [
        ("non-minimal uint", "1801"),
        ("non-minimal uint", "1817"),
        ("non-minimal uint", "190017"),
        ("non-minimal uint", "1a00000017"),
        ("non-minimal uint", "1b0000000000000017"),
        ("non-minimal uint", "1900ff"),
        ("non-minimal length", "5800"),
        ("non-minimal length", "7800"),
        ("non-minimal length", "9800"),
        ("non-minimal length", "990003010203"),
        ("indefinite array", "9f01ff"),
        ("indefinite bstr", "5f41014102ff"),
        ("indefinite text", "7f6161ff"),
        ("indefinite map", "bf0101ff"),
        ("map", "a0"),
        ("map", "a10102"),
        ("tag", "c11a514b67b0"),
        ("tag", "d8ff01"),
        ("tag", "c001"),
        ("float64", "fb3ff0000000000000"),
        ("float16", "f93c00"),
        ("negative", "20"),
        ("undefined", "f7"),
        ("non-minimal null", "f816"),
        ("reserved ai", "1c"),
        ("reserved ai", "1d"),
        ("reserved ai", "1e"),
        ("trailing bytes", "0101"),
        ("trailing bytes", "01a0"),
        ("trailing bytes", "83010203ff"),
        ("trailing bytes", "83010203ffffffff"),
        ("truncated bstr", "5820"),
        ("invalid utf-8", "6263c3"),
    ] {
        expect_cbor_reject(name, input);
    }

    // protocol/04's envelope reject list, exercised through Envelope::decode.
    let doc: Value = serde_json::from_str(ENVELOPE_JSON).unwrap_or(Value::Null);
    let env = envelope_from_json(&doc["cases"][0]["envelope"]);
    let good = env.encode().unwrap_or_default();

    let mut wrong_count = good.clone();
    if !wrong_count.is_empty() {
        wrong_count[0] = 0x88;
    }
    let mut unknown_type = good.clone();
    if unknown_type.len() > 19 {
        unknown_type[19] = 0x07;
    }
    let mut trailing = good.clone();
    trailing.push(0x00);

    for (name, bytes) in [
        ("wrong element count", wrong_count),
        ("unknown type", unknown_type),
        ("trailing bytes", trailing),
    ] {
        let refused = Envelope::decode(&bytes).is_err();
        cases.push(CaseReport::compare(
            format!("envelope {name}"),
            "decode",
            "rejected",
            if refused { "rejected" } else { "accepted" },
        ));
    }

    let mut over_limit = env.clone();
    over_limit.body = "a".repeat(crate::envelope::MAX_BODY_LONG + 1);
    cases.push(CaseReport::compare(
        "envelope body over 4000 bytes",
        "validate",
        "rejected",
        if over_limit.validate().is_err() { "rejected" } else { "accepted" },
    ));

    let mut short_body = env.clone();
    short_body.kind = EnvelopeType::ReactionAdd;
    short_body.body = "a".repeat(crate::envelope::MAX_BODY_SHORT + 1);
    cases.push(CaseReport::compare(
        "reaction body over 32 bytes",
        "validate",
        "rejected",
        if short_body.validate().is_err() { "rejected" } else { "accepted" },
    ));

    let mut bad_aad = env;
    bad_aad.k_f = [0x00; 32];
    cases.push(CaseReport::compare(
        "authenticated_data not 32 bytes",
        "verify_commitment",
        "rejected",
        if bad_aad.verify_commitment(&[0u8; 31]).is_err() { "rejected" } else { "accepted" },
    ));

    SuiteReport { name: "rejects", cases }
}

pub fn run_all() -> VectorReport {
    VectorReport::from_suites(vec![
        run_envelope(),
        run_franking(),
        run_sframe(),
        run_identity(),
        run_rejects(),
    ])
}
```

- [ ] **Step 5: Declare the module**

Add the feature-gated declaration to `core/dilla-core/src/lib.rs`:

```rust
#[cfg(feature = "vectors")]
pub mod vectors;
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --features vectors --test vectors_native --locked
```

Expected: PASS, `test result: ok. 5 passed; 0 failed`.

Then prove the module compiles for both wasm targets, which is the whole point of `include_str!`:

```bash
/home/thim/.cargo/bin/cargo build --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --features vectors --target wasm32-unknown-unknown --locked
```

Expected: PASS.

```bash
/home/thim/.cargo/bin/cargo build --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --features vectors --target wasm32-wasip1 --locked
```

Expected: PASS.

```bash
/home/thim/.cargo/bin/cargo clippy --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --all-targets --all-features --locked -- -D warnings
```

Expected: PASS with no warnings.

- [ ] **Step 7: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add core/dilla-core/src/vectors core/dilla-core/src/lib.rs core/dilla-core/tests/vectors_native.rs && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(core): cross-target conformance vector runner'
```
---

### Task 9: MLS provider and the custom SQLite `StorageProvider`

**Files:**
- Create: `core/dilla-core/src/mls/mod.rs`, `core/dilla-core/src/mls/provider.rs`, `core/dilla-core/src/mls/storage.rs`, `core/dilla-core/src/mls/tx.rs`
- Modify: `core/dilla-core/src/lib.rs` (add `pub mod mls;`), `core/dilla-core/src/error.rs` (add the `Storage` variant to `CoreError`), `core/dilla-core/Cargo.toml` (add the `trybuild` dev-dependency)
- Test: unit tests inside `storage.rs` and `tx.rs`, plus `core/dilla-core/tests/coherence.rs` and `core/dilla-core/tests/coherence/both_traits.rs`

`core/dilla-core/tests/coherence.rs` and `tests/coherence/both_traits.rs` (and the
`both_traits.stderr` step 7 generates) are **additions to interfaces §1**, whose `tests/` list is
`{vectors_native, cbor_reject, mls_roundtrip}.rs`. §6's own task-9 test list requires "a `trybuild`
compile-fail test", which needs these files; recorded here rather than invented silently.

**Interfaces:**
- Consumes: `cbor` (for nothing but the crate's own formats — the storage blobs use `ciborium`, deviation A1-5), `error::{CoreError, ProtocolError}`.
- Produces, all under `mls::`:
  `ConnHandle` (`Arc<Mutex<rusqlite::Connection>>` natively, `Rc<RefCell<rusqlite::Connection>>` on `wasm32`);
  `StorageError { Sqlite(String), Codec(String), Poisoned }`;
  `DillaCodec` (trait: `type Error`, `to_vec<T: Serialize>`, `from_slice<T: DeserializeOwned>`);
  `CborCodec` (unit struct implementing it), `CodecError { Serialize(String), Deserialize(String) }`;
  `DillaStorage` with `new(ConnHandle) -> Self`, `conn(&self) -> &ConnHandle`, `migrate(&self) -> Result<(), StorageError>`, `storage_meta(&self, &str) -> Result<Option<String>, StorageError>`, `transaction<T, E: From<StorageError>>(&self, impl FnOnce() -> Result<T, E>) -> Result<T, TxError<E>>`, and `impl openmls_traits::storage::StorageProvider<CURRENT_VERSION> for DillaStorage { type Error = StorageError; }` (all 53 methods);
  `TxError<E> { Begin(StorageError), Commit(StorageError), RolledBack(E), RollbackFailed { cause: String, rollback: StorageError } }`;
  `DillaProvider` with `new(ConnHandle) -> Self`, `storage(&self) -> &DillaStorage`, implementing `openmls::storage::OpenMlsProvider` with `CryptoProvider = RandProvider = openmls_rust_crypto::RustCrypto` and `StorageProvider = DillaStorage`.

Three facts that decide the design, each verified:

1. **OpenMLS 0.9.0 requires a self-describing serde format.** Upstream says so in the release
   notes, the migration chapter and the `deserialize_any` path in `MlsGroupJoinConfig` (gap-6 §2).
   `postcard` and `bincode` are disqualified outright, and the failure mode is invisible until a
   **reload**, not at write time (gap-6 §2.3) — which is why the test below reopens the connection.
2. **The trait has no transaction hook.** OpenMLS calls a sequence of `write_*` methods inside
   `merge_staged_commit` (up to 15 writes) with no `begin`/`commit` and no `flush` (gap-7 §1.1,
   §2.1). dilla owns the `Connection` and wraps `BEGIN IMMEDIATE … COMMIT` around the OpenMLS call
   **from outside** the provider (R12).
3. **Every method takes `&self`.** Interior mutability is mandatory: a `Mutex` natively, a `RefCell`
   on the single-threaded `wasm32` tier.

- [ ] **Step 1: Read the trait before writing against it**

Only 5 of the 53 signatures were copied verbatim into this plan's inputs (`facts-openmls.md` §2.5's
"representative signatures"); gap-1 §2 adds 16 more through the public subset. The remaining 32
follow the same per-entity shape, but *follow the same shape* is not *verified*. Print the trait and
check the generated list against it before writing any code:

```bash
/home/thim/.cargo/bin/cargo vendor --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml --versioned-dirs /tmp/claude-1000/-home-thim-Repositories-dilla/77aae878-1e83-42c6-a875-6c5e93f17581/scratchpad/vendor
```

```bash
grep -n -A6 '    fn ' /tmp/claude-1000/-home-thim-Repositories-dilla/77aae878-1e83-42c6-a875-6c5e93f17581/scratchpad/vendor/openmls_traits-0.6.0/src/storage.rs
```

Expected: 72 `fn` declarations. Confirm that the 53 non-feature-gated ones are exactly the names
listed in step 5, and that each one's generic parameters and argument types match what step 5
writes. Where they differ, the crate source wins: correct step 5 and note the correction in the
commit body. Do **not** add `vendor/` to git; it lives in the scratchpad only.

Two specific things to read out of that file, because both are compile errors rather than
behaviour bugs and neither is recorded in any facts file:

1. **The order of each method's generic parameters.** rustc matches an impl's generics to the
   trait's **positionally**, not by name, so a pair written the other way round is
   `error[E0276]: impl has stricter requirements than trait`. The four reads that also exist on
   `PublicStorageProvider` are verified GroupId-first (gap-1 §2.3: `fn tree<GroupId: …, TreeSync:
   …>`), but the reads that exist only on `StorageProvider` are not covered by any verified
   source, and at least `group_state`, `psk` and `encryption_key_pair` are reported to declare the
   **value type first**. Step 5's `group_data_slot!` macro therefore takes the order as its first
   token (`key_first` / `value_first`); set each invocation from what this grep shows:

   ```bash
   grep -n -A4 '    fn \(group_state\|message_secrets\|resumption_psk_store\|own_leaf_index\|group_epoch_secrets\|mls_group_join_config\|psk\|encryption_key_pair\|signature_key_pair\|key_package\)<' /tmp/claude-1000/-home-thim-Repositories-dilla/77aae878-1e83-42c6-a875-6c5e93f17581/scratchpad/vendor/openmls_traits-0.6.0/src/storage.rs
   ```

2. **Whether the 24 marker traits have any blanket impls.** The tests in step 2 need types that
   implement `traits::GroupId`, `traits::TreeSync` and so on. `facts-openmls.md` §2.4 records only
   that "OpenMLS implements `Key`/`Entity` for its own types", so primitives such as `Vec<u8>`,
   `u32` and `String` most likely satisfy none of them — and dilla cannot add the impls, because a
   foreign trait on a foreign type is `E0117`. Step 2 therefore declares **local** newtypes and
   implements the markers on them, which is correct whether or not blanket impls exist. Run:

   ```bash
   grep -n 'impl<' /tmp/claude-1000/-home-thim-Repositories-dilla/77aae878-1e83-42c6-a875-6c5e93f17581/scratchpad/vendor/openmls_traits-0.6.0/src/storage.rs
   ```

   Record what it prints in the commit body. (Needs verification item 22.)

- [ ] **Step 2: Write the failing tests**

Create `core/dilla-core/src/mls/storage.rs` containing only this test module:

The tests drive the provider with **local** newtypes, not with `Vec<u8>`, `u32` and `String`:
every method is bounded by one of the 24 marker traits of `openmls_traits::storage::traits`, those
are implemented by OpenMLS for its own types (facts-openmls §2.4), and dilla may not implement a
foreign trait for a foreign type (E0117). The newtypes live in `mls/mod.rs` (step 6) so `tx.rs` and
task 11's `public_group` tests can share them; until step 6 writes them this file does not compile,
which is part of what step 3 expects to see.

Reads are bound with a `let` type annotation rather than a turbofish (`let tree: Option<TVal> =
s.tree(&gid())?`), so the tests stay correct whichever order the trait declares each read's generic
parameters in — see step 1 item 1.

```rust
#[cfg(not(target_arch = "wasm32"))]
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mls::test_entities::{TKey, TVal};
    use openmls_traits::storage::StorageProvider as _;
    use std::sync::{Arc, Mutex};

    fn gid() -> TKey {
        TKey(b"group-1".to_vec())
    }

    fn open(path: &std::path::Path) -> DillaStorage {
        let conn = rusqlite::Connection::open(path).expect("open");
        let storage = DillaStorage::new(Arc::new(Mutex::new(conn)));
        storage.migrate().expect("migrate");
        storage
    }

    fn memory() -> DillaStorage {
        let conn = rusqlite::Connection::open_in_memory().expect("open");
        let storage = DillaStorage::new(Arc::new(Mutex::new(conn)));
        storage.migrate().expect("migrate");
        storage
    }

    #[test]
    fn migrate_seeds_storage_meta_and_is_idempotent() {
        let s = memory();
        assert_eq!(s.storage_meta("storage_provider_version").unwrap().as_deref(), Some("1"));
        assert_eq!(s.storage_meta("codec").unwrap().as_deref(), Some("cbor"));
        assert!(s.storage_meta("openmls_version").unwrap().is_some());
        assert!(s.storage_meta("nothing").unwrap().is_none());
        s.migrate().expect("second migrate");
        assert_eq!(s.storage_meta("codec").unwrap().as_deref(), Some("cbor"));
    }

    /// The self-describing-codec failure mode is invisible until a reload (gap-6 section 2.3), so
    /// this writes with one connection, drops it, and reads with a new one from the same file.
    #[test]
    fn group_data_survives_closing_and_reopening_the_connection() {
        let dir = std::env::temp_dir().join(format!("dilla-storage-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let path = dir.join("reload.sqlite");
        let _ = std::fs::remove_file(&path);

        {
            let s = open(&path);
            s.write_tree(&gid(), &TVal(3)).expect("write_tree");
            s.write_context(&gid(), &TVal(7)).expect("write_context");
        }
        {
            let s = open(&path);
            let tree: Option<TVal> = s.tree(&gid()).expect("tree");
            assert_eq!(tree, Some(TVal(3)));
            let ctx: Option<TVal> = s.group_context(&gid()).expect("context");
            assert_eq!(ctx, Some(TVal(7)));
        }
        std::fs::remove_file(&path).expect("cleanup");
    }

    #[test]
    fn every_group_data_slot_round_trips_and_deletes() {
        let s = memory();
        let g = gid();
        s.write_tree(&g, &TVal(1)).unwrap();
        s.write_interim_transcript_hash(&g, &TVal(2)).unwrap();
        s.write_context(&g, &TVal(3)).unwrap();
        s.write_confirmation_tag(&g, &TVal(4)).unwrap();
        s.write_group_state(&g, &TVal(5)).unwrap();
        s.write_message_secrets(&g, &TVal(6)).unwrap();
        s.write_resumption_psk_store(&g, &TVal(7)).unwrap();
        s.write_own_leaf_index(&g, &TVal(8)).unwrap();
        s.write_group_epoch_secrets(&g, &TVal(9)).unwrap();
        s.write_mls_join_config(&g, &TVal(10)).unwrap();

        let tree: Option<TVal> = s.tree(&g).unwrap();
        assert_eq!(tree, Some(TVal(1)));
        let interim: Option<TVal> = s.interim_transcript_hash(&g).unwrap();
        assert_eq!(interim, Some(TVal(2)));
        let context: Option<TVal> = s.group_context(&g).unwrap();
        assert_eq!(context, Some(TVal(3)));
        let tag: Option<TVal> = s.confirmation_tag(&g).unwrap();
        assert_eq!(tag, Some(TVal(4)));
        let state: Option<TVal> = s.group_state(&g).unwrap();
        assert_eq!(state, Some(TVal(5)));
        let secrets: Option<TVal> = s.message_secrets(&g).unwrap();
        assert_eq!(secrets, Some(TVal(6)));
        let psks: Option<TVal> = s.resumption_psk_store(&g).unwrap();
        assert_eq!(psks, Some(TVal(7)));
        let leaf: Option<TVal> = s.own_leaf_index(&g).unwrap();
        assert_eq!(leaf, Some(TVal(8)));
        let epoch: Option<TVal> = s.group_epoch_secrets(&g).unwrap();
        assert_eq!(epoch, Some(TVal(9)));
        let config: Option<TVal> = s.mls_group_join_config(&g).unwrap();
        assert_eq!(config, Some(TVal(10)));

        s.delete_tree(&g).unwrap();
        s.delete_interim_transcript_hash(&g).unwrap();
        s.delete_context(&g).unwrap();
        s.delete_confirmation_tag(&g).unwrap();
        s.delete_group_state(&g).unwrap();
        s.delete_message_secrets(&g).unwrap();
        s.delete_all_resumption_psk_secrets(&g).unwrap();
        s.delete_own_leaf_index(&g).unwrap();
        s.delete_group_epoch_secrets(&g).unwrap();
        s.delete_group_config(&g).unwrap();

        let tree: Option<TVal> = s.tree(&g).unwrap();
        assert_eq!(tree, None);
        let config: Option<TVal> = s.mls_group_join_config(&g).unwrap();
        assert_eq!(config, None);
        // a delete on an absent row is not an error
        s.delete_tree(&g).unwrap();
    }

    #[test]
    fn the_proposal_queue_appends_lists_removes_and_clears() {
        let s = memory();
        let g = gid();
        let ref_a = TKey(b"ref-a".to_vec());
        let ref_b = TKey(b"ref-b".to_vec());
        s.queue_proposal(&g, &ref_a, &TVal(1)).unwrap();
        s.queue_proposal(&g, &ref_b, &TVal(2)).unwrap();

        let refs: Vec<TKey> = s.queued_proposal_refs(&g).unwrap();
        assert_eq!(refs.len(), 2);
        let all: Vec<(TKey, TVal)> = s.queued_proposals(&g).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|(_, p)| *p == TVal(1)));

        s.remove_proposal(&g, &ref_a).unwrap();
        let all: Vec<(TKey, TVal)> = s.queued_proposals(&g).unwrap();
        assert_eq!(all.len(), 1);

        // Both parameters are unconstrained by the arguments, so this call site must turbofish
        // (gap-1 section 2.5); the body ignores them.
        s.clear_proposal_queue::<TKey, TKey>(&g).unwrap();
        let all: Vec<(TKey, TVal)> = s.queued_proposals(&g).unwrap();
        assert!(all.is_empty());
    }

    #[test]
    fn own_leaf_nodes_append_in_order_and_delete_together() {
        let s = memory();
        let g = gid();
        s.append_own_leaf_node(&g, &TVal(1)).unwrap();
        s.append_own_leaf_node(&g, &TVal(2)).unwrap();
        let nodes: Vec<TVal> = s.own_leaf_nodes(&g).unwrap();
        assert_eq!(nodes, vec![TVal(1), TVal(2)], "insertion order, not rowid order by accident");
        s.delete_own_leaf_nodes(&g).unwrap();
        let nodes: Vec<TVal> = s.own_leaf_nodes(&g).unwrap();
        assert!(nodes.is_empty());
    }

    #[test]
    fn the_five_keyed_tables_round_trip_and_delete() {
        let s = memory();
        let sig_pub = TKey(b"pub".to_vec());
        s.write_signature_key_pair(&sig_pub, &TVal(11)).unwrap();
        let got: Option<TVal> = s.signature_key_pair(&sig_pub).unwrap();
        assert_eq!(got, Some(TVal(11)));
        s.delete_signature_key_pair(&sig_pub).unwrap();
        let got: Option<TVal> = s.signature_key_pair(&sig_pub).unwrap();
        assert_eq!(got, None);

        let enc_pub = TKey(b"epub".to_vec());
        s.write_encryption_key_pair(&enc_pub, &TVal(12)).unwrap();
        let got: Option<TVal> = s.encryption_key_pair(&enc_pub).unwrap();
        assert_eq!(got, Some(TVal(12)));
        s.delete_encryption_key_pair(&enc_pub).unwrap();

        let kp_ref = TKey(b"kpref".to_vec());
        s.write_key_package(&kp_ref, &TVal(13)).unwrap();
        let got: Option<TVal> = s.key_package(&kp_ref).unwrap();
        assert_eq!(got, Some(TVal(13)));
        s.delete_key_package(&kp_ref).unwrap();

        let psk_id = TKey(b"pskid".to_vec());
        s.write_psk(&psk_id, &TVal(14)).unwrap();
        let got: Option<TVal> = s.psk(&psk_id).unwrap();
        assert_eq!(got, Some(TVal(14)));
        s.delete_psk(&psk_id).unwrap();

        let g = gid();
        let epoch = TKey(b"epoch-7".to_vec());
        s.write_encryption_epoch_key_pairs(&g, &epoch, 3, &[TVal(21), TVal(22)]).unwrap();
        let pairs: Vec<TVal> = s.encryption_epoch_key_pairs(&g, &epoch, 3).unwrap();
        assert_eq!(pairs, vec![TVal(21), TVal(22)]);
        // a different leaf index is a different row
        let none: Vec<TVal> = s.encryption_epoch_key_pairs(&g, &epoch, 4).unwrap();
        assert!(none.is_empty());
        s.delete_encryption_epoch_key_pairs(&g, &epoch, 3).unwrap();
        let none: Vec<TVal> = s.encryption_epoch_key_pairs(&g, &epoch, 3).unwrap();
        assert!(none.is_empty());
    }
}
```

Create `core/dilla-core/src/mls/tx.rs` containing only:

```rust
#[cfg(not(target_arch = "wasm32"))]
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mls::test_entities::{TKey, TVal};
    use crate::mls::{DillaStorage, StorageError};
    use openmls_traits::storage::StorageProvider as _;
    use std::sync::{Arc, Mutex};

    fn memory() -> DillaStorage {
        let conn = rusqlite::Connection::open_in_memory().expect("open");
        let s = DillaStorage::new(Arc::new(Mutex::new(conn)));
        s.migrate().expect("migrate");
        s
    }

    #[test]
    fn a_committed_transaction_keeps_every_write() {
        let s = memory();
        let g = TKey(b"group-1".to_vec());
        let out: Result<u8, TxError<StorageError>> = s.transaction(|| {
            s.write_tree(&g, &TVal(1))?;
            s.write_context(&g, &TVal(2))?;
            Ok(7)
        });
        assert_eq!(out.unwrap(), 7);
        let tree: Option<TVal> = s.tree(&g).unwrap();
        assert_eq!(tree, Some(TVal(1)));
        let context: Option<TVal> = s.group_context(&g).unwrap();
        assert_eq!(context, Some(TVal(2)));
    }

    #[test]
    fn a_failing_transaction_leaves_no_row_behind() {
        let s = memory();
        let g = TKey(b"group-1".to_vec());
        let out: Result<(), TxError<StorageError>> = s.transaction(|| {
            s.write_tree(&g, &TVal(1))?;
            s.write_context(&g, &TVal(2))?;
            Err(StorageError::Codec("deliberate".into()))
        });
        assert!(matches!(out, Err(TxError::RolledBack(StorageError::Codec(_)))));
        let tree: Option<TVal> = s.tree(&g).unwrap();
        assert_eq!(tree, None);
        let context: Option<TVal> = s.group_context(&g).unwrap();
        assert_eq!(context, None);
    }

    #[test]
    fn a_nested_transaction_is_refused_rather_than_silently_flattened() {
        let s = memory();
        let out: Result<(), TxError<StorageError>> = s.transaction(|| {
            let inner: Result<(), TxError<StorageError>> = s.transaction(|| Ok(()));
            assert!(matches!(inner, Err(TxError::Begin(_))));
            Ok(())
        });
        assert!(out.is_ok());
    }
}
```

Create `core/dilla-core/tests/coherence.rs`:

```rust
// `trybuild` shells out to a nested host `cargo`, and this test needs a native SQLite-capable
// build of the crate, so it is compiled for the host only. Plan A2 (NV-9) requires every
// integration test that needs native SQLite to carry this gate; it is written here, in the task
// that creates the file, rather than retrofitted.
#![cfg(not(target_arch = "wasm32"))]

//! One type cannot implement both `StorageProvider` and `PublicStorageProvider`: `openmls_traits`
//! ships a blanket impl of the public trait for every `StorageProvider`, so a second impl is
//! E0119 (gap-1 section 3a). `DillaStorage` and `public_group::PublicStore` are therefore two
//! distinct types, and this test makes the constraint a CI failure rather than a paragraph.

#[test]
#[cfg_attr(miri, ignore)]
fn implementing_both_storage_traits_is_a_compile_error() {
    trybuild::TestCases::new().compile_fail("tests/coherence/both_traits.rs");
}
```

Create `core/dilla-core/tests/coherence/both_traits.rs`:

```rust
use openmls_traits::public_storage::PublicStorageProvider;
use openmls_traits::storage::{StorageProvider, CURRENT_VERSION};

#[derive(Debug, thiserror::Error)]
#[error("both")]
struct BothError;

struct Both;

impl StorageProvider<CURRENT_VERSION> for Both {
    type Error = BothError;
}

impl PublicStorageProvider<CURRENT_VERSION> for Both {
    type PublicError = BothError;
}

fn main() {}
```

(The two impls are deliberately incomplete: the compiler reports the coherence conflict before it
reports the missing methods, and `trybuild` matches on the E0119 message. Generate the expected
output with `TRYBUILD=overwrite` in step 7.)

- [ ] **Step 3: Run the tests to verify they fail**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --locked
```

Add step 6's `pub mod mls;` to `core/dilla-core/src/lib.rs` and the `mod storage; mod tx;`
declarations to a stub `core/dilla-core/src/mls/mod.rs` first — an undeclared module is never
compiled, so without them the run exits 0 having added `0 tests`.

Expected: FAIL, non-zero exit, with `error[E0432]: unresolved import crate::mls::test_entities`
(step 6 writes it) and `error[E0412]: cannot find type DillaStorage in this scope`.

- [ ] **Step 4: Add the `trybuild` dev-dependency**

In `core/dilla-core/Cargo.toml`, extend `[dev-dependencies]`:

```toml
[dev-dependencies]
serde_json = "1.0.151"
hex        = "0.4"
trybuild   = "1.0"
```

This is deviation **A1-13** (interfaces §3.1 lists only `serde_json` and `hex`): §6's task-9 test
list requires a `trybuild` compile-fail test, which needs the crate. Record the patch version
`Cargo.lock` resolves in the commit body, the way task 1 records its other unpinned choices, and
re-run the dependency policy:

```bash
/home/thim/.cargo/bin/cargo deny --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml check licenses bans
```

Expected: PASS. `deny.toml` sets `[bans] multiple-versions = "deny"`, and `trybuild` pulls
`glob`, `serde`, `serde_json`, `termcolor` and `toml`; if `bans` reports a duplicate major, add a
`[[bans.skip]]` entry naming exactly that crate and version **with a comment saying it is
dev-only**, rather than relaxing `multiple-versions`. If a licence is refused, add exactly the SPDX
identifier `cargo deny` names, as task 1 step 12 does.

- [ ] **Step 5: Write the storage provider**

Prepend to `core/dilla-core/src/mls/storage.rs`:

```rust
//! dilla's own `StorageProvider` over rusqlite.
//!
//! `openmls_sqlite_storage 0.3.0` is a reference, not a dependency: it pins rusqlite 0.37 and its
//! crate documentation states it does not support `wasm32`. The schema below is the same shape as
//! its `V1__initial.sql`, so its table layout can be read across.
//!
//! Every method takes `&self`, so the connection lives behind a `Mutex` natively and a `RefCell`
//! on `wasm32`. There is no transaction hook on the trait: dilla wraps `BEGIN IMMEDIATE` around
//! the OpenMLS call from outside, in `DillaStorage::transaction` (see `tx.rs`).

use super::{CborCodec, DillaCodec, StorageError};
use openmls_traits::storage::{traits, StorageProvider, CURRENT_VERSION};
use serde::{de::DeserializeOwned, Serialize};

// These two cfgs are exactly the two dependency sections that declare `rusqlite` (task 1 step 5,
// rule 1): native, and wasm32 with `target_os = "unknown"`. A bare `#[cfg(target_arch = "wasm32")]`
// is also true on `wasm32-wasip1`, where `target_os = "wasi"` and **no** `rusqlite` is in the graph
// — it would expand to `Rc<RefCell<rusqlite::Connection>>` and fail with
// `error[E0433]: failed to resolve: use of undeclared crate or module rusqlite`. The whole SQLite
// half of `mls` is compiled out on wasi; see `mls/mod.rs` in step 6.
#[cfg(not(target_arch = "wasm32"))]
pub type ConnHandle = std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub type ConnHandle = std::rc::Rc<core::cell::RefCell<rusqlite::Connection>>;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS openmls_group_data (
    provider_version INTEGER NOT NULL,
    group_id BLOB NOT NULL,
    data_type TEXT NOT NULL CHECK (data_type IN (
        'join_group_config','tree','interim_transcript_hash','context','confirmation_tag',
        'group_state','message_secrets','resumption_psk_store','own_leaf_index',
        'group_epoch_secrets')),
    group_data BLOB NOT NULL,
    PRIMARY KEY (group_id, data_type)
);
CREATE TABLE IF NOT EXISTS openmls_proposals (
    provider_version INTEGER NOT NULL,
    group_id BLOB NOT NULL, proposal_ref BLOB NOT NULL, proposal BLOB NOT NULL,
    PRIMARY KEY (group_id, proposal_ref)
);
CREATE TABLE IF NOT EXISTS openmls_own_leaf_nodes (
    provider_version INTEGER NOT NULL,
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id BLOB NOT NULL, leaf_node BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS openmls_epoch_key_pairs (
    provider_version INTEGER NOT NULL,
    group_id BLOB NOT NULL, epoch_id BLOB NOT NULL, leaf_index INTEGER NOT NULL,
    key_pairs BLOB NOT NULL,
    PRIMARY KEY (group_id, epoch_id, leaf_index)
);
CREATE TABLE IF NOT EXISTS openmls_signature_keys (
    provider_version INTEGER NOT NULL, public_key BLOB PRIMARY KEY, signature_key BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS openmls_encryption_keys (
    provider_version INTEGER NOT NULL, public_key BLOB PRIMARY KEY, key_pair BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS openmls_key_packages (
    provider_version INTEGER NOT NULL, key_package_ref BLOB PRIMARY KEY, key_package BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS openmls_psks (
    provider_version INTEGER NOT NULL, psk_id BLOB PRIMARY KEY, psk_bundle BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

pub struct DillaStorage {
    conn: ConnHandle,
}

impl From<rusqlite::Error> for StorageError {
    fn from(e: rusqlite::Error) -> Self {
        StorageError::Sqlite(e.to_string())
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn with_conn<T>(
    handle: &ConnHandle,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    let guard = handle.lock().map_err(|_| StorageError::Poisoned)?;
    f(&guard)
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn with_conn<T>(
    handle: &ConnHandle,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    let guard = handle.try_borrow().map_err(|_| StorageError::Poisoned)?;
    f(&guard)
}

impl DillaStorage {
    pub fn new(conn: ConnHandle) -> Self {
        Self { conn }
    }

    pub fn conn(&self) -> &ConnHandle {
        &self.conn
    }

    /// Creates every table if absent and seeds `storage_meta`. Idempotent.
    pub fn migrate(&self) -> Result<(), StorageError> {
        with_conn(&self.conn, |c| {
            c.execute_batch(SCHEMA)?;
            let mut stmt =
                c.prepare("INSERT OR IGNORE INTO storage_meta (key, value) VALUES (?1, ?2)")?;
            stmt.execute(rusqlite::params!["openmls_version", "0.9.0"])?;
            stmt.execute(rusqlite::params!["storage_provider_version", "1"])?;
            stmt.execute(rusqlite::params!["codec", "cbor"])?;
            Ok(())
        })
    }

    pub fn storage_meta(&self, key: &str) -> Result<Option<String>, StorageError> {
        with_conn(&self.conn, |c| {
            let mut stmt = c.prepare("SELECT value FROM storage_meta WHERE key = ?1")?;
            let mut rows = stmt.query(rusqlite::params![key])?;
            match rows.next()? {
                Some(row) => Ok(Some(row.get::<_, String>(0)?)),
                None => Ok(None),
            }
        })
    }

    fn enc<T: Serialize>(value: &T) -> Result<Vec<u8>, StorageError> {
        CborCodec::to_vec(value).map_err(|e| StorageError::Codec(e.to_string()))
    }

    fn dec<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, StorageError> {
        CborCodec::from_slice(bytes).map_err(|e| StorageError::Codec(e.to_string()))
    }

    fn put_group_data<K: Serialize, V: Serialize>(
        &self,
        group_id: &K,
        data_type: &str,
        value: &V,
    ) -> Result<(), StorageError> {
        let (g, v) = (Self::enc(group_id)?, Self::enc(value)?);
        with_conn(&self.conn, |c| {
            c.execute(
                "INSERT INTO openmls_group_data (provider_version, group_id, data_type, group_data)
                 VALUES (1, ?1, ?2, ?3)
                 ON CONFLICT (group_id, data_type) DO UPDATE SET group_data = excluded.group_data",
                rusqlite::params![g, data_type, v],
            )?;
            Ok(())
        })
    }

    fn get_group_data<K: Serialize, V: DeserializeOwned>(
        &self,
        group_id: &K,
        data_type: &str,
    ) -> Result<Option<V>, StorageError> {
        let g = Self::enc(group_id)?;
        let raw: Option<Vec<u8>> = with_conn(&self.conn, |c| {
            let mut stmt = c.prepare(
                "SELECT group_data FROM openmls_group_data WHERE group_id = ?1 AND data_type = ?2",
            )?;
            let mut rows = stmt.query(rusqlite::params![g, data_type])?;
            match rows.next()? {
                Some(row) => Ok(Some(row.get::<_, Vec<u8>>(0)?)),
                None => Ok(None),
            }
        })?;
        raw.map(|b| Self::dec(&b)).transpose()
    }

    fn del_group_data<K: Serialize>(
        &self,
        group_id: &K,
        data_type: &str,
    ) -> Result<(), StorageError> {
        let g = Self::enc(group_id)?;
        with_conn(&self.conn, |c| {
            c.execute(
                "DELETE FROM openmls_group_data WHERE group_id = ?1 AND data_type = ?2",
                rusqlite::params![g, data_type],
            )?;
            Ok(())
        })
    }

    fn put_keyed<K: Serialize, V: Serialize>(
        &self,
        sql: &str,
        key: &K,
        value: &V,
    ) -> Result<(), StorageError> {
        let (k, v) = (Self::enc(key)?, Self::enc(value)?);
        with_conn(&self.conn, |c| {
            c.execute(sql, rusqlite::params![k, v])?;
            Ok(())
        })
    }

    fn get_keyed<K: Serialize, V: DeserializeOwned>(
        &self,
        sql: &str,
        key: &K,
    ) -> Result<Option<V>, StorageError> {
        let k = Self::enc(key)?;
        let raw: Option<Vec<u8>> = with_conn(&self.conn, |c| {
            let mut stmt = c.prepare(sql)?;
            let mut rows = stmt.query(rusqlite::params![k])?;
            match rows.next()? {
                Some(row) => Ok(Some(row.get::<_, Vec<u8>>(0)?)),
                None => Ok(None),
            }
        })?;
        raw.map(|b| Self::dec(&b)).transpose()
    }

    fn del_keyed<K: Serialize>(&self, sql: &str, key: &K) -> Result<(), StorageError> {
        let k = Self::enc(key)?;
        with_conn(&self.conn, |c| {
            c.execute(sql, rusqlite::params![k])?;
            Ok(())
        })
    }
}

/// Generates the write/read/delete triple for one `openmls_group_data` discriminant.
///
/// The first token is the **order of the read's generic parameters**, which rustc matches
/// positionally: writing the pair the other way round than the trait declares it is
/// `error[E0276]: impl has stricter requirements than trait`, not a name mismatch. `write_*` is
/// GroupId-first for every slot (verified, facts-openmls §2.5 `write_tree`); the reads are
/// GroupId-first for the four that also exist on `PublicStorageProvider` (verified, gap-1 §2.3)
/// and are **not** verified for the rest — `group_state`, `psk` and `encryption_key_pair` are
/// reported to declare the value type first. Step 1 item 1 prints the real order; flip the token
/// on any invocation the source disagrees with and note it in the commit body.
macro_rules! group_data_slot {
    (key_first, $write:ident, $read:ident, $delete:ident, $entity:ident, $tag:literal) => {
        group_data_slot!(@write $write, $entity, $tag);

        fn $read<
            GroupId: traits::GroupId<CURRENT_VERSION>,
            $entity: traits::$entity<CURRENT_VERSION>,
        >(
            &self,
            group_id: &GroupId,
        ) -> Result<Option<$entity>, Self::Error> {
            self.get_group_data(group_id, $tag)
        }

        group_data_slot!(@delete $delete, $tag);
    };

    (value_first, $write:ident, $read:ident, $delete:ident, $entity:ident, $tag:literal) => {
        group_data_slot!(@write $write, $entity, $tag);

        fn $read<
            $entity: traits::$entity<CURRENT_VERSION>,
            GroupId: traits::GroupId<CURRENT_VERSION>,
        >(
            &self,
            group_id: &GroupId,
        ) -> Result<Option<$entity>, Self::Error> {
            self.get_group_data(group_id, $tag)
        }

        group_data_slot!(@delete $delete, $tag);
    };

    (@write $write:ident, $entity:ident, $tag:literal) => {
        fn $write<
            GroupId: traits::GroupId<CURRENT_VERSION>,
            $entity: traits::$entity<CURRENT_VERSION>,
        >(
            &self,
            group_id: &GroupId,
            value: &$entity,
        ) -> Result<(), Self::Error> {
            self.put_group_data(group_id, $tag, value)
        }
    };

    (@delete $delete:ident, $tag:literal) => {
        fn $delete<GroupId: traits::GroupId<CURRENT_VERSION>>(
            &self,
            group_id: &GroupId,
        ) -> Result<(), Self::Error> {
            self.del_group_data(group_id, $tag)
        }
    };
}

impl StorageProvider<CURRENT_VERSION> for DillaStorage {
    type Error = StorageError;

    // 30 of the 53: ten single-value slots in openmls_group_data. The first token of each line is
    // the read's generic-parameter order, pinned from the vendored source in step 1; `key_first`
    // on the four that `PublicStorageProvider` also declares is verified (gap-1 section 2.3),
    // `value_first` on `group_state` follows the reported `StorageProvider` declaration, and the
    // remaining five are the ones step 1 must confirm.
    group_data_slot!(key_first, write_mls_join_config, mls_group_join_config, delete_group_config, MlsGroupJoinConfig, "join_group_config");
    group_data_slot!(key_first, write_tree, tree, delete_tree, TreeSync, "tree");
    group_data_slot!(key_first, write_interim_transcript_hash, interim_transcript_hash, delete_interim_transcript_hash, InterimTranscriptHash, "interim_transcript_hash");
    group_data_slot!(key_first, write_context, group_context, delete_context, GroupContext, "context");
    group_data_slot!(key_first, write_confirmation_tag, confirmation_tag, delete_confirmation_tag, ConfirmationTag, "confirmation_tag");
    group_data_slot!(value_first, write_group_state, group_state, delete_group_state, GroupState, "group_state");
    group_data_slot!(key_first, write_message_secrets, message_secrets, delete_message_secrets, MessageSecrets, "message_secrets");
    group_data_slot!(key_first, write_resumption_psk_store, resumption_psk_store, delete_all_resumption_psk_secrets, ResumptionPskStore, "resumption_psk_store");
    group_data_slot!(key_first, write_own_leaf_index, own_leaf_index, delete_own_leaf_index, LeafNodeIndex, "own_leaf_index");
    group_data_slot!(key_first, write_group_epoch_secrets, group_epoch_secrets, delete_group_epoch_secrets, GroupEpochSecrets, "group_epoch_secrets");

    // 3: the append-only own-leaf-node log.
    fn append_own_leaf_node<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        LeafNode: traits::LeafNode<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        leaf_node: &LeafNode,
    ) -> Result<(), Self::Error> {
        let (g, n) = (Self::enc(group_id)?, Self::enc(leaf_node)?);
        with_conn(&self.conn, |c| {
            c.execute(
                "INSERT INTO openmls_own_leaf_nodes (provider_version, group_id, leaf_node)
                 VALUES (1, ?1, ?2)",
                rusqlite::params![g, n],
            )?;
            Ok(())
        })
    }

    fn own_leaf_nodes<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        LeafNode: traits::LeafNode<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<LeafNode>, Self::Error> {
        let g = Self::enc(group_id)?;
        let raws: Vec<Vec<u8>> = with_conn(&self.conn, |c| {
            let mut stmt = c.prepare(
                "SELECT leaf_node FROM openmls_own_leaf_nodes WHERE group_id = ?1 ORDER BY id ASC",
            )?;
            let rows = stmt.query_map(rusqlite::params![g], |row| row.get::<_, Vec<u8>>(0))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })?;
        raws.iter().map(|b| Self::dec(b)).collect()
    }

    fn delete_own_leaf_nodes<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.del_keyed("DELETE FROM openmls_own_leaf_nodes WHERE group_id = ?1", group_id)
    }

    // 5: the proposal queue.
    fn queue_proposal<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
        QueuedProposal: traits::QueuedProposal<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        proposal_ref: &ProposalRef,
        proposal: &QueuedProposal,
    ) -> Result<(), Self::Error> {
        let (g, r, p) = (Self::enc(group_id)?, Self::enc(proposal_ref)?, Self::enc(proposal)?);
        with_conn(&self.conn, |c| {
            c.execute(
                "INSERT INTO openmls_proposals (provider_version, group_id, proposal_ref, proposal)
                 VALUES (1, ?1, ?2, ?3)
                 ON CONFLICT (group_id, proposal_ref) DO UPDATE SET proposal = excluded.proposal",
                rusqlite::params![g, r, p],
            )?;
            Ok(())
        })
    }

    fn queued_proposal_refs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<ProposalRef>, Self::Error> {
        let g = Self::enc(group_id)?;
        let raws: Vec<Vec<u8>> = with_conn(&self.conn, |c| {
            let mut stmt = c.prepare(
                "SELECT proposal_ref FROM openmls_proposals WHERE group_id = ?1 ORDER BY rowid ASC",
            )?;
            let rows = stmt.query_map(rusqlite::params![g], |row| row.get::<_, Vec<u8>>(0))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })?;
        raws.iter().map(|b| Self::dec(b)).collect()
    }

    fn queued_proposals<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
        QueuedProposal: traits::QueuedProposal<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<(ProposalRef, QueuedProposal)>, Self::Error> {
        let g = Self::enc(group_id)?;
        let raws: Vec<(Vec<u8>, Vec<u8>)> = with_conn(&self.conn, |c| {
            let mut stmt = c.prepare(
                "SELECT proposal_ref, proposal FROM openmls_proposals
                 WHERE group_id = ?1 ORDER BY rowid ASC",
            )?;
            let rows = stmt.query_map(rusqlite::params![g], |row| {
                Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?))
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })?;
        raws.iter().map(|(r, p)| Ok((Self::dec(r)?, Self::dec(p)?))).collect()
    }

    fn remove_proposal<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        proposal_ref: &ProposalRef,
    ) -> Result<(), Self::Error> {
        let (g, r) = (Self::enc(group_id)?, Self::enc(proposal_ref)?);
        with_conn(&self.conn, |c| {
            c.execute(
                "DELETE FROM openmls_proposals WHERE group_id = ?1 AND proposal_ref = ?2",
                rusqlite::params![g, r],
            )?;
            Ok(())
        })
    }

    /// Both type parameters are unconstrained by the arguments, so every call site turbofishes
    /// them; the body ignores both (gap-1 section 2.5).
    fn clear_proposal_queue<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.del_keyed("DELETE FROM openmls_proposals WHERE group_id = ?1", group_id)
    }

    // 12: the four single-key tables.
    fn write_signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>,
        SignatureKeyPair: traits::SignatureKeyPair<CURRENT_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
        signature_key_pair: &SignatureKeyPair,
    ) -> Result<(), Self::Error> {
        self.put_keyed(
            "INSERT INTO openmls_signature_keys (provider_version, public_key, signature_key)
             VALUES (1, ?1, ?2)
             ON CONFLICT (public_key) DO UPDATE SET signature_key = excluded.signature_key",
            public_key,
            signature_key_pair,
        )
    }

    fn signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>,
        SignatureKeyPair: traits::SignatureKeyPair<CURRENT_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
    ) -> Result<Option<SignatureKeyPair>, Self::Error> {
        self.get_keyed(
            "SELECT signature_key FROM openmls_signature_keys WHERE public_key = ?1",
            public_key,
        )
    }

    fn delete_signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
    ) -> Result<(), Self::Error> {
        self.del_keyed("DELETE FROM openmls_signature_keys WHERE public_key = ?1", public_key)
    }

    fn write_encryption_key_pair<
        EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
    >(
        &self,
        public_key: &EncryptionKey,
        key_pair: &HpkeKeyPair,
    ) -> Result<(), Self::Error> {
        self.put_keyed(
            "INSERT INTO openmls_encryption_keys (provider_version, public_key, key_pair)
             VALUES (1, ?1, ?2)
             ON CONFLICT (public_key) DO UPDATE SET key_pair = excluded.key_pair",
            public_key,
            key_pair,
        )
    }

    // Value type first: this read is reported to declare `<HpkeKeyPair, EncryptionKey>`, and the
    // order is positional (step 1 item 1). Same for `psk` below.
    fn encryption_key_pair<
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
        EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>,
    >(
        &self,
        public_key: &EncryptionKey,
    ) -> Result<Option<HpkeKeyPair>, Self::Error> {
        self.get_keyed(
            "SELECT key_pair FROM openmls_encryption_keys WHERE public_key = ?1",
            public_key,
        )
    }

    fn delete_encryption_key_pair<EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>>(
        &self,
        public_key: &EncryptionKey,
    ) -> Result<(), Self::Error> {
        self.del_keyed("DELETE FROM openmls_encryption_keys WHERE public_key = ?1", public_key)
    }

    fn write_key_package<
        HashReference: traits::HashReference<CURRENT_VERSION>,
        KeyPackage: traits::KeyPackage<CURRENT_VERSION>,
    >(
        &self,
        hash_ref: &HashReference,
        key_package: &KeyPackage,
    ) -> Result<(), Self::Error> {
        self.put_keyed(
            "INSERT INTO openmls_key_packages (provider_version, key_package_ref, key_package)
             VALUES (1, ?1, ?2)
             ON CONFLICT (key_package_ref) DO UPDATE SET key_package = excluded.key_package",
            hash_ref,
            key_package,
        )
    }

    fn key_package<
        HashReference: traits::HashReference<CURRENT_VERSION>,
        KeyPackage: traits::KeyPackage<CURRENT_VERSION>,
    >(
        &self,
        hash_ref: &HashReference,
    ) -> Result<Option<KeyPackage>, Self::Error> {
        self.get_keyed(
            "SELECT key_package FROM openmls_key_packages WHERE key_package_ref = ?1",
            hash_ref,
        )
    }

    fn delete_key_package<HashReference: traits::HashReference<CURRENT_VERSION>>(
        &self,
        hash_ref: &HashReference,
    ) -> Result<(), Self::Error> {
        self.del_keyed("DELETE FROM openmls_key_packages WHERE key_package_ref = ?1", hash_ref)
    }

    fn write_psk<
        PskId: traits::PskId<CURRENT_VERSION>,
        PskBundle: traits::PskBundle<CURRENT_VERSION>,
    >(
        &self,
        psk_id: &PskId,
        psk: &PskBundle,
    ) -> Result<(), Self::Error> {
        self.put_keyed(
            "INSERT INTO openmls_psks (provider_version, psk_id, psk_bundle) VALUES (1, ?1, ?2)
             ON CONFLICT (psk_id) DO UPDATE SET psk_bundle = excluded.psk_bundle",
            psk_id,
            psk,
        )
    }

    fn psk<
        PskBundle: traits::PskBundle<CURRENT_VERSION>,
        PskId: traits::PskId<CURRENT_VERSION>,
    >(
        &self,
        psk_id: &PskId,
    ) -> Result<Option<PskBundle>, Self::Error> {
        self.get_keyed("SELECT psk_bundle FROM openmls_psks WHERE psk_id = ?1", psk_id)
    }

    fn delete_psk<PskId: traits::PskId<CURRENT_VERSION>>(
        &self,
        psk_id: &PskId,
    ) -> Result<(), Self::Error> {
        self.del_keyed("DELETE FROM openmls_psks WHERE psk_id = ?1", psk_id)
    }

    // 3: per-epoch HPKE key pairs, keyed by (group, epoch, leaf).
    fn write_encryption_epoch_key_pairs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        EpochKey: traits::EpochKey<CURRENT_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
        key_pairs: &[HpkeKeyPair],
    ) -> Result<(), Self::Error> {
        // `&key_pairs.to_vec()` would need `HpkeKeyPair: Clone`, which the bound does not give
        // (E0277). A slice reference serialises directly: `&[T]: Serialize` when `T: Serialize`,
        // and the outer `&` keeps the generic argument `Sized`. The wire shape is the same
        // sequence the read below decodes into `Vec<HpkeKeyPair>`.
        let (g, e, v) = (Self::enc(group_id)?, Self::enc(epoch)?, Self::enc(&key_pairs)?);
        with_conn(&self.conn, |c| {
            c.execute(
                "INSERT INTO openmls_epoch_key_pairs
                     (provider_version, group_id, epoch_id, leaf_index, key_pairs)
                 VALUES (1, ?1, ?2, ?3, ?4)
                 ON CONFLICT (group_id, epoch_id, leaf_index)
                 DO UPDATE SET key_pairs = excluded.key_pairs",
                rusqlite::params![g, e, leaf_index, v],
            )?;
            Ok(())
        })
    }

    fn encryption_epoch_key_pairs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        EpochKey: traits::EpochKey<CURRENT_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
    ) -> Result<Vec<HpkeKeyPair>, Self::Error> {
        let (g, e) = (Self::enc(group_id)?, Self::enc(epoch)?);
        let raw: Option<Vec<u8>> = with_conn(&self.conn, |c| {
            let mut stmt = c.prepare(
                "SELECT key_pairs FROM openmls_epoch_key_pairs
                 WHERE group_id = ?1 AND epoch_id = ?2 AND leaf_index = ?3",
            )?;
            let mut rows = stmt.query(rusqlite::params![g, e, leaf_index])?;
            match rows.next()? {
                Some(row) => Ok(Some(row.get::<_, Vec<u8>>(0)?)),
                None => Ok(None),
            }
        })?;
        match raw {
            Some(b) => Self::dec(&b),
            None => Ok(Vec::new()),
        }
    }

    fn delete_encryption_epoch_key_pairs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        EpochKey: traits::EpochKey<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
    ) -> Result<(), Self::Error> {
        let (g, e) = (Self::enc(group_id)?, Self::enc(epoch)?);
        with_conn(&self.conn, |c| {
            c.execute(
                "DELETE FROM openmls_epoch_key_pairs
                 WHERE group_id = ?1 AND epoch_id = ?2 AND leaf_index = ?3",
                rusqlite::params![g, e, leaf_index],
            )?;
            Ok(())
        })
    }
}
```

- [ ] **Step 6: Write the transaction wrapper, the codec and the provider**

Prepend to `core/dilla-core/src/mls/tx.rs`:

```rust
//! `BEGIN IMMEDIATE … COMMIT` around an OpenMLS call (R12).
//!
//! `merge_staged_commit` performs up to 15 storage writes with no transaction hook on the trait
//! (gap-7 section 2.1), so the boundary has to be drawn here, outside the provider.
//!
//! `BEGIN IMMEDIATE` rather than the default deferred begin: it takes the write lock up front, so
//! two clients sharing a file fail fast instead of half-way through a merge.

use super::{DillaStorage, StorageError};

/// What went wrong, and how far the transaction got.
#[derive(Debug, thiserror::Error)]
pub enum TxError<E> {
    #[error("begin: {0}")]
    Begin(StorageError),
    #[error("commit: {0}")]
    Commit(StorageError),
    #[error("rolled back")]
    RolledBack(#[source] E),
    #[error("rollback failed after {cause}: {rollback}")]
    RollbackFailed { cause: String, rollback: StorageError },
}

impl DillaStorage {
    /// Runs `f` inside one SQLite transaction. On any error the transaction is rolled back and the
    /// caller's error is returned inside `TxError::RolledBack`.
    ///
    /// **After a rollback the in-memory `MlsGroup` is invalid** (gap-7 section 4 item 1): the
    /// caller drops its handle and reloads. `DillaGroup` turns that into `MlsError::NeedsReload`.
    pub fn transaction<T, E: From<StorageError>>(
        &self,
        f: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, TxError<E>> {
        self.exec("BEGIN IMMEDIATE").map_err(TxError::Begin)?;
        match f() {
            Ok(value) => match self.exec("COMMIT") {
                Ok(()) => Ok(value),
                Err(e) => Err(TxError::Commit(e)),
            },
            Err(cause) => match self.exec("ROLLBACK") {
                Ok(()) => Err(TxError::RolledBack(cause)),
                Err(rollback) => {
                    Err(TxError::RollbackFailed { cause: format!("{cause:?}"), rollback })
                }
            },
        }
    }
}
```

Add the private `exec` helper to `core/dilla-core/src/mls/storage.rs`, inside the
`impl DillaStorage` block, next to `storage_meta`:

```rust
    pub(crate) fn exec(&self, sql: &str) -> Result<(), StorageError> {
        with_conn(&self.conn, |c| {
            c.execute_batch(sql)?;
            Ok(())
        })
    }
```

Create `core/dilla-core/src/mls/provider.rs`:

```rust
//! `OpenMlsProvider` = `openmls_rust_crypto::RustCrypto` (crypto and randomness) plus dilla's own
//! storage. `RustCrypto` implements `OpenMlsCrypto` and `OpenMlsRand` and is `Default`, so the
//! composition needs no fork of anything upstream.

use super::{ConnHandle, DillaStorage};
use openmls_rust_crypto::RustCrypto;

pub struct DillaProvider {
    crypto: RustCrypto,
    storage: DillaStorage,
}

impl DillaProvider {
    pub fn new(conn: ConnHandle) -> Self {
        Self { crypto: RustCrypto::default(), storage: DillaStorage::new(conn) }
    }

    pub fn storage(&self) -> &DillaStorage {
        &self.storage
    }
}

impl openmls_traits::OpenMlsProvider for DillaProvider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = DillaStorage;

    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }

    fn rand(&self) -> &Self::RandProvider {
        &self.crypto
    }

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }
}
```

Create `core/dilla-core/src/mls/mod.rs`:

```rust
//! The MLS layer: the storage provider, the provider composition, dilla's group-context binding,
//! the group configuration and the transactional group wrapper.
//!
//! **Target gating — read before adding a module here.** `provider`, `storage` and `tx` (and, from
//! task 10, `config` and `group`) are built on `rusqlite`, which `core/dilla-core/Cargo.toml`
//! declares for exactly two targets: native (`cfg(not(target_arch = "wasm32"))`) and the browser
//! (`cfg(all(target_arch = "wasm32", target_os = "unknown"))`). `wasm32-wasip1` is
//! `target_arch = "wasm32"` with `target_os = "wasi"`, so it matches **neither** and has no
//! `rusqlite` in its graph at all — an ungated `mod storage;` there is
//! `error[E0433]: failed to resolve: use of undeclared crate or module rusqlite`. The cfg below is
//! written to be the same condition as those two dependency sections.
//!
//! Everything else in this module is target-agnostic and must stay ungated: `public_group` — the
//! module the whole wasi tier exists for — uses `CborCodec`, `DillaCodec` and `StorageError` from
//! here, and task 10's `DillaBinding`, `GroupKind` and the policy tables are what `dilla-core-wasi`
//! validates against.

#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
mod provider;
#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
mod storage;
#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
mod tx;

#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
pub use provider::DillaProvider;
#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
pub use storage::{ConnHandle, DillaStorage};
#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
pub use tx::TxError;

use serde::{de::DeserializeOwned, Serialize};

/// Everything the storage layer can fail with.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum StorageError {
    #[error("sqlite: {0}")]
    Sqlite(String),
    #[error("codec: {0}")]
    Codec(String),
    #[error("lock poisoned")]
    Poisoned,
}

/// The serde codec the `StorageProvider` blobs use.
///
/// OpenMLS 0.9.0 **requires a self-describing format** (gap-6 section 2): `MlsGroupJoinConfig`
/// deserialises through `deserialize_any`, so postcard, bincode and every other positional binary
/// format is excluded, and the failure only shows up on a reload. The `0-8-1-storage-format`
/// feature stays off and is inert under a self-describing codec.
pub trait DillaCodec: Default {
    type Error: core::fmt::Debug + std::error::Error + Send + Sync + 'static;
    fn to_vec<T: Serialize>(value: &T) -> Result<Vec<u8>, Self::Error>;
    fn from_slice<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, Self::Error>;
}

#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("serialize: {0}")]
    Serialize(String),
    #[error("deserialize: {0}")]
    Deserialize(String),
}

/// CBOR through `ciborium`. `ciborium` splits (de)serialisation into two error types, which is why
/// `CodecError` has two variants rather than passing one through.
///
/// This codec is used **only** for OpenMLS's own serde blobs. Every normative dilla format goes
/// through `crate::cbor`, whose decoder is strict; `ciborium`'s is deliberately liberal and must
/// never see an envelope, a credential identity, a device list or a `dilla_binding`.
#[derive(Default)]
pub struct CborCodec;

impl DillaCodec for CborCodec {
    type Error = CodecError;

    fn to_vec<T: Serialize>(value: &T) -> Result<Vec<u8>, Self::Error> {
        let mut buf = Vec::new();
        ciborium::into_writer(value, &mut buf).map_err(|e| CodecError::Serialize(e.to_string()))?;
        Ok(buf)
    }

    fn from_slice<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, Self::Error> {
        ciborium::from_reader(bytes).map_err(|e| CodecError::Deserialize(e.to_string()))
    }
}

/// Local stand-ins for the OpenMLS types every storage method is generic over, shared by the unit
/// tests of `mls::storage`, `mls::tx` and `public_group::storage`.
///
/// The 24 marker traits of `openmls_traits::storage::traits` are implemented by OpenMLS for its
/// own concrete types (facts-openmls.md section 2.4; gap-1 section 5 lists which concrete type
/// backs each one). Nothing verified says they have blanket impls, so `Vec<u8>`, `u32` and
/// `String` satisfy none of them — and dilla cannot add the impls, because a foreign trait on a
/// foreign type is E0117. These types are local, so they can.
///
/// `ProposalRef` is a Key **and** an Entity (gap-1 section 5), which is why `TKey` is both.
#[cfg(test)]
pub(crate) mod test_entities {
    use openmls_traits::storage::{traits, Entity, Key, CURRENT_VERSION};
    use serde::{Deserialize, Serialize};

    #[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
    pub(crate) struct TKey(pub Vec<u8>);

    impl Key<CURRENT_VERSION> for TKey {}
    impl Entity<CURRENT_VERSION> for TKey {}
    impl traits::GroupId<CURRENT_VERSION> for TKey {}
    impl traits::ProposalRef<CURRENT_VERSION> for TKey {}
    impl traits::SignaturePublicKey<CURRENT_VERSION> for TKey {}
    impl traits::EncryptionKey<CURRENT_VERSION> for TKey {}
    impl traits::HashReference<CURRENT_VERSION> for TKey {}
    impl traits::PskId<CURRENT_VERSION> for TKey {}
    impl traits::EpochKey<CURRENT_VERSION> for TKey {}

    #[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
    pub(crate) struct TVal(pub u32);

    impl Entity<CURRENT_VERSION> for TVal {}
    impl traits::TreeSync<CURRENT_VERSION> for TVal {}
    impl traits::InterimTranscriptHash<CURRENT_VERSION> for TVal {}
    impl traits::GroupContext<CURRENT_VERSION> for TVal {}
    impl traits::ConfirmationTag<CURRENT_VERSION> for TVal {}
    impl traits::GroupState<CURRENT_VERSION> for TVal {}
    impl traits::MessageSecrets<CURRENT_VERSION> for TVal {}
    impl traits::ResumptionPskStore<CURRENT_VERSION> for TVal {}
    impl traits::LeafNodeIndex<CURRENT_VERSION> for TVal {}
    impl traits::GroupEpochSecrets<CURRENT_VERSION> for TVal {}
    impl traits::MlsGroupJoinConfig<CURRENT_VERSION> for TVal {}
    impl traits::QueuedProposal<CURRENT_VERSION> for TVal {}
    impl traits::LeafNode<CURRENT_VERSION> for TVal {}
    impl traits::SignatureKeyPair<CURRENT_VERSION> for TVal {}
    impl traits::HpkeKeyPair<CURRENT_VERSION> for TVal {}
    impl traits::PskBundle<CURRENT_VERSION> for TVal {}
    impl traits::KeyPackage<CURRENT_VERSION> for TVal {}
}
```

Step 1 item 2 checked whether the marker traits carry blanket impls. If they do, these newtypes
still work unchanged — keep them, and record the finding in the commit body.

Add `pub mod mls;` to `core/dilla-core/src/lib.rs`, and add the storage variant to `CoreError` in
`core/dilla-core/src/error.rs`:

```rust
    #[error(transparent)]
    Storage(#[from] crate::mls::StorageError),
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --lib --locked
```

Expected: PASS, `0 failed; 0 ignored` — the six storage tests and the three transaction tests on
top of the 53 unit tests from tasks 3 to 6.

Generate the `trybuild` expectation once, then check it in:

```bash
env TRYBUILD=overwrite /home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --test coherence --locked
```

```bash
cat /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core/tests/coherence/both_traits.stderr
```

Expected: the file contains `error[E0119]: conflicting implementations of trait`. If it contains a
"missing method" error instead, the coherence conflict did **not** reproduce against
`openmls_traits 0.6.0`: record that in the commit body, delete the test, and note that
`DillaStorage` and `PublicStore` stay separate types by design rather than by necessity.

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --test coherence --locked
```

Expected: PASS.

```bash
/home/thim/.cargo/bin/cargo clippy --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --all-targets --all-features --locked -- -D warnings
```

Expected: PASS with no warnings.

Then both wasm targets, here rather than three tasks later: this is the task that introduces
`rusqlite` into the module graph, so it is the task whose gating can break them. The spec's W1 line
asks for the custom StorageProvider "native **+ wasm**", and `dilla-core-wasi` (part A2 task 14)
depends on this crate.

```bash
/home/thim/.cargo/bin/cargo build --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --features vectors --target wasm32-wasip1 --locked
```

Expected: PASS. The `mls` SQLite half is compiled out here (step 6's cfg) and `rusqlite` is absent
from the graph; a `use of undeclared crate or module rusqlite` means an item was left ungated.

```bash
/home/thim/.cargo/bin/cargo build --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --features vectors --target wasm32-unknown-unknown --locked
```

Expected: PASS — this is the browser tier, where the whole provider **is** compiled, over
`sqlite-wasm-rs`, with `ConnHandle = Rc<RefCell<Connection>>` and `with_conn`'s `try_borrow` path.
Week 1 compiles that leg and no more: nothing *runs* it under wasm32-unknown-unknown until part A2
task 16 runs the unit tests under Node, and OPFS persistence is part A2's browser spike. Say so in
the commit body rather than implying the browser store is exercised here.

```bash
/home/thim/.cargo/bin/cargo test --no-run --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --features vectors --target wasm32-unknown-unknown --locked
```

Expected: PASS. This is what catches an integration test that cannot compile for wasm:
`tests/coherence.rs` carries `#![cfg(not(target_arch = "wasm32"))]` (step 2) precisely so that it
does not try to shell out to a nested `cargo` here.

- [ ] **Step 8: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add core/dilla-core/src/mls core/dilla-core/src/lib.rs core/dilla-core/src/error.rs core/dilla-core/Cargo.toml Cargo.lock core/dilla-core/tests/coherence.rs core/dilla-core/tests/coherence && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(core): custom OpenMLS StorageProvider on rusqlite with explicit transactions'
```
---

### Task 10: Group configuration, `dilla_binding` and the group wrapper

**Files:**
- Create: `core/dilla-core/src/mls/binding.rs`, `config.rs`, `policy.rs`, `group.rs`
- Modify: `core/dilla-core/src/mls/mod.rs` (declare and re-export the four), `core/dilla-core/src/error.rs` (add the `Mls` variant to `CoreError`)
- Test: unit tests in `binding.rs`, `config.rs` and `policy.rs`, plus `core/dilla-core/tests/mls_roundtrip.rs`

**Interfaces:**
- Consumes: `cbor`, `ids`, `error`, `identity`, `envelope`, `mls::{DillaProvider, DillaStorage, StorageError, TxError}`.
- Produces, all under `mls::`:
  `DILLA_BINDING_ID: u16 = 0xF001`, `DILLA_BINDING: ExtensionType`, `CIPHERSUITE: Ciphersuite`, `PADDING_SIZE: usize = 256`, `KEY_PACKAGE_LIFETIME_DAYS: u64 = 90`, `INACTIVITY_REMOVE_DAYS: u64 = 90`, `MAX_ADDS_PER_COMMIT: usize = 256`, `PAST_EPOCHS_TEXT: usize = 16`, `PAST_EPOCHS_CALL: usize = 1`;
  `GroupKind { Text = 0, Call = 1, Pairing = 2, Interaction = 3 }` with `as_u8`, `from_u64`, `has_external_sender`, `media_version`;
  `DillaBinding { v, instance_id, community_id, target_id, kind, policy_version, e2ee_version, media_version }` with `encode`, `decode`, `to_extension`, `from_group_context`, `from_extensions`, `matches`;
  `instance_credential_identity(&InstanceId) -> Vec<u8>`, `instance_credential(&InstanceId) -> Credential`, `external_senders(SignaturePublicKey, &InstanceId) -> ExternalSendersExtension`, `instance_sender_index() -> SenderExtensionIndex`;
  `group_context_extensions(&DillaBinding, Option<ExternalSendersExtension>) -> Result<Extensions<GroupContext>, MlsError>`, `leaf_capabilities() -> Capabilities`, `create_config(..) -> Result<MlsGroupCreateConfig, MlsError>`, `join_config(GroupKind) -> MlsGroupJoinConfig`, `build_key_package(..) -> Result<KeyPackageBundle, MlsError>`, `rotate_external_senders_extensions(..) -> Result<Extensions<GroupContext>, MlsError>`;
  `past_epoch_policy(GroupKind) -> PastEpochDeletionPolicy`, `past_epoch_sweep(GroupKind) -> Option<PastEpochDeletion>`, `validate_staged_commit(GroupKind, &UserId, &UserId, &Sender, &PublicGroup, &StagedCommit) -> Result<(), ProtocolError>`;
  `MlsError`, `CommitBundle`, `DillaProcessed`, `DillaGroup` (including `clear_pending_commit`).

**Two changes to the contract, made here and mirrored in `interfaces.md`:**

- `validate_staged_commit` gains `&Sender` and `&PublicGroup`. §2.7.5's four-argument form cannot
  implement its own rule: deciding whether a `Remove` targets the committer's own user means
  reading the *removed* leaf's credential, which lives in the group's pre-merge tree
  (`PublicGroup::leaf(LeafNodeIndex)`, facts-openmls §6) and nowhere in the `StagedCommit`; and
  "is this an external commit" is the commit's `Sender`, not the presence of an update path. The
  caller (`DillaGroup::process_message`) has both.
- `DillaGroup` gains `clear_pending_commit(&mut self, provider) -> Result<(), MlsError>`, wrapping
  `MlsGroup::clear_pending_commit(storage)` (facts-openmls §4.4; gap-7 §4 lists it under T11 as a
  1-2 write operation). Without it a caller cannot stage a second commit after one that will never
  be merged: the group is left in `MlsGroupState::PendingCommit` and every later
  `add_members`/`remove_members`/`self_update` fails with `MlsGroupStateError::PendingCommit`. Two
  places in this plan need it — the DS 409 loser (spec line 591, "the loser clears its pending
  commit") and task 13's ten alternative fixture commits.

Five rules the implementer must not "improve":

1. **`required_capabilities` lists only `ExtensionType::Unknown(0xF001)`** (deviation D2). The spec
   text says external senders go in it; RFC 9420 §7.2 and `protocol/01-groups.md` say a **default**
   extension type must not be listed, and `ExternalSenders` is one (gap-28 §0, gap-5 §4.2).
2. **The binding *type* and the binding *payload* are two different extensions** in the same
   `Extensions<GroupContext>` (gap-4 §4). Getting this wrong is a hard commit failure.
3. **A `GroupContextExtensions` proposal replaces the whole set** and must re-state every extension
   (gap-4 §4.1). `rotate_external_senders_extensions` therefore rebuilds all three.
4. **Every dilla KeyPackage must advertise 0xF001 in its leaf capabilities** or every `Add` is
   rejected with `ProposalValidationError::InsufficientCapabilities` (gap-4 §5).
5. **After a rollback the in-memory `MlsGroup` is invalid** (gap-7 §4 item 1). The wrapper returns
   `MlsError::NeedsReload`; the caller drops the handle and calls `DillaGroup::load` again.

- [ ] **Step 1: Read the OpenMLS signatures this task depends on**

Six items are used below whose exact spelling is **not** recorded in any facts or gap file. Read
them from the vendored source before writing code (the vendor directory was produced in task 9
step 1; re-run that command if it is gone):

```bash
grep -rn 'pub fn new\|pub struct Lifetime' /tmp/claude-1000/-home-thim-Repositories-dilla/77aae878-1e83-42c6-a875-6c5e93f17581/scratchpad/vendor/openmls-0.9.0/src/treesync/node/leaf_node/capabilities.rs /tmp/claude-1000/-home-thim-Repositories-dilla/77aae878-1e83-42c6-a875-6c5e93f17581/scratchpad/vendor/openmls-0.9.0/src/key_packages/lifetime.rs
```

```bash
grep -rn 'pub struct CommitMessageBundle\|impl CommitMessageBundle' -A40 /tmp/claude-1000/-home-thim-Repositories-dilla/77aae878-1e83-42c6-a875-6c5e93f17581/scratchpad/vendor/openmls-0.9.0/src/group/mls_group/commit_builder.rs
```

```bash
grep -rn 'pub fn set_aad\|pub struct LeafNodeParameters\|pub fn leaf_node' /tmp/claude-1000/-home-thim-Repositories-dilla/77aae878-1e83-42c6-a875-6c5e93f17581/scratchpad/vendor/openmls-0.9.0/src/group/mls_group/mod.rs /tmp/claude-1000/-home-thim-Repositories-dilla/77aae878-1e83-42c6-a875-6c5e93f17581/scratchpad/vendor/openmls-0.9.0/src/treesync/node/leaf_node.rs /tmp/claude-1000/-home-thim-Repositories-dilla/77aae878-1e83-42c6-a875-6c5e93f17581/scratchpad/vendor/openmls-0.9.0/src/key_packages/mod.rs
```

```bash
grep -rn 'impl EpochAuthenticator\|pub fn as_slice' /tmp/claude-1000/-home-thim-Repositories-dilla/77aae878-1e83-42c6-a875-6c5e93f17581/scratchpad/vendor/openmls-0.9.0/src/schedule/mod.rs
```

Record what each returns. Where the source differs from the code below, the source wins: correct
the code, and note the correction in the commit body. Each of the six is also listed under "Needs
verification" at the end of this plan, with the line that uses it.

- [ ] **Step 2: Write the failing tests**

Create `core/dilla-core/src/mls/binding.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{ChannelId, CommunityId, InstanceId};
    use tls_codec::Serialize as _;

    fn binding() -> DillaBinding {
        DillaBinding {
            v: 1,
            instance_id: InstanceId::from_bytes([0x11; 16]),
            community_id: Some(CommunityId::from_bytes([0x22; 16])),
            target_id: *ChannelId::from_bytes([0x33; 16]).as_bytes(),
            kind: GroupKind::Text,
            policy_version: 7,
            e2ee_version: 1,
            media_version: 0,
        }
    }

    #[test]
    fn binding_encodes_an_eight_element_array_and_round_trips() {
        let b = binding();
        let bytes = b.encode();
        assert_eq!(bytes[0], 0x88, "an 8-element array head");
        assert_eq!(DillaBinding::decode(&bytes).unwrap(), b);

        let mut dm = b.clone();
        dm.community_id = None;
        assert_eq!(DillaBinding::decode(&dm.encode()).unwrap(), dm);
    }

    #[test]
    fn binding_decode_rejects_trailing_bytes() {
        // OpenMLS does not validate unknown-extension payloads (gap-4 section 3), so an attacker
        // can append padding unless dilla rejects it here.
        let mut bytes = binding().encode();
        bytes.push(0x00);
        assert_eq!(DillaBinding::decode(&bytes), Err(ProtocolError::Binding));
        assert_eq!(DillaBinding::decode(&[]), Err(ProtocolError::Binding));
    }

    #[test]
    fn matches_compares_every_immutable_field() {
        let b = binding();
        assert_eq!(b.matches(&b), Ok(()));
        for mutate in [
            |x: &mut DillaBinding| x.instance_id = InstanceId::from_bytes([0x99; 16]),
            |x: &mut DillaBinding| x.community_id = None,
            |x: &mut DillaBinding| x.target_id = [0x99; 16],
            |x: &mut DillaBinding| x.kind = GroupKind::Call,
            |x: &mut DillaBinding| x.e2ee_version = 2,
            |x: &mut DillaBinding| x.media_version = 1,
        ] {
            let mut other = b.clone();
            mutate(&mut other);
            assert_eq!(b.matches(&other), Err(ProtocolError::Binding));
        }
        // policy_version is a snapshot, not an identity field
        let mut later = b.clone();
        later.policy_version = 99;
        assert_eq!(b.matches(&later), Ok(()));
    }

    /// `Extension`'s TLS codec is hand-written and emits `F0 01 || varint len || payload`.
    /// `UnknownExtension`'s own derived codec adds a second length prefix; never use it for wire
    /// bytes (gap-4 section 3).
    #[test]
    fn the_extension_serialises_without_a_second_length_prefix() {
        let ext = Extension::Unknown(DILLA_BINDING_ID, UnknownExtension(vec![1, 2, 3]));
        assert_eq!(ext.tls_serialize_detached().unwrap(), vec![0xf0, 0x01, 0x03, 0x01, 0x02, 0x03]);
    }

    #[test]
    fn group_kinds_carry_their_external_sender_and_media_rules() {
        assert!(GroupKind::Text.has_external_sender());
        assert!(GroupKind::Call.has_external_sender());
        assert!(!GroupKind::Pairing.has_external_sender());
        assert!(!GroupKind::Interaction.has_external_sender());
        assert_eq!(GroupKind::Call.media_version(), 1);
        for k in [GroupKind::Text, GroupKind::Pairing, GroupKind::Interaction] {
            assert_eq!(k.media_version(), 0);
        }
        assert_eq!(GroupKind::from_u64(4), Err(ProtocolError::Binding));
    }

    #[test]
    fn the_instance_credential_identity_is_the_three_element_array() {
        let id = InstanceId::from_bytes([0x11; 16]);
        let bytes = instance_credential_identity(&id);
        let mut want = crate::cbor::Encoder::new();
        want.array(3).uint(1).text("instance").bytes(id.as_bytes());
        assert_eq!(bytes, want.into_vec());
    }
}
```

Create `core/dilla-core/src/mls/config.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::InstanceId;

    fn binding(kind: GroupKind) -> DillaBinding {
        DillaBinding {
            v: 1,
            instance_id: InstanceId::from_bytes([0x11; 16]),
            community_id: None,
            target_id: [0x33; 16],
            kind,
            policy_version: 1,
            e2ee_version: 1,
            media_version: kind.media_version(),
        }
    }

    /// D2: only `ExtensionType::Unknown(0xF001)` goes in `required_capabilities.extension_types`.
    /// `ExternalSenders` is a default type and listing it makes every commit invalid.
    #[test]
    fn required_capabilities_lists_only_the_dilla_binding_type() {
        let exts = group_context_extensions(&binding(GroupKind::Text), None).unwrap();
        let rc = exts.required_capabilities().expect("required_capabilities present");
        assert_eq!(rc.extension_types(), &[DILLA_BINDING]);
        assert!(rc.proposal_types().is_empty());
        assert_eq!(rc.credential_types(), &[CredentialType::Basic]);
        assert!(exts.unknown(DILLA_BINDING_ID).is_some(), "the payload is a sibling extension");
    }

    #[test]
    fn pairing_and_interaction_groups_refuse_an_external_sender() {
        let senders = ExternalSendersExtension::new();
        for kind in [GroupKind::Pairing, GroupKind::Interaction] {
            let err = group_context_extensions(&binding(kind), Some(senders.clone())).unwrap_err();
            assert!(
                matches!(err, MlsError::Protocol(ProtocolError::ExternalSenderForbidden)),
                "{kind:?}: {err:?}"
            );
        }
        // text and call accept one
        assert!(group_context_extensions(&binding(GroupKind::Text), Some(senders)).is_ok());
    }

    #[test]
    fn every_leaf_advertises_the_binding_extension_and_basic_credentials() {
        let caps = leaf_capabilities();
        assert!(caps.extensions().contains(&DILLA_BINDING));
        assert!(caps.credentials().contains(&CredentialType::Basic));
    }

    #[test]
    fn a_rotation_proposal_restates_all_three_extensions() {
        // A GroupContextExtensions proposal REPLACES the set; dropping the binding from a rotation
        // silently erases it from the group context (gap-4 section 4.1).
        let b = binding(GroupKind::Text);
        let exts = rotate_external_senders_extensions(&b, ExternalSendersExtension::new()).unwrap();
        assert!(exts.required_capabilities().is_some());
        assert!(exts.external_senders().is_some());
        assert_eq!(DillaBinding::from_extensions(&exts).unwrap(), b);
    }

    #[test]
    fn the_create_config_pins_the_wire_and_padding_policy() {
        let cfg = create_config(&binding(GroupKind::Text), None).unwrap();
        assert_eq!(cfg.ciphersuite(), CIPHERSUITE);
        let join = cfg.join_config();
        assert_eq!(join.padding_size(), PADDING_SIZE);
        assert!(!join.use_ratchet_tree_extension(), "the DS serves the tree");
        assert_eq!(join.wire_format_policy(), PURE_PLAINTEXT_WIRE_FORMAT_POLICY);
    }

    #[test]
    fn constants_match_the_protocol_documents() {
        assert_eq!(DILLA_BINDING_ID, 0xF001);
        assert_eq!(PADDING_SIZE, 256);
        assert_eq!(KEY_PACKAGE_LIFETIME_DAYS, 90);
        assert_eq!(INACTIVITY_REMOVE_DAYS, 90); // R15, not the spec's chaos-list "30 days"
        assert_eq!(MAX_ADDS_PER_COMMIT, 256);
        assert_eq!(CIPHERSUITE, Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519);
    }
}
```

Create `core/dilla-core/src/mls/policy.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn past_epoch_policy_is_count_based_per_group_kind() {
        assert_eq!(past_epoch_policy(GroupKind::Text), PastEpochDeletionPolicy::MaxEpochs(PAST_EPOCHS_TEXT));
        assert_eq!(past_epoch_policy(GroupKind::Call), PastEpochDeletionPolicy::MaxEpochs(PAST_EPOCHS_CALL));
        // Structural: nothing is ever written for these two, so nothing can leak.
        assert_eq!(past_epoch_policy(GroupKind::Pairing), PastEpochDeletionPolicy::MaxEpochs(0));
        assert_eq!(past_epoch_policy(GroupKind::Interaction), PastEpochDeletionPolicy::MaxEpochs(0));
    }

    #[test]
    fn the_sweep_exists_only_where_past_epochs_do() {
        assert!(past_epoch_sweep(GroupKind::Text).is_some());
        assert!(past_epoch_sweep(GroupKind::Call).is_some());
        assert!(past_epoch_sweep(GroupKind::Pairing).is_none());
        assert!(past_epoch_sweep(GroupKind::Interaction).is_none());
    }

    #[test]
    fn the_windows_are_the_documented_300_and_10_seconds() {
        assert_eq!(TEXT_SWEEP, core::time::Duration::from_secs(300));
        assert_eq!(CALL_SWEEP, core::time::Duration::from_secs(10));
        assert_eq!(PAST_EPOCHS_TEXT, 16);
        assert_eq!(PAST_EPOCHS_CALL, 1);
    }
}
```

Create `core/dilla-core/tests/mls_roundtrip.rs`:

```rust
// Native only: every test here opens a real SQLite connection through `rusqlite`, which exists on
// this target and on the browser target but not under `wasm32-unknown-unknown`'s test harness.
// Plan A2's NV-9 requires the gate; it is written in the task that creates the file.
#![cfg(not(target_arch = "wasm32"))]

//! Two clients, one text group, end to end: create, add, welcome-join, send, decrypt - through
//! dilla's own StorageProvider, with the binding checked before anything is written.

use dilla_core::envelope::{Envelope, EnvelopeType};
use dilla_core::ids::{DeviceId, InstanceId, MsgId, UserId};
use dilla_core::mls::*;
use dilla_core::ProtocolError;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use std::sync::{Arc, Mutex};

fn provider() -> DillaProvider {
    let conn = rusqlite::Connection::open_in_memory().expect("sqlite");
    let p = DillaProvider::new(Arc::new(Mutex::new(conn)));
    p.storage().migrate().expect("migrate");
    p
}

fn identity(user: u8, device: u8) -> Vec<u8> {
    use dilla_core::identity::{CredentialIdentity, Kind, SignerTier, Tier};
    let umk = dilla_core::identity::UmkSigner::from_bytes(&[user; 32]);
    let ssk = dilla_core::identity::SskSigner::from_bytes(&[user.wrapping_add(0x40); 32]);
    let device_id = DeviceId::from_bytes([device; 16]);
    CredentialIdentity {
        v: 1,
        umk_pub: umk.public(),
        user_id: UserId::from_bytes([user; 16]),
        device_id,
        kind: Kind::User,
        tier: Tier::Native,
        signer_tier: SignerTier::Native,
        ssk_pub: ssk.public(),
        sig_umk_ssk: umk.sign_ssk(&ssk.public()),
        sig_ssk_dev: [0u8; 64], // not checked by this test; task 12 wires the real leaf key in
    }
    .encode()
}

fn signer_and_credential(user: u8, device: u8) -> (SignatureKeyPair, CredentialWithKey) {
    let keys = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
    let credential = BasicCredential::new(identity(user, device));
    let with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: keys.public().into(),
    };
    (keys, with_key)
}

fn binding(kind: GroupKind) -> DillaBinding {
    DillaBinding {
        v: 1,
        instance_id: InstanceId::from_bytes([0x11; 16]),
        community_id: None,
        target_id: [0x33; 16],
        kind,
        policy_version: 1,
        e2ee_version: 1,
        media_version: kind.media_version(),
    }
}

/// The wire round trip, not a `From` impl: `.into()` with an unconstrained target is
/// `error[E0282]: type annotations needed`, and "Needs verification" item 18 records that
/// `From<MlsMessageOut> for MlsMessageIn` was never read from a source (facts-openmls §4.5 marks
/// `MlsMessageIn::into_welcome` as `test-utils`-gated). This is what a real peer does with the
/// bytes, and it is the same path `testkit/src/client.rs` uses.
fn into_protocol(message: MlsMessageOut) -> ProtocolMessage {
    use tls_codec::{Deserialize as _, Serialize as _};
    let bytes = message.tls_serialize_detached().expect("serialize");
    MlsMessageIn::tls_deserialize_exact(&bytes)
        .expect("deserialize")
        .try_into_protocol_message()
        .expect("a commit or an application message is a ProtocolMessage")
}

/// The same round trip for a message that carries a GroupInfo.
fn into_group_info(message: MlsMessageOut) -> VerifiableGroupInfo {
    use tls_codec::{Deserialize as _, Serialize as _};
    let bytes = message.tls_serialize_detached().expect("serialize");
    match MlsMessageIn::tls_deserialize_exact(&bytes).expect("deserialize").extract() {
        MlsMessageBodyIn::GroupInfo(info) => info,
        other => panic!("expected a GroupInfo message, got {other:?}"),
    }
}

/// The same round trip for a Welcome.
fn into_welcome(message: MlsMessageOut) -> Welcome {
    use tls_codec::{Deserialize as _, Serialize as _};
    let bytes = message.tls_serialize_detached().expect("serialize");
    match MlsMessageIn::tls_deserialize_exact(&bytes).expect("deserialize").extract() {
        MlsMessageBodyIn::Welcome(w) => w,
        other => panic!("expected a Welcome message, got {other:?}"),
    }
}

fn envelope(body: &str) -> Envelope {
    Envelope {
        v: 1,
        msg_id: MsgId::from_bytes([0x01; 16]),
        kind: EnvelopeType::Message,
        thread_id: None,
        reply_to: None,
        body: body.to_owned(),
        attachments: Vec::new(),
        previews: Vec::new(),
        k_f: [0x06; 32],
    }
}

#[test]
fn two_clients_create_add_join_send_and_decrypt() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");

    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    let group_id = GroupId::from_slice(&[0x44; 16]);
    let b = binding(GroupKind::Text);
    let mut alice =
        DillaGroup::create(&alice_p, &alice_signer, alice_cred, group_id.clone(), b.clone(), None)
            .expect("create");
    assert_eq!(alice.epoch(), 0);
    assert_eq!(alice.binding(), &b);

    let bundle = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");
    assert_eq!(alice.epoch(), 1);
    assert_eq!(bundle.welcomes.len(), 1);

    let welcome = into_welcome(bundle.welcomes[0].1.clone());
    let tree = alice.export_ratchet_tree();
    let mut bob = DillaGroup::join_from_welcome(&bob_p, welcome, tree.into(), &b).expect("join");
    assert_eq!(bob.epoch(), 1);
    assert_eq!(bob.binding(), &b);

    let env = envelope("On my way. Grab the wolf capes from the chest by the portal.");
    let message = alice.create_message(&alice_p, &alice_signer, &env).expect("create_message");
    let protocol = into_protocol(message);
    match bob.process_message(&bob_p, protocol).expect("process") {
        DillaProcessed::Application(got) => assert_eq!(got, env),
        other => panic!("expected an application message, got {other:?}"),
    }
}

#[test]
fn a_welcome_whose_binding_mismatches_is_refused_before_anything_is_stored() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    let group_id = GroupId::from_slice(&[0x44; 16]);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        group_id.clone(),
        binding(GroupKind::Text),
        None,
    )
    .expect("create");
    let bundle = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");
    let welcome = into_welcome(bundle.welcomes[0].1.clone());

    // Bob expects a DIFFERENT channel.
    let mut wrong = binding(GroupKind::Text);
    wrong.target_id = [0x99; 16];
    let err = DillaGroup::join_from_welcome(
        &bob_p,
        welcome,
        alice.export_ratchet_tree().into(),
        &wrong,
    )
    .expect_err("the binding must be checked before into_group");
    assert!(matches!(err, MlsError::Protocol(ProtocolError::Binding)), "{err:?}");
    assert!(
        DillaGroup::load(&bob_p, &group_id).expect("load").is_none(),
        "a refused welcome must leave no group behind"
    );
}

#[test]
fn a_key_package_without_the_binding_capability_cannot_be_added() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");

    // Built WITHOUT leaf_node_capabilities(leaf_capabilities()): no 0xF001.
    let plain = KeyPackage::builder()
        .build(CIPHERSUITE, &bob_p, &bob_signer, bob_cred)
        .expect("key package");

    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        binding(GroupKind::Text),
        None,
    )
    .expect("create");
    let err = alice
        .add_members(&alice_p, &alice_signer, &[plain.key_package().clone()])
        .expect_err("a leaf that cannot support 0xF001 must be refused");
    assert!(format!("{err:?}").contains("InsufficientCapabilities"), "{err:?}");
}

/// protocol/01-groups.md, "Client policy for proposals from members": a member `Remove` is
/// accepted only when the target leaf belongs to the committer's own user. Alice (user 0xaa) and
/// Bob (user 0xbb) are different users, so Bob's client must refuse Alice's commit rather than
/// merge it — `E_MEMBER_REMOVE_FORBIDDEN`.
#[test]
fn a_member_commit_removing_another_users_leaf_is_refused_by_the_receiver() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        b.clone(),
        None,
    )
    .expect("create");
    let add = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");
    let mut bob = DillaGroup::join_from_welcome(
        &bob_p,
        into_welcome(add.welcomes[0].1.clone()),
        alice.export_ratchet_tree().into(),
        &b,
    )
    .expect("join");

    // Bob joined as the second leaf, so index 1 is his.
    let removal = alice
        .remove_members(&alice_p, &alice_signer, &[LeafNodeIndex::new(1)])
        .expect("remove_members");
    let err = bob
        .process_message(&bob_p, into_protocol(removal.commit))
        .expect_err("a member Remove of another user's leaf must be refused");
    assert!(
        matches!(err, MlsError::Protocol(ProtocolError::MemberRemoveForbidden)),
        "{err:?}"
    );
    assert_eq!(bob.epoch(), 1, "the refused commit must not have advanced Bob's epoch");
}

/// The contract's rollback case: a storage failure inside the merge transaction must surface as
/// `MlsError::NeedsReload` (never as a half-merged group), and the reloaded handle must be at the
/// pre-merge epoch.
///
/// The failure is injected through the connection the provider was built on — `ConnHandle` is
/// public, so the test keeps a clone of it — with a trigger that aborts the one write
/// `merge_staged_commit` always performs on `openmls_epoch_key_pairs`
/// (`store_epoch_keypairs`, gap-7 section 2.1 step 2). Nothing is mocked: the real provider, the
/// real transaction and the real `MlsGroup` are all in play.
#[test]
fn a_storage_failure_inside_the_merge_rolls_back_and_reports_needs_reload() {
    let conn: ConnHandle = std::sync::Arc::new(Mutex::new(
        rusqlite::Connection::open_in_memory().expect("sqlite"),
    ));
    let alice_p = DillaProvider::new(conn.clone());
    alice_p.storage().migrate().expect("migrate");
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    let group_id = GroupId::from_slice(&[0x44; 16]);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        group_id.clone(),
        binding(GroupKind::Text),
        None,
    )
    .expect("create");
    alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    assert_eq!(alice.epoch(), 0);

    conn.lock()
        .expect("lock")
        .execute_batch(
            "CREATE TRIGGER fail_epoch_keys BEFORE INSERT ON openmls_epoch_key_pairs
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
        )
        .expect("install trigger");

    let err = alice.merge_pending_commit(&alice_p).expect_err("the merge must fail");
    assert!(matches!(err, MlsError::NeedsReload), "{err:?}");

    conn.lock().expect("lock").execute_batch("DROP TRIGGER fail_epoch_keys;").expect("drop");

    let reloaded = DillaGroup::load(&alice_p, &group_id).expect("load").expect("group is still there");
    assert_eq!(reloaded.epoch(), 0, "the rollback must leave the pre-merge epoch");
}

#[test]
fn a_pairing_group_never_writes_a_past_epoch_secret() {
    let p = provider();
    let (signer, cred) = signer_and_credential(0xaa, 0x01);
    signer.store(p.storage()).expect("store signer");
    let mut g = DillaGroup::create(
        &p,
        &signer,
        cred,
        GroupId::from_slice(&[0x55; 16]),
        binding(GroupKind::Pairing),
        None,
    )
    .expect("create");
    assert_eq!(past_epoch_policy(GroupKind::Pairing), PastEpochDeletionPolicy::MaxEpochs(0));
    g.self_update(&p, &signer).expect("self_update");
    g.merge_pending_commit(&p).expect("merge");
    // The sweep is a no-op for pairing: there is nothing to sweep.
    assert!(past_epoch_sweep(GroupKind::Pairing).is_none());
    g.sweep_past_epochs(&p).expect("sweep is still callable and does nothing");
}
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --locked
```

Declare the four new modules first — step 7's `mod binding; mod config; mod group; mod policy;`
(with their cfgs) in `core/dilla-core/src/mls/mod.rs`. Step 2 only created the files, and an
undeclared module is never compiled, so without this the run exits 0 with `0 tests` added.

Expected: FAIL, non-zero exit, with `error[E0412]: cannot find type DillaBinding in this scope`,
`error[E0425]: cannot find function group_context_extensions in this scope` and roughly 40 further
resolution errors from `tests/mls_roundtrip.rs`.

- [ ] **Step 4: Write the binding**

Prepend to `core/dilla-core/src/mls/binding.rs`:

```rust
//! `dilla_binding`: the GroupContext extension that nails a group to one instance, one target and
//! one protocol version (protocol/01-groups.md "dilla_binding"). It is immutable for the group's
//! life, and every Welcome, GroupInfo, Proposal and Commit is checked against it.

use super::MlsError;
use crate::cbor::{decode_strict, Encoder};
use crate::error::ProtocolError;
use crate::ids::{CommunityId, InstanceId};
use openmls::extensions::{ExternalSender, ExternalSendersExtension, SenderExtensionIndex};
use openmls::prelude::*;

/// Private-use extension type. 0xF000-0xFFFF is "Reserved for Private Use" in the live IANA
/// registry for RFC 9420, and 0xF001 is not a GREASE value (gap-4 section 1.1).
pub const DILLA_BINDING_ID: u16 = 0xF001;
pub const DILLA_BINDING: ExtensionType = ExtensionType::Unknown(DILLA_BINDING_ID);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum GroupKind {
    Text = 0,
    Call = 1,
    Pairing = 2,
    Interaction = 3,
}

impl GroupKind {
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    pub fn from_u64(v: u64) -> Result<Self, ProtocolError> {
        Ok(match v {
            0 => Self::Text,
            1 => Self::Call,
            2 => Self::Pairing,
            3 => Self::Interaction,
            _ => return Err(ProtocolError::Binding),
        })
    }

    /// Only text and call groups carry the instance as an external sender; pairing and interaction
    /// groups must not (`E_EXTERNAL_SENDER_FORBIDDEN`).
    pub const fn has_external_sender(self) -> bool {
        matches!(self, Self::Text | Self::Call)
    }

    pub const fn media_version(self) -> u64 {
        match self {
            Self::Call => 1,
            _ => 0,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DillaBinding {
    pub v: u64,
    pub instance_id: InstanceId,
    /// `None` for DMs, group DMs, pairing and interaction groups.
    pub community_id: Option<CommunityId>,
    /// channel_id, dm_id, the new device_id (pairing) or the bot's user_id (interaction).
    pub target_id: [u8; 16],
    pub kind: GroupKind,
    /// The instance's policy version at group creation. A snapshot, not an identity field.
    pub policy_version: u64,
    pub e2ee_version: u64,
    pub media_version: u64,
}

impl DillaBinding {
    pub fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::with_capacity(96);
        e.array(8)
            .uint(self.v)
            .bytes(self.instance_id.as_bytes())
            .opt_bytes(self.community_id.as_ref().map(|c| &c.0[..]))
            .bytes(&self.target_id)
            .uint(u64::from(self.kind.as_u8()))
            .uint(self.policy_version)
            .uint(self.e2ee_version)
            .uint(self.media_version);
        e.into_vec()
    }

    /// Rejects trailing bytes itself: OpenMLS does not re-parse or length-check unknown-extension
    /// payloads beyond the outer `opaque<V>` (gap-4 section 3), so without this an attacker can
    /// append padding to a valid binding and still round-trip it.
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        decode_strict(bytes, |d| {
            d.array(8)?;
            let v = d.uint()?;
            let instance_id = InstanceId::from_bytes(d.bytes_exact::<16>()?);
            let community_id = d.opt_bytes_exact::<16>()?.map(CommunityId::from_bytes);
            let target_id = d.bytes_exact::<16>()?;
            let kind = d.uint()?;
            Ok((v, instance_id, community_id, target_id, kind, d.uint()?, d.uint()?, d.uint()?))
        })
        .map_err(|_| ProtocolError::Binding)
        .and_then(|(v, instance_id, community_id, target_id, kind, policy_version, e2ee, media)| {
            if v != 1 {
                return Err(ProtocolError::Binding);
            }
            Ok(Self {
                v,
                instance_id,
                community_id,
                target_id,
                kind: GroupKind::from_u64(kind)?,
                policy_version,
                e2ee_version: e2ee,
                media_version: media,
            })
        })
    }

    pub fn to_extension(&self) -> Extension {
        Extension::Unknown(DILLA_BINDING_ID, UnknownExtension(self.encode()))
    }

    pub fn from_group_context(ctx: &GroupContext) -> Result<Self, ProtocolError> {
        Self::from_extensions(ctx.extensions())
    }

    pub fn from_extensions<T>(exts: &Extensions<T>) -> Result<Self, ProtocolError> {
        let raw = exts.unknown(DILLA_BINDING_ID).ok_or(ProtocolError::Binding)?;
        Self::decode(&raw.0)
    }

    /// Everything immutable must match. `policy_version` is deliberately excluded: it is the
    /// instance's policy snapshot at creation and moves on without the group changing identity.
    pub fn matches(&self, expected: &DillaBinding) -> Result<(), ProtocolError> {
        let same = self.instance_id == expected.instance_id
            && self.community_id == expected.community_id
            && self.target_id == expected.target_id
            && self.kind == expected.kind
            && self.e2ee_version == expected.e2ee_version
            && self.media_version == expected.media_version;
        if same {
            Ok(())
        } else {
            Err(ProtocolError::Binding)
        }
    }
}

/// The instance external sender's basic-credential identity: CBOR `[1, "instance", instance_id]`.
pub fn instance_credential_identity(instance_id: &InstanceId) -> Vec<u8> {
    let mut e = Encoder::with_capacity(32);
    e.array(3).uint(1).text("instance").bytes(instance_id.as_bytes());
    e.into_vec()
}

pub fn instance_credential(instance_id: &InstanceId) -> Credential {
    BasicCredential::new(instance_credential_identity(instance_id)).into()
}

pub fn external_senders(
    instance_key: SignaturePublicKey,
    instance_id: &InstanceId,
) -> ExternalSendersExtension {
    vec![ExternalSender::new(instance_key, instance_credential(instance_id))]
}

/// The instance is always at position 0 and is never reordered (gap-5 section 2.3).
pub fn instance_sender_index() -> SenderExtensionIndex {
    SenderExtensionIndex::new(0)
}

impl From<ProtocolError> for MlsError {
    fn from(e: ProtocolError) -> Self {
        MlsError::Protocol(e)
    }
}
```

- [ ] **Step 5: Write the configuration and the past-epoch policy**

Prepend to `core/dilla-core/src/mls/config.rs`:

```rust
//! Group configuration: the ciphersuite, the three GroupContext extensions, the leaf capabilities
//! and the KeyPackage builder (protocol/01-groups.md, R11).

use super::{
    past_epoch_policy, DillaBinding, DillaProvider, GroupKind, MlsError, DILLA_BINDING,
    DILLA_BINDING_ID,
};
use crate::error::ProtocolError;
use openmls::extensions::ExternalSendersExtension;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;

/// The mandatory-to-implement suite, the only one at v1 (protocol/01-groups.md).
pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
/// Application ciphertext is padded to a multiple of this (RFC 9420 section 6.3.1).
pub const PADDING_SIZE: usize = 256;
/// Clients publish KeyPackages with a 90-day lifetime (protocol/01 "Joining").
pub const KEY_PACKAGE_LIFETIME_DAYS: u64 = 90;
/// A device silent this long is removed by the instance (R15; the spec's chaos list says 30 and is
/// wrong - protocol/01-groups.md and spec line 716 both say 90).
pub const INACTIVITY_REMOVE_DAYS: u64 = 90;
/// The DS batches at most this many Adds into one commit.
pub const MAX_ADDS_PER_COMMIT: usize = 256;

/// Builds the three GroupContext extensions, in this order:
///   1. `RequiredCapabilities` naming only `ExtensionType::Unknown(0xF001)` (D2)
///   2. `ExternalSenders`, only when `ext_senders` is `Some`
///   3. `Unknown(0xF001, UnknownExtension(binding.encode()))` - the payload
///
/// `Extensions` preserves insertion order and rejects duplicate types, so this order is the wire
/// order; do not build a second set and expect byte-identity unless you preserve it.
pub fn group_context_extensions(
    binding: &DillaBinding,
    ext_senders: Option<ExternalSendersExtension>,
) -> Result<Extensions<GroupContext>, MlsError> {
    if ext_senders.is_some() && !binding.kind.has_external_sender() {
        return Err(ProtocolError::ExternalSenderForbidden.into());
    }
    let mut items = vec![Extension::RequiredCapabilities(RequiredCapabilitiesExtension::new(
        &[DILLA_BINDING],
        &[],
        &[CredentialType::Basic],
    ))];
    if let Some(senders) = ext_senders {
        items.push(Extension::ExternalSenders(senders));
    }
    items.push(binding.to_extension());
    Extensions::try_from(items).map_err(|e| MlsError::OpenMls(format!("{e:?}")))
}

/// Every dilla leaf advertises 0xF001. A KeyPackage that does not is rejected on Add with
/// `ProposalValidationError::InsufficientCapabilities` (gap-4 section 5).
pub fn leaf_capabilities() -> Capabilities {
    Capabilities::new(None, None, Some(&[DILLA_BINDING]), None, Some(&[CredentialType::Basic]))
}

pub fn create_config(
    binding: &DillaBinding,
    ext_senders: Option<ExternalSendersExtension>,
) -> Result<MlsGroupCreateConfig, MlsError> {
    Ok(MlsGroupCreateConfig::builder()
        .ciphersuite(CIPHERSUITE)
        .use_ratchet_tree_extension(false)
        .padding_size(PADDING_SIZE)
        .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
        .set_past_epoch_deletion_policy(past_epoch_policy(binding.kind))
        .with_group_context_extensions(group_context_extensions(binding, ext_senders)?)
        .capabilities(leaf_capabilities())
        .build())
}

pub fn join_config(kind: GroupKind) -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(false)
        .padding_size(PADDING_SIZE)
        .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
        .set_past_epoch_deletion_policy(past_epoch_policy(kind))
        .build()
}

pub fn build_key_package(
    provider: &DillaProvider,
    signer: &SignatureKeyPair,
    credential: CredentialWithKey,
    last_resort: bool,
) -> Result<KeyPackageBundle, MlsError> {
    let mut builder = KeyPackage::builder()
        .leaf_node_capabilities(leaf_capabilities())
        // NEEDS VERIFICATION: `Lifetime::new(seconds)` - task step 1 confirms the constructor.
        .key_package_lifetime(Lifetime::new(KEY_PACKAGE_LIFETIME_DAYS * 24 * 60 * 60));
    if last_resort {
        builder = builder.mark_as_last_resort();
    }
    builder
        .build(CIPHERSUITE, provider, signer, credential)
        .map_err(|e| MlsError::OpenMls(format!("{e:?}")))
}

/// A `GroupContextExtensions` proposal **replaces** the whole extension set, so a rotation has to
/// re-state required_capabilities and the unchanged binding alongside the new senders. Dropping
/// the binding silently erases it from the group context; dropping required_capabilities makes the
/// commit invalid (gap-4 section 4.1). At most one such proposal per commit.
pub fn rotate_external_senders_extensions(
    binding: &DillaBinding,
    new_senders: ExternalSendersExtension,
) -> Result<Extensions<GroupContext>, MlsError> {
    group_context_extensions(binding, Some(new_senders))
}
```

(No `dilla_binding_id()` accessor: `DILLA_BINDING_ID` is already a public constant, and interfaces
§2.7.1 forbids inventing public names. Drop `DILLA_BINDING_ID` from this file's `use super::{…}`
list if nothing else here names it — an unused import fails `-D warnings`.)

Prepend to `core/dilla-core/src/mls/policy.rs`:

```rust
//! Past-epoch secret retention and the proposal-policy tables of protocol/01-groups.md.

use super::GroupKind;
use crate::error::ProtocolError;
use crate::ids::UserId;
use core::time::Duration;
// `PublicGroup`, `Sender`, `StagedCommit`, `LeafNodeIndex` and `BasicCredential` all come from the
// prelude; none of them touches storage, so this module compiles on every target, wasip1 included.
use openmls::prelude::*;

/// Text groups keep this many past epochs. **A plan decision, not a verified number**: the
/// protocol's 300-second window cannot be turned into an epoch count without the DS's worst-case
/// reordering window, which nothing measures in week 1.
pub const PAST_EPOCHS_TEXT: usize = 16;
/// Call groups keep exactly one.
pub const PAST_EPOCHS_CALL: usize = 1;
/// protocol/01: past epoch secrets are kept 300 s in text groups.
pub const TEXT_SWEEP: Duration = Duration::from_secs(300);
/// protocol/01: 10 s in call groups.
pub const CALL_SWEEP: Duration = Duration::from_secs(10);

/// The **count-based** policy is the real guarantee. `older_than_duration` compares the epoch's
/// *start* timestamp and short-circuits to "clear all" when the current epoch is itself older than
/// the window (gap-8 section 3.1), so the sweep is an upper bound, not a floor.
pub fn past_epoch_policy(kind: GroupKind) -> PastEpochDeletionPolicy {
    match kind {
        GroupKind::Text => PastEpochDeletionPolicy::MaxEpochs(PAST_EPOCHS_TEXT),
        GroupKind::Call => PastEpochDeletionPolicy::MaxEpochs(PAST_EPOCHS_CALL),
        // Structural: nothing is ever written, so nothing can be recovered.
        GroupKind::Pairing | GroupKind::Interaction => PastEpochDeletionPolicy::MaxEpochs(0),
    }
}

/// The time-based sweep run after a merge. Never write
/// `PastEpochDeletion::delete_all().max_past_epochs(k)`: it silently ignores `k` (gap-8 3.2).
pub fn past_epoch_sweep(kind: GroupKind) -> Option<PastEpochDeletion> {
    match kind {
        GroupKind::Text => Some(PastEpochDeletion::older_than_duration(TEXT_SWEEP)),
        GroupKind::Call => Some(PastEpochDeletion::older_than_duration(CALL_SWEEP)),
        GroupKind::Pairing | GroupKind::Interaction => None,
    }
}

/// The client-side proposal policy of protocol/01-groups.md, applied to a `StagedCommit` **before**
/// it is merged. OpenMLS offers no credential-validation callback on Add: the application inspects
/// the staged commit and aborts without merging (facts-openmls "Is there a credential-validation
/// hook on Add?").
///
/// - `Update` from a member: accept.
/// - `Remove`: accept only when the target leaf belongs to the committer's own user
///   (`E_MEMBER_REMOVE_FORBIDDEN`). Removing other users is the instance's job.
/// - `Add`: accept only in pairing and interaction groups; reject in text and call groups.
/// - An external commit's `Remove` must target only the joiner's own leaf
///   (`E_EXTERNAL_COMMIT_REMOVE`).
/// - `GroupContextExtensions`, `ReInit` and `PreSharedKey` from a member: reject.
///
/// **This function is not optional and is not advisory.** `DillaGroup::process_message` calls it on
/// the `StagedCommitMessage` arm before handing the commit back, so a caller cannot merge a commit
/// the protocol forbids. It is the only enforcement point: OpenMLS validates the commit
/// cryptographically and structurally, never against dilla's role rules.
///
/// `tree` is the group's **pre-merge** membership view (`MlsGroup::public_group()`), and it is the
/// only place a removed leaf's credential can be read: `StagedCommit::credentials_to_verify()` is
/// the set of credentials the commit *introduces* — empty for a Remove-only commit.
/// `sender` is how an external commit is recognised (`Sender::NewMemberCommit`, RFC 9420
/// §12.4.3.2); an update path is not that signal, because every path-bearing member commit has one.
pub fn validate_staged_commit(
    kind: GroupKind,
    own_user: &UserId,
    committer_user: &UserId,
    sender: &Sender,
    tree: &PublicGroup,
    staged: &StagedCommit,
) -> Result<(), ProtocolError> {
    // NEEDS VERIFICATION item 23: `Sender::NewMemberCommit`'s exact spelling in 0.9.0.
    let external = matches!(sender, Sender::NewMemberCommit);

    // `own_user` is the receiving device's own user. No rule below is receiver-relative — every
    // check compares the committer with the target — but the contract carries it because only the
    // caller knows it and the role-snapshot rule of protocol/01 will need it. Asserted rather than
    // discarded with a `let _ =`.
    debug_assert_ne!(own_user.as_bytes(), &[0u8; 16], "own_user must be the receiver's user id");

    if staged.add_proposals().next().is_some() && matches!(kind, GroupKind::Text | GroupKind::Call)
    {
        // NEEDS VERIFICATION item 24: protocol/01-groups.md states this rule ("`Add`: accept only
        // in `pairing` … and `interaction` groups; reject in `text` and `call`") but assigns it no
        // code — its published list is the six `E_*` strings at line 122, and
        // `E_MEMBER_REMOVE_FORBIDDEN` is not one of this rule's names. The **rejection** is what
        // week 1 depends on; the string is not yet part of the compatibility surface for this
        // rule, and settling it is a protocol/07-versioning.md change, not a code change.
        return Err(ProtocolError::MemberRemoveForbidden);
    }
    // `.next().is_some()`, not `!….next().is_none()`: `clippy::nonminimal_bool` is warn-by-default
    // and every task here runs clippy with `-D warnings`. Same NEEDS VERIFICATION item 24 applies
    // to the code this returns.
    if staged.psk_proposals().next().is_some() {
        return Err(ProtocolError::MemberRemoveForbidden);
    }
    for remove in staged.remove_proposals() {
        let target = remove.remove_proposal().removed();
        let target_user = user_of_leaf(tree, target)?;
        removal_verdict(external, committer_user, &target_user)?;
    }
    Ok(())
}

/// The removal rule on its own, over plain user ids.
///
/// Split out so it is testable: a *malicious* external commit — one that removes a leaf belonging
/// to someone other than the joiner — cannot be produced by OpenMLS's own commit builders, so
/// there is no way to drive that branch end to end from this plan's tests. The member branch is
/// covered end to end by `mls_roundtrip.rs`.
pub(crate) fn removal_verdict(
    external: bool,
    committer_user: &UserId,
    target_user: &UserId,
) -> Result<(), ProtocolError> {
    if target_user == committer_user {
        return Ok(());
    }
    if external {
        // RFC 9420 §12.4.3.2 and protocol/01: an external commit may remove only the joiner's own
        // leaf, and the joiner is the committer.
        Err(ProtocolError::ExternalCommitRemove)
    } else {
        Err(ProtocolError::MemberRemoveForbidden)
    }
}

/// The user a leaf belongs to, read from the group's own pre-merge tree.
///
/// `PublicGroup::leaf(LeafNodeIndex) -> Option<&LeafNode>` is verified (facts-openmls §6). A
/// `Remove` names an index in the tree as it stands *before* the merge, which is exactly this view.
fn user_of_leaf(tree: &PublicGroup, leaf: LeafNodeIndex) -> Result<UserId, ProtocolError> {
    let node = tree.leaf(leaf).ok_or(ProtocolError::Credential)?;
    let basic =
        BasicCredential::try_from(node.credential().clone()).map_err(|_| ProtocolError::Credential)?;
    let identity = crate::identity::CredentialIdentity::decode(basic.identity())?;
    Ok(identity.user_id)
}
```

The two negative cases the contract names are covered as follows, and the split is deliberate:

- **a member `Remove` of another user's leaf** — `mls_roundtrip.rs`'s
  `a_member_commit_removing_another_users_leaf_is_refused_by_the_receiver` (step 2), end to end
  through `process_message`.
- **an external commit removing a foreign leaf** — `removal_verdict` directly, in the unit test
  below, because OpenMLS's `ExternalCommitBuilder` only ever removes leaves carrying the joiner's
  own credential, so the malicious commit cannot be built with the APIs this plan has. Add this
  test to `policy.rs`'s test module:

```rust
    #[test]
    fn a_removal_is_allowed_only_within_the_committers_own_user() {
        use crate::ids::UserId;
        let alice = UserId::from_bytes([0xaa; 16]);
        let bob = UserId::from_bytes([0xbb; 16]);

        // own-user device revocation, both as a member and inside an external commit
        assert_eq!(removal_verdict(false, &alice, &alice), Ok(()));
        assert_eq!(removal_verdict(true, &alice, &alice), Ok(()));

        // someone else's leaf: two different codes, and neither is silently accepted
        assert_eq!(
            removal_verdict(false, &alice, &bob),
            Err(ProtocolError::MemberRemoveForbidden)
        );
        assert_eq!(
            removal_verdict(true, &alice, &bob),
            Err(ProtocolError::ExternalCommitRemove)
        );
    }
```

- [ ] **Step 6: Write the group wrapper**

Create `core/dilla-core/src/mls/group.rs`:

```rust
//! The transactional `MlsGroup` wrapper.
//!
//! Every state-changing OpenMLS call runs inside one `BEGIN IMMEDIATE ... COMMIT`, because the
//! `StorageProvider` trait has no transaction hook and `merge_staged_commit` alone performs up to
//! 15 writes (gap-7 section 2.1). After a rollback the in-memory `MlsGroup` is invalid, so the
//! wrapper returns `MlsError::NeedsReload` and the caller reloads.

use super::{
    create_config, join_config, past_epoch_sweep, validate_staged_commit, DillaBinding,
    DillaProvider, GroupKind, StorageError, TxError, CIPHERSUITE,
};
use crate::envelope::Envelope;
use crate::error::ProtocolError;
use crate::ids::{DeviceId, UserId};
use crate::sframe::NK;
use openmls::extensions::ExternalSendersExtension;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum MlsError {
    #[error(transparent)]
    Protocol(ProtocolError),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("transaction: {0}")]
    Tx(String),
    #[error("openmls: {0}")]
    OpenMls(String),
    #[error("group handle is stale after a rollback; reload it")]
    NeedsReload,
    #[error("group not found")]
    NotFound,
}

impl<E: core::fmt::Debug> From<TxError<E>> for MlsError {
    fn from(e: TxError<E>) -> Self {
        match e {
            TxError::RolledBack(_) => MlsError::NeedsReload,
            other => MlsError::Tx(format!("{other:?}")),
        }
    }
}

/// What a committer uploads. `group_info` is **without** the ratchet tree (DS invariant 2).
///
/// OpenMLS produces one `Welcome` addressed to every member added by the commit; dilla's DS API
/// wants it per device, so the same blob is listed once per added device and the DS fans it out.
pub struct CommitBundle {
    pub commit: MlsMessageOut,
    pub welcomes: Vec<(DeviceId, MlsMessageOut)>,
    pub group_info: Option<GroupInfo>,
}

#[derive(Debug)]
pub enum DillaProcessed {
    Application(Envelope),
    Proposal(Box<QueuedProposal>),
    ExternalJoinProposal(Box<QueuedProposal>),
    StagedCommit(Box<StagedCommit>),
    OwnPendingCommit,
    OwnPrivateMessage,
}

pub struct DillaGroup {
    group: MlsGroup,
    binding: DillaBinding,
}

fn openmls<E: core::fmt::Debug>(e: E) -> MlsError {
    MlsError::OpenMls(format!("{e:?}"))
}

/// The user a credential belongs to, read from its `CredentialIdentity`.
fn user_of_credential(credential: &Credential) -> Result<UserId, MlsError> {
    let basic = BasicCredential::try_from(credential.clone()).map_err(openmls)?;
    crate::identity::CredentialIdentity::decode(basic.identity())
        .map(|id| id.user_id)
        .map_err(MlsError::Protocol)
}

/// The device a KeyPackage belongs to, read from its leaf credential.
fn device_of(kp: &KeyPackage) -> Result<DeviceId, MlsError> {
    // NEEDS VERIFICATION: `KeyPackage::leaf_node()` - task step 1 confirms the accessor.
    let credential = kp.leaf_node().credential().clone();
    let basic = BasicCredential::try_from(credential).map_err(openmls)?;
    let identity = crate::identity::CredentialIdentity::decode(basic.identity())
        .map_err(MlsError::Protocol)?;
    Ok(identity.device_id)
}

impl DillaGroup {
    /// T1 create: 8 writes in one transaction.
    pub fn create(
        provider: &DillaProvider,
        signer: &SignatureKeyPair,
        credential: CredentialWithKey,
        group_id: GroupId,
        binding: DillaBinding,
        ext_senders: Option<ExternalSendersExtension>,
    ) -> Result<Self, MlsError> {
        let config = create_config(&binding, ext_senders)?;
        let group = provider.storage().transaction(|| {
            MlsGroup::new_with_group_id(provider, signer, &config, group_id, credential)
                .map_err(openmls)
        })?;
        Ok(Self { group, binding })
    }

    pub fn load(provider: &DillaProvider, group_id: &GroupId) -> Result<Option<Self>, MlsError> {
        let Some(group) =
            MlsGroup::load(provider.storage(), group_id).map_err(MlsError::Storage)?
        else {
            return Ok(None);
        };
        let binding = DillaBinding::from_group_context(group.export_group_context())
            .map_err(MlsError::Protocol)?;
        Ok(Some(Self { group, binding }))
    }

    /// T2 welcome join. The binding is checked on the **staged** welcome, before `into_group`
    /// writes anything: a mismatched Welcome must leave no group behind.
    pub fn join_from_welcome(
        provider: &DillaProvider,
        welcome: Welcome,
        ratchet_tree: RatchetTreeIn,
        expected: &DillaBinding,
    ) -> Result<Self, MlsError> {
        let group = provider.storage().transaction(|| {
            let staged = StagedWelcome::new_from_welcome(
                provider,
                &join_config(expected.kind),
                welcome,
                Some(ratchet_tree),
            )
            .map_err(openmls)?;
            let binding = DillaBinding::from_group_context(staged.group_context())
                .map_err(MlsError::Protocol)?;
            binding.matches(expected).map_err(MlsError::Protocol)?;
            staged.into_group(provider).map_err(openmls)
        })?;
        Ok(Self { group, binding: expected.clone() })
    }

    /// T3 external join: 8 writes.
    pub fn join_by_external_commit(
        provider: &DillaProvider,
        signer: &SignatureKeyPair,
        credential: CredentialWithKey,
        group_info: VerifiableGroupInfo,
        ratchet_tree: RatchetTreeIn,
        expected: &DillaBinding,
    ) -> Result<(Self, MlsMessageOut, Option<GroupInfo>), MlsError> {
        let (group, commit, info) = provider.storage().transaction(|| {
            MlsGroup::join_by_external_commit(
                provider,
                signer,
                Some(ratchet_tree),
                group_info,
                &join_config(expected.kind),
                Some(super::leaf_capabilities()),
                None,
                &[],
                credential,
            )
            .map_err(openmls)
        })?;
        let binding = DillaBinding::from_group_context(group.export_group_context())
            .map_err(MlsError::Protocol)?;
        binding.matches(expected).map_err(MlsError::Protocol)?;
        Ok((Self { group, binding }, commit, info))
    }

    /// T4 create commit.
    pub fn add_members(
        &mut self,
        provider: &DillaProvider,
        signer: &SignatureKeyPair,
        key_packages: &[KeyPackage],
    ) -> Result<CommitBundle, MlsError> {
        if key_packages.len() > super::MAX_ADDS_PER_COMMIT {
            return Err(MlsError::Protocol(ProtocolError::Binding));
        }
        let devices: Vec<DeviceId> =
            key_packages.iter().map(device_of).collect::<Result<_, _>>()?;
        let group = &mut self.group;
        let (commit, welcome, group_info) = provider.storage().transaction(|| {
            group.add_members(provider, signer, key_packages).map_err(openmls)
        })?;
        Ok(CommitBundle {
            commit,
            welcomes: devices.into_iter().map(|d| (d, welcome.clone())).collect(),
            group_info,
        })
    }

    /// T4 create commit.
    pub fn remove_members(
        &mut self,
        provider: &DillaProvider,
        signer: &SignatureKeyPair,
        members: &[LeafNodeIndex],
    ) -> Result<CommitBundle, MlsError> {
        let group = &mut self.group;
        let (commit, welcome, group_info) = provider.storage().transaction(|| {
            group.remove_members(provider, signer, members).map_err(openmls)
        })?;
        // `CommitBundle.welcomes` is the DS's per-device fan-out key. OpenMLS emits a Welcome only
        // for a commit that adds members, so this is always `None` here; inventing an all-zero
        // `DeviceId` for it would address a Welcome to a device that does not exist. If a future
        // commit path ever both adds and removes, resolve the added devices the way `add_members`
        // does rather than reinstating a placeholder.
        debug_assert!(welcome.is_none(), "a remove-only commit emits no Welcome");
        Ok(CommitBundle { commit, welcomes: Vec::new(), group_info })
    }

    /// T4 create commit.
    pub fn self_update(
        &mut self,
        provider: &DillaProvider,
        signer: &SignatureKeyPair,
    ) -> Result<CommitBundle, MlsError> {
        let group = &mut self.group;
        let bundle = provider.storage().transaction(|| {
            // NEEDS VERIFICATION: `LeafNodeParameters::default()` and the `CommitMessageBundle`
            // destructuring - task step 1 confirms both.
            group
                .self_update(provider, signer, LeafNodeParameters::default())
                .map_err(openmls)
        })?;
        let (commit, welcome, group_info) = bundle.into_contents();
        // As in `remove_members`: an Update commit adds nobody, so there is no Welcome and no
        // device to address one to.
        debug_assert!(welcome.is_none(), "a self-update commit emits no Welcome");
        Ok(CommitBundle { commit, welcomes: Vec::new(), group_info })
    }

    /// T11 housekeeping: drop a staged commit that will never be merged.
    ///
    /// Two callers need this. The DS 409 loser — "the loser clears its pending commit" (spec line
    /// 591, `protocol/02-delivery-service.md` `commit_conflict`) — and task 13's fixture
    /// generator, which produces ten **alternative** commits at one epoch. Without it the group
    /// stays in `MlsGroupState::PendingCommit` after the first staged commit and every later
    /// `add_members` / `remove_members` / `self_update` fails with
    /// `MlsGroupStateError::PendingCommit`.
    ///
    /// `MlsGroup::clear_pending_commit` takes the **storage**, not the provider (facts-openmls
    /// §4.4, verified from source), and writes `group_state`, so it runs inside a transaction like
    /// every other state change (gap-7 §4, T11).
    pub fn clear_pending_commit(&mut self, provider: &DillaProvider) -> Result<(), MlsError> {
        let group = &mut self.group;
        provider.storage().transaction(|| {
            group.clear_pending_commit(provider.storage()).map_err(MlsError::Storage)
        })?;
        Ok(())
    }

    /// T5 merge: 13-15 writes.
    pub fn merge_pending_commit(&mut self, provider: &DillaProvider) -> Result<(), MlsError> {
        let group = &mut self.group;
        provider
            .storage()
            .transaction(|| group.merge_pending_commit(provider).map_err(openmls))?;
        self.sweep_past_epochs(provider)
    }

    /// T5 merge: 13-15 writes.
    ///
    /// Call this **only** with a `StagedCommit` that `process_message` handed back: that is where
    /// the proposal policy of protocol/01 is enforced (`validate_staged_commit`), and this method
    /// has neither the commit's `Sender` nor its pre-merge tree to re-check it.
    pub fn merge_staged_commit(
        &mut self,
        provider: &DillaProvider,
        staged: StagedCommit,
    ) -> Result<(), MlsError> {
        let group = &mut self.group;
        provider
            .storage()
            .transaction(|| group.merge_staged_commit(provider, staged).map_err(openmls))?;
        self.sweep_past_epochs(provider)
    }

    /// T6 send. The MLS `authenticated_data` is set to the envelope's 32-byte commitment before
    /// framing, which is what the DS reads and what the receiver checks.
    pub fn create_message(
        &mut self,
        provider: &DillaProvider,
        signer: &SignatureKeyPair,
        envelope: &Envelope,
    ) -> Result<MlsMessageOut, MlsError> {
        let commitment = envelope.commitment().map_err(MlsError::Protocol)?;
        let body = envelope.encode().map_err(MlsError::Protocol)?;
        let group = &mut self.group;
        // `transaction` returns `Result<T, TxError<MlsError>>`, not `Result<T, MlsError>`; every
        // other call site here ends in `?`, which applies `impl From<TxError<E>> for MlsError`.
        // Returning it directly would be a type error.
        let out = provider.storage().transaction(|| {
            // NEEDS VERIFICATION: `MlsGroup::set_aad` - task step 1 confirms the signature.
            group.set_aad(commitment.to_vec());
            group.create_message(provider, signer, &body).map_err(openmls)
        })?;
        Ok(out)
    }

    /// T7 receive. A `PublicMessage` writes nothing; a `PrivateMessage` writes the secret tree
    /// exactly once (gap-7 section 1.2).
    pub fn process_message(
        &mut self,
        provider: &DillaProvider,
        message: ProtocolMessage,
    ) -> Result<DillaProcessed, MlsError> {
        let group = &mut self.group;
        let processed = provider
            .storage()
            .transaction(|| group.process_message(provider, message).map_err(openmls))?;
        let aad = processed.authenticated_data().to_vec();
        // Read before `into_content` consumes the message. `sender()` and `credential()` are
        // verified accessors (facts-openmls section 4.10).
        let sender = processed.sender().clone();
        let committer_user = user_of_credential(processed.credential())?;
        Ok(match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app) => {
                let envelope = Envelope::decode(&app.into_bytes()).map_err(MlsError::Protocol)?;
                envelope.verify_commitment(&aad).map_err(MlsError::Protocol)?;
                DillaProcessed::Application(envelope)
            }
            ProcessedMessageContent::ProposalMessage(p) => DillaProcessed::Proposal(p),
            ProcessedMessageContent::ExternalJoinProposalMessage(p) => {
                DillaProcessed::ExternalJoinProposal(p)
            }
            ProcessedMessageContent::StagedCommitMessage(c) => {
                // The proposal policy of protocol/01-groups.md is enforced here, before the caller
                // ever sees the commit: `merge_staged_commit` is a separate call, and a caller
                // that skipped this check would install a commit the protocol forbids.
                // `public_group()` is the tree as it stands *before* the merge, which is the state
                // a `Remove` names.
                validate_staged_commit(
                    self.binding.kind,
                    &self.own_user()?,
                    &committer_user,
                    &sender,
                    self.group.public_group(),
                    c.as_ref(),
                )
                .map_err(MlsError::Protocol)?;
                DillaProcessed::StagedCommit(c)
            }
            ProcessedMessageContent::OwnPendingCommit => DillaProcessed::OwnPendingCommit,
            ProcessedMessageContent::OwnPrivateMessage => DillaProcessed::OwnPrivateMessage,
            other => return Err(MlsError::OpenMls(format!("unsupported content: {other:?}"))),
        })
    }

    /// T8 delete: 14 writes.
    pub fn delete(&mut self, provider: &DillaProvider) -> Result<(), MlsError> {
        let group = &mut self.group;
        provider
            .storage()
            .transaction(|| group.delete(provider.storage()).map_err(MlsError::Storage))?;
        Ok(())
    }

    /// T11 housekeeping. A no-op for pairing and interaction groups, which keep no past epochs.
    pub fn sweep_past_epochs(&mut self, provider: &DillaProvider) -> Result<(), MlsError> {
        let Some(policy) = past_epoch_sweep(self.binding.kind) else {
            return Ok(());
        };
        let group = &mut self.group;
        provider.storage().transaction(|| {
            group.delete_past_epoch_secrets(provider, policy).map_err(openmls)
        })?;
        Ok(())
    }

    pub fn binding(&self) -> &DillaBinding {
        &self.binding
    }

    pub fn kind(&self) -> GroupKind {
        self.binding.kind
    }

    pub fn group_id(&self) -> &GroupId {
        self.group.group_id()
    }

    pub fn epoch(&self) -> u64 {
        self.group.epoch().as_u64()
    }

    pub fn own_leaf_index(&self) -> LeafNodeIndex {
        self.group.own_leaf_index()
    }

    /// The user this device belongs to, read from its own leaf credential. `own_leaf_node` is in
    /// the 0.9.0 `MlsGroup` method index (facts-openmls §4.11); `LeafNode::credential()` is
    /// "Needs verification" item 9.
    fn own_user(&self) -> Result<UserId, MlsError> {
        let leaf = self.group.own_leaf_node().ok_or(MlsError::NotFound)?;
        user_of_credential(leaf.credential())
    }

    pub fn epoch_authenticator(&self) -> Result<[u8; 32], MlsError> {
        // NEEDS VERIFICATION: `EpochAuthenticator::as_slice()` - task step 1 confirms the accessor.
        let raw = self.group.epoch_authenticator().as_slice();
        if raw.len() != 32 {
            return Err(MlsError::OpenMls(format!("epoch authenticator is {} bytes", raw.len())));
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(raw);
        Ok(out)
    }

    /// `MLS-Exporter("SFrame 1.0 Base Key", "", 16)` - the spec's corrected definition.
    pub fn sframe_base_key(&self, provider: &DillaProvider) -> Result<[u8; NK], MlsError> {
        use openmls_traits::OpenMlsProvider as _;
        let raw = self
            .group
            .export_secret(provider.crypto(), crate::sframe::LABEL_BASE_KEY, &[], NK)
            .map_err(openmls)?;
        let mut out = [0u8; NK];
        out.copy_from_slice(&raw);
        Ok(out)
    }

    /// The GroupInfo a committer uploads: **without** the ratchet tree, because the DS serves the
    /// tree from its own `PublicGroup` (DS invariant 2).
    ///
    /// Returns the `MlsMessageOut` that carries it: `MlsGroup::export_group_info` returns a
    /// message, not a bare `GroupInfo` (facts-openmls section 4.7).
    pub fn export_group_info(
        &self,
        provider: &DillaProvider,
        signer: &SignatureKeyPair,
    ) -> Result<MlsMessageOut, MlsError> {
        use openmls_traits::OpenMlsProvider as _;
        self.group.export_group_info(provider.crypto(), signer, false).map_err(openmls)
    }

    pub fn export_ratchet_tree(&self) -> RatchetTree {
        self.group.export_ratchet_tree()
    }
}
```

- [ ] **Step 7: Declare the modules and extend `CoreError`**

In `core/dilla-core/src/mls/mod.rs`, extend the module block and the re-exports. `config` and
`group` join the SQLite half — `build_key_package` and every `DillaGroup` method take a
`&DillaProvider` — and therefore carry the same cfg as `provider`, `storage` and `tx` (see the
module doc written in task 9 step 6). `binding` and `policy` carry no SQLite and stay ungated:
`public_group` and, through it, `dilla-core-wasi` need `DillaBinding`, `GroupKind`,
`instance_sender_index` and the policy tables on `wasm32-wasip1`, where `rusqlite` does not exist.

```rust
mod binding;
mod policy;

#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
mod config;
#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
mod group;
#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
mod provider;
#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
mod storage;
#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
mod tx;

pub use binding::{
    external_senders, instance_credential, instance_credential_identity, instance_sender_index,
    DillaBinding, GroupKind, DILLA_BINDING, DILLA_BINDING_ID,
};
pub use policy::{
    past_epoch_policy, past_epoch_sweep, validate_staged_commit, CALL_SWEEP, PAST_EPOCHS_CALL,
    PAST_EPOCHS_TEXT, TEXT_SWEEP,
};

#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
pub use config::{
    build_key_package, create_config, group_context_extensions, join_config, leaf_capabilities,
    rotate_external_senders_extensions, CIPHERSUITE, INACTIVITY_REMOVE_DAYS,
    KEY_PACKAGE_LIFETIME_DAYS, MAX_ADDS_PER_COMMIT, PADDING_SIZE,
};
#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
pub use group::{CommitBundle, DillaGroup, DillaProcessed, MlsError};
#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
pub use provider::DillaProvider;
#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
pub use storage::{ConnHandle, DillaStorage};
#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
pub use tx::TxError;
```

`CoreError::Mls` wraps `MlsError`, which lives in the gated `group`, so the variant added below
carries the same cfg:

```rust
    #[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
    #[error(transparent)]
    Mls(#[from] crate::mls::MlsError),
```

(The `CoreError` variant above goes in `core/dilla-core/src/error.rs`, as the last variant.)

- [ ] **Step 8: Run the tests to verify they pass**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --locked
```

Expected: PASS, `0 failed; 0 ignored` — the unit tests plus the six integration tests in
`mls_roundtrip.rs`.

```bash
/home/thim/.cargo/bin/cargo clippy --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --all-targets --all-features --locked -- -D warnings
```

Expected: PASS with no warnings. `clippy::nonminimal_bool` is the one that would have caught
`!x.next().is_none()` in `policy.rs`.

Then both wasm targets, because this task adds four modules to `mls` and two of them are
SQLite-bound:

```bash
/home/thim/.cargo/bin/cargo build --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --features vectors --target wasm32-wasip1 --locked
```

Expected: PASS — `binding` and `policy` compile there, `config` and `group` are cfg'd out with the
rest of the SQLite half.

```bash
/home/thim/.cargo/bin/cargo build --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --features vectors --target wasm32-unknown-unknown --locked
```

Expected: PASS — the browser tier compiles the whole module.

```bash
/home/thim/.cargo/bin/cargo test --no-run --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --features vectors --target wasm32-unknown-unknown --locked
```

Expected: PASS. `tests/mls_roundtrip.rs` opens with `#![cfg(not(target_arch = "wasm32"))]` (step 2):
it drives a native SQLite file and a `trybuild`-free but thoroughly native provider, and part A2's
NV-9 requires every such integration test to carry that gate.

- [ ] **Step 9: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add core/dilla-core/src/mls core/dilla-core/src/error.rs core/dilla-core/tests/mls_roundtrip.rs && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(core): dilla_binding, group configuration and the transactional MLS group wrapper'
```
---

### Task 11: `PublicGroup` wrapper and the in-memory public storage

**Files:**
- Create: `core/dilla-core/src/public_group/mod.rs`, `storage.rs`, `state.rs`
- Modify: `core/dilla-core/src/lib.rs` (add `pub mod public_group;`)
- Test: unit tests in `storage.rs` and `state.rs`, plus integration coverage from `core/dilla-core/tests/mls_roundtrip.rs` (extended here)

**Interfaces:**
- Consumes: `cbor`, `ids`, `error`, `identity::CredentialIdentity`, `mls::{DillaBinding, GroupKind, DILLA_BINDING, DILLA_BINDING_ID, instance_sender_index}`.
- Produces, all under `public_group::`:
  `PublicStoreError { Codec(String), StateVersion(u8), Truncated }`;
  `PublicStore` with `STATE_VERSION: u8 = 1`, `new()`, `export(&self) -> Vec<u8>`, `import(&[u8]) -> Result<Self, PublicStoreError>`, `is_empty(&self) -> bool`, implementing `openmls_traits::public_storage::PublicStorageProvider<CURRENT_VERSION>` with `type PublicError = PublicStoreError` and **nothing else**;
  `PublicGroupError { Protocol, Store, OpenMls(String), StateMissing }`;
  `MemberInfo { leaf_index: u32, signature_key: [u8; 32], identity: CredentialIdentity }`;
  `PublicProcessed { Proposal { proposal_ref, sender_leaf }, ExternalJoinProposal { proposal_ref }, StagedCommit { staged, sender_leaf }, Rejected(ProtocolError) }`;
  `DillaPublicGroup` with `from_external`, `import_state`, `export_state`, `process_message`, `merge_commit`, `add_proposal`, `queue_proposal`, `remove_proposal`, `queued_proposals`, `export_ratchet_tree`, `tree_hash`, `group_id`, `epoch`, `binding`, `members`, `leaf`, `required_capabilities`, `ext_commit_sender_index`;
  `validate_key_package(&impl OpenMlsCrypto, KeyPackageIn) -> Result<KeyPackage, PublicGroupError>`;
  `external_propose_add(KeyPackage, GroupId, GroupEpoch, &impl Signer) -> Result<MlsMessageOut, PublicGroupError>`;
  `external_propose_remove(LeafNodeIndex, GroupId, GroupEpoch, &impl Signer) -> Result<MlsMessageOut, PublicGroupError>`.

Four facts that shape this module:

1. **`PublicStore` must implement only `PublicStorageProvider`.** `openmls_traits` ships a blanket
   impl of the public trait for every `StorageProvider`, so a type implementing both is `E0119`
   (gap-1 §3a). That is why `DillaStorage` and `PublicStore` are different types, and task 9's
   `trybuild` test pins it.
2. **`PublicGroup::load` returns `Ok(None)` on a torn write.** If any one of the four entities is
   missing it discards the other three and reports "absent", which is indistinguishable from "never
   stored" (gap-1 §6.1 hazard 1). The wrapper turns that into `StateMissing`, never into a new
   group, so a crash mid-write can never silently re-bootstrap over live state.
3. **`process_message` takes `&self` and writes nothing.** Structural validation is
   side-effect-free; state changes only through `merge_commit` and `add_proposal`
   (facts-openmls §6).
4. **`PublicGroup` has no `tree_hash()`**; it is `group_context().tree_hash()`.

- [ ] **Step 1: Write the failing tests**

Create `core/dilla-core/src/public_group/storage.rs` containing only the test module below. As in
task 9, it drives the provider with the **local** marker-implementing newtypes from
`crate::mls::test_entities` — `Vec<u8>`, `u32` and `String` implement none of
`openmls_traits::storage::traits`, and dilla cannot give them the impls (E0117) — and binds reads
with a `let` type annotation instead of a turbofish, so the tests do not depend on the order in
which each read declares its generic parameters.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mls::test_entities::{TKey, TVal};
    use openmls_traits::public_storage::PublicStorageProvider as _;

    fn gid() -> TKey {
        TKey(b"group-1".to_vec())
    }

    #[test]
    fn a_fresh_store_is_empty_and_reads_return_none() {
        let s = PublicStore::new();
        let g = TKey(b"g".to_vec());
        assert!(s.is_empty());
        let tree: Option<TVal> = s.tree(&g).unwrap();
        assert_eq!(tree, None);
        let context: Option<TVal> = s.group_context(&g).unwrap();
        assert_eq!(context, None);
        let interim: Option<TVal> = s.interim_transcript_hash(&g).unwrap();
        assert_eq!(interim, None);
        let tag: Option<TVal> = s.confirmation_tag(&g).unwrap();
        assert_eq!(tag, None);
        let none: Vec<(TKey, TVal)> = s.queued_proposals(&g).unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn the_four_entities_and_the_proposal_queue_round_trip_and_delete() {
        let s = PublicStore::new();
        let g = gid();
        let ref_a = TKey(b"ref-a".to_vec());
        let ref_b = TKey(b"ref-b".to_vec());
        s.write_tree(&g, &TVal(1)).unwrap();
        s.write_interim_transcript_hash(&g, &TVal(2)).unwrap();
        s.write_context(&g, &TVal(3)).unwrap();
        s.write_confirmation_tag(&g, &TVal(4)).unwrap();
        s.queue_proposal(&g, &ref_a, &TVal(5)).unwrap();
        s.queue_proposal(&g, &ref_b, &TVal(6)).unwrap();
        assert!(!s.is_empty());

        let tree: Option<TVal> = s.tree(&g).unwrap();
        assert_eq!(tree, Some(TVal(1)));
        let interim: Option<TVal> = s.interim_transcript_hash(&g).unwrap();
        assert_eq!(interim, Some(TVal(2)));
        let context: Option<TVal> = s.group_context(&g).unwrap();
        assert_eq!(context, Some(TVal(3)));
        let tag: Option<TVal> = s.confirmation_tag(&g).unwrap();
        assert_eq!(tag, Some(TVal(4)));
        let all: Vec<(TKey, TVal)> = s.queued_proposals(&g).unwrap();
        assert_eq!(all.len(), 2);

        s.remove_proposal(&g, &ref_a).unwrap();
        let all: Vec<(TKey, TVal)> = s.queued_proposals(&g).unwrap();
        assert_eq!(all.len(), 1);
        s.clear_proposal_queue::<TKey, TKey>(&g).unwrap();
        let all: Vec<(TKey, TVal)> = s.queued_proposals(&g).unwrap();
        assert!(all.is_empty());

        s.delete_tree(&g).unwrap();
        s.delete_confirmation_tag(&g).unwrap();
        s.delete_context(&g).unwrap();
        s.delete_interim_transcript_hash(&g).unwrap();
        assert!(s.is_empty());
    }

    #[test]
    fn export_and_import_round_trip_and_carry_a_version_byte() {
        let s = PublicStore::new();
        let g = gid();
        s.write_tree(&g, &TVal(1)).unwrap();
        s.write_context(&g, &TVal(3)).unwrap();
        s.queue_proposal(&g, &TKey(b"ref-a".to_vec()), &TVal(5)).unwrap();

        let blob = s.export();
        assert_eq!(blob[0], PublicStore::STATE_VERSION);

        let back = PublicStore::import(&blob).expect("import");
        let tree: Option<TVal> = back.tree(&g).unwrap();
        assert_eq!(tree, Some(TVal(1)));
        let context: Option<TVal> = back.group_context(&g).unwrap();
        assert_eq!(context, Some(TVal(3)));
        let all: Vec<(TKey, TVal)> = back.queued_proposals(&g).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(back.export(), blob, "export must be stable");
    }

    #[test]
    fn import_rejects_an_unknown_version_and_a_truncated_blob() {
        let s = PublicStore::new();
        s.write_tree(&TKey(b"g".to_vec()), &TVal(1)).unwrap();
        let mut blob = s.export();
        blob[0] = 9;
        assert_eq!(PublicStore::import(&blob), Err(PublicStoreError::StateVersion(9)));
        assert_eq!(PublicStore::import(&[]), Err(PublicStoreError::Truncated));

        let mut short = s.export();
        short.truncate(3);
        assert!(matches!(PublicStore::import(&short), Err(PublicStoreError::Codec(_))));
    }
}
```

Create `core/dilla-core/src/public_group/state.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mls::test_entities::TVal;
    use openmls_traits::public_storage::PublicStorageProvider as _;

    /// A torn write - one of the four entities missing - must surface as `StateMissing`, never as
    /// "this group does not exist" (gap-1 section 6.1 hazard 1).
    ///
    /// The key here is a real `openmls::group::GroupId`, which OpenMLS implements
    /// `traits::GroupId` for; only the entity side needs a local newtype.
    #[test]
    fn a_torn_state_is_reported_as_missing_not_as_absent() {
        let store = PublicStore::new();
        let group_id = openmls::group::GroupId::from_slice(&[0x44; 16]);
        // Three of the four entities present: exactly the shape a crash mid-`store()` leaves.
        store.write_tree(&group_id, &TVal(1)).unwrap();
        store.write_context(&group_id, &TVal(2)).unwrap();
        store.write_confirmation_tag(&group_id, &TVal(3)).unwrap();
        let blob = store.export();

        let err = DillaPublicGroup::import_state(&blob, &group_id)
            .expect_err("a torn state must not import");
        assert!(matches!(err, PublicGroupError::StateMissing), "{err:?}");
    }

    #[test]
    fn an_empty_state_is_reported_as_missing() {
        let group_id = openmls::group::GroupId::from_slice(&[0x44; 16]);
        let blob = PublicStore::new().export();
        assert!(matches!(
            DillaPublicGroup::import_state(&blob, &group_id),
            Err(PublicGroupError::StateMissing)
        ));
    }
}
```

Append to `core/dilla-core/tests/mls_roundtrip.rs` (it already has the helpers this needs):

```rust
use dilla_core::public_group::*;

#[test]
fn the_ds_view_tracks_the_group_from_a_group_info_and_a_tree() {
    let alice_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    alice_signer.store(alice_p.storage()).expect("store signer");
    let b = binding(GroupKind::Text);
    let alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        b.clone(),
        None,
    )
    .expect("create");

    let info_message = alice.export_group_info(&alice_p, &alice_signer).expect("group info");
    let verifiable = into_group_info(info_message);
    let crypto = openmls_rust_crypto::RustCrypto::default();
    let (ds, _committer_info) = DillaPublicGroup::from_external(
        &crypto,
        alice.export_ratchet_tree().into(),
        verifiable,
    )
    .expect("from_external");

    assert_eq!(ds.epoch(), alice.epoch());
    assert_eq!(ds.group_id(), alice.group_id());
    assert_eq!(ds.binding(), &b);
    assert_eq!(ds.members().len(), 1);
    assert!(ds.required_capabilities().is_some());

    // The tree hash the DS serves is the one in the group context it validated, and it is not
    // empty: a joiner compares this against the GroupInfo before trusting the membership list.
    assert!(!ds.tree_hash().is_empty());
    assert_eq!(ds.tree_hash().len(), 32, "SHA-256 over the tree");
}

#[test]
fn the_ds_view_processes_a_commit_merges_it_and_advances_the_epoch() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        b.clone(),
        None,
    )
    .expect("create");

    let info_message = alice.export_group_info(&alice_p, &alice_signer).expect("group info");
    let verifiable = into_group_info(info_message);
    let crypto = openmls_rust_crypto::RustCrypto::default();
    let (mut ds, _) =
        DillaPublicGroup::from_external(&crypto, alice.export_ratchet_tree().into(), verifiable)
            .expect("from_external");
    let before = ds.export_state();

    let bundle = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");

    let commit = into_protocol(bundle.commit);
    let staged = match ds.process_message(&crypto, commit).expect("process") {
        PublicProcessed::StagedCommit { staged, .. } => *staged,
        other => panic!("expected a staged commit, got {other:?}"),
    };
    ds.merge_commit(staged).expect("merge_commit");

    assert_eq!(ds.epoch(), alice.epoch());
    assert_eq!(ds.members().len(), 2);
    assert_ne!(ds.export_state(), before, "merging must change the exported state");

    // and the exported state reloads into an equivalent view
    let reloaded =
        DillaPublicGroup::import_state(&ds.export_state(), alice.group_id()).expect("import");
    assert_eq!(reloaded.epoch(), ds.epoch());
    assert_eq!(reloaded.tree_hash(), ds.tree_hash());
}

#[test]
fn the_ds_view_refuses_an_application_message() {
    let alice_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    alice_signer.store(alice_p.storage()).expect("store signer");
    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        b,
        None,
    )
    .expect("create");
    let info_message = alice.export_group_info(&alice_p, &alice_signer).expect("group info");
    let verifiable = into_group_info(info_message);
    let crypto = openmls_rust_crypto::RustCrypto::default();
    let (ds, _) =
        DillaPublicGroup::from_external(&crypto, alice.export_ratchet_tree().into(), verifiable)
            .expect("from_external");

    let message = alice
        .create_message(&alice_p, &alice_signer, &envelope("hello"))
        .expect("create_message");
    let protocol = into_protocol(message);
    match ds.process_message(&crypto, protocol).expect("process") {
        PublicProcessed::Rejected(_) => {}
        other => panic!("the DS must never accept a PrivateMessage, got {other:?}"),
    }
}

#[test]
fn validate_key_package_requires_the_binding_capability() {
    let bob_p = provider();
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    bob_signer.store(bob_p.storage()).expect("store signer");
    let crypto = openmls_rust_crypto::RustCrypto::default();

    let good = build_key_package(&bob_p, &bob_signer, bob_cred.clone(), false).expect("kp");
    let good_in: KeyPackageIn = good.key_package().clone().into();
    assert!(validate_key_package(&crypto, good_in).is_ok());

    let plain = KeyPackage::builder()
        .build(CIPHERSUITE, &bob_p, &bob_signer, bob_cred)
        .expect("kp");
    let plain_in: KeyPackageIn = plain.key_package().clone().into();
    let err = validate_key_package(&crypto, plain_in).expect_err("0xF001 is mandatory");
    assert!(matches!(err, PublicGroupError::Protocol(ProtocolError::Binding)), "{err:?}");
}

/// NV-4 and deviation A2-11, both settled by ruling: `queue_proposal` is the only route from a
/// received proposal message to a queued proposal, and what `queued_proposals()` hands back is the
/// **`MLSMessage` the DS received**, byte for byte - not a re-serialised bare `Proposal`, which has
/// lost its `FramedContent` and its signature and which no client could process.
#[test]
fn queue_proposal_keeps_the_mls_message_the_ds_received() {
    use tls_codec::{Deserialize as _, Serialize as _};

    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    // The instance key the DS signs external proposals with, installed as external sender 0 -
    // without it `PublicGroup::process_message` has nothing to verify the proposal against.
    let instance = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
    let instance_id = InstanceId::from_bytes([0x11; 16]);
    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        b,
        Some(external_senders(instance.public().into(), &instance_id)),
    )
    .expect("create");

    // Bob joins, so leaf 1 exists and can be the target of the Remove.
    let _bundle = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");

    let info_message = alice.export_group_info(&alice_p, &alice_signer).expect("group info");
    let crypto = openmls_rust_crypto::RustCrypto::default();
    let (mut ds, _) = DillaPublicGroup::from_external(
        &crypto,
        alice.export_ratchet_tree().into(),
        into_group_info(info_message),
    )
    .expect("from_external");

    // The DS proposes removing Bob, exactly as export 17 does, and then feeds its own message back
    // in over the wire, exactly as export 13 op 0 does.
    let out = external_propose_remove(
        LeafNodeIndex::new(1),
        alice.group_id().clone(),
        GroupEpoch::from(ds.epoch()),
        &instance,
    )
    .expect("external Remove proposal");
    let wire = out.tls_serialize_detached().expect("serialize");

    let received = MlsMessageIn::tls_deserialize_exact(&wire)
        .expect("deserialize")
        .try_into_protocol_message()
        .expect("a proposal is a ProtocolMessage");
    let reference = ds.queue_proposal(&crypto, received).expect("queue_proposal");
    assert!(!reference.is_empty(), "queue_proposal returns the new proposal's reference bytes");

    let queued = ds.queued_proposals().expect("queued_proposals");
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].0.as_slice(), reference.as_slice(), "the reference is the queued one");
    assert_eq!(
        queued[0].1, wire,
        "the DS must hand back the MLSMessage it received, byte for byte (deviation A2-11)"
    );

    // Removing the proposal drops the kept bytes with it: the map is bounded by the queue.
    ds.remove_proposal(&queued[0].0).expect("remove_proposal");
    assert!(ds.queued_proposals().expect("queued_proposals").is_empty());
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --locked
```

Declare the module first — step 1 only created the files, and an undeclared module is never
compiled, so this run would exit 0 with `0 tests` added instead of failing. Add step 5's
`pub mod public_group;` to `core/dilla-core/src/lib.rs` and `mod state; mod storage;` to
`public_group/mod.rs`, then re-run the command above.

Expected: FAIL, non-zero exit, with `error[E0412]: cannot find type PublicStore in this scope`,
`error[E0433]: failed to resolve: use of undeclared type DillaPublicGroup` and the other items
steps 3 and 4 have not written yet.

- [ ] **Step 3: Write the in-memory public store**

Prepend to `core/dilla-core/src/public_group/storage.rs`:

```rust
//! The 16-method `PublicStorageProvider`, in memory, with a versioned export.
//!
//! It implements **only** that trait. `openmls_traits` ships a blanket impl of the public trait
//! for every `StorageProvider`, so a type implementing both is `E0119` (gap-1 section 3a) - which
//! is why `mls::DillaStorage` and this are two types, not one with two impls.
//!
//! State lives in module memory rather than on a WASI filesystem (R9): dillad persists the blob
//! `export()` returns through `public_group_export_state`, in its own transaction, and hands it
//! back through `public_group_import_state`.

use crate::cbor::{decode_strict, Encoder};
use crate::mls::{CborCodec, DillaCodec};
use openmls_traits::public_storage::PublicStorageProvider;
use openmls_traits::storage::{traits, CURRENT_VERSION};
use serde::{de::DeserializeOwned, Serialize};
use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
#[non_exhaustive]
pub enum PublicStoreError {
    #[error("codec: {0}")]
    Codec(String),
    #[error("state version {0} unsupported")]
    StateVersion(u8),
    #[error("truncated state blob")]
    Truncated,
}

/// The four entity discriminants the public trait stores, and nothing else.
const TREE: u64 = 0;
const INTERIM_TRANSCRIPT_HASH: u64 = 1;
const CONTEXT: u64 = 2;
const CONFIRMATION_TAG: u64 = 3;

#[derive(Default)]
struct Inner {
    /// (group_id, discriminant) -> encoded entity
    group_data: BTreeMap<(Vec<u8>, u64), Vec<u8>>,
    /// (group_id, proposal_ref) -> encoded proposal
    proposals: BTreeMap<(Vec<u8>, Vec<u8>), Vec<u8>>,
}

#[derive(Default)]
pub struct PublicStore {
    inner: Mutex<Inner>,
}

impl PublicStore {
    /// Bumped whenever the blob layout changes. dillad stores it alongside the blob so an old
    /// server and a new module can tell each other apart rather than misparse.
    pub const STATE_VERSION: u8 = 1;

    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn enc<T: Serialize>(value: &T) -> Result<Vec<u8>, PublicStoreError> {
        CborCodec::to_vec(value).map_err(|e| PublicStoreError::Codec(e.to_string()))
    }

    fn dec<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, PublicStoreError> {
        CborCodec::from_slice(bytes).map_err(|e| PublicStoreError::Codec(e.to_string()))
    }

    pub fn is_empty(&self) -> bool {
        let inner = self.lock();
        inner.group_data.is_empty() && inner.proposals.is_empty()
    }

    /// `[STATE_VERSION] || CBOR([group_data, proposals])` where
    /// `group_data = [[group_id(bstr), discriminant(uint), value(bstr)], ...]` and
    /// `proposals = [[group_id(bstr), proposal_ref(bstr), proposal(bstr)], ...]`.
    /// Both maps are `BTreeMap`s, so the iteration order - and therefore the blob - is
    /// deterministic for a given state.
    pub fn export(&self) -> Vec<u8> {
        let inner = self.lock();
        let mut e = Encoder::with_capacity(4096);
        e.array(2);
        e.array(inner.group_data.len());
        for ((group_id, disc), value) in inner.group_data.iter() {
            e.array(3).bytes(group_id).uint(*disc).bytes(value);
        }
        e.array(inner.proposals.len());
        for ((group_id, proposal_ref), proposal) in inner.proposals.iter() {
            e.array(3).bytes(group_id).bytes(proposal_ref).bytes(proposal);
        }
        let mut out = Vec::with_capacity(e.as_slice().len() + 1);
        out.push(Self::STATE_VERSION);
        out.extend_from_slice(e.as_slice());
        out
    }

    pub fn import(bytes: &[u8]) -> Result<Self, PublicStoreError> {
        let (version, body) = bytes.split_first().ok_or(PublicStoreError::Truncated)?;
        if *version != Self::STATE_VERSION {
            return Err(PublicStoreError::StateVersion(*version));
        }
        let (group_data, proposals) = decode_strict(body, |d| {
            d.array(2)?;
            let n = d.array_len()?;
            let mut group_data = BTreeMap::new();
            for _ in 0..n {
                d.array(3)?;
                let group_id = d.bytes()?.to_vec();
                let disc = d.uint()?;
                group_data.insert((group_id, disc), d.bytes()?.to_vec());
            }
            let n = d.array_len()?;
            let mut proposals = BTreeMap::new();
            for _ in 0..n {
                d.array(3)?;
                let group_id = d.bytes()?.to_vec();
                let proposal_ref = d.bytes()?.to_vec();
                proposals.insert((group_id, proposal_ref), d.bytes()?.to_vec());
            }
            Ok((group_data, proposals))
        })
        .map_err(|e| PublicStoreError::Codec(e.to_string()))?;
        Ok(Self { inner: Mutex::new(Inner { group_data, proposals }) })
    }

    fn put_entity<K: Serialize, V: Serialize>(
        &self,
        group_id: &K,
        disc: u64,
        value: &V,
    ) -> Result<(), PublicStoreError> {
        let (g, v) = (Self::enc(group_id)?, Self::enc(value)?);
        self.lock().group_data.insert((g, disc), v);
        Ok(())
    }

    fn get_entity<K: Serialize, V: DeserializeOwned>(
        &self,
        group_id: &K,
        disc: u64,
    ) -> Result<Option<V>, PublicStoreError> {
        let g = Self::enc(group_id)?;
        let raw = self.lock().group_data.get(&(g, disc)).cloned();
        raw.map(|b| Self::dec(&b)).transpose()
    }

    fn del_entity<K: Serialize>(&self, group_id: &K, disc: u64) -> Result<(), PublicStoreError> {
        let g = Self::enc(group_id)?;
        self.lock().group_data.remove(&(g, disc));
        Ok(())
    }
}

impl PublicStorageProvider<CURRENT_VERSION> for PublicStore {
    type PublicError = PublicStoreError;

    fn write_tree<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        TreeSync: traits::TreeSync<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        tree: &TreeSync,
    ) -> Result<(), Self::PublicError> {
        self.put_entity(group_id, TREE, tree)
    }

    fn write_interim_transcript_hash<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        InterimTranscriptHash: traits::InterimTranscriptHash<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        interim_transcript_hash: &InterimTranscriptHash,
    ) -> Result<(), Self::PublicError> {
        self.put_entity(group_id, INTERIM_TRANSCRIPT_HASH, interim_transcript_hash)
    }

    fn write_context<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        GroupContext: traits::GroupContext<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        group_context: &GroupContext,
    ) -> Result<(), Self::PublicError> {
        self.put_entity(group_id, CONTEXT, group_context)
    }

    fn write_confirmation_tag<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ConfirmationTag: traits::ConfirmationTag<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        confirmation_tag: &ConfirmationTag,
    ) -> Result<(), Self::PublicError> {
        self.put_entity(group_id, CONFIRMATION_TAG, confirmation_tag)
    }

    fn queue_proposal<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
        QueuedProposal: traits::QueuedProposal<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        proposal_ref: &ProposalRef,
        proposal: &QueuedProposal,
    ) -> Result<(), Self::PublicError> {
        let (g, r, p) = (Self::enc(group_id)?, Self::enc(proposal_ref)?, Self::enc(proposal)?);
        self.lock().proposals.insert((g, r), p);
        Ok(())
    }

    fn queued_proposals<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
        QueuedProposal: traits::QueuedProposal<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<(ProposalRef, QueuedProposal)>, Self::PublicError> {
        let g = Self::enc(group_id)?;
        let rows: Vec<(Vec<u8>, Vec<u8>)> = self
            .lock()
            .proposals
            .iter()
            .filter(|((gid, _), _)| gid == &g)
            .map(|((_, r), p)| (r.clone(), p.clone()))
            .collect();
        rows.iter().map(|(r, p)| Ok((Self::dec(r)?, Self::dec(p)?))).collect()
    }

    fn tree<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        TreeSync: traits::TreeSync<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<TreeSync>, Self::PublicError> {
        self.get_entity(group_id, TREE)
    }

    fn group_context<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        GroupContext: traits::GroupContext<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<GroupContext>, Self::PublicError> {
        self.get_entity(group_id, CONTEXT)
    }

    fn interim_transcript_hash<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        InterimTranscriptHash: traits::InterimTranscriptHash<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<InterimTranscriptHash>, Self::PublicError> {
        self.get_entity(group_id, INTERIM_TRANSCRIPT_HASH)
    }

    fn confirmation_tag<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ConfirmationTag: traits::ConfirmationTag<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<ConfirmationTag>, Self::PublicError> {
        self.get_entity(group_id, CONFIRMATION_TAG)
    }

    fn delete_tree<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::PublicError> {
        self.del_entity(group_id, TREE)
    }

    fn delete_confirmation_tag<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::PublicError> {
        self.del_entity(group_id, CONFIRMATION_TAG)
    }

    fn delete_context<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::PublicError> {
        self.del_entity(group_id, CONTEXT)
    }

    fn delete_interim_transcript_hash<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::PublicError> {
        self.del_entity(group_id, INTERIM_TRANSCRIPT_HASH)
    }

    fn remove_proposal<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        proposal_ref: &ProposalRef,
    ) -> Result<(), Self::PublicError> {
        let (g, r) = (Self::enc(group_id)?, Self::enc(proposal_ref)?);
        self.lock().proposals.remove(&(g, r));
        Ok(())
    }

    /// Both type parameters are unconstrained by the arguments; OpenMLS turbofishes them at every
    /// call site and the body ignores both.
    fn clear_proposal_queue<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::PublicError> {
        let g = Self::enc(group_id)?;
        self.lock().proposals.retain(|(gid, _), _| gid != &g);
        Ok(())
    }
}
```

- [ ] **Step 4: Write the `PublicGroup` wrapper**

Prepend to `core/dilla-core/src/public_group/state.rs`:

```rust
//! The delivery service's view of a group: the public tree, the epoch, the extensions and the leaf
//! credentials. It holds no group secret and cannot decrypt.

use super::{PublicStore, PublicStoreError};
use crate::error::ProtocolError;
use crate::identity::CredentialIdentity;
use crate::mls::{instance_sender_index, DillaBinding, DILLA_BINDING, DILLA_BINDING_ID};
use openmls::prelude::*;
use std::collections::BTreeMap;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum PublicGroupError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error(transparent)]
    Store(#[from] PublicStoreError),
    #[error("openmls: {0}")]
    OpenMls(String),
    /// `PublicGroup::load` returns `Ok(None)` on a torn write - indistinguishable from "absent"
    /// (gap-1 section 6.1 hazard 1). The wrapper turns that into this error, never into a new
    /// group: re-bootstrapping over live state would silently fork every member.
    #[error("public group state is absent or torn")]
    StateMissing,
}

fn openmls<E: core::fmt::Debug>(e: E) -> PublicGroupError {
    PublicGroupError::OpenMls(format!("{e:?}"))
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct MemberInfo {
    pub leaf_index: u32,
    pub signature_key: [u8; 32],
    pub identity: CredentialIdentity,
}

#[derive(Debug)]
pub enum PublicProcessed {
    Proposal { proposal_ref: Vec<u8>, sender_leaf: Option<u32> },
    ExternalJoinProposal { proposal_ref: Vec<u8> },
    StagedCommit { staged: Box<StagedCommit>, sender_leaf: Option<u32> },
    /// The DS never sees an application message: `process_message` refuses a `PrivateMessage`.
    Rejected(ProtocolError),
}

pub struct DillaPublicGroup {
    group: PublicGroup,
    store: PublicStore,
    binding: DillaBinding,
    /// Deviation A2-11: the original `MLSMessage` bytes of every proposal `queue_proposal` accepted,
    /// keyed by the `ProposalRef`'s opaque bytes. The DS hands these back to clients verbatim; a
    /// re-serialised bare `Proposal` has lost its `FramedContent` and its signature and is not
    /// processable by the client that receives it.
    ///
    /// It lives here and **not** in `PublicStore`, so it is not part of `export_state()`. See
    /// `queued_proposals` for what a handle rebuilt by `import_state` reports.
    received: BTreeMap<Vec<u8>, Vec<u8>>,
}

fn sender_leaf(sender: &Sender) -> Option<u32> {
    match sender {
        Sender::Member(index) => Some(index.u32()),
        _ => None,
    }
}

impl DillaPublicGroup {
    /// Seeds the view from the first committer's GroupInfo and the ratchet tree, and verifies
    /// `dilla_binding` before returning. There is no tree-less variant: the DS must be seeded once
    /// and maintains the tree itself afterwards.
    pub fn from_external(
        crypto: &impl OpenMlsCrypto,
        ratchet_tree: RatchetTreeIn,
        group_info: VerifiableGroupInfo,
    ) -> Result<(Self, GroupInfo), PublicGroupError> {
        let store = PublicStore::new();
        let (group, info) =
            PublicGroup::from_external(crypto, &store, ratchet_tree, group_info, ProposalStore::new())
                .map_err(openmls)?;
        let binding = DillaBinding::from_group_context(group.group_context())?;
        Ok((Self { group, store, binding, received: BTreeMap::new() }, info))
    }

    pub fn import_state(state: &[u8], group_id: &GroupId) -> Result<Self, PublicGroupError> {
        let store = PublicStore::import(state)?;
        let group = PublicGroup::load(&store, group_id)
            .map_err(openmls)?
            .ok_or(PublicGroupError::StateMissing)?;
        let binding = DillaBinding::from_group_context(group.group_context())?;
        Ok(Self { group, store, binding, received: BTreeMap::new() })
    }

    pub fn export_state(&self) -> Vec<u8> {
        self.store.export()
    }

    /// `&self`: structural validation writes nothing (facts-openmls section 6). A `PrivateMessage`
    /// is refused outright - the DS holds no secret and must never be asked to decrypt.
    pub fn process_message(
        &self,
        crypto: &impl OpenMlsCrypto,
        message: ProtocolMessage,
    ) -> Result<PublicProcessed, PublicGroupError> {
        if matches!(message, ProtocolMessage::PrivateMessage(_)) {
            return Ok(PublicProcessed::Rejected(ProtocolError::EnvelopeShape));
        }
        let processed = self.group.process_message(crypto, message).map_err(openmls)?;
        let leaf = sender_leaf(processed.sender());
        Ok(match processed.into_content() {
            ProcessedMessageContent::ProposalMessage(p) => PublicProcessed::Proposal {
                // NEEDS VERIFICATION: `QueuedProposal::proposal_reference()` - confirm the
                // accessor against the vendored source before writing this line.
                proposal_ref: p.proposal_reference().as_slice().to_vec(),
                sender_leaf: leaf,
            },
            ProcessedMessageContent::ExternalJoinProposalMessage(p) => {
                PublicProcessed::ExternalJoinProposal {
                    proposal_ref: p.proposal_reference().as_slice().to_vec(),
                }
            }
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                PublicProcessed::StagedCommit { staged, sender_leaf: leaf }
            }
            _ => PublicProcessed::Rejected(ProtocolError::EnvelopeShape),
        })
    }

    pub fn merge_commit(&mut self, staged: StagedCommit) -> Result<(), PublicGroupError> {
        self.group.merge_commit(&self.store, staged).map_err(openmls)?;
        // `PublicGroup::merge_commit` calls `clear_proposal_queue` (gap-1 section 4's call table),
        // so the kept bytes go with the queue. Without this line the map grows for the lifetime of
        // the wazero instance - which R9 keeps alive for the whole dillad process - driven purely
        // by remote input. That is a memory-exhaustion path, not a tidiness question.
        self.received.clear();
        Ok(())
    }

    pub fn add_proposal(&mut self, proposal: QueuedProposal) -> Result<Vec<u8>, PublicGroupError> {
        // NEEDS VERIFICATION: `QueuedProposal::proposal_reference()`.
        let reference = proposal.proposal_reference().as_slice().to_vec();
        self.group.add_proposal(&self.store, proposal).map_err(openmls)?;
        Ok(reference)
    }

    /// Frames, verifies and queues a proposal the DS received, keeping the original `MLSMessage`
    /// bytes beside it (NV-4 and deviation A2-11, both settled by ruling). Returns the new
    /// proposal's reference bytes.
    ///
    /// This is the **only** route from received bytes to a queued proposal, and it lives here
    /// rather than in `dilla-core-wasi` because building a `QueuedProposal` needs the group context
    /// and signature verification: the wasi crate has no public OpenMLS 0.9.0 route from bytes to
    /// `AuthenticatedContent` and must not invent one. Task 14's `public_group_proposal_put` op 0
    /// is its caller.
    ///
    /// The kept bytes are re-framed from the `ProtocolMessage` rather than passed in beside it: TLS
    /// presentation encoding is canonical, so re-framing reproduces exactly what arrived on the
    /// wire, and there is no second copy for a caller to get wrong.
    pub fn queue_proposal(
        &mut self,
        crypto: &impl OpenMlsCrypto,
        message: ProtocolMessage,
    ) -> Result<Vec<u8>, PublicGroupError> {
        use tls_codec::Serialize as _;

        // The DS holds no group secret and must never be asked to decrypt, so a PrivateMessage is
        // refused here exactly as `process_message` refuses it.
        if matches!(message, ProtocolMessage::PrivateMessage(_)) {
            return Err(ProtocolError::EnvelopeShape.into());
        }

        // NEEDS VERIFICATION: `impl From<ProtocolMessage> for MlsMessageIn` on openmls 0.9.0.
        // `MlsMessageIn` derives `TlsSerialize` (gap-16 section 2's derive table, read from the
        // 0.9.0 tarball) and `impl TryFrom<MlsMessageIn> for ProtocolMessage` is recorded verbatim
        // in facts-openmls section 4.5, but the reverse conversion was never read from a source.
        // Read it from the vendored source before writing these three lines - the vendor directory
        // is the one task 9 step 1 produced - and correct the spelling if it differs:
        //   grep -n 'impl From<.*> for MlsMessageIn' \
        //     /tmp/claude-1000/-home-thim-Repositories-dilla/77aae878-1e83-42c6-a875-6c5e93f17581/scratchpad/vendor/openmls-0.9.0/src/framing/message_in.rs
        // If no such impl exists, match the two `ProtocolMessage` variants and go through
        // `MlsMessageIn::from(PublicMessageIn)` instead; nothing else in this method changes.
        let framed = MlsMessageIn::from(message);
        let received = framed.tls_serialize_detached().map_err(openmls)?;
        let message = ProtocolMessage::try_from(framed).map_err(openmls)?;

        let processed = self.group.process_message(crypto, message).map_err(openmls)?;
        let queued = match processed.into_content() {
            ProcessedMessageContent::ProposalMessage(p)
            | ProcessedMessageContent::ExternalJoinProposalMessage(p) => *p,
            // A Commit goes through `process_message` + `merge_commit`, never through the queue.
            _ => return Err(ProtocolError::EnvelopeShape.into()),
        };
        // NEEDS VERIFICATION: `QueuedProposal::proposal_reference()` and `ProposalRef::as_slice()`,
        // the same two accessors `process_message` and `add_proposal` above use.
        let reference = queued.proposal_reference().as_slice().to_vec();
        self.group.add_proposal(&self.store, queued).map_err(openmls)?;
        self.received.insert(reference.clone(), received);
        Ok(reference)
    }

    pub fn remove_proposal(&mut self, proposal_ref: &ProposalRef) -> Result<(), PublicGroupError> {
        self.group.remove_proposal(&self.store, proposal_ref).map_err(openmls)?;
        // NEEDS VERIFICATION: `ProposalRef::as_slice()`, as above.
        self.received.remove(proposal_ref.as_slice());
        Ok(())
    }

    /// Each pair is the proposal's reference and the original `MLSMessage` bytes the DS received -
    /// deviation A2-11. The second element is deliberately **not** a bare `Proposal`: interfaces
    /// section 2.12 hands this list
    /// straight back to clients in `CommitConflict { proposals }` and `CommitRequired { proposals }`,
    /// and a bare `Proposal` has lost its `FramedContent` and its signature, so the client that
    /// receives it cannot process what it got back.
    ///
    /// The bytes live in this wrapper, not in `PublicStore`, so they are not carried by
    /// `export_state()`. A handle rebuilt with `import_state` therefore returns `StateMissing` here
    /// for any proposal it did not queue itself, rather than inventing a re-serialised `Proposal`
    /// or handing back an empty byte string - either would be exactly the interoperability defect
    /// A2-11 exists to prevent.
    pub fn queued_proposals(&self) -> Result<Vec<(ProposalRef, Vec<u8>)>, PublicGroupError> {
        let queued = self.group.queued_proposals(&self.store).map_err(openmls)?;
        queued
            .into_iter()
            .map(|(reference, _queued): (ProposalRef, QueuedProposal)| {
                // NEEDS VERIFICATION: `ProposalRef::as_slice()`, as above.
                let message = self
                    .received
                    .get(reference.as_slice())
                    .cloned()
                    .ok_or(PublicGroupError::StateMissing)?;
                Ok((reference, message))
            })
            .collect()
    }

    pub fn export_ratchet_tree(&self) -> RatchetTree {
        self.group.export_ratchet_tree()
    }

    /// `PublicGroup` has no `tree_hash()`; it lives on the group context.
    pub fn tree_hash(&self) -> Vec<u8> {
        self.group.group_context().tree_hash().to_vec()
    }

    pub fn group_id(&self) -> &GroupId {
        self.group.group_id()
    }

    pub fn epoch(&self) -> u64 {
        self.group.group_context().epoch().as_u64()
    }

    pub fn binding(&self) -> &DillaBinding {
        &self.binding
    }

    pub fn members(&self) -> Vec<MemberInfo> {
        self.group
            .members()
            .filter_map(|m| {
                let basic = BasicCredential::try_from(m.credential.clone()).ok()?;
                let identity = CredentialIdentity::decode(basic.identity()).ok()?;
                let key = m.signature_key.as_slice();
                let mut signature_key = [0u8; 32];
                if key.len() != 32 {
                    return None;
                }
                signature_key.copy_from_slice(key);
                Some(MemberInfo { leaf_index: m.index.u32(), signature_key, identity })
            })
            .collect()
    }

    pub fn leaf(&self, index: LeafNodeIndex) -> Option<&LeafNode> {
        self.group.leaf(index)
    }

    pub fn required_capabilities(&self) -> Option<&RequiredCapabilitiesExtension> {
        self.group.group_context().extensions().required_capabilities()
    }

    pub fn ext_commit_sender_index(
        &self,
        staged: &StagedCommit,
    ) -> Result<LeafNodeIndex, PublicGroupError> {
        self.group.ext_commit_sender_index(staged).map_err(openmls)
    }
}

/// `KeyPackageIn::validate` plus dilla's own checks: the leaf must advertise 0xF001, and the
/// credential identity must decode. Both are invariant 6's "before proposing" gate.
pub fn validate_key_package(
    crypto: &impl OpenMlsCrypto,
    kp: KeyPackageIn,
) -> Result<KeyPackage, PublicGroupError> {
    let validated = kp.validate(crypto, ProtocolVersion::Mls10).map_err(openmls)?;
    // NEEDS VERIFICATION: `KeyPackage::leaf_node()`.
    let leaf = validated.leaf_node();
    if !leaf.capabilities().extensions().contains(&DILLA_BINDING) {
        return Err(ProtocolError::Binding.into());
    }
    let basic = BasicCredential::try_from(leaf.credential().clone()).map_err(openmls)?;
    CredentialIdentity::decode(basic.identity())?;
    Ok(validated)
}

/// The `Provider` type parameter of `ExternalProposal::new_*` is used for **nothing but its
/// error type** (`ProposeAddMemberError<Provider::StorageError>`; gap-16 §"External proposal
/// signing", facts-wazero §6: "all three constructors are generic over `Provider: OpenMlsProvider`
/// even though only the signer is used"). It must therefore not be `DillaProvider`, which exists
/// only on the two targets that have `rusqlite`: this module is the one the wasi tier is built
/// for, and naming `DillaProvider` here would drag SQLite back into the `wasm32-wasip1` build.
/// `openmls_rust_crypto::OpenMlsRustCrypto` is a full `OpenMlsProvider` over `MemoryStorage`
/// (facts-openmls §3), is already in the dependency graph on every target, and no instance of it
/// is ever created.
pub fn external_propose_add(
    kp: KeyPackage,
    group_id: GroupId,
    epoch: GroupEpoch,
    signer: &impl Signer,
) -> Result<MlsMessageOut, PublicGroupError> {
    ExternalProposal::new_add::<openmls_rust_crypto::OpenMlsRustCrypto>(
        kp,
        group_id,
        epoch,
        signer,
        instance_sender_index(),
    )
    .map_err(openmls)
}

pub fn external_propose_remove(
    removed: LeafNodeIndex,
    group_id: GroupId,
    epoch: GroupEpoch,
    signer: &impl Signer,
) -> Result<MlsMessageOut, PublicGroupError> {
    // Same provider-as-error-type-only parameter as `external_propose_add` above.
    ExternalProposal::new_remove::<openmls_rust_crypto::OpenMlsRustCrypto>(
        removed,
        group_id,
        epoch,
        signer,
        instance_sender_index(),
    )
    .map_err(openmls)
}
```

- [ ] **Step 5: Write the module root and declare it**

Create `core/dilla-core/src/public_group/mod.rs`:

```rust
//! The delivery service's structural view of a group.
//!
//! This module never holds a group secret. It exists so dillad - through the wasi ABI - can
//! validate every Proposal, Commit and GroupInfo, maintain the ratchet tree it serves to joiners,
//! and issue external Add and Remove proposals bound to the permission system.

mod state;
mod storage;

pub use state::{
    external_propose_add, external_propose_remove, validate_key_package, DillaPublicGroup,
    MemberInfo, PublicGroupError, PublicProcessed,
};
pub use storage::{PublicStore, PublicStoreError};
```

Add `pub mod public_group;` to `core/dilla-core/src/lib.rs`, keeping the list alphabetical:

```rust
pub mod cbor;
pub mod envelope;
pub mod error;
pub mod identity;
pub mod ids;
pub mod mls;
pub mod public_group;
pub mod sframe;
#[cfg(feature = "vectors")]
pub mod vectors;

pub use error::{CoreError, ProtocolError};
```

That is now exactly §2.0 of the interface contract.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --all-features --locked
```

Expected: PASS — every unit test plus the nine integration tests in `mls_roundtrip.rs` (the eighth
and ninth are `validate_key_package_requires_the_binding_capability` and
`queue_proposal_keeps_the_mls_message_the_ds_received`).

```bash
/home/thim/.cargo/bin/cargo build --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --features vectors --target wasm32-wasip1 --locked
```

Expected: PASS — `public_group` is what the wasi build exports, so it must compile there. Nothing
in this module may name `DillaProvider`, `DillaStorage` or `ConnHandle`: they do not exist on this
target (task 9 step 6), which is why `external_propose_add`/`_remove` instantiate
`OpenMlsRustCrypto` instead. `error[E0433]: failed to resolve: use of undeclared crate or module
rusqlite` means something in `mls` was left ungated.

```bash
/home/thim/.cargo/bin/cargo build --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --features vectors --target wasm32-unknown-unknown --locked
```

Expected: PASS — the browser tier, where the SQLite half compiles too.

```bash
/home/thim/.cargo/bin/cargo test --no-run --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --features vectors --target wasm32-unknown-unknown --locked
```

Expected: PASS — the unit tests of `public_group` build for the browser target; the native-only
integration tests are excluded by their own `#![cfg(not(target_arch = "wasm32"))]`.

```bash
/home/thim/.cargo/bin/cargo clippy --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-core --all-targets --all-features --locked -- -D warnings
```

Expected: PASS with no warnings.

- [ ] **Step 7: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add core/dilla-core/src/public_group core/dilla-core/src/lib.rs core/dilla-core/tests/mls_roundtrip.rs && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(core): PublicGroup wrapper with an exportable in-memory public store'
```
---

### Task 12: testkit v0 — DS stub, clients and the scenario DSL

**Files:**
- Create: `testkit/src/lib.rs` (replaces the task 1 stub), `testkit/src/client.rs`, `testkit/src/ds/mod.rs`, `testkit/src/ds/state.rs`, `testkit/src/ds/invariants.rs`, `testkit/src/scenario/mod.rs`, `testkit/src/scenario/parse.rs`, `testkit/src/scenario/run.rs`, `testkit/src/bin/dilla-testkit.rs` (replaces the stub), `testkit/scenarios/two-client-text.scn`, `testkit/scenarios/external-join.scn`, `testkit/scenarios/commit-conflict.scn`
- Test: unit tests in `parse.rs` and `invariants.rs`, plus `testkit/tests/scenarios.rs`

**Interfaces:**
- Consumes: `dilla_core::mls::{DillaGroup, DillaBinding, GroupKind, DillaProvider, build_key_package, CIPHERSUITE}`, `dilla_core::public_group::DillaPublicGroup`, `dilla_core::envelope::{Envelope, franking_tag, FrankingTagInput}`, `dilla_core::vectors::run_all`.
- Produces, all under `dilla_testkit::`:
  `InstanceConfig { instance_id, signing_key: [u8; 32], policy_version: u64, k_frank: [u8; 32] }`;
  `DsStub` with `new`, `register_group`, `publish_key_packages`, `take_key_package`, `group_info`, `ratchet_tree`, `post_commit`, `post_external_commit`, `post_proposal`, `post_message`, `handshakes`, `messages`, `ds_propose_add`, `ds_propose_remove`, `set_online`, `drain`, `public_group`;
  `DsError` with `code(&self) -> &'static str` and `http_status(&self) -> u16`;
  `RegisterGroup`, `GroupRegistered`, `GroupInfoResponse`, `TreeResponse`, `CommitUpload`, `CommitAccepted`, `MessageAccepted`, `HandshakeItem`, `MessageItem`, `Frame`;
  `TestClient` with `new`, `name`, `device_id`, `credential`, `publish_key_packages`, `create_group`, `join_welcome`, `join_external`, `send`, `remove`, `sync`, `inbox`;
  `Received`, `TestkitError`, `Stmt`, `Scenario`, `ParseError`, `parse`, `Runner`, `StepResult`, `RunReport`;
  the binary subcommands `dilla-testkit run <path.scn> [--seed N]` and `dilla-testkit vectors`.

**Scope, stated so it is not silently widened.** The stub enforces exactly **four** of
`protocol/02-delivery-service.md`'s eleven invariants (R20):

1. **Registration** — a group is registered with its `dilla_binding`; a malformed or mismatched
   binding is `BindingInvalid`, a duplicate `group_id` is `GroupExists`.
2. **Tree service** — committers upload a GroupInfo **without** the ratchet tree; the stub keeps a
   `DillaPublicGroup` and serves the tree and `tree_hash` from it.
3. **One commit per epoch** — the first valid Commit for epoch `n` wins; a later one for the same
   epoch gets `CommitConflict { winning_commit, proposals }`.
4. **KeyPackage directory** — `publish_key_packages` stores per device; `take_key_package` consumes
   an ordinary package and never the last-resort one.

Invariants **5 to 11** (freeze, void, committer election, current-leaf sends, fork handling,
retention, restore) are **out of scope for v0**. The methods that would enforce them succeed
without checking. They arrive with the dillad plan, not here.

- [ ] **Step 1: Write the failing tests**

Create `testkit/src/scenario/parse.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_verb_of_the_grammar() {
        let src = "\
# a comment, and the blank line below is ignored

instance dilla
client alice tier=native kind=user
client bob tier=browser
group chat kind=text target=33333333333333333333333333333333 community=none creator=alice
join bob chat
join bob chat via=external
external_join bob chat
send alice chat On my way. Grab the wolf capes.
expect_decrypts bob chat On my way. Grab the wolf capes.
remove alice chat bob
go_offline bob
go_online bob
sync alice
expect_reject E_BINDING join bob chat
";
        let s = parse(src, "grammar").expect("parse");
        assert_eq!(s.name, "grammar");
        assert_eq!(s.stmts.len(), 14);
        assert_eq!(s.lines.len(), s.stmts.len());
        // The first statement is on source line 3: line 1 is a comment and line 2 is blank.
        assert_eq!(s.lines[0], 3);
        assert!(matches!(s.stmts[0], Stmt::Instance { .. }));
        assert!(matches!(&s.stmts[1], Stmt::Client { tier: Tier::Native, kind: Kind::User, .. }));
        assert!(matches!(&s.stmts[2], Stmt::Client { tier: Tier::Browser, kind: Kind::User, .. }));
        match &s.stmts[3] {
            Stmt::Group { name, kind, target, community, creator } => {
                assert_eq!(name, "chat");
                assert_eq!(*kind, GroupKind::Text);
                assert_eq!(*target, [0x33; 16]);
                assert!(community.is_none());
                assert_eq!(creator, "alice");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(&s.stmts[4], Stmt::Join { external: false, .. }));
        assert!(matches!(&s.stmts[5], Stmt::Join { external: true, .. }));
        assert!(matches!(&s.stmts[6], Stmt::Join { external: true, .. }));
        match &s.stmts[7] {
            Stmt::Send { body, .. } => assert_eq!(body, "On my way. Grab the wolf capes."),
            other => panic!("{other:?}"),
        }
        assert!(matches!(&s.stmts[9], Stmt::Remove { .. }));
        assert!(matches!(&s.stmts[10], Stmt::GoOffline { .. }));
        assert!(matches!(&s.stmts[11], Stmt::GoOnline { .. }));
        assert!(matches!(&s.stmts[12], Stmt::Sync { .. }));
        match &s.stmts[13] {
            Stmt::ExpectReject { code, inner } => {
                assert_eq!(code, "E_BINDING");
                assert!(matches!(**inner, Stmt::Join { .. }));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn reports_the_line_number_of_a_syntax_error() {
        let err = parse("instance dilla\nclient alice\nnope alice\n", "bad").unwrap_err();
        assert_eq!(err.line, 3);
        assert!(err.message.contains("nope"), "{}", err.message);

        let err = parse("group chat kind=text\n", "bad").unwrap_err();
        assert_eq!(err.line, 1);

        let err = parse("client alice tier=quantum\n", "bad").unwrap_err();
        assert_eq!(err.line, 1);
        assert!(err.message.contains("tier"), "{}", err.message);

        let err = parse(
            "group chat kind=text target=zz creator=alice\n",
            "bad",
        )
        .unwrap_err();
        assert_eq!(err.line, 1);
    }

    #[test]
    fn every_committed_scenario_parses() {
        for (file, src) in [
            ("two-client-text.scn", include_str!("../../scenarios/two-client-text.scn")),
            ("external-join.scn", include_str!("../../scenarios/external-join.scn")),
            ("commit-conflict.scn", include_str!("../../scenarios/commit-conflict.scn")),
        ] {
            parse(src, file).unwrap_or_else(|e| panic!("{file}:{}: {}", e.line, e.message));
        }
    }
}
```

Create `testkit/src/ds/invariants.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use crate::{DsError, DsStub, InstanceConfig, RegisterGroup};
    use dilla_core::ids::InstanceId;
    use dilla_core::mls::{DillaBinding, GroupKind};

    fn config() -> InstanceConfig {
        InstanceConfig {
            instance_id: InstanceId::from_bytes([0x11; 16]),
            signing_key: [0x77; 32],
            policy_version: 1,
            k_frank: [0x09; 32],
        }
    }

    fn binding() -> DillaBinding {
        DillaBinding {
            v: 1,
            instance_id: InstanceId::from_bytes([0x11; 16]),
            community_id: None,
            target_id: [0x33; 16],
            kind: GroupKind::Text,
            policy_version: 1,
            e2ee_version: 1,
            media_version: 0,
        }
    }

    /// Invariant 1: a malformed binding is refused before anything is stored.
    #[test]
    fn register_group_refuses_a_malformed_binding() {
        let mut ds = DsStub::new(config());
        let err = ds
            .register_group(RegisterGroup {
                binding: vec![0xff, 0xff],
                group_info: Vec::new(),
                ratchet_tree: Vec::new(),
            })
            .expect_err("a malformed binding must be refused");
        assert!(matches!(err, DsError::BindingInvalid));
        assert_eq!(err.code(), "binding_invalid");
        assert_eq!(err.http_status(), 400);
    }

    /// Invariant 1: a binding naming another instance is refused.
    #[test]
    fn register_group_refuses_a_binding_for_another_instance() {
        let mut ds = DsStub::new(config());
        let mut foreign = binding();
        foreign.instance_id = InstanceId::from_bytes([0x99; 16]);
        let err = ds
            .register_group(RegisterGroup {
                binding: foreign.encode(),
                group_info: Vec::new(),
                ratchet_tree: Vec::new(),
            })
            .expect_err("another instance's binding must be refused");
        assert!(matches!(err, DsError::BindingInvalid));
    }

    /// Invariant 4: the KeyPackage directory consumes ordinary packages and never the last resort.
    #[test]
    fn take_key_package_never_consumes_the_last_resort_until_the_others_are_gone() {
        use dilla_core::ids::DeviceId;
        let mut ds = DsStub::new(config());
        let device = DeviceId::from_bytes([0x02; 16]);
        assert_eq!(
            ds.publish_key_packages(device, vec![b"kp-1".to_vec(), b"kp-2".to_vec()], b"last".to_vec())
                .unwrap(),
            2
        );
        let (first, was_last) = ds.take_key_package(&device).unwrap();
        assert_eq!(first, b"kp-1".to_vec());
        assert!(!was_last);
        let (second, was_last) = ds.take_key_package(&device).unwrap();
        assert_eq!(second, b"kp-2".to_vec());
        assert!(!was_last);
        // the ordinary packages are exhausted; the last-resort one is served but not consumed
        let (third, was_last) = ds.take_key_package(&device).unwrap();
        assert_eq!(third, b"last".to_vec());
        assert!(was_last);
        let (fourth, was_last) = ds.take_key_package(&device).unwrap();
        assert_eq!(fourth, b"last".to_vec());
        assert!(was_last);

        let unknown = DeviceId::from_bytes([0xee; 16]);
        assert!(matches!(ds.take_key_package(&unknown), Err(DsError::NotFound)));
    }

    #[test]
    fn ds_error_codes_and_statuses_match_protocol_02() {
        assert_eq!(DsError::ModeReadable.code(), "mode_readable");
        assert_eq!(DsError::ModeReadable.http_status(), 403);
        assert_eq!(DsError::GroupExists.code(), "group_exists");
        assert_eq!(DsError::GroupExists.http_status(), 409);
        assert_eq!(DsError::LeafNotCurrent.code(), "leaf_not_current");
        assert_eq!(DsError::LeafNotCurrent.http_status(), 403);
        assert_eq!(DsError::CommitmentInvalid.code(), "commitment_invalid");
        assert_eq!(DsError::CommitmentInvalid.http_status(), 422);
        assert_eq!(DsError::TooLarge.code(), "too_large");
        assert_eq!(DsError::TooLarge.http_status(), 413);
        assert_eq!(DsError::Pruned.code(), "pruned");
        assert_eq!(DsError::Pruned.http_status(), 410);
        assert_eq!(
            DsError::CommitConflict { winning_commit: Vec::new(), proposals: Vec::new() }.code(),
            "commit_conflict"
        );
        assert_eq!(
            DsError::CommitConflict { winning_commit: Vec::new(), proposals: Vec::new() }
                .http_status(),
            409
        );
        assert_eq!(DsError::CommitRequired { proposals: Vec::new() }.http_status(), 425);
        assert_eq!(DsError::CommitInvalid { reason: String::new() }.http_status(), 422);
        assert_eq!(DsError::NotFound.http_status(), 404);
    }
}
```

Create `testkit/tests/scenarios.rs`:

```rust
//! The three committed scenarios, end to end, against the in-memory delivery service.

use dilla_testkit::{parse, Runner};

fn run(name: &str, src: &str) {
    let scenario = parse(src, name).unwrap_or_else(|e| panic!("{name}:{}: {}", e.line, e.message));
    let mut runner = Runner::new(0x5eed);
    let report = runner.run(&scenario).unwrap_or_else(|e| panic!("{name}: {e}"));
    assert!(report.is_ok(), "{name}:\n{}", report.to_text());
}

#[test]
fn two_client_text_runs_green() {
    run("two-client-text", include_str!("../scenarios/two-client-text.scn"));
}

#[test]
fn external_join_runs_green() {
    run("external-join", include_str!("../scenarios/external-join.scn"));
}

#[test]
fn commit_conflict_runs_green() {
    run("commit-conflict", include_str!("../scenarios/commit-conflict.scn"));
}

/// `expect_reject` passes only when the inner statement fails with that exact code. A scenario
/// whose inner statement *succeeds* must fail the run, not pass it silently.
#[test]
fn expect_reject_fails_when_the_inner_statement_succeeds() {
    let src = "\
instance dilla
client alice
group chat kind=text target=33333333333333333333333333333333 creator=alice
expect_reject E_BINDING send alice chat hello
";
    let scenario = parse(src, "inverted").expect("parse");
    let mut runner = Runner::new(0x5eed);
    let report = runner.run(&scenario).expect("run");
    assert!(!report.is_ok(), "an inner statement that succeeded must fail the run");
    assert!(report.to_text().contains("E_BINDING"), "{}", report.to_text());
}

#[test]
fn the_vector_runner_is_green_from_the_testkit_too() {
    let report = dilla_core::vectors::run_all();
    assert!(report.is_ok(), "{}", report.to_text());
}
```

- [ ] **Step 2: Write the three scenarios**

Create `testkit/scenarios/two-client-text.scn`:

```
# Two clients, one text channel: create, add by Welcome, send, decrypt.
instance dilla
client alice tier=native kind=user
client bob tier=native kind=user
group chat kind=text target=33333333333333333333333333333333 community=none creator=alice
join bob chat via=welcome
send alice chat On my way. Grab the wolf capes from the chest by the portal.
sync bob
expect_decrypts bob chat On my way. Grab the wolf capes from the chest by the portal.
send bob chat Bringing the silver.
sync alice
expect_decrypts alice chat Bringing the silver.
```

Create `testkit/scenarios/external-join.scn`:

```
# Invariant 2: the joiner verifies tree_hash against the DS-served tree, then joins by external
# commit without a Welcome.
instance dilla
client alice tier=native kind=user
client bob tier=native kind=user
group chat kind=text target=44444444444444444444444444444444 community=none creator=alice
external_join bob chat
# Bob's external commit moved the group to epoch 1. Alice must merge it before she sends, or she
# frames the message at epoch 0 and Bob - who holds no epoch-0 secrets - cannot decrypt it.
sync alice
send alice chat The portal is open.
sync bob
expect_decrypts bob chat The portal is open.
```

Create `testkit/scenarios/commit-conflict.scn`:

```
# Invariant 3: one commit per epoch. Bob joins at epoch 1, goes offline so he never sees the commit
# that admits Carol, and his own commit for epoch 1 is refused with commit_conflict.
#
# The removal target is Alice, not Carol: Bob commits from his own epoch-1 view, where the members
# are Alice and himself. Carol's leaf does not exist there, so `remove bob chat carol` would fail
# inside OpenMLS with an unknown-member error and the scenario would pass for the wrong reason. The
# DS checks the epoch conflict before it validates anything else, so this asserts exactly
# invariant 3.
instance dilla
client alice tier=native kind=user
client bob tier=native kind=user
client carol tier=native kind=user
group chat kind=text target=55555555555555555555555555555555 community=none creator=alice
join bob chat via=welcome
go_offline bob
join carol chat via=welcome
expect_reject commit_conflict remove bob chat alice
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-testkit --locked
```

Expected: FAIL with `error[E0432]: unresolved import dilla_testkit::parse` and
`file not found for module ds`.

- [ ] **Step 4: Write the delivery-service stub**

Create `testkit/src/ds/mod.rs`:

```rust
//! An in-memory delivery service. It is a **test double**, not a specification: it enforces the
//! four week-1 invariants of protocol/02 and nothing else (R20). Invariants 5-11 arrive with the
//! dillad plan; the methods that would enforce them succeed without checking.

mod invariants;
mod state;

pub use state::{
    CommitAccepted, CommitUpload, DsError, DsStub, Frame, GroupInfoResponse, GroupRegistered,
    HandshakeItem, InstanceConfig, MessageAccepted, MessageItem, RegisterGroup, TreeResponse,
};
```

Create `testkit/src/ds/state.rs`:

```rust
use dilla_core::envelope::{franking_tag, FrankingTagInput};
use dilla_core::ids::{DeviceId, InstanceId};
use dilla_core::mls::DillaBinding;
use dilla_core::public_group::{DillaPublicGroup, PublicProcessed};
use openmls::prelude::*;
use std::collections::BTreeMap;

/// The stub parses exactly two things: a commit, so `DillaPublicGroup` can validate it, and the
/// ratchet tree it serves back. It never parses an application message — see `post_message`.
fn deserialize_protocol(bytes: &[u8]) -> Result<ProtocolMessage, String> {
    use tls_codec::Deserialize as _;
    MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(|e| format!("{e:?}"))?
        .try_into_protocol_message()
        .map_err(|e| format!("{e:?}"))
}

fn serialize_tree(tree: &RatchetTree) -> Result<Vec<u8>, DsError> {
    use tls_codec::Serialize as _;
    tree.tls_serialize_detached()
        .map_err(|e| DsError::CommitInvalid { reason: format!("{e:?}") })
}

/// What the instance is: its identity, its external-sender signing key, its policy snapshot and
/// the key it franks uploads under.
pub struct InstanceConfig {
    pub instance_id: InstanceId,
    pub signing_key: [u8; 32],
    pub policy_version: u64,
    pub k_frank: [u8; 32],
}

/// Exactly the codes protocol/02 "Errors" publishes.
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
#[non_exhaustive]
pub enum DsError {
    #[error("binding_invalid")]
    BindingInvalid,
    #[error("mode_readable")]
    ModeReadable,
    #[error("group_exists")]
    GroupExists,
    #[error("not_found")]
    NotFound,
    #[error("leaf_not_current")]
    LeafNotCurrent,
    #[error("commitment_invalid")]
    CommitmentInvalid,
    #[error("too_large")]
    TooLarge,
    #[error("pruned")]
    Pruned,
    #[error("commit_conflict")]
    CommitConflict { winning_commit: Vec<u8>, proposals: Vec<Vec<u8>> },
    #[error("commit_required")]
    CommitRequired { proposals: Vec<Vec<u8>> },
    #[error("commit_invalid")]
    CommitInvalid { reason: String },
}

impl DsError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::BindingInvalid => "binding_invalid",
            Self::ModeReadable => "mode_readable",
            Self::GroupExists => "group_exists",
            Self::NotFound => "not_found",
            Self::LeafNotCurrent => "leaf_not_current",
            Self::CommitmentInvalid => "commitment_invalid",
            Self::TooLarge => "too_large",
            Self::Pruned => "pruned",
            Self::CommitConflict { .. } => "commit_conflict",
            Self::CommitRequired { .. } => "commit_required",
            Self::CommitInvalid { .. } => "commit_invalid",
        }
    }

    pub fn http_status(&self) -> u16 {
        match self {
            Self::BindingInvalid => 400,
            Self::ModeReadable | Self::LeafNotCurrent => 403,
            Self::NotFound => 404,
            Self::GroupExists | Self::CommitConflict { .. } => 409,
            Self::Pruned => 410,
            Self::TooLarge => 413,
            Self::CommitmentInvalid | Self::CommitInvalid { .. } => 422,
            Self::CommitRequired { .. } => 425,
        }
    }
}

pub struct RegisterGroup {
    pub binding: Vec<u8>,
    pub group_info: Vec<u8>,
    pub ratchet_tree: Vec<u8>,
}
pub struct GroupRegistered {
    pub group_id: Vec<u8>,
    pub seq: u64,
}
pub struct GroupInfoResponse {
    pub epoch: u64,
    pub group_info: Vec<u8>,
    pub tree_hash: Vec<u8>,
    pub seq: u64,
}
pub struct TreeResponse {
    pub epoch: u64,
    pub ratchet_tree: Vec<u8>,
    pub tree_hash: Vec<u8>,
}
pub struct CommitUpload {
    pub epoch: u64,
    pub commit: Vec<u8>,
    pub group_info: Vec<u8>,
    pub welcomes: Vec<(DeviceId, Vec<u8>)>,
}
pub struct CommitAccepted {
    pub seq: u64,
    pub epoch: u64,
}
pub struct MessageAccepted {
    pub seq: u64,
    pub franking_tag: [u8; 32],
    pub recv_ts: u64,
}
#[derive(Clone, Debug)]
pub struct HandshakeItem {
    pub seq: u64,
    pub epoch: u64,
    /// 0 proposal, 1 commit, 2 external commit.
    pub kind: u8,
    pub sender: Option<u32>,
    pub blob: Vec<u8>,
}
#[derive(Clone, Debug)]
pub struct MessageItem {
    pub seq: u64,
    pub epoch: u64,
    pub uploader_device: DeviceId,
    pub blob: Vec<u8>,
    pub commitment: [u8; 32],
    pub franking_tag: [u8; 32],
    pub recv_ts: u64,
}
#[derive(Clone, Debug)]
pub enum Frame {
    MlsHandshake { group_id: Vec<u8>, item: HandshakeItem },
    MlsWelcome { group_id: Vec<u8>, blob: Vec<u8> },
    MlsEpochChanged { group_id: Vec<u8>, epoch: u64, seq: u64 },
    MessageCt { group_id: Vec<u8>, item: MessageItem },
}

struct GroupState {
    binding: DillaBinding,
    public: Option<DillaPublicGroup>,
    group_info: Vec<u8>,
    ratchet_tree: Vec<u8>,
    tree_hash: Vec<u8>,
    epoch: u64,
    /// Invariant 3: the commit that won each epoch, keyed by the epoch it was made at.
    winners: BTreeMap<u64, Vec<u8>>,
    proposals: Vec<Vec<u8>>,
    handshakes: Vec<HandshakeItem>,
    messages: Vec<MessageItem>,
    seq: u64,
    members: Vec<DeviceId>,
}

struct DeviceState {
    packages: Vec<Vec<u8>>,
    last_resort: Vec<u8>,
    online: bool,
    queue: Vec<Frame>,
}

pub struct DsStub {
    cfg: InstanceConfig,
    groups: BTreeMap<Vec<u8>, GroupState>,
    devices: BTreeMap<[u8; 16], DeviceState>,
    clock: u64,
}

impl DsStub {
    pub fn new(cfg: InstanceConfig) -> Self {
        Self { cfg, groups: BTreeMap::new(), devices: BTreeMap::new(), clock: 1_758_659_640 }
    }

    fn device(&mut self, device: &DeviceId) -> &mut DeviceState {
        self.devices.entry(*device.as_bytes()).or_insert_with(|| DeviceState {
            packages: Vec::new(),
            last_resort: Vec::new(),
            online: true,
            queue: Vec::new(),
        })
    }

    fn group(&self, group_id: &[u8]) -> Result<&GroupState, DsError> {
        self.groups.get(group_id).ok_or(DsError::NotFound)
    }

    fn fanout(&mut self, group_id: &[u8], frame: Frame, except: Option<DeviceId>) {
        let members = match self.groups.get(group_id) {
            Some(g) => g.members.clone(),
            None => return,
        };
        for device in members {
            if Some(device) == except {
                continue;
            }
            self.device(&device).queue.push(frame.clone());
        }
    }

    /// Invariant 1. The group is registered with its `dilla_binding`; the binding must decode and
    /// must name this instance.
    pub fn register_group(&mut self, req: RegisterGroup) -> Result<GroupRegistered, DsError> {
        let binding = DillaBinding::decode(&req.binding).map_err(|_| DsError::BindingInvalid)?;
        if binding.instance_id != self.cfg.instance_id {
            return Err(DsError::BindingInvalid);
        }
        let group_id = binding.target_id.to_vec();
        if self.groups.contains_key(&group_id) {
            return Err(DsError::GroupExists);
        }
        self.groups.insert(
            group_id.clone(),
            GroupState {
                binding,
                public: None,
                group_info: req.group_info,
                ratchet_tree: req.ratchet_tree,
                tree_hash: Vec::new(),
                epoch: 0,
                winners: BTreeMap::new(),
                proposals: Vec::new(),
                handshakes: Vec::new(),
                messages: Vec::new(),
                seq: 1,
                members: Vec::new(),
            },
        );
        Ok(GroupRegistered { group_id, seq: 1 })
    }

    /// Attaches the structural validator once the creator has published a tree. Invariant 2: from
    /// here on the stub serves the tree and `tree_hash` from its own `PublicGroup`, and
    /// `accept_commit` refuses a commit that `PublicGroup` will not accept.
    ///
    /// `TestClient::create_group` calls this immediately after `register_group`, with a
    /// `DillaPublicGroup` built from the very GroupInfo and tree it uploaded. A group whose
    /// `public` is `None` would serve a frozen epoch-0 tree for ever and validate nothing, so
    /// `accept_commit` treats that as `CommitInvalid` rather than silently accepting.
    pub fn attach_public_group(&mut self, group_id: &[u8], public: DillaPublicGroup) {
        if let Some(g) = self.groups.get_mut(group_id) {
            g.tree_hash = public.tree_hash();
            g.epoch = public.epoch();
            g.public = Some(public);
        }
    }

    pub fn add_member_device(&mut self, group_id: &[u8], device: DeviceId) {
        if let Some(g) = self.groups.get_mut(group_id) {
            if !g.members.contains(&device) {
                g.members.push(device);
            }
        }
    }

    /// Invariant 4.
    pub fn publish_key_packages(
        &mut self,
        device: DeviceId,
        packages: Vec<Vec<u8>>,
        last_resort: Vec<u8>,
    ) -> Result<usize, DsError> {
        let count = packages.len();
        let entry = self.device(&device);
        entry.packages.extend(packages);
        entry.last_resort = last_resort;
        Ok(count)
    }

    /// Invariant 4: ordinary packages are consumed; the last-resort package is served but never
    /// consumed. The bool says which was returned, so the caller knows it owes an `Update`.
    pub fn take_key_package(&mut self, device: &DeviceId) -> Result<(Vec<u8>, bool), DsError> {
        let entry = self.devices.get_mut(device.as_bytes()).ok_or(DsError::NotFound)?;
        // FIFO: the directory hands out the oldest unused package first, which is what
        // protocol/02-delivery-service.md's directory semantics describe and what the invariant-4
        // test asserts. `pop()` would serve them newest-first.
        if !entry.packages.is_empty() {
            return Ok((entry.packages.remove(0), false));
        }
        if entry.last_resort.is_empty() {
            return Err(DsError::NotFound);
        }
        Ok((entry.last_resort.clone(), true))
    }

    pub fn group_info(&self, group_id: &[u8]) -> Result<GroupInfoResponse, DsError> {
        let g = self.group(group_id)?;
        Ok(GroupInfoResponse {
            epoch: g.epoch,
            group_info: g.group_info.clone(),
            tree_hash: g.tree_hash.clone(),
            seq: g.seq,
        })
    }

    /// Invariant 2: the tree and its hash come from the stub's own `PublicGroup`, refreshed by
    /// every accepted commit, and from the creator's upload only for the single epoch between
    /// `register_group` and `attach_public_group`.
    ///
    /// Both this and `group_info` read `tree_hash` from the same `DillaPublicGroup`, because the
    /// stub keeps exactly one view of the group; the joiner-side comparison in
    /// `TestClient::join_external` therefore catches a stub that serves a tree and a GroupInfo
    /// from **different epochs**, not a forged tree. Forgery is caught one layer down, inside
    /// `join_by_external_commit`, which validates the served tree against the GroupInfo's own
    /// `tree_hash` before it joins.
    pub fn ratchet_tree(&self, group_id: &[u8]) -> Result<TreeResponse, DsError> {
        let g = self.group(group_id)?;
        Ok(TreeResponse {
            epoch: g.epoch,
            ratchet_tree: g.ratchet_tree.clone(),
            tree_hash: g.tree_hash.clone(),
        })
    }

    fn accept_commit(
        &mut self,
        group_id: &[u8],
        req: CommitUpload,
        kind: u8,
    ) -> Result<CommitAccepted, DsError> {
        let g = self.groups.get_mut(group_id).ok_or(DsError::NotFound)?;
        // Invariant 3: the first valid commit for an epoch wins.
        if let Some(winner) = g.winners.get(&req.epoch) {
            return Err(DsError::CommitConflict {
                winning_commit: winner.clone(),
                proposals: g.proposals.clone(),
            });
        }

        // Invariant 2 and the "**valid**" in invariant 3: the commit goes through the stub's own
        // `DillaPublicGroup` before it wins the epoch, and the tree, the tree hash and the epoch
        // the stub serves afterwards are the ones that view computed. Without this the stub would
        // serve the creator's bootstrap tree for ever and "first valid commit" would mean "first
        // commit".
        let public = g.public.as_mut().ok_or_else(|| DsError::CommitInvalid {
            reason: "no PublicGroup attached; call attach_public_group after register_group".into(),
        })?;
        let crypto = openmls_rust_crypto::RustCrypto::default();
        let message = deserialize_protocol(&req.commit)
            .map_err(|e| DsError::CommitInvalid { reason: e })?;
        let staged = match public.process_message(&crypto, message) {
            Ok(PublicProcessed::StagedCommit { staged, .. }) => *staged,
            Ok(other) => {
                return Err(DsError::CommitInvalid { reason: format!("not a commit: {other:?}") })
            }
            Err(e) => return Err(DsError::CommitInvalid { reason: format!("{e:?}") }),
        };
        public
            .merge_commit(staged)
            .map_err(|e| DsError::CommitInvalid { reason: format!("{e:?}") })?;
        let (tree, tree_hash, epoch_after) =
            (serialize_tree(&public.export_ratchet_tree())?, public.tree_hash(), public.epoch());

        g.winners.insert(req.epoch, req.commit.clone());
        g.epoch = epoch_after;
        g.ratchet_tree = tree;
        g.tree_hash = tree_hash;
        g.group_info = req.group_info;
        g.proposals.clear();
        let seq = g.seq;
        g.seq += 1;
        let item = HandshakeItem {
            seq,
            epoch: req.epoch,
            kind,
            sender: None,
            blob: req.commit.clone(),
        };
        g.handshakes.push(item.clone());
        let epoch = g.epoch;

        for (device, blob) in req.welcomes {
            self.add_member_device(group_id, device);
            self.device(&device)
                .queue
                .push(Frame::MlsWelcome { group_id: group_id.to_vec(), blob });
        }
        self.fanout(group_id, Frame::MlsHandshake { group_id: group_id.to_vec(), item }, None);
        self.fanout(
            group_id,
            Frame::MlsEpochChanged { group_id: group_id.to_vec(), epoch, seq },
            None,
        );
        Ok(CommitAccepted { seq, epoch })
    }

    pub fn post_commit(
        &mut self,
        group_id: &[u8],
        req: CommitUpload,
    ) -> Result<CommitAccepted, DsError> {
        self.accept_commit(group_id, req, 1)
    }

    pub fn post_external_commit(
        &mut self,
        group_id: &[u8],
        req: CommitUpload,
    ) -> Result<CommitAccepted, DsError> {
        self.accept_commit(group_id, req, 2)
    }

    pub fn post_proposal(
        &mut self,
        group_id: &[u8],
        epoch: u64,
        proposal: Vec<u8>,
    ) -> Result<u64, DsError> {
        let g = self.groups.get_mut(group_id).ok_or(DsError::NotFound)?;
        g.proposals.push(proposal.clone());
        let seq = g.seq;
        g.seq += 1;
        let item = HandshakeItem { seq, epoch, kind: 0, sender: None, blob: proposal };
        g.handshakes.push(item.clone());
        self.fanout(group_id, Frame::MlsHandshake { group_id: group_id.to_vec(), item }, None);
        Ok(seq)
    }

    /// The contract's `post_message`. The real DS reads the franking commitment `C` out of
    /// `private_message.authenticated_data`; this stub does not open application framing at all
    /// (deviation A1-11), so it has no commitment and refuses the upload with
    /// `CommitmentInvalid` — the same refusal the real DS makes when the commitment is missing.
    /// Test clients call `post_message_from`, which is handed `C` explicitly.
    pub fn post_message(
        &mut self,
        group_id: &[u8],
        epoch: u64,
        private_message: Vec<u8>,
    ) -> Result<MessageAccepted, DsError> {
        self.post_message_from(group_id, epoch, DeviceId::from_bytes([0u8; 16]), private_message, None)
    }

    /// The form the test client uses: it knows its own device and the commitment it computed.
    pub fn post_message_from(
        &mut self,
        group_id: &[u8],
        epoch: u64,
        uploader_device: DeviceId,
        private_message: Vec<u8>,
        commitment: Option<[u8; 32]>,
    ) -> Result<MessageAccepted, DsError> {
        let commitment = commitment.ok_or(DsError::CommitmentInvalid)?;
        let k_frank = self.cfg.k_frank;
        let recv_ts = self.clock;
        self.clock += 1;
        let g = self.groups.get_mut(group_id).ok_or(DsError::NotFound)?;
        let seq = g.seq;
        g.seq += 1;
        let group_id_bytes = {
            let mut out = [0u8; 16];
            let n = group_id.len().min(16);
            out[..n].copy_from_slice(&group_id[..n]);
            out
        };
        let tag = franking_tag(
            &k_frank,
            &FrankingTagInput {
                group_id: group_id_bytes,
                epoch,
                seq,
                uploader_device,
                commitment,
                recv_ts,
            },
        );
        let item = MessageItem {
            seq,
            epoch,
            uploader_device,
            blob: private_message,
            commitment,
            franking_tag: tag,
            recv_ts,
        };
        g.messages.push(item.clone());
        self.fanout(
            group_id,
            Frame::MessageCt { group_id: group_id.to_vec(), item },
            Some(uploader_device),
        );
        Ok(MessageAccepted { seq, franking_tag: tag, recv_ts })
    }

    pub fn handshakes(&self, group_id: &[u8], from: u64) -> Result<Vec<HandshakeItem>, DsError> {
        Ok(self.group(group_id)?.handshakes.iter().filter(|h| h.seq >= from).cloned().collect())
    }

    pub fn messages(&self, group_id: &[u8], from: u64) -> Result<Vec<MessageItem>, DsError> {
        Ok(self.group(group_id)?.messages.iter().filter(|m| m.seq >= from).cloned().collect())
    }

    /// Invariants 5 and 6 (freeze and void) are out of scope for v0: this records the proposal and
    /// returns its sequence number without a TTL or a freeze.
    pub fn ds_propose_add(
        &mut self,
        group_id: &[u8],
        key_package: Vec<u8>,
    ) -> Result<u64, DsError> {
        let epoch = self.group(group_id)?.epoch;
        self.post_proposal(group_id, epoch, key_package)
    }

    pub fn ds_propose_remove(&mut self, group_id: &[u8], leaf: u32) -> Result<u64, DsError> {
        let epoch = self.group(group_id)?.epoch;
        self.post_proposal(group_id, epoch, leaf.to_be_bytes().to_vec())
    }

    pub fn set_online(&mut self, device: &DeviceId, online: bool) {
        self.device(device).online = online;
    }

    /// An offline device's queue is left untouched: `go_offline` then `sync` must deliver nothing,
    /// which is what the commit-conflict scenario relies on.
    pub fn drain(&mut self, device: &DeviceId) -> Vec<Frame> {
        let entry = self.device(device);
        if !entry.online {
            return Vec::new();
        }
        core::mem::take(&mut entry.queue)
    }

    pub fn public_group(&self, group_id: &[u8]) -> Option<&DillaPublicGroup> {
        self.groups.get(group_id).and_then(|g| g.public.as_ref())
    }

    pub fn binding(&self, group_id: &[u8]) -> Option<&DillaBinding> {
        self.groups.get(group_id).map(|g| &g.binding)
    }

    pub fn epoch(&self, group_id: &[u8]) -> Option<u64> {
        self.groups.get(group_id).map(|g| g.epoch)
    }
}
```

- [ ] **Step 5: Write the test client**

Create `testkit/src/client.rs`:

```rust
//! A headless dilla client: a `DillaProvider` over an in-memory SQLite database, one signing key,
//! one credential and the groups it belongs to.

use crate::{DsError, DsStub, Frame, TestkitError};
use dilla_core::envelope::{Envelope, EnvelopeType};
use dilla_core::identity::{CredentialIdentity, Kind, SskSigner, Tier, UmkSigner};
use dilla_core::ids::{DeviceId, MsgId, UserId};
use dilla_core::mls::{
    build_key_package, DillaBinding, DillaGroup, DillaProcessed, DillaProvider, CIPHERSUITE,
};
use dilla_core::public_group::DillaPublicGroup;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct Received {
    pub group_id: Vec<u8>,
    pub seq: u64,
    pub sender: DeviceId,
    pub envelope: Envelope,
}

pub struct TestClient {
    name: String,
    device_id: DeviceId,
    provider: DillaProvider,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    groups: BTreeMap<Vec<u8>, DillaGroup>,
    inbox: Vec<Received>,
    next_msg: u64,
}

impl TestClient {
    /// `seed` makes every key deterministic, so a failing scenario reproduces exactly.
    pub fn new(
        name: &str,
        user_id: UserId,
        tier: Tier,
        kind: Kind,
        seed: u64,
    ) -> Result<Self, TestkitError> {
        let mut material = [0u8; 32];
        material[..8].copy_from_slice(&seed.to_be_bytes());
        material[8..16].copy_from_slice(&seed.wrapping_mul(0x9e37_79b9).to_be_bytes());
        let device_id = DeviceId::from_bytes({
            let mut id = [0u8; 16];
            id.copy_from_slice(&material[..16]);
            id
        });

        let conn = rusqlite::Connection::open_in_memory()
            .map_err(|e| TestkitError::Scenario(e.to_string()))?;
        let provider = DillaProvider::new(Arc::new(Mutex::new(conn)));
        provider.storage().migrate()?;

        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
            .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
        signer.store(provider.storage())?;

        let umk = UmkSigner::from_bytes(&material);
        let mut ssk_seed = material;
        ssk_seed[0] ^= 0x40;
        let ssk = SskSigner::from_bytes(&ssk_seed);
        let mut dsk_pub = [0u8; 32];
        let public = signer.public();
        if public.len() != 32 {
            return Err(TestkitError::Scenario("signature key is not 32 bytes".into()));
        }
        dsk_pub.copy_from_slice(public);

        let identity = CredentialIdentity {
            v: 1,
            umk_pub: umk.public(),
            user_id,
            device_id,
            kind,
            tier,
            signer_tier: match tier {
                Tier::Native => dilla_core::identity::SignerTier::Native,
                Tier::Browser => dilla_core::identity::SignerTier::Browser,
            },
            ssk_pub: ssk.public(),
            sig_umk_ssk: umk.sign_ssk(&ssk.public()),
            sig_ssk_dev: ssk.sign_device(
                &device_id,
                &dsk_pub,
                kind,
                tier,
                match tier {
                    Tier::Native => dilla_core::identity::SignerTier::Native,
                    Tier::Browser => dilla_core::identity::SignerTier::Browser,
                },
            ),
        };
        identity.verify_signatures(&dsk_pub)?;

        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.encode()).into(),
            signature_key: signer.public().into(),
        };

        Ok(Self {
            name: name.to_owned(),
            device_id,
            provider,
            signer,
            credential,
            groups: BTreeMap::new(),
            inbox: Vec::new(),
            next_msg: 1,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn device_id(&self) -> DeviceId {
        self.device_id
    }

    pub fn credential(&self) -> CredentialWithKey {
        self.credential.clone()
    }

    pub fn publish_key_packages(
        &mut self,
        ds: &mut DsStub,
        n: usize,
    ) -> Result<(), TestkitError> {
        let mut packages = Vec::with_capacity(n);
        for _ in 0..n {
            let kp =
                build_key_package(&self.provider, &self.signer, self.credential(), false)?;
            packages.push(serialize(kp.key_package())?);
        }
        let last =
            build_key_package(&self.provider, &self.signer, self.credential(), true)?;
        ds.publish_key_packages(self.device_id, packages, serialize(last.key_package())?)?;
        Ok(())
    }

    pub fn create_group(
        &mut self,
        ds: &mut DsStub,
        binding: DillaBinding,
    ) -> Result<Vec<u8>, TestkitError> {
        let group_id = GroupId::from_slice(&binding.target_id);
        let group = DillaGroup::create(
            &self.provider,
            &self.signer,
            self.credential(),
            group_id.clone(),
            binding.clone(),
            None,
        )?;
        let group_info = serialize(&group.export_group_info(&self.provider, &self.signer)?)?;
        let ratchet_tree = serialize(&group.export_ratchet_tree())?;
        let registered = ds.register_group(crate::RegisterGroup {
            binding: binding.encode(),
            group_info: group_info.clone(),
            ratchet_tree: ratchet_tree.clone(),
        })?;

        // Invariant 2: hand the DS the structural view it serves the tree and `tree_hash` from,
        // built from exactly the GroupInfo and tree just uploaded. Everything after this point -
        // every commit, every joiner - goes through it.
        let crypto = openmls_rust_crypto::RustCrypto::default();
        let (public, _committer_info) = DillaPublicGroup::from_external(
            &crypto,
            deserialize_tree(&ratchet_tree)?,
            deserialize_group_info(&group_info)?,
        )
        .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
        ds.attach_public_group(&registered.group_id, public);

        ds.add_member_device(&registered.group_id, self.device_id);
        self.groups.insert(registered.group_id.clone(), group);
        Ok(registered.group_id)
    }

    pub fn join_welcome(
        &mut self,
        ds: &mut DsStub,
        group_id: &[u8],
    ) -> Result<(), TestkitError> {
        let expected = ds
            .binding(group_id)
            .cloned()
            .ok_or_else(|| TestkitError::Scenario("unknown group".into()))?;
        let welcome_blob = ds
            .drain(&self.device_id)
            .into_iter()
            .find_map(|f| match f {
                Frame::MlsWelcome { group_id: g, blob } if g == group_id => Some(blob),
                _ => None,
            })
            .ok_or_else(|| TestkitError::Assertion("no welcome for this device".into()))?;
        let tree = ds.ratchet_tree(group_id)?;
        let welcome = deserialize_welcome(&welcome_blob)?;
        let group = DillaGroup::join_from_welcome(
            &self.provider,
            welcome,
            deserialize_tree(&tree.ratchet_tree)?,
            &expected,
        )?;
        ds.add_member_device(group_id, self.device_id);
        self.groups.insert(group_id.to_vec(), group);
        Ok(())
    }

    /// Invariant 2: verify `tree_hash` from the served GroupInfo against the served tree before
    /// joining. A joiner that skips this trusts the DS with the membership list.
    pub fn join_external(
        &mut self,
        ds: &mut DsStub,
        group_id: &[u8],
        expected: &DillaBinding,
    ) -> Result<(), TestkitError> {
        let info = ds.group_info(group_id)?;
        let tree = ds.ratchet_tree(group_id)?;
        // No `is_empty()` escape: an empty `tree_hash` means the DS has no structural view of the
        // group, and joining on a tree nobody validated is exactly what invariant 2 forbids.
        if info.tree_hash.is_empty() {
            return Err(TestkitError::Assertion("the DS served no tree_hash".into()));
        }
        if info.tree_hash != tree.tree_hash {
            return Err(TestkitError::Assertion("tree_hash does not match the served tree".into()));
        }
        let verifiable = deserialize_group_info(&info.group_info)?;
        let (group, commit, group_info) = DillaGroup::join_by_external_commit(
            &self.provider,
            &self.signer,
            self.credential(),
            verifiable,
            deserialize_tree(&tree.ratchet_tree)?,
            expected,
        )?;
        let epoch = info.epoch;
        // The joiner re-exports the GroupInfo from its own merged state either way, so the
        // `Option<GroupInfo>` the commit builder returned is not used here; it is named so the
        // unused-variable lint stays quiet and so a reader can see it was considered.
        let _ = &group_info;
        ds.post_external_commit(
            group_id,
            crate::CommitUpload {
                epoch,
                commit: serialize(&commit)?,
                group_info: serialize(&group.export_group_info(&self.provider, &self.signer)?)?,
                welcomes: Vec::new(),
            },
        )?;
        ds.add_member_device(group_id, self.device_id);
        self.groups.insert(group_id.to_vec(), group);
        Ok(())
    }

    pub fn send(
        &mut self,
        ds: &mut DsStub,
        group_id: &[u8],
        body: &str,
    ) -> Result<MsgId, TestkitError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| TestkitError::Scenario("not a member of this group".into()))?;
        let mut msg_id = [0u8; 16];
        msg_id[..8].copy_from_slice(&self.next_msg.to_be_bytes());
        msg_id[8..].copy_from_slice(self.device_id.as_bytes()[..8].try_into().expect("8 bytes"));
        self.next_msg += 1;
        let envelope = Envelope {
            v: 1,
            msg_id: MsgId::from_bytes(msg_id),
            kind: EnvelopeType::Message,
            thread_id: None,
            reply_to: None,
            body: body.to_owned(),
            attachments: Vec::new(),
            previews: Vec::new(),
            k_f: [0x06; 32],
        };
        let commitment = envelope.commitment()?;
        let out = group.create_message(&self.provider, &self.signer, &envelope)?;
        let epoch = group.epoch();
        ds.post_message_from(
            group_id,
            epoch,
            self.device_id,
            serialize(&out)?,
            Some(commitment),
        )?;
        Ok(envelope.msg_id)
    }

    pub fn remove(
        &mut self,
        ds: &mut DsStub,
        group_id: &[u8],
        target: DeviceId,
    ) -> Result<(), TestkitError> {
        // Resolve the target's leaf from the DS's structural view, which carries every member's
        // decoded `CredentialIdentity` (invariant 2). `remove <actor> <group> <target>` removes the
        // **target**; committing `own_leaf_index()` here would make every scenario remove its own
        // committer and would leave `E_MEMBER_REMOVE_FORBIDDEN` untested end to end.
        let leaf = ds
            .public_group(group_id)
            .ok_or_else(|| TestkitError::Assertion("the DS has no view of this group".into()))?
            .members()
            .into_iter()
            .find(|m| m.identity.device_id == target)
            .map(|m| LeafNodeIndex::new(m.leaf_index))
            .ok_or_else(|| {
                TestkitError::Assertion(format!("{} is not a member of this group", target.to_hex()))
            })?;
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| TestkitError::Scenario("not a member of this group".into()))?;
        let bundle = group.remove_members(&self.provider, &self.signer, &[leaf])?;
        let epoch = group.epoch();
        let accepted = ds.post_commit(
            group_id,
            crate::CommitUpload {
                epoch,
                commit: serialize(&bundle.commit)?,
                group_info: serialize(&group.export_group_info(&self.provider, &self.signer)?)?,
                welcomes: Vec::new(),
            },
        );
        if let Err(refused) = accepted {
            // Spec line 591 / protocol/02 `commit_conflict`: the loser of an epoch clears its
            // pending commit, syncs, and re-applies. Without this the group stays in
            // `MlsGroupState::PendingCommit` and every later commit from this client fails with
            // `MlsGroupStateError::PendingCommit` instead of the error the caller expects.
            group.clear_pending_commit(&self.provider)?;
            return Err(refused.into());
        }
        group.merge_pending_commit(&self.provider)?;
        Ok(())
    }

    /// Drains this device's queue and applies everything in order: handshakes first, then the
    /// application messages of the epoch they belong to.
    pub fn sync(&mut self, ds: &mut DsStub) -> Result<Vec<Received>, TestkitError> {
        let frames = ds.drain(&self.device_id);
        let mut new = Vec::new();
        for frame in frames {
            match frame {
                Frame::MlsWelcome { .. } | Frame::MlsEpochChanged { .. } => {}
                Frame::MlsHandshake { group_id, item } => {
                    if let Some(group) = self.groups.get_mut(&group_id) {
                        let message = deserialize_protocol(&item.blob)?;
                        if let DillaProcessed::StagedCommit(staged) =
                            group.process_message(&self.provider, message)?
                        {
                            group.merge_staged_commit(&self.provider, *staged)?;
                        }
                    }
                }
                Frame::MessageCt { group_id, item } => {
                    if let Some(group) = self.groups.get_mut(&group_id) {
                        let message = deserialize_protocol(&item.blob)?;
                        if let DillaProcessed::Application(envelope) =
                            group.process_message(&self.provider, message)?
                        {
                            let received = Received {
                                group_id: group_id.clone(),
                                seq: item.seq,
                                sender: item.uploader_device,
                                envelope,
                            };
                            self.inbox.push(received.clone());
                            new.push(received);
                        }
                    }
                }
            }
        }
        Ok(new)
    }

    pub fn inbox(&self) -> &[Received] {
        &self.inbox
    }
}

fn serialize<T: tls_codec::Serialize>(value: &T) -> Result<Vec<u8>, TestkitError> {
    value.tls_serialize_detached().map_err(|e| TestkitError::Scenario(format!("{e:?}")))
}

fn deserialize_message(bytes: &[u8]) -> Result<MlsMessageIn, TestkitError> {
    use tls_codec::Deserialize as _;
    MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(|e| TestkitError::Scenario(format!("{e:?}")))
}

fn deserialize_protocol(bytes: &[u8]) -> Result<ProtocolMessage, TestkitError> {
    deserialize_message(bytes)?
        .try_into_protocol_message()
        .map_err(|e| TestkitError::Scenario(format!("{e:?}")))
}

fn deserialize_welcome(bytes: &[u8]) -> Result<Welcome, TestkitError> {
    match deserialize_message(bytes)?.extract() {
        MlsMessageBodyIn::Welcome(w) => Ok(w),
        other => Err(TestkitError::Scenario(format!("expected a Welcome, got {other:?}"))),
    }
}

fn deserialize_group_info(bytes: &[u8]) -> Result<VerifiableGroupInfo, TestkitError> {
    match deserialize_message(bytes)?.extract() {
        MlsMessageBodyIn::GroupInfo(info) => Ok(info),
        other => Err(TestkitError::Scenario(format!("expected a GroupInfo, got {other:?}"))),
    }
}

fn deserialize_tree(bytes: &[u8]) -> Result<RatchetTreeIn, TestkitError> {
    use tls_codec::Deserialize as _;
    RatchetTreeIn::tls_deserialize_exact(bytes)
        .map_err(|e| TestkitError::Scenario(format!("{e:?}")))
}
```

- [ ] **Step 6: Write the scenario DSL**

Create `testkit/src/scenario/mod.rs`:

```rust
//! A line-oriented scenario language. UTF-8, LF, `.scn`. Blank lines and lines whose first
//! non-space character is `#` are ignored. The last argument of `send` and `expect_decrypts` is
//! the rest of the line after the group name, trimmed, so bodies may contain spaces.

mod parse;
mod run;

pub use parse::{parse, ParseError, Scenario, Stmt};
pub use run::{RunReport, Runner, StepResult};
```

Prepend to `testkit/src/scenario/parse.rs`:

```rust
use dilla_core::identity::{Kind, Tier};
use dilla_core::ids::CommunityId;
use dilla_core::mls::GroupKind;

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Stmt {
    Instance { name: String },
    Client { name: String, tier: Tier, kind: Kind },
    Sync { client: String },
    Group {
        name: String,
        kind: GroupKind,
        target: [u8; 16],
        community: Option<CommunityId>,
        creator: String,
    },
    Join { client: String, group: String, external: bool },
    Send { client: String, group: String, body: String },
    ExpectDecrypts { client: String, group: String, body: String },
    Remove { actor: String, group: String, target: String },
    GoOffline { client: String },
    GoOnline { client: String },
    ExpectReject { code: String, inner: Box<Stmt> },
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Scenario {
    pub name: String,
    pub stmts: Vec<Stmt>,
    /// The source line each statement came from, parallel to `stmts`. The parser skips comments
    /// and blank lines, so a statement's index is **not** its line; every committed `.scn` file
    /// opens with a comment, and `StepResult::line` has to point at something a reader can find.
    pub lines: Vec<usize>,
}

#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
#[error("line {line}: {message}")]
pub struct ParseError {
    pub line: usize,
    pub message: String,
}

fn err(line: usize, message: impl Into<String>) -> ParseError {
    ParseError { line, message: message.into() }
}

fn hex16(s: &str, line: usize) -> Result<[u8; 16], ParseError> {
    if s.len() != 32 {
        return Err(err(line, format!("expected 32 lowercase hex digits, got {s:?}")));
    }
    let mut out = [0u8; 16];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16)
            .map_err(|_| err(line, format!("not hex: {s:?}")))?;
    }
    Ok(out)
}

fn named<'a>(args: &[&'a str], key: &str) -> Option<&'a str> {
    args.iter().find_map(|a| a.strip_prefix(key))
}

fn parse_stmt(line_no: usize, tokens: &[&str], rest: &str) -> Result<Stmt, ParseError> {
    let verb = tokens[0];
    let args = &tokens[1..];
    let need = |n: usize| -> Result<(), ParseError> {
        if args.len() < n {
            Err(err(line_no, format!("{verb} needs {n} argument(s)")))
        } else {
            Ok(())
        }
    };

    Ok(match verb {
        "instance" => {
            need(1)?;
            Stmt::Instance { name: args[0].to_owned() }
        }
        "client" => {
            need(1)?;
            let tier = match named(args, "tier=") {
                None | Some("native") => Tier::Native,
                Some("browser") => Tier::Browser,
                Some(other) => return Err(err(line_no, format!("unknown tier {other:?}"))),
            };
            let kind = match named(args, "kind=") {
                None | Some("user") => Kind::User,
                Some("bot") => Kind::Bot,
                Some(other) => return Err(err(line_no, format!("unknown kind {other:?}"))),
            };
            Stmt::Client { name: args[0].to_owned(), tier, kind }
        }
        "sync" => {
            need(1)?;
            Stmt::Sync { client: args[0].to_owned() }
        }
        "group" => {
            need(1)?;
            let kind = match named(args, "kind=") {
                Some("text") => GroupKind::Text,
                Some("call") => GroupKind::Call,
                Some("pairing") => GroupKind::Pairing,
                Some("interaction") => GroupKind::Interaction,
                Some(other) => return Err(err(line_no, format!("unknown group kind {other:?}"))),
                None => return Err(err(line_no, "group needs kind=")),
            };
            let target = hex16(
                named(args, "target=").ok_or_else(|| err(line_no, "group needs target="))?,
                line_no,
            )?;
            let community = match named(args, "community=") {
                None | Some("none") => None,
                Some(hex) => Some(CommunityId::from_bytes(hex16(hex, line_no)?)),
            };
            let creator = named(args, "creator=")
                .ok_or_else(|| err(line_no, "group needs creator="))?
                .to_owned();
            Stmt::Group { name: args[0].to_owned(), kind, target, community, creator }
        }
        "join" => {
            need(2)?;
            let external = matches!(named(args, "via="), Some("external"));
            if let Some(via) = named(args, "via=") {
                if via != "welcome" && via != "external" {
                    return Err(err(line_no, format!("unknown via= {via:?}")));
                }
            }
            Stmt::Join { client: args[0].to_owned(), group: args[1].to_owned(), external }
        }
        "external_join" => {
            need(2)?;
            Stmt::Join { client: args[0].to_owned(), group: args[1].to_owned(), external: true }
        }
        "send" | "expect_decrypts" => {
            need(2)?;
            let body = rest.trim().to_owned();
            if body.is_empty() {
                return Err(err(line_no, format!("{verb} needs a body")));
            }
            if verb == "send" {
                Stmt::Send { client: args[0].to_owned(), group: args[1].to_owned(), body }
            } else {
                Stmt::ExpectDecrypts {
                    client: args[0].to_owned(),
                    group: args[1].to_owned(),
                    body,
                }
            }
        }
        "remove" => {
            need(3)?;
            Stmt::Remove {
                actor: args[0].to_owned(),
                group: args[1].to_owned(),
                target: args[2].to_owned(),
            }
        }
        "go_offline" => {
            need(1)?;
            Stmt::GoOffline { client: args[0].to_owned() }
        }
        "go_online" => {
            need(1)?;
            Stmt::GoOnline { client: args[0].to_owned() }
        }
        "expect_reject" => {
            need(2)?;
            let inner_tokens: Vec<&str> = tokens[2..].to_vec();
            let inner_rest = rest_after(rest, 1);
            Stmt::ExpectReject {
                code: args[0].to_owned(),
                inner: Box::new(parse_stmt(line_no, &inner_tokens, &inner_rest)?),
            }
        }
        other => return Err(err(line_no, format!("unknown statement {other:?}"))),
    })
}

/// The tail of a line after `skip` further whitespace-separated tokens.
fn rest_after(rest: &str, skip: usize) -> String {
    let mut remaining = rest.trim_start();
    for _ in 0..skip {
        match remaining.find(char::is_whitespace) {
            Some(at) => remaining = remaining[at..].trim_start(),
            None => return String::new(),
        }
    }
    remaining.to_owned()
}

pub fn parse(src: &str, name: &str) -> Result<Scenario, ParseError> {
    let mut stmts = Vec::new();
    let mut lines = Vec::new();
    for (index, raw) in src.lines().enumerate() {
        let line_no = index + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        // Everything after the third token, used as the free-text body of send/expect_decrypts.
        let rest = rest_after(line, 3);
        stmts.push(parse_stmt(line_no, &tokens, &rest)?);
        lines.push(line_no);
    }
    Ok(Scenario { name: name.to_owned(), stmts, lines })
}
```

Create `testkit/src/scenario/run.rs`:

```rust
//! Executes a parsed scenario against one `DsStub` and N `TestClient`s.

use super::{Scenario, Stmt};
use crate::{DsStub, InstanceConfig, TestClient, TestkitError};
use dilla_core::ids::{InstanceId, UserId};
use dilla_core::mls::{DillaBinding, GroupKind};
use std::collections::BTreeMap;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StepResult {
    pub line: usize,
    pub stmt: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RunReport {
    pub steps: Vec<StepResult>,
}

impl RunReport {
    pub fn is_ok(&self) -> bool {
        self.steps.iter().all(|s| s.ok)
    }

    pub fn to_text(&self) -> String {
        let mut out = String::new();
        for step in &self.steps {
            out.push_str(&format!(
                "{} line {}: {} {}\n",
                if step.ok { "ok  " } else { "FAIL" },
                step.line,
                step.stmt,
                step.detail
            ));
        }
        out
    }
}

struct GroupRef {
    id: Vec<u8>,
    binding: DillaBinding,
}

pub struct Runner {
    seed: u64,
    clients: BTreeMap<String, TestClient>,
    groups: BTreeMap<String, GroupRef>,
    ds: Option<DsStub>,
    instance_id: InstanceId,
}

impl Runner {
    pub fn new(seed: u64) -> Self {
        Self {
            seed,
            clients: BTreeMap::new(),
            groups: BTreeMap::new(),
            ds: None,
            instance_id: InstanceId::from_bytes([0x11; 16]),
        }
    }

    fn ds(&mut self) -> Result<&mut DsStub, TestkitError> {
        self.ds
            .as_mut()
            .ok_or_else(|| TestkitError::Scenario("no `instance` statement yet".into()))
    }

    pub fn run(&mut self, scenario: &Scenario) -> Result<RunReport, TestkitError> {
        let mut steps = Vec::new();
        for (index, stmt) in scenario.stmts.iter().enumerate() {
            // The source line, not the statement's position: the parser drops comments and blank
            // lines, and every committed scenario opens with a comment.
            let line = scenario.lines.get(index).copied().unwrap_or(index + 1);
            let label = format!("{stmt:?}");
            let outcome = self.exec(stmt);
            let (ok, detail) = match (stmt, outcome) {
                (Stmt::ExpectReject { code, .. }, Ok(())) => {
                    (false, format!("expected rejection {code}, but it succeeded"))
                }
                (Stmt::ExpectReject { code, .. }, Err(e)) => {
                    let text = e.to_string();
                    (text.contains(code.as_str()), format!("got {text}, wanted {code}"))
                }
                (_, Ok(())) => (true, String::new()),
                (_, Err(e)) => (false, e.to_string()),
            };
            steps.push(StepResult { line, stmt: label, ok, detail });
            if !ok {
                break;
            }
        }
        Ok(RunReport { steps })
    }

    fn exec(&mut self, stmt: &Stmt) -> Result<(), TestkitError> {
        match stmt {
            Stmt::ExpectReject { inner, .. } => return self.exec(inner),
            Stmt::Instance { .. } => {
                self.ds = Some(DsStub::new(InstanceConfig {
                    instance_id: self.instance_id,
                    signing_key: [0x77; 32],
                    policy_version: 1,
                    k_frank: [0x09; 32],
                }));
                return Ok(());
            }
            _ => {}
        }

        match stmt {
            Stmt::Client { name, tier, kind } => {
                let seed = self.seed.wrapping_add(self.clients.len() as u64 + 1);
                let mut user = [0u8; 16];
                user[..8].copy_from_slice(&seed.to_be_bytes());
                let mut client =
                    TestClient::new(name, UserId::from_bytes(user), *tier, *kind, seed)?;
                let ds = self
                    .ds
                    .as_mut()
                    .ok_or_else(|| TestkitError::Scenario("no `instance` statement yet".into()))?;
                client.publish_key_packages(ds, 4)?;
                self.clients.insert(name.clone(), client);
                Ok(())
            }
            Stmt::Group { name, kind, target, community, creator } => {
                let binding = DillaBinding {
                    v: 1,
                    instance_id: self.instance_id,
                    community_id: *community,
                    target_id: *target,
                    kind: *kind,
                    policy_version: 1,
                    e2ee_version: 1,
                    media_version: kind.media_version(),
                };
                let mut client = self.take(creator)?;
                let ds = self.ds()?;
                let id = client.create_group(ds, binding.clone())?;
                self.clients.insert(creator.clone(), client);
                self.groups.insert(name.clone(), GroupRef { id, binding });
                Ok(())
            }
            Stmt::Join { client, group, external } => {
                let target = self.group(group)?;
                let (id, binding) = (target.id.clone(), target.binding.clone());
                // `invite` takes the joiner out of the map itself (to read its device id), so it
                // must run **before** the joiner is taken here: taking twice returns
                // `unknown client <joiner>` and every `join … via=welcome` fails.
                if !*external {
                    self.invite(client, group)?;
                }
                let mut actor = self.take(client)?;
                let result = if *external {
                    let ds = self
                        .ds
                        .as_mut()
                        .ok_or_else(|| TestkitError::Scenario("no `instance` statement yet".into()))?;
                    actor.join_external(ds, &id, &binding)
                } else {
                    let ds = self
                        .ds
                        .as_mut()
                        .ok_or_else(|| TestkitError::Scenario("no `instance` statement yet".into()))?;
                    actor.join_welcome(ds, &id)
                };
                self.clients.insert(client.clone(), actor);
                result
            }
            Stmt::Send { client, group, body } => {
                let id = self.group(group)?.id.clone();
                let mut actor = self.take(client)?;
                let ds = self.ds()?;
                let result = actor.send(ds, &id, body).map(|_| ());
                self.clients.insert(client.clone(), actor);
                result
            }
            Stmt::ExpectDecrypts { client, group, body } => {
                let id = self.group(group)?.id.clone();
                let mut actor = self.take(client)?;
                let ds = self.ds()?;
                let _ = actor.sync(ds)?;
                let found = actor
                    .inbox()
                    .iter()
                    .any(|r| r.group_id == id && r.envelope.body == *body);
                self.clients.insert(client.clone(), actor);
                if found {
                    Ok(())
                } else {
                    Err(TestkitError::Assertion(format!("{client} never decrypted {body:?}")))
                }
            }
            Stmt::Sync { client } => {
                let mut actor = self.take(client)?;
                let ds = self.ds()?;
                let result = actor.sync(ds).map(|_| ());
                self.clients.insert(client.clone(), actor);
                result
            }
            Stmt::Remove { actor, group, target } => {
                let id = self.group(group)?.id.clone();
                let victim = self.take(target)?;
                let device = victim.device_id();
                self.clients.insert(target.clone(), victim);
                let mut committer = self.take(actor)?;
                let ds = self.ds()?;
                let result = committer.remove(ds, &id, device);
                self.clients.insert(actor.clone(), committer);
                result
            }
            Stmt::GoOffline { client } | Stmt::GoOnline { client } => {
                let online = matches!(stmt, Stmt::GoOnline { .. });
                let actor = self.take(client)?;
                let device = actor.device_id();
                self.clients.insert(client.clone(), actor);
                self.ds()?.set_online(&device, online);
                Ok(())
            }
            Stmt::Instance { .. } | Stmt::ExpectReject { .. } => Ok(()),
        }
    }

    /// The inviter commits an Add for `joiner`, so a `join ... via=welcome` has a Welcome waiting.
    fn invite(&mut self, joiner: &str, group: &str) -> Result<(), TestkitError> {
        let id = self.group(group)?.id.clone();
        let inviter_name = self
            .clients
            .keys()
            .find(|n| n.as_str() != joiner)
            .cloned()
            .ok_or_else(|| TestkitError::Scenario("no client can invite".into()))?;
        let joiner_client = self.take(joiner)?;
        let device = joiner_client.device_id();
        self.clients.insert(joiner.to_owned(), joiner_client);

        let mut inviter = self.take(&inviter_name)?;
        let ds = self.ds()?;
        let result = inviter.invite(ds, &id, device);
        self.clients.insert(inviter_name, inviter);
        result
    }

    fn take(&mut self, name: &str) -> Result<TestClient, TestkitError> {
        self.clients
            .remove(name)
            .ok_or_else(|| TestkitError::Scenario(format!("unknown client {name}")))
    }

    fn group(&self, name: &str) -> Result<&GroupRef, TestkitError> {
        self.groups
            .get(name)
            .ok_or_else(|| TestkitError::Scenario(format!("unknown group {name}")))
    }
}
```

Add the `invite` method to `testkit/src/client.rs`, next to `join_welcome`:

```rust
    /// Takes a KeyPackage for `device` from the directory, commits the Add and uploads the commit
    /// with one Welcome addressed to that device.
    pub fn invite(
        &mut self,
        ds: &mut DsStub,
        group_id: &[u8],
        device: DeviceId,
    ) -> Result<(), TestkitError> {
        let (blob, _was_last_resort) = ds.take_key_package(&device)?;
        let key_package = {
            use tls_codec::Deserialize as _;
            let incoming = KeyPackageIn::tls_deserialize_exact(&blob)
                .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
            use openmls_traits::OpenMlsProvider as _;
            dilla_core::public_group::validate_key_package(self.provider.crypto(), incoming)
                .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?
        };
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| TestkitError::Scenario("not a member of this group".into()))?;
        let epoch = group.epoch();
        let bundle = group.add_members(&self.provider, &self.signer, &[key_package])?;
        let welcomes = bundle
            .welcomes
            .iter()
            .map(|(d, w)| Ok((*d, serialize(w)?)))
            .collect::<Result<Vec<_>, TestkitError>>()?;
        ds.post_commit(
            group_id,
            crate::CommitUpload {
                epoch,
                commit: serialize(&bundle.commit)?,
                group_info: serialize(&group.export_group_info(&self.provider, &self.signer)?)?,
                welcomes,
            },
        )?;
        group.merge_pending_commit(&self.provider)?;
        Ok(())
    }
```

- [ ] **Step 7: Write the crate root and the binary**

`testkit/src/client.rs` serialises and deserialises MLS objects, so add `tls_codec` to
`[dependencies]` in `testkit/Cargo.toml`:

```toml
tls_codec = { version = "0.5.0", features = ["derive", "serde", "mls"] }
```

Replace `testkit/src/lib.rs`:

```rust
//! dilla-testkit v0: N headless native `dilla-core` clients against an in-memory delivery service,
//! driven by a line-oriented scenario language.
//!
//! The stub enforces the four week-1 DS invariants (registration with the binding, tree service,
//! one commit per epoch, the KeyPackage directory) and nothing else. Invariants 5-11 belong to the
//! dillad plan; the methods that would enforce them here succeed without checking.

mod client;
mod ds;
mod scenario;

pub use client::{Received, TestClient};
pub use ds::{
    CommitAccepted, CommitUpload, DsError, DsStub, Frame, GroupInfoResponse, GroupRegistered,
    HandshakeItem, InstanceConfig, MessageAccepted, MessageItem, RegisterGroup, TreeResponse,
};
pub use scenario::{parse, ParseError, RunReport, Runner, Scenario, StepResult, Stmt};

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum TestkitError {
    #[error(transparent)]
    Ds(#[from] DsError),
    #[error(transparent)]
    Core(#[from] dilla_core::CoreError),
    #[error("scenario: {0}")]
    Scenario(String),
    #[error("assertion: {0}")]
    Assertion(String),
}

impl From<dilla_core::ProtocolError> for TestkitError {
    fn from(e: dilla_core::ProtocolError) -> Self {
        TestkitError::Core(e.into())
    }
}

impl From<dilla_core::mls::MlsError> for TestkitError {
    fn from(e: dilla_core::mls::MlsError) -> Self {
        TestkitError::Core(e.into())
    }
}

impl From<dilla_core::mls::StorageError> for TestkitError {
    fn from(e: dilla_core::mls::StorageError) -> Self {
        TestkitError::Core(e.into())
    }
}
```

Replace `testkit/src/bin/dilla-testkit.rs`:

```rust
use clap::{Parser, Subcommand};
use dilla_testkit::{parse, Runner};

#[derive(Parser)]
#[command(name = "dilla-testkit", about = "dilla's headless multi-client harness")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run one scenario file.
    Run {
        path: std::path::PathBuf,
        #[arg(long, default_value_t = 0x5eed)]
        seed: u64,
    },
    /// Check the committed protocol vectors and print the report.
    Vectors,
}

fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Run { path, seed } => {
            let src = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("{}: {e}", path.display());
                    return std::process::ExitCode::from(2);
                }
            };
            let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let scenario = match parse(&src, &name) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("{}:{}: {}", path.display(), e.line, e.message);
                    return std::process::ExitCode::from(2);
                }
            };
            let mut runner = Runner::new(seed);
            match runner.run(&scenario) {
                Ok(report) => {
                    print!("{}", report.to_text());
                    if report.is_ok() {
                        std::process::ExitCode::SUCCESS
                    } else {
                        std::process::ExitCode::FAILURE
                    }
                }
                Err(e) => {
                    eprintln!("{e}");
                    std::process::ExitCode::FAILURE
                }
            }
        }
        Command::Vectors => {
            let report = dilla_core::vectors::run_all();
            print!("{}", report.to_text());
            if report.is_ok() {
                std::process::ExitCode::SUCCESS
            } else {
                std::process::ExitCode::FAILURE
            }
        }
    }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-testkit --locked
```

Expected: PASS — the parser tests, the four invariant tests and the five scenario tests.

```bash
/home/thim/.cargo/bin/cargo run --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-testkit --bin dilla-testkit --locked -- vectors
```

Expected: PASS, exit 0, printing five suite lines and `passed N failed 0`.

```bash
/home/thim/.cargo/bin/cargo run --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-testkit --bin dilla-testkit --locked -- run /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/testkit/scenarios/two-client-text.scn
```

Expected: PASS, exit 0, one `ok` line per statement.

```bash
/home/thim/.cargo/bin/cargo clippy --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-testkit --all-targets --locked -- -D warnings
```

Expected: PASS with no warnings.

- [ ] **Step 9: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add testkit && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(testkit): in-memory delivery-service stub, test clients and the scenario DSL'
```

---

### Task 13: 1,500-leaf `PublicGroup` fixture generator

**Files:**
- Create: `testkit/src/fixtures.rs`, `testkit/fixtures/ds-1500/manifest.json`, `group_info.mls`, `ratchet_tree.mls`, `public_group_state.bin`, `commits/00.mls` … `commits/09.mls`
- Modify: `testkit/src/lib.rs` (declare and re-export `fixtures`), `testkit/src/bin/dilla-testkit.rs` (add the `gen-public-group` subcommand), `testkit/Cargo.toml` (add `sha2`)
- Test: `testkit/tests/fixtures.rs`

**Interfaces:**
- Consumes: `dilla_core::mls`, `dilla_core::public_group`, `TestClient`.
- Produces: `dilla_testkit::{FixtureSpec, FixtureManifest, FixtureFile, gen_public_group}` with
  `FixtureSpec { leaves: usize, out: PathBuf, seed: u64 }`,
  `FixtureManifest { leaves: usize, epoch: u64, group_id_hex: String, tree_hash_hex: String, not_after: u64, openmls_version: String, files: Vec<FixtureFile> }`,
  `FixtureFile { path: String, sha256_hex: String, bytes: u64 }`,
  `gen_public_group(&FixtureSpec) -> Result<FixtureManifest, TestkitError>`;
  the subcommand `dilla-testkit gen-public-group --leaves N --out DIR [--seed N]`;
  the committed fixture Plan B task 5 benchmarks against.

What the fixture is, and why it is shaped this way (R10):

- `group_info.mls` — the committer-signed GroupInfo at the base epoch, **without** the ratchet tree.
- `ratchet_tree.mls` — the exported tree, 1,500 leaves.
- `public_group_state.bin` — `PublicStore::export()` of the base state, so the Go benchmark can
  **import** instead of re-running `from_external` on every iteration.
- `commits/00.mls … 09.mls` — **ten alternative commits, all valid at the base epoch**: `00`–`07`
  are eight batched Add commits carrying 256 KeyPackages each (a different KeyPackage set per
  file), `08` removes one leaf, `09` is a self-Update. They are alternatives, not a sequence, so
  every one is measured against a 1,500-leaf tree exactly as R10 requires. **None of them is ever
  merged**, which is why each iteration ends with `DillaGroup::clear_pending_commit`: staging a
  commit writes `group_state` (gap-7 §2.1, `CommitBuilder::stage_commit`), so a reloaded group is
  in `MlsGroupState::PendingCommit` and the next `add_members` would fail with
  `MlsGroupStateError::PendingCommit`.
- `manifest.json` — the `FixtureManifest` as JSON, `not_after` included.

**The fixture expires.** Every leaf carries a KeyPackage lifetime and `PublicGroup::from_external`
validates all of them, so a committed fixture stops working when the first leaf's lifetime ends.
OpenMLS's default is 84 days (`DEFAULT_KEY_PACKAGE_LIFETIME_SECONDS = 60*60*24*28*3`, gap-18 §0
item 10), but every KeyPackage here is built by `build_key_package`, which overrides it with
`KEY_PACKAGE_LIFETIME_DAYS` = **90 days** (task 10, protocol/01 "Joining") — so `not_after` is
derived from that constant, not from the default, and regeneration lands around **2026-12-22**. The
benchmark reads `not_after` from the manifest and fails with an explicit message rather than an
opaque MLS error. R10 requires the fixture to be committed; this is the mitigation.

- [ ] **Step 1: Write the failing test**

Create `testkit/tests/fixtures.rs`:

```rust
//! The committed 1,500-leaf fixture, and the generator that produces it.

use dilla_testkit::{gen_public_group, FixtureSpec};

const FIXTURE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/ds-1500");

fn manifest() -> serde_json::Value {
    let path = std::path::Path::new(FIXTURE_DIR).join("manifest.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}; run `dilla-testkit gen-public-group --leaves 1500 --out {FIXTURE_DIR}`", path.display()));
    serde_json::from_str(&text).expect("manifest.json is JSON")
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn the_generator_is_deterministic_for_a_fixed_seed() {
    let base = std::env::temp_dir().join(format!("dilla-fixture-{}", std::process::id()));
    let a = base.join("a");
    let b = base.join("b");
    let first = gen_public_group(&FixtureSpec { leaves: 32, out: a.clone(), seed: 7 })
        .expect("generate");
    let second = gen_public_group(&FixtureSpec { leaves: 32, out: b.clone(), seed: 7 })
        .expect("generate");
    assert_eq!(first.group_id_hex, second.group_id_hex);
    assert_eq!(first.tree_hash_hex, second.tree_hash_hex);
    assert_eq!(
        first.files.iter().map(|f| (&f.path, &f.sha256_hex)).collect::<Vec<_>>(),
        second.files.iter().map(|f| (&f.path, &f.sha256_hex)).collect::<Vec<_>>(),
    );
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn the_committed_manifest_lists_every_file_with_a_matching_digest() {
    let m = manifest();
    assert_eq!(m["leaves"].as_u64(), Some(1500));
    let files = m["files"].as_array().expect("files");
    assert_eq!(files.len(), 13, "group_info, ratchet_tree, state and ten commits");
    for file in files {
        let rel = file["path"].as_str().expect("path");
        let path = std::path::Path::new(FIXTURE_DIR).join(rel);
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert_eq!(bytes.len() as u64, file["bytes"].as_u64().expect("bytes"), "{rel}");
        assert_eq!(sha256_hex(&bytes), file["sha256_hex"].as_str().expect("sha256"), "{rel}");
    }
}

#[test]
fn the_fixture_has_not_expired() {
    let m = manifest();
    let not_after = m["not_after"].as_u64().expect("not_after");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    assert!(
        not_after > now,
        "fixture expired, run dilla-testkit gen-public-group --leaves 1500 --out {FIXTURE_DIR}"
    );
}

#[test]
fn the_ds_view_accepts_the_committed_fixture_and_every_alternative_commit() {
    use dilla_core::public_group::{DillaPublicGroup, PublicProcessed};
    let m = manifest();
    let state = std::fs::read(std::path::Path::new(FIXTURE_DIR).join("public_group_state.bin"))
        .expect("state");
    let group_id_bytes: Vec<u8> = {
        let hex = m["group_id_hex"].as_str().expect("group_id_hex");
        (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).expect("hex"))
            .collect()
    };
    let group_id = openmls::group::GroupId::from_slice(&group_id_bytes);

    let base = DillaPublicGroup::import_state(&state, &group_id).expect("import");
    assert_eq!(base.tree_hash().iter().map(|b| format!("{b:02x}")).collect::<String>(), m["tree_hash_hex"].as_str().expect("tree_hash"));
    assert_eq!(base.epoch(), m["epoch"].as_u64().expect("epoch"));

    let crypto = openmls_rust_crypto::RustCrypto::default();
    for i in 0..10 {
        let path = std::path::Path::new(FIXTURE_DIR).join(format!("commits/{i:02}.mls"));
        let blob = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        // Every commit is an ALTERNATIVE at the base epoch, so each starts from a fresh import.
        let mut ds = DillaPublicGroup::import_state(&state, &group_id).expect("import");
        let message = {
            use tls_codec::Deserialize as _;
            openmls::prelude::MlsMessageIn::tls_deserialize_exact(&blob)
                .expect("commit")
                .try_into_protocol_message()
                .expect("protocol message")
        };
        let staged = match ds.process_message(&crypto, message).expect("process") {
            PublicProcessed::StagedCommit { staged, .. } => *staged,
            other => panic!("commits/{i:02}.mls is not a commit: {other:?}"),
        };
        let before = ds.epoch();
        ds.merge_commit(staged).expect("merge");
        assert_eq!(ds.epoch(), before + 1, "commits/{i:02}.mls must advance the epoch by one");
    }
}
```

`testkit/src/fixtures.rs` hashes every file it writes and deserialises MLS objects, so both crates
are **library** dependencies, not dev-only. Extend `[dependencies]` in `testkit/Cargo.toml`:

```toml
sha2      = "0.11"
tls_codec = { version = "0.5.0", features = ["derive", "serde", "mls"] }
```

(`tls_codec` is already used by `testkit/src/client.rs` from task 12; if task 12 added it there,
this step adds only `sha2`.)

- [ ] **Step 2: Run the test to verify it fails**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-testkit --test fixtures --locked
```

Expected: FAIL with `error[E0432]: unresolved import dilla_testkit::gen_public_group`, and once the
module exists, `manifest.json: No such file or directory; run dilla-testkit gen-public-group …`.

- [ ] **Step 3: Write the generator**

Create `testkit/src/fixtures.rs`:

```rust
//! Generates the committed benchmark fixture: a 1,500-leaf group's public state plus ten
//! alternative commits valid at its base epoch (R10).

use crate::{TestClient, TestkitError};
use dilla_core::identity::{Kind, Tier};
use dilla_core::ids::{InstanceId, UserId};
use dilla_core::mls::{
    build_key_package, DillaBinding, DillaGroup, GroupKind, MAX_ADDS_PER_COMMIT,
};
use dilla_core::public_group::DillaPublicGroup;
use openmls::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub struct FixtureSpec {
    pub leaves: usize,
    pub out: PathBuf,
    pub seed: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FixtureFile {
    pub path: String,
    pub sha256_hex: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FixtureManifest {
    pub leaves: usize,
    pub epoch: u64,
    pub group_id_hex: String,
    pub tree_hash_hex: String,
    /// Seconds since the Unix epoch. Every leaf carries a KeyPackage lifetime and
    /// `PublicGroup::from_external` validates all of them, so the fixture stops working here.
    pub not_after: u64,
    pub openmls_version: String,
    pub files: Vec<FixtureFile>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn write_file(
    spec: &FixtureSpec,
    rel: &str,
    bytes: &[u8],
    files: &mut Vec<FixtureFile>,
) -> Result<(), TestkitError> {
    let path = spec.out.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| TestkitError::Scenario(e.to_string()))?;
    }
    std::fs::write(&path, bytes).map_err(|e| TestkitError::Scenario(e.to_string()))?;
    files.push(FixtureFile {
        path: rel.to_owned(),
        sha256_hex: hex(&Sha256::digest(bytes)),
        bytes: bytes.len() as u64,
    });
    Ok(())
}

fn serialize<T: tls_codec::Serialize>(value: &T) -> Result<Vec<u8>, TestkitError> {
    value.tls_serialize_detached().map_err(|e| TestkitError::Scenario(format!("{e:?}")))
}

/// Builds the group by adding `leaves - 1` members in batches of `MAX_ADDS_PER_COMMIT`, then
/// freezes the base state and produces ten alternative commits against it.
pub fn gen_public_group(spec: &FixtureSpec) -> Result<FixtureManifest, TestkitError> {
    assert!(spec.leaves >= 2, "a fixture needs at least two leaves");
    let mut creator = TestClient::new(
        "creator",
        UserId::from_bytes([0x01; 16]),
        Tier::Native,
        Kind::User,
        spec.seed,
    )?;
    let binding = DillaBinding {
        v: 1,
        instance_id: InstanceId::from_bytes([0x11; 16]),
        community_id: None,
        target_id: [0x66; 16],
        kind: GroupKind::Text,
        policy_version: 1,
        e2ee_version: 1,
        media_version: 0,
    };
    let group_id = GroupId::from_slice(&binding.target_id);
    let mut group = DillaGroup::create(
        creator.provider(),
        creator.signer(),
        creator.credential(),
        group_id.clone(),
        binding,
        None,
    )?;

    // Fill the tree.
    let mut members = Vec::with_capacity(spec.leaves - 1);
    for i in 1..spec.leaves {
        members.push(TestClient::new(
            &format!("m{i}"),
            UserId::from_bytes([(i % 251) as u8; 16]),
            Tier::Native,
            Kind::User,
            spec.seed.wrapping_add(i as u64),
        )?);
    }
    for batch in members.chunks(MAX_ADDS_PER_COMMIT) {
        let mut packages = Vec::with_capacity(batch.len());
        for member in batch {
            let kp = build_key_package(
                member.provider(),
                member.signer(),
                member.credential(),
                false,
            )?;
            packages.push(kp.key_package().clone());
        }
        group.add_members(creator.provider(), creator.signer(), &packages)?;
        group.merge_pending_commit(creator.provider())?;
    }

    // Freeze the base state.
    let group_info = serialize(&group.export_group_info(creator.provider(), creator.signer())?)?;
    let ratchet_tree = serialize(&group.export_ratchet_tree())?;
    let crypto = openmls_rust_crypto::RustCrypto::default();
    let verifiable = {
        use tls_codec::Deserialize as _;
        match MlsMessageIn::tls_deserialize_exact(&group_info)
            .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?
            .extract()
        {
            MlsMessageBodyIn::GroupInfo(info) => info,
            other => {
                return Err(TestkitError::Scenario(format!("expected a GroupInfo, got {other:?}")))
            }
        }
    };
    let tree_in = {
        use tls_codec::Deserialize as _;
        RatchetTreeIn::tls_deserialize_exact(&ratchet_tree)
            .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?
    };
    let (public, _) = DillaPublicGroup::from_external(&crypto, tree_in, verifiable)
        .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
    let base_state = public.export_state();
    let base_epoch = public.epoch();
    let tree_hash = public.tree_hash();

    // Ten alternative commits, every one valid at the base epoch. The group is reloaded from
    // storage between them so each starts from the same state.
    let mut commits: Vec<Vec<u8>> = Vec::with_capacity(10);
    for batch in 0..8usize {
        let mut fresh = DillaGroup::load(creator.provider(), &group_id)?
            .ok_or_else(|| TestkitError::Scenario("the creator's group vanished".into()))?;
        let mut packages = Vec::with_capacity(MAX_ADDS_PER_COMMIT);
        for i in 0..MAX_ADDS_PER_COMMIT {
            let member = TestClient::new(
                &format!("add-{batch}-{i}"),
                UserId::from_bytes([0x5a; 16]),
                Tier::Native,
                Kind::User,
                spec.seed
                    .wrapping_add(1_000_000)
                    .wrapping_add((batch * MAX_ADDS_PER_COMMIT + i) as u64),
            )?;
            let kp = build_key_package(
                member.provider(),
                member.signer(),
                member.credential(),
                false,
            )?;
            packages.push(kp.key_package().clone());
        }
        let bundle = fresh.add_members(creator.provider(), creator.signer(), &packages)?;
        commits.push(serialize(&bundle.commit)?);
        // Each of the ten is an alternative at the base epoch, so none is merged. Clearing the
        // staged commit is what lets the next iteration stage one at all.
        fresh.clear_pending_commit(creator.provider())?;
    }
    {
        let mut fresh = DillaGroup::load(creator.provider(), &group_id)?
            .ok_or_else(|| TestkitError::Scenario("the creator's group vanished".into()))?;
        let bundle = fresh.remove_members(
            creator.provider(),
            creator.signer(),
            &[LeafNodeIndex::new(1)],
        )?;
        commits.push(serialize(&bundle.commit)?);
        fresh.clear_pending_commit(creator.provider())?;
    }
    {
        let mut fresh = DillaGroup::load(creator.provider(), &group_id)?
            .ok_or_else(|| TestkitError::Scenario("the creator's group vanished".into()))?;
        let bundle = fresh.self_update(creator.provider(), creator.signer())?;
        commits.push(serialize(&bundle.commit)?);
        fresh.clear_pending_commit(creator.provider())?;
    }

    let mut files = Vec::new();
    std::fs::create_dir_all(&spec.out).map_err(|e| TestkitError::Scenario(e.to_string()))?;
    write_file(spec, "group_info.mls", &group_info, &mut files)?;
    write_file(spec, "ratchet_tree.mls", &ratchet_tree, &mut files)?;
    write_file(spec, "public_group_state.bin", &base_state, &mut files)?;
    for (i, commit) in commits.iter().enumerate() {
        write_file(spec, &format!("commits/{i:02}.mls"), commit, &mut files)?;
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| TestkitError::Scenario(e.to_string()))?
        .as_secs();
    // Every leaf of this fixture carries a KeyPackage built by `build_key_package`, which
    // overrides OpenMLS's 84-day default with `Lifetime::new(KEY_PACKAGE_LIFETIME_DAYS * 24 * 60 *
    // 60)` = 90 days (task 10). Deriving `not_after` from that constant rather than restating
    // gap-18's 84 keeps the manifest honest: an under-reported expiry makes the benchmark cry
    // "fixture expired" six days early.
    let lifetime_secs = dilla_core::mls::KEY_PACKAGE_LIFETIME_DAYS * 24 * 60 * 60;
    let manifest = FixtureManifest {
        leaves: spec.leaves,
        epoch: base_epoch,
        group_id_hex: hex(group_id.as_slice()),
        tree_hash_hex: hex(&tree_hash),
        not_after: now + lifetime_secs,
        openmls_version: "0.9.0".to_owned(),
        files,
    };
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| TestkitError::Scenario(e.to_string()))?;
    std::fs::write(spec.out.join("manifest.json"), format!("{json}\n"))
        .map_err(|e| TestkitError::Scenario(e.to_string()))?;
    Ok(manifest)
}
```

Expose the three accessors `gen_public_group` needs on `TestClient`, in `testkit/src/client.rs`:

```rust
    pub fn provider(&self) -> &DillaProvider {
        &self.provider
    }

    pub fn signer(&self) -> &SignatureKeyPair {
        &self.signer
    }
```

- [ ] **Step 4: Wire up the module and the subcommand**

Add to `testkit/src/lib.rs`:

```rust
mod fixtures;

pub use fixtures::{gen_public_group, FixtureFile, FixtureManifest, FixtureSpec};
```

Add the subcommand to `testkit/src/bin/dilla-testkit.rs`, inside `enum Command`:

```rust
    /// Generate the committed PublicGroup benchmark fixture.
    GenPublicGroup {
        #[arg(long, default_value_t = 1500)]
        leaves: usize,
        #[arg(long)]
        out: std::path::PathBuf,
        #[arg(long, default_value_t = 0x5eed)]
        seed: u64,
    },
```

and the matching arm inside `match cli.command`:

```rust
        Command::GenPublicGroup { leaves, out, seed } => {
            match dilla_testkit::gen_public_group(&dilla_testkit::FixtureSpec { leaves, out, seed })
            {
                Ok(manifest) => {
                    println!(
                        "{} leaves, epoch {}, tree_hash {}, {} files, not_after {}",
                        manifest.leaves,
                        manifest.epoch,
                        manifest.tree_hash_hex,
                        manifest.files.len(),
                        manifest.not_after
                    );
                    std::process::ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
                    std::process::ExitCode::FAILURE
                }
            }
        }
```

**No `.gitignore` change is needed, and none is made.** The root `.gitignore` ignores `/target/`,
`/dist/`, `node_modules`, `*.wasm`, `packages/ui/storybook-static/`, `/.superpowers/`,
`/.playwright-mcp/`, `/data/`, `*.db`, `*.sqlite`, `.env*` and editor files (verified against the
file). Nothing there matches `*.mls`, `*.bin` or `manifest.json`, so a `!testkit/fixtures/…`
negation would be a no-op that reads as though it were load-bearing. Step 7 checks what git
actually sees.

- [ ] **Step 5: Generate the committed fixture**

```bash
/home/thim/.cargo/bin/cargo run --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-testkit --bin dilla-testkit --release --locked -- gen-public-group --leaves 1500 --out /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/testkit/fixtures/ds-1500
```

Expected: `1500 leaves, epoch 6, tree_hash <64 hex>, 13 files, not_after <unix seconds>`. Use
`--release`: building a 1,500-leaf tree under a debug build takes minutes.

```bash
ls -la /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/testkit/fixtures/ds-1500 /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/testkit/fixtures/ds-1500/commits
```

Expected: `manifest.json`, `group_info.mls`, `ratchet_tree.mls`, `public_group_state.bin` and
`commits/00.mls` through `commits/09.mls`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
/home/thim/.cargo/bin/cargo test --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -p dilla-testkit --release --locked
```

Expected: PASS — the four fixture tests plus everything from task 12.

```bash
/home/thim/.cargo/bin/cargo clippy --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml --workspace --all-targets --all-features --locked -- -D warnings
```

Expected: PASS with no warnings.

```bash
/home/thim/.cargo/bin/cargo fmt --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml --all --check
```

Expected: PASS with no diff.

- [ ] **Step 7: Confirm the fixture is actually staged, not swallowed by `.gitignore`**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol status --porcelain --untracked-files=all -- testkit/fixtures
```

Expected: every one of the 14 files listed as untracked. If `public_group_state.bin` is missing,
the generator did not write it — check step 5's output, not `.gitignore`: no ignore rule in this
repository matches these files.

- [ ] **Step 8: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add testkit && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(testkit): generate and commit the 1,500-leaf PublicGroup benchmark fixture'
```

---

### Task 14: `dilla-core-wasi` — the CBOR ABI and the 17 exports

**Files:**
- Create: `core/dilla-core-wasi/src/abi.rs`
- Create: `core/dilla-core-wasi/src/handles.rs`
- Create: `core/dilla-core-wasi/src/exports.rs`
- Modify: `core/dilla-core-wasi/src/lib.rs` (task 1 created it as a stub)
- Modify: `core/dilla-core-wasi/Cargo.toml` (task 1 created it; deviation A2-1 adds five dependencies)
- Test: unit tests inside `core/dilla-core-wasi/src/exports.rs` and `src/abi.rs`. The crate is `crate-type = ["cdylib"]`, so no `tests/` integration target can link it; `cargo test` still compiles the library as its own test harness.

**Interfaces:**
- Consumes: `dilla_core::cbor::{Encoder, Decoder, CborError, decode_strict}`; `dilla_core::{ABI_VERSION, CORE_VERSION, E2EE_VERSION, MEDIA_VERSION}`; `dilla_core::ProtocolError`; `dilla_core::identity::{CredentialIdentity, SskSigner}`; `dilla_core::mls::DillaBinding`; `dilla_core::public_group::{DillaPublicGroup, PublicProcessed, PublicGroupError, PublicStoreError, MemberInfo, validate_key_package, external_propose_add, external_propose_remove}`; `dilla_core::vectors::run_all`.
- Produces: `dilla_core_wasi::abi::{AbiError, E_ABI_VERSION, E_ABI_SHAPE, E_ABI_HANDLE, E_ABI_STATE, pack, unpack, open, error_response, tls}`; `dilla_core_wasi::handles::{Table, with_table}`; `dilla_core_wasi::exports::dispatch`; and the 17 wasm exports of interfaces §2.10 — `dilla_alloc`, `dilla_free`, `dilla_abi`, `vectors_check`, `public_group_create`, `public_group_import_state`, `public_group_export_state`, `public_group_close`, `public_group_process`, `public_group_merge`, `public_group_tree`, `public_group_state`, `public_group_proposal_put`, `public_group_proposal_list`, `validate_key_package`, `external_propose_add`, `external_propose_remove`.

- [ ] **Step 1: Resolve NV-1, NV-2, NV-3, NV-3b, NV-3c, NV-4 and NV-11 on docs.rs and write the answers into a scratch note**

Open, in this order, and copy the exact signature of each item into
`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasi/src/abi.rs`'s
module doc comment as you write it in step 5:

1. `https://docs.rs/tls_codec/0.5.0/tls_codec/trait.Deserialize.html` and `trait.DeserializeBytes.html` — the
   method that turns `&[u8]` into a value and rejects trailing bytes (NV-1). Use that method in `abi::tls`;
   do not guess between `tls_deserialize_exact`, `tls_deserialize_exact_bytes` and `tls_deserialize_bytes`.
2. `https://docs.rs/openmls/0.9.0/openmls/framing/struct.MlsMessageIn.html`,
   `.../openmls/treesync/struct.RatchetTreeIn.html`, `.../openmls/messages/struct.GroupInfo.html` — which of
   them implement that trait (NV-1), and whether `GroupInfo` is serialised bare or must be wrapped in an
   `MlsMessageOut` for `protocol/02-delivery-service.md`'s `GET /v1/groups/{id}/group-info` (NV-2). Read
   `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/protocol/02-delivery-service.md`
   section `## API` to settle NV-2.
3. `https://docs.rs/openmls/0.9.0/openmls/group/struct.GroupId.html`,
   `.../struct.GroupEpoch.html`, `.../openmls/binary_tree/array_representation/struct.LeafNodeIndex.html`,
   `.../openmls/key_packages/struct.KeyPackage.html`, `.../openmls/treesync/struct.LeafNode.html`,
   `https://docs.rs/openmls/0.9.0/openmls/credentials/struct.BasicCredential.html` — the constructors and
   accessors of NV-3. Note the crate: `BasicCredential` lives in **`openmls::credentials`**
   (facts-openmls §7 and its source list, line 971); `openmls_basic_credential 0.6.0` exports only
   `SignatureKeyPair`. `BasicCredential::identity()` is already recorded verbatim in facts-openmls §7 as
   `pub fn identity(&self) -> &[u8]`, so it is not re-read here.
4. `https://docs.rs/openmls/0.9.0/openmls/prelude/struct.ProposalRef.html` and
   `.../struct.QueuedProposal.html` — `ProposalRef::as_slice()` and `QueuedProposal::proposal()` (NV-3b), and
   `https://docs.rs/tls_codec/0.5.0/tls_codec/trait.Serialize.html`'s implementors for whether
   `openmls::prelude::Proposal` is TLS-serialisable at all. gap-16 §2's derive table does not list it.
5. `https://docs.rs/openmls_rust_crypto/0.6.0/src/` — `OpenMlsCrypto::sign`'s handling of
   `SignatureScheme::ED25519`, to settle whether `SignatureKeyPair::from_raw`'s `private` half is the
   32-byte seed or the 64-byte seed‖public form (NV-3c).
6. `https://docs.rs/openmls/0.9.0/openmls/messages/struct.GroupInfo.html` and
   `.../openmls/framing/struct.MlsMessageOut.html` — whether a public conversion from `GroupInfo` to bytes
   exists (NV-11). gap-16 §2 records `GroupInfo` as deriving `TlsSize, SerdeSerialize, SerdeDeserialize`
   only, so there is no direct `tls_serialize_detached`. **If no public route exists**, stop:
   `public_group_create`'s sixth response element cannot be produced and the export's shape needs a new
   decision.

**NV-4 is resolved by ruling: task 11 declares it.** A2 still writes no `QueuedProposal` constructor —
building one from a received proposal needs the group context and signature verification, which belong
inside `dilla-core` — but there is nothing left to open and nothing to wait for. **Plan A task 11 step 4**
declares
`DillaPublicGroup::queue_proposal(&mut self, crypto: &impl OpenMlsCrypto, message: ProtocolMessage) -> Result<Vec<u8>, PublicGroupError>`,
which returns the new proposal's reference bytes and keeps the original `MLSMessage` beside the queued
proposal, and `queued_proposals() -> Vec<(ProposalRef, Vec<u8>)>` of `(reference, the bytes the DS
received)` — deviation A2-11. This part simply consumes both. One line confirms the declaration is in the
tree before step 12 writes against it:

Run: `grep -n 'pub fn queue_proposal' /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core/src/public_group/state.rs`

Expected: exactly one hit. No hit means Plan A task 11 has not landed yet — run it first; it is not a
design question any more.

Record the six answers in the commit message of step 17.

- [ ] **Step 2: Prove `dilla-core` builds for `wasm32-wasip1` before anything is written (NV-5)**

Run: `/home/thim/.cargo/bin/cargo build -p dilla-core --target wasm32-wasip1 --locked --features vectors --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: PASS. NV-5 is owned by **Plan A tasks 9, 10 and 11**, and all four of its points are written
into those tasks; this step is the check that they landed, not the place they are fixed. If it fails,
**stop; do not patch `dilla-core` from here** — re-run the owning task instead. What each one owes:

- **Task 9 step 6** gates the private `mod provider; mod storage; mod tx;` declarations in
  `core/dilla-core/src/mls/mod.rs` **and** the `pub use provider::DillaProvider;
  pub use storage::{ConnHandle, DillaStorage}; pub use tx::TxError;` lines beside them with
  `#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]` — the same condition as the two
  `rusqlite` dependency sections, and therefore exactly "not wasip1". Its own step 7 runs this build.
- **Task 10 step 7** gates `mod config;` and `mod group;` and their `pub use` lines identically, which is
  what takes `build_key_package(provider: &DillaProvider, …)` and every `DillaGroup` method off the wasip1
  build. Its step 8 runs this build too.
- **Task 11 step 4** instantiates `external_propose_add` / `external_propose_remove` with
  `openmls_rust_crypto::OpenMlsRustCrypto`, whose storage is never touched, instead of `DillaProvider`,
  which owns a `rusqlite::Connection` (facts-wazero §6: all three `ExternalProposal` constructors are
  generic over `Provider` although only the signer is used). Its step 6 runs this build and says in as many
  words that nothing in `public_group` may name `DillaProvider`, `DillaStorage` or `ConnHandle`.

`error[E0433]: failed to resolve: use of undeclared crate or module rusqlite` names the module whose gate
slipped; take the failure to the task in the list above that owns that module.

- [ ] **Step 3: Add the four dependencies (deviation A2-1)**

**Append** these four lines to the existing `[dependencies]` table of
`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasi/Cargo.toml`. Do
not rewrite the table: task 1 wrote the `dilla-core` line, and Plan A1's deviation A1-2 deliberately removed
`minicbor` from this manifest because the crate encodes through `dilla_core::cbor`. A2 follows A1-2.

```toml
# Deviation A2-1: the ABI carries MLS objects as their RFC 9420 TLS encoding, so the crate must
# TLS-decode them and construct a Signer. Every pin and feature list below is byte-identical to
# core/dilla-core's, which is what keeps Cargo.lock's versions still. openmls_traits is deliberately
# absent: no step here names a trait from it, and the `&impl OpenMlsCrypto` bounds take a concrete
# RustCrypto. tls_codec's feature list is copied verbatim from interfaces §3.1 — trimming `derive`
# would de-unify the feature set with dilla-core and move the lock, which A2-1 promises it will not.
openmls                  = { version = "0.9.0", default-features = false }
openmls_rust_crypto      = "0.6.0"
openmls_basic_credential = "0.6.0"
tls_codec                = { version = "0.5.0", features = ["derive", "serde", "mls"] }
```

Adding dependency edges always makes `Cargo.lock` stale — the lock records a `dependencies = […]` array per
package — so the refresh runs **without** `--locked`; passing it here would fail with "the lock file needs
to be updated but --locked was passed" rather than telling you anything about versions.

Run: `/home/thim/.cargo/bin/cargo metadata --format-version 1 --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml > /dev/null`

Expected: PASS, and `Cargo.lock` is rewritten with the four new edges.

Run: `git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol diff -U0 -- Cargo.lock`

Expected: the only changes are additions to `dilla-core-wasi`'s `dependencies` array. No new `[[package]]`
block and no changed `version = ` line — that is the real form of A2-1's "no new versions enter the lock"
claim. Confirm it mechanically:

Run: `git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol diff -U0 -- Cargo.lock | grep -E '^[+-](version = |\[\[package\]\])'`

Expected: no output, exit 1. Any hit means a version moved; stop and reconcile before writing code. Every
later command in this part passes `--locked` again, because the lock is now current.

- [ ] **Step 4: Write the failing test for the framing primitives and declare the module**

Two files change in this step. Declaring `abi` here is what makes step 5's red state real: task 1 created
`lib.rs` as a doc-comment-only stub, so an undeclared `abi.rs` is simply never compiled and `cargo test`
would exit 0 with zero tests.

Replace the whole of
`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasi/src/lib.rs` with:

```rust
//! `dilla-core-wasi` — the wasm32-wasip1 binding of `dilla-core` (interfaces §2.10, R8, R9).
//!
//! `_initialize` is NOT declared here: it comes from `crt1-reactor.o` and traps if called twice
//! (gap-19 §0 items 6-8). The host calls it exactly once through
//! `wazero.NewModuleConfig().WithStartFunctions("_initialize")`.
//!
//! `handles` is declared in step 8, `exports` in step 10 and `shims` in step 13 — each alongside the
//! file it names, so the crate compiles after every step except the two deliberate red ones.

pub mod abi;
```

Then create
`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasi/src/abi.rs`
containing only this test module for now (the implementation arrives in step 6):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_and_unpack_round_trip() {
        assert_eq!(unpack(pack(0x0001_0000, 42)), (0x0001_0000, 42));
        assert_eq!(unpack(pack(u32::MAX, u32::MAX)), (u32::MAX, u32::MAX));
        assert_eq!(pack(1, 2), (1u64 << 32) | 2);
        assert_eq!(unpack(0), (0, 0));
    }

    #[test]
    fn open_rejects_a_wrong_abi_version() {
        // [7]  — one-element array whose version element is 7, not 1.
        let req = [0x81u8, 0x07];
        let err = open(&req, 1).unwrap_err();
        assert_eq!(err.code, E_ABI_VERSION);
        assert!(err.detail.contains('7'), "detail must name the offending version: {}", err.detail);
    }

    #[test]
    fn open_rejects_a_wrong_array_length() {
        // [1] offered where a three-element request is required.
        let req = [0x81u8, 0x01];
        assert_eq!(open(&req, 3).unwrap_err().code, E_ABI_SHAPE);
    }

    #[test]
    fn open_accepts_the_current_version_and_leaves_the_cursor_after_it() {
        // [1, 9]
        let req = [0x82u8, 0x01, 0x09];
        let mut d = open(&req, 2).unwrap();
        assert_eq!(d.uint().unwrap(), 9);
        d.finish().unwrap();
    }

    #[test]
    fn error_response_is_the_three_element_failure_frame() {
        let err = AbiError::new(E_ABI_HANDLE, "handle 4");
        // [1, "E_ABI_HANDLE", "handle 4"]
        let expected = {
            let mut e = dilla_core::cbor::Encoder::new();
            e.array(3).uint(1).text("E_ABI_HANDLE").text("handle 4");
            e.into_vec()
        };
        assert_eq!(error_response(&err), expected);
    }

    #[test]
    fn a_protocol_error_keeps_its_stable_code() {
        let err = AbiError::from(dilla_core::ProtocolError::Binding);
        assert_eq!(err.code, "E_BINDING");
    }
}
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `/home/thim/.cargo/bin/cargo test -p dilla-core-wasi --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: FAIL to compile, in `abi.rs`'s test module — `cannot find function `pack` in this scope`,
`cannot find function `unpack``, `cannot find function `open``, `cannot find function `error_response``,
`cannot find type `AbiError`` and `cannot find value `E_ABI_VERSION``. If instead the command reports
`0 passed` and exits 0, `lib.rs` is missing the `pub mod abi;` of step 4 — add it and re-run, because a
green run here proves nothing.

- [ ] **Step 6: Write `abi.rs`**

Put this above the `#[cfg(test)] mod tests` block already in
`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasi/src/abi.rs`:

```rust
//! Request and response framing for the dilla wasi ABI (interfaces §2.10, R8, gap-16 §5).
//!
//! Every export takes `(ptr, len)` addressing one deterministic-CBOR request and returns
//! `(ptr << 32) | len` addressing one deterministic-CBOR response the caller frees with
//! `dilla_free`. A success response is `[0, …]`; a failure response is `[1, code, detail]`.
//! No panic, no `Result` and no OpenMLS error type crosses the boundary.
//!
//! NV-1/NV-2/NV-3 answers found in step 1 are recorded on `mod tls` below.

use dilla_core::cbor::{CborError, Decoder, Encoder};

/// ABI-local error codes. Everything else is a `protocol/*.md` `E_*` string.
pub const E_ABI_VERSION: &str = "E_ABI_VERSION";
pub const E_ABI_SHAPE: &str = "E_ABI_SHAPE";
pub const E_ABI_HANDLE: &str = "E_ABI_HANDLE";
pub const E_ABI_STATE: &str = "E_ABI_STATE";

/// One failure frame's payload. Never carries a Rust type across the boundary.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AbiError {
    pub code: String,
    pub detail: String,
}

impl AbiError {
    pub fn new(code: &str, detail: impl Into<String>) -> Self {
        Self { code: code.to_owned(), detail: detail.into() }
    }
    pub fn shape(detail: impl Into<String>) -> Self {
        Self::new(E_ABI_SHAPE, detail)
    }
    pub fn handle(detail: impl Into<String>) -> Self {
        Self::new(E_ABI_HANDLE, detail)
    }
    pub fn state(detail: impl Into<String>) -> Self {
        Self::new(E_ABI_STATE, detail)
    }
}

impl From<CborError> for AbiError {
    fn from(e: CborError) -> Self {
        Self::shape(e.to_string())
    }
}

impl From<dilla_core::ProtocolError> for AbiError {
    fn from(e: dilla_core::ProtocolError) -> Self {
        Self::new(e.code(), e.to_string())
    }
}

impl From<dilla_core::public_group::PublicStoreError> for AbiError {
    fn from(e: dilla_core::public_group::PublicStoreError) -> Self {
        Self::new(E_ABI_STATE, e.to_string())
    }
}

impl From<dilla_core::public_group::PublicGroupError> for AbiError {
    fn from(e: dilla_core::public_group::PublicGroupError) -> Self {
        use dilla_core::public_group::PublicGroupError as E;
        match e {
            E::Protocol(p) => AbiError::from(p),
            E::Store(s) => AbiError::from(s),
            E::OpenMls(detail) => AbiError::new(E_ABI_STATE, detail),
            E::StateMissing => AbiError::new(E_ABI_STATE, "public group state is absent or torn"),
        }
    }
}

/// Packs a response into the single WebAssembly 1.0 return value (gap-16 §0 item 5).
pub const fn pack(ptr: u32, len: u32) -> u64 {
    ((ptr as u64) << 32) | (len as u64)
}

/// Inverse of [`pack`]; used by the tests and by any host written in Rust.
pub const fn unpack(v: u64) -> (u32, u32) {
    ((v >> 32) as u32, (v & 0xffff_ffff) as u32)
}

/// Opens a request: asserts the fixed array length and that element 0 is `ABI_VERSION`.
/// Returns a decoder positioned on element 1.
pub fn open(req: &[u8], len: usize) -> Result<Decoder<'_>, AbiError> {
    let mut d = Decoder::new(req);
    d.array(len)?;
    let v = d.uint()?;
    if v != dilla_core::ABI_VERSION {
        return Err(AbiError::new(
            E_ABI_VERSION,
            format!("abi_version {v}, this module speaks {}", dilla_core::ABI_VERSION),
        ));
    }
    Ok(d)
}

/// `[1, code, detail]`.
pub fn error_response(err: &AbiError) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(3).uint(1).text(&err.code).text(&err.detail);
    e.into_vec()
}

/// Reads a `u32` handle out of a request, rejecting anything that does not fit.
pub fn read_handle(d: &mut Decoder<'_>) -> Result<u32, AbiError> {
    let v = d.uint()?;
    u32::try_from(v).map_err(|_| AbiError::handle(format!("handle {v} does not fit in u32")))
}

/// TLS-codec conversions between the ABI's byte strings and OpenMLS types.
///
/// The four method names below are the ones resolved in step 1 (NV-1); `group_info_out`'s shape is
/// the NV-2 answer. Nothing outside this module names a `tls_codec` trait.
pub mod tls {
    use super::AbiError;
    use openmls::prelude::*;
    use tls_codec::Serialize as _;

    fn bad(what: &str, e: impl core::fmt::Display) -> AbiError {
        AbiError::shape(format!("{what}: {e}"))
    }

    pub fn mls_message_in(bytes: &[u8]) -> Result<MlsMessageIn, AbiError> {
        <MlsMessageIn as tls_codec::Deserialize>::tls_deserialize_exact(bytes)
            .map_err(|e| bad("MLSMessage", e))
    }

    pub fn ratchet_tree_in(bytes: &[u8]) -> Result<RatchetTreeIn, AbiError> {
        <RatchetTreeIn as tls_codec::Deserialize>::tls_deserialize_exact(bytes)
            .map_err(|e| bad("ratchet_tree", e))
    }

    pub fn verifiable_group_info(bytes: &[u8]) -> Result<VerifiableGroupInfo, AbiError> {
        match mls_message_in(bytes)?.extract() {
            MlsMessageBodyIn::GroupInfo(gi) => Ok(gi),
            _ => Err(AbiError::shape("expected an MLSMessage carrying a GroupInfo")),
        }
    }

    pub fn key_package_in(bytes: &[u8]) -> Result<KeyPackageIn, AbiError> {
        match mls_message_in(bytes)?.extract() {
            MlsMessageBodyIn::KeyPackage(kp) => Ok(kp),
            _ => Err(AbiError::shape("expected an MLSMessage carrying a KeyPackage")),
        }
    }

    pub fn protocol_message(bytes: &[u8]) -> Result<ProtocolMessage, AbiError> {
        mls_message_in(bytes)?
            .try_into_protocol_message()
            .map_err(|e| bad("not a handshake or application message", e))
    }

    pub fn message_out(msg: &MlsMessageOut) -> Result<Vec<u8>, AbiError> {
        msg.tls_serialize_detached().map_err(|e| bad("MLSMessage out", e))
    }

    pub fn ratchet_tree_out(tree: &RatchetTree) -> Result<Vec<u8>, AbiError> {
        tree.tls_serialize_detached().map_err(|e| bad("ratchet_tree out", e))
    }

    /// NV-2 settles the framing: the DS stores what the committer uploaded, so a GroupInfo leaves
    /// this module in the same framing `protocol/02-delivery-service.md` names for
    /// `POST /v1/groups/{id}/commit`.
    ///
    /// NV-11 settles the *mechanism*, and it is not assumed here. gap-16 §2 records
    /// `GroupInfo` as deriving `TlsSize, SerdeSerialize, SerdeDeserialize` only — there is **no**
    /// `TlsSerialize`, so `gi.tls_serialize_detached()` does not exist. Write the body with the route
    /// step 1 item 6 actually found on 0.9.0 (an `impl From<GroupInfo> for MlsMessageOut` would make
    /// it `MlsMessageOut::from(gi.clone()).tls_serialize_detached()`), and with nothing else.
    /// Write this body **only** if step 1 item 6 confirmed `impl From<GroupInfo> for MlsMessageOut`
    /// on 0.9.0. If it found a different public route, write that one instead; if it found none,
    /// STOP — `public_group_create`'s sixth response element cannot be produced and the export's
    /// shape needs a new decision (the same stop-and-reconcile rule as NV-4).
    pub fn group_info_out(gi: &GroupInfo) -> Result<Vec<u8>, AbiError> {
        MlsMessageOut::from(gi.clone())
            .tls_serialize_detached()
            .map_err(|e| bad("GroupInfo out", e))
    }
}
```

`group_info_out` is the one body in this file whose *mechanism* step 1 has to confirm rather than
merely name. The code above is written against `impl From<GroupInfo> for MlsMessageOut` because that is
the only route that fits `bad("GroupInfo out", e)`'s shape — but that impl is recorded in **no** facts or
gap file, and gap-16 §2's derive table is the reason it cannot be assumed: `GroupInfo` derives
`TlsSize, SerdeSerialize, SerdeDeserialize` and nothing else, so `gi.tls_serialize_detached()` does not
exist and there is no obvious fallback. If step 1 item 6 comes back empty, this is a blocking finding, not
a line to improvise.

- [ ] **Step 7: Run the framing tests to verify they pass**

Run: `/home/thim/.cargo/bin/cargo test -p dilla-core-wasi --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml abi::`

Expected: PASS — `6 passed`. `abi` is already declared (step 4) and `handles` and `exports` do not exist
yet, so this run compiles exactly the framing module and its six tests.

- [ ] **Step 8: Write `handles.rs`, its tests, and declare the module**

Add `pub mod handles;` to
`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasi/src/lib.rs`,
immediately after `pub mod abi;`, and create
`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasi/src/handles.rs`:

```rust
//! The two handle classes of interfaces §2.10: public groups and staged commits.
//!
//! R9: PublicGroup state lives in module memory. A handle is valid only inside the instance that
//! created it; wazero gives every goroutine its own instance (facts-wazero §3), so the table is a
//! plain `thread_local!` with no locking.

use core::cell::RefCell;
use std::collections::BTreeMap;

use dilla_core::public_group::{DillaPublicGroup, PublicProcessed};

use crate::abi::AbiError;

/// No `#[derive(Default)]`: a derived default would set `next: 0`, and handle 0 is the one value the
/// ABI treats as never valid. `Table::new()` is the only constructor.
pub struct Table {
    groups: BTreeMap<u32, DillaPublicGroup>,
    staged: BTreeMap<u32, PublicProcessed>,
    next: u32,
}

impl Table {
    pub fn new() -> Self {
        Self { groups: BTreeMap::new(), staged: BTreeMap::new(), next: 1 }
    }

    /// Handles never repeat and never wrap to 0, so a stale handle is always a miss, never a hit
    /// on somebody else's group.
    fn next_id(&mut self) -> u32 {
        let id = self.next;
        self.next = self.next.checked_add(1).expect("handle space exhausted");
        id
    }

    pub fn insert_group(&mut self, group: DillaPublicGroup) -> u32 {
        let id = self.next_id();
        self.groups.insert(id, group);
        id
    }

    pub fn group(&self, handle: u32) -> Result<&DillaPublicGroup, AbiError> {
        self.groups.get(&handle).ok_or_else(|| AbiError::handle(format!("no group for handle {handle}")))
    }

    pub fn group_mut(&mut self, handle: u32) -> Result<&mut DillaPublicGroup, AbiError> {
        self.groups
            .get_mut(&handle)
            .ok_or_else(|| AbiError::handle(format!("no group for handle {handle}")))
    }

    pub fn close_group(&mut self, handle: u32) -> Result<(), AbiError> {
        self.groups
            .remove(&handle)
            .map(|_| ())
            .ok_or_else(|| AbiError::handle(format!("no group for handle {handle}")))
    }

    pub fn insert_staged(&mut self, processed: PublicProcessed) -> u32 {
        let id = self.next_id();
        self.staged.insert(id, processed);
        id
    }

    pub fn take_staged(&mut self, handle: u32) -> Result<PublicProcessed, AbiError> {
        self.staged
            .remove(&handle)
            .ok_or_else(|| AbiError::handle(format!("no staged commit for handle {handle}")))
    }

    pub fn group_count(&self) -> usize {
        self.groups.len()
    }

    pub fn staged_count(&self) -> usize {
        self.staged.len()
    }
}

thread_local! {
    static TABLE: RefCell<Table> = RefCell::new(Table::new());
}

/// Runs `f` against this instance's table.
pub fn with_table<T>(f: impl FnOnce(&mut Table) -> T) -> T {
    TABLE.with(|t| f(&mut t.borrow_mut()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_group_handle_is_e_abi_handle_not_a_panic() {
        let t = Table::new();
        let err = t.group(1).unwrap_err();
        assert_eq!(err.code, crate::abi::E_ABI_HANDLE);
        assert!(err.detail.contains('1'));
    }

    #[test]
    fn a_missing_staged_handle_is_e_abi_handle() {
        let mut t = Table::new();
        assert_eq!(t.take_staged(9).unwrap_err().code, crate::abi::E_ABI_HANDLE);
    }

    /// The staged table's full positive path, because `PublicProcessed::Rejected` is the one variant
    /// constructible without an MLS fixture. The group table's positive path
    /// (`insert_group` → `group` hit → `close_group` Ok → second `close_group` E_ABI_HANDLE) is driven
    /// end to end by `public_group_close_twice_is_a_bad_handle_the_second_time` in step 10, which has a
    /// real `DillaPublicGroup` from the committed fixture.
    #[test]
    fn a_staged_handle_is_issued_once_taken_once_and_then_gone() {
        let mut t = Table::new();
        assert_eq!(t.staged_count(), 0);
        let a = t.insert_staged(PublicProcessed::Rejected(dilla_core::ProtocolError::Binding));
        let b = t.insert_staged(PublicProcessed::Rejected(dilla_core::ProtocolError::Binding));
        assert_ne!(a, b, "handles never repeat");
        assert_eq!(t.staged_count(), 2);
        assert!(matches!(t.take_staged(a), Ok(PublicProcessed::Rejected(_))));
        assert_eq!(t.staged_count(), 1);
        assert_eq!(
            t.take_staged(a).unwrap_err().code,
            crate::abi::E_ABI_HANDLE,
            "taking the same staged handle twice must be a bad handle, not a second hit"
        );
    }

    #[test]
    fn ids_are_shared_between_the_two_classes_so_a_staged_id_is_never_a_group_id() {
        let mut t = Table::new();
        let staged = t.insert_staged(PublicProcessed::Rejected(dilla_core::ProtocolError::Binding));
        assert_eq!(t.group(staged).unwrap_err().code, crate::abi::E_ABI_HANDLE);
        assert_eq!(t.group_count(), 0);
    }

    #[test]
    fn handles_start_at_one_so_zero_is_never_valid() {
        let mut t = Table::new();
        assert_eq!(t.next_id(), 1);
        assert_eq!(t.group(0).unwrap_err().code, crate::abi::E_ABI_HANDLE);
    }
}
```

- [ ] **Step 9: Run the framing and handle tests together**

Run: `/home/thim/.cargo/bin/cargo test -p dilla-core-wasi --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: PASS — `11 passed` (`abi::tests` 6, `handles::tests` 5). `exports` and `shims` do not exist yet,
so the crate is complete as written.

- [ ] **Step 10: Write the failing dispatch tests and declare the module**

Add `pub mod exports;` to
`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasi/src/lib.rs`
(so that step 11's red state is a real compile error rather than an uncompiled file), and create
`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasi/src/exports.rs`
with only this test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use dilla_core::cbor::{decode_strict, Decoder, Encoder};

    fn req(build: impl FnOnce(&mut Encoder)) -> Vec<u8> {
        let mut e = Encoder::new();
        build(&mut e);
        e.into_vec()
    }

    fn version_only() -> Vec<u8> {
        req(|e| {
            e.array(1).uint(dilla_core::ABI_VERSION);
        })
    }

    /// Returns (code, detail) of a failure frame, or panics if the frame is a success.
    fn failure(bytes: &[u8]) -> (String, String) {
        decode_strict(bytes, |d: &mut Decoder<'_>| {
            d.array(3)?;
            assert_eq!(d.uint()?, 1, "expected a failure frame");
            Ok((d.text()?.to_owned(), d.text()?.to_owned()))
        })
        .expect("failure frames are always valid deterministic CBOR")
    }

    #[test]
    fn dilla_abi_reports_the_pinned_versions_and_ciphersuite() {
        let out = dispatch("dilla_abi", &version_only());
        let got = decode_strict(&out, |d: &mut Decoder<'_>| {
            d.array(6)?;
            let ok = d.uint()?;
            let abi = d.uint()?;
            let core = d.text()?.to_owned();
            let e2ee = d.uint()?;
            let media = d.uint()?;
            d.array(1)?;
            let suite = d.uint()?;
            Ok((ok, abi, core, e2ee, media, suite))
        })
        .unwrap();
        assert_eq!(got.0, 0);
        assert_eq!(got.1, dilla_core::ABI_VERSION);
        assert_eq!(got.2, dilla_core::CORE_VERSION);
        assert_eq!(got.3, dilla_core::E2EE_VERSION);
        assert_eq!(got.4, dilla_core::MEDIA_VERSION);
        assert_eq!(got.5, 0x0001, "the only ciphersuite at v1 is MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519");
    }

    #[test]
    fn an_unknown_abi_version_is_an_error_frame_not_a_trap() {
        let bad = req(|e| {
            e.array(1).uint(dilla_core::ABI_VERSION + 1);
        });
        assert_eq!(failure(&dispatch("dilla_abi", &bad)).0, crate::abi::E_ABI_VERSION);
    }

    #[test]
    fn truncated_cbor_is_e_abi_shape_not_a_trap() {
        assert_eq!(failure(&dispatch("dilla_abi", &[0x82, 0x01])).0, crate::abi::E_ABI_SHAPE);
        assert_eq!(failure(&dispatch("dilla_abi", &[])).0, crate::abi::E_ABI_SHAPE);
    }

    #[test]
    fn a_map_request_is_rejected_by_the_strict_decoder() {
        // a0 — the empty map, which the dilla CBOR subset forbids outright.
        assert_eq!(failure(&dispatch("dilla_abi", &[0xa0])).0, crate::abi::E_ABI_SHAPE);
    }

    #[test]
    fn an_unknown_export_name_is_an_error_frame() {
        assert_eq!(failure(&dispatch("nope", &version_only())).0, crate::abi::E_ABI_SHAPE);
    }

    #[test]
    fn every_public_group_export_rejects_a_handle_that_was_never_issued() {
        for name in [
            "public_group_export_state",
            "public_group_close",
            "public_group_tree",
            "public_group_state",
            "public_group_proposal_list",
        ] {
            let r = req(|e| {
                e.array(2).uint(dilla_core::ABI_VERSION).uint(4_242);
            });
            assert_eq!(failure(&dispatch(name, &r)).0, crate::abi::E_ABI_HANDLE, "{name}");
        }
    }

    #[test]
    fn merging_a_staged_handle_that_was_never_issued_is_e_abi_handle() {
        let r = req(|e| {
            e.array(3).uint(dilla_core::ABI_VERSION).uint(1).uint(7);
        });
        assert_eq!(failure(&dispatch("public_group_merge", &r)).0, crate::abi::E_ABI_HANDLE);
    }

    #[test]
    fn vectors_check_reports_no_failures() {
        let out = dispatch("vectors_check", &version_only());
        let (ok, passed, failed) = decode_strict(&out, |d: &mut Decoder<'_>| {
            d.array(4)?;
            let ok = d.uint()?;
            let passed = d.uint()?;
            let failed = d.uint()?;
            d.skip()?;
            Ok((ok, passed, failed))
        })
        .unwrap();
        assert_eq!(ok, 0);
        assert_eq!(failed, 0, "the wasi build must reproduce every committed vector");
        assert!(passed > 0, "a zero-case report would pass vacuously");
    }

    #[test]
    fn the_vectors_report_carries_the_same_suites_as_the_native_runner() {
        let native = dilla_core::vectors::run_all();
        let out = dispatch("vectors_check", &version_only());
        let names = decode_strict(&out, |d: &mut Decoder<'_>| {
            d.array(4)?;
            d.uint()?;
            d.uint()?;
            d.uint()?;
            let n = d.array_len()?;
            let mut names = Vec::with_capacity(n);
            for _ in 0..n {
                d.array(2)?;
                names.push(d.text()?.to_owned());
                d.skip()?;
            }
            Ok(names)
        })
        .unwrap();
        let expected: Vec<String> = native.suites.iter().map(|s| s.name.to_string()).collect();
        assert_eq!(names, expected);
    }

    /// The committed 1,500-leaf fixture of Plan A task 13. `include_bytes!` is the only way to reach
    /// it from a `crate-type = ["cdylib"]` crate: no `tests/` integration target can link this
    /// library, so the fixture is compiled into the unit-test binary instead. The paths are relative
    /// to `core/dilla-core-wasi/src/`.
    const FIXTURE_TREE: &[u8] = include_bytes!("../../../testkit/fixtures/ds-1500/ratchet_tree.mls");
    const FIXTURE_GROUP_INFO: &[u8] = include_bytes!("../../../testkit/fixtures/ds-1500/group_info.mls");

    /// Creates the fixture group and returns `(handle, epoch, group_id, tree_hash)`.
    fn create_fixture_group() -> (u64, u64, Vec<u8>, Vec<u8>) {
        let r = req(|e| {
            e.array(3)
                .uint(dilla_core::ABI_VERSION)
                .bytes(FIXTURE_TREE)
                .bytes(FIXTURE_GROUP_INFO);
        });
        let out = dispatch("public_group_create", &r);
        decode_strict(&out, |d: &mut Decoder<'_>| {
            d.array(6)?;
            assert_eq!(d.uint()?, 0, "public_group_create must accept the committed fixture");
            let handle = d.uint()?;
            let epoch = d.uint()?;
            let group_id = d.bytes()?.to_vec();
            let tree_hash = d.bytes()?.to_vec();
            d.skip()?; // the re-serialised GroupInfo; its framing is asserted by Plan B task 3.
            Ok((handle, epoch, group_id, tree_hash))
        })
        .expect("the create response is deterministic CBOR")
    }

    /// interfaces §6 task 14: `public_group_export_state` → `public_group_import_state` →
    /// `public_group_state` reproduces the epoch and tree hash.
    #[test]
    fn state_round_trips_through_export_and_import_byte_for_byte() {
        let (handle, epoch, group_id, tree_hash) = create_fixture_group();

        let r = req(|e| {
            e.array(2).uint(dilla_core::ABI_VERSION).uint(handle);
        });
        let state = decode_strict(&dispatch("public_group_export_state", &r), |d: &mut Decoder<'_>| {
            d.array(2)?;
            assert_eq!(d.uint()?, 0);
            Ok(d.bytes()?.to_vec())
        })
        .unwrap();
        assert!(!state.is_empty(), "an empty state blob would make the round-trip vacuous");

        let r = req(|e| {
            e.array(3).uint(dilla_core::ABI_VERSION).bytes(&state).bytes(&group_id);
        });
        let (imported, imported_epoch) =
            decode_strict(&dispatch("public_group_import_state", &r), |d: &mut Decoder<'_>| {
                d.array(3)?;
                assert_eq!(d.uint()?, 0);
                Ok((d.uint()?, d.uint()?))
            })
            .unwrap();
        assert_eq!(imported_epoch, epoch);

        let r = req(|e| {
            e.array(2).uint(dilla_core::ABI_VERSION).uint(imported);
        });
        let (got_epoch, got_group_id, got_tree_hash, members) =
            decode_strict(&dispatch("public_group_state", &r), |d: &mut Decoder<'_>| {
                d.array(6)?;
                assert_eq!(d.uint()?, 0);
                let epoch = d.uint()?;
                let group_id = d.bytes()?.to_vec();
                let tree_hash = d.bytes()?.to_vec();
                // Deviation A2-13: element 5 is a byte string wrapping the 8-element binding array.
                let binding = d.bytes()?.to_vec();
                let members = d.array_len()?;
                for _ in 0..members {
                    d.array(3)?;
                    d.uint()?;
                    d.bytes()?;
                    d.bytes()?;
                }
                assert!(!binding.is_empty(), "dilla_binding must survive the state round-trip");
                Ok((epoch, group_id, tree_hash, members))
            })
            .unwrap();
        assert_eq!(got_epoch, epoch);
        assert_eq!(got_group_id, group_id);
        assert_eq!(got_tree_hash, tree_hash, "the tree hash must survive export and import");
        assert_eq!(members, 1_500, "the committed fixture has 1,500 leaves");
    }

    #[test]
    fn public_group_close_twice_is_a_bad_handle_the_second_time() {
        let (handle, _, _, _) = create_fixture_group();
        let close = req(|e| {
            e.array(2).uint(dilla_core::ABI_VERSION).uint(handle);
        });
        let first = dispatch("public_group_close", &close);
        decode_strict(&first, |d: &mut Decoder<'_>| {
            d.array(1)?;
            assert_eq!(d.uint()?, 0, "the first close succeeds");
            Ok(())
        })
        .unwrap();
        assert_eq!(failure(&dispatch("public_group_close", &close)).0, crate::abi::E_ABI_HANDLE);
        assert_eq!(failure(&dispatch("public_group_tree", &close)).0, crate::abi::E_ABI_HANDLE);
    }

    /// NV-3c's regression net. It proves the signer can be built and used without panicking, which is
    /// the failure mode a wrong `from_raw` private-key layout produces inside openmls_rust_crypto. It
    /// does **not** prove the signature verifies against a real group: that needs a group whose
    /// `external_senders` carries this public key, which is Plan A task 13's testkit scenario
    /// `external_propose_remove produces a message a member accepts as coming from sender index 0`.
    #[test]
    fn the_instance_signer_is_derived_from_the_private_half_and_signs_without_panicking() {
        let sk = [0x0bu8; 32];
        let signer = super::instance_signer(&sk);
        assert_eq!(
            signer.public(),
            dilla_core::identity::SskSigner::from_bytes(&sk).public(),
            "the public half must be derived, never taken from the request"
        );

        let r = req(|e| {
            e.array(5)
                .uint(dilla_core::ABI_VERSION)
                .bytes(&[0x11u8; 16])
                .uint(7)
                .uint(3)
                .bytes(&sk);
        });
        let message = decode_strict(&dispatch("external_propose_remove", &r), |d: &mut Decoder<'_>| {
            d.array(2)?;
            assert_eq!(d.uint()?, 0, "external_propose_remove must produce a success frame");
            Ok(d.bytes()?.to_vec())
        })
        .unwrap();
        assert!(!message.is_empty(), "an empty MLSMessage would pass vacuously");
        crate::abi::tls::mls_message_in(&message).expect("the output must be a well-formed MLSMessage");
    }
}
```

The fixture round-trip and the close-twice test are the two assertions interfaces §6 task 14 names that no
error-path test can carry: without them every `public_group_*` handler could be silently wrong and the
suite would still be green. They depend on Plan A task 13 having committed
`testkit/fixtures/ds-1500/{ratchet_tree.mls,group_info.mls}`; if that task has not landed, `include_bytes!`
fails the build with the missing path, which is the correct loud failure.

The remaining named test, `dilla_alloc`/`dilla_free` round-trip, is **deferred**, on the same footing as the
export-section assertion at step 15: the shims are `#[cfg(target_family = "wasm")]`, so nothing native can
call them, and there is no 32-bit linear memory to allocate in. **Plan B task 3's
`TestCallCopiesTheResponseOutOfLinearMemory` carries it** — it allocates through `dilla_alloc`, writes a
request, reads the response back and frees both under wazero, which is the only place the contract is real.

- [ ] **Step 11: Run the dispatch tests to verify they fail**

Run: `/home/thim/.cargo/bin/cargo test -p dilla-core-wasi --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: FAIL to compile — `cannot find function 'dispatch' in this scope` in `exports.rs`, together with
the same for `create_fixture_group`'s callees. If `include_bytes!` reports
`couldn't read ../../../testkit/fixtures/ds-1500/ratchet_tree.mls`, Plan A task 13 has not landed; that is a
hard dependency of this task, not something to stub out.

- [ ] **Step 12: Write `exports.rs`**

Put this above the `#[cfg(test)] mod tests` block in `core/dilla-core-wasi/src/exports.rs`:

```rust
//! The fifteen `(ptr, len) -> u64` handlers of interfaces §2.10, written as pure functions over
//! `&[u8]` so the native test build drives exactly the same encoders the wasm build does.

// `Decoder` is deliberately absent: nothing outside the `#[cfg(test)]` module (which has its own
// `use`) names the type, and `cargo clippy --all-targets -- -D warnings` at step 16 fails on an
// unused import.
use dilla_core::cbor::Encoder;
use dilla_core::identity::CredentialIdentity;
use dilla_core::public_group::{
    external_propose_add, external_propose_remove, validate_key_package, DillaPublicGroup,
    PublicProcessed,
};
// `BasicCredential` lives in `openmls::credentials` (facts-openmls §7), not in
// `openmls_basic_credential`, which exports only `SignatureKeyPair`. Import it explicitly rather than
// relying on `openmls::prelude::*`: step 1 confirms whether the prelude re-exports it, and if it
// does, this line is redundant but harmless; if it does not, the crate still compiles.
use openmls::credentials::BasicCredential;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::RustCrypto;

use crate::abi::{self, tls, AbiError};
use crate::handles::{with_table, Table};

/// The only ciphersuite dilla speaks at e2ee_version 1 (`protocol/00-overview.md`).
const CIPHERSUITE_ID: u64 = 0x0001;

/// Routes one request by export name. Never panics and never returns an OpenMLS type.
pub fn dispatch(export: &str, req: &[u8]) -> Vec<u8> {
    let result = with_table(|t| match export {
        "dilla_abi" => abi_info(req, t),
        "vectors_check" => vectors_check(req, t),
        "public_group_create" => public_group_create(req, t),
        "public_group_import_state" => public_group_import_state(req, t),
        "public_group_export_state" => public_group_export_state(req, t),
        "public_group_close" => public_group_close(req, t),
        "public_group_process" => public_group_process(req, t),
        "public_group_merge" => public_group_merge(req, t),
        "public_group_tree" => public_group_tree(req, t),
        "public_group_state" => public_group_state(req, t),
        "public_group_proposal_put" => public_group_proposal_put(req, t),
        "public_group_proposal_list" => public_group_proposal_list(req, t),
        "validate_key_package" => validate_key_package_export(req, t),
        "external_propose_add" => external_propose_add_export(req, t),
        "external_propose_remove" => external_propose_remove_export(req, t),
        other => Err(AbiError::shape(format!("unknown export {other}"))),
    });
    match result {
        Ok(bytes) => bytes,
        Err(err) => abi::error_response(&err),
    }
}

fn abi_info(req: &[u8], _t: &mut Table) -> Result<Vec<u8>, AbiError> {
    abi::open(req, 1)?.finish()?;
    let mut e = Encoder::new();
    e.array(6)
        .uint(0)
        .uint(dilla_core::ABI_VERSION)
        .text(dilla_core::CORE_VERSION)
        .uint(dilla_core::E2EE_VERSION)
        .uint(dilla_core::MEDIA_VERSION)
        .array(1)
        .uint(CIPHERSUITE_ID);
    Ok(e.into_vec())
}

/// Deviation A2-9: the report's elements are emitted after the `0`, not the whole
/// `VectorReport::encode` array nested inside it.
fn vectors_check(req: &[u8], _t: &mut Table) -> Result<Vec<u8>, AbiError> {
    abi::open(req, 1)?.finish()?;
    let report = dilla_core::vectors::run_all();
    let mut e = Encoder::new();
    e.array(4).uint(0).uint(u64::from(report.passed)).uint(u64::from(report.failed));
    e.array(report.suites.len());
    for suite in &report.suites {
        e.array(2).text(suite.name).array(suite.cases.len());
        for case in &suite.cases {
            e.array(5)
                .text(&case.case)
                .text(case.field)
                .uint(u64::from(case.ok))
                .text(&case.expected)
                .text(&case.actual);
        }
    }
    Ok(e.into_vec())
}

fn public_group_create(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 3)?;
    let tree = d.bytes()?;
    let group_info = d.bytes()?;
    d.finish()?;

    let crypto = RustCrypto::default();
    let (group, gi) =
        DillaPublicGroup::from_external(&crypto, tls::ratchet_tree_in(tree)?, tls::verifiable_group_info(group_info)?)?;
    let gi_bytes = tls::group_info_out(&gi)?;
    let epoch = group.epoch();
    let group_id = group.group_id().as_slice().to_vec();
    let tree_hash = group.tree_hash();
    let handle = t.insert_group(group);

    let mut e = Encoder::new();
    e.array(6)
        .uint(0)
        .uint(u64::from(handle))
        .uint(epoch)
        .bytes(&group_id)
        .bytes(&tree_hash)
        .bytes(&gi_bytes);
    Ok(e.into_vec())
}

fn public_group_import_state(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 3)?;
    let state = d.bytes()?;
    let group_id = d.bytes()?;
    d.finish()?;

    let group = DillaPublicGroup::import_state(state, &GroupId::from_slice(group_id))?;
    let epoch = group.epoch();
    let handle = t.insert_group(group);

    let mut e = Encoder::new();
    e.array(3).uint(0).uint(u64::from(handle)).uint(epoch);
    Ok(e.into_vec())
}

fn public_group_export_state(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 2)?;
    let handle = abi::read_handle(&mut d)?;
    d.finish()?;

    let state = t.group(handle)?.export_state();
    let mut e = Encoder::new();
    e.array(2).uint(0).bytes(&state);
    Ok(e.into_vec())
}

fn public_group_close(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 2)?;
    let handle = abi::read_handle(&mut d)?;
    d.finish()?;

    t.close_group(handle)?;
    let mut e = Encoder::new();
    e.array(1).uint(0);
    Ok(e.into_vec())
}

fn public_group_process(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 3)?;
    let handle = abi::read_handle(&mut d)?;
    let message = d.bytes()?;
    d.finish()?;

    let crypto = RustCrypto::default();
    let pm = tls::protocol_message(message)?;
    // process_message takes &self and writes nothing (gap-1 §6), so the borrow ends here and the
    // staged commit can then be moved into the table.
    let (processed, epoch) = {
        let group = t.group(handle)?;
        (group.process_message(&crypto, pm)?, group.epoch())
    };

    let (kind, sender_leaf, staged, proposal_ref) = match processed {
        PublicProcessed::Proposal { proposal_ref, sender_leaf } => (0u64, sender_leaf, None, Some(proposal_ref)),
        PublicProcessed::ExternalJoinProposal { proposal_ref } => (2, None, None, Some(proposal_ref)),
        p @ PublicProcessed::StagedCommit { .. } => {
            let sender = match &p {
                PublicProcessed::StagedCommit { sender_leaf, .. } => *sender_leaf,
                _ => unreachable!("matched StagedCommit one line above"),
            };
            let staged_handle = t.insert_staged(p);
            (1, sender, Some(staged_handle), None)
        }
        // kind 3: the DS never sees a PrivateMessage; the message is reported, not raised.
        PublicProcessed::Rejected(_) => (3, None, None, None),
    };

    let mut e = Encoder::new();
    e.array(6).uint(0).uint(kind).uint(epoch);
    e.opt_uint(sender_leaf.map(u64::from));
    e.opt_uint(staged.map(u64::from));
    e.opt_bytes(proposal_ref.as_deref());
    Ok(e.into_vec())
}

fn public_group_merge(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 3)?;
    let handle = abi::read_handle(&mut d)?;
    let staged = abi::read_handle(&mut d)?;
    d.finish()?;

    let processed = t.take_staged(staged)?;
    let commit = match processed {
        PublicProcessed::StagedCommit { staged, .. } => staged,
        _ => return Err(AbiError::state(format!("handle {staged} is not a staged commit"))),
    };
    let group = t.group_mut(handle)?;
    group.merge_commit(*commit)?;
    let epoch = group.epoch();

    let mut e = Encoder::new();
    e.array(2).uint(0).uint(epoch);
    Ok(e.into_vec())
}

fn public_group_tree(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 2)?;
    let handle = abi::read_handle(&mut d)?;
    d.finish()?;

    let group = t.group(handle)?;
    let tree = tls::ratchet_tree_out(&group.export_ratchet_tree())?;
    let mut e = Encoder::new();
    e.array(4).uint(0).bytes(&tree).bytes(&group.tree_hash()).uint(group.epoch());
    Ok(e.into_vec())
}

fn public_group_state(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 2)?;
    let handle = abi::read_handle(&mut d)?;
    d.finish()?;

    let group = t.group(handle)?;
    let binding = group.binding().encode();
    let members = group.members();

    // Deviation A2-13: element 5 is a CBOR byte string *wrapping* the 8-element dilla_binding array,
    // which is how §2.10's export table types it (`binding(bstr)`). The same section's field note
    // says "spliced verbatim"; that note is wrong, and splicing a bare array here would make
    // §2.13's mlswasi decoder read a major-4 head where it expects major 2. The Go side decodes the
    // bstr, then decodes the binding array out of those bytes.
    let mut e = Encoder::new();
    e.array(6)
        .uint(0)
        .uint(group.epoch())
        .bytes(group.group_id().as_slice())
        .bytes(&group.tree_hash())
        .bytes(&binding);
    e.array(members.len());
    for m in &members {
        e.array(3).uint(u64::from(m.leaf_index)).bytes(&m.signature_key).bytes(&m.identity.encode());
    }
    Ok(e.into_vec())
}

fn public_group_proposal_put(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 4)?;
    let handle = abi::read_handle(&mut d)?;
    let op = d.uint()?;
    let mut e = Encoder::new();
    match op {
        0 => {
            let proposal = d.bytes()?;
            d.finish()?;
            let crypto = RustCrypto::default();
            // NV-4: framing and signature verification stay inside dilla-core. `queue_proposal`
            // (Plan A task 11) takes the received ProtocolMessage, verifies it against the group
            // context, stores the original bytes beside the QueuedProposal (deviation A2-11) and
            // returns the new proposal's reference bytes. The wasi crate never builds an
            // `AuthenticatedContent` or a `QueuedProposal` of its own.
            let pm = tls::protocol_message(proposal)?;
            let proposal_ref = t.group_mut(handle)?.queue_proposal(&crypto, pm)?;
            e.array(2).uint(0).bytes(&proposal_ref);
        }
        1 => {
            let raw = d.bytes()?;
            d.finish()?;
            let group = t.group_mut(handle)?;
            let target = group
                .queued_proposals()?
                .into_iter()
                .find(|(r, _)| proposal_ref_bytes(r) == raw)
                .map(|(r, _)| r)
                .ok_or_else(|| AbiError::state("no queued proposal with that ref"))?;
            group.remove_proposal(&target)?;
            e.array(2).uint(0).null();
        }
        2 => {
            d.null()?;
            d.finish()?;
            let group = t.group_mut(handle)?;
            for (r, _) in group.queued_proposals()? {
                group.remove_proposal(&r)?;
            }
            e.array(2).uint(0).null();
        }
        other => return Err(AbiError::shape(format!("proposal op {other}, expected 0, 1 or 2"))),
    }
    Ok(e.into_vec())
}

fn public_group_proposal_list(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 2)?;
    let handle = abi::read_handle(&mut d)?;
    d.finish()?;

    // Deviation A2-11: the second element is the original MLSMessage the DS received, not a bare
    // `Proposal`. The DS hands this list straight back to clients in §2.12's CommitConflict and
    // CommitRequired, and a bare Proposal has lost its FramedContent and signature, so a client
    // could not process what it got back. `queued_proposals()` yields `(ProposalRef, Vec<u8>)` of
    // (reference, received bytes) — Plan A task 11 owns that, raised in step 1.
    let queued = t.group(handle)?.queued_proposals()?;
    let mut e = Encoder::new();
    e.array(2).uint(0).array(queued.len());
    for (r, message) in &queued {
        e.array(2).bytes(&proposal_ref_bytes(r)).bytes(message);
    }
    Ok(e.into_vec())
}

fn validate_key_package_export(req: &[u8], _t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 2)?;
    let bytes = d.bytes()?;
    d.finish()?;

    let crypto = RustCrypto::default();
    let kp = validate_key_package(&crypto, tls::key_package_in(bytes)?)?;
    let identity = CredentialIdentity::decode(&leaf_credential_bytes(&kp)?)?;

    let mut e = Encoder::new();
    e.array(5)
        .uint(0)
        .bytes(identity.device_id.as_bytes())
        .bytes(identity.user_id.as_bytes())
        .uint(u64::from(is_last_resort(&kp)))
        .uint(lifetime_not_after(&kp)?);
    Ok(e.into_vec())
}

fn external_propose_add_export(req: &[u8], _t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 5)?;
    let group_id = d.bytes()?;
    let epoch = d.uint()?;
    let key_package = d.bytes()?;
    let signing_key = d.bytes_exact::<32>()?;
    d.finish()?;

    let crypto = RustCrypto::default();
    let kp = validate_key_package(&crypto, tls::key_package_in(key_package)?)?;
    let signer = instance_signer(&signing_key);
    let out = external_propose_add(kp, GroupId::from_slice(group_id), GroupEpoch::from(epoch), &signer)?;

    let mut e = Encoder::new();
    e.array(2).uint(0).bytes(&tls::message_out(&out)?);
    Ok(e.into_vec())
}

fn external_propose_remove_export(req: &[u8], _t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 5)?;
    let group_id = d.bytes()?;
    let epoch = d.uint()?;
    let leaf = d.uint()?;
    let signing_key = d.bytes_exact::<32>()?;
    d.finish()?;

    let leaf = u32::try_from(leaf).map_err(|_| AbiError::shape(format!("leaf_index {leaf} does not fit in u32")))?;
    let signer = instance_signer(&signing_key);
    let out = external_propose_remove(
        LeafNodeIndex::new(leaf),
        GroupId::from_slice(group_id),
        GroupEpoch::from(epoch),
        &signer,
    )?;

    let mut e = Encoder::new();
    e.array(2).uint(0).bytes(&tls::message_out(&out)?);
    Ok(e.into_vec())
}

/// Rebuilds the instance's Ed25519 signer from its 32-byte private half. `SskSigner` is used only
/// as dilla-core's verified Ed25519 public-key derivation; the key it holds is the instance key,
/// not an SSK.
fn instance_signer(private: &[u8; 32]) -> SignatureKeyPair {
    let public = dilla_core::identity::SskSigner::from_bytes(private).public();
    SignatureKeyPair::from_raw(SignatureScheme::ED25519, private.to_vec(), public.to_vec())
}
```

The five helpers `proposal_ref_bytes`, `instance_signer`, `leaf_credential_bytes`, `is_last_resort` and
`lifetime_not_after` are written in step 13 with the NV-3 and NV-3b answers from step 1. There is no sixth:
NV-4 settles that nothing here builds a `QueuedProposal`, and deviation A2-11 settles that nothing here
serialises a bare `Proposal`.

- [ ] **Step 13: Write the four OpenMLS accessor helpers and the wasm shims**

Append to `core/dilla-core-wasi/src/exports.rs`, filling each body with the exact accessor recorded in step 1
(do not guess a name that step 1 did not confirm):

```rust
/// NV-3b: the ProposalRef's opaque bytes, as `protocol/02-delivery-service.md` moves them.
fn proposal_ref_bytes(r: &ProposalRef) -> Vec<u8> {
    r.as_slice().to_vec()
}

/// NV-3: the leaf credential's identity bytes, which are dilla's `CredentialIdentity` CBOR.
///
/// Returns an owned `Vec`, never a leaked borrow. `BasicCredential::try_from` produces an owned
/// temporary, so `identity()` can only borrow from it; the earlier `Box::leak` form leaked one
/// allocation per call, and this export is the DS's per-KeyPackage-upload hot path, driven by remote
/// input, inside a wazero instance that dillad pools and keeps alive for the process lifetime (R9).
/// That is a remote memory-exhaustion path, not a style question. The single caller passes the slice
/// straight to `CredentialIdentity::decode(&…)`, so the allocation dies at the end of the call.
fn leaf_credential_bytes(kp: &KeyPackage) -> Result<Vec<u8>, AbiError> {
    let credential = kp.leaf_node().credential();
    BasicCredential::try_from(credential.clone())
        .map(|b| b.identity().to_vec())
        .map_err(|e| AbiError::new("E_CREDENTIAL", e.to_string()))
}

/// NV-3: `last_resort` is a KeyPackage extension, not a leaf-node one.
fn is_last_resort(kp: &KeyPackage) -> bool {
    kp.last_resort()
}

/// NV-3: the upper bound of the leaf's `Lifetime`, in seconds since the Unix epoch.
fn lifetime_not_after(kp: &KeyPackage) -> Result<u64, AbiError> {
    kp.leaf_node()
        .life_time()
        .map(|lt| lt.not_after())
        .ok_or_else(|| AbiError::new("E_CREDENTIAL", "leaf node carries no lifetime"))
}
```

Then append the shims module to
`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasi/src/lib.rs`. It
lands here, not earlier, because it names `crate::exports::dispatch`, which step 12 is the first step to
provide:

```rust
/// The C-shaped exports. Only built for wasm: the ABI's `u32` pointers are the linear-memory
/// addresses of a 32-bit target and have no meaning on a 64-bit host. Native `cargo test` drives
/// the same request and response encoders through [`exports::dispatch`], and Plan B task 3 asserts
/// the built module's export section under wazero.
///
/// Every pointer/integer conversion below goes through `usize`. rustc rejects a direct
/// `*mut u8 as u32` (E0606, "casting `*mut u8` as `u32` is invalid; cast through `usize` first"),
/// and the two-step form is sound here only because `usize == u32` on both wasm32 targets — which is
/// the ABI's premise anyway, since the host addresses this memory with 32-bit offsets.
#[cfg(target_family = "wasm")]
mod shims {
    use core::mem::MaybeUninit;

    use crate::abi::pack;
    use crate::exports::dispatch;

    /// Allocates `size` uninitialised bytes and returns their address (gap-16 §6 item 1).
    #[unsafe(export_name = "dilla_alloc")]
    pub unsafe extern "C" fn dilla_alloc(size: u32) -> u32 {
        let buf: Vec<MaybeUninit<u8>> = vec![MaybeUninit::uninit(); size as usize];
        Box::into_raw(buf.into_boxed_slice()) as *mut u8 as usize as u32
    }

    /// Frees a buffer previously returned by `dilla_alloc` or by any export's response pointer.
    ///
    /// # Safety
    /// `ptr` must be an address this module returned, with the same `size`, freed at most once.
    #[unsafe(export_name = "dilla_free")]
    pub unsafe extern "C" fn dilla_free(ptr: u32, size: u32) {
        if ptr == 0 {
            return;
        }
        unsafe { drop(Vec::from_raw_parts(ptr as usize as *mut u8, 0, size as usize)) }
    }

    /// Moves a response into linear memory and packs its address and length.
    fn emit(bytes: Vec<u8>) -> u64 {
        let len = bytes.len() as u32;
        // into_boxed_slice() makes capacity == len, which is what dilla_free assumes.
        let boxed = bytes.into_boxed_slice();
        let ptr = Box::into_raw(boxed) as *mut u8 as usize as u32;
        pack(ptr, len)
    }

    /// # Safety
    /// `ptr`/`len` must address a readable region the host wrote with `dilla_alloc`.
    unsafe fn request<'a>(ptr: u32, len: u32) -> &'a [u8] {
        if len == 0 {
            return &[];
        }
        unsafe { core::slice::from_raw_parts(ptr as usize as *const u8, len as usize) }
    }

    macro_rules! abi_export {
        ($name:ident) => {
            /// # Safety
            /// See [`request`]; the response must be released with `dilla_free`.
            #[unsafe(export_name = stringify!($name))]
            pub unsafe extern "C" fn $name(ptr: u32, len: u32) -> u64 {
                let req = unsafe { request(ptr, len) };
                emit(dispatch(stringify!($name), req))
            }
        };
    }

    abi_export!(dilla_abi);
    abi_export!(vectors_check);
    abi_export!(public_group_create);
    abi_export!(public_group_import_state);
    abi_export!(public_group_export_state);
    abi_export!(public_group_close);
    abi_export!(public_group_process);
    abi_export!(public_group_merge);
    abi_export!(public_group_tree);
    abi_export!(public_group_state);
    abi_export!(public_group_proposal_put);
    abi_export!(public_group_proposal_list);
    abi_export!(validate_key_package);
    abi_export!(external_propose_add);
    abi_export!(external_propose_remove);
}
```

- [ ] **Step 14: Run the dispatch tests to verify they pass**

Run: `/home/thim/.cargo/bin/cargo test -p dilla-core-wasi --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: PASS — `23 passed`: `abi::tests` 6, `handles::tests` 5, `exports::tests` 12.

- [ ] **Step 15: Build the wasip1 module and check its size**

Run: `/home/thim/.cargo/bin/cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: PASS, producing
`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/target/wasm32-wasip1/release/dilla_core_wasi.wasm`.

Run: `ls -l /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/target/wasm32-wasip1/release/dilla_core_wasi.wasm`

Expected: a file of non-zero size. The assertion that its export section holds exactly the 17 names plus
`_initialize` and `memory` is **Plan B task 3's** — no Rust-side wasm export-section reader exists in this
workspace, and Plan B's wazero host already reads `CompiledModule.ExportedFunctions()` for its
`WithStartFunctions` guard.

- [ ] **Step 16: Lint and format**

Run: `/home/thim/.cargo/bin/cargo fmt --all --check --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: PASS (no output).

Run: `/home/thim/.cargo/bin/cargo clippy -p dilla-core-wasi --all-targets --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -- -D warnings`

Expected: PASS. `unsafe_code = "warn"` is a workspace lint; the `shims` module opts back in with
`#![allow(unsafe_code)]` at its top if clippy objects — add that line rather than weakening the workspace lint.

- [ ] **Step 17: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add core/dilla-core-wasi/Cargo.toml core/dilla-core-wasi/src/lib.rs core/dilla-core-wasi/src/abi.rs core/dilla-core-wasi/src/handles.rs core/dilla-core-wasi/src/exports.rs Cargo.lock && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(core-wasi): CBOR wasi ABI with the PublicGroup and vectors exports'
```

---

### Task 15: `dilla-core-wasm` — the wasm-bindgen surface

**Files:**
- Create: `core/dilla-core-wasm/src/lib.rs` (replaces task 1's stub)
- Create: `core/dilla-core-wasm/src/store.rs`
- Create: `core/dilla-core-wasm/src/probe.rs`
- Modify: `core/dilla-core-wasm/Cargo.toml` (deviation A2-2 adds the wasm SQLite block)
- Modify: `.gitignore` (adds `core/dilla-core-wasm/spike/pkg/` and `.../spike/node_modules/`)
- Test: the `#[cfg(test)]` module inside `src/lib.rs` (native, exercises the pure surface against the committed vectors), plus a `wasm32-unknown-unknown` build, a `wasm-pack build` and a `tsc --noEmit` of the generated `.d.ts`. `store_open` and `probe_persistence` cannot run outside a dedicated worker in a secure context (gap-11 §8), so they are executed in task 17 and asserted in task 18.

**Interfaces:**
- Consumes: `dilla_core::envelope::{Envelope, EnvelopeType, Attachment, Preview, FrankingTagInput, franking_tag}`; `dilla_core::sframe::{Kid, Ctr, derive_keys, encode_header, NK, NN}`; `dilla_core::identity::{safety_number, sas, recovery_key_base32, CredentialIdentity, Kind, Tier, SignerTier}`; `dilla_core::ids::{MsgId, DeviceId, UserId}`; `dilla_core::vectors::run_all`; `dilla_core::{ProtocolError, CORE_VERSION, ABI_VERSION}`.
- Produces: every `#[wasm_bindgen]` item of interfaces §2.11 — `core_version`, `abi_version`, `vectors_check_json`, `vectors_check_ok`, `envelope_encode`, `envelope_decode_json`, `envelope_commitment`, `franking_tag`, `SframeKeysJs`, `sframe_derive`, `sframe_header`, `safety_number`, `sas`, `recovery_key_base32`, `credential_identity_cbor`, `StoreOpenConfig`, `StoreHandle`, `store_open`, `probe_persistence`, `is_sah_contention`.

- [ ] **Step 1: Resolve NV-6, NV-7, NV-12 and NV-13**

Open and record the exact spellings; do not write a name this step did not confirm.

1. `https://docs.rs/web-sys/0.3.81/web_sys/struct.FileSystemGetFileOptions.html` — is the `create` setter
   `set_create(&self, value: bool)` or the older builder `create(&mut self, value: bool) -> &mut Self`?
2. `https://docs.rs/web-sys/0.3.81/web_sys/struct.WorkerNavigator.html` — the accessor returning
   `StorageManager`, and `https://docs.rs/web-sys/0.3.81/web_sys/struct.FileSystemDirectoryHandle.html`
   for `get_file_handle_with_options` and `remove_entry`.
3. `https://docs.rs/sqlite-wasm-vfs/0.2.0/sqlite_wasm_vfs/sahpool/enum.OpfsSAHError.html` — the variant
   carrying the `createSyncAccessHandle` `JsValue` (gap-11 §6 and gap-14 §0 both say
   `CreateSyncAccessHandle(JsValue)`), and whether the enum is `#[non_exhaustive]` (step 6's match already
   has a `_ =>` arm either way).
4. `https://docs.rs/wasm-bindgen/0.2.128/wasm_bindgen/struct.JsError.html` — whether `JsError` can be
   **constructed on a non-wasm target** and whether it implements `Debug` (NV-12). wasm-bindgen's `externs!`
   intrinsics compile to panicking stubs off wasm, and `Result::unwrap` on a `Result<_, JsError>` needs
   `JsError: Debug`. Step 3's native test module is written so that no test takes an error path, but every
   success-path `.unwrap()` still needs `Debug`. If either is missing, split the surface: move the fallible
   logic into plain `fn`s returning `dilla_core::ProtocolError`, keep the `#[wasm_bindgen]` wrappers as thin
   `map_err` shells, point the native tests at the inner functions, and record the deviation.
5. `https://docs.rs/wasm-bindgen/0.2.128/wasm_bindgen/attr.wasm_bindgen.html`, section "Support for
   async/await" — whether an exported `async fn` may take `&self` (NV-13), since the generated future must
   be `'static`. `StoreHandle::reserve_capacity` and `StoreHandle::resume` of interfaces §2.11 are both
   `pub async fn …(&self, …)`. If a borrowed receiver is rejected, move both behind free functions taking
   the handle and record the deviation from §2.11.

- [ ] **Step 2: Add the wasm SQLite dependencies (deviation A2-2) and the ignore rules**

Append to `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasm/Cargo.toml`:

```toml
# Deviation A2-2. Pins copied verbatim from interfaces §3.1's wasm block. rusqlite keeps its default
# features: dropping them removes the `ffi-sqlite-wasm-rs` backend entirely (gap-12 T1). The direct
# `sqlite3mc` feature on sqlite-wasm-rs is what unifies encryption into rusqlite's single copy; drop
# this dependency and encryption silently disappears (gap-11 §9 item 2). sqlite-wasm-vfs 0.2.0 has
# NO [features] table — never write features = ["sahpool"].
[target.'cfg(all(target_arch = "wasm32", target_os = "unknown"))'.dependencies]
rusqlite        = { version = "0.40.2" }
sqlite-wasm-rs  = { version = "0.5.5", default-features = false, features = ["sqlite3mc"] }
sqlite-wasm-vfs = "0.2.0"
```

Append to the crate's plain `[dependencies]` table (deviation A2-14; the pin is interfaces §3.1's):

```toml
# Deviation A2-14: StoreHandle keeps the 256-bit device KEK for the lifetime of the handle so that
# resume() can replay PRAGMA key, and builds a pragma string containing it on every open and resume.
# Zeroizing is what keeps both out of freed wasm linear memory.
zeroize = { version = "1", features = ["zeroize_derive"] }
```

Append to `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/.gitignore`:

```
core/dilla-core-wasm/spike/pkg/
core/dilla-core-wasm/spike/node_modules/
```

Adding dependency edges makes `Cargo.lock` stale, so refresh it **before** any `--locked` command, exactly as
task 14 step 3 did:

Run: `/home/thim/.cargo/bin/cargo metadata --format-version 1 --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml > /dev/null`

Expected: PASS.

Run: `git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol diff -U0 -- Cargo.lock | grep -E '^[+-](version = |\[\[package\]\])'`

Expected: no output, exit 1 — every crate added here is already in the graph at the same pin, so only
`dilla-core-wasm`'s `dependencies` array may change. A hit means a version moved; stop and reconcile. From
here on every command in task 15 passes `--locked` again.

- [ ] **Step 3: Write the failing tests for the pure surface**

Create `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasm/src/lib.rs`
with only this test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// `protocol/vectors/envelope.json`, case "reaction add in a thread".
    const VECTOR_ENVELOPE_JSON: &str = r#"{
        "v": 1,
        "msgId": "11111111111111111111111111111111",
        "type": 3,
        "threadId": "12121212121212121212121212121212",
        "replyTo": "13131313131313131313131313131313",
        "body": "⛏",
        "attachments": [],
        "previews": [],
        "kf": "1616161616161616161616161616161616161616161616161616161616161616"
    }"#;
    const VECTOR_ENVELOPE_CBOR: &str = "89015011111111111111111111111111111111035012121212121212121212121212121212501313131313131313131313131313131363e29b8f808058201616161616161616161616161616161616161616161616161616161616161616";
    const VECTOR_ENVELOPE_COMMITMENT: &str = "ab2930d97f3c839758c035d9b2ace3b85676e65a37807b66370ffb2885a23148";
    /// `protocol/vectors/identity.json`, `credential_identity.cbor`, verbatim. Asserting the whole
    /// 218-byte encoding is the point: a ten-byte prefix check would pass with a wrong `user_id`, a
    /// wrong `device_id`, swapped `kind`/`tier`/`signer_tier` bytes or truncated signatures, on the one
    /// function that encodes identity material.
    const VECTOR_CREDENTIAL_CBOR: &str = "8a015820a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a150d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d450e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e50001005820f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6584017171717171717171717171717171717171717171717171717171717171717171717171717171717171717171717171717171717171717171717171717171717584028282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828";

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    fn hexed(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn envelope_encode_reproduces_the_vector_bytes() {
        let out = envelope_encode(VECTOR_ENVELOPE_JSON).expect("the vector envelope must encode");
        assert_eq!(hexed(&out), VECTOR_ENVELOPE_CBOR);
    }

    #[test]
    fn envelope_decode_json_round_trips_the_vector() {
        let json = envelope_decode_json(&unhex(VECTOR_ENVELOPE_CBOR)).expect("the vector must decode");
        let again = envelope_encode(&json).expect("the decoded JSON must re-encode");
        assert_eq!(hexed(&again), VECTOR_ENVELOPE_CBOR);
    }

    #[test]
    fn envelope_commitment_reproduces_the_vector() {
        let c = envelope_commitment(&unhex(VECTOR_ENVELOPE_CBOR)).unwrap();
        assert_eq!(hexed(&c), VECTOR_ENVELOPE_COMMITMENT);
    }

    /// `protocol/vectors/sframe.json`, case leaf_index 3 / epoch 41.
    #[test]
    fn sframe_derive_reproduces_the_vector() {
        let keys = sframe_derive(&unhex("0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"), 3, 41).unwrap();
        assert_eq!(hexed(&keys.key()), "3fe54e870b67caffa901a88054d2cb6f");
        assert_eq!(hexed(&keys.salt()), "f92a07e1770098f68ed24805");
    }

    /// `kid` and `ctr` in `sframe.json` are **decimal strings**, not hex (interfaces §2.9), so this
    /// case's `"kid": "809"` is 809 decimal — `Kid::new(leaf_index = 3, epoch = 41)` = `(3 << 8) | 41`.
    /// The expected bytes prove it: `91 03 29` carries the two-byte extended KID `0x0329` = 809.
    /// Writing `0x809` here would ask for leaf 8 / epoch-low 9 and fail.
    #[test]
    fn sframe_header_reproduces_the_vector() {
        assert_eq!(hexed(&sframe_header(809, 1).unwrap()), "910329");
    }

    /// `protocol/vectors/identity.json`.
    #[test]
    fn safety_number_and_sas_reproduce_the_vectors() {
        assert_eq!(
            safety_number(
                &unhex("a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"),
                &unhex("b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2")
            )
            .unwrap(),
            "097797588879462191319159221653839944788022939511249052334637"
        );
        assert_eq!(
            sas(&unhex("c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3")).unwrap(),
            "088546891769712384735671929712"
        );
    }

    #[test]
    fn recovery_key_base32_reproduces_the_vector() {
        assert_eq!(
            recovery_key_base32(&unhex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")).unwrap(),
            "1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5G"
        );
    }

    /// `protocol/vectors/identity.json`, `credential_identity`. The JSON below is
    /// `credential_identity.fields` verbatim and the constant is `credential_identity.cbor` verbatim:
    /// both signatures are **64 bytes = 128 hex characters**, which is what `fixed::<64>` accepts.
    /// A 130-character literal fails with `E_ENVELOPE_SHAPE: expected 64 bytes, got 65`.
    #[test]
    fn credential_identity_cbor_reproduces_the_vector() {
        let json = r#"{
            "umk_pub": "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
            "user_id": "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
            "device_id": "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
            "kind": 0, "tier": 1, "signer_tier": 0,
            "ssk_pub": "f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6",
            "sig_umk_ssk": "17171717171717171717171717171717171717171717171717171717171717171717171717171717171717171717171717171717171717171717171717171717",
            "sig_ssk_dev": "28282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828"
        }"#;
        assert_eq!(hexed(&credential_identity_cbor(json).unwrap()), VECTOR_CREDENTIAL_CBOR);
    }

    #[test]
    fn the_vector_report_is_green_and_serialises_as_json() {
        assert!(vectors_check_ok());
        let json = vectors_check_json();
        assert!(json.contains("\"failed\":0"), "report must be green: {json}");
    }

    #[test]
    fn the_version_getters_match_dilla_core() {
        assert_eq!(core_version(), dilla_core::CORE_VERSION);
        assert_eq!(u64::from(abi_version()), dilla_core::ABI_VERSION);
    }
}
```

Ten tests, all of them on the **success** path. That is deliberate and it is NV-12: every rejection path in
this surface ends in `err(..)`/`protocol(..)` → `JsError::new(..)`, and wasm-bindgen's `externs!` intrinsics
(`__wbindgen_error_new`) compile to panicking stubs off wasm, so a native rejection test would abort inside
the function under test instead of asserting `is_err()`. The four rejection assertions that used to live
here — trailing bytes after an envelope, a short SFrame base key, an empty `credential_identity` object and
a short franking commitment — move to task 16's `tests/node.rs`, where they run under
`wasm32-unknown-unknown` and the intrinsics are real. Step 1 item 4 settles whether even the `.unwrap()`s
above are safe; if `JsError` cannot be constructed or does not implement `Debug` on a native target, take
NV-12's split and point these ten tests at the inner `ProtocolError`-returning functions.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `/home/thim/.cargo/bin/cargo test -p dilla-core-wasm --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: FAIL to compile — `cannot find function 'envelope_encode' in this scope`, and the same for every
other name the module calls (`envelope_decode_json`, `envelope_commitment`, `sframe_derive`,
`sframe_header`, `safety_number`, `sas`, `recovery_key_base32`, `credential_identity_cbor`,
`vectors_check_ok`, `vectors_check_json`, `core_version`, `abi_version`).

- [ ] **Step 5: Write the pure surface in `lib.rs`**

Put this above the `#[cfg(test)] mod tests` block:

```rust
//! `dilla-core-wasm` — the browser binding of `dilla-core` (interfaces §2.11).
//!
//! `u64` arguments cross as JavaScript `BigInt`. Errors are `JsError` carrying a `protocol/*.md`
//! `E_*` code, except `store_open`, which rethrows the original DOMException so that
//! [`store::is_sah_contention`] can classify it (deviation A2-3).

// `store` and `probe` exist only on the browser target. The gate lives here, on the declarations and
// the re-exports, and NOT as an inner `#![cfg(…)]` in the two files: a false inner cfg removes the
// module *item*, so an unconditional `pub mod store;` + `pub use store::{…};` fails the native build
// with `error[E0432]: unresolved import` and takes every native test of this crate with it.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub mod probe;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub mod store;

use dilla_core::envelope::{
    franking_tag as core_franking_tag, Attachment, Envelope, EnvelopeType, FrankingTagInput, Preview,
};
use dilla_core::identity::{
    recovery_key_base32 as core_recovery_key_base32, safety_number as core_safety_number,
    sas as core_sas, CredentialIdentity, Kind, SignerTier, Tier,
};
use dilla_core::ids::{DeviceId, MsgId, UserId};
use dilla_core::sframe::{derive_keys, encode_header, Ctr, Kid, NK, NN};
use dilla_core::ProtocolError;
use serde_json::{json, Map, Value};
use wasm_bindgen::prelude::*;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub use probe::probe_persistence;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub use store::{is_sah_contention, store_open, StoreHandle, StoreOpenConfig};

fn err(code: &str, detail: &str) -> JsError {
    JsError::new(&format!("{code}: {detail}"))
}

fn protocol(e: ProtocolError) -> JsError {
    JsError::new(e.code())
}

fn unhex(s: &str, field: &str) -> Result<Vec<u8>, JsError> {
    if s.len() % 2 != 0 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(err("E_ENVELOPE_SHAPE", &format!("{field}: not hex")));
    }
    Ok((0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn fixed<const N: usize>(bytes: &[u8], field: &str) -> Result<[u8; N], JsError> {
    <[u8; N]>::try_from(bytes)
        .map_err(|_| err("E_ENVELOPE_SHAPE", &format!("{field}: expected {N} bytes, got {}", bytes.len())))
}

fn obj<'a>(v: &'a Value, field: &str) -> Result<&'a Map<String, Value>, JsError> {
    v.as_object().ok_or_else(|| err("E_ENVELOPE_SHAPE", &format!("{field}: not an object")))
}

fn str_field<'a>(m: &'a Map<String, Value>, k: &str) -> Result<&'a str, JsError> {
    m.get(k).and_then(Value::as_str).ok_or_else(|| err("E_ENVELOPE_SHAPE", &format!("{k}: missing string")))
}

fn u64_field(m: &Map<String, Value>, k: &str) -> Result<u64, JsError> {
    m.get(k).and_then(Value::as_u64).ok_or_else(|| err("E_ENVELOPE_SHAPE", &format!("{k}: missing integer")))
}

fn opt_hex16(m: &Map<String, Value>, k: &str) -> Result<Option<[u8; 16]>, JsError> {
    match m.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(fixed::<16>(&unhex(s, k)?, k)?)),
        Some(_) => Err(err("E_ENVELOPE_SHAPE", &format!("{k}: expected a hex string or null"))),
    }
}

fn opt_hex(m: &Map<String, Value>, k: &str) -> Result<Option<Vec<u8>>, JsError> {
    match m.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(unhex(s, k)?)),
        Some(_) => Err(err("E_ENVELOPE_SHAPE", &format!("{k}: expected a hex string or null"))),
    }
}

#[wasm_bindgen]
pub fn core_version() -> String {
    dilla_core::CORE_VERSION.to_owned()
}

#[wasm_bindgen]
pub fn abi_version() -> u32 {
    dilla_core::ABI_VERSION as u32
}

#[wasm_bindgen]
pub fn vectors_check_json() -> String {
    let report = dilla_core::vectors::run_all();
    let suites: Vec<Value> = report
        .suites
        .iter()
        .map(|s| {
            json!({
                "name": s.name,
                "cases": s.cases.iter().map(|c| json!({
                    "case": c.case, "field": c.field, "ok": c.ok,
                    "expected": c.expected, "actual": c.actual,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({ "passed": report.passed, "failed": report.failed, "suites": suites }).to_string()
}

#[wasm_bindgen]
pub fn vectors_check_ok() -> bool {
    dilla_core::vectors::run_all().is_ok()
}

/// Reads the JSON shape `protocol/vectors/envelope.json` uses for its `envelope` object.
fn envelope_from_json(source: &str) -> Result<Envelope, JsError> {
    let v: Value = serde_json::from_str(source).map_err(|e| err("E_ENVELOPE_SHAPE", &e.to_string()))?;
    let m = obj(&v, "envelope")?;
    let empty: Vec<Value> = Vec::new();

    let mut attachments = Vec::new();
    for a in m.get("attachments").and_then(Value::as_array).unwrap_or(&empty) {
        let a = obj(a, "attachment")?;
        attachments.push(Attachment {
            blob_id: fixed::<32>(&unhex(str_field(a, "blobId")?, "blobId")?, "blobId")?,
            key: fixed::<32>(&unhex(str_field(a, "key")?, "key")?, "key")?,
            nonce: fixed::<12>(&unhex(str_field(a, "nonce")?, "nonce")?, "nonce")?,
            size: u64_field(a, "size")?,
            mime: str_field(a, "mime")?.to_owned(),
            w: a.get("w").and_then(Value::as_u64),
            h: a.get("h").and_then(Value::as_u64),
            thumb: opt_hex(a, "thumb")?,
        });
    }

    let mut previews = Vec::new();
    for p in m.get("previews").and_then(Value::as_array).unwrap_or(&empty) {
        let p = obj(p, "preview")?;
        previews.push(Preview {
            url: str_field(p, "url")?.to_owned(),
            title: str_field(p, "title")?.to_owned(),
            description: str_field(p, "description")?.to_owned(),
            image: opt_hex(p, "image")?,
        });
    }

    Ok(Envelope {
        v: u64_field(m, "v")?,
        msg_id: MsgId::from_bytes(fixed::<16>(&unhex(str_field(m, "msgId")?, "msgId")?, "msgId")?),
        kind: EnvelopeType::from_u64(u64_field(m, "type")?).map_err(protocol)?,
        thread_id: opt_hex16(m, "threadId")?.map(MsgId::from_bytes),
        reply_to: opt_hex16(m, "replyTo")?.map(MsgId::from_bytes),
        body: str_field(m, "body")?.to_owned(),
        attachments,
        previews,
        k_f: fixed::<32>(&unhex(str_field(m, "kf")?, "kf")?, "kf")?,
    })
}

fn envelope_to_json(e: &Envelope) -> String {
    json!({
        "v": e.v,
        "msgId": e.msg_id.to_hex(),
        "type": e.kind.as_u8(),
        "threadId": e.thread_id.map(|x| x.to_hex()),
        "replyTo": e.reply_to.map(|x| x.to_hex()),
        "body": e.body,
        "attachments": e.attachments.iter().map(|a| json!({
            "blobId": hex(&a.blob_id), "key": hex(&a.key), "nonce": hex(&a.nonce),
            "size": a.size, "mime": a.mime, "w": a.w, "h": a.h,
            "thumb": a.thumb.as_ref().map(|t| hex(t)),
        })).collect::<Vec<_>>(),
        "previews": e.previews.iter().map(|p| json!({
            "url": p.url, "title": p.title, "description": p.description,
            "image": p.image.as_ref().map(|i| hex(i)),
        })).collect::<Vec<_>>(),
        "kf": hex(&e.k_f),
    })
    .to_string()
}

#[wasm_bindgen]
pub fn envelope_encode(json: &str) -> Result<Box<[u8]>, JsError> {
    Ok(envelope_from_json(json)?.encode().map_err(protocol)?.into_boxed_slice())
}

#[wasm_bindgen]
pub fn envelope_decode_json(cbor: &[u8]) -> Result<String, JsError> {
    Ok(envelope_to_json(&Envelope::decode(cbor).map_err(protocol)?))
}

#[wasm_bindgen]
pub fn envelope_commitment(cbor: &[u8]) -> Result<Box<[u8]>, JsError> {
    let envelope = Envelope::decode(cbor).map_err(protocol)?;
    Ok(Box::new(envelope.commitment().map_err(protocol)?) as Box<[u8]>)
}

#[wasm_bindgen]
pub fn franking_tag(
    k_frank: &[u8],
    group_id: &[u8],
    epoch: u64,
    seq: u64,
    uploader_device: &[u8],
    commitment: &[u8],
    recv_ts: u64,
) -> Result<Box<[u8]>, JsError> {
    let input = FrankingTagInput {
        group_id: fixed::<16>(group_id, "group_id")?,
        epoch,
        seq,
        uploader_device: DeviceId::from_bytes(fixed::<16>(uploader_device, "uploader_device")?),
        commitment: fixed::<32>(commitment, "commitment")?,
        recv_ts,
    };
    Ok(Box::new(core_franking_tag(&fixed::<32>(k_frank, "k_frank")?, &input)) as Box<[u8]>)
}

#[wasm_bindgen]
pub struct SframeKeysJs {
    key: [u8; NK],
    salt: [u8; NN],
}

#[wasm_bindgen]
impl SframeKeysJs {
    #[wasm_bindgen(getter)]
    pub fn key(&self) -> Box<[u8]> {
        Box::new(self.key) as Box<[u8]>
    }
    #[wasm_bindgen(getter)]
    pub fn salt(&self) -> Box<[u8]> {
        Box::new(self.salt) as Box<[u8]>
    }
}

#[wasm_bindgen]
pub fn sframe_derive(base_key: &[u8], leaf_index: u32, epoch: u64) -> Result<SframeKeysJs, JsError> {
    let base = fixed::<NK>(base_key, "base_key")?;
    let leaf =
        u16::try_from(leaf_index).map_err(|_| err("E_UNSUPPORTED_SUITE", "leaf_index must be below 2^16"))?;
    let keys = derive_keys(&base, Kid::new(leaf, epoch));
    Ok(SframeKeysJs { key: keys.key, salt: keys.salt })
}

#[wasm_bindgen]
pub fn sframe_header(kid: u64, ctr: u64) -> Result<Box<[u8]>, JsError> {
    Ok(encode_header(Kid::from_raw(kid), Ctr::from_raw(ctr)).into_boxed_slice())
}

#[wasm_bindgen]
pub fn safety_number(umk_a: &[u8], umk_b: &[u8]) -> Result<String, JsError> {
    Ok(core_safety_number(&fixed::<32>(umk_a, "umk_a")?, &fixed::<32>(umk_b, "umk_b")?))
}

#[wasm_bindgen]
pub fn sas(epoch_authenticator: &[u8]) -> Result<String, JsError> {
    Ok(core_sas(&fixed::<32>(epoch_authenticator, "epoch_authenticator")?))
}

#[wasm_bindgen]
pub fn recovery_key_base32(rk: &[u8]) -> Result<String, JsError> {
    Ok(core_recovery_key_base32(&fixed::<32>(rk, "rk")?))
}

/// Reads the `credential_identity.fields` shape of `protocol/vectors/identity.json`.
#[wasm_bindgen]
pub fn credential_identity_cbor(json: &str) -> Result<Box<[u8]>, JsError> {
    let v: Value = serde_json::from_str(json).map_err(|e| err("E_CREDENTIAL", &e.to_string()))?;
    let m = obj(&v, "credential_identity")?;
    let identity = CredentialIdentity {
        v: m.get("v").and_then(Value::as_u64).unwrap_or(1),
        umk_pub: fixed::<32>(&unhex(str_field(m, "umk_pub")?, "umk_pub")?, "umk_pub")?,
        user_id: UserId::from_bytes(fixed::<16>(&unhex(str_field(m, "user_id")?, "user_id")?, "user_id")?),
        device_id: DeviceId::from_bytes(fixed::<16>(
            &unhex(str_field(m, "device_id")?, "device_id")?,
            "device_id",
        )?),
        kind: Kind::from_u64(u64_field(m, "kind")?).map_err(protocol)?,
        tier: Tier::from_u64(u64_field(m, "tier")?).map_err(protocol)?,
        signer_tier: SignerTier::from_u64(u64_field(m, "signer_tier")?).map_err(protocol)?,
        ssk_pub: fixed::<32>(&unhex(str_field(m, "ssk_pub")?, "ssk_pub")?, "ssk_pub")?,
        sig_umk_ssk: fixed::<64>(&unhex(str_field(m, "sig_umk_ssk")?, "sig_umk_ssk")?, "sig_umk_ssk")?,
        sig_ssk_dev: fixed::<64>(&unhex(str_field(m, "sig_ssk_dev")?, "sig_ssk_dev")?, "sig_ssk_dev")?,
    };
    Ok(identity.encode().into_boxed_slice())
}
```

- [ ] **Step 6: Write `store.rs`**

Create `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasm/src/store.rs`:

```rust
//! The browser store: OPFS sahpool + SQLite3 Multiple Ciphers `chacha20` (gap-13, gap-11, R6).
//!
//! wasm-only: `install()` returns `NotSupported` outside a dedicated worker in a secure context,
//! and `rusqlite` on this target is the `sqlite-wasm-rs` FFI backend. The target gate is on
//! `lib.rs`'s `pub mod store;` declaration, not an inner `#![cfg(…)]` here — one gate, one place, and
//! the re-exports in `lib.rs` carry the identical cfg.

use core::cell::RefCell;

use js_sys::Reflect;
use rusqlite::{Connection, OpenFlags};
use sqlite_wasm_rs::WasmOsCallback;
use sqlite_wasm_vfs::sahpool::{install, OpfsSAHError, OpfsSAHPoolCfgBuilder, OpfsSAHPoolUtil};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

/// The pool registers under the plain name; sqlite3mc creates the encrypting wrapper lazily
/// (gap-13 §3). Opening `opfs-sahpool` directly fails at `PRAGMA key` with the exact message
/// "Setting key failed. Encryption is not supported by the VFS."
const POOL_VFS: &str = "opfs-sahpool";
const ENCRYPTED_VFS: &str = "multipleciphers-opfs-sahpool";
/// Slots include journals; 12 leaves room for one database plus its `-journal` and `-wal`.
const INITIAL_CAPACITY: u32 = 12;

#[wasm_bindgen]
#[derive(Clone)]
pub struct StoreOpenConfig {
    directory: String,
    db_name: String,
    kek_hex: String,
}

#[wasm_bindgen]
impl StoreOpenConfig {
    #[wasm_bindgen(constructor)]
    pub fn new(directory: String, db_name: String, kek_hex: String) -> StoreOpenConfig {
        StoreOpenConfig { directory, db_name, kek_hex }
    }
    #[wasm_bindgen(getter)]
    pub fn directory(&self) -> String {
        self.directory.clone()
    }
    #[wasm_bindgen(setter)]
    pub fn set_directory(&mut self, v: String) {
        self.directory = v;
    }
    #[wasm_bindgen(getter)]
    pub fn db_name(&self) -> String {
        self.db_name.clone()
    }
    #[wasm_bindgen(setter)]
    pub fn set_db_name(&mut self, v: String) {
        self.db_name = v;
    }
    #[wasm_bindgen(getter)]
    pub fn kek_hex(&self) -> String {
        self.kek_hex.clone()
    }
    #[wasm_bindgen(setter)]
    pub fn set_kek_hex(&mut self, v: String) {
        self.kek_hex = v;
    }
}

/// NV-7: the variant carrying the `createSyncAccessHandle` DOMException on 0.2.0.
fn error_value(e: &OpfsSAHError) -> JsValue {
    match e {
        OpfsSAHError::CreateSyncAccessHandle(v) => v.clone(),
        other => JsValue::from(js_sys::Error::new(&format!("E_STORE_INSTALL: {other}"))),
    }
}

/// True when the error is OPFS sync-access-handle contention. This is SQLite upstream's own
/// predicate, including the documented Chromium `name` inconsistency (gap-14 §4). Never match on
/// the Display string: 0.2.0's omits the DOMException name entirely.
#[wasm_bindgen]
pub fn is_sah_contention(err: &JsValue) -> bool {
    let prop = |k: &str| Reflect::get(err, &JsValue::from_str(k)).ok().and_then(|v| v.as_string());
    match (prop("name").as_deref(), prop("message").as_deref()) {
        (Some("NoModificationAllowedError"), _) => true,
        (Some("DOMException"), Some(m)) => m.starts_with("Access Handles cannot"),
        _ => false,
    }
}

#[wasm_bindgen]
pub struct StoreHandle {
    util: OpfsSAHPoolUtil,
    conn: RefCell<Option<Connection>>,
    db_name: String,
    /// Deviation A2-14. The raw 256-bit device KEK, kept only because `resume()` has to replay
    /// `PRAGMA key` after `unpause_vfs()`. `Zeroizing` wipes it when the handle drops; without it the
    /// key would sit in freed wasm linear memory for the life of the page.
    kek_hex: Zeroizing<String>,
}

fn open_encrypted(db_name: &str, kek_hex: &str) -> Result<Connection, JsValue> {
    let conn = Connection::open_with_flags_and_vfs(db_name, OpenFlags::default(), ENCRYPTED_VFS)
        .map_err(|e| JsValue::from(js_sys::Error::new(&format!("E_STORE_OPEN: {e}"))))?;
    // Order is load-bearing: cipher, then key, then a real read. `PRAGMA key` always reports ok
    // (gap-13 §2.2), so the SELECT is the key check. The statement text carries the key, so it is
    // built into a Zeroizing<String> and wiped as soon as SQLite has parsed it (deviation A2-14).
    let pragmas =
        Zeroizing::new(format!("PRAGMA cipher = 'chacha20'; PRAGMA key = 'raw:{kek_hex}';"));
    conn.execute_batch(&pragmas)
        .map_err(|e| JsValue::from(js_sys::Error::new(&format!("E_STORE_CIPHER: {e}"))))?;
    drop(pragmas);
    conn.query_row("SELECT count(*) FROM sqlite_schema", [], |r| r.get::<_, i64>(0))
        .map_err(|e| JsValue::from(js_sys::Error::new(&format!("E_STORE_KEY: {e}"))))?;
    Ok(conn)
}

/// Deviation A2-3: the error type is `JsValue`, not `JsError`, so the original DOMException reaches
/// [`is_sah_contention`] unchanged. One attempt only — gap-14 §5's 6-attempt schedule lives in the
/// worker, which is where the attempt count is observable.
#[wasm_bindgen]
pub async fn store_open(cfg: StoreOpenConfig) -> Result<StoreHandle, JsValue> {
    if cfg.kek_hex.len() != 64 || !cfg.kek_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(JsValue::from(js_sys::Error::new("E_STORE_KEK: kek_hex must be 64 hex characters")));
    }
    let pool_cfg = OpfsSAHPoolCfgBuilder::new()
        .vfs_name(POOL_VFS)
        .directory(&cfg.directory)
        .clear_on_init(false)
        .initial_capacity(INITIAL_CAPACITY)
        .build();
    // default_vfs = false: making the pool the default would displace the sqlite3mc-wrapped default
    // and PRAGMA key would fail (gap-13 §3). The bound on 0.2.0 is `C: OsCallback` alone.
    let util = install::<WasmOsCallback>(&pool_cfg, false).await.map_err(|e| error_value(&e))?;
    let conn = open_encrypted(&cfg.db_name, &cfg.kek_hex)?;
    Ok(StoreHandle {
        util,
        conn: RefCell::new(Some(conn)),
        db_name: cfg.db_name,
        kek_hex: Zeroizing::new(cfg.kek_hex),
    })
}

#[wasm_bindgen]
impl StoreHandle {
    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, JsError> {
        let guard = self.conn.borrow();
        let conn = guard.as_ref().ok_or_else(|| JsError::new("E_STORE_PAUSED: the store is paused"))?;
        f(conn).map_err(|e| JsError::new(&format!("E_STORE_SQL: {e}")))
    }

    pub fn exec(&self, sql: &str) -> Result<(), JsError> {
        self.with_conn(|c| c.execute_batch(sql))
    }

    pub fn query_scalar_i64(&self, sql: &str) -> Result<i64, JsError> {
        self.with_conn(|c| c.query_row(sql, [], |r| r.get::<_, i64>(0)))
    }

    /// `get_capacity` — the 0.2.0 spelling (gap-11 §0), not `capacity()`.
    pub fn capacity(&self) -> u32 {
        self.util.get_capacity()
    }

    /// `reserve_minimum_capacity` — the 0.2.0 spelling, not `ensure_capacity`.
    ///
    /// NV-13: `&self` on an exported `async fn` is what step 1 item 5 confirms. If wasm-bindgen
    /// 0.2.128 rejects a borrowed receiver (the generated future must be `'static`), move this and
    /// `resume` behind free functions taking the handle and record the deviation from §2.11.
    /// `reserve_capacity` is called for real by task 17's worker right after open; `resume()` is not
    /// exercised by the week-1 spike, which only ever pauses on the resign path.
    pub async fn reserve_capacity(&self, n: u32) -> Result<(), JsError> {
        self.util
            .reserve_minimum_capacity(n)
            .await
            .map_err(|e| JsError::new(&format!("E_STORE_CAPACITY: {e}")))
    }

    /// Deviation A2-4: drops the connection first — `pause_vfs()` errors while any file handle is
    /// open, and 0.2.0 has no typed `Busy` to tell that apart from a real failure (gap-11 §9 item 5).
    pub fn pause(&self) -> Result<(), JsError> {
        drop(self.conn.borrow_mut().take());
        self.util.pause_vfs().map_err(|e| JsError::new(&format!("E_STORE_PAUSE: {e}")))
    }

    /// Deviation A2-4: reacquires the slots, then reopens the connection and replays the pragmas.
    pub async fn resume(&self) -> Result<(), JsError> {
        self.util.unpause_vfs().await.map_err(|e| JsError::new(&format!("E_STORE_RESUME: {e}")))?;
        // The JsValue is deliberately not formatted into the message: it can carry SQLite text
        // built from the pragma statement, and that statement contains the KEK.
        let conn = open_encrypted(&self.db_name, &self.kek_hex)
            .map_err(|_| JsError::new("E_STORE_RESUME: reopening the keyed connection failed"))?;
        *self.conn.borrow_mut() = Some(conn);
        Ok(())
    }

    pub fn close(self) {
        drop(self.conn.borrow_mut().take());
    }
}
```

- [ ] **Step 7: Write `probe.rs`**

Create `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasm/src/probe.rs`:

```rust
//! The functional persistence probe of gap-15 §6. Presence checks are insufficient: Firefox and
//! Safari private browsing expose the whole API surface and only fail the call. Run this BEFORE
//! `store_open`, so a `memory` boot never leaves a half-created pool behind (gap-15 AC-5).
//!
//! The target gate is on `lib.rs`'s `pub mod probe;` declaration, not an inner `#![cfg(…)]` here.

use js_sys::Reflect;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    DedicatedWorkerGlobalScope, FileSystemDirectoryHandle, FileSystemFileHandle,
    FileSystemGetFileOptions, FileSystemSyncAccessHandle,
};

/// Deliberately outside the sahpool's own directory (default `.opfs-sahpool`) so a crashed probe
/// can never be mistaken for a pool slot.
const PROBE_NAME: &str = ".dilla-probe";

fn report(mode: &str, reason: Option<&str>) -> String {
    match reason {
        Some(r) => format!("{{\"mode\":\"{mode}\",\"reason\":\"{r}\"}}"),
        None => format!("{{\"mode\":\"{mode}\"}}"),
    }
}

fn dom_name(err: &JsValue) -> String {
    Reflect::get(err, &JsValue::from_str("name"))
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_else(|| "UnknownError".to_owned())
}

/// Returns JSON `{"mode":"opfs"|"memory","reason":"…"}`. Never rejects: every failure mode here is
/// a supported product state, and a rejection would be indistinguishable from a bug.
#[wasm_bindgen]
pub async fn probe_persistence() -> Result<String, JsError> {
    let global = js_sys::global();

    let secure = Reflect::get(&global, &JsValue::from_str("isSecureContext"))
        .ok()
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !secure {
        return Ok(report("memory", Some("insecure-context")));
    }

    let scope: DedicatedWorkerGlobalScope = match global.dyn_into::<DedicatedWorkerGlobalScope>() {
        Ok(s) => s,
        Err(_) => return Ok(report("memory", Some("not-a-dedicated-worker"))),
    };

    let root: FileSystemDirectoryHandle =
        match JsFuture::from(scope.navigator().storage().get_directory()).await {
            Ok(v) => v.unchecked_into(),
            // Firefox private browsing -> SecurityError; Safari private browsing -> UnknownError.
            Err(e) => return Ok(report("memory", Some(&format!("getDirectory:{}", dom_name(&e))))),
        };

    let opts = FileSystemGetFileOptions::new();
    opts.set_create(true);
    let file: FileSystemFileHandle =
        match JsFuture::from(root.get_file_handle_with_options(PROBE_NAME, &opts)).await {
            Ok(v) => v.unchecked_into(),
            Err(e) => return Ok(report("memory", Some(&format!("getFileHandle:{}", dom_name(&e))))),
        };

    match JsFuture::from(file.create_sync_access_handle()).await {
        Ok(v) => {
            let handle: FileSystemSyncAccessHandle = v.unchecked_into();
            handle.close();
            let _ = JsFuture::from(root.remove_entry(PROBE_NAME)).await;
            Ok(report("opfs", None))
        }
        Err(e) => {
            let _ = JsFuture::from(root.remove_entry(PROBE_NAME)).await;
            Ok(report("memory", Some(&format!("createSyncAccessHandle:{}", dom_name(&e)))))
        }
    }
}
```

- [ ] **Step 8: Run the native tests to verify they pass**

Run: `/home/thim/.cargo/bin/cargo test -p dilla-core-wasm --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: PASS — 10 passed. `store.rs` and `probe.rs` are not compiled at all here, because `lib.rs`'s
`pub mod` declarations and their two `pub use` lines all carry
`#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]`. If this run fails with
`error[E0432]: unresolved import 'store'`, one of those four cfgs is missing.

- [ ] **Step 9: Build for `wasm32-unknown-unknown`, which is where the store and probe are compiled**

Run: `/home/thim/.cargo/bin/cargo build -p dilla-core-wasm --target wasm32-unknown-unknown --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: PASS. A `links = 'wsqlite3'` collision here means something in the graph pulled
`sqlite-wasm-rs 0.6.x`; pin it back to 0.5.5 rather than relaxing rusqlite (gap-11 §9 item 1).

- [ ] **Step 10: Run `wasm-pack` and type-check the generated declarations**

Run: `/home/thim/.cargo/bin/wasm-bindgen --version`

Expected: `wasm-bindgen 0.2.128` — the exact version of the `wasm-bindgen` crate in `Cargo.lock`.
`--mode no-install` means "don't install tools like `wasm-bindgen`, just use the global environment's
existing versions" (facts-ci §1.6), and wasm-pack resolves the CLI with `which("wasm-bindgen")`, not with the
absolute path this plan otherwise uses everywhere. R4 installs rustup with `--no-modify-path`, so
`~/.cargo/bin` is not necessarily on this shell's PATH and the `which` would fail with "wasm-bindgen not
found". The next command therefore uses the documented PATH prepend R4 allows, written out in full: the
login shell here is fish, where `$PATH` is a list and `PATH=/home/thim/.cargo/bin:$PATH` would expand to
several arguments instead of one, so the whole search path is spelled literally.

Run: `env PATH=/home/thim/.cargo/bin:/usr/local/bin:/usr/bin:/bin /home/thim/.cargo/bin/wasm-pack build /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasm --target web --release --mode no-install --out-dir spike/pkg`

Expected: PASS. `--out-dir` resolves against the **crate** directory, not the shell's cwd (gap-24 §4.3), so
the output lands in `core/dilla-core-wasm/spike/pkg`.

Run: `ls -1 /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasm/spike/pkg`

Expected: `dilla_core_wasm.d.ts`, `dilla_core_wasm.js`, `dilla_core_wasm_bg.wasm`,
`dilla_core_wasm_bg.wasm.d.ts`, `package.json`, `.gitignore`.

Run: `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/node_modules/.bin/tsc --noEmit --strict --target es2022 --module es2022 --moduleResolution bundler /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasm/spike/pkg/dilla_core_wasm.d.ts`

Expected: PASS (no output). A `BigInt literals are not available` diagnostic means `--target` is below
es2020; raise the flag, never edit the generated declaration file.

- [ ] **Step 11: Lint and format**

Run: `/home/thim/.cargo/bin/cargo fmt --all --check --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: PASS (no output).

Run: `/home/thim/.cargo/bin/cargo clippy -p dilla-core-wasm --target wasm32-unknown-unknown --all-targets --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -- -D warnings`

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add core/dilla-core-wasm/Cargo.toml core/dilla-core-wasm/src/lib.rs core/dilla-core-wasm/src/store.rs core/dilla-core-wasm/src/probe.rs .gitignore Cargo.lock && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(core-wasm): wasm-bindgen surface for the browser tier'
```

---

### Task 16: wasm unit tests under Node

**Files:**
- Create: `core/dilla-core-wasm/tests/node.rs`
- Modify: `.github/workflows/ci.yml` (adds the `rust-wasm-node` job only; task 19 adds the other five)

**Interfaces:**
- Consumes: `dilla_core::vectors::run_all`; `dilla_core::cbor::{Encoder, Decoder, CborError, decode_strict}`; the `dilla-core-wasm` surface of task 15.
- Produces: the `rust-wasm-node` CI job and the second leg of the cross-target conformance triangle (native → **Node / wasm32-unknown-unknown** → wasip1 under wazero, Plan B task 4).

- [ ] **Step 1: Resolve NV-8**

Open `https://docs.rs/wasm-bindgen-test/0.3.78/wasm_bindgen_test/macro.wasm_bindgen_test_configure.html` and
record whether `run_in_node_experimental` is an accepted argument. Node is already the runner's default
(facts-ci §6: "tests default to Node"), so if the identifier does not exist, **delete the
`wasm_bindgen_test_configure!` line from step 3's file** and say so in the commit message. Do not substitute
`run_in_browser` or `run_in_dedicated_worker`: this box has no chromedriver (R6, facts-local-toolchain).

- [ ] **Step 2: Confirm `dilla-core`'s own tests compile for wasm (NV-9)**

Run: `/home/thim/.cargo/bin/cargo test --no-run -p dilla-core --target wasm32-unknown-unknown --locked --features vectors --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: PASS. If `core/dilla-core/tests/{mls_roundtrip,cbor_reject,vectors_native}.rs` fail to compile
because they open a native SQLite file, add `#![cfg(not(target_arch = "wasm32"))]` as the first line of the
offending file (Plan A tasks 2, 9, 10, 11 own them) and re-run before continuing.

- [ ] **Step 3: Write the failing test file**

Create `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasm/tests/node.rs`:

```rust
//! Conformance under `wasm32-unknown-unknown`, executed by Node through
//! `wasm-bindgen-test-runner` (the `.cargo/config.toml` runner, R6). No browser and no
//! chromedriver is involved; OPFS is task 17's Playwright spike.

#![cfg(target_arch = "wasm32")]

use dilla_core::cbor::{decode_strict, CborError, Decoder, Encoder};
use dilla_core_wasm::{
    abi_version, core_version, credential_identity_cbor, envelope_commitment, envelope_decode_json,
    envelope_encode, franking_tag, recovery_key_base32, safety_number, sas, sframe_derive,
    sframe_header, vectors_check_json, vectors_check_ok,
};
use wasm_bindgen_test::*;

// NV-8: delete this line if step 1 shows the identifier does not exist on 0.3.78; Node is the
// runner's default either way.
wasm_bindgen_test_configure!(run_in_node_experimental);

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

const VECTOR_ENVELOPE_CBOR: &str = "89015011111111111111111111111111111111035012121212121212121212121212121212501313131313131313131313131313131363e29b8f808058201616161616161616161616161616161616161616161616161616161616161616";
const VECTOR_ENVELOPE_COMMITMENT: &str = "ab2930d97f3c839758c035d9b2ace3b85676e65a37807b66370ffb2885a23148";

/// The committed golden of suite names, in order, from `dilla_core::vectors`' five runners
/// (Plan A task 11 writes `SuiteReport { name: "envelope" | "franking" | "sframe" | "identity" |
/// "rejects", .. }`). Without it, comparing the wasm report against a report produced by the same
/// wasm build proves only internal consistency: a build that silently lost an entire suite would
/// pass. Plan B task 4 holds the equivalent golden for the wasip1 leg.
const EXPECTED_SUITES: [&str; 5] = ["envelope", "franking", "sframe", "identity", "rejects"];

#[wasm_bindgen_test]
fn the_vector_report_is_green_on_wasm() {
    let report = dilla_core::vectors::run_all();
    assert_eq!(report.failed, 0, "wasm32 report:\n{}", report.to_text());
    assert!(report.passed > 0, "a zero-case report would pass vacuously");
    assert!(vectors_check_ok());
}

/// The point of the cross-target triangle is not "wasm is green" but "every field of every case
/// holds under wasm too", so this asserts per case, naming the one that broke.
#[wasm_bindgen_test]
fn every_case_of_every_suite_holds_on_wasm() {
    let report = dilla_core::vectors::run_all();
    let json = vectors_check_json();

    let names: Vec<&str> = report.suites.iter().map(|s| s.name).collect();
    assert_eq!(names, EXPECTED_SUITES, "the wasm build must run all five suites, in order");

    // Every CaseReport is one (case, field) check, so the two counters and the case rows must agree.
    // A suite dropped between `run_all()` and the counters would break this even if the names held.
    let cases: usize = report.suites.iter().map(|s| s.cases.len()).sum();
    assert_eq!(
        cases as u32,
        report.passed + report.failed,
        "passed + failed must account for every case row"
    );

    for suite in &report.suites {
        assert!(json.contains(&format!("\"name\":\"{}\"", suite.name)), "missing suite {}", suite.name);
        assert!(!suite.cases.is_empty(), "suite {} has no cases", suite.name);
        for case in &suite.cases {
            assert!(
                case.ok,
                "{}/{}/{}: expected {} got {}",
                suite.name, case.case, case.field, case.expected, case.actual
            );
        }
    }
    assert!(json.contains("\"failed\":0"));
}

#[wasm_bindgen_test]
fn the_cbor_reject_corpus_behaves_identically_on_wasm() {
    // interfaces §2.3's reject corpus, one entry per rejection class.
    let cases: [(&str, &str); 12] = [
        ("1817", "non-minimal uint"),
        ("190017", "non-minimal uint"),
        ("5800", "non-minimal length"),
        ("9f01ff", "indefinite array"),
        ("5f41014102ff", "indefinite bstr"),
        ("a0", "map"),
        ("c11a514b67b0", "tag"),
        ("fb3ff0000000000000", "double"),
        ("f93c00", "half"),
        ("20", "negative"),
        ("f7", "undefined"),
        ("1c", "reserved additional info"),
    ];
    for (hexed, what) in cases {
        let bytes = unhex(hexed);
        let out: Result<(), CborError> = decode_strict(&bytes, |d: &mut Decoder<'_>| {
            d.skip()?;
            Ok(())
        });
        assert!(out.is_err(), "{what} ({hexed}) must be rejected on wasm too");
    }
    let trailing = unhex("0101");
    assert!(matches!(
        decode_strict(&trailing, |d: &mut Decoder<'_>| d.uint().map(|_| ())),
        Err(CborError::TrailingBytes)
    ));
}

#[wasm_bindgen_test]
fn the_cbor_accept_corpus_round_trips_byte_identically_on_wasm() {
    let mut e = Encoder::new();
    e.array(3).uint(1).uint(2).uint(3);
    assert_eq!(hex(&e.into_vec()), "83010203");
    let mut e = Encoder::new();
    e.uint(1_000_000);
    assert_eq!(hex(&e.into_vec()), "1a000f4240");
    let mut e = Encoder::new();
    e.text("IETF");
    assert_eq!(hex(&e.into_vec()), "6449455446");
    let mut e = Encoder::new();
    e.null();
    assert_eq!(hex(&e.into_vec()), "f6");
    let mut e = Encoder::new();
    e.bytes(&[1, 2, 3, 4]);
    assert_eq!(hex(&e.into_vec()), "4401020304");
}

#[wasm_bindgen_test]
fn the_wasm_bindgen_surface_reproduces_the_envelope_vector() {
    let json = envelope_decode_json(&unhex(VECTOR_ENVELOPE_CBOR)).unwrap();
    assert_eq!(hex(&envelope_encode(&json).unwrap()), VECTOR_ENVELOPE_CBOR);
    assert_eq!(
        hex(&envelope_commitment(&unhex(VECTOR_ENVELOPE_CBOR)).unwrap()),
        VECTOR_ENVELOPE_COMMITMENT
    );
}

#[wasm_bindgen_test]
fn the_wasm_bindgen_surface_reproduces_the_sframe_and_identity_vectors() {
    let keys = sframe_derive(&unhex("0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"), 3, 41).unwrap();
    assert_eq!(hex(&keys.key()), "3fe54e870b67caffa901a88054d2cb6f");
    assert_eq!(hex(&keys.salt()), "f92a07e1770098f68ed24805");
    // `kid` in `sframe.json` is the decimal string "809" (interfaces §2.9), not hex: it is
    // `Kid::new(leaf_index = 3, epoch = 41)` = `(3 << 8) | 41`. `0x809` would be leaf 8 / epoch-low 9.
    assert_eq!(hex(&sframe_header(809, 1).unwrap()), "910329");
    assert_eq!(
        safety_number(
            &unhex("a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"),
            &unhex("b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2")
        )
        .unwrap(),
        "097797588879462191319159221653839944788022939511249052334637"
    );
    assert_eq!(
        sas(&unhex("c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3")).unwrap(),
        "088546891769712384735671929712"
    );
    assert_eq!(
        recovery_key_base32(&unhex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")).unwrap(),
        "1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5G"
    );
}

/// Every rejection path of the wasm-bindgen surface lives here rather than in task 15's native test
/// module: constructing a `JsError` off wasm goes through `__wbindgen_error_new`, whose non-wasm stub
/// panics, so these assertions can only be made where the intrinsics are real (NV-12).
#[wasm_bindgen_test]
fn errors_cross_the_boundary_as_values_not_panics() {
    assert!(envelope_decode_json(&unhex("a0")).is_err(), "a CBOR map is not an envelope");
    let mut trailing = unhex(VECTOR_ENVELOPE_CBOR);
    trailing.push(0x01);
    assert!(envelope_decode_json(&trailing).is_err(), "trailing bytes must not decode");
    assert!(sframe_derive(&[0u8; 15], 0, 0).is_err(), "a 15-byte base key is not NK");
    assert!(credential_identity_cbor("{}").is_err());
    assert!(
        franking_tag(&[0u8; 32], &[0u8; 16], 1, 1, &[0u8; 16], &[0u8; 31], 0).is_err(),
        "a 31-byte commitment is not a 32-byte one"
    );
}

#[wasm_bindgen_test]
fn the_version_getters_agree_with_dilla_core_on_wasm() {
    assert_eq!(core_version(), dilla_core::CORE_VERSION);
    assert_eq!(u64::from(abi_version()), dilla_core::ABI_VERSION);
}
```

- [ ] **Step 4: Run the wasm tests to verify they fail**

Run: `/home/thim/.cargo/bin/cargo test -p dilla-core-wasm --target wasm32-unknown-unknown --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: FAIL. Two failure modes are both acceptable here, and both must be cleared before step 6:
`error: failed to find 'wasm-bindgen'` (the CLI is not installed), or a schema-version mismatch between the
CLI and the `wasm-bindgen` crate in `Cargo.lock`. Fix with:

Run: `/home/thim/.cargo/bin/cargo install wasm-bindgen-cli --vers 0.2.128 --locked`

Then re-run the test command.

**Be explicit about what the red state is here.** Task 15 already implemented every function this file
calls, so there is no behavioural failure to produce: this is a characterization task that adds the
cross-target leg of the conformance triangle, and the only genuine red state is the absent toolchain
(`error: failed to find 'wasm-bindgen'` or a schema-version mismatch) plus NV-8's identifier if it does not
exist on 0.3.78. Once the CLI is installed and NV-8 is settled, expect PASS.

Prove the new tests are load-bearing rather than decorative, the same way task 19 step 8 proves its gates:
change the last character of `VECTOR_ENVELOPE_COMMITMENT` in this file from `8` to `9`, re-run the test
command, and confirm it FAILS naming
`the_wasm_bindgen_surface_reproduces_the_envelope_vector`. Restore the character and re-run; expected PASS.
Do the same with one entry of `EXPECTED_SUITES` (`"rejects"` → `"reject"`) and confirm
`every_case_of_every_suite_holds_on_wasm` fails naming the suite list, then restore it.

- [ ] **Step 5: Confirm the dev-dependency, the runner and the absence of RUSTFLAGS**

`core/dilla-core-wasm/Cargo.toml` must carry (task 1 wrote it from interfaces §3.2):

```toml
[dev-dependencies]
wasm-bindgen-test = "0.3.78"
```

`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/.cargo/config.toml` must carry (task 1
wrote it from interfaces §4.3):

```toml
[target.wasm32-unknown-unknown]
runner = "wasm-bindgen-test-runner"
```

Run: `grep -n rustflags /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/.cargo/config.toml`

Expected: no output, exit 1. `--cfg getrandom_backend="wasm_js"` must not be there: getrandom ≥ 0.3.4 picks
the Web Crypto backend from the `wasm_js` **feature** alone, and in 0.4.x that cfg value is not even in the
check-cfg vocabulary (D7, R5, gap-29). A workflow-level `RUSTFLAGS` env var would also override this file
outright rather than merge with it, which is why step 7's job sets none.

- [ ] **Step 6: Run the wasm tests to verify they pass**

Run: `/home/thim/.cargo/bin/cargo test -p dilla-core-wasm --target wasm32-unknown-unknown --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: PASS — 8 passed. The runner's output names `node`, not a WebDriver session.

Run: `/home/thim/.cargo/bin/cargo test -p dilla-core --target wasm32-unknown-unknown --locked --features vectors --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: PASS. This is the exact command interfaces §5 puts in CI, so it must work locally first.

- [ ] **Step 7: Add the `rust-wasm-node` job**

Append to the `jobs:` mapping of
`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/.github/workflows/ci.yml`, leaving the
existing `node` and `ui` jobs untouched:

```yaml
  rust-wasm-node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: dtolnay/rust-toolchain@1.98.1
        with:
          targets: wasm32-unknown-unknown
      - uses: Swatinem/rust-cache@v2
        with:
          shared-key: rust-wasm32-unknown-unknown
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: npm
      - uses: taiki-e/install-action@v2
        with:
          tool: wasm-bindgen@0.2.128,wasm-pack@0.15.0
      - name: wasm-bindgen-cli must equal the Cargo.lock crate version
        run: |
          want=$(cargo metadata --format-version 1 --locked | jq -r '.packages[] | select(.name=="wasm-bindgen") | .version')
          have=$(wasm-bindgen --version | awk '{print $2}')
          test "$want" = "$have" || { echo "wasm-bindgen-cli $have != crate $want"; exit 1; }
      - run: cargo test -p dilla-core --target wasm32-unknown-unknown --locked --features vectors
      - run: cargo test -p dilla-core-wasm --target wasm32-unknown-unknown --locked
```

- [ ] **Step 8: Read the job back and assert it is fail-closed**

Run: `grep -nE 'continue-on-error|if: *always\(\)|\|\| *true' /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/.github/workflows/ci.yml`

Expected: no output, exit 1 (R22). A hit means an escape hatch was written in; remove it. The pattern is
ERE, not BRE: in BRE `\|` is alternation, so `'…\|| true'` would have searched for a single-pipe `| true`
and fired on legitimate YAML. Task 19 replaces this ad-hoc grep with `scripts/check-ci-workflow.mjs`'s
`FORBIDDEN` table; once that exists, run `node /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/scripts/check-ci-workflow.mjs`
instead.

Run: `grep -n 'rust-wasm-node:' /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/.github/workflows/ci.yml`

Expected: exactly one line, the job key.

- [ ] **Step 9: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add core/dilla-core-wasm/tests/node.rs .github/workflows/ci.yml && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'test(core): run the conformance vectors on wasm32-unknown-unknown under Node'
```

---

### Task 17: Browser spike — dedicated worker, OPFS sahpool, sqlite3mc, Web Locks leader

**Files:**
- Create: `core/dilla-core-wasm/spike/package.json`, `core/dilla-core-wasm/spike/vite.config.ts`, `core/dilla-core-wasm/spike/tsconfig.json`, `core/dilla-core-wasm/spike/tsconfig.worker.json`, `core/dilla-core-wasm/spike/index.html`
- Create: `core/dilla-core-wasm/spike/src/main.ts`, `core/dilla-core-wasm/spike/src/worker.ts`, `core/dilla-core-wasm/spike/src/leader.ts`, `core/dilla-core-wasm/spike/src/probe.ts`
- Create: `e2e/package.json`, `e2e/playwright.config.ts`, `e2e/tests/opfs-leader.spec.ts` (deviation A2-5)
- Modify: `core/dilla-core-wasm/src/store.rs` (deviation A2-10 adds `unencrypted_vfs_probe` and `wrong_key_probe`)
- Modify: `package.json` (workspaces gain the two new members)
- Test: `e2e/tests/opfs-leader.spec.ts`, run by Playwright against the Vite dev server.

**Interfaces:**
- Consumes: `store_open`, `StoreOpenConfig`, `StoreHandle`, `probe_persistence`, `is_sah_contention` from task 15, and `core/dilla-core-wasm/spike/pkg/` built by task 15 step 10.
- Produces: the spike app and the **leader contract** — an exclusive Web Lock named `dilla-core:<instance>` taken with `navigator.locks.request`, and a `BroadcastChannel` of the same name carrying messages `{type:"leader-elected"|"leader-resigned"|"call"|"event", …}`. Also `unencrypted_vfs_probe(db_name, kek_hex) -> string` and `wrong_key_probe(db_name, kek_hex) -> Promise<string>` (deviation A2-10) and the `@dilla/e2e` workspace with its `test:e2e` script.

- [ ] **Step 1: Write the failing Playwright spec**

Create `e2e/package.json`:

```json
{
  "name": "@dilla/e2e",
  "private": true,
  "version": "0.0.0",
  "license": "AGPL-3.0-or-later",
  "type": "module",
  "scripts": {
    "test:e2e": "playwright test --config playwright.config.ts"
  },
  "devDependencies": {
    "@playwright/test": "^1.50"
  }
}
```

There is deliberately **no** `test` script: the root `npm test` runs `npm test --workspaces --if-present`,
and the browser suite must not run in the `node` CI job, which installs no browsers and builds no wasm.

Create `e2e/playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

export default defineConfig({
  testDir: resolve(here, 'tests'),
  // The leadership test measures a real retry budget; parallelism and retries would corrupt it.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    // 127.0.0.1 is a potentially-trustworthy origin, so isSecureContext is true and OPFS is allowed.
    baseURL: 'http://127.0.0.1:5178',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } },
  ],
  webServer: {
    command: 'npm run dev -w @dilla/core-wasm-spike -- --port 5178 --strictPort --host 127.0.0.1',
    cwd: repoRoot,
    url: 'http://127.0.0.1:5178',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

Create `e2e/tests/opfs-leader.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';

// Every test in this file needs a working OPFS boot, a leader and an encrypted store. Firefox in
// private browsing and WebKit in an ephemeral context both boot in `memory` mode by design, so these
// assertions would fail there for the right reason and the wrong purpose. Task 18 adds the firefox
// and webkit projects and `persistence-matrix.spec.ts` covers those engines; this file stays on
// Chromium, and the hand-over metrics file is written by the Chromium run alone.
test.skip(({ browserName }) => browserName !== 'chromium', 'OPFS sahpool is Chromium-only here');

/** Each test gets its own instance id, so its OPFS directory is its own. */
function instance(name: string): string {
  return `spike-${name}-${Date.now().toString(36)}`;
}

async function boot(page: Page, id: string): Promise<void> {
  await page.goto(`/?instance=${id}`);
  await expect(page.getByTestId('mode')).not.toHaveText('', { timeout: 60_000 });
  await expect(page.getByTestId('role')).not.toHaveText('', { timeout: 60_000 });
}

test('a lone tab probes opfs, becomes leader on the first attempt and opens the encrypted store', async ({ page }) => {
  const id = instance('lone');
  await boot(page, id);

  await expect(page.getByTestId('mode')).toHaveText('opfs');
  await expect(page.getByTestId('reason')).toHaveText('');
  await expect(page.getByTestId('role')).toHaveText('leader');
  await expect(page.getByTestId('attempts')).toHaveText('1');
  // A row read back through `SELECT count(*)` proves PRAGMA key actually took.
  await expect(page.getByTestId('rows')).toHaveText('1');
});

test('the probe runs before install, and install creates the pool directory only in opfs mode', async ({ page }) => {
  const id = instance('probe-order');
  await boot(page, id);

  const order: string[] = await page.evaluate(() => (globalThis as any).__dilla.order);
  expect(order.slice(0, 2)).toEqual(['probe', 'install']);

  const dirs: string[] = await page.evaluate(async (dir) => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    // @ts-expect-error async iteration over FileSystemDirectoryHandle is not in lib.dom yet
    for await (const [name] of root.entries()) names.push(name);
    const sub = await root.getDirectoryHandle(dir.split('/')[0]);
    // @ts-expect-error same
    for await (const [name] of sub.entries()) names.push(`${dir.split('/')[0]}/${name}`);
    return names;
  }, `dilla/${id}`);
  expect(dirs.some((n) => n.startsWith('dilla'))).toBe(true);
});

test('a second tab in the same context stays a follower while the leader holds the lock', async ({ context }) => {
  const id = instance('follower');
  const leader = await context.newPage();
  await boot(leader, id);
  await expect(leader.getByTestId('role')).toHaveText('leader');

  const follower = await context.newPage();
  await boot(follower, id);
  await expect(follower.getByTestId('role')).toHaveText('follower');

  // The other half of the leader contract: the follower opened no store of its own, forwarded a
  // `call` over the BroadcastChannel and rendered the leader's `event`. Asserting the leader's row
  // count here is what makes the channel load-bearing rather than decorative.
  await expect(follower.getByTestId('rows')).toHaveText('1', { timeout: 30_000 });
  const followerOrder: string[] = await follower.evaluate(() => (globalThis as any).__dilla.order);
  expect(followerOrder).toContain('follower');
  expect(followerOrder).not.toContain('install');
});

test('a wrong key fails on the SELECT, not on the pragma', async ({ page }) => {
  const id = instance('wrong-key');
  await boot(page, id);
  await expect(page.getByTestId('role')).toHaveText('leader');

  // gap-13 §2.2: `PRAGMA key` reports ok whatever the key is, so this message is the only evidence
  // the browser store is actually encrypted. The probe runs after the boot marker is written, because
  // an empty database has no page to decrypt and any key would succeed.
  const message: string = await page.evaluate(() => (globalThis as any).__dilla.wrongKeyMessage);
  expect(message).toContain('sqlite_schema');
  expect(message).toContain('E_STORE_KEY');
  expect(message).not.toContain('PRAGMA key');
  expect(message).not.toContain('unexpected:');
});

test('the encrypted database survives a reload in the same context', async ({ page }) => {
  const id = instance('reload');
  await boot(page, id);
  await page.getByTestId('append').click();
  await expect(page.getByTestId('rows')).toHaveText('2');

  await page.reload();
  await boot(page, id);
  await expect(page.getByTestId('mode')).toHaveText('opfs');
  await expect(page.getByTestId('rows')).toHaveText('2');
  // Second visit, marker still present: storage was not cleared.
  await expect(page.getByTestId('marker')).toHaveText('kept');
});

test('opening the pool under its plain VFS name fails with the exact sqlite3mc message', async ({ page }) => {
  const id = instance('plain-vfs');
  await boot(page, id);
  const message: string = await page.evaluate(() => (globalThis as any).__dilla.plainVfsMessage);
  expect(message).toContain('Setting key failed. Encryption is not supported by the VFS.');
});

test('resigning closes the connection, pauses the VFS and releases the lock in that order', async ({
  context,
}) => {
  const id = instance('resign');
  const page = await context.newPage();
  await boot(page, id);
  await page.getByTestId('resign').click();
  await expect(page.getByTestId('role')).toHaveText('resigned');

  // `lock-released` is pushed from a `.finally()` on navigator.locks.request, so it appears only once
  // the browser has really released the lock — recording it on the line after `resign()` would record
  // intent and would still pass if the lock were never released at all.
  await expect
    .poll(async () => (await page.evaluate(() => (globalThis as any).__dilla.order)) as string[], {
      timeout: 30_000,
    })
    .toContain('lock-released');

  const order: string[] = await page.evaluate(() => (globalThis as any).__dilla.order);
  const tail = order.slice(order.indexOf('resign-start'));
  expect(tail).toEqual(['resign-start', 'pause', 'leader-resigned', 'lock-released']);

  // The only proof the lock is genuinely free: a fresh page takes it. Without this, a leader that
  // resigned but never released would wedge every successor and the test above would not notice.
  const successor = await context.newPage();
  await boot(successor, id);
  await expect(successor.getByTestId('role')).toHaveText('leader', { timeout: 30_000 });
});
```

- [ ] **Step 2: Run the spec to verify it fails**

There is no `npm install` here: the root `workspaces` array is still `["packages/*"]` until step 3, so npm
would ignore `e2e/package.json` entirely and the lockfile would gain nothing. The real install is step 9's.

Run: `npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run test:e2e -w @dilla/e2e`

Expected: FAIL — `npm error Workspace not found: @dilla/e2e`, because the root `workspaces` array does not
list it yet.

- [ ] **Step 3: Register both new workspaces**

In `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/package.json`, replace the
`"workspaces"` line and add one script:

```json
  "workspaces": ["packages/*", "core/dilla-core-wasm/spike", "e2e"],
```

and, inside `"scripts"`, add after `"vectors"`:

```json
    "test:e2e": "npm run test:e2e -w @dilla/e2e"
```

Leave the existing `"test"` script exactly as it is — it must keep running only the Node workspaces.

- [ ] **Step 4: Write the spike's package, Vite config, tsconfig and shell**

Create `core/dilla-core-wasm/spike/package.json`:

```json
{
  "name": "@dilla/core-wasm-spike",
  "private": true,
  "version": "0.0.0",
  "license": "Apache-2.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.worker.json"
  },
  "devDependencies": {
    "typescript": "^5.6",
    "vite": "^6"
  }
}
```

No `test` script here either, for the same reason as `@dilla/e2e`.

Create `core/dilla-core-wasm/spike/vite.config.ts`:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  preview: { host: '127.0.0.1', port: 5178, strictPort: true },
  // No `optimizeDeps.exclude` entry for ./pkg: that option takes bare module specifiers, and the
  // wasm-pack glue is imported by relative path, which Vite never pre-bundles anyway. An entry there
  // would be inert and would document a mechanism that does not apply.
  build: { target: 'es2022' },
});
```

Create `core/dilla-core-wasm/spike/tsconfig.json` — the **window** program. `lib.dom.d.ts` and
`lib.webworker.d.ts` both declare `self`, `Event`, `EventTarget`, `addEventListener`, `Blob`,
`MessageEvent` and `navigator` as `declare var`/`declare function` with different types, so putting `DOM`
and `WebWorker` in one `lib` array produces hundreds of TS2300 "Duplicate identifier" and TS2403
"Subsequent variable declarations must have the same type" errors that have nothing to do with the spike's
code. The `/// <reference lib="webworker" />` in `worker.ts` does not avoid the clash while `DOM` is in
`lib`; two programs do.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src/main.ts", "vite.config.ts", "pkg/*.d.ts"]
}
```

Create `core/dilla-core-wasm/spike/tsconfig.worker.json` — the **worker** program, over the three modules
that run inside the dedicated worker:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "WebWorker"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src/worker.ts", "src/leader.ts", "src/probe.ts", "pkg/*.d.ts"]
}
```

Create `core/dilla-core-wasm/spike/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>dilla core-wasm spike</title>
  </head>
  <body>
    <h1>dilla browser store spike</h1>
    <p id="banner" data-testid="banner" hidden></p>
    <dl>
      <dt>persistence</dt><dd data-testid="mode" id="mode"></dd>
      <dt>reason</dt><dd data-testid="reason" id="reason"></dd>
      <dt>role</dt><dd data-testid="role" id="role"></dd>
      <dt>open attempts</dt><dd data-testid="attempts" id="attempts">-</dd>
      <dt>open elapsed (ms)</dt><dd data-testid="elapsed" id="elapsed">-</dd>
      <dt>rows</dt><dd data-testid="rows" id="rows">-</dd>
      <dt>boot marker</dt><dd data-testid="marker" id="marker">-</dd>
    </dl>
    <button data-testid="append" id="append">append a row</button>
    <button data-testid="resign" id="resign">resign leadership</button>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: Write `leader.ts` and `probe.ts`**

Create `core/dilla-core-wasm/spike/src/leader.ts`:

```ts
/**
 * The leader contract. One exclusive Web Lock named `dilla-core:<instance>` per instance, plus a
 * BroadcastChannel of the same name. The lock is the election; the channel is how followers learn
 * what happened. Web Locks are released automatically when the holding agent dies, which is the
 * whole point: no lease, no TTL, no heartbeat (gap-14 §1).
 */

export type LeaderMessage =
  | { type: 'leader-elected'; instance: string }
  | { type: 'leader-resigned'; instance: string }
  | { type: 'call'; id: number; fn: string; args: unknown[] }
  | { type: 'event'; name: string; detail: unknown };

export interface LeaderSession {
  /** The BroadcastChannel followers listen on; live for as long as the lock is held. */
  readonly channel: BroadcastChannel;
  /** Releases the Web Lock. Call only after the store is paused. */
  resign(): void;
}

export function channelName(instance: string): string {
  return `dilla-core:${instance}`;
}

/**
 * Takes the lock, runs `onElected` while holding it, and keeps holding it until `resign()` is
 * called or the agent dies. `onContended` is called once if the lock was not immediately free, so
 * the caller can report follower status without polling.
 *
 * `onReleased` fires from a `.finally()` on the `navigator.locks.request` promise, which settles only
 * after the callback's returned promise has settled and the browser has actually released the lock.
 * `resign()` merely resolves `held`; recording "lock-released" on the line after `resign()` would
 * record intent, and would still pass if the lock were never released at all — the one failure that
 * wedges every subsequent leader.
 */
export function elect(
  instance: string,
  onElected: (session: LeaderSession) => Promise<void>,
  onContended: () => void,
  onReleased: () => void,
): void {
  const name = channelName(instance);
  const channel = new BroadcastChannel(name);

  // ifAvailable tells us, without waiting, whether somebody already holds it.
  void navigator.locks.request(name, { ifAvailable: true }, async (probe) => {
    if (probe === null) onContended();
  });

  void navigator.locks
    .request(name, { mode: 'exclusive' }, async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await onElected({ channel, resign: release });
      await held;
    })
    .finally(() => {
      onReleased();
    });
}
```

Create `core/dilla-core-wasm/spike/src/probe.ts`:

```ts
import { probe_persistence } from '../pkg/dilla_core_wasm.js';

export interface Persistence {
  mode: 'opfs' | 'memory';
  reason: string;
  elapsedMs: number;
}

/**
 * gap-15 §6: a functional probe, run in the dedicated worker BEFORE install(), so a `memory` boot
 * never leaves a half-created pool behind. Presence checks are useless here — Firefox and Safari
 * private browsing expose the full API and only fail the call.
 */
export async function probePersistence(): Promise<Persistence> {
  const started = performance.now();
  const raw = JSON.parse(await probe_persistence()) as { mode: 'opfs' | 'memory'; reason?: string };
  return { mode: raw.mode, reason: raw.reason ?? '', elapsedMs: performance.now() - started };
}
```

- [ ] **Step 6: Write `worker.ts`**

Create `core/dilla-core-wasm/spike/src/worker.ts`:

```ts
/// <reference lib="webworker" />
import init, {
  is_sah_contention,
  store_open,
  unencrypted_vfs_probe,
  wrong_key_probe,
  StoreOpenConfig,
  type StoreHandle,
} from '../pkg/dilla_core_wasm.js';
import { channelName, elect, type LeaderMessage } from './leader.js';
import { probePersistence } from './probe.js';

/** SQLite upstream's own schedule for this exact contention (gap-14 §5): 6 tries over ~4.5 s. */
const BACKOFF_MS = [300, 600, 900, 1200, 1500] as const;
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

/** A fixed spike KEK. The real device KEK comes from the pairing flow; this is not that. */
const SPIKE_KEK_HEX = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';
/** A different 64-hex KEK, used once against the already-written database to prove the SELECT is the
 *  key check and `PRAGMA key` is not (gap-13 §2.2, interfaces §6 task 17). */
const WRONG_KEK_HEX = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const order: string[] = [];
let handle: StoreHandle | undefined;

function post(message: Record<string, unknown>): void {
  scope.postMessage({ ...message, order: [...order] });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    scope.setTimeout(resolve, ms);
  });
}

interface Opened {
  handle: StoreHandle;
  attempts: number;
  elapsedMs: number;
}

/**
 * One `store_open` per attempt; the retry lives here, not in Rust, because the attempt count is
 * what the spike has to report. Only contention is retried — `ConfigurationMismatch`,
 * `NotSupported` and `NoCapacity` are permanent (gap-14 §5).
 */
async function openWithRetry(directory: string, dbName: string, kekHex: string): Promise<Opened> {
  const started = performance.now();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // A fresh StoreOpenConfig per attempt. `store_open` takes it **by value**, so wasm-bindgen's glue
    // calls `cfg.__destroy_into_raw()` and nulls the wrapper's pointer on the first call; reusing one
    // config makes attempt 2 throw `Error: null pointer passed to rust`, which `is_sah_contention`
    // classifies as false, so the loop rethrows and the whole retry budget this spike exists to
    // measure becomes dead code. gap-14 §0/§3 says a first failure right after a hand-over is the
    // expected, self-healing case, and task 18 asserts attempt 2 works.
    const cfg = new StoreOpenConfig(directory, dbName, kekHex);
    try {
      const opened = await store_open(cfg);
      return { handle: opened, attempts: attempt, elapsedMs: performance.now() - started };
    } catch (err) {
      if (!is_sah_contention(err) || attempt === MAX_ATTEMPTS) throw err;
      await sleep(BACKOFF_MS[attempt - 1]);
    }
  }
  throw new Error('unreachable: the loop returns or throws');
}

async function run(instance: string): Promise<void> {
  await init();

  order.push('probe');
  const persistence = await probePersistence();
  post({ type: 'probe', ...persistence });

  if (persistence.mode === 'memory') {
    // gap-15 AC-5: install() is never called, so no .opfs-sahpool directory is created.
    order.push('memory-boot');
    post({ type: 'memory-boot' });
    return;
  }

  // Created before `elect` so that both callbacks can use it: the follower sends its call the moment
  // it learns the lock is taken, and the leader answers on the session channel.
  const channel = new BroadcastChannel(channelName(instance));
  channel.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as LeaderMessage;
    post({ type: 'event', name: data.type });
    if (data.type === 'event' && data.name === 'rows') {
      post({ type: 'rows', rows: Number(data.detail) });
    }
  });

  elect(
    instance,
    async (session) => {
      order.push('install');
      const opened = await openWithRetry(`dilla/${instance}`, 'dilla.db', SPIKE_KEK_HEX);
      handle = opened.handle;
      // NV-13's exported async method, exercised once so it is never shipped untested.
      await handle.reserve_capacity(16);

      // gap-13 §3: the plain VFS name cannot carry a key. Proving it here keeps the trap from
      // silently coming back if someone "simplifies" the VFS name later.
      order.push('plain-vfs-probe');
      let plainVfsMessage: string;
      try {
        plainVfsMessage = unencrypted_vfs_probe('plain.db', SPIKE_KEK_HEX);
      } catch (err) {
        plainVfsMessage = `unexpected: ${String(err)}`;
      }

      handle.exec('CREATE TABLE IF NOT EXISTS spike_meta (key TEXT PRIMARY KEY, value TEXT);');
      const hadMarker =
        handle.query_scalar_i64("SELECT count(*) FROM spike_meta WHERE key = 'boot_marker'") > 0;
      handle.exec("INSERT OR REPLACE INTO spike_meta (key, value) VALUES ('boot_marker', '1');");

      // gap-13 §2.2: `PRAGMA key` always reports ok, so the SELECT is the key check. This runs AFTER
      // the table and the row exist — on an empty database there is no page to decrypt and a wrong key
      // would pass. interfaces §6 task 17 requires this assertion and nothing in §2.11 could make it.
      order.push('wrong-key-probe');
      let wrongKeyMessage: string;
      try {
        wrongKeyMessage = await wrong_key_probe('dilla.db', WRONG_KEK_HEX);
      } catch (err) {
        wrongKeyMessage = `unexpected: ${String(err)}`;
      }

      order.push('leader-elected');
      session.channel.postMessage({ type: 'leader-elected', instance });
      post({
        type: 'leader-elected',
        attempts: opened.attempts,
        elapsedMs: opened.elapsedMs,
        rows: handle.query_scalar_i64('SELECT count(*) FROM spike_meta'),
        hadMarker,
        capacity: handle.capacity(),
        plainVfsMessage,
        wrongKeyMessage,
      });

      // The other half of the leader contract (spec, "Browser hosting (fixes the SharedWorker
      // flaw)"): followers forward calls over the BroadcastChannel and render from the leader's
      // events. One call and one event is the whole round trip the week-1 spike needs to prove it.
      session.channel.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as LeaderMessage;
        if (data.type === 'call' && data.fn === 'rows' && handle !== undefined) {
          session.channel.postMessage({
            type: 'event',
            name: 'rows',
            detail: handle.query_scalar_i64('SELECT count(*) FROM spike_meta'),
          } satisfies LeaderMessage);
        }
      });

      scope.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { type: string };
        if (data.type === 'append' && handle !== undefined) {
          handle.exec(
            `INSERT OR REPLACE INTO spike_meta (key, value) VALUES ('row-${Date.now()}', 'x');`,
          );
          post({ type: 'rows', rows: handle.query_scalar_i64('SELECT count(*) FROM spike_meta') });
        }
        if (data.type === 'resign' && handle !== undefined) {
          // The order below is the contract: connection closed, VFS paused, message posted, lock
          // released. pause_vfs() errors while any file handle is open (gap-11 §9 item 5).
          // `lock-released` is NOT pushed here: `resign()` only resolves the `held` promise, and the
          // browser releases the lock later, when the locks.request callback's promise settles. It is
          // recorded in `elect`'s `onReleased`, which runs from a `.finally()` on that promise.
          order.push('resign-start');
          handle.pause();
          order.push('pause');
          session.channel.postMessage({ type: 'leader-resigned', instance });
          order.push('leader-resigned');
          session.resign();
          post({ type: 'resigned' });
        }
      });
    },
    () => {
      order.push('follower');
      post({ type: 'follower' });
      // A follower opens no store of its own; it asks the leader and renders the answer.
      channel.postMessage({ type: 'call', id: 1, fn: 'rows', args: [] } satisfies LeaderMessage);
    },
    () => {
      // Fired from `.finally()` on navigator.locks.request, i.e. after the browser has actually
      // released the lock — not when `resign()` was called.
      order.push('lock-released');
      post({ type: 'lock-released' });
    },
  );
}

scope.addEventListener('message', function bootstrap(event: MessageEvent) {
  const data = event.data as { type: string; instance?: string };
  if (data.type !== 'start' || data.instance === undefined) return;
  scope.removeEventListener('message', bootstrap);
  void run(data.instance).catch((err: unknown) => {
    post({ type: 'error', message: String(err) });
  });
});
```

- [ ] **Step 7: Write `main.ts`**

Create `core/dilla-core-wasm/spike/src/main.ts`:

```ts
interface WorkerReport {
  type: string;
  order?: string[];
  mode?: 'opfs' | 'memory';
  reason?: string;
  attempts?: number;
  elapsedMs?: number;
  rows?: number;
  hadMarker?: boolean;
  capacity?: number;
  plainVfsMessage?: string;
  wrongKeyMessage?: string;
  name?: string;
  message?: string;
}

const params = new URLSearchParams(location.search);
const instance = params.get('instance') ?? 'default';
const visitedKey = `dilla:visited:${instance}`;

function text(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el !== null) el.textContent = value;
}

function banner(message: string): void {
  const el = document.getElementById('banner');
  if (el === null) return;
  el.textContent = message;
  el.hidden = false;
}

const state: Record<string, unknown> = { order: [], instance };
(globalThis as unknown as { __dilla: Record<string, unknown> }).__dilla = state;

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

worker.addEventListener('message', (event: MessageEvent<WorkerReport>) => {
  const report = event.data;
  if (report.order !== undefined) state.order = report.order;

  switch (report.type) {
    case 'probe':
      text('mode', report.mode ?? '');
      text('reason', report.reason ?? '');
      state.mode = report.mode;
      state.reason = report.reason;
      break;
    case 'memory-boot':
      text('role', 'memory');
      // gap-15 AC-7: the copy states the effect, never "you are in a private window" — the same
      // SecurityError fires in a normal Firefox window with site storage blocked.
      banner("Messages in this window won't be saved on this device.");
      break;
    case 'follower':
      text('role', 'follower');
      break;
    case 'leader-elected': {
      text('role', 'leader');
      text('attempts', String(report.attempts ?? ''));
      text('elapsed', String(Math.round(report.elapsedMs ?? 0)));
      text('rows', String(report.rows ?? ''));
      state.attempts = report.attempts;
      state.elapsedMs = report.elapsedMs;
      state.capacity = report.capacity;
      state.plainVfsMessage = report.plainVfsMessage;
      state.wrongKeyMessage = report.wrongKeyMessage;

      // gap-15 AC-6 option (b): engine-independent detection of a cleared store. Chrome incognito
      // reports mode "opfs" and still loses everything, so the probe alone cannot see this.
      const visitedBefore = localStorage.getItem(visitedKey) === '1';
      localStorage.setItem(visitedKey, '1');
      if (visitedBefore && report.hadMarker === false) {
        text('marker', 'cleared');
        banner('Storage was cleared since your last visit.');
      } else {
        text('marker', visitedBefore ? 'kept' : 'first-visit');
      }
      break;
    }
    case 'rows':
      text('rows', String(report.rows ?? ''));
      break;
    case 'resigned':
      text('role', 'resigned');
      break;
    case 'error':
      text('role', 'error');
      banner(`Store error: ${report.message ?? 'unknown'}`);
      break;
    default:
      break;
  }
});

document.getElementById('append')?.addEventListener('click', () => {
  worker.postMessage({ type: 'append' });
});
document.getElementById('resign')?.addEventListener('click', () => {
  worker.postMessage({ type: 'resign' });
});

worker.postMessage({ type: 'start', instance });
```

- [ ] **Step 8: Add `unencrypted_vfs_probe` and `wrong_key_probe` to `store.rs` (deviation A2-10)**

Append to `core/dilla-core-wasm/src/store.rs`:

```rust
/// Deviation A2-10. Proves gap-13 §3's trap is real and stays real: a connection opened on the
/// pool's **plain** VFS name cannot be keyed. Returns SQLite's error text, and errors if the open
/// unexpectedly succeeds — that would mean the encrypting wrapper is no longer needed and the
/// store's VFS choice must be revisited. Call only after `store_open` has installed the pool.
#[wasm_bindgen]
pub fn unencrypted_vfs_probe(db_name: &str, kek_hex: &str) -> Result<String, JsError> {
    let conn = Connection::open_with_flags_and_vfs(db_name, OpenFlags::default(), POOL_VFS)
        .map_err(|e| JsError::new(&format!("E_STORE_OPEN: {e}")))?;
    let pragmas =
        Zeroizing::new(format!("PRAGMA cipher = 'chacha20'; PRAGMA key = 'raw:{kek_hex}';"));
    match conn.execute_batch(&pragmas) {
        Ok(()) => Err(JsError::new(
            "E_STORE_PROBE: the plain VFS accepted a key; gap-13 §3 no longer holds",
        )),
        Err(e) => Ok(e.to_string()),
    }
}

/// Deviation A2-10. Opens an **existing, written** database on the encrypting VFS with the wrong key
/// and returns the text of the failure, so the spike can assert where it happened. gap-13 §2.2: the
/// `PRAGMA key` statement always reports ok, so the only evidence the store is really encrypted is
/// that the first real read fails. Returns an error if the wrong key is accepted all the way through
/// the SELECT — that would mean the database is not encrypted at all.
///
/// Call only after `store_open` has installed the pool **and** something has been written: on an
/// empty database there is no page to decrypt and any key succeeds.
#[wasm_bindgen]
pub async fn wrong_key_probe(db_name: &str, kek_hex: &str) -> Result<String, JsError> {
    if kek_hex.len() != 64 || !kek_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(JsError::new("E_STORE_KEK: kek_hex must be 64 hex characters"));
    }
    let conn = Connection::open_with_flags_and_vfs(db_name, OpenFlags::default(), ENCRYPTED_VFS)
        .map_err(|e| JsError::new(&format!("E_STORE_OPEN: {e}")))?;
    let pragmas =
        Zeroizing::new(format!("PRAGMA cipher = 'chacha20'; PRAGMA key = 'raw:{kek_hex}';"));
    conn.execute_batch(&pragmas)
        .map_err(|e| JsError::new(&format!("E_STORE_PROBE: the pragmas rejected the wrong key, so this probe proves nothing: {e}")))?;
    drop(pragmas);
    match conn.query_row("SELECT count(*) FROM sqlite_schema", [], |r| r.get::<_, i64>(0)) {
        Ok(_) => Err(JsError::new(
            "E_STORE_PROBE: a wrong key read sqlite_schema; the database is not encrypted",
        )),
        Err(e) => Ok(format!("E_STORE_KEY: SELECT count(*) FROM sqlite_schema: {e}")),
    }
}
```

`wrong_key_probe` is `async` only so that the JS side calls it the same way it calls `store_open`; it does
no awaiting of its own. Its return value is the **success** case: the string names the statement that
failed, which is what task 18 asserts. Every path that would mean the store is not encrypted is an error.

- [ ] **Step 9: Rebuild the wasm package and install the browser**

Run: `/home/thim/.cargo/bin/wasm-bindgen --version`

Expected: `wasm-bindgen 0.2.128` — the exact version of the `wasm-bindgen` crate in `Cargo.lock`.
`--mode no-install` means "don't install tools like `wasm-bindgen`, just use the global environment's
existing versions" (facts-ci §1.6), and wasm-pack resolves the CLI with `which("wasm-bindgen")`, not with the
absolute path this plan otherwise uses everywhere. R4 installs rustup with `--no-modify-path`, so
`~/.cargo/bin` is not necessarily on this shell's PATH and the `which` would fail with "wasm-bindgen not
found". The next command therefore uses the documented PATH prepend R4 allows, written out in full: the
login shell here is fish, where `$PATH` is a list and `PATH=/home/thim/.cargo/bin:$PATH` would expand to
several arguments instead of one, so the whole search path is spelled literally.

Run: `env PATH=/home/thim/.cargo/bin:/usr/local/bin:/usr/bin:/bin /home/thim/.cargo/bin/wasm-pack build /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasm --target web --release --mode no-install --out-dir spike/pkg`

Expected: PASS, with `unencrypted_vfs_probe` now present in `spike/pkg/dilla_core_wasm.d.ts`.

Run: `grep -c unencrypted_vfs_probe /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasm/spike/pkg/dilla_core_wasm.d.ts`

Expected: a count of at least 1.

Run: `grep -c wrong_key_probe /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasm/spike/pkg/dilla_core_wasm.d.ts`

Expected: a count of at least 1.

Run: `npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol install`

Expected: PASS — the two new workspaces are linked and `package-lock.json` is updated.

Run: `npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol exec -- playwright install chromium`

Expected: PASS, or "browser is already installed" — Playwright's Chromium is already present on this box for
the `ui` package (facts-local-toolchain).

Run: `npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run typecheck -w @dilla/core-wasm-spike`

Expected: PASS (no output).

- [ ] **Step 10: Run the spec to verify it passes**

Run: `npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run test:e2e -w @dilla/e2e`

Expected: PASS — 7 passed, project `chromium`.

**This is NV-10.** If `store_open` fails at `PRAGMA key` or at the `SELECT`, the combination of sqlite3mc
and the OPFS sahpool does not work, and nobody has ever run it before (gap-13 §6). Do not paper over it:
capture the exact error and record it as this spike's outcome. A failure here is a **recorded result, not
a blocker** — follow-up card (h) already carries the fallback (application-level AES-256-GCM of row
payloads under the device KEK, decided in the web-client plan), so this task finishes either way and
task 20's report states which branch happened.

- [ ] **Step 11: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add package.json package-lock.json core/dilla-core-wasm/src/store.rs core/dilla-core-wasm/spike e2e && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'feat(core-wasm): dedicated-worker OPFS store spike with Web Locks leader election'
```

---

### Task 18: Playwright end-to-end for the browser spike

**Files:**
- Create: `e2e/tests/persistence-matrix.spec.ts`
- Modify: `e2e/playwright.config.ts` (adds the Firefox and WebKit projects — deviation A2-5)
- Modify: `e2e/tests/opfs-leader.spec.ts` (adds the hand-over and metrics tests — deviation A2-5)
- Modify: `e2e/package.json` (adds `test:e2e:matrix`)
- Modify: `.gitignore` (adds `e2e/test-results/` — deviation A2-15)
- Test: both spec files, run by Playwright.

**Interfaces:**
- Consumes: the task 17 spike and its `__dilla` page state.
- Produces: the `@dilla/e2e` matrix run and `e2e/test-results/opfs-leader-metrics.json`, which task 20 quotes.

- [ ] **Step 1: Write the failing hand-over and metrics tests**

Append to `e2e/tests/opfs-leader.spec.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HANDOVERS = 10;

test('leadership passes to the follower within the 6-attempt budget when the leader tab is closed', async ({
  context,
}) => {
  const id = instance('handover');
  const samples: Array<{ attempts: number; elapsedMs: number; grantMs: number }> = [];

  let leader = await context.newPage();
  await boot(leader, id);
  await expect(leader.getByTestId('role')).toHaveText('leader');

  for (let i = 0; i < HANDOVERS; i += 1) {
    const follower = await context.newPage();
    await boot(follower, id);
    await expect(follower.getByTestId('role')).toHaveText('follower');

    // interfaces §6 task 20 asks for the **lock-release latency after a leader kill**, which is the
    // interval between closing the leader and the successor being elected. `elapsedMs` is measured
    // inside openWithRetry, which starts only after the lock has already been granted, so it is the
    // reopen time and not that latency. Both are recorded; task 20 reports them under their own names.
    const killedAt = Date.now();
    await leader.close();

    // The Web Lock is released on agent teardown, with no lease and no TTL; the successor's first
    // install() is also what evicts a BFCached predecessor, so one retry is expected and healthy
    // (gap-14 §0, §3).
    await expect(follower.getByTestId('role')).toHaveText('leader', { timeout: 30_000 });
    const grantMs = Date.now() - killedAt;
    const attempts = Number(await follower.getByTestId('attempts').textContent());
    const elapsedMs = Number(await follower.getByTestId('elapsed').textContent());

    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(attempts).toBeLessThanOrEqual(2);
    expect(elapsedMs).toBeLessThan(4500);
    samples.push({ attempts, elapsedMs, grantMs });

    leader = follower;
  }

  const sorted = [...samples].sort((a, b) => a.elapsedMs - b.elapsedMs);
  const sortedGrant = [...samples].sort((a, b) => a.grantMs - b.grantMs);
  const metrics = {
    handovers: HANDOVERS,
    attempts: {
      min: Math.min(...samples.map((s) => s.attempts)),
      max: Math.max(...samples.map((s) => s.attempts)),
    },
    // Time from `leader.close()` to the successor showing `role = leader`: the OPFS/Web-Locks
    // release latency task 20 must publish. No vendor documents a bound (gap-14 §0).
    grantMs: {
      min: sortedGrant[0].grantMs,
      p50: sortedGrant[Math.floor(sortedGrant.length / 2)].grantMs,
      max: sortedGrant[sortedGrant.length - 1].grantMs,
    },
    // Time inside `openWithRetry`, i.e. how long reopening the encrypted store took once the lock
    // was already held.
    elapsedMs: {
      min: sorted[0].elapsedMs,
      p50: sorted[Math.floor(sorted.length / 2)].elapsedMs,
      max: sorted[sorted.length - 1].elapsedMs,
    },
    samples,
  };
  const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-results');
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'opfs-leader-metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
});

test('the new leader reads the rows the old leader wrote', async ({ context }) => {
  const id = instance('handover-data');
  const first = await context.newPage();
  await boot(first, id);
  await first.getByTestId('append').click();
  await expect(first.getByTestId('rows')).toHaveText('2');

  const second = await context.newPage();
  await boot(second, id);
  await expect(second.getByTestId('role')).toHaveText('follower');
  await first.close();

  await expect(second.getByTestId('role')).toHaveText('leader', { timeout: 30_000 });
  await expect(second.getByTestId('rows')).toHaveText('2');
});
```

- [ ] **Step 2: Write the failing persistence-matrix spec**

Create `e2e/tests/persistence-matrix.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

function instance(name: string): string {
  return `matrix-${name}-${Date.now().toString(36)}`;
}

test.describe('@matrix persistence across engines', () => {
  test('chromium reports opfs and keeps the database across a reload', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'chromium project only');
    const id = instance('chromium');
    await page.goto(`/?instance=${id}`);
    await expect(page.getByTestId('mode')).toHaveText('opfs', { timeout: 60_000 });
    await page.getByTestId('append').click();
    await expect(page.getByTestId('rows')).toHaveText('2');
    await page.reload();
    await expect(page.getByTestId('rows')).toHaveText('2', { timeout: 60_000 });
  });

  test('firefox private browsing reports memory with getDirectory:SecurityError and still boots', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'firefox', 'firefox project only');
    const id = instance('firefox-private');
    await page.goto(`/?instance=${id}`);
    // A plain Playwright Firefox context is a fresh profile, NOT private browsing, and would
    // report "opfs" — the project sets browser.privatebrowsing.autostart so this is real PBM.
    await expect(page.getByTestId('mode')).toHaveText('memory', { timeout: 60_000 });
    await expect(page.getByTestId('reason')).toHaveText('getDirectory:SecurityError');
    await expect(page.getByTestId('role')).toHaveText('memory');
    await expect(page.getByTestId('banner')).toBeVisible();
    // gap-15 AC-7: the copy names the effect, never the browser mode.
    await expect(page.getByTestId('banner')).toHaveText(
      "Messages in this window won't be saved on this device.",
    );
  });

  test('webkit ephemeral contexts report memory with getDirectory:UnknownError and still boot', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'webkit', 'webkit project only');
    const id = instance('webkit');
    await page.goto(`/?instance=${id}`);
    await expect(page.getByTestId('mode')).toHaveText('memory', { timeout: 60_000 });
    await expect(page.getByTestId('reason')).toHaveText('getDirectory:UnknownError');
    await expect(page.getByTestId('banner')).toBeVisible();
  });

  test('a memory boot never installs the pool and never reads an epoch from storage', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'chromium', 'memory mode only');
    const id = instance('no-install');
    await page.goto(`/?instance=${id}`);
    await expect(page.getByTestId('mode')).toHaveText('memory', { timeout: 60_000 });

    // gap-15 AC-5: install() is never reached, so the order log stops at the memory boot.
    const order: string[] = await page.evaluate(() => (globalThis as any).__dilla.order);
    expect(order).toEqual(['probe', 'memory-boot']);
    expect(order).not.toContain('install');

    // gap-15 AC-4, second half: a reload produces a fresh client with no stored rows to read. The
    // first half — "rejoins by external commit", i.e. exactly one external commit on the wire — is
    // **deviation A2-12**: this spike has no MLS group, no delivery service and no wire, so it cannot
    // be observed here at all. Plan A task 13's testkit scenarios and the first browser-client task
    // (W2) carry it.
    await page.reload();
    await expect(page.getByTestId('mode')).toHaveText('memory', { timeout: 60_000 });
    await expect(page.getByTestId('rows')).toHaveText('-');
  });

  test('a cleared store is reported on the next visit', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'needs a working opfs boot to clear');
    const id = instance('cleared');
    await page.goto(`/?instance=${id}`);
    await expect(page.getByTestId('marker')).toHaveText('first-visit', { timeout: 60_000 });

    // The leader's dedicated worker still holds FileSystemSyncAccessHandles over the sahpool slots,
    // and in Chromium `removeEntry` on a directory with live access handles rejects with
    // NoModificationAllowedError. Resign first: the resign path closes the connection and calls
    // pause_vfs(), which is exactly the affordance that releases those handles.
    await page.getByTestId('resign').click();
    await expect(page.getByTestId('role')).toHaveText('resigned', { timeout: 30_000 });

    // Wipe OPFS the way an incognito session end or an eviction would, leaving localStorage alone.
    const left: string[] = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const names: string[] = [];
      // @ts-expect-error async iteration over FileSystemDirectoryHandle is not in lib.dom yet
      for await (const [name] of root.entries()) names.push(name);
      for (const name of names) {
        await root.removeEntry(name, { recursive: true });
      }
      const remaining: string[] = [];
      // @ts-expect-error same
      for await (const [name] of root.entries()) remaining.push(name);
      return remaining;
    });
    // Assert the wipe itself worked, so a swallowed NoModificationAllowedError cannot make the
    // "cleared" assertion below pass for the wrong reason.
    expect(left).toEqual([]);

    await page.reload();

    await expect(page.getByTestId('marker')).toHaveText('cleared', { timeout: 60_000 });
    await expect(page.getByTestId('banner')).toHaveText('Storage was cleared since your last visit.');
  });
});
```

- [ ] **Step 3: Baseline run — this step is not a red step, and says so**

Run: `npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run test:e2e -w @dilla/e2e`

Expected: **PASS**, with skips. Playwright exits 0 when every executed test passes and the rest are skipped,
so calling this a failure would send you hunting for something that cannot happen. Concretely: only the
`chromium` project exists, so the firefox and webkit cases of `persistence-matrix.spec.ts` and its
`test.skip(browserName === 'chromium')` memory-mode case are all reported as skipped; the two new hand-over
tests of step 1 and the chromium persistence case run and must pass. The red state for the engine matrix
arrives in step 5, once the two projects that can actually produce `memory` mode exist — if the firefox and
webkit assertions were to pass before their projects are configured, they would be passing vacuously, which
is the failure this ordering avoids.

- [ ] **Step 4: Add the Firefox and WebKit projects**

In `e2e/playwright.config.ts`, replace the `projects` array:

```ts
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        // The same pref Mozilla's own dom/fs/test/mochitest-private.toml uses. Without it a
        // Playwright Firefox context is a fresh profile, privateBrowsingId 0, and reports "opfs" —
        // the test would pass for the wrong reason (gap-15 AC-1).
        launchOptions: { firefoxUserPrefs: { 'browser.privatebrowsing.autostart': true } },
      },
    },
    // A default WebKit context is already ephemeral; Playwright documents OPFS as unsupported
    // there, which is exactly the case under test (gap-15 AC-2).
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
```

In `e2e/package.json`, add to `scripts`:

```json
    "test:e2e:matrix": "playwright test --config playwright.config.ts --project=chromium --project=firefox --project=webkit"
```

and change the existing `test:e2e` so the default run stays Chromium-only:

```json
    "test:e2e": "playwright test --config playwright.config.ts --project=chromium"
```

- [ ] **Step 5: Install the two extra engines and run the matrix**

Run: `npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol exec -- playwright install firefox webkit`

Expected: PASS. These are not on this box yet (facts-local-toolchain lists only Playwright's Chromium).

Run: `npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run test:e2e:matrix -w @dilla/e2e`

Expected: PASS across all three projects, with these counts, because the two spec files do **not** both run
everywhere:

- `opfs-leader.spec.ts` carries a file-level `test.skip(({ browserName }) => browserName !== 'chromium')`
  (task 17 step 1), so its nine tests run under `chromium` and are skipped under `firefox` and `webkit`.
  Without that guard every one of them would fail on the two engines that boot in `memory` mode by design,
  and the CI `browser-spike` job would be red by construction.
- `persistence-matrix.spec.ts` guards each test individually, so exactly one of its five runs per project.

`getDirectory:SecurityError` under Firefox and `getDirectory:UnknownError` under WebKit are the assertions
that prove the probe is functional rather than a presence check; if either reports `opfs`, the project's
launch options did not take and the test is passing for the wrong reason — fix the config, never the
assertion. `e2e/test-results/opfs-leader-metrics.json` is written by the chromium run alone, so the file
task 20 reads is never overwritten by a later project.

- [ ] **Step 6: Confirm the metrics file exists and is readable by task 20**

Run: `cat /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/e2e/test-results/opfs-leader-metrics.json`

Expected: JSON with `handovers: 10`, an `attempts` range inside 1–2, `grantMs` `min`/`p50`/`max` (the
interval from `leader.close()` to the successor being elected — the lock-release latency) and `elapsedMs`
`min`/`p50`/`max` (the reopen time inside `openWithRetry`, all below 4500). These are the numbers task 20
records; no vendor publishes a bound for OPFS lock-release latency (gap-14 §0), so this measurement is the
only source.

- [ ] **Step 6a: Confirm `.gitignore` does not yet cover Playwright's output**

Run: `grep -n 'test-results' /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/.gitignore`

Expected: no output, exit 1.

- [ ] **Step 6b: Ignore Playwright's output directory (deviation A2-15)**

Append the line `e2e/test-results/` to
`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/.gitignore`. The metrics are
transcribed into the report by task 20, not committed as a build artefact.

- [ ] **Step 6c: Confirm the rule is there**

Run: `grep -n 'test-results' /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/.gitignore`

Expected: exactly one line, `e2e/test-results/`.

- [ ] **Step 7: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add e2e .gitignore && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'test(e2e): Playwright coverage for OPFS leadership hand-over and the persistence matrix'
```

---

### Task 19: Rust and browser CI jobs

**Files:**
- Create: `scripts/check-ci-workflow.mjs`, `scripts/check-ci-workflow.test.mjs` (deviation A2-8)
- Modify: `.github/workflows/ci.yml` (adds `concurrency`, `env`, and the jobs `rust-native`, `rust-wasi`, `vectors`, `browser-spike`, `deny`; adds one `run` step to `node`; `rust-wasm-node` was added by task 16 and is otherwise left as it is)
- Modify: `package.json` (adds `check:ci` and `test:ci-check`)
- Test: `scripts/check-ci-workflow.test.mjs`, run with `node --test`

**Interfaces:**
- Consumes: everything tasks 14–18 built, plus Plan A tasks 1–13 (`cargo deny`, `dilla-testkit vectors`).
- Produces: the six jobs of interfaces §5 that belong to Plan A, and `checkWorkflow(root)` — the executable form of R22's fail-closed rule.

- [ ] **Step 1: Write the failing workflow checker test**

Create `scripts/check-ci-workflow.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWorkflow } from './check-ci-workflow.mjs';

const GOOD = `name: ci
on:
  push:
    branches: [main]
  pull_request:
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
env:
  CARGO_TERM_COLOR: always
jobs:
  node:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: npm run test:ci-check
  ui:
    runs-on: ubuntu-latest
    steps:
      - run: npm test -w packages/ui
  rust-native:
    runs-on: ubuntu-latest
    steps:
      - run: cargo fmt --all --check
      - run: cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
      - run: cargo test --workspace --all-features --locked
  rust-wasm-node:
    runs-on: ubuntu-latest
    steps:
      - run: cargo test -p dilla-core-wasm --target wasm32-unknown-unknown --locked
  rust-wasi:
    runs-on: ubuntu-latest
    steps:
      - run: cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked
      - uses: actions/upload-artifact@v7
        with:
          name: dilla-core-wasi
          path: target/wasm32-wasip1/release/dilla_core_wasi.wasm
          if-no-files-found: error
  vectors:
    runs-on: ubuntu-latest
    steps:
      - run: npm run vectors
      - run: git diff --exit-code -- protocol/vectors
      - run: cargo run -p dilla-testkit --bin dilla-testkit --locked -- vectors
  browser-spike:
    runs-on: ubuntu-latest
    steps:
      - run: wasm-pack build core/dilla-core-wasm --target web --release --mode no-install --out-dir spike/pkg
      - run: npm run test:e2e:matrix -w @dilla/e2e
  deny:
    runs-on: ubuntu-latest
    steps:
      - run: cargo deny --all-features check advisories bans licenses sources
`;

function fixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-ci-'));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), body);
  return dir;
}

test('the real workflow passes every rule', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  assert.deepEqual(checkWorkflow(root), []);
});

test('a well-formed workflow passes', () => {
  assert.deepEqual(checkWorkflow(fixture(GOOD)), []);
});

test('a missing job is reported by name', () => {
  const problems = checkWorkflow(fixture(GOOD.replace(/  deny:[\s\S]*$/, '')));
  assert.ok(problems.some((p) => p.includes('deny')), problems.join('\n'));
});

test('|| true is reported with its line number', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('- run: npm test\n', '- run: npm test || true\n')));
  assert.ok(problems.some((p) => /\|\| true/.test(p)), problems.join('\n'));
});

test('continue-on-error is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('  deny:\n', '  deny:\n    continue-on-error: true\n')));
  assert.ok(problems.some((p) => p.includes('continue-on-error')), problems.join('\n'));
});

test('if: always() is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('      - run: npm test\n', '      - if: always()\n        run: npm test\n')));
  assert.ok(problems.some((p) => p.includes('always()')), problems.join('\n'));
});

test('a job that lost a required step is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('      - run: cargo fmt --all --check\n', '')));
  assert.ok(problems.some((p) => p.includes('cargo fmt')), problems.join('\n'));
});

test('a missing concurrency block is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace(/concurrency:[\s\S]*?cancel-in-progress: true\n/, '')));
  assert.ok(problems.some((p) => p.includes('concurrency')), problems.join('\n'));
});

test('a workflow-level RUSTFLAGS is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('  CARGO_TERM_COLOR: always\n', '  CARGO_TERM_COLOR: always\n  RUSTFLAGS: -D warnings\n')));
  assert.ok(problems.some((p) => p.includes('RUSTFLAGS')), problems.join('\n'));
});

test('a rust-wasi job that lost if-no-files-found is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('          if-no-files-found: error\n', '')));
  assert.ok(problems.some((p) => p.includes('if-no-files-found')), problems.join('\n'));
});

test('a rust-wasi job that lost the artifact path is reported', () => {
  const problems = checkWorkflow(
    fixture(GOOD.replace('          path: target/wasm32-wasip1/release/dilla_core_wasi.wasm\n', '')),
  );
  assert.ok(problems.some((p) => p.includes('dilla_core_wasi.wasm')), problems.join('\n'));
});

test('a go job without needs: rust-wasi is reported', () => {
  const withGo = `${GOOD}  go:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v8
      - run: go test ./...
`;
  const problems = checkWorkflow(fixture(withGo));
  assert.ok(problems.some((p) => p.includes('needs: rust-wasi')), problems.join('\n'));
});

test('a go job with needs: rust-wasi passes', () => {
  const withGo = `${GOOD}  go:
    runs-on: ubuntu-latest
    needs: rust-wasi
    steps:
      - uses: actions/download-artifact@v8
      - run: go test ./...
`;
  assert.deepEqual(checkWorkflow(fixture(withGo)), []);
});

test('a node job that stopped running the checker\'s own tests is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('      - run: npm run test:ci-check\n', '')));
  assert.ok(problems.some((p) => p.includes('test:ci-check')), problems.join('\n'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/scripts/check-ci-workflow.test.mjs`

Expected: FAIL — `Cannot find module '.../scripts/check-ci-workflow.mjs'`.

- [ ] **Step 3: Write the checker**

Create `scripts/check-ci-workflow.mjs`:

```js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every job the workflow must carry (interfaces §5). `go` is Plan B task 8's, so it is not *required*
 * here — but if it exists, `checkGoOrdering` below insists on its `needs: rust-wasi` edge.
 */
export const REQUIRED_JOBS = [
  'node',
  'ui',
  'rust-native',
  'rust-wasm-node',
  'rust-wasi',
  'vectors',
  'browser-spike',
  'deny',
];

/** R22: no escape hatch anywhere in the workflow. */
const FORBIDDEN = [
  { re: /\|\|\s*true/, what: '|| true' },
  { re: /continue-on-error/, what: 'continue-on-error' },
  { re: /if:\s*always\(\)/, what: 'if: always()' },
];

/** One load-bearing command per job, so a silently gutted job is caught. */
const REQUIRED_STEPS = {
  'rust-native': [
    'cargo fmt --all --check',
    'cargo clippy --workspace --all-targets --all-features --locked -- -D warnings',
    'cargo test --workspace --all-features --locked',
  ],
  'rust-wasm-node': ['cargo test -p dilla-core-wasm --target wasm32-unknown-unknown --locked'],
  // Each entry must be a string the job carries and no other step of that job already contains.
  // `'dilla-core-wasi'` would be useless here: the cargo build line above already contains it, so the
  // artifact's `name:` would go unchecked. The three `with:` lines are named in full instead, which is
  // what makes step 9's argument — that `if-no-files-found: error` is what stops Plan B being handed
  // an empty directory — an enforced rule rather than prose.
  'rust-wasi': [
    'cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked',
    'actions/upload-artifact@v7',
    'name: dilla-core-wasi',
    'path: target/wasm32-wasip1/release/dilla_core_wasi.wasm',
    'if-no-files-found: error',
  ],
  // The repository's pattern is that every scripts/check-*.mjs gate runs its own unit tests in the
  // `node` job (test:docs-check, test:brief-check, test:copy-check). This gate enforces that for
  // itself, so it cannot silently rot.
  node: ['npm run test:ci-check'],
  vectors: [
    'npm run vectors',
    'git diff --exit-code -- protocol/vectors',
    'cargo run -p dilla-testkit --bin dilla-testkit --locked -- vectors',
  ],
  // Only the matrix run: it already includes the chromium project, so also running `test:e2e` would
  // execute the 10-hand-over test twice per CI run for no added signal.
  'browser-spike': [
    'wasm-pack build core/dilla-core-wasm --target web --release --mode no-install --out-dir spike/pkg',
    'npm run test:e2e:matrix -w @dilla/e2e',
  ],
  deny: ['cargo deny --all-features check advisories bans licenses sources'],
};

/** Splits the `jobs:` mapping into `{ name: body }` by two-space job keys. */
function splitJobs(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === 'jobs:');
  const jobs = {};
  if (start < 0) return jobs;
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key !== null) {
      current = key[1];
      jobs[current] = [];
      continue;
    }
    if (current !== null) jobs[current].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}

export function checkWorkflow(root) {
  const path = join(root, '.github', 'workflows', 'ci.yml');
  const text = readFileSync(path, 'utf8');
  const problems = [];

  text.split('\n').forEach((line, i) => {
    for (const { re, what } of FORBIDDEN) {
      if (re.test(line)) problems.push(`ci.yml:${i + 1}: forbidden "${what}" — CI is fail-closed (R22)`);
    }
  });

  if (!/^concurrency:$/m.test(text) || !/cancel-in-progress: true/.test(text)) {
    problems.push('ci.yml: missing the workflow-level concurrency block with cancel-in-progress: true');
  }
  // gap-29 §4 ii: a workflow-level RUSTFLAGS overrides every target.*.rustflags outright.
  if (/^\s{2}RUSTFLAGS:/m.test(text)) {
    problems.push('ci.yml: workflow-level RUSTFLAGS overrides .cargo/config.toml — use cargo clippy -- -D warnings');
  }
  if (!/^\s{2}CARGO_TERM_COLOR: always$/m.test(text)) {
    problems.push('ci.yml: missing env CARGO_TERM_COLOR: always');
  }

  const jobs = splitJobs(text);
  for (const name of REQUIRED_JOBS) {
    if (!(name in jobs)) {
      problems.push(`ci.yml: missing job "${name}"`);
      continue;
    }
    for (const step of REQUIRED_STEPS[name] ?? []) {
      if (!jobs[name].includes(step)) problems.push(`ci.yml: job "${name}" is missing: ${step}`);
    }
  }

  // Plan B task 8 owns the `go` job; this plan owns `rust-wasi`. `actions/download-artifact@v8`
  // fetches from the same workflow run, so GitHub schedules `go` after `rust-wasi` only if a `needs:`
  // says so, and whichever plan lands second has to add the edge. Nobody owned that rule, so it lives
  // here: the moment a `go` job exists, it must declare the dependency.
  if ('go' in jobs && !/^\s*needs:.*rust-wasi/m.test(jobs.go)) {
    problems.push('ci.yml: job "go" downloads the rust-wasi artifact but has no "needs: rust-wasi"');
  }

  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = checkWorkflow(process.cwd());
  for (const p of problems) console.error(p);
  process.exit(problems.length === 0 ? 0 : 1);
}
```

- [ ] **Step 4: Run the test to verify it now fails only on the real workflow**

Run: `node --test /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/scripts/check-ci-workflow.test.mjs`

Expected: FAIL on exactly one case — `the real workflow passes every rule`, reporting the missing
`concurrency` block, the `node` job's missing `npm run test:ci-check` step, and the missing jobs
`rust-native`, `rust-wasi`, `vectors`, `browser-spike`, `deny`. The thirteen fixture-based cases must all
pass.

- [ ] **Step 5: Add the workflow-level blocks and the five remaining jobs**

**NV-14 is resolved; do not re-open it.** facts-ci.md line 457 recorded `actions/upload-artifact@v4` as
"from memory (**unverified** this session)"; `gap-31-ci.md` §4 item 2 corrects it from the GitHub release
pages: the current majors are **`actions/upload-artifact@v7.0.1`** and
**`actions/download-artifact@v8.0.1`**, and they are deliberately out of step — "`upload@v7` pairs with
`download@v8`". The `with:` inputs are unchanged across the bump (`name`, `path`, `if-no-files-found` on
upload; `name`, `path` on download), which is why gap-31 §3.2's own reference job writes them exactly as
this job does. This task therefore writes `@v7` in the job, in `REQUIRED_STEPS['rust-wasi']` and in the
step 1 fixture, and **Plan B task 8 writes `@v8`** in the `go` job and in its `main_test.go` assertion —
the two halves move together in one change, which is what deviation B15 was holding out for.

In `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/.github/workflows/ci.yml`, insert
between the `on:` block and `jobs:`:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
env:
  CARGO_TERM_COLOR: always
```

Then append these five jobs to the `jobs:` mapping, leaving `node`, `ui` and `rust-wasm-node` untouched:

```yaml
  rust-native:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: dtolnay/rust-toolchain@1.98.1
        with:
          components: clippy,rustfmt
      - uses: Swatinem/rust-cache@v2
        with:
          shared-key: rust-native
      - run: cargo fmt --all --check
      - run: cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
      - run: cargo test --workspace --all-features --locked

  rust-wasi:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: dtolnay/rust-toolchain@1.98.1
        with:
          targets: wasm32-wasip1
      - uses: Swatinem/rust-cache@v2
        with:
          shared-key: rust-wasm32-wasip1
      - run: cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked
      - uses: actions/upload-artifact@v7
        with:
          name: dilla-core-wasi
          path: target/wasm32-wasip1/release/dilla_core_wasi.wasm
          if-no-files-found: error

  vectors:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run vectors
      - run: git diff --exit-code -- protocol/vectors
      - run: test -z "$(git status --porcelain -- protocol/vectors)"
      - uses: dtolnay/rust-toolchain@1.98.1
      - uses: Swatinem/rust-cache@v2
        with:
          shared-key: rust-native
      - run: cargo run -p dilla-testkit --bin dilla-testkit --locked -- vectors

  browser-spike:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: dtolnay/rust-toolchain@1.98.1
        with:
          targets: wasm32-unknown-unknown
      - uses: Swatinem/rust-cache@v2
        with:
          shared-key: rust-wasm32-unknown-unknown
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: npm
      - uses: taiki-e/install-action@v2
        with:
          tool: wasm-pack@0.15.0,wasm-bindgen@0.2.128
      - run: wasm-pack build core/dilla-core-wasm --target web --release --mode no-install --out-dir spike/pkg
      - run: npm ci
      # Deviation A2-6: the persistence matrix asserts Firefox private-browsing and WebKit
      # ephemeral behaviour, so those engines must be installed too.
      - run: npx playwright install --with-deps chromium firefox webkit
      # Only the matrix script: it already runs the chromium project, so adding `test:e2e` here would
      # execute the 10-hand-over test twice per run and rewrite opfs-leader-metrics.json for nothing.
      - run: npm run test:e2e:matrix -w @dilla/e2e

  deny:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: dtolnay/rust-toolchain@1.98.1
      - uses: taiki-e/install-action@v2
        with:
          tool: cargo-deny@0.20.2
      - run: cargo deny --all-features check advisories bans licenses sources
```

- [ ] **Step 6: Wire the checker into the root scripts**

In `/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/package.json`, add to `scripts`:

```json
    "check:ci": "node scripts/check-ci-workflow.mjs",
    "test:ci-check": "node --test scripts/check-ci-workflow.test.mjs"
```

and extend the existing `"test"` script so the gate runs in the `node` job, which already invokes it:

```json
    "test": "npm run check:docs && npm run check:brief && npm run check:copy && npm run check:ci && npm test --workspaces --if-present",
```

Then add the checker's **own tests** to the `node` job in
`/home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/.github/workflows/ci.yml`, immediately
after the existing `- run: npm run test:copy-check` line:

```yaml
      - run: npm run test:ci-check
```

This is the repository's established pattern — every `scripts/check-*.mjs` gate has a dedicated step in the
`node` job (`test:docs-check`, `test:brief-check`, `test:copy-check`). Without it the nine‑plus tests that
keep `check-ci-workflow.mjs` honest would run only on a developer's machine, and the gate that enforces R22
would be the one gate nothing tests in CI. `REQUIRED_STEPS.node` in step 3 makes the omission self-detecting.
This is the only change task 19 makes to the `node` job.

- [ ] **Step 7: Run the checker and the test to verify they pass**

Run: `node --test /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/scripts/check-ci-workflow.test.mjs`

Expected: PASS — 14 passed, including `the real workflow passes every rule`.

Run: `npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run check:ci`

Expected: PASS, no output, exit 0.

- [ ] **Step 8: Prove each gate actually fails, one at a time, and undo each break**

Each of these must be done, observed and then reverted before the next; that is the only way the "fail
closed" claim is evidence rather than assertion.

1. `cargo fmt`. Append a badly formatted line to `core/dilla-core-wasi/src/handles.rs`:
   `pub fn  formatting_canary( ) ->u8{0}`

   Run: `/home/thim/.cargo/bin/cargo fmt --all --check --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

   Expected: FAIL with a diff naming `handles.rs`. Remove the line and re-run; expected PASS.

2. The vector gate, generator side. Change one hex character in the `"cbor"` value of the first case of
   `protocol/vectors/envelope.json`.

   Run: `npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run vectors`

   Run: `git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol diff --exit-code -- protocol/vectors`

   Expected: FAIL, exit 1 — the generator rewrote the file. Restore with
   `git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol checkout -- protocol/vectors`.

3. The vector gate, Rust side. Make the same one-character change again, then run:

   `/home/thim/.cargo/bin/cargo run -p dilla-testkit --bin dilla-testkit --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml -- vectors`

   Expected: FAIL, exit 1, naming the suite, case and field. Restore as above. Both directions must fail:
   this is the gate that keeps the TypeScript generator and the Rust runner from drifting apart.

4. `cargo-deny` (NV-15). First settle where the flag goes:

   Run: `/home/thim/.cargo/bin/cargo deny --help`

   Expected: a usage line of the form `cargo deny [OPTIONS] <COMMAND>`. `--manifest-path` is a
   top-level option, so it is written **before** the subcommand; write it wherever this output puts
   it, and never rely on the shell's cwd — this harness resets it between calls.

   Then add to `core/dilla-core-wasi/Cargo.toml` a second major of a crate already in the graph,
   for example `thiserror = "1"` alongside the workspace's `2.0`, and run:

   `/home/thim/.cargo/bin/cargo deny --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml --all-features check bans`

   Expected: FAIL with `multiple versions for crate 'thiserror'`. Remove the line, then run:

   `/home/thim/.cargo/bin/cargo deny --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml --all-features check advisories bans licenses sources`

   Expected: PASS.

5. The workflow checker. Append ` || true` to any `run:` line in `ci.yml`, run `npm --prefix … run check:ci`,
   expect FAIL naming the line number, then revert.

- [ ] **Step 9: Confirm the wasi artifact path the Go job will download**

Run: `ls -l /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/target/wasm32-wasip1/release/dilla_core_wasi.wasm`

Expected: the file exists (task 14 step 15 built it). This is the exact `path:` in the `rust-wasi` job, and
Plan B task 8 downloads the artifact `dilla-core-wasi` into `internal/mlswasi/testdata`. `if-no-files-found:
error` makes a silent path change fail the upload rather than hand Plan B an empty directory, and step 3's
`REQUIRED_STEPS['rust-wasi']` now names all three `with:` lines so that claim is enforced.

Run: `grep -n '^  go:' /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/.github/workflows/ci.yml`

If this prints a line, Plan B landed first. `actions/download-artifact@v8` fetches from the same workflow
run, so GitHub schedules `go` after `rust-wasi` only when a `needs:` says so, and Plan B task 8 states that
whichever plan lands second adds the edge — that is this task. Insert `needs: rust-wasi` into the `go` job
now, directly under its `runs-on:` line, and re-run:

Run: `npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run check:ci`

Expected: PASS, no output, exit 0. If the grep printed nothing, Plan B has not landed and `checkWorkflow`'s
`go` rule will catch it when it does.

- [ ] **Step 10: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add .github/workflows/ci.yml scripts/check-ci-workflow.mjs scripts/check-ci-workflow.test.mjs package.json && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'ci: add the cargo, wasm32 and browser-spike jobs with fail-closed vector gates'
```

---

### Task 20: Browser spike report

**Files:**
- Create: `docs/spikes/2026-09-browser.md`
- Test: a grep-based placeholder scan plus a required-headings check, both run as commands in this task; the numbers themselves come from tasks 17 and 18 and from the two size measurements in step 2.

**Interfaces:**
- Consumes: `e2e/test-results/opfs-leader-metrics.json` (task 18 step 6), the `chromium`/`firefox`/`webkit` matrix results (task 18 step 5), and the two wasm artefacts built in tasks 15 and 17.
- Produces: `docs/spikes/2026-09-browser.md` — the W1 record of the browser store decision.

- [ ] **Step 1: Collect the measured numbers**

Run: `cat /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/e2e/test-results/opfs-leader-metrics.json`

Expected: the JSON written by task 18. Copy `handovers`, `attempts.min`, `attempts.max`, `grantMs.min`,
`grantMs.p50`, `grantMs.max`, `elapsedMs.min`, `elapsedMs.p50` and `elapsedMs.max` into step 3's table
verbatim — no rounding beyond whole milliseconds and no numbers from anywhere else. `grantMs` is the
lock-release latency interfaces §6 task 20 asks for (leader killed → successor elected); `elapsedMs` is how
long reopening the store took once the lock was already held. No vendor publishes a bound for either
(gap-14 §0), so this run is the only source that exists.

Run: `npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run test:e2e:matrix -w @dilla/e2e`

Expected: PASS. Record, per project, the `mode` and `reason` the assertions pinned.

- [ ] **Step 2: Measure the bundle before and after wasm-opt**

Run: `/home/thim/.cargo/bin/cargo build -p dilla-core-wasm --target wasm32-unknown-unknown --release --locked --manifest-path /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/Cargo.toml`

Expected: PASS.

Run: `ls -l /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/target/wasm32-unknown-unknown/release/dilla_core_wasm.wasm`

Expected: a byte count. This is the raw rustc output, before `wasm-bindgen` and before `wasm-opt`.

Run: `/home/thim/.cargo/bin/wasm-bindgen --version`

Expected: `wasm-bindgen 0.2.128` — the exact version of the `wasm-bindgen` crate in `Cargo.lock`.
`--mode no-install` means "don't install tools like `wasm-bindgen`, just use the global environment's
existing versions" (facts-ci §1.6), and wasm-pack resolves the CLI with `which("wasm-bindgen")`, not with the
absolute path this plan otherwise uses everywhere. R4 installs rustup with `--no-modify-path`, so
`~/.cargo/bin` is not necessarily on this shell's PATH and the `which` would fail with "wasm-bindgen not
found". The next command therefore uses the documented PATH prepend R4 allows, written out in full: the
login shell here is fish, where `$PATH` is a list and `PATH=/home/thim/.cargo/bin:$PATH` would expand to
several arguments instead of one, so the whole search path is spelled literally.

Run: `env PATH=/home/thim/.cargo/bin:/usr/local/bin:/usr/bin:/bin /home/thim/.cargo/bin/wasm-pack build /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasm --target web --release --mode no-install --out-dir spike/pkg`

Expected: PASS. wasm-pack's release profile runs `wasm-opt -O` and downloads its own pinned binaryen
`version_117`, because no `wasm-opt` is installed on this box (facts-ci §1.7, facts-local-toolchain).

Run: `ls -l /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/core/dilla-core-wasm/spike/pkg/dilla_core_wasm_bg.wasm`

Expected: a smaller byte count. Record both, and record that the reduction is the combined effect of
`wasm-bindgen` and `wasm-opt -O`, not of `wasm-opt` alone — the two cannot be separated without disabling
wasm-opt in `[package.metadata.wasm-pack.profile.release]`, which this spike does not do.

- [ ] **Step 3: Write the report**

Create `docs/spikes/2026-09-browser.md`:

```markdown
# Browser store spike — OPFS, Web Locks and SQLite3 Multiple Ciphers

Date: 2026-09-23. Week 1. Scope: can the browser tier keep an **encrypted** SQLite database in OPFS,
elect one writer across tabs, and degrade honestly where OPFS is unavailable?

**Verdict: yes on Chromium, with an in-memory fallback that is required rather than defensive.**
Two of the three engines refuse OPFS in private browsing outright, and the third gives a volatile
filesystem that looks persistent.

## What was built

- `core/dilla-core-wasm` — the wasm-bindgen surface, including `store_open`, `probe_persistence`
  and `is_sah_contention`.
- `core/dilla-core-wasm/spike/` — a Vite app whose dedicated worker runs the probe, takes the Web
  Lock and opens the store.
- `e2e/` — `@dilla/e2e`, a Playwright suite over Chromium, Firefox and WebKit.

## The three findings that change the design

### 1. The VFS name is load-bearing

The pool installs under `opfs-sahpool` with `default_vfs = false`, and the connection is opened on
**`multipleciphers-opfs-sahpool`**, the wrapper sqlite3mc creates lazily. Opening the plain name and
then keying it fails with exactly:

    Setting key failed. Encryption is not supported by the VFS.

The spike asserts that message on every run (`unencrypted_vfs_probe`), so the trap cannot come back
unnoticed. Making the pool the SQLite default would displace the sqlite3mc-wrapped default and break
keying the same way.

### 2. `PRAGMA key` never reports a wrong key

The open sequence is `PRAGMA cipher = 'chacha20'` → `PRAGMA key = 'raw:<64 hex>'` →
`SELECT count(*) FROM sqlite_schema`. The **SELECT** is the key check; the pragmas always report ok.
Cipher is ChaCha20-Poly1305 (the sqleet scheme), sqlite3mc's compile-time default, in non-legacy
mode.

### 3. The browser file is not portable to the native tier

The browser store is SQLite3 Multiple Ciphers `chacha20`; the native store is SQLCipher 4.14.0.
The two on-disk formats are **not interchangeable in either direction**, even with
`PRAGMA cipher = 'sqlcipher'` — the vendor documents this. Migration between tiers is a re-sync
through the delivery service, never a file copy. Nothing in dilla may assume otherwise.

## Leadership hand-over, measured

One exclusive Web Lock named `dilla-core:<instance>` per instance. The lock is released on agent
teardown with no lease, no TTL and no heartbeat, so a killed tab hands over without a timer. No
vendor publishes a bound on that latency; the numbers below are this spike's measurement on the dev
box (16 cores, 30 GB, Chromium via Playwright), over 10 consecutive hand-overs.

| Metric | Value |
|---|---|
| Hand-overs sampled | (from opfs-leader-metrics.json: handovers) |
| `store_open` attempts, min | (from opfs-leader-metrics.json: attempts.min) |
| `store_open` attempts, max | (from opfs-leader-metrics.json: attempts.max) |
| Lock-release latency, min | (from opfs-leader-metrics.json: grantMs.min) ms |
| Lock-release latency, p50 | (from opfs-leader-metrics.json: grantMs.p50) ms |
| Lock-release latency, max | (from opfs-leader-metrics.json: grantMs.max) ms |
| Time to reopen the store, min | (from opfs-leader-metrics.json: elapsedMs.min) ms |
| Time to reopen the store, p50 | (from opfs-leader-metrics.json: elapsedMs.p50) ms |
| Time to reopen the store, max | (from opfs-leader-metrics.json: elapsedMs.max) ms |
| Retry budget | 6 attempts at 300/600/900/1200/1500 ms, ~4.5 s cumulative |

Lock-release latency is measured from `leader.close()` to the successor reporting `role = leader`; time to
reopen is measured inside `openWithRetry`, after the lock has been granted. They are different numbers and
the report keeps them apart.

The retry loop is the application's job: neither `sqlite-wasm-vfs` nor SQLite upstream's own VFS
sleeps or backs off on contention. The schedule above is SQLite upstream's own for the identical
contention. A **first failure is expected and self-healing** — a predecessor parked in BFCache is
evicted by the successor's first `install()`, so a one-shot open would leave dilla permanently
read-only in an ordinary navigation. Contention is recognised by DOMException `name` —
`NoModificationAllowedError`, or `DOMException` whose message starts `Access Handles cannot`, which
is a documented Chromium `name` inconsistency — never by the error's Display string.

Resignation order is fixed: close the connection → `pause_vfs()` → post `leader-resigned` → release
the Web Lock. `pause_vfs()` errors while any file handle is open, and the pinned `sqlite-wasm-vfs`
0.2.0 has no typed `Busy` variant to tell that apart from a real OPFS failure.

The pinned pair is `sqlite-wasm-rs 0.5.5` + `sqlite-wasm-vfs 0.2.0`, which `rusqlite 0.40.2` caps.
0.2.0 writes **no `.lock` file**, so the Web Lock is load-bearing for correctness, not just for
politeness: two workers racing on a cold origin can otherwise each initialise a disjoint pool.

## Engine matrix

| Engine | `probe_persistence()` | App behaviour |
|---|---|---|
| Chromium (normal) | `{"mode":"opfs"}` | encrypted store, survives reload |
| Chromium (incognito) | `{"mode":"opfs"}` — **and still loses everything** | caught by the boot marker, not the probe |
| Firefox (private browsing) | `{"mode":"memory","reason":"getDirectory:SecurityError"}` | boots, banner shown, messaging works |
| WebKit (ephemeral context) | `{"mode":"memory","reason":"getDirectory:UnknownError"}` | boots, banner shown, messaging works |

Presence checks are useless here: in both failing engines the whole API surface exists and only the
call fails. The probe is therefore functional, runs in the dedicated worker **before** `install()`,
and removes its own probe file. In memory mode `install()` is never called, so no `.opfs-sahpool`
directory is created.

Chrome incognito is the case the probe cannot see, so the app also writes a boot marker into the
store and remembers the visit outside it; a visit with the marker gone reports "Storage was cleared
since your last visit." Banner copy names the **effect**, never the browser mode: the identical
`SecurityError` fires in a normal Firefox window with site storage blocked.

## Bundle size

| Artefact | Bytes |
|---|---|
| `target/wasm32-unknown-unknown/release/dilla_core_wasm.wasm` (raw rustc) | (from step 2: ls -l of the raw artefact) |
| `core/dilla-core-wasm/spike/pkg/dilla_core_wasm_bg.wasm` (wasm-bindgen + `wasm-opt -O`) | (from step 2: ls -l of the packed artefact) |

wasm-pack downloads its own pinned binaryen (`version_117`); no `wasm-opt` is installed on the dev
box. The two stages cannot be separated without disabling wasm-opt in the crate's wasm-pack
metadata, which this spike does not do.

## What is still open

- The `multipleciphers-opfs-sahpool` combination has no upstream test anywhere; this spike is its
  first execution. Every later change to the pinned pair must re-run `@dilla/e2e`.
- `initial_capacity` is 12 slots, chosen to hold one database plus its journal and WAL. No
  measurement yet says what a real dilla store needs; revisit when the schema lands.
- OPFS eviction in a normal window is not covered here. Safari deletes origin storage after a period
  of inactivity, which the boot marker reports but nothing yet prevents.
```

Every measurement placeholder in the template above is written in the single form `(from …)` — there is no
second spelling — so step 4's one grep catches all of them. Replace each with the measured number before
saving.

- [ ] **Step 4: Assert the report has no placeholders and no unfilled measurements**

Run: `grep -nE '\b(TBD|TODO|FIXME|XXX)\b' /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/docs/spikes/2026-09-browser.md`

Expected: no output, exit 1.

Run: `grep -nE '\(from ' /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/docs/spikes/2026-09-browser.md`

Expected: no output, exit 1 — every measurement placeholder has been replaced with a real number.

Run: `grep -cE '^\| (Lock-release latency|Time to reopen the store), (min|p50|max) \| [0-9]+ ms \|$' /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/docs/spikes/2026-09-browser.md`

Expected: `6` — a positive assertion that all six latency rows now hold a bare integer and a unit, so an
edit that deleted a row or left prose in a cell fails here rather than shipping.

Run: `grep -cE '^\| (Hand-overs sampled|`store_open` attempts, (min|max)) \| [0-9]+ \|$' /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/docs/spikes/2026-09-browser.md`

Expected: `3`.

Run: `grep -c 'not interchangeable in either direction' /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/docs/spikes/2026-09-browser.md`

Expected: `1` — the non-portability statement is explicit, as the task requires.

Run: `grep -c 'Setting key failed. Encryption is not supported by the VFS.' /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/docs/spikes/2026-09-browser.md`

Expected: `1`.

Run: `npm --prefix /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol run check:docs`

Expected: PASS. (`check-protocol-docs.mjs` scans `protocol/` only, so this confirms the spike report did not
disturb the normative documents; the greps above are this report's own gate.)

- [ ] **Step 5: Commit**

```bash
git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol add docs/spikes/2026-09-browser.md && git -C /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol commit -s -m 'docs(spikes): record the browser OPFS, Web Locks and sqlite3mc findings'
```

---

## Follow-up cards (not in this plan)

Nine items that this plan's execution produces or exposes but deliberately does **not** do. Each names
why it exists and which plan owns it. None of them blocks a task in this plan; they are here so that no
task invents one of them on the way past. The same list appears in
`docs/superpowers/plans/2026-09-23-dillad-spikes.md`, so a reader of either file sees the whole set.

- **(a) Regenerate `testkit/fixtures/ds-1500/` before its KeyPackages expire, around 2026-12-22.** Task 13
  commits real `.mls` binaries whose 1,500 leaves each carry the 90-day `KEY_PACKAGE_LIFETIME_DAYS`
  lifetime (part A1 item 19), and the manifest's `not_after` is derived from that constant; after that
  date every test that
  loads the fixture fails on validation rather than on the thing it tests. The regeneration is a re-run of
  `dilla-testkit gen-public-group --leaves 1500`, so the card is small — but nothing schedules it. Consider
  a CI check that fails 14 days before `not_after`, which turns a silent expiry into a warning with two
  weeks of slack. **Owner: dilla-core** (task 13 produces the fixture and the generator).
- **(b) Reconcile the delivery-service error vocabulary.** `protocol/02-delivery-service.md` states its
  refusals as HTTP-style reasons while `protocol/01` and `protocol/04` publish `E_*` strings; the two
  never map onto each other in writing, so a client cannot be written against one and tested against the
  other. **Owner: dilla-protocol.**
- **(c) Media error codes for `protocol/05-media-frames.md`.** Document 05 publishes no codes of its own,
  so task 6 borrows `E_UNSUPPORTED_VERSION` — protocol/01's *group version* code — for `Ctr::new`'s
  out-of-range layer and exhausted sequence and for `decode_header`'s truncated header (part A1 item 21). Until 05
  gains its own codes, no DS or client behaviour may be keyed on what those three return. **Owner:
  dilla-protocol**, through `protocol/07-versioning.md`'s change process.
- **(d) A `verify_strict`-distinguishing signature vector in `packages/protocol-vectors`.** gap-10 §4
  requires `verify_strict` and task 4 uses it, but no vector in this repository carries a signature that
  plain `verify` accepts and `verify_strict` refuses — a small-order public key with a signature crafted
  for it (part A1 item 20). Task 4's test is therefore named for what it actually covers and claims nothing more.
  **Owner: dilla-protocol.**
- **(e) Measure the delivery service's reordering window and replace `PAST_EPOCHS_TEXT = 16`.** The 16 is a
  plan decision, not a verified number (part A1 item 14): protocol/01's 300-second retention window cannot
  be converted into an epoch count without the DS's worst-case reordering window, and nothing in week 1
  measures it. Once a real DS exists the constant becomes a derived value. **Owner: the dillad plan**, W5;
  the one-line change lands in `dilla-core`'s `mls::policy`.
- **(f) Tighten the wazero gate towards gap-18's derived p99 ≤ 100 ms for a 256-Add commit.** R10's week-1
  thresholds (p50 ≤ 1 s per commit, tree import ≤ 5 s, ≤ 512 MB resident) are deliberately loose, because
  week 1 has no DS to put them in context. gap-18 derives a much tighter target from the join-storm
  scenario. That is a **W5 target, not a week-1 no-go criterion**: do not retrofit it onto Plan B task 5's
  gate. **Owner: the dillad plan.**
- **(g) The W1 card "dillad skeleton (auth, devices, schema, gateway)" gets its own plan.** R21 scopes
  Plan B to "Go module + wazero host + LiveKit in-process + FTS5", so the card has no task in either
  plan — by ruling, not by oversight (Plan B records the same gap in "Out of scope, recorded on purpose").
  **Owner: the dillad plan**, which does not exist yet and must before W2.
- **(h) A browser-store fallback if sqlite3mc does not attach to the OPFS sahpool VFS.** NV-10: task 17 is
  the first execution anywhere of that combination (gap-13 §6). If it fails, the browser store falls back
  to application-level AES-256-GCM of row payloads under the device KEK — the database file stays plain and
  dilla encrypts what goes into it. **The spike records the outcome and is not blocked by it**; task 17
  finishes either way and task 20's report states which branch happened. **Owner: the web-client plan.**
- **(i) Distinct error codes for malformed recovery key / pairing payloads and for member-originated
  `Add` / `PreSharedKey`.** Part A1 item 16: `protocol/03-identity.md` defines no code for a malformed
  recovery key, pairing QR or pairing payload, so task 4 maps all three to `E_CREDENTIAL`. Part A1
  item 24: `protocol/01-groups.md`
  states the member-originated-`Add` and `PreSharedKey` rules in prose but its published list of six `E_*`
  strings names neither, so task 10 returns `E_MEMBER_REMOVE_FORBIDDEN` and says so at both call sites. The
  **rejections** are what week 1 relies on; only the codes are open. **Owner: dilla-protocol**, as
  `protocol/07-versioning.md` change-process items.

## Needs verification (part A1)

Every item below is used by a step above and is **not** traceable to a facts file, a gap file or the
repository. Each names the task and the line that depends on it. None is a guess presented as a
fact: the task that uses it opens with a step that reads the real signature and corrects the code.

1. **`minicbor 2.3.0`'s `Encoder`/`Decoder` method names** — never read (gap-27 §8). Resolved by
   deviation A1-1: the dependency is dropped and §2.3 is implemented directly over `&[u8]`, so
   nothing in this plan depends on the answer any more.
2. **`ed25519_dalek::Signature::from_bytes(&[u8; 64])`** (task 4, `verify_signatures` and
   `DeviceList::verify`) — gap-10 §4 lists `SigningKey` and `VerifyingKey` methods but not
   `Signature`'s constructor, and does not say whether it is infallible in 2.2.
3. **Node's WebCrypto `"Ed25519"` algorithm name and PKCS#8 import path** (task 7) — task 7 step 3
   probes the runtime and stops if it is absent. The 16-byte PKCS#8 prefix is a standard DER
   encoding, not a dilla invention, but it was not read from a source in this plan's inputs.
4. **48 of the 53 `StorageProvider` method signatures** (task 9) — `facts-openmls.md` §2.5 gives 5
   verbatim, gap-1 §2 gives 16 more through the public subset. The remaining 32 follow the same
   per-entity shape; task 9 step 1 prints the trait and requires the generated list to match.
5. **`Lifetime::new(seconds)`** (task 10, `build_key_package`) — `facts-openmls.md` §5 names
   `key_package_lifetime(Lifetime)` but not `Lifetime`'s constructor or its unit.
6. **`LeafNodeParameters::default()` and the `CommitMessageBundle` destructuring**
   (task 10, `DillaGroup::self_update`) — `self_update` returns `CommitMessageBundle`
   (facts-openmls §4.4) and no accessor of that type was recorded. `into_contents()` is written as
   the three-component destructuring that matches `add_members`' 3-tuple; task 10 step 1 confirms
   or corrects it.
7. **`MlsGroup::set_aad`** (task 10, `DillaGroup::create_message`) — the name is in the 0.9.0 method
   index but its argument type and whether it persists across calls were never read. The franking
   commitment must reach `authenticated_data`, so this is load-bearing.
8. **`EpochAuthenticator::as_slice()`** (task 10, `DillaGroup::epoch_authenticator`) —
   `epoch_authenticator()` returns `&EpochAuthenticator`; the accessor that yields its 32 bytes was
   not recorded.
9. **`KeyPackage::leaf_node()`** (task 10 `device_of`, task 11 `validate_key_package`) — needed to
   read a KeyPackage's capabilities and credential.
10. **`QueuedProposal::proposal_reference()`** (task 11, `process_message` and `add_proposal`) —
    `PublicGroup::add_proposal` returns `Result<(), Storage::Error>`, so the reference has to come
    off the proposal itself, and no accessor was recorded.
11. **`half`'s SPDX licence** (task 1, `deny.toml`) — `half` is a transitive dependency of
    `ciborium-ll` and no facts file records its licence. Task 1 step 12 runs `cargo deny` and adds
    exactly the identifier it names, with a comment, rather than widening the allow list in advance.
12. **`clap 4` and `rand_chacha 0.3` exact patch versions** (task 1) — chosen by this plan, not
    pinned by any facts file (§3.4's own [NV]). Task 1 step 9 records what `Cargo.lock` resolved.
13. **`prometheus/client_golang`** — Plan B's [NV], not this part's.
14. **`PAST_EPOCHS_TEXT = 16`** (task 10) — a plan decision, **not** a verified number. The
    protocol's 300-second window cannot be converted into an epoch count without the DS's
    worst-case reordering window, which nothing measures in week 1. The code says so in a doc
    comment.
15. **Whether `E0119` reproduces against `openmls_traits 0.6.0`** (task 9) — gap-1 §8 verified it
    against a faithful reproduction under `rustc 1.98.1`, not against openmls itself. Task 9 step 7
    pins it with `trybuild` and states what to do if it does not reproduce. Nothing in this plan
    depends on the answer: `DillaStorage` and `PublicStore` are separate types either way.
16. **`protocol/03-identity.md` defines no error code for a malformed recovery key, pairing QR or
    pairing payload** (task 4). The plan maps all three to `E_CREDENTIAL`, document 03's generic
    identity-material rejection, and flags it: if a maintainer wants a distinct code, it is a
    `protocol/07-versioning.md` change, not a code change.
17. **`identity.json`'s new shape is a change to a normative file** (task 7) — **resolved by the
    maintainer's ruling.** Adding a `## Vectors` section to `protocol/03-identity.md`, which has none
    today, and replacing the filler signatures with real ones is **not** a version bump: the identity
    chain is unfrozen until the end of W3 under the spec's freeze rule, "formats freeze one week
    after their end-to-end scenario passes"
    (`docs/superpowers/specs/2026-09-23-dilla-design.md:637`, with the credential chain's scenario
    dated end of W3 at line 408), so `protocol/07-versioning.md`'s change process does not bind this
    file yet. Task 7 records the ruling in its **commit body** rather than arguing it in the pull
    request.
18. **OpenMLS accessor methods used by the tests, none of them read from a source in this plan's
    inputs.** Each is asserted in a test, so a wrong name is a compile error on the first run, not a
    silent wrong answer — but they are guesses about spelling, not about behaviour, and the task
    that uses them should fix them from the vendored source alongside its own step 1:
    `Extensions::required_capabilities()` and `Extensions::external_senders()` (task 10 config
    tests); `MlsGroupCreateConfig::ciphersuite()` and `::join_config()`, and
    `MlsGroupJoinConfig::padding_size()`, `::use_ratchet_tree_extension()`, `::wire_format_policy()`
    (task 10 config test); `GroupEpoch::as_u64()`, `LeafNodeIndex::new()` and `LeafNodeIndex::u32()`
    (tasks 10, 11, 13); `ProposalStore::new()` (task 11 `from_external`); the field names `index`,
    `credential` and `signature_key` on the `Member` that `PublicGroup::members()` yields (task 11
    `members`); and `Credential`/`LeafNode::credential()` (task 10 `user_of_credential`,
    `own_user`, task 11 `members`). Where any of these does not exist, use
    `tls_serialize_detached` plus `MlsMessageIn::tls_deserialize_exact` — the round trip the testkit
    already uses — rather than inventing a conversion.

    `From<MlsMessageOut> for MlsMessageIn` and `MlsMessageOut::into_welcome()` were on this list and
    are **no longer used anywhere**: tasks 10 and 11 go through `into_protocol` / `into_group_info` /
    `into_welcome`, the `tls_serialize_detached` + `MlsMessageIn::tls_deserialize_exact` round trip,
    which is also what a real peer does with the bytes. (facts-openmls §4.5 records
    `MlsMessageIn::into_welcome` as `test-utils`-gated, so the conversion may not have existed at
    all.)
19. **The `.mls` and `.bin` fixture files under `testkit/fixtures/ds-1500/`** (task 13) are
    committed binaries that **expire around 2026-12-22**. R10 requires committing them; every leaf
    carries the 90-day `KEY_PACKAGE_LIFETIME_DAYS` lifetime `build_key_package` sets (gap-18 §0
    item 10's 84 days is OpenMLS's default, which this plan overrides), the manifest's `not_after`
    is derived from that constant and the explicit test message is the mitigation, and no card yet
    covers the regeneration.
20. **A `verify_strict`-only rejection case** (task 4). `gap-10-openmls.md` §4 requires
    `verify_strict`, and the plan uses it, but no vector in this repository carries a signature
    that plain `verify` accepts and `verify_strict` refuses — a small-order public key with a
    signature crafted for it. Task 4's test is therefore named for what it covers (an all-zero
    public key is rejected) and does **not** claim to distinguish the two functions. Producing such
    a case is a `packages/protocol-vectors` change.
21. **protocol/05-media-frames.md assigns no error codes** (task 6). `Ctr::new`'s out-of-range
    layer and exhausted sequence, and `decode_header`'s truncated header, all return
    `E_UNSUPPORTED_VERSION` — protocol/01's *group version* code — because document 05 publishes
    none of its own. Either 05 gains media codes through protocol/07-versioning.md's change
    process, or the three cases move to a non-wire `sframe::SframeError`. Until then no DS or
    client behaviour may be keyed on the code these three return.
22. **Whether the 24 marker traits of `openmls_traits::storage::traits` have blanket impls**
    (task 9). `facts-openmls.md` §2.4 records only that "OpenMLS implements `Key`/`Entity` for its
    own types". The tests therefore use local newtypes (`mls::test_entities`), which is correct
    either way; task 9 step 1 greps the vendored source and records the answer in the commit body.
    The same step pins the **order of each method's generic parameters**, which rustc matches
    positionally: `group_state`, `psk` and `encryption_key_pair` are written value-type-first on a
    report, not on a verified source, and a wrong order is `error[E0276]`.
23. **`Sender::NewMemberCommit`** (task 10 `validate_staged_commit`). RFC 9420 names the sender
    type; the exact variant spelling in `openmls 0.9.0` was not read from a source. It is the only
    correct way to recognise an external commit, and a wrong spelling is a compile error on the
    first run rather than a silent wrong answer.
24. **protocol/01-groups.md assigns no code to a member-originated `Add` or `PreSharedKey`**
    (task 10 `validate_staged_commit`). The document states both rules in prose but its published
    list is the six `E_*` strings at line 122, none of which names them; the plan returns
    `E_MEMBER_REMOVE_FORBIDDEN` and says so in a comment at both call sites. The **rejection** is
    what week 1 relies on. Giving these rules their own code is a protocol/07-versioning.md change,
    and a maintainer decides it.

## Needs verification (part A2)

Each of these is also a numbered step inside the task that first needs it; none is assumed.

- **NV-1 (task 14).** The `tls_codec 0.5.0` entry points for turning a byte slice into `MlsMessageIn` and `RatchetTreeIn`, and a `MlsMessageOut` / `GroupInfo` / `RatchetTree` back into bytes. No facts file records whether these are `Deserialize::tls_deserialize_exact`, `DeserializeBytes::tls_deserialize_exact_bytes` or `tls_deserialize_bytes`. All of them are confined to `abi::tls`.
- **NV-2 (task 14).** Whether the DS-facing `group_info` bytes are a bare TLS `GroupInfo` or an `MLSMessage` wrapping one. `protocol/02-delivery-service.md` does not say, and `facts-openmls.md` §4.7 shows `export_group_info` returning `MlsMessageOut`. Task 14 step 1 settles it against `protocol/02` and records the answer in `abi::tls`'s doc comment.
- **NV-3 (task 14).** `GroupId::from_slice` / `GroupId::as_slice`, `GroupEpoch::from(u64)`, `LeafNodeIndex::new(u32)`, `KeyPackage::leaf_node()`, `LeafNode::credential()`, the `last_resort` accessor and the `Lifetime` upper-bound accessor on OpenMLS 0.9.0. Names are conventional but none was read in a facts file. `BasicCredential::identity()` is **not** on this list: facts-openmls §7 records it verbatim as `pub fn identity(&self) -> &[u8]`, on `openmls::credentials::BasicCredential` (not on `openmls_basic_credential`, which exports only `SignatureKeyPair`).
- **NV-3b (task 14).** `ProposalRef::as_slice()`, `QueuedProposal::proposal()`, and whether `openmls::prelude::Proposal` implements `tls_codec::Serialize` on 0.9.0. None of the three appears in facts-openmls, gap-1 or gap-16, and gap-16 §2's derive table does **not** list `Proposal` among the TLS-serialisable types. Same rule as NV-3: do not write a name step 1 did not confirm. Note that deviation A2-11 removes the need to serialise a bare `Proposal` at all — if `Proposal: tls_codec::Serialize` turns out not to exist, A2-11 is the reason nothing breaks.
- **NV-3c (task 14).** The byte layout `SignatureKeyPair::from_raw` expects for `SignatureScheme::ED25519` on `openmls_basic_credential 0.6.0`: a 32-byte seed, or the historical 64-byte seed‖public form. facts-openmls §7 records the signature (`from_raw(signature_scheme, private: Vec<u8>, public: Vec<u8>)`) but not the encoding, and gap-10 records nothing beyond `ed25519-dalek 2.2`. Resolve it by reading `openmls_rust_crypto 0.6.0`'s `OpenMlsCrypto::sign` before step 12. Getting this wrong makes every external Add/Remove proposal the DS signs silently malformed, so step 14 carries a unit test that signs one external proposal and verifies it end to end.
- **NV-4 (task 14, cross-task) — resolved by ruling: task 11 declares it.** Building a `QueuedProposal` from a received proposal message is **not** a helper the wasi crate can write: it needs the group context and signature verification, and no facts file records a public OpenMLS 0.9.0 route from bytes to `AuthenticatedContent`. A2 therefore does **not** write one. `public_group_proposal_put` op 0 routes through `DillaPublicGroup::queue_proposal(&mut self, crypto: &impl OpenMlsCrypto, message: ProtocolMessage) -> Result<Vec<u8>, PublicGroupError>`, and **Plan A task 11 step 4 now declares it**, so the framing and verification stay inside `dilla-core`. Deviation A2-11 rides on the same method and is settled with it: `queue_proposal` keeps the original `MLSMessage` bytes with the queued proposal in the wrapper's own map, and `queued_proposals()` yields `Vec<(ProposalRef, Vec<u8>)>` where the `Vec<u8>` is those bytes. Task 11's integration test `queue_proposal_keeps_the_mls_message_the_ds_received` queues an external Remove built by `external_propose_remove` and asserts the bytes come back identical. Task 14 step 1 keeps a one-line `grep` that the method exists and otherwise just consumes it; nothing is blocked. What remains genuinely unread is the framing conversion `queue_proposal` uses internally — `impl From<ProtocolMessage> for MlsMessageIn` — which carries a `NEEDS VERIFICATION` comment and a vendored-source grep at the line that names it, in the pattern task 10 step 1 uses.
- **NV-5 (task 14, cross-part — owned by Plan A tasks 9, 10 and 11; verified present, 2026-09-23).** `dilla-core` must compile for `wasm32-wasip1`. §3.1 supplies rusqlite only under `cfg(not(target_arch = "wasm32"))` and `cfg(all(target_arch = "wasm32", target_os = "unknown"))`, so on wasip1 there is no SQLite at all, and four separate things follow. **All four are written into the owning tasks, and each owning task runs `cargo build -p dilla-core --target wasm32-wasip1` and expects PASS:**
  1. `mls::{provider, storage, tx}` are gated off wasip1 — **task 9 step 6**, on the private `mod provider; mod storage; mod tx;` declarations, not on a `pub mod` line that does not exist.
  2. `mls/mod.rs`'s `pub use provider::DillaProvider; pub use storage::{ConnHandle, DillaStorage}; pub use tx::TxError;` carry the identical gate — **task 9 step 6**, immediately beside (1), so they cannot become `E0432 unresolved import`.
  3. `mls::group` (every `DillaGroup` method takes `&DillaProvider`) and `mls::config::build_key_package(provider: &DillaProvider, …)` carry it too — **task 10 step 7**, which gates `mod config;` and `mod group;` and both `pub use` blocks.
  4. `public_group::external_propose_add` / `external_propose_remove` are instantiated with `openmls_rust_crypto::OpenMlsRustCrypto`, whose storage is never touched, **not** with `DillaProvider` as interfaces §2.8 writes them — **task 11 step 4**, with the reason in a doc comment. facts-wazero §6 records that all three `ExternalProposal` constructors are generic over `Provider` although only the signer is used, which is what makes that route sound. Without it, gating (1)–(3) would still leave exports 16 and 17 with no implementation on wasip1.

  The gate the three tasks actually write is `#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]` rather than this item's original `#[cfg(not(target_os = "wasi"))]`. The two are the same set over the three targets this workspace builds — native, `wasm32-unknown-unknown`, `wasm32-wasip1` — and the spelling used is the one that is character-for-character the condition of the two `rusqlite` dependency sections in `core/dilla-core/Cargo.toml`, so a change to either is visibly a change to both. Task 14 step 2 is now a check that references the owning tasks by number, not a stop.
- **NV-6 (task 15).** The web-sys 0.3.81 spelling of the dictionary setters (`FileSystemGetFileOptions::set_create` vs `.create(...)`) and of `WorkerNavigator::storage`.
- **NV-7 (task 15).** The `OpfsSAHError` variant that carries the sync-access-handle `JsValue` on `sqlite-wasm-vfs 0.2.0`. gap-11 §6 and gap-14 §0 both name `CreateSyncAccessHandle(JsValue)`; confirm it is spelled that way and whether the enum is `#[non_exhaustive]`.
- **NV-8 (task 16).** `wasm_bindgen_test_configure!(run_in_node_experimental)` is named by R6 but facts-ci §6 lists only `run_in_browser`, `run_in_dedicated_worker` and `run_in_service_worker` for wasm-bindgen-test 0.3.78. Node is already the runner's default, so if the identifier does not exist the line is simply omitted; the task checks and records which.
- **NV-9 (task 16, cross-task).** `cargo test -p dilla-core --target wasm32-unknown-unknown --features vectors` compiles `core/dilla-core/tests/*.rs` too. Plan A tasks 2, 9, 10, 11 must gate the integration tests that need a native SQLite file behind `#![cfg(not(target_arch = "wasm32"))]`. Task 16 step 2 is where that surfaces.
- **NV-10 (task 17).** That an encrypted database round-trips through `multipleciphers-opfs-sahpool` at all. gap-13 §6 records that **no upstream test anywhere combines sqlite3mc with the OPFS sahpool VFS**; task 17 is the first execution in the world. If it fails there is no fallback **in this plan** (interfaces §7 item 8) — but the decision is no longer open: follow-up card (h) below records it, the browser store falling back to application-level AES-256-GCM of row payloads under the device KEK, carried as a card in the web-client plan. Task 17 therefore records the outcome and is not blocked by it.
- **NV-11 (task 14).** A public conversion from `openmls::messages::GroupInfo` to bytes on OpenMLS 0.9.0 — `impl From<GroupInfo> for MlsMessageOut`, or another route. This cannot be assumed: gap-16 §2's derive table (read from the 0.9.0 tarball, `src/messages/group_info.rs:172-174`) records `GroupInfo` as `#[derive(Debug, PartialEq, Clone, TlsSize, SerdeSerialize, SerdeDeserialize)]` with `TlsDeserialize` only under `feature = "test-utils"` — it has **no `TlsSerialize`**. NV-2 settles only the framing choice (bare `GroupInfo` vs `MLSMessage`), not the existence of a conversion. If no public route exists, `public_group_create`'s sixth response element cannot be produced at all: stop and reconcile, exactly like NV-4, rather than writing code against a guessed `From` impl.
- **NV-12 (task 15).** Whether `wasm_bindgen::JsError` can be constructed on a **non-wasm** target and whether it implements `Debug`. wasm-bindgen's `externs!` intrinsics (`__wbindgen_error_new`) compile to stubs off wasm, and `Result::unwrap` on a `Result<_, JsError>` needs `JsError: Debug`. Read `https://docs.rs/wasm-bindgen/0.2.128/wasm_bindgen/struct.JsError.html` before writing step 3's native test module. If construction panics or `Debug` is absent, split the surface so the fallible logic lives in plain `fn`s returning `dilla_core::ProtocolError` and the `#[wasm_bindgen]` wrappers only map that to `JsError`; the native tests then target the inner functions and the wrappers stay covered by task 16's Node run. Step 3 already keeps every error-path assertion out of the native module for this reason.
- **NV-13 (task 15).** Whether wasm-bindgen 0.2.128 accepts a borrowed receiver on an exported `async fn` — `pub async fn reserve_capacity(&self, n: u32)` and `pub async fn resume(&self)` of interfaces §2.11 — since the generated future must be `'static`. Read `https://docs.rs/wasm-bindgen/0.2.128/wasm_bindgen/attr.wasm_bindgen.html` ("Support for async/await"). If `&self` is rejected, move both behind free functions taking the handle and record the deviation from §2.11. `reserve_capacity` is exercised for real — task 17's worker calls `reserve_capacity(16)` right after open and reports `capacity()`, and task 18 asserts the result. `resume()` is **not**: the week-1 spike only ever pauses, on the resign path, and never comes back, so `pause`/`resume` as a pair is first exercised by the browser client in W2. Say that in the task 15 commit message rather than implying coverage that does not exist.
- **NV-14 (task 19) — resolved.** The current major of `actions/upload-artifact` and of `actions/download-artifact`. facts-ci.md line 457 said plainly that `actions/upload-artifact@v4` was "from memory (**unverified** this session)" and line 485 listed its currency among the unverified items; `gap-31-ci.md` §4 item 2 read both release pages and corrects it: **`upload-artifact@v7.0.1`** and **`download-artifact@v8.0.1`**, different majors on purpose, "`upload@v7` pairs with `download@v8`". Task 19 now writes `@v7` in the `rust-wasi` job, in `REQUIRED_STEPS['rust-wasi']` and in the step 1 fixture; Plan B task 8 writes `@v8` in the `go` job and in its `main_test.go` assertion. The `with:` input names did not change across either bump. What gap-31 could **not** read is the release *year* of the two tags (GitHub omits the year for current-year releases and its API rate-limited that session), which does not affect the refs.
- **NV-15 (task 19).** The accepted ordering of `--manifest-path` on `cargo deny 0.20.2`: its usage is `cargo deny [OPTIONS] <COMMAND>`, and no facts file records whether the flag is marked `global`. Run `cargo deny --help` once at the top of step 8 and write the flag where that output puts it. Step 8 assumes option-before-subcommand.

## Assembly notes

This file was assembled from `scratchpad/planning/core/plan-A1.md` (tasks 0–13) and
`scratchpad/planning/core/plan-A2.md` (tasks 14–20). The task bodies are verbatim; the changes below
are the whole of what the assembler did.

1. **Task numbering is already continuous** — A1 ends at task 13 and A2 begins at task 14, so no
   renumbering was needed and no cross-reference was rewritten.
2. **A1's header, "Global Constraints" and "Deviations from the spec (verified)" are the assembled
   plan's**, as `plan-A1.md`'s own leading assembler comment instructs; A2 carried no header of its
   own. That comment block itself is dropped.
3. **Two sections were added by the assembler and appear in neither part:** "Rulings that bind this
   plan" (summarised from `rulings.md`, one row per ruling, naming the tasks it lands in) and
   "File structure" (derived from `interfaces.md` §1, filtered to the paths Plan A creates or
   modifies, with the task number that owns each one). Nothing in either section changes a task.
4. **Both "Interface deviations" tables now sit together in the front matter**, and both "Needs
   verification" sections together at the end, rather than A2's appearing between task 13 and
   task 14. No row's text changed.
5. **`Files:` bullets are repository-relative throughout.** Part A1's tasks 1–13 and part B already
   wrote them that way; A1 task 0 and every A2 task wrote absolute worktree paths in those bullets
   only. They were rewritten to the relative form, which is what `interfaces.md` §1 uses and what
   the two existing plans in `docs/superpowers/plans/` use. **Commands, `git add` arguments and
   every path inside a code block were left absolute**, as the drafting contract requires.
6. **One ruling is applied at a value other than its literal text**, and the header says so: R2
   writes workspace `rust-version = "1.91"`; this plan writes `"1.98"`, because `interfaces.md` §4.2
   — the binding contract both drafters worked from — fixes the root manifest at `"1.98"` and
   `rust-toolchain.toml` pins `1.98.1`, the verified stable on this box
   (`facts-local-toolchain.md`). `1.91.0` is only `openmls 0.9.0`'s MSRV floor. A maintainer who
   wants the ruling's literal value changes one line in the root `Cargo.toml` (task 1 step 3) and
   one line in Global Constraints.
7. **No naming drift was found between the two parts.** Every symbol A2 consumes from A1 —
   `dilla_core::cbor::{Encoder, Decoder, decode_strict, CborError}`, `ProtocolError::code`,
   `CredentialIdentity`, `DillaBinding`, `DillaPublicGroup`, `PublicProcessed`, `PublicStoreError`,
   `MemberInfo`, `validate_key_package`, `external_propose_add`, `external_propose_remove`,
   `vectors::run_all`, `ABI_VERSION`/`CORE_VERSION`/`E2EE_VERSION`/`MEDIA_VERSION` — is spelled
   identically in the task that produces it and in the task that consumes it, and matches
   `interfaces.md`. Nothing was renamed.
8. **Two cross-part items were left open by the assembler and are now closed by controller ruling
   (2026-09-23).** Both were design decisions, not assembly ones, which is why the assembler could
   not settle them:
   - **NV-4 / deviation A2-11 — resolved by ruling: task 11 declares it.** Task 14 needs
     `DillaPublicGroup::queue_proposal(&mut self, crypto, message) -> Result<Vec<u8>, PublicGroupError>`
     and a `queued_proposals()` that yields the received `MLSMessage` bytes. Task 11 as assembled had
     neither. Task 11 step 4 now declares `queue_proposal` — it validates through
     `PublicGroup::process_message`, stores through `PublicGroup::add_proposal`, keeps the original
     `MLSMessage` bytes in the wrapper's own map keyed by the proposal reference, and returns the
     reference bytes — and `queued_proposals()` returns `Vec<(ProposalRef, Vec<u8>)>`. Task 11
     step 1 gained the integration test
     `queue_proposal_keeps_the_mls_message_the_ds_received`, which queues an external Remove built by
     `external_propose_remove` and asserts the bytes come back identical. Task 14 step 1 keeps a
     one-line `grep` that the method exists and otherwise consumes the API; the stop at step 12 is
     gone.
   - **NV-5 — verified present, nothing added.** `dilla-core` must build for `wasm32-wasip1`, and
     all four gating changes were already written into their owning tasks: task 9 step 6 gates
     `mod provider; mod storage; mod tx;` **and** their three `pub use` lines, task 10 step 7 gates
     `mod config;` and `mod group;` and both `pub use` blocks (which is what takes
     `build_key_package` and every `DillaGroup` method off wasip1), and task 11 step 4 instantiates
     `external_propose_add` / `external_propose_remove` with `OpenMlsRustCrypto`. Each of those three
     tasks runs `cargo build -p dilla-core --target wasm32-wasip1` and expects PASS. The gate is
     spelled `#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]` — the same set as
     `#[cfg(not(target_os = "wasi"))]` over this workspace's three targets, and character-identical
     to the two `rusqlite` dependency conditions. Task 14 step 2 is now a check that names the owning
     task per point, not a stop.
9. **No placeholder was found or fixed.** A grep for `TBD`, `TODO`, `similar to Task`,
   `add appropriate`, `handle edge cases`, `fill in` and `implement later` returns four hits in this
   file's task bodies (plus this note's own restatement of the pattern list), all of them
   assertions rather than placeholders: task 7 step 8's statement that nothing
   under `protocol/` may contain `TBD` or `TODO`, and task 20 step 4's
   `grep -nE '\b(TBD|TODO|FIXME|XXX)\b'` gate that proves it. Both are load-bearing text.

