package api_test

import (
	"testing"
	"time"
)

// An operator's reset-factors (web3.6 S3) keeps the sessions and marks the account owing a second
// factor. A person in a live call is cut from it at once: a LiveKit token minted before the reset
// would otherwise stay good at /rtc until it expires. The cut only removes a barred participant, so
// an account that owes a factor is barred from calls, exactly as a disabled one is. The control is
// the owner in the same room, who owes nothing and is not cut.
func TestAnOwedAccountIsCutFromALiveCall(t *testing.T) {
	b := newBarredEnv(t)
	stop := b.calls.StartRetries(time.Hour)
	defer stop()

	b.calls.CutDevice(t.Context(), b.ownerDev)
	if waitRemoved(b.stub, b.room, b.ownerDev) {
		t.Fatal("CutDevice cut a device whose account owes nothing")
	}

	if err := b.e.Repo.SetFactorOwed(t.Context(), b.member, true); err != nil {
		t.Fatalf("SetFactorOwed: %v", err)
	}
	b.calls.CutUser(t.Context(), b.member)
	if !waitRemoved(b.stub, b.room, b.memberDev) {
		t.Fatal("CutUser did not cut the device of an account that now owes a second factor")
	}
}
