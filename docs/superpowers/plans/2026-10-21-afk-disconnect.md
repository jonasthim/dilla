# AFK means disconnected: plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** being in the AFK channel means having no voice connection at all. There is no LiveKit connection, no MLS call-group leaf, no audio in or out, and no dock. The channel list still shows the person under AFK, as away.

**Context:** Jonas, on the deployed web3.9 (2026-10-21): "if person is in AFK channel, then voice is not connected". Asked to choose, he picked **Truly disconnected**. His answers to the follow-up questions are binding:
- **Q1 Activity clears AFK: yes.** Sending a message or typing in a community takes you out of that community's AFK list.
- **Q2 Offline clears AFK: immediately.** When the user's last gateway connection closes, they leave every AFK list.
- **Q3 No "leave AFK" action.** You leave AFK by joining voice, by being active (Q1), or by going offline (Q2).
- **Release:** a separate release, right after the member-profile release. It has its own reviews and deploy.

Ruling (Claude, open to Jonas): joining a call in any community clears away everywhere (R-AW2). Design source: an opus design pass, 2026-10-21. File:line references are against `feature/member-profile` at f6cf07a1.

## Today (web3.9), end to end
1. **Admission:** `internal/api/calls.go:1196-1201` clears `afkPending` and calls `trackAFKAdmission` (`internal/api/afk.go:427-459`). `afkActivity` (`afk.go:592-642`) refreshes `lastActive`.
2. **Sweep:** `SweepAFK` (`afk.go:717-754`) calls `moveAFK` (`afk.go:648-713`). `moveAFK` cuts the device: `sfu.RemoveParticipants` and `revokeRelay`. It then sets `afkPending[dev]` (10 min TTL) and sends op 54 to the user's own connections (`afk.go:711`).
3. **Leaf removal:** LiveKit's `participant_left` reaches `CallEvents.left` (`callevents.go:271`, `:515`), which proposes the leaf Remove (`ds/proposal.go:377`). In the page, `endCodeOf` gives `E_REMOVED` (`packages/web/src/call/session.ts:263-265`). The worker then runs `leave`, `leaveLive` and `leaveGroup` (`client-core/src/calls/controller.ts:528`, `:551`, `:592`).
4. **Reload of AFK state:** op 54 triggers `scheduleCommunityReload` (`worker/controller.ts:1531`), then `loadAFK` (`:2725`) and `getAFK` (`http/routes.ts:359`). The slice becomes `{pending, seq}` (`state/types.ts:204`).
5. **Listen-only join:** `Shell.tsx:207-221` builds `afkPending` and hands it to `useCall.tsx:885-910`, which joins AFK listen-only (`:488`, `:531-543`). The server grants listen-only (`calls.go:1042`, `:1053`).
6. **Roster:** the AFK roster today is that call's voice book (op 50 plus the `GET …/call` snapshot), rendered at `Shell.tsx:976-990`.

## Binding rulings (R-AW*)
- **R-AW1 The AFK channel never hosts a call.**
  - `POST /v1/channels/{afk}/calls` (`calls.go:340`) is refused with `403 E_FORBIDDEN` "nobody joins a call in the AFK channel". So is minting a token for it.
  - The listen-only grant stays as a backstop.
- **R-AW2 Away and calls never overlap.** If a user is away in any community, no device of that user is in any call.
  - Away is stored per (community, user).
  - An admission anywhere clears every away row of that user.
- **R-AW3 How you become away:**
  - **By the sweep:** the sweep's cut marks the user away only if no other device of theirs is in a call. Otherwise the idle device is just cut.
  - **By choosing AFK:** clicking the AFK row first leaves the current call through the normal leave path. It then sends `PUT /v1/communities/{id}/afk/away`, and the server cuts any device of that user still in a room.
- **R-AW4 What clears away:**
  - any admission of any of the user's devices (all communities);
  - a message upload or a typing op by the user in that community (Q1);
  - the user's last gateway connection closing (Q2, immediately; all communities);
  - leaving the community, a kick or a ban (by cascade).
  - There is no client route to clear away (Q3). Only the server clears it.
- **R-AW5 Away is stored in the database.**
  - This is for a server restart while the user stays connected: nothing else would rebuild the roster.
  - At boot, rows of users with no gateway connection are cleared after a 60 s grace period, so reconnecting clients keep theirs.
- **R-AW6 `pending` stays device-scoped.**
  - The new client uses it only to say "Moved to AFK" instead of "removed".
  - It never joins anything on it.
- **R-AW7 `since_ts` settles races.**
  - A join that starts after `since_ts` wins.
  - Recovery and restore never rejoin a channel in a community where this device's user is away with a `since_ts` later than the call's start.

## Tasks

### Task AW1 (opus): `afk_away` storage
- **Files:**
  - `internal/store/{sqlite,postgres}/migrations/00021_afk_away.sql`, plus `schema/019_afk_away.sql`;
  - `queries/afk.sql` in both dialects, then regenerate with sqlc;
  - `store.go:402`: `SetAFKAway`, `ClearAFKAway(cid, uid)`, `ClearAFKAwayUser(uid) []cid`, `ListAFKAway(cid)`;
  - `contract_test.go:242`, and add the table to `dump.go:70`.
- **Table:** `community_afk_away(community_id, user_id, since INTEGER NOT NULL, PRIMARY KEY(community_id, user_id), FOREIGN KEY(community_id, user_id) REFERENCES members ON DELETE CASCADE) STRICT`.
- **Tests:**
  - setting away is idempotent and keeps the first `since`;
  - leaving the community cascades;
  - `ClearAFKAwayUser` clears every community;
  - dump round-trip;
  - `wantSchemaVersion` is 21.
- **Gates:** `go test ./internal/store/...` on both dialects; a clean sqlc diff.

### Task AW2 (opus): server semantics
- **Files:** `internal/api/afk.go`, `calls.go`, `callevents.go`, the message upload and typing handlers, `internal/dillad/routes.go:118-124`, `internal/gateway`.
- **The sweep marks away:** in `moveAFK`, after the cut (`afk.go:703`), check under `afkMu` that no other device of the user is admitted anywhere. Then call `SetAFKAway` and fan out op 55. Keep `afkPending`.
- **New route:** `PUT …/afk/away` (body `[]`, answers `204`), member-only. It cuts every device of the user in every room, then marks them away. There is no `DELETE` (Q3).
- **Clearing (R-AW4):**
  - **Admission** (`calls.go:1199`): `ClearAFKAwayUser`, plus op 55 `since 0` for each community cleared.
  - **Message upload and typing:** `ClearAFKAway(cid, uid)` in the community of the channel, plus op 55.
  - **Last connection closed:** a gateway hook for a user's last connection clears all their rows, plus op 55.
- **Boot:**
  - After `EnsureAFKChannels`, end every live call in an AFK channel and mark its users away (`since = now`).
  - After 60 s, clear the rows of users with no connection.
- **Snapshot:** `GET /afk` (`afk.go:64-70`) gains a 5th element `away [[user_id, since_ts]]`, at most 1024 entries.
- **Refusal:** R-AW1, both on starting a call and on the token path.
- **Tests:**
  - the sweep marks away;
  - not when another device of the user is in a call;
  - an admission clears away;
  - a mark racing a fresh admission: the admission wins;
  - a message clears away; typing clears away;
  - the last connection closing clears away, a second tab still open keeps it;
  - starting a call in AFK gets 403;
  - `PUT` cuts a second device;
  - restart keeps rows for connected users;
  - a live AFK call at upgrade ends and its users become away.
- **Gates:** `go test -race ./internal/api/... ./internal/dillad/... ./internal/gateway/...`.

### Task AW3 (opus): wire and protocol
- **Op 55 `afk_away`:** `[community_id, user_id, since_ts (uint; 0 = cleared)]`.
  - Server-to-client only, `n = 0`, never stored or replayed.
  - Sent to the `EligibleUsers` of the AFK channel (the `voicestate.go:124` pattern).
  - A client that sends op 55 gets `E_FRAME_TYPE`.
- **Gateway:** `frame.go:55-62`, `:100-142`; `codec.go` `AFKAwayPayload`.
- **Docs:**
  - `protocol/02-delivery-service.md`, the frames section (`:395-411`);
  - `protocol/09-http-api.md:852-890`: the snapshot's 5th element, `PUT …/afk/away`, R-AW1 and R-AW4;
  - a `protocol/07-versioning.md` row: "Additive (migration 00021)". The wire stays 2: an unknown server-to-client op in the ephemeral range is ignored (the op 54 precedent, `:188`).
  - `protocol/vectors` `frames.json`: an `afk_away` case and a 4-element reject.
- **Gates:** the Go and TS vector tests; `check:docs`.

### Task AW4 (opus): client-core
- **Gateway frames:** `gateway/frames.ts:53-68` decodes op 55 and adds it to `DROPPABLE_OPS`.
- **HTTP:** `http/routes.ts:359` reads `away` when `a.length > 4`, and adds `putAFKAway`.
- **State:** `state/types.ts:204` adds `AFKState.away: { userId: string; since: number }[]`.
- **Worker:**
  - `worker/controller.ts` gets an op 55 branch next to `:1531`. It patches `afk:<cid>` in place and keeps `seq` steady.
  - Op 55 is kept only after `loadAFK` has landed. Going offline clears it, as today (`:1519`).
  - A new command, `afkAway`.
- **Tests:**
  - op 55 shape and reject;
  - a 4-element web3.9 snapshot gives `away: []`;
  - an op 55 that arrives before the snapshot is dropped and the re-read wins;
  - a stale `since` is ignored.
- **Gates:** client-core vitest and typecheck.

### Task AW5 (opus): web call lifecycle (`packages/web/src/screens/voice/useCall.tsx`)
- **Remove the AFK join:**
  - the pending effect (`:885-910`);
  - the AFK `move` and listen-only paths (`:488`, `:531-543`, `listenIds`);
  - `resolveAfk` and the `AFK_STATUS_WAIT_MS` wait (`:294-335`);
  - `afkFailed`.
- **Clicking the AFK row:** if in a call, `await leave()` (this releases the mic and hides the dock), then `afkAway`. A click while already away does nothing.
- **Restore and recovery skip AFK** (R-AW7).
- **The sweep's cut:** on `E_REMOVED` with `pending` set, or with `pending` arriving within `REMOVED_HOLD_MS`:
  - say `afk.moved`;
  - do not start recovery;
  - reuse `afkCut` and `sayRemoved` (`:336-364`).
- **Tests** (`useCall.test.tsx`):
  - after the sweep's cut: no rejoin, no recovery, `afk.moved` is said, the dock is gone;
  - clicking AFK in a call: the leave is posted before `afkAway`, and the mic track has ended;
  - recovery after sleep while away: no rejoin;
  - reload while away: no call;
  - joining another channel while away: a normal join.
- **Gates:** web vitest; the e2e voice AFK case on chromium.

### Task AW6 (sonnet): rendering
- **The AFK row's people:**
  - At `Shell.tsx:976-990` they come from `afk:<cid>.away` merged with `members`, shown as away. They never come from `voiceSlice`.
  - The count includes them.
  - The AFK row stays last (MP6).
- **Remove:**
  - `listenReason` in `VoiceView.tsx:84`, `:271`, `:532`;
  - the strings `afk.stage.muted` and `afk.moved.join`.
- **New string:** `afk.away` 'away', with flow 14 and its test.
- **Tests:**
  - the row lists an away person who is in no call;
  - it updates on op 55;
  - it updates when that person sends a message (their row leaves the list).
- **Gates:** web and ui vitest; check:copy; the storybook test for the row; e2e `layout.spec`.

### Task AW7 (haiku): docs
- Rewrite `docs/afk-architecture.md` and its diagram.
- Update `docs/user/voice.md`, the README, and `docs/design/flows/14-layout-grammar-and-afk.md`.
- Gate: `check:docs`.

**Order:** AW1 → AW2 ∥ AW3 → AW4 → AW5 ∥ AW6 → AW7.

## Edge cases
- **Swept while rejoining:** the later of the two wins (R-AW7). The mark checks under `afkMu` that no admission is newer than `tracked.lastActive`.
- **Two devices:**
  - Calls follow R-AW2 and R-AW3.
  - A second tab shows the roster from its own slice.
  - Offline means the **last** connection closed, so one open tab keeps you away.
- **Swept while asleep:** the cut, then the mark, then (if every connection drops) clearing as offline. On waking, the page sees `E_REMOVED`, and recovery is blocked.
- **Server restart:** rows survive. Rows of users who don't reconnect within 60 s are cleared.

## Release (its own: v0.1.0-web3.11 if member-profile is web3.10)
- **Server schema 20 → 21** (migration 00021 `community_afk_away`).
  - A rollback is safe: the Down step drops the table, and web3.9 and web3.10 ignore it.
- **Unchanged:** client store 5, wire 2, ABI and core.
- **Old tabs:**
  - they ignore op 55 and the 5th snapshot element;
  - clicking AFK gets a 403 join failure until they reload.
- **Operator notes:**
  - at first start, live AFK calls end and their people are listed as away;
  - the AFK channel no longer opens a LiveKit room (less SFU load);
  - one new table and one new route.
