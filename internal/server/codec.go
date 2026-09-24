package server

import (
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

// DecodeBody reads at most max bytes of deterministic CBOR into v. Every /v1
// body is CBOR; blob uploads are the one exception and do not come through here.
func DecodeBody(w http.ResponseWriter, r *http.Request, max int64, v any) error {
	ct := r.Header.Get("Content-Type")
	if mt, _, _ := strings.Cut(ct, ";"); strings.TrimSpace(mt) != "application/cbor" {
		return unsupportedMedia(ct)
	}
	r.Body = http.MaxBytesReader(w, r.Body, max)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return Errorf(CodeTooLarge, "body over %d bytes", max)
		}
		return Errorf(CodeInvalidRequest, "read body: %v", err)
	}
	if err := cborx.Unmarshal(body, v); err != nil {
		return Errorf(CodeInvalidRequest, "body is not deterministic CBOR: %v", err)
	}
	return nil
}

// EncodeBody writes v as deterministic CBOR with the given status.
func EncodeBody(w http.ResponseWriter, status int, v any) error {
	b, err := cborx.Marshal(v)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/cbor")
	w.WriteHeader(status)
	_, err = w.Write(b)
	return err
}

// WriteCBOR is EncodeBody under the name parts 1b and 2 use (deviation ID14).
// One of the two spellings had to win; both are kept so neither plan has to
// rewrite every handler.
func WriteCBOR(w http.ResponseWriter, status int, v any) error { return EncodeBody(w, status, v) }

// PathID reads a 32-lowercase-hex path segment. A malformed identifier is
// E_INVALID_REQUEST and never reaches the database (R33).
func PathID(r *http.Request, name string) (id.ID, error) {
	v, err := id.Parse(r.PathValue(name))
	if err != nil {
		return id.ID{}, Errorf(CodeInvalidRequest, "path %s: %v", name, err)
	}
	return v, nil
}

// PathDigest reads a 64-lowercase-hex path segment: a blob id.
func PathDigest(r *http.Request, name string) ([]byte, error) {
	s := r.PathValue(name)
	if len(s) != 64 {
		return nil, Errorf(CodeInvalidRequest, "path %s: want 64 hex characters, got %d", name, len(s))
	}
	out := make([]byte, 32)
	for i := 0; i < 64; i += 2 {
		hi, lo := hexVal(s[i]), hexVal(s[i+1])
		if hi < 0 || lo < 0 {
			return nil, Errorf(CodeInvalidRequest, "path %s: not lowercase hex", name)
		}
		out[i/2] = byte(hi<<4 | lo)
	}
	return out, nil
}

func hexVal(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	default:
		return -1
	}
}
