package dillad

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// CoreFileName is the wasm32-wasip1 build of dilla-core-wasi, looked for beside the dillad binary
// unless Options.CorePath names it. `dillad doctor`'s wasi leg reads the same conventional path.
const CoreFileName = "dilla_core_wasi.wasm"

// defaultCorePath is CoreFileName next to the running executable.
//
// The plan's step text reads `o.Config.MLS.CorePath`, but dilla.toml has no [mls] table (task 4's
// schema never grew one), so the path follows the convention `dillad doctor` already checks
// (deviation B35). Options.CorePath overrides it, which is how a test or a packager that keeps the
// artefact elsewhere points at it.
func defaultCorePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("dillad: locate the dillad binary to find %s beside it: %w", CoreFileName, err)
	}
	return filepath.Join(filepath.Dir(exe), CoreFileName), nil
}

// keyHistoryEntry is one entry of protocol/03-identity.md § Instance keys' key_history:
// [kind, key_id, public, secret, created, retired|null].
type keyHistoryEntry struct {
	_       struct{} `cbor:",toarray"`
	Kind    uint64
	KeyID   []byte
	Public  []byte
	Secret  []byte
	Created uint64
	Retired *uint64
}

type keyHistory struct {
	_       struct{} `cbor:",toarray"`
	V       uint64
	Entries []keyHistoryEntry
}

// instanceKeys reads the two current instance secrets out of instances.key_history: the
// external-sender Ed25519 seed (kind 0) and K_frank (kind 1), each the entry the instance row
// names by key id. `dillad init` writes both; an instance without them cannot sign an external
// proposal or frank a message, so New refuses to start rather than run a delivery service that
// fails on its first proposal.
func instanceKeys(row store.InstanceRow) (ds.InstanceKeys, error) {
	var h keyHistory
	if err := cborx.Unmarshal(row.KeyHistory, &h); err != nil {
		return ds.InstanceKeys{}, fmt.Errorf("dillad: instances.key_history does not decode: %w", err)
	}
	if h.V != 1 {
		return ds.InstanceKeys{}, fmt.Errorf("dillad: instances.key_history is version %d, want 1", h.V)
	}
	k := ds.InstanceKeys{
		InstanceID:          row.InstanceID,
		ExternalSenderKeyID: row.ExternalSenderKeyID,
		FrankingKeyID:       row.FrankingKeyID,
	}
	var haveSender, haveFranking bool
	for _, e := range h.Entries {
		if len(e.KeyID) != len(id.ID{}) || e.Retired != nil {
			continue
		}
		keyID := id.ID(e.KeyID)
		switch {
		case e.Kind == 0 && keyID == row.ExternalSenderKeyID && len(e.Secret) == 32:
			copy(k.ExternalSenderPriv[:], e.Secret)
			haveSender = true
		case e.Kind == 1 && keyID == row.FrankingKeyID && len(e.Secret) == 32:
			copy(k.FrankingKey[:], e.Secret)
			haveFranking = true
		}
	}
	if !haveSender || !haveFranking {
		return ds.InstanceKeys{}, errors.New("dillad: instances.key_history holds no current " +
			"external-sender key or franking key under the ids the instance row names; " +
			"`dillad init` writes both")
	}
	return k, nil
}

// policyFromConfig is ds.DefaultPolicy with the four values dilla.toml carries. internal/ds does not
// import internal/config (ds.Policy's own comment), so the composition root copies them across;
// every value the config does not carry keeps its protocol/02 default.
func policyFromConfig(c *config.Config) ds.Policy {
	p := ds.DefaultPolicy()
	if c.Retention.HandshakeDays > 0 {
		p.HandshakeRetention = time.Duration(c.Retention.HandshakeDays) * 24 * time.Hour
	}
	if c.Retention.CiphertextDays > 0 {
		p.MessageRetention = time.Duration(c.Retention.CiphertextDays) * 24 * time.Hour
	}
	if c.Limits.MaxCiphertextBytes > 0 {
		p.MaxCiphertextBytes = int(c.Limits.MaxCiphertextBytes)
	}
	if c.Limits.MaxKeypackagesPerDevice > 0 {
		p.MaxKeyPackagesPerDevice = c.Limits.MaxKeypackagesPerDevice
	}
	return p
}
