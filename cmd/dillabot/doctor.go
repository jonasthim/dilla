//go:build linux

package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/jonasthim/dilla/internal/mlswasi"
)

type botDoctorCheck struct {
	name   string
	status string
}

var doctorWASI = func(ctx context.Context, binary []byte) error {
	runtime, err := mlswasi.New(ctx, binary, mlswasi.Options{PoolSize: 1})
	if err != nil {
		return err
	}
	return runtime.Close(ctx)
}

// runDoctorCommand checks the local files and permissions dillabot needs before
// it can start. It does not contact Dilla or a music provider, and never prints
// credential contents or configured filesystem paths.
func runDoctorCommand(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("dillabot doctor", flag.ContinueOnError)
	flags.SetOutput(stderr)
	configPath := flags.String("config", "/etc/dilla/bot.toml", "path to the bot service TOML config")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(stderr, "dillabot doctor: unexpected argument")
		return 2
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		fmt.Fprintln(stdout, "FAIL config: configuration or protected runtime credential is invalid")
		return 1
	}

	checks := []botDoctorCheck{
		{name: "runtime_credential", status: "OK: protected owner-only credential is available"},
	}
	if err := validateHelperExecutable(cfg.HelperExecutable); err != nil {
		checks = append(checks, botDoctorCheck{name: "native_helper", status: "FAIL: executable helper is unavailable or unsafe"})
	} else {
		checks = append(checks, botDoctorCheck{name: "native_helper", status: "OK: executable helper is available"})
	}
	if cfg.SpotifyHelperExecutable != "" {
		if err := validateHelperExecutable(cfg.SpotifyHelperExecutable); err != nil {
			checks = append(checks, botDoctorCheck{name: "spotify_pcm_helper", status: "FAIL: executable helper is unavailable or unsafe"})
		} else {
			checks = append(checks, botDoctorCheck{name: "spotify_pcm_helper", status: "OK: executable helper is available"})
		}
	}
	if binary, readErr := readDoctorWASI(cfg.WASIModule); readErr != nil {
		checks = append(checks, botDoctorCheck{name: "wasi_identity_module", status: "FAIL: module is unavailable or unsafe"})
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		healthErr := doctorWASI(ctx, binary)
		cancel()
		clear(binary)
		if healthErr != nil {
			checks = append(checks, botDoctorCheck{name: "wasi_identity_module", status: "FAIL: module failed startup validation"})
		} else {
			checks = append(checks, botDoctorCheck{name: "wasi_identity_module", status: "OK: module compiles and initializes"})
		}
	}
	if err := validatePrivateStateDir(cfg.StateDir); err != nil {
		checks = append(checks, botDoctorCheck{name: "state_directory", status: "FAIL: directory must be owned by the service account with mode 0700"})
	} else {
		checks = append(checks, botDoctorCheck{name: "state_directory", status: "OK: private service-owned directory is ready"})
	}

	failed := false
	for _, check := range checks {
		fmt.Fprintf(stdout, "%s %s\n", check.name, check.status)
		if len(check.status) >= 4 && check.status[:4] == "FAIL" {
			failed = true
		}
	}
	if failed {
		return 1
	}
	return 0
}

func readDoctorWASI(path string) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, os.ErrInvalid
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "wasi-module")
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > 64<<20 || !trustedLocalCode(info) {
		return nil, os.ErrInvalid
	}
	return io.ReadAll(f)
}

func validatePrivateStateDir(path string) error {
	if !filepath.IsAbs(path) {
		return os.ErrInvalid
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !ok || int64(st.Uid) != int64(os.Geteuid()) || info.Mode().Perm() != 0o700 {
		return os.ErrPermission
	}
	return nil
}
