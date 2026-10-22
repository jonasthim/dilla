package main

import (
	"context"
	"crypto/tls"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/jonasthim/dilla/internal/blob"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/ops"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/sfu"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/sqlite"
)

// fileJournalMode reads path's own journal mode on a connection that sets no
// pragmas.
//
// It must run BEFORE any pool is opened with the write DSN: modernc executes
// _pragma=journal_mode(WAL) on every new connection, so a database someone
// left in DELETE mode is silently converted back to WAL by the very act of
// opening it, and a read-back through that pool can never fail.
func fileJournalMode(ctx context.Context, path string) (string, error) {
	db, err := sql.Open("sqlite", "file:"+url.PathEscape(path)+"?mode=ro")
	if err != nil {
		return "", err
	}
	defer func() { _ = db.Close() }()
	var mode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
		return "", err
	}
	return strings.ToLower(mode), nil
}

// doctorHTTPClient is the client the clock leg samples with. A variable so a
// test can point it elsewhere; five seconds bounds one peer.
var doctorHTTPClient = &http.Client{Timeout: 5 * time.Second}

// doctorWasi is the wasi leg's probe, a variable so a test can stand in for the
// artifact a `go test` binary never has beside it.
var doctorWasi = doctorWasiLeg

// peerList is a repeatable --clock-peer flag.
type peerList []string

func (p *peerList) String() string     { return strings.Join(*p, ",") }
func (p *peerList) Set(v string) error { *p = append(*p, v); return nil }

// runDoctor is the full check inventory, in this order: config (parse plus
// Validate), database (db.PingContext plus the goose schema version), pragmas,
// data_dir (mode and ownership), wasi (artifact load plus dilla_abi), clock
// (skew against doctor.clock_peers), certificate, turn, media_binary, media_refresh, udp and blobs. It
// prints ops.Report's stable text, one line per leg, and exits exit.Unavailable
// if any leg is red; a yellow leg alone exits 0.
//
// doctor takes no data-directory lock, because it must be runnable against a
// live instance: it opens the database the way serve does and reads the
// certificate and the blob tree without writing to either.
func runDoctor(args []string, stdout, stderr io.Writer) error {
	flags, cfgPath := newFlagSet("doctor", stderr)
	var clockPeers peerList
	flags.Var(&clockPeers, "clock-peer", "an HTTPS origin to read the Date header from; repeatable, replaces doctor.clock_peers")
	quiet := flags.Bool("quiet", false, "print only the legs that are not OK (for a container health check)")
	if err := parse(flags, args, stdout); err != nil {
		return err
	}

	var report ops.Report
	add := func(l ops.Leg) { report.Legs = append(report.Legs, l) }
	fail := func(leg string, err error) { add(ops.Leg{Name: leg, Status: ops.Red, Detail: err.Error()}) }
	finish := func() error {
		out := report
		if *quiet {
			out = ops.Report{}
			for _, l := range report.Legs {
				if l.Status != ops.Green {
					out.Legs = append(out.Legs, l)
				}
			}
		}
		fmt.Fprint(stdout, out.Text())
		if !*quiet {
			fmt.Fprint(stdout, report.Summary())
		}
		if report.Worst() == ops.Red {
			return fmt.Errorf("doctor: one or more checks failed: %w", exit.Unavailable)
		}
		return nil
	}

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fail("config", err)
		_ = finish()
		return err
	}
	add(ops.Leg{Name: "config", Status: ops.Green, Detail: "parsed and validated"})

	ctx := context.Background()

	// Pragma leg, half 1: the file's own journal mode, read on a mode=ro
	// connection that sets no pragmas of its own. This MUST run before any pool
	// is opened with the write DSN (the database leg, right below): modernc
	// executes _pragma=journal_mode(WAL) on every new connection, so opening
	// the file first would silently convert a database left in DELETE mode
	// back to WAL and this leg could then never fail. journal_mode is a
	// property of the file, not of any one connection (facts-storage §2.3).
	var pragmaErr error
	if cfg.DB.Driver == "sqlite" {
		mode, err := fileJournalMode(ctx, cfg.DB.Path)
		switch {
		case err != nil:
			pragmaErr = err
		case mode != "wal":
			pragmaErr = fmt.Errorf("journal_mode is %q, want wal", mode)
		}
	}

	// Leg 2: db.PingContext plus the goose schema version. Opening the
	// repository is what (harmlessly, now) converts the file back to WAL; the
	// pragma leg above already captured the value before that happened.
	repo, db, err := openRepository(cfg)
	if err != nil {
		fail("database", err)
	} else {
		defer func() { _ = repo.Close() }()
		if err := db.PingContext(ctx); err != nil {
			fail("database", err)
		} else if version, err := repo.SchemaVersion(ctx); err != nil {
			fail("database", err)
		} else {
			add(ops.Leg{Name: "database", Status: ops.Green, Detail: fmt.Sprintf("schema version %d", version)})
		}

		// Pragma leg, half 2: busy_timeout, foreign_keys and synchronous are
		// per-connection and can only be checked on a connection that asked for
		// them, i.e. the pool openRepository just opened.
		if pragmaErr == nil && cfg.DB.Driver == "sqlite" {
			pragmaErr = sqlite.VerifyPragmas(ctx, db, sqlite.WantPragmas)
		}
	}

	switch {
	case cfg.DB.Driver != "sqlite":
		add(ops.Leg{Name: "pragmas", Status: ops.Green, Detail: "skipped (not sqlite)"})
	case pragmaErr != nil:
		fail("pragmas", pragmaErr)
	default:
		add(ops.Leg{Name: "pragmas", Status: ops.Green, Detail: "journal_mode, busy_timeout, foreign_keys and synchronous as required"})
	}

	// Leg 4: the data directory's mode and ownership. StateDirectoryMode=0700
	// (facts-ops.md §6.3) means group and world must have no access at all.
	if info, err := os.Stat(cfg.Instance.DataDir); err != nil {
		fail("data_dir", err)
	} else if perm := info.Mode().Perm(); perm&0o077 != 0 {
		fail("data_dir", fmt.Errorf("%s has mode %04o; group and world must have no access", cfg.Instance.DataDir, perm))
	} else {
		add(ops.Leg{Name: "data_dir", Status: ops.Green, Detail: fmt.Sprintf("%s mode %04o", cfg.Instance.DataDir, perm)})
	}

	// Leg 5: the wasi artifact load plus dilla_abi.
	if info, err := doctorWasi(ctx); err != nil {
		fail("wasi", err)
	} else {
		add(ops.Leg{Name: "wasi", Status: ops.Green, Detail: fmt.Sprintf("abi_version=%d core_version=%s", info.ABIVersion, info.CoreVersion)})
	}

	// Leg 6: clock skew, the median over doctor.clock_peers. serve never gates
	// on it: a booting LXC with no network yet must still start.
	peers := cfg.Doctor.ClockPeers
	if len(clockPeers) > 0 {
		peers = clockPeers
	}
	add(ops.ClockLeg(ctx, doctorHTTPClient, peers, cfg.Doctor.ClockSkewMax.Value()))

	add(doctorCertificateLeg(ctx, cfg))
	add(doctorTURNLeg(ctx, cfg))
	add(doctorMediaBinaryLeg(ctx, cfg))
	add(doctorMediaRefreshLeg(ctx, cfg, time.Now()))
	add(ops.UDPLeg(*cfg))
	add(ops.WebAuthnLeg(*cfg))
	add(doctorBlobsLeg(ctx, cfg, repo))

	return finish()
}

// doctorCertificateLeg looks at the certificate certmagic holds on disk. It
// never asks certmagic to obtain one, so it is safe beside a live serve; the
// last renewal error lives in that process's memory and is not visible here.
func doctorCertificateLeg(ctx context.Context, cfg *config.Config) ops.Leg {
	if cfg.BehindProxy() {
		return ops.Leg{Name: "certificate", Status: ops.Green, Detail: "tls.mode is behind_proxy: the proxy terminates TLS"}
	}
	name := cfg.Instance.Domain
	if cfg.TLS.Mode == config.TLSModeACMEIP {
		name = cfg.Instance.PublicIP.String()
	}
	return ops.CertificateLeg(ctx, name, &tls.Config{
		GetCertificate: ops.CertificateFromStorage(cfg.TLS.StorageDir, name),
		MinVersion:     tls.VersionTLS12,
	}, "")
}

// doctorTURNLeg allocates against the TURN listener the configuration names:
// turn.listen in behind_proxy mode, where it is its own plain TCP listener, and
// otherwise the instance's own 443, where TURN shares the port behind the TLS
// demux and is reached over TLS.
//
// It first names the process that serves the relay (R-UP11): dilla-media or the API, from what
// each answers on its control socket (GET /relay/state on media.sock and api.sock), or, when a
// socket does not answer (doctor run as another user, a process down), from media.json and the
// configuration. Both serving, or neither, is red.
func doctorTURNLeg(ctx context.Context, cfg *config.Config) ops.Leg {
	const name = "turn"
	if !cfg.TURN.Enabled {
		// Yellow, not red: turn.enabled = false is a legitimate topology (a LAN
		// plus one forwarded UDP port), not a fault.
		return ops.Leg{Name: name, Status: ops.Yellow,
			Detail: "turn.enabled is false: no relay is offered, so voice needs direct UDP reachability"}
	}
	owner, unacked, bad := doctorTURNOwner(ctx, cfg)
	if bad != nil {
		return *bad
	}
	leg := doctorTURNProbe(ctx, cfg)
	leg.Detail = "served by " + owner + "; " + leg.Detail
	if unacked > 0 {
		leg.Detail += fmt.Sprintf("; %d cuts not yet acknowledged by dilla-media", unacked)
		if leg.Status == ops.Green {
			leg.Status = ops.Yellow
			leg.Fix = "check `journalctl -u dilla` for media.sock; the cut devices are refused (503) until dilla-media acknowledges"
		}
	}
	return leg
}

// doctorTURNOwner names the process serving the relay and how many cuts dilla-media has not
// acknowledged (api.sock's GET /relay/state), or answers the red leg when both or neither serve,
// or when dilla-media serves TURN and api.sock does not answer: its barred lookups then fail and
// `dillad media --idle` reads busy.
func doctorTURNOwner(ctx context.Context, cfg *config.Config) (string, int, *ops.Leg) {
	const name = "turn"
	if !cfg.LiveKit.Enabled || cfg.LiveKit.Mode != "sidecar" {
		return "the API (dilla), which also runs the SFU", 0, nil
	}
	ask := func(sock string) (server.RelayState, error) {
		ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		return server.FetchRelayState(ctx, server.ControlClient(server.ControlSocketPath(cfg.Instance.DataDir, sock)))
	}
	var media, api, apiDown bool
	unacked := 0
	var how []string
	if st, err := ask(server.MediaSocketName); err == nil {
		media = st.Serving
		how = append(how, fmt.Sprintf("media.sock: serving=%v, %d allocations", st.Serving, st.Allocations))
	} else {
		ms, merr := readMediaState(ctx, cfg.Instance.DataDir)
		media = merr == nil && slices.Contains(ms.Capabilities, turnCapability)
		how = append(how, fmt.Sprintf("media.sock did not answer; media.json says turn=%v", media))
	}
	if st, err := ask(server.APISocketName); err == nil {
		api, unacked = st.Serving, st.Unacked
		how = append(how, fmt.Sprintf("api.sock: serving=%v, %d allocations", st.Serving, st.Allocations))
	} else {
		apiDown = true
		// As serve decides it (planTURN): the demux relay without turn.listen, else turn.listen
		// whenever dilla-media does not hold it.
		api = cfg.TURN.Listen == "" || !media
		how = append(how, fmt.Sprintf("api.sock did not answer; inferred serving=%v", api))
	}
	detail := strings.Join(how, "; ")
	switch {
	case media && apiDown:
		return "", 0, &ops.Leg{Name: name, Status: ops.Red,
			Detail: "dilla-media serves TURN but the API does not answer on api.sock: its barred lookups fail and `dillad media --idle` reads busy (" + detail + ")",
			Fix:    "run `dillad doctor` as the dillad user (api.sock serves only that uid); if it still fails, read `journalctl -u dilla` and systemctl restart dilla"}
	case media && api:
		return "", 0, &ops.Leg{Name: name, Status: ops.Red, Detail: "TURN is served by both dilla-media and the API (" + detail + ")",
			Fix: "restart dilla so it sees dilla-media's relay (systemctl restart dilla)"}
	case !media && !api:
		return "", 0, &ops.Leg{Name: name, Status: ops.Red, Detail: "TURN is served by neither process (" + detail + ")",
			Fix: "check `journalctl -u dilla-media` for the turn.listen bind, then systemctl restart dilla-media"}
	case media:
		return "dilla-media (" + detail + ")", unacked, nil
	}
	return "the API (dilla) (" + detail + ")", unacked, nil
}

// doctorTURNProbe allocates against the listener the relay serves on: turn.listen in behind_proxy
// mode and for the public-mode opt-in (over TLS), the instance's own 443 otherwise.
func doctorTURNProbe(ctx context.Context, cfg *config.Config) ops.Leg {
	const name = "turn"
	switch {
	case !cfg.Doctor.TURNProbe:
		return ops.Leg{Name: name, Status: ops.Green, Detail: "skipped: doctor.turn_probe is false"}
	case cfg.TURN.ProxyProtocol:
		return ops.Leg{Name: name, Status: ops.Yellow,
			Detail: "turn.proxy_protocol is true: the listener refuses a connection without a PROXY header, so doctor cannot probe it directly",
			Fix:    "allocate through the proxy from another network"}
	}
	secret, err := ops.ReadSecret(cfg.TURN.SharedSecretFile)
	if err != nil {
		return ops.Leg{Name: name, Status: ops.Red, Detail: "turn.shared_secret_file: " + err.Error(),
			Fix: "run dillad init, or create the file with 32 random bytes at mode 0600"}
	}
	listen := cfg.TURN.Listen
	if !cfg.BehindProxy() {
		host := cfg.Instance.Domain
		if cfg.TLS.Mode == config.TLSModeACMEIP {
			host = cfg.Instance.PublicIP.String()
		}
		addr := cfg.Server.Listen
		if cfg.TURN.Listen != "" {
			addr = cfg.TURN.Listen // the public-mode opt-in
		}
		_, port, err := net.SplitHostPort(addr)
		if err != nil || port == "" {
			port = "443"
		}
		listen = "tls://" + net.JoinHostPort(host, port)
	}
	return ops.TURNLeg(ctx, listen, cfg.TURN.Realm, secret)
}

// doctorMediaBinaryLeg compares the running SFU's build with this binary, from media.json. The SFU
// is a separate process that outlives an API upgrade until its calls end (R-UP3, R-UP4), so it may
// legitimately be older: yellow. Red is an SFU below the oldest level this API works with.
func doctorMediaBinaryLeg(ctx context.Context, cfg *config.Config) ops.Leg {
	const name = "media_binary"
	if !cfg.LiveKit.Enabled || cfg.LiveKit.Mode != "sidecar" {
		return ops.Leg{Name: name, Status: ops.Green, Detail: "skipped: the SFU is not a sidecar"}
	}
	st, err := readMediaState(ctx, cfg.Instance.DataDir)
	switch {
	case err != nil:
		return ops.Leg{Name: name, Status: ops.Yellow,
			Detail: "dilla-media's build is unknown (" + err.Error() + "); it restarts onto this binary when its calls end (dilla-media-refresh.timer)"}
	case st.MediaLevel < sfu.MinSFUMediaLevel:
		return ops.Leg{Name: name, Status: ops.Red,
			Detail: fmt.Sprintf("dilla-media runs v%s at media level %d; this API needs at least %d", st.Version, st.MediaLevel, sfu.MinSFUMediaLevel),
			Fix:    "systemctl restart dilla-media (this ends live calls)"}
	case st.Version != Version:
		// The versions alone do not say which is newer: after a rollback the SFU runs the later
		// build. The levels say how they relate.
		rel := "differs from this binary's v" + Version
		switch {
		case st.MediaLevel > sfu.MediaLevel:
			rel = fmt.Sprintf("a newer media level (%d) than this binary's (%d)", st.MediaLevel, sfu.MediaLevel)
		case st.MediaLevel < sfu.MediaLevel:
			rel = fmt.Sprintf("an older media level (%d) than this binary's (%d)", st.MediaLevel, sfu.MediaLevel)
		}
		return ops.Leg{Name: name, Status: ops.Yellow,
			Detail: fmt.Sprintf("dilla-media runs v%s, %s; it restarts onto this binary when its calls end (dilla-media-refresh.timer)", st.Version, rel)}
	}
	return ops.Leg{Name: name, Status: ops.Green, Detail: fmt.Sprintf("dilla-media runs v%s, this version (media level %d)", st.Version, st.MediaLevel)}
}

// doctorBlobsLeg cross-checks the blob rows against the blob tree. It never
// creates the blob directory: a directory serve has not made yet is an
// instance that has not stored an attachment.
func doctorBlobsLeg(ctx context.Context, cfg *config.Config, repo store.Repository) ops.Leg {
	const name = "blobs"
	if repo == nil {
		return ops.Leg{Name: name, Status: ops.Yellow, Detail: "skipped: the database did not open"}
	}
	if _, err := os.Stat(cfg.Blobs.Dir); errors.Is(err, fs.ErrNotExist) {
		return ops.Leg{Name: name, Status: ops.Yellow, Detail: cfg.Blobs.Dir + " does not exist yet: serve creates it"}
	}
	bs, err := blob.Open(cfg.Blobs.Dir, cfg.Blobs.Backend)
	if err != nil {
		return ops.Leg{Name: name, Status: ops.Red, Detail: err.Error()}
	}
	defer func() { _ = bs.Close() }()
	return ops.BlobConsistencyLeg(ctx, repo, bs)
}

// doctorWasiLeg loads dilla-core-wasi from the conventional path next to the
// dillad binary and calls dilla_abi. Nothing in dillad yet configures this
// path — the wasi ABI is wired into serve only from task 14 onward — so this
// leg is red until the artifact is placed there.
func doctorWasiLeg(ctx context.Context) (mlswasi.ABIInfo, error) {
	exe, err := os.Executable()
	if err != nil {
		return mlswasi.ABIInfo{}, fmt.Errorf("locate the dillad binary: %w", err)
	}
	path := filepath.Join(filepath.Dir(exe), "dilla_core_wasi.wasm")
	raw, err := os.ReadFile(path) //nolint:gosec // G304: the path is the running binary's own directory joined with a constant file name
	if err != nil {
		return mlswasi.ABIInfo{}, fmt.Errorf("read %s: %w", path, err)
	}
	rt, err := mlswasi.New(ctx, raw, mlswasi.Options{})
	if err != nil {
		return mlswasi.ABIInfo{}, fmt.Errorf("load %s: %w", path, err)
	}
	defer func() { _ = rt.Close(ctx) }()
	return rt.ABI(ctx)
}
