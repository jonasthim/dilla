package spotify

import (
	"errors"
	"os"
	"strings"
	"testing"
)

func TestStartFailsClosedWhenHelperCannotConsumeInheritedCredentialFD(t *testing.T) {
	secret, err := os.CreateTemp(t.TempDir(), "spotify-secret")
	if err != nil {
		t.Fatal(err)
	}
	defer secret.Close()
	if _, err := secret.WriteString("private-token"); err != nil {
		t.Fatal(err)
	}

	adapter, err := New(Config{HelperPath: "/pinned/librespot-helper", StateDir: "/var/lib/dilla/spotify", Credential: secret})
	if err != nil {
		t.Fatal(err)
	}
	_, err = adapter.Start(t.Context(), "spotify:track:0123456789012345678901")
	if !errors.Is(err, ErrHelperContractUnsupported) {
		t.Fatalf("Start() error = %v, want %v", err, ErrHelperContractUnsupported)
	}
	if strings.Contains(strings.ToLower(err.Error()), "private-token") {
		t.Fatal("error exposed credential material")
	}
}

func TestStartRejectsNonTrackOrNoncanonicalSourceBeforeHelperContractCheck(t *testing.T) {
	secret, err := os.CreateTemp(t.TempDir(), "spotify-secret")
	if err != nil {
		t.Fatal(err)
	}
	defer secret.Close()
	adapter, err := New(Config{HelperPath: "/pinned/librespot-helper", StateDir: "/var/lib/dilla/spotify", Credential: secret})
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{
		"spotify:playlist:0123456789012345678901",
		"spotify:track:012345678901234567890",
		"spotify:track:0123456789012345678901?x=y",
	} {
		if _, err := adapter.Start(t.Context(), source); !errors.Is(err, ErrInvalidConfig) {
			t.Errorf("Start(%q) error = %v, want %v", source, err, ErrInvalidConfig)
		}
	}
}

func TestParseStatusAcceptsOnlyBoundedKnownStatus(t *testing.T) {
	got, err := ParseStatus(strings.NewReader(`{"status":"ok","phase":"play","state":"playing","position_ms":1250}` + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "ok" || got.Phase != "play" || got.State != "playing" || got.PositionMS == nil || *got.PositionMS != 1250 {
		t.Fatalf("ParseStatus() = %#v", got)
	}
}

func TestParseStatusRejectsOversizedUnknownOrMalformedLines(t *testing.T) {
	for _, input := range []string{
		strings.Repeat("x", MaxStatusLine+1) + "\n",
		`{"status":"ok","phase":"play","state":"playing","extra":"x"}` + "\n",
		`{"status":"ok","phase":"play","state":"playing","position_ms":-1}` + "\n",
		`{"status":"ok","phase":"play","state":"playing"}` + "\n",
		`{"status":"ok","phase":"status","state":"private-token","position_ms":1}` + "\n",
		`{"status":"ok","phase":"secret","state":"token=abc"}` + "\n",
		`{"status":"ok","phase":"play","state":"playing"} trailing` + "\n",
	} {
		if _, err := ParseStatus(strings.NewReader(input)); err == nil {
			t.Fatalf("ParseStatus accepted %q", input[:min(len(input), 80)])
		}
	}
}
