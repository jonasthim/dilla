# Task 3 report — routing and edit guard contracts

## Delivered

- Router imports and re-exports `SettingsSection` and `ServerSettingsSection` from the settings registry and validates URL section IDs against `SETTINGS_REGISTRY`.
- `/settings` is `{ name: 'settings', section: null }`; unknown user sections resolve to that root route.
- Added server settings routes at `/c/:communityId/settings[/:section]`, with unknown sections resolving to the server settings root. Spotify callback parsing remains first.
- Settings origins are validated as same-origin non-settings paths and persist across user/server settings navigation. `baseRoute` unwraps both route kinds.
- Added indexed history coordination. Entry positions are contiguous on the active history branch and recomputed after Back/Forward, so a push after Back replaces the forward branch at its adjacent position.
- Guarded router navigation and browser traversal. Native pop is restored before confirmation; only accepted traversal emits `subscribeCommittedTraversal`. `goBack(expect)` uses that committed traversal stream.
- Exported:
  - `setNavigationGuard(guard: (() => Promise<boolean>) | null): () => void`
  - `requestNavigation(action: () => void): Promise<boolean>`
  - `subscribeCommittedTraversal(listener: () => void): () => void`
  - `pushHistoryState(state, title?, url?)` / `replaceHistoryState(state, title?, url?)`
  - `useRoute()` navigation function now returns `Promise<boolean>`; without a guard, navigation performs synchronously before returning a resolved promise.
- Added `SettingsEditProvider`, `useSettingsEdit`, and `useSettingsWorkspace`. State operations stay in refs; provider snapshots contain only dirty/busy/canSave booleans, avoiding loops from inline state objects and keeping fresh save/reset closures.
- Added local copy in `strings/settingsEditing.ts`.

## Primary wiring contract

Wrap each settings workspace in `<SettingsEditProvider>`. A section calls `useSettingsEdit({ dirty, busy, canSave, save, reset })`; it returns true when managed. Render `useSettingsWorkspace()?.footer` in SettingsFrame's footer and `useSettingsWorkspace()?.confirmation` once in the workspace layer. Use its `requestNavigation` for external departure actions and `clear()` when permission loss invalidates a draft.

Replace app-owned raw history writes with the exported indexed helpers. Replace app-owned popstate reactions (phone sheets and pending tab transitions) with `subscribeCommittedTraversal`, so those effects run only after the router guard accepts the traversal.

The `useRoute` navigation callback can now be awaited. A false result means keep editing canceled the route change; true means it was accepted. This is for guarded incoming-call joins and notification thread dispatch.

## Verification

- `npm test -- --run src/router.test.tsx src/settings/edit-state.test.tsx`: **72/72 passed**. Includes actual jsdom History back-branching (start → A → B → Back → C), restoration/replay, accepted-only traversal notification, declined `goBack(expect)`, and inline state/fresh operation closure behavior.
- `npm run typecheck`: passed after the integrated `MusicProviderStatus.tsx` file appeared in the shared worktree.
