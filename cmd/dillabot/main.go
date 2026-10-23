//go:build linux

// Command dillabot reconciles managed bot identity, authorized MLS groups,
// paused music queue metadata, and durable group-event moderation handling.
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

	"github.com/pelletier/go-toml/v2"

	"github.com/jonasthim/dilla/internal/bot/announcements"
	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/helper"
	"github.com/jonasthim/dilla/internal/bot/moderation"
	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/session"
	"github.com/jonasthim/dilla/internal/bot/music/spotify"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
)

const maxConfigBytes = 64 << 10
const maxCredentialBytes = 4096

// Version is stamped by the release workflow. Development builds retain the
// explicit fallback so operators can distinguish them from tagged releases.
var Version = "0.0.0-dev"

type config struct {
	BaseURL                 string        `toml:"base_url"`
	InstanceIDText          string        `toml:"instance_id"`
	RuntimeCredentialFile   string        `toml:"runtime_credential_file"`
	HelperExecutable        string        `toml:"helper_executable"`
	WASIModule              string        `toml:"wasi_module"`
	StateDir                string        `toml:"state_dir"`
	ReconcileIntervalText   string        `toml:"reconcile_interval"`
	AllowLoopbackHTTP       bool          `toml:"allow_loopback_http"`
	SpotifyClientID         string        `toml:"spotify_client_id"`
	SpotifyRedirectURL      string        `toml:"spotify_redirect_url"`
	SpotifyHelperExecutable string        `toml:"spotify_helper_executable"`
	InstanceID              id.ID         `toml:"-"`
	ReconcileInterval       time.Duration `toml:"-"`
}

func loadConfig(path string) (config, error) {
	var c config
	if !filepath.IsAbs(path) {
		return c, errors.New("config path must be absolute")
	}
	raw, err := os.ReadFile(path) // #nosec G304 -- path is the explicit absolute --config operator argument.
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
		if c.SpotifyHelperExecutable != "" && !filepath.IsAbs(c.SpotifyHelperExecutable) {
			errs = append(errs, errors.New("spotify_helper_executable must be an absolute path"))
		}
	} else if c.SpotifyHelperExecutable != "" {
		errs = append(errs, errors.New("spotify_helper_executable requires Spotify OAuth configuration"))
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
	defer func() { _ = f.Close() }()
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

func unixSecondsOrZero(now time.Time) uint64 {
	seconds := now.Unix()
	if seconds < 0 {
		return 0
	}
	return uint64(seconds)
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
		defer func() { _ = f.Close() }()
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
		if dir, openErr := os.Open(installDir); openErr == nil { // #nosec G304 -- installDir is derived under the private state directory.
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
		if err := os.Chmod(path, 0o700); err != nil { // #nosec G302 -- this is a private directory and needs owner execute permission.
			return errors.New("state directory permissions could not be secured")
		}
	}
	return nil
}

func validateHelperExecutable(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("helper executable path must be absolute")
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return errors.New("native helper executable is unavailable")
	}
	f := os.NewFile(uintptr(fd), "native-helper")
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || !trustedLocalCode(info) || !serviceCanExecute(info) {
		return errors.New("native helper must be a regular executable file")
	}
	return nil
}

func trustedLocalCode(info os.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && (st.Uid == 0 || int64(st.Uid) == int64(os.Geteuid())) && info.Mode().Perm()&0o022 == 0 && info.Mode()&(os.ModeSetuid|os.ModeSetgid) == 0
}

func serviceCanExecute(info os.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	mode := info.Mode().Perm()
	if os.Geteuid() == 0 {
		return mode&0o111 != 0
	}
	if int64(st.Uid) == int64(os.Geteuid()) {
		return mode&0o100 != 0
	}
	if int64(st.Gid) == int64(os.Getegid()) {
		return mode&0o010 != 0
	}
	groups, err := os.Getgroups()
	if err != nil {
		return false
	}
	for _, group := range groups {
		if int64(st.Gid) == int64(group) {
			return mode&0o010 != 0
		}
	}
	return mode&0o001 != 0
}

func main() {
	if runVersionCommand(os.Args[1:], os.Stdout) {
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "doctor" {
		os.Exit(runDoctorCommand(os.Args[2:], os.Stdout, os.Stderr))
	}
	if len(os.Args) > 1 && os.Args[1] == "interaction-recovery" {
		os.Exit(runInteractionRecoveryCommand(os.Args[2:], os.Stdout, os.Stderr))
	}
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

func runVersionCommand(args []string, stdout io.Writer) bool {
	if len(args) != 1 || args[0] != "version" {
		return false
	}
	fmt.Fprintf(stdout, "dillabot %s\n", Version)
	return true
}

func run(ctx context.Context, cfg config, logger *slog.Logger) error {
	credential, err := readCredential(cfg.RuntimeCredentialFile)
	if err != nil {
		return errors.New("runtime credential could not be loaded")
	}
	defer clear(credential)
	wasmBinary, err := readDoctorWASI(cfg.WASIModule)
	if err != nil {
		return errors.New("wasi identity module is unavailable")
	}
	defer clear(wasmBinary)
	if err := ensurePrivateDir(cfg.StateDir); err != nil {
		return err
	}
	if err := validateHelperExecutable(cfg.HelperExecutable); err != nil {
		return err
	}
	if cfg.SpotifyHelperExecutable != "" {
		if err := validateHelperExecutable(cfg.SpotifyHelperExecutable); err != nil {
			return errors.New("spotify PCM helper is unavailable")
		}
	}
	var spotifyLeases *music.SpotifyLeaseManager
	if cfg.SpotifyHelperExecutable != "" {
		spotifyLeases, err = music.NewSpotifyLeaseManager(cfg.StateDir)
		if err != nil {
			return errors.New("spotify playback lease is unavailable")
		}
	}
	logger.Info("bot service starting", "instance_id", cfg.InstanceID.String(), "identity_reconciliation", "enabled", "group_sync", "enabled", "events", "durable_poll_welcome_interaction_and_moderation_dispatch", "music", "paused_restoration_with_configured_pcm_starters")
	wasm, err := mlswasi.New(ctx, wasmBinary, mlswasi.Options{PoolSize: 1})
	if err != nil {
		return errors.New("wasi identity module failed startup validation")
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
	musicRegistry := newMusicQueueRegistry()
	autoModerationState := newAutoModerationEventState()
	for {
		if err := reconcile(ctx, cfg, api, runtime, wasm, musicRegistry, autoModerationState, spotifyLeases, logger); err != nil && !errors.Is(err, context.Canceled) {
			logger.Error("bot identity reconciliation degraded", "error", err.Error())
		} else if err == nil {
			logger.Info("bot identity reconciliation healthy")
		}
		timer := time.NewTimer(cfg.ReconcileInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			if err := musicRegistry.Close(); err != nil {
				logger.Error("bot music queue shutdown incomplete", "error", err.Error())
			}
			return nil
		case <-timer.C:
		}
	}
}

func reconcile(ctx context.Context, cfg config, api *client.Client, runtime *client.Runtime, wasm *mlswasi.Runtime, musicRegistry *musicQueueRegistry, autoModerationState *autoModerationEventState, spotifyLeases *music.SpotifyLeaseManager, logger *slog.Logger) error {
	var spotifyGuard *service.SpotifyAccountGuard
	if cfg.SpotifyClientID != "" {
		var err error
		spotifyGuard, err = service.NewSpotifyAccountGuard(cfg.StateDir)
		if err != nil {
			return errors.New("spotify account guard unavailable")
		}
	}
	installations, err := runtime.ListInstallations(ctx)
	if err != nil {
		return errors.New("installation discovery failed")
	}
	activeInstallations := make([]id.ID, 0, len(installations))
	for _, installation := range installations {
		activeInstallations = append(activeInstallations, installation.ID)
	}
	if err := musicRegistry.RetainOnly(activeInstallations); err != nil {
		logger.Error("stale bot music runtime cleanup incomplete", "error", err.Error())
	}
	autoModerationState.RetainOnly(activeInstallations)
	var eligible, succeeded int
	for _, installation := range installations {
		if err := ctx.Err(); err != nil {
			return err
		}
		if installation.State >= 4 {
			_ = musicRegistry.Disable(installation.ID)
			autoModerationState.Disable(installation.ID)
			continue
		}
		eligible++
		nativeClient, retainedNative := musicRegistry.Native(installation.ID, installation.CommunityID).(*native.Client)
		if !retainedNative {
			key, _, keyErr := loadDatabaseKey(cfg.StateDir, installation.ID.String())
			if keyErr != nil {
				_ = musicRegistry.Disable(installation.ID)
				logger.Error("bot installation unavailable", "installation_id", installation.ID.String(), "stage", "state_key")
				continue
			}
			nativeClient, err = native.Start(ctx, helper.Options{Executable: cfg.HelperExecutable, StateDir: filepath.Join(cfg.StateDir, installation.ID.String())}, native.Binding{Instance: cfg.InstanceID, Community: installation.CommunityID, Installation: installation.ID}, key)
			clear(key)
			if err != nil {
				_ = musicRegistry.Disable(installation.ID)
				logger.Error("bot installation unavailable", "installation_id", installation.ID.String(), "stage", "helper_start")
				continue
			}
		}
		lifecycle, err := service.NewIdentityLifecycle(cfg.InstanceID, installation.CommunityID, installation.ID, nativeClient, runtime, api, service.LifecycleOptions{})
		if err != nil {
			_ = nativeClient.Close()
			_ = musicRegistry.Disable(installation.ID)
			logger.Error("bot installation unavailable", "installation_id", installation.ID.String(), "stage", "lifecycle_bind")
			continue
		}
		var musicOwnedNative bool
		var musicQueueCount int
		reconcileStage := "identity"
		result, ensureErr := lifecycle.Ensure(ctx)
		ready := false
		membershipReady := false
		if ensureErr == nil {
			reconcileStage = "interaction_restore"
			if result.Session == nil {
				ensureErr = errors.New("identity lifecycle returned no scoped device session")
			} else {
				var healed int
				healed, ensureErr = healRestoredInteractionGroups(ctx, nativeClient, result.Session)
				if ensureErr == nil && healed > 0 {
					logger.Info("bot interaction groups healed after restore", "installation_id", installation.ID.String(), "groups", healed)
				}
			}
			if ensureErr == nil {
				reconcileStage = "membership_source_sync"
				var membership *service.MembershipReconciler
				membership, ensureErr = service.NewMembershipReconciler(nativeClient, service.SourceSyncOptions{}, 32)
				if ensureErr == nil {
					_, ensureErr = membership.ReconcileOnce(ctx, result.Session)
					if ensureErr == nil {
						reconcileStage = "membership_trust"
						// Newly joined MLS members are not actionable until their
						// signed device-list history has been checked by the core.
						var trust *service.SourceTrust
						trust, ensureErr = service.NewSourceTrust(nativeClient)
						if ensureErr == nil {
							_, ensureErr = trust.TrustPendingLeaves(ctx, result.Session)
						}
					}
					if ensureErr == nil {
						reconcileStage = "interaction_source_sync"
						_, ensureErr = membership.ReconcileInteractionGroupsOnce(ctx, result.Session)
					}
					if ensureErr == nil {
						reconcileStage = "readiness"
						ready, ensureErr = markReadyAfterMembership(ctx, result.Session, result.Installation)
						// A 409 means required MLS joins are still pending. Keep
						// reconciling membership, but do not call Ready-only bot APIs.
						if ensureErr == nil && ready {
							reconcileStage = "structural_events_and_registration"
							membershipReady = true
							poller, pollerErr := service.NewStructuralEventPoller(nativeClient, service.StructuralEventPollerOptions{})
							if pollerErr != nil {
								ensureErr = pollerErr
							} else {
								handler, handlerErr := newWelcomeHandler(nativeClient, result.Session, api, installation.CommunityID, installation.ID, installation.Capabilities)
								if handlerErr != nil {
									ensureErr = handlerErr
								} else {
									registration, registrationErr := service.NewInteractionRegistrationCoordinator(cfg.InstanceID, installation.CommunityID, installation.ID, nativeClient, api, result.Session)
									if registrationErr != nil {
										ensureErr = registrationErr
									} else if catchup, catchupErr := service.NewMemberRegistrationCatchup(nativeClient, service.MemberRegistrationCatchupOptions{}); catchupErr != nil {
										ensureErr = catchupErr
									} else if registrationMembers, registrationMembersErr := result.Session.CommunityMembers(installation.CommunityID); registrationMembersErr != nil {
										ensureErr = registrationMembersErr
									} else if registrationHandler, registrationHandlerErr := newInteractionRegistrationHandler(registration, installation.ID, registrationMembers); registrationHandlerErr != nil {
										ensureErr = registrationHandlerErr
									} else {
										handler = composeStructuralEventHandlers(handler, registrationHandler)
										pollResult, pollErr := drainStructuralEvents(ctx, func(pollCtx context.Context) (service.StructuralEventPollResult, error) {
											return poller.PollOnce(pollCtx, result.Session, handler)
										})
										var gap *service.StructuralEventGapError
										if errors.As(pollErr, &gap) {
											recovery, recoveryErr := service.NewStructuralGapRecovery(nativeClient, 0)
											if recoveryErr == nil {
												var finished bool
												finished, recoveryErr = finishStructuralGap(ctx, gap,
													func(recoveryCtx context.Context, floor, highWater uint64) (service.StructuralGapRecoveryResult, error) {
														return recovery.StageOnce(recoveryCtx, registrationMembers, registration, floor, highWater)
													},
													func(recoveryCtx context.Context, highWater uint64) error {
														return poller.CompleteGapReconciliation(recoveryCtx, result.Session, highWater)
													})
												if finished {
													pollErr = nil
													pollResult.More = true // Poll events newer than the recovered snapshot next pass.
													logger.Warn("bot structural event history reconciled from current members", "installation_id", installation.ID.String(), "high_water", gap.HighWater)
												}
											}
											if recoveryErr != nil {
												pollErr = recoveryErr
											}
										}
										if pollErr != nil {
											logger.Error("bot structural event dispatch paused", "installation_id", installation.ID.String(), "error", pollErr.Error())
											ensureErr = pollErr
										} else if pollResult.More {
											logger.Info("bot structural event catch-up remains bounded", "installation_id", installation.ID.String(), "acknowledged_through", pollResult.AcknowledgedThrough)
										}
										members, membersErr := result.Session.CommunityMembers(installation.CommunityID)
										if membersErr != nil {
											logger.Info("bot interaction registration worker unavailable", "installation_id", installation.ID.String(), "stage", "member_lookup")
										} else {
											catchupResult, stageErr := catchup.StageOnce(ctx, members, registration)
											if stageErr != nil {
												logger.Info("bot member registration catch-up remains pending", "installation_id", installation.ID.String(), "error", stageErr.Error())
											} else if catchupResult.More {
												logger.Info("bot member registration catch-up remains bounded", "installation_id", installation.ID.String(), "members_visited", catchupResult.MembersVisited, "pages", catchupResult.Pages)
											}
											if workErr := registration.ProcessPending(ctx, 4, 8, members, result.Session); workErr != nil {
												logger.Info("bot interaction registration work remains pending", "installation_id", installation.ID.String(), "error", workErr.Error())
											}
										}
									}
								}
							}
							var musicInteractions *service.MusicInteractions
							var spotifyPCM session.PCMStarter
							var spotifyCatalogResolver service.SpotifyMusicTrackResolver
							if result.Installation.Capabilities&botMusicCapability != 0 {
								channels, channelsErr := result.Session.Channels(ctx, installation.CommunityID)
								if channelsErr == nil {
									var spotifyCredentials *service.SpotifyCredentials
									if cfg.SpotifyClientID != "" && spotifyGuard != nil {
										var credentialErr error
										spotifyCredentials, credentialErr = service.NewSpotifyCredentials(runtime, nativeClient, cfg.SpotifyClientID, cfg.SpotifyRedirectURL, spotifyGuard)
										if credentialErr == nil {
											if _, credentialErr = spotifyCredentials.Load(ctx); credentialErr == nil {
												spotifyCatalogResolver = installationSpotifyCatalogResolver{credentials: spotifyCredentials, catalog: spotify.NewCatalog(nil)}
											} else {
												logger.Info("Spotify catalog enqueue unavailable until this installation links an account", "installation_id", installation.ID.String())
											}
										}
										if credentialErr != nil {
											logger.Info("Spotify catalog enqueue unavailable", "installation_id", installation.ID.String())
											spotifyCredentials = nil
										}
									}
									if cfg.SpotifyHelperExecutable != "" && spotifyGuard != nil {
										if spotifyCredentials == nil {
											spotifyCredentials, _ = service.NewSpotifyCredentials(runtime, nativeClient, cfg.SpotifyClientID, cfg.SpotifyRedirectURL, spotifyGuard)
										}
										var credentialErr error
										if spotifyCredentials != nil {
											spotifyPCM, credentialErr = spotify.NewPCMStarter(cfg.SpotifyHelperExecutable, cfg.StateDir, func(loadCtx context.Context) (string, error) {
												token, loadErr := spotifyCredentials.Load(loadCtx)
												return token.AccessToken, loadErr
											})
										} else {
											credentialErr = service.ErrSpotifyCredentials
										}
										if credentialErr != nil {
											logger.Warn("bot Spotify PCM provider unavailable", "installation_id", installation.ID.String())
										}
									}
									starterFor := func(channel id.ID) (session.QueueStarter, error) {
										joinCallGroup := func(joinCtx context.Context) error {
											communityRow, communityErr := result.Session.Community(joinCtx, installation.CommunityID)
											if communityErr != nil {
												return communityErr
											}
											return ensureMusicCallGroupJoined(joinCtx, result.Session, nativeClient, installation.ID, installation.CommunityID, channel, communityRow.PolicyVersion)
										}
										return newInstallationMusicQueueStarter(cfg.InstanceID, installation.ID, installation.CommunityID, channel, result.Session, nativeClient, spotifyPCM, nil, spotifyLeases, joinCallGroup)
									}
									musicOwnedNative, channelsErr = musicRegistry.ReconcileWithStarterFactory(ctx, installation.ID, installation.CommunityID, result.Installation.Capabilities, channels, nativeClient, starterFor)
								}
								if channelsErr != nil {
									_ = musicRegistry.Disable(installation.ID)
									logger.Error("bot music queue restore paused", "installation_id", installation.ID.String(), "error", channelsErr.Error())
									ensureErr = errors.Join(ensureErr, channelsErr)
								} else {
									var musicErr error
									musicInteractions, musicErr = newRuntimeMusicInteractions(installation.ID, installation.CommunityID, result.Installation.Capabilities, runtime, result.Session, musicRegistry, logger, spotifyCatalogResolver)
									if musicErr != nil {
										logger.Warn("bot music interaction handlers unavailable", "installation_id", installation.ID.String(), "error", musicErr.Error())
									}
								}
							}
							interactionPoller, interactionErr := service.NewGroupEventPoller(nativeClient)
							var scheduler *announcements.Scheduler
							var scheduleErr error
							scheduler, scheduleErr = service.NewAnnouncementScheduler(nativeClient, result.Session, api)
							if scheduleErr != nil {
								interactionErr = errors.Join(interactionErr, scheduleErr)
							}
							if interactionErr == nil {
								var coordinator *service.SendCoordinator
								coordinator, interactionErr = service.NewSendCoordinator(nativeClient, api)
								if interactionErr == nil {
									var outbox *service.InteractionResponseOutbox
									outbox, interactionErr = service.NewInteractionResponseOutbox(nativeClient, coordinator, result.Session)
									if interactionErr == nil {
										var dispatcher *service.InteractionDispatcher
										var snapshots *service.InteractionRegistrationCoordinator
										snapshots, interactionErr = service.NewInteractionRegistrationCoordinator(cfg.InstanceID, installation.CommunityID, installation.ID, nativeClient, api, result.Session)
										if interactionErr == nil {
											moderationRuntime, replayThrough, replayReceivedThrough, caseSink, moderationErr := configureAutoModeration(ctx, autoModerationState, nativeClient, result.Session, installation.ID, installation.CommunityID, logger)
											if moderationErr != nil {
												logger.Warn("bot automatic moderation event intake paused; text events will be acknowledged without action", "installation_id", installation.ID.String(), "error", moderationErr.Error())
											}
											caseReader, interactionErr := service.NewModerationCaseReader(caseSink, result.Session)
											if interactionErr == nil {
												var announcementAuthority *service.CommunityActorAuthority
												announcementAuthority, interactionErr = service.NewCommunityActorAuthority(result.Session, installation.CommunityID, nil)
												if interactionErr == nil {
													handlers := runtimeInteractionHandlers(
														service.OverviewInteractions{Authority: result.Session, CommunityID: installation.CommunityID},
														service.AnnouncementInteractions{Scheduler: scheduler, Authority: announcementAuthority, CommunityID: installation.CommunityID},
														service.ModerationInteractions{Reader: caseReader, CommunityID: installation.CommunityID,
															InstallationID: installation.ID, ManualRemovalLookup: manualRemovalLookup{Session: result.Session},
															EvidenceWriter:      moderation.NewEvidenceWriter(nativeClient),
															EvidenceReader:      moderation.NewEvidenceReader(nativeClient, result.Session),
															ManualWarningLookup: manualWarningLookup{Session: result.Session}},
														musicInteractions,
														nativeClient,
														autoModerationGrantRedeemer{Session: result.Session, InstallationID: installation.ID},
														moderationRuntime,
													)
													for operation, handler := range runtimeRolePanelHandlers(result.Installation.Capabilities, service.RolePanelInteractions{
														Authority:   result.Session,
														Destination: service.WelcomeDestinationResolver{Session: result.Session, Native: nativeClient},
														Sender:      coordinator, Discovery: api, Session: result.Session, CommunityID: installation.CommunityID, Now: time.Now,
													}) {
														handlers[operation] = handler
													}
													dispatcher, interactionErr = service.NewInteractionDispatcherWithSnapshots(nativeClient,
														handlers, func() uint64 { return unixSecondsOrZero(time.Now()) }, snapshots)
												}
											}
											if interactionErr == nil {
												eventHandler := newInteractionEventHandler(nativeClient, dispatcher, durableInteractionResponseSender{api: api, outbox: outbox})
												eventHandler = newGroupEventRouter(nativeClient, eventHandler, moderationRuntime, replayThrough, replayReceivedThrough)
												eventRuntime := newInteractionEventRuntime(interactionPoller, eventHandler)
												var eventResult service.GroupEventPollResult
												eventResult, interactionErr = eventRuntime.Drain(ctx)
												if interactionErr == nil && eventResult.More {
													logger.Info("bot interaction event catch-up remains bounded", "installation_id", installation.ID.String(), "acknowledged_through", eventResult.AcknowledgedThrough)
												}
											}
										}
									}
								}
							}
							if interactionErr != nil {
								reconcileStage = "interaction_events"
								logger.Error("bot interaction event dispatch paused", "installation_id", installation.ID.String(), "error", interactionErr.Error())
								ensureErr = errors.Join(ensureErr, interactionErr)
							}
							if result.Installation.Capabilities&botMusicCapability == 0 {
								if err := musicRegistry.Disable(installation.ID); err != nil {
									logger.Error("bot music runtime cleanup incomplete", "installation_id", installation.ID.String(), "error", err.Error())
								}
							} else {
								if retained := musicRegistry.runtimes[installation.ID]; retained != nil && retained.queues != nil {
									musicQueueCount = retained.queues.Len()
								}
								providers := "youtube"
								if spotifyPCM != nil {
									providers += ",spotify"
								}
								logger.Info("bot music queue metadata retained paused", "installation_id", installation.ID.String(), "voice_channels", musicQueueCount, "configured_pcm_providers", providers)
							}
							if scheduleErr == nil {
								reconcileStage = "scheduled_services"
								scheduleErr = scheduler.RunDue(ctx)
							}
							caseSink, caseErr := service.NewModerationCaseSink(nativeClient, nil, time.Now)
							if caseErr == nil {
								caseErr = maintainModerationEvidence(ctx, logger, installation.ID, caseSink)
							}
							ensureErr = errors.Join(ensureErr, scheduleErr, caseErr)
						}
					}
				}
			}
		}
		if !membershipReady {
			_ = musicRegistry.Disable(installation.ID)
			autoModerationState.Disable(installation.ID)
		}
		if membershipReady && cfg.SpotifyClientID != "" {
			credentials, linkErr := service.NewSpotifyCredentials(runtime, nativeClient, cfg.SpotifyClientID, cfg.SpotifyRedirectURL, spotifyGuard)
			if linkErr == nil {
				linkErr = credentials.ValidateAccount(ctx)
			}
			if linkErr == nil {
				linkErr = credentials.Link(ctx)
			}
			if linkErr != nil && !errors.Is(linkErr, service.ErrSpotifyNoPending) {
				logger.Error("bot Spotify account link needs attention", "installation_id", installation.ID.String(), "error", linkErr.Error())
				ensureErr = errors.Join(ensureErr, linkErr)
			}
		}
		var closeErr error
		if !retainedNative && !musicOwnedNative {
			closeErr = nativeClient.Close()
		}
		if ensureErr != nil || closeErr != nil {
			attrs := []any{"installation_id", installation.ID.String(), "stage", reconcileStage}
			var membershipErr *service.MembershipPhaseError
			if errors.As(ensureErr, &membershipErr) {
				attrs = append(attrs, "membership_phase", membershipErr.Phase.String())
			}
			var trustErr *service.TrustPhaseError
			if errors.As(ensureErr, &trustErr) {
				attrs = append(attrs, "trust_phase", trustErr.Phase.String())
				attrs = append(attrs, safeTrustErrorAttrs(trustErr)...)
			}
			logger.Error("bot installation reconciliation failed", attrs...)
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

func safeTrustErrorAttrs(err error) []any {
	var helperErr *helper.StatusError
	if errors.As(err, &helperErr) {
		name := "other"
		switch helperErr.Status {
		case 1:
			name = "invalid"
		case 2:
			name = "forbidden"
		case 3:
			name = "expired"
		case 4:
			name = "conflict"
		case 5:
			name = "unavailable"
		case 6:
			name = "busy"
		case 7:
			name = "not_found"
		case 8:
			name = "upgrade_required"
		case 9:
			name = "internal"
		}
		return []any{"trust_failure", "native_helper", "helper_status", name}
	}
	var apiErr *client.APIError
	if errors.As(err, &apiErr) {
		code := "other"
		switch apiErr.Code {
		case "E_BAD_INPUT", "E_CONFLICT", "E_FORBIDDEN", "E_INTERNAL", "E_NOT_FOUND", "E_PRUNED", "E_UNAVAILABLE":
			code = apiErr.Code
		}
		return []any{"trust_failure", "api", "api_status", apiErr.Status, "api_code", code}
	}
	return []any{"trust_failure", "other"}
}
