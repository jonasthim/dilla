# dilla: Discord feature-parity gap inventory (origin/main, web-3.3, 2026-10-14)

All evidence is `git show origin/main:<path>` line numbers. Abbreviations:
- `routes.ts` = packages/client-core/src/http/routes.ts
- `protocol.ts` = packages/client-core/src/worker/protocol.ts, the complete list of commands the page can send the worker. A server feature with no command here has no client.
- `en.ts` = packages/web/src/strings/en.ts, every string the UI shows.
- `spec` = docs/superpowers/specs/2026-09-23-dilla-design.md
- `gs` = docs/user/getting-started.md

Status values: HAVE, SERVER-ONLY, PARTIAL, MISSING, OOS (out of scope by design). Effort: S, M, L, XL. "—" means already done.

Cross-cutting facts that explain many rows:
1. **The server serves no role definitions, role bits or overwrites.** There is no `GET` route for roles or overwrites: `ListRoles` and `ListOverwrites` are only called inside perm.go:200,220 and private.go:30,38. So the client's only permission fact is ownership (client-core/src/state/types.ts:27-28; Shell.tsx:704-706). Any role or permission UI first needs read routes.
2. **`PATCH /v1/accounts/me` answers 501.** internal/api/accounts.go:264-297: "profile updates need a store method". Display name and status message cannot be changed even through the API.
3. **Server-readable channels are SERVER-ONLY.** They have server search, read-state, slow mode and pin-permission checks (readable.go:68-76, 190, 249-252). The web client shows "Channels this server can read arrive in a later version" (en.ts:160).
4. **In end-to-end encrypted channels the server only gates `view_channel`, which is MLS membership** (dsacl.go:45-46). `send_messages`, slow mode, `pin_messages` and `mention_everyone` are not enforced there (messages.go has none of them). Pins and @everyone are left to the client, unchecked (README:52; protocol/07 Q20).

## Servers

| Item | Status | Evidence | Effort | E2EE note |
|---|---|---|---|---|
| Create | HAVE | protocol.ts:13; Create.tsx; README:25 | — | Makes the MLS groups for its text and voice channels |
| Rename | SERVER-ONLY | communities.go:84,250-269 (PATCH name, ManageCommunity); not in routes.ts; gs:723 | S | Name is plaintext metadata the server sees |
| Icon or banner | MISSING | patchCommunityReq has no image field (communities.go:242-249); ui Avatar is initials only | M | Can be plaintext metadata, or an encrypted blob that only members can open |
| Delete | SERVER-ONLY | communities.go:85,762 (owner only) | S | — |
| Leave | SERVER-ONLY | communities.go:89,730 | S | Leaving removes every device of the user from every group by MLS commit |
| Transfer ownership | MISSING | communities.go:736-738 tells the owner to "transfer ownership or delete", but no route exists | M | Signed ownership grants are later work (spec:681) |
| Server settings screen | MISSING | Settings nav has only privacy, keyboard, diagnostics, devices, notifications, appearance and voice (en.ts:6-8,229-232,479); no server-settings strings | L | — |
| Invites: create | PARTIAL | Fixed at 10 uses and 7 days (Create.tsx:380,412); the server takes any values (routes.ts:249-253) | S | — |
| Invites: expiry, max uses, revoke, list | SERVER-ONLY | invites.go:229-231 (POST, GET, DELETE) | S | — |
| Vanity invite | MISSING | Listed as a census gap (spec:244) | S | Joining by an open invite makes the channel server-readable by policy (spec:102-103) |

## Channels

| Item | Status | Evidence | Effort | E2EE note |
|---|---|---|---|---|
| Text | HAVE | protocol.ts:14; README:25 | — | MLS text group per channel |
| Voice | HAVE | protocol.ts:61-69; voice.md | — | Always end to end encrypted with SFrame, even in readable channels (spec:118) |
| Categories | PARTIAL | Server has kind 2 (channels.go:24,454-472); the client renders them (shell-model.ts:17-23) but can only create text or voice (en.ts:532-534) | S | — |
| Reorder | SERVER-ONLY | PATCH position (channels.go:129); Mesh drag-reorder (spec:266) | M | — |
| Topic | PARTIAL | Shown in the header (Shell.tsx:774); can only be set through the API (channels.go:561); gs:722 | S | Topic is plaintext metadata |
| Rename or delete channel | SERVER-ONLY | channels.go:129-130; gs:722 | S | Deleting closes the channel's groups |
| Slow mode | PARTIAL | Stored and validated (channels.go:44,451); enforced only on readable channels (readable.go:249-252), not on E2EE posts (messages.go); no UI | M | The server can enforce it from ciphertext timing (spec:242) but does not yet |
| Private channels and overwrites UI | SERVER-ONLY | roles.go:94-95; channels.go:137-139; private.go; no route to read overwrites | L | An overwrite change becomes MLS Add or Remove commits; private channels are separate groups |
| Threads | SERVER-ONLY | Envelope `thread_id` (protocol/04:13; core envelope/mod.rs:122); spec:222; README:52 | L | Public threads live in the parent group; private threads need their own MLS groups (spec:675) |
| Forum channels | OOS | spec:683 (Phase 2): "threads/forums beyond envelope-level threading" | XL | Restricted forum posts would be their own groups |
| Announcement channels | MISSING | spec:225: "Inbound webhooks and channel following: server-readable channels only at v1" | M | Following across E2EE channels would need an integration device that is a visible member |
| Stage channels | OOS | spec:683: "Stage-scale audiences remain out of scope." | — | — |
| NSFW flag | MISSING | Census gap "age-restricted channel flag" (spec:243) | S | Any blur must be an on-device filter (spec:218-221) |

## Roles and permissions

| Item | Status | Evidence | Effort | E2EE note |
|---|---|---|---|---|
| Create, edit, delete roles | SERVER-ONLY | roles.go:89-91; no route lists roles (see fact 1) | L (with a read route) | Roles are server-held policy; the client gets no snapshot |
| Colours | SERVER-ONLY | roles.go:25,205,223 | S | — |
| Hoist | SERVER-ONLY | roles.go:227,403 | S (needs a member list) | — |
| Mentionable | SERVER-ONLY | roles.go:228,411; the composer cannot mention a role | S | Who may mention is not checked in E2EE groups |
| Permission editor | SERVER-ONLY | 24 permission bits (perm.go:23-46) | L | Bits that touch content (pin, mention everyone, manage messages) cannot be enforced on ciphertext; they need client-side folds or signed moderation events |
| Role assignment UI | SERVER-ONLY | roles.go:92-93 | M | Membership changes from roles turn into MLS commits through private.go |
| Client knows its own permissions | PARTIAL | Knows ownership only (state/types.ts:27-28; Shell.tsx:704-706); member rows carry role ids (routes.ts:36) but no bits | M | Needed for the client-side checks the protocol leaves to clients (protocol/07 Q20) |

## Members

| Item | Status | Evidence | Effort | E2EE note |
|---|---|---|---|---|
| Member list sidebar | MISSING | Member lists are loaded for mentions and DMs (Shell.tsx:151-152) but not shown; Mesh member list (spec:272) | M | Planned as a tree-derived list with badges (spec:661) |
| Presence (online, idle, dnd, invisible) | MISSING | Gateway op 48 is reserved (frame.go:53); `SetPresence` (presence.go:189) is never called; there is no client op to set it; README:53 | M | Presence is server-visible metadata (spec:548) |
| Custom status | MISSING | `status_msg` in PatchMe returns 501 (accounts.go:264-297) | S (after the store method) | Plaintext metadata |
| Profile: avatar | MISSING | No field anywhere; ui Avatar shows initials | M | Could be an encrypted blob shared through groups, or plaintext |
| Profile: display name | PARTIAL | Set at sign-up only (accounts.go:102); PATCH returns 501 | S | — |
| Profile: bio, pronouns | MISSING | Census gap (spec:245) | M | — |
| Per-server nicknames | MISSING | `nick` column and normaliser (communities.go:887-897; routes.ts:36) but no route sets it; ManageNicknames (perm.go:46) is unused | S | — |
| User popout | MISSING | No component or strings | M | Natural place for safety number and verification state |

## Moderation

| Item | Status | Evidence | Effort | E2EE note |
|---|---|---|---|---|
| Kick | SERVER-ONLY | communities.go:87,675; gs:770 (screenshots use `/debug/kick`) | S | Kick becomes MLS Removes from every group and cuts live calls |
| Ban | SERVER-ONLY | bans.go:44,63 | S | Same Removes; the ban gates rejoining |
| Unban and ban list | SERVER-ONLY | bans.go:45-46,159,192 | S | — |
| Timeout | MISSING | No route or field | M | Could withdraw send rights only on the server for readable channels; in E2EE it needs SFU grant withdrawal plus client honour |
| Audit log UI | SERVER-ONLY | Instance-admin only (admin.go:66,220-222); no per-server audit route | M | Server sees ciphertext operations only; planned "client-signed moderation events" (spec:223-224) |
| AutoMod | MISSING | spec:470 (metadata AutoMod for readable channels); spec:46-49 | L | Content AutoMod is impossible on E2EE text by design; on-device filters only (spec:218-221) |
| Reports | SERVER-ONLY | reports.go:94-96 (franked reports, admin queue); spec:401 "report UI later" | M | Franking lets a reporter reveal one message verifiably |
| Moderator delete of others' messages | MISSING | gs:497-498 "no moderator delete"; blobs.go:547 "follow-up card 2" | M | Needs a signed moderation event the clients fold; the server can only tombstone ciphertext |
| Server mute or deafen in voice | MISSING | MuteMembers (perm.go:44) is never used | M | Enforceable: the server mints SFU publish grants (callgrants.go:307) |
| Move or disconnect from voice | MISSING | MoveMembers (perm.go:45) is never used; only a kick or ban cuts calls | M | A move is a call-group join, which needs the member's own device |

## Messaging

| Item | Status | Evidence | Effort | E2EE note |
|---|---|---|---|---|
| Markdown | MISSING | Envelope body is "markdown" (protocol/04:15), rendered as plain text; README:52 | M | Rendered on the client only |
| Replies | HAVE | protocol.ts:23 replyTo; en.ts:299-303 | — | — |
| Edit | HAVE | protocol.ts:40; only the latest version is shown (gs:487) | — | Edit is envelope type 1 in the group |
| Delete | HAVE | protocol.ts:41; author only (gs:497) | — | Copies others saved stay with them |
| Reactions | PARTIAL | Fixed set of 32 (en.ts:312-344); no full emoji picker or emoji in text (gs:727) | S | — |
| Custom server emoji | OOS | spec:683 (Phase 2): "custom emoji/stickers" | L | Needs encrypted asset distribution |
| Stickers | OOS | spec:683 | L | Same |
| GIFs | PARTIAL | GIF files upload as image attachments; no GIF picker | M | No remote loads in E2EE channels (spec:216); a picker must download and re-host as an encrypted attachment |
| Attachments | HAVE | protocol.ts:46-48; 25 MB (README:25) | — | Encrypted per file; thumbnails made by the sender |
| Link previews or embeds | SERVER-ONLY | Envelope `previews` (protocol/04:19,71; envelope/mod.rs:107); "Received link previews are not shown" (gs:729) | M | Sender generates; receivers must never fetch (protocol/04:71); the sender's fetch reveals their IP |
| Mention @user | HAVE | gs:532-541; en.ts:356 | — | — |
| Mention @everyone and @here | PARTIAL | Works, but no permission check (README:52); @here equals @everyone because there is no presence (gs:539) | S | The permission check must be client-side |
| Mention @role | PARTIAL | Received role mentions show as "@role" (en.ts:311); none can be composed and role names are not known | S (after role read route) | — |
| Pins | HAVE | protocol.ts:43-45; anyone can pin (README:52) | — | Pin is envelope type 5/6 folded by clients |
| Search | HAVE | protocol.ts:55-56; Search.tsx; local only, no files, keyboard only (gs:733-734) | — | Search runs only on what this browser holds; server FTS exists only for readable channels (readable.go:75) |
| Typing indicators | HAVE | protocol.ts:57; en.ts:36-37; gateway presence.go | — | Metadata the server sees |
| Unread markers and read states | HAVE | protocol.ts:37 markRead; gs:441-447 | — | Cursors are server-visible |
| Jump to message | HAVE | en.ts:302,363; Search pick | — | — |
| Spoilers | MISSING | No syntax or renderer | S | — |
| Code blocks | MISSING | Comes with markdown | S | — |
| Polls | MISSING | No envelope type (types 0-6, protocol/04) | M | Votes as envelopes; the tally is on each client |
| Forwarding | MISSING | protocol/09:576-587 expects a re-encrypt and re-upload; no client | M | Each forward re-encrypts the files under a new key |
| History for members who join later | OOS (v1) | spec:681 (Phase 2): "MSC4268-style inviter history sharing"; gs:101,741 | XL | This is the biggest E2EE change compared with Discord: MLS forward secrecy means a new member or new browser sees nothing older than its join |

## DMs and social

| Item | Status | Evidence | Effort | E2EE note |
|---|---|---|---|---|
| 1:1 DMs | HAVE | protocol.ts:39; gs:451-456 | — | Always E2EE (dms.go:84-85) |
| Group DMs | PARTIAL | Server supports them (dms.go:136-151); the client shows them and rings for calls (routes.ts:391-393; README:25) but `openDm` sends one user (controller.ts:1617-1618); no add or remove | M | Changing membership is an MLS commit |
| Friend list and requests | MISSING | DMs need a shared server (gs:455-456) | M | — |
| Blocking users | MISSING | voice.md:253 | M | Can only be a client-side filter plus leaving shared DMs; the server cannot filter ciphertext |

## Voice and video

| Item | Status | Evidence | Effort | E2EE note |
|---|---|---|---|---|
| Voice channels | HAVE | voice.md; README:25 | — | SFrame keys come from the MLS call group |
| Camera | HAVE | VoiceView.tsx:207-211; voice.md:112 | — | — |
| Screen share with audio | PARTIAL | Sound only from a Chromium tab (voice.md:115-117); app audio is a v1 must-have through Electron (spec:112,176) | L | — |
| Push to talk | PARTIAL | Works only while the tab is active (voice.md:92-93); a global key needs Electron (spec:516) | M | — |
| Noise suppression | HAVE | voice.md:104; RNNoise (spec:502) | — | — |
| Per-user volume | HAVE | VoiceView.tsx:32-35,70; voice.md:36 | — | — |
| Deafen | HAVE | en.ts:412; keyboard en.ts:499 | — | — |
| Soundboard | MISSING | spec:675 (before first public release) | M | Planned as an encrypted shared asset played on each client |
| Voice activity indicator | HAVE | VoiceView.tsx:344-347; en.ts:418 | — | Uses RFC 6464 audio levels, which travel unencrypted (spec:494) |
| Video grid | HAVE | Tiles (VoiceView.tsx:42-72; en.ts:437) | — | — |
| Stage | OOS | spec:683 | — | — |

Safari has no voice (voice.md:249). Calls cap at 25 voice and 10 publishers (spec:494).

## Notifications

| Item | Status | Evidence | Effort | E2EE note |
|---|---|---|---|---|
| Per-server settings | PARTIAL | Global default plus per channel only (Notifications.tsx:13-14,101); nothing per server | S | — |
| Per-channel settings | HAVE | en.ts:274-279; gs:461-463 | — | Settings are per browser (README:60) |
| Mentions | HAVE | gs:536-541 | — | Mention detection runs on the client after decryption |
| Desktop notifications | PARTIAL | Need an open tab (README:53) | M | Background delivery needs push that carries no content |
| Mobile push | OOS (v1) | spec:683 "Web Push for browsers"; spec:109 "Mobile is phase 2" | XL | Content-blind relay or UnifiedPush (spec:106) |
| Mute | HAVE | en.ts:280-281; DM mute (voice.md:141) | — | — |
| Unread badges | HAVE | gs:441-447 | — | — |

## Clients

| Item | Status | Evidence | Effort | E2EE note |
|---|---|---|---|---|
| Web | HAVE | README:25 | — | A labelled lower-trust tier: code served by the operator (spec:104-105) |
| Desktop (Electron) | MISSING | In v1 scope (spec:516,710); README:66 | XL | Holds SSK on a native device and pins its own code |
| Mobile apps | OOS (v1) | spec:109: "Mobile is phase 2." | XL | LiveKit native frame-transform blocker (spec:679) |
| PWA or installable | MISSING | No manifest or service worker in packages/web (index.html) | S | — |
| Offline | PARTIAL | OPFS store (spec:445), offline banner (en.ts:188); no service worker, so the app shell needs the server | M | Local store holds the plaintext |

## Account

| Item | Status | Evidence | Effort | E2EE note |
|---|---|---|---|---|
| Sign up | HAVE | Onboarding.tsx; protocol.ts:7 | — | Recovery key is required |
| Sign in | HAVE | SignIn.tsx; protocol.ts:29-31 | — | A new browser needs the recovery key |
| Devices or sessions | HAVE | settings/Devices.tsx; protocol.ts:33-36; no device names (README:44) | — | Signed device list |
| 2FA or passkeys | SERVER-ONLY | api.go:175-188 (TOTP enrol, passkeys, OIDC); the web client only verifies TOTP; README:44 | M | Login secrets are separate from E2EE keys (spec:201-202) |
| Recovery | HAVE | Recovery key (gs:173-183) | — | Restores the account, not old messages |
| Change username | MISSING | No route; a deleted account's username stays reserved (accounts.go:298) | M | — |
| Change password | SERVER-ONLY | api.go:177; gs:388 | S | — |
| Delete account | SERVER-ONLY | api.go:199; accounts.go:298-317 (tombstone only, no group Removes yet) | M | Must Remove the user from every group (spec:214) |
| Privacy settings | PARTIAL | Settings → Privacy is safety numbers only; no DM or friend-request privacy controls | M | — |

## Platform

| Item | Status | Evidence | Effort | E2EE note |
|---|---|---|---|---|
| Bots | MISSING | CreateAccount always sets kindHuman (accounts.go:153); kind 1 bot exists only on the wire (protocol/09:279) and as a tag (en.ts:421,504); the bot SDK and music bot are v1 scope (spec:113,711) | XL | Bots must be visible MLS members to read anything; they can never read silently |
| Webhooks | MISSING | spec:225, spec:675 | L | Only into readable channels, or through an owner-run integration device |
| Slash commands | MISSING | Op 33 interaction is reserved but nothing produces it (frame.go:51); spec:188-190,667 | L | Planned to run through interaction MLS groups |
| Integrations | MISSING | — | L | Same constraint as bots |
| Rich presence | MISSING | Electron local IPC (spec:550) | L | Presence is server-visible metadata (spec:548) |
| Scheduled events | OOS | spec:683 | — | — |

## Quality

| Item | Status | Evidence | Effort | E2EE note |
|---|---|---|---|---|
| Accessibility | PARTIAL | Skip link (en.ts:145), screen-reader announcements (en.ts:427-433), high-contrast theme (en.ts:289), phone width; WCAG 2.2 AA is due before public release (spec:238); no audit yet | M | The ceremonies must be accessible (spec:237-238) |
| i18n | PARTIAL | Strings are externalised but English only (strings/index.ts); Intl date formats | M | — |
| Theming | HAVE | system, mesh, light and contrast (en.ts:284-289); no accent or density options | — | — |
| Keyboard shortcuts | PARTIAL | Control/⌘+K, Control+/, mute and deafen (en.ts:10-12,498-501); no single-key shortcuts or command palette (gs:676; spec:275) | M | — |

## Counts

117 items in total: HAVE 31, PARTIAL 20, SERVER-ONLY 23, MISSING 34, OOS 9.

## Biggest gaps for a friends group switching from Discord (ranked)

1. **No server administration UI.** Nothing in the client renames or deletes servers and channels, sets a topic, makes categories, reorders, or sets invite limits, lists or revokes invites. The server does almost all of it already, so this is the cheapest big win (M to L).
2. **No roles, permissions or private channels in the client.** It first needs routes that read roles and overwrites. Until the client knows its permissions, pins and @everyone stay unchecked (L).
3. **No history for new members or new browsers.** This is E2EE by design (phase 2 inviter history sharing), and friends will feel it most (XL).
4. **No phone app and no push.** Notifications also need an open tab. Phase 2 (XL).
5. **No desktop app.** That means no global push to talk, no app or system audio in screen share, no background notifications and no game activity, all of which are v1 must-haves (XL).
6. **No presence and no member list.** The gateway op is reserved but never set (M).
7. **Profiles are frozen.** There are no avatars, nicknames or custom status, and the display name cannot change because `PATCH /me` answers 501 (M).
8. **Plain text only.** No markdown, code blocks, spoilers, full emoji picker or emoji in text (M).
9. **No link previews or GIF picker.** The envelope already carries sender-made previews (M).
10. **No bots or music bot, and no slash commands.** These are v1 scope (XL).
11. Moderation UI: kick, ban and moderator delete. Server-only, or missing for moderator delete.
12. Social: making group DMs, friends and blocking.
