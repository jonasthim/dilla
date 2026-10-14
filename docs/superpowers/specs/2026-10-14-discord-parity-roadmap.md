# dilla → Discord parity: roadmap, wave plans and parallel execution

## Context
Jonas (2026-10-14): "Make an extensive plan to make this up to par with Discord. Do this plan and then utilize subagents that can work in parallel, and the instructions should be so clear we can use less costly agents."

**State at v0.1.0-web3.3 (verified on his instance):**
- create a server, text and voice channels, invite links;
- E2EE text with replies, reactions, edits, pins, attachments and local search;
- DMs;
- voice, camera and screen share, which work in Firefox, confirmed by Jonas.

The server already has much more than the client exposes (kick, ban, roles and others). The gap inventory (`2026-10-14-discord-parity-inventory.md`) lists what is missing.

**Outcome:** a sequence of waves. Each wave is its own superpowers:writing-plans document, executed with superpowers:subagent-driven-development. Most tasks are written as fill-in-the-recipe briefs that a cheaper model (sonnet) can execute. Disjoint tasks run in parallel lanes, and reviews stay on opus.

---

## Part A: execution model (applies to every wave)

### A1. Roles and models
| Role | Model | Why |
|---|---|---|
| Controller (this session) | opus | rulings, integration, merges |
| Wave plan writer | opus | design judgment; produces the briefs |
| Implementer, recipe task (a route, command or UI component with exact names) | **sonnet** | transcription plus tests against a complete brief |
| Implementer, judgment task (E2EE, MLS, authz, gateway ops, migrations' semantics, voice) | opus | security- and protocol-sensitive |
| Mechanical batch (strings, docs, story args) | **haiku** | complete text is given |
| Task reviewer | sonnet for recipe tasks, opus for judgment tasks | review scales with risk |
| Security review, whole-branch review and product walk | opus | non-negotiable |

This replaces the standing "all tasks on opus" rule for recipe and mechanical tasks. Save it to memory once approved.

### A2. Brief contract, so that cheaper agents succeed
Every task brief has:
1. The goal in one sentence.
2. **Exact files and anchors**: create/modify paths, plus the banner comment to append under.
3. **The recipe step list** from Part B, with the concrete names filled in: route path, CBOR array shape, command name, slice name, en.ts keys with exact text, and component props.
4. **Exact test cases**: inputs and expected outputs, including refusal codes.
5. **Exact gate commands.**
6. Commit message text.
7. Out of scope.
8. "Ask, don't guess" (NEEDS_CONTEXT).

No brief says "handle errors appropriately". Every refusal code and its copy key are listed.

### A3. Parallel lanes
- Each lane is a `git clone --shared` under `/home/thim/.cache/dilla-w3/lane-<id>`, with its own `CARGO_TARGET_DIR` and `GOCACHE` per lane, and its own e2e port pair from the registry.
- The controller cherry-picks lanes into the wave branch in a fixed order, and runs gates after each pick.
- **Reservations are made in the wave plan before dispatch:**
  - migration numbers (next free `00017` / schema `015`);
  - gateway ops (next free ephemeral op 55);
  - flow doc numbers (next 08);
  - e2e ports (taken: 8453/4, 8463/4, 8471/2, 8477/8, 8481/2; new ones from 8485 upward, in pairs);
  - permission bits.
- **Serialized files:** one owner per wave, or done by the controller at integration. These are Shell.tsx mounts, protocol/07 rows, `internal/dillad/routes.go`, `ci.yml`, and generated sqlc code (always regenerated after a rebase, never hand-merged).

### A4. Per-task gates (narrow) and per-wave gates (full)
- **Per task:** only that layer's tests, plus typecheck and lint for the touched package.
- **Per wave, at integration:**
  - `npm test`; ui storybook and axe;
  - Go `-race` on the touched packages; `sqlc diff`;
  - check:docs, check:copy and check:ci;
  - the e2e configs that the wave touches;
  - one empty-instance product walk (opus).

### A5. Rules inherited (non-negotiable)
- Fixture reachability, and walks start from an EMPTY instance.
- A green check must be shown failing first.
- Single plain shell commands; `git commit -s -F`, with the trailers.
- No push, tag or release inside tasks.
- After each verified release, tell Homelab to deploy.
- User docs and the README "what works" are updated in every wave.

---

## Part B: the feature recipe (shared appendix for every brief)
(Condensed from the create-channel trace. The full text is copied verbatim into each wave plan's appendix.)

1. **Go route.** Write a `NewX` group with a `Register(mux)` method (pattern: `internal/api/channels.go:125-131`) and mount it in `internal/dillad/routes.go` `mountPlanTwo` (:76-112). The handler follows `Channels.create` (channels.go:285-400):
   1. `enrolledSession`;
   2. `server.PathID`;
   3. `server.DecodeBody` into a `cbor:",toarray"` struct;
   4. a non-member gets `notFound`;
   5. the permission check through `LoadSnapshot(...).Resolve(uid).Has(PermX)` (perm.go:195) or `Resolver.Require` (:287);
   6. `repo.Tx` with an audit row (channels.go:377);
   7. side effects after the commit through `afterCommit(r)` (membership.go:51);
   8. `StructureNotifier.Changed` for op 54 (structurenotify.go:21);
   9. `server.EncodeBody`.
2. **Store.**
   - Twin queries in `internal/store/{sqlite,postgres}/queries/*.sql` with byte-identical headers (schema_test.go:83).
   - `store.go`, the adapters in both `repo.go`, and `contract_test.go`.
   - Run `sqlc generate` (v1.31.1).
   - Migrations: `000NN_*.sql` for both engines plus `schema/0MM_*.sql`, with the Up body verbatim, and `dump.go` DumpTables.
3. **Protocol docs.** protocol/09 subsection table; protocol/02 op table; a protocol/07 row (integrator only). Run `npm run check:docs`. A new `E_*` code touches protocol/02, `testkit/src/ds/state.rs` and `internal/server/errors.go`.
4. **client-core.**
   - `http/routes.ts` method under a feature banner, plus a `routes.test.ts` CASES row, refusal row and input rejects.
   - The `worker/protocol.ts` Command.
   - `controller.ts`: COMMANDS, ID_FIELDS, ACCEPTS, invalid() and dispatch(); the handler under a banner; publish a slice. `state/types.ts` SliceName and SliceTypes.
   - `controller.test.ts` with `world()` / `toReady()`.
   - `sync/testing/model.ts` RouteName, routesFor() and the server-rule double.
5. **ui.** `src/<Comp>/{.tsx,.css,.stories.tsx,.test.tsx}`. All copy comes through the `labels` prop, with tokens only. Export from `src/index.ts`. Storybook axe, the focus guard and target-size rules apply.
6. **web.**
   - The flow in `screens/<Flow>.tsx`, with the running, session and attempt guards (Create.tsx:283-345).
   - The Shell mount (state, opener and element).
   - Strings in a feature file `strings/<feature>.ts` spread into en.ts.
   - The flow doc `docs/design/flows/NN-*.md` with `## States` and `## Copy`.
   - A `strings.<flow>.test.ts`.
   - Vitest with `FakeClient` and `expectNoAxeViolations`.
7. **e2e.** `e2e/web/<feature>.spec.ts` on its own empty host, `startTestHost` with its own reserved port pair (create.spec.ts pattern). Controls are found by role and `copy(key)`.
8. **Gate commands** (Part B table, copied into every brief).

---

## Part C: Roadmap (waves)
The gap inventory has 117 items: HAVE 31, PARTIAL 20, SERVER-ONLY 23, MISSING 34, OOS 9. The full tables are in `2026-10-14-discord-parity-inventory.md`.

Jonas's rulings (2026-10-14):
- the order is friends-trial first;
- pull in **history for new members** and **custom emoji and stickers** from phase 2;
- avatars and icons are **encrypted, members only**;
- **sonnet** for recipe tasks.

Mobile apps, Web Push, forums, stage and scheduled events stay out.

Each wave = one plan doc, one branch, one PR, one prerelease `v0.1.0-web<N>`, a Homelab deploy, and Jonas's check.

| Wave | Release | Scope (inventory rows) | Size | Opus-only parts |
|---|---|---|---|---|
| **W1 Server admin and moderation** | web3.4 | See below. Server: rename, delete, leave; channels: rename, delete, topic, categories, reorder, slow-mode setting; invites: limits, list, revoke. A member list sidebar. Kick, ban, unban, ban list. The client knows its own permissions (new read route). Removal notices (gateway). Voice follow-ups: an autoplay-restricted e2e, audio-share `audible`, mid-call output switch, a "track attached" diagnostic. The `--check-args` doc line | L | the permissions read route and gateway op, the kick/ban removal semantics |
| **W2 Roles and private channels** | web3.5 | Roles list/create/edit/delete, colours, hoist, mentionable, permission editor, role assignment, private channels and overwrites UI. @role mentions. Client-side enforcement of pin and @everyone (protocol/07 Q20). Slow mode enforced on E2EE posts (ciphertext timing). Per-server notification settings | L | overwrite → MLS commit semantics, client-side permission folds, slow-mode enforcement |
| **W3 Profiles and presence** | web3.6 | `PATCH /me` store method (display name, custom status). Encrypted avatars and server icons (members-only blobs, key distribution through groups). Bio and pronouns, per-server nicknames, presence (op 48: online/idle/dnd/invisible, @here), user popout with safety number | L | encrypted avatar/icon key distribution |
| **W4 Rich messaging** | web3.7 | Markdown, code blocks, spoilers, a full emoji picker and emoji in text, link previews (sender-generated, receivers never fetch), a GIF picker (re-hosted as encrypted attachments), polls (new envelope type), forwarding (re-encrypt), moderator delete (signed moderation events), NSFW flag | XL | the new envelope types, moderation events, preview fetch privacy |
| **W5 Social** | web3.8 | Group DM create/add/remove, a friend list and requests, blocking (a client filter and leaving shared DMs), DM privacy settings | M | — |
| **W6 Custom emoji and stickers** | web3.9 | Per-server encrypted emoji and sticker assets, a picker, an upload/manage UI, rendering in text and reactions | L | encrypted shared asset distribution |
| **W7 Voice moderation and extras** | web3.10 | Server mute and deafen (SFU grants), move and disconnect, timeout, soundboard (encrypted shared assets) | M | SFU grant changes |
| **W8 Account, admin tools and PWA** | web3.11 | Change password, 2FA/passkeys UI, change username, delete account (with group Removes), reports UI, per-server audit log (client-signed events), installable PWA and service worker, desktop notifications without the tab | L | account deletion Removes, service-worker trust |
| **W9 History for new members** | web3.12 | MSC4268-style inviter history sharing: an encrypted history bundle handed to new members and new devices. Spec work first (brainstorm with Jonas), then build | XL | all of it: design and core |
| **W10 Electron desktop** | desktop-1 | A desktop shell that pins its own code; global push to talk, app and system audio in screen share, background notifications, rich presence | XL | the trust model and native key store |
| **W11 Bots and integrations** | web4.x | Bot accounts as visible group members, a bot SDK, slash commands (interaction groups, op 33), webhooks into readable channels, a music bot | XL | interaction groups |
| **W12 Quality** | rolling | WCAG 2.2 AA audit, i18n scaffolding, command palette and shortcuts. Runs as a haiku/sonnet side lane in every wave | M | — |

**Added after a completeness check against the inventory.** Six items were in no wave. They are placed as follows:
- **W1** also gets **transfer ownership**: a new route plus a danger-zone action, an opus task because it changes who can delete the server.
- **W2** also gets **threads**: public threads in the parent MLS group through the envelope `thread_id`; private threads get their own group (opus). It also gets **announcement channels**: a channel kind that only role-holders post in, plus follow into other servers' readable channels.
- **W4** also gets **on-device AutoMod**: keyword, link and spam filters run on each client after decryption. The server can't read E2EE text, so this is a client-side policy set by moderators and distributed as a signed server setting.
- **W5** also gets **DM privacy settings**: who may DM you and send friend requests.
- **W8** also gets the **vanity invite**: a fixed code. Per spec:102-103 an open invite makes a channel server-readable, so the copy must say so.

Parallelism across waves:
- W5 (social) and W12 can run beside W2–W4 in their own lanes, because they touch disjoint areas.
- W9's design brainstorm can start during W3.

## Part D: Wave 1 (web3.4) in detail
**Source.** The full design, about 500 lines with exact shapes, en.ts text and test cases, is `docs/superpowers/plans/2026-10-14-dilla-web-3-4-admin.md`. The essentials are below.

**Findings that shape it:**
- No migration, no new op and no new permission bit.
- Op 54 `community_changed` is reused and is also sent once to a removed user. The client already drops a server missing from the re-read list (controller.ts:1347-1358), so the client only adds a notice.
- Ports 8485/6 are taken by the probe, so W1 uses **8487/8488**, with 8489/8490 spare.
- `e2e/web/membership.spec.ts` (kicked = not-member) is rewritten on purpose.
- Invite links can't be shown again, because the server keeps only a hash; the copy says so.
- No slow-mode control appears, because slow mode isn't enforced on E2EE channels yet (that's W2).
- New string prefixes are `admin.`, `members.`, `mod.` and `removed.`, chosen so the pinned key counts in strings.test.ts stay valid.

**Server (lane SRV, which owns protocol/02, protocol/09, routes.go and internal/api):**
- S1 (sonnet): `GET /v1/communities/{id}/permissions` → `[bits, top]`, where top is 0 for @everyone and 2^31 for the owner.
- S2 (sonnet): `GET /v1/communities/{id}/roles`, readable by any member → `[[id, name, color, position, allow, deny, hoist, mentionable]]`.
- S3 (sonnet): the ban list gains `username, display`.
- S4 (opus): op 54 fan-out on join, leave, kick, ban, delete and role/overwrite changes, plus once to the removed user (`StructureNotifier.Removed` / `ChangedTo`); and the protocol prose.

**client-core (lane CORE):**
- C1 (sonnet): 13 routes.
- C2 (sonnet): the slice types `permissions:/roles:/bans:/invites:/removals`, and `admin/rank.ts` (`accessOf`, `topOf`, `canModerate` mirroring `outranks()`).
- C3 (sonnet): `AdminController` with 13 ready-only commands (renameCommunity, deleteCommunity, leaveCommunity, createCategory, updateChannel, moveChannel, deleteChannel, kickMember, banMember, unbanMember, loadBans, loadInvites, revokeInvite), and loadAccess after select.
- C4 (opus): the removal diff → `removals` slice (cap 8, none for your own leave or delete, none at boot).

**ui (lane UI, sonnet, U1→U6):** ActionMenu (WAI-ARIA menu button and context menu), ConfirmDialog, Select, MemberList (hoisted groups, right-click / Shift+F10), ManageList, ChannelSettings, and an AppShell `aside` slot (a fourth column ≥ 64rem, an overlay drawer below that).

**Voice (lane VOICE):**
- V1 (opus): mid-call output switch.
- V2 (opus): "hearing {attached} of {expected}" diagnostic.
- V3 (opus): autoplay-restricted e2e, shown red with startAudio stubbed.
- V4 (opus): audible screen-share audio.
- V5 (haiku): the `--check-args` doc line.

**Web:**
- WEB-A, W1 (sonnet): members-model, MemberPane, Kick/Ban flows with a reason and a length (1h / 1d / 7d / 30d / until lifted).
- WEB-B, W2a–d (sonnet): the ServerSettings dialog on SettingsFrame. Its tabs are overview (rename), channels (edit / move up/down / delete, new category), invites (expiry 30m–30d, max uses 1–1000, list, revoke), bans (list, unban), and danger (leave, or delete by typing the server name with NFC matching).
- W3 (sonnet, the sole owner of Shell.tsx): the mounts, the members toggle, the removal banner and navigation.

**Strings:** T1 (haiku) writes flow doc 08-server-admin.md and the exact en.ts text from the design §4.1, in the feature files `strings/{admin,members,moderation}.ts`.

**Phases and lanes:**
- **P0 (sequential):** T0 hotspot prep — split strings into feature files, one allow-list entry per line, a `VALIDATORS` hook, `strings.flow08.test.ts`, the 08 skeleton, and a copy of the parity inventory into docs/. Then T1.
- **P1 (parallel):** SRV ‖ CORE ‖ UI ‖ VOICE.
- **P2 (parallel):** WEB-A ‖ WEB-B.
- **P3 (sequential):**
  - W3;
  - E1 `e2e/web/admin.spec.ts` (two browsers from an empty instance: rename live, channel edit live, kick → notice, rejoin, ban → rejoin refused, unban, owner not moderatable, leave, delete);
  - E2 membership.spec rewrite;
  - H2 (haiku) user docs and README;
  - integrator: the protocol/07 row, full gates, and the opus walk.

**Integration order:** T0 → T1 → SRV → CORE → UI → VOICE → WEB-A → WEB-B → W3 → E1 → E2 → H2 → 07 row.

**Review focus:**
1. Stale permissions (demoted between load and action).
2. Removed while busy (open dialog or call in that server).
3. Multiple devices and tabs.
4. Honest lists: no re-showable links, lapsed bans, NFC name match, "the host can read it".
5. Keyboard and screen reader: Shift+F10, focus return, 360 px / 200% drawer.

**Risks needing an opus sign-off:**
- the removed user receiving op 54 (it carries nothing new);
- role allow/deny becoming readable by every member;
- op 54 read amplification in large servers (measure it in the walk).

## Part E: Decisions for Jonas
**Taken 2026-10-14:**
- order: friends-trial first;
- pull in history for new members and custom emoji/stickers;
- avatars encrypted, members only;
- sonnet for recipe tasks.

**Still open (none block W1):**
- the rail join tile (M9);
- a thicker composer focus border in light/high-contrast;
- the `v*` tag ruleset;
- W9 history design: a brainstorm with Jonas before W9 starts.

## Execution steps after approval
1. Save memory: the cost model (sonnet/haiku for recipe tasks) and the parity roadmap.
2. Branch `dilla-web-3-4-admin` from origin/main.
3. Write `docs/superpowers/plans/2026-10-14-dilla-web-3-4-admin.md` from Part D and the design output, plus `docs/superpowers/specs/2026-10-14-discord-parity-roadmap.md` (Part C plus the inventory). Commit.
4. Run SDD:
   - mkbriefs per task;
   - P0 sequential;
   - P1 four lanes in `git clone --shared` copies (`/home/thim/.cache/dilla-w3/lane-{srv,core,ui,voice}`, own CARGO_TARGET_DIR/GOCACHE);
   - each task gets an implementer (model per table), a task reviewer (sonnet; opus for S4, C4 and V1-V4) and fix rounds;
   - cherry-pick in the integration order.
5. Whole-branch opus review plus an empty-instance walk; PR; CI green; merge; tag `v0.1.0-web3.4`; verify the assets; tell Homelab to deploy; Jonas checks.
6. Next wave: write W2's plan the same way while W1's CI runs.

## Appendix: coverage of every non-HAVE inventory item
| Area | Item → wave |
|---|---|
| Servers | rename W1 · icon/banner W3 (encrypted) · delete W1 · leave W1 · transfer ownership W1 · settings screen W1 · invite limits/list/revoke W1 · vanity invite W8 |
| Channels | categories W1 · reorder W1 · topic W1 · rename/delete W1 · slow mode W2 (E2EE enforcement) · private channels and overwrites W2 · threads W2 · announcement W2 · NSFW flag W4 · forums OUT · stage OUT |
| Roles | create/edit/delete W2 · colours W2 · hoist W2 · mentionable W2 · permission editor W2 · assignment W2 · own permissions W1 (read route), W2 (client folds) |
| Members | member list W1 · presence W3 · custom status W3 · avatar W3 · display name W3 · bio/pronouns W3 · nicknames W3 · user popout W3 |
| Moderation | kick/ban/unban/ban list W1 · timeout W7 · audit log W8 · AutoMod W4 (on device) · reports W8 · moderator delete W4 · server mute/deafen W7 · move/disconnect W7 |
| Messaging | markdown/code/spoilers W4 · full emoji picker W4 · custom emoji/stickers W6 · GIFs W4 · link previews W4 · @everyone/@here checks W2 (+ @here presence W3) · @role W2 · polls W4 · forwarding W4 · history for new members W9 |
| DMs/social | group DMs W5 · friends W5 · blocking W5 · DM privacy W5 |
| Voice/video | app/system audio share W10 · global push to talk W10 · soundboard W7 · stage OUT |
| Notifications | per-server W2 · background desktop notifications W8 (service worker) and W10 · mobile push OUT |
| Clients | Electron W10 · PWA/installable W8 · offline app shell W8 · mobile apps OUT |
| Account | 2FA/passkeys W8 · change username W8 · change password W8 · delete account W8 · privacy settings W5 |
| Platform | bots W11 · webhooks W11 · slash commands W11 · integrations W11 · rich presence W10 · scheduled events OUT |
| Quality | accessibility audit W12 · i18n W12 · shortcuts/palette W12 |

OUT = Jonas's ruling 2026-10-14 (mobile apps, Web Push, forums, stage, scheduled events).

**Level of detail.**
- W1 is designed to task level.
- W2–W12 are scoped to the item level above. Each gets its task-level design (a Plan agent on opus using the same brief contract) while the previous wave is in CI. That way each design reads the code as it actually is after the previous wave, not a guess.

## Verification (per wave)
- Task gates (narrow) and the wave gates in Part A4: npm test, ui storybook + axe, Go -race on touched packages, sqlc diff, check:docs/copy/ci, the touched e2e configs.
- Every new check is shown red before green.
- An opus walk from an EMPTY dilla-testhost with two browsers through every new flow.
- CI green on the PR; release assets verified (sha256sum -c, stamped tag, `dillad version`); Homelab deploy, doctor 0 FAIL; Jonas's hands-on check.
