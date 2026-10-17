//go:build unix

package main

import "syscall"

// restrictUmask makes every file and directory dillad creates owner-only whatever the caller's
// umask (R17): the database's -wal and -shm, blobs, the lock file and the ACME files. The unit's
// UMask=0077 only covered a service started by systemd.
func restrictUmask() { syscall.Umask(0o077) }
