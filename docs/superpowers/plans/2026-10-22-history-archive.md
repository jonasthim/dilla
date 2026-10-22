# Message History for Your Own New Browsers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every browser of an account saves the messages it can read, sealed under keys from the recovery key, and a browser that signs in with the key restores that history; the server can never read it, deletes are honoured, and Settings → Privacy turns it off and deletes it.

**Architecture:** The Rust core derives the history keys from the recovery key, queues what to save with SQLite triggers on `app_messages`, seals batches with HPKE (X25519/HKDF-SHA256/AES-256-GCM) to a key pair whose private half exists only during a restore, and merges restored rows below the live floor through the same insert and fold path as received rows. `dillad` stores opaque rows under keyed ids with delete tokens, tombstones and a per-account generation. client-core runs the uploader and the restore runner in the worker; the web adds the Privacy section, the off flow, the sign-in and timeline copy and a banner for older browsers.

**Tech Stack:** Rust (OpenMLS 0.9 `openmls_traits` HPKE, rusqlite/SQLite triggers, wasm-bindgen), Go (net/http, sqlc on sqlite and Postgres, goose), TypeScript (React, vitest, Playwright), CBOR.

**Spec:** `docs/superpowers/specs/2026-10-22-history-archive-design.md` (approved at `3819394f`). Every `§` reference is to this spec; read the referenced section before writing the task's code. The spec holds the bulk detail (SQL, CBOR shapes, copy tables, protocol text, test assertions); the plan never repeats it.

## Global Constraints

- Migration `00024_history_archive.sql` and schema file `022_history_archive.sql`, on both engines; renumbering happens at rebase, after voice moderation and calls-survive-upgrade merge (D23).
- Keys from the recovery key, `HKDF-SHA256(salt = "", IKM = RK, info, L = 32)`: `"dilla history key v1"` (seed of the HPKE key pair), `"dilla history auth v1"` (`K_hauth`), `"dilla history id v1"` (`K_hid`), `"dilla history delete v1"` (`K_hdel`) (D1, §8.1).
- `entry_id = HMAC-SHA256(K_hid, "dilla history entry id v1" ‖ group_id ‖ seq_be8)[0..16]`; `del_token = HMAC-SHA256(K_hdel, "dilla history delete token v1" ‖ entry_id)[0..16]`; `del_hash = SHA-256("dilla history delete hash v1" ‖ del_token)[0..16]` (§8.1).
- HPKE base mode, suite `0x0020/0x0001/0x0002`, info `"dilla history v1" ‖ user_id`, exporter context `"dilla history batch v1"` (32 bytes); `K_batch = HKDF(salt = K_hauth, IKM = exported, info = "dilla history batch key v1")`; row AEAD AES-256-GCM, random 12-byte nonce, `aad = "dilla history entry v1" ‖ user_id ‖ entry_id` (§8.1).
- Entry plaintext is the 12-element CBOR of §8.2, padded with zero bytes to a multiple of 256; a row is `[1, enc(32), nonce(12), ciphertext(≥16)]`, at most 81 920 bytes; at most 512 rows per upload (D19, §8.2).
- The read key `SK_hist` lives only in the restore record and is erased when the restore finishes, history goes off, the browser signs out, or 7 days pass (J7, D4).
- The browser store stays at schema 5; new tables and triggers are additive (D17).
- New error code only `409 E_HISTORY_STALE` (Go `server.CodeHistoryStale`) (§8.3).
- Turning history off always needs a valid step-up token, checked by the handler itself (J10, D15).
- Quota `history.quota_bytes_per_user` default 1073741824 (0 turns history off on the instance); `history.upload_bytes_per_day` per device default 268435456; each tombstone counts 64 bytes; tombstones are pruned after 400 days (J9, D18, §S.1).
- No time is stored with an entry; tombstones keep only the day (D20, §9).
- Copy rules: chrome lower case, notices sentence case with a full stop, typographic apostrophes, no "encrypted", "encryption", "end-to-end", "E2EE", "MLS", "secure", "safe", "protected" or "!" in any string, `history.ts` included (D25, §U.4).
- Gates, per task where they apply:
  - `npm run lint`, `npm run typecheck -w <package>`, `npm run check:copy`, `npm run check:docs`, `npm run check:css`;
  - Rust: `cargo test -p dilla-core`, `cargo clippy -p dilla-core --all-targets -- -D warnings`; wasm: `cargo test -p dilla-core-wasm --target wasm32-unknown-unknown --test node`;
  - Go: `go test -race ./internal/... ./cmd/...` on sqlite, and `DILLA_TEST_PG="$DILLA_TEST_PG" go test -race ./internal/store/...` on Postgres; `sqlc diff`;
  - vitest: `npm test -w @dilla/<package> -- <files>`;
  - e2e: `flock /home/thim/.cache/dilla-w3/e2e.lock env DILLA_TESTKIT=/home/thim/.cache/dilla-w3/i37e2e-target/release/dilla-testkit npx playwright test -c e2e/<config> <spec>`.
- Commits: `git commit -s`, ending with the trailers `Co-Authored-By: Claude <Model> 5.5 <noreply@anthropic.com>` (the implementer's own model: Opus, Sonnet or Haiku) and `Claude-Session: https://claude.ai/code/session_01XLFud8eoDaqf8uiZq5wjuP`.
- Every authz and crypto test is negative-first: break the check, see the test go red, restore it.
- e2e specs start from an empty instance and build everything through the shipping client.

## Review Focus

1. **A live fold that lands before its restored target.** A browser that received an edit or reaction live (seq ≥ its join floor) before the restore merged the older target shows the target edited and reacted once the target arrives, without a reload. Test added to K2.
2. **A device clock behind the restore's start.** `history_status(now)` with `now < started` (clock corrected backwards, or a second device's record) answers `expired = 0` and never underflows or panics. Test added to K2.
3. **The recovery key typed as written on paper in Privacy.** Lower case, spaces, hyphens and en dashes are accepted by "enter recovery key" exactly as at sign-in. Test added to K2.
4. **The largest legal envelope.** A type-0 envelope at every `04` limit (4 000-byte body, 4 attachments with 8 192-byte thumbs and 255-byte names, 2 previews with 16 384-byte images) seals into one row under 81 920 bytes and opens. Test added to K1.
5. **Signing out while an upload is in flight.** A flush whose `POST` resolves after the account was signed out and the store wiped neither calls the core again nor throws into the worker. Test added to C2.

---

## Lanes and integration

Four lanes run in parallel copies, each a shared clone of the feature branch:

```bash
for l in core server client web; do
  git clone --shared -b feature/history-archive /home/thim/.cache/dilla-w3/histarch /home/thim/.cache/dilla-w3/histarch-lane-$l
  git -C /home/thim/.cache/dilla-w3/histarch-lane-$l switch -c lane/$l
done
```

| Lane | Clone | Tasks (in order) |
|---|---|---|
| core (K) | `histarch-lane-core` | K1 → K2 → K3 |
| server (S) | `histarch-lane-server` | S1 ∥ S2 ∥ S5 → S3 → S4 |
| client (C) | `histarch-lane-client` | C1 → C2 → C3 |
| web (W) | `histarch-lane-web` | W1 ∥ from the start; W2 → W3 → E1 → D1 ∥ D2 |

- Writers stay sequential within a lane. A task marked ∥ gets its own clone (`histarch-<task>`, branch `lane/<task>`), integrated like a lane.
- **Integration after each wave.** The controller, in `/home/thim/.cache/dilla-w3/histarch` on `feature/history-archive`, fetches and merges each finished lane and ∥ branch (`git fetch ../histarch-lane-server lane/server && git merge --no-ff FETCH_HEAD`), runs the full gates, and each lane merges `feature/history-archive` back before its next wave.
- **Cross-lane dependencies** (spec §13.1): C1 → K3 (`testing/fake-history.ts`); K3 → C2; S5 → S3 (`CodeHistoryStale`, the 09 routes); K1 → S5's vectors row; C2, C3 → W2, W3; S3, C3, W2, W3 → E1.
- **Waves:** 1: K1, S1, S2, S5, C1, W1. 2: K2, S3, S5 step 6 (vectors row). 3: K3, S4. 4: C2. 5: C3. 6: W2, then W3. 7: E1. 8: D1, D2. Then the whole-branch security review.

---

## Wave 1

### Task K1: History crypto, entry codec and vectors — lane core, opus, review opus

**Files:**
- Create: `core/dilla-core/src/history.rs`, `core/dilla-core/tests/history_vectors.rs`, `protocol/vectors/history.json`
- Modify: `core/dilla-core/src/lib.rs` (`pub mod history;`)

**Interfaces:**
- Consumes: `crate::identity::hkdf_sha256`, `crate::cbor::{Encoder, Decoder, decode_strict}`, `openmls_traits::crypto::OpenMlsCrypto` (`derive_hpke_keypair`, `hpke_setup_sender_and_export`, `hpke_setup_receiver_and_export`).
- Produces (§K.1–§K.4, all `pub` in `dilla_core::history`):
  - constants `INFO_KEY`, `INFO_AUTH`, `INFO_ID`, `INFO_DELETE`, `ID_LABEL`, `TOKEN_LABEL`, `HASH_LABEL`, `HPKE_INFO`, `EXPORT_CONTEXT`, `BATCH_KEY_INFO`, `AAD_LABEL`, `PAD_TO = 256`, `ROW_MAX = 81_920`, `BATCH_MAX = 512`, `SUITE`;
  - `struct WriteKeys { pk: [u8; 32], k_auth, k_id, k_del: Zeroizing<[u8; 32]> }` with `encode()`/`decode()`; `struct HistoryKeys { sk: Zeroizing<[u8; 32]>, write: WriteKeys }`;
  - `fn derive_keys(crypto: &impl OpenMlsCrypto, rk: &[u8; 32]) -> Result<HistoryKeys, HistoryError>`;
  - `fn entry_id(k_id: &[u8; 32], group_id: &[u8; 16], seq: u64) -> [u8; 16]`, `fn delete_token(k_del: &[u8; 32], entry_id: &[u8; 16]) -> [u8; 16]`, `fn delete_hash(token: &[u8; 16]) -> [u8; 16]`, `fn ct_eq16(a, b) -> bool`;
  - `struct Entry` (§K.3) with `encode_padded() -> Zeroizing<Vec<u8>>`, `decode_padded(&[u8]) -> Result<Entry, HistoryError>`;
  - `struct SealBatch` with `new(crypto, &WriteKeys, &[u8; 16]) -> Result<Self, HistoryError>`, `seal(&mut self, &[u8; 16], &Entry, [u8; 12]) -> Result<Vec<u8>, HistoryError>`;
  - `struct OpenCache` (`new()`, `#[cfg(test)] open_cache_len()`), `fn open_row(crypto, sk, k_auth, user_id, entry_id, row, &mut OpenCache) -> Result<Entry, HistoryError>`;
  - `enum HistoryError { Shape, Open, Id }`.

- [ ] **Step 1: Write the failing tests** — the twelve of §K.9.1 in `history.rs`'s `mod tests`, plus Review Focus 4:

```rust
#[test] fn keys_are_deterministic_and_distinct() { /* derive twice from [0x0b;32]: equal; sk, k_auth, k_id, k_del pairwise distinct and ≠ k_header/k_backup */ }
#[test] fn a_row_needs_k_auth() { /* SealBatch from the right pk, another k_auth → open_row == Err(HistoryError::Open) */ }
#[test] fn the_open_cache_holds_one_key_per_enc() { /* 3 rows of batch A + 2 of B → open_cache_len() == 2; 65 batches → 64 */ }
#[test] fn the_largest_legal_envelope_fits_one_row() {
    // Review Focus 4: an Entry whose envelope is a type-0 envelope at every 04 limit (4_000-byte body,
    // 4 attachments each with an 8_192-byte thumb and a 255-byte name, 2 previews with 16_384-byte images)
    let row = batch.seal(&id, &e, [7; 12]).expect("seals");
    assert!(row.len() <= ROW_MAX);
    assert_eq!(open_row(&c, &sk, &k_auth, &user, &id, &row, &mut OpenCache::new()).unwrap(), e);
}
```
The other nine as named and asserted in §K.9.1. Then `tests/history_vectors.rs::history_vectors_reproduce` (§K.9.1, shape of `history.json` there).

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p dilla-core --lib history`
Expected: FAIL to compile (`unresolved module history`).

- [ ] **Step 3: Implement `history.rs`** per §K.1–§K.4. Padding: `decode_padded` uses `Decoder::position()` and requires every trailing byte to be zero (§K.3). `OpenCache` keeps at most 64 `(enc, K_batch)` pairs, oldest evicted. No new crate.

- [ ] **Step 4: Freeze the vectors** with the `#[ignore]`d `write_history_vectors` test (fixed nonce `0x0c × 12`), commit `protocol/vectors/history.json`, then run `cargo test -p dilla-core --lib history && cargo test -p dilla-core --test history_vectors`.
Expected: PASS. Flip `SUITE`'s AEAD to `AesGcm128` once: `history_vectors_reproduce` must fail; restore.

- [ ] **Step 5: Gates**: `cargo clippy -p dilla-core --all-targets -- -D warnings && cargo test -p dilla-core --target wasm32-unknown-unknown --test vectors_wasm`. Expected: ok.

- [ ] **Step 6: Commit**

```bash
git add core/dilla-core/src/history.rs core/dilla-core/src/lib.rs core/dilla-core/tests/history_vectors.rs protocol/vectors/history.json
git commit -s -m "feat(core): message history keys, entry codec, sealing and vectors"
```

### Task S1: Migration, store, sqlc and dump — lane server ∥, sonnet, review sonnet

**Files:**
- Create: `internal/store/{sqlite,postgres}/migrations/00024_history_archive.sql`, `internal/store/{sqlite,postgres}/schema/022_history_archive.sql`, `internal/store/{sqlite,postgres}/queries/history.sql`, `internal/store/history_test.go`
- Modify: `internal/store/rows.go`, `store.go` (`Repository` embeds `HistoryStore` after `VoiceSessions`), `sqlite/repo.go`, `postgres/repo.go`, `dump.go`, `internal/ops/restore.go` (`dumpRowCounts`), `schema_test.go` (`wantTables`), `contract_test.go` (two lists), `dump_test.go`; regenerate `sqlitedb/`, `pgdb/`

**Interfaces:**
- Consumes: nothing.
- Produces (§S.2): `store.HistoryState{Enabled bool; Generation uint64; Entries, Bytes, Tombstones int64}`, `HistoryPut{EntryID, DelHash, Row []byte}`, `HistoryRow{N int64; EntryID, Row []byte}`, `HistoryTotals{People, Entries, Bytes, NearFull int64}`, and `HistoryStore` with `GetHistoryState`, `PutHistoryState`, `GetHistoryEntryHash`, `GetHistoryTombstone`, `InsertHistoryEntry`, `DeleteHistoryEntry`, `InsertHistoryTombstone(ctx, uid, entryID, delHash []byte, day int64) (bool, error)`, `PruneHistoryTombstones(ctx, before int64) (int64, error)`, `ListHistoryEntries(ctx, uid, before, after *int64, limit int)`, `DeleteHistoryOfUser`, `HistoryTotals(ctx, nearFullBytes int64)`.

- [ ] **Step 1: Write the failing tests** of §S.8.1 in `internal/store/history_test.go` over `engines(t)`:

```go
func TestHistoryStateDefaultsToOnAtGenerationOne(t *testing.T)        // {true,1,0,0,0}, found == false
func TestHistoryEntriesRoundTripAndPage(t *testing.T)                 // 5 entries: before MaxInt64 limit 2 → 2 newest desc; after n3 → last 2 asc
func TestHistoryEntryIdIsUniquePerUser(t *testing.T)
func TestHistoryTombstoneIsRecordedOnce(t *testing.T)                 // true then false; GetHistoryTombstone == first hash
func TestPruneHistoryTombstonesKeepsTheCountsExact(t *testing.T)
func TestDeleteHistoryOfUserLeavesOthers(t *testing.T)
func TestHistoryGoesWithTheUserRow(t *testing.T)
func TestHistoryArchiveMigrationIsItsSchemaVersion(t *testing.T)      // N from the *_history_archive.sql name; N <= wantSchemaVersion(t)
func TestADumpRoundTripsHistory(t *testing.T)                          // Postgres
func TestPostgresDumpSplitsHistoryIntoBoundedRecords(t *testing.T)     // 65 537 entries → two records
```
and in `internal/ops`: `TestRestoreDryRunSumsRepeatedRecords`. Edit `wantTables` and both `contract_test.go` lists exactly as §S.8.1.

- [ ] **Step 2: Run them to verify they fail**

Run: `go test -race ./internal/store/ ./internal/ops/ -run 'History|DryRunSums'`
Expected: FAIL (`undefined: store.HistoryState`).

- [ ] **Step 3: Implement** the schema and migration files (§S.1, verbatim SQL), the queries with byte-identical headers (§S.2), the repo methods on both engines, `DumpTables` (§S.6 comment and the three names after `"slowmode_marks"`), the chunked `history_entries` records in `DumpPostgres` (§S.6), and `counts[table] += n` in `dumpRowCounts`.

- [ ] **Step 4: Run them to verify they pass**

Run: `sqlc generate && sqlc diff && go test -race ./internal/store/... ./internal/ops/ && DILLA_TEST_PG="$DILLA_TEST_PG" go test -race ./internal/store/...`
Expected: PASS, including `TestDumpTablesNamesEverySchemaTable`, `TestEverySQLiteTableIsStrictAndTyped`, `TestGooseUpDownUpOnSQLite`/`Postgres`, `TestQueryHeadersAreByteIdenticalAcrossEngines`, `TestSubInterfacesMatchTheContract`.

- [ ] **Step 5: Commit**

```bash
git add internal/store internal/ops/restore.go internal/ops/*_test.go
git commit -s -m "feat(store): message history tables, queries and a chunked dump"
```

### Task S2: Config and the history meter — lane server ∥, sonnet, review sonnet

**Files:**
- Modify: `internal/config/config.go`, `defaults.go`, `validate.go` and their tests; `internal/api/api.go` (the `HistoryMeter` field and its construction only)

**Interfaces:**
- Produces: `config.History{QuotaBytesPerUser, UploadBytesPerDay int64}` at `Config.History` (`toml:"history"`); `api.Deps.HistoryMeter *UploadMeter`, built in `Register` only when `d.Config != nil` (§S.3).

- [ ] **Step 1: Write the failing tests**: `TestHistoryDefaults` (1073741824 and 268435456), `TestHistoryValidate` (negative quota refused; quota 0 accepted; upload < 1048576 refused while quota > 0; upload 0 accepted while quota 0), `TestRegisterBuildsTheHistoryMeter` (built from config; nil `Config` → stays nil, no panic).
- [ ] **Step 2: Run them to verify they fail**: `go test -race ./internal/config/ ./internal/api/ -run 'History|HistoryMeter'`. Expected: FAIL (`unknown field History`).
- [ ] **Step 3: Implement** per §S.3 (the comments, defaults, the validate message, and the nil-guarded construction beside `StateMeter` at `api.go:171`).
- [ ] **Step 4: Run them to verify they pass**: the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add internal/config internal/api/api.go internal/api/*_test.go
git commit -s -m "feat(config): [history] quota and per-device upload budget"
```

### Task S5: Protocol docs, the error code and the release-notes stub — lane server ∥, haiku, review opus

**Files:**
- Modify: `protocol/02-delivery-service.md`, `03-identity.md`, `06-backup-archive.md`, `07-versioning.md`, `08-threat-model.md`, `09-http-api.md`, `protocol/vectors/README.md`, `scripts/check-protocol-docs.mjs`, `scripts/check-protocol-docs.test.mjs`, `internal/server/errors.go`, `internal/server/errors_test.go`
- Create: `docs/deploy/releases/v0.1.0-web3.13.md` (stub)

**Interfaces:**
- Produces: `server.CodeHistoryStale Code = "E_HISTORY_STALE"` (409); the 06 headings `## Keys`, `## Header`, `## History`, `## Restore`; the five routes documented in 09 § History (which `TestEveryMountedRouteIsADocumentedRoute` reads).

- [ ] **Step 1: Write the failing tests**: the `errors_test.go` row `{server.Errorf(server.CodeHistoryStale, ""), 409, 3}`; in `check-protocol-docs.test.mjs` the two 06 fixtures take `## History` (lines 24 and 57) and the new case "requires 06's History heading" (§P.8).
- [ ] **Step 2: Run them to verify they fail**: `go test ./internal/server/ && node --test scripts/check-protocol-docs.test.mjs`. Expected: FAIL (`undefined: server.CodeHistoryStale`; the History case fails).
- [ ] **Step 3: Implement**: `CodeHistoryStale` and its 409 case (§P.9); `REQUIRED['06-backup-archive.md']` (§P.8); paste §P.1–§P.5 and §P.6 (with the literal `<release-date>`) into the protocol documents at the places named; the stub release notes with the §10 paragraph and the schema and rollback lines of §11–§12.
- [ ] **Step 4: Run them to verify they pass**: the Step 2 command, then `npm run check:docs`. Expected: PASS (`checkErrorVocabulary` sees `E_HISTORY_STALE` in 02 and in `errors.go`).
- [ ] **Step 5: Commit**

```bash
git add protocol scripts/check-protocol-docs* internal/server/errors*.go docs/deploy/releases/v0.1.0-web3.13.md
git commit -s -m "docs(protocol): saved message history; E_HISTORY_STALE"
```
- [ ] **Step 6 (wave 2, after K1 is integrated): the vectors row.** Paste §P.7 into `protocol/vectors/README.md`; `npm run check:docs`; commit `docs(protocol): history vectors row`.

### Task C1: Routes, the fake scheme and fake-server routes — lane client, sonnet, review sonnet

**Files:**
- Create: `packages/client-core/src/testing/fake-history.ts`, `testing/fake-history.test.ts`
- Modify: `packages/client-core/src/http/routes.ts`, `http/routes.test.ts`, `testing/fake-server.ts`, `testing/fake-server.test.ts`

**Interfaces:**
- Produces (§C.1.1, §C.2): `sha256(...parts)`, `fakeEntryId(group, seq)`, `fakeDelToken(entryId)`, `fakeDelHash(delToken)`, `fakeRow(group, seq, envelope)`; types `HistoryInfo`, `HistorySet`, `HistoryStored {stored, dropped, entries, bytes}`, `HistoryDeleted {deleted, refused, entries, bytes}`, `HistoryCursor`, `HistoryPut`, `HistoryDeleteItem {entryId, delToken, delHash}`; `Routes.getHistory()`, `setHistory(enabled, stepup)`, `postHistoryEntries(generation, puts)`, `postHistoryDeletes(generation, items)`, `getHistoryEntries(generation, cursor, limit): Promise<Uint8Array>`; the fake server's five routes.

- [ ] **Step 1: Write the failing tests** of §C.9.1 ("Routes: history", six cases; "fake history follows §S.4"; the three `fake-history.test.ts` cases), e.g.:

```ts
it('postHistoryDeletes sends [generation, [[id, token, hash]]] and decodes [deleted, refused, entries, bytes]', async () => {
  const f = fakeFetch(encode([1, 0, 3, 768]));
  expect(await routes(f).postHistoryDeletes(2n, [{ entryId: ID, delToken: TOK, delHash: H }]))
    .toEqual({ deleted: 1, refused: 0, entries: 3, bytes: 768 });
  expect(decode(f.lastBody())).toEqual([2n, [[ID, TOK, H]]]);
});
```
- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/client-core -- src/http/routes.test.ts src/testing/fake-history.test.ts src/testing/fake-server.test.ts`. Expected: FAIL (`getHistory is not a function`).
- [ ] **Step 3: Implement** per §C.1.1 (verbatim module) and §C.2 (bodies, decoders, query strings; `http/errors.ts` untouched); the fake server follows §S.4 with `fakeDelHash`.
- [ ] **Step 4: Run them to verify they pass**: the Step 2 command, then `npm run typecheck -w @dilla/client-core`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/http packages/client-core/src/testing
git commit -s -m "feat(client-core): history routes and fakes"
```

### Task W1: Strings, flow 19 and its test — lane web ∥, haiku, review sonnet

**Files:**
- Create: `packages/web/src/strings/history.ts`, `docs/design/flows/19-message-history.md`, `packages/web/src/strings/strings.flow19.test.ts`
- Modify: `packages/web/src/strings/en.ts`, `strings/strings.test.ts`

**Interfaces:**
- Produces: the 31 `history.*` keys and `signin.done.bodyNoHistory`, `onboarding.keys.history`, `shell.log.emptyRestoring`, with the two changed values (`signin.done.body`, `onboarding.browser.oneBrowser`), byte for byte from §U.4. `shell.log.emptyMade` is reused, not duplicated.

- [ ] **Step 1: Write the failing test** `strings.flow19.test.ts` with the five cases of §U.7.1 (36 pairs; lower-case chrome list; the trade-off; the exact `history.off.body`; typographic apostrophes), and update the two pins in `strings.test.ts`.
- [ ] **Step 2: Run it to verify it fails**: `npm test -w @dilla/web -- src/strings/strings.flow19.test.ts src/strings/strings.test.ts`. Expected: FAIL (flow file missing).
- [ ] **Step 3: Implement**: `history.ts` and the `en.ts` changes from §U.4; flow 19 per §U.5.
- [ ] **Step 4: Run it to verify it passes**: the Step 2 command, then `npm run check:copy`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/web/src/strings docs/design/flows/19-message-history.md
git commit -s -m "feat(web): message history copy and flow 19"
```

---

## Wave 2

### Task K2: Store side: tables, triggers, keys, queue, server state, restore merge, parking — lane core, opus, review opus

**Files:**
- Create: `core/dilla-core/src/client/history.rs`, `core/dilla-core/tests/client_history.rs`
- Modify: `core/dilla-core/src/client/mod.rs`, `client/schema.rs` (`APP_HISTORY`, five meta consts, `APP_SCHEMA_V4` → `pub(super)`, the call in `migrate_conn`), `client/identity.rs` (`signup_begin`, `signup_reset`, `recover`, `enrol_complete`, `device_list_revoke`), `core/dilla-core/tests/client_support/mod.rs` (`ready_core_with_key`), `core/dilla-core/tests/client_identity.rs` (tests 17–20)

**Interfaces:**
- Consumes: K1's `history::*`; `messages.rs`'s `insert_message`, `refold_insert`, `own_roles_of`, `mentionable_of`, `broadcast_ok`, `mentions_me_gated`, `StoredMessage`.
- Produces (§K.6–§K.7): `ClientCore::history_status(&self, now: u64) -> Result<Vec<u8>, ClientError>`, `history_set_server(&mut self, enabled: bool, generation: u64)`, `history_unlock(&mut self, recovery_key: &str, root_sealed: &[u8], now: u64)`, `history_take(&mut self, max_rows: u32, max_bytes: u32)`, `history_done(&mut self, taken: &[u64]) -> Result<(), ClientError>`, `history_restore_page(&mut self, rows: &[u8], now: u64)`, `history_restore_state(&self)`, `history_restore_cancel(&mut self) -> Result<(), ClientError>`, `history_unpark(&mut self, now: u64)`; CBOR answers exactly as §K.7.1–§K.7.3; the free functions of §K.7 (`status`, `apply_server`, `queue_backfill`, `take`, `done`, `restore_page`, `merge_entry`, `unpark`); test helper `ready_core_with_key(user: u8, username: &str) -> (Core, String)`.

- [ ] **Step 1: Write the failing tests**: the thirty of §K.9.2, placed as §K.9.2 says (unit: 1–10, 12–16, 21–29 in `client/history.rs`; integration: 11 and 30 in `tests/client_history.rs`, 17–20 in `tests/client_identity.rs`), plus Review Focus 1–3 in `client/history.rs`:

```rust
#[test] fn a_live_fold_before_its_restored_target_applies_when_the_target_arrives() {
    // Review Focus 1: next_seq = 20; live edit (seq 21, author A, reply_to X) and live reaction (seq 22) stored first;
    // restore_page merges the type-0 target X at seq 5 from A.
    // timeline row at 5 shows the edit body and the reaction; app_history_out has no op-0 row for seq 5.
}
#[test] fn a_clock_behind_the_restore_start_is_not_expired() {
    // Review Focus 2: record started = 1_000_000; status(c, 999_000) → expired == 0, no panic (saturating arithmetic).
}
#[test] fn unlock_accepts_the_key_as_written_on_paper() {
    // Review Focus 3 (integration, tests/client_identity.rs): signed_up()'s key in lower case, in groups of four with
    // spaces, hyphens and one en dash → history_unlock answers status with keys == 1.
}
```
- [ ] **Step 2: Run them to verify they fail**: `cargo test -p dilla-core history`. Expected: FAIL to compile (`no method named history_status`).
- [ ] **Step 3: Implement** `APP_HISTORY` verbatim (§K.5) and the call in `migrate_conn`; key installation in the identity flows (§K.6); `history_unlock` (§K.6); status and server state (§K.7.1); take and done (§K.7.2); the restore page, `merge_entry` with the Rust of §K.7.3 step 6 and the op-0-only delete of step 7, and `unpark` (§K.7.3). Use `saturating_sub` for every `now`/`started`/`parked_at` difference.
- [ ] **Step 4: Run them to verify they pass**: `cargo test -p dilla-core`. Expected: PASS. Negative checks, each once and restored: drop `AND kind = 0` from `app_history_put` (test 2 fails); make step 7 delete op 1 too (test 24 fails); skip the `seq >= next_seq` check (test 21 fails).
- [ ] **Step 5: Gates**: `cargo clippy -p dilla-core --all-targets -- -D warnings`. Expected: ok.
- [ ] **Step 6: Commit**

```bash
git add core/dilla-core/src/client core/dilla-core/tests
git commit -s -m "feat(core): save, delete and restore message history in the store"
```

### Task S3: The five routes, account deletion, audit, tombstone pruning — lane server, sonnet, review opus

**Files:**
- Create: `internal/api/history.go`, `internal/api/history_test.go`, `internal/dillad/historysweep_test.go`
- Modify: `internal/api/api.go` (five `m.Handle` lines, §S.4), `internal/api/accounts.go` (`DeleteMe`), `internal/api/accounts_delete_test.go`, `internal/ops/revoke_devices_test.go`, `internal/dillad/server.go` (`sweep`, `historyPrunedAt`)

**Interfaces:**
- Consumes: S1's `HistoryStore`; S2's `HistoryMeter`; S5's `server.CodeHistoryStale`; `Deps.spendStepUp(sess, token *string) error` (`auth.go:1507`).
- Produces: handlers `GetHistory`, `PutHistory`, `PostHistoryEntries`, `PostHistoryDeletes`, `ListHistoryEntries`; constants `historyRowMax = 81920`, `historyPutMax = 512`, `historyDeleteMax = 1024`, `historyPageMax = 512`, `historyPageBytes = 1 << 20`, `historyPutBodyCap = 1<<20 + 4096`, `historyTombstoneBytes = 64`, `historyTombstoneTTL = 400 * 86400`; the wire answers of §8.3.

- [ ] **Step 1: Write the failing tests** of §S.8.2 (every one by name; `TestHistoryOffNeedsAStepUp` with `stepUp`/`stepUpToken` of `auth_test.go:561/568`), e.g.:

```go
func TestHistoryDeleteOfAnAbsentIdRecordsIt(t *testing.T) {
	// delete [id, tok, h(tok)] never stored → [1,0,…]; tombstone holds h(tok)
	// put id → [0,1,…]; delete [id, tok2, h(tok2)] → [0,1,…]; delete [id, tok, h(tok)] → [1,0,…], one tombstone
}
func TestHistoryTombstonesCountTowardTheQuota(t *testing.T) // quota 1000, 2 tombstones: put 873 → 507, 872 → ok; delete while full ok
```
plus `TestSweepPrunesOldHistoryTombstonesHourly` in `internal/dillad`. No factorless-account test: the forced-factor gate's tests (`internal/dillad/factor_owed_test.go:306`, `:242`, `:392`; `internal/api/factor_owed_test.go:28`) stay green.
- [ ] **Step 2: Run them to verify they fail**: `go test -race ./internal/api/ ./internal/dillad/ ./internal/ops/ -run 'History|DeleteMeDeletesHistory|RevokeAllDevicesKeepsHistory'`. Expected: FAIL (`d.GetHistory undefined`).
- [ ] **Step 3: Implement** §S.4.1–§S.4.6, §S.4.5a and §S.5: the strict step-up for off (nil token → `403 E_STEP_UP` before `spendStepUp`), the user lock in every write, quota with 64 bytes per tombstone, the token rules of §S.4.5, the 1 MiB page, the totals in both `POST` answers, the hourly prune in `sweep`, and `tx.DeleteHistoryOfUser` right after `TombstoneUser` in `DeleteMe`.
- [ ] **Step 4: Run them to verify they pass**: the Step 2 command, then `go test -race ./internal/... ./cmd/...` (the factor-owed and documented-route tests included). Expected: PASS. Negative checks, each once and restored: accept a nil token for off; skip the `h(token) == del_hash` comparison; drop the generation check.
- [ ] **Step 5: Commit**

```bash
git add internal/api internal/dillad internal/ops/revoke_devices_test.go
git commit -s -m "feat(api): message history routes with delete tokens, tombstones and a strict off"
```

---

## Wave 3

### Task K3: wasm facade and CorePort — lane core, sonnet, review sonnet

**Files:**
- Modify: `core/dilla-core-wasm/src/facade.rs`, `core/dilla-core-wasm/src/lib.rs` (`BROWSER_ABI_VERSION` 11 → 12), `core/dilla-core-wasm/tests/node.rs` (line 281), `packages/core-wasm/types.test-d.ts`, `packages/client-core/src/core-port.ts`, `core-port.test.ts`, `testing/fake-core.ts`, `testing/fake-core.test.ts`

**Interfaces:**
- Consumes: K2's `ClientCore::history_*`; C1's `testing/fake-history.ts`.
- Produces (§K.8, §C.1): the nine `history_*` facade methods returning `Box<[u8]>` (unlock takes `recovery_key: String`, zeroized); `CorePort.historyStatus(now: bigint): HistoryCoreStatus`, `historySetServer(enabled: boolean, generation: bigint): HistoryCoreStatus`, `historyUnlock({recoveryKey, rootSealed, now}): HistoryCoreStatus`, `historyTake(maxRows: number, maxBytes: number): HistoryTake`, `historyDone(taken: readonly bigint[]): void`, `historyRestorePage(rows: Uint8Array, now: bigint): HistoryRestoreResult`, `historyRestoreState(): HistoryRestoreState | null`, `historyRestoreCancel(): void`, `historyUnpark(now: bigint): { merged: number; groups: Id[] }`, and the types of §C.1.

- [ ] **Step 1: Write the failing tests**: `core-port.test.ts` "history: every method decodes its CBOR answer"; `fake-core.test.ts` "fake history queue: take, done and a requeue", "fake restore: down, up, done", "fake ids and tokens follow fake-history"; the nine `ExpectedCoreHandle` members and `expectTrue` lines (§K.8); `node.rs:281` asserts 12.
- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/client-core -- src/core-port.test.ts src/testing/fake-core.test.ts`. Expected: FAIL (`historyStatus is not a function`).
- [ ] **Step 3: Implement** the facade (the `purges`/`enrol_complete` style, `facade.rs:675`, `:895`), the ABI bump, the CorePort decoders with `decoded(name, bytes, reader)`, and the fake core over the §C.1.1 scheme.
- [ ] **Step 4: Run them to verify they pass**: `wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir ../../packages/core-wasm/pkg && npm run typecheck -w @dilla/core-wasm && cargo test -p dilla-core-wasm --target wasm32-unknown-unknown --test node && npm test -w @dilla/client-core -- src/core-port.test.ts src/testing/fake-core.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add core/dilla-core-wasm packages/core-wasm/types.test-d.ts packages/client-core/src/core-port*.ts packages/client-core/src/testing/fake-core*.ts
git commit -s -m "feat(core-wasm): message history facade, ABI 12"
```

### Task S4: Doctor leg and diagnostics — lane server, sonnet, review sonnet

**Files:**
- Modify: `internal/ops/doctor.go` (`HistoryLeg`), `internal/ops/doctor_test.go`, `cmd/dillad/doctor.go` (`doctorHistoryLeg`), `cmd/dillad/doctor_test.go`, `internal/dillad/diagnostics.go`

**Interfaces:**
- Consumes: S1's `HistoryTotals`; S2's `config.History`.
- Produces: `ops.HistoryLeg(ctx context.Context, repo store.Repository, cfg config.Config) Leg` (name `history`).

- [ ] **Step 1: Write the failing tests**: `TestHistoryLegGreenReportsTotals` ("N people, M entries, X MiB saved"), `TestHistoryLegYellowNearQuota`, `TestHistoryLegYellowWhenOffWithRows`, `TestHistoryLegSkippedWithoutADatabase`, `TestDoctorHistoryLegSkipsWithoutADatabase` (`cmd/dillad`); update that file's leg-order assertions.
- [ ] **Step 2: Run them to verify they fail**: `go test -race ./internal/ops/ ./cmd/dillad/ -run 'HistoryLeg|Doctor'`. Expected: FAIL (`undefined: ops.HistoryLeg`).
- [ ] **Step 3: Implement** §S.7 (the four outcomes and their fix lines; wire after the blobs leg in both places).
- [ ] **Step 4: Run them to verify they pass**: the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add internal/ops/doctor*.go cmd/dillad/doctor*.go internal/dillad/diagnostics.go
git commit -s -m "feat(ops): doctor history leg"
```

---

## Wave 4

### Task C2: History state, the uploader, the slice and the commands — lane client, sonnet, review sonnet

**Files:**
- Create: `packages/client-core/src/history/state.ts`, `history/uploader.ts`, `history/slice.ts`, `history/state.test.ts`, `history/uploader.test.ts`
- Modify: `worker/protocol.ts`, `state/types.ts`, `account/factors.ts` (`export` on `stepupProblem`), `worker/controller.ts`, `index.ts`, `worker/controller.test.ts`

**Interfaces:**
- Consumes: K3's CorePort methods; C1's routes.
- Produces (§C.3, §C.4, §C.6, §C.7.1): `class HistoryState { info; available; full; loadFailed; refresh(); setEnabled(on, stepup); effective() }`, `HISTORY_VALIDATORS`; `class HistoryUploader { start(); poke(); flush(); stop() }` with `FLUSH_OPS = 256`, `FLUSH_AFTER_MS = 20_000`, `BACKOFF_MIN_MS = 2_000`, `BACKOFF_MAX_MS = 300_000`, `FULL_RETRY_MS = 3_600_000`; `interface HistorySlice`, `historySlice(state, status, restore)`; `SliceName` `'history'`, `SliceTypes.history: HistorySlice | null`, `TimelineState.restoring: boolean`; commands `historyRefresh`, `historySetEnabled {on, stepup}`, `historyUseKey {recoveryKey}` (its body is C3's; C2 registers it).

- [ ] **Step 1: Write the failing tests**: §C.9.2 (five), §C.9.3 (twelve), and the C2 cases of §C.9.5 (seven), plus Review Focus 5:

```ts
it('a flush in flight when the account signs out ends without touching the core', async () => {
  // Review Focus 5: postHistoryEntries pending; controller.signOut wipes the store and stops the uploader;
  // the POST then resolves → historyDone is never called, no unhandled rejection, no further historyTake
  expect(core.historyDone).not.toHaveBeenCalled();
  expect(core.historyTake).toHaveBeenCalledTimes(1);
});
```
- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/client-core -- src/history src/worker/controller.test.ts -t 'history'`. Expected: FAIL (module `history/state` not found).
- [ ] **Step 3: Implement** §C.3, §C.4 (rules 1–4 and 2a), §C.6, and the five controller tables and wiring of §C.7.1–§C.7.2 (construction, sync hooks, `onReady`, `historyRefresh`, `historySetEnabled`, sign-out stop). `stop()` sets a stopped flag the in-flight flush checks before `historyDone` and before its next `historyTake`.
- [ ] **Step 4: Run them to verify they pass**: the Step 2 command, then `npm run typecheck -w @dilla/client-core && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src
git commit -s -m "feat(client-core): history state, uploader and commands"
```

---

## Wave 5

### Task C3: Restore runner and its wiring — lane client, sonnet, review sonnet

**Files:**
- Create: `packages/client-core/src/history/restore.ts`, `history/restore.test.ts`
- Modify: `sync/engine.ts` (`SyncDeps.onActivated`, its call first in `activate`, line 404), `sync/engine.test.ts`, `sync/testing/harness.ts` (line 57), `worker/controller.ts`, `worker/controller.test.ts`

**Interfaces:**
- Consumes: C2's `HistoryState`, the controller wiring; K3's restore methods.
- Produces (§C.5, §C.7.3): `class HistoryRestore { progress: RestoreProgress; run(); stop() }`, `PAGE_LIMIT = 512`, `interface RestoreProgress`; `SyncDeps.onActivated(groupId: Id): void`; `Controller.onGroupActivated(g)`; the `historyUseKey` body; `restoring` on every `TimelineState`.

- [ ] **Step 1: Write the failing tests**: §C.9.4 (eight), the C3 cases of §C.9.5 (six, including "a group joined after the first ready merges its parked entries without a reload"), and `engine.test.ts` "activate calls onActivated once, before the snapshot".
- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/client-core -- src/history/restore.test.ts src/sync/engine.test.ts src/worker/controller.test.ts -t 'history|onActivated'`. Expected: FAIL (module `history/restore` not found).
- [ ] **Step 3: Implement** §C.5 (`run` steps 1–6), §C.7.2's restore start and `historyUseKey`, and §C.7.3 (both `SyncDeps` constructions gain `onActivated`).
- [ ] **Step 4: Run them to verify they pass**: the Step 2 command, then `npm test -w @dilla/client-core && npm run typecheck -w @dilla/client-core`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src
git commit -s -m "feat(client-core): restore saved history and unpark on join"
```

---

## Wave 6

### Task W2: Settings → Privacy: the history section — lane web, sonnet, review sonnet

**Files:**
- Create: `packages/web/src/screens/settings/History.tsx`, `History.test.tsx`, `settings/KeyDialog.test.tsx`
- Modify: `settings/Privacy.tsx`, `settings/Privacy.test.tsx`, `screens/Settings.tsx`, `settings/KeyDialog.tsx`

**Interfaces:**
- Consumes: the `history` slice; the commands of C2/C3; W1's keys; `StepUpDialog`, `ConfirmDialog`, `Toggle`, `SettingsRow`, `formatSize` (`shell-model.ts:315`).
- Produces: `History({ history, … })`; `Privacy` props `{ records, onCompare, history }`; `KeyDialog`'s optional `wrongKeyLabel?: StringKey`, `keyLabel?: StringKey`, `confirmVariant?: 'danger' | 'accent'` (§U.1.2).

- [ ] **Step 1: Write the failing tests** of §U.7.2 (the history cases, the off-flow cases of §U.1.1, "opening Privacy calls historyRefresh once", `KeyDialog.test.tsx`'s four, the Privacy order case, axe at three themes and 390 px).
- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/web -- src/screens/settings/History.test.tsx src/screens/settings/KeyDialog.test.tsx src/screens/settings/Privacy.test.tsx`. Expected: FAIL (`History` not found).
- [ ] **Step 3: Implement** §U.1 (status table, button, toggle), the off state machine of §U.1.1, §U.1.2, and §U.2.
- [ ] **Step 4: Run them to verify they pass**: the Step 2 command, then `npm run typecheck -w @dilla/web && npm run check:copy && npm run check:css`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/web/src/screens
git commit -s -m "feat(web): message history in Settings → Privacy"
```

### Task W3: Sign-in done step, sign-up key step, timeline line, empty channel, banner — lane web, sonnet, review sonnet

**Files:**
- Create: `packages/web/src/screens/HistoryBanner.tsx`, `HistoryBanner.test.tsx`
- Modify: `screens/SignIn.tsx`, `SignIn.test.tsx`, `screens/Onboarding.tsx`, `Onboarding.test.tsx`, `screens/conversation/Conversation.tsx` (lines 273–275), `conversation/Conversation.test.tsx`, `screens/Shell.tsx` (slot at 1722–1726), `prefs.ts`, `prefs.test.ts`

**Interfaces:**
- Consumes: the `history` slice, `TimelineState.restoring`, W1's keys.
- Produces: `HistoryBanner()`; `readHistoryBannerDismissed(idb?): Promise<boolean>`, `writeHistoryBannerDismissed(v: boolean, idb?): Promise<void>`; `readRecord(idb, key)`.

- [ ] **Step 1: Write the failing tests** of §U.7.3 (sign-in done copy both ways; the onboarding paragraph; the timeline line and the restoring empty label; the four banner cases; the five prefs cases).
- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/web -- src/screens/SignIn.test.tsx src/screens/Onboarding.test.tsx src/screens/conversation/Conversation.test.tsx src/screens/HistoryBanner.test.tsx src/prefs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** §U.3 (each bullet at the named file and line; the banner after `{banner}` at `Shell.tsx:1725`; the prefs record `history.bannerDismissed`, DB version 1).
- [ ] **Step 4: Run them to verify they pass**: the Step 2 command, then `npm test -w @dilla/web && npm run typecheck -w @dilla/web`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/web/src
git commit -s -m "feat(web): restore copy at sign-in and in the timeline; banner for older browsers"
```

---

## Wave 7

### Task E1: e2e — lane web, sonnet, review sonnet

**Files:**
- Create: `e2e/web/history.spec.ts`
- Modify: `e2e/web/enrol.spec.ts` (the done-step copy)

**Interfaces:**
- Consumes: the built app and testkit; the three flows of §U.8.1 and the phone check of §U.8.2.

- [ ] **Step 1: Write the spec**: the three cases of §U.8.1 (the usage count read after a Privacy reopen, polling every 5 s for at most 60 s) and §U.8.2 at 390 px:

```ts
// case 1, browser B after restore:
await expect(page.getByText('two edited')).toBeVisible();
await expect(page.getByText('three', { exact: true })).toHaveCount(0);
// and no unread or mention badge on #general or the DM, checked with the same badge locators e2e/web/badges.spec.ts uses
```
- [ ] **Step 2: Run it**: `npm run build -w @dilla/web && flock /home/thim/.cache/dilla-w3/e2e.lock env DILLA_TESTKIT=/home/thim/.cache/dilla-w3/i37e2e-target/release/dilla-testkit npx playwright test -c e2e/playwright.web.config.ts history enrol`. Expected: PASS (`history` on chromium and firefox, `enrol` on all three).
- [ ] **Step 3: Gates**: `npm run typecheck:e2e`. Expected: ok.
- [ ] **Step 4: Commit**

```bash
git add e2e/web
git commit -s -m "test(e2e): restore, delete and turn off message history"
```

---

## Wave 8

### Task D1: User docs, deploy guide, README, flows, story and release notes — lane web ∥, sonnet, review sonnet

**Files:**
- Modify: `docs/user/getting-started.md` (108, 652, 701, 856, 1038, new section), `docs/deploy/README.md`, `README.md` ("what works", 54–55), `docs/design/flows/01-onboarding.md` (175, 451), `docs/design/flows/03-sign-in.md` (871, 890), `packages/ui/src/OnboardingFrame/OnboardingFrame.stories.tsx` (29), `docs/deploy/releases/v0.1.0-web3.13.md`, `protocol/07-versioning.md` (`<release-date>`)

- [ ] **Step 1: Write** §U.6 (the README sentence verbatim, the getting-started section, the deploy settings and storage estimate, the table row of §11), the flow and story copy matching W1's values, the release notes with the §10 paragraph verbatim, and the merge date in place of `<release-date>`.
- [ ] **Step 2: Check**: `npm run check:docs && npm test -w @dilla/web -- src/strings && npm test -w @dilla/ui`. Expected: ok; `grep -rn 'not shown there\|not shown in it' README.md docs/user docs/design/flows/01-onboarding.md docs/design/flows/03-sign-in.md` finds only the history-off wording.
- [ ] **Step 3: Commit**

```bash
git add docs README.md packages/ui/src/OnboardingFrame/OnboardingFrame.stories.tsx protocol/07-versioning.md
git commit -s -m "docs: message history for users, operators and the release"
```

### Task D2: Screenshots — lane web ∥, sonnet, review sonnet

**Files:**
- Modify: `e2e/scripts/shoot-docs.mjs` (a `HISTORY_SHOTS` block), `docs/user/screenshots/*`

- [ ] **Step 1: Add the shots** of §U.8.3 and run the shoot under the e2e lock with `DILLA_TESTKIT`. Expected: the ten files exist; review them by eye at 1280 px and 390 px.
- [ ] **Step 2: Commit**

```bash
git add e2e/scripts/shoot-docs.mjs docs/user/screenshots
git commit -s -m "docs: message history screenshots"
```

---

## Whole-branch security review — opus

After wave 8 is integrated, one opus reviewer reads the whole `feature/history-archive` diff against the spec, with these questions and nothing else:

- **Key custody.** `SK_hist` exists only in `history_restore` and is erased on every path of J7/D4 (finish, off, sign-out, 7 days, a new generation); no `K_backup` reaches a browser beyond today's paths; nothing derived from the recovery key crosses the worker boundary (§K.8, §C.8).
- **Crypto.** Labels, suite, AAD and padding match §8.1 byte for byte; ids are compared in constant time; a row moved between ids, users or positions does not open (§K.9.1 tests 9–10, §K.7.3 step 3.2).
- **Deletes and tombstones.** Every drop path in `app_messages` queues a delete; the server never deletes or tombstones without a consistent `h(token) == del_hash`; a stolen session cannot delete or block a real entry (§S.4.5).
- **Authz.** All five routes are own-account only and enrolled-only; off always needs a valid step-up token; quota and byte budget are checked before work (§S.4).
- **Metadata.** No route or table stores a group, sender, message id or time beside an entry; tombstones keep only the day (§9).
- **Honest copy.** protocol/08, `history.risk`, `onboarding.keys.history`, the user docs and the release notes state the trade-off in the same words (§10).

Findings go to the owning task's implementer tier, except K1, K2 and S3's delete-token check, whose fix rounds go to opus. Then: `go test -race ./internal/... ./cmd/...`, `cargo test -p dilla-core`, `npm test`, both e2e configs, and merge.
