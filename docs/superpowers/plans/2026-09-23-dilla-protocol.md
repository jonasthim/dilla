# dilla-protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce dilla's normative protocol documents (groups, delivery service, identity, envelope and franking, media frames, backup, versioning, threat model) and a TypeScript reference implementation that generates the conformance test vectors every later implementation (the Rust core, the Go server) must match.

**Architecture:** The repository is bootstrapped as a monorepo (npm workspaces for TypeScript packages; Cargo and Go workspaces are added by later sub-projects). `protocol/` holds the normative Markdown documents and the committed `protocol/vectors/*.json`. `packages/protocol-vectors` is a small, dependency-free TypeScript package (Node 24 built-ins only: WebCrypto, `node:test` is not used; tests run with Vitest) that implements the pure-function parts of the protocol independently of the Rust core: deterministic CBOR, the message envelope, franking commitments and tags, the SFrame key schedule and KID layout, the safety-number and recovery-key encodings. CI regenerates the vectors and fails if the committed files differ.

**Tech Stack:** Node 24, npm workspaces, TypeScript 5, Vitest 3, WebCrypto (`globalThis.crypto.subtle`), GitHub Actions. No other runtime dependencies in this package.

**Spec:** `docs/superpowers/specs/2026-09-23-dilla-design.md` (sections "Founder decisions", "Recommended approach", "Design addenda", Appendix A "Rust core", "Server (Go)", "E2EE protocol layer", "Media", "Data model", "Testing and verification strategy").

## Global Constraints

- Repository: `github.com/jonasthim/dilla`, public. Licence: AGPL-3.0-or-later for the repository; `packages/protocol-vectors` and everything under `protocol/` are Apache-2.0 (the spec: "Apache-2.0 for SDK/protocol libraries"); each package carries its own `LICENSE` file and `"license"` field.
- Every commit is signed off (`git commit -s`) per the DCO.
- Standards-only cryptography: MLS is RFC 9420, media frames follow the RFC 9605 shape, hashes are SHA-256, MACs are HMAC-SHA256, KDF is HKDF-SHA256, signatures are Ed25519. No bespoke constructions; `CONTRIBUTING.md` says so.
- Mandatory MLS ciphersuite at v1: `0x0001` (MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519). Media suite: SFrame `0x0004` (AES_128_GCM_SHA256_128).
- Wire, E2EE and media protocol versions are independent integers, negotiated with an N-2 window. This plan defines `e2ee_version = 1`, `media_version = 1`.
- Vocabulary in documents: the protocol uses *instance*, *community*, *channel*, *member*, *device*, *leaf*, *group*. (UI copy uses *server*, *channel*, *DMs*, *voice*; that is the design sub-project's concern.)
- Node version: 24 (`.nvmrc`). Package manager: npm 11 (`package-lock.json` committed). No pnpm.
- Nothing in `protocol/` may contain "TBD" or "TODO"; `scripts/check-protocol-docs.mjs` fails on them.

---

### Task 1: Monorepo skeleton and CI

**Files:**
- Create: `package.json`
- Create: `.nvmrc`
- Create: `.editorconfig`
- Create: `README.md`
- Create: `CONTRIBUTING.md`
- Create: `.github/workflows/ci.yml`
- Create: `scripts/check-protocol-docs.mjs`
- Create: `scripts/check-protocol-docs.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` (runs every workspace's `test` script plus the root doc checks); `npm run check:docs` (runs `scripts/check-protocol-docs.mjs`); the workspace list `packages/*`.

- [ ] **Step 1: Create the root package manifest**

```json
{
  "name": "dilla-monorepo",
  "private": true,
  "version": "0.0.0",
  "description": "dilla: self-hosted, end-to-end encrypted community chat, voice and video",
  "license": "AGPL-3.0-or-later",
  "engines": { "node": ">=24" },
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "npm run check:docs && npm test --workspaces --if-present",
    "check:docs": "node scripts/check-protocol-docs.mjs",
    "test:docs-check": "node --test scripts/check-protocol-docs.test.mjs",
    "vectors": "npm run vectors --workspace packages/protocol-vectors --if-present"
  }
}
```

- [ ] **Step 2: Create `.nvmrc` and `.editorconfig`**

`.nvmrc`:
```
24
```

`.editorconfig`:
```
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false

[*.go]
indent_style = tab

[Makefile]
indent_style = tab
```

- [ ] **Step 3: Create the README with the not-audited banner**

```markdown
# dilla

> **Not audited. Not for production.** dilla is under construction. Nothing here has had an
> independent security review, and the project makes no end-to-end encryption claim until one is
> published. Run it only to develop it.

dilla is an open-source, self-hosted alternative to Discord: communities with text channels and
drop-in voice, DMs, roles and permissions, screen share and bots, with end-to-end encryption as the
silent default. One binary per instance. Runnable by anyone who can host it somewhere.

## Repository layout

| Path | What |
|---|---|
| `protocol/` | Normative protocol documents and conformance test vectors (Apache-2.0) |
| `packages/protocol-vectors` | TypeScript reference implementation that generates the vectors (Apache-2.0) |
| `docs/superpowers/specs` | Product and system design specifications |
| `docs/superpowers/plans` | Implementation plans |
| `docs/design` | Design brief and the Mesh design reference |

## Licence

Server and clients: AGPL-3.0-or-later (`LICENSE`). Protocol documents, test vectors and SDK
libraries: Apache-2.0 (`LICENSE-APACHE`). Contributions are accepted under the Developer
Certificate of Origin (`DCO`): sign off every commit with `git commit -s`.
```

- [ ] **Step 4: Create CONTRIBUTING.md**

```markdown
# Contributing to dilla

## Sign-off

Every commit must carry a `Signed-off-by:` line (`git commit -s`), which certifies the Developer
Certificate of Origin in `DCO`. There is no contributor licence agreement and there will not be one.

## Cryptography rule

dilla uses only published standards, implemented in public code: MLS (RFC 9420), the RFC 9605
SFrame shape for media frames, HKDF-SHA256, HMAC-SHA256, SHA-256, AES-128-GCM, Ed25519, X25519.
A pull request that introduces a construction not defined in one of those documents, or a
"simplified" variant of one, is closed without review. Ask first in an issue if you think an
exception is needed.

## Protocol changes

`protocol/` is normative. A change to any document there needs, in the same pull request:
1. a bump of the affected version integer (`e2ee_version`, `media_version` or the wire version),
2. regenerated vectors (`npm run vectors`) with the diff explained,
3. a note in `protocol/07-versioning.md` describing the compatibility window.

## Commits

Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`.
```

- [ ] **Step 5: Write the failing test for the docs checker**

`scripts/check-protocol-docs.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocs } from './check-protocol-docs.mjs';

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-docs-'));
  mkdirSync(join(dir, 'protocol'), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'protocol', name), body);
  return dir;
}

test('passes when every required document exists with its required headings and no placeholders', () => {
  const dir = fixture({
    'README.md': '# dilla protocol\n\n## Documents\n\n## Conformance\n',
    '00-overview.md': '# Overview\n\n## Terminology\n\n## Precedence\n\n## Conformance language\n',
    '01-groups.md': '# Groups\n\n## Group kinds\n\n## dilla_binding\n\n## External senders\n\n## Joining\n\n## Cadence\n',
    '02-delivery-service.md': '# Delivery service\n\n## Roles\n\n## API\n\n## Invariants\n\n## Errors\n\n## Retention\n',
    '03-identity.md': '# Identity\n\n## Keys\n\n## Credential\n\n## Device list\n\n## Custody by tier\n\n## Pairing\n\n## Recovery\n\n## Safety number\n',
    '04-envelope-and-franking.md': '# Envelope\n\n## Envelope\n\n## Deterministic CBOR\n\n## Franking\n\n## Vectors\n',
    '05-media-frames.md': '# Media\n\n## Frame format\n\n## Codec prefixes\n\n## Key schedule\n\n## Counter partition\n\n## Rotation\n',
    '06-backup-archive.md': '# Backup\n\n## Keys\n\n## Header\n\n## Archive\n\n## Restore\n',
    '07-versioning.md': '# Versioning\n\n## Versions\n\n## Negotiation\n\n## Change process\n',
    '08-threat-model.md': '# Threat model\n\n## Adversaries\n\n## Guarantees\n\n## Residual trust\n\n## Out of scope\n',
  });
  assert.deepEqual(checkDocs(dir), []);
});

test('reports a missing document, a missing heading and a placeholder', () => {
  const dir = fixture({
    'README.md': '# dilla protocol\n\n## Documents\n\n## Conformance\n',
    '00-overview.md': '# Overview\n\n## Terminology\n\nTBD\n',
  });
  const problems = checkDocs(dir);
  assert.ok(problems.some(p => p.includes('01-groups.md') && p.includes('missing')));
  assert.ok(problems.some(p => p.includes('00-overview.md') && p.includes('## Precedence')));
  assert.ok(problems.some(p => p.includes('00-overview.md') && p.includes('placeholder')));
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `node --test scripts/check-protocol-docs.test.mjs`
Expected: FAIL with `Cannot find module './check-protocol-docs.mjs'`.

- [ ] **Step 7: Write the checker**

`scripts/check-protocol-docs.mjs`:
```js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED = {
  'README.md': ['## Documents', '## Conformance'],
  '00-overview.md': ['## Terminology', '## Precedence', '## Conformance language'],
  '01-groups.md': ['## Group kinds', '## dilla_binding', '## External senders', '## Joining', '## Cadence'],
  '02-delivery-service.md': ['## Roles', '## API', '## Invariants', '## Errors', '## Retention'],
  '03-identity.md': ['## Keys', '## Credential', '## Device list', '## Custody by tier', '## Pairing', '## Recovery', '## Safety number'],
  '04-envelope-and-franking.md': ['## Envelope', '## Deterministic CBOR', '## Franking', '## Vectors'],
  '05-media-frames.md': ['## Frame format', '## Codec prefixes', '## Key schedule', '## Counter partition', '## Rotation'],
  '06-backup-archive.md': ['## Keys', '## Header', '## Archive', '## Restore'],
  '07-versioning.md': ['## Versions', '## Negotiation', '## Change process'],
  '08-threat-model.md': ['## Adversaries', '## Guarantees', '## Residual trust', '## Out of scope'],
};

const PLACEHOLDER = /\b(TBD|TODO|FIXME|XXX)\b|lorem ipsum|fill in later/i;

export function checkDocs(root) {
  const problems = [];
  for (const [name, headings] of Object.entries(REQUIRED)) {
    const path = join(root, 'protocol', name);
    if (!existsSync(path)) { problems.push(`${name}: missing`); continue; }
    const text = readFileSync(path, 'utf8');
    for (const h of headings) {
      if (!text.split('\n').some(line => line.trim() === h)) problems.push(`${name}: missing heading "${h}"`);
    }
    const bad = text.split('\n').findIndex(line => PLACEHOLDER.test(line));
    if (bad >= 0) problems.push(`${name}: placeholder on line ${bad + 1}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? process.cwd();
  const problems = checkDocs(root);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('protocol docs: ok');
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `node --test scripts/check-protocol-docs.test.mjs`
Expected: PASS (2 tests). `npm run check:docs` at the repository root now fails (no `protocol/` yet); that is expected until Task 2.

- [ ] **Step 9: Create the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run test:docs-check
      - run: npm test
      - name: vectors are up to date
        run: |
          npm run vectors
          git diff --exit-code -- protocol/vectors
```

- [ ] **Step 10: Install and commit**

Run: `npm install` (creates `package-lock.json` with no dependencies yet), then `npm run test:docs-check`.
Expected: PASS.

```bash
git add package.json package-lock.json .nvmrc .editorconfig README.md CONTRIBUTING.md .github/workflows/ci.yml scripts/
git commit -s -m "chore: monorepo skeleton, CI, protocol docs checker"
```

---

### Task 2: Protocol overview and document index

**Files:**
- Create: `protocol/LICENSE` (copy of `LICENSE-APACHE`)
- Create: `protocol/README.md`
- Create: `protocol/00-overview.md`

**Interfaces:**
- Consumes: the checker from Task 1.
- Produces: the terminology every later document uses (instance, community, channel, member, device, leaf, group, DS, tier) and the precedence rule.

- [ ] **Step 1: Copy the licence and write the README**

Run: `mkdir -p protocol/vectors && cp LICENSE-APACHE protocol/LICENSE`

`protocol/README.md`:
```markdown
# dilla protocol

Normative documents for dilla's end-to-end encryption, delivery service, identity, message
envelope, media frames and backups. Licensed Apache-2.0 (`LICENSE` in this directory) so that
third-party clients, bots and servers can implement them without AGPL obligations.

## Documents

| # | Document | Defines |
|---|---|---|
| 00 | `00-overview.md` | Terminology, precedence, conformance language |
| 01 | `01-groups.md` | MLS group kinds, the `dilla_binding` extension, external senders, joining, cadence |
| 02 | `02-delivery-service.md` | The server's role as MLS Delivery Service: API, invariants, errors, retention |
| 03 | `03-identity.md` | User and device keys, credentials, signed device lists, custody by tier, pairing, recovery, safety numbers |
| 04 | `04-envelope-and-franking.md` | The application message envelope, deterministic CBOR, franking |
| 05 | `05-media-frames.md` | Per-frame media encryption (`dilla-sframe/1`), key schedule, counters, rotation |
| 06 | `06-backup-archive.md` | Recovery-key-encrypted header and history archive |
| 07 | `07-versioning.md` | Wire, E2EE and media versions and the change process |
| 08 | `08-threat-model.md` | Adversaries, guarantees, residual trust, out of scope |

## Conformance

`vectors/` holds JSON test vectors generated by `packages/protocol-vectors` (a TypeScript
reference implementation of the pure-function parts of these documents). An implementation
conforms to a document when it reproduces every vector in the files that document names. CI
regenerates the vectors on every change and fails if the committed files differ.
```

- [ ] **Step 2: Write the overview**

`protocol/00-overview.md`:
```markdown
# 00 — Overview

dilla is a self-hosted community chat, voice and video system. Each **instance** is one server
process reachable at one origin. An instance hosts **communities** (the UI calls them servers), each
with **channels** (text and voice), plus **DMs** between users of the same instance. Content in
end-to-end encrypted channels, DMs and calls is protected with MLS (RFC 9420) groups whose secrets
the instance never holds; the instance is the MLS Delivery Service and an external sender.

## Terminology

- **Instance**: one dilla server, identified by `instance_id` (16 random bytes, fixed at install)
  and an Ed25519 **instance signing key** used as the MLS external sender.
- **Community**: a set of channels, roles and members on one instance, identified by
  `community_id` (16 bytes). DMs and group DMs have no community; their `community_id` is null.
- **Channel**: a text or voice channel, identified by `channel_id` (16 bytes). A text channel has a
  **mode**: `e2ee` (content is an MLS group; the instance sees ciphertext) or `readable` (content
  is plaintext to the instance; only channels joinable by public invite may be `readable`).
- **User**: an account on one instance, identified by `user_id` (16 bytes) and a **UMK** (user
  master key, Ed25519).
- **Device**: one installation of a client or bot, identified by `device_id` (16 bytes) and a
  **DSK** (device signing key, Ed25519). A device is one MLS **leaf** in every group it belongs to.
- **Tier**: `native` (desktop or mobile app; bundled code; OS keystore) or `browser` (web app
  served by the instance).
- **Group**: an MLS group of one of four **kinds**: `text`, `call`, `pairing`, `interaction`
  (see `01-groups.md`).
- **DS**: the MLS Delivery Service role of the instance (see `02-delivery-service.md`).
- **Bot**: a user of kind `bot`, operated by whoever runs its process; its devices are ordinary
  leaves.
- **Epoch**: the MLS epoch of a group. **Commit**, **Proposal**, **Welcome**, **KeyPackage**,
  **GroupInfo**, **LeafNode**, **external commit**, **external sender**: as in RFC 9420.

All identifiers are 16 random bytes generated by the party that creates the object (the instance
for users, communities and channels; the client for devices and messages). They are encoded as
CBOR byte strings on the wire and as lowercase hex in JSON test vectors.

## Precedence

1. RFC 9420 (MLS) and RFC 9750 (MLS architecture) govern everything they define. dilla adds
   extensions, policies and encodings; it does not modify MLS.
2. These documents govern dilla-specific behaviour. Where two of them disagree, the lower-numbered
   document wins and the disagreement is a bug to fix.
3. The test vectors in `vectors/` are authoritative for encodings: an implementation that disagrees
   with a vector is wrong until the vector is changed through the change process in
   `07-versioning.md`.

## Conformance language

"MUST", "MUST NOT", "SHOULD", "SHOULD NOT" and "MAY" are used as in RFC 2119 and RFC 8174.
"Rejects" means: the receiving party discards the object, records the reason with the error code
given in the document, and does not act on it. "Hard-rejects" means the same and additionally
surfaces the failure to the user.

## Cryptographic primitives

- Hash: SHA-256. MAC: HMAC-SHA256 (RFC 2104). KDF: HKDF-SHA256 (RFC 5869).
- Signatures: Ed25519 (RFC 8032). Key agreement inside MLS: X25519 through the MLS ciphersuite.
- AEAD: AES-128-GCM (MLS ciphersuite 0x0001 and SFrame suite 0x0004); AES-256-GCM for attachments
  and the backup archive with random 96-bit nonces.
- Randomness: the platform CSPRNG; 16 bytes for identifiers, 32 bytes for keys.
- MLS ciphersuite: `0x0001` MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 is mandatory to
  implement; a group's suite is fixed at creation and recorded in its `dilla_binding`.

## Encodings

- **CBOR** (RFC 8949) in the deterministic core encoding (RFC 8949 §4.2.1) with **fixed-position
  arrays**, never maps: every structure is an array whose element order is normative. A decoder
  MUST reject an array of the wrong length for the declared version.
- Integers are unsigned unless stated. Timestamps are seconds since the Unix epoch, unsigned.
- Text is UTF-8 (CBOR major type 3). Binary is CBOR major type 2.
- Hex in these documents and in vectors is lowercase without a prefix.
```

- [ ] **Step 3: Run the checker**

Run: `npm run check:docs`
Expected: FAIL listing the eight documents still missing (01 through 08). `README.md` and `00-overview.md` report no problems.

- [ ] **Step 4: Commit**

```bash
git add protocol/LICENSE protocol/README.md protocol/00-overview.md
git commit -s -m "docs(protocol): overview, terminology, precedence"
```

---

### Task 3: Groups and the `dilla_binding` extension

**Files:**
- Create: `protocol/01-groups.md`

**Interfaces:**
- Consumes: terminology from Task 2.
- Produces: the `dilla_binding` CBOR layout `[v, instance_id, community_id, target_id, kind, policy_version, e2ee_version, media_version]` and the extension type `0xF001`, used by Task 6's vectors and by the Rust core later.

- [ ] **Step 1: Write the document**

`protocol/01-groups.md`:
```markdown
# 01 — Groups

## Group kinds

Every end-to-end encrypted conversation or session is one MLS group. There are four kinds:

| kind | value | one per | members (leaves) | external sender |
|---|---|---|---|---|
| `text` | 0 | e2ee text channel, DM or group DM | every device of every member | the instance |
| `call` | 1 | voice session in a voice channel, DM call or group-DM call | every device present in the call | the instance |
| `pairing` | 2 | device enrolment | exactly two leaves: the authorising device and the new device | none |
| `interaction` | 3 | (user, bot) pair | every device of the user plus the bot's device(s) | none |

A `readable` text channel has no group. A call in any voice channel, including a voice channel of
a community whose text channels are `readable`, always has a `call` group: calls are always
end-to-end encrypted.

Groups use MLS ciphersuite `0x0001`. Handshake messages (Proposal, Commit) are sent as
`PublicMessage`; application data as `PrivateMessage`. Application data MUST be padded so that the
`PrivateMessage` ciphertext length is a multiple of 256 bytes (RFC 9420 §6.3.1 padding field).

Group configuration:

- `use_ratchet_tree_extension`: off. The DS serves the ratchet tree (`02-delivery-service.md`).
- `required_capabilities`: extension types `[0xF001]`; proposal types `[]`; credential types
  `[basic]`.
- Past epoch secrets: a client keeps the message secrets of past epochs for 300 seconds in `text`
  groups, 10 seconds in `call` groups, and 0 seconds in `pairing` and `interaction` groups, then
  deletes them.

## dilla_binding

Every group carries a GroupContext extension of type `0xF001` (RFC 9420 private-use range) named
`dilla_binding`. Its `extension_data` is the deterministic CBOR encoding of:

```
[
  v,               ; uint, = 1
  instance_id,     ; bstr, 16 bytes
  community_id,    ; bstr, 16 bytes, or null for DMs, group DMs, pairing and interaction groups
  target_id,       ; bstr, 16 bytes: channel_id for text and call groups in a community;
                   ;   dm_id for DMs and their calls; the new device_id for pairing;
                   ;   the bot's user_id for interaction groups
  kind,            ; uint, 0..3 as in the table above
  policy_version,  ; uint, the instance's policy version at group creation (see 02, invariant 1)
  e2ee_version,    ; uint, = 1
  media_version    ; uint, = 1 for call groups, 0 for the other kinds
]
```

Rules:

1. A client MUST reject a Welcome, GroupInfo, Proposal or Commit whose group's `dilla_binding`
   does not match the instance it is connected to (`instance_id`), the object it expects
   (`community_id`, `target_id`, `kind`), or a version it supports. Error code `E_BINDING`.
2. `dilla_binding` MUST be listed in `required_capabilities.extension_types`, so a leaf that does
   not understand it cannot be added.
3. The extension is immutable for the life of the group. A change requires a new group.

## External senders

`text` and `call` groups carry the instance signing key in the `external_senders` GroupContext
extension (RFC 9420 §12.1.8.1), with a `basic` credential whose identity is the CBOR array
`[v = 1, "instance", instance_id]`. `pairing` and `interaction` groups MUST NOT carry any external
sender; a client MUST reject a `pairing` or `interaction` GroupInfo or Welcome that has one
(`E_EXTERNAL_SENDER_FORBIDDEN`).

Client policy for proposals from the external sender:

| proposal | text / call | pairing / interaction |
|---|---|---|
| Add | accept if the credential passes `03-identity.md` checks and the user is eligible per the client's role snapshot | reject |
| Remove | accept | reject |
| GroupContextExtensions | accept only if the sole change is to `external_senders` and the new instance key is signed by the old one (`03-identity.md`, "Instance key rotation") | reject |
| ReInit, PreSharedKey, Update, any other | reject | reject |

Client policy for proposals from members:

- `Update`: accept.
- `Remove`: accept only if the target leaf belongs to the committer's own user (device revocation);
  reject otherwise (`E_MEMBER_REMOVE_FORBIDDEN`). Removing other users is the instance's job, bound
  to roles.
- `Add`: accept only in `pairing` (first join of the second leaf) and `interaction` groups (the
  user's device adding the bot device or a new own device); reject in `text` and `call` groups.
- `GroupContextExtensions`, `ReInit`, `PreSharedKey`: reject.

External commits (RFC 9420 §12.4.3.2) are accepted in `text` and `call` groups for: joining a
community's channels, adding a new device of an existing member, joining a call, and resyncing.
The `Remove` proposal inside an external commit MUST target only a leaf with the joiner's own
`device_id`; otherwise the client rejects the commit (`E_EXTERNAL_COMMIT_REMOVE`).

## Joining

- An online device joins by **external commit** using the GroupInfo and ratchet tree served by
  the DS. The DS refuses external commits while a DS proposal is outstanding, except when no member
  device is online (`02-delivery-service.md`, invariant 5).
- An offline device is added by a **DS Add proposal** carrying one of the device's KeyPackages,
  committed by an online member. Each device keeps 32 ordinary KeyPackages plus 1 **last-resort**
  KeyPackage on the DS; a join that consumed the last-resort package MUST be followed by an
  `Update` from that device in its next commit opportunity.
- Creating a private channel, or granting a role that opens a channel to many members, is done by
  the DS issuing Add proposals in batches: the creator's device commits at most 256 Adds per
  commit, each producing one Welcome, until all eligible devices are members.
- A member leaves a channel or a call by a `Remove` of its own leaves in a commit, or is removed
  by the DS.

## Cadence

- **Update cadence (post-compromise security):** a device in a `text` group sends an `Update`
  proposal at most every `24h × max(1, ceil(leaves / 64))` and only if it has sent at least one
  application message since its last `Update`. The DS batches proposals into one commit per
  `max(60 s, leaves × 1 s)` (see 02, invariant 7). In `call` groups a device updates every 60
  minutes; the DS commits at most once per minute.
- **Inactivity:** a device that has not connected for **90 days** is removed from every group by a
  DS `Remove` proposal (founder decision 2026-09-23). It rejoins by external commit.
- **Epoch rotation on membership change:** every Add or Remove is a new epoch; senders MUST NOT
  send application data in an epoch whose commit they have not processed.

## Error codes

`E_BINDING`, `E_EXTERNAL_SENDER_FORBIDDEN`, `E_MEMBER_REMOVE_FORBIDDEN`, `E_EXTERNAL_COMMIT_REMOVE`,
`E_UNSUPPORTED_VERSION`, `E_UNSUPPORTED_SUITE`. Codes are stable strings; clients MAY show them in
diagnostics.
```

- [ ] **Step 2: Run the checker and commit**

Run: `npm run check:docs`
Expected: `01-groups.md` reports no problems (others still missing).

```bash
git add protocol/01-groups.md
git commit -s -m "docs(protocol): group kinds, dilla_binding, external senders, joining, cadence"
```

---

### Task 4: Delivery service

**Files:**
- Create: `protocol/02-delivery-service.md`

**Interfaces:**
- Consumes: group kinds and `dilla_binding` (Task 3).
- Produces: the DS HTTP API and gateway frame names (`mls.handshake`, `mls.commit_needed`, `mls.epoch_changed`, `message.ct`) and error codes (`409 commit_conflict`, `425 commit_required`, `403 leaf_not_current`) that the Go server and the Rust core implement, and that `dilla-testkit` scenarios drive.

- [ ] **Step 1: Write the document**

`protocol/02-delivery-service.md`:
```markdown
# 02 — Delivery service

## Roles

The instance acts as the MLS Delivery Service (RFC 9750 §5) for every group it hosts:

1. **KeyPackage directory**: stores KeyPackages per device, serves one on request, consumes
   ordinary packages on use, never consumes the last-resort package.
2. **Sequencer**: accepts exactly one Commit per epoch per group and totally orders handshake and
   application messages per group (`seq`, a per-group unsigned counter starting at 1).
3. **GroupInfo and tree store**: keeps the latest committer-signed GroupInfo (without the ratchet
   tree) and the ratchet tree it maintains itself from the handshake stream.
4. **External sender**: issues Add and Remove proposals bound to the permission system, and
   `GroupContextExtensions` proposals only for its own key rotation.
5. **Structural validator**: maintains an MLS `PublicGroup` per group (the public state: tree,
   epoch, extensions, leaf credentials) and validates every Proposal, Commit and GroupInfo
   structurally before accepting it. It never holds a group secret and cannot decrypt.

## API

HTTP endpoints are JSON unless stated; binary MLS objects are base64url strings in JSON and raw
bytes on the gateway. All endpoints require a device session (`03-identity.md`).

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `POST /v1/groups` | `{binding, group_info, ratchet_tree}` from the creator | `201 {group_id, seq}` | `400 binding_invalid`, `403 mode_readable` (text group for a readable channel), `409 group_exists` |
| `GET /v1/groups/{id}/info` | — | `200 {epoch, group_info, tree_hash, seq}` | `404` |
| `GET /v1/groups/{id}/tree` | — | `200 {epoch, ratchet_tree, tree_hash}` | `404` |
| `GET /v1/groups/{id}/handshakes?from={seq}` | — | `200 {items:[{seq, epoch, kind, sender, blob}]}` | `404`, `410 pruned` |
| `POST /v1/groups/{id}/commit` | `{epoch, commit, group_info, welcomes:[{device_id, blob}]}` | `200 {seq, epoch}` | `409 commit_conflict {winning_commit, proposals}`, `425 commit_required {proposals}`, `422 commit_invalid {reason}`, `403 leaf_not_current` |
| `POST /v1/groups/{id}/proposal` | `{epoch, proposal}` (member Update or own-device Remove) | `200 {seq}` | `422`, `403` |
| `POST /v1/groups/{id}/message` | `{epoch, private_message, commitment}` (`commitment` = franking `C`, 32 bytes) | `200 {seq, franking_tag, recv_ts}` | `425 commit_required`, `403 leaf_not_current`, `413 too_large` |
| `POST /v1/groups/{id}/resync` | `{external_commit, group_info}` | `200 {seq, epoch}` | `425 commit_required`, `422` |
| `POST /v1/groups/{id}/fork-report` | `{epoch, seq, reason}` | `202` | — |
| `POST /v1/keypackages` | `{packages:[blob], last_resort: blob}` | `201 {count}` | `422` |
| `GET /v1/devices/{device_id}/keypackage` | — | `200 {blob, last_resort: bool}` | `404` |
| `GET /v1/groups/{id}/messages?from={seq}` | — | `200 {items:[{seq, epoch, uploader_device, blob, commitment, franking_tag, recv_ts}]}` | `410 pruned` |

Gateway frames (CBOR arrays `[type, group_id, payload]`):

- `mls.handshake` — `{seq, epoch, kind, sender, blob}`: a Proposal, Commit or external commit
  accepted by the DS, fanned out to every member device.
- `mls.commit_needed` — `{epoch, proposal_refs, deadline_ms}`: the DS asks one device to commit
  outstanding proposals (invariant 7).
- `mls.epoch_changed` — `{epoch, seq}`: informational, after a commit.
- `message.ct` — `{seq, epoch, uploader_device, blob, commitment, franking_tag, recv_ts}`.
- `mls.welcome` — `{group_id, blob}`: delivered to the device a Welcome is addressed to.

## Invariants

Each invariant has a chaos scenario in `dilla-testkit` named after it.

1. **Registration.** A group is registered with its `dilla_binding`. The DS refuses a `text` group
   for a channel whose mode is `readable` or whose visibility is `discoverable` (`403 mode_readable`).
   `call` groups exist for every voice session regardless of the channel's text mode.
2. **Tree service.** The DS keeps a `PublicGroup` per group. Committers upload a GroupInfo
   **without** the ratchet tree; the DS serves the tree from its own `PublicGroup`, and a joiner
   MUST verify `tree_hash` in the GroupInfo against the served tree before joining.
3. **One commit per epoch.** The first valid Commit for epoch `n` wins; a later one for the same
   epoch gets `409 commit_conflict` with the winning commit and the current outstanding proposals.
4. **Commit validity.** A Commit is accepted only if: it is signed by a current leaf or is a valid
   external commit; it references every outstanding non-void DS proposal (invariant 6); it
   contains no `Update` from the committer; every member-originated `Remove` targets the
   committer's own user; every `Add` carries a credential whose user is eligible under the channel's
   ACL and whose DSK is in the newest signed device list the DS holds; the `PublicGroup` validates
   it structurally; and the uploaded GroupInfo's epoch is `n + 1`. Otherwise `422 commit_invalid`.
5. **Freeze.** While any DS proposal is outstanding for a group, application messages get
   `425 commit_required`, and external commits get `425 commit_required` too — **unless no member
   device is online**, in which case the external commit is accepted, the outstanding proposals are
   re-issued for the new epoch, and `mls.commit_needed` goes to the joiner. After any commit that
   omitted DS proposals (only possible via this exception), non-void ones are re-issued and the
   freeze stays.
6. **Void.** Before proposing, the DS validates a KeyPackage (lifetime not expired, capabilities
   include `0xF001`, not consumed) and a Remove target (leaf still present). A DS proposal older
   than its TTL — 30 seconds in `call` groups, 24 hours in `text` groups — is marked **void**; a
   Commit MAY omit void proposals. The underlying action is retried with a fresh KeyPackage, or
   dropped if the target leaf is already gone.
7. **Committer election.** `mls.commit_needed` goes to the lowest-index online device, bot devices
   first; other devices back off `300 ms + random(0..300 ms)`; a 2-second watchdog nudges the next
   candidate; after three lost rounds the failing device is removed by a DS Remove.
8. **Current-leaf sends.** Application messages are accepted only from a device session whose
   leaf is in the current `PublicGroup` (`403 leaf_not_current`).
9. **Fork handling.** A member that cannot process an accepted Commit reports it
   (`POST /fork-report`) and resyncs to the DS head by external commit. Three distinct reports
   against one Commit quarantine the committer: DS Remove of its leaf and a flag on the device.
10. **Retention.** Handshakes are kept 30 days. Application ciphertext is kept until every member
    device's cursor has passed it, or 30 days, whichever is first. Cursors are per device.
11. **Restore.** `dillad restore` bumps the instance `generation`. Every group becomes
    epoch-unknown. The first member-signed GroupInfo with epoch ≥ the stored epoch, together with
    that member's handshake tail (clients keep the last 64 handshakes per group), is replayed
    through the `PublicGroup` and adopted. If none arrives within 24 hours the group is closed and
    re-created by the channel owner's device. All non-last-resort KeyPackages are purged on
    restore. Live calls end.

## Errors

| HTTP | code | meaning | client action |
|---|---|---|---|
| 409 | `commit_conflict` | another commit won this epoch | discard own pending commit, process the winning one, retry |
| 425 | `commit_required` | outstanding DS proposals must be committed first | commit them (or wait for `commit_needed`), then resend |
| 422 | `commit_invalid` | structural or policy failure, `reason` names the rule | do not retry unchanged; resync if the local state is behind |
| 403 | `leaf_not_current` | the sending device's leaf is not in the current tree | resync by external commit; show "you are no longer a member" if the resync is refused |
| 403 | `mode_readable` | text groups are not allowed for this channel | none; the channel is server-readable |
| 410 | `pruned` | requested `seq` is older than retention | resync by external commit; mark older messages "undecryptable (too old)" |
| 413 | `too_large` | ciphertext exceeds the instance limit (default 64 KiB) | split or attach |

## Retention

Defaults: handshakes 30 days; application ciphertext per invariant 10; KeyPackages until consumed
or their MLS lifetime expires (clients set 90 days); GroupInfo latest only; `PublicGroup` state
current epoch only, with the last 64 handshakes retained for restore. An instance MAY shorten
these for `text` groups per community policy; it MUST NOT lengthen the handshake window beyond 30
days without also lengthening client-side past-epoch retention, which this version does not allow.
```

- [ ] **Step 2: Run the checker and commit**

Run: `npm run check:docs`
Expected: `02-delivery-service.md` reports no problems.

```bash
git add protocol/02-delivery-service.md
git commit -s -m "docs(protocol): delivery service API, invariants, errors, retention"
```

---

### Task 5: Identity, credentials, device lists, custody, pairing, recovery, safety numbers

**Files:**
- Create: `protocol/03-identity.md`

**Interfaces:**
- Consumes: terminology (Task 2), group kinds (Task 3).
- Produces: the credential identity CBOR layout (10 elements), the signature domain strings `"dilla ssk v1"` and `"dilla dsk v1"`, the device-list layout, the recovery-key derivation labels `"dilla header v1"` / `"dilla archive v1"`, the safety-number and SAS encodings used by Task 6's vectors (`safety-number.json`, `recovery-key.json`).

- [ ] **Step 1: Write the document**

`protocol/03-identity.md`:
```markdown
# 03 — Identity

## Keys

Per user:

- **UMK** (user master key): Ed25519. Generated at signup on the first device. The private key is
  stored **only** in the recovery-key-encrypted header (`06-backup-archive.md`) and, transiently,
  on the device performing signup or recovery. It signs exactly one thing: the SSK.
- **SSK** (user signing key): Ed25519, signed by the UMK. The private key lives on every `native`
  device of the user, never on a `browser` device. It signs device credentials and the device list.

Per device:

- **DSK** (device signing key): Ed25519. It is the MLS leaf signature key. Generated on the device;
  the private key never leaves it. Stored in the OS keystore where one exists (Keychain, DPAPI,
  libsecret or KWallet, Android Keystore, iOS Secure Enclave-backed keychain); in IndexedDB on the
  `browser` tier.

Signature domains (the message signed is the domain string in UTF-8 followed by the fields, with
no separators):

- `sig_umk_ssk = Ed25519.sign(UMK_priv, "dilla ssk v1" || ssk_pub)`
- `sig_ssk_dev = Ed25519.sign(SSK_priv, "dilla dsk v1" || device_id || dsk_pub || tier)` where
  `tier` is one byte (0 native, 1 browser). For a browser device signed by a one-shot recovery-key
  entry, the signer is still the SSK (reconstituted from the header in memory and zeroised
  afterwards) and `signer_tier` in the credential is 1.

Instance key rotation: a new instance signing key is announced with
`sig_old(new_pub || "dilla instance rotate v1")`; clients accept the `GroupContextExtensions`
proposal that replaces `external_senders` only when that signature verifies under the previous key.

## Credential

Every leaf uses an MLS `basic` credential whose `identity` is the deterministic CBOR encoding of:

```
[
  v,             ; uint, = 1
  umk_pub,       ; bstr, 32
  user_id,       ; bstr, 16
  device_id,     ; bstr, 16
  kind,          ; uint: 0 user, 1 bot
  tier,          ; uint: 0 native, 1 browser
  signer_tier,   ; uint: 0 native, 1 browser (tier of the device or entry that signed this device)
  ssk_pub,       ; bstr, 32
  sig_umk_ssk,   ; bstr, 64
  sig_ssk_dev    ; bstr, 64
]
```

The leaf's `signature_key` MUST equal the `dsk_pub` covered by `sig_ssk_dev`; the verifier
reconstructs the signed message from the credential fields and the leaf's signature key. A leaf is
accepted only if:

1. both signatures verify;
2. `umk_pub` equals the pinned UMK for `user_id` on this instance (trust-on-first-use with a
   loud, undismissable alert on change), or no pin exists yet;
3. `dsk_pub` for `device_id` appears, unrevoked, in the newest **signed device list** the verifier
   has seen for this user (below);
4. `dilla_binding` checks of `01-groups.md` pass for the group.

Failing 1, 3 or 4 rejects the leaf (`E_CREDENTIAL`); failing 2 hard-rejects (`E_UMK_CHANGED`).

## Device list

The user's devices are published as a hash-chained, SSK-signed list. The DS stores and serves it;
it cannot forge it. Deterministic CBOR:

```
[
  v,           ; uint, = 1
  user_id,     ; bstr, 16
  version,     ; uint, monotonically increasing from 1
  prev_hash,   ; bstr, 32: SHA-256 of the previous list's CBOR bytes; 32 zero bytes for version 1
  entries,     ; array of [device_id (bstr 16), dsk_pub (bstr 32), tier (uint), added_at (uint),
               ;           revoked_at (uint or null)]
  sig_ssk      ; bstr, 64: Ed25519.sign(SSK_priv, "dilla devices v1" || CBOR of elements 0..4)
]
```

Rules: a verifier keeps the newest `version` it has validated per user and MUST reject a list
whose `version` is not greater than that, whose `prev_hash` does not match, or whose signature
fails. A leaf whose `device_id` is absent or has `revoked_at` set in the newest list is rejected
(`E_DEVICE_UNLISTED`) and any message from it is not rendered. Revocation is therefore
cryptographic and does not depend on the instance.

## Custody by tier

| secret | native device | browser device |
|---|---|---|
| `UMK_priv` | never (only in the recovery header) | never |
| `SSK_priv` | yes | never |
| `DSK_priv` | yes, in the OS keystore | yes, in IndexedDB |
| `K_backup` (archive key) | yes | only if the user enables "history in browser sessions" (default off) |
| MLS group state | yes | yes (OPFS) |

A browser device can therefore decrypt and send in groups it belongs to, but cannot enrol other
devices or publish device lists. Peers show a `web` tag on members whose message came from a
`browser`-tier leaf.

## Pairing

Enrolling a new device is a two-leaf `pairing` group without external senders:

1. The new device generates its DSK and shows a QR code (or a 12-character fingerprint) of
   `SHA-256(dsk_pub)`.
2. The authorising device (which holds `SSK_priv`) creates the pairing group with
   `dilla_binding.kind = 2` and `target_id = new device_id`, and adds the new device's KeyPackage.
   It MUST refuse to continue unless the tree has exactly two leaves and the peer's leaf signature
   key hashes to the scanned fingerprint.
3. Both devices compute the **SAS** from the MLS `epoch_authenticator` of the epoch after the Add
   (below) and the user confirms the same digits appear on both screens.
4. The authorising device sends, as application messages in the pairing group: the signed device
   credential for the new device; and, only if the new device is `native`, `SSK_priv`, `K_backup`
   and the UMK pin table. To a `browser` device it sends the credential only (plus `K_backup` if the
   user opted in).
5. The authorising device publishes a new signed device list including the new device, then both
   devices delete the pairing group.

## Recovery

At signup the client generates a 256-bit **recovery key** `RK` and shows it once, in two forms the
user may write down: 24 BIP-39 English words (BIP-39 checksum, 256-bit entropy) or 52 Crockford
base32 characters in 13 groups of 4 (no checksum). The client MUST require the user to acknowledge
that the key was written down before continuing; it MUST NOT offer a copy button on that screen.

Derived keys: `K_header = HKDF-SHA256(salt = "", IKM = RK, info = "dilla header v1", L = 32)` and
`K_backup = HKDF-SHA256(salt = "", IKM = RK, info = "dilla archive v1", L = 32)`.

The **header** (`06-backup-archive.md`) holds `UMK_priv`, `SSK_priv`, the device list and the UMK
pin table under `K_header`. Recovering on a new device with only `RK`: fetch the header, derive
`K_header`, decrypt, enrol the new device by signing its credential with the recovered `SSK_priv`,
publish a new device list revoking any device the user no longer holds, then restore history from
the archive under `K_backup`. A user who loses every device **and** `RK` loses their history; the
instance cannot help, and the onboarding copy says so.

## Safety number

Two users compare a 60-digit safety number derived from both UMKs:

```
digits = decimal(SHA-256(min(umk_a, umk_b) || max(umk_a, umk_b)))   ; min/max by byte order
safety_number = the first 60 digits of `digits` left-padded with zeros to 78 digits
displayed as 12 groups of 5
```

The **SAS** for pairing (and for optional call verification) is derived from the MLS
`epoch_authenticator` (32 bytes): `sas = the first 30 digits of decimal(epoch_authenticator)
left-padded to 78 digits`, displayed as 6 groups of 5. A `call` group's SAS is shown as the call
code in the voice UI (the daily-use design shows only its first 6 digits as two groups of 3, e.g.
`41 72 90`, the remaining digits on request).

## Error codes

`E_CREDENTIAL`, `E_UMK_CHANGED`, `E_DEVICE_UNLISTED`, `E_DEVICE_LIST_STALE`, `E_PAIRING_LEAVES`,
`E_PAIRING_FINGERPRINT`.
```

- [ ] **Step 2: Run the checker and commit**

Run: `npm run check:docs`
Expected: `03-identity.md` reports no problems.

```bash
git add protocol/03-identity.md
git commit -s -m "docs(protocol): identity keys, credentials, device lists, custody, pairing, recovery, safety numbers"
```

---

### Task 6: Reference implementation package — deterministic CBOR

**Files:**
- Create: `packages/protocol-vectors/package.json`
- Create: `packages/protocol-vectors/LICENSE` (copy of `LICENSE-APACHE`)
- Create: `packages/protocol-vectors/tsconfig.json`
- Create: `packages/protocol-vectors/vitest.config.ts`
- Create: `packages/protocol-vectors/src/cbor.ts`
- Test: `packages/protocol-vectors/src/cbor.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `encode(value: CborValue): Uint8Array` and `decode(bytes: Uint8Array): CborValue` where `type CborValue = number | bigint | string | Uint8Array | null | CborValue[]`; `hex(bytes)`, `fromHex(str)`, `concat(...parts)` in `src/bytes.ts` (created here too).

- [ ] **Step 1: Create the package scaffolding**

`packages/protocol-vectors/package.json`:
```json
{
  "name": "@dilla/protocol-vectors",
  "version": "0.1.0",
  "private": true,
  "license": "Apache-2.0",
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "vitest run",
    "vectors": "node --experimental-strip-types src/generate.ts"
  },
  "devDependencies": {
    "typescript": "^5.6",
    "vitest": "^3"
  }
}
```

`packages/protocol-vectors/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`packages/protocol-vectors/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
```

Run: `cp LICENSE-APACHE packages/protocol-vectors/LICENSE && npm install` (from the repository root; installs vitest and typescript into the workspace).

- [ ] **Step 2: Write the failing CBOR tests (RFC 8949 Appendix A known answers)**

`packages/protocol-vectors/src/cbor.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { encode, decode } from './cbor.ts';
import { hex, fromHex } from './bytes.ts';

const cases: Array<[unknown, string]> = [
  [0, '00'], [1, '01'], [10, '0a'], [23, '17'], [24, '1818'], [25, '1819'], [100, '1864'],
  [1000, '1903e8'], [1000000, '1a000f4240'], [1000000000000n, '1b000000e8d4a51000'],
  ['', '60'], ['a', '6161'], ['IETF', '6449455446'], ['ü', '62c3bc'],
  [new Uint8Array([]), '40'], [new Uint8Array([1, 2, 3, 4]), '4401020304'],
  [null, 'f6'], [[], '80'], [[1, 2, 3], '83010203'],
  [[1, [2, 3], [4, 5]], '8301820203820405'],
  [Array.from({ length: 25 }, (_, i) => i + 1), '98190102030405060708090a0b0c0d0e0f101112131415161718181819'],
];

describe('deterministic CBOR encode', () => {
  for (const [value, expected] of cases) {
    it(`encodes ${JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v)} as ${expected}`, () => {
      expect(hex(encode(value as never))).toBe(expected);
    });
  }
  it('rejects negative numbers, floats, maps and undefined', () => {
    expect(() => encode(-1 as never)).toThrow();
    expect(() => encode(1.5 as never)).toThrow();
    expect(() => encode({} as never)).toThrow();
    expect(() => encode(undefined as never)).toThrow();
  });
});

describe('CBOR decode', () => {
  for (const [value, expected] of cases) {
    it(`decodes ${expected}`, () => {
      const decoded = decode(fromHex(expected));
      const norm = (v: unknown): unknown => typeof v === 'bigint' && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      expect(JSON.stringify(decoded, (_, v) => typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : v))
        .toBe(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : norm(v)));
    });
  }
  it('rejects indefinite-length and non-minimal encodings', () => {
    expect(() => decode(fromHex('9f01ff'))).toThrow();   // indefinite array
    expect(() => decode(fromHex('1801'))).toThrow();     // 1 encoded with one extra byte
    expect(() => decode(fromHex('a0'))).toThrow();       // map
    expect(() => decode(fromHex('0101'))).toThrow();     // trailing bytes
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test --workspace packages/protocol-vectors`
Expected: FAIL with `Failed to resolve import "./cbor.ts"`.

- [ ] **Step 4: Write `bytes.ts` and `cbor.ts`**

`packages/protocol-vectors/src/bytes.ts`:
```ts
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-f]/.test(s)) throw new Error(`bad hex: ${s}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function utf8(s: string): Uint8Array { return new TextEncoder().encode(s); }
export function be64(n: bigint | number): Uint8Array {
  const v = BigInt(n); const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) out[i] = Number((v >> BigInt(8 * (7 - i))) & 0xffn);
  return out;
}
export function be16(n: number): Uint8Array { return new Uint8Array([(n >> 8) & 0xff, n & 0xff]); }
```

`packages/protocol-vectors/src/cbor.ts`:
```ts
// Deterministic CBOR (RFC 8949 §4.2.1) for the subset dilla uses:
// unsigned integers, byte strings, text strings, null, and definite-length arrays. Never maps.
export type CborValue = number | bigint | string | Uint8Array | null | CborValue[];

function head(major: number, n: bigint): Uint8Array {
  const m = major << 5;
  if (n < 24n) return new Uint8Array([m | Number(n)]);
  if (n < 0x100n) return new Uint8Array([m | 24, Number(n)]);
  if (n < 0x10000n) return new Uint8Array([m | 25, Number(n >> 8n), Number(n & 0xffn)]);
  if (n < 0x100000000n) return new Uint8Array([m | 26, Number(n >> 24n), Number((n >> 16n) & 0xffn), Number((n >> 8n) & 0xffn), Number(n & 0xffn)]);
  const out = new Uint8Array(9); out[0] = m | 27;
  for (let i = 0; i < 8; i++) out[1 + i] = Number((n >> BigInt(8 * (7 - i))) & 0xffn);
  return out;
}

export function encode(value: CborValue): Uint8Array {
  const parts: Uint8Array[] = [];
  const push = (v: CborValue) => {
    if (v === null) { parts.push(new Uint8Array([0xf6])); return; }
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) throw new Error(`not an unsigned safe integer: ${v}`);
      parts.push(head(0, BigInt(v))); return;
    }
    if (typeof v === 'bigint') {
      if (v < 0n || v > 0xffffffffffffffffn) throw new Error(`out of range: ${v}`);
      parts.push(head(0, v)); return;
    }
    if (typeof v === 'string') { const b = new TextEncoder().encode(v); parts.push(head(3, BigInt(b.length)), b); return; }
    if (v instanceof Uint8Array) { parts.push(head(2, BigInt(v.length)), v); return; }
    if (Array.isArray(v)) { parts.push(head(4, BigInt(v.length))); for (const e of v) push(e); return; }
    throw new Error(`unsupported CBOR value: ${typeof v}`);
  };
  push(value);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function decode(bytes: Uint8Array): CborValue {
  let pos = 0;
  const need = (n: number) => { if (pos + n > bytes.length) throw new Error('truncated'); };
  const readArg = (ai: number, major: number): bigint => {
    if (ai < 24) return BigInt(ai);
    const len = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : ai === 27 ? 8 : -1;
    if (len < 0) throw new Error(`indefinite or reserved additional info ${ai} for major ${major}`);
    need(len); let v = 0n;
    for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(bytes[pos++]);
    const min = len === 1 ? 24n : len === 2 ? 0x100n : len === 4 ? 0x10000n : 0x100000000n;
    if (v < min) throw new Error('non-minimal integer encoding');
    return v;
  };
  const item = (): CborValue => {
    need(1);
    const b = bytes[pos++]; const major = b >> 5; const ai = b & 0x1f;
    switch (major) {
      case 0: { const v = readArg(ai, 0); return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v; }
      case 2: { const n = Number(readArg(ai, 2)); need(n); const s = bytes.slice(pos, pos + n); pos += n; return s; }
      case 3: { const n = Number(readArg(ai, 3)); need(n); const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(pos, pos + n)); pos += n; return s; }
      case 4: { const n = Number(readArg(ai, 4)); const arr: CborValue[] = []; for (let i = 0; i < n; i++) arr.push(item()); return arr; }
      case 7: { if (ai === 22) return null; throw new Error(`unsupported simple value ${ai}`); }
      default: throw new Error(`unsupported major type ${major}`);
    }
  };
  const v = item();
  if (pos !== bytes.length) throw new Error('trailing bytes');
  return v;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test --workspace packages/protocol-vectors`
Expected: PASS (all encode and decode cases, both rejection tests).

- [ ] **Step 6: Commit**

```bash
git add packages/protocol-vectors package-lock.json
git commit -s -m "feat(protocol-vectors): deterministic CBOR encoder and decoder with RFC 8949 known answers"
```

---

### Task 7: Envelope and franking — reference implementation and vectors

**Files:**
- Create: `packages/protocol-vectors/src/hmac.ts`
- Create: `packages/protocol-vectors/src/envelope.ts`
- Create: `packages/protocol-vectors/src/generate.ts`
- Test: `packages/protocol-vectors/src/hmac.test.ts`
- Test: `packages/protocol-vectors/src/envelope.test.ts`
- Create (generated): `protocol/vectors/envelope.json`, `protocol/vectors/franking.json`

**Interfaces:**
- Consumes: `encode`, `decode` (Task 6); `bytes.ts` helpers.
- Produces:
  - `hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>`;
  - `type Envelope = { v: 1; msgId: Uint8Array; type: EnvelopeType; threadId: Uint8Array | null; replyTo: Uint8Array | null; body: string; attachments: Attachment[]; previews: Preview[]; kf: Uint8Array }`;
  - `encodeEnvelope(e: Envelope): Uint8Array`, `decodeEnvelope(b: Uint8Array): Envelope`;
  - `frankingCommitment(e: Envelope): Promise<Uint8Array>` (32 bytes);
  - `frankingTag(instanceKey, groupId, epoch, seq, uploaderDevice, commitment, recvTs): Promise<Uint8Array>`;
  - `paddedLength(n: number): number` (next multiple of 256).
  - The generator entry point `src/generate.ts` writing every vector file (extended by Task 9).

- [ ] **Step 1: Write the failing HMAC test (RFC 4231 test case 2)**

`packages/protocol-vectors/src/hmac.test.ts`:
```ts
import { it, expect } from 'vitest';
import { hmacSha256 } from './hmac.ts';
import { hex, utf8 } from './bytes.ts';

it('matches RFC 4231 test case 2', async () => {
  const mac = await hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?'));
  expect(hex(mac)).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace packages/protocol-vectors -- hmac`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `hmac.ts`**

```ts
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}
```

- [ ] **Step 4: Run the HMAC test to verify it passes**

Run: `npm test --workspace packages/protocol-vectors -- hmac`
Expected: PASS.

- [ ] **Step 5: Write the failing envelope tests**

`packages/protocol-vectors/src/envelope.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { encodeEnvelope, decodeEnvelope, frankingCommitment, frankingTag, paddedLength, EnvelopeType, type Envelope } from './envelope.ts';
import { decode } from './cbor.ts';
import { hex, fromHex } from './bytes.ts';

const id = (n: number) => new Uint8Array(16).fill(n);
const sample: Envelope = {
  v: 1, msgId: id(1), type: EnvelopeType.Message, threadId: null, replyTo: id(2),
  body: 'On my way. Grab the wolf capes from the chest by the portal.',
  attachments: [{ blobId: new Uint8Array(32).fill(3), key: new Uint8Array(32).fill(4), nonce: new Uint8Array(12).fill(5), size: 2100000, mime: 'image/jpeg', w: 1600, h: 900, thumb: null }],
  previews: [],
  kf: new Uint8Array(32).fill(6),
};

describe('envelope', () => {
  it('encodes as a fixed-position 9-element array', () => {
    const bytes = encodeEnvelope(sample);
    const arr = decode(bytes) as unknown[];
    expect(arr.length).toBe(9);
    expect(arr[0]).toBe(1);
    expect(hex(arr[1] as Uint8Array)).toBe(hex(id(1)));
    expect(arr[2]).toBe(0);
    expect(arr[3]).toBeNull();
  });
  it('round-trips', () => {
    expect(decodeEnvelope(encodeEnvelope(sample))).toEqual(sample);
  });
  it('rejects the wrong element count', () => {
    expect(() => decodeEnvelope(fromHex('8801' + '50' + '00'.repeat(16)))).toThrow();
  });
  it('pads to 256-byte buckets', () => {
    expect(paddedLength(1)).toBe(256);
    expect(paddedLength(256)).toBe(256);
    expect(paddedLength(257)).toBe(512);
  });
  it('commitment changes when the body changes and is independent of k_f placement', async () => {
    const c1 = await frankingCommitment(sample);
    const c2 = await frankingCommitment({ ...sample, body: sample.body + '!' });
    expect(c1.length).toBe(32);
    expect(hex(c1)).not.toBe(hex(c2));
    // the commitment is an HMAC under k_f of the envelope with k_f blanked: recomputable by a recipient
    const again = await frankingCommitment(sample);
    expect(hex(again)).toBe(hex(c1));
  });
  it('tag is 32 bytes and binds the sequence number', async () => {
    const key = new Uint8Array(32).fill(9);
    const c = await frankingCommitment(sample);
    const t1 = await frankingTag(key, id(7), 41, 4128, id(8), c, 1758659700);
    const t2 = await frankingTag(key, id(7), 41, 4129, id(8), c, 1758659700);
    expect(t1.length).toBe(32);
    expect(hex(t1)).not.toBe(hex(t2));
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npm test --workspace packages/protocol-vectors -- envelope`
Expected: FAIL, module not found.

- [ ] **Step 7: Write `envelope.ts`**

```ts
import { encode, decode, type CborValue } from './cbor.ts';
import { hmacSha256 } from './hmac.ts';
import { concat, utf8, be64 } from './bytes.ts';

export enum EnvelopeType { Message = 0, Edit = 1, Delete = 2, ReactionAdd = 3, ReactionRemove = 4, Pin = 5, Unpin = 6 }

export type Attachment = { blobId: Uint8Array; key: Uint8Array; nonce: Uint8Array; size: number; mime: string; w: number | null; h: number | null; thumb: Uint8Array | null };
export type Preview = { url: string; title: string; description: string; image: Uint8Array | null };
export type Envelope = {
  v: 1; msgId: Uint8Array; type: EnvelopeType; threadId: Uint8Array | null; replyTo: Uint8Array | null;
  body: string; attachments: Attachment[]; previews: Preview[]; kf: Uint8Array;
};

const FRANK_DOMAIN = utf8('dilla frank v1');
const TAG_DOMAIN = utf8('dilla frank tag v1');

function assertLen(b: Uint8Array, n: number, what: string) { if (b.length !== n) throw new Error(`${what}: expected ${n} bytes, got ${b.length}`); }

function toArray(e: Envelope, kf: Uint8Array): CborValue {
  assertLen(e.msgId, 16, 'msg_id');
  if (e.threadId) assertLen(e.threadId, 16, 'thread_id');
  if (e.replyTo) assertLen(e.replyTo, 16, 'reply_to');
  return [
    e.v, e.msgId, e.type, e.threadId, e.replyTo, e.body,
    e.attachments.map(a => { assertLen(a.blobId, 32, 'blob_id'); assertLen(a.key, 32, 'key'); assertLen(a.nonce, 12, 'nonce');
      return [a.blobId, a.key, a.nonce, a.size, a.mime, a.w, a.h, a.thumb]; }),
    e.previews.map(p => [p.url, p.title, p.description, p.image]),
    kf,
  ];
}

export function encodeEnvelope(e: Envelope): Uint8Array {
  assertLen(e.kf, 32, 'k_f');
  return encode(toArray(e, e.kf));
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const a = decode(bytes);
  if (!Array.isArray(a) || a.length !== 9) throw new Error('envelope: expected a 9-element array');
  const [v, msgId, type, threadId, replyTo, body, attachments, previews, kf] = a as [number, Uint8Array, number, Uint8Array | null, Uint8Array | null, string, CborValue[], CborValue[], Uint8Array];
  if (v !== 1) throw new Error(`envelope: unsupported version ${v}`);
  if (!(type in EnvelopeType)) throw new Error(`envelope: unknown type ${type}`);
  assertLen(msgId, 16, 'msg_id'); assertLen(kf, 32, 'k_f');
  return {
    v: 1, msgId, type, threadId, replyTo, body,
    attachments: attachments.map(x => { const [blobId, key, nonce, size, mime, w, h, thumb] = x as [Uint8Array, Uint8Array, Uint8Array, number, string, number | null, number | null, Uint8Array | null]; return { blobId, key, nonce, size, mime, w, h, thumb }; }),
    previews: previews.map(x => { const [url, title, description, image] = x as [string, string, string, Uint8Array | null]; return { url, title, description, image }; }),
    kf,
  };
}

export function paddedLength(n: number): number { return Math.ceil(n / 256) * 256; }

/** C = HMAC-SHA256(K_f, "dilla frank v1" || CBOR(envelope with k_f = empty bstr)) */
export async function frankingCommitment(e: Envelope): Promise<Uint8Array> {
  const blanked = encode(toArray(e, new Uint8Array(0)));
  return hmacSha256(e.kf, concat(FRANK_DOMAIN, blanked));
}

/** T = HMAC-SHA256(K_frank, "dilla frank tag v1" || group_id || epoch(8) || seq(8) || uploader_device || C || recv_ts(8)) */
export async function frankingTag(instanceKey: Uint8Array, groupId: Uint8Array, epoch: number, seq: number, uploaderDevice: Uint8Array, commitment: Uint8Array, recvTs: number): Promise<Uint8Array> {
  assertLen(groupId, 16, 'group_id'); assertLen(uploaderDevice, 16, 'uploader_device'); assertLen(commitment, 32, 'commitment');
  return hmacSha256(instanceKey, concat(TAG_DOMAIN, groupId, be64(epoch), be64(seq), uploaderDevice, commitment, be64(recvTs)));
}
```

- [ ] **Step 8: Run the envelope tests to verify they pass**

Run: `npm test --workspace packages/protocol-vectors -- envelope`
Expected: PASS (6 tests).

- [ ] **Step 9: Write the vector generator**

`packages/protocol-vectors/src/generate.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hex } from './bytes.ts';
import { encodeEnvelope, frankingCommitment, frankingTag, EnvelopeType, type Envelope } from './envelope.ts';

export const VECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'protocol', 'vectors');
const fill = (n: number, b: number) => new Uint8Array(n).fill(b);
const j = (o: unknown) => JSON.stringify(o, (_, v) => v instanceof Uint8Array ? hex(v) : v, 2) + '\n';

export async function envelopeVectors() {
  const cases: Array<{ name: string; envelope: Envelope }> = [
    { name: 'text message with a reply and one attachment', envelope: {
      v: 1, msgId: fill(16, 0x01), type: EnvelopeType.Message, threadId: null, replyTo: fill(16, 0x02),
      body: 'On my way. Grab the wolf capes from the chest by the portal.',
      attachments: [{ blobId: fill(32, 0x03), key: fill(32, 0x04), nonce: fill(12, 0x05), size: 2100000, mime: 'image/jpeg', w: 1600, h: 900, thumb: null }],
      previews: [], kf: fill(32, 0x06) } },
    { name: 'reaction add in a thread', envelope: {
      v: 1, msgId: fill(16, 0x11), type: EnvelopeType.ReactionAdd, threadId: fill(16, 0x12), replyTo: fill(16, 0x13),
      body: '⛏', attachments: [], previews: [], kf: fill(32, 0x16) } },
    { name: 'delete tombstone', envelope: {
      v: 1, msgId: fill(16, 0x21), type: EnvelopeType.Delete, threadId: null, replyTo: fill(16, 0x01),
      body: '', attachments: [], previews: [], kf: fill(32, 0x26) } },
    { name: 'message with a sender-generated link preview', envelope: {
      v: 1, msgId: fill(16, 0x31), type: EnvelopeType.Message, threadId: null, replyTo: null,
      body: 'https://valheim.fandom.com/wiki/Silver', attachments: [],
      previews: [{ url: 'https://valheim.fandom.com/wiki/Silver', title: 'Silver', description: 'Silver is a metal found in the Mountains.', image: null }],
      kf: fill(32, 0x36) } },
  ];
  const out = [];
  for (const c of cases) {
    const bytes = encodeEnvelope(c.envelope);
    out.push({ name: c.name, envelope: c.envelope, cbor: hex(bytes), length: bytes.length, padded_length: Math.ceil(bytes.length / 256) * 256, commitment: hex(await frankingCommitment(c.envelope)) });
  }
  return { version: 1, description: 'dilla envelope encodings (04-envelope-and-franking.md). cbor = deterministic CBOR of the 9-element array; commitment = HMAC-SHA256(k_f, "dilla frank v1" || CBOR with k_f blanked).', cases: out };
}

export async function frankingVectors() {
  const env: Envelope = { v: 1, msgId: fill(16, 0x01), type: EnvelopeType.Message, threadId: null, replyTo: null, body: 'Found a silver vein under the mountain.', attachments: [], previews: [], kf: fill(32, 0x06) };
  const commitment = await frankingCommitment(env);
  const instanceKey = fill(32, 0x09);
  const cases = [];
  for (const [epoch, seq, ts] of [[41, 4127, 1758659640], [41, 4128, 1758659700], [42, 4129, 1758659760]] as const) {
    cases.push({ group_id: hex(fill(16, 0x07)), epoch, seq, uploader_device: hex(fill(16, 0x08)), commitment: hex(commitment), recv_ts: ts,
      tag: hex(await frankingTag(instanceKey, fill(16, 0x07), epoch, seq, fill(16, 0x08), commitment, ts)) });
  }
  return { version: 1, description: 'franking tags: T = HMAC-SHA256(K_frank, "dilla frank tag v1" || group_id || epoch(8) || seq(8) || uploader_device || C || recv_ts(8))', instance_franking_key: hex(instanceKey), envelope_cbor: hex(encodeEnvelope(env)), cases };
}

export async function main() {
  mkdirSync(VECTORS_DIR, { recursive: true });
  writeFileSync(join(VECTORS_DIR, 'envelope.json'), j(await envelopeVectors()));
  writeFileSync(join(VECTORS_DIR, 'franking.json'), j(await frankingVectors()));
  console.log(`vectors written to ${VECTORS_DIR}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
```

- [ ] **Step 10: Generate and check determinism**

Run: `npm run vectors && npm run vectors && git status --short protocol/vectors`
Expected: `envelope.json` and `franking.json` exist; the second run changes nothing (the files appear once as untracked, never as modified after the second run).

- [ ] **Step 11: Commit**

```bash
git add packages/protocol-vectors/src protocol/vectors
git commit -s -m "feat(protocol-vectors): envelope encoding, franking commitment and tag, vectors"
```

---

### Task 8: Envelope and franking document

**Files:**
- Create: `protocol/04-envelope-and-franking.md`

**Interfaces:**
- Consumes: the exact layout implemented in Task 7 (the document and the code must agree; the vectors are the tie-breaker).
- Produces: the normative text for the Rust core's `envelope` module.

- [ ] **Step 1: Write the document**

`protocol/04-envelope-and-franking.md`:
```markdown
# 04 — Envelope and franking

## Envelope

Every application message in a `text` or `interaction` group is one **envelope**, the MLS
`PrivateMessage` application data. Deterministic CBOR, fixed-position array of 9 elements:

```
[
  v,             ; uint, = 1
  msg_id,        ; bstr, 16: random, chosen by the sender; edits/deletes/reactions reference it
  type,          ; uint: 0 message, 1 edit, 2 delete, 3 reaction add, 4 reaction remove, 5 pin, 6 unpin
  thread_id,     ; bstr 16 or null: the msg_id that roots the thread this belongs to
  reply_to,      ; bstr 16 or null: for type 0 the message replied to; for types 1..6 the target msg_id
  body,          ; tstr: markdown for type 0/1; the emoji for 3/4; empty for 2/5/6
  attachments,   ; array of [blob_id (bstr 32, SHA-256 of the ciphertext), key (bstr 32), nonce (bstr 12),
                 ;           size (uint, plaintext bytes), mime (tstr), w (uint|null), h (uint|null),
                 ;           thumb (bstr|null: a ≤ 16 KiB encrypted thumbnail, same key, nonce = nonce with last byte XOR 0x01)]
  previews,      ; array of [url (tstr), title (tstr), description (tstr), image (bstr|null)]
  k_f            ; bstr, 32: the franking key, random per envelope (also per edit)
]
```

Limits: `body` ≤ 4 000 UTF-8 bytes for type 0/1; ≤ 32 bytes for type 3/4; at most 10 attachments;
at most 5 previews; `image` in a preview ≤ 32 KiB. A receiver rejects an envelope over any limit
(`E_ENVELOPE_LIMIT`), of the wrong length (`E_ENVELOPE_SHAPE`), or with an unknown `type`
(`E_ENVELOPE_TYPE`); it MUST NOT render a partially valid envelope.

Attachments are encrypted by the sender with AES-256-GCM under the per-attachment random `key`
and `nonce`, uploaded as opaque blobs; `blob_id` is the SHA-256 of the ciphertext, and the
receiver MUST verify it after download. Previews are generated by the **sender**; receivers
MUST NOT fetch remote resources for an envelope.

Semantics: an `edit` replaces the body of `reply_to` if from the same user; a `delete` is a
tombstone honoured by clients (the DS also deletes its server copy on request from the uploader);
`reaction add/remove` toggles `body` for the sender on `reply_to`; `pin/unpin` require the
channel's pin permission in the receiver's role snapshot, otherwise they are ignored.

## Deterministic CBOR

RFC 8949 §4.2.1 core deterministic encoding: shortest integer form, definite lengths, no maps,
no floats, no tags, no indefinite items. Element order is normative. A receiver rejects
non-minimal encodings and trailing bytes.

**Padding.** The `PrivateMessage` carrying an envelope is padded (RFC 9420 §6.3.1) so that its
total ciphertext length is a multiple of 256 bytes.

## Franking

Franking lets a member report a message so that a moderator can verify what was sent, without the
instance ever reading content and without the reporter being able to forge it.

- **Commitment**, computed by the sender and carried in the `PrivateMessage`'s
  `authenticated_data` (exactly 32 bytes):
  `C = HMAC-SHA256(key = k_f, data = "dilla frank v1" || CBOR(envelope with k_f replaced by an empty bstr))`.
- **Receiver check.** Every receiver recomputes `C` from the decrypted envelope and hard-rejects a
  message whose `authenticated_data` differs (`E_FRANK_MISMATCH`).
- **Tag**, computed by the instance on upload with its per-instance franking key `K_frank`
  (32 random bytes, rotated yearly, old keys kept for verification):
  `T = HMAC-SHA256(K_frank, "dilla frank tag v1" || group_id || epoch(8, big-endian) || seq(8) || uploader_device(16) || C || recv_ts(8))`.
  The instance stores `(seq, epoch, uploader_device, C, T, recv_ts)` with the ciphertext and returns
  `T` and `recv_ts` to the uploader.
- **Report.** The reporter submits `(group_id, seq, envelope, k_f)`. The moderator's client
  recomputes `C` from the envelope and `k_f`, the instance recomputes `T` from its stored fields and
  the submitted `C`, and the report is verified only if both match the stored values. Authorship is
  bound through the instance's session-to-device record (an operator attestation, deniable to
  third parties); the report shows exactly the envelope submitted and nothing else.

## Vectors

`vectors/envelope.json` (four envelopes: CBOR bytes, length, padded length, commitment) and
`vectors/franking.json` (three tags under a fixed instance key). An implementation conforms when it
reproduces `cbor`, `commitment` and `tag` for every case and rejects the malformed inputs listed
in `packages/protocol-vectors/src/envelope.test.ts`.

## Error codes

`E_ENVELOPE_SHAPE`, `E_ENVELOPE_TYPE`, `E_ENVELOPE_LIMIT`, `E_FRANK_MISMATCH`, `E_BLOB_HASH`.
```

- [ ] **Step 2: Run the checker and commit**

Run: `npm run check:docs`
Expected: `04-envelope-and-franking.md` reports no problems.

```bash
git add protocol/04-envelope-and-franking.md
git commit -s -m "docs(protocol): envelope layout, deterministic CBOR, franking"
```

---

### Task 9: SFrame key schedule, KID and counters — reference implementation and vectors

**Files:**
- Create: `packages/protocol-vectors/src/hkdf.ts`
- Create: `packages/protocol-vectors/src/sframe.ts`
- Modify: `packages/protocol-vectors/src/generate.ts` (add `sframeVectors`, write `sframe.json`)
- Test: `packages/protocol-vectors/src/hkdf.test.ts`
- Test: `packages/protocol-vectors/src/sframe.test.ts`
- Create (generated): `protocol/vectors/sframe.json`

**Interfaces:**
- Consumes: `bytes.ts`, `hmac.ts`.
- Produces: `hkdfSha256(salt, ikm, info, length)`; `kid(leafIndex: number, epoch: number): bigint`; `deriveFrameKeys(baseKey: Uint8Array, kid: bigint): Promise<{ key: Uint8Array; salt: Uint8Array }>` for suite `0x0004`; `counter(slot, layer, seq): bigint`; `nonce(salt, ctr): Uint8Array`; `encodeSframeHeader(kid, ctr): Uint8Array`.

- [ ] **Step 1: Write the failing HKDF tests (RFC 5869 test cases 1 and 3)**

`packages/protocol-vectors/src/hkdf.test.ts`:
```ts
import { it, expect } from 'vitest';
import { hkdfSha256 } from './hkdf.ts';
import { hex, fromHex } from './bytes.ts';

it('matches RFC 5869 test case 1', async () => {
  const okm = await hkdfSha256(fromHex('000102030405060708090a0b0c'), fromHex('0b'.repeat(22)), fromHex('f0f1f2f3f4f5f6f7f8f9'), 42);
  expect(hex(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
});
it('matches RFC 5869 test case 3 (empty salt and info)', async () => {
  const okm = await hkdfSha256(new Uint8Array(0), fromHex('0b'.repeat(22)), new Uint8Array(0), 42);
  expect(hex(okm)).toBe('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8');
});
```

- [ ] **Step 2: Run to verify failure, then write `hkdf.ts`**

Run: `npm test --workspace packages/protocol-vectors -- hkdf` → FAIL, module not found.

`packages/protocol-vectors/src/hkdf.ts`:
```ts
/** HKDF-SHA256 (RFC 5869): Expand(Extract(salt, ikm), info, length). WebCrypto performs both steps. */
export async function hkdfSha256(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}
```

Run: `npm test --workspace packages/protocol-vectors -- hkdf` → PASS.

- [ ] **Step 3: Write the failing SFrame tests**

`packages/protocol-vectors/src/sframe.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { kid, deriveFrameKeys, counter, nonce, encodeSframeHeader, SUITE } from './sframe.ts';
import { hex, fromHex } from './bytes.ts';

describe('KID', () => {
  it('packs leaf index and epoch mod 256', () => {
    expect(kid(0, 0)).toBe(0n);
    expect(kid(3, 41)).toBe((3n << 8n) | 41n);
    expect(kid(3, 297)).toBe((3n << 8n) | 41n);
    expect(kid(65535, 255)).toBe((65535n << 8n) | 255n);
  });
  it('rejects a leaf index above 16 bits', () => { expect(() => kid(65536, 0)).toThrow(); });
});

describe('key derivation for suite 0x0004', () => {
  it('derives a 16-byte key and 12-byte salt that depend on the KID', async () => {
    const base = fromHex('00'.repeat(16));
    const a = await deriveFrameKeys(base, kid(1, 1));
    const b = await deriveFrameKeys(base, kid(2, 1));
    expect(a.key.length).toBe(16); expect(a.salt.length).toBe(12);
    expect(hex(a.key)).not.toBe(hex(b.key));
  });
  it('uses the RFC 9605 labels: "SFrame 1.0 Secret key " and "SFrame 1.0 Secret salt " followed by KID and suite', async () => {
    // Reference computation with the labels spelled out, independent of deriveFrameKeys.
    const { hkdfSha256 } = await import('./hkdf.ts');
    const { concat, utf8, be64, be16 } = await import('./bytes.ts');
    const base = fromHex('0102030405060708090a0b0c0d0e0f10');
    const k = kid(7, 9);
    const expectedKey = await hkdfSha256(new Uint8Array(0), base, concat(utf8('SFrame 1.0 Secret key '), be64(k), be16(SUITE)), 16);
    const expectedSalt = await hkdfSha256(new Uint8Array(0), base, concat(utf8('SFrame 1.0 Secret salt '), be64(k), be16(SUITE)), 12);
    const got = await deriveFrameKeys(base, k);
    expect(hex(got.key)).toBe(hex(expectedKey));
    expect(hex(got.salt)).toBe(hex(expectedSalt));
  });
});

describe('counter partition and nonce', () => {
  it('lays out slot(8) | layer(4) | seq(52)', () => {
    expect(counter(0, 0, 0)).toBe(0n);
    expect(counter(1, 0, 0)).toBe(1n << 56n);
    expect(counter(0, 1, 0)).toBe(1n << 52n);
    expect(counter(2, 3, 5)).toBe((2n << 56n) | (3n << 52n) | 5n);
  });
  it('refuses to wrap', () => {
    expect(() => counter(0, 0, 1n << 52n)).toThrow();
    expect(() => counter(256, 0, 0)).toThrow();
    expect(() => counter(0, 16, 0)).toThrow();
  });
  it('nonce is the 12-byte salt XOR the big-endian counter', () => {
    const salt = fromHex('000000000000000000000000');
    expect(hex(nonce(salt, 1n))).toBe('000000000000000000000001');
    expect(hex(nonce(fromHex('ff'.repeat(12)), 1n))).toBe('ff'.repeat(11) + 'fe');
  });
});

describe('SFrame header (RFC 9605 §4.3)', () => {
  it('encodes small KID and CTR in the config byte', () => {
    // K=0 (KID fits in 3 bits), X=0 (CTR fits in 3 bits): config byte 0b0KKK0CCC
    expect(hex(encodeSframeHeader(3n, 5n))).toBe('35');
  });
  it('encodes extended KID and CTR lengths', () => {
    // KID = 0x0329 needs 2 bytes → K=1, KLEN-1 = 1; CTR = 0x100000 needs 3 bytes → X=1, CLEN-1 = 2
    expect(hex(encodeSframeHeader(0x0329n, 0x100000n))).toBe('4a' + '0329' + '100000');
  });
});
```

- [ ] **Step 4: Run to verify failure, then write `sframe.ts`**

Run: `npm test --workspace packages/protocol-vectors -- sframe` → FAIL, module not found.

`packages/protocol-vectors/src/sframe.ts`:
```ts
import { hkdfSha256 } from './hkdf.ts';
import { concat, utf8, be64, be16 } from './bytes.ts';

/** SFrame cipher suite AES_128_GCM_SHA256_128 (RFC 9605 §4.4). */
export const SUITE = 0x0004;
const NK = 16, NN = 12;

/** KID = (leaf_index << 8) | (epoch mod 256); leaf_index < 2^16 (05-media-frames.md). */
export function kid(leafIndex: number, epoch: number): bigint {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex > 0xffff) throw new Error(`leaf index out of range: ${leafIndex}`);
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error(`epoch out of range: ${epoch}`);
  return (BigInt(leafIndex) << 8n) | BigInt(epoch % 256);
}

/** RFC 9605 §4.4.1: sframe_secret = Extract("", base_key); key/salt = Expand(secret, label || KID(8) || suite(2), N). */
export async function deriveFrameKeys(baseKey: Uint8Array, k: bigint): Promise<{ key: Uint8Array; salt: Uint8Array }> {
  const key = await hkdfSha256(new Uint8Array(0), baseKey, concat(utf8('SFrame 1.0 Secret key '), be64(k), be16(SUITE)), NK);
  const salt = await hkdfSha256(new Uint8Array(0), baseKey, concat(utf8('SFrame 1.0 Secret salt '), be64(k), be16(SUITE)), NN);
  return { key, salt };
}

/** CTR = slot(8 bits) || layer(4 bits) || seq(52 bits); refuse on wrap. */
export function counter(slot: number, layer: number, seq: bigint | number): bigint {
  const s = BigInt(seq);
  if (slot < 0 || slot > 0xff) throw new Error(`slot out of range: ${slot}`);
  if (layer < 0 || layer > 0xf) throw new Error(`layer out of range: ${layer}`);
  if (s < 0n || s >= (1n << 52n)) throw new Error('sequence counter exhausted');
  return (BigInt(slot) << 56n) | (BigInt(layer) << 52n) | s;
}

/** nonce = salt XOR CTR (big-endian, left-padded to 12 bytes). */
export function nonce(salt: Uint8Array, ctr: bigint): Uint8Array {
  if (salt.length !== NN) throw new Error('salt must be 12 bytes');
  const out = new Uint8Array(NN); let c = ctr;
  for (let i = NN - 1; i >= 0; i--) { out[i] = salt[i] ^ Number(c & 0xffn); c >>= 8n; }
  return out;
}

function minBytes(v: bigint): number { let n = 1; while (v >= (1n << BigInt(8 * n))) n++; return n; }
function beBytes(v: bigint, n: number): Uint8Array { const out = new Uint8Array(n); let c = v; for (let i = n - 1; i >= 0; i--) { out[i] = Number(c & 0xffn); c >>= 8n; } return out; }

/** RFC 9605 §4.3 header: config byte [R=0][K][KLEN or KID][X][CLEN or CTR], then extended KID and CTR bytes. */
export function encodeSframeHeader(k: bigint, ctr: bigint): Uint8Array {
  const kExt = k > 7n, cExt = ctr > 7n;
  const kLen = kExt ? minBytes(k) : 0, cLen = cExt ? minBytes(ctr) : 0;
  if (kLen > 8 || cLen > 8) throw new Error('KID or CTR too large for the header');
  const kField = kExt ? (kLen - 1) : Number(k);
  const cField = cExt ? (cLen - 1) : Number(ctr);
  const config = (kExt ? 0x40 : 0) | (kField << 3) | (cExt ? 0x08 : 0) | cField;
  return concat(new Uint8Array([config]), kExt ? beBytes(k, kLen) : new Uint8Array(0), cExt ? beBytes(ctr, cLen) : new Uint8Array(0));
}
```

Run: `npm test --workspace packages/protocol-vectors -- sframe` → PASS (9 tests).

- [ ] **Step 5: Add the SFrame vectors to the generator**

In `packages/protocol-vectors/src/generate.ts`, add after `frankingVectors`:
```ts
import { kid, deriveFrameKeys, counter, nonce, encodeSframeHeader, SUITE } from './sframe.ts';

export async function sframeVectors() {
  const baseKey = fill(16, 0x0a);
  const cases = [];
  for (const [leaf, epoch, slot, layer, seq] of [[0, 41, 0, 0, 0], [3, 41, 0, 0, 1], [3, 297, 1, 2, 1000], [65535, 255, 3, 15, (1 << 30)]] as const) {
    const k = kid(leaf, epoch);
    const { key, salt } = await deriveFrameKeys(baseKey, k);
    const ctr = counter(slot, layer, seq);
    cases.push({ leaf_index: leaf, epoch, kid: k.toString(), key: hex(key), salt: hex(salt), slot, layer, seq, ctr: ctr.toString(), nonce: hex(nonce(salt, ctr)), header: hex(encodeSframeHeader(k, ctr)) });
  }
  return { version: 1, suite: SUITE, description: 'dilla-sframe/1 key schedule (05-media-frames.md): base_key = MLS-Exporter("SFrame 1.0 Base Key", "", 16); key/salt per RFC 9605 §4.4.1; CTR = slot(8)|layer(4)|seq(52); nonce = salt XOR CTR; header per RFC 9605 §4.3.', base_key: hex(baseKey), cases };
}
```
and in `main()` add: `writeFileSync(join(VECTORS_DIR, 'sframe.json'), j(await sframeVectors()));`

- [ ] **Step 6: Generate, verify determinism, commit**

Run: `npm run vectors && npm run vectors && git status --short protocol/vectors`
Expected: `sframe.json` added; nothing modified on the second run.

```bash
git add packages/protocol-vectors/src protocol/vectors/sframe.json
git commit -s -m "feat(protocol-vectors): SFrame key schedule, KID, counter partition, header; vectors"
```

---

### Task 10: Media frames document

**Files:**
- Create: `protocol/05-media-frames.md`

**Interfaces:**
- Consumes: Task 9's derivations.
- Produces: the normative text for the media worker and the Go `FrameEncryptor`.

- [ ] **Step 1: Write the document**

`protocol/05-media-frames.md`:
```markdown
# 05 — Media frames (`dilla-sframe/1`)

Every audio, video and screen-share frame in a `call` group is encrypted per frame by the sender
and forwarded opaquely by the SFU. The construction follows RFC 9605 (SFrame) with the codec
prefix rules Discord's DAVE documents for WebRTC depacketisers; it is **not** byte-compatible with
DAVE.

## Frame format

```
[ clear codec prefix ][ SFrame header ][ ciphertext ][ 16-byte tag ]
```

- **AAD** = SFrame header || clear codec prefix.
- **Cipher**: AES-128-GCM with the per-KID key and the nonce below (suite `0x0004`).
- One ciphertext per simulcast or SVC layer; each layer has its own counter `layer` field.
- The SFrame header is RFC 9605 §4.3: config byte, then extended KID and CTR bytes.

## Codec prefixes

The prefix is the minimum bytes a depacketiser needs in the clear; everything after it is
encrypted, with H.264 RBSP emulation-prevention re-applied after encryption.

| codec | clear prefix |
|---|---|
| Opus | 0 bytes |
| VP8 | 1 byte for inter frames; 10 bytes for key frames |
| VP9 | 0 bytes |
| H.264 | non-VCL NAL units in the clear; for VCL NAL units the 1-byte NAL header in the clear, the RBSP payload encrypted, then re-escaped (`00 00 0x` → `00 00 03 0x`) |
| AV1 | not supported at media_version 1; a client MUST NOT negotiate AV1 in a `call` group |

## Key schedule

- `base_key = MLS-Exporter("SFrame 1.0 Base Key", "", 16)` from the `call` group's current epoch,
  where `MLS-Exporter(Label, Context, Length) = ExpandWithLabel(DeriveSecret(exporter_secret,
  Label), "exported", Hash(Context), Length)` (RFC 9420 §8.5).
- `KID = (leaf_index << 8) | (epoch mod 256)` (24 bits used; `leaf_index` < 2^16).
- `sframe_secret = HKDF-Extract(salt = "", IKM = base_key)`;
  `key = HKDF-Expand(sframe_secret, "SFrame 1.0 Secret key " || KID(8, big-endian) || 0x0004, 16)`;
  `salt = HKDF-Expand(sframe_secret, "SFrame 1.0 Secret salt " || KID(8) || 0x0004, 12)`.
- Every member derives every other member's key from the shared `base_key` and the sender's
  `KID`; a member MUST NOT accept a frame whose `leaf_index` is not in the current or previous
  epoch's tree.

## Counter partition

`CTR` is a 64-bit value: `slot (8 bits) || layer (4 bits) || seq (52 bits)`. Slots: 0 microphone,
1 camera, 2 screen video, 3 screen audio; further slots reserved. `seq` starts at 0 per (KID, slot,
layer) and increments per frame. A sender MUST stop sending and rekey (send an MLS `Update`) when
`seq` reaches 2^52 − 1; it MUST NOT wrap. `nonce = salt XOR CTR` (CTR big-endian, left-padded to
12 bytes).

## Rotation

- A new epoch (any Commit) gives every sender a new KID for the new epoch and new keys. Senders
  switch to the new epoch's keys as soon as they have processed the Commit.
- Receivers keep the previous epoch's keys for **10 seconds** after processing a Commit, then
  delete them. Frames with an unknown KID are buffered for at most **2 seconds** and then dropped
  and counted; they are never rendered.
- Because `KID` carries only `epoch mod 256`, a receiver MUST bind a KID to the exact epoch it
  learned it in and reject a KID that it would have to resolve against an epoch more than 255
  commits ago.
- A removed member cannot decrypt frames after the Commit that removed it, because it does not
  have the new epoch's `exporter_secret`. Between the DS proposal and the Commit (bounded by the
  30-second call TTL in `02-delivery-service.md`), the removed member still decrypts; the UI shows
  "removal pending" during that window.

## Authenticity

Any member can derive any sender's key (RFC 9605 §7.2). Attribution rests on the SFU's binding of
SSRC to the participant identity established at join, which is minted by the instance only for a
leaf present in the `call` group's current epoch. A colluding instance and member can therefore
inject media attributed to another participant. This is the same limit as DAVE and is stated in
`08-threat-model.md`.

## Vectors

`vectors/sframe.json`: for each case, `kid`, `key`, `salt`, `ctr`, `nonce`, `header` from a fixed
`base_key`. An implementation conforms when it reproduces all fields.
```

- [ ] **Step 2: Run the checker and commit**

Run: `npm run check:docs`
Expected: `05-media-frames.md` reports no problems.

```bash
git add protocol/05-media-frames.md
git commit -s -m "docs(protocol): dilla-sframe/1 frame format, codec prefixes, key schedule, counters, rotation"
```

---

### Task 11: Safety numbers and recovery keys — reference implementation and vectors

**Files:**
- Create: `packages/protocol-vectors/src/identity.ts`
- Test: `packages/protocol-vectors/src/identity.test.ts`
- Modify: `packages/protocol-vectors/src/generate.ts` (add `identityVectors`, write `identity.json`)
- Create (generated): `protocol/vectors/identity.json`

**Interfaces:**
- Consumes: `sha256`, `hkdfSha256`, `bytes.ts`.
- Produces: `safetyNumber(umkA, umkB): Promise<string>` (60 digits); `sas(epochAuthenticator): string` (30 digits); `recoveryKeyBase32(rk): string` (52 Crockford chars); `deriveRecoveryKeys(rk): Promise<{ header: Uint8Array; archive: Uint8Array }>`; `credentialIdentity(...)` CBOR builder.

- [ ] **Step 1: Write the failing tests**

`packages/protocol-vectors/src/identity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { safetyNumber, sas, recoveryKeyBase32, deriveRecoveryKeys, credentialIdentity, decimalDigits } from './identity.ts';
import { decode } from './cbor.ts';
import { hex, fromHex } from './bytes.ts';

describe('decimal digits', () => {
  it('renders a hash as a zero-padded 78-digit decimal string', () => {
    expect(decimalDigits(new Uint8Array(32))).toBe('0'.repeat(78));
    expect(decimalDigits(fromHex('00'.repeat(31) + '01'))).toBe('0'.repeat(77) + '1');
    expect(decimalDigits(fromHex('ff'.repeat(32)))).toBe('115792089237316195423570985008687907853269984665640564039457584007913129639935');
  });
});

describe('safety number', () => {
  it('is 60 digits, symmetric, and depends on both keys', async () => {
    const a = fromHex('01'.repeat(32)), b = fromHex('02'.repeat(32));
    const ab = await safetyNumber(a, b), ba = await safetyNumber(b, a);
    expect(ab).toMatch(/^\d{60}$/);
    expect(ab).toBe(ba);
    expect(await safetyNumber(a, fromHex('03'.repeat(32)))).not.toBe(ab);
  });
});

describe('SAS', () => {
  it('is the first 30 digits of the padded decimal of the epoch authenticator', () => {
    const ea = fromHex('ff'.repeat(32));
    expect(sas(ea)).toBe('115792089237316195423570985008');
    expect(sas(new Uint8Array(32))).toBe('0'.repeat(30));
  });
});

describe('recovery key', () => {
  it('encodes 256 bits as 52 Crockford base32 characters', () => {
    expect(recoveryKeyBase32(new Uint8Array(32))).toBe('0'.repeat(52));
    const s = recoveryKeyBase32(fromHex('ff'.repeat(32)));
    expect(s).toHaveLength(52);
    expect(s).toMatch(/^[0-9A-HJKMNP-TV-Z]{52}$/);
  });
  it('derives distinct header and archive keys with the documented labels', async () => {
    const rk = fromHex('0b'.repeat(32));
    const { header, archive } = await deriveRecoveryKeys(rk);
    expect(header.length).toBe(32); expect(archive.length).toBe(32);
    expect(hex(header)).not.toBe(hex(archive));
  });
});

describe('credential identity', () => {
  it('is a 10-element fixed-position array', () => {
    const b = credentialIdentity({ umkPub: fromHex('a1'.repeat(32)), userId: fromHex('b1'.repeat(16)), deviceId: fromHex('c1'.repeat(16)), kind: 0, tier: 0, signerTier: 0, sskPub: fromHex('d1'.repeat(32)), sigUmkSsk: fromHex('e1'.repeat(64)), sigSskDev: fromHex('f1'.repeat(64)) });
    const arr = decode(b) as unknown[];
    expect(arr.length).toBe(10);
    expect(arr[0]).toBe(1);
    expect(arr[4]).toBe(0);
    expect(hex(arr[7] as Uint8Array)).toBe('d1'.repeat(32));
  });
});
```

- [ ] **Step 2: Run to verify failure, then write `identity.ts`**

Run: `npm test --workspace packages/protocol-vectors -- identity` → FAIL, module not found.

`packages/protocol-vectors/src/identity.ts`:
```ts
import { encode } from './cbor.ts';
import { sha256 } from './hmac.ts';
import { hkdfSha256 } from './hkdf.ts';
import { concat, utf8 } from './bytes.ts';

/** Unsigned big-endian bytes → decimal string left-padded with zeros to 78 digits (2^256 has 78 digits). */
export function decimalDigits(bytes: Uint8Array): string {
  let v = 0n; for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v.toString(10).padStart(78, '0');
}

function lessOrEqual(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return true;
}

/** 60 digits: SHA-256(min(umk_a, umk_b) || max(umk_a, umk_b)) as decimal, padded to 78, first 60. */
export async function safetyNumber(umkA: Uint8Array, umkB: Uint8Array): Promise<string> {
  const [lo, hi] = lessOrEqual(umkA, umkB) ? [umkA, umkB] : [umkB, umkA];
  return decimalDigits(await sha256(concat(lo, hi))).slice(0, 60);
}

/** 30 digits from the MLS epoch_authenticator. */
export function sas(epochAuthenticator: Uint8Array): string {
  if (epochAuthenticator.length !== 32) throw new Error('epoch_authenticator must be 32 bytes');
  return decimalDigits(epochAuthenticator).slice(0, 30);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 256 bits → 52 Crockford base32 characters (the last character carries 1 payload bit and 4 zero bits). */
export function recoveryKeyBase32(rk: Uint8Array): string {
  if (rk.length !== 32) throw new Error('recovery key must be 32 bytes');
  let bits = 0, acc = 0, out = '';
  for (const b of rk) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { out += CROCKFORD[(acc >> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out;
}

export async function deriveRecoveryKeys(rk: Uint8Array): Promise<{ header: Uint8Array; archive: Uint8Array }> {
  const none = new Uint8Array(0);
  return { header: await hkdfSha256(none, rk, utf8('dilla header v1'), 32), archive: await hkdfSha256(none, rk, utf8('dilla archive v1'), 32) };
}

export type CredentialFields = { umkPub: Uint8Array; userId: Uint8Array; deviceId: Uint8Array; kind: 0 | 1; tier: 0 | 1; signerTier: 0 | 1; sskPub: Uint8Array; sigUmkSsk: Uint8Array; sigSskDev: Uint8Array };
export function credentialIdentity(f: CredentialFields): Uint8Array {
  return encode([1, f.umkPub, f.userId, f.deviceId, f.kind, f.tier, f.signerTier, f.sskPub, f.sigUmkSsk, f.sigSskDev]);
}
```

Run: `npm test --workspace packages/protocol-vectors -- identity` → PASS (8 tests).

- [ ] **Step 3: Add identity vectors to the generator and regenerate**

In `generate.ts`:
```ts
import { safetyNumber, sas, recoveryKeyBase32, deriveRecoveryKeys, credentialIdentity } from './identity.ts';

export async function identityVectors() {
  const umkA = fill(32, 0xa1), umkB = fill(32, 0xb2);
  const rk = fill(32, 0x0b);
  const keys = await deriveRecoveryKeys(rk);
  return {
    version: 1,
    description: 'safety number (60 digits), SAS (30 digits), recovery key encodings and derived keys, credential identity CBOR (03-identity.md)',
    safety_number: { umk_a: hex(umkA), umk_b: hex(umkB), digits: await safetyNumber(umkA, umkB) },
    sas: { epoch_authenticator: hex(fill(32, 0xc3)), digits: sas(fill(32, 0xc3)) },
    recovery_key: { rk: hex(rk), base32: recoveryKeyBase32(rk), k_header: hex(keys.header), k_backup: hex(keys.archive) },
    credential_identity: { fields: { umk_pub: hex(umkA), user_id: hex(fill(16, 0xd4)), device_id: hex(fill(16, 0xe5)), kind: 0, tier: 1, signer_tier: 0, ssk_pub: hex(fill(32, 0xf6)), sig_umk_ssk: hex(fill(64, 0x17)), sig_ssk_dev: hex(fill(64, 0x28)) },
      cbor: hex(credentialIdentity({ umkPub: umkA, userId: fill(16, 0xd4), deviceId: fill(16, 0xe5), kind: 0, tier: 1, signerTier: 0, sskPub: fill(32, 0xf6), sigUmkSsk: fill(64, 0x17), sigSskDev: fill(64, 0x28) })) },
  };
}
```
and in `main()`: `writeFileSync(join(VECTORS_DIR, 'identity.json'), j(await identityVectors()));`

Run: `npm run vectors && npm run vectors && git status --short protocol/vectors` → `identity.json` added, stable.

- [ ] **Step 4: Commit**

```bash
git add packages/protocol-vectors/src protocol/vectors/identity.json
git commit -s -m "feat(protocol-vectors): safety number, SAS, recovery key, credential identity; vectors"
```

---

### Task 12: Backup archive, versioning and threat model documents

**Files:**
- Create: `protocol/06-backup-archive.md`
- Create: `protocol/07-versioning.md`
- Create: `protocol/08-threat-model.md`

**Interfaces:**
- Consumes: `K_header`, `K_backup` (Task 5 / Task 11), envelope (Task 8).
- Produces: the archive chunk and manifest layouts for the Rust core's `backup` module; the version negotiation rule for the gateway; the residual-trust statements the UI copy and README must repeat.

- [ ] **Step 1: Write the backup document**

`protocol/06-backup-archive.md`:
```markdown
# 06 — Backup archive

The instance stores two kinds of client-encrypted backup per user. It cannot read either.

## Keys

`K_header` and `K_backup` are derived from the recovery key as in `03-identity.md`. AEAD is
AES-256-GCM with a random 96-bit nonce per object; the nonce is stored with the ciphertext.

## Header

One object per user, replaced on every change, uploaded by a `native` device holding `SSK_priv`:

```
plaintext = CBOR [
  v,                ; uint, = 1
  umk_priv,         ; bstr, 32
  ssk_priv,         ; bstr, 32
  device_list,      ; the newest signed device list (03-identity.md), as its CBOR bytes
  pins              ; array of [user_id (bstr 16), umk_pub (bstr 32), first_seen (uint), verified (uint 0|1)]
]
stored = CBOR [ v = 1, nonce (bstr 12), ciphertext (bstr) ]   ; ciphertext = AES-256-GCM(K_header, nonce, plaintext, aad = "dilla header v1")
```

## Archive

Decrypted message history, not MLS keys: restoring MLS group state would clone a leaf (sender
ratchet and nonce reuse) and hand current epoch secrets to anyone with the recovery key. Each
device writes immutable **chunks** of the messages it has decrypted; the user's devices merge by
`msg_id`.

```
chunk plaintext = CBOR [
  v,             ; uint, = 1
  device_id,     ; bstr, 16
  chunk_seq,     ; uint, per device, increasing
  entries        ; array of [group_id (bstr 16), channel_id (bstr 16), epoch (uint), seq (uint),
                 ;           sender_device (bstr 16), received_at (uint), envelope (bstr: 04 envelope CBOR)]
]
chunk stored = CBOR [ v = 1, device_id, chunk_seq, nonce (bstr 12), ciphertext (bstr) ]
               ; ciphertext = AES-256-GCM(K_backup, nonce, plaintext, aad = "dilla archive v1" || device_id || chunk_seq(8))
manifest = CBOR [ v = 1, user_id, chunks (array of [device_id, chunk_seq, blob_id (bstr 32 = SHA-256 of stored chunk)]), sig_umk (bstr 64) ]
```

The manifest is signed by the UMK (`"dilla manifest v1" || CBOR of elements 0..2`) by the device
that last performed recovery or signup, or by any `native` device holding a copy of `UMK_priv` in
memory during that operation; between such operations the manifest is re-signed only when a new
device is enrolled (the header is rewritten then anyway). A chunk is at most 4 MiB of plaintext; a
device uploads a chunk when it has 1 MiB of new entries or after 24 hours, whichever is first.

## Restore

1. With `RK`: derive keys, download and decrypt the header, enrol this device (`03-identity.md`,
   "Recovery"), download the manifest, verify `sig_umk`, download every chunk, verify `blob_id`,
   decrypt, merge entries by `msg_id` (an `edit` supersedes by `received_at`; a `delete` wins).
2. With another signed-in device: pair (`03-identity.md`), receive `K_backup` (native only),
   then steps from "download the manifest".
3. A chunk that fails to decrypt or whose `blob_id` mismatches is reported in Settings → Devices
   as a gap with its `device_id` and `chunk_seq`; restore continues with the rest.
```

- [ ] **Step 2: Write the versioning document**

`protocol/07-versioning.md`:
```markdown
# 07 — Versioning

## Versions

Three independent unsigned integers:

| version | covers | current |
|---|---|---|
| `wire_version` | HTTP API paths under `/v1`, gateway frame layouts | 1 |
| `e2ee_version` | `01-groups.md`, `02`, `03`, `04`, `06` | 1 |
| `media_version` | `05-media-frames.md` | 1 |

A group records the `e2ee_version` and `media_version` it was created with in `dilla_binding`.
Those are the group's floor: a member that does not support them cannot join. A group is never
migrated in place to a new `e2ee_version`; it is re-created (the DS issues a system message and
the channel owner's device creates the new group and re-adds members).

## Negotiation

On connect, the client sends the versions it supports for each of the three; the instance replies
with the highest common version of each, or refuses the connection with `E_VERSION` listing what it
supports. Both sides MUST support the current version and the two before it (**N-2**) for at least
12 months after a new version ships. Official clients also carry a **signed minimum instance
version** published with each release and refuse instances below it, showing the advisory that
explains why.

## Change process

1. Open a pull request that changes the document and bumps the affected version in this file.
2. Regenerate the vectors (`npm run vectors`) and explain every diff.
3. Add a row to the table below.
4. Two maintainers approve; one of them must not be the author.

| date | version | change |
|---|---|---|
| 2026-09-23 | e2ee 1, media 1, wire 1 | initial |
```

- [ ] **Step 3: Write the threat model document**

`protocol/08-threat-model.md`:
```markdown
# 08 — Threat model

## Adversaries

In scope, in the order the design defends against them:

1. **The instance operator** and anyone with the operator's access: disk, database dumps, backups,
   process memory of `dillad`, TLS keys.
2. **The hosting provider and the network**: hypervisor snapshots, traffic capture, relays (TURN,
   the SFU), the push relay.
3. **A malicious or compromised member** of a group: reads what the group shares, may try to
   forge attribution, may report messages.
4. **A compromised member device**: a device whose keys were extracted; the goal is forward
   secrecy for earlier messages and post-compromise security after the device updates or is
   revoked.
5. **An operator serving malicious client code** to `browser`-tier sessions. This is a documented
   exclusion for that tier: the web client is a lower-trust tier and the UI marks members on it.
   Native clients bundle their code; Android and Linux desktop builds are reproducible.

## Guarantees

For `text`, `call`, `pairing` and `interaction` groups, against adversaries 1–3:

- Confidentiality of envelopes, attachments and media frames: only current members' devices hold
  the epoch secrets (RFC 9420 §16).
- Forward secrecy: a device deletes past epoch secrets after the windows in `01-groups.md`; an
  attacker who later obtains the device cannot decrypt earlier epochs beyond those windows.
- Post-compromise security: after an `Update` from the compromised device, or its removal, later
  epochs are secret again (`01-groups.md`, cadence).
- Membership integrity: adds and removes are proposals bound to the permission system through the
  instance's external-sender key, committed by members, and visible to every member as tree
  changes; the instance cannot silently add a leaf that members do not see.
- Sender authenticity for envelopes: MLS `PrivateMessage` signatures under the sender's DSK, with
  the credential chain to a pinned UMK.
- Verifiable reports: franking (`04-envelope-and-franking.md`).
- Cryptographic device revocation: signed device lists (`03-identity.md`).

Against adversary 4: forward secrecy and post-compromise security as above; recovery keys are never
on devices except during signup or recovery.

## Residual trust

Stated plainly in the product's documentation and onboarding:

- The instance may add any **legitimate** user's devices to groups it controls (adversary 1). This
  is visible: members see "X joined" and the leaf in the tree, and a pinned-UMK mismatch is a loud
  alert. It is not silent, but it is possible.
- Media authenticity is group-level: any member can derive any sender's frame keys
  (`05-media-frames.md`); a colluding operator and member can inject media attributed to another
  participant.
- Metadata is visible to the instance: membership, presence, typing, who is in voice, message
  timestamps and sizes, attachment sizes, franking tags.
- History before a member joined is not shared with them at this version.
- A user who loses every device and the recovery key loses their history.
- A `browser`-tier session trusts the code the instance serves.

## Out of scope

Traffic analysis beyond the metadata above; denial of service by the operator; compromise of the
platform CSPRNG or OS keystore; side channels on the device; legal compulsion of the user; the
security of channels in `readable` mode, which is TLS to the instance and nothing more.
```

- [ ] **Step 4: Run the full check and commit**

Run: `npm test` (from the repository root)
Expected: `protocol docs: ok`, then the `protocol-vectors` suite passes.

```bash
git add protocol/06-backup-archive.md protocol/07-versioning.md protocol/08-threat-model.md
git commit -s -m "docs(protocol): backup archive, versioning, threat model"
```

---

### Task 13: Vector index and CI gate

**Files:**
- Create: `protocol/vectors/README.md`
- Modify: `protocol/README.md` (Conformance section: list the files)
- Test: `packages/protocol-vectors/src/generate.test.ts`

**Interfaces:**
- Consumes: all generators.
- Produces: the guarantee that the committed vectors equal the generator's output (tested in the package, and enforced again by the CI step from Task 1).

- [ ] **Step 1: Write the failing generator test**

`packages/protocol-vectors/src/generate.test.ts`:
```ts
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VECTORS_DIR, envelopeVectors, frankingVectors, sframeVectors, identityVectors } from './generate.ts';
import { hex } from './bytes.ts';

const j = (o: unknown) => JSON.stringify(o, (_, v) => v instanceof Uint8Array ? hex(v) : v, 2) + '\n';

for (const [file, gen] of [['envelope.json', envelopeVectors], ['franking.json', frankingVectors], ['sframe.json', sframeVectors], ['identity.json', identityVectors]] as const) {
  it(`committed ${file} equals the generator output`, async () => {
    expect(readFileSync(join(VECTORS_DIR, file), 'utf8')).toBe(j(await gen()));
  });
}
```

- [ ] **Step 2: Run it**

Run: `npm test --workspace packages/protocol-vectors -- generate`
Expected: PASS (4 tests). If it fails, run `npm run vectors` and inspect `git diff protocol/vectors`; a diff means a generator changed without regenerating, which is exactly what this test and the CI step exist to catch.

- [ ] **Step 3: Write the vectors README and update the protocol README**

`protocol/vectors/README.md`:
```markdown
# Conformance vectors

Generated by `packages/protocol-vectors` (`npm run vectors`). Do not edit by hand; CI fails if the
committed files differ from the generator output.

| file | document | what an implementation must reproduce |
|---|---|---|
| `envelope.json` | `04-envelope-and-franking.md` | `cbor`, `length`, `padded_length`, `commitment` per case |
| `franking.json` | `04-envelope-and-franking.md` | `tag` per case from `instance_franking_key` |
| `sframe.json` | `05-media-frames.md` | `kid`, `key`, `salt`, `ctr`, `nonce`, `header` per case |
| `identity.json` | `03-identity.md` | `safety_number.digits`, `sas.digits`, `recovery_key.base32`, `k_header`, `k_backup`, `credential_identity.cbor` |

All byte strings are lowercase hex. Integers larger than 2^53 are decimal strings.
```

In `protocol/README.md`, replace the paragraph under `## Conformance` with:
```markdown
`vectors/` holds JSON test vectors generated by `packages/protocol-vectors`, a TypeScript
reference implementation of the pure-function parts of these documents (`vectors/README.md` lists
the files and what each one tests). An implementation conforms to a document when it reproduces
every vector in the files that document names. CI regenerates the vectors on every change and
fails if the committed files differ.
```

- [ ] **Step 4: Full check and commit**

Run: `npm test && npm run vectors && git diff --exit-code -- protocol/vectors`
Expected: all green, no diff.

```bash
git add protocol/vectors/README.md protocol/README.md packages/protocol-vectors/src/generate.test.ts
git commit -s -m "test(protocol-vectors): committed vectors equal generator output; vectors index"
```

---

## Self-review

**Spec coverage.** Groups and binding (Appendix A "E2EE protocol layer", "Groups"): Task 3. DS invariants 1–11, API, errors, retention: Task 4. Credentials, device list, custody by tier, pairing, recovery, safety numbers: Tasks 5 and 11. Envelope, deterministic CBOR, franking with receiver check: Tasks 6–8. SFrame key schedule, KID, CTR partition, rotation, codec prefixes, authenticity caveat: Tasks 9–10. Backup header and archive, restore: Task 12. Versioning with N-2 and the change process: Task 12. Threat model with residual trust: Task 12. Vectors and the CI gate: Tasks 1, 7, 9, 11, 13. Not in this plan (by design, other sub-projects): the OpenMLS integration, the wazero-hosted `PublicGroup`, the testkit scenarios, the Go server, the media worker. The 90-day inactivity threshold (founder decision) is in Task 3; calls always E2EE (founder decision) is in Task 3.

**Placeholder scan.** No "TBD", "TODO", "later", "similar to Task N". Every code step has the code; every document step has the text.

**Type consistency.** `encode`/`decode` (Task 6) are used by Tasks 7 and 11 with the same signatures. `hmacSha256`/`sha256` (Task 7) used in Task 11. `hkdfSha256(salt, ikm, info, length)` (Task 9) used in Tasks 9 and 11 with that argument order. `Envelope` field names (`msgId`, `threadId`, `replyTo`, `kf`) match between `envelope.ts`, its test and `generate.ts`. Vector file names match between `generate.ts`, `generate.test.ts`, `vectors/README.md` and the documents. The SFrame header test expectations follow RFC 9605 §4.3's config byte layout `R(1) K(1) KLEN/KID(3) X(1) CLEN/CTR(3)`.

**Known limits, stated for the executor.** The RFC 9605 Appendix A test vectors are not embedded here; conformance to them is verified in the Rust core sub-project, where the `sframe` crate's test data is available. The TypeScript reference implementation is a second, independent implementation of the pure functions and is the tie-breaker for encodings, not for AEAD or MLS behaviour.
