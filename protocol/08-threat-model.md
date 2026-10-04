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
- In a browser call, the call group's per-epoch 16-byte `base_key` lives in the call tab's media
  worker for the epoch plus 10 s of retention, so script injected into that page can read it. It
  never reaches long-lived MLS or store secrets, and every member derives every sender's frame keys
  from it anyway. The worker zeroes the transferred key and each copy it hands the wasm cipher, and
  the cipher zeroes the buffer each copy arrives in; the receiver keeps its copy zeroized-on-drop for
  the retention period. Not zeroed: the copy that the receiver's key install passes by value, which
  stays in the wasm stack region until a later call overwrites it, and any copy the browser makes
  internally while transferring the key to the worker.
- A call started in a follower tab receives that `base_key` from the leader tab's core worker over
  `BroadcastChannel("dilla-core:<instance>")`, which any same-origin script can read. The web
  client wave closes this exposure.
- Metadata is visible to the instance: membership, presence, typing, who is in voice, message
  timestamps and sizes, attachment sizes, franking tags.
- History before a member joined is not shared with them at this version.
- A user who loses every device and the recovery key loses their history.
- A `browser`-tier session trusts the code the instance serves.

## Out of scope

Traffic analysis beyond the metadata above; denial of service by the operator; compromise of the
platform CSPRNG or OS keystore; side channels on the device; legal compulsion of the user; the
security of channels in `readable` mode, which is TLS to the instance and nothing more.
