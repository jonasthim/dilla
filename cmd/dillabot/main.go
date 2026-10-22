//go:build linux

// Command dillabot runs the first Linux service bootstrap for managed bot
// installations. It reconciles identity and currently authorized MLS groups;
// event dispatch and music are separate work and are not reported as ready here.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/helper"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/pelletier/go-toml/v2"
)

const maxConfigBytes = 64 << 10
const maxCredentialBytes = 4096

type config struct {
	BaseURL               string        `toml:"base_url"`
	InstanceIDText        string        `toml:"instance_id"`
	RuntimeCredentialFile string        `toml:"runtime_credential_file"`
	HelperExecutable      string        `toml:"helper_executable"`
	WASIModule            string        `toml:"wasi_module"`
	StateDir              string        `toml:"state_dir"`
	ReconcileIntervalText string        `toml:"reconcile_interval"`
	AllowLoopbackHTTP     bool          `toml:"allow_loopback_http"`
	SpotifyClientID       string        `toml:"spotify_client_id"`
	SpotifyRedirectURL    string        `toml:"spotify_redirect_url"`
	InstanceID            id.ID         `toml:"-"`
	ReconcileInterval     time.Duration `toml:"-"`
}

func loadConfig(path string) (config, error) {
	var c config
	if !filepath.IsAbs(path) {
		return c, errors.New("config path must be absolute")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return c, errors.New("config file is unavailable")
	}
	if len(raw) > maxConfigBytes {
		return c, errors.New("config file exceeds size limit")
	}
	decoder := toml.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	err = decoder.Decode(&c)
	clear(raw)
	if err != nil {
		return c, errors.New("config file is invalid")
	}
	var errs []error
	if c.BaseURL == "" {
		errs = append(errs, errors.New("base_url is required"))
	}
	if c.SpotifyClientID != "" || c.SpotifyRedirectURL != "" {
		redirect, parseErr := url.Parse(c.SpotifyRedirectURL)
		if c.SpotifyClientID == "" || len(c.SpotifyClientID) > 256 || strings.ContainsAny(c.SpotifyClientID, "\r\n\x00") ||
			parseErr != nil || redirect.Scheme != "https" || redirect.Host == "" || redirect.User != nil || redirect.Fragment != "" || len(c.SpotifyRedirectURL) > 2048 {
			errs = append(errs, errors.New("spotify_client_id and spotify_redirect_url must form a valid HTTPS OAuth pair"))
		}
	}
	c.InstanceID, err = id.Parse(c.InstanceIDText)
	if err != nil || c.InstanceID.IsZero() {
		errs = append(errs, errors.New("instance_id must be a non-zero lowercase 32-character ID"))
	}
	for name, value := range map[string]string{
		"runtime_credential_file": c.RuntimeCredentialFile,
		"helper_executable":       c.HelperExecutable,
		"wasi_module":             c.WASIModule,
		"state_dir":               c.StateDir,
	} {
		if value == "" || !filepath.IsAbs(value) {
			errs = append(errs, fmt.Errorf("%s must be an absolute path", name))
		}
	}
	c.ReconcileInterval, err = time.ParseDuration(c.ReconcileIntervalText)
	if err != nil || c.ReconcileInterval < time.Second || c.ReconcileInterval > 24*time.Hour {
		errs = append(errs, errors.New("reconcile_interval must be between 1s and 24h"))
	}
	if len(errs) != 0 {
		return config{}, errors.Join(errs...)
	}
	credential, err := readCredential(c.RuntimeCredentialFile)
	if err != nil {
		return config{}, errors.New("runtime credential file is unavailable or unsafe")
	}
	clear(credential)
	return c, nil
}

func readCredential(path string) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("credential path must be absolute")
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("credential file is unavailable or unsafe")
	}
	f := os.NewFile(uintptr(fd), "runtime-credential")
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, errors.New("credential file is unavailable or unsafe")
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || !ok || int64(st.Uid) != int64(os.Geteuid()) || info.Mode().Perm() != 0o600 {
		return nil, errors.New("credential file must be an owner-only 0600 regular file")
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxCredentialBytes+1))
	if err != nil || len(raw) > maxCredentialBytes {
		clear(raw)
		return nil, errors.New("credential file cannot be read")
	}
	token := strings.TrimSpace(string(raw))
	clear(raw)
	encoded := strings.TrimPrefix(token, "dbr_")
	decoded, decodeErr := base64.RawURLEncoding.Strict().DecodeString(encoded)
	canonical := decodeErr == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == encoded
	clear(decoded)
	if !strings.HasPrefix(token, "dbr_") || !canonical || strings.ContainsAny(token, " \t\r\n") {
		return nil, errors.New("credential file must contain one runtime credential")
	}
	return []byte(token), nil
}

func loadDatabaseKey(root, installation string) ([]byte, string, error) {
	if !filepath.IsAbs(root) || len(installation) != 32 {
		return nil, "", errors.New("invalid state directory or installation ID")
	}
	if err := ensurePrivateDir(root); err != nil {
		return nil, "", err
	}
	installDir := filepath.Join(root, installation)
	if err := ensurePrivateDir(installDir); err != nil {
		return nil, "", err
	}
	path := filepath.Join(installDir, "database.key")
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err == nil {
		f := os.NewFile(uintptr(fd), "database-key")
		defer f.Close()
		info, statErr := f.Stat()
		if statErr != nil {
			return nil, "", errors.New("database key is unavailable or unsafe")
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !info.Mode().IsRegular() || !ok || int64(st.Uid) != int64(os.Geteuid()) || info.Mode().Perm() != 0o600 {
			return nil, "", errors.New("database key must be an owner-only 0600 regular file")
		}
		key, readErr := io.ReadAll(io.LimitReader(f, 33))
		if readErr != nil || len(key) != 32 {
			clear(key)
			return nil, "", errors.New("database key must contain exactly 32 bytes")
		}
		return key, path, nil
	}
	if !errors.Is(err, syscall.ENOENT) {
		return nil, "", errors.New("database key is unavailable or unsafe")
	}
	entries, err := os.ReadDir(installDir)
	if err != nil {
		return nil, "", errors.New("installation state directory cannot be inspected")
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "state.db" || name == "state.db-wal" || name == "state.db-shm" || name == "state.db-journal" || strings.HasPrefix(name, "state.db.init-") || name == "state.init" || strings.HasPrefix(name, "state.init-tmp-") {
			return nil, "", errors.New("database key is missing while encrypted state exists; refusing to replace it")
		}
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		clear(key)
		return nil, "", errors.New("database key generation failed")
	}
	fd, err = syscall.Open(path, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		clear(key)
		return nil, "", errors.New("database key could not be created")
	}
	f := os.NewFile(uintptr(fd), "database-key")
	if _, err = f.Write(key); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		if dir, openErr := os.Open(installDir); openErr == nil {
			err = dir.Sync()
			_ = dir.Close()
		} else {
			err = openErr
		}
	}
	if err != nil {
		clear(key)
		return nil, "", errors.New("database key could not be persisted")
	}
	return key, path, nil
}

func ensurePrivateDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return errors.New("state directory is unavailable")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return errors.New("state directory is unavailable")
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !ok || int64(st.Uid) != int64(os.Geteuid()) || info.Mode().Perm()&0o077 != 0 {
		return errors.New("state directories must be owned by the service account and inaccessible to group/other")
	}
	if info.Mode().Perm() != 0o700 {
		if err := os.Chmod(path, 0o700); err != nil {
			return errors.New("state directory permissions could not be secured")
		}
	}
	return nil
}

func validateHelperExecutable(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("helper executable path must be absolute")
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return errors.New("native helper executable is unavailable")
	}
	f := os.NewFile(uintptr(fd), "native-helper")
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return errors.New("native helper must be a regular executable file")
	}
	return nil
}

func main() {
	fs := flag.NewFlagSet("dillabot", flag.ExitOnError)
	configPath := fs.String("config", "/etc/dilla/bot.toml", "path to the bot service TOML config")
	_ = fs.Parse(os.Args[1:])
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	cfg, err := loadConfig(*configPath)
	if err != nil {
		logger.Error("bot service configuration failed", "error", err.Error())
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, cfg, logger); err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("bot service stopped", "error", err.Error())
		os.Exit(1)
	}
}

func run(ctx context.Context, cfg config, logger *slog.Logger) error {
	credential, err := readCredential(cfg.RuntimeCredentialFile)
	if err != nil {
		return errors.New("runtime credential could not be loaded")
	}
	defer clear(credential)
	wasmBinary, err := os.ReadFile(cfg.WASIModule)
	if err != nil {
		return errors.New("WASI identity module is unavailable")
	}
	defer clear(wasmBinary)
	if err := ensurePrivateDir(cfg.StateDir); err != nil {
		return err
	}
	if err := validateHelperExecutable(cfg.HelperExecutable); err != nil {
		return err
	}
	logger.Info("bot service starting", "instance_id", cfg.InstanceID.String(), "identity_reconciliation", "enabled", "group_sync", "enabled", "events", "durable_poll_welcome", "music", "not_implemented")
	wasm, err := mlswasi.New(ctx, wasmBinary, mlswasi.Options{PoolSize: 1})
	if err != nil {
		return errors.New("WASI identity module failed startup validation")
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = wasm.Close(closeCtx)
	}()
	api, err := client.New(client.Config{
		BaseURL: cfg.BaseURL, InstanceID: cfg.InstanceID,
		AllowLoopbackHTTP: cfg.AllowLoopbackHTTP,
		Timeout:           30 * time.Second,
		HTTPClient:        &http.Client{Timeout: 30 * time.Second},
	})
	if err != nil {
		return errors.New("bot HTTP client configuration is invalid")
	}
	discovery, err := api.Discover(ctx)
	if err != nil || discovery.InstanceID != cfg.InstanceID {
		return errors.New("configured Dilla instance discovery failed")
	}
	runtime, err := api.Runtime(string(credential))
	if err != nil {
		return errors.New("runtime credential could not be bound to the client")
	}
	logger.Info("bot service healthy", "instance_id", discovery.InstanceID.String(), "generation", discovery.Generation, "discovery", "ok")
	for {
		if err := reconcile(ctx, cfg, api, runtime, wasm, logger); err != nil && !errors.Is(err, context.Canceled) {
			logger.Error("bot identity reconciliation degraded", "error", err.Error())
		} else if err == nil {
			logger.Info("bot identity reconciliation healthy")
		}
		timer := time.NewTimer(cfg.ReconcileInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}

func reconcile(ctx context.Context, cfg config, api *client.Client, runtime *client.Runtime, wasm *mlswasi.Runtime, logger *slog.Logger) error {
	installations, err := runtime.ListInstallations(ctx)
	if err != nil {
		return errors.New("installation discovery failed")
	}
	var eligible, succeeded int
	for _, installation := range installations {
		if err := ctx.Err(); err != nil {
			return err
		}
		if installation.State >= 4 {
			continue
		}
		eligible++
		key, _, err := loadDatabaseKey(cfg.StateDir, installation.ID.String())
		if err != nil {
			logger.Error("bot installation unavailable", "installation_id", installation.ID.String(), "stage", "state_key")
			continue
		}
		nativeClient, err := native.Start(ctx, helper.Options{Executable: cfg.HelperExecutable, StateDir: filepath.Join(cfg.StateDir, installation.ID.String())}, native.Binding{Instance: cfg.InstanceID, Community: installation.CommunityID, Installation: installation.ID}, key)
		clear(key)
		if err != nil {
			logger.Error("bot installation unavailable", "installation_id", installation.ID.String(), "stage", "helper_start")
			continue
		}
		lifecycle, err := service.NewIdentityLifecycle(cfg.InstanceID, installation.CommunityID, installation.ID, nativeClient, runtime, api, service.LifecycleOptions{})
		if err != nil {
			_ = nativeClient.Close()
			logger.Error("bot installation unavailable", "installation_id", installation.ID.String(), "stage", "lifecycle_bind")
			continue
		}
		result, ensureErr := lifecycle.Ensure(ctx)
		ready := false
		if ensureErr == nil {
			if result.Session == nil {
				ensureErr = errors.New("identity lifecycle returned no scoped device session")
			} else {
				var membership *service.MembershipReconciler
				membership, ensureErr = service.NewMembershipReconciler(nativeClient, service.SourceSyncOptions{}, 32)
				if ensureErr == nil {
					_, ensureErr = membership.ReconcileOnce(ctx, result.Session)
					if ensureErr == nil {
						ready, ensureErr = markReadyAfterMembership(ctx, result.Session, result.Installation)
						if ensureErr == nil {
							poller, pollerErr := service.NewStructuralEventPoller(nativeClient, service.StructuralEventPollerOptions{})
							if pollerErr != nil {
								ensureErr = pollerErr
							} else {
								handler, handlerErr := newWelcomeHandler(nativeClient, result.Session, api, installation.CommunityID, installation.ID)
								if handlerErr != nil {
									ensureErr = handlerErr
								} else if _, pollErr := poller.PollOnce(ctx, result.Session, handler); pollErr != nil {
									logger.Error("bot structural event dispatch paused", "installation_id", installation.ID.String(), "error", pollErr.Error())
									ensureErr = pollErr
								}
							}
						}
					}
				}
			}
		}
		if ensureErr == nil && cfg.SpotifyClientID != "" {
			credentials, linkErr := service.NewSpotifyCredentials(runtime, nativeClient, cfg.SpotifyClientID, cfg.SpotifyRedirectURL)
			if linkErr == nil {
				linkErr = credentials.Link(ctx)
			}
			if linkErr != nil && !errors.Is(linkErr, service.ErrSpotifyNoPending) {
				logger.Error("bot Spotify account link needs attention", "installation_id", installation.ID.String(), "error", linkErr.Error())
				ensureErr = linkErr
			}
		}
		closeErr := nativeClient.Close()
		if ensureErr != nil || closeErr != nil {
			logger.Error("bot installation reconciliation failed", "installation_id", installation.ID.String(), "stage", "identity_membership_or_spotify_link")
			continue
		}
		succeeded++
		logger.Info("bot installation identity and membership reconciled", "installation_id", installation.ID.String(), "ready", ready)
	}
	if succeeded != eligible {
		return fmt.Errorf("%d of %d eligible installations reconciled", succeeded, eligible)
	}
	return nil
}
