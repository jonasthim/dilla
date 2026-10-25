package main

import (
	"context"
	"errors"
	"log/slog"
	"os/exec"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/encode"
	"github.com/jonasthim/dilla/internal/bot/music/livekit"
	"github.com/jonasthim/dilla/internal/bot/music/persistence"
	"github.com/jonasthim/dilla/internal/bot/music/session"
	"github.com/jonasthim/dilla/internal/bot/music/spotify"
	"github.com/jonasthim/dilla/internal/bot/music/youtube"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/bot/spotifyauth"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

const (
	musicVoiceChannelKind = 1
	maxMusicSupervisors   = 512
	botMusicCapability    = 1 << 0 // protocol/10-community-bot.md: capability bit 0
)

var errMusicPCMUnavailable = errors.New("music PCM provider is unavailable")

// musicSnapshotCommitCallback hands a committed revision to the retained
// supervisor. Only an explicit Resume or a Skip that continues existing playback starts audio.
func musicSnapshotCommitCallback(registry *musicQueueRegistry, logger *slog.Logger) func(context.Context, id.ID, id.ID, id.ID, music.State, uint64, bool) (uint64, error) {
	if logger == nil {
		logger = slog.Default()
	}
	return func(ctx context.Context, installation, community, channel id.ID, state music.State, revision uint64, startPlayback bool) (uint64, error) {
		appliedRevision, err := registry.ApplyPersistedSnapshot(ctx, installation, community, channel, state, revision, startPlayback)
		if err != nil {
			logger.Warn("persisted music queue snapshot could not refresh retained runtime", "installation_id", installation.String(), "community_id", community.String(), "channel_id", channel.String(), "revision", revision, "error", err.Error())
		}
		return appliedRevision, err
	}
}

type musicQueueRuntime struct {
	mu          sync.Mutex
	supervisors map[id.ID]*music.Supervisor
	community   id.ID
	store       *persistence.Store
	closed      bool
}

func (r *musicQueueRuntime) Close() error {
	if r != nil {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.closed = true
		closeMusicSupervisors(r.supervisors)
		r.supervisors = make(map[id.ID]*music.Supervisor)
	}
	return nil
}

func (r *musicQueueRuntime) Len() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.supervisors)
}

func (r *musicQueueRuntime) CurrentState(ctx context.Context, channel id.ID) (music.State, uint64, error) {
	if ctx == nil || channel.IsZero() {
		return music.State{}, 0, errors.New("music runtime dependencies unavailable")
	}
	if err := ctx.Err(); err != nil {
		return music.State{}, 0, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return music.State{}, 0, music.ErrSupervisorClosed
	}
	supervisor := r.supervisors[channel]
	if supervisor == nil {
		return music.State{}, 0, errors.New("music voice session is unavailable")
	}
	state := supervisor.State()
	return state, state.Revision, nil
}

// ApplyPersistedSnapshot hands an exact committed revision to its retained
// supervisor. Only an explicit Resume or active Skip may start playback.
func (r *musicQueueRuntime) ApplyPersistedSnapshot(ctx context.Context, channel id.ID, committed music.State, expectedRevision uint64, startPlayback bool) (uint64, error) {
	if ctx == nil || channel.IsZero() {
		return 0, errors.New("music runtime dependencies unavailable")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.store == nil {
		return 0, music.ErrSupervisorClosed
	}
	current := r.supervisors[channel]
	if current == nil {
		return 0, errors.New("music voice session is unavailable")
	}
	return current.ApplyPersistedSnapshot(ctx, committed, expectedRevision, startPlayback)
}

type musicCallStarter interface {
	StartCall(context.Context, id.ID) (client.Call, error)
}

type installationMusicNative interface {
	Binding() native.Binding
	livekit.EpochSource
}

type installationSpotifyCredentials interface {
	Load(context.Context) (spotifyauth.Token, error)
}

type installationSpotifyCatalogResolver struct {
	credentials installationSpotifyCredentials
	catalog     *spotify.Catalog
}

func (r installationSpotifyCatalogResolver) ResolveSpotify(ctx context.Context, input string, requester id.ID) ([]music.Track, error) {
	if r.credentials == nil || r.catalog == nil {
		return nil, service.ErrSpotifyCredentials
	}
	token, err := r.credentials.Load(ctx)
	if err != nil {
		return nil, err
	}
	return r.catalog.Expand(ctx, token.AccessToken, input, requester)
}

// musicRuntimeDeps contains the process-wide dependencies and the channel
// identity for one supervisor. Each supervisor gets its own queue/session
// state; SpotifyLease is shared by all supervisors in this service process.
type musicRuntimeDeps struct {
	Community, Channel id.ID
	Calls              musicCallStarter
	JoinCallGroup      func(context.Context) error
	SpotifyPCM         session.PCMStarter
	YouTubePCM         youtube.PCMSourceStarter
	LeaseManager       *music.SpotifyLeaseManager
	Encoder            session.EncoderStarter
	Publisher          session.PublisherStarter
	Epochs             livekit.EpochSource
	Lifetime           time.Duration
}

// newMusicQueueStarter resolves each queue item at playback time so the call
// credentials are fresh and bound to that item's voice channel. Provider PCM
// implementations are injected so this wiring cannot silently claim that a
// metadata-only YouTube resolver provides live audio.
func newMusicQueueStarter(deps musicRuntimeDeps) (session.QueueStarter, error) {
	if deps.Community.IsZero() || deps.Channel.IsZero() || deps.Calls == nil ||
		deps.Encoder == nil || deps.Epochs == nil || deps.Lifetime <= 0 || deps.Lifetime > 30*time.Minute {
		return session.QueueStarter{}, errors.New("music runtime dependencies unavailable")
	}
	publisher := deps.Publisher
	var resetConnection, closeConnection func() error
	if publisher == nil {
		pool, err := livekit.NewPool(deps.Lifetime)
		if err != nil {
			return session.QueueStarter{}, err
		}
		publisher = session.RetainedLiveKitPublisher{Pool: pool}
		resetConnection, closeConnection = pool.Reset, pool.Close
	}
	options := func(ctx context.Context, track music.Track) (session.Options, error) {
		if ctx == nil || track.CanonicalID == "" {
			return session.Options{}, session.ErrInvalid
		}
		var pcm session.PCMStarter
		switch track.Provider {
		case music.ProviderSpotify:
			pcm = deps.SpotifyPCM
		case music.ProviderYouTube:
			pcm = session.YouTubePCM{Source: deps.YouTubePCM}
		default:
			return session.Options{}, session.ErrInvalid
		}
		if pcm == nil {
			return session.Options{}, session.ErrInvalid
		}
		if track.Provider == music.ProviderSpotify && deps.LeaseManager == nil {
			return session.Options{}, session.ErrInvalid
		}
		if deps.JoinCallGroup != nil {
			if err := deps.JoinCallGroup(ctx); err != nil {
				return session.Options{}, err
			}
		}
		call, err := deps.Calls.StartCall(ctx, deps.Channel)
		if err != nil {
			return session.Options{}, err
		}
		if call.CallID.IsZero() || call.GroupID.IsZero() || call.CallID != deps.Channel ||
			call.LiveKitURL == "" || call.Token == "" {
			return session.Options{}, session.ErrInvalid
		}
		var acquire session.LeaseAcquire
		if track.Provider == music.ProviderSpotify {
			acquire = session.AcquireSpotify(deps.LeaseManager)
		}
		return session.Options{
			Community: deps.Community, Channel: deps.Channel, Provider: track.Provider,
			Track: track.CanonicalID, Call: call, Group: call.GroupID,
			Acquire: acquire, PCM: pcm,
			Encoder: deps.Encoder, Publisher: publisher, Epochs: deps.Epochs,
		}, nil
	}
	return session.QueueStarter{OptionsFor: options, ResetConnection: resetConnection, CloseConnection: closeConnection}, nil
}

func newInstallationYouTubeQueueStarter(instance, installation, community, channel id.ID, calls *client.Session, source installationMusicNative) (session.QueueStarter, error) {
	return newInstallationMusicQueueStarter(instance, installation, community, channel, calls, source, nil, nil, nil)
}

func newInstallationMusicQueueStarter(instance, installation, community, channel id.ID, calls *client.Session, source installationMusicNative, spotifyPCM session.PCMStarter, youtubeSource youtube.PCMSourceStarter, leases *music.SpotifyLeaseManager, joinCallGroup ...func(context.Context) error) (session.QueueStarter, error) {
	if instance.IsZero() || installation.IsZero() || community.IsZero() || channel.IsZero() || calls == nil || source == nil || calls.InstanceID() != instance {
		return session.QueueStarter{}, errors.New("music runtime dependencies unavailable")
	}
	binding := source.Binding()
	if binding.Instance != instance || binding.Installation != installation || binding.Community != community {
		return session.QueueStarter{}, errors.New("music native binding does not match installation")
	}
	var join func(context.Context) error
	if len(joinCallGroup) > 1 {
		return session.QueueStarter{}, errors.New("music call-group join configuration is invalid")
	}
	if len(joinCallGroup) == 1 {
		join = joinCallGroup[0]
	}
	return newMusicQueueStarter(musicRuntimeDeps{
		Community: community, Channel: channel, Calls: calls,
		JoinCallGroup: join,
		SpotifyPCM:    spotifyPCM,
		YouTubePCM: func() youtube.PCMSourceStarter {
			if youtubeSource != nil {
				return youtubeSource
			}
			return youtube.PCMStarter{YTDLP: "yt-dlp", FFmpeg: "ffmpeg", Node: "node"}
		}(),
		LeaseManager: leases,
		Encoder: session.RuntimeEncoder{Config: session.EncoderConfig{
			Capacity: 50, Options: encode.Options{FFmpegPath: "ffmpeg"},
		}},
		Epochs: source, Lifetime: 30 * time.Minute,
	})
}

type persistedMusicQueue struct{ store *persistence.Store }

func (p persistedMusicQueue) Load(ctx context.Context, channel id.ID) (music.State, uint64, error) {
	snapshot, err := p.store.Load(ctx, channel)
	return snapshot.State, snapshot.Revision, err
}

func (p persistedMusicQueue) Save(ctx context.Context, channel id.ID, expected uint64, state music.State) (uint64, error) {
	snapshot, err := p.store.Save(ctx, channel, expected, state)
	return snapshot.Revision, err
}

// runtimeMusicAuthorityStore resolves installation and DJ policy from current
// bot APIs on every authorization check. It never falls back to cached roles.
type runtimeMusicAuthorityStore struct {
	runtime      *client.Runtime
	session      *client.Session
	installation id.ID
	community    id.ID
}

func newRuntimeMusicInteractions(installation, community id.ID, capabilities uint64, runtime *client.Runtime, session *client.Session, registry *musicQueueRegistry, logger *slog.Logger, spotifyResolvers ...service.SpotifyMusicTrackResolver) (*service.MusicInteractions, error) {
	if capabilities&botMusicCapability == 0 {
		return nil, nil
	}
	if installation.IsZero() || community.IsZero() || runtime == nil || session == nil || registry == nil {
		return nil, errors.New("music interaction authority or queue store unavailable")
	}
	stateStore, ok := registry.QueueStore(installation, community)
	if !ok {
		return nil, errors.New("encrypted music queue store unavailable")
	}
	authority := &service.CommunityMusicInteractionAuthority{
		Session:        session,
		Store:          runtimeMusicAuthorityStore{runtime: runtime, session: session, installation: installation, community: community},
		InstallationID: installation, CommunityID: community,
	}
	handlers := &service.MusicInteractions{
		Store: stateStore, Authority: authority,
		InstallationID: installation, CommunityID: community,
		CurrentState:        registry.CurrentState,
		OnPersistedSnapshot: musicSnapshotCommitCallback(registry, logger),
	}
	if len(spotifyResolvers) > 0 {
		handlers.SpotifyResolver = spotifyResolvers[0]
	}
	if resolver, err := newYouTubeMetadataResolver(); err == nil {
		handlers.Resolver = resolver
	} else if logger != nil {
		logger.Info("YouTube music search and enqueue are unavailable", "installation_id", installation.String(), "error", err.Error())
	}
	return handlers, nil
}

func newYouTubeMetadataResolver() (youtube.MetadataResolver, error) {
	ytdlp, err := exec.LookPath("yt-dlp")
	if err != nil {
		return youtube.MetadataResolver{}, err
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return youtube.MetadataResolver{}, err
	}
	bubblewrap, err := exec.LookPath("bwrap")
	if err != nil {
		return youtube.MetadataResolver{}, err
	}
	python, err := exec.LookPath("python3")
	if err != nil {
		return youtube.MetadataResolver{}, err
	}
	return youtube.NewMetadataResolver(ytdlp, node, bubblewrap, python)
}

func (s runtimeMusicAuthorityStore) GetActiveBotInstallationByCommunity(ctx context.Context, community id.ID) (store.BotInstallationRow, error) {
	if s.runtime == nil || community.IsZero() || community != s.community {
		return store.BotInstallationRow{}, store.ErrNotFound
	}
	installations, err := s.runtime.ListInstallations(ctx)
	if err != nil {
		return store.BotInstallationRow{}, err
	}
	var found *client.Installation
	for i := range installations {
		if installations[i].CommunityID != community {
			continue
		}
		if found != nil {
			return store.BotInstallationRow{}, errors.New("multiple runtime installations found for community")
		}
		found = &installations[i]
	}
	if found == nil {
		return store.BotInstallationRow{}, store.ErrNotFound
	}
	if found.ID != s.installation || found.State > 255 || found.Capabilities > 255 {
		return store.BotInstallationRow{}, store.ErrNotFound
	}
	return store.BotInstallationRow{ID: found.ID, CommunityID: found.CommunityID, State: uint8(found.State), Capabilities: uint8(found.Capabilities)}, nil
}

func (s runtimeMusicAuthorityStore) ListDJRolePolicy(ctx context.Context, installation id.ID) ([]store.DJRolePolicyRow, error) {
	if s.session == nil || installation.IsZero() || installation != s.installation {
		return nil, errors.New("music DJ policy session unavailable")
	}
	policy, err := s.session.MusicDJRolePolicy(ctx, installation)
	if err != nil {
		return nil, err
	}
	if policy.CommunityID != s.community || policy.InstallationID != s.installation || policy.Capabilities&botMusicCapability == 0 {
		return nil, errors.New("music DJ policy binding changed")
	}
	rows := make([]store.DJRolePolicyRow, len(policy.RoleIDs))
	for i, role := range policy.RoleIDs {
		rows[i] = store.DJRolePolicyRow{InstallationID: installation, RoleID: role}
	}
	return rows, nil
}

// newMusicSupervisor is the per-channel persistence integration point.
func newMusicSupervisor(ctx context.Context, channel id.ID, store *persistence.Store, starter session.QueueStarter) (*music.Supervisor, error) {
	if store == nil || starter.OptionsFor == nil {
		return nil, errors.New("music runtime dependencies unavailable")
	}
	return music.NewSupervisor(ctx, channel, persistedMusicQueue{store: store}, starter)
}

// restoreMusicSupervisors binds one paused queue supervisor to each voice
// channel in an installation. Its caller owns and closes the returned set.
func restoreMusicSupervisors(ctx context.Context, community id.ID, channels []client.Channel, store *persistence.Store, starter session.QueueStarter) (*musicQueueRuntime, error) {
	return restoreMusicSupervisorsWithStarterFactory(ctx, community, channels, store, func(id.ID) (session.QueueStarter, error) { return starter, nil })
}

type musicStarterFactory func(id.ID) (session.QueueStarter, error)

func restoreMusicSupervisorsWithStarterFactory(ctx context.Context, community id.ID, channels []client.Channel, store *persistence.Store, starterFor musicStarterFactory) (*musicQueueRuntime, error) {
	if ctx == nil || community.IsZero() || store == nil || starterFor == nil || len(channels) > maxMusicSupervisors*2 {
		return nil, errors.New("music runtime dependencies unavailable")
	}
	runtime := &musicQueueRuntime{supervisors: make(map[id.ID]*music.Supervisor), community: community, store: store}
	seen := make(map[id.ID]struct{}, len(channels))
	for _, channel := range channels {
		if channel.ID.IsZero() || channel.CommunityID != community {
			_ = runtime.Close()
			return nil, errors.New("music channel inventory is invalid")
		}
		if _, ok := seen[channel.ID]; ok {
			_ = runtime.Close()
			return nil, errors.New("music channel inventory is invalid")
		}
		seen[channel.ID] = struct{}{}
		if channel.Kind != musicVoiceChannelKind {
			continue
		}
		if len(runtime.supervisors) == maxMusicSupervisors {
			_ = runtime.Close()
			return nil, errors.New("music voice channel limit exceeded")
		}
		starter, err := starterFor(channel.ID)
		if err != nil || starter.OptionsFor == nil {
			_ = runtime.Close()
			if err != nil {
				return nil, err
			}
			return nil, errors.New("music runtime dependencies unavailable")
		}
		supervisor, err := newMusicSupervisor(ctx, channel.ID, store, starter)
		if err != nil {
			_ = runtime.Close()
			return nil, err
		}
		runtime.supervisors[channel.ID] = supervisor
	}
	return runtime, nil
}

type musicRuntimeNative interface {
	persistence.Native
	Close() error
}

type retainedMusicRuntime struct {
	community id.ID
	queues    *musicQueueRuntime
	native    musicRuntimeNative
}

// musicQueueRegistry keeps queue supervisors attached to the native helper
// that backs their persistence store across reconciliation iterations.
type musicQueueRegistry struct {
	mu       sync.Mutex
	runtimes map[id.ID]*retainedMusicRuntime
}

func newMusicQueueRegistry() *musicQueueRegistry {
	return &musicQueueRegistry{runtimes: make(map[id.ID]*retainedMusicRuntime)}
}

func (r *musicQueueRegistry) Native(installation, community id.ID) musicRuntimeNative {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	retained := r.runtimes[installation]
	if retained == nil {
		return nil
	}
	if retained.community != community {
		_ = r.disableLocked(installation)
		return nil
	}
	return retained.native
}

func (r *musicQueueRegistry) QueueStore(installation, community id.ID) (*persistence.Store, bool) {
	if r == nil {
		return nil, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	retained := r.runtimes[installation]
	if retained == nil || retained.community != community || retained.queues == nil || retained.queues.store == nil {
		return nil, false
	}
	return retained.queues.store, true
}

func (r *musicQueueRegistry) CurrentState(ctx context.Context, installation, community, channel id.ID) (music.State, uint64, error) {
	if r == nil {
		return music.State{}, 0, errors.New("music voice session is unavailable")
	}
	r.mu.Lock()
	retained := r.runtimes[installation]
	if retained == nil || retained.community != community || retained.queues == nil {
		r.mu.Unlock()
		return music.State{}, 0, errors.New("music voice session is unavailable")
	}
	queues := retained.queues
	r.mu.Unlock()
	return queues.CurrentState(ctx, channel)
}

// ApplyPersistedSnapshot is the runtime bridge for queue mutations already
// authorized and committed by the interaction service. A missing registry
// entry means the capability or retained native session has been torn down.
func (r *musicQueueRegistry) ApplyPersistedSnapshot(ctx context.Context, installation, community, channel id.ID, state music.State, revision uint64, startPlayback bool) (uint64, error) {
	if r == nil {
		return 0, errors.New("music voice session is unavailable")
	}
	r.mu.Lock()
	retained := r.runtimes[installation]
	if retained == nil || retained.community != community || retained.queues == nil {
		r.mu.Unlock()
		return 0, errors.New("music voice session is unavailable")
	}
	r.mu.Unlock()
	return retained.queues.ApplyPersistedSnapshot(ctx, channel, state, revision, startPlayback)
}

// Reconcile returns true only when ownership of nativeClient transfers to the
// registry. A capability loss closes both the retained supervisors and helper.
func (r *musicQueueRegistry) Reconcile(ctx context.Context, installation, community id.ID, capabilities uint64, channels []client.Channel, nativeClient musicRuntimeNative, starter session.QueueStarter) (bool, error) {
	return r.ReconcileWithStarterFactory(ctx, installation, community, capabilities, channels, nativeClient, func(id.ID) (session.QueueStarter, error) { return starter, nil })
}

func (r *musicQueueRegistry) ReconcileWithStarterFactory(ctx context.Context, installation, community id.ID, capabilities uint64, channels []client.Channel, nativeClient musicRuntimeNative, starterFor musicStarterFactory) (bool, error) {
	if r == nil || installation.IsZero() || community.IsZero() || nativeClient == nil || starterFor == nil {
		return false, errors.New("music runtime dependencies unavailable")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if capabilities&botMusicCapability == 0 {
		return false, r.disableLocked(installation)
	}
	if binding := nativeClient.Binding(); binding.Installation != installation || binding.Community != community {
		_ = r.disableLocked(installation)
		return false, errors.New("music native binding does not match installation")
	}
	if existing := r.runtimes[installation]; existing != nil {
		if existing.community != community {
			_ = r.disableLocked(installation)
		} else {
			if existing.queues == nil {
				queues, err := restoreMusicQueuesIfEnabledWithStarterFactory(ctx, community, capabilities, func(context.Context, id.ID) ([]client.Channel, error) { return channels, nil }, nativeClient, starterFor)
				if err != nil {
					return false, err
				}
				existing.queues = queues
				return false, nil
			}
			if err := syncMusicSupervisorsWithStarterFactory(ctx, existing.queues, channels, starterFor); err != nil {
				_ = r.pauseMusicLocked(installation)
				return false, err
			}
			return false, nil
		}
	}
	queues, err := restoreMusicQueuesIfEnabledWithStarterFactory(ctx, community, capabilities, func(context.Context, id.ID) ([]client.Channel, error) { return channels, nil }, nativeClient, starterFor)
	if err != nil {
		return false, err
	}
	if queues == nil {
		return false, nil
	}
	r.runtimes[installation] = &retainedMusicRuntime{community: community, queues: queues, native: nativeClient}
	return true, nil
}

func syncMusicSupervisorsWithStarterFactory(ctx context.Context, runtime *musicQueueRuntime, channels []client.Channel, starterFor musicStarterFactory) error {
	if ctx == nil || runtime == nil || runtime.store == nil || starterFor == nil || len(channels) > maxMusicSupervisors*2 {
		return errors.New("music runtime dependencies unavailable")
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closed {
		return music.ErrSupervisorClosed
	}
	desired := make(map[id.ID]struct{}, len(channels))
	seen := make(map[id.ID]struct{}, len(channels))
	for _, channel := range channels {
		if channel.ID.IsZero() || channel.CommunityID != runtime.community {
			return errors.New("music channel inventory is invalid")
		}
		if _, ok := seen[channel.ID]; ok {
			return errors.New("music channel inventory is invalid")
		}
		seen[channel.ID] = struct{}{}
		if channel.Kind == musicVoiceChannelKind {
			desired[channel.ID] = struct{}{}
		}
	}
	if len(desired) > maxMusicSupervisors {
		return errors.New("music voice channel limit exceeded")
	}
	for channel, supervisor := range runtime.supervisors {
		if _, ok := desired[channel]; !ok {
			_ = supervisor.Close()
			delete(runtime.supervisors, channel)
		}
	}
	for _, channel := range channels {
		if _, ok := desired[channel.ID]; !ok {
			continue
		}
		if runtime.supervisors[channel.ID] != nil {
			delete(desired, channel.ID)
			continue
		}
		starter, err := starterFor(channel.ID)
		if err != nil || starter.OptionsFor == nil {
			if err != nil {
				return err
			}
			return errors.New("music runtime dependencies unavailable")
		}
		supervisor, err := newMusicSupervisor(ctx, channel.ID, runtime.store, starter)
		if err != nil {
			closeMusicSupervisors(runtime.supervisors)
			runtime.supervisors = make(map[id.ID]*music.Supervisor)
			return err
		}
		runtime.supervisors[channel.ID] = supervisor
	}
	return nil
}

func (r *musicQueueRegistry) Disable(installation id.ID) error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.disableLocked(installation)
}

func (r *musicQueueRegistry) disableLocked(installation id.ID) error {
	if r.runtimes[installation] == nil {
		return nil
	}
	retained := r.runtimes[installation]
	delete(r.runtimes, installation)
	if retained.queues != nil {
		_ = retained.queues.Close()
	}
	return retained.native.Close()
}

// pauseMusicLocked disables only queue state after a recoverable music error.
// The native helper also serves non-music interactions, so it stays retained.
func (r *musicQueueRegistry) pauseMusicLocked(installation id.ID) error {
	retained := r.runtimes[installation]
	if retained == nil || retained.queues == nil {
		return nil
	}
	queues := retained.queues
	retained.queues = nil
	return queues.Close()
}

func (r *musicQueueRegistry) RetainOnly(installations []id.ID) error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	active := make(map[id.ID]struct{}, len(installations))
	for _, installation := range installations {
		active[installation] = struct{}{}
	}
	var errs []error
	for installation := range r.runtimes {
		if _, ok := active[installation]; !ok {
			if err := r.disableLocked(installation); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

func (r *musicQueueRegistry) Close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	var errs []error
	for installation := range r.runtimes {
		if err := r.disableLocked(installation); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func restoreMusicQueuesIfEnabled(ctx context.Context, community id.ID, capabilities uint64, loadChannels func(context.Context, id.ID) ([]client.Channel, error), stateNative persistence.Native, starter session.QueueStarter) (*musicQueueRuntime, error) {
	return restoreMusicQueuesIfEnabledWithStarterFactory(ctx, community, capabilities, loadChannels, stateNative, func(id.ID) (session.QueueStarter, error) { return starter, nil })
}

func restoreMusicQueuesIfEnabledWithStarterFactory(ctx context.Context, community id.ID, capabilities uint64, loadChannels func(context.Context, id.ID) ([]client.Channel, error), stateNative persistence.Native, starterFor musicStarterFactory) (*musicQueueRuntime, error) {
	if capabilities&botMusicCapability == 0 {
		return nil, nil
	}
	if loadChannels == nil || stateNative == nil {
		return nil, errors.New("music runtime dependencies unavailable")
	}
	channels, err := loadChannels(ctx, community)
	if err != nil {
		return nil, err
	}
	store, err := persistence.New(stateNative, community)
	if err != nil {
		return nil, err
	}
	return restoreMusicSupervisorsWithStarterFactory(ctx, community, channels, store, starterFor)
}

func closeMusicSupervisors(queues map[id.ID]*music.Supervisor) {
	for _, supervisor := range queues {
		_ = supervisor.Close()
	}
}

func unavailableMusicQueueStarter() session.QueueStarter {
	return session.QueueStarter{OptionsFor: func(context.Context, music.Track) (session.Options, error) {
		return session.Options{}, errMusicPCMUnavailable
	}}
}

var _ livekit.EpochSource = (*native.Client)(nil)
