# Voice controls as icons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the voice controls icon buttons, as in Discord: mute, deafen, camera, share screen and leave. All five also sit in the left-hand voice dock, not only on the call stage.

**Architecture:**
- A vendored monoline icon set (Lucide, pinned, ISC licence) is drawn through one `Icon` primitive in packages/ui.
- `VoiceToolbar` (packages/ui/src/CallControls) renders each control as an icon-only button with a visible tooltip.
- `VoiceDock` gains camera and share. `CallControls` keeps its five controls.
- packages/web wires the dock's camera and share to the same call handlers the stage uses.

**Tech stack:** React 19, packages/ui (Storybook + axe), Vitest, Playwright voice e2e.

**Source:** Jonas, 2026-10-15: "design of voice controls we need to be more of icons similar to discord. Like mute. Deafen, leave. Also camera / screenshare should fit in the left hand side menu together with the mentioned ones." It ships in v0.1.0-web3.6, beside the second-factor wave, as lane VI. It shares no files with that wave.

## Global Constraints

- **Icons**
  - Fetched from upstream Lucide at a pinned tag, never drawn from memory.
  - Put each download in its own new, empty directory under the scratchpad.
  - Record the tag and each file's SHA-256 in the vendored file's header.
  - Only the paths are kept: 24×24 viewBox, `stroke="currentColor"`, stroke width 2 at 20px render, `fill="none"`, round caps and joins, `aria-hidden="true"`, `focusable="false"`.
  - The icons used:
    - `mic` / `mic-off`
    - `headphones` / `headphone-off`
    - `video` / `video-off`
    - `monitor-up` (share) / `monitor-x` (stop share)
    - `phone-off` (leave)
- **State is never shown by colour alone** (brief line 213). A toggled-on mute shows `mic-off`, deafen shows `headphone-off`, camera on shows `video`, sharing shows `monitor-x`. The tint follows the existing tokens: `--danger` for mute and deafen when on, and the accent for camera and share when on. Leave is always the danger variant. `aria-pressed` stays on every toggle.
- **The accessible name is unchanged:** the same copy keys as today (`voice.mute`, `voice.deafen`, `voice.cameraOn`, `voice.shareOn`, `voice.leave`). The voice e2e suites find controls by role and name, so the names must not change. No new copy keys are needed. The tooltip shows the label, plus the shortcut where one exists (`Ctrl+Shift+M` / `⌘⇧M` from `VOICE_SHORTCUTS`, by platform).
- **Tooltip:** a CSS/ARIA tooltip shown on hover and on keyboard focus, hidden on Escape (WCAG 1.4.13: dismissable, hoverable, persistent). It is not a `title` attribute. It is linked with `aria-describedby` only when it holds the shortcut, so the name isn't announced twice.
- **Target size:** each icon button is at least 2rem square (32px at the default root), above WCAG 2.5.8's 24px. The dock's five buttons fit in one row of the 15rem sidebar at 360px. If they can't, the dock wraps to two rows; it never scrolls.
- **Focus:** the existing roving `role="toolbar"` with one tab stop, arrows, Home and End. The focus ring is the brief's outline.
- **Tokens only**, no hard-coded colours. Light, dark (Mesh) and high-contrast themes all pass axe in Storybook.
- **Motion:** only a 150 ms colour transition on hover and focus. None under reduced motion.
- **The `[x]` pressed mark is removed** from voice toolbars only. Other Button users keep it.

## Review Focus

1. A screen-reader user hears the same names and states as before: name plus pressed.
2. Keyboard: the tooltip appears on focus, Escape hides it without leaving the call, and the arrows still rove.
3. At 360px and at 200% zoom the dock's five controls stay fully visible.
4. Camera and share in the dock are aria-disabled exactly when the stage's are: paused, no camera, no getDisplayMedia, or joining.
5. High contrast: icons use currentColor, so they follow forced colours (`@media (forced-colors: active)`).

---

## Task VI-1: Icons and the icon toolbar (ui)

**Model:** opus. **Lane:** VI (`/home/thim/.cache/dilla-w3/w3-vi`).

**Files:**
- Create:
  - `packages/ui/src/Icon/icons.ts` (vendored paths with the header)
  - `packages/ui/src/Icon/Icon.tsx`, `Icon.css`, `Icon.test.tsx`, `Icon.stories.tsx`
- Modify:
  - `packages/ui/src/CallControls/CallControls.tsx` and `.css`, `.test.tsx`, `.stories.tsx`
  - `packages/ui/src/VoiceDock/VoiceDock.tsx` and `.css`, `.test.tsx`, `.stories.tsx`
  - `packages/ui/src/index.ts`

**Interfaces:**
- Produces:
  - `Icon({ name: IconName, size?: number })`
  - `ToolbarControl` gains `icon: IconName` and `iconOn?: IconName`
  - `VoiceDockProps` gains `camera: boolean; sharing: boolean; canCamera: boolean; canShare: boolean; onCamera(): void; onShare(): void;` and `labels.camera`, `labels.share`
  - `VoiceDockProps.shortcuts?: { mute: string; deafen: string }` (display strings for the tooltip; the caller formats them per platform)

- [ ] **Step 1.** Fetch the nine icons from Lucide at a pinned tag, then vendor and export the `Icon` component. Test: each name renders one `<svg aria-hidden>` with path data. A snapshot of the path count is enough.
- [ ] **Step 2.** In `VoiceToolbar`, render an icon-only Button. The icon is `on ? iconOn ?? icon : icon`. Name it with `aria-label` (the label), keep `aria-pressed` and the tooltip, and drop the `[x]` text in the toolbar only (a Button prop such as `mark={false}`, if the primitive needs one).
  - Tests, each failing first:
    - the name equals the label;
    - aria-pressed toggles;
    - the icon swaps on toggle;
    - the tooltip shows on focus and hides on Escape;
    - the toolbar keeps roving.
- [ ] **Step 3.** `VoiceDock` renders mute, deafen, camera, share and leave in that order, with camera and share inert under the same rules as CallControls. Tests cover order, inert states and the handlers.
- [ ] **Step 4.** Stories:
  - VoiceDock: connected, muted+deafened, camera+sharing, paused (camera and share inert), at 1280 and 360.
  - CallControls: the same states.
  - Run Storybook axe in all three themes, plus forced colours where the harness supports it.
- [ ] **Step 5.** Gates: ui vitest, `typecheck -w packages/ui`, `build-storybook`, `test:storybook:ci`, downstream `typecheck -w @dilla/web` (web will fail on the new required props until VI-2: make the new dock props optional, or do VI-2 in the same lane before integrating).
- [ ] **Step 6.** Commit: `feat(ui): voice controls as icons, all five in the dock`.

## Task VI-2: Wire the dock and update flow 06 (web)

**Model:** sonnet. **Lane:** VI, after VI-1.

**Files:**
- Modify:
  - `packages/web/src/screens/voice/VoiceView.tsx` (the dock mount, ~:487-520): pass camera, sharing, canCamera, canShare, onCamera and onShare from the same `call` state and handlers as the stage at :203-211, and the platform-formatted shortcut strings.
  - its tests
  - `docs/design/flows/06-*.md` (the dock section: five icon controls, the tooltip, the keyboard map, the focus rules)
- [ ] **Step 1.** Write a failing VoiceView test: the dock shows camera and share; pressing the dock's camera calls the same toggle as the stage's; both are aria-disabled while paused.
- [ ] **Step 2.** Implement, and run G-web.
- [ ] **Step 3.** Run the voice e2e suites (chromium and firefox, `test:e2e:voice:*`) locally. Names are unchanged, so they should pass. Fix any locator that relied on visible text.
- [ ] **Step 4.** Re-shoot the voice screenshots for docs/user (`docs:shots`), and add a sentence about the dock controls to docs/user's voice section.
- [ ] **Step 5.** Commit: `feat(web): camera and screen share in the voice dock`.

## After the tasks (controller)

- One opus review covering design (Mesh, Jonas's taste), accessibility and the tooltip.
- Send screenshots to Jonas.
- Integrate into the web3.6 branch, and add one README "what works" line.
