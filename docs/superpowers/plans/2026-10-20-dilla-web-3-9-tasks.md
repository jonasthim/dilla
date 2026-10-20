# dilla v0.1.0-web3.9: a built-in AFK channel, the alignment pass, a Discord layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **AFK is built in.** Every server has one listen-only voice channel named "AFK", made by the server. It can be renamed and moved, never deleted, never turned into anything else, and it takes no permission overwrites. Every member may always see it and join it. The admin sets only the inactive timeout (1, 5, 15, 30 or 60 minutes; default 5). An idle desktop device is moved there by the server and joins the AFK call itself, muted. Phones are never moved.
- **The alignment pass.** The 2 critical and 14 high findings of `ux-audit.md`, through its eight shared fixes S1–S8: one set of row and bar tokens, one 16px glyph column, one trailing slot, icon buttons with tooltips, no undefined custom properties, one settings grammar, inset focus rings, two tested tap-target tiers.
- **A Discord layout, in Mesh.** The `@` Home tile on the rail (desktop and phone) replaces the sidebar tabs; three phone tabs (Home, Activity, You); a 72px rail with 48px tiles; categories that render and collapse; one-click voice join on desktop; avatar speaking rings; a dock without a meter; a header icon cluster; two-line member rows with online and offline sections; grouped messages with date dividers and "jump to present"; tap-to-reveal message actions on phone.
- **Leftover cards:** Firefox `reload.spec` root cause, the deferred-restart speech loss, `PartOf=dilla.service`, `dillad media --rooms`, the Diagnostics device count, category visibility.

**Out of scope (web3.10 and later):** GIFs (the "GIFs (web3.10)" section of the wave plan is a design, not work), context menus and long-press sheets, gestures, drag reorder, the NEW divider, Esc-to-read, an inbox, passkey PRF.

**Architecture:**
- **dillad (Go):**
  - `Communities.create` writes the AFK channel, its `community_afk` row and a system audit row in the community's own transaction;
  - `api.EnsureAFKChannels` runs once inside `dillad.New` (the composition root, `internal/dillad/routes.go`), before any listener exists, so `dillad serve` and `dilla-testhost` both backfill;
  - the resolver grants every member `view_channel | connect` on the AFK channel (a `Snapshot.AFK` flag that `LoadSnapshot` and `EligibleUsers` set);
  - delete, patch and overwrite refusals under the community row lock;
  - every grant path (`grantFor`, `admitGrant`, the role-change re-push in `callgrants.go`) is listen-only in the AFK channel, and share leases are refused there;
  - the sweep records `afkPending[device]` and sends op 54 to the moved user; the snapshot carries `pending` for the caller's device; the occupant roster, `POST /afk` and `DELETE /afk` are retired;
  - a channel's parent must be a category its creator or editor can view, and the listing never reveals a category the caller cannot view.
- **client-core (TS):** `setAFK(timeout)`, `afkActivity(…, exempt?)`, the `afk:` slice `{ channelId, timeoutSeconds, pending }`, the AFK grant mirrored in `admin/perm.ts`, next-position computations skip the AFK channel, `afkMove`/`afkLeave` deleted, a device count of live devices loaded at ready, and the `channels.collapsed.<category>` setting.
- **packages/ui:** tokens (`--row-h`, `--row-h-sub`, `--row-h-2`, `--list-gap`, `--bar-h`, `--slot-w`, `--rail-w: 72px`, `--rail-tile`), `IconButton`, `Tooltip`, `TrailingSlot`, the R16 var check; the sidebar, rail, header, members, stage, dock, messages and settings components rebuilt to the grammar.
- **web:** Shell wiring in six serialized tasks; the AFK call is an ordinary `VoiceView`; useCall joins a pending AFK move listen-only.
- **No migration** (schema stays **20**), client store **5** unchanged, wire **2** unchanged, browser ABI **11** unchanged, WASI ABI 7 reserved and untaken, no gateway op (op 54 reused; 55 stays free), no permission bit, no new error code.

**Tech Stack:** Go (internal/api, internal/dillad, internal/dillad/dilladtest, cmd/dillad, internal/store), POSIX shell and systemd units (deploy/), TypeScript (client-core worker, React web, packages/ui and Storybook, design-tokens), Playwright e2e against dilla-testhost (Chromium, Firefox, WebKit; phone at 390×844, 360×740 and 844×390; desktop at 1440×900 and 1024×768).

**Spec:** `docs/superpowers/plans/2026-10-20-dilla-web-3-9.md` (the wave plan; its Rulings R1–R32, Reservations, Parts A–D, Design gate, Verification, Release-notes duties, "Decisions (answered 2026-10-20)" and follow-up answers F1–F5 are binding). Sources it cites live under `.superpowers/sdd/2026-10-17-dilla-web-3-8/`: `afk-research.md` (G1–G15), `ux-audit.md` (finding ids A1–L3, S1–S8) and `ux-audit/` shots, `discord-research/screenshot-measurements.md` (measured values override the other three research files), `progress.md`, `final-review.md`, `WS6-security-review.md`.

**Anchors** are verified on `dilla-web-3-9` @ 9f632564 (main = web3.8 + docs). A moved anchor is not a NEEDS_CONTEXT; a missing one is.

**Findings that shaped the plan** (wave plan text checked against the tree; each is ruled in Rulings or Pre-flight rulings):
- Op 54 is `community_changed` to the community's members, not a per-device op (`internal/gateway/frame.go:62`, `internal/api/structurenotify.go:46-56`). The pending move reuses it through `StructureNotifier.ChangedTo(ctx, cid, []id.ID{user})`; `pending` in the snapshot is per calling device (R33).
- The role-change grant re-push builds its own grant at `internal/api/callgrants.go:307`, outside `grantFor`/`admitGrant` (`calls.go:1051-1066`). R3 covers it too, or a role change in a community re-grants the microphone in AFK (R34).
- `EligibleUsers` builds `Snapshot` by hand (`internal/api/private.go:40-80`), and the channel list resolves each channel (`channels.go:917-929`). The AFK grant is a `Snapshot` field, not a branch in `Resolver.Resolve` alone, or `channel_members` would leave out role-denied members and the MLS call group would refuse them (R35).
- The settings value cap is 1024 bytes (`core/dilla-core/src/client/settings.rs:8-9`). One `channels.collapsed` value holds at most 31 category ids. The key is per category, `channels.collapsed.<categoryHex>` = `'1'` (R36).
- `--row-gap` already exists as a density token used by messages and lists (`design-tokens/src/css.ts:11-16`, `ChannelRow.css:1`, `MessageRow.css:1`, `app.css:8-48`). R10's between-row gap is `--list-gap` (R37).
- AFK copy lives under `voice.afk.*` (en.ts:455-460) and `admin.afk.*` (admin.ts:27-37); there is no `afk.` file. The new keys go in a new `strings/afk.ts`; the old keys stay unused in en.ts (R38).
- The dock has no "voice connected" string: it renders `voice.dock.connected` = `in {where}` (en.ts:465, `VoiceDock.tsx:79`). New keys `layout.dock.*` (R38).
- There is no channel-settings tab bar: `ChannelEditFlow` renders `ChannelPermissions` inline (`screens/admin/ChannelEditFlow.tsx:84-85`), and delete lives in server settings → channels (`ChannelsSection.tsx:97`, `:133-155`). R7 is carried out there (R39).
- There is no e2e port registry, and the wave plan's "taken" list was incomplete (21 pairs are in use; see Global Constraints). 8611–8616 are free in the repo; 8611/8612 are the audit world's.
- The audit world builder and shooters are not in the repo (`scratchpad/ux/world.mjs`, `run.mjs`, `s*.mjs`, `p*.mjs`, `phone.mjs`, `auth.mjs`). E-GEO commits them under `e2e/ux/`, so AUDIT-2 and the contact sheets are reproducible (R40).
- The retired AFK routes: there is no `E_GONE` in protocol/02 § Errors (:846-879). They answer `404 E_NOT_FOUND` through explicit handlers (R41).
- The GET `/afk` snapshot's third element is a list today; replacing it with a bool would break every web3.8 parser (`routes.ts:358-365`, `atLeast(…,3)` and `bounded(a[2], 1024, …)`). The new shape keeps the third element as an always-empty list and appends `pending` (R33), so the change is additive.
- A new community has no channels when it is created (`communities.go:255-290`), and clients place a new channel at `max(position) + 1` (`admin/controller.ts:219-220`, `worker/controller.ts:2210`). An AFK at "the last position" therefore needs a fixed high position that clients skip (R42).
- The E-PHONE task of the wave plan cannot run after WEB-HOME: changing the phone tabs breaks `e2e/web/phone.spec.ts` at once, and every lane runs its project's whole e2e suite before integration. E-PHONE is folded into WEB-HOME.
- The invite landing page's CSP is `default-src 'none'; style-src 'unsafe-inline'` (`invites.go:158`); serving JetBrains Mono needs `font-src 'self'`. WEB-AUTH takes that change, with an opus review (R43).
- CI's `go-postgres` job runs only `./internal/store/... ./internal/ops/...` (ci.yml:772-775), so the backfill would never run on Postgres in CI. The CI task adds the AFK tests of `./internal/api/...` there.

## Rulings

Built as written unless the controller or Jonas overturns them. R1–R32 are the wave plan's (`2026-10-20-dilla-web-3-9.md` § Rulings), carried verbatim by reference and binding; the text below restates each one only where this plan settles a detail, and adds R33–R44.

- **R1. The built-in AFK channel** (wave plan R1, settled):
  - Row: `Kind 1` (voice), `Mode 0` (`ModeE2EE`), `Visibility 0` (`VisPrivate`), `ParentID nil`, `Name "AFK"`, `Topic ""`, `Position AFKBuiltinPosition` (R42), `SlowmodeSeconds 0`, `SettingsJSON {}`, `HostPolicyVersion` = the community's, no overwrites.
  - Audit row, same transaction: `{Actor: nil, Action: "channel.create", Target: <channel id>, Detail: "afk.builtin", At: now}`.
  - **New communities:** `Communities.create` (`communities.go:212-301`) writes the channel, the audit row and `community_afk {channel, 300}` inside its `Tx` (:255-290), after `PutRole`. After the commit it calls `MaterialiseChannelMembers(afterCommit(r), c.repo, c.dsvc, afk, now)`.
  - **Existing communities:** `api.EnsureAFKChannels(ctx, repo, dsvc, clk, log) (created int, err error)`, called once from the composition root (`internal/dillad/routes.go`, after the `notify` line :116, before `calls.Register`). It never runs inside a request.
    - "Done" means: the community's `community_afk.channel_id` names a live channel whose id is in the set of `Target`s of audit rows with `Action == "channel.create"`, `Detail == "afk.builtin"` and `Actor == nil`. The set is read once per start by paging `ListAudit(ctx, since, 500)` until a short page; no new store method and no new query.
    - Every other live community (no row, a NULL pointer, or a web3.8 pointer at an admin-picked channel): one `Tx` per community that takes `LockCommunity`, re-checks "done" under the lock, creates a new `AFK` row and audit row, and `SetCommunityAFK(cid, {&afk, keep the stored timeout or 300})`. After the commit, `MaterialiseChannelMembers`.
    - The old pointed channel is untouched: its name, overwrites and live call stay, and it is ordinary from that commit on.
    - A failure for one community is logged (`log.ErrorContext(ctx, "afk backfill", "community", cid, "err", err)`) and does not stop the start or the other communities. The summary is one `log.Info("afk backfill", "created", n)` line when `n > 0`.
  - **Lazy ensure:** `GET /v1/communities/{id}/afk` calls `ensureAFK(ctx, cid)` only when the stored pointer is NULL or names no live channel; it runs the same per-community transaction. A failure is logged and the snapshot answers `[null, timeout, [], false]`.
- **R2. Refusals** (wave plan R2, settled):
  - `DELETE /v1/channels/{id}` whose row is the community's AFK channel: `403 E_FORBIDDEN`, detail `the AFK channel cannot be deleted`. The check runs inside the `Tx` after `lockManageable` (`channels.go:973-975`) and replaces the SET NULL block at :984-995.
  - `PATCH` on the AFK channel with a non-nil `Topic`, `Mode`, `Visibility` or `SlowmodeSeconds`: `403 E_FORBIDDEN`, detail `the AFK channel keeps its kind, mode, visibility, topic and slow mode`. Inside the `Tx` after `lockManageable` (:766-768). `Name`, `Position` and `ParentID` pass, and the parent goes through R44.
  - `PUT` and `DELETE /v1/channels/{id}/overwrites/{kind}/{target_id}` whose channel is the AFK channel: `403 E_FORBIDDEN`, detail `the AFK channel takes no permission overwrites`, checked in `overwriteTarget` (both handlers call it, `roles.go:1018` and :1099, and again under the lock). The wave plan's "as does a create that names one" has no path: a channel create writes overwrites only for the channel it creates (`channels.go:582-593`). It is ruled moot; no code.
  - `PUT /v1/communities/{id}/afk/settings`: body `[timeout_seconds]`; `[channel_id, timeout_seconds]` is accepted only when `channel_id` equals the built-in id, else `400 E_INVALID_REQUEST` detail `the AFK channel is built in; send [timeout_seconds]`. A `null` channel id in the two-element form is that 400 too. Timeouts `60, 300, 900, 1800, 3600` (detail unchanged, `communities.go:134`).
  - `GET /v1/communities/{id}/afk/settings` keeps `[channel_id, timeout_seconds]` (the built-in id), unchanged.
- **R3. Listen-only** (wave plan R3, plus R34): `grantFor`, `admitGrant` and the re-push at `callgrants.go:307` return `sfu.PublishGrant(false, false, false)` for a call row whose `ChannelID` is the community's AFK channel. `POST …/call/share` there answers `403 E_FORBIDDEN` detail `nobody shares in the AFK channel`.
- **R4. The move** (wave plan R4, plus R33). Pending entries live 10 minutes (`afkPendingTTL = 10 * time.Minute`).
- **R5. Exempt** (wave plan R5, settled): `POST /v1/communities/{id}/afk/activity` body `[channel_id]` or `[channel_id, exempt(bool)]`. With `exempt == true`, the server deletes `afkTracked[dev]` and records `afkExempt[dev] = <that call's livekit room>`; `trackAFKAdmission` skips a device whose `afkExempt` room equals the admitted room, and a non-resume admission into another room clears the entry. So an exempt report that arrives before the admission still holds. The client sends `exempt` on its first report after each join, when `usePhoneLayout()` is true or `matchMedia('(pointer: coarse)').matches`.
- **R6–R8:** as the wave plan.
- **R9–R32:** as the wave plan, with R37 renaming R10's `--row-gap` to `--list-gap`, and R40-R43 below.
- **R33 (new). The snapshot and the pending move.**
  - `GET /v1/communities/{id}/afk` answers `[channel_id(bstr16|null), timeout_seconds(uint), [] , pending(bool)]`. The third element is always an empty array (the web3.8 occupant list, retired) so a web3.8 parser still reads it; `pending` is true only when `afkPending[<the caller's device>]` names this community and is younger than `afkPendingTTL`.
  - The sweep, after a successful `RemoveParticipants` (`afk.go:333-342`), sets `afkPending[dev] = {community, channel: <AFK id>, at: now}`, deletes `afkTracked[dev]`, and calls `notify.ChangedTo(ctx, community, []id.ID{user})`.
  - `Admitted` (`calls.go:1197-1214`) deletes `afkPending[dev]` for any admission of that device. `SweepAFK` deletes entries older than the TTL.
  - Nobody but the sweep writes `afkPending`; there is no route that sets it.
- **R34 (new). Every grant path is AFK-aware.** A helper `func (h *Calls) inAFK(ctx context.Context, row store.VoiceSessionRow) bool` reads the channel's community pointer (`GetChannel`, then `GetCommunityAFK`); `callgrants.go` gets the same answer through the `*Calls` it already holds or a function field. A read error counts as AFK (fail closed: listen-only).
- **R35 (new). The grant lives in `Snapshot`.** `Snapshot` gains `AFK bool`. `LoadSnapshot(ctx, repo, cid, uid, &chID)` sets it when `GetCommunityAFK(cid).ChannelID == chID`; `EligibleUsers` sets it once for its channel. `ResolveChannel` ends with: when `s.AFK` and the user is a member (the snapshot exists only for members), `return bits | PermViewChannel | PermConnect`, where `bits` is what the existing rules give (so a member with no community-wide view gets exactly `PermViewChannel | PermConnect`; the owner and administrators keep `PermAll`). `Snapshot.Resolve` (community-wide) is unchanged. The client mirror is `admin/perm.ts` (CORE-AFK).
- **R36 (new). Collapsed categories** are the device-local setting `channels.collapsed.<categoryHex>` = `'1'`; expanding deletes it (`setSetting` with `value: null`, `controller.ts:2878`). `isSettingKey` gains the `channels.collapsed.` prefix with a `HEX32` suffix; `isSettingValue` falls through to `value === '1'` (`settings.ts:88`). No store schema change: `app_settings` is key/value (`schema.rs:163`).
- **R37 (new). `--list-gap`** is R10's between-row gap (2px desktop, 0 phone). `--row-gap` stays the density token.
- **R38 (new). Copy prefixes:** `afk.`, `layout.` and `home.` in new files `strings/afk.ts`, `strings/layout.ts`, `strings/home.ts`. There is no `tooltip.` prefix: a tooltip shows its control's existing accessible name (R15's "the accessible name starts with the visible tooltip text"), and the four new icon-only controls get `layout.` keys. `voice.afk.*` and `admin.afk.*` stay in en.ts unused, as web3.8 kept `voice.heading.*`.
- **R39 (new). Where R7 lands.** In `ChannelEditFlow` the AFK channel shows the name field and the category select only, plus `afk.channel.note`; no topic, no slow mode, no `ChannelPermissions`. In server settings → channels the AFK row has no delete action. There is no mode or visibility control anywhere for any channel today (Shell reads `mode` only), so nothing else is hidden.
- **R40 (new). The audit scripts move into the repo** as `e2e/ux/` (E-GEO), with the repo root resolved from `import.meta.url` instead of the hard-coded path at `world.mjs:8`, on 8611/8612 (SFU 7988/7990) as in the audit. Contact sheets and AUDIT-2 run from them.
- **R41 (new). Retired routes.** `POST` and `DELETE /v1/communities/{id}/afk` stay registered and answer `404 E_NOT_FOUND` detail `retired in web3.9`, so a web3.8 tab gets a mapped refusal instead of the mux's 405.
- **R42 (new). Position.** `const AFKBuiltinPosition = 1 << 30` (1,073,741,824, below `maxChannelPosition` 2³¹−1, `channels.go:52`). Clients skip the AFK channel when they compute `max(position) + 1` (`admin/controller.ts:219-220`, `worker/controller.ts:2210`), so new channels land above it. A web3.8 client after a rollback computes 2³⁰+1, still valid. The admin may move it; R2 lets `Position` through.
- **R43 (new). The invite page font.** `InviteLanding` gains `font-src 'self'` in its CSP (`invites.go:158`), and nothing else: still no script, no form, no external reference, one same-origin link. The `@font-face` names the JetBrains Mono latin woff2 found once at start in the web client dillad serves (`Options.Web`, else `web.Embedded()`, `internal/dillad/options.go:80-82`) by `fs.Glob(webFS, "assets/jetbrains-mono-latin-wght-normal-*.woff2")`; with no match (the embedded placeholder) the page keeps today's system stack, and `font-src 'self'` is harmless.
- **R44 (new). Category visibility (SRV-CAT).**
  - Create and patch: a non-nil `ParentID` must name a category the caller holds `PermViewChannel` in (`Resolver.Resolve` on the parent row), else `404 E_NOT_FOUND` detail `no such object` (the existing not-visible answer, `perm.go:291`). Checked inside the `Tx` after the lock, beside `validChannel`.
  - Listing (`channels.go:917-929`): a visible child no longer marks its parent visible. A child whose parent the caller cannot view is listed with `ParentID nil`.
  - The AFK channel's re-parent goes through the same rule.

## Global Constraints

- **Models** (a task's `Model:` line is binding):

  | Task | Implementer | Reviewer |
  |---|---|---|
  | T0, RELNOTES | haiku | sonnet |
  | OPS, UI-1, UI-2, UI-3, UI-4, UI-5, WEB-HOME, WEB-LIST, WEB-PHONE, WEB-SET, WEB-DOCK, E-GEO, CI, DOCS | sonnet | sonnet |
  | CORE-AFK, WEB-AFK, WEB-AUTH, AUDIT-2 | sonnet | **opus** |
  | SRV-AFK, SRV-CAT, VOICE-FIX, FX-RELOAD, VOICE-AFK, E-AFK, H1 | opus | **opus** |

  H1 is opus-implemented because its rows state authz changes (the AFK grant, the overwrite refusal, R44); DOCS is sonnet because it re-shoots screenshots (web3.7 ledger ruling, 2026-10-16), and its prose is haiku-grade text written inside it.
- **Reservations:**
  - **no server migration** (schema stays 20). If the SRV-AFK implementer proves an invariant must live in the database, it stops with NEEDS_CONTEXT naming it; the reserved number is `00021` on both engines, and RELNOTES then labels **schema 20 → 21**;
  - client store schema **5** (unchanged; R36 needs none); browser ABI **11**; WASI ABI 7 reserved and untaken;
  - wire **2** (unchanged); **no gateway op** (op 54 reused; 55 free); no permission bit; `voice_state` bit 5 stays reserved (R6);
  - **no new error code**: `403 E_FORBIDDEN`, `400 E_INVALID_REQUEST` and `404 E_NOT_FOUND`, with the details in R2, R3 and R41;
  - the server-written name `AFK`, a Go literal, not localised;
  - `const AFKBuiltinPosition = 1 << 30` (R42); audit detail `afk.builtin`;
  - flow doc **14**: `docs/design/flows/14-layout-grammar-and-afk.md`, holding the `afk.`, `layout.` and `home.` copy;
  - string prefixes **`afk.`**, **`layout.`**, **`home.`**; value changes only to the R19/I4 keys listed in T0; no removals;
  - one settings key family, `channels.collapsed.<categoryHex>` (R36);
  - **e2e ports**, all new: **8613/8614** `e2e/web/afk.spec.ts` (SFU 7896/7898), **8615/8616** `e2e/web/layout.spec.ts` (SFU 7900/7902), **8611/8612** the `e2e/ux/` world and sheets (SFU 7988/7990). Taken and never reused: 8443/4, 8453/4, 8463/4, 8471/2, 8477/8, 8481/2, 8485/6, 8487/8, 8491/2, 8493/4, 8495/6, 8497/8, 8499/8500, 8501/2, 8503/4, 8505/6, 8513/4, 8515/6, 8517/8, 8521/2, 8523/4, 8525/6, and SFU 7884/6, 7888/90, 7892/4. no new voice spec (the AFK energy pin is in `afk.spec.ts`, which needs its own restartable host);
  - vendored icons (UI-1 only), Lucide **1.57.0** (the `icons.ts` header): `lock`, `log-out`, `shield`, `keyboard`, `monitor-smartphone`, `phone`, `square-pen` (Lucide's current name for `pen-square`), `at-sign`, `pin`, `users`, `ellipsis`. `chevron-down`, `headphones`, `settings`, `plus`, `search`, `messages-square`, `megaphone`, `volume-2` and `hash` are already vendored (`icons.ts:92-246`).
- **Lanes.** Each lane is a `git clone --shared` of the wave branch:
  ```
  git clone --shared /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol /home/thim/.cache/dilla-w3/lane-<id>
  git -C /home/thim/.cache/dilla-w3/lane-<id> switch -c w39-<id>
  ```
  - Lanes: `srv`, `srv2`, `ops`, `core`, `voice`, `e2e0`, `ui`, `ui-b`, `ui-c`, `ui-d`, `web`, `auth`, `e2e`, `e2e2`.
  - Each lane's gate script exports `CARGO_TARGET_DIR=/home/thim/.cache/dilla-w3/lane-<id>-target` and `GOCACHE=/home/thim/.cache/dilla-w3/lane-<id>-gocache`.
  - P0 and P4 run on the wave branch.
- **Serialized files and owners:**

  | File | Owner, in order |
  |---|---|
  | `packages/web/src/screens/Shell.tsx` | WEB lane: WEB-AFK → WEB-HOME → WEB-LIST → WEB-PHONE → WEB-SET → WEB-DOCK; any later fix-up is assigned by the controller |
  | `packages/web/src/app.css` | UI-1 (:73 and :184 only, R16) → WEB-AFK (deletes :73) → WEB-HOME → WEB-LIST → WEB-PHONE → WEB-DOCK |
  | `packages/web/src/layout.ts`, `layout.test.ts`, `router.ts`, `router.test.tsx` | WEB-HOME → WEB-PHONE |
  | `packages/web/src/screens/voice/useCall.tsx`, `packages/web/src/call/session.ts` | VOICE-FIX (`session.ts` only) → VOICE-AFK |
  | `packages/web/src/screens/conversation/**` | WEB-PHONE only |
  | `packages/web/src/screens/admin/MemberPane.tsx` | WEB-LIST → WEB-SET |
  | `packages/web/src/screens/voice/VoiceView.tsx` | VOICE-AFK → WEB-AFK → WEB-LIST → WEB-PHONE → WEB-DOCK |
  | `packages/web/src/screens/admin/{OverviewSection,ChannelEditFlow,ChannelsSection}.tsx` | WEB-AFK → WEB-SET |
  | `packages/web/src/test/fake-client.ts` | CORE-AFK → WEB-AFK |
  | `packages/design-tokens/src/tokens.ts`, `css.ts`, `css.test.ts`, `tokens.test.ts`, `dist/tokens.css` | UI-1 only |
  | `packages/ui/src/styles/base.css`, `base.test.ts`, `test/phone-query.test.ts` | UI-1 → UI-2 → UI-3 → UI-4 → UI-5 (each rebases; UI-2…UI-5 add only `[data-layout="phone"]` rules, never a new `@media`, so the phone-query count at `phone-query.test.ts:48` stays 10) |
  | `packages/ui/src/Icon/icons.ts`, `Icon.test.tsx` | UI-1 only |
  | `packages/ui/src/index.ts` | UI-1 → UI-2 → UI-3 → UI-4 → UI-5 (each appends its own exports) → WEB-HOME (removes the `SidebarTabs` exports) |
  | `packages/ui/src/{ChannelList,ChannelRow,VoiceChannelRow,CommunityRail}/**` | UI-2 only |
  | `packages/ui/src/SidebarTabs/**` | WEB-HOME only (deletes it with its last caller; pre-flight P-17) |
  | `packages/ui/src/VoiceDock/VoiceDock.tsx` | UI-3 → WEB-DOCK (deletes the ignored `meter` prop only) |
  | `packages/ui/src/{ChannelHeader,MemberList,CallStage,CallTile,VoiceDock,UserPanel,AudioMeter}/**` | UI-3 only |
  | `packages/ui/src/{MessageLog,MessageRow,Composer,MessageToolbar}/**` | UI-4 only |
  | `packages/ui/src/{SettingsRow,SettingsFrame,SettingsNav,SearchPalette,ManageList}/**` | UI-5 only |
  | `packages/ui/src/{Tooltip,IconButton,TrailingSlot}/**` (new), `Button/**`, `Segmented/**`, `KeyHint/**`, `scripts/check-css-vars.mjs` (new) | UI-1 only |
  | `internal/api/{afk,calls,callgrants,callshare,communities,perm,private,roles}.go`, `internal/dillad/dilladtest/**`, `cmd/dilla-testhost/**`, `protocol/09` § Voice | SRV-AFK |
  | `internal/dillad/routes.go` | SRV-AFK → WEB-AUTH (the `NewInvites` line :125 only) |
  | `internal/api/channels.go`, `protocol/09` § Channels | SRV-CAT → SRV-AFK (SRV-AFK rebases on SRV-CAT; SRV-CAT's edits are the parent check and the list, SRV-AFK's the delete and patch refusals and nothing else in that file) |
  | `packages/client-core/src/http/routes.ts`, `state/settings.ts`, `admin/perm.ts`, `admin/controller.ts`, `worker/world.ts` | CORE-AFK only |
  | `packages/client-core/src/state/types.ts`, `worker/protocol.ts`, `worker/controller.ts` | CORE-AFK → WEB-AFK (deletes the deprecated AFK members only; pre-flight P-18) |
  | `packages/web/src/strings/**`, `docs/design/flows/{06,08,12,14}*` | T0 only |
  | `cmd/dillad/media.go`, `media_test.go`, `deploy/**` | OPS only |
  | `internal/api/invites.go`, `invites_test.go`, `invites_landing_escape_test.go`, `packages/web/src/screens/{Onboarding,SignIn}.tsx` | WEB-AUTH only |
  | `e2e/web/phone.spec.ts`, `e2e/web/support/app.ts` | WEB-HOME → WEB-LIST → WEB-PHONE → WEB-SET (each rebases) |
  | `e2e/web/keyboard.spec.ts` | WEB-HOME → WEB-LIST → WEB-SET |
  | `e2e/voice/support/voice.ts` | FX-RELOAD → WEB-LIST → WEB-DOCK → E-AFK (moves `audioOut`/`sendsNoAudio` in) |
  | `e2e/voice/join-muted.spec.ts` | E-AFK only (imports the moved helpers) |
  | `e2e/voice/reload.spec.ts` | FX-RELOAD only |
  | `e2e/scripts/shoot-docs.mjs` | WEB-HOME (the DMs tab and the rail tiles) → WEB-LIST → DOCS |
  | `e2e/playwright.web.config.ts` | E-AFK (firefox `testIgnore`, if the fake mic needs it) → E-GEO (the WebKit `testMatch` gains `layout`) → CI (verifies only) |
  | `e2e/ux/**` (new) | E-GEO → AUDIT-2 |
  | `protocol/07-versioning.md` | H1 only |
  | `.github/workflows/ci.yml`, `scripts/check-ci-workflow.mjs` | CI only |
  | `package.json` (root `test` script) | UI-1 (adds `check:css`) only |

- **String rules:**
  - New keys only in T0's files. A task that needs a missing key stops with NEEDS_CONTEXT.
  - Never add `signin.` (strings.test.ts:48 pins 34), `shell.` (:79 pins 177), `settings.|devices.|notify.|appearance.` (:65 pins 119), `voice.`, `nav.`, `admin.`, `factor*.` keys.
  - Controls and labels are lower case; titles, headings and bodies are sentence case (R19); no `!`; none of "secure", "safe", "protected", "encrypted", "E2EE", "MLS" or "end-to-end" outside `strings/privacy.ts` (`scripts/check-ui-copy.mjs` FORBIDDEN).
  - Go refusal details (R2, R3, R41) are English Go literals; the client maps by status and code, never by detail.
- **Design:**
  - Mesh tokens and packages/ui components only: mono type, hairlines, square tiles, bracket headers, accent green, keyboard-first, silent encryption. Discord's placement and behaviour, rendered in Mesh, never reskinned.
  - WCAG 2.2 AA. Tap targets in two tiers (R9): primary 44×44 on phone or coarse pointers; secondary ≥ 24×24 with 2.5.8 spacing.
  - Works at 360px, 390px, 844×390, 1024px, 1440px and 200 % zoom, in all three themes. No input auto-zoom on phones (`base.test.ts:9-11` `NO_ZOOM`).
  - A phone-only rule is a `[data-layout="phone"]` selector, never a new `@media` (the phone-query count stays 10).
- **Contracts carried** (name them in every web and ui brief):
  1. ConfirmDialog error and busy go in one update.
  2. Every dialog and sheet returns focus to its opener.
  3. Dialogs stop Escape at themselves.
  4. `announce` is a required prop.
  5. FakeClient publishes before it resolves.
  6. A once-per-ready step is re-armed on re-ready.
  7. Every seeded fixture is reachable from the shipping client; reviews start from an empty instance.
  8. **DOM changes this wave only where a task names it.** Everything else stays byte-identical.
- **Media.** The E2EE frame path (`packages/web/src/call/**` except `session.ts`, and the media worker) is untouched. Media keys reach a device only through MLS; the AFK call is an ordinary call group whose members are `channel_members`.
- **Server-owned behaviour:** client gates are advisory; refusals are mapped by status and code, never by detail text.
- **Test-first:** every behaviour, guard, CSS pin and e2e assertion is shown red first, and the red run is recorded. A control or regression pin that is green from the start is reported as "guard, green at start", with the reason it cannot be red.
- **Proving checks:** never write a mutation that disables an authorisation check. Every refusal row has a control row that differs in one input and succeeds.
- **Rebuild before any local e2e:** `cargo build -p dilla-testkit --release --locked`; `bash core/dilla-core-wasm/build-wasm-pkg.sh`; `npm run build -w @dilla/web`; `npm run build:harness -w @dilla/client-core`; `go build -o target/dilla-testhost ./cmd/dilla-testhost`.
- **Every lane runs its project's whole e2e suite before integration** (web or voice, chromium and firefox), not only its own specs (web3.8 lesson). Every Go pick runs `golangci-lint run ./...`.
- **Harness:** single plain commands only; anything longer goes in a scratchpad script. `grep` is ugrep here: quote globs (`--include='*.css'`).
- **Commits:** `git commit -s -F <file>`; every message body ends with exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01XLFud8eoDaqf8uiZq5wjuP`
- **Process:** no subagents inside a task; no push, tag, merge or release inside a task; never a bare `git stash`. Anything the brief does not settle is NEEDS_CONTEXT.

## Review Focus

1. **No device ever publishes in AFK.** Not by a fresh token, a replayed `/rtc` admission, a role or overwrite change that re-pushes grants, a share lease, a resume, or the client's own mic. Expected: every grant in an AFK call is `PublishGrant(false,false,false)`; share is 403; the client never acquires a mic there.
   - Pinned in SRV-AFK: `TestAFKTokenIsListenOnly`, `TestAFKAdmitIsListenOnly`, `TestAFKRolePushStaysListenOnly` (a role grant of speak during an AFK call re-pushes listen-only, R34), `TestAFKShareIsRefused`, `TestAFKGrantFailsClosed`.
   - Pinned in VOICE-AFK: `session.test.ts` `a listen-only call never asks for the microphone`; in E-AFK: `afk.spec.ts` steps 4 and 5 (no outbound audio energy, the `join-muted.spec.ts:76-137` method).
2. **AFK cannot be deleted, re-kinded, opened up or locked down by any path**, including a concurrent delete, a category delete (its child is re-parented, still AFK), a community transfer and the overwrite routes. Expected: 403 with the R2 details, every control row passes.
   - Pinned in SRV-AFK: `TestAFKDeleteIsRefused` (+ control: an ordinary voice channel deletes), `TestAFKPatchRefusals` (topic, mode, visibility, slow mode; control: name, position, parent), `TestAFKDeleteRaceStaysRefused`, `TestAFKOverwriteRefused` (put and delete; control: another channel), `TestAFKSurvivesTransferAndCategoryDelete`.
3. **The backfill is exact and idempotent** on SQLite and Postgres: one new AFK per community, a web3.8 pointer moved with its timeout and its old channel left ordinary and joinable, a second start changes nothing, one community's failure does not stop the others, and a rollback leaves web3.8 reading the new pointer.
   - Pinned in SRV-AFK: `TestEnsureAFKChannels` table (no row; NULL pointer; web3.8 pointer with timeout 900 and a live call; already built-in), `TestEnsureAFKChannelsIsIdempotent`, `TestEnsureAFKChannelsSkipsAFailure`, both engines through G-go.
4. **A move cannot be forged or misdirected.** Only the sweep sets `afkPending`; `pending` is per calling device; another member's activity, settings write or snapshot read never moves anyone; the client joins only on its own `pending`, once, without a retry loop; a failed join shows the dock line.
   - Pinned in SRV-AFK: `TestAFKPendingIsPerDevice`, `TestAFKPendingClearsOnAnyJoin`, `TestAFKPendingExpires`, `TestAFKExemptBeforeAdmission`.
   - Pinned in VOICE-AFK: `useCall.test.tsx` `a pending move joins once and never loops`, `a failed AFK join shows the line and stops`.
5. **The layout grammar holds at every width.** One name x per list, one trailing-slot right edge, hairlines at y=48, no primary target under 44 on phone, nothing overflows at 1024 (C1), a collapsed category keeps its current and unread rows, and `/dm` deep links land on Home with `@` selected.
   - Pinned in E-GEO (`layout.spec.ts` rect checks at 1440, 1024, 390 and 360), UI-2 (`ChannelList.test.tsx` collapse cases), WEB-HOME (`router.test.tsx` `/dm` redirect) and AUDIT-2.
6. **Categories do not leak** (R44): a parent the caller cannot view is 404 on create and patch; the listing shows the child at the top level and not the category.
   - Pinned in SRV-CAT: `TestCreateUnderHiddenCategoryIsNotFound`, `TestPatchIntoHiddenCategoryIsNotFound`, `TestListingHidesAHiddenParent` (+ controls).

## Task map

| Task | Part | Phase | Lane | Impl. | Rev. | Depends on | Owns |
|---|---|---|---|---|---|---|---|
| T0 | all copy | P0 | wave | haiku | sonnet | — | `afk.`, `layout.`, `home.` strings; the R19/I4 value changes and their test and flow sites; flow 14; flows 06, 08 and 12 rows |
| SRV-CAT | D | P1 | srv2 | opus | opus | — | R44, protocol/09 § Channels |
| SRV-AFK | A | P1 | srv | opus | opus | T0, SRV-CAT integrated | R1–R5, R33–R35, R41, R42; backfill; testhost legacy hook; protocol/09 § Voice |
| OPS | D | P1 | ops | sonnet | sonnet | — | `PartOf`, `dillad media --rooms`, the `--probe` count, docs/deploy lines |
| VOICE-FIX | D | P1 | voice | opus | opus | — | the deferred-restart speech loss and the swap note |
| FX-RELOAD | D | P1 | e2e0 | opus | opus | — | the Firefox `reload.spec.ts:86` root cause |
| CORE-AFK | A, D | P1 | core | sonnet | **opus** | SRV-AFK's Interfaces (as written here; integration after SRV-AFK) | routes, `afk:` slice, perm mirror, positions, `channels.collapsed.`, `deviceCount` |
| UI-1 | B | P1 | ui | sonnet | sonnet | T0 | tokens, `IconButton`, `Tooltip`, `TrailingSlot`, `KeyHint` chip, focus ring, R16 check, R9 tier tests, icons |
| *controller: sketch round* | B | P1 | — | — | — | UI-1, UI-2's first commit | Storybook contact sheet to Jonas |
| UI-2 | B, C | P1 | ui | sonnet | sonnet | UI-1 | sidebar, rows, categories, rail, `@` tile; `SidebarTabs` deleted |
| UI-3 | B, C | P1 | ui-b | sonnet | sonnet | UI-1 | header, members, stage, tiles, dock, user panel |
| UI-4 | B, C | P1 | ui-c | sonnet | sonnet | UI-1 | message log, rows, tap-to-reveal, composer |
| UI-5 | B | P1 | ui-d | sonnet | sonnet | UI-1 | settings rows, keyboard table, admin channel rows, privacy rows, settings bar, search |
| VOICE-AFK | A | P2 | voice | opus | opus | CORE-AFK, VOICE-FIX | pending join, listen-only session, failure state |
| WEB-AFK | A | P2 | web | sonnet | **opus** | VOICE-AFK, UI-2 | Shell 1/6, OverviewSection, ChannelEditFlow, ChannelsSection |
| WEB-HOME | C | P2 | web | sonnet | sonnet | WEB-AFK, UI-2 | Shell 2/6, `@` tile, three phone tabs, `/dm` redirect, phone.spec rewrite (E-PHONE folded in) |
| WEB-LIST | B, C | P2 | web | sonnet | sonnet | WEB-HOME, UI-3 | Shell 3/6, categories, rail, header, members, one-click join |
| WEB-PHONE | B, C | P2 | web | sonnet | sonnet | WEB-LIST, UI-4 | Shell 4/6, H1–H8, phone stage, keyboard chrome, tap-to-reveal |
| WEB-SET | B | P2 | web | sonnet | sonnet | WEB-PHONE, UI-5 | Shell 5/6, settings and admin to S7, search |
| WEB-DOCK | C | P2 | web | sonnet | sonnet | WEB-SET, UI-3 | Shell 6/6, dock, Diagnostics link, speaking rings |
| WEB-AUTH | B | P2 | auth | sonnet | **opus** | UI-1 | invite page (L1, R43), L2, L3 |
| E-AFK | A | P3 | e2e | opus | opus | P2 | `e2e/web/afk.spec.ts` |
| E-GEO | B | P3 | e2e2 | sonnet | sonnet | P2 | `e2e/web/layout.spec.ts`, `e2e/ux/**` |
| H1 | A, D | P4 | wave | opus | opus | SRV-AFK, SRV-CAT | protocol/07 rows |
| CI | — | P4 | wave | sonnet | sonnet | P3 | ci.yml, check-ci-workflow |
| AUDIT-2 | B | P4 | wave | sonnet | **opus** | P3 | the audit re-run and its diff |
| *controller: contact sheets* | — | P4 | — | — | — | AUDIT-2 | the four widths to Jonas |
| DOCS | all | P4 | wave | sonnet | sonnet | contact sheets approved | README, docs/user, docs/deploy, screenshots |
| RELNOTES | all | P4 | wave | haiku | sonnet | DOCS | `docs/deploy/releases/v0.1.0-web3.9.md` |

27 tasks and two controller steps.

**Integration order:** T0 → SRV-CAT → SRV-AFK → OPS → VOICE-FIX → FX-RELOAD → CORE-AFK → UI-1 → UI-2 → UI-3 → UI-4 → UI-5 → VOICE-AFK → WEB-AFK → WEB-HOME → WEB-LIST → WEB-PHONE → WEB-SET → WEB-DOCK → WEB-AUTH → E-AFK → E-GEO → H1 → CI → AUDIT-2 → DOCS → RELNOTES.

**Parallelism:** P1 runs up to ten lanes (srv, srv2, ops, core, voice, e2e0, ui, then ui-b/ui-c/ui-d after UI-1). UI-2…UI-5 touch disjoint component directories; `tokens.ts` and `icons.ts` are UI-1's alone. The WEB lane is serial because of `Shell.tsx`; WEB-AUTH runs beside it. E-AFK and E-GEO run in parallel lanes.

**Report contract (every task):** `git diff --stat`; every red run (the command and its failing assertion), then green, or "guard, green at start" with the reason; each mutation and the test that caught it; every gate command with its result; every anchor that moved (old → new); every NEEDS_CONTEXT.

**Gate macros:** G-go, G-sqlc, G-docs, G-vectors, G-rust, G-tk, G-scenario, G-core, G-ui, G-web, G-e2e(spec), G-voice(spec) and G-e2e-all, exactly as defined in `2026-10-16-dilla-web-3-7.md` § Gate macros (:245-258). G-go here also runs `golangci-lint run ./...` (it covers gofmt and goimports, `.golangci.yml:97-100`). G-ui serialises `test:storybook:ci` (port 6006) across lanes. New in this wave: **G-css** = `npm run check:css` (UI-1).

---
## Phase 0

### Task T0: Strings, flow 14, and the casing pass

**Model:** haiku; reviewer sonnet. **Lane:** wave branch.

**Files:**
- Create:
  - `packages/web/src/strings/afk.ts`
  - `packages/web/src/strings/layout.ts`
  - `packages/web/src/strings/home.ts`
  - `packages/web/src/strings/strings.flow14.test.ts`
  - `docs/design/flows/14-layout-grammar-and-afk.md`
- Modify:
  - `packages/web/src/strings/en.ts`: imports beside :3-27 and spreads after `...stage,` (:53); the R19/I4 values at :560 (`settings.voice.automatic`), :561 (`automaticBeta`), :563 (`lightweight`), :564 (`off`), :584 (`test`), :585 (`testStop`), :586 (`testClose`);
  - `packages/web/src/strings/admin.ts:100` (`admin.invites.create`);
  - the tests that name the old values: `screens/settings/Voice.test.tsx:54,145,147`, `screens/settings/Voice.beta.test.tsx:22,28,30`, `screens/ShellCreate.test.tsx:260`; then `grep -rn "'Automatic'\|'Lightweight'\|'Off'\|Test microphone\|Stop recording\|Close and discard\|'Make link'" packages e2e docs/design/flows` and update every literal hit outside comments (e2e comments at `e2e/web/support/app.ts:594`, `e2e/scripts/shoot-docs.mjs:604`, `e2e/voice/noise-beta.spec.ts:19` and `enhanced-noise.spec.ts:10` are prose: leave them);
  - `docs/design/flows/08-server-admin.md:182` (`admin.invites.create='make link'`) and its AFK rows (the picker becomes "the built-in AFK channel; one inactive-timeout row", flow 14);
  - `docs/design/flows/06-voice.md`: its AFK States rows say "replaced in v0.1.0-web3.9: the AFK channel is an ordinary voice view, muted (flow 14)"; its Copy keeps `voice.afk.*` with the note "unused since web3.9" outside the backticked pairs;
  - `docs/design/flows/12-phone-shell.md`: the tab rows say "replaced in v0.1.0-web3.9: Home, Activity, You, with DMs as the `@` tile (flow 14)".

- [ ] **Step 1. Red first.**
  - Copy `strings.flow13.test.ts` to `strings.flow14.test.ts`: describe `'flow 14 (v0.1.0-web3.9, layout grammar, Discord layout and the built-in AFK channel)'`, doc path `docs/design/flows/14-layout-grammar-and-afk.md`, prefix regex `/^(afk|layout|home)\./`, `pairs.length` 25, States minimum 20, the `stage.screen` U+2019 lines replaced by the same pin on `afk.channel.note` (code point at index 15 is `0x2019`), and the section checks: Keyboard map contains `` `aria-expanded` `` and `Ctrl+End`; States contains `listen-only`; Announcements contains `Moved to`.
  - `LOWER` = `['afk.timeout.label', 'afk.moved.join', 'layout.dock.connected', 'layout.members.online', 'layout.members.offline', 'layout.log.jump', 'layout.log.today', 'layout.log.yesterday', 'layout.header.more', 'layout.category.add', 'layout.rail.add', 'home.tab']`, length 12.
  - Change the I4 test assertions to the new values.
  - Run `npx vitest run --root packages/web src/strings src/screens/settings src/screens/ShellCreate.test.tsx` and record the failures.
- [ ] **Step 2. Values (byte-exact):**
  ```
  afk.timeout.label='inactive timeout'
  afk.timeout.60='1 minute'
  afk.timeout.300='5 minutes'
  afk.timeout.900='15 minutes'
  afk.timeout.1800='30 minutes'
  afk.timeout.3600='1 hour'
  afk.timeout.hint='Members idle in voice this long move to {channel} and are muted. Phones are not moved.'
  afk.channel.note='This is the server’s AFK channel. Everyone in it is muted.'
  afk.stage.muted='Everyone is muted in {channel}'
  afk.moved='Moved to {channel} for inactivity'
  afk.moved.join='join'
  layout.dock.connected='voice connected'
  layout.dock.where='{channel} · {server}'
  layout.members.online='online — {n}'
  layout.members.offline='offline — {n}'
  layout.log.older='viewing older messages'
  layout.log.jump='jump to present'
  layout.log.today='today'
  layout.log.yesterday='yesterday'
  layout.header.more='more'
  layout.category.add='new channel in {name}'
  layout.rail.add='add a server'
  home.tile='direct messages'
  home.tileLabel='direct messages, unread {unread}, mentions {mentions}'
  home.tab='home'
  ```
  The apostrophe in `afk.channel.note` is U+2019; the dash in the two member keys is U+2014; the dot in `layout.dock.where` is U+00B7.

  R19/I4 value changes:
  ```
  settings.voice.automatic='automatic'
  settings.voice.automaticBeta='automatic (beta)'
  settings.voice.lightweight='lightweight'
  settings.voice.off='off'
  settings.voice.test='test microphone'
  settings.voice.testStop='stop recording'
  settings.voice.testClose='close and discard'
  admin.invites.create='make link'
  ```
  Nothing is removed. `voice.afk.*` and `admin.afk.*` stay in en.ts (R38).
- [ ] **Step 3. Flow 14, "Flow 14: layout grammar, Discord layout and the built-in AFK channel (v0.1.0-web3.9)":**
  - **`## States`, at least 20 rows:**
    1. a new server: the channel list shows `AFK` last, with the voice glyph;
    2. the AFK channel renamed and moved into a category;
    3. idle in voice on desktop: the device leaves its call and joins the AFK call listen-only; every tile and row shows `mic-off`; the stage header reads `afk.stage.muted`;
    4. the AFK join failed: the dock line `afk.moved` with `afk.moved.join`;
    5. a phone in voice: never moved;
    6. server settings → overview: one `afk.timeout.label` row with the five `afk.timeout.*` options and `afk.timeout.hint`, inside the overview's one save footer;
    7. channel settings of the AFK channel: name and category only, plus `afk.channel.note`; server settings → channels: no delete on the AFK row;
    8. the rail: the `@` tile (`home.tile`, `home.tileLabel`), a hairline, the servers, one dashed "+" tile (`layout.rail.add`) with its two-choice menu;
    9. `@` selected on desktop: the DM list in the sidebar;
    10. a server with categories: 32px category headers, one collapsed (`aria-expanded="false"`) keeping its current and unread rows, the trailing "+" (`layout.category.add`) for managers;
    11. a voice row: one click joins on desktop; the trailing join icon (`voice.join`); participants with 24px avatars, the speaking ring and the mute and deafen glyphs in the slot;
    12. the dock: `layout.dock.connected` over `layout.dock.where`, then camera, share and leave; no meter;
    13. the header at 1440 with the icon cluster, and below 36rem with pins and threads folded into `layout.header.more`;
    14. the members aside: hoisted roles, `layout.members.online`, `layout.members.offline` dimmed, two-line rows;
    15. the message log: grouping within 7 minutes, the date divider (`layout.log.today`, `layout.log.yesterday`, else the day), and `layout.log.older` with `layout.log.jump`;
    16. the phone: tabs Home (`home.tab`), Activity, You; `/dm` lands on Home with `@` selected;
    17. the phone: a 48 PhoneHeader on each tab root with its lone actions;
    18. the phone: typing with the call up shows a dot after the title instead of the call bar;
    19. the phone: tap a message to reveal its toolbar; a second tap, Escape or a scroll hides it;
    20. a tooltip on hover (400 ms) and on focus (at once), with its KeyHint chord, dismissed by Escape.
  - **`## Keyboard map`:** category header: Enter or Space toggles, `aria-expanded` follows; the rail: ArrowUp/ArrowDown move, the `@` tile is first; a voice row: Enter opens it, the trailing join icon is its own stop and joins; the message log: `Ctrl+End` jumps to present; a phone message row: Enter reveals its toolbar, Escape hides it; a tooltip: Escape dismisses it without moving focus.
  - **`## Focus rules`:** joining from the trailing icon keeps focus on it; the AFK move does not move focus; collapsing a category keeps focus on its header; the `@` tile keeps focus when the sidebar swaps to DMs.
  - **`## Announcements`:** the AFK move announces `afk.moved` with the channel's name, once; a failed AFK join announces the same line; nothing else new.
  - **`## Copy`:** the 25 pairs above, each as `` `key='value'` ``.
- [ ] **Gates:** G-web; `npm run check:docs`; `npm run check:copy`. **Commit:** `docs(flows): flow 14 and the copy for web3.9`.

---

## Phase 1: parallel lanes

Lanes: **SRV2** (SRV-CAT) ‖ **SRV** (SRV-AFK, after SRV-CAT integrates) ‖ **OPS** ‖ **VOICE** (VOICE-FIX) ‖ **E2E0** (FX-RELOAD) ‖ **CORE** (CORE-AFK) ‖ **UI** (UI-1 → UI-2) ‖ **UI-B** (UI-3) ‖ **UI-C** (UI-4) ‖ **UI-D** (UI-5).

### Task SRV-CAT: A channel's parent must be a category its author can see

**Model:** opus; reviewer opus. **Lane:** srv2. **Depends on:** —.

**Files:**
- Modify:
  - `internal/api/channels.go`:
    - `create` (:476-614): inside the `Tx` (:556-598), after `createGate` and before `validChannel` (:568), call `requireParentVisible(r.Context(), tx, s.UserID, row)`;
    - `patch` (:724-856): inside the `Tx` (:764-822), after the request is applied and before `validChannel` (:792), the same call when `req.ParentID != nil`;
    - `list` (:883-941): the loop at :917-929 no longer sets `visible[*ch.ParentID]`; the output loop at :931-940 writes `ParentID: nil` when `ch.ParentID != nil && !visible[*ch.ParentID]`. A category is listed only when the caller can view it.
  - `protocol/09-http-api.md` § Channels: the create and patch rows gain "`404 E_NOT_FOUND` when `parent_id` names a category the caller cannot view"; the list row says "a channel whose category the caller cannot view is listed with `parent_id` null; a category is listed only when the caller can view it".
- Create: `internal/api/channels_parent_test.go`.

**Interfaces:**
- `func requireParentVisible(ctx context.Context, repo store.Repository, uid id.ID, row store.ChannelRow) error`: nil when `row.ParentID == nil`; otherwise it loads the parent (`GetChannel`; not found falls through to `validChannel`'s own 400), resolves `NewResolver(repo).Resolve(ctx, uid, parent)` and returns `server.Errorf(server.CodeNotFound, "no such object")` when the bits lack `PermViewChannel`.

- [ ] **Step 1: write the failing tests** (`channels_parent_test.go`, both engines through the existing harness):
  - `TestCreateUnderHiddenCategoryIsNotFound`: a moderator holding manage channels, and a category whose `@everyone` overwrite denies view and grants nothing to the moderator's role. A create naming it as parent gets `404 E_NOT_FOUND`. Control: the same create under a category the moderator can view gets 201.
  - `TestPatchIntoHiddenCategoryIsNotFound`: moving an existing channel into the hidden category gets 404; control: into a visible category, 204.
  - `TestListingHidesAHiddenParent`: as the S2 review probe (`S2-review.md:14`): the owner puts a channel the member can view under a category the member cannot view. The member's listing has the channel with `parent_id` null and no row for the category. Control: the owner's listing has both, with the parent set.
  - `TestTheOwnerMayParentAnywhere`: the owner (PermAll) creates under the hidden category: 201 (guard, green at start: the owner sees everything).
  - Run `go test ./internal/api/ -run 'HiddenCategory|HiddenParent|ParentAnywhere'` and record the reds.
- [ ] **Step 2: implement** the Interfaces above. No other file in internal/api changes.
- [ ] **Step 3: gates.** G-go on both engines (`golangci-lint run ./...` included), G-docs. **Commit:** `fix(api): a channel's category must be one its author can see, and the listing never reveals a hidden category`.

### Task SRV-AFK: The built-in AFK channel on the server

**Model:** opus; reviewer opus. **Lane:** srv (rebased on SRV-CAT). **Depends on:** T0 (flow 14 names the copy), SRV-CAT integrated (one file, `channels.go`).

**Files:**
- Modify:
  - `internal/api/communities.go`:
    - `create` (:212-301): inside the `Tx` (:255-290), after `PutRole` and before the community audit row, `createBuiltinAFK(ctx, tx, communityRow, now)`; after the commit (:291), `MaterialiseChannelMembers(afterCommit(r), c.repo, c.dsvc, afk, now)`, error logged as `channels.go:603-605` does;
    - `afkSettingsBody` (:98-102) stays for GET; `putAFKSettings` (:120-166) decodes `[]cbor.RawMessage` of length 1 (`[timeout]`) or 2 (`[channel_id, timeout]`, R2), drops the destination validation and live-call check (:137-158) and the `afkChannelLock` use (:144), and writes `SetCommunityAFK(row.ID, {ChannelID: <the stored built-in id>, TimeoutSeconds: t})`;
  - `internal/api/channels.go` (after SRV-CAT): `delete` — inside the `Tx`, after `lockManageable` (:973), `GetCommunityAFK` and the R2 refusal when the pointer is this row; the SET NULL block at :984-995 is deleted. `patch` — inside the `Tx`, after `lockManageable` (:766), the R2 refusal for Topic, Mode, Visibility or SlowmodeSeconds when the pointer is this row;
  - `internal/api/roles.go` `overwriteTarget` (:925): after it loads the channel, the R2 overwrite refusal when the channel is its community's AFK channel (it runs before and under the lock in both `putOverwrite` :1017 and `deleteOverwrite` :1098);
  - `internal/api/perm.go`: `Snapshot` (:74-80) gains `AFK bool`; `ResolveChannel` (:136-176) applies R35 before its final return; `LoadSnapshot` (:195-227) sets `AFK` when `channelID != nil` and `GetCommunityAFK(communityID).ChannelID` equals it;
  - `internal/api/private.go` `EligibleUsers` (:30-80): reads the pointer once and sets `AFK` on each snapshot it builds (:63);
  - `internal/api/calls.go`:
    - the `afk*` fields (:247-254): `afkConfigMu`, `afkConfigLocks`, `afkOccupied` and `afkOnline` go; `afkPending map[id.ID]afkPendingEntry` and `afkExempt map[id.ID]string` arrive;
    - `start` (:402-…): the `afkChannelLock` block (:409-415) and the `refuseAFK` call (:416-419) go;
    - `grantFor` (:1051-1057) and `admitGrant` (:1061-1066) take `ctx` and return listen-only when `h.inAFK(ctx, row)` (R3, R34); every caller passes its context (`calls.go:564`, `:1188`, `callshare.go:524`);
    - `AdmitRoom` (:1118-1189): the `refuseAFK` block at :1138-1144 goes;
    - `Admitted` (:1197-1214): deletes `afkPending[device]` before `trackAFKAdmission`;
  - `internal/api/callgrants.go:305-307`: `perm` is listen-only when `h.inAFK(ctx, row)` (R34);
  - `internal/api/callshare.go` `share` (:439-…): `403 E_FORBIDDEN` `nobody shares in the AFK channel` before any lease, when the call's channel is the AFK channel;
  - `internal/api/afk.go`:
    - types (:17-40): `afkOccupant` and `afkPerson` go; `afkSnapshot` becomes `[ChannelID *id.ID, TimeoutSeconds uint64, Retired []struct{} (always empty), Pending bool]`; `afkActivityBody` becomes `[ChannelID id.ID, Exempt bool (optional, cbor omitempty)]`;
    - `afkChannelLock` (:42-52), `refuseAFK` (:139-157), `afkManual` (:230-246) and `afkLeave` (:248-270) go;
    - `trackAFKAdmission` (:56-78): skips the AFK channel's own calls and an `afkExempt` device whose room matches (R5);
    - `WithAFKLive` (:82-85) becomes `WithAFKNotify(notify *StructureNotifier) *Calls`;
    - `registerAFK` (:87-92): `POST` and `DELETE /v1/communities/{id}/afk` answer R41's 404;
    - `afkSnapshot` (:159-184): R33's shape, after `ensureAFK` when the pointer is missing (R1);
    - `afkActivity` (:186-228): the optional `exempt` (R5);
    - `moveAFK` (:274-352): no occupancy map; after the cut, R33's pending entry and `ChangedTo`;
    - `SweepAFK` (:356-402): the occupant loop (:367-376) goes; pending entries past the TTL are deleted;
  - new in `afk.go`: `EnsureAFKChannels`, `createBuiltinAFK`, `ensureAFK`, `inAFK`, `afkPendingEntry`, `AFKBuiltinPosition`;
  - `internal/dillad/routes.go:116-117`: `calls.WithAFKNotify(notify)`, then `if n, err := api.EnsureAFKChannels(ctx, repo, p.delivery, clk, log); …` once, before `calls.Register(m)` (the composition root runs before any listener exists, for `dillad serve` and `dilla-testhost` alike);
  - `internal/dillad/dilladtest/host.go` (beside the control-only debug routes at :204-215): `POST /debug/afk/legacy` with JSON `{"community":"<hex>","channel":"<hex>"}` calls `SetCommunityAFK(community, {&channel, <stored timeout>})` and answers 204 — a web3.8 admin's pick, for E-AFK's upgrade case. Control listener only;
  - `protocol/09-http-api.md` § Voice, rows :846-851 and the "AFK lifecycle" bullet :853-864: rewritten to R1–R5, R33 and R41.
- Tests (new): `internal/api/afk_builtin_test.go`, `internal/api/afk_refusal_test.go`, `internal/api/afk_listen_test.go`, `internal/api/afk_pending_test.go`, `internal/dillad/dilladtest/afk_legacy_test.go`. Rewrite, do not drop: `internal/api/afk_move_test.go` and `afk_settings_test.go` (every case that uses a picked destination, the occupant list, `POST /afk` or `DELETE /afk` is rewritten to the built-in channel or to the 404).

**Interfaces:**
```go
// afk.go
const AFKBuiltinPosition = 1 << 30
const afkBuiltinName = "AFK"
const afkBuiltinDetail = "afk.builtin"
const afkPendingTTL = 10 * time.Minute
type afkPendingEntry struct{ community, channel id.ID; at time.Time }
// createBuiltinAFK writes the channel row (R1), its system audit row and the community_afk pointer
// (timeout kept, else 300) in tx. The caller holds the community row lock or created the community in tx.
func createBuiltinAFK(ctx context.Context, tx store.Repository, com store.CommunityRow, timeout uint64, now int64) (store.ChannelRow, error)
// EnsureAFKChannels backfills every live community that is not done (R1). Never inside a request.
func EnsureAFKChannels(ctx context.Context, repo store.Repository, dsvc DS, clk clock.Clock, log *slog.Logger) (int, error)
func (h *Calls) inAFK(ctx context.Context, row store.VoiceSessionRow) bool // R34: true on a read error
func (h *Calls) WithAFKNotify(n *StructureNotifier) *Calls
```
- Wire (protocol/09 § Voice):
  - `GET /v1/communities/{id}/afk/settings` → `200 [channel_id(bstr16), timeout_seconds(uint)]` (unchanged shape).
  - `PUT /v1/communities/{id}/afk/settings` ← `[timeout_seconds]` or `[channel_id, timeout_seconds]` (R2) → 204.
  - `GET /v1/communities/{id}/afk` → `200 [channel_id(bstr16|null), timeout_seconds(uint), [](always empty), pending(bool)]`.
  - `POST /v1/communities/{id}/afk/activity` ← `[channel_id]` or `[channel_id, exempt(bool)]` → 204.
  - `POST` and `DELETE /v1/communities/{id}/afk` → `404 E_NOT_FOUND` `retired in web3.9`.

- [ ] **Step 1: write the failing tests.** Every refusal has its control row.
  - `afk_builtin_test.go`:
    - `TestNewCommunityHasOneAFK`: `POST /v1/communities` → `ListChannels` has exactly one voice row named `AFK` at `AFKBuiltinPosition` with no overwrites; `GetCommunityAFK` names it with 300; the audit log has `channel.create` with a nil actor and detail `afk.builtin`; `ListChannelMembers` of it holds the creator.
    - `TestEnsureAFKChannels` (table; each row seeds through the store, then runs `EnsureAFKChannels`): no `community_afk` row; a NULL pointer; a web3.8 pointer at a voice channel `lounge` with timeout 900, two overwrites and a live call; an already built-in pointer. Expected: one new `AFK` in the first three, the pointer moved, timeout 900 kept in the third, `lounge` unchanged (name, overwrites, call row live) and joinable (`POST /v1/channels/{lounge}/call` is 200, not "AFK is a silent channel"); the fourth unchanged. The created count is 3.
    - `TestEnsureAFKChannelsIsIdempotent`: run twice; the second returns 0 and the channel count is unchanged.
    - `TestEnsureAFKChannelsSkipsAFailure`: a repository wrapper whose `CreateChannel` fails for one community id; the other communities get their AFK, the function returns the count of the rest and a nil error, and the failure is logged.
    - `TestEnsureAFKMaterialisesEveryMember`: a member whose only role denies `view_channel` community-wide is in `channel_members` of the new AFK.
    - `TestSnapshotEnsuresAMissingAFK`: a community whose pointer was nulled under the store; `GET /afk` creates it and answers its id.
  - `afk_refusal_test.go`:
    - `TestAFKDeleteIsRefused` (control: an ordinary voice channel deletes, 204);
    - `TestAFKDeleteRaceStaysRefused`: two concurrent deletes of the AFK channel; both 403 and the row stays live;
    - `TestAFKPatchRefusals` (table): topic, mode, visibility, slow mode each 403; controls: name 204, position 204, parent to a visible category 204, parent to a hidden category 404 (R44);
    - `TestAFKOverwriteRefused`: `PUT` and `DELETE` of a role and a user overwrite on AFK are 403; control: the same on `lounge` is 204;
    - `TestAFKSurvivesTransferAndCategoryDelete`: the AFK channel inside a category; deleting the category leaves AFK live at top level and still the pointer; a community transfer leaves the pointer unchanged;
    - `TestAFKSettingsBody` (table): `[300]` 204; `[<built-in id>, 900]` 204; `[<lounge id>, 300]` 400; `[null, 300]` 400; `[120]` 400; the stored pointer never changes.
    - `TestRetiredAFKRoutes`: `POST` and `DELETE /v1/communities/{id}/afk` are `404 E_NOT_FOUND`.
  - `afk_listen_test.go` (the fake SFU of the call tests):
    - `TestAFKViewAndConnectForEveryMember`: a member whose roles deny view and connect community-wide: `Resolve` on AFK has both bits and no others; on `lounge` they have nothing (control);
    - `TestAFKTokenIsListenOnly`: a member with speak, video and screen share joins AFK; the minted grant is `PublishGrant(false,false,false)`; control: the same member in `lounge` gets the mic;
    - `TestAFKAdmitIsListenOnly`: `AdmitRoom` for that device returns listen-only;
    - `TestAFKRolePushStaysListenOnly`: during an AFK call, granting the member a role with speak triggers the re-push (`callgrants.go`), which sends listen-only; control: in `lounge` it sends the mic;
    - `TestAFKShareIsRefused` (control: `lounge` share is 200);
    - `TestAFKGrantFailsClosed`: a repository whose `GetCommunityAFK` errors; the grant is listen-only.
  - `afk_pending_test.go`:
    - `TestAFKSweepMovesAndMarksPending`: a desktop device idle past 60 s in `lounge` is removed from its room, `GET /afk` from that device says `pending true`, from the same user's other device `false`, and the user's live connections got op 54 for the community;
    - `TestAFKPendingIsPerDevice`: another member's snapshot is `false`, and their activity reports never set anything;
    - `TestAFKPendingClearsOnAnyJoin`: an admission of that device into any room clears it;
    - `TestAFKPendingExpires`: the fake clock past 10 minutes clears it at the next sweep;
    - `TestAFKCallIsNotTracked`: a device admitted into the AFK call is never swept;
    - `TestAFKExemptIsNeverSwept`: a report `[lounge, true]` after the admission; the fake clock past the timeout; no removal;
    - `TestAFKExemptBeforeAdmission`: the exempt report before `Admitted`; still never swept; a later admission into another room is tracked again.
  - `afk_legacy_test.go`: `TestDebugAFKLegacyIsControlOnly` (the public listener answers 404; the control listener 204 and the pointer moves).
  - Run `go test ./internal/api/ ./internal/dillad/... -run 'AFK|Afk'` and record the reds.
- [ ] **Step 2: implement** the Files and Interfaces above. `afkDestination` (:112-137) keeps its checks; with R35 the view-and-connect test always passes for members.
- [ ] **Step 3: gates.** G-go on SQLite and Postgres (`DILLA_TEST_PG`), `golangci-lint run ./...`, G-sqlc (no change), G-docs, `go test -race ./internal/api/...`. Then the voice suite, because grants changed: G-voice on the whole `e2e/voice` project, chromium and firefox.
- [ ] **Mutations to record:** drop the `inAFK` term from the `callgrants.go` re-push → `TestAFKRolePushStaysListenOnly` red; drop the `Snapshot.AFK` set in `EligibleUsers` → `TestEnsureAFKMaterialisesEveryMember` red; remove the delete refusal → `TestAFKDeleteIsRefused` red.
- [ ] **Commit:** `feat(api): every server has a built-in, listen-only AFK channel`.

**Out of scope:** the client (CORE-AFK, VOICE-AFK, WEB-AFK) and protocol/07 (H1).

### Task OPS: The media unit stops with dilla, and `dillad media --rooms`

**Model:** sonnet; reviewer sonnet. **Lane:** ops. **Depends on:** —.

**Files:**
- Modify:
  - `deploy/dilla-media.service` [Unit] (:1-5): add `PartOf=dilla.service` after `Wants=network-online.target`;
  - `deploy/install.sh` `write_media_unit` (:476-515): the heredoc copy gains the same line; the upgrade path already runs `systemctl daemon-reload` after it (:635-637), so no change there (check, and say);
  - `cmd/dillad/media.go` (:21-46): a `--rooms` flag beside `--probe` (:23); the probe branch (:33-43) prints `media probe: ok, <n> live rooms` on success;
  - `cmd/dillad/media_test.go`;
  - `docs/deploy/README.md`: the systemd section names `PartOf=` and the `--rooms` verb.
  - `deploy/install_test.sh`: the media unit assertion gains the `PartOf=` line.

**Interfaces:**
- `dillad media --rooms --config=PATH`: needs `livekit.enabled` and `mode = "sidecar"` (same refusal as `--probe`, exit 78). For each room of `remote.Rooms` (sorted), one line `<room>\t<n> participants`, then the participants' identities indented by two spaces, sorted; an empty SFU prints `no live rooms`. Exit 0; `exit.Unavailable` when the sidecar does not answer within 20 s (as `--probe`).
- The two flags together are refused: `media: --probe and --rooms are exclusive` (exit `exit.Usage`).
- The interface used: `type roomLister interface { Rooms(ctx) ([]string, error) }` (:48-50) widens to also `Participants(ctx, room string) ([]*livekit.ParticipantInfo, error)` (`internal/sfu/remote.go:42`).

- [ ] **Step 1: red tests** (`media_test.go`, a fake lister): two rooms with 2 and 0 participants print the exact lines; no rooms prints `no live rooms`; `--probe --rooms` exits with usage; the probe success line names the count. `install_test.sh` greps `PartOf=dilla.service` in both the shipped unit and the one install.sh writes. Run `go test ./cmd/dillad/ -run Media` and `npm run test:install`; record.
- [ ] **Step 2: implement.**
- [ ] **Step 3: gates.** G-go on SQLite, `npm run test:install`, `bash -n deploy/install.sh`, `go test ./deploy/...`. **Commit:** `feat(dillad): the media sidecar stops with dilla, and media --rooms lists live rooms`.

### Task VOICE-FIX: No speech lost after a deferred restart

**Model:** opus; reviewer opus. **Lane:** voice. **Depends on:** —.

**Context:** web3.8 MUTE R2 parks a capture restart while the mic must not send (`packages/web/src/call/session.ts:739-747`) and runs it on the next open (`applyMic`, :828-831). LiveKit's `restartTrack` stops the old capture before `getUserMedia` resolves, so the first ~100–300 ms after the unmute or the first PTT key-down are lost (`WS6-security-review.md:228`). A second note (:229): during that restart a mute can put the new, enabled capture on the sender for a few ms, because LiveKit calls `replaceTrack` before `enabled = !isMuted`.

**Files:** `packages/web/src/call/session.ts` (:297 `LocalPub`, whose `track` type gains `replaceTrack?(track: MediaStreamTrack, userProvidedTrack?: boolean): Promise<unknown>`; :739-760 `browserStatus`; :818-836 `applyMic`; :839-847 `restartOwnMeter`), `packages/web/src/call/session.test.ts`.

**Interfaces:**
- The parked restart is a **pre-acquire**, not a stop-then-get: when `applyMic` opens with `restartWaiting` set, it calls `deps.media.getUserMedia` (the session's capture dependency, `session.ts:210`) for the wanted constraints first, guards the new track with `guardMic` (so `enabled` is false until `sendNow()`), then hands it over with `micPub.track.replaceTrack(newTrack)` (LiveKit `LocalAudioTrack.replaceTrack(track, userProvidedTrack=true)`), and stops the old capture only after the replace resolves. The old capture keeps sending until then, so no speech is lost.
- The swap note: because the new track is guarded before it reaches the sender, the few-ms window of `:229` closes. The end state stays disabled when the mic must not send.
- If the pre-acquire fails, the old capture stays, `restartWaiting` is cleared, and `browserStatus` reports the unknown state as today; no retry loop.

- [ ] **Step 1: red tests** (`session.test.ts`, fake LiveKit track and fake `getUserMedia`, fake timers):
  - `a deferred restart keeps the old capture until the new one is on the sender`: mute, trigger the deferral, unmute; the call order is `getUserMedia` → `replaceTrack(new)` → `old.stop()`, and no `restartTrack` call;
  - `the pre-acquired track is guarded before it reaches the sender`: at the moment `replaceTrack` is called, `new.enabled === false` when muted again before the replace resolves;
  - `a failed pre-acquire keeps the old capture and does not loop`: `getUserMedia` rejects once; the old track is not stopped, and `getUserMedia` was called once after two more `applyMic` opens;
  - the existing R2 deferral test and the MUTE mutation R2b (`MUTE-report.md:114`, :124) stay green.
- [ ] **Step 2: implement.**
- [ ] **Step 3: gates.** G-web; `npx eslint --max-warnings 0 packages/web/src/call`; G-voice(join-muted.spec.ts controls.spec.ts noise-beta.spec.ts enhanced-noise.spec.ts) chromium and firefox, then the whole voice project. `git diff --stat -- packages/web/src/call` lists only `session.ts` and `session.test.ts`.
- [ ] **Commit:** `fix(web): a deferred microphone restart hands over without losing the first words`.

### Task FX-RELOAD: Why Firefox's reload.spec misses the sweep

**Model:** opus; reviewer opus. **Lane:** e2e0. **Depends on:** —. **Method:** superpowers:systematic-debugging; the root cause first.

**Context:** PR #36, run 39393759704, Firefox: `e2e/voice/reload.spec.ts:86` (`'the reloaded page sweeps the call it left behind'`, a poll of GET `/v1/channels/{id}/call` reads with `SWEEP_BOUND = 30_000`, :19) never saw a read. It passed on PR #35 and main. Step 3 (:77-89) holds back `participant_left` (`withholdLeft(true)`, :80), so only the boot-time stale-call leave (web3.7 3a-client) can remove alice's device.

**Files:** `e2e/voice/reload.spec.ts`, and whichever product file the cause is in (the boot sweep in `packages/client-core` or `packages/web/src/screens/voice/useCall.tsx`); `e2e/voice/support/voice.ts` only for a diagnostic helper.

- [ ] **Step 1. Reproduce.** `npm run test:e2e:voice:firefox -w @dilla/e2e -- reload.spec.ts --repeat-each=20 --trace=on`. Record the pass count. Pull the CI trace of run 39393759704 (`gh run download 39393759704 -n browser-web-results-firefox`) and put its timeline (the reload, `expectShellReady`, the first call read or its absence, `withholdLeft`) in the report.
- [ ] **Step 2. Find the cause.** Candidates to confirm or rule out, each with evidence:
  - the reads are counted by a `page.on('request')` listener attached before the reload (:82-83): Firefox may issue the read from the worker before the page's listener is bound to the new document;
  - the boot sweep is gated on a slice that arrives later in Firefox (the call slice or ready);
  - the sweep runs but uses a different path (`POST …/leave` without a GET read).
  If the cause is the test's instrument, the fix is the instrument (for example `context.on('request')` or a route on the context). If it is the product, the fix is the product and a unit test pins it.
- [ ] **Step 3. Fix the cause, not the bound.** `SWEEP_BOUND` and every timeout stay; a loosened wait needs the controller's ruling (NEEDS_CONTEXT).
- [ ] **Step 4.** `--repeat-each=20` green on Firefox, and on Chromium.
- [ ] **Gates:** G-voice(reload.spec.ts) chromium and firefox `--repeat-each=20`; the whole voice project on both. **Commit:** `fix(<scope>): <the cause>`, with the trace evidence in the body.

### Task CORE-AFK: The worker's AFK routes and slice, the perm mirror, and the device count

**Model:** sonnet; reviewer **opus** (the client half of the move flow). **Lane:** core. **Depends on:** SRV-AFK's Interfaces (as written in this plan); integrated after SRV-AFK.

**Files:**
- Modify:
  - `packages/client-core/src/http/routes.ts`: `AFKSnapshot` (:36-37), `AFKSettings` (:38), `getAFK` (:358-365), `setAFKSettings` (:370-373), `sendAFKActivity` (:374-377); delete `moveToAFK` (:378-381) and `leaveAFK` (:382-384);
  - `packages/client-core/src/state/types.ts:200-201` (`AFKState`);
  - `packages/client-core/src/worker/protocol.ts:66-70`;
  - `packages/client-core/src/worker/controller.ts`: the command lists (:232-236, :343-347, :409-413), the handlers (:1056-1064), `loadAFK` (:2706-2715), `setAFK` (:2717-2724), `createChannel` position (:2208-2211), `refreshDevices` (:2890-2913), `onReady` (:1549-1555);
  - `packages/client-core/src/admin/controller.ts:219-220` (the category position);
  - `packages/client-core/src/admin/perm.ts:98-122` (`channelBitsFrom`, `resolveChannel`, `channelBitsOf`);
  - `packages/client-core/src/state/settings.ts`: `SETTINGS` (:14-36), a prefix constant beside :44-55, `isSettingKey` (:62-71);
  - `packages/client-core/src/worker/world.ts:330-335` (the route mocks);
  - `packages/web/src/test/fake-client.ts:41-42, :242` (the slice and settings shapes).
- Tests: `http/routes.test.ts` (`CASES` :94-107), `worker/controller.test.ts`, `admin/perm.test.ts`, `state/settings.test.ts`.

**Interfaces:**
```ts
// routes.ts
export interface AFKSnapshot { channelId: Uint8Array | null; timeoutSeconds: number; pending: boolean }
export interface AFKSettings { channelId: Uint8Array | null; timeoutSeconds: number }
getAFK(communityId: Uint8Array): Promise<AFKSnapshot>              // parses [id|null, uint, array (ignored, bounded 1024), bool?]; a 3-element answer is pending false
setAFKSettings(communityId: Uint8Array, timeoutSeconds: number): Promise<void>   // PUT [timeout]
sendAFKActivity(communityId: Uint8Array, channelId: Uint8Array, exempt?: boolean): Promise<void> // [id] or [id, true]
// state/types.ts
export interface AFKState {
  channelId: string | null; timeoutSeconds: number; pending: boolean;
  /** @deprecated always empty since web3.9; WEB-AFK deletes it with its last reader. */ occupants: readonly { userId: string; deviceId: string }[];
}
// worker/protocol.ts
| { m: 'setAFK'; communityId: string; timeoutSeconds: number; /** @deprecated ignored; WEB-AFK removes it */ channelId?: string | null }
| { m: 'afkActivity'; communityId: string; channelId: string; exempt?: boolean }
| { m: 'afkMove'; communityId: string; channelId: string } // @deprecated: resolves null without a request; WEB-AFK deletes it
| { m: 'afkLeave'; communityId: string }                   // @deprecated: as afkMove
// admin/perm.ts
export function resolveChannel(input: PermInput, overwrites: readonly PermOverwrite[], userId: string, afk?: boolean): number
export function channelBitsOf(s: { …; afk?: boolean }, userId: string): number | null
// state/settings.ts
SETTINGS.channelCollapsed: (categoryHex: string) => `channels.collapsed.${categoryHex}`   // value '1'; absent = expanded (R36)
```
- The deprecated members keep `G-core`'s `typecheck -w @dilla/web` green until WEB-AFK, which deletes them together with their last callers in Shell and OverviewSection (the web3.8 pre-flight C-3 pattern).
- `resolveChannel` with `afk === true` mirrors R35: a member gets `bits | PERM.viewChannel | PERM.connect`.
- Positions: `createChannel` and the category create skip the channel whose id is `this.slices.get(`afk:${communityId}`)?.channelId` when they take `max(position) + 1` (R42).
- `deviceCount` counts devices with `revokedAt === null` (:2910), and `onReady` calls `refreshDevices()` once per ready (contract 6: re-armed on re-ready), so Diagnostics never reads 0 after load.

- [ ] **Step 1: write the failing tests.**
  - `routes.test.ts`: `getAFK` parses `[id, 300, [], true]` with `pending: true` and `[null, 300, []]` with `pending: false`; a 2-element answer is a decode error; `setAFKSettings` sends `[300]`; `sendAFKActivity` sends `[id]` and, with `exempt`, `[id, true]`; `moveToAFK` and `leaveAFK` no longer exist (a `@ts-expect-error` line).
  - `controller.test.ts`: the slice after a snapshot is `{ channelId, timeoutSeconds, pending, occupants: [] }`; op 54 reloads it (the existing case at :28 rewritten); `setAFK` sends only the timeout and refuses 120 with `E_BAD_INPUT`; `afkActivity` forwards `exempt`; `afkMove` and `afkLeave` resolve null and send no request; a new channel in a community whose AFK sits at 2³⁰ takes `max(other positions) + 1`; `devices` in diagnostics counts only live devices and is set after ready without a page command.
  - `perm.test.ts`: a member whose roles deny view gets exactly view|connect with `afk: true`, and 0 without it; the owner keeps all bits.
  - `settings.test.ts`: `channels.collapsed.<32 hex>` with `'1'` is a key and value; `channels.collapsed.x` and value `'2'` are refused.
  - Run `npm test -w @dilla/client-core` and record.
- [ ] **Step 2: implement.**
- [ ] **Step 3: gates.** G-core (its web typecheck stays green through the deprecated members); `npm run build:harness -w @dilla/client-core`; `npm run test:e2e:core -w @dilla/e2e` against a testhost built from the integrated SRV-AFK.
- [ ] **Commit:** `feat(client-core): the built-in AFK channel's routes and slice, the AFK grant mirror, and a live device count`.
### Task UI-1: Tokens, primitives and the two checks

**Model:** sonnet; reviewer sonnet. **Lane:** ui. **Depends on:** T0.

**Files:**
- Modify:
  - `packages/design-tokens/src/tokens.ts:86-91` (`layout`): `railW: '72px'`; add `railTile: '48px'`, `slotW: '32px'`, `rowH: '2rem'`, `rowHSub: '2rem'`, `rowH2: '2.75rem'`, `listGap: '0.125rem'`, `barH: '3rem'`. `channelHeaderH` stays (ChannelHeader's test pins it; UI-3 moves it to `--bar-h`);
  - `packages/design-tokens/src/css.test.ts:36` (`--rail-w: 72px`) and :47-52 (the new names); `tokens.test.ts:43` (`railW 72px`) and :54-64 (heights rem, widths px: `railTile`, `slotW` px; `rowH`, `rowHSub`, `rowH2`, `listGap`, `barH` rem); rebuild `dist/tokens.css` (`css.test.ts:60` compares it);
  - `packages/ui/src/styles/base.css`: the phone values `.d-app-shell[data-layout="phone"], [data-phone] { --row-h: 2.75rem; --row-h-sub: 2.25rem; --row-h-2: 3.25rem; --slot-w: 44px; --list-gap: 0rem; }`; the inset ring `[data-row]:focus-visible { outline-offset: -2px; }` (R18) after the global ring at :30; the phone/coarse 44 rule `.d-app-shell[data-layout="phone"] :is(.d-btn, .d-segmented__option, .d-icon-button) { min-height: 2.75rem; min-width: 2.75rem; }` (H4);
  - `packages/ui/src/styles/base.test.ts` (pins for the three rules);
  - `packages/ui/src/Button/Button.css`: the disabled accent is an outline, not a fill (I5): `.d-btn[data-variant="accent"]:disabled { background: transparent; color: var(--fg-3); box-shadow: inset 0 0 0 1px var(--hairline); }`;
  - `packages/ui/src/Segmented/Segmented.css` (only if the phone rule above needs a hook; say);
  - `packages/ui/src/KeyHint/KeyHint.css` (the chip: mono 11px, `--surface-hi`, hairline, radius 0);
  - `packages/ui/src/Avatar/Avatar.css` and `Avatar.tsx:12`: `size` gains `'xs'` (24px) and `'row'` (32px), so UI-2 and UI-3 never style an avatar themselves;
  - `packages/ui/src/Icon/icons.ts` (regenerated) and `Icon.test.tsx:8-11` (`SHELL_NAMES` gains the 11 names);
  - `packages/ui/src/index.ts`: exports for `IconButton`, `Tooltip`, `TrailingSlot`;
  - `packages/web/src/app.css:73` (`padding: var(--space-6)` → `padding: 1.5rem`) and `:184` (`outline: 2px solid var(--focus)` → `outline: var(--focus-ring)`): the two undefined tokens, after the check below is red on them;
  - root `package.json:16` (`test` chains `npm run check:css` after `check:copy`) and a script line `"check:css": "node scripts/check-css-vars.mjs"`, plus `"test:css-check": "node --test scripts/check-css-vars.test.mjs"`.
- Create:
  - `packages/ui/src/IconButton/{IconButton.tsx, IconButton.css, IconButton.test.tsx, IconButton.stories.tsx}`;
  - `packages/ui/src/Tooltip/{Tooltip.tsx, Tooltip.css, Tooltip.test.tsx, Tooltip.stories.tsx}`;
  - `packages/ui/src/TrailingSlot/{TrailingSlot.tsx, TrailingSlot.css, TrailingSlot.test.tsx}`;
  - `packages/ui/src/test/target-tiers.test.ts` (R9);
  - `scripts/check-css-vars.mjs`, `scripts/check-css-vars.test.mjs` (R16).

**Interfaces:**
```ts
// IconButton.tsx
export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & {
  icon: IconName; label: string;            // the accessible name and the tooltip text (R15: the name starts with it)
  size?: 28 | 32 | 40 | 44;                  // default 32; on a phone layout the hit area is 44 whatever the size
  pressed?: boolean;                         // aria-pressed; pressed draws the accent glyph and a 2px bottom bar (R27)
  keys?: string[];                           // the KeyHint chord shown in the tooltip, and `aria-keyshortcuts`
  tooltip?: boolean;                         // default true; false for a control whose label is visible beside it
};
// Tooltip.tsx — wraps exactly one focusable child
export type TooltipProps = { label: string; keys?: string[]; placement?: 'top' | 'bottom' | 'right'; children: ReactElement };
// TrailingSlot.tsx — the fixed trailing column of a list row (R13)
export function TrailingSlot(props: { children?: ReactNode }): JSX.Element // <span class="d-slot">, width var(--slot-w), flex: none, centred; empty is still reserved
```
- **Tooltip behaviour (R15):** `role="tooltip"`, mono 11px, `--surface-hi`, 1px hairline, radius 0; shows 400 ms after `pointerenter` and at once on `focus-visible`; hides on `pointerleave` after 100 ms unless the pointer is on the tooltip (hoverable, 1.4.13), on blur, and on Escape (consumed only while shown; focus stays). The KeyHint chord sits at the right. No tooltip when the pointer type is touch or `(hover: none)` matches. `aria-describedby` points at the chord's span only when `keys` is set (the label is already the name, so it is never read twice).
- **R16 check (`check-css-vars.mjs`):** collects every `--name:` declaration in `packages/design-tokens/dist/tokens.css` and in every `.css` under `packages/ui/src` and `packages/web/src`, and every `var(--name)` with no fallback in the same files. It exits 1 listing `file:line var(--name)` for each use whose name is never declared. A `var(--name, fallback)` is allowed (the JS-set properties such as `--d-sidebar-w` and `--d-vvh` always carry one).
- **R9 tier test (`target-tiers.test.ts`):** a CSS-text pin that the phone rules give `.d-btn`, `.d-segmented__option`, `.d-icon-button` and every row using `var(--row-h)` a 44px minimum, and that `--row-h-sub` (36px on phone) and the desktop `.d-icon-button[data-size="28"]` are at least 24px.

- [ ] **Step 0: vendor the icons.** Download `lock`, `log-out`, `shield`, `keyboard`, `monitor-smartphone`, `phone`, `square-pen`, `at-sign`, `pin`, `users`, `ellipsis`, plus every name already in the `icons.ts` header list and `LICENSE`, at Lucide tag `1.57.0` from `https://raw.githubusercontent.com/lucide-icons/lucide/1.57.0/icons/`, into a new empty scratchpad directory, and regenerate with `node packages/ui/scripts/vendor-icons.mjs 1.57.0 <LICENSE> packages/ui/src/Icon/icons.ts <name>.svg…` (`vendor-icons.mjs:5`; only path, rect, circle and line are allowed, :22). If `square-pen` is absent at 1.57.0, use the name the tag has and say so. A failed fetch is NEEDS_CONTEXT.
- [ ] **Step 1: write the failing tests.**
  - `css.test.ts` and `tokens.test.ts` with the new values (red until tokens.ts changes).
  - `check-css-vars.test.mjs`: a fixture with `var(--nope)` fails and names it; `var(--nope, 0)` passes; then run `npm run check:css` against the tree and record that it names exactly `packages/web/src/app.css:73 var(--space-6)` and `packages/web/src/app.css:184 var(--focus)`.
  - `IconButton.test.tsx`: the name is `label`; `pressed` sets `aria-pressed`; `keys` sets `aria-keyshortcuts`; `data-size` follows `size`; in a phone layout the computed min size is 44 (CSS-text pin).
  - `Tooltip.test.tsx` (fake timers): not shown at 399 ms after hover, shown at 400; shown at once on keyboard focus; Escape hides it and focus stays; a touch `pointerdown` never shows it; moving from the trigger onto the tooltip keeps it; `aria-describedby` names the chord only.
  - `TrailingSlot.test.tsx`: an empty slot keeps its width (CSS-text pin `width: var(--slot-w); flex: none`).
  - `target-tiers.test.ts` and `base.test.ts` pins.
  - Run `npm test -w @dilla/design-tokens`, `npm test -w packages/ui`, `npm run test:css-check`; record.
- [ ] **Step 2: implement.** Stories for IconButton (four sizes, pressed, with chord), Tooltip (hover and focus, the `play` checks the 400 ms and Escape) and TrailingSlot under `Primitives/`, plus an `IconButton` row under `Shell/` so the strict target-size axe covers it.
- [ ] **Step 3: gates.** G-ui; G-css; `npm test -w @dilla/design-tokens`; G-web (the two app.css lines). **Commit:** `feat(ui): row and bar tokens, icon buttons with tooltips, a trailing slot, and a check for undefined custom properties`.

### Controller step: sketch round (after UI-1 and UI-2's first commit)

Not a task. The controller builds Storybook from the ui lane and shoots one contact sheet, at desktop (1440 wide), 390 and 360, in mesh and light:
- channel rows: text, voice idle, voice live with participants, the AFK channel, a category collapsed and expanded, the unread tick, a mention pill, selected, keyboard focus;
- the rail with the `@` tile, the pill in its three heights, the merged "+" tile;
- the header at 1440 and 1024 (UI-3's story, when it exists; else noted as missing);
- the dock and the user panel without a meter;
- two-line member rows;
- tiles with the speaking ring and the volume chip.

The sheet goes to Jonas before any WEB task starts. His notes become fix rounds in the ui lanes; the WEB lane waits for his approval.

### Task UI-2: The sidebar, its rows and categories, and the rail with the `@` tile

**Model:** sonnet; reviewer sonnet. **Lane:** ui (after UI-1). **Depends on:** UI-1.

**Files:**
- Modify:
  - `packages/ui/src/ChannelRow/ChannelRow.tsx` (29 lines) and `ChannelRow.css` (14): one row grammar (R10–R14, R18): height `var(--row-h)`, margin `var(--list-gap) 0`, a 16px glyph column (`flex: none`; `#` centred text, the others 14–16px `Icon`s: `megaphone`, `volume-2`), the name (`min-width: 0; text-overflow: ellipsis`), the lock as a 12px `Icon name="lock"` after the name (A9: the 🔒 at :23 goes), then one `TrailingSlot` holding the mention pill, else the unread pill, else nothing; `data-row`; the selected mark (fill + 2px accent bar, R14) and the unread mark (bright name + a 4px edge tick at the left, no bold);
  - `packages/ui/src/VoiceChannelRow/VoiceChannelRow.tsx` (68) and `.css` (17): the same grammar; the count after the name (`harbour · 3`, R13); the trailing slot holds the join `IconButton` (`icon="phone"`, `labels.join`), or the connected glyph when `joined`, never both; participant rows (R25, A7) at `var(--row-h-sub)` indented to the name's x, each a 24px `Avatar size="xs"` with the speaking ring (`data-speaking` → `box-shadow: 0 0 0 2px var(--accent)`, square), the name, and the mute and deafen glyphs in the slot; one row per person;
  - `packages/ui/src/ChannelList/ChannelList.tsx` (137) and `.css` (44): props at :9-43 gain the category and AFK shapes below; renders uncategorised rows first, then each category's 32px header and children; the lone list-header "+" row (A1) goes; the header row is 48 (`var(--bar-h)`) with the title, then `headerAction`; `tabs` stays a prop until WEB-HOME deletes `SidebarTabs`;
  - `packages/ui/src/ChannelList/ChannelList.css.test.ts` (rewrite its pins to the new grammar), `VoiceChannelRow/VoiceChannelRow.css.test.ts`;
  - `packages/ui/src/CommunityRail/CommunityRail.tsx` (99) and `.css` (25): R20, R22, B3, B4: tiles `var(--rail-tile)` square at integer positions; the pill at the left edge, 8px tall for unread, 20 on hover, 40 for selected (replacing the 3px bar at :7); the edge `box-shadow: inset -1px 0 var(--hairline)` (B3) in place of `border-right`; the `@` tile first, then a hairline, then the servers; join and create merge into one dashed "+" tile (`layout.rail.add` via `addLabel`) opening an `ActionMenu` of the two existing actions; the captions (:75, :83) and their CSS (:17) go;
  - `packages/ui/src/index.ts` (append the new types).
- Do not delete `packages/ui/src/SidebarTabs/**`: Shell imports it until WEB-HOME, and G-ui runs the web typecheck. WEB-HOME deletes it.

**Interfaces:**
```ts
// ChannelList additions (all optional, so Shell compiles unchanged until WEB-LIST)
channels: readonly { …existing; parentId?: string | null; joined?: boolean; afk?: boolean }[];
categories?: readonly { id: string; name: string; collapsed: boolean }[];   // in display order
onToggleCategory?(id: string): void;
/** With it, a manager sees a trailing "+" on each category header, named addInCategoryLabel(name) (`layout.category.add`). */
onAddInCategory?(id: string): void; addInCategoryLabel?(name: string): string;
// a collapsed category still renders the rows whose id is activeId, whose unread or mentions are > 0, or that are joined (R23)
// CommunityRail additions
home?: { label: string; selected: boolean; unread: number; mentions: number; itemLabel: string; onSelect(): void }; // `home.tile`, `home.tileLabel`
addLabel?: string;   // with it the join and create tiles render as one "+" tile whose menu holds joinLabel and createLabel
// VoiceChannelRow
labels: { …existing; join: string };   // `voice.join`, the slot's icon button
onJoin?(): void;                         // the trailing icon; the row's own click stays onOpen (Shell decides R24 in WEB-LIST)
```
- Category header: a `<button aria-expanded>` row, 32px, micro uppercase label (`--text-micro`, `--label-tracking`), the `chevron-down` in the glyph column (rotated −90° when collapsed), the trailing "+" `IconButton` in the slot. It is a stop of the list's roving group.
- Name x: every row type's name starts at the same x (16px glyph column + gap), and participant rows indent so their avatar starts at that x (R11).

- [ ] **Step 1: write the failing tests.**
  - `ChannelList.test.tsx`: with categories `[raids (collapsed), lounge (expanded)]`, rows render as top-level, then `raids` header with only its active and unread children, then `lounge` with all; Enter on a header calls `onToggleCategory`; the header has `aria-expanded`; there is no list-header "+" row; the "+" on a header exists only with `onAddInCategory`.
  - `ChannelRow.test.tsx`: the slot shows the mention pill when both counts are set; the lock is an `svg` with the `voice.state`-style `role="img"` name `Private`; no 🔒 text node; `data-row` is present.
  - `VoiceChannelRow.test.tsx`: the count reads `harbour · 3`; joined shows the connected glyph and no join; a participant row has a 24px avatar, `data-speaking`, and the mute glyph in the slot; the slot holds one element.
  - `CommunityRail.test.tsx`: the `@` tile is first and named `home.tileLabel` filled; the "+" tile opens a menu with the two actions; no caption text; the pill has `data-pill="unread|hover|selected"`.
  - CSS pins (`ChannelList.css.test.ts`, `VoiceChannelRow.css.test.ts`, `CommunityRail.css`): `height: var(--row-h)`, the 16px glyph column `flex: none`, the slot, the inset ring, `box-shadow: inset -1px 0`, the tile `width: var(--rail-tile)`.
  - A story-play alignment test (`ChannelList.stories.tsx`, "Mixed"): every `.d-chrow__name`, `.d-voice-row__name` and category label has the same `getBoundingClientRect().left` (±0.5px), and every slot the same `right`.
  - Run `npm test -w packages/ui -- ChannelList ChannelRow VoiceChannelRow CommunityRail`; record.
- [ ] **Step 2: implement**, with stories in three themes: "Mixed" (text, announcement, voice idle and live, AFK, two categories), "Collapsed", "Unread and mention", and the rail with `@`, at desktop and phone.
- [ ] **Step 3: gates.** G-ui (strict target size on `Shell/` and `Voice/`); G-css. **First commit (for the sketch round):** `feat(ui): one row grammar for channels, voice and categories`. **Second commit:** `feat(ui): the rail at 72 with the @ tile and one add tile`.

### Task UI-3: Header, members, stage, dock and user panel

**Model:** sonnet; reviewer sonnet. **Lane:** ui-b. **Depends on:** UI-1.

**Files:**
- Modify:
  - `packages/ui/src/ChannelHeader/ChannelHeader.tsx` (46; props :6-15) and `.css` (17): height `var(--bar-h)` with its hairline at y=48 (R12, B1); the name `min-width: 8rem`, ellipsis; the megaphone its own flex item (C3); `actions` is a cluster of 32px `IconButton`s (R27, C1, C2); a new `overflow?: { label: string; items: ActionMenuItem[] }` prop: below a 36rem container width the caller's `foldable` actions move into one "⋯" `ActionMenu` (`layout.header.more`); `ChannelHeader.test.tsx:14` pins `var(--bar-h)` instead of `--channel-header-h`;
  - `packages/ui/src/MemberList/MemberList.tsx` (82; props :15-23) and `.css` (10): a 48 bar (`label` as its heading), sections in `groups` order with headers `role name — n`, `online — n`, `offline — n` (the offline rows at `--opacity-muted`); two-line rows at `var(--row-h-2)`: a 32px `Avatar size="row"` with the presence corner, the name on line 1, line 2 empty (reserved for a custom status), `data-row` (R28, F1);
  - `packages/ui/src/CallStage/CallStage.tsx` (195; props :20-39) and `.css` (81): `stageColumns` gains the orphan rule (D1): the last row is centred; at 1024 two columns where the formula allowed one only by a 16/9 tie (D2, the existing tie rule stays "fewer columns" otherwise); a `header?: ReactNode` slot rendered as the stage's 48 bar (C4) where the voice ChannelHeader goes; on phone an 18px gutter, centred avatars and the toolbar pinned (D4);
  - `packages/ui/src/CallTile/CallTile.tsx` (191; props :22-51) and `.css` (97): the speaking ring on the tile's avatar and on the tile edge (2px accent, R25), replacing the `StateDot` there; the volume range shows on hover and focus-within only (D3); a quiet chip `70 %` (mono, `--surface-hi`) when the volume is not 100, placed inside the caption row so it never covers the corner (the SHOTS card);
  - `packages/ui/src/VoiceDock/VoiceDock.tsx` (109; props :7-59) and `.css` (12): R26: line 1 `labels.connected` as a button (`onStatus`), line 2 `labels.where`; then camera, share and leave as 32px `IconButton`s in one row; the `meter` prop is removed from the render (the prop stays optional and ignored until WEB-DOCK deletes its last caller); no card: a hairline top and the panel's 12px inset (E1, E2);
  - `packages/ui/src/UserPanel/UserPanel.tsx` (63; props :8-26) and `.css` (30): its buttons are the same 32px `IconButton`s as the dock (E3); height 52, its top meeting the composer band (G3 is UI-4's half);
  - `packages/ui/src/AudioMeter/**`: unchanged (Settings → Voice keeps it); say so.
  - `packages/ui/src/index.ts` (append).

**Interfaces:**
```ts
// VoiceDock
labels: { …existing; where?: string };  // `layout.dock.where` filled by the caller ('{channel} · {server}')
onStatus?(): void;                        // with it, line 1 is a button (it opens Diagnostics, R26)
// ChannelHeader
actions?: ReactNode;                      // IconButtons; each child with data-foldable folds below 36rem
overflow?: { label: string; items: readonly ActionMenuItem[] };   // the "⋯" menu that holds the folded actions
// MemberList
groups: readonly MemberListGroup[];       // MemberListGroup gains kind: 'role' | 'online' | 'offline'
// CallStage
header?: ReactNode;
// CallTile
volume?: { value: number; …existing };    // chip text `${value} %` when value !== 100
```

- [ ] **Step 1: write the failing tests.**
  - `ChannelHeader.test.tsx`: at a 1024 container with the aside open (the C1 case, a container query test or a story-play at 1024), the name is visible and no action overflows; below 36rem the foldable actions are menu items of "⋯"; a pressed toggle has `aria-pressed` and the 2px bar; the megaphone is a sibling of the name, not inside it.
  - `MemberList.test.tsx`: three section headers with counts; an offline row is dimmed; a row is `var(--row-h-2)` with a 32px avatar; line 2 exists and is empty.
  - `CallStage.test.tsx`: `stageColumns` table gains `| 3 | 1200×700 | 2 |` with the orphan centred (`data-orphan` on the last tile), and `| 2 | 1024×600 | 2 |`; the `header` slot renders before the tiles.
  - `CallTile.test.tsx`: speaking draws the ring and no `StateDot`; the volume range is hidden until hover or focus; volume 70 shows the chip `70 %`; 100 shows none.
  - `VoiceDock.test.tsx`: no meter element even when `meter` is passed; the status is a button calling `onStatus`; camera, share and leave are 32px icon buttons with tooltips; no mute.
  - `UserPanel.test.tsx:127,131`: the 32px pins move to `.d-icon-button[data-size="32"]`.
  - Story-play: the header, members bar, sidebar head and stage header hairlines all at y=48 in the AppShell "Desktop" story (B1).
  - Run `npm test -w packages/ui -- ChannelHeader MemberList CallStage CallTile VoiceDock UserPanel`; record.
- [ ] **Step 2: implement**, with stories: the header at 1440 and 1024 (with and without the aside), members with three sections, the stage at 3 and 5 tiles with a speaking ring and a 70 % chip, the dock and panel in a call.
- [ ] **Step 3: gates.** G-ui; G-css. **Commit:** `feat(ui): a 48px bar line, an icon header, two-line members, a fitted stage, and a dock without a meter`.

### Task UI-4: The message log, rows, tap-to-reveal and the composer

**Model:** sonnet; reviewer sonnet. **Lane:** ui-c. **Depends on:** UI-1.

**Files:**
- Modify:
  - `packages/ui/src/MessageLog/MessageLog.tsx` (77; props :5-12) and `.css` (4): date dividers (a mono hairline row with the day, `role="separator"` with `aria-label`), and a "viewing older messages · jump to present" bar (R29) when the caller says the log is not at the present; `Ctrl+End` calls `onJumpToPresent` from anywhere inside the log;
  - `packages/ui/src/MessageRow/MessageRow.tsx` (159; props :12-42) and `.css` (61): `grouped?: boolean` hides author and time and shows the time in the gutter on hover or focus-within (R29); `deviceTag?: 'always' | 'hover'` (G2: the `web` tag only on hover for web clients); on a phone (`[data-layout="phone"]`) the always-visible toolbar goes: `revealed?: boolean` shows it, and a tap on the row body or Enter on the focused row calls `onReveal` (R30). Desktop keeps its hover toolbar;
  - `packages/ui/src/MessageToolbar/**` (only if the reveal needs a class hook; say);
  - `packages/ui/src/Composer/Composer.tsx` (192; props :12-49) and `.css` (30): the visible label is hidden in both states (G1: `.d-sr-only`, the name stays), no height change on focus, and its top edge at the user panel's top (G3, a CSS pin against `--d-composer-band`);
  - `packages/ui/src/index.ts` (append).

**Interfaces:**
```ts
// MessageLog
dividers are children: export function DateDivider(p: { label: string }): JSX.Element  // exported
present?: { atPresent: boolean; olderLabel: string; jumpLabel: string; onJumpToPresent(): void };
// MessageRow
grouped?: boolean; deviceTag?: 'always' | 'hover';
revealed?: boolean; onReveal?(on: boolean): void;   // phone only; Escape and a second tap call onReveal(false)
```
- Grouping is the caller's decision (WEB-PHONE / WEB-LIST compute "same author within 7 minutes, no divider between"); UI-4 only renders it.

- [ ] **Step 1: write the failing tests.**
  - `MessageLog.test.tsx`: a `DateDivider` is a separator named by its label; with `present.atPresent === false` the bar shows both labels and `Ctrl+End` calls `onJumpToPresent`; at present there is no bar.
  - `MessageRow.test.tsx`: `grouped` hides the author and time text and keeps the time in the gutter (visible on focus); on a phone layout no toolbar is rendered until `revealed`; a click on the body calls `onReveal(true)`; Escape calls `onReveal(false)`; `deviceTag="hover"` hides the `web` tag until hover.
  - `Composer.test.tsx`: focusing the textarea changes no box height (CSS pin); the label is visually hidden and the textbox keeps its name.
  - Run `npm test -w packages/ui -- MessageLog MessageRow Composer`; record.
- [ ] **Step 2: implement**, with stories: a grouped log with a divider, the older-messages bar, a phone row revealed and hidden.
- [ ] **Step 3: gates.** G-ui; G-css. **Commit:** `feat(ui): grouped messages, date dividers, jump to present, and tap-to-reveal on phone`.

### Task UI-5: One settings grammar, the keyboard table, admin rows, privacy rows and search

**Model:** sonnet; reviewer sonnet. **Lane:** ui-d. **Depends on:** UI-1.

**Files:**
- Modify:
  - `packages/ui/src/SettingsRow/SettingsRow.tsx` (26; props :4-9) and `.css` (6): R17, I2: a two-column grid with a `16rem` control column, the label and hint left, hairlines between rows, `data-row`; on phone the label stacks over a full-width control (H5);
  - `packages/ui/src/SettingsFrame/SettingsFrame.tsx` (81; props :6-15) and its base.css block: one hairline at y=48 (I8: the two 1px-apart lines become one), a `footer?: ReactNode` rendered as a sticky save footer; on phone the title is not repeated (H5);
  - `packages/ui/src/SettingsNav/**`: 16px icons in the glyph column (`settings`, `shield`, `keyboard`, `monitor-smartphone`, `log-out`, `headphones`), names aligned;
  - `packages/ui/src/ManageList/**`: rows to R10 with icon actions in the trailing slot (I6: `square-pen` for edit, `x` for delete), the delete action omitted for a row with `fixed: true`;
  - `packages/ui/src/SearchPalette/SearchPalette.tsx` (56; props :5-17) and `.css` (15): on desktop a centred overlay of max 40rem over the app (J1), not a full replacement; on phone unchanged;
  - `packages/ui/src/index.ts` (append `KeyboardTable`, `SettingsFooter`).
- Create: `packages/ui/src/KeyboardTable/{KeyboardTable.tsx, .css, .test.tsx, .stories.tsx}` (I3): a two-column table, action on the left and the `KeyHint` chord on the right, with a caption.

**Interfaces:**
```ts
export type KeyboardTableProps = { caption: string; rows: readonly { action: string; keys: string[] }[] };
// SettingsFrame
footer?: ReactNode;   // the one sticky save footer of the section (R17, I5 with UI-1's disabled outline)
// ManageList rows
fixed?: boolean;      // no delete action (the AFK channel, R39)
```
- Privacy rows (I7): the per-member accent call to action becomes one ghost `Button` per row in the trailing slot and one accent action for the section; this is CSS and props of the existing `ManageList` use, not a new component.

- [ ] **Step 1: write the failing tests.** `SettingsRow.test.tsx` (the 16rem column pin; phone stacking pin); `SettingsFrame.test.tsx` (one hairline; the footer is sticky; the existing pins at :218-235 kept); `KeyboardTable.test.tsx` (a table with a caption, one row per action, the chord as `kbd`s); `ManageList.test.tsx` (a `fixed` row has no delete; icon actions are named); `SearchPalette.test.tsx` (desktop overlay keeps the shell in the DOM behind it; Escape returns focus to the opener). Run `npm test -w packages/ui -- SettingsRow SettingsFrame KeyboardTable ManageList SearchPalette`; record.
- [ ] **Step 2: implement**, with stories under `Settings/` (strict target size).
- [ ] **Step 3: gates.** G-ui; G-css. **Commit:** `feat(ui): one settings grammar, a keyboard table, icon actions in admin lists, and a search overlay`.
---

## Phase 2: web (Shell.tsx serialized in the WEB lane; WEB-AUTH beside it)

WEB lane order: VOICE-AFK (no Shell) → WEB-AFK → WEB-HOME → WEB-LIST → WEB-PHONE → WEB-SET → WEB-DOCK. The WEB lane starts only after Jonas approves the sketch round.

### Task VOICE-AFK: A pending move joins the AFK call, listen-only

**Model:** opus; reviewer opus. **Lane:** voice (after VOICE-FIX). **Depends on:** CORE-AFK integrated (the slice shape), VOICE-FIX.

**Files:**
- Modify:
  - `packages/web/src/call/session.ts`: `startPageCall(deps, target, opts)` (:313) takes `opts.listenOnly?: boolean`. With it, the mic is never acquired or published (the block :854-884 is skipped, so no permission prompt), `PageCallState` gains `listenOnly: boolean`, `mic` is `'listen'` (a new member of the union at :44, documented "the AFK channel: the call is listen-only by the server's grant"), `setMuted`/`setDeafened` keep working on playback only (deafen still mutes incoming audio; mute is a no-op that stays true), and the camera and share calls (`ensureShare`, :898-921) reject with `E_FORBIDDEN` before any request;
  - `packages/web/src/screens/voice/useCall.tsx`:
    - `UseCallOptions` (:177-193) gains `afk?: { channels: ReadonlySet<string>; pending: { communityId: string; channelId: string; name: string } | null }`;
    - `join` (:363-480) passes `listenOnly: true` when `afk.channels.has(id)`, and does not call `keepSelf` (:525-536) for a listen-only call, so leaving it restores the user's own `voice.self`;
    - an effect on `afk.pending`: when it turns non-null, it joins that channel once (a ref keyed by `communityId:channelId` that clears only when `pending` turns null), announces `afk.moved` filled with `name` through the existing `announce`, and never retries;
    - `CallView` (:124) gains `afkFailed: { channelId: string; name: string } | null`: set when that join rejects, cleared by the next join or leave;
    - the phase effect (:650-720): a `removed` phase while `afk.pending` names this call's community is silent (no error notice), because the move follows;
  - `packages/web/src/call/session.test.ts`, `packages/web/src/screens/voice/useCall.test.tsx`.
- Not this task: Shell passes `afk` in WEB-AFK; the dock line is rendered in WEB-AFK; the e2e pin of no outbound audio is E-AFK's.

**Interfaces:**
```ts
// session.ts
export interface PageCallOptions { …existing; listenOnly?: boolean }
export interface PageCallState { …existing; listenOnly: boolean; mic: 'ok' | 'denied' | 'missing' | 'failed' | 'listen' }
// useCall.tsx
interface UseCallOptions { …existing; afk?: { channels: ReadonlySet<string>; pending: { communityId: string; channelId: string; name: string } | null } }
interface CallView { …existing; afkFailed: { channelId: string; name: string } | null }
```

- [ ] **Step 1: write the failing tests.**
  - `session.test.ts`: `a listen-only call never asks for the microphone` (no `deps.media.getUserMedia` call, no `publishTrack`, `state.mic === 'listen'`); `camera and share are refused in a listen-only call`; `deafen still mutes playback in a listen-only call`.
  - `useCall.test.tsx`: `a pending move joins once and never loops` (pending set, the join resolves; pending set again with the same key does nothing; a new key joins again); `a failed AFK join shows the line and stops` (the join rejects; `afkFailed` is set; no second join without a new key); `joining the AFK channel by click is listen-only` (`afk.channels` has the id); `leaving the AFK call keeps voice.self` (no `setSetting voice.self` during or after the AFK call); `the cut before a move is silent` (phase `removed` with pending set shows no error notice); `the move is announced once`.
  - Run `npm test -w @dilla/web -- session useCall`; record.
- [ ] **Step 2: implement.**
- [ ] **Step 3: gates.** G-web; `npx eslint --max-warnings 0 packages/web/src/call packages/web/src/screens/voice`; G-voice on the whole voice project, chromium and firefox (nothing outside AFK may change). `git diff --stat -- packages/web/src/call` lists only `session.ts` and `session.test.ts`.
- [ ] **Commit:** `feat(web): an idle move joins the AFK call listen-only, once`.

### Task WEB-AFK: The AFK channel is an ordinary voice view (Shell 1/6)

**Model:** sonnet; reviewer **opus**. **Lane:** web. **Depends on:** VOICE-AFK, UI-2 integrated, the sketch round approved.

**Files:**
- Modify:
  - `packages/web/src/screens/Shell.tsx` (1742 lines):
    - :205-207: keep the `afk:` slices; `selfAFKCommunity` goes; derive `afkChannels` (the set of every listed community's `afk.channelId`) and `afkPending` (the first community whose slice has `pending`, with its channel's current name);
    - :425-426: pass `afk: { channels: afkChannels, pending: afkPending }` to `useCall`;
    - :427-432: the `afkSelf` effect goes;
    - :433-473: the activity effect sends `exempt: true` on its first report after each join (a ref keyed by `call.channelId`) when `phone || matchMedia('(pointer: coarse)').matches` (R5);
    - :890-897 and :898-907: `afkLeave` before `call.join` goes; both paths call `call.join(id)`;
    - :920-931: the AFK page goes; every voice channel renders `VoiceView`;
    - :955-971: the voice rows: `joined: call.channelId === c.id`, `held` no longer names the AFK channel, participants come from the voice slice as for any channel, and the AFK row passes `afk: true`;
    - the desktop `bottom` (:1638-1643): above the dock, when `call.afkFailed` is set, a one-line `Banner tone="info"` reading `afk.moved` with an action `afk.moved.join` that calls `call.join(afkFailed.channelId)`.
  - `packages/web/src/screens/voice/VoiceView.tsx`: in a listen-only call every participant's state includes `muted` (`voice.state.muted`, the `mic-off` glyph; there is no `voice.state.suppressed` key, see Pre-flight P-4), the stage title row shows `afk.stage.muted` filled with the channel's name, and the call controls render mic, camera and share disabled (`aria-disabled` with the existing `voice.why.*` text);
  - `packages/web/src/screens/admin/OverviewSection.tsx` (114): the AFK block (:90-111) becomes one `SettingsRow` labelled `afk.timeout.label`, a `Select` of the five `afk.timeout.*` options (the "1 minutes" bug at :99-101 goes) and the hint `afk.timeout.hint` filled with the AFK channel's current name; it shares the overview's one save footer with the name form (:79-88): one save button saves both, sending `setAFK { communityId, timeoutSeconds }` only when the timeout changed;
  - `packages/web/src/screens/admin/ChannelEditFlow.tsx` (88): for the AFK channel (R39) only the name and category fields, no topic, no slow mode (:82-83), no `ChannelPermissions` (:84-85), plus the line `afk.channel.note`;
  - `packages/web/src/screens/admin/ChannelsSection.tsx` (183): the AFK row has no delete (:97);
  - `packages/web/src/app.css:73`: the `.dw-afk-view` rule is deleted;
  - `packages/client-core/src/worker/protocol.ts`, `worker/controller.ts`, `state/types.ts`: delete the deprecated `afkMove`, `afkLeave`, `setAFK.channelId` and `AFKState.occupants` that CORE-AFK left (their last callers go in this task);
  - `packages/web/src/test/fake-client.ts:41-42, :242`.
- Tests to rewrite, not drop: `screens/voice/VoiceView.test.tsx:38-79` (the silent room, the move-out and the activity cases), `screens/admin/ServerSettings.test.tsx:105-116`, `screens/Shell.test.tsx:59`, `ChannelEditFlow.test.tsx`, `ChannelsSection.test.tsx`.

- [ ] **Step 1: write the failing tests.**
  - `Shell.test.tsx`: the AFK row is not held and has the voice glyph; a click joins it (desktop) and the session is listen-only; with `pending` in the slice, `call.join` is called with the AFK id once; the failure banner shows `afk.moved` and its button joins; no "Move to AFK" or "Leave AFK" exists anywhere.
  - `Shell.phone.test.tsx`: the first activity report after a join carries `exempt: true`, the second does not.
  - `VoiceView.test.tsx`: in the AFK call every tile and row shows the `muted` glyph, the stage shows `afk.stage.muted` with the current name, and mic, camera and share are `aria-disabled`.
  - `ServerSettings.test.tsx`: the overview has one timeout row with the five labels (`1 minute`, …, `1 hour`), no destination select, one save button; saving sends `setAFK { communityId, timeoutSeconds: 900 }` with no `channelId`.
  - `ChannelEditFlow.test.tsx`: the AFK channel's dialog has a name and a category field, the note, and no topic, slow mode or permissions; `ChannelsSection.test.tsx`: no delete button on the AFK row; a voice row still has one (control).
  - Run `npm test -w @dilla/web -- Shell VoiceView ServerSettings ChannelEditFlow ChannelsSection`; record.
- [ ] **Step 2: implement.**
- [ ] **Step 3: gates.** G-web; G-core (the deletions); G-ui; G-css; the whole `e2e/web` project and the whole `e2e/voice` project, chromium and firefox. **Commit:** `feat(web): the AFK channel is an ordinary, muted voice channel with one timeout setting`.

### Task WEB-HOME: The `@` Home tile and three phone tabs (Shell 2/6)

**Model:** sonnet; reviewer sonnet. **Lane:** web. **Depends on:** WEB-AFK, UI-2 integrated.

The wave plan's E-PHONE is folded in here: changing the tabs breaks `e2e/web/phone.spec.ts` at once.

**Files:**
- Modify:
  - `packages/web/src/layout.ts:76`: `export type PhoneTab = 'home' | 'activity' | 'you';`; `rememberedTab` (:87) maps a stored `servers` or `dms` to `home`;
  - `packages/web/src/router.ts`: `tabOf` (:172-179) maps root, welcome, channel, dm and dms to `home`; the `dms` route (:19, :68, :91) stays as "Home with `@` selected", so `/dm` deep links land there;
  - `packages/web/src/screens/Shell.tsx`:
    - the sidebar tab state (:94, :683-693, :1501) becomes `homeSelected = route is dm or dms` (desktop and phone);
    - `onDms` (:1000) is `homeSelected`;
    - the `tabs` prop of ChannelList (:1038-1043) and the `SidebarTabs` import (:5-6) go;
    - the rail (:1632-1636) passes `home={{ label: t('home.tile'), itemLabel: t('home.tileLabel', { unread, mentions }), selected: homeSelected, unread: dmCounts.unread, mentions: dmCounts.mentions, onSelect: () => navigate({ name: 'dms' }) }}`, and on phone the rail shows on the Home tab (`phoneTab === 'home'`);
    - the tab bar (:1343-1397): `tabRoot` (:1346) and the items (:1395) become `tabItem('home', 'server', homeCount)`, `tabItem('activity', …)`, `tabItem('you', …)`, label `home.tab`; the `dms` item goes;
  - `packages/web/src/strings/nav.ts` is not touched (`nav.tab.dms` stays unused; R38);
  - `packages/ui/src/SidebarTabs/**` and its two `index.ts` export lines are deleted (the last caller goes here);
  - `packages/web/src/app.css` only if a `.dw-*` rule names the sidebar tabs (grep, and say).
- Tests to rewrite, not drop: `Shell.test.tsx:1416, :1456-1469` (the "direct messages" tab cases → the `@` tile), `Shell.phone.test.tsx`, `ShellCreate.test.tsx`, `Shell.panel.test.tsx`, `ShellThreads.test.tsx`, `settings/Notifications.test.tsx`, `router.test.tsx`, `layout.test.ts`.
- e2e to rewrite, not drop: `e2e/web/phone.spec.ts`, `e2e/web/threads.spec.ts`, `e2e/web/search-settings.spec.ts`, `e2e/voice/phone-call.spec.ts`, `e2e/web/support/app.ts` (every `nav.tab.*` and `shell.tabs.*` locator; `grep -rn "nav.tab\|shell.tabs" e2e` and list each hit in the report), `e2e/scripts/shoot-docs.mjs` (`PHONE_SHOTS` :67 and the DMs-tab steps).

- [ ] **Step 1: write the failing tests.**
  - `router.test.tsx`: `/dm` parses to `dms` and `tabOf` gives `home`; `/activity` and `/you` unchanged.
  - `layout.test.ts`: a remembered `dms` or `servers` reads back as `home`.
  - `Shell.test.tsx`: no `role="tablist"` in the sidebar; the `@` tile is the rail's first item, named `home.tileLabel` with the DM counts; selecting it shows the DM list; selecting a server shows its channels; focus stays on the tile.
  - `Shell.phone.test.tsx`: the tab bar has exactly `home`, `activity`, `you`; Home shows the rail and the list pane; `@` shows DMs in the list pane.
  - `phone.spec.ts` (390×844 and 844×390): from an EMPTY host, the three tabs; `@` then a DM; a deep link `/dm` lands on Home with `@` selected; every tab target ≥ 44px; `expectAccessible`.
  - Run `npm test -w @dilla/web -- router layout Shell`; record.
- [ ] **Step 2: implement.**
- [ ] **Step 3: gates.** G-web; G-ui (SidebarTabs gone, the stories still build); the whole `e2e/web` project chromium and firefox; `phone.spec.ts` on webkit; `e2e/voice/phone-call.spec.ts` chromium and firefox; `npm run docs:shots -w @dilla/e2e` exits 0. **Commit:** `feat(web): direct messages live behind the @ tile, and phones get three tabs`.

### Task WEB-LIST: Categories, the rail, the header, members and one-click join (Shell 3/6)

**Model:** sonnet; reviewer sonnet. **Lane:** web. **Depends on:** WEB-HOME, UI-2 and UI-3 integrated.

**Files:**
- Modify:
  - `packages/web/src/screens/Shell.tsx`:
    - the ChannelList mount (:1026-1062): `categories` from the community's category rows (kind 2) in position order with `collapsed` from the `channels.collapsed.<id>` settings; `onToggleCategory` writes `setSetting` `'1'` or `null` (R36); `onAddInCategory` (managers) opens the create flow with that parent; channel rows carry `parentId`;
    - `listAction` (:1032-1035) goes (A1): with no categories, the "+" is an `IconButton` in the sidebar head beside the gear (`headerAction`, :1016-1025);
    - the voice rows: on desktop a row click opens the voice view and joins (`openVoice(id); call.join(id)`, R24); on phone a tap opens the voice view only; the trailing icon joins on both; participant rows carry `speaking` from `speakingDevices` (`VoiceView.tsx:410`);
    - the rail (:1632-1636): `addLabel={t('layout.rail.add')}` (one "+" tile; B4);
    - the header (:1191-1212): pins, threads, search, edit channel (`settings` icon, managers) and members become `IconButton`s, pins and threads `data-foldable`, with `overflow={{ label: t('layout.header.more'), items }}`; the DM header (:1213-1221) the same with pins and search;
    - the members aside (:1671-1673) is unchanged here; `MemberPane` changes below;
  - `packages/web/src/screens/admin/MemberPane.tsx` (115): groups hoisted roles first, then `layout.members.online` and `layout.members.offline` (from the presence slice), two-line rows (R28);
  - `packages/web/src/screens/voice/VoiceView.tsx` `Stage` (:299-330): the voice channel's `ChannelHeader` in CallStage's `header` slot (C4);
  - `packages/web/src/app.css` (the `.dw-channel-add` rule and the pins at `app-css.test.ts:56-58` follow the moved "+"; say which lines);
  - `e2e/web/support/app.ts`, `e2e/web/keyboard.spec.ts` (the header stops are icon buttons; the lap count changes, state the new count), `e2e/voice/support/voice.ts` (`voiceRow`, :299, follows the new row; `joinVoice`, :326, uses the trailing icon), `e2e/web/channel-list.spec.ts` and `e2e/web/sidebar-actions.spec.ts` (the "+" moved), `e2e/scripts/shoot-docs.mjs` (:575-578 the rail shot).
- Tests: `Shell.test.tsx`, `Shell.channellist.test.tsx`, `ShellCreate.test.tsx`, `MemberPane.test.tsx`, `VoiceView.test.tsx`.

- [ ] **Step 1: write the failing tests.**
  - `Shell.channellist.test.tsx`: two categories; collapsing one writes `setSetting channels.collapsed.<id> '1'` and keeps its active and unread rows; expanding writes `null`; a remount reads the setting back; a manager's category "+" opens the create flow with that parent; with no categories the "+" sits in the sidebar head.
  - `Shell.test.tsx`: on desktop a click on a voice row joins; on phone (`Shell.phone.test.tsx`) a tap opens without joining and the 44px join joins; the header actions are icon buttons named by their existing labels; at a 36rem main width pins and threads are items of "more".
  - `MemberPane.test.tsx`: a hoisted role section, then `online — 2`, then `offline — 1`.
  - Run `npm test -w @dilla/web -- Shell MemberPane VoiceView`; record.
- [ ] **Step 2: implement.**
- [ ] **Step 3: gates.** G-web; the whole `e2e/web` and `e2e/voice` projects, chromium and firefox. **Commit:** `feat(web): categories that collapse, one-click voice, an icon header and two-line members`.

### Task WEB-PHONE: The phone shell and the message log (Shell 4/6)

**Model:** sonnet; reviewer sonnet. **Lane:** web. **Depends on:** WEB-LIST, UI-4 integrated.

**Files:**
- Modify:
  - `packages/web/src/screens/Shell.tsx`:
    - H1: a 48 `PhoneHeader` on every tab root (Home with the server name or "direct messages", Activity, You), not only on voice (:1190);
    - H2: the lone actions move into the header: "+" new channel (managers), call (in a DM), new message (`square-pen`, on `@`), replacing the `dw-phone-footer` button (:1055-1061);
    - H3: while typing (AppShell's `typing`), the call bar (:1398-1410) is not rendered and the header title shows a 8px accent dot after the title, named by the existing call bar's label;
    - H7: the voice preview's join is 44 and its gutter 18;
  - `packages/web/src/screens/You.tsx`: the status is a 44 row (H6), not a native select;
  - `packages/web/src/screens/Activity.tsx`: the empty state sits in an `EmptyState` frame (H8);
  - `packages/web/src/screens/conversation/Conversation.tsx` and `MessageItem.tsx`: grouping (same author, within 7 minutes, no divider between, R29), `DateDivider`s (`layout.log.today`, `layout.log.yesterday`, else `formatDay`), the `present` bar (`layout.log.older`, `layout.log.jump`) when the log is scrolled away from the newest message, `deviceTag="hover"` for web clients (G2), and on phone the reveal state: one revealed row at a time, hidden by a second tap, Escape or a scroll of the log (R30);
  - `packages/web/src/layout.ts`, `router.ts`: only if H1's back targets need it (say);
  - `packages/web/src/app.css` (the phone footer rule goes; say which lines);
  - `e2e/web/phone.spec.ts`, `e2e/web/support/app.ts`.
- Tests: `Shell.phone.test.tsx`, `You.test.tsx`, `Activity.test.tsx`, `conversation/Conversation.test.tsx`, `conversation/MessageItem.test.tsx`.

- [ ] **Step 1: write the failing tests.**
  - `Conversation.test.tsx`: three messages from one author within 7 minutes render one author line; an 8-minute gap starts a new group; a day change renders a divider named `today` or `yesterday`; scrolled up, the present bar shows and `Ctrl+End` scrolls to the newest; a web client's tag is hover-only.
  - `MessageItem.test.tsx` (phone): no toolbar until a tap; a tap on another row moves the reveal; Escape hides it; a scroll hides it.
  - `Shell.phone.test.tsx`: each tab root has a 48 header with its actions; no `dw-phone-footer`; while typing the call bar is gone and the dot is in the header.
  - `phone.spec.ts`: at 390×844 with the keyboard (visualViewport) up, the composer and the header are visible and the call bar is not; a message's toolbar appears on tap.
  - Run `npm test -w @dilla/web -- Shell.phone You Activity Conversation MessageItem`; record.
- [ ] **Step 2: implement.**
- [ ] **Step 3: gates.** G-web; the whole `e2e/web` project chromium and firefox; `phone.spec.ts` on webkit; `e2e/voice/phone-call.spec.ts`. **Commit:** `feat(web): phone headers, the call dot while typing, grouped messages, and tap-to-reveal actions`.

### Task WEB-SET: Settings and admin in one grammar, and search (Shell 5/6)

**Model:** sonnet; reviewer sonnet. **Lane:** web. **Depends on:** WEB-PHONE, UI-5 integrated.

**Files:**
- Modify:
  - `packages/web/src/screens/Settings.tsx` and every section under `screens/settings/` (Appearance, Devices, Diagnostics, Notifications, Privacy, SignInFactors, SignOut, Voice): `SettingsRow` everywhere (I1, I2), one `SettingsFrame` footer where a section saves;
  - `packages/web/src/screens/settings/Keyboard.tsx` (12 lines; :7-12 is the bullet list): a `KeyboardTable` (I3) with the same four shortcuts;
  - `packages/web/src/screens/settings/Privacy.tsx` (36): the I7 rows;
  - `packages/web/src/screens/admin/{OverviewSection,ChannelsSection,RolesSection,InvitesSection,BansSection,DangerSection,ServerSettings}.tsx`: the S7 grammar; `ChannelsSection` rows use `ManageList` icon actions with `fixed` on the AFK row (R39, I6); the overview keeps WEB-AFK's single footer with I5's separation (a hairline between the name and the timeout rows);
  - `packages/web/src/screens/Search.tsx` (46) and its Shell mount (:1683-1689): the desktop overlay (J1);
  - `packages/web/src/screens/Shell.tsx` (the Search mount and the admin page mount :1711 only);
  - `e2e/web/support/app.ts`, `e2e/web/keyboard.spec.ts`, `e2e/web/search-settings.spec.ts`, `e2e/web/admin.spec.ts` (any locator that named the old layout).
- Tests: every `screens/settings/*.test.tsx` and `screens/admin/*.test.tsx` that the grammar touches, `Search.test.tsx`, `Settings.test.tsx`.

- [ ] **Step 1: write the failing tests.** Each settings section renders `SettingsRow`s (a `.d-settings-row` count per section in its test); Keyboard renders a table with a caption and four rows; the AFK row in channels has edit and no delete; desktop search keeps the shell in the DOM and returns focus on Escape. Run `npm test -w @dilla/web -- settings admin Search Settings`; record.
- [ ] **Step 2: implement.**
- [ ] **Step 3: gates.** G-web; the whole `e2e/web` project chromium and firefox. **Commit:** `feat(web): one settings grammar, a keyboard table, and search over the app`.

### Task WEB-DOCK: The dock as Discord's, and the rings (Shell 6/6)

**Model:** sonnet; reviewer sonnet. **Lane:** web. **Depends on:** WEB-SET, UI-3 integrated.

**Files:**
- Modify:
  - `packages/web/src/screens/voice/VoiceView.tsx` `Dock` (:463-511): no `meter` (:503-507: the `AudioMeter`, `PttLine` and `HearingLine` leave the dock; `PttLine` and `HearingLine` stay exported and are shown on the stage's status line instead); `labels.connected = t('layout.dock.connected')`, `labels.where = t('layout.dock.where', { channel, server })`; `onStatus` navigates to `{ name: 'settings', section: 'diagnostics', from: null }`;
  - `packages/web/src/screens/voice/VoiceView.tsx` `callTiles` (:74-102): the tile volume (`volume.value`) feeds the chip; speaking feeds the ring;
  - `packages/web/src/screens/Shell.tsx` (:1638-1643, the dock props only);
  - `packages/web/src/app.css` (the dock's card rules go; say which lines);
  - `packages/ui/src/VoiceDock/VoiceDock.tsx`: delete the ignored `meter` prop (its last caller goes here);
  - `e2e/voice/support/voice.ts` (`dock`, :318), `e2e/voice/controls.spec.ts` and any voice spec that reads the dock's meter or level text (grep `AudioMeter`, `settings.voice.level`, `dw-voice-dock`; list each hit).
- Tests: `VoiceView.test.tsx`, `Shell.panel.test.tsx`.

- [ ] **Step 1: write the failing tests.** The dock has no meter, no level text and no line; its status button reads `voice connected` and opens Diagnostics; the second line reads `harbour · Midgard Crew`; camera, share and leave are 32px icon buttons; a remote tile at volume 70 shows `70 %`; a speaking participant has the ring in the list and on the tile and no other speaking mark. Run `npm test -w @dilla/web -- VoiceView Shell.panel`; record.
- [ ] **Step 2: implement.**
- [ ] **Step 3: gates.** G-web; G-ui; the whole `e2e/voice` project chromium and firefox, including `speaking.spec.ts` and `join-muted.spec.ts`. **Commit:** `feat(web): the voice dock as Discord's, with no meter, and speaking as a ring`.

### Task WEB-AUTH: The invite page in Mesh, and the auth column edges

**Model:** sonnet; reviewer **opus** (a CSP change). **Lane:** auth. **Depends on:** UI-1 integrated.

**Files:**
- Modify:
  - `internal/api/invites.go`: the template (:77-111, its `<style>` at :85-99) uses the Mesh tokens it already copies plus an `@font-face` for JetBrains Mono when `landingFont` is set (R43); the body is 13.5px (the app's base), the card gets the onboarding frame's DILLA bar and 37rem column, and the open link is a 36px accent button, left-aligned (L1); the CSP at :158 becomes `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'`; `NewInvites` takes the served web client's `fs.FS` and finds the font once (R43: `fs.Glob`, first match; the file is already served at `/assets/…` by `internal/web`);
  - `internal/dillad/routes.go:125` (`api.NewInvites(…)` gains the web client's `fs.FS`, the one `dillad.New` serves; this one line is WEB-AUTH's, after SRV-AFK's routes.go edit integrates);
  - `internal/api/invites_test.go`, `invites_landing_escape_test.go`;
  - `packages/web/src/screens/Onboarding.tsx`, `SignIn.tsx` and their CSS hooks in `app.css`: L2 (ghost link actions inside forms `padding-inline: 0`), L3 (the setup key's "Copy" a 36px suffix attached to the field; one checkbox at 24px on the column's x);
  - `e2e/web/invite-landing.spec.ts` (8517/8518): the headers assertion gains `font-src 'self'`.

- [ ] **Step 1: write the failing tests.** `TestLandingHeadersUnchanged` becomes `TestLandingHeaders` with the new CSP and the other three headers byte-identical; `TestLandingHasNoScriptNoFormOneLink` stays green (no `<script`, `<form`, `<link`, `<img`, no `http:`/`https:`, one `href=`, and now the only `url(` is a same-origin `/assets/…woff2`); `TestLandingFont`: with an `fstest.MapFS` holding `assets/jetbrains-mono-latin-wght-normal-abc.woff2` the page's `@font-face` names `/assets/jetbrains-mono-latin-wght-normal-abc.woff2`; with an empty FS it names none and keeps the system stack; `TestLandingTokensMatchMesh` stays green. `Onboarding.test.tsx` / `SignIn.test.tsx`: CSS pins for L2 and L3. Run `go test ./internal/api/ -run Landing` and `npm test -w @dilla/web -- Onboarding SignIn`; record.
- [ ] **Step 2: implement.**
- [ ] **Step 3: gates.** G-go on SQLite; G-web; G-e2e(invite-landing.spec.ts signup.spec.ts signin-order.spec.ts) chromium and firefox; the shots of `invite-landing.spec.ts` re-taken into `target/ui-screens/web3.9/`. **Commit:** `feat(api): the invite page in the app's type and grid`.
---

## Phase 3: e2e

### Task E-AFK: afk.spec, from an empty instance and from a web3.8 one

**Model:** opus; reviewer opus. **Lane:** e2e. **Depends on:** P2 integrated (WEB-DOCK and WEB-AUTH).

**Files:**
- Create: `e2e/web/afk.spec.ts` — its own host `{ port: 8613, control: 8614, webRoot: 'packages/web/dist', sfu: { port: 7896, udpPort: 7898 } }`, the fake-media launch args of `e2e/web/channel-list.spec.ts` (which also runs its own SFU host); `keepData: true` for the upgrade case's restart.
- Modify: `e2e/playwright.web.config.ts:28` only if Firefox's fake microphone cannot carry the energy check, as `channel-list.spec` is ignored there today; the report says which, with the evidence.
- Helpers: reuse `audioOut`/`sendsNoAudio` from `e2e/voice/join-muted.spec.ts:76-137` by moving them into `e2e/voice/support/voice.ts` (after WEB-DOCK's edit; this is the only change there) and importing them in both specs.

**Steps of the spec** (two browser contexts, Ada the owner and Björn a member, plus a phone-emulated context of Björn; each step is its own `test` in a `describe.serial`):
1. Ada creates "Midgard Crew": the list shows `AFK` last, with the voice glyph, for Ada and, after the invite, for Björn.
2. Ada renames it "Idle" and moves it into a new category "Lounge" through channel settings; Björn sees both changes without a reload.
3. Ada finds no delete for it in server settings → channels, and the channel dialog shows `afk.channel.note` and no permissions. `page.request.delete('/v1/channels/<id>')` with Ada's session is 403 `E_FORBIDDEN`.
4. Ada sets the inactive timeout to 1 minute (one row, one save footer). Björn joins `general` voice on desktop and does nothing; the test advances the instance clock past 60 s through the control listener's clock route (the one `ring.spec` uses) and runs the sweep. Björn's tab joins `Idle` by itself, every tile shows the muted glyph, the stage reads `Everyone is muted in Idle`, `afk.moved` is announced once, and `sendsNoAudio` holds for 5 s.
5. Björn clicks `general` and is back with his own mute state; Ada clicks `Idle` and joins it listen-only (`sendsNoAudio`).
6. Björn's phone context joins `general`; the clock passes the timeout twice; it is never moved.
7. Ada gives Björn a role that denies `view_channel` community-wide (through the role editor). Björn still sees `Idle` and is still moved there after the timeout.
8. The failure line: the test routes Björn's `POST …/call` for `Idle` to a 503 once; after the move the dock area shows `Moved to Idle for inactivity` with `join`, and no second request is made in 10 s; pressing `join` joins.
9. **Upgrade:** Ada creates voice `lounge`; the control listener's `POST /debug/afk/legacy` points the community at `lounge` (a web3.8 pick); the host stops and starts again on the same data (`keepData: true`). After the reload, the list has a new `AFK` and `lounge` is ordinary: Björn joins it and his mic sends (`sendsAudio`, the control); the old `Idle` is a plain voice channel too. A second restart adds nothing.
10. `expectAccessible` on the list, the AFK call and server settings.

- [ ] **Step 1:** write the spec; run it against the integrated build and record each step's result. A product bug is a finding for the controller (NEEDS_CONTEXT naming the step and the trace), never worked around.
- [ ] **Gates:** G-e2e(afk.spec.ts) chromium (and firefox, or the recorded reason it is ignored there) with `--repeat-each=3`; then the whole `e2e/web` and `e2e/voice` projects. **Commit:** `test(e2e): the built-in AFK channel from an empty instance and from a web3.8 one`.

### Task E-GEO: layout.spec, and the audit scripts in the repo

**Model:** sonnet; reviewer sonnet. **Lane:** e2e2. **Depends on:** P2 integrated.

**Files:**
- Create:
  - `e2e/web/layout.spec.ts` — host `{ port: 8615, control: 8616, webRoot: 'packages/web/dist', sfu: { port: 7900, udpPort: 7902 } }`;
  - `e2e/ux/world.mjs`, `e2e/ux/run.mjs`, `e2e/ux/shots.mjs`, `e2e/ux/sheets.mjs`, `e2e/ux/README.md` — ported from `/tmp/claude-1000/-home-thim-Repositories-dilla/c38f1ac9-be10-4029-b063-7a58368f1761/scratchpad/ux/` (`world.mjs`, `run.mjs`, `s1.mjs`–`s6.mjs`, `p1.mjs`, `p2.mjs`, `phone.mjs`, `auth.mjs`, `vars.mjs`) per R40: the repo root from `import.meta.url` (not `world.mjs:8`), ports 8611/8612 and SFU 7988/7990 as before, CDP from 9611, output under `target/ui-screens/web3.9/`. The step scripts merge into `shots.mjs` with one named step per audit screen. `sheets.mjs` composes contact sheets (a grid of shots per width and theme, with captions) into `target/ui-screens/web3.9/sheets/`. The AFK world changes: there is no picked AFK, the built-in one is used.
- Modify: `e2e/playwright.web.config.ts:29` (the WebKit `testMatch` gains `layout`); `e2e/package.json` scripts `ux:world`, `ux:shots`, `ux:sheets`.

**Rect checks in `layout.spec.ts`**, each at 1440×900, 1024×768, 390×844 and 360×740 (phone sizes with `isMobile`, `hasTouch`), from an EMPTY host with a small world (one server, two categories, text, announcement, voice with a live participant, the AFK channel, a DM):
- every list's names share one left x (±0.5px): channel rows, voice rows, category labels, DM rows (A5);
- every row's trailing slot shares one right edge (A4);
- every bar's bottom hairline is at y=48 (sidebar head, channel header, members head, stage header, settings bar, PhoneHeader) (B1, R12);
- on phone every primary target is ≥ 44×44 and every secondary ≥ 24×24 (R9);
- at 1024 with the members aside open, the header's name is visible and no action's rect leaves the header (C1);
- the rail is 72 wide and its tiles 48 (R22);
- a collapsed category keeps its current and unread rows;
- no element of `main` overflows its column horizontally.

- [ ] **Step 1:** write the spec; it must pass on the integrated build. Show each check red first by running it against the web3.8 build (`git worktree` is not allowed: build `packages/web` at `main` into `/tmp/w38-dist` from a `git archive` export, and point a second run's `webRoot` there through an env var), and record the reds.
- [ ] **Step 2:** port the scripts; `npm run ux:world -w @dilla/e2e` then `npm run ux:shots -w @dilla/e2e` must produce the audit's screen names.
- [ ] **Gates:** G-e2e(layout.spec.ts) chromium, firefox and webkit. **Commit:** `test(e2e): the layout grammar as rect checks, and the audit world in the repo`.

---

## Phase 4: integration

### Task H1: protocol/07 rows

**Model:** opus; reviewer opus. **Files:** `protocol/07-versioning.md` (the table ends at :205; rows after it).

- **`| 2026-10-20 | e2ee 1, media 1, wire 2 |` Additive and retirements (the built-in AFK channel, no migration, no version bump):**
  - `09` § Voice: every community has one built-in AFK voice channel, created with the community and, for older communities, by `dillad` at start; `community_afk` names it; the audit row `channel.create` with a null actor and detail `afk.builtin` marks it.
  - `PUT …/afk/settings` takes `[timeout_seconds]`; `[channel_id, timeout_seconds]` only with the built-in id.
  - `GET …/afk` is `[channel_id, timeout_seconds, [], pending]`: the third element is always empty (the occupant list, retired) and `pending` is appended.
  - `POST …/afk/activity` takes an optional second element `exempt`.
  - `POST` and `DELETE …/afk` are retired: `404 E_NOT_FOUND`.
  - Refusals: deleting the AFK channel, patching its topic, mode, visibility or slow mode, and putting or deleting an overwrite on it are `403 E_FORBIDDEN`.
  - Authz: every member holds `view_channel` and `connect` on the AFK channel whatever their roles; every grant in its call is listen-only, and share is refused there.
  - op 54 `community_changed` is also sent to the moved user when the sweep moves a device.
- **`| 2026-10-20 | e2ee 1, media 1, wire 2 |` Behaviour change (`09` § Channels):** a channel's `parent_id` must name a category the caller can view (`404 E_NOT_FOUND`); the listing shows a channel whose category the caller cannot view at the top level, and never the category.
- **Gates:** G-docs. **Commit:** `docs(protocol): web3.9 versioning rows`.

### Task CI

**Model:** sonnet; reviewer sonnet. **Files:** `.github/workflows/ci.yml` (846 lines), `scripts/check-ci-workflow.mjs` and its test.

- The `go-postgres` job step (:772-775) gains `./internal/api/...` filtered to the AFK and channel-parent tests: `go test -race -shuffle=on -timeout 20m ./internal/store/... ./internal/ops/... && go test -race -shuffle=on -timeout 20m -run 'AFK|Afk|HiddenCategory|HiddenParent|ParentAnywhere' ./internal/api/...` as two steps (no `&&` chains if `check-ci-workflow.mjs` forbids them; check and say), each with `DILLA_TEST_PG`.
- The `node` job's `npm test` (:28) already runs `check:css` through the root `test` chain (UI-1); add `- run: npm run test:css-check` beside :21-24 so the checker's own test runs.
- The WebKit `testMatch` gains `layout` from E-GEO; CI verifies it and lists it: `npx playwright test -c e2e/playwright.web.config.ts --list --project=webkit-web` names `phone.spec.ts`, `signin-order.spec.ts`, `private-window.spec.ts`, `signup.spec.ts`, `z/reload.spec.ts` and `layout.spec.ts`.
- The chromium and firefox web projects run every spec in `e2e/web`, so `afk.spec.ts` and `layout.spec.ts` need no entry; the voice project picks up nothing new. If `afk.spec` and `layout.spec` push `chromium-web` or `firefox-web` past the 38-minute budget (`check-ci-workflow.mjs:82-89`), say so with the measured time; do not raise the budget (NEEDS_CONTEXT).
- `check-ci-workflow.mjs`: `REQUIRED_STEPS` for `go-postgres` and `node` gain the two lines; its test is shown red first.
- [ ] **Gates:** `npm run check:ci`; `npm run test:ci-check`. **Commit:** `ci: the AFK backfill on Postgres, the css check, and layout in WebKit`.

### Task AUDIT-2: The audit again, measured against the first

**Model:** sonnet; reviewer **opus**. **Files:** `.superpowers/sdd/2026-10-20-dilla-web-3-9/ux-audit-2.md` (new), `target/ui-screens/web3.9/**` (not committed).

- [ ] **Step 1.** Build, then `npm run ux:world -w @dilla/e2e` and `npm run ux:shots -w @dilla/e2e` (E-GEO's scripts), from an empty instance on 8611/8612, at 1440×900, 1024×768 (mesh, light, high-contrast) and 390×844, 360×740 (mesh, light).
- [ ] **Step 2.** Re-measure every finding of `ux-audit.md` (A1–L3) with the same `getBoundingClientRect` method, and write `ux-audit-2.md`: one row per finding with the web3.8 measurement, the web3.9 measurement, and fixed / partly / open. Every critical and high row must measure fixed; the invariants: hairlines at y=48, one name x per list, one slot right edge, no primary target under 44 on phone.
- [ ] **Step 3.** Any critical or high row that is not fixed is a NEEDS_CONTEXT naming the task that owned it; medium and low rows that stay open are listed for the controller.
- [ ] **Gates:** the file exists with 49 rows. **Commit:** `docs(audit): web3.9 alignment re-measured against web3.8`.

### Controller step: contact sheets (after AUDIT-2, before the PR leaves draft)

Not a task. `npm run ux:sheets -w @dilla/e2e` composes, from AUDIT-2's shots:

| Width | Themes | Screens |
|---|---|---|
| 1440×900 | mesh, light, high-contrast | Home (`@`) with DMs, server with categories and unread, header hover and focus, voice preview, stage (3 and 5 tiles, speaking ring, volume chip), focused stage, dock and panel, AFK call, two-line members, user settings (voice, keyboard), server settings (overview with timeout, channels with AFK), search |
| 1024×768 | mesh, light | shell, header (the C1 case), stage, server settings |
| 390×844 | mesh, light | Home with servers (idle, in call, AFK), Home with `@` DMs, channel, channel with tap-revealed toolbar, channel with keyboard (visualViewport), activity, you, voice preview, stage, members sheet, settings voice |
| 360×740 | mesh | Home, channel with keyboard, stage |

Plus one before/after sheet of the 2 critical and 14 high findings (the `ux-audit/` shot beside the web3.9 one). Jonas approves or sends notes; notes become a fix round (assigned to the owning task's lane) and a re-shoot of the affected sheets. DOCS starts after his approval.

### Task DOCS

**Model:** sonnet (it re-shoots screenshots); the prose is haiku-grade text written here. **Files:** `README.md` (`## What works today`, :17-39), `docs/user/getting-started.md` (AFK settings :157-161, the sidebar, the rail and the phone tabs sections), `docs/user/voice.md` (`## AFK channels` :224-232), `docs/deploy/README.md` (§ Client data version :811-824, the systemd section), `docs/user/screenshots/*`, `e2e/scripts/shoot-docs.mjs` (1208 lines; shot lists :67-99).

- **README "What works today":** "As of web-3.9 (2026-10-2x)" (the controller fills the date); add: the built-in AFK channel; the `@` Home tile and three phone tabs; categories that collapse; one-click voice join on desktop; speaking rings; a dock without a meter; header icons with tooltips; two-line member rows; grouped messages with date dividers and jump to present; tap to reveal message actions on phone; the invite page in the app's type. Remove "Move to AFK".
- **getting-started:**
  - **Home and direct messages:** the `@` tile at the top of the rail opens your direct messages, on desktop and phone; the phone has three tabs, Home, Activity and You;
  - **Servers and categories:** channels sit in categories; click a category's name to collapse it (it keeps the channel you are in and channels with new messages); this is remembered in this browser only; managers add a channel to a category with its "+";
  - **The rail:** one "+" tile to join or create a server;
  - **The header:** pins, threads, search, edit channel and members are icons; hover or focus one to see its name and shortcut;
  - **Server settings → overview:** the inactive timeout (1, 5, 15, 30 minutes or 1 hour); there is no AFK channel picker any more;
  - the keyboard table: `Ctrl+End` jumps to the newest message.
- **voice.md § AFK channels**, rewritten: every server has an "AFK" voice channel; admins can rename it and move it, not delete it; anyone can join it, and everyone in it is muted (you can hear, not speak, share or show a camera); after the inactive timeout in a voice channel on a computer you are moved there; phones are never moved; leave by joining another voice channel. Also: one click on a voice channel joins it on desktop; on a phone, tap it to see who is there, then join; the dock shows "voice connected" (click it for Diagnostics), where you are, then camera, share and leave; speaking shows as a ring around the avatar; the microphone meter is in Settings → Voice.
- **Deploy README:** § Client data version: `| web-3.9 (`v0.1.0-web3.9`) | 5 | 20 | No change to the browser store or the server schema. dillad adds an "AFK" voice channel to every server at its first start. |`; the systemd section: `dilla-media.service` has `PartOf=dilla.service` (run `systemctl daemon-reload` after copying it; `install.sh --upgrade` does), and `dillad media --rooms` lists live rooms and participants; § Upgrading to web-3.9: the AFK backfill, and that a server's web3.8 AFK channel becomes an ordinary voice channel.
- **shoot-docs.mjs:** new shots `home-dms-desktop`, `home-dms-phone`, `categories-desktop`, `afk-call-desktop`, `afk-settings-desktop`, `dock-desktop`, `members-desktop`, `message-reveal-phone`, `header-tooltip-desktop` (a `WEB39_SHOTS` list beside `WEB38_SHOTS` :99, checked by the missing-shot check :1196); every existing shot re-taken.
- **Re-shoot:** `npm run build -w @dilla/web`, then `npm run docs:shots -w @dilla/e2e`; update every image reference in getting-started and voice.md.
- **Gates:** G-docs; `npm run docs:shots -w @dilla/e2e` exits 0 with no missing shot. **Commit:** `docs(user): the AFK channel, the @ tile, categories, the new dock and the phone tabs`.

### Task RELNOTES

**Model:** haiku; reviewer sonnet. **Files:** create `docs/deploy/releases/v0.1.0-web3.9.md`.

- **`# dilla v0.1.0-web3.9`, then `## What's new`:** the built-in AFK channel (renamed and moved freely, never deleted; everyone in it muted; joined by click; idle desktop devices moved there; phones never moved; one inactive-timeout setting, default 5 minutes); direct messages behind the `@` tile, desktop and phone; three phone tabs (Home, Activity, You; old DM links still land); the rail at 72 with 48 tiles and one "+" tile; categories that collapse; one-click voice join on desktop; header icons with tooltips; two-line member rows with online and offline sections; grouped messages, date dividers and jump to present; the dock without a meter, and speaking rings; phone headers and the call dot while typing; tap to reveal message actions on phone; one settings layout and a keyboard table; the invite page in the app's type; no speech lost after a microphone restart. Screenshots linked from `docs/user/screenshots/`.
- **`## Versions`**, each labelled:
  - server schema **20, unchanged** (or, if SRV-AFK took the reservation, **20 → 21, changed**, with its rollback note);
  - client store **5, unchanged**;
  - wire **2, unchanged**;
  - browser ABI **11, unchanged**;
  - WASI ABI **unchanged** when the `dilla_core_wasi.wasm` line of `SHA256SUMS` equals web3.8's (the controller compares and states it);
  - the browser core: `dilla_core_wasm_bg-<hash>.wasm`, its size in bytes as served (the controller fills both from `packages/web/dist/assets` and from CT 144).
- **`## Operator notes`, every operator-visible change:**
  - **Data change at the first start.** `dillad serve` gives every server a new "AFK" voice channel, at the end of its channel list. All members can see and join it whatever their roles. The audit log shows it as created by the system (`channel.create`, no actor, `afk.builtin`). A second start changes nothing.
  - **Servers that chose an AFK channel in web3.8** get the new one too. The old channel loses its AFK role and becomes an ordinary voice channel: joinable again, its name and permissions unchanged, any live call in it untouched. Its admin may delete it. The timeout carries over.
  - **Rollback to web3.8 is safe.** web3.8 reads the new channels as its AFK destinations (held, silent), and the old ones stay ordinary. A web3.9 tab after a rollback keeps working until it reloads.
  - **Behaviour:** the AFK channel cannot be deleted, and its topic, mode, visibility and slow mode cannot be changed; it takes no permission overwrites; "Move to AFK", "Leave AFK" and the AFK picker are gone; auto-move cannot be turned off; phones are never moved; presence in AFK survives a restart like any call.
  - **API:** `PUT /v1/communities/{id}/afk/settings` takes `[timeout_seconds]` (the old two-element body only with the built-in id); `GET /v1/communities/{id}/afk` is `[channel_id, timeout_seconds, [], pending]`; `POST …/afk/activity` takes an optional `exempt`; `POST` and `DELETE …/afk` answer `404`; deleting or re-kinding the AFK channel or writing an overwrite on it answers `403`. protocol/07 has a row for each.
  - **Authz:** a channel can no longer be put in a category its creator or editor cannot see (`404`), and the channel list never shows a category you cannot see.
  - **Deploy:** `dilla-media.service` gains `PartOf=dilla.service`, so stopping or restarting `dilla` stops or restarts the media sidecar; after copying the unit by hand run `systemctl daemon-reload` (`install.sh --upgrade` does it). `dillad media --rooms` lists live rooms and participants, and `dillad media --probe` prints the room count.
  - **The invite page's CSP** gains `font-src 'self'` (JetBrains Mono from the bundle); everything else on it is unchanged.
  - `dilla-testhost` (test only) gains `POST /debug/afk/legacy` on its control listener.
- **`## Known limits`:** WebKit is verified in CI only; no context menus, long-press sheets, gestures, NEW divider or GIFs yet (web3.10).
- **Gates:** G-docs. **Commit:** `docs(deploy): web3.9 release notes`.

## After the tasks (controller)

**Integration order:** T0 → SRV-CAT → SRV-AFK → OPS → VOICE-FIX → FX-RELOAD → CORE-AFK → UI-1 → UI-2 → UI-3 → UI-4 → UI-5 → VOICE-AFK → WEB-AFK → WEB-HOME → WEB-LIST → WEB-PHONE → WEB-SET → WEB-DOCK → WEB-AUTH → E-AFK → E-GEO → H1 → CI → AUDIT-2 → (contact sheets) → DOCS → RELNOTES.

Then:
- **Full wave gates:**
  - `npm test` (all workspaces, with check:docs, check:brief, check:copy, check:ci, check:css and lint); Storybook build and `test:storybook:ci` with axe (strict target size on `Form/`, `Ceremony/`, `Shell/`, `Conversation/`, `Settings/`, `Voice/`, `Media/`, `.storybook/test-runner.ts:4`);
  - `go vet ./...`, `golangci-lint run ./...` (gofmt and goimports), `go test -race -shuffle=on ./...` on SQLite and again with `DILLA_TEST_PG` (both engines; the backfill), G-sqlc;
  - `cargo test --workspace --all-features --locked` (expected unchanged), G-rust including the wasm ABI-11 build and the 3,500,000-byte budget;
  - G-e2e-all: the full `e2e/web` and `e2e/voice` suites on Chromium and Firefox locally, the voice suite on Firefox included, with `reload.spec.ts --repeat-each=20` after FX-RELOAD; `afk.spec`, `layout.spec`, `phone.spec` (390×844 and 844×390), `join-muted.spec`, `speaking.spec`; WebKit in CI.
- **Upgrade path:** a web3.8 database (built by the web3.8 binary) with three servers: one with a web3.8 AFK pointer whose channel has a live call, two without. Start web3.9: each has exactly one new built-in AFK; the old pointed channel is ordinary and its call keeps speaking; a second start changes nothing. Roll back to the web3.8 binary: the new AFK channels read as web3.8 held AFK destinations, the old ones stay ordinary, nothing breaks. Run on SQLite and on Postgres.
- **Reviews (opus):** SRV-AFK + VOICE-AFK + WEB-AFK as one authz and E2EE review with Review Focus 1–4 (can any token, race, re-push or old grant let a device publish in AFK; can any path delete or re-kind AFK, including a concurrent delete or a community transfer; can a pending move be forged; do media keys still flow only through MLS); SRV-CAT separately (Review Focus 6); then a whole-branch review with all six.
- **Walk (opus):** an empty instance on 8611/8612, two browsers, phone emulation and a second device: every Part A and Part C path, plus keyboard-only passes of the rail, list, header, stage and settings.
- **Real devices:** a real Android for the back card (`KEYBOARD_PX = 100`); Jonas's phone at 390.
- PR, CI green, Jonas's contact-sheet approval, merge, tag `v0.1.0-web3.9`, verify the assets (`sha256sum -c`, the stamped tag, `dillad version`), `gh release edit --notes-file`.
- **After release:** tell Homelab to deploy CT 144 unasked, with the operator notes: the AFK backfill on real data, `daemon-reload` for the media unit, and Homelab's unverified browser checks (newer-client screen, Reload, 4006, sign-in order, invite page); doctor reports 0 FAIL; the core size as served.

**Risks carried:**

| # | Risk | Mitigation |
|---|---|---|
| R-a | The backfill fails half way on a real instance | One transaction per community; a failure is logged and skipped; the lazy ensure in `GET /afk` retries; the upgrade walk runs on both engines |
| R-b | A grant path missed in R34 lets a device publish in AFK | Three grant sites named and tested; `inAFK` fails closed; the e2e energy check in E-AFK; the opus review |
| R-c | Firefox's fake mic cannot carry `sendsNoAudio` in `afk.spec` | Recorded and ignored there like `channel-list.spec`; the Chromium run and `join-muted.spec` on Firefox carry the method |
| R-d | Jonas's sketch-round notes reshape UI-2…UI-5 | The WEB lane waits for the approval; fixes stay in the ui lanes |
| R-e | Shell.tsx contention | Six writers in one lane, one at a time |
| R-f | `afk.spec`/`layout.spec` push the web jobs past 38 minutes | CI measures and reports; no budget raise without a ruling |
| R-g | The icon names at Lucide 1.57.0 differ (`square-pen`) | UI-1 uses the tag's name and says so |
| R-h | A web3.9 tab after a rollback reads a 3-element snapshot | CORE-AFK parses it as `pending: false` |

### Critical Files for Implementation
- /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/internal/api/afk.go
- /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/internal/api/calls.go
- /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/internal/api/callgrants.go
- /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/internal/api/perm.go
- /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/internal/api/channels.go
- /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/internal/api/communities.go
- /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/packages/client-core/src/worker/controller.ts
- /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/packages/web/src/screens/Shell.tsx
- /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/packages/web/src/screens/voice/useCall.tsx
- /home/thim/Repositories/dilla/.claude/worktrees/sdd-dilla-protocol/packages/ui/src/ChannelList/ChannelList.tsx

## Pre-flight rulings (2026-10-20)

Points where the wave plan does not hold against the tree at 9f632564, each ruled by the plan writer (the controller may overturn any). The task text already carries each ruling.

| P | Wave plan says | The tree | Ruling | Cost if wrong |
|---|---|---|---|---|
| P-1 | "It sends op 54 to that device" (R4) | Op 54 is `community_changed` to members; there is no per-device frame (`frame.go:62`, `structurenotify.go:46-56`) | `ChangedTo(cid, [user])`; `pending` per calling device in the snapshot (R33) | A per-device op would be a new gateway op, against the reservation |
| P-2 | `grantFor` and `admitGrant` are the grant path (R3) | The role-change re-push builds its own grant (`callgrants.go:307`) | All three are AFK-aware, failing closed (R34) | A role change re-grants the mic in AFK |
| P-3 | "The permission resolver grants every member view and connect" | `EligibleUsers` builds `Snapshot` by hand (`private.go:40-80`) | The grant is `Snapshot.AFK`, set by `LoadSnapshot` and `EligibleUsers` (R35) | Role-denied members miss `channel_members`, so the MLS call group refuses them and the move fails |
| P-4 | AFK participants show `voice.state.suppressed` (R6) | No such key; `voice.state.muted` is the `mic-off` glyph (en.ts:485) | Use `voice.state.muted`; no new `voice.` key | A new `voice.` key against the string rules |
| P-5 | Setting key `channels.collapsed` (one value) | Values are capped at 1024 bytes (`settings.rs:8-9`): 31 ids | `channels.collapsed.<categoryHex>` = `'1'` (R36) | A server with 32+ collapsed categories cannot save |
| P-6 | `--row-gap` 2/0 (R10) | `--row-gap` is the density token, used by messages and lists | `--list-gap` (R37) | Every message row's spacing changes by accident |
| P-7 | Prefix `afk.` "re-used", `tooltip.` | No `afk.` file (keys are `voice.afk.*`, `admin.afk.*`); tooltips repeat existing names | New `afk.`, `layout.`, `home.`; no `tooltip.` (R38) | Keys under forbidden `voice.`/`admin.` prefixes, or tooltip text that differs from the name (2.5.3) |
| P-8 | "voice connected" in the dock | The dock says `in {where}` (`voice.dock.connected`) | `layout.dock.connected`, `layout.dock.where` | — |
| P-9 | Channel settings: hide delete, mode, visibility, the permissions tab | No tab bar; permissions are inline in `ChannelEditFlow`; delete is in server settings → channels; no mode or visibility control exists | R39 | A task hunts for controls that do not exist |
| P-10 | e2e ports "confirmed against the registry"; taken 8453/4, 8463/4, 8481/2, 8485/6 | No registry; 21 pairs in use | The full list is in Global Constraints; 8613/4, 8615/6 new; 8611/2 for `e2e/ux` | A port clash between parallel lanes |
| P-11 | Contact sheets "with the audit's world (`ux/world.mjs`)" | The scripts are in a session scratchpad, not the repo | E-GEO commits them as `e2e/ux/` (R40) | AUDIT-2 and the sheets cannot be reproduced by a lane or after the session |
| P-12 | Retired routes answer `E_GONE` "if protocol/09 has it" | No `E_GONE` in protocol/02 § Errors | `404 E_NOT_FOUND` through explicit handlers (R41) | A web3.8 tab gets the mux's 405 |
| P-13 | The snapshot "adds pending, drops the occupant list" as additive | The web3.8 parser requires the third element to be a list | Keep `[]` third, append `pending` (R33) | Every open web3.8 tab's AFK slice fails to decode until reload |
| P-14 | AFK "at the last position" | New communities have no channels; clients use `max + 1` | `AFKBuiltinPosition = 1 << 30`; clients skip AFK in `max + 1` (R42) | AFK sorts first in every new server |
| P-15 | E-PHONE after WEB-HOME | WEB-HOME breaks `phone.spec.ts` at once, and every lane runs its whole suite | E-PHONE folded into WEB-HOME | WEB-HOME's gate is red |
| P-16 | `EnsureAFKChannels` in `cmd/dillad/serve.go` | Member materialisation needs the DS, built in `dillad.New`; the test host goes through `dillad.New` too, not `serve.go` | Called from the composition root (`routes.go`) before any listener (R1) | The test host never backfills, so the upgrade e2e cannot run |
| P-17 | UI-2 deletes `SidebarTabs` | Shell imports it until WEB-HOME, and G-ui runs the web typecheck | WEB-HOME deletes it (the web3.8 C-1 pattern) | G-ui red from UI-2 to WEB-HOME |
| P-18 | CORE-AFK deletes `moveToAFK`/`leaveAFK` and the occupants | Shell and OverviewSection call them until WEB-AFK | Deprecated no-ops kept until WEB-AFK deletes them with their callers (the web3.8 C-3 pattern) | G-core's web typecheck red until WEB-AFK |
| P-19 | "as does a create that names one" (overwrites on AFK) | A channel create writes overwrites only for itself | Moot; no code (R2) | — |
| P-20 | L1: "serve JetBrains Mono from the web bundle" | The invite CSP forbids fonts | `font-src 'self'`, opus review (R43) | The font never loads, or a CSP change slips through unreviewed |
| P-21 | VOICE-AFK carries "the e2e pin" | The pin needs Shell's wiring (WEB-AFK) | The no-audio pin is E-AFK step 4 and 5 | VOICE-AFK's e2e cannot run in its lane |
| P-22 | CI runs the backfill on Postgres | `go-postgres` runs only store and ops | CI adds the AFK tests of internal/api there | The backfill's Postgres leg runs only locally |

## Addendum (2026-10-20): the AUDIT-2 fix wave

Jonas approved the contact sheets on 2026-10-20 and chose to fix every open AUDIT-2 item before web3.9 ships. The source is `.superpowers/sdd/2026-10-20-dilla-web-3-9-tasks/ux-audit-2.md` (rows, measurements and the cause file:line). There are four tasks in parallel lanes with disjoint owners. Each one runs narrow gates, plus a measured check in `e2e/web/layout.spec.ts` (each task adds its own `test(...)` block, appended at the end of the file).

### Task FA1: Phone targets and invites
Owns: `packages/ui/src/{Button,Toggle,VoiceSettings,SettingsRow}/**`, onboarding and sign-in screens' CSS, and `packages/web/src/screens/settings/server/InvitesSection.tsx`.
- **I1:** the invites section uses SettingsRow/ManageList grammar: label on the left, control in the 16rem column, icon actions in trailing slots.
- **H4/N3:** on a phone (`[data-layout="phone"]`, plus onboarding and sign-in outside the shell), every primary control is at least 44px tall. That covers onboarding and sign-in buttons, Copy, the voice selects and the toggle switches. The `refresh` button reaches 44 on phone, because `SettingsRow.css:10` must not beat the phone rule. The composer field stays a text field at 16px or more.
- **Measured:** every button, select and toggle on onboarding, sign-in, settings → voice and settings → devices is at least 44 at 390.

### Task FA2: The DM and voice layout
Owns: `packages/web/src/screens/Shell.tsx`, `packages/web/src/app.css`, and `packages/web/src/screens/voice/VoiceView.tsx`.
- **N1:** the desktop DM call action moves into the DM header as an icon button, as on phone (`Shell.tsx:1193`), and the lone call band (`app.css:81`) goes.
- **N2:** the DM list's "message someone" becomes a header icon action (`square-pen`, as on phone), not a stray text footer (`Shell.tsx:1058`).
- **N4:** the AFK and voice preview get one grammar. The title, people and join sit in one column at the top, with no 760px gap.
- **D4:** on phone the call stage fills the view and its controls pin above the tab bar (`app.css:68-72`).
- **Measured:** the DM header holds the call button with no band below it; the preview's join sits within 120px of its text; the phone stage controls' bottom edge sits at most 8px above the tab bar.

### Task FA3: One row per person
Owns: the voice roster grouping in client-core and the voice row view model in web.
- **A7:** a voice channel lists each person once, however many devices they have. The count counts people. Their state is the union across devices: speaking if any device speaks, muted only if every device is muted.
- **Tests:** two devices of one user give one row and count 1. The test e2e or the unit level, whichever the roster lives in.

### Task FA4: Polish
Owns: `packages/ui/src/SearchPalette/**`, `packages/web/src/screens/You.tsx`, `packages/ui/src/SettingsFrame/**` (phone title), `packages/web/src/screens/settings/server/ChannelsSection.tsx`, `packages/web/src/screens/settings/Privacy*`, and `packages/ui/src/Icon/icons.ts` (new icons only).
- **J1:** search result rows show `#channel`, the author and the time, plus a KeyHint footer (↑↓ to move, Enter to open, Esc to close).
- **H6:** the You tab gets an icon per row, including sign out (`log-out`).
- **H5:** the phone settings view no longer repeats the header title as an h2. The PhoneHeader is the heading.
- **I6:** admin channel reorder uses `arrow-up`/`arrow-down` icon buttons in trailing slots, and long names truncate to one line.
- **I7:** privacy "Compare with …" uses the ghost button style, with one accent action at most.
