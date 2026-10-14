# dilla v0.1.0-web3.3: people in a call hear each other — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two people in a voice channel hear each other. Today both publish and the far side shows the speaking ring, but nothing plays.

**Architecture:** livekit-client plays a remote audio track only once the app calls `RemoteAudioTrack.attach()`. With `webAudioMix: true`, attach is also what routes the track through the room's AudioContext and its gain node (node_modules/livekit-client/src/room/track/RemoteAudioTrack.ts:98-120, 181). packages/web/src/call/session.ts never attaches a remote audio track: it reads only `mediaStream` for video tiles, and `setVolume` has no gain node to act on. The fix is to attach every subscribed remote audio track (microphone and screen-share audio), including any subscribed before the session's listeners were registered. It detaches them on unsubscribe and on leave, and it surfaces the browser's autoplay block with a one-press "turn on audio".

**Tech Stack:** TypeScript (packages/web call session and voice screen, packages/ui), livekit-client 2.x, Vitest, Playwright (e2e/voice against the real SFU).

**Spec:** the field report from the homelab test on 2026-10-14 (Homelab session).
- Two devices joined one voice channel on v0.1.0-web3.2 behind Pangolin.
- Both became active participants, and both published audio.
- The speaking indicator showed on the far side.
- No audio was heard.
- The SFU logged `connectionType: udp`, and a capture showed bidirectional media.

Root cause: established above, from the source. No spec file exists beyond this report and this plan, so rulings are provisional. The product requirement is the one in docs/design/flows/06-voice.md: people in a call hear each other.

**How the bug escaped:** e2e/voice/join-talk.spec.ts `heard()` (e2e/voice/support/voice.ts:420-436) counts frames the media worker *decrypted*, not sound that reached an output. A green check that could not go red for this fault. Task 1 adds an assertion that fails on main today.

## Global Constraints

- **E2EE untouched.** Don't change the media worker, the transforms, DillaE2EEManager, the key relay, or the room options' `e2ee` key. Attaching an element is downstream of decryption: a frame that fails to decrypt is dropped by the transform and never reaches the element.
- **One mixer.** Keep `webAudioMix: true`. Per-person volume (`gainOf` / `setVolume`), deafen and the output-device choice (`audioOutput`) must act on the attached tracks. Deafened means zero gain on every remote track, and that must still hold for tracks attached after the deafen.
- **No leaks.** Every element the session creates is detached and removed on unsubscribe, on participant leave and on every leave path (user, switch, pagehide, lost, blocked, removed). The e2e leak checks (e2e/voice/support/leaks.ts) stay green.
- **Elements.** Attached elements live in one hidden container. They aren't focusable, aren't announced (`aria-hidden`), have no controls and need no CSP change. Tests inject the container through `PageCallDeps`, in the same way `viewOf` is injected.
- **Copy.** Every user-visible string lives in packages/web/src/strings/en.ts and has a row in docs/design/flows/06-voice.md. It passes `npm run check:copy`. Sentence case, plain verbs, no apology.
- **Design.** Mesh tokens and packages/ui components only. Keyboard first, visible focus. WCAG 2.2 AA including target size. Works at 360 px.
- **Unchanged.** The core (wasm size), the server, authz, the CSP.
- **Test-first.** Each behaviour has a test that fails first, then passes. Each logic change has one mutation that the tests catch. Record both in the task report.
- **Env dirs.** CARGO_TARGET_DIR=/home/thim/.cache/dilla-w3/cf-target, GOCACHE=/home/thim/.cache/dilla-w3/cf-gocache.
- **Harness.** Single plain commands only: no `&&`, `;`, pipes or `$(...)`. Anything longer goes in a script file.
- **Commits.** `git commit -s -F <file>`, and every message ends with exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01XLFud8eoDaqf8uiZq5wjuP`
- **Process.** No subagents inside a task. No push, tag or release. A commit-time security-scanner flag counts as real until shown otherwise.
- **Fixture reachability.** Any state a test seeds must be one the shipping client can reach by itself.

## Review Focus

1. **A track subscribed before the listeners existed.** `trackSubscribed` can fire while `joinCall` is still resolving, and session.ts registers `roomListeners` only after that. A person who joins a call where someone is already talking expects to hear them at once. Pinned in Task 1, step 2.
2. **Deafen, then someone new joins.** The newcomer's track is attached after the deafen, and the person expects silence until they undeafen. Pinned in Task 1, step 3.
3. **The browser blocks autoplay** (Safari, or a join that resolved long after the click). The person expects one clear "turn on audio" press, not silence. Pinned in Task 1, step 4.
4. **Leave and rejoin, or switch channels.** The person expects no doubled audio (two elements for one track) and no element left playing after leave. Pinned in Task 1, step 5.
5. **A speaker excluded by SpeakerPolicy** (more than the top-N talkers). The track is unsubscribed at the SFU. The person expects its element to be detached and re-attached when the speaker returns, without a duplicate. Pinned in Task 1, step 5.

---

### Task 1: Attach remote audio, surface the autoplay block, and prove sound in e2e

**Files:**
- Modify: `packages/web/src/call/session.ts` (EV map ~:171, `PageCallDeps` ~:89, `PageCallState` ~:33, `PageCall` ~:64, room events ~:703-718, `stopEverything` ~:725, `applyGains` ~:446)
- Modify: `packages/web/src/call/session.test.ts`
- Modify: `packages/web/src/screens/voice/VoiceView.tsx` and `packages/web/src/screens/voice/useCall.tsx` (the turn-on-audio affordance)
- Modify: `packages/web/src/screens/voice/VoiceView.test.tsx`
- Modify: `packages/web/src/strings/en.ts`, `docs/design/flows/06-voice.md` (copy rows)
- Modify: `e2e/voice/support/peer-browser.ts`, `e2e/voice/support/voice.ts`, `e2e/voice/join-talk.spec.ts`

**Interfaces:**
- Consumes: livekit `RoomEvent.TrackSubscribed (track, publication, participant)`, `RoomEvent.TrackUnsubscribed (track, publication, participant)` and `RoomEvent.AudioPlaybackStatusChanged` (string `'audioPlaybackChanged'`; check the exact string in node_modules/livekit-client/src/room/events.ts). Also `room.canPlaybackAudio: boolean`, `room.startAudio(): Promise<void>`, `RemoteTrack.kind === 'audio'`, and `RemoteAudioTrack.attach(el?)` / `.detach(el?)`.
- Produces:
  - `PageCallDeps.audioHost?: () => HTMLElement | null`. This returns the container that attached elements go into. The default is a lazily created hidden `<div data-dilla-call-audio hidden aria-hidden="true">` appended to `document.body`, and null when there is no `document`.
  - `PageCallState.audioBlocked: boolean`. It is true while `room.canPlaybackAudio` is false.
  - `PageCall.startAudio(): Promise<void>`. It calls `room.startAudio()` and then re-reads `canPlaybackAudio`.

- [ ] **Step 1: Write the failing unit test for the basic attach.**

  In session.test.ts, use the existing fake room:
  1. A remote participant's microphone track emits `trackSubscribed`.
  2. Expect `attach` to have been called exactly once.
  3. Expect the returned element to sit in the injected `audioHost` container.
  4. A video track emitting `trackSubscribed` is not attached by this path.

  Run `npx vitest run packages/web/src/call/session.test.ts` from packages/web. It must FAIL on main, because nothing calls attach.

- [ ] **Step 2: Test and implement the attach on subscribe, including pre-existing tracks.**

  Test: a participant whose microphone publication already has a subscribed track *before* `startPageCall` registers its listeners is attached once at connect. Then a later `trackSubscribed` for the same track does not attach it a second time.

  Implement:
  - A `Map<RemoteTrack, HTMLMediaElement>`.
  - An `attachAudio(track)` that is a no-op when the track is already in the map or is not audio.
  - A sweep of `room.remoteParticipants` → `trackPublications` → `track` before `state = { ...phase: 'connected' }`.
  - A `trackSubscribed` listener that calls `attachAudio`, then `applyGains()`.

- [ ] **Step 3: Test and implement gains on newly attached tracks.**

  Tests:
  - Deafen, then a new participant's track subscribes. The track's effective volume is 0: assert `setVolume(0, microphone)` was called after the attach, since `applyGains` runs after attach.
  - A per-person volume of 50 set before the attach is applied after it.

  The implementation is the `applyGains()` call from step 2. Make sure it runs after `attach()`, because livekit applies `elementVolume` only to a gain node that exists.

- [ ] **Step 4: Test and implement the autoplay block.**

  Tests:
  - The fake room has `canPlaybackAudio = false` and emits `audioPlaybackChanged`. Then `state.audioBlocked === true`.
  - `call.startAudio()` calls `room.startAudio`. When the fake flips `canPlaybackAudio` to true, `audioBlocked` becomes false.
  - A rejected `startAudio` leaves `audioBlocked` true and doesn't throw out of the handler.

  Also read `canPlaybackAudio` once at connect.

  In VoiceView, when `audioBlocked`:
  - Show a packages/ui Button "Turn on audio" with the hint "Your browser paused call audio." close to the call controls.
  - Pressing it calls `startAudio`.
  - It's reachable by keyboard and visible at 360 px.

  Add both strings to en.ts and to the Copy table in flows/06-voice.md. Add a VoiceView test for show, press and hide.

- [ ] **Step 5: Test and implement the detach paths.**

  Tests:
  - `trackUnsubscribed` detaches that track's element and removes it from the container. This is the SpeakerPolicy exclusion path.
  - A re-subscribe of the same participant attaches once.
  - `participantDisconnected` leaves no element of theirs.
  - Each leave reason ('user', 'switch', 'pagehide', 'lost') leaves the container empty and calls `detach` on every attached track.
  - A second `startPageCall` after a leave starts from an empty container.

  Implement the detach in the `trackUnsubscribed` listener and in `stopEverything()`.

- [ ] **Step 6: Make the e2e prove sound, not decryption.**

  In `installRecorders` (e2e/voice/support/peer-browser.ts):
  1. Record the ids of remote tracks (`RTCPeerConnection` `track` events, i.e. `ev.track.id`) into `__dw.remoteTracks`.
  2. Wrap `BaseAudioContext.prototype.createMediaStreamSource` and `createMediaElementSource`. When the stream (or the element's `srcObject`) holds a recorded remote track, also connect the new source node to an `AnalyserNode`. Keep it in `__dw.remoteAnalysers`.

  In e2e/voice/support/voice.ts, add `audible(page)`: poll until some remote analyser's time-domain RMS exceeds a small threshold (Chromium's fake microphone emits a steady tone).

  In join-talk.spec.ts, call `await audible(alice.page)` and `await audible(bob.page)` after `heard`, inside the Chromium branch that already guards `audioRunning`. Firefox headless has no audio server.

  **Show it red on main:** run the spec with the session change stashed through a WIP commit (never a bare `git stash`), and record the failure output in the report.
  - Run: `npx playwright test -c e2e/playwright.voice.config.ts e2e/voice/join-talk.spec.ts --project=chromium` (check the project names in the config).
  - Expected on main: FAIL at `audible`.
  - Expected with the fix: PASS.

- [ ] **Step 7: Run the wider gates.**
  - packages/web: `npx vitest run` and `npx tsc -p . --noEmit`.
  - Repo: `npm run check:copy`.
  - The full voice e2e config (`npx playwright test -c e2e/playwright.voice.config.ts`), all projects, including leaks and share. A screen share with audio must also be audible: if share.spec.ts has an audio share, add `audible` there too.

- [ ] **Step 8: Commit.** Use one or more commits, each through `git commit -s -F <file>`, for example `fix(web): play remote call audio; turn-on-audio when the browser blocks it`.

---

### Task 2: Docs, the deploy notes from the homelab run, and the release notes

**Files:**
- Modify: `docs/deploy/README.md` (the section "Behind a WireGuard tunnel (Pangolin): MTU and UDP 7882" ~:118, the Pangolin install bullets ~:428-437)
- Modify: `docs/user/voice.md`, `README.md` ("what works")
- Re-shoot: `docs/user/screenshots/voice-stage-desktop.png` and `voice-stage-phone.png` only if the turn-on-audio state is shown there. Otherwise add `voice-audio-blocked-desktop.png` and `voice-audio-blocked-phone.png` through e2e/scripts/shoot-docs.mjs, if that script already shoots voice states.

**Interfaces:**
- Consumes: the strings from Task 1 ("Turn on audio", "Your browser paused call audio.") verbatim from packages/web/src/strings/en.ts.

- [ ] **Step 1: Deploy notes.** Add to the Pangolin section:
  - **The `udp` leg of `dillad doctor` always reads WARN "not probed".** dillad runs no reflector, so it cannot see the forward from inside. Prove the forward instead with `ss -ulpn` on the Pangolin host showing `:7882` and, during a call, the SFU log line `participant active … connectionType: udp`.
  - **Give the raw UDP resource exactly one target:** the node the container runs on. One target per site (as HTTP resources have) makes the stream reach the SFU from several source addresses, and ICE then re-validates without end.
  - **Recreating traefik and gerbil drops every tunnel.** The public hostnames answer 404 (not 502) for about 20 s until they recover. Do it when nobody is in a call.
  - Pre-existing UDP entry points without a `timeout` default to 3 s. The 30 s note applies to them too.

- [ ] **Step 2: User docs.** In docs/user/voice.md, under the troubleshooting part (create one if absent), add: "If you see people speaking but hear nothing, press **Turn on audio**. Your browser paused call audio until you press something on the page." Keep README "what works" accurate: voice calls play audio from v0.1.0-web3.3.

- [ ] **Step 3: Gates.** Run `npm run check:copy` and the docs lint (if one exists in package.json scripts), and run e2e/scripts/shoot-docs.test.mjs if screenshots changed.

- [ ] **Step 4: Commit.** `docs: call audio, and Pangolin UDP notes from the homelab run`.

---

## After the tasks

- Whole-branch review on the most capable model. It includes a product walk from an EMPTY instance on dilla-testhost:
  1. Create a server.
  2. Invite a second browser.
  3. Both join the voice channel.
  4. Confirm `audible` on both.
  5. Deafen and confirm silence.
  6. Leave and confirm no element remains.
- Then a PR, CI green, merge. Then tag `v0.1.0-web3.3` (a prerelease) on main, verify the assets as for web3.2, and ask Homelab to upgrade CT 144. Jonas re-runs the two-device test.
