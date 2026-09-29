package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store/sqlite"
)

// fileJournalMode reads path's own journal mode on a connection that sets no
// pragmas.
//
// It must run BEFORE any pool is opened with the write DSN: modernc executes
// _pragma=journal_mode(WAL) on every new connection, so a database someone
// left in DELETE mode is silently converted back to WAL by the very act of
// opening it, and a read-back through that pool can never fail.
func fileJournalMode(ctx context.Context, path string) (string, error) {
	db, err := sql.Open("sqlite", "file:"+url.PathEscape(path)+"?mode=ro")
	if err != nil {
		return "", err
	}
	defer func() { _ = db.Close() }()
	var mode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
		return "", err
	}
	return strings.ToLower(mode), nil
}

// runDoctor checks configuration, database, wasi artifact and clock without
// starting the server: config parse plus Validate, db.PingContext plus the
// goose schema version, the pragma read-back, the data directory's mode and
// ownership, the wasi artifact load plus dilla_abi, and clock skew against
// doctor.clock_peers. It prints one line per leg and exits exit.Unavailable if
// any leg is red.
func runDoctor(args []string, stdout, stderr io.Writer) error {
	fs, cfgPath := newFlagSet("doctor", stderr)
	if err := parse(fs, args, stdout); err != nil {
		return err
	}

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fmt.Fprintf(stdout, "config: FAIL: %v\n", err)
		return err
	}
	fmt.Fprintln(stdout, "config: ok")

	healthy := true
	fail := func(leg string, err error) {
		healthy = false
		fmt.Fprintf(stdout, "%s: FAIL: %v\n", leg, err)
	}

	ctx := context.Background()

	// Pragma leg, half 1: the file's own journal mode, read on a mode=ro
	// connection that sets no pragmas of its own. This MUST run before any pool
	// is opened with the write DSN (the database leg, right below): modernc
	// executes _pragma=journal_mode(WAL) on every new connection, so opening
	// the file first would silently convert a database left in DELETE mode
	// back to WAL and this leg could then never fail. journal_mode is a
	// property of the file, not of any one connection (facts-storage §2.3).
	var pragmaErr error
	if cfg.DB.Driver == "sqlite" {
		mode, err := fileJournalMode(ctx, cfg.DB.Path)
		switch {
		case err != nil:
			pragmaErr = err
		case mode != "wal":
			pragmaErr = fmt.Errorf("journal_mode is %q, want wal", mode)
		}
	}

	// Leg 2: db.PingContext plus the goose schema version. Opening the
	// repository is what (harmlessly, now) converts the file back to WAL; the
	// pragma leg above already captured the value before that happened.
	repo, db, err := openRepository(cfg)
	if err != nil {
		fail("database", err)
	} else {
		defer func() { _ = repo.Close() }()
		if err := db.PingContext(ctx); err != nil {
			fail("database", err)
		} else if version, err := repo.SchemaVersion(ctx); err != nil {
			fail("database", err)
		} else {
			fmt.Fprintf(stdout, "database: ok (schema version %d)\n", version)
		}

		// Pragma leg, half 2: busy_timeout, foreign_keys and synchronous are
		// per-connection and can only be checked on a connection that asked for
		// them, i.e. the pool openRepository just opened.
		if pragmaErr == nil && cfg.DB.Driver == "sqlite" {
			pragmaErr = sqlite.VerifyPragmas(ctx, db, sqlite.WantPragmas)
		}
	}

	switch {
	case cfg.DB.Driver != "sqlite":
		fmt.Fprintln(stdout, "pragmas: skipped (not sqlite)")
	case pragmaErr != nil:
		fail("pragmas", pragmaErr)
	default:
		fmt.Fprintln(stdout, "pragmas: ok")
	}

	// Leg 4: the data directory's mode and ownership. StateDirectoryMode=0700
	// (facts-ops.md §6.3) means group and world must have no access at all.
	if info, err := os.Stat(cfg.Instance.DataDir); err != nil {
		fail("data_dir", err)
	} else if perm := info.Mode().Perm(); perm&0o077 != 0 {
		fail("data_dir", fmt.Errorf("%s has mode %04o; group and world must have no access", cfg.Instance.DataDir, perm))
	} else {
		fmt.Fprintln(stdout, "data_dir: ok")
	}

	// Leg 5: the wasi artifact load plus dilla_abi.
	if info, err := doctorWasiLeg(ctx); err != nil {
		fail("wasi", err)
	} else {
		fmt.Fprintf(stdout, "wasi: ok (abi_version=%d core_version=%s)\n", info.ABIVersion, info.CoreVersion)
	}

	// Leg 6: clock skew against doctor.clock_peers.
	if skew, peer, err := doctorClockLeg(ctx, cfg.Doctor.ClockPeers, cfg.Doctor.ClockSkewMax.Value()); err != nil {
		fail("clock", err)
	} else {
		fmt.Fprintf(stdout, "clock: ok (skew %s against %s)\n", skew, peer)
	}

	if !healthy {
		return fmt.Errorf("doctor: one or more checks failed: %w", exit.Unavailable)
	}
	return nil
}

// doctorWasiLeg loads dilla-core-wasi from the conventional path next to the
// dillad binary and calls dilla_abi. Nothing in dillad yet configures this
// path — the wasi ABI is wired into serve only from task 14 onward — so this
// leg is red until the artifact is placed there.
func doctorWasiLeg(ctx context.Context) (mlswasi.ABIInfo, error) {
	exe, err := os.Executable()
	if err != nil {
		return mlswasi.ABIInfo{}, fmt.Errorf("locate the dillad binary: %w", err)
	}
	path := filepath.Join(filepath.Dir(exe), "dilla_core_wasi.wasm")
	raw, err := os.ReadFile(path) //nolint:gosec // G304: the path is the running binary's own directory joined with a constant file name
	if err != nil {
		return mlswasi.ABIInfo{}, fmt.Errorf("read %s: %w", path, err)
	}
	rt, err := mlswasi.New(ctx, raw, mlswasi.Options{})
	if err != nil {
		return mlswasi.ABIInfo{}, fmt.Errorf("load %s: %w", path, err)
	}
	defer func() { _ = rt.Close(ctx) }()
	return rt.ABI(ctx)
}

// doctorClockLeg fetches the Date header from the first configured peer that
// answers and reports the skew against the local wall clock. The peers are
// alternatives, not a quorum: doctor.clock_peers defaults to the ACME CA plus
// two well-known HTTPS hosts (config.Derive), and any one of them answering is
// enough to judge the local clock.
func doctorClockLeg(ctx context.Context, peers []string, maxSkew time.Duration) (time.Duration, string, error) {
	if len(peers) == 0 {
		return 0, "", errors.New("doctor.clock_peers is empty")
	}
	client := &http.Client{Timeout: 5 * time.Second}
	var lastErr error
	for _, peer := range peers {
		req, err := http.NewRequestWithContext(ctx, http.MethodHead, peer, nil)
		if err != nil {
			lastErr = err
			continue
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		dateHeader := resp.Header.Get("Date")
		_ = resp.Body.Close()
		remote, err := http.ParseTime(dateHeader)
		if err != nil {
			lastErr = fmt.Errorf("%s: no parseable Date header", peer)
			continue
		}
		skew := time.Since(remote)
		if skew < 0 {
			skew = -skew
		}
		if skew > maxSkew {
			return skew, peer, fmt.Errorf("%s reports a clock skew of %s, over the %s ceiling", peer, skew, maxSkew)
		}
		return skew, peer, nil
	}
	if lastErr != nil {
		return 0, "", fmt.Errorf("no configured clock peer answered: %w", lastErr)
	}
	return 0, "", errors.New("no configured clock peer answered")
}
