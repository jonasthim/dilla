// Package spotify contains the Go boundary for a Spotify playback helper.
//
// The checked-in librespot probe is not yet a production helper: it reads account
// credentials from a state-directory file and has no inherited-FD credential
// contract or long-lived service protocol. This adapter deliberately refuses to
// start it until that contract exists.
package spotify

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const MaxStatusLine = 4096

var (
	ErrInvalidConfig             = errors.New("spotify: invalid adapter configuration")
	ErrHelperContractUnsupported = errors.New("spotify: helper lacks the required inherited-credential service contract")
)

// Config identifies the pinned helper and an already-open credential descriptor.
// Credential is intentionally never read, serialized, or placed in argv or env by
// this package. The current probe cannot consume it, so Start fails closed.
type Config struct {
	HelperPath string
	StateDir   string
	Credential *os.File
}

type Adapter struct{ config Config }

func New(config Config) (*Adapter, error) {
	if !filepath.IsAbs(config.HelperPath) || !filepath.IsAbs(config.StateDir) || config.Credential == nil {
		return nil, ErrInvalidConfig
	}
	return &Adapter{config: config}, nil
}

// Start is intentionally fail-closed pending a helper protocol that consumes
// credentials through an inherited descriptor and provides persistent playback
// control. The existing probe only supports a credential-file CLI.
func (a *Adapter) Start(ctx context.Context, source string) (*Playback, error) {
	if a == nil || ctx == nil || a.config.Credential == nil || !validTrackSource(source) {
		return nil, ErrInvalidConfig
	}
	return nil, ErrHelperContractUnsupported
}

// Playback is the bounded service-facing control surface planned for a qualified
// helper. It is not constructible while the helper contract remains unsupported.
type Playback struct{}

func (*Playback) Pause(context.Context) error        { return ErrHelperContractUnsupported }
func (*Playback) Resume(context.Context) error       { return ErrHelperContractUnsupported }
func (*Playback) Seek(context.Context, uint32) error { return ErrHelperContractUnsupported }
func (*Playback) Stop(context.Context) error         { return ErrHelperContractUnsupported }

// Status is one sanitized status line emitted by the probe on stderr.
type Status struct {
	Status     string  `json:"status"`
	Phase      string  `json:"phase"`
	State      string  `json:"state"`
	PositionMS *uint32 `json:"position_ms,omitempty"`
}

// ParseStatus reads exactly one bounded JSON line and accepts only known status
// values. This prevents helper diagnostics and credential-like strings from
// crossing into service logs as status fields.
func ParseStatus(r io.Reader) (Status, error) {
	var status Status
	if r == nil {
		return status, errors.New("spotify: invalid status")
	}
	b, err := io.ReadAll(io.LimitReader(r, MaxStatusLine+1))
	if err != nil || len(b) == 0 || len(b) > MaxStatusLine {
		return status, errors.New("spotify: invalid status")
	}
	line := strings.TrimSuffix(strings.TrimSuffix(string(b), "\n"), "\r")
	decoder := json.NewDecoder(strings.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&status); err != nil {
		return Status{}, errors.New("spotify: invalid status")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF || !validStatus(status) {
		return Status{}, errors.New("spotify: invalid status")
	}
	return status, nil
}

func validStatus(s Status) bool {
	if s.Status != "ok" && s.Status != "error" {
		return false
	}
	switch s.Phase {
	case "authorize":
		return s.Status == "ok" && s.State == "pending" && s.PositionMS == nil
	case "authorize-complete":
		return s.Status == "ok" && s.State == "credentials-saved" && s.PositionMS == nil
	case "resolve":
		return s.Status == "ok" && s.State == "complete" && s.PositionMS == nil
	case "play":
		switch s.State {
		case "playing", "paused", "seeked":
			return s.Status == "ok" && s.PositionMS != nil
		case "submitted", "first-pcm-written", "end-of-track":
			return s.Status == "ok" && s.PositionMS == nil
		case "unavailable", "output-unavailable":
			return s.Status == "error" && s.PositionMS == nil
		}
	case "control":
		return s.Status == "ok" && s.State == "submitted" && s.PositionMS == nil
	case "pcm-smoke":
		return s.Status == "ok" && s.State == "first-pcm-written" && s.PositionMS == nil
	case "status":
		return s.Status == "error" && s.State == "unavailable" && s.PositionMS == nil
	}
	return false
}

func validTrackSource(source string) bool {
	const prefix = "spotify:track:"
	if !strings.HasPrefix(source, prefix) {
		return false
	}
	id := strings.TrimPrefix(source, prefix)
	if len(id) != 22 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}
