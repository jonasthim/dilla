package config

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"

	"github.com/jonasthim/dilla/internal/exit"
)

// runtimeNumCPU is runtime.NumCPU behind a variable so a test can pin it.
var runtimeNumCPU = runtime.NumCPU

// Load reads path in strict mode over the pre-populated defaults, derives the
// documented empties and validates. Every failure carries exit.Config (78) and,
// for a parse failure, a line and a column.
func Load(path string) (*Config, error) {
	body, err := os.ReadFile(path) //nolint:gosec // G304: path is the operator's own --config argument
	if err != nil {
		return nil, fmt.Errorf("config: read %s: %w: %w", path, err, exit.Config)
	}
	c := Default()
	dec := toml.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(c); err != nil {
		var strict *toml.StrictMissingError
		if errors.As(err, &strict) {
			// Position is a METHOD on *DecodeError, not a field: go-toml v2
			// v2.4.3 errors.go:82 declares
			// `func (e *DecodeError) Position() (row int, column int)` over
			// unexported line/column fields. And the message is String(), not
			// Error(): StrictMissingError.Error() returns only the fixed
			// sentence "strict mode: fields in the document are missing in the
			// target struct", while String() names each field in context.
			row, col := strict.Errors[0].Position()
			return nil, fmt.Errorf("config: %s: unknown key or table at line %d, column %d: %s: %w",
				path, row, col, strict.String(), exit.Config)
		}
		var derr *toml.DecodeError
		if errors.As(err, &derr) {
			row, col := derr.Position()
			return nil, fmt.Errorf("config: %s: line %d, column %d: %s: %w", path, row, col, derr.Error(), exit.Config)
		}
		return nil, fmt.Errorf("config: %s: %w: %w", path, err, exit.Config)
	}
	// Whether the operator WROTE turn.enabled, decoded rather than grepped: a
	// substring test for "enabled" matches [livekit], [metrics], [limits.rate]
	// and [auth.oidc] too, so it is true for essentially every real file and
	// Derive's behind_proxy default would never fire (R39 / D23).
	var presence struct {
		TURN struct {
			Enabled *bool `toml:"enabled"`
		} `toml:"turn"`
	}
	if err := toml.Unmarshal(body, &presence); err != nil {
		return nil, fmt.Errorf("config: %s: %w: %w", path, err, exit.Config)
	}
	c.turnExplicitlyEnabled = presence.TURN.Enabled != nil
	c.Derive()
	if err := c.Validate(); err != nil {
		return nil, fmt.Errorf("config: %s: %w: %w", path, err, exit.Config)
	}
	return c, nil
}

// durations returns every duration key by its dotted TOML path.
func (c *Config) durations() map[string]Duration {
	return map[string]Duration{
		"server.read_header_timeout":      c.Server.ReadHeaderTimeout,
		"server.idle_timeout":             c.Server.IdleTimeout,
		"server.shutdown_grace":           c.Server.ShutdownGrace,
		"gateway.heartbeat_interval":      c.Gateway.HeartbeatInterval,
		"gateway.session_idle_close":      c.Gateway.SessionIdleClose,
		"tls.dns.ttl":                     c.TLS.DNS.TTL,
		"tls.dns.propagation_delay":       c.TLS.DNS.PropagationDelay,
		"tls.dns.propagation_timeout":     c.TLS.DNS.PropagationTimeout,
		"turn.credential_ttl":             c.TURN.CredentialTTL,
		"db.conn_max_lifetime":            c.DB.ConnMaxLifetime,
		"blobs.pending_ttl":               c.Blobs.PendingTTL,
		"blobs.gc_grace":                  c.Blobs.GCGrace,
		"blobs.gc_interval":               c.Blobs.GCInterval,
		"blobs.upload_timeout":            c.Blobs.UploadTimeout,
		"limits.rate.sweep_interval":      c.Limits.Rate.SweepInterval,
		"limits.rate.max_retry_after":     c.Limits.Rate.MaxRetryAfter,
		"auth.session.native_lifetime":    c.Auth.Session.NativeLifetime,
		"auth.session.browser_lifetime":   c.Auth.Session.BrowserLifetime,
		"auth.session.browser_idle":       c.Auth.Session.BrowserIdle,
		"auth.session.reauth_window":      c.Auth.Session.ReauthWindow,
		"auth.lockout.observation_window": c.Auth.Lockout.ObservationWindow,
		"auth.lockout.first_lockout":      c.Auth.Lockout.FirstLockout,
		"auth.lockout.lockout_ceiling":    c.Auth.Lockout.LockoutCeiling,
		"doctor.clock_skew_max":           c.Doctor.ClockSkewMax,
	}
}

type rateBucket struct {
	perSecond float64
	burst     int
}

// rateBuckets returns the twelve (per_second, burst) pairs by name.
func (c *Config) rateBuckets() map[string]rateBucket {
	r := c.Limits.Rate
	return map[string]rateBucket{
		"message":      {r.MessagePerSecond, r.MessageBurst},
		"commit":       {r.CommitPerSecond, r.CommitBurst},
		"proposal":     {r.ProposalPerSecond, r.ProposalBurst},
		"read":         {r.ReadPerSecond, r.ReadBurst},
		"write":        {r.WritePerSecond, r.WriteBurst},
		"login":        {r.LoginPerSecond, r.LoginBurst},
		"login_failed": {r.LoginFailedPerSecond, r.LoginFailedBurst},
		"register":     {r.RegisterPerSecond, r.RegisterBurst},
		"invite":       {r.InvitePerSecond, r.InviteBurst},
		"unauth":       {r.UnauthPerSecond, r.UnauthBurst},
		"invalid":      {r.InvalidPerSecond, r.InvalidBurst},
	}
}

// Validate is the semantic half: strict mode catches spelling, this catches
// meaning. serve exits on the first finding; doctor calls it and prints all.
func (c *Config) Validate() error {
	var problems []error
	add := func(format string, args ...any) { problems = append(problems, fmt.Errorf(format, args...)) }

	for key, d := range c.durations() {
		if err := d.check(key); err != nil {
			add("%v", err)
		}
	}

	if c.Instance.Domain == "" {
		add("instance.domain is required: certmagic, WebAuthn's RPID, the TURN realm and the OIDC redirect all derive from it")
	}
	if !c.BehindProxy() && !c.Instance.PublicIP.IsValid() {
		add("instance.public_ip is required unless tls.mode = \"behind_proxy\": LiveKit would otherwise STUN-discover its own address")
	}
	if c.BehindProxy() && len(c.Server.TrustedProxyCIDRs) == 0 {
		add("server.trusted_proxy_cidrs must be non-empty in behind_proxy mode, or every per-address rate bucket collapses into one")
	}
	if !c.BehindProxy() && len(c.Server.TrustedProxyCIDRs) != 0 {
		add("server.trusted_proxy_cidrs is only read in behind_proxy mode; a direct listener that honours X-Forwarded-For lets a client forge its own address")
	}
	if c.TLS.Mode != TLSModeBehindProxy && !c.TLS.Agreed {
		add("tls.agreed must be true for any acme_* mode")
	}
	if c.TLS.Mode == TLSModeACMEIP && c.TLS.Profile != "" && c.TLS.Profile != "shortlived" {
		add("tls.profile must be \"\" or \"shortlived\" in acme_ip mode: only shortlived permits IP SANs")
	}
	if c.TLS.Mode != TLSModeBehindProxy && c.TURN.Listen != "" {
		add("turn.listen is only read in behind_proxy mode; elsewhere TURN shares 443 through the demux")
	}
	if c.BehindProxy() && c.TURN.Enabled && c.TURN.Listen == "" {
		add("turn.listen is required when turn.enabled is true in behind_proxy mode")
	}
	if c.TURN.Enabled {
		if err := secretFile(c.TURN.SharedSecretFile, 32); err != nil {
			add("turn.shared_secret_file: %v", err)
		}
		if c.TURN.RelayIP == "" {
			add("turn.relay_ip is required when turn.enabled is true")
		} else if _, err := netip.ParseAddr(c.TURN.RelayIP); err != nil && c.TURN.RelayIP != RelayIPAuto {
			add("turn.relay_ip %q is neither an IP address of this host nor %q", c.TURN.RelayIP, RelayIPAuto)
		}
	}
	if c.TURN.PublicURL != "" && !validTURNURL(c.TURN.PublicURL) {
		add("turn.public_url %q is not a turn: or turns: URL with a host and a port, e.g. \"turns:turn.example.org:5349?transport=tcp\"",
			c.TURN.PublicURL)
	}
	if c.TURN.ProxyProtocol && c.TURN.Listen == "" {
		add("turn.proxy_protocol requires turn.listen")
	}
	if c.LiveKit.Enabled {
		if err := secretFile(c.LiveKit.APISecretFile, 32); err != nil {
			add("livekit.api_secret_file: %v", err)
		}
		if len(c.LiveKit.STUNServers) == 0 {
			add("livekit.stun_servers is empty after defaulting; LiveKit would append its own public STUN hosts")
		}
	}
	// Reserved until wired: dillad renders LiveKit's YAML itself, and a key that never reaches it must
	// fail loudly rather than be read and ignored.
	if c.LiveKit.ExtraConfigFile != "" {
		add("livekit.extra_config_file is reserved and not read yet; remove it")
	}
	if c.LiveKit.MaxPublishers != defaultMaxPublishers {
		add("livekit.max_publishers is reserved: LiveKit v1.13.7 has no publisher cap, so only the default %d is accepted",
			defaultMaxPublishers)
	}
	if c.LiveKit.UseExternalIP {
		add("livekit.use_external_ip is reserved and must stay false: livekit.node_ip is the address LiveKit advertises")
	}
	if c.Retention.HandshakeDays > 30 || c.Retention.HandshakeDays < 1 {
		add("retention.handshake_days is %d; the range is 1..30 (protocol/02 § Retention)", c.Retention.HandshakeDays)
	}
	if c.Retention.CiphertextDays > 30 || c.Retention.CiphertextDays < 1 {
		add("retention.ciphertext_days is %d; the range is 1..30", c.Retention.CiphertextDays)
	}
	if c.Limits.MaxCiphertextBytes < 4096 || c.Limits.MaxCiphertextBytes > 1<<20 {
		add("limits.max_ciphertext_bytes is %d; the range is 4096..1048576", c.Limits.MaxCiphertextBytes)
	}
	p := c.Auth.Password
	if p.Argon2Iterations < 2 {
		add("auth.password.argon2_iterations is %d; the floor is 2 (OWASP 2026) and 0 panics inside x/crypto/argon2", p.Argon2Iterations)
	}
	if p.Argon2Parallelism < 1 || p.Argon2Parallelism > 16 {
		add("auth.password.argon2_parallelism is %d; the range is 1..16", p.Argon2Parallelism)
	}
	if p.Argon2KeyBytes != 32 {
		add("auth.password.argon2_key_bytes must be 32")
	}
	if p.Argon2SaltBytes < 16 {
		add("auth.password.argon2_salt_bytes is %d; the floor is 16", p.Argon2SaltBytes)
	}
	if p.Argon2MemoryKiB < 19456 {
		add("auth.password.argon2_memory_kib is %d; the OWASP floor is 19456", p.Argon2MemoryKiB)
	}
	if p.PepperFile != "" {
		// R15 and §6.3: there is no pepper. x/crypto/argon2 exposes no secret
		// input, so a pepper_file that is read and ignored is worse than one
		// that is refused — the operator believes they have a defence they do
		// not have. The key stays in the struct so strict mode still names it.
		add("auth.password.pepper_file is set, but peppering is not implemented: x/crypto/argon2 exposes no secret input (R15). Remove the key")
	}
	if int(p.Argon2MemoryKiB) > p.HashMemoryBudgetMiB*1024 {
		add("auth.password.argon2_memory_kib (%d) exceeds hash_memory_budget_mib (%d MiB); the hashing semaphore would block every login until its context expired",
			p.Argon2MemoryKiB, p.HashMemoryBudgetMiB)
	}
	if c.Limits.Rate.Enabled {
		for name, pair := range c.rateBuckets() {
			if pair.perSecond <= 0 {
				add("limits.rate.%s_per_second must be > 0: a zero rate.Limit allows no events", name)
			}
			if pair.burst < 1 {
				add("limits.rate.%s_burst must be >= 1", name)
			}
		}
		if s := c.Limits.Rate.SweepInterval.Value(); s < 5*time.Second || s > 5*time.Minute {
			add("limits.rate.sweep_interval is %s; the range is 5s..5m", s)
		}
	}
	if c.Limits.Rate.PasswordConcurrency > 2*runtimeNumCPU() {
		add("limits.rate.password_concurrency is %d; the ceiling is 2 x NumCPU", c.Limits.Rate.PasswordConcurrency)
	}
	if len(c.Auth.Methods) == 0 {
		add("auth.methods is empty")
	}
	for _, m := range c.Auth.Methods {
		if !slices.Contains([]string{"password", "totp", "passkey", "oidc"}, m) {
			add("auth.methods: %q is not one of password, totp, passkey, oidc", m)
		}
	}
	if slices.Contains(c.Auth.Methods, "oidc") && !c.Auth.OIDC.Enabled {
		add("auth.methods lists oidc but auth.oidc.enabled is false")
	}
	if c.Auth.OIDC.Enabled {
		if c.Auth.OIDC.Issuer == "" || c.Auth.OIDC.ClientID == "" {
			add("auth.oidc.issuer and auth.oidc.client_id are required when OIDC is enabled")
		}
		if err := secretFile(c.Auth.OIDC.ClientSecretFile, 1); err != nil {
			add("auth.oidc.client_secret_file: %v", err)
		}
	}
	if len(c.Auth.WebAuthn.RPOrigins) == 0 {
		add("auth.webauthn.rp_origins is empty after defaulting; go-webauthn refuses a config with no origin")
	}
	if c.Auth.TOTP.Digits != 6 && c.Auth.TOTP.Digits != 8 {
		add("auth.totp.digits is %d; the values are 6 and 8", c.Auth.TOTP.Digits)
	}
	if !slices.Contains([]string{"SHA1", "SHA256", "SHA512"}, c.Auth.TOTP.Algorithm) {
		add("auth.totp.algorithm is %q; the values are SHA1, SHA256, SHA512", c.Auth.TOTP.Algorithm)
	}
	if c.Auth.TOTP.Skew > 2 {
		add("auth.totp.skew is %d; a skew above 2 accepts more than five codes at once", c.Auth.TOTP.Skew)
	}
	switch c.DB.Driver {
	case "sqlite":
		if c.DB.Path == "" || c.DB.DSN != "" {
			add("db.driver = \"sqlite\" needs db.path and no db.dsn")
		}
	case "postgres":
		if c.DB.DSN == "" || c.DB.Path != "" {
			add("db.driver = \"postgres\" needs db.dsn and no db.path")
		}
	default:
		add("db.driver is %q; the values are sqlite and postgres", c.DB.Driver)
	}
	if !slices.Contains([]string{"public", "session"}, c.Instance.Discovery) {
		add("instance.discovery is %q; the values are public and session", c.Instance.Discovery)
	}
	if c.Doctor.ClockSkewMax.Value() < 2*time.Second {
		add("doctor.clock_skew_max is %s; HTTP-date has one-second granularity, so anything under 2s is noise", c.Doctor.ClockSkewMax.Value())
	}
	return errors.Join(problems...)
}

// validTURNURL is RFC 7065's shape as clients take it: "turn:" or "turns:", a host (an IPv6 literal
// in brackets), a numeric port, and an optional "?transport=..." query.
func validTURNURL(s string) bool {
	rest, ok := strings.CutPrefix(s, "turns:")
	if !ok {
		if rest, ok = strings.CutPrefix(s, "turn:"); !ok {
			return false
		}
	}
	hostport, _, _ := strings.Cut(rest, "?")
	host, port, err := net.SplitHostPort(hostport)
	if err != nil || host == "" || strings.ContainsAny(host, "/@ ") {
		return false
	}
	n, err := strconv.Atoi(port)
	return err == nil && n > 0 && n < 65536
}

// secretFile checks a *_file key: present, readable, mode 0600, at least minBytes bytes.
func secretFile(path string, minBytes int) error {
	if path == "" {
		return errors.New("is required")
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Errorf("%s has mode %04o; a secret file must be 0600", path, perm)
	}
	if info.Size() < int64(minBytes) {
		return fmt.Errorf("%s is %d bytes; at least %d are required", path, info.Size(), minBytes)
	}
	return nil
}
