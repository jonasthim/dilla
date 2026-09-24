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
	"github.com/pressly/goose/v3"
	"github.com/prometheus/client_golang/prometheus"
)

// metricsTokenEnv carries the bearer token /metrics is guarded with when
// metrics.require_admin is set. It is an environment variable and not a
// dilla.toml key because dilla.toml is configuration an operator diffs and
// copies around, while this is a credential: systemd's EnvironmentFile= is
// where the unit already keeps them. An unset variable is not a way in —
// dillad.New substitutes an unguessable random token and logs that no scrape
// will succeed.
const metricsTokenEnv = "DILLA_METRICS_TOKEN"

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
			write.Close()
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
	defer repo.Close()

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

	srv, err := dillad.New(ctx, dillad.Options{
		Config: cfg, Repo: repo, Clock: clock.System(), Log: log,
		Metrics: metrics, Health: health, ScrapeToken: os.Getenv(metricsTokenEnv),
	})
	if err != nil {
		return fmt.Errorf("serve: %w: %w", err, exit.Software)
	}

	listenAddr := cfg.Server.Listen
	ln, err := net.Listen("tcp", listenAddr)
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
	forceExit := make(chan os.Signal, 1)
	signal.Notify(forceExit, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-runCtx.Done()
		// The signal that cancelled runCtx was also delivered here; drain it
		// before waiting for a genuinely second one.
		select {
		case <-forceExit:
		default:
		}
		<-forceExit
		fmt.Fprintln(stderr, "dillad: second signal received, exiting immediately")
		os.Exit(int(exit.Fail))
	}()

	notifyReady()

	go func() {
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
	conn, err := net.Dial("unixgram", sock)
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = conn.Write([]byte("READY=1"))
}
