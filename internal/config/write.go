package config

import (
	"fmt"
	"io"
	"log/slog"

	"github.com/pelletier/go-toml/v2"
)

// WriteConfig writes the commented dilla.toml that `dillad init` produces. Every
// value is this struct's, so the file an operator reads is the configuration
// the process is actually running.
func (c *Config) WriteConfig(w io.Writer) error {
	header := "# dilla.toml — dillad instance configuration.\n" +
		"# Parsed with github.com/pelletier/go-toml/v2 in STRICT mode: an unknown\n" +
		"# key or table aborts start-up with exit code 78 and a line and column.\n" +
		"# Secrets are always *_file (mode 0600), never inline.\n\n"
	if _, err := io.WriteString(w, header); err != nil {
		return fmt.Errorf("config: write header: %w", err)
	}
	enc := toml.NewEncoder(w)
	enc.SetIndentTables(true)
	if err := enc.Encode(c); err != nil {
		return fmt.Errorf("config: encode: %w", err)
	}
	return nil
}

// Redacted is the ONLY way a Config reaches a log. slog.Any on a Config is
// forbidden (R20): it would print db.dsn, which carries a password.
func (c *Config) Redacted() slog.Value {
	return slog.GroupValue(
		slog.String("domain", c.Instance.Domain),
		slog.String("data_dir", c.Instance.DataDir),
		slog.String("tls_mode", string(c.TLS.Mode)),
		slog.String("listen", c.Server.Listen),
		slog.String("db_driver", c.DB.Driver),
		slog.Bool("turn_enabled", c.TURN.Enabled),
		slog.Bool("livekit_enabled", c.LiveKit.Enabled),
		slog.Bool("metrics_enabled", c.Metrics.Enabled),
		slog.Int64("max_ciphertext_bytes", c.Limits.MaxCiphertextBytes),
		slog.Int("handshake_retention_days", c.Retention.HandshakeDays),
		slog.Int("ciphertext_retention_days", c.Retention.CiphertextDays),
		slog.Any("auth_methods", c.Auth.Methods),
	)
}
