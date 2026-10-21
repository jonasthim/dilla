//go:build linux

package main

import (
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"syscall"
)

func openSecretParent(path string) (*os.File, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	fd, err := syscall.Open(string(filepath.Separator), syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	var rootStat syscall.Stat_t
	if err := syscall.Fstat(fd, &rootStat); err != nil {
		_ = syscall.Close(fd)
		return nil, err
	}
	if (rootStat.Uid != 0 && !statOwnedByCurrent(&rootStat)) || (rootStat.Mode&0o022 != 0 && rootStat.Mode&syscall.S_ISVTX == 0) {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("path ancestor must be owned by root or current user")
	}
	parts := strings.FieldsFunc(strings.TrimPrefix(filepath.Clean(abs), string(filepath.Separator)), func(r rune) bool { return r == '/' })
	if len(parts) == 0 {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("directory must be owned and mode 0700")
	}
	for i, part := range parts {
		next, openErr := syscall.Openat(fd, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		_ = syscall.Close(fd)
		if openErr != nil {
			return nil, openErr
		}
		fd = next
		var st syscall.Stat_t
		if err := syscall.Fstat(fd, &st); err != nil {
			_ = syscall.Close(fd)
			return nil, err
		}
		mode := os.FileMode(st.Mode & 0o7777)
		trustedOwner := st.Uid == 0 || statOwnedByCurrent(&st)
		if i == len(parts)-1 {
			if mode.Perm() != 0o700 || !trustedOwner {
				_ = syscall.Close(fd)
				return nil, fmt.Errorf("directory must be owned and mode 0700")
			}
		} else if !trustedOwner || (mode&0o022 != 0 && st.Mode&syscall.S_ISVTX == 0) {
			_ = syscall.Close(fd)
			return nil, fmt.Errorf("writable path ancestor is not sticky and trusted")
		}
	}
	return os.NewFile(uintptr(fd), abs), nil
}

func statOwnedByCurrent(st *syscall.Stat_t) bool {
	current, err := user.Current()
	return err == nil && fmt.Sprint(st.Uid) == current.Uid
}

func openNewSecretFileAt(dir *os.File, name string) (*os.File, error) {
	fd, err := syscall.Openat(int(dir.Fd()), name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), name), nil
}

func unlinkCreatedSecret(dir *os.File, name string, identity os.FileInfo) error {
	if identity == nil {
		return fmt.Errorf("cannot verify created secret inode")
	}
	fd, err := syscall.Openat(int(dir.Fd()), name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		if err == syscall.ENOENT {
			return nil
		}
		return err
	}
	var current syscall.Stat_t
	err = syscall.Fstat(fd, &current)
	_ = syscall.Close(fd)
	if err != nil {
		return err
	}
	expected, ok := identity.Sys().(*syscall.Stat_t)
	if !ok || current.Dev != expected.Dev || current.Ino != expected.Ino {
		return fmt.Errorf("secret path no longer names the file created by this operation")
	}
	return syscall.Unlinkat(int(dir.Fd()), name)
}
