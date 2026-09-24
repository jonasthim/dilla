package config_test

import (
	"bytes"
	"errors"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/exit"
)

type netipPrefix = netip.Prefix

func netipMustParse(t *testing.T, s string) netip.Addr {
	t.Helper()
	a, err := netip.ParseAddr(s)
	if err != nil {
		t.Fatalf("ParseAddr(%q): %v", s, err)
	}
	return a
}

func prefixMustParse(t *testing.T, s string) netip.Prefix {
	t.Helper()
	p, err := netip.ParsePrefix(s)
	if err != nil {
		t.Fatalf("ParsePrefix(%q): %v", s, err)
	}
	return p
}

func base() *config.Config {
	c := config.Default()
	c.Instance.Domain = "chat.example"
	c.TLS.Agreed = true
	return c
}

func writeSecrets(t *testing.T, dir string) {
	t.Helper()
	for _, name := range []string{"turn.secret", "livekit.secret"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(strings.Repeat("s", 32)), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
}

func loadTestdata(t *testing.T, name string) (*config.Config, error) {
	t.Helper()
	dir := t.TempDir()
	body, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read testdata: %v", err)
	}
	path := filepath.Join(dir, "dilla.toml")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	writeSecrets(t, dir)
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	t.Cleanup(func() { os.Chdir(cwd) })
	return config.Load(path)
}

func TestUnknownKeyFailsWithLineAndColumnAndExitConfig(t *testing.T) {
	for _, name := range []string{"unknown_key.toml", "unknown_table.toml"} {
		t.Run(name, func(t *testing.T) {
			_, err := loadTestdata(t, name)
			if err == nil {
				t.Fatal("strict mode accepted an unknown field")
			}
			var code exit.Code
			if !errors.As(err, &code) || code != exit.Config {
				t.Fatalf("error %v does not carry exit.Config", err)
			}
			msg := err.Error()
			if !strings.Contains(msg, "line") || !strings.Contains(msg, "column") {
				t.Fatalf("error %q names neither a line nor a column", msg)
			}
		})
	}
}

func TestMinimalFileLoadsAndValidates(t *testing.T) {
	c, err := loadTestdata(t, "minimal.toml")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Instance.DataDir != "/var/lib/dilla" {
		t.Fatalf("data_dir = %q, want the default", c.Instance.DataDir)
	}
	if c.Limits.MaxCiphertextBytes != 131072 {
		t.Fatalf("max_ciphertext_bytes = %d, want 131072 (R6/R32)", c.Limits.MaxCiphertextBytes)
	}
	if c.Auth.Password.Argon2MemoryKiB != 19456 || c.Auth.Password.Argon2Iterations != 2 || c.Auth.Password.Argon2Parallelism != 1 {
		t.Fatalf("argon2 defaults = %d/%d/%d, want 19456/2/1 (R15)",
			c.Auth.Password.Argon2MemoryKiB, c.Auth.Password.Argon2Iterations, c.Auth.Password.Argon2Parallelism)
	}
	if c.Gateway.HeartbeatInterval.Value() != 30*time.Second || c.Gateway.SessionIdleClose.Value() != 90*time.Second {
		t.Fatalf("gateway timings = %s/%s, want 30s/90s (R10)",
			c.Gateway.HeartbeatInterval.Value(), c.Gateway.SessionIdleClose.Value())
	}
	if c.Auth.WebAuthn.RPID != "chat.example" {
		t.Fatalf("derived rp_id = %q", c.Auth.WebAuthn.RPID)
	}
}

// R39 / D23: TURN is off by default in behind_proxy. This goes through Load,
// not through Default()+Derive(), because the bug it guards against lives in
// Load: a substring test for "enabled" over the whole document is true for
// nearly every real file, and Derive's default then never fires.
func TestTURNDefaultsOffBehindProxyEvenWhenOtherTablesSayEnabled(t *testing.T) {
	c, err := loadTestdata(t, "turn_presence.toml")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.TURN.Enabled {
		t.Fatal("turn.enabled is true in behind_proxy mode although [turn] carries no enabled key")
	}
}

// The other direction: an operator who DID write turn.enabled is obeyed.
func TestAnExplicitTURNEnabledSurvivesBehindProxy(t *testing.T) {
	dir := t.TempDir()
	body, err := os.ReadFile(filepath.Join("testdata", "turn_presence.toml"))
	if err != nil {
		t.Fatalf("read testdata: %v", err)
	}
	body = append(body, []byte("\nenabled            = true\nlisten             = \"127.0.0.1:3478\"\nshared_secret_file = \"turn.secret\"\nrelay_ip           = \"203.0.113.7\"\n")...)
	path := filepath.Join(dir, "dilla.toml")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	writeSecrets(t, dir)
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	t.Cleanup(func() { os.Chdir(cwd) })
	c, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !c.TURN.Enabled {
		t.Fatal("an explicit turn.enabled = true was overridden by the behind_proxy default")
	}
}

// R15 / §6.3: there is no pepper, so a set pepper_file is refused rather than
// silently ignored.
func TestAPepperFileIsRefused(t *testing.T) {
	c := base()
	c.Auth.Password.PepperFile = "/etc/dilla/pepper"
	err := c.Validate()
	if err == nil {
		t.Fatal("auth.password.pepper_file was accepted")
	}
	if !strings.Contains(err.Error(), "peppering is not implemented") {
		t.Fatalf("error %q does not say why the key is refused", err)
	}
}

func TestNoFieldIsATimeDuration(t *testing.T) {
	var forbidden = reflect.TypeOf(time.Duration(0))
	var walk func(reflect.Type, string)
	walk = func(t2 reflect.Type, path string) {
		if t2.Kind() != reflect.Struct {
			return
		}
		for i := 0; i < t2.NumField(); i++ {
			f := t2.Field(i)
			if f.Type == forbidden {
				t.Fatalf("%s.%s is a time.Duration: a TOML integer decodes into it as NANOSECONDS (gap-74 §2.1)", path, f.Name)
			}
			walk(f.Type, path+"."+f.Name)
		}
	}
	walk(reflect.TypeOf(config.Config{}), "Config")
}

func TestEveryDurationRoundTripsThroughWriteToAndLoad(t *testing.T) {
	dir := t.TempDir()
	writeSecrets(t, dir)
	cwd, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	t.Cleanup(func() { os.Chdir(cwd) })

	c := config.Default()
	c.Instance.Domain = "chat.example"
	c.Instance.PublicIP = netipMustParse(t, "203.0.113.7")
	c.TLS.Agreed = true
	c.TURN.SharedSecretFile = "turn.secret"
	c.TURN.RelayIP = "203.0.113.7"
	c.LiveKit.APISecretFile = "livekit.secret"
	var buf bytes.Buffer
	if err := c.WriteTo(&buf); err != nil {
		t.Fatalf("WriteTo: %v", err)
	}
	path := filepath.Join(dir, "written.toml")
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	back, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load(WriteTo output): %v", err)
	}
	if back.Server.ShutdownGrace.Value() != c.Server.ShutdownGrace.Value() ||
		back.Auth.Session.NativeLifetime.Value() != c.Auth.Session.NativeLifetime.Value() ||
		back.Blobs.GCInterval.Value() != c.Blobs.GCInterval.Value() {
		t.Fatal("a duration key did not survive WriteTo -> Load")
	}
}

func TestValidationRules(t *testing.T) {
	base := func() *config.Config {
		c := config.Default()
		c.Instance.Domain = "chat.example"
		c.Instance.PublicIP = netipMustParse(t, "203.0.113.7")
		c.TLS.Agreed = true
		c.TURN.Enabled = false
		c.LiveKit.Enabled = false
		return c
	}
	t.Run("behind_proxy needs trusted_proxy_cidrs", func(t *testing.T) {
		c := base()
		c.TLS.Mode = config.TLSModeBehindProxy
		c.Server.TrustedProxyCIDRs = nil
		if err := c.Validate(); err == nil {
			t.Fatal("empty trusted_proxy_cidrs accepted in behind_proxy")
		}
	})
	t.Run("direct TLS refuses trusted_proxy_cidrs", func(t *testing.T) {
		c := base()
		c.Server.TrustedProxyCIDRs = []netipPrefix{prefixMustParse(t, "127.0.0.1/32")}
		if err := c.Validate(); err == nil {
			t.Fatal("trusted_proxy_cidrs accepted outside behind_proxy")
		}
	})
	t.Run("turn defaults off under behind_proxy and needs listen when on", func(t *testing.T) {
		c := base()
		c.TLS.Mode = config.TLSModeBehindProxy
		c.Server.TrustedProxyCIDRs = []netipPrefix{prefixMustParse(t, "127.0.0.1/32")}
		c.Derive()
		if c.TURN.Enabled {
			t.Fatal("turn.enabled must default false under behind_proxy (R39)")
		}
		c.TURN.Enabled = true
		c.TURN.Listen = ""
		if err := c.Validate(); err == nil {
			t.Fatal("turn.enabled without turn.listen accepted in behind_proxy")
		}
	})
	t.Run("acme without agreement fails", func(t *testing.T) {
		c := base()
		c.TLS.Agreed = false
		if err := c.Validate(); err == nil {
			t.Fatal("an acme_* mode was accepted without tls.agreed")
		}
	})
	t.Run("retention over thirty days fails", func(t *testing.T) {
		for _, set := range []func(*config.Config){
			func(c *config.Config) { c.Retention.HandshakeDays = 31 },
			func(c *config.Config) { c.Retention.CiphertextDays = 31 },
		} {
			c := base()
			set(c)
			if err := c.Validate(); err == nil {
				t.Fatal("a retention window over 30 days was accepted")
			}
		}
	})
	t.Run("argon2 floors", func(t *testing.T) {
		c := base()
		c.Auth.Password.Argon2Iterations = 1
		if err := c.Validate(); err == nil {
			t.Fatal("argon2_iterations = 1 accepted; the floor is 2")
		}
		c = base()
		c.Auth.Password.Argon2MemoryKiB = 4096
		if err := c.Validate(); err == nil {
			t.Fatal("argon2_memory_kib below 19456 accepted")
		}
		c = base()
		c.Auth.Password.Argon2MemoryKiB = 1 << 20
		c.Auth.Password.HashMemoryBudgetMiB = 256
		if err := c.Validate(); err == nil {
			t.Fatal("argon2_memory_kib above the hash memory budget accepted")
		}
	})
	t.Run("a zero rate limit is refused", func(t *testing.T) {
		c := base()
		c.Limits.Rate.MessageBurst = 0
		if err := c.Validate(); err == nil {
			t.Fatal("a zero burst was accepted; rate.Limit(0) allows no events")
		}
	})
}

func TestRedactedNeverEmitsASecret(t *testing.T) {
	c := config.Default()
	c.Instance.Domain = "chat.example"
	c.DB.DSN = "postgres://dilla:hunter2@localhost/dilla"
	c.LiveKit.APIKey = "dilla"
	var buf bytes.Buffer
	h := slog.NewJSONHandler(&buf, nil)
	slog.New(h).Info("config", slog.Any("config", c.Redacted()))
	out := buf.String()
	for _, secret := range []string{"hunter2", "postgres://"} {
		if strings.Contains(out, secret) {
			t.Fatalf("Redacted leaked %q: %s", secret, out)
		}
	}
	if !strings.Contains(out, "chat.example") {
		t.Fatalf("Redacted dropped a non-secret field: %s", out)
	}
}

func TestConfigDoesNotImplementLogValuerByAccident(t *testing.T) {
	// slog.Any(c) must not silently serialise the whole struct: the only
	// supported path is c.Redacted(). A LogValue method on *Config would make
	// slog.Any safe and is therefore deliberately absent, so this asserts the
	// method set rather than the output.
	if _, ok := any(config.Default()).(slog.LogValuer); ok {
		t.Fatal("*Config implements slog.LogValuer; R20 requires the explicit Redacted() call")
	}
}
