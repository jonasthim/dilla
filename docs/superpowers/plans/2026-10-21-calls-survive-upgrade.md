# Calls survive an upgrade: plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** an upgrade of dillad no longer ends people's calls.

**Context:** the homelab upgrade to web3.11 dropped every call, and the clients did not come back on their own. Jonas's decision is binding: **decouple the SFU restart.**
- `install.sh --upgrade` restarts the API (`dilla`) at once.
- `dilla-media` keeps running the old binary until `dillad media --rooms` is empty, or until the operator passes `--restart-sfu`.
- Each release states in machine-readable metadata whether the running SFU can stay. The installer reads that metadata and does not guess.
- CI proves that the previous release's SFU works with the new API (wire 2).

Release: **v0.1.0-web3.12**. It comes after fix/late-rejoin, which lands separately and also writes the web3.12 notes stub. File:line references are against `main` at 18808c0f (web3.11).

## Verified on web3.11 (the investigation's claims, checked in code)
- **(1) A lost room self-Removes, and the rejoin can deadlock. Confirmed.**
  - `onRoomEnd` (`packages/web/src/call/session.ts:1363-1367`) calls `leave('lost')`.
  - In the worker, `leave` (`client-core/src/calls/controller.ts:528`) runs `leaveLive` (`:551`) and then `leaveGroup` (`:592`). `leaveGroup` posts `callLeaveProposal` and forgets the group.
  - The rejoin is an external join (`join.ts:75`, `joinExisting` `:171`). While this device's Remove stands, the resync guard (`internal/ds/resync.go:111-133`) answers 409 `E_REMOVE_PENDING`. The join then waits `REJOIN_WAIT_MS` = 30 s (`join.ts:30-42`, `:148-165`) and gives up.
  - When everyone is lost at once, each device still sees the others in its roster, so nobody takes the "alone" end and nobody commits the Removes.
  - The `room_finished` webhook (`callevents.go:263-271`) would end the call and free everyone. It is lost when the API is down while the SFU closes its rooms, which is exactly what happens during an upgrade.
- **(2) A pending cut answers 403. Confirmed, and it is wider than reported.**
  - `evictDevices` (`internal/api/callevents.go:1100-1125`) marks the cut pending while the SFU cannot take it.
  - The start refuses with 403 `E_FORBIDDEN` "being revoked" (`calls.go:606-608`). So does the `/rtc` gate (`calls.go:1208-1210`).
  - `useCall.tsx:651-656` treats `E_FORBIDDEN` as permanent.
  - Also: while the SFU is down, the start's `CreateRoom` fails with **500 `E_INTERNAL`** (`calls.go:597-601`).
- **(3) The update reload leaves the call, and the restore window runs from the reload. Confirmed.**
  - `Shell.tsx:1637-1657` saves the checkpoint, calls `session.leave('user')` (a self-Remove), then reloads.
  - `restore()` (`useCall.tsx:825-840`) sets `RESTORE_WAIT_MS` = 120 s (`:220-222`) from the moment it is called.
  - The recovery effect enforces that window (`:1084-1086`) and retries every 1 s (`:1098`), even while the instance is down.
- **(4) The SFU restarts twice. Confirmed.**
  - `write_media_unit` writes `PartOf=dilla.service` (`deploy/install.sh:490`; also `deploy/dilla-media.service:6`).
  - `systemctl restart dilla` (`:697`) therefore restarts `dilla-media`, and `:732` restarts it a second time.
- **Also found:**
  - **F1.** Share leases, pending repairs and F11 strikes live in memory (`internal/api/callshare.go:19-24`). The comment's premise, "the SFU is in-process: a restart drops every call", is false in sidecar mode. After an API-only restart, a camera or screen publisher that is still in the SFU holds no slot. Pending cuts are recovered: `reconcile` cuts any participant that has no current leaf (`callgrants.go:297-306`), and the room sweep runs it.
  - **F2.** The TURN relay runs in the API process (`cmd/dillad/front.go:500`). A relayed client loses media on every API restart until ICE restarts.
  - **F3.** `/rtc` is proxied by the API (`internal/dillad/routes.go:255-275`), so every API restart drops the LiveKit signalling WebSocket.
    - The gate admits a resume (`admitRTC`, `:300-335`).
    - livekit-client's default reconnect policy gives up after about 45 s, and `packages/media/src/connect.ts` sets none.
  - **F4.** The E2EE bound that exists today: the room sweep Removes a call-group leaf whose device has been absent from the room for at least `RoomSweepInterval` (30 s, `calls.go:101`) and was not admitted within `admissionJoinWindow` (30 s, `callmembers.go:27`, `trackAbsentLocked` `:224-280`).
  - **F5.** web3.11's `live_calls_preflight` (`install.sh:627-656`) refuses an upgrade while a call is live, unless `--yes`.

## E2EE evaluation of fix (a): keep the leaf
- **What it changes.** A device that lost its room, or that is reloading for an update, does not post its self-Remove. It keeps its leaf and the current epoch's secrets, which it already holds. Nothing new is derived for it, and no epoch is opened to it.
- **Is that acceptable for the call's lifetime? It never lasts that long.** The server's room sweep (F4) stays the only authority. It removes an absent leaf about 30 to 60 s after the SFU stops seeing the device.
  - (a) adds **no** server-side grace. The client's hold never extends the server's tolerance, so the bound is the one a crashed tab already gets today.
  - While the SFU or the API is down the sweep cannot run, so the bound becomes the downtime plus about 60 s.
  - In that window, no media reaches a device that has no SFU connection. Getting a connection needs a token, and a token needs a current leaf. A device that has one is the same device rejoining legitimately.
- **The device never comes back.** The sweep proposes its Remove and the next commit rotates the epoch. The device's stored group state stays on its disk until its next boot sweep forgets it, as for a closed tab today.
- **The device comes back after the sweep removed it.** The resume finds the leaf is no longer current (`E_LEAF_NOT_CURRENT`, or the group's member row shows it removed). The device forgets the group and does an ordinary external join. Nothing is held on to.
- **Where the self-Remove stays:**
  - a person's own leave;
  - a blocked leave;
  - giving up on a recovery (late-rejoin `leftAway`, or the window ending);
  - the boot sweep of any group that the checkpoint does not name, or whose hold has expired.
  - `e2e/voice/reload.spec.ts` (a plain reload's sweep) must stay green unchanged.
- **Verdict: acceptable.** The worst case is the same as a crashed tab today, and a returning device needs no extra epoch. Record the rule in `protocol/01-groups.md` (call groups) and `protocol/08-threat-model.md`.

## Binding rulings (R-UP*)
- **R-UP1 The SFU's level, not a per-release flag.**
  - `internal/sfu` gains two constants:
    - `MediaLevel`, bumped whenever the API↔SFU contract changes: the livekit-server version, `ClientProtocol`, the sfu config, the RoomService calls or the webhook use;
    - `MinSFUMediaLevel`, the oldest SFU level this API works with.
  - A running SFU at level L can stay if and only if L ≥ the new `MinSFUMediaLevel`. A release that skips others is decided correctly this way.
  - A guard test pins the inputs that make up the contract, so a change to them without a bump fails.
- **R-UP2 `release.json` is the metadata.**
  - It is a release asset, listed in SHA256SUMS and generated by release.yml from the built binary's `dillad version --json`. Nobody writes it by hand.
  - Shape: `{"format":1,"tag":"v0.1.0-web3.12","version":"0.1.0-web3.12","wire":[2],"schema":21,"media_level":1,"min_sfu_media_level":1,"sfu_restart":"when-idle"}`.
  - `sfu_restart` is `"when-idle"` or `"required"`. It is informative: it describes the step from the previous release. The installer decides by level.
- **R-UP3 What the installer does:**
  - **The running SFU is compatible:**
    - restart `dilla` only;
    - no live-call refusal;
    - report "dilla-media keeps vX until its calls end".
  - **It is not compatible, or the operator passed `--restart-sfu`:**
    - web3.11's preflight (refuse while calls are live, unless `--restart-sfu`; `--yes` is still accepted as an alias for one release);
    - then restart `dilla` and `dilla-media` once each.
  - **The running SFU's level comes from:**
    - `/var/lib/dillad/media.json` (written by a web3.12+ SFU at start: `{version, media_level, pid, started}`);
    - with no file, from the installed binary: v0.1.0-web3.11 counts as level 1, the baseline CI proves; anything older needs a restart.
  - **Refusals and fallbacks:**
    - a `release.json` that is missing from SHA256SUMS, or that disagrees with the new binary's `version --json`, is refused;
    - a release without `release.json` (downgrading to an older release) is treated as restart required.
- **R-UP4 The pending restart is a root timer.**
  - `dilla-media-refresh.timer` runs every minute and is enabled by the installer.
  - Its oneshot service restarts `dilla-media` only when both hold:
    - the running SFU's executable inode differs from `/usr/local/bin/dillad` (`stat -L /proc/$MAINPID/exe`);
    - `dillad media --idle`, run as dillad, exits 0. That means no room has participants and no room is younger than 60 s, so a start in flight counts as busy.
  - This works for a web3.11 SFU too, which knows nothing of the scheme. Each restart is logged to the journal.
- **R-UP5 No PartOf.**
  - `dilla-media.service` drops `PartOf=dilla.service`.
  - `dilla.service` keeps `Wants=`/`After=dilla-media.service`, for start order only.
  - After `daemon-reload`, restarting `dilla` never touches the SFU.
- **R-UP6 A held call (fix a).**
  - A room lost with `E_DISCONNECTED`, or an update reload, holds the call group. There is no self-Remove and no forget.
  - The next join of the same channel resumes it if the instance still names that group and the leaf is current:
    - catch up on the group's commits;
    - get the media epoch;
    - `startCall` re-mints the token, through the `requireCurrentLeaf` path (`calls.go:944`).
  - Otherwise the device forgets the group and does an external join.
  - Abandoning a hold runs `leaveLive`, which includes the self-Remove.
  - For a reload, the hold is persisted as a worker-store marker `callKeep {groupId, channelId, until}`. The boot sweep spares that group until `until`.
- **R-UP7 A pending cut is transient (fix b).**
  - These answer **503 `E_UNAVAILABLE` with `retry_after_ms`** instead of 403 or 500:
    - `isPending` at the start (`:606`);
    - `isPending` at the `/rtc` gate (`:1208`);
    - an SFU failure at `CreateRoom` or at token mint (`:597-601`).
  - It is still a refusal, so the gate's security property holds. Once the repair lands, every other check runs again, and a barred device still gets its 403.
- **R-UP8 Windows count instance time (fix c).**
  - The restore window `RESTORE_WAIT_MS` runs only while the instance answers. It starts when the worker's gateway is next ready, and pauses while the instance is unreachable.
  - While the instance is unreachable, attempts back off 1, 2, 4 … 30 s.
  - The instance answering again triggers an attempt at once and resets the backoff.
  - An `E_UNAVAILABLE` attempt waits at least `retry_after_ms`.
- **R-UP9 One absence clock (consistency with late-rejoin).**
  - An upgrade restart is not an absence of the person. The late-rejoin `goneSince` does not count time while the instance itself was unreachable: if the loss falls inside an outage of the instance, or within 5 s before it, `goneSince` moves to the moment the instance answered again.
  - A suspend that late-rejoin detects still counts, from its start.
  - A restore records no absence, as late-rejoin already rules.
  - An absence longer than the community's AFK timeout still never auto-rejoins.
- **R-UP10 One SFU restart (fix d).** It follows from R-UP3 and R-UP5. `install_test.sh` asserts the number of restarts.

## Tasks

### Task UP1 (sonnet): SFU level, `version --json`, `media --idle`, `media.json`, doctor
- **Files:**
  - `internal/sfu/level.go` (new): `MediaLevel = 1`, `MinSFUMediaLevel = 1`;
  - `internal/sfu/level_test.go`: a golden file `testdata/media-level.json` holding:
    - the livekit-server module version from `go.mod`;
    - `ClientProtocol`;
    - the SHA-256 of `testdata/livekit-signal-schema.json`;
    - the level.
    The test fails with "bump MediaLevel" when an input changes without the level.
  - `cmd/dillad/version.go`: `--json` prints `{version, revision, wire:[2], schema, media_level, min_sfu_media_level}`;
  - `cmd/dillad/media.go`:
    - `--idle` (exclusive with `--probe` and `--rooms`): exit 0 when idle, 1 when busy (rooms are listed on stderr), 69 when it cannot tell. A room counts as busy while it has participants or is younger than 60 s (`Room.CreationTime`).
    - `serveMedia` writes `media.json` (0600, atomically, in `StateDirectory`) at start, and removes it on a clean stop.
  - `cmd/dillad/doctor.go`: a new leg, `media_binary`, read from `media.json`:
    - green when the SFU runs this version;
    - yellow when it runs an older one, or when there is no file: "dilla-media runs vX (older); it restarts onto this binary when its calls end (dilla-media-refresh.timer)";
    - red when its level is below `MinSFUMediaLevel`.
- **Tests:**
  - `--idle` with:
    - an empty SFU;
    - a room with 0 participants created 10 s ago (busy);
    - a room with 0 participants created 2 min ago (idle);
    - an unreachable SFU (69);
  - `media.json` written and removed;
  - `version --json` matches its golden output;
  - the doctor leg's three colours;
  - the level guard is red when an input is mutated.
- **Gates:** `go test ./cmd/dillad/... ./internal/sfu/...`; golangci-lint.

### Task UP2 (opus): server, calls that survive an API restart
- **Files:** `internal/api/calls.go`, `callshare.go`, `callgrants.go`, `callevents.go`, `protocol/09-http-api.md`.
- **R-UP7:**
  - `server.Unavailable(2_000, "your device's access to this call is being settled")` at `calls.go:606` and `:1208`;
  - `server.Unavailable(2_000, "the media server is not answering")` for a failed `CreateRoom` or token mint (`:597-601`, `:618-622`).
- **F1, adopting slots:**
  - The first whole-room reconcile of a live call whose lease map is empty after boot adopts a slot for each participant that publishes CAMERA or SCREEN_SHARE, oldest publication first, up to `livekit.max_publishers`. Only the excess is demoted.
  - Fix the comment at `callshare.go:23`.
- **Boot:**
  - Nothing at start ends a live call whose room the SFU still holds.
  - Add a test that pins this, so a future change cannot make the boot reap such calls.
- **Tests (`-race`):**
  - a pending cut answers 503 with `retry_after_ms`, and after the repair lands, a barred device gets 403;
  - an SFU down at start answers 503;
  - API restart with a live camera publisher: the camera is still allowed after the first sweep;
  - API restart with a live room: the call row, the group and the participants are untouched, and no Remove is proposed for a participant the SFU still holds;
  - a webhook lost during the restart (`participant_left`) is recovered by the room sweep within one interval.
- **Gates:** `go test -race ./internal/api/... ./internal/dillad/...`; `check:docs` (the 503 rows in protocol/09).

### Task UP3 (opus): installer and units
- **Files:**
  - `deploy/dilla-media.service`: drop `PartOf`; add `RestartForceExitStatus=` only if UP1 needs it (it does not: the timer restarts the SFU);
  - `deploy/dilla-media-refresh.service` and `deploy/dilla-media-refresh.timer` (new, R-UP4);
  - `deploy/install.sh`:
    - `write_media_unit` (`:483-522`) and new writers for the timer units;
    - the download and verify block (`:425-470`): fetch `release.json` and check it against SHA256SUMS;
    - the `--release-json FILE` flag for `--binary` mode;
    - the `--restart-sfu` flag;
    - the upgrade block (`:658-738`);
    - `live_calls_preflight` (`:627-656`, and the comment at `:633`);
    - the rollback text (`:596-622`);
  - `deploy/install_test.sh`, `deploy/deploy_test.go`, `deploy/proxmox-lxc.sh` (if it writes units).
- **Upgrade flow:**
  1. Verify the binary, the core and `release.json`. Cross-check `release.json` against `"$WORK/dillad" version --json`.
  2. Read the running SFU's level (R-UP3), then decide between keep and restart.
  3. On restart only: the preflight.
  4. Keep the `.prev` copies, put the new files in place, write the units, `daemon-reload`, and enable `dilla-media-refresh.timer`.
  5. `systemctl restart dilla`. On failure, run today's rollback. It touches `dilla-media` only if this run restarted it.
  6. On restart only: `systemctl restart dilla-media` and `media --probe`.
  7. Doctor, and report which binary the SFU runs.
- **First install:** write and enable the timer too.
- **The in_process → sidecar migration** keeps today's path. It ends calls, and it is the one case that still needs `--yes`.
- **Tests** (stub `systemctl`, `runuser` and `dillad`):
  - compatible upgrade with live rooms: `dilla` is restarted once, `dilla-media` never, and the upgrade is not refused;
  - incompatible upgrade with live rooms: refused, nothing changed; with `--restart-sfu`: one restart each;
  - `--restart-sfu` on a compatible release;
  - a web3.11 SFU (no `media.json`, installed `v0.1.0-web3.11`) counts as level 1, and an older one needs a restart;
  - `release.json`:
    - missing from SHA256SUMS: refused;
    - disagrees with the binary: refused;
    - absent from the release: restart required;
  - the API restart fails: rollback, and the SFU is untouched;
  - the units have no `PartOf`, and the timer is enabled;
  - the refresh service:
    - same inode: no restart;
    - different inode, busy: no restart;
    - different inode, idle: one restart;
    - `--idle` exits 69: no restart.
- **Gates:** `sh deploy/install_test.sh`; `go test ./deploy/...`; shellcheck.

### Task UP4 (sonnet): release metadata and CI compatibility
- **Files:**
  - `.github/workflows/release.yml`, the assets step (`:202-227`):
    - write `release.json` from `./dillad-linux-amd64 version --json` plus the tag, with `sfu_restart` computed against the previous release's `release.json` (no previous file: `"required"`);
    - add it to SHA256SUMS and to the uploaded assets; the asset count goes from 4 to 5;
    - add a needs-gate on `sfu-compat`.
  - `.github/workflows/ci.yml`, the job `sfu-compat`:
    - download the latest release's `dillad-linux-amd64`, SHA256SUMS and `release.json` with `gh release download`, and verify the sums;
    - run e2e `voice/upgrade.spec.ts --grep compat` with the test host's sidecar SFU taken from that binary (UP5).
    - Skip it, with a notice, when the new `min_sfu_media_level` is above the previous `media_level`: an incompatible release is announced, and the job then only asserts the notes say "required".
  - `scripts/check-release-meta.mjs` (part of `check:ci`): the notes file's Versions row "Media server (SFU)" must agree with the computed `sfu_restart`.
- **Gates:** actionlint; `npm run check:ci`; a dry run of the asset step on a local build.

### Task UP5 (sonnet): test host sidecar mode
- **Files:** `cmd/dilla-testhost` (flags), `e2e/web/support/host.ts:8-30`, `:95-101`.
- **`-sfu-sidecar`:** the host uses `sfu.NewRemote` against an SFU it does not own. That SFU is started separately by `startMediaHost({bin, port, udpPort, webhookURL})`, which runs `dillad media` with a generated `dilla.toml`.
  - `bin` defaults to the tree's `dillad`; `DILLA_SFU_BIN` overrides it (UP4 compat).
- **The API restarts on its own:** `host.stop()` and `startTestHost` with `keepData` restart only the API.
- **`restartMedia()`** restarts the SFU process.
- **`-web-root` swap** serves a copy of `packages/web/dist` with a changed `app-version.json`, so the page sees a new build.
- **Tests:** `host.ts` unit tests for the argument shapes; a smoke spec that starts and stops both processes.
- **Gates:** `go test ./cmd/dilla-testhost/...`; the e2e typecheck.

### Task UP6 (opus): client-core held call (R-UP6, E2EE)
- **Files:** `packages/client-core/src/calls/controller.ts` (`:528-600`), `join.ts` (`:75-170`), `sweep.ts` (`:31-60`), `worker/controller.ts`, `worker/protocol.ts`, `protocol/01-groups.md`, `protocol/08-threat-model.md`.
- **Controller:**
  - `leave(blocked, lost)` gains a mode, `hold`. For `lost` with `E_DISCONNECTED` it:
    - keeps `live.groupId` and the core state;
    - posts nothing;
    - stops rotation;
    - sets phase `removed` with `E_DISCONNECTED` as today;
    - records `held = {groupId, channelId, until: now + HOLD_MS}`, where `HOLD_MS` = `RESTORE_WAIT_MS` + 60 s.
  - New command `callHold {channelId}`, for the update reload. It does the same and also persists `callKeep` in the worker store.
  - New command `callRelease`. It, a hold that expires, a sign-out and a handover all run `leaveGroup` (the self-Remove and the forget) on the held group.
- **Join:**
  - `joinCall` first checks the hold or `callKeep` for `t.channelId`.
  - If `read.groupId` equals the held group, catch up on the group lane, then `mediaEpoch` and `startCall`.
  - On `E_LEAF_NOT_CURRENT`, a removed member row, `E_NOT_FOUND` for the group, or a different `read.groupId`: forget (no Remove: the leaf is already gone, or the group is closed), then run `joinLoop` as today.
- **Sweep:** `sweepStaleCalls` skips the group named in a `callKeep` whose `until` has not passed, and deletes expired markers.
- **Tests:**
  - lost: no `postProposal`, no forget;
  - rejoin within the hold: no external commit (`postGroup`, external join), the same epoch key, and `startCall` called;
  - the server removed the leaf: forget, then an external join;
  - the group closed: a fresh group;
  - `callRelease` and expiry: exactly one self-Remove;
  - a blocked leave and a user leave: a self-Remove as today;
  - the boot sweep spares the kept group and sweeps an expired or unnamed one (`sweep.test.ts`);
  - sign-out drops the hold with a self-Remove.
- **Gates:** client-core vitest and typecheck; the wasm-pack build; `check:docs`.

### Task UP7 (opus): web call lifecycle (R-UP7 to R-UP9)
- **Files:** `packages/web/src/call/session.ts` (`:1363-1367`, `:1426`), `screens/voice/useCall.tsx`, `screens/Shell.tsx` (`:1637-1657`), `packages/media/src/connect.ts` (`:41`, `:100`, `:226`).
- **Session:** `onRoomEnd` with `E_DISCONNECTED` ends the page session and asks the worker to hold, not `leave('lost')`. Every other end code is unchanged.
- **The update path:** Shell posts `callHold` instead of `session.leave('user')`, then reloads.
  - If Jonas picks Q1 = defer, see UP8. This path then stays for `reload: "required"`.
- **useCall:**
  - `E_UNAVAILABLE` is transient: the next attempt waits at least `retry_after_ms`.
  - The restore window follows R-UP8 and counts only while the worker reports the instance online. The `online` slice already exists; reuse it.
  - The instance answering again triggers an immediate attempt.
  - `endRecovery` and a person's leave post `callRelease`.
  - R-UP9, if fix/late-rejoin has merged; otherwise leave a `TODO(late-rejoin)` test that is skipped with a reason, and the reviewer checks it at merge.
- **LiveKit:**
  - Set `reconnectPolicy` so the signalling resume keeps trying for 90 s, with a delay capped at 5 s.
  - First measure how long livekit-server v1.13.7 holds a participant whose signalling dropped while its media flows. Record the number in the code comment. If that is shorter than 90 s, raise it in the media config (`internal/sfu/config.go`).
- **Tests (`useCall.test.tsx`, `session.test.ts`):**
  - a lost room holds: the worker gets `callHold`, not `callLeave`;
  - `E_UNAVAILABLE` waits for `retry_after_ms`;
  - the restore window does not run while offline, and an attempt follows at once on `online`;
  - backoff while offline;
  - a lost room inside an instance outage does not count toward the late-rejoin absence, and a suspend still does;
  - abandoning the recovery posts `callRelease`;
  - the update path posts `callHold`.
- **Gates:** web vitest and typecheck; lint; e2e `voice/reload.spec.ts` and `web/afk.spec.ts` on chromium.

### Task UP8 (sonnet, only if Q1 = defer): the update waits for the call
- **Files:** `Shell.tsx:1630-1660`, `update.ts`, `en.ts`, flow 06, `packages/web` build (`app-version.json` gains `reload: "deferrable" | "required"`; `"required"` when wire, ABI or store changes).
- **In a call with `"deferrable"`:** no reload. The call panel shows the quiet line "Update ready — it applies when you leave the call" (`update.afterCall`). The reload runs on leave.
- **With `"required"`:** the UP7 path (hold, reload, resume).
- **Tests:** in a call, deferrable: no reload, the line shows, and the reload follows the leave; required: an immediate hold and reload; the string test.
- **Gates:** web vitest; `check:copy`; storybook test for the panel.

### Task UP9 (sonnet): acceptance e2e, `e2e/voice/upgrade.spec.ts`
- **Setup:** UP5 sidecar host; three peers (the `peer-browser` support) in one community voice channel, all heard by each other.
- **A, full restart:**
  - stop the API, restart the SFU, start the API with a new web build;
  - no input from anyone;
  - all three show `connected` in the same channel, and each hears the other two, within **90 s** of the API answering.
- **B, compatible release:**
  - restart the API only, with a new build;
  - for each peer, all of these hold:
    - the LiveKit participant sid is unchanged;
    - `phase` never reaches `removed`;
    - inbound audio frames keep increasing, with no gap over 1 s;
    - no new MLS epoch.
  - Without UP8 (Q1 = reload now), B serves the same build and a separate case C covers the reload resume: no external commit, with a bound.
- **compat:** B with `DILLA_SFU_BIN` set to the previous release's binary. CI's UP4 job runs it.
- **Gates:** the spec passes three times in a row on chromium; firefox once.

### Task UP10 (haiku): docs
- **`docs/deploy/README.md`:**
  - the intro (`:1-10`) and the mermaid diagram (`:13-30`): the SFU is no longer restarted with the API;
  - §3 systemd (`:300-330`): no `PartOf`, the refresh timer, `media --idle`;
  - the install script upgrade section (`:431-497`): `--restart-sfu`, `release.json`, how the keep-or-restart decision is reported, rollback by hand (stop **both** units; the SFU restarts onto the restored binary when idle; `systemctl disable --now dilla-media-refresh.timer` before going below web3.12).
- **`docs/deploy/releases/v0.1.0-web3.12.md`** (append to late-rejoin's stub):
  - a new Versions row, **"Media server (SFU) | when-idle (level 1, keeps web3.11's) | …"**;
  - the operator notes below;
  - correct web3.11's PartOf-based rollback wording.
- **README:** in the operator part, "Upgrades keep calls (web3.12)". In the client part, if UP8: "an update waits until you leave the call".
- **`docs/user/voice.md`:** a troubleshooting row and a "During a server upgrade" line (calls continue; at most a short "reconnecting"; and the UP8 line if built).
- **Gate:** `check:docs`, `check:copy`.

**Order:** UP1 → UP2 ∥ UP3 ∥ UP5 → UP4 → UP6 → UP7 (→ UP8) → UP9 → UP10. UP3 needs UP1's `--idle` and `version --json`. UP4 needs UP5 and UP9's spec name, so wire UP4's job last if needed.

## Edge cases
- **A start in flight while the timer restarts the SFU.** A room under 60 s old counts as busy. The few milliseconds left between the check and the restart give a start a 503 followed by a retry (R-UP7, R-UP8).
- **The upgrade happens while a client is mid-reload.** Its `callKeep` outlives the outage, because the window counts instance time.
- **A rollback after a compatible upgrade.** The SFU still runs the old binary. The restored `dillad` has a new inode, so the timer restarts the SFU once, when idle, onto identical code. That is harmless and documented.
- **A rollback below web3.12.** The old `install.sh` writes `PartOf` back and does not know the timer. The docs say to disable the timer.
- **An SFU crash during a compatible upgrade.** systemd restarts it on the new binary (`Restart=on-failure`). Calls recover through R-UP6; the call ended, so they join a fresh group.
- **Two tabs.** The hold lives in the tab's worker. `E_CALL_IN_OTHER_TAB` rules are unchanged.
- **A DM call.** It is held the same way. Late-rejoin does not apply to DM calls.

## Release (v0.1.0-web3.12): operator-visible changes
- **`install.sh --upgrade` restarts only the API** when the running media server is compatible. Live calls continue: at most a short "reconnecting", and for relayed (TURN) clients a brief media gap (F2). There is no live-call refusal and `--yes` is not needed.
- **`dilla-media` keeps the previous binary** until its calls end. `dilla-media-refresh.timer` then restarts it onto the new one. `dillad doctor` shows "dilla-media runs vX (older)" until then.
- **`--restart-sfu`** restarts the media server now and ends live calls. `--yes` is kept as an alias for one release.
- **New release asset `release.json`**, listed in SHA256SUMS. The installer refuses a mismatch. `--binary` mode takes `--release-json FILE`.
- **Units:** `dilla-media.service` loses `PartOf`, so `systemctl stop dilla` no longer stops the media server. There are two new units, `dilla-media-refresh.{service,timer}`.
- **New commands:** `dillad media --idle` and `dillad version --json`.
- **Unchanged:** schema 21 (no migration), wire 2, client store 5, ABI.
- **Known limits:**
  - TURN relays restart with the API;
  - a release that raises `min_sfu_media_level` still ends calls (the installer says so first).

## Review Focus
- **E2EE (UP6):**
  - no path keeps a leaf beyond the server's sweep;
  - every abandonment posts exactly one self-Remove;
  - a resume never reuses a key after the leaf was removed (key zero-fill on every failure, as `join.ts:131`);
  - the boot sweep spares only an unexpired marker for that exact group;
  - `reload.spec.ts` is untouched and green.
- **Authz (UP2):**
  - the 503 is still a refusal at both the start and the `/rtc` gate;
  - slot adoption never exceeds `max_publishers` and never grants a penalised or barred device.
- **Installer safety (UP3):**
  - no path restarts `dilla-media` without a decision logged;
  - rollback never leaves the API on a schema the SFU decision assumed;
  - `release.json` cannot be swapped (SHA256SUMS, plus the cross-check with the binary);
  - shell quoting in the root timer unit.
- **Races (UP7):** a hold versus a person's leave versus `E_REMOVED` arriving late (`REMOVED_HOLD_MS`); the late-rejoin merge.
- **CI (UP4):** the compat job really runs the previous binary (log its `version`), and does not skip silently.

## Open for Jonas
- **Q1. A new build arrives during a call:**
  - (A) defer the reload until the person leaves the call, unless the build is marked `required`: this is UP8;
  - (B) reload at once and resume the kept leaf, a gap of about 2 to 5 s at every upgrade.
  - **Recommend A.** It is the only way "never interrupted at the media level" holds for a real release, and every release ships a new web build.
- **Q2. TURN lives in the API process (F2):**
  - (A) accept and document it for web3.12;
  - (B) move TURN into `dilla-media` now (ports and config move, larger installer change).
  - **Recommend A,** with B as a follow-up.
