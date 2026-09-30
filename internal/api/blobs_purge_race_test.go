package api_test

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/blob"
	"github.com/jonasthim/dilla/internal/store"
)

// purgeOnFirstRead is an upload body that lets an administrator's purge of the same bytes commit
// while the upload is streaming: the moment the handler starts reading the body.
type purgeOnFirstRead struct {
	r     io.Reader
	purge func()
	done  bool
}

func (p *purgeOnFirstRead) Read(b []byte) (int, error) {
	if !p.done {
		p.done = true
		p.purge()
	}
	return p.r.Read(b)
}

// I9 (fix wave): the tombstone was checked only before the body was read, so a purge committing
// during the upload was undone: the racing PUT got 201 and the purged bytes came back with a row,
// a reference and a file, charged to the uploader's quota and carried into every backup. The
// reference transaction re-checks the tombstone; the racing upload is 410 E_PRUNED and leaves
// nothing behind.
func TestAnUploadRacingAPurgeOfTheSameBytesLeavesNothing(t *testing.T) {
	e, ch, tok := blobEnv(t)
	body := bytes.Repeat([]byte{'z'}, 64<<10)
	sum := sha256.Sum256(body)

	reader := &purgeOnFirstRead{r: bytes.NewReader(body), purge: func() {
		if _, err := blob.Purge(t.Context(), e.Repo, e.Blobs, blob.PurgeRequest{
			BlobID: sum[:], Reason: "abuse", At: e.Clk.Now().Unix(),
		}); err != nil {
			t.Errorf("Purge: %v", err)
		}
	}}
	// Straight into the mux, so the body is read only when the handler reads it (an HTTP client
	// would write it into the socket before the handler's tombstone check ran).
	req := httptest.NewRequestWithContext(auth.WithSession(t.Context(), e.sess[tok]),
		http.MethodPut, blobURL(ch, sum[:]), reader)
	req.Header.Set("Content-Type", "application/octet-stream")
	rec := httptest.NewRecorder()
	e.Mux.ServeHTTP(rec, req)
	if !reader.done {
		t.Fatal("the handler never read the body; the race was not run")
	}
	if rec.Code != http.StatusGone {
		t.Fatalf("the PUT racing a purge = %d, want 410 E_PRUNED", rec.Code)
	}
	if code := e.ErrCode(rec.Body.Bytes()); code != "E_PRUNED" {
		t.Fatalf("code = %s, want E_PRUNED", code)
	}
	if _, err := e.Repo.GetBlob(t.Context(), sum[:]); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("GetBlob after the race: %v, want no row", err)
	}
	if n, _ := e.Repo.CountBlobRefs(t.Context(), sum[:]); n != 0 {
		t.Fatalf("%d references after the race, want 0", n)
	}
	if _, err := e.Blobs.Stat(sum[:]); err == nil {
		t.Fatal("the purged bytes are on disk again")
	}
	if used, _ := e.Repo.UserBlobBytes(t.Context(), e.sess[tok].UserID); used != 0 {
		t.Fatalf("the uploader is charged %d bytes for purged content", used)
	}
}
