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

## Release
Ships after v0.1.0-web3.9.1, with release notes (client only: no schema, store or wire change) and the Homelab deploy.
