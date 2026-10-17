# dilla v0.1.0-web3.7.2: the keyboard gap and the mute colour on phones

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** On an iPhone with the keyboard open, the shell sits flush on the keyboard: no empty band between them and no header cut off at the top. A muted mic in the phone call bar reads as off (red), not as on (green).

**Why:** Jonas, 2026-10-17, on web3.7.1, with screenshots from an iPhone in Safari:
- **The keyboard:** a DM with the keyboard up shows an empty black band of about 95 CSS px between the call bar and the keyboard, and the channel header is gone off the top ("This is also a bug").
- **Mute:** the call bar's mute button is filled green while muted ("Why is the unmute button green?").

**Root causes:**
1. **The keyboard band.**
   - What happens: iOS Safari pans the visual viewport inside the layout viewport when the keyboard opens, so `visualViewport.offsetTop > 0`.
   - Why the shell moves: it is in normal flow at the top of the layout viewport, with height `var(--d-vvh)`. It therefore covers `[0, vvh]` while the screen shows `[offsetTop, offsetTop + vvh]`.
   - The result: the top `offsetTop` pixels (the header) are off screen, and the same height of bare page shows below the shell, as the band.
   - Why tests missed it: Playwright emulation never opens a soft keyboard, so `offsetTop` stays 0 in every e2e.
2. **Mute.** `CallBar` renders mute as `<Button pressed={muted}>`. The Button primitive's pressed style is the accent fill. The desktop `CallControls` already overrides that for mute and deafen: a danger glyph and edge, no fill (`CallControls.css:21-28`). The call bar never got that rule.

## Global Constraints

- **Desktop:** unchanged, both DOM and CSS. It never has `--d-vvtop` set.
- **Keyboard position:** `useVisualViewportHeight` (packages/web/src/layout.ts:27) also keeps `--d-vvtop` on `<html>`, equal to `visualViewport.offsetTop` in px, updated on the same resize and scroll events. It removes the property on unmount, like `--d-vvh`.
- **The phone shell:** `position: fixed; top: var(--d-vvtop, 0px); left: 0; right: 0; height: var(--d-shell-h, var(--d-vvh, 100dvh))`. Stories that set `--d-shell-h` keep working; a story host sets `position: relative` back through its own wrapper if needed. The implementer checks the AppShell phone stories still render inside their frames.
- **Elements fixed to the layout viewport:** on a phone, these add `var(--d-vvtop, 0px)` to their top:
  - the ring (base.css:48);
  - the non-modal Settings frame (base.css:118);
  - `.dw-search` and `.dw-other-tab--overlay` (app.css:42, 47).

  They must follow the visual viewport too.
- **Page scroll:** with the shell fixed, the page itself must not scroll on a phone. `html, body { overflow: hidden; }` applies only under the phone media query `(max-width: 47.99rem)`. The message log and the lists keep their own scrolling.
- **Mute:** a pressed mute in the call bar has the danger glyph and edge on `--surface-2`, with no fill, matching the desktop rule. Its label and `aria-pressed` are unchanged. Leave keeps its danger outline. Mute must stay distinguishable from leave: mute has the 2px pressed underline (`box-shadow: inset 0 -2px 0 0 currentColor`) and leave has none, as on desktop.
- **No other changes:** no copy, route, server or store change. Release v0.1.0-web3.7.2. Rolling back to web3.7.1 is safe.

## Review Focus

1. **Keyboard closes:** `offsetTop` returns to 0, `--d-vvtop` to 0px, and nothing is left shifted.
2. **Nested scrolling:** with `overflow: hidden` on html and body, the message log, lists, Settings and sheets still scroll by touch.
3. **Ring and Settings:** an incoming-call ring and phone Settings both stay on screen with the keyboard open.
4. **Pinch-zoom:** the visual viewport pans with an `offsetTop` too, but the person chose that. The shell following the pan is acceptable; it must not jump or loop.
5. **Mute in all three themes:** light and high-contrast keep enough contrast (danger on surface-2) and ≥ 3:1 for the edge.

---

### Task 1: The shell follows the visual viewport; the call bar's mute reads as off (sonnet)

**Files:**
- Modify:
  - `packages/web/src/layout.ts` (useVisualViewportHeight);
  - `packages/ui/src/styles/base.css` (lines 48, 53, 118);
  - `packages/web/src/app.css` (lines 1, 42, 47, plus the phone media query);
  - `packages/ui/src/CallBar/CallBar.css`.
- Tests:
  - `packages/web/src/layout.test.ts`;
  - a CSS pin test next to the existing base.css pins (`packages/web/src/layout.test.ts` already reads base.css);
  - `packages/ui/src/CallBar/CallBar.test.tsx`;
  - the CallBar stories (a muted story in each theme);
  - `e2e/web/phone.spec.ts`.

- [ ] **Step 1: Write the failing tests.**
  - **layout.test.ts:**
    - With a stubbed `visualViewport` whose `offsetTop` is 95, `--d-vvtop` is `95px`.
    - It follows a scroll event to 0, then `0px`.
    - It is removed on unmount.
  - **The CSS pin test:**
    - base.css's phone shell rule contains `position: fixed` and `top: var(--d-vvtop, 0px)`.
    - The ring and modeless Settings rules include `var(--d-vvtop, 0px)`.
    - app.css has `overflow: hidden` for html and body inside `@media (max-width: 47.99rem)`.
  - **CallBar.test.tsx:**
    - A muted call bar's mute button has `aria-pressed="true"`.
    - The stylesheet rule `.d-call-bar .d-call-bar__mute[aria-pressed="true"]` sets `color: var(--danger)` and `background: var(--surface-2)`. Read CallBar.css as text, as other CSS pins in the repo do.
- [ ] **Step 2: Run them and see them fail.**
  - Run `npm test -w @dilla/web -- layout` and `npm test -w @dilla/ui -- CallBar`.
  - Expected: FAIL.
- [ ] **Step 3: Implement** the Global Constraints.
  - For the call bar, copy the desktop rule's values into `CallBar.css`: color, border-color, background and the inset underline, plus a `:hover` on `--surface-hi`.
- [ ] **Step 4: e2e.** In phone.spec, at 390×844 on chromium-web:
  - The shell's computed `position` is `fixed`.
  - After `page.evaluate` sets `--d-vvtop` to `95px` on `<html>`, the shell's bounding box top is 95. This stands in for the iOS pan, which Playwright cannot produce.
  - The muted call bar button's computed background is not the accent colour.
  - Before running, rebuild `packages/web/dist`. Then run `npm run test:e2e:web:chromium -w @dilla/e2e -- web/phone.spec.ts web/threads.spec.ts web/voice` (or whichever web specs touch the call bar).
- [ ] **Step 5: Gates.**
  - The ui and web unit tests, `npx tsc -p packages/ui --noEmit`, the web typecheck script, `npm run lint` and `npm run check:copy`.
  - Storybook axe on `CallBar/` and `AppShell/`.
- [ ] **Step 6: Shots.** In Chromium at 390×844, in Mesh, light and high-contrast, shoot `target/ui-screens/web3.7.2/`:
  - the call bar muted;
  - a DM with the composer focused and `--d-vvtop` forced to 95px.
- [ ] **Step 7: Release notes.** Write `docs/deploy/releases/v0.1.0-web3.7.2.md`.
  - What's new: on an iPhone the screen sits flush on the keyboard, with no empty band and the header kept; a muted mic in the phone call bar shows red, not green.
  - Operator notes:
    - no migration (18) and no client store change (5); rolling back to web3.7.1 is safe;
    - the browser wasm core is unchanged: it is the same `dilla_core_wasm_bg-<hash>.wasm` file as web3.7, so the name proves it;
    - reload open tabs; no config changes.
- [ ] **Step 8: Commit** with `git commit -s` as `fix(web): the phone shell follows the visual viewport, and a muted call bar reads as off`.

### Task 2: Review (opus), CI, release (controller)

- [ ] An opus task review against the Review Focus.
- [ ] Send Jonas the shots.
- [ ] PR, CI green (WebKit included), merge, tag, verify the assets, set the release notes, and ask Homelab to deploy.
- [ ] Jonas confirms the keyboard on his iPhone. CI can't test this; the e2e only forces the offset.
