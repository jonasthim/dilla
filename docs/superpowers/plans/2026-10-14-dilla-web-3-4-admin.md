# dilla v0.1.0-web3.4: server admin and moderation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a server owner or moderator runs their server from the web client. They can:
- rename or delete the server, or hand it to another member;
- edit, reorder and delete channels and categories;
- make invites with limits, and list or revoke them;
- see a member list;
- kick, ban and unban people.

Everyone sees these changes live, and someone who is removed is told. Voice gets four follow-ups.

**Architecture:**
- dillad already serves almost every admin route. Wave 1 adds three read routes (own permissions, roles list, ban names) and one write route (transfer ownership).
- It widens gateway op 54 `community_changed`: it is now also sent on membership, role and community-delete changes, and once to a removed user. The client already drops a server missing from the re-read list (client-core controller.ts:1347-1358).
- client-core gets an `AdminController`. packages/ui gets the menu, confirm, list and aside primitives. The web client gets a member pane and a Server settings dialog built on `SettingsFrame`.
- No migration, no new opcode, no new permission bit.

**Tech Stack:** Go (internal/api, internal/gateway), TypeScript (client-core worker, React web, packages/ui and Storybook), Playwright e2e against dilla-testhost.

**Spec:** `docs/superpowers/specs/2026-10-14-discord-parity-roadmap.md`. This plan is its Wave 1; Part A is the execution model and Part B the feature recipe. Evidence for each gap is in `docs/superpowers/specs/2026-10-14-discord-parity-inventory.md`.

## Global Constraints

- **Models** (roadmap A1): a task's `Model:` line is binding. sonnet does recipe tasks, haiku does strings and docs, opus does S4, S5, C4 and V1-V4 and every review of those.
- **Reservations:**
  - e2e ports 8487/8488 (E1), with 8489/8490 spare. 8485/6 belongs to the probe.
  - Flow doc 08.
  - No migration (00017/015 stay free), no opcode (55 stays free), no permission bits.
- **String prefixes:** new keys use `admin.`, `members.`, `mod.` and `removed.`, in the feature files `packages/web/src/strings/{admin,members,moderation}.ts`.
  - Never add `settings.`, `devices.`, `notify.`, `appearance.` or `shell.` keys: strings.test.ts:66,79 pin their counts.
  - `invite.options` goes in flow 07; `voice.diag.tracks` and `voice.outputFailed` go in flow 06.
- **Copy:**
  - Chrome (buttons, menu items, nav) is lower case. Titles, bodies and refusals are sentence case.
  - No `!`.
  - None of these words outside `strings/privacy.ts`: "secure", "safe", "protected", "encrypted", "E2EE", "MLS", "end-to-end".
  - Every key has a `key='value'` pair in its flow doc's `## Copy`.
- **Design:** Mesh tokens and packages/ui components only. Keyboard first, visible focus. A dialog moves focus in on open and back to its opener on close. WCAG 2.2 AA including target size. Works at 360 px and 200 % zoom.
- **Behaviour the server owns:** every client gate is advisory. The client handles every refusal with its copy key, never with a raw code alone.
- **Test-first:** each behaviour has a test that fails first, then passes. Each logic change has one mutation the tests catch. Record both in the report.
- **Fixture reachability:** any state a test starts from must be reachable from the shipping client. E2E specs start from an EMPTY host.
- **Env dirs:** each lane uses `CARGO_TARGET_DIR=/home/thim/.cache/dilla-w3/<lane>-target` and `GOCACHE=/home/thim/.cache/dilla-w3/<lane>-gocache`.
- **Harness:** single plain commands only: no `&&`, `;`, pipes or `$(...)`. Anything longer goes in a script file under the scratchpad the dispatch names.
- **Commits:** `git commit -s -F <file>`. Every message's body ends with exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01XLFud8eoDaqf8uiZq5wjuP`
- **Process:** no subagents inside a task; no push, tag or release; never a bare `git stash`. A commit-time security scanner flag counts as real until shown otherwise.

## Review Focus

1. **Stale permissions.** A is demoted (or B promoted) after the permissions load. The menu offers kick, the server answers 403, and the person expects the right copy and a refreshed menu. A newly promoted moderator sees actions after the next op 54. Pinned in C3 (a 403 re-reads permissions) and W1.
2. **Removed while busy.** The kicked user has server settings, a ban dialog, a draft or a call open in that server. They expect no crash, the call to end with the existing removed copy, and the dialogs to close. Pinned in C4 and W3.
3. **Several devices or tabs.** Leaving on device 1 shows device 2 the neutral notice. A tab that missed the frame gets the notice at its next list read. Pinned in C4.
4. **Honest lists:**
   - an invite link can't be shown again;
   - lapsed bans read "ended…";
   - delete-server's typed name matches under NFC ("Björn" typed as NFD matches);
   - name and topic hints say the host can read them;
   - no slow-mode promise.
   Pinned in W2a, W2c and W2d.
5. **Keyboard and screen reader:**
   - Shift+F10 or the ContextMenu key on a member row opens its menu;
   - focus returns to the trigger after a confirm;
   - the 360 px member drawer doesn't hide the composer;
   - the `members` toggle state is announced;
   - focus order runs main → aside → status.
   Pinned in U1, U3, U6 and W3.

## Recipe (anchors on origin/main c83f2b7; the full recipe is roadmap Part B)

- **Go handler pattern:** `internal/api/channels.go:285-400` (`Channels.create`):
  1. `enrolledSession` (communities.go:832);
  2. `server.PathID`;
  3. `server.DecodeBody` into a `_ struct{} \`cbor:",toarray"\`` struct;
  4. `notFound` for a non-member (communities.go:843);
  5. the permission check (`LoadSnapshot(ctx, repo, cid, uid, nil).Resolve(uid).Has(PermX)`, perm.go:195);
  6. `repo.Tx` with `tx.Audit(...)` (channels.go:377);
  7. `afterCommit(r)` side effects (membership.go:51);
  8. `server.EncodeBody`.
- **Registering routes:** a group's `Register(mux)`, mounted in `internal/dillad/routes.go:76-112`.
- **Go tests:** `internal/api/*_test.go`, package `api_test`. `newEnv(t)` (apitest_test.go:58), `e.Do(method, path, tok, []any{...})` (:130), `e.ErrCode(body)`.
- **Protocol docs:** a protocol/09 subsection table; protocol/02:385-394 for op 54. Run `npm run check:docs`.
- **client-core routes:** `packages/client-core/src/http/routes.ts` (pattern `createChannel` :240-247: encode, `this.body(METHOD, path, bucket, idempotent, {body})`, `atLeast`, `bin/u53/u64/str/opt`). Tests in `routes.test.ts`: a `CASES` row (:180-195), a refusal row (:510), input rejects (:642-648).
- **client-core worker:**
  - the `worker/protocol.ts` Command union;
  - `worker/controller.ts` COMMANDS, ID_FIELDS, ACCEPTS.ready, `invalid()` and `dispatch()`;
  - slices through `this.slices.set(name, value)`;
  - `state/types.ts` SliceName and SliceTypes (:136-153);
  - tests in `controller.test.ts` with `world()` (:326) / `toReady()` (:1806) / `w.call` / `vi.waitFor(() => w.ret(id))`;
  - model doubles in `sync/testing/model.ts` (RouteName :2036, routesFor :2582).
- **ui:** `packages/ui/src/<C>/{C.tsx, C.css, C.stories.tsx, C.test.tsx}`. All copy comes through `labels`, CSS uses `d-<c>__*` classes and tokens only, export from `src/index.ts`. Storybook axe, the focus guard (`.storybook/test-runner.ts`) and target-size rules apply.
- **web:**
  - flows follow `screens/Create.tsx:283-345` (`useCore()`, the running/session/attempt guards, `client.call`, `errorOf(e).code` → `t(key)`);
  - Vitest with `FakeClient` (`test/fake-client.ts`) and `expectNoAxeViolations`;
  - Shell wiring tests in `screens/Shell*.test.tsx`.
- **e2e:** pattern `e2e/web/create.spec.ts` (own `HostConfig`, `startTestHost` in beforeAll, `copy(key)` for names, `signUp`).

**Gate macros**, run as single commands, one at a time:
- **G-go:** `go vet ./internal/...`, then `go test -race -shuffle=on ./internal/api/... ./internal/gateway/... ./internal/dillad/...`.
- **G-docs:** `npm run check:docs`.
- **G-core:** `npm test -w @dilla/client-core`, `npm run typecheck -w @dilla/client-core`, `npx eslint --max-warnings 0 packages/client-core`.
- **G-ui:** `npm test -w packages/ui`, `npm run typecheck -w packages/ui`, `npm run build-storybook -w packages/ui`, `npm run test:storybook:ci -w packages/ui`.
- **G-web:** `npm test -w @dilla/web`, `npm run typecheck -w @dilla/web`, `npx eslint --max-warnings 0 packages/web`, `npm run check:copy`.
- **G-e2e(spec):** `npm run build -w @dilla/web`, then `npm run test:e2e:web:chromium -w @dilla/e2e -- <spec>` (and `:firefox`).

---

## Phase 0: sequential, on the wave branch

### Task T0: Hotspot prep for parallel lanes

**Model:** sonnet. **Behaviour-preserving**: no visible change.

**Files:**
- Create: `packages/web/src/strings/admin.ts`, `members.ts`, `moderation.ts`
- Modify: `packages/web/src/strings/en.ts`
- Modify: `packages/client-core/src/worker/controller.ts` (COMMANDS :162-171, ID_FIELDS :178-187, ACCEPTS.ready :200-206, `invalid()` before its final `return null` ~:323)
- Create: `packages/web/src/strings/strings.flow08.test.ts`
- Create: `docs/design/flows/08-server-admin.md`

- [ ] **Step 1.** Create the three feature string files. Each is exactly:
  ```ts
  // Flow 08 (docs/design/flows/08-server-admin.md): server admin and moderation copy. Keys: <prefix>.*
  export const admin = {} as const;      // members.ts: export const members; moderation.ts: export const moderation
  ```
  In en.ts, import them next to the `privacy` import and spread `...admin, ...members, ...moderation` immediately after `...privacy` in the `en` object.
- [ ] **Step 2.** In controller.ts:
  - Rewrite COMMANDS, ID_FIELDS and ACCEPTS.ready so each entry is on its own line, in the same order with the same values.
  - Widen ID_FIELDS' field-name union with `'inviteId'`.
  - Add, above `invalid()`:
    ```ts
    /** Per-feature synchronous checks (wave 1+): each returns an E_BAD_INPUT reason or null. */
    const VALIDATORS: Partial<Record<Method, (c: Record<string, unknown>) => string | null>> = {};
    ```
  - In `invalid()`, immediately before its final `return null`, add:
    ```ts
    const extra = VALIDATORS[m as Method]?.(command) ?? null;
    if (extra !== null) return extra;
    ```
    Use the local names `invalid()` already uses.
- [ ] **Step 3.** Create `strings.flow08.test.ts`, modelled on strings.test.ts:125-147. It:
  - reads `docs/design/flows/08-server-admin.md` from `## Copy` onward;
  - collects the pairs with ``/`([a-zA-Z][\w.]*)='([^`]*)'`/g``;
  - asserts every pair equals `en[key]` byte for byte;
  - asserts every en key matching `/^(admin|members|mod|removed)\./` is listed;
  - asserts no pair value contains a word from strings.test.ts's FORBIDDEN list (import or copy the list).

  It passes vacuously now.
- [ ] **Step 4.** Create `08-server-admin.md` with the title `# Flow 08: server admin and moderation (v0.1.0-web3.4)` and the empty headings `## States`, `## 1280×800`, `## 360×740`, `## Keyboard map`, `## Focus rules`, `## Announcements`, `## Copy`.
- [ ] **Step 5.** Gates: G-core and G-web. `git diff --stat` lists only the files above.
- [ ] **Step 6.** Commit: `chore(web,client-core): per-feature string files and one-per-line command lists for parallel lanes`.

### Task T1: Flow 08 copy and doc

**Model:** haiku. **Depends on:** T0.

**Files:** `packages/web/src/strings/{admin,members,moderation}.ts`, `en.ts` (flows 06/07 keys), `docs/design/flows/08-server-admin.md`, `07-create.md` (Copy), `06-voice.md` (Copy), `strings.flow08.test.ts`, `strings.test.ts` (the lower-case lists).

- [ ] **Step 1.** Paste the exact keys below into the files named. Values are exact, including typographic ’ and …. In `members.ts`:
  ```
  members.toggle='members'  members.region='members of {server}'  members.group='{name} — {count}'
  members.groupMembers='members'  members.owner='owner'  members.you='you'  members.bot='bot'
  members.actions='actions for {name}'  members.menu.message='message'  members.menu.compare='compare safety numbers'
  members.menu.kick='kick'  members.menu.ban='ban'  members.loading='Loading members…'
  members.empty='No one else is in this server yet.'  members.close='close members'
  ```
  In `moderation.ts`:
  ```
  mod.cancel='Cancel'
  mod.kick.title='Kick {name} from {server}?'
  mod.kick.body='{name} leaves every channel and call of {server} at once. They can join again with an invite. Messages they already received stay on their devices.'
  mod.kick.confirm='Kick'  mod.kick.busy='Kicking…'  mod.kick.done='{name} was kicked.'
  mod.kick.error.forbidden='You cannot kick {name}. Their highest role is at or above yours, or your roles do not allow kicking.'
  mod.kick.error.gone='{name} is no longer in {server}.'
  mod.ban.title='Ban {name} from {server}?'
  mod.ban.body='{name} leaves every channel and call of {server} at once and cannot join again until the ban ends or is lifted. Messages they already received stay on their devices.'
  mod.ban.reason='Reason'  mod.ban.reasonHint='Optional. Shown to moderators in the ban list, not to {name}. Up to 512 bytes.'
  mod.ban.duration='Ban length'  mod.ban.duration.hour='1 hour'  mod.ban.duration.day='1 day'  mod.ban.duration.week='7 days'
  mod.ban.duration.month='30 days'  mod.ban.duration.forever='until lifted'
  mod.ban.confirm='Ban'  mod.ban.busy='Banning…'  mod.ban.done='{name} was banned.'
  mod.ban.error.forbidden='You cannot ban {name}. Their highest role is at or above yours, or your roles do not allow banning.'
  mod.ban.error.reasonLong='That reason is too long. A reason is up to 512 bytes.'
  mod.ban.error.reasonControl='A reason cannot hold control characters other than line breaks and tabs.'
  mod.ban.error.clock='The ban length was refused. Check this device’s clock and try again.'
  mod.error.other='That did not work ({code}). Try again.'
  removed.notice='You are no longer in {server}.'
  ```
  In `admin.ts`, every key and value below:
  ```
  admin.open='server settings'  admin.title='Server settings'  admin.nav='server settings sections'
  admin.nav.overview='overview'  admin.nav.channels='channels'  admin.nav.invites='invites'  admin.nav.bans='bans'
  admin.nav.delete='delete server'  admin.nav.leave='leave server'  admin.cancel='Cancel'
  admin.overview.title='Overview'  admin.overview.name='Server name'
  admin.overview.hint='Up to 255 bytes. Everyone in the server, and the host, can read it.'
  admin.overview.save='Save'  admin.overview.saving='Saving…'  admin.overview.saved='Saved.'
  admin.overview.error.empty='Give the server a name.'
  admin.overview.error.long='That name is too long. A server name is up to 255 bytes.'
  admin.overview.error.refused='That name was refused. Try another.'
  admin.overview.error.forbidden='You cannot rename this server.'
  admin.overview.error.conflict='Someone else changed the server at the same time. Check the name and save again.'
  admin.overview.error.other='Could not save ({code}). Try again.'
  admin.channels.title='Channels'  admin.channels.newCategory='new category'  admin.channels.edit='edit'
  admin.channels.editLabel='edit {name}'  admin.channels.up='move up'  admin.channels.upLabel='move {name} up'
  admin.channels.down='move down'  admin.channels.downLabel='move {name} down'  admin.channels.delete='delete'
  admin.channels.deleteLabel='delete {name}'  admin.channels.noCategory='no category'  admin.channels.moved='{name} moved.'
  admin.channels.error.move='Could not move {name} ({code}). Try again.'
  admin.category.title='New category in {server}'  admin.category.name='Category name'
  admin.category.hint='Up to 100 bytes. A category groups channels in the list; it holds no messages.'
  admin.category.submit='Create'  admin.category.busy='Creating…'  admin.category.error.empty='Give the category a name.'
  admin.category.error.other='Could not add the category ({code}). Try again.'
  admin.channel.open='edit channel'  admin.channel.titleText='Edit #{name}'  admin.channel.titleVoice='Edit {name}'
  admin.channel.titleCategory='Edit category {name}'  admin.channel.name='Channel name'  admin.channel.nameHint='Up to 100 bytes.'
  admin.channel.topic='Topic'  admin.channel.topicHint='Shown under the channel name. Up to 1024 bytes. The host can read it.'
  admin.channel.category='Category'  admin.channel.save='Save'  admin.channel.saving='Saving…'
  admin.channel.error.empty='Give the channel a name.'
  admin.channel.error.long='That name is too long. A channel name is up to 100 bytes.'
  admin.channel.error.topicLong='That topic is too long. A topic is up to 1024 bytes.'
  admin.channel.error.topicControl='A topic cannot hold control characters other than line breaks and tabs.'
  admin.channel.error.forbidden='You cannot change this channel.'
  admin.channel.error.refused='That change was refused. Check the fields and try again.'
  admin.channel.error.gone='This channel no longer exists.'
  admin.channel.error.other='Could not save the channel ({code}). Try again.'
  admin.channelDelete.titleText='Delete #{name}?'  admin.channelDelete.titleVoice='Delete {name}?'
  admin.channelDelete.titleCategory='Delete category {name}?'
  admin.channelDelete.body='It is removed for everyone, with its messages and files. Copies someone already saved stay with them. This cannot be undone.'
  admin.channelDelete.bodyVoice='It is removed for everyone, and a call in it ends. This cannot be undone.'
  admin.channelDelete.bodyCategory='The category is removed; its channels stay, without a category. This cannot be undone.'
  admin.channelDelete.confirm='Delete'  admin.channelDelete.busy='Deleting…'
  admin.channelDelete.error.other='Could not delete ({code}). Try again.'
  admin.invites.title='Invites'  admin.invites.new='new invite link'  admin.invites.expires='Expires after'
  admin.invites.ttl.halfHour='30 minutes'  admin.invites.ttl.hour='1 hour'  admin.invites.ttl.sixHours='6 hours'
  admin.invites.ttl.halfDay='12 hours'  admin.invites.ttl.day='1 day'  admin.invites.ttl.week='7 days'
  admin.invites.ttl.month='30 days'  admin.invites.uses='Max uses'  admin.invites.uses.one='1 use'
  admin.invites.uses.n='{n} uses'  admin.invites.limitsNote='An invite lasts at most 30 days and admits at most 1000 people.'
  admin.invites.create='Make link'  admin.invites.creating='Making an invite link…'  admin.invites.empty='No live invite links.'
  admin.invites.row='by {name}, {used} of {max} uses, expires {date}'
  admin.invites.codeHidden='The server keeps only a fingerprint of each link, so a link cannot be shown again. Make a new one to share.'
  admin.invites.revoke='revoke'  admin.invites.revokeLabel='revoke the link by {name} that expires {date}'
  admin.invites.revoked='Invite link revoked.'
  admin.invites.error.forbidden='You cannot revoke this link. Only its maker or someone who manages the server can.'
  admin.invites.error.load='Could not load the invite links ({code}).'  admin.invites.error.other='That did not work ({code}). Try again.'
  admin.bans.title='Bans'  admin.bans.loading='Loading bans…'  admin.bans.empty='Nobody is banned from {server}.'
  admin.bans.by='banned by {name} on {date}'  admin.bans.until='ends {date}'  admin.bans.forever='until lifted'
  admin.bans.lapsed='ended {date}; can join again'  admin.bans.noReason='no reason given'
  admin.bans.unknownUser='a deleted account'  admin.bans.unban='unban'  admin.bans.unbanLabel='unban {name}'
  admin.bans.unbanTitle='Unban {name}?'  admin.bans.unbanBody='{name} can join {server} again with an invite. This does not add them back.'
  admin.bans.unbanConfirm='Unban'  admin.bans.unbanBusy='Unbanning…'  admin.bans.unbanned='{name} was unbanned.'
  admin.bans.error.load='Could not load the ban list ({code}).'  admin.bans.retry='Try again'
  admin.leave.open='leave server'  admin.leave.title='Leave {server}?'
  admin.leave.body='You leave every channel and call of {server}. To come back you need an invite.'
  admin.leave.confirm='Leave'  admin.leave.busy='Leaving…'
  admin.leave.owner='You own {server}, so you cannot leave it. Hand it to another member or delete it.'
  admin.leave.error.other='Could not leave ({code}). Try again.'  admin.left='You left {server}.'
  admin.delete.title='Delete {server}?'
  admin.delete.body='Every channel, message and file of {server} is removed for everyone, and every call in it ends. Copies someone already saved stay with them. This cannot be undone.'
  admin.delete.confirmName='Type the server name to confirm'  admin.delete.mismatch='That is not the server name.'
  admin.delete.confirm='Delete server'  admin.delete.busy='Deleting…'
  admin.delete.error.forbidden='Only the owner can delete this server.'
  admin.delete.error.other='Could not delete the server ({code}). Try again.'  admin.delete.done='{server} was deleted.'
  admin.nav.transfer='hand over server'
  admin.transfer.title='Hand {server} to another member'
  admin.transfer.body='The member you choose becomes the owner, with every permission. You stay in {server} as a member and can no longer delete it. This cannot be undone by you.'
  admin.transfer.member='New owner'  admin.transfer.confirmName='Type the server name to confirm'
  admin.transfer.confirm='Hand over'  admin.transfer.busy='Handing over…'  admin.transfer.done='{name} now owns {server}.'
  admin.transfer.none='There is no other member to hand the server to yet.'
  admin.transfer.error.forbidden='Only the owner can hand over this server.'
  admin.transfer.error.gone='That member is no longer in {server}. Choose another.'
  admin.transfer.error.other='Could not hand over the server ({code}). Try again.'
  ```
  In en.ts (flow 07): `invite.options='more options'`. In en.ts (flow 06): `voice.diag.tracks='hearing {attached} of {expected}'` and `voice.outputFailed='The output device did not change. Call sound plays where it did before.'`
- [ ] **Step 2.** Write the `## Copy` section of 08 as a bulleted list of `` `key='value'` `` pairs: every admin, members, mod and removed key above. Add `invite.options` to 07's Copy and the two voice pairs to 06's Copy.
- [ ] **Step 3.** Write 08's `## States` table with one row per state, each naming its copy keys:
  - members closed / open-wide / open-overlay;
  - members loading / empty / grouped;
  - menu open by button, right-click and Shift+F10;
  - kick idle / busy / refused (forbidden, gone, other);
  - ban idle / busy / refused (forbidden, reasonLong, reasonControl, clock, other);
  - settings tabs by permission;
  - overview idle / busy / saved / error (empty, long, refused, forbidden, conflict, other);
  - channels list (edit, up, down, delete, new category, edit dialog, delete confirm);
  - invites (make with options, made, live list, revoke, codeHidden);
  - bans loading / error / empty / list / unban;
  - leave (non-owner) / owner cannot leave / delete with typed name / hand over;
  - removed (banner, rail, navigation);
  - banned rejoin refused (the existing `join.error.forbidden`).

  Fill `## Keyboard map`, `## Focus rules` and `## Announcements` from the Task U1–U6 and W1–W3 behaviour lines.
- [ ] **Step 4.** In strings.flow08.test.ts, add `expect(pairs.length).toBe(<the exact number of admin, members, mod and removed pairs>)`. In strings.test.ts's lower-case chrome lists, add `members.toggle`, `members.menu.*`, `admin.open`, `admin.nav.*`, `admin.channels.edit|up|down|delete|newCategory`, `admin.invites.new|revoke`, `admin.bans.unban`, `admin.leave.open`, `admin.channel.open` and `invite.options`.
- [ ] **Step 5.** Red first: run `npx vitest run --root packages/web src/strings` with the keys added but before the 08 Copy section is written. Record the failure, then write the section and get it green. Gates: G-web.
- [ ] **Step 6.** Commit: `docs(flows): flow 08 server admin and moderation copy`.

---

## Phase 1: four parallel lanes. Each lane is sequential inside, in its own `git clone --shared`.

### Task S1: Own permissions read route
**Model:** sonnet. **Lane:** SRV. **Files:** `internal/api/communities.go` (Register :81-91; a handler after `members` ~:650), `internal/api/communities_test.go`, `protocol/09-http-api.md` (§ Communities).

- [ ] **Route:** `mux.HandleFunc("GET /v1/communities/{id}/permissions", c.permissions)`. The handler follows the recipe. A member only, else 404 (`notFound`). It answers `permissionsResp{_ struct{} cbor:",toarray"; Bits uint64; Top uint64}`:
  - `Bits = snap.Resolve(uid)` community-wide, with no channel overwrite;
  - `Top` = `1<<31` when uid is the owner, otherwise the highest position among the caller's roles, and 0 when only @everyone.
- [ ] **Tests, red first:**
  - the owner gets `[PermAll, 2147483648]`;
  - a fresh member gets `[everyoneRoleAllow, 0]`;
  - a member granted a role at position 5 with PermKickMembers gets `[everyoneRoleAllow|PermKickMembers, 5]`;
  - a role with administrator gives `PermAll`;
  - @everyone with view denied gives `[0, 0]`;
  - a non-member and an unknown community both get 404.
- [ ] **protocol/09 row**, after the `/members?after=` row: `| \`GET /v1/communities/{id}/permissions\` | — | \`[bits(uint), top(uint)]\`: the caller's community-wide permissions (§ Permissions; no channel overwrite applied) and the position of the caller's highest role, \`0\` for \`@everyone\` alone and \`2147483648\` for the owner |`. Add the bullet: "Any member reads their own. A client uses it to offer only what the instance allows and still handles every refusal."
- [ ] **Gates:** G-go, G-docs. **Commit:** `feat(api): a member reads their own community permissions`.

### Task S2: Roles list route
**Model:** sonnet. **Lane:** SRV. **Files:** `internal/api/roles.go` (Register :89-95), `roles_test.go`, protocol/09 § Roles.

- [ ] **Route:** `GET /v1/communities/{id}/roles`, open to any member; a non-member gets 404. The handler calls `ListRoles` and sorts by position, then role_id (the existing `byPositionThenID` if present, else equivalent). It answers `[[role_id(bstr16), name, color(uint), position(uint), allow(uint), deny(uint), hoist(uint 0/1), mentionable(uint 0/1)]]`, with allow and deny masked by `PermAll`.
- [ ] **Tests:**
  - a new community gives exactly one row `[everyoneID, "@everyone", 0, 0, everyoneRoleAllow, 0, 0, 0]`;
  - after a POST of a role at position 3, two rows in that order;
  - a stored bit `1<<40` is cleared in the answer;
  - a non-member gets 404.
- [ ] **protocol/09:** the § Roles intro becomes "…every one needs `manage_roles`, except `GET`, which any member may read". Add a first row with that shape: "every role ordered by `position` then `role_id`, `@everyone` first; bits outside § Permissions are cleared".
- [ ] **Gates:** G-go, G-docs. **Commit:** `feat(api): members read a community's roles`.

### Task S3: Ban list carries names
**Model:** sonnet. **Lane:** SRV. **Files:** `internal/api/bans.go` (`banResp` :180-187, list :192-213), `bans_test.go`, protocol/09 § Bans.

- [ ] Append `Username, Display string` to `banResp`, filled from `GetUser(ctx, userID)`. `store.ErrNotFound` gives `""` for both.
- [ ] **Tests:** a list row has length 7 with the right username and display; a deleted account gives `""` for both.
- [ ] **protocol/09:** the GET bans row becomes `[[user_id, reason, by_user, created, expires(uint|null), username(tstr), display(tstr)]]`, newest first; `username`/`display` are `""` for an account that no longer exists.
- [ ] **Gates:** G-go, G-docs. **Commit:** `feat(api): the ban list names each banned account`.

### Task S4: op 54 fan-out on membership, role and delete changes
**Model:** opus. **Lane:** SRV. **Files:**
- `internal/api/structurenotify.go`
- `communities.go` (join, leave :730, removeMember :675-712, delete :762)
- `bans.go` (put :63-155)
- `roles.go` (create, patch, delete, grant, revoke, overwrite put/delete)
- `internal/dillad/routes.go:107-112`
- `structurenotify_test.go`
- protocol/02:385-394, protocol/09 § Bans.

- [ ] **Notifier API:**
  - `func (n *StructureNotifier) Removed(ctx, cid, uid store.ID)` sends op 54 `[cid]` once to every live connection of uid.
  - `func (n *StructureNotifier) ChangedTo(ctx, cid, users []store.ID)` sends to a list already known; used by delete, where the members are listed inside the tx before the tombstone.
  - Add `Bans.WithNotifier` and `Roles.WithNotifier` and wire them in routes.go.
- [ ] **Calls,** all after the commit through `afterCommit(r)`:
  - join: `Changed`, only when a new membership row was made;
  - leave: `Removed(leaver)` + `Changed`;
  - removeMember: `Removed(target)` + `Changed`;
  - ban put: `Removed(target)` only when a member row was deleted, + `Changed`;
  - community delete: `ChangedTo(former members)`;
  - every role and overwrite mutation: `Changed`.
  - Unban and invite changes send nothing.
- [ ] **Tests** (`changedGW` counters):
  - kick: target 1, others 1;
  - ban of a member: target 1;
  - ban of a non-member: target 0;
  - unban: 0;
  - join: old members +1;
  - leave: leaver 1, others 1;
  - delete: every former member 1;
  - grant: all 1;
  - a refused kick (403): 0;
  - 201 members exercises paging.
- [ ] **protocol/02 op 54 prose:** replace "A user who is not a member is never sent it" with three sentences:
  - "It is also sent after a member joins, leaves, is kicked or is banned; after a role is created, changed, deleted, granted or revoked; after a channel overwrite is put or deleted; and after a community is deleted (to its members at that moment)."
  - "The user a leave, kick or ban removed is sent it once, after the commit, to every live connection; a ban of a non-member sends nothing to that user."
  - "No one else is sent it."

  In protocol/09 § Bans, add to the kick/ban bullet "…and, after the commit, the instance sends `community_changed` (`02`) to the remaining members and once to the removed user."
- [ ] **Hand the integrator this protocol/07 row text** in the report: `| 2026-10-14 | e2ee 1, media 1, wire 1 | **Additive.** \`09\` § Communities: \`GET /v1/communities/{id}/permissions\`; § Roles: \`GET /v1/communities/{id}/roles\` (any member); § Communities: \`POST /v1/communities/{id}/owner\`; § Bans: the list gains \`username, display\` (a client reads at least five elements). \`02\` op 54 is also sent on membership, role, overwrite and community-delete changes, and once to a removed user, who then no longer lists the community. No new opcode or code; no version bump |`
- [ ] **Security note in the report:** the frame carries only a community id the user already knew. Confirm no information leaks to a non-member.
- [ ] **Gates:** G-go, G-docs. **Commit:** `feat(api): op 54 follows membership, role and delete changes, and tells a removed member`.

### Task S5: Transfer ownership
**Model:** opus. **Lane:** SRV, after S4. **Files:** `internal/api/communities.go`, `store.go` + both engines' `queries/communities.sql` (a new query `SetCommunityOwner :exec`, byte-identical headers) + adapters + `contract_test.go`, sqlc regenerate, `communities_test.go`, protocol/09 § Communities.

- [ ] **Route:** `POST /v1/communities/{id}/owner`, body `[user_id(bstr16)]`, answer 204.
  - Only the current owner may call it: otherwise 403 "only the owner can hand over a community".
  - A target that isn't a member gets 404. The caller as target gets 400. A bot account gets 400.
  - In one `repo.Tx` under `LockCommunity`: `SetCommunityOwner(cid, target)`, plus an audit row `community.transfer` with Target set to the target and Detail set to the previous owner.
  - After the commit, `Changed`.
  - The previous owner stays a member with their roles.
- [ ] **Tests:**
  - a happy path, after which the old owner's DELETE community gives 403 and the new owner's gives 204;
  - a non-owner caller gets 403;
  - a non-member target gets 404;
  - self gets 400;
  - the audit row is written;
  - the old owner can now `leave` (204).
- [ ] **protocol/09 row**, plus a sentence in the owner paragraph (:238-249): "The owner may hand the community to another member (`POST …/owner`); then they are an ordinary member and may leave."
- [ ] **Gates:** G-go, G-docs, `sqlc diff`. **Commit:** `feat(api): the owner hands a community to another member`.

### Task C1: client-core routes
**Model:** sonnet. **Lane:** CORE. **Files:** `packages/client-core/src/http/routes.ts` (a new banner `// ---- wave 1: server admin and moderation (flow 08) ----` after the create-flow block :58-72, with methods after `listMembers` :280), `routes.test.ts`.

- [ ] Constants and types:
  ```ts
  export const OWNER_TOP = 2 ** 31; export const ROLES_MAX = 250; export const BANS_MAX = 10_000; export const INVITES_MAX = 10_000;
  export const TOPIC_MAX_BYTES = 1024; export const BAN_REASON_MAX_BYTES = 512;
  export interface PermissionsRow { bits: bigint; top: number }   // top 0..OWNER_TOP else E_CBOR_RANGE
  export interface RoleRow { id: Uint8Array; name: string; color: number; position: number; allow: bigint; deny: bigint; hoist: boolean; mentionable: boolean }
  export interface BanRow { userId: Uint8Array; reason: string; byUser: Uint8Array; created: bigint; expires: bigint | null; username: string; display: string }
  export interface InviteRow { id: Uint8Array; communityId: Uint8Array | null; createdBy: Uint8Array | null; maxUses: number; uses: number; created: bigint; expires: bigint; revokedAt: bigint | null }
  ```
- [ ] Methods (bucket and idempotent in brackets):
  - `getPermissions(c)` GET [read, idem];
  - `listRoles(c)` GET [read, idem];
  - `patchCommunity(c,{name})` PATCH, body `[name,null,null,null]` → bigint;
  - `deleteCommunity(c)` DELETE [write, idem];
  - `leaveCommunity(c)` POST `/leave`, body `[]` [write, non-idem];
  - `transferOwnership(c,u)` POST `/owner`, body `[u]` [write, non-idem];
  - `createCategory(c,{name,position})` POST channels `[2,0,0,null,name,'',position,0]`;
  - `patchChannel(ch,{name?,topic?,parent?: Uint8Array|'top',position?})` PATCH `[name|null,topic|null,null,null,parent|null,position|null,null]`, where `'top'` becomes 16 zero bytes;
  - `deleteChannel(ch)`;
  - `kickMember(c,u)` DELETE `/members/{u}`;
  - `putBan(c,u,{reason,expires:bigint|null})` PUT;
  - `deleteBan(c,u)`;
  - `listBans(c)`: rows read with `atLeast(5)`, elements 5 and 6 optional, default `''`;
  - `listInvites(c)`;
  - `revokeInvite(inviteId)` DELETE `/v1/invites/{id}`.

  Check the exact server CBOR orders in channels.go and invites.go before coding, and stop with NEEDS_CONTEXT if any differs from the above.
- [ ] **Tests,** as CASES rows plus rejects:
  - permissions `[16777215, 2147483648]` → `{bits: 16777215n, top: 2147483648}`; `[1]` → E_CBOR_SHAPE; top 2^31+1 → E_CBOR_RANGE;
  - roles: 251 rows → E_CBOR_SHAPE; hoist 2 → E_CBOR_RANGE;
  - patchCommunity sends `['Asgard', null, null, null]`; rejects `''`, 256 bytes and `'\n'`;
  - createCategory sends `[2,0,0,null,'rooms','',3,0]`;
  - patchChannel `{parent:'top'}` puts 16 zero bytes in slot 4; `{position:4}` → `[null,null,null,null,null,4,null]`; rejects a 1025-byte topic and `'\u0000'`, while a topic with `'\n'` passes;
  - putBan with a null expiry → `['spam', null]`; a 513-byte reason is rejected;
  - a 5-element ban row → username `''`;
  - kick 403 → E_FORBIDDEN;
  - the revokeInvite path is `/v1/invites/<hex>`;
  - transferOwnership sends `[u]`.
- [ ] **Gates:** G-core. **Commit:** `feat(client-core): routes for server admin and moderation`.

### Task C2: Slice types and rank helpers
**Model:** sonnet. **Lane:** CORE. **Files:** `src/state/types.ts` (:136-153), a new `src/admin/rank.ts`, `src/index.ts`, a new `src/admin/rank.test.ts`.

- [ ] Types:
  ```ts
  export interface CommunityAccess { top: number; owner: boolean; manageCommunity: boolean; manageChannels: boolean; kickMembers: boolean; banMembers: boolean; createInvite: boolean; manageRoles: boolean }
  export interface RoleSummary { id: string; name: string; color: number; position: number; hoist: boolean; mentionable: boolean }
  export interface BanSummary { userId: string; name: string; reason: string; byUser: string; created: number; expires: number | null }  // name = display||username||''
  export interface InviteSummary { id: string; createdBy: string | null; maxUses: number; uses: number; created: number; expires: number }
  export interface RemovalNotice { id: number; communityId: string; name: string }
  // SliceName += `permissions:${string}` | `roles:${string}` | `bans:${string}` | `invites:${string}` | 'removals' (and SliceTypes)
  ```
- [ ] `rank.ts`:
  - `PERM` has the bits perm.go defines for create_invite, kick_members, ban_members, manage_channels, manage_community, manage_roles and administrator. Copy the numeric values from internal/api/perm.go:22-46 exactly.
  - `accessOf(bits: bigint, top: number, owner: boolean): CommunityAccess`. The owner or administrator gets everything.
  - `topOf(roleIds: readonly string[], roles: readonly RoleSummary[]): number` is the maximum position; an unknown id counts as `OWNER_TOP - 1`.
  - `canModerate({ me, target, owner, myTop, targetTop }): boolean`:
    - false when target === owner or target === me;
    - true when me === owner;
    - false when myTop === 0;
    - otherwise `targetTop < myTop`.
- [ ] **Tests:**
  - a canModerate table: owner target, self, owner actor, myTop 0, equal tops, lower, an unknown role id via topOf;
  - accessOf for the owner and for the default member;
  - the PERM values pinned to the perm.go numbers.
- [ ] **Gates:** G-core. **Commit:** `feat(client-core): access and rank helpers for moderation`.

### Task C3: AdminController and wiring
**Model:** sonnet. **Lane:** CORE, after C1 and C2. **Files:** a new `src/admin/controller.ts` (modelled on `calls/controller.ts:30`, wired like controller.ts:458), `worker/protocol.ts`, `worker/controller.ts` (the T0 lists, `VALIDATORS`, dispatch, `loadCommunity` follow-up, `dropCommunity` :1358), `sync/testing/model.ts`, a new `src/admin/controller.test.ts` reusing exported `world`/`toReady` (export them from controller.test.ts or move them into a shared test helper; your choice, keep both suites green).

- [ ] **Commands,** appended before `resign` in protocol.ts. All are ready-only and return `null` unless noted:
  ```ts
  | { m: 'renameCommunity'; communityId: string; name: string }
  | { m: 'deleteCommunity'; communityId: string }           // dropped before the ret; no removal notice
  | { m: 'leaveCommunity'; communityId: string }            // same
  | { m: 'transferOwnership'; communityId: string; userId: string }
  | { m: 'createCategory'; communityId: string; name: string }   // → { channelId }
  | { m: 'updateChannel'; channelId: string; name: string | null; topic: string | null; parent: string }  // 'keep'|'top'|32-hex
  | { m: 'moveChannel'; channelId: string; direction: 'up' | 'down' }
  | { m: 'deleteChannel'; channelId: string }
  | { m: 'kickMember'; communityId: string; userId: string }
  | { m: 'banMember'; communityId: string; userId: string; reason: string; seconds: number | null }  // 3600..3_153_600_000
  | { m: 'unbanMember'; communityId: string; userId: string }
  | { m: 'loadBans'; communityId: string }      // slice bans:<cid>
  | { m: 'loadInvites'; communityId: string }   // slice invites:<cid>, live only
  | { m: 'revokeInvite'; communityId: string; inviteId: string }
  ```
- [ ] **Behaviour:**
  - After `loadCommunity`, a separate `loadAccess(cid)` reads `getPermissions` and `listRoles` and publishes `permissions:<cid>` (CommunityAccess) and `roles:<cid>`. It's tracked by the barrier and not awaited by `selectCommunity`, and a rejection leaves the slices absent.
  - The mocks for these two reads must not push into controller.test's ordered `calls`.
  - kick, ban, unban and transfer re-read members and permissions afterwards. A 403 on any moderation command also re-reads permissions.
  - A ban sends `expires = BigInt(floor(now/1000) + seconds)`, or null.
  - `moveChannel` swaps positions with the neighbour inside the same parent, patching only the two channels that change.
  - `loadInvites` keeps only rows with `revokedAt === null`, `expires > now` and `uses < maxUses`.
  - `dropCommunity` also clears `permissions:`, `roles:`, `bans:` and `invites:` for that cid.
- [ ] **VALIDATORS** (E_BAD_INPUT): a blank or too-long name, `seconds` outside the range or not an integer, `parent` not one of keep/top/32-hex, a `direction` other than up/down, a reason over 512 bytes.
- [ ] **model.ts:** add the RouteNames and server-rule doubles: permissions (the owner gets PermAll/OWNER_TOP, anyone else default bits/0) and roles (@everyone only).
- [ ] **Tests:**
  - each E_BAD_INPUT above;
  - kick calls `kickMember`, then `listMembers` and `getPermissions`;
  - a ban with 86400 sends `floor(now/1000)+86400`;
  - moveChannel up on c in [a0, b1, c2] patches c→1 and b→2 only; up on the first channel sends no request;
  - deleteCommunity drops before the ret with no removals entry;
  - the permissions slice is published after select; a rejected getPermissions leaves it absent and select still resolves;
  - loadInvites drops revoked, expired and used-up rows;
  - a 403 on kick re-reads permissions.
- [ ] **Gates:** G-core. **Commit:** `feat(client-core): admin and moderation commands`.

### Task C4: Removal notices
**Model:** opus. **Lane:** CORE, after C3. **Files:** `worker/controller.ts` (`refreshCommunities` :1347, `scheduleCommunityReload` :1436), `src/admin/controller.ts` (`selfRemoved`), tests.

- [ ] `refreshCommunities` diffs the previous `communities` slice against the re-read list. A community that was listed, is gone now, and is not in `selfRemoved` (set by deleteCommunity and leaveCommunity before their request) pushes `{ id: ++n, communityId, name }` to the `removals` slice, keeping the 8 newest.
  - There is no notice on the first list after ready, or after a fresh boot.
  - The page dismisses notices locally.
- [ ] **Tests:**
  - op 54 for a listed community whose re-read lacks it → dropped, one removals entry, its slices cleared, `selected` null;
  - leave or delete → no entry;
  - the first list at ready → none;
  - a ninth removal drops the oldest;
  - a removal during an active call in that community throws nothing and publishes no stale `voice` state (the call ends through the existing `removed` phase);
  - a removal while the sync engine holds an op 17 own-Remove (engine.ts:318-345) throws nothing.
- [ ] **Gates:** G-core. **Commit:** `feat(client-core): a removed member is told`.

### Tasks U1–U6: packages/ui primitives
**Model:** sonnet. **Lane:** UI, in the order U1 → U6. Each is one component folder plus an `index.ts` export, with stories and tests. **Gates:** G-ui. Commit one per component: `feat(ui): <Component>`.

- [ ] **U1 ActionMenu.**
  ```ts
  export interface ActionMenuItem { id: string; label: string; danger?: boolean }
  export interface ActionMenuProps { label: string; items: readonly ActionMenuItem[]; open: boolean; onOpenChange(open: boolean): void;
    onSelect(id: string): void; at?: { x: number; y: number } | null }
  ```
  - WAI-ARIA menu button. Enter, Space or ArrowDown opens on the first item; ArrowUp opens on the last.
  - Arrows wrap; Home and End work.
  - Escape closes and refocuses the trigger. Tab closes. An outside pointerdown closes.
  - `at` positions the popup at the pointer, clamped to the viewport.
  - `danger` items use `--danger`.

  Tests: each key behaviour above; select calls onSelect and closes; axe.
- [ ] **U2 ConfirmDialog + Select.**
  ```ts
  export interface ConfirmDialogProps { open: boolean; title: string; body: string; confirmLabel: string; busyLabel: string; cancelLabel: string;
    tone?: 'danger' | 'accent'; busy: boolean; error: string | null; attempt?: number; canConfirm?: boolean; children?: ReactNode;
    onConfirm(): void; onClose(): void }
  export interface SelectProps { label: string; hint?: string; value: string; options: readonly { value: string; label: string }[]; onChange(v: string): void; disabled?: boolean }
  ```
  - ConfirmDialog wraps `Dialog`. Focus goes to the first field in children, otherwise to Cancel, never to the destructive button.
  - Confirm is disabled when `!canConfirm || busy`.
  - The error has `role=alert` and is re-announced when `attempt` changes.
  - Select is a native `<select>` styled like TextField.

  Tests: each focus rule; disabled confirm; error re-announce; axe.
- [ ] **U3 MemberList.**
  ```ts
  export interface MemberListMember { id: string; name: string; tags: readonly string[]; actionsLabel: string; actions: readonly ActionMenuItem[] }
  export interface MemberListGroup { id: string; title: string; members: readonly MemberListMember[] }
  export interface MemberListProps { label: string; groups: readonly MemberListGroup[]; loading: boolean; loadingLabel: string; emptyLabel: string;
    onAction(memberId: string, actionId: string): void }
  ```
  - One section per group with an `h3`. Rows are a `ul role=list`.
  - A row's actions use an ActionMenu trigger. Right-click (`contextmenu`) opens it at the pointer; Shift+F10 or the ContextMenu key opens it at the trigger.
  - A row with no actions has no trigger.

  Tests: headings; contextmenu at the pointer; Shift+F10; no trigger without actions; loading and empty states; axe.
- [ ] **U4 ManageList.**
  ```ts
  export interface ManageListRow { id: string; title: string; detail: readonly string[]; action: { label: string; ariaLabel: string } | null }
  export interface ManageListProps { label: string; rows: readonly ManageListRow[]; emptyLabel: string; busyId: string | null; onAction(id: string): void }
  ```
  Tests: the empty label; `ariaLabel` used as the accessible name; `busyId` disables only that row; axe.
- [ ] **U5 ChannelSettings.** A form dialog modelled on `CreateChannel`:
  ```ts
  export interface ChannelSettingsProps { open: boolean; kind: 'text' | 'voice' | 'category'; name: string; onName(v: string): void;
    topic: string; onTopic(v: string): void; parent: string; parents: readonly { value: string; label: string }[]; onParent(v: string): void;
    error: string | null; busy: boolean; attempt?: number;
    labels: { title: string; name: string; nameHint: string; topic: string; topicHint: string; category: string; submit: string; busy: string; close: string };
    onSubmit(): void; onClose(): void }
  ```
  Topic shows only for `text`; the category select is hidden for `category`. Tests: those visibility rules; Enter submits; axe.
- [ ] **U6 AppShell `aside` slot** (AppShell.tsx:4-63, AppShell.css, styles/base.css:34-36).
  - New props: `aside?: ReactNode; asideLabel?: string; asideOpen?: boolean; onAsideClose?(): void`.
  - The DOM order is `<main>`, then `<aside aria-label>`, then the status bar.
  - At shell width ≥ 64rem it's a fourth grid column `var(--sidebar-w)`. Below that it's an overlay drawer from the right, `min(20rem, 100%)` wide, where Escape calls `onAsideClose` and focus moves into it on open.
  - When closed it isn't rendered.
  - A shell without `aside` keeps today's grid byte for byte.

  Tests: no aside → the existing tests and `app-css.test.ts` are unchanged; open → an `aside` landmark after main; closed → absent; Escape in the overlay calls onAsideClose. Stories at 1280, 900 and 360 widths.

### Tasks V1–V5: voice follow-ups
**Lane:** VOICE. **Files:** `packages/web/src/call/session.ts`, `session.test.ts`, `screens/voice/useCall.tsx`, `VoiceView.tsx` (+ tests), `e2e/voice/*`, `docs/deploy/README.md`. **Gates:** G-web, plus `npm run test:e2e:voice:chromium -w @dilla/e2e -- <spec>` for V3 and V4.

- [ ] **V1 (opus): output device mid-call.**
  - Add `PageCall.setOutput(id: string): Promise<void>`, reusing the context-sink logic at session.ts ~:300.
  - In useCall, an effect on `settings[SETTINGS.voiceOutput]` calls it while connected, modelled on the effect at ~:547.
  - A rejection announces `voice.outputFailed`.

  Tests: the fake ctx `setSinkId` is called with the new id mid-call; a ctx without `setSinkId` is a no-op; a rejection announces. Commit: `feat(web): the output device follows Settings during a call`.
- [ ] **V2 (opus): "hearing" diagnostic.**
  - Add `PageCallState.audio: { attached: number; expected: number }`, where expected is the subscribed remote audio tracks (pending plus attached) and attached is the attached ones.
  - The dock shows `voice.diag.tracks` near VoiceView ~:490 when `expected > 0`, with `data-audio-attached` and `data-audio-expected` attributes.

  Tests: counts across subscribe, unsubscribe, deafen (pending, so attached stays the same) and undeafen. Commit: `feat(web): the voice dock says how many people it hears`.
- [ ] **V3 (opus): autoplay-restricted e2e.**
  - In `e2e/voice/autoplay.spec.ts` on the voice config's host, an init script wraps `AudioContext` so a new context starts `suspended` and `resume()` succeeds only during user activation.
  - The test expects `voice.audioBlocked`, presses `voice.audioStart`, then expects `audible`.
  - Show it red with `startAudio` stubbed to a no-op, then green. Chromium.

  Commit: `test(e2e): call audio held back by the browser comes back with one press`.
- [ ] **V4 (opus): audible screen-share audio.**
  - Extend `e2e/voice/share.spec.ts` with a Chromium-only share of a tone page, using the `--auto-select-tab-capture-source-by-title` launch arg plus audio.
  - `audible` at the other peer for the share's audio track.
  - Show it red with screen-audio attach disabled.

  Commit: `test(e2e): screen-share audio is heard`.
- [ ] **V5 (haiku).** In docs/deploy/README.md, after the upgrade command (~:354), add: "Add `--check-args` to the same command first: it checks the arguments and changes nothing, and exits 0 without output when they are valid." Run check:docs. Commit: `docs(deploy): check upgrade arguments first`.

---

## Phase 2: parallel lanes after Phase 1 is integrated

### Task W1: Member pane and moderation flows
**Model:** sonnet. **Lane:** WEB-A. **Files:** new `packages/web/src/screens/admin/members-model.ts`, `MemberPane.tsx`, `Moderation.tsx`, plus tests.

- [ ] `memberGroups(members, roles, ownerId, selfId)`:
  - groups by each member's highest **hoisted** role (by position, highest first);
  - puts everyone else in `members.groupMembers`;
  - sorts names with `localeCompare`;
  - tags each member `members.owner`, `members.you` or `members.bot`.
- [ ] `menuFor(member, access, ctx)` builds the items:
  - `message` (openDm), not shown on self;
  - `compare` (navigate to the privacy compare route that exists for safety numbers);
  - `kick` when `access.kickMembers && canModerate(...)`;
  - `ban` when `access.banMembers && canModerate(...)`.
- [ ] `MemberPane` renders `MemberList` from the `members:<cid>`, `roles:<cid>` and `permissions:<cid>` slices.
- [ ] `KickFlow` and `BanFlow` use ConfirmDialog with Create.tsx's guards.
  - Ban has a reason TextField and a Select for the length: hour 3600, day 86400, week 604800, month 2592000, forever null.
  - Refusals map as follows: 403 → `mod.*.error.forbidden`; 404 → `mod.kick.error.gone`; 400 with seconds → `mod.ban.error.clock`; a reason too long → `reasonLong`; control characters → `reasonControl`; else `mod.error.other`.
  - On success, announce `mod.*.done` through the existing shell announcer.
- [ ] **Tests (FakeClient):**
  - grouping by hoisted role;
  - the owner and you tags;
  - kick and ban hidden on the owner and on a higher-ranked target;
  - a ban sends `seconds: 86400` and the reason;
  - each refusal mapping;
  - `expectNoAxeViolations`.
- [ ] **Gates:** G-web. **Commit:** `feat(web): member list with kick and ban`.

### Tasks W2a–W2d: Server settings
**Model:** sonnet. **Lane:** WEB-B, sequential. **Files:** new `screens/admin/ServerSettings.tsx`, `OverviewSection.tsx`, `DangerSection.tsx`, `ChannelsSection.tsx`, `ChannelEditFlow.tsx`, `InvitesSection.tsx`, `BansSection.tsx`, plus tests; `screens/Create.tsx` (~:388, the InviteFlow `invite.options` link). **Gates:** G-web for each.

- [ ] **W2a: frame, overview and danger.**
  - A `SettingsFrame` dialog titled `admin.title`, with nav `admin.nav`. Each tab is shown only with its permission:
    - overview needs `manageCommunity`;
    - channels needs `manageChannels`;
    - invites needs `createInvite`;
    - bans needs `banMembers`;
    - danger is always shown.
  - Overview renames the server and maps 409 → `admin.overview.error.conflict`.
  - Danger:
    - The owner sees `admin.leave.owner`, plus delete server (ConfirmDialog, enabled only when the typed name `.normalize('NFC').trim()` equals the server name with the same normalisation) and **hand over server**.
    - Hand over is a Select of the other members plus the typed-name confirm, calling `transferOwnership`, with `admin.transfer.none` when there's no one else.
    - A non-owner sees leave server.

  Tests:
  - tab visibility per access;
  - a 409 gives the conflict copy;
  - the NFC typed-name match: "Björn" typed as NFD matches;
  - the owner sees the leave refusal text;
  - transfer sends the chosen userId, and its 404 gives `admin.transfer.error.gone`.

  Commit: `feat(web): server settings overview and danger zone`.
- [ ] **W2b: channels.**
  - A list grouped by category, with edit / up / down / delete per row and a "new category" button.
  - The ChannelEditFlow uses `ChannelSettings`: parent `top` for no category, and `keep` when unchanged.
  - Delete uses ConfirmDialog with the per-kind title and body.

  Tests: up and down send `moveChannel`; a category is created; an edit sends `parent: 'top'` for no category; delete confirm text per kind. Commit: `feat(web): channel admin in server settings`.
- [ ] **W2c: invites.**
  - Options: "Expires after" (30m 1800, 1h 3600, 6h 21600, 12h 43200, 1d 86400, 7d 604800 as the default, 30d 2592000) and "Max uses" (1, 5, 10 as the default, 25, 50, 100, 1000).
  - "Make link" shows the existing InviteLink.
  - The live list comes from `invites:<cid>` with revoke. The `admin.invites.codeHidden` note is always shown.
  - InviteFlow (Create.tsx ~:388) keeps its quick path and adds an `invite.options` link that opens settings on the invites tab.

  Tests: the options map to ttlSeconds and maxUses; a revoke 403 gives its copy; the codeHidden note is present. Commit: `feat(web): invite links with limits, list and revoke`.
- [ ] **W2d: bans.**
  - The `bans:<cid>` list through ManageList.
  - Row details: `admin.bans.by`, then `until`, `forever` or `lapsed`, and the reason (or `noReason`).
  - The name is `unknownUser` for `''`.
  - Unban goes through a ConfirmDialog.

  Tests: lapsed, forever and unknown-user rows; the unban confirm and its announcement. Commit: `feat(web): ban list and unban`.

## Phase 3: sequential

### Task W3: Shell integration
**Model:** sonnet; the sole owner of `packages/web/src/screens/Shell.tsx`. **Files:** Shell.tsx (state ~:166-169, actions ~:704-712, mounts ~:924-937), Shell tests.

- [ ] Mount the aside with MemberPane:
  - The `members` toggle is a pressed button in the ChannelHeader actions.
  - It defaults to open at ≥ 64rem. Its state lives in the page and isn't persisted.
- [ ] Add `admin.open` for every member, `admin.leave.open` for non-owners, and `admin.channel.open` with `manageChannels`.
- [ ] The "new channel" button follows `permissions:<cid>.manageChannels`, falling back to ownership while the slice is absent.
- [ ] Hold `adminTab` state for ServerSettings.
- [ ] On a new `removals` entry:
  - show `removed.notice` in the banner slot with `shell.banner.dismiss`;
  - if the route's server is gone, navigate to the first listed server or `/`;
  - close any open admin dialog or confirm for that server.
- [ ] **Tests:** a removal navigates and shows the banner; the toggle's pressed state; the new-channel button follows `manageChannels`; dialogs close on removal.
- [ ] **Gates:** G-web. **Commit:** `feat(web): server admin and member list in the shell`.

### Task E1: Admin e2e from an empty instance
**Model:** sonnet. **Files:** new `e2e/web/admin.spec.ts`. Own host `{ port: 8487, control: 8488, webRoot: 'packages/web/dist' }` in the create.spec.ts pattern; serial; a second browser through the existing two-browser helper.

- [ ] Steps:
  1. A (Ada) signs up with the bootstrap invite and starts "Midgard Crew".
  2. A makes an invite; B (Björn) signs up through it.
  3. A's member list shows Björn.
  4. A renames the server to "Asgard Crew", and B's rail shows the new name without a reload.
  5. A edits #general to the name "lobby" and the topic "welcome", and B sees both.
  6. A kicks Björn: B's rail loses the server, B sees `removed.notice`, and B's URL leaves the server.
  7. B rejoins with the same link and succeeds.
  8. A bans Björn with the reason "spam" for 1 day, and B sees the notice.
  9. B's join shows `join.error.forbidden`.
  10. A's bans tab shows Björn, "spam" and `admin.bans.by{name:'Ada'}`. A unbans him, and the tab shows `admin.bans.empty`.
  11. B rejoins.
  12. B's menu for Ada lists only message and compare, and B's settings show only the invites and danger tabs, with leave.
  13. B leaves, and A's list drops Björn.
  14. B rejoins. A hands the server to Björn, and A's danger tab now shows leave.
  15. Björn deletes the server (typed name). Both rails are empty, and A sees the notice.
  16. `expectAccessible` on the members pane, the settings dialog and the ban confirm.
- [ ] **Gates:** G-e2e(admin.spec.ts), chromium and firefox. **Commit:** `test(e2e): run a server from an empty instance`.

### Task E2: membership.spec follows removal
**Model:** sonnet. **Files:** `e2e/web/membership.spec.ts`. After `/debug/kick`, the spec expects `removed.notice` and no rail item (it used to expect not-member with the tab open). After re-admission it expects the server back and messages flowing. **Gates:** G-e2e(membership.spec.ts). **Commit:** `test(e2e): a kicked browser is told and loses the server`.

### Task H2: User docs and README
**Model:** haiku. **Files:**
- `docs/user/getting-started.md`: replace the API-only text at ~:722 and ~:770 with a section "Run your server" covering server settings, channels, invites, the member list, kick, ban, leave, delete and hand over, and what a removed person sees.
- `README.md`: "what works" gains server admin and moderation as of web-3.4.

Use the en.ts strings verbatim and run check:docs. **Commit:** `docs(user): run your server`.

## After the tasks (integrator: the controller)

- protocol/07: the row text from S4. Run check:docs.
- Full wave gates (roadmap A4), the e2e web and voice configs, and `sqlc diff`.
- Whole-branch review on opus, plus a product walk from an EMPTY instance with two browsers through every flow above. Measure op 54 read amplification: count the reads per frame at 2 and 20 members.
- PR, CI green, merge; tag `v0.1.0-web3.4` (prerelease); verify the assets; tell Homelab to deploy; Jonas checks.
- Then write W2's plan in the same shape.
