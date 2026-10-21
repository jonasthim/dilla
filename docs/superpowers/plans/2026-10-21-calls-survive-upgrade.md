# Calls survive an upgrade: plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** an upgrade of dillad no longer ends people's calls.

**Context:** the homelab upgrade to web3.11 dropped every call, and the clients did not come back on their own. Jonas's decision is binding: **decouple the SFU restart.**
- `install.sh --upgrade` restarts the API (`dilla`) at once.
- `dilla-media` keeps running the old binary until `dillad media --rooms` is empty, or until the operator passes `--restart-sfu`.
- Each release states in machine-readable metadata whether the running SFU can stay. The installer reads that metadata and does not guess.
- CI proves that the previous release's SFU works with the new API (wire 2).

Jonas's answers to the plan's two questions (2026-10-21) are binding:
- **Q1 = B.** When a new build arrives mid-call, the page reloads at once and resumes. It keeps the call group (UP6), re-mints the token and reconnects, with no external join. The audio gap is at most **5 s**, and the e2e asserts it. The late-rejoin rule never fires on an update reload.
- **Q2 = B.** TURN moves into `dilla-media` in this release (UP8).

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
  - **F2.** The TURN relay runs in the API process (`cmd/dillad/front.go:500`, `StartTURN` `internal/server/turn.go:130`). A relayed client loses media on every API restart until ICE restarts. The relay is TCP only:
    - `turns:` on 443 through the API's TLS demux in public mode (`internal/server/demux.go`);
    - `turn:` on `turn.listen` behind a proxy.
    - Credentials are TURN REST HMAC-SHA1 over `turn.shared_secret_file` (`TURNCredential`, `turn.go:100`).
    - Revocation is shared in memory with the call routes (`RelayRevocations`, `internal/server/turnrevoke.go:95`; `Calls.WithRelay`, `calls.go:353`).
    - Barred devices are looked up in the database on demand (`BarredLookup`, `turnrevoke.go:20`; `Calls.BarredDevices`, `calls.go:365`).
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
  - web3.12 sets `MediaLevel = 2` (this SFU also serves TURN, UP8) and `MinSFUMediaLevel = 1`. The API still works with a level-1 SFU (web3.11) by serving TURN itself (R-UP11).
- **R-UP2 `release.json` is the metadata.**
  - It is a release asset, listed in SHA256SUMS and generated by release.yml from the built binary's `dillad version --json`. Nobody writes it by hand.
  - Shape: `{"format":1,"tag":"v0.1.0-web3.12","version":"0.1.0-web3.12","wire":[2],"schema":21,"media_level":2,"min_sfu_media_level":1,"media_capabilities":["turn"],"sfu_restart":"when-idle"}`.
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
    - `/var/lib/dillad/media.json` (written by a web3.12+ SFU at start: `{version, media_level, capabilities, pid, started}`);
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
  - **The TURN handoff (R-UP11).** When the SFU that is restarting gains TURN (`media.json` before the restart has no `turn` capability, and the new binary's `version --json` has it), the service next restarts `dilla`, so that the API lets go of `turn.listen`. Rooms are empty, so no relay is in use.
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
- **R-UP11 TURN belongs to the media process (Q2 = B).**
  - **Who serves it.** A web3.12+ `dillad media` serves TURN. `dillad serve` serves it only while the running SFU's `media.json` lacks the `turn` capability, that is, a web3.11 SFU during the transition. Exactly one process binds `turn.listen` at a time.
  - **Credentials.**
    - Unchanged: the API mints `TURNCredential` with `turn.shared_secret_file`, and the media relay verifies it with the same file. Both run as `dillad` and read the same `dilla.toml`, so there is no new secret.
    - The media relay refuses credentials issued before its own start. A cut set lost in an SFU restart can therefore never be bypassed, and clients that rejoin get fresh credentials from `startCall`.
  - **Revocation and the barred lookup** move behind a local control socket, `/var/lib/dillad/media.sock` (0600, `dillad`, served by `dillad media`).
    - The API implements `RelayRevoker` as a client of that socket (`POST /relay/cut`).
    - On every (re)connect, the API replays the cuts it holds (`PUT /relay/cuts`).
    - The relay's `BarredLookup` asks the API over `/var/lib/dillad/api.sock` (served by `dillad serve`). It fails closed: while the API is down, new allocations are refused, and existing allocations keep relaying. The relay keeps its own cut map, so cuts survive an API restart, which is better than today.
  - **Ports and config.**
    - `behind_proxy`: `turn.listen`, `turn.proxy_protocol`, `relay_ip` and `public_url` are read by the media process at the same address. The operator edits nothing.
    - `public` (`acme_tls_alpn`): TCP 443 belongs to the API, so `turns:` on 443 keeps being demuxed into the API's relay instance, which cannot survive an API restart. An optional `turn.listen` in public mode (today refused by `validate.go:165`) lets the media process serve `turns:` on its own port, with the ACME certificate from the shared certmagic storage. That needs a firewall port, so it is opt-in and documented, and the default is unchanged.
    - If `turn.listen`'s port is below 1024, the installer adds `AmbientCapabilities=CAP_NET_BIND_SERVICE` to `dilla-media.service`.
  - **Compatibility.**
    - New API, old SFU (level 1, no `turn`): the API serves TURN as in web3.11. CI's compat job covers this.
    - Old API, new SFU (a rollback below web3.12): web3.11's `serve` would bind `turn.listen` too and fail. The rollback (installer and by hand) therefore stops `dilla-media` before it starts the old API.

## Tasks

### Task UP1 (sonnet): SFU level, `version --json`, `media --idle`, `media.json`, doctor
- **Files:**
  - `internal/sfu/level.go` (new): `MediaLevel = 2`, `MinSFUMediaLevel = 1`, `Capabilities = ["turn"]`;
  - `internal/sfu/level_test.go`: a golden file `testdata/media-level.json` holding:
    - the livekit-server module version from `go.mod`;
    - `ClientProtocol`;
    - the SHA-256 of `testdata/livekit-signal-schema.json`;
    - the level.
    The test fails with "bump MediaLevel" when an input changes without the level.
  - `cmd/dillad/version.go`: `--json` prints `{version, revision, wire:[2], schema, media_level, min_sfu_media_level, media_capabilities}`;
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
    - the TURN handoff in the refresh service (R-UP4, R-UP11), and the conditional `AmbientCapabilities` on `dilla-media.service`;
    - a rollback below web3.12 while the SFU runs web3.12+: stop `dilla-media` first, and say that this ends calls;
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
    - `--idle` exits 69: no restart;
    - TURN handoff: an idle restart from a no-`turn` SFU onto a `turn` binary restarts `dilla-media`, then `dilla`, in that order; between two `turn` binaries, `dilla` is not restarted;
    - `turn.listen` on port 3478: no capability added; on port 443 behind a proxy: the capability is added;
    - a rollback to web3.11 with a web3.12 SFU stops `dilla-media` before it starts `dilla`.
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
- **The update path (Q1 = B): reload at once and resume within 5 s of audio.**
  - **Before the reload,** Shell posts `callHold` instead of `session.leave('user')`. The page then disconnects its LiveKit room without the MLS leave (`room.disconnect()`), so the SFU frees the old participant at once, and reloads.
  - **After the reload,** the resume is a fast path, not the generic recovery:
    - `restore()` sees the `callKeep` marker for its channel and calls `join` at once, without waiting for the 1 s recovery tick.
    - The AFK read (`afkFresh`) runs in parallel with the worker's resume (catch-up, `mediaEpoch`, `startCall`). Its verdict can still cancel before the LiveKit connect.
    - The microphone track is acquired in parallel with the token mint.
  - **Measure first.** Instrument these five marks:
    - `pagehide`;
    - worker ready;
    - token;
    - LiveKit `connected`;
    - local track published.
    Record the measured budget in the code comment. Target: at most 5 s from `pagehide` to the published track on the CI host.
  - **The late-rejoin rule never fires on an update reload.**
    - A resume from `callKeep` records no absence and skips the `leftAway` verdict entirely, whatever the clocks say.
    - Test this with the clock 10 minutes ahead and an AFK timeout of 60 s.
  - **Microphone permission.** If the browser asks again (for example a Firefox "ask every time" grant), the resume shows the existing microphone prompt. This one case cannot meet 5 s, and it is listed as a known limit.
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
  - the update path posts `callHold` and disconnects without `callLeave`;
  - the restore with `callKeep` joins without waiting for a tick, and the AFK read runs in parallel;
  - an update reload never yields `leftAway`.
- **Gates:** web vitest and typecheck; lint; e2e `voice/reload.spec.ts` and `web/afk.spec.ts` on chromium.

### Task UP8 (opus): TURN moves into `dilla-media` (R-UP11, Q2 = B)
- **Files:**
  - `cmd/dillad/media.go` (`serveMedia`): start TURN with the media process's listener. Behind a proxy that is `turn.listen`, with `proxy_protocol`; in public mode it is the opt-in `turn.listen` with the certmagic certificate. Pass `turnPeers` and the `node_ip` anchor, now computed here.
  - `cmd/dillad/front.go` (`:110-125`, `:175-185`, `:500-510`): `serve` starts TURN only when the running SFU lacks the `turn` capability, or when `livekit.mode` is `in_process`. The 443 demux branch stays in `serve`.
  - `internal/server/turnrevoke.go`:
    - `RelayRevocations` gains `floor = start time` for a media-owned relay;
    - a `RemoteBarred` that implements `BarredLookup` over `api.sock` and fails closed;
  - `internal/server/relayctl.go` (new):
    - the `media.sock` server: `POST /relay/cut {device, at}`, `PUT /relay/cuts [...]`, `GET /relay/state` (allocation count, owner, floor);
    - the client the API uses as `RelayRevoker`, which replays the cut set on (re)connect;
  - `internal/dillad/routes.go:105` and `server.go`: wire the remote revoker; serve `api.sock` with the one route `GET /relay/barred/{device}`;
  - `internal/config/validate.go:165-170`: allow `turn.listen` in public mode (opt-in);
  - `cmd/dillad/doctor.go:221` (and `internal/ops/doctor.go:326`): the `turn` leg names the owner (`media` or `api`) from `media.json` and `GET /relay/state`, then probes the listener as today; it is red when both or neither process serves TURN;
  - TURN metrics: the media process exposes them if it has a metrics listener; otherwise this is a known limit, and they appear in `GET /relay/state`.
- **Socket security:** both sockets are 0600 in the 0700 `StateDirectory`, owned by `dillad`. The server checks `SO_PEERCRED` for the `dillad` uid. Requests are bounded in size and time, and are not reachable from the network.
- **Tests:**
  - a credential minted by the API is accepted by the media relay;
  - a credential issued before the relay started is refused;
  - a cut through `media.sock` ends that device's allocations and refuses new ones;
  - the API reconnects and replays its cut set;
  - the barred lookup fails closed while `api.sock` is down, and existing allocations keep relaying;
  - `serve` binds no TURN when `media.json` has `turn`, and binds it as before with a web3.11 `media.json` (none);
  - the doctor's owner reporting, and red when both or neither serve TURN;
  - **a relayed client survives an API-only restart:** a Go integration test with a pion TURN client allocating through the media relay to the SFU, while the API process restarts. Its allocation and data keep flowing, and new allocations during the outage are refused.
  - e2e: covered in UP9 with a forced relay peer.
- **Gates:** `go test -race ./internal/server/... ./cmd/dillad/... ./internal/dillad/...`; golangci-lint; `check:docs`.

### Task UP9 (sonnet): acceptance e2e, `e2e/voice/upgrade.spec.ts`
- **Setup:** the UP5 sidecar host, with TURN served by the media process. Three peers (the `peer-browser` support) in one community voice channel, all heard by each other. Peer 3 forces relay (`iceTransportPolicy: 'relay'`).
- **A, full restart, no input:**
  - stop the API, restart the SFU, start the API with a new web build;
  - all three show `connected` in the same channel, and each hears the other two, within **90 s** of the API answering.
- **B1, compatible release with the same build:** restart the API only. For every peer, the relayed one included:
  - the LiveKit participant sid is unchanged;
  - `phase` never reaches `removed`;
  - inbound audio frames keep increasing, with no gap over 1 s;
  - no new MLS epoch.
- **B2, compatible release with a new build (Q1 = B):** restart the API with a new build. Every page reloads and resumes:
  - **audio gap ≤ 5 s** per peer, measured from that peer's `pagehide` to its local track published again, and to the other peers' inbound frames from it resuming;
  - no `postGroup` and no external commit (request log);
  - the epoch is unchanged;
  - no `leftAway`, even with the AFK timeout set to 60 s and the page clock moved 10 min ahead.
- **compat:** B1 with `DILLA_SFU_BIN` set to the previous release's binary. A web3.11 SFU has no TURN, so the API serves the relay, and the relayed peer is exempt from the uninterrupted assertion; it must reconnect within 90 s. CI's UP4 job runs it.
- **Gates:** the spec passes three times in a row on chromium; firefox once.

### Task UP10 (haiku): docs
- **`docs/deploy/README.md`:**
  - the intro (`:1-10`) and the mermaid diagram (`:13-30`): the SFU and its TURN relay are no longer restarted with the API;
  - §1's TURN sections (`:92-180`): TURN runs in `dilla-media`; the public-mode 443 path and the opt-in `turn.listen`; the ports are unchanged behind a proxy;
  - §3 systemd (`:300-330`): no `PartOf`, the refresh timer, `media --idle`, `media.sock` and `api.sock`;
  - the install script upgrade section (`:431-497`): `--restart-sfu`, `release.json`, how the keep-or-restart decision is reported, the one-time TURN handoff, rollback by hand (stop **both** units; below web3.12, stop `dilla-media` first; `systemctl disable --now dilla-media-refresh.timer`).
- **`docs/deploy/releases/v0.1.0-web3.12.md`** (append to late-rejoin's stub):
  - a new Versions row, **"Media server (SFU) | when-idle (level 2, keeps web3.11's level 1) | …"**;
  - the operator notes below;
  - correct web3.11's PartOf-based rollback wording.
- **README:**
  - in the operator part: "Upgrades keep calls (web3.12); TURN runs in the media service";
  - in the client part: "an update during a call reloads and reconnects in a few seconds".
- **`docs/user/voice.md`:** a "During a server upgrade" line (the call continues, or the page reloads and you are back within a few seconds with no click) and a troubleshooting row (the microphone prompt after an update in Firefox).
- **Gate:** `check:docs`, `check:copy`.

**Order and dependencies:**
1. UP1: every later task reads `version --json`, `media.json`, the capability or `--idle`.
2. UP2 ∥ UP5 ∥ UP8: disjoint files. UP8 touches `cmd/dillad/{media,front,doctor}.go`, `internal/server` and `internal/dillad`; UP2 touches `internal/api`. The one shared file is the doctor, which UP1 has already changed. Writers in the same worktree stay sequential.
3. UP3 after UP1 and UP8: the TURN handoff, the capability rule and the rollback order depend on UP8's behaviour.
4. UP6, then UP7. UP7 needs UP2's 503 and fix/late-rejoin, merged or rebased.
5. UP9 needs UP5, UP7 and UP8.
6. UP4 needs UP9's spec, because its compat job runs it.
7. UP10 last.

In short: UP1 → (UP2 ∥ UP5 ∥ UP8) → UP3 → UP6 → UP7 → UP9 → UP4 → UP10.

## Edge cases
- **A start in flight while the timer restarts the SFU.** A room under 60 s old counts as busy. The few milliseconds left between the check and the restart give a start a 503 followed by a retry (R-UP7, R-UP8).
- **The upgrade happens while a client is mid-reload.** Its `callKeep` outlives the outage, because the window counts instance time.
- **A rollback after a compatible upgrade.** The SFU still runs the old binary. The restored `dillad` has a new inode, so the timer restarts the SFU once, when idle, onto identical code. That is harmless and documented.
- **A new build while the SFU is also restarting** (an incompatible release). The resume finds the call ended and the group closed, then forgets it and joins fresh. Scenario A covers this; the 5 s target does not apply.
- **A rollback below web3.12.** The old `install.sh` writes `PartOf` back and does not know the timer. If the SFU already runs web3.12, it holds `turn.listen`, so `dilla-media` must stop first: the docs and the web3.12 installer's own rollback both do this.
- **An SFU crash during a compatible upgrade.** systemd restarts it on the new binary (`Restart=on-failure`); if that binary has TURN, the API still holds `turn.listen` until the refresh service's handoff. Then:
  - the media process retries the bind every 5 s and logs it;
  - the doctor shows red "TURN served by neither process" only if the API has let go of the port;
  - calls recover through R-UP6; the call ended, so they join a fresh group.
- **The API is down and a relayed client needs a new allocation** (an ICE restart). It is refused, because the barred lookup fails closed. The client retries after the API is back.
- **Two tabs.** The hold lives in the tab's worker. `E_CALL_IN_OTHER_TAB` rules are unchanged.
- **A DM call.** It is held the same way. Late-rejoin does not apply to DM calls.

## Release (v0.1.0-web3.12): operator-visible changes
- **`install.sh --upgrade` restarts only the API** when the running media server is compatible. Live calls continue, relayed (TURN) clients included once the relay runs in `dilla-media`. There is no live-call refusal and `--yes` is not needed.
- **Open tabs reload into the new build mid-call and reconnect by themselves,** typically within 5 s of audio.
- **TURN moves into `dilla-media`.**
  - Behind a proxy: the same `turn.listen`, no edits.
  - The handoff from a web3.11 SFU happens once, at the first idle refresh, which also restarts `dilla` once.
  - Public mode: `turns:` on 443 stays in the API (it does not survive an API restart), and an optional `turn.listen` moves it to the media service.
  - New sockets: `/var/lib/dillad/media.sock` and `/var/lib/dillad/api.sock`.
  - The doctor's `turn` leg names the owner.
  - Rollback below web3.12: stop `dilla-media` first, which ends calls.
- **`dilla-media` keeps the previous binary** until its calls end. `dilla-media-refresh.timer` then restarts it onto the new one. `dillad doctor` shows "dilla-media runs vX (older)" until then.
- **`--restart-sfu`** restarts the media server now and ends live calls. `--yes` is kept as an alias for one release.
- **New release asset `release.json`**, listed in SHA256SUMS. The installer refuses a mismatch. `--binary` mode takes `--release-json FILE`.
- **Units:**
  - `dilla-media.service` loses `PartOf`, so `systemctl stop dilla` no longer stops the media server;
  - it gains `CAP_NET_BIND_SERVICE` only when `turn.listen` is below 1024;
  - there are two new units, `dilla-media-refresh.{service,timer}`.
- **New commands:** `dillad media --idle` and `dillad version --json`.
- **Unchanged:** schema 21 (no migration), wire 2, client store 5, ABI.
- **Known limits:**
  - public-mode TURN on 443;
  - a microphone prompt after the update reload in browsers that ask every time;
  - a release that raises `min_sfu_media_level` still ends calls (the installer says so first).

## Review Focus
- **E2EE (UP6, UP7):**
  - the fast path's parallel AFK read can still cancel before the connect;
  - no path keeps a leaf beyond the server's sweep;
  - every abandonment posts exactly one self-Remove;
  - a resume never reuses a key after the leaf was removed (key zero-fill on every failure, as `join.ts:131`);
  - the boot sweep spares only an unexpired marker for that exact group;
  - `reload.spec.ts` is untouched and green.
- **Authz (UP2, UP8):**
  - the 503 is still a refusal at both the start and the `/rtc` gate;
  - slot adoption never exceeds `max_publishers` and never grants a penalised or barred device;
  - the media relay's credential floor, its fail-closed barred lookup and the cut replay leave no window in which a cut or barred device gets a new allocation;
  - the sockets accept only the `dillad` uid.
- **Installer safety (UP3):**
  - no path restarts `dilla-media` without a decision logged;
  - rollback never leaves the API on a schema the SFU decision assumed;
  - the TURN handoff order, and rollback never leaves both or neither process bound to `turn.listen`;
  - `release.json` cannot be swapped (SHA256SUMS, plus the cross-check with the binary);
  - shell quoting in the root timer unit.
- **Races (UP7):**
  - a hold versus a person's leave versus `E_REMOVED` arriving late (`REMOVED_HOLD_MS`);
  - the late-rejoin merge;
  - the 5 s budget is measured, not assumed.
- **CI (UP4):** the compat job really runs the previous binary (log its `version`), and does not skip silently.

## Decided
- **Q1 = B** (Jonas, 2026-10-21): reload at once and resume, with an audio gap of at most 5 s. The former UP8 (deferring the reload) is dropped.
- **Q2 = B** (Jonas, 2026-10-21): TURN moves into `dilla-media` now (UP8). Public-mode `turns:` on 443 stays with the API by necessity, and the opt-in `turn.listen` covers it.
