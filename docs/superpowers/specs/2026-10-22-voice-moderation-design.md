# Voice moderation and the person menu: design

Date: 2026-10-22. Roadmap item: W7 "Voice moderation" (docs/superpowers/specs/2026-10-14-discord-parity-roadmap.md:135), without timeout and soundboard.

## Intent

Jonas wants dilla to manage people in voice the way Discord does. Someone with the right rights:
- drags a person from one voice channel onto another to move them;
- right-clicks any person to get Discord's menu.

His words: "move people between voice channels by dragging", "just like discord, if you have the admin rights to do so", "the same custom right-click function as discord", all of Discord's items ("All."), and "Do it as discord" for where the menu appears.

The rule for every open choice: **do what Discord does**. Deviate only where dilla's end-to-end encryption makes Discord's behaviour impossible or dishonest. Where it does, say so in the UI copy and the docs, never silently.

## Goals

1. **Drag to move.** Drag a person under a voice channel in the channel list onto another voice channel, and they are moved.
   - The moved person gets no prompt. Their app leaves the old call and joins the new one by itself, then shows a short notice.
   - You can drag yourself to switch channel. That only needs the normal right to connect to the target.
2. **The person menu.** Right-click any person, anywhere one appears, to open a context menu. On a phone a long-press opens it as a bottom sheet. "Anywhere" means:
   - people under voice channels in the channel list;
   - the member list;
   - message authors (name and avatar);
   - mentions;
   - DM list rows;
   - the participant tiles on the call screen.
3. **Menu items, in Discord's order and groups.** Each item is shown only when it applies.
   - Profile, Mention, Message.
   - "Mute for me" and the Volume slider, shown only while you are in a call with them. Both exist today in part as per-user volume. They are local, never sent to anyone.
   - Server Mute and Server Deafen, as checkable items.
   - Move To ›, a submenu of the voice channels they may be moved into.
   - Disconnect.
   - Roles ›, a submenu of checkable roles.
   - Kick and Ban, which already exist.
   - Copy User ID.
   - Compare safety numbers stays. It is dilla's E2EE trust action and exists in today's member menu. It sits right after Message. *My call.*
   - On your own row, the menu shows what Discord shows for yourself. It has no moderation items, except Server Mute/Deafen and Move/Disconnect when you hold those rights. The server owner's row never shows moderation items to anyone else.
4. **Server mute and server deafen.** These are state on the community member, like Discord's.
   - They stay across channels and calls until a moderator undoes them.
   - The person sees that a moderator muted or deafened them and can't undo it themselves.
5. **Indicators.** Server-muted and server-deafened people get their own icons on voice rows and call tiles, distinct from self-mute and self-deafen, as in Discord.
6. **Audit log.** Every move, disconnect, server mute/unmute and server deafen/undeafen is written to the audit log, with who did it, to whom, and from and to where.

## Non-goals

These are not in this version:
- timeout;
- soundboard;
- channel user limits;
- stage channels;
- priority speaker;
- notes on users;
- nickname changes from the menu (manageNicknames exists but is not wired);
- reordering channels by drag (it stays move up/down).

## Anti-goals (failure even if it works)

- **The server decides what a client joins only within the client's own rights.**
  - A move never puts anyone into a channel's encrypted group they could not join themselves: they must have view and connect on the target.
  - The moved client joins through its normal join path, with the normal checks.
  - Media is never unencrypted, and keys are never handed out by the server.
- **No claim stronger than the truth.**
  - Server deafen asks the SFU to stop forwarding audio to the person. They remain a member of the call's MLS group and hold its key, and a modified client could resubscribe. The docs (protocol/08 threat model) must say so, and the copy must not claim they can't hear.
  - Server mute is enforced by the SFU refusing their audio through the publish grant. Their own client can't undo it.
- **No drag-only paths.** Everything a drag does is reachable by keyboard and screen reader through the menu (Move To ›). The menu opens with Shift+F10 and the ContextMenu key on a focused person, as the member list already does. This keeps the WCAG bar of the existing UI.
- **No silent fallbacks.** A move to an older client that can't follow it shows the mover what happened, for example "disconnected instead: their app can't be moved". A refused move is never treated as done.

## What exists (recon of main, 2026-10-22)

- **Rights:** `PermMuteMembers` (bit 21) and `PermMoveMembers` (bit 22) are defined in Go (`internal/api/perm.go:24-47`) and TS (`packages/client-core/src/admin/perm.ts`), but nothing checks them yet. Both are channel-overridable. No deafen bit exists.
- **Rank:** kick and ban use a rank check (`canModerate` in `packages/web/src/screens/admin/members-model.ts`, mirrored on the server).
- **No server-pushed move exists.** The AFK move only removes the participant from the LiveKit room and records a pending reason the client reads afterwards (`internal/api/afk.go` ~700-770, `removeDevice` in `internal/api/callgrants.go`). On the client: `useCall.tsx` `sayRemoved`; join and leave go through `client-core/src/calls/controller.ts` `join()` / `leave()`.
- **Publish rights** come from `grantFor` (`internal/api/calls.go:1106`). They can be changed mid-call through `UpdatePermission` (`internal/api/callgrants.go:315`).
  - A comment at `callevents.go:671` notes that `MutePublishedTrack` is useless because a client can unmute itself. Server mute must therefore use grants.
- **Menus:** `packages/ui/src/ActionMenu` is a WAI-ARIA menu with right-click positioning (`at={x,y}`). It has no submenus, no slider item and no phone sheet.
  - The member list's right-click and Shift+F10 open the profile card, not a menu (`MemberList.tsx:76-107`).
  - Voice participant rows (`VoiceChannelRow.tsx:93`) are not interactive. The channel list uses one tab stop with roving focus over `[data-row]`.
- **Drag:** none in the app. `AppShell/Splitter.tsx` has the pointer-capture pattern.
- **Person actions:** `members-model.ts` `MenuAction` = message, compare, roles, kick, ban. Per-user local volume is in `settings.ts` (`voiceVolume(userId)`) and `VoiceView.tsx`.
- **Gateway:** voice ops 50, 52, 53 and 55 are taken.
- **Capability bits:** clients send them in identify. The calls-survive-upgrade branch adds bit 0 and migration 00024.

## Decided

These are decisions by Jonas, or calls made under "do it as Discord".

1. **Moves take no consent** (Jonas). The moved person's app switches by itself and shows "Moved to #channel". Following Discord, the notice doesn't name the mover; the audit log does.
2. **All of Discord's items** listed in goal 3 (Jonas).
3. **Menu everywhere, long-press sheet on phone** (Jonas: "do it as discord").
4. **Rights** follow Discord.
   - **Move Members** allows Move To, drag, and Disconnect.
   - **Mute Members** allows Server Mute.
   - **A new Deafen Members bit (24)** allows Server Deafen. It must be added in Go and TS together, with the perm vectors updated, and channel-overridable like 21 and 22. Bits are never renumbered.
   - Moving needs Move Members on the source channel, and view plus connect on the target for the mover.
   - The moved person needs view and connect on the target. A channel they can't join is not offered in Move To and is refused as a drop target.
5. **Rank (Jonas, 2026-10-22: "Like Discord"):** voice actions have no rank check. Anyone holding the right can mute, deafen, move or disconnect anyone in voice, including themselves, but **never the server owner**. Kick, ban and roles keep today's rank check unchanged.
6. **Server mute and deafen are community-member state.** They are stored server-side (a migration, see Constraints), applied on every call join, and applied live to every room the person is in.
   - **Authorization, as in Discord:** the right is checked on the voice channel the person is currently in, and the action is offered only while they are connected to voice. The state persists after they leave, so a muted person rejoins muted. Undoing it also needs them in voice, where a moderator with the right can unmute them, as in Discord.
   - **Mute** withdraws the publish grant for all audio: the microphone **and screen-share audio** (`PublishGrant` in `internal/sfu/grants.go` couples screen-share audio with screen share). Otherwise a muted person could talk through system audio. Video and screen-share video are unaffected. *My call: closing the bypass.*
   - **Deafen (Jonas: "Audio only, like Discord"):** the deafened person stops receiving audio but still sees camera and screen share.
     - LiveKit's subscribe grant is all-or-nothing, so deafen is done by the server unsubscribing that participant from every audio track, and re-applying it whenever a new audio track appears or the participant subscribes again.
     - **Honest limit:** a modified client could resubscribe between the server's re-applications. The UI copy says "deafened by a moderator" and never claims they *can't* hear. protocol/08 states the limit.
     - Deafen also implies mute, as in Discord.
7. **A move is a new server-to-client signal.** The server tells the person's devices in the source call to move to the target channel. Each device leaves its current call and joins the target through its normal join.
   - The server marks it as a move, so the client shows "Moved to …" rather than "removed".
   - If a device hasn't left the source room within a bound (about 10 s), the server removes it from the room, so the move is enforced like a disconnect.
   - Clients that don't advertise a "can be moved" capability bit are disconnected instead, and the mover is told.
8. **Disconnect** removes all of the person's devices from that call, as the AFK sweep does today, with a reason the client shows as "Disconnected by a moderator".
9. **Copy User ID is always shown.** dilla has no developer mode, and the ID is harmless. *My call.*
10. **Dragging yourself switches your own channel** with only the normal connect right, as in Discord.

## Constraints

- **Base and numbering (my call):**
  - Build on main; don't wait for the calls-survive-upgrade branch.
  - Use the next free migration and capability-bit numbers at merge time: today that is 00024 and bit 0 on main. If calls-survive-upgrade (which also takes 00024 and bit 0) merges first, renumber on rebase to the next free ones. The schema test must expect whatever is next.
  - Both engines (sqlite and Postgres), with sqlc, a contract test and the schema dump.
- **Releases:** state the schema bump and the rollback (`migrate down`) in the release notes, with every operator-visible change and new copy strings quoted.
- **Protocol docs:**
  - protocol/09: the new routes and gateway op;
  - protocol/08: the honest deafen limit and "a move only within your own rights";
  - protocol/07: the versioning row.
- **Copy:** sentence case, plain words, the strings rules and check:copy. All new strings go under a `voice.mod.` / `person.menu.` prefix.
- **Gates:**
  - Go race tests on both engines;
  - client-core and web vitest;
  - lint, typecheck, check:copy and check:docs;
  - e2e on chromium, firefox and webkit for drag, menu, phone long-press, keyboard Move To, server mute enforced by the SFU (a muted person's audio doesn't reach a listener), and a move landing in the target call;
  - axe on the menu and the sheet.
- **Reviews:** opus reviews authz (rights, rank, overrides), the move signal and enforcement, and the grant changes.
- **Docs:** user docs (docs/user) and the README's "what works" are updated, with screenshots re-shot.

## Left to the builder

- The exact route shapes and gateway op number (next free), following protocol/09 conventions.
- How ActionMenu grows submenus, a slider item and a phone sheet. Extend it or wrap it, keeping its keyboard model. Submenus open on hover, Right Arrow and Enter, as in WAI-ARIA menus.
- How the drag works: pointer events with pointer capture, like Splitter, not HTML5 DnD, so it works the same on touch.
  - Valid drop targets highlight during the drag, invalid ones don't.
  - Escape cancels.
  - A drop on an invalid target does nothing and announces why.
- The exact copy, within the meaning above. The strings are Jonas-reviewable in the release notes.
- How "Mention" inserts into the composer of the current conversation, and what it does when there is none (Discord opens nothing).
- Task split and order, with the server route and migration first.
