//go:build !linux

package helper

func launch(Options) (exchange, error) { return nil, ErrUnsupportedPlatform }
