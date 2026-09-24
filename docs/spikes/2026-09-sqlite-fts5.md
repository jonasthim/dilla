# modernc.org/sqlite FTS5 check

Date: 2026-09-23. Pin: `modernc.org/sqlite v1.59.0` (SQLite 3.53.4), pure Go,
`CGO_ENABLED=0`. Host: dev box, linux/amd64, Go 1.27.0.

## Result

FTS5 is compiled into `modernc.org/sqlite v1.59.0` and works with cgo disabled.

| Target | How it was checked | Result |
|---|---|---|
| linux/amd64 | `CREATE VIRTUAL TABLE msgs USING fts5(body, channel_id UNINDEXED, tokenize='unicode61')`, `INSERT`, `MATCH`, `highlight()`, `VACUUM INTO`, all run locally | PASS. `sqlite_version()` = `3.53.4`. `highlight(msgs, 0, '[', ']')` on `"hello encrypted world"` matched against `encrypted` returned `hello [encrypted] world`; `MATCH 'nothing'` returned 1 row as expected. `TestHasFTS5`, `TestCompileOptionsAreReadable`, `TestFTS5VirtualTableMatchesAndHighlights`, `TestVacuumIntoWorks` all PASS, including with `CGO_ENABLED=0`. |
| linux/arm64 | `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build ./internal/store/sqlite/` plus the compile-time `SQLITE_ENABLE_FTS5` assertion, and the identical test on a native `ubuntu-24.04-arm` CI runner | build PASS locally (exit 0, no output); `go vet` under `GOOS=linux GOARCH=arm64` also exits 0 with no output. runtime **unverified on this host** (no `qemu-aarch64`, no aarch64 `binfmt_misc` handler); CI job `go-fts5-arm64` is task 8's responsibility and had not run as of this task. |

`pragma_compile_options` on this host (linux/amd64, Go 1.27.0, `modernc.org/sqlite v1.59.0`):

```
ATOMIC_INTRINSICS=1 COMPILER=gcc-12.2.0 DEFAULT_AUTOVACUUM DEFAULT_CACHE_SIZE=-2000
DEFAULT_FILE_FORMAT=4 DEFAULT_JOURNAL_SIZE_LIMIT=-1 DEFAULT_MEMSTATUS=0 DEFAULT_MMAP_SIZE=0
DEFAULT_PAGE_SIZE=4096 DEFAULT_PCACHE_INITSZ=20 DEFAULT_RECURSIVE_TRIGGERS DEFAULT_SECTOR_SIZE=4096
DEFAULT_SYNCHRONOUS=2 DEFAULT_WAL_AUTOCHECKPOINT=1000 DEFAULT_WAL_SYNCHRONOUS=2 DEFAULT_WORKER_THREADS=0
DIRECT_OVERFLOW_READ DISABLE_INTRINSIC ENABLE_COLUMN_METADATA ENABLE_DBPAGE_VTAB ENABLE_DBSTAT_VTAB
ENABLE_FTS5 ENABLE_GEOPOLY ENABLE_MATH_FUNCTIONS ENABLE_MEMORY_MANAGEMENT ENABLE_OFFSET_SQL_FUNC
ENABLE_PREUPDATE_HOOK ENABLE_RBU ENABLE_RTREE ENABLE_SESSION ENABLE_SNAPSHOT ENABLE_STAT4
ENABLE_UNLOCK_NOTIFY LIKE_DOESNT_MATCH_BLOBS MALLOC_SOFT_LIMIT=1024 MAX_ATTACHED=10 MAX_COLUMN=2000
MAX_COMPOUND_SELECT=500 MAX_DEFAULT_PAGE_SIZE=8192 MAX_EXPR_DEPTH=1000 MAX_FUNCTION_ARG=1000
MAX_LENGTH=1000000000 MAX_LIKE_PATTERN_LENGTH=50000 MAX_MMAP_SIZE=0x7fff0000 MAX_PAGE_COUNT=0xfffffffe
MAX_PAGE_SIZE=65536 MAX_SQL_LENGTH=1000000000 MAX_TRIGGER_DEPTH=1000 MAX_VARIABLE_NUMBER=32766
MAX_VDBE_OP=250000000 MAX_WORKER_THREADS=8 MUTEX_PTHREADS SOUNDEX SYSTEM_MALLOC TEMP_STORE=1
THREADSAFE=1
```

**Honest limit.** No `CREATE VIRTUAL TABLE ... USING fts5` statement was
*executed* on arm64 machine code on this workstation: it is linux/amd64 with no
`qemu-aarch64` and no aarch64 `binfmt_misc` handler, and installing one is a host
change this task does not take. The arm64 evidence is therefore (a) upstream's
own generator passing `-DSQLITE_ENABLE_FTS5` for `lib/sqlite_linux_arm64.go`,
(b) `const SQLITE_ENABLE_FTS5 = 1` in the unconstrained `lib/sqlite.go`,
(c) `_sqlite3BuiltinExtensions[0] = __ccgo_fp(_sqlite3Fts5Init)` in a file whose
`//go:build` line includes `linux && arm64`, (d) upstream's own test suite
running natively on an arm64 builder and exercising an fts5 virtual table, and
(e) dilla's `go-fts5-arm64` CI job.

## Two guards against a future re-vendor

1. **Compile-time**, in `internal/store/sqlite/open.go`:

   ```go
   var _ = [1]struct{}{}[1-sqlite3.SQLITE_ENABLE_FTS5]
   ```

   `SQLITE_ENABLE_FTS5` is declared in `lib/sqlite.go`, which carries **no build
   constraint** (gap-22 §3), so it is one value for every target and this
   assertion is a single whole-module check: it fails every build, on every
   target, if a re-vendor drops the flag everywhere, and it costs no CI minutes.
   It cannot distinguish architectures. The flags *are* per-target generator
   invocations, so FTS5 could in principle be dropped for one architecture only —
   that would have to move the constant into a per-target file, and the case is
   covered by the runtime guard below, not by this assertion.

2. **Run-time**, `internal/store/sqlite/fts5_test.go`, run by CI on
   `ubuntu-latest` and `ubuntu-24.04-arm`.

## Not week 1

Migrations. When they arrive they use `github.com/pressly/goose/v3` with
`goose.WithTableName("schema_migrations")` — goose's default table name is
`goose_db_version`, and dilla's is `schema_migrations`, so the option is not
optional. No goose dependency is added by this task.

## Driver notes carried forward

- Driver name is `"sqlite"`, not `"sqlite3"`.
- `Open` uses `file:<path>?_pragma=journal_mode(wal)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)`.
- `VACUUM INTO '<path>'` works and is the pre-migration backup the spec's
  "Upgrades" section calls for.
- CHANGELOG.md carries an untagged `v1.59.1` section; it is pending, not
  released. Stay on v1.59.0 until it is tagged.
