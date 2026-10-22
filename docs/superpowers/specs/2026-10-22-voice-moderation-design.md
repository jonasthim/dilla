# Voice moderation and the app-wide right-click menu: design

Date: 2026-10-22. Roadmap item: W7 "Voice moderation" (docs/superpowers/specs/2026-10-14-discord-parity-roadmap.md:135), without timeout and soundboard, widened the same day to dilla's own right-click menu across the whole app. Base: main at `29e2219f`.

Status: **buildable.** This document merges the original design with its three layer designs (server, client-core, UI and web) under the binding rulings of 2026-10-22. Every name, number, byte, class, key and string in it is a decision. An implementer who finds that the code contradicts it stops and asks; nobody improvises.

How to read it:

- §1–§10 are the design: intent, goals, the decisions and who made them, what main has today, how it works end to end, the one registry of names, and compatibility.
- §11 is the one task list, in dependency order, with lanes, tiers and tests.
- §12 is the open questions (empty).
- Appendix S (server), Appendix C (client-core and media) and Appendix U (UI and web) hold the per-layer recipes: signatures, SQL, CBOR shapes, truth tables, copy, sketches and test lists. References into them read `§S.4.3`, `§C.6.5`, `§U.5.1.2`.

Markers: **(Jonas)** is Jonas's decision. **(my call)** is the orchestrator's call, kept from the original design and from the rulings. **(merge call)** is a conflict between the layer designs that the rulings did not cover, resolved while merging; each one is listed in §5.3 so it can be reviewed.

## Contents

1. [Intent](#1-intent)
2. [Goals](#2-goals)
3. [Non-goals](#3-non-goals)
4. [Anti-goals](#4-anti-goals-failure-even-if-it-works)
5. [Decisions](#5-decisions)
6. [What exists on main](#6-what-exists-on-main-recon-of-29e2219f)
7. [How it works, end to end](#7-how-it-works-end-to-end)
8. [Names: the one registry](#8-names-the-one-registry)
9. [Compatibility with older clients](#9-compatibility-with-older-clients)
10. [Release, docs and gates](#10-release-docs-and-gates)
11. [Tasks](#11-tasks)
12. [Open questions](#12-open-questions)
- [Appendix S: server](#appendix-s-server)
- [Appendix C: client-core and media](#appendix-c-client-core-and-media)
- [Appendix U: UI and web](#appendix-u-ui-and-web)

---

## 1. Intent

Jonas wants dilla to manage people in voice the way Discord does, and to have Discord's right-click menu everywhere. Someone with the right rights:

- drags a person from one voice channel onto another to move them;
- right-clicks any person to get Discord's person menu;
- right-clicks anything else that has a Discord menu (a message, a link, an attachment, a channel, a voice channel, a category, a server icon, a DM row) and gets dilla's menu for it, not the browser's.

His words: "move people between voice channels by dragging", "just like discord, if you have the admin rights to do so", "the same custom right-click function as discord", all of Discord's items ("All."), and "Do it as discord" for where the menu appears. The same day he widened the scope: **dilla's own right-click menu replaces the browser's across the whole app, like Discord (Jonas).** The browser's menu stays only where dilla's would take something away: in text inputs, over a selection, in empty areas, and on Shift+right-click (ruling 9, my call).

The rule for every open choice: **do what Discord does**. Deviate only where dilla's end-to-end encryption, or a feature dilla does not have, makes Discord's behaviour impossible or dishonest. Where it does, say so in the UI copy or the user docs, never silently.

## 2. Goals

1. **Drag to move.** On a desktop, drag a person under a voice channel in the channel list onto another voice channel, and they are moved.
   - The moved person gets no prompt. Their app leaves the old call and joins the new one by itself through its normal join, then shows `Moved to {channel}` (no `#`: voice channels are never drawn with one).
   - You can drag yourself to switch channel. That needs only the normal right to view and connect to the target.
   - Phones and touch have no drag; there, **move to** lives in the menu sheet (ruling 11, my call).
2. **The app-wide context menu.** Right-click opens dilla's menu on every surface that has one; Shift+F10 and the ContextMenu key open it on the focused element; on a phone a long-press (500 ms) opens it as a bottom sheet. The surfaces (§U.4):
   - **person**: people under voice channels in the channel list, member list rows, message authors (name and avatar), user mentions, call tiles (camera and screen);
   - **message**, **link**, **attachment** (card and lightbox image);
   - **channel** (text and announcement), **voice-channel**, **category**, **server** (the rail icon), **dm** (DM list rows).
   The browser's menu stays in text inputs and the composer, over a non-empty selection, on elements with no dilla menu (empty areas), and on Shift+right-click (ruling 9, my call).
3. **The person menu, in Discord's order and groups.** Labels are lower case (dilla's chrome rule). Each item shows only when it applies (truth table §U.5.1.3):
   - **profile**, **mention**, **message**, **compare safety numbers**. Compare safety numbers is dilla's trust action from today's member menu and sits right after message (my call).
   - **mute for me** and the **volume** slider, only while you are in the same call. Both are local to this device, never sent (`voice.localMute.<hex>`, `voice.volume.<hex>`).
   - **server mute** and **server deafen**, as checkable items.
   - **move to ›**, a submenu of the voice channels both you and they may view and connect to, never the current channel and never the AFK channel.
   - **disconnect**.
   - **roles ›**, a submenu of checkable roles.
   - **kick** and **ban**, which already exist as profile-card actions.
   - **copy user ID**, always shown (my call: dilla has no developer mode, and the ID is harmless).
   - **Your own row** shows what Discord shows for yourself: no message, no compare, no local items. Server mute, server deafen, move to and disconnect show when you hold the rights. Move to and disconnect on your own row, while this device is in that call, are your own channel switch and your own leave.
   - **The server owner's row never offers voice moderation to anyone else (Jonas).** On the owner's own row the owner sees only their own switch and leave, never server mute or deafen. Roles on the owner's row follow today's roles rank rule: hidden for everyone but the owner (ruling 5, Jonas). `voiceModAccess` encodes this, so no UI filters it again (§C.9.2).
4. **The other menus.** Message, link, attachment, text channel, voice channel, category, server icon and DM row get Discord's items that dilla can offer (§U.5.2–§U.5.9); the rest are listed with the reason they are left out (§U.5.10).
5. **Server mute and server deafen.** These are state on the community member, like Discord's.
   - They stay across channels and calls until a moderator undoes them.
   - The person sees that a moderator muted or deafened them and can't undo it themselves: their mute and deafen controls are held (`aria-disabled`, pressed, with the reason).
6. **Indicators.** Server-muted and server-deafened people get their own glyphs on voice rows and call tiles, distinct from self-mute and self-deafen by a box and the danger colour (never colour alone), as in Discord. Mute for me gets its own glyph too.
7. **Audit log.** Every move, disconnect, server mute and unmute, and server deafen and undeafen writes an audit row naming the moderator, the person, and the channels (§S.6).

## 3. Non-goals

These are not in this version:

- timeout;
- soundboard;
- channel user limits;
- stage channels;
- priority speaker;
- notes on users;
- nickname changes from the menu (`manageNicknames` exists but is not wired);
- reordering channels by drag (it stays move up and down);
- **moving someone into the AFK channel (Jonas).** It never appears in move to, a drop onto it is refused, and the instance answers 400. dilla's AFK channel hosts no call, so "move to AFK" would mean "disconnect and mark away", which Jonas did not take (ruling 4);
- **message links and mark unread (ruling 10, my call)**, because dilla has neither a message route nor a way to move the read marker back;
- the other Discord items dilla has no feature for (forward, apps, report, notes, friends, block, close DM and the rest): the full list with reasons is §U.5.10.

## 4. Anti-goals (failure even if it works)

- **The instance decides what a client joins only within the client's own rights.**
  - A move never puts anyone into a channel's call group they could not join themselves: the moved person must hold view and connect on the target, and so must the mover.
  - The moved client joins through its normal join path (`callLeave 'switch'`, then `callJoin`), with the normal checks and its own MLS join.
  - LiveKit's server-side `MoveParticipant` is never used: it would put a device into a room whose call group it is not in.
  - Media is never unencrypted, and keys are never handed out by the server.
- **No claim stronger than the truth.**
  - Server deafen asks the SFU to stop forwarding audio to the person. They stay in the call's MLS group and hold its key, and a modified client can resubscribe until the instance's next pass, at most about 30 s at a time. protocol/08 states this, and no copy claims they can't hear (Jonas: "Audio only, like Discord").
  - Server mute is enforced by the SFU: the publish grant loses the microphone and screen-share audio. The person's own client can't undo it.
  - A move the instance had to enforce (the device did not leave in time) is shown as what it was, never as "moved".
- **No drag-only paths.** Everything a drag does is reachable by keyboard and screen reader through the menu (**move to ›**). The menu opens with Shift+F10 and the ContextMenu key on any focused element that has one. The WCAG bar of the existing UI holds: axe clean in all three themes, 44 px targets on phones, focus always returned.
- **No silent fallbacks.** A move to an older client that can't follow it tells the mover what happened, as an announcement and a warning banner: "Disconnected {name} instead: their app can't be moved." A refused move is never treated as done.
- **Never take the browser's menu where it is needed.** Text editing (spellcheck, paste, input methods), a selection (copy, look up, translate, assistive extensions) and Shift+right-click keep the browser's menu.

## 5. Decisions

### 5.1 Jonas's decisions

| # | Decision |
|---|---|
| J1 | **Moves take no consent.** The moved person's app switches by itself and shows `Moved to {channel}`. Following Discord, the notice doesn't name the mover; the audit log does. |
| J2 | **All of Discord's person items** (goal 3). |
| J3 | **Menu everywhere, long-press sheet on phones** ("do it as discord"). |
| J4 | **App-wide right-click:** dilla's menu replaces the browser's across the whole app, like Discord. |
| J5 | **No rank check on voice actions ("Like Discord"), and the owner is never targeted by others.** Anyone holding the right can server mute, deafen, move or disconnect anyone in voice, themselves included, but never the server owner. On the owner's own row the owner sees only their own switch and leave items. Kick, ban and roles keep today's rank check; roles on the owner's row are hidden for everyone but the owner (ruling 5). |
| J6 | **Server deafen is audio only ("Audio only, like Discord").** The deafened person stops receiving audio but still sees camera and screen share. Deafen implies mute, as in Discord. |
| J7 | **The AFK channel is never a move target** (ruling 4): not in move to, a drop is refused, and the instance answers `400 E_INVALID_REQUEST`. |

### 5.2 My calls (original design and rulings)

| # | Decision |
|---|---|
| D1 | **Rights follow Discord.** Move Members (bit 22) allows move to, drag and disconnect. Mute Members (bit 21) allows server mute. **A new Deafen Members bit 24** allows server deafen; it is added in Go and TS together, the vectors are updated, and it is channel-overridable like 21 and 22. Bits are never renumbered. |
| D2 | **Where a right is checked.** dilla is multi-device: one user can have devices in several live calls of one server. Each such call is a **spot** (§S.1.0). Every voice moderation route acts on every spot, and the caller must hold the right (plus view) in every spot. Moving also needs view and connect on the target for the mover, and view and connect on the target for the moved person. When no spot is in a channel the caller can view, the answer is `409 E_NOT_IN_VOICE`, so a call the caller cannot see is never confirmed. |
| D3 | **Server mute and deafen are community-member state**, stored server-side (`member_voice_moderation`), applied on every call join, and applied live to every room the person is in. Undo also needs them in voice, as in Discord: an unmute of someone in no call is `409 E_NOT_IN_VOICE`, and the state stays. |
| D4 | **Server mute strips the microphone and screen-share audio** (`sfu.WithoutAudio`), applied at every grant point: the token mint, the `/rtc` gate, every grant reconcile and the share route. Otherwise a muted person could talk through system audio. Video and screen video are unaffected (ruling 7). |
| D5 | **Server deafen is done by unsubscribing**, because LiveKit's subscribe grant is all-or-nothing. The instance applies `UpdateSubscriptions(…, false)` on every join, on every new audio track, on every grant reconcile of the room, and in the 30 s room sweep. Our own client also unsubscribes its remote audio while server-deafened, and `speakers.ts` never resubscribes it (ruling 6). |
| D6 | **A move is a new server-to-client signal, op 57 `voice_move`**, sent to each of the person's devices in a source call that advertises identify caps bit 1. Each device leaves and joins the target through its normal join. A device still in its source room 10 s later is cut by the instance with pending reason 3 (the cut lands 10–15 s after the move, on the 5 s retry tick). A device without the bit is disconnected at once, and the mover is told how many (`[moved, disconnected]`). |
| D7 | **Disconnect** removes all of the person's devices from every spot, under each call's lock, with pending reason 4 for capable devices. A disconnected device may join again at once, as in Discord. |
| D8 | **Copy user ID is always shown.** |
| D9 | **Dragging yourself** switches your own channel with only the normal connect right; it is a client-side leave and join and never calls the move route. The move route always requires `move_members`, on yourself too. |
| D10 | **Wire names follow the server design** (ruling 1): op 56 `voice_moderation`, op 57 `voice_move`, pending reasons 3 and 4, `409 E_NOT_IN_VOICE`, the three routes under `/v1/communities/{id}/members/{user_id}/voice`, and the snapshot rows' fourth element `mod`. client-core keeps its own names for the commands `voiceMove`, `voiceDisconnect`, `serverMute`, `serverDeafen`, the event `call.move {to, seq}`, `voiceModAccess`, and the setting `voice.localMute.<hex>`. |
| D11 | **The move capability is identify caps bit 1** (ruling 2). The calls-survive-upgrade branch owns bit 0 (`withdrawn_rows`). Its identify-capability reading is ported under the same names (`Frame.Caps`, `conn.caps`, `admits`, `registerCaps`, lenient parsing). |
| D12 | **Migration `00024_voice_moderation.sql` with schema file `022_voice_moderation.sql` for now** (ruling 3). If calls-survive-upgrade (also 00024) merges first, renumber on rebase to the next free ones; the schema tests expect the next number. |
| D13 | **Copy follows dilla's rules** (ruling 8): menu labels lower case; notices and refusals sentence case with a full stop, except the two stage notices `Moved to {channel}` and `Disconnected by a moderator`, which follow `afk.moved` (no full stop); no `#` before voice channel names; no "encrypted", "encryption", "E2EE", "end-to-end" or "MLS" in UI strings (`check:copy`); typographic apostrophes. The two "Has no effect in this version." permission hints are rewritten (§U.9.6). New strings use the prefixes `person.menu.`, `voice.mod.` and `menu.`; permission copy keeps `perm.`. |
| D14 | **The browser's menu stays** in text inputs, over a selection, in empty areas, and on Shift+right-click (ruling 9). dilla's menus offer no "copy" over a selection; the message menu has its own **copy text**, which copies the whole message. |
| D15 | **Left out:** message links and mark unread (ruling 10), with the rest of §U.5.10. |
| D16 | **No drag on phones or from touch** (ruling 11). A long-press is the menu; move to lives in the sheet. |
| D17 | **A move's automatic join reuses the old call's audio context** (ruling 12), so the target call's audio is not blocked for want of a user gesture. If the session cannot keep it, the existing `voice.audioBlocked` path shows. |
| D18 | **e2e browsers** (ruling 13): the menu, sheet and drag-UI specs run on chromium, firefox and webkit, and their names join the webkit `testMatch` whitelist. SFU enforcement and a move landing in the target call run on chromium and firefox (the voice suite). |
| D19 | **Model tiers per task** (ruling 14): server has no opus implementation, and opus reviews S5, S6a and S6b; client-core T6 is on opus; UI W6 is on opus, with opus reviews of W2, W4 and E2. Everything else is sonnet; strings and docs are haiku. |
| D20 | **Mention** inserts `@{username} ` into the current conversation's draft and focuses the composer; with no conversation open the item is hidden (Discord opens nothing). |
| D21 | **Everything the original design left to the builder is decided here:** the route shapes and op numbers (§8), how ActionMenu grows submenus, a slider and a phone sheet (§U.2), how the drag works (§U.6), the exact copy (§U.9), mention (D20), and the task split and order (§11). |

### 5.3 Merge calls (conflicts between the layers that the rulings did not cover)

Names quoted in the "Conflict" column are the rejected spellings. They appear nowhere else in this document and are not to be used.

| # | Conflict | Resolution |
|---|---|---|
| M1 | client-core wanted the call-start answer to carry the caller's own `mod`, so a muted person never tries to publish a microphone; the server design had no such element. | **Adopted.** `POST /v1/channels/{id}/calls` answers 8 elements from this version: element 6 `rung` is always present (`[]` unless the start rang), element 7 is `mod(uint 0..3)` for the caller's user (0 in a DM). Server task S5 (§S.4.5); client task T1 (§C.2). |
| M2 | client-core carried the moderator state of others in op 50 `flags` bits 5 and 6; the server keeps op 50 at 0..31 and sends op 56. | **op 50 stays 0..31 on the wire, and the client's `voiceFlags` check is unchanged.** The client's `VoiceBook` keeps each moderated user's `mod` per community (from op 56 and the snapshot's fourth element) and folds it into its participant rows as `VOICE_FLAG.serverMute` (32) and `VOICE_FLAG.serverDeaf` (64), so every page consumer reads one field (§C.7). |
| M3 | client-core and the UI had a separate refusal `E_TARGET_NO_ACCESS` (the moved person can't join the target); the server answers `403 E_FORBIDDEN` for it and adds no code but `E_NOT_IN_VOICE`. | **No new code.** Every 403 maps to `voice.mod.error.forbidden`, reworded so it names no cause it cannot know: `That isn’t allowed any more: roles or channel permissions changed.` `voice.mod.error.targetNoAccess` stays, used only for the drag's local refusal, where the cause is known. |
| M4 | The server design gave pending reason 3 the copy "Moved by a moderator"; client-core argued the device was not moved. | **A distinct, true notice:** reason 3 says `voice.mod.moveMissed` = `A moderator moved you, but your app didn’t follow in time`; reason 4 says `voice.mod.disconnected` = `Disconnected by a moderator`. |
| M5 | The TS capability names: client-core used `CLIENT_CAPS` and `CAP_VOICE_MOD`, and wanted the identify vector changed to caps 1. | **The calls-survive-upgrade names, as ruling 2 does for Go:** the TS client sends `CAPS`, and the bit is `CAP_VOICE_MOVE = 2` (Go `CapVoiceMove = 1 << 1`). The identify vector in `protocol/vectors/frames.json` keeps caps 0, as on that branch; the gateway test asserts the sent caps separately (§C.12.2). |
| M6 | Two string tests would pin the permission copy: flow 09's test pins every `perm.*` key, and the UI design put `perm.(mute|move|deafen)` in flow 18 too. | **Flow 09 owns `perm.*`.** The four permission lines (§U.9.6) are edited into `docs/design/flows/09-roles-and-private-channels.md`; `strings.flow09.test.ts` goes from 179 to 181 pairs and its lower-case list from 63 to 64. Flow 18 pins `person.menu.`, `voice.mod.` and `menu.` only. |
| M7 | client-core's routes were call-scoped (`/v1/calls/{call}/members/{user}…`, `PUT`/`DELETE …/voice/{mute|deaf}`); ruling 1 took the server's community-scoped routes but kept the command names. | **Command fields follow the routes:** `voiceMove {communityId, userId, toChannelId}`, `voiceDisconnect {communityId, userId}`, `serverMute`/`serverDeafen {communityId, userId, on}`. The worker routes are `moveVoiceMember(communityId, userId, channelId)`, `disconnectVoiceMember(communityId, userId)` and `setServerVoice(communityId, userId, mute, deaf)`. "Gone" is `409 E_NOT_IN_VOICE`, not 404; for disconnect it is success. |
| M8 | client-core registered op 56 in the worker but not in `gateway.ts`, whose ready-phase dispatch only emits listed ops. | `gateway.ts` emits ops 56 and 57 as frames (§C.3); both are droppable. |
| M9 | A move into a full call: the server answers `409 E_CALL_FULL`; no layer had copy for the mover. | New key `voice.mod.error.full` = `{channel} is full. Nobody was moved.` |
| M10 | The UI's drop verdict switched on "self", and `canDrag` re-derived the owner rule. | The verdict switches on `local` (this device is the one in the source call), and Shell's `canDrag` is `!away && (mod.local || mod.move)`, both from `voiceModAccess` (§U.6.2). Dragging your own other device is a move like anyone's. |
| M11 | Ruling 6 needs `speakers.ts` to hold off; no layer owned it as a task. | New task **M1** (packages/media): `SpeakerPolicy.setServerDeafened(on)`; W6 wires it through the session (§C.11). |
| M12 | Ruling 14 names T6 and W6 "on opus" but says nothing of their reviews; the original design's review rule says opus reviews "the move signal and enforcement". | T6 and W6 are reviewed by opus too. All other reviews follow ruling 14. |

## 6. What exists on main (recon of `29e2219f`)

This is the code as it stands, with the original recon's errors corrected.

- **Rights.** `PermMuteMembers` (bit 21) and `PermMoveMembers` (bit 22) are defined in Go (`internal/api/perm.go:24-47`) and TS (`packages/client-core/src/admin/perm.ts`), and nothing checks them. Both are channel-overridable. No deafen bit exists. The TS client masks every permission word with `PERM_ALL = 0xffffff` (`http/routes.ts:119`, used by `bits()` at :296 and `permBits` in `admin/roles.ts:43`), so adding bit 24 without raising the mask to `0x1ffffff` would silently drop it.
- **Rank.** Kick and ban use a rank check (`canModerate` in `packages/web/src/screens/admin/members-model.ts`, mirrored on the server by `outranks`). Today's `menuFor` offers roles on anyone, the owner included.
- **No server-pushed move exists.** The AFK sweep removes participants by calling `h.sfu.RemoveParticipants` directly, without the call's lock (`internal/api/afk.go:740`), and records a pending reason the client reads afterwards (`afk.go:45-79`, `GET /v1/communities/{id}/afk`). It does **not** use `removeDevice` (`internal/api/callgrants.go`), which cuts under the call's lock and leaves a pending cut that the retry loop repeats and the `/rtc` gate honours; moderator cuts use `removeDevice`.
- **Only the page joins a call.** `startPageCall` sends `callJoin` after subscribing to `callKeys` (`worker/protocol.ts:139`), and the page owns LiveKit and the `AudioContext`. A move is therefore offered by the worker (`call.move`) and followed by the page's own switch. `useCall.join(id, made)` expects an `AudioContext` made in a user gesture (`useCall.tsx:639-642`), which a move does not have; hence D17.
- **Publish rights** come from `grantFor` (`internal/api/calls.go:1106`) and `admitGrant`, and change mid-call through `UpdatePermission` (`callgrants.go:315`) from `reconcileOutcome`, which every sync, join and sweep goes through. A comment at `callevents.go:671` notes that `MutePublishedTrack` is useless because a client can unmute itself; server mute must use grants. `sfu.PublishGrant` couples screen-share audio with screen share (`internal/sfu/grants.go`).
- **Subscriptions.** LiveKit sends no webhook on a subscription change, `ListParticipants` does not expose subscriptions, and a client's signal resume re-sends its own subscription state without a webhook. A resubscribe can therefore not be detected, only re-applied (D5). `packages/media/src/audio/speakers.ts` (`SpeakerPolicy`) resubscribes every microphone it excluded.
- **Gateway ops.** Ops 48–55 are all taken (`frames.ts:13`); the next free ones are **56 and 57**, inside the ephemeral range 48–63 (`n = 0`, never replayed). The client accepts op 50 flags 0..31 only: `frames.ts:66` `voiceFlags` drops the whole frame above 31, and `routes.ts:217` throws on a snapshot row above 31, which would blank the voice list. Older clients ignore ops they do not know (`gateway.ts:235` emits only listed ops).
- **Capability bits.** `identify` has carried `caps(uint)` since protocol/02, and the client sends 0 (`gateway.ts:211`); the server ignores it (`internal/gateway/session.go:365` `identifyConnection`). The calls-survive-upgrade branch (`/home/thim/.cache/dilla-w3/upcalls`) builds the reading (`conn.caps`, `Frame.Caps`, `admits`, `registerCaps`) and claims bit 0 and migration 00024. `resume` (op 2) carries no caps, so the instance keeps identify's caps on the connection; the web client never resumes and identifies afresh on every connection.
- **Pending reasons.** Older clients map any pending value ≥ 3 to 2, "You went AFK on another device." (`routes.ts:283-288`). `useCall`'s `sayRemoved` treats every non-1 reason as 2 (the `else` at `useCall.tsx:458`), and the recovery verdict does the same (`:878`).
- **Menus.** `packages/ui/src/ActionMenu` is a WAI-ARIA menu with right-click positioning (`at={x,y}`) and a radio state (`checked` → `menuitemradio`). It has no submenus, no check items, no slider and no phone sheet.
  - The member list's right-click and Shift+F10 open the profile card, not a menu (`MemberList.tsx:70-107`).
  - Voice participant rows (`VoiceChannelRow.tsx:93`) carry `data-row` on their `<li>` but are not interactive; `useRovingFocus` only sees `ul > li > button:first-child` (`internal/roving.ts:21`), and the people sit in a nested `ul`.
  - Kick, ban and roles exist only as profile-card actions (`KickFlow`, `BanFlow`, `MemberRolesFlow` inside `MemberCardHost`). `InviteFlow` (`screens/Create.tsx:454`) is finished but mounted nowhere.
- **Drag:** none in the app. `AppShell/Splitter.tsx` has the pointer-capture pattern.
- **Person actions:** `members-model.ts` `MenuAction` = message, compare, roles, kick, ban. Per-user local volume is the setting `voice.volume.<hex>` (`settings.ts` `voiceVolume(userId)`), applied in `web/src/call/volume.ts` `gainOf`. `endCodeOf` is in `web/src/call/session.ts:283`. `VoiceParticipantView` is in `packages/ui/src/CallTile/CallTile.tsx:19`.
- **Copy rules.** Chrome labels are lower case and notices sentence case (docs/design/flows 04–09; today's member actions are `message`, `kick`, `ban`). Every recent flow pins its strings with a `## Copy` table checked byte for byte by `strings.flowNN.test.ts`. `scripts/check-ui-copy.mjs` forbids the encryption vocabulary outside `strings/privacy.ts`. `perm.mute.hint` and `perm.move.hint` say "Has no effect in this version." (`strings/perm.ts:53,55`).
- **e2e.** `e2e/playwright.voice.config.ts` has chromium and firefox only; `playwright.web.config.ts` runs webkit on a whitelist (`testMatch`).

## 7. How it works, end to end

### 7.1 Server mute (and unmute)

```
mover's page          worker (client-core)         instance                               SFU (LiveKit)
menu: server mute ─▶  serverMute{cid,user,on} ─▶  PATCH …/members/{u}/voice [1,null]
                                                  voiceModTarget → voiceSpotsOf → requireOnSpots(mute_members)
                                                  tx: LockCommunity, owner + rights re-check,
                                                      SetVoiceModeration, audit voice.server_mute
                                                  applyVoiceMod: syncRoomGrants per spot ───▶ UpdateParticipant: no MICROPHONE,
                                                                                                no SCREEN_SHARE_AUDIO (unpublished)
                                                  announceVoiceMod: op 56 [cid,u,1] ─▶ every viewer of each spot, and u
                     ◀─ 200 [1,0] (command → null)
every page:  VoiceBook folds mod into flags → boxed mic-off glyph on row and tile
target page: call.serverMuted = true → session unpublishes mic and screen audio; mute control held;
             announce "A moderator muted you. Only a moderator can unmute you."
```

On join of a muted person: the token is minted without the microphone, the `/rtc` gate admits without it, `participant_joined` reconciles the grant again, the start answer's element 7 sets `serverMuted` before the session publishes anything, and op 56 follows the join's op 50 to the audience.

### 7.2 Server deafen

The same PATCH with `[null,1]` and `deafen_members`. Deafen implies mute (`audioOff = Mute || Deaf`), so the grant drops audio publishing too. Then `deafenRoom` unsubscribes the deafened person's devices from every audio track of everyone else in the room. The instance re-applies it on every join, every audio `track_published`, every room reconcile and every 30 s sweep. The deafened client sets `SpeakerPolicy.setServerDeafened(true)`, which unsubscribes all remote audio and stops the policy resubscribing. Undeafen resubscribes (`undeafenUser`) and the policy re-applies its top-6 cap.

### 7.3 Move

```
mover            instance                                         moved device (worker → page)
move to › ch2 ─▶ POST …/members/{u}/voice/move [ch2]
                 checks (§S.1.3), tx + audit voice.move per source spot
                 capable device: noteMove(dev, deadline +10 s); op 57 [cid, call, ch2] ─▶ worker: VoiceBook untouched;
                 incapable device: modCut(reason 0) now                                  movable? moveTarget? → call.move {to, seq}
           ◀─ 200 [moved, disconnected]                                                  page: join(ch2, keptContext)
"Moved björn to general." (or the warn banner when disconnected > 0)                      = callLeave 'switch' + callJoin ch2
                                                                                           "Moved to general"
                 Admitted(target room, dev) → the move entry is forgotten
                 not left after 10 s → SweepVoiceMoves cuts it, pending reason 3 ─▶ "A moderator moved you, but your app didn’t follow in time"
```

### 7.4 Disconnect

`DELETE …/members/{u}/voice` → audit `voice.disconnect` per spot, then `modCut` of every device under each call's lock, with pending reason 4 for capable devices. The device's room ends `E_REMOVED`; its page reads the pending reason and says `Disconnected by a moderator`.

### 7.5 Drag and keyboard move

The drag is a pointer machine on the channel list (§U.6.3): a 4 px threshold, pointer capture, valid targets highlighted from `voiceModAccess(...).dragTargets`, Escape cancels, an invalid drop announces why. A drop on a valid target calls `voiceMove` (or, for this device's own row, the existing switch). The keyboard path is the same menu: focus the person in the channel list (one tab stop, arrows walk into the people), Shift+F10, **move to**, ArrowRight, Enter.

### 7.6 Opening a menu

One `MenuHostProvider` at the Shell root listens on `document` for `contextmenu`, Shift+F10/ContextMenu `keydown` and touch long-press. It resolves the nearest `[data-menu]` element, finds the innermost registered surface handler, asks it to `build` the menu (null → the browser's menu shows) and renders one `ContextMenu` (popup on desktop, `MenuSheet` on phones) in a portal inside `.d-app-shell` (§U.3).

## 8. Names: the one registry

Every layer uses exactly these spellings. Nothing else names these things.

### 8.1 Wire

| Thing | Name and shape |
|---|---|
| Op 56 | `voice_moderation`, S→C, ephemeral (`n = 0`), ungrouped: `[community_id(bstr 16), user_id(bstr 16), mod(uint 0..3)]`. To every user who may view a call the target is in, and to the target; also after a moderated user's join. Go `gateway.OpVoiceModeration`, `gateway.VoiceModerationPayload`; TS `Op.voiceModeration`, `VoiceModerationFrame`, `voiceModerationOf`. |
| Op 57 | `voice_move`, S→C, ephemeral, ungrouped, device-scoped, delivered only to connections with caps bit 1: `[community_id(bstr 16), call_id(bstr 16), channel_id(bstr 16)]` (leave `call_id`, join `channel_id`). Go `gateway.OpVoiceMove`, `gateway.VoiceMovePayload`; TS `Op.voiceMove`, `VoiceMoveFrame`, `voiceMoveOf`. |
| `mod` | bit 0 `server_mute`, bit 1 `server_deaf`. Go `modBits(m)`. Client-internal fold: `VOICE_FLAG.serverMute = 32`, `VOICE_FLAG.serverDeaf = 64` (never on the wire in op 50). |
| Identify caps | bit 1 `voice_move`: Go `gateway.CapVoiceMove uint64 = 1 << 1`; TS `CAP_VOICE_MOVE = 2`, sent as `CAPS`. Bit 0 is calls-survive-upgrade's `withdrawn_rows` (`CapWithdrawnRows`). |
| Snapshot participant row | `[user_id(bstr16), device_id(bstr16), flags(uint 0..31), mod(uint)]` in `GET /v1/channels/{id}/call` and `GET /v1/communities/{id}/calls`; `mod` is 0 in a DM call. Go `participantRow.Mod`. |
| Call-start answer | `POST /v1/channels/{id}/calls` → `[call_id, group_id, livekit_url, token, ice_servers, caps, rung([user_id]), mod(uint 0..3)]`; `rung` is `[]` unless the start rang. Go `callStartResponse`; TS `CallStarted.mod`. |
| AFK pending reasons | `GET /v1/communities/{id}/afk` element 3: `3` a moderator moved the device and it had not left its call 10 s later; `4` a moderator disconnected the device. Both only to devices whose every online connection set caps bit 1. Go `afkPendingMoved`, `afkPendingModerated`; TS `pendingReason(): 0 \| 1 \| 2 \| 3 \| 4`. |

### 8.2 Routes and errors

| Route | Body | Answer | Right | TS route function | Worker command |
|---|---|---|---|---|---|
| `PATCH /v1/communities/{id}/members/{user_id}/voice` | `[server_mute(0\|1\|null), server_deaf(0\|1\|null)]` | `200 [server_mute, server_deaf]` | `mute_members` for a non-null mute, `deafen_members` for a non-null deaf, in every spot | `setServerVoice(communityId, userId, mute, deaf): Promise<ServerVoice>` | `serverMute`, `serverDeafen` |
| `DELETE /v1/communities/{id}/members/{user_id}/voice` | none | `204` | `move_members` in every spot | `disconnectVoiceMember(communityId, userId): Promise<void>` | `voiceDisconnect` |
| `POST /v1/communities/{id}/members/{user_id}/voice/move` | `[channel_id(bstr16)]` | `200 [moved(uint), disconnected(uint)]` | mover: `move_members` in every spot, view and connect on the target; moved person: view and connect on the target | `moveVoiceMember(communityId, userId, channelId): Promise<VoiceMoveResult>` | `voiceMove` |

| Code | Status | Where |
|---|---|---|
| `E_NOT_IN_VOICE` (**new**, Go `server.CodeNotInVoice`) | 409 | the target has no device in a live call of the community that the caller can view |
| `E_INVALID_REQUEST` | 400 | bad body; target not a voice channel of this community; the AFK channel; already in that channel |
| `E_FORBIDDEN` | 403 | missing right; the owner targeted by another; the moved person cannot join the target |
| `E_NOT_FOUND` | 404 | unknown community, caller or target not a member, a target channel the mover cannot see |
| `E_CALL_FULL` | 409 | the target call is full; nothing moves |
| `E_UNAVAILABLE` | 503 | the SFU did not list a room, or a call's lock was busy |
| `E_BAD_INPUT` | worker | the worker's own validation; nothing was sent |

### 8.3 Permission, store and audit

| Thing | Name |
|---|---|
| Bit 24 | wire/vectors `deafen_members` (16777216); Go `PermDeafenMembers`; TS `PERM.deafenMembers`, `PERM_BY_KEY.deafen`; `PERM_GROUPS` voice = `['connect','speak','video','screen','mute','deafen','move']`; Go `PermAll = 0x1FFFFFF` (33554431); TS `PERM_ALL = 0x1ffffff`. Strings `perm.deafen`, `perm.deafen.hint`. |
| Table | `member_voice_moderation (community_id, user_id, server_mute, server_deaf, updated)` |
| Files | `internal/store/{sqlite,postgres}/migrations/00024_voice_moderation.sql`, `…/schema/022_voice_moderation.sql`, `…/queries/voicemod.sql` |
| sqlc | `GetVoiceModeration`, `UpsertVoiceModeration`, `DeleteVoiceModeration`, `ListVoiceModeration` |
| Store | `store.VoiceModeration{UserID, Mute, Deaf, Updated}`; `Communities.GetVoiceModeration`, `SetVoiceModeration`, `ListVoiceModeration` |
| Audit actions | `voice.server_mute`, `voice.server_unmute`, `voice.server_deafen`, `voice.server_undeafen`, `voice.disconnect`, `voice.move` |

### 8.4 Server symbols

| File | Symbols |
|---|---|
| `internal/api/voicemod.go` (new) | `voiceModReq`, `voiceModTarget`, `voiceSpot`, `voiceSpotsOf`, `requireOnSpots`, `voiceModFor`, `audioOff`, `modBits`, `deafenedIn`, `audioSIDs`, `applyDeafen`, `deafenRoom`, `undeafenUser`, `applyVoiceMod`, `announceVoiceMod`, `voiceModsOf`, `voiceMods`, `auditVoiceMod`, `VoiceModGateway`, `WithVoiceMod`, `moveCapable`, `voiceMoveDeadline`, `voiceMove`, `noteMove`, `clearMove`, `clearMoveIf`, `listsDevice`, `SweepVoiceMoves`, `modCut`, `voiceModStage`, `callStartResponse` (in `calls.go`) |
| `internal/api` fields | `Calls.modGW`, `Calls.moveMu`, `Calls.moves`, `Calls.voiceModHook`; test hook `SetVoiceModHookForTest` |
| `internal/sfu` | `WithoutAudio`, `(*Server).UpdateSubscriptions`, `(*Remote).UpdateSubscriptions`; `CallTokens.UpdateSubscriptions` |
| `internal/gateway` | `OpVoiceModeration`, `OpVoiceMove`, `VoiceModerationPayload`, `VoiceMovePayload`, `CapVoiceMove`, `DeviceCaps`, ported `Frame.Caps`, `conn.caps`, `(*conn).admits`, `registerCaps` |

### 8.5 client-core and media

| Thing | Name |
|---|---|
| Frames | `Op.voiceModeration` (56), `Op.voiceMove` (57), `VoiceModerationFrame {communityId, userId, mod}`, `VoiceMoveFrame {communityId, callId, channelId}`, `voiceModerationOf`, `voiceMoveOf`; both in `DROPPABLE_OPS` |
| Caps | `CAP_VOICE_MOVE`, `CAPS` (`gateway/gateway.ts`) |
| Routes | `setServerVoice`, `disconnectVoiceMember`, `moveVoiceMember`, types `ServerVoice {mute, deaf}`, `VoiceMoveResult {moved, disconnected}`; `CallStarted.mod`; `AFKSnapshot.reason: 0..4` |
| State | `VOICE_FLAG` (`inCall 1, selfMute 2, selfDeaf 4, video 8, screen 16, serverMute 32, serverDeaf 64`); `CallState.move: {to, seq} \| null` (the event `call.move`), `CallState.serverMuted`, `CallState.serverDeafened`; `CallJoinResult.serverMuted?`, `serverDeafened?`; `AFKState.pendingReason: 0..4` |
| Commands | (`AdminController.voiceMove`, `voiceDisconnect`, `serverVoice`; `AdminDeps.loadVoice`, `AdminDeps.afkChannel`) `voiceMove {communityId, userId, toChannelId}` → `VoiceMoveResult`; `voiceDisconnect {communityId, userId}` → `null`; `serverMute {communityId, userId, on}` → `null`; `serverDeafen {communityId, userId, on}` → `null` |
| Calls | `MOVE_RELOAD_MS = 3000`; `CallDeps.reloadCommunity`, `CallDeps.afkChannel`; `Live.mod`; `VoiceDeps.communityOf`; `VoiceBook.moderation` |
| Advisory | `admin/voicemod.ts`: `voiceModAccess`, `voiceChannelOf`, `NO_VOICE_MOD`, `VoiceModAccess {local, serverMute, serverDeafen, move, disconnect, moveTargets, dragTargets}`, `VoiceModSnapshot` |
| Settings | `SETTINGS.voiceLocalMute(hex)` = `voice.localMute.<hex>` (`'1'` or absent); `isLocallyMuted(settings, hex)` |
| Media | `SpeakerPolicy.setServerDeafened(on: boolean)` |
| Web call | `volume.ts` `localMutesFromSettings`, `gainOf(…, localMuted)`; `PageCallOptions.localMutes`; session `setLocalMute(userId, on)`, `applyServerVoice(mod: { muted: boolean; deafened: boolean })`; `PageCallOptions.serverVoice` |

### 8.6 UI and web

| Thing | Name |
|---|---|
| ui components | `ActionMenu` (extended; `MenuEntry`, `withSeparators`, `ActionMenuProps.onValue`), internal `MenuList`, `MenuSlider`, `place.ts` (`placeInBox`, `boxOf`); new `ContextMenu` (`ContextMenuProps`), `MenuSheet` (`MenuSheetProps`) |
| ui props | `VoiceChannelRow`: `channelId`, `onPerson`, `drag`, `drop`; `ChannelList` `voice.onPerson`, `voice.drag`; `ChannelRow` `menu`; `useRovingFocus(activeIndex, selector?)`; `VoiceParticipantView.serverMuted`, `serverDeafened`, `mutedForMe`; `VoiceStateLabels.serverMuted`, `serverDeafened`, `mutedForMe`; `UserPanel`/`CallControls`/`CallBar` `held: { mute?, deafen? }`; `AttachmentCard` `index`; `Lightbox` `index`, `seq` |
| DOM contract | `data-menu` = `person` \| `message` \| `link` \| `attachment` \| `channel` \| `voice-channel` \| `category` \| `server` \| `dm`, with `data-user-id`, `data-msg-id`, `data-seq`, `data-index`, `data-channel-id`, `data-category-id`, `data-community-id`; `data-native-menu` opts out; drag uses `data-draggable`, `data-dragging`, `data-drop` (`valid` \| `over`) |
| CSS classes | `d-action-menu__item`, `__label`, `__box`, `__chevron`, `__sep`, `__slider`, `__slider-label`, `__slider-track`, `__slider-fill`, `__slider-mark`, `__slider-thumb`, `__slider-value`, `__popup`; `d-context-menu`, `d-context-menu__popup`; `d-menu-sheet`, `__scrim`, `__head`, `__back`, `__title`, `__close`, `__list`, `__item`, `__switch`, `__range`, `__sep`; `d-voice-row__person-open`; `d-voice-drag`, `d-voice-drag__name`; web `dw-menu-root` |
| web menus (`packages/web/src/screens/menus/`) | `MenuHost.tsx` (`MenuHostProvider`, `useContextMenu`, `useOpenMenu`, `MenuSurface`, `BuiltMenu`, `SurfaceHandler`), `native.ts` (`keepsNativeMenu`), `long-press.ts` (`LONG_PRESS_MS`, `LONG_PRESS_SLOP_PX`, `CLICK_SUPPRESS_MS`, `createLongPress`), `clipboard.ts` (`copyText`, `copyImage`), models `person-menu.ts` (`personMenu`, `roleChoices`, `personInputs`), `message-menu.ts`, `link-menu.ts`, `attachment-menu.ts`, `channel-menu.ts`, `voice-channel-menu.ts`, `category-menu.ts`, `server-menu.ts`, `dm-menu.ts`, `drop-verdict.ts` (`dropVerdict`, `canDrag`), hooks `usePersonMenu.tsx`, `useVoiceMod.ts`, `use<Surface>Menu.tsx` |
| web other | `screens/admin/ModFlows.tsx`; `LeaveFlow` (from `DangerSection.tsx`); `toggleRole` (from `MemberRolesFlow.tsx`); `OpenCard.source` gains `'menu'` |
| Strings | modules `strings/personMenu.ts` (`person.menu.*`), `strings/voiceMod.ts` (`voice.mod.*`), `strings/menus.ts` (`menu.*`); `perm.*` in `strings/perm.ts`; flow doc `docs/design/flows/18-context-menus-and-voice-moderation.md` with `strings.flow18.test.ts` |

## 9. Compatibility with older clients

| Older client meets | What happens | Why it is safe |
|---|---|---|
| Op 56 | Ignored: `gateway.ts:235` emits only the ops it lists. | It sees no moderator glyphs; its own grant still enforces the mute. |
| Op 57 | Never sent: it is filtered by caps bit 1 (`admits`). | Its device is disconnected instead; the mover is told (`disconnected > 0`). |
| Snapshot row with 4 elements | Read with `atLeast(row, 3)`; the 4th is ignored. | Element 2 stays 0..31. |
| Start answer with 8 elements | Read with `atLeast(a, 6)`; `rung` `[]` is only read for a DM start the client opened. | Nothing else reads elements 6 and 7. |
| Pending reason | Never 3 or 4 (those go only to devices with caps bit 1); it gets no reason and says `You were removed from voice.`, which is true. `E_REMOVED` already stops its auto-recovery (`useCall.tsx:729`). | An old client maps ≥ 3 to "You went AFK on another device.", which would be false. |
| A server mute | Its microphone publish is refused by LiveKit; it shows a call error at worst. | Enforcement is the SFU's, not the client's. |
| A server deafen | The instance unsubscribes it; its `SpeakerPolicy` may resubscribe within the 30 s re-application window. | protocol/08 states this bound. |
| A token minted before a mute | Refused at a full `/rtc` join (`TokenWithin` compares the token's sources with `admitGrant`); the client starts again. A LiveKit resume is unaffected. | The same as a speak revocation by a role change today. |

A device with an older tab open is as capable as that tab: `DeviceCaps` is the AND over every online connection of the device.

## 10. Release, docs and gates

- **Schema and rollback.** The release notes state the schema bump (migration 00024 adds `member_voice_moderation`) and the rollback: `migrate down` drops the table, and with it every stored server mute and deafen, so everyone who was server-muted or server-deafened can speak and hear again. They list every operator-visible change and quote every new copy string (Jonas reviews the copy there).
- **Protocol docs** (task S7):
  - protocol/02: ops 56 and 57 rows and their paragraph; `409 E_NOT_IN_VOICE` row and prose (`scripts/check-protocol-docs.mjs` `checkErrorVocabulary`); identify caps bit 1 `voice_move`.
  - protocol/09: the three routes; the snapshot rows' fourth element; the start answer's elements 6 and 7; AFK `pending` 3 and 4; the audit bullet; permission bit 24.
  - protocol/08: the honest deafen limit, and "a move only within the moved person's own rights".
  - protocol/07: one versioning row (§11, S7).
- **User docs and README** (tasks D1, D2): `docs/user/voice.md` (moderation, the deafen limit, no moves into AFK, attachments have no copy link), `docs/user/getting-started.md` (right-click and long-press), README "what works", and the screenshots of §U.10.4, re-shot.
- **Gates.**
  - Go race tests on both engines (sqlite and Postgres), with sqlc (`sqlc diff`), the contract test and the schema dump.
  - client-core, media and web vitest; ui vitest.
  - lint, typecheck, `check:copy`, `check:css` and `check:docs`.
  - e2e: the web suite (`person-menu`, `context-menus`, `phone-menu`) on chromium, firefox and webkit; the voice suite (`voice-moderation`) on chromium-voice and firefox-voice, covering drag, Escape cancel, an invalid drop, keyboard move to, server mute enforced by the SFU (a muted person's audio doesn't reach a listener), server deafen, disconnect, self drag and a move landing in the target call.
  - axe on the menu, the submenu, the sheet and its pushed page, in all three themes.
- **Reviews.** Opus reviews the authz (rights, owner rule, overwrites: S6a, S6b, W2, W4), the move signal and its enforcement (S6b, T6, W6, E2), and the grant changes (S5).
- **Every fixture reachable.** The e2e specs start from an empty instance and build their servers, roles and channels through the shipping client.

## 11. Tasks

### 11.1 Lanes, order and parallelism

Four lanes run in **parallel working copies**, because their files are disjoint. Inside a lane, writers run one at a time in that lane's copy; tasks marked ∥ inside a lane run in further copies of their own. Reviews run in parallel with the next writer.

| Lane | Packages | Tasks |
|---|---|---|
| **S** server | `internal/`, `protocol/` | S1 ∥ S2 ∥ S3 ∥ S4 → S5 → S6a → S6b; S7 alongside S5 and S6 |
| **C** client-core and media | `packages/client-core`, `packages/media`, plus the few web literals and strings named below | T1 → T2 → T3 → T4 → T5 → T6 → T7; M1 ∥ from the start |
| **U** ui | `packages/ui` | U1 ∥ U3 → U2 (after U1), U4 (after U3) → U5 |
| **W** web, e2e, docs | `packages/web/src/screens`, `e2e/`, `docs/user`, `README.md` | W1 ∥ from the start; then W2, W3 → W4 → W5 → W7 → W6 → E1 ∥ E2 → D1 ∥ D2 |

Cross-lane dependencies (a task never starts before these have merged into the lane's base):

- **S1 → T2**: T2's vector test reads `protocol/vectors/permissions.json`.
- **T4 → W2**, **T5 → W4**: the web consumes `voiceModAccess` and the commands.
- **U2 → W3**, **U3, U4 → W4**, **U5 → W7**: the web mounts the ui components.
- **T1, T3, T6, M1 → W6**: the page follows `call.move`, `serverMuted`, `voice.localMute.<hex>` and the speaker policy.
- **S6b → E2**: the voice e2e needs the real routes.
- UI follows the client-core interfaces: no W task starts on a client-core name that is not merged; the names are frozen in §8, so U tasks and W1 start at once.

Waves (each wave's tasks run together):

| Wave | S | C | U | W |
|---|---|---|---|---|
| 1 | S1, S2, S3, S4 | T1, M1 | U1, U3 | W1 |
| 2 | S5, S7 | T2 (needs S1) | U2, U4 | — |
| 3 | S6a | T3, then T4 | U5 | W3 |
| 4 | S6b | T5 | — | W2 (needs T4) |
| 5 | — | T6, then T7 | — | W4 (needs T5) |
| 6 | — | — | — | W5, then W7 |
| 7 | — | — | — | W6 (needs T6, M1) |
| 8 | — | — | — | E1, E2 (needs S6b) |
| 9 | — | — | — | D1, D2 |

Shared-file hazards, which is why each lane is sequential: `packages/client-core/src/index.ts` (T1, T3, T4), `worker/controller.ts` (T1, T5, T6), `http/routes.ts` (T1, T2), `VoiceChannelRow.tsx` (U3, U4, U5), `Shell.tsx` (W3, W4, W5, W7, W6), `internal/api/calls.go` (S4 interface, then S5, S6a, S6b).

### 11.2 Tiers (ruling 14, M12)

| Tier | Implementation | Review |
|---|---|---|
| **opus** | T6, W6 (2) | S5, S6a, S6b, T6, W2, W4, W6, E2 (8) |
| **sonnet** | S1, S2, S3, S4, S5, S6a, S6b, T1, T2, T3, T4, T5, T7, M1, U1, U2, U3, U4, U5, W2, W3, W4, W5, W7, E1, E2, D2 (27) | all other 24 |
| **haiku** | S7, W1, D1 (3) | — |

If S5's `reconcileOutcome` change or S6b's `modCut` fails its first opus review, the fix round goes to opus.

### 11.3 The tasks

Each gate is narrow: the task's own tests plus typecheck and lint of its package. The full suites run at the end of each lane.

#### S1 — Permission bit 24 in Go, vectors and the protocol table

- **Lane** S, ∥ S2, S3, S4. **Depends on** —. **Model** sonnet. **Review** sonnet.
- **Files:** `internal/api/perm.go`, `internal/api/perm_test.go`, `internal/api/perm_vectors_test.go`, `protocol/vectors/permissions.json`, `protocol/09-http-api.md` (§ Permissions table row only).
- **Recipe:** §S.2 (Go, Vectors, Docs).
- **Tests:** `TestPermissionVectors` (21 cases; `deafen_via_overwrite` resolves community 4083, channel 16781299; owner and administrator 33554431); `TestDeafenMembersIsChannelScoped` (allow on one channel only, deny removes it, a user overwrite denying bit 24 wins over the role). Negative-first: break the overwrite scoping and see it red.

#### S2 — Migration, store and sqlc

- **Lane** S, ∥ S1, S3, S4. **Depends on** —. **Model** sonnet. **Review** sonnet.
- **Files:** `internal/store/{sqlite,postgres}/migrations/00024_voice_moderation.sql`, `internal/store/{sqlite,postgres}/schema/022_voice_moderation.sql`, `internal/store/{sqlite,postgres}/queries/voicemod.sql`, generated `sqlitedb/` and `pgdb/`, `internal/store/rows.go`, `store.go`, `sqlite/repo.go`, `postgres/repo.go`, `dump.go`, `schema_test.go`, `contract_test.go`, new `internal/store/voicemod_test.go`.
- **Recipe:** §S.3.
- **Tests:** `TestVoiceModerationSetGetListAndClear`, `TestVoiceModerationOfANonMemberIsNotFound`, `TestVoiceModerationGoesWithTheMembership`, `TestVoiceModerationMigrationIsSchemaVersion24`, `TestADumpRoundTripsVoiceModeration` (Postgres); and green: `TestDumpTablesNamesEverySchemaTable`, `TestEverySQLiteTableIsStrictAndTyped`, `TestGooseUpDownUpOnSQLite`/`Postgres`, `TestMigrationCarriesEverySchemaFileVerbatim`, `TestQuerierInterfacesAreIdentical`, `TestQueryHeadersAreByteIdenticalAcrossEngines`, `TestSubInterfacesMatchTheContract`, `TestMigrationsAreNumberedWithoutGaps`, `TestSchemaFilesAreNumberedWithoutGaps`. `sqlc diff` clean.

#### S3 — Gateway caps port, ops 56 and 57

- **Lane** S, ∥ S1, S2, S4. **Depends on** —. **Model** sonnet. **Review** sonnet.
- **Files:** `internal/gateway/frame.go`, `codec.go`, `session.go`, `gateway.go`, their tests.
- **Recipe:** §S.5.1, §S.5.2, §S.5.3 (port from `/home/thim/.cache/dilla-w3/upcalls/internal/gateway` verbatim, then `CapVoiceMove = 1 << 1` and `DeviceCaps`).
- **Tests:** `TestIdentifyCapsAreKeptForTheConnection`, `TestDeviceCapsIsTheANDOverOnlineConnections`, `TestFrameCapsFiltersTheFanOut`, `TestOp56And57AreServerToClient`.

#### S4 — SFU: `WithoutAudio` and `UpdateSubscriptions`

- **Lane** S, ∥ S1, S2, S3. **Depends on** —. **Model** sonnet. **Review** sonnet.
- **Files:** `internal/sfu/grants.go`, `internal/sfu/remote.go`, `internal/sfu/grants_test.go`, new `internal/sfu/subscriptions_test.go`, `internal/api/calls.go` (the `CallTokens` interface only), `internal/api/apitest_test.go` (`stubSFU`), `internal/dillad/callcut_test.go`, `plan2_test.go`, `routes_test.go` (fakes).
- **Recipe:** §S.4.2 (`WithoutAudio`), §S.4.3 (`UpdateSubscriptions` and its wiring).
- **Tests:** `TestWithoutAudioDropsMicAndScreenAudio`, `TestUpdateSubscriptionsUnsubscribesAndResubscribes` (real LiveKit), `TestUpdateSubscriptionsOfAnAbsentIdentityIsErrNoParticipant`; the dillad fakes compile.

#### S5 — Mute and deafen in the grants, snapshot `mod`, op 56 on join, the start answer's `mod`

- **Lane** S. **Depends on** S2, S3, S4. **Model** sonnet. **Review** **opus** (grant changes).
- **Files:** new `internal/api/voicemod.go` (§S.4.1, §S.4.3 functions, §S.4.4, §S.7 helpers), `internal/api/calls.go` (`grantFor`, `admitGrant`, `start`, `AdmitRoom`, `callStartResponse`), `callgrants.go` (`reconcileOutcome`, `reconcileRoom`), `callshare.go` (`share`), `callevents.go` (`joined`, `trackPublished`), `voicestate.go` (`deliver`), `callread.go` (`participantRow`, `participantRows`, `channelCall`, `communityCalls`), `internal/api/voicemod_test.go`, `calls_test.go` (start answers of eight elements).
- **Recipe:** §S.4, §S.4.5, §S.7.
- **Tests:** `TestServerMuteWithdrawsMicAndScreenAudio`, `TestServerMuteHoldsOnJoin`, `TestServerMutePersistsAcrossCalls`, `TestServerMuteDoesNotReachDMCalls`, `TestServerUnmuteRestoresTheMic`, `TestDeafenImpliesMuteAndUndeafenKeepsTheStoredMute`, `TestRoleSyncKeepsAServerMute`, `TestServerDeafenUnsubscribesAudioOnly`, `TestServerDeafenIsReappliedOnJoinTrackAndSweep`, `TestServerDeafenFailureLeavesARoomResync`, `TestUndeafenResubscribesAudio`, `TestNobodyDeafenedMakesNoSFUCall`, `TestJoinOfAModeratedUserAnnouncesOp56`, `TestCallSnapshotsCarryTheModerationElement`, `TestCallStartAnswersTheOwnModeration`. (The mute and deafen state is seeded through the store in S5; the PATCH route arrives in S6a, whose tests drive the same assertions through the route.)

#### S6a — The PATCH route, rights on spots, audit, live application

- **Lane** S. **Depends on** S1, S5. **Model** sonnet. **Review** **opus** (authz).
- **Files:** `internal/api/voicemod.go` (prelude, spots, `requireOnSpots`, PATCH handler, `auditVoiceMod`, `applyVoiceMod`, `announceVoiceMod`, `VoiceModGateway`, `WithVoiceMod`, test hook), `internal/api/calls.go` (`Register`, fields), `internal/api/export_test.go` (`SetVoiceModHookForTest`), `internal/server/errors.go` (`CodeNotInVoice`), `internal/dillad/routes.go` (`WithVoiceMod(p.gw)`), `internal/api/voicemod_test.go`.
- **Recipe:** §S.1.0, §S.1.1, §S.4.4, §S.5.3 (`VoiceModGateway`, `WithVoiceMod`, `moveCapable`), §S.6, §S.7.
- **Tests:** `TestVoiceMuteNeedsMuteMembersInTheTargetsChannel`, `TestVoiceDeafenNeedsDeafenMembers`, `TestVoiceModerationNeverTargetsTheOwner` (PATCH part), `TestVoiceModerationHasNoRankCheck` (PATCH part), `TestVoiceModerationNeedsTheTargetInVoice` (PATCH part), `TestVoiceModerationHidesACallTheCallerCannotSee`, `TestVoiceModerationAnswers404ForStrangers`, `TestVoiceModerationBodies` (PATCH cases), `TestVoiceModerationRechecksRightsInTheTransaction` (PATCH), `TestVoiceModerationOp56ReachesTheChannelAudience`, `TestVoiceModerationAuditsEachChange`; the S5 grant and deafen tests re-run through the route. Every authz test negative-first and shown red.

#### S6b — Move and disconnect

- **Lane** S. **Depends on** S6a. **Model** sonnet. **Review** **opus** (move signal, enforcement, authz).
- **Files:** `internal/api/voicemod.go` (DELETE and move handlers, `modCut`, `noteMove`, `clearMove`, `clearMoveIf`, `listsDevice`, `SweepVoiceMoves`), `internal/api/afk.go` (the two consts), `internal/api/calls.go` (`Admitted`, fields), `internal/api/callgrants.go` (`StartRetries`), `internal/api/voicemod_test.go`, `internal/dillad` (`TestVoiceModWiring`).
- **Recipe:** §S.1.2, §S.1.3, §S.5.1, §S.5.4, §S.5.5.
- **Tests:** the DELETE and move parts of `TestVoiceModerationNeverTargetsTheOwner`, `TestVoiceModerationHasNoRankCheck`, `TestVoiceModerationNeedsTheTargetInVoice`, `TestVoiceModerationBodies`, `TestVoiceModerationRechecksRightsInTheTransaction`; `TestMoveNeedsMoveMembersOnTheSource`, `TestMoveNeedsViewAndConnectOnTheTargetForTheMover`, `TestMoveRefusesATargetTheMovedPersonCannotJoin`, `TestMoveRefusesAFKTextAndForeignTargets`, `TestMoveToTheChannelTheyAreInIs400`, `TestMoveIntoAFullCallIs409`, `TestDisconnectCutsEveryDeviceWithAReasonForCapableOnes`, `TestDisconnectedDeviceMayRejoin`, `TestDisconnectBusyLockIs503AndKeepsNoReason`, `TestMoveSendsOp57ToCapableDevices`, `TestMoveDisconnectsDevicesThatCannotFollow`, `TestMoveWithMixedDevices`, `TestMoveIsEnforcedAfterTenSeconds`, `TestMoveFollowedIsForgotten`, `TestMoveDeadlineSurvivesAnSFUListingFailure`, `TestVoiceModWiring`.

#### S7 — Protocol docs and the release-notes stub

- **Lane** S, alongside S5 and S6 (the names are frozen in §8). **Depends on** —. **Model** haiku. **Review** sonnet.
- **Files:** `protocol/02-delivery-service.md`, `protocol/09-http-api.md` (except the permissions row, which is S1's), `protocol/08-*.md`, `protocol/07-versioning.md`, the release-notes stub.
- **Recipe:** §S.5.5 (pending row), §S.6 (audit bullet), §S.7 (ops 56/57 rows and paragraph, snapshot rows), §S.4.5 (start answer), §S.1.0 (`E_NOT_IN_VOICE` row and prose), and:
  - protocol/08: "Server deafen: the SFU stops forwarding audio; the person stays in the call's MLS group and holds its key; a modified client can resubscribe until the instance's next pass, at most about 30 s, and on every join and audio publish." and "A move only within the moved person's own rights: the instance tells the device to move, and it joins through its normal join; it never moves media or hands out keys."
  - protocol/07 row: `| 2026-10-xx | e2ee 1, media 1, wire 1 | **Additive.** Voice moderation: \`09\` § Voice gains \`PATCH\`/\`DELETE /v1/communities/{id}/members/{user_id}/voice\` and \`POST …/voice/move\`; permission bit 24 \`deafen_members\` (channel); \`02\` ops 56 \`voice_moderation\` and 57 \`voice_move\` (ephemeral, S→C); identify caps bit 1 \`voice_move\`; \`409 E_NOT_IN_VOICE\` (new, \`02\` § Errors); the voice snapshots' participant rows gain a fourth element \`mod\`, and the call start's answer always carries \`rung\` and an eighth element \`mod\`, which older clients ignore; the AFK snapshot's \`pending\` gains 3 and 4, sent only to devices with caps bit 1. Schema 00024 adds \`member_voice_moderation\`; \`migrate down\` drops it and every stored server mute and deafen with it. No version bump |`
- **Tests:** `check:docs`; `scripts/check-protocol-docs.mjs` (`checkErrorVocabulary` sees the `E_NOT_IN_VOICE` row).

#### T1 — client-core wire: frames, caps, routes, `mod`, pending reasons, state types

- **Lane** C. **Depends on** — (the names are frozen in §8; tests use fakes). **Model** sonnet. **Review** sonnet.
- **Files:** `packages/client-core/src/gateway/frames.ts`, `gateway/gateway.ts`, `http/routes.ts`, `state/types.ts`, `index.ts`, `worker/controller.ts` (the frame-dispatch condition only), `gateway/frames.test.ts`, `gateway/gateway.test.ts`, `http/routes.test.ts`, the idle-state literals in `worker/bridge.test.ts:111`, `calls/controller.test.ts:1810` and `packages/web/src/App.test.tsx:275,283`.
- **Recipe:** §C.2, §C.3, §C.4.
- **Tests:** §C.12.1, §C.12.2, §C.12.3.

#### T2 — client-core bit 24, the 25-bit mask, permission copy

- **Lane** C. **Depends on** S1, T1. **Model** sonnet. **Review** sonnet.
- **Files:** `packages/client-core/src/admin/perm.ts`, `admin/perm.test.ts`, `admin/roles.test.ts`, `http/routes.ts` (`PERM_ALL` and the comments at :115 and :295), `http/routes.test.ts` (:1604, :1618), `packages/web/src/core/use-channel-bits.test.tsx`, `packages/web/src/strings/perm.ts`, `docs/design/flows/09-roles-and-private-channels.md` (Copy lines), `packages/web/src/strings/strings.flow09.test.ts`.
- **Recipe:** §S.2 (TS and Tests), §U.9.6.
- **Tests:** `perm.test.ts` "pins all 25 values" and "PERM_GROUPS covers all 25 keys … 25 distinct bits", **deafenMembers is channel-overridable**; `roles.test.ts:49,54,55` read `0..33554431` and refuse `0x2000000`; `routes.test.ts` "25 permission bits" with `0x2000000 + 1`; `use-channel-bits.test.tsx:63` `0x1ffffff`; `strings.flow09.test.ts` (181 pairs, 64 lower-case keys); `check:copy`.

#### T3 — Mute for me: the local setting

- **Lane** C. **Depends on** T2 (lane order). **Model** sonnet. **Review** sonnet.
- **Files:** `packages/client-core/src/state/settings.ts`, `state/settings.test.ts`, `index.ts`.
- **Recipe:** §C.10.
- **Tests:** §C.12.6.

#### T4 — The advisory checks: `voiceModAccess`

- **Lane** C. **Depends on** T2 (`PERM.deafenMembers`). **Model** sonnet. **Review** sonnet (W2's opus review reads it again as consumed).
- **Files:** new `packages/client-core/src/admin/voicemod.ts`, new `admin/voicemod.test.ts`, `index.ts`.
- **Recipe:** §C.9.2.
- **Tests:** §C.12.5 (16 cases).

#### T5 — The four moderation commands

- **Lane** C. **Depends on** T1, T4 (lane order). **Model** sonnet. **Review** sonnet.
- **Files:** `packages/client-core/src/worker/protocol.ts`, `worker/controller.ts` (COMMANDS, ACCEPTS, ID_FIELDS, dispatch, AdminController deps), `admin/controller.ts`, `worker/world.ts`, `admin/controller.test.ts`.
- **Recipe:** §C.5.
- **Tests:** §C.12.7.

#### T6 — Applying a move, the moderator state in VoiceBook and in the own call

- **Lane** C. **Depends on** T1, T5. **Model** **opus**. **Review** **opus** (M12).
- **Files:** `packages/client-core/src/calls/controller.ts`, `calls/voice.ts`, `worker/controller.ts` (CallDeps and VoiceDeps wiring), `calls/controller.test.ts` (harness and the new describe), `sync/testing/model.ts`.
- **Recipe:** §C.6, §C.7. The central `setState` rule touches every call path (rekey hold, blocked leave, lost, reset): run the whole `calls/controller.test.ts` and `worker/controller.test.ts`, and judge every changed exact-state expectation.
- **Tests:** §C.12.8 (21 cases).

#### T7 — Fake-server routes

- **Lane** C. **Depends on** T1 (any time after it; lane order puts it last). **Model** sonnet. **Review** sonnet.
- **Files:** `packages/client-core/src/testing/fake-server.ts`, `testing/fake-server.test.ts`.
- **Recipe:** §C.12.9.
- **Tests:** §C.12.9.

#### M1 — Media: the speaker policy holds off while server-deafened

- **Lane** C, ∥ from the start (disjoint package). **Depends on** —. **Model** sonnet. **Review** sonnet.
- **Files:** `packages/media/src/audio/speakers.ts`, `packages/media/test/audio-speakers.test.ts`.
- **Recipe:** §C.11.
- **Tests:** §C.12.10.

#### U1 — ActionMenu: entries, submenus, check items, slider

- **Lane** U, ∥ U3. **Depends on** —. **Model** sonnet. **Review** sonnet.
- **Files:** `packages/ui/src/ActionMenu/ActionMenu.tsx`, new `MenuList.tsx`, new `place.ts`, new `MenuSlider.tsx`, `ActionMenu.css`, `ActionMenu.test.tsx`, `ActionMenu.stories.tsx`.
- **Recipe:** §U.2.1–§U.2.3, §U.2.6.
- **Tests:** the `ActionMenu.test.tsx` list of §U.10.1, including axe with a submenu open and a slider, in all three themes.

#### U2 — ContextMenu and MenuSheet

- **Lane** U. **Depends on** U1. **Model** sonnet. **Review** sonnet.
- **Files:** new `packages/ui/src/ContextMenu/{ContextMenu.tsx,.css,.test.tsx,.stories.tsx}`, new `packages/ui/src/MenuSheet/{MenuSheet.tsx,.css,.test.tsx,.stories.tsx}`, `packages/ui/src/index.ts`.
- **Recipe:** §U.2.4, §U.2.5, §U.2.6.
- **Tests:** `ContextMenu.test.tsx` and `MenuSheet.test.tsx` of §U.10.1, axe in three themes.

#### U3 — Surfaces in ui: `data-menu`, voice person buttons, roving selector

- **Lane** U, ∥ U1. **Depends on** —. **Model** sonnet. **Review** sonnet.
- **Files:** `packages/ui/src/VoiceChannelRow/VoiceChannelRow.tsx`, `internal/roving.ts`, `ChannelList/ChannelList.tsx`, `ChannelRow/ChannelRow.tsx`, `CommunityRail/CommunityRail.tsx`, `MemberList/MemberList.tsx`, `MessageRow/MessageRow.tsx`, `AttachmentCard/AttachmentCard.tsx`, `Lightbox/Lightbox.tsx`, `CallTile/CallTile.tsx` (the `li` attribute), `styles/base.css`, and their tests.
- **Recipe:** §U.3.6, §U.4.
- **Tests:** from §U.10.1: `VoiceChannelRow.test.tsx` (person button, `onPerson`), `ChannelList.test.tsx` (roving, `data-menu`), `MemberList.test.tsx` (replaced right-click tests), `MessageRow.test.tsx`, `CommunityRail.test.tsx`, `roving.test.tsx`, `base.test.ts`, `CallTile.test.tsx` (`data-menu`); `check:css`.

#### U4 — Indicators and held controls

- **Lane** U. **Depends on** U3. **Model** sonnet. **Review** sonnet.
- **Files:** `packages/ui/src/CallTile/CallTile.tsx`, `CallTile.css`, `VoiceChannelRow/VoiceChannelRow.tsx`, `VoiceChannelRow.css`, `UserPanel`, `CallControls`, `CallBar` (and their tests).
- **Recipe:** §U.7.
- **Tests:** `VoiceChannelRow.test.tsx` (boxed glyphs, mutedForMe, `groupPeople`), `CallTile.test.tsx` (`voiceStateWords` order and precedence, `silentByChoice`), `UserPanel`/`CallControls`/`CallBar` "held.mute makes mute aria-disabled, pressed, described by the reason".

#### U5 — Drag

- **Lane** U. **Depends on** U3, U4. **Model** sonnet. **Review** sonnet.
- **Files:** new `packages/ui/src/ChannelList/useVoiceDrag.ts`, `ChannelList.tsx`, `ChannelList.css`, `VoiceChannelRow/VoiceChannelRow.tsx`, new `useVoiceDrag.test.tsx`.
- **Recipe:** §U.6.2 (the `voice.drag` prop), §U.6.3.
- **Tests:** `useVoiceDrag.test.tsx` of §U.10.1; `VoiceChannelRow.test.tsx` `drop` attribute case.

#### W1 — Strings and the flow 18 copy table

- **Lane** W, ∥ from the start. **Depends on** —. **Model** haiku. **Review** sonnet.
- **Files:** new `packages/web/src/strings/personMenu.ts`, `voiceMod.ts`, `menus.ts`, `strings/en.ts`, new `docs/design/flows/18-context-menus-and-voice-moderation.md` (Copy, plus States, Keyboard map, Focus rules and Announcements, as the flow tests require), new `strings/strings.flow18.test.ts`.
- **Recipe:** §U.9.1–§U.9.5.
- **Tests:** `strings.flow18.test.ts` (every key byte for byte, prefix regex `/^(person\.menu\.|voice\.mod\.|menu\.)/`, the counted total pinned, lower-case chrome keys checked); `check:copy`.

#### W2 — Pure menu models and the drop verdict

- **Lane** W. **Depends on** T4 (and T2 through it). **Model** sonnet. **Review** **opus** (advisory authz mirrors the server's rules; reads `admin/voicemod.ts` too).
- **Files:** new `packages/web/src/screens/menus/person-menu.ts` (`personMenu`, `roleChoices`, `personInputs`), `message-menu.ts`, `link-menu.ts`, `attachment-menu.ts`, `channel-menu.ts`, `voice-channel-menu.ts`, `category-menu.ts`, `server-menu.ts`, `dm-menu.ts`, `drop-verdict.ts`, their tests; `screens/admin/MemberRolesFlow.tsx` (`roleChoices`, `toggleRole` extracted).
- **Recipe:** §U.5, §U.6.2 (`dropVerdict`, `canDrag`).
- **Tests:** one `it` per truth-table row (`person-menu.test.ts` 18 rows plus `roleChoices`, `personInputs`, move-to exclusions; `message-menu`, `channel-menu`, `voice-channel-menu`, `category-menu`, `server-menu`, `dm-menu`, `link-menu`, `attachment-menu`), `drop-verdict.test.ts`; `MemberRolesFlow.test.tsx` stays green.

#### W3 — The menu host

- **Lane** W. **Depends on** U2. **Model** sonnet. **Review** sonnet.
- **Files:** new `packages/web/src/screens/menus/MenuHost.tsx`, `native.ts`, `long-press.ts`, `clipboard.ts`, their tests; `packages/web/src/screens/Shell.tsx` (the provider wrap and the `dw-menu-root` element only).
- **Recipe:** §U.3.
- **Tests:** `native.test.ts`, `long-press.test.ts`, `MenuHost.test.tsx` of §U.10.2.

#### W4 — The person surface

- **Lane** W. **Depends on** W1, W2, W3, U3, U4, T5. **Model** sonnet. **Review** **opus**.
- **Files:** new `packages/web/src/screens/menus/usePersonMenu.tsx`, new `useVoiceMod.ts`, new `screens/admin/ModFlows.tsx`, `MemberCardHost.tsx` (`'menu'` source), `MemberPane.tsx`, `Shell.tsx`, `VoiceView.tsx` (export `volumeOf`, labels), new `Shell.personMenu.test.tsx`.
- **Recipe:** §U.5.1.4, §U.5.1.5, §U.8.3.
- **Tests:** `Shell.personMenu.test.tsx` of §U.10.2.

#### W5 — The other surfaces

- **Lane** W. **Depends on** W4 (Shell order), W1, W2, W3, U3. **Model** sonnet. **Review** sonnet.
- **Files:** `packages/web/src/screens/Conversation.tsx`, `ThreadView.tsx`, `Attachments.tsx`, `Shell.tsx`, `screens/admin/ChannelsSection.tsx` (export `DeleteChannel`), `screens/admin/DangerSection.tsx` (extract `LeaveFlow`), `screens/menus/use{Message,Link,Attachment,Channel,VoiceChannel,Category,Server,Dm}Menu.tsx`, new tests.
- **Recipe:** §U.5.2–§U.5.9; `InviteFlow` mounted in Shell.
- **Tests:** `Shell.contextMenus.test.tsx`, `Conversation.menu.test.tsx`, `ThreadView.menu.test.tsx`.

#### W7 — Drag wiring in Shell

- **Lane** W. **Depends on** W5 (Shell order), U5, W2, W4. **Model** sonnet. **Review** sonnet.
- **Files:** `packages/web/src/screens/Shell.tsx` (`voice.drag`), `Shell.personMenu.test.tsx` (drag cases).
- **Recipe:** §U.6.4.
- **Tests:** Shell drag cases: a valid drop calls `voiceMove`; this device's own row switches; an AFK drop announces `voice.mod.drag.afk`; Escape announces `Move cancelled.`; no `voice.drag` on a phone.

#### W6 — Call behaviour: follow a move, the cut reasons, held controls, mute for me, server voice in the session

- **Lane** W. **Depends on** W7 (Shell order), T1, T3, T6, M1, U4. **Model** **opus**. **Review** **opus** (M12).
- **Files:** `packages/web/src/screens/voice/useCall.tsx`, `screens/voice/VoiceView.tsx`, `packages/web/src/call/session.ts`, `call/volume.ts`, `Shell.tsx` (held props), new `useCall.mod.test.tsx`, new `VoiceView.mod.test.tsx`, `call/session.test.ts`, `call/volume.test.ts`.
- **Recipe:** §C.8, §C.10 (web half), §U.7.5, §U.8.1, §U.8.2, §U.8.4. The follow reuses the old session's `AudioContext` (D17).
- **Tests:** `useCall.mod.test.tsx` and `VoiceView.mod.test.tsx` of §U.10.2; `session.test.ts`: "a server mute unpublishes the microphone and screen audio and keeps the own mute", "a permission-refused mic publish while serverMuted is not a call error", "applyServerVoice with deafened calls the speaker policy"; `volume.test.ts`: "a locally muted user's voice gain is 0 and the stream gain is unchanged".

#### E1 — Web e2e

- **Lane** W. **Depends on** W4, W5; in the lane it runs after W6. **Model** sonnet. **Review** sonnet.
- **Files:** new `e2e/web/person-menu.spec.ts`, `e2e/web/context-menus.spec.ts`, `e2e/web/phone-menu.spec.ts`, `e2e/playwright.web.config.ts` (webkit `testMatch`).
- **Recipe:** §U.10.3 (web suite).
- **Tests:** the three specs on chromium, firefox and webkit.

#### E2 — Voice e2e

- **Lane** W, ∥ E1. **Depends on** W6, W7, S6b. **Model** sonnet. **Review** **opus** (enforcement claims).
- **Files:** new `e2e/voice/voice-moderation.spec.ts`.
- **Recipe:** §U.10.3 (voice suite).
- **Tests:** the spec on chromium-voice and firefox-voice.

#### D1 — User docs and README

- **Lane** W, ∥ D2. **Depends on** E1, E2. **Model** haiku. **Review** sonnet.
- **Files:** `docs/user/voice.md`, `docs/user/getting-started.md`, `README.md` ("what works").
- **Recipe:** §U.9.7 and §10.
- **Tests:** `check:docs`.

#### D2 — Screenshots

- **Lane** W, ∥ D1. **Depends on** E1, E2. **Model** sonnet. **Review** sonnet (the shots by eye).
- **Files:** `e2e/scripts/shoot-docs.mjs` (a `VOICEMOD_SHOTS` block after 4d), `docs/user/screenshots/*`.
- **Recipe:** §U.10.4.
- **Tests:** the shoot run; the new and re-shot images reviewed by eye.

## 12. Open questions

None. Every question the layer designs left for Jonas is decided: moves into the AFK channel (J7), the capability bit (D11), roles on the owner's row (J5), and the browser's menu over a selection (D14). The conflicts the rulings did not cover are resolved in §5.3.

---

## Appendix S: server

The server recipe, grounded in main at `29e2219f`. Line numbers are as of that commit; search for the quoted symbol if they have moved. Everything is written so a sonnet implementer never has to choose: where a name, a number or a byte is given, use it verbatim. The layer's own list of corrections to the original design is folded into §5, §6 and §9; the numbering below keeps the layer's, so S.1 to S.8 follow on from it.

### S.1 Routes

#### S.1.0 Conventions (all three routes)

- **Mounting.** Mount in `Calls.Register` (`internal/api/calls.go:398`) with `mux.HandleFunc`, bare, like the other call routes. Each handler requires an enrolled session itself through `enrolledSession(r)`.
- **New file:** `internal/api/voicemod.go` holds everything in this section.
- **Bodies** are CBOR arrays:
  - decode with `server.DecodeBody(w, r, maxCBORBody, &body)` into `[]cbor.RawMessage`;
  - decode elements with `cborx.Unmarshal`;
  - test null with `isNull` (`envelope.go:304`).
- **Responses** use `server.EncodeBody(w, status, v)`, and errors use `server.WriteError`.
- **New error code: `E_NOT_IN_VOICE`, HTTP 409.** It is the target's state, as `E_CALL_NOT_ALONE` is.
  - In `internal/server/errors.go`:

    ```go
    // CodeNotInVoice is the voice moderation routes' refusal when the target has no device in a live
    // call of the community that the caller can view. 409: it is the target's state, as "full" is.
    CodeNotInVoice Code = "E_NOT_IN_VOICE"
    ```
  - Add `CodeNotInVoice` to the 409 case in `(*Error).Status()` (`errors.go:128`).
  - Add a row to protocol/02's errors table: `| 409 | \`E_NOT_IN_VOICE\` | a voice moderation route: the target has no device in a live call of the community that the caller can view | refresh the voice list |`.
  - Add a sentence to the prose under it. `scripts/check-protocol-docs.mjs` `checkErrorVocabulary` enforces the row.
- **No other new error codes.** A moved person who cannot join the target is `403 E_FORBIDDEN`. The client pre-filters it, so the refusal is only ever a race.

##### Common prelude: `voiceModTarget`

```go
// voiceModReq is what every voice moderation route resolves before it looks at voice.
type voiceModReq struct {
	s      auth.Session
	cid    id.ID
	target id.ID
	owner  id.ID
}

// voiceModTarget resolves the session, {id} and {user_id}: 404 for an unknown or deleted community, a
// caller who is not a member and a target who is not a member; 403 "the owner cannot be moderated"
// when the target is the owner and the caller is not.
func (h *Calls) voiceModTarget(r *http.Request) (voiceModReq, error)
```

Exact sequence:

1. `s, err := enrolledSession(r)`. Return the error as is (401 or 403 `E_FACTOR_REQUIRED`).
2. `cid, err := server.PathID(r, "id")` and then `target, err := server.PathID(r, "user_id")`. A malformed id is 400.
3. `com, err := h.repo.GetCommunity(ctx, cid)`. On error, return `notFound(err)`. `GetCommunity` already answers `ErrNotFound` for a soft-deleted community.
4. `h.repo.GetMember(ctx, cid, s.UserID)`. On error, return `notFound(err)`.
5. `h.repo.GetMember(ctx, cid, target)`. On error, return `notFound(err)`.
6. If `target == com.Owner && s.UserID != com.Owner`, return `server.Errorf(server.CodeForbidden, "the owner cannot be moderated")`. This is the same text as `outranks`.
   - The owner may act on themself; the instance allows it, although the client never offers the owner server mute or deafen on their own row (J5).
   - **There is no rank check** (Jonas: "Like Discord"). `outranks` is never called here.

##### Test hook

Add `voiceModHook func(stage string)` to `Calls`, next to `afkHook`, and `func (h *Calls) voiceModStage(stage string) { if f := h.voiceModHook; f != nil { f(stage) } }`. Add `func (h *Calls) SetVoiceModHookForTest(f func(stage string)) { h.voiceModHook = f }` in `internal/api/export_test.go`, next to `SetAFKHookForTest`. Every route calls `h.voiceModStage("checked")` once every check before its transaction has passed, immediately before `h.repo.Tx`.

##### Spots: where the target is in voice

```go
// voiceSpot is one live call of a community voice channel in which the SFU lists devices of a user.
type voiceSpot struct {
	ch      store.ChannelRow
	row     store.VoiceSessionRow
	devices []id.ID // sorted bytewise, de-duplicated, "#" shadows folded into their device
}

// voiceSpotsOf is every live call of communityID's voice channels in which the SFU lists a device of
// userID, ordered by channel id. The AFK channel is skipped (it hosts no call). An SFU that cannot
// list a room is 503 E_UNAVAILABLE; no SFU at all is no spots.
func (h *Calls) voiceSpotsOf(ctx context.Context, communityID, userID id.ID) ([]voiceSpot, error)
```

Exact steps:

1. If `h.sfu == nil`, return `nil, nil`.
2. `devs, err := h.repo.ListDevicesByUser(ctx, userID)`. Build `mine := map[id.ID]bool{}` over `d.ID`.
3. `chans, err := h.repo.ListChannels(ctx, communityID)`. Keep each `ch` with `ch.Kind == ChannelVoice && CallGroupAllowed(ch) && !h.isAFKChannel(ctx, ch)`.
4. For each kept channel:
   - call `row, live, err := h.liveCallOf(ctx, ch, nil)` and skip it unless `live`;
   - call `lctx, cancel := sfuCtx(ctx); parts, err := h.sfu.Participants(lctx, row.LivekitRoom); cancel()`. On error, return `nil, server.Unavailable(uint64(callLockWait/time.Millisecond), "the SFU did not answer; retry shortly")`;
   - for each `p` in `parts`, take `base, _, _ := strings.Cut(p.GetIdentity(), "#")` and parse it with `id.Parse`. When it parses and `mine[dev]`, add `dev` to the spot. Skip `p.GetState() == livekit.ParticipantInfo_DISCONNECTED`.
5. Append each spot that has devices. Sort its devices with `bytes.Compare`. The spots are already in `ListChannels` order; sort them by `ch.ID` with `bytes.Compare` anyway.

##### Rights on spots: `requireOnSpots`

```go
// requireOnSpots is the voice routes' authorisation: 409 E_NOT_IN_VOICE when no spot is in a channel
// the caller can view (so a call the caller cannot see is never confirmed), and 403 E_FORBIDDEN
// "missing permission" unless the caller holds view_channel and every bit of want in every spot.
func requireOnSpots(ctx context.Context, res *Resolver, caller id.ID, spots []voiceSpot, want Bits) error
```

```go
	bits := make([]Bits, len(spots))
	visible := false
	for i, sp := range spots {
		b, err := res.Resolve(ctx, caller, sp.ch)
		if err != nil {
			return err
		}
		bits[i] = b
		visible = visible || b.Has(PermViewChannel)
	}
	if !visible {
		return server.Errorf(server.CodeNotInVoice, "they are not in a voice channel you can see")
	}
	for _, b := range bits {
		if !b.Has(PermViewChannel | want) {
			return server.Errorf(server.CodeForbidden, "missing permission")
		}
	}
	return nil
```

`Resolver.Resolve` is the only resolver used, which is `LoadSnapshot` followed by `Snapshot.ResolveChannel`. Overwrites therefore apply, so all three voice bits are channel-scoped, and the owner and administrators resolve to `PermAll`. With no spots at all, the loop leaves `visible` false, which gives `409`.

#### S.1.1 Set server mute and server deafen

`PATCH /v1/communities/{id}/members/{user_id}/voice`

| | |
|---|---|
| Request | `[server_mute(uint 0\|1\|null), server_deaf(uint 0\|1\|null)]`. `null` leaves that flag as it is. |
| Response | `200 [server_mute(uint 0\|1), server_deaf(uint 0\|1)]`: the stored flags after the request. |
| Permission | `mute_members` for a non-null `server_mute`, and `deafen_members` for a non-null `server_deaf`, each in every spot (`requireOnSpots`). |

Refusals, in check order:

1. `400 E_INVALID_REQUEST`:
   - the body is not exactly 2 elements: "the body is [server_mute, server_deaf]";
   - an element is neither null nor uint 0 or 1, which includes a CBOR boolean (`0xf4`/`0xf5`): "server_mute and server_deaf are 0, 1 or null";
   - both elements are null: "nothing to change".

   Decode the body **before** `voiceModTarget`, like `decodeAFKActivity`.
2. `voiceModTarget`: 404 or 403, as above.
3. `spots := voiceSpotsOf(ctx, cid, target)`, which may give 503.
4. `want` is `PermMuteMembers` if mute is non-null, ORed with `PermDeafenMembers` if deaf is non-null. Then `requireOnSpots(ctx, h.res, s.UserID, spots, want)`, which may give 409 or 403.
5. Run a transaction (below). An owner who changed hands in the meantime is 403. A right lost in the meantime is 403. A target who left the community is 404.

Transaction, exactly:

```go
now := h.clk.Now().Unix()
var prev, next store.VoiceModeration
err := h.repo.Tx(ctx, func(tx store.Repository) error {
	if err := tx.LockCommunity(ctx, cid); err != nil {
		return notFound(err)
	}
	com, err := tx.GetCommunity(ctx, cid)
	if err != nil {
		return notFound(err)
	}
	if target == com.Owner && s.UserID != com.Owner {
		return server.Errorf(server.CodeForbidden, "the owner cannot be moderated")
	}
	// A role or overwrite change that committed after the checks above must not let the caller act.
	if err := requireOnSpots(ctx, NewResolver(tx), s.UserID, spots, want); err != nil {
		return err
	}
	if prev, err = tx.GetVoiceModeration(ctx, cid, target); err != nil {
		return err
	}
	next = prev
	next.UserID, next.Updated = target, now
	if mute != nil {
		next.Mute = *mute
	}
	if deaf != nil {
		next.Deaf = *deaf
	}
	if next.Mute == prev.Mute && next.Deaf == prev.Deaf {
		return nil // nothing changes and nothing is audited
	}
	if err := tx.SetVoiceModeration(ctx, cid, next); err != nil {
		return notFound(err) // the target left the community meanwhile
	}
	return auditVoiceMod(ctx, tx, s.UserID, cid, target, spots[0].ch.ID, prev, next, now)
})
```

`spots[0]` is safe, because `requireOnSpots` refused an empty list.

After the commit, only when `prev` and `next` differ, call `h.applyVoiceMod(afterCommit(r), cid, target, spots, prev, next)` (§S.4.4). Then answer `200 [b2u(next.Mute), b2u(next.Deaf)]`.

**Undo also needs them in voice.** An unmute or undeafen of someone with no spot is `409 E_NOT_IN_VOICE`, and the stored state is unchanged. This is D3, as in Discord.

**Deafen implies mute.** The flags are stored independently. The effective audio withdrawal is `Mute || Deaf` (`audioOff`, §S.4.1). Undeafening leaves the stored `Mute` as it was. `deafen_members` alone can deafen, which mutes in effect, without `mute_members`.

#### S.1.2 Disconnect a person

`DELETE /v1/communities/{id}/members/{user_id}/voice`

| | |
|---|---|
| Request | none |
| Response | `204` |
| Permission | `move_members` in every spot |

Steps:

1. `voiceModTarget`: 404 or 403.
2. `spots := voiceSpotsOf(...)`: 503.
3. `requireOnSpots(ctx, h.res, s.UserID, spots, PermMoveMembers)`: 409 or 403.
4. Re-check inside a short transaction that also writes the audit row:

   ```go
   h.repo.Tx(ctx, func(tx) error {
       tx.LockCommunity(...)               // return notFound(err) on error
       owner re-check
       requireOnSpots(..., NewResolver(tx), ..., PermMoveMembers)
       for each spot: tx.Audit(store.AuditRow{
           Actor: &s.UserID, Action: "voice.disconnect", Target: target.String(),
           Detail: fmt.Sprintf("%s:%s:%d", cid, sp.ch.ID, len(sp.devices)), At: now,
       })
   })
   ```

   The audit row is written before the cuts, so a refusal from the call lock (step 5) still leaves a true record that it was ordered. If the cut does not land, it stays a pending cut that the retry loop enforces.
5. For each spot and each `dev` in `sp.devices`, in order:
   - `capable := h.moveCapable(dev)` (§S.5.3);
   - `reason := uint64(0)`, or `afkPendingModerated` (4) when `capable`;
   - `h.clearMove(dev)`, which drops any outstanding move deadline of this device (§S.5.4);
   - `if err := h.modCut(ctx, sp.row, dev, reason, callHoldRequest); err != nil { server.WriteError(w, err); return }`. The only error is the lock's `503 E_UNAVAILABLE`, so the client retries the whole request. Cuts already done stay done, and a second disconnect is idempotent.
6. `w.WriteHeader(http.StatusNoContent)`.

A disconnected device may join again at once, as in Discord. `modCut` leaves no lasting bar: the pending cut clears once the SFU took the removal.

#### S.1.3 Move a person

`POST /v1/communities/{id}/members/{user_id}/voice/move`

| | |
|---|---|
| Request | `[channel_id(bstr16)]`: the target voice channel |
| Response | `200 [moved(uint), disconnected(uint)]`: how many devices were sent the move signal, and how many were disconnected instead because their app cannot follow a move |
| Permission | mover: `move_members` in every spot (the source); `view_channel` and `connect` in the target. Moved person: `view_channel` and `connect` in the target. |

Refusals, in check order:

1. **Body.** Decode `[channel_id]`, exactly one 16-byte id. Anything else is `400 E_INVALID_REQUEST` "the body is [channel_id]".
2. **`voiceModTarget`**: 404 or 403.
3. **The target channel.** `tch, err := h.repo.GetChannel(ctx, chID)`:
   - `ErrNotFound` → `404 E_NOT_FOUND` "no such object".
   - `tch.CommunityID == nil || *tch.CommunityID != cid || tch.Kind != ChannelVoice || !CallGroupAllowed(tch)` → `400 E_INVALID_REQUEST` "the target is not a voice channel of this community".
   - Mover's bits: `mb, err := h.res.Resolve(ctx, s.UserID, tch)`. No `PermViewChannel` → `404 E_NOT_FOUND` "no such object", so a channel the mover cannot see is never confirmed. No `PermConnect` → `403 E_FORBIDDEN` "missing permission".
   - `h.isAFKChannel(ctx, tch)` → `400 E_INVALID_REQUEST` "nobody joins a call in the AFK channel" (J7). This check comes after the view check, so it is only told to someone who can see the channel.
   - Moved person's bits: `tb, err := h.res.Resolve(ctx, target, tch)`. Without `PermViewChannel|PermConnect` → `403 E_FORBIDDEN` "they cannot join that channel".
4. **Spots.** `spots := voiceSpotsOf(ctx, cid, target)`: 503.
5. **Source rights.** `requireOnSpots(ctx, h.res, s.UserID, spots, PermMoveMembers)`: 409 or 403.
6. **Already there.** `sources :=` the spots whose `ch.ID != tch.ID`. Empty → `400 E_INVALID_REQUEST` "they are already in that channel".
7. **Target full.** `trow, live, err := h.liveCallOf(ctx, tch, nil)`. If `live && h.callFull(ctx, trow.LivekitRoom, sources[0].devices[0])` → `409 E_CALL_FULL` "the call is full", and nothing moves. This is the advisory count the move's own join would meet.
8. **Re-check and audit**, in one transaction:
   - `LockCommunity`;
   - the owner re-check;
   - `requireOnSpots(..., NewResolver(tx), ..., PermMoveMembers)` over **all** spots, re-resolved;
   - the mover's view and connect on `tch` through `NewResolver(tx)` → 404 or 403;
   - the moved person's view and connect on `tch` through `NewResolver(tx)` → 403.

   The capability split and the audit counts are decided **before** the transaction (`capable := h.moveCapable(dev)` per device), so the audit row states exactly what follows. One row per source spot:

   ```go
   store.AuditRow{Actor: &s.UserID, Action: "voice.move", Target: target.String(),
       Detail: fmt.Sprintf("%s:%s:%s:%d:%d", cid, sp.ch.ID, tch.ID, movedN, disconnectedN), At: now}
   ```
9. **Act**, for each source spot and each `dev`:
   - **capable:** `h.noteMove(dev, sp.row)` (§S.5.4), BEFORE the frame, so a fast leave and rejoin cannot race the entry. Then `p, err := gateway.VoiceMovePayload(cid, sp.row.CallID, tch.ID)` (an error answers 500 via `server.WriteError`), `h.modGW.DeliverDevice(dev, gateway.Frame{Op: gateway.OpVoiceMove, Payload: p, Caps: gateway.CapVoiceMove})`, and count `moved++`.
   - **not capable:** `h.clearMove(dev)` and `h.modCut(ctx, sp.row, dev, 0, callHoldRequest)`. On error, answer it (503) and stop; otherwise `disconnected++`.
10. Answer `200 [moved, disconnected]`.

The mover's client uses the response for its honesty notice: `disconnected > 0` → `voice.mod.movedDisconnected` ("Disconnected {name} instead: their app can’t be moved."), as an announcement and a warn banner. `moved > 0` makes no promise that the device lands. The person's own client says if its join fails.

---

### S.2 Rights: `PermDeafenMembers`, bit 24

#### Go: `internal/api/perm.go` (task S1)

- Add `PermDeafenMembers Bits = 1 << 24` after `PermManageNicknames`.
- Add `| PermDeafenMembers` at the end of `PermAll`.
- **Do not** add it to `communityBits`. It is channel-overridable, like 21 and 22. That is how a channel overwrite grants or denies it.
- `PermAll` becomes `0x1FFFFFF` = **33554431**. `perm_test.go:197`'s `< 1<<62` guard still holds.

#### TS (task T2)

- `packages/client-core/src/admin/perm.ts`:
  - In `PERM`, add `deafenMembers: 1 << 24` (16777216, safe in 32-bit).
  - Leave `COMMUNITY_BITS` unchanged.
  - In `PERM_BY_KEY`, add `deafen: PERM.deafenMembers`.
  - In `PERM_GROUPS`, the voice group becomes `['connect', 'speak', 'video', 'screen', 'mute', 'deafen', 'move']`.
  - Change the header comment from "The 24 permission bits" to "The 25 permission bits (bit 24 fits in 32)".
- `packages/client-core/src/http/routes.ts:119`: `export const PERM_ALL = 0x1ffffff;`. Change the comment at line 295 from "24 defined bits" to "25".
- `packages/web/src/strings/perm.ts` (the copy of §U.9.6, D13):
  - add `'perm.deafen': 'deafen members'` and `'perm.deafen.hint': 'Server deafen people in voice: the server stops sending them the call’s sound. A modified app could still get it.'`;
  - replace `perm.mute.hint` and `perm.move.hint` ("Has no effect in this version.") with `'Server mute people in voice: the server stops taking their sound until a moderator undoes it.'` and `'Move people between voice channels they can join, and disconnect them from voice.'`;
  - in `docs/design/flows/09-roles-and-private-channels.md` § Copy, change the `perm.mute.hint` and `perm.move.hint` lines (:207, :209) to the new values, and add `` `perm.deafen='deafen members'` `` and the `perm.deafen.hint` line after the `perm.move.hint` line (M6);
  - in `strings.flow09.test.ts`, the pair count goes from 179 to 181, `'perm.deafen'` joins `LOWER` after `'perm.move'`, and the chrome test reads "64 lower-case keys are pinned";
  - run `check:copy`.
- Tests:
  - `packages/client-core/src/admin/perm.test.ts`: change "24 keys" to 25 and add `deafenMembers: 16777216` to the expected map.
  - `packages/client-core/src/admin/roles.test.ts`: lines 49, 54 and 55 change `0..16777215` to `0..33554431`, and the out-of-range word `0x1000000` becomes `0x2000000`. These are allow and deny. **Lines 47 and 48 are role colour (`ROLE_COLOR_MAX`) and stay.**
  - `packages/web/src/core/use-channel-bits.test.tsx:63`: `0xffffff` becomes `0x1ffffff`.
  - `packages/client-core/src/http/routes.test.ts`: rename the two "24 permission bits" tests to "25", and use `0x2000000 + 1` as the out-of-range word (:1604, :1618).
  - `packages/client-core/src/admin/perm.test.ts` also gains **deafenMembers is channel-overridable**: a member overwrite allowing `deafenMembers` in channel X, on a member without it, gives the bit in X only; `COMMUNITY_BITS & PERM.deafenMembers === 0`. "PERM_GROUPS covers all 25 keys … 25 distinct bits".

#### Vectors: `protocol/vectors/permissions.json` (task S1)

- In `bits`, add `"deafen_members": 16777216`.
- In cases `owner` and `administrator_role`, `community` and `channel` change from `16777215` to `33554431`.
- Append a case that proves the bit is channel-scoped:

  ```json
  {
    "name": "deafen_via_overwrite",
    "owner": "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
    "everyone": "e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0",
    "roles": [{ "id": "e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0", "position": 0, "allow": 4083, "deny": 0 }],
    "held": [],
    "overwrites": [{ "kind": 0, "target": "e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0", "allow": 16777216, "deny": 0 }],
    "user": "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
    "community": 4083,
    "channel": 16781299
  }
  ```
- `internal/api/perm_vectors_test.go`:
  - `len(v.Cases) != 20` becomes `21`, with the message "want 21";
  - add `"deafen_members": api.PermDeafenMembers` to `consts`.

#### Docs (task S1)

protocol/09 § Permissions table: add `| 24 | \`deafen_members\` | channel |`.

---

### S.3 Migration and store

#### Numbers

- **Migration `00024_voice_moderation.sql`** in both `internal/store/sqlite/migrations/` and `internal/store/postgres/migrations/`.
- **Schema file `022_voice_moderation.sql`** in both `schema/` directories. The newest is `021_device_labels.sql`.
- If calls-survive-upgrade merged first and took 00024 and 022, use 00025 and 023. `TestMigrationsAreNumberedWithoutGaps` and `TestSchemaFilesAreNumberedWithoutGaps` (`internal/store/migration_sequence_test.go`) enforce it.

#### Table `member_voice_moderation`

A row exists only while at least one flag is set. Clearing both flags deletes the row. A kick, ban or leave drops the row by cascade from `members`.

**sqlite** (`internal/store/sqlite/schema/022_voice_moderation.sql`):

```sql
-- 022_voice_moderation.sql: a member's server mute and server deafen (voice moderation, migration
-- 00024_voice_moderation.sql). One row per (community, user) while either flag is 1; clearing both
-- deletes it, so a row always holds a flag. server_deaf implies mute in effect (the publish grant
-- drops audio for either), but the two are stored apart so an undeafen restores the stored mute.
-- updated is the unix time of the last change. Leaving the community, a kick or a ban drop the row
-- by cascade from members.
CREATE TABLE member_voice_moderation (
  community_id BLOB NOT NULL CHECK (length(community_id) = 16),
  user_id      BLOB NOT NULL CHECK (length(user_id) = 16),
  server_mute  INTEGER NOT NULL CHECK (server_mute IN (0, 1)),
  server_deaf  INTEGER NOT NULL CHECK (server_deaf IN (0, 1)),
  updated      INTEGER NOT NULL CHECK (updated > 0),
  PRIMARY KEY (community_id, user_id),
  CHECK (server_mute = 1 OR server_deaf = 1),
  FOREIGN KEY (community_id, user_id) REFERENCES members (community_id, user_id) ON DELETE CASCADE
) STRICT;
```

**Postgres** (`internal/store/postgres/schema/022_voice_moderation.sql`): the same comment, then:

```sql
CREATE TABLE member_voice_moderation (
  community_id BYTEA NOT NULL CHECK (octet_length(community_id) = 16),
  user_id      BYTEA NOT NULL CHECK (octet_length(user_id) = 16),
  server_mute  BIGINT NOT NULL CHECK (server_mute IN (0, 1)),
  server_deaf  BIGINT NOT NULL CHECK (server_deaf IN (0, 1)),
  updated      BIGINT NOT NULL CHECK (updated > 0),
  PRIMARY KEY (community_id, user_id),
  CHECK (server_mute = 1 OR server_deaf = 1),
  FOREIGN KEY (community_id, user_id) REFERENCES members (community_id, user_id) ON DELETE CASCADE
);
```

Use `BIGINT`, not `SMALLINT`. `TestQuerierInterfacesAreIdentical` needs `int64` on both engines.

**Migration file** (each engine), following `00023_device_labels.sql`:

```sql
-- +goose Up
-- The body of this section is internal/store/<engine>/schema/022_voice_moderation.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

<the schema file's body, byte for byte>

-- +goose Down
DROP TABLE member_voice_moderation;
```

**What a down migration drops:** the table `member_voice_moderation`. Its primary-key index goes with it. Every stored server mute and server deafen is lost, so after a rollback, everybody who was server-muted or server-deafened can speak and hear again. The release notes must say so.

#### sqlc queries

New file `voicemod.sql` in both `queries/` directories. The `-- name:` lines must be byte-identical across engines (`TestQueryHeadersAreByteIdenticalAcrossEngines`).

sqlite (`internal/store/sqlite/queries/voicemod.sql`):

```sql
-- name: GetVoiceModeration :one
SELECT server_mute, server_deaf, updated FROM member_voice_moderation WHERE community_id = ? AND user_id = ?;

-- name: UpsertVoiceModeration :exec
INSERT INTO member_voice_moderation (community_id, user_id, server_mute, server_deaf, updated)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (community_id, user_id) DO UPDATE SET server_mute = excluded.server_mute,
  server_deaf = excluded.server_deaf, updated = excluded.updated;

-- name: DeleteVoiceModeration :execrows
DELETE FROM member_voice_moderation WHERE community_id = ? AND user_id = ?;

-- name: ListVoiceModeration :many
SELECT user_id, server_mute, server_deaf, updated FROM member_voice_moderation WHERE community_id = ? ORDER BY user_id;
```

Postgres: the same, with `$1..$5` placeholders. Then run `sqlc generate`; CI runs `sqlc diff`.

#### Store types and methods

In `internal/store/rows.go`, next to `AFKAway`:

```go
// VoiceModeration is a member's server mute and server deafen in one community (voice moderation).
// The zero value (both false) is "not moderated", which is also what a missing row reads as.
type VoiceModeration struct {
	UserID  id.ID
	Mute    bool
	Deaf    bool
	Updated int64
}
```

In `internal/store/store.go`, in the `Communities` interface, after `AFKAwayExistsUser`:

```go
	// GetVoiceModeration is userID's server mute and deafen in communityID; a member with no row (and
	// a non-member) reads as the zero value with UserID set, never ErrNotFound.
	GetVoiceModeration(ctx context.Context, communityID, userID id.ID) (VoiceModeration, error)
	// SetVoiceModeration stores m for m.UserID in communityID: an upsert while either flag is set,
	// a delete when both are clear. m.Updated must be > 0 when a flag is set. A user who is no member
	// is ErrNotFound (the row references members).
	SetVoiceModeration(ctx context.Context, communityID id.ID, m VoiceModeration) error
	// ListVoiceModeration is every moderated member of communityID, ordered by user id; bounded by
	// the member count.
	ListVoiceModeration(ctx context.Context, communityID id.ID) ([]VoiceModeration, error)
```

##### Repo implementations

Implement these in both `internal/store/sqlite/repo.go` and `internal/store/postgres/repo.go`, beside `SetAFKAway`.

**`GetVoiceModeration`:**
- `errors.Is(err, sql.ErrNoRows)` → `VoiceModeration{UserID: userID}, nil`;
- any other error → `wrap(err)`;
- otherwise `Mute: row.ServerMute == 1, Deaf: row.ServerDeaf == 1, Updated: row.Updated`.

**`SetVoiceModeration`:**
- when `!m.Mute && !m.Deaf`, call `DeleteVoiceModeration` and return `wrap(err)`. Deleting a row that is not there is not an error;
- otherwise call `UpsertVoiceModeration` with `b2i(m.Mute)`, `b2i(m.Deaf)` and `m.Updated`;
- map a foreign-key failure to `fmt.Errorf("%w: %w", store.ErrNotFound, err)`:
  - sqlite: `strings.Contains(err.Error(), "FOREIGN KEY constraint failed")`;
  - Postgres: `pgErr.Code == "23503"`.

  This is exactly `SetAFKAway`'s pattern.

**`ListVoiceModeration`:** map each row to `VoiceModeration`.

`b2i` is a two-line local helper in each repo file:

```go
func b2i(b bool) int64 { if b { return 1 }; return 0 }
```

Name it `boolInt` if `b2i` already exists in the file.

#### Tables lists, contract test and dump

- `internal/store/dump.go` `DumpTables`: insert `"member_voice_moderation"` right after `"community_afk_away"`, with the comment:

  ```
  // 022_voice_moderation.sql, appended by voice moderation. Its parent is members (a composite key);
  // a restore that dropped it would unmute everyone a moderator muted.
  ```
- `internal/store/schema_test.go` `wantTables`: insert `"member_voice_moderation"` in sorted position, between `"member_roles"` and `"members"`. Extend the comment: "voice moderation added 022_voice_moderation.sql's member_voice_moderation".
- `internal/store/contract_test.go`: add `"GetVoiceModeration", "ListVoiceModeration", "SetVoiceModeration"` to both lists that carry the AFK away names (lines ~175 and ~205), with the comment `// voice moderation, reached through the embedded Communities: server mute and deafen.`

---

### S.4 Grants: mute and deafen in the SFU

#### S.4.1 Helpers (`internal/api/voicemod.go`)

```go
// voiceModFor is userID's stored server mute and deafen in ch's community; the zero value for a DM
// or group DM, which has no community and no moderator.
func voiceModFor(ctx context.Context, repo store.Repository, ch store.ChannelRow, userID id.ID) (store.VoiceModeration, error) {
	if ch.CommunityID == nil {
		return store.VoiceModeration{UserID: userID}, nil
	}
	return repo.GetVoiceModeration(ctx, *ch.CommunityID, userID)
}

// audioOff reports whether m withdraws every audio source: server mute, or server deafen, which
// implies mute (Discord).
func audioOff(m store.VoiceModeration) bool { return m.Mute || m.Deaf }

// modBits is m on the wire (op 56, the snapshot's fourth element): bit 0 server_mute, bit 1 server_deaf.
func modBits(m store.VoiceModeration) uint64 {
	var b uint64
	if m.Mute {
		b |= 1
	}
	if m.Deaf {
		b |= 2
	}
	return b
}
```

#### S.4.2 Mute: no audio source in the publish grant

**`internal/sfu/grants.go`**: add the following after `PublishGrant`. Do **not** change `PublishGrant`'s signature, which has more than 40 callers.

```go
// WithoutAudio is perm without the two audio sources, MICROPHONE and SCREEN_SHARE_AUDIO: a server
// mute (voice moderation) withdraws the microphone and a screen share's audio together, so a muted
// person cannot talk through system audio. Camera and screen video are kept. Like PublishGrant it
// never spells "none" as an empty list, which LiveKit reads as every source: with no source left it
// is CanPublish false with a nil list. perm is not modified.
func WithoutAudio(perm *livekit.ParticipantPermission) *livekit.ParticipantPermission {
	out := proto.Clone(perm).(*livekit.ParticipantPermission)
	var kept []livekit.TrackSource
	for _, s := range perm.GetCanPublishSources() {
		if s != livekit.TrackSource_MICROPHONE && s != livekit.TrackSource_SCREEN_SHARE_AUDIO {
			kept = append(kept, s)
		}
	}
	out.CanPublishSources = kept
	out.CanPublish = len(kept) > 0
	return out
}
```

Import `google.golang.org/protobuf/proto`, which is already in the module graph through livekit/protocol.

**`internal/api/calls.go`**: three changes. A device's mute is read where its bits are resolved, and a read error fails closed by answering or recording the error.

1. `grantFor` gains a parameter: `func (h *Calls) grantFor(ctx context.Context, bits Bits, muted bool, row store.VoiceSessionRow, dev id.ID)`. Its last line becomes:

   ```go
   g := sfu.PublishGrant(bits.Has(PermSpeak), bits.Has(PermVideo) && leased, bits.Has(PermScreenShare) && leased)
   if muted {
       return sfu.WithoutAudio(g)
   }
   return g
   ```
2. `admitGrant` gains the same parameter. Its last line becomes:

   ```go
   g := baseGrant(bits); if muted { return sfu.WithoutAudio(g) }; return g
   ```
3. Callers:
   - **`start`**, at `calls.go:618`: before the mint, call `mod, err := voiceModFor(r.Context(), h.repo, ch, s.UserID)` and answer an error with `server.WriteError`. Pass `audioOff(mod)`. The answer carries `modBits(mod)` as element 7 (§S.4.5).
   - **`AdmitRoom`**, at `calls.go:1242`: after the `PermConnect` check, call `mod, err := voiceModFor(ctx, h.repo, ch, dev.UserID)` and return `nil, err` on error. Pass `audioOff(mod)`.
   - **`share`**, at `callshare.go:529`: after `bits` is re-resolved, call `mod, err := voiceModFor(ctx, h.repo, ch, s.UserID)` and answer an error. Pass `audioOff(mod)`. A muted person may still share a camera or screen, just not its audio.

**`internal/api/callgrants.go` `reconcileOutcome`**: this is the live push that every sync, join and sweep goes through.

- After `leaf` is computed and the cut check passes, before `penalised`:

  ```go
  mod, err := voiceModFor(ctx, d.repo, ch, dv.UserID)
  if err != nil {
      return false, pending(errors.Join(fmt.Errorf("device %s: %w", dev, err), h.pushNone(ctx, d, row, dev)), dropSlot)
  }
  ```
- After `perm := sfu.PublishGrant(...)`, add `if audioOff(mod) { perm = sfu.WithoutAudio(perm) }`.
- `keepsSlot` is unchanged. Video is unaffected.

**How mute applies.**

- **On join:**
  - the token is minted without the microphone (`start`);
  - the `/rtc` gate admits without it (`AdmitRoom`), so a replayed older token with a microphone is refused at a full join;
  - LiveKit's `participant_joined` runs `reconcileJoiner` → `reconcileOutcome`, which pushes the muted grant again.
- **Live**, in every room the person is in:
  - the PATCH route calls `h.syncRoomGrants(ctx, h.deps(), sp.ch, sp.row, &target)` per spot (§S.4.4);
  - LiveKit's `UpdateParticipant` replaces the permission and unpublishes the microphone and screen-audio tracks at once (`participant.go:849-906`, as documented on `sfu.UpdatePermission`);
  - a busy call lock leaves a `roomResync` pending, which the retry loop drives.
- **Undo:** the same `syncRoomGrants`. `reconcileOutcome` now computes a grant with the microphone, and LiveKit lets the client publish again. The client re-enables its own microphone toggle on op 56.
- **Role and overwrite changes** (`SyncCallGrants`) and the room sweep go through `reconcileOutcome` too, so mute is never lost to a later push.

#### S.4.3 Deafen: unsubscribe from audio

**`internal/sfu/grants.go`**: add the following beside `UpdatePermission`.

```go
// UpdateSubscriptions subscribes (subscribe true) or unsubscribes identity in room to or from the
// tracks trackSIDs: RoomService UpdateSubscriptions (livekit-server v1.13.7
// pkg/service/roomservice.go:295 → roommanager.go:951 → rtc/room.go:1361, which calls the
// participant's SubscribeToTrack or UnsubscribeFromTrack per sid). It is how a server deafen
// (voice moderation) stops the SFU forwarding audio to a participant who keeps CanSubscribe and the
// call's media key: a modified client can subscribe again, which the instance re-applies on its
// next pass. An identity the room does not hold is ErrNoParticipant. An empty trackSIDs is a no-op
// and calls nothing.
func (s *Server) UpdateSubscriptions(ctx context.Context, room, identity string, trackSIDs []string, subscribe bool) error {
	if room == "" || identity == "" {
		return errors.New("sfu: room and identity must both be set")
	}
	if len(trackSIDs) == 0 {
		return nil
	}
	rs, ctx, err := s.roomServiceFor(ctx, &auth.VideoGrant{RoomAdmin: true, Room: room})
	if err != nil {
		return err
	}
	if _, err := rs.UpdateSubscriptions(ctx, &livekit.UpdateSubscriptionsRequest{
		Room: room, Identity: identity, TrackSids: trackSIDs, Subscribe: subscribe,
	}); err != nil {
		if isTwirpNotFound(err) {
			return ErrNoParticipant
		}
		return fmt.Errorf("sfu: update the subscriptions of %q in %q: %w", identity, room, err)
	}
	return nil
}
```

Wire it everywhere `CallTokens` is implemented:

- `internal/sfu/remote.go`: add `func (r *Remote) UpdateSubscriptions(ctx context.Context, room, identity string, trackSIDs []string, subscribe bool) error { return r.control.UpdateSubscriptions(ctx, room, identity, trackSIDs, subscribe) }`.
- `internal/api/calls.go` `CallTokens`: add `UpdateSubscriptions(ctx context.Context, room, identity string, trackSIDs []string, subscribe bool) error`, and extend the doc comment with one sentence: "UpdateSubscriptions (un)subscribes a participant to tracks: the server deafen."
- Implement it on every fake:
  - `internal/api/apitest_test.go` `stubSFU`. It records `subUpdate{Room, Identity string; SIDs []string; Subscribe bool}` into a new `subs []subUpdate` field, answers `subFail error` when that is set, and answers `sfu.ErrNoParticipant` when `absent[identity]`. Add a `subUpdates() []subUpdate` reader under `mu`.
  - `internal/dillad/callcut_test.go` `roomSFU`, `internal/dillad/plan2_test.go` `upstreamSFU` and `internal/dillad/routes_test.go` `fakeSFU` each get `return nil`.

##### Deafen functions (`internal/api/voicemod.go`)

None of these needs the call's lock: they touch only subscriptions, never slots or permissions.

```go
// deafenedIn is the users server-deafened in ch's community; nil for a DM or when nobody is.
func deafenedIn(ctx context.Context, repo store.Repository, ch store.ChannelRow) (map[id.ID]bool, error)
```

It returns `nil, nil` when `ch.CommunityID == nil`. Otherwise it calls `ListVoiceModeration` and keeps the users with `Deaf`.

```go
// audioSIDs is every audio track of parts by identity: a track whose Type is AUDIO (MICROPHONE and
// SCREEN_SHARE_AUDIO; whatever its source says, the type decides what a listener hears).
func audioSIDs(parts []*livekit.ParticipantInfo) map[string][]string

// applyDeafen unsubscribes every participant of parts whose user is deafened in ch's community from
// every audio track of every OTHER participant of parts. "#" shadows and identities that are no
// device are skipped (the grant sync cuts them). A participant the room no longer holds is not an
// error. It reads the moderation table first, so a community with nobody deafened costs one query
// and no SFU call.
func (h *Calls) applyDeafen(ctx context.Context, d grantDeps, ch store.ChannelRow, row store.VoiceSessionRow, parts []*livekit.ParticipantInfo) error
```

`applyDeafen` body:

1. `deaf, err := deafenedIn(ctx, d.repo, ch)`. Return `err` on error. If `len(deaf) == 0`, return nil.
2. `audio := audioSIDs(parts)`.
3. For each `p`:
   - `identity := p.GetIdentity()`. Skip it if it contains `#`. Skip it if `id.Parse` fails.
   - `dv, err := d.repo.GetDevice(ctx, dev)`. On `ErrNotFound`, skip. On any other error, collect it and continue.
   - Skip unless `deaf[dv.UserID]`.
   - `sids :=` the concatenation of `audio[other]` for every `other != identity`, sorted.
   - `sctx, cancel := sfuCtx(ctx); err := d.tokens.UpdateSubscriptions(sctx, row.LivekitRoom, identity, sids, false); cancel()`.
   - Collect `err` unless it `errors.Is(err, sfu.ErrNoParticipant)`.
4. Return `errors.Join(errs...)`.

```go
// deafenRoom is applyDeafen over row's room as the SFU lists it now: what a join, an audio publish
// and the deafen itself run. A failure leaves a pending room resync, so the retry loop's reconcile
// (which runs applyDeafen) repeats it.
func (h *Calls) deafenRoom(ctx context.Context, row store.VoiceSessionRow) error
```

`deafenRoom` body:

1. If `h.sfu == nil`, return nil.
2. `ch, err := h.repo.GetChannel(ctx, row.ChannelID)`. On `ErrNotFound`, return nil.
3. `lctx, cancel := sfuCtx(ctx); parts, err := h.sfu.Participants(lctx, row.LivekitRoom); cancel()`.
4. Call `h.applyDeafen(ctx, h.deps(), ch, row, parts)`.
5. On any error, call `h.leases.markPending(row.CallID, roomResync, pendingRepair{Room: row.LivekitRoom})` and `h.reportPending()`, then return the error.

```go
// undeafenUser subscribes userID's devices in row's room to every audio track of the other
// participants again: what LiveKit's auto-subscribe gave them before the deafen. The client's own
// speaker policy (packages/media/src/audio/speakers.ts) re-applies its cap on op 56.
func (h *Calls) undeafenUser(ctx context.Context, ch store.ChannelRow, row store.VoiceSessionRow, userID id.ID) error
```

`undeafenUser` follows the same shape as `applyDeafen`, with these differences:

- it selects the participants whose device's `UserID == userID`;
- it calls `subscribe` true;
- it never marks a pending repair, because a missed resubscribe only costs audio the honest client asks for again.

**Where deafen is applied.** This is the full list, so nothing is left to choose.

1. **The deafen itself** (§S.4.4): `h.deafenRoom(ctx, sp.row)` per spot.
2. **On join:** in `CallEvents.joined` (`callevents.go:412`), after `c.calls.ringer.Answered(...)` at the very end, call `if err := c.calls.deafenRoom(ctx, row); err != nil { c.log.WarnContext(ctx, "re-applying a server deafen on a join did not finish; the retry loop repeats it", "room", row.LivekitRoom, "err", err) }`. This covers a deafened joiner, and also an undeafened joiner who must not be unsubscribed from a deafened person's audio. The latter is a no-op, because only deafened listeners are unsubscribed.
3. **On a new audio track:** in `CallEvents.trackPublished` (`callevents.go:672`), after the `updateTracks` call at the end, call `if t.GetType() == livekit.TrackType_AUDIO { if err := c.calls.deafenRoom(ctx, row); err != nil { warn as above } }`.
4. **On every reconcile of a room:** in `reconcileRoom` (`callgrants.go:151`), just before `return errors.Join(errs...)`, call `if err := h.applyDeafen(ctx, d, ch, row, parts); err != nil { h.leases.markPending(row.CallID, roomResync, pendingRepair{Room: row.LivekitRoom}); errs = append(errs, err) }`. `reconcileRoom` is reached by every grant sync, every retry of a `roomResync`, every cut and the **room sweep every 30 s**. The sweep is the periodic re-application that bounds a modified client's resubscribe.
5. **Undo:** the PATCH route calls `h.undeafenUser(ctx, sp.ch, sp.row, target)` per spot. Re-application stops by itself, because `deafenedIn` no longer lists the user.

The deafened person still receives camera and screen video, which matches Jonas's "Audio only, like Discord". They also keep `CanSubscribe` and stay in the MLS group. protocol/08 states that a modified client can resubscribe until the server's next pass, within 30 s.

#### S.4.4 `applyVoiceMod`: live application after the PATCH

```go
// applyVoiceMod puts a committed server mute/deafen change into every call the target is in, and
// tells each call's audience (op 56). It runs on the request's afterCommit context; what does not
// land is left pending for the retry loop.
func (h *Calls) applyVoiceMod(ctx context.Context, cid, target id.ID, spots []voiceSpot, prev, next store.VoiceModeration) {
	for _, sp := range spots {
		if audioOff(prev) != audioOff(next) {
			if err := h.syncRoomGrants(ctx, h.deps(), sp.ch, sp.row, &target); err != nil {
				h.log.WarnContext(ctx, "pushing a server mute did not finish; the retry loop goes on", "room", sp.row.LivekitRoom, "err", err)
			}
		}
		switch {
		case !prev.Deaf && next.Deaf:
			if err := h.deafenRoom(ctx, sp.row); err != nil {
				h.log.WarnContext(ctx, "a server deafen did not finish; the retry loop repeats it", "room", sp.row.LivekitRoom, "err", err)
			}
		case prev.Deaf && !next.Deaf:
			if err := h.undeafenUser(ctx, sp.ch, sp.row, target); err != nil {
				h.log.WarnContext(ctx, "resubscribing an undeafened member did not finish", "room", sp.row.LivekitRoom, "err", err)
			}
		}
	}
	h.announceVoiceMod(ctx, cid, target, spots, next)
}
```

#### S.4.5 The start answer's `mod` (M1)

`POST /v1/channels/{id}/calls` tells the caller its own moderation, so a muted person's client never tries to publish a microphone (and never shows an open one). In `calls.go`, `callResponse` and `callRungResponse` are replaced by one eight-element struct:

```go
// callStartResponse is the call start's answer (09 § Voice): call_id, group_id, livekit_url, token,
// ice_servers and caps as before; rung([user_id]), the users this start rang ([] unless it opened a
// DM or group-DM call and rang); and mod(uint 0..3), the caller's own server mute (bit 0) and server
// deafen (bit 1) in the channel's community, 0 in a DM (voice moderation). Older clients read the
// first six elements and, for a DM start they opened, rung.
type callStartResponse struct {
	_          struct{} `cbor:",toarray"`
	CallID     id.ID
	GroupID    id.ID
	LiveKitURL string
	Token      string
	ICEServers []iceServer
	Caps       callCaps
	Rung       []id.ID
	Mod        uint64
}
```

- `start` already reads `mod` before the mint (§S.4.2, `start`). The answer is `callStartResponse{CallID: callID, GroupID: groupID, LiveKitURL: h.cfg.LiveKitURL, Token: token, ICEServers: ice, Caps: h.caps(), Rung: []id.ID{}, Mod: modBits(mod)}`. The DM ring branch (`status == http.StatusCreated && row.LivekitRoom == room && (ch.Kind == ChannelDM || ch.Kind == ChannelGroupDM)`) sets `Rung` to `h.ring(...)`, with nil read as `[]id.ID{}` as today.
- `callResponse` and `callRungResponse` are deleted; nothing else uses them.
- protocol/09 § Voice: the start answer row reads `[call_id, group_id, livekit_url, token, ice_servers, caps, rung([user_id]), mod(uint)]`, with a note that `rung` is `[]` unless the start rang and `mod` is 0 in a DM (task S7).
- Test: `TestCallStartAnswersTheOwnModeration` (§S.8, S5).


---

### S.5 The move signal

#### S.5.1 Op 57 `voice_move`

- **Op number:** 57, server-to-client, ephemeral: `n = 0`, never replayed and never persisted. It is ungrouped.
- **Payload:** `[community_id(bstr 16), call_id(bstr 16), channel_id(bstr 16)]`:
  - `call_id` is the call the device must leave, which is the source;
  - `channel_id` is the voice channel it must join through its normal join.
- **Recipients:** each **device** of the moved person that is in a source call and is move-capable, through `DeliverDevice` with `Frame{Op: gateway.OpVoiceMove, Payload: p, Caps: gateway.CapVoiceMove}`. Other users never see it.
- **Client contract** (for protocol/02 and the client tasks):
  - A client in call `call_id` leaves it and joins `channel_id` with its normal `join()`, then says `Moved to {channel}` (`voice.mod.moved`; no `#`). The notice does not name the mover.
  - A client not in `call_id` ignores the frame.
  - A refused join, for example `E_CALL_FULL` or a permission change, is shown as that refusal. The client never retries into the old channel.

Changes in `internal/gateway`:

- `frame.go`:
  - add `OpVoiceMove Op = 57` with the comment `// OpVoiceMove tells one device to leave a call and join another voice channel through its normal join (voice moderation): S->C only, device-scoped, never persisted or replayed.`;
  - add `OpVoiceMove: {elements: 3}` to `opSpecs` with the comment `// [community_id, call_id, channel_id]. Server-to-client, so a client op 57 is E_FRAME_TYPE.`
- `codec.go`:

  ```go
  // VoiceMovePayload is op 57 voice_move's [community_id, call_id, channel_id] (voice moderation): leave call_id, join channel_id.
  func VoiceMovePayload(communityID, callID, channelID id.ID) (cbor.RawMessage, error) { return payload(communityID, callID, channelID) }
  ```
- `gateway.go` `opNames`: add `OpVoiceMove: "voice_move"`.

#### S.5.2 Op 56 `voice_moderation`

This op carries the gateway fan-out of §S.7. It is defined here because it shares the files.

- Op 56, server-to-client, ephemeral, ungrouped.
- **Payload:** `[community_id(bstr 16), user_id(bstr 16), mod(uint 0..3)]`, where `mod` bit 0 is `server_mute` and bit 1 is `server_deaf`.
- `frame.go`: add `OpVoiceModeration Op = 56` and `OpVoiceModeration: {elements: 3}`.
- `codec.go`: add `VoiceModerationPayload(communityID, userID id.ID, mod uint64)`.
- `opNames`: add `OpVoiceModeration: "voice_moderation"`.

#### S.5.3 The capability bit

**Port from `/home/thim/.cache/dilla-w3/upcalls/internal/gateway` verbatim:**

- `Frame.Caps` and its comment (`frame.go`).
- `conn.caps` (`session.go:56-58`) and `(*conn).admits` (`session.go:107-111`).
- `identifyConnection` reads element 4 leniently (`session.go:396-403`): anything that is not a uint reads as 0. Then it calls `g.registerCaps(..., caps)`.
- `registerCaps` (`gateway.go:290-322`). `registerVersions` becomes `return g.registerCaps(ctx, session, s, chosen, 0)`.
- `if c.admits(f) { c.send(f) }` in `DeliverGroup`, `DeliverDevice` and `DeliverUser`.

Do not port `OnlineDevice.Caps` or the election code; they belong to that branch's own feature.

New on top of the port:

```go
// CapVoiceMove is identify's caps bit 1, `voice_move` (voice moderation): the client follows op 57
// by leaving its call and joining the named channel itself, and reads pending cut reasons 3 and 4.
// Bit 0 is CapWithdrawnRows (calls-survive-upgrade), so the two never collide on a rebase.
const CapVoiceMove uint64 = 1 << 1

// DeviceCaps is the AND of the identify caps of every online connection of deviceID (Online's rule:
// ready, live within IdleClose), and whether it has any. A device with an older tab open is as
// capable as that tab: the frame cannot know which tab holds the call.
func (g *Gateway) DeviceCaps(deviceID id.ID) (uint64, bool) {
	now := g.opts.Clock.Now()
	caps, online := ^uint64(0), false
	for _, c := range g.reg.connsOfDevice(deviceID) {
		if c.online(now, g.opts.IdleClose) {
			caps &= c.caps
			online = true
		}
	}
	if !online {
		return 0, false
	}
	return caps, true
}
```

`internal/api/voicemod.go`:

```go
// VoiceModGateway is what voice moderation drives: op 56 to users, op 57 to one device, and the
// device's identify caps. *gateway.Gateway is one.
type VoiceModGateway interface {
	DeliverUser(userID id.ID, f gateway.Frame)
	DeliverDevice(deviceID id.ID, f gateway.Frame)
	DeviceCaps(deviceID id.ID) (uint64, bool)
}

// WithVoiceMod sets the gateway voice moderation uses and returns h. Without it nothing is
// announced and no device is move-capable (every move falls back to a disconnect).
func (h *Calls) WithVoiceMod(gw VoiceModGateway) *Calls { h.modGW = gw; return h }

// moveCapable reports whether every online connection of dev set CapVoiceMove; a device with no
// online connection cannot receive op 57 and is not.
func (h *Calls) moveCapable(dev id.ID) bool {
	if h.modGW == nil {
		return false
	}
	caps, online := h.modGW.DeviceCaps(dev)
	return online && caps&gateway.CapVoiceMove != 0
}
```

Wire it in `internal/dillad/routes.go:122`: `calls.WithAFKAway(p.gw, p.gw.UserConnected).WithAFKDraining(p.gw.Draining).WithVoiceMod(p.gw)`.

**Client:** `gateway.ts:211` sends `CAPS` (`CAP_VOICE_MOVE`, 2) instead of `0` (task T1, §C.3). It ships in the same release as its op 57 and reason 3 and 4 handling (T1, T6, W6).

#### S.5.4 The ~10 s enforcement

New fields on `Calls` (`calls.go`), placed after the AFK block:

```go
	// Voice moderation (voicemod.go). modGW delivers op 56 and op 57 and answers a device's caps.
	// moves is each device a move was sent to: the source room it must leave by deadline, after
	// which SweepVoiceMoves cuts it with pending reason 3. Under moveMu.
	modGW  VoiceModGateway
	moveMu sync.Mutex
	moves  map[id.ID]voiceMove
```

```go
// voiceMoveDeadline is how long a moved device has to leave its source room before the instance
// removes it (spec: "about 10 s"); SweepVoiceMoves runs on the retry tick (CallRetryInterval, 5 s),
// so the cut lands between 10 and 15 s after the move.
const voiceMoveDeadline = 10 * time.Second

type voiceMove struct {
	call     id.ID
	room     string
	deadline time.Time
}

func (h *Calls) noteMove(dev id.ID, row store.VoiceSessionRow) {
	h.moveMu.Lock()
	defer h.moveMu.Unlock()
	if h.moves == nil {
		h.moves = map[id.ID]voiceMove{}
	}
	h.moves[dev] = voiceMove{call: row.CallID, room: row.LivekitRoom, deadline: h.clk.Now().Add(voiceMoveDeadline)}
}

func (h *Calls) clearMove(dev id.ID) {
	h.moveMu.Lock()
	delete(h.moves, dev)
	h.moveMu.Unlock()
}
```

**Admission clears a followed move.** In `Calls.Admitted` (`calls.go:1253`), right after `h.noteAdmission(...)`, add:

```go
h.moveMu.Lock()
if m, ok := h.moves[device]; ok && m.room != room {
	delete(h.moves, device) // it joined elsewhere: it followed the move
}
h.moveMu.Unlock()
```

An admission to the *source* room, such as a LiveKit reconnect before it left, keeps the deadline.

**The sweep.**

```go
// SweepVoiceMoves cuts every moved device still listed in its source room past its deadline, with
// pending reason 3 for its client, and forgets the moves whose device left. A room the SFU cannot
// list, or a cut whose lock is busy, keeps its entry for the next tick. It runs on the retry tick.
func (h *Calls) SweepVoiceMoves(ctx context.Context) {
	if h.sfu == nil {
		return
	}
	now := h.clk.Now()
	h.moveMu.Lock()
	var due []id.ID
	for dev, m := range h.moves {
		if !now.Before(m.deadline) {
			due = append(due, dev)
		}
	}
	h.moveMu.Unlock()
	slices.SortFunc(due, func(a, b id.ID) int { return bytes.Compare(a[:], b[:]) })
	for _, dev := range due {
		h.moveMu.Lock()
		m, ok := h.moves[dev]
		h.moveMu.Unlock()
		if !ok || now.Before(m.deadline) {
			continue // followed or re-moved meanwhile
		}
		row, err := h.repo.GetVoiceSession(ctx, m.call)
		if err != nil || row.Ended != nil || row.LivekitRoom != m.room {
			h.clearMoveIf(dev, m) // the call is over: nothing to leave
			continue
		}
		lctx, cancel := sfuCtx(ctx)
		parts, err := h.sfu.Participants(lctx, m.room)
		cancel()
		if err != nil {
			continue // retried next tick
		}
		if !listsDevice(parts, dev) {
			h.clearMoveIf(dev, m)
			continue
		}
		h.log.WarnContext(ctx, "a moved device did not leave its call in time; it is cut", "room", m.room, "device_id", dev.String())
		if err := h.modCut(ctx, row, dev, afkPendingMoved, callHoldBackground); err != nil {
			continue // the lock was busy: retried next tick
		}
		h.clearMoveIf(dev, m)
	}
}
```

`clearMoveIf(dev, m)` deletes the entry only if it is still the same entry (`h.moves[dev].deadline.Equal(m.deadline)`).

`listsDevice(parts, dev)` is true for an identity equal to `dev.String()` or starting with `dev.String()+"#"`, and skips `ParticipantInfo_DISCONNECTED`.

**Where it runs:** in `StartRetries` (`callgrants.go:799`), inside `case <-tick.C:`, right after `h.SweepAFK(ctx)`, add `h.SweepVoiceMoves(ctx)`. Tests call it directly under the fake clock.

**If the device never joins the target:** nothing more happens to it.

- It is out of the source room, by its own leave or by the cut, and it is in no call.
- The audit row says it was moved.
- Its client shows its own join failure, or reason 3 after a cut.
- The server does not try to put it anywhere. It never decides what a client joins.

#### S.5.5 The removal reasons

Reuse the AFK pending mechanism (`afk.go:45-79`, the `afkPending` map, read by `GET /v1/communities/{id}/afk`). Two new codes go in the same const block:

```go
	afkPendingMoved     = 3 // voice moderation: a moved device that had not left its call by the deadline was cut
	afkPendingModerated = 4 // voice moderation: a moderator disconnected the device
```

Rules:

- Codes 3 and 4 are set only for move-capable devices. Older clients map ≥ 3 to "AFK chosen elsewhere", which would be false (§9).
- The reason is set **before** the removal (R3-n1), so the cut client's first read already says why.
- The reason is put back if the call's lock cannot be taken. A removal the SFU did not take stays a pending cut that the retry loop repeats, so its reason stays.
- Any admission of the device clears it, which already happens in `Admitted` (`delete(h.afkPending, device)`). The 24 h TTL and `SweepAFK`'s pruning apply unchanged.

```go
// modCut removes dev from row's room for a moderator: a disconnect, a move's fallback for a device
// that cannot follow one, or a move's deadline. reason, when non-zero, is set as the device's pending
// cut first (R3-n1) and put back if the call's lock cannot be taken (503 E_UNAVAILABLE, returned).
// The removal itself is removeDevice under the call's lock: a removal the SFU does not take is a
// pending cut the retry loop repeats and the /rtc gate honours, so it is not returned.
func (h *Calls) modCut(ctx context.Context, row store.VoiceSessionRow, dev id.ID, reason uint64, hold time.Duration) error {
	var prev, mine afkPendingEntry
	hadPrev := false
	if reason != 0 {
		h.afkMu.Lock()
		prev, hadPrev = h.afkPending[dev]
		h.setAFKPendingLocked(dev, reason)
		mine = h.afkPending[dev]
		h.afkMu.Unlock()
	}
	lctx, unlock, err := h.lock(ctx, row.CallID, callLockWait, hold)
	if err != nil {
		if reason != 0 {
			h.afkMu.Lock()
			if cur, ok := h.afkPending[dev]; ok && cur.reason == mine.reason && cur.at.Equal(mine.at) {
				if hadPrev {
					h.afkPending[dev] = prev
				} else {
					delete(h.afkPending, dev)
				}
			}
			h.afkMu.Unlock()
		}
		return err
	}
	defer unlock()
	if err := h.removeDevice(lctx, h.deps(), row, dev, true); err != nil {
		h.log.WarnContext(ctx, "a moderator's cut did not land; the retry loop repeats it", "room", row.LivekitRoom, "device_id", dev.String(), "err", err)
	}
	return nil
}
```

The client says `voice.mod.moveMissed` ("A moderator moved you, but your app didn’t follow in time") for 3 and `voice.mod.disconnected` ("Disconnected by a moderator") for 4 (M4). A client that received op 57 and did not follow before the cut has already dropped its offer (phase `removed`), so it reads reason 3 like any cut (§C.6.9). `pendingReason` learns 3 and 4 in T1.

protocol/09: extend the `GET /v1/communities/{id}/afk` `pending` row with: "`3` a moderator moved the device and it had not left its call 10 s later; `4` a moderator disconnected the device. `3` and `4` go only to a device whose every online connection set identify caps bit 1 (`voice_move`)."

---

### S.6 Audit

The audit uses `store.AuditRow{Actor, Action, Target, Detail, At}` through `tx.Audit` inside the transaction that re-checks the rights, as `member.kick` does. `Target` is always the moderated user's id (`target.String()`, hex). Ids in `Detail` are `id.String()` hex, joined by `:`.

| Action | When | Detail |
|---|---|---|
| `voice.server_mute` | `server_mute` 0 → 1 | `<community_id>:<channel_id>` |
| `voice.server_unmute` | `server_mute` 1 → 0 | `<community_id>:<channel_id>` |
| `voice.server_deafen` | `server_deaf` 0 → 1 | `<community_id>:<channel_id>` |
| `voice.server_undeafen` | `server_deaf` 1 → 0 | `<community_id>:<channel_id>` |
| `voice.disconnect` | each spot of a disconnect | `<community_id>:<channel_id>:<devices>` |
| `voice.move` | each source spot of a move | `<community_id>:<from_channel_id>:<to_channel_id>:<moved>:<disconnected>` |

For the four state actions, `channel_id` is `spots[0].ch.ID`, the lowest channel id the target is in. One PATCH that changes both flags writes two rows. A PATCH that changes nothing writes none.

```go
// auditVoiceMod writes one row per flag that changed.
func auditVoiceMod(ctx context.Context, tx store.Repository, actor, cid, target, channel id.ID, prev, next store.VoiceModeration, at int64) error
```

The order is mute first, then deafen.

The cut at a move's deadline writes no row. The move's own row records it, and the server logs a WARN.

protocol/09 gains a bullet under § Voice: "Every server mute, unmute, deafen, undeafen, disconnect and move writes an audit row naming the moderator (`voice.server_mute`, `voice.server_unmute`, `voice.server_deafen`, `voice.server_undeafen`, `voice.disconnect`, `voice.move`); the detail names the community and the channel(s)."

---

### S.7 Gateway fan-out of mute and deafen

**op 50 is not extended**: shipped clients drop an op 50 frame, and a snapshot row, whose flags exceed 31 (§6). There are two carriers:

1. **Live change:** op 56 `voice_moderation` `[community_id, user_id, mod]` (§S.5.2).

   ```go
   // announceVoiceMod sends op 56 to every user who may view a call the target is in (EligibleUsers
   // of each spot's channel, de-duplicated) and to the target. It runs on the request goroutine;
   // without a gateway it sends nothing.
   func (h *Calls) announceVoiceMod(ctx context.Context, cid, target id.ID, spots []voiceSpot, m store.VoiceModeration)
   ```

   - On an encode error, it logs and returns.
   - An `EligibleUsers` error for one channel is logged, and that channel is skipped.
   - It delivers with `h.modGW.DeliverUser(u, gateway.Frame{Op: gateway.OpVoiceModeration, Payload: p})`.
2. **Join and snapshot.**
   - **Snapshot:** `participantRow` (`callread.go:20`) gains a fourth field `Mod uint64`, so a row is `[user_id, device_id, flags, mod]`.
     - `participantRows(row)` becomes `participantRows(row store.VoiceSessionRow, mods map[id.ID]uint64)`, and sets `Mod: mods[p.User]`.
     - `channelCall` builds `mods` with `h.voiceMods(ctx, ch)`.
     - `communityCalls` builds it once, before its loop, with `h.voiceModsOf(ctx, cid)`.

     ```go
     // voiceModsOf is modBits of every moderated member of cid (ListVoiceModeration); voiceMods is it
     // for ch's community, empty for a DM.
     func (h *Calls) voiceModsOf(ctx context.Context, cid id.ID) (map[id.ID]uint64, error)
     func (h *Calls) voiceMods(ctx context.Context, ch store.ChannelRow) (map[id.ID]uint64, error)
     ```

     An error is answered with `server.WriteError`. Old clients ignore the fourth element (`atLeast(row, 3)`).
   - **Join:** in `CallEvents.deliver` (`voicestate.go:120`), after a channel's op 50 frames have been delivered to `audience`, send op 56 to the same audience for each announcement whose user is moderated:

     ```go
     if a.flags&VoiceInCall != 0 && a.ch.CommunityID != nil {
         mctx, mcancel := context.WithTimeout(context.Background(), audienceTimeout)
         m, err := c.repo.GetVoiceModeration(mctx, *a.ch.CommunityID, a.user)
         mcancel()
         if err == nil && (m.Mute || m.Deaf) {
             if p, err := gateway.VoiceModerationPayload(*a.ch.CommunityID, a.user, modBits(m)); err == nil {
                 f := gateway.Frame{Op: gateway.OpVoiceModeration, Payload: p}
                 for _, u := range audience { c.gw.DeliverUser(u, f) }
             }
         }
     }
     ```

     This runs on the announcer goroutine, never on the webhook worker (CALLS-5).

protocol/02 § Ephemeral:

- add rows `| 56 | \`voice_moderation\` | S→C | \`[community_id(bstr 16), user_id(bstr 16), mod(uint 0..3)]\` |` and `| 57 | \`voice_move\` | S→C | \`[community_id(bstr 16), call_id(bstr 16), channel_id(bstr 16)]\` |`;
- add one paragraph: who receives each op, `mod` bit 0 server mute and bit 1 server deafen, and op 57's device scope and caps bit 1.

protocol/09 § Voice: the two snapshot rows read `participants([[user_id(bstr16), device_id(bstr16), flags(uint), mod(uint)]])`, with a note that `mod` is 0 in a DM call.

---

### S.8 Server tests

All Go tests run under `-race` on both engines. The api tests run on sqlite, as the api package does today; the store tests use `engines(t)`. Each authz test is negative-first and must be shown red: break the check, see it fail, then restore.

#### `internal/api/perm_test.go` and `perm_vectors_test.go` (S1)

- `TestPermissionVectors` (updated): 21 cases; `deafen_via_overwrite` resolves `community 4083`, `channel 16781299`; owner and administrator resolve `33554431`.
- `TestDeafenMembersIsChannelScoped`:
  - a role overwrite that allows bit 24 on one channel grants it there only;
  - a role overwrite that denies it removes it there;
  - `api.PermDeafenMembers` is not in what a community-bit overwrite keeps. Assert through `ResolveChannel` with a user overwrite denying bit 24 while the role allows it: the channel result lacks it.

#### `internal/store/voicemod_test.go` (S2)

- `TestVoiceModerationSetGetListAndClear`:
  - Get on a member with no row → zero value, `UserID` set, nil error;
  - Set mute → Get `Mute true, Deaf false`;
  - Set mute and deaf → List has one entry with both;
  - a second member → List ordered by user id;
  - Set both false → Get zero and List without the user.
- `TestVoiceModerationOfANonMemberIsNotFound`: Set for a non-member → `errors.Is(err, store.ErrNotFound)`.
- `TestVoiceModerationGoesWithTheMembership`: `DeleteMember` → List empty, Get zero.
- `TestVoiceModerationMigrationIsSchemaVersion24`: `00024_voice_moderation.sql` is in both FS, and `SchemaVersion >= 24` on both engines. This follows `TestAFKAwayMigrationIsSchemaVersion21`.
- `TestADumpRoundTripsVoiceModeration` (Postgres, skipped without `DILLA_TEST_PG`): a stored mute survives `DumpPostgres` → `LoadPostgres`. This copies `TestADumpRoundTripsTheAFKAwayRoster`.
- Existing tests that change and must pass: `TestDumpTablesNamesEverySchemaTable`, `TestEverySQLiteTableIsStrictAndTyped`, `TestGooseUpDownUpOnSQLite`/`Postgres`, `TestMigrationCarriesEverySchemaFileVerbatim`, `TestQuerierInterfacesAreIdentical`, `TestQueryHeadersAreByteIdenticalAcrossEngines`, `TestSubInterfacesMatchTheContract`.

#### `internal/gateway` (S3)

- `TestIdentifyCapsAreKeptForTheConnection`: identify with caps 2 (`CapVoiceMove`) → `DeviceCaps(dev) == (2, true)`; with caps `"x"` (a text string) → `(0, true)`, and the connection is not refused.
- `TestDeviceCapsIsTheANDOverOnlineConnections`: two connections of one device with caps 2 and 0 → `(0, true)`; close the caps-0 one → `(2, true)`; none → `(0, false)`.
- `TestFrameCapsFiltersTheFanOut`: `DeliverDevice` of a frame with `Caps: CapVoiceMove` reaches the caps-2 connection only, and the caps-0 connection's `n` and ring are untouched.
- `TestOp56And57AreServerToClient`: a client op 56 or 57 of any shape is `E_FRAME_TYPE`; `opSpecs` are `{elements: 3}` only; the encoded frames have `n = 0`; `opNames` are `voice_moderation` and `voice_move`. This follows `TestOp55FromAClientIsEFrameType` and its sibling.

#### `internal/sfu` (S4)

- `TestWithoutAudioDropsMicAndScreenAudio`, a table:
  - `PublishGrant(true,true,true)` → `[CAMERA, SCREEN_SHARE]`, `CanPublish` true;
  - `PublishGrant(true,false,false)` → nil sources, `CanPublish` false;
  - `PublishGrant(false,false,false)` → the same;
  - `CanSubscribe` stays true;
  - the input is not modified.
- `TestUpdateSubscriptionsUnsubscribesAndResubscribes`, against real LiveKit with `spikeServer`/`spikeJoin`:
  - alice publishes a MICROPHONE track, and bob subscribes;
  - `UpdateSubscriptions(room, "bob", [sid], false)` → bob's `OnTrackUnsubscribed` fires;
  - `true` → `OnTrackSubscribed` fires again.
- `TestUpdateSubscriptionsOfAnAbsentIdentityIsErrNoParticipant`: an empty sid list is nil with no call; an absent identity → `ErrNoParticipant`.

#### `internal/api/voicemod_test.go` (S5, S6a, S6b)

**Fixture.** Write `newVoiceModEnv(t)` on top of `newMembershipCallEnvWithoutLoop`. It adds:

- a second voice channel `ch2`, which the member may view and connect to;
- a `modGW` fake implementing `VoiceModGateway`, recording `DeliverUser` and `DeliverDevice` frames with a per-device `caps` map;
- `stub.setPresent(room, &livekit.ParticipantInfo{Identity: memberDev.String(), Tracks: ...})`;
- a moderator user `mod` with a role that has the bits under test.

Helpers:

- `patchVoice(tok, user, mute, deaf any)`;
- `moveVoice(tok, user, ch)`;
- `disconnectVoice(tok, user)`;
- `auditRows(e)`, which reads `e.Repo.ListAudit`.

**Authz, negative.** These tests are the gate for the opus review.

- `TestVoiceMuteNeedsMuteMembersInTheTargetsChannel`:
  - no bit → 403 and nothing stored;
  - the bit allowed only by an overwrite on `ch2` while the target is in `ch` → 403;
  - an overwrite on `ch` → 200;
  - an overwrite on `ch` denying it to a role that has it → 403.
- `TestVoiceDeafenNeedsDeafenMembers`:
  - `mute_members` alone: `[null,1]` → 403;
  - `deafen_members` alone: `[null,1]` → 200 and `[1,null]` → 403.
- `TestVoiceModerationNeverTargetsTheOwner`:
  - an administrator's PATCH, DELETE and move against the owner → 403 each, with nothing stored, no cut and no frame;
  - the owner's PATCH on themself → 200.
- `TestVoiceModerationHasNoRankCheck`: a moderator whose only role sits below the target's highest role → PATCH 200, move 200 and DELETE 204. In contrast, kick by the same moderator → 403.
- `TestVoiceModerationNeedsTheTargetInVoice`:
  - the target in no call → 409 `E_NOT_IN_VOICE` for PATCH, DELETE and move;
  - a stored mute, then not in voice, then PATCH `[0,null]` → 409, and the mute is still stored.
- `TestVoiceModerationHidesACallTheCallerCannotSee`: the target is only in `ch3`, which the moderator cannot view, while the moderator holds the bits elsewhere → 409 `E_NOT_IN_VOICE`, not 403 and not 404.
- `TestVoiceModerationAnswers404ForStrangers`:
  - an unknown community → 404;
  - a caller who is no member → 404;
  - a target who is no member → 404.
- `TestVoiceModerationBodies`, each case 400:
  - PATCH `[null,null]`;
  - PATCH `[2,null]`;
  - PATCH `[true,null]`, a CBOR boolean;
  - PATCH with 3 elements;
  - move `[]`;
  - move with a 15-byte id.
- `TestMoveNeedsMoveMembersOnTheSource`: `move_members` granted only on `ch2`, which is the target → 403.
- `TestMoveNeedsViewAndConnectOnTheTargetForTheMover`: the target hidden from the mover → 404; visible without `connect` → 403.
- `TestMoveRefusesATargetTheMovedPersonCannotJoin`: a user overwrite denies the member `connect` on `ch2` → 403. Also:
  - no op 57 is sent;
  - no removal happens;
  - no audit row is written.
- `TestMoveRefusesAFKTextAndForeignTargets`, each → 400:
  - the AFK channel;
  - a text channel;
  - a voice channel of another community.
- `TestMoveToTheChannelTheyAreInIs400`.
- `TestMoveIntoAFullCallIs409`: `MaxVoiceParticipants: 1`, and the target call has one participant → 409 `E_CALL_FULL`, nothing moved.
- `TestVoiceModerationRechecksRightsInTheTransaction`: the hook `SetVoiceModHookForTest` (below) revokes the moderator's role (`e.Repo.DeleteMemberRole`) at stage `"checked"` → PATCH 403, DELETE 403 and move 403, each with nothing stored, no cut, no frame and no audit row.

**Mute in the grant (S5).** S5 lands before the PATCH route, so its tests seed the state with `e.Repo.SetVoiceModeration` and call `applyVoiceMod` (or `syncRoomGrants` and `deafenRoom`) directly; S6a re-runs them through PATCH, which is how they are written below.

- `TestServerMuteWithdrawsMicAndScreenAudio`:
  - a non-sharing device: after PATCH `[1,null]`, `stub.lastPerms()[dev]` is `CanPublish` false with nil sources;
  - a device that holds a sharing slot (POST share first) → `[CAMERA, SCREEN_SHARE]`, with no `MICROPHONE` and no `SCREEN_SHARE_AUDIO`;
  - `CanSubscribe` stays true.
- `TestServerMuteHoldsOnJoin`, for a muted member:
  - POST `/v1/channels/{ch2}/calls` → the minted token's permission (`stub.mints`) has no `MICROPHONE`;
  - `AdmitRoom` → a grant without the microphone;
  - `Handle(participant_joined)` → the push has no microphone.
- `TestServerMutePersistsAcrossCalls`: mute; the device leaves (`setPresent` empty); a new start later → no microphone.
- `TestServerMuteDoesNotReachDMCalls`: a muted member starts a DM call → the token has `MICROPHONE`.
- `TestCallStartAnswersTheOwnModeration`: a community start answers 8 elements with `rung` `[]`; a muted member's element 7 is 1, a deafened member's 2, a muted and deafened member's 3, an unmoderated member's 0; a DM start that rings answers `rung` with the rung users and `mod` 0. Existing `calls_test.go` cases that decode a six- or seven-element start answer read eight.
- `TestServerUnmuteRestoresTheMic`: PATCH `[0,null]` → the last push has `MICROPHONE`.
- `TestDeafenImpliesMuteAndUndeafenKeepsTheStoredMute`:
  - `[null,1]` → no microphone;
  - `[1,null]` → still none;
  - `[null,0]` → still none, because mute is stored;
  - `[0,null]` → microphone back.
- `TestRoleSyncKeepsAServerMute`: a muted member gets a new role with `speak`; `SyncCallGrants` → the push still has no microphone.

**Deafen (S5).**

- `TestServerDeafenUnsubscribesAudioOnly`: the room holds the member and `other`. `other` has tracks `TR_mic` (AUDIO, MICROPHONE), `TR_sa` (AUDIO, SCREEN_SHARE_AUDIO) and `TR_cam` (VIDEO, CAMERA). PATCH `[null,1]` → `stub.subUpdates()` contains `{room, memberDev, ["TR_mic","TR_sa"], false}`, never with `TR_cam`, and none for `other`.
- `TestServerDeafenIsReappliedOnJoinTrackAndSweep`:
  - `Handle(track_published)` of a new AUDIO track by `other` → a new unsubscribe for the member that includes it;
  - `Handle(track_published)` of a VIDEO track → no new update;
  - `Handle(participant_joined)` of the member → an unsubscribe;
  - `SweepRooms` → an unsubscribe.
- `TestServerDeafenFailureLeavesARoomResync`: `subFail` set → PATCH still 200; a pending `roomResync`; then clear `subFail`, `RetryPending` → the unsubscribe lands.
- `TestUndeafenResubscribesAudio`: `[null,0]` → `{room, memberDev, ["TR_mic","TR_sa"], true}`.
- `TestNobodyDeafenedMakesNoSFUCall`: `track_published` with no moderation rows → no `UpdateSubscriptions` call.

**Fan-out and snapshot (S5).**

- `TestVoiceModerationOp56ReachesTheChannelAudience`: PATCH `[1,null]` → op 56 `[cid, member, 1]` to every user who can view `ch`, the member included, and not to a member who cannot view `ch`.
- `TestJoinOfAModeratedUserAnnouncesOp56`: a muted member's `participant_joined` → after the announcer drains, op 56 `[cid, member, 1]` to the audience. An unmoderated join sends no op 56.
- `TestCallSnapshotsCarryTheModerationElement`: `GET /v1/channels/{ch}/call` and `GET /v1/communities/{cid}/calls` rows have 4 elements. The muted member's fourth is 1, a deafened one's is 2, both is 3, and an unmoderated one's is 0. A DM call's is 0.

**Audit (S6a).**

- `TestVoiceModerationAuditsEachChange`:
  - `[1,null]` → one `voice.server_mute` row, with `Actor` the moderator, `Target` the member and `Detail` `cid:ch`;
  - `[1,null]` again → no new row;
  - `[0,1]` → `voice.server_unmute` then `voice.server_deafen`;
  - `[null,0]` → `voice.server_undeafen`.

**Disconnect (S6b).**

- `TestDisconnectCutsEveryDeviceWithAReasonForCapableOnes`: the member has two devices in the room, `memberDev` with caps `CapVoiceMove` and `phone` with caps 0. DELETE → 204, and both are removed (`removedDevice`). Pending: `memberDev` → 4, `phone` → 0. The audit row is `voice.disconnect` with detail `cid:ch:2`.
- `TestDisconnectedDeviceMayRejoin`: after DELETE, POST `/v1/channels/{ch}/calls` → 200.
- `TestDisconnectBusyLockIs503AndKeepsNoReason`: hold the call's lock (the existing `lockCall` test hook, or a hanging stub push) → 503 `E_UNAVAILABLE`, and pending stays 0.

**Move (S6b).**

- `TestMoveSendsOp57ToCapableDevices`: `memberDev` has caps `CapVoiceMove`. Move to `ch2` → 200 `[1,0]`. One `DeliverDevice(memberDev)` op 57 `[cid, callID, ch2]` with `Caps == CapVoiceMove`. No removal. Audit `voice.move` detail `cid:ch:ch2:1:0`.
- `TestMoveDisconnectsDevicesThatCannotFollow`: caps 0 → 200 `[0,1]`, the device removed, pending 0, no op 57. Detail `cid:ch:ch2:0:1`.
- `TestMoveWithMixedDevices` → `[1,1]`.
- `TestMoveIsEnforcedAfterTenSeconds`:
  - at +9 s, `SweepVoiceMoves` → no removal;
  - at +10 s, with the device still listed → removed, and the AFK snapshot pending is 3;
  - a second device that left the room before the deadline → no removal.
- `TestMoveFollowedIsForgotten`: `Admitted(targetRoom, memberDev)` before the deadline, then +11 s and `SweepVoiceMoves` → no removal. `Admitted(sourceRoom, ...)` instead → the device is still cut at the deadline.
- `TestMoveDeadlineSurvivesAnSFUListingFailure`: `listFail` at the deadline → no cut and the entry kept; the next sweep without the failure → cut.

#### `internal/dillad` (S4, S6b)

- The fakes compile with `UpdateSubscriptions`.
- `TestVoiceModWiring`: `routes.go` passes the gateway (`WithVoiceMod`), so a move against a real `gateway.Gateway` with a connection whose caps set `CapVoiceMove` sends op 57. If the harness makes this heavy, a compile-time assertion `var _ api.VoiceModGateway = (*gateway.Gateway)(nil)` in `internal/dillad` is enough.

---

---

## Appendix C: client-core and media

Scope: `packages/client-core`, `packages/media/src/audio/speakers.ts`, and the web literals and call-session contract that client-core's changes reach. The page work (menus, drag, notices) is Appendix U; this appendix states only the contract client-core gives it. Wire names are §8.

### C.1 The wire as the client sees it

- **Identify** element 4 `caps` = `CAPS` = `CAP_VOICE_MOVE` = 2 (bit 1). Setting it means "this client follows op 57 by leaving its call and joining the named channel itself, and reads pending reasons 3 and 4". On a rebase over calls-survive-upgrade, `CAPS` becomes `CAP_WITHDRAWN_ROWS | CAP_VOICE_MOVE` (3).
- **Op 56 `voice_moderation`** `[community_id, user_id, mod]`, `n = 0`, `group_id` null, `mod` 0..3. A malformed one is dropped without closing the socket.
- **Op 57 `voice_move`** `[community_id, call_id, channel_id]`, `n = 0`, `group_id` null. Sent only to this device, only while it is in `call_id`'s room. A malformed one is dropped.
- **Op 50** is unchanged: flags 0..31.
- **Snapshot rows** (`GET /v1/channels/{id}/call`, `GET /v1/communities/{id}/calls`): `[user_id, device_id, flags(0..31), mod(uint)]`. The client folds `mod` into its own row flags as `flags | ((mod & 3) << 5)`; higher bits of `mod` are ignored, so later bits stay compatible.
- **Call start** (`POST /v1/channels/{id}/calls`): element 6 `rung` is always present, element 7 is `mod(uint)` for the caller's own user. The client reads `mod = a.length > 7 ? u53(a[7]) & 3 : 0`.
- **AFK pending** (`GET /v1/communities/{id}/afk` element 3): the client maps 0 → 0, 1 → 1, 3 → 3, 4 → 4, every other non-zero value → 2.
- **Routes:** §8.2. **Errors:** §8.2; the page's copy for each is §C.5.4.

### C.2 HTTP routes (`http/routes.ts`)

Add next to the call routes, after `endCallIfAlone` (routes.ts:908):

```ts
/** voice moderation (W7): what a move did. `moved` counts devices the instance sent op 57; `disconnected` counts devices
 *  whose client cannot follow a move (no CAP_VOICE_MOVE), which the instance cut instead; the page says so to the mover. */
export interface VoiceMoveResult { moved: number; disconnected: number }
/** A member's stored server mute and server deafen, as a PATCH answered them. */
export interface ServerVoice { mute: boolean; deaf: boolean }

/** /v1/communities/{id}/members/{user_id}/voice, plus `rest`. */
function memberVoicePath(communityId: Uint8Array, userId: Uint8Array, rest = ''): string {
  return `/v1/communities/${id('communityId', communityId)}/members/${id('userId', userId)}/voice${rest}`;
}

  /** PATCH /v1/communities/{id}/members/{user}/voice: [mute|null, deaf|null] → [mute, deaf]. null leaves that flag as it
   *  is; both null is refused here as E_ROUTE_INPUT, as the instance would refuse it (400). It sets values, so it is
   *  idempotent. */
  async setServerVoice(communityId: Uint8Array, userId: Uint8Array, mute: boolean | null, deaf: boolean | null): Promise<ServerVoice> {
    if (mute === null && deaf === null) throw new RangeError('E_ROUTE_INPUT: nothing to change');
    const bit = (v: boolean | null) => (v === null ? null : v ? 1 : 0);
    const raw = await this.body('PATCH', memberVoicePath(communityId, userId), 'write', true,
      { body: encode([bit(mute), bit(deaf)]), ok: [200] });
    const a = atLeast(decode(raw), 2);
    return { mute: flag(a[0]), deaf: flag(a[1]) };
  }
  /** DELETE /v1/communities/{id}/members/{user}/voice: every device of the user leaves every call of the server. */
  async disconnectVoiceMember(communityId: Uint8Array, userId: Uint8Array): Promise<void> {
    await this.body('DELETE', memberVoicePath(communityId, userId), 'write', true, { ok: [204] });
  }
  /** POST /v1/communities/{id}/members/{user}/voice/move: [channel_id] → [moved, disconnected]. Not idempotent: a retried
   *  move whose first attempt went through answers 400 (they are already in that channel). */
  async moveVoiceMember(communityId: Uint8Array, userId: Uint8Array, channelId: Uint8Array): Promise<VoiceMoveResult> {
    const raw = await this.body('POST', memberVoicePath(communityId, userId, '/move'), 'write', false,
      { body: encode([inputId('channelId', channelId)]), ok: [200] });
    const a = atLeast(decode(raw), 2);
    return { moved: u53(a[0]), disconnected: u53(a[1]) };
  }
```

Changes to existing code:

- `participants()` (routes.ts:213):

  ```ts
  const mod = a.length > 3 ? u53(a[3]) & 3 : 0;
  return { userId: bin(a[0], 16), deviceId: bin(a[1], 16), flags: flags | (mod << 5) };
  ```

  Keep the `flags > 31` refusal: element 2 stays 0..31 on the wire.
- `CallStarted` gains `mod: number` (0..3). In `startCall` add `mod: a.length > 7 ? u53(a[7]) & 3 : 0`. `rung` keeps `a.length > 6 ? … : null`; a community start now answers `rung: []`, which only the DM ring path reads.
- `pendingReason()` returns `0 | 1 | 2 | 3 | 4`: `n === 0 ? 0 : n === 1 ? 1 : n === 3 ? 3 : n === 4 ? 4 : 2`. Its comment: "3 a moderator moved this device and it had not left its call 10 s later; 4 a moderator disconnected it; any other value reads as 2". Widen `AFKSnapshot.reason` to `0 | 1 | 2 | 3 | 4`.
- `PERM_ALL` and its comments are task T2 (§S.2).

### C.3 Gateway and frames

`gateway/frames.ts`:

- `Op.voiceModeration: 56, Op.voiceMove: 57`.
- In `SPECS`, add `[56, 3], [57, 3]` (ungrouped: `group_id` must be null).
- In `decodeFrame`, after the op 55 line:

  ```ts
  // op 56 voice_moderation (voice moderation): [community_id, user_id, mod 0..3], mod bit 0 server mute, bit 1 server deafen.
  if (op === 56n && (n !== 0n || !isId(payload[0]) || !isId(payload[1]) || !flags(payload[2]))) shape();
  // op 57 voice_move (voice moderation): [community_id, call_id, channel_id]: leave call_id, join channel_id.
  if (op === 57n && (n !== 0n || !isId(payload[0]) || !isId(payload[1]) || !isId(payload[2]))) shape();
  ```

  (`flags` is the existing 0..3 check of op 52.)
- `voiceFlags` stays 0..31.
- Add `Op.voiceModeration` and `Op.voiceMove` to `DROPPABLE_OPS`, and extend its comment: "the voice moderation signals (ops 56 and 57)".
- Add the types and readers:

  ```ts
  export interface VoiceModerationFrame { communityId: Uint8Array; userId: Uint8Array; mod: number }
  /** op 56 [community_id, user_id, mod] (voice moderation); any other frame is E_FRAME_SHAPE. */
  export function voiceModerationOf(frame: Frame): VoiceModerationFrame {
    const [community, user, mod] = frame.payload;
    if (frame.op !== Op.voiceModeration || frame.payload.length !== 3 || !isId(community) || !isId(user) || !flags(mod)) shape();
    return { communityId: community as Uint8Array, userId: user as Uint8Array, mod: Number(mod) };
  }

  export interface VoiceMoveFrame { communityId: Uint8Array; callId: Uint8Array; channelId: Uint8Array }
  /** op 57 [community_id, call_id, channel_id] (voice moderation); any other frame is E_FRAME_SHAPE. */
  export function voiceMoveOf(frame: Frame): VoiceMoveFrame {
    const [community, call, channel] = frame.payload;
    if (frame.op !== Op.voiceMove || frame.payload.length !== 3 || !isId(community) || !isId(call) || !isId(channel)) shape();
    return { communityId: community as Uint8Array, callId: call as Uint8Array, channelId: channel as Uint8Array };
  }
  ```

`gateway/gateway.ts`:

```ts
/** identify's caps (protocol/02 § Control): bit 1 `voice_move` (voice moderation): this client follows op 57 by leaving
 *  its call and joining the named channel itself, and reads pending reasons 3 and 4. Bit 0 is calls-survive-upgrade's
 *  `withdrawn_rows`; on that rebase, CAPS = CAP_WITHDRAWN_ROWS | CAP_VOICE_MOVE. */
export const CAP_VOICE_MOVE = 2;
export const CAPS = CAP_VOICE_MOVE;
```

- Line 211 becomes `encodeFrame(Op.identify, 1, null, ['', WIRE, 1, 1, CAPS])`.
- The ready-phase dispatch (line 235-236) emits ops 56 and 57 as frames: add `|| frame.op === Op.voiceModeration || frame.op === Op.voiceMove` to the condition (M8).

`worker/controller.ts:1644`: the branch becomes
`(e.frame.op === Op.voiceState || e.frame.op === Op.callRing || e.frame.op === Op.voiceModeration || e.frame.op === Op.voiceMove)`. `ownVoiceState` still runs only for op 50.

### C.4 State types (`state/types.ts`) and exports

```ts
/** voice_state flag bits (02 § voice_state): bits 0-4 travel in op 50; bits 5-6 never do. They are a moderator's mute and
 *  deafen, which VoiceBook folds into each row from op 56 and the snapshots' fourth element (`mod`). */
export const VOICE_FLAG = { inCall: 1, selfMute: 2, selfDeaf: 4, video: 8, screen: 16, serverMute: 32, serverDeaf: 64 } as const;
```

`CallState` gains three **required** fields:

```ts
  /** voice moderation: a move the instance asked this device to follow (op 57), only while phase is 'in' or 'paused';
   *  null otherwise. `to` is the target voice channel (hex). `seq` rises with every move offered (one counter for the
   *  worker's life), so the page follows each one once. The page follows with its own switch: callLeave 'switch', then
   *  callJoin of `to`. */
  move: { to: string; seq: number } | null;
  /** A moderator muted / deafened this person (member state, applied to every call): from the join's answer and op 56
   *  about this user; false outside phases 'in' and 'paused'. The microphone cannot publish while either is true. */
  serverMuted: boolean; serverDeafened: boolean;
```

- `CALL_IDLE` gains `move: null, serverMuted: false, serverDeafened: false`.
- `CallJoinResult` gains `serverMuted?: boolean; serverDeafened?: boolean`. client-core always sets them; they are optional only so page fixtures keep compiling.
- `AFKState.pendingReason` widens to `0 | 1 | 2 | 3 | 4`, with the comment "3 a moderator moved it and it did not follow in time; 4 a moderator disconnected it".
- `index.ts` exports `VOICE_FLAG` beside `CALL_IDLE`, the types `VoiceMoveResult` and `ServerVoice`, and (T3, T4) the functions of §C.9.2 and §C.10.

Literals that spell out a whole idle `CallState` and gain the three fields: `worker/bridge.test.ts:111`, `calls/controller.test.ts:1810`, `packages/web/src/App.test.tsx:275,283`.

### C.5 Worker commands

#### C.5.1 Commands (`worker/protocol.ts`, appended after `revokeInvite`)

```ts
  // voice moderation (W7). The page gates them with voiceModAccess (advisory); the instance decides. The instance acts on
  // every call of the server the person has a device in.
  | { m: 'voiceMove'; communityId: string; userId: string; toChannelId: string }   // ready → VoiceMoveResult { moved, disconnected }
  | { m: 'voiceDisconnect'; communityId: string; userId: string }                  // ready → null; 409 E_NOT_IN_VOICE (already gone) is success
  | { m: 'serverMute'; communityId: string; userId: string; on: boolean }          // ready → null
  | { m: 'serverDeafen'; communityId: string; userId: string; on: boolean }        // ready → null
```

A move or disconnect of this device's own row, while this device is in that call (`voiceModAccess(...).local`), is not a command: the page switches or leaves locally (§U.5.1.5). `callLeave` reasons do not change: a move is followed with `'switch'`.

#### C.5.2 Registration (`worker/controller.ts`)

- Add the four names to `COMMANDS` (after `'revokeInvite'`, :287) and to `ACCEPTS.ready` (after `'revokeInvite'`, :513).
- In the `ID_FIELDS` key type (:358), add `'toChannelId'` to the union. Then add:
  `voiceMove: ['communityId', 'userId', 'toChannelId'], voiceDisconnect: ['communityId', 'userId'], serverMute: ['communityId', 'userId'], serverDeafen: ['communityId', 'userId']`.
- Dispatch, after the `revokeInvite` case:

  ```ts
  case 'voiceMove': return this.admin.voiceMove(command.communityId, command.userId, command.toChannelId);
  case 'voiceDisconnect': return this.admin.voiceDisconnect(command.communityId, command.userId);
  case 'serverMute': return this.admin.serverVoice(command.communityId, command.userId, 'mute', command.on);
  case 'serverDeafen': return this.admin.serverVoice(command.communityId, command.userId, 'deaf', command.on);
  ```
- In the `AdminController` construction (:974), add
  `loadVoice: (c, ch) => this.calls.loadVoice(c, ch), afkChannel: (c) => this.slices.get(\`afk:${c}\`)?.channelId ?? null,`.

#### C.5.3 `admin/controller.ts`

- `AdminRoutes` adds `'moveVoiceMember' | 'disconnectVoiceMember' | 'setServerVoice'`.
- `AdminDeps` adds:

  ```ts
  /** Reads who is in voice again (CallController.loadVoice); rejects when the read does. */
  loadVoice(communityId: string | null, channelId: string | null): Promise<unknown>;
  /** The server's built-in AFK channel (afk:<id>.channelId), or null while unknown. */
  afkChannel(communityId: string): string | null;
  ```
- `AdminCommand` adds `'voiceMove' | 'voiceDisconnect' | 'serverMute' | 'serverDeafen'`.
- In `ADMIN_VALIDATORS`, add:

  ```ts
  voiceMove: undefined,          // the target is checked against the worker's lists in voiceMove
  voiceDisconnect: undefined,
  serverMute: (c) => (typeof c.on === 'boolean' ? null : 'on is not a boolean'),
  serverDeafen: (c) => (typeof c.on === 'boolean' ? null : 'on is not a boolean'),
  ```
- Beside `statusOf` (:111): `const codeOf = (e: unknown): string | null => (e instanceof DillaHttpError ? e.code : null);`.
- The methods go in a new section `// ---- voice moderation ----` before `// ---- invites ----`:

```ts
  /** POST …/members/{user}/voice/move. The target must be a known voice channel of the same server, never its built-in AFK
   *  channel (it hosts no call; J7). 409 E_NOT_IN_VOICE (they left voice) reads the server's calls again and surfaces; a
   *  403 reads the access again (guarded) and surfaces. */
  async voiceMove(communityId: string, userId: string, toChannelId: string): Promise<VoiceMoveResult> {
    this.requireListed(communityId);
    const target = this.known(toChannelId);
    if (target.communityId !== communityId) throw this.deps.refusal('E_BAD_INPUT', 'the target is in another server');
    if (target.row.kind !== 1) throw this.deps.refusal('E_BAD_INPUT', 'not a voice channel');
    if (toChannelId === this.deps.afkChannel(communityId)) throw this.deps.refusal('E_BAD_INPUT', 'nobody is moved into the AFK channel');
    try {
      return await this.guarded(communityId, () => this.deps.routes.moveVoiceMember(fromHex(communityId), fromHex(userId), target.row.id));
    } catch (e) {
      if (codeOf(e) === 'E_NOT_IN_VOICE') this.track(this.deps.loadVoice(communityId, null));
      throw e;
    }
  }

  /** DELETE …/members/{user}/voice. 409 E_NOT_IN_VOICE is success (they are no longer in voice); the calls are read again. */
  async voiceDisconnect(communityId: string, userId: string): Promise<null> {
    this.requireListed(communityId);
    try {
      await this.guarded(communityId, () => this.deps.routes.disconnectVoiceMember(fromHex(communityId), fromHex(userId)));
    } catch (e) {
      if (codeOf(e) !== 'E_NOT_IN_VOICE') throw e;
      this.track(this.deps.loadVoice(communityId, null));
    }
    return null;
  }

  /** PATCH …/members/{user}/voice with one flag set and the other null. 409 E_NOT_IN_VOICE reads the server's calls again
   *  and surfaces, because the action is offered only while they are connected. */
  async serverVoice(communityId: string, userId: string, kind: 'mute' | 'deaf', on: boolean): Promise<null> {
    this.requireListed(communityId);
    try {
      await this.guarded(communityId, () => this.deps.routes.setServerVoice(fromHex(communityId), fromHex(userId),
        kind === 'mute' ? on : null, kind === 'deaf' ? on : null));
    } catch (e) {
      if (codeOf(e) === 'E_NOT_IN_VOICE') this.track(this.deps.loadVoice(communityId, null));
      throw e;
    }
    return null;
  }
```

No success path re-reads anything: op 56 and op 50 carry the outcome to every viewer, the mover included.

#### C.5.4 Error mapping (the page's copy keys; wording §U.9.4)

| From | Code (WorkerError) | Page copy key | Extra |
|---|---|---|---|
| worker validator, `known`, `requireListed` | `E_BAD_INPUT` | `voice.mod.error.generic` | nothing was sent |
| 403 | `E_FORBIDDEN` | `voice.mod.error.forbidden` | the worker re-read `permissions:`, `roles:` and `overwrites:`, so the menu recomputes |
| 409 | `E_NOT_IN_VOICE` | `voice.mod.error.gone` (move, mute, deafen); success for disconnect | the worker re-read the server's calls |
| 409 | `E_CALL_FULL` | `voice.mod.error.full` | move only; nothing moved |
| 404 | `E_NOT_FOUND` | `voice.mod.error.generic` | a race: the person left the server, or the target channel is gone |
| 400 | `E_INVALID_REQUEST` | `voice.mod.error.generic` | |
| 0 / 5xx / 429 | as today | the existing network and rate copy | 503 `E_UNAVAILABLE` included |
| `voiceMove` ok, `disconnected > 0` | — | `voice.mod.movedDisconnected` | announced, and a warn banner |

### C.6 Applying a move (`calls/controller.ts`)

#### C.6.1 Principle

The worker validates op 57 and **offers** the move on the `call` slice (`call.move`). The page follows it through its existing channel switch: `callLeave` `'switch'` (the worker's ordinary leave with its self-Remove), then `startPageCall` → `callJoin(to)` (the worker's ordinary join). The moved device joins the target's MLS group only through its own join and its own gates (§4). No key and no join decision comes from the frame.

#### C.6.2 New deps and constants

```ts
/** voice moderation: a move to a channel this worker does not list yet reads the server's channels at most this long first. */
export const MOVE_RELOAD_MS = 3000;
```

`CallDeps` gains:

```ts
  /** Reads a server's channels and members again (the worker's loadCommunity); rejects when the read does. */
  reloadCommunity(communityHex: string): Promise<void>;
  /** The server's built-in AFK channel (afk:<id>.channelId), or null while unknown. */
  afkChannel(communityHex: string): string | null;
```

Wire them in `worker/controller.ts` (:924):
`reloadCommunity: (c) => this.loadCommunity(c), afkChannel: (c) => this.slices.get(\`afk:${c}\`)?.channelId ?? null,`.

`Live` gains `mod: number` (bit 0 server-muted, bit 1 server-deafened). `CallController` gains `private moveSeq = 0;`, which is never reset (`reset()` leaves it alone).

#### C.6.3 `setState`: one central rule

At the top of `setState(next)`:

```ts
    // voice moderation: a move offer and the moderator's state exist only in a call (phases in and paused).
    if (next.phase !== 'in' && next.phase !== 'paused' && (next.move !== null || next.serverMuted || next.serverDeafened)) {
      next = { ...next, move: null, serverMuted: false, serverDeafened: false };
    }
```

So a leave (phase `leaving`), a removal, a block, a failure or a reset clears the offer without touching any of those paths.

`setIn` builds a literal, so it adds three fields: `move: this.state.move, serverMuted: (live.mod & 1) !== 0, serverDeafened: (live.mod & 2) !== 0`. The rekey path calls `setIn` mid-call, so a pending offer survives a rekey. On a join, the state before was `joining`, so `move` is already null.

`joinOnce` sets `mod: joined.started.mod` in the `Live` literal and adds `serverMuted: (started.mod & 1) !== 0, serverDeafened: (started.mod & 2) !== 0` to the returned `CallJoinResult`.

#### C.6.4 `onFrame`

At its top:

```ts
    if (frame.op === Op.voiceModeration) {
      let f: VoiceModerationFrame;
      try { f = voiceModerationOf(frame); } catch { return; }
      this.book.moderation(f);
      this.ownModeration(f);
      return;
    }
    if (frame.op === Op.voiceMove) {
      let f: VoiceMoveFrame;
      try { f = voiceMoveOf(frame); } catch { return; }
      this.moveFrame(f);
      return;
    }
```

Import `voiceModerationOf, voiceMoveOf, type VoiceModerationFrame, type VoiceMoveFrame` from `../gateway/frames`.

#### C.6.5 The move

```ts
  // ---- voice moderation: a move from the instance (op 57) ----

  /** The live, keyed community call a move frame names; null when it names anything else or the call is not live. */
  private movable(f: VoiceMoveFrame): Live | null {
    const live = this.live;
    if (live === null || live.leaving || live.dm || toHex(live.callId) !== toHex(f.callId)) return null;
    if (this.deps.callTarget(live.channel)?.communityId !== toHex(f.communityId)) return null;
    return this.state.phase === 'in' || this.state.phase === 'paused' ? live : null;
  }

  /** A target the page can join: another known voice channel of the call's own server, not its AFK channel. */
  private moveTarget(live: Live, to: string): boolean {
    const community = this.deps.callTarget(live.channel)?.communityId ?? null;
    if (community === null || to === live.channel || to === this.deps.afkChannel(community)) return false;
    return this.deps.callTarget(to)?.communityId === community;
  }

  /** Op 57. Ignored unless it names the live call. A target this worker does not list yet (the list predates the right
   *  that lets this person see it) is read once, bounded by MOVE_RELOAD_MS, then offered or dropped. A dropped move is
   *  enforced by the instance (it cuts the device after about 10 s, pending reason 3). */
  private moveFrame(f: VoiceMoveFrame): void {
    const live = this.movable(f);
    if (live === null) return;
    const to = toHex(f.channelId);
    if (this.moveTarget(live, to)) { this.offerMove(to); return; }
    const community = this.deps.callTarget(live.channel)?.communityId ?? null;
    if (community === null || this.deps.known(to)) return;   // a known channel that is not a target: dropped
    this.deps.track((async () => {
      let timer: number | null = null;
      await Promise.race([this.deps.reloadCommunity(community).catch(() => undefined),
        new Promise<void>((resolve) => { timer = this.deps.setTimeout(resolve, MOVE_RELOAD_MS); })]);
      if (timer !== null) this.deps.clearTimeout(timer);
      const still = this.movable(f);
      if (still === live && this.moveTarget(live, to)) this.offerMove(to);
    })());
  }

  /** Publishes the offer; the same target again changes nothing, and a new target replaces an unfollowed one. */
  private offerMove(to: string): void {
    if (this.state.move?.to === to) return;
    this.moveSeq += 1;
    this.setState({ ...this.state, move: { to, seq: this.moveSeq } });
  }
```

#### C.6.6 The exact sequence, end to end

1. The instance sends op 57 `[community, source call, target]` to each of the moved user's capable devices in the source room.
2. Each worker accepts it (§C.6.5) and publishes `call` with `move: { to, seq }`. Phase stays `in` (or `paused`). Nothing is sent.
3. The page sees `call.move` with a `seq` it has not handled, while `call.channelId` is the channel of its live session. It runs its switch to `move.to` with the old session's `AudioContext` (D17):
   - The session's `leave('switch')` posts `callLeave 'switch'` and stops media. Media stopping is `room.disconnect()`; that is what the instance watches for.
   - The worker's `leave()` → `leaveLive(live, false, false)` sets `leaving`, stops the rotation, and sets phase `leaving`, which clears `move` under the rule of §C.6.3.
   - Alone in the source (the last keyed roster holds only this device, and the snapshot shows no other device), it sends `DELETE /v1/calls/{source}?if_alone=1`.
   - Then, on the group lane, it posts the self-Remove proposal (`POST /v1/groups/{g}/proposal` with `callLeaveProposal`; a 409 `E_REMOVE_PENDING` is fine) and forgets the group (`callGroupForget`).
   - It ends in phase idle.
4. The page's `startPageCall(to)` sends `callJoin(to)`. This is the worker's ordinary `join()` → `joinCall`: snapshot, register or external join, `callJoinCheck`, `callMediaEpoch`, `startCall`. Then `setIn` sets phase `in` on `to`. `serverMuted` and `serverDeafened` come from the answer's `mod`.
5. The instance's `Admitted` sees the device in the target room and forgets the move's deadline.
6. The page announces `voice.mod.moved` (`Moved to {channel}`) once phase is `in` on `to`. Following Discord, the notice does not name the mover.

These are the same self-Remove semantics as a person's own leave. That is right: from the source group's point of view the device left.

#### C.6.7 A refused target join

The worker answers `callJoin(to)` with the refusal and ends in phase `failed` or `blocked` with its error, exactly as for any join. It does not rejoin the source, which the person was moved out of. Phase `failed` or `blocked` comes with `channelId: to`. The page knows it was following a move (it started the switch from `call.move`), so it says `voice.mod.moveFailed` (`You were moved to {channel}, but couldn’t join it.`) together with the usual reason. It stays out of voice, as Discord does when a move target refuses the connection.

#### C.6.8 Races

| Situation | What happens |
|---|---|
| op 57 while this device is joining any channel (`live === null`) | ignored (`movable` → null). The device is in no room yet, so the instance cannot have meant this join. |
| op 57 while leaving (the person's own switch or leave, a block's leave) | ignored (`live.leaving`). The device is leaving the source anyway. |
| op 57 for another call id, another community, a DM call, or phase `blocked`/`failed`/`removed` | ignored. |
| a second op 57 before the page followed | `offerMove` replaces `to` with a new `seq`. The page follows the newest. The same target twice publishes nothing. |
| a second op 57 while the page's switch is running | ignored (leaving or joining). If the instance still wants the device elsewhere, it sends a move for the new call. |
| a move back to a channel this device just left (A → B → A) | the target join meets `E_REMOVE_PENDING` and takes the existing rejoin wait (phase joining, `rejoining: true`, at most 30 s). No new code. |
| reload or page hide during the follow | pagehide posts `callLeave 'pagehide'` (the same leave); the worker dies with the page; after the reload there is no call and no offer. If the device was still in the room after 10 s, the instance cuts it with pending 3, and nothing is shown (there is no call to explain). |
| the gateway is down when op 57 is sent | the frame is lost (ephemeral). The instance enforces the move at 10–15 s: the room ends `PARTICIPANT_REMOVED`, and pending 3 says `voice.mod.moveMissed`. |
| sign-out, wipe or reset with an offer | `reset()` publishes `CALL_IDLE` (`move: null`). |
| a channel the device is following into is deleted meanwhile | the ordinary join refusal (§C.6.7). |

#### C.6.9 "Moved", "removed" and "disconnected"

- **`endCodeOf`** (`web/src/call/session.ts:283`): unchanged. A followed move never produces a room end, because the page leaves through its own switch.
- **`useCall` `cutReason` / `sayRemoved` / the recovery verdict:** these handle only room ends, the `E_REMOVED` path (task W6, §U.8.2):
  - `cutReason` returns reasons `1 | 2 | 3 | 4`;
  - reason 3 says `voice.mod.moveMissed`, reason 4 says `voice.mod.disconnected`;
  - the `else` branch at useCall.tsx:458 becomes an explicit `cut.reason === 2`; otherwise a 3 or 4 falls into `afk.elsewhere`, and TypeScript does not catch it;
  - the recovery verdict at :878 maps 3 to `'moveMissed'` and 4 to `'modDisconnected'`, and `endRecovery` says the same keys;
  - pending 3 and 4 stay pending cuts: the page neither recovers nor rejoins on them, as for 1 and 2.
- **`call.move`:** the only "moved" signal. If a room end arrives while `call.move` is set (a page stalled for 10 s, so the instance enforced the move), the worker has already cleared the offer (phase `removed`), and the page reads the pending reason: 3 says `voice.mod.moveMissed`. That is the honest outcome, because the device was not moved.

### C.7 The moderator's mute and deafen in the client

#### C.7.1 `VoiceBook` (`calls/voice.ts`)

op 50 never carries a moderator's state, so the book keeps it beside the rows and folds it into every row it builds (M2).

`VoiceDeps` gains:

```ts
  /** The community of a channel this worker knows (hex), or null for a DM, a group DM or an unknown channel. */
  communityOf(channelHex: string): string | null;
```

wired in `CallController`'s `new VoiceBook({...})` (controller.ts:118) as `communityOf: (channel) => deps.callTarget(channel)?.communityId ?? null`.

```ts
const withMod = (flags: number, mod: number): number => (flags & 31) | ((mod & 3) << 5);

  /** voice moderation: each moderated user's mod (bit 0 server mute, bit 1 server deafen), keyed `${community}:${user}`,
   *  from op 56 and the snapshots' fourth element. Absent is 0. */
  private readonly mods = new Map<string, number>();

  private modOf(channel: string, user: string): number {
    const community = this.deps.communityOf(channel);
    return community === null ? 0 : this.mods.get(`${community}:${user}`) ?? 0;
  }

  /** Op 56: the user's rows in every call of that community take the new bits now, and later op 50 frames keep them. It is
   *  also kept for every read in flight, which applies it again after its snapshot. */
  moderation(f: VoiceModerationFrame): void {
    for (const read of this.reads) {
      if (read.moderations.length >= VOICE_MAX) read.overflow = true;
      else read.moderations.push(f);
    }
    if (this.applyModeration(f)) this.deps.publish(this.state);
  }

  private applyModeration(f: VoiceModerationFrame): boolean {
    const community = toHex(f.communityId);
    const user = toHex(f.userId);
    const key = `${community}:${user}`;
    if (f.mod === 0) this.mods.delete(key); else this.mods.set(key, f.mod);
    let changed = false;
    const next = { ...this.state };
    for (const [channel, call] of Object.entries(this.state)) {
      if (this.deps.communityOf(channel) !== community || !call.participants.some((p) => p.userId === user)) continue;
      next[channel] = { ...call, participants: call.participants.map((p) => (p.userId !== user ? p
        : this.deps.participant(p.userId, p.deviceId, withMod(p.flags, f.mod), channel))) };
      changed = true;
    }
    if (changed) this.state = next;
    return changed;
  }
```

- `Read` gains `moderations: VoiceModerationFrame[]` (initialised `[]` where reads are created, :43 and :58). `replay(read)` (:133) replays the read's op 50 frames and then its moderations with `applyModeration`, and publishes once if either changed anything.
- The book's reset (:128, which clears `reads` and `state`) clears `mods` too.
- `place()` records the snapshot's moderation: for each placed participant of a channel with a community, `mod = (p.flags >> 5) & 3`; set `mods` for that key, or delete it when `mod` is 0.
- `apply(f)` (op 50) builds the row with `this.deps.participant(user, device, withMod(f.flags, this.modOf(channel, user)), channel)`. `f.flags === 0` still removes the device.
- The worker's `ownVoiceState` reads `(flags >> 1) & 3` and `flags & 1` of op 50 frames, so the folded bits never disturb it.

#### C.7.2 The own call's state (`CallController`)

```ts
  /** Op 56 about this user in the live call's server: a moderator's mute (bit 0) and deafen (bit 1). */
  private ownModeration(f: VoiceModerationFrame): void {
    const live = this.live;
    const me = this.deps.me();
    if (live === null || live.leaving || live.dm || me === null) return;
    if (toHex(f.userId) !== toHex(me.userId)) return;
    if (this.deps.callTarget(live.channel)?.communityId !== toHex(f.communityId)) return;
    if (f.mod === live.mod) return;
    live.mod = f.mod;
    if (this.state.phase === 'in' || this.state.phase === 'paused') {
      this.setState({ ...this.state, serverMuted: (f.mod & 1) !== 0, serverDeafened: (f.mod & 2) !== 0 });
    }
  }
```

The instance announces op 56 to the target as well as to the audience, and again after the target's own join, so the state stays right across a join, a rejoin and a rekey.

### C.8 The page contract (ui and web; built by U4 and W6)

- **The view.** `VoiceParticipantView` (ui, `CallTile.tsx:19`) gains `serverMuted?`, `serverDeafened?` and `mutedForMe?`; `VoiceStateLabels` gains the three labels; `voiceStateWords` order and glyphs are §U.7.3. `web/src/screens/shell-model.ts` `participantView` sets `serverMuted: (p.flags & VOICE_FLAG.serverMute) !== 0, serverDeafened: (p.flags & VOICE_FLAG.serverDeaf) !== 0, mutedForMe: isLocallyMuted(settings, p.userId)`; its local `FLAG_*` constants are replaced by `VOICE_FLAG`.
- **Before connecting.** `PageCallOptions` gains `serverVoice?: { muted: boolean; deafened: boolean }`, filled from `CallJoinResult` (`muted = serverMuted || serverDeafened`, `deafened = serverDeafened`). The session does not publish the microphone at start while `muted`, and starts its speaker policy deafened while `deafened`.
- **During a call.** The session gains `applyServerVoice(mod: { muted: boolean; deafened: boolean }): void`. `useCall` calls it whenever `call.serverMuted` or `call.serverDeafened` changes, with `muted = serverMuted || serverDeafened` (deafen implies mute). Muted unpublishes the microphone track and the screen-share audio track (the instance withdraws all audio publishing, D4) and does not touch the person's own mute (`voice.self`), so their own choice is intact when the moderator lets go. Deafened calls `SpeakerPolicy.setServerDeafened(true)` (§C.11). Neither touches the self-deafen gain path.
- **The controls.** While `serverMuted || serverDeafened`, the mute control is held; while `serverDeafened`, the deafen control is held. Held is §U.7.5: `aria-disabled`, pressed, the reason as the description, and a press announces `voice.mod.youMuted` or `voice.mod.youDeafened` and changes nothing.
- **LiveKit refusing a publish.** A microphone publish refused for permissions while `serverMuted` is expected, not a call error: the session catches it and leaves the mic unpublished. If it is refused while `serverMuted` is false (the grant changed before op 56 arrived), the session waits for LiveKit's `participantPermissionsChanged` event (already subscribed, `session.ts:276`) and retries once permission returns.
- **The moderator lets go.** Both flags go false. The session publishes the mic again only if the person's own mute is off, and `setServerDeafened(false)` resubscribes.

### C.9 Permissions and the advisory checks

#### C.9.1 `admin/perm.ts`

Task T2, recipe §S.2 (TS). The resolver body (`apply`, `finish`, `channelBitsFrom`) is unchanged: everything masks with `PERM_ALL`, which T2 raises to `0x1ffffff`. The vector test's `camel()` maps `deafen_members` to `deafenMembers` by itself.

#### C.9.2 The page's advisory checks: new `admin/voicemod.ts` (task T4)

```ts
// Voice moderation (W7): what the person menu and the drag may offer for one person in voice. Advisory only: the instance
// decides every request again. No rank check, and the owner is never a target for anyone else; on the owner's own row
// only their own switch and leave survive (Jonas, 2026-10-22: "Like Discord"; ruling 5). No UI filters this again.
import type { VoiceState } from '../state/types';
import { PERM, channelBitsOf, type PermMember, type PermOverwrite, type PermRole } from './perm';

export interface VoiceModSnapshot {
  owner: string;
  /** '' unless permissions:<cid> is loaded with overwritesLoaded; then every answer is NO_VOICE_MOD. */
  everyoneId: string;
  roles: readonly PermRole[];
  members: readonly PermMember[];
  /** channel id → its overwrites (the overwrites:<cid> slice). */
  overwrites: Readonly<Record<string, readonly PermOverwrite[]>>;
  /** The server's voice channels in display order (channels:<cid>, kind 1). */
  voiceChannels: readonly string[];
  /** afk:<cid>.channelId. */
  afkChannelId: string | null;
}

export interface VoiceModAccess {
  /** The target is this account and this device is in the source call: move to and drag switch this device (callJoin),
   *  and disconnect is this device's callLeave. Nothing goes to the moderation routes. */
  local: boolean;
  serverMute: boolean; serverDeafen: boolean;
  /** The move to item is shown when this is true and moveTargets is not empty. Move Members on the source, or `local` on the
   *  owner's own row. */
  move: boolean;
  disconnect: boolean;
  /** The move to item's channels, in voiceChannels order: both may view and connect, never the source, never AFK. */
  moveTargets: string[];
  /** Valid drop targets for a drag of this person. For `local`, every channel this account may view and connect to
   *  (D9: the normal connect right only); otherwise moveTargets. */
  dragTargets: string[];
}

export const NO_VOICE_MOD: VoiceModAccess = Object.freeze({ local: false, serverMute: false, serverDeafen: false, move: false,
  disconnect: false, moveTargets: [], dragTargets: [] }) as VoiceModAccess;

const JOIN = PERM.viewChannel | PERM.connect;
const has = (bits: number | null, bit: number): boolean => bits !== null && (bits & bit) === bit;
function bitsIn(s: VoiceModSnapshot, channel: string, user: string): number | null {
  return channelBitsOf({ owner: s.owner, everyoneId: s.everyoneId, roles: s.roles, members: s.members,
    overwrites: s.overwrites[channel] ?? [] }, user);
}

/** What `me` may do to `target`, who is in voice in `source` (null: not in voice in this server). `ownCall` is the
 *  channel this device's call is in (call.channelId while phase is in or paused), else null. */
export function voiceModAccess(s: VoiceModSnapshot, me: string, target: string, source: string | null, ownCall: string | null): VoiceModAccess {
  if (source === null || s.everyoneId === '') return NO_VOICE_MOD;
  const local = target === me && ownCall === source;
  // J5: the owner is never a target for anyone else, and on their own row only this device's switch and leave remain.
  if (target === s.owner && !(me === s.owner && local)) return NO_VOICE_MOD;
  const mine = bitsIn(s, source, me);
  if (mine === null) return NO_VOICE_MOD;
  const joinable = s.voiceChannels.filter((c) => c !== source && c !== s.afkChannelId
    && has(bitsIn(s, c, me), JOIN) && has(bitsIn(s, c, target), JOIN));
  if (target === s.owner) {
    return { local: true, serverMute: false, serverDeafen: false, move: true, disconnect: true,
      moveTargets: joinable, dragTargets: joinable };
  }
  const move = has(mine, PERM.moveMembers);
  const moveTargets = move ? joinable : [];
  return { local, serverMute: has(mine, PERM.muteMembers), serverDeafen: has(mine, PERM.deafenMembers), move,
    disconnect: move, moveTargets, dragTargets: local ? joinable : moveTargets };
}

/** The first channel (in `channels` order) whose call lists a device of `userId`; null when none does. */
export function voiceChannelOf(voice: VoiceState, channels: readonly string[], userId: string): string | null {
  for (const c of channels) if (voice[c]?.participants.some((p) => p.userId === userId) === true) return c;
  return null;
}
```

Export from `index.ts`:
`export { voiceModAccess, voiceChannelOf, NO_VOICE_MOD } from './admin/voicemod'; export type { VoiceModAccess, VoiceModSnapshot } from './admin/voicemod';`.

How the page uses them (contract; §U.5.1.4):

- `source = voiceChannelOf(voice, voiceChannels, target)`.
- When `local`, move to and drag call the existing switch, and disconnect calls the existing leave.
- Otherwise the page calls the `voiceMove`, `voiceDisconnect`, `serverMute` and `serverDeafen` commands with the server's `communityId`.
- The checkable state of server mute and server deafen comes from the target's rows in `voice[source]`: `VOICE_FLAG.serverMute` or `VOICE_FLAG.serverDeaf` on any of their devices.

### C.10 Mute for me (`state/settings.ts`, task T3; web half in W6)

- `SETTINGS.voiceLocalMute: (hex: string) => \`voice.localMute.${hex}\``, `'1'` when muted for this device and absent otherwise. It is local and never sent.
- `const VOICE_LOCAL_MUTE = 'voice.localMute.';`. `isSettingKey` adds `if (key.startsWith(VOICE_LOCAL_MUTE)) return HEX32.test(key.slice(VOICE_LOCAL_MUTE.length));`. `isSettingValue` already falls through to `value === '1'`.
- `export function isLocallyMuted(settings: Record<string, string>, userHex: string): boolean { return settings[SETTINGS.voiceLocalMute(userHex)] === '1'; }`, exported from `index.ts`.
- The page sets it with the existing `setSetting` command (value `'1'`, or `null` to clear). No new worker command.
- **Web (W6).** `web/src/call/volume.ts` gets `localMutesFromSettings(settings): ReadonlySet<string>`, and `gainOf(userId, volumes, s, localMuted = false)` returns 0 when `localMuted`. The session's `gainFor(identity, 'voice')` passes `localMutes.has(userId)`; the stream (screen-share sound) gain passes false and keeps its own volume and mute (#37 T5). The volume slider keeps its value, so unmuting restores it. `PageCallOptions` gains `localMutes: ReadonlySet<string>`, and the session gains `setLocalMute(userId: string, on: boolean): void`, as `setVolume` does today.

### C.11 Media: the speaker policy while server-deafened (`packages/media/src/audio/speakers.ts`, task M1)

```ts
  /** Voice moderation (ruling 6): while a moderator deafens this person, no remote audio is subscribed (microphones and
   *  screen-share sound alike) and apply() never resubscribes; the instance unsubscribes it too and re-applies every 30 s.
   *  Off resubscribes what this switch turned off and runs the top-`max` policy again. Idempotent. */
  setServerDeafened(on: boolean): void;
```

- New fields: `private serverDeaf = false;` and `private readonly deafExcluded = new WeakSet<RemoteTrackPublication>();`.
- `private audioPubs(p: RemoteParticipant): RemoteTrackPublication[]` = `[...p.audioTrackPublications.values()]` (microphone and screen-share audio).
- `setServerDeafened(true)`: set the flag; for every remote and every audio publication with `isDesired`, call `setSubscribed(false)` and add it to `deafExcluded`.
- `setServerDeafened(false)`: clear the flag; for every remote audio publication in `deafExcluded`, `setSubscribed(true)` and delete it; then `apply()`.
- `apply()`: when `serverDeaf`, run the deafen pass above (which also catches a newly published track and a newly connected participant, because `onPublished` and `onConnected` call `apply()`) and return before the top-`max` logic, so nothing is resubscribed.
- `update()` keeps tracking speakers while deafened (its selection state stays current) and ends in `apply()`, which returns early.
- `dispose()` also resubscribes what `deafExcluded` holds, as it does for `excluded`.

### C.12 Tests

All vitest. `w` is the existing harness of each file. Each line is the assertion the test makes.

#### C.12.1 `gateway/frames.test.ts` (T1)

- **decodes op 56 voice_moderation into its community, user and mod**: `voiceModerationOf(decodeFrame(encodeFrame(56, 0, null, [C, U, 3])))` equals `{ communityId: C, userId: U, mod: 3 }`.
- **refuses op 56 with mod 4, 2 or 4 elements, a 15-byte id, n 1, or a group id, as E_FRAME_SHAPE**.
- **decodes op 57 voice_move into its community, call and target ids**: `{ communityId: C, callId: A, channelId: B }`.
- **refuses op 57 with 2 or 4 elements, a 15-byte id, n 1, or a group id, as E_FRAME_SHAPE**.
- **voice_state still refuses flags 32**: op 50 stays 0..31.
- **DROPPABLE_OPS holds ops 56 and 57**.

#### C.12.2 `gateway/gateway.test.ts` (T1)

- The three `['', 2, 1, 1, 0]` expectations (:210, :251, :602) become `['', 2, 1, 1, CAPS]`.
- **identifies with CAPS, which sets CAP_VOICE_MOVE (bit 1)**: `sent.payload[4] === 2n`.
- **identifies with the frames.json identify vector, the caps aside**: the vector keeps caps 0 (M5); assert `sent.payload[4] === BigInt(CAPS)`, and that `['tok', ...sent.payload.slice(1, 4), want[4]]` encodes to the vector's payload, as the calls-survive-upgrade branch does.
- **a malformed voice_moderation or voice_move of a ready session is dropped and the socket stays open**: no teardown, status stays ready.
- **ops 56 and 57 of a ready session reach the listener as frames**.

#### C.12.3 `http/routes.test.ts` (in "Routes: web-3 calls", T1)

- **setServerVoice patches …/members/{user}/voice and reads [mute, deaf]**: method PATCH, URL `/v1/communities/<c>/members/<u>/voice`, body `[1, null]` for `(c, u, true, null)` and `[null, 0]` for `(c, u, null, false)`, bucket write, idempotent true; an answer `[1, 0]` gives `{ mute: true, deaf: false }`.
- **setServerVoice refuses mute and deaf both null as E_ROUTE_INPUT before any request**.
- **setServerVoice refuses an answer element of 2 as E_CBOR_RANGE**.
- **disconnectVoiceMember deletes …/members/{user}/voice**: method DELETE, bucket write, idempotent true, 204 resolves.
- **moveVoiceMember posts [channel] to …/voice/move and reads [moved, disconnected]**: method POST, URL `/v1/communities/<c>/members/<u>/voice/move`, body `[CHANNEL]`, bucket write, idempotent false; the result is `{ moved: 2, disconnected: 1 }`.
- **moveVoiceMember refuses a one-element answer as E_CBOR_SHAPE**.
- **a 409 E_NOT_IN_VOICE is sent once and propagates**: one request; the error has status 409 and code `E_NOT_IN_VOICE`.
- **the three voice routes refuse a 15-byte id as E_ROUTE_INPUT before any request**.
- **a participant's fourth element sets voice flags bits 5 and 6**: rows with `mod` 1, 2, 3 and 7 give `flags | 32`, `| 64`, `| 96` and `| 96`; a three-element row keeps its flags; element 2 of 32 is still `E_CBOR_RANGE`.
- **startCall reads the eighth element mod**: an 8-element answer with `mod` 3 gives `mod: 3`; 6 and 7 elements give 0; an 8-element community answer with `rung` `[]` gives `rung: []`.
- In "the built-in AFK channel routes": **pending reason 3 reads as 3, 4 as 4, and 5 as 2**.

#### C.12.4 Permission tests (T2)

§S.2 Tests.

#### C.12.5 `admin/voicemod.test.ts` (new, T4; pure)

A fixture: owner O, me M, target T, roles `@everyone` (view, connect, speak) and `mods` (position 1), voice channels V1, V2, V3 and AFK.

1. **the owner's row offers nothing to others**: `voiceModAccess(s, M, O, V1, null)` equals `NO_VOICE_MOD`, even when M holds administrator.
2. **the owner's own row on the device in that call offers only the switch and the leave**: me O, target O, source V1, ownCall V1 → `local` true, `move` true, `disconnect` true, `serverMute` false, `serverDeafen` false, `moveTargets` and `dragTargets` `[V2, V3]`.
3. **the owner's own row for another of their devices offers nothing**: me O, target O, source V1, ownCall null → `NO_VOICE_MOD`.
4. **nobody in voice, nothing offered**: `source` null → `NO_VOICE_MOD`.
5. **access not loaded, nothing offered**: `everyoneId ''` → `NO_VOICE_MOD`.
6. **server mute needs Mute Members on the source channel**: mods with `muteMembers` → `serverMute` true. An overwrite on V1 that denies it to mods → false with source V1, still true with source V2.
7. **server deafen needs bit 24 alone**: `muteMembers` without `deafenMembers` → `serverDeafen` false; `deafenMembers` alone → true.
8. **move and disconnect need Move Members on the source**: true with it, and `moveTargets` is empty without it.
9. **move to lists channels both may view and connect to, in order, never the source or AFK**: T is denied connect on V3 → `moveTargets` `[V2]`. M is denied view on V2 → `[]`.
10. **a target whose member row is unknown is moved nowhere**: T missing from `members` → `moveTargets` `[]`, while `serverMute` still follows M's bits.
11. **no rank check**: T holds a role above M's → `move` is still true (J5).
12. **an administrator holds everything except over the owner**.
13. **dragging yourself needs only connect**: target M, ownCall V1, no `moveMembers` → `local` true, `move` false, `moveTargets` `[]`, `dragTargets` `[V2, V3]`.
14. **your other device is moved like anyone**: target M, ownCall null → `local` false, and `dragTargets` equals `moveTargets`.
15. **voiceChannelOf finds the first channel listing the user, in channel order**: the user is in V2 and V3 → V2; in none → null.
16. **an AFK channel id of null excludes nothing extra**: `afkChannelId` null with V1..V3 → `moveTargets` `[V2, V3]`.

#### C.12.6 `state/settings.test.ts` (T3)

- **voice.localMute.<id> takes '1' only**: `isSettingValue('voice.localMute.'+hex, '1')` is true; `'0'` and `''` are false; `isSettingKey('voice.localMute.XYZ')` is false.
- **isLocallyMuted reads the key**: true with `'1'`, false when absent.

#### C.12.7 `admin/controller.test.ts` (T5)

These run over the whole worker with `world.ts`. Add `moveVoiceMember`, `disconnectVoiceMember` and `setServerVoice` `vi.fn`s to the `routes` object in `world.ts` (:364-380), resolving to `{ moved: 1, disconnected: 0 }`, `undefined` and `{ mute: true, deaf: false }`. Seed a second voice channel and an `afk:` slice where a test needs them.

- Input checks (`it.each`), each refused with `E_BAD_INPUT` before anything is sent: a non-hex `toChannelId`; a `voiceMove` of an unlisted community; `serverMute` with `on: 'yes'`; `serverDeafen` without `on`.
- **voiceMove sends the community, user and target and answers { moved, disconnected }**: the call args are `(COMMUNITY, user, VOICE2)`, and the ret is `{ moved: 1, disconnected: 0 }`.
- **voiceMove refuses a text channel, a channel of another server and the AFK channel with E_BAD_INPUT, sending nothing**.
- **voiceMove 403 reads the permissions again and surfaces E_FORBIDDEN**: `getPermissions` is called once more, and the ret code is `E_FORBIDDEN`.
- **voiceMove 409 E_NOT_IN_VOICE reads the server's calls again and surfaces it**: `getCommunityCalls` is called once more.
- **voiceMove 409 E_CALL_FULL surfaces and reads nothing again**.
- **voiceDisconnect deletes; a 409 E_NOT_IN_VOICE is success and reads the calls again**.
- **serverMute and serverDeafen call setServerVoice with one flag and null**: `(cid, user, true, null)`, `(cid, user, false, null)`, `(cid, user, null, true)`, `(cid, user, null, false)`.
- **the four voice moderation commands are refused outside ready**, following the existing ACCEPTS test pattern.

#### C.12.8 `calls/controller.test.ts` (T6)

Harness additions:

- `HarnessOptions.secondVoice?: boolean`: adds `export const VOICE2 = idOf(0xc5, 2)`, `ds.addVoiceChannel(COMMUNITY, VOICE2)`, and a second channel row `{ id: VOICE2, …, name: 'stage', position: 1 }` in `channelRows`; `VOICE3` likewise where a test needs it.
- `voice2: toHex(VOICE2)` on the world.
- `export function moveFrame(community: Id, call: Id, to: Id): Frame` returns `{ op: 57, n: 0n, groupId: null, payload: [community, call, to] }`.
- `export function moderationFrame(community: Id, user: Id, mod: number): Frame` returns `{ op: 56, n: 0n, groupId: null, payload: [community, user, BigInt(mod)] }`.
- ModelDs (`sync/testing/model.ts`): `readonly serverVoice = new Map<string, number>()`, keyed by user hex. `startCall` returns `mod: this.serverVoice.get(<user of d>) ?? 0`, and `snapshot()` rows carry it folded into `flags` (`flags | mod << 5`), as `participants()` does.

New `describe('a move from the instance (voice moderation)')`:

1. **a voice_move for the live call offers the move and sends nothing**: join VOICE with bob in the call, then push `moveFrame(COMMUNITY, VOICE, VOICE2)` → `call` has `phase: 'in'` and `move: { to: voice2, seq: 1 }`; no new route request.
2. **the page follows with its switch: the self-Remove first, then the target's join**: after the offer, `callLeave 'switch'`, then `callJoin voice2`; in the recorded routes, `POST proposal` comes before `GET channel call` for VOICE2, and `POST calls` comes last; `call` ends with `phase: 'in'`, `channelId: voice2`, `move: null`.
3. **alone in the source, the follow ends that call conditionally and posts no Remove**: with no peer, the routes after the offer are `GET channel call` (the alone check), `DELETE call`, and no `POST proposal` for the source group.
4. **a move for another call, another community, while joining, while leaving, of a DM call, or after a block is ignored**: each case leaves `call.move` null; while leaving: hold `POST proposal`, push the frame, release; while joining: hold `POST calls` and push.
5. **a move to the source, to the AFK channel, or to another server's channel is ignored**. For AFK, publish an `afk:` slice through the getAFK stub with `channelId` VOICE2.
6. **a target this device does not list is read once, then offered**: `listChannels` first omits VOICE2, then includes it; after the frame there is exactly one more `listChannels` call, and `move.to` is voice2.
7. **a target still unknown after the read, or a read slower than MOVE_RELOAD_MS, offers nothing**: hold `listChannels`, advance the clock 3000 ms → `move` stays null.
8. **a second move before the page follows replaces the target; the same target again changes nothing**: VOICE2 then VOICE3 gives `seq` 1 then 2, and `to` is voice3; VOICE3 again publishes no new `call` slice (count the `call` slices).
9. **the offer clears when the call ends otherwise**: after the offer, (a) `onMembershipLost` → phase `removed`, `move: null`; (b) a user `callLeave` → `move: null` once leaving; (c) `reset` (sign-out) → `CALL_IDLE`.
10. **a refused target join leaves the device in no call and never rejoins the source**: follow with `POST calls` refused 403 `E_FORBIDDEN` for VOICE2 → phase `failed`, `channelId: voice2`, error `E_FORBIDDEN`; after the leave, no request names VOICE.
11. **a malformed voice_move is dropped**: a payload of 2 elements pushed through the controller does nothing, and the worker keeps running.
12. **op 56 about me in the live call's server sets serverMuted and serverDeafened**: `moderationFrame(COMMUNITY, ME, 1)` gives `serverMuted: true`; `3` gives both true; `0` gives both false; the same frame twice publishes once.
13. **op 56 about me in another server leaves the own state alone**.
14. **op 56 about a peer folds into the voice slice and survives their op 50**: `moderationFrame(COMMUNITY, PEER, 1)` → bob's row has flags 33 and `serverMuted` stays false; then `voiceFrame(PEER, VOICE, 1 | 2)` → bob's row has flags 35.
15. **op 56 with mod 0 clears the fold**: after 14, `moderationFrame(COMMUNITY, PEER, 0)` → bob's flags 3.
16. **a snapshot row's mod is kept for later op 50 frames**: the model's `serverVoice` has 2 for bob; after the community read, bob's flags carry 64, and a later `voiceFrame(PEER, VOICE, 1)` gives 65.
17. **an op 56 that arrives while a snapshot read is in flight survives the snapshot**: hold `getCommunityCalls` (model mod 0 for bob), push `moderationFrame(COMMUNITY, PEER, 1)`, release → bob's flags carry 32.
18. **the join answer's mod sets the state before the ret**: with `ds.serverVoice` 1 for me, the `call` slice posted before the `callJoin` ret has `serverMuted: true`, and the ret has `serverMuted: true, serverDeafened: false`.
19. **the moderator state resets when the call ends**: after 12, a user leave → `serverMuted: false`.
20. **ops 56 and 57 reach the call controller through the worker's frame dispatch**: tests 1 and 12 go through `w.gateway.push`.
21. **a move offer survives a rekey**: offer, then a rekey (`setIn` mid-call) → `move` unchanged.

#### C.12.9 `testing/fake-server.ts` additions and `testing/fake-server.test.ts` (T7)

In `callRoute` (fake-server.ts:382), before `return null`:

- State:
  - `readonly unmovable = new Set<string>()` holds device hex whose client lacks the capability bit;
  - `readonly serverVoice = new Map<string, number>()` maps user hex to mod bits;
  - `readonly moves: { from: string; to: string; user: string }[] = []`.
- `PATCH /v1/communities/{cid}/members/{u}/voice`: body a two-element array whose elements are each `null`, 0 or 1 and not both null, else 400 `E_INVALID_REQUEST`; 409 `E_NOT_IN_VOICE` when no live call of the community lists `u`; a non-null mute sets or clears bit 0 and a non-null deaf bit 1 in `serverVoice`; answers `200 [mute, deaf]`.
- `DELETE /v1/communities/{cid}/members/{u}/voice`: drops every participant row of `u` in the community's live calls and answers 204; 409 `E_NOT_IN_VOICE` when there was none.
- `POST /v1/communities/{cid}/members/{u}/voice/move`: body a one-element array of a 16-byte bstr, else 400 `E_INVALID_REQUEST`; 409 `E_NOT_IN_VOICE` when no live call of the community lists `u`; the target must be a key of `calls`, else 400; a target that is the only call listing `u` is 400; each participant row of `u` outside the target is moved to the target if its device is not in `unmovable`, else dropped; append to `moves`, and answer `200 [moved, disconnected]`.
- The `GET …/call` and `GET …/calls` snapshot rows become `[user, device, flags, serverVoice.get(user) ?? 0]`.

Tests:

- **a move answers [moved, disconnected] and lists the user's devices under the target call**: two devices, one in `unmovable` → `{ moved: 1, disconnected: 1 }`, and the target's snapshot lists one row of the user.
- **a move of someone not in voice is 409 E_NOT_IN_VOICE**.
- **a disconnect removes every device of the user; a second one is 409 E_NOT_IN_VOICE**.
- **server mute shows as flags bit 5 through Routes.getChannelCall; deafen as bit 6; [0, null] clears the mute**.

#### C.12.10 `packages/media/test/audio-speakers.test.ts` (M1)

- **setServerDeafened(true) unsubscribes every remote microphone and screen-share audio, and leaves video alone**.
- **while server-deafened, a newly published audio track and a newly connected participant are unsubscribed, and ActiveSpeakersChanged resubscribes nothing**.
- **setServerDeafened(false) resubscribes what it turned off, then applies the top-6 cap again**: with 8 remotes, 6 end subscribed.
- **setServerDeafened(true) twice changes nothing the second time**.

---

## Appendix U: UI and web

The UI and web recipe. Every name, class, key, string and order below is a decision. The layer's corrections to the original design are folded into §5 and §6; its numbering is kept (U.2 to U.10, and U.12 for the sketches), so references stay stable. The task split is §11.

### U.2 ActionMenu growth

#### U.2.1 Files

| File | Change |
|---|---|
| `packages/ui/src/ActionMenu/ActionMenu.tsx` | Keeps its trigger and its props. Renders `MenuList` for the popup. `items` widens to `readonly MenuEntry[]`; adds `onValue`. |
| `packages/ui/src/ActionMenu/MenuList.tsx` (new, internal: not exported from `index.ts`) | The `role="menu"` list: entries, keyboard, typeahead, hover-to-focus, submenus, slider. Used by ActionMenu, by ContextMenu and by itself for a submenu. |
| `packages/ui/src/ActionMenu/place.ts` (new, internal) | `placeInBox(root: Element, at: {x,y}, w, h): {x,y}`, the clamp ActionMenu does today (`ActionMenu.tsx:55-65`), moved out unchanged so the context popup and submenus share it. Also `boxOf(root)`: the `.d-app-shell` rect, else the viewport. |
| `packages/ui/src/ActionMenu/MenuSlider.tsx` (new, internal) | The slider entry. |
| `packages/ui/src/ActionMenu/ActionMenu.css` | New classes (§U.2.6). |
| `packages/ui/src/ContextMenu/ContextMenu.tsx` + `.css` + `.test.tsx` + `.stories.tsx` (new, exported) | The trigger-less popup at a point. On a phone it renders `MenuSheet`. |
| `packages/ui/src/MenuSheet/MenuSheet.tsx` + `.css` + `.test.tsx` + `.stories.tsx` (new, exported) | The phone bottom sheet. |
| `packages/ui/src/index.ts` | Export `ContextMenu`, `MenuSheet` and the types `MenuEntry`, `ContextMenuProps`, `MenuSheetProps`. |

#### U.2.2 The entry type (exported from `ActionMenu.tsx`)

```ts
/** Unchanged: a plain item; `checked` set makes it a menuitemradio (single-choice menus). */
export interface ActionMenuItem { id: string; label: string; danger?: boolean; checked?: boolean }

export type MenuEntry =
  /** A plain action (role menuitem), or a radio when `checked` is set (role menuitemradio). */
  | (ActionMenuItem & { kind?: 'item'; disabled?: boolean })
  /** A toggle (role menuitemcheckbox, aria-checked). `keepOpen`: activating it leaves the menu open (the Roles list). */
  | { kind: 'check'; id: string; label: string; checked: boolean; disabled?: boolean; danger?: boolean; keepOpen?: boolean }
  /** Opens a nested menu (role menuitem, aria-haspopup="menu", aria-expanded). Child ids are unique across the whole menu. */
  | { kind: 'submenu'; id: string; label: string; entries: readonly MenuEntry[]; disabled?: boolean }
  /** A value range inside the menu. `valueLabel` has `{n}` (e.g. '{n} %'); the component fills it. */
  | { kind: 'slider'; id: string; label: string; value: number; min: number; max: number; step: number; valueLabel: string }
  /** A group boundary (role separator). Never focused. */
  | { kind: 'separator'; id: string };

/** Turns ordered groups into entries with a separator between non-empty groups. */
export function withSeparators(groups: readonly (readonly MenuEntry[])[]): MenuEntry[];
```

`ActionMenuProps` changes: `items: readonly MenuEntry[]` and `onValue?(id: string, value: number): void`. Every existing caller passes `ActionMenuItem[]`, which still type-checks.

Selection contract, the same for ActionMenu, ContextMenu and MenuSheet:
- `item`, or `check` without `keepOpen`: close the menu, return focus, then call `onSelect(id)`. This is today's order (`ActionMenu.tsx:120-124`).
- `check` with `keepOpen`: call `onSelect(id)` and keep the menu open with focus on the item. The caller re-renders `checked` when its slice changes.
- `submenu`: opens its child list. It never calls `onSelect`.
- `slider`: calls `onValue(id, v)` on every change. It never closes the menu by itself.
- `disabled` (any kind): `aria-disabled="true"`. It is still focusable and reached by arrows. Activation does nothing.

#### U.2.3 MenuList behaviour (desktop popup)

DOM: `<div role="menu" aria-label={label} class="d-action-menu__popup">`. Children in entry order:

| Entry | Element |
|---|---|
| item | `<button type="button" role="menuitem" tabIndex={-1} class="d-action-menu__item" data-danger? aria-disabled?><span class="d-action-menu__label">{label}</span></button>` (radio: `role="menuitemradio" aria-checked`, unchanged) |
| check | `<button role="menuitemcheckbox" aria-checked={checked} class="d-action-menu__item" data-kind="check">` label, then `<span class="d-action-menu__box" aria-hidden="true">{checked ? <Icon name="check" size={12}/> : null}</span>` |
| submenu | `<button role="menuitem" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? childId : undefined} class="d-action-menu__item" data-kind="submenu">` label, then `<span class="d-action-menu__chevron" aria-hidden="true"><Icon name="chevron-right" size={14}/></span>` |
| slider | `<div role="group" aria-label={label} class="d-action-menu__slider">`: a visible `<span class="d-action-menu__slider-label">{label}</span>`, then `<div role="slider" tabIndex={-1} aria-valuemin aria-valuemax aria-valuenow aria-valuetext={valueLabel filled} aria-orientation="horizontal" aria-label={label} class="d-action-menu__slider-track">` holding `__slider-fill`, a `__slider-mark` at 100 when 100 lies in range, `__slider-thumb`, and after the track `<span class="d-action-menu__slider-value" aria-hidden="true">{valueLabel filled}</span>` |
| separator | `<div role="separator" class="d-action-menu__sep" />` |

The focus list is `[role^="menuitem"], [role="slider"]` inside **this** list only (`:scope >` selectors, so a child list's items are not counted).

Keys on a list (the existing ones stay):

| Key | On | Does |
|---|---|---|
| ArrowDown / ArrowUp | any | next / previous, wrapping (today). |
| Home / End | any | first / last (today). On the slider too: Home and End stay the menu's keys. This is a deliberate deviation from the slider pattern, and the slider is documented as Left/Right. |
| Enter, Space | item, check | activate (§U.2.2). |
| Enter, Space, ArrowRight | submenu | open the child list and focus its first entry. |
| ArrowLeft | any entry of a **child** list | close this child list, focus its parent submenu item. |
| ArrowLeft / ArrowRight | slider | value −/+ `step`. |
| PageDown / PageUp | slider | value −/+ `5 × step`. |
| Escape | child list | like ArrowLeft. `stopPropagation`, so the root does not also close. |
| Escape | root list | close everything, return focus (today). |
| Tab / Shift+Tab | any | close everything (today's Tab behaviour). |
| a printable character | any | typeahead: focus the next entry, after the current one and wrapping, whose label starts with that character (case-insensitive, `localeCompare` with `sensitivity: 'base'`). A 500 ms buffer joins quick keys into one prefix. |

Pointer:
- `pointermove` over an entry focuses it (`focus({ preventScroll: true })`), so the pointer and the keyboard share one highlight. Entries style `:focus-visible` and `:focus`, and hover equals focus.
- A submenu item hovered for **150 ms** opens its child list, without moving focus into it. A click opens it immediately, and a click on an open one does nothing.
- When the pointer moves onto another entry of the parent list, the open child list closes after **300 ms**, unless the pointer enters the child list first (the timer is cleared on `pointerenter` of the child popup).
- One child list is open at a time per level.
- Slider pointer: `pointerdown` on the track does `setPointerCapture`, sets the value from x and moves on `pointermove`. Values are rounded to `step` and clamped to `[min,max]`. `pointerup` releases.

Child list placement: `position: fixed`. Origin is the parent item's `getBoundingClientRect()`, relative to `boxOf(root)`:
- `x = item.right − box.left + 2`;
- if `x + w > box.width`, then `x = item.left − box.left − w − 2` (flip left);
- `y = item.top − box.top − 4`, clamped to `[0, box.height − h]`.

Measure after mount in a layout effect, as ActionMenu does. The child popup is rendered inside the same root `<span>`/container, so the outside-pointerdown check (`rootRef.contains`) covers it. The child popup gets `data-submenu="true"` and `max-height: min(60dvh, 24rem); overflow-y: auto`.

Slider local state: keep `const [v, setV] = useState(entry.value)`, re-synced when `entry.value` changes and the slider is not being dragged. A slider writes the value through the worker, and the slice lags behind it.

#### U.2.4 ContextMenu (desktop popup at a point)

```ts
export interface ContextMenuProps {
  /** The menu's accessible name ('menu for ada'). */
  label: string;
  /** The sheet's visible heading on a phone ('ada'); defaults to `label`. */
  title?: string;
  entries: readonly MenuEntry[];
  /** Viewport coordinates: the pointer, or the focused element's corner for a key or a long-press. */
  at: { x: number; y: number };
  /** Default: 'sheet' inside a phone shell (`usePhoneLayout()` of ui), else 'popup'. */
  layout?: 'popup' | 'sheet';
  /** Where focus goes on close when nothing else took it (the opener). */
  returnFocus: HTMLElement | null;
  onClose(): void;
  onSelect(id: string): void;
  onValue?(id: string, value: number): void;
  /** Sheet chrome: `back` is `nav.back`, `close` is `dialog.close`. */
  labels: { back: string; close: string };
}
```

- It is mounted only while open: the host mounts and unmounts it.
- `layout === 'popup'` renders `<div class="d-context-menu">` containing `MenuList`, placed with `placeInBox(root, at, w, h)` exactly like ActionMenu's `at` case. Focus goes to the first entry on mount. The `startAt` logic doesn't apply.
- Outside `pointerdown` (capture), Escape at root, Tab, `window` `blur`, `resize`, and a `scroll` of any ancestor (capture listener on `document`) all close it: `onClose()` and then `returnFocus` via `focusReturnTarget(returnFocus)`.
- The popup class is `d-action-menu__popup d-context-menu__popup`, with `min-width: 13.75rem` (220 px; Discord's menus are 188–220 px).
- `z-index: 45`, above the ProfileCard (40) and the ring (30).

#### U.2.5 MenuSheet (phone)

A new component rather than an ActionMenu mode. The sheet is a modal dialog with 44 px rows and pushed pages, which is a different interaction model from a WAI-ARIA menu. Mixing the two in one component would make both worse.

```ts
export interface MenuSheetProps {
  title: string;                       // the sheet's h2 ('ada', '#general', 'message from ada')
  entries: readonly MenuEntry[];
  returnFocus: HTMLElement | null;
  onClose(): void;
  onSelect(id: string): void;
  onValue?(id: string, value: number): void;
  labels: { back: string; close: string };
}
```

DOM, modelled on ProfileCard's sheet (`ProfileCard.tsx:160-194`):

```
<div class="d-menu-sheet__scrim" onClick={close}>
  <div class="d-menu-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={stop}>
    <div class="d-menu-sheet__head">
      [page > 0] <button class="d-menu-sheet__back" aria-label={labels.back}><Icon chevron-left 18/></button>
      <h2 id={titleId} class="d-menu-sheet__title">{page === 0 ? title : submenu.label}</h2>
      <button class="d-menu-sheet__close" aria-label={labels.close}><Icon x 18/></button>
    </div>
    <div class="d-menu-sheet__list" role="group" aria-labelledby={titleId}>
      ...entries of the current page
    </div>
  </div>
</div>
```

Entries on a page:

| Entry | Element |
|---|---|
| item | `<button class="d-menu-sheet__item" data-danger? aria-disabled?>{label}</button>` |
| check | `<button class="d-menu-sheet__item" role="switch" aria-checked={checked}>` label + `<span class="d-menu-sheet__switch" aria-hidden="true">` (the Toggle look: track + knob) |
| submenu | `<button class="d-menu-sheet__item" data-kind="submenu" aria-haspopup="true">` label + chevron-right 16 |
| slider | `<label class="d-menu-sheet__range"><span>{label}</span><input type="range" min max step value aria-valuetext /><span aria-hidden="true">{value text}</span></label>` (native: touch-friendly; a sheet has no arrow-key navigation to clash with) |
| separator | `<div class="d-menu-sheet__sep" role="separator" />` |

Behaviour:
- **Pages.** A stack of submenu ids; page 0 is the root. Pressing a submenu pushes its entries and moves focus to the first entry of the new page. Back (button, or Escape on a page > 0) pops the page and focuses the submenu item that opened it.
- **Focus trap**: on mount, focus goes to the first entry. Tab and Shift+Tab cycle inside `.d-menu-sheet` (ProfileCard's `onKeyDown` code, `ProfileCard.tsx:148-157`, copied).
- **Close**: Escape on page 0, the close button, a scrim press, or any non-`keepOpen` selection. On unmount, focus goes to `focusReturnTarget(returnFocus)`.
- **Selection order**: close first, then `onSelect`, as in §U.2.2.
- **No drag-to-dismiss** gesture. The close button and the scrim are enough, and a swipe would fight the list's own scroll.
- **Sizing**: `max-height: 85dvh`, list `overflow-y: auto`, `padding-bottom: max(1rem, env(safe-area-inset-bottom))`, items `min-height: 2.75rem` (44 px), back and close 44 × 44.
- **Scroll lock**: while open, `html[data-phone-shell]` already locks page scroll. Add nothing.

#### U.2.6 CSS (existing tokens only)

`ActionMenu.css` additions:

```css
.d-action-menu__item { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.75rem; }
.d-action-menu__item:focus { background: var(--surface-2); outline: none; }
.d-action-menu__item:focus-visible { background: var(--surface-2); outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.d-action-menu__item[aria-disabled="true"] { color: var(--fg-3); cursor: default; }
.d-action-menu__item[data-danger="true"]:focus { background: var(--danger); color: var(--accent-ink); }
.d-action-menu__item[aria-expanded="true"] { background: var(--surface-2); }
.d-action-menu__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.d-action-menu__box { display: inline-flex; align-items: center; justify-content: center; width: 0.875rem; height: 0.875rem; border: 1px solid var(--edge); border-radius: var(--r-sm); }
.d-action-menu__item[aria-checked="true"] .d-action-menu__box { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.d-action-menu__chevron { display: inline-flex; color: var(--fg-3); }
.d-action-menu__sep { height: 1px; margin: 0.25rem 0.375rem; background: var(--hairline); }
.d-action-menu__slider { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.25rem 0.5rem; padding: 0.375rem 0.625rem; font-size: var(--text-sm); }
.d-action-menu__slider-label { grid-column: 1 / -1; color: var(--fg-2); font-size: var(--text-xs); text-transform: lowercase; }
.d-action-menu__slider-track { position: relative; height: 1.25rem; cursor: pointer; border-radius: var(--r-md); }
.d-action-menu__slider-track::before { content: ''; position: absolute; inset: 50% 0 auto; height: 2px; translate: 0 -50%; background: var(--edge); }
.d-action-menu__slider-fill { position: absolute; left: 0; top: 50%; height: 2px; translate: 0 -50%; background: var(--accent); }
.d-action-menu__slider-mark { position: absolute; top: 25%; width: 1px; height: 50%; background: var(--fg-3); }
.d-action-menu__slider-thumb { position: absolute; top: 50%; width: 0.625rem; height: 0.625rem; translate: -50% -50%; background: var(--fg); border-radius: var(--r-sm); }
.d-action-menu__slider-track:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.d-action-menu__slider-value { font-variant-numeric: tabular-nums; color: var(--fg-2); min-width: 3.5ch; text-align: end; }
.d-action-menu__popup[data-submenu="true"] { position: fixed; max-height: min(60dvh, 24rem); overflow-y: auto; z-index: 46; }
@media (forced-colors: active) { .d-action-menu__item:focus { outline: 2px solid Highlight; } .d-action-menu__box { border-color: CanvasText; } }
```

`ContextMenu.css`: `.d-context-menu__popup { position: fixed; z-index: 45; min-width: 13.75rem; max-width: 20rem; }`.

`MenuSheet.css` copies the ProfileCard sheet values (`ProfileCard.css:21-25`): scrim `rgba(0,0,0,0.6)`, z-index 45; sheet `background: var(--surface); border-top: 1px solid var(--accent); border-radius: var(--r-lg) var(--r-lg) 0 0; font-family: var(--font-mono)`. Items: `min-height: 2.75rem; padding: 0 var(--row-pad-x); font-size: var(--text-base); text-align: start`. Danger items get `color: var(--danger)`. Separators use `var(--hairline)`. The switch is drawn like the `Toggle` component's track and knob: copy its CSS values, not its component.

#### U.2.7 Long-press timing, used by the host (§U.3)

**500 ms**, with a **10 px** move tolerance. Defined in `packages/web/src/screens/menus/long-press.ts` as `LONG_PRESS_MS = 500`, `LONG_PRESS_SLOP_PX = 10`.

---

### U.3 The app-wide context-menu layer

#### U.3.1 Files

| File | Contents |
|---|---|
| `packages/web/src/screens/menus/MenuHost.tsx` (new) | `MenuHostProvider`, `useContextMenu`, `useOpenMenu`, the document listeners, the one mounted `ContextMenu`. |
| `packages/web/src/screens/menus/native.ts` (new) | `keepsNativeMenu(event, target): boolean`, pure, with the rules of §U.3.3. |
| `packages/web/src/screens/menus/long-press.ts` (new) | Constants and `createLongPress(...)`, a small state machine with no React in it. |
| `packages/web/src/screens/menus/clipboard.ts` (new) | `copyText(text): Promise<boolean>` and `copyImage(blob): Promise<boolean>`. |
| `packages/web/src/screens/menus/*-menu.ts` (new) | The pure models (§U.5). |
| `packages/web/src/screens/menus/use*Menu.tsx` (new) | One hook per surface: it reads slices and registers the handler. |

#### U.3.2 API

```ts
export type MenuSurface = 'person' | 'message' | 'link' | 'attachment' | 'channel' | 'voice-channel' | 'category' | 'server' | 'dm';

export interface BuiltMenu { label: string; title: string; entries: MenuEntry[] }
export interface SurfaceHandler {
  /** The menu for this element, or null to let the browser's menu show. Called at open, and again on each render while open (live checks). */
  build(el: HTMLElement): BuiltMenu | null;
  /** An item was chosen. `el` is the element the menu was opened on. */
  run(el: HTMLElement, id: string): void;
  value?(el: HTMLElement, id: string, value: number): void;
}

/** Registers `handler` for `surface` inside `root`. The innermost registered root containing the element wins. */
export function useContextMenu(surface: MenuSurface, root: RefObject<HTMLElement | null>, handler: SurfaceHandler): void;

/** Opens the menu of `el` (a "⋯" button, tests). `at` defaults to the element's corner. */
export function useOpenMenu(): (el: HTMLElement, at?: { x: number; y: number }) => void;

export function MenuHostProvider(props: { children: ReactNode; phone: boolean }): React.JSX.Element;
```

**Registration.** The provider keeps a `useRef<Set<{ surface; root; handler: MutableRefObject<SurfaceHandler> }>>`. `useContextMenu` adds an entry in a layout effect and removes it on cleanup. The handler goes in a ref that is updated on every render, so the registration never re-runs.

**Resolution**, for an event target `t`:
1. `el = t.closest('[data-menu]')`. If `el` is null, the browser's menu shows.
2. `surface = el.dataset.menu`. The candidates are registrations with that surface whose `root.current?.contains(el)`. Pick the candidate whose root is contained by every other candidate's root (the deepest). If there is none, the browser's menu shows.
3. `built = handler.build(el)`. If it is null or `built.entries` is empty, the browser's menu shows.

**One menu at a time.** The provider holds `open: { el, at, reg, returnFocus } | null`. Opening another replaces it: the old one unmounts first. A ProfileCard or Dialog opened by an item closes the menu first, because selection closes it (§U.2.2).

**Mount.** `MenuHostProvider` wraps the Shell's returned tree, the whole `<AppShell …>` element. The `ContextMenu` is rendered through `createPortal(menu, document.querySelector('.d-app-shell') ?? document.body)`, so `placeInBox` clamps to the shell as ActionMenu does. `layout` = `phone ? 'sheet' : 'popup'`, where `phone` comes from web's `usePhoneLayout()` and is passed into the provider.

#### U.3.3 When the browser's menu stays (D14, ruling 9, my call)

`keepsNativeMenu(e: MouseEvent | KeyboardEvent, target: Element): boolean` returns true, and the host does nothing (no `preventDefault`), when **any** of these hold:
1. `e.shiftKey` on a `contextmenu` event (Shift+right-click is the escape hatch). Shift+F10 itself is our key, so this rule applies to mouse events only: `e.type === 'contextmenu' && e.shiftKey && !fromKey`, where `fromKey` is true when a key opened a menu within the last 500 ms (§U.3.5).
2. `target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-native-menu]')`: text inputs and the composer keep spellcheck, paste and input methods. `MessageEditor` and `Composer` are textareas. The emoji grid's search and the GIF search are inputs.
3. **A non-empty text selection under the pointer.** `const s = getSelection(); s !== null && !s.isCollapsed && s.toString().trim() !== '' && s.containsNode(target, true)`.
   - **Decision (D14): keep the browser's menu over a selection; don't offer Copy in dilla's menu.**
   - Why: the browser's menu has Copy plus what dilla can't offer: look up, translate, search, speech and assistive-tech extensions. A dilla "copy" would be a weaker copy of it.
   - The rule is simple and testable: *what you selected is the browser's.* It holds everywhere, including inside a link or a mention that is part of the selection.
   - The message menu keeps its own "copy text" item, which copies the whole message without selecting.
4. No `[data-menu]` ancestor, or the resolution of §U.3.2 finds no menu: empty areas fall through.

On a phone the same rules apply. Rule 3 rarely triggers there, because `[data-menu]` rows are `user-select: none` (§U.3.6).

#### U.3.4 The document listeners (installed once by the provider)

All are installed in one `useEffect` with `[]` deps, reading refs.

- **`contextmenu`** (bubble, on `document`):
  - if `e.defaultPrevented`, return;
  - if `keepsNativeMenu`, return;
  - if the menu came from touch (`e.pointerType === 'touch'` when the event is a `PointerEvent`, or the last `pointerdown` was touch within 1000 ms): `e.preventDefault()` and return. Our long-press timer owns touch, and this suppresses Android's own long-press menu;
  - if `Date.now() − keyOpenedAt < 500`: `e.preventDefault()` and return. The menu-key event was already handled;
  - otherwise resolve. If there is a menu: `e.preventDefault()` and open it at `{ x: e.clientX, y: e.clientY }` with `returnFocus = document.activeElement`.
- **`keydown`** (bubble, on `document`):
  - if `e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)`, and `document.activeElement` is an element, and **not** `keepsNativeMenu` rule 2: resolve from `document.activeElement`;
  - if there is a menu: `e.preventDefault()`, `keyOpenedAt = Date.now()`, and open at the element's corner: `r = el.getBoundingClientRect(); at = { x: r.left + 16, y: r.top + Math.min(r.height, 32) }`, with `returnFocus = el`.
- **`pointerdown`** (capture), for touch only (`e.pointerType === 'touch'`): start `createLongPress` on the resolved element if one resolves and rule 2 doesn't hold.
- **`pointermove`, `pointerup`, `pointercancel`, `scroll`** (capture): feed the long-press machine.

#### U.3.5 The long-press machine (`long-press.ts`)

```ts
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;
export const CLICK_SUPPRESS_MS = 700;
export function createLongPress(opts: { onFire(el: HTMLElement, at: { x: number; y: number }): void; now?: () => number;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout }): {
  down(el: HTMLElement, x: number, y: number, pointerId: number): void;
  move(x: number, y: number, pointerId: number): void;   // cancels past the slop
  up(pointerId: number): void;                           // cancels if not fired
  cancel(): void;                                        // scroll, pointercancel
  /** True while a click right after a fired long-press must be swallowed. */
  swallowsClick(): boolean;
};
```

On fire:
- open the menu at the press point, with `returnFocus = el`;
- for the next `CLICK_SUPPRESS_MS`, a capture-phase `click` listener on `document` calls `preventDefault()` and `stopPropagation()` once, so the row's own tap action (profile card, open channel, reveal toolbar) doesn't also run.

There is no vibration: iOS doesn't support it, and Jonas wants silent.

#### U.3.6 CSS that makes long-press usable (`packages/ui/src/styles/base.css`)

```css
[data-menu] { -webkit-touch-callout: none; }
[data-layout="phone"] [data-menu] { -webkit-user-select: none; user-select: none; }
```

On a phone a message's text can't be selected. Its sheet has "copy text", as Discord mobile does. Desktop selection is unchanged.

#### U.3.7 Focus after a menu

- Esc, Tab or an outside press: `returnFocus` (§U.3.4).
- An item that opens a dialog or card: the item's `run` passes `el` as the dialog's opener. Existing dialogs use their opener or `focusReturnTarget`.
- An item that navigates (message, open link): focus goes where the navigation sends it. Nothing extra is done.

---

### U.4 Surfaces

#### U.4.1 The `data-menu` contract

A ui component marks an element by rendering these attributes unconditionally. They are inert without a host:

| `data-menu` | Other attributes | Element |
|---|---|---|
| `person` | `data-user-id` | the focusable control for that person |
| `message` | `data-msg-id` (exists), `data-seq` (exists) | the `.d-message-row` element (focusable in the log's roving) |
| `link` | the `href` itself | `<a class="d-link">` |
| `attachment` | `data-index` | the AttachmentCard root; the lightbox image adds `data-seq` |
| `channel` | `data-channel-id` | the ChannelRow button (text and announcement) |
| `voice-channel` | `data-channel-id` | the `.d-voice-row` button |
| `category` | `data-category-id` | `.d-channel-list__cat-head` |
| `server` | `data-community-id` | the CommunityRail server button |
| `dm` | `data-channel-id` | the ChannelRow button of a DM row |

#### U.4.2 File by file

| Surface | File : component | Change |
|---|---|---|
| Voice people | `packages/ui/src/VoiceChannelRow/VoiceChannelRow.tsx` : `VoiceChannelRow` | The person `<li>` loses `data-row` and keeps its class. Its content moves into `<button type="button" class="d-voice-row__person-open" data-row data-menu="person" data-user-id={p.userId} data-channel-id={channelId} aria-haspopup="menu" onClick={() => onPerson?.(p.userId, el)}>` (avatar, name, states, slot). New props: `channelId: string`, `onPerson?(userId: string, anchor: HTMLElement): void` (a click opens the profile card, as Discord does) and `drag?` (§U.6). CSS: the button is `display: grid; grid-template-columns: subgrid; grid-column: 1 / -1; align-items: center; height: 100%; padding: 0; background: transparent; border: 0; font: inherit; color: inherit; text-align: start; cursor: pointer; border-radius: var(--r-md)`; hover and focus `background: var(--surface-2)`; `:focus-visible { outline-offset: -2px }`. The `.d-voice-row` button gets `data-menu="voice-channel" data-channel-id={channelId}`. Away people (`p.away`) keep a button for the menu and profile, never drag. |
| Roving over people | `packages/ui/src/internal/roving.ts` : `useRovingFocus(activeIndex, selector?)` | New optional `selector: string`. When given, `items()` is `Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(selector) ?? [])`; without it, today's code is unchanged (CommunityRail). |
| Channel list | `packages/ui/src/ChannelList/ChannelList.tsx` : `ChannelList` | `useRovingFocus(index, ROWS)` with `const ROWS = ':scope > li > button[data-row], :scope > li > .d-voice-row__people > li > button[data-row]'`. The `activeIndex` lookup becomes the index among those buttons. Compute it in a layout effect from the active row's `data-channel-id`, or keep `entries.findIndex` and map it: implement as `rows.findIndex(b => b.dataset.channelId === activeId)` after render. `syncExtras` is unchanged. Passes `channelId={c.id}` and `onPerson` from a new `voice.onPerson?` prop. ChannelRow gets `menu={{ surface: c.kind === 'dm' ? 'dm' : 'channel', id: c.id }}`. The category head gets `data-menu="category" data-category-id={e.id}`. ArrowDown from a voice row now walks into its people, then to the next channel. |
| Text channel, DM row | `packages/ui/src/ChannelRow/ChannelRow.tsx` : `ChannelRow` | New prop `menu?: { surface: 'channel' \| 'dm'; id: string }` renders `data-menu` and `data-channel-id` on the button. |
| Server icon | `packages/ui/src/CommunityRail/CommunityRail.tsx` | Each server button: `data-menu="server" data-community-id={item.id}`. Home `@`, `+` and settings get none. |
| Member list | `packages/ui/src/MemberList/MemberList.tsx` | **Remove** `onContextMenu`, `onKeyDown`, `keyOpenedAt` and `openFrom` (lines 70-87, and the two handlers on `<li>`). The row button gets `data-menu="person" data-user-id={m.id}`. `onOpen`'s `via` stays in the type. Clicks pass `e.detail > 0 ? 'click' : 'menu'` as today (Enter = `'menu'`, which only opens). Update the doc comments: right-click, Shift+F10 and the ContextMenu key now open the person menu through the host. |
| Message row, author, avatar, mention, link | `packages/ui/src/MessageRow/MessageRow.tsx` | Row element: `data-menu="message"`. Author name button and avatar span (when `opens`): `data-menu="person" data-user-id={authorId}`. User mention pill button: `data-menu="person" data-user-id={userId}`. The plain mention `<span>` (no `onOpenProfile`) gets none. Link `<a class="d-link">`: `data-menu="link"`. |
| Attachments | `packages/ui/src/AttachmentCard/AttachmentCard.tsx` and `packages/ui/src/Lightbox/Lightbox.tsx` | Card root: `data-menu="attachment" data-index={index}` (new prop `index: number`; `Attachments.tsx:161` passes `a.index`). Lightbox `<img>`: `data-menu="attachment" data-index data-seq` (new props). `MediaPlayer` (audio and video) sits inside the card, so it inherits the card's menu, except over its controls, which are `<input>`s (native menu kept by rule 2). |
| Call tiles | `packages/ui/src/CallTile/CallTile.tsx` | `<li class="d-call-stage__tile">` gets `data-menu="person" data-user-id={view.userId}`. The focus button inside is the focusable element, and `closest` finds the li. Screen tiles too (Discord gives the sharer's menu). |

**Web callers** need no attribute work. They register handlers (§U.3.2):
- `Shell.tsx` registers `person`, `channel`, `voice-channel`, `category`, `server` and `dm` with root = a new `shellRoot` ref on a wrapper `<div className="dw-menu-root" style={{ display: 'contents' }}>` around AppShell;
- `Conversation.tsx` registers `message`, `link` and `attachment` with root = `paneRef`;
- `ThreadView.tsx` registers the same three with root = its own pane ref.

The thread pane sits inside the shell root, so it is the deeper root and wins for its rows.

---

### U.5 Menu models and truth tables

All models are pure functions in `packages/web/src/screens/menus/`. Each returns **ordered groups of `{ id, kind, … }` items** with no labels. Its hook (`use<Surface>Menu.tsx`) maps groups to `MenuEntry[]` with `withSeparators` and the `t()` keys of §U.9, and runs the ids. Advisory only: the instance decides every request again.

#### U.5.1 Person

##### U.5.1.1 Signature (`packages/web/src/screens/menus/person-menu.ts`)

```ts
import type { CommunityAccess, RoleSummary, VoiceModAccess } from '@dilla/client-core';

export interface PersonMenuInput {
  selfId: string;
  target: { userId: string; username: string; isBot: boolean;
    /** Listed in this server's members (false: a former member's message). Ignored in a DM. */ isMember: boolean;
    roleIds: readonly string[] };
  /** Null in a DM or Home: no server, so no voice moderation, roles, kick or ban. */
  community: null | {
    id: string; ownerId: string; access: CommunityAccess | undefined; roles: readonly RoleSummary[];
    /** client-core's advisory answer for this target (NO_VOICE_MOD when they are not in voice or slices are missing). */
    mod: VoiceModAccess;
    /** Voice channel id → name, for move to labels. */
    channelNames: Readonly<Record<string, string>>;
  };
  /** Where the target is in voice now; null when not connected (the AFK away roster counts as not connected). */
  voice: null | { channelId: string; serverMuted: boolean; serverDeafened: boolean;
    /** I am in that same call (same channel, or the same DM call). */ sameCall: boolean;
    mutedForMe: boolean; volume: number };
  /** A composer is open and accepting text, and the target can be mentioned there (a username, and a member of that conversation). */
  canMention: boolean;
}

export type PersonItem =
  | { id: 'profile' | 'mention' | 'message' | 'compare' | 'copyId'; kind: 'item' }
  | { id: 'disconnect' | 'kick' | 'ban'; kind: 'item'; danger: true }
  | { id: 'muteForMe' | 'serverMute' | 'serverDeafen'; kind: 'check'; checked: boolean }
  | { id: 'volume'; kind: 'slider'; value: number }
  | { id: 'moveTo'; kind: 'submenu'; channels: readonly { id: string; name: string }[] }
  | { id: 'roles'; kind: 'submenu'; roles: readonly { id: string; name: string; color: number; checked: boolean; disabled: boolean }[] };

export type PersonGroupId = 'profile' | 'local' | 'voiceMod' | 'roles' | 'members' | 'copy';
export interface PersonGroup { id: PersonGroupId; items: PersonItem[] }

/** The person menu: groups in this order, each item only when it applies, empty groups dropped. */
export function personMenu(input: PersonMenuInput): PersonGroup[];
/** The roles the Roles › submenu lists (moved here from MemberRolesFlow so both agree): highest first, no @everyone. */
export function roleChoices(input: { roles: readonly RoleSummary[]; everyoneId: string; held: readonly string[];
  owner: boolean; myTop: number; myBits: number }): { id: string; name: string; color: number; checked: boolean; disabled: boolean }[];
```

`roleChoices` is lifted from `MemberRolesFlow.tsx` (`assignable`, `rankLocked`, `lacking`), and `MemberRolesFlow` then calls it. That flow's behaviour must not change, and its tests must stay green.

##### U.5.1.2 Order and rules

Let:
- `self = target.userId === selfId`
- `C = community`
- `A = C?.access`, `loaded = A?.loaded === true`
- `targetOwner = C !== null && target.userId === C.ownerId`
- `M = C?.mod ?? NO_VOICE_MOD`

In a server, a target with `isMember === false` gets only `profile` and `copyId`. That covers a former member's message.

| # | Group | Item | Kind | Shown when |
|---|---|---|---|---|
| 1 | profile | `profile` | item | always |
| 2 | profile | `mention` | item | `canMention` |
| 3 | profile | `message` | item | `!self` |
| 4 | profile | `compare` (compare safety numbers) | item | `!self` |
| 5 | local | `muteForMe` (mute for me) | check, `checked = voice.mutedForMe` | `voice !== null && voice.sameCall && !self` |
| 6 | local | `volume` | slider 0..200 step 10, `value = voice.volume` | same as 5 |
| 7 | voiceMod | `serverMute` | check, `checked = voice.serverMuted` | `C && voice && M.serverMute` |
| 8 | voiceMod | `serverDeafen` | check, `checked = voice.serverDeafened` | `C && voice && M.serverDeafen` |
| 9 | voiceMod | `moveTo` › | submenu of `M.moveTargets` (already excludes the current channel and AFK, and requires both to view+connect), labelled by `channelNames` | `C && voice && M.move && M.moveTargets.length > 0` |
| 10 | voiceMod | `disconnect` | item, danger | `C && voice && M.disconnect` |
| 11 | roles | `roles` › | submenu of `roleChoices(...)` | `C && target.isMember && loaded && A.manageRoles && (!targetOwner \|\| self)` and the list is non-empty |
| 12 | members | `kick` | item, danger | `C && target.isMember && loaded && A.kickMembers && canModerate({ me: selfId, target, owner: C.ownerId, myTop: A.top, targetTop: topOf(target.roleIds, C.roles) })` |
| 13 | members | `ban` | item, danger | the same with `A.banMembers` |
| 14 | copy | `copyId` (copy user ID) | item | always |

Notes:
- Rows 7–10 apply to yourself too when you hold the right (J5: "including themselves"). The owner rule lives in `voiceModAccess` (§C.9.2, ruling 5): for anyone else the owner's row gets `NO_VOICE_MOD`; on the owner's own row, on the device in that call, it offers only move to (the switch) and disconnect (the leave). The model adds no owner filter of its own.
- move to and disconnect on your own row, while this device is in that call (`mod.local`), are your own switch and leave (§U.5.1.5), never `voiceMove`/`voiceDisconnect`.
- `canModerate` already excludes self and the owner (`client-core`), unchanged from today's `menuFor`.
- The move to list shows channel names only, in list order. The current channel is left out, and so is the AFK channel (J7).
- **Mention** inserts `@{username} ` (`mentionOptions`' own `insert`, `shell-model.ts:305`) into the current conversation's draft:
  - `setDraft(d => ({ channelId: targetId, text: joinMention(d.text, username), typed: true }))`, where `joinMention(text, u) = text === '' || /\s$/.test(text) ? text + '@' + u + ' ' : text + ' @' + u + ' '`;
  - then `focusComposer()`, with the caret placed at the end.
  - `canMention` is true when the shell's `composer` is non-null **and** `reasonKey === null` **and** `username !== ''` **and** (in a channel) the target is a member of this server, or (in a DM) the target is in `dm.members`.
  - With no conversation open (a voice stage, Home with no DM, Settings), it is hidden. Discord opens nothing either.

##### U.5.1.3 Truth table

Viewer V, target T. ✓ = shown, — = hidden. Abbreviations:
- P/M/Me/C = profile, mention, message, compare;
- L = mute for me + volume;
- SM/SD = server mute/deafen;
- Mv/D = move to/disconnect;
- R = roles;
- K/B = kick/ban;
- ID = copy user ID.

"in voice" = T is connected to voice in this server; "same call" = V is in that call.

| # | Case | P | M¹ | Me | C | L | SM | SD | Mv | D | R | K | B | ID |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | member, no rights, T not in voice | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | — | — | — | ✓ |
| 2 | member, no rights, same call | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | — | — | ✓ |
| 3 | V has mute+deafen+move on T's channel, T in voice, not same call | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓² | ✓ | — | — | — | ✓ |
| 4 | case 3 and same call | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓² | ✓ | — | — | — | ✓ |
| 5 | V has move only (channel override), T in voice | ✓ | ✓ | ✓ | ✓ | ³ | — | — | ✓² | ✓ | — | — | — | ✓ |
| 6 | V holds the rights server-wide, but a channel override denies move on T's channel | ✓ | ✓ | ✓ | ✓ | ³ | ✓ | ✓ | — | — | — | — | — | ✓ |
| 7 | T is the owner, V has every right except owner | ✓ | ✓ | ✓ | ✓ | ³ | — | — | — | — | — | — | — | ✓ |
| 8 | V is the owner, T a member in voice | ✓ | ✓ | ✓ | ✓ | ³ | ✓ | ✓ | ✓² | ✓ | ✓ | ✓ | ✓ | ✓ |
| 9 | self, no rights, in voice | ✓ | ✓ | — | — | — | — | — | — | — | — | — | — | ✓ |
| 10 | self, mute+deafen+move, in voice | ✓ | ✓ | — | — | — | ✓ | ✓ | ✓² | ✓ | ⁴ | — | — | ✓ |
| 11 | self is the owner, in voice on this device | ✓ | ✓ | — | — | — | — | — | ✓² | ✓ | ✓ | — | — | ✓ |
| 12 | V has manageRoles+kick+ban, T ranks below V, T not in voice | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | ✓ | ✓ | ✓ | ✓ |
| 13 | as 12, but T ranks at or above V | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | ✓ | — | — | ✓ |
| 14 | V has move, T in voice, no other channel T and V can both join | ✓ | ✓ | ✓ | ✓ | ³ | — | — | — | ✓ | — | — | — | ✓ |
| 15 | former member (a message author, `isMember` false) | ✓ | — | — | — | — | — | — | — | — | — | — | — | ✓ |
| 16 | DM peer, no call | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | — | — | — | ✓ |
| 17 | DM peer, in the same DM call | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | — | — | ✓ |
| 18 | access or overwrites not loaded yet, T in voice | ✓ | ✓ | ✓ | ✓ | ³ | — | — | — | — | — | — | — | ✓ |

Footnotes:
1. Only while `canMention`.
2. Only while the filtered channel list is non-empty.
3. Only when in the same call.
4. When V has manageRoles.

`personMenu.test.ts` has one `it` per row, asserting the exact flat id list.

##### U.5.1.4 Building the input (`usePersonMenu.tsx`, in Shell)

- **Server context**: `communityId` is the shell's current server (`community?.id`) when the element sits outside a DM view. In a DM conversation, Home or the DM list, `community` is null.
- **Target**: `members:${cid}` finds the member: `isMember`, `roleIds`, `username`, `isBot = kind === 1`. In a DM, `allMembers` plus `dm.members`.
- **Voice**: search `voiceSlice` for a participant with `userId`. Its channel id is `voice.channelId`. Away roster people are excluded.
  - `sameCall = call.channelId === voice.channelId`. For a DM, `voice` = the DM call when `call.channelId === dm.id` and the peer is in its tiles.
  - `volume = volumeOf(settings, userId)` (`VoiceView.tsx:42`, export it).
  - `mutedForMe = isLocallyMuted(settings, userId)`.
- **Access**: `source = voiceChannelOf(voiceSlice, voiceChannelIds, userId)`; `mod = voiceModAccess({ owner, everyoneId: access.overwritesLoaded ? access.everyoneId : '', roles, members, overwrites, voiceChannels: voiceChannelIds, afkChannelId: afk?.channelId ?? null }, selfId, userId, source, call.state?.phase === 'in' || call.state?.phase === 'paused' ? call.channelId : null)`. Any missing slice gives `NO_VOICE_MOD`.
- **Server state**: `serverMuted` / `serverDeafened` = any of the target's devices in `voice[source]` has `VOICE_FLAG.serverMute` / `VOICE_FLAG.serverDeaf` in its flags.

Put this in a pure helper `personInputs(...)` in `person-menu.ts`, so it is tested too.

##### U.5.1.5 Running the ids

| Id | Does |
|---|---|
| `profile` | `setProfileCard({ id: userId, source: 'menu', anchor: el, name })`. Add `'menu'` to `OpenCard.source`. `MemberCardHost` treats it like `'mention'` (`placement="below"`, fallback `messageFallback`). |
| `mention` | §U.5.1.2. |
| `message` | `onMessage(userId)` (the shell's existing DM opener passed to MemberPane). |
| `compare` | `onCompare(userId)` (existing). |
| `muteForMe` | `client.call({ m: 'setSetting', key: SETTINGS.voiceLocalMute(userId), value: checked ? null : '1' })`. useCall calls `session.setLocalMute(userId, on)` when the setting changes (task W6). Announce `person.menu.done.mutedForMe` / `person.menu.done.unmutedForMe`. |
| `volume` | `value` callback: `call.setVolume(userId, v)` (existing, `useCall.tsx:1023`). |
| `serverMute` | `client.call({ m: 'serverMute', communityId, userId, on: !checked })` via `useVoiceMod` (§U.8.3). |
| `serverDeafen` | `client.call({ m: 'serverDeafen', communityId, userId, on: !checked })` via `useVoiceMod`. |
| `move:<channelId>` | `mod.local`: the existing switch, `voiceCtx.onJoinVoice?.(channelId)`, plus `openVoice(channelId)` only if the old channel's stage was on screen. Otherwise `client.call({ m: 'voiceMove', communityId, userId, toChannelId })` via `useVoiceMod` (§U.8.3). |
| `disconnect` | `mod.local`: `call.leave()`. Otherwise `client.call({ m: 'voiceDisconnect', communityId, userId })` via `useVoiceMod`. |
| `role:<roleId>` | `keepOpen` check. `grantRole`/`revokeRole` with the same calls and error copy as `MemberRolesFlow`. Extract its toggle into `toggleRole(client, cid, userId, roleId, on): Promise<void>` in `MemberRolesFlow.tsx` and export it. The entry is `disabled` while its call is in flight (hook state `busyRole`). |
| `kick`, `ban` | a new Shell-level `<ModFlows>` (`packages/web/src/screens/admin/ModFlows.tsx`), which holds `{ kind: 'kick' \| 'ban'; communityId; target: ModTarget; opener: HTMLElement } \| null` and renders `KickFlow`/`BanFlow` exactly as `MemberCardHost` does (lines 168-171). Focus returns to `opener` through `focusReturnTarget`. |
| `copyId` | `copyText(userId)`, then announce `menu.copied.userId` or `menu.copy.blocked`. |

The menu label is `person.menu.label` (`menu for {name}`). The sheet title is the name.

#### U.5.2 Message (`message-menu.ts`)

```ts
export interface MessageMenuInput { own: boolean; state: TimelineItemState; hasIds: boolean /* msgId and seq non-null */;
  inThread: boolean; canSend: boolean; canPin: boolean; canOpenThread: boolean; pinned: boolean; hasText: boolean }
export type MessageItemId = 'react' | 'edit' | 'reply' | 'thread' | 'copyText' | 'pin' | 'delete' | 'copyId';
export function messageMenu(i: MessageMenuInput): { id: 'react' | 'compose' | 'copy' | 'danger' | 'ids'; items: { id: MessageItemId; danger?: true; pinned?: boolean }[] }[];
```

The rules mirror the toolbar (`MessageItem.tsx:71-79`). A row that is not `ok` with ids gets **no message menu** (`build` returns null), and the browser's menu shows. That matches the toolbar being absent there.

| Order | Group | Id | Label key | Shown when | Runs (existing handler) |
|---|---|---|---|---|---|
| 1 | react | `react` | `menu.message.react` | always | `onRowEvent(item, { kind: 'react', anchor })`. Anchor = the row's toolbar react button if rendered, else the row. |
| 2 | compose | `edit` | `shell.message.edit` | `own` | `{ kind: 'edit' }` |
| 3 | compose | `reply` | `shell.message.reply` | `!inThread && canSend` | `{ kind: 'reply' }` |
| 4 | compose | `thread` | `thread.open` | `canOpenThread && canSend` | `p.onOpenThread(msgId)` |
| 5 | copy | `copyText` | `menu.message.copyText` | `hasText` | `copyText(plainBody(item.body, book))`, announce `menu.copied.text` |
| 6 | copy | `pin` | `shell.message.pin` / `shell.message.unpin` | `!inThread && canPin` | `{ kind: 'pin', on: !pinned }` |
| 7 | danger | `delete` | `shell.message.delete` | `own` | `{ kind: 'delete' }` (the existing confirm) |
| 8 | ids | `copyId` | `menu.message.copyId` | always | `copyText(msgId)`, announce `menu.copied.messageId` |

`canPin = bits == null || (bits & PERM.pinMessages) !== 0`, `canSend` likewise, exactly as `MessageItem` does.

Truth table:

| Case | react | edit | reply | thread | copyText | pin | delete | copyId |
|---|---|---|---|---|---|---|---|---|
| own, channel, can send+pin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| other's, channel, can send, no pin | ✓ | — | ✓ | ✓ | ✓ | — | — | ✓ |
| other's, read-only (no send) | ✓ | — | — | — | ✓ | per pin | — | ✓ |
| own, thread pane | ✓ | ✓ | — | — | ✓ | — | ✓ | ✓ |
| attachment-only message (no text) | ✓ | own | ✓ | ✓ | — | ✓ | own | ✓ |
| pending, failed, deleted, cannot-read | no menu (browser's) | | | | | | | |

Label: `menu.message.label` (`menu for message from {name}`). Sheet title = the author's name.

#### U.5.3 Link (`link-menu.ts`)

Ids: `open` (`menu.link.open`), then `copy` (`menu.link.copy`), always both.
- `open` = `window.open(href, '_blank', 'noopener,noreferrer')`, the same target as the anchor.
- `copy` = `copyText(href)` and announce `menu.copied.link`.

Only `SAFE_HREF` links are anchors: a non-anchor link is plain text and has no menu. A link inside a selection keeps the browser's menu (§U.3.3). Label `menu.link.label`.

#### U.5.4 Attachment (`attachment-menu.ts`)

```ts
export function attachmentMenu(i: { kind: 'image' | 'audio' | 'video' | 'file'; tooLarge: boolean; hasSeq: boolean; canCopyImage: boolean }): ('open' | 'save' | 'copyImage')[];
```

| Id | Label | Shown when | Runs |
|---|---|---|---|
| `open` | `menu.attachment.open` | `kind === 'image' && hasSeq && !tooLarge` | the card's `onOpen` (the lightbox, `openImage`) |
| `save` | `media.save` | `hasSeq && !tooLarge` | the card's `save()` (`Attachments.tsx:145`) |
| `copyImage` | `menu.attachment.copyImage` | `kind === 'image' && hasSeq && !tooLarge && canCopyImage` | `openAttachment` (`thumb: false`) → `copyImage(blob)` → announce `menu.copied.image` or `menu.copy.blocked` |

`canCopyImage = typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function'`. `copyImage` converts any image type to PNG: `createImageBitmap(blob)` → `OffscreenCanvas` (or a `<canvas>` where OffscreenCanvas is missing) → `convertToBlob({ type: 'image/png' })` → `navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])`.

What "copy image" honestly does: it places the opened picture on this device's clipboard, the same bytes "save" writes to disk. It never puts a link there.

**Copy link is left out for attachments.** No link exists that opens the file for anyone else: the instance only holds bytes it can't read, so a link would give a stranger nothing and mislead a member. The UI doesn't explain this; the user doc does (§U.9 docs line).

In the lightbox the menu is the same, with `open` hidden (already open). If there is no image, the browser's menu shows. Label `menu.attachment.label` (`menu for {name}`).

#### U.5.5 Text channel (`channel-menu.ts`)

```ts
export function channelMenu(i: { kind: 'text' | 'announcement'; unread: number; mentions: number; muted: boolean;
  notify: 'default' | 'all' | 'mentions' | 'nothing'; canInvite: boolean; canManage: boolean }): Group[];
```

| Order | Group | Id | Kind | Label | Shown when | Runs |
|---|---|---|---|---|---|---|
| 1 | read | `markRead` | item, `disabled` when `unread + mentions === 0` | `menu.channel.markRead` | always | `client.call({ m: 'markRead', channelId })`, announce `menu.done.markedRead` |
| 2 | share | `invite` | item | `menu.channel.invite` | `canInvite` (`access.createInvite`) | open `InviteFlow` (Shell state `inviteFor: communityId`) |
| 3 | share | `copyLink` | item | `menu.channel.copyLink` | always | `copyText(location.origin + routePath({ name: 'channel', communityId, channelId }))` |
| 4 | notify | `mute` | check `muted` | `menu.channel.mute` | always | `setSetting(SETTINGS.muteChannel(id), muted ? null : '1')` |
| 5 | notify | `notify` › | submenu of 4 radio items `notify:default`, `notify:all`, `notify:mentions`, `notify:nothing` | `menu.channel.notify`; children `notify.channel.default/all/mentions/nothing` | always | `setSetting(SETTINGS.notifyChannel(id), v === 'default' ? null : v)` |
| 6 | manage | `edit` | item | `admin.channel.open` | `canManage` | `setEditChannelId(id)` |
| 7 | manage | `delete` | item, danger | `menu.channel.delete` | `canManage` | open `DeleteChannel` (export it from `ChannelsSection.tsx`) |
| 8 | ids | `copyId` | item | `menu.channel.copyId` | always | `copyText(id)` |

`muted` here is `settings[muteChannel] === '1'`, the channel's own flag: a server-wide mute does not tick it. `notify` is the channel's own override or `'default'`.

#### U.5.6 Voice channel (`voice-channel-menu.ts`)

| Order | Group | Id | Label | Shown when | Runs |
|---|---|---|---|---|---|
| 1 | call | `join` | `voice.join` | `!joined && !held && !afk && canConnect` | `openVoice(id)` and `voiceCtx.onJoinVoice?.(id)`, as the row's join icon does |
| 1 | call | `leave` | `menu.channel.leaveVoice` | `joined` | `call.leave()` |
| 2 | share | `invite` | `menu.channel.invite` | `canInvite` | InviteFlow |
| 3 | share | `copyLink` | `menu.channel.copyLink` | always | as 5.5 |
| 4 | manage | `edit` | `admin.channel.open` | `canManage` | `setEditChannelId(id)` |
| 5 | manage | `delete` | `menu.channel.delete` | `canManage && !afk` | `DeleteChannel` |
| 6 | ids | `copyId` | `menu.channel.copyId` | always | copy |

`canConnect` = `channelBitsOf(me)` on it has `PERM.connect`, or `bits === null`, which shows it as before roles existed. "Open chat" is left out: dilla's voice channels have no text chat.

#### U.5.7 Category (`category-menu.ts`)

| Order | Group | Id | Kind | Label | Shown when | Runs |
|---|---|---|---|---|---|---|
| 1 | read | `markRead` | item, disabled when no child has unread or mentions | `menu.channel.markRead` | always | `markRead` for each child channel with `unread + mentions > 0` |
| 2 | fold | `collapse` | check `collapsed` | `menu.category.collapse` | always | `toggleCategory(id)` (`Shell.tsx:982`) |
| 3 | fold | `collapseAll` | item | `menu.category.collapseAll` | `categories.length > 1` | `setSetting(collapsedKey(c), '1')` for each not-yet-collapsed category |
| 4 | manage | `create` | item | `create.channel.open` | `canManage` | `setChannelParent(id); setChannelOpen(true)` (existing "+") |
| 5 | manage | `delete` | item, danger | `menu.category.delete` | `canManage` | `DeleteChannel` (it handles `CATEGORY`) |
| 6 | ids | `copyId` | item | `menu.category.copyId` | always | copy |

#### U.5.8 Server icon (`server-menu.ts`)

| Order | Group | Id | Kind | Label | Shown when | Runs |
|---|---|---|---|---|---|---|
| 1 | read | `markRead` | item, disabled at zero unread and mentions | `menu.channel.markRead` | always | `markRead` for each channel of that server with a badge (`badges` + `rowBadge`) |
| 2 | share | `invite` | item | `menu.server.invite` | `access.createInvite` | InviteFlow for that server |
| 3 | notify | `mute` | check | `menu.server.mute` | always | `setSetting(SETTINGS.muteCommunity(id), on ? '1' : null)` |
| 4 | notify | `notify` › | submenu of 4 radio items | `menu.channel.notify`; children `notify.channel.*` | always | `setSetting(SETTINGS.notifyCommunity(id), …)` |
| 5 | manage | `settings` | item | `menu.server.settings` | always | `openAdminFor(id, 'overview')` |
| 6 | manage | `leave` | item, danger | `menu.server.leave` | `!access.owner` (owner: hidden, as DangerSection tells owners they can't leave) | the new `LeaveFlow` dialog, extracted from `DangerSection.tsx` (its `leave` dialog and `leave()`), exported and used by both |
| 7 | ids | `copyId` | item | `menu.server.copyId` | always | copy |

`access` here is `permissions:${id}` of **that** server, which may differ from the open one. When it is not loaded, `invite` and `leave` are hidden.

#### U.5.9 DM row (`dm-menu.ts`)

Kind 3 is a 1:1 DM; kind 4 is a group.

| Order | Group | Id | Label | Shown when | Runs |
|---|---|---|---|---|---|
| 1 | read | `markRead` (disabled at zero) | `menu.channel.markRead` | always | `markRead` |
| 2 | person | `profile` | `person.menu.profile` | kind 3 | Shell card with `source: 'menu'`, `dm` context |
| 3 | person | `call` | `call.start` | `dmCallStart(voiceCtx, id) !== null` | `dmCallStart(...).onStart()` after navigating to the DM |
| 4 | person | `compare` | `members.menu.compare` | kind 3 | `onCompare(peerId)` |
| 5 | notify | `mute` | check, `menu.dm.mute` | always | `setSetting(SETTINGS.muteChannel(id), …)` |
| 6 | notify | `notify` › | `menu.channel.notify` | always | `notifyChannel(id)` |
| 7 | ids | `copyUserId` | `person.menu.copyId` | kind 3 | copy peer id |
| 8 | ids | `copyId` | `menu.channel.copyId` | always | copy channel id |

"Close DM" is left out: there is no command. `closeChannel` is a subscription close (`Shell.tsx:694`).

#### U.5.10 Left out, and why

| Discord item | Surface | Why |
|---|---|---|
| Copy message link | message | No message route (`router.ts` has `channel` and `dm` only). |
| Mark unread | message | No worker command; `markRead` only moves forward. |
| Forward, Apps, Speak message, Report | message | No such features. |
| Delete or edit another's message | message | The client offers delete on own messages only. |
| Add reaction › recent-emoji list | message | No recent store; the item opens the existing grid. |
| Call, Add note, Add friend, Block, Ignore, Invite to server, Disable video | person | No such features (the DM call lives on the DM row). |
| Timeout, Change nickname | person | Spec non-goals. |
| Notification settings › | category | No per-category setting. |
| Mute category | category | No per-category setting. |
| Edit category | category | No rename flow for categories outside Server settings. |
| Duplicate channel, Create text channel | channel | Not built. |
| Open chat | voice channel | Voice channels have no text chat. |
| Hide names, Hide muted channels, Privacy settings | server | Not built. |
| Close DM | DM row | No command. |
| Copy link (attachment) | attachment | No link that opens the file outside dilla (§U.5.4). |
| Move into AFK | person, drag | The AFK channel hosts no call. |

---

### U.6 Drag to move

#### U.6.1 Phones (D16)

**No drag on a phone, and no drag from touch anywhere.** Discord mobile has none. A long-press is the menu (§U.3.5), so a drag would fight it. On a phone, a move goes through the sheet's **move to** page. A desktop window used with a touch screen also uses long-press → menu.

#### U.6.2 Files and API

| File | What |
|---|---|
| `packages/ui/src/ChannelList/useVoiceDrag.ts` (new) | The pointer machine. |
| `packages/ui/src/ChannelList/ChannelList.tsx` | New `voice.drag?` prop; renders the ghost; passes `drag` handlers to each `VoiceChannelRow`. |
| `packages/ui/src/VoiceChannelRow/VoiceChannelRow.tsx` | Person buttons take `onPointerDown`/`onPointerMove`/`onPointerUp`/`onLostPointerCapture` from the hook, and `data-draggable="true"` when `canDrag`. The voice-row button gets `data-drop` (`valid`, `over` or absent). |
| `packages/ui/src/ChannelList/ChannelList.css` | Ghost and drop styles. |
| `packages/web/src/screens/menus/drop-verdict.ts` (new) | The pure verdict. |
| `packages/web/src/screens/Shell.tsx` | Fills `voice.drag`. |

```ts
// ChannelListProps['voice'] gains:
drag?: {
  /** Desktop only; Shell passes undefined on a phone. */
  canDrag(userId: string, fromChannelId: string): boolean;
  /** For highlighting: true only for a valid target. */
  canDrop(userId: string, fromChannelId: string, toChannelId: string): boolean;
  /** A drop on a valid target. */
  onDrop(userId: string, fromChannelId: string, toChannelId: string): void;
  /** A drop on a voice row that is not valid (not the source row). The caller announces why. */
  onRefuse(userId: string, fromChannelId: string, toChannelId: string): void;
  /** Escape or a lost capture. The caller announces `voice.mod.drag.cancelled`. */
  onCancel(): void;
};
```

```ts
// drop-verdict.ts
export type DropRefusal = 'same' | 'afk' | 'owner' | 'noMove' | 'youCannotJoin' | 'theyCannotJoin';
export type DropVerdict = { ok: true; kind: 'move' | 'switch' } | { ok: false; reason: DropRefusal };
export function dropVerdict(i: { local: boolean; ownerId: string; userId: string; from: string;
  to: { id: string; afk: boolean; targetCanJoin: boolean; iCanJoin: boolean }; myBitsOnFrom: number | null }): DropVerdict;
export function canDrag(i: { local: boolean; ownerId: string; userId: string; away: boolean; myBitsOnFrom: number | null }): boolean;
```

**One advisory answer.** `canDrop(userId, from, to)` in Shell is `mod.dragTargets.includes(to)`, with `mod = voiceModAccess(...)` for that person (§U.5.1.4). That is the one advisory answer, and it decides the highlight and whether `onDrop` or `onRefuse` runs. `dropVerdict` exists only to name the **reason** of a refusal for the announcement. Its inputs come from the same slices (`targetCanJoin`, `iCanJoin` = `channelBitsOf` view+connect for the target and for me; `myBitsOnFrom` = `channelBitsOf(me)` on `from`). A disagreement between the two can only change which refusal sentence is said. Shell's `canDrag` = `!away && (mod.local || mod.move)` (M10): `voiceModAccess` already gives the owner's row nothing for anyone else, so no owner test is repeated. The `canDrag` below is its pure twin for tests, with `local = mod.local`.

`dropVerdict` checks in this order, and the first rule that matches decides:
1. `to.id === from` → `same`
2. `to.afk` → `afk`
3. `local` (this device is the one in `from`) → `iCanJoin ? { ok, 'switch' } : 'youCannotJoin'`
4. `userId === ownerId` → `owner`
5. `myBitsOnFrom === null || !(bits & moveMembers)` → `noMove`
6. `!iCanJoin` → `youCannotJoin`
7. `!targetCanJoin` → `theyCannotJoin`
8. otherwise `{ ok, 'move' }`

`canDrag` = `!away && (local || (userId !== ownerId && myBitsOnFrom !== null && (myBitsOnFrom & PERM.moveMembers) !== 0))`.

#### U.6.3 The pointer machine (`useVoiceDrag`), modelled on `Splitter.tsx`

State: `idle → pressed(userId, from, x0, y0, pointerId) → dragging(…, x, y, over) → idle`.

- **pointerdown** on a person button: only `e.button === 0` and `e.pointerType` `mouse` or `pen`, and `canDrag`. Store `pressed`. Don't capture yet: a plain click must still reach the button.
- **pointermove** while `pressed`: when `Math.hypot(x − x0, y − y0) >= 4` (**threshold 4 px**):
  - `e.currentTarget.setPointerCapture(e.pointerId)`;
  - go to `dragging`;
  - compute `valid: Set<string>` = every voice row id with `canDrop(...)`;
  - set `data-drop="valid"` on those rows: React state `dropIds` passed down; each VoiceChannelRow reads `drop={dropIds.has(id) ? (over === id ? 'over' : 'valid') : undefined}`;
  - set `data-dragging="true"` on the source person button, and `data-dragging="true"` on the `nav.d-channel-list` (cursor);
  - find the scroller (nearest ancestor of the list with `overflow-y` `auto` or `scroll`).
- **pointermove** while `dragging`: set `x, y`. `over = (document.elementFromPoint(x, y)?.closest<HTMLElement>('.d-voice-row')?.dataset.channelId) ?? null`. Auto-scroll as below.
- **pointerup** while `dragging`:
  - `over` in `valid` → `onDrop`;
  - `over` not null and `over !== from` → `onRefuse`;
  - else nothing;
  - then reset, and swallow the click that follows (a `suppressClick` ref checked first in the person button's `onClick`).
- **pointerup** while `pressed` → reset (the button's own click proceeds).
- **lostpointercapture** or **pointercancel** while `dragging` → `onCancel()` and reset.
- **Escape**: while `dragging`, a `keydown` listener on `document` (capture) calls `e.preventDefault()` and `releasePointerCapture`, then `onCancel()` and reset. The person button keeps focus if it had it.

**Auto-scroll.** While dragging, a `requestAnimationFrame` loop runs. With `r = scroller.getBoundingClientRect()` and `EDGE = 32`:
- if `y < r.top + EDGE`: `scroller.scrollTop -= Math.min(8, Math.ceil((r.top + EDGE − y) / 4))`;
- if `y > r.bottom − EDGE`: `scrollTop += Math.min(8, Math.ceil((y − (r.bottom − EDGE)) / 4))`;
- after a scroll, recompute `over`;
- stop the loop on reset;
- under `prefers-reduced-motion: reduce`, keep auto-scroll (it is functional, not decoration) but cap it at 4 px per frame.

**Ghost.** While dragging, ChannelList renders `<div class="d-voice-drag" aria-hidden="true" style={{ left, top }}>` containing `<Avatar name size="xs" />` and `<span class="d-voice-drag__name">{name}</span>`. Its position: `placeInBox(nav, { x: x + 12, y: y + 12 }, w, h)`, the shared clamp (fixed inside the shell's containing block).

CSS (`ChannelList.css`):

```css
.d-voice-drag { position: fixed; z-index: 45; display: inline-flex; align-items: center; gap: 0.375rem; padding: 0.25rem 0.5rem; font-family: var(--font-mono); font-size: var(--text-sm); color: var(--fg); background: var(--surface-hi); border: 1px solid var(--accent); border-radius: var(--r-md); box-shadow: var(--shadow-2); pointer-events: none; }
.d-channel-list[data-dragging="true"], .d-channel-list[data-dragging="true"] * { cursor: grabbing; }
.d-voice-row__person-open[data-dragging="true"] { opacity: var(--opacity-muted); }
.d-voice-row[data-drop="valid"] { outline: 1px dashed var(--accent); outline-offset: -1px; }
.d-voice-row[data-drop="over"] { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); color: var(--fg); }
@media (forced-colors: active) { .d-voice-row[data-drop="valid"] { outline-color: Highlight; } .d-voice-row[data-drop="over"] { outline: 2px solid Highlight; } }
```

Invalid rows get no change. The source channel's row gets no highlight either.

#### U.6.4 What Shell does

- `canDrag`, `canDrop` → `canDrag(...)` and `dropVerdict(...).ok`, with the inputs of §U.5.1.4.
- `onDrop`:
  - verdict `switch` → `voiceCtx.onJoinVoice?.(to)` (the normal join; its own announcements);
  - verdict `move` → `voiceMove` (§U.8.3).
- `onRefuse` → `announce(...)` for the refusal, by reason:
  - `afk` → `voice.mod.drag.afk`;
  - `owner` → `voice.mod.error.owner`;
  - `youCannotJoin` → `voice.mod.drag.youCannotJoin`;
  - `theyCannotJoin` → `voice.mod.error.targetNoAccess`;
  - `noMove` → `voice.mod.error.forbidden` (it can't normally happen, because `canDrag` stops it);
  - `same` → nothing.
- `onCancel` → `announce(t('voice.mod.drag.cancelled'))`.

Drag is never the only path: every drop has the same result through **move to** (§U.5.1).

---

### U.7 Indicators

#### U.7.1 Icons that exist

From `packages/ui/src/Icon/icons.ts`, Lucide 1.57.0: mic, mic-off, headphones, headphone-off, video, video-off, monitor-up, monitor-x, phone-off, server, message-square, activity, user, chevron-left, chevron-right, chevron-down, x, check, triangle-alert, pause, ellipsis-vertical, hash, volume-2, volume-x, volume-off, megaphone, messages-square, file, play, eye, settings, plus, maximize, minimize, search, lock, log-out, shield, keyboard, monitor-smartphone, phone, square-pen, at-sign, pin, users, ellipsis, arrow-up, arrow-down, crown.

#### U.7.2 Decision: no new icon; a boxed glyph in the danger colour

Server-muted = `mic-off` and server-deafened = `headphone-off`, both drawn in `--danger` inside a 1 px box. Self-mute and self-deafen stay plain `--fg-2` glyphs. The two differ by **shape** (the box) and colour, so it is never colour alone (WCAG 1.4.1), and a box survives forced colours as an outline.

This keeps the vendored set untouched: `icons.ts` says "Do not edit by hand" and would need a re-vendor.

`mutedForMe` (your local mute) uses `volume-x` in `--fg-2` with no box.

#### U.7.3 Model changes (`packages/ui/src/CallTile/CallTile.tsx`)

- `VoiceParticipantView` gains `serverMuted?: boolean; serverDeafened?: boolean; mutedForMe?: boolean`.
- `VoiceStateLabels` gains `serverMuted: string; serverDeafened: string; mutedForMe: string`.
- `groupPeople` (VoiceChannelRow) takes `some()` for all three.
- `voiceStateWords` pushes in this order, replacing the current first two lines:
  1. `mutedForMe` → `{ key: 'mutedForMe', glyph: <Icon name="volume-x" size={14}/>, text: labels.mutedForMe, glyphOnly: true }`
  2. if `serverDeafened` → `{ key: 'serverDeafened', glyph: <Icon name="headphone-off" size={14}/>, text: labels.serverDeafened, glyphOnly: true }`
     else if `serverMuted` → `{ key: 'serverMuted', glyph: <Icon name="mic-off" size={14}/>, text: labels.serverMuted, glyphOnly: true }`
     else if `muted` → today's muted
  3. if `!serverDeafened && deafened` → today's deafened
  4. video, screen, speaking, stream states: unchanged.
- `silentByChoice` also counts `serverMuted || serverDeafened`, so no "not heard yet" shows.
- `SLOT_STATES` (VoiceChannelRow) = `new Set(['mutedForMe', 'muted', 'serverMuted', 'deafened', 'serverDeafened'])`.

CSS, added to both `VoiceChannelRow.css` and `CallTile.css`:

```css
.d-voice-row__state[data-state="serverMuted"], .d-voice-row__state[data-state="serverDeafened"],
.d-call-tile__state[data-state="serverMuted"], .d-call-tile__state[data-state="serverDeafened"] { color: var(--danger); outline: 1px solid currentColor; outline-offset: 0; border-radius: var(--r-sm); padding: 1px; }
```

#### U.7.4 Placement and names

| Where | Placement | Accessible name |
|---|---|---|
| Voice row person | the trailing slot, in the order mutedForMe, mute, deafen (as today's slot) | `role="img"`, `aria-label` and `title` = `voice.mod.mutedByModerator` (`muted by a moderator`), `voice.mod.deafenedByModerator` (`deafened by a moderator`), `person.menu.state.mutedForMe` (`muted for you`) |
| Call tile | the caption's states, the same order | the same |
| Your own controls | `UserPanel` (desktop), `CallControls` (stage), `CallBar` (phone): the mute button | see 7.5 |

Web fills the labels in `rowLabels()` and `tileLabels()` (`VoiceView.tsx`).

#### U.7.5 Your own server mute or deafen

- `UserPanel`, `CallControls` and `CallBar` get `held?: { mute?: string; deafen?: string }`. A held control is `aria-disabled="true"`, stays focusable, shows its `on` glyph and `aria-pressed="true"`, and has `title` and `aria-describedby` with the reason. This is the existing `voiceWhy` pattern for camera and share (`CallControls.tsx:80-95`).
- Web passes `held.mute = t('voice.mod.mutedByModerator')` while `call.state.serverMuted || call.state.serverDeafened`, and `held.deafen = t('voice.mod.deafenedByModerator')` while `serverDeafened`.
- Pressing a held control, or its shortcut, does nothing but `announce(t('voice.mod.youMuted'))` or `announce(t('voice.mod.youDeafened'))`. useCall's `toggleMute` and `toggleDeafen` check first.
- Your own voice row and tile show the boxed glyph like anyone else's.

---

### U.8 Notices and feedback

The mechanisms already exist:
- `useAnnouncer` (`screens/announcer.ts`): the shell's polite region (`data-testid="shell-announcer"`);
- `CallNotice` and `setNotice` / `setLasting` in `screens/voice/useCall.tsx`: the stage notice and the `dw-voice-lasting` region that outlives the dock (`Shell.tsx:1713`);
- the shell `Banner` stack (`Shell.tsx:1380-1396`).

#### U.8.1 The moved person (`useCall.tsx`, opus task W6)

A `useEffect` on `call.state.move` (§C.6.6) runs once per new `move.seq`, and only when `call.channelId` is the channel of the live session:
1. Remember `following = { to: move.to, from: call.channelId }` in a ref.
2. Run the existing switch: `join(move.to, keptContext)`, where `keptContext` is the old session's running `AudioContext` (D17). This is the normal leave (`'switch'`) and the normal join with its own checks.
3. When the phase is `in` on `to`: `setNotice({ channelId: to, key: 'voice.mod.moved', text: t('voice.mod.moved', { channel: nameOf(to) }) })`; if the stage of `to` is not shown, also `setLasting(text)`; then `announce(text)`.
4. If the page was showing the **old** channel's stage, navigate to `to`'s stage (Discord's view follows the call). Otherwise stay put.
5. If the target join ends `failed` or `blocked` on `to` (§C.6.7): `setNotice({ channelId: to, key: 'voice.mod.moveFailed', text: t('voice.mod.moveFailed', { channel: nameOf(to) }) })` and the usual reason notice after it. Stay out of voice.

The mover is never named (J1).

#### U.8.2 The disconnected person

`cutReason` (`useCall.tsx:421`) returns `{ reason: 1 | 2 | 3 | 4; cid }`. `sayRemoved` (`useCall.tsx:447`) says, per reason: 1 `afk.moved` (today); 2 `afk.elsewhere`, now an explicit `cut.reason === 2` branch (the `else` at :458 would swallow 3 and 4); 3 `setNotice({ channelId: id, key: 'voice.mod.moveMissed' })`; 4 `setNotice({ channelId: id, key: 'voice.mod.disconnected' })`. For 3 and 4 it also calls `setLasting(t(key))` when the stage is not shown, mirroring reason 1. The recovery verdict (`:878`) maps 3 → `'moveMissed'` and 4 → `'modDisconnected'`, and `endRecovery` says the same two keys the same way.

#### U.8.3 The mover

All feedback goes through a new hook, `useVoiceMod(announce, setModNotice)`, in `packages/web/src/screens/menus/useVoiceMod.ts`. It returns `move`, `disconnect`, `mute` and `deafen` functions that call the worker and say the outcome:

| Outcome | Announce (polite) | Banner (tone warn, with dismiss) |
|---|---|---|
| move ok, `disconnected === 0` | `voice.mod.done.moved` | — |
| move ok with `disconnected > 0` (old client) | `voice.mod.movedDisconnected` | **yes**, same text: "no silent fallbacks" |
| disconnect ok | `voice.mod.done.disconnected` | — |
| server mute on / off | `voice.mod.done.muted` / `voice.mod.done.unmuted` | — |
| server deafen on / off | `voice.mod.done.deafened` / `voice.mod.done.undeafened` | — |
| `E_FORBIDDEN` | `voice.mod.error.forbidden` | yes |
| `E_NOT_IN_VOICE` (not for disconnect, where it is success) | `voice.mod.error.gone` | yes |
| `E_CALL_FULL` (move) | `voice.mod.error.full` | yes |
| `E_BAD_INPUT`, `E_INVALID_REQUEST`, `E_NOT_FOUND`, anything else | `voice.mod.error.generic` | yes |
| network, rate limit | the existing `shell.banner.commandError` path (`report`) | (existing) |

The banner is a new Shell state, `modNotice: { id: number; text: string } | null`, rendered right after `removalNotices` with `shell.banner.dismiss`. Dismiss calls `focusComposer()`, as its neighbours do.

#### U.8.4 Your own server mute or deafen changing

A `useEffect` on `call.state.serverMuted` and `serverDeafened` transitions (not on the first value after a join) announces `voice.mod.youMuted`, `voice.mod.youUnmuted`, `voice.mod.youDeafened` or `voice.mod.youUndeafened`. A join into a call while already server muted announces `voice.mod.youMuted` once, together with the existing join announcement. On every change, and at the join, it also calls `session.applyServerVoice({ muted: serverMuted || serverDeafened, deafened: serverDeafened })` (§C.8).

#### U.8.5 Copies and simple actions

The polite announcer says `menu.copied.*` or `menu.copy.blocked`. Mark as read announces `menu.done.markedRead`. Mute and notification changes announce nothing: the check state and the row's muted badge say it.

---

### U.9 Copy

#### U.9.1 Rules

- Chrome labels (menu items, item names) are lower case.
- Notices, announcements and refusals are sentence case with a full stop, except the stage notices `voice.mod.moved`, `voice.mod.moveMissed` and `voice.mod.disconnected`, which follow `afk.moved` (no full stop).
- Apostrophes are typographic (`’`). No `!`, no "secure", "safe" or "protected".
- None of the `check:copy` FORBIDDEN words appear.

#### U.9.2 New modules

Each is spread into `en` in `strings/en.ts` after `...afk`:

- `packages/web/src/strings/personMenu.ts`: `person.menu.*`
- `packages/web/src/strings/voiceMod.ts`: `voice.mod.*`
- `packages/web/src/strings/menus.ts`: `menu.*`

Changed in place, by task T2 (not W1): `packages/web/src/strings/perm.ts` (§U.9.6).

`docs/design/flows/18-context-menus-and-voice-moderation.md` gets a `## Copy` section listing every line below as `` `key='value'` ``. `strings.flow18.test.ts` checks them byte for byte, modelled on `strings.flow17.test.ts`, with the prefix regex `/^(person\.menu\.|voice\.mod\.|menu\.)/` (permission copy is flow 09's, M6) and the expected count. That count is the number of lines below; the implementer counts them once and pins it.

#### U.9.3 `personMenu.ts`

```
'person.menu.label': 'menu for {name}'
'person.menu.profile': 'profile'
'person.menu.mention': 'mention'
'person.menu.muteForMe': 'mute for me'
'person.menu.volume': 'volume'
'person.menu.serverMute': 'server mute'
'person.menu.serverDeafen': 'server deafen'
'person.menu.moveTo': 'move to'
'person.menu.disconnect': 'disconnect'
'person.menu.roles': 'roles'
'person.menu.copyId': 'copy user ID'
'person.menu.state.mutedForMe': 'muted for you'
'person.menu.done.mutedForMe': '{name} is muted for you.'
'person.menu.done.unmutedForMe': '{name} is no longer muted for you.'
```

These are reused, not duplicated: `members.menu.message` (`message`), `members.menu.compare`, `members.menu.kick`, `members.menu.ban`, `voice.volume` (`volume for {name}`, the slider's accessible name), `voice.volumeValue` (`{n} %`, the slider's `valueLabel`), `nav.back`, `dialog.close`.

#### U.9.4 `voiceMod.ts`

```
'voice.mod.mutedByModerator': 'muted by a moderator'
'voice.mod.deafenedByModerator': 'deafened by a moderator'
'voice.mod.moved': 'Moved to {channel}'
'voice.mod.disconnected': 'Disconnected by a moderator'
'voice.mod.moveMissed': 'A moderator moved you, but your app didn’t follow in time'
'voice.mod.youMuted': 'A moderator muted you. Only a moderator can unmute you.'
'voice.mod.youUnmuted': 'A moderator unmuted you.'
'voice.mod.youDeafened': 'A moderator deafened you. The server stops sending you the call’s sound until a moderator undoes it.'
'voice.mod.youUndeafened': 'A moderator undeafened you.'
'voice.mod.done.moved': 'Moved {name} to {channel}.'
'voice.mod.done.disconnected': 'Disconnected {name}.'
'voice.mod.done.muted': '{name} is server muted.'
'voice.mod.done.unmuted': '{name} is no longer server muted.'
'voice.mod.done.deafened': '{name} is server deafened.'
'voice.mod.done.undeafened': '{name} is no longer server deafened.'
'voice.mod.movedDisconnected': 'Disconnected {name} instead: their app can’t be moved.'
'voice.mod.error.forbidden': 'That isn’t allowed any more: roles or channel permissions changed.'
'voice.mod.error.targetNoAccess': '{name} can’t join {channel}.'
'voice.mod.error.generic': 'That did not work ({code}). Try again.'
'voice.mod.moveFailed': 'You were moved to {channel}, but couldn’t join it.'
'voice.mod.error.gone': '{name} is no longer in voice.'
'voice.mod.error.owner': 'The server owner can’t be moved, muted or disconnected.'
'voice.mod.error.full': '{channel} is full. Nobody was moved.'
'voice.mod.drag.cancelled': 'Move cancelled.'
'voice.mod.drag.afk': 'Nobody can be moved into {channel}.'
'voice.mod.drag.youCannotJoin': 'You can’t join {channel}.'
```

#### U.9.5 `menus.ts`

```
'menu.message.label': 'menu for message from {name}'
'menu.message.react': 'add reaction'
'menu.message.copyText': 'copy text'
'menu.message.copyId': 'copy message ID'
'menu.link.label': 'menu for link'
'menu.link.open': 'open link'
'menu.link.copy': 'copy link'
'menu.attachment.label': 'menu for {name}'
'menu.attachment.open': 'open'
'menu.attachment.copyImage': 'copy image'
'menu.channel.label': 'menu for {name}'
'menu.channel.markRead': 'mark as read'
'menu.channel.invite': 'invite people'
'menu.channel.copyLink': 'copy link'
'menu.channel.mute': 'mute channel'
'menu.channel.notify': 'notifications'
'menu.channel.delete': 'delete channel'
'menu.channel.copyId': 'copy channel ID'
'menu.channel.leaveVoice': 'leave voice'
'menu.category.label': 'menu for category {name}'
'menu.category.collapse': 'collapse category'
'menu.category.collapseAll': 'collapse all categories'
'menu.category.delete': 'delete category'
'menu.category.copyId': 'copy category ID'
'menu.server.label': 'menu for {name}'
'menu.server.invite': 'invite people'
'menu.server.mute': 'mute server'
'menu.server.settings': 'server settings'
'menu.server.leave': 'leave server'
'menu.server.copyId': 'copy server ID'
'menu.dm.label': 'menu for {name}'
'menu.dm.mute': 'mute conversation'
'menu.copied.userId': 'User ID copied.'
'menu.copied.messageId': 'Message ID copied.'
'menu.copied.channelId': 'Channel ID copied.'
'menu.copied.serverId': 'Server ID copied.'
'menu.copied.text': 'Text copied.'
'menu.copied.link': 'Link copied.'
'menu.copied.image': 'Image copied.'
'menu.copy.blocked': 'The browser didn’t allow copying. Nothing was copied.'
'menu.done.markedRead': '{name} marked as read.'
```

`menu.copied.channelId` serves channels, categories and DMs. `menu.copied.serverId` serves servers.

Reused: `shell.message.edit`, `.reply`, `.pin`, `.unpin`, `.delete`, `thread.open`, `media.save`, `admin.channel.open`, `voice.join`, `create.channel.open`, `call.start`, and `notify.channel.default`, `.all`, `.mentions`, `.nothing`.

#### U.9.6 `perm.ts` (changed and new; task T2, pinned by flow 09, M6)

```
'perm.mute.hint': 'Server mute people in voice: the server stops taking their sound until a moderator undoes it.'
'perm.move.hint': 'Move people between voice channels they can join, and disconnect them from voice.'
'perm.deafen': 'deafen members'
'perm.deafen.hint': 'Server deafen people in voice: the server stops sending them the call’s sound. A modified app could still get it.'
```

The permission grid (`PermissionGrid`, `PERM_GROUPS`) picks up `deafen` from client-core's group list. Check that its `perm.${key}` lookups type-check.

#### U.9.7 User doc lines

In `docs/user/voice.md` (task D1). They are not UI strings, so they are not under check:copy, but keep the same plainness:
- *Server deafen asks the server to stop sending someone the call's sound. They stay in the call, and a modified app could still get the sound.*
- *Attachments have no "copy link": nobody outside the conversation could open one.*
- *Nobody can be moved into the AFK channel, because it holds no call.*

---

### U.10 Tests

#### U.10.1 vitest (ui), each file next to its component

**`ActionMenu.test.tsx`** keeps every existing case, and adds:
- `renders a separator as role="separator" and skips it with the arrows`
- `a check item is a menuitemcheckbox with aria-checked; Enter calls onSelect and closes`
- `a keepOpen check item calls onSelect and keeps the menu open with focus on it`
- `a disabled item is aria-disabled, reachable by arrows, and Enter does nothing`
- `typeahead: "k" focuses the next item starting with k, wrapping`
- `pointermove over an item focuses it`
- `ArrowRight on a submenu item opens the child menu on its first item; aria-expanded is true`
- `Enter and Space on a submenu item open it`
- `ArrowLeft in a child menu closes it and focuses the parent item`
- `Escape in a child menu closes only the child; a second Escape closes all and refocuses the trigger`
- `Tab in a child menu closes everything`
- `hover opens a submenu after 150 ms, not before` (fake timers)
- `hovering a sibling closes the open child after 300 ms unless the pointer enters the child`
- `selecting a child item calls onSelect with the child id and closes everything`
- `a child menu flips left when it would overflow the shell` (mockRects)
- `slider: role slider with aria-valuemin/max/now/text; ArrowRight +step, PageUp +5 steps, clamped; Home/End move menu focus`
- `slider: pointer down and move set the value rounded to step`
- `slider: ArrowUp/Down move menu focus off the slider`
- axe in mesh, light and high-contrast with a submenu open and a slider present (the existing `it.each` extended)

**`ContextMenu.test.tsx`**
- `opens at the point, clamped to the shell, and focuses the first item`
- `Escape closes and focuses returnFocus`
- `outside pointerdown, window blur and an ancestor scroll close it`
- `layout sheet renders MenuSheet` (and by default inside `PhoneLayoutProvider value={true}`)
- axe, three themes

**`MenuSheet.test.tsx`**
- `is a modal dialog named by its title; focus starts on the first item`
- `Tab and Shift+Tab stay inside`
- `a submenu item pushes a page titled by it; back pops and focuses the submenu item`
- `Escape on a pushed page goes back; on the root it closes and returns focus`
- `scrim press closes; a press inside does not`
- `check items are role switch with aria-checked`
- `the slider is a native range with aria-valuetext`
- `every item, back and close are at least 44 px` (computed style min-height 2.75rem)
- axe, three themes

**`VoiceChannelRow.test.tsx`** adds:
- `each person is a button with data-menu="person", data-user-id and aria-haspopup="menu"`
- `a click on a person calls onPerson with the id and the button`
- `server muted shows the boxed mic-off named "muted by a moderator" and hides the self-muted glyph`
- `server deafened shows only the boxed headphone-off`
- `mutedForMe shows volume-x named "muted for you"`
- `groupPeople unions serverMuted, serverDeafened, mutedForMe with some()`
- `drop="valid" and "over" set data-drop on the row`

**`ChannelList.test.tsx`** adds:
- `roving: ArrowDown from a voice row reaches its people, then the next channel; one tab stop`
- `rows carry data-menu (channel, dm, voice-channel, category) with their ids`

**`useVoiceDrag.test.tsx`** (new, rendering ChannelList with `voice.drag`):
- `a press and release under 4 px is a click (onPerson), no drag`
- `moving 4 px starts a drag: capture set, ghost shown aria-hidden, valid rows data-drop="valid", invalid rows none`
- `pointerup over a valid row calls onDrop once and swallows the click`
- `pointerup over an invalid row calls onRefuse`
- `pointerup over nothing or the source row calls neither`
- `Escape during a drag calls onCancel and clears every data-drop`
- `lostpointercapture calls onCancel`
- `touch pointerdown never starts a drag`
- `canDrag false: no drag`
- `near the scroller's bottom edge the scroller scrolls` (rAF faked)

**Also:**
- `CallTile.test.tsx`: `voiceStateWords` order and precedence (mutedForMe, server deafen beats server mute beats muted; silentByChoice with server states), and `data-menu` on the li.
- `MemberList.test.tsx`: **replace** the right-click and Shift+F10 card-opening tests with `a row button carries data-menu="person" and data-user-id; the list itself no longer handles contextmenu`.
- `MessageRow.test.tsx`: `data-menu` on the row, author, avatar, user pill and link.
- `CommunityRail.test.tsx`: `data-menu="server"` on server buttons only.
- `UserPanel`, `CallControls`, `CallBar` tests: `held.mute makes mute aria-disabled, pressed, described by the reason`.
- `roving.test.tsx`: `with a selector, nested buttons take part; without one, behaviour is unchanged`.
- `base.test.ts`: `[data-menu]` has `-webkit-touch-callout: none`; phone `user-select: none`.

#### U.10.2 vitest (web)

**Models**: one file per model, one `it` per truth-table row, asserting the exact id list:
- `person-menu.test.ts`: the 18 rows of §U.5.1.3, plus `roleChoices` cases (locked, lacking, everyone excluded, checked from held), `personInputs` with fixtures, and move to exclusions (current, AFK, target can't join, I can't join);
- `message-menu.test.ts`, `channel-menu.test.ts`, `voice-channel-menu.test.ts`, `category-menu.test.ts`, `server-menu.test.ts`, `dm-menu.test.ts`, `link-menu.test.ts`, `attachment-menu.test.ts` (`canCopyImage` false hides copyImage);
- `drop-verdict.test.ts`: each rule in priority order, with `canDrag` for local, owner, away, no bits and move bit.

**`native.test.ts`**:
- `Shift+right-click keeps native`
- `input, textarea, contenteditable and [data-native-menu] keep native`
- `a non-empty selection containing the target keeps native; a collapsed or whitespace-only one does not`
- `no [data-menu] keeps native`
- `Shift+F10 is not the Shift escape hatch`

**`long-press.test.ts`**:
- `fires at 500 ms`
- `a move over 10 px cancels`
- `pointerup before 500 cancels`
- `scroll cancels`
- `swallowsClick is true for 700 ms after a fire`

**`MenuHost.test.tsx`**:
- `a right-click on a registered [data-menu] prevents default and opens one menu at the pointer`
- `the innermost root wins (thread pane over shell)`
- `a second right-click replaces the first menu`
- `Shift+F10 and ContextMenu on a focused [data-menu] open at its corner; the following contextmenu within 500 ms is swallowed`
- `a right-click in the composer textarea is not prevented`
- `a touch pointerdown held 500 ms opens the sheet on a phone and swallows the next click`
- `a touch contextmenu (Android) is prevented and opens nothing by itself`
- `build returning null leaves the event alone`
- `choosing an item calls run(el, id) after the menu closed`

**Surfaces** (render Shell with `FakeClient`, the existing harnesses):
- `Shell.personMenu.test.tsx`:
  - `right-click a member row opens the person menu (not the card); a click still opens the card`
  - `a voice person's menu as owner shows server mute, server deafen, move to, disconnect`
  - `move to › lists only channels both can join`
  - `choosing a channel calls voiceMove and announces "Moved {name} to {channel}."`
  - `a disconnected outcome raises the warn banner with the fallback text`
  - `a 403 refusal raises the banner with voice.mod.error.forbidden, and a 409 E_CALL_FULL with voice.mod.error.full`
  - `mention inserts "@username " into the draft and focuses the composer`
  - `copy user ID writes the clipboard and announces`
  - `kick opens KickFlow and returns focus to the row`
- `Shell.contextMenus.test.tsx`: the channel menu (mark as read → markRead; mute → setSetting; edit → ChannelEditFlow; delete → DeleteChannel), the server icon menu (leave hidden for the owner; leave → LeaveFlow; invite → InviteFlow), category, DM row (1:1 vs group), voice channel (join vs leave voice).
- `Conversation.menu.test.tsx`: the message menu runs the same RowEvents as the toolbar (reply, pin, delete confirm, edit); copy text copies `plainBody`; the link menu opens with noopener; the attachment menu's save calls `openAttachment` and `saveBlob`; copy image hidden without ClipboardItem.
- `ThreadView.menu.test.tsx`: no reply, no pin, no thread in the thread pane's message menu.
- `VoiceView.mod.test.tsx` and `useCall.mod.test.tsx`:
  - `a new call.move.seq switches to move.to with the kept context and shows "Moved to {channel}"; the same seq twice switches once`;
  - `a refused target join after a move shows voice.mod.moveFailed`;
  - `reason 4 says "Disconnected by a moderator", reason 3 says "A moderator moved you, but your app didn’t follow in time", and reason 2 still says afk.elsewhere`;
  - `serverMuted and serverDeafened call session.applyServerVoice({ muted, deafened }) on each change`;
  - `serverMuted holds the mute control and a press announces voice.mod.youMuted`;
  - `transitions announce once`;
  - `the voice.localMute setting calls session.setLocalMute(userId, on)`.
- `MemberRolesFlow.test.tsx` stays green after `roleChoices` and `toggleRole` are extracted.
- `strings.flow18.test.ts` (§U.9).

#### U.10.3 e2e

**Web suite** (`e2e/playwright.web.config.ts`). Add `person-menu`, `context-menus` and `phone-menu` to the **webkit `testMatch`** regex.

`e2e/web/person-menu.spec.ts`, on chromium, firefox and webkit:
1. From an empty host, ada signs up, creates a server, and björn joins by invite (`support/app.ts` helpers).
2. Ada right-clicks björn's member row: a `role="menu"` named `menu for björn` with the items in order, profile → … → copy user ID (asserting `getAllByRole('menuitem…')` labels).
3. Escape: the menu is gone and focus is on björn's row.
4. Shift+F10 on björn's row opens it again at the row. ArrowDown to `roles`, ArrowRight: the child menu shows; tick a role; the member list moves björn under that hoisted role.
5. `runAxe` with the menu and the child menu open: no serious or critical findings.
6. Copy user ID: on chromium, read the clipboard (permission granted) and expect björn's id; on all three, expect the announcer text `User ID copied.`.
7. Native fallback:
   - add a page-level listener recording `defaultPrevented` of the next `contextmenu`;
   - right-click in the composer → `false`;
   - Shift+right-click on björn's row → `false`;
   - right-click on empty sidebar space → `false`;
   - right-click on björn's row → `true`;
   - select a message's text and right-click inside the selection → `false`.

`e2e/web/context-menus.spec.ts`, on chromium, firefox and webkit:
1. Message menu on björn's message as ada: reply puts the reply chip in the composer; pin → the pins count; copy text → announcer.
2. Own message: edit opens the editor; delete opens the confirm.
3. Channel menu on `#loot`: mute channel → the row reads muted; mark as read is disabled at zero.
4. Server icon menu: invite people opens the invite dialog with a link; as björn, leave server opens the confirm (cancel it).
5. A link in a message: copy link → announcer.
6. An image attachment: save → a download event; open → the lightbox.
7. `runAxe` with the message menu open.

`e2e/web/phone-menu.spec.ts`, at 390×844 `isMobile hasTouch` (`phone.spec.ts`'s `PHONE` and `phoneContext`), on chromium, firefox and webkit:
1. Long-press björn's member row: `dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, clientX, clientY })`, wait 600 ms, `dispatchEvent('pointerup', …)`. A `role="dialog"` titled `björn` appears, and the row's profile card did **not** open.
2. Every `.d-menu-sheet__item`, back and close has a bounding box height ≥ 44.
3. Tap roles: a page titled `roles`; back focuses the roles item.
4. Escape closes the sheet and focus returns to the row.
5. Long-press a message: the message sheet; copy text.
6. `runAxe` with the sheet open, and on the pushed page.
7. No drag: a touch move over a voice person scrolls and starts no ghost.

**Voice suite** (`e2e/playwright.voice.config.ts`, chromium-voice and firefox-voice). `e2e/voice/voice-moderation.spec.ts`, with three `VoicePeer`s (ada as owner, björn, mira) and voice channels `harbour` and `general` (`support/voice.ts`):
1. **Drag move.** All three join `harbour`. Ada drags björn's row onto `general` with `page.mouse` down, then 10 moves, then up:
   - during the drag `general` has `data-drop="valid"` and the AFK row has no `data-drop`;
   - after the drop, björn's stage notice reads `Moved to general`, björn's `phaseOf` is connected, and he is listed under `general` on all three pages;
   - ada's announcer says `Moved björn to general.`
2. **Escape cancels.** Start a drag, press Escape: no move, and the announcer says `Move cancelled.`
3. **Invalid drop.** Make channel `vault` private to ada's role. Dragging björn onto `vault` gives no highlight, the drop announces `björn can’t join vault.`, and björn stays.
4. **Keyboard move to.** Focus björn's row in the channel list (Tab to the list, arrows), Shift+F10, `move to`, ArrowRight, Enter on `harbour`: björn lands in `harbour`.
5. **Server mute enforced by the SFU.** Ada server-mutes björn:
   - björn's mute control is `aria-disabled` and his announcer says `A moderator muted you. Only a moderator can unmute you.`;
   - mira's audio analysis of björn reads silence while björn's fake mic plays the tone (the same probe `speaking.spec.ts` and `audio.spec.ts` use);
   - björn's row shows the boxed glyph named `muted by a moderator` on all pages;
   - unmute brings the tone back.
6. **Server deafen.** Ada deafens mira: mira's tile shows `deafened by a moderator`, and mira's received-audio probe reads silence from björn. Undeafen.
7. **Disconnect.** Ada disconnects björn: björn's notice reads `Disconnected by a moderator`, and ada's announcer says `Disconnected björn.`
8. **Self drag.** Ada drags herself to `general`: ada is in `general` through the normal join.
9. `axeEverywhere(page, 'voice-mod-menu')` with ada's person menu open on a voice row.

**Old-client fallback** isn't e2e-able with one build. It is covered by the web vitest (banner) and the server and client-core tests.

#### U.10.4 Screenshots (`e2e/scripts/shoot-docs.mjs`, a new `VOICEMOD_SHOTS` block after 4d)

New:
- `person-menu-desktop.png`: ada right-clicks björn under "harbour";
- `person-menu-moveto-desktop.png`: the move to child menu open;
- `voice-drag-desktop.png`: mid-drag, ghost and a valid target, taken with the mouse held;
- `voice-server-muted-desktop.png`: björn's boxed glyph on the row and tile;
- `person-sheet-phone.png`: 390×844 long-press sheet;
- `message-menu-desktop.png`;
- `channel-menu-desktop.png`;
- `server-menu-desktop.png`.

Re-shoot, because the voice person rows are now buttons and their focus/hover look may shift: `afk-call-desktop.png`, `dock-desktop.png`, `categories-desktop.png`, `phone-callbar.png`, `members-desktop.png`.

### U.12 Sketches

Mesh: mono, hairlines, the accent as a 1 px rule, no fills except focus.

**Desktop person menu**, right-click on björn under "harbour", viewer = owner, in the same call:

```
 ┌ harbour · 3 ──────────────────┐
 │  ▣ ada                        │
 │  ▣ björn            🎤̸  ◄── right-click here
 │  ▣ mira                       │  ┌──────────────────────────────┐
 └───────────────────────────────┘  │ profile                      │
                                    │ mention                      │
                                    │ message                      │
                                    │ compare safety numbers       │
                                    │ ──────────────────────────── │
                                    │ mute for me              [ ] │
                                    │ volume                       │
                                    │ ━━━━━━━━━━━●──┊──────  120 % │
                                    │ ──────────────────────────── │
                                    │ server mute              [x] │
                                    │ server deafen            [ ] │
                                    │▌move to                    › │  ← focused (surface-2)
                                    │ disconnect                   │  (danger)
                                    │ ──────────────────────────── │
                                    │ roles                      › │
                                    │ ──────────────────────────── │
                                    │ kick                         │  (danger)
                                    │ ban                          │  (danger)
                                    │ ──────────────────────────── │
                                    │ copy user ID                 │
                                    └──────────────────────────────┘
```

**Submenu**, move to open on ArrowRight (focus on its first entry):

```
 ┌──────────────────────────────┐
 │ …                            │
 │ server deafen            [ ] │
 │ move to                    › │┌────────────────────┐
 │ disconnect                   ││▌general            │  ← focus
 │ …                            ││ lounge             │
 └──────────────────────────────┘│ war room           │
                                 └────────────────────┘
   ← / Esc closes the child and returns focus to "move to"
```

**Phone sheet**, 390 px, long-press on björn, then the pushed "move to" page:

```
┌──────────────────────────────────────┐      ┌──────────────────────────────────────┐
│ (scrim 60 %)                         │      │ (scrim 60 %)                         │
│                                      │      │                                      │
├──────────────────────────────────────┤      ├──────────────────────────────────────┤
│ björn                            [×] │      │ [‹]  move to                     [×] │
├──────────────────────────────────────┤      ├──────────────────────────────────────┤
│ profile                              │ 44   │ general                              │ 44
│ mention                              │      │ lounge                               │
│ message                              │      │ war room                             │
│ compare safety numbers               │      │                                      │
│ ──────────────────────────────────── │      │                                      │
│ mute for me                    (○  ) │      │                                      │
│ volume  ━━━━━━━━━━●──────────  120 % │      │                                      │
│ ──────────────────────────────────── │      │                                      │
│ server mute                    (  ●) │      │                                      │
│ server deafen                  (○  ) │      │                                      │
│ move to                            › │      │                                      │
│ disconnect                           │      │                                      │
│ ──────────────────────────────────── │      │                                      │
│ roles                              › │      │                                      │
│ kick                                 │      │                                      │
│ ban                                  │      │                                      │
│ copy user ID                         │      │                                      │
└──────────── safe-area inset ─────────┘      └──────────────────────────────────────┘
```

**Drag state**, ada drags björn; `general` is valid (dashed), `lounge` is under the pointer (filled), `vault` is invalid (no change), AFK is never a target:

```
 ┌ channels ─────────────────────────┐
 │ # loot                            │
 │ 🔊 harbour · 3                    │
 │   ▣ ada                           │
 │   ▣ björn            (dimmed, source)
 │   ▣ mira                          │
 │┄🔊 general┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄│  ← data-drop="valid": 1 px dashed accent
 │▌🔊 lounge ░░░░░░░░░░░░░░░░░░░░░░░░│  ← data-drop="over": accent-soft + 2 px accent rule
 │       ┌──────────────┐            │
 │       │ ▣ björn      │ ← ghost (surface-hi, 1 px accent, shadow-2), pointer +12,+12
 │       └──────────────┘            │
 │ 🔊 vault                          │  ← invalid: unchanged
 │ 💤 AFK                            │  ← never a target
 └───────────────────────────────────┘
   Esc → "Move cancelled."   drop on vault → "björn can’t join vault."
```
