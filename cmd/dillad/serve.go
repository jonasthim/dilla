package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/postgres"
	postgresmigrations "github.com/jonasthim/dilla/internal/store/postgres/migrations"
	"github.com/jonasthim/dilla/internal/store/sqlite"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
	"github.com/pressly/goose/v3"
)

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
// highest migration, and serves a health endpoint until an interrupt drains
// it. Task 13 replaces the handler with dillad.New(...).Handler().
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

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})

	srv := &http.Server{
		Addr:              cfg.Server.Listen,
		Handler:           mux,
		ReadHeaderTimeout: cfg.Server.ReadHeaderTimeout.Value(),
		IdleTimeout:       cfg.Server.IdleTimeout.Value(),
		// No WriteTimeout: the gateway's WebSocket connections are long-lived.
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

	serveErr := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	notifyReady()

	select {
	case err := <-serveErr:
		if err != nil {
			return fmt.Errorf("serve: listen: %w: %w", err, exit.NoPerm)
		}
		return nil
	case <-runCtx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.Server.ShutdownGrace.Value())
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("serve: shutdown: %w: %w", err, exit.Fail)
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
