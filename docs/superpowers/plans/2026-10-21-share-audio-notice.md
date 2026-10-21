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
