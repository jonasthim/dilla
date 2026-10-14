# dilla v0.1.0-web3.1: start a server from the web client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person on a freshly installed instance can do everything from the web client alone: create a server, add text and voice channels, invite a friend by link, and talk with them. The release reports its own version.

**Architecture:** dillad already serves the three routes `POST /v1/communities`, `POST /v1/communities/{id}/channels` and `POST /v1/communities/{id}/invites`. client-core gets typed route calls and worker commands for them. The web client gets three dialogs on packages/ui components, with the copy in flow doc 07. A new channel's MLS text group is registered by the first device that opens it (packages/client-core/src/sync/channel.ts ~:165), and a voice channel's call group is made at the first call, so no core or server change is needed. release.yml stamps `main.Version` at link time.

**Tech Stack:** TypeScript (client-core worker, React web, packages/ui, Storybook), Go (dillad main and the release workflow checker), Playwright (web e2e against dilla-testhost).

**Spec:** `.superpowers/sdd/2026-10-14-create-flow/brief.md` (requirements as approved by Jonas, "Go", 2026-10-14). Incident context: `docs/superpowers/plans/2026-10-14-dilla-web-3.md` shipped with no create flow, because every suite seeded communities through dilla-testhost.

**Starting point:** branch `dilla-create-flow` from main dbe836b. It already holds unreviewed work from a stopped first implementer:
- ddd3449: client-core routes, commands and tests;
- 77397df: the ui components, the web screens and flow 07;
- 0df6b12: WIP for the version stamp, the deploy docs and the empty-instance e2e.

Each task below **reviews and finishes** its part of that work. The implementer reads the existing diff first, keeps what meets the task, and fixes what does not. The task reviewer reviews the task's full diff from dbe836b, not only the new commits.

## Global Constraints

- **Name bounds.** A server name is 1..255 UTF-8 bytes and a channel name 1..100. Neither may contain a control character, and the client checks them as dillad does (internal/api validCommunityName, validChannelText).
- **Channel defaults.** New channels are mode 0 (E2EE, not readable by the server), visibility 0, top level, no topic, no slow mode.
- **Invite defaults.** Max uses 10, TTL 7 days, never admin-granting (grants_admin 0). Both numbers live in the Copy table of flow 07.
- **Permissions.** "+ add channel" is shown only to the server's owner, since the instance serves no role bits to clients and the owner is the one fact a page has. "copy invite link" is shown to every member, because @everyone holds CreateInvite by default. A refusal from the instance is shown with its Copy-table text, never as a raw code alone.
- **Copy.** Every user-visible string lives in packages/web/src/strings/en.ts, has a row in docs/design/flows/07-create.md, and passes `npm run check:copy`. Sentence case, plain verbs, no apology.
- **Design.** Mesh tokens and packages/ui components only. Keyboard first, visible focus. Dialogs move focus in on open and back to the opener on close. WCAG 2.2 AA, including target size. Works at 360 px.
- **Unchanged.** The core (wasm size unchanged), authz, the CSP and existing copy rules.
- **Test-first.** Each behaviour has a test that fails first, then passes. Each logic change has one mutation the tests catch. Record both in the task report.
- **Env dirs.** CARGO_TARGET_DIR=/home/thim/.cache/dilla-w3/cf-target, GOCACHE=/home/thim/.cache/dilla-w3/cf-gocache.
- **Harness.** Single plain commands only: no `&&`, `;`, pipes or `$(...)`; anything longer goes in a script file.
- **Commits.** `git commit -s -F <file>`, and every message ends with exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01XLFud8eoDaqf8uiZq5wjuP`
- **Process.** No subagents inside a task. No push, tag or release. A commit-time security scanner flag is real until shown otherwise.
- **Fixture reachability.** Any state a test seeds must be one the shipping client can reach by itself.

## Review Focus

1. **A double press of Create makes two servers.** A person who presses Create twice, or presses Enter while the first request is in flight, expects one server. Pinned in Task 2, step 3.
2. **The channel creates fail after the server exists** (network drop, 5xx). The person expects the server to stay, the error to say what is missing, and Retry to create only the missing channels, never a second `general`. Pinned in Task 2, step 4.
3. **The clipboard is blocked** (a permission denial, an insecure context, Firefox). The person expects to still see the link and copy it by hand, with no false "copied". Pinned in Task 2, step 5.
4. **The name is at the byte edge.** A name of exactly 255 bytes of multi-byte emoji is accepted, one byte more is refused before any request, and whitespace only is refused as empty. Pinned in Task 1, step 1 and Task 2, step 2.
5. **The invited friend lands in an empty-looking server.** The second person, after signing up through the link, expects to see the server, `#general` with the first message, and the first person in the DM picker. Pinned in Task 4.

---

### Task 1: client-core — create a server, a channel, an invite

**Files:**
- Review/finish: `packages/client-core/src/http/routes.ts` (createCommunity, createChannel, createInvite, nameProblem, bounds constants), `packages/client-core/src/worker/protocol.ts` (the three commands), `packages/client-core/src/worker/controller.ts` (handlers), `packages/client-core/src/state/types.ts` (`CommunitySummary.owner`, `InviteCreatedResult`), `packages/client-core/src/sync/testing/model.ts` (the double serves the three routes).
- Tests: `packages/client-core/src/http/routes.test.ts`, `packages/client-core/src/worker/controller.test.ts`, `packages/client-core/src/sync/testing/model.test.ts`, `packages/client-core/src/sync/channel.test.ts`.

**Interfaces:**
- Produces, in routes.ts:
  - `createCommunity(name: string): Promise<CommunityCreated>` with `{ id, roleEveryone, policyVersion }`;
  - `createChannel(communityId: Uint8Array, { kind: 'text' | 'voice'; name: string; position: number }): Promise<ChannelCreated>` with `{ id, mode, visibility }`;
  - `createInvite(communityId: Uint8Array, { maxUses: number; ttlSeconds: number }): Promise<InviteCreated>` with `{ inviteId, code, url, expires }`;
  - `nameProblem(v: unknown, maxBytes: number): string | null`.
- Produces, as worker commands:
  - `{ m: 'createCommunity'; name }` → `{ communityId: string }`, with the community listed before the return;
  - `{ m: 'createChannel'; communityId; kind; name }` → `{ channelId: string }`, listed before the return;
  - `{ m: 'createInvite'; communityId; maxUses; ttlSeconds }` → `InviteCreatedResult { url, code, expires }`.
- Produces in state: `CommunitySummary.owner` (32-hex user id).

- [ ] **Step 1: Read the existing diff and add the missing failing tests.** `git diff dbe836b..HEAD -- packages/client-core`. Make sure routes.test.ts pins each wire shape and bound, adding these if absent:

```ts
it('createCommunity sends [name, empty policy, 0, 0] and decodes [id, everyone, version]', async () => {
  const { routes, sent } = fakeRoutes(cbor([ID_A, ID_B, 1]));
  expect(await routes.createCommunity('Midgard')).toEqual({ id: ID_A, roleEveryone: ID_B, policyVersion: 1n });
  expect(decode(sent[0].body)).toEqual(['Midgard', new Uint8Array(0), 0, 0]);
  expect(sent[0]).toMatchObject({ method: 'POST', path: '/v1/communities' });
});
it('a server name of exactly 255 bytes passes and 256 bytes is refused before any request', async () => {
  const { routes, sent } = fakeRoutes(cbor([ID_A, ID_B, 1]));
  await routes.createCommunity('😀'.repeat(63) + 'abc');            // 63×4 + 3 = 255 bytes
  await expect(routes.createCommunity('😀'.repeat(64))).rejects.toThrow(/E_ROUTE_INPUT: name must be 1..255 bytes/);
  expect(sent).toHaveLength(1);
});
it('a name with a control character is refused before any request', async () => {
  const { routes, sent } = fakeRoutes(cbor([]));
  await expect(routes.createChannel(ID_A, { kind: 'text', name: 'a\u0007b', position: 0 })).rejects.toThrow(/control character/);
  expect(sent).toHaveLength(0);
});
it('createChannel sends kind 0/1, mode 0, visibility 0, no parent, no topic, no slow mode', async () => {
  const { routes, sent } = fakeRoutes(cbor([ID_C, 0, 0]));
  await routes.createChannel(ID_A, { kind: 'voice', name: 'general', position: 1 });
  expect(decode(sent[0].body)).toEqual([1, 0, 0, null, 'general', '', 1, 0]);
});
it('createInvite refuses a non-http(s) url from the instance', async () => {
  const { routes } = fakeRoutes(cbor([ID_D, 'code', 'javascript:alert(1)', 99]));
  await expect(routes.createInvite(ID_A, { maxUses: 10, ttlSeconds: 604800 })).rejects.toMatchObject({ code: 'E_CBOR_RANGE' });
});
```

  (Use the file's existing helpers for `fakeRoutes`, `cbor` and the ids. If the names differ, keep the assertions.)
- [ ] **Step 2: Add the controller tests if absent.**
  - createCommunity: the community appears in state (with `owner` set to the caller) **before** the command resolves.
  - createChannel: the channel appears in the server's list before resolving.
  - A 403 from createChannel rejects with the instance's code, which the page maps to copy.
  - createInvite returns `{ url, code, expires }` and stores nothing.
  - Each command is refused with E_NOT_READY before the session is ready.
- [ ] **Step 3: Add the group-on-open test if absent.** In `sync/channel.test.ts`, against the model double: a channel created through `createChannel` with no text group is opened, the opener registers its group (`postGroup` called once), and a second member opening it joins that group by external commit. This proves the server-side create needs no client group step.
- [ ] **Step 4: Run, expecting red for anything you added.** `npx vitest run packages/client-core/src/http/routes.test.ts packages/client-core/src/worker/controller.test.ts packages/client-core/src/sync/channel.test.ts --root packages/client-core`. Record which tests failed and why.
- [ ] **Step 5: Fix the code until green.** Then make one mutation: drop the byte check in `checkedName`. The 256-byte test must go red. Revert it.
- [ ] **Step 6: Run the gates.** `npm run test -w @dilla/client-core`, then `npm run typecheck -w @dilla/client-core`, then `npx eslint packages/client-core/src`.
- [ ] **Step 7: Commit.** For example: `fix(client-core): create routes pin their wire shapes, bounds and the url check`.

### Task 2: web and ui — the three dialogs, empty states, and the shell wiring

**Files:**
- Review/finish:
  - `packages/ui/src/CreateServer/*`, `packages/ui/src/CreateChannel/*`, `packages/ui/src/InviteLink/*`;
  - `packages/ui/src/CommunityRail/*` ("+ new server"), `packages/ui/src/ChannelList/*` ("+" add channel), `packages/ui/src/EmptyState/*`, `packages/ui/src/index.ts`;
  - `packages/web/src/screens/Create.tsx` (CreateServerFlow, CreateChannelFlow, InviteFlow, nameProblem, channelName, constants), `packages/web/src/screens/Shell.tsx`;
  - `packages/web/src/strings/en.ts`, `docs/design/flows/07-create.md`.
- Tests: `packages/ui/src/*/…test.tsx`, `packages/web/src/screens/Create.test.tsx`, `packages/web/src/screens/ShellCreate.test.tsx`, the Storybook stories.

**Interfaces:**
- Consumes: Task 1's commands and `CommunitySummary.owner`.
- Produces: `CreateServerFlow`, `CreateChannelFlow` and `InviteFlow`, mounted by Shell. Also the constants `INVITE_MAX_USES = 10` and `INVITE_TTL_DAYS = 7`.

- [ ] **Step 1: Read the existing diff and flow 07.** `git diff dbe836b..HEAD -- packages/ui packages/web docs/design/flows/07-create.md`. Check each string in en.ts against a flow 07 Copy row, and each state in the flow's states table against a test.
- [ ] **Step 2: Name validation (Review Focus 4).** Add if absent, in Create.test.tsx:

```tsx
it('whitespace only is refused as empty and sends nothing', async () => {
  const client = fakeClient();
  render(<CreateServerFlow open client={client} onDone={vi.fn()} onClose={vi.fn()} />);
  await user.type(screen.getByLabelText(t('create.server.name')), '   ');
  await user.click(screen.getByRole('button', { name: t('create.server.submit') }));
  expect(screen.getByText(t('create.name.empty'))).toBeVisible();
  expect(client.sent('createCommunity')).toHaveLength(0);
});
```

  (Use the file's real prop names and string keys; the assertion that nothing is sent is the point.)
- [ ] **Step 3: One server per press (Review Focus 1).** Write the test: while createCommunity is pending, a second click and an Enter send nothing more, and the button is `aria-disabled` or `disabled` and announced busy. Expect exactly one `createCommunity` sent.
- [ ] **Step 4: A partial failure retries only what is missing (Review Focus 2).**
  - The case: createCommunity succeeds, the text channel succeeds, and the voice channel fails with a 503.
  - Expect the dialog to show the partial state (the server exists; the voice channel was not made), and Retry to send only `createChannel(kind: 'voice')`.
  - The server stays selected and usable.
  - Expect exactly one `createChannel(kind: 'text', name: 'general')` overall.
- [ ] **Step 5: Clipboard blocked (Review Focus 3).**
  - When `navigator.clipboard.writeText` rejects, the dialog shows the link in a selectable read-only field.
  - The status region does **not** say "Invite link copied.", and it says how to copy by hand (the flow 07 row).
  - When `navigator.clipboard` is undefined, the same holds.
- [ ] **Step 6: Permissions and refusals.**
  - Only the owner sees "+ add channel"; a member does not.
  - Every member sees "copy invite link".
  - A 403 E_FORBIDDEN from createChannel shows the flow 07 refusal copy, not the code alone.
- [ ] **Step 7: Focus and keyboard.**
  - On open, focus goes to the name field.
  - Escape closes the dialog and focus returns to the control that opened it.
  - After a successful create, focus lands in `#general`'s composer.
  - The text/voice choice is a radio group operable by arrow keys.
- [ ] **Step 8: Empty states.**
  - With no server, the shell's empty state names both ways in ("new server", or ask for an invite) and its button opens CreateServerFlow.
  - The DM picker with no server explains why it is empty (flow 07 row).
- [ ] **Step 9: Run, expecting red for anything added.** `npx vitest run --root packages/web src/screens/Create.test.tsx src/screens/ShellCreate.test.tsx`, then `npm run test -w @dilla/ui`. Record the reds.
- [ ] **Step 10: Fix until green, then mutate.** One mutation: remove the in-flight guard in CreateServerFlow. Step 3's test must go red. Revert it.
- [ ] **Step 11: Stories and gates.**
  - Stories for each dialog state: idle, busy, error, partial, copied and copy-blocked.
  - `npm run build-storybook -w @dilla/ui`, then `npm run test-storybook -w @dilla/ui`.
  - `npm run test -w @dilla/web`, `npm run typecheck`, `npx eslint packages/web/src packages/ui/src`, `npm run check:copy`.
- [ ] **Step 12: Commit.** For example: `fix(web): one server per press, retry only missing channels, honest copy when the clipboard is blocked`.

### Task 3: release version stamp

**Files:**
- Review/finish: `cmd/dillad/main.go` (`var Version`), `cmd/dillad/version_test.go`, `.github/workflows/release.yml` (ldflags), `scripts/check-ci-workflow.mjs` and `scripts/check-ci-workflow.test.mjs`.

**Interfaces:**
- Produces: `dillad version` prints `dillad <tag without v> …` for a release build, and `0.0.0-dev` for every other build.

- [ ] **Step 1: Read the WIP diff.** `git diff dbe836b..HEAD -- cmd/dillad .github/workflows/release.yml scripts/check-ci-workflow.mjs scripts/check-ci-workflow.test.mjs`.
- [ ] **Step 2: Version test.** version_test.go builds dillad with `-ldflags "-X main.Version=0.1.0-web3.1"` into a temp dir, runs `version`, and expects the output to start with `dillad 0.1.0-web3.1 `. A plain `go build` prints `dillad 0.0.0-dev `. Run `go test ./cmd/dillad/ -run Version` and record red (against `const`) and green.
- [ ] **Step 3: Release workflow.**
  - In release.yml, both `go build` lines pass `-X main.Version=${VERSION}`, where `VERSION` is the tag without its leading `v`.
  - The tag goes through `env:` only. It is already validated by the tag job (`v[0-9]*`, `[A-Za-z0-9.+_-]`).
- [ ] **Step 4: Checker rule.**
  - `checkReleaseWorkflow` requires the `-X main.Version=` flag on every release `go build`, sourced from env.
  - Add a self-test case that is red without the flag.
  - Run `node --test scripts/check-ci-workflow.test.mjs`, then `npm run check:ci`.
- [ ] **Step 5: Gates and commit.** `go test ./cmd/dillad/`, then `golangci-lint run ./cmd/dillad/...`. Commit, for example: `ci(release): stamp the tag into dillad's version`.

### Task 4: the empty-instance e2e (the incident's regression test)

**Files:**
- Review/finish: `e2e/web/create.spec.ts`, `e2e/web/support/host.ts` (a host with no seeded account, community or channel), `e2e/web/support/app.ts`.

**Interfaces:**
- Consumes: Tasks 1–2's UI, by role and accessible name only.
- Produces: a Playwright test in the chromium-web and firefox-web projects.

- [ ] **Step 1: Read the WIP spec and host support.** Confirm the host starts with **no** seeded state, and that the test never calls the instance API on anyone's behalf: the bootstrap invite is the only input.
- [ ] **Step 2: Make the test cover the whole path in one serial test.**
  1. Sign up with the bootstrap invite.
  2. Press "new server", name it, and land in `#general`. Send "hello from the owner".
  3. Copy the invite link, reading it from the dialog's field rather than the clipboard.
  4. In a second browser context, open the link and sign up.
  5. Check that the second person sees the server, `#general` and "hello from the owner" (Review Focus 5). They reply, and the owner sees the reply.
  6. Check that the second person opens "message someone", picks the owner, and sends a DM; the owner sees it.
  7. Check that the owner adds a text channel `plans`, and both people use it.
  8. Check that the second person sees no "+ add channel".
- [ ] **Step 3: Show red on main's client.** Run the spec against a web build of dbe836b, using `git worktree`-free means: build into a temp dir from `git archive dbe836b`. Record that it fails at "new server", with that locator not found.
- [ ] **Step 4: Green.**
  - `npx playwright test --config e2e/playwright.config.ts --project=chromium-web e2e/web/create.spec.ts`, then the same with firefox-web.
  - Run each 3 times to check for flakes. Record wall times.
  - Close every browser context the test opens.
- [ ] **Step 5: Run the full web suite once in Chromium** (no regressions from the Shell changes), then commit, for example: `test(e2e): from an empty instance to two people talking, through the client alone`.

### Task 5: docs, README and screenshots

**Files:**
- Review/finish: `docs/deploy/README.md` (`--trusted-proxy` is repeatable, one /32 per newt host, an example with two), `docs/user/getting-started.md`, `README.md`, `e2e/scripts/shoot-docs.mjs`, `docs/user/screenshots/*`.

- [ ] **Step 1: Getting started.**
  - Add a first section, "Start a server", for the first person on a new instance: the bootstrap invite link, then "new server", then `#general`.
  - Then "Invite people": copy the invite link, its 10 uses and 7 days, and what the friend sees.
  - Add "Add a channel" (owner only).
- [ ] **Step 2: README.** "What works today" gains creating servers, channels and invite links, dated "web-3.1 (2026-10-14)". "Not there yet" gains roles for adding channels: only the owner, for now.
- [ ] **Step 3: Deploy docs.** In docs/deploy/README.md, check the WIP `--trusted-proxy` text: repeatable, one `/32` per newt host, an example with two, and why a wide CIDR is unsafe (anyone in it can forge X-Forwarded-For).
- [ ] **Step 4: Screenshots.**
  - Add shots to shoot-docs.mjs, desktop and 360 px: the empty instance, the new-server dialog, the add-channel dialog and the invite-link dialog.
  - The script must reach them through the UI from an empty instance.
  - Run `npm run docs:shots -w @dilla/e2e` and reference the images with honest alt text.
- [ ] **Step 5: Gates and commit.** `npm run check:docs`, then `npm run check:copy`. Commit, for example: `docs: start a server, invite people, add a channel; trusted-proxy per host`.

---

## After the tasks (controller)

1. **Whole-branch review** on the most capable model, through two lenses in parallel:
   - security/client: the create routes, the URL handling and the release ldflags;
   - a **product walk from an empty instance**. This uses `dillad init`, or the test host with nothing seeded, and two browsers, driven only through the UI.
2. **Fix wave** with a scoped re-review.
3. **PR to main and CI.** Then merge with `gh pr merge N --merge --delete-branch`.
4. **Tag `v0.1.0-web3.1`.** Then check the release assets, the checksums, the stamped install.sh and that `dillad version` prints `0.1.0-web3.1`.
5. **Ask the Homelab session** to run `install.sh --upgrade --version v0.1.0-web3.1` on Jonas's LXC and verify end to end.
