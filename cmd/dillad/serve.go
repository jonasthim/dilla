package main

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/pressly/goose/v3"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/jonasthim/dilla/internal/blob"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/dillad"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/obs"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/postgres"
	postgresmigrations "github.com/jonasthim/dilla/internal/store/postgres/migrations"
	"github.com/jonasthim/dilla/internal/store/sqlite"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
)

// metricsTokenEnv carries the bearer token /metrics is guarded with when
// metrics.require_admin is set. It is an environment variable and not a
// dilla.toml key because dilla.toml is configuration an operator diffs and
// copies around, while this is a credential: systemd's EnvironmentFile= is
// where the unit already keeps them. An unset variable is not a way in —
// dillad.New substitutes an unguessable random token and logs that no scrape
// will succeed.
const metricsTokenEnv = "DILLA_METRICS_TOKEN" //nolint:gosec // G101: the name of an environment variable, not a credential

// openRepository opens the configured storage engine's pool(s) and wraps them
// in a store.Repository. The *sql.DB it also returns is the pool migrations,
// pragma checks and PingContext run against: the single write pool for
// SQLite (repo.Close closes both the write and the read pool), the one shared
// pool for Postgres.
func openRepository(c *config.Config) (store.Repository, *sql.DB, error) {
	switch c.DB.Driver {
	case "sqlite":
		write, err := sqlite.OpenWrite(c.DB.Path)
		if err != nil {
			return nil, nil, fmt.Errorf("open database: %w: %w", err, exit.Unavailable)
		}
		read, err := sqlite.OpenRead(c.DB.Path)
		if err != nil {
			_ = write.Close()
			return nil, nil, fmt.Errorf("open database: %w: %w", err, exit.Unavailable)
		}
		return sqlite.New(write, read), write, nil
	case "postgres":
		db, err := postgres.Open(c.DB.DSN, c.DB.MaxOpenConns, c.DB.ConnMaxLifetime.Value())
		if err != nil {
			return nil, nil, fmt.Errorf("open database: %w: %w", err, exit.Unavailable)
		}
		return postgres.New(db), db, nil
	default:
		// config.Validate already refuses any other value; this is unreachable
		// through Load but kept so openRepository is total on its own.
		return nil, nil, fmt.Errorf("db.driver %q is neither sqlite nor postgres: %w", c.DB.Driver, exit.Config)
	}
}

// migrationProvider builds a goose Provider over db (as openRepository
// returned it), using the migration set for c's configured engine.
func migrationProvider(c *config.Config, db *sql.DB) (*goose.Provider, error) {
	switch c.DB.Driver {
	case "sqlite":
		p, err := goose.NewProvider(goose.DialectSQLite3, db, sqlitemigrations.FS)
		if err != nil {
			return nil, fmt.Errorf("migrations: %w: %w", err, exit.Software)
		}
		return p, nil
	case "postgres":
		p, err := goose.NewProvider(goose.DialectPostgres, db, postgresmigrations.FS)
		if err != nil {
			return nil, fmt.Errorf("migrations: %w: %w", err, exit.Software)
		}
		return p, nil
	default:
		return nil, fmt.Errorf("db.driver %q is neither sqlite nor postgres: %w", c.DB.Driver, exit.Config)
	}
}

// runServe loads the config, opens the repository, migrates it (when
// db.auto_migrate, after a VACUUM INTO backup when db.pre_migration_backup),
// refuses to start when the database's schema is newer than this binary's
// highest migration, and then serves internal/dillad's composition root until
// an interrupt drains it. Everything above the composition root is start-up
// order; every route, middleware and timeout lives in dillad.New, so the
// binary's surface and an end-to-end test's surface are one thing.
func runServe(args []string, stdout, stderr io.Writer) error {
	fs, cfgPath := newFlagSet("serve", stderr)
	if err := parse(fs, args, stdout); err != nil {
		return err
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}

	repo, db, err := openRepository(cfg)
	if err != nil {
		return err
	}
	defer func() { _ = repo.Close() }()

	ctx := context.Background()
	provider, err := migrationProvider(cfg, db)
	if err != nil {
		return err
	}
	current, target, err := provider.GetVersions(ctx)
	if err != nil {
		return fmt.Errorf("serve: read schema version: %w: %w", err, exit.Data)
	}
	if current > target {
		return fmt.Errorf("serve: database schema %d is newer than this binary's highest migration %d: refusing to start: %w",
			current, target, exit.Data)
	}
	if cfg.DB.AutoMigrate {
		if cfg.DB.PreMigrationBackup && cfg.DB.Driver == "sqlite" {
			backupPath := fmt.Sprintf("%s.pre-migration-%d", cfg.DB.Path, time.Now().Unix())
			if err := store.VacuumInto(ctx, db, backupPath); err != nil {
				return fmt.Errorf("serve: pre-migration backup: %w: %w", err, exit.CantCreate)
			}
		}
		if _, err := provider.Up(ctx); err != nil {
			return fmt.Errorf("serve: migrate: %w: %w", err, exit.Software)
		}
	}

	log := obs.NewLogger(cfg.Log, stderr)
	reg := prometheus.NewRegistry()
	metrics := obs.NewMetrics(reg, reg)
	health := obs.NewHealth(clock.System())

	// The blob store, its start-up sweep of interrupted uploads and the
	// garbage collector (Plan 2 task 11). SweepTemp runs before the listener
	// accepts an upload, so it can never remove one in flight.
	blobStore, err := blob.Open(cfg.Blobs.Dir, cfg.Blobs.Backend)
	if err != nil {
		return fmt.Errorf("serve: open blob store %s: %w: %w", cfg.Blobs.Dir, err, exit.CantCreate)
	}
	defer func() { _ = blobStore.Close() }()
	if n, err := blobStore.SweepTemp(); err != nil {
		return fmt.Errorf("serve: sweep temp uploads: %w: %w", err, exit.IOErr)
	} else if n > 0 {
		log.Info("removed interrupted uploads", "count", n)
	}
	sweeper := blob.NewSweeper(repo, blobStore, clock.System(), cfg.Blobs.GCGrace.Value(),
		cfg.Blobs.GCInterval.Value(), log).WithMetrics(metrics)

	srv, err := dillad.New(ctx, dillad.Options{
		Config: cfg, Repo: repo, Clock: clock.System(), Log: log,
		Metrics: metrics, Health: health, ScrapeToken: os.Getenv(metricsTokenEnv),
	})
	if err != nil {
		return fmt.Errorf("serve: %w: %w", err, exit.Software)
	}

	listenAddr := cfg.Server.Listen
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", listenAddr)
	if err != nil {
		return fmt.Errorf("serve: listen %s: %w: %w", listenAddr, err, exit.Unavailable)
	}
	// An operator (or a test) who asked the kernel for a port learns which one
	// it got; there is nowhere else to read it from.
	if strings.HasSuffix(listenAddr, ":0") {
		fmt.Fprintln(stdout, ln.Addr().String())
	}

	runCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// A second SIGINT/SIGTERM exits immediately rather than waiting out the
	// shutdown grace: NotifyContext only relays the first occurrence to runCtx.
	//
	// The registration and the goroutine last exactly as long as this run.
	// Left behind, they would make a later signal in the same process exit it
	// through a run that is already over — which is how an in-process test
	// that drives runServe twice loses its whole binary to the first run's
	// watcher.
	// The two signals are counted on this channel alone. Waiting on runCtx and
	// then draining forceExit with a non-blocking receive would be a race:
	// signal delivery to NotifyContext's channel and to this one is
	// independent, so the drain often runs before the FIRST signal has arrived
	// here, takes the default branch, and the blocking receive that follows
	// then treats that same first signal as the second and exits the process
	// in the middle of a perfectly ordinary drain. The buffer is 2 so a second
	// signal sent between the two receives is not dropped.
	forceExit := make(chan os.Signal, 2)
	signal.Notify(forceExit, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(forceExit)
	runOver := make(chan struct{})
	defer close(runOver)
	go func() {
		// The first signal is the one NotifyContext also relays to runCtx; it
		// starts the drain.
		select {
		case <-forceExit:
		case <-runOver:
			return
		}
		select {
		case <-forceExit:
		case <-runOver:
			return
		}
		fmt.Fprintln(stderr, "dillad: second signal received, exiting immediately")
		os.Exit(int(exit.Fail))
	}()

	// The sweeper runs for exactly as long as this serve, and runServe waits
	// for it before its deferred repo.Close and blobStore.Close, so a pass never
	// runs against a closed database. Its context is its own so that a Serve
	// that returns for a reason other than a signal still stops it.
	sweepCtx, stopSweep := context.WithCancel(runCtx)
	sweepDone := make(chan struct{})
	go func() {
		defer close(sweepDone)
		sweeper.Run(sweepCtx)
	}()
	defer func() {
		stopSweep()
		<-sweepDone
	}()

	notifyReady()

	drained := make(chan struct{})
	go func() {
		defer close(drained)
		<-runCtx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.Server.ShutdownGrace.Value())
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Error("shutdown", "err", err)
		}
	}()
	// Serve returns nil on the graceful close the goroutine above triggers.
	if err := srv.Serve(runCtx, ln); err != nil {
		return fmt.Errorf("serve: %w: %w", err, exit.Unavailable)
	}
	// Shutdown closes the LISTENER first, so Serve returns ErrServerClosed —
	// and therefore nil — the instant the drain STARTS, not when it finishes.
	// Returning here would run `defer repo.Close()` on a database the requests
	// still in flight are reading, and exit the process inside shutdown_grace.
	// Waiting for the goroutine is what makes the grace real.
	select {
	case <-runCtx.Done():
		<-drained
	default:
		// Serve returned for a reason other than a signal; no drain was
		// started and the goroutine is still parked on runCtx.
	}
	return nil
}

// notifyReady writes READY=1 to $NOTIFY_SOCKET by hand, over a unixgram
// socket: systemd's sd_notify protocol, with no dependency on
// coreos/go-systemd/v22 (Global Constraints: never added). A missing or
// unreachable socket is not an error: dillad runs the same way under a plain
// shell.
func notifyReady() {
	sock := os.Getenv("NOTIFY_SOCKET")
	if sock == "" {
		return
	}
	conn, err := (&net.Dialer{Timeout: 2 * time.Second}).DialContext(context.Background(), "unixgram", sock)
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	_, _ = conn.Write([]byte("READY=1"))
}
