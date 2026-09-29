package testkit

import (
	"bytes"
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type ScenarioResult struct {
	Name   string
	Steps  int
	Stdout string
	Stderr string
	Err    error
}

// ScenarioTimeout bounds one scenario run. The join storm enrols 1,001 clients and joins a
// thousand of them to one group, which is the slowest thing any scenario does.
const ScenarioTimeout = 10 * time.Minute

// Run spawns dilla-testkit for one scenario, pointing it at this harness with --ds.
func (h *Harness) Run(tb testing.TB, scenario string) ScenarioResult {
	tb.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), ScenarioTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, h.binary, "run", scenario, "--ds", h.BaseURL())
	cmd.Env = append(cmd.Environ(),
		"DILLA_TESTKIT_CONTROL="+h.ControlURL(),
		"DILLA_TESTKIT_INVITE="+h.Invite(),
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()

	return ScenarioResult{
		Name:   filepath.Base(scenario),
		Steps:  countSteps(stdout.String()),
		Stdout: stdout.String(),
		Stderr: stderr.String(),
		Err:    err,
	}
}

// CommitCount is how many commits the instance accepted, read from the DS's own counter. A
// scenario that asserts "at most four commits" needs the server's count, not the client's.
//
// The counter is the running server's: restore_snapshot starts a new one, which counts from zero.
func (h *Harness) CommitCount() int { return h.host.Server().CommitCount() }

// countSteps reads dilla-testkit's own step report off its stdout. The runner prints one line per
// executed statement, `ok   line N: …` or `FAIL line N: …` (RunReport::to_text), so a scenario
// that parsed but executed nothing is caught by the harness rather than reported as a pass.
func countSteps(stdout string) int {
	n := 0
	for line := range strings.SplitSeq(stdout, "\n") {
		if strings.HasPrefix(line, "ok   line ") || strings.HasPrefix(line, "FAIL line ") {
			n++
		}
	}
	return n
}
