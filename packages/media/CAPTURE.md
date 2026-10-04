# Capture facts for the desktop wave

This wave ships the browser audio surface (`src/audio/`). Electron capture is dilla-desktop's
(follow-up card 8). The facts below were verified on 2026-09-30 against Electron **44.5.1**
(Chromium 152.0.7977.130), a documented target only: it is not a dependency of `packages/media`.
They are written here so the desktop wave does not freeze a wrong constant.

## Screen-share audio on Electron (DEV-30 … DEV-35, recorded)

| # | Spec text (L504) | What the desktop wave does |
|---|---|---|
| DEV-30 | `audio: 'loopbackWithMute'` | Windows 11: `callback({ video: { id: source.id, name: source.name }, audio: 'loopback' })` plus `getDisplayMedia({ video, audio: { restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })`; `'loopbackWithMute'` only as an explicit Windows 10 choice ("share audio (mutes your speakers)") |
| DEV-31 | "Electron-verified Windows-only" | Documented Windows-only; Linux/macOS behaviour is SP-34 (card) |
| DEV-32 | gate on build ≥ 20348 | Gate on build 22000 through the `restrictOwnAudio` capability probe: `track.getCapabilities().restrictOwnAudio?.includes(true)` (`[false]` on Win10, `[false, true]` on Win11). Chromium: `IsWindowsProcessLoopbackCaptureSupported() = GetVersion() >= Version::WIN11` |
| DEV-33 | WASAPI add-on for per-process audio | No add-on: `'applicationLoopback:' + pid`, validated with `/^\d+$/` first (the parser `CHECK`s the colon and `StringToUint`; a malformed id crashes the audio service); HWND → root PID with `user32!GetWindowThreadProcessId` and Chrome's same-executable ancestor walk (small FFI) |
| DEV-34 | pactl helper "captured as a device" | Add `module-remap-source` over the sink monitor (enumeration skips monitor sources) — recipe below |
| DEV-35 | macOS video only | CoreAudio Tap on macOS 14.2+ (default since Electron v39.0.0-beta.4; needs `NSAudioCaptureUsageDescription`; opt-out `disable-features=MacCatapLoopbackAudioForScreenShare`) |

Chromium device ids: `"loopback"`, `"loopbackWithMute"`, `"loopbackWithMuteCast"`, `"loopbackWithoutChrome"`,
`"loopbackAllDevices"`, `"applicationLoopback:<pid>"`, `"restrictOwnAudioBrowserLoopback"`. Windows
version constants: `WIN10_21H2 = 19` (19044), `WIN10_22H2 = 20` (19045), `SERVER_2022 = 21` (20348),
`WIN11 = 22` (22000).

Linux helper (pipewire-pulse 1.6.9 arguments verified; end to end is SP-34):

```sh
pactl load-module module-null-sink sink_name=dilla_share sink_properties=device.description=dilla-share
pactl -f json list sink-inputs
pactl move-sink-input <index> dilla_share
pactl load-module module-loopback source=dilla_share.monitor sink=@DEFAULT_SINK@ latency_msec=20
pactl load-module module-remap-source master=dilla_share.monitor source_name=dilla_share_src source_properties=device.description=dilla-share-capture
# renderer: getUserMedia({ audio: { deviceId: { exact: <id of "dilla-share-capture"> }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } })
# teardown: pactl unload-module C; pactl unload-module B; pactl unload-module A
```

`restrictOwnAudio` is not applied on Linux: call voices leak into a Linux system-audio share.

## Publish constants (this wave, `src/audio/presets.ts`)

- Mic: `MIC = { source: Microphone, audioPreset: { maxBitrate: 64_000, priority: 'high' }, dtx: true, red: false, forceStereo: false }`.
- Screen audio: `SCREEN_AUDIO = { source: ScreenShareAudio, audioPreset: { maxBitrate: 96_000 }, forceStereo: true, dtx: false, red: false }` (ruling F2) with capture `{ echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 }`.

## Content-Security-Policy minimum

An AudioWorklet inherits the owner document's policy container: `addModule` is checked against
`script-src-elem` → `script-src` → `default-src`, and wasm compilation needs `'wasm-unsafe-eval'`
(or `'unsafe-eval'`) in `script-src` (else `default-src`), or it throws `WebAssembly.CompileError`.
dillad sets no SPA CSP today. The minimum the web build needs, and the Electron build carries in a
`<meta http-equiv>` or through `session.webRequest` (it loads no HTML from dillad):

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'
```

`e2e/media/audio.spec.ts` asserts the worklet's compile fails under `script-src 'self'` and succeeds
with `'wasm-unsafe-eval'` added.

## SP-36 — echo with WebAudio playback (manual; "Needs verification" NV-4)

Two machines with speakers, Chromium 153, one dilla call through the harness page
(`npm run harness -w @dilla/media`, `http://<host>:5179/`):

1. Machine A plays remote audio through `<audio>` elements (the livekit-client default). Machine B
   speaks a fixed 30 s passage; A records its own outgoing mic (`MediaRecorder` on the processed
   track) while its speakers play B.
2. Repeat with A's Room built with `webAudioMix: { audioContext }` and a `GainNode` per remote user
   at gain 1.0.
3. Repeat both on a non-default output device (Room sets element `sinkId` as the crbug 40252911
   workaround; WebAudio uses `AudioContext.setSinkId`).
4. Repeat with `echoCancellation: true` and `echoCancellation: 'all'` in the capture constraints.

Record per leg the residual echo of B's passage in A's recording (RMS in dBFS over the passage,
measured offline with `sox <file> -n stats`). Pass: the WebAudio legs are no worse than the
element legs by more than 3 dB. The result decides whether the spec's "playback via WebAudio with
per-user volume" (L502) is safe; until it is run, client-core keeps `<audio>` elements.
