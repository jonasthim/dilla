package api_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/blob"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// blobEnv mounts the blob routes over a real blob directory with the default
// limits, and returns an end-to-end encrypted text channel the owner created.
func blobEnv(t *testing.T) (*env, id.ID, string) {
	t.Helper()
	d := config.Default().Blobs
	return blobEnvWithLimits(t, d.MaxBlobBytes, d.QuotaBytesPerUser)
}

// blobEnvWithLimits is blobEnv with max_blob_bytes and quota_bytes_per_user set.
func blobEnvWithLimits(t *testing.T, maxBlob, quota int64) (*env, id.ID, string) {
	t.Helper()
	return blobEnvWithConfig(t, func(c *config.Blobs) { c.MaxBlobBytes, c.QuotaBytesPerUser = maxBlob, quota })
}

// blobEnvWithConfig is blobEnv with the [blobs] section adjusted by set.
func blobEnvWithConfig(t *testing.T, set func(*config.Blobs)) (*env, id.ID, string) {
	t.Helper()
	e, cid, tok := channelEnv(t)
	bs, err := blob.Open(t.TempDir(), "fs")
	if err != nil {
		t.Fatalf("blob.Open: %v", err)
	}
	t.Cleanup(func() { _ = bs.Close() })
	cfg := config.Default().Blobs
	set(&cfg)
	log := slog.New(slog.DiscardHandler)
	api.NewBlobs(e.Repo, bs, api.NewResolver(e.Repo), cfg, e.Clk, log).Register(e.Mux)
	api.NewAdmin(e.Repo, bs, e.Clk, log).Register(e.Mux)
	e.Blobs = bs
	ch, _, status := newChannel(t, e, cid, tok, uint64(api.ChannelText), uint64(api.ModeE2EE),
		uint64(api.VisPrivate), "files")
	if status != http.StatusCreated {
		t.Fatalf("create channel = %d", status)
	}
	return e, ch, tok
}

// secondChannel creates another text channel in ch's community.
func secondChannel(t *testing.T, e *env, ch id.ID, tok string) id.ID {
	t.Helper()
	row, err := e.Repo.GetChannel(t.Context(), ch)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	other, _, status := newChannel(t, e, *row.CommunityID, tok, uint64(api.ChannelText), uint64(api.ModeE2EE),
		uint64(api.VisPrivate), "other-"+id.New().String()[:6])
	if status != http.StatusCreated {
		t.Fatalf("create second channel = %d", status)
	}
	return other
}

func blobURL(ch id.ID, sum []byte) string {
	return "/v1/channels/" + ch.String() + "/blobs/" + hex.EncodeToString(sum)
}

func TestPutRejectsAHashMismatchWithNoRow(t *testing.T) {
	e, ch, tok := blobEnv(t)
	payload := []byte("ciphertext")
	wrong := sha256.Sum256([]byte("other"))
	status, body := e.DoRaw(http.MethodPut,
		"/v1/channels/"+ch.String()+"/blobs/"+hex.EncodeToString(wrong[:]), tok,
		"application/octet-stream", payload)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("PUT with a wrong digest = %d (%s)", status, body)
	}
	if code := e.ErrCode(body); code != "E_INVALID_REQUEST" {
		t.Fatalf("code = %s", code)
	}
	if _, err := e.Repo.GetBlob(t.Context(), wrong[:]); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("a rejected upload wrote a row")
	}
}

func TestASecondPutOfTheSameBytesIs200AndAddsAReference(t *testing.T) {
	e, ch, tok := blobEnv(t)
	other := secondChannel(t, e, ch, tok)
	payload := bytes.Repeat([]byte("x"), 4096)
	sum := sha256.Sum256(payload)
	url := func(c id.ID) string {
		return "/v1/channels/" + c.String() + "/blobs/" + hex.EncodeToString(sum[:])
	}
	if status, _ := e.DoRaw(http.MethodPut, url(ch), tok, "application/octet-stream", payload); status != http.StatusCreated {
		t.Fatal("first PUT was not 201")
	}
	if status, _ := e.DoRaw(http.MethodPut, url(other), tok, "application/octet-stream", payload); status != http.StatusOK {
		t.Fatal("second PUT was not 200")
	}
	n, err := e.Repo.CountBlobRefs(t.Context(), sum[:])
	if err != nil {
		t.Fatalf("CountBlobRefs: %v", err)
	}
	if n != 2 {
		t.Fatalf("references = %d, want 2", n)
	}
}

func TestRangeAndHeadCarryTheRightHeaders(t *testing.T) {
	e, ch, tok := blobEnv(t)
	payload := []byte("0123456789abcdef")
	sum := sha256.Sum256(payload)
	url := "/v1/channels/" + ch.String() + "/blobs/" + hex.EncodeToString(sum[:])
	if status, _ := e.DoRaw(http.MethodPut, url, tok, "application/octet-stream", payload); status != http.StatusCreated {
		t.Fatal("PUT failed")
	}

	head := e.Request(t, http.MethodHead, url, tok, nil, nil)
	defer head.Body.Close()
	if head.StatusCode != http.StatusOK {
		t.Fatalf("HEAD = %d", head.StatusCode)
	}
	for k, want := range map[string]string{
		"Content-Type":                 "application/octet-stream",
		"Content-Length":               "16",
		"Accept-Ranges":                "bytes",
		"ETag":                         `"` + hex.EncodeToString(sum[:]) + `"`,
		"Content-Disposition":          "attachment",
		"X-Content-Type-Options":       "nosniff",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Cache-Control":                "private, max-age=31536000, immutable",
	} {
		if got := head.Header.Get(k); got != want {
			t.Errorf("HEAD %s = %q, want %q", k, got, want)
		}
	}
	if head.Header.Get("Last-Modified") != "" {
		t.Error("Last-Modified must not be sent: the mtime is meaningless after a restore")
	}

	get := e.Request(t, http.MethodGet, url, tok, map[string]string{"Range": "bytes=4-7"}, nil)
	defer get.Body.Close()
	if get.StatusCode != http.StatusPartialContent {
		t.Fatalf("ranged GET = %d", get.StatusCode)
	}
	b, _ := io.ReadAll(get.Body)
	if string(b) != "4567" {
		t.Fatalf("range body = %q", b)
	}
	if got := get.Header.Get("Content-Range"); got != "bytes 4-7/16" {
		t.Fatalf("Content-Range = %q", got)
	}
}

func TestOverMaxBlobBytesIs413(t *testing.T) {
	e, ch, tok := blobEnvWithLimits(t, 1024, 1<<30)
	payload := bytes.Repeat([]byte("x"), 4096)
	sum := sha256.Sum256(payload)
	status, body := e.DoRaw(http.MethodPut,
		"/v1/channels/"+ch.String()+"/blobs/"+hex.EncodeToString(sum[:]), tok,
		"application/octet-stream", payload)
	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("PUT over max_blob_bytes = %d", status)
	}
	if code := e.ErrCode(body); code != "E_TOO_LARGE" {
		t.Fatalf("code = %s", code)
	}
}

func TestOverTheUserQuotaIs507(t *testing.T) {
	e, ch, tok := blobEnvWithLimits(t, 1<<20, 4096)
	for i, want := range []int{http.StatusCreated, http.StatusInsufficientStorage} {
		payload := bytes.Repeat([]byte{byte('a' + i)}, 3000)
		sum := sha256.Sum256(payload)
		status, body := e.DoRaw(http.MethodPut,
			"/v1/channels/"+ch.String()+"/blobs/"+hex.EncodeToString(sum[:]), tok,
			"application/octet-stream", payload)
		if status != want {
			t.Fatalf("upload %d = %d, want %d (%s)", i, status, want, body)
		}
		if want == http.StatusInsufficientStorage {
			if code := e.ErrCode(body); code != "E_STORAGE_FULL" {
				t.Fatalf("code = %s", code)
			}
		}
	}
}

// An upload refused over the quota after its bytes were written leaves a blobs
// row marked unreferenced, so the sweeper collects the file after the grace
// window rather than it staying on disk with no row forever. The user is not
// charged for it.
func TestAnUploadRefusedOverTheQuotaIsLeftForTheSweeper(t *testing.T) {
	e, ch, tok := blobEnvWithLimits(t, 1<<20, 4096)
	first := bytes.Repeat([]byte{'a'}, 3000)
	firstSum := sha256.Sum256(first)
	if status, _ := e.DoRaw(http.MethodPut, blobURL(ch, firstSum[:]), tok, "application/octet-stream", first); status != http.StatusCreated {
		t.Fatal("first PUT failed")
	}
	second := bytes.Repeat([]byte{'b'}, 3000)
	sum := sha256.Sum256(second)
	// Sent with no Content-Length, so the pre-body quota check cannot see its size and the body
	// is read: this is the path that leaves a file for the sweeper (one with a Content-Length
	// over the quota is refused before a byte is read, TestTheQuotaPreCheckCountsTheBody).
	if status := putUnsized(t, e, ch, tok, sum[:], second); status != http.StatusInsufficientStorage {
		t.Fatalf("second PUT = %d, want 507", status)
	}
	row, err := e.Repo.GetBlob(t.Context(), sum[:])
	if err != nil {
		t.Fatalf("GetBlob of the refused upload: %v", err)
	}
	if row.UnrefSince == nil || *row.UnrefSince != e.Clk.Now().Unix() {
		t.Fatalf("unref_since = %v, want now", row.UnrefSince)
	}
	if n, err := e.Repo.CountBlobRefs(t.Context(), sum[:]); err != nil || n != 0 {
		t.Fatalf("references = %d (%v), want 0", n, err)
	}
	if used, err := e.Repo.UserBlobBytes(t.Context(), userOf(t, e, tok)); err != nil || used != 3000 {
		t.Fatalf("UserBlobBytes = %d (%v), want 3000", used, err)
	}
}

func TestAFetchWithNoReferenceInThisChannelIs404(t *testing.T) {
	e, ch, tok := blobEnv(t)
	other := secondChannel(t, e, ch, tok)
	payload := []byte("shared")
	sum := sha256.Sum256(payload)
	if status, _ := e.DoRaw(http.MethodPut,
		"/v1/channels/"+ch.String()+"/blobs/"+hex.EncodeToString(sum[:]), tok,
		"application/octet-stream", payload); status != http.StatusCreated {
		t.Fatal("PUT failed")
	}
	// The bytes exist, but not in `other`. The answer must be 404, never 403:
	// the response must not tell a caller that a blob they cannot reach exists.
	status, body := e.Do(http.MethodGet,
		"/v1/channels/"+other.String()+"/blobs/"+hex.EncodeToString(sum[:]), tok, nil)
	if status != http.StatusNotFound {
		t.Fatalf("cross-channel GET = %d, want 404", status)
	}
	if code := e.ErrCode(body); code != "E_NOT_FOUND" {
		t.Fatalf("code = %s", code)
	}
}

// gap-47 §6.2: the PUT is the proof of ownership. Knowing a blob_id is not
// enough to publish it into another channel: the body must hash to it even when
// the bytes are already stored, or anyone who saw the id could claim the object
// into a channel they read and download it from there.
func TestAPutOfAStoredBlobMustStillCarryItsBytes(t *testing.T) {
	e, ch, tok := blobEnv(t)
	other := secondChannel(t, e, ch, tok)
	payload := []byte("the ciphertext")
	sum := sha256.Sum256(payload)
	if status, _ := e.DoRaw(http.MethodPut, blobURL(ch, sum[:]), tok, "application/octet-stream", payload); status != http.StatusCreated {
		t.Fatal("PUT failed")
	}
	status, body := e.DoRaw(http.MethodPut, blobURL(other, sum[:]), tok, "application/octet-stream", nil)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("PUT of a stored id with an empty body = %d (%s), want 422", status, body)
	}
	if n, err := e.Repo.CountBlobRefs(t.Context(), sum[:]); err != nil || n != 1 {
		t.Fatalf("references = %d (%v), want 1: a claim by id alone added one", n, err)
	}
	if status, _ := e.Do(http.MethodGet, blobURL(other, sum[:]), tok, nil); status != http.StatusNotFound {
		t.Fatalf("GET in the claiming channel = %d, want 404", status)
	}
}

// The PUT answers [blob_id(bstr 32), size(uint)], and the object reads back
// byte for byte.
func TestPutAnswersTheIDAndSizeAndGetReturnsTheBytes(t *testing.T) {
	e, ch, tok := blobEnv(t)
	payload := bytes.Repeat([]byte{0x5a}, 777)
	sum := sha256.Sum256(payload)
	status, body := e.DoRaw(http.MethodPut, blobURL(ch, sum[:]), tok, "application/octet-stream", payload)
	if status != http.StatusCreated {
		t.Fatalf("PUT = %d", status)
	}
	var out struct {
		_      struct{} `cbor:",toarray"`
		BlobID []byte
		Size   uint64
	}
	mustUnmarshalBody(t, body, &out)
	if !bytes.Equal(out.BlobID, sum[:]) || out.Size != uint64(len(payload)) {
		t.Fatalf("PUT answered %x/%d", out.BlobID, out.Size)
	}
	row, err := e.Repo.GetBlob(t.Context(), sum[:])
	if err != nil {
		t.Fatalf("GetBlob: %v", err)
	}
	if row.Size != uint64(len(payload)) || row.StorageRef != blob.StorageRef("fs", sum[:]) {
		t.Fatalf("blobs row = %+v", row)
	}
	ref, err := e.Repo.GetBlobRef(t.Context(), sum[:], ch)
	if err != nil {
		t.Fatalf("GetBlobRef: %v", err)
	}
	if ref.UploaderDevice != sessionDevice(t, e, tok) {
		t.Fatalf("uploader_device = %v, want the session's device", ref.UploaderDevice)
	}
	get := e.Request(t, http.MethodGet, blobURL(ch, sum[:]), tok, nil, nil)
	defer get.Body.Close()
	got, _ := io.ReadAll(get.Body)
	if get.StatusCode != http.StatusOK || !bytes.Equal(got, payload) {
		t.Fatalf("GET = %d, %d bytes", get.StatusCode, len(got))
	}
}

// §5.0: {blob_id} is 64 LOWERCASE hex, refused before the database or the
// filesystem is touched.
func TestAMalformedBlobIDIs400(t *testing.T) {
	e, ch, tok := blobEnv(t)
	sum := sha256.Sum256([]byte("x"))
	for _, bad := range []string{
		strings.ToUpper(hex.EncodeToString(sum[:])),
		hex.EncodeToString(sum[:31]),
		hex.EncodeToString(sum[:]) + "00",
	} {
		status, body := e.DoRaw(http.MethodPut, "/v1/channels/"+ch.String()+"/blobs/"+bad, tok,
			"application/octet-stream", []byte("x"))
		if status != http.StatusBadRequest || e.ErrCode(body) != "E_INVALID_REQUEST" {
			t.Fatalf("PUT %s = %d", bad, status)
		}
	}
}

// NV9: a category has no messages and therefore no attachments.
func TestACategoryHoldsNoAttachments(t *testing.T) {
	e, ch, tok := blobEnv(t)
	row, err := e.Repo.GetChannel(t.Context(), ch)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	cat, _, status := newChannel(t, e, *row.CommunityID, tok, uint64(api.ChannelCategory), uint64(api.ModeE2EE),
		uint64(api.VisPrivate), "cat")
	if status != http.StatusCreated {
		t.Fatalf("create category = %d", status)
	}
	payload := []byte("x")
	sum := sha256.Sum256(payload)
	status, body := e.DoRaw(http.MethodPut, blobURL(cat, sum[:]), tok, "application/octet-stream", payload)
	if status != http.StatusForbidden || e.ErrCode(body) != "E_FORBIDDEN" {
		t.Fatalf("PUT into a category = %d", status)
	}
}

// A caller who cannot view the channel learns nothing about it: 404, as for an
// unknown channel, on every verb.
func TestANonMemberGets404(t *testing.T) {
	e, ch, tok := blobEnv(t)
	payload := []byte("members only")
	sum := sha256.Sum256(payload)
	if status, _ := e.DoRaw(http.MethodPut, blobURL(ch, sum[:]), tok, "application/octet-stream", payload); status != http.StatusCreated {
		t.Fatal("PUT failed")
	}
	_, stranger := e.NewUser("stranger")
	if status, _ := e.DoRaw(http.MethodPut, blobURL(ch, sum[:]), stranger, "application/octet-stream", payload); status != http.StatusNotFound {
		t.Fatalf("PUT by a non-member = %d, want 404", status)
	}
	if status, _ := e.Do(http.MethodGet, blobURL(ch, sum[:]), stranger, nil); status != http.StatusNotFound {
		t.Fatalf("GET by a non-member = %d, want 404", status)
	}
}

// An admin purge's tombstone refuses the same bytes again (gap-47 §7.3): content
// addressing would otherwise hand the purged name straight back.
func TestAPurgedBlobCannotBeUploadedAgain(t *testing.T) {
	e, ch, tok := blobEnv(t)
	payload := []byte("purged")
	sum := sha256.Sum256(payload)
	if err := e.Repo.PutBlobTombstone(t.Context(), sum[:], "takedown", userOf(t, e, tok), e.Clk.Now().Unix()); err != nil {
		t.Fatalf("PutBlobTombstone: %v", err)
	}
	status, body := e.DoRaw(http.MethodPut, blobURL(ch, sum[:]), tok, "application/octet-stream", payload)
	if status != http.StatusGone || e.ErrCode(body) != "E_PRUNED" {
		t.Fatalf("PUT of purged bytes = %d", status)
	}
	if _, err := e.Repo.GetBlob(t.Context(), sum[:]); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("a refused upload wrote a row")
	}
}
