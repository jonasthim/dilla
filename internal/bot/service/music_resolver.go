package service

import (
	"context"
	"log/slog"

	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/youtube"
	"github.com/jonasthim/dilla/internal/id"
)

// LoggingMusicTrackResolver records diagnostics without recording its input.
type LoggingMusicTrackResolver struct {
	Resolver       MusicTrackResolver
	Logger         *slog.Logger
	InstallationID id.ID
}

func (r LoggingMusicTrackResolver) Resolve(ctx context.Context, input string) ([]music.Track, error) {
	logger := r.Logger
	if logger == nil {
		logger = slog.Default()
	}
	ctx = youtube.WithDiagnosticLogger(ctx, logger.With("installation_id", r.InstallationID.String()))
	tracks, err := r.Resolver.Resolve(ctx, input)
	if err != nil {
		logger.WarnContext(ctx, "bot YouTube metadata resolve failed", "installation_id", r.InstallationID.String(), "class", youtube.FailureClass(err), "stderr", youtube.FailureStderr(err))
	}
	return tracks, err
}
