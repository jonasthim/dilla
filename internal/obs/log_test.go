package obs_test

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/obs"
)

func TestRedactorReplacesSecretKeysAtEveryDepth(t *testing.T) {
	var buf bytes.Buffer
	log := obs.NewLogger(config.Log{Level: "info", Format: "json"}, &buf)
	log.Info("login",
		slog.String("token", "supersecret"),
		slog.String("username", "jonas"),
		slog.Group("inner",
			slog.String("password", "hunter2"),
			slog.String("route", "/v1/auth/password/login"),
			slog.Group("deeper", slog.String("phc", "$argon2id$v=19$m=19456,t=2,p=1$abc$def"))),
	)
	out := buf.String()
	for _, secret := range []string{"supersecret", "hunter2", "argon2id"} {
		if strings.Contains(out, secret) {
			t.Fatalf("redactor let %q through: %s", secret, out)
		}
	}
	for _, kept := range []string{"jonas", "/v1/auth/password/login"} {
		if !strings.Contains(out, kept) {
			t.Fatalf("redactor dropped a non-secret attribute %q: %s", kept, out)
		}
	}
	var line map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &line); err != nil {
		t.Fatalf("output is not one JSON object: %v", err)
	}
}

func TestAConfigNeverReachesTheLogWithItsSecrets(t *testing.T) {
	var buf bytes.Buffer
	log := obs.NewLogger(config.Log{Level: "info", Format: "json"}, &buf)
	c := config.Default()
	c.DB.DSN = "postgres://dilla:hunter2@localhost/dilla"
	log.Info("starting", slog.Any("config", c.Redacted()))
	if strings.Contains(buf.String(), "hunter2") {
		t.Fatalf("a config secret reached the log: %s", buf.String())
	}
}

func TestIdentifiersAreLoggedAsAnEightHexPrefix(t *testing.T) {
	var buf bytes.Buffer
	log := obs.NewLogger(config.Log{Level: "info", Format: "json"}, &buf)
	full := "0123456789abcdef0123456789abcdef"
	log.Info("group", slog.String("group_id", full))
	if strings.Contains(buf.String(), full) {
		t.Fatalf("a full identifier reached the log: %s", buf.String())
	}
	if !strings.Contains(buf.String(), "01234567") {
		t.Fatalf("the 8-hex prefix is missing: %s", buf.String())
	}
}

// secretHolder is the hole a key-based redactor has if it does not resolve:
// slog expands a LogValuer AFTER the handler chain, so an unresolved one walks
// its whole group past the redactor.
type secretHolder struct{}

func (secretHolder) LogValue() slog.Value {
	return slog.GroupValue(slog.String("token", "supersecret"), slog.String("route", "/v1/x"))
}

func TestALogValuerIsResolvedBeforeItIsRedacted(t *testing.T) {
	var buf bytes.Buffer
	log := obs.NewLogger(config.Log{Level: "info", Format: "json"}, &buf)
	log.Info("login", slog.Any("session", secretHolder{}))
	if strings.Contains(buf.String(), "supersecret") {
		t.Fatalf("a LogValuer carried a secret past the redactor: %s", buf.String())
	}
	if !strings.Contains(buf.String(), "/v1/x") {
		t.Fatalf("the LogValuer's non-secret attributes were dropped: %s", buf.String())
	}
}

// An E_* refusal code is the natural thing to log and must survive; an invite
// code must not. "code" alone is therefore not a secret key.
func TestARefusalCodeSurvivesTheRedactorButAnInviteCodeDoesNot(t *testing.T) {
	var buf bytes.Buffer
	log := obs.NewLogger(config.Log{Level: "info", Format: "json"}, &buf)
	log.Info("refused",
		slog.String("code", "E_NOT_FOUND"),
		slog.String("invite_code", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"))
	out := buf.String()
	if !strings.Contains(out, "E_NOT_FOUND") {
		t.Fatalf("the refusal code was redacted, making the line useless: %s", out)
	}
	if strings.Contains(out, "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
		t.Fatalf("an invite code reached the log: %s", out)
	}
}
