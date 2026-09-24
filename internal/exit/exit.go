// Package exit is dillad's process exit vocabulary. Every command path returns
// an error that unwraps to a Code, so main has one place that calls os.Exit and
// an operator's shell sees a number that means something (BSD sysexits, plus 2
// for a usage error and 3 for a verb this build reserves).
package exit

import (
	"errors"
	"fmt"
	"os"
)

// Code is a process exit status that is also an error.
type Code int

// The whole vocabulary. Nothing else is ever passed to os.Exit.
const (
	OK             Code = 0
	Fail           Code = 1
	Usage          Code = 2
	NotImplemented Code = 3
	Data           Code = 65
	Unavailable    Code = 69
	Software       Code = 70
	CantCreate     Code = 73
	IOErr          Code = 74
	TempFail       Code = 75
	NoPerm         Code = 77
	Config         Code = 78
)

func (c Code) Error() string {
	switch c {
	case OK:
		return "ok"
	case Fail:
		return "failed"
	case Usage:
		return "usage error"
	case NotImplemented:
		return "not in this build"
	case Data:
		return "input data error"
	case Unavailable:
		return "service unavailable"
	case Software:
		return "internal error"
	case CantCreate:
		return "cannot create output"
	case IOErr:
		return "input/output error"
	case TempFail:
		return "temporary failure"
	case NoPerm:
		return "permission denied"
	case Config:
		return "configuration error"
	default:
		return fmt.Sprintf("exit status %d", int(c))
	}
}

// Exit prints err to stderr and exits with the Code it unwraps to, or Fail. A
// nil error exits 0 and prints nothing.
func Exit(err error) {
	if err == nil {
		os.Exit(int(OK))
	}
	code := Fail
	var c Code
	if errors.As(err, &c) {
		code = c
	}
	fmt.Fprintln(os.Stderr, "dillad:", err)
	os.Exit(int(code))
}
