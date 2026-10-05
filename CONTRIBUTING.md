# Contributing to dilla

## Sign-off

Every commit must carry a `Signed-off-by:` line (`git commit -s`), which certifies the Developer
Certificate of Origin in `DCO`. There is no contributor licence agreement and there will not be one.

## Cryptography rule

dilla uses only published standards, implemented in public code: MLS (RFC 9420), the RFC 9605
SFrame shape for media frames, HKDF-SHA256, HMAC-SHA256, SHA-256, AES-128-GCM, AES-256-GCM (the
protocol/06 header objects and protocol/04 attachments), Ed25519, X25519.
A pull request that introduces a construction not defined in one of those documents, or a
"simplified" variant of one, is closed without review. Ask first in an issue if you think an
exception is needed.

## Rust toolchain

The repository pins its Rust toolchain in `rust-toolchain.toml`. That file is a **rustup**
feature: a distribution-packaged `cargo` ignores it without printing anything at all, so a
contributor on such a machine builds with whatever their package manager last installed while
believing the pin applies. Run `scripts/doctor-rust.sh` to find out; it exits non-zero and lists
what is missing.

Install a user-scoped rustup once, without touching the system compiler:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --no-modify-path --default-toolchain none --profile minimal
~/.cargo/bin/rustup toolchain install 1.98.1 --profile minimal \
  --component clippy --component rustfmt \
  --target wasm32-unknown-unknown --target wasm32-wasip1
```

Then put `~/.cargo/bin` at the front of your `PATH`. That makes `cargo` and `rustc` rustup proxies
for every project on the machine, not only this one; it is the intended effect, and
`rustup self uninstall` reverses all of it. Nothing under `/usr` is modified, so a
distribution-packaged Rust keeps working if you remove the `PATH` entry.

## Protocol changes

`protocol/` is normative. A change to any document there needs, in the same pull request:
1. a bump of the affected version integer (`e2ee_version`, `media_version` or the wire version),
2. regenerated vectors (`npm run vectors`) with the diff explained,
3. a note in `protocol/07-versioning.md` describing the compatibility window.

## Commits

Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`.
