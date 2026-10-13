# Vendored crates

Third-party crates that dilla builds from a patched copy, through `[patch.crates-io]` in the root
`Cargo.toml`. Each copy is the published crate as it was downloaded from crates.io, minus the
registry's `.cargo-ok` and `Cargo.lock`, plus the changes listed below. Every change is marked
`DILLA PATCH` in the source. The directory is excluded from the workspace, so `cargo fmt`, `cargo
clippy` and the workspace lints do not touch it.

## sqlite-wasm-vfs 0.2.0

Upstream: <https://github.com/Spxg/sqlite-wasm-rs> (`.cargo_vcs_info.json` has the commit). MIT.

One change, in `src/sahpool.rs` `xCheckReservedLock`: it answers 0 ("no other connection holds a
RESERVED lock") instead of 1.

Why: SQLite treats a leftover rollback journal as hot, and plays it back, only when no connection
holds RESERVED. With 1, the journal of a write that a page unload interrupted was never played back,
and the next open read the half-written database: "database disk image is malformed", or committed
rows silently replaced by uncommitted ones (`.superpowers/sdd/2026-10-08-dilla-web-2c/opfs-report.md`;
regression test `e2e/tests/mls-store.spec.ts`, "a write interrupted by a reload rolls back on the
next open"). The pool's OPFS access handles are exclusive to one worker, so a journal found when the
store opens belongs to a connection that no longer exists. sqlite-wasm-vfs 0.3.0 reports no RESERVED
lock for a fresh connection too.

Remove this copy and the patch entry when the store moves to sqlite-wasm-vfs 0.3.0 or later (that
release needs sqlite-wasm-rs 0.6, so it moves together with rusqlite).
