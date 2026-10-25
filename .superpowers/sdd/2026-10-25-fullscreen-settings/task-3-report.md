# Task 3 report — routing and edit guard contracts

## Delivered

- Router imports and re-exports `SettingsSection` and `ServerSettingsSection` from the settings registry and validates URL section IDs against `SETTINGS_REGISTRY`.
- `/settings` is `{ name: 'settings', section: null }`; unknown user settings sections resolve to that root route.
- Added server settings routes at `/c/:communityId/settings[/:section]`, with unknown sections resolving to the server settings root. Spotify callback parsing remains first.
- Settings origins are validated as same-origin non-settings paths and persist across user/server settings navigation. `baseRoute` unwraps both route kinds.
- Added indexed history coordination, guarded `navigate`/browser traversal/`goBack`, state-only route notifications, and history write helpers:
  - `setNavigationGuard(guard: (() => Promise<boolean>) | null): () => void`
  - `requestNavigation(action: () => void): Promise<boolean>`
  - `pushHistoryState(state, title?, url?)` / `replaceHistoryState(state, title?, url?)`
- Added `SettingsEditProvider`, `useSettingsEdit`, and `useSettingsWorkspace` in `settings/edit-state.tsx`. The provider supplies the shared Save/Reset footer, confirmation dialog, dirty/busy router guard, `beforeunload`, and clear behavior. Standalone forms remain unmanaged.
- Added local copy in `strings/settingsEditing.ts`.

## API contract for primary wiring

Wrap the settings workspace in `<SettingsEditProvider>`. A section calls `useSettingsEdit({ dirty, busy, canSave, save, reset })`; it returns true when managed. Render `useSettingsWorkspace()?.footer` in SettingsFrame's footer and `useSettingsWorkspace()?.confirmation` once in the workspace layer. Use its `requestNavigation` for external departure actions and `clear()` when permission loss invalidates a draft. Replace direct app `history.pushState`/`replaceState` calls with the exported helpers so all entries keep their index and route subscribers receive same-URL state updates.

## Verification

- `npm test -- --run src/router.test.tsx src/settings/edit-state.test.tsx`: **69/69 passed**.
- `npm run typecheck`: the router and edit-state errors are resolved. At the last run, the only failure was primary-owned `src/screens/Settings.tsx:121`, where the old non-null section assumption conflicts with the new root `section: null` contract. Primary has been notified.
