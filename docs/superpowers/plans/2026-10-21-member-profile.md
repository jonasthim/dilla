# Member list polish and a profile card: plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** the member list looks and works like Discord's in the Mesh style. Names are centred, role colour sits on the name, the owner gets a crown, there are no tags in the row, and clicking a member opens a profile card.

**Context:** Jonas, on the deployed web3.9 (2026-10-21), wrote: "why isnt the name vertically aligned? also why do we need the pills with owner and you? Move that into a 'profile' like discord." His answers to the follow-up questions are binding:
- **P1 Role colour:** colour the name itself with the member's top coloured role, as Discord does. Fall back to the normal text token when the role colour would fail 4.5:1 contrast in the current theme. The dot after the name goes.
- **P2 Owner:** a small crown icon after the owner's name, with "owner" for screen readers. The "you" tag leaves the list and appears in the profile card.
- **P3 Profile:** clicking a member, or Enter on the focused row, opens a profile card beside the list. On a phone it opens as a sheet. The card holds the avatar, display name, @username, status, owner and "you" when they apply, roles as coloured chips, and the actions (message, compare safety numbers, and kick and ban when the viewer has the permission). The row's "…" action menu goes; right-click and Shift+F10 open the card too.
- **P4 Vertical alignment:** while line 2 (custom status) is empty, the name is centred in the 44 px row. With a second line it sits as two lines. Discord does the same.

**Architecture:**
- `packages/ui`: MemberList changes, plus a new `ProfileCard` component. ProfileCard is a popover anchored to the row on desktop and a bottom sheet on phone. It is a `dialog`: focus moves in, Escape closes it, focus returns to the row.
- `packages/web`: `screens/admin/MemberPane.tsx` maps the existing member data (roles, owner, self, presence and the permission-gated actions) into the card.
- No server, protocol or store change. Kick and ban stay enforced by the server as they are today.

**Tech:** React, CSS tokens (Mesh), Lucide 1.57.0 icons (`crown`), vitest, Storybook with test-runner and axe, Playwright e2e.

## Global constraints
- Mesh style; WCAG 2.2 AA in mesh, light and high contrast; 44 px targets on phone; inputs at 16 px or more; each element has its room (layout.spec grammar: names share one x, trailing edges align).
- Copy goes under the `layout.` prefix (strings/layout.ts, flow 14 and its test); check:copy stays green.
- Show each new test red, then green.

## Tasks

### Task MP1 (sonnet): MemberList row and ProfileCard (ui)
Files: `packages/ui/src/MemberList/**`, new `packages/ui/src/ProfileCard/**`, `packages/ui/src/Icon/icons.ts` (vendor `crown`), and `index.ts` exports.
- Row: avatar with its presence corner, then the name in the role colour (with the contrast fallback), then the crown for the owner. No tags, no RoleDot, no "…" trigger. The row is one button that opens the card; right-click and Shift+F10 also open it.
- Centre the name while line 2 is empty. Test: measure the name's vertical centre against the row's centre (±1 px) in a story play.
- ProfileCard props: name, username, presence, isOwner, isYou, roles (name and colour), and actions (`ActionMenuItem[]`). Render: avatar (large), name, @username, status, an owner/you line, role chips, and action buttons.
- Card behaviour: a popover beside the row on desktop and a sheet on phone; Escape closes, focus returns, the Tab order stays inside; axe passes.
- Stories: list rows (owner, coloured role, long name, offline), the card on desktop and phone, in three themes.
- Gates: ui vitest; check:css; storybook build and test:storybook:ci.

### Task MP2 (sonnet): wire MemberPane (web)
Files: `packages/web/src/screens/admin/MemberPane.tsx` and its tests, plus `packages/web/src/strings/layout.ts`, flow 14 and its test for new strings (for example `layout.profile.owner`, `layout.profile.you`, `layout.profile.roles`).
- Build each member's card data from what MemberPane already has: roles in order with colours, owner, self, presence, and the existing permission-gated actions.
- Remove the tags and the action menu wiring that MP1's row no longer takes.
- Tests: clicking a row opens the card with the right roles and actions; a member without kick permission sees no kick; "you" shows only on the viewer's own card.
- Gates: web vitest; typecheck; check:copy; and e2e admin.spec plus layout.spec on chromium-web, updated for the card in place of the "…" menu.

### Task MP3 (haiku): docs and screenshots
README and docs/user lines for the member list and the profile card; re-shoot the member-list shots. Gates: check:docs and the shoot-docs test.

### Task MP4 (sonnet): voice sidebar, dock and device tag polish (ui + web)
Jonas, on the deployed web3.9 (2026-10-21): "why is it a green speaker and a 'phone' for casa bonita? Why is there no margin for the mute / deafen in the list? why is the icons for cam/screen sharing to the right?" (he means: why are they on the left; he wants them on the right), and "when hovering a message in the chat the WEB pill shows and the content jumps, make sure that the pill always is showing". Rulings, binding:
- **V1 In-call row, like Discord:** the channel you're connected to shows no phone icon and no accent-coloured speaker. Remove `.d-voice-row__connected` and the `[data-joined]` glyph accent in `packages/ui/src/VoiceChannelRow/VoiceChannelRow.{tsx,css}`. The joined row's name is `var(--fg)` at weight 600; the speaker glyph keeps the live colour (`--fg-2`). The join icon stays as today: only on channels you're not in, on hover/focus (always on touch and phone). Keep `data-joined` for tests. The screen-reader name still says you're connected (keep or move the existing connected wording into the row's accessible name; no new string unless needed, under `voice.`).
- **V2 Participant glyph inset:** a participant's mute/deafen glyphs today overflow the 32 px trailing slot and touch the list's right edge. Give the pair a 0.25 rem gap and make their right edge line up with the channel row's trailing edge (the count/join right edge, `0.5rem` from the list edge). Widen the people grid's slot column to `max-content` with `min-width: var(--slot-w)` or equivalent; one glyph or two, the right edges align down the list. Test: a story play measures each glyph's right edge ≤ the list's right edge − 8 px (±1) and the two glyphs do not overlap.
- **V3 Dock controls on the right:** in `packages/ui/src/VoiceDock/VoiceDock.css`, camera, share and leave sit together at the right end of the controls row (`justify-content: flex-end`; drop the leave `margin-left: auto`), in the order camera, share, leave; the toolbar's arrow-key order is unchanged. Test: a story play checks the camera's left edge is right of the dock's horizontal centre.
- **V4 Device tag always shown:** the WEB tag on a web client's message shows always, so hovering never shifts the row. Remove the `deviceTag: 'hover'` mode: `MessageRow` drops the prop and the `data-reveal="hover"` CSS (`MessageRow.css:72-74`); `packages/web/src/screens/conversation/MessageItem.tsx:106` stops passing it; update `Conversation.test.tsx` ("tags a web client on hover only" becomes "tags a web client and a bot always"), the `DeviceTagOnHover` story and the MessageLog story. A grouped row (no head) shows no tag, as today.
- Gates: ui vitest; web vitest for `Conversation.test.tsx`; typecheck; check:css; storybook build and test:storybook:ci for VoiceChannelRow, VoiceDock and MessageRow; e2e `layout.spec` on chromium-web (update any grammar assertion on the connected glyph or the dock's leave position).
- Shots: VoiceChannelRow joined with a muted+deafened participant, the VoiceDock, and a MessageRow with the WEB tag, at 1440 desktop in mesh, for Jonas before the PR.

### Task MP5 (sonnet, opus review): the dock names the channel and shows ping and bitrate (ui + web)
Jonas, 2026-10-21, on the dock: "instead of voice connected, show the channel name. Also I want us to show the ms to the server, the bitrate of the stream." His answers are binding:
- **D1 Lines:** line 1 is the state dot and the **channel name** (no "voice connected", no server name). Line 2 is the **link stats**: `24 ms · ↑48 ↓96 kb/s`. Before the first sample, line 2 reads `— ms`. While the phase is not connected (connecting, reconnecting, paused/held), line 2 shows the phase's existing words in place of the stats. The server name moves into the line-1 element's `title` (tooltip) and its accessible name, so it is still findable.
- **D2 Bitrate up and down:** ↑ is what this device sends (all outbound RTP: mic, plus camera/screen when on), ↓ is everything it receives (all inbound RTP). Integer kb/s from `bytesSent`/`bytesReceived` deltas over the sample interval (×8/1000/seconds). A counter that goes down (a new peer connection) counts from 0 for that sample.
- **D3 Ping colour:** RTT from the selected candidate pair (`connectionOf` in `packages/web/src/call/stats.ts` already reads it). The stats text uses the normal token under 150 ms; `--warn` at 150–300 ms; `--danger` above 300 ms or loss above 5 %. Colour is never the only signal: the accessible description names the quality ("good", "poor", "bad").
- **Sampling:** a local 2 s poll in `packages/web/src/call/session.ts` while connected. It reads the publisher and subscriber peer connections (`room.engine.pcManager.publisher` / `.subscriber`, the way `reportStats` does) and stays separate from the 10 s server report (`STATS_EVERY_MS`), which is unchanged. Add a pure `linkSample(prevTotals, rtcPub, rtcSub, dtMs)` in `stats.ts` that returns `{ rttMs, upKbps, downKbps, lossPct }` plus the next totals, unit-tested with fake reports, including the counter reset and the no-pair case. Expose it on the call state as `link?: { rttMs; upKbps; downKbps; lossPct }`; it is cleared on leave.
- **UI:** `packages/ui/src/VoiceDock/VoiceDock.tsx` gains `stats?: { rttMs: number; upKbps: number; downKbps: number; quality: 'good' | 'poor' | 'bad' }`; line 1 shows `where` (now the channel), line 2 shows the stats or the phase words. Stats use tabular numerals so the line does not jitter. Neither line wraps; the channel name truncates. The `role="status"` announcements are unchanged; the stats are never announced (they change every 2 s).
- **Copy** (`voice.` prefix, its flow doc and test; check:copy green): `voice.dock.ping` '{ms} ms', `voice.dock.pingNone` '— ms', `voice.dock.rate` '↑{up} ↓{down} kb/s', `voice.dock.stats` 'Ping {ms} milliseconds, {quality}. Sending {up}, receiving {down} kilobits per second.', `voice.dock.quality.good` 'good', `.poor` 'poor', `.bad` 'bad'. Remove the now-unused "voice connected" line-1 string only if nothing else uses it.
- **Wiring:** `packages/web/src/screens/voice/VoiceView.tsx:529` passes the channel name as `where`, the server name as the tooltip, and maps `call.state.link` to `stats` with the thresholds above (a pure `linkQuality(rttMs, lossPct)` with its own test, boundaries 150/300 ms and 5 %).
- Gates: web vitest for stats, session, VoiceView; ui vitest for VoiceDock; typecheck; check:copy; storybook test for VoiceDock (stories: good, poor, bad, no sample yet, reconnecting, a long channel name); e2e voice on chromium only if an existing assertion reads "voice connected".
- Shots: the dock in the three stat states and reconnecting, desktop 1440, mesh, for Jonas.
- Order: after MP4 (both touch VoiceDock), in the same lane.

### Task MP6 (sonnet): the AFK channel always last, and the joined row says so (ui + web)
Jonas, 2026-10-21: "AFK channel should always be in the bottom". His answer is binding: **the very bottom, in its own spot**. The AFK channel is always the last row of the whole channel list, below every category and in no category, whatever its stored `position` or `parentId`.
- **Order:** in `packages/web/src/screens/Shell.tsx` (the `ordered` channels and the category rows, around lines 940-1080), the server's AFK channel (`afkChannels`, from the `afk:<community>` slice) is taken out of its category or uncategorised group and rendered after the last category. Put the ordering in a pure function, for example `withAfkLast(rows, afkIds)`, with a unit test: AFK last with no categories, AFK last when its `parentId` names a category, and no change when there is no AFK channel.
- **Pinned:** if the list supports drag or keyboard reordering, or "move to category" (find it in `packages/ui/src/ChannelList` and `packages/web/src/screens`), the AFK row cannot be moved, and nothing can be dropped below it. The server is not changed: the pin is display-only. A move that would land below AFK lands just above it.
- **Collapsing:** folding a category never hides the AFK row.
- **Joined row for screen readers** (MP4 review, medium): the voice row you are connected to adds `voice.row.joined` 'connected' to its accessible name, for example "harbour, 3, connected". Use `packages/ui/src/VoiceChannelRow` labels (a new `joined` label) and pass it from web. Add the string, its flow doc and its test under the `voice.` prefix.
- Gates: web vitest for the new function and the Shell list tests; ui vitest for VoiceChannelRow; typecheck; check:copy; the e2e layout.spec on chromium-web if it orders channel rows (grep for the AFK channel's name or `afk`).
- Shot: a server with two categories plus AFK, desktop 1440, mesh.

## Release
Ships after v0.1.0-web3.9.1, with release notes (client only: no schema, store or wire change) and the Homelab deploy.
