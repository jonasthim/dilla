package sfu

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/go-logr/logr"
	"github.com/livekit/protocol/logger"
)

func bridged(t *testing.T) (logger.Logger, *bytes.Buffer) {
	t.Helper()
	var buf bytes.Buffer
	h := NewLogBridge(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	return logger.LogRLogger(logr.FromSlogHandler(h)).WithName("livekit"), &buf
}

func records(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var r map[string]any
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatalf("not JSON: %q", line)
		}
		out = append(out, r)
	}
	return out
}

// pion's components log through the generic factory and logging.pion_level no longer applies
// (b.8): below ERROR they are dropped here, at ERROR they are kept.
func TestTheBridgeDropsPionChatterBelowError(t *testing.T) {
	l, buf := bridged(t)
	ice := l.WithName("transport").WithName("pion.ice")
	ice.Infow("checking candidate pair")
	ice.Warnw("binding request timed out", errors.New("timeout"))
	ice.Errorw("ICE failed", errors.New("no pair"))
	l.Infow("room created", "room", "r1")
	got := records(t, buf)
	if len(got) != 2 {
		t.Fatalf("%d records, want the pion ERROR and the LiveKit INFO: %v", len(got), got)
	}
	if got[0]["msg"] != "ICE failed" || got[0]["logger"] != "livekit/transport/pion.ice" {
		t.Errorf("first record %v, want pion's ERROR", got[0])
	}
	if got[1]["msg"] != "room created" {
		t.Errorf("second record %v, want LiveKit's INFO", got[1])
	}
}

// The participant identity is a device id and LiveKit's redactor passes it whole: the bridge
// renames it so dillad's redactor shortens it like every *_id.
func TestTheBridgeRenamesParticipantKeys(t *testing.T) {
	l, buf := bridged(t)
	l.WithValues("participantID", "PA_abcdefgh123").Infow("joined", "participant", "0123456789abcdef0123456789abcdef")
	got := records(t, buf)
	if len(got) != 1 {
		t.Fatalf("%d records", len(got))
	}
	r := got[0]
	if r["device_id"] != "01234567" || r["participant_id"] != "PA_abcde" {
		t.Errorf("record %v: want device_id 01234567 and participant_id PA_abcde", r)
	}
	if _, ok := r["participant"]; ok {
		t.Errorf("record %v still carries participant", r)
	}
}
