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
| 2026-09-23 | e2ee 1, media 1, wire 1 | `identity.json` gains real Ed25519 credential signatures and the seeds that reproduce them; no format change, so no version bump |
