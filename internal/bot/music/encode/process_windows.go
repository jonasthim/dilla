//go:build windows

package encode

import "os/exec"

func configureProcessGroup(cmd *exec.Cmd) {
	// Windows has no POSIX process groups. FFmpeg is the sole child in this bridge.
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return cmd.Process.Kill()
	}
}
