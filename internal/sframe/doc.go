// Package sframe is dilla-sframe/1 (protocol/05-media-frames.md) in pure Go: the frame cipher, the
// codec prefixes, the sender's counter partition and the receiver's key ring. It is the same
// protocol as core/dilla-core/src/sframe — which browsers run as wasm — and the two agree byte for
// byte on protocol/vectors/sframe.json (vectors_test.go).
//
// It exists for Go publishers and decryptors: the capacity rig, the cross-SDK media bot and, later,
// a bot SDK. It uses the standard library only — no cgo, no wazero call per frame (DEV-39). dillad
// never imports it: dillad holds no frame key (TestDilladDoesNotImportTheMediaPackages in
// internal/sfu).
package sframe
