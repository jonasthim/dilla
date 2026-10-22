package main

import (
	"context"
	"errors"

	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/persistence"
	"github.com/jonasthim/dilla/internal/bot/music/session"
	"github.com/jonasthim/dilla/internal/id"
)

type persistedMusicQueue struct{ store *persistence.Store }

func (p persistedMusicQueue) Load(ctx context.Context, channel id.ID) (music.State, uint64, error) {
	snapshot, err := p.store.Load(ctx, channel)
	return snapshot.State, snapshot.Revision, err
}

func (p persistedMusicQueue) Save(ctx context.Context, channel id.ID, expected uint64, state music.State) (uint64, error) {
	snapshot, err := p.store.Save(ctx, channel, expected, state)
	return snapshot.Revision, err
}

// newMusicSupervisor is the main-package integration point. The caller owns
// provider selection and must build the TrackStarter from configured PCM,
// bounded encoder, call credentials and epoch-bound LiveKit publisher.
func newMusicSupervisor(ctx context.Context, channel id.ID, store *persistence.Store, starter session.QueueStarter) (*music.Supervisor, error) {
	if store == nil || starter.OptionsFor == nil {
		return nil, errors.New("music runtime dependencies unavailable")
	}
	return music.NewSupervisor(ctx, channel, persistedMusicQueue{store: store}, starter)
}
