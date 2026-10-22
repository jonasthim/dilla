package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/ops"
)

// stubMediaRefreshPending points the doctor at a pending file in a temp dir, trusted as this test's
// own uid (the real one must be root's).
func stubMediaRefreshPending(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pending")
	prevPath, prevUID := mediaRefreshPendingPath, mediaRefreshTrustedUID
	mediaRefreshPendingPath, mediaRefreshTrustedUID = path, os.Getuid()
	t.Cleanup(func() { mediaRefreshPendingPath, mediaRefreshTrustedUID = prevPath, prevUID })
	return path
}

// UP3 fix round 3: dilla-media-refresh restarts the SFU only when `media --idle` says its rooms are
// idle, and --idle asks that same SFU, so an SFU can defer its own restart forever. The doctor
// surfaces it from the root timer's own record: yellow at first, red after 24 h.
func TestTheDoctorSurfacesADeferredMediaRestart(t *testing.T) {
	cfg := sidecarConfig(t)
	path := stubMediaRefreshPending(t)
	now := time.Unix(1_800_000_000, 0)
	stubMediaMainPID(t, 77, nil)
	write := func(body string, mode os.FileMode) {
		t.Helper()
		if err := os.WriteFile(path, []byte(body), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
	}

	if leg := doctorMediaRefreshLeg(t.Context(), cfg, now); leg.Status != ops.Green || leg.Name != "media_refresh" {
		t.Errorf("no record: %+v", leg)
	}
	write(fmt.Sprintf("pid=77 since=%d\n", now.Add(-3*time.Hour).Unix()), 0o644)
	leg := doctorMediaRefreshLeg(t.Context(), cfg, now)
	if leg.Status != ops.Yellow || !strings.Contains(leg.Detail, "3h0m0s") || !strings.Contains(leg.Detail, "another executable than the installed dillad") {
		t.Errorf("3 h: %+v", leg)
	}
	write(fmt.Sprintf("pid=77 since=%d\n", now.Add(-25*time.Hour).Unix()), 0o644)
	leg = doctorMediaRefreshLeg(t.Context(), cfg, now)
	if leg.Status != ops.Red || !strings.Contains(leg.Fix, "systemctl restart dilla-media") {
		t.Errorf("25 h: %+v", leg)
	}
	// A record for another media process is over: that process is gone.
	write(fmt.Sprintf("pid=12 since=%d\n", now.Add(-25*time.Hour).Unix()), 0o644)
	if leg = doctorMediaRefreshLeg(t.Context(), cfg, now); leg.Status != ops.Green {
		t.Errorf("another pid: %+v", leg)
	}
	// Anyone but root could have written a group- or world-writable file: not believed.
	write(fmt.Sprintf("pid=77 since=%d\n", now.Add(-25*time.Hour).Unix()), 0o666)
	if leg = doctorMediaRefreshLeg(t.Context(), cfg, now); leg.Status != ops.Yellow || !strings.Contains(leg.Detail, "ignored") {
		t.Errorf("writable by others: %+v", leg)
	}
	write("pid=77 since=soon\n", 0o644)
	if leg = doctorMediaRefreshLeg(t.Context(), cfg, now); leg.Status != ops.Yellow || !strings.Contains(leg.Detail, "ignored") {
		t.Errorf("malformed: %+v", leg)
	}
	cfg.LiveKit.Mode = "in_process"
	if leg = doctorMediaRefreshLeg(t.Context(), cfg, now); leg.Status != ops.Green || !strings.Contains(leg.Detail, "skipped") {
		t.Errorf("in-process: %+v", leg)
	}
}
