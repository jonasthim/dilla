# Flow 06 — voice, DM calls, sounds and media players

This flow extends Flow 04's shell order and Flow 05's overlays: skip link → rail → channel list (with `active voice` above the channels, and the voice dock above the user panel) → header → ring banner (while a ring lasts) → stage → log → composer → status bar. Chrome labels use lower case; dialog copy uses sentence case; nothing ends in an exclamation mark. *Voice* names a channel's room and *call* names a DM or group-DM call only. Every visible phrase below comes from the Copy section, with `{name}` filled from the contact's display name or username, `{names}` a comma-separated list of them, `{where}` the voice channel's name or the DM's name, and `{n}` a count. Frame boxes describe width constraints, not pixel-perfect components.

The media key never appears in this flow: the browser derives it in the core worker, hands it to the page once per epoch and the page hands it to the media worker (decision 3). Nothing on screen says "encrypted"; the call code is the one visible trust surface, behind a closed disclosure (decision 9).

## States

| state | shown | worker fact | announcement |
|---|---|---|---|
| idle | voice rows with `voice.join` on focus or hover; no dock | `call.phase` idle | none |
| no one in voice | the row shows no sub-rows and no count; the stage says `voice.empty` | `voice[channel]` absent | none |
| live, not joined | the row shows `voice.count` and one sub-row per person with their state words; `voice.join` / `call.join` | `voice[channel]` has participants, `call.phase` idle | none |
| joining | dock shows `voice.dock.connecting`; the stage controls appear but stay `aria-disabled` | `call.phase` joining | none |
| connected | dock shows `voice.dock.connected`; tiles for everyone; the toolbar is live | `call.phase` in | `voice.announce.joined` |
| reconnecting | dock shows `voice.dock.reconnecting`; tiles keep their last state | page room reconnecting, `call.phase` in | none |
| blocked before join | `voice.blockedChanged` (exactly one changed contact in the call roster) or `voice.blockedJoin`; no join button until the cause is gone | `call.phase` blocked, `call.error.code` E_UMK_CHANGED (with `call.changedUser`) or another block code | the notice (focus moves to it once) |
| blocked mid-call | `voice.blocked`; the dock and stage go away; the row returns to live, not joined | `call.phase` blocked, own leaf left | the notice (focus moves to it once) |
| paused mid-call (RV-3) | banner `voice.paused` on the stage and the dock with its `voice.pausedAction` button; dock says `voice.dock.paused`; tiles show no media, only names and state words; camera and share buttons `aria-disabled` | `call.phase` paused, `call.error.code` E_UMK_CHANGED, `call.changedUser` the changed contact, still in the group and the room, no keys posted | the banner (`role="status"`; focus moves to its button once); `voice.resumed` when it ends |
| removed | `voice.removed`; the dock goes away | `call.phase` removed | the notice |
| full | `voice.full` (or `voice.sharersFull` when the camera or share is refused) | `call.error.code` E_CALL_FULL / E_CALL_SHARERS_FULL | the notice |
| failed | `voice.failed` with the join button available again | `call.phase` failed (also E_DEVICE_LIST_STALE after one refresh, RV-1) | the notice |
| microphone denied | `voice.micDenied`; joined listen-only | `getUserMedia` NotAllowedError | the notice |
| microphone missing | `voice.micMissing`; joined listen-only | `getUserMedia` NotFoundError | the notice |
| microphone failed | `voice.micFailed`; joined listen-only | the page call's `mic` is `failed` (`E_MIC_PUBLISH`: the microphone exists but could not be published; added 2026-10-13, task-8b review m4) | the notice |
| unsupported browser | dialog `voice.unsupported.title` / `voice.unsupported.body` with `voice.unsupported.close` | a required API (insertable streams or `RTCRtpScriptTransform`, `AudioWorklet`) is missing | dialog title |
| other tab | `voice.otherTab`; no join | Flow 05's other-tab state | the notice |
| incoming ring — normal | ring banner `call.ring.incoming` with `call.ring.answer` and `call.ring.decline`; the ring sound plays; a desktop notification `call.ring.notifyTitle` / `call.ring.notifyBody` when the tab is hidden | `rings` holds the ring, `busy` and `quiet` false | `role="alert"` once |
| incoming ring — busy | ring banner `call.ring.busy`; no sound, no notification; answering leaves the current voice first | `rings` entry with `busy` true | `role="alert"` once |
| incoming ring — quiet | ring banner `call.ring.incoming`; no sound, no notification (R1) | `rings` entry with `quiet` true (the DM is muted) | `role="alert"` once |
| outgoing ring | the DM's call strip says `call.outgoing.ringing`; a decline adds `call.outgoing.declined`; when every ring has ended without an answer, `call.outgoing.noAnswer`; no ringback tone (R3) | `call.outgoing` | strip text through the dock's status region |
| attachment player — idle | the attachment card shows `media.play` and `media.save` | `AttachmentSummary.kind` audio or video, not `tooLarge` | none |
| attachment player — loading | `media.loading` in place of the play button | the page is opening the blob | none |
| attachment player — ready | the native `<audio controls>` or `<video controls playsinline>` with the file's shown name as its accessible name; playback starts only on the explicit play | a page-minted `blob:` URL, revoked on unmount | none |
| attachment player — error | `media.error` with `media.save` | the element fired `error`, or the blob did not open | the error text |
| Settings → Notifications → sounds | two switches, `settings.sound.voice` and `settings.sound.ring`, both on by default | `sound.voice`, `sound.ring` (L-TS-54) | none |

A ring reaches only an open dilla tab (R8). A ring ends on every device of that user at the first of: one of their devices joins, they decline, the call ends, or 30 seconds pass (R5); the banner, the sound and the notification all stop then. Each other participant of a group DM is rung independently (R6). A muted DM rings with the banner only (R1). A device already in a call shows the busy banner and plays nothing.

How a block code maps to copy:

- At join: `E_UMK_CHANGED` → `voice.blockedChanged` when exactly one contact in the call roster is changed, else `voice.blockedJoin`.
- Mid-call: `E_UMK_CHANGED` → phase `paused` and `voice.paused` with the changed contact's name (the first by `user_id` when several changed); `voice.pausedAction` opens Privacy's comparison for that contact.
- Any other block → `voice.blocked` mid-call and `voice.blockedJoin` at join.
- `E_DEVICE_LIST_STALE` (phase `failed`, a list that could not be fetched, ruling RV-1) → `voice.failed` at join; mid-call it shows nothing new (media for the new epoch waits for the refresh).

Amended 2026-10-13 (controller ruling I2, task 1 review): the `{name}` of `voice.paused` and `voice.blockedChanged` comes from `call.changedUser`, the 32-hex user id of the changed contact that the worker sets for phase `paused` and for an `E_UMK_CHANGED` join refusal (the first by `user_id` when several changed), and is null otherwise. The page looks the name up as for any contact. At join, "exactly one changed contact" means the worker named one; `voice.blockedJoin` is shown when `changedUser` is null.

## 1280×800

The `ACTIVE VOICE` heading (`voice.heading.active`, shown in caps by the token style) lists the live voice channels of the community above the channel list. Each voice row has sub-rows for the people in it. The dock sits above the user panel while this device is in voice. The stage fills the main pane. A ring banner sits at the top of the main pane, above the stage or the log.

```text
┌──┬──────────────────────┬───────────────────────────────────────────────────────────────────────────────┐
│◆ │ACTIVE VOICE          │┌─────────────────────────────────────────────────────────────────────────────┐│
│  │ ◉ harbour       2    ││ Ada is calling                                     [answer] [decline]       ││
│  │   ada  speaking      │└─────────────────────────────────────────────────────────────────────────────┘│
│  │   bo   muted         │ voice harbour                                                  ▸ call code    │
│  │                      │ ┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐ │
│  │channels              │ │                       │ │                       │ │                       │ │
│  │ # general            │ │          ada          │ │          bo           │ │          you          │ │
│  │ # build              │ │       speaking        │ │         muted         │ │                       │ │
│  │voice                 │ │ volume for ada ──●──  │ │ volume for bo ───●──  │ │                       │ │
│  │ ◉ harbour       2    │ └───────────────────────┘ └───────────────────────┘ └───────────────────────┘ │
│  │ ◉ workshop           │                                                                               │
│  │                      │        [mute] [deafen] [camera] [share screen] [leave]   ← call controls      │
│  │┌────────────────────┐│                                                                               │
│  ││in harbour          ││                                                                               │
│  ││▮▮▮▮▮▮▯▯▯▯▯▯        ││                                                                               │
│  ││[mute] [deafen]     ││                                                                               │
│  ││[leave]             ││                                                                               │
│  │└────────────────────┘│                                                                               │
│  │ web · online         │                                                                               │
└──┴──────────────────────┴───────────────────────────────────────────────────────────────────────────────┘
```

The disclosure `voice.code` is closed by default. Opened, it shows the call code as 6 groups of 5 digits and `voice.codeHelp` under it; Escape closes it.

**DM call.** A call strip sits under the conversation header: `call.start` when no call is live, `call.join` when one is, and `call.outgoing.ringing` while this device's call rings others. While in the call, the stage sits above the log at 40 % of the main pane's height; the log and composer stay usable below it.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ @ ada                                                                        │
│ ringing ada                                                          [call]  │
│ ┌─────────────────────────────────────────────────────────────────────────┐  │
│ │  ada  connecting          you                         ▸ call code       │  │  40 %
│ │        [mute] [deafen] [camera] [share screen] [leave]                  │  │
│ └─────────────────────────────────────────────────────────────────────────┘  │
│ log …                                                                        │
│ composer                                                                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Players.** Inline in the attachment card. A video is at most 480×270 CSS px on desktop; audio is the native control bar at the card's width.

```text
│ ┌──────────────────────────────────────────────┐ │
│ │ harbour-walk.webm · 12.4 MB                  │ │
│ │ ┌──────────────────────────────────────────┐ │ │
│ │ │                (480×270)                 │ │ │
│ │ │ ▶ ━━━━━━━━━━━━━━━━━━━━━━ 0:00  vol  full │ │ │
│ │ └──────────────────────────────────────────┘ │ │
│ │ [save]                                       │ │
│ └──────────────────────────────────────────────┘ │
```

## 360×740

The stage is full width. The dock lives in the sidebar sheet, above the user panel. Every voice control is at least 44×44 CSS px. The ring banner is fixed at the top of the viewport while a ring lasts and never covers the stage controls (the content moves down).

```text
┌────────────────────────────────────┐
│ Ada is calling                     │
│ [answer]            [decline]      │
├────────────────────────────────────┤
│☰ voice harbour        ▸ call code  │
│┌──────────────────────────────────┐│
││               ada                ││
││             speaking             ││
││ volume for ada ───────●───       ││
│└──────────────────────────────────┘│
│┌──────────────────────────────────┐│
││               bo                 ││
││              muted               ││
│└──────────────────────────────────┘│
│                                    │
│ [mute] [deafen] [camera] [leave]   │
│ [share screen]                     │
└────────────────────────────────────┘
```

The sidebar sheet (opened with `☰`) holds the dock above the user panel while this device is in voice:

```text
┌────────────────────────────────────┐
│ACTIVE VOICE                        │
│ ◉ harbour                      2   │
│   ada  speaking                    │
│   bo   muted                       │
│channels                            │
│ # general                          │
│voice                               │
│ ◉ harbour                      2   │
│                                    │
│┌──────────────────────────────────┐│
││in harbour                        ││
││▮▮▮▮▮▮▯▯▯▯▯▯                      ││
││[mute]   [deafen]   [leave]       ││
│└──────────────────────────────────┘│
│ web · online                       │
└────────────────────────────────────┘
```

**DM call on the phone.** The stage is full screen with a `messages` toggle that shows the log and composer in its place; the call strip stays under the header.

**Players on the phone.** A video takes the full card width at 16:9; audio is the native control bar at the card's width. Nothing scrolls horizontally at 360 CSS px.

## Keyboard map

| starting focus | action | destination |
|---|---|---|
| anywhere, while in voice | Control/⌘+Shift+M | toggles mute; focus stays; `voice.announce.muted` / `voice.announce.unmuted` |
| anywhere, while in voice | Control/⌘+Shift+D | toggles deafen; focus stays; `voice.announce.deafened` / `voice.announce.undeafened` |
| anywhere, page focused, push to talk on, focus not in an editable field | hold the push-to-talk key | microphone open while held; `preventDefault`, so nothing is typed; in a text field, `contenteditable` or `select` the key does nothing to the microphone and keeps its usual effect |
| dock or stage toolbar | Left/Right arrows | previous/next control (roving focus); Home/End first/last |
| into a toolbar | Tab | the toolbar's last-focused control, then out on the next Tab |
| `voice.code` disclosure | Enter/Space | opens or closes; Escape closes and returns focus to it |
| unsupported dialog | Escape | closes; focus returns to the join button |
| push-to-talk capture prompt (`settings.voice.pttPrompt`) | one non-text key on its own: F13–F24, Pause, ScrollLock or Insert | that key is saved; any other key, and any key held with Control, Alt, ⌘, Shift or AltGr, is refused with `settings.voice.pttRefused` and the capture goes on; Escape cancels; Tab leaves and cancels |
| ring banner | Tab from the main landmark's start | `call.ring.answer`, then `call.ring.decline`, before any other control of the main landmark |
| attachment player | Enter/Space on `media.play`, then the browser's native controls | the native player |

There is no single-key shortcut (decision 1, WCAG 2.1.4): mute and deafen need Control/⌘ and Shift. The push-to-talk key has no default and acts only while dilla is the active tab (decision 2). These shortcuts do not interrupt IME composition. The settings rows show `keyboard.mute` and `keyboard.deafen`, each followed by `keyboard.muteAction` / `keyboard.deafenAction`, as `keyboard.searchAll` is followed by its action. The dock's and the stage's mute and deafen buttons carry `aria-keyshortcuts` (`Control+Shift+M Meta+Shift+M`, `Control+Shift+D Meta+Shift+D`).

Amended 2026-10-13 (controller rulings on the task-7 review, M4 and M9):
- **Shortcut spelling (M4).** The mute and deafen shortcuts follow the web-2c convention of the existing Control/⌘+K entry: the same spelling (`Control/⌘+Shift+M`, `Control/⌘+Shift+D`) and the same mac mapping (Control or ⌘ works on every platform). `keyboard.mute` and `keyboard.deafen` below are aligned to it.
- **Push-to-talk key (M9, superseded 2026-10-13 below).** The capture refuses a key that types text or moves focus without Control, Alt or ⌘: letters, digits, space, punctuation (with or without Shift), dead and IME keys, Enter, Backspace, Delete, the arrows, Home, End, PageUp and PageDown. Accepted are non-text keys (F1–F24, Pause, ScrollLock, Insert and the like) and any key held with Control, Alt or ⌘. Push to talk never acts while focus is in an editable field (a text input, `textarea`, `select` or `contenteditable`), so the key is never swallowed while someone types.

Amended 2026-10-13 (controller ruling on the task-8b review, I2; supersedes the M9 ruling above): **the push-to-talk key is one non-text key pressed on its own**, F13 to F24, Pause, ScrollLock or Insert. `voice.pttKey` stores a `KeyboardEvent.code` alone, so a combination could never be matched: a key that types text (AltGr included), moves focus or has a browser function (F1–F12) is refused with or without Control, Alt or ⌘, and any of these keys held with Control, Alt, ⌘, Shift or AltGr is refused too. Push to talk binds only such a key and ignores a press with a modifier held. `settings.voice.pttRefused` is reworded to match.

## Focus rules

| transition | focus destination | polite status |
|---|---|---|
| join | the first stage control | `voice.announce.joined` |
| answer a ring | the first stage control, as for a join | `voice.announce.joined` |
| leave | the voice row (or the DM's `call.start`) the call came from | `voice.announce.left` |
| block notice appears (before join or mid-call) | the notice, once | the notice text |
| pause starts (RV-3) | the banner's `voice.pausedAction` button, once | `voice.paused` |
| pause ends | unchanged | `voice.resumed`, once, in the dock's status region |
| a ring starts or ends | unchanged: a ring never moves focus | `role="alert"` once at start |
| the unsupported dialog closes | the join button | none |

## Announcements

One `role="status"` region in the dock announces join, leave, mute, deafen and the end of a pause; the paused banner itself is `role="status"`. An incoming ring is announced once through `role="alert"` and never moves focus. Speaking is shown as an outline plus the word `voice.state.speaking`; the 2 s pulse runs only without `prefers-reduced-motion: reduce`, and the 12-bar meter redraws every 120 ms in every mode. Muted, deafened, camera and screen are a glyph plus a word.

## Sounds

Every sound is synthesised at runtime (no sound file ships), under 300 ms, and obeys Settings → Notifications → sounds.

| sound | plays when | never plays when |
|---|---|---|
| join tick | another user's device joins the call this device is in | the person's own join; deafened; `sound.voice` off; no user activation yet on this page |
| leave tick | another user's device leaves the call this device is in | the person's own leave; deafened; `sound.voice` off; no user activation yet |
| ring | an incoming ring that is neither busy nor quiet: a 2 × 120 ms ping every 2 s for at most 30 s, stopping when the ring ends | busy (already in a call); quiet (the DM is muted, R1); `sound.ring` off; no user activation yet |

There is no sound for one's own join, leave, mute or deafen (R2), and no ringback tone for the caller (R3). In Settings → Notifications, a `settings.notify.sounds` group holds two rows, `settings.sound.voice` and `settings.sound.ring`, each an on/off switch, both on by default (R4).

## Copy

Every key below is one string of `packages/web/src/strings/en.ts`, byte for byte (task 9 checks it).

*Sidebar, rows and dock:*
- `voice.heading.active='active voice'`, `voice.heading.channels='voice'`
- `voice.open='voice {name}'`, `voice.count='{n} in voice'`, `voice.join='join voice'`
- `call.start='call'`, `call.join='join call'`
- `voice.dock.region='voice controls'`, `voice.dock.connecting='connecting'`, `voice.dock.connected='in {where}'`, `voice.dock.reconnecting='reconnecting'`
- `voice.mute='mute'`, `voice.unmute='unmute'`, `voice.deafen='deafen'`, `voice.undeafen='undeafen'`, `voice.leave='leave'`
- `voice.cameraOn='camera'`, `voice.cameraOff='stop camera'`, `voice.shareOn='share screen'`, `voice.shareOff='stop sharing'`
- `voice.controls.region='call controls'`

*Participant states:*
- `voice.state.speaking='speaking'`, `voice.state.muted='muted'`, `voice.state.deafened='deafened'`
- `voice.bot.canHear='can hear'` (shown with the bot tag on a bot's sub-row in the voice list, so a bot that can hear is visible before joining; added 2026-10-13, task-7 review I5)
- `voice.state.notHeard='not heard yet'`, `voice.state.unverified='unverified stream'`, `voice.state.connecting='connecting'`
- `voice.state.video='camera on'`, `voice.state.screen='sharing screen'`

*Announcements:*
- `voice.announce.joined='You joined {where}.'`, `voice.announce.left='You left {where}.'`
- `voice.announce.muted='Microphone muted.'`, `voice.announce.unmuted='Microphone on.'`
- `voice.announce.deafened='Sound off.'`, `voice.announce.undeafened='Sound on.'`

*Stage and call code:*
- `voice.code='call code'`
- `voice.codeHelp='The code changes whenever someone joins or leaves. Read it aloud: if every screen shows the same code, everyone is hearing the same set of devices.'`
- `voice.empty='Nobody is in voice yet.'`, `voice.tiles='people in voice'`, `voice.volume='volume for {name}'`
- `voice.volumeValue='{n} %'` (the volume range's spoken value, `aria-valuetext`; added 2026-10-13, task-7 review M6)

*Refusals and notices:*
- `voice.blocked='A device in this voice failed the identity check, so you left. Joining stays paused until it is removed.'`
- `voice.blockedJoin='A device in this voice failed the identity check. Joining is paused until it is removed.'`
- `voice.blockedChanged='{name}’s identity changed. Compare safety numbers in Privacy before joining.'`
- `voice.paused='{name}’s identity changed, so this call is paused for you: nothing you say is sent and nothing is played. Compare safety numbers in Privacy to continue, or wait until {name} leaves.'` (RV-3; the banner on the stage and the dock, `role="status"`, focus moves to its `compare safety numbers` button once)
- `voice.pausedAction='compare safety numbers'`
- `voice.resumed='The call continues.'` (announced once in the dock's status region when the pause ends)
- `voice.dock.paused='paused in {where}'`
- `voice.removed='You were removed from voice.'`
- `voice.full='This voice is full.'`
- `voice.sharersFull='Too many people are sharing. Try again when someone stops.'`
- `voice.failed='Could not join voice. Try again.'`
- `voice.otherTab='Voice is open in another tab of this browser.'`
- `voice.micDenied='The microphone is blocked. You can listen; allow the microphone in the browser to talk.'`
- `voice.micMissing='No microphone found. You can listen.'`
- `voice.micFailed='The microphone could not be connected. You can listen.'` (added 2026-10-13, task-8b review m4)
- `voice.unsupported.title='Voice does not work in this browser'`
- `voice.unsupported.body='This browser lacks a feature dilla needs for voice. Use a current Chromium-based browser or Firefox.'`
- `voice.unsupported.close='Close'`

*Ringing:*
- `call.ring.region='incoming calls'`, `call.ring.incoming='{name} is calling'`
- `call.ring.busy='{name} is calling. Answering leaves {where}.'`
- `call.ring.answer='answer'`, `call.ring.decline='decline'`
- `call.ring.notifyTitle='{name} is calling'`, `call.ring.notifyBody='Open dilla to answer.'`
- `call.outgoing.ringing='ringing {names}'`, `call.outgoing.declined='{name} declined.'`, `call.outgoing.noAnswer='No answer.'`

*Media players:*
- `media.play='play {name}'`, `media.loading='loading'`
- `media.error='This browser cannot play this file.'`, `media.save='save'`

*Settings:*
- `settings.nav.voice='voice'`, `settings.voice.section='Voice'`
- `settings.voice.input='input device'`, `settings.voice.output='output device'`, `settings.voice.systemDefault='system default'`
- `settings.voice.outputUnsupported='This browser plays voice on the system default device.'`
- `settings.voice.mode='input mode'`, `settings.voice.vad='voice activity'`, `settings.voice.ptt='push to talk'`
- `settings.voice.pttKey='push-to-talk key'`, `settings.voice.pttNone='no key set'`, `settings.voice.pttSet='set key'`
- `settings.voice.pttPrompt='Press the key to use. Escape cancels. It works only while dilla is the active tab.'`
- `settings.voice.pttRefused='That key types text, moves the focus or needs another key. Use one key on its own, such as Pause, Scroll Lock, Insert or F13 to F24.'` (added 2026-10-13, task-7 review M9; reworded 2026-10-13, task-8b review I2)
- `settings.voice.noise='noise suppression'`, `settings.voice.level='input level'`
- `settings.notify.sounds='sounds'`, `settings.sound.voice='join and leave sounds'`, `settings.sound.ring='ring for calls'`

*Keyboard:*
- `keyboard.mute='Control/⌘+Shift+M'`, `keyboard.deafen='Control/⌘+Shift+D'` (aligned 2026-10-13 to `keyboard.searchAll='Control/⌘+K'`, task-7 review M4)
- `keyboard.muteAction='mute or unmute'`, `keyboard.deafenAction='deafen or undeafen'`
