// Package dilladtest is the test-only control surface: an initialised instance, seeding, and a
// clock and a database the harness can move.
//
// It is never imported by cmd/dillad. `go list -deps ./cmd/dillad` asserts that in CI, because the
// alternative — a --insecure-test-bootstrap flag on `dillad serve` — is a production back door
// whose only protection is that nobody passes the flag.
package dilladtest

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/dillad"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/obs"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/sqlite"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
	"github.com/pressly/goose/v3"
)

// InviteUses is how many accounts each of the harness's invites admits: the schema's own ceiling
// (`max_uses BETWEEN 1 AND 1000`). A scenario enrols every client through the invites (the instance
// is invite-only and has no other way in), and join_storm_256_batched alone enrols 1,001, so the
// harness mints Invites of them and the runner moves to the next when one is spent.
const (
	InviteUses = 1000
	Invites    = 4
)

// HostOptions configures NewHost. DataDir and CorePath are required.
type HostOptions struct {
	// DataDir holds the SQLite file, the wazero cache and the snapshots; use t.TempDir().
	DataDir string
	// CorePath is the wasm32-wasip1 build of dilla-core-wasi. Ignored when Wasm is set.
	CorePath string
	// Wasm is a runtime the caller owns and keeps across hosts; nil means NewHost compiles one
	// and Close closes it.
	Wasm *mlswasi.Runtime
	// Clock is the instance clock the control listener moves. nil means a fake clock at the
	// current wall-clock second: the clients mint their KeyPackages against the wall clock, and
	// an instance clock years behind it would find every KeyPackage not yet valid.
	Clock *clock.Fake
	// LogLevel is the instance's slog level; "" means warn.
	LogLevel string
	// LogOutput receives the instance log; nil means os.Stderr.
	LogOutput io.Writer
}

// AllowEveryone is the harness's channel ACL: every enrolled user is eligible for every group.
//
// Plan 1 ships ds.DenyUnlessMember, which admits a user only where the instance can already see
// them in the group, because the permission resolver is Plan 2 task 3's. Under it no scenario can
// add a second user to anything, so the harness — and only the harness — answers the one question
// Plan 2 will answer from roles. It is not a mock of the delivery service: invariant 4's other
// clauses (the signed device list, the structural validation, the GroupInfo epoch) still run.
type AllowEveryone struct{}

func (AllowEveryone) Eligible(context.Context, id.ID, id.ID) (bool, error) { return true, nil }

// Host is one initialised instance behind a stable public handler. Restore replaces the server
// underneath the handler, as `dillad restore` followed by a restart replaces the process, so the
// clients keep their base URL across it.
type Host struct {
	o       HostOptions
	cfg     *config.Config
	clk     *clock.Fake
	wasm    *mlswasi.Runtime
	owns    bool
	invites []string

	mu     sync.RWMutex
	server *dillad.Server

	// kicked remembers, per target device, the leaves the last kick of it named.
	kickMu sync.Mutex
	kicked map[id.ID][]kicked
}

// NewHost does what `dillad init` does — migrate, write the instance row with both instance
// keys, mint the invites — and then builds the server over that database with a fake clock.
func NewHost(ctx context.Context, o HostOptions) (*Host, error) {
	if o.DataDir == "" {
		return nil, errors.New("dilladtest: HostOptions.DataDir is required")
	}
	clk := o.Clock
	if clk == nil {
		clk = clock.NewFake(time.Now().Truncate(time.Second))
	}
	h := &Host{o: o, clk: clk, cfg: hostConfig(o), kicked: map[id.ID][]kicked{}}
	invites, err := bootstrap(ctx, h.cfg, clk.Now())
	if err != nil {
		return nil, err
	}
	h.invites = invites

	h.wasm = o.Wasm
	if h.wasm == nil {
		module, err := os.ReadFile(o.CorePath)
		if err != nil {
			return nil, fmt.Errorf("dilladtest: read the wasi core %q: %w", o.CorePath, err)
		}
		h.wasm, err = mlswasi.New(ctx, module, mlswasi.Options{
			CacheDir: filepath.Join(o.DataDir, "wazero-cache"),
			Now:      clk.Now,
		})
		if err != nil {
			return nil, fmt.Errorf("dilladtest: build the wasi runtime: %w", err)
		}
		h.owns = true
	}
	server, err := h.newServer(ctx)
	if err != nil {
		h.closeWasm(ctx)
		return nil, err
	}
	h.server = server
	return h, nil
}

// hostConfig is config.Default with what `dillad init` would write, and the one change a harness
// needs: rate limiting is off, because a scenario enrols up to a thousand devices from one
// loopback address and the per-IP registration bucket holds three.
func hostConfig(o HostOptions) *config.Config {
	c := config.Default()
	c.Instance.Domain = "dilla.test"
	c.Instance.DataDir = o.DataDir
	c.DB.Path = filepath.Join(o.DataDir, "dilla.db")
	c.Blobs.Dir = filepath.Join(o.DataDir, "blobs")
	c.TLS.Agreed = true
	c.Log.Level = o.LogLevel
	if c.Log.Level == "" {
		c.Log.Level = "warn"
	}
	c.Limits.Rate.Enabled = false
	c.Derive()
	return c
}

// bootstrap migrates the database and inserts the instance row and Invites invites, as `dillad init`
// does, except that each invite admits InviteUses accounts and none expires within a scenario.
func bootstrap(ctx context.Context, c *config.Config, now time.Time) ([]string, error) {
	if err := os.MkdirAll(c.Instance.DataDir, 0o700); err != nil {
		return nil, err
	}
	write, err := sqlite.OpenWrite(c.DB.Path)
	if err != nil {
		return nil, fmt.Errorf("dilladtest: %w", err)
	}
	provider, err := goose.NewProvider(goose.DialectSQLite3, write, sqlitemigrations.FS)
	if err != nil {
		write.Close()
		return nil, fmt.Errorf("dilladtest: migrations: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		write.Close()
		return nil, fmt.Errorf("dilladtest: migrate: %w", err)
	}
	read, err := sqlite.OpenRead(c.DB.Path)
	if err != nil {
		write.Close()
		return nil, fmt.Errorf("dilladtest: %w", err)
	}
	repo := sqlite.New(write, read)
	defer repo.Close()

	esPub, esPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	frank := make([]byte, 32)
	if _, err := rand.Read(frank); err != nil {
		return nil, err
	}
	unix := now.Unix()
	senderKeyID, frankingKeyID := id.New(), id.New()
	history, err := cborx.Marshal([]any{uint64(1), []any{
		[]any{uint64(0), senderKeyID, []byte(esPub), []byte(esPriv.Seed()), uint64(unix), nil},
		[]any{uint64(1), frankingKeyID, []byte{}, frank, uint64(unix), nil},
	}})
	if err != nil {
		return nil, err
	}
	codes := make([]string, 0, Invites)
	err = repo.Tx(ctx, func(tx store.Repository) error {
		if err := tx.CreateInstance(ctx, store.InstanceRow{
			InstanceID: id.New(), ExternalSenderKeyID: senderKeyID, KeyHistory: history,
			FrankingKeyID: frankingKeyID, Generation: 1, PolicyVersion: 1, Created: unix,
		}); err != nil {
			return err
		}
		for range Invites {
			code, hash := auth.NewInviteCode()
			if err := tx.CreateInvite(ctx, store.InviteRow{
				ID: id.New(), CodeHash: hash, MaxUses: InviteUses, Created: unix,
				ExpiresAt: unix + int64(10*365*24*time.Hour/time.Second),
			}); err != nil {
				return err
			}
			codes = append(codes, code)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("dilladtest: bootstrap: %w", err)
	}
	return codes, nil
}

func (h *Host) newServer(ctx context.Context) (*dillad.Server, error) {
	out := h.o.LogOutput
	if out == nil {
		out = os.Stderr
	}
	return dillad.New(ctx, dillad.Options{
		Config: h.cfg,
		Clock:  h.clk,
		Wasm:   h.wasm,
		Log:    obs.NewLogger(h.cfg.Log, out),
		ACL:    AllowEveryone{},
	})
}

// Server is the instance as it stands: a Restore replaces it.
func (h *Host) Server() *dillad.Server {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.server
}

// Handler is the public /v1 and /gateway surface. It is stable across Restore: each request goes
// to the server that is current when it arrives.
func (h *Host) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.Server().Handler().ServeHTTP(w, r)
	})
}

// Invite is the plain codes of the harness's invites, comma-separated, as DILLA_TESTKIT_INVITE
// carries them: every scenario client redeems one, and the runner moves on when one is spent.
func (h *Host) Invite() string { return strings.Join(h.invites, ",") }

// Clock is the instance clock.
func (h *Host) Clock() *clock.Fake { return h.clk }

// Log is a logger for the host's own events, at the instance's level.
func (h *Host) Log() *slog.Logger {
	out := h.o.LogOutput
	if out == nil {
		out = os.Stderr
	}
	return obs.NewLogger(h.cfg.Log, out)
}

var snapshotName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func (h *Host) snapshotPath(name string) (string, error) {
	if !snapshotName.MatchString(name) {
		return "", fmt.Errorf("dilladtest: snapshot name %q is not [A-Za-z0-9_-]{1,64}", name)
	}
	return filepath.Join(h.cfg.Instance.DataDir, "snapshots", name+".db"), nil
}

// Snapshot copies the database, consistently, as a backup would.
func (h *Host) Snapshot(ctx context.Context, name string) error {
	path, err := h.snapshotPath(name)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	_ = os.Remove(path)
	h.mu.RLock()
	defer h.mu.RUnlock()
	db, err := sqlite.OpenWrite(h.cfg.DB.Path)
	if err != nil {
		return err
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx, `VACUUM INTO ?`, path); err != nil {
		return fmt.Errorf("dilladtest: snapshot %s: %w", name, err)
	}
	return nil
}

// Restore does what `dillad restore` and the restart after it do: the server stops, the database
// is replaced by the snapshot, a new server starts over it, and invariant 11's OnRestore bumps the
// generation, marks every group epoch-unknown and purges the KeyPackages.
func (h *Host) Restore(ctx context.Context, name string) error {
	path, err := h.snapshotPath(name)
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("dilladtest: no snapshot %s: %w", name, err)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.server.Shutdown(ctx); err != nil {
		return fmt.Errorf("dilladtest: stop the instance for the restore: %w", err)
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Remove(h.cfg.DB.Path + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := copyFile(path, h.cfg.DB.Path); err != nil {
		return err
	}
	server, err := h.newServer(ctx)
	if err != nil {
		return fmt.Errorf("dilladtest: start the restored instance: %w", err)
	}
	h.server = server
	if err := server.DS().OnRestore(ctx, 0); err != nil {
		return fmt.Errorf("dilladtest: OnRestore: %w", err)
	}
	return nil
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// Close stops the server and, when NewHost compiled it, the wasm runtime.
func (h *Host) Close(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	err := h.server.Shutdown(ctx)
	h.closeWasm(ctx)
	return err
}

func (h *Host) closeWasm(ctx context.Context) {
	if h.owns {
		_ = h.wasm.Close(ctx)
	}
}
