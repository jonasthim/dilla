# dilla v0.1.0-web3.6: required second factor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every human account on an instance has a second factor, and the server enforces it.
- **Sign-up** ends with choosing an authenticator app (QR code, setup key, verify, backup codes) or a passkey (then backup codes).
- **Signing in on a new browser** takes the password and a code, or a passkey on its own. A backup code can replace either.
- **Accounts without a factor** cannot use the app until they add one: legacy accounts, sign-ups abandoned at the last step, and accounts after an operator reset. They meet a forced set-up screen and cannot skip it.
- **Settings → Sign-in** lists the factors. A person can add an app or a passkey, make new backup codes, and remove a factor while at least one remains.

**Architecture:**
- **dillad:**
  - one migration adds `users.factor_owed`, plus a boot-time reconcile that marks any human account holding no usable factor;
  - `Sessions.Middleware` and the gateway refuse an owed account everywhere except a short allow-list (default-deny);
  - the password and passkey logins state what each still owes (`needs`);
  - new routes list and remove factors, make new backup codes, and issue step-up tokens;
  - four new error codes (three from the design, plus `E_PASSKEY_UNKNOWN`, see S2);
  - an operator reset (`dillad admin user reset-factors`) and its test-host twin.
- **testkit (Rust):** native peers enrol TOTP for real.
- **client-core:** routes; a `factor-setup` phase gated in `enterReady`; a global `E_FACTOR_REQUIRED` hook; passkey and backup-code sign-in; factor-management commands; a `factors` slice.
- **packages/ui:** `QrCode` (vendored encoder), `CodeList`, `ChoiceCards`, `FactorRow`.
- **web:** `webauthn.ts`; the `FactorSetup` flow, mounted by Onboarding (step 5 of 6), SignIn (step 3) and App (forced); Settings → Sign-in with its `StepUpDialog`; the W2a `twoFactor` mapping by code.
- **Not in this wave:** no gateway op, no permission bit, no Rust core, browser ABI or local-schema change.

**Tech Stack:** Go (internal/api, internal/auth, internal/store, internal/ops, cmd/dillad), Rust (testkit only), TypeScript (client-core worker, React web, packages/ui and Storybook), Playwright e2e against dilla-testhost (CDP virtual authenticator for passkeys).

**Spec:** the web3.6 second-factor design (opus, 2026-10-15), carried here in full. Jonas's 2026-10-15 decision makes web3.6 this wave; **W2b (slow mode, announcements, threads) moves to web3.7** (D6). Code anchors are re-checked on `dilla-web-3-5-roles` @ 7d0822bb (W2a nearly done). Re-check them once more after W2a merges; a moved anchor is not a NEEDS_CONTEXT, a missing one is.

**Controller rulings (2026-10-15), all as the design recommends:**
- **D1:** vendor Nayuki's MIT `qrcodegen.ts`.
- **D2:** passkey user verification is `required`.
- **D3:** no instance-level off switch; the harnesses enrol for real.
- **D4:** a browser already set up is never asked again; its device key counts as possession.
- **D5:** an operator reset keeps sessions and forces every device to set up again.
- **D6:** W2b moves to web3.7.

## Global Constraints

- **Models** (controller ruling 2026-10-15): a task's `Model:` line is binding.
  - opus implements S1, S2 and C2.
  - opus reviews S1, S2, S3, C2, X2, and W1's `webauthn.ts`.
  - sonnet does everything else, including T0, T1 and H1 (docs and strings). **No haiku in this wave.**
- **Reservations:**
  - migration `00017_second_factor.sql` (sqlite and postgres) with schema `015_second_factor.sql` (both engines);
  - flow doc 10 (`docs/design/flows/10-second-factor.md`);
  - e2e ports 8495/8496 (E1), 8497/8498 (E2), 8499/8500 (E3);
  - no gateway op (55 stays free), no permission bit, no core ABI or local-schema bump.
  - W2b (web3.7) takes migration 00018 / schema 016, flow 11 and ports 8501–8504. T0 writes that into the W2a plan's appendix.
- **String prefixes:** new keys use `factor.`, `factorSignin.` and `factorSettings.`, in `packages/web/src/strings/{factor,factorSignin,factorSettings}.ts`.
  - Never add `signin.`, `settings.`, `devices.`, `notify.`, `appearance.` or `shell.` keys: strings.test.ts pins them. That is why the nav label is `factorSettings.nav`.
  - Never add `admin.`, `members.`, `mod.`, `removed.`, `roles.`, `perm.`, `chperm.`, `mention.` or `serverNotify.` keys: flows 08 and 09 pin them.
  - The **only** edited existing value is `onboarding.step` → `'Step {n} of 6'`. T1 changes it, with flow 01's Copy row.
  - **All copy is written in T1.** No other task adds or edits a key. A task that needs a missing key stops with NEEDS_CONTEXT.
- **Copy and wording:**
  - "backup code" in the UI; "recovery code" only on the wire and in Go/Rust identifiers.
  - Backup codes are never called, or confused with, the recovery key.
  - None of "secure", "safe", "protected", "encrypted", "E2EE", "MLS", "end-to-end" outside `strings/privacy.ts`.
  - Never claim the factor guards messages: it guards signing in on a new browser.
  - No `!`. Every key has a `key='value'` pair in flow 10's `## Copy`.
- **Secrets never persist:**
  - the TOTP secret, the otpauth URI and the backup codes travel only in command returns, never in a slice, a log or storage;
  - the page drops them when the step unmounts;
  - the step-up password goes once into `stepUp` and is cleared from the field and the component state;
  - the worker holds no step-up token beyond the command that spends it.
- **Design:** Mesh tokens and packages/ui components only. Keyboard first, visible focus. WCAG 2.2 AA including target size. Works at 360 px and 200 % zoom.
- **Contracts carried from Wave 1 and W2a.** Name them in every web and ui brief:
  1. **ConfirmDialog:** the caller sets `error` **in the same state update** that sets `busy` to false. Focus goes to the first field, else Cancel, never the destructive button.
  2. **Every dialog returns focus to its opener** on close (confirm, cancel, Escape, done). Each dialog's focus return is asserted in e2e (E1, E2), not only in Vitest.
  3. **Dialogs stop Escape at themselves** (`stopPropagation`, as packages/ui `Dialog` does): an Escape in the StepUpDialog or an add-factor dialog closes that dialog only, never the Settings frame under it.
  4. **`announce` is a required prop** of every flow and section. Announcements go through `useAnnouncer` (screens/announcer.ts), which **queues**: two announcements in a row are both spoken. Never add a second live region for the same text, and never use timers to space announcements.
  5. **FakeClient ordering:** a FakeClient command handler that changes state **publishes its slices before it resolves**, as the worker does.
  6. **A worker step that runs once per ready is re-armed on re-ready.** Memos keyed by ready (the factors read, the `onFactorRequired` latch) are cleared when the core is re-attached and when the phase leaves `ready`.
- **Server-owned behaviour:** every client gate is advisory. The client handles every refusal with its copy key, never with a raw code alone.
- **Refusals are mapped by status and code, never by detail text** (protocol rule; W2a lesson). Where the UI must tell two cases apart, the server gives them distinct codes (this wave adds `E_FACTOR_REQUIRED`, `E_TARGET_NO_FACTOR`, `E_STEP_UP` and `E_PASSKEY_UNKNOWN` for that reason). A brief that seems to need a detail match stops with NEEDS_CONTEXT.
- **Authority re-checks under the lock** (W2a lesson): every write gated on what the account holds re-checks it inside the transaction, under `LockUserForDeviceRegistration(uid)` (the user-row lock) for factor writes, or `LockCommunity` for community writes. Pinned by in-tx hook tests (below).
- **Test-first:** each behaviour has a test that fails first, then passes. Record the red run in the report.
- **Proving checks** (W2a lesson): a mutation that disables an authorisation check is refused by the commit classifier, so **never** write one. Prove each auth check by test design instead:
  - every refusal row has a **control** row that differs in exactly one input and succeeds;
  - every lock re-check has an **in-tx hook** test (the `beforeTx` repository wrapper, channels_test.go:785, pattern in roles_test.go `TestTheRoleRoutesRecheckTheRoleAndTheCommunityUnderTheLock`): the hook changes the state between the checks and the transaction, the request is refused, and the undisturbed control succeeds.

  Mutations stay for non-authorisation logic only (encoders, counters, phase routing). Each such logic change has one mutation the tests catch; record it.
- **Downstream typecheck** (W2a lesson): a task that changes a type another package imports (client-core `state/types.ts`, `worker/protocol.ts`, `http/routes.ts`, `http/client.ts` deps; packages/ui exports) also runs `npm run typecheck -w @dilla/web` before it reports. G-core and G-ui below include it.
- **Fixture reachability:** any state a test starts from must be reachable from the shipping client. E2E specs start from an EMPTY host and use the shipping UI only (the control routes `/debug/clock` and `/debug/reset-factors` stand in for time passing and for the operator, never for the client). dilladtest gets **no** seam that marks an account satisfied.
- **e2e before the PR:** run the **FULL** e2e suite (G-e2e-all), not a hand-picked regression list: every spec's sign-up and sign-in helper changes in this wave.
- **Env dirs:** each lane uses `CARGO_TARGET_DIR=/home/thim/.cache/dilla-w3/<lane>-target` and `GOCACHE=/home/thim/.cache/dilla-w3/<lane>-gocache`.
- **Harness:** single plain commands only: no `&&`, `;`, pipes or `$(...)`. Anything longer goes in a script file under the scratchpad the dispatch names.
- **Commits:** `git commit -s -F <file>`. Every message's body ends with exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01XLFud8eoDaqf8uiZq5wjuP`
- **Process:** no subagents inside a task; no push, tag or release; never a bare `git stash`. A commit-time security scanner flag counts as real until shown otherwise. Ask, don't guess: anything the brief doesn't settle is NEEDS_CONTEXT.

## Review Focus

1. **Bypass of the requirement.**
   - An owed enrolled session reaches anything beyond the allow-list: an HTTP route, a DS route (including the `V` routes `POST /v1/keypackages` and the welcomes), the gateway, or a fresh session from establish.
   - A login path issues a complete assertion for an account that holds a factor: password (`needs` must be 1 or 2), passkey without UV, OIDC, a recovery-verify of a `needs 0` assertion, a passkey step-up ceremony replayed as a login.
   - An account holds no usable factor but is not owed (an `rp_id` change, a restored archive, drift). The boot reconcile closes it.
   - Pinned in S1 (the route sweep), S2 (the login matrix) and S1's reconcile test.
2. **Lockout.**
   - Removing the last factor, including two devices removing the two last factors at once (the user lock).
   - A regenerate that leaves no codes.
   - A reload on the backup-codes step (the codes are gone; Settings can make new ones).
   - A sign-up abandoned at step 5.
   - Clock skew.
   - The operator reset, which must leave the person able to sign in with password plus recovery key.
   - Pinned in S2, S3, C2 and E3.
3. **Step-up and stolen sessions.**
   - Add, remove or regenerate without a valid token; a token from another session; a spent token; step-up brute force; a step-up failure locking password login.
   - A factor added without a step-up because another device confirmed the first factor in between (the begin/confirm window).
   - Pinned in S2.
4. **Honest copy.**
   - Backup codes are never the recovery key.
   - "Browsers already set up do not ask again" is true: a device key re-establishes without the factor (D4).
   - The shared-computer passkey warning.
   - No promise that the factor protects message content.
   - Pinned in T1 and H1.
5. **Ceremony a11y and states.**
   - The QR code has a text alternative: the setup key, copyable, readable character by character.
   - Code fields use `autocomplete="one-time-code"` and `inputMode="numeric"`.
   - After a cancelled or refused WebAuthn ceremony, focus goes to the button that started it.
   - The codes list is a real `<ol>`.
   - Step-up and action dialogs return focus to the row button, and Escape closes only the top dialog.
   - 360 px / 200 %.
   - Pinned in U1–U4, W1–W3 and E1–E3.

## Recipe (anchors re-checked on `dilla-web-3-5-roles` @ 7d0822bb; W2a's recipe applies)

- **Auth handlers:** `internal/api/auth.go`.
  - `Assertions` (:28; `Issue` :52, `Spend` :69, `Upgrade` :86) is the model for `StepUps`.
  - `PasswordLogin` :147 (calls `secondFactorPending` :256); `secondFactorPending` :277; `loginLedger` :303; `failure` :319.
  - `EnrollTOTP` :456 (refuses over a confirmed secret), `ConfirmTOTP` :506 (mints codes at :540-545), `VerifyTOTP` :577, `VerifyRecovery` :598, `verifySecondFactor` :612 (the throttle/spend pattern).
  - `BeginPasskeyRegistration` :694, `FinishPasskeyRegistration` :721, `BeginPasskeyLogin` :755, `FinishPasskeyLogin` :800 (all refusals today are `401 E_UNAUTHENTICATED` with an empty detail, :835; `secondFactorPending` at :843).
  - `CallbackOIDC` :946 (`secondFactorPending` at :1043).
  - Routes are registered in `api.go` :174-194 (auth), :197-199 (accounts), :206-227 (devices, backups, sessions), :232 (ticket). `d.enrolled` :294, `d.scoped` :298.
- **Passkeys:** `internal/auth/passkey.go`: `ConfigFromDilla` :35, `credentials` :130, `flagsFromByte` :177, `storeSession` :191 / `takeSession` :208 (ceremony kinds: `webauthn_ceremonies.kind` is `CHECK (kind IN (0, 1))`, schema/003_auth.sql:56), `BeginRegistration` :223, `FinishRegistration` :243, `BeginLogin` :295, `FinishLogin` :314. go-webauthn v0.18.2.
- **Second-factor rule for mod roles:** `requireSecondFactor` is `internal/api/roles.go:119` (refuses `E_FORBIDDEN` at :135); its in-tx re-check is near :828. Tests: communities_test.go:144-200, roles_test.go:866-920.
- **Middleware:** `internal/auth/session.go`: `Session` :161, `Resolve` :807, `Middleware` :930, `scopeRefusal` :972. Every HTTP route goes through `Sessions.Middleware`: api.go:299, and the per-group wrappers in messages.go:48, heal.go:17, dsmeter.go:74, groups.go:97/111/127, keypackages.go:32/35. **keypackages.go:35 mounts `POST /v1/keypackages` and the welcomes with `want = ScopeProvisional`**, which also admits an enrolled session (see S1).
- **Gateway:** `internal/gateway/session.go`: `Resolve` :179, the enrolled-only check :191; close 4003 is `CloseUnauthenticated` (frame.go:72). The web client reconnects after 4003 and mints a fresh ticket (client-core `gateway/gateway.ts` handles only 4004 specially, :263).
- **Store:**
  - sqlc queries `internal/store/{sqlite,postgres}/queries/{sessions,auth,accounts}.sql`. Existing: `GetSessionByHash` (sessions.sql:5), `GetTOTP`, `DeleteRecoveryCodes`, `PutRecoveryCode`, `ConsumeRecoveryCode`, `CountRecoveryCodes` (unused only), `ListWebauthnCredentials(rp_id, user_id)`, `GetWebauthnCredential`, `PutCeremony`/`GetCeremony`. **Missing:** a TOTP delete and a credential delete.
  - `PutRecoveryCodes` already replaces the whole set (sqlite repo.go:553 → `DeleteRecoveryCodes` first); the Postgres twin likewise.
  - rows.go `UserRow`/`SessionRow`; store.go `Auth`/`Accounts` interfaces; `LockUserForDeviceRegistration` store.go:105.
  - `contract_test.go`'s method lists; `schema_test.go` (migration Up = schema file verbatim; precedent for `ALTER … ADD COLUMN … CHECK` in schema/012_blob_refs_pending.sql); `dump_test.go`, `dump.go`.
  - The `users` table is `STRICT` (schema/002_accounts.sql:1-14).
  - Generated code is always regenerated (`sqlc generate`), never hand-merged.
- **Production `CreateUser` callers:** `internal/api/accounts.go:178` and `internal/dillad/dilladtest/seed.go:614` (`seedOne`, the `/debug/seed` route, used only by seed_test.go).
- **Errors:** a code goes in three places, all diffed by `scripts/check-protocol-docs.mjs`:
  - `internal/server/errors.go` (constant plus a `Status()` case);
  - a protocol/02 § Errors row (~:771);
  - `testkit/src/ds/state.rs` `WIRE_CODES` (:108, sorted).
- **Protocol docs:** protocol/09 § Sessions (:24, the scope table), § Accounts and devices, § Auth ceremonies (:180), § Admin (:1140), the instance document's `auth_methods` (`0 password, 1 totp, 2 passkey, 3 oidc`, :1307). protocol/02 § Device sessions (:24) and § Errors (:771).
- **Admin CLI:** `cmd/dillad/admin.go`: `nounUsage["user"]` :53, the verb switch :450, `setUserDisabled` :487 (the pattern, including how it closes sockets, :900).
- **Doctor:** the checks are `Leg`s in `internal/ops/doctor.go` (e.g. `UDPLeg` :374), wired in `cmd/dillad/doctor.go:189` and `internal/dillad/diagnostics.go:51`. There is no `server.behind_proxy` key: it is `tls.mode = "behind_proxy"` (config.go:15-16, `TLSModeBehindProxy` :53).
- **Config:** `defaults.go:75` (`UserVerification: "preferred"`), :130-138 (`RPID` / `RPOrigins` defaults); `validate.go:316-324` (`auth.methods`), :335 (`rp_origins`).
- **Test host:** `internal/dillad/dilladtest/seed.go` (`ControlHandler` :33, `POST /debug/clock` :35, `POST /debug/kick` :52), `host.go` (`HostOptions` :59, the fake clock :220, `hostConfig` :266 with `Instance.Domain = "dilla.test"` :268, `AsDevice` :495), `cmd/dilla-testhost/main.go` (flags :43-54), `e2e/web/support/host.ts` (`HostConfig` :10, `hostArgs` :16).
- **testkit:** `testkit/src/ds/remote.rs` (`PasswordLogin` :144-148, `decode_password_login` :778, `redeem_invite` :1185, `password_login` :1395, `control_post` / `DILLA_TESTKIT_CONTROL` :2110-2125, the decode test :3555); `testkit/src/web_driver.rs` (the three `needs_totp` call sites :784, :1285, :1621); `testkit/Cargo.toml` (`sha2` is direct; `hmac`/`sha1` are not). The Go harness passes `DILLA_TESTKIT_CONTROL` (internal/testkit/scenario.go:33).
- **client-core:**
  - `http/routes.ts`: `PasswordLogin` :24, `passwordLogin` :543, `totpVerify` :548; `instance.authMethods` :17/:265.
  - `http/client.ts`: `HttpDeps` :23, `HttpClient.request` :52 (the refusal is thrown at the end of the attempt loop).
  - `account/enrol.ts` (`login` :23 sets `this.factorOwed` = the assertion owes TOTP, :28; `totp` :32). Its `factorOwed` is the assertion's debt, not the account flag: C2 renames it `assertionOwes` to avoid two meanings.
  - `account/signup.ts`: `submit` :16 and `resume` :26 both call `refillKeyPackages` (:24, :39) after `publishDeviceList`.
  - `worker/controller.ts`: `ACCEPTS` :299, `VALIDATORS` :396 (`...ROLES_VALIDATORS` :398), the sign-in validators :470-471, `dispatch` ~:834-851, `bootStore` :994, `enterReady` :1074 (steps a–f to :1110, the gateway with `mintTicket` → `postTicket` :1128), the gateway-ready KP refill :1293, `signupSubmit` :1387, `signInLogin` :1461, `signInTotp` :1482, `enrolWithKey` :1545; `passwordSignup` from `authMethods.includes(0)` :969.
  - `state/types.ts`: `BootPhase` :5-6.
- **web:**
  - `App.tsx` `screenFor(phase)` :21 (pure on the phase today); `case 'shell'` mounts `<Settings />` beside `<Shell />` (:224).
  - `router.ts`: `SettingsSection` :4 and the **`SETTINGS_SECTION` regex :19**, which must gain `signin` too.
  - `Settings.tsx`: `NAV` :31 (one per line already). Settings has **no announcer** today.
  - `screens/announcer.ts` `useAnnouncer` :11 (queues).
  - `SignIn.tsx` has its own live region (:267); Onboarding.tsx has none.
  - `screens/admin/MemberRolesFlow.tsx` :69-75 (the refusal mapping; `forbidden(err)` from `shared.ts`).
  - Strings: `en.ts` `onboarding.step` :76 (`'Step {n} of 5'`), `signin.step` :127 (`'Step {n} of 4'`, pinned by strings.test.ts:44).
- **ui:** `packages/ui/src/<C>/{C.tsx, C.css, C.stories.tsx, C.test.tsx}`, exported from `src/index.ts`; `Dialog` already stops Escape (Dialog.tsx:30). `DeviceRow` and `RecoveryKey` (its print pattern, :11-19) are the models for U4 and U2.
- **e2e:** `e2e/web/support/app.ts`: `Account` :420, `signUp` :432, `completeSignUp` :440, `finishSignIn` :566. Worker-driven sign-ups that bypass the UI: `e2e/web/core-worker.spec.ts` (:75, :212, :342, :481, :516, :562) and `e2e/web/spike-joinall.spec.ts:64`. `e2e/voice/support/voice.ts:137` uses `signUp`.

**Gate macros**, run as single commands, one at a time:
- **G-go:** `go vet ./internal/... ./cmd/...`, then `go test -race -shuffle=on ./internal/api/... ./internal/auth/... ./internal/store/... ./internal/gateway/... ./internal/dillad/... ./internal/ops/... ./internal/config/... ./cmd/dillad/...`.
- **G-sqlc:** `sqlc diff` (sqlc 1.31.1, as ci.yml:718-725).
- **G-docs:** `npm run check:docs`.
- **G-rust-tk:** `cargo fmt --all --check`; `cargo test --workspace --all-features --locked`; `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`.
- **G-scenario:** the scenario harness as CI runs it (ci.yml:649-678): build the testkit binary and the wasi core, then `go test -race -shuffle=on -timeout 25m ./internal/testkit/...` with `DILLA_TESTKIT=<binary>` and `DILLA_TESTKIT_REQUIRED=1`. Put the env and the command in a scratchpad script.
- **G-core:** `npm test -w @dilla/client-core`, `npm run typecheck -w @dilla/client-core`, `npx eslint --max-warnings 0 packages/client-core`, and the downstream `npm run typecheck -w @dilla/web`.
- **G-ui:** `npm test -w packages/ui`, `npm run typecheck -w packages/ui`, `npm run build-storybook -w packages/ui`, `npm run test:storybook:ci -w packages/ui`, and the downstream `npm run typecheck -w @dilla/web`.
- **G-web:** `npm test -w @dilla/web`, `npm run typecheck -w @dilla/web`, `npx eslint --max-warnings 0 packages/web`, `npm run check:copy`.
- **G-e2e(spec):** `npm run build -w @dilla/web`, then `npm run test:e2e:web:chromium -w @dilla/e2e -- <spec>` (and `:firefox`).
- **G-e2e-all:** `npm run build -w @dilla/web`, then each of: `npm run test:e2e:web -w @dilla/e2e` (chromium, firefox and webkit), `npm run test:e2e:core -w @dilla/e2e`, `npm run test:e2e -w @dilla/e2e`, `npm run test:e2e:voice:chromium -w @dilla/e2e`, `npm run test:e2e:voice:firefox -w @dilla/e2e`.

---

## Phase 0: sequential, on the wave branch

### Task T0: Hotspot prep and the W2b renumbering

**Model:** sonnet. **Lane:** worktree. **Depends on:** —. **Behaviour-preserving**: no visible change.

**Files:**
- Create: `packages/web/src/strings/factor.ts`, `factorSignin.ts`, `factorSettings.ts`
- Modify: `packages/web/src/strings/en.ts`
- Create: `packages/web/src/strings/strings.flow10.test.ts`
- Create: `docs/design/flows/10-second-factor.md`
- Create: `packages/client-core/src/account/factors.ts`
- Modify: `packages/client-core/src/worker/controller.ts` (`VALIDATORS` :396-398 and its imports)
- Modify: `packages/web/src/router.ts` (the `SettingsSection` union, :4)
- Modify: `docs/superpowers/plans/2026-10-15-dilla-web-3-5-roles.md` (the W2b renumbering)

- [ ] **Step 1.** Create the three feature string files. Each is exactly this, with its own name and prefix:
  ```ts
  // Flow 10 (docs/design/flows/10-second-factor.md): second factor copy. Keys: factor.*
  export const factor = {} as const;   // factorSignin.ts: factorSignin; factorSettings.ts: factorSettings
  ```
  In en.ts, import them next to the `serverNotify` import. Spread `...factor, ...factorSignin, ...factorSettings` immediately after `...serverNotify` in the `en` object.
- [ ] **Step 2.** In router.ts, rewrite the union one member per line, same order, nothing else:
  ```ts
  export type SettingsSection =
    | 'devices'
    | 'notifications'
    | 'appearance'
    | 'voice'
    | 'privacy'
    | 'keyboard'
    | 'diagnostics';
  ```
  Leave `NAV` in Settings.tsx as it is (already one per line).
- [ ] **Step 3.** Create `packages/client-core/src/account/factors.ts`:
  ```ts
  // Wave web3.6 (flow 10): second factors. FactorsController lands in Task C3.
  /** Per-feature synchronous checks for the web3.6 factor commands; Task C3 narrows the key type to its methods. */
  export const FACTOR_VALIDATORS: Partial<Record<string, (c: Record<string, unknown>) => string | null>> = {};
  ```
  In controller.ts, import it and add `...FACTOR_VALIDATORS,` on its own line after `...ROLES_VALIDATORS,` in `VALIDATORS`.
- [ ] **Step 4.** Create `strings.flow10.test.ts` as a copy of `strings.flow09.test.ts`, with these changes:
  - the describe title: `'flow 10 (v0.1.0-web3.6, second factor)'`;
  - the doc path: `docs/design/flows/10-second-factor.md`;
  - the prefix regex: `/^(factor|factorSignin|factorSettings)\./`;
  - **no** `pairs.length` pin yet (T1 adds it);
  - the States row minimum: 22;
  - `const LOWER: readonly string[] = [];` (T1 fills it).

  The sections test fails until T1, so mark it `it.skip` with the comment `// T1 writes the sections`.
- [ ] **Step 5.** Create `10-second-factor.md` with the title `# Flow 10: second factor (v0.1.0-web3.6)` and the empty headings `## States`, `## 1280×800`, `## 360×740`, `## Keyboard map`, `## Focus rules`, `## Announcements`, `## Copy`.
- [ ] **Step 6.** In the W2a plan, renumber W2b (D6). Change only these, and list every edited line in the report:
  - :37 `**W2b = web3.6**` → `**W2b = web3.7**` (and "Later waves shift one tag" → "Later waves shift two tags; web3.6 is the second-factor wave");
  - :48 `8495–8498 are W2b's` → `8495–8500 are web3.6's; 8501–8504 are W2b's`;
  - :49 `Flow doc 09 (10 is W2b's)` → `Flow doc 09 (10 is web3.6's, 11 is W2b's)`;
  - :50 `(00017 / schema 015 are W2b's)` → `(00017 / schema 015 are web3.6's, 00018 / 016 are W2b's)`;
  - :51-52 core schema 5 and ABI 11 stay W2b's (web3.6 takes neither): leave the numbers, keep the text;
  - :1284 "write W2b's plan (web3.6)" → "(web3.7)"; :1299 the same rename;
  - the appendix header :1304 → `## Appendix: W2b (web3.7) design to re-read after web3.6 merges`;
  - the appendix reservations :1316-1322: migration `00018_message_class.sql` and schema `016_message_class.sql`; flow doc 11; e2e ports 8501/8502 (E3) and 8503/8504 (E4); and the same in the E3/E4 lines (:1406, :1410) and the copy heading (`Copy (flow 11, …)`).
- [ ] **Step 7.** Gates: G-core and G-web. `git diff --stat` lists only the files above.
- [ ] **Step 8.** Commit: `chore: wave web3.6 string files and flow 10 skeleton`.

### Task T1: Flow 10 copy and doc

**Model:** sonnet (not haiku). **Lane:** worktree. **Depends on:** T0.

**Files:** `packages/web/src/strings/{factor,factorSignin,factorSettings}.ts`, `packages/web/src/strings/en.ts` (`onboarding.step` only), `docs/design/flows/10-second-factor.md`, `packages/web/src/strings/strings.flow10.test.ts`, `docs/design/flows/01-onboarding.md`, `docs/design/flows/03-sign-in.md`.

- [ ] **Step 1.** Paste every key below into its feature file, chosen by prefix: `factor.*` → factor.ts, `factorSignin.*` → factorSignin.ts, `factorSettings.*` → factorSettings.ts.
  - Use admin.ts's style: one `'key': 'value',` per line, in the order below.
  - Values are byte-exact, including the typographic ….
  - There are **127** keys: factor 57, factorSignin 17, factorSettings 53.

```
factor.step='Step {n} of 3'  factor.choose.title='Add a second factor'
factor.choose.body='Every account on {instance} needs a second factor. Signing in on a new browser then takes your password and a code from an authenticator app, or a passkey on its own.'
factor.choose.required='Your account does not have a second factor yet. {instance} now asks every account for one, so add it before you go on.'
factor.choose.label='Second factor'  factor.choose.app='authenticator app'
factor.choose.appHint='An app on your phone that shows a new six-digit code every 30 seconds.'
factor.choose.passkey='passkey'
factor.choose.passkeyHint='Your phone, a security key or this computer confirms it is you with a fingerprint, your face or a PIN. A passkey signs you in on its own.'
factor.choose.passkeyOff='Passkeys cannot be used here. Use an authenticator app.'
factor.choose.noPassword='Your account has no password, so its second factor is a passkey.'
factor.choose.next='Continue'  factor.totp.title='Set up your authenticator app'
factor.totp.body='In the app, add an account and scan this code. If you cannot scan it, type the setup key instead.'
factor.totp.qr='QR code to add {username} on {instance} to an authenticator app'
factor.totp.key='Setup key'  factor.totp.copyKey='Copy'  factor.totp.keyCopied='Setup key copied.'
factor.totp.code='Code from the app'  factor.totp.codeHint='Six digits. The app shows a new one every 30 seconds.'
factor.totp.loading='Making a setup key…'  factor.totp.submit='Continue'  factor.totp.working='Checking…'
factor.passkey.title='Add a passkey'
factor.passkey.body='Your browser asks where to keep the passkey: on this computer, your phone or a security key. Keep it on this computer only if no one else uses it.'
factor.passkey.name='Passkey name'  factor.passkey.nameHint='So you can tell your passkeys apart later. Up to 64 characters.'
factor.passkey.defaultName='Passkey {n}'  factor.passkey.submit='Add passkey'  factor.passkey.working='Waiting for your passkey…'
factor.back='Back'  factor.codes.title='Your backup codes'
factor.codes.body='If you lose your phone or your passkey, each of these codes signs you in once in its place. Keep them with your recovery key, away from this computer.'
factor.codes.notKey='Backup codes are not your recovery key. You still need the recovery key to add a browser.'
factor.codes.label='Backup codes'  factor.codes.print='Print'  factor.codes.copy='Copy'  factor.codes.copied='Backup codes copied.'
factor.codes.ack='I have written down or printed my backup codes'  factor.codes.ackHint='Tick the box to continue.'
factor.codes.next='Continue'  factor.done.title='Second factor added'
factor.done.totp='Signing in on a new browser now takes your password and a code from your authenticator app.'
factor.done.passkey='You can now sign in on a new browser with this passkey.'
factor.done.next='Open dilla'  factor.added='Second factor added.'
factor.error.required='Fill in this field.'  factor.error.codeFormat='A code has six digits.'
factor.error.code='That code did not match. Type the code the app shows now, and check that your phone sets its clock automatically.'
factor.error.cancelled='No passkey was added. Try again, or use an authenticator app.'
factor.error.wrongAddress='Passkeys do not work at this address of {instance}. Use an authenticator app, and tell the operator.'
factor.error.exists='This passkey is already on your account.'
factor.error.refused='{instance} did not accept the passkey. Try again, or use an authenticator app.'
factor.error.nameLong='A name is up to 64 characters.'  factor.error.tooMany='Too many attempts. Try again in {seconds} s.'
factor.error.network='The connection dropped. Check it and try again.'  factor.error.other='That did not work ({code}). Try again.'
factorSignin.usePasskey='Sign in with a passkey'  factorSignin.passkey.title='Use your passkey'
factorSignin.passkey.body='This account signs in with a passkey. Your browser asks for it when you continue.'
factorSignin.passkey.submit='Use passkey'  factorSignin.passkey.working='Waiting for your passkey…'
factorSignin.passkey.failed='The passkey did not sign you in. Try again, or sign in with your password.'
factorSignin.passkey.unknown='{instance} does not know this passkey. It may belong to another account or another server.'
factorSignin.passkey.needsCode='This passkey did not check that it is you, so {instance} also asks for your code.'
factorSignin.useBackup='Use a backup code instead'  factorSignin.backup.title='Use a backup code'
factorSignin.backup.body='Type one of the backup codes you saved when you added your second factor. Each code works once.'
factorSignin.backup.label='Backup code'
factorSignin.backup.failed='That backup code did not work. Sign in again and try another one.'
factorSignin.backup.format='A backup code has 26 letters and digits. Hyphens and spaces do not matter.'
factorSignin.lost='Lost your phone? Use a backup code, or ask the operator of {instance} to reset your second factor.'
factorSignin.left.one='You have 1 backup code left. Make new ones in Settings, under sign-in.'
factorSignin.left.other='You have {count} backup codes left. Make new ones in Settings, under sign-in.'
factorSettings.nav='sign-in'  factorSettings.title='Sign-in'
factorSettings.body='What {instance} asks for when you sign in on a new browser. Browsers that are already set up, like this one, do not ask again.'
factorSettings.loading='Loading…'  factorSettings.error.load='Could not load your sign-in settings ({code}).'  factorSettings.retry='Try again'
factorSettings.password='Password'  factorSettings.password.set='This account has a password.'  factorSettings.password.none='This account has no password.'
factorSettings.totp='Authenticator app'  factorSettings.totp.on='Added {date}.'  factorSettings.totp.off='Not set up.'
factorSettings.totp.add='add authenticator app'  factorSettings.totp.remove='remove'  factorSettings.totp.removeLabel='remove the authenticator app'
factorSettings.passkeys='Passkeys'  factorSettings.passkeys.none='No passkeys yet.'
factorSettings.passkeys.used='Added {created}, last used {used}.'  factorSettings.passkeys.unused='Added {created}, not used yet.'
factorSettings.passkeys.add='add passkey'  factorSettings.passkeys.remove='remove'  factorSettings.passkeys.removeLabel='remove {name}'
factorSettings.codes='Backup codes'  factorSettings.codes.one='1 backup code left.'  factorSettings.codes.other='{count} backup codes left.'
factorSettings.codes.none='No backup codes left. Make new ones so you are not locked out.'
factorSettings.codes.make='make new backup codes'  factorSettings.codes.makeTitle='Make new backup codes?'
factorSettings.codes.makeBody='Your old backup codes stop working at once.'  factorSettings.codes.makeConfirm='Make new codes'
factorSettings.only='This is your only second factor. Add another one before you remove it.'
factorSettings.removeTitle.totp='Remove the authenticator app?'  factorSettings.removeTitle.passkey='Remove {name}?'
factorSettings.removeBody='You can no longer sign in on a new browser with it. Browsers that are already set up keep working.'
factorSettings.removeConfirm='Remove'  factorSettings.removeBusy='Removing…'  factorSettings.cancel='Cancel'
factorSettings.removed.totp='Authenticator app removed.'  factorSettings.removed.passkey='{name} removed.'
factorSettings.codesMade='New backup codes made.'  factorSettings.stepUp.title='Confirm it is you'
factorSettings.stepUp.body='Type your password to change how you sign in.'  factorSettings.stepUp.password='Password'
factorSettings.stepUp.passkeyBody='Use one of your passkeys to change how you sign in.'
factorSettings.stepUp.usePasskey='Use passkey'  factorSettings.stepUp.confirm='Confirm'  factorSettings.stepUp.working='Checking…'
factorSettings.stepUp.failed='That password did not work.'  factorSettings.stepUp.expired='That took too long. Confirm it is you again.'
factorSettings.lost='Lost your phone or a passkey? Add a new second factor here, then remove the old one. Without a browser that is set up, use a backup code to sign in, or ask the operator of {instance} to reset your second factor.'
factorSettings.error.only='You cannot remove your only second factor.'
factorSettings.error.changed='Your sign-in settings changed on another device. Check them and try again.'
factorSettings.error.other='That did not work ({code}). Try again.'
```

- [ ] **Step 2.** In en.ts change only `'onboarding.step': 'Step {n} of 5'` → `'Step {n} of 6'`. `signin.step` stays `'Step {n} of 4'` (strings.test.ts:44 pins it).
- [ ] **Step 3.** Write the `## Copy` section of 10 as a bulleted list of `` `key='value'` `` pairs: all 127, in the order above.
- [ ] **Step 4.** Write 10's `## States` table: one row per state, columns `| State | What shows | Copy keys |`. At least these 22 rows:
  1. choose for sign-up (`factor.step`, `factor.choose.title|body|label|app|appHint|passkey|passkeyHint|next`);
  2. choose when forced (`factor.choose.required`, no skip or cancel control);
  3. passkey unusable (`factor.choose.passkeyOff`, the card disabled with its reason);
  4. no-password account (`factor.choose.noPassword`, passkey only);
  5. TOTP loading (`factor.totp.loading`);
  6. TOTP shown: QR and key, key copied (`factor.totp.title|body|qr|key|copyKey|keyCopied|code|codeHint|submit`, `factor.back`);
  7. TOTP checking (`factor.totp.working`);
  8. wrong or malformed code (`factor.error.code|codeFormat|required`);
  9. passkey naming (`factor.passkey.title|body|name|nameHint|defaultName|submit`, `factor.error.nameLong`);
  10. passkey waiting (`factor.passkey.working`);
  11. passkey cancelled / wrong address / exists / refused (`factor.error.cancelled|wrongAddress|exists|refused`);
  12. backup codes: unticked, ticked, copied (`factor.codes.*`);
  13. forced done (`factor.done.title|totp|passkey|next`, `factor.added`);
  14. sign-in with a passkey (`factorSignin.usePasskey`, `factorSignin.passkey.title|body|submit|working|failed|unknown`);
  15. sign-in needs a code after a passkey (`factorSignin.passkey.needsCode`);
  16. backup-code sign-in, a failure, and codes left (`factorSignin.useBackup|lost`, `factorSignin.backup.*`, `factorSignin.left.one|other`);
  17. Settings loading and error (`factorSettings.loading|error.load|retry`);
  18. Settings with the app only, remove disabled (`factorSettings.nav|title|body|password*|totp*|only|lost`, `factorSettings.codes|codes.one|other|none|make`);
  19. Settings with the app and passkeys (`factorSettings.passkeys*`);
  20. step-up: password, passkey, failed, expired, too many (`factorSettings.stepUp.*`, `factor.error.tooMany`);
  21. remove and make-codes confirms and their results (`factorSettings.removeTitle.*|removeBody|removeConfirm|removeBusy|cancel|removed.*|codesMade|codes.makeTitle|makeBody|makeConfirm`, `factorSettings.error.only|changed|other`);
  22. `roles.assign.error.twoFactor` from `E_TARGET_NO_FACTOR` (a cross-reference row; the key lives in flow 09).

  Every key appears in at least one row; `factor.error.network|other` go in the rows they can occur in.
- [ ] **Step 5.** Fill the remaining sections:
  - **`## 1280×800`:** the factor steps sit in `OnboardingFrame`, the QR 192 px beside the setup key. Settings → Sign-in is a `SettingsFrame` section with grouped `FactorRow`s.
  - **`## 360×740`:** the QR is above the key at 160 px; the codes are in one column; dialogs are full width.
  - **`## Keyboard map`:**
    - ChoiceCards: the arrows move and select, wrapping; Tab leaves.
    - Enter submits each step's form.
    - Copy and Print are buttons.
    - The codes checkbox toggles with Space.
    - Step-up: Enter confirms; Escape cancels and closes only the step-up dialog.
  - **`## Focus rules`:**
    - Each step focuses its heading. A field error focuses the field.
    - After a cancelled or refused ceremony, focus goes to the button that started it.
    - Dialogs open on their first field, else Cancel, never the destructive button, and close to the row button that opened them.
    - After a removal, focus goes to that group's add button.
  - **`## Announcements`** (polite, through the screen's `useAnnouncer`): `factor.added`, `factor.totp.keyCopied`, `factor.codes.copied`, `factorSettings.removed.*` and `factorSettings.codesMade`. Errors are `role=alert`.
- [ ] **Step 6.** Flow 01 (`01-onboarding.md`): the Copy row for `onboarding.step` becomes `Step {n} of 6` / "step line, steps 1–6"; the prose "Five steps" (:57) becomes "Six steps"; the step table gains row 5 "second factor → flow 10", and done becomes step 6.
- [ ] **Step 7.** Flow 03 (`03-sign-in.md`): step 3's notes name its four forms (an authenticator code, a passkey, a backup code, or the set-up for an account that has no factor yet), pointing to flow 10. No 03 Copy row changes.
- [ ] **Step 8.** In strings.flow10.test.ts:
  - remove the `it.skip` from the sections test;
  - add `expect(pairs.length).toBe(127)`;
  - fill `LOWER` with exactly these 10 keys: `factor.choose.app`, `factor.choose.passkey`, `factorSettings.nav`, `factorSettings.totp.add`, `factorSettings.totp.remove`, `factorSettings.totp.removeLabel`, `factorSettings.passkeys.add`, `factorSettings.passkeys.remove`, `factorSettings.passkeys.removeLabel`, `factorSettings.codes.make`.

  Report the number you pinned. The reviewer recounts the pairs in the doc independently.
- [ ] **Step 9.** Red first: run `npx vitest run --root packages/web src/strings` with the keys added but before 10's Copy section is written. Record the failure, then write the section and get it green. `strings.test.ts` must still pass unchanged.
- [ ] **Step 10.** Gates: G-web. **Commit:** `docs(flows): flow 10 second factor copy`.

---

## Phase 1: parallel lanes. Each lane is sequential inside, in its own `git clone --shared`.

Lanes: **SRV** (S1 → S2 → S3) ‖ **TK** (X2, after S2 is integrated) ‖ **CORE** (C1 → C2 → C3) ‖ **UI** (U1 → U2 → U3 → U4).

`testkit/src/ds/state.rs` is touched by S1 (WIRE_CODES), S2 (one more code) and X2. SRV is integrated first; TK rebases onto it.

Between S1's integration and X2's (and E0's), the scenario harness and the e2e specs fail on the wave branch: every new account is owed. That is expected. No lane "fixes" it with a seam.

### Task S1: The owed flag, enforcement and error codes

**Model:** opus. **Lane:** SRV. **Depends on:** Phase 0.

**Files:**
- `internal/store/{sqlite,postgres}/migrations/00017_second_factor.sql`, `internal/store/{sqlite,postgres}/schema/015_second_factor.sql`
- `internal/store/{sqlite,postgres}/queries/{sessions,accounts,auth}.sql` and the regenerated sqlc
- `internal/store/rows.go`, `store.go`, both `repo.go`, `contract_test.go`, `schema_test.go` (if needed), `dump.go`/`dump_test.go`
- `internal/auth/session.go`, `internal/gateway/session.go` (:191)
- `internal/api/accounts.go` (:178), `internal/api/api.go`, `internal/api/roles.go` (:119-135)
- `internal/dillad/dilladtest/seed.go` (`seedOne`, :567-614)
- the dillad boot path (where the repo and config meet before serving; name the file in the report)
- `internal/server/errors.go`, `testkit/src/ds/state.rs`
- `protocol/02-delivery-service.md` (§ Device sessions, § Errors), `protocol/09-http-api.md` (§ Sessions, the `require_mod_2fa` sentence)

- [ ] **Schema:**
  - `ALTER TABLE users ADD COLUMN factor_owed INTEGER NOT NULL DEFAULT 0 CHECK (factor_owed IN (0, 1));` (Postgres: `SMALLINT`). `users` is STRICT; an `ADD COLUMN` with a constant default and a CHECK is allowed on it.
  - Backfill, in the migration only:
    ```sql
    -- Backfill (data, not schema)
    UPDATE users SET factor_owed = 1
     WHERE kind = 0 AND deleted_at IS NULL
       AND id NOT IN (SELECT user_id FROM totp_secrets WHERE confirmed_at IS NOT NULL)
       AND id NOT IN (SELECT user_id FROM webauthn_credentials);
    ```
    The UPDATE goes after the verbatim schema body under that marker. If schema_test's verbatim check covers the whole Up section, narrow it to stop at the marker and say so. If sqlc accepts the UPDATE inside the schema file, keep it there instead.
- [ ] **Store:**
  - `UserRow.FactorOwed bool`; `CreateUser` writes it.
  - `SessionRow.FactorOwed bool` from `GetSessionByHash`: `SELECT s.*, u.factor_owed FROM sessions s JOIN users u ON u.id = s.user_id WHERE …` (one PK join; keep the existing expiry predicates).
  - Accounts: `SetFactorOwed(ctx, uid, owed bool) error`, and `MarkFactorOwedWithoutFactor(ctx, rpID string) (int64, error)`: sets `factor_owed = 1` on every live human account with no confirmed TOTP and no `webauthn_credentials` row **for `rpID`**. It only ever sets 1, never clears.
  - Auth: `DeleteTOTP(ctx, uid)`, `DeleteWebauthnCredential(ctx, uid, credID) (int64, error)` (deletes only the caller's own row), `DeleteWebauthnCredentialsByUser(ctx, uid)`, and expose the existing `DeleteRecoveryCodes(ctx, uid)`.
  - Update contract_test's lists. Run `sqlc generate`; never hand-edit generated files.
- [ ] **Callers:**
  - `CreateAccount` (accounts.go:178) sets `FactorOwed: kind == 0`.
  - `seedOne` sets `FactorOwed` the same way, so a seeded human is what a real sign-up makes (fixture reachability). If seed_test then fails on a route call, the test enrols a factor for real or calls `SetFactorOwed(false)` from the test file; the control route gets no option for it.
  - **Boot reconcile:** dillad calls `MarkFactorOwedWithoutFactor(ctx, cfg.Auth.WebAuthn.RPID)` once at start, after migrations and before serving, and logs the count at info when it is non-zero. It covers an `rp_id` change (passkeys under the old rp_id no longer count, see S2's `holdsFactor`), an archive restored from before 00017, and drift (risk R8).
- [ ] **Middleware** (`internal/auth/session.go`):
  - `Session.FactorOwed bool`, read by `Resolve` from the joined query.
  - In `Middleware`, after the two scope checks:
    ```go
    if sess.Scope == ScopeEnrolled && sess.FactorOwed && want != ScopePending && !owedOK {
        server.WriteError(w, server.Errorf(server.CodeFactorRequired, "the account owes a second factor"))
        return
    }
    ```
    The design wrote `want == ScopeEnrolled`. That would let an owed enrolled session through every `want = ScopeProvisional` route ("E or V": `POST /v1/keypackages`, `GET /v1/welcomes`, `DELETE /v1/welcomes/{id}`, keypackages.go:35), which the design's own test list refuses. `want != ScopePending` keeps the `P` routes open and closes the `V` ones.
  - `MiddlewareOwedOK(next, want)` is `Middleware` with `owedOK = true`.
  - Gateway (`gateway/session.go:191`): `if session.Scope != auth.ScopeEnrolled || session.FactorOwed` → close 4003.
- [ ] **Routes** (`api.go`): add `func (d Deps) owedOK(h http.HandlerFunc) http.Handler { return d.Sessions.MiddlewareOwedOK(h, auth.ScopeEnrolled) }` and mount through it: `GET /v1/accounts/me`, `POST /v1/auth/totp/enroll`, `POST /v1/auth/totp/confirm`, `POST /v1/auth/passkey/register/begin`, `POST /v1/auth/passkey/register/finish`, `DELETE /v1/devices/{device_id}/sessions` (keeping its `dsMeter`). The `P` routes (`PUT`/`GET /v1/users/{user_id}/device-list`, including `?after=N`, `GET /v1/backups`, `GET /v1/backups/{kind}/{chunk_seq}`) stay as they are and pass by the `want != ScopePending` rule. S2 adds `GET /v1/auth/factors` through `owedOK`.
- [ ] **Errors:** `CodeFactorRequired = "E_FACTOR_REQUIRED"`, `CodeTargetNoFactor = "E_TARGET_NO_FACTOR"`, `CodeStepUp = "E_STEP_UP"`, all `403` in `Status()`; the three 02 § Errors rows; the three `WIRE_CODES` entries, sorted.
  - `E_FACTOR_REQUIRED`: "the session's account owes a second factor". Action: add one (09 § Second factors).
  - `E_TARGET_NO_FACTOR`: "the user the request names holds no second factor and the community requires one". Action: none; tell the actor.
  - `E_STEP_UP`: "the step-up token is missing, spent, expired, another session's, or its secret was wrong". Action: confirm again.
- [ ] **`require_mod_2fa`** (roles.go:135, and the in-tx re-check near :828): refuse with `CodeTargetNoFactor` instead of `CodeForbidden`. Update communities_test.go:144-200 and roles_test.go:918 to assert the **code**, not the detail ("second factor").
- [ ] **protocol/09 § Sessions:** add the letter `F` to the scope table: "`F` | an `enrolled` session whose account owes a second factor is also accepted". Every `E` route not marked `E, F` answers such a session `403 E_FACTOR_REQUIRED`. Mark `GET /v1/accounts/me` and `DELETE /v1/devices/{device_id}/sessions` as `E, F` (S2 marks the auth rows). The `require_mod_2fa` sentence names `403 E_TARGET_NO_FACTOR`.
- [ ] **protocol/02 § Device sessions:** a new item: "An `enrolled` session whose account owes a second factor (`09` § Second factors) reaches only `09`'s `F` and `P` routes; every other route answers `403 E_FACTOR_REQUIRED`, and the gateway refuses it as it refuses a `pending` session (close 4003)."
- [ ] **Tests, red first:**
  - migration up/down/up on both engines;
  - backfill: a password-only user → 1; a TOTP-confirmed one → 0; an unconfirmed-TOTP one → 1; a passkey user → 0; a bot → 0; a deleted one → 0;
  - reconcile: a user whose only passkey is under `rp_id` `old.example` and owed 0 → 1 after `MarkFactorOwedWithoutFactor("dilla.example")`; a TOTP-confirmed user stays 0; an owed user stays 1 (it never clears);
  - **the route sweep** (dillad level, the real composition root so every handler group is mounted): register an account through `POST /v1/accounts`, then:
    - for every row of protocol/09's and protocol/02's endpoint tables whose Auth is `E`, `E or V` or `A` and not `F`, substitute well-formed ids and send it with the owed bearer and an empty body → `403 E_FACTOR_REQUIRED` (the middleware answers before any decode). The table is parsed from the docs, so a new `E` route is swept without a test edit. Assert at least these appear: `POST /v1/gateway/ticket`, `POST /v1/communities`, `POST /v1/keypackages`, `GET /v1/welcomes`, `PUT /v1/backups/0/0`, `POST /v1/groups`, `GET /v1/devices`, `DELETE /v1/accounts/me`;
    - every `F` and `P` row → not `E_FACTOR_REQUIRED` (`GET /v1/accounts/me` 200, the own device-list `PUT`/`GET` 2xx, `GET /v1/backups` 2xx);
    - **control:** after `SetFactorOwed(uid, false)`, the same sweep answers no `E_FACTOR_REQUIRED` anywhere;
  - the gateway: an owed bearer is closed 4003; the control (owed cleared) identifies;
  - an api-package test helper `satisfyFactor(t, repo, uid)` (a `_test.go` file) for Go tests that register through the real route. Other test packages that need it get their own test-file helper. **No production seam.**
  - `require_mod_2fa` tests expect `E_TARGET_NO_FACTOR`.
- [ ] **Mutation** (it tightens, so the classifier allows it): drop `&& !owedOK` → the sweep's `F` rows fail. Revert.
- [ ] **Gates:** G-go, G-sqlc, G-docs, `cargo test -p dilla-testkit --locked` (state.rs). **Commit:** `feat(auth): every account owes a second factor until it has one`.

### Task S2: Login rules, factor routes, step-up

**Model:** opus. **Lane:** SRV. **Depends on:** S1.

**Files:** `internal/api/auth.go`, `internal/auth/passkey.go`, `internal/config/defaults.go` (:75), `internal/config/validate.go` (:316-324), `internal/api/api.go` (routes), `internal/api/roles.go` (`requireSecondFactor` → `holdsFactor`), `internal/server/errors.go`, `testkit/src/ds/state.rs`, `internal/api/auth_test.go`, `passkey_login_test.go`, `passkey_test.go`, `virtualauthenticator_test.go`, `protocol/09-http-api.md` (§ Auth ceremonies and a new `### Second factors`), `protocol/02-delivery-service.md` (§ Errors).

- [ ] **"Holds a factor":** one function `holdsFactor(ctx, repo, uid, rpID) (bool, error)`: a confirmed TOTP secret, or at least one `webauthn_credentials` row for this instance's `rp_id`. It replaces `secondFactorPending` (auth.go:277) and `requireSecondFactor`'s checks (roles.go:119).
- [ ] **`needs`:** `loginNeeds(ctx, uid) (uint8, error)`: TOTP confirmed → 1; else any passkey for `rp_id` → 2; else 0.
  - `Assertions` carries `needs uint8` instead of `needsSecondFactor bool` (`Issue(userID, needs)`, `Spend` returns it).
  - `PasswordLogin` answers `[assertion, needs]`.
  - `verifySecondFactor`: the TOTP path accepts only `needs == 1` and a confirmed secret; the recovery path accepts `needs` 1 **or** 2; a `needs 0` assertion is refused by both (`401`, as today).
  - `CallbackOIDC` (:1043) issues with `loginNeeds`.
- [ ] **Passkey login:**
  - `auth.Passkeys.FinishLogin` returns `(userID id.ID, uv bool, err error)`. `uv` is the **this assertion's** authenticator-data UV flag. Read go-webauthn v0.18.2's `ValidateDiscoverableLogin` and confirm the returned credential's `Flags.UserVerified` is set from the assertion, not copied from the stored credential (`flagsFromByte`); if it is not, read the flag from the parsed assertion. Say which in the report.
  - `FinishPasskeyLogin` answers `[assertion, needs]` with `needs = uv ? 0 : 1`.
  - Under `user_verification = "required"` the library refuses a non-UV assertion outright, so `needs 1` occurs only on an instance that set `preferred` or `discouraged`. Both paths are tested.
  - **Unknown passkey:** when the credential id or user handle is not registered for this `rp_id`, `Passkeys.FinishLogin` returns a sentinel `auth.ErrPasskeyUnknown`, and the route answers `401 E_PASSKEY_UNKNOWN` (detail empty), still charging the ledger as today. Every other failure stays `401 E_UNAUTHENTICATED`. This is the fourth code: the copy distinguishes `factorSignin.passkey.unknown` from `.failed`, and the client may not read details. Add it in errors.go (`401`), the 02 § Errors row ("the passkey is not registered on this instance"; action: use another sign-in), and WIRE_CODES.
- [ ] **Registration:**
  - `Passkeys.BeginRegistration` passes `webauthn.WithExclusions` built from the user's credentials (a re-registration gives the browser's `InvalidStateError`).
  - `register/finish` takes `[ceremony_id, response, name]`; `name` is 1–64 bytes of UTF-8 without control characters, else `400 E_INVALID_REQUEST`; it is stored in the existing `name` column.
- [ ] **Confirm and finish, one transaction each,** under `LockUserForDeviceRegistration(uid)`:
  1. **Re-check the step-up rule under the lock:** if the account now holds a factor and this enrolment's begin carried no valid step-up → `403 E_STEP_UP`, nothing written. The begin records `{uid, kind, steppedUp bool}` in an in-memory map with the ceremony's lifetime (TOTP: keyed by user, replaced on each enroll; passkey: keyed by ceremony id). A missing entry (a restart) counts as not stepped up.
  2. Write the factor (confirm the TOTP row / insert the credential).
  3. `SetFactorOwed(uid, false)`.
  4. If `CountRecoveryCodes == 0`: mint 10 codes (`PutRecoveryCodes`) and return them; otherwise return `[]`. This replaces "regenerate on every TOTP confirm" (auth.go:540), which silently invalidated printed codes.
- [ ] **Step-up:**
  - `StepUps` in `auth.go`, modelled on `Assertions`: token → `{user, session token hash, expires}`; `Issue(uid, sessHash) (token string, expires int64)`; `Spend(token, sessHash) (uid, ok)` with a constant-time compare, single use, 300 s.
  - `POST /v1/auth/stepup` `[method, secret]` (E): method 0 password, 1 TOTP (consumes the counter like `verifySecondFactor`), 2 backup code (spends it). Success → `201 [stepup, expires]`. A wrong secret → `403 E_STEP_UP`. Failures go through `d.failure` on the ledger `loginLedger(store.UserRow{}, false, "\x00stepup"+uid.String())`, so a thief failing step-ups never charges the account's password ledger; past the free attempts → `429 E_RATE_LIMITED` with `retry_after_ms`.
  - **Passkey step-up** (for accounts without a password): `POST /v1/auth/stepup/passkey/begin` `[]` → `[ceremony_id, options]`, this user's credentials only, UV required; `…/finish` `[ceremony_id, response]` → `201 [stepup, expires]`.
    - `webauthn_ceremonies.kind` is `CHECK (kind IN (0, 1))`, so no new kind: a step-up ceremony is **kind 1 with `user_id` set**. `FinishPasskeyLogin` refuses a kind-1 ceremony whose `user_id` is set, and the step-up finish refuses one whose `user_id` is not the caller. Test both ways.
  - The routes that **spend** a token: `totp/enroll` and `passkey/register/begin` (when the account holds a factor; the token is ignored when it holds none), `factors/remove`, `recovery/codes`. Only these.
- [ ] **Factor routes:**
  - `GET /v1/auth/factors` (E, F, through `owedOK`) → `[owed(uint), totp(uint|null) — confirmed_at, passkeys([[cred_id(bstr), name(tstr), created(uint), last_used(uint|null)]]) — by created, backup_codes_left(uint), password(uint)]`.
  - `POST /v1/auth/factors/remove` `[stepup, kind(0 totp|1 passkey), cred_id(bstr|null)]` (E): spend the token (`403 E_STEP_UP`), then in one Tx under `LockUserForDeviceRegistration(uid)`: delete (`DeleteTOTP` or `DeleteWebauthnCredential`; 0 rows for a passkey → `404 E_NOT_FOUND`), recount `holdsFactor`, and on zero roll back with `409 E_INVALID_REQUEST`. Backup codes stay.
  - `POST /v1/auth/recovery/codes` `[stepup]` (E): under the user lock, `PutRecoveryCodes` with 10 fresh codes → `[backup_codes]`.
  - `totp/enroll` takes `[stepup(tstr|null)]`; `passkey/register/begin` takes `[stepup(tstr|null)]`.
- [ ] **Config:** `defaults.go:75` → `UserVerification: "required"` (D2). `validate.go`: `auth.methods` must hold `totp` or `passkey`, else "auth.methods must include totp or passkey: every account needs a second factor".
- [ ] **protocol/09:** the § Auth ceremonies rows change and a new `### Second factors` section follows it, with this table (house style) and the rules below it:

  | Method and path | Auth | Request | Response |
  |---|---|---|---|
  | `POST /v1/auth/password/login` | — | `[username, password]` | `[assertion(tstr), needs(uint)]`: `0` nothing owed; `1` a TOTP code or a backup code (`/totp/verify`, `/recovery/verify`); `2` the account has passkeys and no TOTP: a passkey login, or a backup code |
  | `POST /v1/auth/totp/enroll` | E, F | `[stepup(tstr\|null)]` | `[secret(tstr), otpauth_url(tstr)]`; `403 E_STEP_UP` when the account holds a factor and `stepup` is missing or not valid; `403 E_FORBIDDEN` over a confirmed secret (unchanged) |
  | `POST /v1/auth/totp/confirm` | E, F | `[code(tstr)]` | `[backup_codes([tstr])]`: 10 when the account held no unused code, else `[]`; clears `factor_owed` in the same transaction; `403 E_STEP_UP` when a factor appeared since an enroll that carried no step-up |
  | `POST /v1/auth/recovery/verify` | — | `[assertion, code]` | `[assertion]`; accepts an assertion owing `needs` 1 **or 2** |
  | `POST /v1/auth/passkey/register/begin` | E, F | `[stepup(tstr\|null)]` | `[ceremony_id(bstr16), options(tstr)]`; the user's credentials are excluded |
  | `POST /v1/auth/passkey/register/finish` | E, F | `[ceremony_id, response(tstr), name(tstr)]` | `[cred_id(bstr), backup_codes([tstr])]`; `name` is 1–64 bytes of UTF-8 without control characters (`400` otherwise); clears `factor_owed`; `403 E_STEP_UP` as for confirm |
  | `POST /v1/auth/passkey/login/finish` | — | `[ceremony_id, response]` | `[assertion(tstr), needs(uint 0\|1)]`: 0 when the authenticator verified the user, else 1; `401 E_PASSKEY_UNKNOWN` for a passkey this instance does not hold |
  | `GET /v1/auth/factors` | E, F | — | `[owed(uint), totp(uint\|null), passkeys([[cred_id(bstr), name(tstr), created(uint), last_used(uint\|null)]]), backup_codes_left(uint), password(uint)]` |
  | `POST /v1/auth/stepup` | E | `[method(uint 0 password\|1 totp\|2 backup code), secret(tstr)]` | `201 [stepup(tstr), expires(uint)]`; a wrong secret is `403 E_STEP_UP`; `429 E_RATE_LIMITED` with `retry_after_ms` past the step-up ledger's free attempts |
  | `POST /v1/auth/stepup/passkey/begin` | E | `[]` | `[ceremony_id, options]` (this user's credentials only; UV required) |
  | `POST /v1/auth/stepup/passkey/finish` | E | `[ceremony_id, response]` | `201 [stepup, expires]` |
  | `POST /v1/auth/factors/remove` | E | `[stepup(tstr), kind(uint 0 totp\|1 passkey), cred_id(bstr\|null)]` | `204`; `409 E_INVALID_REQUEST` when it is the account's last factor; `404 E_NOT_FOUND` for a credential that isn't the caller's; `403 E_STEP_UP` |
  | `POST /v1/auth/recovery/codes` | E | `[stepup(tstr)]` | `[backup_codes([tstr])]`; every earlier code stops working |

  Rules (prose):
  - **"Holds a factor"** means a confirmed TOTP secret, or at least one passkey for this instance's `rp_id`. Backup codes are not a factor. 09's prose says recovery codes are shown to people as **backup codes**.
  - **Step-up:** required by enroll, register/begin, remove and codes exactly when the caller's account holds a factor; a token is single-use, bound to the session that minted it, and lives 300 s; only the routes above spend one.
  - **OIDC callback:** the assertion owes a factor whenever the account holds one.
  - **Passkeys count alone only with user verification** (`auth.webauthn.user_verification`, default `required`).
- [ ] **Tests, red first** (each refusal row with its control):

  | Case | Expected | Control |
  |---|---|---|
  | password login, owed account | `needs 0` | — |
  | password login, TOTP account | `needs 1` | — |
  | password login, passkey-only account | `needs 2` | — |
  | `needs 2` + `/totp/verify` | `401` | `needs 2` + a backup code → an assertion that establishes |
  | passkey login, UV | `needs 0` | — |
  | passkey login, UP only (virtual authenticator `userVerified:false`, config `preferred`) | `needs 1` | — |
  | passkey login, UP only, config `required` | refused | the UV control above |
  | passkey login, a credential deleted from the store | `401 E_PASSKEY_UNKNOWN` | the same credential before the delete → 200 |
  | a step-up ceremony (kind 1, user set) sent to `login/finish` | `401` | a login ceremony → 200 |
  | enroll with no step-up while a factor exists | `403 E_STEP_UP` | with a valid token → 200 |
  | the same token twice | second `403 E_STEP_UP` | — |
  | another session's token | `403 E_STEP_UP` | the minting session's token → 200 |
  | confirm, first factor | 10 codes, owed cleared | a second factor's confirm → `[]` |
  | **in-tx hook:** owed account enrolls without step-up; the `beforeTx` hook confirms a passkey for it before confirm's Tx | confirm `403 E_STEP_UP`, nothing written | no hook → 200 |
  | remove the only factor | `409` | remove one of two → 204, `GET factors` shows one |
  | **in-tx hook:** two factors; the hook runs a complete second remove (of the other factor) before the first remove's Tx | the first `409`, exactly one factor left | no hook → 204 |
  | regenerate | the old code fails at `/recovery/verify` | a new code passes |
  | 5 wrong step-up passwords | `429` | a password login of that account (from another client address) still succeeds; the account ledger is untouched |
  | step-up method 1, the same code twice | second `403` | a fresh counter → 201 |
  | register finish with name `''` or 65 bytes | `400` | 64 bytes → 200 |
  | config `auth.methods = ["password"]` | validation error | `["password","totp"]` passes |

  Run the hook tests on both engines where the suite has a Postgres DSN (the contract tests' switch).
- [ ] No mutation that disables a check (Global Constraints). The control rows are the proof.
- [ ] **Gates:** G-go, G-docs, `cargo test -p dilla-testkit --locked`. **Commit:** `feat(auth): second-factor logins, factor routes and step-up`.

### Task S3: Operator reset, test-host seams, doctor

**Model:** sonnet; **opus reviewer**. **Lane:** SRV. **Depends on:** S2.

**Files:**
- a new `internal/ops/factors.go` and its test
- `cmd/dillad/admin.go` (`nounUsage["user"]` :53, the verb switch ~:450) and its test
- `internal/dillad/dilladtest/seed.go` (`ControlHandler` :33), `host.go` (`HostOptions` :59, `hostConfig` :266)
- `cmd/dilla-testhost/main.go` (flags :43-54)
- `internal/ops/doctor.go` (a new leg), `cmd/dillad/doctor.go` (:189), `internal/dillad/diagnostics.go` (:51)
- `protocol/09-http-api.md` § Admin (:1140)

- [ ] **`ops.ResetFactors(ctx, repo, closer func(device id.ID), uid id.ID, now int64) error`:** in one Tx under `LockUserForDeviceRegistration(uid)`: `DeleteTOTP`, `DeleteRecoveryCodes`, `DeleteWebauthnCredentialsByUser`, `SetFactorOwed(uid, true)`, and the audit row `user.factors_reset`. After the commit, close every one of the user's devices' gateway connections through `closer`, **without** deleting sessions (D5): the next request or re-identify answers `E_FACTOR_REQUIRED` / 4003.
- [ ] **CLI:** `dillad admin user reset-factors --id=ID | --username=NAME --yes`, following `setUserDisabled` (:487) for the selector, the `--yes` guard and the socket close. Usage line: `reset-factors  --id=ID | --username=NAME --yes   removes every second factor; the person sets one up at their next sign-in`.
- [ ] **Control routes** (`seed.go`): `GET /debug/clock` → `{"now": <unix seconds>}` from the host's fake clock; `POST /debug/reset-factors {"username": "…"}` → 204, calling the same `ops.ResetFactors` with the host's gateway closer (as `/debug/kick` closes sockets, :52). Unknown username → 404.
- [ ] **WebAuthn origin for tests:** `HostOptions.WebAuthnOrigin string`. When set, `hostConfig` sets `Auth.WebAuthn.RPID` = its hostname and `RPOrigins = [origin]`. If the host checks request origins (`http.trusted_origins`, CORS or CSP), add the origin there too and say so. `cmd/dilla-testhost` gains `-webauthn-origin` (empty = unchanged).
- [ ] **Doctor:** a new `ops.WebAuthnLeg(cfg config.Config) Leg`, wired at both call sites:
  - fail when `rp_id` is an IP literal;
  - fail when an `rp_origins` host is neither `rp_id` nor ends in `.`+`rp_id`;
  - warn when `tls.mode = "behind_proxy"`: "set auth.webauthn.rp_origins to the public origin, with its port";
  - warn when `auth.methods` lacks `totp` ("passkeys are the only second factor; an instance whose passkeys stop working locks new browsers out").
- [ ] **protocol/09 § Admin:** one line: "`dillad admin user reset-factors` removes a person's second factors and backup codes and marks the account owing one (`§ Second factors`); sessions stay, and every device sets up a factor before it is used again."
- [ ] **Tests:**
  - the CLI on a TOTP + passkey user → no TOTP, credential or code rows; `factor_owed = 1`; the audit row; the sessions still there; the closer called once per device;
  - **in-tx hook:** a factor confirmed by the hook before the reset's Tx is deleted too (the reset wins); control: no hook;
  - the control routes (JSON in, 204; the clock answer moves after `POST /debug/clock`);
  - a passkey registered and used against `http://localhost:9999` via `HostOptions.WebAuthnOrigin` (virtual authenticator, as `virtualauthenticator_test.go`);
  - the doctor leg flags `rp_id 10.0.0.1` and an origin `https://other.example`, passes `https://chat.example:8443` for `rp_id chat.example`, and warns behind a proxy.
- [ ] **Gates:** G-go. **Commit:** `feat(ops): operators reset a person's second factor`.

### Task X2: Testkit native peers enrol TOTP

**Model:** sonnet; **opus reviewer**. **Lane:** TK. **Depends on:** S2 integrated (it rebases onto SRV's `state.rs`).

**Files:** `testkit/src/ds/remote.rs` (`PasswordLogin` :144, `decode_password_login` :778, `redeem_invite` :1185, `password_login` :1395, the decode test :3555), `testkit/src/web_driver.rs` (:784, :1285, :1621), `testkit/Cargo.toml` (`hmac` and `sha1` as direct dependencies, at the versions already in Cargo.lock; stop with NEEDS_CONTEXT if either is absent from the lock), a new `testkit/src/totp.rs`.

- [ ] **`totp.rs`:** RFC 6238 over HMAC-SHA1, 6 digits, 30 s steps; `code(secret_b32, counter) -> String`; base32 decode of the otpauth secret.
- [ ] **Accounts:** after `POST /v1/accounts`, when `GET /v1/auth/factors` says owed: `totp/enroll [null]`, read the host time from `GET {DILLA_TESTKIT_CONTROL}/debug/clock`, `totp/confirm` with the code for `floor(now/30)`. Keep `secret` and `last_counter` per member.
  - A no-control environment fails with `scenario("the instance requires a second factor and DILLA_TESTKIT_CONTROL is unset")`.
- [ ] **Logins:** `PasswordLogin.needs: u8` replaces `needs_totp` (decode accepts 0, 1, 2; anything else is a protocol error). When `needs == 1`, web_driver uses counter `max(c-1, last+1)` where `c = floor(now/30)`; when that counter is past `c+1`, it advances the host clock (`POST /debug/clock {seconds: 30}`, repeated) until it is not. `needs == 2` in a native scenario is a `scenario(...)` error (native peers have no passkeys).
- [ ] **Tests:**
  - the RFC 6238 vector: SHA1 secret `12345678901234567890`, T = 59 → `287082` (6 digits);
  - the counter rule: `last` far behind (`c-5`) → `c-1` with no advance; `last = c` → `c+1` with no advance; `last = c+1` → one 30 s advance, then `c+2`;
  - `needs` 3 → decode error;
  - a scenario run against the test host where a peer signs in a second device.

  Mutation: use `max(c, last+1)` and show the `last = c-5` unit case fail; revert.
- [ ] **Gates:** G-rust-tk, then G-scenario. **Commit:** `test(testkit): native peers set up an authenticator app`.

### Task C1: client-core routes and fake server

**Model:** sonnet. **Lane:** CORE. **Depends on:** T0 (the server shapes are fixed by S2's table above).

**Files:** `packages/client-core/src/http/routes.ts` (a new banner `// ---- web3.6: second factors (flow 10) ----` after the wave 2a block), `routes.test.ts`, `testing/fake-server.ts`, `sync/testing/model.ts` (route names).

- [ ] Methods (bucket and idempotent as the neighbouring auth routes):
  - `passwordLogin` → `{ assertion, needs: 0 | 1 | 2 }` (drop `needsTotp`; update every call site);
  - `recoveryVerify(assertion, code)` → `{ assertion }`;
  - `getFactors()` → `{ owed: boolean; totp: number | null; passkeys: { credId: Uint8Array; name: string; created: number; lastUsed: number | null }[]; backupCodesLeft: number; hasPassword: boolean }`;
  - `totpEnroll(stepup: string | null)` → `{ secret, uri }`; `totpConfirm(code)` → `string[]`;
  - `passkeyRegisterBegin(stepup: string | null)` → `{ ceremonyId: Uint8Array; options: string }`; `passkeyRegisterFinish(ceremonyId, response, name)` → `{ credId, backupCodes }`;
  - `passkeyLoginBegin()` → `{ ceremonyId, options }`; `passkeyLoginFinish(ceremonyId, response)` → `{ assertion, needs: 0 | 1 }`;
  - `stepUp(method: 0 | 1 | 2, secret)`, `stepUpPasskeyBegin()`, `stepUpPasskeyFinish(ceremonyId, response)` → `{ token, expires }`;
  - `removeFactor(stepup, kind: 0 | 1, credId: Uint8Array | null)` → void;
  - `regenerateBackupCodes(stepup)` → `string[]`.

  Use `atLeast` on every answer so a later trailing element is ignored. Codes and names are bounded (`bounded(…, 16)` codes, 64-byte names, 1024 passkeys).
- [ ] **Tests:** a `CASES` row for each; decode rejects (`needs` 3 → `E_DECODE`; passkey finish `needs` 2 → `E_DECODE`); refusal rows for `E_FACTOR_REQUIRED`, `E_STEP_UP`, `E_TARGET_NO_FACTOR` and `E_PASSKEY_UNKNOWN`.
- [ ] **Gates:** G-core. **Commit:** `feat(client-core): routes for second factors`.

### Task C2: Worker phases and enforcement

**Model:** opus. **Lane:** CORE. **Depends on:** C1.

**Files:** `worker/controller.ts`, `worker/protocol.ts`, `state/types.ts`, `account/enrol.ts`, `account/signup.ts`, `http/client.ts` (`HttpDeps`), `worker/world.ts`, `test/fake-client`-equivalents that type `HttpDeps`, and tests.

- [ ] **Types:**
  - `BootPhase` gains `'signin-passkey' | 'factor-setup'`.
  - `AccountState` gains `factorSetup: { origin: 'signup' | 'signin' | 'required' } | null`, `instance.passkeys: boolean` (`authMethods` has 2), `instance.totp: boolean` (has 1), and `signIn.factor: 'totp' | 'passkey' | null` with `needsTotp` kept equal to `factor === 'totp'`.
  - The **`factors` slice** type lives here (C3 adds the commands): `{ owed: boolean; totp: { confirmedAt: number } | null; passkeys: { id: string /*hex*/; name: string; created: number; lastUsed: number | null }[]; backupCodesLeft: number; hasPassword: boolean }`.
- [ ] **Commands:**
  - `signInLogin` → `{ needs }`: 1 → `signin-totp` (`factor 'totp'`), 2 → `signin-passkey` (`factor 'passkey'`), 0 → `enrolWithKey`.
  - `signInPasskeyBegin {}` (in `signin-login`, `signin-totp`, `signin-passkey`) → `{ ceremonyId: string /*hex*/, options: string }`.
  - `signInPasskey { ceremonyId, response, recoveryKey }` → `needs 1` → `signin-totp` with `factor 'passkey'` kept for the copy (`needsCode`); `needs 0` → `enrolWithKey`.
  - `signInBackupCode { code, recoveryKey }` (in `signin-totp`, `signin-passkey`) → `enrolWithKey`; a refusal returns to `signin-login` with the error (the assertion is spent).
  - `factorSetupDone { invite: string | null }` (`factor-setup` → `ready`) → `{ communityId, joinError }`.
- [ ] **Enrol** (`account/enrol.ts`): rename `factorOwed` → `assertionOwes` (it is the assertion's debt, not the account flag); add `passkey(ceremonyId, response)` and `backupCode(code)`; `take()` accepts any owed assertion for a backup code.
- [ ] **enterReady** (controller.ts:1074):
  - after step (d) and **before** (e) `ensureBackups` (its backup `PUT` is not an `F` route): `getFactors()`, publish `factors`;
  - if owed: `setAccount({ phase: 'factor-setup', factorSetup: { origin } })` and return without starting the gateway;
  - `origin` comes from the caller: `signupSubmit` → `signup`, `enrolWithKey` → `signin`, boot → `required`.
- [ ] **signupSubmit:** when the phase becomes `factor-setup`, keep `pendingJoin = { communityId, invite }` and return `{ communityId: null, joinError: null, factorOwed: true }`.
- [ ] **factorSetupDone:** re-reads the factors; still owed → `Refusal('E_FACTOR_REQUIRED')` and the phase stays; else `enterReady()`, then joins `pendingJoin ?? (invite ? the redeem path : none)` as `signupSubmit` does, and clears `pendingJoin`.
- [ ] **Signup.submit and resume** (signup.ts:16, :26): stop after `publishDeviceList`. The KeyPackage refill (a `V` route, refused while owed) moves into `enterReady` after the owed gate. The gateway-ready refill (controller.ts:1293) stays.
- [ ] **The global hook:**
  - `HttpDeps` gains `onRefusal?(code: string): void`, called by `HttpClient.request` with the error's code just before it throws a non-network refusal;
  - the worker wires it: code `E_FACTOR_REQUIRED` while the phase is `ready` → `onFactorRequired()`;
  - `onFactorRequired()`: stop the gateway (no ticket retry loop), clear the per-ready memos (contract 6), set `factor-setup` with origin `required`; it fires once per transition (a latch cleared when the phase next becomes `ready`).
  - The reset path (S3) closes the socket; the client reconnects (4003 is not 4004), mints a ticket, and the `403 E_FACTOR_REQUIRED` on `postTicket` fires the hook. Test that chain.
- [ ] **ACCEPTS:** `'signin-passkey': ['signInPasskeyBegin', 'signInPasskey', 'signInBackupCode', 'signInCancel']`; `signin-login` and `signin-totp` gain `signInPasskeyBegin`; `signin-totp` gains `signInPasskey` and `signInBackupCode`; `'factor-setup': ['factorSetupDone', 'forgetBrowser']` (C3 adds its five).
- [ ] **Validators:** `signInBackupCode.code` normalised (drop `-` and spaces, upper-case) must match `^[A-Z2-7]{26}$` (`backup code is not 26 letters and digits`); `ceremonyId` 32 hex; `response` a non-empty string of at most 64 KiB.
- [ ] **Tests, red first:**
  - signup → `factor-setup` → `factorSetupDone` → `ready` and joined;
  - `factorSetupDone` while still owed → refused, phase unchanged;
  - a reload at `factor-setup` (boot with owed) → origin `required`;
  - a ready worker whose `postTicket` answers `403 E_FACTOR_REQUIRED` → `factor-setup`, the gateway stopped, no second `postTicket` within 10 fake seconds;
  - a socket closed with 4003 while owed → one reconnect, the ticket refusal, `factor-setup`;
  - needs 2 → `signin-passkey`; a passkey finish with needs 1 → `signin-totp` with `factor 'passkey'`;
  - a backup code after needs 2 → `ready`; a wrong backup code → `signin-login` with the error;
  - `Signup.submit` makes no keypackage call; the refill happens after `factorSetupDone`;
  - `enterReady` for an owed account makes no backup `PUT`;
  - ACCEPTS for `factor-setup` is exactly the list above.

  Mutation (a phase-routing change, not an auth check — the server refuses an owed account regardless): route needs 2 to `signin-totp` and show the needs-2 test fail; revert.
- [ ] **Gates:** G-core. **Commit:** `feat(client-core): a second factor before the shell`.

### Task C3: Factor management commands

**Model:** sonnet. **Lane:** CORE. **Depends on:** C2.

**Files:** `account/factors.ts` (`FACTOR_VALIDATORS` and a small `FactorsController`), `account/factors.test.ts`, controller.ts (COMMANDS, ID_FIELDS, ACCEPTS, `dispatch`), `worker/protocol.ts`, `sync/testing/model.ts`.

- [ ] **Commands:**
  ```ts
  | { m: 'refreshFactors' }
  | { m: 'factorTotpBegin'; stepup: string | null }                       // → { secret, uri }
  | { m: 'factorTotpConfirm'; code: string }                              // → { backupCodes }
  | { m: 'factorPasskeyBegin'; stepup: string | null }                    // → { ceremonyId, options }
  | { m: 'factorPasskeyFinish'; ceremonyId: string; response: string; name: string }   // → { backupCodes }
  | { m: 'stepUp'; method: 'password' | 'totp' | 'backup'; secret: string }            // → { token }
  | { m: 'stepUpPasskeyBegin' }                                           // → { ceremonyId, options }
  | { m: 'stepUpPasskeyFinish'; ceremonyId: string; response: string }   // → { token }
  | { m: 'removeFactor'; stepup: string; kind: 'totp' | 'passkey'; credId: string | null }  // → null
  | { m: 'regenerateBackupCodes'; stepup: string }                        // → { backupCodes }
  ```
  All are accepted in `ready`. `refreshFactors`, `factorTotpBegin`, `factorTotpConfirm`, `factorPasskeyBegin` and `factorPasskeyFinish` are also accepted in `factor-setup`.
- [ ] **Validators** (E_BAD_INPUT with these reasons): code `^\d{6}$` (`code is not six digits`); a backup-code secret normalised to `^[A-Z2-7]{26}$`; name 1–64 code points, no control characters (`name must be 1 to 64 characters`); `credId` 2..2046 hex; `stepup` non-empty; `method` and `kind` in their sets.
- [ ] **Behaviour:**
  - every state-changing handler re-reads and publishes `factors` **before** it resolves (contract 5);
  - a `403 E_STEP_UP`, a `404` or a `409` re-reads the factors, then rethrows;
  - the secret, URI, codes and tokens are never put in a slice, a log or the store.
- [ ] **Tests:** each command and its route call; the validators; publish-before-resolve ordering; the re-read after `E_STEP_UP` and `409`; ACCEPTS in `factor-setup`.
- [ ] **Gates:** G-core. **Commit:** `feat(client-core): manage second factors`.

### Task U1: QrCode

**Model:** sonnet. **Lane:** UI. **Depends on:** Phase 0.

**Files:** `packages/ui/src/QrCode/{QrCode.tsx, QrCode.css, QrCode.stories.tsx, QrCode.test.tsx, qrcodegen.ts}`, `src/index.ts`.

- [ ] **Vendor (D1):** Nayuki's MIT `qrcodegen.ts`, the TypeScript edition (`typescript-javascript/qrcodegen.ts` of github.com/nayuki/QR-Code-generator at tag `v1.8.0`).
  - Fetch it; never write it from memory. If the fetch fails, stop with NEEDS_CONTEXT.
  - Keep its licence notice. The only edits allowed: `export` the namespace, and a header comment naming the source URL, tag and SHA-256 of the fetched file. Record the SHA-256 in the report.
  - If typecheck, eslint or check:copy flags the vendored file, add the narrowest disable or ignore entry and name it in the report; do not rewrite upstream code.
- [ ] **`QrCode({ value, label, size? })`:** one `<svg role="img" aria-label={label}>` with one `<path>` or `<rect>`s for the dark modules; ECC M; a quiet zone of 4 modules; colours from tokens (dark on light, also in dark mode, for scanners).
- [ ] **Tests:** version 1 for `'HELLO'` is 21×21 modules; an otpauth URI of 120 bytes fits version ≤ 10; the `aria-label`; axe. Mutation: drop the quiet zone and show the size test fail. Stories at 192 and 160 px.
- [ ] **Gates:** G-ui. **Commit:** `feat(ui): QrCode`.

### Task U2: CodeList

**Model:** sonnet. **Lane:** UI. **Depends on:** U1.

**Files:** `packages/ui/src/CodeList/{…}`, `src/index.ts`.

- [ ] `CodeList({ codes, label, onCopy, onPrint, labels: { copy, print } })`: an `<ol aria-label={label}>` of monospace codes shown in 5-character groups, two columns at ≥ 480 px and one below; Copy and Print buttons; print follows RecoveryKey's print pattern (RecoveryKey.tsx:11-19).
- [ ] **Tests:** a real `<ol>` with one `<li>` per code; the grouping; the buttons call back; axe. Stories at 1280 and 360.
- [ ] **Gates:** G-ui. **Commit:** `feat(ui): CodeList`.

### Task U3: ChoiceCards

**Model:** sonnet. **Lane:** UI. **Depends on:** U2.

**Files:** `packages/ui/src/ChoiceCards/{…}`, `src/index.ts`.

- [ ] `ChoiceCards({ name, label, options: { id, title, hint, disabled?, reason? }[], value, onChange })`: a `role=radiogroup` of cards with native radios; roving tabindex; the arrows move and select, wrapping and skipping disabled cards; a disabled card stays visible, and its reason is wired through `aria-describedby`. Targets ≥ 24×24 px.
- [ ] **Tests:** the arrows (wrap, skip disabled, `onChange`); Tab leaves the group; the reason describes the disabled card; axe.
- [ ] **Gates:** G-ui. **Commit:** `feat(ui): ChoiceCards`.

### Task U4: FactorRow

**Model:** sonnet. **Lane:** UI. **Depends on:** U3.

**Files:** `packages/ui/src/FactorRow/{…}`, `src/index.ts`.

- [ ] `FactorRow({ title, detail, action?, actionLabel?, actionAriaLabel?, disabledReason? })`, following `DeviceRow`. A disabled action stays focusable with `aria-disabled="true"` and `aria-describedby` pointing at the visible `disabledReason`; activating it does nothing.
- [ ] **Tests:** the disabled action is focusable, does not call back and is described by its reason; axe. Stories: enabled, disabled, no action.
- [ ] **Gates:** G-ui. **Commit:** `feat(ui): FactorRow`.

---

## Phase 2: parallel lanes after Phase 1 is integrated

Lanes: **WEB-F** (W1 → W2) ‖ **WEB-S** (W3, after W1 is integrated: it reuses W1's steps).

Every web brief names the contracts in Global Constraints, including Escape and the queuing announcer.

### Task W1: `webauthn.ts` and the `FactorSetup` flow

**Model:** sonnet; **opus reviewer on webauthn.ts**. **Lane:** WEB-F. **Depends on:** C3, U1, U2, U3.

**Files:** new `packages/web/src/webauthn.ts` (+ test), new `packages/web/src/screens/factor/FactorSetup.tsx` (+ test).

- [ ] **`webauthn.ts`:**
  - `createPasskey(optionsJson: string): Promise<string>` and `getPasskey(optionsJson: string): Promise<string>`: convert go-webauthn's base64url JSON (`{publicKey:{…}}`) to and from `ArrayBuffer`s **by hand**, without `parseCreationOptionsFromJSON` or `toJSON()`. Serialise the response as `{id, rawId, type, response:{clientDataJSON, attestationObject | authenticatorData + signature + userHandle, transports}, clientExtensionResults:{}, authenticatorAttachment}`.
  - `passkeysUsable(instance): boolean` = `instance.passkeys && 'PublicKeyCredential' in window && isSecureContext`.
  - `PasskeyError` kinds: `cancelled` (NotAllowedError, AbortError), `wrongAddress` (SecurityError), `exists` (InvalidStateError), `other`.
  - Tests: a round trip of a captured go-webauthn options document and a virtual-authenticator-shaped response; each DOMException name → its kind.
- [ ] **`FactorSetup`** props `{ origin: 'signup' | 'signin' | 'required'; stepLabel: string; instanceName; username; announce; onDone(result: { kind: 'totp' | 'passkey' }) }`. States:
  1. **choose:** `ChoiceCards`. Passkey is disabled with `factor.choose.passkeyOff` when not usable. Without a password (`factors.hasPassword` false) only passkey is offered, with `factor.choose.noPassword`. Body `factor.choose.body`, or `factor.choose.required` for `required`. **No skip or cancel control in any origin.**
  2. **totp:** `factorTotpBegin { stepup: null }` (`factor.totp.loading` meanwhile) → `QrCode` (`factor.totp.qr`), the setup key as a read-only `TextField` (`factor.totp.key`) plus `factor.totp.copyKey` (announces `factor.totp.keyCopied`), the code field (`autocomplete="one-time-code"`, `inputMode="numeric"`) → `factorTotpConfirm`.
     - Client checks: empty → `factor.error.required`; not six digits → `factor.error.codeFormat`.
     - `400 E_INVALID_REQUEST` → `factor.error.code` on the field, clear it, focus it.
  3. **passkey:** a name field (default `factor.passkey.defaultName {n}`, n = passkeys + 1; > 64 characters → `factor.error.nameLong`) → `factorPasskeyBegin { stepup: null }` → `createPasskey` → `factorPasskeyFinish`.
     - `cancelled` → `factor.error.cancelled`; `wrongAddress` → `factor.error.wrongAddress`; `exists` → `factor.error.exists`; a refused begin or finish → `factor.error.refused`. Focus returns to `factor.passkey.submit`, and the app path stays available.
  4. **codes:** `CodeList` (`factor.codes.label`, copy announces `factor.codes.copied`) plus `factor.codes.notKey`, the acknowledge checkbox (`factor.codes.ack`, hint `factor.codes.ackHint`), Continue `aria-disabled` until ticked. An empty code list (the account already held codes) skips this state.
  5. **done** (`required` only): `factor.done.title`, `.totp|.passkey`, `.next`; announces `factor.added`.
  - Shared refusals: 429 → `factor.error.tooMany {seconds}`; status 0 → `factor.error.network`; otherwise `factor.error.other {code}`.
  - Back (`factor.back`) returns to choose. The secret, URI and codes live only in component state and are dropped on unmount.
- [ ] **Tests (Vitest, FakeClient, a mocked `navigator.credentials`):** each state; each refusal row; copy-key; focus after a cancelled ceremony; no `stepup` is sent from `factor-setup`; no skip control for each origin; the codes skip when `[]`; axe.
- [ ] **Gates:** G-web. **Commit:** `feat(web): second factor set-up`.

### Task W2: Onboarding, SignIn and App

**Model:** sonnet. **Lane:** WEB-F. **Depends on:** W1.

**Files:** `packages/web/src/screens/Onboarding.tsx`, `SignIn.tsx`, `App.tsx` (`screenFor` :21 and the screen switch ~:224), a new `screens/factor/ForcedFactor.tsx`, and their tests.

- [ ] **Onboarding:** after `signupSubmit` resolves with `factorOwed` (or the phase is `factor-setup` with origin `signup`), render `FactorSetup origin="signup" stepLabel={t('onboarding.step', { n: 5 })}`; its `onDone` sends `factorSetupDone { invite }`, then shows done with `onboarding.step` n 6. Onboarding gains a `useAnnouncer` and its live region (it has none).
- [ ] **SignIn:**
  - step 2 (login) gains the ghost button `factorSignin.usePasskey` (when `passkeysUsable`) → `signInPasskeyBegin` → `getPasskey` → `signInPasskey`;
  - step 3 for `signin-totp` adds the link-button `factorSignin.useBackup` and the line `factorSignin.lost`; with `signIn.factor === 'passkey'` it shows `factorSignin.passkey.needsCode` above the code field;
  - `signin-passkey` shows `factorSignin.passkey.title|body|submit|working` plus `useBackup`;
  - a backup-code sub-state (`factorSignin.backup.title|body|label`, the format check `factorSignin.backup.format`);
  - `factor-setup` with origin `signin` renders `FactorSetup` with `signin.step` n 3;
  - done adds `factorSignin.left.one|other {count}` after a backup code (from the `factors` slice).
  - Refusals by status and code: `401 E_PASSKEY_UNKNOWN` → `factorSignin.passkey.unknown`; other passkey refusals and `cancelled` → `factorSignin.passkey.failed`; `401 E_UNAUTHENTICATED` after a backup code → `factorSignin.backup.failed`, the password cleared and the recovery key kept.
  - Announcements go through SignIn's existing live region, made a `useAnnouncer` if it is not one.
- [ ] **App.screenFor** takes the account (or its `factorSetup.origin`): `signin-passkey` → `signin`; `factor-setup` → by origin: `signup` → `onboarding`, `signin` → `signin`, `required` → a new `'factor'` screen, `ForcedFactor`, which renders `FactorSetup` with `factor.step` in `OnboardingFrame`, then `factorSetupDone { invite: null }` and the shell. Its own `useAnnouncer`.
- [ ] **Tests:** the step labels (5 of 6, 3 of 4); passkey sign-in; the backup path; the refusal rows; the forced screen has no cancel or skip control and no route away except `forgetBrowser`'s existing control; `screenFor` for each origin; axe.
- [ ] **Gates:** G-web. **Commit:** `feat(web): second factor at sign-up, sign-in and when it is missing`.

### Task W3: Settings → Sign-in, the step-up dialog, the twoFactor mapping

**Model:** sonnet. **Lane:** WEB-S. **Depends on:** W1 integrated, U4.

**Files:** `Settings.tsx` (`NAV` :31), `router.ts` (`SettingsSection` and `SETTINGS_SECTION` :19), new `screens/settings/SignInFactors.tsx`, new `screens/settings/StepUpDialog.tsx`, `screens/admin/MemberRolesFlow.tsx` (:69-75), and their tests.

- [ ] **Navigation:** `NAV` gains `{ id: 'signin', key: 'factorSettings.nav' }` on its own line after devices; `SettingsSection` gains `| 'signin'` on its own line after `'devices'`; the `SETTINGS_SECTION` regex gains `signin`.
- [ ] **Announcer:** Settings has none. Add one `useAnnouncer()` in Settings.tsx with its live region **inside** the SettingsFrame dialog (a region outside a modal is hidden from assistive tech), and pass `announce` to `SignInFactors`.
- [ ] **`SignInFactors({ announce })`:**
  - `refreshFactors` on mount; `factorSettings.loading`; on failure `factorSettings.error.load {code}` with `factorSettings.retry`.
  - Heading `factorSettings.title`, body `factorSettings.body {instance}`.
  - `FactorRow`s: password (`factorSettings.password`, `.set|.none`); the app (`factorSettings.totp`, `.on {date}` / `.off`, add `factorSettings.totp.add`, remove `factorSettings.totp.remove` with `removeLabel`); each passkey (`factorSettings.passkeys.used|unused`, remove with `removeLabel {name}`) plus `factorSettings.passkeys.add` (or `.none`); backup codes (`factorSettings.codes.one|other|none`, `factorSettings.codes.make`).
  - A remove control on the account's last factor is disabled with `factorSettings.only` (U4).
  - `factorSettings.lost {instance}` at the bottom.
  - Dates format with the existing date helper the Devices section uses.
- [ ] **`StepUpDialog`** (contracts 1–3):
  - a password field (`factorSettings.stepUp.title|body|password|confirm|working`), or, when `hasPassword` is false, `factorSettings.stepUp.passkeyBody` and the button `factorSettings.stepUp.usePasskey` (`stepUpPasskeyBegin` → `getPasskey` → `stepUpPasskeyFinish`);
  - resolves a token to its caller; the password is cleared from state once sent;
  - `403 E_STEP_UP` → `factorSettings.stepUp.failed`; 429 → `factor.error.tooMany {seconds}`; error and busy in one update.
- [ ] **Actions after a token:**
  - add the app or a passkey: a `Dialog` hosting W1's totp or passkey step and its codes step, with the token as `stepup`;
  - remove: a ConfirmDialog (`factorSettings.removeTitle.totp|passkey {name}`, `removeBody`, `removeConfirm`, `removeBusy`, `cancel`) → `removeFactor`; announces `factorSettings.removed.totp|passkey {name}`; focus goes to that group's add button;
  - make codes: a ConfirmDialog (`factorSettings.codes.makeTitle|makeBody|makeConfirm`) → `regenerateBackupCodes` → the CodeList; announces `factorSettings.codesMade`; focus returns to the make button.
  - Refusals by status and code: `409` → `factorSettings.error.only`; `403 E_STEP_UP` from the action (the token expired or was spent) → `factorSettings.stepUp.expired` and the StepUpDialog again; `404` or `403 E_FORBIDDEN` (the factor changed elsewhere) → `factorSettings.error.changed` and a refresh; otherwise `factorSettings.error.other {code}`.
- [ ] **`MemberRolesFlow`:** `err.code === 'E_TARGET_NO_FACTOR'` → `roles.assign.error.twoFactor {name}`, checked before `forbidden(err)`.
- [ ] **Tests:** each row state; the disabled last remove; the step-up failures; the expired path asks again; Escape in the StepUpDialog leaves Settings open; the twoFactor mapping by code (a 403 `E_FORBIDDEN` with the detail "second factor" maps to `forbidden`, proving no detail read); axe. Focus return is proven in E1/E2.
- [ ] **Gates:** G-web. **Commit:** `feat(web): sign-in settings and second factor management`.

---

## Phase 3: sequential

### Task E0: e2e support

**Model:** sonnet. **Lane:** e2e. **Depends on:** W2, W3.

**Files:** new `e2e/web/support/totp.ts`, new `e2e/web/support/webauthn.ts`, `e2e/web/support/app.ts`, `e2e/web/support/host.ts`, `e2e/web/support.spec.ts`, the specs with their own host (pass `h.control`), `e2e/web/core-worker.spec.ts`, `e2e/web/spike-joinall.spec.ts`, `e2e/voice/support/voice.ts` (if it needs the control).

- [ ] **`totp.ts`:** `totp(secretB32, unix, digits = 6)` (node:crypto HMAC-SHA1, RFC 6238) with the RFC-vector case in `support.spec.ts`; `hostNow(control)` (`GET /debug/clock`); `advanceClock(control, seconds)`; `nextCode(control, account)`: counter `max(c-1, last+1)`, advancing the host clock 30 s at a time while it is past `c+1`; it records `lastCounter`.
- [ ] **`Account`** gains `control`, `totpSecret`, `backupCodes`, `lastCounter`.
- [ ] **`completeSignUp`:** after `submitButton` → `factor.choose.title` → `factor.choose.app` → Continue → read `factor.totp.key` → the code → `factor.codes.title` → read the codes → tick → Continue → `onboarding.done.title`.
- [ ] **`finishSignIn`:** if `signin.totp.title` shows → `nextCode`.
- [ ] **Worker-harness sign-ups** (core-worker.spec.ts, spike-joinall.spec.ts): a helper `completeFactor(page, control)` that sends `factorTotpBegin { stepup: null }`, computes the code, `factorTotpConfirm`, then `factorSetupDone { invite: null }`, called after each `signupSubmit` that answers `factorOwed`.
- [ ] **`support/webauthn.ts`:** `addAuthenticator(page)` (CDP `WebAuthn.enable`, `addVirtualAuthenticator` with `{protocol:'ctap2', transport:'internal', hasResidentKey:true, hasUserVerification:true, isUserVerified:true, automaticPresenceSimulation:true}`) and `copyCredentials(fromPage, toPage)` (`getCredentials` / `addCredential`).
- [ ] **`HostConfig.webauthnOrigin?`** → `hostArgs` adds `-webauthn-origin`.
- [ ] **Gates:** G-e2e-all green (every existing spec, every browser project). App bugs are reported as findings and never worked around. **Commit:** `test(e2e): sign-up and sign-in helpers set up a second factor`.

### Task E1: `e2e/web/second-factor.spec.ts`

**Model:** sonnet. **Lane:** e2e. **Depends on:** E0.

Its own host `{ port: 8495, control: 8496, webRoot: 'packages/web/dist' }` in the admin.spec.ts pattern; serial; chromium and firefox.

- [ ] Steps:
  1. Ada signs up. At step 5: axe on choose and on the TOTP step; a wrong code → `factor.error.code` with focus on the field; the right code → 10 codes and `factor.codes.notKey`; tick → done → shell.
  2. Settings → `factorSettings.nav`: the app is on, no passkeys, `factorSettings.codes.other {count:10}`; the app's remove is `aria-disabled` with `factorSettings.only`.
  3. A second browser: key → login → `signin.totp.title` → code → done → shell.
  4. A third: key → login → `factorSignin.useBackup` → a code → done shows `factorSignin.left.other {count:9}`.
  5. A wrong TOTP on a fourth → `signin.error.totpFailed`, back at login.
  6. Ada → `factorSettings.codes.make` → StepUpDialog (password) → `factorSettings.codes.makeConfirm` → new codes. **Focus returns to the make button.** Escape in the StepUpDialog (a second try) closes it and leaves Settings open.
- [ ] **Gates:** G-e2e(second-factor.spec.ts), chromium and firefox. **Commit:** `test(e2e): second factor from an empty instance`.

### Task E2: `e2e/web/passkey.spec.ts`

**Model:** sonnet. **Lane:** e2e. **Depends on:** E1.

Its own host `{ port: 8497, control: 8498, webRoot: 'packages/web/dist', webauthnOrigin: 'http://localhost:8497' }`, `baseURL http://localhost:8497`; chromium only (`test.skip(browserName !== 'chromium', 'CDP virtual authenticator')`).

- [ ] Steps:
  1. Björn signs up with a passkey named "Laptop" → codes → shell.
  2. A second context with copied credentials: key → `factorSignin.usePasskey` → done, with no password typed.
  3. Settings: add the authenticator app (step-up with the password), then remove "Laptop" (step-up) → `factorSettings.removed.passkey {name:'Laptop'}`; the app's remove is now disabled. **Focus returns to the add button after the add, and to the passkeys' add button after the remove.**
- [ ] **Gates:** G-e2e(passkey.spec.ts), chromium. **Commit:** `test(e2e): passkeys from an empty instance`.

### Task E3: `e2e/web/required-factor.spec.ts`

**Model:** sonnet. **Lane:** e2e. **Depends on:** E2.

Its own host `{ port: 8499, control: 8500, webRoot: 'packages/web/dist' }`; chromium and firefox.

- [ ] Steps:
  1. Cleo signs up with a community invite, then closes the page on `factor.choose.title`. She reopens → the forced screen (`factor.choose.required`, no skip control) → TOTP → `factor.done.title` → shell, and she is a member of the invite's server.
  2. Ada signs up and opens the shell. The control `POST /debug/reset-factors {username}` runs. Ada's page shows the forced screen within 30 s, with no reload. She sets the app up again → shell, and messages flow.
  3. A fresh browser for Ada after another reset: key → login (no code asked) → step 3 is the set-up → done.
  4. axe at 360×740 on the forced screen.
- [ ] **Gates:** G-e2e(required-factor.spec.ts), chromium and firefox. **Commit:** `test(e2e): a missing second factor is required before the app`.

### Task H1: User and operator docs, README

**Model:** sonnet (not haiku). **Lane:** worktree. **Depends on:** E3.

**Files:** `docs/user/getting-started.md`, `README.md`, the user-doc screenshots.

- [ ] getting-started: a section "Second factor" covering setting it up (the app or a passkey); backup codes versus the recovery key; signing in on a new browser; a lost phone (the three paths: a backup code, a browser still set up, the operator); Settings → Sign-in; "browsers already set up do not ask again". Use the en.ts strings verbatim for every control name. Add "check Settings → Sign-in after the upgrade" for existing accounts (risk R3).
- [ ] An operator section: `dillad admin user reset-factors` and when to use it (verify the person out of band; disable the account instead if it may be compromised); `auth.webauthn.rp_id` / `rp_origins` behind a proxy, with an example including a port; `dillad doctor`'s WebAuthn check; `auth.methods` must include totp or passkey.
- [ ] README: "what works" gains the required second factor as of web-3.6; the honest limits ("a browser already set up is not asked again"; "the factor guards signing in on a new browser, not message content").
- [ ] Re-shoot the screenshots of sign-up, sign-in and Settings, following the existing procedure.
- [ ] **Gates:** G-docs. **Commit:** `docs(user): second factor`.

## After the tasks (integrator: the controller)

**Hotspot owners:**

| File | Owner |
|---|---|
| api.go, auth.go, errors.go, session.go (auth), gateway/session.go, protocol/02, protocol/09, state.rs | SRV |
| testkit remote.rs, web_driver.rs, totp.rs | TK (rebases onto SRV's state.rs) |
| controller.ts, protocol.ts, types.ts, http/client.ts, enrol.ts, signup.ts | CORE |
| Onboarding.tsx, SignIn.tsx, App.tsx | WEB-F |
| Settings.tsx, router.ts, MemberRolesFlow.tsx | WEB-S (router.ts union one-per-line from T0) |
| e2e/web/support/* | E0 |
| strings feature files, flow 10, flows 01/03 | T1 only |
| protocol/07 | integrator |

**Integration order:** T0 → T1 → SRV (S1, S2, S3) → TK (X2) → CORE (C1, C2, C3) → UI (U1–U4) → WEB-F (W1, W2) → WEB-S (W3) → E0 → E1 → E2 → E3 → H1 → 07 rows.

Then:
- **protocol/07 rows:**
  - **Behaviour change:** the second factor is required; password `needs` 2; passkey `needs`; four new codes; `require_mod_2fa` answers `E_TARGET_NO_FACTOR`; UV `required` by default.
  - **Wire, additive for clients that read at least:** password login and passkey finish keep their first element, and passkey finish gains a second.
  - **Wire, change:** enroll, register begin and register finish take new bodies; confirm no longer replaces existing codes. No released client sends them.
  - Risk R6: check how a stale cached bundle is told to reload (version close 4006 / the manifest), and say it in the row.
- **Full wave gates:** `npm test`; ui storybook and axe; G-go with `-race`; G-sqlc; G-rust-tk; G-scenario; check:docs, check:copy and check:ci.
- **G-e2e-all** before the whole-branch review (W2a lesson: the full suite, not a list).
- **Whole-branch review on opus**, plus a product walk from an EMPTY instance, including:
  - an upgraded W2a database with a legacy password-only account (forced at next use, the existing browser continues without re-establishing);
  - a real phone authenticator app against a Homelab instance behind its proxy (the `rp_origins` check and the doctor leg);
  - a real platform passkey.
- PR, CI green, merge; tag `v0.1.0-web3.6` (prerelease); verify the assets; tell Homelab to deploy; Jonas checks.
- Then re-read the W2a appendix (W2b, now web3.7) against the merged code and write its plan.

**Risks carried (opus sign-off):**

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Lockout:** lost phone and no codes | Codes minted at the first factor; a browser still set up adds and removes factors with a password step-up; the operator reset; the "only factor" guard under the user lock |
| R2 | **Clock skew** | Skew ±1 step; the copy tells the person to fix the phone clock; doctor checks the server clock; e2e uses the host's fake clock, never the wall clock |
| R3 | **Legacy race:** an attacker who already has the password and the recovery key enrols first | No new exposure: those two were the whole login before. The owner's browsers show the unknown factor in Settings and can replace it with their password. H1 says "check Settings → Sign-in after the upgrade" |
| R4 | **A passkey on a shared computer** signs in on its own | UV required (D2); `factor.passkey.body` warns; Settings shows last use; removal is easy |
| R5 | **Proxy origin and rpId mismatch** breaks passkeys | The doctor leg; the client hides passkeys when unusable and maps SecurityError to copy; TOTP is always offered when the instance has it (validation requires totp or passkey; doctor warns when totp is absent) |
| R6 | **A stale cached bundle** gets `E_FACTOR_REQUIRED` on every call and shows the generic error | Accepted for one release; the 07 row names the reload mechanism |
| R7 | **Testkit churn:** every native peer now enrols, and multi-login scenarios advance the clock | X2's counter rule advances only past `c+1`; scenario timings re-run in TK's gate |
| R8 | **The owed flag drifts** from the factor tables | Written only inside the factor transactions and the reset; the boot reconcile re-marks any human account without a usable factor |

**Decisions settled by the controller (2026-10-15):** D1 vendor qrcodegen.ts; D2 UV `required`; D3 no off switch; D4 a set-up browser is not asked again; D5 the reset keeps sessions and forces set-up on every device; D6 W2b → web3.7.

**Plan-writer resolutions the controller may overturn** (each is built as written unless overturned):
- **P1.** A fourth error code, `401 E_PASSKEY_UNKNOWN` (S2), so the client can show `factorSignin.passkey.unknown` without reading a detail. The alternative: no new code, every passkey refusal shows `.failed`, and `factorSignin.passkey.unknown` is removed from T1 (126 keys).
- **P2.** The boot reconcile (`MarkFactorOwedWithoutFactor`, S1) closes the "not owed but no usable factor" state after an `rp_id` change or an archive restore. The alternative is the migration backfill alone.
- **P3.** The begin/confirm step-up window (S2) is closed with an in-memory "stepped up" record per enrolment; a restart in between makes the person confirm again.

**Controller ruling (2026-10-15): P1, P2 and P3 stand as written.** P1 names a credential, not a username, so it enumerates no accounts. P2 only ever sets the flag. P3 closes a step-up bypass.
