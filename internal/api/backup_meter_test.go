package api_test

// backup_meter_test.go pins the security review's F3 for the root object and the branch review's
// BACKUPS-RECOVERY-01 for the state object. PUT /v1/backups/0/0 (the root, written once) spends the
// blob upload meter (blobs.uploads_per_minute and blobs.upload_bytes_per_day) exactly as a blob PUT
// does. PUT /v1/backups/1/0 (the state object) does not: it spends only the device session's own
// write bucket. Before the branch review it also drew on the user's shared upload meter, so a stolen
// session of the same user, uploading tiny objects at its own device rate, kept the shared bucket
// empty and the owner's state PUT, which revoking another device starts with, answered 429 for as
// long as the thief kept at it.

import (
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// The 21st root PUT in a minute is the blob route's 429 E_RATE_LIMITED, before the body is read;
// a minute later it passes. Changed by BACKUPS-RECOVERY-01: this drove state PUTs, which no longer
// spend the upload meter; the root, the kind that still does, drives it now.
func TestTheRootPutSpendsTheUploadsPerMinute(t *testing.T) {
	h, d := newBackupAPI(t, nil) // blobs.uploads_per_minute = 20 by default
	if d.Config.Blobs.UploadsPerMinute != 20 {
		t.Fatalf("uploads_per_minute = %d, want the default 20", d.Config.Blobs.UploadsPerMinute)
	}
	s := backupSessions(t, d)
	root := rootObject(t, 0x31)
	wantStored(t, "the root", putObject(t, h, "0", s.enrolled, root), http.StatusCreated, root)
	for i := 1; i < 20; i++ {
		if rec := putObject(t, h, "0", s.enrolled, root); rec.Code != http.StatusOK {
			t.Fatalf("root PUT %d of 20 = %d %x", i+1, rec.Code, rec.Body.Bytes())
		}
	}
	rec := putObject(t, h, "0", s.enrolled, root)
	wantRefusal(t, "the 21st root PUT in a minute", rec, http.StatusTooManyRequests, "E_RATE_LIMITED")
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("the refusal carries no Retry-After")
	}
	d.Clock.(*clock.Fake).Advance(time.Minute)
	if rec := putObject(t, h, "0", s.enrolled, root); rec.Code != http.StatusOK {
		t.Fatalf("a root PUT a minute later = %d %x, want 200", rec.Code, rec.Body.Bytes())
	}
}

// Past blobs.upload_bytes_per_day the root PUT is the blob route's 429 E_RATE_LIMITED, and every
// byte read spends the budget whatever happens to the object (a repeat of the stored root included).
// Changed by BACKUPS-RECOVERY-01 like the test above: state PUTs drove it.
func TestTheRootPutSpendsTheDailyUploadBytes(t *testing.T) {
	h, d := newBackupAPI(t, func(c *config.Config) { c.Blobs.UploadBytesPerDay = 250 }) // a root body is 106 bytes
	s := backupSessions(t, d)
	root := rootObject(t, 0x41)
	for i := 0; i < 2; i++ {
		if rec := putObject(t, h, "0", s.enrolled, root); rec.Code != http.StatusOK && rec.Code != http.StatusCreated {
			t.Fatalf("root PUT %d = %d %x", i+1, rec.Code, rec.Body.Bytes())
		}
	}
	wantRefusal(t, "a third root body on a 250-byte daily budget",
		putObject(t, h, "0", s.enrolled, root), http.StatusTooManyRequests, "E_RATE_LIMITED")
	// The budget refills continuously: a day later the same object passes.
	d.Clock.(*clock.Fake).Advance(24 * time.Hour)
	if rec := putObject(t, h, "0", s.enrolled, root); rec.Code != http.StatusOK {
		t.Fatalf("the root PUT a day later = %d %x, want 200", rec.Code, rec.Body.Bytes())
	}
}

// secondEnrolledSession adds a device to user (who has published no list, so the device is
// enrolled) and establishes a session for it through the real challenge-and-signature path.
func secondEnrolledSession(t *testing.T, d api.Deps, user id.ID) string {
	t.Helper()
	ctx := t.Context()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	now := d.Clock.Now().Unix()
	dev := store.DeviceRow{ID: id.New(), UserID: user, DSKPub: pub, CredentialBlob: []byte{1}, LastSeen: now, Created: now}
	if err := d.Repo.CreateDevice(ctx, dev); err != nil {
		t.Fatalf("CreateDevice: %v", err)
	}
	nonce, _, err := d.Sessions.Challenge(ctx, dev.ID)
	if err != nil {
		t.Fatalf("Challenge: %v", err)
	}
	tok, err := d.Sessions.Establish(ctx, auth.EstablishRequest{DeviceID: dev.ID, Nonce: nonce, Purpose: auth.PurposeSession,
		Sig: ed25519.Sign(priv, auth.SessionPreimage(d.Sessions.InstanceID(), dev.ID, nonce, auth.PurposeSession))})
	if err != nil || tok.Scope != auth.ScopeEnrolled {
		t.Fatalf("establish the second device: %v (scope %d)", err, tok.Scope)
	}
	return tok.Token
}

// BACKUPS-RECOVERY-01, the meter half. Attacker statement: a thief holds an enrolled session of
// another device of the same user and spends the user's whole upload meter (here one upload a
// minute and a 200-byte day). The owner's state PUT still lands, a state object larger than the
// day's byte budget included, because the state object draws only on the owner's own device
// bucket; the root, written once, still draws on the shared meter.
func TestAThiefExhaustingTheUploadMeterDoesNotBlockTheOwnersStatePut(t *testing.T) {
	h, d := newBackupAPI(t, func(c *config.Config) {
		c.Blobs.UploadsPerMinute, c.Blobs.UploadBytesPerDay = 1, 200
	})
	thief := backupSessions(t, d)
	owner := secondEnrolledSession(t, d, thief.user.ID)
	root := rootObject(t, 0x51)
	wantStored(t, "the thief's root PUT", putObject(t, h, "0", thief.enrolled, root), http.StatusCreated, root)
	wantRefusal(t, "a root PUT once the meter is spent", putObject(t, h, "0", owner, root),
		http.StatusTooManyRequests, "E_RATE_LIMITED")

	state := sealedObject(t, 300, 0x52) // 317 bytes: more than the whole day's byte budget
	wantStored(t, "the owner's state PUT with the meter spent", putObject(t, h, "1", owner, state), http.StatusCreated, state)
	again := sealedObject(t, 300, 0x53)
	wantStored(t, "the owner's next state PUT", putObject(t, h, "1", owner, again), http.StatusOK, again)
	junk := sealedObject(t, 16, 0x54)
	wantStored(t, "the thief's state PUT", putObject(t, h, "1", thief.enrolled, junk), http.StatusOK, junk)
	wantStored(t, "the owner's state PUT after the thief's", putObject(t, h, "1", owner, again), http.StatusOK, again)
}
