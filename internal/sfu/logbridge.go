package sfu

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/go-logr/logr"
	"github.com/livekit/protocol/logger"
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

// liveKitSink is the handler the one process-wide LiveKit logger writes through. LiveKit's
// logger.SetLogger assigns two package-level variables without synchronisation, and goroutines left
// over from an earlier in-process server (telemetry queues) read them while they log, so it runs once.
// A later Start swaps the handler here instead.
var (
	liveKitSink atomic.Pointer[slog.Handler]
	liveKitOnce sync.Once
)

// installLiveKitLogger points LiveKit's and pion's logs at next. The first call installs the logger;
// every later call only swaps the handler, so LiveKit's package-level logger is written exactly once.
func installLiveKitLogger(next slog.Handler) {
	if next == nil {
		next = slog.DiscardHandler
	}
	liveKitSink.Store(&next)
	liveKitOnce.Do(func() {
		logger.SetLogger(logger.LogRLogger(logr.FromSlogHandler(NewLogBridge(swapHandler{}))), "livekit")
	})
}

// swapHandler forwards to whatever handler liveKitSink holds at the moment of the call. The attrs and
// groups a logger derived from it carries are replayed onto that handler per record, so a derived
// logger created under one Start follows the next Start's handler too.
type swapHandler struct {
	ops []func(slog.Handler) slog.Handler
}

func (h swapHandler) current() slog.Handler {
	cur := slog.DiscardHandler
	if p := liveKitSink.Load(); p != nil {
		cur = *p
	}
	for _, op := range h.ops {
		cur = op(cur)
	}
	return cur
}

func (h swapHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return h.current().Enabled(ctx, l)
}

func (h swapHandler) Handle(ctx context.Context, r slog.Record) error {
	return h.current().Handle(ctx, r)
}

func (h swapHandler) WithAttrs(as []slog.Attr) slog.Handler {
	return swapHandler{ops: append(slices.Clone(h.ops), func(n slog.Handler) slog.Handler { return n.WithAttrs(as) })}
}

func (h swapHandler) WithGroup(name string) slog.Handler {
	return swapHandler{ops: append(slices.Clone(h.ops), func(n slog.Handler) slog.Handler { return n.WithGroup(name) })}
}
