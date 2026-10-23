package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/ops"
)

// mediaRefreshPendingPath is where dilla-media-refresh (root, every minute) records since when the
// running dilla-media has run another executable than the installed dillad without becoming idle:
// "pid=<MainPID> since=<unix seconds>". It is root's (0644 in a 0755 directory), so dillad can read
// it but never write it. A variable so a test can point it elsewhere.
var mediaRefreshPendingPath = "/var/lib/dilla-media-refresh/pending"

// mediaRefreshTrustedUID is the only owner whose pending file is believed: root. A variable so a
// test, which is not root, can stand in its own uid.
var mediaRefreshTrustedUID = 0

// mediaRefreshRedAfter is how long a deferred SFU restart stays yellow.
const mediaRefreshRedAfter = 24 * time.Hour

// doctorMediaRefreshLeg reports a deferred SFU restart. dilla-media-refresh restarts dilla-media
// only once `dillad media --idle` says no call needs it, and --idle asks that same SFU, so an SFU
// that is always busy (or answers busy) is never moved onto the installed binary. Nothing forces it:
// this leg says for how long it has lasted, yellow at first and red after 24 h.
func doctorMediaRefreshLeg(ctx context.Context, cfg *config.Config, now time.Time) ops.Leg {
	const name = "media_refresh"
	if !cfg.LiveKit.Enabled || cfg.LiveKit.Mode != "sidecar" {
		return ops.Leg{Name: name, Status: ops.Green, Detail: "skipped: the SFU is not a sidecar"}
	}
	pid, since, err := readMediaRefreshPending()
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return ops.Leg{Name: name, Status: ops.Green, Detail: "no restart of dilla-media is pending"}
	case err != nil:
		return ops.Leg{Name: name, Status: ops.Yellow, Detail: mediaRefreshPendingPath + " ignored: " + err.Error()}
	}
	main, err := mediaMainPID(ctx)
	if err != nil || main != pid {
		return ops.Leg{Name: name, Status: ops.Green, Detail: "no restart of dilla-media is pending (the record names an earlier process)"}
	}
	age := now.Sub(since).Truncate(time.Second)
	detail := fmt.Sprintf("dilla-media (pid %d) has run another executable than the installed dillad for %s: "+
		"dilla-media-refresh.timer restarts it only once `dillad media --idle` says its rooms are idle", pid, age)
	if age < mediaRefreshRedAfter {
		return ops.Leg{Name: name, Status: ops.Yellow, Detail: detail}
	}
	return ops.Leg{Name: name, Status: ops.Red, Detail: detail + "; it has not been idle for more than 24 h",
		Fix: "check its rooms with `dillad media --rooms`; systemctl restart dilla-media moves it onto the installed binary and ends its calls"}
}

// readMediaRefreshPending reads and checks the pending file: root's, not writable by group or
// others, and exactly "pid=<n> since=<unix>".
func readMediaRefreshPending() (int, time.Time, error) {
	fi, err := os.Lstat(mediaRefreshPendingPath)
	if err != nil {
		return 0, time.Time{}, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !fi.Mode().IsRegular() || !ok || int(st.Uid) != mediaRefreshTrustedUID || fi.Mode().Perm()&0o022 != 0 {
		return 0, time.Time{}, errors.New("it is not a regular file of root's that only root can write")
	}
	raw, err := os.ReadFile(mediaRefreshPendingPath)
	if err != nil {
		return 0, time.Time{}, err
	}
	fields := strings.Fields(string(raw))
	if len(fields) != 2 || !strings.HasPrefix(fields[0], "pid=") || !strings.HasPrefix(fields[1], "since=") {
		return 0, time.Time{}, errors.New("malformed")
	}
	pid, err1 := strconv.Atoi(strings.TrimPrefix(fields[0], "pid="))
	sec, err2 := strconv.ParseInt(strings.TrimPrefix(fields[1], "since="), 10, 64)
	if err1 != nil || err2 != nil || pid <= 0 || sec <= 0 {
		return 0, time.Time{}, errors.New("malformed")
	}
	return pid, time.Unix(sec, 0), nil
}
