package native

import (
	"fmt"

	"github.com/jonasthim/dilla/internal/id"
)

type DeviceRegistration struct {
	DeviceID   [16]byte
	DSKPublic  [32]byte
	Tier       uint64
	SignerTier uint64
	Credential []byte
}

type BootstrapResult struct {
	UMKPublic [32]byte
	SSKPublic [32]byte
	SigUMKSSK [64]byte
	Device    DeviceRegistration
}

type EnrollmentResult struct{ Credential, DeviceListBody []byte }

type Identity struct {
	Phase                  uint64
	Instance, User, Device *id.ID
	Username               string
	DeviceListPublished    bool
}

type SessionSignature struct {
	Nonce     [32]byte
	Purpose   uint64
	Signature [64]byte
}

// Session keeps the bearer private and explicitly redacts all standard fmt
// diagnostics. Token is the intentional access path for authenticated HTTP.
type Session struct {
	token                string
	Expires, IdleExpires uint64
}

func (s Session) Token() string  { return s.token }
func (Session) String() string   { return "Session{token:[redacted]}" }
func (Session) GoString() string { return "native.Session{token:[redacted]}" }

var _ fmt.Stringer = Session{}
