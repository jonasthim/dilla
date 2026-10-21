//go:build !linux

package server

import (
	"errors"
	"net"
)

// peerUID has no SO_PEERCRED to read outside Linux, so every control socket connection is refused:
// the sockets fail closed where the peer cannot be told apart.
func peerUID(net.Conn) (uint32, error) {
	return 0, errors.New("control socket: the peer's uid cannot be read on this platform")
}
