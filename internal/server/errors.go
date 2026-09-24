// Package server is dillad's HTTP plumbing: the stdlib mux, the CBOR codec, the
// E_* error body, the token buckets and the real-client-address rule. It knows
// nothing about accounts, groups or messages.
package server

import (
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"

	"github.com/jonasthim/dilla/internal/cborx"
)

// Code is a stable E_* string. It is the only thing a client switches on.
type Code string

const (
	CodeInvalidRequest    Code = "E_INVALID_REQUEST"
	CodeBindingInvalid    Code = "E_BINDING_INVALID"
	CodeUnauthenticated   Code = "E_UNAUTHENTICATED"
	CodeForbidden         Code = "E_FORBIDDEN"
	CodeLeafNotCurrent    Code = "E_LEAF_NOT_CURRENT"
	CodeModeReadable      Code = "E_MODE_READABLE"
	CodeNotUploader       Code = "E_NOT_UPLOADER"
	CodeNotFound          Code = "E_NOT_FOUND"
	CodeGroupExists       Code = "E_GROUP_EXISTS"
	CodeCommitConflict    Code = "E_COMMIT_CONFLICT"
	CodePruned            Code = "E_PRUNED"
	CodeInviteInvalid     Code = "E_INVITE_INVALID"
	CodeTooLarge          Code = "E_TOO_LARGE"
	CodeCommitInvalid     Code = "E_COMMIT_INVALID"
	CodeCommitmentInvalid Code = "E_COMMITMENT_INVALID"
	CodeCommitRequired    Code = "E_COMMIT_REQUIRED"
	CodeRateLimited       Code = "E_RATE_LIMITED"
	CodeStorageFull       Code = "E_STORAGE_FULL"
	CodeVersion           Code = "E_VERSION"
	CodeInternal          Code = "E_INTERNAL"
	// CodeProvisionalOutsidePairing is protocol/02 § Device sessions item 4:
	// a provisional session reaching anything but its one pairing group.
	CodeProvisionalOutsidePairing Code = "E_PROVISIONAL_OUTSIDE_PAIRING"
	// The next four have no call site in Plan 1: Plan 2's readable-channel
	// handlers raise them. They are declared HERE because this file and
	// protocol/02 § Errors are diffed against each other in both directions by
	// scripts/check-protocol-docs.mjs, so the vocabulary has exactly one owner.
	//
	// The three envelope codes mirror the Rust envelope module's own codes and
	// the protocol/vectors reject corpus one-for-one: a server-readable
	// channel's instance IS a receiver in protocol/04's sense, so it refuses
	// exactly what a client refuses and a client switches on one vocabulary.
	CodeEnvelopeShape Code = "E_ENVELOPE_SHAPE"
	CodeEnvelopeType  Code = "E_ENVELOPE_TYPE"
	CodeEnvelopeLimit Code = "E_ENVELOPE_LIMIT"
	// CodeChannelMode is 403, not 400: the body is well formed and the session
	// is authenticated; the operation is simply not allowed for the channel's
	// mode. It is NOT CodeModeReadable, which says the opposite thing ("text
	// groups are not allowed for this channel, because the channel is
	// server-readable") and which the delivery service uses with that meaning.
	CodeChannelMode Code = "E_CHANNEL_MODE"
	// CodeUnsupportedMedia is not in the table: a wrong Content-Type is answered
	// with 415 and E_INVALID_REQUEST, because the table's rule is "malformed
	// request" and a client that sent JSON has exactly that problem.
	//
	// Every constant above IS in the table. scripts/check-protocol-docs.mjs's
	// checkErrorVocabulary diffs this block against protocol/02 in both
	// directions, so adding one here without adding its row there fails CI.
)

// Error is a refusal: an HTTP status plus the CBOR array of protocol/02.
type Error struct {
	Code         Code
	Detail       string
	RetryAfterMS *uint64
	Extra        []any // appended after retry_after_ms; only four codes have any
	status       int   // set only where the status is not the code's default
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Detail }

// Status is the row's HTTP status.
func (e *Error) Status() int {
	if e.status != 0 {
		return e.status
	}
	switch e.Code {
	case CodeInvalidRequest, CodeBindingInvalid, CodeVersion,
		CodeEnvelopeShape, CodeEnvelopeType, CodeEnvelopeLimit:
		return http.StatusBadRequest
	case CodeUnauthenticated:
		return http.StatusUnauthorized
	case CodeForbidden, CodeLeafNotCurrent, CodeModeReadable, CodeNotUploader,
		CodeProvisionalOutsidePairing, CodeChannelMode:
		return http.StatusForbidden
	case CodeNotFound:
		return http.StatusNotFound
	case CodeGroupExists, CodeCommitConflict:
		return http.StatusConflict
	case CodePruned, CodeInviteInvalid:
		return http.StatusGone
	case CodeTooLarge:
		return http.StatusRequestEntityTooLarge
	case CodeCommitInvalid, CodeCommitmentInvalid:
		return http.StatusUnprocessableEntity
	case CodeCommitRequired:
		return http.StatusTooEarly
	case CodeRateLimited:
		return http.StatusTooManyRequests
	case CodeStorageFull:
		return http.StatusInsufficientStorage
	case CodeInternal:
		return http.StatusInternalServerError
	default:
		return http.StatusInternalServerError
	}
}

// Errorf builds a plain three-element refusal. The status comes from the code,
// never from the caller: two call sites that disagree about which status
// E_FORBIDDEN carries is exactly the drift the one table exists to prevent.
func Errorf(code Code, format string, args ...any) *Error {
	return &Error{Code: code, Detail: fmt.Sprintf(format, args...)}
}

// WithStatus overrides a code's default status. It is the ONE way to do so, and
// it exists for the handful of cases where the same code means two things at two
// statuses — a duplicate username is E_INVALID_REQUEST at 409, not at 400.
func WithStatus(status int, e *Error) *Error {
	e.status = status
	return e
}

// The four refusals that carry extra elements, and the one that carries a delay.

func CommitConflict(winning []byte, proposals [][]byte) *Error {
	return &Error{Code: CodeCommitConflict, Detail: "another commit won this epoch",
		Extra: []any{winning, proposals}}
}

func CommitRequired(proposals [][]byte, retryAfterMS uint64) *Error {
	ms := retryAfterMS
	return &Error{Code: CodeCommitRequired, Detail: "outstanding proposals must be committed first",
		RetryAfterMS: &ms, Extra: []any{proposals}}
}

func CommitInvalid(rule string) *Error {
	return &Error{Code: CodeCommitInvalid, Detail: "commit refused by rule " + rule, Extra: []any{rule}}
}

func Version(wire, e2ee, media []uint64) *Error {
	return &Error{Code: CodeVersion, Detail: "no common version", Extra: []any{wire, e2ee, media}}
}

func RateLimited(retryAfterMS uint64) *Error {
	ms := retryAfterMS
	return &Error{Code: CodeRateLimited, Detail: "rate limited", RetryAfterMS: &ms}
}

// unsupportedMedia is 415 with E_INVALID_REQUEST.
func unsupportedMedia(got string) *Error {
	return &Error{Code: CodeInvalidRequest,
		Detail: "Content-Type must be application/cbor, got " + got,
		status: http.StatusUnsupportedMediaType}
}

// WriteError serialises err as the CBOR error array. An error that is not a
// *Error is 500 with an empty detail: an internal message may name a path, a
// query or a row, and none of that belongs in a client's hands.
func WriteError(w http.ResponseWriter, err error) {
	var e *Error
	if !errors.As(err, &e) {
		e = &Error{Code: CodeInternal, Detail: ""}
	}
	body := []any{string(e.Code), e.Detail, nil}
	if e.RetryAfterMS != nil {
		body[2] = *e.RetryAfterMS
	}
	body = append(body, e.Extra...)
	encoded, encErr := cborx.Marshal(body)
	if encErr != nil {
		http.Error(w, "", http.StatusInternalServerError)
		return
	}
	if e.RetryAfterMS != nil && e.Code == CodeRateLimited {
		seconds := int64(math.Ceil(float64(*e.RetryAfterMS) / 1000))
		w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
	}
	w.Header().Set("Content-Type", "application/cbor")
	w.WriteHeader(e.Status())
	if _, werr := w.Write(encoded); werr != nil {
		slog.Default().Debug("server: write error body", "err", werr)
	}
}
