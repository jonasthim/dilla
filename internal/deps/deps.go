//go:build dillapins

// Package deps pins the modules go.mod requires but no ordinary dilla build
// imports yet. `go mod tidy` considers imports under every build tag, so these
// blank imports keep the pins in go.mod, while the `dillapins` tag keeps the
// LiveKit SFU out of every ordinary compile.
//
// Build the package explicitly to prove the whole pinned tree still compiles
// with the three pion `replace` directives:
//
//	CGO_ENABLED=0 go build -tags dillapins ./internal/deps
//
// It must never import github.com/livekit/server-sdk-go/v2/pkg/media: that
// package needs cgo and libopus headers (gap-21 §3).
package deps

import (
	_ "github.com/coder/websocket"
	_ "github.com/fxamacker/cbor/v2"
	_ "github.com/livekit/livekit-server/pkg/config"
	_ "github.com/livekit/livekit-server/pkg/routing"
	_ "github.com/livekit/livekit-server/pkg/service"
	_ "github.com/livekit/livekit-server/pkg/telemetry/prometheus"
	_ "github.com/livekit/protocol/auth"
	_ "github.com/livekit/server-sdk-go/v2"
	_ "github.com/pion/turn/v5"
	_ "github.com/tetratelabs/wazero"
	_ "github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
	_ "modernc.org/sqlite"
)
