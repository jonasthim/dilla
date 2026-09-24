package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/netip"
	"os"
	"path/filepath"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/sqlite"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
	"github.com/pressly/goose/v3"
)

// writeSecret writes n CSPRNG bytes as lowercase hex at mode 0600 and returns
// the path. init generates every secret file its own config references, because
// a dilla.toml that Validate refuses is not a bootstrap, it is a dead end.
func writeSecret(dir, name string, n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(hex.EncodeToString(buf)), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// runInit creates the data directory, writes dilla.toml at 0600, generates the
// instance keys and the TURN and LiveKit secret files, CREATES AND MIGRATES the
// database (R35), inserts one bootstrap admin invite and prints its link exactly
// once. It refuses to touch a data directory that already holds a dilla.toml.
func runInit(args []string, stdout, stderr io.Writer) error {
	fs, _ := newFlagSet("init", stderr)
	dataDir := fs.String("data-dir", "/var/lib/dilla", "state root")
	domain := fs.String("domain", "", "public DNS name (required)")
	publicIP := fs.String("public-ip", "", "public IP literal (required)")
	agreeTOS := fs.Bool("agree-tos", false, "accept the ACME CA's subscriber agreement on the operator's behalf")
	if err := parse(fs, args, stdout); err != nil {
		return err
	}
	if *domain == "" || *publicIP == "" {
		fmt.Fprintln(stderr, "dillad init: --domain and --public-ip are required")
		return exit.Usage
	}
	if !*agreeTOS {
		fmt.Fprintln(stderr, "dillad init: --agree-tos is required: tls.agreed records the operator's acceptance of the ACME CA's subscriber agreement, and dillad has no standing to accept it for them")
		return exit.Usage
	}
	cfgPath := filepath.Join(*dataDir, "dilla.toml")
	if _, err := os.Stat(cfgPath); err == nil {
		return fmt.Errorf("init: %s already exists; refusing to overwrite an initialised instance: %w", cfgPath, exit.CantCreate)
	}
	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		return fmt.Errorf("init: create %s: %w: %w", *dataDir, err, exit.CantCreate)
	}

	c := config.Default()
	c.Instance.Domain = *domain
	addr, err := netip.ParseAddr(*publicIP)
	if err != nil {
		return fmt.Errorf("init: --public-ip %q: %w: %w", *publicIP, err, exit.Usage)
	}
	c.Instance.PublicIP = addr
	c.Instance.DataDir = *dataDir
	c.DB.Path = filepath.Join(*dataDir, "dilla.db")
	c.Blobs.Dir = filepath.Join(*dataDir, "blobs")
	c.TLS.Agreed = true // the operator said so with --agree-tos
	// Default() leaves turn.enabled and livekit.enabled true, and Validate then
	// requires turn.shared_secret_file, turn.relay_ip and livekit.api_secret_file.
	// Generate them here, or the file this verb writes is one no other verb can
	// read back.
	turnSecret, err := writeSecret(*dataDir, "turn.secret", 32)
	if err != nil {
		return fmt.Errorf("init: write turn secret: %w: %w", err, exit.CantCreate)
	}
	livekitSecret, err := writeSecret(*dataDir, "livekit.secret", 32)
	if err != nil {
		return fmt.Errorf("init: write livekit secret: %w: %w", err, exit.CantCreate)
	}
	c.TURN.SharedSecretFile = turnSecret
	c.TURN.RelayIP = addr.String()
	c.LiveKit.APISecretFile = livekitSecret
	c.Derive()

	write, err := sqlite.OpenWrite(c.DB.Path)
	if err != nil {
		return fmt.Errorf("init: %w: %w", err, exit.CantCreate)
	}
	provider, err := goose.NewProvider(goose.DialectSQLite3, write, sqlitemigrations.FS)
	if err != nil {
		write.Close()
		return fmt.Errorf("init: migrations: %w: %w", err, exit.Software)
	}
	if _, err := provider.Up(context.Background()); err != nil {
		write.Close()
		return fmt.Errorf("init: migrate: %w: %w", err, exit.Data)
	}
	read, err := sqlite.OpenRead(c.DB.Path)
	if err != nil {
		write.Close()
		return fmt.Errorf("init: %w: %w", err, exit.CantCreate)
	}
	repo := sqlite.New(write, read)
	defer repo.Close() // closes BOTH pools; `defer write.Close()` would leak the read pool

	now := time.Now().Unix()
	// The two instance secrets of protocol/03 § Instance keys: the external
	// sender's Ed25519 signing key, whose public half goes into every text and
	// call group's external_senders extension, and K_frank, the 32-byte HMAC key
	// of protocol/04 § Franking. Both are generated once, here, and stored in
	// instances.key_history under the CBOR layout that section fixes.
	esPub, esPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return fmt.Errorf("init: generate external sender key: %w: %w", err, exit.Software)
	}
	frankKey := make([]byte, 32)
	if _, err := rand.Read(frankKey); err != nil {
		return fmt.Errorf("init: generate franking key: %w: %w", err, exit.Software)
	}
	externalSenderKeyID, frankingKeyID := id.New(), id.New()
	keyHistory, err := cborx.Marshal([]any{
		uint64(1),
		[]any{
			// kind 0: external sender. The secret is the 32-byte Ed25519 seed,
			// which is ed25519.PrivateKey's first half.
			[]any{uint64(0), externalSenderKeyID, []byte(esPub), []byte(esPriv.Seed()), uint64(now), nil},
			// kind 1: franking. No public half.
			[]any{uint64(1), frankingKeyID, []byte{}, frankKey, uint64(now), nil},
		},
	})
	if err != nil {
		return fmt.Errorf("init: encode key history: %w: %w", err, exit.Software)
	}
	instance := store.InstanceRow{
		InstanceID: id.New(), ExternalSenderKeyID: externalSenderKeyID, KeyHistory: keyHistory,
		FrankingKeyID: frankingKeyID, Generation: 1, PolicyVersion: 1, Created: now,
	}
	code, hash := auth.NewInviteCode()
	invite := store.InviteRow{
		ID: id.New(), CodeHash: hash, GrantsAdmin: 1, MaxUses: 1,
		Created: now, ExpiresAt: now + int64(24*time.Hour/time.Second),
	}
	if err := repo.Tx(context.Background(), func(tx store.Repository) error {
		if err := tx.CreateInstance(context.Background(), instance); err != nil {
			return err
		}
		return tx.CreateInvite(context.Background(), invite)
	}); err != nil {
		return fmt.Errorf("init: bootstrap: %w: %w", err, exit.Data)
	}

	sum := sha256.Sum256(hash)
	c.Registration.AdminInvite = hex.EncodeToString(sum[:4]) // the reference, never the code (NV12)
	f, err := os.OpenFile(cfgPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("init: write %s: %w: %w", cfgPath, err, exit.CantCreate)
	}
	defer f.Close()
	if err := c.WriteTo(f); err != nil {
		return fmt.Errorf("init: %w: %w", err, exit.IOErr)
	}
	fmt.Fprintf(stdout, "dillad init: wrote %s\n", cfgPath)
	fmt.Fprintf(stdout, "bootstrap invite (valid 24 hours, one use): https://%s/i/%s\n", *domain, code)
	fmt.Fprintln(stdout, "this link is printed once and is not stored anywhere; the database holds only its SHA-256")
	return nil
}
