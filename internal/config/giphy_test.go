package config_test

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/config"
)

// E8: the [giphy] table. Off by default (an empty key), the rating defaults to pg-13, and the key
// never reaches a log.
func TestGiphyIsOffByDefaultWithAPG13Rating(t *testing.T) {
	g := config.Default().Giphy
	if g.APIKey != "" || g.Rating != "pg-13" {
		t.Fatalf("defaults = %+v; want no key and rating pg-13", g)
	}
	c, err := loadTestdata(t, "minimal.toml")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Giphy.APIKey != "" || c.Giphy.Rating != "pg-13" {
		t.Fatalf("a file without [giphy] = %+v; want the defaults", c.Giphy)
	}
}

func TestGiphyRatingIsValidated(t *testing.T) {
	c := base()
	c.Instance.PublicIP = netipMustParse(t, "203.0.113.7")
	c.TURN.Enabled = false
	c.LiveKit.APISecretFile = writeSecretFile(t)
	c.Derive()
	for _, ok := range []string{"g", "pg", "pg-13", "r"} {
		c.Giphy.Rating = ok
		if err := c.Validate(); err != nil {
			t.Fatalf("rating %q: Validate = %v, want nil", ok, err)
		}
	}
	c.Giphy.Rating = "x"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "giphy.rating") {
		t.Fatalf("rating x: Validate = %v, want an error naming giphy.rating", err)
	}
}

func TestGiphyKeyNeverReachesTheRedactedLog(t *testing.T) {
	c := config.Default()
	c.Giphy.APIKey = "sekrit-giphy-key"
	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("config", slog.Any("config", c.Redacted()))
	if strings.Contains(buf.String(), "sekrit-giphy-key") {
		t.Fatalf("Redacted leaked the Giphy key: %s", buf.String())
	}
	if !strings.Contains(buf.String(), "giphy_enabled") {
		t.Fatalf("Redacted does not say whether GIFs are on: %s", buf.String())
	}
}

func TestGiphyRoundTripsThroughWriteToAndLoad(t *testing.T) {
	dir := t.TempDir()
	writeSecrets(t, dir)
	t.Chdir(dir)
	c := config.Default()
	c.Instance.Domain = "chat.example"
	c.Instance.PublicIP = netipMustParse(t, "203.0.113.7")
	c.TLS.Agreed = true
	c.TURN.SharedSecretFile = "turn.secret"
	c.TURN.RelayIP = "203.0.113.7"
	c.LiveKit.APISecretFile = "livekit.secret"
	c.Giphy = config.Giphy{APIKey: "k3y", Rating: "g"}
	var buf bytes.Buffer
	if err := c.WriteConfig(&buf); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}
	path := filepath.Join(dir, "written.toml")
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.Giphy != c.Giphy {
		t.Fatalf("giphy = %+v, want %+v", got.Giphy, c.Giphy)
	}
}
