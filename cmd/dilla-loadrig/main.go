// Command dilla-loadrig is dilla's own capacity rig (SP-29, DEV-64): Go participants on lksdk that
// publish and decrypt dilla-sframe/1 media through one dillad's LiveKit, and a sampler that reads the
// SFU host's counters across each cell. It publishes only what it measured. It is a test tool: the
// release job builds cmd/dillad only.
package main

import (
	"context"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/jonasthim/dilla/internal/sfu"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "dilla-loadrig:", err)
		os.Exit(1)
	}
}

func run() error {
	localSFU := flag.Bool("local-sfu", false, "start LiveKit in this process on 127.0.0.1:7880/7882 and measure it (the dev-box loopback run)")
	lkURL := flag.String("lk-url", "", "LiveKit signalling URL, ws://<livekit.bind_address>:7880")
	lkHTTP := flag.String("lk-http", "", "LiveKit HTTP URL for RoomService, http://<livekit.bind_address>:7880")
	apiKey := flag.String("api-key", "dilla", "the operator's livekit.api_key")
	secretFile := flag.String("api-secret-file", "", "the operator's livekit.api_secret_file")
	metricsURL := flag.String("metrics", "", "dillad's /metrics URL")
	iface := flag.String("iface", "lo", "the SFU host interface whose /proc/net/dev bytes are the wire numbers")
	sshTarget := flag.String("ssh", "", "read /proc on the SFU host through `ssh <target> cat`; empty reads locally")
	pid := flag.Int("dillad-pid", 0, "dillad's pid on the SFU host (with -local-sfu: this process)")
	voice := flag.String("voice", "", "the ≥ 90 s Ogg Opus voice fixture")
	shareQ := flag.String("share-q", "", "the ≥ 90 s VP8 IVF at 480×270, 150 kbit/s")
	shareH := flag.String("share-h", "", "the ≥ 90 s VP8 IVF at 960×540, 625 kbit/s")
	shareF := flag.String("share-f", "", "the ≥ 90 s VP8 IVF at 1920×1080, 2.5 Mbit/s")
	cellsFlag := flag.String("cells", "all", `"all" or a comma list of cell names`)
	warmup := flag.Duration("warmup", 15*time.Second, "time after the last publish before sampling")
	hold := flag.Duration("hold", 60*time.Second, "sampling window per cell (at least 30 s)")
	location := flag.String("location", "", `where the SFU runs, e.g. "founder LXC, LAN"`)
	commit := flag.String("commit", "", "the measured commit")
	baseKey := flag.String("base-key", strings.Repeat("0a", 16), "the fixed rig base key")
	outPath := flag.String("out", "", "append the table rows to this file as well")
	flag.Parse()

	if *hold < MinHold {
		return errors.New("-hold must be at least 30s: the counter moves in 5 s steps and the card reads rate over [30s]")
	}
	cells, err := Select(*cellsFlag)
	if err != nil {
		return err
	}
	key, err := hex.DecodeString(*baseKey)
	if err != nil || len(key) != 16 {
		return errors.New("-base-key must be 32 hex")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	o := Options{APIKey: *apiKey, Iface: *iface, DilladPID: *pid, VoiceFile: *voice,
		ShareFiles: map[Layer]string{LayerQ: *shareQ, LayerH: *shareH, LayerF: *shareF}, Warmup: *warmup, Hold: *hold, Files: LocalReader}
	copy(o.BaseKey[:], key)
	if *sshTarget != "" {
		o.Files = SSHReader(*sshTarget)
	}
	if *localSFU {
		cfg := sfu.DefaultConfig()
		cfg.APISecret = "dilla-loadrig-local-secret-0123456789"
		srv, err := sfu.Start(ctx, cfg)
		if err != nil {
			return err
		}
		defer func() { _ = srv.Stop(context.Background()) }()
		ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", "127.0.0.1:0")
		if err != nil {
			return err
		}
		ms := &http.Server{Handler: promhttp.HandlerFor(prometheus.DefaultGatherer, promhttp.HandlerOpts{}), ReadHeaderTimeout: 5 * time.Second}
		go func() { _ = ms.Serve(ln) }()
		defer func() { _ = ms.Close() }()
		o.LiveKitURL, o.LiveKitHTTP, o.APIKey, o.APISecret = srv.URL(), srv.HTTPURL(), cfg.APIKey, cfg.APISecret
		o.Metrics, o.DilladPID, o.Files = HTTPMetrics("http://"+ln.Addr().String()+"/metrics"), os.Getpid(), LocalReader
	} else {
		if *lkURL == "" || *lkHTTP == "" || *secretFile == "" || *metricsURL == "" || *pid == 0 {
			return errors.New("without -local-sfu, -lk-url, -lk-http, -api-secret-file, -metrics and -dillad-pid are required")
		}
		secret, err := os.ReadFile(*secretFile)
		if err != nil {
			return err
		}
		o.LiveKitURL, o.LiveKitHTTP, o.APISecret, o.Metrics = *lkURL, *lkHTTP, strings.TrimSpace(string(secret)), HTTPMetrics(*metricsURL)
	}

	var out *os.File
	if *outPath != "" {
		if out, err = os.OpenFile(*outPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err != nil {
			return err
		}
		defer func() { _ = out.Close() }()
	}
	emit := func(line string) {
		fmt.Println(line)
		if out != nil {
			fmt.Fprintln(out, line)
		}
	}
	emit(fmt.Sprintf("<!-- egress = %s; ingress = %s; wire = /proc/net/dev %s tx -->", PromQLEgress, PromQLIngress, *iface))
	emit(TableHeader)
	date := time.Now().UTC().Format("2006-01-02")
	for _, c := range cells {
		res, err := RunCell(ctx, o, c)
		if err != nil {
			return fmt.Errorf("%s: %w", c.Name, err)
		}
		emit(res.Row(*location, date, *commit))
		if res.DecryptOKPercent != 100 {
			fmt.Fprintf(os.Stderr, "%s: decrypt-ok %.2f %% — dropped %v\n", c.Name, res.DecryptOKPercent, res.Dropped)
		}
	}
	return nil
}
