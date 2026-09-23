# dilla design brief

## Purpose

dilla's interface is the Mesh design from dilla-chat, reimplemented in the new codebase, with
encryption made silent. This brief is the contract for every UI card: what the chrome looks like,
what words it uses, what it never shows, and the accessibility floor. Where this brief and a
component disagree, the brief wins; where this brief and the Mesh reference disagree, this brief
wins, because it records the decisions taken after the reference was made.

## Audience and tone

A gaming friend group that lives in voice all evening, and the self-hoster who runs their server.
The tone is a tool's: plain verbs, sentence case in prose, uppercase mono for chrome labels, no
marketing, no reassurance. Errors say what happened and what to do. Empty states invite an action.
Nothing on screen exists to make the user feel secure; the product is secure by default and says
nothing about it in the chrome.

## Vocabulary

| concept | UI word | never |
|---|---|---|
| a community on an instance | **server** | team, guild |
| a text or voice room | **channel** | kanal |
| private conversations | **DMs** | PMs, private messages |
| the voice room you are in | **voice** | call, room (call is used only for DM calls) |
| the person who runs the instance | **host** | operator (in copy) |
| a bot user | **bot** | app, integration |

Code, API and protocol keep *community* and *channel*; only copy changes.

## Design system source

`docs/design/reference/mesh-handoff/README.md` §Design Tokens and §Layout shell, `themes.js`
(`mesh`), and the live prototype `Dilla Mesh.html`. The rendering to match is
`docs/design/reference/mesh-without-encryption-markers.jpeg`; the as-shipped handoff is
`mesh-handoff-as-shipped.jpeg` for comparison only.

## Tokens

Colours, mesh theme (the default):

| token | value | role |
|---|---|---|
| `--bg` | `#070809` | page background |
| `--bg-2` | `#0C0D0F` | rail, sidebar, status bars |
| `--bg-3` | `#101214` | tertiary surface |
| `--surface` | `#0C0D0F` | cards, modals |
| `--surface-2` | `#14171A` | hover, sub-surface, inputs |
| `--surface-hi` | `#1A1E22` | active hover, selected row |
| `--hairline` | `#1F2226` | dividers, borders |
| `--hairline-2` | `#363B41` | stronger dividers (decorative; never the only boundary of a control) |
| `--edge` | `#6B7370` | borders of interactive controls (buttons, inputs, kbd, tags): 4.1:1 on `--bg`, so a control is identifiable without hover |
| `--fg` | `#E8ECE8` | primary text |
| `--fg-2` | `#A0A6A0` | secondary text |
| `--fg-3` | `#767C76` | muted text and labels (Mesh had `#5E635E`, 3.3:1; raised to pass 4.5:1) |
| `--fg-4` | `#5E635E` | decorative only: never text, never an icon that carries meaning |
| `--fg-link` | `#7CFF8E` | links |
| `--accent` | `#7CFF8E` | live, active, selected, focus ring, brand caret |
| `--accent-2` | `#A8FFB6` | accent hover |
| `--accent-ink` | `#06150A` | text on accent |
| `--accent-soft` | `rgba(124,255,142,0.14)` | accent tint |
| `--danger` | `#FF6E6E` | destructive, muted mic, errors |
| `--warn` | `#FFD16A` | caution, idle presence |
| `--ok` | `#7CFF8E` | online presence, success |
| `--mention` | `#FFD16A` | mention pill background (with `--accent-ink` text) |

Type: `--font-mono` = "JetBrains Mono Variable", ui-monospace, monospace (everything);
`--font-serif-italic` = "DM Serif Display", serif, italic (only the server name in the sidebar
header). Sizes: `--text-micro` 10px, `--text-xs` 11px, `--text-sm` 12.5px, `--text-base` 13.5px,
`--text-md` 14px, `--text-lg` 17px, `--text-xl` 22px. Weights: `--weight-display` 700,
`--weight-body` 420, `--weight-label` 600. Labels in chrome: uppercase, `letter-spacing: 0.08em`.

Radii: `--r-sm` 0, `--r-md` 2px, `--r-lg` 3px, `--r-pill` 999px (reactions, presence dots, unread
and mention pills only), `--r-avatar` 2px. Shadows: `--shadow-1` `0 0 0 1px rgba(124,255,142,0.08)`,
`--shadow-2` `0 0 0 1px rgba(124,255,142,0.18), 0 12px 30px rgba(0,0,0,0.6)`. No blur anywhere.

Opacity: `--opacity-muted` 0.8, applied to de-emphasised rows (e.g. a muted channel/member row) on
top of their existing colour, never as the only signal of the muted state. Chosen over the Mesh
reference's raw `0.55` because that value composited `--fg-2` text over `--bg-2` down to ~3.09:1;
0.8 is the smallest round value that keeps `--fg-2` on `--bg-2` at or above 4.5:1 in all three
themes (mesh 5.32:1, light 4.95:1, high-contrast 10.59:1).

Density (`data-density`): compact row padding 4px 16px, gap 0, group gap 8px, avatar 28px;
regular 6px 18px, 2px, 14px, 32px; cozy 10px 20px, 4px, 22px, 36px. Line height 1.4 / 1.5 / 1.55.

Layout dimensions: `--rail-w` 60px, `--sidebar-w` 240px (resizable 200–360), `--members-w` 232px
(180–340), `--thread-w` 380px, `--topbar-h` 32px, `--bottombar-h` 26px, `--channel-header-h` 48px.

Focus: `--focus-ring` = `2px solid var(--accent)`, applied as `outline: var(--focus-ring)` with
`outline-offset: 2px` on every interactive element via `:focus-visible`. The ring is an outline and
never a `box-shadow`: `box-shadow` is reserved for component state (the active channel row's inset
bar, a pressed toggle's underline), which must not be able to swallow the ring, and an outline keeps
the Windows forced-colors indicator. Motion: `--duration-fast` 150ms, `--duration-normal` 200ms, `--duration-slow`
300ms, `--ease-out` cubic-bezier(0.16,1,0.3,1); toast pop 220ms; speaking pulse 2s; caret blink 1s.
Under `prefers-reduced-motion: reduce` every duration is 0ms and the caret and pulse are static.

Sound tokens (names; files come with the sound card): `join`, `leave`, `mention`, `mute`,
`unmute`, `deafen`, `undeafen`, `ping`, `error`. Short, dry, mono-era clicks and one ping; no
Discord sounds, no chimes.

## Layout

The Mesh shell, verbatim: a 60px server rail on the left (40×40 tiles with initials, 2px radius,
accent fill and a white left bar when active, dashed accent "+"); a resizable sidebar with the
server name in serif italic plus a node line, tabs CHANNELS / DMS, an ACTIVE VOICE section on top
when a voice channel is live (participants with speaking pulse, mic-off and screen-share glyphs),
then CHANNELS with unread (accent) and mention (warn) pills, then VOICE, a voice dock when
connected, and the user panel; the main pane with a 48px header `[ # NAME ]` + topic + actions
(threads, saved, pinned, members, scoped search), the message feed with day dividers and grouped
messages, and a pill composer with attach, emoji and send; a resizable member list (Admin / Online
/ Offline) that swaps for a 380px thread panel; an optional 32px top bar (mono D-tile + DILLA +
blinking caret, `server · node · status`, a live clock, keybind hints ⌘K / `/` / `?`) and a 26px
bottom bar (node, peers, lamport, latency, voice codec with a 12-bar meter, version). Command
palette on ⌘K, search palette on `/`, settings modal 960×640 with a 220px nav.

## Removed from the chrome

Encryption is the default and says nothing. These Mesh elements are not built:

- the shield badge in channel headers
- the SRTP badge in voice headers
- the composer footer line about encryption
- the e2e and db chunks in the bottom bar
- the pills on empty channels and DMs
- the lock in notification teasers
- the drop-overlay copy about encryption

Encryption details, safety numbers, device verification and the recovery-key ceremony live in
Settings → Privacy and Settings → Devices, the onboarding steps, and their own modals.

## Trust facts that stay visible

- A small muted `web` tag after the name of a member whose message or presence comes from a
  browser session (member list, message header, profile popover).
- On a bot present in a voice channel: the bot tag plus "can hear" (voice list and member list).
- The existing lock glyph on private voice channels (a permission fact, not encryption).

## The readable-channel glyph

A channel anyone can join by public invite is readable by the server. It shows a small muted
dotted-circle glyph `◌` after its name in the channel list, the same weight as the private-channel
lock, with the accessible name "Readable by this server". No text, no colour, nothing else in the
chrome; the mode is set and explained in channel settings.

## Brand mark

Top bar: the mono D-tile (18×18, accent background, `--accent-ink` "D", 2px radius) followed by
"DILLA" in 11px uppercase mono at 700 and a 6×12px accent caret that blinks at 1 Hz (static under
reduced motion). The SVGs in `docs/design/reference/mesh-handoff/branding/` (teal D, amber
wordmark) are used only for the favicon, the first-run splash and the README, never in the app
chrome.

## Sound

Every sound is under 300 ms, dry, and mono-era: a click for mute/unmute/deafen, a two-tone tick
for join/leave, one short ping for mentions, a low buzz for errors. Sounds are user-toggleable per
event in Settings → Notifications and are off in the `browser` tier until the user turns them on.

## Motion

Only these animations exist: toast pop-in 220 ms and shrink-out; splash fade 300 ms; drag-over
flash 120 ms; speaking pulse 2 s; caret blink 1 s; message flash after a reply-reference click
1.4 s; audio meter bars redraw every 120 ms. Hover and focus changes are 150 ms colour transitions.
Everything else is instant. All of it is disabled under `prefers-reduced-motion: reduce`.

## Themes

`mesh` is the default and is what the reference renders show. `light` and `high-contrast` are
derived from the same structure with their own values (see `packages/design-tokens`): the light
theme is not a colour inversion but a re-pick that keeps the accent meaning (green = live/sealed,
warn = attention, danger = destructive) at AA on light surfaces; the high-contrast theme uses pure
black, white text, a brighter accent, 1px white hairlines and underlined links. The app follows
the OS setting until the user chooses.

## Accessibility model

- Full keyboard operation: every action in the chrome reachable by Tab and the documented keybinds
  (⌘K palette, `/` search, `?` keys, ⌘1–9 channel jumps, M mute, D deafen, Esc closes).
- Visible focus everywhere: a 2px accent outline offset by 2px (`--focus-ring`), applied with
  `outline`, never `box-shadow` — `box-shadow` is reserved for component state, so a state cue can
  never swallow the ring. Nothing in the component library sets `outline: none`.
- The message feed is a `log` region with a polite live region for new messages; the virtualised
  list keeps DOM order equal to reading order.
- Presence and speaking are shown with a glyph or text as well as colour.
- 200 % zoom without loss; font sizes in rem; no `min-width` wider than the viewport.
- Dialogs use the native `<dialog>` element: focus trap, Esc, focus return.
- Ceremonies (recovery key, safety number, pairing) are readable as text, copyable as text where
  allowed, and operable by keyboard alone.
- Every story and component test passes axe with zero serious or critical violations; the W12 pass
  adds NVDA, Orca and VoiceOver.

## Flows to wireframe

One week before each build week, as annotated ASCII screens in `docs/design/flows/`:

| flow | wireframe by | build week |
|---|---|---|
| first launch and invite join | W1 | W2 |
| signup with recovery-key ceremony | W2 | W3 |
| channel list and chat, DMs and group DMs | W2 | W3 |
| voice join, leave, mute, deafen, push-to-talk, speaking | W3 | W4 |
| server settings, roles and overwrites | W4 | W5 |
| desktop chrome, tray, notifications | W5 | W6 |
| screen-share picker and audio options | W6 | W7 |
| new-device pairing and recovery-key entry | W7 | W8 |
| diagnostics page | W8 | W9 |
| bot install and bot tags | W10 | W11 |
| report dialog and "what is revealed" copy | W11 | W12 |

## Attribution

The Mesh design system is the work of the dilla-chat authors (github.com/dilla-chat/dilla-chat,
AGPLv3) and is reused here by the same authors under the same licence family. The reference copy
in `docs/design/reference/mesh-handoff/` is unmodified except for the removal of the `mesh-clean`
working directory.
