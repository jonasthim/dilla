# Native Bot interaction context contract — 22 October 2026

## Decision

Do not add a production native-helper operation for kind-3 interaction context yet. The helper
cannot currently establish all of the inputs that such an operation would have to authenticate.
Keep kind-3 creation and Welcome unavailable until the transport and the native state boundary
below are implemented together.

This is a client-side trust gap, separate from the server's registration authorization. The server
must still revalidate current eligibility and consume the admission receipt atomically with group
registration even after the client can verify its local context.

## What exists

`POST /v1/bot-runtime/installations/{installation}/interaction-admissions` accepts an
installation-bound Bot session and returns `[payload, signature]`. The signed admission v1 tuple
contains the instance, installation, community, Bot and participant identities, group ID,
eligibility revision and `not_after`. The handler checks the current participant and signed device
list while holding the admission locks; its 30-second expiry is calculated from the server clock.
The payload does not carry the server time at issuance, policy version, or the signed device-list
versions/hashes used for that decision.

`LoadBotInteractionRegistrationPreflight` is a read-only internal API method that loads the current
server time, eligibility revision, policy version, current verified Bot and participant device-list
entries, signed receipt and pinned instance key under its lock fence. It has no HTTP route or Bot
client wire representation. Its result is therefore unavailable to the native helper.

Rust now verifies a server-signed interaction snapshot against the instance key and signed
device-list pins in encrypted state. A read-only inspector derives the binding and exact two-leaf
roster from a previously persisted OpenMLS group. The older public preparation method that
accepted caller-constructed roster leaves was removed; it could be mistaken for an admission
boundary. The native helper still lacks a transaction-local create/Add/verify path and does not
dispatch encrypted interaction commands. Its group adapter excludes kind 3 and returns
`Unavailable` for the Welcome operation.

There is a sequencing gap too: the participant's authenticated MLS leaf is only available after
OpenMLS processes the participant's KeyPackage/Add into candidate group state. The helper can
inspect a stored group, but cannot yet inspect the transient group before commit. Creating or
persisting the group before validating admission would leave partial interaction state on rejected
input.

## Required transport and helper boundary

The runtime needs a typed response for the admission and for the current-context preflight. The
preflight transport must carry the complete versioned context, not just an unsigned Go struct:

- the server-signed admission proof and the request/admission IDs;
- server `now` and the eligibility revision floor checked at that same snapshot;
- policy version and expected E2EE/media versions for the v2 binding;
- current Bot and participant signed device-list bytes, their versions and hashes, and the SSK
  public keys used to validate them;
- the exact expected installation/community/Bot/participant/device/group tuple.

The proof or a second domain-separated signature must authenticate the added snapshot fields and
bind them to the admission ID. Include device-list versions/hashes so the client can prove that the
roster checks use the exact lists the server checked. The helper must verify the signature under
the instance key already pinned in its encrypted store; a public key supplied in the request is
never a trust root. The helper must also validate each device-list signing key against the core's
existing user-key pins and freshness rules. If those pins are unavailable, it must refuse.

The helper operation should be read-only and preparation-only. It should accept the signed
transport context and an authenticated candidate-group representation, then return a typed
validated context only when all of these agree: the pinned instance, admission tuple, v2 binding,
policy/version values, exact two-device roster, DSK/tier membership in the signed lists, and the
snapshot freshness constraints. It must not create a group, write an intent, cache an admission,
or acknowledge a Welcome. A later mutation path can consume this validated value only if its
provenance is opaque to callers and bound to the exact group candidate; do not make a new
caller-constructible `Expected` struct the production API.

The server's final registration transaction remains authoritative: recheck the current session,
installation, account/device status, community membership/ban, current device lists, eligibility
revision, policy and instance generation, then consume the exact admission receipt together with
the group registration. A client snapshot can expire or become stale between preparation and
registration.

## HTTP/API snapshot contract

`POST /v1/bot-runtime/installations/{installation}/interaction-admissions/context` now returns a
read-only versioned snapshot as `[payload, signature]`. The request is the same four-item tuple as
admission issuance. The route uses the authenticated Bot session and installation binding; its
loader captures admission proof, server time, eligibility floor, policy and binding versions, key
identity, and both verified signed device-list records inside the same transaction and eligibility
fence. Each list record carries UMK/SSK keys, the UMK-to-SSK binding signature, list version, blob,
SSK signature, previous hash, and SHA-256 of the blob. The response is canonical CBOR array v1 and
is signed under `dilla bot interaction context snapshot v1\0` using the instance external-sender
key whose public key is already pinned in the encrypted Bot store. The included key ID is signed
descriptive metadata; the current store does not persist a separate key-ID pin. Signed list blobs are capped at
64 KiB each and the payload at 160 KiB.

This route only provides transport material. The native helper still must verify the snapshot
signature against its stored pin and validate user-key/device-list trust locally before kind-3
preparation can be enabled. The final registrar remains authoritative and rechecks mutable state.

## Tests required before enabling the operation

1. A Rust helper test starts from a pinned native Bot store and accepts only an authentic signed
   snapshot with a matching v2 binding, candidate group and two current signed device lists. It
   asserts that the operation leaves group rows, operation intents, and Welcome cursors unchanged.
2. Table-driven Rust negatives alter each identity/scope field, admission ID, policy/version,
   expiry, eligibility floor, instance signature, device-list hash/version, SSK pin, roster leaf,
   DSK or tier. Each refusal must leave the same state unchanged.
3. MLS negatives use a wrong credential, a revoked or unlisted leaf, duplicate identities, a third
   leaf, an unauthenticated GroupInfo/tree, a legacy binding, and a kind-3 binding with any v2 field
   changed. None may produce a validated context.
4. Shared Go/Rust vectors cover the exact snapshot CBOR and signature domain, including unknown or
   extra fields and non-canonical encodings.
5. API tests prove the snapshot is assembled under the same locks as admission issuance, and that
   a concurrent disable, ban, device-list update, policy change or installation replacement either
   precedes the snapshot or advances the revision before final registration.
6. Registration tests prove stale snapshots cannot bypass the final server revalidation or
   receipt-consumption fence, including a retry with the same IDs and a conflicting request body.

Until this contract has a client transport, authenticated candidate-group inspection, and those
tests, a native operation that accepts caller-provided time/revision/lists would only repackage
untrusted inputs. It would not establish authenticated interaction context.
