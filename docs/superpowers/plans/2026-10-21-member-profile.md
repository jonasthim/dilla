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

## Release
Ships after v0.1.0-web3.9.1, with release notes (client only: no schema, store or wire change) and the Homelab deploy.
