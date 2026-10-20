# Fix #37: "There is no sound when watching another person's stream" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Say when a share has no sound.** The sharer learns at once that the browser gave no audio for the surface they picked, and how to get sound. Viewers see a "no sound" mark on that screen tile, so a silent stream is never a mystery.
- **Never re-send the call.** When the browser captures system audio (Windows and ChromeOS, and macOS 14.2+ on Chrome 141+), the call's own playback is excluded (`restrictOwnAudio`), so viewers do not hear their own voices come back through the share.
- **Ask the browser for every sound it can give.** The `getDisplayMedia` call states its audio hints explicitly (`systemAudio: 'include'`, `windowAudio: 'system'`) instead of relying on defaults that have changed between releases (Edge before 142 defaulted `windowAudio` to `exclude`).
- **The docs say what is true per browser and OS.** `docs/user/voice.md` and the README now say a whole screen or window is shared without sound, which is wrong on Windows and ChromeOS.

**Out of scope:** the sound of a native application or game on Linux and macOS, and window-only audio. No browser API offers either. Both belong to the desktop app (roadmap W10, `docs/superpowers/specs/2026-09-23-dilla-design.md:504`, `:520`). Also out of scope: any server, grant, SFU or E2EE change (none is needed; see Root cause), a protocol bit, and a migration.

**Architecture:**
- **packages/media:** `SCREEN_AUDIO_CAPTURE` (presets.ts:44-49) gains `restrictOwnAudio: true`. A new exported `SCREEN_DISPLAY_HINTS` holds `{ systemAudio: 'include', windowAudio: 'system', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude' }`.
- **web, call/devices.ts:** `acquireScreen` spreads the hints into the `getDisplayMedia` options. It returns `audio`, plus `audioKind: 'tab' | 'system' | 'none'`, read from the video track's `displaySurface` and whether an audio track came back.
- **web, call/session.ts:** `PageCallState` gains `shareAudio: 'tab' | 'system' | 'none' | null`, the sharer's own outcome (null while not sharing). `PageCallTile` gains `screenAudio: boolean`, true while that remote device has a `screen_share_audio` publication. No change to the publish path, the E2EE manager, attach, gains or grants.
- **packages/ui:** `CallTile` with `source="screen"` takes `silent?: boolean` and renders a glyph-only `volume-x` state named by the `stage.noSound` label. The Lucide `volume-x` icon is vendored.
- **web, screens/voice:** the stage passes `silent={!tile.screenAudio}` on remote screen tiles. The sharer gets one polite live-region notice when `shareAudio` turns `'none'`.
- **Docs:** `docs/user/voice.md`, the README limits line, and flow 06 rows.

**Tech Stack:** TypeScript (packages/media, packages/web React, packages/ui and Storybook), Vitest, Playwright e2e against dilla-testhost (voice config, Chromium; Firefox for the "no audio at all" control).

**Spec:** this plan's Root cause section and GitHub issue #37. Binding background: `docs/superpowers/plans/2026-10-14-dilla-web-3.md:51` (decision 10, "Screen audio is Chromium tab audio only"), `docs/superpowers/specs/2026-09-23-dilla-design.md:504` (desktop share audio), `docs/superpowers/plans/2026-10-14-dilla-web-3-4-admin.md:606` (V4, audible share audio).

**Anchors** are verified on `fix/37-stream-audio` @ 36363df7 (= `dilla-web-3-9` head). A moved anchor is not a NEEDS_CONTEXT; a missing one is.

## Root cause (investigation, 2026-10-20)

**Summary.** The share pipeline is not broken. The reporter shared a game (Valheim), which is a native window or a whole screen, not a browser tab. For that surface the browser returned a stream with **no audio track**. That always happens on Linux, on macOS before Chrome 141 / macOS 14.2, in Firefox and in Safari. On Windows and ChromeOS it happens unless the person ticks "Also share system audio" in Chrome's picker. dilla accepts the missing track silently: neither the sharer nor the viewers are told. This is a known product limit (decision 10; README:57 "Screen sound beyond a shared Chromium tab"; voice.md:190), but the app never surfaces it.

**Evidence, layer by layer:**
1. **Capture asks for audio.** `acquireScreen` calls `getDisplayMedia({ video: true, audio: { ...SCREEN_AUDIO_CAPTURE } })` (`packages/web/src/call/devices.ts:69-77`). The constraints are no EC/NS/AGC and 2 channels (`packages/media/src/audio/presets.ts:44-49`). The app passes no `systemAudio`, `windowAudio`, `selfBrowserSurface` or `restrictOwnAudio`. A missing audio track becomes `audio: null` (devices.ts:76), and the session then publishes the video alone (`session.ts:1083-1086`). Nothing tells the sharer.
2. **Browser support** (MDN browser-compat-data, `api/MediaDevices.json`, getDisplayMedia):
   - `audio_capture_support`: Chrome 74+, Edge mirrors it: "On Windows and ChromeOS, the entire system audio can be captured when sharing an entire screen. On Linux and macOS, only the audio of a tab can be captured." Firefox: none ([bug 1541425](https://bugzilla.mozilla.org/show_bug.cgi?id=1541425)). Safari: none. Also [caniuse](https://caniuse.com/mdn-api_mediadevices_getdisplaymedia_audio_capture_support).
   - `systemAudio` option: Chrome 105+, "Default value = `include`" ([caniuse](https://caniuse.com/mdn-api_mediadevices_getdisplaymedia_systemaudio_option); [Chrome screen-sharing controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls): "the default may change").
   - `windowAudio` option: Chrome 141+, "Defaults to `system`. Only supports `exclude` and `system`, not `window`." In Edge, before 142 it defaulted to `exclude` ([TAG review](https://github.com/w3ctag/design-reviews/issues/1110), [spec](https://w3c.github.io/mediacapture-screen-share/)). No browser gives a window's own audio.
   - macOS: Chrome 141 on macOS 14.2+ offers system audio for a screen or a window ([addpipe](https://blog.addpipe.com/getdisplaymedia-allows-capturing-the-screen-with-system-sounds-on-chrome-on-macos/)). BCD's macOS note predates this.
   - `restrictOwnAudio` (Chrome 141, [MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/restrictOwnAudio), [Chrome 141 notes](https://developer.chrome.com/release-notes/141)): "the captured system audio will be filtered to exclude audio originating from the document that performed getDisplayMedia". dilla does not set it, so system-audio capture today also takes the call's playback of everyone's voices (flagged as a risk in design spec :694).
3. **Real-browser probe** (Chromium 1243 from Playwright, headless, Linux; `acquireScreen`'s exact options; scratchpad `probe/probe.mjs`):
   - a tab picked by title → `audio: ["Tab audio"]`, `displaySurface: "browser"`;
   - the fake picker (screen) → `"Fake audio"`, a test double only;
   - "Entire screen" auto-select → no capture in headless.
   The desktop surfaces were not probed headed, because that would raise the portal picker on Jonas's desktop. Their behaviour rests on the sources above.
4. **Publish and E2EE.** The audio is published with `screenAudioOptions(caps)`, source `ScreenShareAudio` (presets.ts:27-41), only if `permitted('screenAudio')`, which is LiveKit source 4 (session.ts:245, :967-972). The E2EE manager attaches a transform to every sender: `sourceToSlot('screen_share_audio') = 3` (`packages/media/src/slots.ts:15`). It fails closed on anything outside the transform (`manager.ts:552-566`, `E_E2EE_REQUIRED`) and is pinned by `packages/media/test/manager.test.ts:367` (`encode, slot 3`). On the server, `notDillaMedia` strikes a `SCREEN_SHARE_AUDIO` track with `Encryption_NONE` or a non-audio type (`internal/api/callevents.go:614-628`). The Go media binding maps it to `sframe.ScreenAudio` (`internal/media/binding.go:51`). No path bypasses E2EE.
5. **Grants.** `sfu.PublishGrant(speak, video, screen)` adds `SCREEN_SHARE`+`SCREEN_SHARE_AUDIO` together for the screen bit (`internal/sfu/grants.go:41-61`). It is used by `grantFor` (`internal/api/calls.go:1041-1047`), `admitGrant` (:1053) and the role re-push (`callgrants.go:305-308`). All three return `PublishGrant(false,false,false)` in AFK and under an F11 penalty. Share is 403 in AFK (`callshare.go:458-460`), pinned by `internal/api/afk_listen_test.go` (`TestAFKShareIsRefused`, `TestAFKGrantFailsClosed`, the token and admit tests). The client refuses too (`sendable()`, session.ts:974). Nothing to change.
6. **Viewer playback.** `autoSubscribe: true` (`packages/media/src/connect.ts:227`). `onSubscribed` → `queueAudio` → `attachPending` attaches every remote audio track, microphone or share, through the `webAudioMix` AudioContext (session.ts:671-741, :1168-1172). `applyGains` puts the person's volume on both `microphone` and `screen_share_audio` (:652-658). Deafen and pause hold the track back at gain 0. A listen-only (AFK) viewer still hears shares; they only cannot share. The share audio is never metered as speaking (:714-715).
7. **End to end, today.** `e2e/voice/share.spec.ts:82` ("a shared tab's sound is heard by the other browser", web3.4 V4) **passes** on code identical to this branch for `packages/web/src`, `packages/media/src` and `internal/` (lane w39-fc, `DILLA_TESTKIT` from w39-fc-target): `2 passed (21.4s)`.

**Conclusion:** the sharer's browser gave no audio for the surface they picked, and dilla said nothing. There are two contributing defects: (a) no in-app signal for a share without sound, for the sharer or the viewers; (b) no `restrictOwnAudio`, so a system-audio share echoes the call. There is also one docs defect: (c) "a whole screen or window is shared without sound" is false on Windows and ChromeOS.

## Open questions for Jonas (answer before T3)

Each question lists options; the recommendation is marked **(rec)**. T1 and T2 do not depend on the answers. T3 and T4 do.

1. **Share audio on by default?**
   - a. Ask whenever the browser offers it, as today. The picker's own "share tab/system audio" toggle is the consent. **(rec)**
   - b. A dilla toggle "share sound" before the picker, default on.
   - c. Default off.
2. **Volume for a stream's sound.**
   - a. One volume per person for voice and stream, as today (applyGains sets both).
   - b. A separate stream volume per person (`voice.streamVolume.<user>`, 0..200), plus a mute button on the screen tile. **(rec, as a follow-up task T5, Discord parity)**
   - c. Only a per-tile mute, no slider.
3. **How a share without sound is shown.**
   - a. To the sharer only: a one-time notice after the share starts.
   - b. To viewers only: a `volume-x` mark on the screen tile.
   - c. Both. **(rec)** The sharer's notice names the fix: "No sound is shared. To share sound, share a browser tab, or on Windows tick 'Also share system audio'".
4. **Guidance before the picker?**
   - a. None, after-the-fact only. **(rec)** No extra click, matches Discord.
   - b. A one-line hint under the share button, chosen by browser and OS.
   - c. A first-time explainer sheet.
5. **When `restrictOwnAudio` is not honoured** (Chrome or Edge before 141 on Windows, with system audio ticked): the call's own voices go out again.
   - a. Publish anyway.
   - b. Drop the share's audio, publish the video, and tell the sharer "Update your browser to share system sound". **(rec)** Privacy first: others' voices are never re-sent.
   - c. Publish with a warning to use headphones.
6. **The answer on #37 and the native-app path.**
   - a. Close #37 with the in-app signal, and link the roadmap's desktop app (W10) for game and app sound. **(rec)**
   - b. Pull W10's share-audio part forward as its own wave.
   - c. A Linux `pactl` helper on the web (design spec :747). Not recommended: it needs a native helper anyway.

## Global Constraints

- **Models** (a task's `Model:` line is binding):

  | Task | Implementer | Reviewer |
  |---|---|---|
  | T1 capture hints and restrictOwnAudio | opus | **opus** |
  | T2 session state (shareAudio, tile screenAudio) | opus | **opus** |
  | T3 UI mark and notice | sonnet | sonnet |
  | T4 e2e | opus | **opus** |
  | T5 stream volume (only if Q2 = b) | sonnet | **opus** |
  | T6 docs and reply | haiku | sonnet |

  T1, T2 and T4 are opus because they sit on the capture and publish path beside the E2EE manager and the AFK listen-only rules. They change neither, and their reviews must confirm that.
- **Reservations:** no server change (`internal/`, `cmd/` untouched); no migration (schema 20), client store 5, wire 2, browser ABI 11, no gateway op, no permission bit, no voice_state bit, no new error code.
- **Strings:** new keys only, under `voice.shareAudio.*` and `stage.noSound`, in `packages/web/src/strings/en.ts`. Flow doc 06 (`docs/design/flows/06-voice.md`) gets the rows. Copy is lowercase-first as the surrounding `voice.*` keys are.
- **Icon:** vendor Lucide **1.57.0** `volume-x` into `packages/ui/src/Icon/icons.ts` (the file header's version), and nothing else.
- **E2EE invariant:** no file under `packages/media/src/manager.ts`, `packages/media/src/worker/`, `packages/media/src/slots.ts`, `internal/` or `core/` changes. `git diff --stat` in every task proves it.
- **Lane:** `/home/thim/.cache/dilla-w3/i37`, branch `fix/37-stream-audio`; one lane, tasks sequential. Gate script env: `CARGO_TARGET_DIR=/home/thim/.cache/dilla-w3/i37-target`, `GOCACHE=/home/thim/.cache/dilla-w3/i37-gocache`. The lane has no `node_modules`: run `npm ci` once.
- **Gate macros:** G-web, G-ui and G-voice(spec) exactly as defined in `docs/superpowers/plans/2026-10-16-dilla-web-3-7.md` § Gate macros (:245-258). G-voice needs `cargo build -p dilla-testkit --release --locked` and `npm run build -w @dilla/web` first.
- **Ports:** no new e2e port; the tests extend `e2e/voice/share.spec.ts` on the voice config (8481/8482, SFU 7884/7886).

## Review Focus

1. **The call never hears itself through a share.** A system-audio share must carry `restrictOwnAudio: true`. Where the browser ignores it, the outcome is Q5's answer (rec: no audio published). Pinned in T1 (`devices.test.ts` `the share asks the browser to leave out the call's own sound`, `a system share whose browser ignores restrictOwnAudio publishes no audio`) and T2 (`session.test.ts` `an unrestricted system audio track is stopped, not published`).
2. **A silent share is never silent about it.** For video-only, `shareAudio === 'none'`, and on the viewer the tile's `screenAudio === false`. When the sharer stops, both clear. A late `screen_share_audio` publication turns the mark off. Pinned in T2 (`session.test.ts` `a tile says whether its screen carries sound` and `…follows a late audio publication`) and T4 (`share.spec.ts` "a share without sound says so on both sides").
3. **Nothing new can publish in AFK.** The listen-only call still refuses share before `getDisplayMedia`, and the new code adds no publish path. Pinned in T2 (`session.test.ts` `a listen-only call refuses share before the picker`, with `getDisplayMedia` never called), and by the existing `TestAFKShareIsRefused`, which stays green.
4. **Deafen and volume still govern share audio.** Deafened → the share audio is not attached, and the mark is about the stream, not about the viewer's deafen. Pinned by the existing `session.test.ts:573` and `:1184` cases (they must stay green), plus T2 `the mark does not change when the viewer deafens`.
5. **The tab path keeps working.** `share.spec.ts:82` stays green in every task that touches capture (T1, T2, T4).

---

## Phase 1: client

### Task T1: Ask for every sound the browser can give, never the call's own

**Model:** opus; reviewer opus. **Depends on:** —.

**Files:**
- Modify: `packages/media/src/audio/presets.ts:43-49` (`SCREEN_AUDIO_CAPTURE` gains `restrictOwnAudio: true`); add `SCREEN_DISPLAY_HINTS` below it; export both from `packages/media/src/index.ts` (check the existing export of `SCREEN_AUDIO_CAPTURE`).
- Modify: `packages/web/src/call/devices.ts:68-77` (`acquireScreen`).
- Test: `packages/web/src/call/devices.test.ts:60-80`, `packages/media/test/audio-presets.test.ts`.

**Interfaces:**
- Produces:
```ts
// packages/media/src/audio/presets.ts
export const SCREEN_AUDIO_CAPTURE: MediaTrackConstraints & { restrictOwnAudio?: boolean };
export const SCREEN_DISPLAY_HINTS: {
  systemAudio: 'include'; windowAudio: 'system'; selfBrowserSurface: 'exclude'; surfaceSwitching: 'exclude';
};
// packages/web/src/call/devices.ts
export type ShareAudioKind = 'tab' | 'system' | 'none';
export async function acquireScreen(media: DisplayMedia):
  Promise<{ video: MediaStreamTrack; audio: MediaStreamTrack | null; audioKind: ShareAudioKind }>;
```
- `audioKind`: `'none'` when no audio track came back. Otherwise `'tab'` when `video.getSettings().displaySurface === 'browser'`, else `'system'`.
- Q5 (rec b): when `audioKind === 'system'` and `audio.getSettings().restrictOwnAudio !== true`, the audio track is stopped, and the result is `{ audio: null, audioKind: 'none', unrestricted: true }`. Add `unrestricted?: true` to the return type, so T2 can say "update your browser". If Jonas answers a or c, drop this branch and the test, and keep the flag for c.

- [ ] **Step 1: write the failing tests** (`devices.test.ts`; extend the `track` double with `getSettings`):
```ts
const vtrack = (surface: string) => ({ kind: 'video', stop: vi.fn(), getSettings: () => ({ displaySurface: surface }) }) as unknown as MediaStreamTrack;
const atrack = (restrict?: boolean) => ({ kind: 'audio', stop: vi.fn(), getSettings: () => (restrict === undefined ? {} : { restrictOwnAudio: restrict }) }) as unknown as MediaStreamTrack;

it('the share asks the browser to leave out the call\'s own sound, and for every audio it offers', async () => {
  const getDisplayMedia = vi.fn(async () => stream(vtrack('browser'), atrack(true)));
  await acquireScreen({ getDisplayMedia });
  expect(getDisplayMedia).toHaveBeenCalledWith({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, restrictOwnAudio: true },
    systemAudio: 'include', windowAudio: 'system', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude',
  });
});
it('a tab share with sound is tab audio', async () => {
  const a = atrack();
  expect(await acquireScreen({ getDisplayMedia: async () => stream(vtrack('browser'), a) })).toMatchObject({ audio: a, audioKind: 'tab' });
});
it('a restricted screen share with sound is system audio', async () => {
  const a = atrack(true);
  expect(await acquireScreen({ getDisplayMedia: async () => stream(vtrack('monitor'), a) })).toMatchObject({ audio: a, audioKind: 'system' });
});
it('a system share whose browser ignores restrictOwnAudio publishes no audio', async () => {
  const a = atrack();
  const r = await acquireScreen({ getDisplayMedia: async () => stream(vtrack('window'), a) });
  expect(r).toMatchObject({ audio: null, audioKind: 'none', unrestricted: true });
  expect(a.stop).toHaveBeenCalled();
});
it('a screen without audio is none', async () => {
  expect(await acquireScreen({ getDisplayMedia: async () => stream(vtrack('monitor')) })).toMatchObject({ audio: null, audioKind: 'none' });
});
```
  Replace the old `SCREEN_AUDIO_EXPECTED` assertions (:71, :76, :80) with these. In `audio-presets.test.ts`, assert `SCREEN_AUDIO_CAPTURE.restrictOwnAudio === true` and the exact `SCREEN_DISPLAY_HINTS`.
- [ ] **Step 2: run, expect FAIL.** `npm test -w @dilla/web -- devices`; `npm test -w @dilla/media -- audio-presets`.
- [ ] **Step 3: implement.**
```ts
export async function acquireScreen(media: DisplayMedia): Promise<ScreenCapture> {
  const stream = await media.getDisplayMedia({ video: true, audio: { ...SCREEN_AUDIO_CAPTURE }, ...SCREEN_DISPLAY_HINTS } as DisplayMediaStreamOptions);
  const video = stream.getVideoTracks()[0];
  if (video === undefined) { stopAll(stream); throw Object.assign(new Error('E_UNAVAILABLE: no screen track'), { name: 'NotFoundError' }); }
  const audio = stream.getAudioTracks()[0] ?? null;
  if (audio === null) return { video, audio: null, audioKind: 'none' };
  if (video.getSettings().displaySurface === 'browser') return { video, audio, audioKind: 'tab' };
  if ((audio.getSettings() as { restrictOwnAudio?: boolean }).restrictOwnAudio !== true) {
    audio.stop();
    return { video, audio: null, audioKind: 'none', unrestricted: true };
  }
  return { video, audio, audioKind: 'system' };
}
```
  The comment above it replaces "Chromium only, decision 10" with the per-OS facts and links of the Root cause, item 2.
- [ ] **Step 4: run, expect PASS.** Then the gates: G-web; `npm test -w @dilla/media`; `npx eslint --max-warnings 0 packages/web/src/call packages/media/src/audio`; G-voice(share.spec.ts) chromium. `git diff --stat` lists only presets.ts, index.ts (if touched), devices.ts and the two tests.
- [ ] **Commit:** `fix(web,media): a screen share asks for every sound the browser offers and never the call's own (#37)`.

### Task T2: The session knows whether a share carries sound

**Model:** opus; reviewer opus. **Depends on:** T1.

**Files:**
- Modify: `packages/web/src/call/session.ts`:
  - `PageCallTile` (:29-37) gains `screenAudio: boolean`;
  - `PageCallState` (:38-75) gains `shareAudio: 'tab' | 'system' | 'none' | null` and `shareAudioUnrestricted: boolean`;
  - `tiles()` (:613-629);
  - `setSharing` (:1066-1107);
  - `stopScreen` (:1013-1023);
  - the initial state (:544-545);
  - `onSubscribed`/`onUnsubscribed` already call `refresh()` through `onPeople`. Also refresh on the room's track published/unpublished events, so a publication that is not subscribed yet still turns the mark (add `EV.trackPublished`, `EV.trackUnpublished` beside :1183-1186 if not present).
- Test: `packages/web/src/call/session.test.ts` (fixture: `f.subscribeTrack(p, 'screen_share_audio')` at :2329 and :2694 shows the helper; add a `f.publishOnly(p, source)` double if the fixture has none).

**Interfaces:**
- Consumes: `acquireScreen` → `{ video, audio, audioKind, unrestricted? }` (T1).
- Produces: `PageCallState.shareAudio`, `PageCallState.shareAudioUnrestricted`, `PageCallTile.screenAudio`, all read by T3.
- `screenAudio` is true when `p.getTrackPublication('screen_share_audio')` exists. It is computed only when `show` is true (an 'ok' tile, not paused), like `screen`, and is false otherwise.

- [ ] **Step 1: write the failing tests:**
  - `a share without sound says so` (getDisplayMedia double returns video only): after `setSharing(true)`, `state.shareAudio === 'none'`, one `publishTrack` (video), and `shareAudioUnrestricted === false`.
  - `a tab share with sound publishes it as screen_share_audio`: `shareAudio === 'tab'`, and the second `publishTrack` has `source: 'screen_share_audio'` and the `screenAudioOptions(caps)` bitrate.
  - `an unrestricted system audio track is stopped, not published`: T1's `unrestricted` result gives `shareAudioUnrestricted === true`, `shareAudio === 'none'`, and no audio `publishTrack`.
  - `stopping the share clears shareAudio`: back to `null` and `false`.
  - `a tile says whether its screen carries sound`: remote bob with `screen_share` only → `tiles[0].screenAudio === false`; add the `screen_share_audio` publication → `true`.
  - `the tile mark follows a late audio publication and an unpublish`.
  - `the mark does not change when the viewer deafens` (deafen → `screenAudio` stays true; the track is not attached: the existing `:573` and `:1184` assertions).
  - `a listen-only call refuses share before the picker`: `listenOnly: true`, `setSharing(true)` rejects `E_FORBIDDEN`, and `getDisplayMedia` is not called. Check whether a test of that name exists from VOICE-AFK; if so, extend it with the `getDisplayMedia` assertion.
  - Run `npm test -w @dilla/web -- session`; record the failures.
- [ ] **Step 2: implement.** In `setSharing`, take `tracks.audioKind` and `tracks.unrestricted`. Publish exactly as today (:1085-1086). Then:
  - `set({ sharing: true, localScreen: viewOf(tracks.video), shareAudio: published ? tracks.audioKind : 'none', shareAudioUnrestricted: tracks.unrestricted === true })`, where `published` is false when `permitted('screenAudio')` was false.
  - In `stopScreen`, `set({ sharing: false, localScreen: null, shareAudio: null, shareAudioUnrestricted: false })`.
  - In `tiles()`, `screenAudio: show && p.getTrackPublication?.(SOURCE.screenAudio) !== undefined`. Extend `RemoteView`'s type with `getTrackPublication?(source: Source): unknown` where it is declared (near :300-312).
- [ ] **Step 3: gates.** G-web; `npx eslint --max-warnings 0 packages/web/src/call`; G-voice(share.spec.ts join-muted.spec.ts controls.spec.ts) chromium and firefox. `git diff --stat -- packages/web/src/call packages/media` lists only `session.ts` and `session.test.ts`.
- [ ] **Commit:** `feat(web): a call knows whether a share carries sound, on both sides (#37)`.

### Task T3: The mark on the screen tile and the sharer's notice

**Model:** sonnet; reviewer sonnet. **Depends on:** T2, and Jonas's answers to Q3 and Q4 (the defaults below are the recommendations).

**Files:**
- Modify: `packages/ui/src/Icon/icons.ts`: vendor Lucide 1.57.0 `volume-x` after `volume-2` (:209). Copy the SVG body from the Lucide 1.57.0 package, the same way as `volume-2`.
- Modify: `packages/ui/src/CallTile/CallTile.tsx`:
  - `CallTileProps` (:22-52) gains `silent?: boolean` (only read when `source === 'screen'`);
  - `labels.state` gains `noSound: string`;
  - `statesOf` (:62-76) pushes `{ key: 'no-sound', glyph: <Icon name="volume-x" size={14} />, text: labels.noSound, glyphOnly: true }` after `screen` when `source === 'screen' && silent`.
- Modify: `packages/ui/src/CallTile/CallTile.test.tsx` and its stories (a "screen without sound" story).
- Modify: the stage in `packages/web/src/screens/voice/VoiceView.tsx`: find where screen tiles render `CallTile source="screen"`, and pass `silent={!tile.screenAudio}` for remote tiles only, never the own `localScreen` tile.
- Modify: `packages/web/src/screens/voice/useCall.tsx` or VoiceView: when `state.shareAudio` turns `'none'` from `null`, announce `voice.shareAudio.none` once through the existing polite `announce`. When `shareAudioUnrestricted`, announce `voice.shareAudio.update` instead.
- Modify: `packages/web/src/strings/en.ts` (after :498):
```ts
  'stage.noSound': 'no sound',
  'voice.shareAudio.none': 'Your screen is shared without sound. To share sound, share a browser tab, or on Windows tick "Also share system audio".',
  'voice.shareAudio.update': 'Your screen is shared without sound: update your browser to share system sound without echo.',
```
- Modify: `docs/design/flows/06-voice.md`: the two notices and the tile state, in that doc's table form.
- Test: `VoiceView.test.tsx` (`a remote screen without sound shows the mark; with sound it does not; the own screen never does`) and `useCall.test.tsx` or `VoiceView.test.tsx` (`a share without sound is announced once`).

- [ ] **Step 1: red tests** (CallTile: `data-state="no-sound"` present only for `source="screen" silent`; VoiceView and useCall as listed). Run `npm test -w packages/ui -- CallTile` and `npm test -w @dilla/web -- VoiceView useCall`.
- [ ] **Step 2: implement.**
- [ ] **Step 3: gates.** G-ui; G-web; `npm run check:copy`; `npm run check:docs`; `npm run check:css`. Screenshot the stage at 1440×900 and 390×844 with a silent screen tile. Show the shots to Jonas before the commit leaves the lane (jonas-phone-app-shell rule: shots first).
- [ ] **Commit:** `feat(ui,web): a screen tile without sound says so, and the sharer is told how to share sound (#37)`.

## Phase 2: e2e

### Task T4: share.spec pins the silent share on both sides

**Model:** opus; reviewer opus. **Depends on:** T3.

**Files:** `e2e/voice/share.spec.ts`.

- [ ] **Step 1: add a test** `a share without sound says so on both sides` (Chromium; the worker's browser with the fake picker):
  - Before alice's share, an init script on alice's page wraps `MediaDevices.prototype.getDisplayMedia` so the stream's audio tracks are stopped and removed. That is what a Linux window share returns. The wrapper also records the options it was called with on `globalThis.__dmOpts`.
  - Alice clicks share. Expect alice's live region to contain `copy('voice.shareAudio.none')`. Expect bob's `screenTile(bob.page, 'alice')` to have a `.d-call-tile__state[data-state="no-sound"]`.
  - Expect `__dmOpts` to match `{ systemAudio: 'include', windowAudio: 'system', audio: { restrictOwnAudio: true } }`.
  - Stop; the mark and the tile go.
- [ ] **Step 2: extend** `a shared tab's sound is heard by the other browser` (:82): after `audible(bob.page)`, expect no `no-sound` state on bob's screen tile and no `voice.shareAudio.none` notice on alice.
- [ ] **Step 3: show red.** Run with T3's `silent` prop forced false (a local edit, not committed): the new test fails on the mark. Revert, then green.
- [ ] **Step 4: gates.** G-voice(share.spec.ts) chromium; then the whole voice project chromium and firefox (G-voice). `npm run typecheck:e2e`.
- [ ] **Commit:** `test(e2e): a share without sound says so to the sharer and the viewer (#37)`.

## Phase 3: optional, by answer

### Task T5 (only if Q2 = b): A stream volume and mute per person

**Model:** sonnet; reviewer opus (it changes the gain path that deafen relies on).

**Files:**
- `packages/web/src/call/volume.ts`: `gainOf` gains `source: 'voice' | 'stream'`, and the stream reads `voice.streamVolume.<user>`, default 100.
- `packages/web/src/call/session.ts`: `applyGains` (:652-658) sets the `screenAudio` gain from the stream volume; `setVolume(userId, volume, source?)`.
- `packages/web/src/call/session.test.ts`, `volume.test.ts`.
- `packages/ui/src/CallTile/CallTile.tsx`: a mute toggle on a remote screen tile with sound.
- Strings: `stage.streamMute`, `stage.streamUnmute`, `stage.streamVolume`.
- Settings key: `voice.streamVolume.<user>` (the settings value cap is 1024 bytes; one number per key).

**Tests:**
- `deafen still silences the stream at any stream volume`;
- `a stream volume of 0 holds the share audio back and leaves the voice playing`;
- `the voice volume does not move the stream`.

**Gates:** G-web, G-ui, G-voice(share.spec.ts controls.spec.ts). **Commit:** `feat(web,ui): a volume and a mute for each person's stream`.

## Phase 4: docs

### Task T6: Docs and the issue reply

**Model:** haiku; reviewer sonnet. **Depends on:** T3 (T5 if built).

**Files:**
- `docs/user/voice.md:190-191`: replace "The only sound a share carries is a tab's, … a whole screen or window is shared without sound" with the per-browser facts:
  - Chrome and Edge share a tab's sound everywhere;
  - on Windows and ChromeOS, a screen's or a window's system sound when you tick "Also share system audio"; on macOS 14.2+ with Chrome 141+ too;
  - Linux shares only tab sound;
  - Firefox and Safari share no sound;
  - a game or app's own sound needs the desktop app (planned);
  - the call's own sound is never shared.
- `docs/user/voice.md:346`, `README.md:57` (limits) and the README web-client row ("screen sound from a Chromium tab only") likewise, in one sentence each.
- Re-shoot the stage screenshot in docs/user if it shows a screen tile (jonas-user-docs rule).
- Write the reply to #37 into the PR description: the cause, what changed, and the native-app path (Q6). The controller posts it after merge.

**Gates:** `npm run check:docs`; `npm run check:copy`. **Commit:** `docs(user): what sound a screen share carries, per browser (#37)`.

## After the tasks (controller)

- A whole-branch review (opus), with the E2EE invariant check: `git diff main...HEAD --stat` touches nothing under `packages/media/src/manager.ts`, `packages/media/src/worker/`, `packages/media/src/slots.ts`, `internal/`, `cmd/` or `core/`.
- A manual check on Windows (Chrome 141+, Jonas or a tester): share "Entire screen" with "Also share system audio" while bob speaks. Alice's share must not carry bob's voice back (`restrictOwnAudio`). Share a window: the system audio toggle is offered (`windowAudio: 'system'`).
- Release as a patch on the web3.9 line. Tell the Homelab session to upgrade CT 144 (jonas-homelab-deploys-releases).

### Critical Files for Implementation
- `packages/web/src/call/devices.ts:68-77`
- `packages/media/src/audio/presets.ts:27-49`
- `packages/web/src/call/session.ts:29-75, 613-629, 1013-1023, 1066-1107`
- `packages/ui/src/CallTile/CallTile.tsx:22-76`
- `e2e/voice/share.spec.ts:82-147`
