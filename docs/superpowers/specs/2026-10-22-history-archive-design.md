# Message history for your own new browsers: design

Date: 2026-10-22. Base: main at `1ad0d408` (lane `/home/thim/.cache/dilla-w3/histarch`, branch
`feature/history-archive`). Scope: a new browser of **your own account** gets your message history once you enter
your recovery key at sign-in, as Messenger's encrypted backup does. History for *new members* of a channel is a
separate, later feature and is not designed here.

Status: **buildable.** Every name, number, byte, label, key, table, route, string and test in this document is a
decision. An implementer who finds that the code contradicts it stops and asks; nobody improvises. Where a line number
is given it is as of `1ad0d408`; search for the quoted symbol if it has moved.

How to read it:

- §1–§11 are the design: intent, goals, the decisions and who made them, what main has today, how it works end to
  end, the one registry of names, what the server learns, the threat model and copy in brief, and compatibility.
- §12 is release, docs and gates. §13 is the one task list, in dependency order, with lanes, tiers and tests.
- §14 is the open questions (only Jonas can decide them; each has a recommendation). §15 is the three biggest risks.
- Appendix K (Rust core), Appendix S (server), Appendix C (client-core), Appendix U (web, ui and copy) and Appendix P
  (protocol text to paste) hold the per-layer recipes: signatures, SQL, CBOR shapes, truth tables, copy and test lists.
  References into them read `§K.4`, `§S.3.2`, `§C.5`, `§U.2`, `§P.3`.

Markers: **(Jonas)** is Jonas's decision. **(my call)** is the designer's call; each is listed in §5.2 so it can be
reviewed, and the ones only Jonas can overturn are repeated in §14.

## Contents

1. [Intent](#1-intent)
2. [Goals](#2-goals)
3. [Non-goals](#3-non-goals)
4. [Anti-goals](#4-anti-goals-failure-even-if-it-works)
5. [Decisions](#5-decisions)
6. [What exists on main](#6-what-exists-on-main-recon-of-1ad0d408)
7. [How it works, end to end](#7-how-it-works-end-to-end)
8. [Names: the one registry](#8-names-the-one-registry)
9. [What the server sees](#9-what-the-server-sees)
10. [Threat model and copy, in brief](#10-threat-model-and-copy-in-brief)
11. [Compatibility, rollback and the store schema](#11-compatibility-rollback-and-the-store-schema)
12. [Release, docs and gates](#12-release-docs-and-gates)
13. [Tasks](#13-tasks)
14. [Open questions](#14-open-questions)
15. [Risks](#15-risks)
- [Appendix K: Rust core](#appendix-k-rust-core)
- [Appendix S: server](#appendix-s-server)
- [Appendix C: client-core](#appendix-c-client-core)
- [Appendix U: web, ui and copy](#appendix-u-web-ui-and-copy)
- [Appendix P: protocol text](#appendix-p-protocol-text)

---

## 1. Intent

Today a browser holds only the messages it received itself. The README says it plainly: "Messages sent before a new
browser joins are not shown there", and the sign-in's done step says "Messages sent before now are not shown here."
Jonas wants what Messenger's encrypted backup gives: you sign in on a new browser, you enter your recovery key (which
sign-in already requires), and your conversations are there, as far back as any of your browsers could read them. The
server stores that history and must never be able to read it.

The rule for every open choice: **the history is a faithful copy of what your browsers show**. A message deleted for
everyone disappears from it; an edit shows as edited; a reaction, pin, reply or thread link comes back as it was; a
message your browsers could not read or would not show is not in it. The one honest cost is stated wherever the
feature is: a leaked recovery key now also opens your stored history.

## 2. Goals

1. **Restore at sign-in.** A browser that signs in with the recovery key restores the account's saved history into its
   local store, newest first, while the app is already usable. Progress shows in Settings → Privacy and at the top of a
   conversation whose older messages are still coming.
2. **Everything (Jonas).** Every message any of your browsers could read (shown, or folded onto a message as an edit,
   delete, reaction, pin or unpin) in a `text` group: channels, DMs and group DMs, back to the oldest message any of
   your browsers holds.
3. **Attachments: keys only (Jonas).** The saved message carries its attachment elements (blob id, key, nonce, size,
   type, name, sealed thumbnail) inside the envelope. No file bytes are copied; the encrypted blob stays where it is.
   Old files open while the server keeps them.
4. **On for everyone by default (Jonas).** Settings → Privacy turns it off, which deletes the saved history from the
   server (after a step-up), and on again.
5. **The server cannot read it.** Entries are sealed to a key pair derived from the recovery key. The server sees opaque
   ids, padded sizes and upload order (§9), nothing that names a group, a person or a time.
6. **Deletes are honoured.** A message deleted for everyone, its edits, and anything a trust check retracts are deleted
   from the saved history by your own browsers, which hold a per-entry delete token the server checks; the server keeps
   the id as deleted so no late browser can put it back.
7. **No duplicates.** Several browsers save the same message under the same keyed id, and the server keeps the first.
   A restored row never collides with a row the browser received live.
8. **Honest copy.** protocol/08, Settings → Privacy, the sign-up's recovery-key step, the user docs and the release
   notes all state the trade-off in the same words (§10, §U.4).

## 3. Non-goals

- **History for new members of a channel.** A separate, later feature (Jonas). Nothing here shares one user's history
  with another user.
- **Copying attachment bytes.** Keys only (Jonas). A file the server has purged (retention, or its sender deleted it)
  does not open after a restore, exactly as it does not open today.
- **Server-readable channels** (`09` § Readable channels). The instance stores those itself and serves them to any
  member; they are not saved.
- **Calls, call groups, pairing and interaction groups.** No envelopes to save (`call`, `pairing`), or no shipping
  client (`interaction`).
- **Native devices and pairing.** No native client ships. The pairing payload (`03` § Pairing) is unchanged; a device
  enrolled by pairing gets the history keys the first time its person enters the recovery key on it.
- **Recovery-key rotation.** The recovery key is never rotated today (`06` § Header: the root object is insert-only).
  This design neither adds rotation nor blocks it (§7.8).
- **Restoring MLS state.** Never: it would clone a leaf (`06` § Archive's original reason, kept).

## 4. Anti-goals (failure even if it works)

- Any server-side value that names a group, channel, DM, sender, message id, sequence number or message time next to
  a saved entry.
- A browser that keeps the history's **read** key after its restore finished (my call, §5.2 D4; §14 Q1).
- A deleted-for-everyone message that a later browser restores and shows.
- A restored message raising an unread badge, a mention badge, a desktop notification or a sound.
- A restored row that replaces or duplicates a row the browser received live.
- Any UI string with "encrypted", "encryption", "end-to-end", "E2EE" or "MLS" (`check:copy`), or "secure", "safe",
  "protected" or "!" (the flow tests' rule), even in `history.ts`.
- A store schema bump that makes a client rollback lock people out (§11).

## 5. Decisions

### 5.1 Jonas's decisions

| # | Decision |
|---|---|
| J1 | **Your own new browsers get your history** once you enter the recovery key at sign-in. The server must never be able to read it. |
| J2 | **How far back: everything** any of your browsers could read. |
| J3 | **Attachments: keys only.** The archive stores each attachment's decryption key and reference; the blob stays where it is. Old files open while the server keeps them. |
| J4 | **On for everyone by default.** Settings → Privacy can turn it off and delete the archive. |
| J5 | **Out of scope:** history for new members of a channel. |
| J6 | **Built by cheap models from recipes:** sonnet for specified tasks, haiku for strings and docs, opus only for the E2EE-critical implementation and all key reviews. |

### 5.2 My calls

| # | Decision |
|---|---|
| D1 | **Four new keys from the recovery key**, by protocol/03's derivation (`HKDF-SHA256(salt = "", IKM = RK, info, L = 32)`): `info = "dilla history key v1"` seeds an X25519 HPKE key pair (`SK_hist`, `PK_hist`, RFC 9180 `DeriveKeyPair`); `"dilla history auth v1"` gives `K_hauth`; `"dilla history id v1"` gives `K_hid`; `"dilla history delete v1"` gives `K_hdel`. `K_header` and `K_backup` are unchanged and not used by history: `K_backup` seals the state object, the device-list rollback floor, and must not spread to every browser. |
| D2 | **Write keys and a read key.** The **write keys** (`PK_hist`, `K_hauth`, `K_hid`, `K_hdel`) live in every browser that entered the recovery key, in its encrypted store; they seal, name and delete entries but cannot open one. The **read key** `SK_hist` exists only while a restore that this browser started is running (§7.4), then is erased. A stolen browser store therefore opens only that browser's own messages, never the saved history of all your browsers. |
| D3 | **One sealing per upload, a key per batch.** Each upload is one HPKE base-mode setup to `PK_hist` (suite X25519 / HKDF-SHA256 / AES-256-GCM), whose exported secret, salted with `K_hauth`, is the batch's AES-256-GCM key. Rows carry their batch's `enc`. Only a holder of `SK_hist` opens a row; only a holder of `K_hauth` makes one that opens (the server, which may learn `PK_hist`, cannot forge one). |
| D4 | **The read key is erased when the restore finishes**, or 7 days after it started, or when history is turned off, or at sign-out. A later "restore again" asks for the recovery key again. (§14 Q1 asks Jonas to confirm.) |
| D5 | **One entry per message, not segments.** The unit is one DS row: one `(group_id, seq)`, one entry, immutable. Posts and every fold (edit, delete, reaction add/remove, pin, unpin) are their own entries, exactly as the local store keeps them. Dedupe, delete and "append" need no read-modify-write and no conflict resolution. Rejected: per-conversation or time segments (they need the read key on every writer to rewrite a segment for a delete, and a merge protocol between browsers writing the same segment; they also tell the server which entries are one conversation). |
| D6 | **Entry ids are keyed hashes.** `entry_id = HMAC-SHA256(K_hid, "dilla history entry id v1" ‖ group_id ‖ seq_be8)[0..16]`. Every browser of the account computes the same id for the same DS row, so the server dedupes without learning the group or the sequence number. |
| D7 | **Append-only, first writer wins, deletes are final.** The server keeps the first row stored for an id and drops later ones; a delete removes the row and keeps the id as deleted for ever (per generation, §7.5), so a late browser cannot put it back. A saved entry is never rewritten. |
| D8 | **Deletes need the entry's delete token.** Each stored entry carries `del_hash = SHA-256("dilla history delete hash v1" ‖ del_token)[0..16]`, where `del_token = HMAC-SHA256(K_hdel, "dilla history delete token v1" ‖ entry_id)[0..16]`. A delete names the id and its token. A stolen session, which holds no `K_hdel`, cannot delete history entry by entry. |
| D9 | **What is saved is decided by SQLite triggers on `app_messages`**, so every path that shows, folds, releases, deletes or retracts a row is covered without touching each call site: a row that becomes shown (status 0, envelope present, type 0–6, `text` group) queues a put; a shown row whose envelope is dropped (status 2, a retraction to status 1, blanked edits) queues a delete; a deletion marker for a sequence never stored queues a delete. A local group deletion (leaving, a resync) deletes nothing from history. |
| D10 | **Restore merges below the live floor only, and never replaces a row.** A restored entry is stored only when its group is held, its seq is below the group's `next_seq` (live sync owns everything from there), and no row is stored at `(group_id, seq)`. It goes through the same insert, fold and search-index path as a decrypted row, never re-queues itself, and raises the group's read marker so it counts toward no unread or mention badge. |
| D11 | **Restored messages carry the saving browser's trust verdict.** The archive holds plaintext, not MLS messages, so signatures cannot be checked again. A restored row keeps its sender's user, device and authenticated signature key; any verdict this browser later records for that key retracts it as it would a live row, and a row whose sender key this browser already holds a failed verdict for is skipped. No per-message mark (Discord and Messenger show none); Settings → Privacy says the browser that saved the messages checked them. |
| D12 | **Entries of groups this browser does not hold yet are parked** (in its encrypted store) and merged when the group arrives; parked rows older than 30 days are dropped (they belong to conversations you left). |
| D13 | **Restore runs newest first**, then catches up what was saved while it ran, then finishes. A restore is resumable across reloads from a cursor in the store. |
| D14 | **The account switch lives on the server** (`history_state`: enabled and a generation). Turning off deletes every entry and every deleted-id record and bumps the generation; turning on bumps it again. A browser that sees a new generation drops its queue and, when history is on, queues everything it holds (a backfill). Uploads name the generation; a stale one is `409 E_HISTORY_STALE`. |
| D15 | **Turning history off needs a step-up**, as account deletion does: it deletes data of every browser of the account. Turning it on does not. |
| D16 | **Existing browsers save once their person enters the recovery key** in Settings → Privacy ("enter recovery key"), which also restores. A banner tells them until they have seen that section once (§14 Q2). New sign-ups get the write keys at sign-up; every sign-in gets them at the key step. |
| D17 | **No store schema bump.** The new client tables and triggers are additive and created on every open, as web-3.5's three tables were; schema stays 5, so a client rollback opens the store (§11). |
| D18 | **Quotas.** `history.quota_bytes_per_user` (default 1 GiB; 0 turns history off on the instance) and `history.upload_bytes_per_day` per device (default 256 MiB). A full history stops saving new entries (`507`) and says so; nothing old is dropped (§14 Q3). |
| D19 | **Padding.** Each entry's plaintext is padded with zero bytes to a multiple of 256, as message ciphertexts are, so a short post and a reaction are the same size. |
| D20 | **No time is stored with an entry.** The server orders rows by an upload counter `n` and keeps no timestamp per entry. |
| D21 | **The history's vectors are frozen from the Rust core** (`protocol/vectors/history.json`), as `permissions.json` is frozen from Go: the TS generator has no X25519 HPKE. |
| D22 | **New routes, not the backups routes.** `/v1/backups` stays the two header objects; history gets `/v1/history` (§8.3). The unserved chunk archive of `06` § Archive and its SSK-signed manifest are retired: a browser holds no SSK and could never sign one. |
| D23 | **Migration numbers.** On main the next free pair is `00024` / schema `022`. Voice moderation (`00024`/`022`) and calls-survive-upgrade (`00025`) merge first, so this design writes `00026_history_archive.sql` and schema file `024_history_archive.sql`; whoever merges this renumbers to the next free pair at rebase and updates `TestHistoryArchiveMigrationIsSchemaVersion26` to match. |
| D24 | **Account deletion deletes history** in the same transaction as the tombstone. The operator's revoke-all (`dillad admin … revoke-devices`) keeps it: it is the recovery reset, after which the person restores with the key. |
| D25 | **Copy lives in a new `strings/history.ts`**, not in `privacy.ts` (the one file `check:copy` exempts), so the forbidden-word lint covers it. |
| D26 | **Model tiers.** Opus implements K1 (crypto) and K2 (store triggers, queue and restore merge); opus reviews K1, K2, S3, S5 and the final branch. Everything else is sonnet; strings and docs are haiku (§13.2). |

### 5.3 Rejected alternatives

| Alternative | Why not |
|---|---|
| One symmetric `K_history` on every browser | Every browser store would then open the saved history of all browsers: a stolen or script-injected browser leaks everything, not just itself. D2 costs one X25519 operation per upload. |
| Keys sealed to the UMK (Ed25519 converted to X25519) | Would let existing browsers save without the recovery key, but the instance knows every UMK and could forge entries; cross-protocol key use of the identity root. |
| Store per-message MLS keys instead of plaintext | OpenMLS exposes no per-message keys, the DS deletes delivered ciphertext after at most 30 days (`PruneAppMessages`), and a new browser is not a member of old epochs. |
| Clear `(group_id, seq)` row keys so the server drops rows on a DS delete | The DS deletes the message row itself within 30 days; clear keys would keep per-message group, sequence and size metadata for ever, past the DS's own retention (§9). Deletes are done by the browsers instead (D8, D9). |
| Re-verify restored rows | Impossible: the archive holds plaintext; MLS signatures need the epoch's group context and the framed content, which no device keeps. |
| Restore into a fresh "history" view separate from the timeline | Two timelines for one conversation; search and folds would need a second engine. D10 merges into the one store. |

## 6. What exists on main (recon of `1ad0d408`)

Only what this design touches.

- **Recovery key and derived keys.** `core/dilla-core/src/identity/recovery.rs`: `k_header`, `k_backup` with
  `INFO_HEADER = b"dilla header v1"` and `INFO_ARCHIVE = b"dilla archive v1"` (`identity/mod.rs:43-45`), via
  `hkdf_sha256(Some(&[]), rk, info, out)` (`identity/mod.rs:125`). Vectors `recovery_key.k_header`/`k_backup` in
  `protocol/vectors/identity.json` from `rk = 0x0b × 32`.
- **Where the recovery key is entered.** `ClientCore::signup_begin` (`client/identity.rs:716`, generates RK, shows it
  once), `enrol_complete` (`:1157`, the sign-in key step, through `recover()` at `:423`, which opens the root object
  under `K_header` and the state object under `K_backup`), and `device_list_revoke` (`:1257`, removing a device with
  the key). The TS side is `account/enrol.ts` (`Enrol.complete`) and `worker/controller.ts` `signInKey` (`:2117`) →
  `enrolWithKey`.
- **HPKE.** `openmls_traits 0.6.0` `OpenMlsCrypto` has `derive_hpke_keypair`, `hpke_setup_sender_and_export` and
  `hpke_setup_receiver_and_export`, implemented by `openmls_rust_crypto 0.6.0` (already a dependency); `HpkeConfig(
  HpkeKemType::DhKem25519, HpkeKdfType::HkdfSha256, HpkeAeadType::AesGcm256)`. No new crate.
- **The local store** (`client/schema.rs`, `APP_SCHEMA_SUPPORTED = 5`): `app_messages` keyed `(group_id, seq)`, status
  0 ok / 1 unreadable / 2 deleted, `envelope` set only on a status-0 row, `type` 0–6 (255 = upload-class mismatch),
  `sender_user`, `sender_device`, `sender_sig_key`, `sender_kind`, `sender_tier`, `franking_tag`, `recv_ts`, `epoch`.
  Every path that drops content sets `envelope = NULL`: delete-wins (`fold.rs:262`), blanked edits
  (`fold.rs:122,128,163,211`), DS deletion (`sync.rs:201,626`), trust retraction (`trust.rs:410`). New tables are
  added by the idempotent every-open block in `migrate_conn` (`schema.rs`, "Every supported store runs this block").
  `insert_message` (`messages.rs:145`) indexes search; `refold_insert` (`messages.rs:185`) folds.
- **Held rows** wait in `app_pending_history`, not in `app_messages`, until released.
- **Group kinds** (`01` § Group kinds): `text` 0, `call` 1, `pairing` 2, `interaction` 3 (`app_groups.kind`).
- **The DS keeps delivered messages at most 30 days** (`PruneAppMessages`, `internal/store/sqlite/queries/messages.sql`);
  a DS delete keeps the row's metadata and drops its ciphertext (`TombstoneAppMessage`).
- **Backups routes** (`internal/api/backups.go`, `09` § Backups): kinds 0 and 1 only; kind 2 (chunks) answers 404. The
  `backups` table allows kind 2 but nothing writes it. `06` § Archive (chunks and an SSK-signed manifest) was never
  served.
- **Server pieces reused:** `LockUserForDeviceRegistration` (the per-user lock), `requireStepUp` (`internal/api/auth.go:1520`),
  `NewStateMeter` (`internal/api/blobmeter.go:58`, a per-key daily byte budget), `dsMeter` buckets in
  `internal/api/api.go:253-256`, `DumpTables` and `DumpPostgres` (`internal/store/dump.go`, buffers each table in
  memory), `dumpRowCounts` (`internal/ops/restore.go:730`, `counts[table] = n`), doctor legs (`internal/ops/doctor.go`,
  `cmd/dillad/doctor.go`, `internal/dillad/diagnostics.go`), `DeleteMe` (`internal/api/accounts.go:349`, tombstones in
  one transaction), `RevokeAllDevices` (`internal/ops/revoke_devices.go`).
- **Migrations** end at `00023_device_labels.sql`, schema files at `021_device_labels.sql`.
- **Web.** `packages/web/src/screens/settings/Privacy.tsx` (the trust list), `KeyDialog.tsx` and `StepUpDialog.tsx` in
  the same folder, `ConfirmDialog`, `Toggle`, `SettingsRow` and `Banner` in `@dilla/ui`. Strings in
  `packages/web/src/strings/*.ts`, merged in `en.ts`, pinned by `strings.flowNN.test.ts` against
  `docs/design/flows/NN-*.md`; flow 18 is voice moderation's, so this is **flow 19**. `check:copy`
  (`scripts/check-ui-copy.mjs`) exempts only `strings/privacy.ts`.
- **Copy to change:** `signin.done.body` ("Messages sent before now are not shown here."),
  `onboarding.browser.oneBrowser` ("Messages sent before that browser joins are not shown in it."), `shell.log.empty`,
  the README "what works" sentence "Messages sent before a new browser joins are not shown there.", and
  `docs/user/getting-started.md` lines 108, 652, 701, 856. `perm.history.hint` (about new members) stays true and
  stays.

## 7. How it works, end to end

### 7.1 Keys

From the recovery key `RK` (32 bytes), wherever it is entered:

```
seed     = HKDF-SHA256(salt = "", IKM = RK, info = "dilla history key v1",    L = 32)
SK_hist, PK_hist = DeriveKeyPair(seed)          ; RFC 9180 §7.1.3, DHKEM(X25519, HKDF-SHA256)
K_hauth  = HKDF-SHA256(salt = "", IKM = RK, info = "dilla history auth v1",   L = 32)
K_hid    = HKDF-SHA256(salt = "", IKM = RK, info = "dilla history id v1",     L = 32)
K_hdel   = HKDF-SHA256(salt = "", IKM = RK, info = "dilla history delete v1", L = 32)
```

- **Sign-up** (`signup_begin`, which generates RK): the browser stores the write keys. Nothing to restore.
- **Sign-in key step** (`enrol_complete`): the browser stores the write keys and a **restore record** holding
  `SK_hist` and the restore's cursor.
- **Removing a device with the key** (`device_list_revoke`): the write keys are stored if absent; no restore.
- **Settings → Privacy → enter recovery key** (`history_unlock`): the key is checked by opening the account's root
  object; the write keys are stored if absent and a fresh restore record is written.

The key is the same every time it is entered, so every derivation is the same: entering it again is idempotent.

### 7.2 Saving (the write path)

1. A row of a `text` group becomes shown in `app_messages` (a decrypted message or fold, this browser's own send at
   `send_confirm`, a held row released). The trigger `app_history_put` queues `(group_id, seq, op 0)` in
   `app_history_out`, in the same storage unit as the row.
2. The uploader in the worker flushes when 256 operations are queued, or 20 s after the oldest unflushed one, or at
   each ready. `history_take(512, 1_000_000)` builds one batch: one HPKE setup, one sealed row per put (with its
   `del_hash`), one `[entry_id, del_token]` per delete, at most 512 puts and 1 000 000 bytes of rows.
3. `POST /v1/history/entries [generation, entries]` stores the puts; the server keeps the first row per id and drops
   later ones and deleted ids. `POST /v1/history/entries/delete [generation, items]` sends the deletes. On success of
   both, `history_done(taken)` removes exactly the queue rows taken (a row queued again meanwhile has a new `n` and
   stays).
4. Every browser of the account does this for every message it shows. The server keeps one copy; the others are
   dropped as duplicates (D7).

Pacing, retries and offline (§C.4): one request at a time per browser; network errors and 5xx back off 2 s, doubling
to 300 s with ±20 % jitter; `429` waits `retry_after_ms`; `409 E_HISTORY_STALE` re-reads `GET /v1/history` and
applies it; `507` marks the history full and retries at the next ready, at most once an hour; `403` (instance has
history off) stops until the next ready. The queue is in the browser's store, so nothing is lost offline or across
reloads.

### 7.3 Deleting and editing

- **Delete for everyone.** The author's delete (a type-2 envelope from the author, which the author's client also
  sends to the DS) or the DS's deletion (`message.deleted`) makes the local fold drop the target's content
  (`status = 2, envelope = NULL`) and blank the author's edits of it (`envelope = NULL`). The trigger `app_history_drop`
  queues a delete for each of those rows. Every browser of every member deletes from its own user's history what it
  held. A deletion marker for a sequence this browser never stored (`app_history_marker`) queues a delete too.
- **The type-2 envelope itself stays saved.** It carries no content. A later restore stores it and the fold applies it,
  so a target that an older copy of the history brings back (an operator restore from an old backup, §10) is still
  shown as deleted.
- **Late browsers.** A deleted id stays deleted on the server (D7): a browser that comes online later and tries to save
  the message gets it dropped.
- **Edits.** Each edit is its own entry. A restore stores them all; the fold shows the latest from the author, as a
  live browser does. dilla shows no edit history in the UI, so none is restored as a view; the earlier edit entries are
  kept because the local store keeps them, and they go when their target is deleted.
- **Retraction.** A trust verdict that retracts rows (`trust.rs` `retract_matching`: status 1, envelope NULL) queues
  their deletes the same way. A retracted row is never saved again (its id is deleted).
- **Reactions and pins.** Each add, remove, pin and unpin is an entry; the fold decides the state on restore.

### 7.4 Restore

1. **Sign-in.** `enrol_complete` stores the write keys and the restore record. After the first ready, the worker reads
   `GET /v1/history`; when history is available and on, `history_set_server` records the generation and the restore
   runner starts at the end of `refreshAfterReady()` (communities and DMs loaded, joins under way). When history is
   off or unavailable, `history_restore_cancel` erases the read key and the done step's copy says messages from before
   are not shown (§U.3).
2. **Down.** `GET /v1/history/entries?generation=g&limit=512` (newest first), then `&before=<lowest n so far>`, page by
   page. `history_restore_page(rows, now)` opens each row, checks its id, and merges it in one storage unit per page
   (D10): stored when the group is held, `seq < next_seq` and no row exists; parked when the group is not held;
   skipped otherwise; counted as a gap when it does not open, its id does not match its content, or its envelope does
   not decode. Each stored row goes through `insert_message` and `refold_insert`, is removed from `app_history_out`,
   and raises `app_read_state.last_read_seq` to at least its seq. The worker refreshes the open timelines of the groups
   a page touched.
3. **Up.** When a down page comes back empty, the runner reads `&after=<top>` ascending (where `top` is the newest `n`
   it saw first) until empty: what other browsers saved while the restore ran.
4. **Done.** The core erases the restore record and the read key with it. The slice says "Message history restored:
   N messages added to this browser." Parked rows are merged at every ready (`history_unpark`).
5. **Resumable.** The cursor (`phase`, `before`, `top`) is in the restore record; a reload or a lost connection resumes
   from it. A restore not finished 7 days after it started is stopped and its read key erased; Privacy offers "enter
   recovery key" to finish.
6. **Live sync.** Rows at or above `next_seq` are never restored (live sync delivers them), and a row already stored
   is never replaced, so there are no duplicates and no races: the merge runs in the core's single writer.
7. **Trust.** D11. A row whose sender key this browser holds a failed verdict for (`app_quarantine`) is skipped.

### 7.5 Turning history off and on

- **Off** (Settings → Privacy): the toggle opens a confirmation, then a step-up (password, app code, backup code or
  passkey, through the existing `StepUpDialog`). `PUT /v1/history [0, stepup]` deletes every entry and every deleted-id
  record of the account, sets enabled to 0 and bumps the generation, in one transaction, and writes an audit row. Each
  browser learns it at its next ready (or at its next upload, `409 E_HISTORY_STALE`): it drops its queue and its read
  key, and its triggers stop queueing (`history_on` absent).
- **On:** `PUT /v1/history [1, null]` sets enabled and bumps the generation. Each browser with write keys queues
  everything it holds (backfill) on seeing the new generation.
- **Instance off** (`history.quota_bytes_per_user = 0`): `GET /v1/history` answers quota 0, every browser treats
  history as unavailable, `PUT /v1/history [1, …]` is `403 E_FORBIDDEN`. Rows already stored stay until each person
  turns history off; the doctor's `history` leg warns (§S.7).

### 7.6 Existing browsers

A browser that signed up or signed in before this release holds no write keys. Its triggers do not queue
(`history_on` is absent until keys exist). Privacy shows "This browser is not saving its messages yet…" with **enter
recovery key**; a banner points there until the person has seen the section once (§14 Q2, §U.3). Entering the key stores the write keys, queues a
backfill of everything the browser holds, and restores what other browsers saved.

### 7.7 Account deletion and the operator

- `DELETE /v1/accounts/me` deletes the account's `history_state`, entries and deleted ids in its transaction (D24).
- The operator's revoke-all keeps history (D24).
- `dillad backup` carries the three tables like any other; on Postgres the entries table is written in records of at
  most 65 536 rows so the dump never buffers a whole history in memory (§S.6). `dillad restore` restores them; its
  dry run sums repeated records.
- The doctor gains a `history` leg (§S.7).

### 7.8 Re-entering and rotating the recovery key

Re-entering the key (another sign-in, a device removal, "restore again") derives the same keys: nothing changes but a
new restore record. **The recovery key is never rotated today**, and this design adds no rotation. If one is added, it
needs a device holding the old `SK_hist` to re-seal every entry under the new keys, or a new generation (the off/on
path) followed by backfills; the `v1` labels and the generation counter leave room for either.

## 8. Names: the one registry

Every layer uses exactly these spellings. Nothing else names these things.

### 8.1 Keys and labels

All labels are ASCII, written without a terminating byte; `‖` is concatenation; `seq_be8` is the DS sequence number
as 8 bytes big-endian.

| Thing | Value |
|---|---|
| HKDF info, HPKE seed | `"dilla history key v1"` → `seed` → `SK_hist`, `PK_hist` (RFC 9180 `DeriveKeyPair`) |
| HKDF info, auth key | `"dilla history auth v1"` → `K_hauth` |
| HKDF info, id key | `"dilla history id v1"` → `K_hid` |
| HKDF info, delete key | `"dilla history delete v1"` → `K_hdel` |
| Entry id | `HMAC-SHA256(K_hid, "dilla history entry id v1" ‖ group_id ‖ seq_be8)[0..16]` |
| Delete token | `HMAC-SHA256(K_hdel, "dilla history delete token v1" ‖ entry_id)[0..16]` |
| Delete hash | `SHA-256("dilla history delete hash v1" ‖ del_token)[0..16]` |
| HPKE suite | DHKEM(X25519, HKDF-SHA256) `0x0020`, HKDF-SHA256 `0x0001`, AES-256-GCM `0x0002`; base mode |
| HPKE info | `"dilla history v1" ‖ user_id` |
| HPKE exporter context | `"dilla history batch v1"`, length 32 → `exported` |
| Batch key | `K_batch = HKDF-SHA256(salt = K_hauth, IKM = exported, info = "dilla history batch key v1", L = 32)` |
| Row AEAD | AES-256-GCM, key `K_batch`, random 12-byte nonce per row, `aad = "dilla history entry v1" ‖ user_id ‖ entry_id` |
| Padding | zero bytes after the entry CBOR to the next multiple of 256 (`PAD_TO = 256`) |
| Rust constants (`core/dilla-core/src/history.rs`) | `INFO_KEY`, `INFO_AUTH`, `INFO_ID`, `INFO_DELETE`, `ID_LABEL`, `TOKEN_LABEL`, `HASH_LABEL`, `HPKE_INFO`, `EXPORT_CONTEXT`, `BATCH_KEY_INFO`, `AAD_LABEL`, `PAD_TO = 256`, `ROW_MAX = 81_920`, `BATCH_MAX = 512`, `SUITE` |

### 8.2 Formats

```
entry (plaintext, before padding) = CBOR [
  v,               ; uint, = 1
  group_id,        ; bstr 16
  seq,             ; uint, the DS sequence number
  epoch,           ; uint, the MLS epoch the row was sent in
  recv_ts,         ; uint, the DS receive time, unix seconds
  sender_user,     ; bstr 16
  sender_device,   ; bstr 16
  sender_sig_key,  ; bstr 32 or null (null for a row stored before the key was kept)
  sender_kind,     ; uint: 0 user, 1 bot
  sender_tier,     ; uint: 0 native, 1 browser
  franking_tag,    ; bstr 32
  envelope         ; bstr: the 04 envelope CBOR, as stored (attachment keys and blob ids inside)
]
padded = entry ‖ 0x00 × p, with p ≥ 0 the least making len(padded) a multiple of 256

row (stored) = CBOR [ v = 1, enc (bstr 32), nonce (bstr 12), ciphertext (bstr, ≥ 16) ], len(row) ≤ 81 920
```

Device-local records in `app_meta` (CBOR):

| Key | Value |
|---|---|
| `history_keys` | `[1, pk_hist (bstr 32), k_hauth (bstr 32), k_hid (bstr 32), k_hdel (bstr 32)]` |
| `history_on` | `uint`: the generation history was on at; present only while this browser has keys and the server said on |
| `history_gen` | `[generation (uint), enabled (uint 0\|1)]`: the last server state applied |
| `history_backfill` | `[]` (the empty array): present when keys were just installed and the next `history_set_server` must queue a backfill |
| `history_restore` | `[1, sk_hist (bstr 32), phase (uint 0 down \| 1 up), before (uint\|null), top (uint\|null), done (uint), gaps (uint), merged (uint), started (uint, unix s)]` |

### 8.3 Routes and errors

All `E` (an enrolled session), deterministic CBOR (`09` § Encoding). Full rules in §S.4 and §P.4.

| Route | Body | Answer | Bucket |
|---|---|---|---|
| `GET /v1/history` | — | `[enabled(uint 0\|1), generation(uint), entries(uint), bytes(uint), quota(uint)]` | read |
| `PUT /v1/history` | `[enabled(uint 0\|1), stepup(tstr\|null)]` | `200 [enabled, generation]` | write |
| `POST /v1/history/entries` | `[generation(uint), entries([[entry_id(bstr 16), del_hash(bstr 16), row(bstr)]])]`, 1–512 entries | `200 [stored(uint), dropped(uint)]` | write, plus the device's history byte budget |
| `POST /v1/history/entries/delete` | `[generation(uint), items([[entry_id(bstr 16), del_token(bstr 16)]])]`, 1–1024 items | `200 [deleted(uint), refused(uint)]` | write |
| `GET /v1/history/entries?generation=&before=&after=&limit=` | — | `[[n(uint), entry_id(bstr 16), row(bstr)]]`; newest first without `after`, ascending with it | read |

| Code | Status | Where |
|---|---|---|
| `E_HISTORY_STALE` (**new**, Go `server.CodeHistoryStale`) | 409 | the request's `generation` is not the account's, or history is off (stored off, or quota 0); on the two entry `POST`s and the entries `GET` |
| `E_INVALID_REQUEST` | 400 | bad body or query: shapes, lengths, counts, both `before` and `after`, `limit` outside 1–512, a missing `generation` |
| `E_TOO_LARGE` | 413 | a body over its cap (§S.4.1) |
| `E_STEP_UP` | 403 | `PUT /v1/history [0, …]` without a valid step-up token |
| `E_FORBIDDEN` | 403 | a pending session; `PUT /v1/history [1, …]` while the instance quota is 0 |
| `E_STORAGE_FULL` | 507 | the entries would take the account past `history.quota_bytes_per_user`; nothing is stored |
| `E_RATE_LIMITED` | 429 | the session's bucket or the device's history byte budget |

### 8.4 Server

| Thing | Name |
|---|---|
| Tables | `history_state (user_id, enabled, generation, entries, bytes, updated)`, `history_entries (n, user_id, entry_id, del_hash, row)`, `history_tombstones (user_id, entry_id)` |
| Files | `internal/store/{sqlite,postgres}/migrations/00026_history_archive.sql`, `…/schema/024_history_archive.sql`, `…/queries/history.sql` (D23: renumber at rebase) |
| sqlc | `GetHistoryState`, `UpsertHistoryState`, `GetHistoryEntryHash`, `HistoryTombstoned`, `InsertHistoryEntry`, `DeleteHistoryEntry`, `InsertHistoryTombstone`, `ListHistoryEntriesBefore`, `ListHistoryEntriesAfter`, `DeleteHistoryEntriesOfUser`, `DeleteHistoryTombstonesOfUser`, `DeleteHistoryStateOfUser`, `HistoryTotals`, `HistoryUsersAtOrOver` |
| Store types | `store.HistoryState{Enabled bool; Generation uint64; Entries int64; Bytes int64}`, `store.HistoryPut{EntryID, DelHash, Row []byte}`, `store.HistoryRow{N int64; EntryID, Row []byte}`, `store.HistoryTotals{People, Entries, Bytes, NearFull int64}` |
| Store methods (`store.HistoryStore`, embedded in `Repository`) | `GetHistoryState`, `PutHistoryState`, `GetHistoryEntryHash`, `HistoryTombstoned`, `InsertHistoryEntry`, `DeleteHistoryEntry`, `InsertHistoryTombstone`, `ListHistoryEntries`, `DeleteHistoryOfUser`, `HistoryTotals` |
| API (`internal/api/history.go`, new) | handlers `GetHistory`, `PutHistory`, `PostHistoryEntries`, `PostHistoryDeletes`, `ListHistoryEntries`; helpers `historyEffective`, `decodeHistoryRow`, `historyQuota`; field `Deps.HistoryMeter *UploadMeter`; constants `historyRowMax = 81920`, `historyPutMax = 512`, `historyDeleteMax = 1024`, `historyPageMax = 512`, `historyPageBytes = 1 << 20`, `historyPutBodyCap = 1<<20 + 4096` |
| Config | `[history]` `quota_bytes_per_user` (1073741824), `upload_bytes_per_day` (268435456); Go `config.History{QuotaBytesPerUser, UploadBytesPerDay int64}` |
| Audit actions | `history.off`, `history.on` |
| Doctor | `ops.HistoryLeg(ctx, repo, cfg) Leg`, leg name `history` |

### 8.5 Rust core

| Thing | Name |
|---|---|
| Pure crypto (`core/dilla-core/src/history.rs`, `pub mod history;` in `lib.rs`) | `HistoryKeys {sk, write}`, `WriteKeys {pk, k_auth, k_id, k_del}`, `derive_keys`, `entry_id`, `delete_token`, `delete_hash`, `Entry`, `Entry::encode_padded`, `Entry::decode_padded`, `SealBatch::new`, `SealBatch::seal`, `OpenCache`, `open_row`, `HistoryError {Shape, Open, Id}` |
| Store side (`core/dilla-core/src/client/history.rs`, new) | `schema::APP_HISTORY`; triggers `app_history_put`, `app_history_release`, `app_history_drop`, `app_history_marker`; tables `app_history_out`, `app_history_parked`; meta keys `schema::HISTORY_KEYS`, `HISTORY_ON`, `HISTORY_GEN`, `HISTORY_BACKFILL`, `HISTORY_RESTORE`; helpers `install_history_keys`, `queue_backfill`, `merge_entry`, `RestoreRecord`; `ClientCore::history_status`, `history_set_server`, `history_unlock`, `history_take`, `history_done`, `history_restore_page`, `history_restore_state`, `history_restore_cancel`, `history_unpark` |
| Constants | `PARK_TTL_S = 2_592_000` (30 days), `PARK_MAX = 200_000`, `RESTORE_TTL_S = 604_800` (7 days), `TAKE_MAX_ROWS = 512`, `TAKE_MAX_BYTES = 1_000_000`, `OPEN_CACHE = 64` |
| wasm facade (`core/dilla-core-wasm/src/facade.rs`) | `history_status`, `history_set_server`, `history_unlock`, `history_take`, `history_done`, `history_restore_page`, `history_restore_state`, `history_restore_cancel`, `history_unpark` |
| Vectors | `protocol/vectors/history.json`; test `core/dilla-core/tests/history_vectors.rs` |

### 8.6 client-core

| Thing | Name |
|---|---|
| CorePort (`core-port.ts`) | `historyStatus(now)`, `historySetServer(enabled, generation)`, `historyUnlock({recoveryKey, rootSealed, now})`, `historyTake(maxRows, maxBytes)`, `historyDone(taken)`, `historyRestorePage(rows, now)`, `historyRestoreState()`, `historyRestoreCancel()`, `historyUnpark(now)`; types `HistoryCoreStatus`, `HistoryTake`, `HistoryRestoreResult`, `HistoryRestoreState` |
| Routes (`http/routes.ts`) | `getHistory(): Promise<HistoryInfo>`, `setHistory(enabled, stepup): Promise<HistorySet>`, `postHistoryEntries(generation, entries): Promise<HistoryStored>`, `postHistoryDeletes(generation, items): Promise<HistoryDeleted>`, `getHistoryEntries(generation, cursor, limit): Promise<HistoryPageRow[]>` |
| Error | `E_HISTORY_STALE` in `http/errors.ts`'s known codes |
| Modules (new) | `packages/client-core/src/history/state.ts` (`HistoryState`), `history/uploader.ts` (`HistoryUploader`), `history/restore.ts` (`HistoryRestore`), `history/slice.ts` (`historySlice`, `HistorySlice`) |
| Commands (`worker/protocol.ts`) | `historyRefresh` (ready → null), `historySetEnabled {on: boolean; stepup: string \| null}` (ready → null), `historyUseKey {recoveryKey: string}` (ready → null) |
| Slice | `history`: `HistorySlice` (§C.6); the timeline slice gains `restoring: boolean` |
| Constants (`history/uploader.ts`, `history/restore.ts`) | `FLUSH_OPS = 256`, `FLUSH_AFTER_MS = 20_000`, `BACKOFF_MIN_MS = 2_000`, `BACKOFF_MAX_MS = 300_000`, `FULL_RETRY_MS = 3_600_000`, `PAGE_LIMIT = 512` |

### 8.7 Web and ui

| Thing | Name |
|---|---|
| Component | `packages/web/src/screens/settings/History.tsx` (`History`), rendered first in `Privacy.tsx` |
| Banner | `packages/web/src/screens/HistoryBanner.tsx` (`HistoryBanner`), pref key `dilla.history.bannerDismissed` (`prefs.ts`) |
| Strings | `packages/web/src/strings/history.ts` (`history.*`, merged in `en.ts`), plus `signin.done.bodyNoHistory`, `onboarding.keys.history`, `shell.log.emptyRestoring`, `shell.log.emptyHistory` in their existing files |
| Flow | `docs/design/flows/19-message-history.md`; test `packages/web/src/strings/strings.flow19.test.ts` |
| e2e | `e2e/web/history.spec.ts` |

No new `@dilla/ui` component: `Toggle`, `SettingsRow`, `Banner`, `Button` and `ConfirmDialog` cover it.

## 9. What the server sees

Per account: whether history is on, a generation counter, the number of entries and their total bytes.

Per entry: a 16-byte keyed id, a 16-byte delete hash, the row's length (the padded plaintext, a multiple of 256, plus
about 70 bytes of framing and tag), the batch's 32-byte `enc` (shared by the rows uploaded together), and its upload
position `n`. No time is stored with an entry. Deleted ids are kept as deleted.

Per request (as for every route, and in its request log): which device uploaded or read, when, and how many entries.

What it cannot learn from what it stores: the group, channel or DM; the sender; the message id or DS sequence number;
the type (post or fold); the message time; the content; the attachment keys.

Whether this is more than it already knows:

- **Live saves link by timing.** An entry saved seconds after the DS delivered a message to that browser is that
  message, to an instance that watches both; batching (20 s or 256 operations) blurs the link within a batch only.
  This is not new knowledge: the DS knew the message, its group and its recipients when it delivered it.
- **Kept longer.** The DS deletes a delivered message's row after at most 30 days (`PruneAppMessages`). The saved
  history keeps, for as long as the account keeps it, how many entries the account saved, their padded sizes and their
  upload order. That is new: a count of the messages and folds you could read and a rough size of each, past the DS's
  own retention. It names no group, person or time.
- **Deletes.** Which ids were deleted, and when the deletes arrived (close to when the delete was folded).
- **Usage.** How much history each person has, and when each browser uploads (which its session activity already
  shows).

protocol/08's metadata bullet states this (§P.3).

## 10. Threat model and copy, in brief

The full protocol text is §P.3; the full copy is §U.4.

- **The trade-off: forward secrecy for stored history.** Before, the recovery key let its holder add a browser and read
  what arrives from then on. Now it also opens every saved entry: all past messages of the account that are still
  saved, to whoever also holds the server's database. A copy of the database taken before a message was deleted (an
  operator's `dillad backup`) still holds that message's entry, and the recovery key opens it. MLS forward secrecy for
  the live conversation is unchanged; the history gives it up for what is saved, by design.
- **A stolen browser** (its store, so its write keys) can add forged entries to its own person's history, attributed
  to anyone, which a later restore shows; and it can delete entries of messages whose group and seq it knows. It cannot
  read the saved history (no read key after the restore). Its own messages are exposed as they are today.
- **A stolen session** (a token, no store) can download rows it cannot open and fill the quota with junk (a denial of
  service, shown as gaps and "full"). It cannot delete entries (no tokens) or turn history off (step-up).
- **The instance** can withhold or drop entries, serve an old copy (bringing back entries deleted since; the saved
  type-2 delete envelope hides an author's deleted message again), or refuse to delete. It cannot read, forge or move
  entries undetectably: the AAD binds the account and the id, and the id binds the group and seq.
- **Restored messages** carry the verdict of the browser that saved them (D11).

Copy, in Settings → Privacy (sentence case for notices, lower case for chrome, none of the forbidden words):

> **Message history**
> *save message history* (toggle)
> Your browsers save the messages they can read to {instance}, locked with a key made from your recovery key. When you
> sign in on a new browser and enter the recovery key, your earlier messages come back there. {instance} cannot read
> them.
> Anyone who has your recovery key can read this saved history, including old messages. Keep the key offline, away from
> this computer.
> Files are not copied. Their keys are saved, so old files open for as long as {instance} keeps them.

Release-note wording (§12, D1): "**Message history (on by default).** Your browsers now save the messages they can read
to your server, sealed under a key that only your recovery key opens, so a browser you sign in to later gets your
earlier messages back. The trade-off: anyone who gets your recovery key can now read that saved history too, including
old messages, where before the key only let them add a browser and read what arrived after. Keep your recovery key
offline. Settings → Privacy turns history off and deletes it from the server. Files are not copied: old files open for
as long as the server keeps them. A browser you used before this release starts saving once you enter your recovery
key in Settings → Privacy."

## 11. Compatibility, rollback and the store schema

- **Wire.** Additive: five routes under `/v1/history`, one error code. No frame, no op, no wire, e2ee or media version
  change (protocol/07 row, §P.6).
- **An old client against a new server** never saves (it does not know the routes). The instance serves the web
  client, so every browser runs the new client after its next reload; an old open tab is told to reload by the existing
  version check.
- **A new client against an old server:** `GET /v1/history` answers 404. The client treats history as unavailable
  (`available: false`): no saving, no restore; the done step and an empty channel keep today's copy; Privacy says
  "{instance} does not save message history."
- **The browser store stays at schema 5** (D17). `app_history_out`, `app_history_parked` and the four triggers are
  created on every open by `APP_HISTORY` in the idempotent block. An older client opening the store ignores the tables;
  the triggers fire on its inserts but queue nothing while `history_on` is absent, and only queue (never upload) while
  it is present, so a rollback of the web client loses nothing and a later upgrade uploads the queue. The deploy
  guide's table gains a row "web3.13 | 5 | **26** | Two additive tables and four triggers in the browser store;
  migration `00026_history_archive`; rolling back to web3.12 needs `migrate down --to=25` with the web3.13 binary
  first and deletes every saved message history".
- **Server rollback.** `migrate down` drops the three tables, and with them every saved history. The release notes and
  the deploy guide say so: "Rolling back deletes every person's saved message history; their browsers keep their own
  messages, and save them again after you upgrade again."
- **Generation after an operator restore.** `dillad restore` restores `history_state` with its generation. A browser
  whose stored generation differs from the restored one backfills (D14): what it holds is saved again. Entries deleted
  after the backup come back as the backup's copy; the saved type-2 envelope hides an author's deleted message again
  on restore, and protocol/08 states the rest (§10).

## 12. Release, docs and gates

- **Schema and rollback** in the release notes (stub by S5, finished by D1): migration `00026_history_archive` adds
  `history_state`, `history_entries` and `history_tombstones`; `migrate down` drops them and every saved history; the
  release-note paragraph of §10 verbatim.
- **Protocol docs** (S5, text in §P): `03` (keys, custody, recovery), `06` (§ History replaces § Archive and
  § Restore), `08` (guarantee, residual trust, metadata), `09` (§ History, body caps, rate limits; § Backups loses the
  chunk wording), `02` (`E_HISTORY_STALE` row and sentence), `07` (row), `vectors/README.md` (row).
- **User docs and README** (D1): `docs/user/getting-started.md` gains "Your message history" (§U.6) and loses the four
  "not shown" sentences; README "what works" replaces "Messages sent before a new browser joins are not shown there."
  with the sentence in §U.6; `docs/deploy/README.md` gains the `[history]` settings, the storage estimate and the
  table row of §11; screenshots re-shot (D2).
- **Gates.**
  - Rust: `cargo test -p dilla-core` (host) and the wasm test build; `cargo clippy` with the workspace lints.
  - Go race tests on both engines (sqlite and Postgres), `sqlc diff`, the contract test, the schema dump,
    `TestDumpTablesNamesEverySchemaTable`.
  - client-core, web and ui vitest; lint, typecheck, `check:copy`, `check:css`, `check:docs`.
  - e2e web suite: `history.spec.ts` on chromium and firefox; `enrol.spec.ts` (its copy updated) on all three.
  - axe on Settings → Privacy in each history state, in all three themes, and at 390 px.
- **Reviews.** Opus reviews K1 (crypto), K2 (triggers, queue, merge), S3 (routes: authz, delete tokens, generation,
  step-up), S5 (protocol 06 and 08 text), and the whole branch before merge (security). Everything else is reviewed by
  sonnet.
- **Every fixture reachable.** The e2e starts from an empty instance and builds everything through the shipping client.

## 13. Tasks

### 13.1 Lanes, order and parallelism

Four lanes run in **parallel working copies**, because their files are disjoint. Inside a lane, writers run one at a
time in that lane's copy; tasks marked ∥ run in further copies of their own. Reviews run in parallel with the next
writer.

| Lane | Packages | Tasks |
|---|---|---|
| **K** Rust core | `core/dilla-core`, `core/dilla-core-wasm`, `protocol/vectors/history.json`, and the CorePort half in `packages/client-core/src/core-port.ts` and `testing/fake-core.ts` | K1 → K2 → K3 |
| **S** server and protocol docs | `internal/`, `cmd/dillad/`, `protocol/*.md` | S1 ∥ S2 ∥ S5 → S3 → S4 |
| **C** client-core | `packages/client-core/src` (not `core-port.ts`) | C1 → C2 → C3 |
| **W** web, e2e, docs | `packages/web/src`, `docs/design/flows`, `e2e/`, `docs/user`, `docs/deploy`, `README.md` | W1 ∥ from the start; W2 → W3 → E1 → D1 ∥ D2 |

Cross-lane dependencies (a task never starts before these have merged into the lane's base):

- **K3 → C2**: the uploader and state call the CorePort methods.
- **K1 → S5**: the vectors file is frozen by K1, and `vectors/README.md`'s row names it.
- **C2, C3 → W2, W3**: the web reads the `history` slice, the `restoring` flag and the three commands.
- **S3, C3, W2, W3 → E1**: the e2e needs the real routes, the restore and the UI.
- Names are frozen in §8, so W1 (strings) and S5 (protocol text) start at once.

Waves (each wave's tasks run together):

| Wave | K | S | C | W |
|---|---|---|---|---|
| 1 | K1 | S1, S2, S5 (all but the vectors row) | C1 | W1 |
| 2 | K2 | S3 | — | — |
| 3 | K3 | S4, S5's vectors row | — | — |
| 4 | — | — | C2 | — |
| 5 | — | — | C3 | — |
| 6 | — | — | — | W2, then W3 |
| 7 | — | — | — | E1 |
| 8 | — | — | — | D1, D2 |

Shared-file hazards, which is why each lane is sequential: `core/dilla-core/src/client/identity.rs` (K2 only),
`client/schema.rs` (K2), `facade.rs` and `core-port.ts` (K3), `internal/api/api.go` (S3), `internal/store/store.go`
(S1), `worker/controller.ts` (C2, C3), `worker/protocol.ts` (C2), `Privacy.tsx` and `Settings.tsx` (W2), `SignIn.tsx`,
`Shell.tsx` and `Onboarding.tsx` (W3), `en.ts` (W1 only; W2 and W3 use the keys W1 adds).

### 13.2 Tiers (J6, D26)

| Tier | Implementation | Review |
|---|---|---|
| **opus** | K1, K2 (2) | K1, K2, S3, S5, and the whole-branch security review (4 + 1) |
| **sonnet** | K3, S1, S2, S3, S4, C1, C2, C3, W2, W3, E1, D2 (12) | K3, S1, S2, S4, C1, C2, C3, W1, W2, W3, E1, D1, D2 (13) |
| **haiku** | S5, W1, D1 (3) | — |

17 tasks. If K2's restore merge (`history_restore_page`, `merge_entry`) or S3's delete-token check fails its first
opus review, the fix round goes to opus; every other first fix round goes to the task's own tier.

### 13.3 The tasks

Each gate is narrow: the task's own tests plus typecheck, lint and clippy of its package. The full suites run at the
end of each lane. Every test is written red first (negative-first for the authz and crypto ones) and named exactly as
below.

#### K1 — History crypto, entry codec and vectors

- **Lane** K. **Depends on** —. **Model** **opus**. **Review** **opus**.
- **Files:** new `core/dilla-core/src/history.rs`, `core/dilla-core/src/lib.rs` (`pub mod history;`), new
  `core/dilla-core/tests/history_vectors.rs`, new `protocol/vectors/history.json`.
- **Recipe:** §K.1–§K.4.
- **Tests:** §K.9.1 (12 unit tests in `history.rs`) and `history_vectors_reproduce` in `tests/history_vectors.rs`.

#### K2 — Store side: tables, triggers, keys, queue, server state, restore merge, parking

- **Lane** K. **Depends on** K1. **Model** **opus**. **Review** **opus**.
- **Files:** new `core/dilla-core/src/client/history.rs`, `client/mod.rs` (`mod history;`), `client/schema.rs`
  (`APP_HISTORY`, the five meta key consts, the call in `migrate_conn`'s every-open block), `client/identity.rs`
  (`signup_begin`, `signup_reset`, `enrol_complete`, `device_list_revoke`: install keys; `Recovered` gains the rk-derived
  `HistoryKeys`), new `core/dilla-core/tests/client_history.rs`. `messages.rs` and `sync.rs` are not edited: the merge
  calls their existing `pub(super)` helpers.
- **Recipe:** §K.5–§K.8.
- **Tests:** §K.9.2 (30 tests).

#### K3 — wasm facade and CorePort

- **Lane** K. **Depends on** K2. **Model** sonnet. **Review** sonnet.
- **Files:** `core/dilla-core-wasm/src/facade.rs`, `packages/client-core/src/core-port.ts`,
  `packages/client-core/src/testing/fake-core.ts`, `packages/client-core/src/core-port.test.ts`,
  `packages/client-core/src/testing/fake-core.test.ts`.
- **Recipe:** §K.8 (signatures), §C.1 (TS types).
- **Tests:** `core-port.test.ts` "history: every method decodes its CBOR answer" (one case per method, with the shapes
  of §C.1); `fake-core.test.ts` "fake history queue: take, done and a requeue" and "fake restore: down, up, done".

#### S1 — Migration, store, sqlc and dump

- **Lane** S, ∥ S2, S5. **Depends on** —. **Model** sonnet. **Review** sonnet.
- **Files:** `internal/store/{sqlite,postgres}/migrations/00026_history_archive.sql`,
  `internal/store/{sqlite,postgres}/schema/024_history_archive.sql`, `internal/store/{sqlite,postgres}/queries/history.sql`,
  generated `sqlitedb/` and `pgdb/`, `internal/store/rows.go`, `store.go`, `sqlite/repo.go`, `postgres/repo.go`,
  `dump.go`, `internal/ops/restore.go` (`dumpRowCounts`), `schema_test.go`, `contract_test.go`, new
  `internal/store/history_test.go`, `dump_test.go`.
- **Recipe:** §S.1, §S.2, §S.6.
- **Tests:** §S.8.1.

#### S2 — Config and the history meter

- **Lane** S, ∥ S1, S5. **Depends on** —. **Model** sonnet. **Review** sonnet.
- **Files:** `internal/config/config.go`, `defaults.go`, `validate.go`, their tests; `internal/api/api.go` (the
  `HistoryMeter` field and its construction in `Register` only, no routes).
- **Recipe:** §S.3.
- **Tests:** `TestHistoryDefaults` (quota 1073741824, upload 268435456), `TestHistoryValidate` (negative quota refused;
  quota 0 accepted; upload below 1048576 refused while quota > 0; upload 0 accepted while quota 0),
  `TestRegisterBuildsTheHistoryMeter` (a nil `HistoryMeter` is built from config).

#### S3 — The five routes, the error code, account deletion, audit

- **Lane** S. **Depends on** S1, S2. **Model** sonnet. **Review** **opus** (authz, delete tokens, generation, step-up).
- **Files:** new `internal/api/history.go`, new `internal/api/history_test.go`, `internal/api/api.go` (five
  `m.Handle` lines), `internal/server/errors.go` (`CodeHistoryStale`, status 409), `internal/server/errors_test.go`,
  `internal/api/accounts.go` (`DeleteMe`), `internal/api/accounts_delete_test.go`, `internal/ops/revoke_devices_test.go`.
- **Recipe:** §S.4, §S.5.
- **Tests:** §S.8.2. Every authz test negative-first and shown red.

#### S4 — Doctor leg and diagnostics

- **Lane** S. **Depends on** S1, S2. **Model** sonnet. **Review** sonnet.
- **Files:** `internal/ops/doctor.go` (`HistoryLeg`), `internal/ops/doctor_test.go`, `cmd/dillad/doctor.go`,
  `internal/dillad/diagnostics.go`.
- **Recipe:** §S.7.
- **Tests:** `TestHistoryLegGreenReportsTotals`, `TestHistoryLegYellowNearQuota`, `TestHistoryLegYellowWhenOffWithRows`,
  `TestHistoryLegSkippedWithoutADatabase`.

#### S5 — Protocol docs and the release-notes stub

- **Lane** S, ∥ S1, S2 (the vectors row after K1). **Depends on** — (K1 for the vectors row). **Model** haiku.
  **Review** **opus** (06 and 08 are normative and the trade-off must be stated exactly).
- **Files:** `protocol/02-delivery-service.md`, `03-identity.md`, `06-backup-archive.md`, `07-versioning.md`,
  `08-threat-model.md`, `09-http-api.md`, `protocol/vectors/README.md`, new `docs/deploy/releases/v0.1.0-web3.13.md`
  (stub).
- **Recipe:** §P (paste verbatim, in the places named).
- **Tests:** `npm run check:docs` (the error vocabulary sees `E_HISTORY_STALE` in 02's table and in `errors.go`).

#### C1 — Routes, error code and fake-server routes

- **Lane** C. **Depends on** — (names frozen in §8). **Model** sonnet. **Review** sonnet.
- **Files:** `packages/client-core/src/http/routes.ts`, `http/errors.ts`, `http/routes.test.ts`,
  `testing/fake-server.ts`, `testing/fake-server.test.ts`.
- **Recipe:** §C.2.
- **Tests:** §C.9.1.

#### C2 — History state, the uploader, the slice and the commands

- **Lane** C. **Depends on** C1, K3. **Model** sonnet. **Review** sonnet.
- **Files:** new `packages/client-core/src/history/state.ts`, `history/uploader.ts`, `history/slice.ts`,
  `history/state.test.ts`, `history/uploader.test.ts`; `worker/protocol.ts` (three commands), `state/types.ts`
  (`history` slice name, `HistorySlice`, `TimelineSlice.restoring`), `worker/controller.ts` (construction, `onReady`,
  the three commands, `historySetEnabled`, sign-out stop), `index.ts` (exports), `worker/controller.test.ts`.
- **Recipe:** §C.3, §C.4, §C.6, §C.7.
- **Tests:** §C.9.2, §C.9.3, and the controller cases of §C.9.5 that name C2.

#### C3 — Restore runner and its wiring

- **Lane** C. **Depends on** C2. **Model** sonnet. **Review** sonnet.
- **Files:** new `packages/client-core/src/history/restore.ts`, `history/restore.test.ts`; `worker/controller.ts`
  (start after `refreshAfterReady`, `historyUseKey`, timeline refresh of touched groups, `restoring` in
  `refreshTimeline`, unpark at each ready, enrol path), `worker/controller.test.ts`.
- **Recipe:** §C.5, §C.7.
- **Tests:** §C.9.4 and the controller cases of §C.9.5 that name C3.

#### W1 — Strings, flow 19 and its test

- **Lane** W, ∥ from the start. **Depends on** —. **Model** haiku. **Review** sonnet.
- **Files:** new `packages/web/src/strings/history.ts`, `strings/en.ts` (spread `history`; change `signin.done.body`
  and `onboarding.browser.oneBrowser`; add `signin.done.bodyNoHistory`, `onboarding.keys.history`,
  `shell.log.emptyRestoring`, `shell.log.emptyHistory`), `strings/strings.test.ts` (the two pinned lines), new
  `docs/design/flows/19-message-history.md`, new `strings/strings.flow19.test.ts`.
- **Recipe:** §U.4 (every key and value, byte for byte), §U.5.
- **Tests:** `strings.flow19.test.ts` (§U.7.1); `strings.test.ts` updated pins; `check:copy`.

#### W2 — Settings → Privacy: the history section

- **Lane** W. **Depends on** W1, C2, C3. **Model** sonnet. **Review** sonnet.
- **Files:** new `packages/web/src/screens/settings/History.tsx`, new `History.test.tsx`, `settings/Privacy.tsx`
  (renders `History` first; new props), `screens/Settings.tsx` (passes the slice and handlers; step-up and confirm
  dialogs for off; `KeyDialog` for the key), `settings/Privacy.test.tsx`, `app.css` only if a class is missing
  (prefer existing `dw-settings-*` classes).
- **Recipe:** §U.1, §U.2.
- **Tests:** §U.7.2.

#### W3 — Sign-in done step, sign-up key step, timeline line, empty channel, banner

- **Lane** W. **Depends on** W2. **Model** sonnet. **Review** sonnet.
- **Files:** `screens/SignIn.tsx`, `SignIn.test.tsx`, `screens/Onboarding.tsx`, `Onboarding.test.tsx`,
  `screens/conversation/*` where the timeline top and empty state render (the component that renders
  `shell.log.empty`), its test, new `screens/HistoryBanner.tsx`, new `HistoryBanner.test.tsx`, `screens/Shell.tsx`
  (mount the banner), `prefs.ts`, `prefs.test.ts`.
- **Recipe:** §U.3.
- **Tests:** §U.7.3.

#### E1 — e2e

- **Lane** W. **Depends on** S3, C3, W2, W3. **Model** sonnet. **Review** sonnet.
- **Files:** new `e2e/web/history.spec.ts`; `e2e/web/enrol.spec.ts` (the done-step copy).
- **Recipe:** §U.8.
- **Tests:** the spec on chromium and firefox; `enrol.spec.ts` on all three.

#### D1 — User docs, deploy guide, README and release notes

- **Lane** W, ∥ D2. **Depends on** E1. **Model** haiku. **Review** sonnet.
- **Files:** `docs/user/getting-started.md`, `docs/deploy/README.md`, `README.md`, `docs/deploy/releases/v0.1.0-web3.13.md`.
- **Recipe:** §U.6, §10 (release-note paragraph verbatim), §11 (table row), §S.3 (settings).
- **Tests:** `check:docs`.

#### D2 — Screenshots

- **Lane** W, ∥ D1. **Depends on** E1. **Model** sonnet. **Review** sonnet (by eye).
- **Files:** `e2e/scripts/shoot-docs.mjs` (a `HISTORY_SHOTS` block), `docs/user/screenshots/*`.
- **Recipe:** §U.8.3.
- **Tests:** the shoot run; the new images reviewed by eye at 1280 px and 390 px.

## 14. Open questions

Only Jonas can decide these. Each has a recommendation; the design is built on it and changes in one named place if he
decides otherwise.

1. **Keep the read key after a restore?** Recommended: **no, erase it** (D4). A browser then cannot open the saved
   history of other browsers if its store is stolen. The cost: a browser does not pick up what another browser saves
   later from its own backlog (an old browser entering its key after this one restored); "restore again" in Privacy
   (with the key) does. If yes: `history_restore_page` keeps the record after "done" and the runner polls `after=top`
   at every ready (§C.5 step 5).
2. **Tell browsers from before this release?** Recommended: **yes, one banner** ("This browser is not saving your
   messages for your other browsers yet." with **open privacy**), shown until the person has seen the history section
   once or entered the key. If no: drop `HistoryBanner` from W3; Privacy alone says it.
3. **Quota and what happens when it is full.** Recommended: **1 GiB per person by default, and a full history stops
   saving new messages and says so** (D18), never dropping old ones silently. Alternative: drop the oldest entries to
   make room (needs a server-side order the browsers can trust; not designed).
4. **Step-up to turn history off.** Recommended: **yes** (D15): turning off deletes every browser's saved history, so
   it is guarded like account deletion. If no: `PUT /v1/history [0, null]` is accepted without a token.

## 15. Risks

1. **The recovery key becomes a key to the past.** A leaked recovery key now opens every saved message, and an
   operator's backup taken before a deletion keeps the deleted message's entry for whoever later holds both. This is
   the feature's whole cost; it is stated in protocol/08, Privacy, the sign-up's key step, the user docs and the
   release notes in the same words, but people who stored their key badly before this release are exposed by an
   upgrade they did not choose (history is on by default, J4). Mitigation in scope: the honest copy and turning it off
   deletes; out of scope: key rotation.
2. **The write path and the restore merge are subtle, and errors are silent.** A missed trigger path saves a message
   that should have been deleted or retracted; a wrong merge rule shows a deleted message, duplicates a live row, or
   raises badges for old messages. Mitigation: triggers rather than call sites (D9), merge only below `next_seq` and
   never over a row (D10), the type-2 envelope kept as its own entry, opus on K2 with 30 named tests including every
   drop path, and the e2e's delete-and-restore check.
3. **Storage and bandwidth grow with people × messages.** Every person keeps their own copy (about 0.6 KB per message or
   fold), every browser uploads what it shows (the server keeps one), and a Postgres dump would have buffered the whole
   table. Mitigation: per-person quota and per-device daily budget, the doctor's `history` leg, the storage estimate in
   the deploy guide, and the chunked dump (§S.6). An instance can turn history off (quota 0).

---

## Appendix K: Rust core

Everything in `dilla-core` is written so the wasm build carries it; no new crate (§6, HPKE through `openmls_traits`).
Errors follow `client/error.rs`: `E_CORE_INPUT`, `E_CORE_STATE`, `E_CORE_STORAGE`, `E_RECOVERY_KEY`.

### K.1 Constants and keys (`core/dilla-core/src/history.rs`, task K1)

```rust
//! Message history (protocol/06 § History): the keys derived from the recovery key, the entry
//! codec, and the sealing and opening of rows. No storage here; client/history.rs owns that.

use crate::cbor::{Decoder, Encoder, decode_strict};
use crate::identity::hkdf_sha256;
use hmac::{Hmac, Mac};
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::types::{HpkeAeadType, HpkeConfig, HpkeKdfType, HpkeKemType};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub const INFO_KEY: &[u8] = b"dilla history key v1";
pub const INFO_AUTH: &[u8] = b"dilla history auth v1";
pub const INFO_ID: &[u8] = b"dilla history id v1";
pub const INFO_DELETE: &[u8] = b"dilla history delete v1";
pub const ID_LABEL: &[u8] = b"dilla history entry id v1";
pub const TOKEN_LABEL: &[u8] = b"dilla history delete token v1";
pub const HASH_LABEL: &[u8] = b"dilla history delete hash v1";
pub const HPKE_INFO: &[u8] = b"dilla history v1";
pub const EXPORT_CONTEXT: &[u8] = b"dilla history batch v1";
pub const BATCH_KEY_INFO: &[u8] = b"dilla history batch key v1";
pub const AAD_LABEL: &[u8] = b"dilla history entry v1";
pub const PAD_TO: usize = 256;
pub const ROW_MAX: usize = 81_920;
pub const BATCH_MAX: usize = 512;
pub const SUITE: HpkeConfig =
    HpkeConfig(HpkeKemType::DhKem25519, HpkeKdfType::HkdfSha256, HpkeAeadType::AesGcm256);

pub struct WriteKeys {
    pub pk: [u8; 32],
    pub k_auth: Zeroizing<[u8; 32]>,
    pub k_id: Zeroizing<[u8; 32]>,
    pub k_del: Zeroizing<[u8; 32]>,
}
pub struct HistoryKeys {
    pub sk: Zeroizing<[u8; 32]>,
    pub write: WriteKeys,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HistoryError { Shape, Open, Id }
```

`derive_keys(crypto: &impl OpenMlsCrypto, rk: &[u8; 32]) -> Result<HistoryKeys, HistoryError>`:

1. `seed = HKDF(salt = Some(&[]), rk, INFO_KEY, 32)` (the existing `hkdf_sha256`), in a `Zeroizing`.
2. `kp = crypto.derive_hpke_keypair(SUITE, &*seed)` → `sk` (32 bytes, `kp.private`), `pk` (32 bytes, `kp.public`).
   Any error or a length other than 32 is `HistoryError::Shape`.
3. `k_auth`, `k_id`, `k_del` = HKDF of `rk` with `INFO_AUTH`, `INFO_ID`, `INFO_DELETE`.

`WriteKeys` encode as `[1, pk, k_auth, k_id, k_del]` (`WriteKeys::encode() -> Zeroizing<Vec<u8>>`,
`WriteKeys::decode(&[u8]) -> Result<WriteKeys, HistoryError>`, strict, `v` must be 1). `Debug` for both key types
prints the field names only, as `SignupRecord` does.

### K.2 Ids and tokens (task K1)

```rust
pub fn entry_id(k_id: &[u8; 32], group_id: &[u8; 16], seq: u64) -> [u8; 16]
// HMAC-SHA256(k_id, ID_LABEL || group_id || seq.to_be_bytes())[0..16]
pub fn delete_token(k_del: &[u8; 32], entry_id: &[u8; 16]) -> [u8; 16]
// HMAC-SHA256(k_del, TOKEN_LABEL || entry_id)[0..16]
pub fn delete_hash(token: &[u8; 16]) -> [u8; 16]
// SHA-256(HASH_LABEL || token)[0..16]
```

`hmac` 0.13 and `sha2` 0.11 are already dependencies. Comparisons of ids in `open_row` use a constant-time equality
(`subtle` is not a dependency: compare with a fold of XORs over the 16 bytes, written once as
`fn ct_eq16(a: &[u8; 16], b: &[u8; 16]) -> bool`).

### K.3 The entry codec (task K1)

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub group_id: [u8; 16],
    pub seq: u64,
    pub epoch: u64,
    pub recv_ts: u64,
    pub sender_user: [u8; 16],
    pub sender_device: [u8; 16],
    pub sender_sig_key: Option<[u8; 32]>,
    pub sender_kind: u8,
    pub sender_tier: u8,
    pub franking_tag: [u8; 32],
    pub envelope: Vec<u8>,
}
impl Entry {
    pub fn encode_padded(&self) -> Zeroizing<Vec<u8>>;
    pub fn decode_padded(bytes: &[u8]) -> Result<Entry, HistoryError>;
}
```

- `encode_padded`: `Encoder::new()`, `array(12)`, `uint(1)`, `bytes(group_id)`, `uint(seq)`, `uint(epoch)`,
  `uint(recv_ts)`, `bytes(sender_user)`, `bytes(sender_device)`, `opt_bytes(sender_sig_key)`, `uint(sender_kind)`,
  `uint(sender_tier)`, `bytes(franking_tag)`, `bytes(envelope)`; then push `0x00` until `len % PAD_TO == 0`.
- `decode_padded`: refuse (`Shape`) when `bytes.len() == 0` or `bytes.len() % PAD_TO != 0`. `let mut d =
  Decoder::new(bytes)`; read the 12 elements in order (`array(12)`, `uint()` must be 1, `bytes_exact::<16>()`,
  `uint()` ×3, `bytes_exact::<16>()` ×2, `opt_bytes_exact::<32>()`, `uint()` ≤ 1, `uint()` ≤ 1,
  `bytes_exact::<32>()`, `bytes()`); then every byte of `bytes[d.position()..]` must be `0x00`. Any failure is
  `Shape`. The `Decoder` enforces deterministic CBOR as `decode_strict` does; `finish()` is not called (the padding
  follows).

### K.4 Sealing and opening (task K1)

```rust
pub struct SealBatch { enc: [u8; 32], key: Zeroizing<[u8; 32]>, user_id: [u8; 16], rows: usize }
impl SealBatch {
    /// One HPKE setup per upload.
    pub fn new(crypto: &impl OpenMlsCrypto, write: &WriteKeys, user_id: &[u8; 16])
        -> Result<SealBatch, HistoryError>;
    /// One row; `nonce` is 12 fresh random bytes from the provider.
    pub fn seal(&mut self, entry_id: &[u8; 16], entry: &Entry, nonce: [u8; 12])
        -> Result<Vec<u8>, HistoryError>;
}
pub struct OpenCache { /* up to 64 (enc → K_batch), oldest evicted first */ }
impl OpenCache { pub fn new() -> OpenCache; }
pub fn open_row(crypto: &impl OpenMlsCrypto, sk: &[u8; 32], k_auth: &[u8; 32], user_id: &[u8; 16],
    entry_id: &[u8; 16], row: &[u8], cache: &mut OpenCache) -> Result<Entry, HistoryError>;
```

`SealBatch::new`:
1. `info = HPKE_INFO ‖ user_id`.
2. `(enc, exported) = crypto.hpke_setup_sender_and_export(SUITE, &write.pk, &info, EXPORT_CONTEXT, 32)`; `enc` must be
   32 bytes (`Shape` otherwise).
3. `key = HKDF-SHA256(salt = Some(&*write.k_auth), IKM = exported, info = BATCH_KEY_INFO, L = 32)`; zeroize
   `exported`.

`SealBatch::seal`: refuse (`Shape`) a 513th row (`rows == BATCH_MAX`). `pt = entry.encode_padded()`;
`aad = AAD_LABEL ‖ user_id ‖ entry_id`; `ct = Aes256Gcm(key).encrypt(nonce, Payload { msg: &pt, aad })`;
`row = CBOR [1, bytes(enc), bytes(nonce), bytes(ct)]`; refuse (`Shape`) when `row.len() > ROW_MAX`. `rows += 1`.

`open_row`:
1. `row.len() > ROW_MAX` → `Shape`. `decode_strict(row, |d| { d.array(4); uint == 1; bytes_exact::<32>();
   bytes_exact::<12>(); bytes() with len ≥ 16 })` → `Shape` on failure.
2. `key = cache.get(enc)` or derive: `exported = crypto.hpke_setup_receiver_and_export(SUITE, &enc, sk, &info,
   EXPORT_CONTEXT, 32)` (`Open` on error), `key = HKDF(salt = k_auth, exported, BATCH_KEY_INFO)`; insert (evict the
   oldest past 64).
3. `pt = decrypt(key, nonce, aad = AAD_LABEL ‖ user_id ‖ entry_id)` → `Open` on failure.
4. `e = Entry::decode_padded(&pt)?` and return it. `open_row` holds no `k_id`, so the caller checks that `e`'s
   `(group_id, seq)` gives `entry_id` (§K.7.3, step 3.2) and counts a mismatch as `HistoryError::Id`.

The AAD already binds `entry_id`, so a row moved to another id does not open; the caller's id check binds the id to
the decrypted `(group_id, seq)`, so an honest writer's row cannot be replayed under another position either.

### K.5 Tables, triggers and meta keys (`client/schema.rs`, task K2)

Add to `schema.rs`:

```rust
pub(crate) const HISTORY_KEYS: &str = "history_keys";
pub(crate) const HISTORY_ON: &str = "history_on";
pub(crate) const HISTORY_GEN: &str = "history_gen";
pub(crate) const HISTORY_BACKFILL: &str = "history_backfill";
pub(crate) const HISTORY_RESTORE: &str = "history_restore";

/// Message history (protocol/06 § History), additive and created by every open (no schema bump,
/// design D17): the upload queue, the parked rows of groups not held yet, and the four triggers that
/// decide what is saved. Every trigger queues only while `history_on` is present and only for a
/// `text` group (kind 0); each writes by DELETE then INSERT, so no conflict clause of an outer
/// statement can change what it does.
pub(super) const APP_HISTORY: &str = "
CREATE TABLE IF NOT EXISTS app_history_out (
  n        INTEGER PRIMARY KEY,
  group_id BLOB    NOT NULL CHECK (length(group_id) = 16),
  seq      INTEGER NOT NULL,
  op       INTEGER NOT NULL CHECK (op IN (0, 1)),
  UNIQUE (group_id, seq)
);
CREATE TABLE IF NOT EXISTS app_history_parked (
  group_id  BLOB    NOT NULL CHECK (length(group_id) = 16),
  seq       INTEGER NOT NULL,
  entry     BLOB    NOT NULL,
  parked_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS app_history_parked_by_age ON app_history_parked (parked_at);
CREATE TRIGGER IF NOT EXISTS app_history_put AFTER INSERT ON app_messages
WHEN new.status = 0 AND new.type BETWEEN 0 AND 6 AND new.envelope IS NOT NULL
 AND EXISTS (SELECT 1 FROM app_meta WHERE k = 'history_on')
 AND EXISTS (SELECT 1 FROM app_groups WHERE group_id = new.group_id AND kind = 0)
BEGIN
  DELETE FROM app_history_out WHERE group_id = new.group_id AND seq = new.seq;
  INSERT INTO app_history_out (group_id, seq, op) VALUES (new.group_id, new.seq, 0);
END;
CREATE TRIGGER IF NOT EXISTS app_history_marker AFTER INSERT ON app_messages
WHEN new.status = 2
 AND EXISTS (SELECT 1 FROM app_meta WHERE k = 'history_on')
 AND EXISTS (SELECT 1 FROM app_groups WHERE group_id = new.group_id AND kind = 0)
BEGIN
  DELETE FROM app_history_out WHERE group_id = new.group_id AND seq = new.seq;
  INSERT INTO app_history_out (group_id, seq, op) VALUES (new.group_id, new.seq, 1);
END;
CREATE TRIGGER IF NOT EXISTS app_history_release AFTER UPDATE OF status, envelope ON app_messages
WHEN new.status = 0 AND new.type BETWEEN 0 AND 6 AND new.envelope IS NOT NULL
 AND (old.status <> 0 OR old.envelope IS NULL)
 AND EXISTS (SELECT 1 FROM app_meta WHERE k = 'history_on')
 AND EXISTS (SELECT 1 FROM app_groups WHERE group_id = new.group_id AND kind = 0)
BEGIN
  DELETE FROM app_history_out WHERE group_id = new.group_id AND seq = new.seq;
  INSERT INTO app_history_out (group_id, seq, op) VALUES (new.group_id, new.seq, 0);
END;
CREATE TRIGGER IF NOT EXISTS app_history_drop AFTER UPDATE OF status, envelope ON app_messages
WHEN old.status = 0 AND old.envelope IS NOT NULL
 AND (new.status <> 0 OR new.envelope IS NULL)
 AND EXISTS (SELECT 1 FROM app_meta WHERE k = 'history_on')
 AND EXISTS (SELECT 1 FROM app_groups WHERE group_id = new.group_id AND kind = 0)
BEGIN
  DELETE FROM app_history_out WHERE group_id = new.group_id AND seq = new.seq;
  INSERT INTO app_history_out (group_id, seq, op) VALUES (new.group_id, new.seq, 1);
END;
";
```

In `migrate_conn`, inside `if found <= 5 { … }`, after `c.execute_batch(APP_AUTHORITY)?;`, add
`c.execute_batch(APP_HISTORY)?;`. `APP_SCHEMA_SUPPORTED` stays 5 and `meta_put(c, SCHEMA, &[5])` is unchanged.

Notes the implementer must not change:

- **No `AFTER DELETE` trigger.** Rows deleted locally (a group discard, the release path's delete-then-insert at
  `sync.rs:376`) are not deletions for everyone. The release path's following `INSERT` fires `app_history_put`.
- **A row inserted shown and blanked in the same unit** (an edit of an already deleted target, `fold.rs:163`) queues a
  put and then a delete; the delete wins (the later row).
- **`n` is the version.** A row queued again gets a new `n`, so `history_done` (which deletes by `n`) never removes an
  operation queued after the take.

### K.6 Keys in the identity flows (`client/identity.rs` and `client/history.rs`, task K2)

```rust
/// Stores the write keys (when absent, or when different: the same RK gives the same keys, so a
/// difference means a store from another account and is E_CORE_STATE) and marks a backfill due
/// when they were absent. With `restore = Some(now)`, writes a fresh restore record holding SK.
pub(super) fn install_history_keys(c: &rusqlite::Connection, keys: &HistoryKeys,
    restore: Option<u64>) -> Result<(), ClientError>;
```

- `signup_begin`: inside its `write` closure, after `rk` is drawn: `let hk = history::derive_keys(ctx.provider.crypto(),
  &rk)?` (map `HistoryError` to `E_CORE_STATE`), and in the same `u.with_conn` that stores `ROOT_SEALED` and `SIGNUP`:
  `install_history_keys(c, &hk, None)`.
- `signup_reset`: also `meta_del` `HISTORY_KEYS`, `HISTORY_ON`, `HISTORY_GEN`, `HISTORY_BACKFILL`, `HISTORY_RESTORE`.
- `recover()`: after `rk` is parsed, derive `history::derive_keys(crypto, &rk)` and return it in `Recovered` as
  `history: HistoryKeys` (`recover` gains a `crypto: &impl OpenMlsCrypto` parameter; both callers pass
  `ctx.provider.crypto()`).
- `enrol_complete`: in the `u.with_conn` that stores `IDENTITY`: `install_history_keys(c, &recovered.history,
  Some(now))`.
- `device_list_revoke`: in its final `u.with_conn`: `install_history_keys(c, &recovered.history, None)`.

`history_unlock(&mut self, recovery_key: &str, root_sealed: &[u8], now: u64) -> Result<Vec<u8>, ClientError>`:
Phase must be `Ready` (`E_CORE_STATE` otherwise). Parse the key (`recovery_key_parse`, `E_RECOVERY_KEY`); open
`root_sealed` under `k_header(rk)` with `AAD_ROOT` (`open_sealed`; `Refused` → `E_RECOVERY_KEY`, `Malformed` →
`E_CORE_INPUT "root_sealed is malformed"`); decode `[1, umk_priv, ssk_priv]`; `UmkSigner::from_bytes(umk_priv).public()`
must equal the identity record's `umk_pub` (`E_RECOVERY_KEY` otherwise; zeroize both privates at once). Derive the
history keys and `install_history_keys(c, &keys, Some(now))`. Answer `history_status(now)`.

### K.7 Queue, server state and restore (`client/history.rs`, task K2)

#### K.7.1 Status and server state

`history_status(&self, now: u64) -> Result<Vec<u8>, ClientError>` answers CBOR
`[keys(uint 0|1), on(uint 0|1), generation(uint|null), queued(uint), restore(null | [phase(uint), done(uint), gaps(uint), merged(uint), started(uint)]), expired(uint 0|1)]`.
`expired` is 1 when a restore record exists and `now > started + RESTORE_TTL_S`; the worker then calls
`history_restore_cancel` and shows "stopped".

`history_set_server(&mut self, enabled: bool, generation: u64) -> Result<Vec<u8>, ClientError>`, one write unit:

1. `prior = meta HISTORY_GEN` (`[g, e]` or none). `keys = meta HISTORY_KEYS is present`.
2. If `prior.g != generation` (or none): `DELETE FROM app_history_out`; delete `HISTORY_RESTORE` **only** when the
   prior generation existed (a restore started under an older generation would read the wrong rows; a first sight
   keeps the sign-in's restore record).
3. Write `HISTORY_GEN = [generation, enabled]`.
4. If `enabled && keys`: write `HISTORY_ON = generation`; if the generation changed or `HISTORY_BACKFILL` is present,
   run `queue_backfill(c)` and delete `HISTORY_BACKFILL`.
5. If `!enabled`: delete `HISTORY_ON`, `DELETE FROM app_history_out`, delete `HISTORY_RESTORE`.
6. Answer `history_status`.

`queue_backfill(c)`:

```sql
DELETE FROM app_history_out;
INSERT INTO app_history_out (group_id, seq, op)
  SELECT m.group_id, m.seq, 0 FROM app_messages m
  JOIN app_groups g ON g.group_id = m.group_id AND g.kind = 0
  WHERE m.status = 0 AND m.type BETWEEN 0 AND 6 AND m.envelope IS NOT NULL
  ORDER BY m.group_id, m.seq;
```

(The deletes of this browser's past are not replayed: what it holds is what it shows.)

#### K.7.2 Take and done

`history_take(&mut self, max_rows: u32, max_bytes: u32) -> Result<Vec<u8>, ClientError>`: `max_rows` 1..=512,
`max_bytes` 1..=1_000_000 (`E_CORE_INPUT` otherwise). Requires `HISTORY_KEYS`, `HISTORY_ON` and `HISTORY_GEN`
(`E_CORE_STATE "history is off"` otherwise) and the identity's `user_id`. Read-only on the store (no write unit; it
draws randomness):

1. `SELECT n, group_id, seq, op FROM app_history_out ORDER BY n LIMIT max_rows`.
2. For each op 1: `id = entry_id(k_id, g, seq)`; push `[id, delete_token(k_del, id)]` to `deletes`; push `n` to
   `taken`.
3. For each op 0: read `SELECT epoch, recv_ts, sender_user, sender_device, sender_sig_key, sender_kind, sender_tier,
   franking_tag, envelope FROM app_messages WHERE group_id = ?1 AND seq = ?2 AND status = 0 AND type BETWEEN 0 AND 6
   AND envelope IS NOT NULL`. None (the row changed since; its delete is queued after it) or a NULL `sender_user`,
   `sender_kind` or `sender_tier` → push `n` to `taken`, nothing else. Otherwise build the `Entry` (a `sender_sig_key`
   whose length is not 32 is `None`), seal it in the call's `SealBatch` (created at the first put), and stop adding
   puts (leaving the op in the queue, not in `taken`) when `bytes_so_far + row.len() + 40 > max_bytes`. A row over
   `ROW_MAX` (impossible within `04`'s limits) is pushed to `taken` and logged nowhere.
4. Answer CBOR `[generation(uint), puts([[entry_id, del_hash, row]]), deletes([[entry_id, del_token]]), taken([uint])]`
   with `del_hash = delete_hash(delete_token(k_del, entry_id))`.

`history_done(&mut self, taken: &[u64]) -> Result<(), ClientError>`: one write unit, `DELETE FROM app_history_out
WHERE n = ?1` for each (at most 1 536; `E_CORE_INPUT` past that).

#### K.7.3 The restore page and the merge

```rust
struct RestoreRecord { sk: Zeroizing<[u8; 32]>, phase: u8, before: Option<u64>, top: Option<u64>,
    done: u64, gaps: u64, merged: u64, started: u64 }
```
(`encode`/`decode` as §8.2, `Debug` prints field names only.)

`history_restore_state(&self) -> Result<Vec<u8>, ClientError>`: CBOR `null` or `[phase, before|null, top|null, done,
gaps, merged, started]`.

`history_restore_cancel(&mut self) -> Result<(), ClientError>`: delete `HISTORY_RESTORE` (no error when absent).

`history_restore_page(&mut self, rows: &[u8], now: u64) -> Result<Vec<u8>, ClientError>`: `rows` is the CBOR the
route served, `[[n(uint), entry_id(bstr 16), row(bstr)]]`, at most 512 (`E_CORE_INPUT` otherwise). Requires
`HISTORY_RESTORE` and `HISTORY_KEYS` (`E_CORE_STATE "no restore is running"`), the identity and `Own`. One write unit:

1. **Empty page.** Phase 0: set `phase = 1`, `top = top.or(Some(0))`. Phase 1: delete `HISTORY_RESTORE` and answer
   `done = 1`.
2. **Cursor.** Phase 0: `top = top.or(max n of the page)`; `before = min n of the page`. Phase 1: `top = max(top, max n
   of the page)`.
3. **Each row**, with one `OpenCache` for the call:
   1. `open_row` → on `Err` `gaps += 1`, next.
   2. `ct_eq16(entry_id(k_id, e.group_id, e.seq), row's entry_id)` false → `gaps += 1`, next.
   3. `Envelope::decode(&e.envelope)` fails → `gaps += 1`, next.
   4. `merge_entry(c, &e, &env, &own, now)` → `Merged`, `Parked` or `Skipped`; count.
4. `done += rows.len()`; write the record; answer CBOR
   `[done(uint 0|1), merged(uint), parked(uint), skipped(uint), gaps(uint), groups([bstr 16])]` where `groups` are the
   distinct groups a row was merged into, for the worker's timeline refresh.

`merge_entry(c, e, env, own, now) -> Result<MergeOutcome, StorageError>`:

1. `SELECT kind, next_seq FROM app_groups WHERE group_id = ?1`. None → `INSERT OR REPLACE INTO app_history_parked
   (group_id, seq, entry, parked_at) VALUES (?1, ?2, ?3, ?4)` with `entry = e.encode_padded()`, → `Parked`.
2. `kind != 0` or `e.seq >= next_seq` → `Skipped`.
3. `EXISTS (SELECT 1 FROM app_messages WHERE group_id = ?1 AND seq = ?2)` → `Skipped`.
4. `EXISTS (SELECT 1 FROM app_quarantine WHERE group_id = ?1 AND user_id = ?2 AND device_id = ?3 AND (signature_key =
   ?4 OR signature_key = x''))` with `?4` the entry's key or `x''` → `Skipped`.
5. Compute the mention exactly as `sync.rs:886-890` does: `roles = own_roles_of(c, g)`, `mentionable =
   mentionable_of(c, g)`, `broadcast = broadcast_ok(c, g, &e.sender_user)`, `mention = env.kind == 0 &&
   e.sender_user != own.user_id && mentions_me_gated(&env.body, &own.user_id, &roles, &mentionable, broadcast)`.
6. `insert_message(c, &StoredMessage { group_id, seq, epoch, recv_ts, status: 0, reason: "", sender_user:
   Some(&e.sender_user), sender_device: &e.sender_device, sender_leaf: None, sender_sig_key: e.sender_sig_key
   .as_ref().map(|k| k.as_slice()), sender_kind: Some(e.sender_kind), sender_tier: Some(e.sender_tier), msg_id:
   Some(env.msg_id), ty: Some(env.kind), reply_to: env.reply_to, thread_id: env.thread_id, body: &env.body, envelope:
   Some(&e.envelope), franking_tag: &e.franking_tag, mention })`, then `refold_insert(c, g, seq, env,
   &e.sender_user, &e.sender_device, Some(own))`.
7. `DELETE FROM app_history_out WHERE group_id = ?1 AND seq = ?2` (the trigger queued it; it is saved already).
8. `INSERT INTO app_read_state (group_id, last_read_seq, last_read_at) VALUES (?1, ?2, 0) ON CONFLICT (group_id) DO
   UPDATE SET last_read_seq = max(last_read_seq, excluded.last_read_seq)`.
9. → `Merged`.

`history_unpark(&mut self, now: u64) -> Result<Vec<u8>, ClientError>`, one write unit: delete parked rows with
`parked_at < now - PARK_TTL_S`; delete beyond `PARK_MAX` the oldest by `parked_at`; for each parked row whose group
is now in `app_groups`: decode it (`Entry::decode_padded`, a failure deletes it), decode its envelope, run steps 2–9
of `merge_entry` (a `Skipped` is also deleted), and delete it. Answer `[merged(uint), groups([bstr 16])]`. Requires
`Own`; needs no keys.

### K.8 The wasm facade (task K3)

In `core/dilla-core-wasm/src/facade.rs`, one method per core method, in the existing style (`self.with_core(|c| …)`,
byte arrays as `&[u8]`, CBOR answers as `Vec<u8>`):

```rust
pub fn history_status(&self, now: u64) -> Result<Vec<u8>, JsError>
pub fn history_set_server(&self, enabled: bool, generation: u64) -> Result<Vec<u8>, JsError>
pub fn history_unlock(&self, recovery_key: &str, root_sealed: &[u8], now: u64) -> Result<Vec<u8>, JsError>
pub fn history_take(&self, max_rows: u32, max_bytes: u32) -> Result<Vec<u8>, JsError>
pub fn history_done(&self, taken: &[u8]) -> Result<(), JsError>          // CBOR [uint]
pub fn history_restore_page(&self, rows: &[u8], now: u64) -> Result<Vec<u8>, JsError>
pub fn history_restore_state(&self) -> Result<Vec<u8>, JsError>
pub fn history_restore_cancel(&self) -> Result<(), JsError>
pub fn history_unpark(&self, now: u64) -> Result<Vec<u8>, JsError>
```

The recovery key crosses as a `&str` exactly as `enrol_complete` takes it; the page never sees the derived keys.

### K.9 Tests

#### K.9.1 Unit tests in `history.rs` (K1)

All from `rk = 0x0b × 32`, `user_id = 0x02 × 16`, `group_id = 0x01 × 16`, unless stated.

1. `keys_are_deterministic_and_distinct`: two derivations agree; `k_auth`, `k_id`, `k_del` and `sk` are pairwise
   different; none equals `k_header(rk)` or `k_backup(rk)`.
2. `entry_id_binds_group_and_seq`: ids for `(g, 7)`, `(g, 8)` and `(0x03×16, 7)` differ; the same inputs agree.
3. `entry_id_is_keyed`: the id under another `k_id` differs.
4. `delete_hash_is_of_the_token`: `delete_hash(delete_token(k_del, id))` is stable and differs from `delete_token`.
5. `padding_is_a_multiple_of_256`: an entry with a 1-byte envelope pads to 256, one whose CBOR is exactly 256 bytes
   stays 256, one of 257 pads to 512.
6. `nonzero_padding_is_refused`: flipping one padding byte to `0x01` is `Shape`; a length not a multiple of 256 is
   `Shape`.
7. `a_sealed_row_opens_to_the_entry`: seal, then `open_row` with `sk` and `k_auth` answers the same `Entry`.
8. `a_row_needs_sk`: opening with another account's `sk` is `Open`.
9. `a_row_needs_k_auth`: a row sealed with a `SealBatch` built from the right `pk` but another `k_auth` does not open
   (`Open`): the server, knowing `pk`, cannot forge.
10. `a_row_under_another_id_or_user_does_not_open`: the same row opened with another `entry_id`, or another `user_id`,
    is `Open`.
11. `a_batch_stops_at_512_rows`: the 513th `seal` is `Shape`.
12. `the_open_cache_derives_once_per_enc`: opening 3 rows of one batch performs one receiver setup (count through a
    wrapping test crypto provider) and the 65th distinct `enc` evicts the first.

`tests/history_vectors.rs` `history_vectors_reproduce`: from `protocol/vectors/history.json` (frozen by K1 by running
the generator test once, `#[ignore]`d, `write_history_vectors`), reproduces `seed`, `sk`, `pk`, `k_auth`, `k_id`,
`k_del`; `entry_id` for `(group_id, seq 7)`; `del_token`; `del_hash`; `entry.padded` from `entry.fields`; and opens
`row` (sealed once with a fixed nonce `0x0c × 12`) to `entry.padded`. The file's shape:

```json
{ "rk": "0b…", "user_id": "02…", "seed": "…", "sk": "…", "pk": "…", "k_auth": "…", "k_id": "…", "k_del": "…",
  "group_id": "01…", "seq": 7, "entry_id": "…", "del_token": "…", "del_hash": "…",
  "entry": { "fields": { "epoch": 3, "recv_ts": 1760000000, "sender_user": "04…", "sender_device": "05…",
             "sender_sig_key": "06…", "sender_kind": 0, "sender_tier": 1, "franking_tag": "07…",
             "envelope": "<the first case of envelope.json>" }, "padded": "…" },
  "row": "…" }
```

#### K.9.2 Store tests (K2), `core/dilla-core/tests/client_history.rs` and unit tests in `client/history.rs`

The trigger tests use an in-memory connection with `APP_SCHEMA`, `APP_SCHEMA_V4`, `APP_AUTHORITY` and `APP_HISTORY`
and rows written directly; the flow tests use the existing two-client harness of `tests/client_identity.rs`.

1. `history_put_queues_a_shown_row_of_a_text_group`: with `history_on`, inserting a status-0 type-0 row with an
   envelope in a kind-0 group queues `op 0`.
2. `history_triggers_ignore_other_rows`: no queue for a kind-1 group, status 1, type 255, a NULL envelope.
3. `history_triggers_do_nothing_while_off`: without `history_on`, no trigger queues anything.
4. `a_delete_fold_queues_the_target_and_its_blanked_edits`: a target, two author edits and the author's type 2
   applied through `refold_insert` queue `op 1` for the target and both edits, and `op 0` for the type-2 row.
5. `a_ds_deletion_queues_a_delete`: the `sync.rs:626` update (status 2, envelope NULL) queues `op 1`.
6. `a_deletion_marker_for_an_unstored_seq_queues_a_delete`: inserting a status-2 row queues `op 1`.
7. `a_retraction_queues_deletes`: `retract_matching` on a leaf with two shown rows queues `op 1` for both.
8. `a_released_row_is_queued`: the release path (delete the status-1 row, insert status 0) queues `op 0`.
9. `the_latest_op_wins`: put then delete of one seq leaves one row, `op 1`, with a larger `n`.
10. `done_keeps_a_row_queued_after_the_take`: take, then the row is queued again, then `history_done(taken)` leaves the
    new row.
11. `take_seals_a_batch_that_the_recovery_key_opens`: a taken put opens with `derive_keys(rk).sk` and `k_auth` to the
    stored row's fields; its `del_hash` equals `delete_hash(delete_token(k_del, entry_id))`.
12. `take_respects_max_rows_and_max_bytes`: 600 queued puts give 512 at most; with `max_bytes = 2000` fewer, and the
    rest stay queued.
13. `take_skips_a_row_that_changed`: a queued put whose row was deleted meanwhile is in `taken` with no put.
14. `set_server_new_generation_clears_and_backfills`: with keys, three shown rows and a stale queue, a new generation
    empties the queue and queues the three rows.
15. `set_server_same_generation_keeps_the_queue`: the same generation twice changes nothing.
16. `set_server_off_clears_queue_restore_and_stops_triggers`: off deletes `history_on`, the queue and the restore
    record; a new shown row queues nothing.
17. `signup_installs_write_keys_only`: after `signup_begin`, `history_keys` exists and `history_restore` does not.
18. `enrol_complete_installs_keys_and_a_restore_record`: after the harness's sign-in with the key, both exist and the
    record's `sk` equals `derive_keys(rk).sk`.
19. `unlock_refuses_a_wrong_key`: `history_unlock` with another valid key is `E_RECOVERY_KEY` and stores nothing.
20. `unlock_installs_keys_and_backfills_once`: on a browser without keys and with two shown rows, unlock then
    `history_set_server(true, g)` queues two rows; a second unlock queues none.
21. `restore_merges_below_next_seq_only`: rows at seq 5 and seq `next_seq` give one `Merged` and one `Skipped`.
22. `restore_never_replaces_a_row`: a status-1 row at seq 5 stays status 1 after a page holding seq 5.
23. `restore_folds_edits_reactions_pins_and_deletes`: a page of a post, its edit, a reaction, a pin, a second post and
    the second post's author delete gives the first post shown edited, reacted and pinned, and the second deleted, in
    either page order.
24. `restore_indexes_search_marks_read_and_does_not_requeue`: after a page, the search finds the post's word, the
    group's `last_read_seq` is at least the highest merged seq, its unread and mention counts are 0, and
    `app_history_out` holds none of the merged seqs.
25. `restore_skips_quarantined_senders`: an entry whose sender key has an `app_quarantine` row in that group is
    `Skipped`.
26. `restore_counts_gaps`: a junk row, a row of another account and a row whose decrypted `(group, seq)` does not give
    its `entry_id` are three gaps; the rest of the page merges.
27. `restore_parks_unheld_groups_and_unpark_merges_them`: a row of a group not in `app_groups` is parked; after the
    group row appears, `history_unpark` merges it; a parked row 30 days and a second old is dropped.
28. `restore_phases_down_up_done_and_erases_sk`: an empty down page moves to phase 1 with `top` kept; an empty up page
    deletes the record and answers `done = 1`; `history_restore_state` then answers `null`.
29. `restore_record_expires_after_seven_days`: `history_status(started + 604_801)` answers `expired = 1`.
30. `the_store_schema_stays_5_with_the_history_tables`: a store opened by this build has `app_history_out`,
    `app_history_parked` and the four triggers, and its schema meta reads 5.

---

## Appendix S: server

Grounded in main at `1ad0d408`. The patterns to copy: `backups.go` (body decoding, meters, the user lock),
`auth.go` (`requireStepUp`), `messages.sql` (paired sqlite and Postgres queries with byte-identical headers).

### S.1 Migration and schema (task S1)

**Numbers (D23).** `00026_history_archive.sql` and schema `024_history_archive.sql` in both engines. The migration's
Up body is the schema file verbatim, as every migration's is (`TestMigrationCarriesEverySchemaFileVerbatim`).

SQLite (`internal/store/sqlite/schema/024_history_archive.sql`):

```sql
-- 024_history_archive.sql: message history (protocol/06 § History, protocol/09 § History),
-- migration 00026_history_archive.sql. The instance cannot open a row: entry ids are keyed hashes,
-- rows are sealed to a key derived from the person's recovery key. No time is stored per entry.
CREATE TABLE history_state (
  user_id    BLOB    PRIMARY KEY CHECK (length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  entries    INTEGER NOT NULL CHECK (entries >= 0),
  bytes      INTEGER NOT NULL CHECK (bytes >= 0),
  updated    INTEGER NOT NULL
) STRICT;
CREATE TABLE history_entries (
  n        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  BLOB    NOT NULL CHECK (length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  entry_id BLOB    NOT NULL CHECK (length(entry_id) = 16),
  del_hash BLOB    NOT NULL CHECK (length(del_hash) = 16),
  row      BLOB    NOT NULL CHECK (length(row) BETWEEN 1 AND 81920),
  UNIQUE (user_id, entry_id)
) STRICT;
CREATE INDEX history_entries_by_user ON history_entries (user_id, n);
CREATE TABLE history_tombstones (
  user_id  BLOB NOT NULL CHECK (length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  entry_id BLOB NOT NULL CHECK (length(entry_id) = 16),
  PRIMARY KEY (user_id, entry_id)
) STRICT, WITHOUT ROWID;
```

Down (both engines): `DROP TABLE history_tombstones; DROP TABLE history_entries; DROP TABLE history_state;`.

Postgres (`internal/store/postgres/schema/024_history_archive.sql`), the same comment, then:

```sql
CREATE TABLE history_state (
  user_id    BYTEA    PRIMARY KEY CHECK (octet_length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  enabled    SMALLINT NOT NULL CHECK (enabled IN (0, 1)),
  generation BIGINT   NOT NULL CHECK (generation >= 1),
  entries    BIGINT   NOT NULL CHECK (entries >= 0),
  bytes      BIGINT   NOT NULL CHECK (bytes >= 0),
  updated    BIGINT   NOT NULL
);
CREATE TABLE history_entries (
  n        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id  BYTEA  NOT NULL CHECK (octet_length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  entry_id BYTEA  NOT NULL CHECK (octet_length(entry_id) = 16),
  del_hash BYTEA  NOT NULL CHECK (octet_length(del_hash) = 16),
  row      BYTEA  NOT NULL CHECK (octet_length(row) BETWEEN 1 AND 81920),
  UNIQUE (user_id, entry_id)
);
CREATE INDEX history_entries_by_user ON history_entries (user_id, n);
CREATE TABLE history_tombstones (
  user_id  BYTEA NOT NULL CHECK (octet_length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  entry_id BYTEA NOT NULL CHECK (octet_length(entry_id) = 16),
  PRIMARY KEY (user_id, entry_id)
);
```

An absent `history_state` row means **on, generation 1, no entries**: the migration writes no rows.

### S.2 Queries and store (task S1)

`internal/store/{sqlite,postgres}/queries/history.sql`; the headers below are byte-identical across engines
(`TestQueryHeadersAreByteIdenticalAcrossEngines`); bodies use `?` on sqlite and `$n` on Postgres.

```sql
-- name: GetHistoryState :one
SELECT enabled, generation, entries, bytes FROM history_state WHERE user_id = ?;

-- name: UpsertHistoryState :exec
INSERT INTO history_state (user_id, enabled, generation, entries, bytes, updated) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled, generation = excluded.generation,
  entries = excluded.entries, bytes = excluded.bytes, updated = excluded.updated;

-- name: GetHistoryEntryHash :one
SELECT del_hash, length(row) AS row_len FROM history_entries WHERE user_id = ? AND entry_id = ?;
-- (Postgres: octet_length(row) AS row_len)

-- name: HistoryTombstoned :one
SELECT CAST(EXISTS (SELECT 1 FROM history_tombstones WHERE user_id = ? AND entry_id = ?) AS INTEGER) AS tombstoned;

-- name: InsertHistoryEntry :exec
INSERT INTO history_entries (user_id, entry_id, del_hash, row) VALUES (?, ?, ?, ?);

-- name: DeleteHistoryEntry :exec
DELETE FROM history_entries WHERE user_id = ? AND entry_id = ?;

-- name: InsertHistoryTombstone :exec
INSERT INTO history_tombstones (user_id, entry_id) VALUES (?, ?) ON CONFLICT DO NOTHING;

-- name: ListHistoryEntriesBefore :many
SELECT n, entry_id, row FROM history_entries WHERE user_id = ? AND n < ? ORDER BY n DESC LIMIT ?;

-- name: ListHistoryEntriesAfter :many
SELECT n, entry_id, row FROM history_entries WHERE user_id = ? AND n > ? ORDER BY n ASC LIMIT ?;

-- name: DeleteHistoryEntriesOfUser :execrows
DELETE FROM history_entries WHERE user_id = ?;

-- name: DeleteHistoryTombstonesOfUser :execrows
DELETE FROM history_tombstones WHERE user_id = ?;

-- name: DeleteHistoryStateOfUser :exec
DELETE FROM history_state WHERE user_id = ?;

-- name: HistoryTotals :one
SELECT CAST(COUNT(*) AS BIGINT) AS people, CAST(COALESCE(SUM(entries), 0) AS BIGINT) AS entries,
       CAST(COALESCE(SUM(bytes), 0) AS BIGINT) AS bytes FROM history_state WHERE entries > 0;

-- name: HistoryUsersAtOrOver :one
SELECT CAST(COUNT(*) AS BIGINT) AS people FROM history_state WHERE bytes >= ?;
```

"Newest first" with no `before` is `ListHistoryEntriesBefore` with `before = math.MaxInt64`.

Store types (`internal/store/rows.go`) and the sub-interface (`internal/store/store.go`, embedded in `Repository`,
listed where `TestSubInterfacesMatchTheContract` reads the sub-interfaces):

```go
type HistoryState struct { Enabled bool; Generation uint64; Entries int64; Bytes int64 }
type HistoryPut struct { EntryID, DelHash, Row []byte }
type HistoryRow struct { N int64; EntryID, Row []byte }
type HistoryTotals struct { People, Entries, Bytes, NearFull int64 }

type HistoryStore interface {
	// GetHistoryState answers the stored state, or {true, 1, 0, 0} and found=false when none is stored.
	GetHistoryState(ctx context.Context, uid id.ID) (st HistoryState, found bool, err error)
	PutHistoryState(ctx context.Context, uid id.ID, st HistoryState, now int64) error
	// GetHistoryEntryHash answers ErrNotFound when the account holds no entry with this id.
	GetHistoryEntryHash(ctx context.Context, uid id.ID, entryID []byte) (delHash []byte, rowLen int64, err error)
	HistoryTombstoned(ctx context.Context, uid id.ID, entryID []byte) (bool, error)
	InsertHistoryEntry(ctx context.Context, uid id.ID, p HistoryPut) error
	DeleteHistoryEntry(ctx context.Context, uid id.ID, entryID []byte) error
	InsertHistoryTombstone(ctx context.Context, uid id.ID, entryID []byte) error
	// ListHistoryEntries: before != nil pages down from it, after != nil pages up from it; exactly one is set.
	ListHistoryEntries(ctx context.Context, uid id.ID, before, after *int64, limit int) ([]HistoryRow, error)
	// DeleteHistoryOfUser deletes the account's entries, deleted ids and state.
	DeleteHistoryOfUser(ctx context.Context, uid id.ID) error
	HistoryTotals(ctx context.Context, nearFullBytes int64) (HistoryTotals, error)
}
```

Each method is one or two generated queries; the transactions are the handlers' (§S.4), through `d.Repo.Tx`.

### S.3 Config and the meter (task S2)

`internal/config/config.go`: `History History \`toml:"history"\`` in `Config` after `Blobs`, and

```go
type History struct {
	QuotaBytesPerUser int64 `toml:"quota_bytes_per_user" comment:"Saved message history per person, in bytes. 0 turns message history off on this instance."`
	UploadBytesPerDay int64 `toml:"upload_bytes_per_day" comment:"Bytes one device may upload to its person's history per day."`
}
```

`defaults.go`: `c.History = History{QuotaBytesPerUser: 1073741824, UploadBytesPerDay: 268435456}`.
`validate.go`: `history.quota_bytes_per_user` ≥ 0; `history.upload_bytes_per_day` ≥ 0, and ≥ 1048576 when the quota
is above 0 (message: "history.upload_bytes_per_day must be at least 1048576 while history is on").

`internal/api/api.go` `Deps`: `HistoryMeter *UploadMeter // per-DEVICE daily byte budget of POST
/v1/history/entries (history.upload_bytes_per_day); Register builds it when it is nil.` In `Register`, beside the
`StateMeter` construction: `if d.HistoryMeter == nil { d.HistoryMeter = NewStateMeter(d.Clock,
d.Config.History.UploadBytesPerDay) }` (with the same nil-`Config` guard the `StateMeter` uses).

### S.4 Routes (task S3)

Registration (`internal/api/api.go`, after the backups lines):

```go
m.Handle("GET /v1/history", d.enrolled(dsMeter(d.Limiter, dsClassRead, d.GetHistory)))
m.Handle("PUT /v1/history", d.enrolled(dsMeter(d.Limiter, dsClassWrite, d.PutHistory)))
m.Handle("POST /v1/history/entries", d.enrolled(dsMeter(d.Limiter, dsClassWrite, d.PostHistoryEntries)))
m.Handle("POST /v1/history/entries/delete", d.enrolled(dsMeter(d.Limiter, dsClassWrite, d.PostHistoryDeletes)))
m.Handle("GET /v1/history/entries", d.enrolled(dsMeter(d.Limiter, dsClassRead, d.ListHistoryEntries)))
```

`d.enrolled` refuses a pending session with `403 E_FORBIDDEN` as for the backups `PUT`.

#### S.4.1 Shared rules

- `historyQuota(d) int64` = `d.Config.History.QuotaBytesPerUser` (0 when `Config` is nil).
- `historyEffective(st, quota) bool` = `st.Enabled && quota > 0`.
- Every write handler runs in `d.Repo.Tx` and takes `tx.LockUserForDeviceRegistration(ctx, sess.UserID)` first, so one
  account's history writes are serialised (the counters stay exact).
- Body caps: `PUT /v1/history` 64 KiB (the default); `POST /v1/history/entries` `historyPutBodyCap` = 1 052 672;
  `POST /v1/history/entries/delete` 64 KiB (1024 items fit in about 37 KiB). Over the cap is `413 E_TOO_LARGE`.
- `decodeHistoryRow(row []byte) error`: `len(row)` 1..81920, and a deterministic CBOR array of 4: `uint` 1, a 32-byte
  `bstr`, a 12-byte `bstr`, a `bstr` of at least 16 bytes; else `400 E_INVALID_REQUEST "row is not a history row"`.
- A `generation` element is a CBOR `uint`; anything else is `400`.

#### S.4.2 `GET /v1/history`

`st, _ := GetHistoryState`; answer `[enabled, generation, entries, bytes, quota]` with `enabled =
historyEffective(st, quota) ? 1 : 0`. No lock.

#### S.4.3 `PUT /v1/history`

Body `[enabled(uint 0|1), stepup(tstr|null)]`; any other shape `400`.

- `enabled = 1`: `quota == 0` → `403 E_FORBIDDEN "message history is off on this instance"`. In the transaction: when
  the stored state is already enabled, answer it unchanged; else `generation + 1`, `enabled = true`, counters kept
  (they are 0 after an off), `PutHistoryState`, audit `history.on` (target the user id, detail `generation N`).
- `enabled = 0`: `d.requireStepUp(ctx, sess, stepup)` **before** the transaction (`403 E_STEP_UP`; it spends the
  token). In the transaction: when already off, answer unchanged; else `DeleteHistoryEntriesOfUser`,
  `DeleteHistoryTombstonesOfUser`, then `PutHistoryState{Enabled: false, Generation: g + 1, Entries: 0, Bytes: 0}`,
  audit `history.off` (detail `generation N, M entries`).
- Answer `200 [enabled, generation]`.

#### S.4.4 `POST /v1/history/entries`

Before the body is read: `held, err := d.HistoryMeter.begin(sess.DeviceID, reserve)` with `reserve` =
`min(historyPutBodyCap, ContentLength)` as `PutBackup` does, and `settle` with the bytes read (the `countingReader`
pattern of `backups.go`). Body `[generation(uint), entries]`, `entries` an array of 1..512 items, each
`[entry_id(bstr 16), del_hash(bstr 16), row(bstr)]` with `decodeHistoryRow(row)`; a repeated `entry_id` within the
body is `400`. Then, in the transaction:

1. Lock; `st := GetHistoryState`. `!historyEffective(st, quota)` or `generation != st.Generation` →
   `409 E_HISTORY_STALE`.
2. For each entry in body order: tombstoned (`HistoryTombstoned`) or present (`GetHistoryEntryHash` not
   `ErrNotFound`) → `dropped++`; else add to `toStore` and `newBytes += len(row)`.
3. `st.Bytes + newBytes > quota` → `507 E_STORAGE_FULL` and nothing stored (the transaction returns the error).
4. `InsertHistoryEntry` each; `st.Entries += len(toStore)`, `st.Bytes += newBytes`; `PutHistoryState`.
5. Answer `200 [stored, dropped]`.

#### S.4.5 `POST /v1/history/entries/delete`

Body `[generation(uint), items]`, 1..1024 items, each `[entry_id(bstr 16), del_token(bstr 16)]`. In the transaction:

1. Lock; state; stale or off → `409 E_HISTORY_STALE`.
2. For each item: `GetHistoryEntryHash`:
   - `ErrNotFound` → `InsertHistoryTombstone` (an id never stored, or already deleted, is recorded as deleted so a late
     upload is dropped); counts as `deleted`.
   - found and `sha256.Sum256("dilla history delete hash v1" ‖ token)[:16]` equals `del_hash` (compared with
     `subtle.ConstantTimeCompare`) → `DeleteHistoryEntry`, `InsertHistoryTombstone`, `st.Entries--`,
     `st.Bytes -= rowLen`, `deleted++`.
   - found and the hash differs → `refused++`, nothing changes.
3. `PutHistoryState`; answer `200 [deleted, refused]`.

#### S.4.6 `GET /v1/history/entries`

Query: `generation` (required, decimal uint), at most one of `before` and `after` (decimal int ≥ 0), `limit` (1..512,
default 512). Anything else, or both cursors, is `400`. No lock.

1. State; stale or off → `409 E_HISTORY_STALE` (so a restore stops when history was turned off elsewhere).
2. `ListHistoryEntries` with `before` (default `math.MaxInt64`) or `after`, `limit`.
3. Answer the rows in that order, stopping before the row that would take the answer's row bytes past
   `historyPageBytes` (1 MiB), but always at least one row: `[[n, entry_id, row]]`.

### S.5 Account deletion and revoke-all (task S3)

- `DeleteMe` (`internal/api/accounts.go:349`): inside its transaction, right after `tx.TombstoneUser(...)`, call
  `tx.DeleteHistoryOfUser(ctx, sess.UserID)`.
- `RevokeAllDevices` is unchanged; `TestRevokeAllDevicesKeepsHistory` pins it (D24).

### S.6 Backup and restore (task S1)

- `internal/store/dump.go` `DumpTables`: append after `"slowmode_marks"`, with a comment in the file's style:

  ```go
  // 024_history_archive.sql, appended by message history S1. All three tables' parent is users. A
  // restore that dropped history_tombstones would let a late browser upload a message its author
  // deleted; one that dropped history_state would reset every person's generation and switch.
  "history_state", "history_entries", "history_tombstones",
  ```

- `DumpPostgres`: for `history_entries` only, write the table as several records instead of one buffered COPY, each
  the output of `COPY (SELECT * FROM history_entries WHERE n > %d ORDER BY n LIMIT 65536) TO STDOUT (FORMAT binary)`
  (the `%d` is the last `n` written, starting at 0; read it back with `SELECT max(n) FROM (SELECT n FROM
  history_entries WHERE n > %d ORDER BY n LIMIT 65536) s` in the same snapshot), until a page holds no rows. Each
  record has the usual header with the table name `history_entries`. A table with no rows still writes one (empty)
  record, so a dump always names every table.
- `LoadPostgres` needs no change: it already COPYs each record into its table, and repeated records of one table
  append. `resetIdentities` moves `history_entries.n` past the highest restored value.
- `internal/ops/restore.go` `dumpRowCounts`: `counts[table] += n` (was `=`), so the dry run reports all of a split
  table's rows.
- SQLite needs no change (`VACUUM INTO`).

### S.7 Doctor (task S4)

`ops.HistoryLeg(ctx context.Context, repo store.Repository, cfg config.Config) Leg`, name `history`:

1. `t, err := repo.HistoryTotals(ctx, cfg.History.QuotaBytesPerUser * 9 / 10)`; an error is `Red` with
   `"read history totals: " + err`.
2. `cfg.History.QuotaBytesPerUser == 0 && t.Entries > 0` → `Yellow`, detail `"off on this instance, but N people
   still hold M saved entries"`, fix `"each person deletes theirs in Settings → Privacy, or set
   history.quota_bytes_per_user above 0"`.
3. `t.NearFull > 0` → `Yellow`, detail `"N people at 90 % of history.quota_bytes_per_user or more"`, fix `"raise
   history.quota_bytes_per_user in dilla.toml"`.
4. Otherwise `Green`, detail `"N people, M entries, X MiB saved"` (MiB rounded to one decimal).

`NearFull` is `HistoryUsersAtOrOver(nearFullBytes)` filled by `HistoryTotals` (0 when the quota is 0). Wire it in
`cmd/dillad/doctor.go` after the blobs leg (`add(doctorHistoryLeg(ctx, cfg, repo))`, which answers `Yellow
"skipped: the database did not open"` with a nil repo) and in `internal/dillad/diagnostics.go` after
`BlobConsistencyLeg`.

### S.8 Server tests

#### S.8.1 Store, migration and dump (S1), `internal/store/history_test.go`, `schema_test.go`, `dump_test.go`

- `TestHistoryStateDefaultsToOnAtGenerationOne`: an account with no row answers `{true, 1, 0, 0}`, `found = false`.
- `TestHistoryEntriesRoundTripAndPage`: insert 5 entries; `before = MaxInt64, limit 2` answers the two newest in
  descending `n`; `after = n of the third, limit 10` answers the last two ascending.
- `TestHistoryEntryIdIsUniquePerUser`: the same id twice for one user fails the unique constraint; for two users
  succeeds.
- `TestHistoryTombstoneIsRecordedOnce`: two `InsertHistoryTombstone` calls leave one row and no error.
- `TestDeleteHistoryOfUserLeavesOthers`: deletes one account's entries, tombstones and state; another's stay.
- `TestHistoryGoesWithTheUserRow`: deleting a `users` row (test-only) cascades all three tables.
- `TestHistoryArchiveMigrationIsSchemaVersion26` (renumber with D23), and green: `TestDumpTablesNamesEverySchemaTable`,
  `TestEverySQLiteTableIsStrictAndTyped`, `TestGooseUpDownUpOnSQLite`/`Postgres`,
  `TestMigrationCarriesEverySchemaFileVerbatim`, `TestQuerierInterfacesAreIdentical`,
  `TestQueryHeadersAreByteIdenticalAcrossEngines`, `TestSubInterfacesMatchTheContract`,
  `TestMigrationsAreNumberedWithoutGaps`, `TestSchemaFilesAreNumberedWithoutGaps`. `sqlc diff` clean.
- `TestADumpRoundTripsHistory` (Postgres): state, entries and tombstones survive dump and load; the next insert gets
  an `n` above the restored maximum.
- `TestPostgresDumpSplitsHistoryIntoBoundedRecords` (Postgres): with 65 537 entries the dump holds two
  `history_entries` records, and the load restores 65 537 rows.
- `TestRestoreDryRunSumsRepeatedRecords` (`internal/ops`): `dumpRowCounts` of a two-record table answers the sum.

#### S.8.2 Routes (S3), `internal/api/history_test.go` unless named

Every authz case is written red first.

- `TestHistoryGetAnswersDefaultsForANewAccount`: `[1, 1, 0, 0, 1073741824]`.
- `TestHistoryGetSaysOffWhenTheQuotaIsZero`: with quota 0, `enabled` reads 0 and `quota` 0.
- `TestHistoryRoutesRefuseAPendingSession`: each of the five routes answers `403 E_FORBIDDEN` to a pending session.
- `TestHistoryPutStoresAndDropsDuplicates`: two entries → `[2, 0]`; the same two again → `[0, 2]`; counters `entries 2`,
  `bytes` the two row lengths.
- `TestHistoryPutRefusesAStaleGeneration`: generation 2 while the account is at 1 → `409 E_HISTORY_STALE`, nothing
  stored.
- `TestHistoryPutRefusesWhileOff`: after off, a put with the new generation → `409 E_HISTORY_STALE`.
- `TestHistoryPutChecksShapes`: a row of the wrong array length, version 2, a 31-byte `enc`, an 11-byte nonce, a
  15-byte ciphertext, a row of 81 921 bytes, a 15-byte id, a 17-byte hash, 0 entries, 513 entries and a repeated id
  are each `400 E_INVALID_REQUEST`; a body over 1 052 672 bytes is `413 E_TOO_LARGE`.
- `TestHistoryPutOverQuotaStoresNothing`: with a 600-byte quota, a put whose rows total 601 bytes → `507
  E_STORAGE_FULL` and `entries` stays 0; a put of 600 bytes then succeeds.
- `TestHistoryUploadSpendsTheDeviceByteBudget`: with `upload_bytes_per_day = 1048576`, puts past it from one device →
  `429 E_RATE_LIMITED` with `retry_after_ms`; another device of the same user is not limited.
- `TestHistoryDeleteNeedsTheToken`: a wrong token → `[0, 1]` and the row stays; the right token → `[1, 0]`, the row
  is gone, the counters drop.
- `TestHistoryDeletedIdIsNeverStoredAgain`: after a delete, a put of the same id → `[0, 1]`.
- `TestHistoryDeleteOfAnAbsentIdRecordsIt`: deleting an id never stored → `[1, 0]`; a later put of it → `[0, 1]`.
- `TestHistoryListPagesNewestFirstThenAfter`: 600 entries: no cursor `limit 512` answers 512 newest descending;
  `before` the lowest answers the remaining 88; `after` the highest answers `[]`.
- `TestHistoryListStopsAtOneMebibyte`: 20 rows of 80 KiB answer 12 rows (≤ 1 MiB); one row larger than the page is
  still answered alone.
- `TestHistoryListChecksItsQuery`: no `generation`, both cursors, `limit 0`, `limit 513`, a negative cursor → `400`;
  a stale generation → `409 E_HISTORY_STALE`.
- `TestHistoryIsOwnAccountOnly`: user B's list never answers user A's rows, and B's delete of A's id with A's token
  records a tombstone in B's account and leaves A's row.
- `TestHistoryOffNeedsAStepUp`: `[0, null]` → `403 E_STEP_UP`, nothing deleted; with a valid token → `[0, 2]`.
- `TestHistoryOffDeletesEverythingAndBumpsTheGeneration`: after off, entries and tombstones are gone and `GET` answers
  `[0, 2, 0, 0, quota]`.
- `TestHistoryOnAgainBumpsTheGeneration`: on after off → `[1, 3]`; on when on → unchanged.
- `TestHistoryOnWithQuotaZeroIsForbidden`: `[1, null]` with quota 0 → `403 E_FORBIDDEN`.
- `TestHistoryAuditsOffAndOn`: an audit row `history.off` then `history.on`, each naming the user.
- `TestHistoryCountersStayExact`: after a mixed run of puts, duplicates, deletes and refusals, `entries` and `bytes`
  equal `COUNT(*)` and `SUM(length(row))` of the account's rows.
- `TestDeleteMeDeletesHistory` (`accounts_delete_test.go`): after `DELETE /v1/accounts/me`, the account has no history
  rows of any of the three tables.
- `TestRevokeAllDevicesKeepsHistory` (`internal/ops/revoke_devices_test.go`): entries survive `RevokeAllDevices`.
- `internal/server/errors_test.go`: a row `{server.Errorf(server.CodeHistoryStale, ""), 409, 3}`.

---

## Appendix C: client-core

All in `packages/client-core/src`. `Id` is the 16-byte `Uint8Array` type of `core-port.ts`; times passed to the core are
unix seconds as `bigint`.

### C.1 CorePort (task K3)

```ts
export interface HistoryCoreStatus {
  keys: boolean; on: boolean; generation: bigint | null; queued: number;
  restore: { phase: 0 | 1; done: number; gaps: number; merged: number; started: bigint } | null;
  expired: boolean;
}
export interface HistoryPut { entryId: Uint8Array; delHash: Uint8Array; row: Uint8Array }
export interface HistoryDeleteItem { entryId: Uint8Array; delToken: Uint8Array }
export interface HistoryTake { generation: bigint; puts: HistoryPut[]; deletes: HistoryDeleteItem[]; taken: bigint[] }
export interface HistoryRestoreResult { done: boolean; merged: number; parked: number; skipped: number; gaps: number; groups: Id[] }
export interface HistoryRestoreState { phase: 0 | 1; before: bigint | null; top: bigint | null; done: number; gaps: number; merged: number; started: bigint }

// in CorePort:
historyStatus(now: bigint): HistoryCoreStatus;
historySetServer(enabled: boolean, generation: bigint): HistoryCoreStatus;
historyUnlock(input: { recoveryKey: string; rootSealed: Uint8Array; now: bigint }): HistoryCoreStatus;
historyTake(maxRows: number, maxBytes: number): HistoryTake;
historyDone(taken: readonly bigint[]): void;
historyRestorePage(rows: Uint8Array, now: bigint): HistoryRestoreResult;   // rows: the route's raw CBOR answer
historyRestoreState(): HistoryRestoreState | null;
historyRestoreCancel(): void;
historyUnpark(now: bigint): { merged: number; groups: Id[] };
```

Each decodes the facade's CBOR (§K.7) with the existing `decoded(name, bytes, reader)` helper; a shape error is
`CoreError('E_CORE_STORAGE', …)` as for the other methods. `historyDone` encodes `taken` as a CBOR array of uints.
`fake-core.ts` implements all nine over an in-memory queue and an in-memory restore record (no crypto: a put's `row` is
the CBOR of `[group_id, seq]`, and `historyRestorePage` accepts rows of that fake shape), so worker tests run without
wasm.

### C.2 Routes and errors (task C1)

`http/routes.ts`:

```ts
export interface HistoryInfo { enabled: boolean; generation: bigint; entries: number; bytes: number; quota: number }
export interface HistorySet { enabled: boolean; generation: bigint }
export interface HistoryStored { stored: number; dropped: number }
export interface HistoryDeleted { deleted: number; refused: number }
export type HistoryCursor = { before: bigint } | { after: bigint } | Record<string, never>;

async getHistory(): Promise<HistoryInfo>             // GET /v1/history, bucket 'read', idempotent
async setHistory(enabled: boolean, stepup: string | null): Promise<HistorySet>   // PUT /v1/history, 'write'
async postHistoryEntries(generation: bigint, puts: readonly HistoryPut[]): Promise<HistoryStored>
  // POST /v1/history/entries, 'write', idempotent: true (a repeat is answered as dropped), timeoutMs BACKUP_TIMEOUT_MS
async postHistoryDeletes(generation: bigint, items: readonly HistoryDeleteItem[]): Promise<HistoryDeleted>
  // POST /v1/history/entries/delete, 'write', idempotent: true
async getHistoryEntries(generation: bigint, cursor: HistoryCursor, limit: number): Promise<Uint8Array>
  // GET /v1/history/entries?generation=G[&before=B|&after=A]&limit=L, 'read', idempotent; answers the raw CBOR body
  // (checked to be an array) for core.historyRestorePage
```

Bodies: `encode([enabled ? 1 : 0, stepup])`, `encode([generation, puts.map(p => [p.entryId, p.delHash, p.row])])`,
`encode([generation, items.map(i => [i.entryId, i.delToken])])`. Answers decode with `atLeast`, `u53`, `u64`, `bin` as
the backups routes do; `enabled` is `oneOf(a[0], [0, 1]) === 1`.

`http/errors.ts`: add `'E_HISTORY_STALE'` to the known codes. No page copy maps it: the worker handles it.

`testing/fake-server.ts`: the five routes over an in-memory account state (enabled, generation, entries by id with
`n`, tombstones), following §S.4 exactly (stale, quota, dedupe, tokens checked by recomputing the hash with
WebCrypto SHA-256, newest-first paging), so C2, C3 and the web tests run against it.

### C.3 History state (task C2), `history/state.ts`

```ts
export class HistoryState {
  info: HistoryInfo | null = null;
  available = false;        // the instance answered GET /v1/history and quota > 0
  full = false;             // the last upload got 507
  loadFailed = false;       // the last GET failed for another reason
  constructor(private readonly deps: { core: CorePort; routes: Routes; now(): number; changed(): void }) {}
  async refresh(): Promise<void>;
  async setEnabled(on: boolean, stepup: string | null): Promise<void>;
  effective(): boolean;     // available && info.enabled
}
```

- `refresh()`: `getHistory()`. A `DillaHttpError` with status 404 → `available = false`, `info = null`,
  `core.historySetServer(false, 0n)` is **not** called (an old instance; nothing to clear), `changed()`. Another error →
  `loadFailed = true`, `changed()`, rethrow nothing. Success → `available = info.quota > 0`, `loadFailed = false`,
  `core.historySetServer(info.enabled && info.quota > 0, info.generation)`, `changed()`.
- `setEnabled(on, stepup)`: `setHistory(on, on ? null : stepup)`, then `refresh()`. Errors propagate to the command
  (the page shows `history.off.failed` or `history.on.failed`).

### C.4 The uploader (task C2), `history/uploader.ts`

```ts
export const FLUSH_OPS = 256;
export const FLUSH_AFTER_MS = 20_000;
export const BACKOFF_MIN_MS = 2_000;
export const BACKOFF_MAX_MS = 300_000;
export const FULL_RETRY_MS = 3_600_000;

export class HistoryUploader {
  constructor(private readonly deps: { core: CorePort; routes: Routes; state: HistoryState; now(): number;
    random(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }) {}
  start(): void;   // arms the 20 s tick
  poke(): void;    // after a group change or an outbox change
  flush(): Promise<void>;   // single-flight
  stop(): void;    // clears timers; an in-flight flush finishes its request and stops
}
```

Rules:

1. **When to flush.** `poke()` reads `core.historyStatus(now).queued` and flushes at once when it is ≥ `FLUSH_OPS`. The
   tick runs every `FLUSH_AFTER_MS` and flushes when `queued > 0`. `start()` and each ready (C.7) also flush. Nothing
   runs unless `state.effective()` and the status says `keys && on`.
2. **A flush** loops: `t = core.historyTake(512, 1_000_000)`; stop when `t.puts`, `t.deletes` and `t.taken` are all
   empty; `postHistoryEntries(t.generation, t.puts)` when there are puts; `postHistoryDeletes` per 1024 deletes; then
   `core.historyDone(t.taken)`; loop.
3. **Errors** (the batch's queue rows stay; `historyDone` is not called):
   - network error, `500`, `503`: wait `min(BACKOFF_MAX_MS, BACKOFF_MIN_MS × 2^k) × (0.8 + 0.4 × random())`, `k` the
     consecutive failures, then flush again; a success resets `k`.
   - `429`: wait `retry_after_ms`, then flush again.
   - `409 E_HISTORY_STALE`: `await state.refresh()` (which applies the new generation or off to the core), then flush
     again once.
   - `507`: `state.full = true`, `state.deps.changed()`; no retry before `FULL_RETRY_MS` or the next ready, whichever
     is later. A later successful put clears `full`.
   - `403`: stop until the next ready.
   - `400`, `413`: `historyDone(t.taken)` (the batch is unusable; dropping it is the only way past it), log nothing,
     go on.
4. **Offline.** No timer fires while the gateway is not ready; the queue is in the store.

### C.5 The restore runner (task C3), `history/restore.ts`

```ts
export const PAGE_LIMIT = 512;
export interface RestoreProgress { state: 'none' | 'running' | 'done' | 'stopped' | 'failed'; done: number; total: number; gaps: number; merged: number }

export class HistoryRestore {
  progress: RestoreProgress = { state: 'none', done: 0, total: 0, gaps: 0, merged: 0 };
  constructor(private readonly deps: { core: CorePort; routes: Routes; state: HistoryState; now(): number;
    random(): number; setTimeout(fn: () => void, ms: number): unknown; changed(): void; touched(groups: Id[]): void }) {}
  run(): Promise<void>;   // single-flight; returns when done, stopped or failed
  stop(): void;
}
```

`run()`:

1. `s = core.historyStatus(nowS)`. No restore record → `progress.state` stays as it is (`done` after a finished run,
   else `none`); return.
2. `s.expired` → `core.historyRestoreCancel()`, `state = 'stopped'`, `changed()`; return.
3. `!state.effective()` → when `state.available` is false or history is off: `core.historyRestoreCancel()`,
   `progress.state = 'none'`; return.
4. `total = state.info.entries` (read once per run), `state = 'running'`, `changed()`.
5. Loop: `r = core.historyRestoreState()`; `cursor = r.phase === 0 ? (r.before === null ? {} : { before: r.before }) :
   { after: r.top ?? 0n }`; `body = await routes.getHistoryEntries(info.generation, cursor, PAGE_LIMIT)`;
   `res = core.historyRestorePage(body, nowS)`; `progress.done = r.done + rows`, `gaps`, `merged` from the core's
   record (`historyRestoreState()` after the page, or the result when done); `touched(res.groups)` when non-empty;
   `changed()`; `res.done` → `state = 'done'`, `changed()`, return.
6. Errors: network, `500`, `503`: back off as §C.4 and retry the same page. `409 E_HISTORY_STALE`: `await
   state.refresh()` (off clears the record in the core), `state = 'none'` if the record is gone, else retry once.
   `429`: wait `retry_after_ms`. Anything else: `state = 'failed'`, `changed()`, return (the next ready runs it again
   from the stored cursor).

If Jonas keeps the read key (§14 Q1): step 5's `res.done` keeps the record and every ready runs only the up phase.

### C.6 The slice (task C2), `history/slice.ts` and `state/types.ts`

```ts
export interface HistorySlice {
  available: boolean;        // false: the instance has no history (404, or quota 0)
  loadFailed: boolean;
  enabled: boolean;          // the account switch (info.enabled)
  keys: boolean;             // this browser holds the write keys
  entries: number; bytes: number; quota: number;
  full: boolean;
  queued: number;
  restore: RestoreProgress;
}
export function historySlice(state: HistoryState, status: HistoryCoreStatus, restore: RestoreProgress): HistorySlice;
```

`SliceName` gains `'history'`. `TimelineSlice` (the `timeline:<channel>` slice) gains `restoring: boolean`, true while
`restore.progress.state === 'running'`. The controller publishes `history` after every `changed()` (debounced to one
publish per macrotask, as the other slices are).

### C.7 Worker wiring (tasks C2 and C3), `worker/controller.ts` and `worker/protocol.ts`

Commands (`worker/protocol.ts`, after `regenerateBackupCodes`):

```ts
| { m: 'historyRefresh' }                                             // ready → null; slice history
| { m: 'historySetEnabled'; on: boolean; stepup: string | null }     // ready → null; slice history; off needs stepup
| { m: 'historyUseKey'; recoveryKey: string }                         // ready → null; slice history
```

`historyUseKey` is added to the commands whose `recoveryKey` must not be blank (`controller.ts:669`) and to the ready
phase's allowed list.

Controller:

- **Construction.** When the session parts are built (where `sync` is built, `controller.ts:1543`): `this.historyState`,
  `this.historyUploader`, `this.historyRestore` with the deps above; `touched(groups)` calls `this.touchGroup(g)` for
  each (which refreshes an open timeline). `forgetAccount` and the wipe stop the uploader and the runner and set the
  three to null.
- **Sync hooks.** `onGroupChanged` and `onOutboxChanged` also call `this.historyUploader?.poke()`.
- **onReady** (`controller.ts:1657`): `void this.barrier.track(this.historyState.refresh().then(() =>
  this.historyUploader.flush()).catch(() => undefined))`.
- **End of `refreshAfterReady`** (C3): `core.historyUnpark(nowS)` (touch its groups), then
  `void this.barrier.track(this.historyRestore.run())`.
- **`historySetEnabled`**: `await historyState.setEnabled(on, stepup)`; off also `historyRestore.stop()`; then publish.
- **`historyUseKey`** (C3): `root = await routes.getBackup(0)` (null → `E_NO_BACKUP`); `core.historyUnlock({
  recoveryKey, rootSealed: root.object, now })` (`E_RECOVERY_KEY` propagates as the command's error);
  `await historyState.refresh()` (queues the backfill); `historyUploader.flush()` (not awaited);
  `void historyRestore.run()`; publish.
- **Sign-in** (C3): nothing extra: `enrol_complete` wrote the restore record; the first ready's refresh and the end of
  `refreshAfterReady` start the run.
- **`refreshTimeline`** (C3): set `restoring` on the timeline slice.

### C.8 What the page reads

The page reads only the `history` slice, `TimelineSlice.restoring`, and the answers of the three commands. It never
sees a key, a row or an entry id.

### C.9 Tests

#### C.9.1 `http/routes.test.ts`, "Routes: history" (C1)

- "getHistory decodes the five elements" (`[1, 3, 10, 5120, 1073741824]`).
- "setHistory sends [0, token] and [1, null]".
- "postHistoryEntries sends [generation, [[id, hash, row]]] and decodes [stored, dropped]".
- "postHistoryDeletes sends [generation, [[id, token]]] and decodes [deleted, refused]".
- "getHistoryEntries puts generation, one cursor and limit in the query" (no cursor, `before`, `after`).
- "a 409 E_HISTORY_STALE surfaces as a DillaHttpError with that code".
- `testing/fake-server.test.ts` "fake history follows §S.4": stale generation, dedupe, quota 507, token check,
  newest-first paging, off deletes and bumps.

#### C.9.2 `history/state.test.ts` (C2)

- "a 404 makes history unavailable and leaves the core alone".
- "quota 0 is unavailable and tells the core off".
- "each refresh hands enabled and generation to the core".
- "a failed read sets loadFailed and does not throw".
- "setEnabled(false, token) sends the token, then refreshes".

#### C.9.3 `history/uploader.test.ts` (C2), fake core, fake server, fake timers

- "poke flushes at 256 queued operations and not at 255".
- "the tick flushes after 20 s when anything is queued".
- "a flush loops until the queue is empty and calls historyDone once per batch".
- "puts go before deletes and deletes go in chunks of 1024".
- "historyDone is not called when the put fails".
- "5xx backs off 2 s, 4 s, 8 s … up to 300 s, and a success resets it".
- "429 waits retry_after_ms".
- "409 refreshes the state and flushes again once".
- "507 marks full and waits an hour".
- "400 drops the batch and goes on".
- "nothing runs while history is off, unavailable or without keys".

#### C.9.4 `history/restore.test.ts` (C3)

- "pages down, then up from top, then done".
- "resumes from the stored cursor after a restart".
- "an expired record is cancelled and shows stopped".
- "history off or unavailable cancels the record".
- "409 refreshes; when history went off the run ends as none".
- "touched groups are handed to the controller".
- "progress counts done of total, with gaps and merged".
- "a network error retries the same page after a back-off".

#### C.9.5 `worker/controller.test.ts`, describe "message history"

- (C2) "ready refreshes history and publishes the slice".
- (C2) "a group change pokes the uploader".
- (C2) "historySetEnabled off sends the step-up token and publishes off".
- (C2) "sign-out stops the uploader".
- (C3) "signInKey with history on restores after the first ready and the timeline says restoring".
- (C3) "a restored page refreshes the open channel's timeline".
- (C3) "historyUseKey with a wrong key answers E_RECOVERY_KEY and changes nothing".
- (C3) "historyUseKey on a browser without keys backfills, uploads and restores".
- (C3) "ready unparks parked rows".

---

## Appendix U: web, ui and copy

Jonas's taste governs: Mesh's terminal/mono feel, keyboard-first, silent about cryptography in chrome; the Privacy page
is the one place that explains it. No new `@dilla/ui` component.

### U.1 Settings → Privacy: the history section (task W2)

`History.tsx` renders, first in `Privacy.tsx`'s section (above the trust list), with `aria-labelledby` on an `h3`:

```
Message history                                     (h3, history.heading)
[ save message history ]  (Toggle)                  (SettingsRow label history.toggle; hint none)
  {status line}                                     (one <p role="status">, below)
  Your browsers save the messages they can read …   (history.body)
  Anyone who has your recovery key can read …       (history.risk)
  Files are not copied …                            (history.files)
  Restored messages were checked by the browser …   (history.checked)
  [ enter recovery key ] or [ restore again ]       (Button variant ghost; below the paragraphs)
```

The status line, in this order of precedence (exactly one shows):

| Condition (from the `history` slice) | Copy | Tone |
|---|---|---|
| `!available && !loadFailed` | `history.unavailable` (and no toggle, no button, no paragraphs but `history.body`) | plain |
| `loadFailed` | `history.loadFailed` | warn |
| `!enabled` | `history.offBody` | plain |
| `restore.state === 'running'` | `history.restoring` with `{done}`, `{total}` (grouped digits, `Intl.NumberFormat`) | plain |
| `restore.state === 'stopped'` | `history.stopped` | warn |
| `!keys` | `history.locked` | warn |
| `full` | `history.full` with `{quota}` | danger |
| `restore.state === 'done'` | `history.restored` with `{merged}`, then `history.gaps` with `{gaps}` when `gaps > 0` | plain |
| otherwise | `history.usage` with `{count}` = entries (grouped digits), `{size}` and `{quota}` formatted by the existing `formatSize` (`screens/shell-model.ts:315`) | plain |

The button: `history.useKey` when `!keys` or `restore.state === 'stopped'`; else `history.restoreAgain`; hidden while
unavailable, off or running. Pressing it opens `KeyDialog` with `title = history.key.title`, `body = history.key.body`,
`confirmLabel = history.key.submit`, `onConfirm = key => client.call({ m: 'historyUseKey', recoveryKey: key })`. A
refusal `E_RECOVERY_KEY` shows `history.key.wrong` in the dialog (the dialog's existing error path).

The toggle: `checked = enabled`; disabled while unavailable or while a command runs.
- **On** → `client.call({ m: 'historySetEnabled', on: true, stepup: null })`; a failure shows `history.on.failed` in the
  status line until the next slice.
- **Off** → `ConfirmDialog` (`tone="danger"`, title `history.off.title`, body `history.off.body`, confirm
  `history.off.confirm`, busy `history.off.busy`, cancel `factorSettings.cancel`), then `StepUpDialog` (as Settings → Sign-in
  uses it), then `historySetEnabled { on: false, stepup: token }`; a failure sets the dialog's `error` to
  `history.off.failed`. Focus returns to the toggle.

Layout uses the existing `dw-settings-section`, `SettingsRow` and `dw-trust-state` classes (`data-tone` for warn and
danger). At 390 px the section is one column and every control is 44 px (the phone shell's rule).
`data-doc-state` values for the screenshots: `history-on`, `history-restoring`, `history-locked`, `history-off`.

### U.2 Settings wiring (task W2)

`Settings.tsx` passes `history={useSlice('history')}` and the handlers to `Privacy`, which passes them to `History`.
`Privacy`'s props become `{ records, onCompare, history }`. No new nav entry.

### U.3 Sign-in, sign-up, timeline, empty channel and banner (task W3)

- **Sign-in done step** (`SignIn.tsx`): body `signin.done.body` when the `history` slice says `available && enabled`
  at the moment the step shows; otherwise `signin.done.bodyNoHistory`. (The slice arrives with the first ready, before
  the done step's button.)
- **Sign-up, the recovery-key step** (`Onboarding.tsx`, step 3): add one paragraph `onboarding.keys.history` after
  `onboarding.keys.loss`. The browser step keeps `onboarding.browser.oneBrowser` (its value changes in W1).
- **Timeline top** (the conversation log's top, where it shows nothing more to load): when the timeline slice's
  `restoring` is true and `hasEarlier` is false, one line `history.timeline` as a `d-label` (lower contrast, not a
  banner), `role="status"`.
- **Empty channel**: `restoring` → `shell.log.emptyRestoring`; else history `available && enabled && keys` →
  `shell.log.emptyHistory`; else `shell.log.empty` (unchanged).
- **Banner** (`HistoryBanner.tsx`, mounted by `Shell` where the other persistent banners are, at the top of the
  conversation pane on a computer and on Home on a phone): shown when `available && enabled && !keys` and the pref
  `dilla.history.bannerDismissed` is not `"1"`. `Banner tone="info"` with `history.banner` and its one `action`,
  `history.banner.open`, which opens Settings → Privacy and focuses the history heading. Showing the history section
  (from the banner or from Settings) sets the pref to `"1"`, so the banner shows until the person has seen the
  section once. It also goes when keys exist. (`Banner` takes one action; no second button is added.)

### U.4 Copy (task W1)

Every key and value, byte for byte. Typographic apostrophes (U+2019). `{instance}` is the instance name.
Chrome (labels, buttons, the toggle) is lower case; headings and notices are sentence case with a full stop.

New file `packages/web/src/strings/history.ts`:

| Key | Value |
|---|---|
| `history.heading` | `Message history` |
| `history.toggle` | `save message history` |
| `history.body` | `Your browsers save the messages they can read to {instance}, locked with a key made from your recovery key. When you sign in on a new browser and enter the recovery key, your earlier messages come back there. {instance} cannot read them.` |
| `history.risk` | `Anyone who has your recovery key can read this saved history, including old messages. Keep the key offline, away from this computer.` |
| `history.files` | `Files are not copied. Their keys are saved, so old files open for as long as {instance} keeps them.` |
| `history.checked` | `Restored messages were checked by the browser that saved them.` |
| `history.usage` | `{count} messages saved, using {size} of {quota}.` |
| `history.full` | `Saved history is full ({quota}). New messages are not being saved. The host of {instance} can raise the limit.` |
| `history.locked` | `This browser is not saving its messages yet. Enter your recovery key once to start, and to get the messages your other browsers saved.` |
| `history.useKey` | `enter recovery key` |
| `history.restoreAgain` | `restore again` |
| `history.restoring` | `Restoring your message history: {done} of {total}.` |
| `history.restored` | `Message history restored: {merged} messages added to this browser.` |
| `history.gaps` | `{gaps} saved messages could not be opened and were skipped.` |
| `history.stopped` | `Restoring stopped before it finished. Enter your recovery key to finish it.` |
| `history.offBody` | `Message history is off. Each browser keeps only the messages it received, and a new browser starts empty.` |
| `history.unavailable` | `{instance} does not save message history.` |
| `history.loadFailed` | `Message history could not be read. dilla reads it again when it reconnects.` |
| `history.on.failed` | `Message history could not be turned on. Check the connection and turn it on again.` |
| `history.off.title` | `Turn off message history?` |
| `history.off.body` | `This deletes the saved history of all your browsers from {instance}. Messages already in a browser stay there. A browser you sign in to later starts empty.` |
| `history.off.confirm` | `turn off and delete` |
| `history.off.busy` | `Deleting…` |
| `history.off.failed` | `Message history could not be turned off. Nothing was deleted.` |
| `history.key.title` | `Enter your recovery key` |
| `history.key.body` | `The 52-character key you wrote down when you created the account. This browser uses it once to save and restore your message history, then forgets it.` |
| `history.key.submit` | `use key` |
| `history.key.wrong` | `That is not this account’s recovery key.` |
| `history.timeline` | `Older messages are still being restored.` |
| `history.banner` | `This browser is not saving your messages for your other browsers yet.` |
| `history.banner.open` | `open privacy` |

Changed and added in existing files (`en.ts` or the file that holds the key today):

| Key | Value |
|---|---|
| `signin.done.body` (changed) | `This browser is now a device of {username} on {instance}. Your earlier messages are being restored here and appear as they arrive.` |
| `signin.done.bodyNoHistory` (new) | `This browser is now a device of {username} on {instance}. Messages sent before now are not shown here.` |
| `onboarding.browser.oneBrowser` (changed) | `To use this account in another browser, sign in there with your password and the second factor you add next, then this recovery key. Your earlier messages are restored there.` |
| `onboarding.keys.history` (new) | `Your messages are also saved on {instance}, locked with this key, so a new browser can get them back. Anyone who has this key can read them.` |
| `shell.log.emptyRestoring` (new) | `nothing here yet. Older messages are still being restored.` |
| `shell.log.emptyHistory` (new) | `nothing here yet.` |

`shell.log.empty` keeps its value. `shell.log.*` starts lower case like `shell.log.empty` (it is chrome in the log's
mono style). `history.off.busy` uses U+2026.

### U.5 Flow 19 (task W1)

`docs/design/flows/19-message-history.md`, in the shape of flow 17: `# Flow 19 — Message history`, then `## States`
(the status table of §U.1 and the banner's rule), `## Sign-in and sign-up` (§U.3), `## Copy` with every pair of §U.4
as one line `` `key='value'` `` (37 pairs: the 31 new `history.*` keys and the 6 changed or new ones), and
`## Not in this flow` (new-member history; files; native pairing).

### U.6 User docs and README (task D1)

- README "what works": replace "Messages sent before a new browser joins are not shown there." with: "Message history
  (web3.13, on by default): your browsers save the messages they can read to the server, locked with a key made from
  your recovery key, and a browser you sign in to with the key gets your earlier messages back (files open while the
  server keeps them); anyone who has your recovery key can read that history, and Settings → Privacy turns it off and
  deletes it."
- `docs/user/getting-started.md`: a section "Your message history" after the recovery-key section: what is saved (every
  message, edit, reaction and pin your browsers could read; not calls; not files, whose keys are saved), when it comes
  back (signing in with the recovery key; progress in Settings → Privacy and at the top of a conversation), the
  trade-off in the words of §10, turning it off (what is deleted, the step-up), browsers from before web3.13 ("enter
  recovery key" once), and a full history. Lines 108, 652, 701 and 856 are rewritten to say earlier messages come back
  when history is on, and are not shown when it is off.
- `docs/deploy/README.md`: `[history]` with both settings and their defaults; "Each person keeps their own copy of the
  messages they can read: about 0.6 KB per message, reaction or edit, so 50 people in a server with 100 000 messages
  take about 3 GB"; the table row of §11; the doctor's `history` leg; rollback deletes saved history.
- `docs/deploy/releases/v0.1.0-web3.13.md`: the §10 paragraph verbatim, the schema line of §12, the rollback line of
  §11.

### U.7 Web tests

#### U.7.1 `strings.flow19.test.ts` (W1)

- "strings: every flow-19 copy key equals en.ts byte for byte, and every new key is in the flow": 37 pairs; each equals
  `en`; none matches a `FORBIDDEN` word; every `en` key matching `/^history\./` is listed.
- "chrome is lower case and notices are sentence case; no exclamation, no reassurance": lower case for
  `history.toggle`, `history.useKey`, `history.restoreAgain`, `history.off.confirm`, `history.key.submit`,
  `history.banner.open`, `shell.log.emptyRestoring`, `shell.log.emptyHistory`; upper case
  first for every other pair; no pair matches `/!|\bsecure\b|\bsafe\b|\bprotected\b/i`.
- "the trade-off is said the same way in three places": `history.risk`, `onboarding.keys.history` and
  `history.off.body` each contain `recovery key` or `this key`, and `history.risk` contains `including old messages`.
- "apostrophes are typographic": `history.key.wrong` contains U+2019 and no U+0027.
- `strings.test.ts`: the two pinned lines take the new values of `onboarding.browser.oneBrowser` and
  `signin.done.body`.

#### U.7.2 `History.test.tsx` and `Privacy.test.tsx` (W2)

- "on: shows the usage line, the three paragraphs and restore again".
- "locked: shows the locked line and enter recovery key; the key dialog calls historyUseKey".
- "a wrong key shows That is not this account’s recovery key. in the dialog".
- "restoring: shows done of total with grouped digits and no button".
- "full: shows the danger line with the quota".
- "off: the toggle opens the confirmation, then the step-up, then calls historySetEnabled with the token".
- "cancelling the confirmation or the step-up leaves history on and focuses the toggle".
- "unavailable: no toggle and no button".
- "the section passes axe in light, dark and high-contrast, and at 390 px".
- `Privacy.test.tsx`: "the history section comes before the trust list".

#### U.7.3 (W3)

- `SignIn.test.tsx`: "the done step says earlier messages are being restored when history is on" and "… says messages
  sent before now are not shown when history is off or unavailable".
- `Onboarding.test.tsx`: "the recovery-key step says the key opens the saved history".
- The conversation log's test: "the top says older messages are still being restored while restoring and nothing
  earlier is loaded"; "an empty channel says nothing here yet. Older messages are still being restored. while
  restoring".
- `HistoryBanner.test.tsx`: "shows for a browser without keys while history is on"; "open privacy opens Settings →
  Privacy with focus on the history heading, and the banner does not come back"; "it is gone once keys exist"; "it
  never shows while history is off or unavailable".
- `prefs.test.ts`: "the history banner pref round-trips".

### U.8 e2e and screenshots

#### U.8.1 `e2e/web/history.spec.ts` (E1), chromium and firefox

From an empty instance, through the shipping client only.

1. "a second browser gets the history, without what was deleted": browser A signs up (keeping the recovery key text),
   creates a server, and in #general posts `one`, `two`, `three`, attaches a small PNG to `four`, edits `two` to `two
   edited`, deletes `three`, reacts 👍 on `one`, pins `one`, replies `re one` to `one`, and opens a DM with a second
   person B0 and exchanges `dm hello`. Wait until A's Settings → Privacy usage line says at least 9 messages saved.
   Browser B signs in to A's account with the recovery key; the done step says "Your earlier messages are being
   restored here"; open dilla; Settings → Privacy reaches "Message history restored". In #general: `one` with 👍 and
   the pin, `two edited` (shown edited), `re one` as a reply, `four` whose image opens full size; no `three`; the DM
   shows `dm hello`; Control/⌘+K finds `edited`; no unread badge on #general or the DM.
2. "turning history off deletes it, and a third browser starts empty": in A, turn off (confirm, step-up with the
   password), the status line says history is off; browser C signs in with the key; the done step says "Messages sent
   before now are not shown here."; #general says the empty-channel copy of `shell.log.empty`.
3. "a message deleted after a restore is gone for the next browser too": history on again in A; A posts `five`, waits
   for it to be saved, deletes it; browser D signs in with the key and, once restored, has no `five`.

`enrol.spec.ts`: its done-step expectation takes the new `signin.done.body`.

#### U.8.2 Phone

Case 1's Settings → Privacy check also runs at 390 px in chromium (the phone project), and the restoring line is
visible without scrolling the page sideways.

#### U.8.3 Screenshots (D2)

`e2e/scripts/shoot-docs.mjs`, a `HISTORY_SHOTS` block: Settings → Privacy with history on (`history-on`), restoring
(`history-restoring`), locked with the banner (`history-locked`), and the off confirmation (`history-off`), each at
1280 px and 390 px, dark theme; and the sign-in done step with the new copy. Images go to `docs/user/screenshots/`
named `history-on.png`, `history-restoring.png`, `history-locked.png`, `history-off.png`, `signin-done-history.png`
and their `-phone` twins.

---

## Appendix P: protocol text

Task S5 pastes these verbatim in the places named. Wording in quotes is final; where a sentence of today's text is
replaced, the old sentence is quoted first.

### P.1 `03-identity.md`

**§ Recovery, "Derived keys" paragraph:** after the `K_backup` line add:

> The recovery key also derives the history keys of `06-backup-archive.md` § History: `seed = HKDF-SHA256(salt = "",
> IKM = RK, info = "dilla history key v1", L = 32)`, from which RFC 9180 `DeriveKeyPair` (DHKEM(X25519, HKDF-SHA256))
> makes the history key pair `SK_hist`, `PK_hist`; and `K_hauth`, `K_hid`, `K_hdel` with `info` `"dilla history auth v1"`,
> `"dilla history id v1"` and `"dilla history delete v1"`. Every entry of the key derives them again, so entering the
> key again changes nothing. The recovery key is not rotated (`06` § Header).

**§ Recovery, the "Recovering on a new device with only RK" sentence:** replace "then restore history from the archive
under `K_backup` (`06-backup-archive.md`, "Restore")." with "then restore the saved history with `SK_hist`
(`06-backup-archive.md` § History, "Restore")."

**§ Custody by tier**, the table: replace the `K_backup` row's browser cell with "never, except during its own
browser-rooted signup (pending signup record only) and transiently at a one-shot recovery-key entry, zeroised
afterwards", and add two rows:

> | history write keys (`PK_hist`, `K_hauth`, `K_hid`, `K_hdel`) | after the recovery key is entered on it | from its own signup, and after the recovery key is entered on it (sign-in, removing a device, Settings → Privacy) |
> | `SK_hist` (history read key) | only while a restore it started runs | only while a restore it started runs: from the recovery-key entry until the restore finishes, history is turned off, the browser signs out, or 7 days pass |

**§ Pairing, step 4:** replace "and `k_backup` is null too unless the user opted in to "history in browser sessions"."
with "and `k_backup` is null too. The pairing payload carries no history key: a device enrolled by pairing gets the
history write keys the first time its user enters the recovery key on it."

### P.2 `06-backup-archive.md`

**Top paragraph:** "The instance stores two kinds of client-encrypted backup per user. It cannot read either." becomes
"The instance stores two kinds of client-encrypted backup per user: the header objects and the saved message history.
It cannot read either."

**§ Header, "At the instance" paragraph:** delete the sentence "Archive chunks and the manifest are not served at wires
1 and 2."

**Replace § Archive and § Restore (everything from `## Archive` to the line before `## Operator note: the instance
backup`) with:**

> ## History
>
> Each user's devices save the messages they can read as **entries**, which the instance stores and cannot open
> (`09-http-api.md` § History). It replaces the chunk archive and SSK-signed manifest of earlier drafts, which no
> instance served: a `browser` device holds no `SSK_priv` and could not sign a manifest.
>
> **Keys** (`03-identity.md`, "Recovery"): `SK_hist` and `PK_hist` (an X25519 key pair derived from `RK`), `K_hauth`,
> `K_hid` and `K_hdel`. The **write keys** `PK_hist`, `K_hauth`, `K_hid` and `K_hdel` let a device save, name and delete
> entries but not open them. The **read key** `SK_hist` opens them; a device holds it only while a restore it started
> runs.
>
> **What is saved.** One entry per delivery-service row of a `text` group that the device shows or folds: a decrypted
> envelope of type 0–6, or the device's own sent one, at the moment it is stored as shown. Folds are entries of their
> own. Not saved: rows that cannot be decrypted, rows held for a trust check (until they are released), rows dropped for
> their upload class (`04` § Semantics), `call`, `pairing` and `interaction` groups, and server-readable channels.
> Attachments are saved as the envelope carries them (blob id, key, nonce, thumbnail): the blob is not copied.
>
> **Entry id and delete token.** `entry_id = HMAC-SHA256(K_hid, "dilla history entry id v1" || group_id || seq)[0..16]`
> with `seq` as 8 bytes big-endian. `del_token = HMAC-SHA256(K_hdel, "dilla history delete token v1" ||
> entry_id)[0..16]` and `del_hash = SHA-256("dilla history delete hash v1" || del_token)[0..16]`. Every device of the
> user computes the same id for the same row, so the instance keeps one entry per row without learning which row.
>
> ```
> entry = CBOR [
>   v,               ; uint, = 1
>   group_id,        ; bstr 16
>   seq,             ; uint
>   epoch,           ; uint
>   recv_ts,         ; uint, the delivery service's receive time
>   sender_user,     ; bstr 16
>   sender_device,   ; bstr 16
>   sender_sig_key,  ; bstr 32 or null
>   sender_kind,     ; uint: 0 user, 1 bot
>   sender_tier,     ; uint: 0 native, 1 browser
>   franking_tag,    ; bstr 32
>   envelope         ; bstr: the 04 envelope CBOR
> ]
> padded = entry || zero bytes to the next multiple of 256
>
> (enc, exported) = HPKE base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM (0x0020, 0x0001, 0x0002):
>                   SetupBaseS(PK_hist, info = "dilla history v1" || user_id), Export("dilla history batch v1", 32)
> K_batch = HKDF-SHA256(salt = K_hauth, IKM = exported, info = "dilla history batch key v1", L = 32)
> row = CBOR [ v = 1, enc (bstr 32), nonce (bstr 12), ciphertext (bstr) ]
>       ; ciphertext = AES-256-GCM(K_batch, nonce, padded, aad = "dilla history entry v1" || user_id || entry_id)
>       ; nonce random per row; one (enc, K_batch) per upload of at most 512 rows; a row is at most 81 920 bytes
> ```
>
> Only a holder of `SK_hist` opens a row, and only a holder of `K_hauth` makes one that opens: the instance cannot
> forge an entry even if it learns `PK_hist`. A reader opens a row, decodes the entry, requires the padding to be zero
> bytes, and requires `entry_id` computed from the entry's `group_id` and `seq` to equal the row's id; a row that fails
> any of these is a gap, never shown.
>
> **Append, dedupe and delete.** An entry is never rewritten. The instance keeps the first row stored for an id and
> drops later ones. When a device drops a saved row's content (a delete for everyone, an edit blanked by its target's
> delete, a delivery-service deletion, a trust retraction), it deletes the entry with its `del_token`; the instance
> checks the token against the stored `del_hash`, deletes the row and keeps the id as deleted, so the entry is never
> stored again. A type-2 envelope is saved like any fold, so a restore applies a delete also to an entry that an older
> copy of the history brings back. Leaving a group, or a device deleting its local copy of a group, deletes nothing.
>
> **On and off.** The instance keeps per user whether history is on and a generation. Turning it off deletes every entry
> and every deleted id and starts a new generation; turning it on starts another. A device that sees a new generation
> drops what it had queued and, when history is on, saves again every row it holds.
>
> ## Restore
>
> 1. With `RK` at sign-in (`03-identity.md`, "Recovery"), or later in the device's settings: derive the history keys,
>    keep the write keys, and keep `SK_hist` for the restore.
> 2. Read the entries newest first, then those saved while the restore ran, and merge each into the local store as if
>    it had arrived: an entry is stored only when the device holds its group, its `seq` is below the group's next
>    expected sequence number (everything from there arrives live), and no row is stored at that `seq`; it is folded and
>    indexed like a received row and counts as read. An entry of a group the device does not hold yet waits until it
>    does, at most 30 days.
> 3. Erase `SK_hist` when the restore finishes, when history is turned off, at sign-out, or 7 days after the restore
>    began.
>
> Restoring MLS state is never done: it would clone a leaf (sender ratchet and nonce reuse) and hand current epoch
> secrets to anyone with the recovery key. A restored entry is plaintext, so its MLS signature cannot be checked again:
> it carries the verdict of the device that saved it. Trust pins and the validated device-list cache stay local to each
> device; a restoring device skips an entry whose sender key it already holds a failed verdict for, and a verdict it
> records later retracts restored rows as it retracts received ones (`03-identity.md`, "Device list").

### P.3 `08-threat-model.md`

**§ Guarantees, after "Verifiable reports" bullet, add:**

> - Saved message history (`06` § History): the instance stores each user's entries as rows sealed to a key pair
>   derived from the recovery key and authenticated by a key the instance never holds. It cannot open, forge or move
>   an entry. A device holds the key that opens them only while it restores.

**§ Guarantees, the sentence "Against adversary 4: forward secrecy and post-compromise security as above; recovery keys
are never on devices except during signup or recovery."** becomes:

> Against adversary 4: forward secrecy and post-compromise security as above, except for saved history (§ Residual
> trust); recovery keys are never on devices except during signup or recovery, and the history's read key only during
> a restore. A compromised device can add forged entries to its own user's saved history, which a later restore shows,
> and can delete entries of rows it knows; it cannot open the saved history.

**§ Residual trust, add after the instance-adds-devices bullet:**

> - **Saved history gives up forward secrecy for what is saved.** Anyone who holds the recovery key and the instance's
>   data can read every saved entry of that user: all past messages any of their devices could read, for as long as
>   the history keeps them. A copy of the instance's data taken before an entry was deleted (an operator's backup) still
>   holds that entry, and the recovery key still opens it. History is on by default; turning it off deletes the saved
>   entries from the instance, not from earlier backups of it.
> - The instance can withhold or drop saved entries, or serve an older copy of the history (bringing back entries
>   deleted since; a saved delete hides an author's deleted message again). It cannot read or forge an entry.
> - A restored message carries the trust verdict of the device that saved it: its MLS signature is not kept and cannot
>   be checked again.

**§ Residual trust, the metadata bullet:** append:

> With history on, the instance also keeps, per user, the number of saved entries (messages and folds), each one's
> padded size and upload order, which ones were deleted, and when each device uploads. It learns no group, sender,
> message id or time from them, but an entry saved right after a delivery can be linked to that message by timing, and
> the count and sizes outlive the delivery service's own retention.

**§ Residual trust, "History before a member joined is not shared with them at this version."** stays, and
**"A user who loses every device and the recovery key loses their history."** becomes "A user who loses every device
and the recovery key loses their history: the saved history opens only with the recovery key."

### P.4 `09-http-api.md`

**§ Backups, first paragraph:** replace "any other value of either, kind `2` (archive chunks) included, is `404
E_NOT_FOUND`: this wire version serves no archive." with "any other value of either is `404 E_NOT_FOUND`. Saved
message history has its own routes (§ History)."

**After § Backups, add `### History`:**

> ### History
>
> The saved message history of `06-backup-archive.md` § History, for the session's own user: no route names a user. All
> routes need an `enrolled` session (`403 E_FORBIDDEN` for a pending one).
>
> | Method and path | Request | Response |
> |---|---|---|
> | `GET /v1/history` | — | `[enabled(uint 0\|1), generation(uint), entries(uint), bytes(uint), quota(uint)]` |
> | `PUT /v1/history` | `[enabled(uint 0\|1), stepup(tstr\|null)]` | `[enabled, generation]` |
> | `POST /v1/history/entries` | `[generation(uint), entries([[entry_id(bstr 16), del_hash(bstr 16), row(bstr)]])]` | `[stored(uint), dropped(uint)]` |
> | `POST /v1/history/entries/delete` | `[generation(uint), items([[entry_id(bstr 16), del_token(bstr 16)]])]` | `[deleted(uint), refused(uint)]` |
> | `GET /v1/history/entries?generation=&before=&after=&limit=` | — | `[[n(uint), entry_id(bstr 16), row(bstr)]]` |
>
> - **State.** A user with no stored state has history on at generation 1. `enabled` reads 0 while the instance's
>   `history.quota_bytes_per_user` is 0. Turning history off needs a step-up token (§ Second factors; `403 E_STEP_UP`
>   without one) and deletes every entry and deleted id of the user; turning it on while the quota is 0 is `403
>   E_FORBIDDEN`. Each change starts a new generation; setting the current value changes nothing. Both are audited
>   (`history.off`, `history.on`).
> - **Generation.** The two `POST`s and the entries `GET` name the generation they act in; another generation, or
>   history off, is `409 E_HISTORY_STALE`, and the client reads `GET /v1/history` again.
> - **Entries.** 1 to 512 per request, ids distinct within it; a `row` is deterministic CBOR `[1, enc(bstr 32),
>   nonce(bstr 12), ciphertext(bstr ≥ 16)]` of at most 81 920 bytes; anything else is `400 E_INVALID_REQUEST`. An id
>   the user already holds, or one deleted before, is dropped (`dropped`), never replaced. Entries that would take the
>   user past `history.quota_bytes_per_user` are `507 E_STORAGE_FULL` and none is stored.
> - **Deletes.** 1 to 1024 per request. An item whose token hashes to the stored `del_hash` deletes the entry; one
>   that does not is `refused` and changes nothing; an id the user does not hold is recorded as deleted. A deleted id is
>   never stored again in that generation.
> - **Listing.** `generation` is required; at most one of `before` and `after`; `limit` 1 to 512 (default 512). Without
>   `after` the rows come newest first (below `before` when given); with `after`, oldest first above it. An answer
>   holds at most 1 MiB of rows, and at least one row when any matches. `n` is the instance's upload order; no time is
>   stored with an entry.
> - Every route spends the device session's `read` or `write` bucket. `POST /v1/history/entries` also spends a
>   per-device budget of `history.upload_bytes_per_day` (default 268 435 456 bytes a day, refilling continuously), `429
>   E_RATE_LIMITED` with `retry_after_ms` past it, before the body is read.

**§ Rate limits, "Body caps":** add "`POST /v1/history/entries` 1,052,672 bytes (1 MiB + 4 KiB);" before "64 KiB on
every other CBOR route".

**§ Instance (settings), if it lists dilla.toml sections:** nothing; the `[history]` settings are documented in
`docs/deploy/README.md` (D1).

### P.5 `02-delivery-service.md`

**§ Errors, the status table:** after the `E_CALL_NOT_ALONE` row add:

> | 409 | `E_HISTORY_STALE` | the request's history generation is not the user's, or history is off (`09` § History) | read `GET /v1/history` again and act on it |

**After the paragraphs that list the codes that "came later":** add "`E_HISTORY_STALE` came with saved message history
(`09` § History)."

### P.6 `07-versioning.md`

Add the row:

> | 2026-10-xx | e2ee 1, media 1, wire 2 | **Additive.** Saved message history: `06` § History and § Restore replace the unserved chunk archive and manifest; `03` derives `SK_hist`/`PK_hist`, `K_hauth`, `K_hid` and `K_hdel` from the recovery key and gives browsers the history write keys; `09` § History adds `GET`/`PUT /v1/history`, `POST /v1/history/entries`, `POST /v1/history/entries/delete` and `GET /v1/history/entries`; `02` adds `409 E_HISTORY_STALE`; `vectors/history.json` (frozen from the Rust core). Schema 00026 adds `history_state`, `history_entries` and `history_tombstones`; `migrate down` drops them and every saved history. No version bump |

### P.7 `protocol/vectors/README.md`

Add the row:

> | `history.json` | `06-backup-archive.md` | `seed`, `sk`, `pk`, `k_auth`, `k_id` and `k_del` from `rk`; `entry_id`, `del_token` and `del_hash`; `entry.padded` from `entry.fields`; and the opening of `row` to `entry.padded` |

and after the `permissions.json` sentence: "`history.json` is not generated either: it is frozen from the Rust core
(`core/dilla-core/src/history.rs`), because the generator has no X25519 HPKE, and is checked by
`core/dilla-core/tests/history_vectors.rs`."
