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
