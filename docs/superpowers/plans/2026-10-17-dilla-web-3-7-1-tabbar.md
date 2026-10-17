# dilla v0.1.0-web3.7.1: the phone tab bar stays on every screen

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** On a phone, the bottom tab bar (Servers · DMs · Activity · You) stays on every screen, and it hides only while the person is typing.

**Why:** Jonas, 2026-10-17, after using web3.7 on his iPhone: "Bottom nav is not kept throughout the app on mobile." web3.7 hid the tab bar on every pushed view: a channel, a DM, the call stage, Settings and the sheets. Jonas reverses that choice (plan web3.7, Part 1: "Jonas can flip this at the design review").

**Architecture:**
- The AppShell renders the tab bar on both phone panes.
- The shell marks "typing" while an editable element in the shell has focus. That is when iOS opens its keyboard, and CI can also check it.
- On phones, Settings becomes a non-modal page that ends above the tab bar.
- The aside sheets (members, threads, pins) end above the tab bar, and tapping a tab closes them.

**Tech stack:** React 19, TypeScript, CSS in `packages/ui`, Vitest, Playwright (`e2e/web/phone.spec.ts`).

## Global Constraints

- Desktop (≥ 48rem) is unchanged: the same DOM and CSS. Every existing desktop test passes unchanged.
- Phone breakpoint `(max-width: 47.99rem)` (`PHONE_QUERY`). No change.
- "Typing": an `input` (other than checkbox, radio, range, button and file), a `textarea`, a `select` or a `[contenteditable]` inside the shell root has focus. While typing, the tab bar has `hidden` and is out of the accessibility tree. The call bar stays.
- Touch targets stay ≥ 44px. Focus order: … main, the aside, the call bar, the tab bar.
- No new copy keys. No change to routes, the server, the client core, or the store schema (it stays 5).
- Release `v0.1.0-web3.7.1`. Rolling back to web3.7 is safe (no data change).
- Tapping the current tab while in its pushed view goes to that tab's list (the iOS convention). Tapping another tab goes to that tab's remembered route, as today.

## Review Focus

1. The composer stays above the iOS keyboard, and no tab bar sits between them. The tab bar hides on focus and returns on blur, with no layout jump into a zoom.
2. Settings on a phone: Escape and the back control still close it, focus goes to its title on open, the tab bar under it works, and leaving via a tab closes Settings (the route changes).
3. A sheet is open and the person taps a tab: the sheet closes, its history entry is popped exactly once, and the new tab shows.
4. The safe area at the bottom is padded exactly once. The tab bar pads it; the composer and call bar no longer pad it when the tab bar is below them.
5. An incoming call ring and the link banner still sit above everything, and the call bar sits between main and the tab bar.

---

### Task 1: The tab bar on every phone screen (sonnet)

**Files:**
- Modify: `packages/ui/src/AppShell/AppShell.tsx`. Render the tab bar on both panes (today it renders only when `listPane`, near line 178). Add a "typing" state and measure `--d-tabbar-h`.
- Modify: `packages/ui/src/styles/base.css` (lines 54-84, phone grid and safe-area rules).
- Modify: `packages/ui/src/SettingsFrame/SettingsFrame.tsx` and `SettingsFrame.css`, plus `packages/web/src/app.css:205-209` (the phone settings frame).
- Modify: `packages/web/src/screens/Shell.tsx`. Make the tab `onSelect` (near line 1248) pop to the list for the current tab, and close an open sheet first.
- Tests:
  - `packages/ui/src/AppShell/AppShell.test.tsx`
  - `packages/ui/src/SettingsFrame/SettingsFrame.test.tsx`
  - `packages/web/src/screens/Shell.phone.test.tsx`
  - `e2e/web/phone.spec.ts`
  - the AppShell phone stories (add a "view pane with tab bar" story and a "typing" story).

**Interfaces:**
- `AppShell`: no new prop. On phones it sets `data-typing="true"` on `.d-app-shell` while typing. It also sets `--d-tabbar-h` on the root to the tab bar's `offsetHeight` (0 when hidden), using the same ResizeObserver pattern as `--d-ring-h` (AppShell.tsx near line 125).
- `SettingsFrame`: inside the phone layout context (`packages/ui/src/internal/phoneLayout.ts`), it opens with `dialog.show()` instead of `showModal()`. It keeps:
  - focus on the title when it opens;
  - Escape → `onClose`, through its own keydown handler, because a non-modal dialog does not fire `cancel`.

  Its CSS on phones: `position: fixed; inset: 0 0 auto 0; height: calc(var(--d-vvh, 100dvh) - var(--d-tabbar-h, 0px)); z-index` below the ring.
  - The implementer first checks that Settings and ServerSettings render inside the AppShell's `PhoneLayoutProvider`. If they don't, add a prop `modal?: boolean` (default true) and pass `modal={!phone}` from both screens.
- The aside on phones (`overlay`): the sheet ends at `bottom: var(--d-tabbar-h)`. The tab bar is no longer `inert` while a sheet is open; the backdrop and main stay inert.
- `Shell.tsx` tab select, in order:
  1. If a sheet is open, close it through its existing close path (`usePhoneSheet`'s `close()`, which pops its own history entry).
  2. If `id === phoneTab` and `phonePane === 'view'`, go to the tab's root list: `/c/:cid` for servers (the current community), `/dm`, `/activity` or `/you`.
  3. Otherwise go to `tabTarget(id)`, as today.

- [ ] **Step 1: Write the failing tests.**
  - **AppShell.test.tsx:**
    - With `layout="phone" phonePane="view"`, the tab bar is in the DOM after the call bar.
    - Focusing a `textarea` inside main sets `data-typing="true"`, and the tab bar wrapper has `hidden`.
    - Blurring clears both.
    - Focusing a checkbox does not set typing.
    - With `layout="desktop"`, there is no tab bar wrapper and no `data-typing`.
  - **SettingsFrame.test.tsx:**
    - Inside the phone provider, `showModal` is not called (spy on `HTMLDialogElement.prototype.showModal`) and `show` is called.
    - Escape calls `onClose`.
    - The title gets focus.
    - On desktop, `showModal` is still called.
  - **Shell.phone.test.tsx:**
    - On `/c/:cid/:ch` the tab bar is present.
    - Selecting `servers` navigates to `/c/:cid`.
    - Selecting `dms` from a channel goes to the remembered DMs route.
    - Inside an open members sheet, selecting `activity` closes the sheet and lands on `/activity`, with `history.length` unchanged by the sheet: its entry was popped.
    - On `/settings/devices`, the tab bar is present and selecting `servers` leaves Settings.
- [ ] **Step 2: Run them and see them fail.**
  - Run `npm test -w @dilla/ui -- AppShell SettingsFrame` and `npm test -w @dilla/web -- Shell.phone`.
  - Expected: FAIL. The tab bar is missing on the view pane, `showModal` is called, and the current-tab select does not pop.
- [ ] **Step 3: Implement** the Interfaces above.
  - CSS:
    - `.d-app-shell[data-layout="phone"][data-typing="true"] .d-app-shell__tabbar { display: none; }`. The `hidden` attribute does the same; keep both so that a story without JS state still matches.
    - The composer's bottom padding is `0.5rem` when a tab bar follows, and `max(0.5rem, env(safe-area-inset-bottom))` only while typing or with no tab bar.
    - Thread-pane composer: the same rule.
    - The call bar's existing `:not(:has(+ .d-app-shell__tabbar))` rule stays, and now also applies while typing.
- [ ] **Step 4: Run the unit gates.**
  - `npm test -w @dilla/ui`, `npm test -w @dilla/web`, `npm run typecheck`, `npm run lint` and `npm run check:copy`.
  - Storybook axe on `AppShell/`, with strict target size.
  - Expected: all PASS.
- [ ] **Step 5: e2e.** In `e2e/web/phone.spec.ts`, at 390×844 in Chromium and WebKit:
  - The tab bar is visible:
    - on a channel view, on a DM view and on the call stage;
    - in Settings, both `/you` → settings and the server settings;
    - with the members sheet open.
  - Focusing the composer hides the tab bar, `visualViewport.scale` stays 1, and the composer's bottom is ≤ the viewport's bottom. Blurring (tap the message log) shows the tab bar again.
  - In a channel view, tapping Servers shows the channel list. Tapping DMs then Servers returns to that channel list, the remembered route.
  - Before running, rebuild the stale artifacts:
    - the wasm pkg (`build-wasm-pkg.sh`);
    - the WASI fixture (`build-wasi.sh`);
    - the release testkit;
    - `packages/web/dist`;
    - `npm run build:harness -w @dilla/client-core`.
  - Run `npx playwright test e2e/web/phone.spec.ts --project=chromium-web --project=webkit-web`, then the full `e2e/web` suite on chromium to catch older specs that assumed no tab bar in a view.
- [ ] **Step 6: Screenshots.** Using the existing phone shoot path (phone.spec's 390×844 WebKit context, persistent profile), take these four shots in Mesh, light and dark:
  - a channel with the tab bar;
  - a channel while typing (tab bar gone);
  - Settings with the tab bar;
  - the members sheet with the tab bar.

  Write them to `target/ui-screens/web3.7.1/`.
- [ ] **Step 7: Docs.**
  - In `docs/user/` (the "On your phone" section) and the README, say the tabs stay on every screen and step aside while you type. Re-shoot the doc screenshots that show a phone view.
  - Write `docs/deploy/releases/v0.1.0-web3.7.1.md`:
    - What's new: the bottom tabs stay on every phone screen; Settings on a phone is a page under the tabs; tapping the current tab returns to its list.
    - Operator notes: no migration (the server stays at 18); no client store change (it stays 5); rollback to web3.7 is safe; reload open tabs to get the change; no config changes.
- [ ] **Step 8: Commit** with `git commit -s`, message `feat(web): the phone tab bar stays on every screen and steps aside while typing`.

### Task 2: Review (opus) and release (controller)

- [ ] An opus task review of the diff against this plan and the Review Focus, including a run of `phone.spec.ts` on WebKit.
- [ ] Jonas sees the four shots before the merge.
- [ ] PR, CI green, merge, tag `v0.1.0-web3.7.1`.
  - Verify the release assets: sha256, `dillad version`, and the install.sh tag.
  - Set the release notes with `gh release edit --notes-file`.
- [ ] Ask Homelab to deploy, with the operator notes. The deploy message says plainly that rolling back to web3.7 is safe and that nothing changes in any browser's data.
