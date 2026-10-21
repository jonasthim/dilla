package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/ops"
	"github.com/jonasthim/dilla/internal/sfu"
)

type fakeRoomInfos struct {
	rooms []*livekit.Room
	err   error
}

func (f fakeRoomInfos) RoomInfos(context.Context) ([]*livekit.Room, error) { return f.rooms, f.err }

func idleRoom(name string, participants uint32, created time.Time) *livekit.Room {
	r := &livekit.Room{Name: name, NumParticipants: participants}
	if !created.IsZero() {
		r.CreationTime = created.Unix()
		r.CreationTimeMs = created.UnixMilli()
	}
	return r
}

func TestMediaIdle(t *testing.T) {
	now := time.Now()
	for _, tc := range []struct {
		name       string
		remote     fakeRoomInfos
		want       error // nil: idle
		stderrHas  []string
		stdoutHas  string
		stderrNone bool
	}{
		{name: "an empty SFU is idle", remote: fakeRoomInfos{}, stdoutHas: "0 rooms", stderrNone: true},
		{name: "a room with 0 participants created 10 s ago is busy",
			remote:    fakeRoomInfos{rooms: []*livekit.Room{idleRoom("young", 0, now.Add(-10*time.Second))}},
			want:      exit.Fail,
			stderrHas: []string{"young\t0 participants"}},
		{name: "a room with 0 participants created 2 min ago is idle",
			remote: fakeRoomInfos{rooms: []*livekit.Room{idleRoom("old", 0, now.Add(-2*time.Minute))}}, stdoutHas: "1 rooms", stderrNone: true},
		{name: "a room with participants is busy however old",
			remote:    fakeRoomInfos{rooms: []*livekit.Room{idleRoom("live", 3, now.Add(-time.Hour))}},
			want:      exit.Fail,
			stderrHas: []string{"live\t3 participants"}},
		{name: "a room whose age is unknown is busy",
			remote:    fakeRoomInfos{rooms: []*livekit.Room{idleRoom("unknown", 0, time.Time{})}},
			want:      exit.Fail,
			stderrHas: []string{"unknown\t0 participants\tage unknown"}},
		{name: "only the busy rooms are listed, sorted",
			remote: fakeRoomInfos{rooms: []*livekit.Room{
				idleRoom("b-live", 1, now.Add(-time.Hour)), idleRoom("idle", 0, now.Add(-time.Hour)), idleRoom("a-young", 0, now)}},
			want:      exit.Fail,
			stderrHas: []string{"a-young\t", "b-live\t"}},
		{name: "an SFU that does not answer cannot tell",
			remote: fakeRoomInfos{err: errors.New("connection refused")}, want: exit.Unavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			err := mediaIdle(t.Context(), tc.remote, noMints, now, &stdout, &stderr, time.Second)
			if tc.want == nil {
				if err != nil {
					t.Fatalf("err = %v, want idle", err)
				}
			} else if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want exit code %d", err, tc.want)
			}
			if tc.stdoutHas != "" && !strings.Contains(stdout.String(), tc.stdoutHas) {
				t.Errorf("stdout = %q, want it to contain %q", stdout.String(), tc.stdoutHas)
			}
			for _, h := range tc.stderrHas {
				if !strings.Contains(stderr.String(), h) {
					t.Errorf("stderr = %q, want it to contain %q", stderr.String(), h)
				}
			}
			if tc.stderrNone && stderr.Len() != 0 {
				t.Errorf("stderr = %q, want nothing", stderr.String())
			}
			if tc.name == "only the busy rooms are listed, sorted" {
				if strings.Contains(stderr.String(), "idle\t") || strings.Index(stderr.String(), "a-young") > strings.Index(stderr.String(), "b-live") {
					t.Errorf("stderr = %q, want a-young then b-live and no idle room", stderr.String())
				}
			}
		})
	}
}

func TestMediaIdleIsExclusiveWithTheOtherModes(t *testing.T) {
	for _, other := range []string{"--probe", "--rooms"} {
		var stderr bytes.Buffer
		err := runMedia([]string{"--idle", other}, &bytes.Buffer{}, &stderr)
		if !errors.Is(err, exit.Usage) {
			t.Errorf("--idle %s: err = %v, want exit.Usage", other, err)
		}
		if !strings.Contains(stderr.String(), "exclusive") {
			t.Errorf("--idle %s: stderr = %q", other, stderr.String())
		}
	}
}

func TestMediaIdleExitsUnavailableWhenNothingListens(t *testing.T) {
	fd := sfuDeps(t, func(lk *config.LiveKit) { lk.Mode = "sidecar" })
	// Nothing listens on the freed port sfuDeps picked.
	remote := sfu.NewRemote(sfuConfig(fd.cfg.LiveKit, strings.Repeat("s", 40)))
	err := mediaIdle(t.Context(), remote, noMints, time.Now(), &bytes.Buffer{}, &bytes.Buffer{}, 2*time.Second)
	if code, ok := exitCode(err); !ok || code != exit.Unavailable {
		t.Fatalf("err = %v, want exit.Unavailable (69)", err)
	}
}

// shortSocketDir returns a directory whose paths fit a unix socket's sun_path.
func shortSocketDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "m-") //nolint:usetesting // t.TempDir exceeds Linux sun_path under the required TMPDIR.
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func stubMediaMainPID(t *testing.T, pid int, err error) {
	t.Helper()
	prev := mediaMainPID
	mediaMainPID = func(context.Context) (int, error) { return pid, err }
	t.Cleanup(func() { mediaMainPID = prev })
}

// media.json is written before READY=1 is sent, so a unit that is "started" always has a valid
// file; a clean stop removes it.
func TestServeMediaWritesMediaJSONBeforeReadyAndRemovesItOnACleanStop(t *testing.T) {
	stubMediaMainPID(t, os.Getpid(), nil)
	fd := sfuDeps(t, func(lk *config.LiveKit) { lk.Mode = "sidecar" })
	state := t.TempDir()
	fd.cfg.Instance.DataDir = state

	sock := filepath.Join(shortSocketDir(t), "n.sock")
	ln, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: sock, Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	t.Setenv("NOTIFY_SOCKET", sock)

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- serveMedia(ctx, fd.cfg, &bytes.Buffer{}, &bytes.Buffer{}) }()

	_ = ln.SetReadDeadline(time.Now().Add(30 * time.Second))
	buf := make([]byte, 64)
	n, err := ln.Read(buf)
	if err != nil {
		t.Fatalf("no READY=1 from media: %v", err)
	}
	if string(buf[:n]) != "READY=1" {
		t.Fatalf("datagram = %q, want READY=1", buf[:n])
	}
	// READY has arrived: the file must already be there, complete and private.
	info, err := os.Stat(filepath.Join(state, "media.json"))
	if err != nil {
		t.Fatalf("media.json is not there at READY=1: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("media.json mode = %04o, want 0600", info.Mode().Perm())
	}
	st, err := readMediaState(t.Context(), state)
	if err != nil {
		t.Fatalf("media.json at READY=1: %v", err)
	}
	if st.Version != Version || st.MediaLevel != sfu.MediaLevel || st.PID != os.Getpid() || st.Started.IsZero() {
		t.Errorf("media.json = %+v", st)
	}
	if st.Capabilities == nil || len(st.Capabilities) != 0 {
		t.Errorf("capabilities = %#v, want [] (turn is added once a listener is bound)", st.Capabilities)
	}
	leftovers, _ := filepath.Glob(filepath.Join(state, ".media.json.*"))
	if len(leftovers) != 0 {
		t.Errorf("temporary files left behind: %v", leftovers)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("media shutdown: %v", err)
		}
	case <-time.After(25 * time.Second):
		t.Fatal("media did not stop")
	}
	if _, err := os.Stat(filepath.Join(state, "media.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("media.json after a clean stop: %v, want it removed", err)
	}
}

func sidecarConfig(t *testing.T) *config.Config {
	t.Helper()
	cfg := config.Default()
	cfg.LiveKit.Enabled, cfg.LiveKit.Mode = true, "sidecar"
	cfg.Instance.DataDir = t.TempDir()
	return cfg
}

func TestTheDoctorTreatsAMediaJSONWithAnotherPIDAsAbsent(t *testing.T) {
	cfg := sidecarConfig(t)
	if err := writeMediaState(cfg.Instance.DataDir, mediaState{Version: Version, MediaLevel: sfu.MediaLevel, PID: 4242, Started: time.Now()}); err != nil {
		t.Fatal(err)
	}
	stubMediaMainPID(t, 4242, nil)
	if _, err := readMediaState(t.Context(), cfg.Instance.DataDir); err != nil {
		t.Fatalf("a file whose pid is the unit's MainPID: %v", err)
	}
	if leg := doctorMediaBinaryLeg(t.Context(), cfg); leg.Status != ops.Green {
		t.Fatalf("matching pid: %v %s", leg.Status, leg.Detail)
	}

	stubMediaMainPID(t, 9999, nil) // the unit restarted: the file is a corpse
	if _, err := readMediaState(t.Context(), cfg.Instance.DataDir); !errors.Is(err, errNoMediaState) {
		t.Fatalf("a stale file: err = %v, want errNoMediaState", err)
	}
	leg := doctorMediaBinaryLeg(t.Context(), cfg)
	if leg.Status != ops.Yellow || !strings.Contains(leg.Detail, "dilla-media-refresh.timer") {
		t.Fatalf("a stale file reads as absent (yellow): %v %s", leg.Status, leg.Detail)
	}

	stubMediaMainPID(t, 0, nil) // the unit is not running
	if _, err := readMediaState(t.Context(), cfg.Instance.DataDir); !errors.Is(err, errNoMediaState) {
		t.Fatalf("unit not running: err = %v, want errNoMediaState", err)
	}
}

func TestTheMediaBinaryLegHasThreeColours(t *testing.T) {
	cfg := sidecarConfig(t)
	write := func(version string, level, pid int) {
		t.Helper()
		if err := writeMediaState(cfg.Instance.DataDir, mediaState{Version: version, MediaLevel: level, PID: pid, Started: time.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	stubMediaMainPID(t, 7, nil)

	// Yellow: no file at all.
	leg := doctorMediaBinaryLeg(t.Context(), cfg)
	if leg.Status != ops.Yellow || !strings.Contains(leg.Detail, "restarts onto this binary when its calls end (dilla-media-refresh.timer)") {
		t.Errorf("no file: %v %q", leg.Status, leg.Detail)
	}
	// Green: the SFU runs this version.
	write(Version, sfu.MediaLevel, 7)
	if leg = doctorMediaBinaryLeg(t.Context(), cfg); leg.Status != ops.Green {
		t.Errorf("same version: %v %q", leg.Status, leg.Detail)
	}
	// Yellow: an older level that is still compatible.
	write("0.1.0-web3.11", sfu.MinSFUMediaLevel, 7)
	leg = doctorMediaBinaryLeg(t.Context(), cfg)
	want := fmt.Sprintf("dilla-media runs v0.1.0-web3.11, an older media level (%d) than this binary's (%d); "+
		"it restarts onto this binary when its calls end (dilla-media-refresh.timer)", sfu.MinSFUMediaLevel, sfu.MediaLevel)
	if leg.Status != ops.Yellow || leg.Detail != want {
		t.Errorf("older: %v %q, want yellow %q", leg.Status, leg.Detail, want)
	}
	// Yellow: after a rollback the SFU may run a newer build; it is never called older.
	write("0.1.0-web3.99", sfu.MediaLevel+1, 7)
	if leg = doctorMediaBinaryLeg(t.Context(), cfg); leg.Status != ops.Yellow || strings.Contains(leg.Detail, "older") ||
		!strings.Contains(leg.Detail, "a newer media level") {
		t.Errorf("newer: %v %q", leg.Status, leg.Detail)
	}
	// Yellow: another build at this level differs, and says so.
	write("0.1.0-web3.12-rc1", sfu.MediaLevel, 7)
	if leg = doctorMediaBinaryLeg(t.Context(), cfg); leg.Status != ops.Yellow || !strings.Contains(leg.Detail, "differs from this binary's v"+Version) {
		t.Errorf("same level, other build: %v %q", leg.Status, leg.Detail)
	}
	// Red: below the oldest level this API works with.
	write("0.1.0-web3.10", sfu.MinSFUMediaLevel-1, 7)
	if leg = doctorMediaBinaryLeg(t.Context(), cfg); leg.Status != ops.Red {
		t.Errorf("below MinSFUMediaLevel: %v %q", leg.Status, leg.Detail)
	}
	// Green and skipped when the SFU is not a sidecar.
	cfg.LiveKit.Mode = "in_process"
	if leg = doctorMediaBinaryLeg(t.Context(), cfg); leg.Status != ops.Green || !strings.Contains(leg.Detail, "skipped") {
		t.Errorf("in-process: %v %q", leg.Status, leg.Detail)
	}
}

var updateSFUConfigGolden = flag.Bool("update-sfu-config", false, "rewrite testdata/sfu-config.sha256")

// pinnedLiveKit is a fixed [livekit] section: every field sfuConfig maps is set.
func pinnedLiveKit() config.LiveKit {
	return config.LiveKit{
		Enabled: true, Mode: "sidecar", Port: 7880, BindAddress: "127.0.0.1", NodeIP: "198.51.100.9",
		UDPPort: 7882, TCPPort: 7881, APIKey: "dilla", AdvertiseInternalIP: true,
		STUNServers: []string{"198.51.100.7:3478"}, MaxVoiceParticipants: 25, VP9: true,
		WebhookListen: "127.0.0.1:7890", LimitNumTracks: 600, LimitBytesPerSec: 12500000,
		IPsExcludes: []string{"172.17.0.0/16"},
	}
}

// The other half of internal/sfu's level guard: dilla.toml -> sfu.Config -> the rendered YAML. A
// change to how a dilla.toml key reaches LiveKit changes the contract with a running SFU.
func TestSFUConfigMappingIsPinned(t *testing.T) {
	yaml, err := sfuConfig(pinnedLiveKit(), strings.Repeat("s", 40)).YAML()
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(yaml))
	got := hex.EncodeToString(sum[:]) + "\n"
	const golden = "testdata/sfu-config.sha256"
	if *updateSFUConfigGolden {
		if err := os.WriteFile(golden, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != got {
		t.Fatalf("the sfu config rendered from dilla.toml changed: bump MediaLevel (internal/sfu/level.go), "+
			"then run go test ./cmd/dillad -run TestSFUConfigMappingIsPinned -update-sfu-config\npinned %s got %s\n%s",
			strings.TrimSpace(string(want)), strings.TrimSpace(got), yaml)
	}
}
