package sfu

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
)

// NewLogBridge is the slog handler LiveKit's and pion's logs go through (b.8). logr names arrive as
// one "logger" attribute joined with "/" (livekit/transport/pion.ice); pion's components no longer
// honour logging.pion_level, so their records below ERROR are dropped here. The participant
// identity — a dilla device id that LiveKit's redactor passes whole — becomes device_id, and
// LiveKit's participant session id becomes participant_id, both shortened like every *_id.
func NewLogBridge(next slog.Handler) slog.Handler {
	if next == nil {
		next = slog.DiscardHandler
	}
	return logBridge{next: next}
}

type logBridge struct{ next slog.Handler }

func (b logBridge) Enabled(ctx context.Context, l slog.Level) bool { return b.next.Enabled(ctx, l) }

func (b logBridge) Handle(ctx context.Context, r slog.Record) error {
	out := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	pion := false
	r.Attrs(func(a slog.Attr) bool {
		if a.Key == "logger" && strings.Contains(a.Value.String(), "/pion.") {
			pion = true
		}
		out.AddAttrs(rename(a))
		return true
	})
	if pion && r.Level < slog.LevelError {
		return nil
	}
	return b.next.Handle(ctx, out)
}

func (b logBridge) WithAttrs(as []slog.Attr) slog.Handler {
	renamed := make([]slog.Attr, 0, len(as))
	for _, a := range as {
		renamed = append(renamed, rename(a))
	}
	return logBridge{next: b.next.WithAttrs(renamed)}
}

func (b logBridge) WithGroup(name string) slog.Handler {
	return logBridge{next: b.next.WithGroup(name)}
}

func rename(a slog.Attr) slog.Attr {
	switch a.Key {
	case "participant":
		return slog.String("device_id", short(a.Value))
	case "participantID":
		return slog.String("participant_id", short(a.Value))
	}
	return a
}

// short is the first eight characters of an identifier, as dillad's redactor logs every *_id.
func short(v slog.Value) string {
	s := fmt.Sprint(v.Resolve().Any())
	if len(s) > 8 {
		return s[:8]
	}
	return s
}
