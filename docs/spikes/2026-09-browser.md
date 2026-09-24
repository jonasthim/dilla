# Browser store spike — OPFS, Web Locks and SQLite3 Multiple Ciphers

Date: 2026-09-23. Week 1. Scope: can the browser tier keep an **encrypted** SQLite database in OPFS,
elect one writer across tabs, and degrade honestly where OPFS is unavailable?

**Verdict: yes on Chromium, with an in-memory fallback that is required rather than defensive.**
Two of the three engines refuse OPFS in private browsing outright, and the third gives a volatile
filesystem that looks persistent.

## What was built

- `core/dilla-core-wasm` — the wasm-bindgen surface, including `store_open`, `probe_persistence`
  and `is_sah_contention`.
- `core/dilla-core-wasm/spike/` — a Vite app whose dedicated worker runs the probe, takes the Web
  Lock and opens the store.
- `e2e/` — `@dilla/e2e`, a Playwright suite over Chromium, Firefox and WebKit.

## The three findings that change the design

### 1. The VFS name is load-bearing

The pool installs under `opfs-sahpool` with `default_vfs = false`, and the connection is opened on
**`multipleciphers-opfs-sahpool`**, the wrapper sqlite3mc creates lazily. Opening the plain name and
then keying it fails with exactly:

    Setting key failed. Encryption is not supported by the VFS.

The spike asserts that message on every run (`unencrypted_vfs_probe`), so the trap cannot come back
unnoticed. Making the pool the SQLite default would displace the sqlite3mc-wrapped default and break
keying the same way.

### 2. `PRAGMA key` never reports a wrong key

The open sequence is `PRAGMA cipher = 'chacha20'` → `PRAGMA key = 'raw:<64 hex>'` →
`SELECT count(*) FROM sqlite_schema`. The **SELECT** is the key check; the pragmas always report ok.
Cipher is ChaCha20-Poly1305 (the sqleet scheme), sqlite3mc's compile-time default, in non-legacy
mode.

### 3. The browser file is not portable to the native tier

The browser store is SQLite3 Multiple Ciphers `chacha20`; the native store is SQLCipher 4.14.0.
The two on-disk formats are **not interchangeable in either direction**, even with
`PRAGMA cipher = 'sqlcipher'` — the vendor documents this. Migration between tiers is a re-sync
through the delivery service, never a file copy. Nothing in dilla may assume otherwise.

## Leadership hand-over, measured

One exclusive Web Lock named `dilla-core:<instance>` per instance. The lock is released on agent
teardown with no lease, no TTL and no heartbeat, so a killed tab hands over without a timer. No
vendor publishes a bound on that latency; the numbers below are this spike's measurement on the dev
box (16 cores, 30 GB, Chromium via Playwright), over 10 consecutive hand-overs.

| Metric | Value |
|---|---|
| Hand-overs sampled | 10 |
| `store_open` attempts, min | 1 |
| `store_open` attempts, max | 1 |
| Lock-release latency, min | 75 ms |
| Lock-release latency, p50 | 77 ms |
| Lock-release latency, max | 80 ms |
| Time to reopen the store, min | 21 ms |
| Time to reopen the store, p50 | 22 ms |
| Time to reopen the store, max | 23 ms |
| Retry budget | 6 attempts at 300/600/900/1200/1500 ms, ~4.5 s cumulative |

Lock-release latency is measured from `leader.close()` to the successor reporting `role = leader`; time to
reopen is measured inside `openWithRetry`, after the lock has been granted. They are different numbers and
the report keeps them apart.

The retry loop is the application's job: neither `sqlite-wasm-vfs` nor SQLite upstream's own VFS
sleeps or backs off on contention. The schedule above is SQLite upstream's own for the identical
contention. A **first failure is expected and self-healing** — a predecessor parked in BFCache is
evicted by the successor's first `install()`, so a one-shot open would leave dilla permanently
read-only in an ordinary navigation. Contention is recognised by DOMException `name` —
`NoModificationAllowedError`, or `DOMException` whose message starts `Access Handles cannot`, which
is a documented Chromium `name` inconsistency — never by the error's Display string.

Resignation order is fixed: close the connection → `pause_vfs()` → post `leader-resigned` → release
the Web Lock. `pause_vfs()` errors while any file handle is open, and the pinned `sqlite-wasm-vfs`
0.2.0 has no typed `Busy` variant to tell that apart from a real OPFS failure.

The pinned pair is `sqlite-wasm-rs 0.5.5` + `sqlite-wasm-vfs 0.2.0`, which `rusqlite 0.40.2` caps.
0.2.0 writes **no `.lock` file**, so the Web Lock is load-bearing for correctness, not just for
politeness: two workers racing on a cold origin can otherwise each initialise a disjoint pool.

## Engine matrix

| Engine | `probe_persistence()` | App behaviour |
|---|---|---|
| Chromium (normal) | `{"mode":"opfs"}` | encrypted store, survives reload |
| Chromium (incognito) | `{"mode":"opfs"}` — **and still loses everything** | caught by the boot marker, not the probe |
| Firefox (private browsing) | `{"mode":"memory","reason":"getDirectory:SecurityError"}` | boots, banner shown, messaging works |
| WebKit (ephemeral context) | `{"mode":"memory","reason":"getDirectory:UnknownError"}` | boots, banner shown, messaging works |

Presence checks are useless here: in both failing engines the whole API surface exists and only the
call fails. The probe is therefore functional, runs in the dedicated worker **before** `install()`,
and removes its own probe file. In memory mode `install()` is never called, so no `.opfs-sahpool`
directory is created.

Chrome incognito is the case the probe cannot see, so the app also writes a boot marker into the
store and remembers the visit outside it; a visit with the marker gone reports "Storage was cleared
since your last visit." Banner copy names the **effect**, never the browser mode: the identical
`SecurityError` fires in a normal Firefox window with site storage blocked.

## Bundle size

| Artefact | Bytes |
|---|---|
| `target/wasm32-unknown-unknown/release/dilla_core_wasm.wasm` (raw rustc) | 3077364 |
| `core/dilla-core-wasm/spike/pkg/dilla_core_wasm_bg.wasm` (wasm-bindgen only, wasm-opt did not run — see below) | 2290870 |

The reduction above is **not** the combined wasm-bindgen + wasm-opt effect the plan expected. `wasm-pack`
was run with `--mode no-install` (required so it resolves `wasm-bindgen` 0.2.128 from `PATH` instead of
`cargo install`-ing a possibly different version, facts-ci §1.6). That flag turned out to suppress **every**
download wasm-pack would otherwise make, not only the `wasm-bindgen-cli` install: the build log reads
`Skipping wasm-opt as no downloading was requested`, and no `wasm-opt` binary is present anywhere on this
box. `wasm-opt` therefore did not run in this measurement, and the byte reduction above is wasm-bindgen's
own JS/wasm glue-generation and dead-code stripping alone. This corrects the plan's assumption
(facts-ci §1.7 is accurate for wasm-pack's ordinary, download-permitted mode) — under `--mode no-install`
on this box, wasm-bindgen and wasm-opt cannot be combined in one measurement without installing
wasm-bindgen a second way. A `wasm-opt -O` pass over the wasm-bindgen output, run separately with a pinned
binaryen, is the way to measure that stage's own contribution; this spike does not do that.

## What is still open

- The `multipleciphers-opfs-sahpool` combination has no upstream test anywhere; this spike is its
  first execution. Every later change to the pinned pair must re-run `@dilla/e2e`.
- `initial_capacity` is 12 slots, chosen to hold one database plus its journal and WAL. No
  measurement yet says what a real dilla store needs; revisit when the schema lands.
- OPFS eviction in a normal window is not covered here. Safari deletes origin storage after a period
  of inactivity, which the boot marker reports but nothing yet prevents.
