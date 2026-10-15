# dilla v0.1.0-web3.5: roles and private channels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a server owner or moderator runs roles and private channels from the web client. They can:
- make, edit, reorder and delete roles, with a name, a colour, "show separately", "anyone can mention" and a permission editor;
- give and take roles from the member list;
- make a channel private when it is created or later, and give roles or people their own settings in a channel;
- mention a role with `@handle`.

Every member's app shows a pin only while its pinner may pin there, and treats `@everyone`/`@here` as a mention only from someone allowed to send it. Each person can set notifications per server.

**Architecture:**
- **dillad.** The overwrite → MLS path already works: `putOverwrite` / `deleteOverwrite` → `materialiseChannel` → `MaterialiseChannelMembers` → `SyncGroupMembers` → Remove and Add proposals → an elected committer (op 17). The client only reads the results. Wave 2a adds:
  - one read route, `GET /v1/communities/{id}/overwrites`;
  - an atomic channel create with overwrites, so a channel is private from birth;
  - a rule that refuses an overwrite change hiding the channel from its own non-owner, non-administrator author.
- **Core (Rust).** Two authority tables and `authority_set`. The pin fold and the mention flag count only senders that the host-served role view allows. Browser ABI 10; local store schema 4.
- **client-core:**
  - routes;
  - a TypeScript port of the Go resolver, checked against frozen Go vectors;
  - a `RolesController` with role, grant, overwrite and private-channel commands;
  - the authority push into the core;
  - per-server notification settings and role-aware mention encoding.
- **packages/ui:** PermissionGrid, ColorSwatches, CheckList, colour dots, and `children` slots in CreateChannel and ChannelSettings.
- **web:**
  - a Roles tab, the role editor and the assign dialog;
  - channel permissions and private create;
  - role mentions, pins gated by rights, and the per-server notification rows;
  - the Shell wiring.
- No migration, no new opcode, no new permission bit.

**Tech Stack:** Go (internal/api), Rust (core/dilla-core, core/dilla-core-wasm), TypeScript (client-core worker, React web, packages/ui and Storybook), Playwright e2e against dilla-testhost.

**Spec:** `docs/superpowers/specs/2026-10-14-discord-parity-roadmap.md`, Wave 2. The controller split it on 2026-10-15:
- **W2a = this plan (web3.5).**
- **W2b = web3.6**, carried in the appendix. Later waves shift one tag.
- Private threads move to a later wave. Cross-server following stays out (spec:225).

The Wave 2 design (opus, 2026-10-15) is carried into this plan in full for W2a and compactly for W2b. Code anchors are on `dilla-web-3-4-admin` @ 29f6d46.

## Global Constraints

- **Models** (roadmap A1, controller ruling 2026-10-15): a task's `Model:` line is binding.
  - sonnet does recipe tasks, and also the doc, `## States` and strings tasks (T1, H1). **No haiku in this wave.**
  - opus does S2, R1 and C4, and every review of those. C2 is implemented on sonnet and reviewed on opus.
- **Reservations:**
  - e2e ports 8491/8492 (E1) and 8493/8494 (E2). 8489/8490 stay spare. 8495–8498 are W2b's.
  - Flow doc 09 (10 is W2b's).
  - No migration (00017 / schema 015 are W2b's), no opcode (55 stays free), no permission bit (24+ stay free).
  - Core local schema: W2a takes `app_meta` `schema` = 4 (today `x'03'`). W2b takes 5.
  - Browser ABI 10 (today 9). W2b takes 11.
- **Never touch `visibility`.** In this wave "private" means exactly this: **the channel has an `@everyone` (kind 0) overwrite whose deny holds `view_channel`.** `visibility` 0 ("private" in channels.go:36) means "not invite-visible" and is a different thing. No brief reads, writes or names it.
- **String prefixes:** new keys use `roles.`, `perm.`, `chperm.`, `mention.` and `serverNotify.`, in the feature files `packages/web/src/strings/{roles,perm,chperm,mention,serverNotify}.ts`.
  - Never add `settings.`, `devices.`, `notify.`, `appearance.`, `shell.` or `signin.` keys: strings.test.ts:66,79 pin their counts.
  - Never add `admin.`, `members.`, `mod.` or `removed.` keys: flow 08's test pins 186.
  - **All W2a copy is written in T1.** No other task adds or edits a key. A task that needs a missing key stops with NEEDS_CONTEXT.
- **Copy:**
  - Chrome (buttons, menu items, nav, toggles) is lower case. Titles, bodies and refusals are sentence case.
  - No `!`.
  - None of these words outside `strings/privacy.ts`: "secure", "safe", "protected", "encrypted", "E2EE", "MLS", "end-to-end".
  - Every key has a `key='value'` pair in flow 09's `## Copy`.
- **Design:** Mesh tokens and packages/ui components only. Keyboard first, visible focus. WCAG 2.2 AA including target size. Works at 360 px and 200 % zoom.
- **Contracts carried from Wave 1.** Name them in every web and ui brief:
  1. **ConfirmDialog:** the caller sets `error` **in the same state update** that sets `busy` to false. Never two updates: the dialog would flash an enabled confirm with no error. Focus goes to the first field, else Cancel, never the destructive button.
  2. **Every dialog returns focus to its opener** on close (save, cancel, Escape, delete, done). jsdom can't prove focus return through portals and the inert drawer, so **each dialog's focus return is asserted in e2e** (E1, E2), not only in Vitest.
  3. **AppShell's narrow member drawer is modal** (the rest is inert). A dialog opened from a drawer row (role assignment) renders through `Dialog`'s portal, as `Moderation.tsx` does, and returns focus to the row's menu trigger through the W1 `asideReturnRef` pattern (Shell.tsx:1004).
  4. **`announce` is a required prop** of every flow and section.
  5. **FakeClient ordering:** a FakeClient command handler that changes state **publishes its slices before it resolves**, as the worker does (the worker awaits its re-reads before the ret). A test that only passes when the slice lands after the resolve hides an ordering bug.
  6. **A worker step that runs once per ready is re-armed on rejoin.** A memo or "done" flag keyed by group or community is cleared when the core is re-attached (controller.ts:2221 clears `this.roles`), when the community is dropped, and when that group is rejoined. Pinned in C4.
- **Behaviour the server owns:** every client gate is advisory. The client handles every refusal with its copy key, never with a raw code alone. The `send_messages` gate in this wave is **advisory only**; W2b enforces it.
- **Test-first:** each behaviour has a test that fails first, then passes. Each logic change has one mutation the tests catch. Record both in the report.
- **Fixture reachability:** any state a test starts from must be reachable from the shipping client. E2E specs start from an EMPTY host and use the shipping UI only.
- **e2e regressions:** before the whole-branch review, re-run every existing spec a W2a change could touch, not only the new ones:
  - `e2e/web/create.spec.ts`, `admin.spec.ts`, `membership.spec.ts`, `badges.spec.ts` and `conversation.spec.ts`;
  - `e2e/voice/controls.spec.ts`.
- **Env dirs:** each lane uses `CARGO_TARGET_DIR=/home/thim/.cache/dilla-w3/<lane>-target` and `GOCACHE=/home/thim/.cache/dilla-w3/<lane>-gocache`.
- **Harness:** single plain commands only: no `&&`, `;`, pipes or `$(...)`. Anything longer goes in a script file under the scratchpad the dispatch names.
- **Commits:** `git commit -s -F <file>`. Every message's body ends with exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01XLFud8eoDaqf8uiZq5wjuP`
- **Process:** no subagents inside a task; no push, tag or release; never a bare `git stash`. A commit-time security scanner flag counts as real until shown otherwise. Ask, don't guess: anything the brief doesn't settle is NEEDS_CONTEXT.

## Review Focus

1. **Stale rank and permissions.** An actor is demoted, or a role moves, while the role editor, the assign dialog or the permissions section is open.
   - Expected: 403/409 gives the right copy, access and roles are re-read, and locked rows refresh.
   - Pinned in C3, WA1, WA2 and WA3.
2. **Losing a channel while busy.** The person was made private-out, or had their role revoked, while composing, with pins open, or in that channel's call.
   - Expected: no crash, `chperm.lostAccess`, navigation away, the call ending through the existing grant sync, and the draft kept.
   - No UI path locks its author out: the S2 rule plus C3's pre-check.
   - Pinned in S2, C3 and W-Shell.
3. **Divergent views across devices and tabs.**
   - Pins appear and disappear only when the authority changes, and are identical on two devices after a reload.
   - A fresh device (authority unknown) still shows pins.
   - A DM is never gated.
   - The core receives `authority_set` exactly once per change, and again after a re-attach or rejoin.
   - Pinned in R1 and C4.
4. **Honest copy:**
   - removed members keep what they have, and joiners see nothing older (E2 asserts "before" isn't shown);
   - the host sees roles, holders and who is in a private channel;
   - send is advisory in W2a;
   - "Has no effect in this version" for the six dead bits;
   - the pins note;
   - no "secure" or "encrypted" outside privacy.ts.
   - Pinned in T1 and H1.
5. **Keyboard and screen reader on dense editors:**
   - 24 permission rows: toggle, and tri-state radiogroups with arrow keys; the disabled reason is announced;
   - colour swatches are named, never colour alone;
   - focus returns to the opener after editor save, delete and assign, including from the modal narrow member drawer;
   - at 360 px / 200 % the permission grid scrolls inside the SettingsFrame;
   - the role-mention listbox announces "role".
   - Pinned in U1, U2, U5, WA1–WA3, E1 and E2.

## Recipe (anchors on `dilla-web-3-4-admin` @ 29f6d46; the full recipe is roadmap Part B)

- **Go handler pattern:** `internal/api/channels.go:286-400` (`Channels.create`):
  1. `enrolledSession` (communities.go:832);
  2. `server.PathID`;
  3. `server.DecodeBody` into a `_ struct{} \`cbor:",toarray"\`` struct. A toarray struct is exact-arity (server/codec.go:29);
  4. `notFound` for a non-member (communities.go:843);
  5. the permission check: `LoadSnapshot(ctx, repo, cid, uid, nil).Resolve(uid).Has(PermX)` (perm.go:195), or `ResolveChannel` with a channel id;
  6. `repo.Tx` with `tx.Audit(...)` (channels.go:377);
  7. `afterCommit(r)` side effects (membership.go:51) and `StructureNotifier.Changed` (op 54);
  8. `server.EncodeBody`.
- **Roles routes:** `Roles.Register` (roles.go:98-107). The roles list handler `list` is at :257. `overwriteTarget` is ~:784-865, `putOverwrite` :876, `deleteOverwrite` :939, `materialiseCommunity` :969. `materialiseChannel` is private.go:262, `MaterialiseChannelMembers` private.go:89. No new route needs `internal/dillad/routes.go`.
- **Go tests:** `internal/api/*_test.go`, package `api_test`. `newEnv(t)` (apitest_test.go:58), `e.Do(method, path, tok, []any{...})` (:130), `e.ErrCode(body)`, and the W1 `changedGW` counters (structurenotify_test.go).
- **Protocol docs:** protocol/09 § Roles (~:353) and § Channels (~:301); protocol/04 § Semantics (~:104-118). Run `npm run check:docs`.
- **Rust core:**
  - local schema in `core/dilla-core/src/client/schema.rs`: the `app_meta` `schema` value at :163/:170, and the migration-block pattern from the v2→v3 step (:300-330);
  - `fold.rs`: `PIN_LATEST` :132, the pin block :306-325, the index-plan test ~:348;
  - `sync.rs`: the mention apply sites :377 and :845;
  - `messages.rs`: `mentions_me_with_roles` :315, and `own_roles_set` :955 as the pattern for a new setter.
- **wasm facade:** `core/dilla-core-wasm/src/facade.rs:649-653` (the `own_roles_set` pattern), `lib.rs:122` `BROWSER_ABI_VERSION`, `tests/node.rs:277`, and `packages/core-wasm/types.test-d.ts`.
- **TS core port:** `packages/client-core/src/core-port.ts`: the interface :115, the wasm handle type :267, the impl :463. Also `testing/fake-core.ts:408`, `worker/world.ts:267` and `sync/testing/model.ts:1572`. Each is the `ownRolesSet` pattern.
- **client-core routes:** `packages/client-core/src/http/routes.ts`. Pattern: `createChannel` :287-295 (encode, `this.body(METHOD, path, bucket, idempotent, {body})`, `atLeast`, `bin/u53/u64/str/opt`, `bounded`). The W1 banner block is :71-87; `revokeInvite` is :398. Tests in `routes.test.ts`: a `CASES` row, a refusal row, input rejects.
- **client-core worker:**
  - the `worker/protocol.ts` Command union;
  - `worker/controller.ts` COMMANDS, ID_FIELDS and ACCEPTS.ready (one entry per line), `VALIDATORS` :370 (spreads per-feature tables), `invalid()`, `dispatch()`;
  - `AdminController` (`admin/controller.ts`: `loadAccess` :104, `forget` :119, the 403 re-read at :366, the post-write reload at :374) is the model for `RolesController`;
  - `publishMembers` is controller.ts:1743-1766;
  - slices go through `this.slices.set(name, value)`; `state/types.ts` SliceName and SliceTypes are ~:141-160;
  - tests in `controller.test.ts` / `admin/controller.test.ts` with `world()` / `toReady()` / `w.call` / `vi.waitFor(() => w.ret(id))`;
  - model doubles live in `sync/testing/model.ts` (RouteName ~:2036, routesFor ~:2582).
- **Protocol vectors in TS tests:** read them the way `cbor/cbor.test.ts:19` does (`readFileSync(new URL('../../../../protocol/vectors/<file>', import.meta.url))`).
- **ui:** `packages/ui/src/<C>/{C.tsx, C.css, C.stories.tsx, C.test.tsx}`. All copy comes through `labels`/props. CSS uses `d-<c>__*` classes and tokens only. Export from `src/index.ts`. Storybook axe, the focus guard (`.storybook/test-runner.ts`) and the target-size rules apply.
- **web:**
  - flows follow `screens/Create.tsx:283-345` (`useCore()`, the running/session/attempt guards, `client.call`, `errorOf(e).code` → `t(key)`);
  - server-settings sections follow `screens/admin/ChannelsSection.tsx` (`useRun`, `SectionProps` from `shared.ts`, rows of Buttons with edit / up / down / delete) and `ServerSettings.tsx`;
  - Vitest with `FakeClient` (`test/fake-client.ts`) and `expectNoAxeViolations`;
  - Shell wiring tests in `screens/Shell*.test.tsx`.
- **e2e:** pattern `e2e/web/admin.spec.ts`: its own `HostConfig` and `startTestHost` in beforeAll, `copy(key)` for names, `signUp` / `completeSignUp`, `launchSecond` for the second browser, `expectAccessible`.

**Gate macros**, run as single commands, one at a time:
- **G-go:** `go vet ./internal/...`, then `go test -race -shuffle=on ./internal/api/... ./internal/gateway/... ./internal/dillad/...`.
- **G-docs:** `npm run check:docs`.
- **G-rust:**
  1. `cargo fmt --all --check`;
  2. `cargo test -p dilla-core --locked`;
  3. `cargo test --workspace --all-features --locked`;
  4. `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`;
  5. `cargo test -p dilla-core-wasm --target wasm32-unknown-unknown --locked`;
  6. `wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir ../../packages/core-wasm/pkg`;
  7. `npm run typecheck -w @dilla/core-wasm`.

  The design named `npm run build -w @dilla/core-wasm`, but that script does not exist. Steps 6–7 are what CI runs (ci.yml:137-145).
- **G-core:** `npm test -w @dilla/client-core`, `npm run typecheck -w @dilla/client-core`, `npx eslint --max-warnings 0 packages/client-core`.
- **G-ui:** `npm test -w packages/ui`, `npm run typecheck -w packages/ui`, `npm run build-storybook -w packages/ui`, `npm run test:storybook:ci -w packages/ui`.
- **G-web:** `npm test -w @dilla/web`, `npm run typecheck -w @dilla/web`, `npx eslint --max-warnings 0 packages/web`, `npm run check:copy`.
- **G-e2e(spec):** `npm run build -w @dilla/web`, then `npm run test:e2e:web:chromium -w @dilla/e2e -- <spec>` (and `:firefox`).

---

## Phase 0: sequential, on the wave branch

### Task T0: Hotspot prep for parallel lanes

**Model:** sonnet. **Lane:** worktree. **Depends on:** —. **Behaviour-preserving**: no visible change.

**Files:**
- Create: `packages/web/src/strings/roles.ts`, `perm.ts`, `chperm.ts`, `mention.ts`, `serverNotify.ts`
- Modify: `packages/web/src/strings/en.ts`
- Create: `packages/web/src/strings/strings.flow09.test.ts`
- Create: `docs/design/flows/09-roles-and-private-channels.md`
- Modify: `packages/web/src/screens/admin/ServerSettings.tsx` (the `AdminTab` union, :14)
- Create: `packages/client-core/src/admin/roles.ts`
- Modify: `packages/client-core/src/worker/controller.ts` (`VALIDATORS` :370-372 and its imports)

- [ ] **Step 1.** Create the five feature string files. Each is exactly this, with its own name and prefix:
  ```ts
  // Flow 09 (docs/design/flows/09-roles-and-private-channels.md): roles and private channels copy. Keys: roles.*
  export const roles = {} as const;   // perm.ts: perm; chperm.ts: chperm; mention.ts: mention; serverNotify.ts: serverNotify
  ```
  In en.ts, import them next to the `moderation` import. Spread `...roles, ...perm, ...chperm, ...mention, ...serverNotify` immediately after `...moderation` in the `en` object.
- [ ] **Step 2.** In ServerSettings.tsx, rewrite the union one member per line, same order, nothing else:
  ```ts
  export type AdminTab =
    | 'overview'
    | 'channels'
    | 'invites'
    | 'bans'
    | 'danger';
  ```
- [ ] **Step 3.** Create `packages/client-core/src/admin/roles.ts`:
  ```ts
  // Wave 2a (flow 09): roles, grants, channel overwrites and private channels. RolesController lands in Task C3.
  /** Per-feature synchronous checks for the wave 2a commands; Task C3 narrows the key type to its methods. */
  export const ROLES_VALIDATORS: Partial<Record<string, (c: Record<string, unknown>) => string | null>> = {};
  ```
  In controller.ts, import it and add `...ROLES_VALIDATORS,` on its own line after `...ADMIN_VALIDATORS,` in `VALIDATORS`.
- [ ] **Step 4.** Create `strings.flow09.test.ts` as a copy of `strings.flow08.test.ts`, with these changes:
  - the describe title: `'flow 09 (v0.1.0-web3.5, roles and private channels)'`;
  - the doc path: `docs/design/flows/09-roles-and-private-channels.md`;
  - the prefix regex: `/^(roles|perm|chperm|mention|serverNotify)\./`;
  - **no** `pairs.length` pin yet (T1 adds it);
  - the States row minimum: 20;
  - a third `it` that declares the lower-case chrome list `const LOWER: readonly string[] = [];` (T1 fills it) and asserts, for each key, `en[key] === en[key].toLowerCase()`.

  The first and third tests pass vacuously. The second (sections) fails until T1, so mark it `it.skip` with the comment `// T1 writes the sections`.
- [ ] **Step 5.** Create `09-roles-and-private-channels.md` with the title `# Flow 09: roles and private channels (v0.1.0-web3.5)` and the empty headings `## States`, `## 1280×800`, `## 360×740`, `## Keyboard map`, `## Focus rules`, `## Announcements`, `## Copy`.
- [ ] **Step 6.** Gates: G-core and G-web. `git diff --stat` lists only the files above.
- [ ] **Step 7.** Commit: `chore: wave 2a string files and flow 09 skeleton`.

### Task X1: Permission vectors frozen from the Go resolver

**Model:** sonnet. **Lane:** worktree. **Depends on:** T0 (order only).

**Files:**
- Create: `protocol/vectors/permissions.json`
- Create: `internal/api/perm_vectors_test.go`
- Modify: `protocol/vectors/README.md` (a table row and a note), `protocol/README.md` (§ Conformance, one sentence)

Every other file in `protocol/vectors/` is generated by `packages/protocol-vectors` and checked by CI. This one is **hand-frozen from Go**: Go is the reference resolver. The generator writes only its own six files (generate.ts:417-422), so CI's "vectors are up to date" step leaves this file alone. If `npm run vectors` deletes or rewrites it, stop with NEEDS_CONTEXT.

- [ ] **Step 1.** Write `permissions.json`. All ids are 32 lower-case hex characters, and bit values are JSON numbers.
  ```json
  { "version": 1,
    "description": "dilla permission resolution (09-http-api.md § Permissions). Frozen from internal/api/perm.go (Go is the reference): community = Snapshot.Resolve(user), channel = Snapshot.ResolveChannel(user) with the case's overwrites.",
    "bits": { "view_channel": 1, "send_messages": 2, "...": "all 24, in perm.go order" },
    "cases": [ { "name": "", "owner": "", "everyone": "", "roles": [{ "id": "", "position": 0, "allow": 0, "deny": 0 }],
                 "held": [], "overwrites": [{ "kind": 0, "target": "", "allow": 0, "deny": 0 }],
                 "user": "", "community": 0, "channel": 0 } ] }
  ```
  - `bits` lists all 24 names as protocol/09 § Permissions spells them, with perm.go's values (`1<<0` … `1<<23`). If 09's spelling differs from `view_channel, send_messages, manage_messages, pin_messages, attach_files, add_reactions, read_history, connect, speak, video, screen_share, create_invite, kick_members, ban_members, manage_channels, manage_roles, manage_community, view_audit_log, mention_everyone, bypass_slowmode, administrator, mute_members, move_members, manage_nicknames`, use 09's spelling and say so in the report.
  - `everyone` is added to the design's case shape: the Go `Snapshot` needs it.

  Fixed ids:

  | id | value |
  |---|---|
  | O (owner) | `0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a` |
  | U (user) | `0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b` |
  | E (@everyone) | `e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0` |
  | A | `a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1` |
  | B | `b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2` |

  Unless a row says otherwise, every case has `owner` O, `everyone` E, `user` U, and the role E at position 0 with allow `EV = 4083` (view, send, attach, react, history, connect, speak, video, screen, invite) and deny 0. `ALL = 16777215`. Exactly these 16 cases, in this order:

  | # | name | roles beyond E (id pos allow deny) | held | overwrites (kind target allow deny) | community | channel |
  |---|---|---|---|---|---|---|
  | 1 | `owner` | — (user = O) | — | 0 E 0 1 | 16777215 | 16777215 |
  | 2 | `everyone_only` | — | — | — | 4083 | 4083 |
  | 3 | `higher_role_deny_wins` | A 2 0 2; B 1 2 0 | A, B | — | 4081 | 4081 |
  | 4 | `higher_role_allow_wins` | A 1 0 2; B 2 2 0 | A, B | — | 4083 | 4083 |
  | 5 | `equal_position_tie_by_id` | A 1 0 2; B 1 2 0 | A, B | — | 4083 | 4083 |
  | 6 | `administrator_role` | A 1 1048576 0 | A | 0 E 0 1 | 16777215 | 16777215 |
  | 7 | `no_view_is_nothing` | A 1 0 1 | A | — | 0 | 0 |
  | 8 | `role_overwrite_denies_view` | — | — | 0 E 0 1 | 4083 | 0 |
  | 9 | `user_overwrite_reallows_view` | — | — | 0 E 0 1; 1 U 1 0 | 4083 | 4083 |
  | 10 | `role_overwrite_reallows_view` | A 1 0 0 | A | 0 E 0 1; 0 A 1 0 | 4083 | 4083 |
  | 11 | `overwrite_kick_ignored` | — | — | 0 E 4096 0 | 4083 | 4083 |
  | 12 | `overwrite_administrator_ignored` | — | — | 1 U 1048576 0 | 4083 | 4083 |
  | 13 | `pin_via_overwrite` | — | — | 0 E 8 0 | 4083 | 4091 |
  | 14 | `mention_everyone_denied_to_everyone` | (E allow 266227) | — | 0 E 0 262144 | 266227 | 4083 |
  | 15 | `user_overwrite_applies_last` | A 1 0 0 | A | 0 A 2 0; 1 U 0 2 | 4083 | 4081 |
  | 16 | `overwrite_cannot_remove_community_bit` | A 1 4096 0 | A | 0 A 0 4096 | 8179 | 8179 |

  The expected columns are the author's hand computation. Write them in, then run Go (Step 3). **If Go disagrees with any value, do not overwrite it. Stop with NEEDS_CONTEXT and quote both values.** Either the arithmetic or the resolver is wrong, and the controller decides which.
- [ ] **Step 2.** Write `perm_vectors_test.go` (package `api_test`). It reads `../../protocol/vectors/permissions.json` and:
  - asserts `len(cases) == 16`;
  - asserts every `bits` entry equals the matching `api.Perm*` constant (a name → constant map in the test);
  - builds an `api.Snapshot{Owner, Everyone, Roles, Held, Overwrite}` per case, with the field types `store.RoleRow` / `store.OverwriteRow` (read their definitions);
  - asserts `Resolve(user) == community` and `ResolveChannel(user) == channel`, naming the case on failure.
- [ ] **Step 3.** Red first: run the test with case 3's `community` set to 4083, show it fail, and restore 4081. Mutation: swap the `&^=` and `|=` lines in `Resolve`, show cases 3, 4 and 5 fail, and revert. Record both.
- [ ] **Step 4.** Docs:
  - In `vectors/README.md`, add the row `` | `permissions.json` | `09-http-api.md` | `community` and `channel` per case: the resolved community-wide and channel bits of `user` (§ Permissions) | ``.
  - Under the table, add: "`permissions.json` is not generated: it is frozen from the Go resolver (`internal/api/perm.go`), which is the reference, and is checked by `internal/api/perm_vectors_test.go` and `packages/client-core/src/admin/perm.test.ts`."
  - In protocol/README § Conformance, add the same sentence after "fails if the committed files differ."
- [ ] **Step 5.** Gates: G-go and G-docs. Also run `npm run vectors --workspaces --if-present`, then `git status --porcelain -- protocol/vectors`. The second must print nothing.
- [ ] **Step 6.** Commit: `test(protocol): permission resolver vectors, frozen from the Go resolver`.

### Task T1: Flow 09 copy and doc

**Model:** sonnet (not haiku). **Lane:** worktree. **Depends on:** T0.

**Files:** `packages/web/src/strings/{roles,perm,chperm,mention,serverNotify}.ts`, `docs/design/flows/09-roles-and-private-channels.md`, `packages/web/src/strings/strings.flow09.test.ts`.

- [ ] **Step 1.** Paste every key below into its feature file, chosen by prefix: `roles.*` → roles.ts, `perm.*` → perm.ts, `chperm.*` → chperm.ts, `mention.*` → mention.ts, `serverNotify.*` → serverNotify.ts.
  - Use admin.ts's style: one `'key': 'value',` per line, in the order below.
  - Values are byte-exact, including the typographic ’ and …. Note that `perm.view` and `perm.view.hint` are two separate flat keys.
  - There are **177** keys: roles 80, perm 56, chperm 31, serverNotify 8, mention 2.

```
roles.tab='roles'  roles.title='Roles'
roles.body='Roles group what people may do. A higher role outranks the ones below it, and you can change only roles below your own highest role. Everyone in the server, and the host, can see every role, its permissions and who holds it.'
roles.new='new role'  roles.everyone='@everyone'
roles.everyoneHint='Everyone in the server holds this role. Its permissions are where every member starts.'
roles.row.one='1 member'  roles.row.other='{count} members'  roles.locked='above your highest role'
roles.edit='edit'  roles.editLabel='edit {name}'  roles.up='move up'  roles.upLabel='move {name} up'
roles.down='move down'  roles.downLabel='move {name} down'  roles.delete='delete'  roles.deleteLabel='delete {name}'
roles.loading='Loading roles…'  roles.error.load='Could not load the roles ({code}).'  roles.retry='Try again'
roles.moved='{name} moved.'  roles.error.move='Could not move {name} ({code}). Try again.'
roles.editor.titleNew='New role in {server}'  roles.editor.titleEdit='Edit {name}'  roles.editor.name='Role name'
roles.editor.nameHint='Up to 100 bytes. Everyone in the server, and the host, can read it.'
roles.editor.color='Colour'  roles.editor.colorHint='Shown as a dot beside the names of people who hold it.'
roles.editor.hoist='show separately in the member list'  roles.editor.mentionable='anyone can mention this role'
roles.editor.mentionableHint='People who may mention @everyone can mention any role.'
roles.editor.permissions='Permissions'  roles.editor.notHeld='You do not hold this permission, so you cannot give or take it.'
roles.editor.save='Save'  roles.editor.saving='Saving…'  roles.editor.create='Create'  roles.editor.creating='Creating…'
roles.editor.cancel='Cancel'  roles.editor.saved='{name} saved.'  roles.editor.created='{name} created.'
roles.color.none='no colour'  roles.color.red='red'  roles.color.orange='orange'  roles.color.amber='amber'
roles.color.green='green'  roles.color.teal='teal'  roles.color.cyan='cyan'  roles.color.blue='blue'
roles.color.indigo='indigo'  roles.color.purple='purple'  roles.color.pink='pink'  roles.color.brown='brown'
roles.color.grey='grey'  roles.color.custom='current colour'
roles.error.empty='Give the role a name.'  roles.error.long='That name is too long. A role name is up to 100 bytes.'
roles.error.forbidden='You cannot change this role. It is at or above your highest role, or it carries a permission you do not hold.'
roles.error.conflict='Someone else moved this role at the same time. Check it and save again.'
roles.error.full='This server already has 250 roles, the most it can hold.'
roles.error.gone='This role no longer exists.'  roles.error.other='Could not save the role ({code}). Try again.'
roles.deleteTitle='Delete {name}?'
roles.deleteBody='Everyone who holds it loses it, and with it any channel it opened for them. This cannot be undone.'
roles.deleteConfirm='Delete'  roles.deleteBusy='Deleting…'  roles.deleted='{name} deleted.'
roles.error.delete='Could not delete {name} ({code}). Try again.'
roles.menu.assign='roles'  roles.assign.title='Roles of {name}'
roles.assign.body='Tick a role to give it to {name}, untick it to take it away. Each change applies at once.'
roles.assign.locked='{role} is at or above your highest role.'
roles.assign.none='There are no roles you can give yet. Make one in Server settings, under roles.'
roles.assign.close='Done'  roles.assign.given='{role} given to {name}.'  roles.assign.taken='{role} taken from {name}.'
roles.assign.error.forbidden='You cannot give or take {role}. It is at or above your highest role, or it carries a permission you do not hold.'
roles.assign.error.twoFactor='{name} needs a second sign-in factor before they can hold a moderator role in this server.'
roles.assign.error.gone='{name} is no longer in this server.'  roles.assign.error.other='That did not work ({code}). Try again.'
roles.access='Roles decide who can see private channels. People who lose a channel keep the messages they already have; people who gain one see only messages sent after they join it.'
perm.group.general='General'  perm.group.members='Members'  perm.group.text='Text'  perm.group.voice='Voice'
perm.allow='allow'  perm.inherit='default'  perm.deny='deny'
perm.view='view channels'  perm.view.hint='See the channel and take part in it. Without it a person is not in the channel at all.'
perm.send='send messages'  perm.send.hint='Post in text channels. In this version only members’ apps check it, by hiding the message box.'
perm.manageMessages='manage messages'  perm.manageMessages.hint='Has no effect in this version.'
perm.pin='pin messages'  perm.pin.hint='Pin and unpin messages. Members’ apps show a pin only while the person who pinned it may pin in that channel.'
perm.attach='attach files'  perm.attach.hint='Send images and files.'
perm.react='add reactions'  perm.react.hint='Has no effect in channels the host cannot read in this version.'
perm.history='read message history'  perm.history.hint='Open the files sent in a channel. Messages sent before someone joins a channel are never shown to them, whatever their roles.'
perm.connect='connect'  perm.connect.hint='Join calls in voice channels.'
perm.speak='speak'  perm.speak.hint='Be heard in calls.'
perm.video='video'  perm.video.hint='Turn on a camera in calls.'
perm.screen='share screen'  perm.screen.hint='Share a screen or a tab in calls.'
perm.invite='create invites'  perm.invite.hint='Make invite links to the server.'
perm.kick='kick members'  perm.kick.hint='Remove members whose highest role is below theirs. They can come back with an invite.'
perm.ban='ban members'  perm.ban.hint='Remove members whose highest role is below theirs, and keep them out.'
perm.manageChannels='manage channels'  perm.manageChannels.hint='Add, edit, move and delete channels and categories.'
perm.manageRoles='manage roles'  perm.manageRoles.hint='Make, edit and give out roles below their own highest role, and set channel permissions.'
perm.manageServer='manage server'  perm.manageServer.hint='Rename the server.'
perm.auditLog='view audit log'  perm.auditLog.hint='Has no effect in this version.'
perm.everyone='mention @everyone and @here'  perm.everyone.hint='Notify everyone in a channel. Members’ apps ignore @everyone and @here from people without it.'
perm.slowmode='bypass slow mode'  perm.slowmode.hint='Has no effect in this version.'
perm.admin='administrator'  perm.admin.hint='Every permission in every channel, whatever the channel’s settings say. Give it only to people you would trust with the whole server.'
perm.mute='mute members'  perm.mute.hint='Has no effect in this version.'
perm.move='move members'  perm.move.hint='Has no effect in this version.'
perm.nicknames='manage nicknames'  perm.nicknames.hint='Has no effect in this version.'
perm.pinsNote='A pin shows while the person who pinned it may pin in this channel.'
chperm.title='Permissions'  chperm.private='private channel'
chperm.privateHint='Only the roles and people you add can see it, with the owner and administrators. The host still knows who is in it.'
chperm.who='Who has settings here'  chperm.everyone='@everyone'  chperm.member='member'
chperm.add='add a role or person'  chperm.addLabel='Role or person'
chperm.remove='remove'  chperm.removeLabel='remove the settings for {name}'
chperm.none='No role or person has settings of their own here yet.'
chperm.saved='Permissions of #{name} saved.'  chperm.busy='Saving…'
chperm.makePrivate.title='Make #{name} private?'
chperm.makePrivate.body='People who are not given access leave the channel now. They keep the messages they already have.'
chperm.makePrivate.confirm='Make private'
chperm.makePublic.title='Open #{name} to everyone?'
chperm.makePublic.body='Everyone in {server} joins the channel. They see only messages sent after they join.'
chperm.makePublic.confirm='Open to everyone'  chperm.cancel='Cancel'
chperm.error.forbidden='You cannot change this. The role or person is at or above your highest role, or the change names a permission you do not hold here.'
chperm.error.hidden='That change would hide the channel from you. Give access to a role you hold first.'
chperm.error.gone='This channel no longer exists.'  chperm.error.other='Could not save the permissions ({code}). Try again.'
chperm.create.private='private channel'  chperm.create.privateHint='Only you, the owner, administrators and the roles you tick can see it.'
chperm.create.roles='Roles that can see it'
chperm.create.noRoles='There are no roles below yours to add. You can add people later in the channel’s permissions.'
chperm.privateTag='private'  chperm.lostAccess='#{name} is no longer available to you.'
chperm.cannotSend='You cannot send messages in #{name}.'
mention.role='@{name}'  mention.role.secondary='role'
serverNotify.title='Servers'  serverNotify.body='A server’s setting applies to its channels unless a channel has its own.'
serverNotify.mode.default='default'  serverNotify.mode.all='all messages'  serverNotify.mode.mentions='mentions'
serverNotify.mode.nothing='nothing'  serverNotify.mute='mute server'  serverNotify.suppressEveryone='ignore @everyone and @here'
```

- [ ] **Step 2.** Write the `## Copy` section of 09 as a bulleted list of `` `key='value'` `` pairs: all 177, in the order above.
- [ ] **Step 3.** Write 09's `## States` table: one row per state, columns `| State | What shows | Copy keys |`. At least these 20 rows:
  1. roles tab hidden without manage roles (`roles.tab`);
  2. roles list loading (`roles.loading`);
  3. roles list error with retry (`roles.error.load`, `roles.retry`);
  4. roles list with @everyone last and the member counts (`roles.title`, `roles.body`, `roles.everyone`, `roles.everyoneHint`, `roles.row.one|other`, `roles.edit|up|down|delete` and their `*Label`);
  5. locked rows (`roles.locked`, no actions);
  6. move done or failed (`roles.moved`, `roles.error.move`);
  7. editor new / edit (`roles.editor.*`, `roles.color.*`, `perm.group.*`, every `perm.<bit>` and `perm.<bit>.hint`, `roles.editor.notHeld`);
  8. editor busy (`roles.editor.saving|creating`);
  9. editor refusals (`roles.error.empty|long|forbidden|conflict|full|gone|other`);
  10. delete confirm, busy, done, failed (`roles.deleteTitle|deleteBody|deleteConfirm|deleteBusy|deleted`, `roles.error.delete`);
  11. assign dialog with locked rows (`roles.assign.title|body|locked|close`, `roles.access`);
  12. assign with nothing to give (`roles.assign.none`);
  13. assign given or taken, and refusals (`roles.assign.given|taken`, `roles.assign.error.forbidden|twoFactor|gone|other`);
  14. channel permissions, public (`chperm.title|private|privateHint|who|everyone|member|add|addLabel|remove|removeLabel|none`, `perm.allow|inherit|deny`);
  15. channel permissions, private, and the confirms (`chperm.privateTag`, `chperm.makePrivate.*`, `chperm.makePublic.*`, `chperm.cancel`, `chperm.busy`, `chperm.saved`);
  16. permission refusals (`chperm.error.forbidden|hidden|gone|other`);
  17. create private, with roles and with no roles (`chperm.create.private|privateHint|roles|noRoles`);
  18. lost access (`chperm.lostAccess`) and cannot send (`chperm.cannotSend`);
  19. a role mention composed and rendered (`mention.role`, `mention.role.secondary`), pin hidden without the right, and the pins note (`perm.pinsNote`);
  20. server notification rows (`serverNotify.*`).

  Then fill `## 1280×800` and `## 360×740` (one paragraph each: where the Roles tab, the editor's grid scroll, the assign dialog and the permissions section sit), and fill `## Keyboard map`, `## Focus rules` and `## Announcements` from the behaviour lines of U1–U5, WA1–WA5 and W-Shell. At least:
  - **Keyboard map:**
    - PermissionGrid toggle mode: Tab between rows, Space toggles.
    - Tri mode: Tab enters a row on its checked radio. The arrow keys move and select within the row, wrapping. Tab leaves the row.
    - ColorSwatches: the arrows move and select, wrapping.
    - CheckList: Tab and Space.
    - A member row's Shift+F10 menu has `roles.menu.assign`.
    - Composer `@`: ArrowUp/ArrowDown, then Enter or Tab inserts. A role option reads its secondary "role".
  - **Focus rules:**
    - The editor opens on the name field and closes to its opener (`roles.new`, or the row's edit button).
    - After a delete, focus goes to `roles.new`.
    - After a move, focus stays on the same row's move button, or on its other move button when that one is now hidden.
    - The assign dialog opens on the first enabled checkbox, else Done, and closes to the member's menu trigger (through `asideReturnRef` from the narrow drawer).
    - The private Toggle's confirm opens on Cancel and closes to the Toggle.
    - An entry's settings disclosure keeps focus on its button.
    - After `chperm.lostAccess`, focus follows the normal channel-open rule.
  - **Announcements** (polite, through the shell announcer): `roles.moved`, `roles.editor.saved`, `roles.editor.created`, `roles.deleted`, `roles.assign.given`, `roles.assign.taken`, `chperm.saved` and `chperm.lostAccess`. Dialog errors are `role=alert`.
- [ ] **Step 4.** In strings.flow09.test.ts:
  - remove the `it.skip` from the sections test;
  - add `expect(pairs.length).toBe(177)`;
  - fill `LOWER` with exactly these 63 keys:
    ```
    roles.tab roles.new roles.edit roles.up roles.down roles.delete roles.locked roles.menu.assign
    roles.editor.hoist roles.editor.mentionable
    roles.color.none roles.color.red roles.color.orange roles.color.amber roles.color.green roles.color.teal roles.color.cyan
    roles.color.blue roles.color.indigo roles.color.purple roles.color.pink roles.color.brown roles.color.grey roles.color.custom
    perm.view perm.send perm.manageMessages perm.pin perm.attach perm.react perm.history perm.connect perm.speak perm.video
    perm.screen perm.invite perm.kick perm.ban perm.manageChannels perm.manageRoles perm.manageServer perm.auditLog
    perm.everyone perm.slowmode perm.admin perm.mute perm.move perm.nicknames perm.allow perm.inherit perm.deny
    chperm.private chperm.add chperm.remove chperm.privateTag chperm.member chperm.create.private
    serverNotify.mode.default serverNotify.mode.all serverNotify.mode.mentions serverNotify.mode.nothing
    serverNotify.mute serverNotify.suppressEveryone
    ```
  Report the number you pinned. The reviewer recounts the pairs in the doc independently.
- [ ] **Step 5.** Red first: run `npx vitest run --root packages/web src/strings` with the keys added but before the 09 Copy section is written. Record the failure, then write the section and get it green. Also confirm `strings.test.ts` still passes unchanged: its `shell.` (177) and settings (85) pins must not move.
- [ ] **Step 6.** Gates: G-web.
- [ ] **Step 7.** Commit: `docs(flows): flow 09 roles and private channels copy`.

---

## Phase 1: parallel lanes. Each lane is sequential inside, in its own `git clone --shared`.

Lanes: **SRV** (S1 → S2) ‖ **CORE-R** (R1) ‖ **CORE** (C1 → C2 → C3 → C5, then C4 once R1 is integrated) ‖ **UI** (U1 → U5).

The CORE and CORE-R lanes both touch `sync/testing/model.ts`, in different blocks. CORE-R is integrated first, and CORE rebases onto it.

### Task S1: Overwrites read route

**Model:** sonnet. **Lane:** SRV. **Depends on:** Phase 0.

**Files:** `internal/api/roles.go` (Register :98-107, and a handler after `list` ~:257-293), `internal/api/roles_test.go`, `protocol/09-http-api.md` (§ Roles ~:353).

- [ ] **Route:** `mux.HandleFunc("GET /v1/communities/{id}/overwrites", h.listOverwrites)`, registered after the roles `GET`.
  - The handler follows the recipe. Only a member may read it; a non-member and an unknown community both get 404 (`notFound`).
  - **Visibility:** follow `Channels.list`'s loop (channels.go:667-705). Load the snapshot once. For each live channel (categories included) where the caller's `ResolveChannel` holds `view_channel`, call `ListOverwrites(channel)`.
  - **Answer:** `[[channel_id(bstr16), kind(uint 0|1), target_id(bstr16), allow(uint), deny(uint)]]`, with allow and deny masked by `PermAll`. Order by channel_id bytes, then kind, then target_id bytes. An empty answer is `[]`, never null: build it with `make(..., 0)`.
  - The response row is a toarray struct `overwriteResp{ChannelID id.ID; Kind uint64; TargetID id.ID; Allow, Deny uint64}`.
- [ ] **Tests, red first:**
  - a fresh community → `[]`;
  - the owner PUTs `@everyone` deny view on #general and role A allow view on #general → the owner's GET returns exactly those two rows, in the stated order;
  - member B without A → `[]` (B cannot view #general);
  - after B is granted A → B gets the two rows;
  - an overwrite stored through the repo with allow `1<<40 | 1` → the answer's allow is `1`;
  - an overwrite on a category is listed to a member who can view the category;
  - a non-member → 404; an unknown community → 404.
- [ ] **protocol/09 § Roles:**
  - Add the row: `` | `GET /v1/communities/{id}/overwrites` | — | `[[channel_id, kind, target_id, allow, deny]]`: every overwrite of every channel (categories included) the caller may view, ordered by `channel_id`, `kind`, `target_id`; bits outside § Permissions are cleared | ``.
  - Change the intro sentence to "…every one needs `manage_roles`, except the two `GET`s, which any member may read".
  - Add the bullet: "A client uses them with § Permissions to fold pins and `@everyone` (`04`)."
- [ ] **Gates:** G-go, G-docs. **Commit:** `feat(api): members read the channel overwrites they can see`.

### Task S2: Private at birth, and no self-lockout

**Model:** opus. **Lane:** SRV, after S1. **Depends on:** S1.

**Files:**
- `internal/api/channels.go` (`createChannelReq` :267, `create` :286-400)
- `internal/api/roles.go` (`overwriteTarget` ~:784-865, `putOverwrite` :876, `deleteOverwrite` :939)
- `internal/api/channels_test.go`, `internal/api/roles_test.go`
- `protocol/09-http-api.md` § Channels (~:301) and § Roles

- [ ] **Create with overwrites.** `POST /v1/communities/{id}/channels` accepts **8 or 9** elements.
  - Decode into `[]cbor.RawMessage` first, because a toarray struct is exact-arity. Then decode elements 0–7 into the existing `createChannelReq` fields (re-encode the 8 as an array, or decode them element-wise).
  - Any other length → 400, with the code and detail the existing shape refusal uses.
  - The 9th element is `overwrites: [[kind(uint), target_id(bstr16), allow(uint), deny(uint)]]` with 1–100 entries. 0 or more than 100 → 400 "overwrites must hold 1 to 100 entries".
- [ ] **With overwrites present, in this order:**
  1. The existing member and `manage_channels` checks.
  2. The caller also needs `manage_roles` community-wide, else 403.
  3. Channel kind 2 (category) → 400 "a category's overwrites have no effect".
  4. Each entry passes putOverwrite's rules, checked against the caller's **community-wide** bits:
     - kind ∈ {0, 1};
     - the target exists (a role of this community / a member), refused with the same code putOverwrite uses;
     - no bit outside `PermAll`;
     - `allow & deny == 0`;
     - no `communityBits`;
     - `checkBits` (403);
     - the target's rank is strictly below the caller's (403; the owner is exempt).
  5. **The one exception:** a kind-1 entry targeting the caller themself, with `allow ⊆ have` and `deny == 0`, is allowed.
  6. A duplicate `(kind, target)` → 400.
  7. Apply the entries to a Snapshot. If the caller's `ResolveChannel` lacks `view_channel` → 400 "the channel would be hidden from you".
  8. One `repo.Tx`:
     - `CreateChannel`;
     - each `PutOverwrite`;
     - the audit rows: the existing `channel.create`, plus one `channel.overwrite.put` per entry (the action string putOverwrite already writes).
  9. After the commit: the existing `MaterialiseChannelMembers` (which now sees the overwrites, so only eligible members join) and **one** op 54 `Changed`. No frame and no member row may exist before the overwrites are in.
- [ ] **Self-lockout on PUT and DELETE.**
  - When the actor is neither the owner nor holds `administrator` community-wide: after the existing checks (so 403 keeps its precedence), build the actor's Snapshot with the channel's overwrites and the candidate change applied. A PUT replaces or inserts `(kind, target)`; a DELETE removes it.
  - If `ResolveChannel(actor)` lacks `view_channel` → 400 "you would lose this channel".
  - There is **no** general self-target exception on PUT: a self overwrite would outlive a demotion.
- [ ] **Tests, red first** (`changedGW` counters from W1):
  1. owner private create (`@everyone` deny view): B is not in B's `GET channels`, and `channel_members` = the owner only;
  2. a mod with manage_roles + manage_channels plus a self entry → 201, and the mod lists the channel;
  3. the same mod without the self entry → 400 "the channel would be hidden from you";
  4. an entry targeting the mod's own top role → 403;
  5. an entry with `kick_members` → 400;
  6. an allow with a bit the mod lacks → 403;
  7. a category with overwrites → 400;
  8. an 8-element body, unchanged → 201;
  9. a 10-element body → 400;
  10. 0 entries → 400; 101 entries → 400;
  11. a duplicate entry → 400;
  12. PUT `@everyone` deny view by a mod with no other access → 400 "you would lose this channel"; the same PUT by the owner → 204;
  13. DELETE of the role overwrite that gives the mod view, while `@everyone` is denied → 400; by the owner → 204;
  14. audit rows written: `channel.create` plus one `channel.overwrite.put` per entry;
  15. op 54 sent exactly once per create.
- [ ] **protocol/09:**
  - The channel create row gains `[, overwrites]`, plus the three rules: needs `manage_roles`; never on a category; the creator must still see the channel, with the self entry rule.
  - § Roles' overwrite PUT/DELETE rows gain: "a change that would hide the channel from its author, unless the author is the owner or holds `administrator`, is `400`".
- [ ] **Hand the integrator this protocol/07 row text** in the report: "Additive: `GET /v1/communities/{id}/overwrites`; channel create takes optional overwrites; an overwrite change that would hide the channel from its non-owner, non-administrator author is `400`; no version bump."
- [ ] **Security note in the report:**
  - confirm no window in which a private channel is listed to, or has a group with, an ineligible member;
  - the self entry outlives a demotion (risk 1, D3);
  - the self-lockout rule can't be bypassed by DELETE.
- [ ] **Gates:** G-go, G-docs, `sqlc diff` (no query change expected; `PutOverwrite` already exists). **Commit:** `feat(api): a channel can be private from birth, and no one locks themself out of one`.

### Task R1: Core authority for pins and @everyone

**Model:** opus. **Lane:** CORE-R. **Depends on:** Phase 0.

**Files:**
- `core/dilla-core/src/client/{schema.rs, fold.rs, sync.rs, messages.rs}`
- `core/dilla-core-wasm/src/{facade.rs, lib.rs}`, `core/dilla-core-wasm/tests/node.rs`, `packages/core-wasm/types.test-d.ts`
- `packages/client-core/src/core-port.ts` (:115, :267, :463), `testing/fake-core.ts` (:408), `worker/world.ts` (:267), `sync/testing/model.ts` (:1572)
- `protocol/04-envelope-and-franking.md` (§ Semantics ~:104-118)

- [ ] **Schema 4.** Following the v2→v3 migration-block pattern:
  ```sql
  CREATE TABLE IF NOT EXISTS app_authority (group_id BLOB NOT NULL, bit INTEGER NOT NULL, user_id BLOB NOT NULL,
    PRIMARY KEY (group_id, bit, user_id)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS app_authority_known (group_id BLOB PRIMARY KEY, set_at INTEGER NOT NULL) WITHOUT ROWID;
  ```
  - `bit` holds 3 (`pin_messages`) or 18 (`mention_everyone`), never anything else.
  - A fresh store writes `schema` `x'04'`. A v3 store gains the tables and moves to `x'04'`.
  - Wherever the store deletes a group's `app_pins` rows (group forget/leave), delete its `app_authority` and `app_authority_known` rows too.
- [ ] **`ClientCore::authority_set(&self, group_id: &[u8; 16], pinners: &[u8], broadcasters: &[u8]) -> Result<(), CoreError>`:**
  1. Checks: each slice length is a multiple of 16, with at most 4096 ids. Otherwise the input error `own_roles_set` uses.
  2. In one transaction: delete the group's rows; insert one row per pinner with bit 3 and per broadcaster with bit 18; upsert `app_authority_known(group_id, set_at)` with the core's existing clock (0 if it has none).
  3. Refold Pin scope for every target with a type 5/6 row in the group: `SELECT DISTINCT reply_to FROM app_messages WHERE group_id = ?1 AND type IN (5, 6)`, then `refold(c, g, target, &FoldScope::Pin, None, own)`.
  4. Recompute `mention` for the group's rows with `sender_user` ≠ the own user, `status = 0`, `type = 0` and a body containing `<@everyone>` or `<@here>`. Use `mentions_me_gated` (below). Badges are SQL counts over `mention = 1`, so they follow.
- [ ] **Pin fold.** `PIN_LATEST` gains:
  ```sql
  AND (NOT EXISTS (SELECT 1 FROM app_authority_known k WHERE k.group_id = ?1)
       OR sender_user IN (SELECT a.user_id FROM app_authority a WHERE a.group_id = ?1 AND a.bit = 3))
  ```
  So an unauthorized 5 is ignored, and an unauthorized 6 can't unpin. The index-plan test (fold.rs ~:348) must stay green: the outer scan still uses `app_messages_by_pin`.
- [ ] **Mention flag.**
  - Add `mentions_me_gated(body, own_user, own_roles, broadcast_ok: bool) -> bool`: a direct `<@own>` or an own-role token gives true; `<@everyone>` or `<@here>` gives true only when `broadcast_ok`.
  - `authorized(group, sender)` = the group is not in `app_authority_known`, or `sender` has a bit-18 row in it.
  - Both apply sites (sync.rs:377 and :845) call `mentions_me_gated(body, own, roles, authorized(group, sender))`.
  - `mentions_me_with_roles` stays for any other caller.
- [ ] **wasm and ABI:**
  - facade `authority_set(&self, group_id: &[u8], pinners: &[u8], broadcasters: &[u8]) -> Result<(), JsError>`, modelled on facade.rs:649-653;
  - `BROWSER_ABI_VERSION = 10` (lib.rs:122, and the asserts at lib.rs:566 and tests/node.rs:277);
  - add `authority_set` to `packages/core-wasm/types.test-d.ts`.
- [ ] **TS port:**
  - core-port.ts: the interface gets `authoritySet(groupId: Id, pinners: Id[], broadcasters: Id[]): void;` (:115). The handle type gets `authority_set(group_id: Uint8Array, pinners: Uint8Array, broadcasters: Uint8Array): void;` (:267). The impl joins the ids the way `ownRolesSet` does (:463).
  - fake-core.ts: `authoritySet` **records** each call in a public `authoritySets: { groupId: string; pinners: string[]; broadcasters: string[] }[]` (hex) and returns. C4's tests read it. Do not use `notModelled`.
  - world.ts and model.ts: wire it as `ownRolesSet` is wired.
- [ ] **protocol/04,** rewrite § Semantics Pins and § Mentions:
  - "A receiver that holds the community's role view (`09` overwrites, roles, members) counts a 5/6 only from a sender holding `pin_messages` in that channel now, and `<@everyone>`/`<@here>` only from a sender holding `mention_everyone`; a receiver that holds none keeps the former rule."
  - Remove the Q20 sentence on Pins.
- [ ] **Hand the integrator this protocol/07 row text:** "Behaviour change, client only; no wire change. Receivers fold pins and `@everyone`/`@here` by the sender's current rights in the channel (`04` § Semantics)."
- [ ] **Tests, red first:**
  - an authorized pin, then an unauthorized unpin → still pinned;
  - an unauthorized pin → ignored;
  - removing the pinner from the set unpins, and restoring them re-pins;
  - an unknown group keeps the old behaviour (anyone pins);
  - `@everyone` from an unauthorized sender → `mention` 0; the same body plus a direct `<@own>` → 1;
  - `authority_set` flips an existing row's `mention` both ways, and the badge count follows;
  - a v3 store migrates to 4 with its pins unchanged;
  - 4097 ids → input error; a 15-byte slice → input error;
  - ABI 10 asserted;
  - core-port.test.ts covers `authoritySet` joining.

  Mutation: drop the `OR sender_user IN …` branch and show the re-pin test fail.
- [ ] **Gates:** G-rust and G-core. **Commit:** `feat(core): pins and @everyone count only from members allowed them`.

### Task C1: client-core routes

**Model:** sonnet. **Lane:** CORE. **Depends on:** T0.

**Files:** `packages/client-core/src/http/routes.ts` (a new banner `// ---- wave 2a: roles and private channels (flow 09) ----` after the wave 1 block :71-87, with methods after `revokeInvite` :398), `routes.test.ts`.

- [ ] Constants and types:
  ```ts
  export const OVERWRITES_MAX = 10_000; export const ROLE_NAME_MAX_BYTES = 100; export const ROLE_COLOR_MAX = 0xffffff;
  export const PERM_ALL = 0xffffff; export const OVERWRITES_PER_CREATE_MAX = 100;
  export interface OverwriteRow { channelId: Uint8Array; kind: 0 | 1; targetId: Uint8Array; allow: number; deny: number }
  export interface NewOverwrite { kind: 0 | 1; targetId: Uint8Array; allow: number; deny: number }
  export interface RolePatch { name?: string; color?: number; position?: number; allow?: number; deny?: number; hoist?: boolean; mentionable?: boolean }
  ```
  `RoleRow.allow` and `RoleRow.deny` change from `bigint` to `number`, read as `Number(u64(a[k]) & BigInt(PERM_ALL))`. Update every call site. `rank.ts`'s `accessOf(bits: bigint, …)` reads `PermissionsRow.bits` and keeps `bigint`.
- [ ] Methods. Bucket and idempotent are in brackets. Names are checked by `checkedName(…, ROLE_NAME_MAX_BYTES)` (the control-character rule as for channel names), colours are integers 0..ROLE_COLOR_MAX, positions 1..2^31-1, and bits integers 0..PERM_ALL:
  - `createRole(c, {name, color, position, allow, deny, hoist, mentionable})`: POST `/v1/communities/{c}/roles` `[name, color, position, allow, deny, hoist?1:0, mentionable?1:0]` → `{ roleId: Uint8Array }` [write, non-idem];
  - `patchRole(roleId, RolePatch)`: PATCH `/v1/roles/{id}` with 7 slots in that order, `null` for an absent field, flags as 0|1 → void [write, idem];
  - `deleteRole(roleId)`: DELETE `/v1/roles/{id}` [write, idem];
  - `grantRole(c, u, r)`: PUT `/v1/communities/{c}/members/{u}/roles/{r}` with body `[]` [write, idem];
  - `revokeRole(c, u, r)`: DELETE on the same path [write, idem];
  - `putOverwrite(ch, kind, target, {allow, deny})`: PUT `/v1/channels/{ch}/overwrites/{kind}/{target}` `[allow, deny]` [write, idem];
  - `deleteOverwrite(ch, kind, target)`: DELETE on the same path [write, idem];
  - `listOverwrites(c)`: GET `/v1/communities/{c}/overwrites` [read, idem]. Uses `bounded(…, OVERWRITES_MAX)` and rows `atLeast(5)`. A kind ∉ {0, 1} → `E_CBOR_RANGE`; an allow or deny > PERM_ALL → `E_CBOR_RANGE`;
  - `createChannel` gains an optional third-argument field `overwrites?: readonly NewOverwrite[]`. A non-empty list adds the 9th element `[[kind, targetId, allow, deny], …]`; an empty or absent list sends 8 elements; more than 100 → `E_ROUTE_INPUT`.

  Check the server's request and answer shapes in roles.go (`createRoleReq` :231, `patchRoleReq` :385, `putOverwriteReq` :866, the create answer, the grant body) before coding. Stop with NEEDS_CONTEXT if any differs from the above.
- [ ] **Tests,** as CASES rows plus rejects:
  - createRole sends `['Crew', 0x30a46c, 1, 8, 0, 1, 1]`;
  - patchRole `{allow: 8}` → `[null, null, null, 8, null, null, null]`;
  - the role names `''`, 101 bytes and `'\u0007'` are rejected; colour `0x1000000` is rejected;
  - a role row with allow `2**40 + 8` → `allow: 8`;
  - an overwrite row with kind 2 → `E_CBOR_RANGE`; allow `0x1000000` → `E_CBOR_RANGE`;
  - 10 001 overwrite rows → `E_CBOR_SHAPE`;
  - createChannel with one overwrite puts a 9-element array whose slot 8 is `[[0, <16B>, 0, 1]]`;
  - an empty overwrites array sends 8 elements; 101 entries are rejected;
  - grant 403 → `E_FORBIDDEN`;
  - the putOverwrite path is `/v1/channels/<hex>/overwrites/1/<hex>`.
- [ ] **Gates:** G-core. **Commit:** `feat(client-core): routes for roles, overwrites and private channel create`.

### Task C2: The permission resolver in TypeScript

**Model:** sonnet; **opus reviewer**. **Lane:** CORE. **Depends on:** X1, C1.

**Files:** a new `packages/client-core/src/admin/perm.ts`, a new `admin/perm.test.ts`, `admin/rank.ts`, `admin/rank.test.ts`, `src/index.ts`.

- [ ] `perm.ts`:
  - `export const PERM = { viewChannel: 1 << 0, … } as const`: all 24 as **numbers**, the values of perm.go:23-46. Names and keys:

    | key (copy `perm.<key>`) | PERM name | bit |
    |---|---|---|
    | view | viewChannel | 0 |
    | send | sendMessages | 1 |
    | manageMessages | manageMessages | 2 |
    | pin | pinMessages | 3 |
    | attach | attachFiles | 4 |
    | react | addReactions | 5 |
    | history | readHistory | 6 |
    | connect | connect | 7 |
    | speak | speak | 8 |
    | video | video | 9 |
    | screen | screenShare | 10 |
    | invite | createInvite | 11 |
    | kick | kickMembers | 12 |
    | ban | banMembers | 13 |
    | manageChannels | manageChannels | 14 |
    | manageRoles | manageRoles | 15 |
    | manageServer | manageCommunity | 16 |
    | auditLog | viewAuditLog | 17 |
    | everyone | mentionEveryone | 18 |
    | slowmode | bypassSlowmode | 19 |
    | admin | administrator | 20 |
    | mute | muteMembers | 21 |
    | move | moveMembers | 22 |
    | nicknames | manageNicknames | 23 |
  - `export type PermKey` is the union of the 24 keys.
  - `export const COMMUNITY_BITS` = kick | ban | manageCommunity | manageRoles | viewAuditLog | administrator | manageNicknames (perm.go `communityBits`).
  - `export const PERM_GROUPS: readonly { id: 'general' | 'members' | 'text' | 'voice'; keys: readonly PermKey[] }[]`, in this order:
    - general: view, manageChannels, manageRoles, manageServer, invite, auditLog, admin;
    - members: kick, ban, nicknames;
    - text: send, attach, react, history, pin, everyone, manageMessages, slowmode;
    - voice: connect, speak, video, screen, mute, move.
  - `export const PERM_BY_KEY: Readonly<Record<PermKey, number>>`.
  - Structural inputs, so this task doesn't wait for C3's types:
    ```ts
    export interface PermRole { id: string; position: number; allow: number; deny: number }
    export interface PermOverwrite { kind: 0 | 1; targetId: string; allow: number; deny: number }
    export interface PermMember { userId: string; roleIds: readonly string[] }
    export interface PermInput { owner: string; everyoneId: string; roles: readonly PermRole[]; held: readonly string[] }
    ```
  - `resolveCommunity(input, userId): number` and `resolveChannel(input, overwrites: readonly PermOverwrite[], userId): number`:
    - a line-for-line port of perm.go:108-173;
    - the owner short-circuit; `@everyone` held by identity (`everyoneId`), others only when in `held`;
    - the defensive sort by position, then id (a lower-case hex string compare equals a bytewise compare);
    - deny before allow, each masked by `PERM_ALL`;
    - administrator → `PERM_ALL`; no view → 0;
    - in a channel: role overwrites in ascending role position, then the user's own, then the community-bits restore.
  - `channelBitsOf(s: { owner: string; everyoneId: string; roles: readonly PermRole[]; members: readonly PermMember[]; overwrites: readonly PermOverwrite[] }, userId): number | null`:
    - `PERM_ALL` for the owner;
    - `null` when `userId` isn't in `members` (unknown, so the caller keeps today's behaviour);
    - otherwise `resolveChannel` with `held = member.roleIds`.
  - `isPrivate(overwrites, everyoneId): boolean`: true when a kind-0 entry for `everyoneId` has `deny & PERM.viewChannel`.
- [ ] `rank.ts`: delete its own `PERM`, import `PERM` from `./perm`, and use `BigInt(PERM.x)` inside `accessOf`. `index.ts`: export `PERM, COMMUNITY_BITS, PERM_GROUPS, PERM_BY_KEY, resolveCommunity, resolveChannel, channelBitsOf, isPrivate` and the types from `./admin/perm`, and drop `PERM` from the rank export line. Move rank.test.ts's PERM pin into perm.test.ts as the full 24-value table.
- [ ] **Tests:**
  - every case of `protocol/vectors/permissions.json` (read as cbor.test.ts:19 does) gives `community` and `channel`;
  - the vector file's `bits` map equals `PERM` (snake_case → the PERM names above);
  - `PERM_GROUPS` covers all 24 keys exactly once;
  - `channelBitsOf` gives null for a non-member and `PERM_ALL` for the owner;
  - `isPrivate` is true for `@everyone` deny view, false for deny send only, and false for a role's deny view.

  Mutation: swap the deny and allow lines in `resolveCommunity`, show vector cases 3–5 fail, and revert.
- [ ] **Gates:** G-core. **Commit:** `feat(client-core): the permission resolver, checked against the Go vectors`.

### Task C3: Role, overwrite and private-channel commands

**Model:** sonnet. **Lane:** CORE. **Depends on:** C1, C2.

**Files:**
- `src/worker/protocol.ts` (before `'resign'`, ~:84)
- `src/state/types.ts` (~:141-160)
- `src/admin/roles.ts` (RolesController and ROLES_VALIDATORS), a new `src/admin/roles.test.ts`
- `src/admin/controller.ts` (`loadAccess` :104, `forget` :119)
- `src/worker/controller.ts` (the T0 one-per-line lists, `dispatch`, wiring like AdminController, one line in `publishMembers`, `createChannel`)
- `src/sync/testing/model.ts`

- [ ] **Types:**
  ```ts
  export interface RoleSummary { id: string; name: string; color: number; position: number; hoist: boolean; mentionable: boolean;
    allow: number; deny: number; members: number }
  export interface OverwriteSummary { kind: 0 | 1; targetId: string; allow: number; deny: number }
  // SliceName += `overwrites:${string}`; SliceTypes[`overwrites:${string}`] = Record<string, OverwriteSummary[]>  (channelId hex → entries;
  //   a channel with none is absent)
  // CommunityAccess += everyoneId: string   ('' until loaded; every CommunityAccess literal gains it, e.g. admin/controller.ts:124)
  ```
- [ ] **Commands,** before `resign`. All are ready-only and return `null` unless noted:
  ```ts
  | { m: 'createRole'; communityId: string; name: string; color: number; hoist: boolean; mentionable: boolean; allow: number }  // → { roleId }
  | { m: 'updateRole'; communityId: string; roleId: string; name: string | null; color: number | null; hoist: boolean | null; mentionable: boolean | null; allow: number | null }
  | { m: 'moveRole'; communityId: string; roleId: string; direction: 'up' | 'down' }
  | { m: 'deleteRole'; communityId: string; roleId: string }
  | { m: 'grantRole'; communityId: string; userId: string; roleId: string }
  | { m: 'revokeRole'; communityId: string; userId: string; roleId: string }
  | { m: 'setOverwrite'; channelId: string; kind: 0 | 1; targetId: string; allow: number; deny: number }   // 0/0 → DELETE (404 = done)
  | { m: 'setChannelPrivate'; channelId: string; private: boolean }
  // the existing createChannel gains: private?: { roleIds: string[] }
  ```
  Widen ID_FIELDS with `'roleId'` and `'targetId'`. `createRole` sends deny 0. `updateRole` sends position and deny as null.
- [ ] **Behaviour:**
  - **`loadAccess`** reads permissions, roles and overwrites in parallel. It publishes:
    - `permissions:<cid>`, with `everyoneId` set to the id of the position-0 role;
    - `roles:<cid>`, with allow, deny and `members` (the number of `members:<cid>` rows whose `roleIds` include the role; every member for `@everyone`; 0 while members are absent);
    - `overwrites:<cid>`.

    RolesController keeps the last role rows and the last raw permission bits per community, privately; no slice carries the raw bits. `publishMembers` calls `rolesController.membersChanged(cid)`, which republishes `roles:<cid>` with fresh counts. `forget` also clears `overwrites:`.
  - **createRole position:** the lowest positive integer not used by any role and below my top. The owner's bound is 2^31-1. With no room → E_BAD_INPUT `no room below your highest role`.
  - **moveRole:**
    - Order roles by (position, id). The neighbour is the next role up or down, never `@everyone`.
    - The neighbour must be below my top unless I'm the owner; otherwise send no request and resolve null.
    - With different positions, swap them: patch the moving role to the neighbour's position, then the neighbour to the old one.
    - With equal positions, patch only the moving role to the neighbour's position + 1 (up) or − 1 (down; not below 1), under the same top rule.
    - A 409 → `loadAccess`, then rethrow.
  - **setOverwrite:**
    - 0/0 → `deleteOverwrite`, where a 404 resolves null;
    - otherwise `putOverwrite`.
  - **setChannelPrivate(true):**
    1. Find the channel's community through the known-channel map. Use the cached overwrites, or await `loadAccess` first.
    2. When I'm not the owner, lack administrator (the raw bits), and **no existing overwrite in this channel allows `view_channel` to me** (a kind-0 entry for a role I hold, or a kind-1 entry for me) → E_BAD_INPUT `you would lose this channel`, with no request. This mirrors S2.
    3. PUT `@everyone` kind 0 with `deny | VIEW`, keeping its other allow and deny bits.
  - **setChannelPrivate(false):**
    - clear VIEW from `@everyone`'s deny, and DELETE the entry when the result is 0/0;
    - with no `@everyone` entry, send no request.
  - **createChannel with `private`:** the overwrites are:
    - `[{kind 0, @everyone, allow 0, deny VIEW}]`;
    - `{kind 0, roleId, allow VIEW, deny 0}` per roleId;
    - plus `{kind 1, me, allow VIEW, deny 0}` when I'm not the owner and lack administrator.
  - **Every write:**
    - a 403 → `loadAccess` (the W1 `guarded` pattern), then rethrow;
    - after success: grant and revoke re-read members and access; every other write re-reads access.
    - The re-reads are **awaited before the ret**, so the page sees the new slices when its call resolves.
- [ ] **ROLES_VALIDATORS** (typed `Record<RolesMethod, …>` like ADMIN_VALIDATORS). Each returns E_BAD_INPUT with this exact reason:
  - a blank name → `role name is blank`; over 100 bytes → `role name is longer than 100 bytes`;
  - `color` not an integer in 0..16777215 → `color must be an integer 0..16777215`;
  - `allow` (and `deny` on setOverwrite) not an integer in 0..16777215 → `allow must be an integer 0..16777215` / `deny must be an integer 0..16777215`;
  - `direction` ∉ {up, down} → `direction must be up or down`;
  - `kind` ∉ {0, 1} → `kind must be 0 or 1`;
  - `allow & deny ≠ 0` → `allow and deny overlap`;
  - `updateRole` with every field null → `nothing to change`;
  - `private.roleIds` not an array of at most 100 32-hex ids → `roleIds must be at most 100 ids`.

  Non-hex ids fail through ID_FIELDS as today.
- [ ] **model.ts:** add RouteNames and server-rule doubles for listOverwrites (`[]` by default), createRole, patchRole, deleteRole, grantRole, revokeRole, putOverwrite, deleteOverwrite, and a 9-element createChannel. The mocks for the three access reads must not push into controller.test's ordered `calls`.
- [ ] **Tests:**
  - each E_BAD_INPUT above;
  - createRole picks 2 when positions {1, 3} are used and my top is 5; no room → `no room below your highest role`;
  - moveRole up on [a1, b2] (top 9) sends patch a→2, then b→1; up past my top → no request; a 409 → roles reloaded and the error rethrown;
  - setChannelPrivate keeps `@everyone`'s other deny bits (deny 2 → deny 3);
  - setChannelPrivate(true) as a non-owner with no allowing overwrite → `you would lose this channel` and no request;
  - setChannelPrivate(false) on deny 1 → DELETE;
  - setOverwrite 0/0 sends DELETE, and a 404 resolves null;
  - a private create sends the self entry for a non-owner and none for the owner;
  - loadAccess publishes `overwrites:` keyed by channel, plus `roles:` with allow, deny and counts; a member list change republishes the counts;
  - grantRole re-reads members and permissions **before** the ret;
  - a 403 on setOverwrite re-reads access;
  - `overwrites:` is cleared on drop.
- [ ] **Gates:** G-core. **Commit:** `feat(client-core): role, overwrite and private channel commands`.

### Task C5: Per-server notifications and role mention encoding

**Model:** sonnet. **Lane:** CORE, after C3. **Depends on:** T0.

**Files:** `src/state/settings.ts`, `settings.test.ts`, `src/state/mentions.ts`, `mentions.test.ts`, `src/index.ts`.

The role-aware `encodeMentions` lives in client-core `state/mentions.ts`, not in the web, so it moves here from the design's WA4. Its word class is ASCII-only today (`WORD`), so "Modérateurs" can't match without this change.

- [ ] **settings.ts:**
  - `SETTINGS.notifyCommunity = (hex) => \`notify.community.${hex}\`` (`'all' | 'mentions' | 'nothing'`), `SETTINGS.muteCommunity = (hex) => \`mute.community.${hex}\`` (`'1'`), and `SETTINGS.everyoneCommunity = (hex) => \`everyone.community.${hex}\`` (`'1'` = ignore `@everyone`/`@here`).
  - `isSettingKey` admits the three prefixes with a 32-hex suffix. `isSettingValue` admits MODES for `notify.community.*` and `'1'` for the other two.
  - `effectiveNotifyMode(settings, channelHex, kind, communityHex?)`: the channel override first, then the community value (when `communityHex` is given and valid), then today's default.
  - `isMuted(settings, channelHex, communityHex?)`: true when the channel or the community is muted.
  - `suppressesEveryone(settings, communityHex): boolean`.
- [ ] **mentions.ts:**
  - `mentionsDirectly(body, userHex, roleHexes)`: like `mentionsMe` without the broadcast tokens.
  - `export interface MentionRole { roleId: string; handle: string }`.
  - `export function roleHandle(name: string): string` = `name.normalize('NFC').toLowerCase().trim().replace(/\s+/g, '-')`.
  - `encodeMentions(text, members, broadcast, roles: readonly MentionRole[] = [])`. At each `@` at a boundary (today's rule), the candidates are:
    - every member's username, lower case;
    - every role handle passed (the caller passes the offerable roles only);
    - `everyone` and `here` when `broadcast`.

    A candidate `h` matches when `text.slice(i + 1, i + 1 + h.length).toLowerCase() === h` and the next character is the end, whitespace, or one of `.,;:!?)]}"'`. The longest match wins. On equal length, broadcast beats member, and member beats role. The output is `<@everyone>`/`<@here>`/`<@userHex>`/`<@roleHex>`.
  - `mentionQuery` widens its word class to `/[\p{L}\p{N}._-]/u`. Everything else stays.
  - Every existing `mentions.test.ts` case stays green. If one fails, stop with NEEDS_CONTEXT; never edit an existing case.
- [ ] **Tests:**
  - precedence: channel > community > default; mute by community alone;
  - the validators for each new key;
  - `mentionsDirectly('<@everyone>', u, [])` is false; `mentionsDirectly('<@r>', u, ['r'])` is true;
  - `roleHandle('Game  Night')` is `'game-night'`; `roleHandle('Modérateurs')` is `'modérateurs'` (from an NFD input too);
  - `'hi @game-night'` → the role token; `'@Modérateurs.'` → token + `'.'`;
  - `'@everyone'` without broadcast is unchanged;
  - longest wins: roles `game` and `game-night` on `'@game-night'` → game-night;
  - a member `crew` and a role `crew` → the member token;
  - `mentionQuery('hi @modé', 8)` → `{ start: 3, query: 'modé' }`.
- [ ] **Gates:** G-core. **Commit:** `feat(client-core): per-server notification settings and role mentions`.

### Task C4: Authority push into the core

**Model:** opus. **Lane:** CORE, after C3 and C5. **Depends on:** C3, and R1 integrated into the wave branch.

**Files:** a new `src/admin/authority.ts`, a new `admin/authority.test.ts`, `src/worker/controller.ts` (the end of the access load and of `publishMembers` :1743-1766, the re-attach reset ~:2221, `dropCommunity`, the group-state transition).

- [ ] `authority.ts` exports a pure `authorityFor(s: { owner; everyoneId; roles; members; overwrites: Record<string, OverwriteSummary[]>; channels: { id: string; kind: number; mode: number; textGroupId: string | null }[] }): Map<groupHex, { pinners: string[]; broadcasters: string[] }>`:
  - it covers text channels (kind 0, mode 0) with a `textGroupId`;
  - `pinners` are the members whose `channelBitsOf` has `PERM.pinMessages`;
  - `broadcasters` are those whose result has `PERM.mentionEveryone`;
  - both lists are sorted hex.
- [ ] **In the worker:** after the access load and at the end of `publishMembers`, when roles, members and overwrites are all present for the community:
  1. For each group the core holds (`core.groups()`), compare a memo keyed by group hex: the sorted pinners and broadcasters joined.
  2. When it changed, call `core.authoritySet(fromHex(g), pinners.map(fromHex), broadcasters.map(fromHex))`, then republish:
     - the open timeline, if it is one of those channels;
     - `pins:<channelId>` if that dialog is open;
     - the badges.

     Use the controller's existing republish helpers.
  - The call is never made for DMs, and never while roles, members or overwrites are absent.
  - A throw leaves the memo unchanged, so the next load retries.
- [ ] **Re-arm (W1 lesson 6):** clear the whole memo where `this.roles.clear()` runs (core re-attach, :2221). Clear a community's entries in `dropCommunity`. Clear a group's entry when that channel's group goes from `not-member`/`resync`/`joining` to `active`.
- [ ] **Tests, red first** (fake-core's `authoritySets`):
  - a demotion (role loses pin) → `authoritySet` without that user;
  - unchanged inputs → no second call;
  - a DM → no call;
  - members not loaded → no call;
  - the `pins:` slice is republished after a change while open;
  - a throwing `authoritySet` → retried at the next load;
  - a new ready (core re-attached) → sent once again;
  - a group rejoin → sent once again.

  Mutation: skip the re-attach clear and show the re-ready test fail.
- [ ] **Gates:** G-core. **Commit:** `feat(client-core): members' apps learn who may pin and mention everyone`.

### Task U1: PermissionGrid

**Model:** sonnet. **Lane:** UI. **Depends on:** Phase 0.

**Files:** `packages/ui/src/PermissionGrid/{PermissionGrid.tsx, .css, .stories.tsx, .test.tsx}`, `src/index.ts`.

- [ ] Props:
  ```ts
  export type PermValue = 'allow' | 'inherit' | 'deny';
  export interface PermissionGridRow { id: string; label: string; hint: string; disabled: boolean; disabledHint?: string }
  export interface PermissionGridGroup { id: string; title: string; rows: readonly PermissionGridRow[] }
  export interface PermissionGridProps { label: string; groups: readonly PermissionGridGroup[]; mode: 'toggle' | 'tri';
    values: Readonly<Record<string, PermValue>>; labels: { allow: string; inherit: string; deny: string };
    onChange(id: string, v: PermValue): void }
  ```
  - The root is a `role=group` named by `label`, with one `h3` per group.
  - `toggle`: one existing `Toggle` per row (on = allow, off = inherit), with the hint as its description.
  - `tri`: one `role=radiogroup` per row, named by the row label, holding three radios labelled from `labels`. Roving tabindex on the checked radio; the arrows move and select within the row, wrapping; Tab moves between rows.
  - A disabled row disables its control and points `aria-describedby` at both the hint and `disabledHint`.
  - At 360 px the rows stack: label and hint above, control below.
- [ ] **Tests:** the arrow keys in tri mode (wrap, select, `onChange`); Tab goes to the next row; a disabled row is described by `disabledHint`; one `h3` per group; axe. Stories: both modes at 1280 and 360, plus a disabled row.
- [ ] **Gates:** G-ui. **Commit:** `feat(ui): PermissionGrid`.

### Task U2: ColorSwatches

**Model:** sonnet. **Lane:** UI. **Depends on:** U1.

**Files:** `packages/ui/src/ColorSwatches/{…}`, `src/index.ts`.

- [ ] Props:
  ```ts
  export interface ColorSwatchesProps { label: string; hint?: string; value: number; options: readonly { value: number; name: string }[];
    noneLabel: string; onChange(v: number): void }
  ```
  - A radiogroup. Value 0 is the "none" option, labelled `noneLabel`, and listed first.
  - Each swatch's accessible name is its colour name. The selected swatch shows a visible check mark, not colour alone. Targets are at least 24×24 px.
  - The colour comes from data, through the inline custom property `--d-swatch` (`#rrggbb`). This is the only non-token value; document it in a CSS comment.
- [ ] **Tests:** the names; the arrows select; the check renders on the selection; 0 selects none; axe. Stories: the 12-colour palette plus a custom 13th option.
- [ ] **Gates:** G-ui. **Commit:** `feat(ui): ColorSwatches`.

### Task U3: Role colour dots

**Model:** sonnet. **Lane:** UI. **Depends on:** U2.

**Files:** `packages/ui/src/MemberList/*`, `packages/ui/src/MessageRow/*` (the `BodyPart` type :8 and its mention render).

- [ ] `MemberListMember.color?: number | null`, and the `BodyPart` mention variant gains `color?: number | null`.
- [ ] A non-null, non-zero colour renders an `aria-hidden` 8 px dot (through `--d-swatch`) before the name. The text keeps its token colour, for AA contrast.
- [ ] **Tests:** the dot renders with the colour and is `aria-hidden`; no dot for null or 0; the existing tests are unchanged; axe.
- [ ] **Gates:** G-ui. **Commit:** `feat(ui): role colour dots in the member list and mentions`.

### Task U4: Form slots in CreateChannel and ChannelSettings

**Model:** sonnet. **Lane:** UI. **Depends on:** U3.

**Files:** `packages/ui/src/CreateChannel/*`, `packages/ui/src/ChannelSettings/*`.

- [ ] `CreateChannelProps.children?: ReactNode` renders after the name field. `ChannelSettingsProps.children?: ReactNode` renders after the topic and category fields, inside the form. No other change.
- [ ] **Tests:** the slot renders inside the form in both components; without children the DOM is unchanged (existing snapshots or assertions stay green).
- [ ] **Gates:** G-ui. **Commit:** `feat(ui): form slots in CreateChannel and ChannelSettings`.

### Task U5: CheckList

**Model:** sonnet. **Lane:** UI. **Depends on:** U4.

**Files:** `packages/ui/src/CheckList/{…}`, `src/index.ts`.

- [ ] Props:
  ```ts
  export interface CheckListItem { id: string; label: string; detail?: string; checked: boolean; disabled: boolean; color?: number | null }
  export interface CheckListProps { label: string; items: readonly CheckListItem[]; busyId: string | null; emptyLabel: string;
    onToggle(id: string, checked: boolean): void }
  ```
  - A `fieldset` with a `legend` of `label`, and native checkboxes.
  - `busyId` disables that one row and sets `aria-busy` on it.
  - `detail` is wired through `aria-describedby`.
  - `color` renders the U3 dot.
  - No items → `emptyLabel` as text.
- [ ] **Tests:** toggle calls `onToggle`; the busy row is disabled and the others aren't; the detail describes its row; the empty label; axe.
- [ ] **Gates:** G-ui. **Commit:** `feat(ui): CheckList`.

---

## Phase 2: parallel lanes after Phase 1 is integrated

Lanes: **WEB-R** (WA1 → WA2) ‖ **WEB-C** (WA3 → WA4) ‖ **WEB-N** (WA5).

`shell-model.ts` is shared: WEB-C edits the mention render first, then WEB-N edits the mute lines and rebases. Every web brief names the six W1 contracts in Global Constraints.

### Task WA1: Roles tab and role editor

**Model:** sonnet. **Lane:** WEB-R. **Depends on:** C3, U1, U2 (Phase 1 integrated).

**Files:** new `packages/web/src/screens/admin/RolesSection.tsx`, `RoleEditorFlow.tsx`, `role-palette.ts`, and their tests; `ServerSettings.tsx` (+ test).

- [ ] **ServerSettings:**
  - `AdminTab` gains `'roles'` on its own line after `'channels'`.
  - The tab sits after channels, labelled `roles.tab`, and shows only when `access.manageRoles`.
  - Its panel is `RolesSection`.
- [ ] **`role-palette.ts`:** this value → name list (the names are `roles.color.*` keys):
  - `0xE5484D` red, `0xF76B15` orange, `0xFFC53D` amber, `0x30A46C` green;
  - `0x12A594` teal, `0x00A2C7` cyan, `0x0090FF` blue, `0x3E63DD` indigo;
  - `0x8E4EC6` purple, `0xD6409F` pink, `0xAD7F58` brown, `0x8B8D98` grey.

  `paletteFor(current: number)` returns the 12, plus a 13th `{ value: current, name: t('roles.color.custom') }` when `current` is non-zero and not among them.
- [ ] **`RolesSection({ communityId, serverName, announce })`:**
  - The heading is `roles.title` and the body `roles.body`. Rows come from `roles:<cid>`, highest position first, `@everyone` (name `roles.everyone`, detail `roles.everyoneHint`) last.
  - Use ChannelsSection's row pattern (rows of Buttons), not ManageList: ManageList carries one action per row.
  - Row detail: `roles.row.one|other` with `{count}` = `members`. A row whose position is ≥ my top, when I'm not the owner, adds `roles.locked` and shows **no** actions.
  - Actions: edit / up / down / delete, with `aria-label` from `roles.editLabel|upLabel|downLabel|deleteLabel` `{name}`. `@everyone` has edit only. Up is hidden on the top movable row, down on the lowest.
  - A `roles.new` button.
  - While the slice is absent: `roles.loading`. On a load failure: `roles.error.load {code}` with `roles.retry`.
  - Move: `moveRole`. Success announces `roles.moved {name}`; failure shows `roles.error.move {name, code}`.
  - Delete: a ConfirmDialog (`roles.deleteTitle {name}`, `roles.deleteBody`, `roles.deleteConfirm`, `roles.deleteBusy`, cancel `roles.editor.cancel`). Success announces `roles.deleted {name}` and focuses `roles.new`. Failure sets `roles.error.delete {name, code}` in the same update as busy=false.
- [ ] **`RoleEditorFlow({ communityId, roleId | null, onClose, announce })`:**
  - A `Dialog` titled `roles.editor.titleNew {server}` or `roles.editor.titleEdit {name}`.
  - Fields:
    - a TextField `roles.editor.name` (hint `roles.editor.nameHint`). For `@everyone` the name field is read-only, and colour, hoist and mentionable are hidden;
    - ColorSwatches `roles.editor.color` (hint `roles.editor.colorHint`, none `roles.color.none`, options `paletteFor`);
    - Toggles `roles.editor.hoist` and `roles.editor.mentionable` (hint `roles.editor.mentionableHint`);
    - a PermissionGrid `toggle` titled `roles.editor.permissions`, with the `PERM_GROUPS` groups titled `perm.group.*` and rows labelled `perm.<key>` / `perm.<key>.hint`.
  - A bit I don't hold (from my channel-less bits; the owner and administrators hold all) is disabled with `roles.editor.notHeld`.
  - Submit: `roles.editor.create`/`creating` or `roles.editor.save`/`saving`. Create calls `createRole`; edit calls `updateRole` with only the changed fields. An unchanged submit closes without a call.
  - Name checks before the call: blank → `roles.error.empty`; over 100 bytes (UTF-8) → `roles.error.long`. The name is NFC-normalised before it's sent.
  - Refusals:
    - 403 → `roles.error.forbidden`;
    - 409 → `roles.error.conflict`;
    - 400 whose detail contains "at most 250" → `roles.error.full`;
    - 404 → `roles.error.gone`;
    - otherwise `roles.error.other {code}`.
  - Success announces `roles.editor.created|saved {name}` and closes to the opener.
- [ ] **Tests (FakeClient, which publishes before it resolves):**
  - tab visibility with and without manageRoles;
  - a locked row has no actions and shows `roles.locked`;
  - `@everyone` is last with edit only;
  - each refusal maps to its key;
  - the colour options are named, and a custom colour adds `roles.color.custom`;
  - move up/down calls `moveRole` with the direction;
  - an NFD name is sent as NFC;
  - not-held rows are disabled with the hint;
  - delete confirm → `roles.deleted`, and a failure shows the error with an enabled confirm;
  - `expectNoAxeViolations`.

  Focus return is proven in E1.
- [ ] **Gates:** G-web. **Commit:** `feat(web): roles tab and role editor in server settings`.

### Task WA2: Role assignment from the member list

**Model:** sonnet. **Lane:** WEB-R. **Depends on:** WA1, U3, U5.

**Files:** new `packages/web/src/screens/admin/MemberRolesFlow.tsx` (+ test); `members-model.ts` (+ test); `MemberPane.tsx` (pass the colour).

- [ ] `members-model.ts`:
  - `menuFor` adds `{ id: 'roles', label: t('roles.menu.assign') }` when `access.manageRoles`, after compare and before kick.
  - `memberGroups` sets each member's `color` to the colour of their highest **coloured** role (by position; 0 → null).
- [ ] **`MemberRolesFlow({ communityId, userId, onClose, announce })`:**
  - A `Dialog` (rendered through its portal) titled `roles.assign.title {name}`, with the body `roles.assign.body {name}` and the note `roles.access`.
  - A CheckList labelled `roles.assign.title`. Items are the non-`@everyone` roles, highest first, with `checked` = held and `color` = the role colour.
  - Disabled items: rank ≥ my top when I'm not the owner (detail `roles.assign.locked {role}`), or a role carrying a bit I lack.
  - Toggling calls `grantRole` / `revokeRole` with `busyId` set. Success announces `roles.assign.given|taken {role, name}`.
  - Refusals:
    - 403 whose detail contains "second factor" → `roles.assign.error.twoFactor {name}`;
    - other 403 → `roles.assign.error.forbidden {role}`;
    - 404 whose detail contains "not a member" → `roles.assign.error.gone {name}`;
    - otherwise `roles.assign.error.other {code}`.
  - With no assignable role at all: `roles.assign.none`.
  - `roles.assign.close` closes the dialog.
- [ ] **Tests:**
  - the menu item only with manageRoles;
  - locked and lacking-bit rows are disabled with their detail;
  - grant then revoke calls and announcements;
  - the twoFactor and gone mappings;
  - `roles.assign.none`;
  - the group colour comes from the highest coloured role;
  - axe.
- [ ] **Gates:** G-web. **Commit:** `feat(web): give and take roles from the member list`.

### Task WA3: Channel permissions and private create

**Model:** sonnet. **Lane:** WEB-C. **Depends on:** C2, C3, U1, U4, U5.

**Files:** new `packages/web/src/screens/admin/ChannelPermissions.tsx` (+ test); `ChannelEditFlow.tsx`; `ChannelsSection.tsx` (the private tag); `packages/web/src/screens/Create.tsx` (the new-channel flow) (+ tests).

- [ ] **`ChannelPermissions({ channelId, communityId, announce })`**, rendered in ChannelEditFlow's ChannelSettings `children` when `access.manageRoles` and the channel isn't a category:
  - Heading `chperm.title`.
  - A Toggle `chperm.private` (hint `chperm.privateHint`), on when `isPrivate(overwrites, everyoneId)`. Switching it opens a ConfirmDialog:
    - to private: `chperm.makePrivate.title {name}` / `.body` / `.confirm`;
    - to public: `chperm.makePublic.title {name}` / `.body {server}` / `.confirm`;
    - `chperm.cancel`, busy `chperm.busy`.

    Confirm calls `setChannelPrivate`. Its error follows the W1 contract, and focus returns to the Toggle.
  - A list `chperm.who` of the entries: `@everyone` first (`chperm.everyone`), then roles by position (highest first), then members (detail `chperm.member`). With none: `chperm.none`.
  - Each entry is a disclosure button (`aria-expanded`) that reveals, below it, a PermissionGrid in `tri` mode over the channel bits only (every PERM_GROUPS key whose bit is not in `COMMUNITY_BITS`). Values come from the entry: allow / deny / inherit.
  - A change calls `setOverwrite` with the new allow/deny and announces `chperm.saved {name}`.
  - Rows I can't set (target at or above my top; bits I lack) are disabled with `chperm.error.forbidden` as `disabledHint`.
  - Each entry except `@everyone` has a `chperm.remove` button (`chperm.removeLabel {name}`) → `setOverwrite` 0/0.
  - A Select `chperm.addLabel` (button `chperm.add`) lists the roles and members below me with no entry yet. Adding creates an entry with allow 0 / deny 0 shown open; nothing is sent until a value changes.
  - Refusals:
    - 403 → `chperm.error.forbidden`;
    - 400 whose detail contains "lose this channel", or E_BAD_INPUT `you would lose this channel` → `chperm.error.hidden`;
    - 404 → `chperm.error.gone`;
    - otherwise `chperm.error.other {code}`.
- [ ] **Private create.** Create.tsx's new-channel flow passes `children` to `CreateChannel` when `access.manageRoles` and the kind is text or voice:
  - a Toggle `chperm.create.private` (hint `chperm.create.privateHint`);
  - when it's on, a CheckList `chperm.create.roles` of the roles below my top (empty label `chperm.create.noRoles`).

  Submit sends `createChannel` with `private: { roleIds }` when the toggle is on.
- [ ] **ChannelsSection:** a private channel's row detail adds `chperm.privateTag`.
- [ ] **Tests:**
  - the makePrivate confirm text, and that it calls `setChannelPrivate(true)`;
  - the `hidden` refusal mapping;
  - the private create sends the ticked roleIds;
  - `noRoles` with no lower roles;
  - the tri grid hides community bits;
  - remove sends 0/0;
  - `chperm.privateTag` on the row;
  - axe.
- [ ] **Gates:** G-web. **Commit:** `feat(web): channel permissions and private channels`.

### Task WA4: Role mentions, pins by right, and the send hint

**Model:** sonnet. **Lane:** WEB-C. **Depends on:** WA3, C2, C5.

**Files:**
- `packages/web/src/screens/conversation/ComposerArea.tsx` (:14, :30, :75, :98)
- `screens/shell-model.ts` (:179-186 the mention render, :219 `mentionOptions`)
- `screens/conversation/MessageItem.tsx` (:74, the pin item)
- `screens/conversation/Pins.tsx`
- a new `packages/web/src/core/use-channel-bits.ts`
- their tests

- [ ] **`useChannelBits(communityId, channelId): number | null`** reads `roles:`, `members:`, `overwrites:` and `permissions:` (for `everyoneId`) plus the owner from `communities`, and returns `channelBitsOf(…)`. It returns null while anything is absent. With **null bits** the UI behaves exactly as today: the pin item is shown, the composer is shown, and `broadcast` stays as today.
- [ ] **Composer:**
  - `broadcast` = bits non-null ? `(bits & PERM.mentionEveryone) !== 0` : today's value.
  - The offered roles are the mentionable roles, or every non-`@everyone` role when `broadcast`, as `MentionRole { roleId, handle: roleHandle(name) }`. They're passed to `encodeMentions` (C5) at :75 and :98.
  - `mentionOptions(query, candidates, broadcast, roles)` appends role options whose handle starts with the query: `{ id: 'r-<id>', primary: t('mention.role', { name }), secondary: t('mention.role.secondary'), insert: '@<handle> ' }`, after the members and before `@everyone`, within the existing 8 + broadcast cap.
  - With bits non-null and no `PERM.sendMessages`: the composer is replaced by the text `chperm.cannotSend {name}`. It is advisory: W2b enforces.
- [ ] **Render:** shell-model:186 renders a known role id as `t('mention.role', { name })` with `color` set to the role's colour (U3). An id in `book.roles` without a summary keeps `shell.message.mentionRole`.
- [ ] **Pins:** the message menu's pin and unpin items show only when bits are null or hold `PERM.pinMessages`. The pins dialog shows `perm.pinsNote` under its title.
- [ ] **Tests:**
  - "@game-night" encodes to the role token; "Modérateurs" is offered as "@modérateurs" with the secondary "role";
  - `@everyone` isn't encoded or offered without the bit;
  - the pin item is hidden without PIN and shown with null bits;
  - `chperm.cannotSend` without SEND;
  - the role label renders with its colour;
  - `perm.pinsNote` is present;
  - axe on the composer with the role list open.
- [ ] **Gates:** G-web. **Commit:** `feat(web): role mentions, and pins and @everyone follow channel rights`.

### Task WA5: Per-server notifications

**Model:** sonnet. **Lane:** WEB-N. **Depends on:** C5 (rebases on WEB-C for shell-model.ts).

**Files:** `packages/web/src/screens/settings/Notifications.tsx` (+ test), `packages/web/src/notify.ts` (:20, :23, :140-141) (+ test), `packages/web/src/screens/voice/useSounds.tsx` (:43), `screens/shell-model.ts` (:103 and the rail badge mute).

- [ ] **Notifications.tsx:**
  - A section `serverNotify.title` (body `serverNotify.body`) before the channels section.
  - One row per listed server (name as row label), with:
    - a Segmented `default / all / mentions / nothing` (`serverNotify.mode.*`) that writes `notify.community.<hex>`; default deletes the key;
    - a Toggle `serverNotify.mute` (`mute.community.<hex>` = '1', or deleted);
    - a Toggle `serverNotify.suppressEveryone` (`everyone.community.<hex>`).
- [ ] **notify.ts:**
  - Pass the notice's community hex (from the channel's summary; null for DMs) to `isMuted` and `effectiveNotifyMode` at :20/:23, and to the ring checks at :140-141.
  - When `suppressesEveryone(settings, cid)` holds and a 'mention' notice's body has `!mentionsDirectly(body, me, myRoles)`, treat it as `'message'`.
  - useSounds :43 passes the ring's community too.
- [ ] **shell-model.ts:** channel rows (:103) and the rail use `isMuted(settings, channelId, communityId)`.
- [ ] **Tests:**
  - precedence through the UI: a server set to nothing silences a channel with no override, and a channel override still wins;
  - suppress turns a broadcast-only mention into `'message'` but keeps a direct one;
  - a muted server's row label uses `shell.channels.rowLabelMuted`;
  - the default deletes the key;
  - axe.
- [ ] **Gates:** G-web. **Commit:** `feat(web): notification settings per server`.

---

## Phase 3: sequential

### Task W-Shell: Shell integration

**Model:** sonnet; the **sole** owner of `packages/web/src/screens/Shell.tsx`. **Lane:** worktree. **Depends on:** WA1–WA5.

**Files:** Shell.tsx (:310 broadcast, :692 and :846 the ComposerArea props, the MemberPane mount ~:1004, the ServerSettings tab routing), Shell tests.

- [ ] Replace `const broadcast = channel !== null` (:310) with the WA4 hook value. Pass bits, roles and the role mention list to both ComposerArea mounts (:692, :846).
- [ ] Mount `MemberRolesFlow` from the MemberPane menu's `roles` item. It renders through the Dialog portal, and its close returns focus to that row's menu trigger through `asideReturnRef` when the drawer is narrow (W1 contract 3).
- [ ] Route the `roles` tab in ServerSettings (`adminTab` state).
- [ ] **Lost access:** when the open channel leaves the `channels:<cid>` list while its community remains:
  1. announce `chperm.lostAccess {name}`;
  2. navigate to the first listed channel of that server;
  3. keep the draft (the composer draft store is keyed by channel; do not clear it);
  4. close any channel dialog for it.
- [ ] **Tests:**
  - lost access: announcement, navigation and draft kept;
  - the assign dialog opens from the menu, and on close the menu trigger is the active element in the wide layout;
  - the roles tab routes;
  - `broadcast` false without the bit.
- [ ] **Gates:** G-web. **Commit:** `feat(web): roles, private channels and role mentions in the shell`.

### Task E1: Roles e2e from an empty instance

**Model:** sonnet. **Lane:** e2e. **Depends on:** W-Shell.

**Files:** a new `e2e/web/roles.spec.ts`. Its own host `{ port: 8491, control: 8492, webRoot: 'packages/web/dist' }` in the admin.spec.ts pattern; serial; the second browser through `launchSecond`. App bugs are reported as findings and never worked around.

- [ ] Steps:
  1. Ada signs up with the bootstrap invite and starts "Midgard Crew". Björn joins through Ada's invite.
  2. Björn's message menu on Ada's message has no `shell.message.pin`. Typing `@ev` in his composer offers no `@everyone`.
  3. Ada → server settings → `roles.tab` → `roles.new`: "Crew", green, `roles.editor.hoist` on, `roles.editor.mentionable` on, `perm.pin` on → `roles.editor.created`. **Focus is back on `roles.new`.**
  4. Ada → Björn's member menu → `roles.menu.assign` → tick Crew → `roles.assign.given`. `roles.assign.close`, and **focus is on Björn's menu trigger**. Both member lists show the group "Crew — 1".
  5. Björn pins Ada's message. Ada's pins dialog lists it with `shell.pins.by {name:'Björn'}` and shows `perm.pinsNote`.
  6. Ada sends "hi @crew". Björn's #general row label shows mentions 1, and the message renders "@Crew" on both sides.
  7. Ada edits Crew and turns `perm.pin` off. Ada's pins dialog **no longer** lists Björn's pin: the fold, with honest clients only.
  8. Ada deletes Crew → `roles.deleted`, and focus is on `roles.new`. Björn's list loses the group.
  9. `expectAccessible` on the roles tab, the editor and the assign dialog.
- [ ] **Gates:** G-e2e(roles.spec.ts), chromium and firefox. **Commit:** `test(e2e): roles from an empty instance`.

### Task E2: Private channels e2e from an empty instance

**Model:** sonnet. **Lane:** e2e. **Depends on:** E1.

**Files:** a new `e2e/web/private.spec.ts`. Its own host `{ port: 8493, control: 8494, webRoot: 'packages/web/dist' }`; the same pattern.

- [ ] Steps:
  1. Ada starts "Midgard Crew", Björn joins, and Ada creates the role "Staff".
  2. Ada makes a new text channel "staff-room" with `chperm.create.private` on and Staff ticked. Björn's channel list lacks it. Ada posts "before".
  3. Ada gives Björn Staff. staff-room appears for him, and "before" is **not** shown. Ada posts "after", and Björn sees it. Björn reloads: staff-room and "after" are still there.
  4. With staff-room open, Björn is shown `chperm.lostAccess` when Ada takes Staff, and staff-room leaves his list.
  5. Ada → #general → `admin.channel.open` → `chperm.private` → `chperm.makePrivate.confirm`. **Focus returns to the Toggle.** Björn loses #general. Ada turns it off → `chperm.makePublic.confirm`, and Björn gets #general back.
  6. Björn → Settings → Notifications → `serverNotify.mute` on "Midgard Crew". His #general row label uses `shell.channels.rowLabelMuted`.
  7. axe on the permissions section and on the private create.
- [ ] **Gates:** G-e2e(private.spec.ts), chromium and firefox. **Commit:** `test(e2e): private channels from an empty instance`.

### Task H1: User docs and README

**Model:** sonnet (not haiku). **Lane:** worktree. **Depends on:** E2.

**Files:** `docs/user/getting-started.md`, `README.md`.

- [ ] getting-started: add a section "Roles and private channels" after "Run your server". It covers:
  - making a role, colours, show separately, mentionable;
  - the permission editor, including which permissions have no effect yet;
  - giving roles from the member list;
  - private channels at creation and later;
  - per-channel settings;
  - `@role` mentions;
  - who sees pins and `@everyone`;
  - per-server notifications.

  Use the en.ts strings verbatim for every control name. Also update the line near :818 that says roles are API-only.
- [ ] README:
  - "what works" gains roles and private channels as of web-3.5;
  - remove the known-limits lines near :46 (roles) and :51 (pin/everyone checks);
  - add the honest limits: "who may send is checked only by members' apps in this version"; "people who gain a channel see only messages sent after they join it".
- [ ] Re-shoot the user-doc screenshots that show server settings, the member menu and the composer, if the docs embed any, following the existing screenshot procedure.
- [ ] **Gates:** G-docs. **Commit:** `docs(user): roles and private channels`.

## After the tasks (integrator: the controller)

**Hotspot owners in W2a:**

| File | Owner |
|---|---|
| Shell.tsx | W-Shell |
| ServerSettings.tsx | T0 (one-per-line), then WEB-R |
| ChannelEditFlow.tsx, ChannelsSection.tsx, Create.tsx, ComposerArea.tsx | WEB-C |
| Notifications.tsx, notify.ts, useSounds.tsx | WEB-N |
| shell-model.ts | WEB-C (mentions) first, then WEB-N (mute); WEB-N rebases |
| controller.ts lists, types.ts, protocol.ts, settings.ts, mentions.ts | CORE |
| core-port.ts, fake-core.ts, world.ts | CORE-R (R1) |
| sync/testing/model.ts | CORE-R first, then CORE rebases |
| protocol/09 | SRV |
| protocol/04 | R1 |
| protocol/vectors | X1 |
| protocol/07 | integrator |
| strings feature files and flow 09 | T1 only |

**Integration order:** T0 → X1 → T1 → SRV (S1, S2) → CORE-R (R1) → CORE (C1, C2, C3, C5, then C4) → UI (U1–U5) → WEB-R (WA1, WA2) → WEB-C (WA3, WA4) → WEB-N (WA5) → W-Shell → E1 → E2 → H1 → 07 rows.

Then:
- **protocol/07:** the rows from S2 and R1. Run check:docs.
- **Full wave gates** (roadmap A4): `npm test`; ui storybook and axe; Go `-race`; G-rust; `sqlc diff`; check:docs, check:copy and check:ci.
- **e2e regressions** before the whole-branch review: the new roles.spec and private.spec, plus `e2e/web/create.spec.ts`, `admin.spec.ts`, `membership.spec.ts`, `badges.spec.ts` and `conversation.spec.ts`, and `e2e/voice/controls.spec.ts`, on chromium and firefox.
- **Whole-branch review on opus**, plus a product walk from an EMPTY instance with two browsers through every flow above. Also:
  - a granted member's **second device** catches up in a private channel after a reload (risk 5: KeyPackage-less devices join by external commit);
  - measure op 54 reads per frame (now 6 with overwrites) at 2 and 20 members;
  - measure materialise latency after a role PATCH with 10 channels × 20 members. Card it if it takes over 1 s (risk 4).
- PR, CI green, merge; tag `v0.1.0-web3.5` (prerelease); verify the assets; tell Homelab to deploy; Jonas checks.
- Then re-read the appendix against the merged code and write W2b's plan (web3.6) in the same shape.

**Risks carried (opus sign-off):**
1. **S2 self entry.** The create-time self overwrite outlives a demotion: an ex-moderator keeps a private channel they created. It's visible in the channel's permission list and audited, and the owner or an admin can remove it. The alternative (D3): never allow self entries, and require a role below the creator.
2. **Host-served view.** A malicious host can grant folds. No doc may claim otherwise. Card SIGNED-POLICY (owner-signed role, grant and overwrite objects; with spec:681 and the W4 signed moderation events).
3. **Fold time semantics.** Demoted pinners' pins vanish (D1). The copy says so (`perm.pinsNote`, `perm.pin.hint`).
4. **Materialise cost.** A role PATCH re-derives every channel: O(channels × members) plus DS proposals. Measured in the walk.
5. **KeyPackage-less devices.** They join only by external commit. Checked in the walk.
6. **ABI 10 and the store bump.** These break the native peer, the conformance lists and the fakes. R1 updates every one; G-rust's `cargo test --workspace` covers the testkit.

**Decisions still open for Jonas** (the plan builds the recommended option):
- **D1.** Pins count by the pinner's *current* rights (built), or by their rights at receipt.
- **D3.** Allow the create-time self overwrite (built), or require a lower held role.
- **D2** (W2b): the host learns post vs. other per upload.
- **D4 and D5 are settled** by the controller (2026-10-15):
  - W2a = web3.5 and W2b = web3.6, with later waves shifting by one;
  - no category sync; private threads in a later wave; cross-server following out.

---

## Appendix: W2b (web3.6) design to re-read after W2a merges

**Scope:**
- an "upload class" protocol change, so the host enforces `send_messages` and slow mode on E2EE posts;
- the slow-mode UI;
- announcement channels;
- public threads.

Not in scope: private threads (a new group target, in a later wave) and cross-server following (spec:225 limits it to readable channels at v1; the integration device is W11 work).

W2b shares no files with W2a except the strings, the Shell owner and the core schema numbering. **Re-anchor every line number below against W2a's merged code before dispatch.**

**Reservations:**
- migration `00017_message_class.sql` (both engines), plus `sqlite/schema/015_message_class.sql` and its Postgres twin;
- no op (55 stays free); no permission bit;
- core local schema 5; browser ABI 11;
- flow doc 10;
- e2e ports 8495/8496 (E3) and 8497/8498 (E4);
- string prefixes `slow.`, `announce.` and `thread.`.

**Trust model (§2.2): a host-enforced upload class, verified by receivers.**
- Folding `send_messages` the W2a way would retroactively hide a demoted member's whole history, so it's rejected. Spec:468 binds send permission and slow mode to the uploading device session.
- **Upload body:** `[epoch, private_message, class]`. Class 0 = type 0 (a post); class 1 = types 1–6. The host stores the class and relays it as the 9th element of a message list row and the 7th of `message.ct`.
- **Host rules** (community E2EE text groups only; DMs unchecked):
  - class 0 needs `send_messages` in the channel → 403 E_FORBIDDEN;
  - class 0 is refused 429 E_RATE_LIMITED (`retry_after_ms`, detail "slowmode") within `slowmode_seconds` of the user's last class-0 upload in that channel, unless they hold `bypass_slowmode`.
- **Receiver rule (core):** a stored class that disagrees with the decrypted type (type 0 with class 1, or 1–6 with class 0) is neither shown nor folded. A legacy row with no class is accepted. After this version the host refuses a 2-element upload (400).
- **Metadata (D2):** the host learns post vs. not-post for every upload. Spec:468 already implies it. Ciphertexts are padded to 256 bytes, so today a short post and a reaction look alike.
- A slow-mode check on every upload would also throttle edits, deletes, reactions and pins: hence the class.
- `http/client.ts:95` sleeps on a 429 (unless `retry429:false`) while the group's drain lane is held. Slow mode therefore needs `retry429:false` plus an explicit requeue.

**Server, SB1 (opus); SB2 is folded into it:**
- **Schema:** `mls_app_messages.class INTEGER NULL` (Postgres `SMALLINT`), plus the index `(group_id, class, uploader_device, created)`. Update `dump.go` DumpTables.
- **Seam:** `ds.PostPolicy` (`Check(ctx, groupID, userID id.ID, class uint8, now int64) error`), implemented in `internal/api/postpolicy.go` with the rules above. Slow mode is per user per channel across its text groups (join `devices` on `uploader_device`).
- **Wire:**
  - upload `[epoch, private_message, class(uint 0|1)]`; 2 elements → 400; class > 1 → 400;
  - messages row `[…, deleted, class(uint|null)]`;
  - `message.ct` `[…, recv_ts, class(uint|null)]`.
- **Docs:** protocol/02 (endpoint 7 and the op 19 table); protocol/09 § Channels ("slow mode now applies to end-to-end encrypted posts"); `slowmode_seconds` PATCH already exists in channels.go, so only the prose changes.
- **testkit:** the native peer sends the class.
- **Tests:**
  - class 0 without send → 403; class 1 without send → 200;
  - slow mode 10 s: a second class-0 upload at +5 s → 429 with retry_after 5000; at +10 s → 200;
  - bypass → 200; class-1 uploads are not slowed;
  - a 2-element body → 400;
  - the messages row and the op 19 frame carry the class;
  - DMs are unchecked;
  - both engines.
- **Integrator 07 row:** "Behaviour change, wire additive for readers using atLeast", plus a **wire behaviour change** row: "the host refuses a 2-element upload". Check how the version close 4006 treats a stale cached bundle, and bump the client minimum if a mechanism exists (risk 7).

**Core and client-core:**
- **RB1 (opus):** parse the wire with an optional trailing class, store it, apply the mismatch rule, and send `postMessage(g, body, cls)`, where the class is `OutboxRow.type === 0 ? 0 : 1`. ABI 11.
- **TB1 (opus core):**
  - `app_messages.thread_id` plus an index;
  - `send_prepare` accepts `thread_id` for type 0. It must name a held type-0 root that itself has no thread_id, else E_CORE_INPUT;
  - the main timeline excludes rows whose thread root is held;
  - a root carries `thread {count, last_ts}`;
  - `thread_timeline(group, root, before, limit)` and `threads(group)`;
  - protocol/04 § Threads: a thread whose root isn't held, or a nested one, shows in the channel.

  Today every send uses `thread_id: None` (messages.rs:424), the local `app_messages` has no `thread_id`, and the timeline query is flat.
- **CB2 (opus):** send.ts uses `retry429:false`. On a 429 with the "slowmode" detail it calls `sendRequeue` and arms a timer for `retryAfterMs`. It publishes a `slow:<channelId>` slice `{ until: number }`. Tests: a 429 is requeued, not failed; the timer re-drains; no `sleep` in the lane.
- **CB3 (sonnet):**
  - `ChannelSummary.slowmode: number`;
  - `updateChannel` gains `slowmode: number | null` (patch slot 6; VALIDATOR ∈ SLOW_STEPS);
  - `createChannel` kind `'announcement'`: text plus overwrites `[@everyone deny SEND]`, a self allow SEND for a non-owner, and an allow SEND for each roleId.
- **TB2 (sonnet):**
  - commands `openThread {channelId, rootMsgId}`, `closeThread {channelId}`, and `send.threadId?`;
  - slices `thread:<channelId>` and `threads:<channelId>`;
  - `TimelineItem.thread: {count: number; lastTs: number} | null`.

**UI-B (sonnet):**
- a `ThreadPane` that renders in the AppShell aside; while a thread is open it replaces the member list (ruling: one aside);
- a MessageRow `thread` summary chip and toolbar item;
- a Composer `notice` slot for `slow.wait` / `announce.readOnly`.

**WEB-B (sonnet):**
- a ChannelSettings slow-mode Select with the steps 0/5/10/30/60/300/900/3600/21600;
- the announcement kind in the new-channel flow;
- the composer countdown;
- ThreadView;
- then W-Shell-B.

**Copy (flow 10, `strings/{slow,announce,thread}.ts`), exact:**

```
slow.label='Slow mode'  slow.hint='How long each person waits between messages. People who may bypass slow mode do not wait.'
slow.off='off'  slow.s5='5 seconds'  slow.s10='10 seconds'  slow.s30='30 seconds'  slow.m1='1 minute'  slow.m5='5 minutes'
slow.m15='15 minutes'  slow.h1='1 hour'  slow.h6='6 hours'  slow.wait='Slow mode is on. You can send again in {time}.'
slow.queued='Waiting for slow mode, then sending.'  slow.badge='slow mode'
announce.kind='announcement'  announce.hint='Only the roles you tick can post. Everyone can read and react.'
announce.roles='Roles that can post'  announce.readOnly='Only some people can post in #{name}.'
thread.open='reply in thread'  thread.summary.one='1 reply'  thread.summary.other='{count} replies'
thread.title='Thread'  thread.close='close thread'  thread.composer='reply in thread'  thread.list='threads'
thread.empty='No threads in #{name} yet.'  thread.rootMissing='The message that started this thread cannot be shown here.'
```

W2b also changes two values, so T1b must update flow 09's Copy too (flow09's test catches the drift):
- `perm.send.hint` → "Post in text channels. The host refuses posts from people without it."
- `perm.slowmode.hint` → "Send without waiting in channels with slow mode."

**e2e:**
- **E3 `slowmode-announce.spec.ts`** (8495/8496):
  - 10 s slow mode: Björn sends one message, the composer shows `slow.wait`, and the second message arrives after the wait;
  - an announcement channel: Björn sees `announce.readOnly` and can react;
  - a request crafted through the core-worker harness hook (class 0 without send) → 403. Use the harness, not the UI.
- **E4 `threads.spec.ts`** (8497/8498): reply in a thread; the summary count shows on both sides; the thread pane opens in the aside; a mention in a thread gives a badge.

**Task order:**
- P0: T0b (sonnet: the string files, flow 10, `strings.flow10.test.ts`), then T1b (sonnet: the copy).
- Then: SRV-B (SB1) → CORE-R-B (RB1, then TB1) → CORE-B (CB2, CB3, TB2) → UI-B → WEB-B → W-Shell-B → E3 → E4 → H1b → 07 rows.
- **Split again if needed:** threads (TB1/TB2/UI/E4) touch nothing of the class work except core schema numbering. If W2b runs long, ship threads as W2c.

**W2b risks:**
- 7: a stale cached web bundle gets 400 on every send until it reloads.
- 8: the post vs. fold class is visible to the host (D2).
- 9: the `perm.*.hint` drift in flow 09.
