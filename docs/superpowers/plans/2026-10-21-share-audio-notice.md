# The share-audio notice names what this browser can do: plan

**Context:** Jonas, testing v0.1.0-web3.9.1 on Linux, 2026-10-21:
> "Your screen is shared without sound. To share sound, share a browser tab, or on Windows tick 'Also share system audio'. I dont have any option for that?"

The single string `voice.shareAudio.none` (`packages/web/src/strings/en.ts:515`) gives advice that can't work on his platform:
- Firefox (and Firefox-based browsers) and Safari capture no audio from `getDisplayMedia` at all (bugzilla 1541425).
- Chromium on Linux offers only a tab's sound ("Also share tab audio" in the tab picker). There is no system audio.
- Chromium on Windows and ChromeOS, and on macOS 14.2+ with Chrome 141+, can share a screen's system sound.

The capabilities are already documented at `packages/web/src/call/devices.ts:72-80`.

## Task FX1 (sonnet): one notice per platform
- **Pure function:** add `shareAudioAdvice(env): 'unsupported' | 'tab-only' | 'tab-or-system'` in `packages/web/src/call/devices.ts`, with `env = { ua: string; uaPlatform?: string; brands?: string[] }`.
  - Firefox (`Firefox/` or `Gecko/` without `Chrome/`) and Safari (`Safari/` without `Chrome/` or `Chromium/`) → `unsupported`.
  - Chromium-family browsers, detected from `navigator.userAgentData.brands` when present or else a `Chrome/` or `Edg/` UA:
    - on Windows or ChromeOS → `tab-or-system`;
    - on macOS → `tab-or-system`, because the picker shows the checkbox only where it works;
    - on Linux and anything else → `tab-only`.
- **Unit test:** a table over real UA strings for Firefox Linux, Zen (Firefox-based), Safari macOS, Chrome Linux, Chrome Windows, Edge Windows, Chrome macOS and Chrome OS.
- **Copy:** replace `voice.shareAudio.none` with three keys. Update flow 06, its test and the strings test.
  - `voice.shareAudio.none.unsupported` 'Your screen is shared without sound. This browser can't share sound; Chrome or Edge can share a browser tab with its sound.'
  - `voice.shareAudio.none.tabOnly` 'Your screen is shared without sound. Here only a browser tab can carry sound: share a tab and keep "Also share tab audio" ticked.'
  - `voice.shareAudio.none.tabOrSystem` 'Your screen is shared without sound. To share sound, share a browser tab, or tick "Also share system audio" when you pick a screen.'
- **Wiring:** `useCall.tsx`, where the notice is said, picks the key from `shareAudioAdvice(navigator)`. The fake client and the tests follow.
- **Tests:** `useCall.test.tsx` checks that the notice for each advice uses its key. On the e2e side, `share.spec` (Chromium on Linux in CI) expects the tab-only text if it asserts the notice.
- **Docs:** `docs/user/voice.md` gets the same three cases in its screen-sharing section.
- **Gates:** web vitest for devices, useCall and strings; typecheck; check:copy; check:docs; e2e `share.spec` on chromium-voice if you changed it.
- **Release:** a client-only patch, v0.1.0-web3.9.2. Its notes say the store, schema and wire are unchanged.

## Task FX2 (sonnet, opus review): a "sound from" picker for a share
Jonas, 2026-10-21. He asked how Discord shares sound on Linux. The answer: its native desktop app captures it, and the browser cannot. He chose **Add a "sound from" picker**.

- **What it does:** when a share is running, or when one starts without sound, the person can choose any audio input as the stream's sound. The list comes from `navigator.mediaDevices.enumerateDevices()`, audio inputs only. On Linux it includes PipeWire/Pulse "Monitor of …" devices (Firefox lists them), and any virtual source carrying one app.
- **Tracks:**
  - The chosen device is opened with `getUserMedia({ audio: { deviceId: { exact }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } })`.
  - It is published as the screen share's audio track: the same publication slot as tab or system audio, source `screen_share_audio`, E2EE like every track. Watchers then get it through the existing per-person stream volume and mute.
  - Choosing "none" unpublishes it.
  - The track ends when the share ends.
  - A browser-captured tab or system sound always wins. The picker shows only when the share has no sound (`audioKind: 'none'`), or as "replace sound" in a menu.
- **Echo warning:** if the device label matches `/^Monitor of /i` or contains "monitor", the picker warns: `voice.shareAudio.monitorWarn` 'This device carries all your computer's sound, including this call: others will hear themselves. Route only the app you want to a separate device (see help).' Picking it is still allowed.
- **The mic is never offered:** the device the call's mic uses is excluded from the list.
- **Permission:** a browser that hasn't granted mic permission shows unlabeled devices. The call already holds mic permission, so labels exist. If labels are missing, show `voice.shareAudio.needsPermission`.
- **UI:** in the share controls (CallControls, the share menu or tile popover; follow the phone popover pattern from #37 T3/T5), add a "sound from" Select with "none", then the devices. Its state is `screenAudio.source` (`'browser' | deviceId | null`).
- **Notice:** `voice.shareAudio.none.*` from FX1 gains a second sentence for each case: 'You can also pick a sound source for the stream.' The button `voice.shareAudio.pick` 'pick a sound source' opens the Select.
- **Docs:** add a `docs/user/voice.md` section, "Share sound from Firefox or Linux". It covers picking a monitor, why that echoes, and how to route one app with PipeWire: `pw-loopback` or `pactl load-module module-null-sink` plus the app's output, with qpwgraph or pavucontrol to move the app.
- **Copy keys** (`voice.` prefix, flow 06 and its test): `voice.shareAudio.from` 'sound from', `.fromNone` 'none', `.pick`, `.monitorWarn`, `.needsPermission` 'Allow the microphone to see sound sources.'
- **Tests:**
  - session: publish, replace and unpublish of the picked track;
  - it ends with the share;
  - a browser sound already present hides the picker;
  - the monitor warning shows by label;
  - the call mic is excluded.
- **e2e:** on chromium-voice with a fake audio device (`--use-fake-device-for-media-stream`), pick a device and check that the watcher gets a screen-share audio track.
- **Gates:** web vitest (session, useCall, VoiceView, strings); ui vitest for the touched components; typecheck; check:copy; check:docs; e2e share.spec on chromium.
