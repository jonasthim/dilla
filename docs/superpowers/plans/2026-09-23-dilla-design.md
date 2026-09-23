# dilla-design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the written design brief, the Mesh design-token package with an automated WCAG contrast guard and three themes, the first eight UI primitives in a React component library with Storybook and axe checks, and the lint that keeps encryption markers and the old vocabulary out of the chrome.

**Architecture:** `docs/design/brief.md` is the human-readable contract and is machine-checked for its required sections. `packages/design-tokens` holds the Mesh palette, the light and high-contrast derivations, density, radii, type, motion, focus and sound tokens as a TypeScript module, emits `dist/tokens.css` (CSS custom properties keyed by `data-theme` and `data-density`), and tests every text and UI colour pair against WCAG 2.2 AA. `packages/ui` is a React 19 library styled only with those custom properties; every component has a render test with `vitest-axe`, a keyboard test, and a Storybook story; the Storybook test-runner runs axe on every story in CI. A root script scans the UI package's copy for forbidden words.

**Tech Stack:** Node 24, npm workspaces, TypeScript 5, Vite 6, Vitest 3 with jsdom, React 19, Testing Library, vitest-axe, Storybook 9 (`@storybook/react-vite`, `@storybook/addon-a11y`, `@storybook/test-runner` with `axe-playwright`), Fontsource packages for JetBrains Mono and DM Serif Display (self-hosted, no font requests to third parties).

**Spec:** `docs/superpowers/specs/2026-09-23-dilla-design.md`, sections "UX, visual design system and accessibility", "Items confirmed at spec review", "Decisions taken at spec review", "Verification (end to end)". Design reference: `docs/design/reference/mesh-handoff/README.md` (§Design Tokens, §Layout shell) and `docs/design/reference/mesh-without-encryption-markers.jpeg`.

## Global Constraints

- The design system is dilla-chat's Mesh, reimplemented: near-black surfaces, JetBrains Mono everywhere, neon-green accent `#7CFF8E`, radii 0–3px, matte (no blur, no glass), uppercase mono labels as chrome, bracketed channel headers, status bars, a mono D-tile with a blinking caret as the brand mark.
- **No encryption markers in the chrome.** Forbidden in `packages/ui` copy and stories: `E2E`, `E2EE`, `end-to-end`, `encrypted`, `encryption`, `SRTP`, `X3DH`, `Signal Protocol`, `SQLCipher`, `AES-256`, `MLS`. The one exception is the readable-channel glyph, whose accessible name is "Readable by this server".
- **Vocabulary in UI copy:** *server*, *channel*, *DMs*, *voice*. Forbidden: `kanal`, `kanals`, `team`, `teams`, `PMs` (as copy; identifiers in code are not copy).
- Trust facts that stay visible: a small muted `web` tag on members signed in from a browser; the bot tag plus "can hear" on a bot present in a voice channel.
- Accessibility: WCAG 2.2 AA. Text colour pairs ≥ 4.5:1, UI component and large-text pairs ≥ 3:1, visible focus ring on every interactive element, no information by colour alone, `prefers-reduced-motion` stops every non-user-triggered animation. `axe` with zero `serious` or `critical` violations on every story and every component test.
- Themes: `mesh` (dark, default), `light`, `high-contrast`; system-following by default; density `compact` / `regular` / `cozy`.
- Fonts are self-hosted through Fontsource; nothing in this package fetches from `fonts.googleapis.com`.
- Licence: `packages/design-tokens` and `packages/ui` are AGPL-3.0-or-later (client code). Every commit signed off (`git commit -s`).
- Node 24, npm 11, no pnpm. Dependency majors below are the ones current on 2026-09-23; if npm reports a newer major with the same API, use it and note it in the commit message.

---

### Task 1: Design brief and its checker

**Files:**
- Create: `docs/design/brief.md`
- Create: `scripts/check-design-brief.mjs`
- Test: `scripts/check-design-brief.test.mjs`
- Modify: `package.json` (root scripts `check:brief`, `test`)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run check:brief`; the token values and rules every later task copies from the brief.

- [ ] **Step 1: Write the failing checker test**

`scripts/check-design-brief.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBrief, REQUIRED_HEADINGS, EXCLUSIONS } from './check-design-brief.mjs';

function fixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-brief-'));
  mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'design', 'brief.md'), body);
  return dir;
}

test('a complete brief passes', () => {
  const body = ['# dilla design brief', ...REQUIRED_HEADINGS, '', ...EXCLUSIONS.map(e => `- ${e}`)].join('\n\n');
  assert.deepEqual(checkBrief(fixture(body)), []);
});

test('missing headings and exclusions are reported', () => {
  const problems = checkBrief(fixture('# dilla design brief\n\n## Purpose\n'));
  assert.ok(problems.some(p => p.includes('## Vocabulary')));
  assert.ok(problems.some(p => p.includes(EXCLUSIONS[0])));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/check-design-brief.test.mjs`
Expected: FAIL, `Cannot find module './check-design-brief.mjs'`.

- [ ] **Step 3: Write the checker**

`scripts/check-design-brief.mjs`:
```js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_HEADINGS = [
  '## Purpose', '## Audience and tone', '## Vocabulary', '## Design system source', '## Tokens', '## Layout',
  '## Removed from the chrome', '## Trust facts that stay visible', '## The readable-channel glyph',
  '## Brand mark', '## Sound', '## Motion', '## Themes', '## Accessibility model', '## Flows to wireframe', '## Attribution',
];

export const EXCLUSIONS = [
  'the shield badge in channel headers',
  'the SRTP badge in voice headers',
  'the composer footer line about encryption',
  'the e2e and db chunks in the bottom bar',
  'the pills on empty channels and DMs',
  'the lock in notification teasers',
  'the drop-overlay copy about encryption',
];

export function checkBrief(root) {
  const path = join(root, 'docs', 'design', 'brief.md');
  if (!existsSync(path)) return ['docs/design/brief.md: missing'];
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').map(l => l.trim());
  const problems = [];
  for (const h of REQUIRED_HEADINGS) if (!lines.includes(h)) problems.push(`brief: missing heading "${h}"`);
  for (const e of EXCLUSIONS) if (!text.includes(e)) problems.push(`brief: exclusion list must contain "${e}"`);
  if (/\b(TBD|TODO|FIXME)\b/.test(text)) problems.push('brief: placeholder found');
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkBrief(process.argv[2] ?? process.cwd());
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('design brief: ok');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/check-design-brief.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the brief**

`docs/design/brief.md`:
```markdown
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
(`meshTheme`), and the live prototype `Dilla Mesh.html`. The rendering to match is
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
| `--hairline-2` | `#363B41` | stronger borders, kbd outlines |
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

Density (`data-density`): compact row padding 4px 16px, gap 0, group gap 8px, avatar 28px;
regular 6px 18px, 2px, 14px, 32px; cozy 10px 20px, 4px, 22px, 36px. Line height 1.4 / 1.5 / 1.55.

Layout dimensions: `--rail-w` 60px, `--sidebar-w` 240px (resizable 200–360), `--members-w` 232px
(180–340), `--thread-w` 380px, `--topbar-h` 32px, `--bottombar-h` 26px, `--channel-header-h` 48px.

Focus: `--focus-ring` = `0 0 0 2px var(--bg), 0 0 0 4px var(--accent)` on every interactive element
via `:focus-visible`. Motion: `--duration-fast` 150ms, `--duration-normal` 200ms, `--duration-slow`
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
- Visible focus everywhere (`--focus-ring`).
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
```

- [ ] **Step 6: Wire the script into the root manifest and run it**

In the root `package.json` `scripts`, change `"test"` to
`"npm run check:docs && npm run check:brief && npm test --workspaces --if-present"` and add
`"check:brief": "node scripts/check-design-brief.mjs"` and
`"test:brief-check": "node --test scripts/check-design-brief.test.mjs"`.

Run: `npm run check:brief`
Expected: `design brief: ok`.

- [ ] **Step 7: Commit**

```bash
git add docs/design/brief.md scripts/check-design-brief.mjs scripts/check-design-brief.test.mjs package.json
git commit -s -m "docs(design): design brief with machine-checked sections and the exclusion list"
```

---

### Task 2: Design-tokens package — WCAG contrast utility

**Files:**
- Create: `packages/design-tokens/package.json`
- Create: `packages/design-tokens/tsconfig.json`
- Create: `packages/design-tokens/vitest.config.ts`
- Create: `packages/design-tokens/src/contrast.ts`
- Test: `packages/design-tokens/src/contrast.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `relativeLuminance(hex: string): number`, `contrastRatio(a: string, b: string): number`, `parseColor(input: string): [r, g, b, alpha]` (accepts `#rrggbb` and `rgba(r,g,b,a)`), `composite(fg: string, bg: string): string` (flattens an alpha colour onto an opaque background, returns `#rrggbb`).

- [ ] **Step 1: Create the package files**

`packages/design-tokens/package.json`:
```json
{
  "name": "@dilla/design-tokens",
  "version": "0.1.0",
  "private": true,
  "license": "AGPL-3.0-or-later",
  "type": "module",
  "exports": { ".": "./src/index.ts", "./tokens.css": "./dist/tokens.css" },
  "files": ["src", "dist"],
  "scripts": {
    "test": "vitest run",
    "build": "node --experimental-strip-types src/build.ts"
  },
  "devDependencies": { "typescript": "^5.6", "vitest": "^3" }
}
```

`packages/design-tokens/tsconfig.json`:
```json
{
  "compilerOptions": { "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true, "noEmit": true, "verbatimModuleSyntax": true, "allowImportingTsExtensions": true, "types": ["node"] },
  "include": ["src"]
}
```

`packages/design-tokens/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
```

Run: `npm install` at the root.

- [ ] **Step 2: Write the failing contrast tests**

`packages/design-tokens/src/contrast.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { relativeLuminance, contrastRatio, parseColor, composite } from './contrast.ts';

describe('parseColor', () => {
  it('parses hex and rgba', () => {
    expect(parseColor('#FFFFFF')).toEqual([255, 255, 255, 1]);
    expect(parseColor('#070809')).toEqual([7, 8, 9, 1]);
    expect(parseColor('rgba(124,255,142,0.14)')).toEqual([124, 255, 142, 0.14]);
    expect(() => parseColor('blue')).toThrow();
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 6);
  });
});

describe('contrastRatio', () => {
  it('is 21 for white on black and symmetric', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 2);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 2);
  });
  it('matches the well-known 4.54:1 of #767676 on white', () => {
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
  });
  it('flattens alpha colours onto the background before comparing', () => {
    // 14% green tint on near-black is almost the background: ratio close to 1
    expect(contrastRatio('rgba(124,255,142,0.14)', '#070809')).toBeLessThan(1.6);
  });
});

describe('composite', () => {
  it('returns the background for alpha 0 and the foreground for alpha 1', () => {
    expect(composite('rgba(255,0,0,0)', '#070809')).toBe('#070809');
    expect(composite('rgba(255,0,0,1)', '#070809')).toBe('#ff0000');
  });
});
```

- [ ] **Step 3: Run to verify failure, then write `contrast.ts`**

Run: `npm test --workspace packages/design-tokens` → FAIL, module not found.

`packages/design-tokens/src/contrast.ts`:
```ts
export type Rgba = [number, number, number, number];

export function parseColor(input: string): Rgba {
  const s = input.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) { const n = parseInt(hex[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(s);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`unsupported colour: ${input}`);
}

const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');

/** Alpha-composite `fg` over an opaque `bg`; returns #rrggbb. */
export function composite(fg: string, bg: string): string {
  const [r, g, b, a] = parseColor(fg);
  const [br, bgc, bb] = parseColor(bg);
  return `#${toHex(r * a + br * (1 - a))}${toHex(g * a + bgc * (1 - a))}${toHex(b * a + bb * (1 - a))}`;
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function relativeLuminance(color: string): number {
  const [r, g, b] = parseColor(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio; `fg` may have alpha and is flattened onto `bg` first. */
export function contrastRatio(fg: string, bg: string): number {
  const f = relativeLuminance(composite(fg, bg));
  const b = relativeLuminance(composite(bg, '#000000'));
  const [hi, lo] = f > b ? [f, b] : [b, f];
  return (hi + 0.05) / (lo + 0.05);
}
```

Run: `npm test --workspace packages/design-tokens` → PASS (7 tests).

- [ ] **Step 4: Commit**

```bash
git add packages/design-tokens package-lock.json
git commit -s -m "feat(design-tokens): WCAG contrast utility with known-answer tests"
```

---

### Task 3: Tokens, three themes, and the AA guard

**Files:**
- Create: `packages/design-tokens/src/tokens.ts`
- Create: `packages/design-tokens/src/index.ts`
- Test: `packages/design-tokens/src/tokens.test.ts`

**Interfaces:**
- Consumes: `contrastRatio` (Task 2).
- Produces: `type ThemeName = 'mesh' | 'light' | 'high-contrast'`; `themes: Record<ThemeName, ColorTokens>`; `ColorTokens` with the keys listed in the brief (`bg`, `bg2`, `bg3`, `surface`, `surface2`, `surfaceHi`, `hairline`, `hairline2`, `fg`, `fg2`, `fg3`, `fg4`, `fgLink`, `accent`, `accent2`, `accentInk`, `accentSoft`, `danger`, `warn`, `ok`, `mention`, `mentionInk`, `linkUnderline`); `structural` (type, radii, shadows, layout, focus, motion, sounds); `densities`; `TEXT_PAIRS` and `UI_PAIRS` (the pairs the guard checks).

- [ ] **Step 1: Write the failing token tests**

`packages/design-tokens/src/tokens.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { themes, TEXT_PAIRS, UI_PAIRS, structural, densities, type ThemeName } from './tokens.ts';
import { contrastRatio } from './contrast.ts';

const names = Object.keys(themes) as ThemeName[];

describe('themes', () => {
  it('defines mesh, light and high-contrast with the same keys', () => {
    expect(names.sort()).toEqual(['high-contrast', 'light', 'mesh']);
    const keys = Object.keys(themes.mesh).sort();
    for (const n of names) expect(Object.keys(themes[n]).sort()).toEqual(keys);
  });
  it('keeps the Mesh accent and background', () => {
    expect(themes.mesh.bg).toBe('#070809');
    expect(themes.mesh.accent).toBe('#7CFF8E');
    expect(themes.mesh.fg4).toBe('#5E635E');
  });
});

describe('WCAG AA guard', () => {
  for (const n of names) {
    for (const [fg, bg] of TEXT_PAIRS) {
      it(`${n}: text ${fg} on ${bg} is at least 4.5:1`, () => {
        expect(contrastRatio(themes[n][fg], themes[n][bg])).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const [fg, bg] of UI_PAIRS) {
      it(`${n}: ui ${fg} on ${bg} is at least 3:1`, () => {
        expect(contrastRatio(themes[n][fg], themes[n][bg])).toBeGreaterThanOrEqual(3);
      });
    }
  }
  it('high-contrast underlines links', () => {
    expect(themes['high-contrast'].linkUnderline).toBe(1);
    expect(themes.mesh.linkUnderline).toBe(0);
  });
});

describe('structural tokens', () => {
  it('has the Mesh radii and layout dimensions', () => {
    expect(structural.radius.md).toBe('2px');
    expect(structural.radius.pill).toBe('999px');
    expect(structural.layout.railW).toBe('60px');
    expect(structural.layout.bottombarH).toBe('26px');
  });
  it('has three densities', () => {
    expect(Object.keys(densities)).toEqual(['compact', 'regular', 'cozy']);
    expect(densities.regular.avatar).toBe('32px');
  });
});
```

- [ ] **Step 2: Run to verify failure, then write `tokens.ts` and `index.ts`**

Run: `npm test --workspace packages/design-tokens -- tokens` → FAIL, module not found.

`packages/design-tokens/src/tokens.ts`:
```ts
export type ThemeName = 'mesh' | 'light' | 'high-contrast';

export type ColorTokens = {
  bg: string; bg2: string; bg3: string; surface: string; surface2: string; surfaceHi: string;
  hairline: string; hairline2: string;
  fg: string; fg2: string; fg3: string; fg4: string; fgLink: string;
  accent: string; accent2: string; accentInk: string; accentSoft: string;
  danger: string; warn: string; ok: string; mention: string; mentionInk: string;
  linkUnderline: 0 | 1;
};

export const themes: Record<ThemeName, ColorTokens> = {
  mesh: {
    bg: '#070809', bg2: '#0C0D0F', bg3: '#101214', surface: '#0C0D0F', surface2: '#14171A', surfaceHi: '#1A1E22',
    hairline: '#1F2226', hairline2: '#363B41',
    fg: '#E8ECE8', fg2: '#A0A6A0', fg3: '#767C76', fg4: '#5E635E', fgLink: '#7CFF8E',
    accent: '#7CFF8E', accent2: '#A8FFB6', accentInk: '#06150A', accentSoft: 'rgba(124,255,142,0.14)',
    danger: '#FF6E6E', warn: '#FFD16A', ok: '#7CFF8E', mention: '#FFD16A', mentionInk: '#1A1300',
    linkUnderline: 0,
  },
  light: {
    bg: '#F5F6F5', bg2: '#ECEEEC', bg3: '#E3E6E3', surface: '#FFFFFF', surface2: '#E6E9E6', surfaceHi: '#DDE1DD',
    hairline: '#CBD0CB', hairline2: '#8F978F',
    fg: '#14171A', fg2: '#3F453F', fg3: '#5C635C', fg4: '#A9B0A9', fgLink: '#1E7F3A',
    accent: '#1E7F3A', accent2: '#2A9A4A', accentInk: '#FFFFFF', accentSoft: 'rgba(30,127,58,0.14)',
    danger: '#B3261E', warn: '#8A5A00', ok: '#1E7F3A', mention: '#F2C14E', mentionInk: '#1A1300',
    linkUnderline: 0,
  },
  'high-contrast': {
    bg: '#000000', bg2: '#000000', bg3: '#0A0A0A', surface: '#000000', surface2: '#101010', surfaceHi: '#1C1C1C',
    hairline: '#FFFFFF', hairline2: '#FFFFFF',
    fg: '#FFFFFF', fg2: '#E6E6E6', fg3: '#C8C8C8', fg4: '#8A8A8A', fgLink: '#9BFFA8',
    accent: '#9BFFA8', accent2: '#C4FFCC', accentInk: '#000000', accentSoft: 'rgba(155,255,168,0.2)',
    danger: '#FF9A9A', warn: '#FFE08A', ok: '#9BFFA8', mention: '#FFE08A', mentionInk: '#000000',
    linkUnderline: 1,
  },
};

type K = keyof ColorTokens;
/** Text pairs (≥ 4.5:1): [foreground, background]. */
export const TEXT_PAIRS: Array<[K, K]> = [
  ['fg', 'bg'], ['fg', 'bg2'], ['fg', 'surface'], ['fg', 'surface2'], ['fg', 'surfaceHi'],
  ['fg2', 'bg'], ['fg2', 'bg2'], ['fg2', 'surface2'],
  ['fg3', 'bg'], ['fg3', 'bg2'], ['fg3', 'surface'],
  ['fgLink', 'bg'], ['danger', 'bg'], ['warn', 'bg'], ['ok', 'bg2'],
  ['accentInk', 'accent'], ['mentionInk', 'mention'],
];
/** UI component and large-text pairs (≥ 3:1). */
export const UI_PAIRS: Array<[K, K]> = [
  ['accent', 'bg'], ['accent', 'bg2'], ['hairline2', 'bg'], ['danger', 'surface2'], ['warn', 'surface2'], ['fg2', 'surfaceHi'],
];

export const structural = {
  font: {
    mono: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    serifItalic: '"DM Serif Display", Georgia, serif',
  },
  text: { micro: '10px', xs: '11px', sm: '12.5px', base: '13.5px', md: '14px', lg: '17px', xl: '22px' },
  weight: { display: '700', body: '420', label: '600' },
  labelTracking: '0.08em',
  radius: { sm: '0px', md: '2px', lg: '3px', pill: '999px', avatar: '2px' },
  shadow: { s1: '0 0 0 1px rgba(124,255,142,0.08)', s2: '0 0 0 1px rgba(124,255,142,0.18), 0 12px 30px rgba(0,0,0,0.6)' },
  layout: { railW: '60px', sidebarW: '240px', membersW: '232px', threadW: '380px', topbarH: '32px', bottombarH: '26px', channelHeaderH: '48px' },
  focusRing: '0 0 0 2px var(--bg), 0 0 0 4px var(--accent)',
  motion: { fast: '150ms', normal: '200ms', slow: '300ms', easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)', toast: '220ms', pulse: '2s', caret: '1s', flash: '1.4s', meter: '120ms' },
  sounds: ['join', 'leave', 'mention', 'mute', 'unmute', 'deafen', 'undeafen', 'ping', 'error'] as const,
} as const;

export const densities = {
  compact: { rowPadY: '4px', rowPadX: '16px', rowGap: '0px', groupGap: '8px', avatar: '28px', lineHeight: '1.4' },
  regular: { rowPadY: '6px', rowPadX: '18px', rowGap: '2px', groupGap: '14px', avatar: '32px', lineHeight: '1.5' },
  cozy: { rowPadY: '10px', rowPadX: '20px', rowGap: '4px', groupGap: '22px', avatar: '36px', lineHeight: '1.55' },
} as const;
```

`packages/design-tokens/src/index.ts`:
```ts
export { themes, structural, densities, TEXT_PAIRS, UI_PAIRS } from './tokens.ts';
export type { ThemeName, ColorTokens } from './tokens.ts';
export { contrastRatio, relativeLuminance, parseColor, composite } from './contrast.ts';
```

- [ ] **Step 3: Run the tests; fix any pair that fails by changing the token, never the threshold**

Run: `npm test --workspace packages/design-tokens -- tokens`
Expected: PASS. If a pair fails, adjust the *value* in `tokens.ts` (darken a light-theme colour or lighten a dark-theme one) and note the change in the brief's token table when it concerns the mesh theme; the thresholds 4.5 and 3 are fixed.

- [ ] **Step 4: Commit**

```bash
git add packages/design-tokens/src
git commit -s -m "feat(design-tokens): Mesh tokens, light and high-contrast themes, WCAG AA guard"
```

---

### Task 4: CSS emitter

**Files:**
- Create: `packages/design-tokens/src/css.ts`
- Create: `packages/design-tokens/src/build.ts`
- Test: `packages/design-tokens/src/css.test.ts`
- Create (generated, committed): `packages/design-tokens/dist/tokens.css`

**Interfaces:**
- Consumes: `themes`, `structural`, `densities`.
- Produces: `renderCss(): string`; `npm run build -w packages/design-tokens` writes `dist/tokens.css`; the custom property names `--bg`, `--bg-2`, `--bg-3`, `--surface`, `--surface-2`, `--surface-hi`, `--hairline`, `--hairline-2`, `--fg`, `--fg-2`, `--fg-3`, `--fg-4`, `--fg-link`, `--accent`, `--accent-2`, `--accent-ink`, `--accent-soft`, `--danger`, `--warn`, `--ok`, `--mention`, `--mention-ink`, `--link-underline`, `--font-mono`, `--font-serif-italic`, `--text-*`, `--weight-*`, `--label-tracking`, `--r-*`, `--shadow-1`, `--shadow-2`, `--rail-w` etc., `--focus-ring`, `--duration-*`, `--ease-out`, `--row-pad-y`, `--row-pad-x`, `--row-gap`, `--group-gap`, `--avatar-size`, `--line-height`.

- [ ] **Step 1: Write the failing CSS tests**

`packages/design-tokens/src/css.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { renderCss, kebab } from './css.ts';

describe('kebab', () => {
  it('maps token keys to custom property names', () => {
    expect(kebab('bg2')).toBe('bg-2');
    expect(kebab('surfaceHi')).toBe('surface-hi');
    expect(kebab('accentInk')).toBe('accent-ink');
    expect(kebab('fg')).toBe('fg');
  });
});

describe('renderCss', () => {
  const css = renderCss();
  it('sets the mesh theme on :root and the others on data-theme', () => {
    expect(css).toMatch(/:root\s*{[^}]*--bg:\s*#070809;/);
    expect(css).toMatch(/\[data-theme="light"\]\s*{[^}]*--bg:\s*#F5F6F5;/);
    expect(css).toMatch(/\[data-theme="high-contrast"\]\s*{[^}]*--link-underline:\s*1;/);
  });
  it('follows the OS light setting only when no theme is chosen', () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: light\)\s*{\s*:root:not\(\[data-theme\]\)\s*{[^}]*--bg:\s*#F5F6F5;/);
  });
  it('emits densities and reduced motion', () => {
    expect(css).toMatch(/\[data-density="compact"\]\s*{[^}]*--avatar-size:\s*28px;/);
    expect(css).toMatch(/:root\s*{[^}]*--row-pad-y:\s*6px;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{\s*:root\s*{[^}]*--duration-fast:\s*0ms;/);
  });
  it('emits structural tokens', () => {
    expect(css).toContain('--r-md: 2px;');
    expect(css).toContain('--rail-w: 60px;');
    expect(css).toContain('--focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);');
    expect(css).toContain('--font-mono: "JetBrains Mono Variable"');
  });
});
```

- [ ] **Step 2: Run to verify failure, then write `css.ts` and `build.ts`**

Run: `npm test --workspace packages/design-tokens -- css` → FAIL, module not found.

`packages/design-tokens/src/css.ts`:
```ts
import { themes, structural, densities, type ColorTokens } from './tokens.ts';

export function kebab(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/([a-zA-Z])(\d)/g, '$1-$2').toLowerCase();
}

function colorDecls(t: ColorTokens): string {
  return (Object.entries(t) as Array<[string, string | number]>).map(([k, v]) => `  --${kebab(k)}: ${v};`).join('\n');
}

function densityDecls(d: (typeof densities)[keyof typeof densities]): string {
  return [
    `  --row-pad-y: ${d.rowPadY};`, `  --row-pad-x: ${d.rowPadX};`, `  --row-gap: ${d.rowGap};`,
    `  --group-gap: ${d.groupGap};`, `  --avatar-size: ${d.avatar};`, `  --line-height: ${d.lineHeight};`,
  ].join('\n');
}

function structuralDecls(): string {
  const s = structural;
  const lines = [
    `  --font-mono: ${s.font.mono};`, `  --font-serif-italic: ${s.font.serifItalic};`,
    ...Object.entries(s.text).map(([k, v]) => `  --text-${k}: ${v};`),
    ...Object.entries(s.weight).map(([k, v]) => `  --weight-${k}: ${v};`),
    `  --label-tracking: ${s.labelTracking};`,
    ...Object.entries(s.radius).map(([k, v]) => `  --r-${k}: ${v};`),
    `  --shadow-1: ${s.shadow.s1};`, `  --shadow-2: ${s.shadow.s2};`,
    ...Object.entries(s.layout).map(([k, v]) => `  --${kebab(k)}: ${v};`),
    `  --focus-ring: ${s.focusRing};`,
    `  --duration-fast: ${s.motion.fast};`, `  --duration-normal: ${s.motion.normal};`, `  --duration-slow: ${s.motion.slow};`,
    `  --ease-out: ${s.motion.easeOut};`, `  --duration-toast: ${s.motion.toast};`, `  --duration-pulse: ${s.motion.pulse};`,
    `  --duration-caret: ${s.motion.caret};`, `  --duration-flash: ${s.motion.flash};`, `  --duration-meter: ${s.motion.meter};`,
  ];
  return lines.join('\n');
}

export function renderCss(): string {
  const reduced = ['fast', 'normal', 'slow', 'toast', 'pulse', 'caret', 'flash'].map(k => `    --duration-${k}: 0ms;`).join('\n');
  return [
    '/* Generated by packages/design-tokens (npm run build). Do not edit. */',
    `:root {\n${colorDecls(themes.mesh)}\n${structuralDecls()}\n${densityDecls(densities.regular)}\n  color-scheme: dark;\n}`,
    `[data-theme="mesh"] {\n${colorDecls(themes.mesh)}\n  color-scheme: dark;\n}`,
    `[data-theme="light"] {\n${colorDecls(themes.light)}\n  color-scheme: light;\n}`,
    `[data-theme="high-contrast"] {\n${colorDecls(themes['high-contrast'])}\n  color-scheme: dark;\n}`,
    `@media (prefers-color-scheme: light) {\n  :root:not([data-theme]) {\n${colorDecls(themes.light).replace(/^/gm, '  ')}\n    color-scheme: light;\n  }\n}`,
    `[data-density="compact"] {\n${densityDecls(densities.compact)}\n}`,
    `[data-density="regular"] {\n${densityDecls(densities.regular)}\n}`,
    `[data-density="cozy"] {\n${densityDecls(densities.cozy)}\n}`,
    `@media (prefers-reduced-motion: reduce) {\n  :root {\n${reduced}\n  }\n}`,
    '',
  ].join('\n\n');
}
```

`packages/design-tokens/src/build.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCss } from './css.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'tokens.css');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, renderCss());
console.log(`wrote ${out}`);
```

Run: `npm test --workspace packages/design-tokens -- css` → PASS.

- [ ] **Step 3: Build, add the generated-file test, commit**

Append to `css.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
it('committed dist/tokens.css equals renderCss()', () => {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'tokens.css');
  expect(readFileSync(dist, 'utf8')).toBe(renderCss());
});
```

Run: `npm run build -w packages/design-tokens && npm test --workspace packages/design-tokens`
Expected: `dist/tokens.css` written; all tests PASS.

```bash
git add packages/design-tokens
git commit -s -m "feat(design-tokens): CSS custom-property emitter with themes, densities and reduced motion"
```

---

### Task 5: UI package scaffold, base styles, and the Button

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/vite.config.ts`
- Create: `packages/ui/src/test/setup.ts`
- Create: `packages/ui/src/styles/base.css`
- Create: `packages/ui/src/index.ts`
- Create: `packages/ui/src/Button/Button.tsx`
- Create: `packages/ui/src/Button/Button.css`
- Create: `packages/ui/src/Button/Button.stories.tsx`
- Test: `packages/ui/src/Button/Button.test.tsx`

**Interfaces:**
- Consumes: `@dilla/design-tokens/tokens.css`.
- Produces: `Button` with props `{ variant?: 'default' | 'accent' | 'danger' | 'ghost'; size?: 'sm' | 'md'; keyHint?: string; pressed?: boolean }` plus native button props; the test setup (`expect.extend(axeMatchers)`, jest-dom matchers) and the `axe` helper `expectNoAxeViolations(container)` used by every later component test.

- [ ] **Step 1: Create the package files**

`packages/ui/package.json`:
```json
{
  "name": "@dilla/ui",
  "version": "0.1.0",
  "private": true,
  "license": "AGPL-3.0-or-later",
  "type": "module",
  "exports": { ".": "./src/index.ts", "./base.css": "./src/styles/base.css" },
  "scripts": {
    "test": "vitest run",
    "storybook": "storybook dev -p 6006",
    "build-storybook": "storybook build",
    "test:storybook": "test-storybook --ci"
  },
  "peerDependencies": { "react": "^19", "react-dom": "^19" },
  "dependencies": {
    "@dilla/design-tokens": "*",
    "@fontsource-variable/jetbrains-mono": "^5",
    "@fontsource/dm-serif-display": "^5"
  },
  "devDependencies": {
    "@storybook/addon-a11y": "^9",
    "@storybook/react-vite": "^9",
    "@storybook/test-runner": "^0.23",
    "@testing-library/jest-dom": "^6",
    "@testing-library/react": "^16",
    "@testing-library/user-event": "^14",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "^4",
    "axe-playwright": "^2",
    "concurrently": "^9",
    "http-server": "^14",
    "jsdom": "^26",
    "playwright": "^1.50",
    "react": "^19",
    "react-dom": "^19",
    "storybook": "^9",
    "typescript": "^5.6",
    "vite": "^6",
    "vitest": "^3",
    "vitest-axe": "^0.1",
    "wait-on": "^8"
  }
}
```

`packages/ui/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"], "module": "ESNext", "moduleResolution": "Bundler",
    "jsx": "react-jsx", "strict": true, "noEmit": true, "skipLibCheck": true, "allowImportingTsExtensions": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", ".storybook"]
}
```

`packages/ui/vite.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', globals: true, setupFiles: ['src/test/setup.ts'], include: ['src/**/*.test.tsx'], css: false },
});
```

`packages/ui/src/test/setup.ts`:
```ts
import '@testing-library/jest-dom/vitest';
import { expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';
import { axe } from 'vitest-axe';
expect.extend(axeMatchers);

export async function expectNoAxeViolations(container: Element) {
  const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } }); // jsdom has no layout; contrast is guarded by design-tokens
  const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, JSON.stringify(serious, null, 2)).toHaveLength(0);
}
```

`packages/ui/src/styles/base.css`:
```css
@import '@dilla/design-tokens/tokens.css';
@import '@fontsource-variable/jetbrains-mono';
@import '@fontsource/dm-serif-display/400-italic.css';

:where(.d-root, .d-root *) { box-sizing: border-box; }
.d-root {
  font-family: var(--font-mono);
  font-size: var(--text-base);
  font-weight: var(--weight-body);
  line-height: var(--line-height);
  color: var(--fg);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
}
.d-root :focus-visible { outline: none; box-shadow: var(--focus-ring); }
.d-label { font-size: var(--text-micro); font-weight: var(--weight-label); letter-spacing: var(--label-tracking); text-transform: uppercase; color: var(--fg-3); }
.d-root a { color: var(--fg-link); text-decoration-line: none; }
[data-theme="high-contrast"] .d-root a, .d-root a[data-underline] { text-decoration-line: underline; }
```

- [ ] **Step 2: Write the failing Button test**

`packages/ui/src/Button/Button.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Button } from './Button.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('Button', () => {
  it('renders its label and calls onClick on click and on Enter', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save changes</Button>);
    const btn = screen.getByRole('button', { name: 'Save changes' });
    await userEvent.click(btn);
    btn.focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);
  });
  it('shows a key hint as a kbd element that is not part of the accessible name', () => {
    render(<Button keyHint="⌘↵">Save changes</Button>);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(screen.getByText('⌘↵').tagName).toBe('KBD');
  });
  it('exposes pressed state', () => {
    render(<Button pressed>Mute</Button>);
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('sets data-variant and data-size', () => {
    render(<Button variant="danger" size="sm">Leave</Button>);
    const btn = screen.getByRole('button', { name: 'Leave' });
    expect(btn).toHaveAttribute('data-variant', 'danger');
    expect(btn).toHaveAttribute('data-size', 'sm');
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><Button variant="accent" keyHint="M">Mute</Button></div>);
    await expectNoAxeViolations(container);
  });
});
```

- [ ] **Step 3: Install and run to verify failure**

Run: `npm install` (root), then `npm test --workspace packages/ui`
Expected: FAIL, `Failed to resolve import "./Button.tsx"`.

- [ ] **Step 4: Write the Button**

`packages/ui/src/Button/Button.tsx`:
```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './Button.css';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'accent' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  /** A keybind shown after the label, e.g. "M" or "⌘↵". Decorative for assistive tech. */
  keyHint?: string;
  /** For toggle buttons (mute, deafen): exposes aria-pressed. */
  pressed?: boolean;
  children: ReactNode;
};

export function Button({ variant = 'default', size = 'md', keyHint, pressed, children, type = 'button', className, ...rest }: ButtonProps) {
  return (
    <button type={type} className={['d-btn', className].filter(Boolean).join(' ')} data-variant={variant} data-size={size}
      aria-pressed={pressed === undefined ? undefined : pressed} {...rest}>
      <span className="d-btn__label">{children}</span>
      {keyHint ? <kbd className="d-btn__kbd" aria-hidden="true">{keyHint}</kbd> : null}
    </button>
  );
}
```

`packages/ui/src/Button/Button.css`:
```css
.d-btn {
  display: inline-flex; align-items: center; gap: 8px;
  height: 28px; padding: 0 10px;
  font: inherit; font-size: var(--text-sm); font-weight: var(--weight-label);
  color: var(--fg); background: var(--surface-2);
  border: 1px solid var(--hairline-2); border-radius: var(--r-md);
  cursor: pointer; transition: background var(--duration-fast), border-color var(--duration-fast), color var(--duration-fast);
}
.d-btn[data-size="sm"] { height: 22px; padding: 0 7px; font-size: var(--text-xs); }
.d-btn:hover { background: var(--surface-hi); border-color: var(--fg-3); }
.d-btn[data-variant="accent"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.d-btn[data-variant="accent"]:hover { background: var(--accent-2); }
.d-btn[data-variant="danger"] { color: var(--danger); border-color: var(--danger); background: transparent; }
.d-btn[data-variant="danger"]:hover { background: color-mix(in srgb, var(--danger) 15%, transparent); }
.d-btn[data-variant="ghost"] { background: transparent; border-color: transparent; color: var(--fg-2); }
.d-btn[data-variant="ghost"]:hover { color: var(--fg); background: var(--surface-2); }
.d-btn[aria-pressed="true"] { background: var(--danger); color: var(--accent-ink); border-color: var(--danger); }
.d-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.d-btn__kbd { font: inherit; font-size: var(--text-micro); padding: 0 4px; border: 1px solid currentColor; border-radius: var(--r-md); opacity: 0.8; }
```

`packages/ui/src/index.ts`:
```ts
export { Button } from './Button/Button.tsx';
export type { ButtonProps } from './Button/Button.tsx';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test --workspace packages/ui`
Expected: PASS (5 tests).

- [ ] **Step 6: Write the story**

`packages/ui/src/Button/Button.stories.tsx`:
```tsx
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './Button.tsx';

const meta = { title: 'Primitives/Button', component: Button, args: { children: 'Save changes' } } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Accent: Story = { args: { variant: 'accent', keyHint: '⌘↵' } };
export const Danger: Story = { args: { variant: 'danger', children: 'Leave voice', keyHint: 'X' } };
export const Ghost: Story = { args: { variant: 'ghost', children: 'Cancel', keyHint: 'esc' } };
export const Pressed: Story = { args: { pressed: true, children: 'Mute', keyHint: 'M' } };
export const Small: Story = { args: { size: 'sm', children: 'Verify' } };
```

- [ ] **Step 7: Commit**

```bash
git add packages/ui package-lock.json
git commit -s -m "feat(ui): package scaffold, base styles, Button with tests and stories"
```

---

### Task 6: Pill, Tag and KeyHint

**Files:**
- Create: `packages/ui/src/Pill/Pill.tsx`, `Pill.css`, `Pill.stories.tsx`
- Create: `packages/ui/src/Tag/Tag.tsx`, `Tag.css`, `Tag.stories.tsx`
- Create: `packages/ui/src/KeyHint/KeyHint.tsx`, `KeyHint.css`, `KeyHint.stories.tsx`
- Test: `packages/ui/src/Pill/Pill.test.tsx`, `packages/ui/src/Tag/Tag.test.tsx`, `packages/ui/src/KeyHint/KeyHint.test.tsx`
- Modify: `packages/ui/src/index.ts`

**Interfaces:**
- Consumes: base styles, `expectNoAxeViolations`.
- Produces: `Pill({ kind: 'unread' | 'mention'; count: number })` with accessible name "N unread" / "N mentions"; `Tag({ kind: 'bot' | 'web' | 'admin' | 'readable' | 'canHear' })`; `KeyHint({ keys: string[]; label?: string })`.

- [ ] **Step 1: Write the failing tests**

`packages/ui/src/Pill/Pill.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Pill } from './Pill.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('Pill', () => {
  it('names unread and mention counts for assistive tech', () => {
    render(<><Pill kind="unread" count={4} /><Pill kind="mention" count={12} /></>);
    expect(screen.getByText('4')).toHaveAccessibleName('4 unread');
    expect(screen.getByText('12')).toHaveAccessibleName('12 mentions');
  });
  it('caps display at 99+', () => {
    render(<Pill kind="unread" count={140} />);
    expect(screen.getByText('99+')).toHaveAccessibleName('140 unread');
  });
  it('renders nothing for zero', () => {
    const { container } = render(<Pill kind="unread" count={0} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><Pill kind="mention" count={1} /></div>);
    await expectNoAxeViolations(container);
  });
});
```

`packages/ui/src/Tag/Tag.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Tag } from './Tag.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('Tag', () => {
  it('renders text tags', () => {
    render(<><Tag kind="bot" /><Tag kind="web" /><Tag kind="admin" /><Tag kind="canHear" /></>);
    expect(screen.getByText('bot')).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('can hear')).toBeInTheDocument();
  });
  it('renders the readable-channel glyph with an accessible name and no visible text', () => {
    render(<Tag kind="readable" />);
    const glyph = screen.getByRole('img', { name: 'Readable by this server' });
    expect(glyph).toHaveTextContent('◌');
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><Tag kind="web" /><Tag kind="readable" /></div>);
    await expectNoAxeViolations(container);
  });
});
```

`packages/ui/src/KeyHint/KeyHint.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { KeyHint } from './KeyHint.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('KeyHint', () => {
  it('renders each key as kbd and the label as text', () => {
    render(<KeyHint keys={['⌘', 'K']} label="cmd" />);
    expect(screen.getAllByRole('presentation')).toHaveLength(0);
    expect(screen.getByText('⌘').tagName).toBe('KBD');
    expect(screen.getByText('K').tagName).toBe('KBD');
    expect(screen.getByText('cmd')).toBeInTheDocument();
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><KeyHint keys={['/']} label="search" /></div>);
    await expectNoAxeViolations(container);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace packages/ui`
Expected: three "Failed to resolve import" failures.

- [ ] **Step 3: Write the components**

`packages/ui/src/Pill/Pill.tsx`:
```tsx
import './Pill.css';
export type PillProps = { kind: 'unread' | 'mention'; count: number };
export function Pill({ kind, count }: PillProps) {
  if (count <= 0) return null;
  const label = kind === 'unread' ? `${count} unread` : `${count} ${count === 1 ? 'mention' : 'mentions'}`;
  return <span className="d-pill" data-kind={kind} aria-label={label} role="status">{count > 99 ? '99+' : count}</span>;
}
```

`packages/ui/src/Pill/Pill.css`:
```css
.d-pill { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 16px; padding: 0 5px; font-size: var(--text-micro); font-weight: 700; border-radius: var(--r-pill); }
.d-pill[data-kind="unread"] { background: var(--accent); color: var(--accent-ink); }
.d-pill[data-kind="mention"] { background: var(--mention); color: var(--mention-ink); }
```

`packages/ui/src/Tag/Tag.tsx`:
```tsx
import './Tag.css';
export type TagKind = 'bot' | 'web' | 'admin' | 'readable' | 'canHear';
const TEXT: Record<Exclude<TagKind, 'readable'>, string> = { bot: 'bot', web: 'web', admin: 'admin', canHear: 'can hear' };
export function Tag({ kind }: { kind: TagKind }) {
  if (kind === 'readable') return <span className="d-tag d-tag--glyph" role="img" aria-label="Readable by this server">◌</span>;
  return <span className="d-tag" data-kind={kind}>{TEXT[kind]}</span>;
}
```

`packages/ui/src/Tag/Tag.css`:
```css
.d-tag { display: inline-block; font-size: 9px; font-weight: var(--weight-label); letter-spacing: var(--label-tracking); text-transform: uppercase; line-height: 14px; padding: 0 4px; border: 1px solid var(--hairline-2); border-radius: var(--r-md); color: var(--fg-3); vertical-align: 1px; }
.d-tag[data-kind="admin"] { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.d-tag[data-kind="canHear"] { color: var(--warn); border-color: var(--warn); }
.d-tag--glyph { border: 0; padding: 0; font-size: var(--text-xs); line-height: 1; color: var(--fg-3); text-transform: none; letter-spacing: 0; }
```

`packages/ui/src/KeyHint/KeyHint.tsx`:
```tsx
import './KeyHint.css';
export type KeyHintProps = { keys: string[]; label?: string };
export function KeyHint({ keys, label }: KeyHintProps) {
  return (
    <span className="d-keyhint">
      {keys.map((k, i) => <kbd key={i} className="d-keyhint__kbd">{k}</kbd>)}
      {label ? <span className="d-keyhint__label">{label}</span> : null}
    </span>
  );
}
```

`packages/ui/src/KeyHint/KeyHint.css`:
```css
.d-keyhint { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-micro); letter-spacing: var(--label-tracking); text-transform: uppercase; color: var(--fg-3); }
.d-keyhint__kbd { font: inherit; padding: 0 5px; line-height: 16px; border: 1px solid var(--hairline-2); border-radius: var(--r-md); color: var(--fg-2); }
```

Add to `packages/ui/src/index.ts`:
```ts
export { Pill } from './Pill/Pill.tsx';
export type { PillProps } from './Pill/Pill.tsx';
export { Tag } from './Tag/Tag.tsx';
export type { TagKind } from './Tag/Tag.tsx';
export { KeyHint } from './KeyHint/KeyHint.tsx';
export type { KeyHintProps } from './KeyHint/KeyHint.tsx';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --workspace packages/ui`
Expected: PASS (all Button, Pill, Tag, KeyHint tests).

- [ ] **Step 5: Write the stories**

`packages/ui/src/Pill/Pill.stories.tsx`:
```tsx
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Pill } from './Pill.tsx';
const meta = { title: 'Primitives/Pill', component: Pill } satisfies Meta<typeof Pill>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unread: Story = { args: { kind: 'unread', count: 4 } };
export const Mention: Story = { args: { kind: 'mention', count: 12 } };
export const Capped: Story = { args: { kind: 'unread', count: 140 } };
```

`packages/ui/src/Tag/Tag.stories.tsx`:
```tsx
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Tag } from './Tag.tsx';
const meta = { title: 'Primitives/Tag', component: Tag } satisfies Meta<typeof Tag>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Bot: Story = { args: { kind: 'bot' } };
export const Web: Story = { args: { kind: 'web' } };
export const Admin: Story = { args: { kind: 'admin' } };
export const CanHear: Story = { args: { kind: 'canHear' } };
export const ReadableGlyph: Story = { args: { kind: 'readable' } };
```

`packages/ui/src/KeyHint/KeyHint.stories.tsx`:
```tsx
import type { Meta, StoryObj } from '@storybook/react-vite';
import { KeyHint } from './KeyHint.tsx';
const meta = { title: 'Primitives/KeyHint', component: KeyHint } satisfies Meta<typeof KeyHint>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Palette: Story = { args: { keys: ['⌘', 'K'], label: 'cmd' } };
export const Search: Story = { args: { keys: ['/'], label: 'search' } };
export const Help: Story = { args: { keys: ['?'], label: 'help' } };
```

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src
git commit -s -m "feat(ui): Pill, Tag with the readable-channel glyph, KeyHint"
```

---

### Task 7: Avatar and ChannelRow

**Files:**
- Create: `packages/ui/src/Avatar/Avatar.tsx`, `Avatar.css`, `Avatar.stories.tsx`
- Create: `packages/ui/src/ChannelRow/ChannelRow.tsx`, `ChannelRow.css`, `ChannelRow.stories.tsx`
- Test: `packages/ui/src/Avatar/Avatar.test.tsx`, `packages/ui/src/ChannelRow/ChannelRow.test.tsx`
- Modify: `packages/ui/src/index.ts`

**Interfaces:**
- Consumes: `Pill`, `Tag`.
- Produces: `Avatar({ name: string; initials?: string; hue?: number; presence?: 'online' | 'idle' | 'dnd' | 'offline'; size?: 'sm' | 'md' | 'lg' })` exposing `role="img"` with name "jonas, online"; `ChannelRow({ name, kind: 'text' | 'voice', active?, unread?, mentions?, muted?, readable?, private?, onSelect })` rendering a `button` with `aria-current="page"` when active.

- [ ] **Step 1: Write the failing tests**

`packages/ui/src/Avatar/Avatar.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Avatar } from './Avatar.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('Avatar', () => {
  it('derives initials and announces presence in the name', () => {
    render(<Avatar name="jonas" presence="online" />);
    const img = screen.getByRole('img', { name: 'jonas, online' });
    expect(img).toHaveTextContent('JO');
  });
  it('uses given initials and omits presence text when unknown', () => {
    render(<Avatar name="Skald" initials="SK" />);
    expect(screen.getByRole('img', { name: 'Skald' })).toHaveTextContent('SK');
  });
  it('shows presence with a glyph, not only colour', () => {
    render(<Avatar name="lina" presence="idle" />);
    expect(screen.getByRole('img', { name: 'lina, idle' }).querySelector('[data-presence="idle"]')).not.toBeNull();
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><Avatar name="erik" presence="dnd" size="lg" /></div>);
    await expectNoAxeViolations(container);
  });
});
```

`packages/ui/src/ChannelRow/ChannelRow.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ChannelRow } from './ChannelRow.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('ChannelRow', () => {
  it('is a button named after the channel and selectable by keyboard', async () => {
    const onSelect = vi.fn();
    render(<ChannelRow name="loot" kind="text" onSelect={onSelect} />);
    const row = screen.getByRole('button', { name: /^loot/ });
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
  it('marks the active channel with aria-current', () => {
    render(<ChannelRow name="loot" kind="text" active onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: /^loot/ })).toHaveAttribute('aria-current', 'page');
  });
  it('shows unread and mention pills and the readable glyph', () => {
    render(<><ChannelRow name="screenshots" kind="text" unread={3} mentions={12} onSelect={() => {}} /><ChannelRow name="lfg" kind="text" readable onSelect={() => {}} /></>);
    expect(screen.getByLabelText('3 unread')).toBeInTheDocument();
    expect(screen.getByLabelText('12 mentions')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Readable by this server' })).toBeInTheDocument();
  });
  it('shows the lock on private voice channels and a muted state', () => {
    render(<ChannelRow name="sauna" kind="voice" private muted onSelect={() => {}} />);
    const row = screen.getByRole('button', { name: /^sauna/ });
    expect(row).toHaveAttribute('data-muted', 'true');
    expect(screen.getByRole('img', { name: 'Private' })).toBeInTheDocument();
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><ChannelRow name="loot" kind="text" active unread={4} onSelect={() => {}} /></div>);
    await expectNoAxeViolations(container);
  });
});
```

- [ ] **Step 2: Run to verify failure, then write the components**

Run: `npm test --workspace packages/ui` → two "Failed to resolve import" failures.

`packages/ui/src/Avatar/Avatar.tsx`:
```tsx
import './Avatar.css';
export type Presence = 'online' | 'idle' | 'dnd' | 'offline';
export type AvatarProps = { name: string; initials?: string; hue?: number; presence?: Presence; size?: 'sm' | 'md' | 'lg' };

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return s.toUpperCase();
}
function deriveHue(name: string): number {
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h;
}
const GLYPH: Record<Presence, string> = { online: '●', idle: '◐', dnd: '⊘', offline: '○' };

export function Avatar({ name, initials, hue, presence, size = 'md' }: AvatarProps) {
  const label = presence ? `${name}, ${presence}` : name;
  return (
    <span className="d-avatar" data-size={size} role="img" aria-label={label} style={{ ['--avatar-hue' as string]: String(hue ?? deriveHue(name)) }}>
      <span className="d-avatar__initials" aria-hidden="true">{initials ?? deriveInitials(name)}</span>
      {presence ? <span className="d-avatar__presence" data-presence={presence} aria-hidden="true">{GLYPH[presence]}</span> : null}
    </span>
  );
}
```

`packages/ui/src/Avatar/Avatar.css`:
```css
.d-avatar { position: relative; display: inline-flex; align-items: center; justify-content: center; width: var(--avatar-size); height: var(--avatar-size); border-radius: var(--r-avatar); background: hsl(var(--avatar-hue) 45% 42%); color: #fff; font-weight: 700; font-size: var(--text-xs); flex-shrink: 0; }
.d-avatar[data-size="sm"] { width: 20px; height: 20px; font-size: 9px; }
.d-avatar[data-size="lg"] { width: 64px; height: 64px; font-size: var(--text-lg); }
.d-avatar__presence { position: absolute; right: -4px; bottom: -4px; width: 12px; height: 12px; border-radius: var(--r-pill); font-size: 8px; line-height: 12px; text-align: center; background: var(--bg-2); }
.d-avatar__presence[data-presence="online"] { color: var(--ok); }
.d-avatar__presence[data-presence="idle"] { color: var(--warn); }
.d-avatar__presence[data-presence="dnd"] { color: var(--danger); }
.d-avatar__presence[data-presence="offline"] { color: var(--fg-3); }
```

`packages/ui/src/ChannelRow/ChannelRow.tsx`:
```tsx
import { Pill } from '../Pill/Pill.tsx';
import { Tag } from '../Tag/Tag.tsx';
import './ChannelRow.css';

export type ChannelRowProps = {
  name: string; kind: 'text' | 'voice'; active?: boolean; unread?: number; mentions?: number;
  muted?: boolean; readable?: boolean; private?: boolean; onSelect: () => void;
};

export function ChannelRow({ name, kind, active, unread = 0, mentions = 0, muted, readable, private: isPrivate, onSelect }: ChannelRowProps) {
  return (
    <button type="button" className="d-chrow" data-kind={kind} data-muted={muted ? 'true' : undefined}
      data-unread={unread > 0 || mentions > 0 ? 'true' : undefined} aria-current={active ? 'page' : undefined} onClick={onSelect}>
      <span className="d-chrow__glyph" aria-hidden="true">{kind === 'text' ? '#' : '♪'}</span>
      <span className="d-chrow__name">{name}</span>
      {readable ? <Tag kind="readable" /> : null}
      {isPrivate ? <span className="d-chrow__lock" role="img" aria-label="Private">🔒</span> : null}
      <span className="d-chrow__spacer" />
      {mentions > 0 ? <Pill kind="mention" count={mentions} /> : unread > 0 ? <Pill kind="unread" count={unread} /> : null}
    </button>
  );
}
```

`packages/ui/src/ChannelRow/ChannelRow.css`:
```css
.d-chrow { display: flex; align-items: center; gap: 8px; width: 100%; padding: var(--row-pad-y) 8px; margin: var(--row-gap) 0; font: inherit; font-size: var(--text-base); color: var(--fg-2); background: transparent; border: 0; border-radius: var(--r-md); text-align: left; cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast); }
.d-chrow:hover { background: var(--surface-2); color: var(--fg); }
.d-chrow[aria-current="page"] { background: var(--surface-hi); color: var(--fg); box-shadow: inset 3px 0 0 var(--accent); }
.d-chrow[data-unread="true"] { color: var(--fg); font-weight: 700; }
.d-chrow[data-muted="true"] { opacity: 0.55; }
.d-chrow__glyph { width: 12px; text-align: center; color: var(--fg-3); }
.d-chrow__lock { font-size: 10px; filter: grayscale(1); opacity: 0.7; }
.d-chrow__spacer { flex: 1; }
```

Add to `packages/ui/src/index.ts`:
```ts
export { Avatar } from './Avatar/Avatar.tsx';
export type { AvatarProps, Presence } from './Avatar/Avatar.tsx';
export { ChannelRow } from './ChannelRow/ChannelRow.tsx';
export type { ChannelRowProps } from './ChannelRow/ChannelRow.tsx';
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npm test --workspace packages/ui`
Expected: PASS.

- [ ] **Step 4: Write the stories**

`packages/ui/src/Avatar/Avatar.stories.tsx`:
```tsx
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Avatar } from './Avatar.tsx';
const meta = { title: 'Primitives/Avatar', component: Avatar, args: { name: 'jonas' } } satisfies Meta<typeof Avatar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Online: Story = { args: { presence: 'online' } };
export const Idle: Story = { args: { name: 'lina', presence: 'idle' } };
export const DoNotDisturb: Story = { args: { name: 'erik', presence: 'dnd' } };
export const Offline: Story = { args: { name: 'sven', presence: 'offline' } };
export const Bot: Story = { args: { name: 'Skald', initials: 'SK', hue: 210 } };
export const Large: Story = { args: { size: 'lg', presence: 'online' } };
```

`packages/ui/src/ChannelRow/ChannelRow.stories.tsx`:
```tsx
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChannelRow } from './ChannelRow.tsx';
const meta = { title: 'Primitives/ChannelRow', component: ChannelRow, args: { onSelect: () => {} },
  decorators: [Story => <div style={{ width: 240, background: 'var(--bg-2)', padding: 8 }}><Story /></div>] } satisfies Meta<typeof ChannelRow>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Text: Story = { args: { name: 'general', kind: 'text' } };
export const Active: Story = { args: { name: 'loot', kind: 'text', active: true, unread: 4 } };
export const Mentions: Story = { args: { name: 'screenshots', kind: 'text', unread: 3, mentions: 12 } };
export const ReadableByServer: Story = { args: { name: 'lfg', kind: 'text', readable: true } };
export const Voice: Story = { args: { name: 'longhouse', kind: 'voice' } };
export const PrivateVoice: Story = { args: { name: 'sauna', kind: 'voice', private: true } };
export const Muted: Story = { args: { name: 'random', kind: 'text', muted: true } };
```

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src
git commit -s -m "feat(ui): Avatar with presence glyphs, ChannelRow with pills, readable glyph and lock"
```

---

### Task 8: StatusBar and Dialog

**Files:**
- Create: `packages/ui/src/StatusBar/StatusBar.tsx`, `StatusBar.css`, `StatusBar.stories.tsx`
- Create: `packages/ui/src/Dialog/Dialog.tsx`, `Dialog.css`, `Dialog.stories.tsx`
- Test: `packages/ui/src/StatusBar/StatusBar.test.tsx`, `packages/ui/src/Dialog/Dialog.test.tsx`
- Modify: `packages/ui/src/index.ts`

**Interfaces:**
- Consumes: `KeyHint`.
- Produces: `StatusBar({ position: 'top' | 'bottom'; label: string; children })` as `role="toolbar"`; `StatusChunk({ label?: string; children; onClick?; tone?: 'ok' | 'warn' | 'danger' })` rendering a `button` when clickable, else a `span`; `Meter({ levels: number[] })` twelve bars, `aria-hidden`; `BrandMark()`; `Dialog({ open, title, onClose, children, footer? })` on the native `<dialog>`.

- [ ] **Step 1: Write the failing tests**

`packages/ui/src/StatusBar/StatusBar.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { StatusBar, StatusChunk, Meter, BrandMark } from './StatusBar.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('StatusBar', () => {
  it('is a labelled toolbar with clickable and static chunks', async () => {
    const onClick = vi.fn();
    render(
      <StatusBar position="bottom" label="Connection">
        <StatusChunk label="node">dilla.thim.dev</StatusChunk>
        <StatusChunk label="voice" tone="ok" onClick={onClick}>OPUS 48kHz</StatusChunk>
      </StatusBar>,
    );
    expect(screen.getByRole('toolbar', { name: 'Connection' })).toBeInTheDocument();
    expect(screen.getByText('dilla.thim.dev').closest('button')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /voice OPUS 48kHz/ }));
    expect(onClick).toHaveBeenCalled();
  });
  it('renders the brand mark with the product name readable once', () => {
    render(<StatusBar position="top" label="Session"><BrandMark /></StatusBar>);
    expect(screen.getByText('DILLA')).toBeInTheDocument();
    expect(screen.queryByText('D')).toHaveAttribute('aria-hidden', 'true');
  });
  it('meter is decorative', () => {
    const { container } = render(<Meter levels={[1, 3, 5, 2, 0, 4, 6, 2, 1, 3, 2, 1]} />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelectorAll('i')).toHaveLength(12);
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><StatusBar position="top" label="Session"><BrandMark /><StatusChunk>server Midgard Crew</StatusChunk></StatusBar></div>);
    await expectNoAxeViolations(container);
  });
});
```

`packages/ui/src/Dialog/Dialog.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Dialog } from './Dialog.tsx';
import { Button } from '../Button/Button.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('Dialog', () => {
  it('opens as a modal dialog named by its title and closes on Escape', async () => {
    const onClose = vi.fn();
    render(<Dialog open title="Leave voice?" onClose={onClose}><p>You can rejoin any time.</p></Dialog>);
    const dialog = screen.getByRole('dialog', { name: 'Leave voice?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('renders nothing visible when closed', () => {
    render(<Dialog open={false} title="Hidden" onClose={() => {}}><p>x</p></Dialog>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('has a close button in the footer by default', async () => {
    const onClose = vi.fn();
    render(<Dialog open title="Verify device" onClose={onClose}><p>Compare the code.</p></Dialog>);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><Dialog open title="Leave voice?" onClose={() => {}} footer={<Button variant="danger">Leave</Button>}><p>You can rejoin any time.</p></Dialog></div>);
    await expectNoAxeViolations(container);
  });
});
```

- [ ] **Step 2: Run to verify failure, then write the components**

Run: `npm test --workspace packages/ui` → two "Failed to resolve import" failures.

`packages/ui/src/StatusBar/StatusBar.tsx`:
```tsx
import type { ReactNode } from 'react';
import './StatusBar.css';

export function StatusBar({ position, label, children }: { position: 'top' | 'bottom'; label: string; children: ReactNode }) {
  return <div className="d-statusbar" data-position={position} role="toolbar" aria-label={label}>{children}</div>;
}

export function StatusChunk({ label, children, onClick, tone }: { label?: string; children: ReactNode; onClick?: () => void; tone?: 'ok' | 'warn' | 'danger' }) {
  const inner = <>{label ? <span className="d-chunk__k">{label}</span> : null}<span className="d-chunk__v" data-tone={tone}>{children}</span></>;
  return onClick
    ? <button type="button" className="d-chunk d-chunk--clickable" onClick={onClick}>{inner}</button>
    : <span className="d-chunk">{inner}</span>;
}

/** Twelve-bar audio meter, decorative: the accessible state lives on the mute button. */
export function Meter({ levels }: { levels: number[] }) {
  const bars = Array.from({ length: 12 }, (_, i) => Math.max(0, Math.min(6, levels[i] ?? 0)));
  return <span className="d-meter" aria-hidden="true">{bars.map((h, i) => <i key={i} style={{ height: `${2 + h * 1.5}px` }} />)}</span>;
}

export function BrandMark() {
  return (
    <span className="d-brand">
      <span className="d-brand__tile" aria-hidden="true">D</span>
      <span className="d-brand__name">DILLA</span>
      <span className="d-brand__caret" aria-hidden="true" />
    </span>
  );
}
```

`packages/ui/src/StatusBar/StatusBar.css`:
```css
.d-statusbar { display: flex; align-items: stretch; gap: 0; background: var(--bg-2); font-size: var(--text-micro); letter-spacing: var(--label-tracking); text-transform: uppercase; color: var(--fg-3); white-space: nowrap; overflow: hidden; }
.d-statusbar[data-position="top"] { height: var(--topbar-h); border-bottom: 1px solid var(--hairline); }
.d-statusbar[data-position="bottom"] { height: var(--bottombar-h); border-top: 1px solid var(--hairline); }
.d-chunk { display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; border-right: 1px solid var(--hairline); font: inherit; color: inherit; background: transparent; }
.d-chunk--clickable { cursor: pointer; border-top: 0; border-bottom: 0; border-left: 0; }
.d-chunk--clickable:hover { color: var(--fg); background: var(--surface-2); }
.d-chunk__k { color: var(--fg-4); }
.d-chunk__v { color: var(--fg-2); font-weight: var(--weight-label); }
.d-chunk__v[data-tone="ok"] { color: var(--ok); }
.d-chunk__v[data-tone="warn"] { color: var(--warn); }
.d-chunk__v[data-tone="danger"] { color: var(--danger); }
.d-meter { display: inline-flex; align-items: flex-end; gap: 1px; height: 11px; margin-left: 6px; }
.d-meter i { display: block; width: 3px; background: var(--accent); }
.d-brand { display: inline-flex; align-items: center; gap: 7px; padding: 0 12px; font-weight: 700; color: var(--fg); letter-spacing: 0.14em; }
.d-brand__tile { width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; background: var(--accent); color: var(--accent-ink); border-radius: var(--r-md); font-size: var(--text-xs); letter-spacing: 0; }
.d-brand__caret { width: 6px; height: 12px; background: var(--accent); animation: d-blink var(--duration-caret) steps(1) infinite; }
@keyframes d-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .d-brand__caret { animation: none; } }
```

`packages/ui/src/Dialog/Dialog.tsx`:
```tsx
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import './Dialog.css';

export type DialogProps = { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode };

export function Dialog({ open, title, onClose, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog ref={ref} className="d-dialog" aria-labelledby="d-dialog-title" aria-modal="true"
      onCancel={e => { e.preventDefault(); onClose(); }}
      onClick={e => { if (e.target === ref.current) onClose(); }}>
      <div className="d-dialog__panel" onClick={e => e.stopPropagation()}>
        <h2 id="d-dialog-title" className="d-dialog__title">{title}</h2>
        <div className="d-dialog__body">{children}</div>
        <div className="d-dialog__footer">
          <Button variant="ghost" keyHint="esc" onClick={onClose}>Close</Button>
          {footer}
        </div>
      </div>
    </dialog>
  );
}
```

`packages/ui/src/Dialog/Dialog.css`:
```css
.d-dialog { padding: 0; border: 1px solid var(--accent); border-radius: var(--r-lg); background: var(--surface); color: var(--fg); box-shadow: var(--shadow-2); max-width: min(560px, calc(100vw - 32px)); }
.d-dialog::backdrop { background: rgba(0, 0, 0, 0.6); }
.d-dialog__panel { padding: 16px 18px; font-family: var(--font-mono); }
.d-dialog__title { margin: 0 0 10px; font-size: var(--text-lg); font-weight: var(--weight-display); letter-spacing: 0.02em; }
.d-dialog__body { font-size: var(--text-base); color: var(--fg-2); }
.d-dialog__footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
```

Add to `packages/ui/src/index.ts`:
```ts
export { StatusBar, StatusChunk, Meter, BrandMark } from './StatusBar/StatusBar.tsx';
export { Dialog } from './Dialog/Dialog.tsx';
export type { DialogProps } from './Dialog/Dialog.tsx';
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npm test --workspace packages/ui`
Expected: PASS. If jsdom reports `showModal is not a function`, add to `src/test/setup.ts`:
```ts
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
}
```

- [ ] **Step 4: Write the stories**

`packages/ui/src/StatusBar/StatusBar.stories.tsx`:
```tsx
import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusBar, StatusChunk, Meter, BrandMark } from './StatusBar.tsx';
const meta = { title: 'Chrome/StatusBar', component: StatusBar } satisfies Meta<typeof StatusBar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Top: Story = {
  args: { position: 'top', label: 'Session', children: null },
  render: args => (
    <StatusBar {...args}>
      <BrandMark />
      <StatusChunk>server Midgard Crew</StatusChunk>
      <StatusChunk>node home-1</StatusChunk>
      <StatusChunk tone="ok">● ready</StatusChunk>
    </StatusBar>
  ),
};
export const Bottom: Story = {
  args: { position: 'bottom', label: 'Connection', children: null },
  render: args => (
    <StatusBar {...args}>
      <StatusChunk label="node">dilla.thim.dev</StatusChunk>
      <StatusChunk label="latency">14ms p50</StatusChunk>
      <StatusChunk label="voice" tone="ok" onClick={() => {}}>OPUS 48kHz @ 96kbps<Meter levels={[1, 3, 5, 2, 0, 4, 6, 2, 1, 3, 2, 1]} /></StatusChunk>
      <StatusChunk label="v">0.1.0-dev</StatusChunk>
    </StatusBar>
  ),
};
```

`packages/ui/src/Dialog/Dialog.stories.tsx`:
```tsx
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Dialog } from './Dialog.tsx';
import { Button } from '../Button/Button.tsx';
const meta = { title: 'Chrome/Dialog', component: Dialog, args: { open: true, title: 'Leave voice?', onClose: () => {} } } satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Confirm: Story = { args: { children: <p>You can rejoin longhouse any time.</p>, footer: <Button variant="danger" keyHint="↵">Leave</Button> } };
export const Info: Story = { args: { title: 'Compare the code', children: <p>Read the six digits aloud. They must match on every screen.</p> } };
```

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src
git commit -s -m "feat(ui): StatusBar with chunks, meter and brand mark; native Dialog"
```

---

### Task 9: Storybook with the a11y addon, theme and density toolbar, axe test-runner, CI

**Files:**
- Create: `packages/ui/.storybook/main.ts`
- Create: `packages/ui/.storybook/preview.tsx`
- Create: `packages/ui/.storybook/test-runner.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: every story.
- Produces: `npm run storybook -w packages/ui` (dev), `npm run build-storybook -w packages/ui`, `npm run test:storybook -w packages/ui` (axe on every story, fails on serious or critical), the `ui` CI job.

- [ ] **Step 1: Storybook configuration**

`packages/ui/.storybook/main.ts`:
```ts
import type { StorybookConfig } from '@storybook/react-vite';
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: {} },
};
export default config;
```

`packages/ui/.storybook/preview.tsx`:
```tsx
import type { Preview } from '@storybook/react-vite';
import '../src/styles/base.css';

const preview: Preview = {
  globalTypes: {
    theme: { description: 'Theme', toolbar: { title: 'Theme', items: ['mesh', 'light', 'high-contrast'], dynamicTitle: true } },
    density: { description: 'Density', toolbar: { title: 'Density', items: ['compact', 'regular', 'cozy'], dynamicTitle: true } },
  },
  initialGlobals: { theme: 'mesh', density: 'regular' },
  decorators: [
    (Story, ctx) => {
      document.documentElement.dataset.theme = ctx.globals.theme;
      document.documentElement.dataset.density = ctx.globals.density;
      return <div className="d-root" style={{ padding: 16, minHeight: 120 }}><Story /></div>;
    },
  ],
  parameters: { a11y: { test: 'error' }, backgrounds: { disable: true } },
};
export default preview;
```

`packages/ui/.storybook/test-runner.ts`:
```ts
import type { TestRunnerConfig } from '@storybook/test-runner';
import { injectAxe, checkA11y } from 'axe-playwright';

const config: TestRunnerConfig = {
  async preVisit(page) { await injectAxe(page); },
  async postVisit(page) {
    await checkA11y(page, '#storybook-root', { detailedReport: true, detailedReportOptions: { html: true }, includedImpacts: ['critical', 'serious'] });
  },
};
export default config;
```

- [ ] **Step 2: Build Storybook and run the test-runner locally**

Run:
```bash
npm run build -w packages/design-tokens
npx playwright install --with-deps chromium
npm run build-storybook -w packages/ui
npx --workspace packages/ui concurrently -k -s first -n SB,TEST \
  "npx http-server packages/ui/storybook-static --port 6006 --silent" \
  "npx wait-on tcp:127.0.0.1:6006 && npm run test:storybook -w packages/ui -- --url http://127.0.0.1:6006"
```
Expected: every story passes with no serious or critical axe violations. If `color-contrast` fails on a story, the token is wrong: fix it in `packages/design-tokens/src/tokens.ts` (and the brief) and rebuild; do not disable the rule.

- [ ] **Step 3: Add the CI job**

Append to `.github/workflows/ci.yml` under `jobs:`:
```yaml
  ui:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run build -w packages/design-tokens
      - run: git diff --exit-code -- packages/design-tokens/dist
      - run: npm test -w packages/design-tokens
      - run: npm test -w packages/ui
      - run: npx playwright install --with-deps chromium
      - run: npm run build-storybook -w packages/ui
      - name: axe on every story
        run: |
          npx --workspace packages/ui concurrently -k -s first -n SB,TEST \
            "npx http-server packages/ui/storybook-static --port 6006 --silent" \
            "npx wait-on tcp:127.0.0.1:6006 && npm run test:storybook -w packages/ui -- --url http://127.0.0.1:6006"
```

Add `packages/ui/storybook-static/` to `.gitignore`.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/.storybook .github/workflows/ci.yml .gitignore
git commit -s -m "ci(ui): Storybook with a11y addon, theme and density toolbar, axe test-runner"
```

---

### Task 10: UI copy lint — vocabulary and no encryption markers

**Files:**
- Create: `scripts/check-ui-copy.mjs`
- Test: `scripts/check-ui-copy.test.mjs`
- Modify: `package.json` (root scripts `check:copy`, `test`)

**Interfaces:**
- Consumes: `packages/ui/src/**/*.tsx`.
- Produces: `npm run check:copy` failing on any forbidden word inside string literals or JSX text in the UI package; the only allowed occurrence is the readable glyph's accessible name.

- [ ] **Step 1: Write the failing test**

`scripts/check-ui-copy.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCopy, findForbidden } from './check-ui-copy.mjs';

test('extracts string literals and JSX text, not identifiers', () => {
  const src = `const team = 1; export function X() { return <span title="Leave voice">Message #loot {team} 'kanal'</span>; }`;
  const copy = extractCopy(src);
  assert.ok(copy.includes('Leave voice'));
  assert.ok(copy.includes('Message #loot'));
  assert.ok(copy.includes('kanal'));
  assert.ok(!copy.some(c => c.trim() === 'team'));
});

test('flags forbidden vocabulary and encryption markers, case-insensitively', () => {
  assert.deepEqual(findForbidden(['Message #loot']), []);
  assert.deepEqual(findForbidden(['Your kanals']).map(f => f.word), ['kanal']);
  assert.deepEqual(findForbidden(['messages are end-to-end encrypted']).map(f => f.word), ['end-to-end', 'encrypted']);
  assert.deepEqual(findForbidden(['E2E', 'SRTP · OPUS', 'Signal Protocol', 'SQLCipher', 'AES-256', 'via MLS', 'PMs']).map(f => f.word), ['E2E', 'SRTP', 'Signal Protocol', 'SQLCipher', 'AES-256', 'MLS', 'PMs']);
});

test('allows the readable glyph accessible name', () => {
  assert.deepEqual(findForbidden(['Readable by this server']), []);
});
```

- [ ] **Step 2: Run it to verify it fails, then write the script**

Run: `node --test scripts/check-ui-copy.test.mjs` → FAIL, module not found.

`scripts/check-ui-copy.mjs`:
```js
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORBIDDEN = [
  { word: 'kanal', re: /\bkanals?\b/i }, { word: 'team', re: /\bteams?\b/i }, { word: 'PMs', re: /\bPMs\b/ },
  { word: 'E2E', re: /\bE2EE?\b/ }, { word: 'end-to-end', re: /\bend-to-end\b/i }, { word: 'encrypted', re: /\bencrypted\b/i },
  { word: 'encryption', re: /\bencryption\b/i }, { word: 'SRTP', re: /\bSRTP\b/ }, { word: 'X3DH', re: /\bX3DH\b/ },
  { word: 'Signal Protocol', re: /\bSignal Protocol\b/i }, { word: 'SQLCipher', re: /\bSQLCipher\b/i },
  { word: 'AES-256', re: /\bAES-\d{3}\b/ }, { word: 'MLS', re: /\bMLS\b/ },
];

/** Pull string literals ('…', "…", `…`) and JSX text nodes out of a TSX source. Approximate by design. */
export function extractCopy(source) {
  const out = [];
  for (const m of source.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3]);
  for (const m of source.matchAll(/>([^<>{}]+)</g)) { const t = m[1].trim(); if (t) out.push(t); }
  return out;
}

export function findForbidden(copy) {
  const hits = [];
  for (const text of copy) for (const f of FORBIDDEN) if (f.re.test(text)) hits.push({ word: f.word, text });
  return hits;
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, acc); }
    else if (/\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

export function checkUiCopy(root) {
  const problems = [];
  for (const file of walk(join(root, 'packages', 'ui', 'src'))) {
    for (const hit of findForbidden(extractCopy(readFileSync(file, 'utf8')))) problems.push(`${file}: "${hit.word}" in "${hit.text}"`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkUiCopy(process.argv[2] ?? process.cwd());
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('ui copy: ok');
}
```

Run: `node --test scripts/check-ui-copy.test.mjs` → PASS (3 tests).

- [ ] **Step 3: Wire it in and run against the real package**

Root `package.json` scripts: add `"check:copy": "node scripts/check-ui-copy.mjs"` and `"test:copy-check": "node --test scripts/check-ui-copy.test.mjs"`, and make `"test"` = `"npm run check:docs && npm run check:brief && npm run check:copy && npm test --workspaces --if-present"`. Add `npm run test:copy-check` to the CI `node` job after `test:brief-check`.

Run: `npm run check:copy`
Expected: `ui copy: ok`. (The Tag test file contains the words `bot`, `web`, `admin`, `can hear` and `Readable by this server`, none forbidden; the Dialog test contains `Verify device`, allowed.)

- [ ] **Step 4: Commit**

```bash
git add scripts/check-ui-copy.mjs scripts/check-ui-copy.test.mjs package.json .github/workflows/ci.yml
git commit -s -m "chore: lint UI copy for vocabulary and encryption markers"
```

---

## Self-review

**Spec coverage.** Design brief with tokens, layout, exclusion list, trust facts, glyph, brand mark, sound, motion, themes, accessibility model, flow schedule, attribution: Task 1. Token package with role-colour-safe palette, three themes, density, focus ring, motion honouring reduced motion, sound tokens, CSS variables and a TS module, AA contrast guard: Tasks 2–4. Component library primitives with Storybook and axe: Tasks 5–9 (Button, Pill, Tag with the readable glyph, KeyHint, Avatar with non-colour presence, ChannelRow with `aria-current`, StatusBar chunks and meter, BrandMark with a reduced-motion-safe caret, native Dialog with focus trap and Esc). "The client ships no Discord colours, icons, sounds or typefaces" and "no encryption markers": Task 10's lint plus the brief's exclusion list; fonts self-hosted through Fontsource. Web tag and bot "can hear" kept visible: `Tag` kinds `web` and `canHear`. Not in this plan (later cards): the composer, message row, virtualised log, member list, voice tile, command palette, keyboard-only Playwright traversal, the sound files, and the wireframes themselves (`docs/design/flows/` is scheduled in the brief).

**Placeholder scan.** No "TBD", "TODO", "later" as an instruction, "similar to Task N". Every component step has the component, its CSS, its test and its story.

**Type consistency.** `expectNoAxeViolations(container)` from `src/test/setup.ts` is used identically in every test. `Tag` kind `canHear` is spelled the same in the component, test and stories. `Pill` accessible names ("4 unread", "12 mentions") match the ChannelRow test's `getByLabelText`. Token keys in `tokens.ts` (`bg2`, `surfaceHi`, `accentInk`, `mentionInk`, `linkUnderline`) map through `kebab()` to the custom properties the CSS files use (`--bg-2`, `--surface-hi`, `--accent-ink`, `--mention-ink`, `--link-underline`). `structural.layout.railW` → `--rail-w`, `bottombarH` → `--bottombar-h`, as the CSS tests and `StatusBar.css` expect. The `themes` record keys equal the `data-theme` values in `renderCss()` and in the Storybook toolbar.

**Colour numbers, checked against the guard.** Mesh `fg3` was raised from the handoff's `#5E635E` (3.3:1 on `#070809`) to `#767C76` (4.7:1) to pass the 4.5:1 text rule; the original value survives as `fg4` for decorative use only. All other mesh pairs listed in `TEXT_PAIRS` and `UI_PAIRS` exceed their thresholds at the values given; the light and high-contrast values were chosen to pass the same pairs, and Task 3 Step 3 says what to do if the test disagrees: change the value, never the threshold.
