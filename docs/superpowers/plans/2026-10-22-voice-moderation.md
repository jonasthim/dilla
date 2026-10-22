# Voice Moderation and App-Wide Right-Click Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discord-style voice moderation (server mute, server deafen, move by drag or menu, disconnect) and dilla's own right-click menu across the whole app, as specified in the approved design.

**Architecture:** The instance stores server mute and deafen per member, enforces them in the SFU grants and subscriptions, and signals moves with op 57 to capable devices, cutting the ones that don't follow. client-core decodes the wire, offers moves on `call.move`, folds moderation into the voice slice and gives the page advisory access (`voiceModAccess`). ui grows ActionMenu into submenus, checks and a slider, plus a popup and a phone sheet; web adds one menu host, pure menu models, the drag and the call behaviour.

**Tech Stack:** Go (net/http, sqlc on sqlite and Postgres, goose, LiveKit server SDK), TypeScript (React, vitest, Playwright), livekit-client, CBOR.

**Spec:** `docs/superpowers/specs/2026-10-22-voice-moderation-design.md` (approved at 182af0c3). Every `§` reference below is to this spec; read the referenced section before writing the task's code. The spec is the source for bulk detail (SQL, copy tables, truth tables); the plan never repeats it.

## Global Constraints

- Migration `00024_voice_moderation.sql` with schema file `022_voice_moderation.sql` for now; if calls-survive-upgrade (also 00024) merges first, renumber on rebase to the next free ones (00025 and 023); the schema tests expect the next number (D12).
- Permission bit 24 `deafen_members` = 16777216, channel-overridable, not in `communityBits`/`COMMUNITY_BITS`; Go `PermAll = 0x1FFFFFF` (33554431); TS `PERM_ALL = 0x1ffffff`. Bits are never renumbered (D1).
- Op 56 `voice_moderation` `[community_id(bstr 16), user_id(bstr 16), mod(uint 0..3)]`, mod bit 0 server_mute, bit 1 server_deaf; op 57 `voice_move` `[community_id(bstr 16), call_id(bstr 16), channel_id(bstr 16)]`; both S→C, ephemeral (`n = 0`), ungrouped (§8.1).
- Identify caps bit 1 `voice_move`: Go `CapVoiceMove uint64 = 1 << 1`; TS `CAP_VOICE_MOVE = 2`, sent as `CAPS`. Bit 0 belongs to calls-survive-upgrade (D11).
- Op 50 flags stay 0..31 on the wire; the client folds `mod` into `VOICE_FLAG.serverMute = 32` and `VOICE_FLAG.serverDeaf = 64` internally (M2).
- New error code only `409 E_NOT_IN_VOICE` (Go `server.CodeNotInVoice`) (D10).
- Pending reasons 3 (moved, didn't leave in time) and 4 (disconnected by a moderator) go only to devices whose every online connection set caps bit 1.
- Copy rules (D13): menu labels lower case; notices and refusals sentence case with a full stop, except the three stage notices `voice.mod.moved`, `voice.mod.moveMissed`, `voice.mod.disconnected` (no full stop); no `#` before voice channel names; no "encrypted", "encryption", "E2EE", "end-to-end" or "MLS" in UI strings; typographic apostrophes; new string prefixes `person.menu.`, `voice.mod.`, `menu.`; permission copy keeps `perm.` and is pinned by flow 09.
- No copy claims a deafened person can't hear; the bound is about 30 s × ceil(live rooms / 64) (§4, D5).
- The AFK channel is never a move target (J7); the owner is never moderated by others, and the owner's own row offers only their own switch and leave (J5).
- Gates, per task where they apply:
  - `npm run lint`, `npm run typecheck -w <package>`, `npm run check:copy`, `npm run check:docs`, `npm run check:css`;
  - Go: `go test -race ./internal/...` on sqlite, and `DILLA_TEST_PG="$DILLA_TEST_PG" go test -race ./internal/store/...` on Postgres;
  - vitest: `npm test -w @dilla/<package> -- <files>`;
  - e2e: `flock /home/thim/.cache/dilla-w3/e2e.lock env DILLA_TESTKIT=/home/thim/.cache/dilla-w3/i37e2e-target/release/dilla-testkit npx playwright test -c e2e/<config> <spec>`.
- Commits: `git commit -s`, ending with the trailers `Co-Authored-By: Claude <Model> 5.5 <noreply@anthropic.com>` (the implementer's own model: Opus, Sonnet or Haiku) and `Claude-Session: https://claude.ai/code/session_01XLFud8eoDaqf8uiZq5wjuP`. Never write "close #37" or "fix #37" in any message.
- Every authz test is negative-first: break the check, see the test go red, restore it.
- e2e specs start from an empty instance and build their servers, roles and channels through the shipping client.

## Review Focus

1. **The owner's row in every surface.** An administrator who opens the owner's menu from the voice row, member list, message author, mention, call tile or DM row sees no server mute, deafen, move to, disconnect or roles. Test added to W4b.
2. **The mover's rights change mid-drag.** If a role change removes Move Members while björn is being dragged, the drop sends nothing and says why; it doesn't trust the highlight computed at drag start. Test added to W7.
3. **The phone sheet at 360 px.** At 360×640 the sheet and its move to page fit without horizontal scroll, and every target is still 44 px. Test added to E1.
4. **Shift+F10 and the ContextMenu key on Firefox.** Exactly one dilla menu opens and the browser's never shows behind it (Firefox follows the key with its own `contextmenu`). Test added to E1.
5. **A server mute that lands mid-join.** A PATCH between the token mint and `participant_joined` still leaves the joiner without a microphone (the `/rtc` gate and the join reconcile read the fresh state). Test added to S6a.

---

## Lanes and integration

Four lanes run in parallel copies. Each is a shared clone of the feature branch:

```bash
for l in server core ui web; do
  git clone --shared -b feature/voice-moderation /home/thim/.cache/dilla-w3/voicemod /home/thim/.cache/dilla-w3/voicemod-lane-$l
  git -C /home/thim/.cache/dilla-w3/voicemod-lane-$l switch -c lane/$l
done
```

| Lane | Clone | Tasks (in order) |
|---|---|---|
| server | `voicemod-lane-server` | S1 ∥ S2 ∥ S3 ∥ S4 → S5 → S6a → S6b; S7 alongside S5–S6 |
| core | `voicemod-lane-core` | T1 → T2 → T3 → T4 → T5 → T6 → T7; M1 ∥ from the start |
| ui | `voicemod-lane-ui` | U1 ∥ U3 → U2, U4 → U5 |
| web | `voicemod-lane-web` | W1 ∥ from the start; W3, W2 → W4a → W4b → W5 → W7 → W6 → E1 ∥ E2 → D1 ∥ D2 |

- Writers stay sequential within a lane. A task marked ∥ inside a lane gets a clone of its own (`voicemod-<task>`, e.g. `voicemod-s2`, branch `lane/<task>`), integrated like a lane.
- **Integration after each wave.** The controller, in `/home/thim/.cache/dilla-w3/voicemod` on `feature/voice-moderation`, fetches each lane branch and merges it: `git fetch ../voicemod-lane-server lane/server && git merge --no-ff FETCH_HEAD`, the same for every lane and ∥ clone that finished in that wave, then runs the full gates. Each lane then merges `feature/voice-moderation` back (`git fetch origin feature/voice-moderation && git merge FETCH_HEAD`) before its next wave, so cross-lane dependencies are present.
- **Waves** (spec §11.1): 1: S1, S2, S3, S4, T1, M1, U1, U3, W1. 2: S5, S7, T2, U2, U4. 3: S6a, T3, T4, U5, W3. 4: S6b, T5, W2. 5: T6, T7, W4a, W4b. 6: W5, W7. 7: W6. 8: E1, E2. 9: D1, D2.

---

## Wave 1

### Task S1: Permission bit 24 in Go, vectors, the protocol table; `E_NOT_IN_VOICE` — lane server ∥, sonnet, review sonnet

**Files:**
- Modify: `internal/api/perm.go`, `internal/api/perm_test.go`, `internal/api/perm_vectors_test.go`, `protocol/vectors/permissions.json`, `protocol/09-http-api.md` (§ Permissions table row), `internal/server/errors.go`, `internal/server/errors_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `api.PermDeafenMembers Bits = 1 << 24`; `api.PermAll` = `0x1FFFFFF`; `server.CodeNotInVoice Code = "E_NOT_IN_VOICE"` (409); vector key `deafen_members` = 16777216 and case `deafen_via_overwrite`.

- [ ] **Step 1: Write the failing tests**

```go
func TestNotInVoiceIs409(t *testing.T) {
	if got := (&server.Error{Code: server.CodeNotInVoice}).Status(); got != 409 { t.Fatalf("status %d, want 409", got) }
}
func TestDeafenMembersIsChannelScoped(t *testing.T) {
	// role overwrite allowing bit 24 on ch1 → ResolveChannel(ch1) has it, ch2 does not;
	// role overwrite denying it on ch1 → ch1 lacks it;
	// role allows bit 24, user overwrite on ch1 denies it → ch1 lacks it.
}
```
Update `TestPermissionVectors`: `len(v.Cases) != 21` with "want 21"; `consts["deafen_members"] = api.PermDeafenMembers`. Add the `deafen_via_overwrite` case and the bit to `permissions.json` exactly as §S.2 Vectors (community 4083, channel 16781299; owner and administrator 33554431).

- [ ] **Step 2: Run them to verify they fail**

Run: `go test -race ./internal/server/ ./internal/api/ -run 'TestNotInVoiceIs409|TestDeafenMembersIsChannelScoped|TestPermissionVectors'`
Expected: FAIL (`undefined: server.CodeNotInVoice`, `undefined: api.PermDeafenMembers`).

- [ ] **Step 3: Implement**

`PermDeafenMembers Bits = 1 << 24` after `PermManageNicknames`, ORed into `PermAll`, not into `communityBits` (§S.2 Go). `CodeNotInVoice` with the comment of §S.1.0, added to the 409 case of `(*Error).Status()` (`errors.go:128`). Protocol/09 permissions row: `| 24 | \`deafen_members\` | channel |`.

- [ ] **Step 4: Run them to verify they pass**

Run: the Step 2 command. Expected: PASS. Break the overwrite scoping once (add bit 24 to `communityBits`), see `TestDeafenMembersIsChannelScoped` fail, restore.

- [ ] **Step 5: Gates**

Run: `go test -race ./internal/api/ ./internal/server/ && npm run check:docs`. Expected: ok.

- [ ] **Step 6: Commit**

```bash
git add internal/api/perm*.go protocol/vectors/permissions.json protocol/09-http-api.md internal/server/errors*.go
git commit -s -m "feat(api): permission bit 24 deafen_members and E_NOT_IN_VOICE"
```

### Task S2: Migration, store and sqlc — lane server ∥, sonnet, review sonnet

**Files:**
- Create: `internal/store/{sqlite,postgres}/migrations/00024_voice_moderation.sql`, `internal/store/{sqlite,postgres}/schema/022_voice_moderation.sql`, `internal/store/{sqlite,postgres}/queries/voicemod.sql`, `internal/store/voicemod_test.go`
- Modify: `internal/store/rows.go`, `store.go`, `sqlite/repo.go`, `postgres/repo.go`, `dump.go`, `schema_test.go`, `contract_test.go`; regenerate `sqlitedb/`, `pgdb/`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type VoiceModeration struct { UserID id.ID; Mute bool; Deaf bool; Updated int64 }`
  - `GetVoiceModeration(ctx, communityID, userID id.ID) (VoiceModeration, error)`: no row → zero value with `UserID` set, never `ErrNotFound`.
  - `SetVoiceModeration(ctx, communityID id.ID, m VoiceModeration) error`: upsert while a flag is set, delete when both clear; non-member → `ErrNotFound`.
  - `ListVoiceModeration(ctx, communityID id.ID) ([]VoiceModeration, error)`: ordered by user id.

- [ ] **Step 1: Write the failing tests** (`internal/store/voicemod_test.go`, over `engines(t)`)

```go
func TestVoiceModerationSetGetListAndClear(t *testing.T) {
	// Get on a member with no row → VoiceModeration{UserID: u}, nil
	// Set{Mute:true} → Get {Mute:true, Deaf:false}; Set{Mute,Deaf} → List == [{u,true,true,...}]
	// second member → List ordered by user id; Set both false → Get zero, List without u
}
func TestVoiceModerationOfANonMemberIsNotFound(t *testing.T)   // errors.Is(err, store.ErrNotFound)
func TestVoiceModerationGoesWithTheMembership(t *testing.T)    // DeleteMember → List empty, Get zero
func TestVoiceModerationMigrationIsSchemaVersion24(t *testing.T) // 00024 in both FS; wantSchemaVersion >= 24
func TestADumpRoundTripsVoiceModeration(t *testing.T)           // Postgres only; skip without DILLA_TEST_PG
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test -race ./internal/store/ -run VoiceModeration`
Expected: FAIL to compile (`undefined: store.VoiceModeration`).

- [ ] **Step 3: Implement**

SQL, both engines: spec §S.3, verbatim (table, CHECKs, cascade, `BIGINT` on Postgres; the migration file carries the schema body byte for byte; `-- name:` headers byte-identical). Run `sqlc generate`. Repo methods as §S.3 "Repo implementations", reusing the existing `boolInt`; foreign-key failure mapped to `ErrNotFound` exactly like `SetAFKAway`. `DumpTables`, `wantTables` and both contract lists as §S.3 "Tables lists".

- [ ] **Step 4: Run them to verify they pass**

Run: `go test -race ./internal/store/ && DILLA_TEST_PG="$DILLA_TEST_PG" go test -race ./internal/store/`
Expected: PASS, including `TestDumpTablesNamesEverySchemaTable`, `TestEverySQLiteTableIsStrictAndTyped`, `TestGooseUpDownUpOnSQLite`/`Postgres`, `TestMigrationCarriesEverySchemaFileVerbatim`, `TestQuerierInterfacesAreIdentical`, `TestQueryHeadersAreByteIdenticalAcrossEngines`, `TestSubInterfacesMatchTheContract`, `TestMigrationsAreNumberedWithoutGaps`, `TestSchemaFilesAreNumberedWithoutGaps`.

- [ ] **Step 5: Gates**

Run: `sqlc diff` (both engines). Expected: no diff.

- [ ] **Step 6: Commit**

```bash
git add internal/store
git commit -s -m "feat(store): member_voice_moderation, migration 00024"
```

### Task S3: Gateway caps port, ops 56 and 57 — lane server ∥, sonnet, review sonnet

**Files:**
- Modify: `internal/gateway/frame.go`, `codec.go`, `session.go`, `gateway.go` and their tests

**Interfaces:**
- Consumes: the calls-survive-upgrade code at `/home/thim/.cache/dilla-w3/upcalls/internal/gateway`, ported verbatim (`Frame.Caps`, `conn.caps`, `(*conn).admits`, lenient identify element 4, `registerCaps`).
- Produces:
  - `OpVoiceModeration Op = 56`, `OpVoiceMove Op = 57` (opSpecs `{elements: 3}`, opNames `voice_moderation`, `voice_move`);
  - `func VoiceModerationPayload(communityID, userID id.ID, mod uint64) (cbor.RawMessage, error)`;
  - `func VoiceMovePayload(communityID, callID, channelID id.ID) (cbor.RawMessage, error)`;
  - `const CapVoiceMove uint64 = 1 << 1`;
  - `func (g *Gateway) DeviceCaps(deviceID id.ID) (uint64, bool)`: the AND over online connections.

- [ ] **Step 1: Write the failing tests**

```go
func TestIdentifyCapsAreKeptForTheConnection(t *testing.T)  // caps 2 → DeviceCaps(dev) == (2, true); caps "x" → (0, true), not refused
func TestDeviceCapsIsTheANDOverOnlineConnections(t *testing.T) // caps 2 and 0 → (0,true); close caps-0 → (2,true); none → (0,false)
func TestFrameCapsFiltersTheFanOut(t *testing.T)            // DeliverDevice(Frame{Caps: CapVoiceMove}) reaches only the caps-2 conn; the other's n and ring untouched
func TestOp56And57AreServerToClient(t *testing.T)           // client op 56/57 → E_FRAME_TYPE; encoded n == 0; opNames
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test -race ./internal/gateway/ -run 'Caps|Op56And57'`. Expected: FAIL to compile.

- [ ] **Step 3: Implement** the port, then the new constants, payload functions and `DeviceCaps` as §S.5.1–§S.5.3 (code given there; `DeliverGroup`, `DeliverDevice` and `DeliverUser` call `c.admits(f)`).

- [ ] **Step 4: Run them to verify they pass**

Run: `go test -race ./internal/gateway/`. Expected: PASS (all existing gateway tests too).

- [ ] **Step 5: Commit**

```bash
git add internal/gateway
git commit -s -m "feat(gateway): identify caps, ops 56 voice_moderation and 57 voice_move"
```

### Task S4: SFU `WithoutAudio` and `UpdateSubscriptions` — lane server ∥, sonnet, review sonnet

**Files:**
- Modify: `internal/sfu/grants.go`, `internal/sfu/remote.go`, `internal/sfu/grants_test.go`, `internal/api/calls.go` (`CallTokens` interface only), `internal/api/apitest_test.go` (`stubSFU`), `internal/dillad/callcut_test.go`, `plan2_test.go`, `routes_test.go`
- Create: `internal/sfu/subscriptions_test.go`

**Interfaces:**
- Produces:
  - `func WithoutAudio(perm *livekit.ParticipantPermission) *livekit.ParticipantPermission` (drops MICROPHONE and SCREEN_SHARE_AUDIO; `CanPublish = len(kept) > 0`; input untouched);
  - `func (s *Server) UpdateSubscriptions(ctx context.Context, room, identity string, trackSIDs []string, subscribe bool) error` (empty sids → nil, no call; absent identity → `ErrNoParticipant`);
  - `CallTokens.UpdateSubscriptions(...)` with the same signature; `stubSFU` records `subUpdate{Room, Identity string; SIDs []string; Subscribe bool}` in `subs`, honours `subFail` and `absent[identity]`, reader `subUpdates() []subUpdate`.

- [ ] **Step 1: Write the failing tests**

```go
func TestWithoutAudioDropsMicAndScreenAudio(t *testing.T) {
	// PublishGrant(true,true,true) → sources [CAMERA, SCREEN_SHARE], CanPublish true
	// PublishGrant(true,false,false) and (false,false,false) → nil sources, CanPublish false
	// CanSubscribe stays true; the input is not modified
}
func TestUpdateSubscriptionsUnsubscribesAndResubscribes(t *testing.T) // spikeServer: bob's OnTrackUnsubscribed, then OnTrackSubscribed
func TestUpdateSubscriptionsOfAnAbsentIdentityIsErrNoParticipant(t *testing.T)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test -race ./internal/sfu/ -run 'WithoutAudio|UpdateSubscriptions'`. Expected: FAIL to compile.

- [ ] **Step 3: Implement** both functions as §S.4.2 and §S.4.3 (code given), `Remote.UpdateSubscriptions`, the interface method, and `return nil` in the three dillad fakes.

- [ ] **Step 4: Run them to verify they pass**

Run: `go test -race ./internal/sfu/ ./internal/api/ ./internal/dillad/`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/sfu internal/api/calls.go internal/api/apitest_test.go internal/dillad/*_test.go
git commit -s -m "feat(sfu): WithoutAudio and UpdateSubscriptions"
```

### Task T1: client-core wire — lane core, sonnet, review sonnet

**Files:**
- Modify: `packages/client-core/src/gateway/frames.ts`, `gateway/gateway.ts`, `http/routes.ts`, `state/types.ts`, `index.ts`, `worker/controller.ts` (the frame-dispatch condition at :1644), `calls/controller.ts` (`setIn`, `Live`, minimal), `sync/testing/model.ts` (`startCall`, minimal)
- Test: `gateway/frames.test.ts`, `gateway/gateway.test.ts`, `http/routes.test.ts`, and the idle literals in `src/bridge.test.ts:111`, `calls/controller.test.ts:1810`, `packages/web/src/App.test.tsx:275,283`

**Interfaces:**
- Produces:
  - `Op.voiceModeration = 56`, `Op.voiceMove = 57`; `interface VoiceModerationFrame { communityId: Uint8Array; userId: Uint8Array; mod: number }`; `voiceModerationOf(frame: Frame): VoiceModerationFrame`; `interface VoiceMoveFrame { communityId: Uint8Array; callId: Uint8Array; channelId: Uint8Array }`; `voiceMoveOf(frame: Frame): VoiceMoveFrame`;
  - `CAP_VOICE_MOVE = 2`, `CAPS = CAP_VOICE_MOVE`;
  - `Routes.setServerVoice(communityId: Uint8Array, userId: Uint8Array, mute: boolean | null, deaf: boolean | null): Promise<ServerVoice>`; `Routes.disconnectVoiceMember(communityId, userId): Promise<void>`; `Routes.moveVoiceMember(communityId, userId, channelId): Promise<VoiceMoveResult>`; `interface ServerVoice { mute: boolean; deaf: boolean }`; `interface VoiceMoveResult { moved: number; disconnected: number }`;
  - `CallStarted.mod: number`; `pendingReason(): 0 | 1 | 2 | 3 | 4`; `AFKSnapshot.reason` and `AFKState.pendingReason`: `0 | 1 | 2 | 3 | 4`;
  - `VOICE_FLAG = { inCall: 1, selfMute: 2, selfDeaf: 4, video: 8, screen: 16, serverMute: 32, serverDeaf: 64 }`;
  - `CallState.move: { to: string; seq: number } | null`, `CallState.serverMuted: boolean`, `CallState.serverDeafened: boolean`; `CallJoinResult.serverMuted?`, `serverDeafened?`; `CALL_IDLE` with `move: null, serverMuted: false, serverDeafened: false`.

- [ ] **Step 1: Write the failing tests** (the lists of §C.12.1–§C.12.3; key assertions)

```ts
expect(voiceModerationOf(decodeFrame(encodeFrame(56, 0, null, [C, U, 3])))).toEqual({ communityId: C, userId: U, mod: 3 });
expect(() => decodeFrame(encodeFrame(56, 0, null, [C, U, 4]))).toThrow('E_FRAME_SHAPE');
expect(voiceMoveOf(decodeFrame(encodeFrame(57, 0, null, [C, A, B])))).toEqual({ communityId: C, callId: A, channelId: B });
expect(() => decodeFrame(encodeFrame(50, 0, null, [U, D, A, 32]))).toThrow('E_FRAME_SHAPE');
expect(DROPPABLE_OPS.has(56) && DROPPABLE_OPS.has(57)).toBe(true);
expect(sent.payload[4]).toBe(2n);                         // identifies with CAPS
// routes: PATCH /v1/communities/<c>/members/<u>/voice, body [1, null], idempotent true, answer [1,0] → { mute: true, deaf: false }
// setServerVoice(c, u, null, null) → E_ROUTE_INPUT, no request; a 409 E_NOT_IN_VOICE propagates with its code
// DELETE …/voice → 204; POST …/voice/move body [CHANNEL], idempotent false → { moved: 2, disconnected: 1 }
// participant mod 1,2,3,7 → flags |32, |64, |96, |96; startCall 8 elements mod 3 → mod 3; 6 or 7 elements → 0
// pendingReason: 3 → 3, 4 → 4, 5 → 2
```
The identify-vector test keeps the vector's caps 0 and asserts `sent.payload[4] === BigInt(CAPS)` (§C.12.2).

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w @dilla/client-core -- src/gateway src/http/routes.test.ts`. Expected: FAIL (`voiceModerationOf is not a function`, caps `0n`).

- [ ] **Step 3: Implement** §C.2, §C.3 and §C.4 (code given there; `gateway.ts:235` emits ops 56 and 57; `worker/controller.ts:1644` routes them to `this.calls.onFrame`). The T1 half of §C.6.3: `setIn` adds `move: null, serverMuted: false, serverDeafened: false`; `Live.mod` from `joined.started.mod`; the model's `startCall` returns `mod: 0`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test -w @dilla/client-core && npm run typecheck -w @dilla/client-core && npm run typecheck -w @dilla/web`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client-core packages/web/src/App.test.tsx
git commit -s -m "feat(client-core): voice moderation wire, ops 56 and 57, caps bit 1"
```

### Task M1: The speaker policy while server-deafened — lane core ∥, sonnet, review sonnet

**Files:**
- Modify: `packages/media/src/audio/speakers.ts`
- Test: `packages/media/test/audio-speakers.test.ts`

**Interfaces:**
- Produces: `SpeakerPolicy.setServerDeafened(on: boolean): void`; the test-only reader `serverDeafClientOff()` over `__DILLA_E2E_HOOKS__` and `globalThis.__dillaE2E.serverDeafClientOff` (§C.11).

- [ ] **Step 1: Write the failing tests** (§C.12.10)

```ts
it('setServerDeafened(true) unsubscribes every remote microphone and screen-share audio, and leaves video alone', …);
it('while server-deafened, a newly published audio track and a newly connected participant are unsubscribed, and ActiveSpeakersChanged resubscribes nothing', …);
it('setServerDeafened(false) resubscribes what it turned off, then applies the top-6 cap again', …); // 8 remotes → 6 subscribed
it('setServerDeafened(true) twice changes nothing the second time', …);
it('the e2e hook holds the policy off only when the build switch and the page flag are both set', …); // vi.stubGlobal('__DILLA_E2E_HOOKS__', true)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w @dilla/media -- test/audio-speakers.test.ts`. Expected: FAIL (`setServerDeafened is not a function`).

- [ ] **Step 3: Implement `setServerDeafened(on: boolean): void`** with `serverDeaf` and `deafExcluded: WeakSet<RemoteTrackPublication>`; `apply()` returns early while deafened after the deafen pass; `dispose()` resubscribes `deafExcluded` (§C.11).

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test -w @dilla/media && npm run typecheck -w @dilla/media`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/media
git commit -s -m "feat(media): the speaker policy holds off while server-deafened"
```

### Task U1: ActionMenu entries, submenus, check items, slider — lane ui ∥, sonnet, review sonnet

**Files:**
- Modify: `packages/ui/src/ActionMenu/ActionMenu.tsx`, `ActionMenu.css`, `ActionMenu.test.tsx`, `ActionMenu.stories.tsx`, `packages/ui/src/index.ts`
- Create: `packages/ui/src/ActionMenu/MenuList.tsx`, `place.ts`, `MenuSlider.tsx`

**Interfaces:**
- Produces: `type MenuEntry` (item, check, submenu, slider, separator, §U.2.2); `withSeparators(groups: readonly (readonly MenuEntry[])[]): MenuEntry[]`; `ActionMenuProps.items: readonly MenuEntry[]`, `onValue?(id: string, value: number): void`; internal `placeInBox(root: Element, at: {x: number; y: number}, w: number, h: number): {x: number; y: number}` and `boxOf(root)`; ui index exports `withSeparators` and `MenuEntry`.

- [ ] **Step 1: Write the failing tests**: the 18 `ActionMenu.test.tsx` cases of §U.10.1, keeping every existing case. Key assertions:

```ts
expect(screen.getByRole('menuitemcheckbox', { name: 'server mute' })).toHaveAttribute('aria-checked', 'true');
// hover opens a submenu after 150 ms, not before (vi.advanceTimersByTime(149) → closed; 1 → open)
// slider: ArrowRight +step, PageUp +5 steps, clamped to [min,max]; Home/End move menu focus
// Escape in a child closes only the child; a second Escape closes all and refocuses the trigger
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w @dilla/ui -- src/ActionMenu`. Expected: FAIL.

- [ ] **Step 3: Implement** `MenuList` (keys, typeahead with 500 ms buffer, hover focus, 150 ms open and 300 ms close timers, child placement), `MenuSlider`, `place.ts` (the clamp moved from `ActionMenu.tsx:55-65` unchanged) and the CSS, all as §U.2.1–§U.2.3 and §U.2.6.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test -w @dilla/ui -- src/ActionMenu && npm run typecheck -w @dilla/ui && npm run check:css`. Expected: PASS (axe clean in the three themes).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/ActionMenu packages/ui/src/index.ts
git commit -s -m "feat(ui): ActionMenu submenus, check items, slider and separators"
```

### Task U3: Surfaces in ui: `data-menu`, voice person buttons, roving selector form — lane ui ∥, sonnet, review sonnet

**Files:**
- Modify: `packages/ui/src/VoiceChannelRow/VoiceChannelRow.tsx`, `internal/roving.ts`, `ChannelList/ChannelList.tsx`, `ChannelRow/ChannelRow.tsx`, `CommunityRail/CommunityRail.tsx`, `MemberList/MemberList.tsx`, `MessageRow/MessageRow.tsx`, `AttachmentCard/AttachmentCard.tsx`, `Lightbox/Lightbox.tsx`, `CallTile/CallTile.tsx`, `styles/base.css`, and their tests

**Interfaces:**
- Produces: `interface RovingSelectors { rows: string; activeSelector: string | null }`; `useRovingFocus(active: number | RovingSelectors): RovingFocus`; `VoiceChannelRow` props `channelId: string`, `onPerson?(userId: string, anchor: HTMLElement): void`; `ChannelRow` prop `menu?: { surface: 'channel' | 'dm'; id: string }`; `MessageRow` and `AttachmentCard` prop `menuKey?: string`; `AttachmentCard` `index: number`; `Lightbox` `index`, `seq`; the `data-menu` contract of §U.4.1.

- [ ] **Step 1: Write the failing tests**

```ts
// roving.test.tsx (§U.4.3): the index form unchanged; selector form walks a voice row's people then the next channel;
//   tab stop on the row matching activeSelector; no match or null → first row; new activeSelector resets the stop
// VoiceChannelRow: each person is a button with data-menu="person", data-user-id and aria-haspopup="menu"; click → onPerson(id, button)
// ChannelList: ArrowDown from a voice row reaches its people, then the next channel; one tab stop; rows carry data-menu
// MemberList: a row button carries data-menu="person" and data-user-id; the list no longer handles contextmenu
// MessageRow / AttachmentCard: data-menu and data-menu-key={menuKey}; CommunityRail: data-menu="server" on server buttons only
// base.test.ts: [data-menu] has -webkit-touch-callout: none; phone user-select: none
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w @dilla/ui -- src/internal src/VoiceChannelRow src/ChannelList src/MemberList src/MessageRow src/AttachmentCard src/CommunityRail src/CallTile src/styles`. Expected: FAIL.

- [ ] **Step 3: Implement** the selector form of `useRovingFocus` (§U.4.3) and the attribute work file by file (§U.4.2; `ROWS` selector and `activeSelector` with `CSS.escape` in ChannelList; MemberList's `onContextMenu`, `onKeyDown`, `keyOpenedAt` and `openFrom` removed); `base.css` rules of §U.3.6.

- [ ] **Step 4: Run them to verify they pass**

Run: the Step 2 command, then `npm run typecheck -w @dilla/ui && npm run check:css`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -s -m "feat(ui): data-menu surfaces, voice person buttons, roving selector form"
```

### Task W1: Strings and flow 18 — lane web ∥, haiku, review sonnet

**Files:**
- Create: `packages/web/src/strings/personMenu.ts`, `voiceMod.ts`, `menus.ts`, `docs/design/flows/18-context-menus-and-voice-moderation.md`, `packages/web/src/strings/strings.flow18.test.ts`
- Modify: `packages/web/src/strings/en.ts` (spread the three after `...afk`)

**Interfaces:**
- Produces: the 81 keys of §U.9.3–§U.9.5 (14 `person.menu.`, 26 `voice.mod.`, 41 `menu.`).

- [ ] **Step 1: Write the failing test** (modelled on `strings.flow17.test.ts`)

```ts
expect(pairs.length).toBe(81);
for (const [key, value] of pairs) expect(table[key], key).toBe(value);
expect(Object.keys(en).filter(k => /^(person\.menu\.|voice\.mod\.|menu\.)/.test(k)).filter(k => !listed.has(k))).toEqual([]);
for (const k of CHROME) expect(en[k], k).toMatch(/^[a-z]/);            // the 46 keys of §U.9.8
for (const k of SENTENCES) expect(en[k], k).toMatch(/^[A-Z{]/);        // the other 35
for (const k of SENTENCES.filter(k => !STAGE.has(k))) expect(en[k], k).toMatch(/\.$/);
// STAGE = voice.mod.moved, voice.mod.moveMissed, voice.mod.disconnected; none of them ends with '.'
// the four sections (States, Keyboard map, Focus rules, Announcements) have content
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @dilla/web -- src/strings/strings.flow18.test.ts`. Expected: FAIL (no flow 18 doc).

- [ ] **Step 3: Write the strings and the doc.** Copy: spec §U.9.3–§U.9.5, verbatim. Flow doc: the intro, the four sections and the chrome list of §U.9.8 verbatim, then `## Copy` with the 81 lines as `` `key='value'` ``.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -w @dilla/web -- src/strings && npm run check:copy`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/strings docs/design/flows/18-context-menus-and-voice-moderation.md
git commit -s -m "feat(web): person menu, voice moderation and menu strings, flow 18"
```

---

## Wave 2

### Task S5: `voicemod.go` plumbing; mute and deafen in the grants; snapshot `mod`; op 56; the start answer's `mod` — lane server, sonnet, review opus

**Files:**
- Create: `internal/api/voicemod.go`, `internal/api/voicemod_test.go`
- Modify: `internal/api/calls.go` (`grantFor`, `admitGrant`, `start`, `AdmitRoom`, `callStartResponse`, fields `modGW`, `voiceModHook`), `callgrants.go` (`reconcileOutcome`, `reconcileRoom`), `callshare.go` (`share`), `callevents.go` (`joined`, `trackPublished`), `voicestate.go` (`deliver`), `callread.go` (`participantRow`, `participantRows`, `channelCall`, `communityCalls`), `export_test.go` (`SetVoiceModHookForTest`), `calls_test.go`, `internal/dillad/routes.go`

**Interfaces:**
- Consumes: S2's store methods; S3's `OpVoiceModeration`, `VoiceModerationPayload`, `DeviceCaps`, `CapVoiceMove`; S4's `WithoutAudio`, `UpdateSubscriptions`.
- Produces (all in `voicemod.go` unless noted):
  - `voiceModFor(ctx, repo store.Repository, ch store.ChannelRow, userID id.ID) (store.VoiceModeration, error)`, `audioOff(m) bool`, `modBits(m) uint64`;
  - `type voiceSpot struct { ch store.ChannelRow; row store.VoiceSessionRow; devices []id.ID }`, `(h *Calls) voiceSpotsOf(ctx, communityID, userID id.ID) ([]voiceSpot, error)`;
  - `deafenedIn`, `audioSIDs`, `(h *Calls) applyDeafen(ctx, d grantDeps, ch, row, parts) error`, `deafenRoom(ctx, row) error`, `undeafenUser(ctx, ch, row, userID) error`;
  - `(h *Calls) applyVoiceMod(ctx, cid, target id.ID, spots []voiceSpot, prev, next store.VoiceModeration)`;
  - `(h *Calls) announceVoiceMod(ctx, cid, target id.ID, spots []voiceSpot, m store.VoiceModeration)`; `voiceModsOf(ctx, cid) (map[id.ID]uint64, error)`, `voiceMods(ctx, ch)`;
  - `type VoiceModGateway interface { DeliverUser(id.ID, gateway.Frame); DeliverDevice(id.ID, gateway.Frame); DeviceCaps(id.ID) (uint64, bool) }`, `(h *Calls) WithVoiceMod(gw VoiceModGateway) *Calls`, `(h *Calls) moveCapable(dev id.ID) bool`;
  - `(h *Calls) voiceModStage(stage string)`, `SetVoiceModHookForTest(f func(stage string))`;
  - `callStartResponse` (8 elements: …, `Rung []id.ID`, `Mod uint64`); `grantFor(ctx, bits, muted bool, row, dev)`; `admitGrant` gains `muted bool`;
  - test fixture `newVoiceModEnv(t)` with its `modGW` fake (per-device `caps`, recorded frames).

- [ ] **Step 1: Write the failing tests** (`voicemod_test.go`; state seeded with `e.Repo.SetVoiceModeration`, then `applyVoiceMod` or the event under test)

```go
func TestServerMuteWithdrawsMicAndScreenAudio(t *testing.T) // lastPerms[dev]: CanPublish false, nil sources; sharer → [CAMERA, SCREEN_SHARE]; CanSubscribe true
func TestServerMuteHoldsOnJoin(t *testing.T)                // mint has no MICROPHONE; AdmitRoom grant none; participant_joined push none
func TestServerMutePersistsAcrossCalls(t *testing.T)
func TestServerMuteDoesNotReachDMCalls(t *testing.T)        // DM token has MICROPHONE
func TestServerUnmuteRestoresTheMic(t *testing.T)
func TestDeafenImpliesMuteAndUndeafenKeepsTheStoredMute(t *testing.T)
func TestRoleSyncKeepsAServerMute(t *testing.T)
func TestServerDeafenUnsubscribesAudioOnly(t *testing.T)    // subUpdates contains {room, memberDev, ["TR_mic","TR_sa"], false}; never TR_cam; none for other
func TestServerDeafenIsReappliedOnJoinTrackAndSweep(t *testing.T)
func TestServerDeafenFailureLeavesARoomResync(t *testing.T)
func TestUndeafenResubscribesAudio(t *testing.T)            // {room, memberDev, ["TR_mic","TR_sa"], true}
func TestNobodyDeafenedMakesNoSFUCall(t *testing.T)
func TestJoinOfAModeratedUserAnnouncesOp56(t *testing.T)    // op 56 [cid, member, 1] to the audience after the announcer drains
func TestCallSnapshotsCarryTheModerationElement(t *testing.T) // rows of 4; muted 1, deafened 2, both 3, none 0; DM 0
func TestCallStartAnswersTheOwnModeration(t *testing.T)     // 8 elements, rung []; mod 1/2/3/0; DM ring rung users, mod 0
func TestVoiceModerationOp56ReachesTheChannelAudience(t *testing.T) // every viewer of ch and the member; not a non-viewer
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test -race ./internal/api/ -run 'ServerMute|ServerDeafen|Deafen|Undeafen|NobodyDeafened|Op56|Snapshots|CallStartAnswers|RoleSyncKeeps'`. Expected: FAIL to compile.

- [ ] **Step 3: Implement** §S.4.1–§S.4.5 and §S.7 in the order given there, the spots helpers of §S.1.0, `VoiceModGateway`/`WithVoiceMod`/`moveCapable` of §S.5.3, the test hook, and the dillad wiring `calls.WithAFKAway(...).WithAFKDraining(...).WithVoiceMod(p.gw)` at `routes.go:122`. Existing `calls_test.go` cases that decode the start answer read eight elements.

- [ ] **Step 4: Run them to verify they pass**

Run: `go test -race ./internal/api/ ./internal/dillad/`. Expected: PASS.

- [ ] **Step 5: Gates**

Run: `go test -race ./internal/... && DILLA_TEST_PG="$DILLA_TEST_PG" go test -race ./internal/store/`. Expected: ok.

- [ ] **Step 6: Commit**

```bash
git add internal/api internal/dillad/routes.go
git commit -s -m "feat(api): server mute and deafen in grants and subscriptions, op 56, snapshot mod"
```

### Task S7: Protocol docs — lane server, sonnet, review sonnet

**Files:**
- Modify: `protocol/02-delivery-service.md`, `protocol/09-http-api.md` (not the permissions row), `protocol/08-*.md`, `protocol/07-versioning.md`

**Interfaces:**
- Consumes: S1's `CodeNotInVoice` (for `checkErrorVocabulary`); the frozen names of §8.

- [ ] **Step 1: Write the `E_NOT_IN_VOICE` row first and run the check**

Add the protocol/02 errors row of §S.1.0, then run `npm run check:docs`. Expected: PASS (`checkErrorVocabulary` matches the row to S1's `CodeNotInVoice`; with a misspelt code it FAILs).

- [ ] **Step 2: Write the rest of the docs** from: §S.1.0 (`E_NOT_IN_VOICE` row and prose), §S.7 (ops 56/57 rows and paragraph, snapshot rows), §S.4.5 (the start answer), §S.5.5 (AFK `pending` 3 and 4), §S.6 (audit bullet), the three routes of §S.1.1–§S.1.3, protocol/08's two statements and protocol/07's row as given in spec §11 S7 (wire 2).

- [ ] **Step 3: Run the checks**

Run: `npm run check:docs`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add protocol
git commit -s -m "docs(protocol): voice moderation routes, ops 56 and 57, the deafen bound"
```

### Task T2: client-core bit 24, the 25-bit mask, permission copy — lane core, sonnet, review sonnet

**Files:**
- Modify: `packages/client-core/src/admin/perm.ts`, `admin/perm.test.ts`, `admin/roles.test.ts`, `http/routes.ts` (`PERM_ALL`, comments :115 and :295), `http/routes.test.ts` (:1604, :1618), `packages/web/src/core/use-channel-bits.test.tsx`, `packages/web/src/strings/perm.ts`, `docs/design/flows/09-roles-and-private-channels.md` (Copy), `packages/web/src/strings/strings.flow09.test.ts`

**Interfaces:**
- Consumes: S1's `permissions.json`.
- Produces: `PERM.deafenMembers = 1 << 24`, `PERM_BY_KEY.deafen`, `PERM_GROUPS` voice `['connect','speak','video','screen','mute','deafen','move']`, `PERM_ALL = 0x1ffffff`; strings `perm.deafen`, `perm.deafen.hint`, new `perm.mute.hint`, `perm.move.hint`.

- [ ] **Step 1: Write the failing tests**

```ts
expect(PERM.deafenMembers).toBe(16777216);                         // "pins all 25 values"
expect(COMMUNITY_BITS & PERM.deafenMembers).toBe(0);               // deafenMembers is channel-overridable
// roles.test.ts:49,54,55 messages 0..33554431, out-of-range 0x2000000; routes.test.ts "25 permission bits", 0x2000000 + 1
// use-channel-bits.test.tsx:63 0x1ffffff; strings.flow09: 181 pairs, LOWER has 64 keys including 'perm.deafen'
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w @dilla/client-core -- src/admin src/http/routes.test.ts && npm test -w @dilla/web -- src/core/use-channel-bits.test.tsx src/strings/strings.flow09.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** §S.2 TS; copy: spec §U.9.6, verbatim, into `strings/perm.ts` and flow 09's Copy lines (:207, :209, plus the two `perm.deafen` lines after `perm.move.hint`).

- [ ] **Step 4: Run them to verify they pass**

Run: the Step 2 commands, then `npm run check:copy && npm run typecheck -w @dilla/web`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client-core packages/web docs/design/flows/09-roles-and-private-channels.md
git commit -s -m "feat(client-core): permission bit 24 and the 25-bit mask"
```

### Task U2: ContextMenu and MenuSheet — lane ui, sonnet, review sonnet

**Files:**
- Create: `packages/ui/src/ContextMenu/{ContextMenu.tsx,ContextMenu.css,ContextMenu.test.tsx,ContextMenu.stories.tsx}`, `packages/ui/src/MenuSheet/{MenuSheet.tsx,MenuSheet.css,MenuSheet.test.tsx,MenuSheet.stories.tsx}`
- Modify: `packages/ui/src/index.ts`

**Interfaces:**
- Consumes: U1's `MenuEntry`, `MenuList`, `placeInBox`.
- Produces: `ContextMenu(props: ContextMenuProps)` and `MenuSheet(props: MenuSheetProps)` with the props of §U.2.4 and §U.2.5 (`label`, `title?`, `entries`, `at`, `layout?: 'popup' | 'sheet'`, `returnFocus`, `onClose()`, `onSelect(id)`, `onValue?`, `labels: { back; close }`).

- [ ] **Step 1: Write the failing tests** (§U.10.1 lists)

```ts
// ContextMenu: opens at the point clamped to the shell, first item focused; Escape → focus on returnFocus;
//   outside pointerdown, window blur and an ancestor scroll close it; layout sheet renders MenuSheet
// MenuSheet: role dialog aria-modal named by its title; Tab stays inside; a submenu pushes a page, back focuses the item;
//   Escape on a page goes back, on the root closes; check items are role switch; slider is input type=range;
//   every item, back and close have min-height 2.75rem
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w @dilla/ui -- src/ContextMenu src/MenuSheet`. Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** both as §U.2.4–§U.2.6 (z-index 45, `min-width: 13.75rem`, sheet values copied from `ProfileCard.css:21-25`, focus trap copied from `ProfileCard.tsx:148-157`).

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test -w @dilla/ui -- src/ContextMenu src/MenuSheet && npm run typecheck -w @dilla/ui && npm run check:css`. Expected: PASS, axe clean in three themes.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/ContextMenu packages/ui/src/MenuSheet packages/ui/src/index.ts
git commit -s -m "feat(ui): ContextMenu popup and MenuSheet"
```

### Task U4: Indicators and held controls — lane ui, sonnet, review sonnet

**Files:**
- Modify: `packages/ui/src/CallTile/CallTile.tsx`, `CallTile.css`, `VoiceChannelRow/VoiceChannelRow.tsx`, `VoiceChannelRow.css`, `UserPanel`, `CallControls`, `CallBar` (components and tests)

**Interfaces:**
- Produces: `VoiceParticipantView.serverMuted?`, `serverDeafened?`, `mutedForMe?`; `VoiceStateLabels.serverMuted`, `serverDeafened`, `mutedForMe`; `held?: { mute?: string; deafen?: string }` on `UserPanel`, `CallControls`, `CallBar`.

- [ ] **Step 1: Write the failing tests**

```ts
// VoiceChannelRow: server muted shows the boxed mic-off named "muted by a moderator" and hides the self-muted glyph;
//   server deafened shows only the boxed headphone-off; mutedForMe shows volume-x named "muted for you"; groupPeople uses some()
// CallTile: voiceStateWords order mutedForMe, serverDeafened > serverMuted > muted; silentByChoice counts server states
// UserPanel/CallControls/CallBar: held.mute → mute aria-disabled, aria-pressed true, described by the reason
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w @dilla/ui -- src/CallTile src/VoiceChannelRow src/UserPanel src/CallControls src/CallBar`. Expected: FAIL.

- [ ] **Step 3: Implement** §U.7.2–§U.7.5 (no new icon; boxed glyph CSS in both CSS files; `SLOT_STATES`).

- [ ] **Step 4: Run them to verify they pass**

Run: the Step 2 command, `npm run typecheck -w @dilla/ui`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src
git commit -s -m "feat(ui): server mute and deafen indicators, held controls"
```

---

## Wave 3

### Task S6a: The PATCH route, rights on spots, audit — lane server, sonnet, review opus

**Files:**
- Modify: `internal/api/voicemod.go` (adds `voiceModReq`, `voiceModTarget`, `requireOnSpots`, the PATCH handler, `auditVoiceMod`), `internal/api/calls.go` (`Register`), `internal/api/voicemod_test.go`

**Interfaces:**
- Consumes: S5's plumbing and `newVoiceModEnv`; S1's `CodeNotInVoice`, `PermDeafenMembers`.
- Produces: `PATCH /v1/communities/{id}/members/{user_id}/voice`; `(h *Calls) voiceModTarget(r *http.Request) (voiceModReq, error)`; `requireOnSpots(ctx, res *Resolver, caller id.ID, spots []voiceSpot, want Bits) error`; `auditVoiceMod(ctx, tx store.Repository, actor, cid, target, channel id.ID, prev, next store.VoiceModeration, at int64) error`; test helper `patchVoice(tok, user, mute, deaf any)`.

- [ ] **Step 1: Write the failing tests** (negative first)

```go
func TestVoiceMuteNeedsMuteMembersInTheTargetsChannel(t *testing.T) // no bit 403; overwrite on ch2 only 403; on ch 200; deny on ch 403
func TestVoiceDeafenNeedsDeafenMembers(t *testing.T)               // mute_members alone [null,1] 403; deafen alone [null,1] 200, [1,null] 403
func TestVoiceModerationNeverTargetsTheOwner(t *testing.T)         // admin PATCH on owner 403, nothing stored, no frame; owner on self 200
func TestVoiceModerationHasNoRankCheck(t *testing.T)               // lower-ranked moderator PATCH 200; kick 403
func TestVoiceModerationNeedsTheTargetInVoice(t *testing.T)        // 409 E_NOT_IN_VOICE; stored mute, not in voice, [0,null] 409, mute still stored
func TestVoiceModerationHidesACallTheCallerCannotSee(t *testing.T) // 409, not 403 or 404
func TestVoiceModerationAnswers404ForStrangers(t *testing.T)
func TestVoiceModerationBodies(t *testing.T)                       // [null,null], [2,null], [true,null], 3 elements → 400
func TestVoiceModerationRechecksRightsInTheTransaction(t *testing.T) // hook at "checked" revokes the role → 403, nothing stored, no frame, no audit
func TestVoiceModerationAuditsEachChange(t *testing.T)             // voice.server_mute cid:ch; repeat no row; [0,1] unmute then deafen; [null,0] undeafen
func TestServerMuteLandingMidJoinHolds(t *testing.T)               // Review Focus 5: start mints with mic; PATCH [1,null]; AdmitRoom → no MICROPHONE; participant_joined push → no MICROPHONE
```
Re-run the S5 grant and deafen tests through `patchVoice`.

- [ ] **Step 2: Run them to verify they fail**

Run: `go test -race ./internal/api/ -run 'VoiceMute|VoiceDeafen|VoiceModeration|MidJoin'`. Expected: FAIL (404 from an unregistered route).

- [ ] **Step 3: Implement** §S.1.0 (prelude order, `requireOnSpots` code), §S.1.1 (check order, the transaction exactly as given), §S.6 (`auditVoiceMod`, mute then deafen).

- [ ] **Step 4: Run them to verify they pass**

Run: `go test -race ./internal/api/`. Expected: PASS. Break `requireOnSpots`'s visibility check once, see `TestVoiceModerationHidesACallTheCallerCannotSee` fail, restore.

- [ ] **Step 5: Commit**

```bash
git add internal/api
git commit -s -m "feat(api): PATCH voice moderation route with rights on every spot and audit"
```

### Task T3: Mute for me, the local setting — lane core, sonnet, review sonnet

**Files:**
- Modify: `packages/client-core/src/state/settings.ts`, `state/settings.test.ts`, `index.ts`

**Interfaces:**
- Produces: `SETTINGS.voiceLocalMute(hex: string): string` = `voice.localMute.<hex>`; `isLocallyMuted(settings: Record<string, string>, userHex: string): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
expect(isSettingValue('voice.localMute.' + HEX, '1')).toBe(true);
expect(isSettingValue('voice.localMute.' + HEX, '0')).toBe(false);
expect(isSettingKey('voice.localMute.XYZ')).toBe(false);
expect(isLocallyMuted({ ['voice.localMute.' + HEX]: '1' }, HEX)).toBe(true);
expect(isLocallyMuted({}, HEX)).toBe(false);
```

- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/client-core -- src/state/settings.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** §C.10 (client-core half).

- [ ] **Step 4: Run them to verify they pass**: the same command plus `npm run typecheck -w @dilla/client-core`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/state packages/client-core/src/index.ts
git commit -s -m "feat(client-core): the voice.localMute setting"
```

### Task T4: The advisory checks, `voiceModAccess` — lane core, sonnet, review sonnet

**Files:**
- Create: `packages/client-core/src/admin/voicemod.ts`, `admin/voicemod.test.ts`
- Modify: `packages/client-core/src/index.ts`

**Interfaces:**
- Consumes: T2's `PERM.deafenMembers`; `channelBitsOf` from `admin/perm.ts`.
- Produces: `interface VoiceModSnapshot { owner; everyoneId; roles; members; overwrites; voiceChannels; afkChannelId }`; `interface VoiceModAccess { local: boolean; serverMute: boolean; serverDeafen: boolean; move: boolean; disconnect: boolean; moveTargets: string[] }`; `NO_VOICE_MOD`; `voiceModAccess(s: VoiceModSnapshot, me: string, target: string, source: string | null, ownCall: string | null): VoiceModAccess`; `canJoin(s: VoiceModSnapshot, channel: string, user: string): boolean`; `voiceChannelOf(voice: VoiceState, channels: readonly string[], userId: string): string | null`.

- [ ] **Step 1: Write the failing tests**: the 16 cases of §C.12.5. Key ones:

```ts
expect(voiceModAccess(s, M, O, V1, null)).toEqual(NO_VOICE_MOD);                       // 1, even with administrator
expect(voiceModAccess(s, O, O, V1, V1)).toEqual({ local: true, serverMute: false, serverDeafen: false,
  move: true, disconnect: true, moveTargets: [V2, V3] });                              // 2
expect(voiceModAccess(s, O, O, V1, null)).toEqual(NO_VOICE_MOD);                       // 3
expect(voiceModAccess(muteOnly, M, T, V1, null).serverDeafen).toBe(false);             // 7
expect(voiceModAccess(tDeniedV3, M, T, V1, null).moveTargets).toEqual([V2]);           // 9
expect(voiceModAccess(tAboveM, M, T, V1, null).move).toBe(true);                       // 11, no rank check
```

- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/client-core -- src/admin/voicemod.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** §C.9.2 (the code is given; it is authz, so keep it verbatim).

- [ ] **Step 4: Run them to verify they pass**: the same command and `npm run typecheck -w @dilla/client-core`. Expected: PASS. Remove the owner guard once, see cases 1 and 3 fail, restore.

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/admin/voicemod*.ts packages/client-core/src/index.ts
git commit -s -m "feat(client-core): voiceModAccess advisory checks"
```

### Task U5: Drag — lane ui, sonnet, review sonnet

**Files:**
- Create: `packages/ui/src/ChannelList/useVoiceDrag.ts`, `useVoiceDrag.test.tsx`
- Modify: `packages/ui/src/ChannelList/ChannelList.tsx`, `ChannelList.css`, `VoiceChannelRow/VoiceChannelRow.tsx`

**Interfaces:**
- Produces: `ChannelListProps['voice'].drag?: { canDrag(userId, fromChannelId): boolean; canDrop(userId, fromChannelId, toChannelId): boolean; onDrop(userId, from, to): void; onRefuse(userId, from, to): void; onCancel(): void }`; `VoiceChannelRow` prop `drop?: 'valid' | 'over'`.

- [ ] **Step 1: Write the failing tests** (the 10 `useVoiceDrag.test.tsx` cases of §U.10.1)

```ts
// a press and release under 4 px is a click (onPerson), no drag
// moving 4 px: capture set, ghost aria-hidden, valid rows data-drop="valid", invalid rows none
// pointerup over a valid row → onDrop once, click swallowed; over an invalid row → onRefuse; over nothing or the source → neither
// Escape → onCancel, every data-drop cleared; lostpointercapture → onCancel; touch pointerdown never drags; canDrag false → no drag
// near the scroller's bottom edge the scroller scrolls (rAF faked), at most 8 px a frame (4 under reduced motion)
```

- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/ui -- src/ChannelList`. Expected: FAIL.

- [ ] **Step 3: Implement** the pointer machine of §U.6.3 (threshold 4 px, `EDGE = 32`, ghost via `placeInBox`) and the CSS.

- [ ] **Step 4: Run them to verify they pass**: the same command, `npm run typecheck -w @dilla/ui && npm run check:css`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/ChannelList packages/ui/src/VoiceChannelRow
git commit -s -m "feat(ui): drag a voice participant onto another channel"
```

### Task W3: The menu host and row actions — lane web, sonnet, review sonnet

**Files:**
- Create: `packages/web/src/screens/menus/MenuHost.tsx`, `native.ts`, `long-press.ts`, `clipboard.ts`, `MenuActionRegistry.tsx` and their tests
- Modify: `packages/web/src/screens/Shell.tsx` (the two provider wraps and `dw-menu-root` only)

**Interfaces:**
- Consumes: U2's `ContextMenu`.
- Produces: `type MenuSurface`; `interface BuiltMenu { label; title; entries: MenuEntry[] }`; `interface SurfaceHandler { build(el): BuiltMenu | null; run(el, id): void; value?(el, id, value): void }`; `useContextMenu(surface, root, handler): void`; `useOpenMenu(): (el, at?) => void`; `MenuHostProvider(props: { children; phone: boolean })`; `keepsNativeMenu(e: MouseEvent | KeyboardEvent, target: Element, fromKey: boolean): boolean`; `LONG_PRESS_MS = 500`, `LONG_PRESS_SLOP_PX = 10`, `CLICK_SUPPRESS_MS = 700`, `createLongPress(opts)`; `copyText(text: string): Promise<boolean>`, `copyImage(blob: Blob): Promise<boolean>`; `interface RowActions { run(id: string): void | Promise<boolean>; value?(id, v): void }`, `MenuActionRegistry`, `MenuActionProvider`, `useRowActions(key: string, actions: RowActions): void`, `rowActionsOf(registry, el): RowActions | undefined`.

- [ ] **Step 1: Write the failing tests** (`native.test.ts`, `long-press.test.ts`, `MenuHost.test.tsx`, `MenuActionRegistry.test.tsx` of §U.10.2)

```ts
expect(keepsNativeMenu(contextmenu({ shiftKey: true }), row, false)).toBe(true);
expect(keepsNativeMenu(contextmenu({ shiftKey: true }), row, true)).toBe(false);   // fromKey wins
expect(keepsNativeMenu(contextmenu(), textarea, false)).toBe(true);
// long-press fires at 500 ms; >10 px cancels; swallowsClick true for 700 ms
// MenuHost: right-click on a registered [data-menu] prevents default and opens one menu; innermost root wins;
//   Shift+F10 opens at the element's corner and the following contextmenu within 500 ms is swallowed
// registry: rowActionsOf finds the closest [data-menu-key]; an unmounted row runs nothing; a stale delete keeps the newer entry
```

- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/web -- src/screens/menus`. Expected: FAIL.

- [ ] **Step 3: Implement** §U.3 (listener order of §U.3.4: defaultPrevented, `fromKey`, `keepsNativeMenu`, touch, resolve; portal into `.d-app-shell`) and §U.3.8.

- [ ] **Step 4: Run them to verify they pass**: the same command, `npm run typecheck -w @dilla/web && npm run lint`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/screens/menus packages/web/src/screens/Shell.tsx
git commit -s -m "feat(web): app-wide context menu host and row actions"
```

---

## Wave 4

### Task S6b: Move and disconnect — lane server, sonnet, review opus

**Files:**
- Modify: `internal/api/voicemod.go` (DELETE and move handlers, `modCut`, `noteMove`, `clearMove`, `clearMoveIf`, `listsDevice`, `SweepVoiceMoves`), `internal/api/afk.go` (consts), `internal/api/calls.go` (`Admitted`, fields `moveMu`, `moves`), `internal/api/callgrants.go` (`StartRetries`), `internal/api/voicemod_test.go`, `internal/dillad` test

**Interfaces:**
- Consumes: S5, S6a.
- Produces: `DELETE …/members/{user_id}/voice` → 204; `POST …/members/{user_id}/voice/move` `[channel_id]` → `200 [moved, disconnected]`; `afkPendingMoved = 3`, `afkPendingModerated = 4`; `const voiceMoveDeadline = 10 * time.Second`; `(h *Calls) modCut(ctx, row, dev id.ID, reason uint64, hold time.Duration) error`; `(h *Calls) SweepVoiceMoves(ctx)`.

- [ ] **Step 1: Write the failing tests** (negative first; §S.8 lists)

```go
func TestMoveNeedsMoveMembersOnTheSource(t *testing.T)                 // only on ch2 (the target) → 403
func TestMoveNeedsViewAndConnectOnTheTargetForTheMover(t *testing.T)   // hidden 404, visible without connect 403
func TestMoveRefusesATargetTheMovedPersonCannotJoin(t *testing.T)      // 403; no op 57, no removal, no audit
func TestMoveRefusesAFKTextAndForeignTargets(t *testing.T)             // 400 each
func TestMoveToTheChannelTheyAreInIs400(t *testing.T)
func TestMoveIntoAFullCallIs409(t *testing.T)                          // MaxVoiceParticipants 1 → 409 E_CALL_FULL
func TestDisconnectCutsEveryDeviceWithAReasonForCapableOnes(t *testing.T) // pending memberDev 4, phone 0; audit cid:ch:2
func TestDisconnectedDeviceMayRejoin(t *testing.T)
func TestDisconnectBusyLockIs503AndKeepsNoReason(t *testing.T)
func TestMoveSendsOp57ToCapableDevices(t *testing.T)                   // [1,0]; DeliverDevice op 57 [cid, callID, ch2], Caps == CapVoiceMove; audit cid:ch:ch2:1:0
func TestMoveDisconnectsDevicesThatCannotFollow(t *testing.T)          // [0,1]; detail cid:ch:ch2:0:1
func TestMoveWithMixedDevices(t *testing.T)                            // [1,1]
func TestMoveIsEnforcedAfterTenSeconds(t *testing.T)                   // +9 s no cut; +10 s cut, pending 3
func TestMoveFollowedIsForgotten(t *testing.T)
func TestMoveDeadlineSurvivesAnSFUListingFailure(t *testing.T)
func TestVoiceModWiring(t *testing.T)                                  // or var _ api.VoiceModGateway = (*gateway.Gateway)(nil)
```
Plus the DELETE and move parts of the owner, no-rank, not-in-voice, bodies and recheck tests.

- [ ] **Step 2: Run them to verify they fail**: `go test -race ./internal/api/ -run 'Move|Disconnect'`. Expected: FAIL.

- [ ] **Step 3: Implement** §S.1.2, §S.1.3 (refusal order exactly), §S.5.4, §S.5.5 (`modCut` code given; `noteMove` before the frame).

- [ ] **Step 4: Run them to verify they pass**: `go test -race ./internal/... && DILLA_TEST_PG="$DILLA_TEST_PG" go test -race ./internal/store/`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/api internal/dillad
git commit -s -m "feat(api): move and disconnect with op 57 and the 10 s enforcement"
```

### Task T5: The four moderation commands — lane core, sonnet, review sonnet

**Files:**
- Modify: `packages/client-core/src/worker/protocol.ts`, `worker/controller.ts`, `admin/controller.ts`, `worker/world.ts`, `admin/controller.test.ts`

**Interfaces:**
- Consumes: T1's routes (`setServerVoice`, `disconnectVoiceMember`, `moveVoiceMember`).
- Produces: commands `{ m: 'voiceMove'; communityId; userId; toChannelId }` → `VoiceMoveResult`, `{ m: 'voiceDisconnect'; communityId; userId }` → `null`, `{ m: 'serverMute' | 'serverDeafen'; communityId; userId; on: boolean }` → `null`; `AdminController.voiceMove`, `voiceDisconnect`, `serverVoice(communityId, userId, kind: 'mute' | 'deaf', on: boolean): Promise<null>`; `AdminDeps.loadVoice(communityId: string | null, channelId: string | null): Promise<unknown>`, `AdminDeps.afkChannel(communityId: string): string | null`.

- [ ] **Step 1: Write the failing tests** (§C.12.7)

```ts
// E_BAD_INPUT before sending: non-hex toChannelId; unlisted community; serverMute on 'yes'; serverDeafen without on
expect(routes.moveVoiceMember).toHaveBeenCalledWith(COMMUNITY, user, VOICE2);  // ret { moved: 1, disconnected: 0 }
// text channel, another server's channel, the AFK channel → E_BAD_INPUT, nothing sent
// 403 → getPermissions once more, E_FORBIDDEN; 409 E_NOT_IN_VOICE → getCommunityCalls once more; 409 E_CALL_FULL reads nothing
// voiceDisconnect 409 E_NOT_IN_VOICE is success; serverMute/Deafen → setServerVoice(cid, user, on, null) / (cid, user, null, on)
// the four commands are refused outside ready
```

- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/client-core -- src/admin/controller.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** §C.5 (code given).

- [ ] **Step 4: Run them to verify they pass**: the same command, `npm run typecheck -w @dilla/client-core`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/worker packages/client-core/src/admin
git commit -s -m "feat(client-core): voiceMove, voiceDisconnect, serverMute and serverDeafen commands"
```

### Task W2: Pure menu models and the drop verdict — lane web, sonnet, review opus

**Files:**
- Create: `packages/web/src/screens/menus/groups.ts`, `person-menu.ts`, `message-menu.ts`, `link-menu.ts`, `attachment-menu.ts`, `channel-menu.ts`, `voice-channel-menu.ts`, `category-menu.ts`, `server-menu.ts`, `dm-menu.ts`, `drop-verdict.ts`, one test file each
- Modify: `packages/web/src/screens/admin/MemberRolesFlow.tsx` (extract `roleChoices`, `toggleRole`)

**Interfaces:**
- Consumes: T4's `VoiceModAccess`, `NO_VOICE_MOD`, `canJoin`; `canModerate` from `members-model.ts`.
- Produces: `NotifyMode`, `MenuItemModel<Id>`, `Group<G, Id>` (§U.5.0); `PersonMenuInput`, `PersonItem`, `PersonGroup`, `personMenu(input): PersonGroup[]`, `roleChoices(input)` (§U.5.1.1); `messageMenu`, `linkMenu`, `attachmentMenu`, `channelMenu`, `voiceChannelMenu`, `categoryMenu`, `serverMenu`, `dmMenu` with the signatures of §U.5.2–§U.5.9; `DropRefusal`, `DropVerdict { ok: boolean; reason: DropRefusal | null }`, `DropInput`, `dropVerdict(i: DropInput): DropVerdict`, `canDrag(mod: VoiceModAccess, away: boolean): boolean` (§U.6.2); `toggleRole(client, cid, userId, roleId, on): Promise<void>`.

- [ ] **Step 1: Write the failing tests**: one `it` per truth-table row, asserting the exact flat id list. Truth tables: spec §U.5.1.3 (18 rows), §U.5.2, and the tables of §U.5.3–§U.5.9; `drop-verdict.test.ts` per §U.10.2. Key assertions:

```ts
expect(flat(personMenu(row7OwnerSeenByAdmin))).toEqual(['profile', 'mention', 'message', 'compare', 'copyId']);
expect(dropVerdict({ ...base, to: { ...to, afk: true } })).toEqual({ ok: false, reason: 'afk' });
expect(dropVerdict(localNoConnect)).toEqual({ ok: false, reason: 'youCannotJoin' });
expect(canDrag(NO_VOICE_MOD, false)).toBe(false);
```

- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/web -- src/screens/menus src/screens/admin/MemberRolesFlow.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement** the models from the tables; `dropVerdict` rules 1–8 of §U.6.2 in order.

- [ ] **Step 4: Run them to verify they pass**: the same command, `npm run typecheck -w @dilla/web && npm run lint`. Expected: PASS, `MemberRolesFlow.test.tsx` unchanged and green.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/screens/menus packages/web/src/screens/admin/MemberRolesFlow.tsx
git commit -s -m "feat(web): menu models, truth tables and the drop verdict"
```

---

## Wave 5

### Task T6: Applying a move; moderation in VoiceBook and in the own call — lane core, opus, review opus

**Files:**
- Modify: `packages/client-core/src/calls/controller.ts`, `calls/voice.ts`, `worker/controller.ts` (CallDeps and VoiceDeps wiring), `calls/controller.test.ts`, `sync/testing/model.ts`

**Interfaces:**
- Consumes: T1 (frames, `CallState` fields, `CallStarted.mod`, the minimal `setIn`/`Live.mod` it replaces); T5's `worker/controller.ts` wiring, which it extends.
- Produces: `MOVE_RELOAD_MS = 3000`; `CallDeps.reloadCommunity(communityHex: string): Promise<void>`, `CallDeps.afkChannel(communityHex: string): string | null`; `VoiceDeps.communityOf(channelHex: string): string | null`; `VoiceBook.moderation(f: VoiceModerationFrame): void`; `call.move` offers and `serverMuted`/`serverDeafened` as §C.6–§C.7.

- [ ] **Step 1: Write the failing tests**: the 21 cases of §C.12.8 with its harness additions (`moveFrame(community, call, to)`, `moderationFrame(community, user, mod)`, `VOICE2`, `VOICE3`, ModelDs `serverVoice`). Key assertions:

```ts
expect(callSlice()).toMatchObject({ phase: 'in', move: { to: w.voice2, seq: 1 } });   // 1, no new request
expect(callSlice()).toMatchObject({ phase: 'in', channelId: w.voice2, move: null });   // 2, after the follow
expect(bobRow().flags).toBe(33); /* then voiceFrame(PEER, VOICE, 1|2) */ expect(bobRow().flags).toBe(35); // 14
expect(bobRow().flags & 32).toBe(32);                                                  // 17, op 56 during a held snapshot
expect(joinRet).toMatchObject({ serverMuted: true, serverDeafened: false });           // 18
```

- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/client-core -- src/calls/controller.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** §C.6.2–§C.6.5 and §C.7 (code given; the central `setState` rule first). Judge every existing exact-state expectation that changes.

- [ ] **Step 4: Run them to verify they pass**: `npm test -w @dilla/client-core && npm run typecheck -w @dilla/client-core`. Expected: PASS, the whole `calls/controller.test.ts` and `worker/controller.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/calls packages/client-core/src/worker/controller.ts packages/client-core/src/sync/testing/model.ts
git commit -s -m "feat(client-core): follow a server move; fold voice moderation into the voice slice"
```

### Task T7: Fake-server routes — lane core, sonnet, review sonnet

**Files:**
- Modify: `packages/client-core/src/testing/fake-server.ts`, `testing/fake-server.test.ts`

**Interfaces:**
- Produces: fake routes for PATCH, DELETE and POST move under `/v1/communities/{cid}/members/{u}/voice`; state `unmovable: Set<string>`, `serverVoice: Map<string, number>`, `moves: { from; to; user }[]`; snapshot rows `[user, device, flags, serverVoice.get(user) ?? 0]`.

- [ ] **Step 1: Write the failing tests** (§C.12.9)

```ts
expect(await routes.moveVoiceMember(C, U, TARGET)).toEqual({ moved: 1, disconnected: 1 });   // one device unmovable
// a move of someone not in voice → 409 E_NOT_IN_VOICE; a second disconnect → 409 E_NOT_IN_VOICE
// server mute → getChannelCall flags bit 5; deafen bit 6; [0, null] clears the mute
```

- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/client-core -- src/testing/fake-server.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the routes of §C.12.9 in `callRoute` (fake-server.ts:382).

- [ ] **Step 4: Run them to verify they pass**: the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/testing
git commit -s -m "test(client-core): fake-server voice moderation routes"
```

### Task W4a: The person menu's inputs and the mover's feedback — lane web, sonnet, review opus

**Files:**
- Modify: `packages/web/src/screens/menus/person-menu.ts`, `packages/web/src/call/volume.ts` (export `volumeOf`), `packages/web/src/screens/voice/VoiceView.tsx` (import it)
- Create: `packages/web/src/screens/menus/person-inputs.test.ts`, `screens/menus/useVoiceMod.ts`, `screens/menus/useVoiceMod.test.tsx`

**Interfaces:**
- Consumes: W2's `PersonMenuInput`; T4's `voiceModAccess`, `voiceChannelOf`; T3's `isLocallyMuted`; T5's commands.
- Produces: `interface PersonSources` and `personInputs(s: PersonSources): PersonMenuInput` exactly as §U.5.1.4; `volumeOf(settings: Readonly<Record<string, string>>, userId: string): number` in `call/volume.ts`; `useVoiceMod(announce: (text: string) => void, setModNotice: (n: { id: number; text: string } | null) => void): { move(communityId: string, userId: string, toChannelId: string, label: { name: string; channel: string }): Promise<void>; disconnect(communityId: string, userId: string, name: string): Promise<void>; mute(communityId: string, userId: string, on: boolean, name: string): Promise<void>; deafen(communityId: string, userId: string, on: boolean, name: string): Promise<void> }` (every outcome said as §U.8.3; none rejects).

- [ ] **Step 1: Write the failing tests** (one per row of the `personInputs` table; one per outcome row of §U.8.3)

```ts
expect(personInputs(unreadAccess).community?.mod).toEqual(NO_VOICE_MOD);
expect(personInputs(inPaused).voice?.sameCall).toBe(true);
expect(personInputs(composerClosed).canMention).toBe(false);
// useVoiceMod: disconnected > 0 → announce voice.mod.movedDisconnected and the banner; 409 E_CALL_FULL → voice.mod.error.full;
//   disconnect 409 E_NOT_IN_VOICE → voice.mod.done.disconnected, no banner
```

- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/web -- src/screens/menus/person-inputs.test.ts src/screens/menus/useVoiceMod.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement** `personInputs` from the field table of §U.5.1.4, and `useVoiceMod` from the outcome table of §U.8.3.

- [ ] **Step 4: Run them to verify they pass**: the same command, `npm run typecheck -w @dilla/web`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/screens/menus packages/web/src/call/volume.ts packages/web/src/screens/voice/VoiceView.tsx
git commit -s -m "feat(web): person menu inputs and the mover's feedback"
```

### Task W4b: The person surface wiring — lane web, sonnet, review opus

**Files:**
- Create: `packages/web/src/screens/menus/usePersonMenu.tsx`, `packages/web/src/screens/Shell.personMenu.test.tsx`
- Modify: `packages/web/src/screens/admin/Moderation.tsx` (new export `ModFlows`), `screens/admin/MemberCardHost.tsx` (`'menu'` source), `screens/admin/MemberPane.tsx`, `screens/Shell.tsx`, `screens/voice/VoiceView.tsx` (labels)

**Interfaces:**
- Consumes: W3's `useContextMenu`; W4a's `personInputs`, `useVoiceMod`; W2's `personMenu`; U3's `onPerson`; U4's labels.
- Produces: the `person` surface handler; `ModFlows` (`{ kind: 'kick' | 'ban'; communityId; target: ModTarget; opener: HTMLElement } | null`); `OpenCard.source` gains `'menu'`; Shell state `modNotice: { id: number; text: string } | null`.

- [ ] **Step 1: Write the failing tests** (`Shell.personMenu.test.tsx` of §U.10.2, plus Review Focus 1)

```ts
// right-click a member row opens the person menu, a click still opens the card; owner's menu on a voice person
//   shows server mute, server deafen, move to, disconnect; move to lists only channels both can join;
//   choosing a channel calls voiceMove and announces "Moved björn to general."; disconnected > 0 raises the warn banner;
//   mention inserts "@username " and focuses the composer; copy user ID announces "User ID copied."; kick opens KickFlow
it("an administrator sees no voice moderation and no roles on the owner's row from any surface", async () => {
  for (const surface of ['voice row', 'member list', 'message author', 'mention', 'call tile', 'DM row'])
    expect(await openMenuOnOwner(surface)).not.toEqual(expect.arrayContaining(['server mute', 'server deafen', 'move to', 'disconnect', 'roles']));
});
```

- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/web -- src/screens/Shell.personMenu.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement** §U.5.1.5 (each id's action), the Shell sources of `PersonSources`, `ModFlows` beside `KickFlow` and `BanFlow`, the `modNotice` banner after `removalNotices`.

- [ ] **Step 4: Run them to verify they pass**: the same command, then `npm test -w @dilla/web && npm run typecheck -w @dilla/web && npm run lint`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/screens
git commit -s -m "feat(web): the person menu on every person surface"
```

---

## Wave 6

### Task W5: The other surfaces — lane web, sonnet, review sonnet

**Files:**
- Modify: `packages/web/src/screens/conversation/Conversation.tsx`, `conversation/ThreadView.tsx`, `conversation/MessageItem.tsx`, `conversation/Attachments.tsx`, `screens/Shell.tsx`, `screens/admin/ChannelsSection.tsx` (export `DeleteChannel`), `screens/admin/DangerSection.tsx` (extract `LeaveFlow`)
- Create: `packages/web/src/screens/menus/use{Message,Link,Attachment,Channel,VoiceChannel,Category,Server,Dm}Menu.tsx`, `screens/Shell.contextMenus.test.tsx`, `screens/conversation/Conversation.menu.test.tsx`, `screens/conversation/ThreadView.menu.test.tsx`

**Interfaces:**
- Consumes: W2's models, W3's registry and host.
- Produces: the eight surface handlers; `LeaveFlow`; `InviteFlow` mounted in Shell (`inviteFor: communityId`).

- [ ] **Step 1: Write the failing tests** (§U.10.2 "Surfaces")

```ts
// message menu: reply → the reply chip; pin → emit { kind: 'pin', on: true }; delete → the existing confirm; edit → the editor;
//   react → emit { kind: 'react', anchor: the [data-action="react"] button }; copy text copies plainBody and announces "Text copied."
// link menu opens with noopener; attachment save calls openAttachment and saveBlob; copy image hidden without ClipboardItem
// thread pane: no reply, no pin, no thread; channel menu: mark as read, mute, edit, delete; server menu: leave hidden for the owner
```

- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/web -- src/screens/Shell.contextMenus.test.tsx src/screens/conversation`. Expected: FAIL.

- [ ] **Step 3: Implement** the mapping table of §U.3.8 in `MessageItem` (`useRowActions('message:' + item.seq, …)`), the attachment card's actions, and each surface hook from §U.5.2–§U.5.9.

- [ ] **Step 4: Run them to verify they pass**: the same command, `npm test -w @dilla/web && npm run typecheck -w @dilla/web && npm run lint`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/screens
git commit -s -m "feat(web): message, link, attachment, channel, category, server and DM menus"
```

### Task W7: Drag wiring in Shell — lane web, sonnet, review sonnet

**Files:**
- Modify: `packages/web/src/screens/Shell.tsx` (`voice.drag`), `screens/Shell.personMenu.test.tsx`

**Interfaces:**
- Consumes: U5's `voice.drag` prop; W2's `dropVerdict`, `canDrag`; W4a's `useVoiceMod`.

- [ ] **Step 1: Write the failing tests** (§11 W7, plus Review Focus 2)

```ts
// a valid drop calls voiceMove; this device's own row switches through onJoinVoice; an AFK drop announces
//   t('voice.mod.drag.afk', { channel: afkName }); Escape announces "Move cancelled."; no voice.drag on a phone
it('a rights change during a drag is judged at the drop', async () => {
  startDrag('björn'); revokeMoveMembers(); dropOn('general');
  expect(client.calls('voiceMove')).toHaveLength(0);
  expect(announced()).toContain('That isn’t allowed any more: roles or channel permissions changed.');
});
```

- [ ] **Step 2: Run them to verify they fail**: `npm test -w @dilla/web -- src/screens/Shell.personMenu.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement** §U.6.4: `canDrop` and `onRefuse` both call `dropVerdict` with inputs built from the current slices at the moment of the call.

- [ ] **Step 4: Run them to verify they pass**: the same command, `npm run typecheck -w @dilla/web`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/screens
git commit -s -m "feat(web): drag to move in the channel list"
```

---

## Wave 7

### Task W6: Call behaviour — lane web, opus, review opus

**Files:**
- Modify: `packages/web/src/screens/voice/useCall.tsx`, `screens/voice/VoiceView.tsx`, `packages/web/src/call/session.ts`, `call/volume.ts`, `screens/Shell.tsx` (held props), `call/session.test.ts`, `call/volume.test.ts`
- Create: `packages/web/src/screens/voice/useCall.mod.test.tsx`, `screens/voice/VoiceView.mod.test.tsx`

**Interfaces:**
- Consumes: T1, T3, T6 (`call.move`, `serverMuted`, `serverDeafened`, `pendingReason` 3 and 4), M1 (`setServerDeafened`), U4 (`held`).
- Produces: `PageCall.releaseContext(): AudioContext | null`; `PageCall.applyServerVoice(mod: { muted: boolean; deafened: boolean }): void`; `PageCall.setLocalMute(userId: string, on: boolean): void`; `PageCallOptions.localMutes: ReadonlySet<string>`, `PageCallOptions.serverVoice?: { muted: boolean; deafened: boolean }`; `gainOf(userId, volumes, s, localMuted = false)`; `localMutesFromSettings(settings): ReadonlySet<string>`.

- [ ] **Step 1: Check the null-context state first**

Write `it('a session started with audioContext null reports audioBlocked true once connected, and startAudio clears it')` in `call/session.test.ts` and run `npm test -w @dilla/web -- src/call/session.test.ts`. If it fails, make it true in `session.ts` before anything else; if it passes, keep the test.

- [ ] **Step 2: Write the failing tests**

```ts
// session.test.ts: releaseContext returns a running context and the following leave('switch') does not close it;
//   closes a suspended one and returns null; a second call returns null; a server mute unpublishes the mic and screen audio
//   and keeps the own mute; a permission-refused publish while serverMuted is not a call error; applyServerVoice deafened → setServerDeafened(true)
// volume.test.ts: gainOf(u, volumes, s, true) === 0 for voice; the stream gain is unchanged
// useCall.mod.test.tsx: a new move.seq switches to move.to and shows "Moved to general"; the same seq twice switches once;
//   a running context is passed on (createCallContext not called); a suspended one → null and the voice.audioStart press;
//   a refused target join shows voice.mod.moveFailed; reason 4 "Disconnected by a moderator", reason 3 voice.mod.moveMissed,
//   reason 2 still afk.elsewhere; serverMuted holds the mute control and a press announces voice.mod.youMuted
```

- [ ] **Step 3: Run them to verify they fail**: `npm test -w @dilla/web -- src/call src/screens/voice`. Expected: FAIL.

- [ ] **Step 4: Implement** §U.8.6 (`releaseContext`), §U.8.1, §U.8.2 (`cutReason` 1|2|3|4, explicit `cut.reason === 2`, recovery verdicts `'moveMissed'`, `'modDisconnected'`), §U.8.4, §C.8, §C.10 (web half), §U.7.5 (`toggleMute` and `toggleDeafen` check `held` first).

- [ ] **Step 5: Run them to verify they pass**: `npm test -w @dilla/web && npm run typecheck -w @dilla/web && npm run lint`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src
git commit -s -m "feat(web): follow a move with the old audio context; moderator states in the call"
```

---

## Wave 8

### Task E1: Web e2e — lane web, sonnet, review sonnet

**Files:**
- Create: `e2e/web/person-menu.spec.ts`, `e2e/web/context-menus.spec.ts`, `e2e/web/phone-menu.spec.ts`
- Modify: `e2e/playwright.web.config.ts` (add `person-menu`, `context-menus`, `phone-menu` to the webkit `testMatch`)

**Interfaces:**
- Consumes: the built app (`npm run build -w @dilla/web`).

- [ ] **Step 1: Write the specs** as §U.10.3 (web suite), plus Review Focus 3 and 4:

```ts
// phone-menu.spec.ts, at 360×640 isMobile hasTouch:
expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);   // sheet and its move to page
for (const b of await page.locator('.d-menu-sheet__item, .d-menu-sheet__back, .d-menu-sheet__close').all())
  expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
// person-menu.spec.ts, every browser: after Shift+F10 and again after the ContextMenu key on björn's row,
//   exactly one role="menu" is open and the page listener saw the following contextmenu with defaultPrevented true
```

- [ ] **Step 2: Run them** (the features landed in W4b and W5; these specs pin them end to end)

Run: `flock /home/thim/.cache/dilla-w3/e2e.lock env DILLA_TESTKIT=/home/thim/.cache/dilla-w3/i37e2e-target/release/dilla-testkit npx playwright test -c e2e/playwright.web.config.ts person-menu context-menus phone-menu`
Expected: PASS on chromium, firefox and webkit.

- [ ] **Step 3: Gates**: `npm run typecheck:e2e`. Expected: ok.

- [ ] **Step 4: Commit**

```bash
git add e2e/web e2e/playwright.web.config.ts
git commit -s -m "test(e2e): person, context and phone menus on three browsers"
```

### Task E2: Voice e2e and the hooked build — lane web ∥, sonnet, review opus

**Files:**
- Create: `e2e/voice/voice-moderation.spec.ts`, `packages/web/scripts/check-no-e2e-hooks.mjs`
- Modify: `e2e/playwright.voice.config.ts` (`testIgnore` unless `DILLA_VOICEMOD_E2E=1`), `packages/web/vite.config.ts` (define `__DILLA_E2E_HOOKS__`), `packages/web/package.json` (`build:e2e-hooks`), `.github/workflows/ci.yml`, `.github/workflows/release.yml`

**Interfaces:**
- Consumes: M1's hook reader; the artifact layout of §C.11 (`dilla-web-dist` hook-free, `dilla-web-dist-e2e-hooks` separate, job `voice-moderation-e2e`).

- [ ] **Step 1: Write the hook check and its test first**

`check-no-e2e-hooks.mjs <dir>`: exit 1 when any file under `<dir>` contains `__dillaE2E`, else 0. Run `npm run build -w @dilla/web && node packages/web/scripts/check-no-e2e-hooks.mjs packages/web/dist` (expected exit 0) and `npm run build:e2e-hooks -w @dilla/web && node packages/web/scripts/check-no-e2e-hooks.mjs packages/web/dist-e2e-hooks` (expected exit 1).

- [ ] **Step 2: Write the spec** as §U.10.3 (voice suite): `Person` pages from `peerBrowser.open`, mira's init script, the per-case mute steps, nine cases.

- [ ] **Step 3: Run it on the hooked build**

Run: `npm run build:e2e-hooks -w @dilla/web && rm -rf packages/web/dist && cp -r packages/web/dist-e2e-hooks packages/web/dist && flock /home/thim/.cache/dilla-w3/e2e.lock env DILLA_VOICEMOD_E2E=1 DILLA_TESTKIT=/home/thim/.cache/dilla-w3/i37e2e-target/release/dilla-testkit npx playwright test -c e2e/playwright.voice.config.ts voice-moderation`
Expected: PASS on chromium-voice and firefox-voice. Then rebuild the hook-free `dist`.

- [ ] **Step 4: Run the existing voice suite without the flag**: the same command without `DILLA_VOICEMOD_E2E=1` on the hook-free build. Expected: `voice-moderation.spec.ts` is not run; the rest PASS.

- [ ] **Step 5: Gates**: `npm run typecheck:e2e && npm run check:ci`. Expected: ok.

- [ ] **Step 6: Commit**

```bash
git add e2e packages/web/scripts/check-no-e2e-hooks.mjs packages/web/vite.config.ts packages/web/package.json .github/workflows
git commit -s -m "test(e2e): voice moderation enforced by the SFU, on a separate hooked build"
```

---

## Wave 9

### Task D1: User docs and README — lane web ∥, haiku, review sonnet

**Files:**
- Modify: `docs/user/voice.md`, `docs/user/getting-started.md`, `README.md` ("what works")

- [ ] **Step 1: Write** the three user-doc lines of §U.9.7 verbatim into `docs/user/voice.md`, a section on moderating voice (server mute, deafen, move, disconnect, who may) and on right-click, Shift+F10 and long-press in `getting-started.md`, and README "what works" lines for both.
- [ ] **Step 2: Check**: `npm run check:docs`. Expected: ok.
- [ ] **Step 3: Commit**

```bash
git add docs/user README.md
git commit -s -m "docs(user): voice moderation and the right-click menu"
```

### Task D2: Screenshots and release notes — lane web ∥, sonnet, review sonnet

**Files:**
- Modify: `e2e/scripts/shoot-docs.mjs` (a `VOICEMOD_SHOTS` block after 4d), `docs/user/screenshots/*`
- Create: `docs/deploy/releases/<next-release>.md` (version filled at release time, modelled on `v0.1.0-web3.9.2.md`)

- [ ] **Step 1: Add the shots** of §U.10.4 (eight new, five re-shot) and run the shoot under the e2e lock with `DILLA_TESTKIT` as in Global Constraints. Expected: the files exist; review them by eye.
- [ ] **Step 2: Write the release notes**: every operator-visible change; schema bump (migration 00024 adds `member_voice_moderation`) and rollback (`migrate down` drops it and every stored server mute and deafen); every new copy string of §U.9.3–§U.9.6 quoted with its key.
- [ ] **Step 3: Check** the notes against §U.9.3–§U.9.6 key by key (81 keys and the four `perm.*` lines) and run `npm run check:docs`. Expected: ok.
- [ ] **Step 4: Commit**

```bash
git add e2e/scripts/shoot-docs.mjs docs/user/screenshots docs/deploy/releases
git commit -s -m "docs: voice moderation screenshots and release notes"
```
