package api_test

// backup_meter_test.go pins the security review's F3: PUT /v1/backups/{kind}/0 spends the blob
// upload meter (blobs.uploads_per_minute and blobs.upload_bytes_per_day) exactly as a blob PUT
// does. Before the fix the route had only the device write bucket (2/s): one enrolled session
// stored a fresh 1 MiB state object per request, each replaced one uncollectable for gc_grace,
// about 7 GiB an hour against blobs.store_max_bytes (unlimited by default; when set, the whole
// instance then answers 507 to everyone).

import (
	"net/http"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
)

// The 21st backup PUT in a minute is the blob route's 429 E_RATE_LIMITED, before the body is read;
// a minute later it passes.
func TestTheBackupPutSpendsTheUploadsPerMinute(t *testing.T) {
	h, d := newBackupAPI(t, nil) // blobs.uploads_per_minute = 20 by default
	if d.Config.Blobs.UploadsPerMinute != 20 {
		t.Fatalf("uploads_per_minute = %d, want the default 20", d.Config.Blobs.UploadsPerMinute)
	}
	s := backupSessions(t, d)
	root := rootObject(t, 0x31)
	wantStored(t, "the root", putObject(t, h, "0", s.enrolled, root), http.StatusCreated, root)
	for i := 1; i < 20; i++ {
		state := sealedObject(t, 32, byte(i))
		if rec := putObject(t, h, "1", s.enrolled, state); rec.Code != http.StatusOK && rec.Code != http.StatusCreated {
			t.Fatalf("backup PUT %d of 20 = %d %x", i+1, rec.Code, rec.Body.Bytes())
		}
	}
	over := sealedObject(t, 32, 0xee)
	rec := putObject(t, h, "1", s.enrolled, over)
	wantRefusal(t, "the 21st backup PUT in a minute", rec, http.StatusTooManyRequests, "E_RATE_LIMITED")
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("the refusal carries no Retry-After")
	}
	if _, err := d.Repo.GetBlob(t.Context(), objectID(over)); err == nil {
		t.Fatal("the refused PUT stored its bytes")
	}
	d.Clock.(*clock.Fake).Advance(time.Minute)
	if rec := putObject(t, h, "1", s.enrolled, over); rec.Code != http.StatusOK {
		t.Fatalf("a backup PUT a minute later = %d %x, want 200", rec.Code, rec.Body.Bytes())
	}
}

// Past blobs.upload_bytes_per_day the backup PUT is the blob route's 429 E_RATE_LIMITED, and every
// byte read spends the budget whatever happens to the object.
func TestTheBackupPutSpendsTheDailyUploadBytes(t *testing.T) {
	h, d := newBackupAPI(t, func(c *config.Config) { c.Blobs.UploadBytesPerDay = 3000 })
	s := backupSessions(t, d)
	for i := 0; i < 2; i++ {
		state := sealedObject(t, 1000, byte(0x40+i))
		if rec := putObject(t, h, "1", s.enrolled, state); rec.Code != http.StatusOK && rec.Code != http.StatusCreated {
			t.Fatalf("state PUT %d = %d %x", i+1, rec.Code, rec.Body.Bytes())
		}
	}
	over := sealedObject(t, 1000, 0x4f)
	wantRefusal(t, "a third 1 KiB state object on a 3000-byte daily budget",
		putObject(t, h, "1", s.enrolled, over), http.StatusTooManyRequests, "E_RATE_LIMITED")
	if _, err := d.Repo.GetBlob(t.Context(), objectID(over)); err == nil {
		t.Fatal("the refused PUT stored its bytes")
	}
	// The budget refills continuously: a day later the same object passes.
	d.Clock.(*clock.Fake).Advance(24 * time.Hour)
	if rec := putObject(t, h, "1", s.enrolled, over); rec.Code != http.StatusOK {
		t.Fatalf("the state PUT a day later = %d %x, want 200", rec.Code, rec.Body.Bytes())
	}
}
